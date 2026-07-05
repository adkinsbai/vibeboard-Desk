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

export function createJobRuntime({ jobStore, classifyError, appendServerLog = async () => {}, timeoutMs = DEFAULT_JOB_TIMEOUT_MS } = {}) {
  if (!jobStore) throw new Error("jobStore is required");
  const handlers = new Map();
  let queue = Promise.resolve();

  function contextFor(jobId) {
    return {
      jobId,
      async phase(phase, message = "") {
        const job = await jobStore.getJob(jobId);
        if (!job || isFinal(job.status)) return job;
        const next = await jobStore.transition(jobId, { phase: String(phase || job.phase || "") });
        if (message) await jobStore.appendLog(jobId, message, {}, phase);
        return next;
      },
      async log(message, data = {}) {
        return await jobStore.appendLog(jobId, message, data);
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

  async function runExisting(jobId) {
    const job = await jobStore.getJob(jobId);
    if (!job || isFinal(job.status)) return job;
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

    await jobStore.transition(jobId, { status: JOB_STATUS.RUNNING, phase: "starting" });
    await jobStore.appendLog(jobId, "Job started.");
    await appendServerLog("job.start", { id: jobId, type: job.type, conversationId: job.conversation_id });

    try {
      const ctx = contextFor(jobId);
      await ctx.checkCanceled();
      const output = await withTimeout(
        handler(job.input || {}, ctx, job),
        Number(job.input?.job_timeout_ms || job.input?.timeout_ms || timeoutMs || DEFAULT_JOB_TIMEOUT_MS),
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
      await appendServerLog("job.done", { id: jobId, type: job.type });
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
      await jobStore.appendLog(jobId, error?.message || "Job failed.", {
        errorType: classified.errorType,
        technicalDetail: classified.technicalDetail,
      });
      await appendServerLog("job.failed", { id: jobId, type: job.type, errorType: classified.errorType, error: error?.message });
    }
    return await jobStore.getJob(jobId);
  }

  function schedule(jobId) {
    queue = queue.then(() => runExisting(jobId), () => runExisting(jobId));
    return queue;
  }

  return {
    register(type, handler) {
      handlers.set(String(type || ""), handler);
    },

    enqueue(type, input = {}, { conversationId = "", title = "" } = {}) {
      const created = jobStore.createJob({
        type,
        conversationId,
        title: title || type,
        input,
        phase: "queued",
      });
      if (isPromiseLike(created)) {
        return created.then(async job => {
          schedule(job.id);
          return await jobStore.getJob(job.id);
        });
      }
      const job = created;
      schedule(job.id);
      return jobStore.getJob(job.id);
    },

    async runNow(type, input = {}, { conversationId = "", title = "" } = {}) {
      const job = await jobStore.createJob({
        type,
        conversationId,
        title: title || type,
        input,
        phase: "queued",
      });
      return await runExisting(job.id);
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
