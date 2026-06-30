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

    await page.goto(`${baseUrl}/workbench`, { waitUntil: "domcontentloaded" });
    await page.locator("#chatLog").waitFor({ timeout: 6000 });
    assert(await page.locator("#currentConversationTitle").count() === 1, "workbench route should preserve current UI");
  } finally {
    await browser.close();
  }
}, { dbPrefix: "portal-smoke", wait: { path: "/api/health" } });

console.log("portal smoke ok");
