import { chromium } from "playwright";
import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl, json }) => {
  const first = await json("/api/conversations", { method: "POST" });
  const second = await json("/api/conversations", { method: "POST" });
  assert(first.id && second.id, "setup should create conversations");

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  try {
    await page.goto(`${baseUrl}/workbench`, { waitUntil: "domcontentloaded" });
    await page.locator("#chatLog").waitFor({ timeout: 6000 });
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

    await page.evaluate(() => window.__previewGateBefore = {
      maskOpacity: getComputedStyle(document.querySelector("#previewLoadingMask")).opacity,
      frameOpacity: getComputedStyle(document.querySelector("#deviceFrame")).opacity,
    });
    await page.route("**/never-finishes-preview.html*", () => {});
    await page.evaluate(() => window.setDeviceFrameSrc("/never-finishes-preview.html"));
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector("#previewLoadingMask")).opacity === "1" &&
      getComputedStyle(document.querySelector("#deviceFrame")).opacity === "0"
    ));
    const previewLoadingState = await page.locator("#macPhoto").evaluate(node => ({
      loading: node.classList.contains("preview-loading"),
      ready: node.classList.contains("preview-ready"),
      maskOpacity: getComputedStyle(document.querySelector("#previewLoadingMask")).opacity,
      frameOpacity: getComputedStyle(document.querySelector("#deviceFrame")).opacity,
    }));
    assert(previewLoadingState.loading, "device preview should enter loading state before iframe load");
    assert(!previewLoadingState.ready, "device preview should not be ready while iframe is still loading");
    assert(previewLoadingState.maskOpacity === "1", "loading mask should hide incomplete preview");
    assert(previewLoadingState.frameOpacity === "0", "iframe should remain hidden before preview load completes");
    await page.evaluate(() => window.setDeviceFrameSrc("/generated/current/index.html?test=preview-gate"));
    await page.waitForFunction(() => (
      document.querySelector("#macPhoto")?.classList.contains("preview-ready") &&
      getComputedStyle(document.querySelector("#deviceFrame")).opacity === "1"
    ));
    const previewReadyState = await page.locator("#macPhoto").evaluate(node => ({
      loading: node.classList.contains("preview-loading"),
      ready: node.classList.contains("preview-ready"),
      frameOpacity: getComputedStyle(document.querySelector("#deviceFrame")).opacity,
    }));
    assert(!previewReadyState.loading && previewReadyState.ready, "device preview should leave loading state after iframe load");
    assert(previewReadyState.frameOpacity === "1", "iframe should fade in only after load");
    await page.unroute("**/never-finishes-preview.html*");

    await page.locator("#deviceSelect").selectOption("taishan-transparent");
    const transparentScreen = await page.locator("#macPhoto").evaluate(node => ({
      left: node.style.getPropertyValue("--screen-left"),
      top: node.style.getPropertyValue("--screen-top"),
      width: node.style.getPropertyValue("--screen-width"),
      height: node.style.getPropertyValue("--screen-height"),
      hasCalibrationButton: Boolean(document.querySelector("#calibrateScreenBtn")),
      hasCalibrationPanel: Boolean(document.querySelector("#calibrationPanel")),
      hasResizeHandle: Boolean(document.querySelector("#calibrationResizeHandle")),
      overlayCursor: getComputedStyle(document.querySelector(".mac-screen-overlay")).cursor,
    }));
    assert(transparentScreen.left === "21.06%" && transparentScreen.top === "22.88%", "transparent board should use the confirmed screen position");
    assert(transparentScreen.width === "58.43%" && transparentScreen.height === "30.66%", "transparent board should use the confirmed screen size");
    assert(!transparentScreen.hasCalibrationButton && !transparentScreen.hasCalibrationPanel && !transparentScreen.hasResizeHandle, "screen calibration controls should not be exposed to users");
    assert(!["move", "grab", "grabbing"].includes(transparentScreen.overlayCursor), "screen overlay should not advertise draggable calibration");

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
    await page.locator(".job-log-details").first().waitFor({ timeout: 3000 });
    const jobLogOverflow = await page.locator(".job-log").first().evaluate(node => getComputedStyle(node).overflowY);
    assert(jobLogOverflow !== "auto" && jobLogOverflow !== "scroll", "job logs should not create a nested scroll area");
    await page.locator("#closeJobDrawer").click();
    await page.waitForFunction(() => !document.querySelector("#jobDrawer")?.classList.contains("open"));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#jobDrawer")).visibility === "hidden");
    const jobDrawerHiddenState = await page.locator("#jobDrawer").evaluate(node => ({
      inert: node.inert,
      ariaHidden: node.getAttribute("aria-hidden"),
      visibility: getComputedStyle(node).visibility,
      pointerEvents: getComputedStyle(node).pointerEvents,
    }));
    assert(jobDrawerHiddenState.inert === true, "closed drawers should be inert");
    assert(jobDrawerHiddenState.ariaHidden === "true", "closed drawers should be hidden from assistive tech");
    assert(jobDrawerHiddenState.visibility === "hidden", "closed drawers should not remain visually hittable offscreen");
    assert(jobDrawerHiddenState.pointerEvents === "none", "closed drawers should not receive pointer events");

    await page.locator("#refreshBoardBtn").click();
    await page.locator("#statusDrawer.open").waitFor({ timeout: 3000 });
    const statusDrawerScroll = await page.locator("#statusDrawer").evaluate(node => ({
      overflowY: getComputedStyle(node).overflowY,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }));
    assert(statusDrawerScroll.overflowY !== "hidden", "status drawer should not clip overflowing status content");
    assert(statusDrawerScroll.scrollHeight >= statusDrawerScroll.clientHeight, "status drawer should own its vertical scroll when needed");
    await page.locator("#closeStatusDrawer").click();
    await page.waitForFunction(() => !document.querySelector("#statusDrawer")?.classList.contains("open"));

    await page.locator("#accountBtn").click();
    await page.locator("#authModal.open").waitFor({ timeout: 3000 });
    const authStyle = await page.locator(".auth-panel").evaluate(node => {
      const visibleInputs = [...node.querySelectorAll(".auth-form:not(.hidden) .auth-field input")];
      const submit = node.querySelector(".auth-form:not(.hidden) button[type='submit']");
      const activeTab = node.querySelector(".auth-tab.active");
      const rect = el => {
        const box = el.getBoundingClientRect();
        return { x: Math.round(box.x), width: Math.round(box.width), height: Math.round(box.height) };
      };
      return {
        panelBackground: getComputedStyle(node).backgroundColor,
        panelColor: getComputedStyle(node).color,
        panelBorder: getComputedStyle(node).borderColor,
        inputRects: visibleInputs.map(rect),
        inputBorders: visibleInputs.map(el => getComputedStyle(el).borderColor),
        submitRect: rect(submit),
        submitBackground: getComputedStyle(submit).backgroundColor,
        activeTabBackground: getComputedStyle(activeTab).backgroundColor,
      };
    });
    assert(authStyle.panelBackground === "rgb(255, 255, 255)", "auth panel should use a clean white surface");
    assert(authStyle.panelBorder === "rgb(17, 17, 17)", "auth panel should use a black border");
    assert(authStyle.inputBorders.every(color => color === "rgb(17, 17, 17)"), "auth inputs should use black borders");
    assert(authStyle.inputRects.every(rect => rect.x === authStyle.submitRect.x && rect.width === authStyle.submitRect.width), "auth fields and submit button should align");
    assert(authStyle.submitBackground === "rgb(31, 143, 58)", "auth submit button should use the green action color");
    assert(authStyle.activeTabBackground === "rgb(31, 143, 58)", "active auth tab should use the green selected color");
    assert(await page.locator("#creditChip").count() === 1, "usage action should live in the account menu");
    const usageSurface = await page.locator("#usageDrawer").evaluate(node => ({
      open: node.classList.contains("open"),
      hasToolbar: Boolean(document.querySelector("#refreshUsageBtn")),
      hasSummary: Boolean(document.querySelector("#usageSummary")),
      hasLedger: Boolean(document.querySelector("#usageLedger")),
    }));
    assert(!usageSurface.open && usageSurface.hasToolbar && usageSurface.hasSummary && usageSurface.hasLedger, "usage drawer should be available but require login before opening");
    await page.locator("#closeAuthModal").click();
    await page.waitForFunction(() => !document.querySelector("#authModal")?.classList.contains("open"));

    await page.locator("#assetManagerBtn").click();
    await page.locator("#assetManagerDrawer.open").waitFor({ timeout: 3000 });
    const assetSurface = await page.locator("#assetManagerDrawer").evaluate(node => ({
      background: getComputedStyle(node).backgroundColor,
      color: getComputedStyle(node).color,
    }));
    assert(!assetSurface.background.includes("248, 250, 252") && !assetSurface.background.includes("255, 255, 255"), "asset manager should use the app dark surface");
    assert(!assetSurface.color.includes("15, 23, 42"), "asset manager text should not use the old light-theme foreground");
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
