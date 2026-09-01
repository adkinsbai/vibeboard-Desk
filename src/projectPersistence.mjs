import { promises as fs } from "node:fs";
import path from "node:path";

import {
  declaredAssetPathsFromFiles,
  deserializeFileMap,
  serializeFileMap,
} from "./assetContract.mjs";
import { createConversationStore } from "./conversationStore.mjs";
import {
  CONVERSATION_FILE_NAMES,
  defaultProjectMemory,
  filterConversationFiles,
  normalizeProjectMemory,
} from "./conversationStore.mjs";
import {
  createJobStore,
  digestJobInput,
  idempotencyConflict,
  normalizeJobIdentity,
  sanitizeJobInput,
} from "./jobStore.mjs";

const fileMutationLocks = new Map();
const FILE_LOCK_RETRY_MS = 15;
const FILE_LOCK_TIMEOUT_MS = 15000;
const FILE_LOCK_STALE_MS = 60000;

export function createProjectPersistence(options = {}) {
  const { pg = null, sqliteDb = null, saveSqlite = () => {}, env = process.env } = options;
  if (env.VIBEBOARD_TEST_PROJECT_PERSISTENCE_FILE) {
    return createFileProjectPersistence({ filePath: env.VIBEBOARD_TEST_PROJECT_PERSISTENCE_FILE });
  }
  if (pg && (env.VERCEL === "1" || env.VIBEBOARD_PUBLIC_DEPLOYMENT === "1")) {
    return createPostgresProjectPersistence({ pg });
  }
  return createSqliteProjectPersistence({ sqliteDb, saveSqlite, jobOptions: options.jobOptions || {} });
}

export function createSqliteProjectPersistence({ sqliteDb, saveSqlite = () => {}, jobOptions = {} } = {}) {
  if (!sqliteDb) throw new Error("sqlite db is required");
  const conversationStore = createConversationStore(sqliteDb, saveSqlite);
  const jobStore = createJobStore(sqliteDb, saveSqlite, jobOptions);
  const persistence = wrapStores(conversationStore, jobStore);
  persistence._sqliteDb = sqliteDb;
  return persistence;
}

export async function readLegacySqliteSnapshot(buffer) {
  if (!buffer?.length) return null;
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(buffer);
  const legacy = createSqliteProjectPersistence({ sqliteDb: db, saveSqlite: () => {} });
  await legacy.initSchema();
  return legacy;
}

async function migrateLegacySqliteSnapshotInto(target, buffer) {
  const legacy = await readLegacySqliteSnapshot(buffer);
  if (!legacy) return;

  const legacyRows = readLegacySqliteRows(legacy);
  const conversations = legacyRows.conversations.length ? legacyRows.conversations : await legacy.listConversations();
  for (const conversation of conversations) {
    const conversationId = conversation.id;
    if (!conversationId) continue;

    const existingConversation = await target.getConversation(conversationId);
    if (!existingConversation) {
      await target.createConversation(conversationId, conversation.title || "New App", {
        userId: conversation.user_id || "",
        projectDir: conversation.project_dir || "",
      });
    }

    const messages = legacyRows.messages.filter(row => row.conversation_id === conversationId);
    if (messages.length) {
      if (typeof target.importLegacyMessages === "function") {
        await target.importLegacyMessages(conversationId, messages);
      } else if ((await target.listMessages(conversationId)).length === 0) {
        for (const message of messages) await target.appendMessage(conversationId, message);
      }
    }

    const fileRows = legacyRows.conversation_files.filter(row => row.conversation_id === conversationId);
    if (fileRows.length) {
      if (typeof target.importLegacyConversationFiles === "function") {
        await target.importLegacyConversationFiles(conversationId, fileRows);
      } else {
        const targetFiles = await target.loadConversationFiles(conversationId);
        if (Object.keys(targetFiles?.files || {}).length === 0) {
          const legacyFiles = await legacy.loadConversationFiles(conversationId);
          if (Object.keys(legacyFiles?.files || {}).length) {
            await target.saveConversationFiles(conversationId, legacyFiles.buildId || "", legacyFiles.files);
          }
        }
      }
    }

    const memoryRow = legacyRows.project_memory.find(row => row.conversation_id === conversationId);
    if (memoryRow) {
      const targetMemory = await target.getProjectMemory(conversationId);
      if (isDefaultProjectMemory(targetMemory)) {
        const legacyMemory = parseProjectMemoryRow(memoryRow);
        if (!isDefaultProjectMemory(legacyMemory)) {
          if (typeof target.importLegacyProjectMemory === "function") {
            await target.importLegacyProjectMemory(conversationId, legacyMemory);
          } else {
            await target.setProjectMemory(conversationId, legacyMemory);
          }
        }
      }
    }
  }

  const jobs = legacyRows.jobs.length ? legacyRows.jobs.map(normalizeLegacyJobRow) : await listAllLegacyJobs(legacy);
  for (const job of jobs) {
    if (!job?.id || await target.getJob(job.id)) continue;
    await target.createJob({
      id: job.id,
      type: job.type,
      conversationId: job.conversation_id,
      title: job.title,
      organizationId: job.organization_id,
      projectId: job.project_id,
      buildId: job.build_id,
      idempotencyKey: job.idempotency_key,
      inputDigest: job.input_digest,
      input: job.input,
      phase: job.phase,
      status: job.status,
      output: job.output,
      error: job.error,
      choices: job.choices,
      logs: job.logs,
      cancel_requested: job.cancel_requested,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
    });
  }
}

function readLegacySqliteRows(legacy) {
  const db = legacy?._sqliteDb;
  if (!db) return { conversations: [], messages: [], conversation_files: [], project_memory: [], jobs: [] };
  return {
    conversations: sqliteSelect(db, "SELECT * FROM conversations ORDER BY updated_at DESC"),
    messages: sqliteSelect(db, "SELECT * FROM messages ORDER BY id ASC"),
    conversation_files: sqliteSelect(db, "SELECT * FROM conversation_files ORDER BY id ASC"),
    project_memory: sqliteSelect(db, "SELECT * FROM project_memory ORDER BY conversation_id ASC"),
    jobs: sqliteSelect(db, "SELECT * FROM jobs ORDER BY created_at DESC"),
  };
}

function sqliteSelect(db, sql) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function parseProjectMemoryRow(row = {}) {
  try {
    return normalizeProjectMemory(JSON.parse(String(row.memory_json || "{}")));
  } catch {
    return defaultProjectMemory();
  }
}

function parseJsonValue(value, fallback) {
  try {
    return value == null || value === "" ? fallback : JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normalizeLegacyJobRow(row = {}) {
  if (!row) return null;
  return {
    id: String(row.id || ""),
    type: String(row.type || ""),
    status: String(row.status || "queued"),
    phase: String(row.phase || ""),
    conversation_id: row.conversation_id || "",
    title: String(row.title || ""),
    organization_id: String(row.organization_id || ""),
    project_id: String(row.project_id || ""),
    build_id: String(row.build_id || ""),
    idempotency_key: String(row.idempotency_key || ""),
    input_digest: String(row.input_digest || ""),
    input: parseJsonValue(row.input_json, {}),
    output: parseJsonValue(row.output_json, null),
    error: parseJsonValue(row.error_json, null),
    choices: parseJsonValue(row.choices_json, []),
    logs: parseJsonValue(row.logs_json, []),
    cancel_requested: Number(row.cancel_requested || 0) === 1,
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
    started_at: String(row.started_at || ""),
    completed_at: String(row.completed_at || ""),
  };
}

async function listAllLegacyJobs(legacy) {
  if (!legacy?._sqliteDb) return legacy.listJobs({ limit: 200 });
  const stmt = legacy._sqliteDb.prepare("SELECT id FROM jobs ORDER BY created_at DESC");
  const jobs = [];
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const job = await legacy.getJob(row.id);
      if (job) jobs.push(job);
    }
  } finally {
    stmt.free();
  }
  return jobs;
}

function isDefaultProjectMemory(memory = {}) {
  return JSON.stringify(normalizeProjectMemory(memory)) === JSON.stringify(defaultProjectMemory());
}

function wrapStores(conversationStore, jobStore) {
  return {
    async initSchema() {
      conversationStore.initSchema();
      jobStore.initSchema();
    },
    async markInterruptedRunningJobs() {
      return jobStore.markInterruptedRunningJobs();
    },
    async listConversations(options = {}) {
      return conversationStore.listConversations(options);
    },
    async createConversation(id, title, options = {}) {
      return conversationStore.createConversation(id, title, options);
    },
    async updateConversation(id, patch = {}) {
      return conversationStore.updateConversation(id, patch);
    },
    async getConversation(id) {
      return conversationStore.getConversation(id);
    },
    async deleteConversation(id) {
      return conversationStore.deleteConversation(id);
    },
    async listMessages(conversationId) {
      return conversationStore.listMessages(conversationId);
    },
    async appendMessage(conversationId, message = {}) {
      return conversationStore.appendMessage(conversationId, message);
    },
    async saveConversationFiles(conversationId, buildId, files = {}) {
      return conversationStore.saveConversationFiles(conversationId, buildId, files);
    },
    async loadConversationFiles(conversationId) {
      return conversationStore.loadConversationFiles(conversationId);
    },
    async deleteConversationFiles(conversationId) {
      return conversationStore.deleteConversationFiles(conversationId);
    },
    async getProjectMemory(conversationId) {
      return conversationStore.getProjectMemory(conversationId);
    },
    async setProjectMemory(conversationId, memory = {}) {
      return conversationStore.setProjectMemory(conversationId, memory);
    },
    createJob(input = {}) {
      return jobStore.createJob(input);
    },
    getJob(id) {
      return jobStore.getJob(id);
    },
    getJobForOrganization(id, organizationId) {
      return jobStore.getJobForOrganization(id, organizationId);
    },
    createOrGetJob(input = {}) {
      return jobStore.createOrGetJob(input);
    },
    listJobs(filters = {}) {
      return jobStore.listJobs(filters);
    },
    transition(id, patch = {}) {
      return jobStore.transition(id, patch);
    },
    claimJob(id) {
      return jobStore.claimJob(id);
    },
    appendLog(id, message, data = {}, phase = "") {
      return jobStore.appendLog(id, message, data, phase);
    },
    requestCancel(id) {
      return jobStore.requestCancel(id);
    },
    requestCancelForOrganization(id, organizationId) {
      return jobStore.requestCancelForOrganization(id, organizationId);
    },
    isCancelRequested(id) {
      return jobStore.isCancelRequested(id);
    },
  };
}

export function createFileProjectPersistence({ filePath } = {}) {
  if (!filePath) throw new Error("filePath is required");
  return createJsonProjectPersistence({ filePath });
}

export function createPostgresProjectPersistence({ pg } = {}) {
  if (!pg) throw new Error("pg is required");
  const now = () => new Date().toISOString();
  const finalStatuses = new Set(["succeeded", "failed", "canceled"]);
  const normalizeStatus = (value, fallback = "queued") => {
    const status = String(value || "").trim();
    return ["queued", "running", "succeeded", "failed", "canceled"].includes(status) ? status : fallback;
  };
  const jsonString = (value, fallback) => {
    try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
  };
  const parseJson = (value, fallback) => {
    try { return value == null || value === "" ? fallback : JSON.parse(String(value)); } catch { return fallback; }
  };
  const rowsOf = result => Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
  const firstRow = async queryResult => rowsOf(await queryResult)[0] || null;
  const timestampValue = value => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    const text = String(value || "").trim();
    if (!text) return null;
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
  };
  const runTransactionStatements = async builders => {
    if (typeof pg.transaction === "function") {
      return pg.transaction(tx => builders.map(build => build(tx)));
    }
    const results = [];
    for (const build of builders) results.push(await build(pg));
    return results;
  };
  const parseStoredFileContent = value => {
    if (typeof value !== "string") return value;
    try {
      const parsed = JSON.parse(value);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed.__vibeboardFileEncoding === "base64" || parsed.type === "Buffer")
      ) {
        return parsed;
      }
    } catch {}
    return value;
  };
  const filterStoredConversationFileRows = rows => {
    const files = {};
    for (const row of rows) {
      if (CONVERSATION_FILE_NAMES.has(row.filename)) {
        files[row.filename] = row.content;
        continue;
      }
      const content = parseStoredFileContent(row.content);
      const candidate = { ...files, [row.filename]: content };
      if (declaredAssetPathsFromFiles(candidate).includes(row.filename)) {
        files[row.filename] = content;
      }
    }
    return files;
  };
  const normalizeJob = row => {
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
      input: sanitizeJobInput(parseJson(row.input_json, {})),
      output: parseJson(row.output_json, null),
      error: parseJson(row.error_json, null),
      choices: parseJson(row.choices_json, []),
      logs: parseJson(row.logs_json, []),
      cancel_requested: Number(row.cancel_requested || 0) === 1,
      created_at: String(row.created_at || ""),
      updated_at: String(row.updated_at || ""),
      started_at: row.started_at ? String(row.started_at) : "",
      completed_at: row.completed_at ? String(row.completed_at) : "",
    };
  };
  const compactLogEntry = entry => ({
    ts: entry.ts || now(),
    phase: String(entry.phase || "").slice(0, 80),
    message: String(entry.message || "").slice(0, 600),
    data: entry.data && typeof entry.data === "object" ? entry.data : {},
  });

  return {
    async initSchema() {
      await pg`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT DEFAULT 'New App',
          user_id TEXT,
          project_dir TEXT,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `;
      await pg`
        CREATE TABLE IF NOT EXISTS messages (
          id BIGSERIAL PRIMARY KEY,
          legacy_id TEXT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT,
          build_id TEXT,
          created_at TIMESTAMPTZ DEFAULT now()
        )
      `;
      await pg`
        CREATE TABLE IF NOT EXISTS conversation_files (
          id BIGSERIAL PRIMARY KEY,
          legacy_id TEXT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          build_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          content TEXT,
          created_at TIMESTAMPTZ DEFAULT now()
        )
      `;
      await pg`
        CREATE TABLE IF NOT EXISTS project_memory (
          conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
          memory_json TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `;
      await pg`
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
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ
        )
      `;
      await pg`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS organization_id TEXT`;
      await pg`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS project_id TEXT`;
      await pg`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS build_id TEXT`;
      await pg`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT`;
      await pg`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS input_digest TEXT`;
      const legacyJobRows = rowsOf(await pg`
        SELECT id, input_json, organization_id, input_digest
        FROM jobs
      `);
      for (const legacyJob of legacyJobRows) {
        const input = parseJson(legacyJob.input_json, {});
        const safeInput = sanitizeJobInput(input);
        const identity = normalizeJobIdentity({ input: safeInput });
        const persistedOrganizationId = String(legacyJob.organization_id || "").trim();
        const organizationId = persistedOrganizationId || identity.organization_id;
        const inputDigest = digestJobInput(safeInput);
        if (
          organizationId !== persistedOrganizationId
          || inputDigest !== String(legacyJob.input_digest || "")
          || jsonString(input, {}) !== jsonString(safeInput, {})
        ) {
          await pg`
            UPDATE jobs
            SET organization_id = ${organizationId}, input_digest = ${inputDigest}, input_json = ${jsonString(safeInput, {})}
            WHERE id = ${legacyJob.id}
          `;
        }
      }
      await pg`ALTER TABLE messages ADD COLUMN IF NOT EXISTS legacy_id TEXT`;
      await pg`ALTER TABLE conversation_files ADD COLUMN IF NOT EXISTS legacy_id TEXT`;
      await pg`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_legacy_id ON messages(legacy_id) WHERE legacy_id IS NOT NULL`;
      await pg`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_files_legacy_id ON conversation_files(legacy_id) WHERE legacy_id IS NOT NULL`;
      await pg`CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_conversation_files_conversation_id ON conversation_files(conversation_id, id)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_jobs_conversation_created ON jobs(conversation_id, created_at)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_jobs_organization_created ON jobs(organization_id, created_at)`;
      await pg`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_organization_operation_idempotency
        ON jobs(organization_id, type, idempotency_key)
        WHERE idempotency_key IS NOT NULL AND idempotency_key <> ''
      `;
    },

    async markInterruptedRunningJobs() {
      const interruptedAt = now();
      const rows = rowsOf(await pg`SELECT * FROM jobs WHERE status = ${"running"}`);
      for (const row of rows) {
        const job = normalizeJob(row);
        const logs = [...job.logs, compactLogEntry({
          ts: interruptedAt,
          phase: "server_restart",
          message: "Server restarted before this job finished.",
        })].slice(-80);
        await pg`
          UPDATE jobs
          SET status = ${"failed"},
              phase = ${"server_restart"},
              error_json = ${jsonString({
                errorType: "connection_dropped",
                errorLabel: "Job interrupted",
                errorStage: "runtime",
                userMessage: "The server restarted before this background job finished.",
                suggestion: "Retry the job from Task Center.",
                retryable: true,
                nextActions: ["Retry job", "View logs"],
              }, null)},
              choices_json = ${jsonString([
                { label: "Retry job", action: "retry_job" },
                { label: "View logs", action: "view_logs" },
              ], [])},
              logs_json = ${jsonString(logs, [])},
              updated_at = ${interruptedAt},
              completed_at = ${interruptedAt}
          WHERE id = ${job.id}
        `;
      }
    },

    async listConversations(options = {}) {
      const userId = String(options.userId || options.user_id || "").trim();
      if (userId) {
        return rowsOf(await pg`SELECT * FROM conversations WHERE user_id = ${userId} ORDER BY updated_at DESC`);
      }
      return rowsOf(await pg`SELECT * FROM conversations ORDER BY updated_at DESC`);
    },

    async createConversation(id, title = "New App", options = {}) {
      const row = {
        id,
        title,
        user_id: String(options.userId || options.user_id || ""),
        project_dir: String(options.projectDir || options.project_dir || ""),
      };
      await pg`
        INSERT INTO conversations (id, title, user_id, project_dir)
        VALUES (${row.id}, ${row.title}, ${row.user_id}, ${row.project_dir})
        ON CONFLICT (id) DO NOTHING
      `;
      return row;
    },

    async updateConversation(id, patch = {}) {
      const title = patch.title == null ? null : String(patch.title || "").trim();
      const projectDir = patch.projectDir ?? patch.project_dir;
      if (title) {
        await pg`UPDATE conversations SET title = ${title}, updated_at = now() WHERE id = ${id}`;
      }
      if (projectDir != null) {
        await pg`UPDATE conversations SET project_dir = ${String(projectDir || "")}, updated_at = now() WHERE id = ${id}`;
      }
      return this.getConversation(id);
    },

    async getConversation(id) {
      return firstRow(pg`SELECT * FROM conversations WHERE id = ${id}`);
    },

    async deleteConversation(id) {
      await pg`DELETE FROM conversations WHERE id = ${id}`;
    },

    async listMessages(conversationId) {
      return rowsOf(await pg`SELECT * FROM messages WHERE conversation_id = ${conversationId} ORDER BY created_at ASC`);
    },

    async appendMessage(conversationId, message = {}) {
      const role = message.role;
      const content = message.content;
      const buildId = message.build_id || null;
      await pg`
        INSERT INTO messages (conversation_id, role, content, build_id)
        VALUES (${conversationId}, ${role}, ${content}, ${buildId})
      `;
      if (role === "user") {
        const countRow = await firstRow(pg`SELECT COUNT(*) as count FROM messages WHERE conversation_id = ${conversationId}`);
        if (Number(countRow?.count || 0) === 1) {
          const title = String(content || "").slice(0, 50) + (String(content || "").length > 50 ? "..." : "");
          await pg`UPDATE conversations SET title = ${title}, updated_at = now() WHERE id = ${conversationId}`;
        }
      }
    },
    async importLegacyMessages(conversationId, messages = []) {
      for (const message of messages) {
        const legacyId = String(message.id || "");
        if (!legacyId) continue;
        await pg`
          INSERT INTO messages (legacy_id, conversation_id, role, content, build_id, created_at)
          VALUES (${legacyId}, ${conversationId}, ${message.role}, ${message.content}, ${message.build_id || null}, ${timestampValue(message.created_at) || now()})
          ON CONFLICT DO NOTHING
        `;
      }
    },

    async saveConversationFiles(conversationId, buildId, files = {}) {
      const safeFiles = filterConversationFiles(files);
      const serialized = serializeFileMap(safeFiles);
      const statements = [
        sql => sql`DELETE FROM conversation_files WHERE conversation_id = ${conversationId}`,
        ...Object.entries(serialized).map(([filename, content]) => sql => sql`
          INSERT INTO conversation_files (conversation_id, build_id, filename, content)
          VALUES (${conversationId}, ${buildId}, ${filename}, ${typeof content === "string" ? content : JSON.stringify(content)})
        `),
      ];
      await runTransactionStatements(statements);
    },
    async importLegacyConversationFiles(conversationId, rows = []) {
      for (const row of rows) {
        const legacyId = String(row.id || "");
        if (!legacyId) continue;
        await pg`
          INSERT INTO conversation_files (legacy_id, conversation_id, build_id, filename, content, created_at)
          SELECT ${legacyId}, ${conversationId}, ${row.build_id || ""}, ${row.filename}, ${row.content}, ${timestampValue(row.created_at) || now()}
          WHERE NOT EXISTS (
            SELECT 1 FROM conversation_files
            WHERE conversation_id = ${conversationId} AND filename = ${row.filename}
          )
          ON CONFLICT DO NOTHING
        `;
      }
    },

    async loadConversationFiles(conversationId) {
      const rows = rowsOf(await pg`
        SELECT filename, content, build_id FROM conversation_files
        WHERE conversation_id = ${conversationId}
        ORDER BY id ASC
      `);
      if (rows.length === 0) return { buildId: null, files: {} };
      const files = filterStoredConversationFileRows(rows);
      return { buildId: rows[0].build_id, files: deserializeFileMap(files) };
    },

    async deleteConversationFiles(conversationId) {
      await pg`DELETE FROM conversation_files WHERE conversation_id = ${conversationId}`;
    },

    async getProjectMemory(conversationId) {
      const row = await firstRow(pg`SELECT memory_json FROM project_memory WHERE conversation_id = ${conversationId}`);
      if (!row) return defaultProjectMemory();
      return normalizeProjectMemory(parseJson(row.memory_json, defaultProjectMemory()));
    },

    async setProjectMemory(conversationId, memory = {}) {
      const normalized = normalizeProjectMemory(memory);
      const serialized = jsonString(normalized, defaultProjectMemory());
      await pg`
        INSERT INTO project_memory (conversation_id, memory_json, updated_at)
        VALUES (${conversationId}, ${serialized}, now())
        ON CONFLICT (conversation_id) DO UPDATE
        SET memory_json = ${serialized}, updated_at = now()
      `;
      await pg`UPDATE conversations SET updated_at = now() WHERE id = ${conversationId}`;
      return normalized;
    },
    async importLegacyProjectMemory(conversationId, memory = {}) {
      const normalized = normalizeProjectMemory(memory);
      const serialized = jsonString(normalized, defaultProjectMemory());
      await pg`
        INSERT INTO project_memory (conversation_id, memory_json, updated_at)
        VALUES (${conversationId}, ${serialized}, now())
        ON CONFLICT DO NOTHING
      `;
      return normalized;
    },

    async createJob({
      id = `job_${cryptoRandom()}`,
      type,
      conversationId = "",
      title = "",
      organizationId = "",
      organization_id = "",
      projectId = "",
      project_id = "",
      buildId = "",
      build_id = "",
      idempotencyKey = "",
      idempotency_key = "",
      inputDigest = "",
      input_digest = "",
      input = {},
      phase = "queued",
      status = "queued",
      output = null,
      error = null,
      choices = [],
      logs = null,
      cancel_requested = false,
      created_at = "",
      updated_at = "",
      started_at = "",
      completed_at = "",
    } = {}) {
      const ts = now();
      const safeStatus = normalizeStatus(status);
      const safeInput = sanitizeJobInput(input);
      const identity = normalizeJobIdentity({
        type,
        organizationId: organizationId || organization_id,
        projectId: projectId || project_id,
        buildId: buildId || build_id,
        idempotencyKey: idempotencyKey || idempotency_key,
        input: safeInput,
      });
      const row = {
        id,
        type: identity.type,
        status: safeStatus,
        phase: String(phase || safeStatus),
        conversation_id: String(conversationId || ""),
        title: String(title || ""),
        organization_id: identity.organization_id,
        project_id: identity.project_id,
        build_id: identity.build_id,
        idempotency_key: identity.idempotency_key,
        input_digest: String(inputDigest || input_digest || digestJobInput(safeInput)),
        input: safeInput,
        output,
        error,
        choices: Array.isArray(choices) ? choices : [],
        logs: Array.isArray(logs) ? logs : [compactLogEntry({ ts, phase, message: "Job accepted." })],
        cancel_requested: Boolean(cancel_requested),
        created_at: created_at || ts,
        updated_at: updated_at || ts,
        started_at: started_at || (safeStatus === "running" ? ts : ""),
        completed_at: completed_at || (finalStatuses.has(safeStatus) ? ts : ""),
      };
      await pg`
        INSERT INTO jobs
        (id, type, status, phase, conversation_id, title, organization_id, project_id, build_id, idempotency_key, input_digest,
         input_json, output_json, error_json, choices_json, logs_json, cancel_requested, created_at, updated_at, started_at, completed_at)
        VALUES (${row.id}, ${row.type}, ${row.status}, ${row.phase}, ${row.conversation_id}, ${row.title}, ${row.organization_id}, ${row.project_id}, ${row.build_id}, ${row.idempotency_key}, ${row.input_digest},
          ${jsonString(row.input, {})}, ${jsonString(row.output, null)}, ${jsonString(row.error, null)},
          ${jsonString(row.choices, [])}, ${jsonString(row.logs, [])}, ${row.cancel_requested ? 1 : 0}, ${timestampValue(row.created_at)}, ${timestampValue(row.updated_at)},
          ${timestampValue(row.started_at)}, ${timestampValue(row.completed_at)})
        ON CONFLICT (id) DO NOTHING
      `;
      return row;
    },

    async getJob(id) {
      return normalizeJob(await firstRow(pg`SELECT * FROM jobs WHERE id = ${id}`));
    },

    async getJobForOrganization(id, organizationId) {
      return normalizeJob(await firstRow(pg`
        SELECT * FROM jobs WHERE organization_id = ${String(organizationId || "")} AND id = ${id}
      `));
    },

    async createOrGetJob({ context, operation, idempotencyKey, input = {}, ...job } = {}) {
      const safeInput = sanitizeJobInput(input);
      const identity = normalizeJobIdentity({ context, operation, idempotencyKey, input: safeInput }, { requireOrganization: true });
      const inputDigest = digestJobInput(safeInput);
      if (!identity.idempotency_key) {
        return this.createJob({
          ...job,
          type: identity.type,
          organizationId: identity.organization_id,
          projectId: identity.project_id,
          buildId: identity.build_id,
          inputDigest,
          input: safeInput,
        });
      }
      const existing = normalizeJob(await firstRow(pg`
        SELECT * FROM jobs
        WHERE organization_id = ${identity.organization_id}
          AND type = ${identity.type}
          AND idempotency_key = ${identity.idempotency_key}
      `));
      if (existing) {
        if (existing.input_digest !== inputDigest) throw idempotencyConflict();
        return existing;
      }

      const ts = now();
      const safeStatus = normalizeStatus(job.status || "queued");
      const row = {
        id: job.id || `job_${cryptoRandom()}`,
        type: identity.type,
        status: safeStatus,
        phase: String(job.phase || safeStatus),
        conversation_id: String(job.conversationId || ""),
        title: String(job.title || ""),
        organization_id: identity.organization_id,
        project_id: identity.project_id,
        build_id: identity.build_id,
        idempotency_key: identity.idempotency_key,
        input_digest: inputDigest,
        input: safeInput,
        output: job.output ?? null,
        error: job.error ?? null,
        choices: Array.isArray(job.choices) ? job.choices : [],
        logs: Array.isArray(job.logs) ? job.logs : [compactLogEntry({ ts, phase: job.phase || safeStatus, message: "Job accepted." })],
        cancel_requested: Boolean(job.cancel_requested),
        created_at: job.created_at || ts,
        updated_at: job.updated_at || ts,
        started_at: job.started_at || (safeStatus === "running" ? ts : ""),
        completed_at: job.completed_at || (finalStatuses.has(safeStatus) ? ts : ""),
      };
      const inserted = rowsOf(await pg`
        INSERT INTO jobs
        (id, type, status, phase, conversation_id, title, organization_id, project_id, build_id, idempotency_key, input_digest,
         input_json, output_json, error_json, choices_json, logs_json, cancel_requested, created_at, updated_at, started_at, completed_at)
        VALUES (${row.id}, ${row.type}, ${row.status}, ${row.phase}, ${row.conversation_id}, ${row.title}, ${row.organization_id}, ${row.project_id}, ${row.build_id}, ${row.idempotency_key}, ${row.input_digest},
          ${jsonString(row.input, {})}, ${jsonString(row.output, null)}, ${jsonString(row.error, null)},
          ${jsonString(row.choices, [])}, ${jsonString(row.logs, [])}, ${row.cancel_requested ? 1 : 0}, ${timestampValue(row.created_at)}, ${timestampValue(row.updated_at)},
          ${timestampValue(row.started_at)}, ${timestampValue(row.completed_at)})
        ON CONFLICT (organization_id, type, idempotency_key)
          WHERE idempotency_key IS NOT NULL AND idempotency_key <> ''
        DO NOTHING
        RETURNING *
      `);
      if (inserted.length) return normalizeJob(inserted[0]);
      const winner = normalizeJob(await firstRow(pg`
        SELECT * FROM jobs
        WHERE organization_id = ${identity.organization_id}
          AND type = ${identity.type}
          AND idempotency_key = ${identity.idempotency_key}
      `));
      if (!winner) throw new Error("Idempotency job was not persisted.");
      if (winner.input_digest !== inputDigest) throw idempotencyConflict();
      return winner;
    },

    async listJobs({ limit = 50, conversationId = "", status = "", organizationId = "", organization_id = "" } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      const safeStatus = status ? normalizeStatus(status) : "";
      const scopedOrganization = String(organizationId || organization_id || "").trim();
      let rows;
      if (scopedOrganization && conversationId && safeStatus) {
        rows = rowsOf(await pg`
          SELECT * FROM jobs WHERE organization_id = ${scopedOrganization} AND conversation_id = ${conversationId} AND status = ${safeStatus}
          ORDER BY created_at DESC LIMIT ${safeLimit}
        `);
      } else if (scopedOrganization && conversationId) {
        rows = rowsOf(await pg`
          SELECT * FROM jobs WHERE organization_id = ${scopedOrganization} AND conversation_id = ${conversationId}
          ORDER BY created_at DESC LIMIT ${safeLimit}
        `);
      } else if (scopedOrganization && safeStatus) {
        rows = rowsOf(await pg`
          SELECT * FROM jobs WHERE organization_id = ${scopedOrganization} AND status = ${safeStatus}
          ORDER BY created_at DESC LIMIT ${safeLimit}
        `);
      } else if (scopedOrganization) {
        rows = rowsOf(await pg`
          SELECT * FROM jobs WHERE organization_id = ${scopedOrganization}
          ORDER BY created_at DESC LIMIT ${safeLimit}
        `);
      } else if (conversationId && safeStatus) {
        rows = rowsOf(await pg`
          SELECT * FROM jobs WHERE conversation_id = ${conversationId} AND status = ${safeStatus}
          ORDER BY created_at DESC LIMIT ${safeLimit}
        `);
      } else if (conversationId) {
        rows = rowsOf(await pg`
          SELECT * FROM jobs WHERE conversation_id = ${conversationId}
          ORDER BY created_at DESC LIMIT ${safeLimit}
        `);
      } else if (safeStatus) {
        rows = rowsOf(await pg`
          SELECT * FROM jobs WHERE status = ${safeStatus}
          ORDER BY created_at DESC LIMIT ${safeLimit}
        `);
      } else {
        rows = rowsOf(await pg`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ${safeLimit}`);
      }
      return rows.map(normalizeJob);
    },

    async transition(id, patch = {}) {
      const existing = await this.getJob(id);
      if (!existing) throw new Error(`Job not found: ${id}`);
      const updatedAt = now();
      const next = {
        ...existing,
        ...patch,
        status: normalizeStatus(patch.status || existing.status),
        updated_at: updatedAt,
      };
      if (next.status === "running" && !next.started_at) next.started_at = updatedAt;
      if (finalStatuses.has(next.status) && !next.completed_at) next.completed_at = updatedAt;
      await pg`
        UPDATE jobs
        SET status = ${next.status},
            phase = ${next.phase || ""},
            output_json = ${jsonString(next.output, null)},
            error_json = ${jsonString(next.error, null)},
            choices_json = ${jsonString(next.choices, [])},
            logs_json = ${jsonString(next.logs, [])},
            cancel_requested = ${next.cancel_requested ? 1 : 0},
            updated_at = ${timestampValue(next.updated_at)},
            started_at = ${timestampValue(next.started_at)},
            completed_at = ${timestampValue(next.completed_at)}
        WHERE id = ${id}
      `;
      return next;
    },

    async claimJob(id) {
      const updatedAt = now();
      return normalizeJob(await firstRow(pg`
        UPDATE jobs
        SET status = ${"running"},
            phase = ${"starting"},
            updated_at = ${timestampValue(updatedAt)},
            started_at = COALESCE(started_at, ${timestampValue(updatedAt)})
        WHERE id = ${id}
          AND status = ${"queued"}
          AND cancel_requested = ${0}
        RETURNING *
      `));
    },

    async appendLog(id, message, data = {}, phase = "") {
      const job = await this.getJob(id);
      if (!job) throw new Error(`Job not found: ${id}`);
      return this.transition(id, {
        logs: [...job.logs, compactLogEntry({ phase: phase || job.phase || "", message, data })].slice(-120),
      });
    },

    async requestCancel(id) {
      const job = await this.getJob(id);
      if (!job) throw new Error(`Job not found: ${id}`);
      if (finalStatuses.has(job.status)) return job;
      const canceled = job.status === "queued";
      return this.transition(id, {
        cancel_requested: true,
        status: canceled ? "canceled" : job.status,
        phase: canceled ? "canceled" : job.phase,
        error: canceled ? { errorType: "job_canceled", message: "Job canceled before it started." } : job.error,
        choices: canceled ? [] : job.choices,
      });
    },

    async requestCancelForOrganization(id, organizationId) {
      const organization = String(organizationId || "").trim();
      const job = await this.getJobForOrganization(id, organization);
      if (!job) return null;
      if (finalStatuses.has(job.status)) return job;
      const updatedAt = now();
      const canceled = job.status === "queued";
      const next = {
        ...job,
        cancel_requested: true,
        status: canceled ? "canceled" : job.status,
        phase: canceled ? "canceled" : job.phase,
        error: canceled ? { errorType: "job_canceled", message: "Job canceled before it started." } : job.error,
        choices: canceled ? [] : job.choices,
        updated_at: updatedAt,
        completed_at: canceled ? updatedAt : job.completed_at,
      };
      await pg`
        UPDATE jobs
        SET status = ${next.status},
            phase = ${next.phase || ""},
            error_json = ${jsonString(next.error, null)},
            choices_json = ${jsonString(next.choices, [])},
            cancel_requested = ${1},
            updated_at = ${timestampValue(next.updated_at)},
            completed_at = ${timestampValue(next.completed_at)}
        WHERE organization_id = ${organization}
          AND id = ${id}
          AND status NOT IN ('succeeded', 'failed', 'canceled')
      `;
      return this.getJobForOrganization(id, organization);
    },

    async isCancelRequested(id) {
      return Boolean((await this.getJob(id))?.cancel_requested);
    },
    async migrateLegacySqliteSnapshot(buffer) {
      return migrateLegacySqliteSnapshotInto(this, buffer);
    },
  };
}

function createJsonProjectPersistence({ filePath }) {
  async function waitForUnlocked() {
    const lockPath = `${filePath}.lock`;
    const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const stat = await fs.stat(lockPath).catch(() => null);
      if (!stat) return;
      if (Date.now() - stat.mtimeMs > FILE_LOCK_STALE_MS) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        return;
      }
      await new Promise(resolve => setTimeout(resolve, FILE_LOCK_RETRY_MS));
    }
    throw new Error(`Timed out waiting for project persistence read lock: ${filePath}`);
  }

  async function readState({ waitForLock = true } = {}) {
    if (waitForLock) await waitForUnlocked();
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw) {
      return { conversations: [], messages: [], conversation_files: [], project_memory: [], jobs: [] };
    }
    const parsed = JSON.parse(raw);
    return {
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      conversation_files: Array.isArray(parsed.conversation_files) ? parsed.conversation_files : [],
      project_memory: Array.isArray(parsed.project_memory) ? parsed.project_memory : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  }
  async function writeState(next) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${cryptoRandom()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(next, null, 2));
      await fs.rename(temporaryPath, filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
  async function acquireFileLock() {
    const lockPath = `${filePath}.lock`;
    const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const handle = await fs.open(lockPath, "wx");
        return { handle, lockPath };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const stat = await fs.stat(lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > FILE_LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, FILE_LOCK_RETRY_MS));
      }
    }
    throw new Error(`Timed out waiting for project persistence lock: ${filePath}`);
  }
  async function withFileLock(task) {
    const lock = await acquireFileLock();
    try {
      return await task();
    } finally {
      await lock.handle.close().catch(() => {});
      await fs.rm(lock.lockPath, { force: true }).catch(() => {});
    }
  }
  async function mutate(task) {
    const previous = fileMutationLocks.get(filePath) || Promise.resolve();
    let release;
    const currentLock = new Promise(resolve => { release = resolve; });
    const chainedLock = previous.then(() => currentLock, () => currentLock);
    fileMutationLocks.set(filePath, chainedLock);
    await previous.catch(() => {});
    try {
      return await withFileLock(async () => {
        const current = await readState({ waitForLock: false });
        const result = await task(current);
        await writeState(current);
        return result;
      });
    } finally {
      release();
      if (fileMutationLocks.get(filePath) === chainedLock) fileMutationLocks.delete(filePath);
    }
  }
  const now = () => new Date().toISOString();
  const byId = (rows, id) => rows.find(row => String(row.id || "") === String(id || ""));
  const normalizeStatus = value => ["queued", "running", "succeeded", "failed", "canceled"].includes(String(value || "")) ? String(value) : "queued";
  const normalizeJobRow = row => {
    if (!row) return null;
    const input = sanitizeJobInput(row.input || {});
    const identity = normalizeJobIdentity({
      type: row.type,
      organizationId: row.organization_id,
      projectId: row.project_id,
      buildId: row.build_id,
      idempotencyKey: row.idempotency_key,
      input,
    });
    return {
      ...row,
      type: identity.type,
      organization_id: identity.organization_id,
      project_id: identity.project_id,
      build_id: identity.build_id,
      idempotency_key: identity.idempotency_key,
      input_digest: String(row.input_digest || digestJobInput(input)),
      input,
    };
  };
  return {
    async initSchema() {
      await mutate(state => {
        for (let index = 0; index < state.jobs.length; index += 1) {
          state.jobs[index] = normalizeJobRow(state.jobs[index]);
        }
      });
    },
    async markInterruptedRunningJobs() {
      return mutate(state => {
        for (const job of state.jobs) {
          if (job.status === "running") {
            job.status = "failed";
            job.phase = "server_restart";
            job.completed_at = now();
            job.error = { errorType: "connection_dropped", error: "Server restarted before this job finished." };
          }
        }
      });
    },
    async createConversation(id, title = "New App", options = {}) {
      const row = { id, title, user_id: options.userId || options.user_id || "", project_dir: options.projectDir || options.project_dir || "", created_at: now(), updated_at: now() };
      await mutate(state => {
        if (!byId(state.conversations, id)) state.conversations.push(row);
      });
      return row;
    },
    async listConversations(options = {}) {
      const state = await readState();
      const userId = String(options.userId || options.user_id || "");
      return state.conversations
        .filter(row => !userId || row.user_id === userId)
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    },
    async getConversation(id) {
      const state = await readState();
      return byId(state.conversations, id) || null;
    },
    async updateConversation(id, patch = {}) {
      let updated = null;
      await mutate(state => {
        const row = byId(state.conversations, id);
        if (!row) return;
        if (patch.title) row.title = String(patch.title);
        if (patch.projectDir != null || patch.project_dir != null) row.project_dir = String(patch.projectDir ?? patch.project_dir ?? "");
        row.updated_at = now();
        updated = { ...row };
      });
      return updated;
    },
    async deleteConversation(id) {
      await mutate(state => {
        state.conversations = state.conversations.filter(row => row.id !== id);
        state.messages = state.messages.filter(row => row.conversation_id !== id);
        state.conversation_files = state.conversation_files.filter(row => row.conversation_id !== id);
        state.project_memory = state.project_memory.filter(row => row.conversation_id !== id);
      });
    },
    async appendMessage(conversationId, message = {}) {
      const row = { id: `${Date.now()}-${Math.random()}`, conversation_id: conversationId, role: message.role, content: message.content, build_id: message.build_id || null, created_at: now() };
      await mutate(state => { state.messages.push(row); });
      return row;
    },
    async importLegacyMessages(conversationId, messages = []) {
      await mutate(state => {
        const existingKeys = new Set(state.messages
          .filter(row => row.conversation_id === conversationId)
          .map(row => String(row.legacy_id || row.id || "")));
        for (const message of messages) {
          const legacyId = String(message.id || "");
          if (!legacyId || existingKeys.has(legacyId)) continue;
          state.messages.push({
            id: `legacy:${legacyId}`,
            legacy_id: legacyId,
            conversation_id: conversationId,
            role: message.role,
            content: message.content,
            build_id: message.build_id || null,
            created_at: message.created_at || now(),
          });
          existingKeys.add(legacyId);
        }
      });
    },
    async listMessages(conversationId) {
      const state = await readState();
      return state.messages.filter(row => row.conversation_id === conversationId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    },
    async saveConversationFiles(conversationId, buildId, files = {}) {
      const { filterConversationFiles } = await import("./conversationStore.mjs");
      const safeFiles = filterConversationFiles(files);
      await mutate(state => {
        state.conversation_files = state.conversation_files.filter(row => row.conversation_id !== conversationId);
        for (const [filename, content] of Object.entries(safeFiles)) {
          state.conversation_files.push({ id: `${Date.now()}-${Math.random()}`, conversation_id: conversationId, build_id: buildId, filename, content, created_at: now() });
        }
      });
    },
    async importLegacyConversationFiles(conversationId, rows = []) {
      await mutate(state => {
        const existingRows = state.conversation_files.filter(row => row.conversation_id === conversationId);
        const existingKeys = new Set(existingRows.map(row => String(row.legacy_id || row.id || "")));
        const existingFilenames = new Set(existingRows.map(row => String(row.filename || "")));
        for (const row of rows) {
          const legacyId = String(row.id || "");
          const filename = String(row.filename || "");
          if (!legacyId || !filename || existingKeys.has(legacyId) || existingFilenames.has(filename)) continue;
          state.conversation_files.push({
            id: `legacy:${legacyId}`,
            legacy_id: legacyId,
            conversation_id: conversationId,
            build_id: row.build_id || "",
            filename,
            content: row.content,
            created_at: row.created_at || now(),
          });
          existingKeys.add(legacyId);
          existingFilenames.add(filename);
        }
      });
    },
    async loadConversationFiles(conversationId) {
      const state = await readState();
      const rows = state.conversation_files.filter(row => row.conversation_id === conversationId);
      const files = Object.fromEntries(rows.map(row => [row.filename, row.content]));
      return { buildId: rows[0]?.build_id || null, files };
    },
    async deleteConversationFiles(conversationId) {
      await mutate(state => {
        state.conversation_files = state.conversation_files.filter(row => row.conversation_id !== conversationId);
      });
    },
    async getProjectMemory(conversationId) {
      const { defaultProjectMemory, normalizeProjectMemory } = await import("./conversationStore.mjs");
      const state = await readState();
      const row = state.project_memory.find(item => item.conversation_id === conversationId);
      return row ? normalizeProjectMemory(row.memory) : defaultProjectMemory();
    },
    async setProjectMemory(conversationId, memory = {}) {
      const { normalizeProjectMemory } = await import("./conversationStore.mjs");
      const normalized = normalizeProjectMemory(memory);
      await mutate(state => {
        const existing = state.project_memory.find(item => item.conversation_id === conversationId);
        if (existing) {
          existing.memory = normalized;
          existing.updated_at = now();
        } else {
          state.project_memory.push({ conversation_id: conversationId, memory: normalized, updated_at: now() });
        }
      });
      return normalized;
    },
    async createJob({
      id = `job_${cryptoRandom()}`,
      type,
      conversationId = "",
      title = "",
      organizationId = "",
      organization_id = "",
      projectId = "",
      project_id = "",
      buildId = "",
      build_id = "",
      idempotencyKey = "",
      idempotency_key = "",
      inputDigest = "",
      input_digest = "",
      input = {},
      phase = "queued",
      status = "queued",
      output = null,
      error = null,
      choices = [],
      logs = null,
      cancel_requested = false,
      created_at = "",
      updated_at = "",
      started_at = "",
      completed_at = "",
    } = {}) {
      const ts = now();
      const safeStatus = normalizeStatus(status);
      const safeInput = sanitizeJobInput(input);
      const identity = normalizeJobIdentity({
        type,
        organizationId: organizationId || organization_id,
        projectId: projectId || project_id,
        buildId: buildId || build_id,
        idempotencyKey: idempotencyKey || idempotency_key,
        input: safeInput,
      });
      const row = normalizeJobRow({
        id,
        type: identity.type,
        status: safeStatus,
        phase,
        conversation_id: conversationId,
        title,
        organization_id: identity.organization_id,
        project_id: identity.project_id,
        build_id: identity.build_id,
        idempotency_key: identity.idempotency_key,
        input_digest: String(inputDigest || input_digest || digestJobInput(safeInput)),
        input: safeInput,
        output,
        error,
        choices: Array.isArray(choices) ? choices : [],
        logs: Array.isArray(logs) ? logs : [{ ts, phase, message: "Job accepted.", data: {} }],
        cancel_requested: Boolean(cancel_requested),
        created_at: created_at || ts,
        updated_at: updated_at || ts,
        started_at: started_at || (safeStatus === "running" ? ts : ""),
        completed_at: completed_at || (["succeeded", "failed", "canceled"].includes(safeStatus) ? ts : ""),
      });
      await mutate(state => {
        if (!byId(state.jobs, id)) state.jobs.push(row);
      });
      return row;
    },
    async getJob(id) {
      const state = await readState();
      return normalizeJobRow(byId(state.jobs, id));
    },
    async getJobForOrganization(id, organizationId) {
      const state = await readState();
      const job = byId(state.jobs, id);
      const normalized = normalizeJobRow(job);
      return normalized?.organization_id === String(organizationId || "").trim() ? normalized : null;
    },
    async createOrGetJob({ context, operation, idempotencyKey, input = {}, ...job } = {}) {
      const safeInput = sanitizeJobInput(input);
      const identity = normalizeJobIdentity({ context, operation, idempotencyKey, input: safeInput }, { requireOrganization: true });
      const inputDigest = digestJobInput(safeInput);
      let result = null;
      await mutate(state => {
        const existing = identity.idempotency_key
          ? state.jobs.map(normalizeJobRow).find(item => item.organization_id === identity.organization_id && item.type === identity.type && item.idempotency_key === identity.idempotency_key)
          : null;
        if (existing) {
          if (existing.input_digest !== inputDigest) throw idempotencyConflict();
          result = existing;
          return;
        }
        const ts = now();
        const row = normalizeJobRow({
          id: job.id || `job_${cryptoRandom()}`,
          type: identity.type,
          status: normalizeStatus(job.status),
          phase: job.phase || "queued",
          conversation_id: job.conversationId || "",
          title: job.title || "",
          organization_id: identity.organization_id,
          project_id: identity.project_id,
          build_id: identity.build_id,
          idempotency_key: identity.idempotency_key,
          input_digest: inputDigest,
          input: safeInput,
          output: job.output ?? null,
          error: job.error ?? null,
          choices: Array.isArray(job.choices) ? job.choices : [],
          logs: Array.isArray(job.logs) ? job.logs : [{ ts, phase: job.phase || "queued", message: "Job accepted.", data: {} }],
          cancel_requested: Boolean(job.cancel_requested),
          created_at: job.created_at || ts,
          updated_at: job.updated_at || ts,
          started_at: job.started_at || "",
          completed_at: job.completed_at || "",
        });
        state.jobs.push(row);
        result = row;
      });
      return result;
    },
    async listJobs({ limit = 50, conversationId = "", status = "", organizationId = "", organization_id = "" } = {}) {
      const state = await readState();
      const scopedOrganization = String(organizationId || organization_id || "").trim();
      return state.jobs
        .map(normalizeJobRow)
        .filter(row => (!conversationId || row.conversation_id === conversationId) && (!status || row.status === status) && (!scopedOrganization || row.organization_id === scopedOrganization))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
    },
    async transition(id, patch = {}) {
      let next = null;
      await mutate(state => {
        const job = byId(state.jobs, id);
        if (!job) throw new Error(`Job not found: ${id}`);
        Object.assign(job, patch);
        job.status = normalizeStatus(patch.status || job.status);
        job.updated_at = now();
        if (job.status === "running" && !job.started_at) job.started_at = job.updated_at;
        if (["succeeded", "failed", "canceled"].includes(job.status) && !job.completed_at) job.completed_at = job.updated_at;
        next = { ...job };
      });
      return next;
    },
    async claimJob(id) {
      let claimed = null;
      await mutate(state => {
        const job = byId(state.jobs, id);
        if (!job || job.status !== "queued" || job.cancel_requested) return;
        job.status = "running";
        job.phase = "starting";
        job.updated_at = now();
        if (!job.started_at) job.started_at = job.updated_at;
        claimed = normalizeJobRow(job);
      });
      return claimed;
    },
    async appendLog(id, message, data = {}, phase = "") {
      let next = null;
      await mutate(state => {
        const job = byId(state.jobs, id);
        if (!job) throw new Error(`Job not found: ${id}`);
        job.logs = [...(job.logs || []), { ts: now(), phase: phase || job.phase || "", message: String(message || "").slice(0, 600), data }].slice(-120);
        job.updated_at = now();
        next = { ...job };
      });
      return next;
    },
    async requestCancel(id) {
      const job = await this.getJob(id);
      if (!job) throw new Error(`Job not found: ${id}`);
      if (["succeeded", "failed", "canceled"].includes(job.status)) return job;
      return this.transition(id, { cancel_requested: true, status: job.status === "queued" ? "canceled" : job.status, phase: job.status === "queued" ? "canceled" : job.phase });
    },
    async requestCancelForOrganization(id, organizationId) {
      const organization = String(organizationId || "").trim();
      let next = null;
      await mutate(state => {
        const job = byId(state.jobs, id);
        const normalized = normalizeJobRow(job);
        if (!normalized || normalized.organization_id !== organization) return;
        if (["succeeded", "failed", "canceled"].includes(normalized.status)) {
          next = normalized;
          return;
        }
        job.cancel_requested = true;
        if (job.status === "queued") {
          job.status = "canceled";
          job.phase = "canceled";
          job.error = { errorType: "job_canceled", message: "Job canceled before it started." };
          job.choices = [];
          job.completed_at = now();
        }
        job.updated_at = now();
        next = normalizeJobRow(job);
      });
      return next;
    },
    async isCancelRequested(id) {
      return Boolean((await this.getJob(id))?.cancel_requested);
    },
    async migrateLegacySqliteSnapshot(buffer) {
      return migrateLegacySqliteSnapshotInto(this, buffer);
    },
  };
}

function cryptoRandom() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
