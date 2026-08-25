import assert from "node:assert/strict";
import {
  TASK_ROUTE_SCHEMA_VERSION,
  TASK_ROUTES,
  TASK_ROUTE_THRESHOLDS,
  classifyTaskRoute,
  fast_patch_max_model_turns,
  full_agent_max_model_turns,
  guided_build_max_model_turns,
  routeToExecutionProfile,
  scoreTaskRoute,
  taskRouteRoutes,
} from "../src/taskRoutePolicy.mjs";

function score(input) {
  const result = scoreTaskRoute(input);
  assert.equal(result.schema_version, TASK_ROUTE_SCHEMA_VERSION);
  return result;
}

function assertRoute(input, expectedRoute, expectedHardGate) {
  const scored = score(input);
  const classified = classifyTaskRoute(scored);
  assert.equal(classified.route, expectedRoute);
  if (expectedHardGate) {
    assert(classified.hard_gates.includes(expectedHardGate), "expected hard gate " + expectedHardGate);
  }
  return { scored, classified };
}

assert.equal(TASK_ROUTE_SCHEMA_VERSION, "task-route.v1");
assert.equal(TASK_ROUTES.FAST_PATCH, "fast_patch");
assert.equal(TASK_ROUTES.GUIDED_BUILD, "guided_build");
assert.equal(TASK_ROUTES.FULL_AGENT, "full_agent");
assert.equal(TASK_ROUTES.CLARIFY_OR_BLOCK, "clarify_or_block");

const cosmetic = assertRoute(
  {
    prompt: "把首页标题改成蓝色，顺手调整一下间距",
    projectFiles: ["index.html", "style.css", "app.js"],
    action: "confirm_build",
  },
  "fast_patch",
);
assert(cosmetic.scored.score <= TASK_ROUTE_THRESHOLDS.FAST_PATCH_MAX, "cosmetic single-file task should stay in fast range");
assert(cosmetic.scored.confidence >= 0.65, "cosmetic task should have meaningful confidence");
assert(cosmetic.scored.reasons.some((reason) => reason.includes("single_file") || reason.includes("low_risk")), "cosmetic task should explain why it is fast");

const cosmeticWithExistingHardware = assertRoute(
  {
    prompt: "把那个按钮改成绿色",
    projectFiles: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"],
    projectMemory: ["项目已经接入硬件并完成过部署"],
    action: "confirm_build",
  },
  "fast_patch",
);
assert(!cosmeticWithExistingHardware.scored.hard_gates.includes("hardware_or_deploy"), "existing hardware files must not open a new hardware gate");

const cosmeticCalendar = assertRoute(
  {
    prompt: "把日历标题改成蓝色",
    projectFiles: ["index.html", "style.css", "app.js", "calendar.js"],
    action: "confirm_build",
  },
  "fast_patch",
);
assert(cosmeticCalendar.scored.score <= TASK_ROUTE_THRESHOLDS.FAST_PATCH_MAX, "calendar title patch should stay in fast range");

const calendar = assertRoute(
  {
    prompt: "修复日历周视图里长标题的布局，并补一个回归测试",
    projectFiles: ["src/WeekScheduleView.xaml.cs", "tests/week-schedule.spec.mjs", "docs/notes.md"],
    action: "confirm_build",
  },
  "guided_build",
);
assert(calendar.scored.score >= 21 && calendar.scored.score <= 49, "calendar work should land in guided range");
assert(calendar.scored.reasons.some((reason) => reason.includes("calendar") || reason.includes("multi_file")), "calendar task should be justified as guided");

const newCalendar = assertRoute(
  {
    prompt: "生成一个日历",
    projectFiles: [],
    action: "confirm_build",
  },
  "guided_build",
);
assert(newCalendar.scored.reasons.includes("new_project_surface"), "new calendar builds should receive a bounded guided budget");

const hardware = assertRoute(
  {
    prompt: "接入麦克风并部署到灰色版，顺便接个 API",
    projectFiles: [],
    action: "confirm_build",
  },
  "full_agent",
  "hardware_or_deploy",
);
assert(hardware.scored.score >= TASK_ROUTE_THRESHOLDS.FULL_AGENT_MIN, "hardware or deployment work should be high risk");
assert(hardware.scored.reasons.some((reason) => reason.includes("hardware") || reason.includes("deploy")), "hardware task should explain the gate");

const unclear = assertRoute(
  {
    prompt: "把之前那个改好",
    projectFiles: [],
    action: "message",
  },
  "clarify_or_block",
);
assert(unclear.scored.score <= TASK_ROUTE_THRESHOLDS.FAST_PATCH_MAX, "unclear request should not masquerade as a build");
assert(unclear.scored.reasons.some((reason) => reason.includes("ambiguous") || reason.includes("missing") || reason.includes("insufficient")), "unclear task should explain ambiguity");

const thresholdFast = score({
  prompt: "改一下按钮颜色",
  projectFiles: ["index.html"],
  action: "confirm_build",
});
assert.equal(classifyTaskRoute({ ...thresholdFast, score: 20 }).route, "fast_patch", "score 20 should remain fast_patch");
assert.equal(classifyTaskRoute({ ...thresholdFast, score: 21 }).route, "guided_build", "score 21 should promote to guided_build");
assert.equal(classifyTaskRoute({ ...thresholdFast, score: 49 }).route, "guided_build", "score 49 should remain guided_build");
assert.equal(classifyTaskRoute({ ...thresholdFast, score: 50 }).route, "full_agent", "score 50 should promote to full_agent");

const safeDegrade = score({
  prompt: "改一个文案并检查可能影响的页面",
  projectFiles: ["README.md", "src/home.mjs", "src/settings.mjs"],
  action: "confirm_build",
});
const degradedProfile = routeToExecutionProfile("clarify_or_block", safeDegrade);
assert.equal(degradedProfile.route, "clarify_or_block");
assert.equal(degradedProfile.requires_confirmation, true);
assert(degradedProfile.hard_gates.length >= 1 || degradedProfile.reasons.length >= 1, "degraded profile should still explain itself");

const fastProfile = routeToExecutionProfile("fast_patch", cosmetic.scored);
assert.equal(fastProfile.schema_version, "task-route.v1");
assert.equal(fastProfile.route, "fast_patch");
assert.equal(fastProfile.max_model_turns, fast_patch_max_model_turns);
assert.equal(fastProfile.requires_confirmation, true);
assert.equal(fastProfile.max_verification_attempts, 1);
assert.equal(fastProfile.repair_attempts, 0);

const guidedProfile = routeToExecutionProfile("guided_build", calendar.scored);
assert.equal(guidedProfile.max_model_turns, guided_build_max_model_turns);
assert.equal(guidedProfile.route, "guided_build");
assert.equal(guidedProfile.requires_confirmation, true);

const fullProfile = routeToExecutionProfile("full_agent", hardware.scored);
assert.equal(fullProfile.max_model_turns, full_agent_max_model_turns);
assert.equal(fullProfile.route, "full_agent");
assert.equal(fullProfile.requires_confirmation, true);

assert(taskRouteRoutes.fast_patch && taskRouteRoutes.guided_build && taskRouteRoutes.full_agent && taskRouteRoutes.clarify_or_block, "route constants should expose all route names");

console.log("PASS task route policy");
