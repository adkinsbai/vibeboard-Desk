import { strict as assert } from "node:assert";
import {
  autonomousCandidates,
  lifePhaseFor,
  phaseMessage,
  planAutonomousAction,
  shouldHoldAutonomousMessage,
} from "../src/digitalLifeAutonomy.mjs";

assert.equal(lifePhaseFor(new Date("2026-06-19T02:00:00")), "sleep");
assert.equal(lifePhaseFor(new Date("2026-06-19T07:30:00")), "wake");
assert.equal(lifePhaseFor(new Date("2026-06-19T14:00:00")), "day");
assert.equal(lifePhaseFor(new Date("2026-06-19T20:00:00")), "evening");
assert.equal(lifePhaseFor(new Date("2026-06-19T23:30:00")), "night");

const recentSend = [{ action_type: "send_message" }];
assert.equal(shouldHoldAutonomousMessage(recentSend, "evening"), true, "recent proactive message should hold further evening messages");
assert.equal(shouldHoldAutonomousMessage(recentSend, "day"), false, "daytime should not hold messages by this rule");
assert(!autonomousCandidates([], "evening").includes("do_nothing"), "empty recent actions should not restrict candidates");
assert(autonomousCandidates(recentSend, "evening").includes("do_nothing"), "recent message should restrict candidates");

const state = { mood: "curious" };
const sleep = planAutonomousAction("sleep", { state, body: { phase: "night" } });
assert.equal(sleep.output.summary, "Rested and lowered stress.");
assert(sleep.state_delta.stress < 0, "sleep should lower stress");

const diary = planAutonomousAction("write_diary", { state, body: { phase: "evening" } });
assert.equal(diary.journal.entry_type, "autonomous");
assert.equal(diary.journal.title, "Heartbeat note");
assert(diary.reward > 0, "diary action should have positive reward");

const message = planAutonomousAction("send_message", { state, body: { phase: "evening" } });
assert.equal(message.message.conversation_id, "digital-life-page");
assert.equal(message.message.role, "assistant");
assert(message.message.content.includes("back soon") || message.message.content.length > 0, "message action should include content");

const customMessage = planAutonomousAction("send_message", { state, body: { phase: "day", message: "custom ping" } });
assert.equal(customMessage.message.content, "custom ping");

assert(phaseMessage("sleep", state).includes("low-energy"), "sleep phase message should communicate low energy");
assert.equal(planAutonomousAction("unknown").reward, 0, "unknown action should be neutral");

console.log(JSON.stringify({
  ok: true,
  heldCandidates: autonomousCandidates(recentSend, "evening"),
  message: message.message.content,
}, null, 2));
