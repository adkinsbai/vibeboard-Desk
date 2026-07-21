import { createIflytekSpeechClient } from "./iflytekSpeech.mjs";

const MAX_RECORDING_SECONDS = 60;
const MAX_PCM_BYTES = 16000 * 2 * MAX_RECORDING_SECONDS;
const MAX_TTS_BYTES = 8000;
const VOICES = new Set(["xiaoyan", "aisjiuxu", "aisxping", "aisjinger"]);

function routeError(code, statusCode = 400, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  error.retryable = retryable;
  return error;
}

function decodePcm(body = {}) {
  if (body.format !== "raw") throw routeError("speech_format_invalid");
  if (body.sample_rate !== 16000) throw routeError("speech_sample_rate_invalid");
  if (typeof body.audio_base64 !== "string" || !body.audio_base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.audio_base64) || body.audio_base64.length % 4 !== 0) {
    throw routeError("speech_audio_invalid");
  }
  const audio = Buffer.from(body.audio_base64, "base64");
  if (!audio.byteLength) throw routeError("speech_audio_empty");
  if (audio.byteLength % 2) throw routeError("speech_audio_invalid");
  if (audio.byteLength > MAX_PCM_BYTES) throw routeError("speech_audio_too_large", 413);
  return audio;
}

function validateText(value) {
  const text = String(value || "").trim();
  if (!text) throw routeError("speech_text_empty");
  if (Buffer.byteLength(text, "utf8") > MAX_TTS_BYTES) throw routeError("speech_text_too_large", 413);
  return text;
}

function validateVoice(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!VOICES.has(String(value))) throw routeError("speech_voice_invalid");
  return String(value);
}

export function createDigitalLifeSpeechRoutes({ readBody, json, speechClient, env } = {}) {
  if (typeof readBody !== "function") throw new Error("createDigitalLifeSpeechRoutes requires readBody");
  if (typeof json !== "function") throw new Error("createDigitalLifeSpeechRoutes requires json");
  const client = speechClient || createIflytekSpeechClient({ env });

  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/digital-life/speech")) return false;

    try {
      if (req.method === "GET" && url.pathname === "/api/digital-life/speech/status") {
        const status = client.status();
        json(res, 200, {
          ok: true,
          configured: Boolean(status.configured),
          transcription: Boolean(status.transcription),
          synthesis: Boolean(status.synthesis),
          max_recording_seconds: MAX_RECORDING_SECONDS,
        });
        return true;
      }

      if (req.method === "POST" && url.pathname === "/api/digital-life/speech/transcribe") {
        const body = await readBody(req);
        const audio = decodePcm(body);
        const result = await client.transcribe({ audio, sampleRate: 16000, language: "zh_cn" });
        json(res, 200, { ok: true, transcript: String(result.transcript || "").trim(), provider: "iflytek" });
        return true;
      }

      if (req.method === "POST" && url.pathname === "/api/digital-life/speech/synthesize") {
        const body = await readBody(req);
        const text = validateText(body?.text);
        const voice = validateVoice(body?.voice);
        const result = await client.synthesize({ text, voice, encoding: "lame" });
        json(res, 200, {
          ok: true,
          audio_base64: Buffer.from(result.audio || []).toString("base64"),
          mime: "audio/mpeg",
          provider: "iflytek",
        });
        return true;
      }

      return false;
    } catch (error) {
      json(res, error?.statusCode || 502, {
        ok: false,
        error: error?.code || "speech_unavailable",
        retryable: error?.retryable !== false,
      });
      return true;
    }
  }

  return { handle };
}
