import { chromium } from "playwright";
import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl }) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
  const forbiddenRequests = [];
  const pageErrors = [];

  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/digital-life/**", route => {
    forbiddenRequests.push(route.request().url());
    return route.fulfill({
      status: 599,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "removed_platform_api" }),
    });
  });

  try {
    await page.goto(`${baseUrl}/market-apps/vb-companion-device-demo/index.html`, { waitUntil: "networkidle" });
    await page.locator("#companion-screen").waitFor({ timeout: 6000 });

    const initial = await page.evaluate(() => window.CompanionDeviceSimulator?.getState?.());
    assert(initial?.schema_version === "expression-state.v2", "market companion should expose the local device simulator hook");
    assert(initial.connection_mode === "offline", "market companion should run as a local deployable app");
    assert(!("speech" in initial), "market companion should not expose platform speech service state");

    await page.locator("#messageInput").fill("今天有点累");
    await page.locator("#messageForm").evaluate(form => form.requestSubmit());
    await page.locator(".message-assistant").last().waitFor({ timeout: 6000 });
    const afterMessage = await page.evaluate(() => window.CompanionDeviceSimulator.getState());
    assert(afterMessage.messages.some(message => message.role === "assistant"), "local companion should answer without a platform backend");
    assert(afterMessage.connection_mode === "offline", "local response should keep the app in deployable offline mode");

    await page.locator("#key2").click();
    const afterMemory = await page.evaluate(() => window.CompanionDeviceSimulator.getState());
    assert(afterMemory.memory_overlay_open === true, "KEY2 should open the local memory overlay");
    assert(afterMemory.retrieval_count > 0, "local memory search should return ranked entries");

    assert(forbiddenRequests.length === 0, `market companion should not call removed legacy APIs: ${forbiddenRequests.join(", ")}`);
    assert(pageErrors.length === 0, `market companion should not emit page errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
  }
}, { dbPrefix: "market-companion-device-app", wait: { path: "/api/health" } });

console.log("market companion device app ok");
