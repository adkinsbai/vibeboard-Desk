import assert from "node:assert/strict";
import { createDigitalLifeSpeechRoutes } from "../src/digitalLifeSpeechRoutes.mjs";

const SECRET_VALUES = ["route-app-id", "route-api-key", "route-api-secret"];
const calls = [];
const speechClient = {
  status() {
    return { configured: true, transcription: true, synthesis: true, provider: "iflytek" };
  },
  async transcribe(input) {
    calls.push({ type: "transcribe", input });
    return { transcript: "今天感觉不错", durationMs: 120 };
  },
  async synthesize(input) {
    calls.push({ type: "synthesize", input });
    return { audio: Buffer.from("mp3-data"), mime: "audio/mpeg", encoding: "lame" };
  },
};

let nextBody = {};
const speechRoutes = createDigitalLifeSpeechRoutes({
  readBody: async () => nextBody,
  json: (res, status, body) => {
    res.statusCode = status;
    res.body = body;
  },
  speechClient,
});

async function request(method, pathname, body = {}) {
  nextBody = body;
  const res = {};
  const handled = await speechRoutes.handle({ method }, res, new URL(`http://localhost${pathname}`));
  return { handled, status: res.statusCode, body: res.body };
}

function assertNoSecrets(value, label) {
  const serialized = JSON.stringify(value);
  for (const secret of SECRET_VALUES) assert(!serialized.includes(secret), `${label} should not expose ${secret}`);
  assert(!serialized.includes("authorization="), `${label} should not expose signed authorization`);
  assert(!serialized.includes("wss://"), `${label} should not expose signed WebSocket URLs`);
}

async function testStatus() {
  const result = await request("GET", "/api/digital-life/speech/status");
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    configured: true,
    transcription: true,
    synthesis: true,
    max_recording_seconds: 60,
  });
  assertNoSecrets(result.body, "status");
}

async function testTranscriptionAndSynthesis() {
  const transcription = await request("POST", "/api/digital-life/speech/transcribe", {
    audio_base64: Buffer.alloc(3200).toString("base64"),
    format: "raw",
    sample_rate: 16000,
    language: "zh_cn",
  });
  assert.equal(transcription.status, 200);
  assert.deepEqual(transcription.body, { ok: true, transcript: "今天感觉不错", provider: "iflytek" });
  assert.equal(calls.at(-1).input.audio.byteLength, 3200);
  assert.equal(calls.at(-1).input.sampleRate, 16000);
  assert.equal(calls.at(-1).input.language, "zh_cn");

  const synthesis = await request("POST", "/api/digital-life/speech/synthesize", { text: "我听见了" });
  assert.equal(synthesis.status, 200);
  assert.deepEqual(synthesis.body, {
    ok: true,
    audio_base64: Buffer.from("mp3-data").toString("base64"),
    mime: "audio/mpeg",
    provider: "iflytek",
  });
  assert.deepEqual(calls.at(-1).input, { text: "我听见了", voice: undefined, encoding: "lame" });
  assertNoSecrets(transcription.body, "transcription");
  assertNoSecrets(synthesis.body, "synthesis");
}

async function testValidation() {
  const before = calls.length;
  const malformed = await request("POST", "/api/digital-life/speech/transcribe", {
    audio_base64: "%%%",
    format: "raw",
    sample_rate: 16000,
  });
  assert.equal(malformed.status, 400);
  assert.equal(calls.length, before);

  const wrongFormat = await request("POST", "/api/digital-life/speech/transcribe", {
    audio_base64: Buffer.alloc(2).toString("base64"),
    format: "webm",
    sample_rate: 16000,
  });
  assert.equal(wrongFormat.status, 400);
  assert.equal(calls.length, before);

  const wrongRate = await request("POST", "/api/digital-life/speech/transcribe", {
    audio_base64: Buffer.alloc(2).toString("base64"),
    format: "raw",
    sample_rate: 8000,
  });
  assert.equal(wrongRate.status, 400);
  assert.equal(calls.length, before);

  const tooLarge = await request("POST", "/api/digital-life/speech/transcribe", {
    audio_base64: Buffer.alloc(16000 * 2 * 60 + 2).toString("base64"),
    format: "raw",
    sample_rate: 16000,
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(calls.length, before);

  const emptyText = await request("POST", "/api/digital-life/speech/synthesize", { text: "  " });
  assert.equal(emptyText.status, 400);
  const tooLargeText = await request("POST", "/api/digital-life/speech/synthesize", { text: "a".repeat(8001) });
  assert.equal(tooLargeText.status, 413);
  const unknownVoice = await request("POST", "/api/digital-life/speech/synthesize", { text: "hello", voice: "arbitrary-provider-voice" });
  assert.equal(unknownVoice.status, 400);
  assert.equal(calls.length, before);
}

await testStatus();
await testTranscriptionAndSynthesis();
await testValidation();
console.log("PASS digital life speech routes (3 cases)");
