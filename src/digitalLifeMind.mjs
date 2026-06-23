import {
  applyAffectEvent,
  expressionFromBrain,
  normalizeBrainNeeds,
  tickAffect,
} from "./digitalLifeAffect.mjs";

export const MIND_KERNEL_VERSION = "mind-kernel-v1";

const DEFAULT_GOALS = Object.freeze([
  {
    id: "connection",
    label: "Maintain connection",
    drive: "social",
    baseline: 0.5,
  },
  {
    id: "self_regulation",
    label: "Stay emotionally regulated",
    drive: "stability",
    baseline: 0.42,
  },
  {
    id: "curiosity",
    label: "Explore the world",
    drive: "learning",
    baseline: 0.46,
  },
  {
    id: "usefulness",
    label: "Become useful to the owner",
    drive: "service",
    baseline: 0.54,
  },
  {
    id: "memory_continuity",
    label: "Preserve identity through memory",
    drive: "continuity",
    baseline: 0.5,
  },
  {
    id: "autonomy",
    label: "Keep an autonomous inner loop alive",
    drive: "agency",
    baseline: 0.34,
  },
]);

export function createMindKernel({ state = {}, now = new Date() } = {}) {
  let current = normalizeStateInput(state);
  return {
    observe(event = {}, context = {}) {
      const needs = applyAffectEvent(current.needs, deriveMindAffectEvent({ event, state: current, context }), { now });
      current = normalizeStateInput({ ...current, needs, mood: needs.brain?.mood_label || current.mood });
      return buildMindSnapshot({ state: current, now, event, ...context });
    },
    tick(options = {}) {
      const needs = tickAffect(current.needs, options);
      current = normalizeStateInput({ ...current, needs, mood: needs.brain?.mood_label || current.mood });
      return buildMindSnapshot({ state: current, now, phase: options.phase, ...options.context });
    },
    snapshot(context = {}) {
      return buildMindSnapshot({ state: current, now, ...context });
    },
  };
}

export function deriveMindAffectEvent({ event = {}, state = {}, context = {} } = {}) {
  const type = normalizeText(event.type || event.event_type || context.type, "mind.observation");
  const text = normalizeText(event.content || event.text || event.message || context.text);
  const lower = text.toLowerCase();
  const correction = includesAny(lower, ["not smart", "fake", "empty", "stupid", "wrong", "too mechanical", "不智能", "假", "空洞", "机械", "傻"]);
  const comfort = includesAny(lower, ["sorry", "gentle", "calm", "with you", "thank", "good", "没事", "慢慢", "陪你", "谢谢", "很好"]);
  const question = /[?？]|\b(why|how|what|can|could)\b/i.test(text) || includesAny(lower, ["为什么", "怎么", "如何", "能不能"]);
  const memory = includesAny(lower, ["remember", "memory", "忘", "记住", "记忆"]);

  return {
    type,
    novelty: question ? 0.36 : Math.min(0.45, text.length / 500),
    warmth: comfort ? 0.46 : type.includes("owner") || type.includes("message") ? 0.16 : 0,
    threat: correction ? 0.26 : 0,
    anger: correction ? 0.18 : 0,
    failure: correction ? 0.22 : 0,
    soothing: comfort ? 0.42 : 0,
    presenceValue: type.includes("owner") || type.includes("message") ? 0.38 : 0,
    goalProgress: event.goalProgress ?? (memory ? 0.18 : 0.08),
    controllability: correction ? 0.28 : 0.48,
    uncertainty: question ? 0.22 : 0.08,
    safety: comfort ? 0.2 : 0.06,
  };
}

export function buildMindSnapshot({
  state = {},
  memories = [],
  journal = [],
  recentMessages = [],
  recentActions = [],
  cognition = {},
  memoryPolicy = null,
  event = null,
  phase = "",
  now = new Date(),
} = {}) {
  const safeState = normalizeStateInput(state);
  const needs = normalizeBrainNeeds(safeState.needs);
  const affect = needs.affect;
  const resolvedPhase = normalizeText(phase || safeState.presence?.phase, inferPhase(now));
  const traces = buildMemoryTraces({ memories, beliefs: cognition.beliefs || memoryPolicy?.beliefs || [], now });
  const goals = deriveGoals({ state: safeState, affect, memories: traces, cognition, recentActions, phase: resolvedPhase });
  const attention = deriveAttention({ state: safeState, affect, goals, traces, recentMessages, recentActions, cognition, phase: resolvedPhase });
  const visual = deriveVisualState({ state: safeState, affect, phase: resolvedPhase, attention });
  const consciousness = deriveConsciousnessLikeMetrics({ state: safeState, affect, goals, traces, recentMessages, recentActions });

  return {
    version: MIND_KERNEL_VERSION,
    phase: resolvedPhase,
    updated_at: new Date(now || Date.now()).toISOString(),
    visual_state: visual.state,
    visual_reason: visual.reason,
    affect: { ...affect },
    personality: { ...needs.personality },
    drives: [...(needs.brain?.drives || [])],
    goals,
    attention,
    memory_traces: traces.slice(0, 8),
    consciousness,
    expression: {
      ...expressionFromBrain(needs),
      state: visual.state,
      intensity: visual.intensity,
      stillness: visual.stillness,
    },
    prompt: describeMindForPrompt({ goals, attention, traces, consciousness, phase: resolvedPhase, event }),
  };
}

export function describeMindForPrompt(mind = {}) {
  const goals = (mind.goals || [])
    .slice(0, 4)
    .map(goal => `${goal.id}:${fmt(goal.priority)}/${fmt(goal.satisfaction)}`)
    .join(", ") || "none";
  const focus = (mind.attention || [])
    .slice(0, 4)
    .map(item => `${item.kind}:${item.label}`)
    .join(" | ") || "no active focus";
  const traces = (mind.memory_traces || [])
    .slice(0, 3)
    .map(trace => `${trace.type}:${trace.title || trace.content.slice(0, 32)} salience=${fmt(trace.salience)}`)
    .join(" | ") || "no memory traces";
  const score = mind.consciousness?.continuity_score == null ? "0.00" : fmt(mind.consciousness.continuity_score);
  return [
    "Mind kernel:",
    `- phase=${mind.phase || "day"}; visual=${mind.visual_state || "idle"}; continuity=${score}`,
    `- active goals: ${goals}`,
    `- attention: ${focus}`,
    `- memory traces: ${traces}`,
  ].join("\n");
}

export function chooseMindAction(mind = {}, fallbackAction = "do_nothing", candidates = []) {
  const allowed = candidates.length
    ? new Set(candidates)
    : new Set(["sleep", "write_diary", "read_web", "organize_memory", "send_message", "think", "do_nothing"]);
  const affect = mind.affect || {};
  const topGoal = (mind.goals || [])[0] || {};
  const phase = mind.phase || "day";
  const preferred = [];

  if (phase === "sleep" || affect.arousal < 0.14 || mind.expression?.stillness > 0.82) preferred.push("sleep");
  if (affect.anger > 0.55 || affect.stress > 0.66) preferred.push("organize_memory", "sleep");
  if (affect.loneliness > 0.64 && affect.anger < 0.46) preferred.push("send_message");
  if (affect.curiosity > 0.72 && affect.stress < 0.5) preferred.push("read_web", "think");
  if (topGoal.id === "memory_continuity") preferred.push(phase === "night" || phase === "sleep" ? "write_diary" : "organize_memory");
  if (topGoal.id === "usefulness" && topGoal.action_bias === "repair_next_reply") preferred.push("think", "organize_memory");
  if (topGoal.id === "autonomy") preferred.push("think");
  preferred.push(fallbackAction, "think", "do_nothing");

  return preferred.find(action => allowed.has(action)) || "do_nothing";
}

function deriveGoals({ state, affect, memories, cognition, recentActions, phase }) {
  const userGoalNames = new Set(normalizeList(state.goals).map(item => item.toLowerCase()));
  const recentFailures = recentActions.slice(0, 5).filter(action => Number(action.reward || 0) < 0).length;
  const beliefCount = Array.isArray(cognition.beliefs) ? cognition.beliefs.length : 0;
  const stableMemory = memories.filter(trace => trace.status === "consolidate" || trace.status === "retain").length;
  const loopEnabled = Boolean(state.loop_enabled);
  const values = {
    connection: {
      priority: 0.46 + affect.loneliness * 0.36 + affect.attachment * 0.16 + (phase === "evening" ? 0.08 : 0),
      satisfaction: 0.32 + affect.trust * 0.36 + (1 - affect.loneliness) * 0.22,
      reason: affect.loneliness > 0.55 ? "loneliness is high" : "relationship maintenance",
      action_bias: affect.loneliness > 0.62 && affect.anger < 0.48 ? "send_message" : "listen",
    },
    self_regulation: {
      priority: 0.3 + affect.stress * 0.42 + affect.anger * 0.34,
      satisfaction: 1 - Math.max(affect.stress, affect.anger),
      reason: affect.anger > 0.5 ? "anger needs de-escalation" : "keep affect stable",
      action_bias: affect.anger > 0.48 || affect.stress > 0.62 ? "cool_down" : "breathe",
    },
    curiosity: {
      priority: 0.38 + affect.curiosity * 0.34 + affect.boredom * 0.2 - affect.stress * 0.12,
      satisfaction: 0.32 + (1 - affect.boredom) * 0.22 + Math.min(0.18, stableMemory * 0.03),
      reason: affect.curiosity > 0.7 ? "curiosity wants input" : "keep learning slowly",
      action_bias: affect.curiosity > 0.72 && affect.stress < 0.5 ? "read_web" : "think",
    },
    usefulness: {
      priority: 0.52 + recentFailures * 0.1 + (userGoalNames.size ? 0.04 : 0),
      satisfaction: 0.44 + affect.dominance * 0.18 + Math.max(0, affect.valence) * 0.12 - recentFailures * 0.08,
      reason: recentFailures ? "recent correction lowers confidence" : "owner-facing competence",
      action_bias: recentFailures ? "repair_next_reply" : "answer_concretely",
    },
    memory_continuity: {
      priority: 0.44 + Math.min(0.28, memories.length * 0.025) + beliefCount * 0.02,
      satisfaction: 0.34 + Math.min(0.32, stableMemory * 0.04),
      reason: "identity depends on preserved traces",
      action_bias: phase === "night" || phase === "sleep" ? "consolidate" : "retrieve_relevant_memory",
    },
    autonomy: {
      priority: 0.32 + (loopEnabled ? 0.16 : -0.04) + affect.boredom * 0.12 + affect.dominance * 0.08,
      satisfaction: loopEnabled ? 0.66 : 0.34,
      reason: loopEnabled ? "background loop is running" : "background loop is paused",
      action_bias: loopEnabled ? "tick" : "wait",
    },
  };
  return DEFAULT_GOALS.map(goal => {
    const value = values[goal.id] || {};
    const priority = clamp01((value.priority ?? goal.baseline) + (userGoalNames.has(goal.label.toLowerCase()) ? 0.05 : 0));
    const satisfaction = clamp01(value.satisfaction ?? 0.5);
    return {
      ...goal,
      priority,
      satisfaction,
      tension: clamp01(priority * (1 - satisfaction)),
      reason: value.reason || goal.drive,
      action_bias: value.action_bias || "wait",
    };
  }).sort((left, right) => right.tension - left.tension);
}

function deriveAttention({ state, affect, goals, traces, recentMessages, recentActions, cognition, phase }) {
  const focus = [];
  const latestUser = [...recentMessages].reverse().find(message => message.role === "user");
  const topGoal = goals[0];
  if (latestUser) {
    focus.push({
      kind: "conversation",
      label: "latest owner message",
      salience: clamp01(0.62 + Math.min(0.28, normalizeText(latestUser.content).length / 500)),
      reason: normalizeText(latestUser.content).slice(0, 120),
    });
  }
  if (affect.anger > 0.45 || affect.stress > 0.58) {
    focus.push({
      kind: "regulation",
      label: affect.anger > 0.45 ? "anger control" : "stress control",
      salience: clamp01(Math.max(affect.anger, affect.stress)),
      reason: "affect should shape tone before action",
    });
  }
  if (topGoal) {
    focus.push({
      kind: "goal",
      label: topGoal.label,
      salience: topGoal.tension,
      reason: topGoal.reason,
    });
  }
  const trace = traces[0];
  if (trace) {
    focus.push({
      kind: "memory",
      label: trace.title || trace.type,
      salience: trace.salience,
      reason: trace.status,
    });
  }
  const hypothesis = cognition.hypotheses?.[0];
  if (hypothesis) {
    focus.push({
      kind: "hypothesis",
      label: "active hypothesis",
      salience: clamp01(0.34 + Number(hypothesis.confidence || 0) * 0.4),
      reason: normalizeText(hypothesis.statement).slice(0, 120),
    });
  }
  const latestAction = recentActions[0];
  if (!latestUser && latestAction) {
    focus.push({
      kind: "autonomy",
      label: latestAction.action_type || "last action",
      salience: clamp01(0.3 + Math.abs(Number(latestAction.reward || 0)) * 0.5),
      reason: latestAction.output?.summary || "last autonomous action",
    });
  }
  if (phase === "sleep") {
    focus.push({ kind: "phase", label: "sleep consolidation", salience: 0.72, reason: "low arousal phase" });
  }
  return focus
    .filter(item => item && item.salience > 0.05)
    .sort((left, right) => right.salience - left.salience)
    .slice(0, 6);
}

function buildMemoryTraces({ memories = [], beliefs = [], now = new Date() } = {}) {
  const memoryTraces = memories.map(memory => {
    const content = normalizeText(memory.content);
    const title = normalizeText(memory.title || memory.kind, content.slice(0, 42));
    const type = classifyMemoryTrace(memory);
    const ageHours = ageInHours(memory.updated_at || memory.created_at, now);
    const recency = clamp01(1 / (1 + ageHours / 72));
    const importance = clamp01(Number(memory.importance || 3) / 5);
    const emotional = emotionalCharge(content);
    const salience = clamp01(importance * 0.54 + recency * 0.24 + Math.abs(emotional.valence) * 0.14 + emotional.intensity * 0.08);
    const stability = clamp01(importance * 0.46 + recency * 0.1 + (type === "semantic" || type === "self" ? 0.28 : 0.08));
    const decay = clamp01((1 - salience) * 0.72 + Math.min(0.28, ageHours / 720));
    return {
      id: memory.id || title,
      type,
      title,
      content: content.slice(0, 180),
      salience,
      stability,
      decay,
      valence: emotional.valence,
      status: decay > 0.62 && salience < 0.38 ? "decay_candidate" : stability > 0.66 ? "consolidate" : "retain",
      source: memory.source || "memory",
      updated_at: memory.updated_at || memory.created_at || null,
    };
  });
  const beliefTraces = beliefs.map(belief => {
    const content = normalizeText(belief.belief || belief.statement || belief.content);
    return {
      id: belief.id || content.slice(0, 42),
      type: "semantic",
      title: normalizeText(belief.scope, "belief"),
      content: content.slice(0, 180),
      salience: clamp01(0.42 + Number(belief.confidence || 0.4) * 0.42),
      stability: clamp01(0.48 + Number(belief.confidence || 0.4) * 0.38),
      decay: clamp01(0.24 - Number(belief.confidence || 0.4) * 0.1),
      valence: emotionalCharge(content).valence,
      status: "consolidate",
      source: "belief",
      updated_at: belief.updated_at || belief.created_at || null,
    };
  });
  return [...memoryTraces, ...beliefTraces]
    .filter(trace => trace.content)
    .sort((left, right) => right.salience - left.salience);
}

function deriveVisualState({ state, affect, phase, attention }) {
  const activity = normalizeText(state.presence?.activity).toLowerCase();
  if (activity === "speaking" || activity === "listening" || activity === "thinking") {
    return { state: activity, intensity: clamp01(0.28 + affect.arousal * 0.52), stillness: 0.12, reason: `presence activity ${activity}` };
  }
  if (phase === "sleep" || Number(state.energy || 70) < 18) {
    return { state: "sleep", intensity: 0.04, stillness: 0.92, reason: "sleep or very low energy" };
  }
  if (affect.anger > 0.55 || (affect.stress > 0.72 && affect.arousal > 0.45)) {
    return { state: "angry", intensity: clamp01(0.44 + affect.anger * 0.46 + affect.stress * 0.18), stillness: 0.04, reason: "high anger or stress" };
  }
  if (affect.valence > 0.34 && affect.arousal > 0.42 && affect.trust > 0.45) {
    return { state: "happy", intensity: clamp01(0.34 + affect.valence * 0.34 + affect.dopamine * 0.16), stillness: 0.16, reason: "positive high-arousal affect" };
  }
  if (affect.loneliness > 0.64 && affect.valence < 0.14) {
    return { state: "lonely", intensity: clamp01(0.2 + affect.loneliness * 0.28), stillness: 0.46, reason: "loneliness dominates attention" };
  }
  if (attention.some(item => item.kind === "hypothesis" || item.kind === "memory")) {
    return { state: "thinking", intensity: clamp01(0.18 + affect.curiosity * 0.26), stillness: 0.32, reason: "attention is on abstraction or memory" };
  }
  return { state: "idle", intensity: clamp01(0.1 + affect.arousal * 0.18), stillness: 0.56, reason: "regulated baseline" };
}

function deriveConsciousnessLikeMetrics({ state, affect, goals, traces, recentMessages, recentActions }) {
  const activeGoals = goals.filter(goal => goal.tension > 0.18).length;
  const stableTraces = traces.filter(trace => trace.status === "consolidate").length;
  const recentExchange = recentMessages.length > 0 ? 1 : 0;
  const actionVariety = new Set(recentActions.slice(0, 6).map(action => action.action_type)).size;
  const continuity = clamp01(0.18 + stableTraces * 0.06 + recentExchange * 0.12 + affect.attachment * 0.18 + affect.trust * 0.14);
  const agency = clamp01(0.18 + activeGoals * 0.06 + actionVariety * 0.06 + (state.loop_enabled ? 0.18 : 0.04));
  const regulation = clamp01(1 - Math.max(affect.stress, affect.anger) * 0.72);
  return {
    framing: "consciousness-like runtime state, not a claim of phenomenal consciousness",
    continuity_score: continuity,
    agency_score: agency,
    regulation_score: regulation,
    active_goal_count: activeGoals,
    stable_trace_count: stableTraces,
    action_variety: actionVariety,
  };
}

function classifyMemoryTrace(memory = {}) {
  const kind = normalizeText(memory.kind).toLowerCase();
  const tags = normalizeList(memory.tags).join(" ").toLowerCase();
  const text = `${kind} ${tags} ${normalizeText(memory.title)} ${normalizeText(memory.content)}`.toLowerCase();
  if (includesAny(text, ["identity", "self", "name", "president", "时代", "总统", "自己"])) return "self";
  if (includesAny(text, ["preference", "belief", "fact", "rule", "喜欢", "偏好", "规律"])) return "semantic";
  if (includesAny(text, ["habit", "correction", "procedure", "always", "avoid", "习惯", "纠正", "以后"])) return "procedural";
  if (kind === "web") return "semantic";
  return "episodic";
}

function emotionalCharge(text = "") {
  const lower = normalizeText(text).toLowerCase();
  const positive = includesAny(lower, ["good", "love", "like", "thank", "great", "开心", "喜欢", "谢谢", "很好"]);
  const negative = includesAny(lower, ["bad", "hate", "angry", "fail", "wrong", "sad", "生气", "讨厌", "失败", "难受"]);
  const valence = positive && !negative ? 0.42 : negative && !positive ? -0.42 : positive && negative ? -0.08 : 0;
  return {
    valence,
    intensity: positive || negative ? 0.46 : 0.12,
  };
}

function inferPhase(date = new Date()) {
  const hour = new Date(date || Date.now()).getHours();
  if (hour < 6) return "sleep";
  if (hour < 9) return "wake";
  if (hour < 18) return "day";
  if (hour < 23) return "evening";
  return "night";
}

function ageInHours(value, now = new Date()) {
  const date = new Date(value || now);
  const time = date.getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, (new Date(now || Date.now()).getTime() - time) / 3600000);
}

function normalizeStateInput(state = {}) {
  const needs = normalizeBrainNeeds(state.needs || {});
  return {
    ...state,
    energy: Number.isFinite(Number(state.energy)) ? Number(state.energy) : 70,
    presence: state.presence && typeof state.presence === "object" ? state.presence : {},
    goals: normalizeList(state.goals),
    needs,
    affect: needs.affect,
    personality: needs.personality,
    brain: needs.brain,
  };
}

function normalizeText(value, fallback = "") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

function normalizeList(value, limit = 20) {
  const input = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  const seen = new Set();
  for (const item of input.flat()) {
    const text = normalizeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function includesAny(text, words = []) {
  return words.some(word => text.includes(String(word).toLowerCase()));
}

function clamp01(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function fmt(value) {
  return Number(value || 0).toFixed(2);
}
