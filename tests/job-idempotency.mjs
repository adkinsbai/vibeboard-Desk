import initSqlJs from "sql.js";

import { assert } from "./support/serverHarness.mjs";
import { createJobRuntime } from "../src/jobRuntime.mjs";
import { createSqliteProjectPersistence } from "../src/projectPersistence.mjs";

const SQL = await initSqlJs();

await test("job runtime returns an existing job for the same conversation action and client_run_id", async () => {
  const db = new SQL.Database();
  let counter = 0;
  const persistence = createSqliteProjectPersistence({
    sqliteDb: db,
    saveSqlite: () => {},
    jobOptions: { idFactory: () => `job-${++counter}` },
  });
  await persistence.initSchema();

  let runs = 0;
  const runtime = createJobRuntime({
    jobStore: persistence,
    classifyError: error => ({ errorType: error?.errorType || "unknown", retryable: true }),
  });
  runtime.register("generate", async body => {
    runs += 1;
    return { ok: true, id: `build-${runs}`, prompt: body.prompt };
  });

  const input = {
    prompt: "paid slack calculator",
    action: "confirm_build",
    client_run_id: "run-fixed",
  };
  const first = await runtime.runNow("generate", input, {
    conversationId: "conv-idem",
    title: "Generate paid slack calculator",
  });
  const second = await runtime.runNow("generate", input, {
    conversationId: "conv-idem",
    title: "Generate paid slack calculator",
  });
  const jobs = await persistence.listJobs({ conversationId: "conv-idem" });

  assert(first.id === second.id, "same client_run_id should return the existing job id");
  assert(runs === 1, `handler should run once for duplicate client_run_id, got ${runs}`);
  assert(jobs.length === 1, `only one job should be stored for duplicate client_run_id, got ${jobs.length}`);
});

await test("job idempotency is scoped by conversation, action, type, and user", async () => {
  const db = new SQL.Database();
  let counter = 0;
  const persistence = createSqliteProjectPersistence({
    sqliteDb: db,
    saveSqlite: () => {},
    jobOptions: { idFactory: () => `job-scope-${++counter}` },
  });
  await persistence.initSchema();

  let runs = 0;
  const runtime = createJobRuntime({
    jobStore: persistence,
    classifyError: error => ({ errorType: error?.errorType || "unknown", retryable: true }),
  });
  runtime.register("generate", async () => {
    runs += 1;
    return { ok: true, id: `build-scope-${runs}` };
  });

  const base = { prompt: "edit", client_run_id: "same-run", user_id: "user-a" };
  const first = await runtime.runNow("generate", { ...base, action: "confirm_build" }, { conversationId: "conv-a" });
  const same = await runtime.runNow("generate", { ...base, action: "confirm_build" }, { conversationId: "conv-a" });
  const differentAction = await runtime.runNow("generate", { ...base, action: "continue_edit" }, { conversationId: "conv-a" });
  const differentConversation = await runtime.runNow("generate", { ...base, action: "confirm_build" }, { conversationId: "conv-b" });
  const differentUser = await runtime.runNow("generate", { ...base, user_id: "user-b", action: "confirm_build" }, { conversationId: "conv-a" });

  assert(first.id === same.id, "same idempotency scope should reuse the first job");
  assert(new Set([first.id, differentAction.id, differentConversation.id, differentUser.id]).size === 4, "different scopes should create separate jobs");
  assert(runs === 4, `handler should run once per unique scope, got ${runs}`);
});

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
