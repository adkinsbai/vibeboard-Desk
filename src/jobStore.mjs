import crypto from "node:crypto";

import {
  FINAL_STATUSES,
  JOB_STATUS,
  compactJobLogEntry,
  jobIdempotencyScope,
  jobMatchesIdempotencyScope,
  normalizeJobStatus,
} from "./jobLifecyclePolicy.mjs";

export { JOB_STATUS } from "./jobLifecyclePolicy.mjs";

function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(db, saveDb, sql, params = []) {
  db.run(sql, params);
  if (typeof saveDb === "function") saveDb();
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function isoNow(now) {
  const value = typeof now === "function" ? now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeJob(row) {
  if (!row) return null;
  return {
    id: String(row.id || ""),
    type: String(row.type || ""),
    status: normalizeJobStatus(row.status),
    phase: String(row.phase || ""),
    conversation_id: row.conversation_id || "",
    title: String(row.title || ""),
    input: parseJson(row.input_json, {}),
    output: parseJson(row.output_json, null),
    error: parseJson(row.error_json, null),
    choices: parseJson(row.choices_json, []),
    logs: parseJson(row.logs_json, []),
    cancel_requested: Number(row.cancel_requested || 0) === 1,
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
    started_at: String(row.started_at || ""),
    completed_at: String(row.completed_at || ""),
  };
}

export function createJobStore(db, saveDb = () => {}, options = {}) {
  const now = options.now || (() => new Date());
  const idFactory = options.idFactory || (() => `job_${crypto.randomUUID()}`);

  function getJob(id) {
    const rows = query(db, "SELECT * FROM jobs WHERE id = ?", [String(id || "")]);
    return normalizeJob(rows[0]);
  }

  function updateJob(id, patch = {}) {
    const existing = getJob(id);
    if (!existing) throw new Error(`Job not found: ${id}`);
    const next = {
      ...existing,
      ...patch,
      status: normalizeJobStatus(patch.status || existing.status),
      updated_at: isoNow(now),
    };
    if (FINAL_STATUSES.has(next.status) && !next.completed_at) next.completed_at = next.updated_at;
    if (next.status === JOB_STATUS.RUNNING && !next.started_at) next.started_at = next.updated_at;
    run(
      db,
      saveDb,
      `UPDATE jobs
       SET status = ?, phase = ?, output_json = ?, error_json = ?, choices_json = ?,
           logs_json = ?, cancel_requested = ?, updated_at = ?, started_at = ?, completed_at = ?
       WHERE id = ?`,
      [
        next.status,
        next.phase || "",
        stringifyJson(next.output, null),
        stringifyJson(next.error, null),
        stringifyJson(next.choices, []),
        stringifyJson(next.logs, []),
        next.cancel_requested ? 1 : 0,
        next.updated_at,
        next.started_at || "",
        next.completed_at || "",
        id,
      ]
    );
    return getJob(id);
  }

  return {
    initSchema() {
      db.run(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          phase TEXT,
          conversation_id TEXT,
          title TEXT,
          input_json TEXT,
          output_json TEXT,
          error_json TEXT,
          choices_json TEXT,
          logs_json TEXT,
          cancel_requested INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        )
      `);
      db.run("CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)");
      db.run("CREATE INDEX IF NOT EXISTS idx_jobs_conversation_created ON jobs(conversation_id, created_at)");
      db.run("CREATE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(type, conversation_id)");
      if (typeof saveDb === "function") saveDb();
    },

    markInterruptedRunningJobs() {
      const interruptedAt = isoNow(now);
      const rows = query(db, "SELECT id, logs_json FROM jobs WHERE status = ?", [JOB_STATUS.RUNNING]);
      for (const row of rows) {
        const logs = parseJson(row.logs_json, []);
        logs.push(compactJobLogEntry({
          ts: interruptedAt,
          phase: "server_restart",
          message: "Server restarted before this job finished.",
        }, { now }));
        run(
          db,
          saveDb,
          `UPDATE jobs
           SET status = ?, phase = ?, error_json = ?, choices_json = ?, logs_json = ?,
               updated_at = ?, completed_at = ?
           WHERE id = ?`,
          [
            JOB_STATUS.FAILED,
            "server_restart",
            stringifyJson({
              errorType: "connection_dropped",
              errorLabel: "Job interrupted",
              errorStage: "runtime",
              userMessage: "The server restarted before this background job finished.",
              suggestion: "Retry the job from Task Center.",
              retryable: true,
              nextActions: ["Retry job", "View logs"],
            }, null),
            stringifyJson([
              { label: "Retry job", action: "retry_job" },
              { label: "View logs", action: "view_logs" },
            ], []),
            stringifyJson(logs.slice(-80), []),
            interruptedAt,
            interruptedAt,
            row.id,
          ]
        );
      }
    },

    createJob({ type, conversationId = "", title = "", input = {}, phase = "queued", status = JOB_STATUS.QUEUED } = {}) {
      const existing = this.findIdempotentJob({ type, conversationId, input });
      if (existing) return existing;
      const id = idFactory();
      const ts = isoNow(now);
      const safeStatus = normalizeJobStatus(status);
      run(
        db,
        saveDb,
        `INSERT INTO jobs
         (id, type, status, phase, conversation_id, title, input_json, output_json, error_json,
          choices_json, logs_json, cancel_requested, created_at, updated_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          id,
          String(type || "task"),
          safeStatus,
          String(phase || safeStatus),
          String(conversationId || ""),
          String(title || ""),
          stringifyJson(input, {}),
          stringifyJson(null, null),
          stringifyJson(null, null),
          stringifyJson([], []),
          stringifyJson([compactJobLogEntry({ ts, phase, message: "Job accepted." }, { now })], []),
          ts,
          ts,
          safeStatus === JOB_STATUS.RUNNING ? ts : "",
          FINAL_STATUSES.has(safeStatus) ? ts : "",
        ]
      );
      return getJob(id);
    },

    getJob,

    findIdempotentJob({ type = "", conversationId = "", input = {} } = {}) {
      const scope = jobIdempotencyScope({ type, conversationId, input });
      if (!scope) return null;
      const rows = query(
        db,
        "SELECT * FROM jobs WHERE type = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT 100",
        [scope.type, scope.conversationId],
      );
      for (const row of rows) {
        const job = normalizeJob(row);
        if (jobMatchesIdempotencyScope(job, scope)) {
          return job;
        }
      }
      return null;
    },

    listJobs({ limit = 50, conversationId = "", status = "" } = {}) {
      const clauses = [];
      const params = [];
      if (conversationId) {
        clauses.push("conversation_id = ?");
        params.push(String(conversationId));
      }
      if (status) {
        clauses.push("status = ?");
        params.push(normalizeJobStatus(status));
      }
      params.push(Math.max(1, Math.min(Number(limit) || 50, 200)));
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return query(db, `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`, params)
        .map(normalizeJob);
    },

    transition(id, patch = {}) {
      return updateJob(id, patch);
    },

    appendLog(id, message, data = {}, phase = "") {
      const job = getJob(id);
      if (!job) throw new Error(`Job not found: ${id}`);
      const entry = compactJobLogEntry({
        ts: isoNow(now),
        phase: phase || job.phase || "",
        message,
        data,
      }, { now });
      return updateJob(id, {
        logs: [...job.logs, entry].slice(-120),
      });
    },

    requestCancel(id) {
      const job = getJob(id);
      if (!job) throw new Error(`Job not found: ${id}`);
      if (FINAL_STATUSES.has(job.status)) return job;
      const canceled = job.status === JOB_STATUS.QUEUED;
      return updateJob(id, {
        cancel_requested: true,
        status: canceled ? JOB_STATUS.CANCELED : job.status,
        phase: canceled ? "canceled" : job.phase,
        error: canceled ? { errorType: "job_canceled", message: "Job canceled before it started." } : job.error,
        choices: canceled ? [] : job.choices,
      });
    },

    isCancelRequested(id) {
      return Boolean(getJob(id)?.cancel_requested);
    },
  };
}
