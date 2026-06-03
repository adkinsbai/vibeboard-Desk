const SPEC = {"id":"vb-mpy6k44x-e85c2d","prompt":"hello world test","mode":"assistant","title":"AI Screen Assistant","subtitle":"hello world test","accent":"#22c55e","target":"480x360 RK3566 Linux kiosk","hardwareApi":["/api/status","./hardware-result.json"],"widgets":[{"id":"wifi","label":"Wi-Fi","value":"--","hint":"live network"},{"id":"ip","label":"IP","value":"--","hint":"board address"},{"id":"temp","label":"Temp","value":"--","hint":"thermal zone"},{"id":"runtime","label":"Runtime","value":"--","hint":"python result"}],"actions":[{"id":"primary","label":"Run"},{"id":"secondary","label":"Mark"},{"id":"refresh","label":"Refresh"}]};
const PROMPT = SPEC.prompt;
const BUILD_ID = "vb-mpy6k44x-e85c2d";
const el = id => document.getElementById(id);
const state = { tick: 0, activeA: false, activeB: false, running: false, seconds: 1500, cycles: 0 };

window.VibeBoardHardware = {
  async getStatus() {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error("status " + res.status);
    return res.json();
  },
  async getProgramResult() {
    const res = await fetch("./hardware-result.json", { cache: "no-store" });
    if (!res.ok) throw new Error("program " + res.status);
    return res.json();
  },
  async getSnapshot() {
    const settled = await Promise.allSettled([this.getStatus(), this.getProgramResult()]);
    return {
      status: settled[0].status === "fulfilled" ? settled[0].value : null,
      program: settled[1].status === "fulfilled" ? settled[1].value : null
    };
  }
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value == null || value === "" ? "--" : String(value);
}

function drawClock() {
  const now = new Date();
  setText("time", pad(now.getHours()) + ":" + pad(now.getMinutes()));
  setText("date", now.toLocaleDateString("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }));
}

function renderMode() {
  if (SPEC.mode === "timer") {
    if (state.running && state.seconds > 0) state.seconds -= 1;
    const minutes = Math.floor(state.seconds / 60);
    const seconds = state.seconds % 60;
    setText("remaining", pad(minutes) + ":" + pad(seconds));
    setText("cycles", state.cycles);
  }
  if (SPEC.mode === "voice") {
    setText("level", state.running ? "listening" : "ready");
    setText("transcript", state.running ? "capturing..." : "tap start");
    setText("response", state.tick % 2 ? "hardware online" : "waiting");
  }
  if (SPEC.mode === "control") {
    setText("switchA", state.activeA ? "on" : "off");
    setText("switchB", state.activeB ? "on" : "off");
  }
}

async function refresh() {
  try {
    const snapshot = await window.VibeBoardHardware.getSnapshot();
    const data = snapshot.status || {};
    const program = snapshot.program || {};
    const ip = (data.network && data.network.addresses && data.network.addresses[0]) || "--";
    setText("wifi", (data.network && data.network.wifi) || "offline");
    setText("ip", ip);
    setText("temp", data.cpu_temp == null ? "--" : data.cpu_temp + "°C");
    setText("memory", data.memory ? Number(data.memory.percent || 0).toFixed(1) + "%" : "--");
    setText("runtime", program.runtime || "waiting");
    setText("load", program.loadavg || "--");
    setText("serviceState", data.services && data.services.display || "--");
    setText("eventLog", "api ok " + new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    const serviceText = data.services ? "SSH " + (data.services.ssh || "--") + " / FRP " + (data.services.frpc || "--") : "Linux API ready";
    setText("service", serviceText);
  } catch (error) {
    setText("eventLog", "hardware api retrying");
    setText("ip", "waiting");
  }
}

function handleAction(action, button) {
  if (action === "refresh") refresh();
  if (action === "primary") {
    if (SPEC.mode === "timer") state.running = !state.running;
    else if (SPEC.mode === "control") state.activeA = !state.activeA;
    else state.running = !state.running;
  }
  if (action === "secondary") {
    if (SPEC.mode === "timer") { state.cycles += 1; state.seconds = 1500; }
    else if (SPEC.mode === "control") state.activeB = !state.activeB;
    else state.tick += 1;
  }
  if (button) button.classList.toggle("active");
  renderMode();
}

drawClock();
refresh();
renderMode();
document.querySelectorAll(".action").forEach(button => {
  button.addEventListener("click", () => handleAction(button.dataset.action, button));
});
setInterval(drawClock, 1000);
setInterval(() => { state.tick += 1; renderMode(); }, 1000);
setInterval(refresh, 5000);
console.log("VibeBoard deployed", BUILD_ID, PROMPT);
