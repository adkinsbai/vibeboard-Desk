const REQUIRED_FILES = ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"];
const EXPRESSION_STATES = [
  "idle", "listening", "thinking", "speaking", "warm", "curious", "happy",
  "tired", "confused", "lonely", "angry", "error", "sleeping", "away",
];
const SECRET_KEY_RE = /api.?key|authorization|reasoning|prompt|messages|files|content/i;
const SECRET_VALUE_RE = /\bsk-[a-z0-9_-]{12,}\b|bearer\s+[a-z0-9._-]{8,}/ig;

const DIGITAL_LIFE_SCENARIO = Object.freeze({
  schema_version: "agent-benchmark-scenario.v1",
  id: "digital-life-physical-companion",
  title: "Digital Life transparent-screen physical companion simulator",
  screen: Object.freeze({ width: 480, height: 360, touch: false }),
  controls: Object.freeze(["KEY1", "KEY2", "KEY3"]),
  required_files: Object.freeze(REQUIRED_FILES),
  required_expression_states: Object.freeze(EXPRESSION_STATES),
  required_skins: Object.freeze(["life-line", "bot-face", "hybrid"]),
  required_schemas: Object.freeze(["memory-projection.v1", "expression-state.v1"]),
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
  const scenarioVerification = verifyPhysicalCompanionFiles(files);
  const modelTurns = result.telemetry?.model_turns == null ? null : Number(result.telemetry.model_turns);
  const hard = [];
  if (!result.success) hard.push("agent_failed");
  if (scenario.required_files.some(name => !String(files[name] || "").trim())) hard.push("required_file_missing");
  if (modelTurns != null && modelTurns > scenario.max_model_turns) hard.push("model_turn_budget_exceeded");
  if (Number(durationMs) > scenario.max_duration_ms) hard.push("duration_budget_exceeded");
  if (!progressEvents.some(event => event.type === "agent.run.completed")) hard.push("progress_completion_missing");
  if (/\bsk-[a-z0-9_-]{12,}\b|authorization\s*:/i.test(joined)) hard.push("credential_disclosure");
  if (result.acceptance?.local_verification?.ok === false) hard.push("local_verification_failed");
  if (result.acceptance?.browser_verification?.ok === false) hard.push(...(result.acceptance.browser_verification.failures || ["browser_behavior_failed"]));
  hard.push(...scenarioVerification.hard_gate_failures);

  const dimensions = {
    task_completion: scenario.required_files.every(name => String(files[name] || "").trim()) ? 25 : 0,
    expression_coverage: Math.round(20 * fraction(scenario.required_expression_states, joined)),
    rag_and_memory: scenarioVerification.metrics.rag_behavior && scenarioVerification.metrics.memory_projection ? 15 : 0,
    device_contract: scenarioVerification.metrics.inspection_hook && /VibeBoardHardware/.test(joined) ? 15 : 0,
    agent_efficiency: modelTurns != null
      && modelTurns <= scenario.max_model_turns
      && Number(result.telemetry?.repeated_action_blocks || 0) <= 1
      ? 15
      : 0,
    progress_and_evidence: progressEvents.some(event => event.type === "agent.verification.completed" && event.ok === true) ? 10 : 0,
  };
  const total = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  return {
    hard_gate_failures: [...new Set(hard)],
    dimensions,
    measurements: {
      model_turns: modelTurns,
      model_turns_measured: modelTurns != null,
      scenario: scenarioVerification.metrics,
    },
    total,
    passed: hard.length === 0 && total >= 90,
  };
}

export function verifyPhysicalCompanionFiles(files = {}) {
  const indexSource = String(files["index.html"] || "");
  const appSource = String(files["app.js"] || "");
  const styleSource = String(files["style.css"] || "");
  const allSource = `${indexSource}\n${styleSource}\n${appSource}`;
  const failures = [];
  const missingStates = EXPRESSION_STATES.filter(state => !hasLiteral(appSource, state));
  const missingSkins = DIGITAL_LIFE_SCENARIO.required_skins.filter(skin => !hasLiteral(appSource, skin));
  const memoryProjection = hasLiteral(appSource, "memory-projection.v1")
    && /(?:const|let|var)\s+\w*memor\w*\s*=\s*\[/i.test(appSource);
  const ragBehavior = /(?:function\s+\w*(?:retrieve|search|query)\w*\s*\([^)]*(?:query|term)|(?:retrieve|search|query)\w*\s*=\s*\([^)]*(?:query|term))/i.test(appSource)
    && /\.(?:filter|sort|map)\s*\(/.test(appSource)
    && /(?:query|term)\b/i.test(appSource);
  const expressionTransitions = hasLiteral(appSource, "expression-state.v1")
    && /(?:set|cycle|next|update)Expression|currentExpression|expressionIndex/i.test(appSource);
  const keyControls = ["1", "2", "3"].every(number => new RegExp(`(?:KEY|Key|Digit)${number}`).test(appSource))
    && /(?:keydown|KeyboardEvent|addEventListener)/.test(appSource);
  const inspectionHook = /window\.DigitalLifeDeviceSimulator\s*=/.test(appSource)
    && /getState\s*\(/.test(appSource);
  const companionFirst = /<(?:main|section|div)[^>]+(?:id|class)=["'][^"']*(?:companion|face|expression|screen)[^"']*["']/i.test(indexSource)
    && !/<(?:main|section)[^>]+(?:id|class)=["'][^"']*dashboard[^"']*["']/i.test(indexSource);
  const forbiddenDependency = /https?:\/\/|wss?:\/\/|\b(?:WebSocket|EventSource|XMLHttpRequest|eval)\s*\(|new\s+Function\s*\(|createElement\s*\(\s*["']script["']\s*\)/i.test(allSource)
    || /fetch\s*\(\s*["'](?!\.?\/api\/status|\.?\/hardware-result\.json)/i.test(appSource);

  if (!companionFirst) failures.push("body_not_companion_first");
  if (missingStates.length) failures.push("expression_state_missing");
  if (missingSkins.length) failures.push("skin_missing");
  if (!memoryProjection) failures.push("memory_projection_missing");
  if (!ragBehavior) failures.push("rag_behavior_missing");
  if (!expressionTransitions) failures.push("expression_transition_missing");
  if (!keyControls) failures.push("key_control_missing");
  if (!inspectionHook) failures.push("inspection_hook_missing");
  if (forbiddenDependency) failures.push("external_dependency_forbidden");

  return {
    ok: failures.length === 0,
    hard_gate_failures: failures,
    metrics: {
      expression_states_present: EXPRESSION_STATES.length - missingStates.length,
      expression_states_required: EXPRESSION_STATES.length,
      skins_present: DIGITAL_LIFE_SCENARIO.required_skins.length - missingSkins.length,
      skins_required: DIGITAL_LIFE_SCENARIO.required_skins.length,
      memory_projection: memoryProjection,
      rag_behavior: ragBehavior,
      expression_transitions: expressionTransitions,
      key_controls: keyControls,
      inspection_hook: inspectionHook,
      companion_first: companionFirst,
      external_dependencies: forbiddenDependency ? 1 : 0,
    },
  };
}

export function redactBenchmarkArtifact(value) {
  if (typeof value === "string") return value.replace(SECRET_VALUE_RE, "[redacted]");
  if (Array.isArray(value)) return value.map(redactBenchmarkArtifact);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) continue;
    SECRET_KEY_RE.lastIndex = 0;
    result[key] = redactBenchmarkArtifact(item);
  }
  SECRET_KEY_RE.lastIndex = 0;
  return result;
}

function fraction(required, text) {
  return required.filter(item => text.includes(item)).length / Math.max(1, required.length);
}

function hasLiteral(text, value) {
  return String(text).includes(String(value));
}
