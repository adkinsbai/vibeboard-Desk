import { runBuildGraph } from "./buildGraph.mjs";
import { buildRefinedPrompt } from "./clarifyEngine.mjs";
import { normalizeProjectMemory } from "./conversationStore.mjs";
import { normalizeModelSettings } from "./modelSettings.mjs";
import { normalizeAssetPath } from "./assetContract.mjs";
import {
  AGENT_PHASES,
  appendEvidence,
  buildInitialSpec,
  createAgentRun,
  formatRunEvidence,
  transitionRun,
} from "./agentStateMachine.mjs";
import { writeGeneratedFiles } from "./buildArtifact.mjs";

export const GENERATE_RUNTIME_DEFAULTS = Object.freeze({
  maxIterations: 18,
  maxVerificationAttempts: 1,
  timeoutMs: 120000,
  llmTimeoutMs: 60000,
});

export function formatProjectMemoryForPrompt(memory = {}) {
  const normalized = normalizeProjectMemory(memory);
  const lines = [];
  if (normalized.summary) lines.push(`Summary: ${normalized.summary}`);
  if (normalized.goal) lines.push(`Goal: ${normalized.goal}`);
  if (normalized.requirements.length) lines.push(`Requirements:\n${normalized.requirements.map(item => `- ${item}`).join("\n")}`);
  if (normalized.constraints.length) lines.push(`Constraints:\n${normalized.constraints.map(item => `- ${item}`).join("\n")}`);
  if (normalized.decisions.length) lines.push(`Confirmed decisions:\n${normalized.decisions.map(item => `- ${item}`).join("\n")}`);
  if (normalized.open_questions.length) lines.push(`Open questions:\n${normalized.open_questions.map(item => `- ${item}`).join("\n")}`);
  if (!lines.length) return "";
  return `\n\n## Current project memory\n${lines.join("\n")}`;
}

export function createGenerateRuntime(deps = {}) {
  const {
    conversationStore,
    memoryStore,
    assetLibraryStore,
    experienceStore,
    runAgent,
    appendServerLog = async () => {},
    normalizeGenerateHistory = defaultNormalizeGenerateHistory,
    compressHistory = async history => history,
    structuredErrorFieldsForLog = () => ({}),
    positiveInt = defaultPositiveInt,
    env = process.env,
    defaults = GENERATE_RUNTIME_DEFAULTS,
    getBoard = () => ({}),
    isBoardPasswordConfigured = () => false,
    ssh,
    scp,
    buildId,
    createAppSpec,
    generatedHardwareApp,
    injectHardwareAppContracts,
    generatedManifest,
    writeGenerated,
    buildCurrent,
    recordAgentLearning = () => {},
    filesWithHardwareResult = async files => files,
    generatedDir,
    getCurrentBuild = () => null,
    setCurrentBuild,
    formatMemoryForPrompt = formatProjectMemoryForPrompt,
    log = console,
  } = deps;

  requireObject(conversationStore, "conversationStore");
  requireObject(memoryStore, "memoryStore");

  async function runGenerateRequest(body = {}) {
    const rawPrompt = String(body.prompt || "").trim();
    if (!rawPrompt) throw new Error("Prompt is required.");
    const rawHistory = Array.isArray(body.history) ? body.history : [];
    const normalizedHistory = normalizeGenerateHistory(rawHistory);
    const clarifyAnswers = Array.isArray(body.clarify_answers) ? body.clarify_answers : [];
    const modelSettings = body.modelSettings || {};
    const agentMode = normalizeAgentMode(body.agent_mode || body.agentMode);
    const conversationId = String(body.conversation_id || "").trim();
    const projectMemory = conversationId
      ? conversationStore.getProjectMemory(conversationId)
      : normalizeProjectMemory();
    const assetContext = conversationId && assetLibraryStore?.promptContext
      ? assetLibraryStore.promptContext(conversationId)
      : "";
    const embeddedAssets = conversationId && assetLibraryStore?.generatedAssets
      ? assetLibraryStore.generatedAssets(conversationId)
      : emptyEmbeddedAssets();
    const conversationFiles = conversationId
      ? conversationStore.loadConversationFiles(conversationId).files
      : {};

    const settings = normalizeModelSettings(modelSettings);
    const history = await compressHistory(normalizedHistory, settings);
    const userPreferences = memoryStore.getAll();
    const prompt = buildRefinedPrompt(
      `${rawPrompt}${formatMemoryForPrompt(projectMemory)}${formatAgentModeForPrompt(agentMode)}${assetContext}${formatEmbeddedAssetContext(embeddedAssets)}`,
      clarifyAnswers,
      userPreferences,
    );

    if (embeddedAssets.items?.length || embeddedAssets.rejected?.length) {
      await appendServerLog("generate.assets.selected", {
        embeddedCount: embeddedAssets.items?.length || 0,
        rejectedCount: embeddedAssets.rejected?.length || 0,
        paths: (embeddedAssets.items || []).slice(0, 12).map(item => item.path),
      });
    }

    if (clarifyAnswers.length > 0) {
      for (const ans of clarifyAnswers) {
        if (ans.key && ans.answer) {
          memoryStore.set(ans.key, ans.answer, {
            label: ans.question || ans.key,
            category: "clarify",
            source: "auto_extract",
          });
        }
      }
    }

    const fileStore = { ...conversationFiles };
    const isEditing = Object.keys(fileStore).some(name => name !== "manifest.json");
    const agentStartedAt = Date.now();
    const agentSettings = buildGenerateAgentSettings(settings, env, positiveInt, defaults);

    return runBuildGraph({
      prompt,
      rawPrompt,
      settings,
      agentSettings,
      modelSettings,
      fileStore,
      history,
      userPreferences,
      conversationId,
      isEditing,
      agentMode,
      embeddedAssets,
    }, {
      agentGenerate: async () => runAgentGenerate({
        prompt,
        settings,
        agentSettings,
        fileStore,
        history,
        userPreferences,
        conversationId,
        isEditing,
        agentMode,
        embeddedAssets,
        agentStartedAt,
      }),
      templateGenerate: async () => runTemplateGenerate({ prompt, modelSettings, embeddedAssets }),
      saveSnapshot: async state => saveSnapshot({ state, conversationId }),
    });
  }

  async function runAgentGenerate({
    prompt,
    settings,
    agentSettings,
    fileStore,
    history,
    userPreferences,
    conversationId,
    isEditing,
    agentMode,
    embeddedAssets,
    agentStartedAt,
  }) {
    requireFunction(runAgent, "runAgent");
    requireFunction(buildId, "buildId");
    requireFunction(createAppSpec, "createAppSpec");
    requireFunction(generatedHardwareApp, "generatedHardwareApp");
    requireFunction(injectHardwareAppContracts, "injectHardwareAppContracts");
    requireFunction(generatedManifest, "generatedManifest");
    requireFunction(buildCurrent, "buildCurrent");
    requireFunction(setCurrentBuild, "setCurrentBuild");
    requireString(generatedDir, "generatedDir");

    log.log?.(`[generate] Agent starting (${isEditing ? "edit" : "new"} mode)`);
    await appendServerLog("generate.agent.start", {
      prompt: prompt.slice(0, 160),
      isEditing,
      agentMode,
      fileCount: Object.keys(fileStore).length,
      files: Object.keys(fileStore).slice(0, 12),
      model: settings.model,
      provider: settings.provider,
      maxIterations: agentSettings.maxIterations,
      maxVerificationAttempts: agentSettings.maxVerificationAttempts,
      timeoutMs: agentSettings.timeoutMs,
      llmTimeoutMs: agentSettings.llmTimeoutMs,
    });

    let agentResult;
    try {
      agentResult = await runAgent(agentSettings, prompt, fileStore, history, action => {
        log.log?.(`[agent] ${action.tool}: ${action.args?.path || action.args?.query || action.args?.summary || ""}`);
        appendServerLog("generate.agent.action", {
          tool: action.tool,
          path: action.args?.path || "",
          query: action.args?.query || "",
          summary: action.args?.summary || "",
        }).catch(() => {});
      }, userPreferences, experienceStore, { ssh, scp, board: getBoard() });
    } catch (agentErr) {
      await appendServerLog("generate.agent.failed", {
        error: agentErr.message,
        ...structuredErrorFieldsForLog(agentErr),
        durationMs: Date.now() - agentStartedAt,
      });
      throw agentErr;
    }

    if (!agentResult.success) {
      await appendServerLog("generate.agent.failed", {
        error: agentResult.summary || "Agent failed",
        agentError: agentResult.error || null,
        actionCount: agentResult.actions?.length || 0,
        limit: agentResult.limit || "",
        iteration: agentResult.iteration ?? null,
        durationMs: Date.now() - agentStartedAt,
      });
      const error = new Error(agentResult.summary || "Agent failed");
      if (agentResult.error && typeof agentResult.error === "object") {
        Object.assign(error, agentResult.error);
      }
      throw error;
    }

    const id = buildId();
    let agentFiles = agentResult.files;

    if (!agentFiles["hardware_app.py"]) {
      const spec = createAppSpec(prompt, id);
      agentFiles["hardware_app.py"] = generatedHardwareApp(prompt, id, spec);
    }
    agentFiles["hardware_app.py"] = injectHardwareAppContracts(agentFiles["hardware_app.py"], id);

    const board = getBoard();
    const spec = createAppSpec(prompt, id);
    let manifest = generatedManifest(prompt, id, spec, {
      generator: "vibeboard-agent-v1",
      title: prompt.slice(0, 40),
      source: "agent",
      model: settings.model,
      provider: settings.provider,
      notes: agentResult.summary,
      target: board.targetStatic,
    });
    agentFiles["manifest.json"] = JSON.stringify(manifest, null, 2);
    const embedded = embedGeneratedAssetsInFiles(agentFiles, embeddedAssets, manifest);
    agentFiles = embedded.files;
    manifest = embedded.manifest || manifest;

    await writeGeneratedFiles(generatedDir, agentFiles);
    let agentRun = transitionRun(createAgentRun({
      prompt,
      mode: "agent",
      buildId: id,
      hardwareMode: isBoardPasswordConfigured() ? "real" : "simulated",
    }), AGENT_PHASES.CODE, {
      spec: buildInitialSpec(prompt, { requireBoard: isBoardPasswordConfigured() }),
    });
    agentRun = appendEvidence(agentRun, {
      phase: AGENT_PHASES.CODE,
      ok: true,
      summary: agentResult.summary || "agent code completed",
      evidence: {
        whatWorked: agentResult.whatWorked || [],
        whatFailed: agentResult.whatFailed || [],
        actionCount: agentResult.actions?.length || 0,
      },
      issues: [],
    });
    setCurrentBuild({ id, prompt, files: agentFiles, dir: generatedDir, built: false, deployed: false, manifest, agentRun, conversationId });

    try {
      await buildCurrent();
    } catch (buildErr) {
      log.error?.("[generate] Build error:", buildErr.message);
      await appendServerLog("generate.agent.build_failed", { id, error: buildErr.message });
      throw new Error(`Generated app failed validation: ${buildErr.message}`);
    }

    const currentBuild = getCurrentBuild();
    recordAgentLearning({
      prompt,
      agentResult,
      verificationResult: currentBuild?.buildEvidence || null,
      success: true,
    });

    await appendServerLog("generate.agent.done", {
      id,
      actionCount: agentResult.actions?.length || 0,
      durationMs: Date.now() - agentStartedAt,
    });

    return {
      ok: true,
      id,
      files: agentFiles,
      manifest,
      source: "agent",
      spec: currentBuild?.agentRun?.spec || null,
      evidence: formatRunEvidence(currentBuild?.agentRun || {}),
      buildEvidence: currentBuild?.buildEvidence || null,
      intelligenceSummary: currentBuild?.intelligenceSummary || null,
      verificationMode: isBoardPasswordConfigured() ? "real-ready" : "local-simulated",
      agentSummary: agentResult.summary,
      agentActions: (agentResult.actions || []).map(a => ({
        tool: a.tool,
        path: a.args?.path,
        query: a.args?.query,
        summary: a.args?.summary,
      })),
    };
  }

  async function runTemplateGenerate({ prompt, modelSettings, embeddedAssets }) {
    requireFunction(writeGenerated, "writeGenerated");
    const build = await writeGenerated(prompt, modelSettings, [], embeddedAssets);
    const embedded = embedGeneratedAssetsInFiles(build.files, embeddedAssets, build.manifest);
    return {
      ok: true,
      id: build.id,
      files: embedded.files,
      manifest: embedded.manifest || build.manifest || null,
      source: "template",
      spec: build.agentRun?.spec || null,
      evidence: formatRunEvidence(build.agentRun || {}),
      buildEvidence: build.buildEvidence || null,
      intelligenceSummary: build.intelligenceSummary || null,
      verificationMode: isBoardPasswordConfigured() ? "real-ready" : "local-simulated",
      agentActions: [],
      thinking: "",
    };
  }

  async function saveSnapshot({ state, conversationId }) {
    if (!conversationId) return;
    try {
      conversationStore.saveConversationFiles(
        conversationId,
        state.result.id,
        await filesWithHardwareResult(state.result.files),
      );
    } catch (saveErr) {
      await appendServerLog(`generate.${state.result.source}.conversation_save_failed`, {
        id: state.result.id,
        conversationId,
        error: saveErr.message,
      });
    }
  }

  return { runGenerateRequest };
}

export function formatEmbeddedAssetContext(embeddedAssets = emptyEmbeddedAssets()) {
  const items = Array.isArray(embeddedAssets.items) ? embeddedAssets.items : [];
  const rejected = Array.isArray(embeddedAssets.rejected) ? embeddedAssets.rejected : [];
  if (!items.length && !rejected.length) return "";

  const lines = [
    "## Embedded uploaded assets",
    "The following passive uploaded files will be copied into the generated app. Reference them with ./assets/uploaded/... from HTML, CSS, or JavaScript, and keep them declared in manifest.json assets[].",
  ];
  for (const item of items.slice(0, 24)) {
    lines.push(`- ./${item.path} <= ${item.name} (${item.kind}, ${item.size} bytes): ${item.use || "uploaded passive asset"}`);
  }
  if (rejected.length) {
    lines.push("Reference-only uploaded assets:");
    for (const item of rejected.slice(0, 8)) {
      lines.push(`- ${item.name}: ${item.error}`);
    }
  }
  return `\n\n${lines.join("\n")}`;
}

export function embedGeneratedAssetsInFiles(files = {}, embeddedAssets = emptyEmbeddedAssets(), fallbackManifest = {}) {
  const nextFiles = { ...(files || {}) };
  const assetFiles = embeddedAssets?.files && typeof embeddedAssets.files === "object"
    ? embeddedAssets.files
    : {};
  const entries = Object.entries(assetFiles);
  const parsedManifest = parseManifest(nextFiles["manifest.json"]);
  const fallback = fallbackManifest && typeof fallbackManifest === "object" && !Array.isArray(fallbackManifest)
    ? fallbackManifest
    : {};
  const manifest = Object.keys(parsedManifest).length || !Object.keys(fallback).length
    ? { ...parsedManifest }
    : { ...fallback };
  if (!entries.length) {
    return { files: nextFiles, manifest, paths: [], rejected: [] };
  }

  const manifestAssets = uniqueStrings(manifest.assets);
  const manifestFiles = uniqueStrings(manifest.files);
  const paths = [];
  const rejected = [];
  const declared = new Set([...manifestAssets, ...manifestFiles]);

  for (const [rawPath, content] of entries) {
    try {
      const assetPath = normalizeAssetPath(rawPath);
      if (!Object.prototype.hasOwnProperty.call(nextFiles, assetPath)) {
        nextFiles[assetPath] = content;
      }
      if (!declared.has(assetPath)) {
        manifestAssets.push(assetPath);
        manifestFiles.push(assetPath);
        declared.add(assetPath);
      }
      paths.push(assetPath);
    } catch (error) {
      rejected.push({ path: rawPath, error: error.message });
    }
  }

  manifest.assets = uniqueStrings(manifestAssets);
  manifest.files = uniqueStrings(manifestFiles);
  nextFiles["manifest.json"] = JSON.stringify(manifest, null, 2);
  return { files: nextFiles, manifest, paths: uniqueStrings(paths), rejected };
}

function emptyEmbeddedAssets() {
  return {
    files: {},
    items: [],
    manifestAssets: [],
    rejected: [],
    summary: { count: 0, totalBytes: 0 },
  };
}

function parseManifest(raw) {
  if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) return raw;
  try {
    return typeof raw === "string" && raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function uniqueStrings(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeAgentMode(value) {
  return String(value || "").trim() === "codex" ? "codex" : "vibeboard";
}

function formatAgentModeForPrompt(agentMode = "vibeboard") {
  const mode = normalizeAgentMode(agentMode);
  return `\n\n## Agent execution mode\n${mode === "codex"
    ? "Codex hardware embedded design mode. Stay strictly inside VibeBoard 480x360 hardware UI generation, local verification, and deploy-confirmation boundaries."
    : "VibeBoard self-developed Agent mode. Use the local VibeBoard generator and hardware contracts."}`;
}

export function buildGenerateAgentSettings(
  settings = {},
  env = process.env,
  positiveInt = defaultPositiveInt,
  defaults = GENERATE_RUNTIME_DEFAULTS,
) {
  return {
    ...settings,
    maxIterations: positiveInt(env.VIBEBOARD_AGENT_MAX_ITERATIONS, defaults.maxIterations),
    maxVerificationAttempts: positiveInt(
      env.VIBEBOARD_AGENT_MAX_VERIFICATION_ATTEMPTS,
      defaults.maxVerificationAttempts,
    ),
    timeoutMs: positiveInt(env.VIBEBOARD_AGENT_TIMEOUT_MS, defaults.timeoutMs),
    llmTimeoutMs: positiveInt(env.VIBEBOARD_AGENT_LLM_TIMEOUT_MS, defaults.llmTimeoutMs),
  };
}

function defaultNormalizeGenerateHistory(rawHistory) {
  return Array.isArray(rawHistory)
    ? rawHistory.filter(item => item && typeof item === "object")
    : [];
}

function defaultPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new Error(`GenerateRuntime missing dependency: ${name}`);
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== "object") {
    throw new Error(`GenerateRuntime missing dependency: ${name}`);
  }
}

function requireString(value, name) {
  if (!value || typeof value !== "string") {
    throw new Error(`GenerateRuntime missing dependency: ${name}`);
  }
}
