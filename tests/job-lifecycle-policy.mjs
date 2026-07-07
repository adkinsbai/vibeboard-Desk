import { assert } from "./support/serverHarness.mjs";
import {
  FINAL_STATUSES,
  JOB_STATUS,
  compactJobLogEntry,
  compactJobOutput,
  jobIdempotencyScope,
  jobMatchesIdempotencyScope,
  isFinalJobStatus,
  normalizeJobStatus,
} from "../src/jobLifecyclePolicy.mjs";

await test("job lifecycle policy normalizes known statuses and detects final states", () => {
  assert(normalizeJobStatus("running") === JOB_STATUS.RUNNING, "known status should be preserved");
  assert(normalizeJobStatus("bogus") === JOB_STATUS.QUEUED, "unknown status should fall back to queued");
  assert(normalizeJobStatus("bogus", JOB_STATUS.FAILED) === JOB_STATUS.FAILED, "custom fallback should be honored");
  assert(isFinalJobStatus(JOB_STATUS.SUCCEEDED), "succeeded should be final");
  assert(isFinalJobStatus(JOB_STATUS.FAILED), "failed should be final");
  assert(isFinalJobStatus(JOB_STATUS.CANCELED), "canceled should be final");
  assert(!isFinalJobStatus(JOB_STATUS.RUNNING), "running should not be final");
  assert(FINAL_STATUSES.has(JOB_STATUS.CANCELED), "final status set should be exported for callers that need set semantics");
});

await test("job lifecycle policy scopes idempotency by normalized type conversation action user and client run id", () => {
  const scope = jobIdempotencyScope({
    type: "generate",
    conversationId: "conv-a",
    input: {
      action: "confirm_build",
      user_id: "user-a",
      client_run_id: "run-1",
    },
  });

  assert(scope.type === "generate", "scope should include normalized type");
  assert(scope.conversationId === "conv-a", "scope should include normalized conversation id");
  assert(scope.action === "confirm_build", "scope should include normalized action");
  assert(scope.userId === "user-a", "scope should include normalized user id");
  assert(scope.clientRunId === "run-1", "scope should include normalized client run id");

  assert(jobMatchesIdempotencyScope({
    type: "generate",
    conversation_id: "conv-a",
    input: { action: "confirm_build", user_id: "user-a", client_run_id: "run-1" },
  }, scope), "same idempotency scope should match");

  assert(!jobMatchesIdempotencyScope({
    type: "generate",
    conversation_id: "conv-a",
    input: { action: "continue_edit", user_id: "user-a", client_run_id: "run-1" },
  }, scope), "different action should not match");
});

await test("job lifecycle policy compacts log entries and large generated file output", () => {
  const log = compactJobLogEntry({
    ts: "2026-07-07T01:02:03.000Z",
    phase: "x".repeat(100),
    message: "m".repeat(700),
    data: "not-object",
  });
  assert(log.phase.length === 80, "log phase should be capped");
  assert(log.message.length === 600, "log message should be capped");
  assert(JSON.stringify(log.data) === "{}", "non-object log data should be discarded");

  const output = compactJobOutput({
    ok: true,
    files: {
      "app.js": "a".repeat(300010),
      "index.html": "<!doctype html>",
    },
  });
  assert(output.ok === true, "other output fields should be preserved");
  assert(output.files["index.html"] === "<!doctype html>", "small file output should be preserved");
  assert(output.files["app.js"].length < 300050, "large file output should be compacted");
  assert(output.files["app.js"].includes("truncated in job output"), "large file output should include truncation marker");
});

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
