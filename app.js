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

const MODEL_STORAGE_KEY = "vibeboard-linux-model-settings";
const DEVICE_STORAGE_KEY = "vibeboard-active-device";
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

function withDeviceQuery(url) {
  const href = new URL(url, window.location.origin);
  href.searchParams.set("deviceId", activeDeviceId);
  return `${href.pathname}${href.search}`;
}

function withDevicePayload(payload = {}) {
  return { ...payload, deviceId: activeDeviceId };
}

async function postJson(url, payload = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withDevicePayload(payload))
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.errorLabel || data.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

async function getJson(url) {
  const res = await fetch(withDeviceQuery(url), { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.errorLabel || data.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
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
    syncDeviceFrameFromCurrent();
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
    deviceFrame.src = makePreviewUrl(profile.previewPath, buildId);
  }
  if (deviceScreen) {
    deviceScreen.dataset.status = statusText || "";
    deviceScreen.dataset.prompt = prompt || "";
  }
}

async function syncDeviceFrameFromCurrent() {
  if (!deviceFrame) return;
  const profile = deviceProfiles[activeDeviceId] || deviceProfiles["taishan-gray"];
  try {
    const res = await fetch("/generated/current/manifest.json", { cache: "no-store" });
    const manifest = await res.json();
    const buildId = manifest.id || Date.now();
    deviceFrame.src = makePreviewUrl(profile.previewPath, buildId);
  } catch {
    deviceFrame.src = makePreviewUrl(profile.previewPath, Date.now());
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

async function runFlow(prompt) {
  if (busy) return;
  setBusy(true);
  deployState.textContent = "starting";
  addMessage("user", prompt);
  persistMessage("user", prompt);
  const progress = addStageCard();
  const history = buildConversationHistory();

  try {
    progress.set("generate", "active", "run");
    deployState.textContent = labels.generating;
    const gen = await postJson(api.generate, {
      prompt,
      modelSettings: getModelPayload(),
      conversation_id: currentConversationId,
      history
    });
    renderFiles(gen.files);
    renderDevicePreview(prompt, "已生成应用");
    progress.set("generate", "done", "ok");
    el("lastBuildState").textContent = gen.id || "generated";
    if (gen.source === "llm") {
      addMessage("agent", `已通过 ${modelSettings.provider} / ${modelSettings.model} 生成应用代码。`);
    } else if (gen.fallbackReason) {
      const reason = gen.fallbackReason;
      let hint = "";
      if (/not configured|no api key/i.test(reason)) {
        hint = "💡 点击右上角「Model」配置 AI 模型后，可获得更好的生成效果。";
      } else if (/failed|timeout|error/i.test(reason)) {
        hint = "💡 请检查 API Key 和网络连接，或稍后重试。";
      }
      addMessage("agent", `⚠️ 未配置 AI 模型，已使用本地模板生成应用。\n${hint}`);
    }

    progress.set("build", "active", "run");
    deployState.textContent = labels.building;
    const build = await postJson(api.build, {});
    progress.set("build", "done", build.summary || "ok");

    deployState.textContent = "生成完成";
    addDeployButton(prompt);
    const fileCount = Object.keys(gen.files).length;
    let verifyNote = "";
    if (gen.verification) {
      if (gen.verification.ok) {
        verifyNote = "✅ 截图验证通过，页面渲染正常。";
      } else {
        const issues = [
          ...(gen.verification.consoleErrors || []),
          ...(gen.verification.pageErrors || [])
        ];
        if (gen.verification.isBlank) issues.push("页面白屏");
        if (issues.length) verifyNote = `⚠️ 已自动修复 ${issues.length} 个问题并重新生成。`;
      }
    }
    const successMessage = `已生成 ${fileCount} 个文件并通过编译校验。${verifyNote}
点击下方按钮部署到泰山派真机，或继续对话修改代码。`;
    addMessage("agent", successMessage);
    persistMessage("agent", successMessage, gen.id || null);
  } catch (error) {
    const current = stages.find(stage => document.querySelector(`[data-stage="${stage.id}"].active`));
    if (current) progress.set(current.id, "fail", "fail");
    deployState.textContent = labels.failed;
    const f = friendlyError(error.data, error.message);
    const errorMessage = `❌ ${f.title}\n${f.detail}\n💡 ${f.suggestion}`;
    addMessage("agent", errorMessage);
    persistMessage("agent", errorMessage);
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
    deployState.textContent = labels.done;
    renderDevicePreview("", "已写入真机");
    addMessage("agent", `✅ 部署成功！应用已写入${profile.label}，服务已重启。\n你可以在右侧预览窗口查看效果，或直接在设备屏幕上查看。`);
    btn.textContent = "部署完成";
    btn.classList.add("done");
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
applyDeviceProfile({ refresh: true });
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
    const [msgRes, fileRes] = await Promise.all([
      fetch(`${API_BASE}/api/conversations/${id}/messages`),
      fetch(`${API_BASE}/api/conversations/${id}/files`)
    ]);
    const msgData = await msgRes.json();
    const fileData = await fileRes.json();

    // Restore code files if available
    if (fileData.ok && fileData.files && Object.keys(fileData.files).length > 0) {
      renderFiles(fileData.files);
      renderDevicePreview("", "已加载应用");
    }

    if (msgData.ok) {
      renderMessages(msgData.messages);
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
          <p>告诉我你想在泰山派小屏上实现什么，我会自动生成代码、编译校验，然后一键写入真机。</p>
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
      await loadConversations();
      if (resetChat) {
        const chatLog = document.getElementById("chatLog");
        if (chatLog) {
          chatLog.innerHTML = `
            <article class="msg agent">
              <div class="avatar">VB</div>
        <div class="welcome-block">
          <p class="welcome-greeting">👋 你好！我是 VibeBoard，你的硬件应用助手。</p>
          <p>告诉我你想在泰山派小屏上实现什么，我会自动生成代码、编译校验，然后一键写入真机。</p>
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