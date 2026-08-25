const $ = id => document.getElementById(id);

const state = {
  user: null,
  mode: "login",
  boards: [],
  devices: [],
  binding: false,
};

const authCard = $("portalAuthCard");
const boardArea = $("portalBoardArea");
const boardCatalog = $("boardCatalog");
const userLabel = $("portalUserLabel");
const adminLink = $("portalAdminLink");
const logoutBtn = $("portalLogoutBtn");
const message = $("portalAuthMessage");
const authTitle = $("portalAuthTitle");
const loginTab = $("portalLoginTab");
const registerTab = $("portalRegisterTab");
const loginForm = $("portalLoginForm");
const registerForm = $("portalRegisterForm");
const deviceBindForm = $("deviceBindForm");
const deviceSerialInput = $("deviceSerialInput");
const deviceBindMessage = $("deviceBindMessage");
const myDeviceList = $("myDeviceList");

loginTab?.addEventListener("click", () => setMode("login"));
registerTab?.addEventListener("click", () => setMode("register"));
logoutBtn?.addEventListener("click", logout);
loginForm?.addEventListener("submit", event => {
  event.preventDefault();
  submitAuth("/api/auth/login", {
    phone: $("portalLoginPhone").value.trim(),
    password: $("portalLoginPassword").value,
  });
});
registerForm?.addEventListener("submit", event => {
  event.preventDefault();
  submitAuth("/api/auth/register", {
    phone: $("portalRegisterPhone").value.trim(),
    password: $("portalRegisterPassword").value,
  });
});
deviceBindForm?.addEventListener("submit", event => {
  event.preventDefault();
  bindDevice();
});
deviceSerialInput?.addEventListener("input", () => {
  const normalized = normalizeSerial(deviceSerialInput.value);
  if (deviceSerialInput.value !== normalized) deviceSerialInput.value = normalized;
});

init();

async function init() {
  await Promise.all([loadMe(), loadBoards()]);
  if (state.user) await loadMyDevices();
  render();
}

async function loadMe() {
  const data = await getJson("/api/me").catch(() => ({ user: null }));
  state.user = data.user || null;
}

async function loadBoards() {
  const data = await getJson("/api/board-catalog");
  state.boards = data.boards || [];
}

async function loadMyDevices() {
  if (!state.user) {
    state.devices = [];
    return;
  }
  const data = await getJson("/api/my-devices").catch(() => ({ devices: [] }));
  state.devices = data.devices || [];
}

function render() {
  const signedIn = Boolean(state.user);
  authCard.hidden = signedIn;
  boardArea.hidden = !signedIn;
  logoutBtn.hidden = !signedIn;
  adminLink.hidden = state.user?.role !== "admin";
  if (userLabel) userLabel.textContent = signedIn ? `当前账号 ${state.user.phone}` : "";
  renderBoards();
  renderMyDevices();
}

function renderBoards() {
  if (!boardCatalog) return;
  boardCatalog.innerHTML = state.boards.map(board => `
    <article class="board-card" data-board-id="${escapeHtml(board.id)}">
      <div class="board-card-top">
        <div>
          <span class="board-family">${escapeHtml(board.family || "Board")}</span>
          <h3>${escapeHtml(board.label)}</h3>
        </div>
        <span class="board-status ${escapeHtml(board.status || "")}">${statusLabel(board.status)}</span>
      </div>
      <p>${escapeHtml(board.description || "")}</p>
      <div class="board-tags">${(board.capabilities || []).map(item => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      <button class="primary-btn board-enter" type="button" data-board-enter="${escapeHtml(board.id)}">进入体验</button>
    </article>
  `).join("");
  boardCatalog.querySelectorAll("[data-board-enter]").forEach(button => {
    button.addEventListener("click", () => {
      const board = state.boards.find(item => item.id === button.dataset.boardEnter);
      if (!board) return;
      selectBoard(board);
      location.href = board.route || `/workbench?board=${encodeURIComponent(board.id)}`;
    });
  });
}

function renderMyDevices() {
  if (!myDeviceList) return;
  const devices = state.devices || [];
  if (!devices.length) {
    myDeviceList.innerHTML = `
      <article class="my-device-empty">
        <h3>还没有绑定设备</h3>
        <p>你仍然可以从上方泰山派入口进入体验预览。拿到真实硬件后，在这里输入设备序列号即可绑定。</p>
      </article>
    `;
    return;
  }
  myDeviceList.innerHTML = devices.map(device => `
    <article class="my-device-card" data-device-serial="${escapeHtml(device.serial)}">
      <div class="device-avatar ${escapeHtml(device.color || "default")}"></div>
      <div class="device-main">
        <div class="device-title-row">
          <h3>${escapeHtml(device.label || "VibeBoard 设备")}</h3>
          <span class="device-status">${deviceStatusLabel(device.status)}</span>
        </div>
        <p>${escapeHtml(device.model || "泰山派 RK3566")} · ${connectionLabel(device.connection_mode)}</p>
        <span class="device-serial">${escapeHtml(device.serial_mask || device.serial || "")}</span>
      </div>
      <button class="ghost-btn device-open" type="button" data-device-open="${escapeHtml(device.serial)}">进入设备</button>
    </article>
  `).join("");
  myDeviceList.querySelectorAll("[data-device-open]").forEach(button => {
    button.addEventListener("click", () => {
      const device = devices.find(item => item.serial === button.dataset.deviceOpen);
      if (!device) return;
      localStorage.setItem("vibeboard-bound-device", JSON.stringify({
        serial: device.serial,
        label: device.label,
        board_id: device.board_id,
        selected_at: new Date().toISOString(),
      }));
      location.href = device.route || `/workbench?board=${encodeURIComponent(device.board_id || "taishan-gray")}&device=${encodeURIComponent(device.serial)}`;
    });
  });
}

function selectBoard(board) {
  localStorage.setItem("vibeboard-active-device", board.id);
  localStorage.setItem("vibeboard-selected-board", JSON.stringify({
    id: board.id,
    label: board.label,
    family: board.family,
    status: board.status,
    selected_at: new Date().toISOString(),
  }));
  window.VibeTelemetry?.track("portal.board.select", { category: "portal", board_id: board.id, board_status: board.status });
}

function setMode(mode) {
  state.mode = mode === "register" ? "register" : "login";
  const register = state.mode === "register";
  loginTab.classList.toggle("active", !register);
  registerTab.classList.toggle("active", register);
  loginTab.setAttribute("aria-selected", String(!register));
  registerTab.setAttribute("aria-selected", String(register));
  loginForm.classList.toggle("hidden", register);
  registerForm.classList.toggle("hidden", !register);
  authTitle.textContent = register ? "Create your account" : "Sign in to VibeBoard";
  message.textContent = "";
}

async function submitAuth(url, payload) {
  try {
    message.textContent = "正在处理...";
    await postJson(url, payload);
    window.VibeTelemetry?.track(url.includes("register") ? "auth.register" : "auth.login", { category: "auth" });
    await loadMe();
    await loadMyDevices();
    message.textContent = "";
    render();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function bindDevice() {
  if (!deviceSerialInput || state.binding) return;
  const serial = normalizeSerial(deviceSerialInput.value);
  state.binding = true;
  if (deviceBindMessage) deviceBindMessage.textContent = "正在绑定设备...";
  setBindDisabled(true);
  try {
    const data = await postJson("/api/device-bindings", { serial });
    state.devices = data.devices || (data.device ? [data.device] : []);
    deviceSerialInput.value = "";
    if (deviceBindMessage) deviceBindMessage.textContent = "设备已绑定。";
    window.VibeTelemetry?.track("portal.device.bind", { category: "portal", connection_mode: data.device?.connection_mode || "" });
    renderMyDevices();
  } catch (error) {
    if (deviceBindMessage) deviceBindMessage.textContent = friendlyBindError(error.message);
  } finally {
    state.binding = false;
    setBindDisabled(false);
  }
}

function setBindDisabled(disabled) {
  const button = deviceBindForm?.querySelector("button[type='submit']");
  if (button) {
    button.disabled = disabled;
    button.textContent = disabled ? "绑定中..." : "绑定设备";
  }
}

async function logout() {
  await postJson("/api/auth/logout", {}).catch(() => {});
  state.user = null;
  state.devices = [];
  render();
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function normalizeSerial(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function friendlyBindError(messageText) {
  const text = String(messageText || "");
  if (/8 letters/i.test(text)) return "序列号格式不对：请输入 8 个英文字母 + 4 个数字。";
  if (/not found/i.test(text)) return "没有找到这台设备，请确认序列号是否录入到设备库存。";
  if (/already bound/i.test(text)) return "这台设备已经绑定到其它账号，不能重复绑定。";
  if (/login/i.test(text)) return "请先登录后再绑定设备。";
  return text || "绑定失败，请稍后重试。";
}

function statusLabel(status) {
  if (status === "available") return "可用";
  if (status === "experimental") return "实验";
  return "待接入";
}

function deviceStatusLabel(status) {
  if (status === "ready") return "已就绪";
  if (status === "offline") return "离线";
  return "已绑定";
}

function connectionLabel(mode) {
  if (mode === "frp") return "FRP 通道";
  if (mode === "lan") return "局域网";
  return "体验预览";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}
