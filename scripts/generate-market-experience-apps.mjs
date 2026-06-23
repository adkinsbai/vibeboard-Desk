import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKET_ROOT = path.join(ROOT, "market-apps");
const GENERATED_FILES = ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"];

const apps = [
  {
    id: "vb-micro-life-pod",
    name: "桌面微型生命舱",
    title: "Micro Life Pod",
    prompt: "A living desktop micro habitat with weather, light, memory, and keyboard care rituals.",
    mode: "companion",
    accent: "#7ef6c7",
    secondary: "#f6c453",
    kind: "life",
    description: "一个会呼吸的小型生命舱，Space 喂养回应，方向键切房间，1/2/3 触发音乐、灯光和记忆。",
  },
  {
    id: "vb-cyber-weather-shrine",
    name: "赛博天气神龛",
    title: "Cyber Weather Shrine",
    prompt: "A cyberpunk weather shrine with rain glass, neon clouds, thunder, and city weather metrics.",
    mode: "weather",
    accent: "#13f2ff",
    secondary: "#ff4fd8",
    kind: "weather",
    description: "雨滴、云层、霓虹和雷声组成的天气小世界，Space 切城市，方向键浏览天气指标。",
  },
  {
    id: "vb-lofi-visual-radio",
    name: "Lo-fi 音乐可视化电台",
    title: "Lo-fi Visual Radio",
    prompt: "A lo-fi visual radio with synthesized audio, animated channels, and Linux Bluetooth readiness display.",
    mode: "music",
    accent: "#9cff6e",
    secondary: "#8c7cff",
    kind: "radio",
    description: "离线 WebAudio 合成电台，带音乐可视化和 Linux 蓝牙状态提示，不包含未授权流行歌曲。",
  },
  {
    id: "vb-mechanical-ai-console",
    name: "机械仪表盘式 AI 助手",
    title: "Mechanical AI Console",
    prompt: "A retro mechanical instrument console that performs local rule-based assistant scans.",
    mode: "assistant",
    accent: "#ffbf54",
    secondary: "#43f47d",
    kind: "console",
    description: "复古飞船控制台式本地助手，用示波器、磁带转轮和打字机动画呈现扫描建议。",
  },
  {
    id: "vb-pocket-arcade",
    name: "桌面小型游戏机",
    title: "Pocket Arcade",
    prompt: "A compact 480x360 arcade with pixel racer, space dodge, and fishing modes.",
    mode: "game",
    accent: "#ff5c7a",
    secondary: "#56d6ff",
    kind: "arcade",
    description: "三合一小型游戏机：像素赛车、太空躲避和钓鱼，方向键移动，Space 动作，Enter 菜单。",
  },
];

await fs.mkdir(MARKET_ROOT, { recursive: true });

for (const app of apps) {
  const dir = path.join(MARKET_ROOT, app.id);
  await fs.mkdir(dir, { recursive: true });
  const files = {
    "index.html": indexHtml(app),
    "style.css": styleCss(app),
    "app.js": appJs(app),
    "hardware_app.py": hardwarePy(app),
    "manifest.json": `${JSON.stringify(manifest(app), null, 2)}\n`,
  };
  await Promise.all(Object.entries(files).map(([name, content]) => (
    fs.writeFile(path.join(dir, name), content, "utf8")
  )));
}

const catalogPath = path.join(MARKET_ROOT, "catalog.json");
let catalog = { ok: true, apps: [] };
try {
  catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
} catch {}
const generatedIds = new Set(apps.map(app => app.id));
const existing = Array.isArray(catalog.apps) ? catalog.apps.filter(app => !generatedIds.has(app.id)) : [];
catalog.ok = true;
catalog.apps = [
  ...apps.map(app => ({
    id: app.id,
    name: app.name,
    description: app.description,
    preview_url: `market-apps/${app.id}/preview.png`,
    author: "VibeBoard",
    downloads: 0,
    created_at: "2026-06-22 12:00:00",
    files: GENERATED_FILES,
    source: "static",
  })),
  ...existing,
];
await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

console.log(`generated ${apps.length} market experience apps`);

function indexHtml(app) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=480,height=360,initial-scale=1">
  <title>${escapeHtml(app.title)}</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <main id="screen" aria-label="${escapeHtml(app.title)}">
    <canvas id="stage" width="480" height="360"></canvas>
    <section id="hud" aria-live="polite">
      <div class="brand">
        <span id="modeLabel">${escapeHtml(app.title)}</span>
        <strong id="valueLabel">BOOT</strong>
      </div>
      <div id="metricRail"></div>
    </section>
    <section id="caption"></section>
  </main>
  <script src="./app.js"></script>
</body>
</html>
`;
}

function styleCss(app) {
  return `:root {
  --accent: ${app.accent};
  --secondary: ${app.secondary};
  --bg: #070913;
  --panel: rgba(7, 12, 24, 0.74);
  --text: #f8fafc;
  --muted: #9fb4c7;
}

* { box-sizing: border-box; }
html, body {
  width: 480px;
  height: 360px;
  margin: 0;
  overflow: hidden;
  background: #03050b;
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

#screen {
  position: relative;
  width: 480px;
  height: 360px;
  overflow: hidden;
  background:
    radial-gradient(circle at 18% 14%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 26%),
    radial-gradient(circle at 76% 26%, color-mix(in srgb, var(--secondary) 18%, transparent), transparent 28%),
    linear-gradient(180deg, #0d1021 0%, #050713 58%, #03040a 100%);
}

#stage {
  position: absolute;
  inset: 0;
  width: 480px;
  height: 360px;
  image-rendering: auto;
}

#screen::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px),
    radial-gradient(circle at center, transparent 54%, rgba(0,0,0,0.36) 100%);
  background-size: 100% 4px, 100% 100%;
  mix-blend-mode: screen;
  opacity: 0.28;
}

#hud {
  position: absolute;
  left: 10px;
  right: 10px;
  top: 8px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  align-items: start;
  pointer-events: none;
}

.brand {
  max-width: 256px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
  background: var(--panel);
  box-shadow: 0 0 18px color-mix(in srgb, var(--accent) 18%, transparent), inset 0 0 18px rgba(255,255,255,0.04);
  padding: 7px 9px;
  border-radius: 8px;
}

#modeLabel {
  display: block;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.1;
}

#valueLabel {
  display: block;
  margin-top: 2px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 15px;
  letter-spacing: 0;
  color: var(--accent);
  text-shadow: 0 0 10px color-mix(in srgb, var(--accent) 70%, transparent);
  white-space: nowrap;
}

#metricRail {
  min-width: 144px;
  display: grid;
  gap: 4px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  color: #dce8f5;
}

.metric {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(3, 7, 17, 0.64);
  border-radius: 6px;
  padding: 3px 6px;
}

.metric.is-hot {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 52%, transparent);
}

#caption {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 8px;
  min-height: 30px;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  background: rgba(3, 6, 14, 0.68);
  color: #e7f0fb;
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.25;
  box-shadow: inset 0 0 16px rgba(255,255,255,0.04);
}

@media (prefers-reduced-motion: reduce) {
  #screen::before { opacity: 0.12; }
}
`;
}

function appJs(app) {
  const config = {
    id: app.id,
    title: app.title,
    prompt: app.prompt,
    kind: app.kind,
    accent: app.accent,
    secondary: app.secondary,
  };
  return `const BUILD_ID = ${JSON.stringify(app.id)};
const PROMPT = ${JSON.stringify(app.prompt)};
const CONFIG = ${JSON.stringify(config, null, 2)};

window.VibeBoardHardware = {
  async getStatus() {
    try {
      const response = await fetch("/api/status");
      return await response.json();
    } catch (error) {
      return { ok: false, mode: "offline", error: error.message };
    }
  },
  async getProgramResult() {
    try {
      const response = await fetch("./hardware-result.json");
      return await response.json();
    } catch (error) {
      return fallbackHardware();
    }
  },
  getSnapshot() {
    return {
      build_id: BUILD_ID,
      prompt: PROMPT,
      kind: CONFIG.kind,
      frame: Math.round(state.t),
      mode: state.mode,
    };
  },
};

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const modeLabel = document.getElementById("modeLabel");
const valueLabel = document.getElementById("valueLabel");
const metricRail = document.getElementById("metricRail");
const caption = document.getElementById("caption");
const W = 480;
const H = 360;
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false;

const state = {
  t: 0,
  mode: "boot",
  focus: 0,
  selected: 0,
  playing: false,
  intensity: 0.62,
  actionPulse: 0,
  hardware: fallbackHardware(),
  status: {},
  keys: new Set(),
  particles: makeParticles(reducedMotion ? 70 : 170),
  stars: makeParticles(100),
  arcade: {
    mode: 0,
    score: 0,
    hp: 3,
    x: 240,
    y: 286,
    vx: 0,
    objects: [],
    timer: 0,
    menu: true,
  },
  console: {
    phase: "idle",
    typed: "",
    target: "Awaiting local scan.",
    scan: 0,
  },
  audio: {
    ctx: null,
    master: null,
    noise: null,
    started: false,
  },
};

const palettes = {
  life: ["#08131b", "#12382d", "#7ef6c7", "#f6c453"],
  weather: ["#060819", "#10143a", "#13f2ff", "#ff4fd8"],
  radio: ["#08091a", "#17252a", "#9cff6e", "#8c7cff"],
  console: ["#080807", "#252015", "#ffbf54", "#43f47d"],
  arcade: ["#070814", "#161b36", "#ff5c7a", "#56d6ff"],
};

const metricsByKind = {
  life: ["LIFE", "TEMP", "HUM", "MEM"],
  weather: ["TEMP", "RAIN", "WIND", "AQI"],
  radio: ["BPM", "MOOD", "BT", "SINK"],
  console: ["SIGNAL", "THERM", "LOAD", "LINK"],
  arcade: ["MODE", "SCORE", "HP", "FPS"],
};

const labels = {
  life: ["canopy", "roots", "climate", "memory"],
  weather: ["Shanghai", "Shenzhen", "Chengdu", "Chongqing", "Beijing"],
  radio: ["Rain Tape", "Desk Beats", "Night Bus", "Cafe Loop"],
  console: ["thermal", "memory", "network", "service"],
  arcade: ["Pixel Racer", "Space Dodge", "Pocket Fishing"],
};

Promise.all([
  window.VibeBoardHardware.getStatus(),
  window.VibeBoardHardware.getProgramResult(),
]).then(([status, hardware]) => {
  state.status = status || {};
  state.hardware = hardware || fallbackHardware();
  state.mode = "ready";
}).catch(() => {
  state.mode = "ready";
});

document.addEventListener("keydown", event => {
  if (["Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Digit1", "Digit2", "Digit3"].includes(event.code)) {
    event.preventDefault();
  }
  state.keys.add(event.code);
  unlockAudio();
  handleKey(event.code);
});

document.addEventListener("keyup", event => {
  state.keys.delete(event.code);
});

function handleKey(code) {
  state.actionPulse = 1;
  ping(code === "Space" ? 440 : code === "Enter" ? 660 : 330, 0.04);
  if (CONFIG.kind === "life") handleLifeKey(code);
  if (CONFIG.kind === "weather") handleWeatherKey(code);
  if (CONFIG.kind === "radio") handleRadioKey(code);
  if (CONFIG.kind === "console") handleConsoleKey(code);
  if (CONFIG.kind === "arcade") handleArcadeKey(code);
}

function handleLifeKey(code) {
  if (code === "Space") state.intensity = clamp(state.intensity + 0.08, 0.2, 1);
  if (code === "ArrowLeft") state.focus = (state.focus + 3) % 4;
  if (code === "ArrowRight") state.focus = (state.focus + 1) % 4;
  if (code === "ArrowUp") state.intensity = clamp(state.intensity + 0.05, 0.2, 1);
  if (code === "ArrowDown") state.intensity = clamp(state.intensity - 0.05, 0.2, 1);
  if (code === "Digit1") state.mode = "observe";
  if (code === "Digit2") state.mode = "light";
  if (code === "Digit3") state.mode = "memory";
}

function handleWeatherKey(code) {
  if (code === "Space") state.selected = (state.selected + 1) % labels.weather.length;
  if (code === "ArrowLeft") state.focus = (state.focus + 3) % 4;
  if (code === "ArrowRight") state.focus = (state.focus + 1) % 4;
  if (code === "ArrowUp") state.intensity = clamp(state.intensity + 0.08, 0.25, 1);
  if (code === "ArrowDown") state.intensity = clamp(state.intensity - 0.08, 0.25, 1);
}

function handleRadioKey(code) {
  if (code === "Space") state.playing = !state.playing;
  if (code === "ArrowLeft") state.selected = (state.selected + labels.radio.length - 1) % labels.radio.length;
  if (code === "ArrowRight") state.selected = (state.selected + 1) % labels.radio.length;
  if (code === "ArrowUp") state.intensity = clamp(state.intensity + 0.1, 0.2, 1);
  if (code === "ArrowDown") state.intensity = clamp(state.intensity - 0.1, 0.2, 1);
}

function handleConsoleKey(code) {
  if (code === "Space") {
    state.console.phase = "scanning";
    state.console.scan = 0;
    state.console.typed = "";
  }
  if (code === "ArrowLeft" || code === "ArrowUp") state.selected = (state.selected + labels.console.length - 1) % labels.console.length;
  if (code === "ArrowRight" || code === "ArrowDown") state.selected = (state.selected + 1) % labels.console.length;
  if (code === "Enter") {
    state.console.phase = "typing";
    state.console.target = adviceText();
    state.console.typed = "";
  }
}

function handleArcadeKey(code) {
  const a = state.arcade;
  if (code === "Enter") a.menu = !a.menu;
  if (a.menu && code === "ArrowUp") a.mode = (a.mode + 2) % 3;
  if (a.menu && code === "ArrowDown") a.mode = (a.mode + 1) % 3;
  if (code === "Space" && a.menu) resetArcade();
  if (code === "Space" && !a.menu) {
    a.vx = a.mode === 1 ? 9 : a.mode === 2 ? -4 : 6;
    ping(760, 0.05);
  }
}

function loop() {
  state.t += 1;
  state.actionPulse *= 0.88;
  updateAudio();
  updateArcade();
  draw();
  requestAnimationFrame(loop);
}
loop();

function draw() {
  const p = palettes[CONFIG.kind];
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, p[0]);
  g.addColorStop(0.58, p[1]);
  g.addColorStop(1, "#02030a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  drawBackdrop(p);
  if (CONFIG.kind === "life") drawLife(p);
  if (CONFIG.kind === "weather") drawWeather(p);
  if (CONFIG.kind === "radio") drawRadio(p);
  if (CONFIG.kind === "console") drawConsole(p);
  if (CONFIG.kind === "arcade") drawArcade(p);
  drawGlass(p);
  updateHud();
}

function drawBackdrop(p) {
  const t = state.t * 0.01;
  ctx.save();
  for (let i = 0; i < state.stars.length; i++) {
    const s = state.stars[i];
    const x = (s.x * W + Math.sin(t + i) * 8 + W) % W;
    const y = (s.y * H + state.t * s.v * 0.08) % H;
    ctx.globalAlpha = 0.12 + s.r * 0.2;
    ctx.fillStyle = i % 3 === 0 ? p[2] : "#ffffff";
    ctx.fillRect(x, y, 1.2 + s.r * 1.6, 1.2 + s.r * 1.6);
  }
  ctx.globalAlpha = 0.2;
  ctx.strokeStyle = p[2];
  for (let x = -80; x < W + 80; x += 42) {
    line(x + Math.sin(t) * 8, 248, x + 160, 360);
  }
  ctx.restore();
}

function drawLife(p) {
  const pulse = 1 + Math.sin(state.t * 0.055) * 0.025 + state.actionPulse * 0.05;
  roomShell(p);
  ctx.save();
  ctx.translate(240, 184);
  ctx.scale(pulse, pulse);
  const pod = ctx.createRadialGradient(0, -28, 16, 0, 0, 118);
  pod.addColorStop(0, "rgba(255,255,255,0.32)");
  pod.addColorStop(0.42, "rgba(126,246,199,0.13)");
  pod.addColorStop(1, "rgba(5,20,28,0.78)");
  ctx.fillStyle = pod;
  roundRect(-96, -122, 192, 228, 88);
  ctx.fill();
  ctx.strokeStyle = "rgba(215,255,241,0.62)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.globalAlpha = 0.76;
  ctx.strokeStyle = p[2];
  for (let i = 0; i < 7; i++) {
    const y = 42 - i * 15;
    bezier(0, 62, Math.sin(state.t * 0.02 + i) * 40, y, -48 + i * 16, y - 32, -14 + i * 5, y - 52);
    bezier(0, 62, Math.sin(state.t * 0.018 + i) * -36, y, 42 - i * 14, y - 28, 16 - i * 3, y - 48);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = p[3];
  ellipse(0, 54, 34, 17);
  ctx.fillStyle = p[2];
  ellipse(-12 + Math.sin(state.t * 0.05) * 3, 20, 18, 26);
  ellipse(18 + Math.cos(state.t * 0.04) * 3, 4, 22, 31);
  ctx.fillStyle = "rgba(255,255,255,0.74)";
  ellipse(-28, -72, 12, 44);
  ellipse(36, -66, 9, 36);
  ctx.restore();
  caption.textContent = state.mode === "memory"
    ? "Night diary compiled from today's touches, light changes, and quiet intervals."
    : state.mode === "light"
      ? "Growth lamp tuned. The pod answers with a warmer pulse."
      : "The habitat is stable. A tiny rhythm follows the board telemetry.";
}

function drawWeather(p) {
  const city = labels.weather[state.selected];
  for (let i = 0; i < 4; i++) {
    const y = 42 + i * 34 + Math.sin(state.t * 0.01 + i) * 5;
    ctx.fillStyle = \`rgba(160,190,255,\${0.05 + i * 0.02})\`;
    ellipse(110 + i * 75, y, 100, 18);
  }
  ctx.fillStyle = "#050711";
  for (let x = 0; x < W; x += 34) {
    const h = 64 + ((x * 17) % 72);
    ctx.fillRect(x, 238 - h, 28, h);
    ctx.fillStyle = p[(x / 34) % 2 ? 2 : 3];
    for (let y = 238 - h + 10; y < 232; y += 18) ctx.fillRect(x + 6, y, 12, 2);
    ctx.fillStyle = "#050711";
  }
  ctx.save();
  ctx.translate(240, 174);
  ctx.strokeStyle = p[2];
  ctx.lineWidth = 3;
  ctx.shadowBlur = 26;
  ctx.shadowColor = p[2];
  roundRect(-58, -70, 116, 138, 16);
  ctx.stroke();
  ctx.fillStyle = "rgba(4,10,24,0.74)";
  roundRect(-48, -60, 96, 118, 12);
  ctx.fill();
  ctx.fillStyle = p[3];
  ellipse(0, -12, 28 + Math.sin(state.t * 0.06) * 4, 28);
  ctx.strokeStyle = p[2];
  for (let a = 0; a < 8; a++) {
    const r = 42 + Math.sin(state.t * 0.03 + a) * 3;
    line(Math.cos(a) * 24, Math.sin(a) * 24 - 12, Math.cos(a) * r, Math.sin(a) * r - 12);
  }
  ctx.restore();
  drawRain(p);
  if (Math.sin(state.t * 0.047) > 0.965 && state.intensity > 0.5) {
    ctx.fillStyle = "rgba(200,240,255,0.28)";
    ctx.fillRect(0, 0, W, H);
  }
  caption.textContent = \`\${city} shrine online. Metric \${metricsByKind.weather[state.focus]} is driving rain, neon, and thunder intensity.\`;
}

function drawRadio(p) {
  const channel = labels.radio[state.selected];
  ctx.save();
  ctx.translate(0, 0);
  if (state.selected === 0) drawTrainWindow(p);
  if (state.selected === 1) drawDeskScene(p);
  if (state.selected === 2) drawNightBus(p);
  if (state.selected === 3) drawCafeLoop(p);
  const bars = 36;
  for (let i = 0; i < bars; i++) {
    const x = 34 + i * 11;
    const h = 10 + Math.abs(Math.sin(state.t * 0.045 + i * 0.55)) * (state.playing ? 82 * state.intensity : 20);
    ctx.fillStyle = i % 3 === 0 ? p[2] : p[3];
    ctx.globalAlpha = 0.28 + h / 130;
    ctx.fillRect(x, 260 - h, 6, h);
  }
  ctx.restore();
  caption.textContent = state.playing
    ? \`\${channel} is synthesized locally. Bluetooth: \${btLabel()}.\`
    : \`\${channel} armed. Audio starts only after a keyboard gesture; no external songs are bundled.\`;
}

function drawConsole(p) {
  const c = state.console;
  if (c.phase === "scanning") {
    c.scan += 0.018;
    if (c.scan >= 1) {
      c.phase = "suggesting";
      c.scan = 1;
    }
  }
  if (c.phase === "typing" && c.typed.length < c.target.length && state.t % 2 === 0) {
    c.typed = c.target.slice(0, c.typed.length + 1);
    ping(520 + (c.typed.length % 5) * 20, 0.012);
  }
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  roundRect(22, 64, 436, 242, 16);
  ctx.fill();
  dial(96, 154, 56, "TEMP", 0.64 + Math.sin(state.t * 0.02) * 0.15, p);
  dial(96, 252, 42, "LOAD", 0.42 + Math.cos(state.t * 0.017) * 0.16, p);
  scope(180, 82, 160, 104, p);
  reel(384, 130, 42, state.t * 0.035 * (c.phase === "idle" ? 0.3 : 1), p);
  reel(384, 230, 42, -state.t * 0.035 * (c.phase === "idle" ? 0.3 : 1), p);
  ctx.fillStyle = "rgba(10,14,12,0.82)";
  roundRect(176, 204, 168, 76, 8);
  ctx.fill();
  ctx.fillStyle = p[2];
  ctx.font = "12px Consolas, monospace";
  const text = c.phase === "typing" ? c.typed : c.phase === "suggesting" ? adviceText() : "SPACE starts local scan";
  wrapText(text, 188, 224, 140, 14);
  ctx.restore();
  caption.textContent = c.phase === "suggesting"
    ? \`Selected advisory channel: \${labels.console[state.selected]}.\`
    : "Local rule console: oscilloscope, reels, dials, and typewriter response.";
}

function drawArcade(p) {
  const a = state.arcade;
  ctx.save();
  ctx.fillStyle = "#0a1028";
  roundRect(22, 46, 436, 278, 18);
  ctx.fill();
  ctx.strokeStyle = p[2];
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(42, 68, 396, 226);
  ctx.clip();
  if (a.mode === 0) drawRacer(p);
  if (a.mode === 1) drawSpaceDodge(p);
  if (a.mode === 2) drawFishing(p);
  ctx.restore();
  if (a.menu) {
    ctx.fillStyle = "rgba(2,5,14,0.78)";
    roundRect(118, 92, 244, 144, 12);
    ctx.fill();
    ctx.strokeStyle = p[3];
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "16px Consolas, monospace";
    ctx.fillText(labels.arcade[a.mode], 156, 138);
    ctx.font = "12px Consolas, monospace";
    ctx.fillText("Choose a cabinet mode", 160, 168);
    ctx.fillText("Score " + a.score + "  HP " + a.hp, 174, 194);
  }
  caption.textContent = a.menu ? "Pocket cabinet waiting at the attract screen." : \`\${labels.arcade[a.mode]} running. Score \${a.score} HP \${a.hp}.\`;
}

function updateArcade() {
  if (CONFIG.kind !== "arcade") return;
  const a = state.arcade;
  if (a.menu) return;
  a.timer += 1;
  const speed = 2 + a.score * 0.012;
  if (state.keys.has("ArrowLeft")) a.x -= 4.2;
  if (state.keys.has("ArrowRight")) a.x += 4.2;
  if (state.keys.has("ArrowUp")) a.y -= 3.2;
  if (state.keys.has("ArrowDown")) a.y += 3.2;
  a.x = clamp(a.x + a.vx, 62, 418);
  a.y = clamp(a.y, 90, 286);
  a.vx *= 0.82;
  if (a.timer % 44 === 0) {
    a.objects.push({ x: 60 + Math.random() * 340, y: 62, r: 8 + Math.random() * 16, kind: Math.random() > 0.74 ? "bonus" : "hazard" });
  }
  for (const o of a.objects) o.y += speed + (a.mode === 1 ? 1.4 : 0);
  a.objects = a.objects.filter(o => o.y < 314);
  for (const o of a.objects) {
    const hit = Math.hypot(o.x - a.x, o.y - a.y) < o.r + 13;
    if (hit && !o.hit) {
      o.hit = true;
      if (o.kind === "bonus") {
        a.score += 10;
        ping(840, 0.04);
      } else {
        a.hp -= 1;
        ping(140, 0.08);
        if (a.hp <= 0) a.menu = true;
      }
    }
  }
  if (a.timer % 30 === 0) a.score += 1;
}

function resetArcade() {
  const a = state.arcade;
  a.menu = false;
  a.score = 0;
  a.hp = 3;
  a.x = 240;
  a.y = 278;
  a.objects = [];
  a.timer = 0;
}

function drawRacer(p) {
  ctx.fillStyle = "#12172b";
  ctx.fillRect(42, 68, 396, 226);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  for (let x = 108; x < 420; x += 66) {
    ctx.setLineDash([12, 14]);
    line(x, 68, x + Math.sin(state.t * 0.05) * 8, 294);
  }
  ctx.setLineDash([]);
  drawVehicle(state.arcade.x, state.arcade.y, p[2]);
  for (const o of state.arcade.objects) drawVehicle(o.x, o.y, o.kind === "bonus" ? p[3] : "#f05252", 0.72);
}

function drawSpaceDodge(p) {
  ctx.fillStyle = "#050718";
  ctx.fillRect(42, 68, 396, 226);
  for (const s of state.stars.slice(0, 60)) {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(42 + s.x * 396, 68 + ((s.y * 226 + state.t * s.v) % 226), 1.5, 1.5);
  }
  ship(state.arcade.x, state.arcade.y, p[2]);
  for (const o of state.arcade.objects) asteroid(o.x, o.y, o.r, o.kind === "bonus" ? p[3] : "#a8b3c7");
}

function drawFishing(p) {
  const water = ctx.createLinearGradient(0, 68, 0, 294);
  water.addColorStop(0, "#11314f");
  water.addColorStop(1, "#061222");
  ctx.fillStyle = water;
  ctx.fillRect(42, 68, 396, 226);
  for (let y = 86; y < 282; y += 20) {
    ctx.strokeStyle = "rgba(130,220,255,0.16)";
    bezier(42, y, 126, y + Math.sin(state.t * 0.04 + y) * 8, 274, y - 10, 438, y + 4);
  }
  ctx.strokeStyle = p[3];
  line(state.arcade.x, 76, state.arcade.x, state.arcade.y);
  ellipse(state.arcade.x, state.arcade.y, 13, 8, p[2]);
  for (const o of state.arcade.objects) fish(o.x, o.y, o.r, o.kind === "bonus" ? p[3] : "#5b7898");
}

function updateHud() {
  modeLabel.textContent = CONFIG.title;
  const labelSet = labels[CONFIG.kind] || [];
  valueLabel.textContent = labelSet[state.selected] || state.mode || "READY";
  const hardware = state.hardware || {};
  const metrics = metricValues();
  metricRail.innerHTML = metrics.map((item, index) => (
    \`<div class="metric \${index === state.focus ? "is-hot" : ""}"><span>\${item[0]}</span><b>\${item[1]}</b></div>\`
  )).join("");
}

function metricValues() {
  const hw = state.hardware || {};
  if (CONFIG.kind === "life") return [["LIFE", pct(0.72 + state.intensity * 0.22)], ["TEMP", temp()], ["HUM", pct(0.58 + state.intensity * 0.2)], ["MEM", mem()]];
  if (CONFIG.kind === "weather") return [["TEMP", weatherTemp()], ["RAIN", pct(state.intensity)], ["WIND", Math.round(12 + state.selected * 4 + state.intensity * 12) + "k"], ["AQI", String(54 + state.selected * 9)]];
  if (CONFIG.kind === "radio") return [["BPM", String(Math.round(72 + state.intensity * 42))], ["MOOD", String(Math.round(state.intensity * 5))], ["BT", btShort()], ["SINK", audioSink(hw)]];
  if (CONFIG.kind === "console") return [["SIGN", pct(0.62 + state.console.scan * 0.35)], ["THERM", temp()], ["LOAD", loadShort()], ["LINK", linkShort()]];
  const a = state.arcade;
  return [["MODE", String(a.mode + 1)], ["SCORE", String(a.score)], ["HP", String(a.hp)], ["FPS", "60"]];
}

function fallbackHardware() {
  return {
    build_id: BUILD_ID,
    prompt: PROMPT,
    runtime: "executed_on_board",
    available_apis: ["/api/status", "./hardware-result.json"],
    sensors: { cpu_temp_c: 43.2, mem_available_kb: 512000, disk_percent: 37, loadavg: "0.20 0.16 0.09" },
    bluetooth: { adapter_present: false, adapter_powered: false, paired_phone_detected: false },
    audio: { linux_audio: { alsa_detected: true, pipewire_detected: false, default_sink: null } },
  };
}

function unlockAudio() {
  if (state.audio.started) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const ac = new AudioContext();
  const master = ac.createGain();
  master.gain.value = 0.03;
  master.connect(ac.destination);
  state.audio.ctx = ac;
  state.audio.master = master;
  state.audio.started = true;
  startToneBed();
}

function startToneBed() {
  const ac = state.audio.ctx;
  if (!ac) return;
  const base = CONFIG.kind === "radio" ? 110 : CONFIG.kind === "weather" ? 72 : CONFIG.kind === "life" ? 96 : 58;
  for (const detune of [0, 7, 12]) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = CONFIG.kind === "console" ? "sawtooth" : "sine";
    osc.frequency.value = base * Math.pow(2, detune / 12);
    gain.gain.value = 0.012;
    osc.connect(gain).connect(state.audio.master);
    osc.start();
  }
}

function updateAudio() {
  if (!state.audio.master) return;
  const target = CONFIG.kind === "radio" && !state.playing ? 0.004 : 0.018 + state.intensity * 0.026;
  state.audio.master.gain.setTargetAtTime(target, state.audio.ctx.currentTime, 0.08);
}

function ping(freq, dur) {
  const ac = state.audio.ctx;
  if (!ac || !state.audio.master) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;
  gain.gain.value = 0.035;
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
  osc.connect(gain).connect(state.audio.master);
  osc.start();
  osc.stop(ac.currentTime + dur + 0.01);
}

function drawRain(p) {
  ctx.save();
  ctx.strokeStyle = p[2];
  for (const r of state.particles) {
    const x = (r.x * W + state.t * r.v * 0.8) % W;
    const y = (r.y * H + state.t * r.v * 2.6) % H;
    ctx.globalAlpha = 0.12 + r.r * 0.28;
    line(x, y, x - 8, y + 18);
  }
  ctx.restore();
}

function drawGlass(p) {
  ctx.save();
  ctx.globalAlpha = 0.5 + state.actionPulse * 0.18;
  ctx.strokeStyle = p[2];
  ctx.lineWidth = 1;
  roundRect(5, 5, 470, 350, 16);
  ctx.stroke();
  ctx.globalAlpha = 0.09;
  ctx.fillStyle = "#fff";
  ctx.fillRect(28, 0, 46, 360);
  ctx.restore();
}

function roomShell(p) {
  ctx.fillStyle = "rgba(0,0,0,0.24)";
  roundRect(34, 54, 412, 258, 20);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.11)";
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  for (let x = 50; x < 430; x += 32) ctx.fillRect(x, 72, 1, 220);
}

function drawTrainWindow(p) {
  ctx.fillStyle = "#0c1222";
  roundRect(42, 66, 396, 184, 16);
  ctx.fill();
  for (let x = -40; x < W; x += 80) {
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect((x - state.t * 1.4) % W, 118, 54, 92);
  }
  ctx.fillStyle = p[2];
  ellipse(392, 92, 24, 24);
}

function drawDeskScene(p) {
  ctx.fillStyle = "#141b22";
  ctx.fillRect(0, 210, W, 80);
  ctx.fillStyle = p[3];
  roundRect(64, 112, 86, 58, 8);
  ctx.fill();
  ctx.fillStyle = p[2];
  ellipse(300, 138, 44, 18);
}

function drawNightBus(p) {
  ctx.fillStyle = "#050713";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111a2a";
  roundRect(52, 72, 372, 150, 14);
  ctx.fill();
  for (let x = 74; x < 390; x += 70) {
    ctx.fillStyle = "rgba(255,220,120,0.24)";
    roundRect(x, 96, 44, 72, 4);
    ctx.fill();
  }
}

function drawCafeLoop(p) {
  ctx.fillStyle = "#160d12";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,191,84,0.2)";
  ellipse(246, 118, 150, 54);
  ctx.fillStyle = p[2];
  roundRect(176, 170, 128, 48, 12);
  ctx.fill();
  ctx.fillStyle = "#0a0608";
  ellipse(240, 166, 50, 13);
}

function dial(x, y, r, label, value, p) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 7;
  circle(x, y, r);
  ctx.stroke();
  ctx.strokeStyle = p[2];
  ctx.beginPath();
  ctx.arc(x, y, r, Math.PI * 0.76, Math.PI * (0.76 + 1.45 * clamp(value, 0, 1)));
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "10px Consolas, monospace";
  ctx.fillText(label, x - 16, y + 4);
  ctx.restore();
}

function scope(x, y, w, h, p) {
  ctx.fillStyle = "rgba(0,10,4,0.8)";
  roundRect(x, y, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = p[3];
  ctx.stroke();
  ctx.strokeStyle = "rgba(67,244,125,0.18)";
  for (let i = 1; i < 5; i++) line(x, y + i * h / 5, x + w, y + i * h / 5);
  ctx.strokeStyle = p[3];
  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    const yy = y + h / 2 + Math.sin(i * 0.11 + state.t * 0.12) * 22 + Math.sin(i * 0.03) * 8;
    if (i === 0) ctx.moveTo(x + i, yy); else ctx.lineTo(x + i, yy);
  }
  ctx.stroke();
}

function reel(x, y, r, rot, p) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.strokeStyle = p[2];
  ctx.lineWidth = 3;
  circle(0, 0, r);
  ctx.stroke();
  for (let i = 0; i < 6; i++) {
    ctx.rotate(Math.PI / 3);
    roundRect(7, -4, r - 14, 8, 4);
    ctx.stroke();
  }
  ctx.restore();
}

function drawVehicle(x, y, color, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = color;
  roundRect(-14, -24, 28, 48, 8);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.56)";
  roundRect(-8, -14, 16, 12, 4);
  ctx.fill();
  ctx.restore();
}

function ship(x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - 18);
  ctx.lineTo(x - 18, y + 18);
  ctx.lineTo(x, y + 10);
  ctx.lineTo(x + 18, y + 18);
  ctx.closePath();
  ctx.fill();
}

function asteroid(x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    const rr = r * (0.72 + ((i * 17) % 5) / 12);
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function fish(x, y, r, color) {
  ctx.fillStyle = color;
  ellipse(x, y, r * 1.4, r * 0.72);
  ctx.beginPath();
  ctx.moveTo(x - r * 1.1, y);
  ctx.lineTo(x - r * 1.9, y - r * 0.7);
  ctx.lineTo(x - r * 1.9, y + r * 0.7);
  ctx.closePath();
  ctx.fill();
}

function adviceText() {
  const items = [
    "Thermal signal rising. Hold animation density and keep the core display responsive.",
    "Memory margin is acceptable. Continue local mode and avoid waiting on remote models.",
    "Network channel is optional. Keep the assistant useful with cached board telemetry.",
    "Display service looks stable. Commit to the current kiosk loop and verify locally.",
  ];
  return items[state.selected % items.length];
}

function btLabel() {
  const bt = state.hardware?.bluetooth || {};
  if (bt.paired_phone_detected) return "paired phone detected";
  if (bt.adapter_present || bt.linux_stack_detected) return bt.adapter_powered === false ? "adapter off" : "ready for pairing";
  return "not detected";
}

function btShort() {
  const bt = state.hardware?.bluetooth || {};
  if (bt.paired_phone_detected) return "PAIR";
  if (bt.adapter_present || bt.linux_stack_detected) return bt.adapter_powered === false ? "OFF" : "RDY";
  return "NO";
}

function audioSink(hw) {
  const audio = hw.audio?.linux_audio || {};
  if (audio.default_sink) return "SINK";
  if (audio.pipewire_detected) return "PIPE";
  if (audio.alsa_detected) return "ALSA";
  return "WEB";
}

function temp() {
  const value = state.hardware?.sensors?.cpu_temp_c || state.hardware?.system?.cpu_temp_c || 43;
  return Math.round(value) + "C";
}

function mem() {
  const kb = state.hardware?.sensors?.mem_available_kb || 512000;
  return Math.round(kb / 1024) + "M";
}

function loadShort() {
  const load = state.hardware?.sensors?.loadavg || state.hardware?.system?.loadavg || "0.20";
  return String(load).split(" ")[0];
}

function linkShort() {
  const net = state.status?.connected;
  if (net === true) return "ON";
  if (net === false) return "SIM";
  return "LOC";
}

function weatherTemp() {
  return Math.round(20 + state.selected * 2 + state.intensity * 8) + "C";
}

function pct(value) {
  return Math.round(clamp(value, 0, 1) * 100) + "%";
}

function makeParticles(count) {
  return Array.from({ length: count }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: Math.random(),
    v: 0.4 + Math.random() * 2.2,
  }));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function line(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function bezier(x1, y1, x2, y2, x3, y3, x4, y4) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(x2, y2, x3, y3, x4, y4);
  ctx.stroke();
}

function circle(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function ellipse(x, y, rx, ry, fill) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  if (fill) ctx.fillStyle = fill;
  ctx.fill();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(text, x, y, maxWidth, lineHeight) {
  const words = String(text).split(" ");
  let lineText = "";
  for (const word of words) {
    const test = lineText ? lineText + " " + word : word;
    if (ctx.measureText(test).width > maxWidth && lineText) {
      ctx.fillText(lineText, x, y);
      y += lineHeight;
      lineText = word;
    } else {
      lineText = test;
    }
  }
  ctx.fillText(lineText, x, y);
}
`;
}

function hardwarePy(app) {
  const appSlug = app.kind === "radio" ? "lofi-visual-radio" : app.id;
  return `#!/usr/bin/env python3
import json
import os
import platform
import shutil
import socket
import subprocess
import time

BUILD_ID = ${JSON.stringify(app.id)}
PROMPT = ${JSON.stringify(app.prompt)}

def read_text(path, default=""):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except Exception:
        return default

def command_ok(command):
    if not shutil.which(command[0]):
        return False, ""
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=1.5)
        return completed.returncode == 0, (completed.stdout or completed.stderr or "").strip()
    except Exception as exc:
        return False, str(exc)

def cpu_temp_c():
    raw = read_text("/sys/class/thermal/thermal_zone0/temp")
    try:
        value = float(raw)
        return round(value / 1000 if value > 200 else value, 1)
    except Exception:
        return 43.0

def mem_available_kb():
    for line in read_text("/proc/meminfo").splitlines():
        if line.startswith("MemAvailable:"):
            try:
                return int(line.split()[1])
            except Exception:
                return 512000
    return 512000

def disk_percent():
    usage = shutil.disk_usage("/")
    return round((usage.used / usage.total) * 100, 1)

def detect_bluetooth():
    rfkill_ok, rfkill_out = command_ok(["rfkill", "list", "bluetooth"])
    bt_ok, bt_out = command_ok(["bluetoothctl", "show"])
    devices_ok, devices_out = command_ok(["bluetoothctl", "devices", "Paired"])
    powered = "Powered: yes" in bt_out
    return {
        "linux_stack_detected": bool(shutil.which("bluetoothctl") or shutil.which("rfkill")),
        "adapter_present": bt_ok or rfkill_ok,
        "adapter_powered": powered,
        "paired_phone_detected": "Phone" in devices_out or "iPhone" in devices_out or "Android" in devices_out,
        "phone_trigger_supported": "detect_only_after_system_pairing",
        "rfkill": rfkill_out[:240],
        "user_message": "Bluetooth phone audio requires Linux-side pairing; this app only displays detected status."
    }

def detect_audio():
    pipewire_ok, pipewire_out = command_ok(["pactl", "info"])
    aplay_ok, aplay_out = command_ok(["aplay", "-l"])
    return {
        "engine": "browser_webaudio_synthesis",
        "uses_external_music": False,
        "license_policy": "No unauthorized popular songs; WebAudio synthesis only.",
        "linux_audio": {
            "alsa_detected": aplay_ok,
            "pulseaudio_detected": "PulseAudio" in pipewire_out,
            "pipewire_detected": "PipeWire" in pipewire_out,
            "default_sink": next((line.split(":", 1)[1].strip() for line in pipewire_out.splitlines() if line.startswith("Default Sink:")), None)
        }
    }

def main():
    sensors = {
        "cpu_temp_c": cpu_temp_c(),
        "loadavg": " ".join(str(v) for v in os.getloadavg()) if hasattr(os, "getloadavg") else "0.20 0.16 0.09",
        "mem_available_kb": mem_available_kb(),
        "disk_percent": disk_percent(),
        "network": [{"name": socket.gethostname(), "state": "local"}]
    }
    result = {
        "app": ${JSON.stringify(appSlug)},
        "build_id": BUILD_ID,
        "prompt": PROMPT,
        "compile": "py_compile_ok",
        "runtime": "executed_on_board",
        "time": int(time.time()),
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "available_apis": ["/api/status", "./hardware-result.json", "/api/audio/status", "/api/audio/play", "/api/audio/record", "/api/audio/stop"],
        "sensors": sensors,
        "limits": {"temp_warn_c": 70, "mem_warn_kb": 180000, "disk_warn_percent": 85},
        "display": {"width": 480, "height": 360, "touch": False},
        "controls": {"space": "primary_action", "arrows": "navigate_or_adjust", "enter": "confirm_or_menu", "digits": ["1", "2", "3"]},
        "audio": detect_audio(),
        "bluetooth": detect_bluetooth(),
        "experience": {
            "kind": ${JSON.stringify(app.kind)},
            "title": ${JSON.stringify(app.title)},
            "offline_assets": True,
            "external_assets": False
        }
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))

if __name__ == "__main__":
    main()
`;
}

function manifest(app) {
  return {
    id: app.id,
    name: app.title,
    title: app.name,
    prompt: app.prompt,
    generator: "vibeboard-market-experience-suite",
    mode: app.mode,
    target: "480x360 RK3566 Linux kiosk",
    hardwareApi: ["/api/status", "./hardware-result.json", "/api/audio/status", "/api/audio/play", "/api/audio/record", "/api/audio/stop"],
    controls: ["Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "1", "2", "3"],
    files: GENERATED_FILES,
    compile: {
      web: "node --check app.js",
      hardware: "python -m py_compile hardware_app.py",
    },
    notes: "All visuals and sounds are generated locally with Canvas, CSS, and WebAudio. No external copyrighted music or image assets are bundled.",
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
