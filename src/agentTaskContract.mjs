import { MODEL_WRITABLE_FILE_NAMES } from "./hardwareContractFirewall.mjs";

const WRITABLE = new Set(["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"]);

export function createAgentTaskContract(input = {}) {
  const required = uniqueStrings(
    input.requiredFiles || ["index.html", "style.css", "app.js", "hardware_app.py"],
    5,
    80,
  );
  if (required.some(name => !WRITABLE.has(name))) {
    throw new Error("agent task contract required_files contains a non-contract file");
  }
  return Object.freeze({
    schema_version: "agent-task-contract.v1",
    objective: bounded(input.objective, 1200),
    required_files: Object.freeze(required),
    model_writable_files: Object.freeze([...MODEL_WRITABLE_FILE_NAMES]),
    acceptance_criteria: Object.freeze(uniqueStrings(input.acceptanceCriteria, 24, 240)),
    forbidden: Object.freeze(uniqueStrings(input.forbidden, 16, 180)),
    screen: Object.freeze({ width: 480, height: 360, touch: false }),
    controls: Object.freeze(["KEY1", "KEY2", "KEY3"]),
    max_model_turns: clampInt(input.maxModelTurns, 1, 30, 14),
  });
}

export function taskContractPrompt(contract) {
  if (!contract || contract.schema_version !== "agent-task-contract.v1") return "";
  return [
    "## Executable task contract",
    `Schema: ${contract.schema_version}`,
    `Objective: ${contract.objective}`,
    `Required files: ${contract.required_files.join(", ")}`,
    `Model writable files: ${contract.model_writable_files?.join(", ") || ""}`,
    "System-owned files: hardware_app.py, manifest.json (the model must not create, edit, or delete them)",
    "Acceptance criteria:",
    ...contract.acceptance_criteria.map(item => `- ${item}`),
    "Forbidden:",
    ...contract.forbidden.map(item => `- ${item}`),
    `Screen: ${contract.screen.width}x${contract.screen.height}; touch=${contract.screen.touch}`,
    `Controls: ${contract.controls.join(", ")}`,
    `Model-turn budget: ${contract.max_model_turns}`,
    "Before calling done, inspect the generated files against every acceptance criterion and forbidden item. Missing behavior is unfinished work even when syntax passes.",
    "Use the remaining model turns for focused contract repairs; do not spend them rereading unchanged files unless a verifier points to a specific location.",
    "Treat this contract as completion evidence, not as permission to deploy.",
  ].join("\n");
}

function bounded(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function uniqueStrings(value = [], maxItems, maxLength) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map(item => bounded(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
