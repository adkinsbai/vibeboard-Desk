import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { assert, findFreePort, stopChild, waitForServer } from "./support/serverHarness.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const port = await findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const logPath = fileURLToPath(new URL(`../runtime/database-outage-${port}.log`, import.meta.url));
const logFile = await fs.open(logPath, "w");

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    VERCEL: "1",
    VIBEBOARD_PUBLIC_DEPLOYMENT: "1",
    VIBEBOARD_BILLING_MODE: "free",
    VIBEBOARD_REQUIRE_PHONE_VERIFICATION: "0",
    VIBEBOARD_FORCE_OFFLINE: "1",
    VIBEBOARD_FORCE_REAL_BOARD: "0",
    VIBEBOARD_BOARD_PASSWORD: "",
    VIBEBOARD_IDENTITY_FILE: "",
    XFYUN_TTS_ENABLED: "0",
    VIBEBOARD_PORT: String(port),
    DATABASE_URL: "postgresql://user:pass@127.0.0.1:1/db",
    RENDER_RUNNER_REQUIRED: "false",
  },
  stdio: ["ignore", logFile.fd, logFile.fd],
  windowsHide: true,
});

try {
  await waitForServer(baseUrl, { path: "/api/health", timeoutMs: 8000 });

  const health = await getJson("/api/health");
  assert(health.ok === true, `health should stay up during database outage: ${JSON.stringify(health)}`);
  assert(health.database?.ok === false, `health should report database outage: ${JSON.stringify(health)}`);

  const boardCatalog = await raw("/api/board-catalog");
  assert(boardCatalog.status === 200, `database-independent catalog should keep working, got ${boardCatalog.status}`);

  const jobs = await raw("/api/jobs");
  assert(jobs.status === 503, `database-backed job API should return 503, got ${jobs.status}: ${JSON.stringify(jobs.data)}`);
  assert(/database/i.test(String(jobs.data?.error || "")), `503 should explain database outage: ${JSON.stringify(jobs.data)}`);
  assert(jobs.data?.errorType === "database_unavailable", `database outage should be structured, got ${JSON.stringify(jobs.data)}`);
  assert(jobs.data?.userTitle, `database outage should include a user title: ${JSON.stringify(jobs.data)}`);
  assert(Array.isArray(jobs.data?.nextActions) && jobs.data.nextActions.length > 0, `database outage should include next actions: ${JSON.stringify(jobs.data)}`);
} finally {
  await stopChild(child);
  await logFile.close();
  await fs.rm(logPath, { force: true }).catch(() => {});
}

console.log("database outage startup ok");

async function getJson(path) {
  const result = await raw(path);
  assert(result.response.ok, `${path} should return ok HTTP, got ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function raw(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
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
