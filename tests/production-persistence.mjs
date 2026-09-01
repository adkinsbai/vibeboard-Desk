import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, delay, waitForServer } from "./support/serverHarness.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNTIME_ROOT = fileURLToPath(new URL("../runtime/", import.meta.url));
const PHONE = `+1555${String(Math.floor(Math.random() * 1000000)).padStart(6, "0")}`;
const PASSWORD = "correct-horse-42";
const TITLE = `Production Persistence ${randomUUID().slice(0, 8)}`;
const snapshotPath = fileURLToPath(new URL(`../runtime/prod-persist-${randomUUID()}.db`, import.meta.url));
const projectPersistencePath = fileURLToPath(new URL(`../runtime/prod-project-persistence-${randomUUID()}.json`, import.meta.url));
const KEEP_SNAPSHOT = process.env.VIBEBOARD_KEEP_PROD_PERSIST_SNAPSHOT === "1";
await fs.rm(snapshotPath, { force: true }).catch(() => {});
await fs.rm(projectPersistencePath, { force: true }).catch(() => {});

const serverSource = await fs.readFile(path.join(ROOT, "server.mjs"), "utf8");
assert(
  /function shouldSaveSqliteSnapshot\(\)\s*{[\s\S]*?PUBLIC_DEPLOYMENT\s*&&\s*!TEST_CLOUD_SQLITE_FILE[\s\S]*?return false[\s\S]*?}/.test(serverSource),
  "server should disable legacy sqlite_snapshots writes in public production without VIBEBOARD_TEST_CLOUD_SQLITE_FILE"
);
assert(
  /const\s+shouldSaveCloudSnapshot\s*=\s*dbBootstrapComplete\s*&&\s*shouldSaveSqliteSnapshot\(\)/.test(serverSource) &&
  /if\s*\(\s*shouldSaveCloudSnapshot\s*\)\s*{[\s\S]*?cloudSqliteSnapshot\.save\(buffer\)/.test(serverSource),
  "saveDb should decide cloud snapshot writes when the save is queued"
);
assert(
  /const\s+localDbBuffer\s*=\s*cloudSqliteSnapshot\s*[\r\n\s]*\?\s*null\s*[\r\n\s]*:\s*await\s+fs\.readFile\(DB_PATH\)/.test(serverSource),
  "server should not fall back to a stale local Vercel sqlite file when a cloud snapshot source is configured"
);
assert(
  !/createDigitalLife(?:Store|Routes)\b/.test(serverSource) && !/\/api\/digital-life/.test(serverSource),
  "platform server should not mount the legacy companion as a built-in route or hidden runtime"
);

const defaultVercel = await startServer(await findFreePort(), {
  VIBEBOARD_GENERATED_DIR: undefined,
  VIBEBOARD_RUNTIME_DIR: undefined,
  VIBEBOARD_PREVIEWS_DIR: undefined,
});
try {
  const baseUrl = `http://127.0.0.1:${defaultVercel.port}`;
  await waitForServer(baseUrl, { path: "/api/health" });
  const register = await raw(baseUrl, "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: `+1555${String(Math.floor(Math.random() * 1000000)).padStart(6, "0")}`, password: PASSWORD }),
  });
  assert(register.status === 200, `default Vercel register should succeed, got ${register.status}: ${JSON.stringify(register.data)}`);
  const defaultCookie = cookieFrom(register.response);
  const created = await raw(baseUrl, "/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: defaultCookie },
    body: JSON.stringify({ title: "Default Vercel Writable Dirs" }),
  });
  assert(created.status === 200, `default Vercel conversation create should succeed, got ${created.status}: ${JSON.stringify(created.data)}`);
  assert(
    path.resolve(created.data.projects_root || "").startsWith(path.resolve(os.tmpdir())),
    `Vercel project workspace should default to tmp, got ${created.data.projects_root}`
  );
} finally {
  await stopChild(defaultVercel.child);
}

let cookie = "";
let conversationId = "";
let jobId = "";

const stale = await startServer(await findFreePort());
const first = await startServer(await findFreePort());
try {
  const baseUrl = `http://127.0.0.1:${first.port}`;
  await waitForServer(`http://127.0.0.1:${stale.port}`, { path: "/api/health" });
  await waitForServer(baseUrl, { path: "/api/health" });
  const register = await raw(baseUrl, "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: PHONE, password: PASSWORD }),
  });
  assert(register.status === 200, `register should succeed, got ${register.status}: ${JSON.stringify(register.data)}`);
  cookie = cookieFrom(register.response);
  assert(cookie, "register should set a session cookie");

  const created = await raw(baseUrl, "/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: TITLE }),
  });
  assert(created.status === 200, `conversation create should succeed, got ${created.status}: ${JSON.stringify(created.data)}`);
  conversationId = created.data.id;
  assert(conversationId, "conversation create should return an id");
  assert(created.data.project_dir.includes("VibeBoard Projects"), "production project workspace should still be created");

  const listed = await getJson(baseUrl, "/api/conversations", cookie);
  assert(listed.conversations.some(item => item.id === conversationId), "created conversation should be listed before restart");

  const message = await raw(baseUrl, `/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ role: "user", content: "keep this message after restart" }),
  });
  assert(message.status === 200, `message save should succeed, got ${message.status}: ${JSON.stringify(message.data)}`);

  const job = await raw(baseUrl, "/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      type: "generate",
      payload: {
        prompt: "persisted request-bound job",
        conversation_id: conversationId,
        background: true,
        generation_mode: "offline-simulated",
        modelSettings: { enabled: false },
      },
    }),
  });
  assert(job.status === 202, `public background job should be accepted asynchronously, got ${job.status}: ${JSON.stringify(job.data)}`);
  jobId = job.data.job?.id || "";
  assert(jobId, "job create should return a job id");
  const completedJob = await waitForJob(baseUrl, jobId, cookie);
  assert(completedJob.status === "succeeded", `background job should succeed, got ${JSON.stringify(completedJob)}`);
  const files = await getJson(baseUrl, `/api/conversations/${conversationId}/files`, cookie);
  assert(files.buildId === completedJob.output.id, `conversation files should persist after public job: ${JSON.stringify(files)}`);
  assert(files.files?.["index.html"], "conversation files should include index.html after public job");
  const projectPersistenceState = JSON.parse(await fs.readFile(projectPersistencePath, "utf8"));
  assert(
    projectPersistenceState.conversation_files?.some(item => item.conversation_id === conversationId && item.filename === "index.html"),
    `conversation files should persist through ProjectPersistence file adapter: ${JSON.stringify(projectPersistenceState.conversation_files)}`
  );
  const jobs = await getJson(baseUrl, "/api/jobs", cookie);
  assert(jobs.jobs.some(item => item.id === jobId), "created job should be listed before restart");

  const snapshotStat = await fs.stat(snapshotPath).catch(() => null);
  assert(snapshotStat?.size > 0, "cloud sqlite snapshot should be saved before the create response returns");

  const staleBaseUrl = `http://127.0.0.1:${stale.port}`;
  const staleLogin = await raw(staleBaseUrl, "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: PHONE, password: PASSWORD }),
  });
  assert(staleLogin.status === 200, `login on already-warm instance should succeed, got ${staleLogin.status}: ${JSON.stringify(staleLogin.data)}`);
  const staleCookie = cookieFrom(staleLogin.response);
  const staleListed = await getJson(staleBaseUrl, "/api/conversations", staleCookie);
  assert(
    staleListed.conversations.some(item => item.id === conversationId),
    `already-warm instance should load the newest cloud sqlite snapshot before reading conversations: ${JSON.stringify(staleListed.conversations)}`
  );
  const staleMessages = await getJson(staleBaseUrl, `/api/conversations/${conversationId}/messages`, staleCookie);
  assert(
    staleMessages.messages.some(item => item.content === "keep this message after restart"),
    `already-warm instance should load the newest cloud sqlite snapshot before reading messages: ${JSON.stringify(staleMessages.messages)}`
  );
} finally {
  await stopChild(first.child);
  await stopChild(stale.child);
}

const second = await startServer(await findFreePort());
try {
  const baseUrl = `http://127.0.0.1:${second.port}`;
  await waitForServer(baseUrl, { path: "/api/health" });
  const login = await raw(baseUrl, "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: PHONE, password: PASSWORD }),
  });
  assert(login.status === 200, `login after restart should succeed, got ${login.status}: ${JSON.stringify(login.data)}`);
  const nextCookie = cookieFrom(login.response);
  const listed = await getJson(baseUrl, "/api/conversations", nextCookie);
  assert(
    listed.conversations.some(item => item.id === conversationId),
    `created conversation should survive a Vercel-style restart through the cloud sqlite snapshot: ${JSON.stringify(listed.conversations)}`
  );
  const messages = await getJson(baseUrl, `/api/conversations/${conversationId}/messages`, nextCookie);
  assert(
    messages.messages.some(item => item.content === "keep this message after restart"),
    `conversation messages should survive a Vercel-style restart: ${JSON.stringify(messages.messages)}`
  );
  const jobs = await getJson(baseUrl, "/api/jobs", nextCookie);
  assert(
    jobs.jobs.some(item => item.id === jobId),
    `background jobs should survive a Vercel-style restart: ${JSON.stringify(jobs.jobs)}`
  );
} finally {
  await stopChild(second.child);
  if (!KEEP_SNAPSHOT) {
    await fs.rm(snapshotPath, { force: true }).catch(() => {});
  }
  await fs.rm(projectPersistencePath, { force: true }).catch(() => {});
}

console.log(JSON.stringify({ ok: true, conversationId, jobId, title: TITLE, snapshotPath: KEEP_SNAPSHOT ? snapshotPath : undefined }, null, 2));

async function startServer(port, envOverrides = {}) {
  await fs.mkdir(RUNTIME_ROOT, { recursive: true });
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: removeUndefined({
      ...process.env,
      VERCEL: "1",
      VIBEBOARD_PUBLIC_DEPLOYMENT: "1",
      VIBEBOARD_BILLING_MODE: "free",
      VIBEBOARD_REQUIRE_PHONE_VERIFICATION: "0",
      VIBEBOARD_ADMIN_PHONES: PHONE,
      VIBEBOARD_FORCE_OFFLINE: "1",
      VIBEBOARD_ALLOW_OFFLINE_GENERATION: "1",
      VIBEBOARD_TEST_MODE: "1",
      VIBEBOARD_FORCE_REAL_BOARD: "0",
      VIBEBOARD_BOARD_PASSWORD: "",
      VIBEBOARD_IDENTITY_FILE: "",
      XFYUN_TTS_ENABLED: "0",
      VIBEBOARD_PORT: String(port),
      DATABASE_URL: "postgresql://user:pass@example.test/db",
      VIBEBOARD_TEST_CLOUD_SQLITE_FILE: snapshotPath,
      VIBEBOARD_TEST_PROJECT_PERSISTENCE_FILE: projectPersistencePath,
      VIBEBOARD_LLM_PROVIDER: "deepseek",
      VIBEBOARD_LLM_BASE_URL: "https://api.deepseek.com",
      VIBEBOARD_LLM_MODEL: "deepseek-v4-flash",
      VIBEBOARD_LLM_API_KEY: "test-key",
      RENDER_RUNNER_REQUIRED: "false",
      ...envOverrides,
    }),
    stdio: "ignore",
    windowsHide: true,
  });
  return { child, port };
}

function removeUndefined(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise(resolve => child.once("close", resolve));
  child.kill();
  await Promise.race([closed, delay(2000)]);
}

async function getJson(baseUrl, targetPath, cookie = "") {
  const result = await raw(baseUrl, targetPath, { headers: cookie ? { cookie } : {} });
  assert(result.response.ok, `${targetPath} should return ok HTTP, got ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function waitForJob(baseUrl, id, cookie = "") {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await getJson(baseUrl, `/api/jobs/${encodeURIComponent(id)}`, cookie);
    if (["succeeded", "failed", "canceled"].includes(job.job?.status)) return job.job;
    await delay(100);
  }
  throw new Error(`job ${id} did not finish before the persistence test timeout`);
}

async function raw(baseUrl, targetPath, options = {}) {
  const response = await fetch(`${baseUrl}${targetPath}`, {
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { response, status: response.status, data };
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}
