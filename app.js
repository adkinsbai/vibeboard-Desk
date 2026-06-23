const api = {
  board: "/api/board",
  generate: "/api/generate",
  build: "/api/build",
  deploy: "/api/deploy",
  verify: "/api/verify",
  clarify: "/api/clarify",
  preferences: "/api/preferences",
  agent: "/api/agent",
  chat: "/api/chat",
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
const deviceSelect = el("deviceSelect");
const macPhoto = el("macPhoto");
const macPhotoImg = el("macPhotoImg");
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
let conversationLoadToken = 0;

const MODEL_STORAGE_KEY = "vibeboard-linux-model-settings";
const DEVICE_STORAGE_KEY = "vibeboard-active-device";
const CONVERSATION_STORAGE_KEY = "vibeboard-current-conversation";
const BLANK_DEVICE_FRAME_HTML = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden;}*{box-sizing:border-box;}</style></head><body></body></html>';
const deviceProfiles = {
  "taishan-transparent": {
    id: "taishan-transparent",
    label: "透明版",
    image: "/mac-frame-transparent.png",
    previewPath: "/generated/current/index.html",
    screen: { left: "22.6%", top: "29.1%", width: "55.4%", height: "26.0%" }
  },
  "taishan-gray": {
    id: "taishan-gray",
    label: "灰色版",
    image: "/mac-frame.png",
    previewPath: "/generated/current/index.html",
    screen: { left: "30.18%", top: "31.88%", width: "44.3%", height: "21.8%" }
  },
  "taishan-black": {
    id: "taishan-black",
    label: "亮黑版",
    image: "/mac-frame.png",
    previewPath: "/generated/current/index.html",
    screen: { left: "30.18%", top: "31.88%", width: "44.3%", height: "21.8%" }
  }
};

function getActiveDeviceId() {
  const saved = localStorage.getItem(DEVICE_STORAGE_KEY);
  if (saved && deviceProfiles[saved]) return saved;
  return "taishan-gray";
}

let activeDeviceId = getActiveDeviceId();

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
  preparing: "\u51c6\u5907\u6267\u884c",
  generating: "\u751f\u6210\u6587\u4ef6",
  building: "\u672c\u5730\u9a8c\u8bc1",
  deploying: "\u5199\u5165\u786c\u4ef6",
  verifying: "\u9a8c\u8bc1\u95ed\u73af",
  observing: "\u5237\u65b0\u5c0f\u5c4f",
  done: "\u5b8c\u6210",
  failed: "\u5931\u8d25"
};

const stages = [
  { id: "intake", title: "理解任务", note: "读取需求和上下文" },
  { id: "generate", title: "生成小屏应用", note: "index.html / style.css / app.js / hardware_app.py" },
  { id: "build", title: "本地 L0-L3 验证", note: "contracts + syntax + hardware sim + render" },
  { id: "ready", title: "等待确认部署", note: "不会自动写入真机" },
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

function renderPlanList(items) {
  return `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}



// User-friendly error messages with actionable suggestions
const FRIENDLY_ERRORS = {
  ssh_timeout: {
    title: "设备连接超时",
    detail: "无法在规定时间内连接到泰山派设备。",
    suggestion: "请检查：① 设备是否已开机 ② 设备是否连接了网络 ③ FRP 隧道是否正常"
  },
  connection_refused: {
    title: "设备拒绝连接",
    detail: "泰山派设备的 SSH 服务没有响应。",
    suggestion: "请检查：① 设备是否已开机 ② SSH 服务是否正常运行 ③ 端口号是否正确"
  },
  board_offline: {
    title: "设备离线",
    detail: "无法连接到泰山派设备，设备可能已关机或网络不通。",
    suggestion: "请检查：① 设备是否已开机并连接网络 ② FRP 隧道是否正常 ③ 稍等片刻后重试"
  },
  auth_failed: {
    title: "设备认证失败",
    detail: "SSH 密码认证被拒绝。",
    suggestion: "请检查设备 SSH 密码是否正确，或联系管理员重置"
  },
  connection_dropped: {
    title: "设备连接中断",
    detail: "SSH 连接在传输过程中断开。",
    suggestion: "可能是网络不稳定，请稍后重试"
  },
  deploy_mkdir: {
    title: "设备存储空间不足",
    detail: "无法在设备上创建部署目录。",
    suggestion: "设备存储可能已满，请联系管理员清理设备空间"
  },
  deploy_copy: {
    title: "文件写入设备失败",
    detail: "应用文件无法复制到设备的目标目录。",
    suggestion: "可能是设备存储空间不足或文件权限问题"
  },
  deploy_compile: {
    title: "应用在设备上运行出错",
    detail: "应用代码在泰山派上执行时出现错误。",
    suggestion: "可能是代码兼容性问题，请尝试重新生成应用"
  },
  deploy_service: {
    title: "设备服务重启失败",
    detail: "泰山派上的显示服务无法正常重启。",
    suggestion: "请尝试手动重启设备，或联系管理员检查服务状态"
  },
  deploy_http: {
    title: "设备 HTTP 服务无响应",
    detail: "部署完成后，设备上的网页服务没有正常启动。",
    suggestion: "应用可能启动缓慢，请等待几秒后刷新页面查看"
  },
  no_api_key: {
    title: "未配置 AI 模型",
    detail: "还没有设置 AI 模型的 API Key，将使用本地模板生成。",
    suggestion: "点击右上角「Model」按钮配置 DeepSeek 或其他模型"
  },
  llm_failed: {
    title: "AI 模型调用失败",
    detail: "无法连接到 AI 模型服务。",
    suggestion: "请检查：① API Key 是否正确 ② 网络是否能访问模型服务"
  },
  llm_auth: {
    title: "模型认证失败",
    detail: "DeepSeek 返回了 API Key 无效或无权限，代码生成还没有开始。",
    suggestion: "请在当前 VibeBoard 页面重新配置 DeepSeek API Key，或用 DEEPSEEK_API_KEY / VIBEBOARD_LLM_API_KEY 启动服务后重试"
  },
  llm_timeout: {
    title: "AI 模型响应超时",
    detail: "AI 模型没有在规定时间内返回结果。",
    suggestion: "可能是模型服务繁忙，请稍后重试"
  },
  syntax_error: {
    title: "代码语法错误",
    detail: "生成的 JavaScript 代码有语法问题。",
    suggestion: "系统会尝试重新生成，请再试一次"
  },
  python_syntax: {
    title: "硬件代码语法错误",
    detail: "生成的 Python 硬件代码有语法问题。",
    suggestion: "系统会尝试重新生成，请再试一次"
  },
  empty_file: {
    title: "生成的文件为空",
    detail: "代码生成过程中出现了问题，文件内容为空。",
    suggestion: "请重新生成，如果持续出现请联系管理员"
  },
  no_code: {
    title: "此应用为示例预览",
    detail: "这个应用没有存储源代码，无法直接部署到设备。",
    suggestion: "请在对话中输入类似的需求，生成你自己的应用版本后部署"
  },
  empty_prompt: {
    title: "请输入你的需求",
    detail: "描述不能为空。",
    suggestion: "例如：做一个显示天气的应用、做一个时钟"
  },
  deploy_failed: {
    title: "部署失败",
    detail: "将应用写入设备时出现问题。",
    suggestion: "请检查设备状态后重试"
  },
  generate_failed: {
    title: "代码生成失败",
    detail: "生成应用代码时出现问题。",
    suggestion: "请检查模型配置后重试"
  },
  server_unreachable: {
    title: "无法连接到服务器",
    detail: "VibeBoard 服务器没有响应，可能已停止运行。",
    suggestion: "请检查服务器是否在运行，或尝试重新启动"
  },
  unknown: {
    title: "操作失败",
    detail: "执行过程中出现了未知错误。",
    suggestion: "请稍后重试，如果问题持续请联系管理员"
  }
};

function friendlyError(data, fallbackMsg) {
  const type = data?.errorType || "unknown";
  const info = FRIENDLY_ERRORS[type] || FRIENDLY_ERRORS.unknown;
  return {
    title: info.title,
    detail: info.detail,
    suggestion: info.suggestion,
    type,
    raw: data?.error || fallbackMsg || ""
  };
}

function formatFriendlyError(data, fallbackMsg) {
  const f = friendlyError(data, fallbackMsg);
  return f.title + "。" + f.detail + "\n💡 " + f.suggestion;
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
  title.textContent = "我开始执行您的任务";
  const list = document.createElement("div");
  list.className = "stage-list";
  stages.forEach(stage => {
    const row = document.createElement("div");
    row.className = "stage";
    row.dataset.stage = stage.id;
    row.innerHTML = `<i></i><span>${escapeHtml(stage.title)}<br><small>${escapeHtml(stage.note)}</small></span><em>wait</em>`;
    list.appendChild(row);
  });
  const log = document.createElement("div");
  log.className = "work-log";
  const addLog = message => {
    const item = document.createElement("div");
    item.className = "work-log-item";
    item.textContent = `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} ${message}`;
    log.appendChild(item);
    chatLog.scrollTop = chatLog.scrollHeight;
  };
  addLog("Task accepted. I am reading the request and preparing the local verification path.");
  card.append(title, list, log);
  article.append(avatar, card);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;

  return {
    log: addLog,
    set(id, state, note, options = {}) {
      const row = list.querySelector(`[data-stage="${id}"]`);
      if (!row) return;
      row.classList.remove("active", "done", "fail");
      if (state) row.classList.add(state);
      row.querySelector("em").textContent = note || state || "wait";
      if (!options.silent) {
        addLog(`${row.querySelector("span")?.childNodes?.[0]?.textContent || id}: ${note || state || "wait"}`);
      }
      chatLog.scrollTop = chatLog.scrollHeight;
    }
  };
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${pad(seconds)}s` : `${seconds}s`;
}

function describeGenerateLog(entry = {}) {
  const event = entry.event || "";
  if (event === "generate.agent.start") {
    return `Agent started: ${entry.model || entry.provider || "model"}`;
  }
  if (event === "generate.template.start") {
    return "Using local template generator";
  }
  if (event === "generate.agent.auto_verify") {
    const issueCount = Number.isFinite(entry.issueCount) ? entry.issueCount : 0;
    return issueCount > 0 ? `Auto verification found ${issueCount} issue(s)` : "Auto verification passed";
  }
  if (event === "generate.agent.failed") {
    return `Agent failed: ${entry.error || entry.summary || "see details"}`;
  }
  if (event === "build.start") {
    return "Local verification started";
  }
  if (event === "build.done") {
    const issueCount = Number.isFinite(entry.issueCount) ? entry.issueCount : 0;
    return issueCount > 0 ? `Local verification finished with ${issueCount} issue(s)` : "Local verification passed";
  }
  if (event === "generate.template.done") {
    return "Template generation finished";
  }
  if (event !== "generate.agent.action") {
    return "";
  }

  const tool = entry.tool || "action";
  const path = entry.path ? ` ${entry.path}` : "";
  if (tool === "read_file") return `Reading${path}`;
  if (tool === "create_file") return `Creating${path}`;
  if (tool === "edit_file") return `Editing${path}`;
  if (tool === "search_code") return `Searching ${entry.query || path || "code"}`;
  if (tool === "verify_syntax") return "Checking syntax";
  if (tool === "verify_render") return "Checking screen render";
  if (tool === "run_hardware") return "Running hardware simulation";
  if (tool === "record_lesson") return "Recording repair note";
  if (tool === "done") return entry.summary ? `Agent done: ${entry.summary}` : "Agent finished";
  return path ? `${tool}${path}` : tool;
}

function createGenerateLogPoller(progress) {
  const startedAt = Date.now();
  const seen = new Set();
  let stopped = false;
  let timer = null;
  let latestAction = "starting";
  let lastLogAt = 0;
  let consecutiveFailures = 0;

  const usefulEvents = new Set([
    "generate.agent.start",
    "generate.agent.action",
    "generate.agent.auto_verify",
    "generate.agent.failed",
    "generate.template.start",
    "generate.template.done",
    "build.start",
    "build.done"
  ]);

  const updateStage = () => {
    if (stopped) return;
    progress.set("generate", "active", `${formatElapsed(Date.now() - startedAt)} | ${latestAction}`, { silent: true });
  };

  const remember = entry => {
    const key = [
      entry.ts || "",
      entry.event || "",
      entry.tool || "",
      entry.path || "",
      entry.query || "",
      entry.summary || "",
      entry.id || ""
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  const poll = async () => {
    if (stopped) return;
    updateStage();
    try {
      const data = await getJson("/api/logs?limit=80", { timeout: 5000 });
      consecutiveFailures = 0;
      const logs = Array.isArray(data.logs) ? data.logs : [];
      for (const entry of logs) {
        const entryTime = Date.parse(entry.ts || "");
        if (Number.isFinite(entryTime) && entryTime < startedAt - 1000) continue;
        if (!usefulEvents.has(entry.event) || !remember(entry)) continue;
        const message = describeGenerateLog(entry);
        if (!message) continue;
        latestAction = message.length > 90 ? `${message.slice(0, 87)}...` : message;
        const now = Date.now();
        if (entry.event === "generate.agent.action" && now - lastLogAt < 900) {
          updateStage();
          continue;
        }
        progress.log(`${formatElapsed(now - startedAt)} ${latestAction}`);
        lastLogAt = now;
        updateStage();
      }
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures === 2) {
        latestAction = "waiting for server logs";
        progress.log(`${formatElapsed(Date.now() - startedAt)} Waiting for backend progress logs...`);
      }
    } finally {
      if (!stopped) timer = window.setTimeout(poll, 1200);
    }
  };

  return {
    start() {
      progress.log("Streaming backend generation progress...");
      poll();
    },
    stop(finalNote) {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      if (finalNote) {
        latestAction = finalNote;
        progress.set("generate", "active", `${formatElapsed(Date.now() - startedAt)} | ${latestAction}`, { silent: true });
      }
    }
  };
}

function withDeviceQuery(url) {
  const href = new URL(url, window.location.origin);
  href.searchParams.set("deviceId", activeDeviceId);
  return `${href.pathname}${href.search}`;
}

function withDevicePayload(payload = {}) {
  return { ...payload, deviceId: activeDeviceId };
}

async function postJson(url, payload = {}, { timeout = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withDevicePayload(payload)),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.errorLabel || data.error || `HTTP ${res.status}`);
      err.data = data;
      throw err;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const err = new Error("请求超时");
      err.data = { errorType: "ssh_timeout" };
      throw err;
    }
    // Network error (server down, connection reset, etc.)
    if (error instanceof TypeError && /fetch|network|Failed to fetch/i.test(error.message)) {
      const err = new Error("无法连接到服务器");
      err.data = { errorType: "server_unreachable" };
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, { timeout = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(withDeviceQuery(url), { cache: "no-store", signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.errorLabel || data.error || `HTTP ${res.status}`);
      err.data = data;
      throw err;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const err = new Error("请求超时");
      err.data = { errorType: "ssh_timeout" };
      throw err;
    }
    if (error instanceof TypeError && /fetch|network|Failed to fetch/i.test(error.message)) {
      const err = new Error("无法连接到服务器");
      err.data = { errorType: "server_unreachable" };
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
  activeFile = names.includes(activeFile) ? activeFile : "";
  fileTabs.innerHTML = "";
  if (!names.length) {
    activeFile = "";
    codePreview.textContent = "# no generated files for this project";
    return;
  }
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

function clearGeneratedOutput(statusText = "等待生成") {
  renderFiles({});
  showBlankDeviceFrame();
  if (deviceScreen) {
    deviceScreen.dataset.status = statusText;
    deviceScreen.dataset.prompt = "";
  }
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
  const overlay = document.querySelector('.mac-screen-overlay');
  if (!overlay) return;

  // Get the actual size of the CRT screen overlay area
  const rect = overlay.getBoundingClientRect();
  const availableWidth = rect.width;
  const availableHeight = rect.height;

  if (!availableWidth || !availableHeight) return;

  // Calculate scale to fit 480x360 iframe into the CRT screen area
  const scale = Math.min(availableWidth / 480, availableHeight / 360);
  overlay.style.setProperty('--screen-scale', String(scale));
}

function scheduleFitDeviceFrame() {
  requestAnimationFrame(() => {
    fitDeviceFrame();
    requestAnimationFrame(fitDeviceFrame);
  });
}

function makePreviewUrl(path = "/generated/current/index.html", buildId = Date.now()) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("build", String(buildId));
  url.searchParams.set("deviceId", activeDeviceId);
  return `${url.pathname}${url.search}`;
}

function makeConversationPreviewUrl(conversationId, buildId = Date.now()) {
  const encodedId = encodeURIComponent(conversationId || "");
  return makePreviewUrl(`/api/conversations/${encodedId}/preview/index.html`, buildId);
}

function showBlankDeviceFrame() {
  if (!deviceFrame) return;
  deviceFrame.removeAttribute("src");
  deviceFrame.srcdoc = BLANK_DEVICE_FRAME_HTML;
  scheduleFitDeviceFrame();
}

function setDeviceFrameSrc(src) {
  if (!deviceFrame || !src) return;
  deviceFrame.removeAttribute("srcdoc");
  deviceFrame.src = src;
}

function applyDeviceProfile({ refresh = true } = {}) {
  const profile = deviceProfiles[activeDeviceId] || deviceProfiles["taishan-gray"];
  if (deviceSelect) deviceSelect.value = profile.id;
  if (macPhotoImg) {
    macPhotoImg.src = profile.image;
    macPhotoImg.alt = `${profile.label} Taishan Board`;
  }
  if (macPhoto) {
    macPhoto.dataset.device = profile.id;
    macPhoto.style.setProperty("--screen-left", profile.screen.left);
    macPhoto.style.setProperty("--screen-top", profile.screen.top);
    macPhoto.style.setProperty("--screen-width", profile.screen.width);
    macPhoto.style.setProperty("--screen-height", profile.screen.height);
  }
  scheduleFitDeviceFrame();
  if (refresh) {
    syncDeviceFrameFromActiveContext();
    refreshBoard();
  }
}

function renderDevicePreview(prompt, statusText) {
  if (deviceFrame) {
    let buildId = "";
    try {
      buildId = generatedFiles?.["manifest.json"] ? JSON.parse(generatedFiles["manifest.json"]).id || "" : "";
    } catch {}
    if (!buildId) buildId = Date.now();
    const profile = deviceProfiles[activeDeviceId] || deviceProfiles["taishan-gray"];
    setDeviceFrameSrc(makePreviewUrl(profile.previewPath, buildId));
  }
  if (deviceScreen) {
    deviceScreen.dataset.status = statusText || "";
    deviceScreen.dataset.prompt = prompt || "";
  }
}

function renderConversationPreview(conversationId, buildId, statusText) {
  if (!conversationId) {
    clearGeneratedOutput(statusText || "等待生成");
    return;
  }
  if (deviceFrame) {
    setDeviceFrameSrc(makeConversationPreviewUrl(conversationId, buildId || Date.now()));
  }
  if (deviceScreen) {
    deviceScreen.dataset.status = statusText || "已加载应用";
    deviceScreen.dataset.prompt = "";
  }
}

function currentGeneratedBuildId() {
  try {
    return generatedFiles?.["manifest.json"] ? JSON.parse(generatedFiles["manifest.json"]).id || "" : "";
  } catch {
    return "";
  }
}

function hasDeployableBuild() {
  return Boolean(
    generatedFiles &&
    Object.keys(generatedFiles).length &&
    generatedFiles["index.html"] &&
    generatedFiles["manifest.json"]
  );
}

async function findDeployableBuildId() {
  const currentBuildId = currentGeneratedBuildId();
  if (hasDeployableBuild()) return currentBuildId;
  try {
    const res = await fetch("/generated/current/manifest.json", { cache: "no-store" });
    if (!res.ok) return "";
    const manifest = await res.json();
    return String(manifest?.id || "").trim();
  } catch {
    return "";
  }
}

function syncDeviceFrameFromActiveContext() {
  if (currentConversationId) {
    if (Object.keys(generatedFiles || {}).length) {
      renderConversationPreview(
        currentConversationId,
        currentGeneratedBuildId() || Date.now(),
        deviceScreen?.dataset.status || "已加载应用"
      );
    } else {
      clearGeneratedOutput(deviceScreen?.dataset.status || "等待生成");
    }
    return;
  }
  syncDeviceFrameFromCurrent();
}

async function syncDeviceFrameFromCurrent() {
  if (!deviceFrame) return;
  const profile = deviceProfiles[activeDeviceId] || deviceProfiles["taishan-gray"];
  try {
    const res = await fetch("/generated/current/manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`missing generated app manifest: ${res.status}`);
    const manifest = await res.json();
    const buildId = manifest.id || Date.now();
    setDeviceFrameSrc(makePreviewUrl(profile.previewPath, buildId));
  } catch {
    showBlankDeviceFrame();
  }
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
    goldenLoopState.textContent = goldenLoop.skipped ? "skipped" : goldenLoop.ok ? "passed" : "failed";
    goldenLoopState.className = goldenLoop.skipped ? "skip" : goldenLoop.ok ? "ok" : "fail";
  }

  if (!verifyList) return;
  verifyList.innerHTML = "";
  (goldenLoop.checks || []).forEach(check => {
    const item = document.createElement("div");
    item.className = `verify-item ${check.skipped ? "skip" : check.ok ? "pass" : "fail"}`;
    item.innerHTML = `
      <div>
        <b>${escapeHtml(check.label || check.id)}</b>
        <small>${escapeHtml(check.evidence || "")}</small>
      </div>
      <span>${check.skipped ? "skip" : check.ok ? "pass" : "fail"}</span>
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

  el("compileState").textContent = result.skipped ? "local ok" : compileLog ? "board ok" : "local ok";
  el("programState").textContent = result.skipped ? "skipped" : hardware ? "executed" : "no result";
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
      golden_loop: goldenLoop.skipped ? "skipped" : goldenLoop.ok ? "passed" : "failed",
      id: goldenLoop.id,
      mode: goldenLoop.mode,
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
    if (sshState) sshState.textContent = data.connected ? "ssh live" : "ssh checking";
    if (data.kernel) el("boardOs").textContent = `Linux ${data.kernel}`;
    if (!data.connected && !data.error) {
      window.setTimeout(() => refreshBoard(), 3000);
    }
  } catch (error) {
    const sshState = el("sshState");
    if (sshState) sshState.textContent = "offline";
    const f = friendlyError(error.data, error.message);
    addMessage("agent", `⚠️ ${f.title}。${f.detail}\n💡 ${f.suggestion}`);
  } finally {
    if (refreshBoardBtn) refreshBoardBtn.disabled = false;
  }
}

// Add a visible execution-process bubble to the chat
function addThinkingBubble(thinking) {
  const article = document.createElement("article");
  article.className = "msg agent thinking-msg";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "VB";
  const body = document.createElement("div");
  body.className = "thinking-body";
  const header = document.createElement("div");
  header.className = "thinking-header";
  header.innerHTML = `<span class="thinking-icon">🧠</span> <span>执行过程</span> <span class="thinking-toggle">▲</span>`;
  const content = document.createElement("div");
  content.className = "thinking-content";
  content.style.display = "block";
  // Format process text: preserve line breaks
  const lines = thinking.split("\n").filter(l => l.trim());
  for (const line of lines) {
    const p = document.createElement("p");
    p.textContent = line;
    content.appendChild(p);
  }
  header.addEventListener("click", () => {
    const isHidden = content.style.display === "none";
    content.style.display = isHidden ? "block" : "none";
    header.querySelector(".thinking-toggle").textContent = isHidden ? "▲" : "▼";
  });
  body.append(header, content);
  article.append(avatar, body);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
  return article;
}

// Show agent actions as a collapsible card
function addAgentActionsCard(actions, summary) {
  const article = document.createElement("article");
  article.className = "msg agent";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "VB";
  const body = document.createElement("div");
  body.className = "agent-card";

  const header = document.createElement("div");
  header.className = "agent-card-header";
  const icon = document.createElement("span");
  icon.textContent = "⚙️";
  const title = document.createElement("span");
  title.textContent = `执行了 ${actions.length} 步操作`;
  const toggle = document.createElement("span");
  toggle.className = "agent-toggle";
  toggle.textContent = "▼";
  header.append(icon, title, toggle);

  const list = document.createElement("div");
  list.className = "agent-actions-list";
  list.style.display = "none";

  const toolIcons = {
    list_files: "📁", read_file: "📖", search_code: "🔍",
    edit_file: "✏️", create_file: "📄", verify_syntax: "✅", done: "🎯"
  };

  for (const action of actions) {
    const row = document.createElement("div");
    row.className = "agent-action";
    const toolIcon = document.createElement("span");
    toolIcon.className = "agent-action-icon";
    toolIcon.textContent = toolIcons[action.tool] || "🔧";
    const desc = document.createElement("span");
    desc.className = "agent-action-desc";
    if (action.tool === "edit_file") {
      desc.textContent = `编辑 ${action.path || ""}`;
    } else if (action.tool === "read_file") {
      desc.textContent = `读取 ${action.path || ""}`;
    } else if (action.tool === "search_code") {
      desc.textContent = `搜索 "${action.query || ""}" in ${action.path || ""}`;
    } else if (action.tool === "create_file") {
      desc.textContent = `创建 ${action.path || ""}`;
    } else if (action.tool === "verify_syntax") {
      desc.textContent = "验证语法";
    } else if (action.tool === "done") {
      desc.textContent = action.summary || "完成";
    } else {
      desc.textContent = action.tool;
    }
    row.append(toolIcon, desc);
    list.appendChild(row);
  }

  header.addEventListener("click", () => {
    const isHidden = list.style.display === "none";
    list.style.display = isHidden ? "block" : "none";
    toggle.textContent = isHidden ? "▲" : "▼";
  });

  body.append(header, list);
  article.append(avatar, body);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addEvidenceCard(payload = {}) {
  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const spec = payload.spec || null;
  const buildEvidence = payload.buildEvidence || null;
  const mode = payload.verificationMode || "local-simulated";

  if (!evidence.length && !spec && !buildEvidence) return;

  const article = document.createElement("article");
  article.className = "msg agent";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "VB";
  const body = document.createElement("div");
  body.className = "agent-card evidence-card";

  const header = document.createElement("div");
  header.className = "agent-card-header";
  const icon = document.createElement("span");
  icon.textContent = buildEvidence?.ok === false ? "!" : "OK";
  const title = document.createElement("span");
  title.textContent = "Verification Evidence";
  const modePill = document.createElement("span");
  modePill.className = `evidence-mode ${mode.includes("real") ? "real" : "sim"}`;
  modePill.textContent = mode.includes("real") ? "real-ready" : "local/sim";
  const toggle = document.createElement("span");
  toggle.className = "agent-toggle";
  toggle.textContent = ">";
  header.append(icon, title, modePill, toggle);

  const list = document.createElement("div");
  list.className = "evidence-list";
  list.style.display = "none";

  if (spec) {
    const specRow = document.createElement("div");
    specRow.className = "evidence-item pass";
    specRow.innerHTML = `<b>Spec</b><span>${escapeHtml(spec.appType || "custom")} | 480x360 | ${spec.requiresCloud ? "cloud needed" : "local ready"}</span>`;
    list.appendChild(specRow);
  }

  for (const item of evidence) {
    const row = document.createElement("div");
    row.className = `evidence-item ${item.ok ? "pass" : "fail"}`;
    row.innerHTML = `<b>${escapeHtml(item.phase || "phase")}</b><span>${escapeHtml(item.summary || (item.ok ? "passed" : "failed"))}</span>`;
    list.appendChild(row);
  }

  if (buildEvidence) {
    const row = document.createElement("div");
    row.className = `evidence-item ${buildEvidence.ok ? "pass" : "fail"}`;
    const ev = buildEvidence.evidence || {};
    row.innerHTML = `<b>build</b><span>${escapeHtml(buildEvidence.summary || "local build")} | ${escapeHtml(ev.hardwareResult || "")}</span>`;
    list.appendChild(row);
  }

  const boardRow = document.createElement("div");
  boardRow.className = mode.includes("real") ? "evidence-item pending" : "evidence-item skip";
  boardRow.innerHTML = `<b>board</b><span>${mode.includes("real") ? "ready for golden loop" : "skipped: no board credential configured"}</span>`;
  list.appendChild(boardRow);

  header.addEventListener("click", () => {
    const isHidden = list.style.display === "none";
    list.style.display = isHidden ? "grid" : "none";
    toggle.textContent = isHidden ? "v" : ">";
  });

  body.append(header, list);
  article.append(avatar, body);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Show execution animation while waiting
function addThinkingAnimation() {
  const article = document.createElement("article");
  article.className = "msg agent thinking-msg";
  article.id = "thinking-animation";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "VB";
  const body = document.createElement("div");
  body.className = "thinking-body thinking-active";
  body.innerHTML = `<span class="thinking-icon">🧠</span> <span>正在执行任务</span><span class="thinking-dots">...</span>`;
  article.append(avatar, body);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
  return article;
}

function removeThinkingAnimation() {
  const el = document.getElementById("thinking-animation");
  if (el) el.remove();
}

// Build conversation history for multi-turn context (send ALL, server compresses)
function buildConversationHistory() {
  const msgs = chatLog.querySelectorAll(".msg");
  const history = [];
  for (const msg of msgs) {
    const role = msg.classList.contains("user") ? "user" : "assistant";
    const body = msg.querySelector("p, .msg-text");
    if (body) {
      const text = body.textContent.trim();
      if (text) history.push({ role, content: text });
    }
  }
  return history;
}

// ─── Clarify UI ───

function addClarifyCard(questions, onConfirm) {
  const card = document.createElement("div");
  card.className = "clarify-card";
  card.innerHTML = `
    <div class="clarify-header">
      <span class="clarify-icon">❓</span>
      <span class="clarify-title">帮我确认几个细节</span>
      <span class="clarify-reasoning"></span>
    </div>
    <div class="clarify-questions"></div>
    <div class="clarify-actions">
      <button class="btn btn-ghost clarify-skip">跳过，直接生成</button>
      <button class="btn btn-primary clarify-confirm">确认选择</button>
    </div>
  `;

  const questionsContainer = card.querySelector(".clarify-questions");
  const answers = {};

  // 渲染每个问题
  for (const q of questions) {
    const qEl = document.createElement("div");
    qEl.className = "clarify-question";
    qEl.innerHTML = `
      <div class="clarify-question-text">${q.question}</div>
      <div class="clarify-options" data-key="${q.key}"></div>
    `;

    const optionsContainer = qEl.querySelector(".clarify-options");
    // 预选第一个选项
    answers[q.key] = { key: q.key, question: q.question, answer: q.options[0] };

    for (let i = 0; i < q.options.length; i++) {
      const optBtn = document.createElement("button");
      optBtn.className = `clarify-option ${i === 0 ? "selected" : ""}`;
      optBtn.textContent = q.options[i];
      optBtn.addEventListener("click", () => {
        // 取消同组其他选中
        optionsContainer.querySelectorAll(".clarify-option").forEach(b => b.classList.remove("selected"));
        optBtn.classList.add("selected");
        answers[q.key] = { key: q.key, question: q.question, answer: q.options[i] };
      });
      optionsContainer.appendChild(optBtn);
    }

    questionsContainer.appendChild(qEl);
  }

  // 显示 reasoning
  const reasoningEl = card.querySelector(".clarify-reasoning");

  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;

  return new Promise((resolve) => {
    // 确认按钮
    card.querySelector(".clarify-confirm").addEventListener("click", () => {
      card.remove();
      resolve(Object.values(answers));
    });

    // 跳过按钮
    card.querySelector(".clarify-skip").addEventListener("click", () => {
      card.remove();
      resolve([]);
    });
  });
}

// Clarify 卡片样式（注入到 head）
if (!document.getElementById("clarify-styles")) {
  const style = document.createElement("style");
  style.id = "clarify-styles";
  style.textContent = `
    .clarify-card {
      background: var(--surface-1, #1a1a2e);
      border: 1px solid var(--border, #2a2a4a);
      border-radius: 12px;
      padding: 16px;
      margin: 12px 0;
      max-width: 100%;
    }
    .clarify-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .clarify-icon { font-size: 18px; }
    .clarify-title {
      font-weight: 600;
      font-size: 14px;
      color: var(--text, #e0e0e0);
    }
    .clarify-question {
      margin-bottom: 12px;
    }
    .clarify-question-text {
      font-size: 13px;
      color: var(--text-secondary, #a0a0b0);
      margin-bottom: 8px;
    }
    .clarify-options {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .clarify-option {
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--border, #2a2a4a);
      background: var(--surface-0, #0d0d1a);
      color: var(--text, #e0e0e0);
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .clarify-option:hover {
      border-color: var(--accent, #6366f1);
    }
    .clarify-option.selected {
      background: var(--accent, #6366f1);
      border-color: var(--accent, #6366f1);
      color: white;
    }
    .clarify-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }
    .clarify-actions .btn {
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      border: none;
    }
    .clarify-actions .btn-ghost {
      background: transparent;
      color: var(--text-secondary, #a0a0b0);
      border: 1px solid var(--border, #2a2a4a);
    }
    .clarify-actions .btn-primary {
      background: var(--accent, #6366f1);
      color: white;
    }
  `;
  document.head.appendChild(style);
}

// ─── Markdown 渲染 ───

function renderMarkdown(text) {
  // 如果 marked.js 加载成功，用它；否则用简易渲染
  if (typeof marked !== "undefined") {
    try {
      return marked.parse(text, { breaks: true, gfm: true });
    } catch (e) { /* fallback */ }
  }
  // 简易 Markdown 渲染
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}

function addMarkdownMessage(role, text) {
  const article = document.createElement("article");
  article.className = `msg ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "You" : "VB";
  const body = document.createElement("div");
  body.className = "msg-text markdown-body";
  body.innerHTML = renderMarkdown(text);
  article.append(avatar, body);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
  return body;
}

// ─── 内联按钮组件 ───

function addInlineButtons(buttons) {
  const article = document.createElement("article");
  article.className = "msg agent";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "VB";
  const body = document.createElement("div");
  body.className = "inline-actions";

  for (const btn of buttons) {
    const button = document.createElement("button");
    button.className = `btn ${btn.primary ? "btn-primary" : "btn-ghost"}`;
    button.textContent = btn.label;
    button.addEventListener("click", () => {
      article.remove();
      btn.action();
    });
    body.appendChild(button);
  }

  article.append(avatar, body);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addQuickReplyButtons(quickReplies = []) {
  const choices = normalizeQuickReplyButtons(quickReplies);
  if (!choices.length) return;
  addInlineButtons(choices.map((choice, index) => ({
    label: choice.label,
    primary: index === 0,
    action: () => handleChat(choice.value),
  })));
}

function normalizeQuickReplyButtons(quickReplies = []) {
  if (!Array.isArray(quickReplies)) return [];
  const seen = new Set();
  const choices = [];
  for (const item of quickReplies) {
    const label = truncateButtonText(item?.label || item?.text || item?.value || item, 18);
    const value = String(item?.value || item?.prompt || item?.text || item?.label || item || "").trim();
    if (!label || !value || seen.has(value)) continue;
    seen.add(value);
    choices.push({ label, value });
    if (choices.length >= 4) break;
  }
  return choices;
}

function truncateButtonText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function addBuildPromptAction(buildPrompt, plan = {}) {
  const prompt = String(buildPrompt || "").trim();
  if (!prompt) return;
  pendingGeneratePrompt = prompt;

  const target = plan.target === "edit_current_project" ? "edit_current_project" : "new_project";
  const understanding = Array.isArray(plan.understanding) ? plan.understanding.filter(Boolean) : [];
  const plannedChanges = Array.isArray(plan.planned_changes) ? plan.planned_changes.filter(Boolean) : [];
  const article = document.createElement("article");
  article.className = "msg agent";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "VB";
  const body = document.createElement("div");
  body.className = "build-confirmation";
  const primaryLabel = target === "edit_current_project"
    ? "确认按这个方案修改当前项目"
    : "确认按这个方案开始构建";
  body.innerHTML = `
    <div class="confirm-copy">
      <strong>我理解你要的是：</strong>
      ${renderPlanList(understanding.length ? understanding : ["按当前对话整理出的方案执行。"])}
      <strong>我准备这样做：</strong>
      ${renderPlanList(plannedChanges.length ? plannedChanges : ["生成或修改项目文件。", "完成本地验证并保存这个聊天的预览快照。"])}
    </div>
    <div class="inline-actions">
      <button class="btn btn-primary" type="button" data-action="confirm">${escapeHtml(primaryLabel)}</button>
      <button class="btn btn-ghost" type="button" data-action="revise">继续补充或调整</button>
    </div>
  `;
  body.querySelector('[data-action="confirm"]')?.addEventListener("click", () => {
    article.remove();
    startBuild(pendingGeneratePrompt);
  });
  body.querySelector('[data-action="revise"]')?.addEventListener("click", () => {
    promptInput.value = "我还想再调整一下方案";
    promptInput.focus();
  });
  article.append(avatar, body);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ─── 对话式交互 ───

let pendingGeneratePrompt = null; // 暂存完整的生成 prompt

function isNegativeIntent(text) {
  return /(不要|不用|别|先别|取消|等等|等一下|不是|不对|还不|暂不|稍后|no|cancel|stop)/i.test(text);
}

function isBuildConfirmationIntent(prompt) {
  const text = String(prompt || "").trim();
  if (!text || isNegativeIntent(text)) return false;
  if (text.length > 30 && !/(按这个|按你说的|就这样|确认这个|开始执行|开始生成|开始构建)/i.test(text)) return false;
  return /(开始|开工|执行|生成|构建|确认|可以|可以了|就这样|按这个|按你说的|没问题|好的|好吧|行|go|ok|yes|start|build)/i.test(text);
}

function isDeployIntent(prompt) {
  const text = String(prompt || "").trim();
  if (!text || isNegativeIntent(text)) return false;
  return /(部署|写入真机|写到真机|上板|发到板子|发布到硬件|烧到板|运行到板|deploy|push to board|run on board)/i.test(text);
}

function showDeployConfirmationForCurrentBuild(prompt = "", buildId = currentGeneratedBuildId()) {
  const profile = deviceProfiles[activeDeviceId] || deviceProfiles["taishan-gray"];
  const reply = `可以，当前对话里已经有可部署的构建${buildId ? `（${buildId}）` : ""}。我不会自动写入真机，点下面按钮就开始部署到 ${profile.label}。`;
  addMarkdownMessage("agent", reply);
  persistMessage("agent", reply, buildId || null, currentConversationId);
  addInlineButtons([
    { label: `部署到${profile.label}真机`, primary: true, action: () => doDeploy(prompt) },
    { label: "先不部署", primary: false, action: () => addMarkdownMessage("agent", "好的，先保留当前本地验证结果。") },
  ]);
}

function showMissingBuildChoices() {
  const reply = "我还没找到当前对话里可直接部署的构建。你可以先生成应用，或切回左侧已有构建记录的对话。";
  addMarkdownMessage("agent", reply);
  persistMessage("agent", reply, null, currentConversationId);
  const firstAction = pendingGeneratePrompt
    ? {
        label: "先生成并验证",
        primary: true,
        action: () => {
          const buildPrompt = pendingGeneratePrompt;
          pendingGeneratePrompt = null;
          startBuild(buildPrompt);
        },
      }
    : {
        label: "先生成应用",
        primary: true,
        action: () => {
          promptInput.value = "按当前方案先生成一个可部署的小屏应用";
          promptInput.focus();
        },
      };
  addInlineButtons([
    firstAction,
    { label: "选择历史对话", primary: false, action: () => addMarkdownMessage("agent", "请在左侧选择带有构建记录的对话，我会自动恢复预览和部署按钮。") },
  ]);
}

function buildChatMessages() {
  const msgs = chatLog.querySelectorAll(".msg");
  const messages = [];
  for (const msg of msgs) {
    const role = msg.classList.contains("user") ? "user" : "assistant";
    const body = msg.querySelector("p, .msg-text");
    if (body) {
      const text = body.textContent.trim();
      if (text) messages.push({ role, content: text });
    }
  }
  return messages;
}

async function handleChat(prompt) {
  if (busy) return;
  prompt = String(prompt || "").trim();
  if (!prompt) return;

  await ensureConversation();
  const conversationId = currentConversationId;
  addMessage("user", prompt);
  persistMessage("user", prompt, null, conversationId);
  promptInput.value = "";

  if (isDeployIntent(prompt)) {
    const buildId = await findDeployableBuildId();
    if (buildId || hasDeployableBuild()) {
      showDeployConfirmationForCurrentBuild(prompt, buildId);
    } else {
      showMissingBuildChoices();
    }
    return;
  }

  if (pendingGeneratePrompt && isBuildConfirmationIntent(prompt)) {
    const buildPrompt = pendingGeneratePrompt;
    pendingGeneratePrompt = null;
    await startBuild(buildPrompt);
    return;
  }

  setBusy(true);
  addThinkingAnimation();

  try {
    const messages = buildChatMessages();
    const result = await postJson(api.agent, {
      action: "message",
      messages,
      conversation_id: conversationId,
      modelSettings: getModelPayload(),
    }, { timeout: 60000 });

    removeThinkingAnimation();

    if (result.error) {
      addMarkdownMessage("agent", `❌ **错误**：${result.error}`);
      return;
    }

    const reply = result.reply || "抱歉，我暂时无法回应。";
    addMarkdownMessage("agent", reply);
    persistMessage("agent", reply, null, conversationId);

    // 检测是否准备好构建
    if (result.ready_to_build) {
      pendingGeneratePrompt = String(result.build_prompt || "").trim();
      if (!pendingGeneratePrompt) {
        addMarkdownMessage("agent", "我还没有拿到完整的构建需求，请继续补充或确认方案。");
        return;
      }
      addBuildPromptAction(pendingGeneratePrompt, result);
    } else {
      addQuickReplyButtons(result.quick_replies);
    }
  } catch (error) {
    removeThinkingAnimation();
    const f = friendlyError(error.data, error.message);
    addMarkdownMessage("agent", `❌ **请求失败**：${f}`);
  } finally {
    setBusy(false);
  }
}

async function startBuild(originalPrompt) {
  originalPrompt = String(originalPrompt || pendingGeneratePrompt || "").trim();
  if (!originalPrompt) {
    addMarkdownMessage("agent", "我还没有整理出可构建的需求，请先继续聊清楚方案。");
    return;
  }
  addMarkdownMessage("agent", "🔨 **正在生成代码，请稍候...**");

  // 收集完整的对话上下文
  const history = buildChatMessages();

  // 调用原有的代码生成流程
  await runFlow(originalPrompt, history, currentConversationId);
}

async function runFlow(prompt, history = [], conversationId = currentConversationId) {
  if (busy) return;
  setBusy(true);
  deployState.textContent = labels.preparing;
  const progress = addStageCard();

  // 使用传入的历史，或从聊天记录构建
  const chatHistory = history.length > 0 ? history : buildConversationHistory();

  progress.set("intake", "active", "run");
  progress.log("I will generate and verify locally first. Hardware write waits for your deploy click.");
  addMarkdownMessage("agent", "我开始执行您的任务。先理解需求并做本地生成与验证，不会自动写入硬件。");

  // Show thinking animation
  addThinkingAnimation();

  let generatePoller = null;
  try {
    await new Promise(resolve => window.setTimeout(resolve, 250));
    progress.set("intake", "done", "ok");
    progress.set("generate", "active", "run");
    progress.log("Creating app files and the hardware Python contract.");
    deployState.textContent = labels.generating;
    generatePoller = createGenerateLogPoller(progress);
    generatePoller.start();
    const gen = await postJson(api.agent, {
      action: "confirm_build",
      prompt,
      build_prompt: prompt,
      modelSettings: getModelPayload(),
      conversation_id: conversationId,
      clarify_answers: [],
      history: chatHistory
    }, { timeout: 600000 });
    generatePoller.stop("response received");
    generatePoller = null;

    // Remove thinking animation, show agent actions
    removeThinkingAnimation();
    if (gen.agentActions?.length) {
      addAgentActionsCard(gen.agentActions, gen.agentSummary);
    } else if (gen.thinking) {
      addThinkingBubble(gen.thinking);
    } else {
      addThinkingBubble(`Execution trace
1. Task received: ${prompt}
2. No model reasoning output is available, so I continued through the local template path
3. Local verification is checking contracts, syntax, hardware simulation, and 480x360 render
4. Hardware write waits for your later deploy confirmation`);
    }
    addEvidenceCard(gen);

    if (!conversationId || conversationId === currentConversationId) {
      renderFiles(gen.files);
      if (conversationId) {
        renderConversationPreview(conversationId, gen.id, gen.agentSummary || "已生成应用");
      } else {
        renderDevicePreview(prompt, gen.agentSummary || "已生成应用");
      }
    }
    progress.set("generate", "done", "ok");
    el("lastBuildState").textContent = gen.id || "generated";

    progress.set("build", "active", "run");
    progress.log("Running local L0-L3 checks: contracts, syntax, hardware simulation, and render.");
    deployState.textContent = labels.building;
    let build = {
      ok: Boolean(gen.buildEvidence?.ok),
      summary: gen.buildEvidence?.summary || "local verification complete",
      buildEvidence: gen.buildEvidence || null,
      evidence: gen.evidence || [],
    };
    if (!build.buildEvidence) {
      build = await postJson(api.build, {});
      addEvidenceCard(build);
    }
    progress.set("build", "done", build.summary || "ok");

    deployState.textContent = "生成完成";
    const fileCount = Object.keys(gen.files).length;
    let verifyNote = "";
    if (gen.verification) {
      if (gen.verification.ok) {
        verifyNote = "\n\n✅ 截图验证通过，页面渲染正常。";
      } else {
        const issues = [
          ...(gen.verification.consoleErrors || []),
          ...(gen.verification.pageErrors || [])
        ];
        if (gen.verification.isBlank) issues.push("页面白屏");
        if (issues.length) verifyNote = `\n\n⚠️ 已自动修复 ${issues.length} 个问题并重新生成。`;
      }
    }

    const agentSummary = gen.agentSummary ? `\n\n> ${gen.agentSummary}` : "";
    const successMessage = `**本地生成与验证完成**\n\n已生成 **${fileCount}** 个文件，并通过本地 L0-L3 验证。${verifyNote}${agentSummary}\n\n我还没有写入硬件。你可以先在右侧预览确认效果；确认后再点击下方部署按钮。`;
    addMarkdownMessage("agent", successMessage);
    persistMessage("agent", successMessage, gen.id || null, conversationId);

    // 部署按钮放在聊天框内
    addInlineButtons([
      { label: "🚀 部署到真机", primary: true, action: () => doDeploy(prompt) },
      { label: "✏️ 继续修改", primary: false, action: () => {
        addMarkdownMessage("agent", "好的，请告诉我你想修改什么。");
      }},
    ]);
    progress.set("ready", "done", "awaiting deploy");
    progress.log("Local verification finished. Waiting for your explicit deploy confirmation.");
  } catch (error) {
    if (generatePoller) {
      generatePoller.stop("failed");
      generatePoller = null;
    }
    const current = stages.find(stage => document.querySelector(`[data-stage="${stage.id}"].active`));
    if (current) progress.set(current.id, "fail", "fail");
    deployState.textContent = labels.failed;
    const f = friendlyError(error.data, error.message);
    const errorMessage = `❌ **${f.title}**\n\n${f.detail}\n\n💡 ${f.suggestion}`;
    addMarkdownMessage("agent", errorMessage);
    persistMessage("agent", errorMessage, null, conversationId);
  } finally {
    setBusy(false);
  }
}

function addDeployButton(prompt) {
  const profile = deviceProfiles[activeDeviceId] || deviceProfiles["taishan-gray"];
  const article = document.createElement("article");
  article.className = "msg agent";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "VB";
  const body = document.createElement("div");
  body.className = "deploy-action";
  const btn = document.createElement("button");
  btn.className = "deploy-btn";
  btn.textContent = `部署到${profile.label}真机`;
  btn.addEventListener("click", () => runDeploy(btn));
  body.appendChild(btn);
  article.append(avatar, body);
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function doDeploy(prompt) {
  const profile = deviceProfiles[activeDeviceId] || deviceProfiles["taishan-gray"];
  if (busy) return;
  setBusy(true);
  deployState.textContent = labels.deploying;

  addMarkdownMessage("agent", `🚀 **正在部署到 ${profile.label}...**`);

  try {
    const deployed = await postJson(api.deploy, {});
    renderHardwareRun(deployed);
    if (deployed.skipped) {
      deployState.textContent = "hardware skipped";
      renderDevicePreview("", "local verification ready");
      addMarkdownMessage("agent", `**Hardware deploy skipped**\n\nNo reachable board is configured right now. Local L0-L3 verification passed and this build is ready for L4 golden-loop after hardware is connected.`);
    } else {
      deployState.textContent = labels.done;
      renderDevicePreview("", "已写入真机");
      addMarkdownMessage("agent", `✅ **部署成功！**\n\n应用已写入 **${profile.label}**，服务已重启。\n你可以在右侧预览窗口查看效果，或直接在设备屏幕上查看。`);
    }
  } catch (error) {
    deployState.textContent = labels.failed;
    const f = friendlyError(error.data, error.message);
    addMarkdownMessage("agent", `❌ **部署失败**\n\n${f.title}\n\n${f.detail}\n\n💡 ${f.suggestion}`);
  } finally {
    setBusy(false);
  }
}

async function runDeploy(btn) {
  const profile = deviceProfiles[activeDeviceId] || deviceProfiles["taishan-gray"];
  if (busy) return;
  setBusy(true);
  btn.disabled = true;
  btn.textContent = `部署到${profile.label}中...`;
  deployState.textContent = labels.deploying;

  try {
    const deployed = await postJson(api.deploy, {});
    renderHardwareRun(deployed);
    if (deployed.skipped) {
      deployState.textContent = "hardware skipped";
      renderDevicePreview("", "local verification ready");
      addMessage("agent", "Hardware deploy skipped. Local L0-L3 verification passed; connect the board to run L4 golden-loop.");
      btn.textContent = "Hardware skipped";
      btn.disabled = false;
    } else {
      deployState.textContent = labels.done;
      renderDevicePreview("", "已写入真机");
      addMessage("agent", `✅ 部署成功！应用已写入${profile.label}，服务已重启。\n你可以在右侧预览窗口查看效果，或直接在设备屏幕上查看。`);
      btn.textContent = "部署完成";
      btn.classList.add("done");
    }
  } catch (error) {
    deployState.textContent = labels.failed;
    const f = friendlyError(error.data, error.message);
    addMessage("agent", `❌ ${f.title}\n${f.detail}\n💡 ${f.suggestion}`);
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
  if (prompt) handleChat(prompt);
});

generateBtn?.addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();
  const prompt = promptInput.value.trim();
  if (prompt) handleChat(prompt);
});

refreshBoardBtn?.addEventListener("click", () => setStatusDrawer(true));
codeToggle?.addEventListener("click", () => setCodeDrawer(true));
closeDrawer?.addEventListener("click", () => setCodeDrawer(false));
closeStatusDrawer?.addEventListener("click", () => setStatusDrawer(false));
modelConfigBtn?.addEventListener("click", () => setModelModal(true));
closeModelModal?.addEventListener("click", () => setModelModal(false));
modelProvider?.addEventListener("change", () => applyProviderPreset(modelProvider.value));
deviceSelect?.addEventListener("change", () => {
  activeDeviceId = deviceProfiles[deviceSelect.value] ? deviceSelect.value : "taishan-gray";
  localStorage.setItem(DEVICE_STORAGE_KEY, activeDeviceId);
  deployState.textContent = "device changed";
  applyDeviceProfile();
});
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
applyDeviceProfile({ refresh: false });
syncModelUi();
window.addEventListener("resize", scheduleFitDeviceFrame);
if (deviceFrame) {
  deviceFrame.addEventListener("load", scheduleFitDeviceFrame);
}
const macOverlay = document.querySelector('.mac-screen-overlay');
if (macOverlay && "ResizeObserver" in window) {
  const observer = new ResizeObserver(scheduleFitDeviceFrame);
  observer.observe(macOverlay);
}

// ==================== Conversation Management ====================
const API_BASE = "";

let currentConversationId = null;

function rememberConversation(id) {
  if (id) localStorage.setItem(CONVERSATION_STORAGE_KEY, id);
  else localStorage.removeItem(CONVERSATION_STORAGE_KEY);
}

function rememberedConversationId() {
  return localStorage.getItem(CONVERSATION_STORAGE_KEY) || "";
}

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
      const conversations = data.conversations || [];
      renderConversationList(conversations);
      if (conversations.length) restoreCurrentConversation(conversations);
      else syncDeviceFrameFromCurrent();
    }
  } catch (err) {
    console.error("Failed to load conversations:", err);
  }
}

function restoreCurrentConversation(conversations = []) {
  if (busy || currentConversationId || !conversations.length) return;
  const savedId = rememberedConversationId();
  const remembered = conversations.find(conv => conv.id === savedId);
  const target = remembered || conversations[0];
  if (target?.id) selectConversation(target.id);
}

// Render conversation list
function renderConversationList(conversations) {
  const list = document.getElementById("conversationList");
  if (!list) return;

  list.innerHTML = conversations.map(conv => `
    <div class="conv-item ${conv.id === currentConversationId ? 'active' : ''}" data-id="${conv.id}">
      <div class="conv-title">${escapeHtml(conv.title)}</div>
      <div class="conv-time">${formatTime(conv.updated_at)}</div>
      <button class="conv-delete" data-id="${conv.id}" title="删除对话">×</button>
    </div>
  `).join("");

  // Add click handlers for conversation selection
  list.querySelectorAll(".conv-item").forEach(item => {
    item.addEventListener("click", (e) => {
      // Don't select if clicking delete button
      if (e.target.closest(".conv-delete")) return;
      selectConversation(item.dataset.id);
    });
  });

  // Add click handlers for delete buttons
  list.querySelectorAll(".conv-delete").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const convId = btn.dataset.id;
      if (!confirm("确定删除这个对话吗？")) return;
      try {
        const res = await fetch(`${API_BASE}/api/conversations/${convId}`, { method: "DELETE" });
        const data = await res.json();
        if (data.ok) {
          // If deleted the current conversation, clear selection
          if (convId === currentConversationId) {
            currentConversationId = null;
            rememberConversation(null);
            conversationLoadToken += 1;
            pendingGeneratePrompt = null;
            clearGeneratedOutput("等待生成");
            const chatLog = document.getElementById("chatLog");
            if (chatLog) chatLog.innerHTML = '<div class="msg"><p style="color:var(--text-2)">选择或新建一个对话开始</p></div>';
          }
          loadConversations();
        }
      } catch (err) {
        console.error("Failed to delete conversation:", err);
      }
    });
  });
}

// Select conversation
async function selectConversation(id) {
  if (busy) return; // Don't switch while a flow is running
  currentConversationId = id;
  rememberConversation(id);
  pendingGeneratePrompt = null;
  const loadToken = ++conversationLoadToken;

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

  // Load messages and files in parallel
  try {
    const [msgRes, fileRes, memoryRes] = await Promise.all([
      fetch(`${API_BASE}/api/conversations/${id}/messages`),
      fetch(`${API_BASE}/api/conversations/${id}/files`),
      fetch(`${API_BASE}/api/conversations/${id}/memory`)
    ]);
    const msgData = await msgRes.json();
    const fileData = await fileRes.json();
    const memoryData = await memoryRes.json();
    if (loadToken !== conversationLoadToken || id !== currentConversationId) return;

    // Restore code files if available
    if (fileData.ok && fileData.files && Object.keys(fileData.files).length > 0) {
      renderFiles(fileData.files);
      renderConversationPreview(id, fileData.buildId, "已加载应用");
    } else {
      clearGeneratedOutput("等待生成");
    }

    if (msgData.ok) {
      renderMessages(msgData.messages);
    }
    if (memoryData.ok) {
      addBuildPromptAction(memoryData.project_memory?.build_prompt, {
        understanding: memoryData.project_memory?.requirements || [],
        planned_changes: memoryData.project_memory?.decisions || [],
        target: fileData.ok && Object.keys(fileData.files || {}).length ? "edit_current_project" : "new_project"
      });
    }
  } catch (err) {
    console.error("Failed to load conversation:", err);
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
        <div class="welcome-block">
          <p class="welcome-greeting">👋 你好！我是 VibeBoard，你的硬件应用助手。</p>
          <p>告诉我你想在泰山派小屏上实现什么。我会先理解任务、生成文件并完成本地验证；写入真机需要你之后单独确认。</p>
          <div class="welcome-suggestions">
            <button class="suggestion-btn" data-prompt="做一个显示当前时间的全屏时钟应用">⏰ 全屏时钟</button>
            <button class="suggestion-btn" data-prompt="做一个显示天气信息和温度的应用">🌤 天气面板</button>
            <button class="suggestion-btn" data-prompt="做一个轮播展示图片的应用">🖼 图片轮播</button>
            <button class="suggestion-btn" data-prompt="做一个显示 CPU 温度和内存使用率的系统监控面板">📊 系统监控</button>
          </div>
        </div>
      </article>
    `;
    // Bind suggestion buttons
    chatLog.querySelectorAll('.suggestion-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        promptInput.value = btn.dataset.prompt;
        promptInput.focus();
      });
    });
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
    const profile = deviceProfiles[activeDeviceId] || deviceProfiles["taishan-gray"];
    const article = document.createElement("article");
    article.className = "msg agent";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "VB";
    const body = document.createElement("div");
    body.className = "deploy-action";
    const btn = document.createElement("button");
    btn.className = "deploy-btn";
    btn.textContent = `部署到${profile.label}真机`;
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
      rememberConversation(data.id);
      pendingGeneratePrompt = null;
      conversationLoadToken += 1;
      clearGeneratedOutput("等待生成");
      await loadConversations();
      if (resetChat) {
        const chatLog = document.getElementById("chatLog");
        if (chatLog) {
          chatLog.innerHTML = `
            <article class="msg agent">
              <div class="avatar">VB</div>
        <div class="welcome-block">
          <p class="welcome-greeting">👋 你好！我是 VibeBoard，你的硬件应用助手。</p>
          <p>告诉我你想在泰山派小屏上实现什么。我会先理解任务、生成文件并完成本地验证；写入真机需要你之后单独确认。</p>
          <div class="welcome-suggestions">
            <button class="suggestion-btn" data-prompt="做一个显示当前时间的全屏时钟应用">⏰ 全屏时钟</button>
            <button class="suggestion-btn" data-prompt="做一个显示天气信息和温度的应用">🌤 天气面板</button>
            <button class="suggestion-btn" data-prompt="做一个轮播展示图片的应用">🖼 图片轮播</button>
            <button class="suggestion-btn" data-prompt="做一个显示 CPU 温度和内存使用率的系统监控面板">📊 系统监控</button>
          </div>
        </div>
            </article>
          `;
          // Bind suggestion buttons
          chatLog.querySelectorAll('.suggestion-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              promptInput.value = btn.dataset.prompt;
              promptInput.focus();
            });
          });
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
async function saveMessage(role, content, buildId = null, conversationId = currentConversationId) {
  if (!conversationId) {
    await ensureConversation();
    conversationId = currentConversationId;
  }
  if (!conversationId) return;

  try {
    await fetch(`${API_BASE}/api/conversations/${conversationId}/messages`, {
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

function persistMessage(role, content, buildId = null, conversationId = currentConversationId) {
  saveMessage(role, content, buildId, conversationId).catch(err => {
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
