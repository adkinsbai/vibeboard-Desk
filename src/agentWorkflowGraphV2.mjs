import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { normalizeProjectMemory } from "./conversationStore.mjs";
import { MODEL_WRITABLE_FILE_NAMES } from "./hardwareContractFirewall.mjs";

export const AGENT_WORKFLOW_V2_NODES = Object.freeze({
  LOAD_CONTEXT: "load_context",
  RETRIEVE_CONTEXT: "retrieve_context",
  PLAN_REQUIREMENT: "plan_requirement",
  CONFIRM_GATE: "confirm_gate",
  CONTRACT_FIREWALL: "contract_firewall",
  BUILD_GRAPH: "build_graph",
  DEBUG_REFLECT: "debug_reflect",
  DEPLOY_APPROVAL: "deploy_approval",
  RESPOND: "respond",
});

const AgentWorkflowV2State = Annotation.Root({
  action: Annotation({
    reducer: (_left, right) => normalizeAction(right),
    default: () => "message",
  }),
  messages: Annotation({
    reducer: (_left, right) => (Array.isArray(right) ? right : []),
    default: () => [],
  }),
  conversationId: Annotation({ reducer: replaceValue, default: () => "" }),
  projectMemory: Annotation({
    reducer: (left, right) => normalizeProjectMemory(right === undefined ? left : right),
    default: () => normalizeProjectMemory(),
  }),
  buildPrompt: Annotation({ reducer: replaceValue, default: () => "" }),
  prompt: Annotation({ reducer: replaceValue, default: () => "" }),
  agentMode: Annotation({ reducer: replaceValue, default: () => "vibeboard" }),
  modeBoundary: Annotation({ reducer: replaceValue, default: () => null }),
  codexBridge: Annotation({ reducer: replaceValue, default: () => null }),
  routeProfile: Annotation({ reducer: replaceValue, default: () => null }),
  context_retrieval: Annotation({ reducer: replaceValue, default: () => null }),
  assetContext: Annotation({ reducer: replaceValue, default: () => "" }),
  retrievedContextText: Annotation({ reducer: replaceValue, default: () => "" }),
  debugContext: Annotation({ reducer: replaceValue, default: () => null }),
  contextBundle: Annotation({ reducer: replaceValue, default: () => null }),
  taskContract: Annotation({ reducer: replaceValue, default: () => null }),
  contractFirewall: Annotation({ reducer: replaceValue, default: () => null }),
  loaded_context: Annotation({ reducer: replaceValue, default: () => null }),
  plan: Annotation({ reducer: replaceValue, default: () => null }),
  build: Annotation({ reducer: replaceValue, default: () => null }),
  learning: Annotation({ reducer: replaceValue, default: () => null }),
  response: Annotation({ reducer: replaceValue, default: () => null }),
  deployApproval: Annotation({ reducer: replaceValue, default: () => null }),
  shouldBuild: Annotation({
    reducer: (_left, right) => Boolean(right),
    default: () => false,
  }),
  buildPromptResolved: Annotation({ reducer: replaceValue, default: () => "" }),
  agentGraphV2: Annotation({
    reducer: (left, right) => [
      ...(Array.isArray(left) ? left : []),
      ...(Array.isArray(right) ? right : right ? [right] : []),
    ],
    default: () => [],
  }),
});

export async function runAgentWorkflowGraphV2(input = {}, steps = {}) {
  const workflow = createAgentWorkflowGraphV2(steps);
  const state = await workflow.invoke({
    ...input,
    action: normalizeAction(input.action),
    messages: Array.isArray(input.messages) ? input.messages : [],
    projectMemory: normalizeProjectMemory(input.projectMemory),
    buildPrompt: input.buildPrompt || input.build_prompt || "",
    prompt: input.prompt || "",
    assetContext: input.assetContext || input.asset_context || "",
    retrievedContextText: input.retrievedContextText || input.retrieved_context_text || "",
    debugContext: input.debugContext || input.debug_context || null,
    taskContract: input.taskContract || input.task_contract || null,
  });
  return formatWorkflowResult(state);
}

export function createAgentWorkflowGraphV2(steps = {}) {
  return new StateGraph(AgentWorkflowV2State)
    .addNode(AGENT_WORKFLOW_V2_NODES.LOAD_CONTEXT, async state => {
      const patch = await callOptionalStep(steps.loadContext, state);
      return {
        ...patch,
        agentGraphV2: [
          traceEntry(AGENT_WORKFLOW_V2_NODES.LOAD_CONTEXT, "done", {
            action: state.action,
            conversationId: state.conversationId || "",
            hasMemory: hasProjectMemory(state.projectMemory),
          }),
        ],
      };
    })
    .addNode(AGENT_WORKFLOW_V2_NODES.RETRIEVE_CONTEXT, async state => {
      const contextBundle = buildContextBundle(state);
      return {
        contextBundle,
        agentGraphV2: [
          traceEntry(AGENT_WORKFLOW_V2_NODES.RETRIEVE_CONTEXT, contextBundle.contextRetrieval.degraded ? "degraded" : "done", {
            retrievedEntries: contextBundle.contextRetrieval.entryCount,
            availableLayers: contextBundle.contextRetrieval.availableLayers,
            assetContextAttached: Boolean(contextBundle.assetContext),
            debugContextAttached: hasDebugContext(contextBundle.debugContext),
            projectMemoryAttached: hasProjectMemory(contextBundle.projectMemory),
          }),
        ],
      };
    })
    .addNode(AGENT_WORKFLOW_V2_NODES.PLAN_REQUIREMENT, async state => {
      requireStep(steps.planMessage, AGENT_WORKFLOW_V2_NODES.PLAN_REQUIREMENT);
      const plan = await steps.planMessage(state);
      const nextMemory = plan?.project_memory
        ? normalizeProjectMemory(plan.project_memory)
        : state.projectMemory;
      return {
        plan,
        projectMemory: nextMemory,
        agentGraphV2: [
          traceEntry(AGENT_WORKFLOW_V2_NODES.PLAN_REQUIREMENT, "done", {
            intent: plan?.intent || "",
            readyToBuild: Boolean(plan?.ready_to_build),
            target: plan?.target || "",
          }),
        ],
      };
    })
    .addNode(AGENT_WORKFLOW_V2_NODES.CONFIRM_GATE, async state => {
      if (state.action === "message") {
        const readyToBuild = Boolean(state.plan?.ready_to_build);
        return {
          response: { mode: readyToBuild ? "confirm_required" : "chat" },
          agentGraphV2: [
            traceEntry(AGENT_WORKFLOW_V2_NODES.CONFIRM_GATE, readyToBuild ? "waiting" : "blocked", {
              reason: readyToBuild ? "awaiting_user_confirmation" : "chat_or_clarify",
            }),
          ],
        };
      }

      const prompt = resolveBuildPrompt(state);
      const routeNeedsClarification = state.routeProfile?.route === "clarify_or_block";
      const passed = Boolean(prompt) && !routeNeedsClarification;
      if (passed) {
        return {
          shouldBuild: true,
          buildPromptResolved: prompt,
          response: { mode: "build_pending" },
          agentGraphV2: [
            traceEntry(AGENT_WORKFLOW_V2_NODES.CONFIRM_GATE, "passed", {
              hasBuildPrompt: true,
            }),
          ],
        };
      }

      return {
        shouldBuild: false,
        buildPromptResolved: "",
        response: routeNeedsClarification
          ? routeClarifyResponse(state)
          : missingPromptResponse(state),
        agentGraphV2: [
          traceEntry(AGENT_WORKFLOW_V2_NODES.CONFIRM_GATE, "blocked", {
            hasBuildPrompt: Boolean(prompt),
            reason: routeNeedsClarification ? "route_requires_clarification" : "missing_build_prompt",
            route: routeNeedsClarification ? state.routeProfile.route : "",
          }),
        ],
      };
    })
    .addNode(AGENT_WORKFLOW_V2_NODES.CONTRACT_FIREWALL, async state => {
      const verdict = validateTaskContractBoundary(state.taskContract);
      if (!verdict.ok) {
        return {
          shouldBuild: false,
          contractFirewall: verdict,
          response: contractBlockedResponse(verdict, state),
          agentGraphV2: [
            traceEntry(AGENT_WORKFLOW_V2_NODES.CONTRACT_FIREWALL, "blocked", {
              contractAttached: verdict.contractAttached,
              issues: verdict.issues.map(issue => issue.code),
              modelWritableFiles: verdict.modelWritableFiles,
              systemOwnedFiles: verdict.systemOwnedFiles,
            }),
          ],
        };
      }
      return {
        contractFirewall: verdict,
        agentGraphV2: [
          traceEntry(AGENT_WORKFLOW_V2_NODES.CONTRACT_FIREWALL, "passed", {
            contractAttached: verdict.contractAttached,
            modelWritableFiles: verdict.modelWritableFiles,
            systemOwnedFiles: verdict.systemOwnedFiles,
          }),
        ],
      };
    })
    .addNode(AGENT_WORKFLOW_V2_NODES.BUILD_GRAPH, async state => {
      requireStep(steps.build, AGENT_WORKFLOW_V2_NODES.BUILD_GRAPH);
      const prompt = state.buildPromptResolved || resolveBuildPrompt(state);
      const build = await steps.build(state, prompt);
      return {
        build,
        agentGraphV2: [
          traceEntry(AGENT_WORKFLOW_V2_NODES.BUILD_GRAPH, "done", {
            id: build?.id || "",
            source: build?.source || "",
            ok: Boolean(build?.ok),
          }),
        ],
      };
    })
    .addNode(AGENT_WORKFLOW_V2_NODES.DEBUG_REFLECT, async state => {
      if (typeof steps.reflect !== "function") {
        return {
          agentGraphV2: [
            traceEntry(AGENT_WORKFLOW_V2_NODES.DEBUG_REFLECT, "skipped", {
              reason: "no_reflect_step",
            }),
          ],
        };
      }

      const mutableState = { ...state };
      const reflected = await steps.reflect(mutableState);
      const patch = plainObject(reflected) ? reflected : {};
      if (mutableState.learning && !patch.learning) patch.learning = mutableState.learning;
      return {
        ...patch,
        agentGraphV2: [
          traceEntry(AGENT_WORKFLOW_V2_NODES.DEBUG_REFLECT, "done", {
            issueCount: state.build?.buildEvidence?.issues?.length || 0,
            learned: Boolean(patch.learning),
          }),
        ],
      };
    })
    .addNode(AGENT_WORKFLOW_V2_NODES.DEPLOY_APPROVAL, async state => {
      const approval = state.build?.ok
        ? {
          status: "waiting",
          requiresConfirmation: true,
          buildId: state.build?.id || "",
          reason: "explicit_deploy_confirmation_required",
        }
        : {
          status: "blocked",
          requiresConfirmation: false,
          buildId: state.build?.id || "",
          reason: "build_or_verification_failed",
        };
      return {
        deployApproval: approval,
        agentGraphV2: [
          traceEntry(AGENT_WORKFLOW_V2_NODES.DEPLOY_APPROVAL, approval.status, {
            buildId: approval.buildId,
            reason: approval.reason,
          }),
        ],
      };
    })
    .addNode(AGENT_WORKFLOW_V2_NODES.RESPOND, async state => ({
      agentGraphV2: [
        traceEntry(AGENT_WORKFLOW_V2_NODES.RESPOND, "done", {
          mode: state.response?.mode || (state.action === "confirm_build" ? "build_done" : "chat"),
        }),
      ],
    }))
    .addEdge(START, AGENT_WORKFLOW_V2_NODES.LOAD_CONTEXT)
    .addEdge(AGENT_WORKFLOW_V2_NODES.LOAD_CONTEXT, AGENT_WORKFLOW_V2_NODES.RETRIEVE_CONTEXT)
    .addConditionalEdges(
      AGENT_WORKFLOW_V2_NODES.RETRIEVE_CONTEXT,
      state => (state.action === "message"
        ? AGENT_WORKFLOW_V2_NODES.PLAN_REQUIREMENT
        : AGENT_WORKFLOW_V2_NODES.CONFIRM_GATE),
      {
        [AGENT_WORKFLOW_V2_NODES.PLAN_REQUIREMENT]: AGENT_WORKFLOW_V2_NODES.PLAN_REQUIREMENT,
        [AGENT_WORKFLOW_V2_NODES.CONFIRM_GATE]: AGENT_WORKFLOW_V2_NODES.CONFIRM_GATE,
      }
    )
    .addEdge(AGENT_WORKFLOW_V2_NODES.PLAN_REQUIREMENT, AGENT_WORKFLOW_V2_NODES.CONFIRM_GATE)
    .addConditionalEdges(
      AGENT_WORKFLOW_V2_NODES.CONFIRM_GATE,
      state => (state.shouldBuild ? AGENT_WORKFLOW_V2_NODES.CONTRACT_FIREWALL : AGENT_WORKFLOW_V2_NODES.RESPOND),
      {
        [AGENT_WORKFLOW_V2_NODES.CONTRACT_FIREWALL]: AGENT_WORKFLOW_V2_NODES.CONTRACT_FIREWALL,
        [AGENT_WORKFLOW_V2_NODES.RESPOND]: AGENT_WORKFLOW_V2_NODES.RESPOND,
      }
    )
    .addConditionalEdges(
      AGENT_WORKFLOW_V2_NODES.CONTRACT_FIREWALL,
      state => (state.shouldBuild ? AGENT_WORKFLOW_V2_NODES.BUILD_GRAPH : AGENT_WORKFLOW_V2_NODES.RESPOND),
      {
        [AGENT_WORKFLOW_V2_NODES.BUILD_GRAPH]: AGENT_WORKFLOW_V2_NODES.BUILD_GRAPH,
        [AGENT_WORKFLOW_V2_NODES.RESPOND]: AGENT_WORKFLOW_V2_NODES.RESPOND,
      }
    )
    .addEdge(AGENT_WORKFLOW_V2_NODES.BUILD_GRAPH, AGENT_WORKFLOW_V2_NODES.DEBUG_REFLECT)
    .addEdge(AGENT_WORKFLOW_V2_NODES.DEBUG_REFLECT, AGENT_WORKFLOW_V2_NODES.DEPLOY_APPROVAL)
    .addEdge(AGENT_WORKFLOW_V2_NODES.DEPLOY_APPROVAL, AGENT_WORKFLOW_V2_NODES.RESPOND)
    .addEdge(AGENT_WORKFLOW_V2_NODES.RESPOND, END)
    .compile();
}

function formatWorkflowResult(state = {}) {
  const trace = Array.isArray(state.agentGraphV2) ? state.agentGraphV2 : [];
  const common = {
    workflow_engine: "langgraph-v2",
    context_bundle: publicContextBundle(state.contextBundle),
    agentGraphV2: trace,
    agentGraph: trace,
  };

  if (state.action === "message") {
    const plan = plainObject(state.plan) ? state.plan : {};
    return {
      ok: true,
      mode: state.response?.mode || (plan.ready_to_build ? "confirm_required" : "chat"),
      ...plan,
      project_memory: state.projectMemory,
      ...common,
    };
  }

  if (state.action === "confirm_build" && !state.shouldBuild) {
    return {
      ...state.response,
      project_memory: state.projectMemory,
      route_profile: state.routeProfile || state.response?.route_profile,
      context_retrieval: state.context_retrieval || state.response?.context_retrieval,
      contract_firewall: state.contractFirewall,
      ...common,
    };
  }

  if (state.action === "confirm_build") {
    return {
      ...(plainObject(state.build) ? state.build : {}),
      mode: "build_done",
      deploy_approval: state.deployApproval,
      learning: state.learning,
      contract_firewall: state.contractFirewall,
      ...common,
    };
  }

  return {
    ok: true,
    mode: "chat",
    intent: "chat",
    reply: "我可以先和你把需求聊清楚。确认后，我再开始生成、验证并保存预览。",
    ready_to_build: false,
    build_prompt: "",
    project_memory: state.projectMemory,
    ...common,
  };
}

async function callOptionalStep(step, state) {
  if (typeof step !== "function") return {};
  const result = await step(state);
  return plainObject(result) ? result : {};
}

function resolveBuildPrompt(state = {}) {
  return String(state.buildPrompt || state.prompt || state.projectMemory?.build_prompt || "").trim();
}

function missingPromptResponse(state = {}) {
  return {
    ok: true,
    mode: "clarify",
    intent: "clarify",
    reply: "我还没有整理出可构建的完整需求，请先继续补充或确认方案。",
    ready_to_build: false,
    build_prompt: "",
    project_memory: normalizeProjectMemory(state.projectMemory),
  };
}

function routeClarifyResponse(state = {}) {
  return {
    ok: true,
    mode: "clarify",
    intent: "clarify",
    reply: "当前需求还不足以安全开始构建。请从下面选择一个方向，或补充具体的页面、功能和目标设备。",
    understanding: [],
    planned_changes: [],
    ready_to_build: false,
    build_prompt: "",
    quick_replies: [
      { label: "补充具体功能", value: "我想做一个具体的小屏应用，功能是：" },
      { label: "基于当前项目修改", value: "请基于当前项目，明确修改这个页面/功能：" },
      { label: "先查看项目现状", value: "先读取当前项目并告诉我现有文件、硬件能力和可修改范围。" },
    ],
    project_memory: normalizeProjectMemory(state.projectMemory),
    route_profile: state.routeProfile,
    context_retrieval: state.context_retrieval || null,
  };
}

function validateTaskContractBoundary(contract = null) {
  const allowedModelWritable = new Set(MODEL_WRITABLE_FILE_NAMES);
  const systemOwnedFiles = ["hardware_app.py", "manifest.json"];
  const modelWritableFiles = Array.isArray(contract?.model_writable_files)
    ? contract.model_writable_files.map(normalizeFileName).filter(Boolean)
    : [...MODEL_WRITABLE_FILE_NAMES];
  const requiredFiles = Array.isArray(contract?.required_files)
    ? contract.required_files.map(normalizeFileName).filter(Boolean)
    : [];
  const issues = [];

  if (contract && contract.schema_version !== "agent-task-contract.v1") {
    issues.push({
      code: "TASK_CONTRACT_SCHEMA_UNSUPPORTED",
      message: "task contract schema is unsupported.",
    });
  }
  for (const filename of modelWritableFiles) {
    if (!allowedModelWritable.has(filename)) {
      issues.push({
        code: "MODEL_WRITABLE_FILE_FORBIDDEN",
        message: `${filename} is system-owned and cannot be model-writable.`,
        filename,
      });
    }
  }

  return {
    ok: issues.length === 0,
    contractAttached: Boolean(contract),
    schema: contract?.schema_version || "",
    requiredFiles,
    modelWritableFiles,
    systemOwnedFiles,
    issues,
  };
}

function contractBlockedResponse(verdict = {}, state = {}) {
  return {
    ok: true,
    mode: "clarify",
    intent: "clarify",
    reply: "当前任务被硬件契约拦截：模型不能直接修改系统托管的硬件文件。请继续描述你想改变的界面、交互或数据，平台会自动注入硬件运行合同。",
    understanding: [
      "hardware_app.py 和 manifest.json 属于系统托管文件。",
      "模型只允许修改 index.html、style.css、app.js。",
    ],
    planned_changes: [],
    ready_to_build: false,
    build_prompt: "",
    quick_replies: [
      { label: "只改界面", value: "不要修改硬件函数，只修改界面视觉和交互。" },
      { label: "调用硬件能力", value: "保持硬件契约不变，只调用已有硬件 API 完成功能。" },
      { label: "重新整理需求", value: "重新整理需求并按 VibeBoard 硬件契约生成。" },
    ],
    project_memory: normalizeProjectMemory(state.projectMemory),
    contract_firewall: verdict,
  };
}

function buildContextBundle(state = {}) {
  return {
    projectMemory: normalizeProjectMemory(state.projectMemory),
    assetContext: truncateText(state.assetContext, 16000),
    retrievedContextText: truncateText(state.retrievedContextText, 16000),
    contextRetrieval: normalizeContextRetrieval(state.context_retrieval),
    debugContext: normalizeDebugContext(state.debugContext),
  };
}

function publicContextBundle(bundle = null) {
  if (!bundle) {
    return {
      projectMemoryAttached: false,
      assetContextAttached: false,
      debugContextAttached: false,
      retrievedEntries: 0,
      availableLayers: [],
      degraded: false,
    };
  }
  return {
    projectMemoryAttached: hasProjectMemory(bundle.projectMemory),
    assetContextAttached: Boolean(bundle.assetContext),
    debugContextAttached: hasDebugContext(bundle.debugContext),
    retrievedEntries: bundle.contextRetrieval?.entryCount || 0,
    availableLayers: bundle.contextRetrieval?.availableLayers || [],
    degraded: Boolean(bundle.contextRetrieval?.degraded),
  };
}

function normalizeContextRetrieval(meta = {}) {
  const input = meta && typeof meta === "object" ? meta : {};
  return {
    degraded: Boolean(input.degraded),
    availableLayers: Array.isArray(input.availableLayers) ? input.availableLayers.map(String).slice(0, 12) : [],
    entryCount: Math.max(0, Number(input.entryCount || 0) || 0),
    errors: Array.isArray(input.errors)
      ? input.errors.slice(0, 6).map(error => ({
        source: String(error?.source || "").slice(0, 80),
        message: String(error?.message || error || "").slice(0, 240),
      }))
      : [],
  };
}

function normalizeDebugContext(debugContext = null) {
  if (!plainObject(debugContext)) {
    return { previousFailures: [], playbooks: [], attempt: 0 };
  }
  return {
    attempt: Math.max(0, Number(debugContext.attempt || 0) || 0),
    previousFailures: Array.isArray(debugContext.previousFailures)
      ? debugContext.previousFailures.slice(0, 5).map(compactDebugFailure)
      : [],
    playbooks: Array.isArray(debugContext.playbooks)
      ? debugContext.playbooks.slice(0, 3).map(compactDebugPlaybook)
      : [],
  };
}

function compactDebugFailure(failure = {}) {
  return {
    attempt: Number(failure.attempt || 0) || 0,
    signature: String(failure.signature || "").slice(0, 120),
    errorType: String(failure.errorType || "").slice(0, 80),
    errorStage: String(failure.errorStage || "").slice(0, 80),
    errorLabel: String(failure.errorLabel || "").slice(0, 120),
    message: String(failure.message || "").slice(0, 600),
    technicalDetail: String(failure.technicalDetail || "").slice(0, 800),
  };
}

function compactDebugPlaybook(playbook = {}) {
  return {
    signature: String(playbook.signature || "").slice(0, 120),
    title: String(playbook.title || "").slice(0, 160),
    root_cause: String(playbook.root_cause || "").slice(0, 400),
    diagnosis_steps: Array.isArray(playbook.diagnosis_steps)
      ? playbook.diagnosis_steps.slice(0, 5).map(item => String(item).slice(0, 300))
      : [],
    fix: String(playbook.fix || "").slice(0, 600),
    score: Number(playbook.score || 0) || 0,
  };
}

function hasDebugContext(debugContext = {}) {
  return Boolean(debugContext?.previousFailures?.length || debugContext?.playbooks?.length);
}

function truncateText(value = "", limit = 12000) {
  const text = String(value || "");
  return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeFileName(value = "") {
  return String(value || "").trim().replaceAll("\\", "/");
}

function traceEntry(node, status = "done", detail = {}) {
  return {
    node,
    status,
    detail: sanitizeDetail(detail),
    at: new Date().toISOString(),
  };
}

function sanitizeDetail(detail = {}) {
  const result = {};
  for (const [key, value] of Object.entries(detail || {})) {
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.slice(0, 10).map(item => String(item));
    } else {
      result[key] = String(value);
    }
  }
  return result;
}

function hasProjectMemory(memory = {}) {
  const normalized = normalizeProjectMemory(memory);
  return Boolean(normalized.summary || normalized.goal || normalized.build_prompt);
}

function normalizeAction(action) {
  const value = String(action || "message").trim();
  if (value === "confirm_build") return "confirm_build";
  return "message";
}

function replaceValue(left, right) {
  return right === undefined ? left : right;
}

function requireStep(fn, node) {
  if (typeof fn !== "function") {
    throw new Error(`AgentWorkflowGraphV2 missing required node: ${node}`);
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
