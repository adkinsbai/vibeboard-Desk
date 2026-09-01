const BUILD_ID = "vb-companion-device-demo";
const PROMPT = "Verified local companion market demo";

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
  { id: "offline-3", title: "透明小电脑", kind: "vision", content: "透明小电脑可以成为陪伴应用的身体。", tags: ["设备", "身体"], importance: .91, source: "offline" },
  { id: "offline-4", title: "目标会变化", kind: "belief", content: "目标会变化，需要保留证据、冲突和修订历史。", tags: ["目标", "记忆"], importance: .86, source: "offline" },
];

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
  requestInFlight: false,
  interactionStatus: "可以和我说说话。",
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
    source: memory.source === "offline" ? "offline" : "local",
    reason: String(memory.reason || memory.ranking_reason || ""),
  };
}

function normalizeMessage(message = {}) {
  return {
    id: String(message.id || `message-${Math.random().toString(16).slice(2)}`),
    role: message.role === "user" ? "user" : "assistant",
    content: String(message.content || message.text || ""),
    offline: true,
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
  const sendButton = document.getElementById("sendMessage");
  if (expressionLabel) expressionLabel.textContent = state.expression.toUpperCase();
  if (skinLabel) skinLabel.textContent = state.skin.replace("-", " ").toUpperCase();
  if (moodLine) moodLine.textContent = state.life.mood || expressionCopy[state.expression] || expressionCopy.idle;
  if (connectionStatus) {
    connectionStatus.dataset.connection = state.connectionMode;
    connectionStatus.textContent = "本地运行";
  }
  if (memoryOverlay) memoryOverlay.hidden = !state.memoryOverlayOpen;
  if (interactionStatus) interactionStatus.textContent = state.interactionStatus;
  if (sendButton) sendButton.disabled = state.requestInFlight;
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

function localCompanionReply(content) {
  const matched = retrieveMemories(content);
  const expression = matched.length ? "warm" : content.length > 18 ? "thinking" : "curious";
  const memoryLine = matched[0]
    ? `我记得：${matched[0].content}`
    : "我先把这句话放进本地上下文里。";
  return {
    assistant_message: {
      role: "assistant",
      content: `${memoryLine} 这是一个可部署到小电脑上的本地 companion demo。`,
    },
    state: {
      mood: expressionCopy[expression] || expressionCopy.idle,
      mind: { expression },
    },
  };
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
    const response = localCompanionReply(content);
    appendVisibleMessage({ ...response.assistant_message, offline: true });
    applyLifeState(response.state);
    state.connectionMode = "offline";
    state.interactionStatus = "本地设备应用正在运行。";
    return response;
  } catch (error) {
    state.connectionMode = "error";
    const fallback = `我先陪你在这里。刚才的本地回应没有完成：${error?.message || "暂时不可用"}`;
    appendVisibleMessage({ role: "assistant", content: fallback, offline: true });
    state.interactionStatus = "本地回应暂时不可用，按键互动仍可继续。";
    setTransientExpression("error");
    return null;
  } finally {
    state.requestInFlight = false;
    render();
  }
}

async function hydrate() {
  state.memories = offlineMemories.map(normalizeMemory);
  state.connectionMode = "offline";
  state.interactionStatus = "本地设备应用已启动。";
  render();
}

function handlePhysicalKey(event) {
  if (event.target?.matches?.("input,textarea,button")) {
    return;
  }
  if (/Digit1|Numpad1/.test(event.code || "") || event.key === "KEY1") cycleExpression();
  if (/Digit2|Numpad2/.test(event.code || "") || event.key === "KEY2") toggleMemory();
  if (/Digit3|Numpad3/.test(event.code || "") || event.key === "KEY3") cycleSkin();
}

document.addEventListener("keydown", handlePhysicalKey);
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

window.CompanionDeviceSimulator = {
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
      life: { ...state.life, mind: { ...state.life.mind } },
      conversation_state: state.requestInFlight ? "thinking" : "idle",
      available_expressions: [...expressionStates],
      available_skins: [...skins],
    };
  },
  setExpression,
  retrieveMemories,
  normalizeExpression,
  sendMessage,
};

render();
hydrate();
