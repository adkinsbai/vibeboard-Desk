import http from "node:http";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import initSqlJs from "sql.js";
import {
  boardEndpoints,
  createBoardConfig,
  deviceIdFrom,
  endpointLabel,
  publicBoardConfig as makePublicBoardConfig,
  publicDeviceProfiles
} from "./src/devices.mjs";
import {
  GENERATED_FILE_NAMES,
  loadStaticMarketApps as loadStaticMarketAppsFromDir,
  mergeMarketApps,
  readStaticMarketCode as readStaticMarketCodeFromDir
} from "./src/marketCatalog.mjs";
import { createConversationStore, normalizeProjectMemory } from "./src/conversationStore.mjs";
import { runAgent } from "./src/agent.mjs";
import { chatCompletionsUrl, normalizeModelSettings } from "./src/modelSettings.mjs";
import { createMemoryStore } from "./src/memoryStore.mjs";
import { createExperienceStore, makePlaybookCandidate } from "./src/experienceStore.mjs";
import { createPlaybookStore } from "./src/playbookStore.mjs";
import { verifyAllLocal } from "./src/verifiers/index.mjs";
import { analyzeAndClarify, buildRefinedPrompt } from "./src/clarifyEngine.mjs";
import { planChatWithModel } from "./src/chatPlanner.mjs";
import {
  assertFileContracts,
  validationRulesText
} from "./src/contracts.mjs";
import {
  AGENT_PHASES,
  appendEvidence,
  buildInitialSpec,
  createAgentRun,
  formatRunEvidence,
  transitionRun
} from "./src/agentStateMachine.mjs";
import {
  buildGoldenLoopResult,
  buildGoldenLoopRemoteCommand,
  parseGoldenLoopSections
} from "./src/goldenLoop.mjs";
import {
  buildDeployPaths,
  buildDeployRemoteCommand,
  buildDeployUploadEntries,
  buildPostDeployVerificationFailure,
  parseDeployOutput
} from "./src/deskDeployer.mjs";
import {
  buildCompileManifest,
  ensureGeneratedWorkspace,
  loadGeneratedWorkspace,
  readGeneratedFiles,
  writeGeneratedFiles,
  withAssetVersion
} from "./src/buildArtifact.mjs";
import {
  buildUploadBundleCommand,
  buildUploadTextCommand,
  buildUploadTextPayload,
  execOpenSsh,
  execPasswordSsh,
  execWslSsh,
  runAcrossEndpoints
} from "./src/remoteRunner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const GENERATED_DIR = path.join(ROOT, "generated", "current");
const PREVIEWS_DIR = path.join(ROOT, "previews");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const SERVER_LOG_PATH = path.join(RUNTIME_DIR, "server.log");
const SERVER_LOG_STRING_LIMIT = 600;
const SERVER_LOG_ARRAY_LIMIT = 20;
const MARKET_APPS_DIR = path.join(ROOT, "market-apps");
const PORT = Number(process.env.VIBEBOARD_PORT || 8789);
const DB_PATH = path.join(ROOT, "vibeboard.db");
const DEFAULT_GENERATE_AGENT_MAX_ITERATIONS = 18;
const DEFAULT_GENERATE_AGENT_MAX_VERIFICATION_ATTEMPTS = 1;
const DEFAULT_GENERATE_AGENT_TIMEOUT_MS = 120000;
const DEFAULT_GENERATE_AGENT_LLM_TIMEOUT_MS = 60000;

// Initialize SQLite database
const SQL = await initSqlJs();
let db;
try {
  const dbBuffer = await fs.readFile(DB_PATH).catch(() => null);
  db = dbBuffer ? new SQL.Database(dbBuffer) : new SQL.Database();
} catch {
  db = new SQL.Database();
}

db.run(`
  CREATE TABLE IF NOT EXISTS market_apps (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    name TEXT NOT NULL,
    description TEXT,
    code TEXT,
    preview_url TEXT,
    author TEXT DEFAULT 'anonymous',
    downloads INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  )
`);

// Helper to save database to file
async function saveDb() {
  const data = db.export();
  await fs.writeFile(DB_PATH, Buffer.from(data));
}

// Helper to run query and return results
function query(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// Helper to run insert/update/delete
function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

const conversationStore = createConversationStore(db, saveDb);
conversationStore.initSchema();

const memoryStore = createMemoryStore(db, saveDb);
memoryStore.initSchema();

const experienceStore = createExperienceStore(db, saveDb);
experienceStore.initSchema();

const playbookStore = createPlaybookStore(db, saveDb);
playbookStore.initSchema();

let BOARD = createBoardConfig();
let knownHosts = process.env.VIBEBOARD_KNOWN_HOSTS || path.join(os.tmpdir(), `${BOARD.id}_known_hosts`);
const identityFile = process.env.VIBEBOARD_IDENTITY_FILE || path.join(os.homedir(), ".ssh", "id_ed25519");
let boardPassword = process.env.VIBEBOARD_BOARD_PASSWORD || "";
const PYTHON_BIN = process.env.VIBEBOARD_PYTHON || (process.platform === "win32" ? "python" : "python3");

let currentBuild = null;
let activeEndpoint = null;
let lastDeploy = null;
const boardStatusCache = new Map();
const boardStatusRefreshPromises = new Map();
let deviceContextQueue = Promise.resolve();
let deployQueue = Promise.resolve();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function compactForLog(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > SERVER_LOG_STRING_LIMIT
      ? `${value.slice(0, SERVER_LOG_STRING_LIMIT)}... [truncated ${value.length - SERVER_LOG_STRING_LIMIT} chars]`
      : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, SERVER_LOG_ARRAY_LIMIT).map(item => compactForLog(item, depth + 1));
    if (value.length > SERVER_LOG_ARRAY_LIMIT) items.push(`... [truncated ${value.length - SERVER_LOG_ARRAY_LIMIT} items]`);
    return items;
  }
  if (typeof value === "object") {
    if (depth >= 2) {
      const keys = Object.keys(value);
      return { _type: "object", keys: keys.slice(0, SERVER_LOG_ARRAY_LIMIT), truncated: Math.max(0, keys.length - SERVER_LOG_ARRAY_LIMIT) };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, compactForLog(item, depth + 1)])
    );
  }
  return String(value);
}

async function appendServerLog(event, detail = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...compactForLog(detail),
  });
  try {
    await fs.mkdir(RUNTIME_DIR, { recursive: true });
    await fs.appendFile(SERVER_LOG_PATH, `${line}\n`, "utf8");
  } catch {}
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function loadStaticMarketApps() {
  return loadStaticMarketAppsFromDir(MARKET_APPS_DIR, GENERATED_FILE_NAMES);
}

function readStaticMarketCode(appId) {
  return readStaticMarketCodeFromDir(MARKET_APPS_DIR, appId, GENERATED_FILE_NAMES);
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length
  });
  res.end(body);
}

function staticCacheFor(filePath) {
  const relative = path.relative(ROOT, filePath).replaceAll(path.sep, "/");
  const ext = path.extname(filePath).toLowerCase();
  if (relative === "index.html" || relative === "market.html" || ext === ".html") {
    return "no-store";
  }
  if (relative === "app.js" || relative === "styles.css") {
    return "no-store";
  }
  if (relative.startsWith("generated/current/")) {
    return "no-store";
  }
  if (relative === "market-apps/catalog.json") {
    return "no-store";
  }
  if (relative.startsWith("market-apps/") || relative === "mac-frame.png" || ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".gif") {
    return "public, max-age=604800";
  }
  if (ext === ".css" || ext === ".js") {
    return "public, max-age=3600";
  }
  return "public, max-age=300";
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function execFileP(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd || ROOT,
      timeout: options.timeout || 30000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        ...(options.env || {})
      }
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJsonObject(text, label = "JSON") {
  const raw = String(text || "").trim();
  if (!raw) throw new Error(`${label} is empty.`);
  try {
    return JSON.parse(raw);
  } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(raw.slice(start, end + 1));
  }
  throw new Error(`${label} is not valid JSON.`);
}

function shouldUsePasswordFallback(error) {
  if (!boardPassword) return false;
  const text = `${error?.message || ""}\n${error?.stdout || ""}\n${error?.stderr || ""}`;
  return error?.code !== 0 || /Connection closed|Permission denied|Authentication failed|No supported authentication|kex_exchange_identification|Connection reset/i.test(text);
}

function publicBoardConfig() {
  return makePublicBoardConfig(BOARD, {
    passwordConfigured: Boolean(boardPassword),
    activeEndpoint
  });
}

function selectDevice(deviceId = "") {
  const next = createBoardConfig(deviceIdFrom({ deviceId }, BOARD.id));
  if (next.id !== BOARD.id) {
    activeEndpoint = null;
  }
  BOARD = next;
  knownHosts = process.env.VIBEBOARD_KNOWN_HOSTS || path.join(os.tmpdir(), `${BOARD.id}_known_hosts`);
  return BOARD;
}

async function withDevice(deviceId, task) {
  const previous = deviceContextQueue;
  let release;
  deviceContextQueue = new Promise(resolve => {
    release = resolve;
  });
  await previous;
  const previousBoard = BOARD;
  const previousKnownHosts = knownHosts;
  const previousActiveEndpoint = activeEndpoint;
  selectDevice(deviceId);
  try {
    return await task();
  } finally {
    BOARD = previousBoard;
    knownHosts = previousKnownHosts;
    activeEndpoint = previousActiveEndpoint;
    release();
  }
}

function updateBoardConfig(input = {}) {
  if (input.host !== undefined) BOARD.host = String(input.host || "").trim() || BOARD.host;
  if (input.port !== undefined) BOARD.port = String(input.port || "").trim() || BOARD.port;
  if (input.user !== undefined) BOARD.user = String(input.user || "").trim() || BOARD.user;
  if (input.frpHost !== undefined) BOARD.frpHost = String(input.frpHost || "").trim() || BOARD.frpHost;
  if (input.frpPort !== undefined) BOARD.frpPort = String(input.frpPort || "").trim() || BOARD.frpPort;
  if (input.password !== undefined) boardPassword = String(input.password || "").trim();
  activeEndpoint = null;
  return publicBoardConfig();
}

async function withDeployLock(task) {
  const previous = deployQueue;
  let release;
  deployQueue = new Promise(resolve => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

async function paramikoExecOnce(endpoint, remoteCommand, timeout = 30000, input = "") {
  return execPasswordSsh({
    execFile,
    pythonBin: PYTHON_BIN,
    endpoint,
    user: BOARD.user,
    password: boardPassword,
    remoteCommand,
    timeout,
    input,
    cwd: ROOT,
    env: process.env
  });
}

async function paramikoExec(remoteCommand, timeout = 30000, input = "") {
  const { endpoint, result } = await runAcrossEndpoints({
    activeEndpoint,
    endpoints: boardEndpoints(BOARD),
    attempts: 2,
    retryPattern: /NoValidConnectionsError|Unable to connect|Error reading SSH protocol banner|EOFError|Connection reset|Connection closed|timed out/i,
    retryDelay: attempt => 700 * attempt,
    boardLabel: BOARD.label,
    endpointLabel,
    runOnce: endpoint => paramikoExecOnce(endpoint, remoteCommand, timeout, input)
  });
  activeEndpoint = endpoint;
  return result;
}

async function opensshExec(remoteCommand, timeout = 30000, input = "") {
  const authHint = boardPassword
    ? ""
    : " No VIBEBOARD_BOARD_PASSWORD is set, so only key auth was attempted.";
  const { endpoint, result } = await runAcrossEndpoints({
    activeEndpoint,
    endpoints: boardEndpoints(BOARD),
    attempts: 3,
    retryPattern: /Connection closed|Connection timed out|banner exchange|kex_exchange_identification|Connection reset|timed out/i,
    retryDelay: attempt => 900 * attempt,
    boardLabel: BOARD.label,
    authHint,
    endpointLabel,
    runOnce: endpoint => execOpenSsh({
      execFile,
      endpoint,
      user: BOARD.user,
      identityFile,
      knownHosts,
      remoteCommand,
      timeout,
      input,
      cwd: ROOT
    })
  });
  activeEndpoint = endpoint;
  return result;
}

async function ssh(remoteCommand, timeout = 30000) {
  let result;
  try {
    result = boardPassword
      ? await paramikoExec(remoteCommand, timeout)
      : await opensshExec(remoteCommand, timeout);
  } catch (error) {
    if (!shouldUsePasswordFallback(error)) throw error;
    result = await paramikoExec(remoteCommand, timeout);
  }
  return result.stdout.trim();
}

async function wslSshWithInput(remoteCommand, input, timeout = 30000) {
  return execWslSsh({
    execFile,
    endpoint: { host: BOARD.frpHost, port: Number(BOARD.frpPort) },
    user: BOARD.user,
    password: boardPassword,
    remoteCommand,
    timeout,
    input
  });
}

async function sshWithInput(remoteCommand, input, timeout = 30000) {
  if (process.platform === "win32" && boardPassword) {
    try {
      return await wslSshWithInput(remoteCommand, input, timeout);
    } catch (wslError) {
      // fall through
    }
  }
  try {
    if (boardPassword) {
      return await paramikoExec(remoteCommand, timeout, input);
    }
    return await opensshExec(remoteCommand, timeout, input);
  } catch (error) {
    if (!shouldUsePasswordFallback(error)) throw error;
    return paramikoExec(remoteCommand, timeout, input);
  }
}

async function scp(localFile, remoteDir, timeout = 30000) {
  const args = [
    "-P", BOARD.port,
    "-o", "BatchMode=yes",
    "-i", identityFile,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    localFile,
    `${BOARD.user}@${BOARD.host}:${remoteDir}/`
  ];
  await execFileP("scp", args, { timeout });
}

async function scpToPath(localFile, remotePath, timeout = 30000) {
  const args = [
    "-P", BOARD.port,
    "-o", "BatchMode=yes",
    "-i", identityFile,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    localFile,
    `${BOARD.user}@${BOARD.host}:${remotePath}`
  ];
  await execFileP("scp", args, { timeout });
}

async function uploadTextFile(localFile, remotePath, timeout = 30000) {
  const content = await fs.readFile(localFile);
  return sshWithInput(
    buildUploadTextCommand(remotePath),
    buildUploadTextPayload(content),
    timeout
  );
}

async function uploadBundle(entries, timeout = 45000) {
  const files = await Promise.all(entries.map(async entry => ({
    path: entry.remotePath,
    mode: entry.mode || "",
    data: (await fs.readFile(entry.localPath)).toString("base64")
  })));

  return ssh(buildUploadBundleCommand(files), timeout);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildId() {
  return `vb-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function promptHas(prompt, words) {
  const lower = String(prompt || "").toLowerCase();
  return words.some(word => lower.includes(word.toLowerCase()));
}

function createAppSpec(prompt, id) {
  const text = String(prompt || "").trim() || "Build a VibeBoard hardware app";
  let mode = "assistant";
  if (promptHas(text, ["carousel", "slideshow", "photo", "image", "图片", "照片", "轮播", "相册"])) mode = "carousel";
  if (promptHas(text, ["fullscreen clock", "full screen clock", "clock", "全屏时钟", "时钟", "大时钟"])) mode = "clock";
  if (promptHas(text, ["voice", "audio", "record", "speech", "语音", "录音", "麦克风"])) mode = "voice";
  if (promptHas(text, ["server", "dashboard", "status", "监控", "状态", "面板", "服务器"])) mode = "dashboard";
  if (promptHas(text, ["timer", "focus", "countdown", "倒计时", "番茄"])) mode = "timer";
  if (promptHas(text, ["control", "switch", "gpio", "relay", "button", "控制", "开关", "继电器"])) mode = "control";
  if (promptHas(text, ["weather", "天气", "气温", "白底蓝字", "白色", "蓝色", "小屏助手"])) mode = "weather";

  const titles = {
    assistant: "AI Screen Assistant",
    voice: "Voice Console",
    dashboard: "Device Dashboard",
    timer: "Focus Clock",
    control: "Hardware Control",
    weather: "小屏助手",
    clock: "全屏时钟",
    carousel: "图片轮播"
  };
  const accents = {
    assistant: "#22c55e",
    voice: "#38bdf8",
    dashboard: "#f59e0b",
    timer: "#a78bfa",
    control: "#fb7185",
    weather: "#0b63ce",
    clock: "#f8fafc",
    carousel: "#fb7185"
  };
  const widgetsByMode = {
    assistant: [
      ["wifi", "Wi-Fi", "--", "live network"],
      ["ip", "IP", "--", "board address"],
      ["temp", "Temp", "--", "thermal zone"],
      ["runtime", "Runtime", "--", "python result"]
    ],
    voice: [
      ["level", "Input", "ready", "mic state"],
      ["transcript", "Transcript", "tap start", "simulated capture"],
      ["response", "AI Reply", "waiting", "screen output"],
      ["temp", "Temp", "--", "board thermal"]
    ],
    dashboard: [
      ["ip", "IP", "--", "network"],
      ["temp", "Temp", "--", "thermal"],
      ["memory", "Memory", "--", "available"],
      ["load", "Load", "--", "linux loadavg"]
    ],
    timer: [
      ["remaining", "Timer", "25:00", "focus session"],
      ["cycles", "Cycles", "0", "completed"],
      ["temp", "Temp", "--", "board thermal"],
      ["memory", "Memory", "--", "system"]
    ],
    control: [
      ["switchA", "Output A", "off", "virtual GPIO"],
      ["switchB", "Output B", "off", "virtual relay"],
      ["serviceState", "Service", "--", "systemd"],
      ["temp", "Temp", "--", "board thermal"]
    ],
    weather: [
      ["weather", "天气", "--", "Shenzhen weather"],
      ["temp", "板端温度", "--", "thermal zone"],
      ["wifi", "Wi-Fi", "--", "live network"],
      ["memory", "内存", "--", "system"]
    ],
    clock: [
      ["time", "Time", "--:--", "fullscreen clock"],
      ["date", "Date", "--", "calendar"],
      ["seconds", "Seconds", "--", "ticker"],
      ["service", "Service", "--", "hardware api"]
    ],
    carousel: [
      ["slide", "Slide", "1/4", "image index"],
      ["caption", "Caption", "ready", "current image"],
      ["runtime", "Runtime", "--", "python result"],
      ["service", "Service", "--", "hardware api"]
    ]
  };
  const actionsByMode = {
    weather: [{ id: "refresh", label: "刷新" }],
    clock: [{ id: "refresh", label: "Sync" }],
    carousel: [
      { id: "previous", label: "Prev" },
      { id: "next", label: "Next" },
      { id: "refresh", label: "Sync" }
    ]
  };

  return {
    id,
    prompt: text,
    mode,
    title: titles[mode],
    subtitle: text.slice(0, 120),
    accent: accents[mode],
    target: "480x360 RK3566 Linux kiosk",
    hardwareApi: ["/api/status", "./hardware-result.json"],
    widgets: widgetsByMode[mode].map(([widgetId, label, value, hint]) => ({ id: widgetId, label, value, hint })),
    actions: actionsByMode[mode] || [
      { id: "primary", label: mode === "voice" ? "Start" : mode === "timer" ? "Start" : mode === "control" ? "Toggle A" : "Run" },
      { id: "secondary", label: mode === "control" ? "Toggle B" : "Mark" },
      { id: "refresh", label: "Refresh" }
    ]
  };
}

function stripCodeFence(text) {
  const trimmed = String(text || "").trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}

function extractJsonObject(text) {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(cleaned.slice(start, end + 1));
  }
  throw new Error("Model did not return valid JSON.");
}

function validateGeneratedFileContracts(files, label) {
  assertFileContracts(files, label);
}

function hasBoardCredentials() {
  return Boolean(boardPassword || process.env.VIBEBOARD_IDENTITY_FILE || process.env.VIBEBOARD_FORCE_REAL_BOARD === "1");
}

function buildOfflineGoldenLoop(buildId = currentBuild?.id || "") {
  const checkedAt = new Date().toISOString();
  const checks = [
    "ssh-route",
    "upload",
    "board-python",
    "service-restart",
    "http-build-id",
    "display-geometry",
    "kiosk-window",
  ].map(id => ({
    id,
    label: `${id} skipped without hardware`,
    ok: false,
    skipped: true,
    evidence: "No Taishan board credentials or reachable route configured in this session.",
  }));

  return {
    id: buildId,
    ok: false,
    skipped: true,
    mode: "offline-simulated",
    checkedAt,
    route: activeEndpoint ? endpointLabel(activeEndpoint) : "",
    checks,
    raw: {},
  };
}

function buildOfflineDeployResult() {
  const buildEvidence = currentBuild?.buildEvidence || null;
  return {
    id: currentBuild?.id || "",
    skipped: true,
    mode: "offline-simulated",
    deployed: false,
    backup: "",
    output: "Hardware deploy skipped because no board credentials or reachable route are configured.",
    compileLog: buildEvidence?.ok ? "local L0-L3 verification passed" : "local verification not available",
    hardwareResult: null,
    hardwareResultRaw: "",
    programPath: "generated/current/hardware-result.json",
    compilePath: "",
    buildEvidence,
    goldenLoop: buildOfflineGoldenLoop(currentBuild?.id || ""),
  };
}

function detectTaskTypeLocal(prompt = "") {
  const lower = String(prompt || "").toLowerCase();
  if (/时钟|clock|时间/.test(lower)) return "clock";
  if (/游戏|game|snake|贪吃蛇|赛车/.test(lower)) return "game";
  if (/天气|weather/.test(lower)) return "weather";
  if (/动画|animation/.test(lower)) return "animation";
  if (/音乐|music|播放/.test(lower)) return "music";
  if (/计时|timer|倒计时/.test(lower)) return "timer";
  return "general";
}

function recordAgentLearning({
  prompt,
  agentResult = {},
  verificationResult = null,
  success = false,
} = {}) {
  const record = {
    taskType: detectTaskTypeLocal(prompt),
    promptSummary: String(prompt || "").slice(0, 200),
    whatWorked: agentResult.whatWorked || [],
    whatFailed: agentResult.whatFailed || [],
    fixesApplied: verificationResult?.issues?.length
      ? (verificationResult.issues || []).flatMap(issue => issue.suggestedFixes || [])
      : [],
    verificationResult,
    success,
  };

  try {
    experienceStore.recordExperience(record);
  } catch (err) {
    console.warn("[learning] experience record failed:", err.message);
  }

  try {
    const candidate = makePlaybookCandidate(record);
    if (candidate.signature !== "general:unknown") {
      return playbookStore.recordPlaybook(candidate);
    }
  } catch (err) {
    console.warn("[learning] playbook record failed:", err.message);
  }

  return null;
}

/**
 * 兜底注入：确保 hardware_app.py 输出包含 golden-loop 必需字段
 * 无论 AI 生成什么代码，都强制注入 runtime 和 build_id
 */
function injectHardwareAppContracts(source, buildId) {
  const idJson = JSON.stringify(buildId);
  const sourceB64Json = JSON.stringify(Buffer.from(String(source || ""), "utf8").toString("base64"));
  
  // 检查是否已经有 runtime 字段
  if (source.includes('"runtime"') && source.includes('"executed_on_board"')) {
    // 已经有正确的 runtime 字段，只检查 build_id
    if (source.includes('"build_id"')) {
      return source; // 两个字段都有，不需要注入
    }
  }
  
  // 注入包装器：在脚本执行后，强制添加必需字段
  const wrapper = `
# --- Golden-loop contract injection (auto-injected) ---
import base64 as __base64
import json as __json
import sys as __sys

__original_print = print
__build_id = ${idJson}
__script_content = __base64.b64decode(${sourceB64Json}).decode("utf-8")

def __wrapped_main():
    """Run original script and inject required fields."""
    import io
    __old_stdout = __sys.stdout
    __sys.stdout = __buffer = io.StringIO()
    try:
        exec(__script_content, {"__name__": "__main__"})
    finally:
        __sys.stdout = __old_stdout
    
    # 解析原始输出
    __raw_output = __buffer.getvalue().strip()
    try:
        __result = __json.loads(__raw_output)
    except __json.JSONDecodeError:
        __result = {"raw_output": __raw_output}
    
    # 注入必需字段
    __result["build_id"] = __build_id
    __result["runtime"] = "executed_on_board"
    __result["hostname"] = __result.get("hostname", socket.gethostname())
    
    __original_print(__json.dumps(__result, ensure_ascii=False, indent=2))

# 保存原始脚本内容
if __name__ == "__main__":
    import socket
    __wrapped_main()
`;
  
  return wrapper;
}

function injectHardwareAppContractsV2(source, buildId) {
  const sourceText = String(source || "");
  const idJson = JSON.stringify(buildId);
  const sourceB64Json = JSON.stringify(Buffer.from(sourceText, "utf8").toString("base64"));

  return `
# --- VibeBoard runtime contract injection (auto-injected) ---
import base64 as __vb_base64
import json as __vb_json
import socket as __vb_socket
import sys as __vb_sys

__vb_build_id = ${idJson}
__vb_script_content = __vb_base64.b64decode(${sourceB64Json}).decode("utf-8")

def __vb_parse_output(raw):
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        return __vb_json.loads(raw)
    except Exception:
        pass
    for line in reversed([item.strip() for item in raw.splitlines() if item.strip()]):
        if line.startswith("{") or line.startswith("["):
            try:
                return __vb_json.loads(line)
            except Exception:
                pass
    return {"raw_output": raw}

def __vb_wrapped_main():
    import io
    old_stdout = __vb_sys.stdout
    __vb_sys.stdout = buffer = io.StringIO()
    try:
        exec(__vb_script_content, {"__name__": "__main__"})
    finally:
        __vb_sys.stdout = old_stdout

    result = __vb_parse_output(buffer.getvalue())
    if not isinstance(result, dict):
        result = {"value": result}
    result["build_id"] = __vb_build_id
    result["runtime"] = "executed_on_board"
    result["hostname"] = result.get("hostname") or __vb_socket.gethostname()
    result["available_apis"] = result.get("available_apis") or ["/api/status", "./hardware-result.json"]
    print(__vb_json.dumps(result, ensure_ascii=False, sort_keys=True))

if __name__ == "__main__":
    __vb_wrapped_main()
`;
}

const HARDWARE_PROFILE = {
  屏幕: { 宽度: 480, 高度: 360, 色深: "RGB565", 触摸: false, 类型: "IPS LCD" },
  芯片: { 型号: "RK3566", 架构: "aarch64", GPU: "Mali-G52 2EE", CPU: "4x Cortex-A55 @1.8GHz" },
  系统: { OS: "Debian 11 (bullseye)", Python: "3.9", Node: "无（仅服务端有Node）" },
  连接: { WiFi: true, 蓝牙: false, GPIO: "40pin", I2C: true, SPI: true, UART: true },
  传感器: { CPU温度: "可读", GPU温度: "可读", 加速度: "无", 光线: "无", GPS: "无" },
  输入: { 触摸屏: false, 按钮: "3个GPIO物理按钮（KEY1/KEY2/KEY3）", 旋钮: "无" },
  输出: { 屏幕: "480x360 LCD", LED: "绿色LED x1", 蜂鸣器: "无", 喇叭: "3.5mm音频" },
  已装软件: ["flask", "luma.oled", "PIL/Pillow", "pygame", "RPi.GPIO", "requests"],
  网络: { HTTP服务: "可运行flask或node http-server", 端口: "可用任意高端口" }
};

function llmSystemPrompt(conversationHistory = []) {
  const isEditing = conversationHistory.length > 0;

  return `You are VibeBoard, a hardware-aware coding assistant embedded in a real physical device.

## Your Hardware Context
${JSON.stringify(HARDWARE_PROFILE, null, 2)}

## Your Capabilities
You generate complete, production-ready web applications that run on the above hardware.
The screen is 480x360 pixels with NO touch input. Users interact via 3 physical GPIO buttons.
Every app you create runs as a fullscreen kiosk in a real browser on a real embedded Linux board.

## Output Format
Return ONLY a JSON object (no markdown, no commentary):
{
  "files": {
    "index.html": "...",
    "style.css": "...",
    "app.js": "...",
    "hardware_app.py": "..."
  },
  "title": "short app title",
  "mode": "assistant|weather|dashboard|voice|timer|control|custom",
  "notes": "one concise implementation note"
}

${isEditing ? `## ⚠️ Editing Mode — CRITICAL RULES
You are modifying an EXISTING project that is already deployed.
The user can see the current code in the "当前部署的完整代码" section below.

**YOU MUST:**
1. Return ALL files in the JSON, even if you only changed one file
2. For files the user didn't ask to change: copy them EXACTLY as-is (no formatting changes, no "improvements")
3. Only modify the specific thing the user asked about
4. If the user says "把3改成2", find what "3" refers to in the code and change only that to "2"
5. NEVER rewrite the entire project from scratch when making a small change
6. Preserve all existing functionality that the user didn't mention

**COMMON MISTAKE TO AVOID:**
User says "fix the color of button X" → Do NOT remove button Y or change the layout.
User says "change item 3 to 2" → Find item 3 in the code, change its value to 2. Keep everything else.
` : `## Generation Mode
You are creating a NEW project from scratch.
` }

## Hard Requirements (always apply)
${validationRulesText("en").map(rule => `- ${rule}`).join("\n")}
- Use dark theme (dark background, light text) for best readability on LCD.
- Font sizes: titles 16-20px, body 12-14px, small labels 10-11px.
- Colors: avoid pure white (#fff), prefer #e2e8f0 or similar soft white.

## Available Runtime Data (from /api/status)
- hostname, model, kernel, time, uptime, cpu_temp
- memory.percent, memory.used_h, memory.total_h
- disk.percent, disk.used_h, disk.total_h
- network.wifi, network.addresses[0], network.gateway
- services.ssh, services.frpc, services.display
`;
}

/**
 * Thinking engine: analyze the user's request before generating code.
 * Returns { thinking, analysis } where thinking is displayable text.
 */
async function thinkBeforeGenerate(settings, prompt, id, history = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const isEditing = history.length > 0;
    const recentContext = history.slice(-4).map(m =>
      `[${m.role === "user" ? "用户" : "助手"}] ${m.content.slice(0, 200)}`
    ).join("\n");

    const thinkingPrompt = `你是一个嵌入式硬件编程助手，在生成代码前先思考分析。

## 当前任务
用户${isEditing ? "要修改已有的应用" : "请求创建一个新应用"}：${prompt}

${isEditing ? `## 最近对话
${recentContext}

## 当前代码
${currentBuild?.files ? Object.keys(currentBuild.files).filter(f => f !== "manifest.json").map(name => {
  const content = currentBuild.files[name] || "";
  return "### " + name + "\n" + content.slice(0, 2000) + (content.length > 2000 ? "\n...(已截断)" : "");
}).join("\n\n") : "无"}` : ""}

## 你的硬件环境
- 屏幕 480x360 像素，无触摸，3个GPIO物理按钮
- RK3566 芯片，Debian 11，Python 3.9
- 深色主题 LCD 显示屏

请用中文思考，输出你的分析过程。格式：

思考过程：
1. 需求理解：...
2. 技术方案：...
3. UI布局规划：...
4. 需要注意的问题：...
${isEditing ? "5. 需要修改哪些文件：..." : ""}

不要生成代码，只输出思考分析。`;

    const messages = [
      { role: "system", content: "你是一个善于分析和规划的嵌入式系统编程专家。在动手写代码前，你会先仔细思考需求、规划方案、预判问题。用中文回答。" },
      { role: "user", content: thinkingPrompt }
    ];

    // For DeepSeek, enable native thinking
    const payload = {
      model: settings.model,
      messages,
      temperature: 0.3,
      max_tokens: 2000
    };
    if (settings.provider === "deepseek") {
      payload.thinking = { type: "enabled" };
    }

    const res = await fetch(chatCompletionsUrl(settings.baseUrl), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { thinking: "", analysis: null };
    }

    // Extract thinking from DeepSeek native thinking or content
    let thinking = "";
    if (data.choices?.[0]?.message?.reasoning_content) {
      thinking = data.choices[0].message.reasoning_content;
    } else {
      thinking = data.choices?.[0]?.message?.content || "";
    }

    return { thinking: thinking.trim(), analysis: thinking.trim() };
  } catch (err) {
    console.warn("[thinkBeforeGenerate] Failed:", err.message);
    return { thinking: "", analysis: null };
  }
}

function llmUserPrompt(prompt, id, history = []) {
  const isEditing = history.length > 0;

  if (!isEditing) {
    // New project: simple prompt
    return `Build id: ${id}
User request: ${prompt}

Respond with ONLY the JSON object containing the files.`;
  }

  // Editing mode: inject FULL current code snapshot
  let codeSnapshot = "";
  if (currentBuild?.files) {
    const fileList = Object.keys(currentBuild.files).filter(f => f !== "manifest.json");
    codeSnapshot = "\n\n## 当前部署的完整代码（这是用户正在看的版本）\n";
    codeSnapshot += "你必须基于这些代码做修改，保留未被要求修改的部分。\n\n";
    for (const name of fileList) {
      const content = currentBuild.files[name] || "";
      if (content.length > 8000) {
        codeSnapshot += `### ${name}\n\`\`\`\n${content.slice(0, 8000)}\n... (截断)\n\`\`\`\n\n`;
      } else {
        codeSnapshot += `### ${name}\n\`\`\`\n${content}\n\`\`\`\n\n`;
      }
    }
  }

  return `Build id: ${id}
用户请求: ${prompt}
${codeSnapshot}

## 关键规则
1. 返回完整的 JSON，包含所有文件（即使只改了一个文件，其他文件也要原样返回）
2. 只修改用户要求改的部分，其他内容保持不变
3. 不要重新设计或重构用户没有提到的部分
4. 如果用户说"把X改成Y"，只改X相关的内容

Respond with ONLY the JSON object.`;
}

async function callChatModel(settings, prompt, id, history = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const messages = [
      { role: "system", content: llmSystemPrompt(history) }
    ];
    // Add conversation history (previous user/assistant turns)
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
    // Add current user prompt
    messages.push({ role: "user", content: llmUserPrompt(prompt, id, history) });
    const payload = {
      model: settings.model,
      messages,
      temperature: 0.2,
      max_tokens: 16000
    };
    const res = await fetch(chatCompletionsUrl(settings.baseUrl), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.error?.message || data.base_resp?.status_msg || `model HTTP ${res.status}`;
      throw new Error(message);
    }
    // Support DeepSeek reasoning_content field
    const content = data.choices?.[0]?.message?.reasoning_content
      ? data.choices[0].message.content || ""
      : data.choices?.[0]?.message?.content || "";
    if (!content.trim()) throw new Error("Model returned empty content.");
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeGeneratedFiles(raw, prompt, id, meta = {}) {
  const payload = raw.files && typeof raw.files === "object" ? raw.files : raw;
  const files = {};
  for (const name of ["index.html", "style.css", "app.js", "hardware_app.py"]) {
    if (typeof payload[name] === "string" && payload[name].trim()) {
      files[name] = payload[name];
    }
  }

  if (!files["index.html"] || !files["style.css"] || !files["app.js"]) {
    throw new Error("Model output is missing index.html, style.css, or app.js.");
  }

  const spec = createAppSpec(prompt, id);
  if (!files["hardware_app.py"]) {
    files["hardware_app.py"] = generatedHardwareAppV2(prompt, id, spec);
  }
  
  // 兜底注入：确保 hardware_app.py 输出包含 golden-loop 必需字段
  files["hardware_app.py"] = injectHardwareAppContractsV2(files["hardware_app.py"], id);
  
  validateGeneratedFileContracts(files, "Model");

  const manifest = generatedManifestV2(prompt, id, spec, {
    generator: "vibeboard-llm-webcoding-v1",
    mode: raw.mode || spec.mode,
    title: raw.title || spec.title,
    source: "llm",
    model: meta.model || "",
    provider: meta.provider || "",
    notes: raw.notes || "",
    target: BOARD.targetStatic
  });
  files["manifest.json"] = JSON.stringify(manifest, null, 2);
  return { files, manifest };
}

function templateGeneratedFiles(prompt, id, reason = "") {
  const spec = createAppSpec(prompt, id);
  const manifest = generatedManifestV2(prompt, id, spec, {
    source: "template",
    fallbackReason: reason,
    target: BOARD.targetStatic
  });
  return {
    files: {
      "index.html": generatedIndexV2(prompt, id, spec),
      "style.css": generatedStyleV2(prompt, id, spec),
      "app.js": generatedAppV2(prompt, id, spec),
      "hardware_app.py": generatedHardwareAppV2(prompt, id, spec),
      "manifest.json": JSON.stringify(manifest, null, 2)
    },
    manifest
  };
}


const HISTORY_WINDOW = 10; // keep last N messages uncompressed
const HISTORY_LOOKBACK = 20; // how many old messages to summarize
const GENERATE_HISTORY_ALLOWED_ROLES = new Set(["user", "assistant", "system"]);
const GENERATE_HISTORY_MAX_MESSAGES = HISTORY_WINDOW + HISTORY_LOOKBACK;
const GENERATE_HISTORY_CONTENT_LIMIT = 8000;

function normalizeGenerateHistory(rawHistory) {
  const messages = Array.isArray(rawHistory) ? rawHistory : [];
  const normalized = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;

    let role = typeof msg.role === "string" ? msg.role.trim().toLowerCase() : "";
    if (role === "agent") role = "assistant";
    if (!GENERATE_HISTORY_ALLOWED_ROLES.has(role)) continue;
    if (typeof msg.content !== "string") continue;

    const content = msg.content.trim();
    if (!content) continue;

    normalized.push({
      role,
      content: content.length > GENERATE_HISTORY_CONTENT_LIMIT
        ? content.slice(0, GENERATE_HISTORY_CONTENT_LIMIT)
        : content,
    });
  }

  return normalized.length > GENERATE_HISTORY_MAX_MESSAGES
    ? normalized.slice(-GENERATE_HISTORY_MAX_MESSAGES)
    : normalized;
}

function structuredErrorFieldsForLog(error) {
  if (!(error instanceof Error)) return {};

  const fields = {};
  for (const key of Object.keys(error)) {
    if (key === "message" || key === "stack") continue;
    fields[key] = error[key];
  }

  if (error.cause instanceof Error) {
    fields.cause = {
      name: error.cause.name,
      message: error.cause.message,
      ...structuredErrorFieldsForLog(error.cause),
    };
  } else if (error.cause != null) {
    fields.cause = error.cause;
  }

  return fields;
}

/**
 * Compress conversation history using a sliding window + summary approach.
 * - If total messages <= HISTORY_WINDOW, return as-is.
 * - Otherwise: summarize the older chunk into 1 summary message,
 *   keep the recent HISTORY_WINDOW messages intact.
 * - Summary is generated by the LLM itself for best quality.
 * - Falls back to a simple extractive summary if LLM call fails.
 */
async function compressHistory(history, settings) {
  if (history.length <= HISTORY_WINDOW) return history;

  const recent = history.slice(-HISTORY_WINDOW);
  const older = history.slice(0, -HISTORY_WINDOW);

  // Build a simple extractive summary as fallback
  const fallbackSummary = buildExtractiveSummary(older);

  // Try LLM-based summary if settings available
  let summary = fallbackSummary;
  if (settings?.enabled && settings?.apiKey) {
    try {
      const summaryPrompt = older.map(m =>
        `[${m.role === "user" ? "用户" : "助手"}] ${m.content.slice(0, 500)}`
      ).join("\n");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(chatCompletionsUrl(settings.baseUrl), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [
            {
              role: "system",
              content: `你是一个对话摘要助手。将以下对话压缩为一段简洁的中文摘要（不超过200字），保留关键信息：用户的需求、生成了什么应用、做了哪些修改、遇到了什么问题。只输出摘要，不要其他内容。`
            },
            { role: "user", content: summaryPrompt }
          ],
          temperature: 0.1,
          max_tokens: 300
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const content = data.choices?.[0]?.message?.content?.trim();
        if (content && content.length > 10) {
          summary = content;
          console.log(`[compressHistory] LLM summary: ${summary.slice(0, 80)}...`);
        }
      }
    } catch (err) {
      console.warn("[compressHistory] LLM summary failed, using extractive:", err.message);
    }
  }

  return [
    { role: "system", content: `[对话历史摘要] ${summary}` },
    ...recent
  ];
}

/**
 * Extractive fallback: pull key sentences from old messages.
 */
function buildExtractiveSummary(messages) {
  const userRequests = [];
  const assistantActions = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      // Take first 80 chars of each user message
      const text = msg.content.slice(0, 80).replace(/\n/g, " ");
      if (text) userRequests.push(text);
    } else {
      // Check for key actions
      if (msg.content.includes("已生成")) assistantActions.push("生成了应用");
      if (msg.content.includes("部署")) assistantActions.push("部署到真机");
      if (msg.content.includes("修复") || msg.content.includes("修改")) assistantActions.push("做了修改");
      if (msg.content.includes("截图验证")) assistantActions.push("截图验证");
    }
  }
  const parts = [];
  if (userRequests.length) parts.push(`用户请求过：${userRequests.slice(-3).join("；")}`);
  if (assistantActions.length) parts.push(`助手${[...new Set(assistantActions)].join("、")}`);
  return parts.join("。") || "之前有一段对话";
}

async function generateFilesForPrompt(prompt, id, modelSettings = {}, history = []) {
  const settings = normalizeModelSettings(modelSettings);
  if (!settings.enabled) {
    return templateGeneratedFiles(prompt, id, "model settings not configured");
  }

  try {
    const content = await callChatModel(settings, prompt, id, history);
    const raw = extractJsonObject(content);
    return normalizeGeneratedFiles(raw, prompt, id, {
      provider: settings.provider,
      model: settings.model
    });
  } catch (error) {
    if (history.length > 0) {
      // If editing and LLM fails, don't fall back to template - throw the error
      throw error;
    }
    return templateGeneratedFiles(prompt, id, `model generation failed: ${error.message}`);
  }
}

function generatedIndexV2(prompt, id, spec = createAppSpec(prompt, id)) {
  if (spec.mode === "clock") {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VibeBoard Clock</title>
  <link rel="stylesheet" href="./style.css?v=${id}">
</head>
<body>
  <main class="screen clock-screen" data-mode="clock">
    <section class="clock-face" aria-label="fullscreen clock">
      <span id="date">--</span>
      <strong id="time">--:--</strong>
      <small id="seconds">--</small>
    </section>
    <footer>
      <span id="service">Linux API --</span>
      <span id="eventLog">waiting</span>
      <button class="action" type="button" data-action="refresh">Sync</button>
    </footer>
  </main>
  <script src="./app.js?v=${id}"></script>
</body>
</html>
`;
  }

  if (spec.mode === "carousel") {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VibeBoard Carousel</title>
  <link rel="stylesheet" href="./style.css?v=${id}">
</head>
<body>
  <main class="screen carousel-screen" data-mode="carousel">
    <section class="slide-stage" aria-label="image carousel">
      <div class="slide active" data-slide="0"><span>01</span><strong>晨光</strong></div>
      <div class="slide" data-slide="1"><span>02</span><strong>城市</strong></div>
      <div class="slide" data-slide="2"><span>03</span><strong>山海</strong></div>
      <div class="slide" data-slide="3"><span>04</span><strong>夜色</strong></div>
    </section>
    <section class="carousel-meta">
      <div>
        <span id="slide">1/4</span>
        <strong id="caption">晨光</strong>
      </div>
      <small id="eventLog">auto playing</small>
    </section>
    <footer>
      <button class="action" type="button" data-action="previous">Prev</button>
      <span id="service">Linux API --</span>
      <button class="action" type="button" data-action="next">Next</button>
    </footer>
  </main>
  <script src="./app.js?v=${id}"></script>
</body>
</html>
`;
  }

  if (spec.mode === "weather") {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VibeBoard App</title>
  <link rel="stylesheet" href="./style.css?v=${id}">
</head>
<body>
  <main class="screen" data-mode="assistant">
    <header class="top">
      <div>
        <span id="date">--</span>
        <strong>${htmlEscape(spec.title)}</strong>
      </div>
      <b id="service">同步中</b>
    </header>

    <section class="time-panel" aria-label="time">
      <span id="time">--:--</span>
      <small id="seconds">--</small>
    </section>

    <section class="weather-panel" aria-label="weather">
      <div>
        <span>今日天气</span>
        <strong id="weatherText">天气同步中</strong>
        <small id="weatherMeta">深圳</small>
      </div>
      <b id="weatherTemp">--°C</b>
    </section>

    <section class="status-grid">
      <article><span>Wi-Fi</span><strong id="wifi">--</strong></article>
      <article><span>板端温度</span><strong id="temp">--</strong></article>
      <article><span>内存</span><strong id="memory">--</strong></article>
      <article><span>IP</span><strong id="ip">--</strong></article>
    </section>

    <footer>
      <button class="action" type="button" data-action="refresh">刷新</button>
      <span id="eventLog">等待硬件 API</span>
      <span>${id}</span>
    </footer>
  </main>
  <script src="./app.js?v=${id}"></script>
</body>
</html>
`;
  }

  const widgets = spec.widgets.map(widget => (
    `<article class="widget" data-widget="${htmlEscape(widget.id)}"><span>${htmlEscape(widget.label)}</span><strong id="${htmlEscape(widget.id)}">${htmlEscape(widget.value)}</strong><small>${htmlEscape(widget.hint)}</small></article>`
  )).join("\n      ");
  const actions = spec.actions.map(action => (
    `<button class="action" type="button" data-action="${htmlEscape(action.id)}">${htmlEscape(action.label)}</button>`
  )).join("\n        ");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VibeBoard App</title>
  <link rel="stylesheet" href="./style.css?v=${id}">
</head>
<body>
  <main class="screen" data-mode="${htmlEscape(spec.mode)}">
    <header class="top">
      <div>
        <span id="date">--</span>
        <strong id="time">--:--</strong>
      </div>
      <b>${htmlEscape(spec.mode)}</b>
    </header>
    <section class="hero">
      <span>Generated Linux web app</span>
      <h1>${htmlEscape(spec.title)}</h1>
      <p>${htmlEscape(spec.subtitle)}</p>
    </section>
    <section class="widgets">
      ${widgets}
    </section>
    <section class="actions">
      <div>
        ${actions}
      </div>
      <small id="eventLog">hardware api waiting</small>
    </section>
    <footer><span id="service">Linux API --</span><span>${id}</span></footer>
  </main>
  <script src="./app.js?v=${id}"></script>
</body>
</html>
`;
}

function generatedStyleV2(prompt = "", id = "preview", spec = createAppSpec(prompt, id)) {
  if (spec.mode === "clock") {
    return `:root {
  color-scheme: dark;
  --bg: #05070b;
  --panel: rgba(255, 255, 255, .08);
  --line: rgba(255, 255, 255, .16);
  --text: #f8fafc;
  --muted: #94a3b8;
  --accent: #38bdf8;
}

* { box-sizing: border-box; }

html, body {
  width: 480px;
  height: 360px;
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", "Noto Sans SC", system-ui, sans-serif;
}

button { font: inherit; }

.screen {
  width: 480px;
  height: 360px;
  display: grid;
  grid-template-rows: 1fr 42px;
  gap: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at 22% 20%, rgba(56, 189, 248, .22), transparent 28%),
    linear-gradient(135deg, #05070b 0%, #111827 52%, #020617 100%);
}

.clock-face {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: 42px 172px 48px;
  align-content: center;
  justify-items: center;
  padding: 22px 18px 10px;
}

.clock-face span,
.clock-face small,
footer {
  color: var(--muted);
  font-size: 16px;
  line-height: 1.2;
  letter-spacing: 0;
}

.clock-face strong {
  overflow: hidden;
  max-width: 456px;
  color: var(--text);
  font-family: Consolas, "Segoe UI", monospace;
  font-size: 118px;
  font-weight: 900;
  line-height: .92;
  letter-spacing: 0;
  text-align: center;
  white-space: nowrap;
}

.clock-face small {
  min-width: 78px;
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--accent);
  background: var(--panel);
  font-family: Consolas, monospace;
  font-size: 28px;
  font-weight: 800;
  text-align: center;
}

footer {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 150px 1fr 74px;
  gap: 8px;
  align-items: center;
  padding: 7px 10px;
  border-top: 1px solid var(--line);
  background: rgba(2, 6, 23, .72);
  white-space: nowrap;
}

footer span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.action {
  min-width: 0;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--text);
  background: rgba(56, 189, 248, .16);
  font-size: 12px;
  font-weight: 800;
}
`;
  }

  if (spec.mode === "carousel") {
    return `:root {
  color-scheme: dark;
  --bg: #111827;
  --line: rgba(255, 255, 255, .18);
  --text: #f8fafc;
  --muted: #cbd5e1;
  --accent: #fb7185;
}

* { box-sizing: border-box; }

html, body {
  width: 480px;
  height: 360px;
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", "Noto Sans SC", system-ui, sans-serif;
}

button { font: inherit; }

.screen {
  width: 480px;
  height: 360px;
  display: grid;
  grid-template-rows: 248px 58px 54px;
  overflow: hidden;
  background: #111827;
}

.slide-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #0f172a;
}

.slide {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 0;
  transform: scale(1.02);
  transition: opacity .45s ease, transform .45s ease;
}

.slide.active {
  opacity: 1;
  transform: scale(1);
}

.slide::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(145deg, rgba(255, 255, 255, .18), transparent 36%),
    radial-gradient(circle at 20% 72%, rgba(255, 255, 255, .22), transparent 18%),
    radial-gradient(circle at 78% 28%, rgba(255, 255, 255, .2), transparent 16%);
}

.slide[data-slide="0"] { background: linear-gradient(135deg, #0f766e, #f59e0b); }
.slide[data-slide="1"] { background: linear-gradient(135deg, #1d4ed8, #7c3aed); }
.slide[data-slide="2"] { background: linear-gradient(135deg, #166534, #0891b2); }
.slide[data-slide="3"] { background: linear-gradient(135deg, #312e81, #be123c); }

.slide span {
  position: absolute;
  top: 18px;
  left: 20px;
  color: rgba(255, 255, 255, .72);
  font-family: Consolas, monospace;
  font-size: 24px;
  font-weight: 900;
}

.slide strong {
  position: relative;
  max-width: 420px;
  overflow: hidden;
  color: #ffffff;
  font-size: 66px;
  font-weight: 900;
  line-height: 1;
  letter-spacing: 0;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 8px 20px rgba(0, 0, 0, .28);
}

.carousel-meta {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 160px;
  gap: 10px;
  align-items: center;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  background: #111827;
}

.carousel-meta div,
.carousel-meta small {
  min-width: 0;
  overflow: hidden;
}

.carousel-meta span,
.carousel-meta small,
footer {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.2;
}

.carousel-meta strong {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  color: var(--text);
  font-size: 23px;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

footer {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 86px 1fr 86px;
  gap: 9px;
  align-items: center;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  background: #0f172a;
  white-space: nowrap;
}

footer span {
  min-width: 0;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
}

.action {
  min-width: 0;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: #fff;
  background: rgba(251, 113, 133, .28);
  font-size: 12px;
  font-weight: 850;
}
`;
  }

  if (spec.mode === "weather") {
    return `:root {
  color-scheme: light;
  --bg: #ffffff;
  --panel: #f2f7ff;
  --panel-strong: #e5f0ff;
  --line: #b8d4ff;
  --text: #0757b8;
  --muted: #3d78c5;
  --accent: ${spec.accent};
}

* { box-sizing: border-box; }

html, body {
  width: 480px;
  height: 360px;
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", "Noto Sans SC", system-ui, sans-serif;
}

button { font: inherit; }

.screen {
  width: 480px;
  height: 360px;
  display: grid;
  grid-template-rows: 44px 98px 82px 82px 30px;
  gap: 7px;
  padding: 10px;
  background: var(--bg);
}

.top {
  min-width: 0;
  min-height: 0;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.top span,
.weather-panel span,
.weather-panel small,
.status-grid span,
footer {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.2;
}

.top strong {
  display: block;
  margin-top: 2px;
  color: var(--accent);
  font-size: 22px;
  line-height: 1;
  letter-spacing: 0;
}

.top b {
  max-width: 170px;
  min-height: 26px;
  padding: 6px 9px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--accent);
  background: var(--panel);
  font-size: 12px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time-panel {
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-strong);
}

.time-panel span {
  color: var(--accent);
  font-family: Consolas, "Segoe UI", monospace;
  font-size: 70px;
  font-weight: 900;
  line-height: 1;
  letter-spacing: 0;
}

.time-panel small {
  color: var(--muted);
  font-family: Consolas, monospace;
  font-size: 24px;
  font-weight: 800;
}

.weather-panel {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 136px;
  gap: 8px;
  align-items: stretch;
}

.weather-panel > div,
.weather-panel > b,
.status-grid article {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}

.weather-panel > div {
  padding: 10px 12px;
}

.weather-panel strong {
  display: block;
  margin: 4px 0;
  overflow: hidden;
  color: var(--accent);
  font-size: 25px;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.weather-panel > b {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--accent);
  font-family: Consolas, monospace;
  font-size: 31px;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-grid {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 7px;
}

.status-grid article {
  padding: 8px;
}

.status-grid strong {
  display: block;
  margin-top: 6px;
  overflow: hidden;
  color: var(--accent);
  font-size: 16px;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
}

footer {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 70px 1fr 132px;
  gap: 7px;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
}

.action {
  min-width: 0;
  min-height: 28px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  color: #ffffff;
  background: var(--accent);
  font-size: 13px;
  font-weight: 850;
}

footer span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;
  }

  return `:root {
  color-scheme: dark;
  --bg: #10161e;
  --panel: rgba(255, 255, 255, .07);
  --line: rgba(255, 255, 255, .14);
  --text: #f8fafc;
  --muted: #cbd5e1;
  --accent: ${spec.accent};
}

* { box-sizing: border-box; }
html, body {
  width: 480px;
  height: 360px;
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", "Noto Sans SC", system-ui, sans-serif;
}

button { font: inherit; }

.screen {
  width: 480px;
  height: 360px;
  display: grid;
  grid-template-rows: 48px 96px 112px 54px 24px;
  gap: 6px;
  padding: 10px;
  background:
    linear-gradient(145deg, rgba(34, 197, 94, .15), transparent 42%),
    linear-gradient(330deg, rgba(56, 189, 248, .16), transparent 48%),
    #10161e;
}

.top {
  min-width: 0;
  min-height: 0;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.top span, .hero span, .widget span, .widget small, .actions small, footer {
  color: var(--muted);
  font-size: 12px;
}

.top strong {
  display: block;
  margin-top: 2px;
  font-family: Consolas, monospace;
  font-size: 32px;
  line-height: .95;
}

.top b {
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text);
  background: rgba(255, 255, 255, .08);
  font-size: 12px;
  text-transform: uppercase;
}

.hero, .widget {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}

.hero {
  min-width: 0;
  min-height: 0;
  padding: 9px;
}

h1 {
  margin: 4px 0 5px;
  font-size: 22px;
  line-height: 1.12;
  letter-spacing: 0;
}

p {
  margin: 0;
  display: -webkit-box;
  overflow: hidden;
  color: #e2e8f0;
  font-size: 13px;
  line-height: 1.35;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.widgets {
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}

.widget {
  min-width: 0;
  min-height: 0;
  padding: 7px;
}

.widget strong {
  display: block;
  margin: 2px 0 1px;
  overflow: hidden;
  font-size: 17px;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  min-width: 0;
  min-height: 0;
  display: grid;
  gap: 5px;
}

.actions div {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.action {
  min-width: 0;
  min-height: 28px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--text);
  background: #0b1220;
  font-weight: 750;
  font-size: 12px;
}

.action.active {
  border-color: var(--accent);
  box-shadow: 0 0 14px rgba(56, 189, 248, .45);
}

.actions small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

footer {
  min-width: 0;
  min-height: 0;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  overflow: hidden;
  white-space: nowrap;
}
`;
}

function generatedAppV2(prompt, id, spec = createAppSpec(prompt, id)) {
  const specJson = JSON.stringify(spec);
  const idJson = JSON.stringify(id);
  if (spec.mode === "clock") {
    return `const SPEC = ${specJson};
const PROMPT = SPEC.prompt;
const BUILD_ID = ${idJson};
const el = id => document.getElementById(id);

window.VibeBoardHardware = {
  async getStatus() {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error("status " + res.status);
    return res.json();
  },
  async getProgramResult() {
    const res = await fetch("./hardware-result.json", { cache: "no-store" });
    if (!res.ok) throw new Error("program " + res.status);
    return res.json();
  },
  async getSnapshot() {
    const settled = await Promise.allSettled([this.getStatus(), this.getProgramResult()]);
    return {
      status: settled[0].status === "fulfilled" ? settled[0].value : null,
      program: settled[1].status === "fulfilled" ? settled[1].value : null
    };
  }
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value == null || value === "" ? "--" : String(value);
}

function drawClock() {
  const now = new Date();
  setText("time", pad(now.getHours()) + ":" + pad(now.getMinutes()));
  setText("seconds", pad(now.getSeconds()));
  setText("date", now.toLocaleDateString("zh-CN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }));
}

async function refresh() {
  try {
    const snapshot = await window.VibeBoardHardware.getSnapshot();
    const data = snapshot.status || {};
    const program = snapshot.program || {};
    const serviceText = data.services ? "SSH " + (data.services.ssh || "--") + " / FRP " + (data.services.frpc || "--") : "Linux API ready";
    setText("service", serviceText);
    setText("eventLog", program.runtime || "clock synced");
  } catch (error) {
    setText("service", "Linux API retrying");
    setText("eventLog", "offline clock");
  }
}

document.querySelectorAll(".action").forEach(button => {
  button.addEventListener("click", refresh);
});

drawClock();
refresh();
setInterval(drawClock, 1000);
setInterval(refresh, 5000);
console.log("VibeBoard preview ready", BUILD_ID, PROMPT);
`;
  }

  if (spec.mode === "carousel") {
    return `const SPEC = ${specJson};
const PROMPT = SPEC.prompt;
const BUILD_ID = ${idJson};
const el = id => document.getElementById(id);
const slides = Array.from(document.querySelectorAll(".slide"));
const captions = ["晨光", "城市", "山海", "夜色"];
let current = 0;

window.VibeBoardHardware = {
  async getStatus() {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error("status " + res.status);
    return res.json();
  },
  async getProgramResult() {
    const res = await fetch("./hardware-result.json", { cache: "no-store" });
    if (!res.ok) throw new Error("program " + res.status);
    return res.json();
  },
  async getSnapshot() {
    const settled = await Promise.allSettled([this.getStatus(), this.getProgramResult()]);
    return {
      status: settled[0].status === "fulfilled" ? settled[0].value : null,
      program: settled[1].status === "fulfilled" ? settled[1].value : null
    };
  }
};

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value == null || value === "" ? "--" : String(value);
}

function showSlide(index) {
  if (!slides.length) return;
  current = (index + slides.length) % slides.length;
  slides.forEach((slide, idx) => slide.classList.toggle("active", idx === current));
  setText("slide", String(current + 1) + "/" + String(slides.length));
  setText("caption", captions[current] || "Slide " + String(current + 1));
}

async function refresh() {
  try {
    const snapshot = await window.VibeBoardHardware.getSnapshot();
    const data = snapshot.status || {};
    const program = snapshot.program || {};
    const serviceText = data.services ? "SSH " + (data.services.ssh || "--") : "Linux API ready";
    setText("service", serviceText);
    setText("eventLog", "build " + (program.build_id || BUILD_ID).slice(0, 10));
  } catch (error) {
    setText("service", "Linux API retrying");
    setText("eventLog", "local slideshow");
  }
}

function handleAction(action) {
  if (action === "previous") showSlide(current - 1);
  if (action === "next") showSlide(current + 1);
  if (action === "refresh") refresh();
}

document.querySelectorAll(".action").forEach(button => {
  button.addEventListener("click", () => handleAction(button.dataset.action));
});

showSlide(0);
refresh();
setInterval(() => showSlide(current + 1), 3000);
setInterval(refresh, 5000);
console.log("VibeBoard preview ready", BUILD_ID, PROMPT);
`;
  }

  if (spec.mode === "weather") {
    return `const SPEC = ${specJson};
const PROMPT = SPEC.prompt;
const BUILD_ID = ${idJson};
const el = id => document.getElementById(id);

window.VibeBoardHardware = {
  async getStatus() {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error("status " + res.status);
    return res.json();
  },
  async getProgramResult() {
    const res = await fetch("./hardware-result.json", { cache: "no-store" });
    if (!res.ok) throw new Error("program " + res.status);
    return res.json();
  },
  async getSnapshot() {
    const settled = await Promise.allSettled([this.getStatus(), this.getProgramResult()]);
    return {
      status: settled[0].status === "fulfilled" ? settled[0].value : null,
      program: settled[1].status === "fulfilled" ? settled[1].value : null
    };
  }
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value == null || value === "" ? "--" : String(value);
}

function drawClock() {
  const now = new Date();
  setText("time", pad(now.getHours()) + ":" + pad(now.getMinutes()));
  setText("seconds", pad(now.getSeconds()));
  setText("date", now.toLocaleDateString("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }));
}

const weatherCodeText = {
  0: "晴",
  1: "大部晴朗",
  2: "局部多云",
  3: "阴",
  45: "有雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "密集毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  80: "阵雨",
  81: "强阵雨",
  82: "暴阵雨",
  95: "雷雨"
};

async function refreshWeather() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  setText("weatherText", "大部晴朗");
  setText("weatherTemp", "32°C");
  setText("weatherMeta", "深圳参考天气");
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=22.5431&longitude=114.0579&current=temperature_2m,weather_code&timezone=Asia%2FShanghai";
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error("weather " + res.status);
    const data = await res.json();
    const current = data.current || {};
    const code = Number(current.weather_code);
    const temp = Number(current.temperature_2m);
    setText("weatherText", weatherCodeText[code] || "天气已同步");
    setText("weatherTemp", Number.isFinite(temp) ? Math.round(temp) + "°C" : "--°C");
    setText("weatherMeta", "深圳实时天气");
  } catch (error) {
    setText("weatherText", "大部晴朗");
    setText("weatherTemp", "32°C");
    setText("weatherMeta", "深圳参考天气");
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshHardware() {
  try {
    const snapshot = await window.VibeBoardHardware.getSnapshot();
    const data = snapshot.status || {};
    const program = snapshot.program || {};
    const ip = (data.network && data.network.addresses && data.network.addresses[0]) || "--";
    setText("wifi", (data.network && data.network.wifi) || "未连接");
    setText("ip", ip);
    setText("temp", data.cpu_temp == null ? "--" : data.cpu_temp + "°C");
    setText("memory", data.memory ? Number(data.memory.percent || 0).toFixed(1) + "%" : "--");
    setText("service", data.services && data.services.display || "在线");
    setText("eventLog", "API " + (program.runtime || "ready"));
  } catch (error) {
    setText("service", "重连中");
    setText("eventLog", "硬件 API 重试中");
    setText("ip", "waiting");
  }
}

async function refreshAll() {
  await Promise.allSettled([refreshWeather(), refreshHardware()]);
}

document.querySelectorAll(".action").forEach(button => {
  button.addEventListener("click", refreshAll);
});

drawClock();
refreshAll();
setInterval(drawClock, 1000);
setInterval(refreshHardware, 5000);
setInterval(refreshWeather, 600000);
console.log("VibeBoard preview ready", BUILD_ID, PROMPT);
`;
  }

  return `const SPEC = ${specJson};
const PROMPT = SPEC.prompt;
const BUILD_ID = ${idJson};
const el = id => document.getElementById(id);
const state = { tick: 0, activeA: false, activeB: false, running: false, seconds: 1500, cycles: 0 };

window.VibeBoardHardware = {
  async getStatus() {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error("status " + res.status);
    return res.json();
  },
  async getProgramResult() {
    const res = await fetch("./hardware-result.json", { cache: "no-store" });
    if (!res.ok) throw new Error("program " + res.status);
    return res.json();
  },
  async getSnapshot() {
    const settled = await Promise.allSettled([this.getStatus(), this.getProgramResult()]);
    return {
      status: settled[0].status === "fulfilled" ? settled[0].value : null,
      program: settled[1].status === "fulfilled" ? settled[1].value : null
    };
  }
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value == null || value === "" ? "--" : String(value);
}

function drawClock() {
  const now = new Date();
  setText("time", pad(now.getHours()) + ":" + pad(now.getMinutes()));
  setText("date", now.toLocaleDateString("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }));
}

function renderMode() {
  if (SPEC.mode === "timer") {
    if (state.running && state.seconds > 0) state.seconds -= 1;
    const minutes = Math.floor(state.seconds / 60);
    const seconds = state.seconds % 60;
    setText("remaining", pad(minutes) + ":" + pad(seconds));
    setText("cycles", state.cycles);
  }
  if (SPEC.mode === "voice") {
    setText("level", state.running ? "listening" : "ready");
    setText("transcript", state.running ? "capturing..." : "tap start");
    setText("response", state.tick % 2 ? "hardware online" : "waiting");
  }
  if (SPEC.mode === "control") {
    setText("switchA", state.activeA ? "on" : "off");
    setText("switchB", state.activeB ? "on" : "off");
  }
}

async function refresh() {
  try {
    const snapshot = await window.VibeBoardHardware.getSnapshot();
    const data = snapshot.status || {};
    const program = snapshot.program || {};
    const ip = (data.network && data.network.addresses && data.network.addresses[0]) || "--";
    setText("wifi", (data.network && data.network.wifi) || "offline");
    setText("ip", ip);
    setText("temp", data.cpu_temp == null ? "--" : data.cpu_temp + "°C");
    setText("memory", data.memory ? Number(data.memory.percent || 0).toFixed(1) + "%" : "--");
    setText("runtime", program.runtime || "waiting");
    setText("load", program.loadavg || "--");
    setText("serviceState", data.services && data.services.display || "--");
    setText("eventLog", "api ok " + new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    const serviceText = data.services ? "SSH " + (data.services.ssh || "--") + " / FRP " + (data.services.frpc || "--") : "Linux API ready";
    setText("service", serviceText);
  } catch (error) {
    setText("eventLog", "hardware api retrying");
    setText("ip", "waiting");
  }
}

function handleAction(action, button) {
  if (action === "refresh") refresh();
  if (action === "primary") {
    if (SPEC.mode === "timer") state.running = !state.running;
    else if (SPEC.mode === "control") state.activeA = !state.activeA;
    else state.running = !state.running;
  }
  if (action === "secondary") {
    if (SPEC.mode === "timer") { state.cycles += 1; state.seconds = 1500; }
    else if (SPEC.mode === "control") state.activeB = !state.activeB;
    else state.tick += 1;
  }
  if (button) button.classList.toggle("active");
  renderMode();
}

drawClock();
refresh();
renderMode();
document.querySelectorAll(".action").forEach(button => {
  button.addEventListener("click", () => handleAction(button.dataset.action, button));
});
setInterval(drawClock, 1000);
setInterval(() => { state.tick += 1; renderMode(); }, 1000);
setInterval(refresh, 5000);
console.log("VibeBoard preview ready", BUILD_ID, PROMPT);
`;
}

function generatedHardwareAppV2(prompt, id, spec = createAppSpec(prompt, id)) {
  const promptJson = JSON.stringify(prompt);
  const idJson = JSON.stringify(id);
  const specJson = JSON.stringify(spec);
  return `#!/usr/bin/env python3
import glob
import json
import os
import platform
import shutil
import socket
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass

BUILD_ID = ${idJson}
PROMPT = ${promptJson}
SPEC = ${specJson}

def read_first(path, default=""):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.readline().strip()
    except OSError:
        return default

def cpu_temp_c():
    raw = read_first("/sys/class/thermal/thermal_zone0/temp")
    try:
        value = float(raw)
        return round(value / 1000, 1) if value > 200 else round(value, 1)
    except ValueError:
        return None

def mem_available_kb():
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return None

def network_interfaces():
    items = []
    for path in glob.glob("/sys/class/net/*/operstate"):
        name = path.split("/")[-2]
        state = read_first(path, "unknown")
        if name != "lo":
            items.append({"name": name, "state": state})
    return items

def disk_percent():
    try:
        usage = shutil.disk_usage("/")
        return round((usage.used / usage.total) * 100, 1)
    except OSError:
        return None

result = {
    "app": "vibeboard-hardware-app",
    "build_id": BUILD_ID,
    "compile": "py_compile_ok",
    "runtime": "executed_on_board",
    "prompt": PROMPT,
    "spec": SPEC,
    "hostname": socket.gethostname(),
    "platform": platform.platform(),
    "time": int(time.time()),
    "cpu_temp_c": cpu_temp_c(),
    "mem_available_kb": mem_available_kb(),
    "disk_percent": disk_percent(),
    "network": network_interfaces(),
    "loadavg": read_first("/proc/loadavg"),
    "cwd": os.getcwd(),
    "available_apis": ["/api/status", "./hardware-result.json"]
}

print(json.dumps(result, ensure_ascii=False, sort_keys=True))
`;
}

function generatedManifestV2(prompt, id, spec = createAppSpec(prompt, id), extra = {}) {
  return {
    id,
    prompt: spec.prompt || prompt,
    generator: "vibeboard-web-coding-v2",
    mode: spec.mode,
    title: spec.title,
    target: spec.target,
    hardwareApi: spec.hardwareApi,
    files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"],
    createdAt: new Date().toISOString(),
    ...extra
  };
}

function generatedIndex(prompt, id) {
  const safePrompt = htmlEscape(prompt).slice(0, 160);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VibeBoard Screen</title>
  <link rel="stylesheet" href="./style.css?v=${id}">
</head>
<body>
  <main class="screen">
    <header class="top">
      <div>
        <span id="date">--</span>
        <strong id="time">--:--</strong>
      </div>
      <b>VibeBoard</b>
    </header>
    <section class="summary">
      <span>AI generated app</span>
      <h1>小屏助手已部署</h1>
      <p>${safePrompt}</p>
    </section>
    <section class="grid">
      <article><span>Wi-Fi</span><strong id="wifi">--</strong></article>
      <article><span>IP</span><strong id="ip">--</strong></article>
      <article><span>Temp</span><strong id="temp">--</strong></article>
      <article><span>Memory</span><strong id="mem">--</strong></article>
    </section>
    <footer><span id="service">SSH -- / FRP --</span><span>${id}</span></footer>
  </main>
  <script src="./app.js?v=${id}"></script>
</body>
</html>
`;
}

function generatedStyle() {
  return `:root {
  color-scheme: dark;
  --bg: #10161e;
  --panel: rgba(255, 255, 255, .07);
  --line: rgba(255, 255, 255, .14);
  --text: #f8fafc;
  --muted: #cbd5e1;
  --green: #22c55e;
  --blue: #38bdf8;
}

* { box-sizing: border-box; }
html, body {
  width: 480px;
  height: 360px;
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", "Noto Sans SC", system-ui, sans-serif;
}

.screen {
  width: 480px;
  height: 360px;
  display: grid;
  grid-template-rows: 54px 120px 94px 24px;
  gap: 7px;
  padding: 10px;
  background:
    linear-gradient(145deg, rgba(34, 197, 94, .18), transparent 42%),
    linear-gradient(330deg, rgba(56, 189, 248, .2), transparent 48%),
    #10161e;
}

.top {
  min-width: 0;
  min-height: 0;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.top span, .summary span, article span, footer {
  color: var(--muted);
  font-size: 12px;
}

.top strong {
  display: block;
  margin-top: 2px;
  font-family: Consolas, monospace;
  font-size: 36px;
  line-height: .95;
}

.top b {
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: #bbf7d0;
  background: rgba(34, 197, 94, .1);
  font-size: 12px;
}

.summary, article {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}

.summary {
  min-width: 0;
  min-height: 0;
  padding: 9px;
}

h1 {
  margin: 4px 0 5px;
  font-size: 23px;
  line-height: 1.12;
}

p {
  margin: 0;
  display: -webkit-box;
  overflow: hidden;
  color: #e2e8f0;
  font-size: 13px;
  line-height: 1.36;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.grid {
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}

article {
  min-width: 0;
  min-height: 0;
  padding: 7px;
}

article strong {
  display: block;
  margin-top: 4px;
  overflow: hidden;
  font-size: 18px;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
}

footer {
  min-width: 0;
  min-height: 0;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  overflow: hidden;
  white-space: nowrap;
}
`;
}

function generatedApp(prompt, id) {
  const promptJson = JSON.stringify(prompt);
  const idJson = JSON.stringify(id);
  return `const PROMPT = ${promptJson};
const BUILD_ID = ${idJson};
const el = id => document.getElementById(id);

function pad(value) {
  return String(value).padStart(2, "0");
}

function drawClock() {
  const now = new Date();
  el("time").textContent = pad(now.getHours()) + ":" + pad(now.getMinutes());
  el("date").textContent = now.toLocaleDateString("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric"
  });
}

async function refresh() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    const data = await res.json();
    const ip = (data.network && data.network.addresses && data.network.addresses[0]) || "--";
    el("wifi").textContent = (data.network && data.network.wifi) || "未连接";
    el("ip").textContent = ip;
    el("temp").textContent = data.cpu_temp == null ? "--" : data.cpu_temp + "°C";
    el("mem").textContent = data.memory ? Number(data.memory.percent || 0).toFixed(1) + "%" : "--";
    el("service").textContent = "SSH " + (data.services && data.services.ssh || "--") + " / FRP " + (data.services && data.services.frpc || "--");
  } catch (error) {
    el("ip").textContent = "waiting";
  }
}

drawClock();
refresh();
setInterval(drawClock, 1000);
setInterval(refresh, 5000);
console.log("VibeBoard preview ready", BUILD_ID, PROMPT);
`;
}

function generatedHardwareApp(prompt, id) {
  const promptJson = JSON.stringify(prompt);
  const idJson = JSON.stringify(id);
  return `#!/usr/bin/env python3
import json
import os
import platform
import socket
import time

BUILD_ID = ${idJson}
PROMPT = ${promptJson}

def read_first(path, default=""):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.readline().strip()
    except OSError:
        return default

def cpu_temp_c():
    raw = read_first("/sys/class/thermal/thermal_zone0/temp")
    try:
        value = float(raw)
        return round(value / 1000, 1) if value > 200 else round(value, 1)
    except ValueError:
        return None

def mem_available_kb():
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return None

result = {
    "app": "vibeboard-hardware-app",
    "build_id": BUILD_ID,
    "compile": "py_compile_ok",
    "runtime": "executed_on_board",
    "prompt": PROMPT,
    "hostname": socket.gethostname(),
    "platform": platform.platform(),
    "time": int(time.time()),
    "cpu_temp_c": cpu_temp_c(),
    "mem_available_kb": mem_available_kb(),
    "loadavg": read_first("/proc/loadavg"),
    "cwd": os.getcwd()
}

print(json.dumps(result, ensure_ascii=False, sort_keys=True))
`;
}

async function writeGenerated(prompt, modelSettings = {}, history = []) {
  const id = buildId();
  await appendServerLog("generate.template.start", { id, prompt: String(prompt || "").slice(0, 160) });
  const { files, manifest } = await generateFilesForPrompt(prompt, id, modelSettings, history);
  await writeGeneratedFiles(GENERATED_DIR, files);
  const agentRun = transitionRun(createAgentRun({
    prompt,
    mode: "template",
    buildId: id,
    hardwareMode: boardPassword ? "real" : "simulated",
  }), AGENT_PHASES.CODE, {
    spec: buildInitialSpec(prompt, { requireBoard: Boolean(boardPassword) }),
  });
  currentBuild = { id, prompt, files, dir: GENERATED_DIR, built: false, deployed: false, manifest, agentRun };
  await buildCurrent();
  await appendServerLog("generate.template.done", { id, files: Object.keys(files) });
  return currentBuild;
}

async function loadGeneratedBuild() {
  currentBuild = await loadGeneratedWorkspace(GENERATED_DIR, GENERATED_FILE_NAMES, {
    id: "preview",
    prompt: "等待生成"
  });
  return currentBuild;
}

async function ensureInitialGenerated() {
  currentBuild = await ensureGeneratedWorkspace({
    dir: GENERATED_DIR,
    generatedFileNames: GENERATED_FILE_NAMES,
    fallbackSeed: {
      id: "preview",
      prompt: "等待生成。这里会显示即将写入灰色版小电脑的同一份 480x360 小屏应用。"
    },
    bootstrapFile: "index.html",
    makeFiles: ({ id, prompt }) => {
      const spec = createAppSpec(prompt, id);
      return {
        "index.html": generatedIndexV2(prompt, id, spec),
        "style.css": generatedStyleV2(prompt, id, spec),
        "app.js": generatedAppV2(prompt, id, spec),
        "hardware_app.py": generatedHardwareAppV2(prompt, id, spec),
        "manifest.json": JSON.stringify(generatedManifestV2(prompt, id, spec), null, 2)
      };
    }
  });
}

async function buildCurrent() {
  if (!currentBuild) throw new Error("No generated app. Generate first.");
  await appendServerLog("build.start", { id: currentBuild.id });
  const appFile = path.join(currentBuild.dir, "app.js");
  const hardwareFile = path.join(currentBuild.dir, "hardware_app.py");
  const hardwareResultFile = path.join(currentBuild.dir, "hardware-result.json");
  const indexFile = path.join(currentBuild.dir, "index.html");
  const styleFile = path.join(currentBuild.dir, "style.css");
  const manifestFile = path.join(currentBuild.dir, "manifest.json");
  try {
    const indexSource = await fs.readFile(indexFile, "utf8");
    const versionedIndex = withAssetVersion(indexSource, currentBuild.id);
    if (versionedIndex !== indexSource) {
      await fs.writeFile(indexFile, versionedIndex, "utf8");
      currentBuild.files["index.html"] = versionedIndex;
    }
  } catch {}
  await execFileP(process.execPath, ["--check", appFile], { timeout: 10000 });
  const hardwareCompile = await execFileP(PYTHON_BIN, ["-m", "py_compile", hardwareFile], { timeout: 10000 });
  const hardwareRun = await execFileP(PYTHON_BIN, [hardwareFile], { cwd: currentBuild.dir, timeout: 10000 });
  const hardwareResult = parseJsonObject(hardwareRun.stdout, "hardware_app.py output");
  if (!hardwareResult.build_id) throw new Error("hardware_app.py output is missing build_id.");
  if (hardwareResult.build_id !== currentBuild.id) {
    throw new Error(`hardware_app.py build_id mismatch: ${hardwareResult.build_id} !== ${currentBuild.id}`);
  }
  if (!hardwareResult.runtime) throw new Error("hardware_app.py output is missing runtime.");
  const hardwareResultJson = JSON.stringify(hardwareResult, null, 2);
  await fs.writeFile(hardwareResultFile, hardwareResultJson, "utf8");
  delete currentBuild.files["hardware-result.json"];
  for (const file of [indexFile, styleFile, appFile, hardwareFile, manifestFile]) {
    const stat = await fs.stat(file);
    if (!stat.size) throw new Error(`${path.basename(file)} is empty`);
  }
  const hardwareResultStat = await fs.stat(hardwareResultFile);
  if (!hardwareResultStat.size) throw new Error("hardware-result.json is empty");
  const indexSource = await fs.readFile(indexFile, "utf8");
  const appSource = await fs.readFile(appFile, "utf8");
  const hardwareSource = await fs.readFile(hardwareFile, "utf8");
  validateGeneratedFileContracts({
    "index.html": indexSource,
    "app.js": appSource,
    "hardware_app.py": hardwareSource
  }, "Generated app");
  let previousManifest = {};
  try {
    previousManifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  } catch {
    previousManifest = {};
  }
  const spec = createAppSpec(currentBuild.prompt, currentBuild.id);
  const manifest = buildCompileManifest({
    generatedManifest: generatedManifestV2(currentBuild.prompt, currentBuild.id, spec),
    previousManifest,
    pythonBin: PYTHON_BIN,
    hardwareCompileOutput: hardwareCompile,
    targetStatic: BOARD.targetStatic
  });
  await fs.writeFile(path.join(currentBuild.dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  currentBuild.files["manifest.json"] = JSON.stringify(manifest, null, 2);
  currentBuild.manifest = manifest;
  const verificationFiles = {
    "index.html": await fs.readFile(indexFile, "utf8"),
    "style.css": await fs.readFile(styleFile, "utf8"),
    "app.js": await fs.readFile(appFile, "utf8"),
    "hardware_app.py": await fs.readFile(hardwareFile, "utf8"),
    "manifest.json": await fs.readFile(manifestFile, "utf8"),
    "hardware-result.json": hardwareResultJson,
  };
  const verification = await verifyAllLocal(verificationFiles, {
    dir: currentBuild.dir,
    pythonBin: PYTHON_BIN,
    timeoutMs: 15000,
  });
  if (!verification.ok) {
    await appendServerLog("build.failed", {
      id: currentBuild.id,
      issues: (verification.issues || []).map(issue => ({ code: issue.code, message: issue.message })),
    });
    const detail = (verification.issues || [])
      .slice(0, 5)
      .map(issue => `${issue.code}: ${issue.message}`)
      .join("; ");
    throw new Error(`local verification failed: ${detail || verification.summary}`);
  }
  currentBuild.built = true;
  currentBuild.buildEvidence = verification;
  currentBuild.buildEvidence.phase = AGENT_PHASES.LOCAL_VERIFY;
  currentBuild.buildEvidence.summary = "L0-L3 local verification passed";
  currentBuild.buildEvidence.evidence = {
    ...currentBuild.buildEvidence.evidence,
    nodeCheck: "passed",
    pythonCompile: "passed",
    hardwareRun: "passed",
    hardwareResult: "generated/current/hardware-result.json",
    buildId: currentBuild.id,
    pythonBin: PYTHON_BIN,
  };
  if (currentBuild.agentRun) {
    currentBuild.agentRun = appendEvidence(currentBuild.agentRun, currentBuild.buildEvidence);
  }
  await appendServerLog("build.done", {
    id: currentBuild.id,
    phase: currentBuild.buildEvidence.phase,
    issueCount: currentBuild.buildEvidence.issues?.length || 0,
  });
  return manifest;
}

// Capture preview screenshot and return verification report
async function capturePreview() {
  if (!currentBuild) return { ok: false, error: "no build" };
  try {
    await fs.mkdir(PREVIEWS_DIR, { recursive: true });
    const previewPath = path.join(PREVIEWS_DIR, `${currentBuild.id}.png`);
    const reportPath = path.join(PREVIEWS_DIR, `${currentBuild.id}.json`);
    const scriptPath = path.join(ROOT, "screenshot.cjs");
    const url = `http://127.0.0.1:${PORT}/generated/current/index.html`;

    let stdout = "", stderr = "";
    let exitCode = 0;
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath, url, previewPath, reportPath], {
          timeout: 25000,
          stdio: ["ignore", "pipe", "pipe"]
        });
        child.stdout.on("data", d => stdout += d);
        child.stderr.on("data", d => stderr += d);
        child.on("close", code => { exitCode = code; resolve(); });
        child.on("error", reject);
      });
    } catch (spawnErr) {
      exitCode = 1;
      stderr = spawnErr.message;
    }

    // Parse report from stdout
    let report = { ok: false, consoleErrors: [], pageErrors: [], isBlank: false };
    const reportMatch = stdout.match(/__REPORT__(.*)/);
    if (reportMatch) {
      try { report = JSON.parse(reportMatch[1]); } catch {}
    }

    // Also try reading from report file
    if (!report.ok) {
      try {
        const fileReport = await fs.readFile(reportPath, "utf8");
        report = JSON.parse(fileReport);
      } catch {}
    }

    // Set preview path if screenshot exists
    try {
      const stat = await fs.stat(previewPath);
      if (stat.size > 0) {
        currentBuild.previewPath = previewPath;
      }
    } catch {}

    report.screenshot = previewPath;
    return report;
  } catch (err) {
    console.error("[capturePreview] Failed:", err.message);
    return { ok: false, error: err.message, consoleErrors: [], pageErrors: [], isBlank: false };
  }
}

async function verifyGoldenLoop(expectedId = currentBuild?.id) {
  if (!expectedId) throw new Error("No build id available for golden-loop verification.");

  const remote = buildGoldenLoopRemoteCommand({
    targetStatic: BOARD.targetStatic,
    service: BOARD.service
  });
  const raw = await ssh(remote, 30000);
  return buildGoldenLoopResult({
    expectedId,
    sections: parseGoldenLoopSections(raw),
    route: activeEndpoint ? endpointLabel(activeEndpoint) : "",
    serviceName: BOARD.service
  });
}

async function deployCurrent() {
  console.log("[deployCurrent] Starting...");
  await loadGeneratedBuild();
  if (!currentBuild) {
    console.error("[deployCurrent] No currentBuild");
    throw new Error("No generated app. Generate first.");
  }
  console.log("[deployCurrent] currentBuild.id:", currentBuild.id);
  if (!currentBuild.built) {
    console.log("[deployCurrent] Building...");
    await buildCurrent();
  }

  const {
    release,
    compilePath,
    programPath
  } = buildDeployPaths(BOARD, currentBuild.id);
  console.log("[deployCurrent] Creating release dir:", release);
  await ssh(`mkdir -p ${shQuote(release)} ${shQuote(BOARD.backupRoot)}`, 45000);
  console.log("[deployCurrent] Uploading files...");
  await uploadBundle(buildDeployUploadEntries({
    currentBuild,
    board: BOARD,
    runtimeDir: RUNTIME_DIR
  }), 60000);

  const remote = buildDeployRemoteCommand({
    board: BOARD,
    buildId: currentBuild.id
  });

  console.log("[deployCurrent] Executing remote commands...");
  const output = await ssh(remote, 45000);
  console.log("[deployCurrent] Remote execution completed");
  currentBuild.deployed = true;
  const { backup } = parseDeployOutput(output);
  let compileLog = "";
  let hardwareResultRaw = "";
  try {
    compileLog = await ssh(`cat ${shQuote(compilePath)} 2>/dev/null || true`, 10000);
  } catch (error) {
    compileLog = `post-deploy compile log unavailable: ${error.message}`;
  }
  try {
    hardwareResultRaw = await ssh(`cat ${shQuote(programPath)} 2>/dev/null || true`, 10000);
  } catch (error) {
    hardwareResultRaw = "";
  }
  let hardwareResult = null;
  try {
    hardwareResult = hardwareResultRaw ? JSON.parse(hardwareResultRaw) : null;
  } catch {}
  let goldenLoop = null;
  try {
    goldenLoop = await verifyGoldenLoop(currentBuild.id);
  } catch (error) {
    goldenLoop = buildPostDeployVerificationFailure({
      buildId: currentBuild.id,
      route: activeEndpoint ? endpointLabel(activeEndpoint) : "",
      error
    });
  }
  lastDeploy = {
    id: currentBuild.id,
    backup,
    output,
    compileLog,
    hardwareResult,
    hardwareResultRaw,
    programPath,
    compilePath,
    goldenLoop
  };
  return lastDeploy;
}

async function boardStatus() {
  const raw = await ssh("curl -fsS http://127.0.0.1:8765/api/status", 10000);
  const status = JSON.parse(raw);
  return {
    connected: true,
    board: {
      id: BOARD.id,
      label: BOARD.label,
      host: activeEndpoint?.host || BOARD.host,
      port: String(activeEndpoint?.port || BOARD.port),
      route: activeEndpoint?.name || "configured",
      frpHost: BOARD.frpHost,
      frpPort: BOARD.frpPort,
      user: BOARD.user,
      targetStatic: BOARD.targetStatic
    },
    hostname: status.hostname || "taishan",
    kernel: status.kernel || "",
    wifi: status.network?.wifi || "",
    ip: status.network?.addresses?.[0] || "",
    temp: status.cpu_temp ?? null,
    memory: status.memory ? `${Number(status.memory.percent || 0).toFixed(1)}%` : "",
    service: status.services?.display || "",
    ssh: status.services?.ssh || "",
    frpc: status.services?.frpc || ""
  };
}

function offlineBoardStatus(error = null) {
  const cached = boardStatusCache.get(BOARD.id)?.status || null;
  return {
    connected: false,
    error: error?.message || "",
    board: {
      ...publicBoardConfig(),
      targetStatic: BOARD.targetStatic
    },
    hostname: cached?.hostname || "",
    kernel: cached?.kernel || "",
    wifi: cached?.wifi || "",
    ip: cached?.ip || "",
    temp: cached?.temp ?? null,
    memory: cached?.memory || "",
    service: cached?.service || "",
    ssh: "",
    frpc: cached?.frpc || ""
  };
}

function refreshBoardStatus() {
  const deviceId = BOARD.id;
  if (!boardStatusRefreshPromises.has(deviceId)) {
    const refresh = boardStatus()
      .then(status => {
        boardStatusCache.set(deviceId, { status, fetchedAt: Date.now() });
        return status;
      })
      .catch(error => {
        const status = offlineBoardStatus(error);
        boardStatusCache.set(deviceId, { status, fetchedAt: Date.now() });
        return status;
      })
      .finally(() => {
        boardStatusRefreshPromises.delete(deviceId);
      });
    boardStatusRefreshPromises.set(deviceId, refresh);
  }
  return boardStatusRefreshPromises.get(deviceId);
}

async function fastBoardStatus() {
  const now = Date.now();
  const cached = boardStatusCache.get(BOARD.id) || null;
  if (cached?.status && now - cached.fetchedAt < 15000) {
    return cached.status;
  }
  if (cached?.status) {
    return cached.status;
  }
  return refreshBoardStatus();
}

function fastRawBoardStatus() {
  const cached = boardStatusCache.get(BOARD.id)?.status || null;
  refreshBoardStatus().catch(error => {
    console.warn("[board] background status refresh failed:", error.message);
  });
  const connected = Boolean(cached?.connected);
  return {
    ok: connected,
    connected,
    mode: connected ? "real" : "offline-simulated",
    skipped: !connected,
    verificationMode: connected ? "real-ready" : "local-simulated",
    message: connected ? "Board connected." : "No board route is currently connected; local simulation remains available.",
    hostname: cached?.hostname || "",
    kernel: cached?.kernel || "",
    cpu_temp: cached?.temp ?? null,
    memory: cached?.memory ? { percent: Number.parseFloat(cached.memory) || 0 } : null,
    network: {
      wifi: cached?.wifi || "",
      addresses: cached?.ip ? [cached.ip] : []
    },
    services: {
      display: cached?.service || "",
      ssh: cached?.ssh || "",
      frpc: cached?.frpc || ""
    },
    board: cached?.board || {
      id: BOARD.id,
      label: BOARD.label,
      host: BOARD.host,
      port: String(BOARD.port),
      targetStatic: BOARD.targetStatic,
    },
  };
}

async function rawBoardStatus() {
  const raw = await ssh("curl -fsS http://127.0.0.1:8765/api/status", 10000);
  return JSON.parse(raw);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("not file");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": staticCacheFor(filePath)
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function readServerLogTail(limit = 80) {
  try {
    const raw = await fs.readFile(SERVER_LOG_PATH, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(Number(limit) || 80, 500)))
      .map(line => {
        try {
          return compactForLog(JSON.parse(line));
        } catch {
          return { raw: compactForLog(line) };
        }
      });
  } catch {
    return [];
  }
}


// ==================== Error Classification ====================
function classifyError(error) {
  const llmText = [
    error?.type || "",
    error?.code || "",
    error?.status ? `HTTP ${error.status}` : "",
    error?.endpoint || "",
    error?.providerMessage || "",
    error?.message || "",
    error?.stdout || "",
    error?.stderr || ""
  ].join("\n");

  if (/LLM_TIMEOUT|llm.*timeout|model.*timeout/i.test(llmText)) {
    return { errorType: "llm_timeout", errorLabel: "AI model timeout" };
  }
  if (/not configured|no api key|NO_API_KEY/i.test(llmText)) {
    return { errorType: "no_api_key", errorLabel: "AI model not configured" };
  }
  if (/LLM_CALL_FAILED|llm.*fail|model.*fail/i.test(llmText)) {
    if (/HTTP\s*(?:401|403)|api key|invalid|unauthorized|forbidden|Authentication Fails|authentication failed|auth/i.test(llmText)) {
      return { errorType: "llm_auth", errorLabel: "AI model authentication failed" };
    }
    return { errorType: "llm_failed", errorLabel: "AI model call failed" };
  }

  const text = [
    error?.message || "",
    error?.stdout || "",
    error?.stderr || ""
  ].join("\n");

  if (/timed out|ETIMEDOUT|timeout/i.test(text)) {
    return { errorType: "ssh_timeout", errorLabel: "设备连接超时" };
  }
  if (/ECONNREFUSED|Connection refused/i.test(text)) {
    return { errorType: "connection_refused", errorLabel: "设备拒绝连接" };
  }
  if (/Unable to reach|NoValidConnectionsError|Unable to connect/i.test(text)) {
    return { errorType: "board_offline", errorLabel: "设备离线" };
  }
  if (/Permission denied|Authentication failed|auth/i.test(text)) {
    return { errorType: "auth_failed", errorLabel: "设备认证失败" };
  }
  if (/Connection reset|Connection closed|EOFError/i.test(text)) {
    return { errorType: "connection_dropped", errorLabel: "设备连接中断" };
  }
  if (/mkdir|No space left|ENOSPC/i.test(text)) {
    return { errorType: "deploy_mkdir", errorLabel: "设备存储空间不足" };
  }
  if (/scp|upload|copy/i.test(text) && /fail|error/i.test(text)) {
    return { errorType: "deploy_copy", errorLabel: "文件写入设备失败" };
  }
  if (/syntax.?error|SyntaxError|unexpected token/i.test(text)) {
    return { errorType: "syntax_error", errorLabel: "代码语法错误" };
  }
  if (/IndentationError|TabError|NameError|python/i.test(text) && /error/i.test(text)) {
    return { errorType: "python_syntax", errorLabel: "硬件代码语法错误" };
  }
  if (/systemctl|service.*restart|Failed to restart/i.test(text)) {
    return { errorType: "deploy_service", errorLabel: "设备服务重启失败" };
  }
  if (/HTTP.*(?:502|503|504)|connection refused.*curl/i.test(text)) {
    return { errorType: "deploy_http", errorLabel: "设备 HTTP 服务无响应" };
  }
  if (/not configured|no api key|NO_API_KEY/i.test(text)) {
    return { errorType: "no_api_key", errorLabel: "未配置 AI 模型" };
  }
  if (/LLM_CALL_FAILED|llm.*fail|model.*fail/i.test(text)) {
    return { errorType: "llm_failed", errorLabel: "AI 模型调用失败" };
  }
  if (/LLM_TIMEOUT|llm.*timeout|model.*timeout/i.test(text)) {
    return { errorType: "llm_timeout", errorLabel: "AI 模型响应超时" };
  }
  if (/达到最大迭代次数|maximum iterations|max iterations|未确认完成|Agent 未生成完整项目/i.test(text)) {
    return { errorType: "generate_failed", errorLabel: "AI 生成未完成" };
  }
  if (/Prompt is required|empty.*prompt/i.test(text)) {
    return { errorType: "empty_prompt", errorLabel: "请输入你的需求" };
  }
  if (/no code|has no code/i.test(text)) {
    return { errorType: "no_code", errorLabel: "此应用为示例预览" };
  }
  if (/Deploy failed/i.test(text)) {
    return { errorType: "deploy_failed", errorLabel: "部署失败" };
  }
  return { errorType: "unknown", errorLabel: error?.message || "操作失败" };
}

function formatProjectMemoryForPrompt(memory = {}) {
  const normalized = normalizeProjectMemory(memory);
  const lines = [];
  if (normalized.summary) lines.push(`摘要: ${normalized.summary}`);
  if (normalized.goal) lines.push(`目标: ${normalized.goal}`);
  if (normalized.requirements.length) lines.push(`功能需求:\n${normalized.requirements.map(item => `- ${item}`).join("\n")}`);
  if (normalized.constraints.length) lines.push(`约束:\n${normalized.constraints.map(item => `- ${item}`).join("\n")}`);
  if (normalized.decisions.length) lines.push(`已确认方案:\n${normalized.decisions.map(item => `- ${item}`).join("\n")}`);
  if (normalized.open_questions.length) lines.push(`未解决问题:\n${normalized.open_questions.map(item => `- ${item}`).join("\n")}`);
  if (!lines.length) return "";
  return `\n\n## 当前项目记忆\n${lines.join("\n")}`;
}

async function route(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/board") {
      const deviceId = deviceIdFrom(Object.fromEntries(url.searchParams.entries()), BOARD.id);
      const status = await withDevice(deviceId, () => fastBoardStatus());
      json(res, 200, { ok: true, ...status });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/board-config") {
      const deviceId = deviceIdFrom(Object.fromEntries(url.searchParams.entries()), BOARD.id);
      const boardConfig = await withDevice(deviceId, () => publicBoardConfig());
      json(res, 200, { ok: true, boardConfig, devices: publicDeviceProfiles() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/board-config") {
      const body = await readBody(req);
      selectDevice(deviceIdFrom(body || {}, BOARD.id));
      const boardConfig = updateBoardConfig(body || {});
      let status = null;
      try {
        status = await boardStatus();
      } catch (error) {
        json(res, 200, {
          ok: true,
          boardConfig,
          connected: false,
          error: error.message
        });
        return;
      }
      json(res, 200, {
        ok: true,
        boardConfig: publicBoardConfig(),
        connected: true,
        status
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const deviceId = deviceIdFrom(Object.fromEntries(url.searchParams.entries()), BOARD.id);
      json(res, 200, await withDevice(deviceId, () => fastRawBoardStatus()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/logs") {
      const limit = Number(url.searchParams.get("limit") || 80);
      json(res, 200, { ok: true, logs: await readServerLogTail(limit) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/verify") {
      const deviceId = deviceIdFrom(Object.fromEntries(url.searchParams.entries()), BOARD.id);
      const id = url.searchParams.get("id") || currentBuild?.id || lastDeploy?.id || "";
      if (!hasBoardCredentials()) {
        json(res, 200, { ok: true, skipped: true, mode: "offline-simulated", goldenLoop: buildOfflineGoldenLoop(id) });
        return;
      }
      const goldenLoop = await withDevice(deviceId, () => verifyGoldenLoop(id));
      json(res, 200, { ok: true, goldenLoop });
      return;
    }
    // --- Chat: 对话式规划（不生成代码） ---
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readBody(req);
      const rawMessages = Array.isArray(body.messages) ? body.messages : [];
      const conversationId = String(body.conversation_id || "").trim();
      const modelSettings = normalizeModelSettings(body.modelSettings || {});
      const projectMemory = conversationId ? conversationStore.getProjectMemory(conversationId) : normalizeProjectMemory();

      if (!modelSettings.enabled) {
        json(res, 200, {
          ok: true,
          intent: "chat",
          reply: "请先在右上角 Model 里配置可用的大模型。配置后我会先和你对话、梳理需求，只有你确认开始构建时才生成代码。",
          ready_to_build: false,
          build_prompt: "",
          project_memory: projectMemory
        });
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        const plan = await planChatWithModel(
          modelSettings,
          rawMessages,
          memoryStore.getAll(),
          projectMemory,
          (url, options = {}) => fetch(url, { ...options, signal: controller.signal })
        );
        if (conversationId && plan.project_memory) {
          conversationStore.setProjectMemory(conversationId, plan.project_memory);
        }
        clearTimeout(timeout);
        json(res, 200, { ok: true, ...plan });
      } catch (err) {
        clearTimeout(timeout);
        const classified = classifyError(err);
        json(res, 500, { ok: false, error: err.message, ...classified });
      }
      return;
    }
    // --- Clarify: 实时需求细化 ---
    if (req.method === "POST" && url.pathname === "/api/clarify") {
      const body = await readBody(req);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) { json(res, 400, { ok: false, error: "Prompt is required." }); return; }

      const modelSettings = normalizeModelSettings(body.modelSettings || {});
      if (!modelSettings.enabled) { json(res, 200, { ok: true, questions: null, source: "skip" }); return; }

      const rawHistory = Array.isArray(body.history) ? body.history : [];
      const preferences = memoryStore.getAll();

      const result = await analyzeAndClarify(modelSettings, prompt, preferences, rawHistory);
      json(res, 200, { ok: true, questions: result, source: result ? "llm" : "skip" });
      return;
    }

    // --- Preferences: 用户偏好 CRUD ---
    if (req.method === "GET" && url.pathname === "/api/preferences") {
      json(res, 200, { ok: true, preferences: memoryStore.getAll() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/preferences") {
      const body = await readBody(req);
      const { key, value, label, category, source } = body;
      if (!key || !value) { json(res, 400, { ok: false, error: "key and value required" }); return; }
      memoryStore.set(key, value, { label, category, source: source || "user" });
      json(res, 200, { ok: true, preferences: memoryStore.getAll() });
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/preferences") {
      const body = await readBody(req);
      if (body.key) memoryStore.remove(body.key);
      else if (body.category) memoryStore.removeCategory(body.category);
      json(res, 200, { ok: true, preferences: memoryStore.getAll() });
      return;
    }

    // --- Experience: Agent 经验查询 ---
    if (req.method === "GET" && url.pathname === "/api/experience") {
      const taskType = url.searchParams.get("type") || "general";
      const lessons = experienceStore.getLessons(taskType, 10);
      const stats = experienceStore.getStats(taskType);
      json(res, 200, { ok: true, lessons, stats });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/playbooks") {
      const taskType = url.searchParams.get("type") || "general";
      const signature = url.searchParams.get("signature") || "";
      const limit = Number(url.searchParams.get("limit") || 10);
      const playbooks = playbookStore.findPlaybooks({ taskType, signature, limit });
      json(res, 200, { ok: true, playbooks });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/playbooks") {
      const body = await readBody(req);
      const playbook = playbookStore.recordPlaybook(body || {});
      json(res, 200, { ok: true, playbook });
      return;
    }

    // --- Generate: AI 代码生成 ---
    if (req.method === "POST" && url.pathname === "/api/generate") {
      const body = await readBody(req);
      const rawPrompt = String(body.prompt || "").trim();
      if (!rawPrompt) throw new Error("Prompt is required.");
      const rawHistory = Array.isArray(body.history) ? body.history : [];
      const normalizedHistory = normalizeGenerateHistory(rawHistory);
      const clarifyAnswers = Array.isArray(body.clarify_answers) ? body.clarify_answers : [];
      const modelSettings = body.modelSettings || {};
      const conversationId = String(body.conversation_id || "").trim();
      const projectMemory = conversationId ? conversationStore.getProjectMemory(conversationId) : normalizeProjectMemory();
      const conversationFiles = conversationId
        ? conversationStore.loadConversationFiles(conversationId).files
        : {};

      // Compress history
      const history = await compressHistory(normalizedHistory, normalizeModelSettings(modelSettings));
      const settings = normalizeModelSettings(modelSettings);

      // 构建精细化 prompt（合并 clarify 答案 + 用户偏好）
      const userPreferences = memoryStore.getAll();
      const prompt = buildRefinedPrompt(`${rawPrompt}${formatProjectMemoryForPrompt(projectMemory)}`, clarifyAnswers, userPreferences);

      // 保存用户选择的偏好到记忆（LLM 自动提取）
      if (clarifyAnswers.length > 0) {
        for (const ans of clarifyAnswers) {
          if (ans.key && ans.answer) {
            memoryStore.set(ans.key, ans.answer, {
              label: ans.question || ans.key,
              category: "clarify",
              source: "auto_extract",
            });
          }
        }
      }

      if (!settings.enabled) {
        // Fallback to template if no model configured
        const build = await writeGenerated(prompt, modelSettings, []);
        if (conversationId) {
          try {
            conversationStore.saveConversationFiles(conversationId, build.id, build.files);
          } catch (saveErr) {
            await appendServerLog("generate.template.conversation_save_failed", {
              id: build.id,
              conversationId,
              error: saveErr.message,
            });
          }
        }
        json(res, 200, {
          ok: true, id: build.id, files: build.files,
          manifest: build.manifest || null, source: "template",
          spec: build.agentRun?.spec || null,
          evidence: formatRunEvidence(build.agentRun || {}),
          buildEvidence: build.buildEvidence || null,
          verificationMode: boardPassword ? "real-ready" : "local-simulated",
          agentActions: [], thinking: ""
        });
        return;
      }

      // Prepare file store from this project only. Chat history alone does not
      // mean the user is editing existing code.
      const fileStore = { ...conversationFiles };
      const isEditing = Object.keys(fileStore).some(name => name !== "manifest.json");
      const agentStartedAt = Date.now();

      // Run the coding agent
      console.log(`[generate] Agent starting (${isEditing ? "edit" : "new"} mode)`);
      const agentSettings = {
        ...settings,
        maxIterations: positiveInt(process.env.VIBEBOARD_AGENT_MAX_ITERATIONS, DEFAULT_GENERATE_AGENT_MAX_ITERATIONS),
        maxVerificationAttempts: positiveInt(process.env.VIBEBOARD_AGENT_MAX_VERIFICATION_ATTEMPTS, DEFAULT_GENERATE_AGENT_MAX_VERIFICATION_ATTEMPTS),
        timeoutMs: positiveInt(process.env.VIBEBOARD_AGENT_TIMEOUT_MS, DEFAULT_GENERATE_AGENT_TIMEOUT_MS),
        llmTimeoutMs: positiveInt(process.env.VIBEBOARD_AGENT_LLM_TIMEOUT_MS, DEFAULT_GENERATE_AGENT_LLM_TIMEOUT_MS),
      };
      await appendServerLog("generate.agent.start", {
        prompt: prompt.slice(0, 160),
        isEditing,
        fileCount: Object.keys(fileStore).length,
        files: Object.keys(fileStore).slice(0, 12),
        model: settings.model,
        provider: settings.provider,
        maxIterations: agentSettings.maxIterations,
        maxVerificationAttempts: agentSettings.maxVerificationAttempts,
        timeoutMs: agentSettings.timeoutMs,
        llmTimeoutMs: agentSettings.llmTimeoutMs,
      });
      let agentResult;
      try {
        agentResult = await runAgent(agentSettings, prompt, fileStore, history, (action) => {
          console.log(`[agent] ${action.tool}: ${action.args?.path || action.args?.query || action.args?.summary || ""}`);
          appendServerLog("generate.agent.action", {
            tool: action.tool,
            path: action.args?.path || "",
            query: action.args?.query || "",
            summary: action.args?.summary || "",
          }).catch(() => {});
        }, userPreferences, experienceStore, { ssh, scp, board: BOARD });
      } catch (agentErr) {
        await appendServerLog("generate.agent.failed", {
          error: agentErr.message,
          ...structuredErrorFieldsForLog(agentErr),
          durationMs: Date.now() - agentStartedAt,
        });
        throw agentErr;
      }

      if (!agentResult.success) {
        await appendServerLog("generate.agent.failed", {
          error: agentResult.summary || "Agent failed",
          agentError: agentResult.error || null,
          actionCount: agentResult.actions?.length || 0,
          limit: agentResult.limit || "",
          iteration: agentResult.iteration ?? null,
          durationMs: Date.now() - agentStartedAt,
        });
        const error = new Error(agentResult.summary || "Agent failed");
        if (agentResult.error && typeof agentResult.error === "object") {
          Object.assign(error, agentResult.error);
        }
        throw error;
      }

      // Ensure hardware_app.py and manifest exist
      const id = buildId();
      const agentFiles = agentResult.files;

      if (!agentFiles["hardware_app.py"]) {
        const spec = createAppSpec(prompt, id);
        agentFiles["hardware_app.py"] = generatedHardwareAppV2(prompt, id, spec);
      }
      agentFiles["hardware_app.py"] = injectHardwareAppContractsV2(agentFiles["hardware_app.py"], id);

      const spec = createAppSpec(prompt, id);
      const manifest = generatedManifestV2(prompt, id, spec, {
        generator: "vibeboard-agent-v1",
        title: prompt.slice(0, 40),
        source: "agent",
        model: settings.model,
        provider: settings.provider,
        notes: agentResult.summary,
        target: BOARD.targetStatic
      });
      agentFiles["manifest.json"] = JSON.stringify(manifest, null, 2);

      // Write to disk
      await writeGeneratedFiles(GENERATED_DIR, agentFiles);
      let agentRun = transitionRun(createAgentRun({
        prompt,
        mode: "agent",
        buildId: id,
        hardwareMode: boardPassword ? "real" : "simulated",
      }), AGENT_PHASES.CODE, {
        spec: buildInitialSpec(prompt, { requireBoard: Boolean(boardPassword) }),
      });
      agentRun = appendEvidence(agentRun, {
        phase: AGENT_PHASES.CODE,
        ok: true,
        summary: agentResult.summary || "agent code completed",
        evidence: {
          whatWorked: agentResult.whatWorked || [],
          whatFailed: agentResult.whatFailed || [],
          actionCount: agentResult.actions?.length || 0,
        },
        issues: [],
      });
      currentBuild = { id, prompt, files: agentFiles, dir: GENERATED_DIR, built: false, deployed: false, manifest, agentRun };

      // Auto-build
      try {
        await buildCurrent();
      } catch (buildErr) {
        console.error("[generate] Build error:", buildErr.message);
        await appendServerLog("generate.agent.build_failed", { id, error: buildErr.message });
        throw new Error(`Generated app failed validation: ${buildErr.message}`);
      }
      recordAgentLearning({
        prompt,
        agentResult,
        verificationResult: currentBuild.buildEvidence || null,
        success: true,
      });

      // Save to conversation
      const convId = body.conversation_id || null;
      if (convId) {
        try {
          conversationStore.saveConversationFiles(convId, id, agentFiles);
        } catch (saveErr) {
          await appendServerLog("generate.agent.conversation_save_failed", {
            id,
            conversationId: convId,
            error: saveErr.message,
          });
        }
      }

      await appendServerLog("generate.agent.done", {
        id,
        actionCount: agentResult.actions?.length || 0,
        durationMs: Date.now() - agentStartedAt,
      });
      json(res, 200, {
        ok: true,
        id,
        files: agentFiles,
        manifest,
        source: "agent",
        spec: currentBuild.agentRun?.spec || null,
        evidence: formatRunEvidence(currentBuild.agentRun || {}),
        buildEvidence: currentBuild.buildEvidence || null,
        verificationMode: boardPassword ? "real-ready" : "local-simulated",
        agentSummary: agentResult.summary,
        agentActions: agentResult.actions.map(a => ({
          tool: a.tool,
          path: a.args?.path,
          query: a.args?.query,
          summary: a.args?.summary
        }))
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/build") {
      const manifest = await buildCurrent();
      // Capture preview screenshot after successful build
      capturePreview().catch(err => console.error("[build] preview capture failed:", err.message));
      json(res, 200, {
        ok: true,
        summary: `${manifest.files.length} files`,
        manifest,
        buildEvidence: currentBuild?.buildEvidence || null,
        evidence: formatRunEvidence(currentBuild?.agentRun || {}),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/deploy") {
      try {
        const body = await readBody(req);
        const deviceId = deviceIdFrom(body || {}, BOARD.id);
        if (!hasBoardCredentials()) {
          if (!currentBuild) await loadGeneratedBuild();
          if (currentBuild && (!currentBuild.built || !currentBuild.buildEvidence)) await buildCurrent();
          const result = buildOfflineDeployResult();
          lastDeploy = result;
          await appendServerLog("deploy.skipped", { id: currentBuild?.id || "", mode: result.mode });
          json(res, 200, { ok: true, deviceId, ...result });
          return;
        }
        console.log("[deploy] Starting deploy...");
        await appendServerLog("deploy.start", { id: currentBuild?.id || "", deviceId });
        const result = await withDeployLock(() => withDevice(deviceId, () => deployCurrent()));
        console.log("[deploy] Deploy completed successfully");
        await appendServerLog("deploy.done", { id: result.id, goldenLoopOk: result.goldenLoop?.ok });
        json(res, 200, { ok: true, deviceId, ...result });
      } catch (error) {
        console.error("[deploy] Error:", error.message);
        console.error("[deploy] Stack:", error.stack);
        if (error.stdout) console.error("[deploy] stdout:", error.stdout);
        if (error.stderr) console.error("[deploy] stderr:", error.stderr);
        const classified = classifyError(error);
        json(res, 500, {
          ok: false,
          error: error.message,
          ...classified,
          stdout: error.stdout || "",
          stderr: error.stderr || ""
        });
      }
      return;
    }

    // Conversation APIs
    if (req.method === "GET" && url.pathname === "/api/conversations") {
      const conversations = conversationStore.listConversations();
      json(res, 200, { ok: true, conversations });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/conversations") {
      const conversation = conversationStore.createConversation();
      json(res, 200, { ok: true, id: conversation.id, title: conversation.title });
      return;
    }
    // Delete conversation and its messages
    if (req.method === "DELETE" && url.pathname.startsWith("/api/conversations/")) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      if (convId && !parts[4]) {
        conversationStore.deleteConversation(convId);
        json(res, 200, { ok: true });
      } else {
        json(res, 400, { ok: false, error: "Invalid conversation ID" });
      }
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/messages")) {
      const convId = url.pathname.split("/")[3];
      const messages = conversationStore.listMessages(convId);
      json(res, 200, { ok: true, messages });
      return;
    }
    // Load saved files for a conversation (for state restoration)
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/files")) {
      const convId = url.pathname.split("/")[3];
      const { buildId, files } = conversationStore.loadConversationFiles(convId);
      json(res, 200, { ok: true, buildId, files });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/memory")) {
      const convId = url.pathname.split("/")[3];
      json(res, 200, { ok: true, project_memory: conversationStore.getProjectMemory(convId) });
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/messages")) {
      const convId = url.pathname.split("/")[3];
      const body = await readBody(req);
      conversationStore.appendMessage(convId, body);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/conversations/")) {
      const convId = url.pathname.split("/")[3];
      conversationStore.deleteConversation(convId);
      json(res, 200, { ok: true });
      return;
    }

    // Market APIs
    if (req.method === "GET" && url.pathname === "/api/market") {
      const dbApps = query("SELECT id, conversation_id, name, description, preview_url, author, downloads, created_at FROM market_apps ORDER BY created_at DESC")
        .map(app => ({ ...app, source: "database" }));
      const apps = mergeMarketApps(dbApps, await loadStaticMarketApps());
      json(res, 200, { ok: true, apps });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/market/publish") {
      const body = await readBody(req);
      const { conversation_id, name, description } = body;
      if (!name) throw new Error("App name is required.");

      // Get current generated code
      let codeJson = "{}";
      if (currentBuild && currentBuild.files) {
        codeJson = JSON.stringify(currentBuild.files);
      } else {
        // Try to read from generated/current directory
        try {
          const files = await readGeneratedFiles(GENERATED_DIR, GENERATED_FILE_NAMES);
          if (Object.keys(files).length > 0) {
            codeJson = JSON.stringify(files);
          }
        } catch {}
      }

      // Get preview image if available
      let preview_url = "";
      if (currentBuild && currentBuild.previewPath) {
        preview_url = `/api/previews/${currentBuild.id}.png`;
      } else {
        // Check if preview file exists on disk
        const previewFile = path.join(PREVIEWS_DIR, `${currentBuild?.id || "unknown"}.png`);
        try {
          await fs.access(previewFile);
          preview_url = `/api/previews/${currentBuild.id}.png`;
        } catch {}
      }
      const id = randomUUID();
      const author = "user";

      run(
        "INSERT INTO market_apps (id, conversation_id, name, description, code, preview_url, author) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, conversation_id || null, name, description || "", codeJson, preview_url, author]
      );

      json(res, 200, { ok: true, id });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/market/") && !url.pathname.includes("/deploy")) {
      const appId = url.pathname.split("/")[3];
      const apps = query("SELECT * FROM market_apps WHERE id = ?", [appId]);
      if (apps.length === 0) {
        json(res, 404, { ok: false, error: "App not found" });
        return;
      }
      json(res, 200, { ok: true, app: apps[0] });
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/market/") && url.pathname.endsWith("/deploy")) {
      const appId = url.pathname.split("/")[3];

      try {
        const body = await readBody(req);
        const deviceId = deviceIdFrom(body || {}, BOARD.id);
        const result = await withDeployLock(async () => {
          return withDevice(deviceId, async () => {
            // Get app from market
            const apps = query("SELECT * FROM market_apps WHERE id = ?", [appId]);
            const isStaticApp = apps.length === 0;
            if (isStaticApp) {
              const staticApps = await loadStaticMarketApps();
              if (!staticApps.some(app => app.id === appId)) {
                const error = new Error("App not found");
                error.statusCode = 404;
                throw error;
              }
            }
            if (apps.length === 0 && !isStaticApp) {
              const error = new Error("App not found");
              error.statusCode = 404;
              throw error;
            }

            const app = apps[0] || null;
            let codeFiles = {};
            if (app) {
              try {
                codeFiles = JSON.parse(app.code || "{}");
              } catch {}
            } else {
              codeFiles = await readStaticMarketCode(appId);
            }

            if (Object.keys(codeFiles).length === 0) {
              const error = new Error("App has no code to deploy");
              error.statusCode = 400;
              throw error;
            }

            // Write code to generated/current directory
            const generatedFiles = Object.fromEntries(Object.entries(codeFiles).filter(([filename]) => (
              GENERATED_FILE_NAMES.includes(filename)
            )));
            await writeGeneratedFiles(GENERATED_DIR, generatedFiles);
            await loadGeneratedBuild();
            console.log("[marketDeploy] requested app:", appId, "loaded build:", currentBuild?.id, "device:", BOARD.id);

            await buildCurrent();
            const deployResult = await deployCurrent();

            // Increment download count
            if (app) run("UPDATE market_apps SET downloads = downloads + 1 WHERE id = ?", [appId]);

            return deployResult;
          });
        });

        json(res, 200, {
          ok: true,
          message: "App deployed successfully",
          deviceId,
          deployId: result.id
        });
      } catch (deployErr) {
        const classified = classifyError(deployErr);
        if (deployErr.statusCode) {
          json(res, deployErr.statusCode, { ok: false, error: deployErr.message, ...classified });
        } else {
          json(res, 500, { ok: false, error: deployErr.message, ...classified });
        }
      }
      return;
    }

    // Serve preview images
    if (req.method === "GET" && url.pathname.startsWith("/api/previews/")) {
      const filename = url.pathname.split("/").pop();
      const previewFile = path.join(PREVIEWS_DIR, filename);
      try {
        const stat = await fs.stat(previewFile);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": stat.size,
          "Cache-Control": "public, max-age=86400"
        });
        createReadStream(previewFile).pipe(res);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Preview not found");
      }
      return;
    }

    if (req.url.startsWith("/api/")) {
      json(res, 404, { ok: false, error: "API not found" });
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    const classified = classifyError(error);
    json(res, 500, {
      ok: false,
      error: error.message,
      ...classified,
      stdout: error.stdout,
      stderr: error.stderr
    });
  }
}

await ensureInitialGenerated();

http.createServer(route).listen(PORT, "127.0.0.1", () => {
  console.log(`VibeBoard MVP listening on http://127.0.0.1:${PORT}/ -> ${BOARD.id}:${BOARD.port}`);
});
