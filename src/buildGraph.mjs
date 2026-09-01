export const BUILD_GRAPH_NODES = Object.freeze({
  PREPARE: "prepare",
  OFFLINE_SIMULATION: "offline_simulation",
  AGENT_GENERATE: "agent_generate",
  ENSURE_CONTRACTS: "ensure_contracts",
  LOCAL_VERIFY: "local_verify",
  SAVE_SNAPSHOT: "save_snapshot",
  RESPOND: "respond",
});

export function createBuildGraphTrace() {
  return [];
}

export function appendBuildGraphTrace(trace, node, status = "done", detail = {}) {
  trace.push({
    node,
    status,
    detail: sanitizeDetail(detail),
    at: new Date().toISOString(),
  });
  return trace;
}

export function summarizeBuildGraph(trace = []) {
  return trace.map(item => `${item.node}:${item.status}`);
}

export async function runBuildGraph(input = {}, steps = {}) {
  const trace = createBuildGraphTrace();
  const state = {
    ...input,
    trace,
    files: {},
    result: null,
  };

  appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.PREPARE, "start", {
    hasModel: Boolean(input.settings?.enabled),
    isEditing: Boolean(input.isEditing),
    conversationId: input.conversationId || "",
  });
  if (steps.prepare) await steps.prepare(state);
  appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.PREPARE, "done");

  if (input.offlineSimulation === true) {
    requireStep(steps.offlineSimulation, BUILD_GRAPH_NODES.OFFLINE_SIMULATION);
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.OFFLINE_SIMULATION, "start");
    state.result = await steps.offlineSimulation(state);
    state.files = state.result?.files || {};
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.OFFLINE_SIMULATION, "done", {
      id: state.result?.id || "",
      fileCount: Object.keys(state.files).length,
    });
  } else {
    if (!input.settings?.enabled) {
      throw missingModelError();
    }
    requireStep(steps.agentGenerate, BUILD_GRAPH_NODES.AGENT_GENERATE);
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.AGENT_GENERATE, "start", {
      fileCount: Object.keys(input.fileStore || {}).length,
    });
    state.result = await steps.agentGenerate(state);
    state.files = state.result?.files || {};
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.AGENT_GENERATE, "done", {
      id: state.result?.id || "",
      fileCount: Object.keys(state.files).length,
      actionCount: state.result?.agentActions?.length || 0,
    });
  }

  if (steps.ensureContracts) {
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.ENSURE_CONTRACTS, "start");
    await steps.ensureContracts(state);
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.ENSURE_CONTRACTS, "done");
  }

  if (steps.localVerify) {
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.LOCAL_VERIFY, "start");
    await steps.localVerify(state);
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.LOCAL_VERIFY, "done", {
      ok: Boolean(state.result?.buildEvidence?.ok),
    });
  }

  if (steps.saveSnapshot) {
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.SAVE_SNAPSHOT, "start", {
      conversationId: input.conversationId || "",
    });
    await steps.saveSnapshot(state);
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.SAVE_SNAPSHOT, "done");
  }

  if (steps.respond) {
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.RESPOND, "start");
    state.result = await steps.respond(state);
    appendBuildGraphTrace(trace, BUILD_GRAPH_NODES.RESPOND, "done");
  }

  return {
    ...state.result,
    buildGraph: trace,
  };
}

function missingModelError() {
  const error = new Error("A configured AI model is required for code generation.");
  error.errorType = "no_api_key";
  error.statusCode = 400;
  return error;
}

function requireStep(fn, node) {
  if (typeof fn !== "function") {
    throw new Error(`BuildGraph missing required node: ${node}`);
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
