const api = {
  board: "/api/board",
  generate: "/api/generate",
  build: "/api/build",
  deploy: "/api/deploy",
  verify: "/api/verify"
};

const el = id => document.getElementById(id);
const chatLog = el("chatLog");
const composer = el("composer");
const promptInput = el("promptInput");
const generateBtn = el("generateBtn");
const runDemoBtn = el("runDemoBtn");
const refreshBoardBtn = el("refreshBoardBtn");
const agentState = el("agentState");
const deployState = el("deployState");
const codeDrawer = el("codeDrawer");
const statusDrawer = el("statusDrawer");
const codeToggle = el("codeToggle");
const closeDrawer = el("closeDrawer");
const closeStatusDrawer = el("closeStatusDrawer");
const scrim = el("scrim");
const fileTabs = el("fileTabs");
const codePreview = el("codePreview");
const screenViewport = el("screenViewport");
const deviceScreen = el("deviceScreen");
const deviceFrame = el("deviceFrame");
const modelConfigBtn = el("modelConfigBtn");
const modelModal = el("modelModal");
const closeModelModal = el("closeModelModal");
const modelForm = el("modelForm");
const modelProvider = el("modelProvider");
const modelBaseUrl = el("modelBaseUrl");
const modelName = el("modelName");
const modelApiKey = el("modelApiKey");
const modelButtonLabel = el("modelButtonLabel");
const modelDot = el("modelDot");
const modelHelpText = el("modelHelpText");
const clearModelSettings = el("clearModelSettings");
const goldenLoopState = el("goldenLoopState");
const verifyList = el("verifyList");

let generatedFiles = {};
let activeFile = "";
let busy = false;
let conversationInitPromise = null;

const MODEL_STORAGE_KEY = "vibeboard-linux-model-settings";
const providerPresets = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    help: "DeepSeek OpenAI-compatible endpoint. 推荐先用 deepseek-v4-flash。"
  },
  minimax: {
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M2.7",
    help: "MiniMax OpenAI-compatible endpoint. 国内默认 minimaxi.com，国际账户可改成 api.minimax.io。"
  },
  custom: {
    label: "Custom",
    baseUrl: "",
    model: "",
    help: "填写任意 OpenAI-compatible /chat/completions 服务。"
  }
};

function loadModelSettings() {
  const preset = providerPresets.deepseek;
  try {
    const saved = JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) || "{}");
    const provider = saved.provider && providerPresets[saved.provider] ? saved.provider : "deepseek";
    const base = providerPresets[provider];
    return {
      provider,
      baseUrl: saved.baseUrl || base.baseUrl,
      model: saved.model || base.model,
      apiKey: saved.apiKey || ""
    };
  } catch {
    return {
      provider: "deepseek",
      baseUrl: preset.baseUrl,
      model: preset.model,
      apiKey: ""
    };
  }
}

let modelSettings = loadModelSettings();

const labels = {
  generating: "\u751f\u6210\u6587\u4ef6",
  building: "\u7f16\u8bd1\u6821\u9a8c",
  deploying: "\u5199\u5165\u786c\u4ef6",
  verifying: "\u9a8c\u8bc1\u95ed\u73af",
  observing: "\u5237\u65b0\u5c0f\u5c4f",
  done: "\u5b8c\u6210",
  failed: "\u5931\u8d25"
};

const stages = [
  { id: "generate", title: "生成小屏应用", note: "index.html / style.css / app.js" },
  { id: "build", title: "编译与打包校验", note: "syntax check + manifest" },
];

function pad(value) {
  return String(value).padStart(2, "0");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function addMessage(role, text) {
  const article = document.createElement("article");
  article.className = `msg ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "ME" : "VB";
  const body = document.createElement("p");
  body.textContent = text;
  article.append(avatar, body);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
  return article;
}

function addStageCard() {
  const article = document.createElement("article");
  article.className = "msg agent";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "VB";
  const card = document.createElement("div");
  card.className = "stage-card";
  const title = document.createElement("strong");
  title.textContent = "\u6211\u6b63\u5728\u6267\u884c\u751f\u6210\u548c\u5199\u5165\u6d41\u7a0b";
  const list = document.createElement("div");
  list.className = "stage-list";
  stages.forEach(stage => {
    const row = document.createElement("div");
    row.className = "stage";
    row.dataset.stage = stage.id;
    row.innerHTML = `<i></i><span>${escapeHtml(stage.title)}<br><small>${escapeHtml(stage.note)}</small></span><em>wait</em>`;
    list.appendChild(row);
  });
  card.append(title, list);
  article.append(avatar, card);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;

  return {
    set(id, state, note) {
      const row = list.querySelector(`[data-stage="${id}"]`);
      if (!row) return;
      row.classList.remove("active", "done", "fail");
      if (state) row.classList.add(state);
      row.querySelector("em").textContent = note || state || "wait";
      chatLog.scrollTop = chatLog.scrollHeight;
    }
  };
}

async function postJson(url, payload = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function setBusy(value) {
  busy = value;
  if (generateBtn) generateBtn.disabled = value;
  if (runDemoBtn) runDemoBtn.disabled = value;
  if (modelConfigBtn) modelConfigBtn.disabled = value;
  if (agentState) agentState.textContent = value ? "running" : "idle";
}

function hasModelConfig(settings = modelSettings) {
  return Boolean(settings.apiKey && settings.baseUrl && settings.model);
}

function saveModelSettings(settings) {
  modelSettings = { ...settings };
  localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(modelSettings));
  syncModelUi();
}

function syncModelUi() {
  const preset = providerPresets[modelSettings.provider] || providerPresets.custom;
  if (modelProvider) modelProvider.value = modelSettings.provider;
  if (modelBaseUrl) modelBaseUrl.value = modelSettings.baseUrl || preset.baseUrl || "";
  if (modelName) modelName.value = modelSettings.model || preset.model || "";
  if (modelApiKey) modelApiKey.value = modelSettings.apiKey || "";
  if (modelButtonLabel) {
    modelButtonLabel.textContent = hasModelConfig() ? `${preset.label} · ${modelSettings.model}` : "配置模型";
  }
  if (modelDot) modelDot.classList.toggle("online", hasModelConfig());
  if (modelHelpText) {
    modelHelpText.textContent = `${preset.help} API Key 只保存在当前浏览器本地；未配置时使用本地模板兜底。`;
  }
}

function applyProviderPreset(provider) {
  const preset = providerPresets[provider] || providerPresets.custom;
  modelSettings = {
    ...modelSettings,
    provider,
    baseUrl: preset.baseUrl || modelSettings.baseUrl || "",
    model: preset.model || modelSettings.model || ""
  };
  syncModelUi();
}

function getModelPayload() {
  return {
    provider: modelSettings.provider,
    baseUrl: modelSettings.baseUrl,
    model: modelSettings.model,
    apiKey: modelSettings.apiKey
  };
}

function renderFiles(files) {
  generatedFiles = files || {};
  const names = Object.keys(generatedFiles);
  fileTabs.innerHTML = "";
  names.forEach(name => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.classList.toggle("active", !activeFile || activeFile === name);
    button.addEventListener("click", () => showFile(name));
    fileTabs.appendChild(button);
  });
  if (names.length) showFile(activeFile && generatedFiles[activeFile] ? activeFile : names[0]);
}

function showFile(name) {
  activeFile = name;
  codePreview.textContent = generatedFiles[name] || "# no file selected";
  [...fileTabs.children].forEach(button => {
    button.classList.toggle("active", button.textContent === name);
  });
}

function isOpen(node) {
  return Boolean(node?.classList.contains("open"));
}

function syncScrim() {
  if (!scrim) return;
  scrim.hidden = !(
    isOpen(codeDrawer) ||
    isOpen(statusDrawer) ||
    isOpen(modelModal) ||
    isOpen(el("deployMarketModal"))
  );
}

function setCodeDrawer(open) {
  if (!codeDrawer) return;
  codeDrawer.classList.toggle("open", open);
  codeDrawer.setAttribute("aria-hidden", open ? "false" : "true");
  syncScrim();
}

function setStatusDrawer(open) {
  if (!statusDrawer) return;
  statusDrawer.classList.toggle("open", open);
  statusDrawer.setAttribute("aria-hidden", open ? "false" : "true");
  syncScrim();
  if (open) refreshBoard();
}

function setModelModal(open) {
  if (!modelModal) return;
  modelModal.classList.toggle("open", open);
  modelModal.setAttribute("aria-hidden", open ? "false" : "true");
  syncScrim();
  if (open) {
    syncModelUi();
    setTimeout(() => modelApiKey?.focus(), 40);
  }
}

function closeDrawers() {
  setCodeDrawer(false);
  setStatusDrawer(false);
  setModelModal(false);
  const deployModal = el("deployMarketModal");
  if (deployModal) {
    deployModal.classList.remove("open");
    deployModal.setAttribute("aria-hidden", "true");
  }
  syncScrim();
}

function fitDeviceFrame() {
  if (!deviceScreen || !screenViewport) return;
  const frame = screenViewport.closest(".display-frame");
  const rect = frame ? frame.getBoundingClientRect() : screenViewport.getBoundingClientRect();
  const style = frame ? getComputedStyle(frame) : null;
  const padX = style ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 0;
  const padY = style ? parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) : 0;
  const availableWidth = Math.max(0, rect.width - padX);
  const availableHeight = Math.max(0, rect.height - padY);
  if (!availableWidth || !availableHeight) return;
  const scale = Math.max(0.1, Math.min(availableWidth / 480, availableHeight / 360));
  screenViewport.style.width = `${480 * scale}px`;
  screenViewport.style.height = `${360 * scale}px`;
  deviceScreen.style.setProperty("--screen-scale", String(scale || 1));
}

function scheduleFitDeviceFrame() {
  requestAnimationFrame(() => {
    fitDeviceFrame();
    requestAnimationFrame(fitDeviceFrame);
  });
}

function renderDevicePreview(prompt, statusText) {
  if (deviceFrame) {
    deviceFrame.src = `/generated/current/index.html?t=${Date.now()}`;
  }
  deviceScreen.dataset.status = statusText || "";
  deviceScreen.dataset.prompt = prompt || "";
}

function renderGoldenLoop(goldenLoop) {
  if (!goldenLoop) {
    if (goldenLoopState) {
      goldenLoopState.textContent = "not verified";
      goldenLoopState.className = "";
    }
    if (verifyList) verifyList.innerHTML = "";
    return;
  }

  if (goldenLoopState) {
    goldenLoopState.textContent = goldenLoop.ok ? "passed" : "failed";
    goldenLoopState.className = goldenLoop.ok ? "ok" : "fail";
  }

  if (!verifyList) return;
  verifyList.innerHTML = "";
  (goldenLoop.checks || []).forEach(check => {
    const item = document.createElement("div");
    item.className = `verify-item ${check.ok ? "pass" : "fail"}`;
    item.innerHTML = `
      <div>
        <b>${escapeHtml(check.label || check.id)}</b>
        <small>${escapeHtml(check.evidence || "")}</small>
      </div>
      <span>${check.ok ? "pass" : "fail"}</span>
    `;
    verifyList.appendChild(item);
  });
}

function failedGoldenLoopLabels(goldenLoop) {
  return (goldenLoop?.checks || [])
    .filter(check => !check.ok)
    .map(check => check.label || check.id)
    .join(", ");
}

function renderHardwareRun(result) {
  const compileLog = String(result.compileLog || "").trim();
  const hardware = result.hardwareResult || null;
  const raw = String(result.hardwareResultRaw || "").trim();
  const goldenLoop = result.goldenLoop || null;

  el("compileState").textContent = compileLog ? "board ok" : "local ok";
  el("programState").textContent = hardware ? "executed" : "no result";
  renderGoldenLoop(goldenLoop);

  const lines = [];
  if (compileLog) lines.push(compileLog);
  if (hardware) {
    lines.push(JSON.stringify({
      build_id: hardware.build_id,
      runtime: hardware.runtime,
      hostname: hardware.hostname,
      cpu_temp_c: hardware.cpu_temp_c,
      mem_available_kb: hardware.mem_available_kb,
      loadavg: hardware.loadavg
    }, null, 2));
  } else if (raw) {
    lines.push(raw);
  }
  if (goldenLoop) {
    lines.push(JSON.stringify({
      golden_loop: goldenLoop.ok ? "passed" : "failed",
      id: goldenLoop.id,
      failed: (goldenLoop.checks || []).filter(check => !check.ok).map(check => check.label)
    }, null, 2));
  }
  el("hardwareResult").textContent = lines.join("\n\n") || "waiting for hardware run";
}

async function refreshBoard() {
  if (refreshBoardBtn) refreshBoardBtn.disabled = true;
  try {
    const data = await getJson(api.board);
    if (data.board) {
      el("boardName").innerHTML = `${escapeHtml(data.board.label || data.hostname || "Taishan")} <span>RK3566</span>`;
    }
    el("boardWifi").textContent = data.wifi || "--";
    el("boardIp").textContent = data.ip || "--";
    el("serviceState").textContent = data.service || "--";
    el("tempState").textContent = data.temp == null ? "--" : `${data.temp}\u00b0C`;
    el("memoryState").textContent = data.memory || "--";
    const sshState = el("sshState");
    if (sshState) sshState.textContent = data.connected ? "ssh live" : "offline";
    if (data.kernel) el("boardOs").textContent = `Linux ${data.kernel}`;
  } catch (error) {
    const sshState = el("sshState");
    if (sshState) sshState.textContent = "ssh error";
    addMessage("agent", `\u8BFB\u53D6\u771F\u673A\u72B6\u6001\u5931\u8D25\uFF1A${error.message}`);
  } finally {
    if (refreshBoardBtn) refreshBoardBtn.disabled = false;
  }
}

async function runFlow(prompt) {
  if (busy) return;
  setBusy(true);
  deployState.textContent = "starting";
  addMessage("user", prompt);
  persistMessage("user", prompt);
  const progress = addStageCard();

  try {
    progress.set("generate", "active", "run");
    deployState.textContent = labels.generating;
    const gen = await postJson(api.generate, { prompt, modelSettings: getModelPayload() });
    renderFiles(gen.files);
    renderDevicePreview(prompt, "已生成应用");
    progress.set("generate", "done", "ok");
    el("lastBuildState").textContent = gen.id || "generated";
    if (gen.source === "llm") {
      addMessage("agent", `已通过 ${modelSettings.provider} / ${modelSettings.model} 生成应用代码。`);
    } else if (gen.fallbackReason) {
      addMessage("agent", `模型连接不可用，已继续使用本地模板生成；写入流程会继续。原因：${gen.fallbackReason}`);
    }

    progress.set("build", "active", "run");
    deployState.textContent = labels.building;
    const build = await postJson(api.build, {});
    progress.set("build", "done", build.summary || "ok");

    deployState.textContent = "生成完成";
    addDeployButton(prompt);
    const successMessage = `已生成 ${Object.keys(gen.files).length} 个文件并通过编译校验。点击下方按钮部署到泰山派真机。`;
    addMessage("agent", successMessage);
    persistMessage("agent", successMessage, gen.id || null);
  } catch (error) {
    const current = stages.find(stage => document.querySelector(`[data-stage="${stage.id}"].active`));
    if (current) progress.set(current.id, "fail", "fail");
    deployState.textContent = labels.failed;
    const errorMessage = `流程失败：${error.message}`;
    addMessage("agent", errorMessage);
    persistMessage("agent", errorMessage);
  } finally {
    setBusy(false);
  }
}

function addDeployButton(prompt) {
  const article = document.createElement("article");
  article.className = "msg agent";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "VB";
  const body = document.createElement("div");
  body.className = "deploy-action";
  const btn = document.createElement("button");
  btn.className = "deploy-btn";
  btn.textContent = "🚀 部署到泰山派真机";
  btn.addEventListener("click", () => runDeploy(btn));
  body.appendChild(btn);
  article.append(avatar, body);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function runDeploy(btn) {
  if (busy) return;
  setBusy(true);
  btn.disabled = true;
  btn.textContent = "⏳ 部署中...";
  deployState.textContent = labels.deploying;

  try {
    const deployed = await postJson(api.deploy, {});
    renderHardwareRun(deployed);
    deployState.textContent = labels.done;
    renderDevicePreview("", "已写入真机");
    addMessage("agent", `部署成功！已写入泰山派，服务已重启。Backup: ${deployed.backup || "remote backup"}`);
    btn.textContent = "✅ 部署完成";
    btn.classList.add("done");
  } catch (error) {
    deployState.textContent = labels.failed;
    addMessage("agent", `部署失败：${error.message}`);
    btn.textContent = "❌ 部署失败，点击重试";
    btn.disabled = false;
  } finally {
    setBusy(false);
  }
}

function drawClock() {
  if (deviceFrame && deviceFrame.contentWindow) {
    return;
  }
}

composer?.addEventListener("submit", event => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (prompt) runFlow(prompt);
});

runDemoBtn?.addEventListener("click", () => {
  const prompt = promptInput.value.trim();
  if (prompt) runFlow(prompt);
});

refreshBoardBtn?.addEventListener("click", () => setStatusDrawer(true));
codeToggle?.addEventListener("click", () => setCodeDrawer(true));
closeDrawer?.addEventListener("click", () => setCodeDrawer(false));
closeStatusDrawer?.addEventListener("click", () => setStatusDrawer(false));
modelConfigBtn?.addEventListener("click", () => setModelModal(true));
closeModelModal?.addEventListener("click", () => setModelModal(false));
modelProvider?.addEventListener("change", () => applyProviderPreset(modelProvider.value));
modelForm?.addEventListener("submit", event => {
  event.preventDefault();
  saveModelSettings({
    provider: modelProvider.value,
    baseUrl: modelBaseUrl.value.trim(),
    model: modelName.value.trim(),
    apiKey: modelApiKey.value.trim()
  });
  setModelModal(false);
  addMessage("agent", `模型配置已保存：${providerPresets[modelSettings.provider]?.label || modelSettings.provider} / ${modelSettings.model || "未填写模型"}`);
});
clearModelSettings?.addEventListener("click", () => {
  localStorage.removeItem(MODEL_STORAGE_KEY);
  modelSettings = loadModelSettings();
  syncModelUi();
});
scrim?.addEventListener("click", closeDrawers);

document.querySelectorAll("[data-prompt]").forEach(button => {
  button.addEventListener("click", () => {
    promptInput.value = button.dataset.prompt;
    promptInput.focus();
  });
});

scheduleFitDeviceFrame();
syncModelUi();
window.addEventListener("resize", scheduleFitDeviceFrame);
if (deviceFrame) {
  deviceFrame.addEventListener("load", scheduleFitDeviceFrame);
}
if (screenViewport && "ResizeObserver" in window) {
  const frame = screenViewport.closest(".display-frame");
  const observer = new ResizeObserver(scheduleFitDeviceFrame);
  if (frame) observer.observe(frame);
}
refreshBoard();

// ==================== Conversation Management ====================
const API_BASE = "";

let currentConversationId = null;

// Sidebar toggle
const sidebarToggle = document.getElementById("sidebarToggle");
const sidebar = document.getElementById("sidebar");

if (sidebarToggle && sidebar) {
  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
  });
}

// Load conversations
async function loadConversations() {
  try {
    const res = await fetch(`${API_BASE}/api/conversations`);
    const data = await res.json();
    if (data.ok) {
      renderConversationList(data.conversations);
    }
  } catch (err) {
    console.error("Failed to load conversations:", err);
  }
}

// Render conversation list
function renderConversationList(conversations) {
  const list = document.getElementById("conversationList");
  if (!list) return;

  list.innerHTML = conversations.map(conv => `
    <div class="conv-item ${conv.id === currentConversationId ? 'active' : ''}" data-id="${conv.id}">
      <div class="conv-title">${escapeHtml(conv.title)}</div>
      <div class="conv-time">${formatTime(conv.updated_at)}</div>
    </div>
  `).join("");

  // Add click handlers
  list.querySelectorAll(".conv-item").forEach(item => {
    item.addEventListener("click", () => {
      selectConversation(item.dataset.id);
    });
  });
}

// Select conversation
async function selectConversation(id) {
  if (busy) return; // Don't switch while a flow is running
  currentConversationId = id;

  // Update sidebar active state
  document.querySelectorAll(".conv-item").forEach(item => {
    item.classList.toggle("active", item.dataset.id === id);
  });

  // Update title immediately
  const convItem = document.querySelector(`.conv-item[data-id="${id}"]`);
  if (convItem) {
    const title = convItem.querySelector(".conv-title")?.textContent;
    const titleEl = document.getElementById("currentConversationTitle");
    if (titleEl && title) titleEl.textContent = title;
  }

  // Show loading state
  const chatLog = document.getElementById("chatLog");
  if (chatLog) {
    chatLog.innerHTML = `
      <article class="msg agent">
        <div class="avatar">VB</div>
        <p style="color:var(--dim)">加载对话记录中...</p>
      </article>
    `;
  }

  // Load messages
  try {
    const res = await fetch(`${API_BASE}/api/conversations/${id}/messages`);
    const data = await res.json();
    if (data.ok) {
      renderMessages(data.messages);
    }
  } catch (err) {
    console.error("Failed to load messages:", err);
    if (chatLog) {
      chatLog.innerHTML = `
        <article class="msg agent">
          <div class="avatar">VB</div>
          <p style="color:#ef4444">加载失败，请重试。</p>
        </article>
      `;
    }
  }
}

// Render messages from history
function renderMessages(messages) {
  const chatLog = document.getElementById("chatLog");
  if (!chatLog) return;

  if (!messages || messages.length === 0) {
    chatLog.innerHTML = `
      <article class="msg agent">
        <div class="avatar">VB</div>
        <p>告诉我你想在硬件上做什么。我会把需求拆成文件、做最小编译校验，然后通过 SSH 写入右侧连接的泰山派小屏。</p>
      </article>
    `;
    return;
  }

  let lastBuildId = null;

  chatLog.innerHTML = messages.map(msg => {
    // Track the last build_id for restoring deploy button
    if (msg.build_id) lastBuildId = msg.build_id;

    return `
      <article class="msg ${msg.role === 'user' ? 'user' : 'agent'}">
        <div class="avatar">${msg.role === 'user' ? 'ME' : 'VB'}</div>
        <p>${escapeHtml(msg.content)}</p>
      </article>
    `;
  }).join("");

  // If the last message has a build_id, restore the deploy button
  if (lastBuildId) {
    const article = document.createElement("article");
    article.className = "msg agent";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "VB";
    const body = document.createElement("div");
    body.className = "deploy-action";
    const btn = document.createElement("button");
    btn.className = "deploy-btn";
    btn.textContent = "🚀 部署到泰山派真机";
    btn.addEventListener("click", () => runDeploy(btn));
    body.appendChild(btn);
    article.append(avatar, body);
    chatLog.appendChild(article);
  }

  // Scroll to bottom
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Create new conversation
async function createConversation({ resetChat = true } = {}) {
  try {
    const res = await fetch(`${API_BASE}/api/conversations`, { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      currentConversationId = data.id;
      await loadConversations();
      if (resetChat) {
        const chatLog = document.getElementById("chatLog");
        if (chatLog) {
          chatLog.innerHTML = `
            <article class="msg agent">
              <div class="avatar">VB</div>
              <p>告诉我你想在硬件上做什么。我会把需求拆成文件、做最小编译校验，然后通过 SSH 写入右侧连接的泰山派小屏。</p>
            </article>
          `;
        }
        const titleEl = document.getElementById("currentConversationTitle");
        if (titleEl) titleEl.textContent = "New App";
      }
    }
  } catch (err) {
    console.error("Failed to create conversation:", err);
  }
}

async function ensureConversation() {
  if (currentConversationId) return currentConversationId;
  if (!conversationInitPromise) {
    conversationInitPromise = createConversation({ resetChat: false }).finally(() => {
      conversationInitPromise = null;
    });
  }
  await conversationInitPromise;
  return currentConversationId;
}

// Save message to conversation
async function saveMessage(role, content, buildId = null) {
  await ensureConversation();
  if (!currentConversationId) return;

  try {
    await fetch(`${API_BASE}/api/conversations/${currentConversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, content, build_id: buildId })
    });

    // Refresh conversation list to update title
    await loadConversations();
  } catch (err) {
    console.error("Failed to save message:", err);
  }
}

function persistMessage(role, content, buildId = null) {
  saveMessage(role, content, buildId).catch(err => {
    console.error("Failed to persist message:", err);
  });
}

// New conversation button
const newConvBtn = document.getElementById("newConversationBtn");
if (newConvBtn) {
  newConvBtn.addEventListener("click", createConversation);
}

// Deploy to market button
const deployMarketBtn = document.getElementById("deployMarketBtn");
const deployMarketModal = document.getElementById("deployMarketModal");
const closeDeployModal = document.getElementById("closeDeployModal");
const cancelDeploy = document.getElementById("cancelDeploy");
const deployMarketForm = document.getElementById("deployMarketForm");

if (deployMarketBtn && deployMarketModal) {
  deployMarketBtn.addEventListener("click", () => {
    deployMarketModal.classList.add("open");
    deployMarketModal.setAttribute("aria-hidden", "false");
    syncScrim();

    const descField = document.getElementById("appDescription");
    if (descField && !descField.value) {
      descField.value = "一个运行在泰山派 RK3566 上的硬件应用，通过 VibeBoard 平台生成。";
    }
  });

  const closeModal = () => {
    deployMarketModal.classList.remove("open");
    deployMarketModal.setAttribute("aria-hidden", "true");
    syncScrim();
  };

  closeDeployModal?.addEventListener("click", closeModal);
  cancelDeploy?.addEventListener("click", closeModal);

  deployMarketForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("appName")?.value;
    const desc = document.getElementById("appDescription")?.value;

    if (!name) return;

    try {
      const res = await fetch(`${API_BASE}/api/market/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: currentConversationId,
          name,
          description: desc
        })
      });
      const data = await res.json();

      if (data.ok) {
        alert("发布成功！你的应用已上架应用市场。");
        closeModal();
      } else {
        alert("发布失败：" + (data.error || "未知错误"));
      }
    } catch (err) {
      alert("发布失败：" + err.message);
    }
  });
}

function formatTime(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;

  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

// Load conversations on startup
loadConversations();
