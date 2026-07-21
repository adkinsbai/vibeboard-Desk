import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createIflytekSpeechClient } from "../src/iflytekSpeech.mjs";
import { findFreePort, stopChild, waitForServer } from "../tests/support/serverHarness.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REQUIRED_SPEECH_ENV = ["IFLYTEK_APP_ID", "IFLYTEK_API_KEY", "IFLYTEK_API_SECRET"];
const ALLOWED_EXPRESSIONS = new Set([
  "idle", "listening", "thinking", "speaking", "warm", "curious", "happy",
  "tired", "confused", "lonely", "angry", "error", "sleeping", "away",
]);

function requireAuthorization() {
  if (process.env.VIBEBOARD_RUN_LIVE_SPEECH !== "1") {
    throw safeError("live_speech_not_authorized", "Set VIBEBOARD_RUN_LIVE_SPEECH=1 to authorize one paid live speech verification run.");
  }
  for (const name of REQUIRED_SPEECH_ENV) {
    if (!process.env[name]) throw safeError("live_speech_missing_configuration", `Missing ${name}.`);
  }
}

function safeError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function elapsed(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", accept: "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw safeError(body.error || `http_${response.status}`);
  return body;
}

function finalExpression(response = {}) {
  const value = response.mind?.expression
    || response.state?.mind?.expression
    || response.state?.expression
    || response.state?.mood
    || "idle";
  return ALLOWED_EXPRESSIONS.has(value) ? value : "idle";
}

function containsAnySecret(value, secrets) {
  const text = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""), "utf8");
  return secrets.some(secret => secret && text.includes(Buffer.from(secret, "utf8")));
}

async function scanTrackedSource(secrets) {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  for (const relative of output.split("\0").filter(Boolean)) {
    const absolute = path.join(ROOT, relative);
    const content = await fs.readFile(absolute).catch(() => null);
    if (content && containsAnySecret(content, secrets)) throw safeError("secret_found_in_source");
  }
}

async function main() {
  requireAuthorization();
  const secrets = REQUIRED_SPEECH_ENV.map(name => process.env[name]).filter(Boolean);
  if (process.env.VIBEBOARD_LLM_API_KEY) secrets.push(process.env.VIBEBOARD_LLM_API_KEY);

  const report = {
    ok: false,
    speech: { tts_raw: false, iat: false, tts_http: false },
    dialogue: false,
    expression: "",
    latency_ms: {},
    secret_scan: "not_run",
    llm_mode: "",
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vibeboard-speech-live-"));
  const dbPath = path.join(tempRoot, "acceptance.db");
  const generatedDir = path.join(tempRoot, "generated");
  const projectsDir = path.join(tempRoot, "projects");
  const runtimeDir = path.join(tempRoot, "runtime");
  await Promise.all([generatedDir, projectsDir, runtimeDir].map(directory => fs.mkdir(directory, { recursive: true })));

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logChunks = [];
  let child = null;
  let browser = null;
  const requestEvidence = [];
  let browserStorage = "";

  try {
    const client = createIflytekSpeechClient({ env: process.env, timeoutMs: 30000 });
    const rawStarted = Date.now();
    const rawSpeech = await client.synthesize({ text: "你好，今天我们慢一点。", encoding: "raw" });
    report.latency_ms.tts_raw = elapsed(rawStarted);
    if (!rawSpeech.audio?.byteLength) throw safeError("live_tts_empty_audio");
    report.speech.tts_raw = true;

    const iatStarted = Date.now();
    const recognition = await client.transcribe({ audio: rawSpeech.audio, sampleRate: 16000, language: "zh_cn" });
    report.latency_ms.iat = elapsed(iatStarted);
    if (!recognition.transcript?.trim()) throw safeError("live_iat_empty_transcript");
    report.speech.iat = true;

    child = spawn(process.execPath, ["server.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        VIBEBOARD_PORT: String(port),
        VIBEBOARD_DB_PATH: dbPath,
        VIBEBOARD_GENERATED_DIR: generatedDir,
        VIBEBOARD_PROJECTS_DIR: projectsDir,
        VIBEBOARD_RUNTIME_DIR: runtimeDir,
        VIBEBOARD_FORCE_OFFLINE: "0",
        DIGITAL_LIFE_AUTOSTART: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const collectLog = chunk => {
      if (logChunks.reduce((sum, item) => sum + item.length, 0) < 2 * 1024 * 1024) logChunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collectLog);
    child.stderr.on("data", collectLog);
    await waitForServer(baseUrl, { path: "/api/health", timeoutMs: 20000 });

    const status = await jsonRequest(baseUrl, "/api/digital-life/speech/status");
    if (!status.configured || !status.transcription || !status.synthesis) throw safeError("live_speech_status_unconfigured");

    const dialogueStarted = Date.now();
    const dialogue = await jsonRequest(baseUrl, "/api/digital-life/message", {
      method: "POST",
      body: JSON.stringify({ conversation_id: "live-speech-acceptance", content: recognition.transcript.trim() }),
    });
    report.latency_ms.dialogue = elapsed(dialogueStarted);
    if (!dialogue.assistant_message?.content) throw safeError("live_dialogue_empty_reply");
    if (process.env.VIBEBOARD_REQUIRE_LLM === "1" && dialogue.mode === "offline_mock") throw safeError("live_llm_fallback_not_allowed");
    report.dialogue = true;
    report.llm_mode = dialogue.mode || "unknown";
    report.expression = finalExpression(dialogue);

    const ttsStarted = Date.now();
    const spoken = await jsonRequest(baseUrl, "/api/digital-life/speech/synthesize", {
      method: "POST",
      body: JSON.stringify({ text: dialogue.assistant_message.content }),
    });
    report.latency_ms.tts_http = elapsed(ttsStarted);
    if (Buffer.from(spoken.audio_base64 || "", "base64").byteLength <= 100) throw safeError("live_tts_http_empty_audio");
    report.speech.tts_http = true;

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
    page.on("request", request => {
      if (request.url().includes("/api/digital-life/")) requestEvidence.push(`${request.method()} ${request.url()} ${request.postData() || ""}`);
    });
    await page.goto(`${baseUrl}/market-apps/vb-digital-life-companion-demo/index.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.DigitalLifeDeviceSimulator?.getState().connection_mode === "online");
    browserStorage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));

    await scanTrackedSource(secrets);
    const databaseBytes = await fs.readFile(dbPath).catch(() => Buffer.alloc(0));
    const logBytes = Buffer.concat(logChunks);
    if (containsAnySecret(databaseBytes, secrets)) throw safeError("secret_found_in_database");
    if (containsAnySecret(logBytes, secrets)) throw safeError("secret_found_in_logs");
    if (containsAnySecret(browserStorage, secrets)) throw safeError("secret_found_in_browser_storage");
    if (containsAnySecret(requestEvidence.join("\n"), secrets)) throw safeError("secret_found_in_browser_request");
    if (requestEvidence.some(value => /[?&]authorization=|wss:\/\//i.test(value))) throw safeError("signed_url_found_in_browser_request");
    report.secret_scan = "clean";
    report.latency_ms.total = Object.values(report.latency_ms).reduce((sum, value) => sum + Number(value || 0), 0);
    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close().catch(() => {});
    await stopChild(child).catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  console.error(error?.message || "live speech verification failed");
  process.exitCode = 1;
}
