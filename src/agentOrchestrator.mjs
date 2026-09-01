import { runAgentGraph } from "./agentGraph.mjs";
import { runAgentWorkflowGraphV2 } from "./agentWorkflowGraphV2.mjs";
import { planChatWithModel } from "./chatPlanner.mjs";
import {
  codexBridgeMetadata,
  createCodexScopeRedirect,
  evaluateCodexHardwareScope,
  planCodexHardwareWithModel,
} from "./codexHardwareAgent.mjs";
import { normalizeProjectMemory } from "./conversationStore.mjs";
import { normalizeModelSettings } from "./modelSettings.mjs";
import { createAgentTaskContract } from "./agentTaskContract.mjs";
import { routeToExecutionProfile, scoreTaskRoute } from "./taskRoutePolicy.mjs";

export function createAgentOrchestrator({
  conversationStore,
  memoryStore,
  assetLibraryStore,
  contextRetriever = null,
  recordAgentLearning,
  runGenerateRequest,
  fetchImpl = globalThis.fetch,
  agentWorkflowVersion = "v1",
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
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const query = body.action === "confirm_build"
      ? String(body.build_prompt || body.prompt || projectMemory.build_prompt || lastUserMessage(rawMessages) || "").trim()
      : (lastUserMessage(rawMessages) || String(body.build_prompt || body.prompt || "").trim());
    const projectFiles = conversationId && typeof conversationStore.loadConversationFiles === "function"
      ? Object.keys((await conversationStore.loadConversationFiles(conversationId))?.files || {}).filter(name => name !== "manifest.json")
      : [];
    const routeScore = scoreTaskRoute({
      prompt: query,
      action: body.action || "message",
      projectFiles,
      projectMemory: projectMemoryForRouting(projectMemory),
      assets: conversationId && typeof assetLibraryStore?.listAssets === "function"
        ? assetLibraryStore.listAssets(conversationId)
        : [],
    });
    const routeProfile = routeToExecutionProfile(routeScore.route, routeScore);
    const assetContext = conversationId && assetLibraryStore?.promptContext
      ? assetLibraryStore.promptContext(conversationId, { query, limit: 12 })
      : "";
    const retrievedContext = await loadRetrievedContext({
      contextRetriever,
      query,
      conversationId,
      projectId: conversationId,
      organizationId: body.organization_id || body.organizationId || "",
      actorId: body.actor_id || body.actorId || body.user_id || "",
    });
    const unifiedContext = retrievedContext.text;
    const agentMode = normalizeAgentMode(body.agent_mode || body.agentMode);
    const modeBoundary = agentModeBoundary(agentMode);
    const codexBridge = agentMode === "codex"
      ? codexBridgeMetadata({ modeBoundary, assetContext, action: body.action || "message" })
      : null;

    const workflowRunner = shouldUseLangGraphV2(body, agentWorkflowVersion)
      ? runAgentWorkflowGraphV2
      : runAgentGraph;
    const confirmedTaskContract = body.action === "confirm_build"
      ? taskContractForBuild(body.task_contract, body.build_prompt || body.prompt || query, projectMemory)
      : null;

    return workflowRunner({
      action: body.action,
      messages: rawMessages,
      conversationId,
      projectMemory,
      buildPrompt: body.build_prompt || body.prompt || "",
      agentMode,
      modeBoundary,
      routeProfile,
      context_retrieval: retrievedContext.meta,
      assetContext,
      retrievedContextText: unifiedContext,
      debugContext: body.debug_context || body.debugContext || null,
      taskContract: confirmedTaskContract,
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
              assetContext: `${assetContext}${unifiedContext}`,
              modeBoundary,
              fetchImpl: scopedFetch,
            })
            : await planChatWithModel(
              modelSettings,
              rawMessages,
              memoryStore.getAll(),
              projectMemory,
              `${assetContext}${unifiedContext}`,
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
      build: async (_state, prompt) => {
        const debugContext = body.debug_context || body.debugContext || _state.debugContext || _state.contextBundle?.debugContext || null;
        const executionPrompt = buildExecutionPrompt({
          prompt,
          agentMode,
          modeBoundary,
          codexBridge,
          assetContext: `${assetContext}${unifiedContext}`,
          debugContext,
        });
        return runGenerateRequest({
          prompt: executionPrompt,
          raw_user_prompt: prompt,
          modelSettings: body.modelSettings || {},
          conversation_id: conversationId,
          agent_mode: agentMode,
          clarify_answers: Array.isArray(body.clarify_answers) ? body.clarify_answers : [],
          history: Array.isArray(body.history) ? body.history : rawMessages,
          codex_bridge: codexBridge,
          route_profile: routeProfile,
          context_retrieval: retrievedContext.meta,
          debug_context: debugContext,
          context_bundle: _state.contextBundle
            ? {
              retrievedEntries: _state.contextBundle.contextRetrieval?.entryCount || 0,
              availableLayers: _state.contextBundle.contextRetrieval?.availableLayers || [],
              assetContextAttached: Boolean(_state.contextBundle.assetContext),
              debugContextAttached: Boolean(_state.contextBundle.debugContext?.previousFailures?.length || _state.contextBundle.debugContext?.playbooks?.length),
            }
            : null,
          task_contract: _state.taskContract || confirmedTaskContract || taskContractForBuild(body.task_contract, prompt, projectMemory),
        });
      },
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
      route_profile: result.route_profile || routeProfile,
      context_retrieval: result.context_retrieval || retrievedContext.meta,
    }));
  }

  return { runAgentRequest };
}

function lastUserMessage(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return String(messages[index].content || "").trim();
  }
  return "";
}

function projectMemoryForRouting(memory = {}) {
  const normalized = normalizeProjectMemory(memory);
  return [
    normalized.summary,
    normalized.goal,
    ...normalized.requirements,
    ...normalized.constraints,
    ...normalized.decisions,
    ...normalized.open_questions,
    normalized.build_prompt,
  ].filter(Boolean);
}

async function loadRetrievedContext({ contextRetriever, query, conversationId, projectId, organizationId, actorId } = {}) {
  if (!contextRetriever?.loadMemoryContext) {
    return { text: "", meta: { degraded: false, availableLayers: [], entryCount: 0, errors: [] } };
  }
  try {
    const result = await contextRetriever.loadMemoryContext({
      query,
      conversationId,
      projectId: projectId || conversationId,
      organizationId,
      actorId,
      mode: "planning",
      limit: 18,
    });
    return {
      text: contextRetriever.formatMemoryContext
        ? `\n\n## Unified retrieved project context\n${contextRetriever.formatMemoryContext(result)}`
        : "",
      meta: {
        degraded: Boolean(result.degraded),
        availableLayers: result.availableLayers || [],
        entryCount: Array.isArray(result.entries) ? result.entries.length : 0,
        errors: (result.errors || []).slice(0, 6),
      },
    };
  } catch (error) {
    return { text: "", meta: { degraded: true, availableLayers: [], entryCount: 0, errors: [{ source: "contextRetriever", message: error.message }] } };
  }
}

function taskContractForBuild(raw = {}, prompt = "", projectMemory = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const memory = normalizeProjectMemory(projectMemory);
  return createAgentTaskContract({
    objective: input.objective || prompt,
    requiredFiles: input.required_files || input.requiredFiles,
    acceptanceCriteria: input.acceptance_criteria || input.acceptanceCriteria || [
      ...memory.requirements,
      ...memory.constraints,
      "All required generated files pass VibeBoard L0-L3 local verification.",
      "The 480x360 screen is nonblank and has no overflow.",
    ],
    forbidden: input.forbidden || [
      "automatic hardware deployment",
      "credentials or model configuration in generated files",
      "claims of hardware execution without board evidence",
    ],
    maxModelTurns: input.max_model_turns ?? input.maxModelTurns,
  });
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
  debugContext = null,
} = {}) {
  const rawPrompt = String(prompt || "").trim();
  const debugContextText = formatDebugContextForPrompt(debugContext);
  if (normalizeAgentMode(agentMode) !== "codex") {
    return [rawPrompt, debugContextText].filter(Boolean).join("\n\n");
  }

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
  if (debugContextText) {
    lines.push("", debugContextText);
  }

  return lines.join("\n");
}

function formatDebugContextForPrompt(debugContext = null) {
  if (!debugContext || typeof debugContext !== "object") return "";
  const previousFailures = Array.isArray(debugContext.previousFailures) ? debugContext.previousFailures : [];
  const playbooks = Array.isArray(debugContext.playbooks) ? debugContext.playbooks : [];
  if (!previousFailures.length && !playbooks.length) return "";

  const lines = [
    "## Automatic debug context",
    "The previous attempt failed before hardware deployment. Apply the smallest code change that addresses the evidence, keep hardware contracts read-only, then run local verification again.",
  ];
  if (previousFailures.length) {
    lines.push("", "Previous failures:");
    for (const failure of previousFailures.slice(0, 5)) {
      lines.push(`- ${String(failure.errorType || failure.type || "failure").slice(0, 80)}: ${String(failure.message || failure.technicalDetail || "").slice(0, 500)}`);
    }
  }
  if (playbooks.length) {
    lines.push("", "Relevant experience playbooks:");
    for (const playbook of playbooks.slice(0, 3)) {
      const title = String(playbook.title || playbook.signature || "playbook").slice(0, 120);
      const fix = String(playbook.fix || playbook.root_cause || "").slice(0, 500);
      lines.push(`- ${title}${fix ? `: ${fix}` : ""}`);
    }
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

function shouldUseLangGraphV2(body = {}, defaultVersion = "v1") {
  const value = String(
    body.workflow_version ||
    body.workflowVersion ||
    body.agent_workflow ||
    body.agentWorkflow ||
    defaultVersion ||
    "v1"
  ).trim().toLowerCase();
  return value === "v2" || value === "langgraph-v2";
}
