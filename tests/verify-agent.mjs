import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import initSqlJs from "sql.js";
import {
  AGENT_WRITABLE_FILE_NAMES,
  CONVERSATION_SNAPSHOT_FILE_NAMES,
  HARDWARE_APP_CONTRACT,
  HARDWARE_RESULT_FILE,
  REQUIRED_RUNTIME_APIS,
  hardwareContractPromptText,
  validateFileContracts,
  validateHardwareResultContract,
} from "../src/contracts.mjs";
import {
  serializeFileMap,
} from "../src/assetContract.mjs";
import { failResult, okResult, mergeResults, SEVERITY } from "../src/toolResult.mjs";
import { createPlaybookStore, signatureFromIssues } from "../src/playbookStore.mjs";
import { createJobStore } from "../src/jobStore.mjs";
import { createJobRuntime } from "../src/jobRuntime.mjs";
import { classifyError } from "../src/errorClassifier.mjs";
import { createAppSpec, generatedManifestV2 } from "../src/generatedAppTemplate.mjs";
import {
  advancedTemplateFilesV2,
  generatedAppV2,
  generatedHardwareAppV2,
  generatedIndexV2,
  generatedStyleV2,
} from "../src/generatedAppTemplatesV2.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_BIN = process.env.VIBEBOARD_NODE || "node";
const PYTHON_BIN = process.env.VIBEBOARD_PYTHON || (process.platform === "win32" ? "python" : "python3");
const SQL = await initSqlJs();

const results = [];

function record(status, name, detail = "") {
  results.push({ status, name, detail });
  const suffix = detail ? ` - ${detail}` : "";
  console.log(`${status} ${name}${suffix}`);
}

async function test(name, fn) {
  try {
    const detail = await fn();
    record("PASS", name, detail);
  } catch (error) {
    record("FAIL", name, error?.stack || error?.message || String(error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function execFileP(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd || ROOT,
      timeout: options.timeout || 15000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
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

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function validGeneratedFiles() {
  const buildId = "vb-test-valid";
  return {
    "index.html": `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=480,height=360,initial-scale=1">
    <link rel="stylesheet" href="./style.css">
    <title>VibeBoard Test</title>
  </head>
  <body>
    <main id="screen"></main>
    <script src="./app.js"></script>
  </body>
</html>
`,
    "style.css": `html, body { width: 480px; height: 360px; overflow: hidden; margin: 0; }
#screen { width: 480px; height: 360px; overflow: hidden; background: #101820; color: #f7f7f2; }
`,
    "app.js": `const BUILD_ID = "${buildId}";
const PROMPT = "valid generated app smoke test";

window.VibeBoardHardware = {
  async getStatus() {
    const response = await fetch("/api/status");
    return response.json();
  },
  async getProgramResult() {
    const response = await fetch("./hardware-result.json");
    return response.json();
  },
  getSnapshot() {
    return { build_id: BUILD_ID, prompt: PROMPT };
  }
};

document.addEventListener("DOMContentLoaded", async () => {
  const screen = document.getElementById("screen");
  const status = await window.VibeBoardHardware.getStatus().catch(() => ({ ok: false }));
  const program = await window.VibeBoardHardware.getProgramResult().catch(() => ({ ok: false }));
  screen.textContent = JSON.stringify({ status, program });
});
`,
    "hardware_app.py": `import json

BUILD_ID = "${buildId}"
PROMPT = "valid generated app smoke test"
available_apis = ["/api/status", "./hardware-result.json"]

payload = {
    "build_id": BUILD_ID,
    "prompt": PROMPT,
    "available_apis": available_apis,
    "runtime": {"mode": "test", "executed_on_board": False},
}

with open("hardware-result.json", "w", encoding="utf-8") as handle:
    handle.write(json.dumps(payload, ensure_ascii=False))

print(json.dumps(payload))
`,
    "manifest.json": JSON.stringify({
      id: buildId,
      name: "VibeBoard Test",
      files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"],
    }, null, 2),
  };
}

function generatedFilesForBuildId(buildId) {
  const files = validGeneratedFiles();
  for (const name of ["app.js", "hardware_app.py", "manifest.json"]) {
    files[name] = String(files[name]).replaceAll("vb-test-valid", buildId);
  }
  return files;
}

function templateFilesForPrompt(prompt, id = "vb-template-test") {
  const spec = createAppSpec(prompt, id);
  const specialized = advancedTemplateFilesV2(prompt, id, spec);
  return specialized || {
    "index.html": generatedIndexV2(prompt, id, spec),
    "style.css": generatedStyleV2(prompt, id, spec),
    "app.js": generatedAppV2(prompt, id, spec),
    "hardware_app.py": generatedHardwareAppV2(prompt, id, spec),
    "manifest.json": JSON.stringify(generatedManifestV2(prompt, id, spec), null, 2),
  };
}

await test("template routes paid fishing salary calculators away from hardware control", () => {
  const prompt = [
    "做一个带薪摸鱼计算器",
    "点击开始就计算薪资，点击暂停停止",
    "我的时薪是150",
    "要有一个大按钮",
  ].join("，");
  const spec = createAppSpec(prompt, "vb-wage-template");
  assert(spec.mode === "wage", `expected wage mode, got ${spec.mode}`);
  const files = templateFilesForPrompt(prompt, "vb-wage-template");
  const joined = Object.values(files).join("\n");
  assert(joined.includes("带薪摸鱼计算器"), "wage template should keep the calculator title");
  assert(joined.includes("150元/小时"), "wage template should display the hourly wage");
  assert(joined.includes("开始摸鱼"), "wage template should include a start button label");
  assert(joined.includes("暂停摸鱼"), "wage template should include a pause button label");
  assert(/setInterval|requestAnimationFrame/.test(files["app.js"]), "wage template should update live over time");
  assert(/HOURLY_RATE\s*\/\s*3600/.test(files["app.js"]), "wage template should calculate salary per second from the hourly rate");
  assert(!/Relay Command|Hardware Control|Toggle A|GPIO/.test(joined), "wage template must not fall back to the hardware control panel");

  const englishSpec = createAppSpec("salary timer with start button, hourly wage 150 RMB/hour", "vb-wage-english");
  assert(englishSpec.mode === "wage", `expected English salary timer prompt to stay wage mode, got ${englishSpec.mode}`);

  const salaryTimerSpec = createAppSpec("salary timer, hourly wage 150 RMB/hour", "vb-wage-timer");
  assert(salaryTimerSpec.mode === "wage", `expected salary timer prompt to stay wage mode, got ${salaryTimerSpec.mode}`);
});

function makeZip(entries = []) {
  const chunks = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content || ""), "utf8");
    const method = entry.method ?? 8;
    const data = method === 0 ? raw : zlib.deflateRawSync(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, name, data);
  }
  return Buffer.concat(chunks);
}

function makeTar(entries = []) {
  const chunks = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content || ""), "utf8");
    const header = Buffer.alloc(512, 0);
    name.copy(header, 0, 0, Math.min(name.length, 100));
    header.write("0000777\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(raw.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    const padding = Buffer.alloc((512 - (raw.length % 512)) % 512, 0);
    chunks.push(header, raw, padding);
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function makePngHeader(width = 480, height = 360) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, 4, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function makeWavHeader({ sampleRate = 16000, channels = 1, durationSec = 2 } = {}) {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const dataBytes = Math.round(byteRate * durationSec);
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, 4, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, 4, "ascii");
  buffer.write("fmt ", 12, 4, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(channels * bitsPerSample / 8, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, 4, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function makeDocx(text = "VibeBoard product brief") {
  return makeZip([
    { name: "[Content_Types].xml", content: "<?xml version=\"1.0\"?><Types></Types>" },
    { name: "word/document.xml", content: `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` },
  ]);
}

function makeXlsx(values = ["temperature", "battery", "status"]) {
  const shared = values.map((value) => `<si><t>${value}</t></si>`).join("");
  const cells = values.map((_, index) => `<c r="${String.fromCharCode(65 + index)}1" t="s"><v>${index}</v></c>`).join("");
  return makeZip([
    { name: "[Content_Types].xml", content: "<?xml version=\"1.0\"?><Types></Types>" },
    { name: "xl/sharedStrings.xml", content: `<?xml version="1.0"?><sst>${shared}</sst>` },
    { name: "xl/worksheets/sheet1.xml", content: `<?xml version="1.0"?><worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>` },
  ]);
}

function validGeneratedFilesWithAsset() {
  const files = validGeneratedFiles();
  const manifest = JSON.parse(files["manifest.json"]);
  manifest.assets = ["assets/pet.json", "assets/sprite.webp"];
  manifest.files = [...manifest.files, ...manifest.assets];
  files["manifest.json"] = JSON.stringify(manifest, null, 2);
  files["app.js"] = files["app.js"].replace(
    "screen.textContent = JSON.stringify({ status, program });",
    "const pet = await fetch('./assets/pet.json').then(r => r.json()).catch(() => ({ mood: 'missing' }));\n  screen.textContent = JSON.stringify({ status, program, pet });",
  );
  files["assets/pet.json"] = JSON.stringify({ mood: "calm", frames: 8 });
  files["assets/sprite.webp"] = Buffer.from([82, 73, 70, 70, 26, 0, 0, 0, 87, 69, 66, 80]);
  return files;
}

function createMarketRows(initialRows = []) {
  const rows = initialRows.map(row => ({
    conversation_id: null,
    description: "",
    preview_url: "",
    author: "user",
    downloads: 0,
    created_at: "2026-06-22T00:00:00.000Z",
    ...row,
  }));

  return {
    rows,
    query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT id, conversation_id")) {
        return rows.map(({ id, conversation_id, name, description, preview_url, author, downloads, created_at }) => ({
          id,
          conversation_id,
          name,
          description,
          preview_url,
          author,
          downloads,
          created_at,
        }));
      }
      if (normalized.startsWith("SELECT * FROM market_apps WHERE id = ?")) {
        return rows.filter(row => row.id === params[0]).map(row => ({ ...row }));
      }
      throw new Error(`Unexpected market query: ${normalized}`);
    },
    run(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("INSERT INTO market_apps")) {
        const [id, conversation_id, name, description, code, preview_url, author] = params;
        rows.push({
          id,
          conversation_id,
          name,
          description,
          code,
          preview_url,
          author,
          downloads: 0,
          created_at: "2026-06-22T00:00:00.000Z",
        });
        return;
      }
      if (normalized.startsWith("UPDATE market_apps SET downloads")) {
        const row = rows.find(item => item.id === params[0]);
        if (row) row.downloads += 1;
        return;
      }
      throw new Error(`Unexpected market run: ${normalized}`);
    },
  };
}

async function writeFiles(dir, files) {
  for (const [filename, content] of Object.entries(files)) {
    const filePath = path.join(dir, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
}

async function importVerifyAllLocal() {
  const candidates = [
    path.join(ROOT, "src", "verifiers", "index.mjs"),
    path.join(ROOT, "src", "verifiers", "verifyAllLocal.mjs"),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      const mod = await import(pathToFileURL(candidate).href);
      const verifyAllLocal = mod.verifyAllLocal || mod.default;
      if (typeof verifyAllLocal === "function") {
        return { verifyAllLocal, path: path.relative(ROOT, candidate) };
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`Failed to load ${path.relative(ROOT, candidate)}: ${error.message}`);
    }
  }

  return null;
}

async function importVerifiers() {
  const candidate = path.join(ROOT, "src", "verifiers", "index.mjs");
  await fs.access(candidate);
  return import(pathToFileURL(candidate).href);
}

async function startStaticServer(rootDir, jsonRoutes = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const routeKey = url.pathname;
    if (Object.prototype.hasOwnProperty.call(jsonRoutes, routeKey)) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(jsonRoutes[routeKey]));
      return;
    }
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^\/+/, "");
    const target = path.resolve(rootDir, relative);
    const root = path.resolve(rootDir);
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const body = await fs.readFile(target);
      const contentType = target.endsWith(".js") ? "text/javascript; charset=utf-8" : target.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function createMemoryDb() {
  const rowsBySignature = new Map();

  return {
    exec(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("CREATE ") || normalized.startsWith("CREATE INDEX")) return [];

      if (normalized.includes("WHERE signature = ? LIMIT 1")) {
        const row = rowsBySignature.get(params[0]);
        return selectRows(row ? [row] : []);
      }

      if (normalized.includes("FROM playbooks") && normalized.includes("WHERE score >= ?")) {
        const [minScore, taskType] = params;
        const rows = [...rowsBySignature.values()]
          .filter(row => row.score >= minScore && (row.task_type === taskType || row.task_type === "general"))
          .sort((left, right) => right.score - left.score || String(right.updated_at).localeCompare(String(left.updated_at)));
        return selectRows(rows);
      }

      return [];
    },
    run(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      const now = new Date().toISOString();

      if (normalized.startsWith("INSERT INTO playbooks")) {
        const [
          signature,
          taskType,
          title,
          rootCause,
          diagnosisSteps,
          fix,
          verificationEvidence,
          tags,
          score,
        ] = params;
        rowsBySignature.set(signature, {
          id: rowsBySignature.size + 1,
          signature,
          task_type: taskType,
          title,
          root_cause: rootCause,
          diagnosis_steps: diagnosisSteps,
          fix,
          verification_evidence: verificationEvidence,
          tags,
          score,
          usage_count: 0,
          success_count: 0,
          failure_count: 0,
          created_at: now,
          updated_at: now,
          last_used_at: null,
        });
        return;
      }

      if (normalized.startsWith("UPDATE playbooks") && normalized.includes("usage_count = usage_count + 1")) {
        const [successDelta, failureDelta, verificationEvidence, score, signature] = params;
        const row = rowsBySignature.get(signature);
        if (!row) return;
        row.usage_count += 1;
        row.success_count += successDelta;
        row.failure_count += failureDelta;
        row.verification_evidence = verificationEvidence;
        row.score = score;
        row.updated_at = now;
        row.last_used_at = now;
        return;
      }

      if (normalized.startsWith("UPDATE playbooks")) {
        const [
          taskType,
          titleForCheck,
          title,
          rootCauseForCheck,
          rootCause,
          diagnosisSteps,
          fixForCheck,
          fix,
          verificationEvidence,
          tags,
          score,
          signature,
        ] = params;
        const row = rowsBySignature.get(signature);
        if (!row) return;
        if (row.task_type === "general") row.task_type = taskType;
        if (titleForCheck !== "") row.title = title;
        if (rootCauseForCheck !== "") row.root_cause = rootCause;
        row.diagnosis_steps = diagnosisSteps;
        if (fixForCheck !== "") row.fix = fix;
        row.verification_evidence = verificationEvidence;
        row.tags = tags;
        row.score = score;
        row.updated_at = now;
      }
    },
  };
}

function createSqlMemoryDb() {
  return new SQL.Database();
}

function selectRows(rows) {
  const columns = [
    "id",
    "signature",
    "task_type",
    "title",
    "root_cause",
    "diagnosis_steps",
    "fix",
    "verification_evidence",
    "tags",
    "score",
    "usage_count",
    "success_count",
    "failure_count",
    "created_at",
    "updated_at",
    "last_used_at",
  ];
  return [{
    columns,
    values: rows.map(row => columns.map(column => row[column])),
  }];
}

async function withMockChatServer(responses, fn) {
  let index = 0;
  const requestBodies = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      requestBodies.push(JSON.parse(body || "{}"));
    } catch {
      requestBodies.push({});
    }

    const message = responses[Math.min(index, responses.length - 1)];
    index += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    return await fn({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      calls: () => index,
      requestBodies: () => requestBodies,
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function withMockPythonRunner(fn) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/python/execute") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    requests.push(body);

    if (body.mode === "compile") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        mode: "compile",
        stdout: "",
        stderr: "",
        exitCode: 0,
        files: {},
      }));
      return;
    }

    const hardwareResult = {
      build_id: extractMockRunnerBuildId(body),
      prompt: "runner executed",
      runtime: { mode: "python_runner", executed_on_board: false },
      available_apis: ["/api/status", "./hardware-result.json"],
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      mode: "run",
      stdout: JSON.stringify(hardwareResult),
      stderr: "",
      exitCode: 0,
      files: {
        "hardware-result.json": JSON.stringify(hardwareResult),
      },
    }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    return await fn({
      url: `http://127.0.0.1:${server.address().port}`,
      requests: () => requests,
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function withMockRenderRunner(fn, { response } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/render/verify") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    const payload = response || {
      ok: true,
      phase: "render",
      summary: "Remote 480x360 HTTP render passed.",
      issues: [],
      degraded: false,
      evidence: {
        runner: "mock-render-runner",
        pageState: { viewportWidth: 480, viewportHeight: 360, scrollWidth: 480, scrollHeight: 360 },
        screenshot: { mimeType: "image/png", bytes: 8 },
      },
      data: {
        screenshot: {
          encoding: "base64",
          content: "iVBORw0K",
          mimeType: "image/png",
          bytes: 8,
        },
      },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    return await fn({
      url: `http://127.0.0.1:${server.address().port}`,
      requests: () => requests,
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function extractMockRunnerBuildId(body = {}) {
  const hardwareSource = mockRunnerFileText(body.files, "hardware_app.py");
  const matches = [
    hardwareSource.match(/\bBUILD_ID\s*=\s*["']([^"']+)["']/),
    hardwareSource.match(/["']build_id["']\s*:\s*["']([^"']+)["']/),
    hardwareSource.match(/expectedBuildId\s*=\s*["']([^"']+)["']/),
  ];
  return matches.find(match => match)?.[1] || "vb-runner-test";
}

function mockRunnerFileText(files = {}, name) {
  const value = files?.[name];
  if (typeof value === "string") return value;
  if (value?.encoding === "base64" && value?.data) {
    return Buffer.from(String(value.data), "base64").toString("utf8");
  }
  return "";
}

function createFileToolCall(id, pathName, content) {
  return {
    id,
    type: "function",
    function: {
      name: "create_file",
      arguments: JSON.stringify({ path: pathName, content }),
    },
  };
}

async function runVerifyAllLocal(verifyAllLocal, dir, files) {
  const attempts = [
    () => verifyAllLocal({ dir, files, root: ROOT }),
    () => verifyAllLocal(dir, { files, root: ROOT }),
    () => verifyAllLocal(files, { dir, root: ROOT }),
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("verifyAllLocal returned undefined.");
}

await test("contracts reject missing required hardware/frontend hooks", () => {
  const issues = validateFileContracts({
    "index.html": "<script src=\"app.js\"></script>",
    "app.js": "console.log('missing hooks');",
    "hardware_app.py": "print('missing json contract')",
  }, "Broken app");

  assert(issues.length >= 5, `expected multiple contract issues, got ${issues.length}`);
  assert(issues.some(issue => issue.code === "APP_BUILD_ID"), "expected APP_BUILD_ID issue");
  assert(issues.some(issue => issue.code === "INDEX_RELATIVE_ASSETS"), "expected INDEX_RELATIVE_ASSETS issue");
  assert(issues.some(issue => issue.code === "HW_JSON_STDOUT"), "expected HW_JSON_STDOUT issue");
  return `${issues.length} issues detected`;
});

await test("hardware app contract centralizes embedded rules", () => {
  assert(HARDWARE_APP_CONTRACT.screen.width === 480, "screen width should be fixed at 480");
  assert(HARDWARE_APP_CONTRACT.screen.height === 360, "screen height should be fixed at 360");
  assert(HARDWARE_APP_CONTRACT.hardware.touch === false, "hardware should be no-touch");
  assert(REQUIRED_RUNTIME_APIS.includes("/api/status"), "runtime APIs should include /api/status");
  assert(REQUIRED_RUNTIME_APIS.includes(`./${HARDWARE_RESULT_FILE}`), "runtime APIs should include hardware-result.json");
  assert(AGENT_WRITABLE_FILE_NAMES.includes("hardware_app.py"), "agent writable files should include hardware_app.py");
  assert(!AGENT_WRITABLE_FILE_NAMES.includes("_run.sh"), "agent writable files should reject helper scripts");
  assert(CONVERSATION_SNAPSHOT_FILE_NAMES.includes(HARDWARE_RESULT_FILE), "conversation snapshots should keep hardware result");
  const prompt = hardwareContractPromptText("en");
  assert(prompt.includes("480x360"), "prompt contract should include screen size");
  assert(prompt.includes("Runtime data"), "prompt contract should include runtime data rules");
});

await test("Taishan board profiles use the deployable linaro account", async () => {
  const { createBoardConfig } = await import(pathToFileURL(path.join(ROOT, "src", "devices.mjs")).href);
  const transparent = createBoardConfig("taishan-transparent", {});
  const gray = createBoardConfig("taishan-gray", {});
  const black = createBoardConfig("taishan-black", {});
  assert(transparent.user === "linaro", `transparent board should default to linaro, got ${transparent.user}`);
  assert(gray.user === "linaro", `gray board should default to linaro, got ${gray.user}`);
  assert(black.user === "linaro", `black board should default to linaro, got ${black.user}`);
  assert(transparent.port === "6223", `transparent board should keep FRP port 6223, got ${transparent.port}`);
  assert(gray.port === "6278", `gray board should keep FRP port 6278, got ${gray.port}`);
  assert(black.port === "6279", `black board should keep FRP port 6279, got ${black.port}`);
});

await test("hardware result contract rejects missing runtime APIs", () => {
  const issues = validateHardwareResultContract({
    build_id: "vb-test-contract",
    runtime: "executed_on_board",
    available_apis: ["/api/status"],
  }, {
    expectedBuildId: "vb-test-contract",
  });
  assert(issues.some(issue => issue.code === "HARDWARE_RESULT_API_MISSING"), "expected missing hardware-result API issue");
});

await test("toolResult keeps blocking failures non-ok", () => {
  const good = okResult("contract", "contract ok");
  const bad = failResult("syntax", "bad js", [{ code: "BAD_JS", message: "Invalid JavaScript" }]);
  const merged = mergeResults("local", "combined", [good, bad]);

  assert(good.ok === true, "okResult should be ok");
  assert(bad.ok === false, "failResult should not be ok");
  assert(bad.issues[0].severity === SEVERITY.BLOCKING, "failResult issue should be blocking");
  assert(merged.ok === false, "merged result should fail when a blocking issue exists");
});

await test("error classifier returns actionable generation failure details", async () => {
  const { classifyError, createStructuredError } = await import(pathToFileURL(path.join(ROOT, "src", "errorClassifier.mjs")).href);
  const auth = classifyError(new Error("LLM_CALL_FAILED: HTTP 401; provider=invalid api key"));
  assert(auth.errorType === "llm_auth", `expected llm_auth, got ${JSON.stringify(auth)}`);
  assert(auth.userMessage.includes("API Key"), "auth error should explain API key");
  assert(auth.suggestion && auth.nextActions.length, "auth error should include suggestions");

  const render = classifyError(new Error("480x360 HTTP render failed. LAYOUT_OVERFLOW"));
  assert(render.errorType === "render_failed", `expected render_failed, got ${JSON.stringify(render)}`);
  assert(render.errorStage === "local_verify", "render error should point to local verification");
  const contrast = classifyError(new Error("local verification failed: TEXT_CONTRAST_LOW: Rendered page has low contrast text."));
  assert(contrast.errorType === "render_failed", `expected contrast error to be render_failed, got ${JSON.stringify(contrast)}`);
  const missingPython = classifyError(new Error("spawn python3 ENOENT while running py_compile for hardware_app.py"));
  assert(missingPython.errorType === "python_runtime_unavailable", `expected python_runtime_unavailable, got ${JSON.stringify(missingPython)}`);

  const busy = classifyError(createStructuredError("Another generation is already running.", "generate_busy"));
  assert(busy.statusCode === 409, "busy generation should be an HTTP 409 conflict");
  assert(busy.retryable === true, "busy generation should be retryable after the active task finishes");
});

await test("bad JavaScript is rejected by node --check", async () => {
  await withTempDir("vibeboard-bad-js-", async dir => {
    const badJs = path.join(dir, "app.js");
    await fs.writeFile(badJs, "const broken = ;\n", "utf8");
    let failed = false;
    try {
      await execFileP(NODE_BIN, ["--check", badJs]);
    } catch (error) {
      failed = true;
    }
    assert(failed, "node --check unexpectedly accepted bad JavaScript");
  });
});

await test("bad Python is rejected by py_compile", async () => {
  await withTempDir("vibeboard-bad-py-", async dir => {
    const badPy = path.join(dir, "hardware_app.py");
    await fs.writeFile(badPy, "def broken(:\n    pass\n", "utf8");
    let failed = false;
    try {
      await execFileP(PYTHON_BIN, ["-m", "py_compile", badPy]);
    } catch (error) {
      failed = true;
    }
    assert(failed, "py_compile unexpectedly accepted bad Python");
  });
});

await test("valid generated fixture satisfies contracts", () => {
  const files = validGeneratedFiles();
  const issues = validateFileContracts(files, "Valid app");
  assert(issues.length === 0, `expected no contract issues, got ${JSON.stringify(issues)}`);
});

await test("declared passive assets satisfy generated app contracts", () => {
  const files = validGeneratedFilesWithAsset();
  const issues = validateFileContracts(files, "Asset app");
  assert(issues.length === 0, `expected declared assets to pass, got ${JSON.stringify(issues)}`);
});

await test("asset contracts reject active files and undeclared references", () => {
  const files = validGeneratedFiles();
  const manifest = JSON.parse(files["manifest.json"]);
  manifest.assets = ["assets/skin.html", "../escape.png", "assets/good.png"];
  files["manifest.json"] = JSON.stringify(manifest, null, 2);
  files["app.js"] += "\nfetch('./assets/missing.json');\n";
  files["assets/good.png"] = Buffer.from([1, 2, 3]);
  files["assets/logic.js"] = "console.log('active')";

  const issues = validateFileContracts(files, "Unsafe asset app");
  assert(issues.some(issue => issue.code === "ASSET_PATH_INVALID"), `expected invalid manifest asset issue, got ${JSON.stringify(issues)}`);
  assert(issues.some(issue => issue.code === "ASSET_REFERENCE_UNDECLARED"), `expected undeclared reference issue, got ${JSON.stringify(issues)}`);
  assert(issues.some(issue => issue.code === "UNSUPPORTED_FILE" && issue.evidence?.fileName === "assets/logic.js"), `expected active asset file rejection, got ${JSON.stringify(issues)}`);
});

await test("valid generated fixture runs local syntax checks", async () => {
  await withTempDir("vibeboard-valid-", async dir => {
    const files = validGeneratedFilesWithAsset();
    await writeFiles(dir, files);
    await execFileP(NODE_BIN, ["--check", path.join(dir, "app.js")]);
    await execFileP(PYTHON_BIN, ["-m", "py_compile", path.join(dir, "hardware_app.py")]);
  });
});

await test("generated workspace read/write preserves declared binary assets", async () => {
  const { writeGeneratedFiles, readGeneratedFiles } = await import(pathToFileURL(path.join(ROOT, "src", "buildArtifact.mjs")).href);
  await withTempDir("vibeboard-assets-rw-", async dir => {
    const files = validGeneratedFilesWithAsset();
    await fs.mkdir(path.join(dir, "assets"), { recursive: true });
    await fs.writeFile(path.join(dir, "assets", "stale.webp"), Buffer.from([9, 9, 9]));

    await writeGeneratedFiles(dir, files);
    const loaded = await readGeneratedFiles(dir, HARDWARE_APP_CONTRACT.generatedFiles);
    const staleExists = await fs.stat(path.join(dir, "assets", "stale.webp")).then(() => true).catch(() => false);

    assert(Buffer.isBuffer(loaded["assets/pet.json"]), "declared JSON asset should be loaded through the binary asset path");
    assert(loaded["assets/pet.json"].toString("utf8") === files["assets/pet.json"], "declared JSON asset contents should round-trip");
    assert(Buffer.isBuffer(loaded["assets/sprite.webp"]), "binary asset should be loaded as Buffer");
    assert(loaded["assets/sprite.webp"].equals(files["assets/sprite.webp"]), "binary asset contents should round-trip");
    assert(staleExists === false, "writing a new generated workspace should clear stale assets");
  });
});

await test("build intelligence summary translates verification into hardware fit", async () => {
  const { createBuildIntelligenceSummary } = await import(pathToFileURL(path.join(ROOT, "src", "buildIntelligence.mjs")).href);
  const summary = createBuildIntelligenceSummary({
    build: { id: "vb-test-valid" },
    manifest: { id: "vb-test-valid" },
    verification: {
      ok: true,
      summary: "L0-L3 local verification passed",
      issues: [],
      evidence: {
        nodeCheck: "passed",
        pythonCompile: "passed",
        hardwareRun: "passed",
      },
    },
    hardwareResult: {
      build_id: "vb-test-valid",
      runtime: "executed_on_board",
      available_apis: ["/api/status", "./hardware-result.json"],
    },
    board: { label: "Taishan Gray", targetStatic: "/tmp/vibeboard-static" },
    pythonBin: PYTHON_BIN,
  });

  assert(summary.confidence === "local_verified", `expected local_verified, got ${JSON.stringify(summary)}`);
  assert(summary.deviceFit.includes("480x360"), "summary should describe screen fit");
  assert(summary.deviceFit.includes("KEY1"), "summary should describe physical keys");
  assert(summary.hardwareChecks.every(check => check.status === "passed"), `expected passed checks, got ${JSON.stringify(summary.hardwareChecks)}`);
  assert(summary.nextBestAction === "deploy_to_board", "verified build should recommend deploy_to_board");
  assert(summary.userMoment.includes("hardware script ran"), "summary should include a user-readable hardware moment");
});

await test("preview runtime reuses an existing build screenshot", async () => {
  const { createPreviewRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "previewRuntime.mjs")).href);
  await withTempDir("vibeboard-preview-runtime-", async dir => {
    const previewsDir = path.join(dir, "previews");
    await fs.mkdir(previewsDir, { recursive: true });
    const build = { id: "vb-preview-existing" };
    const previewPath = path.join(previewsDir, `${build.id}.png`);
    await fs.writeFile(previewPath, Buffer.alloc(32, 1));
    let spawnCalled = false;
    const runtime = createPreviewRuntime({
      rootDir: dir,
      previewsDir,
      port: 8789,
      nodeBin: NODE_BIN,
      spawnProcess: () => {
        spawnCalled = true;
        throw new Error("spawn should not be called for existing previews");
      },
    });

    const result = await runtime.ensureBuildPreview(build);
    assert(result.ok === true, `existing preview should be ok: ${JSON.stringify(result)}`);
    assert(result.existing === true, "existing preview should be marked as reused");
    assert(result.previewUrl === `/api/previews/${build.id}.png`, "existing preview should return market preview URL");
    assert(build.previewPath === previewPath, "build should receive previewPath");
    assert(spawnCalled === false, "existing preview should avoid screenshot process");
  });
});

await test("market runtime publishes current build with a persisted preview URL", async () => {
  const { createMarketRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "marketRuntime.mjs")).href);
  const files = validGeneratedFiles();
  const marketRows = createMarketRows();
  let captureCalled = false;
  const runtime = createMarketRuntime({
    generatedFileNames: HARDWARE_APP_CONTRACT.generatedFiles,
    query: marketRows.query,
    run: marketRows.run,
    loadStaticMarketApps: async () => [{
      id: "static-demo",
      name: "Static Demo",
      description: "static app",
      preview_url: "/market-apps/static-demo.png",
      author: "VibeBoard",
      downloads: 0,
      created_at: "2026-06-22T00:00:00.000Z",
    }],
    readStaticMarketCode: async () => ({}),
    mergeMarketApps: (dbApps, staticApps) => [...dbApps, ...staticApps],
    readGeneratedFiles: async () => {
      throw new Error("publish should prefer current build files");
    },
    writeGeneratedFiles: async () => {
      throw new Error("publish should not write generated files");
    },
    generatedDir: "generated/current",
    getCurrentBuild: () => ({ id: "vb-market-publish", files }),
    capturePreview: async () => {
      captureCalled = true;
      return {
        ok: true,
        buildId: "vb-market-publish",
        previewUrl: "/api/previews/vb-market-publish.png",
      };
    },
    loadGeneratedBuild: async () => {
      throw new Error("publish should not reload generated build");
    },
    buildCurrent: async () => {
      throw new Error("publish should not build");
    },
    deployCurrent: async () => ({ id: "unused" }),
    withDeployLock: async fn => fn(),
    withDevice: async (_deviceId, fn) => fn(),
    deviceIdFrom: (_body, fallback) => fallback,
    getBoard: () => ({ id: "board-default" }),
    idFactory: () => "market-runtime-publish",
  });

  const published = await runtime.publishApp({
    conversation_id: "conv-market",
    name: "Market Runtime App",
    description: "Captures the current build preview.",
  });
  const listed = await runtime.listApps();
  const saved = marketRows.rows[0];
  const savedCode = JSON.parse(saved.code);

  assert(published.ok === true, `expected publish ok, got ${JSON.stringify(published)}`);
  assert(captureCalled === true, "publish should capture a preview for the current build");
  assert(published.preview_url === "/api/previews/vb-market-publish.png", "publish should return preview URL");
  assert(saved.preview_url === published.preview_url, "publish should persist preview URL in market app");
  assert(saved.conversation_id === "conv-market", "publish should persist source conversation");
  assert(savedCode["app.js"] === files["app.js"], "publish should snapshot current generated app files");
  assert(listed.apps.some(app => app.id === "market-runtime-publish" && app.source === "database"), "list should include database app source");
  assert(listed.apps.some(app => app.id === "static-demo"), "list should still include static market apps");
});

await test("market runtime snapshots and restores declared binary assets", async () => {
  const { createMarketRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "marketRuntime.mjs")).href);
  const files = validGeneratedFilesWithAsset();
  const marketRows = createMarketRows();
  let writtenFiles = null;
  const runtime = createMarketRuntime({
    generatedFileNames: HARDWARE_APP_CONTRACT.generatedFiles,
    query: marketRows.query,
    run: marketRows.run,
    loadStaticMarketApps: async () => [],
    readStaticMarketCode: async () => ({}),
    mergeMarketApps: (dbApps, staticApps) => [...dbApps, ...staticApps],
    readGeneratedFiles: async () => {
      throw new Error("publish should prefer current build files");
    },
    writeGeneratedFiles: async (_dir, nextFiles) => {
      writtenFiles = { ...nextFiles };
    },
    generatedDir: "generated/current",
    getCurrentBuild: () => ({ id: "vb-asset-publish", files }),
    capturePreview: async () => ({ ok: true, previewUrl: "/api/previews/vb-asset-publish.png" }),
    loadGeneratedBuild: async () => ({ id: "vb-asset-publish" }),
    buildCurrent: async () => {},
    deployCurrent: async () => ({ id: "deploy-asset-market" }),
    withDeployLock: async fn => fn(),
    withDevice: async (_deviceId, fn) => fn(),
    deviceIdFrom: (_body, fallback) => fallback,
    getBoard: () => ({ id: "board-default" }),
    idFactory: () => "market-runtime-asset",
    log: { log: () => {} },
  });

  await runtime.publishApp({ name: "Asset Market App" });
  const savedCode = JSON.parse(marketRows.rows[0].code);
  assert(savedCode["assets/sprite.webp"]?.__vibeboardFileEncoding === "base64", "published binary asset should be base64 encoded");

  const deployed = await runtime.deployApp("market-runtime-asset", {});
  assert(deployed.ok === true, `expected deploy ok, got ${JSON.stringify(deployed)}`);
  assert(Buffer.isBuffer(writtenFiles["assets/sprite.webp"]), "market deploy should restore binary assets as Buffer");
  assert(writtenFiles["assets/sprite.webp"].equals(files["assets/sprite.webp"]), "restored binary asset should match original");
  assert(writtenFiles["assets/pet.json"] === files["assets/pet.json"], "text asset should be restored unchanged");
});

await test("market runtime rejects publish when preview capture fails", async () => {
  const { createMarketRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "marketRuntime.mjs")).href);
  const marketRows = createMarketRows();
  const runtime = createMarketRuntime({
    generatedFileNames: HARDWARE_APP_CONTRACT.generatedFiles,
    query: marketRows.query,
    run: marketRows.run,
    loadStaticMarketApps: async () => [],
    readStaticMarketCode: async () => ({}),
    mergeMarketApps: (dbApps, staticApps) => [...dbApps, ...staticApps],
    readGeneratedFiles: async () => {
      throw new Error("publish should prefer current build files");
    },
    writeGeneratedFiles: async () => {
      throw new Error("publish failure should not write generated files");
    },
    generatedDir: "generated/current",
    getCurrentBuild: () => ({ id: "vb-preview-failure", files: validGeneratedFiles() }),
    capturePreview: async () => ({
      ok: false,
      buildId: "vb-preview-failure",
      error: "screenshot process failed",
      previewUrl: "",
    }),
    loadGeneratedBuild: async () => {
      throw new Error("publish failure should not reload generated build");
    },
    buildCurrent: async () => {
      throw new Error("publish failure should not build");
    },
    deployCurrent: async () => ({ id: "unused" }),
    withDeployLock: async fn => fn(),
    withDevice: async (_deviceId, fn) => fn(),
    deviceIdFrom: (_body, fallback) => fallback,
    getBoard: () => ({ id: "board-default" }),
    idFactory: () => "market-runtime-preview-failure",
  });

  let failed = null;
  try {
    await runtime.publishApp({ name: "No Screenshot App" });
  } catch (error) {
    failed = error;
  }

  assert(failed?.statusCode === 502, `preview capture failure should be a 502, got ${failed?.statusCode}`);
  assert(failed.previewReport?.error === "screenshot process failed", "preview failure should keep previewReport diagnostics");
  assert(marketRows.rows.length === 0, "publish should not persist an app without a preview URL");
});

await test("market runtime rejects publish without app name as bad input", async () => {
  const { createMarketRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "marketRuntime.mjs")).href);
  const marketRows = createMarketRows();
  const runtime = createMarketRuntime({
    generatedFileNames: HARDWARE_APP_CONTRACT.generatedFiles,
    query: marketRows.query,
    run: marketRows.run,
    loadStaticMarketApps: async () => [],
    readStaticMarketCode: async () => ({}),
    mergeMarketApps: (dbApps, staticApps) => [...dbApps, ...staticApps],
    readGeneratedFiles: async () => ({}),
    writeGeneratedFiles: async () => {},
    generatedDir: "generated/current",
    getCurrentBuild: () => ({ id: "vb-name-required", files: validGeneratedFiles() }),
    capturePreview: async () => {
      throw new Error("name validation should run before preview capture");
    },
    loadGeneratedBuild: async () => {},
    buildCurrent: async () => {},
    deployCurrent: async () => ({ id: "unused" }),
    withDeployLock: async fn => fn(),
    withDevice: async (_deviceId, fn) => fn(),
    deviceIdFrom: (_body, fallback) => fallback,
    getBoard: () => ({ id: "board-default" }),
  });

  let failed = null;
  try {
    await runtime.publishApp({ name: "   " });
  } catch (error) {
    failed = error;
  }

  assert(failed?.statusCode === 400, `missing app name should be a 400, got ${failed?.statusCode}`);
  assert(marketRows.rows.length === 0, "publish should not persist invalid input");
});

await test("market runtime deploys database app through build and deploy seams", async () => {
  const { createMarketRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "marketRuntime.mjs")).href);
  const codeFiles = {
    ...validGeneratedFilesWithAsset(),
    [HARDWARE_RESULT_FILE]: "{\"stale\":true}",
    "notes.txt": "not part of the hardware generated workspace",
  };
  const marketRows = createMarketRows([{
    id: "market-db-app",
    name: "Stored App",
    code: JSON.stringify(codeFiles),
  }]);
  const calls = [];
  let writtenFiles = null;
  const runtime = createMarketRuntime({
    generatedFileNames: HARDWARE_APP_CONTRACT.generatedFiles,
    query: marketRows.query,
    run: marketRows.run,
    loadStaticMarketApps: async () => [],
    readStaticMarketCode: async () => {
      throw new Error("database app deploy should not read static code");
    },
    mergeMarketApps: (dbApps, staticApps) => [...dbApps, ...staticApps],
    readGeneratedFiles: async () => ({}),
    writeGeneratedFiles: async (dir, files) => {
      calls.push(`write:${dir}`);
      writtenFiles = { ...files };
    },
    generatedDir: "generated/current",
    getCurrentBuild: () => null,
    capturePreview: async () => ({ ok: false }),
    loadGeneratedBuild: async () => {
      calls.push("load");
      return { id: "vb-test-valid" };
    },
    buildCurrent: async () => {
      calls.push("build");
    },
    deployCurrent: async () => {
      calls.push("deploy");
      return { id: "deploy-market-db" };
    },
    withDeployLock: async fn => {
      calls.push("lock");
      return fn();
    },
    withDevice: async (deviceId, fn) => {
      calls.push(`device:${deviceId}`);
      return fn();
    },
    deviceIdFrom: (body, fallback) => body.deviceId || fallback,
    getBoard: () => ({ id: "board-default" }),
    log: { log: () => {} },
  });

  const deployed = await runtime.deployApp("market-db-app", { deviceId: "board-b" });
  const actualFiles = Object.keys(writtenFiles || {}).sort().join(",");
  const expectedFiles = [...HARDWARE_APP_CONTRACT.generatedFiles, "assets/pet.json", "assets/sprite.webp"].sort().join(",");

  assert(deployed.ok === true, `expected deploy ok, got ${JSON.stringify(deployed)}`);
  assert(deployed.deviceId === "board-b", "deploy should preserve requested device id");
  assert(deployed.deployId === "deploy-market-db", "deploy should expose deploy result id");
  assert(actualFiles === expectedFiles, `market deploy should write only generated files and declared assets, got ${actualFiles}`);
  assert(!writtenFiles[HARDWARE_RESULT_FILE], "market deploy should not restore stale hardware-result.json");
  assert(!writtenFiles["notes.txt"], "market deploy should ignore non-contract files");
  assert(Buffer.isBuffer(writtenFiles["assets/sprite.webp"]), "market deploy should keep binary asset buffers");
  assert(marketRows.rows[0].downloads === 1, "database app deploy should increment downloads");
  assert(calls.join(">") === "lock>device:board-b>write:generated/current>load>build>deploy", `unexpected deploy order: ${calls.join(">")}`);
});

await test("market runtime preview creates an editable project from app code", async () => {
  const { createMarketRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "marketRuntime.mjs")).href);
  const codeFiles = {
    ...validGeneratedFilesWithAsset(),
    [HARDWARE_RESULT_FILE]: "{\"stale\":true}",
    "notes.txt": "not part of preview",
  };
  const marketRows = createMarketRows([{
    id: "market-preview-app",
    name: "Previewable App",
    code: JSON.stringify(codeFiles),
  }]);
  let previewProject = null;
  const runtime = createMarketRuntime({
    generatedFileNames: HARDWARE_APP_CONTRACT.generatedFiles,
    query: marketRows.query,
    run: marketRows.run,
    loadStaticMarketApps: async () => [],
    readStaticMarketCode: async () => {
      throw new Error("database preview should not read static code");
    },
    mergeMarketApps: (dbApps, staticApps) => [...dbApps, ...staticApps],
    readGeneratedFiles: async () => ({}),
    writeGeneratedFiles: async () => {
      throw new Error("preview should not overwrite the current generated workspace");
    },
    generatedDir: "generated/current",
    getCurrentBuild: () => null,
    capturePreview: async () => ({ ok: false }),
    loadGeneratedBuild: async () => ({ id: "unused" }),
    buildCurrent: async () => {},
    deployCurrent: async () => ({ id: "unused" }),
    withDeployLock: async fn => fn(),
    withDevice: async (_deviceId, fn) => fn(),
    deviceIdFrom: (_body, fallback) => fallback,
    getBoard: () => ({ id: "board-default" }),
    createPreviewProject: async payload => {
      previewProject = payload;
      return {
        conversation_id: "conv-market-preview",
        build_id: "market-preview-build",
        preview_url: "/api/conversations/conv-market-preview/preview/index.html?build=market-preview-build",
      };
    },
    log: { log: () => {} },
  });

  const preview = await runtime.previewApp("market-preview-app", {});
  const actualFiles = Object.keys(previewProject?.files || {}).sort().join(",");
  const expectedFiles = [...HARDWARE_APP_CONTRACT.generatedFiles, "assets/pet.json", "assets/sprite.webp"].sort().join(",");

  assert(preview.ok === true, `expected preview ok, got ${JSON.stringify(preview)}`);
  assert(preview.conversation_id === "conv-market-preview", "preview should expose the new conversation");
  assert(preview.title === "Previewable App", "preview should use the market app name as project title");
  assert(previewProject.title === "Previewable App", "preview project should receive market app title");
  assert(actualFiles === expectedFiles, `preview should keep only generated files and declared assets, got ${actualFiles}`);
  assert(!previewProject.files[HARDWARE_RESULT_FILE], "preview should not import stale hardware output");
  assert(Buffer.isBuffer(previewProject.files["assets/sprite.webp"]), "preview should preserve binary declared assets");
});

await test("market runtime deploys static fallback and reports missing apps", async () => {
  const { createMarketRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "marketRuntime.mjs")).href);
  const marketRows = createMarketRows();
  let staticCodeId = null;
  let writeCount = 0;
  const runtime = createMarketRuntime({
    generatedFileNames: HARDWARE_APP_CONTRACT.generatedFiles,
    query: marketRows.query,
    run: marketRows.run,
    loadStaticMarketApps: async () => [{ id: "static-market-app", name: "Static Market App" }],
    readStaticMarketCode: async appId => {
      staticCodeId = appId;
      return validGeneratedFiles();
    },
    mergeMarketApps: (dbApps, staticApps) => [...dbApps, ...staticApps],
    readGeneratedFiles: async () => ({}),
    writeGeneratedFiles: async () => {
      writeCount += 1;
    },
    generatedDir: "generated/current",
    getCurrentBuild: () => null,
    capturePreview: async () => ({ ok: false }),
    loadGeneratedBuild: async () => ({ id: "vb-test-valid" }),
    buildCurrent: async () => {},
    deployCurrent: async () => ({ id: "deploy-static-market" }),
    withDeployLock: async fn => fn(),
    withDevice: async (_deviceId, fn) => fn(),
    deviceIdFrom: (_body, fallback) => fallback,
    getBoard: () => ({ id: "board-default" }),
    log: { log: () => {} },
  });

  const deployed = await runtime.deployApp("static-market-app", {});
  let missing = null;
  try {
    await runtime.deployApp("missing-market-app", {});
  } catch (error) {
    missing = error;
  }

  assert(deployed.ok === true, `expected static deploy ok, got ${JSON.stringify(deployed)}`);
  assert(deployed.deployId === "deploy-static-market", "static deploy should expose deploy result id");
  assert(staticCodeId === "static-market-app", "static deploy should load static app code by id");
  assert(writeCount === 1, `only successful static deploy should write files, got ${writeCount}`);
  assert(marketRows.rows.length === 0, "static deploy should not create database rows");
  assert(missing?.statusCode === 404, "missing market app should report 404");
});

await test("static market catalog reads manifest-declared assets", async () => {
  const { readStaticMarketCode } = await import(pathToFileURL(path.join(ROOT, "src", "marketCatalog.mjs")).href);
  await withTempDir("vibeboard-static-market-assets-", async dir => {
    const appDir = path.join(dir, "asset-static-app");
    const files = validGeneratedFilesWithAsset();
    await writeFiles(appDir, files);

    const loaded = await readStaticMarketCode(dir, "asset-static-app", HARDWARE_APP_CONTRACT.generatedFiles);
    assert(loaded["app.js"] === files["app.js"], "static market reader should load generated app source");
    assert(Buffer.isBuffer(loaded["assets/pet.json"]), "static market reader should load declared JSON asset as Buffer");
    assert(loaded["assets/pet.json"].toString("utf8") === files["assets/pet.json"], "static market JSON asset should match source");
    assert(Buffer.isBuffer(loaded["assets/sprite.webp"]), "static market reader should load declared binary asset");
    assert(loaded["assets/sprite.webp"].equals(files["assets/sprite.webp"]), "static market binary asset should match source");
  });
});

await test("desk deployer uploads and copies declared assets", async () => {
  const {
    buildDeployRemoteCommand,
    buildDeployUploadEntries,
  } = await import(pathToFileURL(path.join(ROOT, "src", "deskDeployer.mjs")).href);
  const board = {
    releaseRoot: "/tmp/vibeboard/releases",
    backupRoot: "/tmp/vibeboard/backups",
    targetStatic: "/home/linaro/static",
    appRoot: "/home/linaro/app",
    service: "taishan-screen.service",
  };
  const build = {
    id: "vb-deploy-assets",
    dir: "/local/generated",
    files: validGeneratedFilesWithAsset(),
  };
  const entries = buildDeployUploadEntries({
    currentBuild: build,
    board,
    runtimeDir: "/local/runtime",
  });
  const remotePaths = entries.map(entry => entry.remotePath);
  const command = buildDeployRemoteCommand({ board, buildId: build.id });

  assert(remotePaths.includes("/tmp/vibeboard/releases/vb-deploy-assets/assets/pet.json"), `expected pet asset upload, got ${remotePaths.join(",")}`);
  assert(remotePaths.includes("/tmp/vibeboard/releases/vb-deploy-assets/assets/sprite.webp"), `expected sprite asset upload, got ${remotePaths.join(",")}`);
  assert(command.includes("rm -rf \"$target/assets\""), "deploy command should remove stale target assets");
  assert(command.includes("cp -a \"$release/assets/.\" \"$target/assets/\""), "deploy command should copy release assets to target");
});

await test("build runtime runs local hardware build and records evidence", async () => {
  const { createBuildRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "buildRuntime.mjs")).href);
  await withTempDir("vibeboard-build-runtime-", async dir => {
    const files = validGeneratedFilesWithAsset();
    const logs = [];
    await writeFiles(dir, files);
    const currentBuild = {
      id: "vb-test-valid",
      prompt: "valid generated app smoke test",
      files: { ...files },
      dir,
      built: false,
      deployed: false,
      manifest: JSON.parse(files["manifest.json"]),
      agentRun: { phase: "code", evidence: [], failures: [] },
    };
    const runtime = createBuildRuntime({
      appendServerLog: async (event, detail) => {
        logs.push({ event, detail });
      },
      execFileP,
      verifyAllLocal: async (verificationFiles, options) => {
        assert(options.dir === dir, "build runtime should verify the generated directory");
        assert(options.pythonBin === PYTHON_BIN, "build runtime should pass configured Python bin");
        assert(verificationFiles[HARDWARE_RESULT_FILE]?.includes('"build_id": "vb-test-valid"'), "verification should receive hardware result JSON");
        assert(Buffer.isBuffer(verificationFiles["assets/sprite.webp"]), "build runtime should pass declared binary assets to verification");
        return { ok: true, issues: [], evidence: { verifier: "stub" }, summary: "stub ok" };
      },
      createAppSpec: (prompt, id) => ({
        prompt,
        id,
        mode: "test",
        target: "480x360 RK3566 Linux kiosk",
        hardwareApi: REQUIRED_RUNTIME_APIS,
      }),
      generatedManifest: (prompt, id, spec) => ({
        id,
        prompt,
        target: spec.target,
        files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"],
      }),
      getCurrentBuild: () => currentBuild,
      getBoard: () => ({ targetStatic: "/tmp/vibeboard-static" }),
      pythonBin: PYTHON_BIN,
      nodeBin: NODE_BIN,
    });

    const manifest = await runtime.buildCurrent();
    const hardwareResult = JSON.parse(await fs.readFile(path.join(dir, HARDWARE_RESULT_FILE), "utf8"));

    assert(hardwareResult.build_id === "vb-test-valid", "build runtime should write matching hardware-result.json");
    assert(currentBuild.built === true, "build runtime should mark current build as built");
    assert(currentBuild.buildEvidence.phase === "local_verify", "build evidence should record local verification phase");
    assert(currentBuild.buildEvidence.summary === "L0-L3 local verification passed", "build evidence should preserve L0-L3 summary");
    assert(currentBuild.buildEvidence.evidence.hardwareResult.endsWith(`/${HARDWARE_RESULT_FILE}`), "build evidence should point at hardware result");
    assert(currentBuild.intelligenceSummary?.confidence === "local_verified", "build runtime should attach local verified intelligence summary");
    assert(currentBuild.intelligenceSummary?.hardwareChecks?.some(check => check.id === "build_id_match" && check.status === "passed"), "intelligence summary should prove build id match");
    assert(currentBuild.intelligenceSummary?.nextBestAction === "deploy_to_board", "verified build should suggest deploy_to_board");
    assert(currentBuild.agentRun.evidence.some(item => item.phase === "local_verify" && item.ok === true), "agent run should receive local verification evidence");
    assert(manifest.compile?.web === "node --check app.js", "manifest should preserve web compile command");
    assert(manifest.target === "/tmp/vibeboard-static", "manifest should keep board target");
    assert(logs.some(item => item.event === "build.start"), "build runtime should log build.start");
    assert(logs.some(item => item.event === "build.done"), "build runtime should log build.done");
  });
});

await test("build runtime uses Python runner when local Python is unavailable", async () => {
  const { createBuildRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "buildRuntime.mjs")).href);
  await withTempDir("vibeboard-build-runtime-runner-", async dir => {
    await withMockPythonRunner(async runner => {
      const files = generatedFilesForBuildId("vb-build-runner");
      await writeFiles(dir, files);
      const currentBuild = {
        id: "vb-build-runner",
        prompt: "runner-backed build runtime",
        files: { ...files },
        dir,
        built: false,
        deployed: false,
        manifest: JSON.parse(files["manifest.json"]),
        agentRun: { phase: "code", evidence: [], failures: [] },
      };
      const runtime = createBuildRuntime({
        appendServerLog: async () => {},
        execFileP: async (file, args, options) => {
          if (String(file).includes("python-vibeboard-missing")) {
            const error = new Error("spawn python-vibeboard-missing ENOENT");
            error.code = "ENOENT";
            throw error;
          }
          return await execFileP(file, args, options);
        },
        verifyAllLocal: async (verificationFiles, options) => {
          assert(options.pythonRunnerUrl === runner.url, "verifyAllLocal should receive runner URL");
          assert(options.renderRunnerUrl === "http://render-runner.example/vibeboard-runner", "verifyAllLocal should receive render runner URL");
          assert(options.renderRunnerToken === "render-token-for-test", "verifyAllLocal should receive render runner token");
          assert(options.renderRunnerRequired === "true", "verifyAllLocal should receive render runner required flag");
          assert(options.renderRunnerTimeoutMs === "22000", "verifyAllLocal should receive render runner timeout");
          assert(verificationFiles[HARDWARE_RESULT_FILE]?.includes('"build_id": "vb-build-runner"'), "verification should receive runner hardware result");
          return { ok: true, issues: [], evidence: { runner: true }, summary: "runner verify ok" };
        },
        createAppSpec: (prompt, id) => ({ prompt, id, target: "480x360 RK3566 Linux kiosk" }),
        generatedManifest: (prompt, id) => ({ id, prompt, files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
        getCurrentBuild: () => currentBuild,
        getBoard: () => ({ targetStatic: "/tmp/vibeboard-static" }),
        pythonBin: "python-vibeboard-missing",
        nodeBin: NODE_BIN,
        env: {
          PYTHON_RUNNER_URL: runner.url,
          PYTHON_RUNNER_REQUIRED: "true",
          RENDER_RUNNER_URL: "http://render-runner.example/vibeboard-runner",
          RENDER_RUNNER_TOKEN: "render-token-for-test",
          RENDER_RUNNER_REQUIRED: "true",
          RENDER_RUNNER_TIMEOUT_MS: "22000",
        },
      });

      await runtime.buildCurrent();
      assert(currentBuild.built === true, "runner-backed build should mark current build as built");
      assert(currentBuild.buildEvidence.evidence.pythonCompile === "passed", "runner-backed build should keep compile evidence");
      const hardwareResult = JSON.parse(await fs.readFile(path.join(dir, HARDWARE_RESULT_FILE), "utf8"));
      assert(hardwareResult.build_id === "vb-build-runner", "runner should produce matching hardware result");
    });
  });
});

await test("hardware contract wrapper preserves stdout when source exits cleanly", async () => {
  const { injectHardwareAppContracts } = await import(pathToFileURL(path.join(ROOT, "src", "generatedAppTemplate.mjs")).href);
  await withTempDir("vibeboard-hardware-exit-", async dir => {
    const script = injectHardwareAppContracts(`import json
import sys

print(json.dumps({
    "build_id": "source-build",
    "runtime": "source-runtime",
    "available_apis": ["/api/status", "./hardware-result.json"]
}))
sys.exit(0)
`, "vb-wrapper-exit-ok");
    const scriptPath = path.join(dir, "hardware_app.py");
    await fs.writeFile(scriptPath, script, "utf8");

    await execFileP(PYTHON_BIN, ["-m", "py_compile", scriptPath], { cwd: dir });
    const result = await execFileP(PYTHON_BIN, [scriptPath], { cwd: dir });
    const output = JSON.parse(result.stdout.trim());

    assert(output.build_id === "vb-wrapper-exit-ok", "wrapper should replace source build id");
    assert(output.runtime === "executed_on_board", "wrapper should normalize runtime");
    assert(output.available_apis.includes("./hardware-result.json"), "wrapper should preserve hardware result API contract");
  });
});

await test("frontend hardware SDK injection prevents agent overrides", async () => {
  const { injectAppHardwareSdkContracts } = await import(pathToFileURL(path.join(ROOT, "src", "generatedAppTemplate.mjs")).href);
  const source = injectAppHardwareSdkContracts(`
window.VibeBoardHardware = {
  async getStatus() {
    return { broken: true };
  },
};
(async () => {
  window.__agentStatus = await window.VibeBoardHardware.getStatus();
})();
`, "vb-sdk-lock");
  assert(source.includes("VibeBoard frontend hardware SDK"), "injected source should include SDK marker");
  assert(source.includes("/api/status"), "injected SDK should call /api/status");
  await withTempDir("vibeboard-sdk-lock-", async dir => {
    const html = `<!doctype html><script src="./app.js"></script>`;
    await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
    await fs.writeFile(path.join(dir, "app.js"), source, "utf8");
    const server = await startStaticServer(dir, {
      "/api/status": { ok: true, mode: "test" },
      "/hardware-result.json": { build_id: "vb-sdk-lock", runtime: "test", available_apis: ["/api/status", "./hardware-result.json"] },
    });
    let browser = null;
    try {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
      await page.goto(`http://127.0.0.1:${server.port}/index.html`, { waitUntil: "networkidle" });
      const state = await page.evaluate(async () => ({
        status: await window.VibeBoardHardware.getStatus(),
        agentStatus: window.__agentStatus,
        system: window.VibeBoardHardware.__vibeboard_system_sdk,
        ignoredOverride: Boolean(window.__vibeboardIgnoredHardwareOverride),
      }));
      assert(state.system === true, "window.VibeBoardHardware should remain the system SDK");
      assert(state.status.mode === "test", `expected SDK status call, got ${JSON.stringify(state)}`);
      assert(state.agentStatus.mode === "test", "agent override should not replace SDK behavior");
      assert(state.ignoredOverride === true, "attempted override should be recorded and ignored");
    } finally {
      if (browser) await browser.close().catch(() => {});
      await server.close();
    }
  });
});

await test("build runtime injects locked frontend hardware SDK before verification", async () => {
  const { createBuildRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "buildRuntime.mjs")).href);
  const { injectAppHardwareSdkContracts, injectHardwareAppContracts } = await import(pathToFileURL(path.join(ROOT, "src", "generatedAppTemplate.mjs")).href);
  await withTempDir("vibeboard-build-sdk-inject-", async dir => {
    const files = validGeneratedFiles();
    files["app.js"] = `
const BUILD_ID = "vb-build-sdk";
const PROMPT = "sdk injection test";
window.VibeBoardHardware = { getStatus: async () => ({ broken: true }) };
document.addEventListener("DOMContentLoaded", async () => {
  const root = document.getElementById("screen");
  const status = await window.VibeBoardHardware.getStatus();
  root.textContent = JSON.stringify(status);
});
`;
    await writeFiles(dir, files);
    const currentBuild = {
      id: "vb-build-sdk",
      prompt: "valid generated app smoke test",
      files: { ...files },
      dir,
      built: false,
      deployed: false,
      manifest: JSON.parse(files["manifest.json"]),
      agentRun: { phase: "code", evidence: [], failures: [] },
    };
    const runtime = createBuildRuntime({
      execFileP,
      verifyAllLocal: async verificationFiles => {
        const issues = validateFileContracts(verificationFiles, "Generated app");
        return { ok: issues.length === 0, issues, evidence: {}, summary: "contract verification" };
      },
      createAppSpec: (prompt, id) => ({ prompt, id, target: "480x360 RK3566 Linux kiosk" }),
      generatedManifest: (prompt, id) => ({ id, prompt, files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
      injectAppHardwareSdkContracts,
      injectHardwareAppContracts,
      getCurrentBuild: () => currentBuild,
      getBoard: () => ({ targetStatic: "/tmp/vibeboard-static" }),
      pythonBin: PYTHON_BIN,
      nodeBin: NODE_BIN,
    });

    await runtime.buildCurrent();
    const appSource = await fs.readFile(path.join(dir, "app.js"), "utf8");
    assert(appSource.includes("VibeBoard frontend hardware SDK"), "build runtime should inject frontend SDK");
    assert(appSource.includes("__vibeboardIgnoredHardwareOverride"), "SDK should guard agent override attempts");
    assert(currentBuild.built === true, "build should pass after SDK injection");
  });
});

await test("audio record failures include actionable hardware diagnostics", async () => {
  const source = await fs.readFile(path.join(ROOT, "server.mjs"), "utf8");
  assert(source.includes("classifyAudioError"), "server should classify board audio failures");
  assert(source.includes("audio_board_unreachable"), "board connection failures should have a stable audio error type");
  assert(source.includes("runAudioRoute"), "audio routes should catch SSH failures before the global classifier");
  assert(source.includes("audio_permission_denied"), "permission failures should have a stable error type");
  assert(source.includes("audio_device_busy"), "busy microphone failures should have a stable error type");
  assert(source.includes("audio_device_missing"), "missing microphone failures should have a stable error type");
  assert(source.includes("/tmp/vibeboard-audio/arecord.log"), "record command should surface board arecord logs");
  assert(source.includes("arecord exited immediately; microphone did not start."), "record command should fail when arecord exits immediately");
});

await test("main UI keeps navigation usable during running tasks", async () => {
  const html = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
  const js = await fs.readFile(path.join(ROOT, "app.js"), "utf8");
  assert(html.includes('id="generateBtn" type="submit">发送</button>'), "main composer button should be labeled send");
  assert(js.includes('promptInput?.addEventListener("keydown"'), "main composer should handle keyboard submission");
  assert(js.includes('event.key !== "Enter" || event.shiftKey || event.isComposing'), "Enter handling should preserve shift-enter and IME composition");
  assert(!js.includes("generateBtn.disabled = value"), "running state should not disable the send button");
  assert(!js.includes("if (busy) return; // Don't switch while a flow is running"), "running state should not block conversation selection");
  assert(!html.includes('id="jobCenterBtn"'), "main UI should remove the old task center topbar entry");
  assert(html.includes('id="guideBtn"'), "main UI should expose the new beginner guide entry");
  assert(html.includes('id="guideModal"'), "main UI should include beginner guide content");
  assert(js.includes("background: true"), "main UI should start long generation/deploy actions as background jobs");
});

await test("job store persists lifecycle logs and cancellation", async () => {
  const db = new SQL.Database();
  let saves = 0;
  const store = createJobStore(db, () => { saves += 1; }, {
    idFactory: () => `job_test_${saves}`,
  });
  store.initSchema();
  const job = store.createJob({
    type: "agent",
    conversationId: "conv-a",
    title: "Generate clock",
    input: { prompt: "clock" },
  });
  assert(job.status === "queued", "new job should start queued");
  store.appendLog(job.id, "queued for generation", { step: 1 }, "queued");
  const running = store.transition(job.id, { status: "running", phase: "generate" });
  assert(running.started_at, "running job should record started_at");
  const done = store.transition(job.id, {
    status: "succeeded",
    phase: "done",
    output: { ok: true },
    choices: [{ label: "Open result", action: "open_result" }],
  });
  assert(done.completed_at, "final job should record completed_at");
  assert(done.logs.some(item => item.message === "queued for generation"), "job logs should persist");
  assert(store.listJobs({ conversationId: "conv-a" }).length === 1, "jobs should be listable by conversation");

  const cancelJob = store.createJob({ type: "deploy", title: "Deploy", input: {} });
  const canceled = store.requestCancel(cancelJob.id);
  assert(canceled.status === "canceled", "queued job cancellation should finish the job");
  assert(saves >= 5, "job operations should persist to disk");
});

await test("job runtime queues work and turns failures into choices", async () => {
  const db = new SQL.Database();
  const store = createJobStore(db, () => {});
  store.initSchema();
  const runtime = createJobRuntime({ jobStore: store, classifyError });
  runtime.register("generate", async (body, ctx) => {
    ctx.phase("generate", "running fixture");
    if (body.fail) {
      const error = new Error("missing api key");
      error.errorType = "no_api_key";
      throw error;
    }
    return { ok: true, files: { "index.html": "<!doctype html>" } };
  });

  const okJob = runtime.enqueue("generate", { prompt: "ok" }, { title: "ok" });
  await new Promise(resolve => setTimeout(resolve, 20));
  const ok = store.getJob(okJob.id);
  assert(ok.status === "succeeded", `expected succeeded, got ${ok.status}`);
  assert(ok.choices.some(choice => choice.action === "open_result"), "successful generate job should expose open result choice");

  const failJob = runtime.enqueue("generate", { fail: true }, { title: "fail" });
  await new Promise(resolve => setTimeout(resolve, 20));
  const failed = store.getJob(failJob.id);
  assert(failed.status === "failed", `expected failed, got ${failed.status}`);
  assert(failed.error.errorType === "no_api_key", `failure should be classified, got ${JSON.stringify(failed.error)}`);
  assert(failed.choices.some(choice => choice.action === "open_model_settings"), "missing model config should offer model settings");
});

await test("job runtime times out stuck work with retry choices", async () => {
  const db = new SQL.Database();
  const store = createJobStore(db, () => {});
  store.initSchema();
  const runtime = createJobRuntime({ jobStore: store, classifyError, timeoutMs: 1 });
  runtime.register("agent", async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { ok: true };
  });

  const job = runtime.enqueue("agent", { prompt: "slow" }, { title: "slow" });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const timedOut = store.getJob(job.id);
  assert(timedOut.status === "failed", `expected timeout failure, got ${timedOut.status}`);
  assert(timedOut.error.errorType === "llm_timeout" || timedOut.error.errorType === "job_timeout", `expected timeout classification, got ${JSON.stringify(timedOut.error)}`);
  assert(timedOut.completed_at, "timeout should finish the job instead of leaving it running");
  assert(timedOut.choices.some(choice => choice.action === "retry_job"), "timeout should expose retry");
  assert(timedOut.choices.some(choice => choice.action === "view_logs"), "timeout should expose logs");
});

await test("build runtime rejects hardware result build id mismatch before verification", async () => {
  const { createBuildRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "buildRuntime.mjs")).href);
  await withTempDir("vibeboard-build-runtime-mismatch-", async dir => {
    const files = validGeneratedFiles();
    await writeFiles(dir, files);
    const currentBuild = {
      id: "vb-test-mismatch",
      prompt: "valid generated app smoke test",
      files: { ...files },
      dir,
      built: false,
      deployed: false,
      manifest: JSON.parse(files["manifest.json"]),
      agentRun: { phase: "code", evidence: [], failures: [] },
    };
    let verifyCalled = false;
    const runtime = createBuildRuntime({
      execFileP,
      verifyAllLocal: async () => {
        verifyCalled = true;
        return { ok: true, issues: [], evidence: {}, summary: "should not run" };
      },
      createAppSpec: (prompt, id) => ({ prompt, id, target: "480x360 RK3566 Linux kiosk" }),
      generatedManifest: (prompt, id) => ({ id, prompt, files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
      getCurrentBuild: () => currentBuild,
      getBoard: () => ({ targetStatic: "/tmp/vibeboard-static" }),
      pythonBin: PYTHON_BIN,
      nodeBin: NODE_BIN,
    });

    let failed = false;
    try {
      await runtime.buildCurrent();
    } catch (error) {
      failed = /HARDWARE_BUILD_ID_MISMATCH/.test(error.message);
    }

    assert(failed, "build runtime should reject mismatched hardware build_id");
    assert(verifyCalled === false, "local verification should not run after hardware contract failure");
  });
});

await test("default DeepSeek settings do not reuse OPENAI_API_KEY", async () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousDeepSeek = process.env.DEEPSEEK_API_KEY;
  const previousLlm = process.env.VIBEBOARD_LLM_API_KEY;
  const previousModel = process.env.VIBEBOARD_MODEL_API_KEY;

  try {
    process.env.OPENAI_API_KEY = "openai-key-only";
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.VIBEBOARD_LLM_API_KEY;
    delete process.env.VIBEBOARD_MODEL_API_KEY;

    const { normalizeModelSettings } = await import(pathToFileURL(path.join(ROOT, "src", "modelSettings.mjs")).href);
    const settings = normalizeModelSettings({});

    assert(settings.provider === "deepseek", `expected default deepseek provider, got ${settings.provider}`);
    assert(settings.apiKey === "", "DeepSeek must not inherit OPENAI_API_KEY");
    assert(settings.enabled === false, "DeepSeek should be disabled without a DeepSeek-specific key");
  } finally {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeek;
    if (previousLlm === undefined) delete process.env.VIBEBOARD_LLM_API_KEY;
    else process.env.VIBEBOARD_LLM_API_KEY = previousLlm;
    if (previousModel === undefined) delete process.env.VIBEBOARD_MODEL_API_KEY;
    else process.env.VIBEBOARD_MODEL_API_KEY = previousModel;
  }
});

await test("explicitly disabled model settings ignore environment API keys", async () => {
  const previousDeepSeek = process.env.DEEPSEEK_API_KEY;
  const previousLlm = process.env.VIBEBOARD_LLM_API_KEY;

  try {
    process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
    process.env.VIBEBOARD_LLM_API_KEY = "generic-test-key";

    const { normalizeModelSettings } = await import(pathToFileURL(path.join(ROOT, "src", "modelSettings.mjs")).href);
    const settings = normalizeModelSettings({ enabled: false });

    assert(settings.apiKey === "", "disabled settings should not inherit environment API keys");
    assert(settings.enabled === false, "explicit enabled:false should keep the model disabled");
  } finally {
    if (previousDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeek;
    if (previousLlm === undefined) delete process.env.VIBEBOARD_LLM_API_KEY;
    else process.env.VIBEBOARD_LLM_API_KEY = previousLlm;
  }
});

await test("project memory is scoped per conversation", async () => {
  const initSqlJs = (await import("sql.js")).default;
  const { createConversationStore } = await import(pathToFileURL(path.join(ROOT, "src", "conversationStore.mjs")).href);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = createConversationStore(db, () => {});
  store.initSchema();
  store.createConversation("project-a", "Clock");
  store.createConversation("project-b", "Weather");

  store.setProjectMemory("project-a", {
    summary: "clock app",
    goal: "make a fullscreen clock",
    requirements: ["show current time"],
    build_prompt: "Build a fullscreen clock.",
  });
  store.setProjectMemory("project-b", {
    summary: "weather app",
    goal: "make a weather dashboard",
    requirements: ["show Shenzhen weather"],
    build_prompt: "Build a weather dashboard.",
  });

  assert(store.getProjectMemory("project-a").goal.includes("clock"), "project-a memory should stay isolated");
  assert(store.getProjectMemory("project-b").goal.includes("weather"), "project-b memory should stay isolated");
  store.deleteConversation("project-a");
  assert(store.getProjectMemory("project-a").goal === "", "deleted project memory should be removed");
  assert(store.getProjectMemory("project-b").goal.includes("weather"), "deleting one project must not delete another project memory");
});

await test("conversation files reject chat-text pollution", async () => {
  const initSqlJs = (await import("sql.js")).default;
  const { createConversationStore } = await import(pathToFileURL(path.join(ROOT, "src", "conversationStore.mjs")).href);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = createConversationStore(db, () => {});
  store.initSchema();
  store.createConversation("project-files", "Files");

  store.saveConversationFiles("project-files", "build-safe", {
    "index.html": "<!doctype html>",
    "style.css": "body{}",
    "app.js": "console.log('ok')",
    "{\"intent\":\"build_ready\"}": "planner json accidentally used as a filename",
    "开始吧": "user chat accidentally used as a filename",
  });

  const saved = store.loadConversationFiles("project-files").files;
  assert(saved["index.html"] === "<!doctype html>", "valid generated file should be saved");
  assert(saved["style.css"] === "body{}", "valid style file should be saved");
  assert(!saved["{\"intent\":\"build_ready\"}"], "planner JSON must not be treated as a generated file");
  assert(!saved["开始吧"], "user chat text must not be treated as a generated file");
});

await test("conversation files keep only manifest-declared assets", async () => {
  const initSqlJs = (await import("sql.js")).default;
  const { createConversationStore } = await import(pathToFileURL(path.join(ROOT, "src", "conversationStore.mjs")).href);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = createConversationStore(db, () => {});
  store.initSchema();
  store.createConversation("project-assets", "Assets");

  const files = {
    ...validGeneratedFilesWithAsset(),
    "assets/undeclared.webp": Buffer.from([4, 5, 6]),
  };
  store.saveConversationFiles("project-assets", "build-assets", files);
  const saved = store.loadConversationFiles("project-assets").files;

  assert(saved["manifest.json"], "manifest should be saved");
  assert(saved["assets/pet.json"] === files["assets/pet.json"], "declared text asset should be saved");
  assert(Buffer.isBuffer(saved["assets/sprite.webp"]), "declared binary asset should be restored as Buffer");
  assert(saved["assets/sprite.webp"].equals(files["assets/sprite.webp"]), "declared binary asset should match original");
  assert(!saved["assets/undeclared.webp"], "undeclared asset should not be saved");
});

await test("conversation files filter legacy polluted rows on load", async () => {
  const initSqlJs = (await import("sql.js")).default;
  const { createConversationStore } = await import(pathToFileURL(path.join(ROOT, "src", "conversationStore.mjs")).href);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = createConversationStore(db, () => {});
  store.initSchema();
  store.createConversation("project-legacy-files", "Legacy Files");

  db.run(
    "INSERT INTO conversation_files (conversation_id, build_id, filename, content) VALUES (?, ?, ?, ?)",
    ["project-legacy-files", "build-legacy", "{\"intent\":\"build_ready\"}", "polluted chat JSON"]
  );
  db.run(
    "INSERT INTO conversation_files (conversation_id, build_id, filename, content) VALUES (?, ?, ?, ?)",
    ["project-legacy-files", "build-legacy", "app.js", "console.log('safe')"]
  );

  const loaded = store.loadConversationFiles("project-legacy-files").files;
  assert(loaded["app.js"] === "console.log('safe')", "valid legacy generated file should load");
  assert(Object.keys(loaded).length === 1, `polluted legacy rows should be filtered, got ${Object.keys(loaded).join(",")}`);
});

await test("conversation store persists compound writes once per operation", async () => {
  const initSqlJs = (await import("sql.js")).default;
  const { createConversationStore } = await import(pathToFileURL(path.join(ROOT, "src", "conversationStore.mjs")).href);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  let saveCount = 0;
  const store = createConversationStore(db, () => {
    saveCount += 1;
  });
  store.initSchema();
  store.createConversation("project-persist", "Persist");
  saveCount = 0;

  store.appendMessage("project-persist", { role: "user", content: "first prompt" });
  assert(saveCount === 1, `appendMessage should save once, got ${saveCount}`);

  saveCount = 0;
  store.saveConversationFiles("project-persist", "build-persist", {
    "index.html": "<!doctype html>",
    "style.css": "body{}",
    "app.js": "console.log('ok')",
    "hardware_app.py": "print('ok')",
    "manifest.json": "{}",
    "hardware-result.json": "{}",
  });
  assert(saveCount === 1, `saveConversationFiles should save once, got ${saveCount}`);

  saveCount = 0;
  store.setProjectMemory("project-persist", {
    summary: "persist",
    goal: "persist compound writes",
  });
  assert(saveCount === 1, `setProjectMemory should save once, got ${saveCount}`);

  saveCount = 0;
  store.deleteConversation("project-persist");
  assert(saveCount === 1, `deleteConversation should save once, got ${saveCount}`);
});

await test("chat planner keeps capability questions in chat mode", async () => {
  const { planChatWithModel } = await import(pathToFileURL(path.join(ROOT, "src", "chatPlanner.mjs")).href);
  let requestBody = null;
  const plan = await planChatWithModel({
    baseUrl: "http://planner.test",
    apiKey: "test-key",
    model: "mock-planner",
  }, [{ role: "user", content: "你能做什么？" }], {}, {
    summary: "旧摘要",
    goal: "旧目标",
  }, async (url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              intent: "chat",
              reply: "我可以先和你讨论小屏应用需求，再在你确认后生成代码。",
              ready_to_build: false,
              build_prompt: "",
              project_memory: {
                summary: "用户在询问能力范围",
                goal: "",
                requirements: [],
                constraints: ["480x360 小屏"],
                open_questions: ["用户还没有提出具体应用需求"],
                decisions: [],
                build_prompt: "",
              },
            }),
          },
        }],
      }),
    };
  });

  assert(plan.intent === "chat", `expected chat intent, got ${JSON.stringify(plan)}`);
  assert(plan.ready_to_build === false, "capability question must not trigger build");
  assert(plan.build_prompt === "", "chat mode should not include build_prompt");
  assert(plan.project_memory.summary.includes("能力"), `expected project memory update, got ${JSON.stringify(plan.project_memory)}`);
  assert(requestBody.messages[0].content.includes("旧目标"), "planner prompt should include existing project memory");
});

await test("chat planner requires build_prompt for build_ready", async () => {
  const { parseChatPlan } = await import(pathToFileURL(path.join(ROOT, "src", "chatPlanner.mjs")).href);
  const invalid = parseChatPlan(JSON.stringify({
    intent: "build_ready",
    reply: "可以开始。",
    ready_to_build: true,
    build_prompt: "",
  }));
  const valid = parseChatPlan(JSON.stringify({
    intent: "build_ready",
    reply: "方案确认，可以开始构建。",
    ready_to_build: true,
    build_prompt: "生成一个 480x360 全屏时钟，显示当前时间、日期和本地运行状态。",
    project_memory: {
      summary: "全屏时钟",
      goal: "生成时钟应用",
      requirements: ["显示当前时间"],
      constraints: ["480x360"],
      open_questions: [],
      decisions: ["全屏布局"],
      build_prompt: "生成一个 480x360 全屏时钟，显示当前时间、日期和本地运行状态。",
    },
  }));

  assert(invalid.ready_to_build === false, "build_ready without build_prompt must be downgraded");
  assert(invalid.intent === "clarify", `expected clarify fallback, got ${JSON.stringify(invalid)}`);
  assert(valid.ready_to_build === true, `expected valid build plan, got ${JSON.stringify(valid)}`);
  assert(valid.build_prompt.includes("480x360"), "valid build prompt should be preserved");
  assert(valid.project_memory.requirements.includes("显示当前时间"), "valid build plan should preserve project memory");
});

await test("chat planner preserves quick replies for choice-based clarification", async () => {
  const { planChatWithModel } = await import(pathToFileURL(path.join(ROOT, "src", "chatPlanner.mjs")).href);
  let requestBody = null;
  const plan = await planChatWithModel({
    baseUrl: "http://planner.test",
    apiKey: "test-key",
    model: "mock-planner",
  }, [{ role: "user", content: "帮我做一个桌面小助手" }], {}, {}, async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              intent: "clarify",
              reply: "你想优先展示哪类信息？",
              ready_to_build: false,
              build_prompt: "",
              quick_replies: [
                { label: "时间天气", value: "优先展示时间、天气和一句 AI 摘要。" },
                { label: "设备状态", value: "优先展示设备状态、网络、内存和温度。" },
                { label: "按默认方案", value: "按你推荐的默认方案继续。" },
              ],
              project_memory: {
                summary: "桌面小助手",
                goal: "做一个小屏助手",
                requirements: [],
                constraints: ["480x360"],
                open_questions: ["优先展示哪类信息？"],
                decisions: [],
                build_prompt: "",
              },
            }),
          },
        }],
      }),
    };
  });

  assert(plan.intent === "clarify", `expected clarify intent, got ${JSON.stringify(plan)}`);
  assert(plan.ready_to_build === false, "clarify choice should not trigger build");
  assert(plan.quick_replies.length === 3, `expected quick replies, got ${JSON.stringify(plan.quick_replies)}`);
  assert(plan.quick_replies[0].label === "时间天气", "quick reply label should be preserved");
  assert(plan.quick_replies[2].value.includes("默认方案"), "default option should be preserved");
  assert(requestBody.messages[0].content.includes("quick_replies"), "planner prompt should request structured quick replies");
  assert(requestBody.messages[0].content.includes("clarify 每轮最多问 1 个"), "planner prompt should limit clarification questions");
});

await test("chat planner supplies fallback choices when clarification omits quick replies", async () => {
  const { parseChatPlan } = await import(pathToFileURL(path.join(ROOT, "src", "chatPlanner.mjs")).href);
  const plan = parseChatPlan(JSON.stringify({
    intent: "clarify",
    reply: "还需要确认数据来源。",
    ready_to_build: false,
    build_prompt: "",
    project_memory: {
      summary: "天气面板",
      goal: "做天气面板",
      requirements: ["显示天气"],
      constraints: ["480x360"],
      open_questions: ["天气数据用真实接口还是模拟数据？"],
      decisions: [],
      build_prompt: "",
    },
  }));

  assert(plan.intent === "clarify", `expected clarify, got ${JSON.stringify(plan)}`);
  assert(plan.quick_replies.length >= 3, `expected fallback choices, got ${JSON.stringify(plan.quick_replies)}`);
  assert(plan.quick_replies.some(choice => choice.label.includes("默认")), "fallback choices should include a default path");
  assert(plan.quick_replies.some(choice => choice.label.includes("极简")), "fallback choices should include a minimal version path");
});

await test("asset library analyzes mixed user assets for agent context", async () => {
  const { normalizeIncomingAssets, formatAssetContext, summarizeAssets } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const html = Buffer.from("<section><img src=\"hero.png\"><button>Deploy</button></section>", "utf8").toString("base64");
  const text = Buffer.from("品牌色彩 palette: cyan. 480x360 dashboard metrics.", "utf8").toString("base64");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString("base64");
  const normalized = normalizeIncomingAssets([
    { name: "hero.png", mime: "image/png", encoding: "base64", content: png },
    { name: "component.html", mime: "text/html", encoding: "base64", content: html },
    { name: "brief.txt", mime: "text/plain", encoding: "base64", content: text },
  ]);

  assert(normalized.assets.length === 3, `expected 3 assets, got ${JSON.stringify(normalized)}`);
  assert(normalized.assets.some(asset => asset.kind === "image"), "image asset should be classified");
  assert(normalized.assets.some(asset => asset.kind === "component"), "HTML component should be classified");
  assert(normalized.assets.some(asset => asset.summary.signals.includes("Contains UI/component markup.")), "component signal should be extracted");
  const summary = summarizeAssets(normalized.assets);
  assert(summary.designBrief.productIntents.some(item => item.includes("dashboard") || item.includes("showcase")), `product intent should be inferred, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.layoutPlan.some(item => item.includes("480x360") || item.includes("control row") || item.includes("dashboard")), `layout plan should be inferred, got ${JSON.stringify(summary.designBrief)}`);
  const context = formatAssetContext(normalized.assets);
  assert(context.includes("Uploaded asset library"), "asset context should have a heading");
  assert(context.includes("component.html"), "asset context should include component names");
  assert(context.includes("480x360"), "asset text preview should be available to the agent");
  assert(context.includes("product-intent:"), "agent context should expose inferred product intents");
  assert(context.includes("layout-plan:"), "agent context should expose inferred layout plan");
});

await test("asset library store returns non-duplicated upload summary", async () => {
  const initSqlJs = (await import("sql.js")).default;
  const { createAssetLibraryStore } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = createAssetLibraryStore(db, () => {});
  store.initSchema();
  const content = Buffer.from("480x360 launch screen copy", "utf8").toString("base64");
  const result = store.addAssets("asset-summary-test", [
    { name: "copy.txt", mime: "text/plain", encoding: "base64", content },
  ]);

  assert(result.assets.length === 1, `expected one uploaded asset, got ${JSON.stringify(result)}`);
  assert(result.summary.count === 1, `summary should not double count upload, got ${JSON.stringify(result.summary)}`);
  assert(result.summary.byKind.text === 1, "summary should count text once");
  assert(store.listAssets("asset-summary-test").length === 1, "store should persist one asset");
});

await test("asset library exposes embeddable passive assets for generated builds", async () => {
  const initSqlJs = (await import("sql.js")).default;
  const { createAssetLibraryStore } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = createAssetLibraryStore(db, () => {});
  store.initSchema();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const html = Buffer.from("<section>reference only</section>", "utf8").toString("base64");
  const text = Buffer.from("copy should be summarized, not embedded as runtime asset", "utf8").toString("base64");
  store.addAssets("asset-embed-test", [
    { name: "Hero Image.png", mime: "image/png", encoding: "base64", content: png },
    { name: "component.html", mime: "text/html", encoding: "base64", content: html },
    { name: "brief.txt", mime: "text/plain", encoding: "base64", content: text },
  ]);

  const generated = store.generatedAssets("asset-embed-test");
  assert(generated.items.length === 1, `expected one embeddable asset, got ${JSON.stringify(generated)}`);
  assert(generated.items[0].path === "assets/uploaded/Hero Image.png", `expected safe uploaded path, got ${JSON.stringify(generated.items)}`);
  assert(Buffer.isBuffer(generated.files["assets/uploaded/Hero Image.png"]), "embedded asset content should be a Buffer");
  assert(generated.rejected.some(item => item.name === "component.html"), "active component asset should remain reference-only");
  assert(generated.rejected.some(item => item.name === "brief.txt"), "unsupported text runtime asset should remain reference-only");
});

await test("project workspace persists assets, memory, and build snapshots", async () => {
  const initSqlJs = (await import("sql.js")).default;
  const { createConversationStore } = await import(pathToFileURL(path.join(ROOT, "src", "conversationStore.mjs")).href);
  const { createAssetLibraryStore } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const { createProjectWorkspace } = await import(pathToFileURL(path.join(ROOT, "src", "projectWorkspace.mjs")).href);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const conversationStore = createConversationStore(db, () => {});
  conversationStore.initSchema();
  const assetLibraryStore = createAssetLibraryStore(db, () => {});
  assetLibraryStore.initSchema();

  await withTempDir("vibeboard-project-workspace-", async dir => {
    const workspace = createProjectWorkspace({
      root: ROOT,
      env: { VIBEBOARD_PROJECTS_DIR: dir },
      conversationStore,
      assetLibraryStore,
      now: () => new Date("2026-06-27T00:00:00.000Z"),
    });
    const conversation = conversationStore.createConversation("conv-project-assets", "Asset Tracking Demo");
    const project = await workspace.ensureProject(conversation.id, conversation.title);
    assert(project.project_dir.startsWith(dir), "project folder should live under configured projects dir");

    const result = assetLibraryStore.addAssets(conversation.id, [{
      name: "brief.txt",
      mime: "text/plain",
      encoding: "base64",
      content: Buffer.from("Use a neon green counter UI", "utf8").toString("base64"),
    }], {
      persistAssetFile: asset => workspace.persistAssetFile(conversation.id, asset),
    });
    assert(result.assets.length === 1, "asset should be stored");
    await new Promise(resolve => setTimeout(resolve, 50));
    const storedAsset = assetLibraryStore.listAssets(conversation.id)[0];
    assert(storedAsset.project_path.endsWith("brief.txt"), `asset project path should be recorded, got ${JSON.stringify(storedAsset)}`);

    const renamedPath = await workspace.renameAssetFile(conversation.id, storedAsset.project_path, "brief-renamed.txt");
    assetLibraryStore.updateAsset(conversation.id, storedAsset.id, { name: "brief-renamed.txt", usage: "reference_only", projectPath: renamedPath });
    const renamed = assetLibraryStore.getAsset(conversation.id, storedAsset.id);
    assert(renamed.name === "brief-renamed.txt", "asset metadata rename should persist");
    assert(renamed.usage === "reference_only", "asset usage should persist");

    const memory = await workspace.writeMemory(conversation.id, { trigger: "unit-test", prompt: "Build it" });
    assert(memory.path.endsWith("MEMORY.md"), "workspace should write MEMORY.md");
    const memoryText = await fs.readFile(memory.path, "utf8");
    assert(memoryText.includes("Asset Tracking Demo"), "memory should include project title");
    assert(memoryText.includes("brief-renamed.txt"), "memory should include renamed asset");

    await workspace.writeBuildSnapshot(conversation.id, "vb-unit-build", {
      "index.html": "<main>ok</main>",
      "app.js": "console.log('ok')",
    }, [{ id: renamed.id, name: renamed.name, project_path: renamed.project_path, usage: renamed.usage, sha256: renamed.sha256 }]);
    const files = await workspace.listProjectFiles(conversation.id);
    assert(files.some(file => file.path === "MEMORY.md"), "project files should list memory");
    assert(files.some(file => file.path === "assets/text/brief-renamed.txt"), "project files should list renamed asset");
    assert(files.some(file => file.path === "builds/vb-unit-build/asset-snapshot.json"), "project files should list build snapshot");
  });
});

await test("asset library usage controls generated assets and records build usage", async () => {
  const initSqlJs = (await import("sql.js")).default;
  const { createAssetLibraryStore } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = createAssetLibraryStore(db, () => {});
  store.initSchema();
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  store.addAssets("asset-usage-test", [
    { name: "embed.png", mime: "image/png", encoding: "base64", content: image, usage: "embeddable" },
    { name: "reference.png", mime: "image/png", encoding: "base64", content: image, usage: "reference_only" },
  ]);
  const generated = store.generatedAssets("asset-usage-test");
  assert(generated.items.some(item => item.name === "embed.png"), "embeddable image should be selected");
  assert(!generated.items.some(item => item.name === "reference.png"), "reference_only image should not be embedded");
  const snapshots = store.recordBuildSnapshot("asset-usage-test", "vb-asset-build", generated);
  assert(snapshots.length === generated.items.length, "snapshot rows should match embedded assets");
  const used = store.listAssets("asset-usage-test").find(asset => asset.name === "embed.png");
  assert(used.usage === "used_in_build", "used asset should be marked used_in_build");
});

await test("asset library auto-classifies assets into file-manager folders", async () => {
  const initSqlJs = (await import("sql.js")).default;
  const { createAssetLibraryStore } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = createAssetLibraryStore(db, () => {});
  store.initSchema();
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const audio = makeWavHeader().toString("base64");
  const text = Buffer.from("notes", "utf8").toString("base64");
  store.addAssets("folder-classify-test", [
    { name: "hero.png", mime: "image/png", encoding: "base64", content: image },
    { name: "sound.wav", mime: "audio/wav", encoding: "base64", content: audio },
    { name: "notes.txt", mime: "text/plain", encoding: "base64", content: text },
  ]);
  const folders = store.listFolders("folder-classify-test");
  const images = folders.find(folder => folder.name === "图片");
  const audioFolder = folders.find(folder => folder.name === "音频");
  const other = folders.find(folder => folder.name === "其他");
  assert(images?.asset_count === 1, `image folder should have one asset: ${JSON.stringify(folders)}`);
  assert(audioFolder?.asset_count === 1, "audio folder should have one asset");
  assert(other?.asset_count === 1, "other folder should have one asset");
  assert(store.listAssets("folder-classify-test").every(asset => asset.folder_id), "all assets should expose folder_id");

  const legacyId = "legacy-unfiled-asset";
  db.run(`
    INSERT INTO asset_library (
      id, conversation_id, name, mime, kind, size, sha256, usage, encoding, content, summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [legacyId, "folder-classify-test", "old-video.mp4", "video/mp4", "video", 4, "legacy-sha", "auto", "base64", "", "{}"]);
  const migrated = store.listAssets("folder-classify-test").find(asset => asset.id === legacyId);
  const videoFolder = store.listFolders("folder-classify-test").find(folder => folder.name === "视频");
  assert(migrated?.folder_id === videoFolder?.id, "legacy unfiled assets should be migrated into their type folder");

  const custom = store.createFolder("folder-classify-test", "参考图");
  assert(custom.name === "参考图", "custom folder should be created");
  const renamed = store.updateFolder("folder-classify-test", custom.id, { name: "视觉参考" });
  assert(renamed.name === "视觉参考", "custom folder should be renamed");
  const deleted = store.deleteFolder("folder-classify-test", custom.id);
  assert(deleted.moved_to, "custom folder delete should move contents to fallback");
  let locked = false;
  try {
    store.deleteFolder("folder-classify-test", images.id);
  } catch (error) {
    locked = error.errorType === "system_folder_locked";
  }
  assert(locked, "system folders should not be deleteable");
});

await test("asset library expands ZIP bundles into analyzed assets", async () => {
  const { normalizeIncomingAssets, formatAssetContext } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const zip = makeZip([
    { name: "brief.txt", content: "品牌视觉 cyan 480x360 product screen" },
    { name: "components/card.html", content: "<section><button>Start</button></section>" },
    { name: "images/hero.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  const result = normalizeIncomingAssets([
    { name: "launch-pack.zip", mime: "application/zip", encoding: "base64", content: zip.toString("base64") },
  ]);
  const names = result.assets.map(asset => asset.name);

  assert(result.rejected.length === 0, `expected zip to unpack cleanly, got ${JSON.stringify(result.rejected)}`);
  assert(names.includes("launch-pack.zip"), "archive itself should be retained");
  assert(names.includes("launch-pack/brief.txt"), `brief should be extracted, got ${names.join(",")}`);
  assert(names.includes("launch-pack/components/card.html"), "nested component should be extracted");
  assert(names.includes("launch-pack/images/hero.png"), "nested image should be extracted");
  assert(result.assets.some(asset => asset.kind === "component" && asset.summary.signals.includes("Contains UI/component markup.")), "component signal should survive zip extraction");
  const context = formatAssetContext(result.assets);
  assert(context.includes("ZIP archive extracted 3 supported files"), "archive extraction should be visible to the agent");
  assert(context.includes("launch-pack/components/card.html"), "agent context should include extracted file path");
});

await test("asset library rejects unsafe ZIP entry paths", async () => {
  const { normalizeIncomingAssets } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const zip = makeZip([
    { name: "../escape.txt", content: "escape" },
    { name: "safe.txt", content: "ok" },
  ]);
  const result = normalizeIncomingAssets([
    { name: "unsafe.zip", mime: "application/zip", encoding: "base64", content: zip.toString("base64") },
  ]);
  const names = result.assets.map(asset => asset.name);

  assert(names.includes("unsafe.zip"), "archive itself should still be retained");
  assert(names.includes("unsafe/safe.txt"), "safe entry should be extracted");
  assert(!names.some(name => name.includes("escape")), `unsafe entry should not be accepted, got ${names.join(",")}`);
  assert(result.rejected.some(item => item.error.includes("unsafe ZIP entry path")), `expected unsafe path rejection, got ${JSON.stringify(result.rejected)}`);
});

await test("asset library expands TGZ bundles and builds a product design brief", async () => {
  const { normalizeIncomingAssets, formatAssetContext, summarizeAssets } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const tar = makeTar([
    { name: "brief/brand.md", content: "品牌 palette cyan #12f7d6 logo motion dashboard 480x360 音乐 氛围 CTA: 立即开始" },
    { name: "components/player.html", content: "<section class=\"hero player-card\"><audio src=\"theme.mp3\"></audio><button>Play</button><button>Connect Device</button></section>" },
    { name: "data/metrics.json", content: "{\"temperature\": 26, \"battery\": 88, \"status\": \"online\", \"volume\": 64}" },
    { name: "media/theme.wav", content: makeWavHeader({ sampleRate: 16000, channels: 1, durationSec: 2 }) },
    { name: "media/loop.webm", content: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) },
    { name: "images/product.png", content: makePngHeader(480, 360) },
  ]);
  const tgz = zlib.gzipSync(tar);
  const result = normalizeIncomingAssets([
    { name: "product-kit.tgz", mime: "application/gzip", encoding: "base64", content: tgz.toString("base64") },
  ]);
  const names = result.assets.map(asset => asset.name);
  const summary = summarizeAssets(result.assets);
  const context = formatAssetContext(result.assets);

  assert(result.rejected.length === 0, `expected tgz to unpack cleanly, got ${JSON.stringify(result.rejected)}`);
  assert(names.includes("product-kit.tgz"), "archive itself should be retained");
  assert(names.includes("product-kit/brief/brand.md"), `brief should be extracted, got ${names.join(",")}`);
  assert(names.includes("product-kit/components/player.html"), "component should be extracted from tgz");
  assert(names.includes("product-kit/data/metrics.json"), "JSON data should be extracted from tgz");
  assert(names.includes("product-kit/media/theme.wav"), "audio should be extracted from tgz");
  assert(names.includes("product-kit/media/loop.webm"), "video should be extracted from tgz");
  assert(names.includes("product-kit/images/product.png"), "image should be extracted from tgz");
  assert(summary.byKind.audio === 1, `audio should be classified, got ${JSON.stringify(summary.byKind)}`);
  assert(summary.byKind.video === 1, `video should be classified, got ${JSON.stringify(summary.byKind)}`);
  assert(summary.byKind.image === 1, `image should be classified, got ${JSON.stringify(summary.byKind)}`);
  assert(summary.designBrief.priorities.some(item => item.includes("audio") || item.includes("音频")), `design brief should mention audio, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.priorities.some(item => item.includes("dashboard")), "design brief should infer dashboard priority from text");
  assert(summary.designBrief.palette.includes("#12f7d6"), `design brief should expose palette cues, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.components.some(item => item.includes("player")), `design brief should expose component cues, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.ctas.some(item => /Play|立即开始|Connect/.test(item)), `design brief should expose CTA cues, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.dataFields.includes("temperature"), `design brief should expose JSON fields, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.productIntents.some(item => item.includes("media controller") || item.includes("dashboard")), `design brief should infer product intent, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.layoutPlan.some(item => item.includes("media/status strip") || item.includes("dashboard grid")), `design brief should infer a layout plan, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.mediaPlan.some(item => item.includes("audio") || item.includes("video") || item.includes("image")), `design brief should include media plan, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.mediaProfiles.some(item => item.includes("product.png") && item.includes("480x360")), `design brief should expose image dimensions, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.mediaProfiles.some(item => item.includes("theme.wav") && item.includes("2s")), `design brief should expose audio duration, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.items.some(item => item.name === "product-kit/images/product.png" && item.mediaProfile?.width === 480 && item.mediaProfile?.height === 360), `image item should expose media profile, got ${JSON.stringify(summary.items)}`);
  assert(summary.items.some(item => item.name === "product-kit/media/theme.wav" && item.mediaProfile?.durationSec === 2), `audio item should expose media profile, got ${JSON.stringify(summary.items)}`);
  assert(context.includes("Inferred product design brief from assets"), "agent context should include product design brief");
  assert(context.includes("priority:"), "agent context should expose priorities");
  assert(context.includes("palette: #12f7d6"), "agent context should expose palette lines");
  assert(context.includes("component:"), "agent context should expose component lines");
  assert(context.includes("data-field: temperature"), "agent context should expose data field lines");
  assert(context.includes("product-intent:"), "agent context should expose product intent lines");
  assert(context.includes("layout-plan:"), "agent context should expose layout plan lines");
  assert(context.includes("media-plan:"), "agent context should expose media plan lines");
  assert(context.includes("media-profile: Image product-kit/images/product.png"), "agent context should expose image media profile");
  assert(context.includes("media-profile: Audio product-kit/media/theme.wav"), "agent context should expose audio media profile");
});

await test("asset library infers product defaults when uploads are incomplete", async () => {
  const { normalizeIncomingAssets, formatAssetContext, summarizeAssets } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const metrics = Buffer.from("{\"temperature\": 25, \"battery\": 82, \"status\": \"ready\"}", "utf8").toString("base64");
  const brief = Buffer.from("480x360 sensor dashboard status panel. Use a quiet embedded hardware style.", "utf8").toString("base64");
  const result = normalizeIncomingAssets([
    { name: "metrics.json", mime: "application/json", encoding: "base64", content: metrics },
    { name: "brief.txt", mime: "text/plain", encoding: "base64", content: brief },
  ]);
  const summary = summarizeAssets(result.assets);
  const context = formatAssetContext(result.assets);

  assert(summary.designBrief.productIntents.some(item => item.includes("dashboard")), `dashboard intent should be inferred, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.layoutPlan.some(item => item.includes("dashboard grid")), `dashboard layout should be inferred, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.completionGaps.some(item => item.includes("No visual media")), `missing visual default should be exposed, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.completionGaps.some(item => item.includes("No explicit CTA")), `missing CTA default should be exposed, got ${JSON.stringify(summary.designBrief)}`);
  assert(context.includes("completion-gap:"), "agent context should expose completion gaps");
});

await test("asset library extracts lightweight document profiles for agent context", async () => {
  const { normalizeIncomingAssets, formatAssetContext, summarizeAssets } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const docx = makeDocx("Product Brief Hero screen CTA Start battery dashboard");
  const xlsx = makeXlsx(["temperature", "battery", "status"]);
  const result = normalizeIncomingAssets([
    { name: "product-brief.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", encoding: "base64", content: docx.toString("base64") },
    { name: "metrics.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", encoding: "base64", content: xlsx.toString("base64") },
  ]);
  const summary = summarizeAssets(result.assets);
  const context = formatAssetContext(result.assets);

  assert(result.assets.length === 2, `expected 2 document assets, got ${JSON.stringify(result)}`);
  assert(result.assets.every(asset => asset.kind === "document"), `documents should be classified, got ${JSON.stringify(result.assets.map(asset => asset.kind))}`);
  assert(summary.byKind.document === 2, `summary should count documents, got ${JSON.stringify(summary.byKind)}`);
  assert(summary.designBrief.documentProfiles.some(item => item.includes("product-brief.docx") && item.includes("Product Brief")), `docx profile should expose text, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.documentProfiles.some(item => item.includes("metrics.xlsx") && item.includes("temperature")), `xlsx profile should expose shared strings, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.productIntents.some(item => item.includes("spreadsheet") || item.includes("document-backed")), `documents should influence product intent, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.layoutPlan.some(item => item.includes("spreadsheet") || item.includes("document")), `documents should influence layout plan, got ${JSON.stringify(summary.designBrief)}`);
  assert(context.includes("document-profile: Document product-brief.docx"), "agent context should expose docx document profile");
  assert(context.includes("document-profile: Spreadsheet metrics.xlsx"), "agent context should expose xlsx document profile");
});

await test("asset library recognizes design source files as visual direction", async () => {
  const { normalizeIncomingAssets, formatAssetContext, summarizeAssets } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const tokens = Buffer.from(JSON.stringify({
    color: { primary: { value: "#12f7d6" }, background: { value: "#08111f" } },
    component: "hero card button metric panel",
  }), "utf8").toString("base64");
  const fig = Buffer.from([0x46, 0x49, 0x47, 0x00, 0x01]).toString("base64");
  const result = normalizeIncomingAssets([
    { name: "brand-system.tokens", mime: "application/json", encoding: "base64", content: tokens },
    { name: "dashboard-ui.fig", mime: "application/octet-stream", encoding: "base64", content: fig },
  ]);
  const summary = summarizeAssets(result.assets);
  const context = formatAssetContext(result.assets);

  assert(result.assets.length === 2, `expected 2 design assets, got ${JSON.stringify(result)}`);
  assert(result.assets.every(asset => asset.kind === "design"), `design assets should be classified, got ${JSON.stringify(result.assets.map(asset => asset.kind))}`);
  assert(summary.byKind.design === 2, `summary should count design assets, got ${JSON.stringify(summary.byKind)}`);
  assert(summary.designBrief.designProfiles.some(item => item.includes("brand-system.tokens") && item.includes("#12f7d6")), `design profile should expose token colors, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.designProfiles.some(item => item.includes("dashboard-ui.fig") && item.includes("figma")), `figma source should be profiled, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.productIntents.some(item => item.includes("design-system-led")), `design assets should influence product intent, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.layoutPlan.some(item => item.includes("design source cues")), `design assets should influence layout plan, got ${JSON.stringify(summary.designBrief)}`);
  assert(context.includes("design-profile: Design brand-system.tokens"), "agent context should expose design token profile");
  assert(context.includes("design-profile: Design dashboard-ui.fig"), "agent context should expose figma profile");
});

await test("asset library expands single GZ text assets", async () => {
  const { normalizeIncomingAssets } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
  const gz = zlib.gzipSync(Buffer.from("480x360 data dashboard status metrics", "utf8"));
  const result = normalizeIncomingAssets([
    { name: "metrics.txt.gz", mime: "application/gzip", encoding: "base64", content: gz.toString("base64") },
  ]);
  const names = result.assets.map(asset => asset.name);

  assert(result.rejected.length === 0, `expected gz to unpack cleanly, got ${JSON.stringify(result.rejected)}`);
  assert(names.includes("metrics.txt.gz"), "gz archive should be retained");
  assert(names.includes("metrics.txt/metrics.txt"), `inner text should be extracted under archive prefix, got ${names.join(",")}`);
  assert(result.assets.some(asset => asset.name === "metrics.txt/metrics.txt" && asset.kind === "text"), "inner gz text should be classified");
});

await test("chat planner prompt includes asset context and Codex hardware boundary", async () => {
  const { planChatWithModel } = await import(pathToFileURL(path.join(ROOT, "src", "chatPlanner.mjs")).href);
  let requestBody = null;
  await planChatWithModel({
    baseUrl: "http://planner.test",
    apiKey: "test-key",
    model: "mock-planner",
  }, [{ role: "user", content: "用我上传的素材做个产品展示屏" }], {}, {}, "## Uploaded asset library\n- hero.png (image): product photo", "codex", async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              intent: "clarify",
              reply: "产品展示屏优先突出什么？",
              quick_replies: [{ label: "主视觉", value: "优先突出主视觉和产品名称。" }],
              ready_to_build: false,
              build_prompt: "",
              project_memory: {
                summary: "产品展示屏",
                goal: "使用上传素材做小屏产品展示",
                requirements: [],
                constraints: ["480x360"],
                open_questions: ["优先突出什么？"],
                decisions: [],
                build_prompt: "",
              },
            }),
          },
        }],
      }),
    };
  });

  const systemPrompt = requestBody.messages[0].content;
  assert(systemPrompt.includes("Codex 硬件嵌入式设计模式"), "planner prompt should include Codex hardware mode");
  assert(systemPrompt.includes("不能引导用户做通用桌面自动化"), "planner prompt should include Codex boundary");
  assert(systemPrompt.includes("Uploaded asset library"), "planner prompt should include uploaded asset context");
  assert(systemPrompt.includes("hero.png"), "planner prompt should include asset names");
});

await test("chat planner recovers truncated build_ready JSON when build prompt is complete", async () => {
  const { parseChatPlan } = await import(pathToFileURL(path.join(ROOT, "src", "chatPlanner.mjs")).href);
  const longPrompt = [
    "Build a pure frontend village simulation for a 480x360 display.",
    "Use a 45-degree isometric view with road grids and houses upgrading to 4 floors.",
    "Add day-night cycle, weather changes, and a Day 1 08:00 style time label.",
  ].join("\n");
  const truncated = `{
    "intent": "build_ready",
    "reply": "I understand the village simulation and will build it.",
    "understanding": ["45-degree village", "day-night weather", "Canvas only"],
    "planned_changes": ["draw Canvas scene", "implement weather particles"],
    "target": "new_project",
    "ready_to_build": true,
    "build_prompt": ${JSON.stringify(longPrompt)},
    "project_memory": {
      "summary": "truncated after this point`;

  const plan = parseChatPlan(truncated, { goal: "old goal" });
  assert(plan.intent === "build_ready", `expected recovered build_ready, got ${JSON.stringify(plan)}`);
  assert(plan.ready_to_build === true, "recovered plan should be build ready");
  assert(plan.build_prompt.includes("village simulation"), "recovered plan should preserve build prompt");
  assert(plan.understanding.includes("45-degree village"), "recovered plan should preserve understanding");
});

await test("chat planner preserves understanding and planned changes for confirmation UI", async () => {
  const { parseChatPlan } = await import(pathToFileURL(path.join(ROOT, "src", "chatPlanner.mjs")).href);
  const plan = parseChatPlan(JSON.stringify({
    intent: "build_ready",
    reply: "我理解你要把当前天气面板改成白底蓝字，我准备调整布局和样式。确认后我会修改当前项目。",
    understanding: ["用户不满意当前视觉效果", "当前项目要改成白底蓝字的天气面板"],
    planned_changes: ["修改 CSS 色彩系统", "保留天气数据逻辑并调整布局"],
    target: "edit_current_project",
    ready_to_build: true,
    build_prompt: "修改当前天气面板：白底蓝字，保留天气数据逻辑，调整布局。",
    project_memory: {
      summary: "修改天气面板视觉",
      goal: "把当前天气面板改成白底蓝字",
      requirements: ["白底蓝字", "保留天气数据逻辑"],
      constraints: ["480x360"],
      open_questions: [],
      decisions: ["修改当前项目而不是新建"],
      build_prompt: "修改当前天气面板：白底蓝字，保留天气数据逻辑，调整布局。",
    },
  }));

  assert(plan.ready_to_build === true, `expected ready plan, got ${JSON.stringify(plan)}`);
  assert(plan.target === "edit_current_project", "planner should preserve edit target");
  assert(plan.understanding.length === 2, "planner should return understanding list");
  assert(plan.planned_changes.includes("修改 CSS 色彩系统"), "planner should return concrete planned changes");
});

await test("chat planner preserves project memory on non-json reply", async () => {
  const { parseChatPlan } = await import(pathToFileURL(path.join(ROOT, "src", "chatPlanner.mjs")).href);
  const plan = parseChatPlan("我可以先帮你梳理需求。", {
    summary: "天气面板讨论中",
    goal: "做天气面板",
    requirements: ["显示温度"],
  });

  assert(plan.intent === "chat", `expected chat fallback, got ${JSON.stringify(plan)}`);
  assert(plan.ready_to_build === false, "non-json reply must not trigger build");
  assert(plan.project_memory.goal === "做天气面板", "non-json reply should preserve existing project memory");
  assert(plan.project_memory.requirements.includes("显示温度"), "non-json reply should preserve existing requirements");
});

await test("chat planner switches project memory when user replaces the goal", async () => {
  const { planChatWithModel, parseChatPlan } = await import(pathToFileURL(path.join(ROOT, "src", "chatPlanner.mjs")).href);
  const oldMemory = {
    summary: "用户原本想做全屏时钟",
    goal: "做全屏时钟",
    requirements: ["显示 HH:mm:ss", "显示日期"],
    constraints: ["480x360 小屏"],
    decisions: ["全屏时钟布局"],
    build_prompt: "生成一个 480x360 全屏时钟，显示当前时间和日期。",
  };

  const downgraded = parseChatPlan(JSON.stringify({
    intent: "build_ready",
    reply: "已切换到天气面板方向，我先确认数据来源和城市。",
    ready_to_build: true,
    build_prompt: "",
    project_memory: {
      summary: "用户改为做天气面板",
      goal: "做天气面板",
      requirements: ["显示温度", "显示天气状态"],
      constraints: ["480x360 小屏"],
      open_questions: ["城市使用定位还是手动配置？"],
      decisions: ["放弃全屏时钟方向"],
      build_prompt: "",
    },
  }), oldMemory);

  assert(downgraded.ready_to_build === false, "old build_prompt must not authorize a new build");
  assert(downgraded.intent === "clarify", `expected clarify after goal switch, got ${JSON.stringify(downgraded)}`);
  assert(downgraded.build_prompt === "", "build_prompt should stay empty until the new goal is confirmed");
  assert(downgraded.project_memory.goal === "做天气面板", "project memory should switch to the new goal");
  assert(!downgraded.project_memory.requirements.includes("显示 HH:mm:ss"), "old requirements should not remain after replacement");

  let requestBody = null;
  await planChatWithModel({
    baseUrl: "http://planner.test",
    apiKey: "test-key",
    model: "mock-planner",
  }, [
    { role: "user", content: "做一个全屏时钟" },
    { role: "assistant", content: "我整理好了时钟方案。" },
    { role: "user", content: "不做时钟了，改做天气面板，先别构建" },
  ], {}, oldMemory, async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              intent: "clarify",
              reply: "可以，已切换到天气面板。还需要确认城市和天气数据来源。",
              ready_to_build: false,
              build_prompt: "",
              project_memory: {
                summary: "用户改为做天气面板",
                goal: "做天气面板",
                requirements: ["显示温度", "显示天气状态"],
                constraints: ["480x360 小屏"],
                open_questions: ["城市使用定位还是手动配置？", "天气数据来源用哪个接口？"],
                decisions: ["放弃全屏时钟方向"],
                build_prompt: "",
              },
            }),
          },
        }],
      }),
    };
  });

  assert(requestBody.messages[0].content.includes("不做 1，改做 2"), "planner prompt should include explicit replacement rule");
  assert(requestBody.messages[0].content.includes("不要因为旧记忆里有 build_prompt 就返回 build_ready"), "planner prompt should forbid old build_prompt reuse");
});

await test("build graph runs template path and returns trace", async () => {
  const { runBuildGraph } = await import(pathToFileURL(path.join(ROOT, "src", "buildGraph.mjs")).href);
  const result = await runBuildGraph({
    prompt: "offline graph test",
    settings: { enabled: false },
    conversationId: "project-a",
    isEditing: false,
  }, {
    templateGenerate: async () => ({
      ok: true,
      id: "build-a",
      files: { "index.html": "<html></html>" },
      source: "template",
      agentActions: [],
    }),
    saveSnapshot: async state => {
      state.snapshotSaved = state.result.id === "build-a";
    },
  });

  const nodes = result.buildGraph.map(item => item.node);
  assert(result.ok === true, `expected ok result, got ${JSON.stringify(result)}`);
  assert(result.id === "build-a", "build graph should preserve template result");
  assert(nodes.includes("prepare"), "build graph should include prepare node");
  assert(nodes.includes("template_generate"), "build graph should include template node");
  assert(nodes.includes("save_snapshot"), "build graph should include snapshot node");
});

await test("generate runtime runs template path and saves snapshot", async () => {
  const { createGenerateRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "generateRuntime.mjs")).href);
  let savedSnapshot = null;
  const runtime = createGenerateRuntime({
    conversationStore: {
      getProjectMemory: id => {
        assert(id === "conv-runtime-template", "runtime should load project memory by conversation id");
        return { goal: "make a quiet status panel", requirements: ["show status"] };
      },
      loadConversationFiles: id => {
        assert(id === "conv-runtime-template", "runtime should load conversation files by conversation id");
        return { files: {} };
      },
      saveConversationFiles: (conversationId, buildId, files) => {
        savedSnapshot = { conversationId, buildId, files };
      },
    },
    memoryStore: {
      getAll: () => ({ palette: "high contrast" }),
      set: () => {},
    },
    writeGenerated: async (prompt, modelSettings, history) => ({
      ok: true,
      id: "vb-runtime-template",
      files: { "index.html": "<html></html>" },
      manifest: { id: "vb-runtime-template" },
      agentRun: { spec: { prompt }, evidence: [{ phase: "code", ok: true, summary: "template ok" }] },
      buildEvidence: { ok: true, issues: [] },
      intelligenceSummary: { confidence: "local_verified", nextBestAction: "deploy_to_board" },
      modelSettings,
      history,
    }),
    filesWithHardwareResult: async files => ({ ...files, [HARDWARE_RESULT_FILE]: "{\"ok\":true}" }),
  });

  const result = await runtime.runGenerateRequest({
    prompt: "Build a small device panel.",
    conversation_id: "conv-runtime-template",
    modelSettings: { enabled: false },
  });

  const nodes = result.buildGraph.map(item => item.node);
  assert(result.ok === true, `expected runtime ok, got ${JSON.stringify(result)}`);
  assert(result.id === "vb-runtime-template", "template build id should pass through");
  assert(result.source === "template", "runtime should use template path when model settings are disabled");
  assert(result.intelligenceSummary?.confidence === "local_verified", "runtime should return template build intelligence summary");
  assert(nodes.includes("template_generate"), "runtime graph should include template node");
  assert(nodes.includes("save_snapshot"), "runtime graph should include save snapshot node");
  assert(savedSnapshot?.conversationId === "conv-runtime-template", "runtime should save conversation snapshot");
  assert(savedSnapshot?.files?.[HARDWARE_RESULT_FILE], "snapshot should include hardware result file");
});

await test("generate runtime rejects overlapping generation requests with actionable error", async () => {
  const { createGenerateRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "generateRuntime.mjs")).href);
  let releaseFirst;
  const firstStarted = new Promise(resolve => {
    releaseFirst = resolve;
  });
  let allowFirstToFinish;
  const firstCanFinish = new Promise(resolve => {
    allowFirstToFinish = resolve;
  });
  const runtime = createGenerateRuntime({
    conversationStore: {
      getProjectMemory: () => ({}),
      loadConversationFiles: () => ({ files: {} }),
      saveConversationFiles: () => {},
    },
    memoryStore: {
      getAll: () => ({}),
      set: () => {},
    },
    appendServerLog: async () => {},
    writeGenerated: async () => {
      releaseFirst();
      await firstCanFinish;
      return {
        ok: true,
        id: "vb-runtime-lock",
        files: { "index.html": "<html></html>" },
        manifest: { id: "vb-runtime-lock" },
        agentRun: { spec: {}, evidence: [] },
        buildEvidence: { ok: true, issues: [] },
        intelligenceSummary: { confidence: "local_verified" },
      };
    },
    filesWithHardwareResult: async files => ({ ...files, [HARDWARE_RESULT_FILE]: "{\"ok\":true}" }),
  });

  const first = runtime.runGenerateRequest({
    prompt: "first long running task",
    modelSettings: { enabled: false },
  });
  await firstStarted;

  let overlapError = null;
  try {
    await runtime.runGenerateRequest({
      prompt: "second task while first is active",
      modelSettings: { enabled: false },
    });
  } catch (error) {
    overlapError = error;
  } finally {
    allowFirstToFinish();
  }
  const firstResult = await first;

  assert(firstResult.ok === true, "first generation should finish after the lock is released");
  assert(overlapError?.errorType === "generate_busy", `expected generate_busy, got ${overlapError?.message} ${JSON.stringify(overlapError)}`);
  assert(overlapError?.statusCode === 409, "overlapping generation should be reported as HTTP 409");
  assert(overlapError?.userMessage?.includes("当前已经有一个生成任务"), "busy error should be user-actionable");
});

await test("generate runtime embeds uploaded passive assets into template builds", async () => {
  const { createGenerateRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "generateRuntime.mjs")).href);
  const embeddedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let savedSnapshot = null;
  let receivedPrompt = "";
  let receivedEmbeddedAssets = null;
  const runtime = createGenerateRuntime({
    conversationStore: {
      getProjectMemory: () => ({ goal: "use uploaded hero image" }),
      loadConversationFiles: () => ({ files: {} }),
      saveConversationFiles: (conversationId, buildId, files) => {
        savedSnapshot = { conversationId, buildId, files };
      },
    },
    memoryStore: {
      getAll: () => ({}),
      set: () => {},
    },
    assetLibraryStore: {
      promptContext: () => "\n\n## Uploaded asset library\n- hero.png (image): product photo",
      generatedAssets: () => ({
        files: {
          "assets/uploaded/hero.png": embeddedPng,
        },
        items: [{
          name: "hero.png",
          kind: "image",
          size: embeddedPng.byteLength,
          path: "assets/uploaded/hero.png",
          use: "product hero image",
        }],
        manifestAssets: ["assets/uploaded/hero.png"],
        rejected: [{ name: "component.html", error: "component remains a design reference only" }],
        summary: { count: 1, totalBytes: embeddedPng.byteLength },
      }),
    },
    appendServerLog: async () => {},
    writeGenerated: async (prompt, modelSettings, history, embeddedAssets) => {
      receivedPrompt = prompt;
      receivedEmbeddedAssets = embeddedAssets;
      return {
        ok: true,
        id: "vb-runtime-assets",
        files: validGeneratedFiles(),
        manifest: JSON.parse(validGeneratedFiles()["manifest.json"]),
        agentRun: { spec: { prompt }, evidence: [{ phase: "code", ok: true, summary: "template ok" }] },
        buildEvidence: { ok: true, issues: [] },
        intelligenceSummary: { confidence: "local_verified", nextBestAction: "deploy_to_board" },
        modelSettings,
        history,
      };
    },
    filesWithHardwareResult: async files => ({ ...files, [HARDWARE_RESULT_FILE]: "{\"ok\":true}" }),
  });

  const result = await runtime.runGenerateRequest({
    prompt: "Build a product display with my uploaded hero image.",
    conversation_id: "conv-runtime-assets",
    modelSettings: { enabled: false },
  });
  const manifest = JSON.parse(result.files["manifest.json"]);

  assert(result.ok === true, `expected runtime ok, got ${JSON.stringify(result)}`);
  assert(receivedPrompt.includes("Embedded uploaded assets"), "model prompt should expose embedded asset paths");
  assert(receivedPrompt.includes("./assets/uploaded/hero.png"), "model prompt should include the generated asset path");
  assert(receivedEmbeddedAssets?.items?.[0]?.path === "assets/uploaded/hero.png", "template generator should receive embedded asset metadata");
  assert(Buffer.isBuffer(result.files["assets/uploaded/hero.png"]), "runtime result should include embedded binary asset");
  assert(result.files["assets/uploaded/hero.png"].equals(embeddedPng), "embedded asset bytes should be preserved");
  assert(manifest.assets.includes("assets/uploaded/hero.png"), "manifest assets[] should declare embedded asset");
  assert(manifest.files.includes("assets/uploaded/hero.png"), "manifest files[] should include embedded asset");
  assert(savedSnapshot?.files?.["assets/uploaded/hero.png"], "conversation snapshot should save embedded asset");
});

await test("generate runtime fails when conversation snapshot save fails", async () => {
  const { createGenerateRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "generateRuntime.mjs")).href);
  const logs = [];
  const runtime = createGenerateRuntime({
    conversationStore: {
      getProjectMemory: async () => ({}),
      loadConversationFiles: async () => ({ files: {} }),
      saveConversationFiles: async () => {
        const error = new Error("durable project save failed");
        error.errorType = "storage_failed";
        throw error;
      },
    },
    memoryStore: { getAll: () => ({}) },
    assetLibraryStore: {
      promptContext: () => "",
      generatedAssets: () => ({ items: [], files: {}, rejected: [] }),
      recordBuildSnapshot: () => {},
    },
    appendServerLog: async (event, data) => logs.push({ event, data }),
    normalizeGenerateHistory: history => history,
    compressHistory: async history => history,
    buildId: () => "build-save-fails",
    writeGenerated: async () => ({
      id: "build-save-fails",
      files: validGeneratedFiles(),
      manifest: JSON.parse(validGeneratedFiles()["manifest.json"]),
      buildEvidence: { ok: true, issues: [] },
      agentRun: {},
    }),
    filesWithHardwareResult: async files => files,
    projectWorkspace: {
      writeBuildSnapshot: async () => {},
      writeMemory: async () => {},
      listProjectFiles: async () => [],
    },
  });

  let failed = false;
  try {
    await runtime.runGenerateRequest({
      prompt: "Build a clock",
      conversation_id: "conv-save-fails",
      modelSettings: { enabled: false },
    });
  } catch (error) {
    failed = error.errorType === "storage_failed" || /save failed/i.test(error.message);
  }

  assert(failed, "generation should fail when durable conversation file save fails");
  assert(logs.some(item => /conversation_save_failed/.test(item.event)), "runtime should log conversation save failure");
});

await test("generate runtime passes conversation files into agent path", async () => {
  const { createGenerateRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "generateRuntime.mjs")).href);
  await withTempDir("vibeboard-runtime-agent-", async dir => {
    let receivedFiles = null;
    let receivedPrompt = "";
    let currentBuild = null;
    const embeddedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const runtime = createGenerateRuntime({
      conversationStore: {
        getProjectMemory: () => ({ goal: "edit existing screen" }),
        loadConversationFiles: () => ({
          files: {
            "index.html": "<html><script src=\"./app.js\"></script></html>",
            "style.css": "body{}",
            "app.js": "console.log('old')",
          },
        }),
        saveConversationFiles: () => {},
      },
      memoryStore: {
        getAll: () => ({}),
        set: () => {},
      },
      assetLibraryStore: {
        promptContext: () => "\n\n## Uploaded asset library\n- agent-hero.png (image): product image",
        generatedAssets: () => ({
          files: {
            "assets/uploaded/agent-hero.png": embeddedPng,
          },
          items: [{
            name: "agent-hero.png",
            kind: "image",
            size: embeddedPng.byteLength,
            path: "assets/uploaded/agent-hero.png",
            use: "agent product image",
          }],
          manifestAssets: ["assets/uploaded/agent-hero.png"],
          rejected: [],
          summary: { count: 1, totalBytes: embeddedPng.byteLength },
        }),
      },
      runAgent: async (_settings, prompt, fileStore) => {
        receivedPrompt = prompt;
        receivedFiles = { ...fileStore };
        return {
          success: true,
          summary: "agent edited files",
          files: {
            "index.html": "<html><script src=\"./app.js\"></script></html>",
            "style.css": "body{}",
            "app.js": "console.log('new')",
          },
          actions: [],
        };
      },
      buildId: () => "vb-runtime-agent",
      createAppSpec: (prompt, id) => ({ prompt, id, target: "test-target" }),
      generatedHardwareApp: (_prompt, id) => `print({"build_id": "${id}"})`,
      injectHardwareAppContracts: source => source,
      generatedManifest: (_prompt, id) => ({ id, files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
      buildCurrent: async () => {
        currentBuild.built = true;
        currentBuild.buildEvidence = { ok: true, issues: [], phase: "local_verify" };
        currentBuild.intelligenceSummary = { confidence: "local_verified", nextBestAction: "deploy_to_board" };
      },
      setCurrentBuild: build => {
        currentBuild = build;
        return currentBuild;
      },
      getCurrentBuild: () => currentBuild,
      generatedDir: dir,
      filesWithHardwareResult: async files => files,
    });

    const result = await runtime.runGenerateRequest({
      prompt: "Change the existing screen.",
      conversation_id: "conv-runtime-agent",
      modelSettings: {
        provider: "custom",
        baseUrl: "http://mock.local",
        model: "mock",
        apiKey: "key",
      },
    });

    assert(result.ok === true, `expected agent runtime ok, got ${JSON.stringify(result)}`);
    assert(result.source === "agent", "enabled model settings should use agent path");
    assert(result.intelligenceSummary?.confidence === "local_verified", "runtime should return agent build intelligence summary");
    assert(receivedPrompt.includes("./assets/uploaded/agent-hero.png"), "agent prompt should expose embedded asset paths");
    assert(receivedFiles?.["app.js"] === "console.log('old')", "agent should receive saved conversation files");
    assert(Buffer.isBuffer(result.files["assets/uploaded/agent-hero.png"]), "agent result should include embedded passive asset");
    assert(result.files["assets/uploaded/agent-hero.png"].equals(embeddedPng), "agent embedded asset bytes should be preserved");
    const manifest = JSON.parse(result.files["manifest.json"]);
    assert(manifest.assets.includes("assets/uploaded/agent-hero.png"), "agent manifest should declare embedded asset");
    assert(result.buildGraph.some(item => item.node === "agent_generate" && item.status === "done"), "runtime graph should include completed agent node");
  });
});

await test("generate runtime auto-repairs local verification failures before returning to user", async () => {
  const { createGenerateRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "generateRuntime.mjs")).href);
  await withTempDir("vibeboard-runtime-repair-", async dir => {
    let runAgentCalls = 0;
    let buildCalls = 0;
    let currentBuild = null;
    const logs = [];
    const runtime = createGenerateRuntime({
      conversationStore: {
        getProjectMemory: () => ({}),
        loadConversationFiles: () => ({ files: {} }),
        saveConversationFiles: () => {},
      },
      memoryStore: {
        getAll: () => ({}),
        set: () => {},
      },
      appendServerLog: async (event, detail) => logs.push({ event, detail }),
      runAgent: async (_settings, prompt) => {
        runAgentCalls += 1;
        if (runAgentCalls === 1) {
          return {
            success: true,
            summary: "initial broken files",
            files: {
              "index.html": "<html><script src=\"./app.js\"></script></html>",
              "style.css": "body{}",
              "app.js": "console.log('broken')",
              "hardware_app.py": "print('broken')",
            },
            actions: [{ tool: "done", args: { summary: "initial" } }],
          };
        }
        assert(prompt.includes("部署前 L0-L3 本地验证失败"), "repair prompt should include local verification failure framing");
        assert(prompt.includes("local verification failed"), "repair prompt should include build failure evidence");
        assert(prompt.includes("TEXT_CONTRAST_LOW"), "repair prompt should include hardware verification issue codes");
        assert(prompt.includes("Raise text/background contrast"), "repair prompt should include verifier suggested fixes");
        assert(prompt.includes("contrast 1.8:1"), "repair prompt should include sampled failing text evidence");
        return {
          success: true,
          summary: "repair applied",
          files: validGeneratedFiles(),
          actions: [{ tool: "edit_file", args: { path: "app.js", summary: "fixed" } }],
        };
      },
      buildId: () => "vb-runtime-repair",
      createAppSpec: (prompt, id) => ({ prompt, id }),
      generatedHardwareApp: (_prompt, id) => validGeneratedFiles()["hardware_app.py"].replace("vb-test-valid", id),
      injectHardwareAppContracts: source => source,
      generatedManifest: (_prompt, id) => ({ id, files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
      buildCurrent: async () => {
        buildCalls += 1;
        if (buildCalls === 1) {
          const error = new Error("local verification failed: TEXT_CONTRAST_LOW: Rendered page has 1 visible text block below 3:1 contrast.");
          error.verification = {
            ok: false,
            phase: "local_verification",
            summary: "Local render verification failed",
            issues: [{
              code: "TEXT_CONTRAST_LOW",
              message: "Rendered page has 1 visible text block below 3:1 contrast.",
              phase: "render",
              suggestedFixes: ["Raise text/background contrast to at least 3:1 on the 480x360 hardware screen."],
              evidence: {
                samples: [{
                  tag: "span",
                  id: "service",
                  text: "mock",
                  fontSize: 11,
                  contrastRatio: 1.8,
                }],
              },
            }],
          };
          throw error;
        }
        currentBuild.built = true;
        currentBuild.buildEvidence = { ok: true, issues: [], phase: "local_verify", summary: "L0-L3 local verification passed" };
        currentBuild.intelligenceSummary = { confidence: "local_verified", nextBestAction: "deploy_to_board" };
      },
      setCurrentBuild: build => {
        currentBuild = build;
      },
      getCurrentBuild: () => currentBuild,
      generatedDir: dir,
      filesWithHardwareResult: async files => files,
    });

    const result = await runtime.runGenerateRequest({
      prompt: "Build a screen that needs repair.",
      modelSettings: {
        provider: "custom",
        baseUrl: "http://mock.local",
        model: "mock",
        apiKey: "key",
      },
    });

    assert(result.ok === true, `expected repaired generation to pass, got ${JSON.stringify(result)}`);
    assert(runAgentCalls === 2, `expected initial agent plus repair agent, got ${runAgentCalls}`);
    assert(buildCalls === 2, `expected build to run before and after repair, got ${buildCalls}`);
    assert(result.repairAttempts === 1, `expected one repair attempt, got ${result.repairAttempts}`);
    assert(result.repairSummary.includes("自动修复 1 轮"), `expected repair summary, got ${result.repairSummary}`);
    assert(result.buildEvidence?.ok === true, "repaired result should include passing build evidence");
    assert(logs.some(item => item.event === "generate.agent.auto_repair.start"), "repair start should be logged");
    assert(logs.some(item => item.event === "generate.agent.auto_repair.done"), "repair completion should be logged");
  });
});

await test("generate runtime surfaces user-actionable repair model failures", async () => {
  const { createGenerateRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "generateRuntime.mjs")).href);
  await withTempDir("vibeboard-runtime-repair-auth-", async dir => {
    let runAgentCalls = 0;
    let currentBuild = null;
    const runtime = createGenerateRuntime({
      conversationStore: {
        getProjectMemory: () => ({}),
        loadConversationFiles: () => ({ files: {} }),
        saveConversationFiles: () => {},
      },
      memoryStore: {
        getAll: () => ({}),
        set: () => {},
      },
      runAgent: async () => {
        runAgentCalls += 1;
        if (runAgentCalls === 1) {
          return {
            success: true,
            summary: "initial files",
            files: validGeneratedFiles(),
            actions: [],
          };
        }
        return {
          success: false,
          summary: "LLM auth failed during repair",
          error: {
            type: "llm_auth",
            code: "LLM_CALL_FAILED",
            status: 401,
            message: "LLM_CALL_FAILED: HTTP 401; provider=invalid api key",
          },
          actions: [],
          files: validGeneratedFiles(),
        };
      },
      buildId: () => "vb-runtime-repair-auth",
      createAppSpec: (prompt, id) => ({ prompt, id }),
      generatedHardwareApp: (_prompt, id) => validGeneratedFiles()["hardware_app.py"].replace("vb-test-valid", id),
      injectHardwareAppContracts: source => source,
      generatedManifest: (_prompt, id) => ({ id, files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
      buildCurrent: async () => {
        throw new Error("local verification failed: LAYOUT_OVERFLOW: screen overflows 480x360");
      },
      setCurrentBuild: build => {
        currentBuild = build;
      },
      getCurrentBuild: () => currentBuild,
      generatedDir: dir,
      filesWithHardwareResult: async files => files,
    });

    let error = null;
    try {
      await runtime.runGenerateRequest({
        prompt: "Build should fail then repair model auth should ask user.",
        modelSettings: {
          provider: "custom",
          baseUrl: "http://mock.local",
          model: "mock",
          apiKey: "bad-key",
        },
      });
    } catch (err) {
      error = err;
    }

    assert(error, "expected repair auth failure to throw");
    assert(error.errorType === "llm_auth", `expected llm_auth, got ${error?.errorType}: ${error?.message}`);
    assert(error.userMessage?.includes("API Key"), "repair auth failure should be user-actionable");
    assert(runAgentCalls === 2, `expected initial generation plus repair attempt, got ${runAgentCalls}`);
  });
});

await test("generate runtime allows disabling auto repair with zero attempts", async () => {
  const { buildGenerateAgentSettings } = await import(pathToFileURL(path.join(ROOT, "src", "generateRuntime.mjs")).href);
  const settings = buildGenerateAgentSettings({}, { VIBEBOARD_AGENT_REPAIR_ATTEMPTS: "0" });
  assert(settings.repairAttempts === 0, `expected zero repair attempts, got ${settings.repairAttempts}`);
});

await test("generate runtime honors request-bound cloud agent limits", async () => {
  const { buildGenerateAgentSettings } = await import(pathToFileURL(path.join(ROOT, "src", "generateRuntime.mjs")).href);
  const settings = buildGenerateAgentSettings({
    max_iterations: 3,
    max_verification_attempts: 0,
    repair_attempts: 0,
    timeout_ms: 45000,
    llm_timeout_ms: 12000,
  }, {
    VIBEBOARD_AGENT_MAX_ITERATIONS: "18",
    VIBEBOARD_AGENT_MAX_VERIFICATION_ATTEMPTS: "2",
    VIBEBOARD_AGENT_REPAIR_ATTEMPTS: "2",
    VIBEBOARD_AGENT_TIMEOUT_MS: "120000",
    VIBEBOARD_AGENT_LLM_TIMEOUT_MS: "60000",
  });
  assert(settings.maxIterations === 3, `request max_iterations should override env default, got ${settings.maxIterations}`);
  assert(settings.maxVerificationAttempts === 0, `request max_verification_attempts=0 should be preserved, got ${settings.maxVerificationAttempts}`);
  assert(settings.repairAttempts === 0, `request repair_attempts=0 should be preserved, got ${settings.repairAttempts}`);
  assert(settings.timeoutMs === 45000, `request timeout_ms should override env default, got ${settings.timeoutMs}`);
  assert(settings.llmTimeoutMs === 12000, `request llm_timeout_ms should override env default, got ${settings.llmTimeoutMs}`);
});

await test("agent graph keeps chat behind confirmation gate", async () => {
  const { runAgentGraph } = await import(pathToFileURL(path.join(ROOT, "src", "agentGraph.mjs")).href);
  let buildCalled = false;
  const result = await runAgentGraph({
    action: "message",
    messages: [{ role: "user", content: "你能做什么？" }],
    projectMemory: { summary: "old clock", build_prompt: "Build an old clock." },
  }, {
    planMessage: async () => ({
      intent: "chat",
      reply: "我可以先帮你梳理需求，确认后再构建。",
      target: "chat",
      ready_to_build: false,
      build_prompt: "",
      project_memory: {
        summary: "用户在询问能力范围",
        goal: "",
        requirements: [],
        constraints: [],
        open_questions: ["还没有具体应用需求"],
        decisions: [],
        build_prompt: "",
      },
    }),
    build: async () => {
      buildCalled = true;
      return { ok: true };
    },
  });

  assert(result.ok === true, `expected ok chat result, got ${JSON.stringify(result)}`);
  assert(result.mode === "chat", "capability question should stay chat mode");
  assert(result.ready_to_build === false, "chat should not be ready to build");
  assert(buildCalled === false, "chat path must not call build node");
  assert(result.agentGraph.some(item => item.node === "confirm_gate" && item.status === "blocked"), "agent graph should record blocked confirmation gate");
});

await test("agent graph confirm action runs build graph and returns build result", async () => {
  const { runAgentGraph } = await import(pathToFileURL(path.join(ROOT, "src", "agentGraph.mjs")).href);
  let receivedPrompt = "";
  const result = await runAgentGraph({
    action: "confirm_build",
    buildPrompt: "Build a cyberpunk clock.",
    projectMemory: { build_prompt: "Build a stale weather panel." },
  }, {
    build: async (_state, prompt) => {
      receivedPrompt = prompt;
      return {
        ok: true,
        id: "vb-agent-graph-test",
        files: { "index.html": "<html></html>" },
        source: "template",
        buildEvidence: { ok: true, issues: [] },
      };
    },
  });

  assert(result.ok === true, `expected build ok, got ${JSON.stringify(result)}`);
  assert(result.mode === "build_done", "confirm action should return build_done");
  assert(result.id === "vb-agent-graph-test", "build result should pass through");
  assert(receivedPrompt === "Build a cyberpunk clock.", "explicit confirmed prompt should win over stale memory");
  assert(result.agentGraph.some(item => item.node === "build_graph" && item.status === "done"), "agent graph should include build_graph node");
});

await test("agent orchestrator routes confirmed build through generator", async () => {
  const { createAgentOrchestrator } = await import(pathToFileURL(path.join(ROOT, "src", "agentOrchestrator.mjs")).href);
  let receivedBody = null;
  const conversationMemory = { build_prompt: "Build old stale app." };
  const orchestrator = createAgentOrchestrator({
    conversationStore: {
      getProjectMemory: id => {
        assert(id === "conv-agent-orchestrator", "conversation id should be passed to memory store");
        return conversationMemory;
      },
      setProjectMemory: () => {
        throw new Error("confirm build should not update planner memory");
      },
    },
    memoryStore: {
      getAll: () => ({}),
    },
    recordAgentLearning: () => null,
    runGenerateRequest: async body => {
      receivedBody = body;
      return {
        ok: true,
        id: "vb-orchestrator-test",
        files: { "index.html": "<html></html>" },
        source: "agent",
        buildEvidence: { ok: true, issues: [] },
      };
    },
  });

  const result = await orchestrator.runAgentRequest({
    action: "confirm_build",
    conversation_id: "conv-agent-orchestrator",
    build_prompt: "Build the confirmed village simulator.",
    modelSettings: { enabled: false },
    history: [{ role: "user", content: "confirmed" }],
  });

  assert(result.ok === true, `expected ok result, got ${JSON.stringify(result)}`);
  assert(result.mode === "build_done", "confirm_build should return build_done mode");
  assert(result.id === "vb-orchestrator-test", "build result id should pass through");
  assert(receivedBody?.prompt === "Build the confirmed village simulator.", "confirmed prompt should reach generator");
  assert(receivedBody?.conversation_id === "conv-agent-orchestrator", "conversation id should reach generator");
  assert(Array.isArray(receivedBody?.history) && receivedBody.history.length === 1, "history should reach generator");
});

await test("agent orchestrator returns choice-based guidance when model is missing", async () => {
  const { createAgentOrchestrator } = await import(pathToFileURL(path.join(ROOT, "src", "agentOrchestrator.mjs")).href);
  const orchestrator = createAgentOrchestrator({
    conversationStore: {
      getProjectMemory: () => ({}),
      setProjectMemory: () => {},
    },
    memoryStore: {
      getAll: () => ({}),
    },
    runGenerateRequest: async () => ({ ok: true }),
  });

  const result = await orchestrator.runAgentRequest({
    action: "message",
    modelSettings: { enabled: false },
    messages: [{ role: "user", content: "帮我生成一个天气小屏" }],
  });

  assert(result.ok === true, `expected ok response, got ${JSON.stringify(result)}`);
  assert(result.ready_to_build === false, "missing model should not auto-build from chat message");
  assert(result.reply.includes("没有配置可用的 AI 模型"), `missing model reply should be localized, got ${result.reply}`);
  assert(Array.isArray(result.quick_replies) && result.quick_replies.length >= 2, "missing model should offer quick reply choices");
  assert(result.quick_replies.some(item => item.label.includes("本地生成")), "missing model should offer local template generation choice");
});

await test("agent orchestrator exposes Codex hardware mode boundary", async () => {
  const { createAgentOrchestrator } = await import(pathToFileURL(path.join(ROOT, "src", "agentOrchestrator.mjs")).href);
  let plannerRequest = null;
  const orchestrator = createAgentOrchestrator({
    conversationStore: {
      getProjectMemory: () => ({ summary: "codex test" }),
      setProjectMemory: () => {},
    },
    memoryStore: {
      getAll: () => ({}),
    },
    runGenerateRequest: async () => ({ ok: true }),
    fetchImpl: async (_url, options = {}) => {
      plannerRequest = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                intent: "clarify",
                reply: "先确认展示重点。",
                ready_to_build: false,
                build_prompt: "",
                quick_replies: [{ label: "主视觉", value: "优先主视觉。" }],
                project_memory: {
                  summary: "codex test",
                  goal: "",
                  requirements: [],
                  constraints: [],
                  open_questions: [],
                  decisions: [],
                  build_prompt: "",
                },
              }),
            },
          }],
        }),
      };
    },
  });

  const result = await orchestrator.runAgentRequest({
    action: "message",
    agent_mode: "codex",
    modelSettings: {
      provider: "custom",
      baseUrl: "http://planner.test",
      apiKey: "test-key",
      model: "mock-planner",
    },
    messages: [{ role: "user", content: "用 Codex 做小屏" }],
  });

  assert(result.agent_mode === "codex", `expected codex mode, got ${JSON.stringify(result)}`);
  assert(result.mode_boundary?.scope?.includes("480x360"), "Codex boundary should mention hardware screen scope");
  assert(result.mode_boundary?.disallowed?.some(item => item.includes("general desktop automation")), "Codex boundary should disallow unrelated automation");
  assert(result.codex_bridge?.name === "codex-hardware-agent", `Codex bridge metadata should be returned, got ${JSON.stringify(result.codex_bridge)}`);
  assert(result.codex_bridge?.allowed_operations?.some(item => item.includes("local verification")), "Codex bridge should expose allowed hardware operations");
  const systemPrompt = plannerRequest?.messages?.[0]?.content || "";
  assert(systemPrompt.includes("You are Codex operating inside VibeBoard"), "Codex mode should use Codex hardware bridge system prompt");
  assert(systemPrompt.includes("must not perform"), "Codex prompt should include forbidden operation boundary");
  assert(systemPrompt.includes("Codex hardware bridge metadata"), "Codex prompt should include bridge metadata");
  assert(result.project_memory.constraints.some(item => item.includes("Codex mode is limited")), "Codex project memory should retain hardware constraints");
});

await test("agent orchestrator passes Codex bridge into confirmed builds", async () => {
  const { createAgentOrchestrator } = await import(pathToFileURL(path.join(ROOT, "src", "agentOrchestrator.mjs")).href);
  let receivedBody = null;
  const orchestrator = createAgentOrchestrator({
    conversationStore: {
      getProjectMemory: () => ({ build_prompt: "Build Codex hardware dashboard." }),
      setProjectMemory: () => {},
    },
    memoryStore: {
      getAll: () => ({}),
    },
    runGenerateRequest: async body => {
      receivedBody = body;
      return {
        ok: true,
        id: "vb-codex-bridge-build",
        buildEvidence: { ok: true, issues: [] },
      };
    },
  });

  const result = await orchestrator.runAgentRequest({
    action: "confirm_build",
    agent_mode: "codex",
    conversation_id: "conv-codex-build",
    build_prompt: "Build the Codex hardware dashboard.",
    modelSettings: { enabled: false },
  });

  assert(result.mode === "build_done", `expected build_done, got ${JSON.stringify(result)}`);
  assert(receivedBody?.agent_mode === "codex", "confirmed build should keep codex mode");
  assert(receivedBody?.codex_bridge?.name === "codex-hardware-agent", `confirmed build should receive bridge metadata, got ${JSON.stringify(receivedBody?.codex_bridge)}`);
  assert(receivedBody?.raw_user_prompt === "Build the Codex hardware dashboard.", "confirmed build should preserve raw user prompt");
  assert(receivedBody?.prompt?.includes("Codex hardware execution package"), `confirmed build should receive Codex execution package, got ${receivedBody?.prompt}`);
  assert(receivedBody?.prompt?.includes("Never write to hardware"), "Codex execution package should enforce deploy confirmation");
  assert(receivedBody?.prompt?.includes("Asset Library insights"), "Codex execution package should require asset insight usage");
  assert(result.codex_bridge?.scope?.includes("480x360"), "build result should expose bridge scope");
});

await test("agent orchestrator returns Codex quick choices when model is missing", async () => {
  const { createAgentOrchestrator } = await import(pathToFileURL(path.join(ROOT, "src", "agentOrchestrator.mjs")).href);
  const orchestrator = createAgentOrchestrator({
    conversationStore: {
      getProjectMemory: () => ({ summary: "codex no model" }),
      setProjectMemory: () => {
        throw new Error("missing model plan should not persist memory automatically");
      },
    },
    memoryStore: {
      getAll: () => ({}),
    },
    runGenerateRequest: async () => {
      throw new Error("missing model chat should not build");
    },
  });

  const result = await orchestrator.runAgentRequest({
    action: "message",
    agent_mode: "codex",
    modelSettings: { enabled: false },
    messages: [{ role: "user", content: "用 Codex 做小屏产品展示" }],
  });

  assert(result.intent === "clarify", `expected clarify, got ${JSON.stringify(result)}`);
  assert(result.ready_to_build === false, "missing model path should not be build-ready");
  assert(result.reply.includes("Codex 硬件模式"), "missing model reply should explain Codex hardware mode");
  assert(result.quick_replies.length >= 3, "missing model reply should provide clickable choices");
  assert(result.codex_bridge?.name === "codex-hardware-agent", "missing model reply should still expose Codex bridge");
  assert(result.mode_boundary?.scope?.includes("480x360"), "missing model reply should expose hardware boundary");
});

await test("codex hardware mode redirects unrelated desktop tasks before model call", async () => {
  const { createAgentOrchestrator } = await import(pathToFileURL(path.join(ROOT, "src", "agentOrchestrator.mjs")).href);
  let fetchCalled = false;
  const orchestrator = createAgentOrchestrator({
    conversationStore: {
      getProjectMemory: () => ({ summary: "codex scope test" }),
      setProjectMemory: () => {},
    },
    memoryStore: {
      getAll: () => ({}),
    },
    runGenerateRequest: async () => ({ ok: true }),
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called for out-of-scope Codex tasks");
    },
  });

  const result = await orchestrator.runAgentRequest({
    action: "message",
    agent_mode: "codex",
    modelSettings: {
      provider: "custom",
      baseUrl: "http://planner.test",
      apiKey: "test-key",
      model: "mock-planner",
    },
    messages: [{ role: "user", content: "帮我操作电脑打开浏览器登录账号付款" }],
  });

  assert(fetchCalled === false, "out-of-scope Codex task should be redirected before LLM call");
  assert(result.intent === "clarify", `expected clarify redirect, got ${JSON.stringify(result)}`);
  assert(result.ready_to_build === false, "out-of-scope redirect should not be build-ready");
  assert(result.codex_bridge?.scope_guard?.blocked === true, `scope guard metadata should mark block, got ${JSON.stringify(result.codex_bridge)}`);
  assert(result.reply.includes("VibeBoard") && result.reply.includes("480x360"), "redirect should explain the hardware-only scope");
  assert(result.quick_replies.some(reply => reply.label.includes("小屏")), "redirect should offer hardware quick replies");
});

await test("codex hardware scope classifier requires explicit hardware signals", async () => {
  const { evaluateCodexHardwareScope } = await import(pathToFileURL(path.join(ROOT, "src", "codexHardwareAgent.mjs")).href);
  assert(evaluateCodexHardwareScope([{ role: "user", content: "帮我操作电脑打开浏览器登录账号付款" }]).allowed === false, "Chinese desktop/payment task should be blocked");
  assert(evaluateCodexHardwareScope([{ role: "user", content: "please control my Windows desktop, open browser, login account and make a payment" }]).allowed === false, "English desktop/payment task should be blocked");
  assert(evaluateCodexHardwareScope([{ role: "user", content: "做一个 480x360 小屏天气应用" }]).allowed === true, "explicit small-screen hardware app should be allowed");
  assert(evaluateCodexHardwareScope([{ role: "user", content: "做一个普通应用" }]).allowed === true, "ambiguous normal app should remain discussable");
});

await test("build registry tracks current and conversation builds", async () => {
  const { createBuildRegistry } = await import(pathToFileURL(path.join(ROOT, "src", "buildRegistry.mjs")).href);
  const registry = createBuildRegistry();
  const build = { id: "vb-build-registry-test", conversationId: "conv-build-registry" };

  registry.setCurrentBuild(build);
  assert(registry.currentBuild === build, "registry should expose current build");
  assert(registry.getBuild("vb-build-registry-test") === build, "registry should index build by id");
  assert(registry.getConversationBuild("conv-build-registry") === build, "registry should index build by conversation id");

  const endpoint = { name: "local", host: "127.0.0.1" };
  registry.setActiveEndpoint(endpoint);
  assert(registry.activeEndpoint === endpoint, "registry should track active endpoint");

  const deploy = { id: "vb-build-registry-test", mode: "offline-simulated" };
  registry.setLastDeploy(deploy);
  assert(registry.lastDeploy === deploy, "registry should track last deploy result");
});

await test("agent accepts complete text-only final answer after local verification", async () => {
  const { runAgent } = await import(pathToFileURL(path.join(ROOT, "src", "agent.mjs")).href);
  const files = validGeneratedFiles();
  await withMockChatServer([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        createFileToolCall("call-index", "index.html", files["index.html"]),
        createFileToolCall("call-style", "style.css", files["style.css"]),
        createFileToolCall("call-app", "app.js", files["app.js"]),
        createFileToolCall("call-hardware", "hardware_app.py", files["hardware_app.py"]),
      ],
    },
    {
      role: "assistant",
      content: "完成",
    },
  ], async mock => {
    const result = await runAgent({
      baseUrl: mock.baseUrl,
      apiKey: "test-key",
      model: "mock-tools",
      maxIterations: 4,
      maxVerificationAttempts: 1,
      llmTimeoutMs: 10000,
    }, "做一个全屏时钟", {}, []);

    assert(result.success === true, `expected success, got ${JSON.stringify(result)}`);
    assert(result.files["index.html"] && result.files["style.css"] && result.files["app.js"] && result.files["hardware_app.py"], "expected all runtime files");
    assert(result.whatWorked.includes("所有自动验证通过"), `expected auto verification evidence, got ${JSON.stringify(result.whatWorked)}`);
    assert(result.actions.some(action => action.tool === "verify_syntax"), "expected verify_syntax action");
    assert(result.actions.some(action => action.tool === "verify_render"), "expected verify_render action");
    assert(result.actions.some(action => action.tool === "run_hardware"), "expected run_hardware action");
    assert(mock.calls() === 2, `expected 2 mock model calls, got ${mock.calls()}`);
  });
});

await test("agent accepts complete files when iteration budget ends before done", async () => {
  const { runAgent } = await import(pathToFileURL(path.join(ROOT, "src", "agent.mjs")).href);
  const files = validGeneratedFiles();
  await withMockChatServer([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        createFileToolCall("call-budget-index", "index.html", files["index.html"]),
        createFileToolCall("call-budget-style", "style.css", files["style.css"]),
        createFileToolCall("call-budget-app", "app.js", files["app.js"]),
        createFileToolCall("call-budget-hardware", "hardware_app.py", files["hardware_app.py"]),
      ],
    },
  ], async mock => {
    const result = await runAgent({
      baseUrl: mock.baseUrl,
      apiKey: "test-key",
      model: "mock-tools",
      maxIterations: 1,
      maxVerificationAttempts: 0,
      llmTimeoutMs: 10000,
    }, "make a compact hardware status screen", {}, []);

    assert(result.success === true, `complete files should be accepted at iteration budget: ${JSON.stringify(result)}`);
    assert(result.summary.includes("complete files"), `summary should explain fallback completion, got ${result.summary}`);
    assert(result.files["index.html"] && result.files["style.css"] && result.files["app.js"] && result.files["hardware_app.py"], "expected all runtime files");
    assert(mock.calls() === 1, `expected 1 mock model call, got ${mock.calls()}`);
  });
});

await test("agent degrades hardware Python checks when Python runtime is unavailable", async () => {
  const { runAgent } = await import(pathToFileURL(path.join(ROOT, "src", "agent.mjs")).href);
  const files = validGeneratedFiles();
  const oldPython = process.env.PYTHON;
  process.env.PYTHON = "python-vibeboard-missing-for-test";
  try {
    await withMockChatServer([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          createFileToolCall("call-index-missing-python", "index.html", files["index.html"]),
          createFileToolCall("call-style-missing-python", "style.css", files["style.css"]),
          createFileToolCall("call-app-missing-python", "app.js", files["app.js"]),
          createFileToolCall("call-hardware-missing-python", "hardware_app.py", files["hardware_app.py"]),
        ],
      },
      {
        role: "assistant",
        content: "done",
      },
    ], async mock => {
      const result = await runAgent({
        baseUrl: mock.baseUrl,
        apiKey: "test-key",
        model: "mock-tools",
        maxIterations: 4,
        maxVerificationAttempts: 1,
        llmTimeoutMs: 10000,
      }, "make a status dashboard", {}, []);

      assert(result.success === true, `expected success with degraded Python checks, got ${JSON.stringify(result)}`);
      const syntaxAction = result.actions.find(action => action.tool === "verify_syntax");
      const hardwareAction = result.actions.find(action => action.tool === "run_hardware");
      assert(syntaxAction?.result.includes("Python runtime unavailable"), `expected skipped Python syntax warning, got ${syntaxAction?.result}`);
      assert(hardwareAction?.args?.degraded === true, `expected degraded hardware run, got ${JSON.stringify(hardwareAction)}`);
    });
  } finally {
    if (oldPython == null) delete process.env.PYTHON;
    else process.env.PYTHON = oldPython;
  }
});

await test("agent uses configured Python runner for hardware checks", async () => {
  const { runAgent } = await import(pathToFileURL(path.join(ROOT, "src", "agent.mjs")).href);
  const files = validGeneratedFiles();
  const oldPython = process.env.PYTHON;
  const oldRunnerUrl = process.env.PYTHON_RUNNER_URL;
  process.env.PYTHON = "python-vibeboard-missing-for-test";
  try {
    await withMockPythonRunner(async runner => {
      process.env.PYTHON_RUNNER_URL = runner.url;
      await withMockChatServer([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            createFileToolCall("call-index-runner", "index.html", files["index.html"]),
            createFileToolCall("call-style-runner", "style.css", files["style.css"]),
            createFileToolCall("call-app-runner", "app.js", files["app.js"]),
            createFileToolCall("call-hardware-runner", "hardware_app.py", files["hardware_app.py"]),
          ],
        },
        {
          role: "assistant",
          content: "done",
        },
      ], async mock => {
        const result = await runAgent({
          baseUrl: mock.baseUrl,
          apiKey: "test-key",
          model: "mock-tools",
          maxIterations: 4,
          maxVerificationAttempts: 1,
          llmTimeoutMs: 10000,
        }, "make a runner-backed status dashboard", {}, []);

        assert(result.success === true, `expected success with Python runner, got ${JSON.stringify(result)}`);
        const hardwareAction = result.actions.find(action => action.tool === "run_hardware");
        assert(hardwareAction?.result.includes("运行正常"), `expected hardware run to pass, got ${hardwareAction?.result}`);
        assert(runner.requests().some(item => item.mode === "compile"), "runner should receive a compile request");
        assert(runner.requests().some(item => item.mode === "run"), "runner should receive a run request");
      });
    });
  } finally {
    if (oldPython == null) delete process.env.PYTHON;
    else process.env.PYTHON = oldPython;
    if (oldRunnerUrl == null) delete process.env.PYTHON_RUNNER_URL;
    else process.env.PYTHON_RUNNER_URL = oldRunnerUrl;
  }
});

await test("python runner client preserves URL path prefixes", async () => {
  const { resolvePythonRunnerConfig, executePythonRunner } = await import(pathToFileURL(path.join(ROOT, "src", "pythonRunnerClient.mjs")).href);
  let requestedUrl = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ ok: true, mode: "compile", entry: "hardware_app.py", stdout: "", stderr: "", files: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const config = resolvePythonRunnerConfig({ pythonRunnerUrl: "http://runner.example.com/vibeboard-runner/" });
    assert(config.url === "http://runner.example.com/vibeboard-runner", `runner URL should trim only trailing slash, got ${config.url}`);
    const result = await executePythonRunner({ "hardware_app.py": "print(1)" }, {
      pythonRunnerUrl: "http://runner.example.com/vibeboard-runner/",
      mode: "compile",
    });
    assert(result.ok === true, "mocked runner request should succeed");
    assert(requestedUrl === "http://runner.example.com/vibeboard-runner/v1/python/execute", `runner path prefix should be preserved, got ${requestedUrl}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("agent treats chat-only history with empty files as a new project", async () => {
  const { runAgent } = await import(pathToFileURL(path.join(ROOT, "src", "agent.mjs")).href);
  const files = validGeneratedFiles();
  await withMockChatServer([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        createFileToolCall("call-index", "index.html", files["index.html"]),
        createFileToolCall("call-style", "style.css", files["style.css"]),
        createFileToolCall("call-app", "app.js", files["app.js"]),
        createFileToolCall("call-hardware", "hardware_app.py", files["hardware_app.py"]),
      ],
    },
    {
      role: "assistant",
      content: "完成",
    },
  ], async mock => {
    const result = await runAgent({
      baseUrl: mock.baseUrl,
      apiKey: "test-key",
      model: "mock-tools",
      maxIterations: 4,
      maxVerificationAttempts: 1,
      llmTimeoutMs: 10000,
    }, "生成一个 480x360 全屏时钟", {}, [
      { role: "user", content: "你能做什么？" },
      { role: "assistant", content: "我会先帮你梳理需求。" },
    ]);

    const firstRequest = mock.requestBodies()[0] || {};
    const userMessages = (firstRequest.messages || []).filter(message => message.role === "user");
    const lastUserMessage = userMessages.at(-1)?.content || "";
    assert(result.success === true, `expected success, got ${JSON.stringify(result)}`);
    assert(lastUserMessage.includes("请创建一个新项目"), `expected new project prompt, got ${lastUserMessage}`);
    assert(!lastUserMessage.includes("请修改当前项目"), `chat history alone must not trigger edit mode: ${lastUserMessage}`);
  });
});

await test("playbook store deduplicates issue signatures and records reuse", () => {
  const db = createMemoryDb();
  let saves = 0;
  const store = createPlaybookStore(db, () => { saves += 1; });
  store.initSchema();

  const issues = [{ phase: "render", code: "LAYOUT_OVERFLOW", message: "screen overflows 480x360" }];
  const signature = signatureFromIssues(issues);
  const first = store.recordPlaybook({
    taskType: "dashboard",
    title: "Fix overflow",
    issues,
    diagnosisSteps: ["measure scrollWidth"],
    fix: "constrain root",
    verificationEvidence: ["render failed"],
    score: 2,
  });
  const second = store.recordPlaybook({
    taskType: "dashboard",
    title: "Fix overflow duplicate",
    signature,
    diagnosisSteps: ["measure scrollWidth"],
    verificationEvidence: ["render passed after fix"],
    score: 2,
  });
  const used = store.recordUse(signature, { success: true, verificationEvidence: ["reused successfully"] });
  const matches = store.findPlaybooks({ taskType: "dashboard", issues, limit: 5 });

  assert(first.id === second.id, "duplicate signatures should update the existing playbook");
  assert(used.usage_count === 1 && used.success_count === 1, "recordUse should increment usage and success counters");
  assert(matches.length === 1 && matches[0].signature === signature, "findPlaybooks should retrieve the matching signature");
  assert(saves >= 3, "store should persist schema, record, update, and use operations");
});

await test("experience lessons include persistent playbook fixes", async () => {
  const { createExperienceStore } = await import(pathToFileURL(path.join(ROOT, "src", "experienceStore.mjs")).href);
  const db = createSqlMemoryDb();
  let saves = 0;
  const playbooks = createPlaybookStore(db, () => { saves += 1; });
  playbooks.initSchema();
  const experience = createExperienceStore(db, () => { saves += 1; });
  experience.initSchema();
  experience.setPlaybookStore(playbooks);

  playbooks.recordPlaybook({
    taskType: "general",
    issues: [{ phase: "contract", code: "APP_HARDWARE_API", message: "window.VibeBoardHardware was overwritten" }],
    title: "Protect frontend hardware SDK",
    rootCause: "Agent rewrote window.VibeBoardHardware instead of calling the system SDK.",
    diagnosisSteps: ["Check app.js for window.VibeBoardHardware assignment."],
    fix: "Let the system inject the locked SDK and only call getStatus/getProgramResult/getSnapshot.",
    verificationEvidence: ["verify:agent reproduced the locked SDK path."],
    score: 5,
  });

  const lessons = experience.getLessons("general", 5);
  assert(lessons.pitfalls.some(item => item.includes("rewrote window.VibeBoardHardware")), `expected playbook pitfall, got ${JSON.stringify(lessons)}`);
  assert(lessons.fixes.some(item => item.includes("locked SDK")), `expected playbook fix, got ${JSON.stringify(lessons)}`);
  assert(saves >= 2, "stores should persist schemas and playbook");
});

const verifier = await importVerifyAllLocal();
if (!verifier) {
  record("SKIP", "verifyAllLocal valid generated fixture", "src/verifiers not present yet");
} else {
  await test("verifyAllLocal accepts valid generated fixture", async () => {
    await withTempDir("vibeboard-verify-all-", async dir => {
      const files = validGeneratedFiles();
      await writeFiles(dir, files);
      const result = await runVerifyAllLocal(verifier.verifyAllLocal, dir, files);
      assert(result && result.ok === true, `verifyAllLocal did not return ok result: ${JSON.stringify(result)}`);
      return `loaded ${verifier.path}`;
    });
  });

  await test("verifyAllLocal degrades when Python runtime is unavailable", async () => {
    await withTempDir("vibeboard-verify-no-python-", async dir => {
      const files = validGeneratedFiles();
      await writeFiles(dir, files);
      const mod = await importVerifiers();
      const result = await mod.verifyAllLocal(files, {
        dir,
        root: ROOT,
        pythonBin: "python-vibeboard-missing-for-test",
      });
      assert(result && result.ok === true, `missing Python should not block cloud verification: ${JSON.stringify(result)}`);
      assert(result.degraded === true, `missing Python should mark verification degraded: ${JSON.stringify(result)}`);
      assert(result.issues.some(issue => issue.code === "PYTHON_RUNTIME_UNAVAILABLE" && issue.severity === SEVERITY.WARNING), `expected PYTHON_RUNTIME_UNAVAILABLE warning, got ${JSON.stringify(result.issues)}`);
    });
  });

  await test("verifyAllLocal uses configured Python runner", async () => {
    await withTempDir("vibeboard-verify-runner-", async dir => {
      await withMockPythonRunner(async runner => {
        const files = validGeneratedFiles();
        await writeFiles(dir, files);
        const mod = await importVerifiers();
        const result = await mod.verifyAllLocal(files, {
          dir,
          root: ROOT,
          pythonBin: "python-vibeboard-missing-for-test",
          pythonRunnerUrl: runner.url,
        });
        assert(result && result.ok === true, `runner-backed verification should pass: ${JSON.stringify(result)}`);
        assert(result.degraded === false, `runner-backed verification should not be degraded: ${JSON.stringify(result)}`);
        assert(result.data?.hardware_run?.runtime?.mode === "python_runner", `expected runner hardware data, got ${JSON.stringify(result.data)}`);
        assert(runner.requests().some(item => item.mode === "compile"), "runner should receive compile request");
        assert(runner.requests().some(item => item.mode === "run"), "runner should receive run request");
      });
    });
  });

  await test("verifyHardwareRun rejects non-JSON hardware output", async () => {
    const mod = await importVerifiers();
    const files = validGeneratedFiles();
    files["hardware_app.py"] = "print('not-json')\n";
    const result = await mod.verifyHardwareRun(files, { pythonBin: PYTHON_BIN });
    assert(result.ok === false, "invalid hardware output should fail verification");
    assert(result.issues.some(issue => issue.code === "HARDWARE_JSON_INVALID"), `expected HARDWARE_JSON_INVALID, got ${JSON.stringify(result.issues)}`);
  });

  await test("verifyRender uses remote runner in cloud deployment", async () => {
    const mod = await importVerifiers();
    await withMockRenderRunner(async runner => {
      const result = await mod.verifyRender(validGeneratedFiles(), {
        env: { VERCEL: "1" },
        renderRunnerUrl: runner.url,
        renderRunnerRequired: "true",
        chromium: {
          launch: async () => {
            throw new Error("local Playwright should not be used when render runner is configured");
          },
        },
      });
      assert(result.ok === true, `runner-backed render verification should pass: ${JSON.stringify(result)}`);
      assert(result.degraded === false, "runner-backed render verification should not be degraded");
      assert(result.evidence.runner === true, `render evidence should mark runner path: ${JSON.stringify(result.evidence)}`);
      assert(result.data?.screenshot?.bytes === 8, `render runner should preserve screenshot data: ${JSON.stringify(result.data)}`);
      assert(runner.requests().length === 1, "render runner should receive exactly one request");
      assert(runner.requests()[0].files["index.html"], "render runner should receive index.html");
      assert(runner.requests()[0].files["hardware-result.json"], "render runner should receive hardware-result.json");
    });
  });

  await test("verifyRender fails cloud deployment when render runner is unavailable", async () => {
    const mod = await importVerifiers();
    const result = await mod.verifyRender(validGeneratedFiles(), {
      env: { VERCEL: "1" },
      renderRunnerUrl: "http://127.0.0.1:1",
      renderRunnerRequired: "true",
      chromium: {
        launch: async () => {
          throw new Error("local Playwright should not mask missing remote runner");
        },
      },
    });
    assert(result.ok === false, `missing cloud render runner should fail: ${JSON.stringify(result)}`);
    assert(result.issues.some(issue => issue.code === "RENDER_RUNNER_UNAVAILABLE" && issue.severity === SEVERITY.BLOCKING), `expected RENDER_RUNNER_UNAVAILABLE blocking issue, got ${JSON.stringify(result.issues)}`);
  });

  await test("verifyRender fails cloud deployment when no render runner URL is configured", async () => {
    const mod = await importVerifiers();
    const result = await mod.verifyRender(validGeneratedFiles(), {
      env: { VERCEL: "1" },
      renderRunnerRequired: "true",
      chromium: {
        launch: async () => {
          throw new Error("local Playwright should not mask missing remote runner config");
        },
      },
    });
    assert(result.ok === false, `unconfigured cloud render runner should fail: ${JSON.stringify(result)}`);
    assert(result.issues.some(issue => issue.code === "RENDER_RUNNER_UNAVAILABLE" && issue.severity === SEVERITY.BLOCKING), `expected RENDER_RUNNER_UNAVAILABLE blocking issue, got ${JSON.stringify(result.issues)}`);
  });

  await test("verifyRender rejects 480x360 overflow", async () => {
    const mod = await importVerifiers();
    const files = validGeneratedFiles();
    files["style.css"] = "html, body { width: 960px; height: 720px; margin: 0; } #screen { width: 960px; height: 720px; }";
    files["app.js"] = files["app.js"].replace(
      "screen.textContent = JSON.stringify({ status, program });",
      "screen.innerHTML = '<div style=\"width:960px;height:720px\">overflow</div>';",
    );
    const result = await mod.verifyRender(files, { timeoutMs: 15000 });
    assert(result.ok === false, "overflowing render should fail verification");
    assert(result.issues.some(issue => issue.code === "LAYOUT_OVERFLOW"), `expected LAYOUT_OVERFLOW, got ${JSON.stringify(result.issues)}`);
  });

  await test("verifyRender rejects unreadably small hardware text", async () => {
    const mod = await importVerifiers();
    const files = validGeneratedFiles();
    files["style.css"] = "html, body { width: 480px; height: 360px; overflow: hidden; margin: 0; } #screen { width: 480px; height: 360px; overflow: hidden; background: #101820; color: #f7f7f2; } .micro { font-size: 7px; }";
    files["app.js"] = files["app.js"].replace(
      "screen.textContent = JSON.stringify({ status, program });",
      "screen.innerHTML = '<p class=\"micro\">tiny diagnostics that would be unreadable on hardware</p>';",
    );
    const result = await mod.verifyRender(files, { timeoutMs: 15000 });
    assert(result.ok === false, "tiny text should fail render verification");
    assert(result.issues.some(issue => issue.code === "TEXT_TOO_SMALL"), `expected TEXT_TOO_SMALL, got ${JSON.stringify(result.issues)}`);
  });

  await test("verifyRender rejects low-contrast hardware text", async () => {
    const mod = await importVerifiers();
    const files = validGeneratedFiles();
    files["style.css"] = "html, body { width: 480px; height: 360px; overflow: hidden; margin: 0; } #screen { width: 480px; height: 360px; overflow: hidden; background: #202020; color: #2a2a2a; font-size: 14px; }";
    files["app.js"] = files["app.js"].replace(
      "screen.textContent = JSON.stringify({ status, program });",
      "screen.innerHTML = '<p>low contrast status text</p>';",
    );
    const result = await mod.verifyRender(files, { timeoutMs: 15000 });
    assert(result.ok === false, "low contrast text should fail render verification");
    assert(result.issues.some(issue => issue.code === "TEXT_CONTRAST_LOW"), `expected TEXT_CONTRAST_LOW, got ${JSON.stringify(result.issues)}`);
  });

  await test("verifyRender blends translucent panels against dark hardware backgrounds", async () => {
    const mod = await importVerifiers();
    const files = validGeneratedFiles();
    files["style.css"] = "html, body { width: 480px; height: 360px; overflow: hidden; margin: 0; background: #08111d; } #screen { width: 480px; height: 360px; overflow: hidden; background: #08111d; color: #f8fbff; font-size: 14px; } .chip { display: inline-block; padding: 8px 10px; background: rgba(255,255,255,.08); color: #f8fbff; }";
    files["app.js"] = files["app.js"].replace(
      "screen.textContent = JSON.stringify({ status, program });",
      "screen.innerHTML = '<span class=\"chip\">SYSTEM BUS</span>';",
    );
    const result = await mod.verifyRender(files, { timeoutMs: 15000 });
    assert(result.ok === true, `translucent panel text should pass against its effective dark background: ${JSON.stringify(result.issues)}`);
    assert(!result.issues.some(issue => issue.code === "TEXT_CONTRAST_LOW"), `expected no low contrast issue, got ${JSON.stringify(result.issues)}`);
  });

  await test("verifyRender accepts generated dashboard template contrast", async () => {
    const mod = await importVerifiers();
    const files = templateFilesForPrompt("offline acceptance dashboard");
    const result = await mod.verifyRender(files, { timeoutMs: 15000 });
    assert(result.ok === true, `generated dashboard template should pass render verification: ${JSON.stringify(result.issues)}`);
    assert(!result.issues.some(issue => issue.code === "TEXT_CONTRAST_LOW"), `expected no low contrast issue, got ${JSON.stringify(result.issues)}`);
  });

  await test("verifyRender accepts generated weather template contrast", async () => {
    const mod = await importVerifiers();
    const files = templateFilesForPrompt("preview restore weather panel");
    const result = await mod.verifyRender(files, { timeoutMs: 15000 });
    assert(result.ok === true, `generated weather template should pass render verification: ${JSON.stringify(result.issues)}`);
    assert(!result.issues.some(issue => issue.code === "TEXT_CONTRAST_LOW"), `expected no low contrast issue, got ${JSON.stringify(result.issues)}`);
  });

  await test("verifyRender accepts generated template mode contrast matrix", async () => {
    const mod = await importVerifiers();
    const prompts = [
      "assistant status panel",
      "server dashboard status panel",
      "voice audio console",
      "focus timer countdown",
      "paid fishing wage calculator hourly wage 150 start pause button",
      "gpio relay control panel",
      "weather panel",
      "fullscreen clock",
      "image carousel slideshow",
    ];
    for (const prompt of prompts) {
      const result = await mod.verifyRender(templateFilesForPrompt(prompt), { timeoutMs: 15000 });
      assert(result.ok === true, `${prompt} should pass render verification: ${JSON.stringify(result.issues)}`);
      assert(!result.issues.some(issue => issue.code === "TEXT_TOO_SMALL" || issue.code === "TEXT_CONTRAST_LOW"), `${prompt} should not have hardware readability issues: ${JSON.stringify(result.issues)}`);
    }
  });

  await test("verifyRender warns but does not fail for tiny interactive targets", async () => {
    const mod = await importVerifiers();
    const files = validGeneratedFiles();
    files["style.css"] = "html, body { width: 480px; height: 360px; overflow: hidden; margin: 0; } #screen { width: 480px; height: 360px; overflow: hidden; background: #101820; color: #f7f7f2; font-size: 14px; } button { width: 20px; height: 20px; font-size: 12px; }";
    files["app.js"] = files["app.js"].replace(
      "screen.textContent = JSON.stringify({ status, program });",
      "screen.innerHTML = '<button aria-label=\"refresh\">R</button><p>Readable status panel</p>';",
    );
    const result = await mod.verifyRender(files, { timeoutMs: 15000 });
    assert(result.ok === true, `tiny touch target should be warning-only for no-touch hardware: ${JSON.stringify(result.issues)}`);
    assert(result.degraded === true, "tiny interactive target should mark render result degraded");
    assert(result.issues.some(issue => issue.code === "INTERACTIVE_TARGET_SMALL" && issue.severity === "warning"), `expected INTERACTIVE_TARGET_SMALL warning, got ${JSON.stringify(result.issues)}`);
  });
}

const failed = results.filter(result => result.status === "FAIL");
const passed = results.filter(result => result.status === "PASS");
const skipped = results.filter(result => result.status === "SKIP");

console.log("");
console.log(`verify-agent summary: ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed`);

if (failed.length) {
  process.exitCode = 1;
}
