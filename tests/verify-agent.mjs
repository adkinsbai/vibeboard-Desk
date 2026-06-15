import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateFileContracts } from "../src/contracts.mjs";
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

async function writeFiles(dir, files) {
  for (const [filename, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, filename), content, "utf8");
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

await test("valid generated fixture runs local syntax checks", async () => {
  await withTempDir("vibeboard-valid-", async dir => {
    const files = validGeneratedFiles();
    await writeFiles(dir, files);
    await execFileP(NODE_BIN, ["--check", path.join(dir, "app.js")]);
    await execFileP(PYTHON_BIN, ["-m", "py_compile", path.join(dir, "hardware_app.py")]);
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
