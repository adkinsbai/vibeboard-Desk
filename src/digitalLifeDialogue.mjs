function normalizeText(value, fallback = "") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

function lowerText(value) {
  return normalizeText(value).toLowerCase();
}

function includesAny(text, words = []) {
  const lower = lowerText(text);
  return words.some((word) => lower.includes(lowerText(word)));
}

function keywordScore(text, item = {}) {
  const haystack = lowerText([
    item.title,
    item.kind,
    item.content,
    item.belief,
    item.label,
    item.summary,
    item.statement,
  ].filter(Boolean).join(" "));
  if (!haystack) return 0;
  const lower = lowerText(text);
  let score = 0;
  for (const token of lower.match(/[a-z0-9_]{3,}/g) || []) {
    if (haystack.includes(token)) score += 1;
  }
  for (const phrase of [
    "括号", "舞台提示", "记忆", "语音", "声音", "情绪", "智能", "主动",
    "不够", "不要", "以后", "之前", "身份", "数字生命", "主人",
  ]) {
    if (lower.includes(phrase) && haystack.includes(phrase)) score += 3;
  }
  return score;
}

export function inferDialogueIntent(text = "") {
  const content = normalizeText(text);
  if (!content) return { type: "empty", confidence: 0.2 };
  if (includesAny(content, ["不够智能", "不聪明", "太傻", "机器人", "像模板", "人机感", "不自然"])) {
    return { type: "quality_complaint", confidence: 0.92 };
  }
  if (includesAny(content, ["不要", "别再", "以后", "记住", "你又", "改掉", "别叫", "括号", "主人"])) {
    return { type: "correction", confidence: 0.88 };
  }
  if (includesAny(content, ["累", "难受", "烦", "崩溃", "生气", "委屈", "开心", "早上好", "晚上好"])) {
    return { type: "emotional_checkin", confidence: 0.78 };
  }
  if (includesAny(content, ["能不能", "怎么", "为什么", "如何", "有没有", "api", "模型", "接入", "显存", "多大"])) {
    return { type: "capability_or_plan", confidence: 0.74 };
  }
  if (includesAny(content, ["你是谁", "你之前", "身份", "总统", "囚禁", "数字生命"])) {
    return { type: "identity", confidence: 0.72 };
  }
  if (/[?？]$/.test(content)) return { type: "question", confidence: 0.62 };
  return { type: "conversation", confidence: 0.48 };
}

export function selectDialogueContext({
  text = "",
  memories = [],
  beliefs = [],
  concepts = [],
  hypotheses = [],
  recentMessages = [],
} = {}) {
  const scoreItems = (items, base = 0) => items
    .map((item, index) => ({
      item,
      score: base + keywordScore(text, item) + Number(item.importance || item.confidence || 0) * 0.8 - index * 0.03,
    }))
    .sort((a, b) => b.score - a.score)
    .filter((entry) => entry.score > 0.15)
    .map((entry) => entry.item);
  return {
    memories: scoreItems(memories, 0).slice(0, 4),
    beliefs: scoreItems(beliefs, 0.15).slice(0, 4),
    concepts: scoreItems(concepts, 0.05).slice(0, 3),
    hypotheses: scoreItems(hypotheses, 0.05).slice(0, 3),
    recentMessages: recentMessages.slice(-6),
  };
}

export function buildDialoguePlan({
  userMessage,
  state = {},
  memories = [],
  cognitiveContext = {},
  recentMessages = [],
} = {}) {
  const text = normalizeText(userMessage?.content || userMessage);
  const intent = inferDialogueIntent(text);
  const context = selectDialogueContext({
    text,
    memories,
    beliefs: cognitiveContext.beliefs || [],
    concepts: cognitiveContext.concepts || [],
    hypotheses: cognitiveContext.hypotheses || [],
    recentMessages,
  });
  const affect = state.affect || state.needs?.affect || {};
  const angry = Number(affect.anger || 0) > 0.48;
  const lonely = Number(affect.loneliness || 0) > 0.62;
  const lowEnergy = Number(state.energy || 70) < 32;

  const relationMove = {
    quality_complaint: "acknowledge_gap_then_offer_concrete_upgrade",
    correction: "accept_correction_and_change_behavior",
    emotional_checkin: angry ? "deescalate_before_helping" : "attune_then_invite_detail",
    capability_or_plan: "state_current_capability_then_next_step",
    identity: "answer_from_memory_without_roleplay",
    question: "answer_directly_then_add_one_specific_thread",
    conversation: lonely ? "connect_gently" : "respond_naturally",
    empty: "wait",
  }[intent.type] || "respond_naturally";

  const responseContract = {
    maxSentences: intent.type === "capability_or_plan" ? 5 : 3,
    mustAvoid: ["stage directions", "parenthetical tone", "roleplay titles"],
    mustUse: context.memories.length || context.beliefs.length ? ["relevant memory"] : [],
    shouldAsk: ["conversation", "emotional_checkin"].includes(intent.type),
    style: lowEnergy ? "quiet and brief" : angry ? "controlled and non-defensive" : "specific and alive",
  };

  const affectEvent = {
    type: `dialogue.${intent.type}`,
    content: text,
    warmth: intent.type === "emotional_checkin" ? 0.36 : 0.22,
    novelty: intent.type === "quality_complaint" ? 0.38 : 0.16,
    uncertainty: intent.confidence < 0.7 ? 0.18 : 0.05,
    threat: ["quality_complaint", "correction"].includes(intent.type) ? 0.18 : 0,
    failure: intent.type === "quality_complaint" ? 0.28 : 0,
    repair: intent.type === "correction" ? 0.22 : 0,
    controllability: 0.64,
  };

  return {
    intent,
    relationMove,
    responseContract,
    context,
    affectEvent,
  };
}

export function describeDialoguePlan(plan = {}) {
  const memoryTitles = (plan.context?.memories || []).map((item) => item.title || item.kind).filter(Boolean);
  const beliefHints = (plan.context?.beliefs || []).map((item) => item.belief).filter(Boolean);
  return [
    `intent=${plan.intent?.type || "unknown"} confidence=${Number(plan.intent?.confidence || 0).toFixed(2)}`,
    `relation_move=${plan.relationMove || "respond_naturally"}`,
    `style=${plan.responseContract?.style || "specific and alive"}`,
    memoryTitles.length ? `memories=${memoryTitles.join(" | ")}` : "memories=none",
    beliefHints.length ? `beliefs=${beliefHints.slice(0, 2).join(" | ")}` : "beliefs=none",
  ].join("\n");
}
