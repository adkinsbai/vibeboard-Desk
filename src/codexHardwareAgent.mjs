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
    codex_bridge: bridge,
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
