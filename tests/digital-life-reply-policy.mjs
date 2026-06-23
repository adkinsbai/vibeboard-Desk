import { strict as assert } from "node:assert";
import {
  buildReplyContract,
  detectReplyViolations,
  enforceReplyContract,
  repairAssistantReply,
  sanitizeAssistantReply,
} from "../src/digitalLifeReplyPolicy.mjs";

const qualityPlan = {
  intent: { type: "quality_complaint", confidence: 0.92 },
  relationMove: "acknowledge_gap_then_offer_concrete_upgrade",
  responseContract: {
    maxSentences: 3,
    mustAvoid: ["stage directions", "parenthetical tone", "roleplay titles"],
    style: "specific and alive",
  },
};

const contract = buildReplyContract({
  dialoguePlan: qualityPlan,
  state: { energy: 70, affect: { anger: 0.1 } },
});

assert.equal(contract.intentType, "quality_complaint", "contract should preserve intent");
assert.equal(contract.maxSentences, 3, "contract should use dialogue max sentence bound");
assert(contract.mustAvoid.includes("roleplay titles"), "contract should hard-code roleplay title avoidance");
assert(contract.qualityComplaint.requiresConcreteMechanism, "quality complaints should require concrete mechanisms");

const dirty = "（轻轻清了清不存在的嗓子，语气带笑）主人，我会继续优化。以后会更智能。请相信我。";
const dirtyViolations = detectReplyViolations(dirty, contract).map((item) => item.code);
assert(dirtyViolations.includes("STAGE_DIRECTION"), "stage directions should be detected");
assert(dirtyViolations.includes("ROLEPLAY_TITLE"), "roleplay title should be detected");
assert(dirtyViolations.includes("VAGUE_QUALITY_COMPLAINT"), "vague quality complaint roadmap should be detected");

const sanitized = sanitizeAssistantReply(dirty, contract);
assert(!/[()（）]/.test(sanitized), "sanitizer should strip parenthetical stage directions");
assert(!/主人|Master|owner|老板/i.test(sanitized), "sanitizer should strip roleplay titles");
assert(sentenceCount(sanitized) <= contract.maxSentences, "sanitizer should enforce max sentences");

const longReply = "第一句。第二句。第三句。第四句。第五句。";
const limited = sanitizeAssistantReply(longReply, contract);
assert.equal(limited, "第一句。第二句。第三句。", "sanitizer should keep only the allowed number of sentences");
assert(detectReplyViolations(longReply, contract).some((item) => item.code === "TOO_MANY_SENTENCES"), "detector should report sentence overflow");

const repaired = repairAssistantReply("我会继续优化，以后会更智能。", contract);
assert.match(repaired, /意图分类|记忆排序|情绪评估|回复守卫/, "quality complaint repair should name concrete mechanisms");
assert(!detectReplyViolations(repaired, contract).length, "deterministic repair should satisfy the contract");

const enforced = enforceReplyContract(dirty, contract);
assert.equal(enforced.repaired, true, "enforcer should mark dirty replies as repaired");
assert.match(enforced.reply, /意图分类|记忆排序|情绪评估|回复守卫/, "enforcer should return deterministic concrete repair");
assert(!detectReplyViolations(enforced.reply, contract).length, "enforced reply should have no remaining violations");

const correctionContract = buildReplyContract({
  dialoguePlan: {
    intent: { type: "correction" },
    responseContract: { maxSentences: 4 },
  },
  state: { energy: 20 },
});
assert.equal(correctionContract.maxSentences, 2, "low energy should tighten the sentence bound");

console.log(JSON.stringify({
  ok: true,
  exports: [
    "buildReplyContract",
    "sanitizeAssistantReply",
    "detectReplyViolations",
    "repairAssistantReply",
    "enforceReplyContract",
  ],
  repaired: enforced.reply,
}, null, 2));

function sentenceCount(text) {
  return (String(text || "").match(/[^。！？!?。]+[。！？!?]?/gu) || []).filter((part) => part.trim()).length;
}
