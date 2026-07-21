import assert from "node:assert/strict";
import {
  buildIflytekSignedUrl,
  createIflytekSpeechClient,
} from "../src/iflytekSpeech.mjs";

const FIXED_NOW = new Date("2026-07-21T02:00:00.000Z");
const TEST_ENV = Object.freeze({
  IFLYTEK_APP_ID: "unit-app-id",
  IFLYTEK_API_KEY: "unit-api-key",
  IFLYTEK_API_SECRET: "unit-api-secret",
});

function assertSafe(value, label) {
  const serialized = JSON.stringify(value);
  for (const secret of Object.values(TEST_ENV)) {
    assert(!serialized.includes(secret), `${label} should not expose ${secret}`);
  }
}

function testSignedUrl() {
  const signed = new URL(buildIflytekSignedUrl({
    host: "iat-api.xfyun.cn",
    path: "/v2/iat",
    apiKey: TEST_ENV.IFLYTEK_API_KEY,
    apiSecret: TEST_ENV.IFLYTEK_API_SECRET,
    now: () => FIXED_NOW,
  }));

  assert.equal(signed.protocol, "wss:");
  assert.equal(signed.host, "iat-api.xfyun.cn");
  assert.equal(signed.pathname, "/v2/iat");
  assert.equal(signed.searchParams.get("date"), "Tue, 21 Jul 2026 02:00:00 GMT");
  assert.equal(
    signed.searchParams.get("authorization"),
    "YXBpX2tleT0idW5pdC1hcGkta2V5IiwgYWxnb3JpdGhtPSJobWFjLXNoYTI1NiIsIGhlYWRlcnM9Imhvc3QgZGF0ZSByZXF1ZXN0LWxpbmUiLCBzaWduYXR1cmU9IjFWOUlNRG5nQ3Q0dVB4NUE0UzdTcXM4Qzg1YS9sVW5hV1dwWVk0bGg3dkE9Ig==",
  );
  assert(!signed.href.includes(TEST_ENV.IFLYTEK_API_SECRET));
  assert(!signed.href.includes(TEST_ENV.IFLYTEK_API_KEY));

  assert.throws(
    () => buildIflytekSignedUrl({
      host: "example.com",
      path: "/v2/iat",
      apiKey: TEST_ENV.IFLYTEK_API_KEY,
      apiSecret: TEST_ENV.IFLYTEK_API_SECRET,
      now: () => FIXED_NOW,
    }),
    error => error.code === "speech_endpoint_rejected" && error.statusCode === 400,
  );
}

function testConfigurationStatus() {
  const unconfigured = createIflytekSpeechClient({ env: {}, now: () => FIXED_NOW });
  assert.deepEqual(unconfigured.status(), {
    configured: false,
    transcription: false,
    synthesis: false,
    provider: "iflytek",
  });

  const configured = createIflytekSpeechClient({ env: TEST_ENV, now: () => FIXED_NOW });
  assert.deepEqual(configured.status(), {
    configured: true,
    transcription: true,
    synthesis: true,
    provider: "iflytek",
  });
  assertSafe(configured.status(), "speech status");
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.closed = true;
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  emitJson(value) {
    this.emit("message", { data: JSON.stringify(value) });
  }
}

async function waitFor(predicate, message) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function testProtocolRoundTrips() {
  FakeWebSocket.instances = [];
  const client = createIflytekSpeechClient({
    env: TEST_ENV,
    WebSocketImpl: FakeWebSocket,
    now: () => FIXED_NOW,
    timeoutMs: 1000,
  });

  const transcription = client.transcribe({ audio: Buffer.alloc(2560, 1) });
  const iatSocket = FakeWebSocket.instances.at(-1);
  assert(iatSocket, "transcription should create a WebSocket");
  assert.equal(new URL(iatSocket.url).host, "iat-api.xfyun.cn");
  iatSocket.emit("open");
  await waitFor(() => iatSocket.sent.length === 3, "IAT frames were not sent");
  assert.deepEqual(iatSocket.sent.map(frame => frame.data.status), [0, 1, 2]);
  assert.equal(iatSocket.sent[0].common.app_id, TEST_ENV.IFLYTEK_APP_ID);
  assert.equal(iatSocket.sent[0].business.dwa, "wpgs");
  assert.equal(Buffer.from(iatSocket.sent[0].data.audio, "base64").byteLength, 1280);
  assert.equal(Buffer.from(iatSocket.sent[1].data.audio, "base64").byteLength, 1280);
  assert.equal(iatSocket.sent[2].data.audio, "");

  iatSocket.emitJson({
    code: 0,
    data: { status: 1, result: { sn: 1, pgs: "apd", ws: [{ cw: [{ w: "今天" }] }] } },
  });
  iatSocket.emitJson({
    code: 0,
    data: { status: 1, result: { sn: 2, pgs: "apd", ws: [{ cw: [{ w: "不忙" }] }] } },
  });
  iatSocket.emitJson({
    code: 0,
    data: { status: 2, result: { sn: 3, pgs: "rpl", rg: [2, 2], ws: [{ cw: [{ w: "很好" }] }] } },
  });
  const transcriptResult = await transcription;
  assert.equal(transcriptResult.transcript, "今天很好");
  assert.equal(typeof transcriptResult.durationMs, "number");
  assert(iatSocket.closed, "IAT socket should close after the final result");

  const synthesis = client.synthesize({ text: "你好", encoding: "lame" });
  const ttsSocket = FakeWebSocket.instances.at(-1);
  assert(ttsSocket && ttsSocket !== iatSocket, "synthesis should create a second WebSocket");
  assert.equal(new URL(ttsSocket.url).host, "tts-api.xfyun.cn");
  ttsSocket.emit("open");
  await waitFor(() => ttsSocket.sent.length === 1, "TTS request was not sent");
  assert.equal(ttsSocket.sent[0].business.aue, "lame");
  assert.equal(ttsSocket.sent[0].business.vcn, "xiaoyan");
  assert.equal(Buffer.from(ttsSocket.sent[0].data.text, "base64").toString("utf8"), "你好");

  ttsSocket.emitJson({ code: 0, data: { status: 1, audio: Buffer.from("first").toString("base64") } });
  ttsSocket.emitJson({ code: 0, data: { status: 2, audio: Buffer.from("second").toString("base64") } });
  const synthesisResult = await synthesis;
  assert.equal(synthesisResult.audio.toString(), "firstsecond");
  assert.equal(synthesisResult.mime, "audio/mpeg");
  assert.equal(synthesisResult.encoding, "lame");
  assert(ttsSocket.closed, "TTS socket should close after the final chunk");
}

async function testSafeErrors() {
  const client = createIflytekSpeechClient({
    env: TEST_ENV,
    WebSocketImpl: FakeWebSocket,
    now: () => FIXED_NOW,
    timeoutMs: 5,
  });

  await assert.rejects(() => client.transcribe({ audio: Buffer.alloc(0) }), error => error.code === "speech_audio_empty");
  await assert.rejects(() => client.transcribe({ audio: Buffer.alloc(2), sampleRate: 8000 }), error => error.code === "speech_sample_rate_invalid");
  await assert.rejects(() => client.transcribe({ audio: Buffer.alloc(1) }), error => error.code === "speech_audio_invalid");
  await assert.rejects(() => client.transcribe({ audio: Buffer.alloc(16000 * 2 * 60 + 2) }), error => error.code === "speech_audio_too_large");
  await assert.rejects(() => client.synthesize({ text: "" }), error => error.code === "speech_text_empty");
  await assert.rejects(() => client.synthesize({ text: "a".repeat(8001) }), error => error.code === "speech_text_too_large");

  FakeWebSocket.instances = [];
  const providerFailure = client.transcribe({ audio: Buffer.alloc(2) });
  const failedSocket = FakeWebSocket.instances.at(-1);
  failedSocket.emit("open");
  failedSocket.emitJson({ code: 10106, message: "provider detail must stay hidden" });
  await assert.rejects(providerFailure, error => {
    assert.equal(error.code, "speech_provider_error");
    assertSafe(error, "provider error");
    return true;
  });

  FakeWebSocket.instances = [];
  const timeout = client.transcribe({ audio: Buffer.alloc(2) });
  await assert.rejects(timeout, error => error.code === "speech_timeout");
}

async function main() {
  testSignedUrl();
  testConfigurationStatus();
  await testProtocolRoundTrips();
  await testSafeErrors();
  console.log("PASS iflytek speech client (4 cases)");
}

await main();
