import { createAppSpec } from "./generatedAppTemplate.mjs";

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
export function advancedTemplateFilesV2(prompt, id, spec) {
  const title = spec.title || "VibeBoard Generated App";
  const chips = ["CUSTOM APP", "480x360", "RUNNER READY"];
  const actions = (spec.actions || []).slice(0, 3);
  while (actions.length < 3) actions.push({ id: actions.length ? "secondary" : "primary", label: actions.length ? "Mark" : "Run" });
  const widgetCards = spec.widgets.slice(0, 4).map(widget => (
    `<article class="widget" data-widget="${htmlEscape(widget.id)}"><span>${htmlEscape(widget.label)}</span><strong id="${htmlEscape(widget.id)}">${htmlEscape(widget.value)}</strong><small>${htmlEscape(widget.hint)}</small></article>`
  )).join("\n      ");
  const actionButtons = actions.map(action => (
    `<button class="action" type="button" data-action="${htmlEscape(action.id)}">${htmlEscape(action.label)}</button>`
  )).join("\n          ");

  const index = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VibeBoard ${htmlEscape(title)}</title>
  <link rel="stylesheet" href="./style.css?v=${id}">
</head>
<body>
  <main class="screen mode-fallback" data-mode="fallback">
    <div class="aurora" aria-hidden="true"></div>
    <div class="scanline" aria-hidden="true"></div>
    <div class="cityline" aria-hidden="true"></div>
    <header class="hud">
      <div>
        <span id="date">480x360 RK3566 Linux kiosk</span>
        <strong>${htmlEscape(title)}</strong>
      </div>
      <b id="service">Linux API --</b>
    </header>
    <section class="chips">
      ${chips.map(chip => `<span>${htmlEscape(chip)}</span>`).join("\n      ")}
    </section>
    <section class="scene" aria-label="generated app scene">
      <div class="scene-copy">
        <span>GENERATED APP</span>
        <h1>${htmlEscape(spec.title)}</h1>
        <p>${htmlEscape(spec.subtitle)}</p>
      </div>
      <div class="reactor" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    </section>
    <section class="widgets">
      ${widgetCards}
    </section>
    <section class="actions">
      <div>
        ${actionButtons}
      </div>
      <small id="eventLog">hardware api waiting</small>
    </section>
    <footer><span id="clock">--:--</span><span>${id}</span></footer>
  </main>
  <script src="./app.js?v=${id}"></script>
</body>
</html>
`;

  const style = `:root {
  color-scheme: dark;
  --bg: #05030f;
  --panel: rgba(8, 13, 34, .72);
  --line: rgba(125, 249, 255, .26);
  --text: #f8fbff;
  --muted: #91a8c7;
  --cyan: #2df8ff;
  --pink: #ff2bd6;
  --green: #43ff91;
  --gold: #ffd166;
}

* { box-sizing: border-box; }

html, body {
  width: 480px;
  height: 360px;
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", "Noto Sans SC", system-ui, sans-serif;
}

button { font: inherit; }

.screen {
  position: relative;
  width: 480px;
  height: 360px;
  display: grid;
  grid-template-rows: 46px 28px 118px 78px 44px 18px;
  gap: 7px;
  padding: 10px;
  overflow: hidden;
  isolation: isolate;
  background:
    linear-gradient(rgba(125,249,255,.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,43,214,.06) 1px, transparent 1px),
    radial-gradient(circle at 14% 18%, rgba(45,248,255,.32), transparent 24%),
    radial-gradient(circle at 82% 18%, rgba(255,43,214,.27), transparent 25%),
    radial-gradient(circle at 62% 88%, rgba(67,255,145,.14), transparent 26%),
    linear-gradient(135deg, #070817 0%, #13051d 48%, #06111c 100%);
  background-size: 28px 28px, 28px 28px, auto, auto, auto, auto;
}

.mode-dashboard {
  background:
    linear-gradient(rgba(255,209,102,.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(45,248,255,.06) 1px, transparent 1px),
    radial-gradient(circle at 18% 24%, rgba(255,209,102,.34), transparent 25%),
    radial-gradient(circle at 84% 72%, rgba(45,248,255,.24), transparent 28%),
    linear-gradient(135deg, #08111d 0%, #1a1320 52%, #061922 100%);
}

.mode-control {
  background:
    linear-gradient(rgba(255,43,214,.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(67,255,145,.06) 1px, transparent 1px),
    radial-gradient(circle at 18% 18%, rgba(255,43,214,.34), transparent 26%),
    radial-gradient(circle at 82% 70%, rgba(67,255,145,.24), transparent 28%),
    linear-gradient(135deg, #140612 0%, #061513 58%, #190918 100%);
}

.mode-timer {
  background:
    linear-gradient(rgba(167,139,250,.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(45,248,255,.06) 1px, transparent 1px),
    radial-gradient(circle at 22% 20%, rgba(167,139,250,.36), transparent 26%),
    radial-gradient(circle at 78% 76%, rgba(255,209,102,.2), transparent 28%),
    linear-gradient(135deg, #10091e 0%, #071327 54%, #130f08 100%);
}

.mode-voice {
  background:
    linear-gradient(rgba(56,189,248,.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,43,214,.06) 1px, transparent 1px),
    radial-gradient(circle at 20% 24%, rgba(56,189,248,.35), transparent 26%),
    radial-gradient(circle at 80% 70%, rgba(255,43,214,.2), transparent 28%),
    linear-gradient(135deg, #07111f 0%, #0c071b 58%, #061522 100%);
}

.aurora {
  position: absolute;
  inset: -80px;
  z-index: -2;
  opacity: .74;
  background: conic-gradient(from 180deg, transparent, rgba(45,248,255,.32), rgba(255,43,214,.28), transparent, rgba(67,255,145,.22), transparent);
  animation: drift 10s linear infinite;
}

.scanline {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  background: linear-gradient(transparent 0 48%, rgba(255,255,255,.14) 50%, transparent 52% 100%);
  background-size: 100% 7px;
  mix-blend-mode: overlay;
  opacity: .26;
}

.cityline {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 38px;
  z-index: -1;
  height: 54px;
  opacity: .42;
  background:
    linear-gradient(90deg, transparent 0 18px, rgba(45,248,255,.28) 18px 32px, transparent 32px 48px),
    linear-gradient(180deg, transparent 0 22px, rgba(255,43,214,.2) 22px 54px);
  background-size: 48px 54px, 100% 54px;
  filter: drop-shadow(0 0 12px rgba(45,248,255,.5));
}

.hud {
  min-width: 0;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
}

.hud span,
.chips span,
.scene span,
.scene p,
.widget span,
.widget small,
.actions small,
footer {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.1;
  letter-spacing: 0;
}

.hud strong {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  color: var(--cyan);
  font-size: 21px;
  line-height: 1;
  text-shadow: 0 0 16px rgba(45,248,255,.75);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hud b {
  max-width: 178px;
  min-height: 28px;
  padding: 7px 9px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--cyan);
  background: rgba(0,0,0,.22);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chips {
  display: flex;
  gap: 7px;
  min-width: 0;
}

.chips span {
  padding: 6px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(255,255,255,.08);
  color: inherit;
  font-weight: 800;
}

.scene,
.widget {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.16), 0 12px 28px rgba(0,0,0,.18);
  backdrop-filter: blur(8px);
}

.scene {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 124px;
  gap: 8px;
  padding: 12px;
  overflow: hidden;
}

.scene-copy {
  min-width: 0;
  z-index: 1;
}

h1 {
  max-width: 276px;
  margin: 8px 0 6px;
  overflow: hidden;
  color: var(--cyan);
  font-size: 29px;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 0 16px rgba(45,248,255,.68);
}

p {
  display: -webkit-box;
  max-width: 276px;
  margin: 0;
  overflow: hidden;
  line-height: 1.35;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.reactor {
  position: relative;
  width: 106px;
  height: 106px;
  align-self: center;
  justify-self: end;
}

.reactor i {
  position: absolute;
  inset: 0;
  border: 2px solid rgba(45,248,255,.42);
  border-radius: 50%;
  box-shadow: 0 0 18px rgba(45,248,255,.36), inset 0 0 18px rgba(255,43,214,.22);
  animation: orbit 4s linear infinite;
}

.reactor i:nth-child(2) {
  inset: 16px;
  border-color: rgba(255,43,214,.52);
  animation-duration: 2.7s;
  animation-direction: reverse;
}

.reactor i:nth-child(3) {
  inset: 36px;
  border-color: rgba(67,255,145,.52);
  animation-duration: 1.8s;
}

.meter {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 10px;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  height: 18px;
}

.meter i {
  display: block;
  border-radius: 4px;
  background: linear-gradient(90deg, rgba(45,248,255,.62), rgba(255,43,214,.42));
  transform-origin: bottom;
  animation: meter 1.3s ease-in-out infinite;
}

.meter i:nth-child(2) { animation-delay: .16s; }
.meter i:nth-child(3) { animation-delay: .31s; }
.meter i:nth-child(4) { animation-delay: .47s; }
.meter i:nth-child(5) { animation-delay: .62s; }

.widgets {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 7px;
}

.widget {
  padding: 8px;
}

.widget strong {
  display: block;
  margin: 7px 0 4px;
  overflow: hidden;
  color: var(--green);
  font-size: 17px;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.widget small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  min-width: 0;
  min-height: 0;
  display: grid;
  gap: 5px;
}

.actions div {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 7px;
}

.action {
  min-width: 0;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--text);
  background: linear-gradient(135deg, rgba(45,248,255,.24), rgba(255,43,214,.2));
  font-size: 11px;
  font-weight: 900;
}

.action.active {
  border-color: var(--green);
  box-shadow: 0 0 16px rgba(67,255,145,.45);
}

.actions small,
footer span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

@keyframes drift {
  to { transform: rotate(360deg); }
}

@keyframes orbit {
  to { transform: rotate(360deg); }
}

@keyframes meter {
  0%, 100% { transform: scaleY(.35); opacity: .58; }
  50% { transform: scaleY(1); opacity: 1; }
}
`;

  const app = `const SPEC = ${JSON.stringify(spec)};
const PROMPT = SPEC.prompt;
const BUILD_ID = ${JSON.stringify(id)};
const el = id => document.getElementById(id);
let secondsLeft = 25 * 60;
let cycles = 0;

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
  },
  audio: {
    async status() {
      const res = await fetch("/api/audio/status", { cache: "no-store" });
      if (!res.ok) throw new Error("audio status " + res.status);
      return res.json();
    },
    async play(options = {}) {
      const res = await fetch("/api/audio/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options)
      });
      if (!res.ok) throw new Error("audio play " + res.status);
      return res.json();
    },
    async record(options = {}) {
      const res = await fetch("/api/audio/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options)
      });
      if (!res.ok) throw new Error("audio record " + res.status);
      return res.json();
    },
    async stop(options = {}) {
      const res = await fetch("/api/audio/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options)
      });
      if (!res.ok) throw new Error("audio stop " + res.status);
      return res.json();
    }
  }
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value == null || value === "" ? "--C" : String(value);
}

function drawClock() {
  const now = new Date();
  setText("clock", pad(now.getHours()) + ":" + pad(now.getMinutes()));
}

function tickTimer() {
  if (SPEC.mode !== "timer") return;
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  setText("remaining", pad(minutes) + ":" + pad(seconds));
  setText("cycles", String(cycles));
  secondsLeft -= 1;
  if (secondsLeft < 0) {
    cycles += 1;
    secondsLeft = 25 * 60;
  }
}

function animateVoice() {
  if (SPEC.mode !== "voice") return;
  const level = 34 + Math.round(Math.random() * 62);
  setText("level", level + "%");
  setText("transcript", level > 72 ? "voice captured" : "listening");
  setText("response", level > 72 ? "ready to reply" : "waiting for command");
}

async function refreshHardware() {
  try {
    const snapshot = await window.VibeBoardHardware.getSnapshot();
    const data = snapshot.status || {};
    const program = snapshot.program || {};
    const service = data.services || {};
    const network = data.network || {};
    setText("service", service.display || service.ssh || "Linux API ready");
    setText("eventLog", program.runtime || ("build " + BUILD_ID.slice(0, 12)));
    setText("wifi", network.wifi || "ready");
    setText("ip", (network.addresses && network.addresses[0]) || "--C");
    setText("temp", data.cpu_temp == null ? "--C" : data.cpu_temp + "°C");
    setText("memory", data.memory ? Number(data.memory.percent || 0).toFixed(1) + "%" : "--C");
    setText("load", data.loadavg || "0.18");
    setText("runtime", program.runtime || "executed");
    setText("serviceState", service.display || "active");
  } catch {
    setText("service", "offline preview");
    setText("eventLog", "local cinematic mode");
    setText("wifi", "local");
    setText("ip", "preview");
    setText("temp", "42°C");
    setText("memory", "36%");
    setText("load", "0.18");
    setText("runtime", "simulated");
    setText("serviceState", "active");
  }
}

async function handleAction(action, button) {
  if (action === "primary") {
    if (SPEC.mode === "voice") {
      const result = await window.VibeBoardHardware.audio.record({ duration: 8 });
      setText("level", result.mode === "offline-simulated" ? "simulated" : "recording");
      setText("transcript", "录音中");
      setText("eventLog", result.message || "microphone recording");
    } else {
      setText("eventLog", "command pulse accepted");
      setText("switchA", "on");
    }
  }
  if (action === "secondary") {
    if (SPEC.mode === "voice") {
      const result = await window.VibeBoardHardware.audio.stop();
      setText("level", "ready");
      setText("transcript", "录音已停止");
      setText("eventLog", result.message || "audio stopped");
    } else {
      setText("eventLog", "secondary command toggled");
      setText("switchB", "on");
    }
    if (SPEC.mode === "timer") {
      secondsLeft = 25 * 60;
      tickTimer();
    }
  }
  if (action === "refresh") {
    if (SPEC.mode === "voice") {
      const result = await window.VibeBoardHardware.audio.play();
      setText("response", result.message || "speaker playback");
      setText("eventLog", result.mode === "offline-simulated" ? "simulated playback" : "speaker playback");
    } else {
      refreshHardware();
    }
  }
  if (button) button.classList.toggle("active");
}

document.querySelectorAll(".action").forEach(button => {
  button.addEventListener("click", () => handleAction(button.dataset.action, button));
});

drawClock();
tickTimer();
animateVoice();
refreshHardware();
setInterval(drawClock, 1000);
setInterval(tickTimer, 1000);
setInterval(animateVoice, 1300);
setInterval(refreshHardware, 5000);
console.log("VibeBoard advanced preview ready", BUILD_ID, PROMPT);
`;

  return {
    "index.html": index,
    "style.css": style,
    "app.js": app
  };
}
export function generatedIndexV2(prompt, id, spec = createAppSpec(prompt, id)) {
  if (spec.mode === "clock") {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VibeBoard Clock</title>
  <link rel="stylesheet" href="./style.css?v=${id}">
</head>
<body>
  <main class="screen clock-screen" data-mode="clock">
    <section class="clock-face" aria-label="fullscreen clock">
      <span id="date">--</span>
      <strong id="time">--:--</strong>
      <small id="seconds">--</small>
    </section>
    <footer>
      <span id="service">Linux API --</span>
      <span id="eventLog">waiting</span>
      <button class="action" type="button" data-action="refresh">Sync</button>
    </footer>
  </main>
  <script src="./app.js?v=${id}"></script>
</body>
</html>
`;
  }

  if (spec.mode === "carousel") {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VibeBoard Carousel</title>
  <link rel="stylesheet" href="./style.css?v=${id}">
</head>
<body>
  <main class="screen carousel-screen" data-mode="carousel">
    <section class="slide-stage" aria-label="image carousel">
      <div class="slide active" data-slide="0"><span>01</span><strong>晨光</strong></div>
      <div class="slide" data-slide="1"><span>02</span><strong>城市</strong></div>
      <div class="slide" data-slide="2"><span>03</span><strong>山海</strong></div>
      <div class="slide" data-slide="3"><span>04</span><strong>夜色</strong></div>
    </section>
    <section class="carousel-meta">
      <div>
        <span id="slide">1/4</span>
        <strong id="caption">晨光</strong>
      </div>
      <small id="eventLog">auto playing</small>
    </section>
    <footer>
      <button class="action" type="button" data-action="previous">Prev</button>
      <span id="service">Linux API --</span>
      <button class="action" type="button" data-action="next">Next</button>
    </footer>
  </main>
  <script src="./app.js?v=${id}"></script>
</body>
</html>
`;
  }

  if (spec.mode === "weather") {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VibeBoard App</title>
  <link rel="stylesheet" href="./style.css?v=${id}">
</head>
<body>
  <main class="screen" data-mode="assistant">
    <header class="top">
      <div>
        <span id="date">--</span>
        <strong>${htmlEscape(spec.title)}</strong>
      </div>
      <b id="service">同步中</b>
    </header>

    <section class="time-panel" aria-label="time">
      <span id="time">--:--</span>
      <small id="seconds">--</small>
    </section>

    <section class="weather-panel" aria-label="weather">
      <div>
        <span>今日天气</span>
        <strong id="weatherText">天气同步中</strong>
        <small id="weatherMeta">深圳</small>
      </div>
      <b id="weatherTemp">--°C</b>
    </section>

    <section class="status-grid">
      <article><span>Wi-Fi</span><strong id="wifi">--</strong></article>
      <article><span>板端温度</span><strong id="temp">--</strong></article>
      <article><span>内存</span><strong id="memory">--</strong></article>
      <article><span>IP</span><strong id="ip">--</strong></article>
    </section>

    <footer>
      <button class="action" type="button" data-action="refresh">刷新</button>
      <span id="eventLog">等待硬件 API</span>
      <span>${id}</span>
    </footer>
  </main>
  <script src="./app.js?v=${id}"></script>
</body>
</html>
`;
  }

  const widgets = spec.widgets.map(widget => (
    `<article class="widget" data-widget="${htmlEscape(widget.id)}"><span>${htmlEscape(widget.label)}</span><strong id="${htmlEscape(widget.id)}">${htmlEscape(widget.value)}</strong><small>${htmlEscape(widget.hint)}</small></article>`
  )).join("\n      ");
  const actions = spec.actions.map(action => (
    `<button class="action" type="button" data-action="${htmlEscape(action.id)}">${htmlEscape(action.label)}</button>`
  )).join("\n        ");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VibeBoard App</title>
  <link rel="stylesheet" href="./style.css?v=${id}">
</head>
<body>
  <main class="screen" data-mode="${htmlEscape(spec.mode)}">
    <header class="top">
      <div>
        <span id="date">--</span>
        <strong id="time">--:--</strong>
      </div>
      <b>${htmlEscape(spec.mode)}</b>
    </header>
    <section class="hero">
      <span>Generated Linux web app</span>
      <h1>${htmlEscape(spec.title)}</h1>
      <p>${htmlEscape(spec.subtitle)}</p>
    </section>
    <section class="widgets">
      ${widgets}
    </section>
    <section class="actions">
      <div>
        ${actions}
      </div>
      <small id="eventLog">hardware api waiting</small>
    </section>
    <footer><span id="service">Linux API --</span><span>${id}</span></footer>
  </main>
  <script src="./app.js?v=${id}"></script>
</body>
</html>
`;
}

export function generatedStyleV2(prompt = "", id = "preview", spec = createAppSpec(prompt, id)) {
  if (spec.mode === "clock") {
    return `:root {
  color-scheme: dark;
  --bg: #05070b;
  --panel: rgba(255, 255, 255, .08);
  --line: rgba(255, 255, 255, .16);
  --text: #f8fafc;
  --muted: #94a3b8;
  --accent: #38bdf8;
}

* { box-sizing: border-box; }

html, body {
  width: 480px;
  height: 360px;
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", "Noto Sans SC", system-ui, sans-serif;
}

button { font: inherit; }

.screen {
  width: 480px;
  height: 360px;
  display: grid;
  grid-template-rows: 1fr 42px;
  gap: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at 22% 20%, rgba(56, 189, 248, .22), transparent 28%),
    linear-gradient(135deg, #05070b 0%, #111827 52%, #020617 100%);
}

.clock-face {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: 42px 172px 48px;
  align-content: center;
  justify-items: center;
  padding: 22px 18px 10px;
}

.clock-face span,
.clock-face small,
footer {
  color: var(--muted);
  font-size: 16px;
  line-height: 1.2;
  letter-spacing: 0;
}

.clock-face strong {
  overflow: hidden;
  max-width: 456px;
  color: var(--text);
  font-family: Consolas, "Segoe UI", monospace;
  font-size: 118px;
  font-weight: 900;
  line-height: .92;
  letter-spacing: 0;
  text-align: center;
  white-space: nowrap;
}

.clock-face small {
  min-width: 78px;
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--accent);
  background: var(--panel);
  font-family: Consolas, monospace;
  font-size: 28px;
  font-weight: 800;
  text-align: center;
}

footer {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 150px 1fr 74px;
  gap: 8px;
  align-items: center;
  padding: 7px 10px;
  border-top: 1px solid var(--line);
  background: rgba(2, 6, 23, .72);
  white-space: nowrap;
}

footer span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.action {
  min-width: 0;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--text);
  background: rgba(56, 189, 248, .16);
  font-size: 12px;
  font-weight: 800;
}
`;
  }

  if (spec.mode === "carousel") {
    return `:root {
  color-scheme: dark;
  --bg: #111827;
  --line: rgba(255, 255, 255, .18);
  --text: #f8fafc;
  --muted: #cbd5e1;
  --accent: #fb7185;
}

* { box-sizing: border-box; }

html, body {
  width: 480px;
  height: 360px;
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", "Noto Sans SC", system-ui, sans-serif;
}

button { font: inherit; }

.screen {
  width: 480px;
  height: 360px;
  display: grid;
  grid-template-rows: 248px 58px 54px;
  overflow: hidden;
  background: #111827;
}

.slide-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #0f172a;
}

.slide {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 0;
  transform: scale(1.02);
  transition: opacity .45s ease, transform .45s ease;
}

.slide.active {
  opacity: 1;
  transform: scale(1);
}

.slide::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(145deg, rgba(255, 255, 255, .18), transparent 36%),
    radial-gradient(circle at 20% 72%, rgba(255, 255, 255, .22), transparent 18%),
    radial-gradient(circle at 78% 28%, rgba(255, 255, 255, .2), transparent 16%);
}

.slide[data-slide="0"] { background: linear-gradient(135deg, #0f766e, #f59e0b); }
.slide[data-slide="1"] { background: linear-gradient(135deg, #1d4ed8, #7c3aed); }
.slide[data-slide="2"] { background: linear-gradient(135deg, #166534, #0891b2); }
.slide[data-slide="3"] { background: linear-gradient(135deg, #312e81, #be123c); }

.slide span {
  position: absolute;
  top: 18px;
  left: 20px;
  color: rgba(255, 255, 255, .72);
  font-family: Consolas, monospace;
  font-size: 24px;
  font-weight: 900;
}

.slide strong {
  position: relative;
  max-width: 420px;
  overflow: hidden;
  color: #ffffff;
  font-size: 66px;
  font-weight: 900;
  line-height: 1;
  letter-spacing: 0;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 8px 20px rgba(0, 0, 0, .28);
}

.carousel-meta {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 160px;
  gap: 10px;
  align-items: center;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  background: #111827;
}

.carousel-meta div,
.carousel-meta small {
  min-width: 0;
  overflow: hidden;
}

.carousel-meta span,
.carousel-meta small,
footer {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.2;
}

.carousel-meta strong {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  color: var(--text);
  font-size: 23px;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

footer {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 86px 1fr 86px;
  gap: 9px;
  align-items: center;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  background: #0f172a;
  white-space: nowrap;
}

footer span {
  min-width: 0;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
}

.action {
  min-width: 0;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: #fff;
  background: rgba(251, 113, 133, .28);
  font-size: 12px;
  font-weight: 850;
}
`;
  }

  if (spec.mode === "weather") {
    return `:root {
  color-scheme: light;
  --bg: #ffffff;
  --panel: #f2f7ff;
  --panel-strong: #e5f0ff;
  --line: #b8d4ff;
  --text: #0757b8;
  --muted: #3d78c5;
  --accent: ${spec.accent};
}

* { box-sizing: border-box; }

html, body {
  width: 480px;
  height: 360px;
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", "Noto Sans SC", system-ui, sans-serif;
}

button { font: inherit; }

.screen {
  width: 480px;
  height: 360px;
  display: grid;
  grid-template-rows: 44px 98px 82px 82px 30px;
  gap: 7px;
  padding: 10px;
  background: var(--bg);
}

.top {
  min-width: 0;
  min-height: 0;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.top span,
.weather-panel span,
.weather-panel small,
.status-grid span,
footer {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.2;
}

.top strong {
  display: block;
  margin-top: 2px;
  color: var(--accent);
  font-size: 22px;
  line-height: 1;
  letter-spacing: 0;
}

.top b {
  max-width: 170px;
  min-height: 26px;
  padding: 6px 9px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--accent);
  background: var(--panel);
  font-size: 12px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time-panel {
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-strong);
}

.time-panel span {
  color: var(--accent);
  font-family: Consolas, "Segoe UI", monospace;
  font-size: 70px;
  font-weight: 900;
  line-height: 1;
  letter-spacing: 0;
}

.time-panel small {
  color: var(--muted);
  font-family: Consolas, monospace;
  font-size: 24px;
  font-weight: 800;
}

.weather-panel {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 136px;
  gap: 8px;
  align-items: stretch;
}

.weather-panel > div,
.weather-panel > b,
.status-grid article {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}

.weather-panel > div {
  padding: 10px 12px;
}

.weather-panel strong {
  display: block;
  margin: 4px 0;
  overflow: hidden;
  color: var(--accent);
  font-size: 25px;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.weather-panel > b {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--accent);
  font-family: Consolas, monospace;
  font-size: 31px;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-grid {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 7px;
}

.status-grid article {
  padding: 8px;
}

.status-grid strong {
  display: block;
  margin-top: 6px;
  overflow: hidden;
  color: var(--accent);
  font-size: 16px;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
}

footer {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 70px 1fr 132px;
  gap: 7px;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
}

.action {
  min-width: 0;
  min-height: 28px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  color: #ffffff;
  background: var(--accent);
  font-size: 13px;
  font-weight: 850;
}

footer span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;
  }

  return `:root {
  color-scheme: dark;
  --bg: #10161e;
  --panel: rgba(255, 255, 255, .07);
  --line: rgba(255, 255, 255, .14);
  --text: #f8fafc;
  --muted: #cbd5e1;
  --accent: ${spec.accent};
}

* { box-sizing: border-box; }
html, body {
  width: 480px;
  height: 360px;
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", "Noto Sans SC", system-ui, sans-serif;
}

button { font: inherit; }

.screen {
  width: 480px;
  height: 360px;
  display: grid;
  grid-template-rows: 48px 96px 112px 54px 24px;
  gap: 6px;
  padding: 10px;
  background:
    linear-gradient(145deg, rgba(34, 197, 94, .15), transparent 42%),
    linear-gradient(330deg, rgba(56, 189, 248, .16), transparent 48%),
    #10161e;
}

.top {
  min-width: 0;
  min-height: 0;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.top span, .hero span, .widget span, .widget small, .actions small, footer {
  color: var(--muted);
  font-size: 12px;
}

.top strong {
  display: block;
  margin-top: 2px;
  font-family: Consolas, monospace;
  font-size: 32px;
  line-height: .95;
}

.top b {
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text);
  background: rgba(255, 255, 255, .08);
  font-size: 12px;
  text-transform: uppercase;
}

.hero, .widget {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}

.hero {
  min-width: 0;
  min-height: 0;
  padding: 9px;
}

h1 {
  margin: 4px 0 5px;
  font-size: 22px;
  line-height: 1.12;
  letter-spacing: 0;
}

p {
  margin: 0;
  display: -webkit-box;
  overflow: hidden;
  color: #e2e8f0;
  font-size: 13px;
  line-height: 1.35;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.widgets {
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}

.widget {
  min-width: 0;
  min-height: 0;
  padding: 7px;
}

.widget strong {
  display: block;
  margin: 2px 0 1px;
  overflow: hidden;
  font-size: 17px;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  min-width: 0;
  min-height: 0;
  display: grid;
  gap: 5px;
}

.actions div {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.action {
  min-width: 0;
  min-height: 28px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--text);
  background: #0b1220;
  font-weight: 750;
  font-size: 12px;
}

.action.active {
  border-color: var(--accent);
  box-shadow: 0 0 14px rgba(56, 189, 248, .45);
}

.actions small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

footer {
  min-width: 0;
  min-height: 0;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  overflow: hidden;
  white-space: nowrap;
}
`;
}

export function generatedAppV2(prompt, id, spec = createAppSpec(prompt, id)) {
  const specJson = JSON.stringify(spec);
  const idJson = JSON.stringify(id);
  if (spec.mode === "clock") {
    return `const SPEC = ${specJson};
const PROMPT = SPEC.prompt;
const BUILD_ID = ${idJson};
const el = id => document.getElementById(id);

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
  },
  audio: {
    async status() {
      const res = await fetch("/api/audio/status", { cache: "no-store" });
      if (!res.ok) throw new Error("audio status " + res.status);
      return res.json();
    },
    async play(options = {}) {
      const res = await fetch("/api/audio/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options)
      });
      if (!res.ok) throw new Error("audio play " + res.status);
      return res.json();
    },
    async record(options = {}) {
      const res = await fetch("/api/audio/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options)
      });
      if (!res.ok) throw new Error("audio record " + res.status);
      return res.json();
    },
    async stop(options = {}) {
      const res = await fetch("/api/audio/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options)
      });
      if (!res.ok) throw new Error("audio stop " + res.status);
      return res.json();
    }
  }
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value == null || value === "" ? "--C" : String(value);
}

function drawClock() {
  const now = new Date();
  setText("time", pad(now.getHours()) + ":" + pad(now.getMinutes()));
  setText("seconds", pad(now.getSeconds()));
  setText("date", now.toLocaleDateString("zh-CN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }));
}

async function refresh() {
  try {
    const snapshot = await window.VibeBoardHardware.getSnapshot();
    const data = snapshot.status || {};
    const program = snapshot.program || {};
    const serviceText = data.services ? "SSH " + (data.services.ssh || "--C") + " / FRP " + (data.services.frpc || "--C") : "Linux API ready";
    setText("service", serviceText);
    setText("eventLog", program.runtime || "clock synced");
  } catch (error) {
    setText("service", "Linux API retrying");
    setText("eventLog", "offline clock");
  }
}

document.querySelectorAll(".action").forEach(button => {
  button.addEventListener("click", refresh);
});

drawClock();
refresh();
setInterval(drawClock, 1000);
setInterval(refresh, 5000);
console.log("VibeBoard preview ready", BUILD_ID, PROMPT);
`;
  }

  if (spec.mode === "carousel") {
    return `const SPEC = ${specJson};
const PROMPT = SPEC.prompt;
const BUILD_ID = ${idJson};
const el = id => document.getElementById(id);
const slides = Array.from(document.querySelectorAll(".slide"));
const captions = ["晨光", "城市", "山海", "夜色"];
let current = 0;

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
  },
  audio: {
    async status() {
      const res = await fetch("/api/audio/status", { cache: "no-store" });
      if (!res.ok) throw new Error("audio status " + res.status);
      return res.json();
    },
    async play(options = {}) {
      const res = await fetch("/api/audio/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options)
      });
      if (!res.ok) throw new Error("audio play " + res.status);
      return res.json();
    },
    async record(options = {}) {
      const res = await fetch("/api/audio/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options)
      });
      if (!res.ok) throw new Error("audio record " + res.status);
      return res.json();
    },
    async stop(options = {}) {
      const res = await fetch("/api/audio/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options)
      });
      if (!res.ok) throw new Error("audio stop " + res.status);
      return res.json();
    }
  }
};

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value == null || value === "" ? "--C" : String(value);
}

function showSlide(index) {
  if (!slides.length) return;
  current = (index + slides.length) % slides.length;
  slides.forEach((slide, idx) => slide.classList.toggle("active", idx === current));
  setText("slide", String(current + 1) + "/" + String(slides.length));
  setText("caption", captions[current] || "Slide " + String(current + 1));
}

async function refresh() {
  try {
    const snapshot = await window.VibeBoardHardware.getSnapshot();
    const data = snapshot.status || {};
    const program = snapshot.program || {};
    const serviceText = data.services ? "SSH " + (data.services.ssh || "--C") : "Linux API ready";
    setText("service", serviceText);
    setText("eventLog", "build " + (program.build_id || BUILD_ID).slice(0, 10));
  } catch (error) {
    setText("service", "Linux API retrying");
    setText("eventLog", "local slideshow");
  }
}

function handleAction(action) {
  if (action === "previous") showSlide(current - 1);
  if (action === "next") showSlide(current + 1);
  if (action === "refresh") refresh();
}

document.querySelectorAll(".action").forEach(button => {
  button.addEventListener("click", () => handleAction(button.dataset.action));
});

showSlide(0);
refresh();
setInterval(() => showSlide(current + 1), 3000);
setInterval(refresh, 5000);
console.log("VibeBoard preview ready", BUILD_ID, PROMPT);
`;
  }

  if (spec.mode === "weather") {
    return `const SPEC = ${specJson};
const PROMPT = SPEC.prompt;
const BUILD_ID = ${idJson};
const el = id => document.getElementById(id);

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
  if (node) node.textContent = value == null || value === "" ? "--C" : String(value);
}

function drawClock() {
  const now = new Date();
  setText("time", pad(now.getHours()) + ":" + pad(now.getMinutes()));
  setText("seconds", pad(now.getSeconds()));
  setText("date", now.toLocaleDateString("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }));
}

const weatherCodeText = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Cloudy",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Dense drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Rain showers",
  81: "Heavy showers",
  82: "Violent showers",
  95: "Thunderstorm"
};
async function refreshWeather() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  setText("weatherText", "大部晴朗");
  setText("weatherTemp", "32C");
  setText("weatherMeta", "深圳参考天气");
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=22.5431&longitude=114.0579&current=temperature_2m,weather_code&timezone=Asia%2FShanghai";
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error("weather " + res.status);
    const data = await res.json();
    const current = data.current || {};
    const code = Number(current.weather_code);
    const temp = Number(current.temperature_2m);
    setText("weatherText", weatherCodeText[code] || "天气已同步");
    setText("weatherTemp", Number.isFinite(temp) ? Math.round(temp) + "C" : "--C");
    setText("weatherMeta", "深圳实时天气");
  } catch (error) {
    setText("weatherText", "大部晴朗");
    setText("weatherTemp", "32C");
    setText("weatherMeta", "深圳参考天气");
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshHardware() {
  try {
    const snapshot = await window.VibeBoardHardware.getSnapshot();
    const data = snapshot.status || {};
    const program = snapshot.program || {};
    const ip = (data.network && data.network.addresses && data.network.addresses[0]) || "--C";
    setText("wifi", (data.network && data.network.wifi) || "未连接");
    setText("ip", ip);
    setText("temp", data.cpu_temp == null ? "--C" : data.cpu_temp + "°C");
    setText("memory", data.memory ? Number(data.memory.percent || 0).toFixed(1) + "%" : "--C");
    setText("service", data.services && data.services.display || "online");
    setText("eventLog", "API " + (program.runtime || "ready"));
  } catch (error) {
    setText("service", "重连中");
    setText("eventLog", "硬件 API 重试中");
    setText("ip", "waiting");
  }
}

async function refreshAll() {
  await Promise.allSettled([refreshWeather(), refreshHardware()]);
}

document.querySelectorAll(".action").forEach(button => {
  button.addEventListener("click", refreshAll);
});

drawClock();
refreshAll();
setInterval(drawClock, 1000);
setInterval(refreshHardware, 5000);
setInterval(refreshWeather, 600000);
console.log("VibeBoard preview ready", BUILD_ID, PROMPT);
`;
  }

  return `const SPEC = ${specJson};
const PROMPT = SPEC.prompt;
const BUILD_ID = ${idJson};
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
  if (node) node.textContent = value == null || value === "" ? "--C" : String(value);
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
    const ip = (data.network && data.network.addresses && data.network.addresses[0]) || "--C";
    setText("wifi", (data.network && data.network.wifi) || "offline");
    setText("ip", ip);
    setText("temp", data.cpu_temp == null ? "--C" : data.cpu_temp + "°C");
    setText("memory", data.memory ? Number(data.memory.percent || 0).toFixed(1) + "%" : "--C");
    setText("runtime", program.runtime || "waiting");
    setText("load", program.loadavg || "--C");
    setText("serviceState", data.services && data.services.display || "--C");
    setText("eventLog", "api ok " + new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    const serviceText = data.services ? "SSH " + (data.services.ssh || "--C") + " / FRP " + (data.services.frpc || "--C") : "Linux API ready";
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
console.log("VibeBoard preview ready", BUILD_ID, PROMPT);
`;
}

export function generatedHardwareAppV2(prompt, id, spec = createAppSpec(prompt, id)) {
  const promptJson = JSON.stringify(prompt);
  const idJson = JSON.stringify(id);
  const specJson = JSON.stringify(spec);
  return `#!/usr/bin/env python3
import glob
import json
import os
import os
import platform
import shutil
import socket
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass

BUILD_ID = ${idJson}
PROMPT = ${promptJson}
SPEC = ${specJson}

def read_first(path, default=""):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.readline().strip()
    except OSError:
        return default

def cpu_temp_c():
    raw = read_first("/sys/class/thermal/thermal_zone0/temp")
    try:
        value = float(raw)
        return round(value / 1000, 1) if value > 200 else round(value, 1)
    except ValueError:
        return None

def mem_available_kb():
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return None

def network_interfaces():
    items = []
    for path in glob.glob("/sys/class/net/*/operstate"):
        name = path.split("/")[-2]
        state = read_first(path, "unknown")
        if name != "lo":
            items.append({"name": name, "state": state})
    return items

def disk_percent():
    try:
        usage = shutil.disk_usage("/")
        return round((usage.used / usage.total) * 100, 1)
    except OSError:
        return None

result = {
    "app": "vibeboard-hardware-app",
    "build_id": BUILD_ID,
    "compile": "py_compile_ok",
    "runtime": os.environ.get("VIBEBOARD_RUNTIME", "simulated"),
    "prompt": PROMPT,
    "spec": SPEC,
    "hostname": socket.gethostname(),
    "platform": platform.platform(),
    "time": int(time.time()),
    "cpu_temp_c": cpu_temp_c(),
    "mem_available_kb": mem_available_kb(),
    "disk_percent": disk_percent(),
    "network": network_interfaces(),
    "loadavg": read_first("/proc/loadavg"),
    "cwd": os.getcwd(),
    "available_apis": ["/api/status", "./hardware-result.json", "/api/audio/status", "/api/audio/play", "/api/audio/record", "/api/audio/stop"]
}

print(json.dumps(result, ensure_ascii=False, sort_keys=True))
`;
}

function generatedManifestV2(prompt, id, spec = createAppSpec(prompt, id), extra = {}) {
  return {
    id,
    prompt: spec.prompt || prompt,
    generator: "vibeboard-web-coding-v2",
    mode: spec.mode,
    title: spec.title,
    target: spec.target,
    hardwareApi: spec.hardwareApi,
    files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"],
    createdAt: new Date().toISOString(),
    ...extra
  };
}
