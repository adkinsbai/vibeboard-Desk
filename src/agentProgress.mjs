export const AGENT_PROGRESS_TYPES = Object.freeze({
  RUN_STARTED: "agent.run.started",
  MODEL_STARTED: "agent.model.started",
  MODEL_COMPLETED: "agent.model.completed",
  TOOL_STARTED: "agent.tool.started",
  TOOL_COMPLETED: "agent.tool.completed",
  VERIFICATION_STARTED: "agent.verification.started",
  VERIFICATION_COMPLETED: "agent.verification.completed",
  RECOVERY: "agent.recovery",
  RUN_COMPLETED: "agent.run.completed",
  RUN_FAILED: "agent.run.failed",
});

const ALLOWED = new Set(Object.values(AGENT_PROGRESS_TYPES));

export function createAgentProgressEvent(type, detail = {}) {
  if (!ALLOWED.has(type)) throw new Error(`unknown agent progress type: ${type}`);
  return {
    schema_version: "agent-progress.v1",
    type,
    phase: bounded(detail.phase, 40),
    tool: bounded(detail.tool, 60),
    path: bounded(detail.path, 120),
    ok: detail.ok == null ? null : Boolean(detail.ok),
    elapsed_ms: Math.max(0, Math.round(Number(detail.elapsedMs || 0))),
    message: bounded(detail.message, 160),
  };
}

function bounded(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}
