export const AGENT_PHASES = Object.freeze({
  INTAKE: "intake",
  SPEC: "spec",
  PLAN: "plan",
  CODE: "code",
  LOCAL_VERIFY: "local_verify",
  RENDER_VERIFY: "render_verify",
  HARDWARE_SIM: "hardware_sim",
  DEPLOY: "deploy",
  BOARD_VERIFY: "board_verify",
  LEARN: "learn",
  DONE: "done",
  FAILED: "failed",
});

export const DEFAULT_PHASE_ORDER = Object.freeze([
  AGENT_PHASES.INTAKE,
  AGENT_PHASES.SPEC,
  AGENT_PHASES.PLAN,
  AGENT_PHASES.CODE,
  AGENT_PHASES.LOCAL_VERIFY,
  AGENT_PHASES.RENDER_VERIFY,
  AGENT_PHASES.HARDWARE_SIM,
  AGENT_PHASES.DEPLOY,
  AGENT_PHASES.BOARD_VERIFY,
  AGENT_PHASES.LEARN,
  AGENT_PHASES.DONE,
]);

export function createAgentRun({ prompt = "", mode = "generate", buildId = "", hardwareMode = "auto" } = {}) {
  return {
    id: buildId || `run-${Date.now().toString(36)}`,
    prompt,
    mode,
    hardwareMode,
    phase: AGENT_PHASES.INTAKE,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    spec: null,
    plan: [],
    evidence: [],
    failures: [],
    completedAt: null,
  };
}

export function transitionRun(run, phase, patch = {}) {
  return {
    ...run,
    ...patch,
    phase,
    updatedAt: new Date().toISOString(),
    completedAt: phase === AGENT_PHASES.DONE || phase === AGENT_PHASES.FAILED
      ? new Date().toISOString()
      : run.completedAt || null,
  };
}

export function appendEvidence(run, evidence) {
  const item = {
    phase: evidence?.phase || run.phase,
    ok: Boolean(evidence?.ok),
    summary: evidence?.summary || "",
    evidence: evidence?.evidence || {},
    issues: evidence?.issues || [],
    timestamp: new Date().toISOString(),
  };
  return {
    ...run,
    evidence: [...(run.evidence || []), item],
    failures: item.ok ? run.failures || [] : [...(run.failures || []), item],
    updatedAt: new Date().toISOString(),
  };
}

export function buildInitialSpec(prompt, options = {}) {
  const text = String(prompt || "").trim();
  const lower = text.toLowerCase();
  const appType = /timer|计时|倒计时/.test(lower)
    ? "timer"
    : /weather|天气/.test(lower)
      ? "weather"
      : /voice|语音|听|记录/.test(lower)
        ? "voice"
        : /status|状态|dashboard|面板/.test(lower)
          ? "dashboard"
          : "custom";

  return {
    appType,
    prompt: text,
    screen: { width: 480, height: 360, touch: false },
    inputs: ["KEY1", "KEY2", "KEY3"],
    requiresCloud: /cloud|云|llm|obsidian|上传/.test(lower),
    hardwareApis: ["/api/status", "./hardware-result.json"],
    doneCriteria: [
      "files satisfy contracts",
      "JavaScript and Python syntax pass",
      "hardware_app.py produces hardware-result.json",
      "Playwright render has no console errors or overflow",
      options.requireBoard ? "board golden loop passes" : "board golden loop skipped unless hardware is configured",
    ],
  };
}

export function formatRunEvidence(run) {
  return (run.evidence || []).map(item => ({
    phase: item.phase,
    ok: item.ok,
    summary: item.summary,
    issueCount: item.issues?.length || 0,
    timestamp: item.timestamp,
  }));
}
