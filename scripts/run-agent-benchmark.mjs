import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getBenchmarkScenario,
  redactBenchmarkArtifact,
  scoreBenchmarkRun,
} from "../src/agentBenchmark.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.find(arg => arg.startsWith("--mode="))?.slice("--mode=".length) || "fixture";
assert(["fixture", "live"].includes(mode), `unsupported benchmark mode: ${mode}`);

const scenario = getBenchmarkScenario("digital-life-physical-companion");
const startedAt = Date.now();
let execution;
try {
  execution = mode === "live" ? await runLiveScenario(scenario) : fixtureExecution();
} catch (error) {
  execution = failedExecution(error);
}
const durationMs = Date.now() - startedAt;
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
  failure_summary: execution.failureSummary || {},
});
const artifactJson = JSON.stringify(artifact, null, 2);
assert(!/\bsk-[a-z0-9_-]{12,}\b|bearer\s+[a-z0-9._-]{8,}/i.test(artifactJson), "benchmark artifact contains credential-shaped text");
const artifactDir = path.join(ROOT, "runtime", "benchmarks");
await fs.mkdir(artifactDir, { recursive: true });
const artifactPath = path.join(artifactDir, `${mode}-digital-life-physical-companion.json`);
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
    VIBEBOARD_AGENT_MAX_ITERATIONS: "14",
    VIBEBOARD_AGENT_MAX_VERIFICATION_ATTEMPTS: "3",
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
      title: "Digital Life physical companion benchmark",
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
    });
    const buildPrompt = String(plan.build_prompt || currentScenario.prompt).trim();
    const progressEvents = [];
    const stopPolling = await pollProgress(origin, progressEvents);
    let build;
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
      }, 240000);
    } finally {
      await stopPolling();
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

function validateLiveGates() {
  assert.equal(process.env.VIBEBOARD_AGENT_BENCHMARK_LIVE, "1");
  assert.equal(process.env.VIBEBOARD_AGENT_BENCHMARK_SYNTHETIC_ONLY, "1");
  assert.equal(process.env.VIBEBOARD_AGENT_BENCHMARK_MAX_RUNS, "3");
  assert.equal(process.env.VIBEBOARD_AGENT_BENCHMARK_MAX_MODEL_CALLS, "42");
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
  let cursor = 0;
  const loop = (async () => {
    while (!stopped) {
      try {
        const payload = await getJson(`${origin}/api/logs?limit=120`);
        const logs = Array.isArray(payload.logs) ? payload.logs : [];
        for (const entry of logs.slice(cursor)) {
          const mapped = mapServerLog(entry);
          if (mapped) target.push(mapped);
        }
        cursor = logs.length;
      } catch {}
      await delay(500);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}

function mapServerLog(entry = {}) {
  if (entry.event === "generate.agent.start") return { type: "agent.run.started", ok: true };
  if (entry.event === "generate.agent.action") return { type: "agent.tool.completed", tool: String(entry.tool || ""), ok: true };
  if (entry.event === "generate.agent.auto_verify" || entry.event === "build.done") {
    return { type: "agent.verification.completed", ok: Number(entry.issueCount || 0) === 0 };
  }
  if (entry.event === "generate.agent.done") return { type: "agent.run.completed", ok: true };
  if (entry.event === "generate.agent.failed") return { type: "agent.run.failed", ok: false };
  if (entry.event === "generate.agent.progress") {
    return { type: String(entry.type || ""), tool: String(entry.tool || ""), ok: entry.ok == null ? null : Boolean(entry.ok) };
  }
  return null;
}

async function postJson(url, body, timeoutMs = 90000) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`benchmark request failed with HTTP ${response.status}`);
    error.status = response.status;
    error.type = String(data.errorType || data.error || "http_error").slice(0, 80);
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

function fixtureFiles() {
  const states = [
    "idle", "listening", "thinking", "speaking", "warm", "curious", "happy",
    "tired", "confused", "lonely", "angry", "error", "sleeping", "away",
  ];
  return {
    "index.html": '<!doctype html><meta name="viewport" content="width=480,height=360"><main id="screen"></main><script src="./app.js"></script>',
    "style.css": "html,body,#screen{width:480px;height:360px;overflow:hidden;margin:0;background:#050505;color:#fff}",
    "app.js": `const states=${JSON.stringify(states)}; const schemas=["memory-projection.v1","expression-state.v1"]; window.DigitalLifeDeviceSimulator={getState(){return {states,schemas,skins:["life-line","bot-face","hybrid"],rag:true}}}; window.VibeBoardHardware={getStatus(){},getProgramResult(){},getSnapshot(){}};`,
    "hardware_app.py": 'import json\nprint(json.dumps({"build_id":"fixture","runtime":{"executed_on_board":False},"available_apis":["/api/status","./hardware-result.json"]}))',
    "manifest.json": '{"id":"fixture"}',
  };
}
