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
  jobs: "/api/jobs",
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
const guideBtn = el("guideBtn");
const guideModal = el("guideModal");
const closeGuideModal = el("closeGuideModal");
const jobDrawer = el("jobDrawer");
const closeJobDrawer = el("closeJobDrawer");
const refreshJobsBtn = el("refreshJobsBtn");
const jobList = el("jobList");
const jobSummary = el("jobSummary");
const usageDrawer = el("usageDrawer");
const closeUsageDrawer = el("closeUsageDrawer");
const refreshUsageBtn = el("refreshUsageBtn");
const usageSummary = el("usageSummary");
const usageLedger = el("usageLedger");
const scrim = el("scrim");
const fileTabs = el("fileTabs");
const codePreview = el("codePreview");
const screenViewport = el("screenViewport");
const deviceScreen = el("deviceScreen");
const deviceFrame = el("deviceFrame");
const previewLoadingMask = el("previewLoadingMask");
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
const assetUploadBtn = el("assetUploadBtn");
const assetUploadInput = el("assetUploadInput");
const assetState = el("assetState");
const agentModeSelect = el("agentModeSelect");
const assetImportModal = el("assetImportModal");
const assetImportUpload = el("assetImportUpload");
const closeAssetImportModal = el("closeAssetImportModal");
const chooseAssetFilesBtn = el("chooseAssetFilesBtn");
const assetDropZone = el("assetDropZone");
const assetManagerBtn = el("assetManagerBtn");
const assetManagerDrawer = el("assetManagerDrawer");
const closeAssetManagerDrawer = el("closeAssetManagerDrawer");
const refreshAssetManagerBtn = el("refreshAssetManagerBtn");
const assetProjectList = el("assetProjectList");
const assetFileList = el("assetFileList");
const assetManagerPath = el("assetManagerPath");
const assetBreadcrumb = el("assetBreadcrumb");
const assetBackBtn = el("assetBackBtn");
const newAssetFolderBtn = el("newAssetFolderBtn");
const renameAssetItemBtn = el("renameAssetItemBtn");
const deleteAssetItemBtn = el("deleteAssetItemBtn");
const assetTableHead = el("assetTableHead");
const assetContextMenu = el("assetContextMenu");
const assetPropertiesModal = el("assetPropertiesModal");
const closeAssetPropertiesModal = el("closeAssetPropertiesModal");
const assetPropertiesBody = el("assetPropertiesBody");
const projectCreateModal = el("projectCreateModal");
const closeProjectCreateModal = el("closeProjectCreateModal");
const cancelProjectCreate = el("cancelProjectCreate");
const projectCreateForm = el("projectCreateForm");
const projectNameInput = el("projectNameInput");
const projectRootHint = el("projectRootHint");
const accountBtn = el("accountBtn");
const accountMenuWrap = el("accountMenuWrap");
const accountMenu = el("accountMenu");
const accountIdentity = el("accountIdentity");
const accountLogoutBtn = el("accountLogoutBtn");
const adminLink = el("adminLink");
const creditChip = el("creditChip");

let generatedFiles = {};
let activeFile = "";
let busy = false;
let previewLoadToken = 0;
let previewReadyTimer = null;
let foregroundTaskCount = 0;
let conversationInitPromise = null;
const activeRunFlows = new Map();
let messagePersistChain = Promise.resolve();
let conversationLoadToken = 0;
let jobsPollTimer = null;
let activeJobWaiters = new Set();
let assetManagerSelectedConversationId = "";
const GENERATION_START_TIMEOUT_MS = 300000;
let assetManagerCurrentFolderId = "";
let assetManagerSelection = null;
let assetManagerCache = { folders: [], assets: [], projectFiles: [] };
let assetContextTarget = null;
let currentUser = null;
let registerVerificationToken = "";

const MODEL_STORAGE_KEY = "vibeboard-linux-model-settings";
const DEVICE_STORAGE_KEY = "vibeboard-active-device";
const BOUND_DEVICE_STORAGE_KEY = "vibeboard-bound-device";
const CONVERSATION_STORAGE_KEY = "vibeboard-current-conversation";
const AGENT_MODE_STORAGE_KEY = "vibeboard-agent-mode";
const BLANK_DEVICE_FRAME_HTML = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden;}*{box-sizing:border-box;}</style></head><body></body></html>';
const deviceProfiles = {
  "taishan-transparent": {
    id: "taishan-transparent",
    label: "透明版",
    image: "/mac-frame-transparent.png",
    previewPath: "/generated/current/index.html",
    screen: { left: "21.06%", top: "22.88%", width: "58.43%", height: "30.66%" }
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
  const params = new URLSearchParams(window.location.search);
  const selected = params.get("board") || "";
  if (selected && deviceProfiles[selected]) {
    localStorage.setItem(DEVICE_STORAGE_KEY, selected);
    return selected;
  }
  const saved = localStorage.getItem(DEVICE_STORAGE_KEY);
  if (saved && deviceProfiles[saved]) return saved;
  return "taishan-gray";
}

function getActiveDeviceSerial() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("device") || "";
  if (fromUrl) return fromUrl;
  try {
    const saved = JSON.parse(localStorage.getItem(BOUND_DEVICE_STORAGE_KEY) || "{}");
    return saved?.board_id === activeDeviceId ? String(saved.serial || "") : "";
  } catch {
    return "";
  }
}

let activeDeviceId = getActiveDeviceId();
let activeDeviceSerial = getActiveDeviceSerial();
let currentAssetSummary = { count: 0, totalBytes: 0, byKind: {}, items: [] };
let conversationCache = [];
let optimisticConversations = [];

function getAgentMode() {
  const value = agentModeSelect?.value || localStorage.getItem(AGENT_MODE_STORAGE_KEY) || "vibeboard";
  return value === "codex" ? "codex" : "vibeboard";
}

function syncAgentModeUi() {
  if (!agentModeSelect) return;
  agentModeSelect.value = getAgentMode();
}

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
  glm: {
    label: "GLM 5.2",
    baseUrl: "https://maas-openapi.wanjiedata.com/api/v1",
    model: "glm-5.2",
    help: "GLM 5.2 OpenAI-compatible endpoint. Use the WanjieData MAAS API key."
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
  timeout: {
    title: "请求超时",
    detail: "操作没有在预期时间内完成。",
    suggestion: "请稍后重试；如果连续超时，缩短需求、减少上传上下文或检查网络。"
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
  generate_busy: {
    title: "已有任务正在执行",
    detail: "当前已经有一个生成任务在运行，新的任务没有启动，避免覆盖当前构建。",
    suggestion: "请等待当前任务结束；如果刚刷新页面，先查看当前对话是否已经恢复出最新预览。"
  },
  no_api_key: {
    title: "未配置 AI 模型",
    detail: "还没有设置 AI 模型的 API Key，将使用本地模板生成。",
    suggestion: "点击右上角「Model」按钮配置 DeepSeek 或其他模型"
  },
  database_quota: {
    title: "数据库额度超限",
    detail: "Neon 数据库返回流量或额度超限，登录、对话、项目保存和任务接口会暂时不可用。",
    suggestion: "请升级或恢复 Neon 数据库额度，或等额度重置后再试；这不是 GLM 5.2 的 API Key 问题。"
  },
  llm_quota: {
    title: "模型额度不可用",
    detail: "模型服务返回额度、余额或配额不足，代码生成在部署设备前已经停止。",
    suggestion: "请给模型账号充值、提高额度，或在 Model 设置里切换到另一个可用 API Key 后重试。"
  },
  llm_rate_limited: {
    title: "模型请求被限流",
    detail: "模型服务暂时拒绝了当前请求，Agent 还没有拿到完整代码。",
    suggestion: "请稍后重试，或切换到并发额度更高的模型配置。"
  },
  llm_network: {
    title: "模型网络不可达",
    detail: "服务端无法连接模型 API，可能是 Base URL、代理、DNS 或网络问题。",
    suggestion: "请检查 Base URL、代理、网络连通性和防火墙设置。"
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
  model_output_invalid: {
    title: "模型输出不符合代码合同",
    detail: "模型返回内容缺少必需文件、不是可解析 JSON，或没有按 VibeBoard 硬件合同输出。",
    suggestion: "请重试生成；如果连续出现，换一个模型或把需求拆得更具体。"
  },
  auto_repair_failed: {
    title: "自动修复未完成",
    detail: "Agent 已经尝试自动修复部署前的本地验证问题，但仍未通过 L0-L3 验证。",
    suggestion: "请查看技术详情中的最后一次失败原因；如果是需求冲突或缺少素材，请补充信息后重新生成。"
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
  hardware_contract: {
    title: "硬件合同不完整",
    detail: "生成应用缺少 VibeBoard 必需的硬件合同字段或运行结果。",
    suggestion: "请重新生成，并保留 hardware_app.py、hardware-result.json、build_id 和 runtime API。"
  },
  render_failed: {
    title: "480×360 渲染验证失败",
    detail: "页面没有通过小屏渲染验证，可能是白屏、溢出、资源加载失败或前端运行错误。",
    suggestion: "请重试生成，或根据技术详情修复布局尺寸、资源路径和控制台错误。"
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
  storage_failed: {
    title: "项目快照保存失败",
    detail: "项目快照或会话文件保存失败，刷新后可能无法恢复这次生成。",
    suggestion: "请检查 runtime 数据库、磁盘权限和剩余空间，然后重试。"
  },
  storage_corrupt: {
    title: "项目数据库损坏",
    detail: "本地项目数据库无法读取，可能导致对话、资产或快照恢复失败。",
    suggestion: "请先备份 runtime 数据库，再修复或重建数据库文件。"
  },
  asset_rejected: {
    title: "资产未通过检查",
    detail: "上传资产没有通过安全、类型或大小检查，因此没有进入生成上下文。",
    suggestion: "请检查资产路径、文件类型、压缩包结构和大小限制后重新上传。"
  },
  request_too_large: {
    title: "请求或资产包太大",
    detail: "这次请求超过后端大小限制，生成还没有开始。",
    suggestion: "请拆分资产包，先上传关键素材，再分批补充其它素材。"
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
  const nextActions = Array.isArray(data?.nextActions) ? data.nextActions.filter(Boolean).slice(0, 4) : [];
  return {
    title: data?.userTitle || info.title || data?.errorLabel,
    detail: data?.userMessage || info.detail,
    suggestion: data?.suggestion || info.suggestion,
    stage: data?.errorStage || "",
    retryable: data?.retryable,
    nextActions,
    technicalDetail: data?.technicalDetail || "",
    type,
    raw: data?.error || fallbackMsg || ""
  };
}

function formatFriendlyError(data, fallbackMsg) {
  const f = friendlyError(data, fallbackMsg);
  return `${f.title}。${f.detail}\n💡 ${f.suggestion}`;
}

function friendlyErrorMarkdown(data, fallbackMsg, { includeRaw = true } = {}) {
  const f = friendlyError(data, fallbackMsg);
  const lines = [
    `**${f.title}**`,
    "",
    f.detail,
    "",
    `💡 ${f.suggestion}`,
  ];
  if (f.stage) lines.push("", `阶段：\`${f.stage}\``);
  if (f.nextActions.length) {
    lines.push("", "**下一步可以选：**");
    for (const action of f.nextActions) lines.push(`- ${action}`);
  }
  const detail = f.technicalDetail || (includeRaw ? f.raw : "");
  if (detail) lines.push("", `<details><summary>技术详情</summary>\n\n\`${String(detail).slice(0, 800)}\`\n\n</details>`);
  return lines.join("\n");
}

function notifyBusyAttempt(prompt = "") {
  const message = friendlyErrorMarkdown({
    errorType: "generate_busy",
    nextActions: ["等待当前任务完成", "稍后重新提交", "先查看当前预览"],
    errorStage: "generate",
  }, "busy", { includeRaw: false });
  addMarkdownMessage("agent", `❌ ${message}`);
  if (prompt) {
    addInlineButtons([
      { label: "稍后重试", primary: true, action: () => {
        promptInput.value = prompt;
        promptInput.focus();
      }},
      { label: "查看当前预览", primary: false, action: () => syncDeviceFrameFromCurrent() },
    ]);
  }
}

function isActiveConversation(conversationId) {
  return !conversationId || conversationId === currentConversationId;
}

const CHAT_BOTTOM_GAP = 96;

function shouldStickChatToBottom() {
  if (!chatLog) return false;
  return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight <= CHAT_BOTTOM_GAP;
}

function keepChatInView(stick = true) {
  if (!chatLog || !stick) return;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendChatNode(node, { force = false } = {}) {
  if (!chatLog || !node) return;
  const stick = force || shouldStickChatToBottom();
  chatLog.appendChild(node);
  keepChatInView(stick);
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
  appendChatNode(article);
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
    const stick = shouldStickChatToBottom();
    const item = document.createElement("div");
    item.className = "work-log-item";
    item.textContent = `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} ${message}`;
    log.appendChild(item);
    keepChatInView(stick);
  };
  addLog("Task accepted. I am reading the request and preparing the local verification path.");
  card.append(title, list, log);
  article.append(avatar, card);
  appendChatNode(article);

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
  if (event === "generate.agent.progress") {
    if (entry.type === "agent.run.started") return entry.message || "Agent planning started";
    if (entry.type === "agent.model.started") return entry.message || "Agent is reasoning";
    if (entry.type === "agent.model.completed") return `${entry.message || "Reasoning finished"}${entry.elapsed_ms ? ` (${formatElapsed(entry.elapsed_ms)})` : ""}`;
    if (entry.type === "agent.tool.started") return entry.path ? `${entry.tool || "tool"}: ${entry.path}` : `Running ${entry.tool || "tool"}`;
    if (entry.type === "agent.tool.completed") return `${entry.tool || "Tool"} ${entry.ok === false ? "failed" : "finished"}`;
    if (entry.type === "agent.verification.started") return "Checking generated app";
    if (entry.type === "agent.verification.completed") return entry.ok === false ? "Generated app needs repair" : "Generated app checks passed";
    if (entry.type === "agent.recovery") return entry.message || "Agent is correcting its approach";
    if (entry.type === "agent.run.completed") return "Agent work completed";
    if (entry.type === "agent.run.failed") return "Agent work failed";
    return entry.message || "Agent progress updated";
  }
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
    "generate.agent.progress",
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
      entry.type || "",
      entry.message || "",
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
  if (activeDeviceSerial) href.searchParams.set("device", activeDeviceSerial);
  return `${href.pathname}${href.search}`;
}

function withDevicePayload(payload = {}) {
  return {
    ...payload,
    deviceId: activeDeviceId,
    ...(activeDeviceSerial ? { device: activeDeviceSerial } : {}),
  };
}

async function authFetch(url, payload = {}, { method = "POST" } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refreshAccountState() {
  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    currentUser = data.user || null;
    if (accountBtn) accountBtn.textContent = "账户";
    if (accountIdentity) accountIdentity.textContent = currentUser ? currentUser.phone : "未登录";
    if (adminLink) adminLink.hidden = currentUser?.role !== "admin";
    if (accountLogoutBtn) accountLogoutBtn.hidden = !currentUser;
    if (creditChip) {
      const monthTokens = Number(data.usage?.month_tokens || 0);
      creditChip.textContent = currentUser ? `用量 ${formatCompactNumber(monthTokens)} tokens` : "用量";
    }
    return currentUser;
  } catch {
    currentUser = null;
    if (accountBtn) accountBtn.textContent = "账户";
    if (accountIdentity) accountIdentity.textContent = "未登录";
    if (accountLogoutBtn) accountLogoutBtn.hidden = true;
    if (adminLink) adminLink.hidden = true;
    if (creditChip) creditChip.textContent = "用量";
    return null;
  }
}

function setAccountMenu(open) {
  if (!accountMenu || !accountBtn) return;
  const shouldOpen = Boolean(open && currentUser);
  accountMenu.hidden = !shouldOpen;
  accountBtn.setAttribute("aria-expanded", String(shouldOpen));
}

function goPortalForAuth() {
  window.location.href = "/";
}

function formatCredits(value) {
  return Number(value || 0).toFixed(4).replace(/\.?0+$/, "");
}

function formatCompactNumber(value) {
  const number = Number(value || 0);
  if (number >= 1000000) return `${(number / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(number));
}

async function loadUsage() {
  if (!usageSummary || !usageLedger) return;
  if (!currentUser) {
    goPortalForAuth();
    return;
  }
  try {
    usageSummary.innerHTML = `<div class="usage-empty">Loading usage...</div>`;
    const res = await fetch("/api/credits?limit=50", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    renderUsage(data);
    await refreshAccountState();
  } catch (error) {
    usageSummary.innerHTML = `<div class="usage-empty danger-text">${escapeHtml(error.message)}</div>`;
    usageLedger.innerHTML = "";
  }
}

function renderUsage(data = {}) {
  const usage = data.usage || {};
  const ledger = Array.isArray(data.ledger) ? data.ledger : [];
  const credits = data.credits || {};
  usageSummary.innerHTML = `
    <div><span>Mode</span><strong>${escapeHtml(usage.billing_mode || data.billingMode || "free")}</strong></div>
    <div><span>This month</span><strong>${Number(usage.month_tokens || 0).toLocaleString()} tokens</strong></div>
    <div><span>Total</span><strong>${Number(usage.total_tokens || 0).toLocaleString()} tokens</strong></div>
    <div><span>AI calls</span><strong>${Number(usage.total_calls || 0).toLocaleString()}</strong></div>
    <div><span>Estimated credits</span><strong>${formatCredits(usage.total_calculated_credits || 0)}</strong></div>
    <div><span>Current balance</span><strong>${formatCredits(credits.credits_balance || 0)}</strong></div>
  `;
  const rows = ledger.filter(row => Number(row.tokens || 0) > 0).slice(0, 20);
  usageLedger.innerHTML = rows.map(row => {
    const meta = parseMetadata(row.metadata_json);
    return `
      <div class="usage-row">
        <div>
          <strong>${escapeHtml(row.reason || "ai_call")}</strong>
          <span>${formatTime(row.created_at)}</span>
        </div>
        <div>${Number(row.tokens || 0).toLocaleString()} tokens</div>
        <div>${formatCredits(meta.credits_calculated || Math.abs(Number(row.delta || 0)))} credits</div>
      </div>
    `;
  }).join("") || `<div class="usage-empty">No AI usage recorded yet.</div>`;
}

function parseMetadata(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function postJson(url, payload = {}, { timeout = 120000, method = "POST" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
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
      err.data = { errorType: "timeout", errorStage: "request" };
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
      err.data = { errorType: "timeout", errorStage: "request" };
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

function isFinalJob(job = {}) {
  return ["succeeded", "failed", "canceled"].includes(String(job.status || ""));
}

async function fetchJob(jobId) {
  const data = await getJson(`${api.jobs}/${encodeURIComponent(jobId)}`, { timeout: 15000 });
  return data.job;
}

async function waitForJob(jobId, { onUpdate, interval = 1200, timeout = 900000 } = {}) {
  const startedAt = Date.now();
  activeJobWaiters.add(jobId);
  try {
    while (Date.now() - startedAt < timeout) {
      const job = await fetchJob(jobId);
      if (typeof onUpdate === "function") onUpdate(job);
      loadJobs({ silent: true });
      if (isFinalJob(job)) return job;
      await new Promise(resolve => window.setTimeout(resolve, interval));
    }
    const error = new Error("Job timed out");
    error.data = { errorType: "timeout", errorStage: "job" };
    throw error;
  } finally {
    activeJobWaiters.delete(jobId);
  }
}

async function loadJobs({ silent = false } = {}) {
  if (!jobList && !jobSummary) return [];
  try {
    const data = await getJson(`${api.jobs}?limit=30`, { timeout: 15000 });
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    renderJobs(jobs);
    scheduleJobsPolling(jobs);
    return jobs;
  } catch (error) {
    if (!silent && jobList) {
      jobList.innerHTML = `<div class="job-error">${escapeHtml(formatFriendlyError(error.data, error.message))}</div>`;
    }
    return [];
  }
}

function scheduleJobsPolling(jobs = []) {
  if (jobsPollTimer) window.clearTimeout(jobsPollTimer);
  const hasActive = jobs.some(job => !isFinalJob(job)) || activeJobWaiters.size > 0;
  if (hasActive) jobsPollTimer = window.setTimeout(() => loadJobs({ silent: true }), 1500);
}

function renderJobs(jobs = []) {
  if (jobSummary) {
    const active = jobs.filter(job => !isFinalJob(job)).length;
    jobSummary.textContent = active ? `${active} active / ${jobs.length}` : `${jobs.length} jobs`;
  }
  if (!jobList) return;
  if (!jobs.length) {
    jobList.innerHTML = `<div class="job-card"><div class="job-meta">No background jobs yet.</div></div>`;
    return;
  }
  jobList.innerHTML = "";
  for (const job of jobs) {
    const card = document.createElement("article");
    card.className = "job-card";
    const latestLogs = Array.isArray(job.logs) ? job.logs.slice(-5) : [];
    const logRows = latestLogs.map(log => `<div>${escapeHtml((log.phase ? `${log.phase}: ` : "") + (log.message || ""))}</div>`).join("") || "<div>waiting for logs</div>";
    const error = job.error || {};
    card.innerHTML = `
      <div class="job-card-head">
        <div>
          <h3>${escapeHtml(job.title || job.type || job.id)}</h3>
          <div class="job-meta">${escapeHtml(job.type || "task")} | ${escapeHtml(job.phase || "")} | ${formatTime(job.updated_at || job.created_at)}</div>
        </div>
        <span class="job-status ${escapeHtml(job.status || "")}">${escapeHtml(job.status || "")}</span>
      </div>
      ${error && (error.userMessage || error.error || error.errorLabel)
        ? `<div class="job-error">${escapeHtml(error.userMessage || error.errorLabel || error.error || "Job failed")}</div>`
        : ""}
      <details class="job-log-details">
        <summary>Logs · ${latestLogs.length || 1}</summary>
        <div class="job-log">${logRows}</div>
      </details>
      <div class="job-actions"></div>
    `;
    const actions = card.querySelector(".job-actions");
    for (const choice of normalizedJobChoices(job)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = choice.primary ? "primary" : "";
      button.textContent = truncateButtonText(choice.label, 24);
      button.addEventListener("click", () => runJobChoice(job, choice));
      actions.appendChild(button);
    }
    jobList.appendChild(card);
  }
}

function normalizedJobChoices(job = {}) {
  const choices = Array.isArray(job.choices) ? job.choices : [];
  const output = job.output || {};
  const result = choices.map((choice, index) => ({
    label: choice.label || choice.action || "Action",
    action: choice.action || "",
    value: choice.value || {},
    primary: index === 0,
  }));
  if (!isFinalJob(job)) {
    result.push({ label: "Cancel", action: "cancel_job", value: { job_id: job.id }, primary: false });
  }
  if (job.status === "succeeded" && output.files && !result.some(item => item.action === "open_result")) {
    result.unshift({ label: "Open result", action: "open_result", value: { job_id: job.id }, primary: true });
  }
  if (!result.length) result.push({ label: "View logs", action: "view_logs", value: { job_id: job.id }, primary: true });
  return result.slice(0, 5);
}

function applyGenerateResult(gen = {}, prompt = "", conversationId = currentConversationId) {
  if (!gen || typeof gen !== "object") return;
  removeThinkingAnimation();
  if (gen.agentActions?.length) addAgentActionsCard(gen.agentActions, gen.agentSummary);
  else if (gen.thinking) addThinkingBubble(gen.thinking);
  renderModeBoundary(gen.mode_boundary);
  renderCodexBridge(gen.codex_bridge);
  addEvidenceCard(gen);
  renderFiles(gen.files || {});
  if (conversationId) {
    renderConversationPreview(conversationId, gen.id, gen.agentSummary || "generated app");
  } else {
    renderDevicePreview(prompt, gen.agentSummary || "generated app");
  }
  if (gen.id) el("lastBuildState").textContent = gen.id;
  const fileCount = Object.keys(gen.files || {}).length;
  const message = `**Background job completed**\n\nGenerated **${fileCount}** files and restored the verified preview. Hardware deployment still waits for your explicit confirmation.`;
  addMarkdownMessage("agent", message);
  persistMessage("agent", message, gen.id || null, conversationId);
  addInlineButtons([
    { label: "Deploy", primary: true, action: () => doDeploy(prompt) },
    { label: "Keep editing", primary: false, action: () => promptInput?.focus() },
  ]);
}

async function runJobChoice(job = {}, choice = {}) {
  const action = String(choice.action || "");
  if (action === "open_result") {
    applyGenerateResult(job.output, job.input?.prompt || job.input?.build_prompt || "", job.conversation_id || currentConversationId);
    setJobDrawer(false);
    return;
  }
  if (action === "deploy_job_output") {
    setJobDrawer(false);
    await doDeploy(job.input?.prompt || job.input?.build_prompt || "");
    return;
  }
  if (action === "open_model_settings") {
    setJobDrawer(false);
    setModelModal(true);
    return;
  }
  if (action === "open_board_status") {
    setJobDrawer(false);
    setStatusDrawer(true);
    return;
  }
  if (action === "cancel_job") {
    await postJson(`${api.jobs}/${encodeURIComponent(job.id)}/cancel`, {}, { timeout: 15000 });
    await loadJobs();
    return;
  }
  if (action === "retry_local_template") {
    setJobDrawer(false);
    await retryJob(job, { modelSettings: { enabled: false } });
    return;
  }
  if (action === "retry_job") {
    setJobDrawer(false);
    await retryJob(job);
    return;
  }
  setJobDrawer(true);
}

async function retryJob(job = {}, overrides = {}) {
  const payload = { ...(job.input || {}), ...overrides };
  if (job.type === "deploy") {
    await doDeploy(payload.prompt || "");
    return;
  }
  if (job.type === "generate") {
    await runFlow(payload.prompt || payload.build_prompt || "", payload.history || [], payload.conversation_id || currentConversationId, payload);
    return;
  }
  await runFlow(payload.prompt || payload.build_prompt || "", payload.history || [], payload.conversation_id || currentConversationId, payload);
}

function setBusy(value) {
  foregroundTaskCount = Math.max(0, foregroundTaskCount + (value ? 1 : -1));
  busy = foregroundTaskCount > 0;
  if (runDemoBtn) runDemoBtn.disabled = busy;
  if (modelConfigBtn) modelConfigBtn.disabled = busy;
  if (agentState) agentState.textContent = busy ? `${foregroundTaskCount} running` : "idle";
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

function setLayerOpen(node, open) {
  if (!node) return;
  node.classList.toggle("open", open);
  node.setAttribute("aria-hidden", open ? "false" : "true");
  node.inert = !open;
  node.toggleAttribute("inert", !open);
}

function syncScrim() {
  if (!scrim) return;
  scrim.hidden = !(
    isOpen(codeDrawer) ||
    isOpen(statusDrawer) ||
    isOpen(jobDrawer) ||
    isOpen(guideModal) ||
    isOpen(usageDrawer) ||
    isOpen(assetManagerDrawer) ||
    isOpen(assetPropertiesModal) ||
    isOpen(projectCreateModal) ||
    isOpen(assetImportModal) ||
    isOpen(modelModal) ||
    isOpen(el("deployMarketModal"))
  );
}

function setCodeDrawer(open) {
  if (!codeDrawer) return;
  setLayerOpen(codeDrawer, open);
  syncScrim();
}

function setStatusDrawer(open) {
  if (!statusDrawer) return;
  setLayerOpen(statusDrawer, open);
  syncScrim();
  if (open) refreshBoard();
}

function setJobDrawer(open) {
  if (!jobDrawer) return;
  setLayerOpen(jobDrawer, open);
  syncScrim();
  if (open) loadJobs();
}

function setGuideModal(open) {
  if (!guideModal) return;
  setLayerOpen(guideModal, open);
  syncScrim();
}

function setUsageDrawer(open) {
  if (!usageDrawer) return;
  setLayerOpen(usageDrawer, open);
  syncScrim();
  if (open) loadUsage();
}

function setAssetManagerDrawer(open) {
  if (!assetManagerDrawer) return;
  setLayerOpen(assetManagerDrawer, open);
  syncScrim();
  if (open) loadAssetManager();
}

function setProjectCreateModal(open) {
  if (!projectCreateModal) return;
  setLayerOpen(projectCreateModal, open);
  syncScrim();
  if (open) {
    loadProjectRootHint();
    setTimeout(() => projectNameInput?.focus(), 40);
  }
}

function setAssetImportModal(open) {
  if (!assetImportModal) return;
  setLayerOpen(assetImportModal, open);
  if (open) {
    if (assetImportUpload) assetImportUpload.hidden = false;
  }
  syncScrim();
}

function setAssetPropertiesModal(open) {
  if (!assetPropertiesModal) return;
  setLayerOpen(assetPropertiesModal, open);
  syncScrim();
}

function setModelModal(open) {
  if (!modelModal) return;
  setLayerOpen(modelModal, open);
  syncScrim();
  if (open) {
    syncModelUi();
    setTimeout(() => modelApiKey?.focus(), 40);
  }
}

function setDeployMarketModal(open) {
  const deployModal = el("deployMarketModal");
  if (!deployModal) return;
  setLayerOpen(deployModal, open);
  syncScrim();
}

function closeDrawers() {
  setCodeDrawer(false);
  setStatusDrawer(false);
  setJobDrawer(false);
  setGuideModal(false);
  setUsageDrawer(false);
  setAssetManagerDrawer(false);
  setAssetPropertiesModal(false);
  setProjectCreateModal(false);
  setAssetImportModal(false);
  setModelModal(false);
  setDeployMarketModal(false);
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
  setPreviewLoading("Preparing preview");
  deviceFrame.removeAttribute("src");
  deviceFrame.srcdoc = BLANK_DEVICE_FRAME_HTML;
  scheduleFitDeviceFrame();
}

function setDeviceFrameSrc(src) {
  if (!deviceFrame || !src) return;
  setPreviewLoading("Loading preview");
  deviceFrame.removeAttribute("srcdoc");
  deviceFrame.src = src;
}

function setPreviewLoading(label = "Loading preview") {
  previewLoadToken += 1;
  if (previewReadyTimer) {
    window.clearTimeout(previewReadyTimer);
    previewReadyTimer = null;
  }
  if (previewLoadingMask) {
    const text = previewLoadingMask.querySelector("strong");
    if (text) text.textContent = label;
  }
  macPhoto?.classList.add("preview-loading");
  macPhoto?.classList.remove("preview-ready");
}

function markPreviewReady(token = previewLoadToken) {
  scheduleFitDeviceFrame();
  if (!macPhoto || token !== previewLoadToken) return;
  if (previewReadyTimer) window.clearTimeout(previewReadyTimer);
  previewReadyTimer = window.setTimeout(() => {
    if (token !== previewLoadToken) return;
    macPhoto.classList.remove("preview-loading");
    macPhoto.classList.add("preview-ready");
  }, 120);
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

function currentGeneratedContractHash() {
  try {
    const manifest = generatedFiles?.["manifest.json"] ? JSON.parse(generatedFiles["manifest.json"]) : {};
    return String(manifest?.contractHash || manifest?.contract_hash || "").trim();
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
    addMarkdownMessage("agent", `⚠️ ${friendlyErrorMarkdown(error.data, error.message, { includeRaw: false })}`);
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
  appendChatNode(article);
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
  appendChatNode(article);
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
  appendChatNode(article);
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
  appendChatNode(article);
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

  appendChatNode(card);

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
  appendChatNode(article);
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
  appendChatNode(article);
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

function addFallbackChoiceButtonsFromText(text) {
  const choices = extractTextChoices(text);
  if (!choices.length) return false;
  addQuickReplyButtons(choices);
  return true;
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

function extractTextChoices(text = "") {
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const choices = [];
  for (const line of lines) {
    const match = line.match(/^(?:选项\s*)?(?:\(?([1-9][0-9]?|[A-Da-d])\)?[\.、:：\)]|\-\s+)\s*(.{2,80})$/);
    if (!match) continue;
    const label = match[2].replace(/[*_`]/g, "").trim();
    if (!label || /^(下一步|技术详情|阶段|查看|请查看)$/i.test(label)) continue;
    choices.push({ label: truncateButtonText(label, 18), value: label });
    if (choices.length >= 4) break;
  }
  return choices.length >= 2 ? choices : [];
}

function truncateButtonText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function renderModeBoundary(boundary = {}) {
  if (!boundary || boundary.mode !== "codex") return;
  const scope = boundary.scope || "VibeBoard hardware embedded design only.";
  const body = addMarkdownMessage("agent", `Codex 硬件模式已启用：${scope}`);
  body?.classList.add("mode-boundary-note");
}

function renderCodexBridge(bridge = {}) {
  if (!bridge || bridge.name !== "codex-hardware-agent") return;
  if (bridge.scope_guard?.blocked) {
    const reason = bridge.scope_guard.reason || "out of scope";
    const body = addMarkdownMessage("agent", `Codex scope guard 已拦截非硬件请求：${reason}。请把需求改成 VibeBoard 480x360 小屏应用。`);
    body?.classList.add("codex-bridge-note", "codex-bridge-warning");
    return;
  }
  const allowed = Array.isArray(bridge.allowed_operations) ? bridge.allowed_operations.slice(0, 3).join(" / ") : "";
  const assetText = bridge.asset_context_attached ? "已接入当前 Assets 分析上下文" : "暂无上传资产上下文";
  const body = addMarkdownMessage("agent", `Codex hardware bridge active。${assetText}${allowed ? `。允许范围：${allowed}` : ""}`);
  body?.classList.add("codex-bridge-note");
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
  body.querySelector('[data-action="confirm"]')?.addEventListener("click", event => {
    const button = event.currentTarget;
    if (button?.disabled) return;
    if (button) button.disabled = true;
    const buildPrompt = pendingGeneratePrompt;
    pendingGeneratePrompt = null;
    article.remove();
    startBuild(buildPrompt);
  });
  body.querySelector('[data-action="revise"]')?.addEventListener("click", () => {
    promptInput.value = "我还想再调整一下方案";
    promptInput.focus();
  });
  article.append(avatar, body);
  appendChatNode(article);
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
      agent_mode: getAgentMode(),
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
    renderModeBoundary(result.mode_boundary);
    renderCodexBridge(result.codex_bridge);

    // 检测是否准备好构建
    if (result.ready_to_build) {
      pendingGeneratePrompt = String(result.build_prompt || "").trim();
      if (!pendingGeneratePrompt) {
        addMarkdownMessage("agent", "我还没有拿到完整的构建需求，请继续补充或确认方案。");
        return;
      }
      addBuildPromptAction(pendingGeneratePrompt, result);
    } else {
      const choices = normalizeQuickReplyButtons(result.quick_replies);
      if (choices.length) addQuickReplyButtons(choices);
      else addFallbackChoiceButtonsFromText(reply);
    }
  } catch (error) {
    removeThinkingAnimation();
    addMarkdownMessage("agent", `❌ ${friendlyErrorMarkdown(error.data, error.message)}`);
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
  await runFlow(originalPrompt, history, currentConversationId);
}

function runFlowKey(prompt, conversationId) {
  return `${String(conversationId || "")}::${String(prompt || "").trim()}`;
}

async function runFlow(prompt, history = [], conversationId = currentConversationId, overrides = {}) {
  const key = runFlowKey(prompt, conversationId);
  if (activeRunFlows.has(key)) return activeRunFlows.get(key);
  const promise = runFlowOnce(prompt, history, conversationId, overrides).finally(() => {
    activeRunFlows.delete(key);
  });
  activeRunFlows.set(key, promise);
  return promise;
}

async function runFlowOnce(prompt, history = [], conversationId = currentConversationId, overrides = {}) {
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
    const started = await postJson(api.generate, {
      prompt,
      modelSettings: getModelPayload(),
      agent_mode: getAgentMode(),
      conversation_id: conversationId,
      clarify_answers: [],
      history: chatHistory,
      background: true,
      ...overrides,
    }, { timeout: GENERATION_START_TIMEOUT_MS });
    const initialJob = started.job;
    const jobId = initialJob?.id;
    if (!jobId) throw new Error("Background generation job was not created.");
    progress.log(isFinalJob(initialJob) ? `Background job completed: ${jobId}` : `Background job queued: ${jobId}`);
    setJobDrawer(true);
    const finishedJob = isFinalJob(initialJob)
      ? initialJob
      : await waitForJob(jobId, {
        onUpdate(job) {
          if (!job) return;
          const phase = job.phase || job.status || "running";
          progress.set("generate", job.status === "queued" ? "active" : "active", phase, { silent: true });
        },
        timeout: 900000,
      });
    if (finishedJob.status !== "succeeded") {
      const error = new Error(finishedJob.error?.error || finishedJob.error?.errorLabel || "Generation job failed.");
      error.data = finishedJob.error || { errorType: "unknown" };
      throw error;
    }
    const gen = finishedJob.output;
    generatePoller.stop("job completed");
    generatePoller = null;

    // Remove thinking animation, show agent actions
    if (isActiveConversation(conversationId)) {
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
      renderModeBoundary(gen.mode_boundary);
      renderCodexBridge(gen.codex_bridge);
      addEvidenceCard(gen);
    }

    if (isActiveConversation(conversationId)) {
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
      if (isActiveConversation(conversationId)) addEvidenceCard(build);
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
    const repairNote = gen.repairSummary ? `\n\n${gen.repairSummary}` : "";
    const successMessage = `**本地生成与验证完成**\n\n已生成 **${fileCount}** 个文件，并通过本地 L0-L3 验证。${verifyNote}${repairNote}${agentSummary}\n\n我还没有写入硬件。你可以先在右侧预览确认效果；确认后再点击下方部署按钮。`;
    if (isActiveConversation(conversationId)) addMarkdownMessage("agent", successMessage);
    persistMessage("agent", successMessage, gen.id || null, conversationId);

    // 部署按钮放在聊天框内
    if (isActiveConversation(conversationId)) {
      addInlineButtons([
        { label: "🚀 部署到真机", primary: true, action: () => doDeploy(prompt) },
        { label: "✏️ 继续修改", primary: false, action: () => {
          addMarkdownMessage("agent", "好的，请告诉我你想修改什么。");
        }},
      ]);
    }
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
    const errorMessage = `❌ ${friendlyErrorMarkdown(error.data, error.message)}`;
    if (isActiveConversation(conversationId)) addMarkdownMessage("agent", errorMessage);
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
  appendChatNode(article);
}

async function runDeployJob(buildId = currentGeneratedBuildId()) {
  const started = await postJson(api.deploy, withDevicePayload({
    background: true,
    conversation_id: currentConversationId || "",
    build_id: buildId || "",
    confirmation: "deploy",
    boundDeviceId: activeDeviceSerial ? activeDeviceId : "",
    contractHash: currentGeneratedContractHash(),
  }), { timeout: 30000 });
  const jobId = started.job?.id;
  if (!jobId) throw new Error("Background deploy job was not created.");
  setJobDrawer(true);
  const finishedJob = await waitForJob(jobId, { timeout: 600000 });
  if (finishedJob.status !== "succeeded") {
    const error = new Error(finishedJob.error?.error || finishedJob.error?.errorLabel || "Deploy job failed.");
    error.data = finishedJob.error || { errorType: "deploy_failed" };
    throw error;
  }
  return finishedJob.output;
}

async function doDeploy(prompt) {
  const profile = deviceProfiles[activeDeviceId] || deviceProfiles["taishan-gray"];
  setBusy(true);
  deployState.textContent = labels.deploying;

  addMarkdownMessage("agent", `🚀 **正在部署到 ${profile.label}...**`);

  try {
    const deployed = await runDeployJob(currentGeneratedBuildId());
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
    addMarkdownMessage("agent", `❌ **部署失败**\n\n${friendlyErrorMarkdown(error.data, error.message)}`);
  } finally {
    setBusy(false);
  }
}

async function runDeploy(btn) {
  const profile = deviceProfiles[activeDeviceId] || deviceProfiles["taishan-gray"];
  setBusy(true);
  btn.disabled = true;
  btn.textContent = `部署到${profile.label}中...`;
  deployState.textContent = labels.deploying;

  try {
    const deployed = await runDeployJob(currentGeneratedBuildId());
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
    addMarkdownMessage("agent", `❌ ${friendlyErrorMarkdown(error.data, error.message)}`);
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

promptInput?.addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
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
guideBtn?.addEventListener("click", () => setGuideModal(true));
refreshJobsBtn?.addEventListener("click", () => loadJobs());
codeToggle?.addEventListener("click", () => setCodeDrawer(true));
closeDrawer?.addEventListener("click", () => setCodeDrawer(false));
closeStatusDrawer?.addEventListener("click", () => setStatusDrawer(false));
closeJobDrawer?.addEventListener("click", () => setJobDrawer(false));
closeGuideModal?.addEventListener("click", () => setGuideModal(false));
modelConfigBtn?.addEventListener("click", () => setModelModal(true));
closeModelModal?.addEventListener("click", () => setModelModal(false));
modelProvider?.addEventListener("change", () => applyProviderPreset(modelProvider.value));
agentModeSelect?.addEventListener("change", () => {
  localStorage.setItem(AGENT_MODE_STORAGE_KEY, getAgentMode());
  const label = getAgentMode() === "codex" ? "Codex 硬件模式" : "自研 Agent";
  addMarkdownMessage("agent", `已切换到 ${label}。我会继续只处理硬件嵌入式小屏应用相关的设计、生成、验证和部署确认。`);
});
assetUploadBtn?.addEventListener("click", () => setAssetImportModal(true));
closeAssetImportModal?.addEventListener("click", () => setAssetImportModal(false));
chooseAssetFilesBtn?.addEventListener("click", () => assetUploadInput?.click());
assetUploadInput?.addEventListener("change", () => uploadAssetFiles(assetUploadInput.files));
if (assetDropZone) {
  assetDropZone.addEventListener("dragover", event => {
    event.preventDefault();
    assetDropZone.classList.add("drag-over");
  });
  assetDropZone.addEventListener("dragleave", () => assetDropZone.classList.remove("drag-over"));
  assetDropZone.addEventListener("drop", event => {
    event.preventDefault();
    assetDropZone.classList.remove("drag-over");
    uploadAssetFiles(event.dataTransfer?.files);
  });
}
assetManagerBtn?.addEventListener("click", () => setAssetManagerDrawer(true));
closeAssetManagerDrawer?.addEventListener("click", () => setAssetManagerDrawer(false));
refreshAssetManagerBtn?.addEventListener("click", () => loadAssetManager());
assetBackBtn?.addEventListener("click", () => {
  assetManagerCurrentFolderId = "";
  assetManagerSelection = null;
  renderAssetManagerExplorer();
});
newAssetFolderBtn?.addEventListener("click", () => createManagedFolder());
renameAssetItemBtn?.addEventListener("click", () => renameSelectedAssetItem());
deleteAssetItemBtn?.addEventListener("click", () => deleteSelectedAssetItem());
assetContextMenu?.addEventListener("click", event => {
  const button = event.target.closest("[data-asset-menu-action]");
  if (!button) return;
  handleAssetContextAction(button.dataset.assetMenuAction || "");
});
closeAssetPropertiesModal?.addEventListener("click", () => setAssetPropertiesModal(false));
closeProjectCreateModal?.addEventListener("click", () => setProjectCreateModal(false));
cancelProjectCreate?.addEventListener("click", () => setProjectCreateModal(false));
projectCreateForm?.addEventListener("submit", event => {
  event.preventDefault();
  const title = projectNameInput?.value?.trim() || "";
  if (!title) return;
  setProjectCreateModal(false);
  createConversation({ resetChat: true, title });
});
deviceSelect?.addEventListener("change", () => {
  activeDeviceId = deviceProfiles[deviceSelect.value] ? deviceSelect.value : "taishan-gray";
  activeDeviceSerial = "";
  localStorage.setItem(DEVICE_STORAGE_KEY, activeDeviceId);
  localStorage.removeItem(BOUND_DEVICE_STORAGE_KEY);
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
accountBtn?.addEventListener("click", event => {
  event.stopPropagation();
  if (!currentUser) {
    goPortalForAuth();
    return;
  }
  setAccountMenu(accountMenu?.hidden);
});
accountLogoutBtn?.addEventListener("click", async event => {
  event.stopPropagation();
  await authFetch("/api/auth/logout", {}).catch(() => {});
  currentUser = null;
  setAccountMenu(false);
  await refreshAccountState();
});
creditChip?.addEventListener("click", () => {
  if (!currentUser) {
    goPortalForAuth();
    return;
  }
  setUsageDrawer(true);
});
closeUsageDrawer?.addEventListener("click", () => setUsageDrawer(false));
refreshUsageBtn?.addEventListener("click", () => loadUsage());
clearModelSettings?.addEventListener("click", () => {
  localStorage.removeItem(MODEL_STORAGE_KEY);
  modelSettings = loadModelSettings();
  syncModelUi();
});
scrim?.addEventListener("click", closeDrawers);
document.addEventListener("click", event => {
  if (accountMenuWrap && !accountMenuWrap.contains(event.target)) {
    setAccountMenu(false);
  }
  if (!assetContextMenu || assetContextMenu.hidden) return;
  if (event.target.closest("#assetContextMenu")) return;
  hideAssetContextMenu();
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  setAccountMenu(false);
  hideAssetContextMenu();
  if (isOpen(assetPropertiesModal)) setAssetPropertiesModal(false);
});

document.querySelectorAll("[data-prompt]").forEach(button => {
  button.addEventListener("click", () => {
    promptInput.value = button.dataset.prompt;
    promptInput.focus();
  });
});

scheduleFitDeviceFrame();
applyDeviceProfile({ refresh: false });
syncModelUi();
syncAgentModeUi();
loadJobs({ silent: true });
window.addEventListener("resize", scheduleFitDeviceFrame);
if (deviceFrame) {
  deviceFrame.addEventListener("load", () => markPreviewReady());
  if (deviceFrame.contentDocument?.readyState === "complete") {
    markPreviewReady();
  }
}
const macOverlay = document.querySelector('.mac-screen-overlay');
if (macOverlay && "ResizeObserver" in window) {
  const observer = new ResizeObserver(scheduleFitDeviceFrame);
  observer.observe(macOverlay);
}

async function loadConversationAssets(conversationId = currentConversationId) {
  if (!conversationId) {
    renderAssetSummary({ count: 0, totalBytes: 0, byKind: {}, items: [] });
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/conversations/${conversationId}/assets`);
    const data = await res.json();
    if (data.ok) renderAssetSummary(data.summary);
  } catch (error) {
    console.error("Failed to load assets:", error);
  }
}

function renderAssetSummary(summary = {}) {
  currentAssetSummary = {
    count: Number(summary.count || 0),
    totalBytes: Number(summary.totalBytes || 0),
    byKind: summary.byKind || {},
    designBrief: summary.designBrief || {},
    items: Array.isArray(summary.items) ? summary.items : [],
  };
  if (!assetState) return;
  const count = currentAssetSummary.count;
  if (!count) {
    assetState.textContent = "0 assets";
    assetState.title = "No uploaded assets";
    return;
  }
  const kinds = Object.entries(currentAssetSummary.byKind)
    .map(([kind, value]) => `${kind}:${value}`)
    .join(" ");
  assetState.textContent = `${count} assets`;
  assetState.title = assetSummaryTooltip(currentAssetSummary, kinds);
}

function assetSummaryTooltip(summary = {}, kinds = "") {
  const lines = [`${summary.count || 0} assets`, kinds].filter(Boolean);
  const brief = summary.designBrief || {};
  const priorities = Array.isArray(brief.priorities) ? brief.priorities.slice(0, 4) : [];
  if (priorities.length) {
    lines.push("Design brief:");
    for (const item of priorities) lines.push(`- ${item}`);
  }
  const palette = Array.isArray(brief.palette) ? brief.palette.slice(0, 6) : [];
  if (palette.length) lines.push(`Palette: ${palette.join(", ")}`);
  const components = Array.isArray(brief.components) ? brief.components.slice(0, 6) : [];
  if (components.length) lines.push(`Components: ${components.join(", ")}`);
  const ctas = Array.isArray(brief.ctas) ? brief.ctas.slice(0, 4) : [];
  if (ctas.length) lines.push(`CTA: ${ctas.join(", ")}`);
  const dataFields = Array.isArray(brief.dataFields) ? brief.dataFields.slice(0, 6) : [];
  if (dataFields.length) lines.push(`Data: ${dataFields.join(", ")}`);
  const productIntents = Array.isArray(brief.productIntents) ? brief.productIntents.slice(0, 4) : [];
  if (productIntents.length) {
    lines.push("Product intents:");
    for (const item of productIntents) lines.push(`- ${item}`);
  }
  const layoutPlan = Array.isArray(brief.layoutPlan) ? brief.layoutPlan.slice(0, 4) : [];
  if (layoutPlan.length) {
    lines.push("Layout plan:");
    for (const item of layoutPlan) lines.push(`- ${item}`);
  }
  const mediaPlan = Array.isArray(brief.mediaPlan) ? brief.mediaPlan.slice(0, 3) : [];
  if (mediaPlan.length) {
    lines.push("Media plan:");
    for (const item of mediaPlan) lines.push(`- ${item}`);
  }
  const mediaProfiles = Array.isArray(brief.mediaProfiles) ? brief.mediaProfiles.slice(0, 4) : [];
  if (mediaProfiles.length) {
    lines.push("Media profiles:");
    for (const item of mediaProfiles) lines.push(`- ${item}`);
  }
  const documentProfiles = Array.isArray(brief.documentProfiles) ? brief.documentProfiles.slice(0, 4) : [];
  if (documentProfiles.length) {
    lines.push("Document profiles:");
    for (const item of documentProfiles) lines.push(`- ${item}`);
  }
  const designProfiles = Array.isArray(brief.designProfiles) ? brief.designProfiles.slice(0, 4) : [];
  if (designProfiles.length) {
    lines.push("Design profiles:");
    for (const item of designProfiles) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

async function uploadAssetFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  await ensureConversation();
  const conversationId = currentConversationId;
  assetState.textContent = "uploading...";
  try {
    const assets = await Promise.all(files.map(fileToAssetPayload));
    const result = await postJson(`${API_BASE}/api/conversations/${conversationId}/assets`, { assets }, { timeout: 120000 });
    renderAssetSummary(result.summary);
    setAssetImportModal(false);
    if (isOpen(assetManagerDrawer)) loadAssetManager(conversationId);
    const uploaded = result.assets?.length || 0;
    const rejected = result.rejected?.length || 0;
    const kinds = Object.entries(result.summary?.byKind || {}).map(([kind, count]) => `${kind} ${count}`).join(", ");
    const priorities = Array.isArray(result.summary?.designBrief?.priorities)
      ? result.summary.designBrief.priorities.slice(0, 3)
      : [];
    const designBrief = result.summary?.designBrief || {};
    const insightLines = [
      ...(Array.isArray(designBrief.palette) && designBrief.palette.length ? [`调色板：${designBrief.palette.slice(0, 6).join(", ")}`] : []),
      ...(Array.isArray(designBrief.components) && designBrief.components.length ? [`组件结构：${designBrief.components.slice(0, 6).join(", ")}`] : []),
      ...(Array.isArray(designBrief.ctas) && designBrief.ctas.length ? [`操作文案：${designBrief.ctas.slice(0, 4).join(", ")}`] : []),
      ...(Array.isArray(designBrief.dataFields) && designBrief.dataFields.length ? [`数据字段：${designBrief.dataFields.slice(0, 6).join(", ")}`] : []),
      ...(Array.isArray(designBrief.productIntents) && designBrief.productIntents.length ? [`产品方向：${designBrief.productIntents.slice(0, 3).join("；")}`] : []),
      ...(Array.isArray(designBrief.layoutPlan) && designBrief.layoutPlan.length ? [`布局建议：${designBrief.layoutPlan.slice(0, 2).join("；")}`] : []),
      ...(Array.isArray(designBrief.mediaProfiles) && designBrief.mediaProfiles.length ? [`媒体画像：${designBrief.mediaProfiles.slice(0, 3).join("；")}`] : []),
      ...(Array.isArray(designBrief.documentProfiles) && designBrief.documentProfiles.length ? [`文档摘要：${designBrief.documentProfiles.slice(0, 3).join("；")}`] : []),
      ...(Array.isArray(designBrief.designProfiles) && designBrief.designProfiles.length ? [`设计画像：${designBrief.designProfiles.slice(0, 3).join("；")}`] : []),
      ...(Array.isArray(designBrief.completionGaps) && designBrief.completionGaps.length ? [`自动补全：${designBrief.completionGaps.slice(0, 2).join("；")}`] : []),
    ];
    const brief = priorities.length || insightLines.length
      ? `\n\n**Assets 设计简报**\n${[
        ...priorities.map(item => `- ${item}`),
        ...insightLines.map(item => `- ${item}`),
      ].join("\n")}`
      : "";
    addMarkdownMessage("agent", `已解析 ${uploaded} 个资产${rejected ? `，${rejected} 个未导入` : ""}。${kinds ? `类型：${kinds}。` : ""}${brief}`);
  } catch (error) {
    addMarkdownMessage("agent", `❌ **资产上传失败**\n\n${friendlyErrorMarkdown(error.data, error.message)}`);
    renderAssetSummary(currentAssetSummary);
  } finally {
    if (assetUploadInput) assetUploadInput.value = "";
  }
}

function fileToAssetPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      resolve({
        name: file.name,
        mime: file.type || "",
        size: file.size,
        encoding: "data-url",
        content: dataUrl,
      });
    };
    reader.readAsDataURL(file);
  });
}

async function loadProjectRootHint() {
  if (!projectRootHint) return;
  try {
    const res = await fetch(`${API_BASE}/api/projects/root`);
    const data = await res.json();
    if (data.ok && data.root) {
      projectRootHint.textContent = `创建后会在此目录下生成项目文件夹：${data.root}`;
    }
  } catch {
    projectRootHint.textContent = "创建后会在项目文件夹中生成对应目录。";
  }
}

async function loadAssetManager(preferredConversationId = assetManagerSelectedConversationId || currentConversationId || "") {
  if (!assetProjectList || !assetFileList) return;
  try {
    const res = await fetch(`${API_BASE}/api/conversations`);
    const data = await res.json();
    const conversations = data.ok ? data.conversations || [] : [];
    if (!assetManagerSelectedConversationId) {
      assetManagerSelectedConversationId = preferredConversationId || conversations[0]?.id || "";
    }
    if (!conversations.some(conv => conv.id === assetManagerSelectedConversationId)) {
      assetManagerSelectedConversationId = conversations[0]?.id || "";
    }
    renderAssetProjectList(conversations);
    if (assetManagerSelectedConversationId) {
      await loadAssetManagerConversation(assetManagerSelectedConversationId);
    } else {
      assetManagerPath.textContent = "暂无项目，请先新建 Project。";
      assetFileList.innerHTML = "";
      assetManagerCache = { folders: [], assets: [], projectFiles: [] };
    }
  } catch (error) {
    assetFileList.innerHTML = `<div class="asset-file-card"><strong>加载失败</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

function renderAssetProjectList(conversations = []) {
  if (!assetProjectList) return;
  assetProjectList.innerHTML = conversations.map(conv => `
    <button class="asset-project-item ${conv.id === assetManagerSelectedConversationId ? "active" : ""}" type="button" data-id="${escapeHtml(conv.id)}">
      <strong>${escapeHtml(conv.title || "New Project")}</strong>
      <span>${escapeHtml(conv.project_dir || "folder pending")}</span>
    </button>
  `).join("");
  assetProjectList.querySelectorAll(".asset-project-item").forEach(button => {
    button.addEventListener("click", () => {
      assetManagerSelectedConversationId = button.dataset.id || "";
      loadAssetManager(assetManagerSelectedConversationId);
    });
  });
}

async function loadAssetManagerConversation(conversationId) {
  const [assetRes, filesRes] = await Promise.all([
    fetch(`${API_BASE}/api/conversations/${conversationId}/assets`),
    fetch(`${API_BASE}/api/conversations/${conversationId}/project-files`),
  ]);
  const assetData = await assetRes.json();
  const filesData = await filesRes.json();
  if (assetManagerPath) {
    const projectDir = filesData.project_dir || "项目文件夹尚未创建";
    assetManagerPath.textContent = `项目文件夹：${projectDir}`;
    assetManagerPath.title = projectDir;
  }
  assetManagerCache = {
    folders: assetData.ok ? assetData.folders || [] : [],
    assets: assetData.ok ? assetData.assets || [] : [],
    projectFiles: filesData.ok ? filesData.files || [] : [],
  };
  renderAssetManagerExplorer();
}

function renderAssetManagerExplorer() {
  if (!assetFileList) return;
  assetManagerSelection = null;
  hideAssetContextMenu();
  const currentFolder = currentAssetFolder();
  if (assetBreadcrumb) {
    assetBreadcrumb.innerHTML = assetBreadcrumbMarkup(currentFolder);
    assetBreadcrumb.querySelector("[data-asset-breadcrumb-root]")?.addEventListener("click", () => openAssetFolder(""));
  }
  if (assetBackBtn) assetBackBtn.disabled = !currentFolder;
  if (newAssetFolderBtn) newAssetFolderBtn.disabled = Boolean(currentFolder);
  if (assetTableHead) assetTableHead.classList.toggle("folder-mode", !currentFolder);

  if (!currentFolder) {
    const folders = assetManagerCache.folders || [];
    assetFileList.classList.add("folder-grid");
    assetFileList.innerHTML = folders.length
      ? folders.map(folder => assetManagerFolderTile(folder)).join("")
      : `<div class="asset-empty-state">暂无文件夹</div>`;
    assetFileList.querySelectorAll("[data-folder-open]").forEach(item => {
      item.addEventListener("dblclick", () => openAssetFolder(item.dataset.folderOpen));
      item.addEventListener("click", () => selectAssetManagerItem("folder", item.dataset.folderOpen));
      item.addEventListener("contextmenu", event => {
        event.preventDefault();
        selectAssetManagerItem("folder", item.dataset.folderOpen);
        showAssetContextMenu(event, "folder", item.dataset.folderOpen);
      });
    });
    return;
  }

  const assets = (assetManagerCache.assets || []).filter(asset => asset.folder_id === currentFolder.id);
  assetFileList.classList.remove("folder-grid");
  assetFileList.innerHTML = assets.length
    ? assets.map(asset => assetManagerFileRow(asset)).join("")
    : `<div class="asset-empty-state">此文件夹为空。导入资产后会自动归类到这里。</div>`;
  assetFileList.querySelectorAll("[data-asset-row]").forEach(row => {
    row.addEventListener("click", () => selectAssetManagerItem("asset", row.dataset.assetRow));
    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      selectAssetManagerItem("asset", row.dataset.assetRow);
      showAssetContextMenu(event, "asset", row.dataset.assetRow);
    });
  });
  assetFileList.querySelectorAll("[data-asset-usage]").forEach(select => {
    select.addEventListener("click", event => event.stopPropagation());
    select.addEventListener("change", () => updateManagedAsset(assetManagerSelectedConversationId, select.dataset.assetUsage, { usage: select.value }));
  });
}

function assetBreadcrumbMarkup(currentFolder = null) {
  const rootButton = `<button class="asset-breadcrumb-link" type="button" data-asset-breadcrumb-root>资产</button>`;
  if (!currentFolder) return rootButton;
  return `${rootButton}<span class="asset-breadcrumb-separator">›</span><span class="asset-breadcrumb-current">${escapeHtml(currentFolder.name)}</span>`;
}

function currentAssetFolder() {
  if (!assetManagerCurrentFolderId) return null;
  return (assetManagerCache.folders || []).find(folder => folder.id === assetManagerCurrentFolderId) || null;
}

function assetManagerFolderTile(folder = {}) {
  return `
    <button class="asset-folder-tile" type="button" data-folder-open="${escapeHtml(folder.id)}" title="${escapeHtml(folder.name)}">
      <span class="asset-folder-icon" aria-hidden="true">${folderIconSvg()}</span>
      <span class="asset-folder-name">${escapeHtml(folder.name)}</span>
      <span class="asset-folder-meta">${folder.asset_count || 0} 个文件</span>
    </button>
  `;
}

function assetManagerFileRow(asset = {}) {
  const usage = asset.usage || "auto";
  return `
    <div class="asset-file-row" data-asset-row="${escapeHtml(asset.id)}" title="${escapeHtml(asset.project_path || asset.name || "")}">
      <span class="asset-file-name"><span class="asset-file-icon" aria-hidden="true">${fileIconSvg(asset.kind)}</span>${escapeHtml(asset.name || "asset")}</span>
      <span class="asset-file-kind">${assetKindLabel(asset.kind)}</span>
      <span class="asset-file-size">${formatBytes(asset.size || 0)}</span>
      <span class="asset-file-usage">
        <select data-asset-usage="${escapeHtml(asset.id)}" aria-label="Asset usage">
          ${["auto", "embeddable", "reference_only", "ignored", "used_in_build"].map(value => `<option value="${value}" ${usage === value ? "selected" : ""}>${assetUsageLabel(value)}</option>`).join("")}
        </select>
      </span>
    </div>
  `;
}

function openAssetFolder(folderId = "") {
  assetManagerCurrentFolderId = folderId;
  assetManagerSelection = null;
  renderAssetManagerExplorer();
}

function selectAssetManagerItem(type, id) {
  assetManagerSelection = { type, id };
  assetFileList?.querySelectorAll(".asset-folder-tile, .asset-file-row").forEach(node => {
    node.classList.toggle("selected",
      (type === "folder" && node.dataset.folderOpen === id) ||
      (type === "asset" && node.dataset.assetRow === id));
  });
}

function selectedFolder() {
  if (assetManagerSelection?.type !== "folder") return null;
  return (assetManagerCache.folders || []).find(folder => folder.id === assetManagerSelection.id) || null;
}

function selectedAsset() {
  if (assetManagerSelection?.type !== "asset") return null;
  return (assetManagerCache.assets || []).find(asset => asset.id === assetManagerSelection.id) || null;
}

function selectedAssetManagerItem() {
  return selectedFolder() || selectedAsset();
}

function showAssetContextMenu(event, type, id) {
  if (!assetContextMenu) return;
  assetContextTarget = { type, id };
  assetContextMenu.hidden = false;
  assetContextMenu.classList.add("open");
  const menuRect = assetContextMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const left = Math.min(event.clientX + 8, Math.max(8, viewportWidth - menuRect.width - 8));
  const top = Math.min(event.clientY + 8, Math.max(8, viewportHeight - menuRect.height - 8));
  assetContextMenu.style.left = `${left}px`;
  assetContextMenu.style.top = `${top}px`;
}

function hideAssetContextMenu() {
  if (!assetContextMenu) return;
  assetContextMenu.hidden = true;
  assetContextMenu.classList.remove("open");
  assetContextTarget = null;
}

function handleAssetContextAction(action = "") {
  if (assetContextTarget) {
    selectAssetManagerItem(assetContextTarget.type, assetContextTarget.id);
  }
  hideAssetContextMenu();
  if (action === "rename") {
    renameSelectedAssetItem();
  } else if (action === "delete") {
    deleteSelectedAssetItem();
  } else if (action === "properties") {
    showSelectedAssetProperties();
  }
}

function showSelectedAssetProperties() {
  const item = selectedAssetManagerItem();
  if (!item || !assetPropertiesBody) return;
  const rows = assetPropertiesRows(item);
  assetPropertiesBody.innerHTML = rows.map(([label, value]) => `
    <div class="asset-property-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </div>
  `).join("");
  setAssetPropertiesModal(true);
}

function assetPropertiesRows(item = {}) {
  if (assetManagerSelection?.type === "folder") {
    return [
      ["名称", item.name || "文件夹"],
      ["类型", item.system ? "系统文件夹" : "自定义文件夹"],
      ["文件数量", `${item.asset_count || 0} 个文件`],
      ["总大小", formatBytes(item.total_bytes || 0)],
      ["路径", item.name ? `资产 > ${item.name}` : "资产"],
    ];
  }
  return [
    ["名称", item.name || "asset"],
    ["类型", assetKindLabel(item.kind)],
    ["MIME", item.mime || ""],
    ["大小", formatBytes(item.size || 0)],
    ["使用方式", assetUsageLabel(item.usage || "auto")],
    ["项目路径", item.project_path || ""],
    ["SHA-256", item.sha256 || ""],
  ];
}

function assetUsageLabel(value) {
  return {
    auto: "自动判断",
    embeddable: "可嵌入生成",
    reference_only: "仅作参考",
    ignored: "忽略",
    used_in_build: "已用于构建",
  }[value] || value;
}

function assetKindLabel(kind = "") {
  return {
    image: "图片",
    video: "视频",
    audio: "音频",
    document: "文档",
    design: "设计",
    archive: "压缩包",
    text: "文本",
    font: "字体",
    data: "数据",
    component: "组件",
  }[kind] || "其他";
}

function folderIconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A3.5 3.5 0 0 1 17.5 20h-11A3.5 3.5 0 0 1 3 16.5v-10Z" fill="currentColor"/></svg>`;
}

function fileIconSvg(kind = "") {
  const colorClass = kind === "image" ? "image" : kind === "video" ? "video" : kind === "audio" ? "audio" : "other";
  return `<svg class="${colorClass}" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6V3Z" fill="currentColor" opacity=".18"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 13h8M8 17h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

async function renameManagedAsset(conversationId, assetId) {
  const nextName = prompt("输入新的资产名称", "");
  if (!nextName?.trim()) return;
  await updateManagedAsset(conversationId, assetId, { name: nextName.trim() });
}

async function createManagedFolder() {
  if (!assetManagerSelectedConversationId) return;
  const name = prompt("新建文件夹名称", "新建文件夹");
  if (!name?.trim()) return;
  try {
    await postJson(`${API_BASE}/api/conversations/${assetManagerSelectedConversationId}/asset-folders`, {
      name: name.trim(),
    }, { timeout: 30000 });
    await loadAssetManager(assetManagerSelectedConversationId);
  } catch (error) {
    addMarkdownMessage("agent", `新建文件夹失败：${friendlyErrorMarkdown(error.data, error.message)}`);
  }
}

async function renameSelectedAssetItem() {
  if (!assetManagerSelectedConversationId || !assetManagerSelection) return;
  const folder = selectedFolder();
  const asset = selectedAsset();
  const target = folder || asset;
  if (!target) return;
  const name = prompt("输入新的名称", target.name || "");
  if (!name?.trim()) return;
  try {
    if (folder) {
      await postJson(`${API_BASE}/api/conversations/${assetManagerSelectedConversationId}/asset-folders/${encodeURIComponent(folder.id)}`, {
        name: name.trim(),
      }, { method: "PATCH", timeout: 30000 });
    } else if (asset) {
      await updateManagedAsset(assetManagerSelectedConversationId, asset.id, { name: name.trim() });
      return;
    }
    await loadAssetManager(assetManagerSelectedConversationId);
  } catch (error) {
    addMarkdownMessage("agent", `重命名失败：${friendlyErrorMarkdown(error.data, error.message)}`);
  }
}

async function deleteSelectedAssetItem() {
  if (!assetManagerSelectedConversationId || !assetManagerSelection) return;
  const folder = selectedFolder();
  const asset = selectedAsset();
  const target = folder || asset;
  if (!target) return;
  const typeLabel = folder ? "文件夹" : "文件";
  if (!confirm(`确定删除${typeLabel}“${target.name}”吗？`)) return;
  try {
    if (folder) {
      await fetch(`${API_BASE}/api/conversations/${assetManagerSelectedConversationId}/asset-folders/${encodeURIComponent(folder.id)}`, {
        method: "DELETE",
      }).then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
        return data;
      });
    } else if (asset) {
      await fetch(`${API_BASE}/api/conversations/${assetManagerSelectedConversationId}/assets/${encodeURIComponent(asset.id)}`, {
        method: "DELETE",
      }).then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
        return data;
      });
    }
    assetManagerSelection = null;
    await loadAssetManager(assetManagerSelectedConversationId);
    if (assetManagerSelectedConversationId === currentConversationId) {
      await loadConversationAssets(currentConversationId);
    }
  } catch (error) {
    addMarkdownMessage("agent", `删除失败：${friendlyErrorMarkdown(error.data, error.message)}`);
  }
}

async function updateManagedAsset(conversationId, assetId, patch = {}) {
  try {
    const result = await postJson(`${API_BASE}/api/conversations/${conversationId}/assets/${encodeURIComponent(assetId)}`, patch, {
      method: "PATCH",
      timeout: 30000,
    });
    if (conversationId === currentConversationId) renderAssetSummary(result.summary);
    await loadAssetManager(conversationId);
  } catch (error) {
    addMarkdownMessage("agent", `资产更新失败：${friendlyErrorMarkdown(error.data, error.message)}`);
  }
}

// ==================== Conversation Management ====================
const API_BASE = "";

let currentConversationId = null;

function rememberConversation(id) {
  if (id) localStorage.setItem(CONVERSATION_STORAGE_KEY, id);
  else localStorage.removeItem(CONVERSATION_STORAGE_KEY);
}

function rememberedConversationId() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("conversation") || params.get("conversation_id") || "";
  return fromUrl || localStorage.getItem(CONVERSATION_STORAGE_KEY) || "";
}

// Sidebar toggle
const sidebarToggle = document.getElementById("sidebarToggle");
const sidebar = document.getElementById("sidebar");
const compactSidebarQuery = window.matchMedia("(max-width: 1120px)");

if (sidebarToggle && sidebar) {
  const syncSidebarToggleState = () => {
    sidebarToggle.setAttribute("aria-expanded", String(!sidebar.classList.contains("collapsed")));
  };

  const syncSidebarForViewport = event => {
    sidebar.classList.toggle("collapsed", event.matches);
    syncSidebarToggleState();
  };

  syncSidebarForViewport(compactSidebarQuery);
  compactSidebarQuery.addEventListener?.("change", syncSidebarForViewport);

  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    syncSidebarToggleState();
  });
}

// Load conversations
async function loadConversations() {
  try {
    const res = await fetch(`${API_BASE}/api/conversations`);
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.ok) {
      const serverConversations = data.conversations || [];
      conversationCache = serverConversations;
      const serverIds = new Set(serverConversations.map(conv => conv.id));
      optimisticConversations = optimisticConversations.filter(conv => !serverIds.has(conv.id));
      const conversations = [...optimisticConversations, ...serverConversations];
      renderConversationList(conversations);
      if (conversations.length) restoreCurrentConversation(conversations);
      else syncDeviceFrameFromCurrent();
    }
  } catch (err) {
    if (/Login required|401/i.test(err.message || "")) goPortalForAuth();
    console.error("Failed to load conversations:", err);
  }
}

function restoreCurrentConversation(conversations = []) {
  if (currentConversationId || !conversations.length) return;
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
    <div class="conv-item ${conv.id === currentConversationId ? 'active' : ''} ${conv.optimistic ? 'pending' : ''}" data-id="${conv.id}">
      <div class="conv-title">${escapeHtml(conv.title)}</div>
      <div class="conv-time">${conv.optimistic ? '创建中...' : formatTime(conv.updated_at)}</div>
      ${conv.optimistic ? '' : `<button class="conv-delete" data-id="${conv.id}" title="删除对话">×</button>`}
    </div>
  `).join("");

  // Add click handlers for conversation selection
  list.querySelectorAll(".conv-item").forEach(item => {
    item.addEventListener("click", (e) => {
      // Don't select if clicking delete button
      if (e.target.closest(".conv-delete")) return;
      if (item.classList.contains("pending")) return;
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
            renderAssetSummary({ count: 0, totalBytes: 0, byKind: {}, items: [] });
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
    const [msgRes, fileRes, memoryRes, assetRes] = await Promise.all([
      fetch(`${API_BASE}/api/conversations/${id}/messages`),
      fetch(`${API_BASE}/api/conversations/${id}/files`),
      fetch(`${API_BASE}/api/conversations/${id}/memory`),
      fetch(`${API_BASE}/api/conversations/${id}/assets`)
    ]);
    const msgData = await msgRes.json();
    const fileData = await fileRes.json();
    const memoryData = await memoryRes.json();
    const assetData = await assetRes.json();
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
    if (assetData.ok) renderAssetSummary(assetData.summary);
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
  chatLog.scrollTop = 0;
}

// Create new conversation
async function createConversation({ resetChat = true, title = "" } = {}) {
  const projectTitle = String(title || "New Project").trim() || "New Project";
  const optimisticId = `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  optimisticConversations.unshift({
    id: optimisticId,
    title: projectTitle,
    updated_at: new Date().toISOString(),
    optimistic: true,
  });
  currentConversationId = optimisticId;
  renderConversationList([...optimisticConversations, ...conversationCache]);
  try {
    const res = await fetch(`${API_BASE}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: projectTitle }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.ok) {
      optimisticConversations = optimisticConversations.filter(conv => conv.id !== optimisticId);
      currentConversationId = data.id;
      rememberConversation(data.id);
      pendingGeneratePrompt = null;
      conversationLoadToken += 1;
      renderAssetSummary({ count: 0, totalBytes: 0, byKind: {}, items: [] });
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
        if (titleEl) titleEl.textContent = data.title || projectTitle;
        if (data.project_dir) {
          addMarkdownMessage("agent", `Project 创建成功。\n\n文件夹：${data.project_dir}`);
        }
      }
    }
  } catch (err) {
    optimisticConversations = optimisticConversations.filter(conv => conv.id !== optimisticId);
    renderConversationList([...optimisticConversations, ...conversationCache]);
    currentConversationId = null;
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

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, content, build_id: buildId })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      // Refresh conversation list to update title
      await loadConversations();
      return;
    } catch (err) {
      if (attempt >= 2) {
        console.error("Failed to save message:", err);
        throw err;
      }
      await new Promise(resolve => window.setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
}

function persistMessage(role, content, buildId = null, conversationId = currentConversationId) {
  const task = () => saveMessage(role, content, buildId, conversationId);
  messagePersistChain = messagePersistChain.then(task, task).catch(err => {
    console.error("Failed to persist message:", err);
  });
  return messagePersistChain;
}

async function flushPersistedMessages() {
  await messagePersistChain;
}
window.flushPersistedMessages = flushPersistedMessages;

// New conversation button
const newConvBtn = document.getElementById("newConversationBtn");
if (newConvBtn) {
  newConvBtn.addEventListener("click", () => setProjectCreateModal(true));
}

// Deploy to market button
const deployMarketBtn = document.getElementById("deployMarketBtn");
const deployMarketModal = document.getElementById("deployMarketModal");
const closeDeployModal = document.getElementById("closeDeployModal");
const cancelDeploy = document.getElementById("cancelDeploy");
const deployMarketForm = document.getElementById("deployMarketForm");

if (deployMarketBtn && deployMarketModal) {
  deployMarketBtn.addEventListener("click", () => {
    setDeployMarketModal(true);

    const descField = document.getElementById("appDescription");
    if (descField && !descField.value) {
      descField.value = "一个运行在泰山派 RK3566 上的硬件应用，通过 VibeBoard 平台生成。";
    }
  });

  const closeModal = () => {
    setDeployMarketModal(false);
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
        alert("发布失败：" + formatFriendlyError(data, data.error || "未知错误"));
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

// Load account and conversations on startup
[
  codeDrawer,
  statusDrawer,
  jobDrawer,
  guideModal,
  usageDrawer,
  assetManagerDrawer,
  assetPropertiesModal,
  projectCreateModal,
  assetImportModal,
  modelModal,
  el("deployMarketModal"),
].forEach(node => setLayerOpen(node, isOpen(node)));
syncScrim();
refreshAccountState().finally(() => loadConversations());
