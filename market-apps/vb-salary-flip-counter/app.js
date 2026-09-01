const BUILD_ID = "vb-salary-flip-counter";
const PROMPT = "A 480x360 salary counter for a 09:00-18:00 shift with CNY 1,000 total daily salary and stable scoreboard flip animations.";
function salarySnapshot(now = new Date(), options = {}) {
  const startHour = Number.isFinite(options.startHour) ? options.startHour : 9;
  const endHour = Number.isFinite(options.endHour) ? options.endHour : 18;
  const dailySalary = Number.isFinite(options.dailySalary) ? options.dailySalary : 1000;
  const start = new Date(now);
  start.setHours(startHour, 0, 0, 0);
  const end = new Date(now);
  end.setHours(endHour, 0, 0, 0);
  const shiftMs = Math.max(1, end - start);
  const elapsedMs = Math.min(Math.max(now - start, 0), shiftMs);
  const amount = (elapsedMs / shiftMs) * dailySalary;
  return { amount, integerAmount: Math.floor(amount), progress: elapsedMs / shiftMs, phase: now < start ? "waiting" : now >= end ? "complete" : "earning", total: dailySalary };
}
const digitsRoot = document.querySelector("#amount");
const phaseLabel = document.querySelector("#phaseLabel");
const precise = document.querySelector("#precise");
const progressLabel = document.querySelector("#progressLabel");
const remainingLabel = document.querySelector("#remainingLabel");
const progressBar = document.querySelector("#progressBar");
const statusLabel = document.querySelector("#statusLabel");
const calendar = document.querySelector("#calendar");
const calendarMonth = document.querySelector("#calendarMonth");
const calendarDay = document.querySelector("#calendarDay");
const money = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integerMoney = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
let shownDigits = "0000";
let dayKey = "";

function makeDigit(value, index) {
  const el = document.createElement("div");
  el.className = `digit${value === "0" && index < 3 ? " dim" : ""}`;
  el.dataset.index = String(index);
  el.innerHTML = `<span class="face">${value}</span>`;
  return el;
}

function renderDigits(value) {
  const next = String(Math.max(0, Math.min(9999, value))).padStart(4, "0");
  if (!digitsRoot.children.length) {
    digitsRoot.innerHTML = `<span class="currency">¥</span>`;
    [...next].forEach((digit, index) => digitsRoot.append(makeDigit(digit, index)));
    shownDigits = next;
    return;
  }
  [...next].forEach((digit, index) => {
    if (digit === shownDigits[index]) return;
    const el = digitsRoot.querySelector(`[data-index="${index}"]`);
    const face = el.querySelector(".face");
    face.textContent = digit;
    el.classList.toggle("dim", digit === "0" && index < 3);
    el.classList.remove("flipping");
    void el.offsetWidth;
    el.classList.add("flipping");
    window.setTimeout(() => el.classList.remove("flipping"), 520);
  });
  shownDigits = next;
}

function renderCalendar(now) {
  const nextKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  calendarMonth.textContent = monthNames[now.getMonth()];
  calendarDay.textContent = String(now.getDate()).padStart(2, "0");
  if (nextKey !== dayKey) {
    dayKey = nextKey;
    calendar.classList.remove("flip");
    void calendar.offsetWidth;
    calendar.classList.add("flip");
  }
}

function render() {
  const now = new Date();
  const snapshot = salarySnapshot(now);
  renderCalendar(now);
  renderDigits(snapshot.integerAmount);
  precise.textContent = `精确收入 ¥${money.format(snapshot.amount)}`;
  progressBar.style.width = `${Math.round(snapshot.progress * 100)}%`;
  progressLabel.textContent = `今日进度 ${Math.round(snapshot.progress * 100)}%`;
  remainingLabel.textContent = snapshot.phase === "complete" ? "今日已完成" : `距 ¥${integerMoney.format(snapshot.total)}`;
  if (snapshot.phase === "waiting") {
    phaseLabel.textContent = "正在准备";
    statusLabel.textContent = "工作日 09:00 开始计时";
  } else if (snapshot.phase === "complete") {
    phaseLabel.textContent = "今日完成";
    statusLabel.textContent = "辛苦了，今天已赚 ¥1,000";
  } else {
    phaseLabel.textContent = "正在累积";
    statusLabel.textContent = "每一秒，都在变多";
  }
}

window.VibeBoardHardware = { getSnapshot: () => ({ build_id: BUILD_ID, prompt: PROMPT, display: { width: 480, height: 360 }, capabilities: [] }) };
render();
window.setInterval(render, 250);
