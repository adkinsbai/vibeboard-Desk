import { runBuildGraph } from "./buildGraph.mjs";
import { buildRefinedPrompt } from "./clarifyEngine.mjs";
import { normalizeProjectMemory } from "./conversationStore.mjs";
import { normalizeModelSettings } from "./modelSettings.mjs";
import { normalizeAssetPath } from "./assetContract.mjs";
import { classifyError, createStructuredError } from "./errorClassifier.mjs";
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
  repairAttempts: 2,
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
    injectAppHardwareSdkContracts = (source) => source,
    injectHardwareAppContracts,
    generatedManifest,
    buildCurrent,
    recordAgentLearning = () => {},
    filesWithHardwareResult = async files => files,
    generatedDir,
    getCurrentBuild = () => null,
    setCurrentBuild,
    projectWorkspace = null,
    formatMemoryForPrompt = formatProjectMemoryForPrompt,
    log = console,
  } = deps;

  requireObject(conversationStore, "conversationStore");
  requireObject(memoryStore, "memoryStore");
  let activeGenerate = null;

  async function runGenerateRequest(body = {}) {
    if (activeGenerate) {
      throw createStructuredError("Another generation is already running.", "generate_busy", {
        statusCode: 409,
        activeGenerate,
      });
    }
    activeGenerate = {
      id: `pending-${Date.now()}`,
      startedAt: new Date().toISOString(),
      conversationId: String(body.conversation_id || "").trim(),
      promptPreview: String(body.prompt || body.build_prompt || "").trim().slice(0, 120),
    };
    try {
      const rawPrompt = String(body.prompt || "").trim();
      if (!rawPrompt) throw createStructuredError("Prompt is required.", "empty_prompt", { statusCode: 400 });
      const rawHistory = Array.isArray(body.history) ? body.history : [];
      const normalizedHistory = normalizeGenerateHistory(rawHistory);
      const clarifyAnswers = Array.isArray(body.clarify_answers) ? body.clarify_answers : [];
      const modelSettings = body.modelSettings || {};
      const agentMode = normalizeAgentMode(body.agent_mode || body.agentMode);
      const conversationId = String(body.conversation_id || "").trim();
      const projectMemory = conversationId
        ? await conversationStore.getProjectMemory(conversationId)
        : normalizeProjectMemory();
      const assetContext = conversationId && assetLibraryStore?.promptContext
        ? assetLibraryStore.promptContext(conversationId)
        : "";
      const projectFilesContext = await formatProjectFilesContext(projectWorkspace, conversationId);
      const embeddedAssets = conversationId && assetLibraryStore?.generatedAssets
        ? assetLibraryStore.generatedAssets(conversationId)
        : emptyEmbeddedAssets();
      const conversationFiles = conversationId
        ? (await conversationStore.loadConversationFiles(conversationId)).files
        : {};

      const settings = normalizeModelSettings(modelSettings);
      if (!settings.enabled) {
        throw createStructuredError("AI provider is not configured. Configure a model before generating.", "no_api_key", {
          statusCode: 400,
          stage: "model_config",
        });
      }
      const history = await compressHistory(normalizedHistory, settings);
      const userPreferences = memoryStore.getAll();
      const prompt = buildRefinedPrompt(
        `${rawPrompt}${formatMemoryForPrompt(projectMemory)}${formatAgentModeForPrompt(agentMode)}${assetContext}${projectFilesContext}${formatEmbeddedAssetContext(embeddedAssets)}`,
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
      const agentSettings = buildGenerateAgentSettings({
        ...settings,
        max_iterations: body.max_iterations,
        maxIterations: body.maxIterations,
        max_verification_attempts: body.max_verification_attempts,
        maxVerificationAttempts: body.maxVerificationAttempts,
        repair_attempts: body.repair_attempts,
        repairAttempts: body.repairAttempts,
        timeout_ms: body.timeout_ms,
        timeoutMs: body.timeoutMs,
        llm_timeout_ms: body.llm_timeout_ms,
        llmTimeoutMs: body.llmTimeoutMs,
      }, env, positiveInt, defaults);

      return await runBuildGraph({
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
        saveSnapshot: async state => saveSnapshot({ state, conversationId, embeddedAssets, rawPrompt }),
      });
    } catch (error) {
      const classified = classifyError(error, { stage: "generate" });
      await appendServerLog("generate.request.failed", {
        error: error.message,
        ...classified,
        conversationId: activeGenerate?.conversationId || "",
        activeGenerate,
        durationMs: activeGenerate?.startedAt ? Date.now() - Date.parse(activeGenerate.startedAt) : null,
      }).catch(() => {});
      Object.assign(error, classified);
      throw error;
    } finally {
      activeGenerate = null;
    }
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
      repairAttempts: agentSettings.repairAttempts,
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
    agentFiles["app.js"] = injectAppHardwareSdkContracts(agentFiles["app.js"] || "", id);
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

    const repairReport = await buildWithAutoRepair({
      id,
      prompt,
      settings,
      agentSettings,
      agentFiles,
      manifest,
      embeddedAssets,
      agentResult,
      history,
      userPreferences,
      agentStartedAt,
    });
    agentFiles = repairReport.files || agentFiles;
    manifest = repairReport.manifest || manifest;

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
      repairSummary: repairReport.summary || "",
      repairAttempts: repairReport.attempts || 0,
      agentActions: (agentResult.actions || []).map(a => ({
        tool: a.tool,
        path: a.args?.path,
        query: a.args?.query,
        summary: a.args?.summary,
      })),
    };
  }

  async function buildWithAutoRepair({
    id,
    prompt,
    settings,
    agentSettings,
    agentFiles,
    manifest,
    embeddedAssets,
    agentResult,
    history,
    userPreferences,
    agentStartedAt,
  }) {
    let files = agentFiles;
    let currentManifest = manifest;
    let lastError = null;
    const maxAttempts = Math.max(0, Number(agentSettings.repairAttempts || 0));

    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      try {
        await buildCurrent();
        if (attempt > 0) {
          await appendServerLog("generate.agent.auto_repair.done", {
            id,
            attempts: attempt,
            durationMs: Date.now() - agentStartedAt,
          });
        }
        return {
          ok: true,
          files,
          manifest: currentManifest,
          attempts: attempt,
          summary: attempt > 0 ? `Agent 自动修复 ${attempt} 轮后通过 L0-L3 验证。` : "",
        };
      } catch (buildErr) {
        lastError = buildErr;
        log.error?.("[generate] Build error:", buildErr.message);
        await appendServerLog("generate.agent.build_failed", {
          id,
          error: buildErr.message,
          attempt,
          repairAttempts: maxAttempts,
        });
        recordAgentLearning({
          prompt,
          agentResult: {
            whatWorked: attempt > 0 ? ["Auto repair modified generated files before this validation run."] : [],
            whatFailed: [buildErr.message],
          },
          verificationResult: verificationResultFromError(buildErr, "pre_deploy_build"),
          success: false,
        });
        if (attempt >= maxAttempts || !isAutoRepairableError(buildErr)) break;
        if (!settings.enabled) break;

        const repair = await runRepairAgent({
          id,
          prompt,
          settings,
          agentSettings,
          files,
          buildErr,
          attempt: attempt + 1,
          maxAttempts,
          history,
          userPreferences,
          embeddedAssets,
          agentResult,
        });
        if (!repair.ok) {
          lastError = repair.error || buildErr;
          break;
        }
        const finalized = finalizeAgentFiles({
          id,
          prompt,
          files: repair.files,
          manifest: currentManifest,
          embeddedAssets,
          agentSummary: `${agentResult.summary || ""}\nAuto repair ${attempt + 1}: ${repair.summary || "repair applied"}`.trim(),
          provider: settings.provider,
          model: settings.model,
        });
        files = finalized.files;
        currentManifest = finalized.manifest;
        await writeGeneratedFiles(generatedDir, files);
        const currentBuild = getCurrentBuild();
        if (currentBuild) {
          currentBuild.files = files;
          currentBuild.manifest = currentManifest;
          currentBuild.built = false;
          currentBuild.buildEvidence = null;
        }
      }
    }

    const readabilityFallback = await tryReadabilityFallback({
      id,
      prompt,
      files,
      manifest: currentManifest,
      embeddedAssets,
      agentResult,
      settings,
      lastError,
      agentStartedAt,
      maxAttempts,
    });
    if (readabilityFallback.ok) return readabilityFallback;
    if (readabilityFallback.error) lastError = readabilityFallback.error;

    const classified = classifyError(lastError, { stage: "auto_repair" });
    const error = createStructuredError(
      `Automatic repair could not finish before deployment: ${lastError?.message || "local verification failed"}`,
      shouldAskUserForRepair(classified.errorType) ? classified.errorType : "auto_repair_failed",
      {
        statusCode: shouldAskUserForRepair(classified.errorType) ? classified.statusCode : 422,
        cause: lastError,
        technicalDetail: classified.technicalDetail || lastError?.message || "",
      },
    );
    await appendServerLog("generate.agent.auto_repair.failed", {
      id,
      error: error.message,
      errorType: error.errorType,
      attempts: maxAttempts,
      lastError: lastError?.message || "",
    });
    recordAgentLearning({
      prompt,
      agentResult: {
        whatWorked: [],
        whatFailed: [error.message, lastError?.message || ""].filter(Boolean),
      },
      verificationResult: verificationResultFromError(error, "auto_repair"),
      success: false,
    });
    throw error;
  }

  async function tryReadabilityFallback({
    id,
    prompt,
    files,
    manifest,
    embeddedAssets,
    agentResult,
    settings,
    lastError,
    agentStartedAt,
    maxAttempts = 0,
  }) {
    if (!isLowContrastOnlyError(lastError)) return { ok: false };
    await appendServerLog("generate.agent.readability_fallback.start", {
      id,
      error: lastError?.message || "",
    });
    const patched = finalizeAgentFiles({
      id,
      prompt,
      files: applyReadabilitySafetyNet(files),
      manifest,
      embeddedAssets,
      agentSummary: `${agentResult.summary || ""}\nSystem readability safety net: raised text contrast after auto repair.`.trim(),
      provider: settings.provider,
      model: settings.model,
    });
    files = patched.files;
    manifest = patched.manifest;
    await writeGeneratedFiles(generatedDir, files);
    const currentBuild = getCurrentBuild();
    if (currentBuild) {
      currentBuild.files = files;
      currentBuild.manifest = manifest;
      currentBuild.built = false;
      currentBuild.buildEvidence = null;
    }
    try {
      await buildCurrent();
      await appendServerLog("generate.agent.readability_fallback.done", {
        id,
        durationMs: Date.now() - agentStartedAt,
      });
      return {
        ok: true,
        files,
        manifest,
        attempts: maxAttempts,
        summary: "System readability safety net raised text contrast after model repair.",
      };
    } catch (error) {
      lastError = error;
      await appendServerLog("generate.agent.readability_fallback.failed", {
        id,
        error: error.message,
      });
      return { ok: false, error };
    }
  }

  async function runRepairAgent({
    id,
    prompt,
    settings,
    agentSettings,
    files,
    buildErr,
    attempt,
    maxAttempts,
    history,
    userPreferences,
    embeddedAssets,
    agentResult,
  }) {
    const repairPrompt = buildRepairPrompt({
      prompt,
      buildErr,
      attempt,
      maxAttempts,
      embeddedAssets,
    });
    await appendServerLog("generate.agent.auto_repair.start", {
      id,
      attempt,
      maxAttempts,
      error: buildErr.message,
      model: settings.model,
      provider: settings.provider,
    });
    try {
      const repairResult = await runAgent(
        {
          ...agentSettings,
          maxIterations: Math.max(4, Math.min(Number(agentSettings.maxIterations || 8), 8)),
          maxVerificationAttempts: 1,
        },
        repairPrompt,
        { ...files },
        [
          ...history.slice(-6),
          { role: "assistant", content: agentResult.summary || "Initial generation completed but local L0-L3 verification failed." },
          { role: "user", content: `Local verification failure: ${buildErr.message}` },
        ],
        action => {
          log.log?.(`[repair-agent] ${action.tool}: ${action.args?.path || action.args?.query || action.args?.summary || ""}`);
          appendServerLog("generate.agent.auto_repair.action", {
            attempt,
            tool: action.tool,
            path: action.args?.path || "",
            query: action.args?.query || "",
            summary: action.args?.summary || "",
          }).catch(() => {});
        },
        userPreferences,
        experienceStore,
        { ssh, scp, board: getBoard() },
      );
      if (!repairResult.success) {
        const error = new Error(repairResult.summary || "Auto repair agent failed");
        if (repairResult.error && typeof repairResult.error === "object") Object.assign(error, repairResult.error);
        return { ok: false, error };
      }
      await appendServerLog("generate.agent.auto_repair.applied", {
        id,
        attempt,
        actionCount: repairResult.actions?.length || 0,
        summary: repairResult.summary || "",
      });
      return {
        ok: true,
        files: repairResult.files,
        summary: repairResult.summary || "",
        actions: repairResult.actions || [],
      };
    } catch (error) {
      await appendServerLog("generate.agent.auto_repair.failed", {
        id,
        attempt,
        error: error.message,
        ...structuredErrorFieldsForLog(error),
      });
      return { ok: false, error };
    }
  }

  function finalizeAgentFiles({
    id,
    prompt,
    files,
    manifest,
    embeddedAssets,
    agentSummary,
    provider,
    model,
  }) {
    let nextFiles = { ...(files || {}) };
    if (!nextFiles["hardware_app.py"]) {
      const spec = createAppSpec(prompt, id);
      nextFiles["hardware_app.py"] = generatedHardwareApp(prompt, id, spec);
    }
    nextFiles["app.js"] = injectAppHardwareSdkContracts(nextFiles["app.js"] || "", id);
    nextFiles["hardware_app.py"] = injectHardwareAppContracts(nextFiles["hardware_app.py"], id);
    const spec = createAppSpec(prompt, id);
    let nextManifest = generatedManifest(prompt, id, spec, {
      ...(manifest && typeof manifest === "object" ? manifest : {}),
      generator: "vibeboard-agent-v1",
      title: prompt.slice(0, 40),
      source: "agent",
      model,
      provider,
      notes: agentSummary,
      target: getBoard().targetStatic,
    });
    nextFiles["manifest.json"] = JSON.stringify(nextManifest, null, 2);
    const embedded = embedGeneratedAssetsInFiles(nextFiles, embeddedAssets, nextManifest);
    nextFiles = embedded.files;
    nextManifest = embedded.manifest || nextManifest;
    return { files: nextFiles, manifest: nextManifest };
  }

  async function saveSnapshot({ state, conversationId, embeddedAssets, rawPrompt }) {
    if (!conversationId) return;
    try {
      const files = await filesWithHardwareResult(state.result.files);
      await conversationStore.saveConversationFiles(
        conversationId,
        state.result.id,
        files,
      );
      assetLibraryStore?.recordBuildSnapshot?.(conversationId, state.result.id, embeddedAssets);
      await projectWorkspace?.writeBuildSnapshot?.(
        conversationId,
        state.result.id,
        files,
        Array.isArray(embeddedAssets?.items) ? embeddedAssets.items : [],
      );
      await projectWorkspace?.writeMemory?.(conversationId, {
        trigger: "generate-snapshot",
        buildId: state.result.id,
        prompt: rawPrompt || state.result.prompt || "",
      });
    } catch (saveErr) {
      await appendServerLog(`generate.${state.result.source}.conversation_save_failed`, {
        id: state.result.id,
        conversationId,
        error: saveErr.message,
      });
      const error = createStructuredError(
        "Generated files were created, but project data could not be saved. Please retry.",
        "storage_failed",
        {
          statusCode: saveErr.statusCode || 503,
          cause: saveErr,
          technicalDetail: saveErr.message || "conversation snapshot save failed",
        },
      );
      throw error;
    }
  }

  return { runGenerateRequest };
}

export function isLowContrastOnlyError(error = {}) {
  const issues = Array.isArray(error?.verification?.issues)
    ? error.verification.issues
    : Array.isArray(error?.buildEvidence?.issues)
      ? error.buildEvidence.issues
      : Array.isArray(error?.verificationResult?.issues)
        ? error.verificationResult.issues
        : [];
  const blocking = issues.filter(issue => String(issue.severity || "blocking") !== "warning" && String(issue.severity || "blocking") !== "info");
  if (issues.length) return blocking.length > 0 && blocking.every(issue => issue.code === "TEXT_CONTRAST_LOW");
  const text = [error?.message, error?.technicalDetail].filter(Boolean).join("\n");
  return /TEXT_CONTRAST_LOW/i.test(text)
    && !/LAYOUT_OVERFLOW|TEXT_TOO_SMALL|NETWORK_ERRORS|CONSOLE_ERRORS|PAGE_ERRORS|RENDER_VERIFIER_ERROR/i.test(text);
}

export function applyReadabilitySafetyNet(files = {}) {
  const nextFiles = { ...(files || {}) };
  const css = String(nextFiles["style.css"] || "");
  if (css.includes("VibeBoard readability safety net")) return nextFiles;
  const patch = `

/* VibeBoard readability safety net: keep generated text legible on 480x360 LCD. */
:where(body, main, section, article, div, p, span, label, button, input, output, time, strong, small, h1, h2, h3) {
  color: #f8fbff;
}
:where(.muted, .subtle, .hint, .caption, small, label) {
  color: #dbeafe;
}
:where(button, .button, [role="button"]) {
  color: #f8fbff;
  background-color: #14532d;
  border-color: #bbf7d0;
}
`;
  nextFiles["style.css"] = `${css.trimEnd()}${patch}`;
  return nextFiles;
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

async function formatProjectFilesContext(projectWorkspace, conversationId = "") {
  if (!conversationId || !projectWorkspace?.listProjectFiles) return "";
  try {
    const files = await projectWorkspace.listProjectFiles(conversationId);
    if (!files.length) return "";
    const lines = [
      "## Project folder files",
      "This project has a persistent local folder. You may use MEMORY.md, assets, and build snapshots as project context. For binary files, rely on the asset library summary unless the user explicitly asks to inspect the file.",
    ];
    for (const file of files.slice(0, 80)) {
      lines.push(`- ${file.path} (${file.size || 0} bytes)`);
    }
    return `\n\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

function buildRepairPrompt({
  prompt = "",
  buildErr = null,
  attempt = 1,
  maxAttempts = 2,
  embeddedAssets = emptyEmbeddedAssets(),
} = {}) {
  const assetContext = formatEmbeddedAssetContext(embeddedAssets);
  const hardwareFixHints = formatHardwareRepairHints(buildErr);
  return [
    "部署前 L0-L3 本地验证失败，请自动修复当前 VibeBoard 生成文件。",
    "",
    `原始需求：${String(prompt || "").slice(0, 4000)}`,
    `修复轮次：${attempt}/${maxAttempts}`,
    "",
    "失败证据：",
    String(buildErr?.message || buildErr || "local verification failed").slice(0, 4000),
    hardwareFixHints,
    "",
    "修复规则：",
    "- 只修改 index.html、style.css、app.js、hardware_app.py、manifest.json。",
    "- 优先做最小修复，不要重写无关功能和视觉方向。",
    "- 必须保持 480x360 无滚动小屏合同。",
    "- 必须保持 window.VibeBoardHardware.getStatus/getProgramResult/getSnapshot。",
    "- 必须保持 hardware_app.py 输出包含 build_id、runtime、available_apis 的 JSON。",
    "- 修复后调用 done；不要请求部署硬件。",
    assetContext,
  ].filter(Boolean).join("\n");
}

function formatHardwareRepairHints(error) {
  const verification = error?.verification || error?.buildEvidence || error?.verificationResult || null;
  const issues = Array.isArray(verification?.issues) ? verification.issues : [];
  if (!issues.length) return "";
  const lines = ["", "Hardware verification repair hints:"];
  for (const issue of issues.slice(0, 6)) {
    const code = String(issue.code || "UNKNOWN");
    lines.push(`- ${code}: ${issue.message || "verification issue"}`);
    for (const fix of (issue.suggestedFixes || []).slice(0, 3)) {
      lines.push(`  fix: ${fix}`);
    }
    for (const sample of sampleIssueEvidence(issue).slice(0, 3)) {
      lines.push(`  sample: ${sample}`);
    }
  }
  return lines.join("\n");
}

function sampleIssueEvidence(issue = {}) {
  const samples = Array.isArray(issue.evidence?.samples)
    ? issue.evidence.samples
    : Array.isArray(issue.evidence?.readabilityState?.lowContrastSamples)
      ? issue.evidence.readabilityState.lowContrastSamples
      : Array.isArray(issue.evidence?.readabilityState?.tinyTextSamples)
        ? issue.evidence.readabilityState.tinyTextSamples
        : [];
  return samples.map(sample => {
    const parts = [
      sample.tag || "",
      sample.id ? `#${sample.id}` : "",
      sample.className ? `.${String(sample.className).split(/\s+/).filter(Boolean).join(".")}` : "",
      sample.text ? `"${String(sample.text).slice(0, 50)}"` : "",
      sample.fontSize ? `${sample.fontSize}px` : "",
      sample.contrastRatio ? `contrast ${sample.contrastRatio}:1` : "",
    ];
    return parts.filter(Boolean).join(" ");
  }).filter(Boolean);
}

function isAutoRepairableError(error) {
  const classified = classifyError(error, { stage: "auto_repair" });
  if (shouldAskUserForRepair(classified.errorType)) return false;
  return new Set([
    "syntax_error",
    "python_syntax",
    "hardware_contract",
    "render_failed",
    "model_output_invalid",
    "no_code",
    "auto_repair_failed",
    "unknown",
  ]).has(classified.errorType);
}

function shouldAskUserForRepair(errorType = "") {
  return new Set([
    "no_api_key",
    "llm_auth",
    "llm_quota",
    "llm_rate_limited",
    "llm_network",
    "request_too_large",
    "asset_rejected",
    "storage_failed",
    "storage_corrupt",
    "generate_busy",
    "empty_prompt",
  ]).has(String(errorType || ""));
}

function verificationResultFromError(error, phase = "generate") {
  const verification = error?.verification || error?.buildEvidence || error?.verificationResult || null;
  if (verification && typeof verification === "object") {
    return {
      ...verification,
      ok: false,
      phase: verification.phase || phase,
      summary: verification.summary || error?.message || "Generation verification failed",
    };
  }
  const classified = classifyError(error, { stage: phase });
  return {
    ok: false,
    phase,
    summary: error?.message || "Generation verification failed",
    issues: [{
      code: classified.errorType || error?.code || "UNKNOWN",
      message: error?.message || String(error || "Generation verification failed"),
      phase,
      suggestedFixes: [classified.suggestion].filter(Boolean),
    }],
  };
}

export function buildGenerateAgentSettings(
  settings = {},
  env = process.env,
  positiveInt = defaultPositiveInt,
  defaults = GENERATE_RUNTIME_DEFAULTS,
) {
  return {
    ...settings,
    maxIterations: positiveInt(
      settings.max_iterations ?? settings.maxIterations ?? env.VIBEBOARD_AGENT_MAX_ITERATIONS,
      defaults.maxIterations,
    ),
    maxVerificationAttempts: nonNegativeInt(
      settings.max_verification_attempts ?? settings.maxVerificationAttempts ?? env.VIBEBOARD_AGENT_MAX_VERIFICATION_ATTEMPTS,
      defaults.maxVerificationAttempts,
    ),
    repairAttempts: nonNegativeInt(
      settings.repair_attempts ?? settings.repairAttempts ?? env.VIBEBOARD_AGENT_REPAIR_ATTEMPTS,
      defaults.repairAttempts,
    ),
    timeoutMs: positiveInt(
      settings.timeout_ms ?? settings.timeoutMs ?? env.VIBEBOARD_AGENT_TIMEOUT_MS,
      defaults.timeoutMs,
    ),
    llmTimeoutMs: positiveInt(
      settings.llm_timeout_ms ?? settings.llmTimeoutMs ?? env.VIBEBOARD_AGENT_LLM_TIMEOUT_MS,
      defaults.llmTimeoutMs,
    ),
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

function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
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
