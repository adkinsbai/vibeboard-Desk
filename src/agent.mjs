/**
 * VibeBoard Coding Agent — Enhanced
 *
 * 可迭代、可自我验证、可自我学习的 Agent。
 *
 * 核心能力：
 * 1. 代码生成 — read_file, create_file, edit_file, search_code
 * 2. 自我验证 — verify_syntax, verify_render (截图), run_hardware (Python)
 * 3. 经验学习 — get_learnings (查询过去经验)
 * 4. 自动修复 — 验证失败时自动进入修复循环
 */

import fs from "fs/promises";
import path from "path";
import os from "os";
import http from "http";
import { execFile } from "child_process";
import {
  APP_CONTRACT_SNIPPETS,
  AGENT_WRITABLE_FILE_NAMES,
  HARDWARE_CONTRACT_SNIPPETS,
  REQUIRED_RUNTIME_FILE_NAMES,
  validationRulesText,
} from "./contracts.mjs";

const DEFAULT_MAX_ITERATIONS = 30;
const DEFAULT_MAX_VERIFICATION_ATTEMPTS = 3;
const RENDER_TIMEOUT_MS = 30000;
const HARDWARE_TIMEOUT_MS = 10000;
const LLM_TIMEOUT_MS = 120000;
const AGENT_TIMEOUT_MS = 180000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CONTENT_CHARS = 4000;
const MAX_NO_TOOL_RESPONSES = 3;
const REQUIRED_RUNTIME_FILES = [...REQUIRED_RUNTIME_FILE_NAMES];
const AGENT_WRITABLE_FILES = new Set(AGENT_WRITABLE_FILE_NAMES);
const GENERATION_TOOL_NAMES = new Set([
  "read_file",
  "list_files",
  "search_code",
  "edit_file",
  "create_file",
  "verify_syntax",
  "get_learnings",
  "record_lesson",
  "done",
]);

const REQUIRED_APP_SNIPPETS = APP_CONTRACT_SNIPPETS.map(rule => ({
  text: rule.text,
  message: rule.message.replace("app.js must", "app.js 必须"),
}));

const REQUIRED_HARDWARE_SNIPPETS = HARDWARE_CONTRACT_SNIPPETS.map(rule => ({
  text: rule.text,
  message: rule.message.replace("hardware_app.py must", "hardware_app.py 必须"),
}));

// ─── Tool Definitions (OpenAI function calling format) ───

export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取文件的完整内容。用于查看当前代码。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件名，如 'app.js', 'index.html', 'style.css'" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出当前项目的所有文件。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "在文件中搜索文本，返回匹配的行和行号。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件名" },
          query: { type: "string", description: "要搜索的文本" }
        },
        required: ["path", "query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "精准编辑文件：找到 old_text 并替换为 new_text。old_text 必须是文件中精确存在的文本。只替换第一处匹配。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件名" },
          old_text: { type: "string", description: "要替换的原始文本（必须精确匹配）" },
          new_text: { type: "string", description: "替换后的新文本" }
        },
        required: ["path", "old_text", "new_text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description: "创建或完全重写一个文件。用于新建项目或需要完全重写某个文件时。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件名" },
          content: { type: "string", description: "文件的完整内容" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "verify_syntax",
      description: "验证当前代码的语法是否正确。检查 JS 花括号匹配、HTML 引用完整性、Python 编译。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "verify_render",
      description: "用 Playwright 截图验证页面是否正常渲染。检查：页面是否白屏、是否有 JS 错误、元素是否可见。返回截图路径和错误列表。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "run_hardware",
      description: "运行 hardware_app.py 并验证输出是否为有效 JSON（包含 runtime 和 build_id 字段）。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_learnings",
      description: "查询过去构建类似任务的经验教训。返回成功模式、常见陷阱和有效修复方法。",
      parameters: {
        type: "object",
        properties: {
          task_type: { type: "string", description: "任务类型，如 'clock', 'game', 'weather', 'general'" }
        }
      }
    }
  },
  // ─── 硬件调试工具 ───
  {
    type: "function",
    function: {
      name: "ssh_exec",
      description: "SSH 到泰山派硬件执行命令。用于调试：查看日志、检查进程、测试 Python 脚本。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 Linux 命令，如 'journalctl -u vibeboard -n 50', 'ps aux | grep python'" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_device_logs",
      description: "获取硬件设备日志。支持：systemd 日志、Python 输出、应用崩溃信息。",
      parameters: {
        type: "object",
        properties: {
          log_type: {
            type: "string",
            enum: ["app", "system", "python", "recent"],
            description: "日志类型：app=应用运行日志, system=系统日志, python=Python输出, recent=最近所有日志"
          },
          lines: { type: "number", description: "获取最后多少行，默认 50" }
        },
        required: ["log_type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "deploy_to_device",
      description: "将当前项目部署到硬件设备并运行。会 SCP 上传文件、执行 hardware_app.py、返回运行结果。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "check_device_status",
      description: "检查硬件设备状态：是否在线、CPU/内存使用、Python 进程是否运行。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "record_lesson",
      description: "记录一条经验教训。在调试过程中发现问题或找到解决方案时立即调用，不要等到 done。类型：pitfall=陷阱（避免）, pattern=成功模式, fix=修复方法。",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["pitfall", "pattern", "fix"],
            description: "经验类型"
          },
          content: { type: "string", description: "经验内容，简洁具体，如 'Python json.dumps 必须 ensure_ascii=False'" },
          context: { type: "string", description: "上下文：什么场景下发现的" }
        },
        required: ["type", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "当所有修改完成且验证通过时调用。报告你做了什么以及验证结果。",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "用中文简要说明你做了哪些修改" },
          what_worked: {
            type: "array",
            items: { type: "string" },
            description: "这次构建中有效的模式（用于经验记忆）"
          },
          what_failed: {
            type: "array",
            items: { type: "string" },
            description: "这次构建中遇到的问题（用于经验记忆）"
          }
        },
        required: ["summary"]
      }
    }
  }
];

// ─── Tool Implementations ───

export function createToolExecutor(fileStore, hardware = null) {
  // hardware: { ssh, scp, board } — 由 server.mjs 注入
  const actions = [];
  const lessons = []; // 本次会话积累的经验教训

  async function executeTool(name, args) {
    const action = { tool: name, args: {}, timestamp: Date.now() };

    switch (name) {
      case "list_files": {
        const files = Object.keys(fileStore).filter(f => f !== "manifest.json");
        action.result = `项目文件：${files.join(", ")}`;
        actions.push(action);
        return action.result;
      }

      case "read_file": {
        const filePath = args.path;
        const content = fileStore[filePath];
        if (content === undefined) {
          action.result = `错误：文件 '${filePath}' 不存在`;
          action.args = { path: filePath };
          actions.push(action);
          return action.result;
        }
        const truncated = content.length > 10000
          ? content.slice(0, 10000) + "\n... (文件过长，已截断到前10000字符)"
          : content;
        action.result = `文件 ${filePath} 的内容：\n${truncated}`;
        action.args = { path: filePath, size: content.length };
        actions.push(action);
        return action.result;
      }

      case "search_code": {
        const filePath = args.path;
        const query = args.query;
        const content = fileStore[filePath];
        if (content === undefined) {
          action.result = `错误：文件 '${filePath}' 不存在`;
          action.args = { path: filePath, query };
          actions.push(action);
          return action.result;
        }
        const lines = content.split("\n");
        const matches = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(query)) {
            matches.push(`  行 ${i + 1}: ${lines[i].trim()}`);
          }
        }
        action.args = { path: filePath, query };
        if (matches.length === 0) {
          action.result = `在 ${filePath} 中未找到 "${query}"`;
        } else {
          action.result = `在 ${filePath} 中找到 ${matches.length} 处匹配：\n${matches.join("\n")}`;
        }
        actions.push(action);
        return action.result;
      }

      case "edit_file": {
        const filePath = args.path;
        const oldText = args.old_text;
        const newText = args.new_text;
        if (!isWritableAgentFile(filePath)) {
          action.result = `错误：生成阶段只允许修改 ${[...AGENT_WRITABLE_FILES].join(", ")}，不能修改 ${filePath}`;
          action.args = { path: filePath, blocked: true };
          actions.push(action);
          return action.result;
        }
        const content = fileStore[filePath];

        if (content === undefined) {
          action.result = `错误：文件 '${filePath}' 不存在`;
          action.args = { path: filePath };
          actions.push(action);
          return action.result;
        }

        const idx = content.indexOf(oldText);
        if (idx === -1) {
          const trimmed = oldText.trim();
          const trimmedIdx = content.indexOf(trimmed);
          if (trimmedIdx === -1) {
            action.result = `错误：在 ${filePath} 中找不到要替换的文本。请先用 search_code 或 read_file 确认文本存在。`;
            action.args = { path: filePath, old_text_preview: oldText.slice(0, 80) };
            actions.push(action);
            return action.result;
          }
          fileStore[filePath] = content.slice(0, trimmedIdx) + newText + content.slice(trimmedIdx + trimmed.length);
        } else {
          fileStore[filePath] = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
        }

        action.result = `已编辑 ${filePath}`;
        action.args = { path: filePath, old_text: oldText.slice(0, 60), new_text: newText.slice(0, 60) };
        actions.push(action);
        return action.result;
      }

      case "create_file": {
        const filePath = args.path;
        const content = args.content;
        if (!isWritableAgentFile(filePath)) {
          action.result = `错误：生成阶段只允许创建 ${[...AGENT_WRITABLE_FILES].join(", ")}，不能创建 ${filePath}`;
          action.args = { path: filePath, blocked: true };
          actions.push(action);
          return action.result;
        }
        fileStore[filePath] = content;
        action.result = `已创建/重写 ${filePath}（${content.length} 字符）`;
        action.args = { path: filePath, size: content.length };
        actions.push(action);
        return action.result;
      }

      case "verify_syntax": {
        const results = [];
        let hasError = false;
        const tmpDir = path.join(os.tmpdir(), `vibeboard-syntax-${Date.now()}`);
        await fs.mkdir(tmpDir, { recursive: true });

        try {
          // JS 检查
          if (fileStore["app.js"]) {
            const js = fileStore["app.js"];
            const jsSyntax = await validateJavaScriptSyntax(js, "app.js", tmpDir);
            for (const issue of jsSyntax) {
              results.push(`❌ ${issue}`);
              hasError = true;
            }
            for (const rule of REQUIRED_APP_SNIPPETS) {
              if (!js.includes(rule.text)) {
                results.push(`❌ ${rule.message}`);
                hasError = true;
              }
            }
            for (const method of ["getStatus", "getProgramResult", "getSnapshot"]) {
              if (!js.includes(method)) {
                results.push(`❌ app.js: window.VibeBoardHardware 缺少 ${method}()`);
                hasError = true;
              }
            }
            if (js.includes("{{") || js.includes("}}")) {
              results.push("❌ app.js: 疑似模板语法错误");
              hasError = true;
            }
            if (!results.some(line => line.includes("app.js"))) results.push("✅ app.js: 基本检查通过");
          }

          // HTML 检查
          if (fileStore["index.html"]) {
            const html = fileStore["index.html"];
            let htmlOk = true;
            if (!html.includes("./style.css")) {
              results.push("❌ index.html: 未使用相对路径引用 ./style.css");
              htmlOk = false;
              hasError = true;
            }
            if (!html.includes("./app.js")) {
              results.push("❌ index.html: 未使用相对路径引用 ./app.js");
              htmlOk = false;
              hasError = true;
            }
            if (htmlOk) results.push("✅ index.html: 基本检查通过");
          }

          // Python 检查
          if (fileStore["hardware_app.py"]) {
            const py = fileStore["hardware_app.py"];
            let pyOk = true;
            const pySyntax = await validatePythonSyntax(py, "hardware_app.py", tmpDir);
            for (const issue of pySyntax) {
              results.push(`❌ ${issue}`);
              hasError = true;
              pyOk = false;
            }
            for (const rule of REQUIRED_HARDWARE_SNIPPETS) {
              if (!py.includes(rule.text)) {
                results.push(`❌ ${rule.message}`);
                hasError = true;
                pyOk = false;
              }
            }
            if (!py.includes("import json") && !py.includes("from json")) {
              results.push("❌ hardware_app.py: 缺少 json 导入");
              hasError = true;
              pyOk = false;
            }
            if (!py.includes("print(") || !py.includes("json.dumps")) {
              results.push("❌ hardware_app.py: 必须 print(json.dumps(...)) 到 stdout");
              hasError = true;
              pyOk = false;
            }
            if (pyOk) {
              results.push("✅ hardware_app.py: 基本检查通过");
            }
          }
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }

        action.result = results.join("\n");
        action.args = { hasError };
        actions.push(action);
        return action.result;
      }

      case "verify_render": {
        let browser = null;
        let server = null;
        let tmpDir = null;
        try {
          tmpDir = path.join(os.tmpdir(), `vibeboard-verify-${Date.now()}`);
          await fs.mkdir(tmpDir, { recursive: true });

          for (const [name, content] of Object.entries(fileStore)) {
            if (name === "manifest.json") continue;
            const filePath = path.join(tmpDir, name);
            await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
            await fs.writeFile(filePath, content, "utf-8");
          }

          await ensureRenderSupport();
          server = await startVerificationServer(tmpDir);
          const baseUrl = `http://127.0.0.1:${server.port}`;

          const { chromium } = await import("playwright");
          browser = await chromium.launch({ headless: true });
          const page = await browser.newPage({ viewport: { width: 480, height: 360 } });

          const consoleErrors = [];
          const pageErrors = [];

          page.on("console", msg => {
            if (msg.type() === "error") consoleErrors.push(msg.text());
          });
          page.on("pageerror", err => pageErrors.push(err.message));

          try {
            await page.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
            await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
          } catch (navErr) {
            pageErrors.push(`页面加载失败: ${navErr.message}`);
          }

          const pageState = await page.evaluate(() => {
            const body = document.body;
            const root = document.querySelector("main") || document.querySelector("#app") || body;
            const rect = root?.getBoundingClientRect?.();
            const text = body?.innerText || "";
            return {
              bodyHtmlLength: body?.innerHTML?.trim?.().length || 0,
              textLength: text.trim().length,
              scrollWidth: document.documentElement.scrollWidth,
              scrollHeight: document.documentElement.scrollHeight,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
              rootWidth: rect?.width || 0,
              rootHeight: rect?.height || 0,
            };
          }).catch(() => ({
            bodyHtmlLength: 0,
            textLength: 0,
            scrollWidth: 0,
            scrollHeight: 0,
            viewportWidth: 480,
            viewportHeight: 360,
            rootWidth: 0,
            rootHeight: 0,
          }));
          const isBlank = pageState.bodyHtmlLength < 50 && pageState.textLength < 5;
          const overflows = pageState.scrollWidth > 500 || pageState.scrollHeight > 390;

          const screenshotDir = path.join(os.tmpdir(), "vibeboard-render-screenshots");
          await fs.mkdir(screenshotDir, { recursive: true }).catch(() => {});
          const screenshotPath = path.join(screenshotDir, `screenshot-${Date.now()}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
          const screenshotExists = Boolean(await fs.stat(screenshotPath).catch(() => null));

          const result = {
            ok: consoleErrors.length === 0 && pageErrors.length === 0 && !isBlank && !overflows,
            consoleErrors,
            pageErrors,
            isBlank,
            overflows,
            pageState,
            screenshotPath: screenshotExists ? screenshotPath : null,
          };

          const resultLines = [];
          if (result.ok) {
            resultLines.push("✅ 页面渲染正常");
          } else {
            if (result.isBlank) resultLines.push("❌ 页面白屏");
            if (result.overflows) {
              resultLines.push(`❌ 页面可能溢出 480x360（scroll=${pageState.scrollWidth}x${pageState.scrollHeight}）`);
            }
            if (result.consoleErrors.length > 0) {
              resultLines.push(`❌ 控制台错误 (${result.consoleErrors.length}):`);
              result.consoleErrors.slice(0, 5).forEach(e => resultLines.push(`  - ${e.slice(0, 200)}`));
            }
            if (result.pageErrors.length > 0) {
              resultLines.push(`❌ 页面错误 (${result.pageErrors.length}):`);
              result.pageErrors.slice(0, 5).forEach(e => resultLines.push(`  - ${e.slice(0, 200)}`));
            }
          }
          if (result.screenshotPath) {
            resultLines.push(`截图: ${result.screenshotPath}`);
          }

          action.result = resultLines.join("\n");
          action.args = { ...result, screenshotPath: undefined };
          actions.push(action);
          return action.result;
        } catch (err) {
          action.result = `⚠️ 截图验证不可用，已降级为语法验证: ${err.message}`;
          action.args = { error: err.message, degraded: true };
          actions.push(action);
          return action.result;
        } finally {
          if (browser) await browser.close().catch(() => {});
          if (server?.close) await server.close().catch(() => {});
          if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      }

      case "run_hardware": {
        try {
          if (!fileStore["hardware_app.py"]) {
            action.result = "❌ 没有 hardware_app.py 文件";
            actions.push(action);
            return action.result;
          }

          const tmpDir = path.join(os.tmpdir(), `vibeboard-hw-${Date.now()}`);
          await fs.mkdir(tmpDir, { recursive: true });
          try {
            for (const [name, content] of Object.entries(fileStore)) {
              if (name === "manifest.json") continue;
              await fs.writeFile(path.join(tmpDir, name), content, "utf-8");
            }

            let runResult;
            try {
              runResult = await runPythonScript(path.join(tmpDir, "hardware_app.py"), tmpDir, HARDWARE_TIMEOUT_MS);
            } catch (execErr) {
              const stderr = execErr.stderr || "";
              const stdout = execErr.stdout || "";
              action.result = `❌ hardware_app.py 运行失败:\n${stderr || stdout || execErr.message}`;
              action.args = { error: stderr || stdout || execErr.message };
              actions.push(action);
              return action.result;
            }

            const output = runResult.stdout.trim();
            let parsed;
            try {
              parsed = parseJsonOutput(output);
            } catch {
              action.result = `❌ hardware_app.py 输出不是有效 JSON:\n${output.slice(0, 500)}`;
              action.args = { output: output.slice(0, 500) };
              actions.push(action);
              return action.result;
            }

            const issues = [];
            if (!parsed.runtime) issues.push("缺少 runtime 字段");
            if (!parsed.build_id) issues.push("缺少 build_id 字段");
            if (!Array.isArray(parsed.available_apis) && !fileStore["hardware_app.py"].includes("available_apis")) {
              issues.push("缺少 available_apis 信息");
            }

            const hardwareResultPath = path.join(tmpDir, "hardware-result.json");
            const hardwareResultRaw = await fs.readFile(hardwareResultPath, "utf-8").catch(() => null);
            if (!hardwareResultRaw) {
              issues.push("未写入 hardware-result.json 文件");
            } else {
              try {
                const hardwareResult = JSON.parse(hardwareResultRaw);
                if (hardwareResult.build_id && parsed.build_id && hardwareResult.build_id !== parsed.build_id) {
                  issues.push("stdout 与 hardware-result.json 的 build_id 不一致");
                }
              } catch {
                issues.push("hardware-result.json 不是有效 JSON");
              }
            }

            if (issues.length > 0) {
              action.result = `❌ hardware_app.py 验证失败:\n${issues.map(i => `- ${i}`).join("\n")}`;
              action.args = { output: parsed, issues };
            } else {
              action.result = "✅ hardware_app.py 运行正常，stdout 和 hardware-result.json 均有效";
              action.args = { output: parsed };
            }

            actions.push(action);
            return action.result;
          } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          }
        } catch (err) {
          action.result = `❌ 硬件验证失败: ${err.message}`;
          action.args = { error: err.message };
          actions.push(action);
          return action.result;
        }
      }

      case "get_learnings": {
        // 这个工具的结果由外部注入（见 runAgent）
        action.result = "（经验数据由系统注入）";
        action.args = { task_type: args.task_type };
        actions.push(action);
        return action.result;
      }

      // ─── 硬件调试工具 ───

      case "ssh_exec": {
        if (!hardware?.ssh) {
          action.result = simulateHardwareTool("ssh_exec", args);
          action.args = { command: args.command, simulated: true };
          actions.push(action);
          return action.result;
        }
        try {
          const cmd = args.command || "";
          if (!cmd) {
            action.result = "❌ 缺少 command 参数";
            actions.push(action);
            return action.result;
          }
          // 安全检查：禁止危险命令
          const dangerous = ["rm -rf /", "mkfs", "dd if=", "> /dev/"];
          if (dangerous.some(d => cmd.includes(d))) {
            action.result = "❌ 命令被拒绝：可能存在危险操作";
            actions.push(action);
            return action.result;
          }
          const output = await hardware.ssh(cmd, 15000);
          action.result = output || "（命令执行成功，无输出）";
          action.args = { command: cmd };
          actions.push(action);
          return action.result;
        } catch (err) {
          action.result = `❌ SSH 执行失败: ${err.message}`;
          action.args = { command: args.command, error: err.message };
          actions.push(action);
          return action.result;
        }
      }

      case "get_device_logs": {
        if (!hardware?.ssh) {
          action.result = simulateHardwareTool("get_device_logs", args);
          action.args = { log_type: args.log_type || "recent", simulated: true };
          actions.push(action);
          return action.result;
        }
        try {
          const logType = args.log_type || "recent";
          const lines = args.lines || 50;
          let cmd;
          switch (logType) {
            case "app":
              // 查找 VibeBoard 相关的 Python 进程日志
              cmd = `journalctl --user -u 'vibeboard*' -n ${lines} --no-pager 2>/dev/null || tail -n ${lines} /tmp/vibeboard*.log 2>/dev/null || echo "未找到应用日志"`;
              break;
            case "system":
              cmd = `journalctl -n ${lines} --no-pager --priority=err 2>/dev/null || dmesg | tail -n ${lines}`;
              break;
            case "python":
              // 查找 Python 进程的 stderr 输出
              cmd = `ps aux | grep -i python | grep -v grep; echo "---"; journalctl --user -u 'python*' -n ${lines} --no-pager 2>/dev/null || tail -n ${lines} /tmp/python*.log 2>/dev/null || echo "未找到 Python 日志"`;
              break;
            case "recent":
            default:
              cmd = `echo "=== 最近错误 ===" && journalctl -n ${lines} --no-pager --priority=err 2>/dev/null | tail -20; echo "=== 进程状态 ===" && ps aux | grep -E "(python|vibeboard)" | grep -v grep; echo "=== 最近文件变更 ===" && find /opt/vibeboard -name '*.py' -mmin -10 2>/dev/null | head -10`;
              break;
          }
          const output = await hardware.ssh(cmd, 15000);
          action.result = output || "（无日志输出）";
          action.args = { log_type: logType, lines };
          actions.push(action);
          return action.result;
        } catch (err) {
          action.result = `❌ 获取日志失败: ${err.message}`;
          action.args = { error: err.message };
          actions.push(action);
          return action.result;
        }
      }

      case "deploy_to_device": {
        if (!hardware?.ssh || !hardware?.scp) {
          const hwResult = fileStore["hardware_app.py"]
            ? await executeTool("run_hardware", {})
            : "⚠️ 未提供 hardware_app.py，跳过本地硬件脚本验证";
          action.result = [
            "⚠️ 硬件未配置，已使用模拟部署模式。",
            `模拟目标: /opt/vibeboard/current`,
            `文件数量: ${Object.keys(fileStore).filter(f => f !== "manifest.json").length}`,
            "",
            hwResult,
          ].join("\n");
          action.args = { simulated: true };
          actions.push(action);
          return action.result;
        }
        try {
          const files = Object.keys(fileStore).filter(f => f !== "manifest.json");
          if (files.length === 0) {
            action.result = "❌ 没有文件可部署";
            actions.push(action);
            return action.result;
          }

          // 1. 创建临时目录
          const tmpDir = path.join(os.tmpdir(), `vibeboard-deploy-${Date.now()}`);
          await fs.mkdir(tmpDir, { recursive: true });

          // 2. 写入文件
          for (const name of files) {
            await fs.writeFile(path.join(tmpDir, name), fileStore[name], "utf-8");
          }

          // 3. SCP 上传到设备
          const remoteDir = "/opt/vibeboard/current";
          await hardware.ssh(`mkdir -p ${remoteDir}`, 10000);

          for (const name of files) {
            await hardware.scp(path.join(tmpDir, name), remoteDir, 15000);
          }

          // 4. 运行 hardware_app.py
          let runOutput = "";
          if (fileStore["hardware_app.py"]) {
            try {
              runOutput = await hardware.ssh(`cd ${remoteDir} && python3 hardware_app.py 2>&1`, 15000);
            } catch (e) {
              runOutput = `运行失败: ${e.message}`;
            }
          }

          // 5. 清理临时目录
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

          const resultLines = [
            `✅ 已部署 ${files.length} 个文件到 ${remoteDir}`,
            runOutput ? `\n=== hardware_app.py 输出 ===\n${runOutput}` : "",
          ];

          action.result = resultLines.join("\n");
          action.args = { files: files.length, remoteDir };
          actions.push(action);
          return action.result;
        } catch (err) {
          action.result = `❌ 部署失败: ${err.message}`;
          action.args = { error: err.message };
          actions.push(action);
          return action.result;
        }
      }

      case "check_device_status": {
        if (!hardware?.ssh) {
          action.result = simulateHardwareTool("check_device_status", args);
          action.args = { simulated: true };
          actions.push(action);
          return action.result;
        }
        try {
          const cmd = `echo "=== 设备信息 ===" && uname -a; echo "=== 运行时间 ===" && uptime; echo "=== CPU/内存 ===" && top -bn1 | head -5; echo "=== 磁盘 ===" && df -h / | tail -1; echo "=== Python 进程 ===" && ps aux | grep python | grep -v grep || echo "无 Python 进程"; echo "=== 网络 ===" && ip addr show | grep "inet " | head -3`;
          const output = await hardware.ssh(cmd, 15000);
          action.result = output || "（无法获取设备状态）";
          action.args = {};
          actions.push(action);
          return action.result;
        } catch (err) {
          action.result = `❌ 设备不可达: ${err.message}`;
          action.args = { error: err.message };
          actions.push(action);
          return action.result;
        }
      }

      case "record_lesson": {
        const lessonType = args.type || "pattern";
        const content = normalizeLessonText(args.content || "");
        const context = normalizeLessonText(args.context || "");

        if (!content) {
          action.result = "❌ 缺少 content 参数";
          actions.push(action);
          return action.result;
        }

        const duplicate = lessons.some(lesson =>
          lesson.type === lessonType &&
          normalizeLessonText(lesson.content) === content &&
          normalizeLessonText(lesson.context || "") === context
        );
        if (duplicate) {
          action.result = `✅ 经验已存在，跳过去重 [${lessonType}]: ${content}`;
          action.args = { type: lessonType, content, context, duplicate: true };
          actions.push(action);
          return action.result;
        }

        const lesson = { type: lessonType, content, context, timestamp: Date.now() };
        lessons.push(lesson);

        // 同时写入项目级 LESSONS.md（追加）
        try {
          const lessonsFile = "LESSONS.md";
          const existing = fileStore[lessonsFile] || "";
          const typeEmoji = { pitfall: "⚠️", pattern: "✅", fix: "🔧" }[lessonType] || "📝";
          const entryText = `- ${typeEmoji} **${lessonType}**: ${content}${context ? ` (${context})` : ""}`;
          if (!normalizeLessonText(existing).includes(normalizeLessonText(entryText))) {
            fileStore[lessonsFile] = existing
              ? existing.trimEnd() + "\n" + entryText + "\n"
              : `# VibeBoard 项目经验\n\n## 自动记录的经验教训\n${entryText}\n`;
          }
        } catch {}

        action.result = `✅ 已记录经验 [${lessonType}]: ${content}`;
        action.args = { type: lessonType, content, context };
        actions.push(action);
        return action.result;
      }

      case "done": {
        action.result = `完成：${args.summary}`;
        action.args = {
          summary: args.summary,
          what_worked: args.what_worked || [],
          what_failed: args.what_failed || [],
        };
        action.done = true;
        actions.push(action);
        return action.result;
      }

      default:
        return `未知工具: ${name}`;
    }
  }

  return { executeTool, actions, lessons, getFileStore: () => fileStore };
}

// ─── Agent Loop ───

/**
 * Run the coding agent with auto-verification.
 */
export async function runAgent(settings, prompt, fileStore, history = [], onAction = null, userPreferences = {}, experienceStore = null, hardware = null) {
  const { executeTool, actions, lessons: sessionLessons, getFileStore } = createToolExecutor(fileStore, hardware);
  const isEditing = Object.keys(fileStore).length > 0;

  // 获取经验教训
  let lessons = { pitfalls: [], patterns: [], fixes: [] };
  if (experienceStore) {
    try {
      lessons = experienceStore.getLessons("general", 5);
    } catch {}
  }

  // Build system prompt
  const systemPrompt = buildAgentSystemPrompt(isEditing, fileStore, userPreferences, lessons);

  // Build messages
  const messages = [
    { role: "system", content: systemPrompt }
  ];

  // Add sanitized conversation history. UI messages may use the visual role
  // "agent", but chat-completions providers expect "assistant".
  for (const msg of normalizeAgentHistory(history)) {
    messages.push(msg);
  }

  // Add user prompt
  messages.push({
    role: "user",
    content: isEditing
      ? `请修改当前项目：${prompt}\n\n当前项目文件：${Object.keys(fileStore).filter(f => f !== "manifest.json").join(", ")}`
      : `请创建一个新项目：${prompt}`
  });

  const maxIterations = Number(settings.maxIterations || process.env.VIBEBOARD_AGENT_MAX_ITERATIONS || DEFAULT_MAX_ITERATIONS);
  const maxVerificationAttempts = Number(settings.maxVerificationAttempts || process.env.VIBEBOARD_AGENT_MAX_VERIFICATION_ATTEMPTS || DEFAULT_MAX_VERIFICATION_ATTEMPTS);
  let summary = "";
  let whatWorked = [];
  let whatFailed = [];
  let verificationAttempts = 0;
  let lastVerifyResult = null;

  for (let i = 0; i < maxIterations; i++) {
    const response = await callLLMWithTools(settings, messages);

    if (response?.error) {
      return {
        success: false,
        summary: response.error.message,
        error: response.error,
        actions,
        files: getFileStore(),
        whatWorked,
        whatFailed,
      };
    }

    messages.push(response);

    const toolCalls = response.tool_calls || [];

    if (toolCalls.length === 0) {
      const completionIssues = getCompletionIssues(getFileStore());
      if (completionIssues.length > 0) {
        const noToolResponses = messages.filter(msg => msg.role === "user" && msg.content?.includes("请继续用工具完成代码生成")).length;
        if (noToolResponses >= MAX_NO_TOOL_RESPONSES) {
          summary = `Agent 未生成完整项目: ${completionIssues.join("; ")}`;
          break;
        }
        messages.push({
          role: "user",
          content: [
            "请继续用工具完成代码生成，不要只用文字回答。",
            `当前缺少或不完整: ${completionIssues.join("; ")}`,
            "必须创建或修复所有必需文件后再调用 done。"
          ].join("\n"),
        });
        continue;
      }
      summary = response.content || "完成";

      // Some providers answer with final text instead of calling the done tool,
      // even after creating all required files. Treat that as a completion
      // candidate, but still run the same auto-verification gate used by done.
      if (verificationAttempts < maxVerificationAttempts) {
        lastVerifyResult = await autoVerify(fileStore, executeTool, actions, onAction);

        if (!lastVerifyResult.ok) {
          verificationAttempts++;
          whatFailed.push(`验证失败 (第${verificationAttempts}次): ${lastVerifyResult.issues.join("; ")}`);
          messages.push({
            role: "user",
            content: `## ⚠️ 自动验证发现问题（第${verificationAttempts}次）\n\n${lastVerifyResult.issues.map(issue => `- ${issue}`).join("\n")}\n\n请优先修复上述问题，不要重写无关文件。修复后再次调用 done。`,
          });
          continue;
        }

        whatWorked.push("所有自动验证通过");
      }

      for (const lesson of sessionLessons) {
        if (lesson.type === "pitfall") whatFailed.push(lesson.content);
        else whatWorked.push(lesson.content);
      }

      if (experienceStore) {
        try {
          experienceStore.recordExperience({
            taskType: detectTaskType(prompt),
            promptSummary: prompt.slice(0, 200),
            whatWorked,
            whatFailed,
            fixesApplied: lastVerifyResult?.fixes || [],
            verificationResult: lastVerifyResult,
            success: true,
          });
        } catch {}
      }

      return { success: true, summary, actions, files: getFileStore(), whatWorked, whatFailed, lessons: sessionLessons };
    }

    for (const tc of toolCalls) {
      const fnName = tc.function.name;
      let args = {};
      try {
        args = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments;
      } catch {}

      // 拦截 get_learnings，注入经验数据
      if (fnName === "get_learnings") {
        const taskType = args.task_type || "general";
        const learnings = experienceStore ? experienceStore.getLessons(taskType, 5) : lessons;
        const learnText = [
          learnings.pitfalls.length > 0 ? `## 常见陷阱（请避免）\n${learnings.pitfalls.map(p => `- ${p}`).join("\n")}` : "",
          learnings.patterns.length > 0 ? `## 成功模式（推荐使用）\n${learnings.patterns.map(p => `- ${p}`).join("\n")}` : "",
          learnings.fixes.length > 0 ? `## 有效修复方法\n${learnings.fixes.map(f => `- ${f}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n") || "暂无相关经验。";

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: learnText,
        });

        if (onAction) onAction({ tool: fnName, args, result: learnText });
        continue;
      }

      const result = await executeTool(fnName, args);

      if (onAction) {
        onAction({ tool: fnName, args, result });
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });

      // 拦截 done，执行自动验证
      if (fnName === "done") {
        summary = args.summary || "完成";
        whatWorked = args.what_worked || [];
        whatFailed = args.what_failed || [];

        // 自动验证循环
        if (verificationAttempts < maxVerificationAttempts) {
          lastVerifyResult = await autoVerify(fileStore, executeTool, actions, onAction);

          if (!lastVerifyResult.ok) {
            verificationAttempts++;
            whatFailed.push(`验证失败 (第${verificationAttempts}次): ${lastVerifyResult.issues.join("; ")}`);

            // 注入修复提示，继续循环
            messages.push({
              role: "user",
              content: `## ⚠️ 自动验证发现问题（第${verificationAttempts}次）\n\n${lastVerifyResult.issues.map(issue => `- ${issue}`).join("\n")}\n\n请优先修复上述问题，不要重写无关文件。修复后再次调用 done。`,
            });

            // 移除 done 标记，继续循环
            continue;
          }

          // 验证通过
          whatWorked.push("所有自动验证通过");
        }

        // 合并 sessionLessons 到经验记录
        for (const lesson of sessionLessons) {
          if (lesson.type === "pitfall") whatFailed.push(lesson.content);
          else whatWorked.push(lesson.content);
        }

        // 记录经验
        if (experienceStore) {
          try {
            experienceStore.recordExperience({
              taskType: detectTaskType(prompt),
              promptSummary: prompt.slice(0, 200),
              whatWorked,
              whatFailed,
              fixesApplied: lastVerifyResult?.fixes || [],
              verificationResult: lastVerifyResult,
              success: true,
            });
          } catch {}
        }

        return { success: true, summary, actions, files: getFileStore(), whatWorked, whatFailed, lessons: sessionLessons };
      }
    }
  }

  return {
    success: false,
    summary: summary || `达到最大迭代次数（${maxIterations}），未确认完成`,
    actions,
    files: getFileStore(),
    whatWorked,
    whatFailed,
    lessons: sessionLessons,
  };
}

// ─── Auto-Verification ───

async function autoVerify(fileStore, executeTool, actions, onAction) {
  const issues = [];
  const fixes = [];

  // Step 1: Syntax check
  const syntaxResult = await executeTool("verify_syntax", {});
  if (onAction) onAction({ tool: "verify_syntax", args: {}, result: syntaxResult });
  if (syntaxResult.includes("❌")) {
    issues.push(`语法问题: ${syntaxResult.split("\n").filter(l => l.includes("❌")).join("; ")}`);
  }

  // Step 2: Render check (screenshot)
  if (fileStore["index.html"] && fileStore["app.js"]) {
    const renderResult = await executeTool("verify_render", {});
    if (onAction) onAction({ tool: "verify_render", args: {}, result: renderResult });
    if (renderResult.includes("❌")) {
      issues.push(`渲染问题: ${renderResult.split("\n").filter(l => l.includes("❌")).join("; ")}`);
    }
  }

  // Step 3: Hardware check
  if (fileStore["hardware_app.py"]) {
    const hwResult = await executeTool("run_hardware", {});
    if (onAction) onAction({ tool: "run_hardware", args: {}, result: hwResult });
    if (hwResult.includes("❌")) {
      issues.push(`硬件问题: ${hwResult.split("\n").filter(l => l.includes("❌")).join("; ")}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    fixes,
  };
}

// ─── Helpers ───

function detectTaskType(prompt) {
  const lower = prompt.toLowerCase();
  if (/时钟|clock|时间/.test(lower)) return "clock";
  if (/游戏|game|贪吃蛇|snake|赛车/.test(lower)) return "game";
  if (/天气|weather/.test(lower)) return "weather";
  if (/动画|animation/.test(lower)) return "animation";
  if (/音乐|music|播放/.test(lower)) return "music";
  if (/计时|timer|倒计时/.test(lower)) return "timer";
  return "general";
}

function normalizeAgentHistory(history = []) {
  if (!Array.isArray(history)) return [];
  const normalized = [];
  for (const raw of history.slice(-MAX_HISTORY_MESSAGES)) {
    const role = normalizeChatRole(raw?.role);
    if (!role) continue;
    const content = String(raw?.content || "").trim().slice(0, MAX_HISTORY_CONTENT_CHARS);
    if (!content) continue;
    normalized.push({ role, content });
  }
  return normalized;
}

function normalizeChatRole(role) {
  if (role === "agent") return "assistant";
  if (role === "assistant" || role === "user" || role === "system") return role;
  return null;
}

function isWritableAgentFile(filePath) {
  return AGENT_WRITABLE_FILES.has(String(filePath || ""));
}

function getCompletionIssues(files = {}) {
  const issues = [];
  for (const fileName of REQUIRED_RUNTIME_FILES) {
    if (typeof files[fileName] !== "string" || !files[fileName].trim()) {
      issues.push(`${fileName} 缺失`);
    }
  }
  const indexSource = files["index.html"] || "";
  if (indexSource && (!indexSource.includes("./style.css") || !indexSource.includes("./app.js"))) {
    issues.push("index.html 未使用 ./style.css 和 ./app.js");
  }
  const appSource = files["app.js"] || "";
  if (appSource) {
    for (const rule of REQUIRED_APP_SNIPPETS) {
      if (!appSource.includes(rule.text)) issues.push(rule.message);
    }
    for (const method of ["getStatus", "getProgramResult", "getSnapshot"]) {
      if (!appSource.includes(method)) issues.push(`window.VibeBoardHardware 缺少 ${method}()`);
    }
  }
  const hardwareSource = files["hardware_app.py"] || "";
  if (hardwareSource) {
    for (const rule of REQUIRED_HARDWARE_SNIPPETS) {
      if (!hardwareSource.includes(rule.text)) issues.push(rule.message);
    }
    if (!hardwareSource.includes("print(") || !hardwareSource.includes("json.dumps")) {
      issues.push("hardware_app.py 必须 print(json.dumps(...)) 到 stdout");
    }
  }
  return [...new Set(issues)];
}

function normalizeLessonText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function validateJavaScriptSyntax(source, label, tmpDir) {
  const issues = [];
  const filePath = path.join(tmpDir, label);
  await fs.writeFile(filePath, source, "utf-8");
  try {
    await execFileText(process.execPath, ["--check", filePath], { cwd: tmpDir, timeout: 5000 });
  } catch (err) {
    issues.push(`${label}: JS 语法错误 - ${(err.stderr || err.stdout || err.message).trim()}`);
    return issues;
  }

  try {
    new Function(source);
  } catch (err) {
    issues.push(`${label}: JS 解析错误 - ${err.message}`);
  }
  return issues;
}

async function validatePythonSyntax(source, label, tmpDir) {
  const filePath = path.join(tmpDir, label);
  await fs.writeFile(filePath, source, "utf-8");
  const candidates = process.platform === "win32"
    ? [process.env.PYTHON || "python", "py"]
    : [process.env.PYTHON || "python3", "python"];
  const errors = [];

  for (const bin of candidates) {
    try {
      await execFileText(bin, ["-m", "py_compile", filePath], { cwd: tmpDir, timeout: 5000 });
      return [];
    } catch (err) {
      errors.push(`${bin}: ${(err.stderr || err.stdout || err.message).trim()}`);
    }
  }

  return [`${label}: Python 编译失败 - ${errors.join("; ")}`];
}

async function ensureRenderSupport() {
  try {
    const { chromium } = await import("playwright");
    if (!chromium) throw new Error("Playwright chromium 不可用");
  } catch (err) {
    throw new Error(`Playwright Chromium 未就绪: ${err.message}`);
  }
}

async function startVerificationServer(rootDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname === "/api/status") {
        sendJson(res, 200, mockBoardStatus());
        return;
      }

      const cleanPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const relative = cleanPath.replace(/^\/+/, "");
      const target = path.resolve(rootDir, relative);
      const root = path.resolve(rootDir);
      if (target !== root && !target.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      let body = await fs.readFile(target);
      res.writeHead(200, { "Content-Type": contentTypeFor(target), "Cache-Control": "no-store" });
      res.end(body);
    } catch (err) {
      if ((req.url || "").includes("hardware-result.json")) {
        sendJson(res, 200, mockHardwareResult());
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
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

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function mockBoardStatus() {
  return {
    ok: true,
    connected: true,
    hostname: "vibeboard-mock",
    model: "RK3566 Taishan Gray Mock",
    kernel: "mock",
    time: new Date().toISOString(),
    uptime: "mock",
    cpu_temp: 42,
    memory: { percent: 38, used_h: "380M", total_h: "1G" },
    disk: { percent: 24, used_h: "2.4G", total_h: "10G" },
    network: { wifi: "mock-wifi", addresses: ["127.0.0.1"], gateway: "127.0.0.1" },
    services: { ssh: "mock", frpc: "mock", display: "mock" },
  };
}

function mockHardwareResult() {
  return {
    build_id: "mock-build",
    runtime: "mock",
    available_apis: ["/api/status", "./hardware-result.json"],
  };
}

function simulateHardwareTool(toolName, args = {}) {
  switch (toolName) {
    case "ssh_exec":
      return `⚠️ 硬件未配置，已使用模拟 SSH。\n命令未发送到真实设备: ${args.command || "(empty)"}`;
    case "get_device_logs":
      return "⚠️ 硬件未配置，已返回模拟日志。\n=== recent ===\nmock: no hardware connection configured";
    case "check_device_status":
      return JSON.stringify(mockBoardStatus(), null, 2);
    default:
      return "⚠️ 硬件未配置，已使用模拟模式。";
  }
}

async function runPythonScript(scriptPath, cwd, timeoutMs) {
  const candidates = process.platform === "win32"
    ? [process.env.PYTHON || "python", "py"]
    : [process.env.PYTHON || "python3", "python"];
  const errors = [];

  for (const bin of candidates) {
    try {
      return await execFileText(bin, [scriptPath], { cwd, timeout: timeoutMs });
    } catch (err) {
      errors.push(`${bin}: ${err.message}`);
    }
  }

  const error = new Error(`无法运行 Python。尝试过: ${errors.join("; ")}`);
  error.stderr = errors.join("\n");
  throw error;
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf-8" }, (error, stdout, stderr) => {
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

function parseJsonOutput(output) {
  const trimmed = String(output || "").trim();
  if (!trimmed) throw new Error("empty JSON output");
  try {
    return JSON.parse(trimmed);
  } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("invalid JSON output");
}

// ─── LLM Call with Function Calling ───

function generationTools() {
  return AGENT_TOOLS.filter(tool => GENERATION_TOOL_NAMES.has(tool.function?.name));
}

async function callLLMWithTools(settings, messages) {
  const { chatCompletionsUrl } = await import("./modelSettings.mjs");
  const timeoutMs = Number(settings.llmTimeoutMs || LLM_TIMEOUT_MS);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const endpoint = chatCompletionsUrl(settings.baseUrl);
    const payload = {
      model: settings.model,
      messages,
      tools: generationTools(),
      tool_choice: "auto",
      temperature: 0.1,
      max_tokens: 8000,
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const providerMessage = extractProviderError(data) || `HTTP ${res.status}`;
      const error = createLlmError({
        type: "llm_failed",
        code: "LLM_CALL_FAILED",
        providerMessage,
        status: res.status,
        model: settings.model,
        endpoint,
      });
      console.error("[agent] LLM error:", error.message);
      return { error };
    }

    const message = data.choices?.[0]?.message;
    if (!message) {
      return {
        error: createLlmError({
          type: "llm_failed",
          code: "LLM_CALL_FAILED",
          providerMessage: "Response did not include choices[0].message",
          status: res.status,
          model: settings.model,
          endpoint,
        })
      };
    }
    return message;
  } catch (err) {
    clearTimeout(timeout);
    const isAbort = err.name === "AbortError";
    const error = createLlmError({
      type: isAbort ? "llm_timeout" : "llm_failed",
      code: isAbort ? "LLM_TIMEOUT" : "LLM_CALL_FAILED",
      providerMessage: isAbort ? `Timed out after ${timeoutMs}ms` : err.message,
      model: settings.model,
      endpoint: chatCompletionsUrl(settings.baseUrl),
    });
    console.error("[agent] LLM call failed:", error.message);
    return { error };
  }
}

function extractProviderError(data) {
  if (!data || typeof data !== "object") return "";
  const error = data.error;
  if (typeof error === "string") return error;
  if (error?.message) return String(error.message);
  if (data.message) return String(data.message);
  return "";
}

function createLlmError({ type, code, providerMessage, status = null, model = "", endpoint = "" }) {
  const details = [
    status ? `HTTP ${status}` : "",
    model ? `model=${model}` : "",
    providerMessage ? `provider=${providerMessage}` : "",
  ].filter(Boolean).join("; ");
  return {
    type,
    code,
    status,
    model,
    endpoint: redactUrl(endpoint),
    providerMessage,
    message: `${code}: ${details || providerMessage || "model request failed"}`,
  };
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return String(value || "");
  }
}

// ─── System Prompt ───

function buildAgentSystemPrompt(isEditing, fileStore, userPreferences = {}, lessons = { pitfalls: [], patterns: [], fixes: [] }) {
  const fileList = Object.keys(fileStore).filter(f => f !== "manifest.json");

  // 用户偏好
  const prefEntries = Object.entries(userPreferences);
  const memorySection = prefEntries.length > 0
    ? `\n## 用户偏好记忆\n${prefEntries.map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\n")}\n请在生成代码时参考这些偏好。`
    : "";

  // 经验教训
  const lessonSections = [];
  if (lessons.pitfalls.length > 0) {
    lessonSections.push(`### ⚠️ 常见陷阱（请避免）\n${lessons.pitfalls.map(p => `- ${p}`).join("\n")}`);
  }
  if (lessons.patterns.length > 0) {
    lessonSections.push(`### ✅ 成功模式（推荐使用）\n${lessons.patterns.map(p => `- ${p}`).join("\n")}`);
  }
  if (lessons.fixes.length > 0) {
    lessonSections.push(`### 🔧 有效修复方法\n${lessons.fixes.map(f => `- ${f}`).join("\n")}`);
  }
  const lessonSection = lessonSections.length > 0
    ? `\n## 过去的经验教训\n${lessonSections.join("\n\n")}`
    : "";

  return `你是 VibeBoard Coding Agent，一个可迭代、可自我验证、可自我学习的编程助手。

## 硬件环境
- 屏幕：480x360 像素 IPS LCD，无触摸
- 芯片：RK3566 (4x Cortex-A55)
- 系统：Debian 11，Python 3.9
- 输入：3个GPIO物理按钮（KEY1/KEY2/KEY3）
- 主题：深色背景 + 浅色文字

## 你的工作流程

### Phase 1: 准备
1. 用 get_learnings 查询过去的经验教训
2. 用 read_file / list_files 了解项目结构（如果是编辑）
3. 用 search_code 找到要修改的位置

### Phase 2: 编码
4. 用 create_file 或 edit_file 生成/修改代码
5. 完成一组相关修改后用 verify_syntax 做轻量检查，不要每改一行都验证
6. 生成阶段只能创建或修改 index.html、style.css、app.js、hardware_app.py。不要创建 _encode.py、_run.sh、test 文件或任何临时辅助文件

### Phase 3: 自我验证
7. 主动调用 done 后，系统会自动执行语法、渲染和硬件脚本验证
8. 如果自动验证失败，系统会把具体问题反馈给你；你只修复这些问题再 done
9. 生成阶段不要 SSH、不要部署、不要运行外部脚本；真机部署由用户后续点击按钮触发

### Phase 4: 完成
10. 用 done 报告完成，包含 what_worked 和 what_failed

## 关键原则
- **精准编辑**：用 edit_file 的 old_text → new_text，不要重写整个文件
- **先读后改**：修改前先 read_file 确认当前内容
- **最小改动**：只改用户要求的部分，其他保持不变
- **验证节奏**：语法验证可多用；截图和硬件验证留给 done 自动验证或关键疑难问题
- **自我修复**：验证失败时自动修复，不要放弃
- **实时记录**：发现陷阱或好模式时立即用 record_lesson 记录，不要等 done
- **经验积累**：记录什么有效、什么失败

${isEditing ? `## 当前项目\n项目已有 ${fileList.length} 个文件：${fileList.join(", ")}\n用户要求修改这个已有的项目。先读取相关文件，再做修改。` : `## 新项目\n用户要求创建一个新项目。用 create_file 创建所有需要的文件。\n必须创建：index.html, style.css, app.js, hardware_app.py`}

## 文件规范
${validationRulesText("zh").map(rule => `- ${rule}`).join("\n")}

开始工作吧。
${memorySection}${lessonSection}`;
}
