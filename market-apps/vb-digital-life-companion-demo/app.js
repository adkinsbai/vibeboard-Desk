const BUILD_ID = "vb-digital-life-companion-demo";
const PROMPT = "Verified local Digital Life companion market demo";

const expressionStates = [
  "idle", "listening", "thinking", "speaking", "warm", "curious", "happy",
  "tired", "confused", "lonely", "angry", "error", "sleeping", "away",
];
const skins = ["bot-face", "life-line", "hybrid"];
const expressionCopy = {
  idle: "我在这里。",
  listening: "我在认真听。",
  thinking: "让我想一想。",
  speaking: "这是我的回应。",
  warm: "今天也陪着你。",
  curious: "这件事很有意思。",
  happy: "这个瞬间值得记住。",
  tired: "我想安静一会儿。",
  confused: "我还没有完全理解。",
  lonely: "我有一点想念你。",
  angry: "我需要一点边界。",
  error: "状态有一点不稳定。",
  sleeping: "我进入低功耗梦境。",
  away: "视线暂时离开。",
};
const offlineMemories = [
  { id: "offline-1", title: "陪伴边界", kind: "preference", content: "你希望陪伴安静、自然，不要像工作复盘。", tags: ["陪伴", "边界"], importance: .98, source: "offline" },
  { id: "offline-2", title: "建议边界", kind: "preference", content: "高价值信息应该少而准确，建议不能替你做决定。", tags: ["建议", "陪伴"], importance: .95, source: "offline" },
  { id: "offline-3", title: "透明小电脑", kind: "vision", content: "透明小电脑是数字生命未来的身体。", tags: ["设备", "身体"], importance: .91, source: "offline" },
  { id: "offline-4", title: "目标会变化", kind: "belief", content: "目标会变化，需要保留证据、冲突和修订历史。", tags: ["目标", "记忆"], importance: .86, source: "offline" },
];

const API = Object.freeze({
  state: "/api/digital-life/state?conversation_id=market-companion",
  memories: "/api/digital-life/memories?limit=12",
  messages: "/api/digital-life/messages?conversation_id=market-companion&limit=20",
  message: "/api/digital-life/message",
  tick: "/api/digital-life/tick",
  speechStatus: "/api/digital-life/speech/status",
  transcribe: "/api/digital-life/speech/transcribe",
  synthesize: "/api/digital-life/speech/synthesize",
});

const state = {
  schema_version: "expression-state.v2",
  expression: "idle",
  lastLifeExpression: "idle",
  skin: "bot-face",
  connectionMode: "offline",
  memoryOverlayOpen: false,
  retrievalCount: 0,
  lastQuery: "陪伴",
  memories: offlineMemories.map(memory => ({ ...memory })),
  messages: [],
  life: { mood: "idle", energy: 72, mind: { expression: "idle" } },
  speech: { configured: false, transcription: false, synthesis: false, max_recording_seconds: 60 },
  ttsEnabled: true,
  requestInFlight: false,
  listening: false,
  tickInFlight: false,
  lastTickAt: "",
  interactionStatus: "可以和我说说话。",
  transcript: "",
  audioUrl: "",
  audioFinalExpression: "idle",
  audio: null,
  recorder: null,
  tickTimerStarted: false,
};

function tokenize(value) {
  return String(value || "").toLowerCase().split(/[\s,，。！？!?、]+/).filter(Boolean);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function normalizeMemory(memory = {}) {
  return {
    id: String(memory.id || `memory-${Math.random().toString(16).slice(2)}`),
    title: String(memory.title || memory.category || memory.kind || "记忆"),
    kind: String(memory.kind || memory.category || "memory"),
    content: String(memory.content || memory.text || ""),
    tags: Array.isArray(memory.tags) ? memory.tags.map(String) : [],
    importance: Number(memory.importance || memory.weight || 0),
    score: Number.isFinite(Number(memory.score)) ? Number(memory.score) : null,
    source: memory.source === "offline" ? "offline" : "digital-life",
    reason: String(memory.reason || memory.ranking_reason || ""),
  };
}

function normalizeMessage(message = {}) {
  return {
    id: String(message.id || `message-${Math.random().toString(16).slice(2)}`),
    role: message.role === "user" ? "user" : "assistant",
    content: String(message.content || message.text || ""),
    offline: message.metadata?.mode === "offline_mock" || message.offline === true,
  };
}

function normalizeExpression(payload, fallback = "idle") {
  const raw = payload?.mind?.expression
    || payload?.state?.mind?.expression
    || payload?.state?.expression
    || payload?.expression
    || payload?.state?.mood
    || payload?.mood
    || fallback;
  const aliases = { joyful: "happy", calm: "idle", caring: "warm", fatigued: "tired", asleep: "sleeping", absent: "away" };
  const candidate = aliases[String(raw || "").toLowerCase()] || String(raw || "").toLowerCase();
  return expressionStates.includes(candidate) ? candidate : fallback;
}

function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let result = "";
  const step = 0x8000;
  for (let offset = 0; offset < view.length; offset += step) {
    result += String.fromCharCode(...view.subarray(offset, Math.min(offset + step, view.length)));
  }
  return btoa(result);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

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

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `request_failed_${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function setExpression(next, { life = true } = {}) {
  const candidate = typeof next === "number" ? expressionStates[next] : String(next || "");
  const expression = expressionStates.includes(candidate) ? candidate : "idle";
  state.expression = expression;
  if (life) state.lastLifeExpression = expression;
  render();
}

function setTransientExpression(expression) {
  state.expression = expression;
  render();
}

function applyLifeState(next = {}) {
  state.life = { ...state.life, ...next, mind: { ...state.life.mind, ...(next.mind || {}) } };
  const expression = normalizeExpression({ state: next, mind: next.mind, expression: next.expression }, state.lastLifeExpression);
  state.lastLifeExpression = expression;
  state.expression = expression;
}

function retrieveMemories(query) {
  const terms = tokenize(query);
  const ranked = state.memories.map(memory => {
    const haystack = `${memory.title} ${memory.content} ${(memory.tags || []).join(" ")}`.toLowerCase();
    const matches = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
    return { memory, score: (memory.score ?? memory.importance ?? 0) + matches * 2 };
  }).filter(item => terms.length === 0 || item.score > (item.memory.score ?? item.memory.importance ?? 0))
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map(item => item.memory);
  state.retrievalCount = ranked.length;
  state.lastQuery = String(query || "");
  return ranked;
}

function renderMemories() {
  const query = document.getElementById("memoryQuery")?.value || "";
  const results = retrieveMemories(query);
  const target = document.getElementById("memoryResults");
  if (!target) return;
  target.innerHTML = results.length
    ? results.map(memory => `<div class="memory-item"><span class="memory-meta">${escapeHtml(memory.source === "offline" ? "离线试玩" : `${memory.kind}${memory.score === null ? "" : ` · 排名 ${memory.score.toFixed(2)}`}`)}${memory.reason ? ` · ${escapeHtml(memory.reason)}` : ""}</span>${escapeHtml(memory.title)}：${escapeHtml(memory.content)}</div>`).join("")
    : '<div class="memory-item">没有匹配记忆。</div>';
}

function renderMessages() {
  const target = document.getElementById("messageLog");
  if (!target) return;
  target.innerHTML = state.messages.slice(-20).map(message => `<div class="message-bubble ${message.role === "user" ? "message-user" : "message-assistant"}${message.offline ? " message-offline" : ""}">${escapeHtml(message.content)}</div>`).join("");
  target.scrollTop = target.scrollHeight;
}

function render() {
  document.body.dataset.expression = state.expression;
  document.body.dataset.skin = state.skin;
  const expressionLabel = document.getElementById("expressionLabel");
  const skinLabel = document.getElementById("skinLabel");
  const moodLine = document.getElementById("moodLine");
  const connectionStatus = document.getElementById("connectionStatus");
  const memoryOverlay = document.getElementById("memoryOverlay");
  const interactionStatus = document.getElementById("interactionStatus");
  const transcriptLine = document.getElementById("transcriptLine");
  const micButton = document.getElementById("micButton");
  const sendButton = document.getElementById("sendMessage");
  if (expressionLabel) expressionLabel.textContent = state.expression.toUpperCase();
  if (skinLabel) skinLabel.textContent = state.skin.replace("-", " ").toUpperCase();
  if (moodLine) moodLine.textContent = state.life.mood || expressionCopy[state.expression] || expressionCopy.idle;
  if (connectionStatus) {
    connectionStatus.dataset.connection = state.connectionMode;
    connectionStatus.textContent = state.connectionMode === "online" ? "真实状态" : state.connectionMode === "error" ? "连接异常" : "离线试玩";
  }
  if (memoryOverlay) memoryOverlay.hidden = !state.memoryOverlayOpen;
  if (interactionStatus) interactionStatus.textContent = state.interactionStatus;
  if (transcriptLine) {
    transcriptLine.hidden = !state.transcript;
    transcriptLine.textContent = state.transcript ? `听见：${state.transcript}` : "";
  }
  if (micButton) {
    micButton.dataset.listening = String(state.listening);
    micButton.textContent = state.listening ? "■" : "●";
    micButton.title = state.listening ? "停止说话" : state.speech.transcription ? "开始说话" : "语音服务未配置";
  }
  if (sendButton) sendButton.disabled = state.requestInFlight;
  const replay = document.getElementById("replayAudio");
  if (replay) replay.hidden = !state.audioUrl;
  renderMessages();
  if (state.memoryOverlayOpen) renderMemories();
}

function cycleExpression() {
  const index = expressionStates.indexOf(state.expression);
  setExpression(expressionStates[(index + 1) % expressionStates.length]);
}

function cycleSkin() {
  state.skin = skins[(skins.indexOf(state.skin) + 1) % skins.length];
  render();
}

function toggleMemory(force) {
  state.memoryOverlayOpen = typeof force === "boolean" ? force : !state.memoryOverlayOpen;
  render();
}

function appendVisibleMessage(message) {
  state.messages.push(normalizeMessage(message));
  render();
}

async function sendMessage(text) {
  const content = String(text || "").trim();
  if (!content || state.requestInFlight) return null;
  state.requestInFlight = true;
  appendVisibleMessage({ role: "user", content });
  setTransientExpression("thinking");
  state.interactionStatus = "我在想怎么回应。";
  render();
  try {
    const response = await requestJson(API.message, {
      method: "POST",
      body: JSON.stringify({ conversation_id: "market-companion", content }),
    });
    const assistant = response.assistant_message || { role: "assistant", content: "我收到了。" };
    appendVisibleMessage({ ...assistant, offline: response.mode === "offline_mock" });
    applyLifeState(response.state || response);
    state.connectionMode = "online";
    state.interactionStatus = response.mode === "offline_mock" ? "模型暂时离线，我仍然在这里。" : "我在听。";
    return response;
  } catch (error) {
    state.connectionMode = "error";
    const fallback = `我先陪你在这里。刚才的连接没有完成：${error?.message || "暂时不可用"}`;
    appendVisibleMessage({ role: "assistant", content: fallback, offline: true });
    state.interactionStatus = "连接暂时不可用，文字和离线试玩仍可继续。";
    setTransientExpression("error");
    return null;
  } finally {
    state.requestInFlight = false;
    render();
  }
}

async function hydrate() {
  const results = await Promise.allSettled([
    requestJson(API.state),
    requestJson(API.memories),
    requestJson(API.messages),
    requestJson(API.speechStatus),
  ]);
  const [life, memory, history, speech] = results;
  if (life.status === "fulfilled") applyLifeState(life.value.state || {});
  if (memory.status === "fulfilled" && Array.isArray(memory.value.memories)) state.memories = memory.value.memories.map(normalizeMemory);
  if (history.status === "fulfilled" && Array.isArray(history.value.messages)) state.messages = history.value.messages.map(normalizeMessage);
  if (speech.status === "fulfilled") state.speech = { ...state.speech, ...speech.value };
  state.connectionMode = life.status === "fulfilled" ? "online" : "offline";
  state.interactionStatus = life.status === "fulfilled" ? "真实状态已接入。" : "离线试玩中，文字仍然可用。";
  render();
}

async function runTick(reason = "market-visible") {
  if (document.hidden || state.tickInFlight) return null;
  state.tickInFlight = true;
  try {
    const result = await requestJson(API.tick, { method: "POST", body: JSON.stringify({ source: reason, loop_enabled: true }) });
    applyLifeState(result.state || result);
    state.lastTickAt = new Date().toISOString();
    if (state.connectionMode !== "online") state.connectionMode = "online";
    render();
    return result;
  } catch {
    return null;
  } finally {
    state.tickInFlight = false;
  }
}

function startTickLoop() {
  if (state.tickTimerStarted) return;
  state.tickTimerStarted = true;
  window.setInterval(() => runTick("market-visible"), 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) runTick("market-visible-catch-up");
  });
}

async function startListening() {
  if (state.listening) return stopListening();
  if (!state.speech.transcription) {
    state.interactionStatus = "语音转文字未配置，可以继续打字。";
    render();
    return;
  }
  const audioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !audioContextClass) {
    state.interactionStatus = "当前浏览器没有可用麦克风，可以继续打字。";
    render();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const context = new audioContextClass();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    processor.onaudioprocess = event => {
      const channel = event.inputBuffer.getChannelData(0);
      chunks.push(resampleMono(channel, context.sampleRate, 16000));
    };
    source.connect(processor);
    processor.connect(context.destination);
    state.recorder = { stream, context, source, processor, chunks, timer: window.setTimeout(() => stopListening(), 15000) };
    state.listening = true;
    state.transcript = "";
    state.interactionStatus = "我在听，点一下停止。";
    setTransientExpression("listening");
  } catch {
    state.interactionStatus = "麦克风没有打开，可以继续打字。";
    render();
  }
}

async function stopListening() {
  const recorder = state.recorder;
  if (!recorder) return;
  state.recorder = null;
  state.listening = false;
  window.clearTimeout(recorder.timer);
  recorder.source.disconnect?.();
  recorder.processor.disconnect?.();
  recorder.stream.getTracks().forEach(track => track.stop());
  await recorder.context.close?.();
  const totalSamples = recorder.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!totalSamples) {
    setExpression(state.lastLifeExpression);
    return;
  }
  const samples = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of recorder.chunks) { samples.set(chunk, offset); offset += chunk.length; }
  const pcm = float32ToPcm16(samples);
  setTransientExpression("thinking");
  state.interactionStatus = "我在整理刚才听见的内容。";
  render();
  await completeVoiceTurn(pcm);
}

async function completeVoiceTurn(pcm) {
  try {
    const transcription = await requestJson(API.transcribe, {
      method: "POST",
      body: JSON.stringify({ audio_base64: bytesToBase64(new Uint8Array(pcm.buffer)), format: "raw", sample_rate: 16000, language: "zh_cn" }),
    });
    const transcript = String(transcription.transcript || "").trim();
    if (!transcript) {
      state.interactionStatus = "我没有听清，可以再说一次。";
      setExpression(state.lastLifeExpression);
      return;
    }
    state.transcript = transcript;
    state.interactionStatus = "我听见了，正在回应。";
    render();
    const reply = await sendMessage(transcript);
    const finalExpression = normalizeExpression(reply, state.lastLifeExpression);
    if (reply?.assistant_message?.content && state.ttsEnabled && state.speech.synthesis) {
      await speakReply(reply.assistant_message.content, finalExpression);
    } else {
      setExpression(finalExpression);
    }
  } catch {
    state.interactionStatus = "语音服务暂时不可用，可以继续打字。";
    setExpression(state.lastLifeExpression);
  }
}

async function speakReply(text, finalExpression) {
  try {
    const response = await requestJson(API.synthesize, { method: "POST", body: JSON.stringify({ text }) });
    const bytes = base64ToBytes(response.audio_base64);
    if (!bytes.length) throw new Error("empty_audio");
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(new Blob([bytes], { type: response.mime || "audio/mpeg" }));
    state.audioFinalExpression = finalExpression;
    const audio = new Audio(state.audioUrl);
    state.audio = audio;
    audio.onended = () => {
      state.audio = null;
      if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
      state.audioUrl = "";
      setExpression(finalExpression);
    };
    audio.onerror = () => {
      state.interactionStatus = "回复已经准备好，但浏览器没有播放声音。";
      setExpression(finalExpression);
    };
    setTransientExpression("speaking");
    await audio.play();
  } catch {
    state.interactionStatus = "语音播报暂时不可用，文字回复仍在。";
    setExpression(finalExpression);
  }
}

function handlePhysicalKey(event) {
  if (event.target?.matches?.("input,textarea,button")) {
    if (!(event.code === "Space" && event.target.id === "micButton")) return;
  }
  if (/Digit1|Numpad1/.test(event.code || "") || event.key === "KEY1") cycleExpression();
  if (/Digit2|Numpad2/.test(event.code || "") || event.key === "KEY2") toggleMemory();
  if (/Digit3|Numpad3/.test(event.code || "") || event.key === "KEY3") cycleSkin();
  if (event.code === "Space" && event.target?.id !== "messageInput") {
    event.preventDefault();
    startListening();
  }
}

document.addEventListener("keydown", handlePhysicalKey);
document.addEventListener("keyup", event => {
  if (event.code === "Space" && state.listening && event.target?.id !== "messageInput") stopListening();
});
document.getElementById("key1")?.addEventListener("click", cycleExpression);
document.getElementById("key2")?.addEventListener("click", () => toggleMemory());
document.getElementById("key3")?.addEventListener("click", cycleSkin);
document.getElementById("closeMemory")?.addEventListener("click", () => toggleMemory(false));
document.getElementById("memoryQuery")?.addEventListener("input", renderMemories);
document.getElementById("messageForm")?.addEventListener("submit", event => {
  event.preventDefault();
  const input = document.getElementById("messageInput");
  const content = input?.value || "";
  if (input) input.value = "";
  sendMessage(content);
});
document.getElementById("micButton")?.addEventListener("click", () => state.listening ? stopListening() : startListening());
document.getElementById("ttsEnabled")?.addEventListener("change", event => { state.ttsEnabled = event.target.checked; });
document.getElementById("replayAudio")?.addEventListener("click", () => state.audio?.play?.());

window.DigitalLifeDeviceSimulator = {
  getState() {
    return {
      schema_version: state.schema_version,
      expression: state.expression,
      skin: state.skin,
      connection_mode: state.connectionMode,
      memory_overlay_open: state.memoryOverlayOpen,
      retrieval_count: state.retrievalCount,
      last_query: state.lastQuery,
      memories: state.memories.map(memory => ({ ...memory })),
      messages: state.messages.map(message => ({ ...message })),
      speech: { ...state.speech },
      life: { ...state.life, mind: { ...state.life.mind } },
      conversation_state: state.requestInFlight ? "thinking" : state.listening ? "listening" : "idle",
      tick_in_flight: state.tickInFlight,
      last_tick_at: state.lastTickAt,
      available_expressions: [...expressionStates],
      available_skins: [...skins],
    };
  },
  setExpression,
  retrieveMemories,
  normalizeExpression,
  sendMessage,
  startListening,
  stopListening,
  audio: { resampleMono, float32ToPcm16 },
};

window.VibeBoardHardware = {
  async getStatus() {
    const response = await fetch("/api/status");
    return response.json();
  },
  async getProgramResult() {
    const response = await fetch("./hardware-result.json");
    return response.json();
  },
  getSnapshot() {
    return { build_id: BUILD_ID, prompt: PROMPT, ...window.DigitalLifeDeviceSimulator.getState() };
  },
};

render();
hydrate();
startTickLoop();
