import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import initSqlJs from "sql.js";

import { assert } from "./support/serverHarness.mjs";
import {
  createFileProjectPersistence,
  createPostgresProjectPersistence,
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
  const idempotentJob = await persistence.findIdempotentJob({
    type: "generate",
    conversationId: "conv-a",
    input: { prompt: "clock", user_id: "user-a", client_run_id: "missing" },
  });

  assert(listed.some(item => item.id === "conv-a"), "conversation should be listable by user");
  assert(files.buildId === "build-a", "saved files should keep the build id");
  assert(files.files["index.html"] === "<!doctype html>", "valid generated file should be loaded");
  assert(!files.files["chat pollution"], "invalid generated file names should be filtered");
  assert(messages.some(item => item.content === "make a clock"), "message should be saved");
  assert(memory.goal === "show current time", "project memory should be saved");
  assert(jobs.some(item => item.id === job.id), "job should be listable by conversation");
  assert(idempotentJob === null, "sqlite idempotency lookup should ignore jobs without client_run_id");
  assert(done.completed_at, "final job should have completed_at");
});

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

await test("file ProjectPersistence filters loaded conversation rows like database adapters", async () => {
  const filePath = fileURLToPath(new URL(`runtime/project-persistence-filter-load-${Date.now()}-${Math.random()}.json`, new URL("..", import.meta.url)));
  const state = {
    conversations: [{ id: "conv-file-filter", title: "Filter", user_id: "user-a", project_dir: "", created_at: "2026-07-07T01:00:00.000Z", updated_at: "2026-07-07T01:00:00.000Z" }],
    messages: [],
    conversation_files: [
      { id: "row-1", conversation_id: "conv-file-filter", build_id: "build-file-filter", filename: "index.html", content: "<!doctype html>", created_at: "2026-07-07T01:00:00.000Z" },
      { id: "row-2", conversation_id: "conv-file-filter", build_id: "build-file-filter", filename: "manifest.json", content: JSON.stringify({ id: "build-file-filter", files: ["index.html", "assets/logo.json"] }), created_at: "2026-07-07T01:00:00.000Z" },
      { id: "row-3", conversation_id: "conv-file-filter", build_id: "build-file-filter", filename: "assets/logo.json", content: "{\"name\":\"logo\"}", created_at: "2026-07-07T01:00:00.000Z" },
      { id: "row-4", conversation_id: "conv-file-filter", build_id: "build-file-filter", filename: "chat pollution", content: "must be filtered", created_at: "2026-07-07T01:00:00.000Z" },
    ],
    project_memory: [],
    jobs: [],
  };
  await fs.mkdir(new URL("runtime/", new URL("..", import.meta.url)), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));

  const persistence = createFileProjectPersistence({ filePath });
  const loaded = await persistence.loadConversationFiles("conv-file-filter");

  assert(loaded.buildId === "build-file-filter", "file load should keep the first snapshot build id");
  assert(loaded.files["index.html"] === "<!doctype html>", "allowed generated file should load");
  assert(loaded.files["assets/logo.json"] === "{\"name\":\"logo\"}", "manifest-declared asset should load");
  assert(!loaded.files["chat pollution"], "undeclared file rows should be filtered on load");
});

await test("ProjectPersistence can find idempotent jobs by client_run_id", async () => {
  const db = new SQL.Database();
  const sqlite = createSqliteProjectPersistence({
    sqliteDb: db,
    saveSqlite: () => {},
    jobOptions: { idFactory: () => "job-idem-sqlite" },
  });
  await sqlite.initSchema();
  const created = await sqlite.createJob({
    type: "generate",
    conversationId: "conv-idem",
    title: "Generate once",
    input: { prompt: "one", action: "confirm_build", client_run_id: "run-idem", user_id: "user-a" },
  });
  const found = await sqlite.findIdempotentJob({
    type: "generate",
    conversationId: "conv-idem",
    input: { prompt: "one", action: "confirm_build", client_run_id: "run-idem", user_id: "user-a" },
  });
  const differentAction = await sqlite.findIdempotentJob({
    type: "generate",
    conversationId: "conv-idem",
    input: { prompt: "one", action: "continue_edit", client_run_id: "run-idem", user_id: "user-a" },
  });

  assert(found?.id === created.id, "sqlite should find matching idempotent job");
  assert(differentAction === null, "sqlite idempotency lookup should be scoped by action");

  const filePath = fileURLToPath(new URL(`runtime/project-idempotency-${Date.now()}-${Math.random()}.json`, new URL("..", import.meta.url)));
  const filePersistence = createFileProjectPersistence({ filePath });
  await filePersistence.initSchema();
  const fileJob = await filePersistence.createJob({
    type: "generate",
    conversationId: "conv-file-idem",
    title: "Generate once",
    input: { action: "confirm_build", client_run_id: "run-file-idem", user_id: "user-a" },
  });
  const fileFound = await filePersistence.findIdempotentJob({
    type: "generate",
    conversationId: "conv-file-idem",
    input: { action: "confirm_build", client_run_id: "run-file-idem", user_id: "user-a" },
  });

  assert(fileFound?.id === fileJob.id, "file persistence should find matching idempotent job");
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

function createRecordingPg(options = {}) {
  const conversationsById = options.conversationsById || {};
  const projectMemoryByConversationId = options.projectMemoryByConversationId || {};
  const calls = [];
  const pg = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (/SELECT \* FROM conversations WHERE id/.test(text)) {
      const row = conversationsById[String(values[0] || "")];
      return row ? [row] : [];
    }
    if (/SELECT \* FROM conversations/.test(text)) return [];
    if (/SELECT filename, content, build_id FROM conversation_files/.test(text)) return [];
    if (/SELECT \* FROM jobs WHERE id/.test(text)) return [];
    if (/SELECT \* FROM jobs/.test(text)) return [];
    if (/SELECT memory_json FROM project_memory/.test(text)) {
      const row = projectMemoryByConversationId[String(values[0] || "")];
      return row ? [row] : [];
    }
    return [];
  };
  pg.calls = calls;
  return pg;
}

await test("postgres ProjectPersistence issues row-level writes instead of sqlite snapshot writes", async () => {
  const pg = createRecordingPg();
  const persistence = createPostgresProjectPersistence({ pg });
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

await test("postgres ProjectPersistence can find idempotent jobs by client_run_id", async () => {
  const pg = async (strings, ...values) => {
    const text = strings.join("?");
    if (/SELECT \* FROM jobs/.test(text)) {
      assert(values[0] === "generate", "postgres idempotency lookup should filter by type");
      assert(values[1] === "conv-pg-idem", "postgres idempotency lookup should filter by conversation");
      return [{
        id: "job-pg-idem",
        type: "generate",
        status: "succeeded",
        phase: "done",
        conversation_id: "conv-pg-idem",
        title: "Generate once",
        input_json: JSON.stringify({ action: "confirm_build", client_run_id: "run-pg-idem", user_id: "user-a" }),
        output_json: JSON.stringify({ ok: true }),
        error_json: null,
        choices_json: "[]",
        logs_json: "[]",
        cancel_requested: 0,
        created_at: "2026-07-06T01:00:00.000Z",
        updated_at: "2026-07-06T01:00:01.000Z",
        started_at: null,
        completed_at: "2026-07-06T01:00:01.000Z",
      }];
    }
    return [];
  };
  const persistence = createPostgresProjectPersistence({ pg });
  const found = await persistence.findIdempotentJob({
    type: "generate",
    conversationId: "conv-pg-idem",
    input: { action: "confirm_build", client_run_id: "run-pg-idem", user_id: "user-a" },
  });
  const miss = await persistence.findIdempotentJob({
    type: "generate",
    conversationId: "conv-pg-idem",
    input: { action: "confirm_build", client_run_id: "run-pg-idem", user_id: "user-b" },
  });

  assert(found?.id === "job-pg-idem", "postgres should find matching idempotent job");
  assert(miss === null, "postgres idempotency lookup should be scoped by user");
});

await test("postgres ProjectPersistence sends null for absent job timestamp columns", async () => {
  const calls = [];
  const pg = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (/SELECT \* FROM jobs WHERE id/.test(text)) {
      return [{
        id: "job-existing",
        type: "generate",
        status: "queued",
        phase: "queued",
        conversation_id: "conv-pg",
        title: "PG",
        input_json: "{}",
        output_json: "null",
        error_json: "null",
        choices_json: "[]",
        logs_json: "[]",
        cancel_requested: 0,
        created_at: "2026-07-04T00:00:00.000Z",
        updated_at: "2026-07-04T00:00:00.000Z",
        started_at: null,
        completed_at: null,
      }];
    }
    return [];
  };
  const persistence = createPostgresProjectPersistence({ pg });
  const created = await persistence.createJob({ type: "generate", conversationId: "conv-pg", title: "PG" });
  const insert = calls.find(call => call.text.includes("INSERT INTO jobs"));
  assert(insert.values.at(-2) === null, "queued job should insert null started_at");
  assert(insert.values.at(-1) === null, "queued job should insert null completed_at");
  assert(created.started_at === "", "created job should keep public empty started_at shape");
  assert(created.completed_at === "", "created job should keep public empty completed_at shape");

  const transitioned = await persistence.transition("job-existing", { phase: "queued" });
  const update = calls.find(call => call.text.includes("UPDATE jobs"));
  assert(update.values.at(-3) === null, "non-running transition should update null started_at");
  assert(update.values.at(-2) === null, "non-final transition should update null completed_at");
  assert(transitioned.started_at === "", "transition result should keep public empty started_at shape");
  assert(transitioned.completed_at === "", "transition result should keep public empty completed_at shape");
});

await test("postgres ProjectPersistence writes Date-backed job timestamps as ISO strings", async () => {
  const calls = [];
  const date = new Date("2026-07-05T12:57:00.000Z");
  const pg = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (/SELECT \* FROM jobs WHERE id/.test(text)) {
      return [{
        id: "job-date",
        type: "generate",
        status: "running",
        phase: "starting",
        conversation_id: "conv-date",
        title: "Date job",
        input_json: "{}",
        output_json: "null",
        error_json: "null",
        choices_json: "[]",
        logs_json: "[]",
        cancel_requested: 0,
        created_at: date,
        updated_at: date,
        started_at: date,
        completed_at: null,
      }];
    }
    return [];
  };
  const persistence = createPostgresProjectPersistence({ pg });
  await persistence.transition("job-date", { status: "succeeded", phase: "done", output: { ok: true } });

  const update = calls.find(call => call.text.includes("UPDATE jobs"));
  assert(update, "transition should update job row");
  assert(update.values.includes("2026-07-05T12:57:00.000Z"), "Date-backed started_at should be written as ISO");
  assert(!update.values.some(value => typeof value === "string" && value.includes("GMT+")), "Postgres timestamp writes must not use JS Date.toString()");
});

await test("postgres ProjectPersistence replaces conversation files in a transaction when supported", async () => {
  const calls = [];
  const pg = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ source: "pg", text, values });
    return [];
  };
  pg.transaction = async task => {
    const tx = async (strings, ...values) => {
      const text = strings.join("?");
      calls.push({ source: "tx", text, values });
      return [];
    };
    const queries = task(tx);
    calls.push({ source: "transaction", queryCount: queries.length });
    return queries;
  };
  const persistence = createPostgresProjectPersistence({ pg });
  await persistence.saveConversationFiles("conv-pg", "build-pg", {
    "index.html": "<!doctype html>",
    "style.css": "body{}",
    "app.js": "console.log('pg')",
    "hardware_app.py": "print('pg')",
    "manifest.json": JSON.stringify({ id: "build-pg", files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
  });

  assert(calls.some(call => call.source === "transaction"), "file replacement should use pg.transaction");
  assert(calls.filter(call => call.source === "tx" && call.text.includes("DELETE FROM conversation_files")).length === 1, "delete should be inside transaction");
  assert(calls.filter(call => call.source === "tx" && call.text.includes("INSERT INTO conversation_files")).length === 5, "file inserts should be inside transaction");
  assert(calls.every(call => call.source !== "pg" || !call.text.includes("conversation_files")), "file replacement statements should not run outside transaction");
});

await test("postgres ProjectPersistence filters loaded conversation files", async () => {
  const pg = async (strings, ...values) => {
    const text = strings.join("?");
    if (/SELECT filename, content, build_id FROM conversation_files/.test(text)) {
      return [
        { filename: "index.html", content: "<!doctype html>", build_id: "build-pg" },
        { filename: "manifest.json", content: JSON.stringify({ id: "build-pg", files: ["index.html", "assets/logo.json"] }), build_id: "build-pg" },
        { filename: "assets/logo.json", content: "{\"name\":\"logo\"}", build_id: "build-pg" },
        { filename: "chat pollution", content: "must be filtered", build_id: "build-pg" },
      ];
    }
    return [];
  };
  const persistence = createPostgresProjectPersistence({ pg });
  const loaded = await persistence.loadConversationFiles("conv-pg");
  assert(loaded.files["index.html"] === "<!doctype html>", "allowed generated file should load");
  assert(loaded.files["assets/logo.json"] === "{\"name\":\"logo\"}", "manifest-declared asset should load");
  assert(!loaded.files["chat pollution"], "undeclared file rows should be filtered");
});

await test("postgres ProjectPersistence legacy migration uses conflict-safe child inserts", async () => {
  const legacyDb = new SQL.Database();
  const legacy = createSqliteProjectPersistence({ sqliteDb: legacyDb, saveSqlite: () => {} });
  await legacy.initSchema();
  await legacy.createConversation("conv-pg-migrate", "Legacy PG", { userId: "user-pg" });
  await legacy.appendMessage("conv-pg-migrate", { role: "user", content: "legacy pg prompt" });
  await legacy.saveConversationFiles("conv-pg-migrate", "build-pg-migrate", {
    "index.html": "<!doctype html>",
    "style.css": "body{}",
    "app.js": "console.log('pg migrate')",
    "hardware_app.py": "print('pg migrate')",
    "manifest.json": JSON.stringify({ id: "build-pg-migrate", files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
  });

  const pg = createRecordingPg();
  const persistence = createPostgresProjectPersistence({ pg });
  await persistence.initSchema();
  await persistence.migrateLegacySqliteSnapshot(Buffer.from(legacyDb.export()));

  const text = pg.calls.map(call => call.text).join("\n");
  assert(text.includes("legacy_id"), "migration schema and inserts should use legacy_id keys");
  assert(text.includes("ON CONFLICT DO NOTHING"), "migration child inserts should be conflict-safe");
  assert(text.includes("INSERT INTO messages"), "migration should insert messages directly");
  assert(text.includes("INSERT INTO conversation_files"), "migration should insert files directly");
});

await test("postgres ProjectPersistence legacy migration imports missing project memory without touching conversation timestamps", async () => {
  const legacyDb = new SQL.Database();
  const legacy = createSqliteProjectPersistence({ sqliteDb: legacyDb, saveSqlite: () => {} });
  await legacy.initSchema();
  await legacy.createConversation("conv-pg-existing-memory", "Legacy PG", { userId: "user-pg" });
  await legacy.setProjectMemory("conv-pg-existing-memory", {
    summary: "legacy summary",
    goal: "legacy goal",
    requirements: ["legacy requirement"],
  });

  const pg = createRecordingPg({
    conversationsById: {
      "conv-pg-existing-memory": {
        id: "conv-pg-existing-memory",
        title: "Current PG",
        user_id: "user-pg",
        project_dir: "",
        created_at: "2026-07-04T01:00:00.000Z",
        updated_at: "2026-07-04T02:00:00.000Z",
      },
    },
  });
  const persistence = createPostgresProjectPersistence({ pg });
  await persistence.initSchema();
  await persistence.migrateLegacySqliteSnapshot(Buffer.from(legacyDb.export()));

  const conversationUpdates = pg.calls.filter(call => /UPDATE conversations SET/.test(call.text));
  const memoryInserts = pg.calls.filter(call => /INSERT INTO project_memory/.test(call.text));
  assert(memoryInserts.length === 1, "migration should insert missing project memory");
  assert(conversationUpdates.length === 0, "legacy memory import must not update conversations.updated_at");
});

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

await test("ProjectPersistence legacy migration does not overwrite same-key target rows", async () => {
  const legacyDb = new SQL.Database();
  const legacy = createSqliteProjectPersistence({ sqliteDb: legacyDb, saveSqlite: () => {} });
  await legacy.initSchema();
  await legacy.createConversation("conv-shared", "Legacy title", { userId: "legacy-user", projectDir: "legacy-dir" });
  await legacy.appendMessage("conv-shared", { role: "user", content: "legacy prompt", build_id: "legacy-build" });
  await legacy.appendMessage("conv-shared", { role: "assistant", content: "legacy answer", build_id: "legacy-build" });
  await legacy.saveConversationFiles("conv-shared", "legacy-build", {
    "index.html": "<!doctype html><p>legacy</p>",
    "style.css": "body{color:red}",
    "app.js": "console.log('legacy')",
    "hardware_app.py": "print('legacy')",
    "manifest.json": JSON.stringify({ id: "legacy-build", files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
  });
  await legacy.setProjectMemory("conv-shared", { goal: "legacy goal", requirements: ["legacy"] });
  const legacyJob = await legacy.createJob({ type: "generate", conversationId: "conv-shared", title: "Legacy job", input: { source: "legacy" } });

  const filePath = fileURLToPath(new URL(`runtime/project-persistence-migrate-existing-${Date.now()}-${Math.random()}.json`, new URL("..", import.meta.url)));
  const targetState = {
    conversations: [{
      id: "conv-shared",
      title: "Current title",
      user_id: "current-user",
      project_dir: "current-dir",
      created_at: "2026-07-04T01:00:00.000Z",
      updated_at: "2026-07-04T02:00:00.000Z",
    }],
    messages: [{
      id: "legacy:1",
      legacy_id: "1",
      conversation_id: "conv-shared",
      role: "user",
      content: "current prompt",
      build_id: "current-build",
      created_at: "2026-07-04T02:01:00.000Z",
    }],
    conversation_files: [
      { id: "current-file-1", conversation_id: "conv-shared", build_id: "current-build", filename: "index.html", content: "<!doctype html><p>current</p>", created_at: "2026-07-04T02:02:00.000Z" },
      { id: "current-file-2", conversation_id: "conv-shared", build_id: "current-build", filename: "style.css", content: "body{color:green}", created_at: "2026-07-04T02:02:00.000Z" },
    ],
    project_memory: [{
      conversation_id: "conv-shared",
      memory: { goal: "current goal", requirements: ["current"] },
      updated_at: "2026-07-04T02:03:00.000Z",
    }],
    jobs: [{
      id: legacyJob.id,
      type: "generate",
      status: "succeeded",
      phase: "done",
      conversation_id: "conv-shared",
      title: "Current job",
      input: { source: "current" },
      output: { ok: true },
      error: null,
      choices: [],
      logs: [],
      cancel_requested: false,
      created_at: "2026-07-04T02:04:00.000Z",
      updated_at: "2026-07-04T02:05:00.000Z",
      started_at: "2026-07-04T02:04:00.000Z",
      completed_at: "2026-07-04T02:05:00.000Z",
    }, {
      id: "job-current-only",
      type: "generate",
      status: "queued",
      phase: "queued",
      conversation_id: "conv-shared",
      title: "Current only",
      input: { source: "current-only" },
      output: null,
      error: null,
      choices: [],
      logs: [],
      cancel_requested: false,
      created_at: "2026-07-04T02:06:00.000Z",
      updated_at: "2026-07-04T02:06:00.000Z",
      started_at: "",
      completed_at: "",
    }],
  };
  await fs.mkdir(new URL("runtime/", new URL("..", import.meta.url)), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(targetState, null, 2));

  const target = createFileProjectPersistence({ filePath });
  await target.initSchema();
  await target.migrateLegacySqliteSnapshot(Buffer.from(legacyDb.export()));

  const conversation = await target.getConversation("conv-shared");
  const messages = await target.listMessages("conv-shared");
  const files = await target.loadConversationFiles("conv-shared");
  const memory = await target.getProjectMemory("conv-shared");
  const job = await target.getJob(legacyJob.id);

  assert(conversation.title === "Current title", "current conversation title should not be overwritten");
  assert(conversation.project_dir === "current-dir", "current conversation project_dir should not be overwritten");
  assert(conversation.updated_at === "2026-07-04T02:00:00.000Z", "current conversation ordering timestamp should not change");
  assert(messages.length === 2, "missing legacy message should be imported by stable key");
  assert(messages.find(row => row.id === "legacy:1")?.content === "current prompt", "current same-key message should not be overwritten");
  assert(messages.some(row => row.content === "legacy answer"), "missing legacy message should be imported");
  assert(files.files["index.html"] === "<!doctype html><p>current</p>", "current same-key file should not be overwritten");
  assert(files.files["app.js"] === "console.log('legacy')", "missing legacy file should be imported");
  assert(memory.goal === "current goal", "current project memory should not be overwritten");
  assert(job.title === "Current job" && job.input.source === "current", "current same-id job should not be overwritten");
  assert(await target.getJob("job-current-only"), "current-only job should remain after migration");
});

await test("ProjectPersistence legacy migration imports missing children without reordering existing conversation metadata", async () => {
  const legacyDb = new SQL.Database();
  const legacy = createSqliteProjectPersistence({ sqliteDb: legacyDb, saveSqlite: () => {} });
  await legacy.initSchema();
  await legacy.createConversation("conv-existing", "Legacy title", { userId: "legacy-user", projectDir: "legacy-dir" });
  await legacy.appendMessage("conv-existing", { role: "user", content: "legacy prompt" });
  const legacyBuffer = Buffer.from(legacyDb.export());

  const filePath = fileURLToPath(new URL(`runtime/project-persistence-migrate-metadata-${Date.now()}-${Math.random()}.json`, new URL("..", import.meta.url)));
  const target = createFileProjectPersistence({ filePath });
  await target.initSchema();
  await target.createConversation("conv-existing", "Current title", { userId: "current-user", projectDir: "current-dir" });
  const before = JSON.parse(await fs.readFile(filePath, "utf8"));
  before.conversations[0].updated_at = "2026-07-04T03:00:00.000Z";
  await fs.writeFile(filePath, JSON.stringify(before, null, 2));

  await target.migrateLegacySqliteSnapshot(legacyBuffer);

  const conversation = await target.getConversation("conv-existing");
  const messages = await target.listMessages("conv-existing");
  assert(messages.length === 1 && messages[0].content === "legacy prompt", "missing legacy message should be imported");
  assert(conversation.title === "Current title", "existing conversation title should stay current");
  assert(conversation.project_dir === "current-dir", "existing project_dir should stay current");
  assert(conversation.updated_at === "2026-07-04T03:00:00.000Z", "importing children should not reorder existing conversation");
});

await test("ProjectPersistence legacy migration is repeated and concurrent idempotent for child rows", async () => {
  const legacyDb = new SQL.Database();
  const legacy = createSqliteProjectPersistence({ sqliteDb: legacyDb, saveSqlite: () => {} });
  await legacy.initSchema();
  await legacy.createConversation("conv-race", "Race", { userId: "user-a" });
  await legacy.appendMessage("conv-race", { role: "user", content: "make it durable" });
  await legacy.appendMessage("conv-race", { role: "assistant", content: "working" });
  await legacy.saveConversationFiles("conv-race", "build-race", {
    "index.html": "<!doctype html>",
    "style.css": "body{}",
    "app.js": "console.log('race')",
    "hardware_app.py": "print('race')",
    "manifest.json": JSON.stringify({ id: "build-race", files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
  });
  const job = await legacy.createJob({ id: "job-race", type: "generate", conversationId: "conv-race", title: "Race", input: { prompt: "race" } });
  const legacyBuffer = Buffer.from(legacyDb.export());

  const filePath = fileURLToPath(new URL(`runtime/project-persistence-migrate-race-${Date.now()}-${Math.random()}.json`, new URL("..", import.meta.url)));
  const a = createFileProjectPersistence({ filePath });
  const b = createFileProjectPersistence({ filePath });
  await a.initSchema();
  await b.initSchema();

  await Promise.all([
    a.migrateLegacySqliteSnapshot(legacyBuffer),
    b.migrateLegacySqliteSnapshot(legacyBuffer),
  ]);
  await a.migrateLegacySqliteSnapshot(legacyBuffer);

  const state = JSON.parse(await fs.readFile(filePath, "utf8"));
  const messageRows = state.messages.filter(row => row.conversation_id === "conv-race");
  const fileRows = state.conversation_files.filter(row => row.conversation_id === "conv-race");
  const jobRows = state.jobs.filter(row => row.id === job.id);
  assert(messageRows.length === 2, "repeated/concurrent migration should not duplicate messages");
  assert(fileRows.length === 5, "repeated/concurrent migration should not duplicate files");
  assert(jobRows.length === 1, "repeated/concurrent migration should not duplicate jobs");
});

await test("ProjectPersistence legacy migration imports all legacy jobs", async () => {
  const legacyDb = new SQL.Database();
  const legacy = createSqliteProjectPersistence({ sqliteDb: legacyDb, saveSqlite: () => {} });
  await legacy.initSchema();
  await legacy.createConversation("conv-jobs", "Jobs", { userId: "user-a" });
  const expectedIds = [];
  for (let index = 0; index < 205; index += 1) {
    const job = await legacy.createJob({
      type: "generate",
      conversationId: "conv-jobs",
      title: `Legacy job ${index}`,
      input: { index },
    });
    expectedIds.push(job.id);
  }
  const legacyBuffer = Buffer.from(legacyDb.export());

  const filePath = fileURLToPath(new URL(`runtime/project-persistence-migrate-jobs-${Date.now()}-${Math.random()}.json`, new URL("..", import.meta.url)));
  const target = createFileProjectPersistence({ filePath });
  await target.initSchema();

  await target.migrateLegacySqliteSnapshot(legacyBuffer);

  const imported = await Promise.all(expectedIds.map(id => target.getJob(id)));
  assert(imported.every(Boolean), "migration should import jobs beyond the first listing page");
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
