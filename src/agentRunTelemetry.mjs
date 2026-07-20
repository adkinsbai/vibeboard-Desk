export function createAgentRunTelemetry({ startedAt = Date.now() } = {}) {
  const state = {
    startedAt: finiteTime(startedAt, Date.now()),
    completedAt: null,
    modelTurns: 0,
    toolActions: 0,
    toolFailures: 0,
    repeatedActionBlocks: 0,
    verificationAttempts: 0,
    completionReason: "",
    modelDurationMs: 0,
    toolDurationMs: 0,
  };

  return {
    modelTurn({ durationMs = 0 } = {}) {
      state.modelTurns += 1;
      state.modelDurationMs += nonNegative(durationMs);
    },
    tool({ durationMs = 0, ok = true } = {}) {
      state.toolActions += 1;
      state.toolDurationMs += nonNegative(durationMs);
      if (!ok) state.toolFailures += 1;
    },
    verification() {
      state.verificationAttempts += 1;
    },
    recovery({ code = "" } = {}) {
      if (["duplicate_action", "duplicate_action_without_progress"].includes(code)) {
        state.repeatedActionBlocks += 1;
      }
    },
    finish({ reason = "", at = Date.now() } = {}) {
      state.completedAt = finiteTime(at, Date.now());
      state.completionReason = allowReason(reason);
    },
    snapshot() {
      return { ...state };
    },
  };
}

export function publicAgentRunTelemetry(snapshot = {}) {
  const startedAt = finiteTime(snapshot.startedAt, 0);
  const completedAt = finiteTime(snapshot.completedAt, startedAt);
  return {
    model_turns: nonNegativeInt(snapshot.modelTurns),
    tool_actions: nonNegativeInt(snapshot.toolActions),
    tool_failures: nonNegativeInt(snapshot.toolFailures),
    repeated_action_blocks: nonNegativeInt(snapshot.repeatedActionBlocks),
    verification_attempts: nonNegativeInt(snapshot.verificationAttempts),
    duration_ms: Math.max(0, Math.round(completedAt - startedAt)),
    completion_reason: allowReason(snapshot.completionReason),
  };
}

function allowReason(value) {
  const reason = String(value || "").trim().toLowerCase();
  return ["verified", "failed", "timeout", "iteration_limit", "provider_error"].includes(reason)
    ? reason
    : "";
}

function finiteTime(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function nonNegativeInt(value) {
  return Math.round(nonNegative(value));
}
