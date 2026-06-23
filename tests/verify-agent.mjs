import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_BIN = process.env.VIBEBOARD_NODE || "node";
const PYTHON_BIN = process.env.VIBEBOARD_PYTHON || (process.platform === "win32" ? "python" : "python3");

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

await test("gray board profile uses the deployable linaro account", async () => {
  const { createBoardConfig } = await import(pathToFileURL(path.join(ROOT, "src", "devices.mjs")).href);
  const gray = createBoardConfig("taishan-gray", {});
  assert(gray.user === "linaro", `gray board should default to linaro, got ${gray.user}`);
  assert(gray.port === "6278", `gray board should keep FRP port 6278, got ${gray.port}`);
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
  const { normalizeIncomingAssets, formatAssetContext } = await import(pathToFileURL(path.join(ROOT, "src", "assetLibrary.mjs")).href);
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
  const context = formatAssetContext(normalized.assets);
  assert(context.includes("Uploaded asset library"), "asset context should have a heading");
  assert(context.includes("component.html"), "asset context should include component names");
  assert(context.includes("480x360"), "asset text preview should be available to the agent");
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
    { name: "brief/brand.md", content: "品牌 palette cyan logo motion dashboard 480x360 音乐 氛围" },
    { name: "components/player.html", content: "<section><audio src=\"theme.mp3\"></audio><button>Play</button></section>" },
    { name: "media/theme.mp3", content: Buffer.from([0x49, 0x44, 0x33, 0x03]) },
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
  assert(names.includes("product-kit/media/theme.mp3"), "audio should be extracted from tgz");
  assert(summary.byKind.audio === 1, `audio should be classified, got ${JSON.stringify(summary.byKind)}`);
  assert(summary.designBrief.priorities.some(item => item.includes("audio") || item.includes("音频")), `design brief should mention audio, got ${JSON.stringify(summary.designBrief)}`);
  assert(summary.designBrief.priorities.some(item => item.includes("dashboard")), "design brief should infer dashboard priority from text");
  assert(context.includes("Inferred product design brief from assets"), "agent context should include product design brief");
  assert(context.includes("priority:"), "agent context should expose priorities");
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

await test("generate runtime downgrades snapshot save failures", async () => {
  const { createGenerateRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "generateRuntime.mjs")).href);
  const logs = [];
  const runtime = createGenerateRuntime({
    conversationStore: {
      getProjectMemory: () => ({}),
      loadConversationFiles: () => ({ files: {} }),
      saveConversationFiles: () => {
        throw new Error("database busy");
      },
    },
    memoryStore: {
      getAll: () => ({}),
      set: () => {},
    },
    appendServerLog: async (event, detail) => {
      logs.push({ event, detail });
    },
    writeGenerated: async () => ({
      id: "vb-runtime-save-fail",
      files: { "index.html": "<html></html>" },
      manifest: null,
      agentRun: { evidence: [] },
      buildEvidence: { ok: true, issues: [] },
      intelligenceSummary: { confidence: "local_verified" },
    }),
    filesWithHardwareResult: async files => files,
  });

  const result = await runtime.runGenerateRequest({
    prompt: "Build a resilient snapshot test.",
    conversation_id: "conv-runtime-save-fail",
    modelSettings: { enabled: false },
  });

  assert(result.ok === true, `snapshot save failure must not fail generation, got ${JSON.stringify(result)}`);
  assert(logs.some(item => item.event === "generate.template.conversation_save_failed"), "runtime should log downgraded snapshot failure");
});

await test("generate runtime passes conversation files into agent path", async () => {
  const { createGenerateRuntime } = await import(pathToFileURL(path.join(ROOT, "src", "generateRuntime.mjs")).href);
  await withTempDir("vibeboard-runtime-agent-", async dir => {
    let receivedFiles = null;
    let currentBuild = null;
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
      runAgent: async (_settings, _prompt, fileStore) => {
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
    assert(receivedFiles?.["app.js"] === "console.log('old')", "agent should receive saved conversation files");
    assert(result.buildGraph.some(item => item.node === "agent_generate" && item.status === "done"), "runtime graph should include completed agent node");
  });
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
  assert(result.codex_bridge?.scope?.includes("480x360"), "build result should expose bridge scope");
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

  await test("verifyHardwareRun rejects non-JSON hardware output", async () => {
    const mod = await importVerifiers();
    const files = validGeneratedFiles();
    files["hardware_app.py"] = "print('not-json')\n";
    const result = await mod.verifyHardwareRun(files, { pythonBin: PYTHON_BIN });
    assert(result.ok === false, "invalid hardware output should fail verification");
    assert(result.issues.some(issue => issue.code === "HARDWARE_JSON_INVALID"), `expected HARDWARE_JSON_INVALID, got ${JSON.stringify(result.issues)}`);
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
}

const failed = results.filter(result => result.status === "FAIL");
const passed = results.filter(result => result.status === "PASS");
const skipped = results.filter(result => result.status === "SKIP");

console.log("");
console.log(`verify-agent summary: ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed`);

if (failed.length) {
  process.exitCode = 1;
}
