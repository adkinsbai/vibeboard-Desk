import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn as defaultSpawn } from "node:child_process";

export function createPreviewRuntime({
  rootDir,
  previewsDir,
  generatedDir = "",
  port,
  nodeBin = process.execPath,
  screenshotScript = "",
  spawnProcess = defaultSpawn,
  appendServerLog = async () => {},
} = {}) {
  requireString(rootDir, "rootDir");
  requireString(previewsDir, "previewsDir");
  requireString(String(port || ""), "port");

  const captures = new Map();
  const scriptPath = screenshotScript || path.join(rootDir, "screenshot.cjs");

  function previewPathsForBuild(build = {}) {
    const buildId = build.id || "";
    if (!buildId) throw new Error("Build id is required for preview capture.");
    return {
      buildId,
      previewPath: path.join(previewsDir, `${buildId}.png`),
      reportPath: path.join(previewsDir, `${buildId}.json`),
      previewUrl: previewUrlForBuild(buildId),
      pageUrl: pageUrlForBuild(build),
    };
  }

  function pageUrlForBuild(build = {}) {
    const workspaceDir = String(build.workspaceDir || build.dir || "").trim();
    const root = String(generatedDir || "").trim();
    if (workspaceDir && root) {
      const relative = path.relative(path.resolve(root), path.resolve(workspaceDir));
      if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        const suffix = relative.split(path.sep).map(encodeURIComponent).join("/");
        return `http://127.0.0.1:${port}/generated/current/${suffix}/index.html`;
      }
    }
    return `http://127.0.0.1:${port}/generated/current/index.html`;
  }

  function previewUrlForBuild(buildOrId = "") {
    const buildId = typeof buildOrId === "string" ? buildOrId : buildOrId?.id || "";
    return buildId ? `/api/previews/${encodeURIComponent(buildId)}.png` : "";
  }

  async function hasPreview(previewPath) {
    try {
      const stat = await fs.stat(previewPath);
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  async function ensureBuildPreview(build = {}) {
    const paths = previewPathsForBuild(build);
    if (await hasPreview(paths.previewPath)) {
      build.previewPath = paths.previewPath;
      return {
        ok: true,
        existing: true,
        screenshot: paths.previewPath,
        previewPath: paths.previewPath,
        previewUrl: paths.previewUrl,
        buildId: paths.buildId,
      };
    }

    if (captures.has(paths.buildId)) return captures.get(paths.buildId);
    const capture = captureBuildPreview(build)
      .finally(() => captures.delete(paths.buildId));
    captures.set(paths.buildId, capture);
    return capture;
  }

  async function captureBuildPreview(build = {}) {
    const paths = previewPathsForBuild(build);
    await fs.mkdir(previewsDir, { recursive: true });

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      await new Promise((resolve, reject) => {
        const child = spawnProcess(nodeBin, [scriptPath, paths.pageUrl, paths.previewPath, paths.reportPath], {
          timeout: 25000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.on("data", data => { stdout += data; });
        child.stderr?.on("data", data => { stderr += data; });
        child.once?.("close", code => {
          exitCode = Number(code || 0);
          resolve();
        });
        child.once?.("error", reject);
      });
    } catch (error) {
      exitCode = 1;
      stderr = error?.message || String(error);
    }

    let report = parseReport(stdout);
    if (!report.ok) {
      try {
        report = JSON.parse(await fs.readFile(paths.reportPath, "utf8"));
      } catch {}
    }

    const screenshotExists = await hasPreview(paths.previewPath);
    if (screenshotExists) build.previewPath = paths.previewPath;

    const result = {
      ok: Boolean(report.ok),
      ...report,
      screenshot: paths.previewPath,
      previewPath: screenshotExists ? paths.previewPath : "",
      previewUrl: screenshotExists ? paths.previewUrl : "",
      buildId: paths.buildId,
      exitCode,
      stderr: stderr.slice(0, 1200),
    };

    if (!result.ok) {
      appendServerLog("preview.capture.failed", {
        id: paths.buildId,
        exitCode,
        stderr: result.stderr,
        pageErrors: result.pageErrors || [],
        consoleErrors: result.consoleErrors || [],
      }).catch(() => {});
    }

    return result;
  }

  return {
    captureBuildPreview,
    ensureBuildPreview,
    previewUrlForBuild,
  };
}

function parseReport(stdout = "") {
  const match = String(stdout || "").match(/__REPORT__(.*)/);
  if (!match) return { ok: false, consoleErrors: [], pageErrors: [], isBlank: false };
  try {
    return JSON.parse(match[1]);
  } catch {
    return { ok: false, consoleErrors: [], pageErrors: [], isBlank: false };
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`PreviewRuntime missing dependency: ${name}`);
  }
}
