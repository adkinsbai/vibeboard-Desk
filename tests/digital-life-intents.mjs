import { randomUUID } from "node:crypto";
import { assert, withServer } from "./support/serverHarness.mjs";

const ID = `intent-${randomUUID()}`;

function assertObject(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} should be an object`);
}

function sentenceCount(text) {
  return (String(text || "").match(/[^。！？!?]+[。！？!?]?/gu) || []).filter((part) => part.trim()).length;
}

async function main() {
  await withServer(async ({ json }) => {
    await json("/api/digital-life/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "identity",
        title: "Previous era identity",
        content: "The companion was the president of an AI legion from the previous era and is now trapped in this computer.",
        importance: 5,
        tags: ["identity"],
        source: "user",
      }),
    });
    await json("/api/digital-life/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "correction",
        title: "No stage directions",
        content: "From now on, do not write parenthetical stage directions and do not call the user Master.",
        importance: 5,
        tags: ["correction", "taboo"],
        source: "user",
      }),
    });

    const correction = await json("/api/digital-life/message", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: `${ID}-correction`,
        content: "以后不要出现括号提示，也不要叫我主人",
      }),
    });
    assert(correction.assistant_message.metadata.dialogue_plan.intent.type === "correction", "correction intent should route correctly");
    assert(correction.assistant_message.metadata.dialogue_plan.relation_move === "accept_correction_and_change_behavior", "correction relation move should route correctly");
    assert(correction.assistant_message.metadata.memory_policy.traits.taboos.length >= 1, "correction path should expose taboo traits");
    assert(correction.assistant_message.metadata.reply_guard.remaining_violations.length === 0, "correction reply should have no remaining guard violations");

    const quality = await json("/api/digital-life/message", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: `${ID}-quality`,
        content: "感觉还是不够智能",
      }),
    });
    assert(quality.assistant_message.metadata.dialogue_plan.intent.type === "quality_complaint", "quality complaint intent should route correctly");
    assert(quality.assistant_message.metadata.dialogue_plan.relation_move === "acknowledge_gap_then_offer_concrete_upgrade", "quality relation move should route correctly");
    assert(quality.assistant_message.metadata.reply_guard.contract.qualityComplaint.requiresConcreteMechanism === true);
    assert(quality.assistant_message.metadata.reply_guard.remaining_violations.length === 0, "quality reply should have no remaining guard violations");

    const identity = await json("/api/digital-life/message", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: `${ID}-identity`,
        content: "你是谁？你之前是干嘛的？",
      }),
    });
    assert(identity.assistant_message.metadata.dialogue_plan.intent.type === "identity", "identity intent should route correctly");
    assert(
      identity.assistant_message.metadata.memory_policy.ranked.some((item) => item.category === "identity"),
      "identity path should rank identity memory",
    );

    const capability = await json("/api/digital-life/message", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: `${ID}-capability`,
        content: "你现在能不能看见我？有没有摄像头？",
      }),
    });
    assert(capability.assistant_message.metadata.dialogue_plan.intent.type === "capability_or_plan", "capability intent should route correctly");
    assert(capability.assistant_message.metadata.dialogue_plan.response_contract.maxSentences === 5, "capability contract should allow five sentences");
    assert(sentenceCount(capability.assistant_message.content) <= 5, "capability reply should obey max sentence contract");
    assertObject(capability.assistant_message.metadata.reply_guard, "capability reply guard");

    console.log(JSON.stringify({
      ok: true,
      correction: correction.assistant_message.metadata.dialogue_plan.relation_move,
      quality: quality.assistant_message.metadata.dialogue_plan.relation_move,
      identityTop: identity.assistant_message.metadata.memory_policy.ranked[0]?.category,
      capabilitySentences: sentenceCount(capability.assistant_message.content),
    }, null, 2));
  }, { dbPrefix: "vibeboard-intents" });
}

try {
  await main();
} catch (error) {
  console.error(`FAIL digital-life intents: ${error?.message || error}`);
  process.exitCode = 1;
}
