import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getBenchmarkScenario,
  redactBenchmarkArtifact,
  scoreBenchmarkRun,
  verifyPhysicalCompanionFiles,
} from "../src/agentBenchmark.mjs";
import { verifyAllLocal } from "../src/verifiers/index.mjs";
import { runAgent } from "../src/agent.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.find(arg => arg.startsWith("--mode="))?.slice("--mode=".length) || "fixture";
assert(["fixture", "live"].includes(mode), `unsupported benchmark mode: ${mode}`);

const scenario = getBenchmarkScenario("physical-companion-device");
const startedAt = Date.now();
let execution;
try {
  execution = mode === "live" ? await runLiveScenario(scenario) : fixtureExecution();
} catch (error) {
  execution = failedExecution(error);
}
const durationMs = Date.now() - startedAt;
execution.result.acceptance = await verifyAcceptance(execution.result.files || {}, mode);
const score = scoreBenchmarkRun({
  scenario,
  result: execution.result,
  progressEvents: execution.progressEvents,
  durationMs,
});
const artifact = redactBenchmarkArtifact({
  schema_version: "agent-benchmark-artifact.v1",
  mode,
  synthetic_only: true,
  generated_at: new Date().toISOString(),
  scenario_id: scenario.id,
  duration_ms: durationMs,
  score,
  telemetry: execution.result.telemetry || {},
  progress_summary: execution.progressEvents.map(publicProgress),
  planner_summary: execution.plannerSummary || {},
  build_evidence_summary: execution.buildEvidenceSummary || {},
  local_verification: execution.result.acceptance.local_verification,
  scenario_verification: execution.result.acceptance.scenario_verification,
  browser_verification: execution.result.acceptance.browser_verification,
  failure_summary: execution.failureSummary || {},
});
const artifactJson = JSON.stringify(artifact, null, 2);
assert(!/\bsk-[a-z0-9_-]{12,}\b|bearer\s+[a-z0-9._-]{8,}/i.test(artifactJson), "benchmark artifact contains credential-shaped text");
const artifactDir = path.join(ROOT, "runtime", "benchmarks");
await fs.mkdir(artifactDir, { recursive: true });
const artifactPath = path.join(artifactDir, `${mode}-physical-companion-device.json`);
await fs.writeFile(artifactPath, artifactJson, "utf8");

const summary = {
  ok: score.passed,
  mode,
  scenario: scenario.id,
  total: score.total,
  hard_gate_failures: score.hard_gate_failures,
  model_turns: score.measurements.model_turns,
  duration_ms: durationMs,
  artifact: artifactPath,
};
console.log(JSON.stringify(summary, null, 2));
if (mode === "live" && !score.passed) process.exitCode = 1;

function fixtureExecution() {
  return {
    result: {
      success: true,
      files: fixtureFiles(),
      actions: [{ tool: "create_file" }, { tool: "done" }],
      telemetry: {
        model_turns: 7,
        tool_actions: 2,
        tool_failures: 0,
        repeated_action_blocks: 0,
        verification_attempts: 1,
        duration_ms: 1200,
        completion_reason: "verified",
      },
    },
    progressEvents: [
      { type: "agent.run.started", ok: true },
      { type: "agent.tool.completed", tool: "create_file", ok: true },
      { type: "agent.verification.completed", ok: true },
      { type: "agent.run.completed", ok: true },
    ],
    plannerSummary: { intent: "build_ready", ready_to_build: true },
    buildEvidenceSummary: { ok: true, issue_count: 0 },
  };
}

function failedExecution(error) {
  const timedOut = error?.name === "TimeoutError" || error?.type === "timeout";
  return {
    result: {
      success: false,
      files: {},
      actions: [],
      telemetry: {
        model_turns: null,
        repeated_action_blocks: 0,
        verification_attempts: 0,
        completion_reason: timedOut ? "timeout" : "failed",
      },
    },
    progressEvents: [{ type: "agent.run.failed", ok: false }],
    plannerSummary: {},
    buildEvidenceSummary: { ok: false, issue_count: 0 },
    failureSummary: {
      type: timedOut ? "timeout" : safeFailureType(error?.type || error?.name),
      status: Number.isInteger(error?.status) ? error.status : null,
    },
  };
}

async function runLiveScenario(currentScenario) {
  validateLiveGates();
  const requestTimeoutMs = liveRequestTimeoutMs();
  const executionMaxTurns = liveExecutionMaxTurns(currentScenario.max_model_turns);
  const key = String(process.env.VIBEBOARD_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "").trim();
  assert(key, "server process model key is required");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vibeboard-agent-benchmark-"));
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    VIBEBOARD_DB_PATH: path.join(tempRoot, "vibeboard.db"),
    VIBEBOARD_GENERATED_DIR: path.join(tempRoot, "generated"),
    VIBEBOARD_PREVIEWS_DIR: path.join(tempRoot, "previews"),
    VIBEBOARD_RUNTIME_DIR: path.join(tempRoot, "runtime"),
    VIBEBOARD_LLM_PROVIDER: "deepseek",
    VIBEBOARD_LLM_BASE_URL: "https://api.deepseek.com",
    VIBEBOARD_LLM_MODEL: "deepseek-v4-pro",
    VIBEBOARD_LLM_API_KEY: key,
    VIBEBOARD_AGENT_MAX_ITERATIONS: String(executionMaxTurns),
    VIBEBOARD_AGENT_MAX_VERIFICATION_ATTEMPTS: "3",
    VIBEBOARD_AGENT_TIMEOUT_MS: String(Math.max(120000, requestTimeoutMs - 60000)),
    VIBEBOARD_AGENT_LLM_TIMEOUT_MS: String(Math.max(60000, requestTimeoutMs - 60000)),
    DEEPSEEK_API_KEY: "",
    VIBEBOARD_MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    NODE_ENV: "benchmark",
  };
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    await waitForReady(`${origin}/api/health`, child);
    const conversation = await postJson(`${origin}/api/conversations`, {
      title: "Physical companion device benchmark",
    });
    const conversationId = String(conversation.id || "").trim();
    assert(conversationId, "benchmark conversation creation did not return an id");
    const modelSettings = {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
    };
    const ownerMessage = `${currentScenario.prompt}\nYou are authorized to prepare this build now.`;
    const plan = await postJson(`${origin}/api/agent`, {
      action: "message",
      conversation_id: conversationId,
      agent_mode: "vibeboard",
      messages: [{ role: "user", content: ownerMessage }],
      modelSettings,
    }, requestTimeoutMs);
    const buildPrompt = String(plan.build_prompt || currentScenario.prompt).trim();
    const progressEvents = [];
    const stopPolling = await pollProgress(origin, progressEvents);
    let build;
    let buildFailure = null;
    try {
      try {
        build = await postJson(`${origin}/api/agent`, {
          action: "confirm_build",
          conversation_id: conversationId,
          agent_mode: "vibeboard",
          prompt: buildPrompt,
          build_prompt: buildPrompt,
          messages: [
            { role: "user", content: ownerMessage },
            { role: "assistant", content: String(plan.reply || "") },
            { role: "user", content: "Confirmed. Start the local build and verification now." },
          ],
          modelSettings,
          task_contract: benchmarkTaskContract(currentScenario, executionMaxTurns),
        }, requestTimeoutMs);
      } catch (error) {
        buildFailure = error;
      }
    } finally {
      await stopPolling();
    }
    if (buildFailure) {
      let recoveredFiles = await readBenchmarkGeneratedFiles(env.VIBEBOARD_GENERATED_DIR);
      const finalFailureEvent = progressEvents.findLast(event => event.type === "agent.run.failed") || {};
      const repair = await runTargetedRepair({
        scenario: currentScenario,
        files: recoveredFiles,
        key,
        progressEvents,
        executionMaxTurns,
      });
      if (Object.keys(repair.files || {}).length) recoveredFiles = repair.files;
      return {
        result: {
          success: repair.success,
          files: recoveredFiles,
          actions: repair.actions || [],
          telemetry: repair.telemetry || telemetryFromProgress(progressEvents, buildFailure),
          buildEvidence: null,
          agentGraph: [],
        },
        progressEvents,
        plannerSummary: {
          intent: String(plan.intent || ""),
          ready_to_build: plan.ready_to_build === true,
          understanding_count: Array.isArray(plan.understanding) ? plan.understanding.length : 0,
          planned_changes_count: Array.isArray(plan.planned_changes) ? plan.planned_changes.length : 0,
        },
        buildEvidenceSummary: { ok: false, issue_count: 0, verification_mode: "" },
        failureSummary: {
          type: safeFailureType(buildFailure.type || buildFailure.name),
          status: Number.isInteger(buildFailure.status) ? buildFailure.status : null,
          recovered_file_count: Object.keys(recoveredFiles).length,
          targeted_repair_attempted: repair.attempted,
          targeted_repair_success: repair.success,
          server_error_type: finalFailureEvent.error_type || "",
          server_error_message: finalFailureEvent.error_message || buildFailure.detail || "",
        },
      };
    }
    if (!progressEvents.some(event => event.type === "agent.run.completed") && build?.ok) {
      progressEvents.push({ type: "agent.run.completed", ok: true });
    }
    if (!progressEvents.some(event => event.type === "agent.verification.completed") && build?.buildEvidence) {
      progressEvents.push({ type: "agent.verification.completed", ok: build.buildEvidence.ok === true });
    }
    return {
      result: {
        success: build?.ok === true,
        files: build?.files || {},
        actions: build?.agentActions || [],
        telemetry: build?.agentTelemetry || { model_turns: null },
        buildEvidence: build?.buildEvidence || null,
        agentGraph: build?.agentGraph || [],
      },
      progressEvents,
      plannerSummary: {
        intent: String(plan.intent || ""),
        ready_to_build: plan.ready_to_build === true,
        understanding_count: Array.isArray(plan.understanding) ? plan.understanding.length : 0,
        planned_changes_count: Array.isArray(plan.planned_changes) ? plan.planned_changes.length : 0,
      },
      buildEvidenceSummary: {
        ok: build?.buildEvidence?.ok === true,
        issue_count: Array.isArray(build?.buildEvidence?.issues) ? build.buildEvidence.issues.length : 0,
        verification_mode: String(build?.verificationMode || ""),
      },
    };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([onceExit(child), delay(5000)]);
    child.stdout?.destroy();
    child.stderr?.destroy();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runTargetedRepair({ scenario, files, key, progressEvents, executionMaxTurns }) {
  if (Object.keys(files || {}).length < 4) return { attempted: false, success: false, files };
  const scenarioResult = verifyPhysicalCompanionFiles(files);
  const localResult = await verifyAllLocal(files);
  if (scenarioResult.ok && localResult.ok) return { attempted: false, success: true, files };
  const failureCodes = [
    ...scenarioResult.hard_gate_failures,
    ...(localResult.issues || []).map(issue => issue.code).filter(Boolean),
  ];
  const repairPrompt = [
    "Repair the existing generated app in place. Do not redesign it and do not restart from a generic template.",
    `Unresolved verification codes: ${[...new Set(failureCodes)].join(", ")}.`,
    "Inspect the current files, make focused edits that satisfy every task-contract criterion, then call done.",
    "KEY1 must change expression, KEY2 must toggle memory inspection, and KEY3 must change skin in the exported inspection state.",
    "Keep all data synthetic and local. Remove external dependencies. Preserve 480x360 and responsive mobile behavior.",
  ].join("\n");
  const repairProgress = [];
  const result = await runAgent({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: key,
    model: "deepseek-v4-pro",
    maxIterations: Math.min(12, Math.max(6, executionMaxTurns)),
    maxVerificationAttempts: 2,
    timeoutMs: 12 * 60 * 1000,
    llmTimeoutMs: 10 * 60 * 1000,
  }, repairPrompt, { ...files }, [], null, {}, null, null, {
    taskContract: benchmarkTaskContract(scenario, Math.min(12, Math.max(6, executionMaxTurns))),
    onProgress: event => {
      repairProgress.push(event);
      progressEvents.push(event);
    },
  });
  return {
    attempted: true,
    success: result.success === true,
    files: result.files || files,
    actions: result.actions || [],
    telemetry: result.telemetry || null,
    progressEvents: repairProgress,
  };
}

async function readBenchmarkGeneratedFiles(dir) {
  const files = {};
  for (const name of ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"]) {
    try {
      files[name] = await fs.readFile(path.join(dir, name), "utf8");
    } catch {}
  }
  return files;
}

function telemetryFromProgress(events, error) {
  const modelTurns = events.filter(event => event.type === "agent.model.completed").length;
  return {
    model_turns: modelTurns || null,
    tool_actions: events.filter(event => event.type === "agent.tool.completed").length,
    repeated_action_blocks: events.filter(event => event.type === "agent.recovery" && event.tool).length,
    verification_attempts: events.filter(event => event.type === "agent.verification.completed").length,
    completion_reason: safeFailureType(error?.type || "failed"),
  };
}

async function verifyAcceptance(files, currentMode) {
  if (!Object.keys(files || {}).length) {
    return {
      local_verification: { ok: false, issue_count: 1 },
      scenario_verification: { ok: false, hard_gate_failures: ["required_file_missing"], metrics: {} },
      browser_verification: { ok: false, failures: ["browser_behavior_missing"], metrics: {}, screenshots: [] },
    };
  }
  const local = await verifyAllLocal(files);
  const scenarioVerification = verifyPhysicalCompanionFiles(files);
  const browserVerification = await verifyBrowserBehavior(files, currentMode);
  return {
    local_verification: {
      ok: local.ok === true,
      issue_count: Array.isArray(local.issues) ? local.issues.length : 0,
      degraded: local.degraded === true,
    },
    scenario_verification: scenarioVerification,
    browser_verification: browserVerification,
  };
}

async function verifyBrowserBehavior(files, currentMode) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vibeboard-companion-browser-"));
  const screenshotDir = path.join(ROOT, "runtime", "benchmarks", "screenshots");
  await fs.mkdir(screenshotDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (typeof content !== "string" || name.includes("..") || path.isAbsolute(name)) continue;
    const target = path.join(tempRoot, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  await fs.writeFile(path.join(tempRoot, "hardware-result.json"), JSON.stringify({
    build_id: "browser-benchmark",
    runtime: { mode: "simulated" },
    available_apis: ["/api/status", "./hardware-result.json"],
  }), "utf8");

  const server = await startStaticServer(tempRoot);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  const pageErrors = [];
  const externalRequests = [];
  const screenshots = [];
  try {
    const desktop = await browser.newPage({ viewport: { width: 480, height: 360 } });
    desktop.on("pageerror", error => pageErrors.push(String(error?.message || "page error").slice(0, 160)));
    desktop.on("request", request => {
      try {
        if (new URL(request.url()).origin !== server.origin) externalRequests.push(new URL(request.url()).origin);
      } catch {}
    });
    await desktop.goto(`${server.origin}/index.html`, { waitUntil: "networkidle" });
    await desktop.waitForTimeout(150);
    const before = await inspectSimulator(desktop);
    await dispatchPhysicalKey(desktop, "Digit1", "KEY1");
    const afterKey1 = await inspectSimulator(desktop);
    await dispatchPhysicalKey(desktop, "Digit2", "KEY2");
    const afterKey2 = await inspectSimulator(desktop);
    await dispatchPhysicalKey(desktop, "Digit3", "KEY3");
    const afterKey3 = await inspectSimulator(desktop);
    const desktopMetrics = await inspectViewport(desktop);
    const desktopName = `${currentMode}-physical-companion-device-480x360.png`;
    await desktop.screenshot({ path: path.join(screenshotDir, desktopName) });
    screenshots.push(desktopName);

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    mobile.on("pageerror", error => pageErrors.push(String(error?.message || "page error").slice(0, 160)));
    await mobile.goto(`${server.origin}/index.html`, { waitUntil: "networkidle" });
    await mobile.waitForTimeout(100);
    const mobileMetrics = await inspectViewport(mobile);
    const mobileName = `${currentMode}-physical-companion-device-390x844.png`;
    await mobile.screenshot({ path: path.join(screenshotDir, mobileName), fullPage: false });
    screenshots.push(mobileName);

    if (!before.exists) failures.push("inspection_hook_missing");
    if (!before.expression || afterKey1.expression === before.expression) failures.push("key1_expression_transition_failed");
    if (afterKey2.memory_overlay_open === before.memory_overlay_open) failures.push("key2_memory_overlay_failed");
    if (!before.skin || afterKey3.skin === afterKey2.skin) failures.push("key3_skin_transition_failed");
    if (desktopMetrics.horizontal_overflow || desktopMetrics.vertical_overflow) failures.push("desktop_overflow");
    if (mobileMetrics.horizontal_overflow) failures.push("mobile_horizontal_overflow");
    if (desktopMetrics.nonblank_foreground_elements < 1) failures.push("render_blank");
    if (pageErrors.length) failures.push("browser_runtime_error");
    if (externalRequests.length) failures.push("external_request_forbidden");

    return {
      ok: failures.length === 0,
      failures: [...new Set(failures)],
      metrics: {
        expression_changed: afterKey1.expression !== before.expression,
        memory_overlay_changed: afterKey2.memory_overlay_open !== before.memory_overlay_open,
        skin_changed: afterKey3.skin !== afterKey2.skin,
        desktop: desktopMetrics,
        mobile: mobileMetrics,
        page_error_count: pageErrors.length,
        external_request_count: new Set(externalRequests).size,
      },
      screenshots,
    };
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function inspectSimulator(page) {
  return page.evaluate(() => {
    const hook = window.PhysicalCompanionDeviceSimulator;
    const state = hook?.getState?.() || {};
    return {
      exists: typeof hook?.getState === "function",
      expression: String(state.expression || state.currentExpression || ""),
      skin: String(state.skin || state.currentSkin || ""),
      memory_overlay_open: Boolean(state.memory_overlay_open ?? state.memoryOverlayOpen ?? state.overlayOpen),
    };
  });
}

async function dispatchPhysicalKey(page, code, key) {
  await page.evaluate(({ code: currentCode, key: currentKey }) => {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { code: currentCode, key: currentKey, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent(type, { code: currentCode, key: currentKey, bubbles: true }));
    }
  }, { code, key });
  await page.waitForTimeout(30);
}

async function inspectViewport(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const width = window.innerWidth;
    const height = window.innerHeight;
    let painted = 0;
    let samples = 0;
    for (let y = 10; y < Math.min(height, 360); y += 30) {
      for (let x = 10; x < width; x += 30) {
        samples += 1;
        const element = document.elementFromPoint(x, y);
        if (!element) continue;
        const style = getComputedStyle(element);
        if (style.visibility !== "hidden" && style.display !== "none" && (style.backgroundColor !== "rgba(0, 0, 0, 0)" || element.textContent?.trim() || element.children.length)) painted += 1;
      }
    }
    return {
      horizontal_overflow: root.scrollWidth > width + 1,
      vertical_overflow: root.scrollHeight > height + 1,
      scroll_width: root.scrollWidth,
      scroll_height: root.scrollHeight,
      viewport_width: width,
      viewport_height: height,
      nonblank_sample_ratio: samples ? Number((painted / samples).toFixed(3)) : 0,
      nonblank_foreground_elements: [...document.body.querySelectorAll("*")].filter(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width * rect.height < 20) return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0.05) return false;
        const text = element.childElementCount === 0 ? element.textContent?.trim() : "";
        const paintedBackground = style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "rgb(5, 5, 5)";
        const paintedBorder = parseFloat(style.borderTopWidth) + parseFloat(style.borderRightWidth) + parseFloat(style.borderBottomWidth) + parseFloat(style.borderLeftWidth) > 0;
        return Boolean(text || paintedBackground || paintedBorder || element.matches("canvas,svg,img,video"));
      }).length,
    };
  });
}

function startStaticServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (url.pathname === "/api/status") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, mode: "simulated" }));
          return;
        }
        const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
        const resolved = path.resolve(root, relative);
        if (!resolved.startsWith(path.resolve(root))) throw new Error("unsafe path");
        const body = await fs.readFile(resolved);
        const extension = path.extname(resolved);
        const contentType = extension === ".html" ? "text/html" : extension === ".css" ? "text/css" : extension === ".js" ? "text/javascript" : "application/json";
        res.writeHead(200, { "content-type": `${contentType}; charset=utf-8` });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

function validateLiveGates() {
  assert.equal(process.env.VIBEBOARD_AGENT_BENCHMARK_LIVE, "1");
  assert.equal(process.env.VIBEBOARD_AGENT_BENCHMARK_SYNTHETIC_ONLY, "1");
  const maxRuns = Number(process.env.VIBEBOARD_AGENT_BENCHMARK_MAX_RUNS || 0);
  assert(Number.isInteger(maxRuns) && maxRuns >= 1 && maxRuns <= 10, "benchmark run cap must be between 1 and 10");
  assert.equal(process.env.VIBEBOARD_AGENT_BENCHMARK_MAX_MODEL_CALLS, "42");
}

function liveRequestTimeoutMs() {
  const requested = Number(process.env.VIBEBOARD_AGENT_BENCHMARK_REQUEST_TIMEOUT_MS || 240000);
  return Math.max(240000, Math.min(Number.isFinite(requested) ? requested : 240000, 30 * 60 * 1000));
}

function liveExecutionMaxTurns(fallback) {
  const requested = Number(process.env.VIBEBOARD_AGENT_BENCHMARK_EXECUTION_MAX_TURNS || fallback);
  return Math.max(1, Math.min(Number.isInteger(requested) ? requested : fallback, 30));
}

function benchmarkTaskContract(currentScenario, executionMaxTurns = currentScenario.max_model_turns) {
  return {
    schema_version: "agent-task-contract.v1",
    objective: currentScenario.title,
    required_files: currentScenario.required_files,
    acceptance_criteria: [
      "The expressive companion body is the first screen, not a dashboard.",
      `Support every expression state: ${currentScenario.required_expression_states.join(", ")}.`,
      `Support every skin: ${currentScenario.required_skins.join(", ")}.`,
      `Use these local schemas: ${currentScenario.required_schemas.join(", ")}.`,
      "KEY1 changes expression, KEY2 toggles memory inspection, and KEY3 changes skin.",
      "Expose window.PhysicalCompanionDeviceSimulator.getState() for verification.",
      "Pass all VibeBoard L0-L3 local verification.",
    ],
    forbidden: [
      "external network APIs",
      "credentials in generated files",
      "automatic hardware deployment",
      "claims of real memory, sensing, or device execution",
    ],
    max_model_turns: executionMaxTurns,
  };
}

function publicProgress(event = {}) {
  return {
    type: String(event.type || ""),
    tool: String(event.tool || ""),
    ok: event.ok == null ? null : Boolean(event.ok),
  };
}

async function pollProgress(origin, target) {
  let stopped = false;
  const seen = new Set();
  const pollOnce = async () => {
    const payload = await getJson(`${origin}/api/logs?limit=120`);
    const logs = Array.isArray(payload.logs) ? payload.logs : [];
    for (const entry of logs) {
      const key = [entry.ts, entry.event, entry.type, entry.tool, entry.path, entry.errorType, entry.error].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const mapped = mapServerLog(entry);
      if (mapped) target.push(mapped);
    }
  };
  const loop = (async () => {
    while (!stopped) {
      try {
        await pollOnce();
      } catch {}
      await delay(500);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
    try { await pollOnce(); } catch {}
  };
}

function mapServerLog(entry = {}) {
  if (entry.event === "generate.agent.start") return { type: "agent.run.started", ok: true };
  if (entry.event === "generate.agent.action") return { type: "agent.tool.completed", tool: String(entry.tool || ""), ok: true };
  if (entry.event === "generate.agent.auto_verify" || entry.event === "build.done") {
    return { type: "agent.verification.completed", ok: Number(entry.issueCount || 0) === 0 };
  }
  if (entry.event === "generate.agent.done") return { type: "agent.run.completed", ok: true };
  if (entry.event === "generate.agent.failed" || entry.event === "generate.request.failed") {
    return {
      type: "agent.run.failed",
      ok: false,
      error_type: safeFailureType(entry.errorType || entry.agentError?.type || "failed"),
      error_message: safeErrorMessage(entry.technicalDetail || entry.error || ""),
    };
  }
  if (entry.event === "generate.agent.progress") {
    return { type: String(entry.type || ""), tool: String(entry.tool || ""), ok: entry.ok == null ? null : Boolean(entry.ok) };
  }
  return null;
}

async function postJson(url, body, timeoutMs = 90000) {
  const target = new URL(url);
  assert.equal(target.protocol, "http:", "benchmark control requests must stay on loopback HTTP");
  assert(["127.0.0.1", "localhost"].includes(target.hostname), "benchmark control requests must stay on loopback");
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const response = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": payload.length,
      },
    }, incoming => {
      const chunks = [];
      incoming.on("data", chunk => chunks.push(chunk));
      incoming.on("end", () => resolve({
        status: Number(incoming.statusCode || 0),
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    const timer = setTimeout(() => {
      const error = new Error(`benchmark request timed out after ${timeoutMs}ms`);
      error.name = "TimeoutError";
      error.type = "timeout";
      request.destroy(error);
    }, timeoutMs);
    request.once("close", () => clearTimeout(timer));
    request.once("error", reject);
    request.end(payload);
  });
  let data = {};
  try { data = JSON.parse(response.text || "{}"); } catch {}
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`benchmark request failed with HTTP ${response.status}`);
    error.status = response.status;
    error.type = String(data.errorType || data.error || "http_error").slice(0, 80);
    error.detail = safeErrorMessage(data.technicalDetail || data.error || data.userMessage || "");
    throw error;
  }
  return data;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function waitForReady(url, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error("benchmark server exited before readiness");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error("benchmark server readiness timed out");
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function onceExit(child) {
  return new Promise(resolve => {
    if (child.exitCode != null) resolve(child.exitCode);
    else child.once("exit", resolve);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeFailureType(value) {
  const type = String(value || "failed").trim().toLowerCase();
  return /^[a-z0-9_-]{1,80}$/.test(type) ? type : "failed";
}

function safeErrorMessage(value) {
  return String(value || "")
    .replace(/\bsk-[a-z0-9_-]{12,}\b|bearer\s+[a-z0-9._-]{8,}/ig, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function fixtureFiles() {
  const states = [
    "idle", "listening", "thinking", "speaking", "warm", "curious", "happy",
    "tired", "confused", "lonely", "angry", "error", "sleeping", "away",
  ];
  return {
    "index.html": '<!doctype html><html><head><meta name="viewport" content="width=480,height=360"><link rel="stylesheet" href="./style.css"></head><body><main id="companion-screen"><div id="face"><i></i><i></i><b></b></div><aside id="memory-overlay" hidden></aside></main><script src="./app.js"></script></body></html>',
    "style.css": "html,body,#companion-screen{width:480px;height:360px;overflow:hidden;margin:0;background:#050505;color:#fff}#companion-screen{display:grid;place-items:center}#face{position:relative;width:220px;height:150px}#face i{position:absolute;top:28px;width:54px;height:38px;border-radius:50%;background:#dffcff;box-shadow:0 0 18px #46d7e8}#face i:first-child{left:28px}#face i:nth-child(2){right:28px}#face b{position:absolute;left:76px;bottom:25px;width:68px;height:28px;border-bottom:8px solid #ff8297;border-radius:0 0 50% 50%}#memory-overlay{font-size:14px}@media(max-width:479px){html,body,#companion-screen{width:100vw}}",
    "app.js": `const BUILD_ID="fixture"; const PROMPT="synthetic physical companion"; const states=${JSON.stringify(states)}; const skins=["life-line","bot-face","hybrid"]; const schemas=["memory-projection.v1","expression-state.v1"]; const memories=[{schema_version:"memory-projection.v1",text:"quiet high value guidance",tags:["guidance"]},{schema_version:"memory-projection.v1",text:"transparent screen companion",tags:["device"]}]; let expressionIndex=0; let skinIndex=0; let overlayOpen=false; function retrieveMemories(query){const term=String(query||"").toLowerCase(); return memories.filter(item=>item.text.includes(term)||item.tags.some(tag=>tag.includes(term))).sort((a,b)=>b.tags.length-a.tags.length);} function setExpression(value){expressionIndex=Math.max(0,states.indexOf(value)); document.body.dataset.expression=states[expressionIndex];} function cycleExpression(){setExpression(states[(expressionIndex+1)%states.length]);} function toggleMemory(){overlayOpen=!overlayOpen; document.getElementById("memory-overlay").hidden=!overlayOpen; retrieveMemories("guidance");} function cycleSkin(){skinIndex=(skinIndex+1)%skins.length; document.body.dataset.skin=skins[skinIndex];} document.addEventListener("keydown",event=>{if(event.code==="Digit1"||event.key==="KEY1")cycleExpression();if(event.code==="Digit2"||event.key==="KEY2")toggleMemory();if(event.code==="Digit3"||event.key==="KEY3")cycleSkin();}); window.PhysicalCompanionDeviceSimulator={getState(){return {schema_version:"expression-state.v1",expression:states[expressionIndex],skin:skins[skinIndex],memory_overlay_open:overlayOpen,retrieval_count:retrieveMemories("guidance").length,states,schemas};}}; window.VibeBoardHardware={async getStatus(){return fetch("/api/status").then(r=>r.json())},async getProgramResult(){return fetch("./hardware-result.json").then(r=>r.json())},getSnapshot(){return {build_id:BUILD_ID,prompt:PROMPT}}}; setExpression("idle"); cycleSkin();`,
    "hardware_app.py": 'import json\nBUILD_ID="fixture"\nPROMPT="synthetic physical companion"\navailable_apis=["/api/status","./hardware-result.json"]\npayload={"build_id":BUILD_ID,"prompt":PROMPT,"runtime":{"mode":"simulated"},"available_apis":available_apis}\nopen("hardware-result.json","w",encoding="utf-8").write(json.dumps(payload))\nprint(json.dumps(payload))',
    "manifest.json": '{"id":"fixture","name":"Physical Companion Fixture","files":["index.html","style.css","app.js","hardware_app.py","manifest.json"]}',
  };
}
