import { chromium } from "playwright";
import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl }) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.locator("#portalAuthCard").waitFor({ timeout: 6000 });
    const title = await page.locator(".portal-brand h1").textContent();
    assert(title.includes("开发板主控平台"), "root page should be the board control portal");
    const portalLayout = await page.locator(".portal-hero").evaluate(node => ({
      justifyItems: getComputedStyle(node).justifyItems,
      cardX: Math.round(document.querySelector("#portalAuthCard").getBoundingClientRect().x),
      heroX: Math.round(node.getBoundingClientRect().x),
      heroWidth: Math.round(node.getBoundingClientRect().width),
      primaryBackground: getComputedStyle(document.querySelector("#portalLoginForm button[type='submit']")).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundImage,
    }));
    assert(portalLayout.justifyItems === "center", "portal hero content should be centered");
    assert(portalLayout.cardX > portalLayout.heroX + 100, "auth card should not be left-aligned");
    assert(portalLayout.primaryBackground === "rgb(30, 89, 224)", "portal primary action should use the theme blue");
    assert(portalLayout.bodyBackground.includes("gradient"), "portal should use a professional layered background");

    await page.locator("#portalRegisterTab").click();
    await page.locator("#portalRegisterPhone").fill("+15558889999");
    await page.locator("#portalRegisterPassword").fill("correct-horse-42");
    await page.locator("#portalRegisterForm button[type='submit']").click();
    await page.locator("#portalBoardArea").waitFor({ state: "visible", timeout: 6000 });
    const boards = await page.locator(".board-card").count();
    assert(boards >= 4, "portal should show a board catalog after login");
    const hasCurrentWorkbench = await page.locator(".board-card", { hasText: "泰山派" }).count();
    assert(hasCurrentWorkbench >= 1, "portal should include current Taishan workbench entry");
    const taishanCards = await page.locator(".board-card[data-board-id^='taishan-']").count();
    assert(taishanCards === 1, `portal should show one generic Taishan entry, got ${taishanCards}`);
    assert(await page.locator("#deviceBindForm").count() === 1, "portal should expose the device binding form");

    await page.locator("#deviceSerialInput").fill("GRAYUNIT2026");
    await page.locator("#deviceBindForm button[type='submit']").click();
    await page.locator(".my-device-card", { hasText: "灰色版" }).waitFor({ timeout: 6000 });
    const boundDevices = await page.locator(".my-device-card").count();
    assert(boundDevices === 1, "bound devices should appear in My Devices after binding");
    await page.locator("#portalAdminLink").evaluate(node => { node.hidden = false; });
    const actionStyles = await page.locator(".portal-header-actions .ghost-btn").evaluateAll(nodes => {
      const metrics = nodes.map(node => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          top: Math.round(rect.top),
          centerY: Math.round(rect.top + rect.height / 2),
          height: Math.round(rect.height),
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          textDecoration: style.textDecorationLine,
          display: style.display,
          alignItems: style.alignItems,
        };
      });
      return {
        metrics,
        centerDelta: Math.max(...metrics.map(item => item.centerY)) - Math.min(...metrics.map(item => item.centerY)),
      };
    });
    assert(actionStyles.metrics.length === 3, "portal should expose workbench, admin, and logout actions");
    assert(actionStyles.centerDelta <= 1, `portal header actions should align horizontally: ${JSON.stringify(actionStyles.metrics)}`);
    assert(actionStyles.metrics.every(item => item.textDecoration === "none"), "portal header actions should not be underlined");
    assert(new Set(actionStyles.metrics.map(item => item.fontSize)).size === 1, "portal header actions should share the same font size");
    assert(new Set(actionStyles.metrics.map(item => item.fontWeight)).size === 1, "portal header actions should share the same font weight");
    assert(actionStyles.metrics.every(item => ["flex", "inline-flex"].includes(item.display) && item.alignItems === "center"), "portal header actions should use the same flex alignment");

    await page.goto(`${baseUrl}/workbench`, { waitUntil: "domcontentloaded" });
    await page.locator("#chatLog").waitFor({ timeout: 6000 });
    assert(await page.locator("#currentConversationTitle").count() === 1, "workbench route should preserve current UI");

    const market = await fetch(`${baseUrl}/api/market`).then(res => res.json());
    const previewable = market.apps?.find(app => app.id === "vb-cyber-weather-shrine") || market.apps?.[0];
    assert(previewable?.id, "market should expose at least one app for preview");
    const preview = await fetch(`${baseUrl}/api/market/${encodeURIComponent(previewable.id)}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "taishan-gray" }),
    }).then(res => res.json());
    assert(preview.ok === true && preview.conversation_id, "market preview should create an editable conversation");
    const files = await fetch(`${baseUrl}/api/conversations/${preview.conversation_id}/files`).then(res => res.json());
    assert(files.ok === true && files.files?.["index.html"] && files.files?.["hardware_app.py"], "market preview files should persist on the new project");
    const html = await fetch(`${baseUrl}${preview.preview_url}`).then(res => res.text());
    assert(html.includes("VibeBoardHardware") || html.includes("<html"), "market preview URL should render the generated app HTML");
  } finally {
    await browser.close();
  }
}, { dbPrefix: "portal-smoke", wait: { path: "/api/health" } });

console.log("portal smoke ok");
