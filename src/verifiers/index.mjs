import { execFile } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  GENERATED_FILES,
  SCREEN_CONTRACT,
  validateFileContracts,
} from "../contracts.mjs";
import {
  failResult,
  mergeResults,
  okResult,
  SEVERITY,
  toolResult,
  warnResult,
} from "../toolResult.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10000;
const RENDER_SETTLE_MS = 250;
const TEXT_EXTENSIONS = new Set([".html", ".css", ".js", ".json", ".py", ".txt", ".md", ".svg"]);

export function verifyContracts(input = {}) {
  const files = normalizeFilesInput(input);
  const phase = "contract";
  const issues = [];

  for (const fileName of GENERATED_FILES) {
    if (fileName === "manifest.json") continue;
    const value = files[fileName];
    if (typeof value !== "string" || !value.trim()) {
      issues.push({
        code: "FILE_MISSING",
        message: `${fileName} is required and cannot be empty.`,
        phase,
        evidence: { fileName, present: value != null, type: typeof value },
        suggestedFixes: [`Create ${fileName} before validation.`],
      });
    }
  }

  const contractIssues = validateFileContracts(files, "Generated app").map(issue => ({
    ...issue,
    phase,
    severity: SEVERITY.BLOCKING,
  }));
  issues.push(...contractIssues);

  return toolResult({
    ok: issues.length === 0,
    phase,
    summary: issues.length === 0 ? "Generated files satisfy static contracts." : "Generated files violate static contracts.",
    issues,
    evidence: {
      requiredFiles: GENERATED_FILES.filter(name => name !== "manifest.json"),
      presentFiles: Object.keys(files),
      screen: SCREEN_CONTRACT,
    },
  });
}

export async function verifySyntax(input = {}, options = {}) {
  const files = normalizeFilesInput(input, options);
  const { pythonBin } = options;
  const phase = "syntax";
  const issues = [];
  const tmpDir = await writeFilesToTempDir(files, "vibeboard-syntax-");
  const python = resolvePythonBin(pythonBin);

  try {
    if (typeof files["app.js"] === "string") {
      const appPath = path.join(tmpDir, "app.js");
      const jsResult = await execText(process.execPath, ["--check", appPath], {
        cwd: tmpDir,
        timeout: DEFAULT_TIMEOUT_MS,
      });
      if (!jsResult.ok) {
        issues.push({
          code: "JS_SYNTAX_ERROR",
          message: "app.js failed node --check.",
          phase,
          evidence: commandEvidence(jsResult),
          suggestedFixes: ["Fix the JavaScript parse error reported by node --check."],
        });
      }
    } else {
      issues.push({
        code: "JS_FILE_MISSING",
        message: "app.js is required for syntax verification.",
        phase,
        suggestedFixes: ["Generate app.js before running syntax verification."],
      });
    }

    if (typeof files["hardware_app.py"] === "string") {
      const hardwarePath = path.join(tmpDir, "hardware_app.py");
      const pyResult = await execText(python, ["-m", "py_compile", hardwarePath], {
        cwd: tmpDir,
        timeout: DEFAULT_TIMEOUT_MS,
      });
      if (!pyResult.ok) {
        issues.push({
          code: "PYTHON_SYNTAX_ERROR",
          message: "hardware_app.py failed python -m py_compile.",
          phase,
          evidence: commandEvidence(pyResult),
          suggestedFixes: ["Fix the Python syntax error reported by py_compile."],
        });
      }
    } else {
      issues.push({
        code: "PYTHON_FILE_MISSING",
        message: "hardware_app.py is required for syntax verification.",
        phase,
        suggestedFixes: ["Generate hardware_app.py before running syntax verification."],
      });
    }

    return toolResult({
      ok: issues.length === 0,
      phase,
      summary: issues.length === 0 ? "JavaScript and Python syntax checks passed." : "Syntax verification failed.",
      issues,
      evidence: {
        tmpDir,
        nodeBin: process.execPath,
        pythonBin: python,
      },
    });
  } finally {
    await removeDir(tmpDir);
  }
}

export async function verifyHardwareRun(input = {}, options = {}) {
  const files = normalizeFilesInput(input, options);
  const { pythonBin } = options;
  const phase = "hardware_run";
  const tmpDir = await writeFilesToTempDir(files, "vibeboard-hardware-");
  const python = resolvePythonBin(pythonBin);

  try {
    if (typeof files["hardware_app.py"] !== "string") {
      return failResult(phase, "hardware_app.py is missing.", [{
        code: "PYTHON_FILE_MISSING",
        message: "hardware_app.py is required for hardware run verification.",
        phase,
        suggestedFixes: ["Generate hardware_app.py before running hardware simulation."],
      }], { evidence: { tmpDir, pythonBin: python } });
    }

    const hardwarePath = path.join(tmpDir, "hardware_app.py");
    const runResult = await execText(python, [hardwarePath], {
      cwd: tmpDir,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    if (!runResult.ok) {
      return failResult(phase, "hardware_app.py exited with an error.", [{
        code: "PYTHON_RUNTIME_ERROR",
        message: "hardware_app.py did not complete successfully.",
        phase,
        evidence: commandEvidence(runResult),
        suggestedFixes: ["Run hardware_app.py locally and fix the runtime exception."],
      }], { evidence: { tmpDir, pythonBin: python } });
    }

    const stdout = runResult.stdout.trim();
    const parsed = parseLastJson(stdout);
    if (!parsed.ok) {
      return failResult(phase, "hardware_app.py did not print valid JSON.", [{
        code: "HARDWARE_JSON_INVALID",
        message: parsed.error,
        phase,
        evidence: { stdout: truncate(stdout), stderr: truncate(runResult.stderr) },
        suggestedFixes: ["Print exactly one JSON object or ensure the last stdout JSON object contains the hardware result."],
      }], { evidence: { tmpDir, pythonBin: python } });
    }

    const data = parsed.value;
    const issues = [];
    if (!hasValue(data?.build_id)) {
      issues.push({
        code: "HARDWARE_BUILD_ID_MISSING",
        message: "hardware_app.py JSON output must include build_id.",
        phase,
        evidence: { outputKeys: Object.keys(data || {}) },
        suggestedFixes: ["Include a build_id field in the JSON printed by hardware_app.py."],
      });
    }
    if (!hasValue(data?.runtime)) {
      issues.push({
        code: "HARDWARE_RUNTIME_MISSING",
        message: "hardware_app.py JSON output must include runtime.",
        phase,
        evidence: { outputKeys: Object.keys(data || {}) },
        suggestedFixes: ["Include a runtime field in the JSON printed by hardware_app.py."],
      });
    }
    if (!Array.isArray(data?.available_apis) || !data.available_apis.includes("/api/status")) {
      issues.push({
        code: "HARDWARE_STATUS_API_MISSING",
        message: "hardware_app.py JSON output must include /api/status in available_apis.",
        phase,
        evidence: { available_apis: data?.available_apis },
        suggestedFixes: ["Add /api/status to available_apis."],
      });
    }
    if (!Array.isArray(data?.available_apis) || !data.available_apis.some(api => String(api).includes("hardware-result.json"))) {
      issues.push({
        code: "HARDWARE_RESULT_API_MISSING",
        message: "hardware_app.py JSON output must include hardware-result.json in available_apis.",
        phase,
        evidence: { available_apis: data?.available_apis },
        suggestedFixes: ["Add ./hardware-result.json to available_apis."],
      });
    }

    return toolResult({
      ok: issues.length === 0,
      phase,
      summary: issues.length === 0 ? "hardware_app.py produced valid runtime JSON." : "hardware_app.py JSON output violated runtime contract.",
      issues,
      evidence: {
        tmpDir,
        pythonBin: python,
        stdout: truncate(stdout),
        stderr: truncate(runResult.stderr),
      },
      data,
    });
  } finally {
    await removeDir(tmpDir);
  }
}

export async function verifyRender(input = {}, options = {}) {
  const files = normalizeFilesInput(input, options);
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const phase = "render";
  let browser = null;
  let server = null;
  const tmpDir = await writeFilesToTempDir(files, "vibeboard-render-");

  try {
    if (!files["hardware-result.json"]) {
      const hardwareData = await bestEffortHardwareResult(files);
      await fs.writeFile(path.join(tmpDir, "hardware-result.json"), JSON.stringify(hardwareData, null, 2), "utf8");
    }

    server = await startMockHttpServer(tmpDir);
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const { chromium } = await import("playwright");

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: SCREEN_CONTRACT.width, height: SCREEN_CONTRACT.height },
      deviceScaleFactor: 1,
    });

    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const responses = [];

    page.on("console", msg => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", err => pageErrors.push(err.message));
    page.on("requestfailed", req => {
      failedRequests.push({
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText || "request failed",
      });
    });
    page.on("response", res => {
      const status = res.status();
      if (status >= 400) responses.push({ url: res.url(), status });
    });

    const targetUrl = `${baseUrl}/index.html`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 5000) }).catch(() => {});
    await page.waitForTimeout(RENDER_SETTLE_MS);

    const pageState = await page.evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      const root = document.querySelector("main") || document.querySelector("#app") || body;
      const rect = root?.getBoundingClientRect?.();
      const text = body?.innerText || "";
      const style = window.getComputedStyle(body);
      return {
        bodyHtmlLength: body?.innerHTML?.trim?.().length || 0,
        textLength: text.trim().length,
        scrollWidth: html.scrollWidth,
        scrollHeight: html.scrollHeight,
        bodyScrollWidth: body?.scrollWidth || 0,
        bodyScrollHeight: body?.scrollHeight || 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        rootWidth: rect?.width || 0,
        rootHeight: rect?.height || 0,
        bodyOverflow: style.overflow,
        bodyOverflowX: style.overflowX,
        bodyOverflowY: style.overflowY,
      };
    });

    const screenshotDir = path.join(os.tmpdir(), "vibeboard-render-screenshots");
    await fs.mkdir(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `render-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const issues = [];
    if (pageState.bodyHtmlLength < 50 && pageState.textLength < 5) {
      issues.push({
        code: "RENDER_BLANK",
        message: "Rendered page appears blank.",
        phase,
        evidence: pageState,
        suggestedFixes: ["Ensure index.html contains a mounted screen and app.js writes visible content."],
      });
    }

    const maxWidth = SCREEN_CONTRACT.width;
    const maxHeight = SCREEN_CONTRACT.height;
    if (pageState.scrollWidth > maxWidth || pageState.scrollHeight > maxHeight) {
      issues.push({
        code: "LAYOUT_OVERFLOW",
        message: `Rendered page overflows ${maxWidth}x${maxHeight}.`,
        phase,
        evidence: pageState,
        suggestedFixes: [
          `Constrain html, body, and the root app surface to ${maxWidth}px by ${maxHeight}px.`,
          "Use overflow: hidden and reduce gaps or fixed-size panels that exceed the screen.",
        ],
      });
    }

    if (consoleErrors.length) {
      issues.push({
        code: "CONSOLE_ERRORS",
        message: `Rendered page emitted ${consoleErrors.length} console error(s).`,
        phase,
        evidence: { consoleErrors: consoleErrors.slice(0, 10) },
        suggestedFixes: ["Fix JavaScript errors and failed resource handling reported in the browser console."],
      });
    }

    if (pageErrors.length) {
      issues.push({
        code: "PAGE_ERRORS",
        message: `Rendered page threw ${pageErrors.length} page error(s).`,
        phase,
        evidence: { pageErrors: pageErrors.slice(0, 10) },
        suggestedFixes: ["Fix uncaught runtime exceptions in app.js."],
      });
    }

    const badNetwork = [...failedRequests, ...responses].filter(item => {
      const url = String(item.url || "");
      return !url.startsWith("data:") && !url.startsWith("blob:");
    });
    if (badNetwork.length) {
      issues.push({
        code: "NETWORK_ERRORS",
        message: `Rendered page had ${badNetwork.length} failed or non-2xx resource request(s).`,
        phase,
        evidence: { network: badNetwork.slice(0, 10) },
        suggestedFixes: ["Use only local relative assets and ensure /api/status plus ./hardware-result.json are handled."],
      });
    }

    return toolResult({
      ok: issues.length === 0,
      phase,
      summary: issues.length === 0 ? "480x360 HTTP render passed." : "480x360 HTTP render failed.",
      issues,
      evidence: {
        baseUrl,
        targetUrl,
        tmpDir,
        screenshotPath,
        pageState,
        consoleErrors,
        pageErrors,
        failedRequests,
        badResponses: responses,
      },
    });
  } catch (err) {
    return failResult(phase, "Render verification could not complete.", [{
      code: "RENDER_VERIFIER_ERROR",
      message: err.message,
      phase,
      evidence: { stack: truncate(err.stack, 2000) },
      suggestedFixes: ["Check that Playwright Chromium is installed and that index.html/app.js can load over HTTP."],
    }], { evidence: { tmpDir } });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    await removeDir(tmpDir);
  }
}

export async function verifyAllLocal(input = {}, options = {}) {
  const { files, options: normalizedOptions } = normalizeVerifierInvocation(input, options);
  const contractResult = verifyContracts(files);
  const syntaxResult = await verifySyntax(files, normalizedOptions);
  const hardwareResult = await verifyHardwareRun(files, normalizedOptions);
  const renderResult = await verifyRender(files, normalizedOptions);
  return mergeResults("local_verification", "Local contract, syntax, hardware, and render verification complete.", [
    contractResult,
    syntaxResult,
    hardwareResult,
    renderResult,
  ]);
}

function normalizeVerifierInvocation(input = {}, options = {}) {
  if (typeof input === "string") {
    return {
      files: normalizeFilesInput(options.files || {}),
      options: { ...options, dir: input },
    };
  }

  if (input && typeof input === "object" && input.files && typeof input.files === "object") {
    return {
      files: normalizeFilesInput(input.files),
      options: { ...options, ...withoutFiles(input) },
    };
  }

  return {
    files: normalizeFilesInput(input, options),
    options: { ...options },
  };
}

function normalizeFilesInput(input = {}, options = {}) {
  if (input && typeof input === "object" && input.files && typeof input.files === "object") {
    return normalizeFilesInput(input.files, options);
  }
  if (options && typeof options === "object" && options.files && typeof options.files === "object") {
    return normalizeFilesInput(options.files);
  }
  if (!input || typeof input !== "object" || Buffer.isBuffer(input)) return {};

  const files = {};
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "string" || Buffer.isBuffer(value)) files[name] = value;
  }
  return files;
}

function withoutFiles(input = {}) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (key !== "files") output[key] = value;
  }
  return output;
}

async function writeFilesToTempDir(files, prefix) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  for (const [fileName, content] of Object.entries(files || {})) {
    if (typeof content !== "string" && !Buffer.isBuffer(content)) continue;
    const target = safeResolve(tmpDir, fileName);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return tmpDir;
}

function safeResolve(rootDir, fileName) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, String(fileName).replace(/^[/\\]+/, ""));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Refusing to write outside temporary verifier directory: ${fileName}`);
  }
  return target;
}

async function execText(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      ...options,
    });
    return {
      ok: true,
      command,
      args,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: 0,
    };
  } catch (err) {
    return {
      ok: false,
      command,
      args,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: typeof err.code === "number" ? err.code : null,
      signal: err.signal || null,
      message: err.message,
    };
  }
}

function commandEvidence(result) {
  return {
    command: [result.command, ...(result.args || [])].join(" "),
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    message: result.message,
  };
}

function resolvePythonBin(pythonBin) {
  if (pythonBin) return pythonBin;
  return process.platform === "win32" ? "python" : "python3";
}

function parseLastJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "stdout was empty." };

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {}

  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return { ok: true, value: JSON.parse(line) };
    } catch {}
  }

  const start = raw.lastIndexOf("{");
  if (start >= 0) {
    try {
      return { ok: true, value: JSON.parse(raw.slice(start)) };
    } catch {}
  }

  return { ok: false, error: "stdout did not contain a parseable JSON object." };
}

async function bestEffortHardwareResult(files) {
  const result = await verifyHardwareRun(files, {});
  if (result.ok && result.data) return result.data;
  return mockHardwareResult();
}

async function startMockHttpServer(rootDir) {
  const root = path.resolve(rootDir);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname === "/api/status") {
        sendJson(res, 200, mockBoardStatus());
        return;
      }

      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      const relative = decodeURIComponent(pathname).replace(/^[/\\]+/, "");
      const target = path.resolve(root, relative);
      if (target !== root && !target.startsWith(root + path.sep)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      const body = await fs.readFile(target);
      res.writeHead(200, {
        "Content-Type": contentTypeFor(target),
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch (err) {
      if ((req.url || "").includes("hardware-result.json")) {
        sendJson(res, 200, mockHardwareResult());
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function mockBoardStatus() {
  return {
    ok: true,
    connected: true,
    mode: "mock",
    hostname: "vibeboard-mock",
    model: "RK3566 Taishan Gray Mock",
    kernel: "mock",
    time: new Date().toISOString(),
    uptime: "mock",
    cpu_temp: 42,
    memory: { percent: 38, used_h: "380M", total_h: "1G" },
    disk: { percent: 24, used_h: "2.4G", total_h: "10G" },
    network: { wifi: "mock-wifi", addresses: ["127.0.0.1"], gateway: "127.0.0.1" },
    services: { ssh: "mock", frpc: "mock", display: "mock" },
  };
}

function mockHardwareResult() {
  return {
    ok: true,
    mode: "mock",
    build_id: "mock-render",
    runtime: "python-mock",
    available_apis: ["/api/status", "./hardware-result.json"],
    created_at: new Date().toISOString(),
  };
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function truncate(value, max = 4000) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...<truncated ${text.length - max} chars>`;
}

async function removeDir(dir) {
  if (!dir) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
