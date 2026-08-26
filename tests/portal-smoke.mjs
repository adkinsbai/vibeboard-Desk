import { chromium } from "playwright";
import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl }) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  try {
    await page.goto(`${baseUrl}/studio`, { waitUntil: "domcontentloaded" });
    await page.locator("#portalAuthCard").waitFor({ timeout: 6000 });
    const portalLayout = await page.locator(".portal-hero").evaluate(node => ({
      justifyItems: getComputedStyle(node).justifyItems,
      cardX: Math.round(document.querySelector("#portalAuthCard").getBoundingClientRect().x),
      heroX: Math.round(node.getBoundingClientRect().x),
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
    assert(boards >= 6, "portal should show a board catalog after login");
    const taishanCards = await page.locator(".board-card[data-board-id^='taishan-']").count();
    assert(taishanCards === 1, `portal should show one generic Taishan entry, got ${taishanCards}`);
    assert(await page.locator("#deviceBindForm").count() === 1, "portal should expose the device binding form");

    await page.locator("#deviceSerialInput").fill("GRAYUNIT2026");
    await page.locator("#deviceBindForm button[type='submit']").click();
    await page.locator(".my-device-card", { hasText: "灰色版" }).waitFor({ timeout: 6000 });
    const boundDevices = await page.locator(".my-device-card").count();
    assert(boundDevices === 1, "bound devices should appear in My Devices after binding");

    await page.goto(`${baseUrl}/studio/workbench`, { waitUntil: "domcontentloaded" });
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
