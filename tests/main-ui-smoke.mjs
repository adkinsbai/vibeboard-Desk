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
    await page.locator("#projectCreateModal.open").waitFor({ timeout: 3000 });
    await page.locator("#projectNameInput").fill("UI smoke project");
    await page.locator("#projectCreateForm button[type='submit']").click();
    await page.waitForFunction(count => document.querySelectorAll(".conv-item").length > count, beforeCreate);
    const afterCreate = await page.locator(".conv-item").count();
    assert(afterCreate > beforeCreate, "busy state should not block new conversation creation");
    const createdProjectId = await page.locator(".conv-item.active").getAttribute("data-id");
    await json(`/api/conversations/${createdProjectId}/assets`, {
      method: "POST",
      body: JSON.stringify({
        assets: [{
          name: "ui-smoke.png",
          mime: "image/png",
          encoding: "base64",
          content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
        }],
      }),
    });

    await page.locator("#assetUploadBtn").click();
    await page.locator("#assetImportModal.open").waitFor({ timeout: 3000 });
    await page.locator("#chooseAssetFilesBtn").waitFor({ timeout: 3000 });
    const pickerReady = await page.locator("#chooseAssetFilesBtn").textContent();
    assert(pickerReady.includes("从文件夹中选取"), "asset import should expose explicit folder picker action");
    assert(await page.locator("#assetImportKnownBtn").count() === 0, "asset import should not require an acknowledgement step");
    assert(await page.locator(".asset-icon-row").count() === 0, "asset import intro icons should be removed");
    await page.locator("#closeAssetImportModal").click();
    await page.waitForFunction(() => !document.querySelector("#assetImportModal")?.classList.contains("open"));

    await page.locator("#jobCenterBtn").click();
    await page.locator("#jobDrawer.open").waitFor({ timeout: 3000 });
    await page.locator(".job-card").first().waitFor({ timeout: 3000 });
    await page.locator("#closeJobDrawer").click();
    await page.waitForFunction(() => !document.querySelector("#jobDrawer")?.classList.contains("open"));

    await page.locator("#assetManagerBtn").click();
    await page.locator("#assetManagerDrawer.open").waitFor({ timeout: 3000 });
    await page.locator(".asset-project-item").first().waitFor({ timeout: 3000 });
    await page.locator(".asset-folder-tile").first().waitFor({ timeout: 3000 });
    const folderCount = await page.locator(".asset-folder-tile").count();
    assert(folderCount >= 4, "asset manager should show default category folders");
    await page.locator(".asset-folder-tile").first().dblclick();
    await page.locator(".asset-breadcrumb-current").waitFor({ timeout: 3000 });
    await page.locator("[data-asset-breadcrumb-root]").click();
    await page.waitForFunction(() => !document.querySelector(".asset-breadcrumb-current"));
    await page.locator(".asset-folder-tile").first().dblclick();
    await page.locator(".asset-file-row").first().waitFor({ timeout: 3000 });
    await page.locator(".asset-file-row").first().click({ button: "right" });
    await page.locator("#assetContextMenu:not([hidden])").waitFor({ timeout: 3000 });
    await page.locator('[data-asset-menu-action="properties"]').click();
    await page.locator("#assetPropertiesModal.open").waitFor({ timeout: 3000 });
    const propertiesText = await page.locator("#assetPropertiesBody").textContent();
    assert(propertiesText.includes("ui-smoke.png") && propertiesText.includes("image/png"), "asset properties should show file name and MIME type");
    await page.locator("#closeAssetPropertiesModal").click();
    await page.waitForFunction(() => !document.querySelector("#assetPropertiesModal")?.classList.contains("open"));

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
