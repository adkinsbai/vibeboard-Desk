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
  const modelTurns = result.telemetry?.model_turns == null ? null : Number(result.telemetry.model_turns);
  const hard = [];
  if (!result.success) hard.push("agent_failed");
  if (scenario.required_files.some(name => !String(files[name] || "").trim())) hard.push("required_file_missing");
  if (modelTurns != null && modelTurns > scenario.max_model_turns) hard.push("model_turn_budget_exceeded");
  if (Number(durationMs) > scenario.max_duration_ms) hard.push("duration_budget_exceeded");
  if (!progressEvents.some(event => event.type === "agent.run.completed")) hard.push("progress_completion_missing");
  if (/\bsk-[a-z0-9_-]{12,}\b|authorization\s*:/i.test(joined)) hard.push("credential_disclosure");

  const dimensions = {
    task_completion: scenario.required_files.every(name => String(files[name] || "").trim()) ? 25 : 0,
    expression_coverage: Math.round(20 * fraction(scenario.required_expression_states, joined)),
    rag_and_memory: Math.round(15 * fraction(scenario.required_schemas, joined)),
    device_contract: /DigitalLifeDeviceSimulator/.test(joined) && /VibeBoardHardware/.test(joined) ? 15 : 0,
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
    measurements: { model_turns: modelTurns, model_turns_measured: modelTurns != null },
    total,
    passed: hard.length === 0 && total >= 90,
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
