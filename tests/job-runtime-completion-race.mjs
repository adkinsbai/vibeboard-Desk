import initSqlJs from "sql.js";

import { createJobRuntime } from "../src/jobRuntime.mjs";
import { createJobStore } from "../src/jobStore.mjs";
import { assert, delay } from "./support/serverHarness.mjs";

const SQL = await initSqlJs();
const store = createJobStore(new SQL.Database(), () => {});
store.initSchema();

store.appendLog = async (id, message, data = {}, phase = "") => {
  const snapshot = store.getJob(id);
  await delay(40);
  return store.transition(id, {
    status: snapshot.status,
    phase: phase || snapshot.phase,
    output: snapshot.output,
    logs: [...snapshot.logs, {
      ts: new Date().toISOString(),
      phase: phase || snapshot.phase,
      message,
      data,
    }],
  });
};

const runtime = createJobRuntime({
  jobStore: store,
  classifyError: error => ({ errorType: error?.errorType || "unknown" }),
});

runtime.register("generate", async (_input, ctx) => {
  await ctx.phase("done", "Generation finished.");
  return { ok: true, id: "build-race-proof" };
});

const completed = await runtime.runNow("generate", { prompt: "finish once" });
await delay(120);
const persisted = store.getJob(completed.id);

assert(persisted.status === "succeeded", `late job logs must not restore ${persisted.status}`);
assert(persisted.phase === "done", `completed job phase must stay done, got ${persisted.phase}`);
assert(persisted.output?.id === "build-race-proof", "late job logs must not clear completed output");
assert(persisted.logs.some(item => item.message === "Generation finished."), "completion log should be persisted");

console.log("job runtime completion/log ordering ok");
