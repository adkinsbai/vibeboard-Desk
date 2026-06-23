const BUILD_ID = "vb-micro-life-pod";
const PROMPT = "A living desktop micro habitat with weather, light, memory, and keyboard care rituals.";
const ROOM_DAY_DATA_URL = "./assets/room-day.webp";
const ROOM_NIGHT_DATA_URL = "./assets/room-night.webp";
const CREATURE_ATLAS_DATA_URL = "./assets/creature-atlas.webp";

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const modeLabel = document.getElementById("modeLabel");
const valueLabel = document.getElementById("valueLabel");
const metricRail = document.getElementById("metricRail");
const caption = document.getElementById("caption");
const W = 480;
const H = 360;
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false;

const rooms = [
  { id: "habitat", label: "HABITAT", caption: "It watches the room lights and answers when you tap Space." },
  { id: "window", label: "RAIN WINDOW", caption: "Rain on the glass becomes a quiet rhythm for the pod." },
  { id: "garden", label: "GARDEN", caption: "The little companion tends the plants when the board rests." },
  { id: "memory", label: "DIARY", caption: "At night it gathers today's touches into a tiny diary." },
];

const state = {
  t: 0,
  room: 0,
  scene: "day",
  mood: 0.66,
  care: 0.58,
  memory: 0.42,
  warmth: 0.54,
  actionPulse: 0,
  feedPulse: 0,
  diaryPulse: 0,
  rainPulse: 0.45,
  lightPulse: 0.45,
  sprite: 0,
  lastAction: "BOOT",
  keys: new Set(),
  hardware: fallbackHardware(),
  status: {},
  audio: {
    ctx: null,
    master: null,
    rain: null,
    hum: null,
    started: false,
  },
};

const images = {
  day: loadImage(ROOM_DAY_DATA_URL),
  night: loadImage(ROOM_NIGHT_DATA_URL),
  creature: loadImage(CREATURE_ATLAS_DATA_URL),
};

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
    } catch {
      return fallbackHardware();
    }
  },
  getSnapshot() {
    return {
      build_id: BUILD_ID,
      prompt: PROMPT,
      room: rooms[state.room].id,
      mood: Math.round(state.mood * 100),
      care: Math.round(state.care * 100),
      memory: Math.round(state.memory * 100),
      frame: Math.round(state.t),
    };
  },
};

Promise.all([
  window.VibeBoardHardware.getStatus(),
  window.VibeBoardHardware.getProgramResult(),
]).then(([status, hardware]) => {
  state.status = status || {};
  state.hardware = hardware || fallbackHardware();
  state.lastAction = "READY";
}).catch(() => {
  state.lastAction = "LOCAL";
});

document.addEventListener("keydown", event => {
  if (["Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Digit1", "Digit2", "Digit3", "Enter"].includes(event.code)) {
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
  if (code === "Space") {
    state.feedPulse = 1;
    state.sprite = 2;
    state.care = clamp(state.care + 0.12, 0, 1);
    state.mood = clamp(state.mood + 0.1, 0, 1);
    state.memory = clamp(state.memory + 0.05, 0, 1);
    state.lastAction = "FED";
    ping(660, 0.05);
  }
  if (code === "ArrowLeft") shiftRoom(-1);
  if (code === "ArrowRight") shiftRoom(1);
  if (code === "ArrowUp") {
    state.warmth = clamp(state.warmth + 0.08, 0, 1);
    state.lastAction = "WARM";
    ping(520, 0.035);
  }
  if (code === "ArrowDown") {
    state.rainPulse = clamp(state.rainPulse + 0.16, 0, 1);
    state.lastAction = "RAIN";
    ping(360, 0.035);
  }
  if (code === "Digit1") {
    state.scene = "day";
    state.lightPulse = 1;
    state.sprite = 1;
    state.lastAction = "LIGHT";
    ping(740, 0.05);
  }
  if (code === "Digit2") {
    state.rainPulse = 1;
    state.sprite = 5;
    state.lastAction = "WEATHER";
    rainTick();
  }
  if (code === "Digit3" || code === "Enter") {
    state.scene = "night";
    state.room = 3;
    state.diaryPulse = 1;
    state.sprite = 6;
    state.memory = clamp(state.memory + 0.18, 0, 1);
    state.lastAction = "DIARY";
    ping(880, 0.07);
  }
}

function shiftRoom(delta) {
  state.room = (state.room + rooms.length + delta) % rooms.length;
  state.sprite = state.room === 3 ? 6 : state.room === 1 ? 5 : state.room === 2 ? 8 : 0;
  state.lastAction = rooms[state.room].label;
  ping(delta > 0 ? 490 : 430, 0.035);
}

function loop() {
  state.t += reducedMotion ? 0.45 : 1;
  state.actionPulse *= 0.9;
  state.feedPulse *= 0.86;
  state.diaryPulse *= 0.91;
  state.rainPulse = clamp(state.rainPulse * 0.996, 0.28, 1);
  state.lightPulse *= 0.94;
  if (state.feedPulse < 0.06 && state.diaryPulse < 0.06 && state.t % 96 < 1) {
    state.sprite = state.mood > 0.8 ? 1 : state.room === 3 ? 6 : 0;
  }
  updateAudio();
  draw();
  requestAnimationFrame(loop);
}
loop();

function draw() {
  drawScene();
  drawAtmosphere();
  drawCreature();
  drawForegroundEffects();
  drawPanel();
  drawHud();
}

function drawScene() {
  const active = state.scene === "night" || state.room === 3 ? images.night : images.day;
  if (active.complete && active.naturalWidth > 0) {
    ctx.drawImage(active, 0, 0, W, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#12262c");
    g.addColorStop(0.58, "#163b35");
    g.addColorStop(1, "#0a0807");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  const night = state.scene === "night" || state.room === 3;
  ctx.save();
  ctx.globalAlpha = night ? 0.22 : 0.08;
  ctx.fillStyle = night ? "#07152b" : "#fff2c2";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  const lamp = ctx.createRadialGradient(236, 172, 20, 236, 172, 190);
  lamp.addColorStop(0, `rgba(255,225,141,${0.18 + state.warmth * 0.15 + state.lightPulse * 0.2})`);
  lamp.addColorStop(0.44, `rgba(126,246,199,${0.08 + state.mood * 0.05})`);
  lamp.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, W, H);
}

function drawAtmosphere() {
  const rain = Math.max(state.rainPulse, state.room === 1 ? 0.75 : 0.36);
  ctx.save();
  ctx.strokeStyle = "rgba(185,225,240,0.62)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 42; i++) {
    const x = (i * 37 + state.t * (0.5 + i % 5) * 0.42) % (W + 80) - 40;
    const y = (i * 23 + state.t * (1.2 + i % 4) * 0.9) % 250;
    ctx.globalAlpha = rain * (0.04 + (i % 7) * 0.008);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 7, y + 22);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  for (let i = 0; i < 26; i++) {
    const phase = state.t * 0.012 + i * 1.7;
    const x = 98 + (i * 13) + Math.sin(phase) * 9;
    const y = 68 + ((i * 29 + state.t * 0.35) % 218);
    const r = 1.2 + (i % 4) * 0.35;
    ctx.globalAlpha = 0.08 + state.mood * 0.08 + state.diaryPulse * 0.16;
    ctx.fillStyle = i % 3 === 0 ? "#ffd982" : "#9df6cf";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCreature() {
  const atlas = images.creature;
  const sprite = spriteIndex();
  const col = sprite % 3;
  const row = Math.floor(sprite / 3);
  const cell = atlas.naturalWidth ? atlas.naturalWidth / 3 : 256;
  const bob = Math.sin(state.t * 0.045) * (reducedMotion ? 1 : 4);
  const x = 240 + roomOffset();
  const y = 206 + bob - state.feedPulse * 10 - state.diaryPulse * 3;
  const scale = 0.56 + state.feedPulse * 0.08 + state.diaryPulse * 0.03;
  const w = 142 * scale;
  const h = 142 * scale;

  ctx.save();
  const glow = ctx.createRadialGradient(x, y + 20, 18, x, y + 20, 94);
  glow.addColorStop(0, `rgba(255,224,126,${0.34 + state.actionPulse * 0.2})`);
  glow.addColorStop(0.48, `rgba(126,246,199,${0.18 + state.mood * 0.1})`);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(x - 120, y - 100, 240, 220);
  ctx.shadowColor = "#f9df8a";
  ctx.shadowBlur = 22 + state.actionPulse * 24;
  if (atlas.complete && atlas.naturalWidth > 0) {
    ctx.drawImage(atlas, col * cell, row * cell, cell, cell, x - w / 2, y - h / 2, w, h);
  } else {
    ctx.fillStyle = "#bdf8dd";
    ctx.beginPath();
    ctx.ellipse(x, y, 34 * scale, 42 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  if (state.feedPulse > 0.05) drawFoodBurst(x, y - 34);
  if (state.diaryPulse > 0.05) drawDiaryCards(x, y + 54);
}

function spriteIndex() {
  if (state.diaryPulse > 0.08 || state.room === 3) return 6;
  if (state.feedPulse > 0.1) return 2;
  if (state.actionPulse > 0.3 && state.lastAction === "WEATHER") return 5;
  if (state.mood > 0.86) return 1;
  return state.sprite || 0;
}

function roomOffset() {
  if (state.room === 1) return 30;
  if (state.room === 2) return -34;
  if (state.room === 3) return -10;
  return 0;
}

function drawFoodBurst(x, y) {
  ctx.save();
  for (let i = 0; i < 9; i++) {
    const a = i / 9 * Math.PI * 2 + state.t * 0.03;
    const d = (1 - state.feedPulse) * 48 + 12;
    ctx.globalAlpha = state.feedPulse;
    ctx.fillStyle = i % 2 ? "#ffd46b" : "#ff9f7a";
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 2.2 + (i % 3), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawDiaryCards(x, y) {
  ctx.save();
  ctx.globalAlpha = clamp(state.diaryPulse + 0.2, 0, 1);
  for (let i = 0; i < 3; i++) {
    const dx = (i - 1) * 42 + Math.sin(state.t * 0.02 + i) * 4;
    ctx.translate(x + dx, y - i * 8);
    ctx.rotate((i - 1) * 0.08);
    ctx.fillStyle = "rgba(255,238,192,0.86)";
    roundRect(-18, -12, 36, 24, 5);
    ctx.fill();
    ctx.fillStyle = "rgba(118,86,48,0.56)";
    ctx.fillRect(-10, -3, 20, 2);
    ctx.fillRect(-10, 4, 14, 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  ctx.restore();
}

function drawForegroundEffects() {
  ctx.save();
  ctx.globalAlpha = 0.28 + state.actionPulse * 0.2;
  ctx.strokeStyle = "rgba(219,255,240,0.6)";
  ctx.lineWidth = 1;
  roundRect(6, 6, 468, 348, 14);
  ctx.stroke();
  ctx.globalAlpha = 0.11;
  ctx.fillStyle = "#fff";
  ctx.fillRect(42, 0, 36, H);
  ctx.restore();

  const vignette = ctx.createRadialGradient(240, 168, 120, 240, 168, 310);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.42)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
}

function drawPanel() {
  ctx.save();
  ctx.fillStyle = "rgba(4,8,12,0.5)";
  roundRect(14, 304, 452, 42, 10);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.stroke();
  ctx.restore();
}

function drawHud() {
  modeLabel.textContent = "Micro Life Pod";
  valueLabel.textContent = state.lastAction;
  const values = [
    ["CARE", pct(state.care)],
    ["MOOD", pct(state.mood)],
    ["MEM", pct(state.memory)],
    ["CPU", temp()],
  ];
  metricRail.innerHTML = values.map((item, index) => (
    `<div class="metric ${index === state.room ? "is-hot" : ""}"><span>${item[0]}</span><b>${item[1]}</b></div>`
  )).join("");

  const room = rooms[state.room];
  if (state.diaryPulse > 0.08 || state.room === 3) {
    caption.textContent = "It is arranging today's touches into a small night diary.";
  } else if (state.feedPulse > 0.08) {
    caption.textContent = "The pod brightens, eats, and remembers that you answered.";
  } else {
    caption.textContent = `${room.label}: ${room.caption}`;
  }
}

function unlockAudio() {
  if (state.audio.started) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const ac = new AudioContext();
  const master = ac.createGain();
  master.gain.value = 0.025;
  master.connect(ac.destination);
  state.audio.ctx = ac;
  state.audio.master = master;
  state.audio.started = true;

  const hum = ac.createOscillator();
  const humGain = ac.createGain();
  hum.type = "sine";
  hum.frequency.value = 92;
  humGain.gain.value = 0.016;
  hum.connect(humGain).connect(master);
  hum.start();
  state.audio.hum = humGain;
}

function updateAudio() {
  if (!state.audio.master || !state.audio.ctx) return;
  const target = 0.012 + state.mood * 0.018 + state.diaryPulse * 0.018;
  state.audio.master.gain.setTargetAtTime(target, state.audio.ctx.currentTime, 0.08);
  state.audio.hum?.gain.setTargetAtTime(0.01 + state.warmth * 0.014, state.audio.ctx.currentTime, 0.1);
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

function rainTick() {
  ping(240, 0.04);
  setTimeout(() => ping(310, 0.03), 54);
}

function loadImage(src) {
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  return image;
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

function temp() {
  const value = state.hardware?.sensors?.cpu_temp_c || state.hardware?.system?.cpu_temp_c || 43;
  return `${Math.round(value)}C`;
}

function pct(value) {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
