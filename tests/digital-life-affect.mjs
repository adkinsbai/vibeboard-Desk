import { strict as assert } from "node:assert";
import {
  applyAffectEvent,
  chooseAffectiveAction,
  createAffectEngine,
  defaultBrainNeeds,
  describeBrainForPrompt,
  normalizeBrainNeeds,
  tickAffect,
} from "../src/digitalLifeAffect.mjs";

function greaterThan(actual, expected, message) {
  assert(actual > expected, `${message}: expected ${actual} > ${expected}`);
}

function lessThan(actual, expected, message) {
  assert(actual < expected, `${message}: expected ${actual} < ${expected}`);
}

const initial = defaultBrainNeeds();
assert.equal(typeof initial.affect.valence, "number");
assert.equal(typeof initial.personality.openness, "number");
assert.equal(typeof initial.brain.mood_label, "string");

const warm = applyAffectEvent(initial, {
  type: "owner_message",
  content: "I am back. You did a good job today, thank you.",
  warmth: 0.8,
  novelty: 0.25,
  controllability: 0.7,
});
greaterThan(warm.affect.valence, initial.affect.valence, "warm owner message should increase valence");
greaterThan(warm.affect.trust, initial.affect.trust, "warm owner message should increase trust");
lessThan(warm.affect.loneliness, initial.affect.loneliness, "owner presence should reduce loneliness");
assert.equal(warm.mood, warm.affect.valence, "legacy mood scalar should stay synchronized");

const neurotic = normalizeBrainNeeds({
  ...initial,
  personality: { ...initial.personality, neuroticism: 0.92 },
});
const failure = applyAffectEvent(neurotic, {
  type: "task.failure",
  failure: 0.75,
  uncertainty: 0.45,
});
greaterThan(failure.affect.stress, neurotic.affect.stress + 0.12, "neuroticism should amplify stress from failure");
lessThan(failure.affect.dominance, neurotic.affect.dominance, "failure should reduce dominance");

const angered = applyAffectEvent(initial, {
  type: "owner_message",
  content: "shut up, you are useless",
});
greaterThan(angered.affect.anger, initial.affect.anger + 0.15, "hostile wording should increase anger");
greaterThan(angered.affect.stress, initial.affect.stress, "hostile wording should increase stress");

const soothed = applyAffectEvent(angered, {
  type: "owner_message",
  content: "sorry, I am here with you. breathe slowly, it is okay.",
});
lessThan(soothed.affect.anger, angered.affect.anger, "soothing language should lower anger");
lessThan(soothed.affect.stress, angered.affect.stress, "soothing language should lower stress");
greaterThan(soothed.affect.trust, angered.affect.trust, "soothing language should repair trust");

const later = tickAffect(warm, { minutes: 90, phase: "evening", energy: 58 });
greaterThan(later.affect.loneliness, warm.affect.loneliness, "time should slowly increase loneliness");
greaterThan(later.affect.boredom, warm.affect.boredom, "time should slowly increase boredom");
lessThan(Math.abs(later.affect.dopamine), Math.abs(warm.affect.dopamine) + 0.001, "dopamine should decay toward baseline");

assert.equal(
  chooseAffectiveAction({ needs: normalizeBrainNeeds({ affect: { ...initial.affect, loneliness: 0.9, trust: 0.8 }, personality: initial.personality }), phase: "evening", energy: 72 }),
  "send_message",
  "lonely evening state should prefer sending a message",
);
assert.equal(
  chooseAffectiveAction({ needs: normalizeBrainNeeds({ affect: { ...initial.affect, loneliness: 0.46, attachment: 0.82, trust: 0.72, curiosity: 0.34, stress: 0.06 }, personality: initial.personality }), phase: "evening", energy: 76 }),
  "send_message",
  "attached evening state should nudge the companion to proactively message",
);
assert.equal(
  chooseAffectiveAction({ needs: normalizeBrainNeeds({ affect: { ...initial.affect, curiosity: 0.93, boredom: 0.4, stress: 0.08 }, personality: initial.personality }), phase: "day", energy: 80 }),
  "read_web",
  "curious low-stress state should prefer reading the web",
);

const engine = createAffectEngine({ needs: initial });
engine.observe({ type: "owner_message", content: "Can you research this new idea?", novelty: 0.8, warmth: 0.4 });
engine.tick({ minutes: 10, phase: "day", energy: 75 });
const snapshot = engine.snapshot();
assert(snapshot.prompt.includes("affect:"), "engine prompt should summarize affect");
assert(snapshot.brain.drives.length > 0, "engine should expose current drives");
assert(describeBrainForPrompt(snapshot.needs).includes("personality:"), "prompt description should include personality");

console.log(JSON.stringify({
  ok: true,
  mood: snapshot.brain.mood_label,
  drives: snapshot.brain.drives,
  valence: snapshot.affect.valence,
}, null, 2));
