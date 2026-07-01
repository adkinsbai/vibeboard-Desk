import { randomUUID } from "node:crypto";
import {
  deserializeFileMap,
  filterDeployableFiles,
  serializeFileMap,
} from "./assetContract.mjs";

export function createMarketRuntime(deps = {}) {
  const {
    generatedFileNames = [],
    query,
    run,
    loadStaticMarketApps,
    readStaticMarketCode,
    mergeMarketApps,
    readGeneratedFiles,
    writeGeneratedFiles,
    generatedDir,
    getCurrentBuild,
    capturePreview,
    loadGeneratedBuild,
    buildCurrent,
    deployCurrent,
    withDeployLock,
    withDevice,
    deviceIdFrom,
    getBoard,
    createPreviewProject,
    log = console,
    idFactory = randomUUID,
  } = deps;

  requireArray(generatedFileNames, "generatedFileNames");
  requireFunction(query, "query");
  requireFunction(run, "run");
  requireFunction(loadStaticMarketApps, "loadStaticMarketApps");
  requireFunction(readStaticMarketCode, "readStaticMarketCode");
  requireFunction(mergeMarketApps, "mergeMarketApps");
  requireFunction(readGeneratedFiles, "readGeneratedFiles");
  requireFunction(writeGeneratedFiles, "writeGeneratedFiles");
  requireString(generatedDir, "generatedDir");
  requireFunction(getCurrentBuild, "getCurrentBuild");
  requireFunction(capturePreview, "capturePreview");
  requireFunction(loadGeneratedBuild, "loadGeneratedBuild");
  requireFunction(buildCurrent, "buildCurrent");
  requireFunction(deployCurrent, "deployCurrent");
  requireFunction(withDeployLock, "withDeployLock");
  requireFunction(withDevice, "withDevice");
  requireFunction(deviceIdFrom, "deviceIdFrom");
  requireFunction(getBoard, "getBoard");

  async function listApps() {
    const dbApps = query("SELECT id, conversation_id, name, description, preview_url, author, downloads, created_at FROM market_apps ORDER BY created_at DESC")
      .map(app => ({ ...app, source: "database" }));
    const apps = mergeMarketApps(dbApps, await loadStaticMarketApps());
    return { ok: true, apps };
  }

  async function publishApp(body = {}) {
    const name = String(body.name || "").trim();
    if (!name) throwStatus(400, "App name is required.");
    const currentBuild = getCurrentBuild();
    const codeJson = await snapshotCurrentGeneratedApp(currentBuild);
    const previewReport = currentBuild
      ? await capturePreview()
      : { ok: false, error: "No current build available for preview capture." };
    const preview_url = previewReport.previewUrl || "";
    if (currentBuild && !preview_url) {
      throwStatus(502, `Preview capture failed: ${previewReport.error || "missing preview URL"}`, {
        previewReport,
      });
    }
    const id = idFactory();
    const author = "user";

    run(
      "INSERT INTO market_apps (id, conversation_id, name, description, code, preview_url, author) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, body.conversation_id || null, name, String(body.description || ""), codeJson, preview_url, author],
    );

    return { ok: true, id, preview_url, previewReport };
  }

  function getApp(appId) {
    const apps = query("SELECT * FROM market_apps WHERE id = ?", [appId]);
    if (apps.length === 0) {
      throwStatus(404, "App not found");
    }
    return { ok: true, app: apps[0] };
  }

  async function deployApp(appId, body = {}) {
    const board = getBoard();
    const deviceId = deviceIdFrom(body || {}, board.id);
    const result = await withDeployLock(async () => (
      withDevice(deviceId, async () => {
        const { app, codeFiles, isStaticApp } = await loadMarketAppCode(appId);
        const generatedFiles = filterDeployableFiles(codeFiles, generatedFileNames);
        await writeGeneratedFiles(generatedDir, generatedFiles);
        const build = await loadGeneratedBuild();
        log.log?.("[marketDeploy] requested app:", appId, "loaded build:", build?.id, "device:", getBoard().id);

        await buildCurrent();
        const deployResult = await deployCurrent();
        if (app && !isStaticApp) run("UPDATE market_apps SET downloads = downloads + 1 WHERE id = ?", [appId]);
        return deployResult;
      })
    ));

    return {
      ok: true,
      message: "App deployed successfully",
      deviceId,
      deployId: result.id,
    };
  }

  async function previewApp(appId, body = {}) {
    requireFunction(createPreviewProject, "createPreviewProject");
    const { app, codeFiles, isStaticApp } = await loadMarketAppCode(appId);
    const name = String(body.name || app?.name || appId || "Market App").trim() || "Market App";
    const generatedFiles = filterDeployableFiles(codeFiles, generatedFileNames);
    const result = await createPreviewProject({
      appId,
      app,
      title: name,
      files: generatedFiles,
      source: isStaticApp ? "static" : "database",
      body,
    });
    return {
      ok: true,
      appId,
      title: name,
      source: isStaticApp ? "static" : "database",
      ...result,
    };
  }

  async function snapshotCurrentGeneratedApp(currentBuild) {
    if (currentBuild?.files) return JSON.stringify(serializeFileMap(currentBuild.files));
    try {
      const files = await readGeneratedFiles(generatedDir, generatedFileNames);
      if (Object.keys(files).length > 0) return JSON.stringify(serializeFileMap(files));
    } catch {}
    return "{}";
  }

  async function loadMarketAppCode(appId) {
    const apps = query("SELECT * FROM market_apps WHERE id = ?", [appId]);
    const app = apps[0] || null;
    if (app) {
      let codeFiles = {};
      try {
        codeFiles = deserializeFileMap(JSON.parse(app.code || "{}"));
      } catch {}
      if (Object.keys(codeFiles).length === 0) {
        throwStatus(400, "App has no code to deploy");
      }
      return { app, codeFiles, isStaticApp: false };
    }

    const staticApps = await loadStaticMarketApps();
    if (!staticApps.some(item => item.id === appId)) {
      throwStatus(404, "App not found");
    }
    const codeFiles = await readStaticMarketCode(appId);
    if (Object.keys(codeFiles).length === 0) {
      throwStatus(400, "App has no code to deploy");
    }
    return { app: null, codeFiles, isStaticApp: true };
  }

  return {
    listApps,
    publishApp,
    getApp,
    deployApp,
    previewApp,
  };
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new Error(`MarketRuntime missing dependency: ${name}`);
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`MarketRuntime missing dependency: ${name}`);
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`MarketRuntime missing dependency: ${name}`);
}

function throwStatus(statusCode, message, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  throw error;
}
