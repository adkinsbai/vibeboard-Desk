import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const ROOT_URL = new URL("../..", import.meta.url);
const RUNTIME_URL = new URL("runtime/", ROOT_URL);

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForServer(baseUrl, { timeoutMs = 15000, path = "/api/status" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
      if (response.ok) return;
      lastError = new Error(`${path} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError || new Error(`Timed out waiting for ${baseUrl}`);
}

export async function withServer(fn, options = {}) {
  const externalBaseUrl = options.baseUrl ?? process.env.VIBEBOARD_TEST_BASE_URL ?? "";
  if (externalBaseUrl) {
    await waitForServer(externalBaseUrl, options.wait || {});
    return fn(createServerClient(externalBaseUrl, "external"));
  }

  const port = await findFreePort();
  const baseUrl = `http://${HOST}:${port}`;
  const dbPrefix = options.dbPrefix || "vibeboard-test";
  const dbPath = new URL(`${dbPrefix}-${randomUUID()}.db`, RUNTIME_URL);
  const generatedDir = new URL(`${dbPrefix}-${randomUUID()}-generated/`, RUNTIME_URL);
  const projectsDir = new URL(`${dbPrefix}-${randomUUID()}-projects/`, RUNTIME_URL);
  const runtimeDir = new URL(`${dbPrefix}-${randomUUID()}-runtime/`, RUNTIME_URL);
  const previewsDir = new URL(`${dbPrefix}-${randomUUID()}-previews/`, RUNTIME_URL);
  await fs.mkdir(RUNTIME_URL, { recursive: true });
  await fs.mkdir(generatedDir, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(previewsDir, { recursive: true });

  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT_URL,
    env: {
      ...process.env,
      ...offlineEnv(),
      ...(options.env || {}),
      VIBEBOARD_PORT: String(port),
      VIBEBOARD_DB_PATH: fileURLToPath(dbPath),
      VIBEBOARD_GENERATED_DIR: fileURLToPath(generatedDir),
      VIBEBOARD_PROJECTS_DIR: fileURLToPath(projectsDir),
      VIBEBOARD_RUNTIME_DIR: fileURLToPath(runtimeDir),
      VIBEBOARD_PREVIEWS_DIR: fileURLToPath(previewsDir),
    },
    stdio: options.stdio || "ignore",
    windowsHide: true,
  });

  try {
    await waitForServer(baseUrl, options.wait || {});
    return await fn(createServerClient(baseUrl, "spawned", { dbPath: fileURLToPath(dbPath) }));
  } finally {
    await stopChild(child);
    await fs.rm(dbPath, { force: true }).catch(() => {});
    await fs.rm(generatedDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(projectsDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(previewsDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function createServerClient(baseUrl, serverMode = "external", metadata = {}) {
  return {
    baseUrl,
    serverMode,
    ...metadata,
    json: (path, options = {}) => jsonFetch(baseUrl, path, options),
    text: (path, options = {}) => textFetch(baseUrl, path, options),
  };
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise(resolve => child.once("close", resolve));
  child.kill();
  await Promise.race([closed, delay(2000)]);
}

export async function jsonFetch(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "content-type": "application/json",
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
    throw new Error(`${path} returned non-JSON HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    const detail = data?.error ? ` (${data.error})` : `: ${JSON.stringify(data)}`;
    throw new Error(`${path} returned HTTP ${response.status}${detail}`);
  }
  return data;
}

export async function textFetch(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return text;
}

function offlineEnv() {
  return {
    VIBEBOARD_FORCE_OFFLINE: "1",
    VIBEBOARD_ALLOW_OFFLINE_GENERATION: "1",
    VIBEBOARD_TEST_MODE: "1",
    VIBEBOARD_FORCE_REAL_BOARD: "0",
    VIBEBOARD_BOARD_PASSWORD: "",
    VIBEBOARD_IDENTITY_FILE: "",
    XFYUN_TTS_ENABLED: "0",
  };
}
