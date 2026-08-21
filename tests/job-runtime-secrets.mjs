import initSqlJs from "sql.js";

import { createJobRuntime } from "../src/jobRuntime.mjs";
import { createJobStore } from "../src/jobStore.mjs";
import { assert, delay } from "./support/serverHarness.mjs";

const SQL = await initSqlJs();
const db = new SQL.Database();
const store = createJobStore(db, () => {});
store.initSchema();

const runtimeInputsSeen = [];
let executionCount = 0;
const runtime = createJobRuntime({ jobStore: store, classifyError: error => ({ errorType: error?.errorType || "unknown" }) });
runtime.register("agent", async input => {
  executionCount += 1;
  runtimeInputsSeen.push(input);
  await delay(30);
  return { ok: true };
});

const rawInput = {
  prompt: "Use the active browser key",
  apiKey: "api-key-should-stay-in-memory",
  accessToken: "access-token-should-stay-in-memory",
  password: "password-should-stay-in-memory",
  openai_api_key: "compound-api-key-should-stay-in-memory",
  connection_string: "compound-connection-should-stay-in-memory",
  ssh_password: "compound-password-should-stay-in-memory",
  max_tokens: 321,
  organization_id: "org-runtime",
  idempotency_key: "runtime-idempotency-key",
};
const job = await runtime.enqueue("agent", rawInput, { title: "Secret-safe job", persistedInput: rawInput });
const duplicate = await runtime.enqueue("agent", { ...rawInput, request_id: "retry-request" }, { title: "Secret-safe job", persistedInput: rawInput });
assert(duplicate.id === job.id, "runtime retries must return the existing idempotent job");
const synchronousDuplicate = await runtime.runNow("agent", { ...rawInput, request_id: "synchronous-retry" }, { title: "Secret-safe job", persistedInput: rawInput });
assert(synchronousDuplicate.id === job.id, "request-bound retries must return the existing idempotent job");

const concurrentInput = {
  prompt: "Concurrent request should execute once",
  organization_id: "org-runtime",
  idempotency_key: "runtime-concurrent-key",
};
const [concurrentFirst, concurrentSecond] = await Promise.all([
  runtime.runNow("agent", concurrentInput, { title: "Concurrent job", persistedInput: concurrentInput }),
  runtime.runNow("agent", { ...concurrentInput, request_id: "retry-request" }, { title: "Concurrent job", persistedInput: concurrentInput }),
]);
assert(concurrentFirst.id === concurrentSecond.id, "concurrent request-bound retries must return one job");

for (let attempt = 0; attempt < 30 && store.getJob(job.id)?.status !== "succeeded"; attempt += 1) {
  await delay(10);
}

const stored = store.getJob(job.id);
const secretRuntimeInput = runtimeInputsSeen.find(input => input.idempotency_key === rawInput.idempotency_key);
assert(secretRuntimeInput?.apiKey === rawInput.apiKey, "active execution should receive the runtime-only API key");
assert(secretRuntimeInput?.accessToken === rawInput.accessToken, "active execution should receive the runtime-only access token");
assert(secretRuntimeInput?.password === rawInput.password, "active execution should receive the runtime-only password");
assert(stored.input.apiKey === undefined, "persisted job input must not retain API keys");
assert(stored.input.accessToken === undefined, "persisted job input must not retain access tokens");
assert(stored.input.password === undefined, "persisted job input must not retain passwords");
assert(stored.input.openai_api_key === undefined, "persisted job input must not retain compound API key fields");
assert(stored.input.connection_string === undefined, "persisted job input must not retain connection strings");
assert(stored.input.ssh_password === undefined, "persisted job input must not retain compound password fields");
assert(stored.input.max_tokens === 321, "non-sensitive max_tokens must remain persisted");
assert(executionCount === 2, "idempotent retries must execute each distinct job once");

console.log("job runtime secret persistence boundary ok");
