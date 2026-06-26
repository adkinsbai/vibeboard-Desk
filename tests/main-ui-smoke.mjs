import { chromium } from "playwright";
import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl, json }) => {
  const first = await json("/api/conversations", { method: "POST" });
  const second = await json("/api/conversations", { method: "POST" });
  assert(first.id && second.id, "setup should create conversations");

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      window.__vibeboardTestEvents = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const url = typeof input === "string" ? input : input?.url || "";
        const method = String(init?.method || "GET").toUpperCase();
        if (url.includes("/api/agent") && method === "POST") {
          window.__vibeboardTestEvents.push({ type: "agent-post" });
          return Promise.resolve(new Response(JSON.stringify({
            ok: false,
            error: "stubbed",
            errorType: "missing_model_config",
            userMessage: "stubbed",
            suggestion: "stubbed"
          }), {
            status: 400,
            headers: { "content-type": "application/json" }
          }));
        }
        if (url.includes("/api/jobs") && method === "GET") {
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            jobs: [{
              id: "job-ui-smoke",
              type: "agent",
              status: "running",
              phase: "generate",
              title: "UI smoke job",
              logs: [{ phase: "generate", message: "running" }],
              choices: []
            }]
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          }));
        }
        return originalFetch(input, init);
      };
      window.setBusy(true);
    });

    await page.locator(`.conv-item[data-id="${second.id}"]`).click();
    await page.locator(`.conv-item.active[data-id="${second.id}"]`).waitFor({ timeout: 6000 });
    const activeId = await page.locator(".conv-item.active").getAttribute("data-id");
    assert(activeId === second.id, "busy state should not block conversation selection");

    const beforeCreate = await page.locator(".conv-item").count();
    await page.locator("#newConversationBtn").click();
    await page.waitForFunction(count => document.querySelectorAll(".conv-item").length > count, beforeCreate);
    const afterCreate = await page.locator(".conv-item").count();
    assert(afterCreate > beforeCreate, "busy state should not block new conversation creation");

    await page.locator("#jobCenterBtn").click();
    await page.locator("#jobDrawer.open").waitFor({ timeout: 3000 });
    await page.locator(".job-card").first().waitFor({ timeout: 3000 });

    await page.evaluate(() => window.setBusy(false));
    await page.locator("#promptInput").fill("Enter should submit from the main composer");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window.__vibeboardTestEvents || []).some(item => item.type === "agent-post"));
    const submitted = await page.evaluate(() => window.__vibeboardTestEvents.length);
    assert(submitted >= 1, "Enter should submit the main composer");

    console.log(JSON.stringify({ ok: true, activeId, beforeCreate, afterCreate, submitted }, null, 2));
  } finally {
    await browser.close();
  }
}, { dbPrefix: "vibeboard-main-ui-test" });
