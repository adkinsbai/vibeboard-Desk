import { strict as assert } from "node:assert";
import {
  buildDialoguePlan,
  inferDialogueIntent,
  selectDialogueContext,
} from "../src/digitalLifeDialogue.mjs";
import {
  buildBrainMockReply,
  buildDigitalLifeSystemPrompt,
  buildPreThought,
} from "../src/digitalLifeBrain.mjs";
import { defaultBrainNeeds, normalizeBrainNeeds } from "../src/digitalLifeAffect.mjs";

const needs = normalizeBrainNeeds(defaultBrainNeeds());
const state = {
  mood: "calm",
  energy: 72,
  presence: { activity: "conversation" },
  needs,
  affect: needs.affect,
  brain: needs.brain,
};

const complaint = inferDialogueIntent("感觉还是不够智能");
assert.equal(complaint.type, "quality_complaint", "quality complaint should be a first-class intent");

const memories = [
  {
    kind: "preference",
    title: "Style correction",
    content: "以后不要出现括号里的舞台提示，也不要叫我主人。",
    importance: 5,
  },
  {
    kind: "note",
    title: "Voice",
    content: "用户关心语音自然度。",
    importance: 3,
  },
];

const context = selectDialogueContext({
  text: "你又出现括号提示了，以后不要这样",
  memories,
  beliefs: [{ belief: "The owner dislikes roleplay stage directions", confidence: 0.92 }],
});
assert.equal(context.memories[0].title, "Style correction", "dialogue context should rank directly relevant memories first");
assert(context.beliefs.length >= 1, "dialogue context should include relevant beliefs");

const plan = buildDialoguePlan({
  userMessage: { content: "感觉还是不够智能" },
  state,
  memories,
  cognitiveContext: {
    beliefs: [{ belief: "When criticized, acknowledge the gap and name one concrete change.", confidence: 0.8 }],
    concepts: [],
    hypotheses: [],
  },
  recentMessages: [],
});
assert.equal(plan.intent.type, "quality_complaint", "plan should preserve inferred intent");
assert.equal(plan.relationMove, "acknowledge_gap_then_offer_concrete_upgrade");
assert(plan.affectEvent.failure > 0, "quality complaint should affect the internal brain as a failure/repair event");

const reply = buildBrainMockReply({
  content: "感觉还是不够智能",
  state,
  memories,
  dialoguePlan: plan,
});
assert.match(reply, /不够像一个会判断局面的生命|判断你是在抱怨/, "fallback reply should name a concrete intelligence upgrade");
assert(!/[()（）]/.test(reply), "fallback reply should not use stage directions");

const thought = buildPreThought({
  userMessage: { content: "感觉还是不够智能" },
  state,
  memories,
  dialoguePlan: plan,
});
assert(thought.includes("Dialogue plan"), "pre-thought should include the dialogue plan");
assert(thought.includes("quality_complaint"), "pre-thought should expose intent internally for verification");

const systemPrompt = buildDigitalLifeSystemPrompt({
  state,
  memories,
  journal: [],
  preThought: thought,
  dialoguePlan: plan,
});
assert(systemPrompt.includes("concrete internal mechanism"), "system prompt should force concrete mechanism changes for intelligence criticism");
assert(systemPrompt.includes("intent classification"), "system prompt should name mechanism examples");

console.log(JSON.stringify({
  ok: true,
  intent: plan.intent.type,
  relationMove: plan.relationMove,
  reply,
}, null, 2));
