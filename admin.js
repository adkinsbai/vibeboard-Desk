const $ = id => document.getElementById(id);
const usersBody = $("adminUsersBody");
const ledgerBody = $("adminLedgerBody");
const summary = $("adminSummary");
const message = $("adminMessage");
const refreshBtn = $("refreshAdminBtn");

refreshBtn?.addEventListener("click", loadAdmin);
loadAdmin();

async function loadAdmin() {
  try {
    message.textContent = "";
    const [me, users, credits] = await Promise.all([
      getJson("/api/me"),
      getJson("/api/admin/users"),
      getJson("/api/admin/credits"),
    ]);
    if (!me.user || me.user.role !== "admin") {
      message.textContent = "需要管理员账号登录后访问。";
      return;
    }
    renderSummary(users.users || []);
    renderUsers(users.users || []);
    renderLedger(credits.ledger || [], users.users || []);
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

function renderSummary(users) {
  const totalCredits = users.reduce((sum, user) => sum + Number(user.credits_balance || 0), 0);
  summary.innerHTML = `
    <div><span>账户数</span><strong>${users.length}</strong></div>
    <div><span>总余额</span><strong>${formatCredits(totalCredits)}</strong></div>
    <div><span>免费额度</span><strong>40 / account</strong></div>
    <div><span>计费</span><strong>1 credit = 10k tokens</strong></div>
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

function formatCredits(value) {
  return Number(value || 0).toFixed(4).replace(/\.?0+$/, "");
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN");
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
