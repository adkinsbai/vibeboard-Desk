/**
 * VibeBoard Coding Agent
 * 
 * A tool-calling agent that thinks → acts → verifies, just like real coding agents.
 * Instead of generating all files at once, it:
 *   1. Reads existing code (if editing)
 *   2. Searches for what to change
 *   3. Makes targeted edits
 *   4. Verifies the result
 */

import fs from "fs/promises";
import path from "path";

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
          path: {
            type: "string",
            description: "文件名，如 'app.js', 'index.html', 'style.css'"
          }
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
          path: {
            type: "string",
            description: "文件名，如 'app.js'"
          },
          query: {
            type: "string",
            description: "要搜索的文本"
          }
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
          path: {
            type: "string",
            description: "文件名"
          },
          old_text: {
            type: "string",
            description: "要替换的原始文本（必须精确匹配）"
          },
          new_text: {
            type: "string",
            description: "替换后的新文本"
          }
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
          path: {
            type: "string",
            description: "文件名"
          },
          content: {
            type: "string",
            description: "文件的完整内容"
          }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "verify_syntax",
      description: "验证当前代码的语法是否正确（JS/HTML/CSS）。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "当所有修改完成时调用。报告你做了什么。",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "用中文简要说明你做了哪些修改"
          }
        },
        required: ["summary"]
      }
    }
  }
];

// ─── Tool Implementations ───

export function createToolExecutor(fileStore) {
  // fileStore: { "app.js": "...", "index.html": "...", ... }
  // Modified in-place by tools

  const actions = []; // Log of all actions for frontend display

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
        // Truncate very long files for context
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
        const content = fileStore[filePath];

        if (content === undefined) {
          action.result = `错误：文件 '${filePath}' 不存在`;
          action.args = { path: filePath };
          actions.push(action);
          return action.result;
        }

        const idx = content.indexOf(oldText);
        if (idx === -1) {
          // Try fuzzy match: trim whitespace
          const trimmed = oldText.trim();
          const trimmedIdx = content.indexOf(trimmed);
          if (trimmedIdx === -1) {
            action.result = `错误：在 ${filePath} 中找不到要替换的文本。请先用 search_code 或 read_file 确认文本存在。`;
            action.args = { path: filePath, old_text_preview: oldText.slice(0, 80) };
            actions.push(action);
            return action.result;
          }
          // Use trimmed version
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
        fileStore[filePath] = content;
        action.result = `已创建/重写 ${filePath}（${content.length} 字符）`;
        action.args = { path: filePath, size: content.length };
        actions.push(action);
        return action.result;
      }

      case "verify_syntax": {
        const results = [];
        if (fileStore["app.js"]) {
          try {
            // Basic syntax check: look for common errors
            const js = fileStore["app.js"];
            if (js.includes("{{") || js.includes("}}")) {
              results.push("app.js: 疑似模板语法错误");
            }
            // Check balanced braces
            const open = (js.match(/{/g) || []).length;
            const close = (js.match(/}/g) || []).length;
            if (open !== close) {
              results.push(`app.js: 花括号不匹配（{ ${open}个, } ${close}个）`);
            }
            if (!js.includes("BUILD_ID")) {
              results.push("app.js: 缺少 BUILD_ID 定义");
            }
            if (!js.includes("VibeBoardHardware")) {
              results.push("app.js: 缺少 VibeBoardHardware 定义");
            }
            results.push("app.js: 基本检查通过");
          } catch (e) {
            results.push(`app.js: 检查失败 - ${e.message}`);
          }
        }
        if (fileStore["index.html"]) {
          const html = fileStore["index.html"];
          if (!html.includes("style.css")) {
            results.push("index.html: 未引用 style.css");
          }
          if (!html.includes("app.js")) {
            results.push("index.html: 未引用 app.js");
          }
          results.push("index.html: 基本检查通过");
        }
        action.result = results.join("\n");
        action.args = {};
        actions.push(action);
        return action.result;
      }

      case "done": {
        action.result = `完成：${args.summary}`;
        action.args = { summary: args.summary };
        action.done = true;
        actions.push(action);
        return action.result;
      }

      default:
        return `未知工具: ${name}`;
    }
  }

  return { executeTool, actions, getFileStore: () => fileStore };
}

// ─── Agent Loop ───

/**
 * Run the coding agent.
 * @param {Object} settings - Model settings
 * @param {string} prompt - User's request
 * @param {Object} fileStore - Current files (modified in-place)
 * @param {Array} history - Conversation history
 * @param {Function} onAction - Callback for each action (for UI updates)
 * @returns {{ success, summary, actions, files }}
 */
export async function runAgent(settings, prompt, fileStore, history = [], onAction = null) {
  const { executeTool, actions, getFileStore } = createToolExecutor(fileStore);
  const isEditing = Object.keys(fileStore).length > 0;

  // Build system prompt
  const systemPrompt = buildAgentSystemPrompt(isEditing, fileStore);

  // Build messages
  const messages = [
    { role: "system", content: systemPrompt }
  ];

  // Add conversation history (compressed)
  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Add user prompt
  messages.push({
    role: "user",
    content: isEditing
      ? `请修改当前项目：${prompt}\n\n当前项目文件：${Object.keys(fileStore).filter(f => f !== "manifest.json").join(", ")}`
      : `请创建一个新项目：${prompt}`
  });

  const MAX_ITERATIONS = 15;
  let summary = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Call LLM with tools
    const response = await callLLMWithTools(settings, messages);

    if (!response) {
      return { success: false, summary: "LLM 调用失败", actions, files: getFileStore() };
    }

    // Add assistant message to history
    messages.push(response);

    // Check if LLM called any tools
    const toolCalls = response.tool_calls || [];

    if (toolCalls.length === 0) {
      // No tool calls — LLM might have just responded with text
      summary = response.content || "完成";
      break;
    }

    // Execute each tool call
    for (const tc of toolCalls) {
      const fnName = tc.function.name;
      let args = {};
      try {
        args = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments;
      } catch {}

      const result = await executeTool(fnName, args);

      // Notify frontend of action
      if (onAction) {
        onAction({ tool: fnName, args, result });
      }

      // Add tool result to messages
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result
      });

      // If done, stop
      if (fnName === "done") {
        summary = args.summary || "完成";
        return { success: true, summary, actions, files: getFileStore() };
      }
    }
  }

  return {
    success: true,
    summary: summary || "达到最大迭代次数",
    actions,
    files: getFileStore()
  };
}

// ─── LLM Call with Function Calling ───

async function callLLMWithTools(settings, messages) {
  const { chatCompletionsUrl } = await import("./modelSettings.mjs");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const payload = {
      model: settings.model,
      messages,
      tools: AGENT_TOOLS,
      tool_choice: "auto",
      temperature: 0.1,
      max_tokens: 8000
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
    clearTimeout(timeout);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || `HTTP ${res.status}`;
      console.error("[agent] LLM error:", msg);
      return null;
    }

    return data.choices?.[0]?.message || null;
  } catch (err) {
    clearTimeout(timeout);
    console.error("[agent] LLM call failed:", err.message);
    return null;
  }
}

// ─── System Prompt ───

function buildAgentSystemPrompt(isEditing, fileStore) {
  const fileList = Object.keys(fileStore).filter(f => f !== "manifest.json");

  return `你是 VibeBoard Coding Agent，一个运行在嵌入式硬件上的编程助手。

## 硬件环境
- 屏幕：480x360 像素 IPS LCD，无触摸
- 芯片：RK3566 (4x Cortex-A55)
- 系统：Debian 11，Python 3.9
- 输入：3个GPIO物理按钮（KEY1/KEY2/KEY3）
- 主题：深色背景 + 浅色文字

## 你的工作方式
你通过调用工具来完成任务，就像一个真正的程序员：
1. 先用 read_file / list_files 了解项目结构
2. 用 search_code 找到要修改的位置
3. 用 edit_file 做精准修改（不要重写整个文件）
4. 用 verify_syntax 检查语法
5. 最后用 done 报告完成

## 关键原则
- **精准编辑**：用 edit_file 的 old_text → new_text，不要重写整个文件
- **先读后改**：修改前先 read_file 确认当前内容
- **最小改动**：只改用户要求的部分，其他保持不变
- **验证完成**：编辑后用 verify_syntax 检查

${isEditing ? `## 当前项目
项目已有 ${fileList.length} 个文件：${fileList.join(", ")}
用户要求修改这个已有的项目。先读取相关文件，再做修改。`
: `## 新项目
用户要求创建一个新项目。用 create_file 创建所有需要的文件。
必须创建：index.html, style.css, app.js, hardware_app.py`}

## 文件规范
- index.html：必须引用 "./style.css" 和 "./app.js"
- app.js：必须定义 const BUILD_ID, const PROMPT, window.VibeBoardHardware
- app.js：必须 fetch "/api/status" 和 "./hardware-result.json"
- hardware_app.py：必须输出 JSON，包含 runtime 和 build_id 字段
- style.css：480x360 固定尺寸，overflow hidden，深色主题
- 不使用外部库、CDN、emoji 图标

开始工作吧。`;
}
