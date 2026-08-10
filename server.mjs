import http from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { neon } from "@neondatabase/serverless";
import { createAuthStore, clearSessionCookie, httpError, sessionCookie } from "./src/authStore.mjs";
import { createCloudSqliteSnapshot } from "./src/cloudSqliteSnapshot.mjs";
import { createPhoneVerificationService } from "./src/phoneVerification.mjs";
import { buildBoardCatalog } from "./src/boardCatalog.mjs";
import { createTelemetryStore } from "./src/telemetryStore.mjs";
import { creditsForTokens, estimateTokensFromPayload, tokensFromModelResponse } from "./src/creditMeter.mjs";
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
import { normalizeProjectMemory } from "./src/conversationStore.mjs";
import { createProjectPersistence } from "./src/projectPersistence.mjs";
import { runAgent } from "./src/agent.mjs";
import { chatCompletionsUrl, normalizeModelSettings } from "./src/modelSettings.mjs";
import { createMemoryStore } from "./src/memoryStore.mjs";
import { declaredAssetPathsFromFiles } from "./src/assetContract.mjs";
import { createAssetLibraryStore } from "./src/assetLibrary.mjs";
import { createProjectWorkspace } from "./src/projectWorkspace.mjs";
import { createDigitalLifeStore } from "./src/digitalLife.mjs";
import { createDigitalLifeRoutes } from "./src/digitalLifeRoutes.mjs";
import { createExperienceStore, makePlaybookCandidate } from "./src/experienceStore.mjs";
import { createPlaybookStore } from "./src/playbookStore.mjs";
import { createJobRuntime } from "./src/jobRuntime.mjs";
import { executionContextFromRequest } from "./src/executionContext.mjs";
import { verifyAllLocal } from "./src/verifiers/index.mjs";
import { classifyError } from "./src/errorClassifier.mjs";
import { analyzeAndClarify } from "./src/clarifyEngine.mjs";
import { createAgentOrchestrator } from "./src/agentOrchestrator.mjs";
import {
  createGenerateRuntime,
  embedGeneratedAssetsInFiles,
} from "./src/generateRuntime.mjs";
import { createBuildRuntime } from "./src/buildRuntime.mjs";
import { createPreviewRuntime } from "./src/previewRuntime.mjs";
import { createMarketRuntime } from "./src/marketRuntime.mjs";
import {
  AUDIO_RUNTIME_APIS,
  HARDWARE_APP_CONTRACT,
  HARDWARE_RESULT_FILE,
  hardwareContractPromptText,
  validationRulesText
} from "./src/contracts.mjs";
import {
  AGENT_PHASES,
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
  ensureGeneratedWorkspace,
  loadGeneratedWorkspace,
  readGeneratedFiles,
  writeGeneratedFiles
} from "./src/buildArtifact.mjs";
import {
  buildUploadBundleCommand,
  buildUploadBundleInput,
  buildUploadBundleStdinCommand,
  buildUploadTextCommand,
  buildUploadTextPayload,
  execOpenSsh,
  execPasswordSsh,
  execWslSsh,
  runAcrossEndpoints
} from "./src/remoteRunner.mjs";
import { createBuildRegistry } from "./src/buildRegistry.mjs";
import {
  createAppSpec,
  generatedManifestV2,
  injectAppHardwareSdkContracts,
  injectHardwareAppContractsV2,
  validateGeneratedFileContracts,
} from "./src/generatedAppTemplate.mjs";
import {
  advancedTemplateFilesV2,
  generatedAppV2,
  generatedHardwareAppV2,
  generatedIndexV2,
  generatedStyleV2,
} from "./src/generatedAppTemplatesV2.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DEFAULT_GENERATED_DIR = process.env.VERCEL === "1"
  ? path.join(os.tmpdir(), "vibeboard-generated", "current")
  : path.join(ROOT, "generated", "current");
const GENERATED_DIR = process.env.VIBEBOARD_GENERATED_DIR
  ? path.resolve(process.env.VIBEBOARD_GENERATED_DIR)
  : DEFAULT_GENERATED_DIR;
const PREVIEWS_DIR = process.env.VIBEBOARD_PREVIEWS_DIR
  ? path.resolve(process.env.VIBEBOARD_PREVIEWS_DIR)
  : process.env.VERCEL === "1"
    ? path.join(os.tmpdir(), "vibeboard-previews")
    : path.join(ROOT, "previews");
const RUNTIME_DIR = process.env.VIBEBOARD_RUNTIME_DIR
  ? path.resolve(process.env.VIBEBOARD_RUNTIME_DIR)
  : process.env.VERCEL === "1"
    ? path.join(os.tmpdir(), "vibeboard-runtime")
    : path.join(ROOT, "runtime");
const SERVER_LOG_PATH = path.join(RUNTIME_DIR, "server.log");
const SERVER_LOG_STRING_LIMIT = 600;
const SERVER_LOG_ARRAY_LIMIT = 20;
const MARKET_APPS_DIR = path.join(ROOT, "market-apps");
const PORT = Number(process.env.PORT || process.env.VIBEBOARD_PORT || 8789);
const HOST = process.env.VERCEL === "1" ? undefined : (process.env.VIBEBOARD_HOST || "127.0.0.1");
const DB_PATH = process.env.VIBEBOARD_DB_PATH || (process.env.VERCEL === "1" ? path.join(os.tmpdir(), "vibeboard.db") : path.join(ROOT, "vibeboard.db"));
const DEFAULT_GENERATE_AGENT_MAX_ITERATIONS = 18;
const DEFAULT_GENERATE_AGENT_MAX_VERIFICATION_ATTEMPTS = 1;
const DEFAULT_GENERATE_AGENT_TIMEOUT_MS = 120000;
const DEFAULT_GENERATE_AGENT_LLM_TIMEOUT_MS = 60000;
const DEFAULT_JOB_TIMEOUT_MS = Math.max(1000, Number(process.env.VIBEBOARD_JOB_TIMEOUT_MS || (process.env.VERCEL === "1" ? 240000 : 600000)));
const PUBLIC_DEPLOYMENT = process.env.VERCEL === "1" || process.env.VIBEBOARD_PUBLIC_DEPLOYMENT === "1";

async function loadLocalEnv() {
  if (process.env.VERCEL === "1") return;
  for (const filename of [".env.local", ".env"]) {
    const envPath = path.join(ROOT, filename);
    const raw = await fs.readFile(envPath, "utf8").catch(() => "");
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

await loadLocalEnv();

const BILLING_MODE = String(process.env.VIBEBOARD_BILLING_MODE || "free").toLowerCase() === "credits" ? "credits" : "free";
const REQUIRE_PHONE_VERIFICATION = process.env.VIBEBOARD_REQUIRE_PHONE_VERIFICATION === "1";

const TEST_CLOUD_SQLITE_FILE = process.env.VIBEBOARD_TEST_CLOUD_SQLITE_FILE || "";
const pg = process.env.DATABASE_URL && !TEST_CLOUD_SQLITE_FILE ? neon(process.env.DATABASE_URL) : null;
if (process.env.VERCEL === "1" && !pg && !TEST_CLOUD_SQLITE_FILE) {
  throw new Error("DATABASE_URL is required on Vercel public deployment.");
}
const cloudSqliteSnapshot = createCloudSqliteSnapshot({
  pg,
  key: process.env.VIBEBOARD_DB_SNAPSHOT_KEY || "vibeboard-main",
  filePath: TEST_CLOUD_SQLITE_FILE,
});
if (cloudSqliteSnapshot) await cloudSqliteSnapshot.initSchema();

// Initialize SQLite database
const SQL = await initSqlJs();
let db;
try {
  const dbBuffer = await cloudSqliteSnapshot?.load().catch((error) => {
    console.warn("[db] cloud sqlite snapshot load failed:", error.message);
    return null;
  }) || await fs.readFile(DB_PATH).catch(() => null);
  db = dbBuffer ? new SQL.Database(dbBuffer) : new SQL.Database();
} catch {
  db = new SQL.Database();
}
try {
  db.exec("SELECT 1");
} catch (error) {
  console.warn("[db] database failed sanity check; starting from an empty database:", error.message);
  db = new SQL.Database();
}

const sqliteDb = {
  prepare: (...args) => db.prepare(...args),
  run: (...args) => db.run(...args),
  exec: (...args) => db.exec(...args),
  export: (...args) => db.export(...args),
};

sqliteDb.run(`
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
let dbSaveQueue = Promise.resolve();
let dbSaveError = null;
let dbSnapshotHash = hashBuffer(db.export());
let dbSyncQueue = Promise.resolve();

function shouldSaveSqliteSnapshot() {
  if (!cloudSqliteSnapshot) return false;
  if (PUBLIC_DEPLOYMENT && !TEST_CLOUD_SQLITE_FILE) return false;
  return true;
}

async function saveDb() {
  dbSaveQueue = dbSaveQueue
    .catch(() => {})
    .then(async () => {
      dbSaveError = null;
      const data = db.export();
      const buffer = Buffer.from(data);
      dbSnapshotHash = hashBuffer(buffer);
      await fs.mkdir(path.dirname(DB_PATH), { recursive: true }).catch(() => {});
      await fs.writeFile(DB_PATH, buffer).catch((error) => {
        console.warn("[db] local sqlite save failed:", error.message);
      });
      if (shouldSaveSqliteSnapshot()) {
        await cloudSqliteSnapshot.save(buffer);
      }
    })
    .catch((error) => {
      dbSaveError = error;
      console.warn("[db] sqlite snapshot save failed:", error.message);
    });
  return dbSaveQueue;
}

async function flushDbSaves({ requireCloudSnapshot = false } = {}) {
  await dbSaveQueue.catch(() => {});
  if (requireCloudSnapshot && dbSaveError) {
    const error = new Error("Failed to save project data. Please retry.");
    error.statusCode = 503;
    error.cause = dbSaveError;
    throw error;
  }
}

async function flushMutationSaves() {
  await flushDbSaves({ requireCloudSnapshot: Boolean(cloudSqliteSnapshot) });
}

function hashBuffer(buffer) {
  return createHash("sha256").update(Buffer.from(buffer || [])).digest("hex");
}

async function syncDbFromSnapshot() {
  if (!cloudSqliteSnapshot) return;
  dbSyncQueue = dbSyncQueue
    .catch(() => {})
    .then(async () => {
      await flushDbSaves();
      const buffer = await cloudSqliteSnapshot.load();
      if (!buffer?.length) return;
      const nextHash = hashBuffer(buffer);
      if (nextHash === dbSnapshotHash) return;
      db = new SQL.Database(buffer);
      dbSnapshotHash = nextHash;
    });
  await dbSyncQueue;
}

// Helper to run query and return results
function query(sql, params = []) {
  const stmt = sqliteDb.prepare(sql);
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
  sqliteDb.run(sql, params);
  saveDb();
}

const projectPersistence = createProjectPersistence({
  pg,
  sqliteDb,
  saveSqlite: saveDb,
  env: process.env,
});
await projectPersistence.initSchema();
if (PUBLIC_DEPLOYMENT && !TEST_CLOUD_SQLITE_FILE && cloudSqliteSnapshot && typeof projectPersistence.migrateLegacySqliteSnapshot === "function") {
  const legacyBuffer = await cloudSqliteSnapshot.load().catch((error) => {
    console.warn("[db] legacy sqlite snapshot migration load failed:", error.message);
    return null;
  });
  if (legacyBuffer?.length) {
    await projectPersistence.migrateLegacySqliteSnapshot(legacyBuffer).catch((error) => {
      console.warn("[db] legacy sqlite snapshot migration failed:", error.message);
    });
  }
}
const conversationStore = projectPersistence;

const memoryStore = createMemoryStore(sqliteDb, saveDb);
memoryStore.initSchema();

const digitalLifeStore = createDigitalLifeStore(sqliteDb, saveDb);
digitalLifeStore.initSchema();

const experienceStore = createExperienceStore(sqliteDb, saveDb);
experienceStore.initSchema();

const playbookStore = createPlaybookStore(sqliteDb, saveDb);
playbookStore.initSchema();
experienceStore.setPlaybookStore?.(playbookStore);

const jobStore = projectPersistence;
await jobStore.markInterruptedRunningJobs();

const assetLibraryStore = createAssetLibraryStore(sqliteDb, saveDb);
assetLibraryStore.initSchema();

const authStore = createAuthStore({ sqliteDb, saveSqlite: saveDb, pg, env: process.env });
await authStore.initSchema();
const phoneVerification = createPhoneVerificationService({ authStore, env: process.env });
const telemetryStore = createTelemetryStore({ sqliteDb, saveSqlite: saveDb, pg, env: process.env });
await telemetryStore.initSchema();

const projectWorkspace = createProjectWorkspace({
  root: ROOT,
  env: process.env,
  conversationStore,
  assetLibraryStore,
});

let BOARD = createBoardConfig();
let knownHosts = process.env.VIBEBOARD_KNOWN_HOSTS || path.join(os.tmpdir(), `${BOARD.id}_known_hosts`);
const identityFile = process.env.VIBEBOARD_IDENTITY_FILE || path.join(os.homedir(), ".ssh", "id_ed25519");
let boardPassword = process.env.VIBEBOARD_BOARD_PASSWORD || "";
const PYTHON_BIN = process.env.VIBEBOARD_PYTHON || (process.platform === "win32" ? "python" : "python3");

const buildRegistry = createBuildRegistry();
let currentBuild = null;
let activeEndpoint = null;
let lastDeploy = null;

function setCurrentBuild(build) {
  currentBuild = buildRegistry.setCurrentBuild(build);
  return currentBuild;
}

function setActiveEndpoint(endpoint) {
  activeEndpoint = buildRegistry.setActiveEndpoint(endpoint);
  return activeEndpoint;
}

function setLastDeploy(deploy) {
  lastDeploy = buildRegistry.setLastDeploy(deploy);
  return lastDeploy;
}
let audioState = {
  mode: "idle",
  recording: false,
  playing: false,
  lastAction: "",
  lastRecording: "",
  lastError: "",
  updatedAt: ""
};
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
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
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

function jsonWithHeaders(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    ...headers,
  });
  res.end(body);
}

async function currentUser(req) {
  return authStore.currentUserFromRequest(req);
}

async function requireApiUser(req, res, url) {
  if (!PUBLIC_DEPLOYMENT) {
    return await currentUser(req);
  }
  if (isPublicApi(url.pathname)) {
    return await currentUser(req);
  }
  const user = await currentUser(req);
  if (user) return user;
  json(res, 401, { ok: false, error: "Login required." });
  return null;
}

function isPublicApi(pathname) {
  return pathname === "/api/me" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/api/board-catalog" ||
    pathname === "/api/telemetry" ||
    pathname === "/api/health" ||
    pathname === "/healthz";
}

function shouldSyncSqliteSnapshot(pathname) {
  if (!cloudSqliteSnapshot) return false;
  if (PUBLIC_DEPLOYMENT && !TEST_CLOUD_SQLITE_FILE) return false;
  if (!isPublicApi(pathname)) return true;
  return TEST_CLOUD_SQLITE_FILE && /^\/api\/auth\//.test(pathname);
}

function secureCookie(req) {
  return process.env.VERCEL === "1" || /^https:/i.test(String(req.headers["x-forwarded-proto"] || ""));
}

function summarizeUsage(ledger = []) {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const summary = {
    billing_mode: BILLING_MODE,
    total_tokens: 0,
    month_tokens: 0,
    total_calls: 0,
    month_calls: 0,
    total_calculated_credits: 0,
    month_calculated_credits: 0,
  };
  for (const row of ledger || []) {
    const tokens = Number(row?.tokens || 0);
    if (tokens <= 0) continue;
    const metadata = parseUsageMetadata(row.metadata_json);
    const calculatedCredits = Number(metadata.credits_calculated ?? creditsForTokens(tokens));
    const createdAt = new Date(row.created_at || 0);
    const rowMonthKey = Number.isFinite(createdAt.getTime())
      ? `${createdAt.getUTCFullYear()}-${String(createdAt.getUTCMonth() + 1).padStart(2, "0")}`
      : "";
    summary.total_tokens += tokens;
    summary.total_calls += 1;
    summary.total_calculated_credits += calculatedCredits;
    if (rowMonthKey === monthKey) {
      summary.month_tokens += tokens;
      summary.month_calls += 1;
      summary.month_calculated_credits += calculatedCredits;
    }
  }
  summary.total_calculated_credits = Number(summary.total_calculated_credits.toFixed(4));
  summary.month_calculated_credits = Number(summary.month_calculated_credits.toFixed(4));
  return summary;
}

function parseUsageMetadata(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function publicSafeModelSettings(input = {}) {
  if (!PUBLIC_DEPLOYMENT) return input || {};
  if (input.enabled === false || input.forceTemplate === true) {
    return {
      provider: input.provider || process.env.VIBEBOARD_LLM_PROVIDER || process.env.VIBEBOARD_MODEL_PROVIDER || "deepseek",
      baseUrl: input.baseUrl || process.env.VIBEBOARD_LLM_BASE_URL || process.env.VIBEBOARD_MODEL_BASE_URL || "",
      model: input.model || process.env.VIBEBOARD_LLM_MODEL || process.env.VIBEBOARD_MODEL || "",
      enabled: false,
    };
  }
  return {
    provider: process.env.VIBEBOARD_LLM_PROVIDER || process.env.VIBEBOARD_MODEL_PROVIDER || input.provider || "deepseek",
    baseUrl: process.env.VIBEBOARD_LLM_BASE_URL || process.env.VIBEBOARD_MODEL_BASE_URL || input.baseUrl || "",
    model: process.env.VIBEBOARD_LLM_MODEL || process.env.VIBEBOARD_MODEL || input.model || "",
    enabled: true,
  };
}

function withServerModelSettings(body = {}, options = {}) {
  const forceTemplate = options.forceTemplate === true;
  const modelInput = forceTemplate
    ? { ...(body?.modelSettings || {}), enabled: false, forceTemplate: true }
    : (body?.modelSettings || {});
  const cloudAgentLimits = PUBLIC_DEPLOYMENT
    ? {
        max_iterations: Math.min(6, Number(body?.max_iterations || body?.maxIterations || 6)),
        max_verification_attempts: 0,
        repair_attempts: 0,
      }
    : {};
  return {
    ...(body || {}),
    modelSettings: publicSafeModelSettings(modelInput),
    ...cloudAgentLimits,
  };
}

async function ensureConversationAccess(conversationId, user) {
  const conversation = await conversationStore.getConversation(conversationId);
  if (!conversation) throw httpError(404, "Conversation not found.");
  if (PUBLIC_DEPLOYMENT && user?.role !== "admin" && (!conversation.user_id || conversation.user_id !== user?.id)) {
    throw httpError(403, "Conversation access denied.");
  }
  return conversation;
}

async function ensureCreditsAvailable(user) {
  if (!PUBLIC_DEPLOYMENT || BILLING_MODE !== "credits" || !user?.id) return null;
  const credits = await authStore.userCreditSummary(user.id);
  if (Number(credits?.credits_balance || 0) <= 0) {
    throw httpError(402, "Insufficient credits.");
  }
  return credits;
}

async function ensureJobAccess(job, user) {
  if (!job) throw httpError(404, "Job not found");
  if (PUBLIC_DEPLOYMENT && user?.role !== "admin" && String(job.input?.user_id || "") !== user?.id) {
    throw httpError(403, "Job access denied.");
  }
  return job;
}

function filterJobsForUser(jobs = [], user) {
  if (!PUBLIC_DEPLOYMENT || user?.role === "admin") return jobs;
  return jobs.filter(job => String(job.input?.user_id || "") === user?.id);
}

function requirePublicAdmin(user, message = "Admin access required.") {
  if (PUBLIC_DEPLOYMENT && user?.role !== "admin") throw httpError(403, message);
}

function staticCacheFor(filePath) {
  const relative = path.relative(ROOT, filePath).replaceAll(path.sep, "/");
  const ext = path.extname(filePath).toLowerCase();
  if (relative === "index.html" || relative === "market.html" || ext === ".html") {
    return "no-store";
  }
  if (relative === "app.js" || relative === "portal.js" || relative === "telemetry.js" || relative === "styles.css" || relative.startsWith("digital-life.")) {
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

function resolveStaticFilePath(pathname) {
  const normalizedPath = pathname === "/"
    ? "/portal.html"
    : pathname === "/workbench"
      ? "/index.html"
      : decodeURIComponent(pathname);
  if (normalizedPath === "/generated/current" || normalizedPath.startsWith("/generated/current/")) {
    const suffix = normalizedPath.slice("/generated/current".length).replace(/^\/+/, "");
    const filePath = path.resolve(GENERATED_DIR, suffix);
    return filePath === GENERATED_DIR || filePath.startsWith(`${GENERATED_DIR}${path.sep}`) ? filePath : "";
  }
  const filePath = path.resolve(ROOT, normalizedPath.replace(/^\/+/, ""));
  return filePath === ROOT || filePath.startsWith(`${ROOT}${path.sep}`) ? filePath : "";
}

function responseContentType(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  return mimeTypes[ext] || "text/plain; charset=utf-8";
}

const CONVERSATION_PREVIEW_FILE_NAMES = [...HARDWARE_APP_CONTRACT.snapshotFiles];

async function previewFilesForConversation(conversationId) {
  const { buildId, files } = await conversationStore.loadConversationFiles(conversationId);
  const allowedFiles = new Set([
    ...CONVERSATION_PREVIEW_FILE_NAMES,
    ...declaredAssetPathsFromFiles(files),
  ]);
  return {
    buildId,
    files: Object.fromEntries(
      Object.entries(files || {}).filter(([filename]) => allowedFiles.has(filename))
    )
  };
}

async function filesWithHardwareResult(files = {}) {
  const savedFiles = { ...(files || {}) };
  try {
    savedFiles[HARDWARE_RESULT_FILE] = await fs.readFile(path.join(GENERATED_DIR, HARDWARE_RESULT_FILE), "utf8");
  } catch {}
  return savedFiles;
}

function resolveConversationPreviewFile(pathname) {
  const match = pathname.match(/^\/api\/conversations\/([^/]+)\/preview(?:\/(.*))?$/);
  if (!match) return null;
  const conversationId = decodeURIComponent(match[1] || "");
  const requested = decodeURIComponent(match[2] || "index.html");
  const filename = path.posix.normalize(`/${requested}`).slice(1) || "index.html";
  if (!conversationId || filename.includes("..")) {
    return { error: "Invalid preview path" };
  }
  return { conversationId, filename };
}

function rewriteConversationPreviewHtml(html, conversationId, buildId) {
  const base = `/api/conversations/${encodeURIComponent(conversationId)}/preview/`;
  const version = encodeURIComponent(buildId || Date.now());
  return String(html || "")
    .replace(/(["'])\.\/style\.css(?:\?[^"']*)?\1/g, `$1${base}style.css?v=${version}$1`)
    .replace(/(["'])\.\/app\.js(?:\?[^"']*)?\1/g, `$1${base}app.js?v=${version}$1`);
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
    setActiveEndpoint(null);
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
    setActiveEndpoint(previousActiveEndpoint);
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
  setActiveEndpoint(null);
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
  setActiveEndpoint(endpoint);
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
  setActiveEndpoint(endpoint);
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

  return sshWithInput(buildUploadBundleStdinCommand(), buildUploadBundleInput(files), timeout);
}

async function readBody(req, { limitBytes = 64 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > limitBytes) {
      const error = new Error(`Request body is larger than ${limitBytes} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const digitalLifeRoutes = createDigitalLifeRoutes({
  store: digitalLifeStore,
  readBody,
  json,
  appendLog: appendServerLog,
  env: process.env,
});

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

function hasBoardCredentials() {
  if (process.env.VIBEBOARD_FORCE_OFFLINE === "1") return false;
  return Boolean(
    boardPassword ||
    process.env.VIBEBOARD_IDENTITY_FILE ||
    (identityFile && existsSync(identityFile)) ||
    process.env.VIBEBOARD_FORCE_REAL_BOARD === "1"
  );
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

const AUDIO_RECORDING_DIR = "/tmp/vibeboard-audio";
const AUDIO_DEFAULT_RECORDING = `${AUDIO_RECORDING_DIR}/recording.wav`;
const AUDIO_APIS = AUDIO_RUNTIME_APIS;

function nowIso() {
  return new Date().toISOString();
}

function updateAudioState(next = {}) {
  audioState = {
    ...audioState,
    ...next,
    updatedAt: nowIso()
  };
  return audioState;
}

function audioCapabilityPayload(extra = {}) {
  return {
    ok: true,
    available_apis: [...AUDIO_APIS],
    capabilities: {
      play: true,
      record: true,
      stop: true,
      status: true,
      playbackCommand: "aplay",
      recordCommand: "arecord"
    },
    state: audioState,
    ...extra
  };
}

function offlineAudioResponse(action, extra = {}) {
  const state = updateAudioState({
    mode: action === "record" ? "recording" : action === "play" ? "playing" : "idle",
    recording: action === "record",
    playing: action === "play",
    lastAction: action,
    lastError: "",
    ...(extra.recordingPath ? { lastRecording: extra.recordingPath } : {})
  });
  return audioCapabilityPayload({
    mode: "offline-simulated",
    skipped: true,
    message: "No board route is currently connected; audio action was simulated locally.",
    state,
    ...extra
  });
}

function parsePositiveNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function requestedAudioFile(body = {}) {
  const raw = String(body.file || body.path || AUDIO_DEFAULT_RECORDING).trim();
  const basename = path.posix.basename(raw || "recording.wav").replace(/[^a-zA-Z0-9._-]/g, "_") || "recording.wav";
  const withExt = /\.[a-z0-9]+$/i.test(basename) ? basename : `${basename}.wav`;
  return `${AUDIO_RECORDING_DIR}/${withExt}`;
}

function remoteAudioStatusCommand() {
  return String.raw`set -u
mkdir -p /tmp/vibeboard-audio
python3 - <<'PY'
import json, os, shutil, subprocess
def cmd_exists(name):
    return shutil.which(name) is not None
recording = subprocess.run("pgrep -f 'arecord.*vibeboard-audio' >/dev/null 2>&1", shell=True).returncode == 0
playing = subprocess.run("pgrep -f 'aplay.*vibeboard-audio' >/dev/null 2>&1", shell=True).returncode == 0
last = "/tmp/vibeboard-audio/recording.wav"
payload = {
    "ok": True,
    "mode": "real",
    "available_apis": ["/api/audio/status", "/api/audio/play", "/api/audio/record", "/api/audio/stop"],
    "capabilities": {
        "play": cmd_exists("aplay"),
        "record": cmd_exists("arecord"),
        "stop": True,
        "status": True,
        "playbackCommand": "aplay",
        "recordCommand": "arecord"
    },
    "state": {
        "mode": "recording" if recording else ("playing" if playing else "idle"),
        "recording": recording,
        "playing": playing,
        "lastRecording": last if os.path.exists(last) else "",
        "lastError": ""
    }
}
print(json.dumps(payload, ensure_ascii=False))
PY`;
}

function remoteAudioPlayCommand({ file = AUDIO_DEFAULT_RECORDING, duration = 0.35, frequency = 880 } = {}) {
  const safeFile = shQuote(file);
  const safeDuration = parsePositiveNumber(duration, 0.35, 0.05, 3);
  const safeFrequency = Math.round(parsePositiveNumber(frequency, 880, 120, 2400));
  return `set -u
mkdir -p ${shQuote(AUDIO_RECORDING_DIR)}
file=${safeFile}
if ! command -v aplay >/dev/null 2>&1; then
  echo '{"ok":false,"error":"aplay not installed","mode":"real"}'
  exit 0
fi
if [ ! -s "$file" ]; then
  python3 - <<'PY'
import math, struct, wave
path = ${JSON.stringify(file)}
rate = 16000
duration = ${safeDuration}
freq = ${safeFrequency}
with wave.open(path, "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(rate)
    for i in range(int(rate * duration)):
        sample = int(18000 * math.sin(2 * math.pi * freq * i / rate))
        wav.writeframes(struct.pack("<h", sample))
PY
fi
timeout 4s aplay "$file" >/tmp/vibeboard-audio/aplay.log 2>&1 &
python3 - <<'PY'
import json
print(json.dumps({"ok": True, "mode": "real", "action": "play", "playing": True, "file": ${JSON.stringify(file)}, "available_apis": ["/api/audio/status", "/api/audio/play", "/api/audio/record", "/api/audio/stop"]}, ensure_ascii=False))
PY`;
}

function remoteAudioRecordCommand({ file = AUDIO_DEFAULT_RECORDING, duration = 5 } = {}) {
  const safeFile = shQuote(file);
  const safeDuration = Math.round(parsePositiveNumber(duration, 5, 1, 30));
  return `set -u
mkdir -p ${shQuote(AUDIO_RECORDING_DIR)}
file=${safeFile}
if ! command -v arecord >/dev/null 2>&1; then
  echo '{"ok":false,"error":"arecord not installed","mode":"real"}'
  exit 0
fi
pkill -f 'arecord.*vibeboard-audio' 2>/dev/null || true
rm -f /tmp/vibeboard-audio/arecord.log
timeout ${safeDuration}s arecord -q -f S16_LE -r 16000 -c 1 "$file" >/tmp/vibeboard-audio/arecord.log 2>&1 &
sleep 0.35
python3 - <<'PY'
import json, os, subprocess
file = ${JSON.stringify(file)}
recording = subprocess.run("pgrep -f 'arecord.*vibeboard-audio' >/dev/null 2>&1", shell=True).returncode == 0
log = ""
try:
    with open("/tmp/vibeboard-audio/arecord.log", "r", encoding="utf-8", errors="replace") as fh:
        log = fh.read().strip()
except FileNotFoundError:
    pass
payload = {
    "mode": "real",
    "action": "record",
    "recording": recording,
    "duration": ${safeDuration},
    "file": file,
    "available_apis": ["/api/audio/status", "/api/audio/play", "/api/audio/record", "/api/audio/stop"],
    "diagnostics": {
        "log": log[-1200:],
        "fileExists": os.path.exists(file),
        "fileSize": os.path.getsize(file) if os.path.exists(file) else 0
    }
}
if recording:
    payload["ok"] = True
else:
    payload["ok"] = False
    payload["error"] = log or "arecord exited immediately; microphone did not start."
print(json.dumps(payload, ensure_ascii=False))
PY`;
}

function remoteAudioStopCommand() {
  return String.raw`set -u
pkill -f 'arecord.*vibeboard-audio' 2>/dev/null || true
pkill -f 'aplay.*vibeboard-audio' 2>/dev/null || true
python3 - <<'PY'
import json
print(json.dumps({"ok": True, "mode": "real", "action": "stop", "recording": False, "playing": False, "available_apis": ["/api/audio/status", "/api/audio/play", "/api/audio/record", "/api/audio/stop"]}, ensure_ascii=False))
PY`;
}

function normalizeRemoteAudioResult(raw, fallbackAction = "status") {
  let parsed = null;
  try {
    parsed = parseJsonObject(raw, "audio response");
  } catch (error) {
    parsed = { ok: false, error: error.message, raw: String(raw || "") };
  }
  const audioError = parsed.ok === false ? classifyAudioError(parsed.error || parsed.diagnostics?.log || parsed.raw || "") : {};
  const state = updateAudioState({
    mode: parsed.state?.mode || (parsed.recording ? "recording" : parsed.playing ? "playing" : "idle"),
    recording: Boolean(parsed.state?.recording ?? parsed.recording),
    playing: Boolean(parsed.state?.playing ?? parsed.playing),
    lastAction: parsed.action || fallbackAction,
    lastRecording: parsed.state?.lastRecording || parsed.file || audioState.lastRecording || "",
    lastError: parsed.error || audioError.userMessage || ""
  });
  return {
    ...audioCapabilityPayload({
      mode: parsed.mode || "real",
      skipped: false,
      ...audioError,
      ...parsed
    }),
    state
  };
}

function classifyAudioError(message = "") {
  const text = String(message || "");
  if (/Unable to reach|NoValidConnectionsError|Connection refused|Connection timed out|banner exchange|No VIBEBOARD_BOARD_PASSWORD|Permission denied|Authentication failed|SSH/i.test(text)) {
    return {
      errorType: "audio_board_unreachable",
      userMessage: "无法连接到板端音频接口，所以还不能确认麦克风状态。",
      suggestion: "检查灰色版板子的 FRP/SSH 通道、端口、VIBEBOARD_BOARD_PASSWORD 或私钥配置，然后重试录音。"
    };
  }
  if (/arecord not installed|not found|command not found/i.test(text)) {
    return {
      errorType: "audio_recorder_missing",
      userMessage: "板端没有安装 arecord，无法调用麦克风录音。",
      suggestion: "在板端安装 alsa-utils，或把录音适配器改成可用的系统命令。"
    };
  }
  if (/Permission denied|Operation not permitted|EACCES/i.test(text)) {
    return {
      errorType: "audio_permission_denied",
      userMessage: "板端录音命令被权限拦截，当前用户没有访问麦克风设备的权限。",
      suggestion: "把运行用户加入 audio 组，检查 /dev/snd 权限，然后重启板端服务。"
    };
  }
  if (/Device or resource busy|busy|EBUSY/i.test(text)) {
    return {
      errorType: "audio_device_busy",
      userMessage: "麦克风设备正在被其它进程占用。",
      suggestion: "停止占用声卡的录音/播放进程，再重新开始录音。"
    };
  }
  if (/No such file or directory|cannot find card|no soundcards|Unknown PCM|No such device|ENODEV/i.test(text)) {
    return {
      errorType: "audio_device_missing",
      userMessage: "板端没有识别到可用的麦克风输入设备。",
      suggestion: "检查麦克风连接、声卡驱动和 arecord -l 输出。"
    };
  }
  return {
    errorType: "audio_record_failed",
    userMessage: "麦克风录音没有成功启动。",
    suggestion: "查看技术详情里的板端 arecord 日志，并检查设备、权限和占用情况。"
  };
}

function audioFailureResponse(error, action = "status") {
  const detail = `${error?.message || ""}\n${error?.stderr || ""}\n${error?.stdout || ""}`.trim();
  const classified = classifyAudioError(detail);
  const state = updateAudioState({
    mode: "idle",
    recording: false,
    playing: false,
    lastAction: action,
    lastError: error?.message || classified.userMessage || "Audio command failed."
  });
  return audioCapabilityPayload({
    ok: false,
    mode: "real",
    skipped: false,
    ...classified,
    error: error?.message || classified.userMessage || "Audio command failed.",
    technicalDetail: detail.slice(0, 1200),
    state
  });
}

async function runAudioRoute(action, task) {
  try {
    return await task();
  } catch (error) {
    return audioFailureResponse(error, action);
  }
}

async function audioStatus() {
  if (!hasBoardCredentials()) {
    return audioCapabilityPayload({
      mode: "offline-simulated",
      skipped: true,
      message: "No board route is currently connected; audio APIs are available in simulation mode."
    });
  }
  const raw = await ssh(remoteAudioStatusCommand(), 12000);
  return normalizeRemoteAudioResult(raw, "status");
}

async function audioPlay(body = {}) {
  const file = requestedAudioFile(body);
  if (!hasBoardCredentials()) return offlineAudioResponse("play", { file });
  const raw = await ssh(remoteAudioPlayCommand({
    file,
    duration: body.duration,
    frequency: body.frequency
  }), 12000);
  return normalizeRemoteAudioResult(raw, "play");
}

async function audioRecord(body = {}) {
  const file = requestedAudioFile(body);
  const duration = parsePositiveNumber(body.duration, 5, 1, 30);
  if (!hasBoardCredentials()) return offlineAudioResponse("record", { file, duration, recordingPath: file });
  const raw = await ssh(remoteAudioRecordCommand({ file, duration }), 12000);
  return normalizeRemoteAudioResult(raw, "record");
}

async function audioStop() {
  if (!hasBoardCredentials()) return offlineAudioResponse("stop");
  const raw = await ssh(remoteAudioStopCommand(), 12000);
  return normalizeRemoteAudioResult(raw, "stop");
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
    intelligenceSummary: currentBuild?.intelligenceSummary || null,
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
 * 鍏滃簳娉ㄥ叆锛氱‘淇?hardware_app.py 杈撳嚭鍖呭惈 golden-loop 蹇呴渶瀛楁
 * 鏃犺 AI 鐢熸垚浠€涔堜唬鐮侊紝閮藉己鍒舵敞鍏?runtime 鍜?build_id
 */
function llmSystemPrompt(conversationHistory = []) {
  const isEditing = conversationHistory.length > 0;

  return `You are VibeBoard, a hardware-aware coding assistant embedded in a real physical device.

## Your Hardware Context
${hardwareContractPromptText("en")}

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

${isEditing ? `## 鈿狅笍 Editing Mode 鈥?CRITICAL RULES
You are modifying an EXISTING project that is already deployed.
The user can see the current code in the "褰撳墠閮ㄧ讲鐨勫畬鏁翠唬鐮? section below.

**YOU MUST:**
1. Return ALL files in the JSON, even if you only changed one file
2. For files the user didn't ask to change: copy them EXACTLY as-is (no formatting changes, no "improvements")
3. Only modify the specific thing the user asked about
4. If the user says "鎶?鏀规垚2", find what "3" refers to in the code and change only that to "2"
5. NEVER rewrite the entire project from scratch when making a small change
6. Preserve all existing functionality that the user didn't mention

**COMMON MISTAKE TO AVOID:**
User says "fix the color of button X" 鈫?Do NOT remove button Y or change the layout.
User says "change item 3 to 2" 鈫?Find item 3 in the code, change its value to 2. Keep everything else.
` : `## Generation Mode
You are creating a NEW project from scratch.
` }

## Hard Requirements (always apply)
${validationRulesText("en").map(rule => `- ${rule}`).join("\n")}
- Use dark theme (dark background, light text) for best readability on LCD.
- Font sizes: titles 16-20px, body 12-14px, small labels 10-11px.
- Colors: avoid pure white (#fff), prefer #e2e8f0 or similar soft white.

## Visual Quality Baseline
- Do not produce a plain static CRUD-like screen. Every new app should feel like a polished embedded kiosk experience.
- Use a composed scene: animated background layers, scanlines or subtle motion, glowing status chips, dense but readable data panels, and clear hardware state.
- For clock apps, prefer a cyberpunk neon visual direction with a large glowing time display, animated grid/scanline effects, seconds ticker, and hardware status.
- For weather, carousel, dashboard, timer, voice, and control apps, add distinctive scene styling and motion that fits the domain while keeping the 480x360 layout stable.
- Keep animations CSS-only or lightweight JavaScript, and ensure text never overflows the fixed 480x360 display.

## Available Runtime Data (from /api/status)
- hostname, model, kernel, time, uptime, cpu_temp
- memory.percent, memory.used_h, memory.total_h
- disk.percent, disk.used_h, disk.total_h
- network.wifi, network.addresses[0], network.gateway
- services.ssh, services.frpc, services.display

## Audio Runtime APIs
- GET /api/audio/status returns speaker/microphone capability and current recording/playback state.
- POST /api/audio/play plays the last recording or a generated test tone through the board speaker.
- POST /api/audio/record starts a bounded microphone recording; body may include { "duration": 5, "file": "recording.wav" }.
- POST /api/audio/stop stops active recording/playback.
- In app.js, expose these through window.VibeBoardHardware.audio.status/play/record/stop when the app needs voice, recorder, alarm, sound, or speaker behavior.
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
    const recentContext = history.slice(-4).map((message) =>
      `[${message.role === "user" ? "user" : "assistant"}] ${String(message.content || "").slice(0, 200)}`
    ).join("\n");

    const currentFiles = isEditing && currentBuild?.files
      ? Object.keys(currentBuild.files)
          .filter((name) => name !== "manifest.json")
          .map((name) => {
            const content = String(currentBuild.files[name] || "");
            return `### ${name}\n${content.slice(0, 2000)}${content.length > 2000 ? "\n...(truncated)" : ""}`;
          })
          .join("\n\n")
      : "";

    const thinkingPrompt = `You are a hardware-aware coding assistant. Think briefly before generating code.\n\nBuild id: ${id}\nMode: ${isEditing ? "edit existing app" : "new app"}\nUser request: ${prompt}\n\nRecent context:\n${recentContext || "none"}\n\nCurrent files:\n${currentFiles || "none"}\n\nReturn concise analysis with: requirement understanding, technical plan, UI layout, and hardware contract risks.`;

    const messages = [
      { role: "system", content: "You analyze VibeBoard generation tasks before code generation. Return concise planning text only." },
      { role: "user", content: thinkingPrompt }
    ];

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

    const thinking = data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.content || "";
    return { thinking: thinking.trim(), analysis: thinking.trim() };
  } catch (err) {
    console.warn("[thinkBeforeGenerate] Failed:", err.message);
    return { thinking: "", analysis: null };
  } finally {
    clearTimeout(timeout);
  }
}

function llmUserPrompt(prompt, id, history = []) {
  const isEditing = history.length > 0;

  if (!isEditing) {
    return `Build id: ${id}\nUser request: ${prompt}\n\nRespond with ONLY the JSON object containing index.html, style.css, app.js, and hardware_app.py.`;
  }

  let codeSnapshot = "";
  if (currentBuild?.files) {
    const fileList = Object.keys(currentBuild.files).filter((name) => name !== "manifest.json");
    codeSnapshot = "\n\n## Existing app files\nKeep all unrelated behavior unchanged. Return every required file, even if only one file changes.\n";
    for (const name of fileList) {
      const content = String(currentBuild.files[name] || "");
      const truncated = content.length > 8000 ? `${content.slice(0, 8000)}\n... (truncated)` : content;
      codeSnapshot += `### ${name}\n\`\`\`\n${truncated}\n\`\`\`\n\n`;
    }
  }

  return `Build id: ${id}\nUser request: ${prompt}${codeSnapshot}\n\nRules:\n1. Return valid JSON only.\n2. Return all required files.\n3. Preserve unrelated existing behavior.\n4. Keep the 480x360 no-touch hardware contract intact.\n\nRespond with ONLY the JSON object.`;
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

  files["app.js"] = injectAppHardwareSdkContracts(files["app.js"], id);

  // 鍏滃簳娉ㄥ叆锛氱‘淇?hardware_app.py 杈撳嚭鍖呭惈 golden-loop 蹇呴渶瀛楁
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
  const advanced = advancedTemplateFilesV2(prompt, id, spec);
  return {
    files: {
      "index.html": advanced?.["index.html"] || generatedIndexV2(prompt, id, spec),
      "style.css": advanced?.["style.css"] || generatedStyleV2(prompt, id, spec),
      "app.js": injectAppHardwareSdkContracts(advanced?.["app.js"] || generatedAppV2(prompt, id, spec), id),
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
      <h1>灏忓睆鍔╂墜宸查儴缃?/h1>
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
    const ip = (data.network && data.network.addresses && data.network.addresses[0]) || "--C";
    el("wifi").textContent = (data.network && data.network.wifi) || "鏈繛鎺?;
    el("ip").textContent = ip;
    el("temp").textContent = data.cpu_temp == null ? "--C" : data.cpu_temp + "掳C";
    el("mem").textContent = data.memory ? Number(data.memory.percent || 0).toFixed(1) + "%" : "--C";
    el("service").textContent = "SSH " + (data.services && data.services.ssh || "--C") + " / FRP " + (data.services && data.services.frpc || "--C");
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

async function writeGenerated(prompt, modelSettings = {}, history = [], embeddedAssets = null) {
  const id = buildId();
  await appendServerLog("generate.template.start", { id, prompt: String(prompt || "").slice(0, 160) });
  const generated = await generateFilesForPrompt(prompt, id, modelSettings, history);
  const embedded = embedGeneratedAssetsInFiles(generated.files, embeddedAssets, generated.manifest);
  const files = embedded.files;
  const manifest = embedded.manifest || generated.manifest;
  await writeGeneratedFiles(GENERATED_DIR, files);
  const agentRun = transitionRun(createAgentRun({
    prompt,
    mode: "template",
    buildId: id,
    hardwareMode: boardPassword ? "real" : "simulated",
  }), AGENT_PHASES.CODE, {
    spec: buildInitialSpec(prompt, { requireBoard: Boolean(boardPassword) }),
  });
  setCurrentBuild({ id, prompt, files, dir: GENERATED_DIR, built: false, deployed: false, manifest, agentRun });
  await buildCurrent();
  await appendServerLog("generate.template.done", { id, files: Object.keys(files) });
  return currentBuild;
}

async function loadGeneratedBuild() {
  setCurrentBuild(await loadGeneratedWorkspace(GENERATED_DIR, GENERATED_FILE_NAMES, {
    id: "preview",
    prompt: "Waiting for generation"
  }));
  return currentBuild;
}

async function ensureInitialGenerated() {
  setCurrentBuild(await ensureGeneratedWorkspace({
    dir: GENERATED_DIR,
    generatedFileNames: GENERATED_FILE_NAMES,
    fallbackSeed: {
      id: "preview",
      prompt: "Waiting for generation. This preview will show the 480x360 VibeBoard kiosk app before it is deployed to hardware."
    },
    bootstrapFile: "index.html",
    makeFiles: ({ id, prompt }) => {
      const spec = createAppSpec(prompt, id);
      return {
        "index.html": generatedIndexV2(prompt, id, spec),
        "style.css": generatedStyleV2(prompt, id, spec),
        "app.js": injectAppHardwareSdkContracts(generatedAppV2(prompt, id, spec), id),
        "hardware_app.py": generatedHardwareAppV2(prompt, id, spec),
        "manifest.json": JSON.stringify(generatedManifestV2(prompt, id, spec), null, 2)
      };
    }
  }));
}

const buildRuntime = createBuildRuntime({
  appendServerLog,
  execFileP,
  verifyAllLocal,
  createAppSpec,
  generatedManifest: generatedManifestV2,
  injectAppHardwareSdkContracts,
  injectHardwareAppContracts: injectHardwareAppContractsV2,
  getCurrentBuild: () => currentBuild,
  getBoard: () => BOARD,
  pythonBin: PYTHON_BIN,
  nodeBin: process.execPath,
});

const previewRuntime = createPreviewRuntime({
  rootDir: ROOT,
  previewsDir: PREVIEWS_DIR,
  port: PORT,
  nodeBin: process.execPath,
  appendServerLog,
});

async function buildCurrent() {
  return buildRuntime.buildCurrent();
}

// Capture preview screenshot and return verification report
async function capturePreview() {
  if (!currentBuild) return { ok: false, error: "no build" };
  try {
    return await previewRuntime.ensureBuildPreview(currentBuild);
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
  setLastDeploy({
    id: currentBuild.id,
    backup,
    output,
    compileLog,
    hardwareResult,
    hardwareResultRaw,
    programPath,
    compilePath,
    intelligenceSummary: currentBuild?.intelligenceSummary || null,
    goldenLoop
  });
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
  if (PUBLIC_DEPLOYMENT && /\/digital-life(?:\.html|\.js|\.css)?$/i.test(url.pathname)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const filePath = resolveStaticFilePath(url.pathname);
  if (!filePath) {
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

function formatProjectMemoryForPrompt(memory = {}) {
  const normalized = normalizeProjectMemory(memory);
  const lines = [];
  if (normalized.summary) lines.push(`Summary: ${normalized.summary}`);
  if (normalized.goal) lines.push(`Goal: ${normalized.goal}`);
  if (normalized.requirements.length) lines.push(`Requirements:\n${normalized.requirements.map((item) => `- ${item}`).join("\n")}`);
  if (normalized.constraints.length) lines.push(`Constraints:\n${normalized.constraints.map((item) => `- ${item}`).join("\n")}`);
  if (normalized.decisions.length) lines.push(`Decisions:\n${normalized.decisions.map((item) => `- ${item}`).join("\n")}`);
  if (normalized.open_questions.length) lines.push(`Open questions:\n${normalized.open_questions.map((item) => `- ${item}`).join("\n")}`);
  if (!lines.length) return "";
  return `\n\n## Current project memory\n${lines.join("\n")}`;
}
const generateRuntime = createGenerateRuntime({
  conversationStore,
  memoryStore,
  assetLibraryStore,
  experienceStore,
  runAgent,
  appendServerLog,
  normalizeGenerateHistory,
  compressHistory,
  structuredErrorFieldsForLog,
  positiveInt,
  env: process.env,
  defaults: {
    maxIterations: DEFAULT_GENERATE_AGENT_MAX_ITERATIONS,
    maxVerificationAttempts: DEFAULT_GENERATE_AGENT_MAX_VERIFICATION_ATTEMPTS,
    timeoutMs: DEFAULT_GENERATE_AGENT_TIMEOUT_MS,
    llmTimeoutMs: DEFAULT_GENERATE_AGENT_LLM_TIMEOUT_MS,
  },
  getBoard: () => BOARD,
  isBoardPasswordConfigured: () => Boolean(boardPassword),
  ssh,
  scp,
  buildId,
  createAppSpec,
  generatedHardwareApp: generatedHardwareAppV2,
  injectAppHardwareSdkContracts,
  injectHardwareAppContracts: injectHardwareAppContractsV2,
  generatedManifest: generatedManifestV2,
  writeGenerated,
  buildCurrent,
  recordAgentLearning,
  filesWithHardwareResult,
  generatedDir: GENERATED_DIR,
  getCurrentBuild: () => currentBuild,
  setCurrentBuild,
  projectWorkspace,
});

async function runGenerateRequest(body = {}) {
  return generateRuntime.runGenerateRequest(withServerModelSettings(body));
}

async function chargeAiUsage({ user, body = {}, result = {}, reason = "ai_call" } = {}) {
  if (!user?.id) return null;
  const usageTokens = tokensFromModelResponse(result, 0);
  const estimated = usageTokens <= 1;
  const tokens = estimated
    ? estimateTokensFromPayload({
        messages: body.history || [
          { role: "user", content: body.prompt || body.build_prompt || body.message || "" },
        ],
        max_tokens: 16000,
      })
    : usageTokens;
  const credits = creditsForTokens(tokens);
  if (credits <= 0 && tokens <= 0) return null;
  const delta = BILLING_MODE === "credits" ? -credits : 0;
  return authStore.applyCreditDelta({
    userId: user.id,
    delta,
    reason,
    tokens,
    metadata: {
      estimated,
      billing_mode: BILLING_MODE,
      credits_calculated: credits,
      conversation_id: body.conversation_id || "",
      model: result.model || body.modelSettings?.model || process.env.VIBEBOARD_LLM_MODEL || process.env.VIBEBOARD_MODEL || "",
    },
  });
}

async function recordProductTelemetry({ req = null, user = null, body = {}, eventType, category, action, severity = "info", extra = {} } = {}) {
  const prompt = String(body.prompt || body.build_prompt || body.message || "").trim();
  await telemetryStore.record({
    req,
    user,
    eventType,
    category,
    action,
    page: "api",
    boardId: body.deviceId || body.board_id || body.boardId || "",
    conversationId: body.conversation_id || body.conversationId || "",
    severity,
    payload: {
      action: body.action || action || "",
      agent_mode: body.agent_mode || "",
      background: Boolean(body.background || body.as_job),
      prompt_excerpt: prompt ? prompt.slice(0, 800) : "",
      prompt_length: prompt.length,
      model: body.modelSettings?.model || process.env.VIBEBOARD_LLM_MODEL || process.env.VIBEBOARD_MODEL || "",
      ...extra,
    },
  }).catch(() => {});
}

async function writeProjectMemorySafe(conversationId, options = {}) {
  const id = String(conversationId || "").trim();
  if (!id) return null;
  try {
    return await projectWorkspace.writeMemory(id, options);
  } catch (error) {
    await appendServerLog("project.memory.write_failed", {
      conversationId: id,
      trigger: options.trigger || "",
      error: error.message,
    }).catch(() => {});
    return null;
  }
}

const marketRuntime = createMarketRuntime({
  generatedFileNames: GENERATED_FILE_NAMES,
  query,
  run,
  loadStaticMarketApps,
  readStaticMarketCode,
  mergeMarketApps,
  readGeneratedFiles,
  writeGeneratedFiles,
  generatedDir: GENERATED_DIR,
  getCurrentBuild: () => currentBuild,
  capturePreview,
  loadGeneratedBuild,
  buildCurrent,
  deployCurrent,
  withDeployLock,
  withDevice,
  deviceIdFrom,
  getBoard: () => BOARD,
  createPreviewProject: createMarketPreviewProject,
});

async function createMarketPreviewProject({ title, files = {}, appId = "", source = "", body = {} } = {}) {
  const requestUser = body.requestUser || null;
  const projectTitle = String(title || "Market Preview").trim() || "Market Preview";
  const conversation = await conversationStore.createConversation(randomUUID(), projectTitle, { userId: requestUser?.id || "" });
  const project = await projectWorkspace.ensureProject(conversation.id, projectTitle);
  const buildId = `market-preview-${String(appId || conversation.id).slice(0, 24)}-${Date.now().toString(36)}`;
  await conversationStore.saveConversationFiles(conversation.id, buildId, files);
  await conversationStore.appendMessage(conversation.id, {
    role: "agent",
    content: `已从应用市场载入「${projectTitle}」。你可以先在右侧小屏预览，也可以继续和 Agent 对话修改。`,
    build_id: buildId,
  });
  await projectWorkspace.writeBuildSnapshot(conversation.id, buildId, files, []);
  await writeProjectMemorySafe(conversation.id, {
    trigger: "market-preview",
    buildId,
    prompt: `Preview market app ${projectTitle}`,
  });
  await recordProductTelemetry({
    req: body.req || null,
    user: requestUser,
    body: { conversation_id: conversation.id, app_id: appId },
    eventType: "market.preview",
    category: "market",
    action: "preview",
    extra: { title: projectTitle, source, file_count: Object.keys(files || {}).length },
  });
  await flushMutationSaves();
  return {
    conversation_id: conversation.id,
    build_id: buildId,
    project_dir: project.project_dir,
    preview_url: `/api/conversations/${encodeURIComponent(conversation.id)}/preview/index.html?build=${encodeURIComponent(buildId)}`,
  };
}

const { runAgentRequest } = createAgentOrchestrator({
  conversationStore,
  memoryStore,
  assetLibraryStore,
  recordAgentLearning,
  runGenerateRequest,
});

async function runDeployRequest(body = {}) {
  const deviceId = deviceIdFrom(body || {}, BOARD.id);
  if (!hasBoardCredentials()) {
    if (!currentBuild) await loadGeneratedBuild();
    if (currentBuild && (!currentBuild.built || !currentBuild.buildEvidence)) await buildCurrent();
    const result = buildOfflineDeployResult();
    setLastDeploy(result);
    await appendServerLog("deploy.skipped", { id: currentBuild?.id || "", mode: result.mode });
    return { ok: true, deviceId, ...result };
  }
  console.log("[deploy] Starting deploy...");
  await appendServerLog("deploy.start", { id: currentBuild?.id || "", deviceId });
  const result = await withDeployLock(() => withDevice(deviceId, () => deployCurrent()));
  console.log("[deploy] Deploy completed successfully");
  await appendServerLog("deploy.done", { id: result.id, goldenLoopOk: result.goldenLoop?.ok });
  return { ok: true, deviceId, ...result };
}

function withoutBackgroundFlags(body = {}) {
  const { background, as_job, ...rest } = body || {};
  return rest;
}

function wantsBackgroundJob(body = {}) {
  return body?.background === true || body?.as_job === true;
}

function jobTitle(type, body = {}) {
  const prompt = String(body.prompt || body.build_prompt || body.message || "").replace(/\s+/g, " ").trim();
  if (type === "deploy") return "Deploy current build";
  if (type === "generate" || body.action === "confirm_build") return `Generate${prompt ? `: ${prompt.slice(0, 80)}` : ""}`;
  return `Agent${prompt ? `: ${prompt.slice(0, 80)}` : ""}`;
}

async function enqueueBackgroundJob(type, body = {}) {
  const input = withoutBackgroundFlags(body || {});
  return await jobRuntime.enqueue(type, input, {
    conversationId: String(input.conversation_id || ""),
    title: jobTitle(type, input),
  });
}

async function runRequestBoundJob(type, body = {}) {
  const input = withoutBackgroundFlags(body || {});
  return await jobRuntime.runNow(type, input, {
    conversationId: String(input.conversation_id || ""),
    title: jobTitle(type, input),
  });
}

const jobRuntime = createJobRuntime({
  jobStore,
  classifyError,
  appendServerLog,
  timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
});

jobRuntime.register("agent", async (body = {}, ctx) => {
  await ctx.phase("agent", "Agent request is running.");
  const result = await runAgentRequest(withServerModelSettings(body || {}));
  const user = body.user_id ? await authStore.userCreditSummary(body.user_id).catch(() => null) : null;
  await chargeAiUsage({ user, body, result, reason: body.action === "confirm_build" ? "agent_build" : "agent" });
  await writeProjectMemorySafe(body.conversation_id, {
    trigger: body.action === "confirm_build" ? "agent-confirm-build" : "agent-message",
    buildId: result?.id || result?.build_id || "",
    prompt: body.prompt || body.build_prompt || body.message || "",
  });
  await ctx.phase("done", "Agent request finished.");
  return result;
});

jobRuntime.register("generate", async (body = {}, ctx) => {
  await ctx.phase("generate", "Code generation is running.");
  const result = await runGenerateRequest(withServerModelSettings(body || {}));
  const user = body.user_id ? await authStore.userCreditSummary(body.user_id).catch(() => null) : null;
  await chargeAiUsage({ user, body, result, reason: "generate" });
  await writeProjectMemorySafe(body.conversation_id, {
    trigger: "generate-job",
    buildId: result?.id || "",
    prompt: body.prompt || body.build_prompt || "",
  });
  await ctx.phase("done", "Generation finished.");
  return result;
});

jobRuntime.register("deploy", async (body = {}, ctx) => {
  await ctx.phase("deploy", "Deploy is running.");
  const result = await runDeployRequest(body || {});
  await writeProjectMemorySafe(body.conversation_id, {
    trigger: "deploy-confirmed",
    buildId: result?.id || currentBuild?.id || "",
    prompt: currentBuild?.prompt || "",
    deploy: result,
  });
  await ctx.phase("done", "Deploy finished.");
  return result;
});

await jobRuntime.resumeQueuedJobs();

async function route(req, res) {
  let url = null;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#08111d"/><path d="M14 18h36v28H14z" fill="#f8fbff"/><path d="M18 22h28v20H18z" fill="#0b63ce"/><circle cx="23" cy="49" r="3" fill="#43ff91"/><circle cx="32" cy="49" r="3" fill="#ffd166"/><circle cx="41" cy="49" r="3" fill="#ff2bd6"/></svg>');
      return;
    }
    if (req.method === "GET" && (url.pathname === "/api/health" || url.pathname === "/healthz")) {
      json(res, 200, { ok: true, publicDeployment: PUBLIC_DEPLOYMENT, auth: true, billingMode: BILLING_MODE, phoneVerificationRequired: REQUIRE_PHONE_VERIFICATION, db: pg ? "postgres" : "sqlite" });
      return;
    }
    if (req.url.startsWith("/api/") && shouldSyncSqliteSnapshot(url.pathname)) {
      await syncDbFromSnapshot();
    }
    if (req.method === "GET" && url.pathname === "/api/board-catalog") {
      json(res, 200, { ok: true, boards: buildBoardCatalog(process.env) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/me") {
      const user = await currentUser(req);
      const credits = user ? await authStore.userCreditSummary(user.id) : null;
      const ledger = user ? await authStore.listCreditLedger({ userId: user.id, limit: 50 }) : [];
      json(res, 200, { ok: true, user, credits, usage: summarizeUsage(ledger) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/auth/send-code") {
      const body = await readBody(req).catch(() => ({}));
      json(res, 200, await phoneVerification.sendCode({ phone: body.phone, purpose: "register" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/auth/verify-code") {
      const body = await readBody(req).catch(() => ({}));
      json(res, 200, { ok: true, ...(await phoneVerification.verifyCode({ phone: body.phone, purpose: "register", code: body.code })) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const body = await readBody(req).catch(() => ({}));
      const user = await authStore.createUser({
        phone: body.phone,
        password: body.password,
        verificationToken: body.verification_token || body.verificationToken,
        requireVerification: REQUIRE_PHONE_VERIFICATION,
      });
      const login = await authStore.login({ phone: body.phone, password: body.password });
      jsonWithHeaders(res, 200, { ok: true, user: login.user }, {
        "Set-Cookie": sessionCookie(login.session.token, { maxAge: login.session.max_age_seconds, secure: secureCookie(req) }),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readBody(req).catch(() => ({}));
      const login = await authStore.login({ phone: body.phone, password: body.password });
      jsonWithHeaders(res, 200, { ok: true, user: login.user }, {
        "Set-Cookie": sessionCookie(login.session.token, { maxAge: login.session.max_age_seconds, secure: secureCookie(req) }),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      await authStore.logout(req);
      jsonWithHeaders(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/telemetry") {
      const body = await readBody(req, { limitBytes: 256 * 1024 }).catch(() => ({}));
      const user = await currentUser(req).catch(() => null);
      const event = await telemetryStore.recordClientEvent({ req, user, body });
      json(res, 200, { ok: true, event });
      return;
    }

    const requestUser = req.url.startsWith("/api/")
      ? await requireApiUser(req, res, url)
      : await currentUser(req);
    if (req.url.startsWith("/api/") && PUBLIC_DEPLOYMENT && !requestUser && !isPublicApi(url.pathname)) {
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/credits") {
      const user = await authStore.requireUser(req);
      json(res, 200, {
        ok: true,
        credits: await authStore.userCreditSummary(user.id),
        ledger: await authStore.listCreditLedger({ userId: user.id, limit: Number(url.searchParams.get("limit") || 50) }),
        usage: summarizeUsage(await authStore.listCreditLedger({ userId: user.id, limit: 500 })),
        billingMode: BILLING_MODE,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      await authStore.requireAdmin(req);
      json(res, 200, { ok: true, users: await authStore.listUsers({ limit: Number(url.searchParams.get("limit") || 200) }) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/admin/credits") {
      await authStore.requireAdmin(req);
      json(res, 200, { ok: true, ledger: await authStore.listCreditLedger({ userId: url.searchParams.get("user_id") || "", limit: Number(url.searchParams.get("limit") || 200) }) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/admin/telemetry") {
      await authStore.requireAdmin(req);
      json(res, 200, { ok: true, events: await telemetryStore.list({ limit: Number(url.searchParams.get("limit") || 300) }) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/admin/credits") {
      await authStore.requireAdmin(req);
      const body = await readBody(req).catch(() => ({}));
      const result = await authStore.applyCreditDelta({
        userId: body.user_id || body.userId,
        delta: Number(body.delta || 0),
        reason: body.reason || "admin_adjustment",
        tokens: Number(body.tokens || 0),
        metadata: { admin: true, note: body.note || "" },
      });
      json(res, 200, { ok: true, result });
      return;
    }
    if (req.method === "POST" && url.pathname === "/chat/completions") {
      const body = await readBody(req);
      if (body?.model === "stub-model") {
        const isAppraisal = body.messages?.some((message) => String(message.content || "").includes("affect appraisal engine"));
        json(res, 200, {
          choices: [{
            message: {
              content: isAppraisal
                ? JSON.stringify({ warmth: 0.45, reward: 0.2, goalProgress: 0.5, soothing: 0.2, safety: 0.2, uncertainty: 0.05, controllability: 0.6 })
                : "I heard you. The local stub model is responding.",
            },
          }],
        });
        return;
      }
    }
    if (PUBLIC_DEPLOYMENT && url.pathname.startsWith("/api/digital-life")) {
      json(res, 404, { ok: false, error: "API not found" });
      return;
    }
    if (await digitalLifeRoutes.handle(req, res, url)) {
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/board") {
      requirePublicAdmin(requestUser);
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
      requirePublicAdmin(requestUser);
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
      requirePublicAdmin(requestUser);
      const deviceId = deviceIdFrom(Object.fromEntries(url.searchParams.entries()), BOARD.id);
      json(res, 200, await withDevice(deviceId, () => fastRawBoardStatus()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/audio/status") {
      requirePublicAdmin(requestUser);
      const deviceId = deviceIdFrom(Object.fromEntries(url.searchParams.entries()), BOARD.id);
      json(res, 200, await withDevice(deviceId, () => runAudioRoute("status", () => audioStatus())));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/audio/play") {
      requirePublicAdmin(requestUser);
      const body = await readBody(req);
      const deviceId = deviceIdFrom(body || {}, BOARD.id);
      json(res, 200, await withDevice(deviceId, () => runAudioRoute("play", () => audioPlay(body || {}))));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/audio/record") {
      requirePublicAdmin(requestUser);
      const body = await readBody(req);
      const deviceId = deviceIdFrom(body || {}, BOARD.id);
      json(res, 200, await withDevice(deviceId, () => runAudioRoute("record", () => audioRecord(body || {}))));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/audio/stop") {
      requirePublicAdmin(requestUser);
      const body = await readBody(req).catch(() => ({}));
      const deviceId = deviceIdFrom(body || {}, BOARD.id);
      json(res, 200, await withDevice(deviceId, () => runAudioRoute("stop", () => audioStop())));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/logs") {
      requirePublicAdmin(requestUser);
      const limit = Number(url.searchParams.get("limit") || 80);
      json(res, 200, { ok: true, logs: await readServerLogTail(limit) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/verify") {
      requirePublicAdmin(requestUser);
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
    // --- Chat: 瀵硅瘽寮忚鍒掞紙涓嶇敓鎴愪唬鐮侊級 ---
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = withServerModelSettings(await readBody(req));
      try {
        if (body?.conversation_id) await ensureConversationAccess(body.conversation_id, requestUser);
        await ensureCreditsAvailable(requestUser);
        const result = await runAgentRequest({ ...(body || {}), action: "message" });
        await chargeAiUsage({ user: requestUser, body, result, reason: "chat" });
        await writeProjectMemorySafe(body?.conversation_id, {
          trigger: "chat",
          prompt: body?.prompt || body?.message || "",
        });
        await flushMutationSaves();
        json(res, 200, result);
      } catch (err) {
        const classified = classifyError(err);
        json(res, classified.statusCode || err.statusCode || 500, { ok: false, error: err.message, ...classified });
      }
      return;
    }
    // --- Clarify: 瀹炴椂闇€姹傜粏鍖?---
    if (req.method === "POST" && url.pathname === "/api/clarify") {
      const body = withServerModelSettings(await readBody(req));
      const prompt = String(body.prompt || "").trim();
      if (!prompt) { json(res, 400, { ok: false, error: "Prompt is required." }); return; }

      const modelSettings = normalizeModelSettings(body.modelSettings || {});
      if (!modelSettings.enabled) { json(res, 200, { ok: true, questions: null, source: "skip" }); return; }
      if (body?.conversation_id) await ensureConversationAccess(body.conversation_id, requestUser);
      await ensureCreditsAvailable(requestUser);

      const rawHistory = Array.isArray(body.history) ? body.history : [];
      const preferences = memoryStore.getAll();

      const result = await analyzeAndClarify(modelSettings, prompt, preferences, rawHistory);
      await chargeAiUsage({ user: requestUser, body, result: { source: "clarify" }, reason: "clarify" });
      json(res, 200, { ok: true, questions: result, source: result ? "llm" : "skip" });
      return;
    }

    // --- Preferences: 鐢ㄦ埛鍋忓ソ CRUD ---
    if (req.method === "GET" && url.pathname === "/api/preferences") {
      requirePublicAdmin(requestUser);
      json(res, 200, { ok: true, preferences: memoryStore.getAll() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/preferences") {
      requirePublicAdmin(requestUser);
      const body = await readBody(req);
      const { key, value, label, category, source } = body;
      if (!key || !value) { json(res, 400, { ok: false, error: "key and value required" }); return; }
      memoryStore.set(key, value, { label, category, source: source || "user" });
      await flushMutationSaves();
      json(res, 200, { ok: true, preferences: memoryStore.getAll() });
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/preferences") {
      requirePublicAdmin(requestUser);
      const body = await readBody(req);
      if (body.key) memoryStore.remove(body.key);
      else if (body.category) memoryStore.removeCategory(body.category);
      await flushMutationSaves();
      json(res, 200, { ok: true, preferences: memoryStore.getAll() });
      return;
    }

    // --- Experience: Agent 缁忛獙鏌ヨ ---
    if (req.method === "GET" && url.pathname === "/api/experience") {
      requirePublicAdmin(requestUser);
      const taskType = url.searchParams.get("type") || "general";
      const lessons = experienceStore.getLessons(taskType, 10);
      const stats = experienceStore.getStats(taskType);
      json(res, 200, { ok: true, lessons, stats });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/playbooks") {
      requirePublicAdmin(requestUser);
      const taskType = url.searchParams.get("type") || "general";
      const signature = url.searchParams.get("signature") || "";
      const limit = Number(url.searchParams.get("limit") || 10);
      const playbooks = playbookStore.findPlaybooks({ taskType, signature, limit });
      json(res, 200, { ok: true, playbooks });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/playbooks") {
      requirePublicAdmin(requestUser);
      const body = await readBody(req);
      const playbook = playbookStore.recordPlaybook(body || {});
      await flushMutationSaves();
      json(res, 200, { ok: true, playbook });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      let jobs = await jobStore.listJobs({
        limit: Number(url.searchParams.get("limit") || 50),
        conversationId: url.searchParams.get("conversation_id") || "",
        status: url.searchParams.get("status") || "",
      });
      jobs = filterJobsForUser(jobs, requestUser);
      json(res, 200, { ok: true, jobs });
      return;
    }
    if (req.method === "GET" && /^\/api\/jobs\/[^/]+$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.split("/")[3] || "");
      const job = await ensureJobAccess(await jobStore.getJob(jobId), requestUser);
      json(res, 200, { ok: true, job });
      return;
    }
    if (req.method === "POST" && /^\/api\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.split("/")[3] || "");
      try {
        await ensureJobAccess(await jobStore.getJob(jobId), requestUser);
        const job = await jobStore.requestCancel(jobId);
        await flushMutationSaves();
        json(res, 200, { ok: true, job });
      } catch (cancelErr) {
        json(res, 404, { ok: false, error: cancelErr.message });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const body = await readBody(req);
      const type = String(body?.type || "").trim();
      if (!["agent", "generate", "deploy"].includes(type)) {
        json(res, 400, { ok: false, error: "Unsupported job type" });
        return;
      }
      const payload = body?.payload && typeof body.payload === "object" ? body.payload : body;
      const executionContext = executionContextFromRequest(req, requestUser, {
        ...(payload || {}),
        operation: type,
      });
      if (payload?.conversation_id) await ensureConversationAccess(payload.conversation_id, requestUser);
      if (type === "agent" || type === "generate") await ensureCreditsAvailable(requestUser);
      const normalizedPayload = type === "generate"
        ? withServerModelSettings(payload || {}, { forceTemplate: PUBLIC_DEPLOYMENT && payload?.agent_full !== true && payload?.agentFull !== true })
        : { ...(payload || {}) };
      const jobInput = {
        ...normalizedPayload,
        organization_id: executionContext.organizationId,
        actor_id: executionContext.actorId,
        project_id: executionContext.projectId,
        application_id: executionContext.applicationId,
        build_id: executionContext.buildId,
        device_id: executionContext.deviceId,
        idempotency_key: executionContext.idempotencyKey,
        user_id: requestUser?.id || "",
      };
      const job = PUBLIC_DEPLOYMENT
        ? await runRequestBoundJob(type, jobInput)
        : await enqueueBackgroundJob(type, jobInput);
      await recordProductTelemetry({
        req,
        user: requestUser,
        body: payload,
        eventType: "job.queued",
        category: "job",
        action: type,
        extra: { job_id: job.id, job_type: type },
      });
      await flushMutationSaves();
      json(res, PUBLIC_DEPLOYMENT ? 200 : 202, { ok: true, job });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent") {
      const body = withServerModelSettings(await readBody(req));
      if (body?.conversation_id) await ensureConversationAccess(body.conversation_id, requestUser);
      await ensureCreditsAvailable(requestUser);
      await recordProductTelemetry({
        req,
        user: requestUser,
        body,
        eventType: "agent.request",
        category: "agent",
        action: body?.action || "message",
      });
      if (wantsBackgroundJob(body || {})) {
        const jobInput = { ...(body || {}), user_id: requestUser?.id || "" };
        const job = PUBLIC_DEPLOYMENT
          ? await runRequestBoundJob("agent", jobInput)
          : await enqueueBackgroundJob("agent", jobInput);
        await recordProductTelemetry({
          req,
          user: requestUser,
          body,
          eventType: "job.queued",
          category: "job",
          action: "agent",
          extra: { job_id: job.id, job_type: "agent" },
        });
        await flushMutationSaves();
        json(res, PUBLIC_DEPLOYMENT ? 200 : 202, { ok: true, job });
        return;
      }
      try {
        const result = await runAgentRequest(body || {});
        await chargeAiUsage({ user: requestUser, body, result, reason: body?.action === "confirm_build" ? "agent_build" : "agent" });
        await writeProjectMemorySafe(body?.conversation_id, {
          trigger: body?.action === "confirm_build" ? "agent-confirm-build" : "agent",
          buildId: result?.id || result?.build_id || "",
          prompt: body?.prompt || body?.build_prompt || body?.message || "",
        });
        await recordProductTelemetry({
          req,
          user: requestUser,
          body,
          eventType: "agent.success",
          category: "agent",
          action: body?.action || "message",
          extra: {
            ready_to_build: Boolean(result?.ready_to_build),
            mode_boundary: result?.mode_boundary?.mode || "",
          },
        });
        await flushMutationSaves();
        json(res, 200, result);
      } catch (err) {
        const classified = classifyError(err);
        await recordProductTelemetry({
          req,
          user: requestUser,
          body,
          eventType: "agent.error",
          category: "agent",
          action: body?.action || "message",
          severity: "error",
          extra: {
            error: err.message,
            errorType: classified.errorType || "",
            errorStage: classified.errorStage || "",
          },
        });
        json(res, classified.statusCode || err.statusCode || 500, { ok: false, error: err.message, ...classified });
      }
      return;
    }

    // --- Generate: AI 浠ｇ爜鐢熸垚 ---
    if (req.method === "POST" && url.pathname === "/api/generate") {
      let body = {};
      try {
        const rawBody = await readBody(req);
        body = withServerModelSettings(rawBody, {
          forceTemplate: PUBLIC_DEPLOYMENT && rawBody?.agent_full !== true && rawBody?.agentFull !== true,
        });
        if (body?.conversation_id) await ensureConversationAccess(body.conversation_id, requestUser);
        await ensureCreditsAvailable(requestUser);
        if (wantsBackgroundJob(body || {})) {
          const jobInput = { ...(body || {}), user_id: requestUser?.id || "" };
          const job = PUBLIC_DEPLOYMENT
            ? await runRequestBoundJob("generate", jobInput)
            : await enqueueBackgroundJob("generate", jobInput);
          await recordProductTelemetry({
            req,
            user: requestUser,
            body,
            eventType: "job.queued",
            category: "job",
            action: "generate",
            extra: { job_id: job.id, job_type: "generate" },
          });
          await flushMutationSaves();
          json(res, PUBLIC_DEPLOYMENT ? 200 : 202, { ok: true, job });
          return;
        }
        const result = await runGenerateRequest(body || {});
        await chargeAiUsage({ user: requestUser, body, result, reason: "generate" });
        await writeProjectMemorySafe(body?.conversation_id, {
          trigger: "generate",
          buildId: result?.id || "",
          prompt: body?.prompt || body?.build_prompt || "",
        });
        await recordProductTelemetry({
          req,
          user: requestUser,
          body,
          eventType: "generate.success",
          category: "generate",
          action: "generate",
          extra: {
            build_id: result?.id || "",
            file_count: Object.keys(result?.files || {}).length,
            verification_ok: Boolean(result?.verification?.ok),
          },
        });
        await flushMutationSaves();
        json(res, 200, result);
      } catch (error) {
        const classified = classifyError(error, { stage: "generate" });
        await recordProductTelemetry({
          req,
          user: requestUser,
          body,
          eventType: "generate.error",
          category: "generate",
          action: "generate",
          severity: "error",
          extra: {
            error: error.message,
            errorType: classified.errorType || "",
            errorStage: classified.errorStage || "",
          },
        });
        json(res, classified.statusCode || error.statusCode || 500, {
          ok: false,
          error: error.message,
          ...classified,
          stdout: error.stdout,
          stderr: error.stderr,
        });
      }
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
        intelligenceSummary: currentBuild?.intelligenceSummary || null,
        evidence: formatRunEvidence(currentBuild?.agentRun || {}),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/deploy") {
      requirePublicAdmin(requestUser);
      try {
        const body = await readBody(req);
        if (wantsBackgroundJob(body || {})) {
          const job = await enqueueBackgroundJob("deploy", body || {});
          await flushMutationSaves();
          json(res, 202, { ok: true, job });
          return;
        }
        const result = await runDeployRequest(body || {});
        await writeProjectMemorySafe(body?.conversation_id, {
          trigger: "deploy-confirmed",
          buildId: result?.id || currentBuild?.id || "",
          prompt: currentBuild?.prompt || "",
          deploy: result,
        });
        await flushMutationSaves();
        json(res, 200, result);
      } catch (error) {
        console.error("[deploy] Error:", error.message);
        console.error("[deploy] Stack:", error.stack);
        if (error.stdout) console.error("[deploy] stdout:", error.stdout);
        if (error.stderr) console.error("[deploy] stderr:", error.stderr);
        const classified = classifyError(error);
        json(res, classified.statusCode || error.statusCode || 500, {
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
      const conversations = await conversationStore.listConversations({ userId: requestUser?.id || "" });
      json(res, 200, { ok: true, conversations });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/conversations") {
      const body = await readBody(req).catch(() => ({}));
      const title = String(body?.title || "New Project").trim() || "New Project";
      const conversation = await conversationStore.createConversation(randomUUID(), title, { userId: requestUser?.id || "" });
      const project = await projectWorkspace.ensureProject(conversation.id, title);
      await writeProjectMemorySafe(conversation.id, { trigger: "project-created" });
      await recordProductTelemetry({
        req,
        user: requestUser,
        body: { conversation_id: conversation.id },
        eventType: "project.created",
        category: "project",
        action: "created",
        extra: { title },
      });
      await flushMutationSaves();
      json(res, 200, {
        ok: true,
        id: conversation.id,
        title: project.title || title,
        project_dir: project.project_dir,
        projects_root: projectWorkspace.baseDir,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/projects/root") {
      await projectWorkspace.ensureBaseDir();
      json(res, 200, { ok: true, root: projectWorkspace.baseDir });
      return;
    }
    // Delete conversation and its messages
    if (req.method === "DELETE" && /^\/api\/conversations\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      if (convId && !parts[4]) {
        await ensureConversationAccess(convId, requestUser);
        assetLibraryStore.deleteConversationAssets(convId);
        await conversationStore.deleteConversation(convId);
        await flushMutationSaves();
        json(res, 200, { ok: true });
      } else {
        json(res, 400, { ok: false, error: "Invalid conversation ID" });
      }
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/messages")) {
      const convId = url.pathname.split("/")[3];
      await ensureConversationAccess(convId, requestUser);
      const messages = await conversationStore.listMessages(convId);
      json(res, 200, { ok: true, messages });
      return;
    }
    // Load saved files for a conversation (for state restoration)
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/files")) {
      const convId = url.pathname.split("/")[3];
      await ensureConversationAccess(convId, requestUser);
      const { buildId, files } = await conversationStore.loadConversationFiles(convId);
      json(res, 200, { ok: true, buildId, files });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/") && url.pathname.includes("/preview")) {
      const resolved = resolveConversationPreviewFile(url.pathname);
      if (!resolved || resolved.error) {
        json(res, 400, { ok: false, error: resolved?.error || "Invalid preview path" });
        return;
      }
      await ensureConversationAccess(resolved.conversationId, requestUser);
      const { buildId, files } = await previewFilesForConversation(resolved.conversationId);
      if (!Object.keys(files).length || !(resolved.filename in files)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("Conversation preview not found");
        return;
      }
      const content = resolved.filename === "index.html"
        ? rewriteConversationPreviewHtml(files[resolved.filename], resolved.conversationId, buildId)
        : files[resolved.filename];
      const body = Buffer.isBuffer(content)
        ? content
        : Buffer.from(String(content || ""), "utf8");
      res.writeHead(200, {
        "Content-Type": responseContentType(resolved.filename),
        "Content-Length": body.length,
        "Cache-Control": "no-store"
      });
      res.end(body);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/memory")) {
      const convId = url.pathname.split("/")[3];
      await ensureConversationAccess(convId, requestUser);
      json(res, 200, { ok: true, project_memory: await conversationStore.getProjectMemory(convId) });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/project-files")) {
      const convId = url.pathname.split("/")[3];
      await ensureConversationAccess(convId, requestUser);
      const existingConversation = await conversationStore.getConversation(convId);
      if (existingConversation) {
        await projectWorkspace.ensureProject(convId, existingConversation.title || "New Project");
        await flushMutationSaves();
      }
      const files = await projectWorkspace.listProjectFiles(convId);
      const conversation = await conversationStore.getConversation(convId);
      json(res, 200, { ok: true, project_dir: conversation?.project_dir || "", files });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/project-file")) {
      const convId = url.pathname.split("/")[3];
      await ensureConversationAccess(convId, requestUser);
      const relativePath = url.searchParams.get("path") || "";
      const file = await projectWorkspace.readProjectFile(convId, relativePath);
      if (!file) {
        json(res, 404, { ok: false, error: "Project file not found" });
        return;
      }
      json(res, 200, { ok: true, file });
      return;
    }
    if (url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/assets")) {
      const convId = url.pathname.split("/")[3];
      await ensureConversationAccess(convId, requestUser);
      if (req.method === "GET") {
        assetLibraryStore.ensureDefaultFolders(convId);
        json(res, 200, {
          ok: true,
          assets: assetLibraryStore.listAssets(convId),
          folders: assetLibraryStore.listFolders(convId),
          summary: assetLibraryStore.summarize(convId),
        });
        return;
      }
      if (req.method === "POST") {
        try {
          const body = await readBody(req, { limitBytes: 64 * 1024 * 1024 });
          await projectWorkspace.ensureProject(convId, (await conversationStore.getConversation(convId))?.title || "New Project");
          assetLibraryStore.ensureDefaultFolders(convId);
          const result = assetLibraryStore.addAssets(convId, Array.isArray(body.assets) ? body.assets : [], {
            folderId: body.folder_id || body.folderId || "",
            persistAssetFile: asset => projectWorkspace.persistAssetFile(convId, asset),
          });
          await result.persistence;
          const assets = assetLibraryStore.listAssets(convId);
          const summary = assetLibraryStore.summarize(convId);
          await appendServerLog("assets.uploaded", {
            conversationId: convId,
            count: assets.length,
            rejected: result.rejected.length,
            kinds: summary.byKind,
          });
          await writeProjectMemorySafe(convId, { trigger: "assets-uploaded" });
          await flushMutationSaves();
          json(res, 200, { ok: true, assets, folders: assetLibraryStore.listFolders(convId), rejected: result.rejected, summary });
        } catch (assetErr) {
          const classified = classifyError(assetErr);
          json(res, classified.statusCode || assetErr.statusCode || 400, { ok: false, error: assetErr.message, ...classified });
        }
        return;
      }
    }
    if (url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/asset-folders")) {
      const convId = url.pathname.split("/")[3];
      await ensureConversationAccess(convId, requestUser);
      if (req.method === "GET") {
        json(res, 200, { ok: true, folders: assetLibraryStore.ensureDefaultFolders(convId) });
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const folder = assetLibraryStore.createFolder(convId, body.name || "新建文件夹");
        await writeProjectMemorySafe(convId, { trigger: "asset-folder-created" });
        await flushMutationSaves();
        json(res, 200, { ok: true, folder, folders: assetLibraryStore.listFolders(convId) });
        return;
      }
    }
    if (url.pathname.startsWith("/api/conversations/") && url.pathname.includes("/asset-folders/")) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      const folderId = decodeURIComponent(parts[5] || "");
      await ensureConversationAccess(convId, requestUser);
      try {
        if (req.method === "PATCH") {
          const body = await readBody(req).catch(() => ({}));
          const folder = assetLibraryStore.updateFolder(convId, folderId, { name: body.name });
          if (!folder) {
            json(res, 404, { ok: false, error: "Folder not found" });
            return;
          }
          await writeProjectMemorySafe(convId, { trigger: "asset-folder-renamed" });
          await flushMutationSaves();
          json(res, 200, { ok: true, folder, folders: assetLibraryStore.listFolders(convId) });
          return;
        }
        if (req.method === "DELETE") {
          const result = assetLibraryStore.deleteFolder(convId, folderId);
          if (!result) {
            json(res, 404, { ok: false, error: "Folder not found" });
            return;
          }
          await writeProjectMemorySafe(convId, { trigger: "asset-folder-deleted" });
          await flushMutationSaves();
          json(res, 200, { ok: true, ...result, folders: assetLibraryStore.listFolders(convId), assets: assetLibraryStore.listAssets(convId) });
          return;
        }
      } catch (folderErr) {
        const classified = classifyError(folderErr);
        json(res, classified.statusCode || folderErr.statusCode || 400, { ok: false, error: folderErr.message, ...classified });
        return;
      }
    }
    if (req.method === "PATCH" && url.pathname.startsWith("/api/conversations/") && url.pathname.includes("/assets/")) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      const assetId = decodeURIComponent(parts[5] || "");
      await ensureConversationAccess(convId, requestUser);
      const body = await readBody(req).catch(() => ({}));
      let current = assetLibraryStore.getAsset(convId, assetId);
      if (!current) {
        json(res, 404, { ok: false, error: "Asset not found" });
        return;
      }
      let projectPath = body.projectPath ?? body.project_path;
      if (body.name != null && current.project_path) {
        projectPath = await projectWorkspace.renameAssetFile(convId, current.project_path, body.name).catch(() => current.project_path);
      }
      const asset = assetLibraryStore.updateAsset(convId, assetId, {
        name: body.name,
        usage: body.usage,
        folderId: body.folderId ?? body.folder_id,
        projectPath,
      });
      await writeProjectMemorySafe(convId, { trigger: "asset-updated" });
      await flushMutationSaves();
      json(res, 200, { ok: true, asset, folders: assetLibraryStore.listFolders(convId), summary: assetLibraryStore.summarize(convId) });
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/conversations/") && url.pathname.includes("/assets/")) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      const assetId = decodeURIComponent(parts[5] || "");
      await ensureConversationAccess(convId, requestUser);
      assetLibraryStore.deleteAsset(convId, assetId);
      await flushMutationSaves();
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/messages")) {
      const convId = url.pathname.split("/")[3];
      await ensureConversationAccess(convId, requestUser);
      const body = await readBody(req);
      await conversationStore.appendMessage(convId, body);
      await flushMutationSaves();
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/conversations/")) {
      const convId = url.pathname.split("/")[3];
      await ensureConversationAccess(convId, requestUser);
      assetLibraryStore.deleteConversationAssets(convId);
      await conversationStore.deleteConversation(convId);
      await flushMutationSaves();
      json(res, 200, { ok: true });
      return;
    }

    // Market APIs
    if (req.method === "GET" && url.pathname === "/api/market") {
      json(res, 200, await marketRuntime.listApps());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/market/publish") {
      try {
        const body = await readBody(req);
        json(res, 200, await marketRuntime.publishApp(body || {}));
      } catch (publishErr) {
        const classified = classifyError(publishErr);
        json(res, classified.statusCode || publishErr.statusCode || 500, {
          ok: false,
          error: publishErr.message,
          ...classified,
          previewReport: publishErr.previewReport,
        });
      }
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/market/") && url.pathname.endsWith("/preview")) {
      const appId = url.pathname.split("/")[3];
      try {
        const body = await readBody(req).catch(() => ({}));
        json(res, 200, await marketRuntime.previewApp(appId, {
          ...(body || {}),
          req,
          requestUser,
        }));
      } catch (previewErr) {
        const classified = classifyError(previewErr);
        json(res, classified.statusCode || previewErr.statusCode || 500, {
          ok: false,
          error: previewErr.message,
          ...classified,
        });
      }
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/market/") && !url.pathname.includes("/deploy")) {
      const appId = url.pathname.split("/")[3];
      try {
        json(res, 200, marketRuntime.getApp(appId));
      } catch (marketErr) {
        const classified = classifyError(marketErr);
        json(res, classified.statusCode || marketErr.statusCode || 500, { ok: false, error: marketErr.message, ...classified });
      }
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/market/") && url.pathname.endsWith("/deploy")) {
      const appId = url.pathname.split("/")[3];

      try {
        const body = await readBody(req);
        json(res, 200, await marketRuntime.deployApp(appId, body || {}));
      } catch (deployErr) {
        const classified = classifyError(deployErr);
        if (deployErr.statusCode) {
          json(res, classified.statusCode || deployErr.statusCode, { ok: false, error: deployErr.message, ...classified });
        } else {
          json(res, classified.statusCode || 500, { ok: false, error: deployErr.message, ...classified });
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
    if (url?.pathname !== "/api/telemetry") {
      await telemetryStore.record({
        req,
        user: await currentUser(req).catch(() => null),
        eventType: "server.error",
        category: "api",
        action: url?.pathname || req.url || "",
        page: url?.pathname || "",
        severity: "error",
        payload: {
          message: error.message,
          statusCode: classified.statusCode || error.statusCode || 500,
          errorType: classified.errorType || "",
          stack: process.env.NODE_ENV === "production" ? "" : error.stack,
        },
      }).catch(() => {});
    }
    json(res, classified.statusCode || error.statusCode || 500, {
      ok: false,
      error: error.message,
      ...classified,
      stdout: error.stdout,
      stderr: error.stderr
    });
  }
}

await ensureInitialGenerated();

const server = http.createServer(route);
function onListen() {
  const shownHost = HOST || "0.0.0.0";
  console.log(`VibeBoard MVP listening on http://${shownHost}:${PORT}/ -> ${BOARD.id}:${BOARD.port}`);
}
if (HOST) server.listen(PORT, HOST, onListen);
else server.listen(PORT, onListen);
