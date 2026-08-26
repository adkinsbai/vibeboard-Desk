import { JOB_STATUS } from "./jobStore.mjs";

const FINAL_STATUSES = new Set([
  JOB_STATUS.SUCCEEDED,
  JOB_STATUS.FAILED,
  JOB_STATUS.CANCELED,
]);

function isFinal(status) {
  return FINAL_STATUSES.has(String(status || ""));
}

function compactOutput(output) {
  if (!output || typeof output !== "object") return output ?? null;
  const copy = { ...output };
  if (copy.files && typeof copy.files === "object") {
    copy.files = Object.fromEntries(
      Object.entries(copy.files).map(([name, value]) => [
        name,
        typeof value === "string" && value.length > 300000
          ? `${value.slice(0, 300000)}\n/* truncated in job output */`
          : value,
      ])
    );
  }
  return copy;
}

function serializeError(error, classified) {
  return {
    ok: false,
    error: error?.message || "Job failed",
    ...classified,
    stdout: error?.stdout || "",
    stderr: error?.stderr || "",
  };
}

function actionKey(action = "") {
  return String(action || "").toLowerCase().replace(/\s+/g, "_").replace(/[^\w-]/g, "");
}

function choicesFromError(classified = {}, job = {}) {
  const choices = [];
  const add = (label, action, value = {}) => {
    if (!label || choices.some(item => item.action === action)) return;
    choices.push({ label, action, value });
  };
  const errorType = String(classified.errorType || "");
  if (classified.retryable) add("Retry job", "retry_job", { job_id: job.id });
  if (["no_api_key", "llm_auth", "llm_quota", "llm_network", "llm_failed"].includes(errorType)) {
    add("Open model settings", "open_model_settings");
  }
  if (errorType === "no_api_key") add("Use local template", "retry_local_template", { job_id: job.id });
  if (/deploy|audio|board|ssh/i.test(errorType) || classified.errorStage === "deploy") {
    add("Open board status", "open_board_status");
  }
  for (const action of classified.nextActions || []) {
    add(String(action).slice(0, 24), actionKey(action) || "next_action", { job_id: job.id });
    if (choices.length >= 4) break;
  }
  add("View logs", "view_logs", { job_id: job.id });
  return choices.slice(0, 4);
}

function choicesFromOutput(type, output = {}, job = {}) {
  if (type === "agent" || type === "generate") {
    return [
      { label: "Open result", action: "open_result", value: { job_id: job.id } },
      { label: "Deploy", action: "deploy_job_output", value: { job_id: job.id } },
    ];
  }
  if (type === "deploy") {
    return [
      { label: "Open board status", action: "open_board_status", value: { job_id: job.id } },
      { label: "View logs", action: "view_logs", value: { job_id: job.id } },
    ];
  }
  return [{ label: "View logs", action: "view_logs", value: { job_id: job.id } }];
}

const DEFAULT_JOB_TIMEOUT_MS = 180000;

export function createJobRuntime({
  jobStore,
  classifyError,
  appendServerLog = async () => {},
  timeoutMs = DEFAULT_JOB_TIMEOUT_MS,
  maxConcurrency = 2,
} = {}) {
  if (!jobStore) throw new Error("jobStore is required");
  const handlers = new Map();
  const runtimeInputs = new Map();
  const scheduledJobs = new Set();
  const activeRuns = new Map();
  const pendingRuns = [];
  const concurrency = Math.max(1, Math.min(Number(maxConcurrency) || 2, 64));
  let runningCount = 0;

  function contextFor(jobId) {
    return {
      jobId,
      async phase(phase, message = "") {
        const job = await jobStore.getJob(jobId);
        if (!job || isFinal(job.status)) return job;
        const next = await jobStore.transition(jobId, { phase: String(phase || job.phase || "") });
        if (message) await settleSideEffect(() => jobStore.appendLog(jobId, message, {}, phase));
        return next;
      },
      async log(message, data = {}) {
        return await settleSideEffect(() => jobStore.appendLog(jobId, message, data));
      },
      async checkCanceled() {
        const job = await jobStore.getJob(jobId);
        if (job?.cancel_requested) {
          const error = new Error("Job was canceled.");
          error.errorType = "job_canceled";
          error.statusCode = 409;
          throw error;
        }
      },
    };
  }

  async function runExisting(jobId, runtimeInput = null) {
    const queuedJob = await jobStore.getJob(jobId);
    if (!queuedJob || isFinal(queuedJob.status)) return queuedJob;
    if (queuedJob.status !== JOB_STATUS.QUEUED) return queuedJob;
    const job = typeof jobStore.claimJob === "function"
      ? await jobStore.claimJob(jobId)
      : await jobStore.transition(jobId, { status: JOB_STATUS.RUNNING, phase: "starting" });
    if (!job) return await jobStore.getJob(jobId);
    try {
      await jobStore.transition(jobId, { phase: "claimed" });
    } catch (error) {
      const classified = classifyError
        ? classifyError(error, { stage: "job_claim" })
        : { errorType: error?.errorType || "job_claim_failed", retryable: true };
      await jobStore.transition(jobId, {
        status: JOB_STATUS.FAILED,
        phase: "job_claim",
        error: serializeError(error, classified),
        choices: choicesFromError(classified, job),
      }).catch(() => {});
      return await jobStore.getJob(jobId);
    }
    const handler = handlers.get(job.type);
    if (!handler) {
      await jobStore.transition(jobId, {
        status: JOB_STATUS.FAILED,
        phase: "missing_handler",
        error: { errorType: "job_handler_missing", error: `No handler registered for ${job.type}` },
        choices: [{ label: "View logs", action: "view_logs", value: { job_id: jobId } }],
      });
      return await jobStore.getJob(jobId);
    }
    if (job.cancel_requested) {
      return await jobStore.transition(jobId, {
        status: JOB_STATUS.CANCELED,
        phase: "canceled",
        error: { errorType: "job_canceled", error: "Job canceled before it started." },
      });
    }

    void appendServerLog("job.claimed", { id: jobId, type: job.type, conversationId: job.conversation_id }).catch(() => {});

    try {
      await settleSideEffect(() => jobStore.appendLog(jobId, "Job started."));
      void appendServerLog("job.start", { id: jobId, type: job.type, conversationId: job.conversation_id }).catch(() => {});
      const ctx = contextFor(jobId);
      const executionInput = runtimeInput || job.input || {};
      await ctx.checkCanceled();
      await jobStore.transition(jobId, { phase: "dispatching" });
      const handlerPromise = Promise.resolve().then(() => handler(executionInput, ctx, job));
      const output = await withTimeout(
        handlerPromise,
        Number(executionInput?.job_timeout_ms || executionInput?.timeout_ms || timeoutMs || DEFAULT_JOB_TIMEOUT_MS),
        job
      );
      const latest = await jobStore.getJob(jobId);
      if (latest?.cancel_requested) {
        await jobStore.transition(jobId, {
          status: JOB_STATUS.CANCELED,
          phase: "canceled",
          error: { errorType: "job_canceled", error: "Job was canceled." },
        });
      } else {
        await jobStore.transition(jobId, {
          status: JOB_STATUS.SUCCEEDED,
          phase: "done",
          output: compactOutput(output),
          error: null,
          choices: choicesFromOutput(job.type, output, job),
        });
      }
      void appendServerLog("job.done", { id: jobId, type: job.type }).catch(() => {});
    } catch (error) {
      const classified = classifyError
        ? classifyError(error, { stage: job.type })
        : { errorType: error?.errorType || "unknown", retryable: true, nextActions: ["Retry job"] };
      await jobStore.transition(jobId, {
        status: error?.errorType === "job_canceled" ? JOB_STATUS.CANCELED : JOB_STATUS.FAILED,
        phase: classified.errorStage || job.type || "failed",
        error: serializeError(error, classified),
        choices: choicesFromError(classified, job),
      });
      await settleSideEffect(() => jobStore.appendLog(jobId, error?.message || "Job failed.", {
        errorType: classified.errorType,
        technicalDetail: classified.technicalDetail,
      }));
      void appendServerLog("job.failed", { id: jobId, type: job.type, errorType: classified.errorType, error: error?.message }).catch(() => {});
    }
    return await jobStore.getJob(jobId);
  }

  function schedule(jobId) {
    if (scheduledJobs.has(jobId)) return activeRuns.get(jobId) || Promise.resolve(null);
    scheduledJobs.add(jobId);
    const completion = new Promise((resolve, reject) => {
      pendingRuns.push({ jobId, resolve, reject });
    });
    queueMicrotask(pump);
    return completion;
  }

  function pump() {
    while (runningCount < concurrency && pendingRuns.length) {
      const pending = pendingRuns.shift();
      runningCount += 1;
      runOnce(pending.jobId, runtimeInputs.get(pending.jobId) || null)
        .then(pending.resolve, pending.reject)
        .finally(() => {
          runningCount -= 1;
          scheduledJobs.delete(pending.jobId);
          runtimeInputs.delete(pending.jobId);
          pump();
        });
    }
  }

  async function createOrGetRuntimeJob(type, input, { conversationId = "", title = "", persistedInput = input } = {}) {
    const organizationId = String(persistedInput?.organization_id || input?.organization_id || "").trim();
    const idempotencyKey = String(persistedInput?.idempotency_key || input?.idempotency_key || "").trim();
    const jobInput = {
      type,
      conversationId,
      title: title || type,
      input: persistedInput,
      phase: "queued",
    };
    if (organizationId && idempotencyKey && typeof jobStore.createOrGetJob === "function") {
      return await jobStore.createOrGetJob({
        context: {
          organizationId,
          projectId: persistedInput?.project_id || input?.project_id || "",
          buildId: persistedInput?.build_id || input?.build_id || "",
          idempotencyKey,
        },
        operation: type,
        idempotencyKey,
        ...jobInput,
      });
    }
    return await jobStore.createJob(jobInput);
  }

  async function runOnce(jobId, runtimeInput) {
    if (activeRuns.has(jobId)) return activeRuns.get(jobId);
    const run = (async () => {
      const current = await jobStore.getJob(jobId);
      if (!current || isFinal(current.status) || current.status !== JOB_STATUS.QUEUED) return current;
      return await runExisting(jobId, runtimeInput);
    })().finally(() => activeRuns.delete(jobId));
    activeRuns.set(jobId, run);
    return run;
  }

  return {
    register(type, handler) {
      handlers.set(String(type || ""), handler);
    },

    enqueue(type, input = {}, { conversationId = "", title = "", persistedInput = input } = {}) {
      const created = createOrGetRuntimeJob(type, input, { conversationId, title, persistedInput });
      if (isPromiseLike(created)) {
        return created.then(async job => {
          if (!runtimeInputs.has(job.id)) runtimeInputs.set(job.id, input);
          schedule(job.id);
          return await jobStore.getJob(job.id);
        });
      }
      const job = created;
      if (!runtimeInputs.has(job.id)) runtimeInputs.set(job.id, input);
      schedule(job.id);
      return jobStore.getJob(job.id);
    },

    async runNow(type, input = {}, { conversationId = "", title = "", persistedInput = input } = {}) {
      const job = await createOrGetRuntimeJob(type, input, { conversationId, title, persistedInput });
      return await runOnce(job.id, input);
    },

    resumeQueuedJobs() {
      const jobs = jobStore.listJobs({ status: JOB_STATUS.QUEUED, limit: 200 });
      if (isPromiseLike(jobs)) {
        return jobs.then(items => {
          for (const job of items.reverse()) schedule(job.id);
        });
      }
      for (const job of jobs.reverse()) {
        schedule(job.id);
      }
      return Promise.resolve();
    },

    capacity() {
      return {
        maxConcurrency: concurrency,
        running: runningCount,
        queued: pendingRuns.length,
      };
    },
  };
}

function isPromiseLike(value) {
  return value && typeof value.then === "function";
}

function withTimeout(promise, timeoutMs, job = {}) {
  const ms = Math.max(1000, Math.min(Number(timeoutMs) || DEFAULT_JOB_TIMEOUT_MS, 15 * 60 * 1000));
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Job timed out after ${ms}ms.`);
      error.errorType = "job_timeout";
      error.statusCode = 504;
      error.jobId = job.id || "";
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function settleSideEffect(effect, timeoutMs = 2000) {
  let value;
  try {
    value = typeof effect === "function" ? effect() : effect;
  } catch {
    value = null;
  }
  const promise = Promise.resolve(value).catch(() => null);
  return await Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}
