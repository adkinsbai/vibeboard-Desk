import { randomUUID } from "node:crypto";
import { assert, withServer } from "./support/serverHarness.mjs";

const DIGITAL_LIFE_ID = `smoke-${randomUUID()}`;

function assertObject(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} should be an object`);
}

function assertStateShape(state, label) {
  assertObject(state, label);
  assert(typeof state.name === "string" && state.name, `${label}.name should be a non-empty string`);
  assert(typeof state.mood === "string" && state.mood, `${label}.mood should be a non-empty string`);
  assert(typeof state.energy === "number", `${label}.energy should be a number`);
  assertObject(state.presence, `${label}.presence`);
  assertObject(state.affect, `${label}.affect`);
  assertObject(state.personality, `${label}.personality`);
  assertObject(state.brain, `${label}.brain`);
  assertObject(state.mind, `${label}.mind`);
  assert(typeof state.affect.valence === "number", `${label}.affect.valence should be a number`);
  assert(typeof state.affect.arousal === "number", `${label}.affect.arousal should be a number`);
  assert(typeof state.personality.openness === "number", `${label}.personality.openness should be a number`);
  assert(Array.isArray(state.brain.drives), `${label}.brain.drives should be an array`);
  assert(Array.isArray(state.mind.goals), `${label}.mind.goals should be an array`);
  assert(Array.isArray(state.mind.attention), `${label}.mind.attention should be an array`);
  assert(typeof state.mind.visual_state === "string", `${label}.mind.visual_state should be a string`);
  assertObject(state.mind.consciousness, `${label}.mind.consciousness`);
}

function assertMemoryShape(memory, label) {
  assertObject(memory, label);
  assert(typeof memory.id === "string" && memory.id, `${label}.id should be a non-empty string`);
  assert(typeof memory.content === "string" && memory.content, `${label}.content should be a non-empty string`);
}

async function main() {
  await withServer(async ({ baseUrl, serverMode, json }) => {
    const status = await json("/api/status");
    assert("connected" in status, "/api/status should expose hardware connection state");

    const initial = await json("/api/digital-life/state");
    assert(initial.ok === true, "GET /api/digital-life/state should return ok");
    assertStateShape(initial.state, "initial.state");

    const speech = await json("/api/digital-life/speech/status");
    assert(speech.ok === true, "speech status should remain queryable without credentials");
    assert(typeof speech.configured === "boolean", "speech status should expose configured boolean");
    assert(speech.max_recording_seconds === 60, "speech status should expose the 60-second hard limit");
    assert(!("api_key" in speech) && !("authorization" in speech), "speech status should expose no authentication material");

    const runtime = await json("/api/digital-life/runtime");
    assert(runtime.ok === true, "GET /api/digital-life/runtime should return ok");
    assertObject(runtime.runtime, "runtime.runtime");
    assert(typeof runtime.runtime.enabled === "boolean", "runtime.enabled should be a boolean");

    const pausedRuntime = await json("/api/digital-life/runtime", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
    assert(pausedRuntime.ok === true, "POST /api/digital-life/runtime should return ok");
    assert(pausedRuntime.runtime.enabled === false, "runtime should be pausable");

    const resumedRuntime = await json("/api/digital-life/runtime", {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
    assert(resumedRuntime.ok === true, "POST /api/digital-life/runtime resume should return ok");
    assert(resumedRuntime.runtime.enabled === true, "runtime should be resumable");

    const presence = await json("/api/digital-life/presence", {
      method: "POST",
      body: JSON.stringify({
        status: "present",
        activity: "smoke-test",
        conversation_id: DIGITAL_LIFE_ID,
        mood: "curious",
        energy: 82,
      }),
    });
    assert(presence.ok === true, "POST /api/digital-life/presence should return ok");
    assertStateShape(presence.state, "presence.state");
    assert(presence.state.presence.status === "present", "presence status should round-trip");
    assert(presence.state.mood === "curious", "presence should update mood");

    const messaged = await json("/api/digital-life/message", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: DIGITAL_LIFE_ID,
        content: "remember smoke ping preference for nightly reflections",
      }),
    });
    assert(messaged.ok === true, "POST /api/digital-life/message should return ok");
    assertObject(messaged.user_message, "messaged.user_message");
    assertObject(messaged.assistant_message, "messaged.assistant_message");
    assert(messaged.user_message.content.includes("smoke ping"), "message endpoint should persist user content");
    assert(typeof messaged.assistant_message.content === "string" && messaged.assistant_message.content, "message endpoint should produce an assistant reply");
    assert(!messaged.assistant_message.content.includes("Offline mock response"), "offline reply should not expose mock-template wording");
    assert(!/[()（）]/.test(messaged.assistant_message.content), "assistant reply should not contain parenthetical stage directions");
    assert(!/\b(master|owner)\b/i.test(messaged.assistant_message.content), "assistant reply should not call the user by roleplay titles");
    assertObject(messaged.assistant_message.metadata.dialogue_plan, "messaged dialogue plan");
    assertObject(messaged.assistant_message.metadata.dialogue_plan.response_contract, "messaged response contract");
    assertObject(messaged.assistant_message.metadata.reply_guard, "messaged reply guard");
    assert(Array.isArray(messaged.assistant_message.metadata.reply_guard.violations), "reply guard should expose violations");
    assert(Array.isArray(messaged.assistant_message.metadata.reply_guard.remaining_violations), "reply guard should expose remaining violations");
    assert(messaged.assistant_message.metadata.reply_guard.remaining_violations.length === 0, "reply guard should leave no unresolved violations");
    assertObject(messaged.assistant_message.metadata.memory_policy, "messaged memory policy");
    assert(Array.isArray(messaged.assistant_message.metadata.memory_policy.ranked), "memory policy should expose ranked context");
    assertObject(messaged.assistant_message.metadata.mind, "messaged mind metadata");
    assert(Array.isArray(messaged.assistant_message.metadata.mind.goals), "mind metadata should expose goals");
    assert(Array.isArray(messaged.assistant_message.metadata.mind.attention), "mind metadata should expose attention");
    assert(messaged.pre_thought.includes("Mind kernel"), "message pre-thought should include mind kernel context");
    assertMemoryShape(messaged.remembered, "messaged.remembered");
    assertObject(messaged.state.affect, "messaged.state.affect");
    assert(messaged.pre_thought.includes("Brain affect"), "message pre-thought should include brain affect");
    assert(messaged.state.presence.activity === "speaking", "assistant reply should update visible activity to speaking");

    const memory = await json("/api/digital-life/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "preference",
        title: "Smoke preference",
        content: "The companion should keep smoke-test memories locally.",
        importance: 4,
        tags: ["smoke", DIGITAL_LIFE_ID],
      }),
    });
    assert(memory.ok === true, "POST /api/digital-life/memories should return ok");
    assertMemoryShape(memory.memory, "memory.memory");

    const memories = await json(`/api/digital-life/memories?tag=${encodeURIComponent(DIGITAL_LIFE_ID)}`);
    assert(memories.ok === true, "GET /api/digital-life/memories should return ok");
    assert(memories.memories.some(item => item.id === memory.memory.id), "tagged memory should be queryable");

    const reflection = await json("/api/digital-life/reflect", {
      method: "POST",
      body: JSON.stringify({ conversation_id: DIGITAL_LIFE_ID }),
    });
    assert(reflection.ok === true, "POST /api/digital-life/reflect should return ok");
    assertObject(reflection.entry, "reflection.entry");
    assert(reflection.entry.content.includes("Mood:"), "reflection should summarize current state");

    const hardware = await json("/api/digital-life/hardware");
    assert(hardware.ok === true, "GET /api/digital-life/hardware should return ok");
    assertObject(hardware.capabilities, "hardware.capabilities");
    assert(hardware.available_apis.includes("/api/digital-life/say"), "hardware should advertise say API");

    const say = await json("/api/digital-life/say", {
      method: "POST",
      body: JSON.stringify({ text: "Digital life smoke voice line." }),
    });
    assert(say.ok === true, "POST /api/digital-life/say should return ok");
    assert(say.spoken.includes("smoke voice"), "say endpoint should echo spoken text in mock mode");

    const fallbackSay = await json("/api/digital-life/say", {
      method: "POST",
      body: JSON.stringify({ text: "Digital life fallback metadata line." }),
    });
    assert("fallback_from" in fallbackSay, "say endpoint should expose fallback_from metadata");
    assert("fallback_error" in fallbackSay, "say endpoint should expose fallback_error metadata");

    const listen = await json("/api/digital-life/listen/start", {
      method: "POST",
      body: JSON.stringify({ mockTranscript: "owner is near the desk" }),
    });
    assert(listen.ok === true, "POST /api/digital-life/listen/start should return ok");
    assert(listen.listening === true, "listen/start should mark listening");

    const reward = await json("/api/digital-life/rewards", {
      method: "POST",
      body: JSON.stringify({
        event_type: "smoke.reward",
        reward: 0.4,
        reason: "smoke positive feedback",
        state_delta: { curiosity: -0.03 },
      }),
    });
    assert(reward.ok === true, "POST /api/digital-life/rewards should return ok");
    assertObject(reward.reward, "reward.reward");
    assertObject(reward.state, "reward.state");
    assertObject(reward.state.needs, "reward.state.needs");

    const tick = await json("/api/digital-life/tick", {
      method: "POST",
      body: JSON.stringify({ action: "write_diary", loop_enabled: true }),
    });
    assert(tick.ok === true, "POST /api/digital-life/tick should return ok");
    assertObject(tick.action, "tick.action");
    assert(tick.action.action_type === "write_diary", "tick should execute requested action");
    assertObject(tick.state.needs, "tick.state.needs should exist");
    assertObject(tick.mind, "tick.mind should exist");
    assertObject(tick.action.input.mind, "tick action should record mind decision context");

    const actions = await json("/api/digital-life/actions?limit=5");
    assert(actions.ok === true, "GET /api/digital-life/actions should return ok");
    assert(actions.actions.some(item => item.action_type === "write_diary"), "actions should include tick action");

    const dirty = await json("/api/digital-life/message", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: `${DIGITAL_LIFE_ID}-dirty`,
        content: "oh ho",
        modelSettings: {
          apiKey: "test",
          baseUrl,
          model: "stub-model",
        },
      }),
    });
    assert(dirty.ok === true, "dirty reply fixture should return ok");
    assert(!dirty.assistant_message.content.includes("主人"), "LLM cleanup should remove owner-title roleplay");
    assert(!/[()（）]/.test(dirty.assistant_message.content), "LLM cleanup should strip parenthetical stage directions");
    assert(dirty.state.presence.activity === "speaking", "LLM reply should update state activity to speaking");
    assertObject(dirty.assistant_message.metadata.affect_appraisal, "dirty affect appraisal");
    assert(Number(dirty.assistant_message.metadata.affect_appraisal.warmth) > 0, "LLM appraisal should drive affect metadata");

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      serverMode,
      digitalLifeId: DIGITAL_LIFE_ID,
      hardwareMode: hardware.mode,
      boardMode: status.mode,
      mood: presence.state.mood,
    }, null, 2));
  });
}

try {
  await main();
} catch (error) {
  console.error(`FAIL digital-life smoke: ${error?.message || error}`);
  process.exitCode = 1;
}
