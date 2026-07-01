import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { assert, delay, waitForServer } from "./support/serverHarness.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNTIME_ROOT = fileURLToPath(new URL("../runtime/", import.meta.url));
const PHONE = `+1555${String(Math.floor(Math.random() * 1000000)).padStart(6, "0")}`;
const PASSWORD = "correct-horse-42";
const TITLE = `Production Persistence ${randomUUID().slice(0, 8)}`;
const snapshotPath = fileURLToPath(new URL(`../runtime/prod-persist-${randomUUID()}.db`, import.meta.url));
const KEEP_SNAPSHOT = process.env.VIBEBOARD_KEEP_PROD_PERSIST_SNAPSHOT === "1";
await fs.rm(snapshotPath, { force: true }).catch(() => {});

let cookie = "";
let conversationId = "";
let jobId = "";

const first = await startServer(await findFreePort());
try {
  const baseUrl = `http://127.0.0.1:${first.port}`;
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
      type: "deploy",
      payload: { conversation_id: conversationId, background: true },
    }),
  });
  assert(job.status === 202, `job create should succeed, got ${job.status}: ${JSON.stringify(job.data)}`);
  jobId = job.data.job?.id || "";
  assert(jobId, "job create should return a job id");
  const jobs = await getJson(baseUrl, "/api/jobs", cookie);
  assert(jobs.jobs.some(item => item.id === jobId), "created job should be listed before restart");

  const snapshotStat = await fs.stat(snapshotPath).catch(() => null);
  assert(snapshotStat?.size > 0, "cloud sqlite snapshot should be saved before the create response returns");
} finally {
  await stopChild(first.child);
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
}

console.log(JSON.stringify({ ok: true, conversationId, jobId, title: TITLE, snapshotPath: KEEP_SNAPSHOT ? snapshotPath : undefined }, null, 2));

async function startServer(port) {
  await fs.mkdir(RUNTIME_ROOT, { recursive: true });
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      VERCEL: "1",
      VIBEBOARD_PUBLIC_DEPLOYMENT: "1",
      VIBEBOARD_BILLING_MODE: "free",
      VIBEBOARD_REQUIRE_PHONE_VERIFICATION: "0",
      VIBEBOARD_ADMIN_PHONES: PHONE,
      VIBEBOARD_FORCE_OFFLINE: "1",
      VIBEBOARD_FORCE_REAL_BOARD: "0",
      VIBEBOARD_BOARD_PASSWORD: "",
      VIBEBOARD_IDENTITY_FILE: "",
      XFYUN_TTS_ENABLED: "0",
      VIBEBOARD_PORT: String(port),
      DATABASE_URL: "postgresql://user:pass@example.test/db",
      VIBEBOARD_TEST_CLOUD_SQLITE_FILE: snapshotPath,
      VIBEBOARD_LLM_PROVIDER: "deepseek",
      VIBEBOARD_LLM_BASE_URL: "https://api.deepseek.com",
      VIBEBOARD_LLM_MODEL: "deepseek-v4-flash",
      VIBEBOARD_LLM_API_KEY: "test-key",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  return { child, port };
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
