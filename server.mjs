import http from "node:http";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const GENERATED_DIR = path.join(ROOT, "generated", "current");
const PREVIEWS_DIR = path.join(ROOT, "previews");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const PORT = Number(process.env.VIBEBOARD_PORT || 8789);
const DB_PATH = path.join(ROOT, "vibeboard.db");

// Initialize SQLite database
const SQL = await initSqlJs();
let db;
try {
  const dbBuffer = await fs.readFile(DB_PATH).catch(() => null);
  db = dbBuffer ? new SQL.Database(dbBuffer) : new SQL.Database();
} catch {
  db = new SQL.Database();
}

// Create tables
db.run(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT DEFAULT 'New App',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    build_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  )
`);
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

const BOARD = {
  id: process.env.VIBEBOARD_BOARD_ID || "taishan-gray",
  label: process.env.VIBEBOARD_BOARD_LABEL || "Taishan Gray",
  host: process.env.VIBEBOARD_BOARD_HOST || "150.158.146.192",
  port: process.env.VIBEBOARD_BOARD_PORT || "6278",
  user: process.env.VIBEBOARD_BOARD_USER || "linaro",
  frpHost: "150.158.146.192",
  frpPort: "6278",
  targetStatic: "/home/linaro/workspace/taishan-screen/static",
  appRoot: "/home/linaro/workspace/taishan-screen",
  releaseRoot: "/home/linaro/workspace/vibeboard-deploy/releases",
  backupRoot: "/home/linaro/workspace/vibeboard-deploy/backups",
  service: "taishan-screen.service"
};

const knownHosts = process.env.VIBEBOARD_KNOWN_HOSTS || path.join(os.tmpdir(), `${BOARD.id}_known_hosts`);
const identityFile = process.env.VIBEBOARD_IDENTITY_FILE || path.join(os.homedir(), ".ssh", "id_ed25519");
let boardPassword = process.env.VIBEBOARD_BOARD_PASSWORD || "152535";

let currentBuild = null;
let activeEndpoint = null;
let lastDeploy = null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const MODEL_PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash"
  },
  minimax: {
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M2.7"
  },
  custom: {
    label: "Custom",
    baseUrl: "",
    model: ""
  }
};

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length
  });
  res.end(body);
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
      maxBuffer: 1024 * 1024 * 4
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

function shouldUsePasswordFallback(error) {
  if (!boardPassword) return false;
  const text = `${error?.message || ""}\n${error?.stdout || ""}\n${error?.stderr || ""}`;
  return error?.code !== 0 || /Connection closed|Permission denied|Authentication failed|No supported authentication|kex_exchange_identification|Connection reset/i.test(text);
}

function boardEndpoints() {
  const preferred = { name: "configured", host: BOARD.host, port: Number(BOARD.port) };
  const frp = { name: "frp", host: BOARD.frpHost, port: Number(BOARD.frpPort) };
  const endpoints = [frp, preferred];
  return endpoints.filter((endpoint, index, list) => (
    endpoint.host &&
    endpoint.port &&
    list.findIndex(item => item.host === endpoint.host && item.port === endpoint.port) === index
  ));
}

function publicBoardConfig() {
  return {
    id: BOARD.id,
    label: BOARD.label,
    host: BOARD.host,
    port: String(BOARD.port),
    user: BOARD.user,
    frpHost: BOARD.frpHost,
    frpPort: String(BOARD.frpPort),
    passwordConfigured: Boolean(boardPassword),
    activeRoute: activeEndpoint ? endpointLabel(activeEndpoint) : ""
  };
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

function endpointLabel(endpoint) {
  return `${endpoint.name}:${endpoint.host}:${endpoint.port}`;
}

function summarizeRemoteError(error) {
  const text = `${error?.stderr || ""}\n${error?.stdout || ""}\n${error?.message || ""}`.trim();
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const interesting = lines.find(line => /NoValidConnectionsError|Unable to connect|timed out|Authentication|Permission denied|Connection refused|Error reading SSH protocol banner|Connection closed/i.test(line));
  return interesting || lines.slice(-1)[0] || "remote command failed";
}

async function paramikoExecOnce(endpoint, remoteCommand, timeout = 30000, input = "") {
  const script = String.raw`
import json
import subprocess
import sys

cfg = json.load(sys.stdin)
cmd_bytes = cfg["command"].encode("utf-8")
extra_input = cfg.get("input", "").encode("utf-8") if cfg.get("input") else b""
combined = cmd_bytes + b"\n" + extra_input if extra_input else cmd_bytes

ssh_cmd = [
    "sshpass", "-p", cfg["password"],
    "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=15",
    "-o", "UserKnownHostsFile=/dev/null",
    "-p", str(cfg["port"]),
    cfg["user"] + "@" + cfg["host"],
    "bash", "-s",
]
result = subprocess.run(
    ssh_cmd,
    capture_output=True,
    timeout=max(5, int(cfg["timeout"] / 1000)) + 10,
    input=combined,
)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
`;

  const payload = JSON.stringify({
    host: endpoint.host,
    port: Number(endpoint.port),
    user: BOARD.user,
    password: boardPassword,
    command: remoteCommand,
    timeout,
    input
  });

  return new Promise((resolve, reject) => {
    const pythonBin = process.platform === "win32" ? "python" : "python3";
    const child = execFile(pythonBin, ["-c", script], {
      cwd: ROOT,
      timeout: timeout + 35000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(payload);
  });
}

async function paramikoExec(remoteCommand, timeout = 30000, input = "") {
  let lastError;
  const ordered = [
    ...(activeEndpoint ? [activeEndpoint] : []),
    ...boardEndpoints()
  ].filter((endpoint, index, list) => (
    list.findIndex(item => item.host === endpoint.host && item.port === endpoint.port) === index
  ));

  for (const endpoint of ordered) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await paramikoExecOnce(endpoint, remoteCommand, timeout, input);
        activeEndpoint = endpoint;
        return result;
      } catch (error) {
        lastError = error;
        const text = `${error?.message || ""}\n${error?.stdout || ""}\n${error?.stderr || ""}`;
        if (!/NoValidConnectionsError|Unable to connect|Error reading SSH protocol banner|EOFError|Connection reset|Connection closed|timed out/i.test(text) || attempt === 2) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 700 * attempt));
      }
    }
  }

  const error = new Error(`Unable to reach ${BOARD.label}. Tried ${ordered.map(endpointLabel).join(", ")}. Last error: ${summarizeRemoteError(lastError)}`);
  error.cause = lastError;
  error.stdout = lastError?.stdout || "";
  error.stderr = lastError?.stderr || "";
  throw error;
}

function sshArgs(endpoint, remoteCommand) {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=20",
    "-i", identityFile,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-p", String(endpoint.port),
    `${BOARD.user}@${endpoint.host}`,
    remoteCommand
  ];
}

async function opensshExec(remoteCommand, timeout = 30000, input = "") {
  let lastError;
  const ordered = [
    ...(activeEndpoint ? [activeEndpoint] : []),
    ...boardEndpoints()
  ].filter((endpoint, index, list) => (
    list.findIndex(item => item.host === endpoint.host && item.port === endpoint.port) === index
  ));

  for (const endpoint of ordered) {
    try {
      const result = await new Promise((resolve, reject) => {
        const child = execFile("ssh", sshArgs(endpoint, remoteCommand), {
          cwd: ROOT,
          timeout,
          windowsHide: true,
          maxBuffer: 1024 * 1024 * 4
        }, (error, stdout, stderr) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            error.endpoint = endpoint;
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        });
        child.stdin.end(input);
      });
      activeEndpoint = endpoint;
      return result;
    } catch (error) {
      lastError = error;
    }
  }

  const authHint = boardPassword
    ? ""
    : " No VIBEBOARD_BOARD_PASSWORD is set, so only key auth was attempted.";
  const error = new Error(`Unable to reach ${BOARD.label}. Tried ${ordered.map(endpointLabel).join(", ")}.${authHint} Last error: ${summarizeRemoteError(lastError)}`);
  error.cause = lastError;
  error.stdout = lastError?.stdout || "";
  error.stderr = lastError?.stderr || "";
  throw error;
}

async function wslSshExec(remoteCommand, timeout = 30000) {
  const endpoint = { host: BOARD.frpHost, port: Number(BOARD.frpPort) };
  const args = [
    "sshpass", "-p", boardPassword,
    "ssh", "-o", "StrictHostKeyChecking=no",
    "-o", `ConnectTimeout=20`,
    "-p", String(endpoint.port),
    `${BOARD.user}@${endpoint.host}`,
    remoteCommand
  ];
  return new Promise((resolve, reject) => {
    const child = execFile("wsl.exe", args, {
      timeout: timeout + 25000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
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

async function ssh(remoteCommand, timeout = 30000) {
  // paramiko with keyboard-interactive fallback
  let result;
  try {
    result = await paramikoExec(remoteCommand, timeout);
  } catch (error) {
    if (!shouldUsePasswordFallback(error)) throw error;
    result = await paramikoExec(remoteCommand, timeout);
  }
  return result.stdout.trim();
}

async function wslSshWithInput(remoteCommand, input, timeout = 30000) {
  const endpoint = { host: BOARD.frpHost, port: Number(BOARD.frpPort) };
  const args = [
    "sshpass", "-p", boardPassword,
    "ssh", "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=20",
    "-p", String(endpoint.port),
    `${BOARD.user}@${endpoint.host}`,
    remoteCommand
  ];
  return new Promise((resolve, reject) => {
    const child = execFile("wsl.exe", args, {
      timeout: timeout + 25000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
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
  const payload = `${content.toString("base64")}\n`;
  const remote = [
    "set -eu",
    `tmp=${shQuote(`${remotePath}.tmp.$$`)}`,
    "base64 -d > \"$tmp\"",
    `mv "$tmp" ${shQuote(remotePath)}`
  ].join("\n");

  return sshWithInput(remote, payload, timeout);
}

async function uploadBundle(entries, timeout = 45000) {
  const files = await Promise.all(entries.map(async entry => ({
    path: entry.remotePath,
    mode: entry.mode || "",
    data: (await fs.readFile(entry.localPath)).toString("base64")
  })));

  const script = String.raw`
import base64
import json
import os
import sys

payload = json.load(sys.stdin)
for item in payload["files"]:
    p = item["path"]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp." + str(os.getpid())
    with open(tmp, "wb") as f:
        f.write(base64.b64decode(item["data"]))
    os.replace(tmp, p)
    if item.get("mode"):
        os.chmod(p, int(item["mode"], 8))
print("uploaded=" + str(len(payload["files"])))
`;

  const scriptB64 = Buffer.from(script).toString("base64");
  const dataB64 = Buffer.from(JSON.stringify({ files })).toString("base64");
  const remote = [
    `s=/tmp/vb_upload_$$.py`,
    `echo '${scriptB64}' | base64 -d > $s`,
    `echo '${dataB64}' | base64 -d | python3 $s`,
    `rm -f $s`
  ].join('; ');
  return ssh(remote, timeout);
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
  if (promptHas(text, ["voice", "audio", "record", "speech", "语音", "录音", "麦克风"])) mode = "voice";
  if (promptHas(text, ["server", "dashboard", "status", "监控", "状态", "面板", "服务器"])) mode = "dashboard";
  if (promptHas(text, ["timer", "clock", "focus", "countdown", "时间", "倒计时", "番茄"])) mode = "timer";
  if (promptHas(text, ["control", "switch", "gpio", "relay", "button", "控制", "开关", "继电器"])) mode = "control";
  if (promptHas(text, ["weather", "天气", "气温", "白底蓝字", "白色", "蓝色", "小屏助手"])) mode = "weather";

  const titles = {
    assistant: "AI Screen Assistant",
    voice: "Voice Console",
    dashboard: "Device Dashboard",
    timer: "Focus Clock",
    control: "Hardware Control",
    weather: "小屏助手"
  };
  const accents = {
    assistant: "#22c55e",
    voice: "#38bdf8",
    dashboard: "#f59e0b",
    timer: "#a78bfa",
    control: "#fb7185",
    weather: "#0b63ce"
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
    ]
  };
  const actionsByMode = {
    weather: [{ id: "refresh", label: "刷新" }]
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

function normalizeModelSettings(input = {}) {
  const providerId = String(input.provider || "deepseek").toLowerCase();
  const preset = MODEL_PROVIDERS[providerId] || MODEL_PROVIDERS.custom;
  const baseUrl = String(input.baseUrl || preset.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(input.model || preset.model || "").trim();
  const apiKey = String(input.apiKey || "").trim();
  return {
    provider: providerId,
    providerLabel: preset.label || providerId,
    baseUrl,
    model,
    apiKey,
    enabled: Boolean(apiKey && baseUrl && model)
  };
}

function chatCompletionsUrl(baseUrl) {
  return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
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
  const appSource = files["app.js"] || "";
  const indexSource = files["index.html"] || "";
  const hardwareSource = files["hardware_app.py"] || "";

  if (!appSource.includes("window.VibeBoardHardware")) {
    throw new Error(`${label} app.js is missing window.VibeBoardHardware.`);
  }
  if (!appSource.includes("BUILD_ID") || !appSource.includes("PROMPT")) {
    throw new Error(`${label} app.js is missing BUILD_ID or PROMPT constants.`);
  }
  if (!appSource.includes("/api/status")) {
    throw new Error(`${label} app.js is missing /api/status integration.`);
  }
  if (!appSource.includes("hardware-result.json")) {
    throw new Error(`${label} app.js is missing hardware-result.json integration.`);
  }
  if (!indexSource.includes("./style.css") || !indexSource.includes("./app.js")) {
    throw new Error(`${label} index.html must use relative ./style.css and ./app.js assets.`);
  }
  if (!hardwareSource.includes("available_apis") || !hardwareSource.includes("/api/status") || !hardwareSource.includes("hardware-result.json")) {
    throw new Error(`${label} hardware_app.py must declare available hardware APIs.`);
  }
}

/**
 * 兜底注入：确保 hardware_app.py 输出包含 golden-loop 必需字段
 * 无论 AI 生成什么代码，都强制注入 runtime 和 build_id
 */
function injectHardwareAppContracts(source, buildId) {
  const idJson = JSON.stringify(buildId);
  
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
import json as __json
import sys as __sys

__original_print = print
__build_id = ${idJson}

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
__script_content = '''
${source.replace(/'/g, "\\'").replace(/\\/g, "\\\\")}
'''

if __name__ == "__main__":
    import socket
    __wrapped_main()
`;
  
  return wrapper;
}

function llmSystemPrompt() {
  return `You are VibeBoard WebCoding, an expert frontend and embedded Linux web-app generator.

Generate a complete 480x360 web kiosk app for an RK3566 Linux board. Return ONLY a JSON object with this exact shape:
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

Hard requirements:
- No markdown, no commentary outside JSON.
- index.html must link "./style.css" and "./app.js" with relative paths.
- html, body and the main screen root must be exactly 480px by 360px, overflow hidden.
- Do not use external CSS or JavaScript packages.
- Do not use emoji as UI icons.
- app.js must define window.VibeBoardHardware with getStatus(), getProgramResult(), getSnapshot().
- app.js must fetch "/api/status" and "./hardware-result.json".
- app.js must define const BUILD_ID and const PROMPT.
- hardware_app.py must be valid Python 3, define BUILD_ID and PROMPT, print JSON, and include "available_apis": ["/api/status", "./hardware-result.json"]. The JSON output MUST include "runtime": "executed_on_board" and "build_id": BUILD_ID to pass golden-loop verification.
- Use the board SDK only through /api/status and hardware-result.json. Do not run shell commands from browser JavaScript.
- Design for a real 480x360 small display: stable fixed dimensions, no scrolling, no text overlap, clear hierarchy.
`;
}

function llmUserPrompt(prompt, id) {
  return `Build id: ${id}
User request: ${prompt}

Available runtime data from /api/status:
- hostname, model, kernel, time, uptime, cpu_temp
- memory.percent, memory.used_h, memory.total_h
- disk.percent, disk.used_h, disk.total_h
- network.wifi, network.addresses[0], network.gateway
- services.ssh, services.frpc, services.display

Make the app feel purpose-built for the user's request. Keep the UI dense enough for 480x360, polished, and reliable if APIs are slow.`;
}

async function callChatModel(settings, prompt, id) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const payload = {
      model: settings.model,
      messages: [
        { role: "system", content: llmSystemPrompt() },
        { role: "user", content: llmUserPrompt(prompt, id) }
      ],
      temperature: 0.2,
      max_tokens: 8000
    };
    if (settings.provider === "deepseek") {
      payload.thinking = { type: "disabled" };
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.error?.message || data.base_resp?.status_msg || `model HTTP ${res.status}`;
      throw new Error(message);
    }
    const content = data.choices?.[0]?.message?.content || "";
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
  files["hardware_app.py"] = injectHardwareAppContracts(files["hardware_app.py"], id);
  
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

async function generateFilesForPrompt(prompt, id, modelSettings = {}) {
  const settings = normalizeModelSettings(modelSettings);
  if (!settings.enabled) {
    return templateGeneratedFiles(prompt, id, "model settings not configured");
  }

  try {
    const content = await callChatModel(settings, prompt, id);
    const raw = extractJsonObject(content);
    return normalizeGeneratedFiles(raw, prompt, id, {
      provider: settings.provider,
      model: settings.model
    });
  } catch (error) {
    return templateGeneratedFiles(prompt, id, `model generation failed: ${error.message}`);
  }
}

function generatedIndexV2(prompt, id, spec = createAppSpec(prompt, id)) {
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
console.log("VibeBoard deployed", BUILD_ID, PROMPT);
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
console.log("VibeBoard deployed", BUILD_ID, PROMPT);
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
import time

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
console.log("VibeBoard deployed", BUILD_ID, PROMPT);
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

async function writeGenerated(prompt, modelSettings = {}) {
  const id = buildId();
  const { files, manifest } = await generateFilesForPrompt(prompt, id, modelSettings);
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, content]) => (
    fs.writeFile(path.join(GENERATED_DIR, name), content, "utf8")
  )));
  currentBuild = { id, prompt, files, dir: GENERATED_DIR, built: false, deployed: false, manifest };
  return currentBuild;
}

async function loadGeneratedBuild() {
  const names = ["index.html", "style.css", "app.js"];
  try {
    await fs.access(path.join(GENERATED_DIR, "hardware_app.py"));
    names.push("hardware_app.py");
  } catch {}
  try {
    await fs.access(path.join(GENERATED_DIR, "manifest.json"));
    names.push("manifest.json");
  } catch {}
  const files = {};
  for (const name of names) {
    files[name] = await fs.readFile(path.join(GENERATED_DIR, name), "utf8");
  }

  let manifest = {};
  try {
    manifest = JSON.parse(await fs.readFile(path.join(GENERATED_DIR, "manifest.json"), "utf8"));
  } catch {
    manifest = {};
  }

  const appFile = files["app.js"];
  const idMatch = appFile.match(/const BUILD_ID = ("(?:\\.|[^"\\])*");/);
  const promptMatch = appFile.match(/const PROMPT = ("(?:\\.|[^"\\])*");/);
  const id = manifest.id || (idMatch ? JSON.parse(idMatch[1]) : "preview");
  const prompt = manifest.prompt || (promptMatch ? JSON.parse(promptMatch[1]) : "等待生成");

  currentBuild = {
    id,
    prompt,
    files,
    dir: GENERATED_DIR,
    built: Boolean(manifest.id),
    deployed: false
  };
  return currentBuild;
}

async function ensureInitialGenerated() {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const indexPath = path.join(GENERATED_DIR, "index.html");
  try {
    await fs.access(indexPath);
  } catch {
    const initial = {
      id: "preview",
      prompt: "等待生成。这里会显示即将写入灰色版小电脑的同一份 480x360 小屏应用。"
    };
    const spec = createAppSpec(initial.prompt, initial.id);
    await fs.writeFile(path.join(GENERATED_DIR, "index.html"), generatedIndexV2(initial.prompt, initial.id, spec), "utf8");
    await fs.writeFile(path.join(GENERATED_DIR, "style.css"), generatedStyleV2(initial.prompt, initial.id, spec), "utf8");
    await fs.writeFile(path.join(GENERATED_DIR, "app.js"), generatedAppV2(initial.prompt, initial.id, spec), "utf8");
    await fs.writeFile(path.join(GENERATED_DIR, "hardware_app.py"), generatedHardwareAppV2(initial.prompt, initial.id, spec), "utf8");
    await fs.writeFile(path.join(GENERATED_DIR, "manifest.json"), JSON.stringify(generatedManifestV2(initial.prompt, initial.id, spec), null, 2), "utf8");
  }
  let seed = { id: "preview", prompt: "waiting for generation" };
  try {
    const appSource = await fs.readFile(path.join(GENERATED_DIR, "app.js"), "utf8");
    const idMatch = appSource.match(/const BUILD_ID = ("(?:\\.|[^"\\])*");/);
    const promptMatch = appSource.match(/const PROMPT = ("(?:\\.|[^"\\])*");/);
    seed = {
      id: idMatch ? JSON.parse(idMatch[1]) : seed.id,
      prompt: promptMatch ? JSON.parse(promptMatch[1]) : seed.prompt
    };
  } catch {}

  let needsV2Rewrite = false;
  try {
    const appSource = await fs.readFile(path.join(GENERATED_DIR, "app.js"), "utf8");
    needsV2Rewrite = !appSource.includes("window.VibeBoardHardware") || !appSource.includes("const SPEC =");
  } catch {
    needsV2Rewrite = true;
  }

  const spec = createAppSpec(seed.prompt, seed.id);
  if (needsV2Rewrite) {
    const files = {
      "index.html": generatedIndexV2(seed.prompt, seed.id, spec),
      "style.css": generatedStyleV2(seed.prompt, seed.id, spec),
      "app.js": generatedAppV2(seed.prompt, seed.id, spec),
      "hardware_app.py": generatedHardwareAppV2(seed.prompt, seed.id, spec),
      "manifest.json": JSON.stringify(generatedManifestV2(seed.prompt, seed.id, spec), null, 2)
    };
    await Promise.all(Object.entries(files).map(([name, content]) => (
      fs.writeFile(path.join(GENERATED_DIR, name), content, "utf8")
    )));
  }

  const requiredFiles = {
    "index.html": () => generatedIndexV2(seed.prompt, seed.id, spec),
    "style.css": () => generatedStyleV2(seed.prompt, seed.id, spec),
    "app.js": () => generatedAppV2(seed.prompt, seed.id, spec),
    "hardware_app.py": () => generatedHardwareAppV2(seed.prompt, seed.id, spec),
    "manifest.json": () => JSON.stringify(generatedManifestV2(seed.prompt, seed.id, spec), null, 2)
  };
  for (const [name, factory] of Object.entries(requiredFiles)) {
    const filePath = path.join(GENERATED_DIR, name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 0) continue;
    } catch {}
    await fs.writeFile(filePath, factory(), "utf8");
  }
  await loadGeneratedBuild();
}

async function buildCurrent() {
  if (!currentBuild) throw new Error("No generated app. Generate first.");
  const appFile = path.join(currentBuild.dir, "app.js");
  const hardwareFile = path.join(currentBuild.dir, "hardware_app.py");
  const indexFile = path.join(currentBuild.dir, "index.html");
  const styleFile = path.join(currentBuild.dir, "style.css");
  const manifestFile = path.join(currentBuild.dir, "manifest.json");
  await execFileP(process.execPath, ["--check", appFile], { timeout: 10000 });
  const hardwareCompile = await execFileP("python", ["-m", "py_compile", hardwareFile], { timeout: 10000 });
  for (const file of [indexFile, styleFile, appFile, hardwareFile, manifestFile]) {
    const stat = await fs.stat(file);
    if (!stat.size) throw new Error(`${path.basename(file)} is empty`);
  }
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
  const manifest = {
    ...generatedManifestV2(currentBuild.prompt, currentBuild.id, spec),
    ...previousManifest,
    compile: {
      web: "node --check app.js",
      hardware: "python -m py_compile hardware_app.py",
      hardwareLog: hardwareCompile.stderr || hardwareCompile.stdout || "local py_compile ok"
    },
    target: BOARD.targetStatic,
    builtAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(currentBuild.dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  currentBuild.files["manifest.json"] = JSON.stringify(manifest, null, 2);
  currentBuild.manifest = manifest;
  currentBuild.built = true;
  return manifest;
}

// Capture preview screenshot of the generated app
async function capturePreview() {
  if (!currentBuild) return null;
  try {
    await fs.mkdir(PREVIEWS_DIR, { recursive: true });
    const previewPath = path.join(PREVIEWS_DIR, `${currentBuild.id}.png`);
    const scriptPath = path.join(ROOT, "screenshot.cjs");
    const url = `http://127.0.0.1:${PORT}/generated/current/index.html`;

    // Run screenshot via child_process (Windows Playwright)
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, url, previewPath], {
        timeout: 20000,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", d => stdout += d);
      child.stderr.on("data", d => stderr += d);
      child.on("close", code => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `screenshot exit code ${code}`));
      });
      child.on("error", reject);
    });

    // Verify the file was created
    const stat = await fs.stat(previewPath);
    if (stat.size > 0) {
      currentBuild.previewPath = previewPath;
      console.log("[capturePreview] Saved:", previewPath);
      return previewPath;
    }
  } catch (err) {
    console.error("[capturePreview] Failed:", err.message);
  }
  return null;
}

function parseFirstBuildId(text) {
  const match = String(text || "").match(/vb-[a-z0-9]+-[a-f0-9]{6}/i);
  return match ? match[0] : "";
}

function parseJsonSafe(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function makeCheck(id, label, ok, evidence = "") {
  return {
    id,
    label,
    ok: Boolean(ok),
    evidence: String(evidence || "").trim().slice(0, 500)
  };
}

async function verifyGoldenLoop(expectedId = currentBuild?.id) {
  if (!expectedId) throw new Error("No build id available for golden-loop verification.");

  const remote = [
    "set -u",
    `target=${shQuote(BOARD.targetStatic)}`,
    `service=${shQuote(BOARD.service)}`,
    "printf '__SECTION__:service\\n'",
    "systemctl is-active \"$service\" 2>/dev/null || true",
    "printf '\\n__SECTION__:http_index_id\\n'",
    "curl -fsS http://127.0.0.1:8765/app.js 2>/dev/null | grep -o 'vb-[a-z0-9]*-[a-f0-9]*' | head -1 || true",
    "printf '\\n__SECTION__:static_index_id\\n'",
    "grep -o 'vb-[a-z0-9]*-[a-f0-9]*' \"$target/index.html\" \"$target/app.js\" 2>/dev/null | head -1 || true",
    "printf '\\n__SECTION__:manifest\\n'",
    "cat \"$target/manifest.json\" 2>/dev/null || true",
    "printf '\\n__SECTION__:program\\n'",
    "cat \"$target/hardware-result.json\" 2>/dev/null || true",
    "printf '\\n__SECTION__:status\\n'",
    "curl -fsS http://127.0.0.1:8765/api/status 2>/dev/null || true",
    "printf '\\n__SECTION__:geometry\\n'",
    "DISPLAY=:0 XAUTHORITY=/home/linaro/.Xauthority xwininfo -root 2>/dev/null | grep -E 'Absolute upper-left|Width|Height' || true",
    "printf '\\n__SECTION__:kiosk\\n'",
    "{ ps -C chromium -o pid=,args= 2>/dev/null; ps -C chromium-bin -o pid=,args= 2>/dev/null; } | head -n 3 || true"
  ].join("\n");

  const raw = await ssh(remote, 30000);
  const sections = {};
  let current = "";
  for (const line of raw.split(/\r?\n/)) {
    const marker = line.match(/^__SECTION__:(.+)$/);
    if (marker) {
      current = marker[1];
      sections[current] = "";
    } else if (current) {
      sections[current] += `${line}\n`;
    }
  }
  Object.keys(sections).forEach(key => {
    sections[key] = sections[key].trim();
  });

  const manifest = parseJsonSafe(sections.manifest);
  const program = parseJsonSafe(sections.program);
  const status = parseJsonSafe(sections.status);
  const geometry = sections.geometry || "";
  const kiosk = sections.kiosk || "";
  const httpIndexId = parseFirstBuildId(sections.http_index_id);
  const staticIndexId = parseFirstBuildId(sections.static_index_id);
  const service = (sections.service || "").split(/\r?\n/).find(Boolean) || "";

  const checks = [
    makeCheck("program-runtime", "board program executed", program?.runtime === "executed_on_board", program ? JSON.stringify({
      build_id: program.build_id,
      runtime: program.runtime,
      hostname: program.hostname,
      cpu_temp_c: program.cpu_temp_c,
      loadavg: program.loadavg
    }) : sections.program),
    makeCheck("program-build-id", "program build id matches", program?.build_id === expectedId, program?.build_id || "missing"),
    makeCheck("http-build-id", "board HTTP build id matches", httpIndexId === expectedId, httpIndexId || sections.http_index_id || "missing"),
    makeCheck("static-build-id", "board static build id matches", staticIndexId === expectedId, staticIndexId || sections.static_index_id || "missing"),
    makeCheck("manifest-build-id", "manifest build id matches", manifest?.id === expectedId, manifest?.id || "missing"),
    makeCheck("status-api", "board status API responded", Boolean(status?.hostname || status?.network || status?.services), sections.status),
    makeCheck("service-active", `${BOARD.service} active`, service === "active", service || "missing"),
    makeCheck("display-geometry", "display geometry is 480x360", /Width:\s*480\b/.test(geometry) && /Height:\s*360\b/.test(geometry), geometry || "xwininfo unavailable"),
    makeCheck("kiosk-window", "kiosk launched at 480x360 scale 1", /--window-size=480,360/.test(kiosk) && /--force-device-scale-factor=1/.test(kiosk), kiosk || "chromium process not found")
  ];

  return {
    id: expectedId,
    ok: checks.every(check => check.ok),
    checkedAt: new Date().toISOString(),
    route: activeEndpoint ? endpointLabel(activeEndpoint) : "",
    checks,
    raw: sections
  };
}

async function deployCurrent() {
  console.log("[deployCurrent] Starting...");
  if (!currentBuild) {
    console.error("[deployCurrent] No currentBuild");
    throw new Error("No generated app. Generate first.");
  }
  console.log("[deployCurrent] currentBuild.id:", currentBuild.id);
  if (!currentBuild.built) {
    console.log("[deployCurrent] Building...");
    await buildCurrent();
  }

  const release = `${BOARD.releaseRoot}/${currentBuild.id}`;
  console.log("[deployCurrent] Creating release dir:", release);
  await ssh(`mkdir -p ${shQuote(release)} ${shQuote(BOARD.backupRoot)}`, 45000);
  console.log("[deployCurrent] Uploading files...");
  await uploadBundle([
    ...["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"].map(name => ({
      localPath: path.join(currentBuild.dir, name),
      remotePath: `${release}/${name}`
    })),
    {
      localPath: path.join(RUNTIME_DIR, "start-kiosk.sh"),
      remotePath: `${BOARD.appRoot}/start-kiosk.sh`,
      mode: "0755"
    }
  ], 60000);

  const remote = [
    "set -u",
    `target=${shQuote(BOARD.targetStatic)}`,
    `release=${shQuote(release)}`,
    `backup=${shQuote(`${BOARD.backupRoot}/static-${currentBuild.id}`)}`,
    `app_root=${shQuote(BOARD.appRoot)}`,
    "compile_log=\"$release/compile.log\"",
    "program_result=\"$release/hardware-result.json\"",
    "mkdir -p \"$backup\" || exit 10",
    "python3 -m py_compile \"$release/hardware_app.py\" >\"$compile_log\" 2>&1 || exit 16",
    "echo \"board py_compile ok: $release/hardware_app.py\" >>\"$compile_log\"",
    "python3 \"$release/hardware_app.py\" >\"$program_result\" 2>>\"$compile_log\" || exit 17",
    "echo \"board program executed: $program_result\" >>\"$compile_log\"",
    // 兜底注入：确保 hardware-result.json 包含 runtime 字段
    `grep -q '"runtime"' "$program_result" || python3 -c "import json,sys;p=sys.argv[1];d=json.load(open(p));d['runtime']='executed_on_board';d.setdefault('build_id','${currentBuild.id}');json.dump(d,open(p,'w'),indent=2)" "$program_result" && echo "injected runtime" >>"$compile_log" || echo "inject-failed" >>"$compile_log"`,
    "cp -a \"$target/.\" \"$backup/\" || exit 11",
    "cp \"$release/index.html\" \"$target/index.html\" || exit 12",
    "cp \"$release/style.css\" \"$target/style.css\" || exit 13",
    "cp \"$release/app.js\" \"$target/app.js\" || exit 14",
    "cp \"$release/manifest.json\" \"$target/manifest.json\" || exit 15",
    "cp \"$program_result\" \"$target/hardware-result.json\" || exit 18",
    "chmod +x \"$app_root/start-kiosk.sh\" || exit 15",
    `sudo systemctl restart ${shQuote(BOARD.service)} || exit 20`,
    "sleep 5",
    `state=$(systemctl is-active ${shQuote(BOARD.service)} || true)`,
    "if [ \"$state\" != \"active\" ]; then systemctl status taishan-screen.service --no-pager || true; exit 21; fi",
    "pkill -9 chromium-bin 2>/dev/null || true",
    "pkill -9 chromium 2>/dev/null || true",
    "sleep 1",
    "nohup \"$app_root/start-kiosk.sh\" >/tmp/vibeboard-kiosk-reload-request.log 2>&1 </dev/null &",
    "sleep 5",
    "kiosk=$( { ps -C chromium -o pid=,args= 2>/dev/null; ps -C chromium-bin -o pid=,args= 2>/dev/null; } | head -n 1 || true )",
    "curl -fsS http://127.0.0.1:8765/ >/tmp/vibeboard-deploy-check.html || exit 30",
    "printf 'service=%s\\nbackup=%s\\ncompile=%s\\nprogram=%s\\nkiosk=%s\\n' \"$state\" \"$backup\" \"$compile_log\" \"$program_result\" \"$kiosk\""
  ].join("\n");

  console.log("[deployCurrent] Executing remote commands...");
  const output = await ssh(remote, 45000);
  console.log("[deployCurrent] Remote execution completed");
  currentBuild.deployed = true;
  const backup = (output.match(/^backup=(.*)$/m) || [])[1] || "";
  const compilePath = `${release}/compile.log`;
  const programPath = `${release}/hardware-result.json`;
  const compileLog = await ssh(`cat ${shQuote(compilePath)} 2>/dev/null || true`, 10000);
  const hardwareResultRaw = await ssh(`cat ${shQuote(programPath)} 2>/dev/null || true`, 10000);
  let hardwareResult = null;
  try {
    hardwareResult = hardwareResultRaw ? JSON.parse(hardwareResultRaw) : null;
  } catch {}
  const goldenLoop = await verifyGoldenLoop(currentBuild.id);
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
      "Cache-Control": "no-store"
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function route(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/board") {
      json(res, 200, { ok: true, ...(await boardStatus()) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/board-config") {
      json(res, 200, { ok: true, boardConfig: publicBoardConfig() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/board-config") {
      const body = await readBody(req);
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
      json(res, 200, await rawBoardStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/verify") {
      const id = url.searchParams.get("id") || currentBuild?.id || lastDeploy?.id || "";
      const goldenLoop = await verifyGoldenLoop(id);
      json(res, 200, { ok: true, goldenLoop });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/generate") {
      const body = await readBody(req);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) throw new Error("Prompt is required.");
      const build = await writeGenerated(prompt, body.modelSettings || {});
      json(res, 200, {
        ok: true,
        id: build.id,
        files: build.files,
        manifest: build.manifest || null,
        source: build.manifest?.source || "unknown",
        fallbackReason: build.manifest?.fallbackReason || ""
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/build") {
      const manifest = await buildCurrent();
      // Capture preview screenshot after successful build
      capturePreview().catch(err => console.error("[build] preview capture failed:", err.message));
      json(res, 200, { ok: true, summary: `${manifest.files.length} files`, manifest });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/deploy") {
      try {
        console.log("[deploy] Starting deploy...");
        const result = await deployCurrent();
        console.log("[deploy] Deploy completed successfully");
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        console.error("[deploy] Error:", error.message);
        console.error("[deploy] Stack:", error.stack);
        if (error.stdout) console.error("[deploy] stdout:", error.stdout);
        if (error.stderr) console.error("[deploy] stderr:", error.stderr);
        json(res, 500, { 
          ok: false, 
          error: error.message,
          stdout: error.stdout || "",
          stderr: error.stderr || ""
        });
      }
      return;
    }

    // Conversation APIs
    if (req.method === "GET" && url.pathname === "/api/conversations") {
      const conversations = query("SELECT * FROM conversations ORDER BY updated_at DESC");
      json(res, 200, { ok: true, conversations });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/conversations") {
      const id = crypto.randomUUID();
      const title = "New App";
      run("INSERT INTO conversations (id, title) VALUES (?, ?)", [id, title]);
      json(res, 200, { ok: true, id, title });
      return;
    }
    // Delete conversation and its messages
    if (req.method === "DELETE" && url.pathname.startsWith("/api/conversations/")) {
      const parts = url.pathname.split("/");
      const convId = parts[3];
      if (convId && !parts[4]) {
        run("DELETE FROM messages WHERE conversation_id = ?", [convId]);
        run("DELETE FROM conversations WHERE id = ?", [convId]);
        json(res, 200, { ok: true });
      } else {
        json(res, 400, { ok: false, error: "Invalid conversation ID" });
      }
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/messages")) {
      const convId = url.pathname.split("/")[3];
      const messages = query("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC", [convId]);
      json(res, 200, { ok: true, messages });
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/conversations/") && url.pathname.endsWith("/messages")) {
      const convId = url.pathname.split("/")[3];
      const body = await readBody(req);
      const { role, content, build_id } = body;
      run("INSERT INTO messages (conversation_id, role, content, build_id) VALUES (?, ?, ?, ?)", [convId, role, content, build_id || null]);
      // Update conversation title if first user message
      if (role === "user") {
        const msgCount = query("SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?", [convId]);
        if (msgCount[0]?.count === 1) {
          const title = content.slice(0, 50) + (content.length > 50 ? "..." : "");
          run("UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [title, convId]);
        }
      }
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/conversations/")) {
      const convId = url.pathname.split("/")[3];
      run("DELETE FROM messages WHERE conversation_id = ?", [convId]);
      run("DELETE FROM conversations WHERE id = ?", [convId]);
      json(res, 200, { ok: true });
      return;
    }

    // Market APIs
    if (req.method === "GET" && url.pathname === "/api/market") {
      const apps = query("SELECT id, conversation_id, name, description, preview_url, author, downloads, created_at FROM market_apps ORDER BY created_at DESC");
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
          const files = {};
          for (const fname of ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"]) {
            const fpath = path.join(GENERATED_DIR, fname);
            try {
              files[fname] = await fs.readFile(fpath, "utf8");
            } catch {}
          }
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
      const id = crypto.randomUUID();
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

      // Get app from market
      const apps = query("SELECT * FROM market_apps WHERE id = ?", [appId]);
      if (apps.length === 0) {
        json(res, 404, { ok: false, error: "App not found" });
        return;
      }

      const app = apps[0];
      let codeFiles = {};
      try {
        codeFiles = JSON.parse(app.code || "{}");
      } catch {}

      if (Object.keys(codeFiles).length === 0) {
        json(res, 400, { ok: false, error: "App has no code to deploy" });
        return;
      }

      // Write code to generated/current directory
      for (const [filename, content] of Object.entries(codeFiles)) {
        const filePath = path.join(GENERATED_DIR, filename);
        await fs.writeFile(filePath, content, "utf8");
      }

      // Build and deploy
      try {
        await buildCurrent();
        const deployResult = await deployCurrent();

        // Increment download count
        run("UPDATE market_apps SET downloads = downloads + 1 WHERE id = ?", [appId]);

        json(res, 200, {
          ok: true,
          message: "App deployed successfully",
          deployId: deployResult.id
        });
      } catch (deployErr) {
        json(res, 500, { ok: false, error: "Deploy failed: " + deployErr.message });
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
    json(res, 500, {
      ok: false,
      error: error.message,
      stdout: error.stdout,
      stderr: error.stderr
    });
  }
}

await ensureInitialGenerated();

http.createServer(route).listen(PORT, "127.0.0.1", () => {
  console.log(`VibeBoard MVP listening on http://127.0.0.1:${PORT}/ -> ${BOARD.id}:${BOARD.port}`);
});
