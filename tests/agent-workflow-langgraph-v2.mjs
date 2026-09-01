import assert from "node:assert/strict";

import {
  AGENT_WORKFLOW_V2_NODES,
  runAgentWorkflowGraphV2,
} from "../src/agentWorkflowGraphV2.mjs";
import { createAgentOrchestrator } from "../src/agentOrchestrator.mjs";

{
  let loaded = false;
  const result = await runAgentWorkflowGraphV2({
    action: "message",
    messages: [{ role: "user", content: "做一个天气小屏" }],
    conversationId: "conv-weather",
    projectMemory: {},
  }, {
    loadContext: async state => {
      loaded = true;
      return { loaded_context: { conversationId: state.conversationId } };
    },
    planMessage: async state => ({
      intent: "build_ready",
      reply: "我已经理解，可以开始生成。",
      ready_to_build: true,
      build_prompt: `weather app for ${state.loaded_context.conversationId}`,
      project_memory: {
        summary: "天气小屏",
        goal: "生成天气小屏",
        requirements: ["天气"],
        constraints: ["480x360"],
        open_questions: [],
        decisions: [],
        build_prompt: "weather app",
      },
    }),
  });

  assert.equal(loaded, true, "LangGraph v2 should run load_context before planning");
  assert.equal(result.workflow_engine, "langgraph-v2");
  assert.equal(result.mode, "confirm_required");
  assert.equal(result.build_prompt, "weather app for conv-weather");
  assert.equal(result.project_memory.summary, "天气小屏");
  assert(result.agentGraphV2.some(item => item.node === AGENT_WORKFLOW_V2_NODES.LOAD_CONTEXT), "trace should include load_context");
  assert(result.agentGraphV2.some(item => item.node === AGENT_WORKFLOW_V2_NODES.PLAN_REQUIREMENT), "trace should include plan_requirement");
  assert(result.agentGraphV2.some(item => item.node === AGENT_WORKFLOW_V2_NODES.CONFIRM_GATE), "trace should include confirm gate");
}

{
  let built = false;
  const result = await runAgentWorkflowGraphV2({
    action: "confirm_build",
    buildPrompt: "做一个计时器",
    projectMemory: { summary: "计时器", build_prompt: "做一个计时器" },
  }, {
    build: async (_state, prompt) => {
      built = true;
      return {
        ok: true,
        id: "vb-test-v2",
        source: "test",
        buildEvidence: { ok: true, issues: [] },
        prompt,
      };
    },
    reflect: async state => {
      return { learning: { learned: Boolean(state.build?.buildEvidence?.ok) } };
    },
  });

  assert.equal(built, true, "confirmed build should call the build node");
  assert.equal(result.workflow_engine, "langgraph-v2");
  assert.equal(result.mode, "build_done");
  assert.equal(result.id, "vb-test-v2");
  assert.equal(result.deploy_approval?.status, "waiting", "successful builds should end at a deploy approval gate");
  assert(result.agentGraphV2.some(item => item.node === AGENT_WORKFLOW_V2_NODES.BUILD_GRAPH), "trace should include build node");
  assert(result.agentGraphV2.some(item => item.node === AGENT_WORKFLOW_V2_NODES.DEPLOY_APPROVAL), "trace should include deploy approval node");
}

{
  let built = false;
  const result = await runAgentWorkflowGraphV2({
    action: "confirm_build",
    projectMemory: {},
  }, {
    build: async () => {
      built = true;
      return { ok: true };
    },
  });

  assert.equal(built, false, "confirm_build without a build prompt must not call build");
  assert.equal(result.workflow_engine, "langgraph-v2");
  assert.equal(result.mode, "clarify");
  assert.equal(result.ready_to_build, false);
  assert(result.agentGraphV2.some(item => item.status === "blocked"), "trace should record the blocked gate");
}

{
  let buildState = null;
  const result = await runAgentWorkflowGraphV2({
    action: "confirm_build",
    buildPrompt: "修复 480x360 布局",
    projectMemory: {
      summary: "翻牌薪资小屏",
      requirements: ["数字翻牌动画"],
      constraints: ["480x360 no overflow"],
      build_prompt: "修复 480x360 布局",
    },
    asset_context: "Asset Library: salary-bg.png image embeddable",
    retrieved_context_text: "Memory context\n1. projectMemory | content: daily salary is 1000",
    context_retrieval: {
      entryCount: 2,
      availableLayers: ["projectMemory", "assetSummaries"],
      degraded: false,
      errors: [],
    },
    debug_context: {
      previousFailures: [{ errorType: "render_failed", message: "LAYOUT_OVERFLOW" }],
      playbooks: [{ title: "Fix overflow", fix: "constrain fixed screen dimensions" }],
    },
  }, {
    build: async (state, prompt) => {
      buildState = state;
      return {
        ok: true,
        id: "vb-context-v2",
        source: "test",
        prompt,
        buildEvidence: { ok: true, issues: [] },
      };
    },
  });

  assert.equal(result.mode, "build_done");
  assert.equal(buildState.contextBundle.projectMemory.summary, "翻牌薪资小屏");
  assert(buildState.contextBundle.assetContext.includes("salary-bg.png"), "v2 build should receive asset context");
  assert(buildState.contextBundle.retrievedContextText.includes("daily salary is 1000"), "v2 build should receive retrieved memory text");
  assert.equal(buildState.contextBundle.contextRetrieval.entryCount, 2, "v2 build should receive retrieval metadata");
  assert.equal(buildState.contextBundle.debugContext.previousFailures.length, 1, "v2 build should receive debug context");
  const retrieveTrace = result.agentGraphV2.find(item => item.node === AGENT_WORKFLOW_V2_NODES.RETRIEVE_CONTEXT);
  assert(retrieveTrace, "trace should include retrieve_context");
  assert.equal(retrieveTrace.detail.assetContextAttached, true);
  assert.equal(retrieveTrace.detail.debugContextAttached, true);
  assert.equal(result.context_bundle.retrievedEntries, 2, "public result should expose a compact context summary");
}

{
  let built = false;
  const result = await runAgentWorkflowGraphV2({
    action: "confirm_build",
    buildPrompt: "尝试修改硬件入口",
    projectMemory: { summary: "硬件契约测试", build_prompt: "尝试修改硬件入口" },
    task_contract: {
      schema_version: "agent-task-contract.v1",
      objective: "尝试修改硬件入口",
      required_files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"],
      model_writable_files: ["index.html", "style.css", "app.js", "hardware_app.py"],
      acceptance_criteria: [],
      forbidden: [],
      screen: { width: 480, height: 360, touch: false },
      controls: ["KEY1", "KEY2", "KEY3"],
    },
  }, {
    build: async () => {
      built = true;
      return { ok: true };
    },
  });

  assert.equal(built, false, "contract firewall should block model writes to hardware_app.py");
  assert.equal(result.mode, "clarify");
  assert.equal(result.ready_to_build, false);
  const contractTrace = result.agentGraphV2.find(item => item.node === AGENT_WORKFLOW_V2_NODES.CONTRACT_FIREWALL);
  assert(contractTrace, "trace should include contract_firewall");
  assert.equal(contractTrace.status, "blocked");
  assert(result.contract_firewall.issues.some(issue => issue.code === "MODEL_WRITABLE_FILE_FORBIDDEN"));
}

{
  const orchestrator = createAgentOrchestrator({
    conversationStore: {
      getProjectMemory: async () => ({}),
      loadConversationFiles: async () => ({ files: {} }),
      setProjectMemory: async () => {},
    },
    memoryStore: { getAll: () => [] },
    runGenerateRequest: async () => ({ ok: true, id: "unused" }),
  });
  const result = await orchestrator.runAgentRequest({
    action: "message",
    workflow_version: "langgraph-v2",
    messages: [{ role: "user", content: "做一个简单日历" }],
    modelSettings: { enabled: false },
  });

  assert.equal(result.workflow_engine, "langgraph-v2", "orchestrator should route explicit v2 requests to LangGraph");
  assert(Array.isArray(result.agentGraphV2), "orchestrator result should include the LangGraph v2 trace");
}

{
  const captured = [];
  const orchestrator = createAgentOrchestrator({
    conversationStore: {
      getProjectMemory: async () => ({ summary: "资产天气屏", build_prompt: "生成天气屏" }),
      loadConversationFiles: async () => ({ files: {} }),
      setProjectMemory: async () => {},
    },
    memoryStore: { getAll: () => [] },
    assetLibraryStore: {
      listAssets: () => [{ id: "asset-1", name: "weather.png", kind: "image", usage: "embeddable" }],
      promptContext: () => "Asset Library: weather.png",
    },
    contextRetriever: {
      async loadMemoryContext() {
        return {
          degraded: false,
          availableLayers: ["projectMemory", "assetSummaries"],
          entries: [{ source: "projectMemory", content: "Use weather.png" }],
          errors: [],
        };
      },
      formatMemoryContext(result) {
        return result.entries.map(entry => entry.content).join("\n");
      },
    },
    runGenerateRequest: async body => {
      captured.push(body);
      return { ok: true, id: "vb-orchestrator-v2", buildEvidence: { ok: true, issues: [] } };
    },
  });
  const result = await orchestrator.runAgentRequest({
    action: "confirm_build",
    conversation_id: "v2-context-project",
    workflow_version: "langgraph-v2",
    build_prompt: "生成天气屏",
    debug_context: {
      previousFailures: [{ errorType: "model_output_invalid", message: "missing manifest" }],
    },
    modelSettings: { enabled: false },
  });

  assert.equal(result.workflow_engine, "langgraph-v2");
  assert.equal(captured.at(-1).context_retrieval.entryCount, 1, "v2 orchestrator should preserve retrieval evidence for generation");
  assert.equal(captured.at(-1).debug_context.previousFailures.length, 1, "v2 orchestrator should pass debug evidence to generation");
  assert(captured.at(-1).prompt.includes("Automatic debug context"), "debug context should reach the generation prompt");
  assert(!captured.at(-1).task_contract.model_writable_files.includes("hardware_app.py"), "v2 orchestrator task contract should keep hardware_app.py read-only");
  assert(result.agentGraphV2.some(item => item.node === AGENT_WORKFLOW_V2_NODES.CONTRACT_FIREWALL && item.status === "passed"), "v2 orchestrator should pass through the contract firewall node");
  assert.equal(result.context_bundle.retrievedEntries, 1, "v2 result should expose context retrieval summary");
}

console.log("agent-workflow-langgraph-v2: core graph contract passed");
