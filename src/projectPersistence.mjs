import { promises as fs } from "node:fs";
import path from "node:path";

import {
  deserializeFileMap,
  serializeFileMap,
} from "./assetContract.mjs";
import { createConversationStore } from "./conversationStore.mjs";
import {
  defaultProjectMemory,
  filterConversationFiles,
  normalizeProjectMemory,
} from "./conversationStore.mjs";
import { createJobStore } from "./jobStore.mjs";

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
  return wrapStores(conversationStore, jobStore);
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
  const normalizeJob = row => {
    if (!row) return null;
    return {
      id: String(row.id || ""),
      type: String(row.type || ""),
      status: normalizeStatus(row.status),
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
      await pg`CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_conversation_files_conversation_id ON conversation_files(conversation_id, id)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)`;
      await pg`CREATE INDEX IF NOT EXISTS idx_jobs_conversation_created ON jobs(conversation_id, created_at)`;
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

    async saveConversationFiles(conversationId, buildId, files = {}) {
      const safeFiles = filterConversationFiles(files);
      const serialized = serializeFileMap(safeFiles);
      await pg`DELETE FROM conversation_files WHERE conversation_id = ${conversationId}`;
      for (const [filename, content] of Object.entries(serialized)) {
        await pg`
          INSERT INTO conversation_files (conversation_id, build_id, filename, content)
          VALUES (${conversationId}, ${buildId}, ${filename}, ${typeof content === "string" ? content : JSON.stringify(content)})
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
      const files = Object.fromEntries(rows.map(row => [row.filename, row.content]));
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

    async createJob({ type, conversationId = "", title = "", input = {}, phase = "queued", status = "queued" } = {}) {
      const id = `job_${cryptoRandom()}`;
      const ts = now();
      const safeStatus = normalizeStatus(status);
      const row = {
        id,
        type: String(type || "task"),
        status: safeStatus,
        phase: String(phase || safeStatus),
        conversation_id: String(conversationId || ""),
        title: String(title || ""),
        input,
        output: null,
        error: null,
        choices: [],
        logs: [compactLogEntry({ ts, phase, message: "Job accepted." })],
        cancel_requested: false,
        created_at: ts,
        updated_at: ts,
        started_at: safeStatus === "running" ? ts : "",
        completed_at: finalStatuses.has(safeStatus) ? ts : "",
      };
      await pg`
        INSERT INTO jobs
        (id, type, status, phase, conversation_id, title, input_json, output_json, error_json,
         choices_json, logs_json, cancel_requested, created_at, updated_at, started_at, completed_at)
        VALUES (${row.id}, ${row.type}, ${row.status}, ${row.phase}, ${row.conversation_id}, ${row.title},
          ${jsonString(row.input, {})}, ${jsonString(row.output, null)}, ${jsonString(row.error, null)},
          ${jsonString(row.choices, [])}, ${jsonString(row.logs, [])}, ${0}, ${row.created_at}, ${row.updated_at},
          ${row.started_at}, ${row.completed_at})
      `;
      return row;
    },

    async getJob(id) {
      return normalizeJob(await firstRow(pg`SELECT * FROM jobs WHERE id = ${id}`));
    },

    async listJobs({ limit = 50, conversationId = "", status = "" } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      const safeStatus = status ? normalizeStatus(status) : "";
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
            updated_at = ${next.updated_at},
            started_at = ${next.started_at || ""},
            completed_at = ${next.completed_at || ""}
        WHERE id = ${id}
      `;
      return next;
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

    async isCancelRequested(id) {
      return Boolean((await this.getJob(id))?.cancel_requested);
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
    const current = await readState();
    const result = await task(current);
    await writeState(current);
    return result;
  }
  const now = () => new Date().toISOString();
  const byId = (rows, id) => rows.find(row => String(row.id || "") === String(id || ""));
  const normalizeStatus = value => ["queued", "running", "succeeded", "failed", "canceled"].includes(String(value || "")) ? String(value) : "queued";
  return {
    async initSchema() {
      await writeState(await readState());
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
    async createJob({ type, conversationId = "", title = "", input = {}, phase = "queued", status = "queued" } = {}) {
      const id = `job_${cryptoRandom()}`;
      const row = { id, type, status: normalizeStatus(status), phase, conversation_id: conversationId, title, input, output: null, error: null, choices: [], logs: [{ ts: now(), phase, message: "Job accepted.", data: {} }], cancel_requested: false, created_at: now(), updated_at: now(), started_at: "", completed_at: "" };
      await mutate(state => { state.jobs.push(row); });
      return row;
    },
    async getJob(id) {
      const state = await readState();
      return byId(state.jobs, id) || null;
    },
    async listJobs({ limit = 50, conversationId = "", status = "" } = {}) {
      const state = await readState();
      return state.jobs
        .filter(row => (!conversationId || row.conversation_id === conversationId) && (!status || row.status === status))
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
    async isCancelRequested(id) {
      return Boolean((await this.getJob(id))?.cancel_requested);
    },
  };
}

function cryptoRandom() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
