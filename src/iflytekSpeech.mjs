import { createHmac } from "node:crypto";

const PROVIDER = "iflytek";
const HOST_PATHS = new Map([
  ["iat-api.xfyun.cn", "/v2/iat"],
  ["tts-api.xfyun.cn", "/v2/tts"],
]);
const IAT_CHUNK_BYTES = 1280;
const MAX_PCM_BYTES = 16000 * 2 * 60;
const MAX_TTS_BYTES = 8000;

function speechError(code, statusCode = 502, retryable = true) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  error.retryable = retryable;
  return error;
}

function wordsFromResult(result = {}) {
  return (result.ws || [])
    .flatMap(item => item.cw || [])
    .map(item => item.w || "")
    .join("");
}

function applyIatResult(segments, result = {}) {
  if (result.pgs === "rpl" && Array.isArray(result.rg)) {
    const start = Number(result.rg[0]);
    const end = Number(result.rg[1]);
    for (let sequence = start; sequence <= end; sequence += 1) {
      segments.delete(sequence);
    }
  }
  segments.set(Number(result.sn || 0), wordsFromResult(result));
  return [...segments.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, text]) => text)
    .join("");
}

function sendJson(socket, value) {
  socket.send(JSON.stringify(value));
}

function parseProviderMessage(event) {
  try {
    return JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
  } catch {
    throw speechError("speech_invalid_response");
  }
}

export function buildIflytekSignedUrl({
  host,
  path,
  apiKey,
  apiSecret,
  now = () => new Date(),
}) {
  if (HOST_PATHS.get(host) !== path) {
    throw speechError("speech_endpoint_rejected", 400, false);
  }

  const date = now().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const signature = createHmac("sha256", apiSecret)
    .update(signatureOrigin)
    .digest("base64");
  const authorizationOrigin = [
    `api_key="${apiKey}"`,
    'algorithm="hmac-sha256"',
    'headers="host date request-line"',
    `signature="${signature}"`,
  ].join(", ");
  const query = new URLSearchParams({
    authorization: Buffer.from(authorizationOrigin).toString("base64"),
    date,
    host,
  });

  return `wss://${host}${path}?${query}`;
}

export function createIflytekSpeechClient({
  env = process.env,
  WebSocketImpl = globalThis.WebSocket,
  now = () => new Date(),
  timeoutMs = 15000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const configured = Boolean(
    env.IFLYTEK_APP_ID
    && env.IFLYTEK_API_KEY
    && env.IFLYTEK_API_SECRET,
  );

  function requireAvailable() {
    if (!configured) throw speechError("speech_unconfigured", 503, true);
    if (typeof WebSocketImpl !== "function") throw speechError("speech_websocket_unavailable", 503, true);
  }

  function connect({ host, path, onOpen, onPayload }) {
    requireAvailable();
    const url = buildIflytekSignedUrl({
      host,
      path,
      apiKey: env.IFLYTEK_API_KEY,
      apiSecret: env.IFLYTEK_API_SECRET,
      now,
    });
    const socket = new WebSocketImpl(url);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimer(() => finish(reject, speechError("speech_timeout", 504, true)), timeoutMs);

      function cleanup() {
        clearTimer(timer);
        socket.removeEventListener?.("open", handleOpen);
        socket.removeEventListener?.("message", handleMessage);
        socket.removeEventListener?.("error", handleError);
        socket.removeEventListener?.("close", handleClose);
      }

      function finish(callback, value) {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.close();
        } catch {
          // The result is already settled; close errors are not actionable.
        }
        callback(value);
      }

      function handleOpen() {
        try {
          onOpen(socket);
        } catch {
          finish(reject, speechError("speech_request_failed"));
        }
      }

      function handleMessage(event) {
        try {
          const payload = parseProviderMessage(event);
          if (Number(payload.code || 0) !== 0) {
            finish(reject, speechError("speech_provider_error"));
            return;
          }
          const result = onPayload(payload);
          if (result?.done) finish(resolve, result.value);
        } catch (error) {
          finish(reject, error?.code ? error : speechError("speech_invalid_response"));
        }
      }

      function handleError() {
        finish(reject, speechError("speech_connection_failed"));
      }

      function handleClose() {
        if (!settled) finish(reject, speechError("speech_connection_closed"));
      }

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("error", handleError);
      socket.addEventListener("close", handleClose);
    });
  }

  async function transcribe({ audio, sampleRate = 16000, language = "zh_cn" } = {}) {
    const startedAt = Date.now();
    const pcm = Buffer.from(audio || []);
    if (sampleRate !== 16000) throw speechError("speech_sample_rate_invalid", 400, false);
    if (!pcm.byteLength) throw speechError("speech_audio_empty", 400, false);
    if (pcm.byteLength % 2) throw speechError("speech_audio_invalid", 400, false);
    if (pcm.byteLength > MAX_PCM_BYTES) throw speechError("speech_audio_too_large", 413, false);
    const segments = new Map();
    let transcript = "";

    return connect({
      host: "iat-api.xfyun.cn",
      path: "/v2/iat",
      onOpen(socket) {
        const chunks = [];
        for (let offset = 0; offset < pcm.byteLength; offset += IAT_CHUNK_BYTES) {
          chunks.push(pcm.subarray(offset, Math.min(pcm.byteLength, offset + IAT_CHUNK_BYTES)));
        }
        chunks.forEach((chunk, index) => {
          const frame = {
            data: {
              status: index === 0 ? 0 : 1,
              format: `audio/L16;rate=${sampleRate}`,
              encoding: "raw",
              audio: chunk.toString("base64"),
            },
          };
          if (index === 0) {
            frame.common = { app_id: env.IFLYTEK_APP_ID };
            frame.business = {
              language,
              domain: "iat",
              accent: "mandarin",
              dwa: "wpgs",
            };
          }
          sendJson(socket, frame);
        });
        sendJson(socket, {
          data: {
            status: 2,
            format: `audio/L16;rate=${sampleRate}`,
            encoding: "raw",
            audio: "",
          },
        });
      },
      onPayload(payload) {
        if (payload.data?.result) transcript = applyIatResult(segments, payload.data.result);
        if (Number(payload.data?.status) !== 2) return null;
        return {
          done: true,
          value: {
            transcript: transcript.trim(),
            durationMs: Math.max(0, Date.now() - startedAt),
          },
        };
      },
    });
  }

  async function synthesize({ text, voice, encoding = "lame" } = {}) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) throw speechError("speech_text_empty", 400, false);
    if (Buffer.byteLength(normalizedText, "utf8") > MAX_TTS_BYTES) {
      throw speechError("speech_text_too_large", 413, false);
    }
    const audioChunks = [];
    const selectedVoice = voice || env.IFLYTEK_TTS_VOICE || "xiaoyan";

    return connect({
      host: "tts-api.xfyun.cn",
      path: "/v2/tts",
      onOpen(socket) {
        sendJson(socket, {
          common: { app_id: env.IFLYTEK_APP_ID },
          business: {
            aue: encoding,
            auf: "audio/L16;rate=16000",
            vcn: selectedVoice,
            tte: "UTF8",
          },
          data: {
            status: 2,
            text: Buffer.from(normalizedText, "utf8").toString("base64"),
          },
        });
      },
      onPayload(payload) {
        if (payload.data?.audio) audioChunks.push(Buffer.from(payload.data.audio, "base64"));
        if (Number(payload.data?.status) !== 2) return null;
        return {
          done: true,
          value: {
            audio: Buffer.concat(audioChunks),
            mime: encoding === "raw" ? "audio/pcm" : "audio/mpeg",
            encoding,
          },
        };
      },
    });
  }

  return {
    status() {
      return {
        configured,
        transcription: configured,
        synthesis: configured,
        provider: PROVIDER,
      };
    },
    transcribe,
    synthesize,
  };
}
