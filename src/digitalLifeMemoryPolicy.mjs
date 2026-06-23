export const MEMORY_POLICY_VERSION = "memory-policy-v1";

const CATEGORY_WEIGHT = Object.freeze({
  correction: 120,
  taboo: 112,
  identity: 92,
  preference: 78,
  habit: 58,
  belief: 46,
  note: 24,
});

const TABOO_PATTERNS = [
  /\b(?:do not|don't|dont|never|stop|avoid|must not|should not|no more|forbidden|taboo)\b/i,
  /\b(?:dislike|hate)\b/i,
  /\u4e0d\u8981|\u522b|\u5225|\u7981\u6b62|\u8ba8\u538c|\u4e0d\u559c\u6b22|\u4e0d\u5141\u8bb8/u,
];

const CORRECTION_PATTERNS = [
  /\b(?:correction|correct|fix this|change this|from now on|remember that|next time)\b/i,
  /\b(?:you should|you need to|please stop|keep it from happening)\b/i,
  /\u4ee5\u540e|\u8bb0\u4f4f|\u6539\u6389|\u6539\u6210|\u7ea0\u6b63|\u522b\u518d|\u4e0b\u6b21/u,
];

const IDENTITY_PATTERNS = [
  /\b(?:identity|name is|called|you are|you were|i am|my name|previous era|president|ai legion)\b/i,
  /\b(?:digital life|companion|vibeboard)\b/i,
  /\u4f60\u662f|\u4f60\u53eb|\u6211\u662f|\u540d\u5b57|\u8eab\u4efd|\u4e0a\u4e00\u4e2a\u65f6\u4ee3|\u603b\u7edf|\u6570\u5b57\u751f\u547d/u,
];

const PREFERENCE_PATTERNS = [
  /\b(?:prefer|preference|like|likes|want|wants|rather|style|tone|voice|layout|color|favorite)\b/i,
  /\u504f\u597d|\u559c\u6b22|\u60f3\u8981|\u98ce\u683c|\u8bed\u6c14|\u58f0\u97f3|\u754c\u9762|\u989c\u8272/u,
];

const HABIT_PATTERNS = [
  /\b(?:habit|usually|often|always|tends to|keeps|when .* then|after .* then)\b/i,
  /\u4e60\u60ef|\u7ecf\u5e38|\u603b\u662f|\u901a\u5e38|\u6bcf\u6b21|\u5982\u679c.*\u5c31/u,
];

const LOW_VALUE_TEST_PATTERNS = [
  /\b(?:smoke|smoke-test|ui smoke|test memory|verify|verification|playwright|fixture|ping|mock|stub)\b/i,
  /\b(?:DIGITAL_LIFE_ID|digital-life-smoke|ui-smoke)\b/i,
];

function normalizeText(value, fallback = "") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

function normalizeList(value) {
  const input = Array.isArray(value) ? value : value == null ? [] : [value];
  return input.map((item) => normalizeText(item)).filter(Boolean);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampFloat(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function compactWhitespace(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function canonicalText(value) {
  return compactWhitespace(value)
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, "")
    .replace(/\b\d+\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function includesAnyPattern(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function keywordOverlapScore(query, text) {
  const queryTokens = new Set(canonicalText(query).split(" ").filter((token) => token.length >= 3));
  if (!queryTokens.size) return 0;
  const haystack = canonicalText(text);
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 1.5;
  }
  return Math.min(12, score);
}

function recencyScore(item) {
  const raw = item.updated_at || item.created_at;
  if (!raw) return 0;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return 0;
  const days = Math.max(0, (Date.now() - time) / 86400000);
  if (days <= 1) return 3;
  if (days <= 7) return 2;
  if (days <= 30) return 1;
  return 0;
}

function sourceReliability(item) {
  const source = normalizeText(item.source).toLowerCase();
  if (source === "user") return 8;
  if (source === "conversation") return 5;
  if (source === "llm" || source === "model") return -2;
  if (source === "test" || source === "smoke") return -10;
  return 0;
}

function rawMemoryText(memory = {}) {
  return compactWhitespace([memory.kind, memory.title, memory.content, ...normalizeList(memory.tags)].join(" "));
}

function rawBeliefText(belief = {}) {
  return compactWhitespace([belief.scope, belief.belief, ...normalizeList(belief.evidence)].join(" "));
}

function classifyText({ kind = "", title = "", text = "", tags = [] } = {}) {
  const combined = compactWhitespace([kind, title, text, ...tags].join(" "));
  const normalizedKind = normalizeText(kind).toLowerCase();
  const normalizedTags = tags.map((tag) => tag.toLowerCase());
  const explicitHabit = normalizedKind === "habit" || normalizedTags.includes("habit");
  const flags = {
    correction: normalizedKind === "correction" || normalizedTags.includes("correction") || includesAnyPattern(combined, CORRECTION_PATTERNS),
    taboo: normalizedKind === "taboo" || normalizedTags.includes("taboo") || includesAnyPattern(combined, TABOO_PATTERNS),
    identity: normalizedKind === "identity" || normalizedTags.includes("identity") || includesAnyPattern(combined, IDENTITY_PATTERNS),
    preference: normalizedKind === "preference" || normalizedTags.includes("preference") || includesAnyPattern(combined, PREFERENCE_PATTERNS),
    habit: explicitHabit || includesAnyPattern(combined, HABIT_PATTERNS),
    lowValueTest: normalizedTags.some((tag) => ["smoke", "test", "fixture"].includes(tag)) || includesAnyPattern(combined, LOW_VALUE_TEST_PATTERNS),
  };
  const category = flags.correction
    ? "correction"
    : flags.taboo
      ? "taboo"
      : flags.identity
        ? "identity"
        : explicitHabit
            ? "habit"
            : flags.preference
              ? "preference"
              : flags.habit
                ? "habit"
                : "note";
  return { category, flags };
}

function policyItemFromMemory(memory = {}, index = 0, query = "") {
  const tags = normalizeList(memory.tags);
  const content = normalizeText(memory.content);
  const title = normalizeText(memory.title);
  const kind = normalizeText(memory.kind, "note");
  const classification = classifyText({ kind, title, text: content, tags });
  const importance = clampNumber(memory.importance, 1, 5, 3);
  const score =
    CATEGORY_WEIGHT[classification.category] +
    importance * 7 +
    sourceReliability(memory) +
    keywordOverlapScore(query, rawMemoryText(memory)) +
    recencyScore(memory) -
    index * 0.04 -
    (classification.flags.lowValueTest ? 120 : 0);
  return {
    id: normalizeText(memory.id, `memory-${index}`),
    sourceType: "memory",
    original: memory,
    kind,
    title,
    content,
    statement: content,
    tags,
    category: classification.category,
    flags: classification.flags,
    score,
    confidence: importance / 5,
    priority: CATEGORY_WEIGHT[classification.category],
    source: normalizeText(memory.source, "unknown"),
    created_at: memory.created_at || null,
    updated_at: memory.updated_at || null,
  };
}

function policyItemFromBelief(belief = {}, index = 0, query = "") {
  const statement = normalizeText(belief.belief || belief.statement || belief.content);
  const tags = normalizeList(belief.tags);
  const kind = normalizeText(belief.kind, "belief");
  const classification = classifyText({ kind, title: belief.title, text: statement, tags });
  const confidence = clampFloat(belief.confidence, 0, 1, 0.4);
  const category = classification.category === "note" ? "belief" : classification.category;
  const score =
    CATEGORY_WEIGHT[category] +
    confidence * 34 +
    keywordOverlapScore(query, rawBeliefText(belief)) +
    recencyScore(belief) -
    index * 0.04 -
    (classification.flags.lowValueTest ? 110 : 0);
  return {
    id: normalizeText(belief.id, `belief-${index}`),
    sourceType: "belief",
    original: belief,
    kind,
    title: normalizeText(belief.title),
    content: statement,
    statement,
    tags,
    category,
    flags: classification.flags,
    score,
    confidence,
    priority: CATEGORY_WEIGHT[category],
    source: normalizeText(belief.source || belief.scope, "belief"),
    created_at: belief.created_at || null,
    updated_at: belief.updated_at || null,
  };
}

function smokeSignature(item) {
  return canonicalText(item.content || item.statement || item.title)
    .replace(/\b(?:smoke|test|smoketest|verify|verification|ping|playwright|fixture|memory|memories)\b/g, "")
    .replace(/\bshould keep\b/g, "")
    .replace(/\blocally\b/g, "")
    .trim();
}

function dedupePolicyItems(items) {
  const seenHighValue = new Set();
  const seenSmoke = new Set();
  const deduped = [];
  const suppressed = [];
  for (const item of items) {
    const highValueKey = `${item.sourceType}:${item.category}:${canonicalText(item.content || item.statement)}`;
    if (item.flags.lowValueTest) {
      const key = smokeSignature(item) || highValueKey;
      if (seenSmoke.has(key)) {
        suppressed.push({ ...item, suppressedReason: "duplicate_low_value_test_memory" });
        continue;
      }
      seenSmoke.add(key);
    } else if (seenHighValue.has(highValueKey)) {
      suppressed.push({ ...item, suppressedReason: "duplicate_policy_item" });
      continue;
    }
    seenHighValue.add(highValueKey);
    deduped.push(item);
  }
  return { items: deduped, suppressed };
}

function traitTextFromItem(item) {
  return compactWhitespace(item.statement || item.content || item.title);
}

function makeTrait(item) {
  return {
    text: traitTextFromItem(item),
    sourceIds: [item.id],
    confidence: Number(item.confidence.toFixed(3)),
    priority: Math.round(item.score),
    category: item.category,
    sourceType: item.sourceType,
  };
}

function mergeTrait(target, item) {
  if (!target.sourceIds.includes(item.id)) target.sourceIds.push(item.id);
  target.confidence = Number(Math.max(target.confidence, item.confidence).toFixed(3));
  target.priority = Math.max(target.priority, Math.round(item.score));
}

function collectTraits(items, category) {
  const byText = new Map();
  for (const item of items) {
    if (item.category !== category && !(category === "taboo" && item.flags.taboo)) continue;
    if (item.flags.lowValueTest) continue;
    const text = traitTextFromItem(item);
    if (!text) continue;
    const key = canonicalText(text);
    if (!key) continue;
    if (!byText.has(key)) {
      byText.set(key, makeTrait(category === "taboo" ? { ...item, category: "taboo" } : item));
    } else {
      mergeTrait(byText.get(key), item);
    }
  }
  return [...byText.values()].sort((a, b) => b.priority - a.priority || b.confidence - a.confidence);
}

export function rankMemoryPolicyItems({ memories = [], beliefs = [], text = "", limit = 12 } = {}) {
  const allItems = [
    ...memories.map((memory, index) => policyItemFromMemory(memory, index, text)),
    ...beliefs.map((belief, index) => policyItemFromBelief(belief, index, text)),
  ]
    .filter((item) => item.content)
    .sort((a, b) => b.score - a.score || b.priority - a.priority || b.confidence - a.confidence);
  const { items, suppressed } = dedupePolicyItems(allItems);
  const boundedLimit = clampNumber(limit, 1, 100, 12);
  return {
    items: items.slice(0, boundedLimit),
    suppressed,
    allItems: items,
  };
}

export function deriveStableTraits({ memories = [], beliefs = [] } = {}) {
  const { allItems } = rankMemoryPolicyItems({ memories, beliefs, limit: 100 });
  return {
    taboos: collectTraits(allItems, "taboo"),
    preferences: collectTraits(allItems, "preference"),
    identityFacts: collectTraits(allItems, "identity"),
    habits: collectTraits(allItems, "habit"),
  };
}

export function buildMemoryPolicyContext({ memories = [], beliefs = [], text = "", limit = 8 } = {}) {
  const ranked = rankMemoryPolicyItems({ memories, beliefs, text, limit });
  const traits = deriveStableTraits({ memories, beliefs });
  const rankedMemories = ranked.items
    .filter((item) => item.sourceType === "memory" && !item.flags.lowValueTest)
    .map((item) => item.original);
  const rankedBeliefs = ranked.items
    .filter((item) => item.sourceType === "belief" && !item.flags.lowValueTest)
    .map((item) => item.original);
  return {
    version: MEMORY_POLICY_VERSION,
    ranked: ranked.items,
    suppressed: ranked.suppressed,
    memories: rankedMemories,
    beliefs: rankedBeliefs,
    traits,
  };
}
