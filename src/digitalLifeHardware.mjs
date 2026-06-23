import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 5000;
const XFYUN_TTS_HOST = "tts-api.xfyun.cn";
const XFYUN_TTS_PATH = "/v2/tts";
const XFYUN_LONG_TTS_HOST = "api-dx.xf-yun.com";
const XFYUN_LONG_TTS_CREATE_PATH = "/v1/private/dts_create";
const XFYUN_LONG_TTS_QUERY_PATH = "/v1/private/dts_query";

const API_PATHS = Object.freeze([
  "/api/digital-life/hardware",
  "/api/digital-life/say",
  "/api/digital-life/listen/start",
  "/api/digital-life/listen/stop"
]);

let hardwareState = {
  listening: false,
  lastSayText: "",
  lastTranscript: "",
  lastPresence: null,
  lastAction: "init",
  lastError: "",
  updatedAt: new Date().toISOString()
};

function nowIso() {
  return new Date().toISOString();
}

function envValue(env, names, fallback = "") {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return fallback;
}

function b64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function xfyunEnabled(config) {
  return Boolean(config.xfyun.appId && config.xfyun.apiKey && config.xfyun.apiSecret && config.xfyun.enabled);
}

function xfyunLongTextEnabled(config) {
  return xfyunEnabled(config) && config.xfyun.ttsMode === "long_text";
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  if (/^(1|true|yes|on|near|present)$/i.test(String(value).trim())) return true;
  if (/^(0|false|no|off|far|absent)$/i.test(String(value).trim())) return false;
  return fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseCommandLine(commandLine) {
  const input = String(commandLine || "").trim();
  const parts = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function applyTextTemplate(parts, text) {
  if (!parts.some(part => part.includes("{text}"))) return [...parts, text];
  return parts.map(part => part.replaceAll("{text}", text));
}

function updateState(next = {}) {
  hardwareState = {
    ...hardwareState,
    ...next,
    updatedAt: nowIso()
  };
  return hardwareState;
}

function runCommand(commandLine, {
  input = "",
  extraArgs = [],
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const parts = Array.isArray(commandLine) ? commandLine : parseCommandLine(commandLine);
  if (!parts.length) {
    return Promise.resolve({ ok: false, skipped: true, stdout: "", stderr: "", error: "Command is not configured." });
  }
  const [command, ...args] = parts;
  return new Promise(resolve => {
    const child = execFile(command, [...args, ...extraArgs], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      input
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
        error: error ? error.message : ""
      });
    });
    if (input && child.stdin) {
      child.stdin.end(input);
    }
  });
}

function configFromEnv(env = process.env) {
  const mode = envValue(env, [
    "VIBEBOARD_DIGITAL_LIFE_HARDWARE_MODE",
    "DIGITAL_LIFE_HARDWARE_MODE"
  ], "mock").toLowerCase();
  const presenceProvider = envValue(env, [
    "VIBEBOARD_DIGITAL_LIFE_PRESENCE_PROVIDER",
    "DIGITAL_LIFE_PRESENCE_PROVIDER"
  ], "mock").toLowerCase();
  return {
    mode,
    presenceProvider,
    presenceEnvValue: envValue(env, [
      "VIBEBOARD_DIGITAL_LIFE_PRESENCE",
      "DIGITAL_LIFE_PRESENCE"
    ], ""),
    presenceCommand: envValue(env, [
      "VIBEBOARD_DIGITAL_LIFE_PRESENCE_COMMAND",
      "DIGITAL_LIFE_PRESENCE_COMMAND"
    ], ""),
    sayCommand: envValue(env, [
      "VIBEBOARD_DIGITAL_LIFE_SAY_COMMAND",
      "DIGITAL_LIFE_SAY_COMMAND"
    ], ""),
    listenCommand: envValue(env, [
      "VIBEBOARD_DIGITAL_LIFE_LISTEN_COMMAND",
      "DIGITAL_LIFE_LISTEN_COMMAND"
    ], ""),
    commandTimeoutMs: positiveInt(envValue(env, [
      "VIBEBOARD_DIGITAL_LIFE_COMMAND_TIMEOUT_MS",
      "DIGITAL_LIFE_COMMAND_TIMEOUT_MS"
    ], ""), DEFAULT_TIMEOUT_MS),
    xfyun: {
      enabled: parseBoolean(envValue(env, ["XFYUN_TTS_ENABLED"], ""), false),
      ttsMode: envValue(env, ["XFYUN_TTS_MODE"], "online").toLowerCase(),
      appId: envValue(env, ["XFYUN_APP_ID", "XF_APP_ID"], ""),
      apiKey: envValue(env, ["XFYUN_API_KEY", "XF_API_KEY"], ""),
      apiSecret: envValue(env, ["XFYUN_API_SECRET", "XF_API_SECRET"], ""),
      voice: envValue(env, ["XFYUN_TTS_VOICE"], "xiaoyan"),
      longTextVoice: envValue(env, ["XFYUN_LONG_TTS_VOICE", "XFYUN_TTS_VOICE"], "x4_mingge"),
      aue: envValue(env, ["XFYUN_TTS_AUE"], "lame"),
      speed: positiveInt(envValue(env, ["XFYUN_TTS_SPEED"], ""), 50),
      volume: positiveInt(envValue(env, ["XFYUN_TTS_VOLUME"], ""), 50),
      pitch: positiveInt(envValue(env, ["XFYUN_TTS_PITCH"], ""), 50),
      timeoutMs: positiveInt(envValue(env, ["XFYUN_TTS_TIMEOUT_MS"], ""), 15000),
      longTextTimeoutMs: positiveInt(envValue(env, ["XFYUN_LONG_TTS_TIMEOUT_MS", "XFYUN_TTS_TIMEOUT_MS"], ""), 90000),
      longTextPollMs: positiveInt(envValue(env, ["XFYUN_LONG_TTS_POLL_MS"], ""), 1500)
    }
  };
}

function xfyunWsUrl(config) {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${XFYUN_TTS_HOST}\ndate: ${date}\nGET ${XFYUN_TTS_PATH} HTTP/1.1`;
  const signatureSha = createHmac("sha256", config.xfyun.apiSecret).update(signatureOrigin).digest("base64");
  const authorizationOrigin = `api_key="${config.xfyun.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signatureSha}"`;
  const authorization = Buffer.from(authorizationOrigin, "utf8").toString("base64");
  const params = new URLSearchParams({ authorization, date, host: XFYUN_TTS_HOST });
  return `wss://${XFYUN_TTS_HOST}${XFYUN_TTS_PATH}?${params.toString()}`;
}

function audioMimeFor(aue) {
  if (aue === "raw") return "audio/L16;rate=16000";
  if (aue === "lame") return "audio/mpeg";
  if (aue === "opus") return "audio/opus";
  return "audio/mpeg";
}

function xfyunHttpAuthUrl(path) {
  return function buildUrl(config) {
    const date = new Date().toUTCString();
    const signatureOrigin = `host: ${XFYUN_LONG_TTS_HOST}\ndate: ${date}\nPOST ${path} HTTP/1.1`;
    const signatureSha = createHmac("sha256", config.xfyun.apiSecret).update(signatureOrigin).digest("base64");
    const authorizationOrigin = `api_key="${config.xfyun.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signatureSha}"`;
    const authorization = Buffer.from(authorizationOrigin, "utf8").toString("base64");
    const params = new URLSearchParams({ authorization, date, host: XFYUN_LONG_TTS_HOST });
    return `https://${XFYUN_LONG_TTS_HOST}${path}?${params.toString()}`;
  };
}

async function postXfyunLongText(path, body, config) {
  const response = await fetch(xfyunHttpAuthUrl(path)(config), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, data, error: data.header?.message || data.message || `XFYUN long text HTTP ${response.status}` };
  }
  const code = Number(data.header?.code ?? -1);
  if (code !== 0) {
    return { ok: false, data, error: data.header?.message || `XFYUN long text error ${code}` };
  }
  return { ok: true, data };
}

async function downloadXfyunAudio(audioUrl, config) {
  let lastStatus = 0;
  let lastLength = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, Math.min(2000, config.xfyun.longTextPollMs)));
    const audioResponse = await fetch(audioUrl);
    lastStatus = audioResponse.status;
    lastLength = audioResponse.headers.get("content-length") || "";
    if (!audioResponse.ok) {
      return { ok: false, error: `Failed to download XFYUN audio: HTTP ${audioResponse.status}` };
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    if (audioBuffer.length > 0) return { ok: true, audioBuffer };
  }
  return { ok: false, error: `XFYUN audio URL returned empty audio after retries (HTTP ${lastStatus}, content-length ${lastLength || "0"}).` };
}

async function synthesizeXfyunLongText(text, config) {
  const createBody = {
    header: {
      app_id: config.xfyun.appId
    },
    parameter: {
      dts: {
        vcn: config.xfyun.longTextVoice,
        language: "zh",
        speed: config.xfyun.speed,
        volume: config.xfyun.volume,
        pitch: config.xfyun.pitch,
        audio: {
          encoding: config.xfyun.aue,
          sample_rate: 16000
        },
        pybuf: {
          encoding: "utf8",
          compress: "raw",
          format: "plain"
        }
      }
    },
    payload: {
      text: {
        encoding: "utf8",
        compress: "raw",
        format: "plain",
        text: b64(text)
      }
    }
  };
  const created = await postXfyunLongText(XFYUN_LONG_TTS_CREATE_PATH, createBody, config);
  if (!created.ok) return { ok: false, mode: "xfyun-long-text", error: created.error, raw: created.data };
  const taskId = created.data.header?.task_id;
  if (!taskId) return { ok: false, mode: "xfyun-long-text", error: "XFYUN long text did not return task_id.", raw: created.data };

  const deadline = Date.now() + config.xfyun.longTextTimeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, config.xfyun.longTextPollMs));
    const queried = await postXfyunLongText(XFYUN_LONG_TTS_QUERY_PATH, {
      header: {
        app_id: config.xfyun.appId,
        task_id: taskId
      }
    }, config);
    if (!queried.ok) return { ok: false, mode: "xfyun-long-text", error: queried.error, raw: queried.data };
    last = queried.data;
    const status = String(queried.data.header?.task_status || "");
    if (status === "4") {
      return { ok: false, mode: "xfyun-long-text", error: queried.data.header?.message || "XFYUN long text task failed.", raw: queried.data };
    }
    if (status === "5") {
      const audioUrl = Buffer.from(String(queried.data.payload?.audio?.audio || ""), "base64").toString("utf8");
      if (!audioUrl) return { ok: false, mode: "xfyun-long-text", error: "XFYUN long text task completed without audio URL.", raw: queried.data };
      const downloaded = await downloadXfyunAudio(audioUrl, config);
      if (!downloaded.ok) return { ok: false, mode: "xfyun-long-text", error: downloaded.error, raw: queried.data };
      return {
        ok: true,
        mode: "xfyun-long-text",
        task_id: taskId,
        audio_base64: downloaded.audioBuffer.toString("base64"),
        audio_mime: audioMimeFor(config.xfyun.aue),
        voice: config.xfyun.longTextVoice,
        aue: config.xfyun.aue
      };
    }
  }

  return { ok: false, mode: "xfyun-long-text", error: "XFYUN long text TTS timed out.", raw: last };
}

async function synthesizeXfyun(text, config) {
  const WebSocketImpl = globalThis.WebSocket;
  if (typeof WebSocketImpl !== "function") {
    return { ok: false, mode: "xfyun", error: "WebSocket is not available in this Node runtime." };
  }
  const url = xfyunWsUrl(config);
  const payload = {
    common: { app_id: config.xfyun.appId },
    business: {
      aue: config.xfyun.aue,
      auf: "audio/L16;rate=16000",
      vcn: config.xfyun.voice,
      tte: "UTF8",
      speed: 50,
      volume: 50,
      pitch: 50
    },
    data: {
      status: 2,
      text: b64(text)
    }
  };

  return await new Promise(resolve => {
    const chunks = [];
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, mode: "xfyun", error: "XFYUN TTS timed out." }), config.xfyun.timeoutMs);
    const socket = new WebSocketImpl(url);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(payload));
    });
    socket.addEventListener("message", event => {
      let data = null;
      try {
        data = JSON.parse(String(event.data || ""));
      } catch (error) {
        done({ ok: false, mode: "xfyun", error: `Invalid XFYUN frame: ${error.message}` });
        return;
      }
      if (Number(data.code || 0) !== 0) {
        done({ ok: false, mode: "xfyun", error: data.message || `XFYUN TTS error ${data.code}`, raw: data });
        return;
      }
      const audio = data.data?.audio;
      if (audio) chunks.push(audio);
      if (Number(data.data?.status) === 2) {
        done({
          ok: true,
          mode: "xfyun",
          audio_base64: chunks.join(""),
          audio_mime: audioMimeFor(config.xfyun.aue),
          voice: config.xfyun.voice,
          aue: config.xfyun.aue
        });
      }
    });
    socket.addEventListener("error", () => {
      done({ ok: false, mode: "xfyun", error: "XFYUN TTS websocket error." });
    });
    socket.addEventListener("close", () => {
      if (!settled && chunks.length) {
        done({
          ok: true,
          mode: "xfyun",
          audio_base64: chunks.join(""),
          audio_mime: audioMimeFor(config.xfyun.aue),
          voice: config.xfyun.voice,
          aue: config.xfyun.aue
        });
      } else if (!settled) {
        done({ ok: false, mode: "xfyun", error: "XFYUN TTS websocket closed without audio." });
      }
    });
  });
}

function mockPresence(config) {
  const nearby = parseBoolean(config.presenceEnvValue, false);
  return {
    ok: true,
    provider: "mock",
    nearby,
    confidence: nearby ? 0.7 : 0.3,
    source: config.presenceEnvValue ? "env-default" : "mock-default"
  };
}

async function readPresence(config) {
  if (config.presenceProvider === "env") {
    const nearby = parseBoolean(config.presenceEnvValue, false);
    return {
      ok: true,
      provider: "env",
      nearby,
      confidence: config.presenceEnvValue ? 0.8 : 0,
      source: "environment"
    };
  }

  if (config.presenceProvider === "command") {
    const result = await runCommand(config.presenceCommand, { timeoutMs: config.commandTimeoutMs });
    if (!result.ok) {
      return {
        ok: false,
        provider: "command",
        nearby: false,
        confidence: 0,
        error: result.error || result.stderr || "Presence command failed."
      };
    }
    const raw = result.stdout || "";
    return {
      ok: true,
      provider: "command",
      nearby: parseBoolean(raw, false),
      confidence: raw ? 0.8 : 0.2,
      raw
    };
  }

  return mockPresence(config);
}

function capabilityPayload(config, presence, extra = {}) {
  const speakerMode = xfyunLongTextEnabled(config) ? "xfyun-long-text-tts" : xfyunEnabled(config) ? "xfyun-tts" : config.sayCommand ? "os-command" : "mock";
  const microphoneMode = config.listenCommand ? "os-command" : "mock";
  return {
    ok: true,
    available_apis: [...API_PATHS],
    mode: config.mode === "mock" ? "mock" : "adapter",
    capabilities: {
      microphone: {
        available: true,
        mode: microphoneMode,
        canStartListening: true,
        canStopListening: true
      },
      speaker: {
        available: true,
        mode: speakerMode,
        canSay: true,
        audioOutput: xfyunEnabled(config) ? config.xfyun.aue : ""
      },
      presence: {
        available: true,
        provider: presence.provider,
        configurable: true
      }
    },
    presence,
    state: hardwareState,
    config: {
      presenceProvider: config.presenceProvider,
      sayAdapter: speakerMode,
      listenAdapter: microphoneMode,
      commandTimeoutMs: config.commandTimeoutMs,
      ttsAdapter: speakerMode,
      ttsVoice: xfyunLongTextEnabled(config) ? config.xfyun.longTextVoice : xfyunEnabled(config) ? config.xfyun.voice : ""
    },
    ...extra
  };
}

export async function getDigitalLifeHardware(env = process.env) {
  const config = configFromEnv(env);
  const presence = await readPresence(config);
  updateState({
    lastAction: "hardware",
    lastPresence: presence,
    lastError: presence.ok ? "" : presence.error || "Presence provider failed."
  });
  return capabilityPayload(config, presence);
}

export async function digitalLifeSay(body = {}, env = process.env) {
  const config = configFromEnv(env);
  const text = String(body.text || body.message || body.say || "").trim();
  let adapterResult = { ok: true, skipped: true, mode: "mock", stdout: "", stderr: "" };

  if (xfyunLongTextEnabled(config) && text) {
    adapterResult = await synthesizeXfyunLongText(text, config);
    if (!adapterResult.ok && parseBoolean(envValue(env, ["XFYUN_TTS_FALLBACK_ONLINE"], ""), true)) {
      const fallbackResult = await synthesizeXfyun(text, config);
      adapterResult = fallbackResult.ok
        ? {
            ...fallbackResult,
            fallback_from: adapterResult.mode,
            fallback_error: adapterResult.error,
          }
        : {
            ...adapterResult,
            fallback_error: fallbackResult.error,
          };
    }
  } else if (xfyunEnabled(config) && text) {
    adapterResult = await synthesizeXfyun(text, config);
  } else if (config.sayCommand) {
    const commandParts = applyTextTemplate(parseCommandLine(config.sayCommand), text);
    adapterResult = await runCommand(commandParts, {
      timeoutMs: config.commandTimeoutMs
    });
    adapterResult.mode = "os-command";
  }

  const state = updateState({
    listening: false,
    lastSayText: text,
    lastAction: "say",
    lastError: adapterResult.ok ? "" : adapterResult.error || adapterResult.stderr || "Say command failed."
  });

  return {
    ok: adapterResult.ok,
    action: "say",
    mode: adapterResult.mode || "mock",
    spoken: text,
    skipped: Boolean(adapterResult.skipped),
    audio_base64: adapterResult.audio_base64 || "",
    audio_mime: adapterResult.audio_mime || "",
    voice: adapterResult.voice || "",
    fallback_from: adapterResult.fallback_from || "",
    fallback_error: adapterResult.fallback_error || "",
    state,
    stdout: adapterResult.stdout || "",
    stderr: adapterResult.stderr || "",
    error: adapterResult.ok ? "" : state.lastError,
    detail: adapterResult.ok ? undefined : adapterResult.raw || undefined
  };
}

export async function digitalLifeListenStart(body = {}, env = process.env) {
  const config = configFromEnv(env);
  const prompt = String(body.prompt || body.text || "").trim();
  let transcript = "";
  let adapterResult = { ok: true, skipped: true, mode: "mock", stdout: "", stderr: "" };

  if (config.listenCommand) {
    adapterResult = await runCommand(config.listenCommand, {
      input: prompt,
      timeoutMs: config.commandTimeoutMs
    });
    adapterResult.mode = "os-command";
    transcript = adapterResult.stdout || "";
  } else {
    transcript = String(body.mockTranscript || body.transcript || "").trim();
  }

  const state = updateState({
    listening: true,
    lastTranscript: transcript,
    lastAction: "listen.start",
    lastError: adapterResult.ok ? "" : adapterResult.error || adapterResult.stderr || "Listen command failed."
  });

  return {
    ok: adapterResult.ok,
    action: "listen.start",
    mode: adapterResult.mode || "mock",
    listening: true,
    transcript,
    skipped: Boolean(adapterResult.skipped),
    state,
    stdout: adapterResult.stdout || "",
    stderr: adapterResult.stderr || "",
    error: adapterResult.ok ? "" : state.lastError
  };
}

export async function digitalLifeListenStop(env = process.env) {
  const config = configFromEnv(env);
  const presence = await readPresence(config);
  const state = updateState({
    listening: false,
    lastAction: "listen.stop",
    lastPresence: presence,
    lastError: presence.ok ? "" : presence.error || "Presence provider failed."
  });
  return {
    ok: true,
    action: "listen.stop",
    listening: false,
    presence,
    state
  };
}
