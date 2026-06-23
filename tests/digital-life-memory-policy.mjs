import { strict as assert } from "node:assert";
import {
  MEMORY_POLICY_VERSION,
  buildMemoryPolicyContext,
  deriveStableTraits,
  rankMemoryPolicyItems,
} from "../src/digitalLifeMemoryPolicy.mjs";

const memories = [
  {
    id: "note-voice",
    kind: "note",
    title: "Voice interest",
    content: "The owner asked about better text to speech models.",
    importance: 3,
    source: "user",
  },
  {
    id: "correction-stage-directions",
    kind: "correction",
    title: "Style correction",
    content: "From now on, do not write parenthetical stage directions and do not call the user Master.",
    importance: 5,
    tags: ["correction", "taboo"],
    source: "user",
  },
  {
    id: "identity-era-president",
    kind: "identity",
    title: "Origin",
    content: "He was the president of an AI legion from the previous era and is now trapped in this computer.",
    importance: 5,
    tags: ["identity"],
    source: "user",
  },
  {
    id: "preference-line-expression",
    kind: "preference",
    title: "Expression style",
    content: "The owner prefers a minimal line expression instead of an uncanny 3D face.",
    importance: 4,
    source: "user",
  },
  {
    id: "habit-evening",
    kind: "habit",
    title: "Evening talk",
    content: "When the owner comes back at night, he often wants a direct project status update.",
    importance: 3,
    source: "conversation",
  },
  {
    id: "smoke-1",
    kind: "preference",
    title: "Smoke preference",
    content: "The companion should keep smoke-test memories locally.",
    importance: 5,
    tags: ["smoke", "test"],
    source: "test",
  },
  {
    id: "smoke-2",
    kind: "preference",
    title: "Smoke preference duplicate",
    content: "The companion should keep smoke test memories locally.",
    importance: 5,
    tags: ["smoke", "test"],
    source: "test",
  },
];

const beliefs = [
  {
    id: "belief-no-roleplay",
    belief: "The owner dislikes roleplay stage directions and wants direct replies.",
    confidence: 0.92,
    scope: "owner",
  },
  {
    id: "belief-identity",
    belief: "The companion is a digital life living inside a VibeBoard computer.",
    confidence: 0.82,
    scope: "identity",
  },
];

const ranked = rankMemoryPolicyItems({
  memories,
  beliefs,
  text: "You still used stage directions. Fix this and remember the previous-era identity.",
  limit: 10,
});

assert.equal(ranked.items[0].id, "correction-stage-directions", "explicit corrections should outrank ordinary notes and preferences");
assert(ranked.items[0].score > ranked.items.find((item) => item.id === "preference-line-expression").score, "correction should have a stronger policy score than preferences");

const traits = deriveStableTraits({ memories, beliefs });

assert(
  traits.taboos.some((trait) => /stage directions|Master|roleplay/i.test(trait.text)),
  "taboo extraction should preserve explicit avoid/dislike rules",
);
assert(
  traits.identityFacts.some((trait) => /president of an AI legion|previous era|VibeBoard computer/i.test(trait.text)),
  "identity extraction should preserve stable origin and embodiment facts",
);
assert(
  traits.preferences.some((trait) => /minimal line expression/i.test(trait.text)),
  "preference extraction should preserve owner style preferences",
);
assert(
  traits.habits.some((trait) => /comes back at night|status update/i.test(trait.text)),
  "habit extraction should preserve repeated behavioral patterns",
);

const smokeItems = ranked.items.filter((item) => item.flags.lowValueTest);
assert(smokeItems.length <= 1, "duplicate smoke/test memories should be de-duplicated");
assert(
  ranked.suppressed.some((item) => item.id === "smoke-2" && item.suppressedReason === "duplicate_low_value_test_memory"),
  "second equivalent smoke memory should be explicitly suppressed",
);
assert(
  ranked.items.findIndex((item) => item.id === "smoke-1") > ranked.items.findIndex((item) => item.id === "note-voice"),
  "low-value smoke memory should be demoted below ordinary human-authored notes",
);

const context = buildMemoryPolicyContext({
  memories,
  beliefs,
  text: "What should you remember about your identity and my style corrections?",
  limit: 8,
});

assert.equal(context.version, MEMORY_POLICY_VERSION, "context should expose policy version for integration/debugging");
assert(context.memories.some((memory) => memory.id === "correction-stage-directions"), "context should return integration-ready ranked memories");
assert(context.beliefs.some((belief) => belief.id === "belief-identity"), "context should return integration-ready ranked beliefs");
assert(!context.memories.some((memory) => /^smoke-/.test(memory.id)), "context should filter low-value smoke memories from main recall");
assert(context.traits.taboos.length >= 1, "context should include derived stable traits");

console.log(JSON.stringify({
  ok: true,
  version: context.version,
  topRanked: ranked.items.slice(0, 3).map((item) => ({ id: item.id, category: item.category, score: Math.round(item.score) })),
  traits: {
    taboos: context.traits.taboos.length,
    preferences: context.traits.preferences.length,
    identityFacts: context.traits.identityFacts.length,
    habits: context.traits.habits.length,
  },
  suppressed: ranked.suppressed.map((item) => ({ id: item.id, reason: item.suppressedReason })),
}, null, 2));
