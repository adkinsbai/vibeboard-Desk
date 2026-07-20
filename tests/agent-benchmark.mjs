import assert from "node:assert/strict";
import {
  getBenchmarkScenario,
  redactBenchmarkArtifact,
  scoreBenchmarkRun,
  verifyPhysicalCompanionFiles,
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

const validScenario = verifyPhysicalCompanionFiles(benchmarkFixtureFiles());
assert.deepEqual(validScenario.hard_gate_failures, []);

const dashboardFirst = benchmarkFixtureFiles();
dashboardFirst["index.html"] = dashboardFirst["index.html"].replace('id="companion-screen"', 'id="dashboard"');
assert(verifyPhysicalCompanionFiles(dashboardFirst).hard_gate_failures.includes("body_not_companion_first"));

const missingExpression = benchmarkFixtureFiles();
missingExpression["app.js"] = missingExpression["app.js"].replace('"tired",', "");
assert(verifyPhysicalCompanionFiles(missingExpression).hard_gate_failures.includes("expression_state_missing"));

const fakeRag = benchmarkFixtureFiles();
fakeRag["app.js"] = fakeRag["app.js"].replace("function retrieveMemories(query)", "function listMemories()");
assert(verifyPhysicalCompanionFiles(fakeRag).hard_gate_failures.includes("rag_behavior_missing"));

const external = benchmarkFixtureFiles();
external["app.js"] += '\nfetch("https://example.com/private")';
assert(verifyPhysicalCompanionFiles(external).hard_gate_failures.includes("external_dependency_forbidden"));

const missingHook = benchmarkFixtureFiles();
missingHook["app.js"] = missingHook["app.js"].replace("window.DigitalLifeDeviceSimulator", "window.MissingSimulator");
assert(verifyPhysicalCompanionFiles(missingHook).hard_gate_failures.includes("inspection_hook_missing"));

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
    "index.html": '<!doctype html><html><head><meta name="viewport" content="width=480,height=360"><link rel="stylesheet" href="./style.css"></head><body><main id="companion-screen"><div id="face"><i></i><i></i><b></b></div><aside id="memory-overlay" hidden></aside></main><script src="./app.js"></script></body></html>',
    "style.css": "html,body,#companion-screen{width:480px;height:360px;overflow:hidden;margin:0;background:#050505;color:#fff}#companion-screen{display:grid;place-items:center}#face{position:relative;width:220px;height:150px}#face i{position:absolute;top:28px;width:54px;height:38px;border-radius:50%;background:#dffcff;box-shadow:0 0 18px #46d7e8}#face i:first-child{left:28px}#face i:nth-child(2){right:28px}#face b{position:absolute;left:76px;bottom:25px;width:68px;height:28px;border-bottom:8px solid #ff8297;border-radius:0 0 50% 50%}#memory-overlay{font-size:14px}@media(max-width:479px){html,body,#companion-screen{width:100vw}}",
    "app.js": `const BUILD_ID="fixture"; const PROMPT="synthetic physical companion"; const states=${JSON.stringify(states)}; const skins=["life-line","bot-face","hybrid"]; const schemas=["memory-projection.v1","expression-state.v1"]; const memories=[{schema_version:"memory-projection.v1",text:"quiet high value guidance",tags:["guidance"]},{schema_version:"memory-projection.v1",text:"transparent screen companion",tags:["device"]}]; let expressionIndex=0; let skinIndex=0; let overlayOpen=false; function retrieveMemories(query){const term=String(query||"").toLowerCase(); return memories.filter(item=>item.text.includes(term)||item.tags.some(tag=>tag.includes(term))).sort((a,b)=>b.tags.length-a.tags.length);} function setExpression(value){expressionIndex=Math.max(0,states.indexOf(value)); document.body.dataset.expression=states[expressionIndex];} function cycleExpression(){setExpression(states[(expressionIndex+1)%states.length]);} function toggleMemory(){overlayOpen=!overlayOpen; document.getElementById("memory-overlay").hidden=!overlayOpen; retrieveMemories("guidance");} function cycleSkin(){skinIndex=(skinIndex+1)%skins.length; document.body.dataset.skin=skins[skinIndex];} document.addEventListener("keydown",event=>{if(event.code==="Digit1"||event.key==="KEY1")cycleExpression();if(event.code==="Digit2"||event.key==="KEY2")toggleMemory();if(event.code==="Digit3"||event.key==="KEY3")cycleSkin();}); window.DigitalLifeDeviceSimulator={getState(){return {schema_version:"expression-state.v1",expression:states[expressionIndex],skin:skins[skinIndex],memory_overlay_open:overlayOpen,retrieval_count:retrieveMemories("guidance").length,states,schemas};}}; window.VibeBoardHardware={async getStatus(){return fetch("/api/status").then(r=>r.json())},async getProgramResult(){return fetch("./hardware-result.json").then(r=>r.json())},getSnapshot(){return {build_id:BUILD_ID,prompt:PROMPT}}}; setExpression("idle"); cycleSkin();`,
    "hardware_app.py": 'import json\nBUILD_ID="fixture"\nPROMPT="synthetic physical companion"\navailable_apis=["/api/status","./hardware-result.json"]\npayload={"build_id":BUILD_ID,"prompt":PROMPT,"runtime":{"mode":"simulated"},"available_apis":available_apis}\nopen("hardware-result.json","w",encoding="utf-8").write(json.dumps(payload))\nprint(json.dumps(payload))',
    "manifest.json": '{"id":"fixture","name":"Physical Companion Fixture","files":["index.html","style.css","app.js","hardware_app.py","manifest.json"]}',
  };
}
