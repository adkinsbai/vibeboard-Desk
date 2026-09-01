import assert from "node:assert/strict";
import initSqlJs from "sql.js";

import { classifyError } from "../src/errorClassifier.mjs";
import { createDebugRecovery } from "../src/debugRuntime.mjs";
import { createJobRuntime } from "../src/jobRuntime.mjs";
import { createJobStore } from "../src/jobStore.mjs";

const SQL = await initSqlJs();

async function waitForFinal(store, jobId, timeoutMs = 800) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = store.getJob(jobId);
    if (["succeeded", "failed", "canceled"].includes(job?.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return store.getJob(jobId);
}

function createRuntime({ recovery, classify = classifyError } = {}) {
  const db = new SQL.Database();
  const store = createJobStore(db, () => {});
  store.initSchema();
  const runtime = createJobRuntime({
    jobStore: store,
    classifyError: classify,
    debugRecovery: recovery,
    timeoutMs: 500,
  });
  return { store, runtime };
}

const playbookUses = [];
const fakePlaybooks = {
  findPlaybooks({ taskType, issues }) {
    return [{
      signature: "issues:local_verify:render_failed:layout_overflow",
      task_type: taskType,
      title: "Fix 480x360 overflow",
      root_cause: "layout overflow",
      diagnosis_steps: issues.map(issue => issue.message || issue.errorType || String(issue)),
      fix: "constrain fixed screen dimensions and rerun render verification",
      verification_evidence: ["render verification passed"],
      score: 12,
    }];
  },
  recordUse(signature, meta) {
    playbookUses.push({ signature, meta });
  },
};

const recovery = createDebugRecovery({
  classifyError,
  playbookStore: fakePlaybooks,
  maxAttempts: 3,
  sameSignatureLimit: 2,
  retryDelayMs: 0,
});

{
  const { store, runtime } = createRuntime({ recovery });
  let attempts = 0;
  runtime.register("generate", async (body) => {
    attempts += 1;
    if (attempts === 1) throw new Error("local verification failed: LAYOUT_OVERFLOW: screen overflows 480x360");
    assert(body.debug_context?.previousFailures?.length === 1, "retry should receive previous failure context");
    return { ok: true, files: { "index.html": "<!doctype html>" } };
  });

  const queued = await runtime.enqueue("generate", { prompt: "calendar" }, { title: "debug recover" });
  const job = await waitForFinal(store, queued.id);
  assert.equal(job.status, "succeeded", `recoverable job should succeed after debug retry: ${JSON.stringify(job.error)}`);
  assert.equal(attempts, 2, "recoverable failure should run one debug retry");
  assert(job.output.debug_recovery?.recovered === true, `output should include recovery evidence: ${JSON.stringify(job.output)}`);
  assert(job.logs.some(log => /Auto debug attempt 1/.test(log.message)), "job logs should show automatic debug attempt");
  assert(playbookUses.some(use => use.meta?.success === true), "successful recovery should record playbook usage");
}

{
  const { store, runtime } = createRuntime({ recovery });
  let attempts = 0;
  runtime.register("generate", async () => {
    attempts += 1;
    const error = new Error("missing api key");
    error.errorType = "no_api_key";
    throw error;
  });

  const queued = await runtime.enqueue("generate", { prompt: "needs model" }, { title: "no key" });
  const job = await waitForFinal(store, queued.id);
  assert.equal(job.status, "failed", "no_api_key should fail instead of auto-debugging forever");
  assert.equal(attempts, 1, "user-actionable failures should not be retried automatically");
  assert(job.choices.some(choice => choice.action === "open_model_settings"), "model config failure should keep choice-based guidance");
  assert(!job.logs.some(log => /Auto debug attempt/.test(log.message)), "no_api_key should not enter debug loop");
}

{
  const { store, runtime } = createRuntime({ recovery });
  let attempts = 0;
  runtime.register("generate", async () => {
    attempts += 1;
    throw new Error("local verification failed: LAYOUT_OVERFLOW: screen overflows 480x360");
  });

  const queued = await runtime.enqueue("generate", { prompt: "bad layout" }, { title: "repeat fail" });
  const job = await waitForFinal(store, queued.id);
  assert.equal(job.status, "failed", "repeated identical debug failures should stop and surface the error");
  assert.equal(attempts, 2, "same signature should stop after the second identical failure");
  assert(job.error.debug_recovery?.stoppedReason === "repeated_signature", `expected repeated signature stop evidence: ${JSON.stringify(job.error)}`);
  assert(job.choices.some(choice => choice.action === "view_logs"), "failed debug run should keep log choice");
}

{
  const boardError = classifyError(new Error("Unable to reach 灰色版. Tried configured:192.168.31.50:22, frp:150.158.146.192:6278. Last error: Connection refused"), { stage: "deploy" });
  assert.equal(boardError.errorType, "board_unreachable", `board transport failures should not be mislabeled as model errors: ${JSON.stringify(boardError)}`);
  assert.equal(boardError.retryable, false, "offline device should require user action instead of automatic retries");
}

console.log("job-debug-runtime: automatic debug recovery boundaries passed");
