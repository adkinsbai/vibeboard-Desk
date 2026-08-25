import assert from "node:assert/strict";

import { createAgentOrchestrator } from "../src/agentOrchestrator.mjs";
import { buildGenerateAgentSettings } from "../src/generateRuntime.mjs";

const files = {
  "index.html": "<html></html>",
  "style.css": "body{}",
  "app.js": "console.log('app')",
  "hardware_app.py": "# system-owned",
  "manifest.json": "{}",
};

const projectMemory = {
  summary: "A 480x360 hardware project",
  goal: "Keep the existing small-screen app stable",
  requirements: ["No touch input"],
  constraints: ["Hardware contract is system-owned"],
  decisions: ["Use the existing dark theme"],
  open_questions: [],
  build_prompt: "",
};

const captured = [];
const conversationStore = {
  async getProjectMemory() {
    return projectMemory;
  },
  async loadConversationFiles(conversationId) {
    return { files: conversationId === "existing" ? files : {} };
  },
  async listMessages() {
    return [{ id: "m-1", role: "user", content: "Use the current dark theme" }];
  },
  async setProjectMemory() {},
};

const orchestrator = createAgentOrchestrator({
  conversationStore,
  memoryStore: { getAll: () => ({ theme: "dark" }) },
  assetLibraryStore: {
    listAssets: () => [{ id: "asset-1", name: "snow.png", kind: "image", usage: "embeddable" }],
    promptContext: (_id, options) => `asset-query:${options.query}`,
  },
  contextRetriever: {
    async loadMemoryContext(input) {
      return {
        input,
        degraded: false,
        availableLayers: ["projectMemory", "recentMessages", "assetSummaries"],
        entries: [{ source: "projectMemory", scope: { projectId: input.projectId }, content: "Use the existing dark theme", confidence: 0.99, provenance: { test: true } }],
        errors: [],
      };
    },
    formatMemoryContext(result) {
      return result.entries.map(entry => entry.content).join("\n");
    },
  },
  runGenerateRequest: async body => {
    captured.push(body);
    return { ok: true, id: `build-${captured.length}`, buildEvidence: { ok: true, issues: [] } };
  },
});

const patch = await orchestrator.runAgentRequest({
  action: "confirm_build",
  conversation_id: "existing",
  build_prompt: "把首页标题改成绿色",
  modelSettings: { enabled: false },
});
assert.equal(patch.mode, "build_done");
assert.equal(patch.route_profile.route, "fast_patch");
assert.equal(captured.at(-1).route_profile.route, "fast_patch");
assert(captured.at(-1).context_retrieval.entryCount === 1, "build should carry bounded retrieval evidence");

const calendar = await orchestrator.runAgentRequest({
  action: "confirm_build",
  conversation_id: "new-calendar",
  build_prompt: "生成一个日历",
  modelSettings: { enabled: false },
});
assert.equal(calendar.mode, "build_done");
assert.equal(calendar.route_profile.route, "guided_build");

const microphone = await orchestrator.runAgentRequest({
  action: "confirm_build",
  conversation_id: "new-mic",
  build_prompt: "接入麦克风并显示录音状态",
  modelSettings: { enabled: false },
});
assert.equal(microphone.mode, "build_done");
assert.equal(microphone.route_profile.route, "full_agent");
assert(microphone.route_profile.hard_gates.includes("hardware_or_deploy"));

const unclear = await orchestrator.runAgentRequest({
  action: "confirm_build",
  conversation_id: "new-unclear",
  build_prompt: "把之前那个改好",
  modelSettings: { enabled: false },
});
assert.equal(unclear.mode, "clarify");
assert.equal(unclear.ready_to_build, false);
assert.equal(unclear.route_profile.route, "clarify_or_block");
assert.equal(captured.length, 3, "ambiguous confirmation must not start generation");
assert(Array.isArray(unclear.quick_replies) && unclear.quick_replies.length >= 2);

const baseSettings = {
  enabled: true,
  maxIterations: 18,
  maxVerificationAttempts: 3,
  repairAttempts: 2,
};
const fastSettings = buildGenerateAgentSettings(baseSettings, {}, value => Number(value), { maxIterations: 18, maxVerificationAttempts: 3, repairAttempts: 2, timeoutMs: 120000, llmTimeoutMs: 60000 }, {
  max_model_turns: 4,
  max_verification_attempts: 1,
  repair_attempts: 0,
});
assert.equal(fastSettings.maxIterations, 4);
assert.equal(fastSettings.maxVerificationAttempts, 1);
assert.equal(fastSettings.repairAttempts, 0);

console.log("PASS context routing integration");
