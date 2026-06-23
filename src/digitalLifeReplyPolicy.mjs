function normalizeText(value, fallback = "") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

function compactWhitespace(text = "") {
  return String(text || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const ROLEPLAY_TITLE_RE = /\b(?:master|owner|boss)\b[:,：\s]*|主人[，,：:\s]*|老板[，,：:\s]*/giu;
const PAREN_STAGE_RE = /(^|\n)\s*[\(（][^()（）\n]{1,180}[\)）]\s*/gmu;
const INLINE_STAGE_RE = /[\(（][^()（）]*(?:clears throat|tone|laugh|smile|gesture|action|speaker|screen|voice|表情|动作|语气|笑|嗓子|光标|屏幕)[^()（）]*[\)）]/gimu;

const CONCRETE_MECHANISM_RE = /intent classification|memory ranking|affect appraisal|action selection|reply guard|policy|意图|记忆排序|记忆召回|情绪评估|行动选择|回复策略|机制|规则/u;
const VAGUE_ROADMAP_RE = /方向|可以升级|更自然|更智能|先弄|以后会更好|慢慢来|try to improve|make it better|more natural/iu;

export function sanitizeAssistantReply(content = "", contract = {}) {
  let text = normalizeText(content)
    .replace(PAREN_STAGE_RE, "$1")
    .replace(INLINE_STAGE_RE, "")
    .replace(ROLEPLAY_TITLE_RE, "")
    .replace(/^\s*>\s?/gm, "");
  text = compactWhitespace(text) || "我在。";
  return contract?.maxSentences ? enforceMaxSentences(text, contract.maxSentences) : text;
}

export function splitSentences(content = "") {
  const text = compactWhitespace(content);
  if (!text) return [];
  const sentences = text
    .replace(/\n+/g, " ")
    .match(/[^。！？!?]+[。！？!?]?/gu);
  return (sentences || [text])
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildReplyContract({ dialoguePlan = {}, state = {}, memoryProfile = {} } = {}) {
  const intent = dialoguePlan.intent?.type || "conversation";
  const responseContract = dialoguePlan.responseContract || {};
  const maxSentences = Number(responseContract.maxSentences || (intent === "capability_or_plan" ? 5 : 3));
  const boundedMaxSentences = Math.max(1, Math.min(8, Number(state.energy || 70) < 28 ? Math.min(2, maxSentences) : maxSentences));
  return {
    intentType: intent,
    intent,
    relationMove: dialoguePlan.relationMove || "respond_naturally",
    maxSentences: boundedMaxSentences,
    mustAvoid: [
      "stage_directions",
      "roleplay_titles",
      ...(responseContract.mustAvoid || []),
      ...(memoryProfile.taboos || []),
    ],
    requiredMechanism: intent === "quality_complaint",
    qualityComplaint: {
      requiresConcreteMechanism: intent === "quality_complaint",
    },
    shouldAsk: Boolean(responseContract.shouldAsk),
    style: responseContract.style || "specific and alive",
    mood: state.brain?.mood_label || state.mood || "calm",
  };
}

export function detectReplyViolations(content = "", contract = {}) {
  const text = normalizeText(content);
  const sanitized = sanitizeAssistantReply(text);
  const sentences = splitSentences(sanitized);
  const violations = [];
  if (PAREN_STAGE_RE.test(text) || INLINE_STAGE_RE.test(text)) {
    violations.push({ code: "STAGE_DIRECTION", legacyCode: "stage_directions" });
  }
  PAREN_STAGE_RE.lastIndex = 0;
  INLINE_STAGE_RE.lastIndex = 0;
  if (ROLEPLAY_TITLE_RE.test(text)) violations.push({ code: "ROLEPLAY_TITLE", legacyCode: "roleplay_titles" });
  ROLEPLAY_TITLE_RE.lastIndex = 0;
  if (sentences.length > Number(contract.maxSentences || 99)) {
    violations.push({ code: "TOO_MANY_SENTENCES", legacyCode: "too_many_sentences" });
  }
  if (contract.requiredMechanism && (!CONCRETE_MECHANISM_RE.test(sanitized) || VAGUE_ROADMAP_RE.test(sanitized))) {
    violations.push({ code: "VAGUE_QUALITY_COMPLAINT", legacyCode: "vague_quality_repair" });
  }
  const seen = new Set();
  return violations.filter((item) => {
    if (seen.has(item.code)) return false;
    seen.add(item.code);
    return true;
  });
}

function violationCodes(violations = []) {
  return violations.map((item) => item.code || item);
}

export function enforceMaxSentences(content = "", maxSentences = 3) {
  const sentences = splitSentences(content);
  if (sentences.length <= maxSentences) return compactWhitespace(content);
  return compactWhitespace(sentences.slice(0, maxSentences).join(""));
}

export function repairAssistantReply(content = "", contract = {}) {
  let repaired = sanitizeAssistantReply(content);
  if (contract.requiredMechanism && violationCodes(detectReplyViolations(repaired, contract)).includes("VAGUE_QUALITY_COMPLAINT")) {
    repaired = "你说得对，这不是单纯换一种说法能解决的。我会把这次反馈落到三个内部机制上：先做意图分类，再做记忆排序，最后用回复策略检查是否又变成模板话。";
  }
  repaired = enforceMaxSentences(repaired, Number(contract.maxSentences || 3));
  return sanitizeAssistantReply(repaired);
}

export function guardAssistantReply(content = "", { contract = {}, fallback = "" } = {}) {
  const initial = normalizeText(content, fallback);
  const firstPass = sanitizeAssistantReply(initial);
  const initialViolations = detectReplyViolations(initial, contract);
  if (!initialViolations.length) {
    return { content: firstPass, violations: [], repaired: false };
  }
  const repaired = repairAssistantReply(firstPass, contract);
  const remaining = detectReplyViolations(repaired, contract);
  return {
    content: repaired,
    violations: initialViolations,
    remainingViolations: remaining,
    repaired: true,
  };
}

export function enforceReplyContract(content = "", contract = {}) {
  const guarded = guardAssistantReply(content, { contract });
  return {
    reply: guarded.content,
    content: guarded.content,
    violations: guarded.violations,
    remainingViolations: guarded.remainingViolations || [],
    repaired: guarded.repaired,
  };
}
