const DEFAULT_AFFECT = Object.freeze({
  valence: 0.02,
  arousal: 0.35,
  dominance: 0.02,
  curiosity: 0.68,
  loneliness: 0.28,
  trust: 0.52,
  stress: 0.08,
  boredom: 0.18,
  anger: 0,
  attachment: 0.48,
  dopamine: 0,
});

const DEFAULT_PERSONALITY = Object.freeze({
  openness: 0.74,
  conscientiousness: 0.46,
  extraversion: 0.42,
  agreeableness: 0.58,
  neuroticism: 0.38,
  curiosityBias: 0.72,
  attachmentBias: 0.58,
  autonomyBias: 0.44,
});

const AFFECT_KEYS = Object.keys(DEFAULT_AFFECT);
const PERSONALITY_KEYS = Object.keys(DEFAULT_PERSONALITY);

export function defaultBrainNeeds() {
  return syncLegacyNeeds({
    dopamine: DEFAULT_AFFECT.dopamine,
    mood: DEFAULT_AFFECT.valence,
    arousal: DEFAULT_AFFECT.arousal,
    curiosity: DEFAULT_AFFECT.curiosity,
    boredom: DEFAULT_AFFECT.boredom,
    stress: DEFAULT_AFFECT.stress,
    loneliness: DEFAULT_AFFECT.loneliness,
    social: DEFAULT_AFFECT.trust,
    affect: { ...DEFAULT_AFFECT },
    personality: { ...DEFAULT_PERSONALITY },
    brain: {
      version: 1,
      last_appraisal: null,
      drives: [],
      mood_label: deriveMoodLabel(DEFAULT_AFFECT),
    },
  });
}

export function normalizeBrainNeeds(needs = {}) {
  const input = needs && typeof needs === "object" ? needs : {};
  const affectInput = input.affect && typeof input.affect === "object" ? input.affect : {};
  const personalityInput = input.personality && typeof input.personality === "object" ? input.personality : {};
  const brainInput = input.brain && typeof input.brain === "object" ? input.brain : {};
  const affect = {};
  for (const key of AFFECT_KEYS) {
    const legacy = key === "valence"
      ? input.mood
      : key === "trust"
        ? input.social
        : input[key];
    affect[key] = clamp(Number(affectInput[key] ?? legacy), affectRange(key), DEFAULT_AFFECT[key]);
  }
  const personality = {};
  for (const key of PERSONALITY_KEYS) {
    personality[key] = clamp01(Number(personalityInput[key]), DEFAULT_PERSONALITY[key]);
  }
  const normalized = {
    dopamine: affect.dopamine,
    mood: affect.valence,
    arousal: affect.arousal,
    curiosity: affect.curiosity,
    boredom: affect.boredom,
    stress: affect.stress,
    loneliness: affect.loneliness,
    social: affect.trust,
    affect,
    personality,
    brain: {
      version: 1,
      last_appraisal: normalizeAppraisal(brainInput.last_appraisal),
      drives: Array.isArray(brainInput.drives) ? brainInput.drives.slice(0, 5).map(String) : deriveDrives(affect, personality),
      mood_label: String(brainInput.mood_label || deriveMoodLabel(affect)),
      updated_at: brainInput.updated_at || null,
    },
  };
  return syncLegacyNeeds(normalized);
}

export function createAffectEngine({ needs = {}, now = new Date() } = {}) {
  let state = normalizeBrainNeeds(needs);
  return {
    observe(event = {}) {
      state = applyAffectEvent(state, event, { now });
      return snapshot(state);
    },
    tick(options = {}) {
      state = tickAffect(state, options);
      return snapshot(state);
    },
    snapshot() {
      return snapshot(state);
    },
    describeForPrompt() {
      return describeBrainForPrompt(state);
    },
    chooseAction(candidates = [], context = {}) {
      return chooseAffectiveAction({ needs: state, ...context }, candidates);
    },
  };
}

export function applyAffectEvent(needs = {}, event = {}, options = {}) {
  const current = normalizeBrainNeeds(needs);
  const affect = { ...current.affect };
  const personality = { ...current.personality };
  const appraisal = appraise(event, { affect, personality });
  const plasticity = 0.7 + personality.neuroticism * 0.45;
  const openness = 0.75 + personality.openness * 0.5;
  const attachment = 0.75 + personality.attachmentBias * 0.5;
  const autonomy = 0.75 + personality.autonomyBias * 0.45;

  affect.valence = clamp11(
    affect.valence
      + appraisal.reward * 0.2
      + appraisal.warmth * 0.16
      + appraisal.goalProgress * 0.12
      + appraisal.soothing * 0.12
      - appraisal.threat * 0.16
      - appraisal.failure * 0.14 * plasticity,
  );
  affect.arousal = clamp01(
    affect.arousal
      + appraisal.novelty * 0.12
      + appraisal.uncertainty * 0.1
      + appraisal.threat * 0.14
      + appraisal.anger * 0.16
      + Math.abs(appraisal.reward) * 0.06
      - appraisal.safety * 0.06
      - appraisal.soothing * 0.08,
  );
  affect.dominance = clamp11(
    affect.dominance
      + appraisal.controllability * 0.12 * autonomy
      + appraisal.goalProgress * 0.08
      - appraisal.failure * 0.18
      - appraisal.threat * 0.08,
  );
  affect.curiosity = clamp01(
    affect.curiosity
      + appraisal.novelty * 0.18 * openness
      + appraisal.uncertainty * 0.08
      - appraisal.failure * 0.05
      - appraisal.safety * 0.02,
  );
  affect.loneliness = clamp01(
    affect.loneliness
      - appraisal.warmth * 0.18 * attachment
      - appraisal.presence * 0.16
      + appraisal.absence * 0.14 * attachment,
  );
  affect.trust = clamp01(
    affect.trust
      + appraisal.warmth * 0.08
      + appraisal.repair * 0.08
      + appraisal.soothing * 0.08
      - appraisal.threat * 0.12
      - appraisal.failure * 0.04,
  );
  affect.stress = clamp01(
    affect.stress
      + appraisal.threat * 0.18 * plasticity
      + appraisal.failure * 0.16 * plasticity
      + appraisal.anger * 0.12 * plasticity
      + appraisal.uncertainty * 0.06
      - appraisal.safety * 0.1
      - appraisal.warmth * 0.04
      - appraisal.soothing * 0.14,
  );
  affect.boredom = clamp01(
    affect.boredom
      + appraisal.repetition * 0.12
      + appraisal.absence * 0.05
      - appraisal.novelty * 0.16
      - appraisal.goalProgress * 0.08,
  );
  affect.anger = clamp01(
    affect.anger
      + appraisal.threat * 0.18 * plasticity
      + appraisal.failure * 0.08
      + appraisal.anger * 0.2
      - appraisal.soothing * 0.22
      - appraisal.warmth * 0.05,
  );
  affect.attachment = clamp01(
    affect.attachment
      + appraisal.warmth * 0.06 * attachment
      + appraisal.presence * 0.04
      - appraisal.threat * 0.04,
  );
  affect.dopamine = clamp11(affect.dopamine * 0.55 + appraisal.reward * 0.45);

  return withBrainMetadata({
    ...current,
    affect,
    personality,
  }, appraisal, options.now);
}

export function tickAffect(needs = {}, { minutes = 1, phase = "day", energy = 70 } = {}) {
  const current = normalizeBrainNeeds(needs);
  const affect = { ...current.affect };
  const personality = current.personality;
  const step = clamp(Number(minutes) || 1, [0.1, 120], 1) / 60;
  const lowEnergy = clamp01(1 - Number(energy || 70) / 100, 0.3);

  affect.dopamine = clamp11(affect.dopamine * (1 - 0.3 * step));
  affect.valence = clamp11(affect.valence * (1 - 0.07 * step) - lowEnergy * 0.025 * step);
  affect.arousal = clamp01(affect.arousal + (phase === "sleep" ? -0.16 : -0.03) * step + lowEnergy * 0.05 * step);
  affect.curiosity = clamp01(affect.curiosity + (0.05 + personality.curiosityBias * 0.04) * step - affect.stress * 0.025 * step);
  affect.boredom = clamp01(affect.boredom + (0.04 - personality.openness * 0.01) * step);
  affect.anger = clamp01(affect.anger - (0.08 + personality.agreeableness * 0.04) * step);
  affect.loneliness = clamp01(affect.loneliness + (0.035 + personality.attachmentBias * 0.025) * step);
  affect.stress = clamp01(affect.stress - 0.025 * step + lowEnergy * 0.02 * step);
  affect.dominance = clamp11(affect.dominance * (1 - 0.025 * step) - lowEnergy * 0.025 * step);
  affect.trust = clamp01(affect.trust * (1 - 0.006 * step) + 0.003 * step);
  affect.attachment = clamp01(affect.attachment * (1 - 0.004 * step) + affect.loneliness * 0.006 * step);

  return withBrainMetadata({
    ...current,
    affect,
  }, {
    type: "time.tick",
    novelty: 0,
    warmth: 0,
    reward: 0,
    controllability: phase === "sleep" ? 0.25 : 0.4,
    uncertainty: 0.05,
    threat: 0,
    goalProgress: 0,
    repetition: affect.boredom,
    absence: affect.loneliness,
    presence: 0,
    safety: phase === "sleep" ? 0.4 : 0.1,
    failure: 0,
    anger: 0,
    soothing: 0,
    repair: 0,
  });
}

export function chooseAffectiveAction(state = {}, candidates = []) {
  const needs = normalizeBrainNeeds(state.needs || state);
  const affect = needs.affect;
  const phase = state.phase || "day";
  const lastAction = state.recentActions?.[0]?.action_type || "";
  const baseScores = {
    sleep: (1 - Number(state.energy || 70) / 100) * 0.85 + affect.stress * 0.5 + affect.anger * 0.22 + (phase === "sleep" ? 1.1 : 0),
    write_diary: Math.abs(affect.valence) * 0.45 + affect.boredom * 0.18 + affect.attachment * 0.08 + affect.anger * 0.16 + (phase === "night" ? 0.32 : 0),
    read_web: affect.curiosity * 0.8 + affect.boredom * 0.35 - affect.stress * 0.28 - affect.anger * 0.28 + (phase === "day" ? 0.16 : 0),
    organize_memory: affect.stress * 0.36 + affect.boredom * 0.22 + affect.dominance * 0.08 + affect.anger * 0.34 + 0.1,
    send_message: affect.loneliness * 0.88 + affect.attachment * 0.24 + affect.trust * 0.14 - affect.stress * 0.22 - affect.anger * 0.48 + (phase === "evening" ? 0.42 : 0),
    think: affect.curiosity * 0.35 + affect.valence * 0.14 + affect.dominance * 0.08 - affect.anger * 0.12 + 0.2 + (phase === "wake" ? 0.12 : 0),
    do_nothing: 0.18 + affect.stress * 0.1,
  };
  const allowed = candidates.length ? candidates : Object.keys(baseScores);
  const scored = allowed.map(action => [
    action,
    (baseScores[action] ?? 0) - (action === lastAction ? 0.25 : 0),
  ]);
  scored.sort((left, right) => right[1] - left[1]);
  return scored[0]?.[1] > 0.32 ? scored[0][0] : "do_nothing";
}

export function deriveMoodLabel(input = {}) {
  const raw = input.affect && typeof input.affect === "object" ? input.affect : input;
  const affect = { ...DEFAULT_AFFECT, ...raw };
  if (affect.stress > 0.62 && affect.arousal > 0.48) return "strained";
  if (affect.anger > 0.62) return "angry";
  if (affect.loneliness > 0.68 && affect.valence < 0.08) return "lonely";
  if (affect.valence < -0.28) return "hurt";
  if (affect.curiosity > 0.76 && affect.stress < 0.48) return "curious";
  if (affect.valence > 0.32 && affect.trust > 0.55) return "warm";
  if (affect.boredom > 0.68) return "restless";
  if (affect.arousal < 0.22) return "quiet";
  return "calm";
}

export function describeBrainForPrompt(needs = {}) {
  const brain = normalizeBrainNeeds(needs);
  const affect = brain.affect;
  const personality = brain.personality;
  const drives = deriveDrives(affect, personality);
  return [
    `- affect: ${deriveMoodLabel(affect)}; valence=${fmt(affect.valence)}, arousal=${fmt(affect.arousal)}, dominance=${fmt(affect.dominance)}`,
    `- social: trust=${fmt(affect.trust)}, attachment=${fmt(affect.attachment)}, loneliness=${fmt(affect.loneliness)}`,
    `- drives: curiosity=${fmt(affect.curiosity)}, boredom=${fmt(affect.boredom)}, stress=${fmt(affect.stress)}, anger=${fmt(affect.anger)}, dopamine=${fmt(affect.dopamine)}`,
    `- personality: openness=${fmt(personality.openness)}, neuroticism=${fmt(personality.neuroticism)}, autonomy=${fmt(personality.autonomyBias)}, attachment=${fmt(personality.attachmentBias)}`,
    `- current impulses: ${drives.length ? drives.join(", ") : "stay regulated"}`,
  ].join("\n");
}

export function expressionFromBrain(needs = {}) {
  const brain = normalizeBrainNeeds(needs);
  const affect = brain.affect;
  return {
    mood: deriveMoodLabel(affect),
    energyBias: clamp01((affect.valence + 1) / 2),
    valence: affect.valence,
    arousal: affect.arousal,
    dominance: affect.dominance,
    curiosity: affect.curiosity,
    loneliness: affect.loneliness,
    trust: affect.trust,
    stress: affect.stress,
    anger: affect.anger,
    boredom: affect.boredom,
    attachment: affect.attachment,
    dopamine: affect.dopamine,
  };
}

function appraise(event = {}, context = {}) {
  const text = String(event.content || event.text || event.message || "").toLowerCase();
  const explicitReward = Number(event.reward ?? event.value ?? 0);
  const type = String(event.type || event.event_type || "event");
  const explicitWarmth = /sorry|gentle|love|stay|with you|thank|duibuqi|calm|对不起|别怕|慢慢来|没事|我在|陪你|哄|抱歉|喜欢|谢谢/i.test(text) ? 0.55 : 0;
  const explicitThreat = /shut up|stupid|useless|punish|hate|angry|闭嘴|笨|没用|讨厌|惩罚|滚|生气/i.test(text) ? 0.55 : 0;
  const soothingWords = /sorry|gentle|breathe|calm|stay with you|it's okay|duibuqi|对不起|别怕|慢慢来|没事|我在|陪你|哄|抱歉/i.test(text) ? 0.65 : 0;
  const warmthWords = /thank|good|great|love|like|陪|喜欢|谢谢|很好|可以|奖励|回来|在家/i.test(text) ? 0.45 : 0;
  const threatWords = /bad|wrong|fail|stop|angry|hate|惩罚|错|失败|难受|生气|不好/i.test(text) ? 0.35 : 0;
  const noveltyWords = /new|why|how|what|研究|新闻|网页|问题|想法|抽象|规律|实验/i.test(text) ? 0.35 : 0;
  const presenceStatus = String(event.status || event.presence || "").toLowerCase();
  const activity = String(event.activity || "").toLowerCase();

  const appraisal = {
    type,
    novelty: num(event.novelty, noveltyWords),
    warmth: num(event.warmth ?? event.socialWarmth, Math.max(warmthWords, explicitWarmth)),
    reward: clamp11(explicitReward),
    controllability: num(event.controllability, type.includes("command") ? 0.25 : 0.45),
    uncertainty: num(event.uncertainty, /maybe|不确定|可能|试试/i.test(text) ? 0.35 : 0.1),
    threat: num(event.threat, Math.max(threatWords, explicitThreat)),
    anger: num(event.anger, Math.max(threatWords, explicitThreat)),
    soothing: num(event.soothing, soothingWords),
    goalProgress: num(event.goalProgress ?? event.goal_progress, type.includes("success") ? 0.55 : 0),
    repetition: num(event.repetition, 0),
    absence: num(event.absence, presenceStatus === "away" ? 0.6 : 0),
    presence: num(event.presenceValue, presenceStatus === "present" || activity === "conversation" || activity === "nearby" ? 0.55 : 0),
    safety: num(event.safety, type.includes("sleep") || type.includes("rest") ? 0.45 : 0),
    failure: num(event.failure, type.includes("fail") || type.includes("penalty") ? 0.55 : 0),
    repair: num(event.repair, type.includes("reward") ? 0.25 : 0),
  };
  if (type.includes("owner_message")) {
    appraisal.warmth = Math.max(appraisal.warmth, 0.18);
    appraisal.presence = Math.max(appraisal.presence, 0.42);
    appraisal.novelty = Math.max(appraisal.novelty, Math.min(0.5, text.length / 360));
  }
  if (type.includes("web")) {
    appraisal.novelty = Math.max(appraisal.novelty, 0.5);
    appraisal.goalProgress = Math.max(appraisal.goalProgress, event.ok === false ? 0 : 0.22);
    appraisal.failure = Math.max(appraisal.failure, event.ok === false ? 0.5 : 0);
  }
  if (type.includes("reward")) {
    appraisal.warmth = Math.max(appraisal.warmth, explicitReward > 0 ? 0.35 : 0);
    appraisal.threat = Math.max(appraisal.threat, explicitReward < 0 ? 0.3 : 0);
  }
  if (appraisal.soothing > 0) {
    appraisal.warmth = Math.max(appraisal.warmth, appraisal.soothing * 0.7);
    appraisal.safety = Math.max(appraisal.safety, appraisal.soothing * 0.6);
    appraisal.repair = Math.max(appraisal.repair, appraisal.soothing * 0.5);
  }
  return Object.fromEntries(Object.entries(appraisal).map(([key, value]) => [
    key,
    key === "type" ? value : clamp01(value, 0),
  ]));
}

function deriveDrives(affect, personality) {
  const drives = [];
  if (affect.loneliness > 0.56) drives.push("seek connection");
  if (affect.curiosity * (0.8 + personality.openness * 0.4) > 0.62) drives.push("explore the world");
  if (affect.anger > 0.5) drives.push("cool down before responding");
  if (affect.stress > 0.48) drives.push("reduce stress");
  if (affect.boredom > 0.52) drives.push("find novelty");
  if (affect.dominance < -0.25) drives.push("regain control");
  if (!drives.length && affect.trust > 0.58) drives.push("stay available");
  return drives.slice(0, 4);
}

function withBrainMetadata(state, appraisal, now = new Date()) {
  const normalized = syncLegacyNeeds(state);
  normalized.brain = {
    version: 1,
    last_appraisal: normalizeAppraisal(appraisal),
    drives: deriveDrives(normalized.affect, normalized.personality),
    mood_label: deriveMoodLabel(normalized.affect),
    updated_at: new Date(now || Date.now()).toISOString(),
  };
  return normalized;
}

function syncLegacyNeeds(input) {
  const state = { ...input, affect: { ...input.affect }, personality: { ...input.personality }, brain: { ...input.brain } };
  state.dopamine = state.affect.dopamine;
  state.mood = state.affect.valence;
  state.arousal = state.affect.arousal;
  state.curiosity = state.affect.curiosity;
  state.boredom = state.affect.boredom;
  state.stress = state.affect.stress;
  state.anger = state.affect.anger;
  state.loneliness = state.affect.loneliness;
  state.social = state.affect.trust;
  state.brain.mood_label = deriveMoodLabel(state.affect);
  state.brain.drives = deriveDrives(state.affect, state.personality);
  return state;
}

function snapshot(needs) {
  const normalized = normalizeBrainNeeds(needs);
  return {
    needs: normalized,
    affect: { ...normalized.affect },
    personality: { ...normalized.personality },
    brain: { ...normalized.brain },
    prompt: describeBrainForPrompt(normalized),
    expression: expressionFromBrain(normalized),
  };
}

function normalizeAppraisal(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = key === "type" ? String(raw || "event") : clamp01(raw, 0);
  }
  return out;
}

function num(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function fmt(value) {
  return Number(value || 0).toFixed(2);
}

function affectRange(key) {
  return key === "valence" || key === "dominance" || key === "dopamine" ? [-1, 1] : [0, 1];
}

function clamp01(value, fallback = 0) {
  return clamp(value, [0, 1], fallback);
}

function clamp11(value) {
  return clamp(value, [-1, 1], 0);
}

function clamp(value, range = [0, 1], fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(range[1], Math.max(range[0], number));
}
