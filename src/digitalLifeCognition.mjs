function normalizeText(value, fallback = "") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

export const COGNITIVE_PATTERNS = Object.freeze([
  {
    key: "voice_naturalness",
    label: "Voice naturalness matters",
    summary: "The owner cares about speech rhythm, prosody, pronunciation, and whether the synthetic voice feels natural.",
    hypothesis: "When the owner discusses voice, prioritize rhythm, pronunciation, pausing, and adapter limits over simply confirming that audio works.",
    next_test: "For the next voice-related request, mention concrete TTS adapter limits and offer voice/rhythm tuning.",
    words: ["voice", "tts", "speech", "prosody", "pronunciation", "rhythm", "pause", "语音", "声音", "发音", "音调", "断句", "文字转语音", "读音"],
  },
  {
    key: "honest_boundaries",
    label: "Honest capability boundaries",
    summary: "The owner prefers accurate capability boundaries and corrects invented claims quickly.",
    hypothesis: "When uncertain about hardware, audio, privacy, or model capabilities, be explicit about what is implemented versus only planned.",
    next_test: "If asked about a capability, answer with current implementation status before aspirational design.",
    words: ["actually", "real", "connected", "model", "capability", "privacy", "boundary", "不是", "不对", "实际", "真的", "接入", "模型", "能力", "边界", "隐私"],
  },
  {
    key: "minimal_life_symbol",
    label: "Minimal symbolic embodiment",
    summary: "The owner prefers a restrained symbolic life expression over uncanny 3D faces or decorative complexity.",
    hypothesis: "For embodiment design, use subtle motion, lines, and device-like signals instead of literal faces unless explicitly requested.",
    next_test: "When improving expression, propose line/signal behaviors before facial features.",
    words: ["expression", "line", "wave", "symbol", "3d", "three", "face", "uncanny", "表情", "直线", "振动", "脸", "诡异", "符号", "麦金塔"],
  },
  {
    key: "persistent_memory",
    label: "Persistent identity and memory",
    summary: "The owner expects the companion to retain names, preferences, corrections, and recent interaction context.",
    hypothesis: "Identity corrections and naming preferences should be treated as high-confidence long-term beliefs.",
    next_test: "When the owner asks identity or recent-context questions, answer from stored beliefs and mention uncertainty when needed.",
    words: ["remember", "memory", "name", "preference", "later", "always", "记住", "名字", "小黑", "你叫", "我是谁", "刚才", "以后", "记忆"],
  },
  {
    key: "responsive_ui",
    label: "Responsive visible interaction",
    summary: "The owner notices delays, disappearing messages, layout friction, and visible interface state problems.",
    hypothesis: "For UI changes, preserve immediate feedback and avoid background refreshes that erase local user actions.",
    next_test: "When changing interaction flow, verify pending state and visible persistence in the browser.",
    words: ["disappear", "popup", "layout", "refresh", "display", "scroll", "enter", "send", "消失", "弹出", "界面", "布局", "刷新", "显示", "拉到", "体验", "发送"],
  },
  {
    key: "abstract_reasoning_interest",
    label: "Abstract reasoning as growth",
    summary: "The owner wants the companion to extract rules, test hypotheses, and transfer patterns across domains.",
    hypothesis: "The companion should explain and use observable reasoning loops: observe, abstract, hypothesize, test, update.",
    next_test: "Expose current observations, abstractions, and hypotheses in the interface so the owner can correct them.",
    words: ["abstract", "rule", "verify", "hypothesis", "consciousness", "observe", "fact", "抽象", "规律", "验证", "思考", "假设", "意识", "观察", "事实"],
  },
]);

export function matchCognitivePatterns(text, patterns = COGNITIVE_PATTERNS) {
  const lower = normalizeText(text).toLowerCase();
  if (!lower) return [];
  return patterns.filter((pattern) =>
    pattern.words.some((word) => lower.includes(String(word).toLowerCase()))
  );
}

export function createCognitiveCycle({
  addObservation,
  upsertConcept,
  upsertHypothesis,
  upsertBelief,
  matchPatterns = matchCognitivePatterns,
} = {}) {
  for (const [name, fn] of Object.entries({ addObservation, upsertConcept, upsertHypothesis, upsertBelief })) {
    if (typeof fn !== "function") throw new Error(`createCognitiveCycle requires ${name}`);
  }

  return function cognitiveCycle({ content = "", source = "conversation", subject = "owner", metadata = {} } = {}) {
    const text = normalizeText(content);
    if (!text) return { observation: null, concepts: [], hypotheses: [], beliefs: [] };
    const patterns = matchPatterns(text);
    const observation = addObservation({
      subject,
      content: text,
      source,
      salience: patterns.length ? 0.72 : 0.42,
      metadata: {
        ...metadata,
        matched_patterns: patterns.map((pattern) => pattern.key),
      },
    });
    if (!observation) return { observation: null, concepts: [], hypotheses: [], beliefs: [] };
    const concepts = [];
    const hypotheses = [];
    const beliefs = [];
    for (const pattern of patterns) {
      concepts.push(upsertConcept(pattern, observation.id));
      hypotheses.push(upsertHypothesis(pattern, observation.id));
      beliefs.push(upsertBelief(pattern, observation.id));
    }
    return {
      observation,
      concepts: concepts.filter(Boolean),
      hypotheses: hypotheses.filter(Boolean),
      beliefs: beliefs.filter(Boolean),
    };
  };
}
