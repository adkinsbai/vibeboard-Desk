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
  validateHardwareResultContract,
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
const MIN_READABLE_FONT_PX = 10;
const MIN_INTERACTIVE_TARGET_PX = 28;
const MIN_TEXT_CONTRAST_RATIO = 3;
const MAX_READABILITY_SAMPLES = 12;
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
    const issues = validateHardwareResultContract(data, {
      label: "hardware_app.py JSON output",
    }).map(issue => ({
      ...issue,
      phase,
      suggestedFixes: hardwareResultSuggestedFixes(issue.code),
    }));

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

    const readabilityState = await page.evaluate((config) => {
      const tinyTextSamples = [];
      const lowContrastSamples = [];
      const smallInteractiveSamples = [];
      let tinyTextCount = 0;
      let lowContrastTextCount = 0;
      let smallInteractiveCount = 0;
      let visibleTextBlockCount = 0;
      let interactiveCount = 0;

      function isVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0.5 && rect.height > 0.5;
      }

      function compactText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function directText(el) {
        return compactText(Array.from(el.childNodes)
          .filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent || "")
          .join(" "));
      }

      function hasVisibleTextChild(el) {
        return Array.from(el.children || []).some(child => isVisible(child) && compactText(child.innerText).length > 0);
      }

      function sampleFor(el, text, fontSize, rect) {
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          className: typeof el.className === "string" ? el.className.slice(0, 120) : "",
          text: compactText(text).slice(0, 80),
          fontSize,
          color: window.getComputedStyle(el).color,
          backgroundColor: effectiveBackgroundColor(el),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }

      function parseRgb(value) {
        const text = String(value || "").trim();
        if (text.toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
        const match = text.match(/^rgba?\(([^)]+)\)$/i);
        if (!match) return null;
        const body = match[1].replace(/\s*\/\s*/g, " ").trim();
        const parts = (body.includes(",") ? body.split(",") : body.split(/\s+/))
          .map(part => Number.parseFloat(part.trim()));
        if (parts.length < 3 || parts.slice(0, 3).some(part => Number.isNaN(part))) return null;
        return {
          r: Math.max(0, Math.min(255, parts[0])),
          g: Math.max(0, Math.min(255, parts[1])),
          b: Math.max(0, Math.min(255, parts[2])),
          a: parts.length >= 4 && !Number.isNaN(parts[3]) ? Math.max(0, Math.min(1, parts[3])) : 1,
        };
      }

      function representativeBackgroundImageColor(value) {
        const matches = String(value || "").match(/rgba?\([^)]+\)|transparent/gi) || [];
        const colors = matches
          .map(item => parseRgb(item))
          .filter(color => color && color.a > 0.01);
        if (!colors.length) return null;
        let total = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        let alpha = 0;
        for (const color of colors) {
          const weight = Math.max(color.a ?? 1, 0.05);
          r += color.r * weight;
          g += color.g * weight;
          b += color.b * weight;
          total += weight;
          alpha = Math.max(alpha, color.a ?? 1);
        }
        if (total <= 0) return null;
        return { r: r / total, g: g / total, b: b / total, a: alpha };
      }

      function blend(fg, bg) {
        const alpha = fg.a == null ? 1 : fg.a;
        return {
          r: fg.r * alpha + bg.r * (1 - alpha),
          g: fg.g * alpha + bg.g * (1 - alpha),
          b: fg.b * alpha + bg.b * (1 - alpha),
          a: 1,
        };
      }

      function effectiveBackgroundColor(el) {
        const white = { r: 255, g: 255, b: 255, a: 1 };
        const backgroundStack = [];
        let current = el;
        while (current && current instanceof Element) {
          const currentStyle = window.getComputedStyle(current);
          const imageColor = representativeBackgroundImageColor(currentStyle.backgroundImage);
          if (imageColor && imageColor.a > 0) backgroundStack.push(imageColor);
          const parsed = parseRgb(currentStyle.backgroundColor);
          if (parsed && parsed.a > 0) backgroundStack.push(parsed);
          current = current.parentElement;
        }
        let background = white;
        for (const layer of backgroundStack.reverse()) {
          background = blend(layer, background);
        }
        return background;
      }

      function channelLuminance(channel) {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      }

      function relativeLuminance(color) {
        return 0.2126 * channelLuminance(color.r)
          + 0.7152 * channelLuminance(color.g)
          + 0.0722 * channelLuminance(color.b);
      }

      function contrastRatio(fg, bg) {
        const foreground = fg.a != null && fg.a < 1 ? blend(fg, bg) : fg;
        const l1 = relativeLuminance(foreground);
        const l2 = relativeLuminance(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }

      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        if (!isVisible(el)) continue;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const text = directText(el) || (!hasVisibleTextChild(el) ? compactText(el.innerText) : "");

        if (text.length >= 2) {
          const fontSize = Number.parseFloat(style.fontSize) || 0;
          visibleTextBlockCount += 1;
          if (fontSize > 0 && fontSize < config.minReadableFontPx) {
            tinyTextCount += 1;
            if (tinyTextSamples.length < config.maxSamples) {
              tinyTextSamples.push(sampleFor(el, text, fontSize, rect));
            }
          }
          const color = parseRgb(style.color);
          const backgroundColor = effectiveBackgroundColor(el);
          if (color && backgroundColor) {
            const ratio = contrastRatio(color, backgroundColor);
            if (ratio < config.minTextContrastRatio) {
              lowContrastTextCount += 1;
              if (lowContrastSamples.length < config.maxSamples) {
                lowContrastSamples.push({
                  ...sampleFor(el, text, fontSize, rect),
                  contrastRatio: Number(ratio.toFixed(2)),
                });
              }
            }
          }
        }

        const tag = el.tagName.toLowerCase();
        const role = String(el.getAttribute("role") || "").toLowerCase();
        const interactive = ["button", "a", "input", "select", "textarea"].includes(tag)
          || ["button", "link", "switch", "checkbox", "radio", "tab"].includes(role)
          || el.hasAttribute("onclick");
        if (interactive) {
          interactiveCount += 1;
          if (rect.width < config.minInteractiveTargetPx || rect.height < config.minInteractiveTargetPx) {
            smallInteractiveCount += 1;
            if (smallInteractiveSamples.length < config.maxSamples) {
              smallInteractiveSamples.push(sampleFor(el, compactText(el.innerText || el.getAttribute("aria-label") || tag), Number.parseFloat(style.fontSize) || 0, rect));
            }
          }
        }
      }

      return {
        minReadableFontPx: config.minReadableFontPx,
        minInteractiveTargetPx: config.minInteractiveTargetPx,
        minTextContrastRatio: config.minTextContrastRatio,
        textLength: compactText(document.body.innerText).length,
        visibleTextBlockCount,
        tinyTextCount,
        tinyTextSamples,
        lowContrastTextCount,
        lowContrastSamples,
        interactiveCount,
        smallInteractiveCount,
        smallInteractiveSamples,
      };
    }, {
      minReadableFontPx: MIN_READABLE_FONT_PX,
      minInteractiveTargetPx: MIN_INTERACTIVE_TARGET_PX,
      minTextContrastRatio: MIN_TEXT_CONTRAST_RATIO,
      maxSamples: MAX_READABILITY_SAMPLES,
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

    if (readabilityState.tinyTextCount > 0) {
      issues.push({
        code: "TEXT_TOO_SMALL",
        message: `Rendered page has ${readabilityState.tinyTextCount} visible text block(s) below ${MIN_READABLE_FONT_PX}px.`,
        phase,
        evidence: {
          minReadableFontPx: MIN_READABLE_FONT_PX,
          samples: readabilityState.tinyTextSamples,
        },
        suggestedFixes: [
          `Use at least ${MIN_READABLE_FONT_PX}px for visible text on the 480x360 hardware screen.`,
          "Reduce secondary metadata, spacing, or item count instead of shrinking labels below the readability floor.",
        ],
      });
    }

    if (readabilityState.lowContrastTextCount > 0) {
      issues.push({
        code: "TEXT_CONTRAST_LOW",
        message: `Rendered page has ${readabilityState.lowContrastTextCount} visible text block(s) below ${MIN_TEXT_CONTRAST_RATIO}:1 contrast.`,
        phase,
        evidence: {
          minTextContrastRatio: MIN_TEXT_CONTRAST_RATIO,
          samples: readabilityState.lowContrastSamples,
        },
        suggestedFixes: [
          `Raise text/background contrast to at least ${MIN_TEXT_CONTRAST_RATIO}:1 on the 480x360 hardware screen.`,
          "Use stronger foreground colors, darker/lighter backing surfaces, or remove decorative low-contrast labels.",
        ],
      });
    }

    if (readabilityState.smallInteractiveCount > 0) {
      issues.push({
        code: "INTERACTIVE_TARGET_SMALL",
        message: `Rendered page has ${readabilityState.smallInteractiveCount} visible interactive target(s) below ${MIN_INTERACTIVE_TARGET_PX}px.`,
        phase,
        severity: SEVERITY.WARNING,
        evidence: {
          minInteractiveTargetPx: MIN_INTERACTIVE_TARGET_PX,
          samples: readabilityState.smallInteractiveSamples,
        },
        suggestedFixes: [
          `Keep interactive controls at least ${MIN_INTERACTIVE_TARGET_PX}px wide and tall, or replace them with passive status indicators for no-touch hardware.`,
        ],
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

    const blockingIssueCount = issues.filter(issue => issue.severity !== SEVERITY.WARNING && issue.severity !== SEVERITY.INFO).length;
    const summary = blockingIssueCount > 0
      ? "480x360 HTTP render failed."
      : issues.length > 0
        ? "480x360 HTTP render passed with hardware-fit warnings."
        : "480x360 HTTP render passed.";

    return toolResult({
      ok: blockingIssueCount === 0,
      phase,
      summary,
      issues,
      degraded: blockingIssueCount === 0 && issues.length > 0,
      evidence: {
        baseUrl,
        targetUrl,
        tmpDir,
        screenshotPath,
        pageState,
        readabilityState,
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
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".ttf") return "font/ttf";
  if (ext === ".woff") return "font/woff";
  if (ext === ".woff2") return "font/woff2";
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

function hardwareResultSuggestedFixes(code) {
  switch (code) {
    case "HARDWARE_BUILD_ID_MISSING":
      return ["Include a build_id field in the JSON printed by hardware_app.py."];
    case "HARDWARE_RUNTIME_MISSING":
      return ["Include a runtime field in the JSON printed by hardware_app.py."];
    case "HARDWARE_STATUS_API_MISSING":
      return ["Add /api/status to available_apis."];
    case "HARDWARE_RESULT_API_MISSING":
      return ["Add ./hardware-result.json to available_apis."];
    default:
      return ["Make hardware_app.py output satisfy the VibeBoard hardware contract."];
  }
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
