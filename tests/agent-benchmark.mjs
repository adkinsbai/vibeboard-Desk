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

const unmeasured = scoreBenchmarkRun({
  scenario,
  durationMs: 62000,
  progressEvents: [{ type: "agent.run.completed", ok: true }],
  result: {
    success: true,
    files: benchmarkFixtureFiles(),
    telemetry: { model_turns: null, repeated_action_blocks: 0 },
  },
});
assert.equal(unmeasured.measurements.model_turns_measured, false);
assert.equal(unmeasured.dimensions.agent_efficiency, 0);

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
