import { chromium } from "playwright";
import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl, json }) => {
  const first = await json("/api/conversations", { method: "POST" });
  const second = await json("/api/conversations", { method: "POST" });
  assert(first.id && second.id, "setup should create conversations");

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  try {
    const missingLifecyclePage = await browser.newPage({ viewport: { width: 1366, height: 820 } });
    const missingLifecycleErrors = [];
    missingLifecyclePage.on("pageerror", error => missingLifecycleErrors.push(error.message || String(error)));
    await missingLifecyclePage.route("**/buildLifecycle.js", route => route.fulfill({
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "missing in production bundle",
    }));
    await missingLifecyclePage.route("**/api/agent", route => route.fulfill({
      status: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: "stubbed",
        errorType: "missing_model_config",
        userMessage: "stubbed",
        suggestion: "stubbed",
      }),
    }));
    await missingLifecyclePage.goto(`${baseUrl}/workbench`, { waitUntil: "domcontentloaded" });
    await missingLifecyclePage.locator("#promptInput").fill("Fallback lifecycle should keep Enter working");
    await missingLifecyclePage.keyboard.press("Enter");
    await missingLifecyclePage.waitForFunction(() => document.querySelector("#chatLog")?.innerText.includes("Fallback lifecycle should keep Enter working"));
    const fallbackInputValue = await missingLifecyclePage.locator("#promptInput").inputValue();
    assert(fallbackInputValue === "", "Enter should clear the composer even when buildLifecycle.js is unavailable");
    assert(!missingLifecycleErrors.length, `missing buildLifecycle.js should not crash app.js: ${missingLifecycleErrors.join("; ")}`);
    await missingLifecyclePage.close();

    await page.goto(`${baseUrl}/workbench`, { waitUntil: "domcontentloaded" });
    await page.locator("#chatLog").waitFor({ timeout: 6000 });
    const lifecyclePolicyContract = await page.evaluate(() => {
      const lifecycle = window.VibeBuildLifecycle;
      if (!lifecycle?.createBuildLifecyclePolicy) {
        return { ok: false, reason: "missing lifecycle module" };
      }
      let next = 0;
      const snapshots = [];
      const policy = lifecycle.createBuildLifecyclePolicy({
        createId: () => `client-run-${++next}`,
        getCurrentBuildId: () => "build-from-ui",
        onChange: state => snapshots.push({ ...state }),
      });
      const first = policy.clientRunIdForFlow("Build a timer", "conv-a", "confirm_build");
      const same = policy.clientRunIdForFlow("Build a timer", "conv-a", "confirm_build");
      const edited = policy.clientRunIdForFlow("Build a timer", "conv-a", "edit_build");
      policy.setState(lifecycle.STATES.AWAITING_DEPLOY, { currentBuildId: "build-ready" });
      policy.setState(lifecycle.STATES.DEPLOYING);
      policy.setState(lifecycle.STATES.DONE, { currentBuildId: "build-done" });
      return {
        ok: true,
        states: Object.values(lifecycle.STATES),
        first,
        same,
        edited,
        snapshots,
        final: policy.getState(),
      };
    });
    assert(lifecyclePolicyContract.ok, lifecyclePolicyContract.reason || "build lifecycle module should load before app.js");
    assert(
      ["clarifying", "generating", "verified", "awaiting_deploy", "deploying", "done"].every(state => lifecyclePolicyContract.states.includes(state)),
      `build lifecycle module should expose expected states, got ${JSON.stringify(lifecyclePolicyContract.states)}`
    );
    assert(lifecyclePolicyContract.first === lifecyclePolicyContract.same, "same conversation/action/prompt should reuse client_run_id while generating");
    assert(lifecyclePolicyContract.edited !== lifecyclePolicyContract.first, "different build actions should receive a new client_run_id");
    assert(lifecyclePolicyContract.snapshots.some(state => state.state === "generating" && state.currentBuildId === "build-from-ui"), "generating state should capture the current build id");
    assert(lifecyclePolicyContract.final.state === "done" && lifecyclePolicyContract.final.currentBuildId === "build-done", "deploy lifecycle should transition through done with the build id preserved");
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
        if (url.includes("/api/generate") && method === "POST") {
          let body = {};
          try {
            body = init?.body ? JSON.parse(String(init.body)) : {};
          } catch {}
          window.__vibeboardTestEvents.push({ type: "generate-post", body });
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            job: {
              id: "job-final-immediate",
              type: "generate",
              status: "succeeded",
              phase: "done",
              input: { prompt: "Immediate final job" },
              output: {
                ok: true,
                id: "vb-ui-final",
                agentSummary: "Immediate final job restored without polling",
                files: {
                  "index.html": "<!doctype html><html><head><link rel=\"stylesheet\" href=\"style.css\"></head><body><main id=\"app\">Immediate final job</main><script src=\"app.js\"></script></body></html>",
                  "style.css": "body{margin:0;background:#000;color:#fff;font:24px sans-serif}",
                  "app.js": "document.getElementById('app').dataset.ready='true';",
                  "hardware_app.py": "print('{\"build_id\":\"vb-ui-final\",\"runtime\":\"executed_on_board\",\"available_apis\":[\"/api/status\",\"./hardware-result.json\"]}')",
                  "manifest.json": "{\"id\":\"vb-ui-final\",\"files\":[\"index.html\",\"style.css\",\"app.js\",\"hardware_app.py\",\"manifest.json\"]}"
                },
                buildEvidence: { ok: true, summary: "stubbed verification", evidence: {} },
                evidence: [],
                verification: { ok: true }
              },
              choices: [{ label: "Open result", action: "open_result" }]
            }
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          }));
        }
        if (url.includes("/api/jobs/job-final-immediate") && method === "GET") {
          window.__vibeboardTestEvents.push({ type: "job-detail-get" });
          return Promise.resolve(new Response(JSON.stringify({
            ok: false,
            error: "Job not found"
          }), {
            status: 404,
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
      getComputedStyle(document.querySelector("#deviceFrame")).opacity === "1" &&
      getComputedStyle(document.querySelector("#previewLoadingMask")).opacity === "0"
    ));
    const previewReadyState = await page.locator("#macPhoto").evaluate(node => ({
      loading: node.classList.contains("preview-loading"),
      ready: node.classList.contains("preview-ready"),
      frameOpacity: getComputedStyle(document.querySelector("#deviceFrame")).opacity,
      maskOpacity: getComputedStyle(document.querySelector("#previewLoadingMask")).opacity,
    }));
    assert(!previewReadyState.loading && previewReadyState.ready, "device preview should leave loading state after iframe load");
    assert(previewReadyState.frameOpacity === "1", "iframe should fade in only after load");
    assert(previewReadyState.maskOpacity === "0", "loading mask should disappear after preview load");
    await page.unroute("**/never-finishes-preview.html*");

    const deviceOptions = await page.locator("#deviceSelect option").evaluateAll(options => options.map(option => ({
      value: option.value,
      label: option.textContent.trim(),
    })));
    assert(deviceOptions.length === 1, `device selector should expose one Taishan option, got ${JSON.stringify(deviceOptions)}`);
    assert(deviceOptions[0]?.value === "taishan-gray", "single Taishan option should use the canonical taishan-gray id");
    const taishanScreen = await page.locator("#macPhoto").evaluate(node => ({
      left: node.style.getPropertyValue("--screen-left"),
      top: node.style.getPropertyValue("--screen-top"),
      width: node.style.getPropertyValue("--screen-width"),
      height: node.style.getPropertyValue("--screen-height"),
      hasCalibrationButton: Boolean(document.querySelector("#calibrateScreenBtn")),
      hasCalibrationPanel: Boolean(document.querySelector("#calibrationPanel")),
      hasResizeHandle: Boolean(document.querySelector("#calibrationResizeHandle")),
      overlayCursor: getComputedStyle(document.querySelector(".mac-screen-overlay")).cursor,
    }));
    assert(taishanScreen.left === "30.18%" && taishanScreen.top === "31.88%", "canonical Taishan board should use the confirmed screen position");
    assert(taishanScreen.width === "44.3%" && taishanScreen.height === "21.8%", "canonical Taishan board should use the confirmed screen size");
    assert(!taishanScreen.hasCalibrationButton && !taishanScreen.hasCalibrationPanel && !taishanScreen.hasResizeHandle, "screen calibration controls should not be exposed to users");
    assert(!["move", "grab", "grabbing"].includes(taishanScreen.overlayCursor), "screen overlay should not advertise draggable calibration");

    const beforeCreate = await page.locator(".conv-item").count();
    await page.locator("#newConversationBtn").click();
    await page.locator("#projectCreateModal.open").waitFor({ timeout: 3000 });
    await page.locator("#projectNameInput").fill("UI smoke project");
    await page.locator("#projectCreateForm button[type='submit']").click();
    await page.waitForFunction(count => document.querySelectorAll(".conv-item").length > count, beforeCreate);
    await page.waitForFunction(() => {
      const active = document.querySelector(".conv-item.active");
      return active && !active.classList.contains("pending") && !active.dataset.id.startsWith("pending-");
    });
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

    assert(await page.locator("#jobCenterBtn").count() === 0, "top navigation should no longer expose the old task-list entry");
    await page.locator("#guideBtn").click();
    await page.locator("#guideModal.open").waitFor({ timeout: 3000 });
    const guideText = await page.locator("#guideModal").textContent();
    assert(guideText.includes("平台功能") && guideText.includes("Runner") && guideText.includes("应用市场"), "new guide should explain core workflows");
    await page.locator("#closeGuideModal").click();
    await page.waitForFunction(() => !document.querySelector("#guideModal")?.classList.contains("open"));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#guideModal")).display === "none");
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

    await page.evaluate(async () => {
      window.__vibeboardTestEvents = [];
      await window.runFlow("Immediate final job", [], "");
    });
    const finalJobEvents = await page.evaluate(() => window.__vibeboardTestEvents || []);
    const lastBuildState = await page.locator("#lastBuildState").textContent();
    const codePreviewText = await page.locator("#codePreview").textContent();
    assert(finalJobEvents.some(item => item.type === "generate-post"), "runFlow should start generation through /api/generate");
    assert(!finalJobEvents.some(item => item.type === "job-detail-get"), "runFlow should not poll a request-bound final job after /api/generate already returned it");
    assert(lastBuildState === "vb-ui-final", `request-bound final job should restore the generated build, got ${lastBuildState}`);
    assert(codePreviewText.includes("Immediate final job"), "request-bound final job should render generated files");

    await page.evaluate(async () => {
      window.__vibeboardTestEvents = [];
      window.pendingGeneratePrompt = "Single confirm build";
      await window.startBuild("Single confirm build");
    });
    const confirmBuildEvents = await page.evaluate(() => window.__vibeboardTestEvents || []);
    const confirmGeneratePosts = confirmBuildEvents.filter(item => item.type === "generate-post");
    assert(confirmGeneratePosts.length === 1, `startBuild should submit one generation request, got ${confirmGeneratePosts.length}`);
    assert(confirmGeneratePosts[0]?.body?.client_run_id, "startBuild should include a client_run_id for backend idempotency");

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
