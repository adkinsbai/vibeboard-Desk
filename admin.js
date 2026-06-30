const $ = id => document.getElementById(id);
const usersBody = $("adminUsersBody");
const ledgerBody = $("adminLedgerBody");
const telemetryBody = $("adminTelemetryBody");
const summary = $("adminSummary");
const message = $("adminMessage");
const refreshBtn = $("refreshAdminBtn");

refreshBtn?.addEventListener("click", loadAdmin);
loadAdmin();

async function loadAdmin() {
  try {
    message.textContent = "";
    const [me, users, credits, telemetry] = await Promise.all([
      getJson("/api/me"),
      getJson("/api/admin/users"),
      getJson("/api/admin/credits"),
      getJson("/api/admin/telemetry?limit=200"),
    ]);
    if (!me.user || me.user.role !== "admin") {
      message.textContent = "需要管理员账号登录后访问。";
      return;
    }
    renderSummary(users.users || [], telemetry.events || []);
    renderUsers(users.users || []);
    renderLedger(credits.ledger || [], users.users || []);
    renderTelemetry(telemetry.events || []);
  } catch (error) {
    message.textContent = error.message;
  }
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderSummary(users, events = []) {
  const totalCredits = users.reduce((sum, user) => sum + Number(user.credits_balance || 0), 0);
  const errorEvents = events.filter(event => String(event.severity || "").toLowerCase() === "error").length;
  summary.innerHTML = `
    <div><span>账户数</span><strong>${users.length}</strong></div>
    <div><span>总余额</span><strong>${formatCredits(totalCredits)}</strong></div>
    <div><span>上报事件</span><strong>${events.length}</strong></div>
    <div><span>错误事件</span><strong>${errorEvents}</strong></div>
  `;
}

function renderUsers(users) {
  usersBody.innerHTML = users.map(user => `
    <tr>
      <td>${escapeHtml(user.phone)}</td>
      <td>${escapeHtml(user.role)}</td>
      <td>${formatCredits(user.credits_balance)}</td>
      <td>${formatTime(user.created_at)}</td>
    </tr>
  `).join("") || `<tr><td colspan="4">暂无账户</td></tr>`;
}

function renderLedger(rows, users) {
  const phoneById = new Map(users.map(user => [user.id, user.phone]));
  ledgerBody.innerHTML = rows.map(row => `
    <tr>
      <td>${escapeHtml(phoneById.get(row.user_id) || row.user_id || "")}</td>
      <td class="${Number(row.delta) < 0 ? "danger-text" : "ok-text"}">${formatCredits(row.delta)}</td>
      <td>${formatCredits(row.balance_after)}</td>
      <td>${escapeHtml(row.reason || "")}</td>
      <td>${Number(row.tokens || 0).toLocaleString()}</td>
      <td>${formatTime(row.created_at)}</td>
    </tr>
  `).join("") || `<tr><td colspan="6">暂无账本记录</td></tr>`;
}

function renderTelemetry(events) {
  telemetryBody.innerHTML = events.map(event => `
    <tr>
      <td>${formatTime(event.created_at)}</td>
      <td>${escapeHtml(shortHash(event.user_hash || event.session_hash || "anonymous"))}</td>
      <td>${escapeHtml([event.event_type, event.category, event.action].filter(Boolean).join(" / "))}</td>
      <td>${escapeHtml(event.page || "")}</td>
      <td>${escapeHtml(event.board_id || "")}</td>
      <td><code>${escapeHtml(JSON.stringify(event.payload || {}).slice(0, 280))}</code></td>
    </tr>
  `).join("") || `<tr><td colspan="6">暂无上报数据</td></tr>`;
}

function formatCredits(value) {
  return Number(value || 0).toFixed(4).replace(/\.?0+$/, "");
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN");
}

function shortHash(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 12)}...` : text;
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
