import { promises as fs } from "node:fs";
import path from "node:path";

import { createConversationStore } from "./conversationStore.mjs";
import {
  defaultProjectMemory,
  normalizeProjectMemory,
} from "./conversationStore.mjs";
import {
  filterConversationFiles,
  normalizeConversationFileRows,
  serializeConversationFiles,
} from "./conversationSnapshot.mjs";
import { createJobStore } from "./jobStore.mjs";
import {
  FINAL_STATUSES,
  JOB_STATUS,
  compactJobLogEntry,
  jobIdempotencyScope,
  jobMatchesIdempotencyScope,
  normalizeIdempotencyValue,
  normalizeJobStatus,
} from "./jobLifecyclePolicy.mjs";

const fileMutationLocks = new Map();

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
    status: normalizeJobStatus(row.status),
    phase: String(row.phase || ""),
    conversation_id: row.conversation_id || "",
    title: String(row.title || ""),
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
    async createJob(input = {}) {
      return jobStore.createJob(input);
    },
    async getJob(id) {
      return jobStore.getJob(id);
    },
    async findIdempotentJob(input = {}) {
      return typeof jobStore.findIdempotentJob === "function"
        ? jobStore.findIdempotentJob(input)
        : null;
    },
    async listJobs(filters = {}) {
      return jobStore.listJobs(filters);
    },
    async transition(id, patch = {}) {
      return jobStore.transition(id, patch);
    },
    async appendLog(id, message, data = {}, phase = "") {
      return jobStore.appendLog(id, message, data, phase);
    },
    async requestCancel(id) {
      return jobStore.requestCancel(id);
    },
    async isCancelRequested(id) {
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
  const normalizeJob = row => {
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
      started_at: row.started_at ? String(row.started_at) : "",
      completed_at: row.completed_at ? String(row.completed_at) : "",
    };
  };

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
      await pg`ALTER TABLE messages ADD COLUMN IF NOT EXISTS legacy_id TEXT`;
      await pg`ALTER TABLE conversation_files ADD COLUMN IF NOT EXISTS legacy_id TEXT`;
      await pg`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_legacy_id ON messages(legacy_id) WHERE legacy_id IS NOT NULL`;
      await pg`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_files_legacy_id ON conversation_files(legacy_id) WHERE legacy_id IS NOT NULL`;
      await pg`CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_conversation_files_conversation_id ON conversation_files(conversation_id, id)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_jobs_conversation_created ON jobs(conversation_id, created_at)`;
    },

    async markInterruptedRunningJobs() {
      const interruptedAt = now();
      const rows = rowsOf(await pg`SELECT * FROM jobs WHERE status = ${JOB_STATUS.RUNNING}`);
      for (const row of rows) {
        const job = normalizeJob(row);
        const logs = [...job.logs, compactJobLogEntry({
          ts: interruptedAt,
          phase: "server_restart",
          message: "Server restarted before this job finished.",
        }, { now })].slice(-80);
        await pg`
          UPDATE jobs
          SET status = ${JOB_STATUS.FAILED},
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
      await pg`UPDATE conversations SET updated_at = now() WHERE id = ${conversationId}`;
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
      const serialized = serializeConversationFiles(files);
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
      return normalizeConversationFileRows(rows);
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
      const safeStatus = normalizeJobStatus(status);
      const row = {
        id,
        type: String(type || "task"),
        status: safeStatus,
        phase: String(phase || safeStatus),
        conversation_id: String(conversationId || ""),
        title: String(title || ""),
        input,
        output,
        error,
        choices: Array.isArray(choices) ? choices : [],
        logs: Array.isArray(logs) ? logs : [compactJobLogEntry({ ts, phase, message: "Job accepted." }, { now })],
        cancel_requested: Boolean(cancel_requested),
        created_at: created_at || ts,
        updated_at: updated_at || ts,
        started_at: started_at || (safeStatus === JOB_STATUS.RUNNING ? ts : ""),
        completed_at: completed_at || (FINAL_STATUSES.has(safeStatus) ? ts : ""),
      };
      await pg`
        INSERT INTO jobs
        (id, type, status, phase, conversation_id, title, input_json, output_json, error_json,
         choices_json, logs_json, cancel_requested, created_at, updated_at, started_at, completed_at)
        VALUES (${row.id}, ${row.type}, ${row.status}, ${row.phase}, ${row.conversation_id}, ${row.title},
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

    async findIdempotentJob({ type = "", conversationId = "", input = {} } = {}) {
      const scope = jobIdempotencyScope({ type, conversationId, input });
      if (!scope) return null;
      const rows = rowsOf(await pg`
        SELECT * FROM jobs
        WHERE type = ${scope.type} AND conversation_id = ${scope.conversationId}
        ORDER BY created_at DESC LIMIT ${100}
      `);
      return rows.map(normalizeJob).find(job => jobMatchesIdempotencyScope(job, scope)) || null;
    },

    async listJobs({ limit = 50, conversationId = "", status = "" } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      const safeStatus = status ? normalizeJobStatus(status) : "";
      let rows;
      if (conversationId && safeStatus) {
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
        status: normalizeJobStatus(patch.status || existing.status),
        updated_at: updatedAt,
      };
      if (next.status === JOB_STATUS.RUNNING && !next.started_at) next.started_at = updatedAt;
      if (FINAL_STATUSES.has(next.status) && !next.completed_at) next.completed_at = updatedAt;
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

    async appendLog(id, message, data = {}, phase = "") {
      const job = await this.getJob(id);
      if (!job) throw new Error(`Job not found: ${id}`);
      return this.transition(id, {
        logs: [...job.logs, compactJobLogEntry({ phase: phase || job.phase || "", message, data }, { now })].slice(-120),
      });
    },

    async requestCancel(id) {
      const job = await this.getJob(id);
      if (!job) throw new Error(`Job not found: ${id}`);
      if (FINAL_STATUSES.has(job.status)) return job;
      const canceled = job.status === JOB_STATUS.QUEUED;
      return this.transition(id, {
        cancel_requested: true,
        status: canceled ? JOB_STATUS.CANCELED : job.status,
        phase: canceled ? "canceled" : job.phase,
        error: canceled ? { errorType: "job_canceled", message: "Job canceled before it started." } : job.error,
        choices: canceled ? [] : job.choices,
      });
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
  async function readState() {
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
    await fs.writeFile(filePath, JSON.stringify(next, null, 2));
  }
  async function mutate(task) {
    const previous = fileMutationLocks.get(filePath) || Promise.resolve();
    let release;
    const currentLock = new Promise(resolve => { release = resolve; });
    const chainedLock = previous.then(() => currentLock, () => currentLock);
    fileMutationLocks.set(filePath, chainedLock);
    await previous.catch(() => {});
    try {
      const current = await readState();
      const result = await task(current);
      await writeState(current);
      return result;
    } finally {
      release();
      if (fileMutationLocks.get(filePath) === chainedLock) fileMutationLocks.delete(filePath);
    }
  }
  const now = () => new Date().toISOString();
  const byId = (rows, id) => rows.find(row => String(row.id || "") === String(id || ""));
  return {
    async initSchema() {
      await writeState(await readState());
    },
    async markInterruptedRunningJobs() {
      return mutate(state => {
        for (const job of state.jobs) {
          if (job.status === JOB_STATUS.RUNNING) {
            job.status = JOB_STATUS.FAILED;
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
      await mutate(state => {
        state.messages.push(row);
        const conversation = state.conversations.find(item => item.id === conversationId);
        if (conversation) conversation.updated_at = row.created_at;
      });
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
      return normalizeConversationFileRows(rows);
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
      const safeStatus = normalizeJobStatus(status);
      const row = {
        id,
        type,
        status: safeStatus,
        phase,
        conversation_id: conversationId,
        title,
        input,
        output,
        error,
        choices: Array.isArray(choices) ? choices : [],
        logs: Array.isArray(logs) ? logs : [compactJobLogEntry({ ts, phase, message: "Job accepted." }, { now })],
        cancel_requested: Boolean(cancel_requested),
        created_at: created_at || ts,
        updated_at: updated_at || ts,
        started_at: started_at || (safeStatus === JOB_STATUS.RUNNING ? ts : ""),
        completed_at: completed_at || (FINAL_STATUSES.has(safeStatus) ? ts : ""),
      };
      await mutate(state => {
        if (!byId(state.jobs, id)) state.jobs.push(row);
      });
      return row;
    },
    async getJob(id) {
      const state = await readState();
      return byId(state.jobs, id) || null;
    },
    async findIdempotentJob({ type = "", conversationId = "", input = {} } = {}) {
      const scope = jobIdempotencyScope({ type, conversationId, input });
      if (!scope) return null;
      const state = await readState();
      return state.jobs
        .filter(row => normalizeIdempotencyValue(row.type) === scope.type && normalizeIdempotencyValue(row.conversation_id) === scope.conversationId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 100)
        .find(job => jobMatchesIdempotencyScope(job, scope)) || null;
    },
    async listJobs({ limit = 50, conversationId = "", status = "" } = {}) {
      const state = await readState();
      const safeStatus = status ? normalizeJobStatus(status) : "";
      return state.jobs
        .filter(row => (!conversationId || row.conversation_id === conversationId) && (!safeStatus || normalizeJobStatus(row.status) === safeStatus))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
    },
    async transition(id, patch = {}) {
      let next = null;
      await mutate(state => {
        const job = byId(state.jobs, id);
        if (!job) throw new Error(`Job not found: ${id}`);
        Object.assign(job, patch);
        job.status = normalizeJobStatus(patch.status || job.status);
        job.updated_at = now();
        if (job.status === JOB_STATUS.RUNNING && !job.started_at) job.started_at = job.updated_at;
        if (FINAL_STATUSES.has(job.status) && !job.completed_at) job.completed_at = job.updated_at;
        next = { ...job };
      });
      return next;
    },
    async appendLog(id, message, data = {}, phase = "") {
      let next = null;
      await mutate(state => {
        const job = byId(state.jobs, id);
        if (!job) throw new Error(`Job not found: ${id}`);
        job.logs = [...(job.logs || []), compactJobLogEntry({ phase: phase || job.phase || "", message, data }, { now })].slice(-120);
        job.updated_at = now();
        next = { ...job };
      });
      return next;
    },
    async requestCancel(id) {
      const job = await this.getJob(id);
      if (!job) throw new Error(`Job not found: ${id}`);
      if (FINAL_STATUSES.has(job.status)) return job;
      return this.transition(id, {
        cancel_requested: true,
        status: job.status === JOB_STATUS.QUEUED ? JOB_STATUS.CANCELED : job.status,
        phase: job.status === JOB_STATUS.QUEUED ? "canceled" : job.phase,
      });
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
