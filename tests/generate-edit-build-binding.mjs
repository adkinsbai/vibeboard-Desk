import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert } from "./support/serverHarness.mjs";
import { createGenerateRuntime } from "../src/generateRuntime.mjs";

await test("edit requests must provide the current build id when conversation files exist", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vibeboard-edit-binding-"));
  let runAgentCalls = 0;
  const runtime = createTestRuntime({
    generatedDir: dir,
    conversationFiles: {
      buildId: "build-current",
      files: validFiles("build-current"),
    },
    runAgent: async () => {
      runAgentCalls += 1;
      return {
        success: true,
        summary: "edited",
        files: validFiles("build-edited"),
        actions: [],
      };
    },
  });

  let caught = null;
  try {
    await runtime.runGenerateRequest({
      prompt: "add today's income at the top",
      conversation_id: "conv-edit",
      modelSettings: enabledModelSettings(),
    });
  } catch (error) {
    caught = error;
  }

  assert(caught, "missing current_build_id should reject before agent execution");
  assert(caught.errorType === "build_context_required", `expected build_context_required, got ${caught.errorType}`);
  assert(runAgentCalls === 0, "agent must not run when edit build binding is missing");
});

await test("edit requests reject stale current_build_id instead of starting a new project", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vibeboard-edit-binding-"));
  let runAgentCalls = 0;
  const runtime = createTestRuntime({
    generatedDir: dir,
    conversationFiles: {
      buildId: "build-current",
      files: validFiles("build-current"),
    },
    runAgent: async () => {
      runAgentCalls += 1;
      return {
        success: true,
        summary: "edited",
        files: validFiles("build-edited"),
        actions: [],
      };
    },
  });

  let caught = null;
  try {
    await runtime.runGenerateRequest({
      prompt: "add today's income at the top",
      conversation_id: "conv-edit",
      current_build_id: "build-stale",
      modelSettings: enabledModelSettings(),
    });
  } catch (error) {
    caught = error;
  }

  assert(caught, "stale current_build_id should reject before agent execution");
  assert(caught.errorType === "build_context_stale", `expected build_context_stale, got ${caught.errorType}`);
  assert(runAgentCalls === 0, "agent must not run when edit build binding is stale");
});

await test("edit requests with matching current_build_id run against existing files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vibeboard-edit-binding-"));
  let receivedFiles = null;
  let savedSnapshot = null;
  const runtime = createTestRuntime({
    generatedDir: dir,
    conversationFiles: {
      buildId: "build-current",
      files: validFiles("build-current"),
    },
    runAgent: async (_settings, _prompt, fileStore) => {
      receivedFiles = { ...fileStore };
      return {
        success: true,
        summary: "edited",
        files: {
          ...fileStore,
          "app.js": `${fileStore["app.js"]}\nconsole.log("income added");`,
        },
        actions: [],
      };
    },
    saveConversationFiles: (conversationId, buildId, files) => {
      savedSnapshot = { conversationId, buildId, files };
    },
  });

  const result = await runtime.runGenerateRequest({
    prompt: "add today's income at the top",
    conversation_id: "conv-edit",
    current_build_id: "build-current",
    modelSettings: enabledModelSettings(),
  });

  assert(result.ok === true, "matching edit build should generate successfully");
  assert(receivedFiles?.["index.html"]?.includes("build-current"), "agent should receive existing conversation files");
  assert(savedSnapshot?.conversationId === "conv-edit", "successful edit should save a new snapshot");
});

function createTestRuntime({
  generatedDir,
  conversationFiles,
  runAgent,
  saveConversationFiles,
} = {}) {
  let currentBuild = null;
  return createGenerateRuntime({
    generatedDir,
    conversationStore: {
      getProjectMemory: () => ({}),
      loadConversationFiles: () => conversationFiles || { buildId: null, files: {} },
      saveConversationFiles: saveConversationFiles || (() => {}),
    },
    memoryStore: {
      getAll: () => ({}),
      set: () => {},
    },
    runAgent,
    buildId: () => "build-edited",
    createAppSpec: () => ({ title: "Edit test" }),
    generatedHardwareApp: (_prompt, id) => `print({"build_id":"${id}","runtime":"executed_on_board","available_apis":[]})`,
    injectAppHardwareSdkContracts: source => source,
    injectHardwareAppContracts: source => source,
    generatedManifest: (_prompt, id) => ({ id, files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
    buildCurrent: async () => {
      if (!currentBuild?.files?.["index.html"]) {
        const error = new Error("missing index");
        error.errorType = "no_code";
        throw error;
      }
    },
    setCurrentBuild: build => { currentBuild = build; },
    getCurrentBuild: () => currentBuild,
    filesWithHardwareResult: async files => files,
    appendServerLog: async () => {},
    isBoardPasswordConfigured: () => false,
  });
}

function validFiles(buildId) {
  return {
    "index.html": `<!doctype html><html><body><main>${buildId}</main><script src="app.js"></script></body></html>`,
    "style.css": "body{font-family:sans-serif}",
    "app.js": `window.BUILD_ID="${buildId}";`,
    "hardware_app.py": `print({"build_id":"${buildId}","runtime":"executed_on_board","available_apis":[]})`,
    "manifest.json": JSON.stringify({ id: buildId, files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"] }),
  };
}

function enabledModelSettings() {
  return {
    enabled: true,
    provider: "custom",
    baseUrl: "https://example.test/v1",
    model: "stub-model",
    apiKey: "test-key",
  };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
