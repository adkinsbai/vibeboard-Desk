import { strict as assert } from "node:assert";
import {
  createCognitiveCycle,
  matchCognitivePatterns,
} from "../src/digitalLifeCognition.mjs";

const voicePatterns = matchCognitivePatterns("这个文字转语音的发音和断句听起来还是不自然，TTS rhythm needs work.");
assert(voicePatterns.some((pattern) => pattern.key === "voice_naturalness"), "voice language should match voice_naturalness");

const reasoningPatterns = matchCognitivePatterns("我希望你能观察事实，抽象规律，提出假设，然后验证。");
assert(reasoningPatterns.some((pattern) => pattern.key === "abstract_reasoning_interest"), "reasoning language should match abstraction pattern");

const written = {
  observations: [],
  concepts: [],
  hypotheses: [],
  beliefs: [],
};

const cycle = createCognitiveCycle({
  addObservation(input) {
    const observation = { id: `obs-${written.observations.length + 1}`, ...input };
    written.observations.push(observation);
    return observation;
  },
  upsertConcept(pattern, evidenceId) {
    const concept = { id: `concept-${pattern.key}`, label: pattern.label, evidenceId };
    written.concepts.push(concept);
    return concept;
  },
  upsertHypothesis(pattern, evidenceId) {
    const hypothesis = { id: `hyp-${pattern.key}`, statement: pattern.hypothesis, status: "active", confidence: 0.4, evidenceId };
    written.hypotheses.push(hypothesis);
    return hypothesis;
  },
  upsertBelief(pattern, evidenceId) {
    const belief = { id: `belief-${pattern.key}`, belief: pattern.summary, confidence: 0.4, evidenceId };
    written.beliefs.push(belief);
    return belief;
  },
});

const result = cycle({
  content: "以后记住，我更喜欢抽象推理，也在意界面不要刷新到丢消息。",
  source: "test",
  subject: "owner",
  metadata: { message_id: "m1" },
});

assert(result.observation, "cycle should create an observation");
assert(result.concepts.length >= 2, "cycle should create matched concepts");
assert(result.hypotheses.every((item) => item.status === "active"), "cycle should create active hypotheses");
assert(result.beliefs.length === result.concepts.length, "cycle should create matching beliefs");
assert.deepEqual(
  result.observation.metadata.matched_patterns,
  result.concepts.map((concept) => concept.id.replace("concept-", "")),
  "observation metadata should record matched pattern keys",
);

const empty = cycle({ content: "   " });
assert.equal(empty.observation, null, "empty content should not create observation");

console.log(JSON.stringify({
  ok: true,
  matched: result.observation.metadata.matched_patterns,
}, null, 2));
