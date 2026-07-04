import { promises as fs } from "node:fs";
import path from "node:path";

import { createConversationStore } from "./conversationStore.mjs";
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

export function createPostgresProjectPersistence() {
  throw new Error("Postgres ProjectPersistence is not implemented yet.");
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
