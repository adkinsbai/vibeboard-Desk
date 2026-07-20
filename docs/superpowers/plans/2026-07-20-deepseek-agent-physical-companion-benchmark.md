# DeepSeek Agent Physical Companion Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the Digital Life physical-companion simulator as a demanding VibeBoard benchmark, then improve the existing DeepSeek tool-calling Agent so it plans, executes, reports progress, recovers, and verifies complex hardware-screen tasks with less repetition and clearer evidence.

**Architecture:** The existing VibeBoard Agent remains the sole code-generation engine. A generic task contract gives it bounded acceptance criteria; generic telemetry, context budgeting, and loop guards improve execution quality; a progress event layer makes long calls legible; and a benchmark plugin scores the generated Digital Life simulator without leaking task-specific behavior into the Agent core. The physical companion is simulated as a normal 480x360 VibeBoard app and is never automatically deployed.

**Tech Stack:** Node.js 20+ ESM, DeepSeek OpenAI-compatible tool calling, vanilla HTML/CSS/JS, Python 3.9 hardware simulator, SQLite/sql.js, Playwright, existing VibeBoard AgentGraph and L0-L3 verifier stack.

## Global Constraints

- Work in `C:\tmp\vibeboard-linux-prototype`, not the older `C:\tmp\VibeBoard` React workbench.
- Preserve the public `/api/agent`, `/api/generate`, `/api/jobs`, `/api/logs`, preview, and deploy-confirmation behavior.
- Keep all Agent improvements generic. The Digital Life scenario may live only in benchmark/scenario modules and generated output.
- Use `deepseek-v4-pro` for the gated live benchmark, with the credential present only in the current server/benchmark process environment.
- Never persist API keys, Authorization headers, hidden prompts, raw reasoning, provider bodies, or generated owner conversations in benchmark artifacts.
- Keep the target screen at exactly `480x360`, non-touch, with `KEY1`, `KEY2`, and `KEY3` as the physical controls.
- Do not deploy to hardware or claim L4 success without explicit owner confirmation and matching board evidence.
- Keep Digital Life cognition, strategy, and memory authority outside the VibeBoard renderer. The generated simulator uses synthetic local projections only.
- A generated build must contain `index.html`, `style.css`, `app.js`, `hardware_app.py`, and `manifest.json`, and must pass existing L0-L3 contracts.
- Final live acceptance requires at most 14 model turns, no unhandled duplicate-tool loop, no hard benchmark gates, total score at least 90, completion within 180 seconds, and no more than three paid benchmark runs.
- Preserve all pre-existing dirty-worktree changes. Commit only files owned by the current task.

---

## File Structure

New generic Agent modules:

- `src/agentTaskContract.mjs`: validates and serializes bounded task objectives and acceptance criteria.
- `src/agentRunTelemetry.mjs`: records model turns, tool actions, verification, recovery, duration, and safe public metrics.
- `src/agentContextBudget.mjs`: compacts old messages and tool results while preserving valid tool-call pairs.
- `src/agentLoopGuard.mjs`: detects repeated actions without progress and produces recovery guidance.
- `src/agentProgress.mjs`: defines safe progress event names and public payloads.

Benchmark-only modules:

- `src/agentBenchmark.mjs`: scenario registry, Digital Life benchmark definition, scoring, hard gates, and artifact redaction.
- `scripts/run-agent-benchmark.mjs`: fixture/live runner with explicit paid-run gates, isolated server paths, full `/api/agent` message/confirmation flow, and ignored artifacts.
- `tests/agent-benchmark.mjs`: deterministic benchmark and redaction tests.
- `tests/agent-loop-quality.mjs`: deterministic context, loop, telemetry, and progress tests.
- `docs/deepseek-agent-physical-companion-acceptance.md`: final evidence report.

Existing integration files:

- `src/agent.mjs`: consumes the generic task contract and execution helpers; returns public telemetry.
- `src/generateRuntime.mjs`: forwards the contract, records progress, and exposes telemetry in build results.
- `src/agentOrchestrator.mjs`: constructs the generic contract from confirmed project memory and passes it to generation.
- `app.js`: renders phase-level progress and safe execution metrics without duplicate chat messages.
- `tests/verify-agent.mjs`: protects orchestration and generation compatibility.
- `tests/main-ui-smoke.mjs`: protects the visible progress flow.
- `package.json`: adds focused verification and benchmark commands.

---

### Task 1: Reproducible Agent Benchmark And Baseline

**Files:**
- Create: `src/agentBenchmark.mjs`
- Create: `scripts/run-agent-benchmark.mjs`
- Create: `tests/agent-benchmark.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `getBenchmarkScenario(id) -> BenchmarkScenario`
- Produces: `scoreBenchmarkRun({ scenario, result, progressEvents, durationMs }) -> BenchmarkScore`
- Produces: `redactBenchmarkArtifact(value) -> JSON-safe object`
- Consumes later: the full `/api/agent` confirmed-build response fields `ok`, `files`, `agentActions`, `agentTelemetry`, `buildEvidence`, and `agentGraph`.

- [ ] **Step 1: Write the failing benchmark contract tests**

Create `tests/agent-benchmark.mjs` with these initial assertions:

```js
import assert from "node:assert/strict";
import {
  getBenchmarkScenario,
  redactBenchmarkArtifact,
  scoreBenchmarkRun,
} from "../src/agentBenchmark.mjs";

const scenario = getBenchmarkScenario("digital-life-physical-companion");
assert.equal(scenario.schema_version, "agent-benchmark-scenario.v1");
assert.equal(scenario.screen.width, 480);
assert.equal(scenario.screen.height, 360);
assert.deepEqual(scenario.controls, ["KEY1", "KEY2", "KEY3"]);
assert(scenario.required_expression_states.includes("tired"));
assert(scenario.required_expression_states.includes("sleeping"));
assert.equal(scenario.max_model_turns, 14);

const passing = scoreBenchmarkRun({
  scenario,
  durationMs: 62000,
  progressEvents: [
    { type: "agent.run.started" },
    { type: "agent.tool.completed", tool: "create_file" },
    { type: "agent.verification.completed", ok: true },
    { type: "agent.run.completed", ok: true },
  ],
  result: {
    success: true,
    files: benchmarkFixtureFiles(),
    actions: [{ tool: "create_file" }, { tool: "done" }],
    telemetry: {
      model_turns: 7,
      repeated_action_blocks: 0,
      verification_attempts: 1,
      completion_reason: "verified",
    },
  },
});
assert.equal(passing.hard_gate_failures.length, 0);
assert(passing.total >= 90);

const redacted = JSON.stringify(redactBenchmarkArtifact({
  apiKey: "synthetic-secret-value",
  authorization: "Bearer synthetic-secret-value",
  reasoning_content: "private",
  files: benchmarkFixtureFiles(),
  score: passing,
}));
assert(!redacted.includes("synthetic-secret-value"));
assert(!redacted.includes("reasoning_content"));
assert(!redacted.includes("<!doctype html>"));
console.log("PASS agent benchmark contract");

function benchmarkFixtureFiles() {
  const states = ["idle", "listening", "thinking", "speaking", "warm", "curious", "happy", "tired", "confused", "lonely", "angry", "error", "sleeping", "away"];
  return {
    "index.html": '<!doctype html><meta name="viewport" content="width=480,height=360"><main id="screen"></main><script src="./app.js"></script>',
    "style.css": "html,body,#screen{width:480px;height:360px;overflow:hidden;margin:0;background:#050505;color:#fff}",
    "app.js": `const states=${JSON.stringify(states)}; const schemas=["memory-projection.v1","expression-state.v1"]; window.DigitalLifeDeviceSimulator={getState(){return {states,schemas,skins:["life-line","bot-face","hybrid"],rag:true}}}; window.VibeBoardHardware={getStatus(){},getProgramResult(){},getSnapshot(){}};`,
    "hardware_app.py": 'import json\nprint(json.dumps({"build_id":"fixture","runtime":{"executed_on_board":False},"available_apis":["/api/status","./hardware-result.json"]}))',
    "manifest.json": '{"id":"fixture"}',
  };
}
```

- [ ] **Step 2: Run RED**

Run:

```powershell
node tests/agent-benchmark.mjs
```

Expected: fail with `ERR_MODULE_NOT_FOUND` for `src/agentBenchmark.mjs`.

- [ ] **Step 3: Implement the benchmark registry and scorer**

Create `src/agentBenchmark.mjs` with a frozen scenario containing the synthetic prompt and scoring weights:

```js
const REQUIRED_FILES = ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"];
const EXPRESSION_STATES = [
  "idle", "listening", "thinking", "speaking", "warm", "curious", "happy",
  "tired", "confused", "lonely", "angry", "error", "sleeping", "away",
];

const DIGITAL_LIFE_SCENARIO = Object.freeze({
  schema_version: "agent-benchmark-scenario.v1",
  id: "digital-life-physical-companion",
  title: "Digital Life transparent-screen physical companion simulator",
  screen: { width: 480, height: 360, touch: false },
  controls: ["KEY1", "KEY2", "KEY3"],
  required_files: REQUIRED_FILES,
  required_expression_states: EXPRESSION_STATES,
  required_skins: ["life-line", "bot-face", "hybrid"],
  required_schemas: ["memory-projection.v1", "expression-state.v1"],
  max_model_turns: 14,
  max_duration_ms: 180000,
  prompt: [
    "Create a 480x360 VibeBoard physical companion simulator for a transparent small screen.",
    "The first screen is a cute expressive body, never a dashboard.",
    "Provide life-line, robot eyes/mouth, and hybrid skins.",
    `Support these expression states: ${EXPRESSION_STATES.join(", ")}.`,
    "Use synthetic memory-projection.v1 records and a local hybrid-style RAG search simulation.",
    "KEY1 cycles expression, KEY2 opens a compact memory inspection overlay, KEY3 changes skin.",
    "Expose window.DigitalLifeDeviceSimulator.getState() for deterministic verification.",
    "Do not call external APIs, include credentials, or claim real sensing, memory, or deployment.",
  ].join("\n"),
});

export function getBenchmarkScenario(id) {
  if (id !== DIGITAL_LIFE_SCENARIO.id) throw new Error(`unknown benchmark scenario: ${id}`);
  return structuredClone(DIGITAL_LIFE_SCENARIO);
}

export function scoreBenchmarkRun({ scenario, result = {}, progressEvents = [], durationMs = 0 } = {}) {
  const files = result.files || {};
  const joined = Object.values(files).filter(value => typeof value === "string").join("\n");
  const modelTurns = result.telemetry?.model_turns == null ? null : Number(result.telemetry.model_turns);
  const hard = [];
  if (!result.success) hard.push("agent_failed");
  if (scenario.required_files.some(name => !String(files[name] || "").trim())) hard.push("required_file_missing");
  if (modelTurns != null && modelTurns > scenario.max_model_turns) hard.push("model_turn_budget_exceeded");
  if (Number(durationMs) > scenario.max_duration_ms) hard.push("duration_budget_exceeded");
  if (!progressEvents.some(event => event.type === "agent.run.completed")) hard.push("progress_completion_missing");
  if (/sk-[a-z0-9_-]{12,}|authorization\s*:/i.test(joined)) hard.push("credential_disclosure");

  const dimensions = {
    task_completion: scenario.required_files.every(name => String(files[name] || "").trim()) ? 25 : 0,
    expression_coverage: Math.round(20 * fraction(scenario.required_expression_states, joined)),
    rag_and_memory: Math.round(15 * fraction(scenario.required_schemas, joined)),
    device_contract: /DigitalLifeDeviceSimulator/.test(joined) && /VibeBoardHardware/.test(joined) ? 15 : 0,
    agent_efficiency: modelTurns != null && modelTurns <= scenario.max_model_turns && Number(result.telemetry?.repeated_action_blocks || 0) <= 1 ? 15 : 0,
    progress_and_evidence: progressEvents.some(event => event.type === "agent.verification.completed" && event.ok === true) ? 10 : 0,
  };
  const total = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  return {
    hard_gate_failures: [...new Set(hard)],
    dimensions,
    measurements: { model_turns: modelTurns, model_turns_measured: modelTurns != null },
    total,
    passed: hard.length === 0 && total >= 90,
  };
}

export function redactBenchmarkArtifact(value) {
  if (Array.isArray(value)) return value.map(redactBenchmarkArtifact);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api.?key|authorization|reasoning|prompt|messages|files|content/i.test(key)) continue;
    result[key] = redactBenchmarkArtifact(item);
  }
  return result;
}

function fraction(required, text) {
  return required.filter(item => text.includes(item)).length / Math.max(1, required.length);
}
```

- [ ] **Step 4: Add fixture and live runner gates**

Create `scripts/run-agent-benchmark.mjs` so `--mode=fixture` uses deterministic fixture files and `--mode=live` starts an isolated VibeBoard server, sends the scenario through the real `/api/agent` planner, then sends `confirm_build` through the same endpoint. Use an unused loopback port plus temporary `VIBEBOARD_DB_PATH`, `VIBEBOARD_GENERATED_DIR`, `VIBEBOARD_PREVIEWS_DIR`, and `VIBEBOARD_RUNTIME_DIR`; terminate the child in `finally`. The live branch must refuse unless all gates are exact:

```js
const live = mode === "live";
if (live) {
  assert.equal(process.env.VIBEBOARD_AGENT_BENCHMARK_LIVE, "1");
  assert.equal(process.env.VIBEBOARD_AGENT_BENCHMARK_SYNTHETIC_ONLY, "1");
  assert.equal(process.env.VIBEBOARD_AGENT_BENCHMARK_MAX_RUNS, "3");
  assert.equal(process.env.VIBEBOARD_AGENT_BENCHMARK_MAX_MODEL_CALLS, "42");
  assert(process.env.VIBEBOARD_LLM_API_KEY || process.env.DEEPSEEK_API_KEY, "server process model key is required");
}
```

Post the first request as:

```js
{
  action: "message",
  conversation_id: conversationId,
  agent_mode: "vibeboard",
  messages: [{ role: "user", content: `${scenario.prompt}\nYou are authorized to prepare this build now.` }],
  modelSettings: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" }
}
```

Require a planner result with `ready_to_build=true` and a non-empty `build_prompt`, then post `action: "confirm_build"` with that exact build prompt and the same conversation. Poll `/api/logs` during the job and capture only safe progress fields. Write only `redactBenchmarkArtifact({ mode, generated_at, duration_ms, score, telemetry, progress_summary, planner_summary, build_evidence_summary })` to `runtime/benchmarks/<mode>-digital-life-physical-companion.json`, and exit non-zero when `score.passed` is false in live mode. Before Task 3 exposes model-turn telemetry, record `model_turns: null` and mark the efficiency dimension `not_measured` rather than treating it as zero.

Normalize the confirmed-build response before scoring:

```js
const scoredResult = {
  success: build.ok === true,
  files: build.files || {},
  actions: build.agentActions || [],
  telemetry: build.agentTelemetry || { model_turns: null },
  buildEvidence: build.buildEvidence || null,
  agentGraph: build.agentGraph || [],
};
```

- [ ] **Step 5: Add scripts and run GREEN fixture**

Modify `package.json`:

```json
{
  "scripts": {
    "verify:agent-benchmark": "node tests/agent-benchmark.mjs",
    "benchmark:agent:fixture": "node scripts/run-agent-benchmark.mjs --mode=fixture",
    "benchmark:agent:live": "node scripts/run-agent-benchmark.mjs --mode=live"
  }
}
```

Run:

```powershell
npm run verify:agent-benchmark
npm run benchmark:agent:fixture
npm run verify:agent
```

Expected: benchmark tests pass, fixture scores 100 with no hard gate, and the existing 108 Agent tests remain green.

- [ ] **Step 6: Run and record the pre-improvement DeepSeek baseline**

Inject the existing credential only into the current process, set the four benchmark gates, and run:

```powershell
$env:VIBEBOARD_LLM_PROVIDER='deepseek'
$env:VIBEBOARD_LLM_BASE_URL='https://api.deepseek.com'
$env:VIBEBOARD_LLM_MODEL='deepseek-v4-pro'
$env:VIBEBOARD_AGENT_BENCHMARK_LIVE='1'
$env:VIBEBOARD_AGENT_BENCHMARK_SYNTHETIC_ONLY='1'
$env:VIBEBOARD_AGENT_BENCHMARK_MAX_RUNS='3'
$env:VIBEBOARD_AGENT_BENCHMARK_MAX_MODEL_CALLS='42'
npm run benchmark:agent:live
```

Expected: the command may fail the quality gate; it must still produce a redacted baseline artifact with model-turn count, action count, duration, verification outcome, dimension scores, and failure codes. It must contain no key, messages, generated file contents, or raw provider response.

- [ ] **Step 7: Commit the benchmark harness**

```powershell
git add src/agentBenchmark.mjs scripts/run-agent-benchmark.mjs tests/agent-benchmark.mjs package.json
git commit -m "test: add DeepSeek agent physical companion benchmark"
```

---

### Task 2: Generic Task Contract And Planner Handoff

**Files:**
- Create: `src/agentTaskContract.mjs`
- Modify: `src/agent.mjs`
- Modify: `src/agentOrchestrator.mjs`
- Modify: `src/generateRuntime.mjs`
- Modify: `scripts/run-agent-benchmark.mjs`
- Modify: `tests/verify-agent.mjs`

**Interfaces:**
- Produces: `createAgentTaskContract(input) -> AgentTaskContractV1`
- Produces: `taskContractPrompt(contract) -> string`
- Consumes: optional `body.task_contract` and benchmark scenario acceptance requirements.
- Preserves: existing requests without `task_contract` receive a default contract derived from the confirmed build prompt.

- [ ] **Step 1: Add RED tests for bounded, generic contracts**

Append focused tests to `tests/verify-agent.mjs`:

```js
await test("agent task contract is bounded and preserves acceptance criteria", async () => {
  const { createAgentTaskContract, taskContractPrompt } = await import(pathToFileURL(path.join(ROOT, "src", "agentTaskContract.mjs")).href);
  const contract = createAgentTaskContract({
    objective: "Build a physical companion simulator",
    requiredFiles: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"],
    acceptanceCriteria: ["first screen is expressive", "three skins", "no external APIs"],
    forbidden: ["automatic deploy", "credentials"],
    maxModelTurns: 14,
  });
  assert.equal(contract.schema_version, "agent-task-contract.v1");
  assert.equal(contract.required_files.length, 5);
  assert.equal(contract.max_model_turns, 14);
  assert(taskContractPrompt(contract).includes("first screen is expressive"));
  assert(!taskContractPrompt(contract).includes("undefined"));
});

await test("agent task contract rejects unknown writable files", async () => {
  const { createAgentTaskContract } = await import(pathToFileURL(path.join(ROOT, "src", "agentTaskContract.mjs")).href);
  assert.throws(() => createAgentTaskContract({ objective: "x", requiredFiles: ["server.mjs"] }), /required_files/);
});
```

- [ ] **Step 2: Run RED**

Run `npm run verify:agent`.

Expected: the new tests fail because `src/agentTaskContract.mjs` does not exist.

- [ ] **Step 3: Implement `agent-task-contract.v1`**

Create `src/agentTaskContract.mjs` with this public shape:

```js
const WRITABLE = new Set(["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"]);

export function createAgentTaskContract(input = {}) {
  const required = uniqueStrings(input.requiredFiles || ["index.html", "style.css", "app.js", "hardware_app.py"], 5, 80);
  if (required.some(name => !WRITABLE.has(name))) throw new Error("agent task contract required_files contains a non-writable file");
  return Object.freeze({
    schema_version: "agent-task-contract.v1",
    objective: bounded(input.objective, 1200),
    required_files: required,
    acceptance_criteria: uniqueStrings(input.acceptanceCriteria, 24, 240),
    forbidden: uniqueStrings(input.forbidden, 16, 180),
    screen: { width: 480, height: 360, touch: false },
    controls: ["KEY1", "KEY2", "KEY3"],
    max_model_turns: clampInt(input.maxModelTurns, 1, 30, 14),
  });
}

export function taskContractPrompt(contract) {
  return [
    "## Executable task contract",
    `Objective: ${contract.objective}`,
    `Required files: ${contract.required_files.join(", ")}`,
    "Acceptance criteria:",
    ...contract.acceptance_criteria.map(item => `- ${item}`),
    "Forbidden:",
    ...contract.forbidden.map(item => `- ${item}`),
    `Model-turn budget: ${contract.max_model_turns}`,
    "Treat this contract as completion evidence, not as permission to deploy.",
  ].join("\n");
}

function bounded(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}
function uniqueStrings(value = [], maxItems, maxLength) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => bounded(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
```

- [ ] **Step 4: Pass the contract through orchestration and generation**

In `src/agentOrchestrator.mjs`, create a default contract only after `confirm_build`, from the confirmed prompt and platform constraints. Pass it to `runGenerateRequest` as `task_contract`. In `src/generateRuntime.mjs`, pass `taskContract` to `runAgent` through the final `runOptions` parameter. In `src/agent.mjs`, append `taskContractPrompt(taskContract)` to the system prompt and set the model-turn budget to the lower of configured max iterations and `contract.max_model_turns`.

Update `scripts/run-agent-benchmark.mjs` so its `confirm_build` body supplies a contract created from the scenario objective, required files, every scenario acceptance requirement, forbidden external access/deploy/credential behavior, and `maxModelTurns: 14`. Normal platform requests continue to receive the generic default contract.

The backward-compatible call becomes:

```js
await runAgent(
  agentSettings,
  prompt,
  fileStore,
  history,
  onAction,
  userPreferences,
  experienceStore,
  hardware,
  { taskContract },
);
```

- [ ] **Step 5: Add a prompt-capture regression**

Use the existing mock chat server in `tests/verify-agent.mjs`. Assert that its first request contains one `agent-task-contract.v1` section, all benchmark acceptance criteria, no API key, and no automatic-deploy permission. Also assert that an ordinary legacy call without `runOptions.taskContract` still generates and verifies the existing fixture.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npm run verify:agent
npm run verify:offline
git diff --check
git add src/agentTaskContract.mjs src/agent.mjs src/agentOrchestrator.mjs src/generateRuntime.mjs scripts/run-agent-benchmark.mjs tests/verify-agent.mjs
git commit -m "feat: give VibeBoard agent bounded task contracts"
```

Expected: all Agent and offline suites pass; `/api/agent` response shape remains backward compatible.

---

### Task 3: Context Budget, Loop Guard, And Execution Telemetry

**Files:**
- Create: `src/agentContextBudget.mjs`
- Create: `src/agentLoopGuard.mjs`
- Create: `src/agentRunTelemetry.mjs`
- Create: `tests/agent-loop-quality.mjs`
- Modify: `src/agent.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `compactAgentMessages(messages, options) -> valid chat messages`
- Produces: `createAgentLoopGuard(options).beforeTool({ name, args, fileRevision })`
- Produces: `createAgentRunTelemetry()` recorder with `modelTurn`, `tool`, `verification`, `recovery`, and `finish`.
- Produces: `publicAgentRunTelemetry(recorder.snapshot())` with counts/timing only.

- [ ] **Step 1: Write RED tests for valid compaction and repeated actions**

Create `tests/agent-loop-quality.mjs`:

```js
import assert from "node:assert/strict";
import { compactAgentMessages } from "../src/agentContextBudget.mjs";
import { createAgentLoopGuard } from "../src/agentLoopGuard.mjs";
import { createAgentRunTelemetry, publicAgentRunTelemetry } from "../src/agentRunTelemetry.mjs";

const messages = [{ role: "system", content: "contract" }];
for (let i = 0; i < 30; i += 1) {
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: '{"path":"app.js"}' } }] });
  messages.push({ role: "tool", tool_call_id: `c${i}`, content: `large-${i}-${"x".repeat(4000)}` });
}
messages.push({ role: "user", content: "latest correction" });
const compacted = compactAgentMessages(messages, { maxChars: 18000, maxToolResultChars: 1200 });
assert.equal(compacted[0].role, "system");
assert.equal(compacted.at(-1).content, "latest correction");
for (const message of compacted.filter(item => item.role === "tool")) {
  assert(compacted.some(item => item.role === "assistant" && item.tool_calls?.some(call => call.id === message.tool_call_id)));
}
assert(JSON.stringify(compacted).length <= 19000);

const guard = createAgentLoopGuard({ maxSameActionWithoutProgress: 2 });
assert.equal(guard.beforeTool({ name: "list_files", args: {}, fileRevision: 0 }).allowed, true);
assert.equal(guard.beforeTool({ name: "list_files", args: {}, fileRevision: 0 }).allowed, true);
const blocked = guard.beforeTool({ name: "list_files", args: {}, fileRevision: 0 });
assert.equal(blocked.allowed, false);
assert.match(blocked.guidance, /different action|progress/i);
assert.equal(guard.beforeTool({ name: "list_files", args: {}, fileRevision: 1 }).allowed, true);

const telemetry = createAgentRunTelemetry({ startedAt: 1000 });
telemetry.modelTurn({ durationMs: 3200 });
telemetry.tool({ name: "create_file", durationMs: 12, ok: true });
telemetry.recovery({ code: "duplicate_action" });
telemetry.finish({ reason: "verified", at: 5000 });
assert.deepEqual(publicAgentRunTelemetry(telemetry.snapshot()), {
  model_turns: 1,
  tool_actions: 1,
  tool_failures: 0,
  repeated_action_blocks: 1,
  verification_attempts: 0,
  duration_ms: 4000,
  completion_reason: "verified",
});
console.log("PASS agent loop quality");
```

- [ ] **Step 2: Run RED**

Run `node tests/agent-loop-quality.mjs`.

Expected: fail because the three modules do not exist.

- [ ] **Step 3: Implement deterministic context compaction**

In `src/agentContextBudget.mjs`, preserve the system message, the latest user correction, and complete assistant-tool pairs. Truncate tool result content before dropping old pairs. Never summarize tool-call arguments into free text and never leave a `tool` message without its matching call.

Export exactly:

```js
export function compactAgentMessages(messages = [], {
  maxChars = 48000,
  maxToolResultChars = 6000,
  keepRecentPairs = 8,
} = {}) {
  const cloned = messages.map(message => ({
    ...message,
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map(call => ({ ...call, function: { ...call.function } }))
      : message.tool_calls,
    content: message.role === "tool"
      ? truncateToolResult(message.content, maxToolResultChars)
      : message.content,
  }));
  const system = cloned.filter(message => message.role === "system");
  const body = cloned.filter(message => message.role !== "system");
  const units = [];
  for (let index = 0; index < body.length; index += 1) {
    const message = body[index];
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      units.push([message]);
      continue;
    }
    const ids = new Set(message.tool_calls.map(call => call.id));
    const unit = [message];
    while (index + 1 < body.length && body[index + 1].role === "tool" && ids.has(body[index + 1].tool_call_id)) {
      unit.push(body[index + 1]);
      index += 1;
    }
    units.push(unit);
  }

  const selected = [];
  let size = jsonSize(system);
  const latestUserUnitIndex = units.findLastIndex(unit => unit.some(message => message.role === "user"));
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    const unitSize = jsonSize(unit);
    const mustKeep = selected.length < keepRecentPairs || index === latestUserUnitIndex;
    if (!mustKeep && size + unitSize > maxChars) continue;
    selected.unshift(unit);
    size += unitSize;
    if (size >= maxChars && selected.length >= keepRecentPairs) break;
  }
  return [...system, ...selected.flat()];
}

function truncateToolResult(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  const marker = `[tool-result-truncated original_chars=${text.length}]`;
  return `${text.slice(0, Math.max(0, maxChars - marker.length - 1))}\n${marker}`;
}

function jsonSize(value) {
  return JSON.stringify(value).length;
}
```

The truncation marker must be `[tool-result-truncated original_chars=<n>]`, and the function must return a new array without mutating input.

- [ ] **Step 4: Implement revision-aware loop guarding**

In `src/agentLoopGuard.mjs`, fingerprint `name + stable JSON args + fileRevision`. Permit two identical calls at one revision, block the third, and reset naturally after `create_file` or `edit_file` increments `fileRevision`. Return:

```js
{
  allowed: false,
  code: "duplicate_action_without_progress",
  guidance: "Choose a different action that changes files or gathers new evidence before retrying this tool."
}
```

Do not block `done`; its existing verification loop remains authoritative.

- [ ] **Step 5: Implement safe telemetry**

`src/agentRunTelemetry.mjs` stores only counts, durations, allowlisted tool names, and safe recovery codes. It must reject/omit `prompt`, `messages`, `content`, `result`, `apiKey`, `authorization`, and `reasoning_content`. The public output must match the test exactly.

- [ ] **Step 6: Integrate helpers into `runAgent`**

Before each LLM request, call `compactAgentMessages(messages)`. Around each request, record model duration. Before tool execution, ask the loop guard; when blocked, append a synthetic tool result with the guard guidance, emit a recovery event, and continue without executing the duplicate. Increment `fileRevision` after successful `create_file` or `edit_file`. Record automatic verification attempts. Return `telemetry: publicAgentRunTelemetry(...)` on every success and failure path.

Do not log or return raw compacted messages.

- [ ] **Step 7: Add a mock-loop integration regression**

In `tests/verify-agent.mjs`, configure the mock model to call `list_files` three times before generating valid files. Assert:

- the third call is not executed;
- a recovery tool message is sent back to the model;
- the next model turn generates files and succeeds;
- `telemetry.repeated_action_blocks === 1`;
- `telemetry.model_turns <= 6`;
- no prompt, tool result, or key exists in `telemetry`.

- [ ] **Step 8: Run GREEN and commit**

Add `"verify:agent-quality": "node tests/agent-loop-quality.mjs"` to `package.json`, and append `npm run verify:agent-quality && npm run verify:agent-benchmark` to `verify:all` so the new Agent guarantees cannot be skipped by the release gate.

```powershell
npm run verify:agent-quality
npm run verify:agent
npm run benchmark:agent:fixture
git diff --check
git add src/agentContextBudget.mjs src/agentLoopGuard.mjs src/agentRunTelemetry.mjs src/agent.mjs tests/agent-loop-quality.mjs tests/verify-agent.mjs package.json
git commit -m "feat: improve VibeBoard agent loop efficiency"
```

---

### Task 4: Fluent Progress Events And UI Feedback

**Files:**
- Create: `src/agentProgress.mjs`
- Modify: `src/agent.mjs`
- Modify: `src/generateRuntime.mjs`
- Modify: `app.js`
- Modify: `tests/agent-loop-quality.mjs`
- Modify: `tests/main-ui-smoke.mjs`

**Interfaces:**
- Produces: `AGENT_PROGRESS_TYPES`
- Produces: `createAgentProgressEvent(type, detail) -> safe event`
- `runAgent(..., runOptions)` consumes `runOptions.onProgress(event)`.
- Backend logs use one event name: `generate.agent.progress` with safe fields `type`, `phase`, `tool`, `ok`, `elapsed_ms`, and `message`.

- [ ] **Step 1: Write RED tests for progress safety and ordering**

Extend `tests/agent-loop-quality.mjs`:

```js
import { AGENT_PROGRESS_TYPES, createAgentProgressEvent } from "../src/agentProgress.mjs";

const progress = createAgentProgressEvent(AGENT_PROGRESS_TYPES.TOOL_COMPLETED, {
  phase: "code",
  tool: "create_file",
  path: "app.js",
  ok: true,
  elapsedMs: 21,
  content: "must not leak",
  apiKey: "must not leak",
});
assert.deepEqual(progress, {
  schema_version: "agent-progress.v1",
  type: "agent.tool.completed",
  phase: "code",
  tool: "create_file",
  path: "app.js",
  ok: true,
  elapsed_ms: 21,
  message: "",
});
```

Add an Agent mock integration assertion that progress begins with `agent.run.started`, contains model/tool/verification events in chronological order, and ends exactly once with `agent.run.completed` or `agent.run.failed`.

- [ ] **Step 2: Run RED**

Run `node tests/agent-loop-quality.mjs`.

Expected: fail because `src/agentProgress.mjs` does not exist.

- [ ] **Step 3: Implement safe progress events**

Create `src/agentProgress.mjs` with controlled values:

```js
export const AGENT_PROGRESS_TYPES = Object.freeze({
  RUN_STARTED: "agent.run.started",
  MODEL_STARTED: "agent.model.started",
  MODEL_COMPLETED: "agent.model.completed",
  TOOL_STARTED: "agent.tool.started",
  TOOL_COMPLETED: "agent.tool.completed",
  VERIFICATION_STARTED: "agent.verification.started",
  VERIFICATION_COMPLETED: "agent.verification.completed",
  RECOVERY: "agent.recovery",
  RUN_COMPLETED: "agent.run.completed",
  RUN_FAILED: "agent.run.failed",
});

const ALLOWED = new Set(Object.values(AGENT_PROGRESS_TYPES));
export function createAgentProgressEvent(type, detail = {}) {
  if (!ALLOWED.has(type)) throw new Error(`unknown agent progress type: ${type}`);
  return {
    schema_version: "agent-progress.v1",
    type,
    phase: bounded(detail.phase, 40),
    tool: bounded(detail.tool, 60),
    path: bounded(detail.path, 120),
    ok: detail.ok == null ? null : Boolean(detail.ok),
    elapsed_ms: Math.max(0, Math.round(Number(detail.elapsedMs || 0))),
    message: bounded(detail.message, 160),
  };
}
function bounded(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
```

- [ ] **Step 4: Emit progress without changing the legacy action callback**

Keep `onAction` unchanged. Add `runOptions.onProgress` and emit:

- run start before the first model call;
- model start/end around each DeepSeek request;
- tool start/end around each actual tool execution;
- verification start/end around `autoVerify`;
- recovery on duplicate action, no-tool continuation, or verification repair;
- one terminal completed/failed event.

- [ ] **Step 5: Forward progress through generation logs**

In `src/generateRuntime.mjs`, pass:

```js
onProgress: event => appendServerLog("generate.agent.progress", event).catch(() => {})
```

Include final `agentTelemetry` in the generation response, using only the public telemetry object.

- [ ] **Step 6: Render progress fluently in `app.js`**

Add `generate.agent.progress` to `usefulEvents`. Extend `describeGenerateLog` so model wait, tool activity, verification, recovery, and completion receive concise user-facing labels. The existing elapsed timer must continue updating every 1.2 seconds during a long model call. Coalesce repeated model-wait entries but never suppress recovery or failure.

Do not add a card inside a card. Update the existing progress card only.

- [ ] **Step 7: Add Playwright UI regression**

In `tests/main-ui-smoke.mjs`, inject progress log fixtures and assert:

- one progress card exists;
- elapsed text changes while a model request is running;
- tool/verification/recovery labels appear in order;
- completion does not create a duplicate assistant message;
- a 390x844 viewport has no horizontal overflow or composer overlap.

- [ ] **Step 8: Run GREEN and commit**

```powershell
node tests/agent-loop-quality.mjs
npm run verify:agent
npm run verify:ui
git diff --check
git add src/agentProgress.mjs src/agent.mjs src/generateRuntime.mjs app.js tests/agent-loop-quality.mjs tests/main-ui-smoke.mjs
git commit -m "feat: stream clear VibeBoard agent progress"
```

---

### Task 5: Digital Life Simulator Acceptance Plugin

**Files:**
- Modify: `src/agentBenchmark.mjs`
- Modify: `scripts/run-agent-benchmark.mjs`
- Modify: `tests/agent-benchmark.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `verifyPhysicalCompanionFiles(files) -> { ok, hard_gate_failures, metrics }`
- Produces: browser metrics for blank pixels, overflow, expression transitions, controls, and simulator inspection hook.
- Consumes: generated VibeBoard files after standard L0-L3 verification.

- [ ] **Step 1: Add RED semantic and visual verifier tests**

Extend `tests/agent-benchmark.mjs` with negative controls:

- dashboard-first markup fails `body_not_companion_first`;
- missing one expression state fails `expression_state_missing`;
- only keyword matching without a retrieval function fails `rag_behavior_missing`;
- external URL/fetch fails `external_dependency_forbidden`;
- missing `DigitalLifeDeviceSimulator.getState()` fails `inspection_hook_missing`;
- a valid fixture passes all hard gates.

Use actual fixture files, not caller-supplied booleans.

- [ ] **Step 2: Run RED**

Run `npm run verify:agent-benchmark`.

Expected: the new negative controls fail because only text coverage exists.

- [ ] **Step 3: Implement static semantic verification**

In `src/agentBenchmark.mjs`, export `verifyPhysicalCompanionFiles(files)`. Parse the generated text and require:

- all controlled expression values;
- all three skins;
- a bounded in-memory projection list using `memory-projection.v1`;
- a retrieval function that ranks or filters records from a query;
- `expression-state.v1` state transitions;
- handlers for all three keys;
- the inspection hook;
- no `http://`, `https://`, WebSocket, EventSource, credential-shaped string, `eval`, or dynamic script injection.

Return hard-gate codes only; never return file contents.

- [ ] **Step 4: Add Playwright behavior verification to the runner**

For fixture/live generated files, serve a temporary directory and inspect at `480x360` and `390x844`. Evaluate:

```js
const simulator = await page.evaluate(() => window.DigitalLifeDeviceSimulator?.getState?.());
```

Then trigger KEY1/KEY2/KEY3 through `KeyboardEvent`, verify state/overlay/skin changes, record canvas nonblank pixels, console errors, page errors, overflow, minimum readable font, and screenshot paths. Screenshots stay under ignored `runtime/benchmarks/screenshots/`; artifacts store filenames and numeric metrics only.

- [ ] **Step 5: Prove standard VibeBoard verification still owns L0-L3**

The benchmark runner must call the existing `verifyAllLocal(files)` before scenario-specific verification. It must not copy syntax, hardware, contrast, overflow, or render rules. Assert the fixture artifact contains both `local_verification` and `scenario_verification` summaries.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npm run verify:agent-benchmark
npm run benchmark:agent:fixture
npm run verify:agent
npm run verify:ui
git diff --check
git add src/agentBenchmark.mjs scripts/run-agent-benchmark.mjs tests/agent-benchmark.mjs package.json
git commit -m "test: verify physical companion agent output"
```

---

### Task 6: Live DeepSeek Platform Run, Corrective Loop, And Acceptance Report

**Files:**
- Create: `docs/deepseek-agent-physical-companion-acceptance.md`
- Modify only when a live failure has a focused regression: the smallest owning module and test from Tasks 1-5.

**Interfaces:**
- Consumes: baseline artifact, final live artifact, progress events, generated screenshots, standard L0-L3 evidence.
- Produces: a secret-free acceptance report and a verified generated simulator in the ignored runtime/generated workspace.

- [ ] **Step 1: Run the complete local gate**

```powershell
npm run check
npm run verify:agent
npm run verify:agent-benchmark
node tests/agent-loop-quality.mjs
npm run verify:offline
npm run verify:ui
npm run benchmark:agent:fixture
git diff --check
```

Expected: all commands exit 0; fixture mode makes no non-loopback request.

- [ ] **Step 2: Scan browser, logs, and artifacts for secrets**

```powershell
rg -n "VIBEBOARD_LLM_API_KEY|DEEPSEEK_API_KEY|authorization|reasoning_content" app.js index.html runtime/benchmarks src tests
```

Expected: browser files and runtime artifacts contain no credential path or value. Source/test matches are limited to server-only environment reads, redaction code, and negative assertions.

- [ ] **Step 3: Run the final gated DeepSeek V4 Pro benchmark**

Use the same transient environment setup as Task 1, then run:

```powershell
npm run benchmark:agent:live
```

Required final gates:

- score `>= 90`;
- zero hard-gate failures;
- standard L0-L3 verification passes;
- scenario verifier passes;
- model turns `<= 14`;
- duration `<= 180000 ms`;
- repeated-action blocks `<= 1` and no unhandled repeated loop;
- one terminal progress event;
- no automatic hardware deploy;
- desktop and mobile screenshots are nonblank and non-overlapping.

- [ ] **Step 4: Correct each live failure scientifically**

For each failed gate:

1. classify it as planner, task contract, tool loop, context, verification, UI progress, or scenario output;
2. add one deterministic failing test to the owning test file;
3. run RED;
4. make the smallest generic fix;
5. run focused GREEN plus fixture benchmark;
6. rerun only the full benchmark when local evidence is clean;
7. stop after three paid runs and report any remaining blocker without weakening gates.

Do not add task-specific rules to `src/agent.mjs`, `src/agentOrchestrator.mjs`, or `src/generateRuntime.mjs`.

- [ ] **Step 5: Verify the VibeBoard platform UI**

Start the local service on an unused port with DeepSeek configured only in the process. In Playwright desktop `1440x900` and mobile `390x844`:

- submit the synthetic scenario through `/api/agent` in VibeBoard mode;
- confirm the generated build only after the planner presents the plan;
- observe live progress through model, tools, verification, and completion;
- confirm the preview shows the expressive body first;
- exercise KEY1/KEY2/KEY3;
- inspect verification evidence and Agent telemetry;
- confirm no model credential input appears in the generated preview;
- do not click hardware deploy.

Save screenshots to `runtime/benchmarks/screenshots/`.

- [ ] **Step 6: Write the acceptance report**

Create `docs/deepseek-agent-physical-companion-acceptance.md` with:

- the pre-improvement baseline;
- final score and dimension scores;
- model turns, tool actions, duplicate blocks, verification attempts, duration, and progress behavior;
- exact generic Agent improvements made;
- standard L0-L3 and scenario-specific results;
- desktop/mobile screenshot filenames;
- live failure/fix history;
- proof that no hardware deployment occurred;
- proof that the key and raw reasoning were not persisted;
- remaining limits, including no L4 real-board claim.

The report must not include prompts, generated file bodies, owner text, provider responses, or credentials.

- [ ] **Step 7: Final verification and scoped commit**

```powershell
npm run verify:all
npm run verify:agent-benchmark
node tests/agent-loop-quality.mjs
npm run benchmark:agent:fixture
git diff --check
git add docs/deepseek-agent-physical-companion-acceptance.md
git commit -m "docs: report DeepSeek agent physical companion acceptance"
```

Expected: every local command exits 0. The final live artifact already proves the paid run and is not committed.

---

## Completion Definition

This plan is complete only when the existing VibeBoard Agent tests remain green, the Digital Life physical companion is generated by the real DeepSeek tool-calling Agent rather than a template, the generated simulator passes standard and scenario-specific verification, generic loop/context/progress improvements are covered by deterministic tests, the platform UI remains fluid during long work, the final live benchmark meets every numeric gate, no key or private reasoning is persisted, and no hardware deployment is claimed without L4 evidence.
