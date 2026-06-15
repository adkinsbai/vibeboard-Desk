import { normalizeProjectMemory } from "./conversationStore.mjs";

export const AGENT_GRAPH_NODES = Object.freeze({
  LOAD_CONTEXT: "load_context",
  INTENT_MEMORY: "intent_memory",
  CONFIRM_GATE: "confirm_gate",
  BUILD_GRAPH: "build_graph",
  DEBUG_REFLECT: "debug_reflect",
  RESPOND: "respond",
});

export function createAgentGraphTrace() {
  return [];
}

export function appendAgentGraphTrace(trace, node, status = "done", detail = {}) {
  trace.push({
    node,
    status,
    detail: sanitizeDetail(detail),
    at: new Date().toISOString(),
  });
  return trace;
}

export function summarizeAgentGraph(trace = []) {
  return trace.map(item => `${item.node}:${item.status}`);
}

export async function runAgentGraph(input = {}, steps = {}) {
  const trace = createAgentGraphTrace();
  const state = {
    ...input,
    action: normalizeAction(input.action),
    messages: Array.isArray(input.messages) ? input.messages : [],
    projectMemory: normalizeProjectMemory(input.projectMemory),
    plan: null,
    build: null,
    trace,
  };

  appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.LOAD_CONTEXT, "start", {
    action: state.action,
    conversationId: state.conversationId || "",
    hasMemory: Boolean(state.projectMemory.summary || state.projectMemory.goal || state.projectMemory.build_prompt),
  });
  if (steps.loadContext) await steps.loadContext(state);
  appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.LOAD_CONTEXT, "done");

  if (state.action === "message") {
    requireStep(steps.planMessage, AGENT_GRAPH_NODES.INTENT_MEMORY);
    appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.INTENT_MEMORY, "start", {
      messageCount: state.messages.length,
    });
    state.plan = await steps.planMessage(state);
    if (state.plan?.project_memory) {
      state.projectMemory = normalizeProjectMemory(state.plan.project_memory);
    }
    appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.INTENT_MEMORY, "done", {
      intent: state.plan?.intent || "",
      readyToBuild: Boolean(state.plan?.ready_to_build),
      target: state.plan?.target || "",
    });

    appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.CONFIRM_GATE, state.plan?.ready_to_build ? "waiting" : "blocked", {
      reason: state.plan?.ready_to_build ? "awaiting_user_confirmation" : "chat_or_clarify",
    });

    appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.RESPOND, "done", {
      mode: state.plan?.ready_to_build ? "confirm_required" : "chat",
    });
    return {
      ok: true,
      mode: state.plan?.ready_to_build ? "confirm_required" : "chat",
      ...state.plan,
      agentGraph: trace,
    };
  }

  if (state.action === "confirm_build") {
    const prompt = String(input.buildPrompt || input.prompt || state.projectMemory.build_prompt || "").trim();
    appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.CONFIRM_GATE, prompt ? "passed" : "blocked", {
      hasBuildPrompt: Boolean(prompt),
    });
    if (!prompt) {
      appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.RESPOND, "done", { mode: "clarify" });
      return {
        ok: true,
        mode: "clarify",
        intent: "clarify",
        reply: "我还没有整理出可构建的完整需求，请先继续补充或确认方案。",
        ready_to_build: false,
        build_prompt: "",
        project_memory: state.projectMemory,
        agentGraph: trace,
      };
    }

    requireStep(steps.build, AGENT_GRAPH_NODES.BUILD_GRAPH);
    appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.BUILD_GRAPH, "start", {
      promptLength: prompt.length,
    });
    state.build = await steps.build(state, prompt);
    appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.BUILD_GRAPH, "done", {
      id: state.build?.id || "",
      source: state.build?.source || "",
      ok: Boolean(state.build?.ok),
    });

    if (steps.reflect) {
      appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.DEBUG_REFLECT, "start", {
        issueCount: state.build?.buildEvidence?.issues?.length || 0,
      });
      await steps.reflect(state);
      appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.DEBUG_REFLECT, "done", {
        learned: Boolean(state.learning),
      });
    }

    appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.RESPOND, "done", { mode: "build_done" });
    return {
      ...state.build,
      mode: "build_done",
      agentGraph: trace,
    };
  }

  appendAgentGraphTrace(trace, AGENT_GRAPH_NODES.RESPOND, "done", { mode: "chat" });
  return {
    ok: true,
    mode: "chat",
    intent: "chat",
    reply: "我可以先和你把需求聊清楚。确认后，我再开始生成、验证并保存预览。",
    ready_to_build: false,
    build_prompt: "",
    project_memory: state.projectMemory,
    agentGraph: trace,
  };
}

function normalizeAction(action) {
  const value = String(action || "message").trim();
  if (value === "confirm_build") return "confirm_build";
  return "message";
}

function requireStep(fn, node) {
  if (typeof fn !== "function") {
    throw new Error(`AgentGraph missing required node: ${node}`);
  }
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
