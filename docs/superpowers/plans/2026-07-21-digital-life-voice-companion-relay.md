# Digital Life Voice Companion Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the VibeBoard market companion to the real Digital Life runtime and server-side iFLYTEK speech services while preserving text and local fallback behavior.

**Architecture:** Add a focused iFLYTEK WebSocket client and a narrow same-origin speech route module, then let the existing Digital Life route owner compose both without moving cognition, memory, or affect logic. Upgrade the existing five-file static market app in place so startup hydration, text chat, push-to-talk, expression rendering, TTS playback, ranked memory display, and bounded ticks all use the established `/api/digital-life/*` contract.

**Tech Stack:** Node.js 24 ESM, built-in WebSocket and crypto APIs, existing HTTP server and sql.js runtime, browser Web Audio API, Playwright, Node assertion-based smoke tests.

## Global Constraints

- Provider credentials exist only in `IFLYTEK_APP_ID`, `IFLYTEK_API_KEY`, `IFLYTEK_API_SECRET`, optional `IFLYTEK_TTS_VOICE`, and the existing `VIBEBOARD_LLM_*` server environment variables.
- Never write credential values, signed URLs, authorization queries, or raw audio into source, SQLite, logs, telemetry, screenshots, browser storage, or acceptance artifacts.
- Sign only `wss://iat-api.xfyun.cn/v2/iat` and `wss://tts-api.xfyun.cn/v2/tts`.
- Accept only 16 kHz, signed 16-bit, mono raw PCM for transcription; stop browser capture after 15 seconds and reject server requests beyond 60 seconds.
- Limit TTS input to 8,000 UTF-8 bytes and route-selected voices to a server allowlist.
- Keep the existing controlled expression vocabulary: `idle`, `listening`, `thinking`, `speaking`, `warm`, `curious`, `happy`, `tired`, `confused`, `lonely`, `angry`, `error`, `sleeping`, `away`.
- The market app remains a five-file static app; all browser behavior stays in `market-apps/vb-digital-life-companion-demo/app.js`.
- Digital Life cognition, memory policy, affect, persistence, and offline LLM fallback remain authoritative in `src/digitalLife.mjs`.
- Do not add always-listening, wake words, voice identity, raw-audio history, arbitrary provider endpoints, or real-board deployment.
- Every code task follows RED, minimal GREEN, focused regression, then commit.
- Because `server.mjs` changes, final verification includes `npm run verify:agent` in addition to focused speech, Digital Life, UI, and offline suites.

---

## File Structure

- Create `src/iflytekSpeech.mjs`: signing, IAT framing/result assembly, TTS framing/audio assembly, timeouts, and safe provider errors.
- Create `src/digitalLifeSpeechRoutes.mjs`: HTTP validation and safe JSON contracts for speech status, transcription, and synthesis.
- Modify `src/digitalLifeRoutes.mjs`: compose the speech route handler before returning `false`; keep runtime and hardware routes unchanged.
- Modify `server.mjs`: pass `process.env` into Digital Life route construction so configuration is explicit and testable.
- Modify `market-apps/vb-digital-life-companion-demo/index.html`: add compact conversation, microphone, transcript, connection status, and TTS controls.
- Modify `market-apps/vb-digital-life-companion-demo/style.css`: fit conversation and memory overlays at 480x360 and mobile dimensions without overlap.
- Modify `market-apps/vb-digital-life-companion-demo/app.js`: real hydration, text/voice pipeline, expression normalization, memory rendering, tick scheduling, and independent fallbacks.
- Modify `market-apps/vb-digital-life-companion-demo/manifest.json`: update capabilities and version while retaining the five-file contract.
- Create `tests/iflytek-speech.mjs`: deterministic unit tests with fixed time and fake WebSockets.
- Create `tests/digital-life-speech-routes.mjs`: validation, injection, error sanitization, and no-secret route tests.
- Create `tests/digital-life-market-companion.mjs`: Playwright API fixtures, real UI sequencing, microphone/audio mocks, failure modes, and viewport checks.
- Create `scripts/verify-digital-life-speech-live.mjs`: explicitly gated, isolated provider and end-to-end live smoke with secret scanning.
- Modify `tests/digital-life-smoke.mjs`: assert speech status coexists with the existing Digital Life contract.
- Modify `package.json`: add focused and live speech commands and include focused tests in `verify:digital-life`.
- Create `docs/digital-life-voice-companion-acceptance.md`: final evidence template populated only with observed results.

---

### Task 1: Deterministic iFLYTEK Speech Protocol Client

**Files:**
- Create: `src/iflytekSpeech.mjs`
- Create: `tests/iflytek-speech.mjs`

**Interfaces:**
- Consumes: `{ IFLYTEK_APP_ID, IFLYTEK_API_KEY, IFLYTEK_API_SECRET, IFLYTEK_TTS_VOICE }` from an injected environment object.
- Produces: `buildIflytekSignedUrl({ host, path, apiKey, apiSecret, now }): string`.
- Produces: `createIflytekSpeechClient(options): { status(), transcribe(input), synthesize(input) }`.
- `status()` returns `{ configured: boolean, transcription: boolean, synthesis: boolean, provider: "iflytek" }`.
- `transcribe({ audio: Buffer, sampleRate?: 16000, language?: "zh_cn" })` resolves to `{ transcript: string, durationMs: number }`.
- `synthesize({ text: string, voice?: string, encoding?: "lame" | "raw" })` resolves to `{ audio: Buffer, mime: string, encoding: string }`.
- Provider failures throw errors with only `{ code, statusCode, retryable, message }`; no error property contains a credential or signed URL.

- [ ] **Step 1: Write the fixed-clock signing and status tests**

```js
import assert from "node:assert/strict";
import { buildIflytekSignedUrl, createIflytekSpeechClient } from "../src/iflytekSpeech.mjs";

const fixedNow = new Date("2026-07-21T02:00:00.000Z");
const signed = new URL(buildIflytekSignedUrl({
  host: "iat-api.xfyun.cn",
  path: "/v2/iat",
  apiKey: "unit-api-key",
  apiSecret: "unit-api-secret",
  now: () => fixedNow,
}));
assert.equal(signed.protocol, "wss:");
assert.equal(signed.host, "iat-api.xfyun.cn");
assert.equal(signed.pathname, "/v2/iat");
assert.equal(signed.searchParams.get("date"), fixedNow.toUTCString());
assert.match(signed.searchParams.get("authorization"), /^[A-Za-z0-9+/=]+$/);
assert(!signed.href.includes("unit-api-secret"));

const unconfigured = createIflytekSpeechClient({ env: {}, now: () => fixedNow });
assert.deepEqual(unconfigured.status(), {
  configured: false,
  transcription: false,
  synthesis: false,
  provider: "iflytek",
});
```

- [ ] **Step 2: Run the signing tests and confirm RED**

Run: `node tests/iflytek-speech.mjs`

Expected: exit 1 with `ERR_MODULE_NOT_FOUND` for `src/iflytekSpeech.mjs`.

- [ ] **Step 3: Implement signing, configuration, and safe error primitives**

```js
import { createHmac } from "node:crypto";

const HOST_PATHS = new Map([
  ["iat-api.xfyun.cn", "/v2/iat"],
  ["tts-api.xfyun.cn", "/v2/tts"],
]);

export function buildIflytekSignedUrl({ host, path, apiKey, apiSecret, now = () => new Date() }) {
  if (HOST_PATHS.get(host) !== path) throw speechError("speech_endpoint_rejected", 400, false);
  const date = now().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const signature = createHmac("sha256", apiSecret).update(signatureOrigin).digest("base64");
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const query = new URLSearchParams({
    authorization: Buffer.from(authorizationOrigin).toString("base64"),
    date,
    host,
  });
  return `wss://${host}${path}?${query}`;
}

function speechError(code, statusCode = 502, retryable = true) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  error.retryable = retryable;
  return error;
}
```

- [ ] **Step 4: Add fake-WebSocket RED tests for IAT and TTS message order**

```js
class FakeWebSocket extends EventTarget {
  static instances = [];
  sent = [];
  constructor(url) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.dispatchEvent(new CloseEvent("close")); }
  emitJson(value) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

const env = {
  IFLYTEK_APP_ID: "unit-app",
  IFLYTEK_API_KEY: "unit-key",
  IFLYTEK_API_SECRET: "unit-secret",
};
const client = createIflytekSpeechClient({ env, WebSocketImpl: FakeWebSocket, now: () => fixedNow, timeoutMs: 1000 });
const iatPromise = client.transcribe({ audio: Buffer.alloc(2560, 1) });
await new Promise(resolve => setImmediate(resolve));
const iatSocket = FakeWebSocket.instances.at(-1);
assert.deepEqual(iatSocket.sent.map(frame => frame.data.status), [0, 1, 2]);
iatSocket.emitJson({ code: 0, data: { status: 1, result: { sn: 1, pgs: "apd", ws: [{ cw: [{ w: "你" }] }] } } });
iatSocket.emitJson({ code: 0, data: { status: 2, result: { sn: 2, pgs: "apd", ws: [{ cw: [{ w: "好" }] }] } } });
assert.equal((await iatPromise).transcript, "你好");

const ttsPromise = client.synthesize({ text: "你好", encoding: "lame" });
await new Promise(resolve => setImmediate(resolve));
const ttsSocket = FakeWebSocket.instances.at(-1);
assert.equal(Buffer.from(ttsSocket.sent[0].data.text, "base64").toString("utf8"), "你好");
ttsSocket.emitJson({ code: 0, data: { status: 1, audio: Buffer.from("first").toString("base64") } });
ttsSocket.emitJson({ code: 0, data: { status: 2, audio: Buffer.from("second").toString("base64") } });
assert.equal((await ttsPromise).audio.toString(), "firstsecond");
```

- [ ] **Step 5: Implement bounded framing, dynamic correction, audio assembly, and timeouts**

Use 1,280-byte IAT chunks (40 ms at 16 kHz, 16-bit mono). Send the first chunk with status `0`, remaining chunks with status `1`, then an empty status `2` frame. Store recognition segments by `sn`; for `pgs: "rpl"`, delete the inclusive `rg` range before inserting the replacement; resolve only after provider status `2`. TTS sends one request with `aue: "lame"` for public MP3 or `aue: "raw"` for the live round-trip test, appends each decoded `data.audio` chunk, and resolves at status `2`. Both operations close their socket and throw `speech_timeout` when the injected timeout expires.

Core result assembly must be implemented exactly through these helpers:

```js
function wordsFromResult(result = {}) {
  return (result.ws || []).flatMap(item => item.cw || []).map(item => item.w || "").join("");
}

function applyIatResult(segments, result = {}) {
  if (result.pgs === "rpl" && Array.isArray(result.rg)) {
    for (let sn = Number(result.rg[0]); sn <= Number(result.rg[1]); sn += 1) segments.delete(sn);
  }
  segments.set(Number(result.sn || 0), wordsFromResult(result));
  return [...segments.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join("");
}
```

- [ ] **Step 6: Add RED tests for replacement results, errors, empty payloads, and timeout cleanup**

Cover `rpl` replacing two earlier segments, provider `code !== 0`, empty final transcript, missing credentials, WebSocket absence, and timeout. Assert errors expose only safe codes and never include any of `unit-app`, `unit-key`, or `unit-secret`.

- [ ] **Step 7: Run the focused suite to GREEN**

Run: `node tests/iflytek-speech.mjs`

Expected: exit 0 and print `PASS iflytek speech client` with signing, IAT, TTS, replacement, error, and timeout case counts.

- [ ] **Step 8: Commit the protocol client**

```bash
git add src/iflytekSpeech.mjs tests/iflytek-speech.mjs
git commit -m "feat: add iflytek speech protocol client"
```

---

### Task 2: Safe Digital Life Speech HTTP Relay

**Files:**
- Create: `src/digitalLifeSpeechRoutes.mjs`
- Create: `tests/digital-life-speech-routes.mjs`
- Modify: `src/digitalLifeRoutes.mjs`
- Modify: `server.mjs`
- Modify: `tests/digital-life-smoke.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `createIflytekSpeechClient({ env })` from Task 1.
- Produces: `createDigitalLifeSpeechRoutes({ readBody, json, speechClient?, env? }): { handle(req, res, url): Promise<boolean> }`.
- `GET /api/digital-life/speech/status` returns public booleans and `max_recording_seconds: 60` only.
- `POST /api/digital-life/speech/transcribe` accepts `{ audio_base64, format: "raw", sample_rate: 16000, language: "zh_cn" }`.
- `POST /api/digital-life/speech/synthesize` accepts `{ text, voice? }` and returns MP3 base64.

- [ ] **Step 1: Write route RED tests using an injected fake client**

```js
const calls = [];
const speechClient = {
  status: () => ({ configured: true, transcription: true, synthesis: true, provider: "iflytek" }),
  async transcribe(input) {
    calls.push({ type: "transcribe", input });
    return { transcript: "今天感觉不错", durationMs: 120 };
  },
  async synthesize(input) {
    calls.push({ type: "synthesize", input });
    return { audio: Buffer.from("mp3-data"), mime: "audio/mpeg", encoding: "lame" };
  },
};

assert.deepEqual(await request("GET", "/api/digital-life/speech/status"), {
  ok: true,
  configured: true,
  transcription: true,
  synthesis: true,
  max_recording_seconds: 60,
});
assert.equal((await request("POST", "/api/digital-life/speech/transcribe", {
  audio_base64: Buffer.alloc(3200).toString("base64"),
  format: "raw",
  sample_rate: 16000,
  language: "zh_cn",
})).transcript, "今天感觉不错");
assert.equal((await request("POST", "/api/digital-life/speech/synthesize", { text: "我听见了" })).mime, "audio/mpeg");
```

- [ ] **Step 2: Run the route test and confirm RED**

Run: `node tests/digital-life-speech-routes.mjs`

Expected: exit 1 with `ERR_MODULE_NOT_FOUND` for `src/digitalLifeSpeechRoutes.mjs`.

- [ ] **Step 3: Implement request validation and safe response mapping**

```js
const MAX_PCM_BYTES = 16000 * 2 * 60;
const MAX_TTS_BYTES = 8000;

export function createDigitalLifeSpeechRoutes({ readBody, json, speechClient, env } = {}) {
  const client = speechClient || createIflytekSpeechClient({ env });
  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith("/api/digital-life/speech")) return false;
      try {
        if (req.method === "GET" && url.pathname === "/api/digital-life/speech/status") {
          const status = client.status();
          json(res, 200, { ok: true, configured: status.configured, transcription: status.transcription, synthesis: status.synthesis, max_recording_seconds: 60 });
          return true;
        }
        if (req.method === "POST" && url.pathname === "/api/digital-life/speech/transcribe") {
          const body = await readBody(req);
          const audio = decodeAndValidatePcm(body, MAX_PCM_BYTES);
          const result = await client.transcribe({ audio, sampleRate: 16000, language: "zh_cn" });
          json(res, 200, { ok: true, transcript: result.transcript, provider: "iflytek" });
          return true;
        }
        if (req.method === "POST" && url.pathname === "/api/digital-life/speech/synthesize") {
          const body = await readBody(req);
          const text = validateTtsText(body?.text, MAX_TTS_BYTES);
          const result = await client.synthesize({ text, voice: validateVoice(body?.voice), encoding: "lame" });
          json(res, 200, { ok: true, audio_base64: result.audio.toString("base64"), mime: "audio/mpeg", provider: "iflytek" });
          return true;
        }
        return false;
      } catch (error) {
        json(res, error.statusCode || 502, { ok: false, error: error.code || "speech_unavailable", retryable: error.retryable !== false });
        return true;
      }
    },
  };
}
```

`decodeAndValidatePcm` must reject missing/noncanonical base64, odd byte counts, non-`raw` formats, non-16000 sample rates, empty buffers, and buffers larger than 1,920,000 bytes before calling the client. `validateTtsText` measures `Buffer.byteLength(text, "utf8")`. `validateVoice` accepts an empty value or one of the server-defined values `xiaoyan`, `aisjiuxu`, `aisxping`, and `aisjinger`; unknown values receive HTTP 400.

- [ ] **Step 4: Add RED tests for all validation and sanitization boundaries**

Test malformed base64, empty audio, odd bytes, 8 kHz audio, non-raw format, 60-second-plus audio, empty text, 8,001-byte text, unknown voice, unconfigured client, and provider failure. For every response, assert the serialized JSON does not contain injected APPID, API key, API secret, `authorization=`, or `wss://`.

- [ ] **Step 5: Compose the speech handler into existing Digital Life routes**

In `src/digitalLifeRoutes.mjs`, import `createDigitalLifeSpeechRoutes`, construct it once beside `runtime`, and call it before `handleDigitalLifeRequest` so `/api/digital-life/speech/*` is handled without entering the generic collection route:

```js
const speechRoutes = createDigitalLifeSpeechRoutes({ readBody, json, env });

async function handle(req, res, url) {
  if (await speechRoutes.handle(req, res, url)) return true;
  if (await handleDigitalLifeRequest({ req, res, url, readBody, json, store })) return true;
  // existing runtime and hardware routes remain here
}
```

Pass `env: process.env` from `server.mjs` when calling `createDigitalLifeRoutes`.

- [ ] **Step 6: Extend the existing Digital Life smoke contract**

Add an unconfigured status assertion to `tests/digital-life-smoke.mjs`:

```js
const speech = await json("/api/digital-life/speech/status");
assert(speech.ok === true, "speech status should remain queryable without credentials");
assert(typeof speech.configured === "boolean", "speech status should expose configured boolean");
assert(speech.max_recording_seconds === 60, "speech status should expose the 60-second hard limit");
assert(!("api_key" in speech) && !("authorization" in speech), "speech status should expose no authentication material");
```

- [ ] **Step 7: Add focused scripts and run GREEN**

Add these package scripts without replacing existing commands:

```json
"verify:digital-life-speech": "node tests/iflytek-speech.mjs && node tests/digital-life-speech-routes.mjs",
"verify:digital-life-market": "node tests/digital-life-market-companion.mjs",
"verify:digital-life-speech:live": "node scripts/verify-digital-life-speech-live.mjs"
```

Prepend `npm run verify:digital-life-speech &&` to the existing `verify:digital-life` command.

Run: `npm run verify:digital-life-speech && node tests/digital-life-smoke.mjs`

Expected: exit 0; speech unit/route suites pass and the existing state/message/memory/tick smoke prints `{ "ok": true }`.

- [ ] **Step 8: Commit the HTTP relay**

```bash
git add src/digitalLifeSpeechRoutes.mjs src/digitalLifeRoutes.mjs server.mjs tests/digital-life-speech-routes.mjs tests/digital-life-smoke.mjs package.json
git commit -m "feat: relay digital life speech services"
```

---

### Task 3: Real Startup Hydration, Text Dialogue, Memory, and Expression

**Files:**
- Create: `tests/digital-life-market-companion.mjs`
- Modify: `market-apps/vb-digital-life-companion-demo/index.html`
- Modify: `market-apps/vb-digital-life-companion-demo/style.css`
- Modify: `market-apps/vb-digital-life-companion-demo/app.js`
- Modify: `market-apps/vb-digital-life-companion-demo/manifest.json`

**Interfaces:**
- Consumes: existing `/state`, `/memories`, `/messages`, `/message`, and Task 2 `/speech/status` JSON contracts.
- Produces: `window.DigitalLifeDeviceSimulator.getState()` with `connection_mode`, `conversation_state`, `expression`, `memories`, `messages`, `speech`, and legacy skin fields.
- Produces: `window.DigitalLifeDeviceSimulator.sendMessage(text): Promise<object>` for browser verification and hardware simulation.
- Produces: `normalizeExpression(payload, fallback): string` inside `app.js`, exposed as `DigitalLifeDeviceSimulator.normalizeExpression` for contract testing.

- [ ] **Step 1: Write a Playwright hydration and text-conversation RED test**

Intercept same-origin Digital Life calls before navigating to the market app. Return a state with `mind.expression: "curious"`, two ranked memories, two history messages, disabled speech, and a message reply with `state.mind.expression: "warm"`. Assert the four startup requests happen, the page moves from local rendering to `data-connection="online"`, KEY2 shows server memory text, and sending `今天有点累` posts only `{ content, conversation_id }` before rendering the reply and `warm` expression.

```js
await page.route("**/api/digital-life/**", async route => {
  const url = new URL(route.request().url());
  calls.push({ path: url.pathname, method: route.request().method(), body: route.request().postDataJSON?.() });
  if (url.pathname.endsWith("/state")) return route.fulfill({ json: { ok: true, state: { mood: "curious", energy: 72, mind: { expression: "curious" } } } });
  if (url.pathname.endsWith("/memories")) return route.fulfill({ json: { ok: true, memories: [{ id: "real-1", title: "陪伴边界", kind: "preference", content: "安静陪伴，不替用户决定", importance: 5 }] } });
  if (url.pathname.endsWith("/messages")) return route.fulfill({ json: { ok: true, messages: [{ id: "u1", role: "user", content: "早上好" }, { id: "a1", role: "assistant", content: "早上好，我在。" }] } });
  if (url.pathname.endsWith("/speech/status")) return route.fulfill({ json: { ok: true, configured: false, transcription: false, synthesis: false, max_recording_seconds: 60 } });
  if (url.pathname.endsWith("/message")) return route.fulfill({ json: { ok: true, assistant_message: { id: "a2", role: "assistant", content: "听起来你需要慢一点。" }, state: { mood: "warm", mind: { expression: "warm" } }, mode: "offline_mock", fallback_reason: "model unavailable" } });
  return route.fulfill({ status: 404, json: { ok: false } });
});
```

- [ ] **Step 2: Run the market test and confirm RED**

Run: `node tests/digital-life-market-companion.mjs`

Expected: exit 1 because the current app makes none of the four hydration calls and has no conversation form.

- [ ] **Step 3: Add the compact conversation surface**

Add `#connectionStatus`, `#messageLog`, `#transcriptLine`, `#messageForm`, `#messageInput`, `#sendMessage`, `#micButton`, and `#ttsEnabled` to `index.html`. Keep the face as the first visual signal; place the message log in a bottom sheet with fixed responsive bounds, and use icon glyphs only for send/microphone controls with accessible labels and tooltips.

CSS invariants:

```css
.conversation-panel { position: absolute; inset: auto 10px 58px; max-height: min(42vh, 148px); overflow: hidden; }
.message-log { min-height: 46px; max-height: 72px; overflow-y: auto; }
.composer { display: grid; grid-template-columns: minmax(0, 1fr) 36px 36px; gap: 6px; }
.composer input { min-width: 0; }
.icon-button { inline-size: 36px; block-size: 36px; }
@media (max-width: 420px), (max-height: 420px) {
  .conversation-panel { inset-inline: 8px; bottom: 54px; max-height: 138px; }
}
```

- [ ] **Step 4: Implement startup hydration and render real records**

Use one `Promise.allSettled` for the four startup requests. Preserve current local face and synthetic memories until real data succeeds. Mark synthetic records with `source: "offline"`; replace `state.memories` entirely after a successful backend memory response. Escape every rendered message/memory field.

```js
const API = {
  state: "/api/digital-life/state?conversation_id=market-companion",
  memories: "/api/digital-life/memories?limit=12",
  messages: "/api/digital-life/messages?conversation_id=market-companion&limit=20",
  message: "/api/digital-life/message",
  tick: "/api/digital-life/tick",
  speechStatus: "/api/digital-life/speech/status",
  transcribe: "/api/digital-life/speech/transcribe",
  synthesize: "/api/digital-life/speech/synthesize",
};

async function hydrate() {
  const [life, memory, history, speech] = await Promise.allSettled([
    requestJson(API.state), requestJson(API.memories), requestJson(API.messages), requestJson(API.speechStatus),
  ]);
  if (life.status === "fulfilled") applyLifeState(life.value.state);
  if (memory.status === "fulfilled") state.memories = memory.value.memories.map(normalizeMemory);
  if (history.status === "fulfilled") state.messages = history.value.messages.map(normalizeMessage);
  if (speech.status === "fulfilled") state.speech = speech.value;
  state.connectionMode = life.status === "fulfilled" ? "online" : "offline";
  render();
}
```

- [ ] **Step 5: Implement expression priority and text send without browser model settings**

```js
function normalizeExpression(payload, fallback = "idle") {
  const raw = payload?.mind?.expression
    || payload?.state?.mind?.expression
    || payload?.state?.expression
    || payload?.expression
    || payload?.state?.mood
    || fallback;
  const aliases = { joyful: "happy", calm: "idle", caring: "warm", fatigued: "tired", asleep: "sleeping", absent: "away" };
  const candidate = aliases[String(raw || "").toLowerCase()] || String(raw || "").toLowerCase();
  return expressionStates.includes(candidate) ? candidate : fallback;
}

async function sendMessage(text) {
  const content = String(text || "").trim();
  if (!content || state.requestInFlight) return null;
  appendVisibleMessage({ role: "user", content, pending: true });
  setTransientExpression("thinking");
  const response = await requestJson(API.message, {
    method: "POST",
    body: JSON.stringify({ conversation_id: "market-companion", content }),
  });
  appendVisibleMessage(response.assistant_message);
  state.lastLifeExpression = normalizeExpression(response, state.lastLifeExpression);
  applyLifeState(response.state || {});
  render();
  return response;
}
```

On `/message` failure, retain the user's single visible message, append one explicitly offline local reply, set `connectionMode: "offline"`, and never retry the POST automatically.

- [ ] **Step 6: Run hydration and text tests to GREEN**

Run: `node tests/digital-life-market-companion.mjs --section=text`

Expected: exit 0 with four startup endpoints observed, one message POST, real KEY2 memory content, `curious -> thinking -> warm`, and no API/model credential fields in the request.

- [ ] **Step 7: Update manifest and commit the real companion body**

Set version to `1.1.0`, source to `digital-life-runtime`, and add capability labels for `text-dialogue`, `ranked-memory`, `runtime-expression`, `push-to-talk`, `speech-synthesis`, and `offline-fallback` without adding files.

```bash
git add market-apps/vb-digital-life-companion-demo/index.html market-apps/vb-digital-life-companion-demo/style.css market-apps/vb-digital-life-companion-demo/app.js market-apps/vb-digital-life-companion-demo/manifest.json tests/digital-life-market-companion.mjs
git commit -m "feat: connect market companion to digital life"
```

---

### Task 4: Push-to-Talk PCM, Transcription, and Speech Playback

**Files:**
- Modify: `market-apps/vb-digital-life-companion-demo/app.js`
- Modify: `market-apps/vb-digital-life-companion-demo/style.css`
- Modify: `tests/digital-life-market-companion.mjs`

**Interfaces:**
- Consumes: Task 2 transcription and synthesis routes and Task 3 `sendMessage`.
- Produces: `startListening(): Promise<void>`, `stopListening(): Promise<void>`, and `speakReply(text, finalExpression): Promise<void>`.
- Produces: `float32ToPcm16(samples): Int16Array` and `resampleMono(samples, inputRate, outputRate): Float32Array`, exposed under `DigitalLifeDeviceSimulator.audio` for deterministic browser assertions.
- Voice state sequence is exactly `listening -> thinking -> speaking -> final real expression` when all services succeed.

- [ ] **Step 1: Add browser RED tests for audio conversion and full state sequence**

Install a fake `navigator.mediaDevices.getUserMedia`, `AudioContext`, and `Audio` before page scripts execute. The fake processor exposes `window.__emitMicSamples(Float32Array)` and fake audio fires `play`, then `ended`. Fulfill transcription with `今天想安静一点`, message with `mind.expression: "warm"`, and synthesis with a small base64 MP3. Assert route order is `transcribe`, `message`, `synthesize`, transcript appears before reply, and body expressions observed by a `MutationObserver` include `listening`, `thinking`, `speaking`, `warm` in that order.

- [ ] **Step 2: Run the voice section and confirm RED**

Run: `node tests/digital-life-market-companion.mjs --section=voice`

Expected: exit 1 because the microphone control has no recording pipeline.

- [ ] **Step 3: Implement deterministic mono resampling and PCM conversion**

```js
function resampleMono(input, inputRate, outputRate = 16000) {
  if (inputRate === outputRate) return new Float32Array(input);
  const length = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Float32Array(length);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = input[left] + (input[right] - input[left]) * fraction;
  }
  return output;
}

function float32ToPcm16(input) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}
```

- [ ] **Step 4: Implement explicit capture with a 15-second stop and cleanup**

On click or Space outside editable controls, call `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })`, create a `ScriptProcessorNode(4096, 1, 1)`, downmix the first input channel, resample from `audioContext.sampleRate`, and accumulate `Int16Array` chunks. `stopListening` disconnects nodes, stops every track, closes the context, clears the timer, concatenates the chunks, and sends base64 using a chunk-safe byte conversion. Never place PCM in DOM, localStorage, IndexedDB, or `state` after the request resolves.

- [ ] **Step 5: Implement transcript-to-message-to-TTS sequencing**

```js
async function completeVoiceTurn(pcm) {
  const transcription = await requestJson(API.transcribe, {
    method: "POST",
    body: JSON.stringify({ audio_base64: bytesToBase64(pcm), format: "raw", sample_rate: 16000, language: "zh_cn" }),
  });
  const transcript = String(transcription.transcript || "").trim();
  if (!transcript) return restoreLifeExpression();
  showTranscript(transcript);
  const reply = await sendMessage(transcript);
  const finalExpression = normalizeExpression(reply, state.lastLifeExpression);
  if (reply?.assistant_message?.content && state.ttsEnabled && state.speech.synthesis) {
    await speakReply(reply.assistant_message.content, finalExpression);
  } else {
    setExpression(finalExpression);
  }
}
```

`speakReply` calls synthesis once, creates a Blob URL, sets `speaking` only for playback, revokes the URL after `ended` or `error`, and restores the final real expression without repeating `/message`.

- [ ] **Step 6: Add independent failure RED tests and implement fallbacks**

Cover microphone denial, STT 503, empty transcript, message 500, TTS 503, and autoplay rejection. Expected behavior:

- microphone denial: text form remains enabled and mic displays retry state;
- STT failure: no `/message` call and body restores the last real expression;
- empty transcript: no `/message` call;
- message failure: one local fallback reply and no duplicate user bubble;
- TTS failure: assistant text remains visible and final real expression returns;
- autoplay rejection: a visible replay icon reuses cached synthesized audio and does not repeat `/message` or `/synthesize`.

- [ ] **Step 7: Run voice and failure tests to GREEN**

Run: `node tests/digital-life-market-companion.mjs --section=voice`

Expected: exit 0 with conversion assertions, successful sequencing, six failure cases, one request per stage, and no raw audio retained in `DigitalLifeDeviceSimulator.getState()`.

- [ ] **Step 8: Commit push-to-talk and playback**

```bash
git add market-apps/vb-digital-life-companion-demo/app.js market-apps/vb-digital-life-companion-demo/style.css tests/digital-life-market-companion.mjs
git commit -m "feat: add companion push to talk"
```

---

### Task 5: Bounded Tick Scheduling and Responsive Market Regression

**Files:**
- Modify: `market-apps/vb-digital-life-companion-demo/app.js`
- Modify: `market-apps/vb-digital-life-companion-demo/style.css`
- Modify: `tests/digital-life-market-companion.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `POST /api/digital-life/tick` response containing `state` and `mind`.
- Produces: `scheduleTick()`, `runTick(reason)`, and `handleVisibilityChange()` with at most one request in flight.
- Produces: test snapshot fields `tick_in_flight`, `last_tick_at`, and `connection_mode`; no timer handle is exposed.

- [ ] **Step 1: Add clock-controlled RED tests for ticks and visibility**

Use Playwright fake timers. Advance 180 seconds while visible and assert exactly three sequential tick POSTs. Hold the first response open and advance another minute; assert no overlap. Hide the page, advance five minutes, assert no calls; show it and assert one catch-up call. Make one tick fail and assert confirmed mood/expression remain unchanged until the next scheduled success.

- [ ] **Step 2: Run tick section and confirm RED**

Run: `node tests/digital-life-market-companion.mjs --section=tick`

Expected: exit 1 because the market app has no tick scheduler.

- [ ] **Step 3: Implement the one-minute visible-page scheduler**

```js
async function runTick(reason = "market-visible") {
  if (document.hidden || state.tickInFlight) return null;
  state.tickInFlight = true;
  try {
    const result = await requestJson(API.tick, { method: "POST", body: JSON.stringify({ source: reason, loop_enabled: true }) });
    applyLifeState(result.state || result);
    state.lastTickAt = new Date().toISOString();
    return result;
  } catch {
    return null;
  } finally {
    state.tickInFlight = false;
  }
}

setInterval(() => runTick("market-visible"), 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) runTick("market-visible-catch-up");
});
```

Do not calculate or submit elapsed hidden time. Do not create messages from tick results in the browser; only apply returned state and expression.

- [ ] **Step 4: Add responsive and nonblank visual assertions**

At 480x360 and 390x844, assert `document.documentElement.scrollWidth <= innerWidth`, every interactive control rectangle stays within the viewport, the face has nonzero dimensions, the two eyes and mouth are visible foreground elements, text input does not overlap mic/send buttons, and KEY1/KEY2/KEY3 still function. Assert KEY2 online data contains `real-1` content and no offline synthetic copy.

- [ ] **Step 5: Run complete market and UI suites to GREEN**

Run: `npm run verify:digital-life-market && npm run verify:ui`

Expected: exit 0; market hydration/text/voice/failure/tick/responsive checks pass and existing portal/admin/main/Digital Life UI tests remain green.

- [ ] **Step 6: Include market verification in the Digital Life gate and commit**

Append `&& npm run verify:digital-life-market` to `verify:digital-life` after the existing backend/UI tests, retaining every existing command.

```bash
git add market-apps/vb-digital-life-companion-demo/app.js market-apps/vb-digital-life-companion-demo/style.css tests/digital-life-market-companion.mjs package.json
git commit -m "test: verify companion tick and fallbacks"
```

---

### Task 6: Live Provider Flow, Secret Audit, and Acceptance Report

**Files:**
- Create: `scripts/verify-digital-life-speech-live.mjs`
- Create: `docs/digital-life-voice-companion-acceptance.md`
- Modify: `market-apps/vb-digital-life-companion-demo/preview.png`

**Interfaces:**
- Consumes: `createIflytekSpeechClient`, loopback server routes, provider environment variables, and optional `VIBEBOARD_REQUIRE_LLM=1`.
- Produces: safe JSON `{ ok, speech, dialogue, expression, latency_ms, secret_scan, llm_mode }` with no transcript, reply text, audio, keys, authorization values, or signed URLs.
- The command refuses to run unless `VIBEBOARD_RUN_LIVE_SPEECH=1` and all three `IFLYTEK_*` secrets are present.

- [ ] **Step 1: Write the live verifier's explicit gate and isolated lifecycle**

```js
if (process.env.VIBEBOARD_RUN_LIVE_SPEECH !== "1") {
  throw new Error("Set VIBEBOARD_RUN_LIVE_SPEECH=1 to authorize one paid live speech verification run.");
}
for (const name of ["IFLYTEK_APP_ID", "IFLYTEK_API_KEY", "IFLYTEK_API_SECRET"]) {
  if (!process.env[name]) throw new Error(`Missing ${name}.`);
}
```

Create a temporary SQLite path and unused loopback port, launch `node server.mjs` with secrets inherited through the child environment, wait for `/api/health`, and terminate the child plus remove temporary files in `finally`. Capture server output in memory only and sanitize it before including failure diagnostics.

- [ ] **Step 2: Implement one provider speech round trip**

Create the Task 1 client directly, synthesize `你好，今天我们慢一点。` with `encoding: "raw"`, assert nonempty PCM, transcribe that PCM, and require a nonempty transcript. Separately call the HTTP synthesis route for MP3 and require `audio_base64` to decode to more than 100 bytes.

- [ ] **Step 3: Implement one transcript-to-mind-to-speech HTTP flow**

POST the recognized transcript to `/api/digital-life/message` using conversation ID `live-speech-acceptance`, require a nonempty assistant message and one of the 14 allowed final expressions, then synthesize that reply through `/api/digital-life/speech/synthesize`. Record each stage latency and total latency. If `VIBEBOARD_REQUIRE_LLM=1`, require `mode !== "offline_mock"`; otherwise report the observed `llm_mode` without treating the backend's documented fallback as a speech failure.

- [ ] **Step 4: Scan all persistence surfaces for credentials**

Read `git ls-files` source contents, the temporary SQLite bytes, captured sanitized logs, and Playwright `localStorage`/`sessionStorage`. For each supplied credential value assert zero matches. Also assert browser requests contain no fields matching `/api.?key|secret|authorization|appid/i`.

- [ ] **Step 5: Run local gates before spending a live request**

Run:

```bash
npm run check
npm run verify:digital-life
npm run verify:agent
npm run verify:offline
```

Expected: every command exits 0. Do not run the paid live verifier while any local gate is red.

- [ ] **Step 6: Run the explicitly authorized live provider verifier**

Run in the current PowerShell process after setting secrets as transient environment variables:

```powershell
$env:VIBEBOARD_RUN_LIVE_SPEECH='1'
npm run verify:digital-life-speech:live
```

Expected: safe JSON with `"ok": true`, nonzero IAT/TTS/dialogue latencies, an allowed expression, `"secret_scan": "clean"`, and an explicit `llm_mode`. If the provider returns quota, entitlement, signing, or timeout failure, record that exact safe category as an external acceptance blocker; do not change passing local code to conceal it.

- [ ] **Step 7: Perform browser visual QA and refresh the market preview**

Open `http://127.0.0.1:8789/market-apps/vb-digital-life-companion-demo/index.html` at 480x360 and 390x844. Verify eyes/mouth, controls, transcript, message sheet, connection status, and KEY2 overlay are legible and do not overlap. Capture a 480x360 screenshot only after real online hydration or a clearly labeled offline state, then replace `preview.png` with the verified image.

- [ ] **Step 8: Write the evidence-based acceptance report**

Populate `docs/digital-life-voice-companion-acceptance.md` with:

- commit IDs and changed-file inventory;
- each local command and observed pass/fail count;
- browser viewport metrics and state-sequence evidence;
- live IAT, TTS, dialogue, total latency, expression, and `llm_mode`;
- secret scan surfaces and zero-match result;
- any external provider/quota blocker separated from implementation failures;
- explicit statement that no real-board deployment was performed.

Do not mark an unrun or failed live check as passed.

- [ ] **Step 9: Run final regression and commit acceptance evidence**

Run: `npm run verify:all`

Expected: exit 0 with syntax, auth, Agent, Agent quality/benchmark, offline, Digital Life speech/runtime/market, and UI suites green.

```bash
git add scripts/verify-digital-life-speech-live.mjs docs/digital-life-voice-companion-acceptance.md market-apps/vb-digital-life-companion-demo/preview.png package.json
git commit -m "test: accept digital life voice companion"
```

---

## Final Acceptance Checklist

- [ ] Text entered in the market app reaches `/api/digital-life/message` exactly once and renders the real reply or explicit backend offline fallback.
- [ ] Explicit push-to-talk creates 16 kHz PCM, returns a nonempty transcript, and retains no raw audio after the request.
- [ ] Available TTS speaks the assistant reply; unavailable TTS leaves the reply readable and restores the final expression.
- [ ] The final face expression comes from real `mind.expression` or the documented normalization fallback order.
- [ ] KEY2 displays current backend memories when online and labels synthetic memories offline.
- [ ] Visible-page ticks are one minute apart, non-overlapping, paused when hidden, and perform one bounded catch-up after visibility returns.
- [ ] Provider and microphone failures remain independent and never disable text dialogue.
- [ ] Credential scans find zero persisted values and public responses contain no signing material.
- [ ] `npm run check`, `npm run verify:digital-life`, `npm run verify:agent`, `npm run verify:offline`, `npm run verify:ui`, and `npm run verify:all` all exit 0.
- [ ] The market catalog still lists the app and both target viewports show a nonblank, nonoverlapping face and controls.
- [ ] The report distinguishes local verification, live iFLYTEK verification, DeepSeek mode/quota, and hardware deployment status without overstating any result.
