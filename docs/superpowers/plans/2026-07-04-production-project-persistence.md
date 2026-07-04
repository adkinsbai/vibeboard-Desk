# Production Project Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move production project state from whole-SQLite snapshot blobs into durable Postgres-backed project persistence while preserving local SQLite behaviour.

**Architecture:** Introduce `ProjectPersistence` as the deep module for conversations, generated files, project memory, and jobs. Local mode uses a SQLite adapter built from existing stores; public Vercel mode uses a Postgres adapter, and multi-process tests use a dedicated file-backed adapter. Server and generation code consume the persistence interface through await-compatible methods.

**Tech Stack:** Node.js ESM, sql.js for local SQLite, `@neondatabase/serverless` for production Postgres, existing Node test scripts.

## Global Constraints

- Preserve local-first SQLite behaviour for Windows and RK3566 prototype workflows.
- Production Vercel project-state reads and writes must not depend on the mutable `sqlite_snapshots` blob write path.
- Do not clear production data.
- Auth, credits, and telemetry stay on their existing Postgres paths.
- A generation job may only return `succeeded` after generated files and final job state are durably saved.
- Storage failures are classified as `storage_failed`.
- Keep public `/api` response shapes stable for the existing frontend.

---

## File Structure

- Create `src/projectPersistence.mjs`: composition module that exposes `createProjectPersistence`, `createSqliteProjectPersistence`, `createFileProjectPersistence`, and `createPostgresProjectPersistence`.
- Modify `server.mjs`: use `ProjectPersistence` for `conversationStore` and `jobStore`, await persistence methods, stop production request-time `syncDbFromSnapshot`.
- Modify `src/generateRuntime.mjs`: await persistence reads/writes and make conversation file save failures fail generation.
- Modify `src/agentOrchestrator.mjs`: await project memory reads/writes.
- Modify `src/projectWorkspace.mjs`: await conversation persistence calls.
- Audit `src/marketRuntime.mjs`: update async persistence call sites when present, or record that the file has no persistence call sites.
- Create `tests/project-persistence.mjs`: adapter parity and multi-instance durable-store regression tests.
- Modify `tests/verify-agent.mjs`: update generation snapshot failure expectations.
- Modify `tests/production-persistence.mjs`: cover public server restart and warm-instance behaviour through the new file-backed test adapter instead of cloud SQLite snapshot writes.
- Modify `package.json`: add a `verify:persistence` script for the new persistence regression suite.
- Modify `docs/public-vercel-deploy.md`: document that `sqlite_snapshots` is now legacy migration storage, not the production write path.

---

### Task 1: Create ProjectPersistence SQLite Interface

**Files:**
- Create: `src/projectPersistence.mjs`
- Create: `tests/project-persistence.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `createConversationStore(sqliteDb, saveDb)` from `src/conversationStore.mjs`; `createJobStore(sqliteDb, saveDb, options)` from `src/jobStore.mjs`.
- Produces: `createSqliteProjectPersistence({ sqliteDb, saveSqlite, jobOptions })` returning await-compatible conversation and job methods, plus job-runtime compatibility aliases `transition`, `appendLog`, `requestCancel`, and `isCancelRequested`.

- [ ] **Step 1: Write the failing test**

Create `tests/project-persistence.mjs` with this initial content:

```js
import { fileURLToPath } from "node:url";

import initSqlJs from "sql.js";

import { assert } from "./support/serverHarness.mjs";
import {
  createFileProjectPersistence,
  createSqliteProjectPersistence,
} from "../src/projectPersistence.mjs";

const SQL = await initSqlJs();

await test("sqlite ProjectPersistence preserves conversations, files, memory, and jobs", async () => {
  const db = new SQL.Database();
  let saves = 0;
  const persistence = createSqliteProjectPersistence({
    sqliteDb: db,
    saveSqlite: () => { saves += 1; },
    jobOptions: { idFactory: () => `job_${saves}` },
  });
  await persistence.initSchema();

  const conversation = await persistence.createConversation("conv-a", "Clock", { userId: "user-a" });
  assert(conversation.id === "conv-a", "conversation id should be returned");

  await persistence.appendMessage("conv-a", { role: "user", content: "make a clock" });
  await persistence.setProjectMemory("conv-a", {
    summary: "clock app",
    goal: "show current time",
    requirements: ["large readable clock"],
    build_prompt: "Build a clock.",
  });
  await persistence.saveConversationFiles("conv-a", "build-a", {
    "index.html": "<!doctype html>",
    "style.css": "body{}",
    "app.js": "console.log('clock')",
    "hardware_app.py": "print('ok')",
    "manifest.json": JSON.stringify({ id: "build-a", files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
    "chat pollution": "must be filtered",
  });

  const job = await persistence.createJob({
    type: "generate",
    conversationId: "conv-a",
    title: "Generate clock",
    input: { prompt: "clock", user_id: "user-a" },
  });
  await persistence.appendLog(job.id, "started", { step: 1 }, "generate");
  const done = await persistence.transition(job.id, {
    status: "succeeded",
    phase: "done",
    output: { ok: true, id: "build-a" },
    choices: [{ label: "Open result", action: "open_result" }],
  });

  const listed = await persistence.listConversations({ userId: "user-a" });
  const files = await persistence.loadConversationFiles("conv-a");
  const messages = await persistence.listMessages("conv-a");
  const memory = await persistence.getProjectMemory("conv-a");
  const jobs = await persistence.listJobs({ conversationId: "conv-a" });

  assert(listed.some(item => item.id === "conv-a"), "conversation should be listable by user");
  assert(files.buildId === "build-a", "saved files should keep the build id");
  assert(files.files["index.html"] === "<!doctype html>", "valid generated file should be loaded");
  assert(!files.files["chat pollution"], "invalid generated file names should be filtered");
  assert(messages.some(item => item.content === "make a clock"), "message should be saved");
  assert(memory.goal === "show current time", "project memory should be saved");
  assert(jobs.some(item => item.id === job.id), "job should be listable by conversation");
  assert(done.completed_at, "final job should have completed_at");
});

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node tests/project-persistence.mjs
```

Expected: FAIL with an import error because `../src/projectPersistence.mjs` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/projectPersistence.mjs` with this SQLite implementation:

```js
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
  const state = {
    conversations: [],
    messages: [],
    conversation_files: [],
    project_memory: [],
    jobs: [],
  };
  async function readState() {
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw) return { ...state };
    return { ...state, ...JSON.parse(raw) };
  }
  async function writeState(next) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(next, null, 2));
  }
  return {
    async initSchema() {
      await writeState(await readState());
    },
  };
}
```

The file-backed adapter is intentionally incomplete in this task. It is created now so later tests can drive its behaviour.

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
node tests/project-persistence.mjs
```

Expected: PASS with `ok - sqlite ProjectPersistence preserves conversations, files, memory, and jobs`.

- [ ] **Step 5: Add npm script**

Modify `package.json` scripts to include:

```json
"verify:persistence": "node tests/project-persistence.mjs"
```

Keep the surrounding JSON valid and keep existing scripts unchanged.

- [ ] **Step 6: Run verification**

Run:

```powershell
npm run verify:persistence
npm run check
```

Expected: both commands pass.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/projectPersistence.mjs tests/project-persistence.mjs package.json
git commit -m "feat: add project persistence interface"
```

---

### Task 2: Implement Shared File Adapter Regression Harness

**Files:**
- Modify: `src/projectPersistence.mjs`
- Modify: `tests/project-persistence.mjs`

**Interfaces:**
- Consumes: `createFileProjectPersistence({ filePath })`.
- Produces: a durable test adapter with the same await-compatible methods as the SQLite adapter, allowing two independent instances to share one JSON file without whole-state overwrite loss.

- [ ] **Step 1: Add failing multi-instance tests**

Append these tests to `tests/project-persistence.mjs` before the `test` helper:

```js
await test("file ProjectPersistence keeps writes from two independent instances", async () => {
  const filePath = fileURLToPath(new URL(`runtime/project-persistence-${Date.now()}-${Math.random()}.json`, new URL("..", import.meta.url)));
  const a = createFileProjectPersistence({ filePath });
  const b = createFileProjectPersistence({ filePath });
  await a.initSchema();
  await b.initSchema();

  await a.createConversation("conv-a", "A", { userId: "user-a" });
  await a.saveConversationFiles("conv-a", "build-a", {
    "index.html": "<!doctype html>",
    "style.css": "body{}",
    "app.js": "console.log('a')",
    "hardware_app.py": "print('a')",
    "manifest.json": JSON.stringify({ id: "build-a", files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
  });
  const job = await b.createJob({
    type: "generate",
    conversationId: "conv-a",
    title: "Generate A",
    input: { user_id: "user-a", prompt: "A" },
  });
  await b.transition(job.id, { status: "succeeded", phase: "done", output: { ok: true, id: "build-a" } });

  const filesFromB = await b.loadConversationFiles("conv-a");
  const jobsFromA = await a.listJobs({ conversationId: "conv-a" });
  const conversationsFromB = await b.listConversations({ userId: "user-a" });

  assert(filesFromB.files["app.js"] === "console.log('a')", "instance B should read files from instance A");
  assert(jobsFromA.some(item => item.id === job.id), "instance A should read job from instance B");
  assert(conversationsFromB.some(item => item.id === "conv-a"), "conversation should survive both writers");
});

await test("file ProjectPersistence does not overwrite newer rows with stale writers", async () => {
  const filePath = fileURLToPath(new URL(`runtime/project-persistence-stale-${Date.now()}-${Math.random()}.json`, new URL("..", import.meta.url)));
  const stale = createFileProjectPersistence({ filePath });
  const fresh = createFileProjectPersistence({ filePath });
  await stale.initSchema();
  await fresh.initSchema();

  await fresh.createConversation("conv-fresh", "Fresh", { userId: "user-a" });
  await stale.createConversation("conv-stale", "Stale", { userId: "user-a" });

  const listed = await fresh.listConversations({ userId: "user-a" });
  const ids = listed.map(item => item.id).sort();
  assert(ids.includes("conv-fresh"), "fresh conversation should remain after stale writer saves");
  assert(ids.includes("conv-stale"), "stale writer conversation should also be saved");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm run verify:persistence
```

Expected: FAIL because the file adapter only implements `initSchema`.

- [ ] **Step 3: Implement file adapter methods**

Replace `createJsonProjectPersistence` in `src/projectPersistence.mjs` with an implementation that reads latest state before every mutation and writes merged rows. Use this code shape:

```js
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
```

Add `cryptoRandom` near the bottom of `src/projectPersistence.mjs` exactly as shown above.

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm run verify:persistence
```

Expected: all persistence tests pass.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/projectPersistence.mjs tests/project-persistence.mjs
git commit -m "test: cover durable project persistence"
```

---

### Task 3: Add Postgres ProjectPersistence Adapter

**Files:**
- Modify: `src/projectPersistence.mjs`
- Modify: `tests/project-persistence.mjs`

**Interfaces:**
- Consumes: Neon tagged template function `pg`.
- Produces: `createPostgresProjectPersistence({ pg })`, with the same interface as `createSqliteProjectPersistence`.

- [ ] **Step 1: Add failing schema contract test**

Append this test to `tests/project-persistence.mjs` before the `test` helper:

```js
await test("postgres ProjectPersistence initializes first-class project tables", async () => {
  const statements = [];
  const pg = async (strings, ...values) => {
    statements.push({ text: strings.join("?"), values });
    return [];
  };
  const persistence = (await import("../src/projectPersistence.mjs")).createPostgresProjectPersistence({ pg });
  await persistence.initSchema();
  const schema = statements.map(item => item.text).join("\n");
  assert(schema.includes("CREATE TABLE IF NOT EXISTS conversations"), "schema should create conversations table");
  assert(schema.includes("CREATE TABLE IF NOT EXISTS messages"), "schema should create messages table");
  assert(schema.includes("CREATE TABLE IF NOT EXISTS conversation_files"), "schema should create conversation_files table");
  assert(schema.includes("CREATE TABLE IF NOT EXISTS project_memory"), "schema should create project_memory table");
  assert(schema.includes("CREATE TABLE IF NOT EXISTS jobs"), "schema should create jobs table");
  assert(schema.includes("idx_jobs_conversation_created"), "schema should index jobs by conversation");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run verify:persistence
```

Expected: FAIL with `Postgres ProjectPersistence is not implemented yet.`

- [ ] **Step 3: Implement schema**

Replace `createPostgresProjectPersistence()` with:

```js
export function createPostgresProjectPersistence({ pg } = {}) {
  if (!pg) throw new Error("pg is required");
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
  };
}
```

- [ ] **Step 4: Run test to verify schema passes**

Run:

```powershell
npm run verify:persistence
```

Expected: schema test passes, but full Postgres CRUD is not yet implemented.

- [ ] **Step 5: Add Postgres CRUD tests using a fake pg delegate**

Add a lightweight fake SQL delegate in `tests/project-persistence.mjs` to exercise adapter method calls without a real database:

```js
function createRecordingPg() {
  const calls = [];
  const pg = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (/SELECT \* FROM conversations WHERE id/.test(text)) return [];
    if (/SELECT \* FROM conversations/.test(text)) return [];
    if (/SELECT filename, content, build_id FROM conversation_files/.test(text)) return [];
    if (/SELECT \* FROM jobs WHERE id/.test(text)) return [];
    if (/SELECT \* FROM jobs/.test(text)) return [];
    if (/SELECT memory_json FROM project_memory/.test(text)) return [];
    return [];
  };
  pg.calls = calls;
  return pg;
}

await test("postgres ProjectPersistence issues row-level writes instead of sqlite snapshot writes", async () => {
  const pg = createRecordingPg();
  const persistence = (await import("../src/projectPersistence.mjs")).createPostgresProjectPersistence({ pg });
  await persistence.createConversation("conv-pg", "PG", { userId: "user-pg" });
  await persistence.saveConversationFiles("conv-pg", "build-pg", {
    "index.html": "<!doctype html>",
    "style.css": "body{}",
    "app.js": "console.log('pg')",
    "hardware_app.py": "print('pg')",
    "manifest.json": JSON.stringify({ id: "build-pg", files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
  });
  await persistence.createJob({ type: "generate", conversationId: "conv-pg", title: "PG", input: { user_id: "user-pg" } });
  const text = pg.calls.map(call => call.text).join("\n");
  assert(text.includes("INSERT INTO conversations"), "conversation should be inserted into a table");
  assert(text.includes("DELETE FROM conversation_files"), "file save should replace rows for one conversation");
  assert(text.includes("INSERT INTO conversation_files"), "files should be inserted as rows");
  assert(text.includes("INSERT INTO jobs"), "job should be inserted into jobs table");
  assert(!text.includes("sqlite_snapshots"), "project persistence must not write sqlite_snapshots");
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run:

```powershell
npm run verify:persistence
```

Expected: FAIL because CRUD methods are missing.

- [ ] **Step 7: Implement Postgres CRUD methods**

Extend `createPostgresProjectPersistence` with the same method names as the SQLite adapter. Use these rules:

```js
const now = () => new Date().toISOString();
const jsonString = (value, fallback) => {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
};
const parseJson = (value, fallback) => {
  try { return value == null || value === "" ? fallback : JSON.parse(String(value)); } catch { return fallback; }
};
function normalizeJob(row) {
  if (!row) return null;
  return {
    id: String(row.id || ""),
    type: String(row.type || ""),
    status: String(row.status || "queued"),
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
}
```

Implement each method with row-level SQL:

```js
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
}
```

Use the same explicit style for all methods. For `saveConversationFiles`, import and apply `filterConversationFiles(files)` before inserting rows. For `setProjectMemory`, use `ON CONFLICT (conversation_id) DO UPDATE`. For `transition`, read the existing job first, merge patch fields, then update one job row. For `appendLog`, read the job, append one compact log entry, and call `transition`.

- [ ] **Step 8: Run verification**

Run:

```powershell
npm run verify:persistence
npm run check
```

Expected: both pass.

- [ ] **Step 9: Commit**

Run:

```powershell
git add src/projectPersistence.mjs tests/project-persistence.mjs
git commit -m "feat: add postgres project persistence"
```

---

### Task 4: Wire Server and Runtime Through ProjectPersistence

**Files:**
- Modify: `server.mjs`
- Modify: `src/generateRuntime.mjs`
- Modify: `src/agentOrchestrator.mjs`
- Modify: `src/projectWorkspace.mjs`
- Modify: `tests/production-persistence.mjs`

**Interfaces:**
- Consumes: `createProjectPersistence({ pg, sqliteDb, saveSqlite, env })`.
- Produces: server routes and generation runtime using await-compatible persistence calls.

- [ ] **Step 1: Add failing production persistence test**

In `tests/production-persistence.mjs`, add a new shared file path near the existing `snapshotPath`:

```js
const projectPersistencePath = fileURLToPath(new URL(`../runtime/prod-project-persistence-${randomUUID()}.json`, import.meta.url));
await fs.rm(projectPersistencePath, { force: true }).catch(() => {});
```

In `startServer`, add this env value:

```js
VIBEBOARD_TEST_PROJECT_PERSISTENCE_FILE: projectPersistencePath,
```

After the request-bound generate job succeeds, add:

```js
const files = await getJson(baseUrl, `/api/conversations/${conversationId}/files`, cookie);
assert(files.buildId === job.data.job.output.id, `conversation files should persist after public job: ${JSON.stringify(files)}`);
assert(files.files?.["index.html"], "conversation files should include index.html after public job");
```

In the `finally` cleanup at the end of the file, add:

```js
await fs.rm(projectPersistencePath, { force: true }).catch(() => {});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node tests/production-persistence.mjs
```

Expected: FAIL because `server.mjs` does not use `VIBEBOARD_TEST_PROJECT_PERSISTENCE_FILE` yet.

- [ ] **Step 3: Wire ProjectPersistence in server**

In `server.mjs`, import:

```js
import { createProjectPersistence } from "./src/projectPersistence.mjs";
```

Replace direct creation of `conversationStore` and `jobStore` with:

```js
const projectPersistence = createProjectPersistence({
  pg,
  sqliteDb,
  saveSqlite: saveDb,
  env: process.env,
});
await projectPersistence.initSchema();
const conversationStore = projectPersistence;
const jobStore = projectPersistence;
await jobStore.markInterruptedRunningJobs();
```

Remove or skip the old lines:

```js
const conversationStore = createConversationStore(sqliteDb, saveDb);
conversationStore.initSchema();
const jobStore = createJobStore(sqliteDb, saveDb);
jobStore.initSchema();
jobStore.markInterruptedRunningJobs();
```

Keep imports for `normalizeProjectMemory` from `conversationStore.mjs` if still used.

- [ ] **Step 4: Stop production snapshot sync on normal API reads**

Update `shouldSyncSqliteSnapshot(pathname)` in `server.mjs`:

```js
function shouldSyncSqliteSnapshot(pathname) {
  if (!cloudSqliteSnapshot) return false;
  if (PUBLIC_DEPLOYMENT && !TEST_CLOUD_SQLITE_FILE) return false;
  if (!isPublicApi(pathname)) return true;
  return TEST_CLOUD_SQLITE_FILE && /^\/api\/auth\//.test(pathname);
}
```

This keeps local test snapshot behaviour but stops production project API reads from reloading a stale blob.

- [ ] **Step 5: Make access helpers async**

Change `ensureConversationAccess`:

```js
async function ensureConversationAccess(conversationId, user) {
  const conversation = await conversationStore.getConversation(conversationId);
  if (!conversation) throw httpError(404, "Conversation not found.");
  if (PUBLIC_DEPLOYMENT && user?.role !== "admin" && (!conversation.user_id || conversation.user_id !== user?.id)) {
    throw httpError(403, "Conversation access denied.");
  }
  return conversation;
}
```

Change `ensureJobAccess`:

```js
async function ensureJobAccess(job, user) {
  if (!job) throw httpError(404, "Job not found");
  if (PUBLIC_DEPLOYMENT && user?.role !== "admin" && String(job.input?.user_id || "") !== user?.id) {
    throw httpError(403, "Job access denied.");
  }
  return job;
}
```

Then update every call site to `await ensureConversationAccess(...)` and `await ensureJobAccess(...)`.

- [ ] **Step 6: Await persistence route calls**

In `server.mjs`, update route call sites so these calls are awaited:

```js
await conversationStore.listConversations(...)
await conversationStore.createConversation(...)
await conversationStore.deleteConversation(...)
await conversationStore.listMessages(...)
await conversationStore.loadConversationFiles(...)
await conversationStore.getProjectMemory(...)
await conversationStore.setProjectMemory(...)
await conversationStore.appendMessage(...)
await jobStore.listJobs(...)
await jobStore.getJob(...)
await jobStore.requestCancel(...)
```

Use exact response shapes already present in `server.mjs`.

- [ ] **Step 7: Await persistence in runtime modules**

In `src/generateRuntime.mjs`, update these calls:

```js
const projectMemory = conversationId
  ? await conversationStore.getProjectMemory(conversationId)
  : normalizeProjectMemory();
const conversationFiles = conversationId
  ? (await conversationStore.loadConversationFiles(conversationId)).files
  : {};
await conversationStore.saveConversationFiles(conversationId, state.result.id, files);
```

In `src/agentOrchestrator.mjs`, update project-memory calls:

```js
const projectMemory = conversationId
  ? await conversationStore.getProjectMemory(conversationId)
  : normalizeProjectMemory();
await conversationStore.setProjectMemory(conversationId, plan.project_memory);
```

In `src/projectWorkspace.mjs`, await:

```js
await conversationStore.getConversation?.(conversationId)
await conversationStore.updateConversation?.(conversationId, { projectDir })
await conversationStore.getProjectMemory(conversationId)
```

- [ ] **Step 8: Run focused verification**

Run:

```powershell
node tests/production-persistence.mjs
npm run verify:persistence
npm run check
```

Expected: all pass.

- [ ] **Step 9: Commit**

Run:

```powershell
git add server.mjs src/generateRuntime.mjs src/agentOrchestrator.mjs src/projectWorkspace.mjs tests/production-persistence.mjs
git commit -m "refactor: wire server through project persistence"
```

---

### Task 5: Make Conversation File Save Failures Fail Generation

**Files:**
- Modify: `src/generateRuntime.mjs`
- Modify: `tests/verify-agent.mjs`

**Interfaces:**
- Consumes: `saveSnapshot({ state, conversationId, embeddedAssets, rawPrompt })` inside `createGenerateRuntime`.
- Produces: storage save failures throw structured `storage_failed` errors and prevent job success.

- [ ] **Step 1: Replace the old downgraded-failure test**

Find the existing test named:

```js
generate runtime downgrades snapshot save failures
```

Replace it with this test:

```js
await test("generate runtime fails when conversation snapshot save fails", async () => {
  const logs = [];
  const runtime = createGenerateRuntime({
    conversationStore: {
      getProjectMemory: async () => ({}),
      loadConversationFiles: async () => ({ files: {} }),
      saveConversationFiles: async () => {
        const error = new Error("durable project save failed");
        error.errorType = "storage_failed";
        throw error;
      },
    },
    memoryStore: { getAll: () => ({}) },
    assetLibraryStore: {
      promptContext: () => "",
      generatedAssets: () => ({ items: [], files: {}, rejected: [] }),
      recordBuildSnapshot: () => {},
    },
    appendServerLog: async (event, data) => logs.push({ event, data }),
    normalizeGenerateHistory: history => history,
    compressHistory: async history => history,
    buildId: () => "build-save-fails",
    writeGenerated: async () => ({
      id: "build-save-fails",
      files: validGeneratedFiles(),
      manifest: JSON.parse(validGeneratedFiles()["manifest.json"]),
      buildEvidence: { ok: true, summary: "ok" },
      agentRun: {},
    }),
    filesWithHardwareResult: async files => files,
    projectWorkspace: {
      writeBuildSnapshot: async () => {},
      writeMemory: async () => {},
      listProjectFiles: async () => [],
    },
  });

  let failed = false;
  try {
    await runtime.runGenerateRequest({
      prompt: "Build a clock",
      conversation_id: "conv-save-fails",
      modelSettings: { enabled: false },
    });
  } catch (error) {
    failed = error.errorType === "storage_failed" || /save failed/i.test(error.message);
  }

  assert(failed, "generation should fail when durable conversation file save fails");
  assert(logs.some(item => /conversation_save_failed/.test(item.event)), "runtime should log conversation save failure");
});
```

Before adding the test, inspect the existing helper names in `tests/verify-agent.mjs`. Use the file's existing generated-file helper when one exists; otherwise define the `validGeneratedFiles` helper shown in this step.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node tests/verify-agent.mjs
```

Expected: FAIL because `saveSnapshot` currently catches and downgrades save failures.

- [ ] **Step 3: Change saveSnapshot error behaviour**

In `src/generateRuntime.mjs`, change the `catch (saveErr)` block in `saveSnapshot` to log and rethrow a classified storage error:

```js
    } catch (saveErr) {
      await appendServerLog(`generate.${state.result.source}.conversation_save_failed`, {
        id: state.result.id,
        conversationId,
        error: saveErr.message,
      });
      const error = createStructuredError(
        "Generated files were created, but project data could not be saved. Please retry.",
        "storage_failed",
        {
          statusCode: saveErr.statusCode || 503,
          cause: saveErr,
          technicalDetail: saveErr.message || "conversation snapshot save failed",
        },
      );
      throw error;
    }
```

- [ ] **Step 4: Run focused verification**

Run:

```powershell
node tests/verify-agent.mjs
npm run verify:persistence
```

Expected: both pass.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/generateRuntime.mjs tests/verify-agent.mjs
git commit -m "fix: fail generation on project save errors"
```

---

### Task 6: Add Legacy Snapshot Migration and Documentation

**Files:**
- Modify: `src/projectPersistence.mjs`
- Modify: `server.mjs`
- Modify: `tests/project-persistence.mjs`
- Modify: `docs/public-vercel-deploy.md`

**Interfaces:**
- Consumes: legacy SQLite snapshot buffer from `cloudSqliteSnapshot.load()`.
- Produces: idempotent migration into `ProjectPersistence` without overwriting newer rows.

- [ ] **Step 1: Add failing migration test**

Append this test to `tests/project-persistence.mjs`:

```js
await test("ProjectPersistence legacy migration imports missing rows without overwriting newer rows", async () => {
  const legacyDb = new SQL.Database();
  const legacy = createSqliteProjectPersistence({ sqliteDb: legacyDb, saveSqlite: () => {} });
  await legacy.initSchema();
  await legacy.createConversation("conv-legacy", "Legacy", { userId: "user-a" });
  await legacy.saveConversationFiles("conv-legacy", "build-legacy", {
    "index.html": "<!doctype html>",
    "style.css": "body{}",
    "app.js": "console.log('legacy')",
    "hardware_app.py": "print('legacy')",
    "manifest.json": JSON.stringify({ id: "build-legacy", files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
  });
  const legacyBuffer = Buffer.from(legacyDb.export());

  const filePath = fileURLToPath(new URL(`runtime/project-persistence-migrate-${Date.now()}-${Math.random()}.json`, new URL("..", import.meta.url)));
  const target = createFileProjectPersistence({ filePath });
  await target.initSchema();
  await target.createConversation("conv-new", "New", { userId: "user-a" });

  await target.migrateLegacySqliteSnapshot(legacyBuffer);
  await target.migrateLegacySqliteSnapshot(legacyBuffer);

  const listed = await target.listConversations({ userId: "user-a" });
  const files = await target.loadConversationFiles("conv-legacy");
  const ids = listed.map(item => item.id);
  assert(ids.includes("conv-legacy"), "legacy conversation should be imported");
  assert(ids.includes("conv-new"), "new conversation should not be overwritten");
  assert(files.files["app.js"] === "console.log('legacy')", "legacy files should be imported");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run verify:persistence
```

Expected: FAIL because `migrateLegacySqliteSnapshot` does not exist.

- [ ] **Step 3: Implement migration on adapters**

In `src/projectPersistence.mjs`, add an exported helper:

```js
export async function readLegacySqliteSnapshot(buffer) {
  if (!buffer?.length) return null;
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(buffer);
  const legacy = createSqliteProjectPersistence({ sqliteDb: db, saveSqlite: () => {} });
  await legacy.initSchema();
  return legacy;
}
```

Add `migrateLegacySqliteSnapshot(buffer)` to `createJsonProjectPersistence` and `createPostgresProjectPersistence`. It should:

1. Call `readLegacySqliteSnapshot(buffer)`.
2. List all legacy conversations.
3. For each legacy conversation, insert it only if `getConversation(id)` returns null.
4. Import messages when the target has no messages for that conversation.
5. Import conversation files when the target has no files for that conversation.
6. Import project memory when the target memory is empty.
7. Import jobs when `getJob(id)` returns null.

Use target adapter public methods for all writes so filtering and normalization stay in one place.

- [ ] **Step 4: Wire migration in server**

After `await projectPersistence.initSchema();` in `server.mjs`, add:

```js
if (PUBLIC_DEPLOYMENT && !TEST_CLOUD_SQLITE_FILE && cloudSqliteSnapshot && typeof projectPersistence.migrateLegacySqliteSnapshot === "function") {
  const legacyBuffer = await cloudSqliteSnapshot.load().catch((error) => {
    console.warn("[db] legacy sqlite snapshot migration load failed:", error.message);
    return null;
  });
  if (legacyBuffer?.length) {
    await projectPersistence.migrateLegacySqliteSnapshot(legacyBuffer).catch((error) => {
      console.warn("[db] legacy sqlite snapshot migration failed:", error.message);
    });
  }
}
```

This is a best-effort compatibility migration. It must not re-enable production snapshot writes.

- [ ] **Step 5: Update deployment docs**

In `docs/public-vercel-deploy.md`, replace the Storage Model paragraph with:

```md
## Storage Model

Vercel Functions have a read-only filesystem and only `/tmp` is writable scratch space. In public deployment, auth, credits, telemetry, conversations, generated files, project memory, and jobs use Postgres tables through server-side adapters.

The older `sqlite_snapshots` table is retained only as a legacy migration source for project state that existed before the Postgres project-persistence migration. New production project-state writes do not update the SQLite snapshot blob.
```

- [ ] **Step 6: Run verification**

Run:

```powershell
npm run verify:persistence
node tests/production-persistence.mjs
npm run check
```

Expected: all pass.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/projectPersistence.mjs server.mjs tests/project-persistence.mjs docs/public-vercel-deploy.md
git commit -m "feat: migrate legacy project snapshots"
```

---

### Task 7: Full Verification and Public Smoke

**Files:**
- Modify only files needed to fix failures found by verification.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified local and public production behaviour.

- [ ] **Step 1: Run local verification gates**

Run:

```powershell
npm run check
npm run verify:persistence
npm run verify:auth
npm run verify:agent
npm run verify:offline
```

Expected: all pass.

- [ ] **Step 2: Run public E2E**

Run:

```powershell
npm run verify:public
```

Expected: PASS. The final output must include successful `conversation.files` after successful generation.

- [ ] **Step 3: Inspect Vercel deployment before any deploy**

Run:

```powershell
npx vercel inspect https://vibeboard-chi.vercel.app --timeout 120000
```

Expected: current production deployment is Ready. This confirms the baseline before any deploy action.

- [ ] **Step 4: Commit verification-only fixes when verification changes files**

If Step 1 or Step 2 requires code fixes, run `git status --short`, stage the exact files shown there that belong to this persistence work, run the relevant focused tests again, then commit. Example for a server/runtime verification fix:

```powershell
git status --short
git add server.mjs src/projectPersistence.mjs src/generateRuntime.mjs tests/project-persistence.mjs tests/production-persistence.mjs
git commit -m "fix: stabilize project persistence verification"
```

If no fixes are needed, do not create an empty commit.

- [ ] **Step 5: Record final status**

Prepare a short handoff note in the final response with:

The final note must include the exact commands run, each pass/fail result, the Vercel deployment readiness state, and one concise remaining-risk sentence.
