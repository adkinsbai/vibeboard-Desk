import { createDigitalLifeExpression } from "./digital-life-expression.js?v=line-20260618-emotion2";

const app = document.querySelector(".life-app");
const expressionCanvas = document.getElementById("lifeExpression");
const messageLog = document.getElementById("messageLog");
const newMessagesNotice = document.getElementById("newMessagesNotice");
const memoryList = document.getElementById("memoryList");
const memoryForm = document.getElementById("memoryForm");
const memoryTitle = document.getElementById("memoryTitle");
const memoryContent = document.getElementById("memoryContent");
const journalList = document.getElementById("journalList");
const lifeComposer = document.getElementById("lifeComposer");
const lifeInput = document.getElementById("lifeInput");
const listenBtn = document.getElementById("listenBtn");
const tickBtn = document.getElementById("tickBtn");
const reflectBtn = document.getElementById("reflectBtn");
const refreshBtn = document.getElementById("refreshBtn");
const loopToggle = document.getElementById("loopToggle");
const loopStatus = document.getElementById("loopStatus");
const runtimeLabel = document.getElementById("runtimeLabel");
const vitalsGrid = document.getElementById("vitalsGrid");
const innerStateSummary = document.getElementById("innerStateSummary");
const rewardBtn = document.getElementById("rewardBtn");
const penaltyBtn = document.getElementById("penaltyBtn");
const mindPanel = document.getElementById("mindPanel");
const webForm = document.getElementById("webForm");
const webUrl = document.getElementById("webUrl");
const actionList = document.getElementById("actionList");
const autonomySummary = document.getElementById("autonomySummary");
const cognitionList = document.getElementById("cognitionList");
const cognitionSummary = document.getElementById("cognitionSummary");
const modelToggle = document.getElementById("modelToggle");
const modelPanel = document.getElementById("modelPanel");
const modelProvider = document.getElementById("modelProvider");
const modelBaseUrl = document.getElementById("modelBaseUrl");
const modelName = document.getElementById("modelName");
const modelApiKey = document.getElementById("modelApiKey");
const modelStatus = document.getElementById("modelStatus");

const MODEL_STORAGE_KEY = "vibeboard-digital-life-model-settings";
const providerDefaults = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
  minimax: { baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M2.7" },
  custom: { baseUrl: "", model: "" },
};

const stateMeta = {
  idle: { label: "idle", mood: "calm", energy: 78 },
  sleep: { label: "sleep", mood: "resting", energy: 14 },
  listening: { label: "listening", mood: "attentive", energy: 82 },
  thinking: { label: "thinking", mood: "reflective", energy: 70 },
  speaking: { label: "speaking", mood: "warm", energy: 68 },
  angry: { label: "angry", mood: "heated", energy: 76 },
  happy: { label: "happy", mood: "bright", energy: 84 },
  lonely: { label: "lonely", mood: "quietly lonely", energy: 38 },
  nearby: { label: "nearby", mood: "present", energy: 86 },
  away: { label: "away", mood: "quiet", energy: 34 },
};

let loopTimer = null;
const REFRESH_INTERVAL_MS = 8000;
let lastLifeSnapshot = null;
let activeSpeechAudio = null;
let audioContext = null;
let analyser = null;
let speechFrame = 0;
let lastServerMessages = [];
let optimisticMessages = [];
let renderedMessageSignature = "";
let inputComposing = false;
let manualVisualState = "";
let manualVisualUntil = 0;
const expression = expressionCanvas
  ? createDigitalLifeExpression(expressionCanvas, {
      reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches,
    })
  : null;

function el(id) {
  return document.getElementById(id);
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || `${path} failed with HTTP ${response.status}`);
  }
  return data;
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

function setLifeState(state, patch = {}) {
  const next = stateMeta[state] ? state : "idle";
  const meta = { ...stateMeta[next], ...patch };
  app.dataset.lifeState = next;
  setText("lifeStateLabel", meta.label);
  setText("lifeMood", meta.mood);
  document.querySelectorAll("[data-life-state]").forEach(button => {
    button.setAttribute("aria-pressed", button.dataset.lifeState === next ? "true" : "false");
  });
  expression?.setState({
    state: next,
    mood: meta.mood,
    energy: (meta.energy ?? 70) / 100,
    ...(meta.affect || {}),
  });
}

function deriveExpressionState(state, requested = "idle") {
  if (manualVisualState && Date.now() < manualVisualUntil) return manualVisualState;
  manualVisualState = "";
  if (["listening", "thinking", "speaking"].includes(requested)) return requested;
  const needs = state?.needs || {};
  if (state?.mind?.visual_state && stateMeta[state.mind.visual_state]) return state.mind.visual_state;
  const affect = state?.mind?.expression || state?.expression || state?.affect || needs.affect || needs;
  const energy = Number(state?.energy ?? 70) / 100;
  const valence = Number(affect.valence || 0);
  const stress = Number(affect.stress || 0);
  const anger = Number(affect.anger || 0);
  const loneliness = Number(affect.loneliness || 0);
  const arousal = Number(affect.arousal || 0);
  const dopamine = Number(affect.dopamine || 0);
  const mood = String(affect.mood || state?.brain?.mood_label || state?.mood || "").toLowerCase();
  if (requested === "away") return energy < 0.2 ? "sleep" : "away";
  if (energy < 0.16 || mood.includes("sleep") || mood.includes("rest")) return "sleep";
  if (anger > 0.55 || (stress > 0.66 && (valence < 0.12 || arousal > 0.65))) return "angry";
  if (loneliness > 0.64 && valence < 0.28) return "lonely";
  if (valence > 0.42 && dopamine > -0.1) return "happy";
  if (requested === "nearby") return "nearby";
  return "idle";
}

function holdManualVisualState(state, durationMs = 9000) {
  if (!stateMeta[state]) return;
  manualVisualState = state;
  manualVisualUntil = Date.now() + durationMs;
}

function loadModelSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) || "{}");
    const provider = providerDefaults[saved.provider] ? saved.provider : "deepseek";
    const defaults = providerDefaults[provider];
    return {
      provider,
      baseUrl: saved.baseUrl || defaults.baseUrl,
      model: saved.model || defaults.model,
      apiKey: saved.apiKey || "",
    };
  } catch {
    return { provider: "deepseek", ...providerDefaults.deepseek, apiKey: "" };
  }
}

function saveModelSettings(settings) {
  localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(settings));
}

function syncModelForm(settings = loadModelSettings()) {
  modelProvider.value = settings.provider;
  modelBaseUrl.value = settings.baseUrl;
  modelName.value = settings.model;
  modelApiKey.value = settings.apiKey;
  modelStatus.textContent = settings.apiKey && settings.baseUrl && settings.model
    ? `${settings.provider} ready`
    : "using server model";
}

function currentModelSettings() {
  const settings = {
    provider: modelProvider.value,
    baseUrl: modelBaseUrl.value.trim(),
    model: modelName.value.trim(),
    apiKey: modelApiKey.value.trim(),
  };
  return settings.apiKey && settings.baseUrl && settings.model ? settings : {};
}

async function syncPresence(state) {
  const meta = stateMeta[state] || stateMeta.idle;
  try {
    await jsonFetch("/api/digital-life/presence", {
      method: "POST",
      body: JSON.stringify({
        status: state === "away" ? "away" : "present",
        activity: state,
        mood: meta.mood,
        energy: meta.energy,
      }),
    });
  } catch (error) {
    appendMessage("assistant", `Presence sync failed: ${error.message}`);
  }
}

function appendMessage(role, content, options = {}) {
  const article = document.createElement("article");
  article.className = `msg ${role}${options.pending ? " pending" : ""}${options.autonomous ? " autonomous" : ""}`;
  const small = document.createElement("small");
  const repeat = options.repeatCount > 1 ? ` ×${options.repeatCount}` : "";
  small.textContent = `${options.label || (role === "user" ? "you" : "vibe")}${repeat}`;
  const body = document.createElement("div");
  body.textContent = displayMessageContent(role, content);
  article.append(small, body);
  messageLog.appendChild(article);
}

function displayMessageContent(role, content) {
  let text = String(content || "");
  if (role !== "user") {
    text = text
      .replace(/^\s*[（(][^）)]{0,180}[）)]\s*/u, "")
      .replace(/\b主人\b/g, "你")
      .replace(/主人/g, "你");
  }
  return text.trim() || String(content || "");
}

function isMessageLogNearBottom() {
  if (!messageLog) return true;
  const distance = messageLog.scrollHeight - messageLog.scrollTop - messageLog.clientHeight;
  return distance < 72;
}

function scrollMessageLogToBottom() {
  if (!messageLog) return;
  messageLog.scrollTop = messageLog.scrollHeight;
  if (newMessagesNotice) newMessagesNotice.hidden = true;
}

function messageSignature(messages = []) {
  return messages
    .map(message => `${message.id || ""}:${message.role}:${message.pending ? "pending" : "sent"}:${message.content}`)
    .join("|");
}

function compactMessageList(messages = []) {
  const compacted = [];
  for (const message of messages) {
    const previous = compacted[compacted.length - 1];
    const sameAutonomous = previous
      && previous.role === message.role
      && previous.content === message.content
      && previous.metadata?.mode === "autonomous"
      && message.metadata?.mode === "autonomous";
    if (sameAutonomous) {
      previous.repeatCount = (previous.repeatCount || 1) + 1;
    } else {
      compacted.push({ ...message, repeatCount: message.repeatCount || 1 });
    }
  }
  return compacted;
}

function makeLocalMessage(role, content) {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    pending: true,
  };
}

function mergeMessageLists(serverMessages = [], localMessages = []) {
  const seen = new Set();
  const merged = [];
  for (const message of [...serverMessages, ...localMessages]) {
    const id = message.id || `${message.role}:${message.content}`;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(message);
  }
  return merged;
}

function renderMessages(messages = [], options = {}) {
  const { forceScroll = false, showNotice = true } = options;
  const visibleMessages = mergeMessageLists(messages, optimisticMessages);
  const chatMessages = compactMessageList(visibleMessages);
  const signature = messageSignature(chatMessages) || "empty-thread";
  if (!forceScroll && signature === renderedMessageSignature) return;
  const wasNearBottom = isMessageLogNearBottom();
  const previousHeight = messageLog.scrollHeight;
  const previousTop = messageLog.scrollTop;
  messageLog.innerHTML = "";
  const changed = signature !== renderedMessageSignature;
  renderedMessageSignature = signature;
  if (!chatMessages.length) {
    appendMessage("assistant", "I am running as a local-first digital life companion. Tell me something to remember.");
    scrollMessageLogToBottom();
    return;
  }
  for (const message of chatMessages) {
    appendMessage(
      message.role === "user" ? "user" : "assistant",
      message.content,
      {
        pending: Boolean(message.pending),
        label: message.pending
          ? (message.role === "user" ? "you - sending" : "vibe")
          : message.metadata?.mode === "autonomous" ? "vibe - autonomous" : "",
        autonomous: message.metadata?.mode === "autonomous",
        repeatCount: message.repeatCount || 1,
      }
    );
  }
  if (forceScroll || wasNearBottom) {
    scrollMessageLogToBottom();
  } else {
    messageLog.scrollTop = Math.max(0, previousTop + (messageLog.scrollHeight - previousHeight));
    if (newMessagesNotice && showNotice && changed) newMessagesNotice.hidden = false;
  }
}

function renderList(target, items, emptyText) {
  target.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "memory-item";
    empty.innerHTML = `<b>Empty</b><span>${emptyText}</span>`;
    target.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "memory-item";
    const title = item.title || item.entry_type || item.kind || item.action_type || item.event_type || "Memory";
    const content = item.content || item.output?.summary || item.reason || "";
    row.innerHTML = `<b></b><span></span>`;
    row.querySelector("b").textContent = title;
    row.querySelector("span").textContent = content;
    target.appendChild(row);
  }
}

function formatLevel(value) {
  return Math.round(Math.min(1, Math.max(0, Number(value || 0))) * 100);
}

function affectTone(affect = {}) {
  const valence = Number(affect.valence || 0);
  const anger = Number(affect.anger || 0);
  const loneliness = Number(affect.loneliness || 0);
  const stress = Number(affect.stress || 0);
  const trust = Number(affect.trust || 0);
  if (anger > 0.58) return "需要安抚";
  if (loneliness > 0.62) return "想靠近你";
  if (stress > 0.64) return "紧绷";
  if (valence > 0.42 && trust > 0.42) return "明亮";
  if (valence < -0.18) return "低落";
  return "平稳";
}

function renderInnerState(state = {}) {
  if (!innerStateSummary) return;
  const needs = state?.needs || {};
  const affect = state?.affect || needs.affect || needs;
  const personality = state?.personality || needs.personality || {};
  const bars = [
    ["愉悦", formatLevel((Number(affect.valence || 0) + 1) / 2), "valence"],
    ["唤醒", formatLevel(affect.arousal), "arousal"],
    ["压力", formatLevel(affect.stress), "stress"],
    ["怒意", formatLevel(affect.anger), "anger"],
    ["孤独", formatLevel(affect.loneliness), "loneliness"],
    ["信任", formatLevel(affect.trust), "trust"],
  ];
  innerStateSummary.innerHTML = "";
  const head = document.createElement("div");
  head.className = "inner-state-head";
  head.innerHTML = `<b></b><span></span>`;
  head.querySelector("b").textContent = affectTone(affect);
  head.querySelector("span").textContent = `${Math.round(state.energy ?? 0)}% energy · open ${formatLevel(personality.openness)}`;
  innerStateSummary.appendChild(head);
  const list = document.createElement("div");
  list.className = "affect-bars";
  for (const [label, value, key] of bars) {
    const row = document.createElement("div");
    row.className = `affect-bar ${key}`;
    row.innerHTML = `<span></span><i><em></em></i><b></b>`;
    row.querySelector("span").textContent = label;
    row.querySelector("em").style.width = `${value}%`;
    row.querySelector("b").textContent = `${value}`;
    list.appendChild(row);
  }
  innerStateSummary.appendChild(list);
}

function renderAutonomy(actions = [], runtime = {}, state = {}) {
  if (!autonomySummary) return;
  const latest = actions[0];
  const activity = state?.presence?.activity || "idle";
  const loopEnabled = Boolean(runtime?.enabled ?? state?.loop_enabled);
  autonomySummary.innerHTML = "";
  const rows = [
    ["loop", loopEnabled ? "自主循环开启" : "手动模式"],
    ["activity", activity],
    ["last", latest?.action_type || "waiting"],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "autonomy-row";
    row.innerHTML = `<span></span><b></b>`;
    row.querySelector("span").textContent = label;
    row.querySelector("b").textContent = value;
    autonomySummary.appendChild(row);
  }
}

function renderCognition(cognition = {}) {
  if (!cognitionList) return;
  if (cognitionSummary) {
    const concept = cognition.concepts?.[0]?.label || "还在形成概念";
    const hypothesisCount = cognition.hypotheses?.length || 0;
    cognitionSummary.textContent = `${concept} · ${hypothesisCount} hypotheses`;
  }
  cognitionList.innerHTML = "";
  const rows = [
    ...(cognition.concepts || []).slice(0, 3).map(item => ({
      title: item.label,
      body: item.summary,
      meta: `concept ${Math.round((item.confidence || 0) * 100)}%`,
    })),
    ...(cognition.hypotheses || []).slice(0, 3).map(item => ({
      title: "Hypothesis",
      body: item.statement,
      meta: `${Math.round((item.confidence || 0) * 100)}% · ${item.next_test || "needs test"}`,
    })),
    ...(cognition.experiments || []).slice(0, 2).map(item => ({
      title: "Next Test",
      body: item.question,
      meta: item.status || "pending",
    })),
  ];
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "memory-item";
    empty.innerHTML = `<b>Empty</b><span>她还没有足够观察来抽象规律。</span>`;
    cognitionList.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const node = document.createElement("div");
    node.className = "memory-item cognition-item";
    node.innerHTML = `<b></b><span></span><small></small>`;
    node.querySelector("b").textContent = row.title;
    node.querySelector("span").textContent = row.body;
    node.querySelector("small").textContent = row.meta;
    cognitionList.appendChild(node);
  }
}

function renderVitals(state) {
  const needs = state?.needs || {};
  const affect = state?.affect || needs.affect || needs;
  const personality = state?.personality || needs.personality || {};
  const brain = state?.brain || needs.brain || {};
  const items = [
    ["energy", `${Math.round(state?.energy ?? 0)}%`],
    ["mood", brain.mood_label || state?.mood || "calm"],
    ["valence", Number(affect.valence || 0).toFixed(2)],
    ["arousal", Number(affect.arousal || 0).toFixed(2)],
    ["stress", Number(affect.stress || 0).toFixed(2)],
    ["anger", Number(affect.anger || 0).toFixed(2)],
  ];
  vitalsGrid.innerHTML = items.map(([label, value]) => (
    `<div class="vital"><span>${label}</span><b>${value}</b></div>`
  )).join("");
}

function renderMindPanel(state = {}) {
  if (!mindPanel) return;
  const mind = state?.mind || {};
  const consciousness = mind.consciousness || {};
  const goals = Array.isArray(mind.goals) ? mind.goals.slice(0, 4) : [];
  const attention = Array.isArray(mind.attention) ? mind.attention.slice(0, 4) : [];
  const traces = Array.isArray(mind.memory_traces) ? mind.memory_traces.slice(0, 4) : [];
  mindPanel.innerHTML = "";

  const head = document.createElement("div");
  head.className = "mind-head";
  head.innerHTML = `<b></b><span></span>`;
  head.querySelector("b").textContent = mind.visual_state || "idle";
  head.querySelector("span").textContent = `${mind.phase || "day"} · ${mind.visual_reason || "regulated baseline"}`;
  mindPanel.appendChild(head);

  const meters = document.createElement("div");
  meters.className = "mind-meters";
  for (const [label, raw] of [
    ["continuity", consciousness.continuity_score],
    ["agency", consciousness.agency_score],
    ["regulation", consciousness.regulation_score],
  ]) {
    const value = formatLevel(raw);
    const row = document.createElement("div");
    row.className = "mind-meter";
    row.innerHTML = `<span></span><i><em></em></i><b></b>`;
    row.querySelector("span").textContent = label;
    row.querySelector("em").style.width = `${value}%`;
    row.querySelector("b").textContent = `${value}`;
    meters.appendChild(row);
  }
  mindPanel.appendChild(meters);

  const groups = document.createElement("div");
  groups.className = "mind-groups";
  groups.appendChild(renderMindGroup("goals", goals.map(goal => ({
    title: goal.label || goal.id,
    meta: `${Math.round((goal.tension || 0) * 100)} tension · ${goal.action_bias || "wait"}`,
  }))));
  groups.appendChild(renderMindGroup("attention", attention.map(item => ({
    title: item.label || item.kind,
    meta: `${item.kind || "focus"} · ${Math.round((item.salience || 0) * 100)}`,
  }))));
  groups.appendChild(renderMindGroup("memory traces", traces.map(trace => ({
    title: trace.title || trace.type,
    meta: `${trace.type || "memory"} · ${trace.status || "retain"}`,
  }))));
  mindPanel.appendChild(groups);
}

function renderMindGroup(label, rows = []) {
  const group = document.createElement("section");
  group.className = "mind-group";
  const title = document.createElement("h3");
  title.textContent = label;
  group.appendChild(title);
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.textContent = "none";
    group.appendChild(empty);
    return group;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "mind-row";
    item.innerHTML = `<b></b><span></span>`;
    item.querySelector("b").textContent = row.title;
    item.querySelector("span").textContent = row.meta;
    group.appendChild(item);
  }
  return group;
}

function syncExpression(state, activity = "idle") {
  lastLifeSnapshot = state || lastLifeSnapshot;
  const needs = state?.needs || {};
  const affect = state?.mind?.expression || state?.expression || state?.affect || needs.affect || needs;
  const expressionState = deriveExpressionState(state, activity);
  expression?.setState({
    state: expressionState,
    mood: affect.mood || state?.brain?.mood_label || state?.mood || "calm",
    energy: Number(state?.energy || 0) / 100,
    dopamine: Number(affect.dopamine || 0),
    stress: Number(affect.stress || 0),
    anger: Number(affect.anger || 0),
    curiosity: Number(affect.curiosity || 0),
    loneliness: Number(affect.loneliness || 0),
    arousal: Number(affect.arousal || 0),
    valence: Number(affect.valence || 0),
    dominance: Number(affect.dominance || 0),
    trust: Number(affect.trust || 0),
    boredom: Number(affect.boredom || 0),
  });
}

function base64AudioUrl(result) {
  if (!result?.audio_base64) return "";
  const mime = result.audio_mime || "audio/mpeg";
  return `data:${mime};base64,${result.audio_base64}`;
}

function estimateVoiceMetrics(data) {
  if (!data?.length) return { level: 0, pitch: 0.45 };
  let sum = 0;
  let crossings = 0;
  let previous = data[0] - 128;
  for (let index = 0; index < data.length; index += 1) {
    const centered = data[index] - 128;
    sum += centered * centered;
    if ((centered >= 0 && previous < 0) || (centered < 0 && previous >= 0)) crossings += 1;
    previous = centered;
  }
  const rms = Math.sqrt(sum / data.length) / 128;
  return {
    level: Math.min(1, rms * 3.5),
    pitch: Math.min(1, Math.max(0.1, crossings / data.length * 6)),
  };
}

async function playSpeechAudio(result) {
  const sourceUrl = base64AudioUrl(result);
  if (!sourceUrl) return false;
  if (activeSpeechAudio) {
    activeSpeechAudio.pause();
    activeSpeechAudio = null;
  }
  cancelAnimationFrame(speechFrame);

  const audio = new Audio(sourceUrl);
  activeSpeechAudio = audio;
  audio.preload = "auto";

  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") await audioContext.resume();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.76;
    const source = audioContext.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    const samples = new Uint8Array(analyser.fftSize);
    const pump = () => {
      if (audio.paused || audio.ended || activeSpeechAudio !== audio) {
        expression?.setState({ state: "idle", voiceLevel: 0 });
        if (lastLifeSnapshot) syncExpression(lastLifeSnapshot, "idle");
        return;
      }
      analyser.getByteTimeDomainData(samples);
      const metrics = estimateVoiceMetrics(samples);
      expression?.setState({
        state: "speaking",
        voiceLevel: metrics.level,
        voicePitch: metrics.pitch,
      });
      speechFrame = requestAnimationFrame(pump);
    };
    audio.addEventListener("play", pump, { once: true });
    audio.addEventListener("ended", () => {
      expression?.setState({ state: "idle", voiceLevel: 0 });
      if (lastLifeSnapshot) syncExpression(lastLifeSnapshot, "idle");
    });
    await audio.play();
    return true;
  } catch (error) {
    modelStatus.textContent = `audio blocked: ${error.message.slice(0, 80)}`;
    expression?.setState({ state: "speaking", voiceLevel: 0.35, voicePitch: 0.45 });
    return false;
  }
}

async function refreshLife() {
  const [state, memories, journal, hardware, actions, runtime, messages, cognition] = await Promise.all([
    jsonFetch("/api/digital-life/state"),
    jsonFetch("/api/digital-life/memories?limit=8"),
    jsonFetch("/api/digital-life/journal?limit=6"),
    jsonFetch("/api/digital-life/hardware").catch(() => null),
    jsonFetch("/api/digital-life/actions?limit=8").catch(() => ({ actions: [] })),
    jsonFetch("/api/digital-life/runtime").catch(() => ({ runtime: null })),
    jsonFetch("/api/digital-life/messages?conversation_id=digital-life-page&limit=60").catch(() => ({ messages: [] })),
    jsonFetch("/api/digital-life/cognition?limit=8").catch(() => ({ cognition: {} })),
  ]);
  const activity = state.state?.presence?.activity;
  const visualActivity = deriveExpressionState(state.state, stateMeta[activity] ? activity : "idle");
  setLifeState(visualActivity, {
    mood: state.state?.brain?.mood_label || state.state?.mood || "calm",
  });
  syncExpression(state.state, visualActivity);
  setText("companionName", state.state?.name || "Vibe");
  setText("hardwareMode", hardware?.mode || "mock");
  const presence = hardware?.presence?.nearby
    ? "nearby detected"
    : state.state?.presence?.status || "presence unknown";
  setText("presenceLabel", presence);
  const runtimeEnabled = Boolean(runtime.runtime?.enabled ?? state.state?.loop_enabled);
  loopToggle.checked = runtimeEnabled;
  loopStatus.textContent = runtimeEnabled ? "server loop on" : "manual";
  if (runtimeLabel) {
    const last = runtime.runtime?.lastAction?.action_type || state.state?.presence?.activity || "idle";
    runtimeLabel.textContent = runtimeEnabled ? `loop ${last}` : "loop paused";
  }
  renderInnerState(state.state);
  renderVitals(state.state);
  renderMindPanel(state.state);
  renderList(memoryList, memories.memories || [], "No long-term memories yet.");
  renderList(journalList, journal.journal || [], "No reflections yet.");
  renderAutonomy(actions.actions || [], runtime.runtime || {}, state.state);
  renderList(actionList, actions.actions || [], "No autonomous actions yet.");
  renderCognition(cognition.cognition || {});
  lastServerMessages = messages.messages || [];
  renderMessages(lastServerMessages);
}

async function sendMessage(content) {
  const text = String(content || "").trim();
  if (!text) return;
  const pendingUser = makeLocalMessage("user", text);
  optimisticMessages = [...optimisticMessages, pendingUser];
  renderMessages(lastServerMessages, { forceScroll: true });
  setLifeState("thinking");
  syncPresence("thinking").catch(error => {
    modelStatus.textContent = `presence sync delayed: ${error.message.slice(0, 80)}`;
  });
  let result = null;
  try {
    result = await jsonFetch("/api/digital-life/message", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: "digital-life-page",
        content: text,
        modelSettings: currentModelSettings(),
      }),
    });
  } catch (error) {
    optimisticMessages = optimisticMessages.filter(message => message.id !== pendingUser.id);
    const failed = makeLocalMessage("assistant", `Message failed: ${error.message}`);
    optimisticMessages = [...optimisticMessages, failed];
    renderMessages(lastServerMessages, { forceScroll: true });
    setLifeState("idle");
    return;
  }
  setLifeState("speaking");
  optimisticMessages = optimisticMessages.filter(message => message.id !== pendingUser.id);
  lastServerMessages = mergeMessageLists(lastServerMessages, [
    result.user_message,
    result.assistant_message,
  ].filter(Boolean));
  renderMessages(lastServerMessages, { forceScroll: true });
  if (result.mode === "llm") {
    modelStatus.textContent = `chatting with ${result.model || modelName.value || "server model"}`;
  } else if (result.fallback_reason) {
    const reason = result.fallback_reason === "fetch failed"
      ? "model network unreachable"
      : result.fallback_reason;
    modelStatus.textContent = `fallback: ${reason.slice(0, 80)}`;
  }
  const speech = await jsonFetch("/api/digital-life/say", {
    method: "POST",
    body: JSON.stringify({ text: result.assistant_message?.content || "I heard you." }),
  }).catch(() => null);
  if (speech?.ok === false && speech.error) {
    modelStatus.textContent = `tts failed: ${speech.error.slice(0, 80)}`;
  } else if (speech?.fallback_from && speech.fallback_error) {
    modelStatus.textContent = `tts ${speech.mode}: ${speech.fallback_from} failed, using fallback`;
    await playSpeechAudio(speech);
  } else {
    await playSpeechAudio(speech);
  }
  await refreshLife();
}

document.querySelectorAll("[data-life-state]").forEach(button => {
  button.addEventListener("click", async () => {
    const state = button.dataset.lifeState || "idle";
    const demoAffect = {
      idle: { energy: 72, affect: { arousal: 0.28, stress: 0.08, anger: 0, valence: 0.02, loneliness: 0.22, trust: 0.54, dopamine: 0 } },
      sleep: { energy: 14, affect: { arousal: 0.03, stress: 0.02, anger: 0, valence: -0.04, loneliness: 0.18, dominance: -0.05 } },
      angry: { energy: 78, affect: { arousal: 0.94, stress: 0.92, anger: 0.86, valence: -0.42, dominance: -0.2, voiceLevel: 0.05 } },
      happy: { energy: 86, affect: { arousal: 0.72, stress: 0.08, anger: 0, valence: 0.78, dopamine: 0.8, dominance: 0.34 } },
      lonely: { energy: 36, affect: { arousal: 0.22, stress: 0.28, anger: 0.05, valence: -0.28, loneliness: 0.88, dominance: -0.38 } },
    };
    holdManualVisualState(state);
    setLifeState(state, demoAffect[state] || {});
    if (demoAffect[state]) {
      const meta = stateMeta[state] || stateMeta.idle;
      await jsonFetch("/api/digital-life/state", {
        method: "POST",
        body: JSON.stringify({
          mood: meta.mood,
          energy: demoAffect[state].energy,
          presence: {
            status: state === "away" ? "away" : "present",
            activity: state,
            updated_at: new Date().toISOString(),
          },
          needs: {
            affect: demoAffect[state].affect,
          },
        }),
      });
    } else {
      await syncPresence(state);
    }
    if (state === "speaking") {
      const speech = await jsonFetch("/api/digital-life/say", {
        method: "POST",
        body: JSON.stringify({ text: "I am here." }),
      }).catch(() => null);
      await playSpeechAudio(speech);
    }
    if (state === "listening") {
      await jsonFetch("/api/digital-life/listen/start", {
        method: "POST",
        body: JSON.stringify({ mockTranscript: "owner is near the desk" }),
      }).catch(() => null);
    }
    await refreshLife();
  });
});

lifeComposer.addEventListener("submit", async event => {
  event.preventDefault();
  const text = lifeInput.value;
  lifeInput.value = "";
  await sendMessage(text);
});

lifeInput.addEventListener("compositionstart", () => {
  inputComposing = true;
});

lifeInput.addEventListener("compositionend", () => {
  inputComposing = false;
});

lifeInput.addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.shiftKey || inputComposing || event.isComposing) return;
  event.preventDefault();
  lifeComposer.requestSubmit();
});

newMessagesNotice?.addEventListener("click", scrollMessageLogToBottom);

listenBtn.addEventListener("click", async () => {
  setLifeState("listening");
  await jsonFetch("/api/digital-life/listen/start", {
    method: "POST",
    body: JSON.stringify({ mockTranscript: "owner is nearby" }),
  });
  appendMessage("assistant", "Listening channel is open in mock mode.");
  scrollMessageLogToBottom();
  await syncPresence("listening");
  await refreshLife();
});

reflectBtn.addEventListener("click", async () => {
  setLifeState("thinking");
  const reflection = await jsonFetch("/api/digital-life/reflect", {
    method: "POST",
    body: JSON.stringify({ conversation_id: "digital-life-page" }),
  });
  appendMessage("assistant", reflection.entry?.content || "Reflection saved.");
  scrollMessageLogToBottom();
  await refreshLife();
});

async function heartbeat(action = "") {
  const result = await jsonFetch("/api/digital-life/tick", {
    method: "POST",
    body: JSON.stringify({ action, loop_enabled: loopToggle.checked }),
  });
  if (result.action?.output?.summary) {
    appendMessage("assistant", result.action.output.summary);
    scrollMessageLogToBottom();
  }
  await refreshLife();
}

tickBtn.addEventListener("click", () => heartbeat());
refreshBtn.addEventListener("click", refreshLife);
rewardBtn.addEventListener("click", async () => {
  await jsonFetch("/api/digital-life/rewards", {
    method: "POST",
    body: JSON.stringify({
      event_type: "owner.reward",
      reward: 0.6,
      reason: "Owner rewarded the companion.",
      state_delta: { social: 0.08, loneliness: -0.08 },
    }),
  });
  appendMessage("assistant", "I felt that as positive feedback.");
  scrollMessageLogToBottom();
  await refreshLife();
});

penaltyBtn.addEventListener("click", async () => {
  await jsonFetch("/api/digital-life/rewards", {
    method: "POST",
    body: JSON.stringify({
      event_type: "owner.penalty",
      reward: -0.45,
      reason: "Owner corrected the companion.",
      state_delta: { stress: 0.08, social: -0.04 },
    }),
  });
  appendMessage("assistant", "I registered that as a correction.");
  scrollMessageLogToBottom();
  await refreshLife();
});

webForm.addEventListener("submit", async event => {
  event.preventDefault();
  const url = webUrl.value.trim();
  if (!url) return;
  setLifeState("thinking");
  const result = await jsonFetch("/api/digital-life/web/read", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  appendMessage("assistant", `I read ${url}. ${result.excerpt ? result.excerpt.slice(0, 160) : ""}`);
  scrollMessageLogToBottom();
  webUrl.value = "";
  await refreshLife();
});

memoryForm?.addEventListener("submit", async event => {
  event.preventDefault();
  const content = memoryContent.value.trim();
  if (!content) return;
  await jsonFetch("/api/digital-life/memories", {
    method: "POST",
    body: JSON.stringify({
      kind: "manual",
      title: memoryTitle.value.trim() || content.slice(0, 28),
      content,
      importance: 5,
      tags: ["owner_seed", "manual"],
      source: "manual_ui",
    }),
  });
  memoryTitle.value = "";
  memoryContent.value = "";
  appendMessage("assistant", "我已经把这条写进长期记忆。");
  scrollMessageLogToBottom();
  await refreshLife();
});

loopToggle.addEventListener("change", async () => {
  loopStatus.textContent = loopToggle.checked ? "server loop on" : "manual";
  await jsonFetch("/api/digital-life/runtime", {
    method: "POST",
    body: JSON.stringify({ enabled: loopToggle.checked }),
  });
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  if (loopToggle.checked) {
    loopTimer = setInterval(() => refreshLife().catch(error => {
      appendMessage("assistant", `Refresh failed: ${error.message}`);
    }), REFRESH_INTERVAL_MS);
  }
  await refreshLife();
});
modelToggle.addEventListener("click", () => {
  modelPanel.hidden = !modelPanel.hidden;
});

modelProvider.addEventListener("change", () => {
  const defaults = providerDefaults[modelProvider.value] || providerDefaults.custom;
  if (!modelBaseUrl.value || providerDefaults[modelProvider.value]) modelBaseUrl.value = defaults.baseUrl;
  if (!modelName.value || providerDefaults[modelProvider.value]) modelName.value = defaults.model;
});

modelPanel.addEventListener("submit", event => {
  event.preventDefault();
  const settings = currentModelSettings();
  saveModelSettings(settings);
  syncModelForm(settings);
});

syncModelForm();
refreshLife().catch(error => {
  appendMessage("assistant", `Startup failed: ${error.message}`);
});
loopTimer = setInterval(() => refreshLife().catch(() => {}), REFRESH_INTERVAL_MS);
