export const JOB_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELED: "canceled",
});

export const FINAL_STATUSES = new Set([
  JOB_STATUS.SUCCEEDED,
  JOB_STATUS.FAILED,
  JOB_STATUS.CANCELED,
]);

export function normalizeJobStatus(status, fallback = JOB_STATUS.QUEUED) {
  const value = String(status || "").trim();
  return Object.values(JOB_STATUS).includes(value) ? value : fallback;
}

export function isFinalJobStatus(status) {
  return FINAL_STATUSES.has(String(status || ""));
}

export function normalizeIdempotencyValue(value) {
  return String(value || "").trim().slice(0, 160);
}

export function jobIdempotencyScope({ type = "", conversationId = "", input = {} } = {}) {
  const clientRunId = normalizeIdempotencyValue(input.client_run_id || input.clientRunId);
  if (!clientRunId) return null;
  return {
    type: normalizeIdempotencyValue(type || "task"),
    conversationId: normalizeIdempotencyValue(conversationId || input.conversation_id || input.conversationId),
    action: normalizeIdempotencyValue(input.action || input.job_action || type || "task"),
    userId: normalizeIdempotencyValue(input.user_id || input.userId),
    clientRunId,
  };
}

export function jobMatchesIdempotencyScope(job = {}, scope = null) {
  if (!job || !scope) return false;
  const input = job.input || {};
  return (
    normalizeIdempotencyValue(job.type) === scope.type &&
    normalizeIdempotencyValue(job.conversation_id) === scope.conversationId &&
    normalizeIdempotencyValue(input.client_run_id || input.clientRunId) === scope.clientRunId &&
    normalizeIdempotencyValue(input.action || input.job_action || job.type || "task") === scope.action &&
    normalizeIdempotencyValue(input.user_id || input.userId) === scope.userId
  );
}

export function compactJobLogEntry(entry = {}, options = {}) {
  return {
    ts: entry.ts || isoNow(options.now),
    phase: String(entry.phase || "").slice(0, 80),
    message: String(entry.message || "").slice(0, 600),
    data: entry.data && typeof entry.data === "object" ? entry.data : {},
  };
}

export function compactJobOutput(output) {
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

function isoNow(now) {
  const value = typeof now === "function" ? now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
