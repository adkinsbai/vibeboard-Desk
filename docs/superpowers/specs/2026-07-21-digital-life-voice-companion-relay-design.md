# Digital Life Voice Companion Relay Design

Date: 2026-07-21
Status: Approved for implementation planning

## 1. Objective

Turn the existing `vb-digital-life-companion-demo` market app from a self-contained visual simulator into a real frontend body for the VibeBoard Digital Life runtime. The companion must:

- hear the owner through explicit push-to-talk;
- transcribe speech through iFLYTEK's streaming WebSocket API;
- send recognized text through `/api/digital-life/message`;
- render the returned state, affect, memory context, and `mind.expression`;
- speak the final reply through iFLYTEK TTS;
- load real state, ranked memories, and recent messages at startup;
- advance affect and autonomy through bounded `/api/digital-life/tick` calls;
- keep text chat and the current local simulator available whenever model, network, or speech services fail.

The market app is the body. VibeBoard's local Digital Life runtime is the brain. Provider credentials never enter the body.

## 2. Approved Architecture

```text
Browser microphone
  -> 16 kHz / 16-bit / mono PCM
  -> POST /api/digital-life/speech/transcribe
  -> VibeBoard server
  -> signed wss://iat-api.xfyun.cn/v2/iat
  -> transcript
  -> POST /api/digital-life/message
  -> memory policy + cognition + affect + DeepSeek reply
  -> normalized expression and assistant message
  -> POST /api/digital-life/speech/synthesize
  -> signed wss://tts-api.xfyun.cn/v2/tts
  -> MP3 audio
  -> browser playback and mouth animation
```

The browser never connects directly to iFLYTEK. A direct browser WebSocket would reveal signing material and is forbidden.

## 3. Provider Configuration

The server reads these process environment variables only:

- `IFLYTEK_APP_ID`
- `IFLYTEK_API_KEY`
- `IFLYTEK_API_SECRET`
- `IFLYTEK_TTS_VOICE`, optional, defaulting to a generally available Mandarin voice
- existing `VIBEBOARD_LLM_PROVIDER`, `VIBEBOARD_LLM_BASE_URL`, `VIBEBOARD_LLM_MODEL`, and `VIBEBOARD_LLM_API_KEY` for DeepSeek

Credential values must never be written to source files, the market catalog, SQLite, generated files, browser storage, logs, telemetry, screenshots, error responses, or acceptance artifacts.

The public speech status endpoint may expose only booleans and capability names, such as `configured`, `transcription`, and `synthesis`.

## 4. Server Modules

### 4.1 iFLYTEK speech client

Create a focused server module responsible for:

- building an RFC1123/HMAC-SHA256 signed WebSocket URL for a supplied host and request path;
- streaming bounded PCM frames to iFLYTEK IAT using status `0`, `1`, and `2` frames;
- assembling dynamic-correction recognition results into one final transcript;
- submitting bounded UTF-8 text to iFLYTEK TTS;
- concatenating returned audio chunks into an MP3 response;
- converting provider failures into safe error codes without returning provider credentials or signed URLs;
- enforcing connection and response timeouts;
- accepting injected clock and WebSocket implementations for deterministic tests.

The module does not know about HTTP routing, Digital Life state, browser UI, or database persistence.

### 4.2 Speech API routes

Add same-origin server routes:

#### `GET /api/digital-life/speech/status`

Returns:

```json
{
  "ok": true,
  "configured": true,
  "transcription": true,
  "synthesis": true,
  "max_recording_seconds": 60
}
```

#### `POST /api/digital-life/speech/transcribe`

Accepts:

```json
{
  "audio_base64": "...",
  "format": "raw",
  "sample_rate": 16000,
  "language": "zh_cn"
}
```

Rules:

- require 16 kHz, 16-bit, mono PCM;
- reject empty, malformed, or over-60-second audio;
- do not persist audio;
- return `{ ok, transcript, provider: "iflytek" }`;
- return a safe, retryable error when speech is unconfigured or unavailable.

#### `POST /api/digital-life/speech/synthesize`

Accepts bounded text and optional voice selection from an allowlist. It returns `{ ok, audio_base64, mime: "audio/mpeg", provider: "iflytek" }`. Text is limited to the provider's 8,000-byte request boundary and normal companion replies should stay far below that limit.

No route accepts an APPID, API key, API secret, signed URL, or arbitrary provider endpoint from the browser.

## 5. Market Companion Behavior

### 5.1 Startup hydration

On load, request in parallel:

- `GET /api/digital-life/state`
- `GET /api/digital-life/memories?limit=12`
- `GET /api/digital-life/messages?limit=20`
- `GET /api/digital-life/speech/status`

The body initially renders its current local state. Successful responses replace local state with real runtime data without a blank intermediate screen.

### 5.2 Text conversation

Add a compact dialogue overlay with recent messages, a text input, send command, microphone control, and TTS toggle. Sending text calls:

```json
POST /api/digital-life/message
{ "content": "owner text" }
```

The frontend displays the returned assistant message and records safe reply metadata for inspection. Model configuration is never sent by the browser.

### 5.3 Voice conversation

- Microphone access begins only after an explicit click or Space key action.
- The body switches immediately to `listening`.
- Browser audio is downmixed and resampled to 16 kHz signed 16-bit mono PCM.
- Default recording is push-to-talk with a 15-second automatic stop; the server still enforces the provider's 60-second maximum.
- A successful transcript is displayed before it is sent to `/message`.
- During model work the body shows `thinking`.
- During audio playback it shows `speaking` and animates the mouth.
- After playback it returns to the expression derived from the latest real mind state.

There is no always-on microphone, wake-word service, background recording while the page is hidden, or persisted raw audio in this phase.

### 5.4 Real expression mapping

Normalize the Digital Life response from the first available source:

1. `response.mind.expression`
2. `response.state.mind.expression`
3. `response.state.expression`
4. affect/mood label mapping
5. local fallback expression

Map the runtime result onto the controlled visual vocabulary:

`idle`, `listening`, `thinking`, `speaking`, `warm`, `curious`, `happy`, `tired`, `confused`, `lonely`, `angry`, `error`, `sleeping`, `away`.

The frontend must not invent an emotional change when a real state response is available.

### 5.5 Real memories

KEY2 opens the current ranked memory response, showing safe title/category/content excerpts and ranking reasons when present. It no longer presents synthetic records once the backend is reachable. Synthetic memory remains only as an explicitly labeled offline fallback.

### 5.6 Tick and autonomy

While the kiosk page is visible, call `/api/digital-life/tick` once per minute with at most one request in flight. Pause while hidden and request one bounded catch-up tick after returning. Apply returned energy, affect, mind, and expression state.

The browser does not fabricate elapsed background time and does not send autonomous messages itself. Server policy remains authoritative for whether a proactive action is held or delivered.

## 6. Failure Behavior

Failure modes degrade independently:

- Digital Life API unavailable: keep the current local simulator and label it offline.
- DeepSeek unavailable: accept the backend's grounded offline reply and preserve state/memory behavior.
- STT unavailable: keep text input and disable microphone with a concise status.
- TTS unavailable: show the assistant reply silently and restore its expression.
- Microphone permission denied: keep text conversation and provide a retry command.
- Empty transcript: return to idle without sending an empty message.
- Audio playback blocked: expose a play command without repeating the model call.
- Tick failure: keep the last confirmed state and retry only on the next scheduled interval.

No failure may erase persisted memory, duplicate a user message, send an automatic hardware deployment, or expose provider details.

## 7. Security And Privacy

- All provider authentication is server-side.
- The speech client signs only fixed official iFLYTEK hosts and paths.
- Audio is held in memory only for the active request.
- Request and response size limits are enforced before provider calls.
- Speech errors and telemetry contain safe provider names, durations, and codes only.
- The market app may call only same-origin Digital Life endpoints.
- Existing public-deployment authentication rules continue to protect `/api/digital-life/*`.
- No real-board deployment is part of this work.

Because provider credentials were supplied in a chat transcript, rotating them in the provider console after integration is recommended even though the implementation will not persist them.

## 8. Verification Strategy

### 8.1 Unit tests

- fixed-clock signing vector for IAT and TTS URLs;
- URL contains no plain API secret;
- IAT frame order and bounded PCM chunking;
- dynamic-correction transcript assembly;
- TTS request encoding and audio chunk assembly;
- safe timeout, provider error, empty audio, oversize audio, and oversize text handling;
- expression normalization across supported response shapes.

### 8.2 Route tests

- unconfigured speech returns a safe capability status;
- transcription and synthesis call injected fake clients;
- invalid formats and sizes fail before provider access;
- responses and server logs contain no credential value or signed authorization query;
- existing `/state`, `/memories`, `/messages`, `/message`, and `/tick` behavior remains unchanged.

### 8.3 Browser tests

- startup hydrates real state, ranked memories, and message history;
- text send flows through `/message` and updates expression;
- mocked PCM recording flows through transcription, message, and TTS in order;
- listening, thinking, speaking, and final expressions appear in order;
- STT, DeepSeek, TTS, microphone, and tick failures each preserve usable fallback controls;
- KEY2 shows real ranked memories when online;
- 480x360 and 390x844 have no horizontal overflow or control overlap.

### 8.4 Live provider smoke

With credentials supplied only to the test process:

- synthesize one short Mandarin sentence and verify a nonempty MP3 result;
- transcribe one synthetic or explicitly recorded short PCM sample and verify a nonempty transcript;
- complete one voice-to-message-to-expression-to-speech flow;
- scan source, artifacts, logs, database, and browser state for credential values;
- stop without deploying to hardware.

## 9. Acceptance Criteria

The feature is accepted only when:

- the market companion can exchange a text message with the real Digital Life endpoint;
- explicit push-to-talk produces a transcript and no raw audio persists;
- the assistant reply is synthesized and played when TTS is available;
- the returned real mind state drives the final expression;
- KEY2 shows backend-ranked memories;
- visible-page ticks update affect without duplicate requests;
- every provider failure preserves a usable text/offline path;
- no provider credential appears outside server process configuration;
- all focused tests and the existing `verify:digital-life`, `verify:agent`, and UI smoke suites pass;
- the app remains listed and previewable in the VibeBoard market;
- no L4 hardware deployment is claimed.

## 10. Out Of Scope

- always-listening microphones or wake words;
- voice identity recognition;
- raw audio history or training-data collection;
- replacement of the current Digital Life memory/cognition architecture;
- cloud account, billing, or entitlement changes;
- automatic real-board deployment;
- standalone edge speech inference on the transparent computer.
