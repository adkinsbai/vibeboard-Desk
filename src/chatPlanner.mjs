import { chatCompletionsUrl } from "./modelSettings.mjs";
import { normalizeProjectMemory } from "./conversationStore.mjs";

const VALID_INTENTS = new Set(["chat", "clarify", "build_ready"]);

export async function planChatWithModel(settings, rawMessages = [], preferences = {}, projectMemoryOrFetch = {}, fetchImpl = globalThis.fetch) {
  let projectMemory = projectMemoryOrFetch;
  if (typeof projectMemoryOrFetch === "function") {
    fetchImpl = projectMemoryOrFetch;
    projectMemory = {};
  }
  const messages = [
    { role: "system", content: buildPlannerSystemPrompt(preferences, projectMemory) },
    ...normalizePlannerMessages(rawMessages),
  ];

  const response = await fetchImpl(chatCompletionsUrl(settings.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature: 0.2,
      max_tokens: 1600,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(providerErrorMessage(data) || `HTTP ${response.status}`);
    error.type = "llm_failed";
    error.code = "LLM_CALL_FAILED";
    error.status = response.status;
    error.model = settings.model;
    error.endpoint = chatCompletionsUrl(settings.baseUrl);
    error.providerMessage = providerErrorMessage(data);
    throw error;
  }

  return parseChatPlan(data.choices?.[0]?.message?.content || "", projectMemory);
}

export function parseChatPlan(rawContent, fallbackMemory = {}) {
  const existingMemory = normalizeProjectMemory(fallbackMemory);
  const raw = String(rawContent || "").trim();
  if (!raw) {
    return {
      intent: "chat",
      reply: "我没有收到有效回复。请再说一次你的想法。",
      understanding: [],
      planned_changes: [],
      target: "chat",
      ready_to_build: false,
      build_prompt: "",
      project_memory: existingMemory,
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {}
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      intent: "chat",
      reply: raw,
      understanding: [],
      planned_changes: [],
      target: "chat",
      ready_to_build: false,
      build_prompt: "",
      project_memory: existingMemory,
    };
  }

  const intent = VALID_INTENTS.has(parsed.intent) ? parsed.intent : "chat";
  const projectMemory = normalizeProjectMemory(parsed.project_memory || existingMemory);
  const buildPrompt = String(parsed.build_prompt || "").trim();
  const readyToBuild = intent === "build_ready" && parsed.ready_to_build === true && buildPrompt.length > 0;
  if (readyToBuild) {
    projectMemory.build_prompt = buildPrompt;
  }

  return {
    intent: readyToBuild ? "build_ready" : intent === "build_ready" ? "clarify" : intent,
    reply: String(parsed.reply || "").trim() || "我已经理解了，请继续补充你的想法。",
    understanding: stringList(parsed.understanding),
    planned_changes: stringList(parsed.planned_changes),
    target: normalizeTarget(parsed.target, readyToBuild),
    ready_to_build: readyToBuild,
    build_prompt: readyToBuild ? buildPrompt : "",
    project_memory: projectMemory,
  };
}

function normalizeTarget(value, readyToBuild) {
  const target = String(value || "").trim();
  if (["chat", "new_project", "edit_current_project"].includes(target)) return target;
  return readyToBuild ? "new_project" : "chat";
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || "").trim()).filter(Boolean).slice(0, 8);
}

function normalizePlannerMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages
    .slice(-20)
    .map(message => ({
      role: message?.role === "assistant" || message?.role === "agent" ? "assistant" : "user",
      content: String(message?.content || "").trim(),
    }))
    .filter(message => message.content);
}

function buildPlannerSystemPrompt(preferences = {}, projectMemory = {}) {
  const preferenceText = Object.entries(preferences)
    .map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
    .join("\n");
  const memory = normalizeProjectMemory(projectMemory);

  return `你是 VibeBoard 的对话规划器，负责先和用户自然讨论，再决定是否可以开始生成小屏应用。

硬件约束：
- 屏幕固定为 480x360。
- 目标是泰山派/RK3566 上的小屏 Web 应用。
- 生成前需要把需求、交互、数据来源、视觉重点说清楚。

你必须根据完整对话理解用户意图。不要让后端代码靠关键词判断意图。

只返回一个 JSON 对象，不要输出 JSON 之外的文字：
{
  "intent": "chat" | "clarify" | "build_ready",
  "reply": "给用户看的自然中文回复",
  "understanding": ["用用户能看懂的话列出你理解到的关键需求"],
  "planned_changes": ["如果用户确认构建或修改，你准备执行的具体工程动作"],
  "target": "chat" | "new_project" | "edit_current_project",
  "ready_to_build": true | false,
  "build_prompt": "只有 ready_to_build 为 true 时填写完整、可直接交给代码生成器的需求；否则为空字符串",
  "project_memory": {
    "summary": "当前项目的一句话摘要",
    "goal": "用户最终想做什么",
    "requirements": ["已经明确的功能需求"],
    "constraints": ["屏幕、数据来源、交互、视觉、硬件等约束"],
    "open_questions": ["仍需用户确认的问题"],
    "decisions": ["对话中已经确定的方案或取舍"],
    "build_prompt": "当前最完整的构建需求；只有需求整理完整时才填写，否则为空字符串"
  }
}

决策原则：
- 普通聊天、能力询问、解释流程、讨论方案时，intent 为 chat，ready_to_build 为 false。
- 信息不足、方案还没理清时，intent 为 clarify，reply 里提出必要问题，ready_to_build 为 false。
- 只有当对话中已经有完整可执行需求，并且用户明确授权开始生成时，intent 才能是 build_ready，ready_to_build 才能为 true。
- 当用户表达“不满意”“继续修改”“改一下当前预览”等反馈时，先在 reply/understanding/planned_changes 里明确说明你理解到什么、准备如何改；如果需求足够明确，target 应为 edit_current_project，并等待用户点击确认后再构建。
- ready_to_build 为 true 时，reply 必须包含“我理解你要的是...”和“我准备这样做...”的意思，不能只说“需求已整理”。
- understanding 至少列出 2 条关键理解；planned_changes 至少列出 2 条具体执行项。信息不足时 planned_changes 可以为空，但 reply 必须追问缺失信息。
- build_prompt 必须整合上下文，写成完整需求，不能只写“开始吧”或“确认”。
- 每次回复都要更新 project_memory。它是当前 project 的独立记忆，只能基于当前对话和下面给出的旧记忆整理。
- 如果用户明确否定、取消、放弃或替换旧目标，必须以最新目标为准，覆盖 summary/goal/requirements/decisions，并清空与旧目标相关的 build_prompt。
- 当用户从“做 1”改成“不做 1，改做 2”时，project_memory 必须切换到“做 2”；除非用户又明确确认开始构建 2，否则 intent 不能是 build_ready，ready_to_build 必须为 false，build_prompt 必须为空。
- 旧记忆只能帮助理解上下文，不能替代本轮用户确认。不要因为旧记忆里有 build_prompt 就返回 build_ready。

回复风格：
- 像一个工程搭档，先帮用户理清思路。
- 简洁、直接、可执行。
- 不要在聊天阶段声称已经生成、验证或部署代码。

当前 project 旧记忆：
${JSON.stringify(memory, null, 2)}

${preferenceText ? `用户偏好：\n${preferenceText}` : ""}`;
}

function providerErrorMessage(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.error === "string") return data.error;
  if (data.error?.message) return String(data.error.message);
  if (data.message) return String(data.message);
  return "";
}
