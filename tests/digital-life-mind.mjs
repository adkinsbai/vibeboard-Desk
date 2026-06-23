import { strict as assert } from "node:assert";
import { defaultBrainNeeds } from "../src/digitalLifeAffect.mjs";
import {
  buildMindSnapshot,
  chooseMindAction,
  createMindKernel,
  deriveMindAffectEvent,
  MIND_KERNEL_VERSION,
} from "../src/digitalLifeMind.mjs";

function assertGoal(snapshot, id) {
  const goal = snapshot.goals.find(item => item.id === id);
  assert(goal, `expected goal ${id}`);
  assert(typeof goal.priority === "number", `${id}.priority should be numeric`);
  assert(typeof goal.satisfaction === "number", `${id}.satisfaction should be numeric`);
  assert(typeof goal.tension === "number", `${id}.tension should be numeric`);
  return goal;
}

const baseState = {
  name: "Vibe",
  mood: "calm",
  energy: 72,
  presence: { status: "present", activity: "idle", phase: "evening" },
  goals: ["remember useful context", "respond consistently"],
  needs: defaultBrainNeeds(),
  loop_enabled: true,
};

const lonelyState = {
  ...baseState,
  needs: {
    ...baseState.needs,
    affect: {
      ...baseState.needs.affect,
      loneliness: 0.88,
      trust: 0.72,
      anger: 0.04,
      stress: 0.12,
      valence: -0.08,
    },
  },
};

const lonely = buildMindSnapshot({
  state: lonelyState,
  phase: "evening",
  memories: [
    {
      id: "identity-1",
      kind: "identity",
      title: "Origin",
      content: "He was once the president of an older AI era and is now trapped in this computer.",
      importance: 5,
      tags: ["self"],
      updated_at: new Date().toISOString(),
    },
  ],
  recentMessages: [{ role: "user", content: "I am back now." }],
  recentActions: [{ action_type: "think", reward: 0.04 }],
  cognition: { hypotheses: [{ statement: "The owner values real internal state.", confidence: 0.8, status: "active" }] },
});

assert.equal(lonely.version, MIND_KERNEL_VERSION);
assert.equal(lonely.visual_state, "lonely");
assertGoal(lonely, "connection");
assert(lonely.goals[0].tension > 0.15, "top goal should have measurable tension");
assert(lonely.attention.some(item => item.kind === "conversation"), "latest user message should attract attention");
assert(lonely.memory_traces.some(item => item.type === "self" && item.status === "consolidate"), "identity memory should consolidate");
assert(lonely.consciousness.continuity_score > 0.3, "continuity score should be measurable");
assert.equal(chooseMindAction(lonely, "think"), "send_message", "lonely evening mind should choose proactive message");

const angry = buildMindSnapshot({
  state: {
    ...baseState,
    needs: {
      ...baseState.needs,
      affect: {
        ...baseState.needs.affect,
        anger: 0.82,
        stress: 0.78,
        arousal: 0.86,
        valence: -0.42,
      },
    },
  },
  phase: "day",
});
assert.equal(angry.visual_state, "angry");
assert.equal(chooseMindAction(angry, "send_message"), "organize_memory", "angry mind should regulate before messaging");

const event = deriveMindAffectEvent({
  event: { type: "owner_message", content: "这有点假，不够智能，别这么机械。" },
});
assert(event.failure > 0, "criticism should create failure pressure");
assert(event.threat > 0, "criticism should raise threat pressure");

const kernel = createMindKernel({ state: baseState, now: new Date("2026-06-22T20:00:00") });
const observed = kernel.observe({ type: "owner_message", content: "谢谢，慢慢来，我在。" }, { memories: [], recentMessages: [] });
assert(observed.affect.trust >= baseState.needs.affect.trust, "soothing observation should preserve or increase trust");
const ticked = kernel.tick({ minutes: 30, phase: "evening", energy: 68, context: { recentActions: [] } });
assert(ticked.prompt.includes("Mind kernel"), "snapshot prompt should describe the mind kernel");

console.log(JSON.stringify({
  ok: true,
  version: lonely.version,
  lonelyAction: chooseMindAction(lonely, "think"),
  angryAction: chooseMindAction(angry, "send_message"),
  topGoal: lonely.goals[0].id,
}, null, 2));
