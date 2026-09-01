import { signatureFromIssues } from "./playbookStore.mjs";

const USER_ACTION_ERROR_TYPES = new Set([
  "asset_rejected",
  "board_unreachable",
  "build_not_found",
  "database_quota",
  "database_unavailable",
  "deploy_contract_guard",
  "empty_prompt",
  "idempotency_conflict",
  "llm_auth",
  "llm_quota",
  "no_api_key",
  "no_code",
  "request_too_large",
  "storage_corrupt",
]);

const RECOVERABLE_ERROR_TYPES = new Set([
  "agent_timeout",
  "auto_repair_failed",
  "connection_dropped",
  "deploy_copy",
  "deploy_failed",
  "deploy_http",
  "deploy_mkdir",
  "deploy_service",
  "hardware_contract",
  "llm_failed",
  "llm_network",
  "llm_rate_limited",
  "llm_timeout",
  "model_output_invalid",
  "python_runtime_unavailable",
  "python_syntax",
  "render_failed",
  "storage_failed",
  "syntax_error",
  "timeout",
  "unknown",
]);

function normalizePositiveInt(value, fallback, min = 0, max = 10) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

function compactFailure({ error, classified, signature, attempt }) {
  return {
    attempt,
    signature,
    errorType: classified.errorType,
    errorStage: classified.errorStage,
    errorLabel: classified.errorLabel,
    message: error?.message || classified.userMessage || "debuggable failure",
    technicalDetail: classified.technicalDetail || "",
  };
}

function issueFromFailure(failure) {
  return {
    phase: failure.errorStage,
    type: failure.errorType,
    message: failure.message,
    detail: failure.technicalDetail,
  };
}

function playbookBrief(playbook) {
  return {
    signature: playbook.signature,
    title: playbook.title,
    root_cause: playbook.root_cause,
    diagnosis_steps: playbook.diagnosis_steps || [],
    fix: playbook.fix,
    score: Number(playbook.score || 0),
  };
}

function promptSummary(input = {}, job = {}) {
  return String(input.prompt || input.message || input.build_prompt || job.title || job.type || "job").slice(0, 220);
}

function shouldAutoDebug(classified = {}) {
  const type = String(classified.errorType || "");
  if (USER_ACTION_ERROR_TYPES.has(type)) return false;
  if (RECOVERABLE_ERROR_TYPES.has(type)) return true;
  return Boolean(classified.retryable);
}

function withDebugOutput(output, recovery) {
  if (!recovery?.recovered || !output || typeof output !== "object" || Array.isArray(output)) return output;
  return {
    ...output,
    debug_recovery: recovery,
  };
}

function attachDebugRecovery(error, recovery) {
  error.debugRecovery = recovery;
  error.debug_recovery = recovery;
  return error;
}

async function safeCall(fn) {
  try {
    return typeof fn === "function" ? await fn() : null;
  } catch {
    return null;
  }
}

export function createDebugRecovery({
  classifyError,
  playbookStore = null,
  experienceStore = null,
  maxAttempts = 2,
  sameSignatureLimit = 2,
  retryDelayMs = 250,
  enabled = true,
} = {}) {
  const retries = normalizePositiveInt(maxAttempts, 2, 0, 5);
  const signatureLimit = normalizePositiveInt(sameSignatureLimit, 2, 1, 5);
  const delayMs = normalizePositiveInt(retryDelayMs, 250, 0, 30000);

  async function run({ job, input, ctx, runAttempt }) {
    if (!enabled || retries <= 0) return await runAttempt(input);

    const failures = [];
    let matchedPlaybooks = [];
    let debugAttempts = 0;

    while (true) {
      try {
        const attemptInput = debugAttempts === 0
          ? input
          : {
              ...input,
              debug_context: {
                attempt: debugAttempts,
                previousFailures: failures,
                playbooks: matchedPlaybooks.map(playbookBrief),
              },
            };
        const output = await runAttempt(attemptInput);
        const recovery = {
          recovered: debugAttempts > 0,
          attempts: debugAttempts,
          failures,
          playbooks: matchedPlaybooks.map(playbookBrief),
        };
        if (recovery.recovered) {
          await recordRecoveryUse({ job, input, failures, matchedPlaybooks, success: true });
        }
        return withDebugOutput(output, recovery);
      } catch (error) {
        const classified = classifyError
          ? classifyError(error, { stage: job?.type || "job" })
          : { errorType: error?.errorType || "unknown", retryable: true, technicalDetail: error?.message || "" };
        const issue = {
          phase: classified.errorStage,
          type: classified.errorType,
          message: error?.message || classified.userMessage || "debuggable failure",
          detail: classified.technicalDetail || "",
        };
        const signature = signatureFromIssues([issue]);
        const failure = compactFailure({
          error,
          classified,
          signature,
          attempt: debugAttempts + 1,
        });
        failures.push(failure);

        matchedPlaybooks = await safeCall(() => playbookStore?.findPlaybooks?.({
          taskType: job?.type || "general",
          issues: failures.map(issueFromFailure),
          limit: 3,
          minScore: 0,
        })) || [];

        const sameSignatureCount = failures.filter(item => item.signature === signature).length;
        const canAutoDebug = shouldAutoDebug(classified);
        const stoppedReason = !canAutoDebug
          ? "requires_user_action"
          : sameSignatureCount >= signatureLimit
            ? "repeated_signature"
            : debugAttempts >= retries
              ? "max_attempts"
              : "";

        if (stoppedReason) {
          await recordRecoveryUse({ job, input, failures, matchedPlaybooks, success: false });
          throw attachDebugRecovery(error, {
            recovered: false,
            attempts: debugAttempts,
            failures,
            playbooks: matchedPlaybooks.map(playbookBrief),
            stoppedReason,
          });
        }

        debugAttempts += 1;
        await ctx?.phase?.("debugging", `Auto debug attempt ${debugAttempts}/${retries}: ${classified.errorLabel || classified.errorType}`);
        await ctx?.log?.(`Auto debug attempt ${debugAttempts}: ${classified.errorLabel || classified.errorType}`, {
          errorType: classified.errorType,
          signature,
          playbooks: matchedPlaybooks.map(playbookBrief),
        });
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  async function recordRecoveryUse({ job, input, failures, matchedPlaybooks, success }) {
    const evidence = failures.map(item => `${item.errorType}: ${item.message}`).slice(-5);
    for (const playbook of matchedPlaybooks || []) {
      await safeCall(() => playbookStore?.recordUse?.(playbook.signature, {
        success,
        verificationEvidence: evidence,
      }));
    }
    await safeCall(() => experienceStore?.recordExperience?.({
      taskType: job?.type || "general",
      promptSummary: promptSummary(input, job),
      whatWorked: success ? ["automatic debug recovery succeeded"] : [],
      whatFailed: evidence,
      fixesApplied: (matchedPlaybooks || []).map(playbook => playbook.fix).filter(Boolean),
      verificationResult: {
        phase: success ? "debug_recovered" : "debug_stopped",
        issues: failures.map(issueFromFailure),
      },
      success,
    }));
  }

  return {
    run,
    shouldAutoDebug,
  };
}
