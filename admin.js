const $ = id => document.getElementById(id);
const usersBody = $("adminUsersBody");
const ledgerBody = $("adminLedgerBody");
const telemetryBody = $("adminTelemetryBody");
const telemetryInsights = $("telemetryInsights");
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
    renderTelemetryInsights(telemetry.events || []);
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

function renderTelemetryInsights(events) {
  const users = uniqueCount(events.map(event => event.user_hash || event.session_hash).filter(Boolean));
  const pages = topCounts(events.map(event => event.page || "unknown"), 4);
  const boards = topCounts(events.map(event => event.board_id || "").filter(Boolean), 4);
  const actions = topCounts(events.map(event => [event.category, event.action].filter(Boolean).join(":") || event.event_type), 6);
  const errors = events.filter(event => String(event.severity || "").toLowerCase() === "error");
  const errorTypes = topCounts(errors.map(event => event.payload?.errorType || event.event_type || "error"), 4);
  const recentPrompts = events
    .map(event => event.payload?.prompt_excerpt || event.payload?.prompt || "")
    .filter(Boolean)
    .slice(0, 4);

  telemetryInsights.innerHTML = `
    <div class="telemetry-insight-card">
      <span>匿名用户 / 会话</span>
      <strong>${users}</strong>
    </div>
    <div class="telemetry-insight-card">
      <span>常用页面</span>
      ${renderCountList(pages)}
    </div>
    <div class="telemetry-insight-card">
      <span>开发板偏好</span>
      ${renderCountList(boards)}
    </div>
    <div class="telemetry-insight-card">
      <span>高频行为</span>
      ${renderCountList(actions)}
    </div>
    <div class="telemetry-insight-card">
      <span>错误类型</span>
      ${renderCountList(errorTypes)}
    </div>
    <div class="telemetry-insight-card wide">
      <span>最近任务摘要</span>
      ${recentPrompts.length ? `<ul>${recentPrompts.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<em>暂无任务摘要</em>"}
    </div>
  `;
}

function topCounts(values, limit = 5) {
  const counts = new Map();
  for (const value of values) {
    const key = String(value || "").trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function uniqueCount(values) {
  return new Set(values.filter(Boolean)).size;
}

function renderCountList(rows) {
  if (!rows.length) return "<em>暂无</em>";
  return `<ul>${rows.map(([label, count]) => `<li><b>${escapeHtml(label)}</b><span>${count}</span></li>`).join("")}</ul>`;
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
