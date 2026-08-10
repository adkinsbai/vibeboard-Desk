import crypto from "node:crypto";

export const JOB_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELED: "canceled",
});

const FINAL_STATUSES = new Set([
  JOB_STATUS.SUCCEEDED,
  JOB_STATUS.FAILED,
  JOB_STATUS.CANCELED,
]);

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

function normalizeStatus(status, fallback = JOB_STATUS.QUEUED) {
  const value = String(status || "").trim();
  return Object.values(JOB_STATUS).includes(value) ? value : fallback;
}

function normalizeJob(row) {
  if (!row) return null;
  return {
    id: String(row.id || ""),
    type: String(row.type || ""),
    status: normalizeStatus(row.status),
    phase: String(row.phase || ""),
    conversation_id: row.conversation_id || "",
    title: String(row.title || ""),
    organization_id: String(row.organization_id || ""),
    project_id: String(row.project_id || ""),
    build_id: String(row.build_id || ""),
    idempotency_key: String(row.idempotency_key || ""),
    input_digest: String(row.input_digest || ""),
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

const SECRET_OR_VOLATILE_INPUT_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "background",
  "client_run_id",
  "clientrunid",
  "idempotency_key",
  "idempotencykey",
  "request_id",
  "requestid",
  "timeout_ms",
  "job_timeout_ms",
  "as_job",
]);

function canonicalInput(value) {
  if (Array.isArray(value)) return value.map(canonicalInput);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .sort()
    .filter(key => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      return !SECRET_OR_VOLATILE_INPUT_KEYS.has(key.toLowerCase())
        && !SECRET_OR_VOLATILE_INPUT_KEYS.has(normalized)
        && !/(secret|token|password|credential)/i.test(key);
    })
    .map(key => [key, canonicalInput(value[key])])
  );
}

export function digestJobInput(input = {}) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalInput(input))).digest("hex");
}

function stringValue(value) {
  return String(value || "").trim();
}

function legacyOrganizationId(input = {}) {
  const userId = stringValue(input?.user_id);
  return userId ? `personal:${userId}` : "";
}

export function normalizeJobIdentity({
  context = null,
  operation = "",
  type = "",
  organizationId = "",
  organization_id = "",
  projectId = "",
  project_id = "",
  buildId = "",
  build_id = "",
  idempotencyKey = "",
  idempotency_key = "",
  input = {},
} = {}, { requireOrganization = false } = {}) {
  const organization = stringValue(context?.organizationId || context?.organization_id || organizationId || organization_id)
    || stringValue(input?.organization_id)
    || legacyOrganizationId(input);
  if (requireOrganization && !organization) {
    const error = new Error("Job organization identity is required.");
    error.errorType = "execution_context_invalid";
    throw error;
  }
  return {
    type: stringValue(operation || type) || "task",
    organization_id: organization,
    project_id: stringValue(context?.projectId || context?.project_id || projectId || project_id) || stringValue(input?.project_id),
    build_id: stringValue(context?.buildId || context?.build_id || buildId || build_id) || stringValue(input?.build_id),
    idempotency_key: stringValue(idempotencyKey || idempotency_key || context?.idempotencyKey || context?.idempotency_key),
  };
}

export function idempotencyConflict() {
  const error = new Error("Idempotency key was already used with a different request.");
  error.errorType = "idempotency_conflict";
  error.statusCode = 409;
  return error;
}

function compactLogEntry(entry = {}) {
  return {
    ts: entry.ts || new Date().toISOString(),
    phase: String(entry.phase || "").slice(0, 80),
    message: String(entry.message || "").slice(0, 600),
    data: entry.data && typeof entry.data === "object" ? entry.data : {},
  };
}

export function createJobStore(db, saveDb = () => {}, options = {}) {
  const now = options.now || (() => new Date());
  const idFactory = options.idFactory || (() => `job_${crypto.randomUUID()}`);

  function getJob(id) {
    const rows = query(db, "SELECT * FROM jobs WHERE id = ?", [String(id || "")]);
    return normalizeJob(rows[0]);
  }

  function getJobForOrganization(id, organizationId) {
    const rows = query(
      db,
      "SELECT * FROM jobs WHERE organization_id = ? AND id = ?",
      [stringValue(organizationId), String(id || "")]
    );
    return normalizeJob(rows[0]);
  }

  function findJobByIdempotency(identity) {
    if (!identity.organization_id || !identity.idempotency_key) return null;
    const rows = query(
      db,
      "SELECT * FROM jobs WHERE organization_id = ? AND type = ? AND idempotency_key = ?",
      [identity.organization_id, identity.type, identity.idempotency_key]
    );
    return normalizeJob(rows[0]);
  }

  function makeJobRow({
    id = idFactory(),
    type,
    conversationId = "",
    title = "",
    input = {},
    phase = "queued",
    status = JOB_STATUS.QUEUED,
    output = null,
    error = null,
    choices = [],
    logs = null,
    cancel_requested = false,
    created_at = "",
    updated_at = "",
    started_at = "",
    completed_at = "",
    inputDigest = "",
    input_digest = "",
    ...identityInput
  } = {}) {
    const identity = normalizeJobIdentity({ ...identityInput, type, input });
    const ts = isoNow(now);
    const safeStatus = normalizeStatus(status);
    return {
      id: String(id || idFactory()),
      type: identity.type,
      status: safeStatus,
      phase: String(phase || safeStatus),
      conversation_id: String(conversationId || ""),
      title: String(title || ""),
      organization_id: identity.organization_id,
      project_id: identity.project_id,
      build_id: identity.build_id,
      idempotency_key: identity.idempotency_key,
      input_digest: String(inputDigest || input_digest || digestJobInput(input)),
      input,
      output,
      error,
      choices: Array.isArray(choices) ? choices : [],
      logs: Array.isArray(logs) ? logs : [compactLogEntry({ ts, phase, message: "Job accepted." })],
      cancel_requested: Boolean(cancel_requested),
      created_at: created_at || ts,
      updated_at: updated_at || ts,
      started_at: started_at || (safeStatus === JOB_STATUS.RUNNING ? ts : ""),
      completed_at: completed_at || (FINAL_STATUSES.has(safeStatus) ? ts : ""),
    };
  }

  function insertJob(row, { ignoreIdempotencyConflict = false } = {}) {
    const insert = ignoreIdempotencyConflict ? "INSERT OR IGNORE" : "INSERT";
    run(
      db,
      saveDb,
      `${insert} INTO jobs
       (id, type, status, phase, conversation_id, title, organization_id, project_id, build_id, idempotency_key, input_digest,
        input_json, output_json, error_json, choices_json, logs_json, cancel_requested, created_at, updated_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.type, row.status, row.phase, row.conversation_id, row.title, row.organization_id, row.project_id, row.build_id, row.idempotency_key, row.input_digest,
        stringifyJson(row.input, {}), stringifyJson(row.output, null), stringifyJson(row.error, null), stringifyJson(row.choices, []), stringifyJson(row.logs, []),
        row.cancel_requested ? 1 : 0, row.created_at, row.updated_at, row.started_at || "", row.completed_at || "",
      ]
    );
  }

  function updateJob(id, patch = {}) {
    const existing = getJob(id);
    if (!existing) throw new Error(`Job not found: ${id}`);
    const next = {
      ...existing,
      ...patch,
      status: normalizeStatus(patch.status || existing.status),
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
          organization_id TEXT,
          project_id TEXT,
          build_id TEXT,
          idempotency_key TEXT,
          input_digest TEXT,
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
      const columns = new Set(query(db, "PRAGMA table_info(jobs)").map(row => row.name));
      for (const [name, type] of [["organization_id", "TEXT"], ["project_id", "TEXT"], ["build_id", "TEXT"], ["idempotency_key", "TEXT"], ["input_digest", "TEXT"]]) {
        if (!columns.has(name)) db.run(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
      }
      const legacyRows = query(db, "SELECT id, input_json, organization_id, input_digest FROM jobs");
      for (const legacy of legacyRows) {
        const input = parseJson(legacy.input_json, {});
        const organizationId = stringValue(legacy.organization_id) || legacyOrganizationId(input);
        const inputDigest = stringValue(legacy.input_digest) || digestJobInput(input);
        if (organizationId !== stringValue(legacy.organization_id) || inputDigest !== stringValue(legacy.input_digest)) {
          db.run("UPDATE jobs SET organization_id = ?, input_digest = ? WHERE id = ?", [organizationId, inputDigest, legacy.id]);
        }
      }
      db.run("CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)");
      db.run("CREATE INDEX IF NOT EXISTS idx_jobs_conversation_created ON jobs(conversation_id, created_at)");
      db.run("CREATE INDEX IF NOT EXISTS idx_jobs_organization_created ON jobs(organization_id, created_at)");
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_organization_operation_idempotency ON jobs(organization_id, type, idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> ''");
      if (typeof saveDb === "function") saveDb();
    },

    markInterruptedRunningJobs() {
      const interruptedAt = isoNow(now);
      const rows = query(db, "SELECT id, logs_json FROM jobs WHERE status = ?", [JOB_STATUS.RUNNING]);
      for (const row of rows) {
        const logs = parseJson(row.logs_json, []);
        logs.push(compactLogEntry({
          ts: interruptedAt,
          phase: "server_restart",
          message: "Server restarted before this job finished.",
        }));
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

    createJob(input = {}) {
      const row = makeJobRow(input);
      insertJob(row);
      return getJob(row.id);
    },

    getJob,

    getJobForOrganization,

    createOrGetJob({ context, operation, idempotencyKey, input = {}, ...job } = {}) {
      const identity = normalizeJobIdentity({ context, operation, idempotencyKey, input }, { requireOrganization: true });
      const inputDigest = digestJobInput(input);
      const existing = findJobByIdempotency(identity);
      if (existing) {
        if (existing.input_digest !== inputDigest) throw idempotencyConflict();
        return existing;
      }
      const row = makeJobRow({
        ...job,
        type: identity.type,
        organizationId: identity.organization_id,
        projectId: identity.project_id,
        buildId: identity.build_id,
        idempotencyKey: identity.idempotency_key,
        inputDigest,
        input,
      });
      if (!identity.idempotency_key) {
        insertJob(row);
        return getJob(row.id);
      }
      insertJob(row, { ignoreIdempotencyConflict: true });
      const created = getJob(row.id);
      if (created) return created;
      const winner = findJobByIdempotency(identity);
      if (!winner) throw new Error("Idempotency job was not persisted.");
      if (winner.input_digest !== inputDigest) throw idempotencyConflict();
      return winner;
    },

    listJobs({ limit = 50, conversationId = "", status = "", organizationId = "", organization_id = "" } = {}) {
      const clauses = [];
      const params = [];
      if (conversationId) {
        clauses.push("conversation_id = ?");
        params.push(String(conversationId));
      }
      if (status) {
        clauses.push("status = ?");
        params.push(normalizeStatus(status));
      }
      const scopedOrganization = stringValue(organizationId || organization_id);
      if (scopedOrganization) {
        clauses.push("organization_id = ?");
        params.push(scopedOrganization);
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
      const entry = compactLogEntry({
        ts: isoNow(now),
        phase: phase || job.phase || "",
        message,
        data,
      });
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
