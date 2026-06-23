import { runAgentGraph } from "./agentGraph.mjs";
import { planChatWithModel } from "./chatPlanner.mjs";
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
      ? conversationStore.getProjectMemory(conversationId)
      : normalizeProjectMemory();
    const assetContext = conversationId && assetLibraryStore?.promptContext
      ? assetLibraryStore.promptContext(conversationId)
      : "";
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const agentMode = normalizeAgentMode(body.agent_mode || body.agentMode);
    const modeBoundary = agentModeBoundary(agentMode);

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
        if (!modelSettings.enabled) {
          return {
            intent: "chat",
            reply: "Please configure a model first. After that, I will chat with you, organize the requirements, and generate code only after you confirm the build.",
            understanding: [],
            planned_changes: [],
            target: "chat",
            ready_to_build: false,
            build_prompt: "",
            project_memory: projectMemory,
            quick_replies: [],
            agent_mode: agentMode,
            mode_boundary: modeBoundary,
          };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);
        try {
          const plan = await planChatWithModel(
            modelSettings,
            rawMessages,
            memoryStore.getAll(),
            projectMemory,
            assetContext,
            agentMode,
            (url, options = {}) => fetchImpl(url, { ...options, signal: controller.signal })
          );
          if (conversationId && plan.project_memory) {
            conversationStore.setProjectMemory(conversationId, plan.project_memory);
          }
          return plan;
        } finally {
          clearTimeout(timeout);
        }
      },
      build: async (_state, prompt) => runGenerateRequest({
        prompt,
        modelSettings: body.modelSettings || {},
        conversation_id: conversationId,
        agent_mode: agentMode,
        clarify_answers: Array.isArray(body.clarify_answers) ? body.clarify_answers : [],
        history: Array.isArray(body.history) ? body.history : rawMessages,
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
