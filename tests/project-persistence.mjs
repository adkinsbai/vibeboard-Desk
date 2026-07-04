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
