const $ = id => document.getElementById(id);

const state = {
  user: null,
  mode: "login",
  boards: [],
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

init();

async function init() {
  await Promise.all([loadMe(), loadBoards()]);
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

function render() {
  const signedIn = Boolean(state.user);
  authCard.hidden = signedIn;
  boardArea.hidden = !signedIn;
  logoutBtn.hidden = !signedIn;
  adminLink.hidden = state.user?.role !== "admin";
  if (userLabel) userLabel.textContent = signedIn ? `当前账户 ${state.user.phone}` : "";
  renderBoards();
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
      localStorage.setItem("vibeboard-active-device", board.id);
      localStorage.setItem("vibeboard-selected-board", JSON.stringify({
        id: board.id,
        label: board.label,
        family: board.family,
        status: board.status,
        selected_at: new Date().toISOString(),
      }));
      window.VibeTelemetry?.track("portal.board.select", { category: "portal", board_id: board.id, board_status: board.status });
      location.href = board.route || `/workbench?board=${encodeURIComponent(board.id)}`;
    });
  });
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
    message.textContent = "";
    render();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function logout() {
  await postJson("/api/auth/logout", {}).catch(() => {});
  state.user = null;
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

function statusLabel(status) {
  if (status === "available") return "可用";
  if (status === "experimental") return "实验";
  return "待接入";
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
