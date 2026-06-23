import { parseChatPlan } from "./chatPlanner.mjs";
import { normalizeProjectMemory } from "./conversationStore.mjs";
import { chatCompletionsUrl } from "./modelSettings.mjs";

export async function planCodexHardwareWithModel({
  settings,
  rawMessages = [],
  preferences = {},
  projectMemory = {},
  assetContext = "",
  modeBoundary = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedMemory = normalizeProjectMemory(projectMemory);
  const bridge = codexBridgeMetadata({ modeBoundary, assetContext, action: "message" });
  const scopeDecision = evaluateCodexHardwareScope(rawMessages);
  if (!scopeDecision.allowed) {
    return createCodexScopeRedirect({
      reason: scopeDecision.reason,
      projectMemory: normalizedMemory,
      bridge,
    });
  }
  const messages = [
    {
      role: "system",
      content: buildCodexHardwareSystemPrompt({
        preferences,
        projectMemory: normalizedMemory,
        assetContext,
        modeBoundary,
        bridge,
      }),
    },
    ...normalizeCodexMessages(rawMessages),
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
      temperature: 0.18,
      max_tokens: 4096,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(providerErrorMessage(data) || `HTTP ${response.status}`);
    error.type = "codex_hardware_agent_failed";
    error.code = "CODEX_HARDWARE_AGENT_CALL_FAILED";
    error.status = response.status;
    error.model = settings.model;
    error.endpoint = chatCompletionsUrl(settings.baseUrl);
    error.providerMessage = providerErrorMessage(data);
    throw error;
  }

  const plan = parseChatPlan(data.choices?.[0]?.message?.content || "", normalizedMemory);
  return attachCodexBridge(plan, bridge);
}

export function evaluateCodexHardwareScope(rawMessages = []) {
  const latest = latestUserMessage(rawMessages).toLowerCase();
  if (!latest) return { allowed: true, reason: "" };

  const hardwareSignals = [
    "vibeboard", "480", "360", "小屏", "硬件", "嵌入式", "屏幕", "泰山", "rk3566",
    "部署到板", "真机", "kiosk", "硬件ui", "小屏界面", "小屏app", "assets库", "素材包",
  ];
  if (hardwareSignals.some(signal => latest.includes(signal.toLowerCase()))) {
    return { allowed: true, reason: "" };
  }

  const outOfScopeChecks = [
    { reason: "desktop automation", pattern: /(控制|操作|打开|关闭|删除|安装|卸载|重启|点击|输入|复制|移动).*(电脑|windows|桌面|文件夹|浏览器|微信|qq|软件|系统)/i },
    { reason: "desktop automation", pattern: /(control|operate|open|close|delete|install|uninstall|restart|click|type|copy|move).*(computer|windows|desktop|folder|browser|system|software)/i },
    { reason: "account or payment task", pattern: /(登录|注册|账号|密码|付款|支付|转账|充值|提现|银行卡|购买|下单|订单)/i },
    { reason: "account or payment task", pattern: /(login|register|account|password|payment|pay|transfer|checkout|purchase|order)/i },
    { reason: "trading or finance task", pattern: /(股票|基金|期货|加密货币|交易|买入|卖出|下单|投资|炒股|量化)/i },
    { reason: "trading or finance task", pattern: /(stock|fund|future|crypto|trade|buy|sell|invest|trading)/i },
    { reason: "unrelated web task", pattern: /(帮我|替我).*(网页|网站|表单|申请|投递|邮箱|搜索|下载|爬取)/i },
    { reason: "unrelated web task", pattern: /(help me|for me).*(webpage|website|form|application|email|search|download|scrape)/i },
  ];
  for (const check of outOfScopeChecks) {
    if (check.pattern.test(latest)) {
      return { allowed: false, reason: check.reason };
    }
  }
  return { allowed: true, reason: "" };
}

export function codexBridgeMetadata({ modeBoundary = {}, assetContext = "", action = "message" } = {}) {
  return {
    name: "codex-hardware-agent",
    status: "active",
    action,
    scope: modeBoundary.scope || "VibeBoard 480x360 hardware embedded UI design only.",
    allowed_operations: [
      "discuss hardware UI requirements",
      "analyze uploaded asset-library summaries",
      "prepare generated app build prompts",
      "run local verification through VibeBoard build runtime",
      "request explicit deploy confirmation",
    ],
    disallowed_operations: Array.isArray(modeBoundary.disallowed)
      ? modeBoundary.disallowed
      : ["general desktop automation", "automatic hardware writes without deploy confirmation"],
    asset_context_attached: Boolean(String(assetContext || "").trim()),
  };
}

export function attachCodexBridge(plan = {}, bridge = codexBridgeMetadata()) {
  const projectMemory = normalizeProjectMemory(plan.project_memory || {});
  const constraints = new Set(projectMemory.constraints || []);
  constraints.add("Codex mode is limited to VibeBoard 480x360 hardware embedded UI design, generation, local verification, and explicit deploy confirmation.");
  constraints.add("Do not perform or suggest unrelated desktop, account, payment, trading, or external web operations.");
  projectMemory.constraints = [...constraints];

  return {
    ...plan,
    project_memory: projectMemory,
    codex_bridge: plan.codex_bridge ? { ...bridge, ...plan.codex_bridge } : bridge,
  };
}

export function createCodexScopeRedirect({ reason = "out of scope", projectMemory = {}, bridge = codexBridgeMetadata() } = {}) {
  return attachCodexBridge(outOfScopePlan({ reason, projectMemory, bridge }), bridge);
}

function outOfScopePlan({ reason = "out of scope", projectMemory = {}, bridge = codexBridgeMetadata() } = {}) {
  const memory = normalizeProjectMemory(projectMemory);
  const question = "这个请求超出了 Codex 硬件模式。我只能继续帮你做 VibeBoard 480x360 小屏硬件应用，要不要把它改成小屏功能？";
  return {
    intent: "clarify",
    reply: question,
    understanding: [
      `当前请求被识别为 ${reason}，不属于 VibeBoard 硬件嵌入式设计范围。`,
      "Codex 模式只能处理 480x360 小屏 UI 设计、生成、本地验证和明确部署确认。",
    ],
    planned_changes: [],
    target: "chat",
    ready_to_build: false,
    build_prompt: "",
    project_memory: {
      ...memory,
      open_questions: [
        "是否把这个想法改写成 VibeBoard 480x360 小屏硬件应用？",
      ],
      decisions: [
        ...memory.decisions,
        `Codex hardware scope guard redirected an out-of-scope request: ${reason}.`,
      ].slice(-12),
    },
    quick_replies: [
      { label: "改成小屏", value: "把这个想法改成 VibeBoard 480x360 小屏硬件应用。" },
      { label: "做基础版", value: "按默认方案做一个 VibeBoard 小屏基础版。" },
      { label: "先不做", value: "先不做这个，继续讨论硬件小屏应用。" },
    ],
    codex_bridge: {
      ...bridge,
      scope_guard: {
        blocked: true,
        reason,
      },
    },
  };
}

function buildCodexHardwareSystemPrompt({
  preferences = {},
  projectMemory = {},
  assetContext = "",
  modeBoundary = {},
  bridge = codexBridgeMetadata(),
} = {}) {
  const preferenceText = Object.entries(preferences || {})
    .map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
    .join("\n");

  return `You are Codex operating inside VibeBoard as a hardware-embedded design agent.

This chat should feel like the user is talking directly with Codex, but your operational scope is strictly limited:
- Scope: ${modeBoundary.scope || bridge.scope}
- You may discuss, design, plan, generate, locally verify, and prepare deploy confirmations for VibeBoard 480x360 hardware UI apps.
- You must not perform, promise, or request unrelated desktop automation, account/payment/trading actions, external web tasks, or filesystem operations outside VibeBoard hardware app generation.
- You must never write to hardware automatically. Deployment always requires explicit user confirmation after local verification.

Hardware product rules:
- Target screen is fixed at 480x360.
- Generated apps must remain self-contained and compatible with VibeBoard hardware contracts.
- Uploaded HTML/CSS/JS components are design references, not unrestricted executable code.
- Uploaded assets should be used to make a more polished embedded product: visual hierarchy, typography, brand palette, media states, dashboard data, and interaction affordances.
- If asset context includes an inferred product design brief, treat it as important product direction.
- If asset context includes product-intent, layout-plan, media-plan, or completion-gap lines, use them as the default product plan instead of asking the user to restate asset usage or layout choices.

Agent behavior:
- Infer intent from the full conversation, not from keywords.
- Ask at most one high-impact clarification question per turn.
- Every clarification must include 2-4 quick_replies and one low-friction default option.
- If the user asks to start/build/generate and the requirements are sufficient, return build_ready with a complete build_prompt.
- If the user asks for unrelated operations, politely redirect to what Codex can do for VibeBoard hardware UI.
- Do not claim that code was generated, verified, deployed, or written until the VibeBoard runtime has actually done it.

Return only one JSON object:
{
  "intent": "chat" | "clarify" | "build_ready",
  "reply": "natural Chinese response shown to the user",
  "understanding": ["key requirements you understood"],
  "planned_changes": ["specific engineering actions you would take after confirmation"],
  "target": "chat" | "new_project" | "edit_current_project",
  "ready_to_build": true | false,
  "build_prompt": "complete prompt for generator only when ready_to_build is true; otherwise empty string",
  "quick_replies": [{"label": "12 Chinese chars or fewer", "value": "full answer sent when clicked"}],
  "project_memory": {
    "summary": "one-sentence project summary",
    "goal": "what the user wants to build",
    "requirements": ["clear functional requirements"],
    "constraints": ["screen, data, assets, interaction, visual, hardware constraints"],
    "open_questions": ["remaining question"],
    "decisions": ["confirmed choices"],
    "build_prompt": "current complete build prompt only when ready"
  }
}

Existing project memory:
${JSON.stringify(normalizeProjectMemory(projectMemory), null, 2)}

Codex hardware bridge metadata:
${JSON.stringify(bridge, null, 2)}

Uploaded asset context:
${String(assetContext || "").trim() || "none"}

User preferences:
${preferenceText || "none"}`;
}

function latestUserMessage(rawMessages = []) {
  const messages = Array.isArray(rawMessages) ? rawMessages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = String(message?.role || "user").trim();
    if (role === "assistant" || role === "agent") continue;
    const content = String(message?.content || "").trim();
    if (content) return content;
  }
  return "";
}

function normalizeCodexMessages(rawMessages = []) {
  return (Array.isArray(rawMessages) ? rawMessages : [])
    .slice(-24)
    .map(message => ({
      role: message?.role === "assistant" || message?.role === "agent" ? "assistant" : "user",
      content: String(message?.content || "").trim(),
    }))
    .filter(message => message.content);
}

function providerErrorMessage(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.error === "string") return data.error;
  if (data.error?.message) return String(data.error.message);
  if (data.message) return String(data.message);
  return "";
}
