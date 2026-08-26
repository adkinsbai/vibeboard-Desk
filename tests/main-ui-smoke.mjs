import { chromium } from "playwright";
import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl, json }) => {
  const first = await json("/api/conversations", { method: "POST" });
  const second = await json("/api/conversations", { method: "POST" });
  assert(first.id && second.id, "setup should create conversations");

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  try {
    await page.goto(`${baseUrl}/studio/workbench`, { waitUntil: "domcontentloaded" });
    await page.locator("#chatLog").waitFor({ timeout: 6000 });
    const platformTheme = await page.evaluate(() => {
      const styles = getComputedStyle(document.body);
      const readToken = name => styles.getPropertyValue(name).trim();
      const generateButton = getComputedStyle(document.querySelector("#generateBtn"));
      return {
        name: readToken("--vb-theme-name"),
        black: readToken("--vb-black"),
        white: readToken("--vb-white"),
        lime: readToken("--vb-lime"),
        purple: readToken("--vb-purple"),
        bodyBackground: styles.backgroundColor,
        primaryBackground: generateButton.backgroundColor,
        primaryColor: generateButton.color,
      };
    });
    assert(platformTheme.name === "Electric Glass", "workbench should expose the Electric Glass platform theme");
    assert(platformTheme.black === "#010101", "platform theme should define the VibeBoard black token");
    assert(platformTheme.white === "#F0F0F0", "platform theme should define the VibeBoard white token");
    assert(platformTheme.lime === "#F0F0F0", "platform accent token should use VibeBoard white");
    assert(platformTheme.purple === "#7E3BED", "platform theme should define the VibeBoard purple token");
    assert(platformTheme.bodyBackground === "rgb(1, 1, 1)", "workbench shell should render on VibeBoard black");
    assert(platformTheme.primaryBackground === "rgb(240, 240, 240)", "primary platform action should render in VibeBoard white");
    assert(platformTheme.primaryColor === "rgb(1, 1, 1)", "white primary action should use black text for contrast");
    await page.evaluate(() => {
      window.__vibeboardTestEvents = [];
      let backgroundPollCount = 0;
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
          window.__vibeboardTestEvents.push({ type: "generate-post" });
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            job: {
              id: "job-final-immediate",
              type: "generate",
              status: "queued",
              phase: "queued",
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
            status: 202,
            headers: { "content-type": "application/json" }
          }));
        }
        if (url.includes("/api/jobs/job-final-immediate") && method === "GET") {
          window.__vibeboardTestEvents.push({ type: "job-detail-get" });
          backgroundPollCount += 1;
          const done = backgroundPollCount > 1;
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            job: {
              id: "job-final-immediate",
              type: "generate",
              status: done ? "succeeded" : "running",
              phase: done ? "done" : "generate",
              output: done ? {
                ok: true,
                id: "vb-ui-final",
                agentSummary: "Background final job restored after polling",
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
              } : null,
            }
          }), {
            status: 200,
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

    assert(await page.locator("#authModal").count() === 0, "workbench should not include its own login/register modal");
    assert(await page.locator("#loginForm").count() === 0, "workbench should not include a login form");
    assert(await page.locator("#registerForm").count() === 0, "workbench should not include a register form");
    assert(await page.locator("#creditChip").count() === 1, "usage action should live in the account menu");
    const usageSurface = await page.locator("#usageDrawer").evaluate(node => ({
      open: node.classList.contains("open"),
      hasToolbar: Boolean(document.querySelector("#refreshUsageBtn")),
      hasSummary: Boolean(document.querySelector("#usageSummary")),
      hasLedger: Boolean(document.querySelector("#usageLedger")),
    }));
    assert(!usageSurface.open && usageSurface.hasToolbar && usageSurface.hasSummary && usageSurface.hasLedger, "usage drawer should be available but require login before opening");

    await page.locator("#assetManagerBtn").click();
    await page.locator("#assetManagerDrawer.open").waitFor({ timeout: 3000 });
    const assetSurface = await page.locator("#assetManagerDrawer").evaluate(node => ({
      background: getComputedStyle(node).backgroundColor,
      color: getComputedStyle(node).color,
      themeName: getComputedStyle(document.body).getPropertyValue("--vb-theme-name").trim(),
    }));
    assert(assetSurface.themeName === "Electric Glass", "workbench should enable the Electric Glass platform theme");
    assert(assetSurface.background.includes("9, 9, 11") || assetSurface.background.includes("13, 13, 16"), "asset manager should use an Electric Glass dark surface");
    assert(assetSurface.color.includes("240, 240, 240"), "asset manager text should use the Electric Glass foreground");
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
    await page.locator("#closeAssetManagerDrawer").click();
    await page.waitForFunction(() => !document.querySelector("#assetManagerDrawer")?.classList.contains("open"));

    await page.evaluate(async () => {
      window.__vibeboardTestEvents = [];
      await window.runFlow("Immediate final job", [], "");
    });
    const finalJobEvents = await page.evaluate(() => window.__vibeboardTestEvents || []);
    const lastBuildState = await page.locator("#lastBuildState").textContent();
    const codePreviewText = await page.locator("#codePreview").textContent();
    assert(finalJobEvents.some(item => item.type === "generate-post"), "runFlow should start generation through /api/generate");
    assert(finalJobEvents.some(item => item.type === "job-detail-get"), "runFlow should poll the queued background job");
    assert(finalJobEvents.filter(item => item.type === "job-detail-get").length >= 2, "runFlow should observe running and final job states");
    assert(lastBuildState === "vb-ui-final", `background final job should restore the generated build, got ${lastBuildState}`);
    assert(codePreviewText.includes("Immediate final job"), "background final job should render generated files");

    await page.evaluate(async () => {
      window.__vibeboardTestEvents = [];
      await Promise.all([
        window.runFlow("Duplicate guard job", [], ""),
        window.runFlow("Duplicate guard job", [], ""),
      ]);
    });
    const duplicateGuardPosts = await page.evaluate(() => (
      window.__vibeboardTestEvents || []
    ).filter(item => item.type === "generate-post").length);
    assert(duplicateGuardPosts === 1, `overlapping build triggers should post once, got ${duplicateGuardPosts}`);

    await page.evaluate(() => window.setBusy(false));
    await page.locator("#promptInput").fill("Enter should submit from the main composer");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window.__vibeboardTestEvents || []).some(item => item.type === "agent-post"));
    const submitted = await page.evaluate(() => window.__vibeboardTestEvents.length);
    assert(submitted >= 1, "Enter should submit the main composer");

    await page.evaluate(() => {
      document.querySelectorAll(".drawer.open, .modal.open").forEach(node => window.setLayerOpen(node, false));
      window.syncScrim();
    });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForFunction(() => document.querySelector("#sidebar")?.classList.contains("collapsed"));
    const compactDesktopLayout = await page.evaluate(() => {
      const box = selector => document.querySelector(selector)?.getBoundingClientRect();
      const actionButtons = [...document.querySelectorAll(".top-actions > *")];
      return {
        shellWidth: box(".shell")?.width || 0,
        sidebarPosition: getComputedStyle(document.querySelector("#sidebar")).position,
        agentWidth: box(".agent-panel")?.width || 0,
        hardwareWidth: box(".hardware-panel")?.width || 0,
        wrappedActions: actionButtons.some(node => node.getBoundingClientRect().height > 42),
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    assert(compactDesktopLayout.sidebarPosition === "fixed", "compact desktop sidebar should be a fixed overlay");
    assert(compactDesktopLayout.shellWidth >= 1023, "compact desktop workbench should use the full viewport width");
    assert(compactDesktopLayout.agentWidth >= 350, "compact desktop agent panel should remain usable");
    assert(compactDesktopLayout.hardwareWidth >= 600, "compact desktop preview should remain the primary surface");
    assert(!compactDesktopLayout.wrappedActions, "compact desktop top actions should not wrap into tall buttons");
    assert(compactDesktopLayout.scrollWidth <= 1024, "compact desktop workbench should not scroll horizontally");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector("#sidebar")?.classList.contains("collapsed"));
    const mobileLayout = await page.evaluate(() => ({
      bodyWidth: document.body.getBoundingClientRect().width,
      shellWidth: document.querySelector(".shell")?.getBoundingClientRect().width || 0,
      sidebarCollapsed: document.querySelector("#sidebar")?.classList.contains("collapsed"),
      sidebarExpanded: document.querySelector("#sidebarToggle")?.getAttribute("aria-expanded"),
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert(mobileLayout.sidebarCollapsed, "mobile workbench should start with the project sidebar collapsed");
    assert(mobileLayout.sidebarExpanded === "false", "mobile sidebar button should expose its collapsed state");
    assert(mobileLayout.shellWidth >= mobileLayout.bodyWidth - 1, "mobile workbench should keep the shell at full viewport width");
    assert(mobileLayout.scrollWidth <= 390, "mobile workbench should not introduce horizontal page scrolling");
    await page.locator("#sidebarToggle").click();
    const openedMobileSidebar = await page.locator("#sidebar").evaluate(node => ({
      collapsed: node.classList.contains("collapsed"),
      position: getComputedStyle(node).position,
      width: node.getBoundingClientRect().width,
      shellWidth: document.querySelector(".shell")?.getBoundingClientRect().width || 0,
    }));
    assert(!openedMobileSidebar.collapsed && openedMobileSidebar.position === "fixed", "mobile sidebar should open as a fixed overlay");
    assert(openedMobileSidebar.width > 240, "mobile sidebar overlay should remain usable");
    assert(openedMobileSidebar.shellWidth >= mobileLayout.bodyWidth - 1, "opening the mobile sidebar must not squeeze the workbench");

    console.log(JSON.stringify({ ok: true, activeId, beforeCreate, afterCreate, submitted }, null, 2));
  } finally {
    await browser.close();
  }
}, { dbPrefix: "vibeboard-main-ui-test" });
