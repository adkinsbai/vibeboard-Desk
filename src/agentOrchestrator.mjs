import { runAgentGraph } from "./agentGraph.mjs";
import { planChatWithModel } from "./chatPlanner.mjs";
import {
  codexBridgeMetadata,
  createCodexScopeRedirect,
  evaluateCodexHardwareScope,
  planCodexHardwareWithModel,
} from "./codexHardwareAgent.mjs";
import { normalizeProjectMemory } from "./conversationStore.mjs";
import { normalizeModelSettings } from "./modelSettings.mjs";

export function createAgentOrchestrator({
  conversationStore,
  memoryStore,
  assetLibraryStore,
  recordAgentLearning,
  runGenerateRequest,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!conversationStore) throw new Error("conversationStore is required");
  if (!memoryStore) throw new Error("memoryStore is required");
  if (typeof runGenerateRequest !== "function") throw new Error("runGenerateRequest is required");

  async function runAgentRequest(body = {}) {
    const conversationId = String(body.conversation_id || "").trim();
    const modelSettings = normalizeModelSettings(body.modelSettings || {});
    const projectMemory = conversationId
      ? await conversationStore.getProjectMemory(conversationId)
      : normalizeProjectMemory();
    const assetContext = conversationId && assetLibraryStore?.promptContext
      ? assetLibraryStore.promptContext(conversationId)
      : "";
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const agentMode = normalizeAgentMode(body.agent_mode || body.agentMode);
    const modeBoundary = agentModeBoundary(agentMode);
    const codexBridge = agentMode === "codex"
      ? codexBridgeMetadata({ modeBoundary, assetContext, action: body.action || "message" })
      : null;

    return runAgentGraph({
      action: body.action,
      messages: rawMessages,
      conversationId,
      projectMemory,
      buildPrompt: body.build_prompt || body.prompt || "",
      agentMode,
      modeBoundary,
    }, {
      planMessage: async () => {
        if (agentMode === "codex") {
          const scopeDecision = evaluateCodexHardwareScope(rawMessages);
          if (!scopeDecision.allowed) {
            const plan = createCodexScopeRedirect({
              reason: scopeDecision.reason,
              projectMemory,
              bridge: codexBridge,
            });
            if (conversationId && plan.project_memory) {
              await conversationStore.setProjectMemory(conversationId, plan.project_memory);
            }
            return plan;
          }
        }

        if (!modelSettings.enabled) {
          const missingModelPlan = agentMode === "codex"
            ? codexMissingModelPlan({ projectMemory, modeBoundary, bridge: codexBridge })
            : null;
          if (missingModelPlan) return missingModelPlan;
          return {
            intent: "clarify",
            reply: "当前还没有配置可用的 AI 模型，所以我不能调用真实 LLM 来理解复杂需求。不过你可以先走本地模板生成一个可验证的小屏版本，或者先配置模型后再继续。",
            understanding: [],
            planned_changes: [],
            target: "chat",
            ready_to_build: false,
            build_prompt: "",
            project_memory: projectMemory,
            quick_replies: [
              { label: "先本地生成", value: "先用本地模板生成一个可验证的 480x360 小屏应用" },
              { label: "配置模型", value: "我先配置模型 API Key，然后继续让 Agent 理解需求" },
              { label: "继续补充", value: "我继续补充小屏应用需求，暂时不开始构建" },
            ],
            agent_mode: agentMode,
            mode_boundary: modeBoundary,
            codex_bridge: codexBridge,
          };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);
        try {
          const scopedFetch = (url, options = {}) => fetchImpl(url, { ...options, signal: controller.signal });
          const plan = agentMode === "codex"
            ? await planCodexHardwareWithModel({
              settings: modelSettings,
              rawMessages,
              preferences: memoryStore.getAll(),
              projectMemory,
              assetContext,
              modeBoundary,
              fetchImpl: scopedFetch,
            })
            : await planChatWithModel(
              modelSettings,
              rawMessages,
              memoryStore.getAll(),
              projectMemory,
              assetContext,
              agentMode,
              scopedFetch
          );
          if (conversationId && plan.project_memory) {
            await conversationStore.setProjectMemory(conversationId, plan.project_memory);
          }
          return plan;
        } finally {
          clearTimeout(timeout);
        }
      },
      build: async (_state, prompt) => runGenerateRequest({
        prompt: buildExecutionPrompt({
          prompt,
          agentMode,
          modeBoundary,
          codexBridge,
          assetContext,
        }),
        raw_user_prompt: prompt,
        modelSettings: body.modelSettings || {},
        conversation_id: conversationId,
        agent_mode: agentMode,
        clarify_answers: Array.isArray(body.clarify_answers) ? body.clarify_answers : [],
        history: Array.isArray(body.history) ? body.history : rawMessages,
        codex_bridge: codexBridge,
      }),
      reflect: async (state) => {
        if (typeof recordAgentLearning !== "function") return;
        const build = state.build || {};
        const issues = build.buildEvidence?.issues || [];
        if (!issues.length) return;
        state.learning = recordAgentLearning({
          prompt: body.build_prompt || body.prompt || projectMemory.build_prompt || "",
          agentResult: {
            whatWorked: build.buildEvidence?.ok ? ["local verification passed"] : [],
            whatFailed: issues.map(issue => issue.message || issue.code || String(issue)),
          },
          verificationResult: build.buildEvidence,
          success: Boolean(build.buildEvidence?.ok),
        });
      },
    }).then(result => ({
      ...result,
      agent_mode: agentMode,
      mode_boundary: modeBoundary,
      codex_bridge: result.codex_bridge || codexBridge,
    }));
  }

  return { runAgentRequest };
}

function normalizeAgentMode(value) {
  const mode = String(value || "vibeboard").trim();
  if (mode === "codex") return "codex";
  return "vibeboard";
}

function agentModeBoundary(mode = "vibeboard") {
  if (mode === "codex") {
    return {
      mode,
      label: "Codex hardware embedded design mode",
      scope: "VibeBoard 480x360 hardware UI design, generation, local verification, and explicit deploy confirmation only.",
      disallowed: [
        "general desktop automation",
        "account, payment, trading, or unrelated web tasks",
        "filesystem operations outside VibeBoard hardware app generation",
        "automatic hardware writes without deploy confirmation",
      ],
    };
  }
  return {
    mode: "vibeboard",
    label: "VibeBoard self-developed Agent mode",
    scope: "Local VibeBoard planner/generator flow with hardware contracts and explicit deploy confirmation.",
    disallowed: ["automatic hardware writes without deploy confirmation"],
  };
}

export function buildExecutionPrompt({
  prompt = "",
  agentMode = "vibeboard",
  modeBoundary = agentModeBoundary(agentMode),
  codexBridge = null,
  assetContext = "",
} = {}) {
  const rawPrompt = String(prompt || "").trim();
  if (normalizeAgentMode(agentMode) !== "codex") return rawPrompt;

  const lines = [
    rawPrompt,
    "",
    "## Codex hardware execution package",
    "You are Codex inside VibeBoard. Generate only a VibeBoard 480x360 hardware embedded UI app.",
    `Scope: ${modeBoundary.scope || "VibeBoard 480x360 hardware UI design, generation, local verification, and explicit deploy confirmation only."}`,
    "Required behavior:",
    "- Use uploaded Asset Library insights as product direction: palette, components, CTA copy, data fields, media states, and embedded passive assets.",
    "- Keep uploaded HTML/CSS/JS as design references only; do not execute uploaded active code as-is.",
    "- Produce contract-safe index.html, style.css, app.js, hardware_app.py, and manifest.json.",
    "- Run through local VibeBoard L0-L3 verification before offering deployment.",
    "- Never write to hardware or claim deployment without an explicit deploy confirmation.",
    "Disallowed operations:",
    ...arrayOfStrings(modeBoundary.disallowed).map(item => `- ${item}`),
  ];

  if (codexBridge) {
    lines.push("", "Codex bridge:", JSON.stringify(codexBridge, null, 2));
  }
  if (String(assetContext || "").trim()) {
    lines.push("", "Asset Library context:", String(assetContext).trim());
  }

  return lines.join("\n");
}

function codexMissingModelPlan({ projectMemory = {}, modeBoundary = agentModeBoundary("codex"), bridge = null } = {}) {
  const memory = normalizeProjectMemory(projectMemory);
  return {
    intent: "clarify",
    reply: "Codex 硬件模式已经选中，但还没有配置可用模型。我可以先按默认硬件小屏方案整理需求，或者你先配置模型后再让我像 Codex 一样继续规划。",
    understanding: [
      "当前聊天模式是 Codex 硬件嵌入式设计模式。",
      "Codex 模式只处理 VibeBoard 480x360 小屏应用的设计、生成、本地验证和部署确认。",
    ],
    planned_changes: [],
    target: "chat",
    ready_to_build: false,
    build_prompt: "",
    quick_replies: [
      { label: "先做基础版", value: "先按默认方案整理一个 VibeBoard 480x360 小屏基础版。" },
      { label: "配置模型", value: "我先配置模型，然后继续用 Codex 硬件模式规划。" },
      { label: "继续讨论", value: "先继续讨论小屏应用需求，不开始构建。" },
    ],
    project_memory: {
      ...memory,
      open_questions: [
        "是否先配置模型，还是按默认硬件小屏方案继续整理？",
      ],
      constraints: [
        ...memory.constraints,
        modeBoundary.scope,
      ].filter(Boolean),
    },
    agent_mode: "codex",
    mode_boundary: modeBoundary,
    codex_bridge: bridge || codexBridgeMetadata({ modeBoundary, action: "message" }),
  };
}

function arrayOfStrings(value = []) {
  return Array.isArray(value)
    ? value.map(item => String(item || "").trim()).filter(Boolean)
    : [];
}
