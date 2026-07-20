import assert from "node:assert/strict";
import { compactAgentMessages } from "../src/agentContextBudget.mjs";
import { createAgentLoopGuard } from "../src/agentLoopGuard.mjs";
import { createAgentRunTelemetry, publicAgentRunTelemetry } from "../src/agentRunTelemetry.mjs";
import { AGENT_PROGRESS_TYPES, createAgentProgressEvent } from "../src/agentProgress.mjs";

const messages = [{ role: "system", content: "contract" }];
for (let i = 0; i < 30; i += 1) {
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: `c${i}`,
      type: "function",
      function: { name: "read_file", arguments: '{"path":"app.js"}' },
    }],
  });
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
assert(messages[2].content.length > 4000, "compaction must not mutate input messages");

const guard = createAgentLoopGuard({ maxSameActionWithoutProgress: 2 });
assert.equal(guard.beforeTool({ name: "list_files", args: {}, fileRevision: 0 }).allowed, true);
assert.equal(guard.beforeTool({ name: "list_files", args: {}, fileRevision: 0 }).allowed, true);
const blocked = guard.beforeTool({ name: "list_files", args: {}, fileRevision: 0 });
assert.equal(blocked.allowed, false);
assert.match(blocked.guidance, /different action|progress/i);
assert.equal(guard.beforeTool({ name: "list_files", args: {}, fileRevision: 1 }).allowed, true);
assert.equal(guard.beforeTool({ name: "done", args: {}, fileRevision: 1 }).allowed, true);

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

const sanitized = JSON.stringify(publicAgentRunTelemetry({
  ...telemetry.snapshot(),
  apiKey: "synthetic-secret",
  prompt: "private prompt",
  messages: ["private"],
  reasoning_content: "private",
}));
assert(!sanitized.includes("synthetic-secret"));
assert(!sanitized.includes("private prompt"));

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
assert(!JSON.stringify(progress).includes("must not leak"));

console.log("PASS agent loop quality");
