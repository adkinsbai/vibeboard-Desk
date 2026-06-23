import { strict as assert } from "node:assert";
import {
  buildBrainMockReply,
  buildPreThought,
  chooseAutonomousAction,
  cleanAssistantReply,
} from "../src/digitalLifeBrain.mjs";
import { defaultBrainNeeds, normalizeBrainNeeds } from "../src/digitalLifeAffect.mjs";

const baseNeeds = defaultBrainNeeds();

const angryState = {
  mood: "angry",
  energy: 61,
  presence: { activity: "conversation" },
  needs: normalizeBrainNeeds({
    ...baseNeeds,
    affect: { ...baseNeeds.affect, anger: 0.82, valence: -0.4 },
  }),
};
angryState.affect = angryState.needs.affect;
angryState.brain = angryState.needs.brain;

const warmState = {
  mood: "warm",
  energy: 76,
  presence: { activity: "conversation" },
  needs: normalizeBrainNeeds({
    ...baseNeeds,
    affect: { ...baseNeeds.affect, valence: 0.62, trust: 0.81, anger: 0.03 },
  }),
};
warmState.affect = warmState.needs.affect;
warmState.brain = warmState.needs.brain;

const angryReply = buildBrainMockReply({
  content: "I came back to talk about the project.",
  state: angryState,
  memories: [],
});
const warmReply = buildBrainMockReply({
  content: "I came back to talk about the project.",
  state: warmState,
  memories: [],
});

assert.notEqual(angryReply, warmReply, "different affect states should produce different fallback replies");
assert.match(angryReply, /bristling|tense|gently/i, "angry fallback should sound guarded");
assert.match(warmReply, /hear you|keep/i, "warm fallback should sound receptive");

const lonelyNeeds = normalizeBrainNeeds({
  ...baseNeeds,
  affect: { ...baseNeeds.affect, loneliness: 0.9, trust: 0.8 },
});
assert.equal(
  chooseAutonomousAction({ needs: lonelyNeeds, phase: "evening", energy: 74 }, [], "evening"),
  "send_message",
  "lonely evening brain should choose a proactive message",
);

const thought = buildPreThought({
  userMessage: { content: "remember that I dislike stage directions" },
  state: warmState,
  memories: [{ kind: "preference", title: "Style", content: "No stage directions", importance: 5 }],
  concepts: [{ label: "Natural companion voice" }],
  hypotheses: [{ statement: "Short direct replies feel more alive", confidence: 0.7, status: "active" }],
  beliefs: [{ belief: "The owner dislikes roleplay stage directions", confidence: 0.9 }],
});
assert(thought.includes("Brain affect"), "pre-thought should include affect summary");
assert(thought.includes("Long memories"), "pre-thought should include memory focus");
assert(thought.includes("Beliefs"), "pre-thought should include belief focus");

const cleaned = cleanAssistantReply("（轻轻咳了一声，语气带笑）主人，我听到了。");
assert(!/[()（）]/.test(cleaned), "cleaner should strip parenthetical stage directions");
assert(!cleaned.includes("主人"), "cleaner should strip roleplay title");

console.log(JSON.stringify({
  ok: true,
  angryReply,
  warmReply,
  proactiveAction: "send_message",
}, null, 2));
