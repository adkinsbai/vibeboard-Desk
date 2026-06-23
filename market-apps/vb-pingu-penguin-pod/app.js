const BUILD_ID = "vb-pingu-penguin-pod";
const PROMPT = "A Pingu-style authorized cute penguin desktop pet for VibeBoard with local assets, keyboard interaction, and diary moments.";

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
      mood: state.mood,
      pose: state.pose,
      action: state.actionName,
      animation: activeAnimationName(),
      spriteReady: Boolean(getReadyImage(assets.sprite) && state.spriteMeta),
      room: state.room,
      x: Math.round(state.x),
      fish: state.fish,
      diary: state.diary.length,
      frame: Math.round(state.t),
    };
  },
};

const W = 480;
const H = 360;
const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const modeLabel = document.getElementById("modeLabel");
const valueLabel = document.getElementById("valueLabel");
const meterRail = document.getElementById("meterRail");
const caption = document.getElementById("caption");
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false;

const assets = {
  room: loadImage("./assets/ice-room.webp"),
  pet: loadImage("./assets/pingu-cutout.webp"),
  sprite: loadImage("./assets/pingu-sprite-atlas.webp"),
  spriteMeta: fetch("./assets/pingu-sprite-atlas.json").then(response => response.json()).catch(() => null),
  reference: loadImage("./assets/pingu-reference.webp"),
  spec: fetch("./assets/pet-spec.json").then(response => response.json()).catch(() => ({})),
};

const state = {
  t: 0,
  room: 0,
  mood: "boot",
  pose: "boot",
  actionStartedAt: 0,
  actionDurationMs: 0,
  actionName: "",
  actionTimer: 0,
  direction: 1,
  focus: 0,
  x: 240,
  targetX: 240,
  fish: Number(localStorage.getItem("pingu.fish") || 3),
  warmth: Number(localStorage.getItem("pingu.warmth") || 62),
  trust: Number(localStorage.getItem("pingu.trust") || 50),
  diary: loadDiary(),
  action: 0,
  blink: 0,
  lastInputAt: Date.now(),
  hardware: fallbackHardware(),
  status: {},
  spriteMeta: null,
  keys: new Set(),
  snow: makeSnow(reducedMotion ? 34 : 92),
  bubbles: makeBubbles(18),
};

Promise.all([
  window.VibeBoardHardware.getStatus(),
  window.VibeBoardHardware.getProgramResult(),
  assets.spriteMeta,
  assets.spec,
]).then(([status, hardware, spriteMeta]) => {
  state.status = status || {};
  state.hardware = hardware || fallbackHardware();
  state.spriteMeta = spriteMeta || null;
  state.mood = "idle";
  startAction("idle", 0);
}).catch(() => {
  state.mood = "idle";
  startAction("idle", 0);
});

document.addEventListener("keydown", event => {
  if (["Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Digit1", "Digit2", "Digit3"].includes(event.code)) {
    event.preventDefault();
  }
  state.keys.add(event.code);
  handleKey(event.code);
});

document.addEventListener("keyup", event => {
  state.keys.delete(event.code);
});

function handleKey(code) {
  state.action = 1;
  state.lastInputAt = Date.now();
  if (code === "Space") {
    state.fish = clamp(state.fish + 1, 0, 9);
    state.trust = clamp(state.trust + 8, 0, 100);
    state.mood = "happy";
    startAction("wave", 720);
    addDiary("SPACE response: one fish saved for the penguin.");
  }
  if (code === "ArrowLeft") {
    state.room = (state.room + 2) % 3;
    state.direction = -1;
    state.targetX = clamp(state.x - 88, 154, 326);
    state.mood = "walking";
    startAction("waddle", 1320);
  }
  if (code === "ArrowRight") {
    state.room = (state.room + 1) % 3;
    state.direction = 1;
    state.targetX = clamp(state.x + 88, 154, 326);
    state.mood = "walking";
    startAction("waddle", 1320);
  }
  if (code === "ArrowUp") {
    state.warmth = clamp(state.warmth + 7, 0, 100);
    state.mood = "happy";
    startAction("warm", 780);
  }
  if (code === "ArrowDown") {
    state.warmth = clamp(state.warmth - 7, 0, 100);
    state.mood = "cozy";
    startAction("settle", 720);
  }
  if (code === "Digit1") {
    state.warmth = clamp(state.warmth + 14, 0, 100);
    state.mood = "lamp";
    startAction("warm", 860);
    addDiary("Lamp warmed the ice room.");
  }
  if (code === "Digit2") {
    state.fish = clamp(state.fish + 2, 0, 9);
    state.mood = "fish";
    startAction("fish", 900);
    addDiary("Two fish were tucked into the cold box.");
  }
  if (code === "Digit3" || code === "Enter") {
    state.mood = "diary";
    startAction("diary", 1400);
    addDiary("Diary opened. The penguin reviewed today's small rituals.");
  }
  persistCare();
}

function loop() {
  state.t += reducedMotion ? 0.35 : 1;
  state.action *= 0.9;
  state.x += (state.targetX - state.x) * (state.pose === "waddle" ? 0.13 : 0.026);
  updateAction();
  const idleMs = Date.now() - state.lastInputAt;
  if (idleMs > 90000) {
    state.mood = "sleep";
    state.pose = "sleep";
  } else if (idleMs > 32000 && state.pose === "idle") {
    state.mood = "waiting";
    state.pose = "waiting";
  }
  draw();
  requestAnimationFrame(loop);
}
loop();

function startAction(name, durationMs) {
  if (state.actionTimer) {
    window.clearTimeout(state.actionTimer);
    state.actionTimer = 0;
  }
  state.pose = name || "idle";
  state.actionName = name || "idle";
  state.actionStartedAt = performance.now();
  state.actionDurationMs = Math.max(0, durationMs || 0);
  if (state.actionDurationMs) {
    state.actionTimer = window.setTimeout(updateAction, state.actionDurationMs + 40);
  }
}

function updateAction() {
  if (!state.actionDurationMs) return;
  const done = performance.now() - state.actionStartedAt >= state.actionDurationMs;
  if (!done) return;
  state.actionDurationMs = 0;
  state.actionName = "";
  state.actionTimer = 0;
  if (state.mood === "walking") {
    state.x = state.targetX;
    state.mood = "idle";
  } else if (["happy", "lamp", "fish", "cozy"].includes(state.mood)) {
    state.mood = "idle";
  }
  state.pose = state.mood === "diary" ? "diary" : "idle";
}

function actionProgress() {
  if (!state.actionDurationMs) return state.pose === "idle" ? 0 : 1;
  return clamp((performance.now() - state.actionStartedAt) / state.actionDurationMs, 0, 1);
}

function draw() {
  drawRoom();
  drawSnow();
  drawPodGlass();
  drawPet();
  drawProps();
  drawGlow();
  drawHud();
  drawCaption();
}

function drawRoom() {
  const room = getReadyImage(assets.room);
  if (room) {
    ctx.drawImage(room, 0, 0, W, H);
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 0, H);
    gradient.addColorStop(0, "#bce9ff");
    gradient.addColorStop(0.48, "#2879ba");
    gradient.addColorStop(1, "#f2fbff");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
  }
  const night = state.room === 2 ? 0.38 : state.room === 1 ? 0.16 : 0.04;
  ctx.fillStyle = `rgba(3, 10, 22, ${night})`;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255, 238, 178, 0.16)";
  ellipse(240, 158, 118 + state.warmth * 0.55, 98 + state.warmth * 0.25);
}

function drawSnow() {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  for (const flake of state.snow) {
    const x = (flake.x + Math.sin(state.t * 0.01 + flake.seed) * 10 + W) % W;
    const y = (flake.y + state.t * flake.speed) % H;
    ctx.globalAlpha = flake.alpha;
    ctx.beginPath();
    ctx.arc(x, y, flake.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPodGlass() {
  ctx.save();
  const glass = ctx.createLinearGradient(64, 58, 420, 308);
  glass.addColorStop(0, "rgba(255,255,255,0.32)");
  glass.addColorStop(0.42, "rgba(188,233,255,0.08)");
  glass.addColorStop(1, "rgba(4,20,36,0.12)");
  ctx.fillStyle = glass;
  roundRect(38, 42, 404, 276, 26);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.46)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.24)";
  line(82, 56, 44, 300);
  line(412, 74, 372, 304);
  ctx.restore();
}

function drawPet() {
  const sprite = getReadyImage(assets.sprite);
  const pet = getReadyImage(assets.pet);
  const motion = petMotion();
  const bob = moodBob();
  const scale = moodScale();
  const y = 230 + bob + motion.y;
  ctx.save();
  ctx.translate(state.x + motion.x, y);
  ctx.rotate(motion.lean);
  ctx.scale(scale * motion.sx, scale * motion.sy);
  if (state.mood === "sleep") {
    ctx.globalAlpha = 0.88;
  }
  if (sprite && state.spriteMeta) {
    drawSpriteFrame(sprite, state.spriteMeta);
  } else if (pet) {
    ctx.save();
    ctx.shadowColor = "rgba(10, 32, 48, 0.45)";
    ctx.shadowBlur = 10;
    ctx.drawImage(pet, -86, -172, 172, 246);
    ctx.restore();
  } else {
    drawFallbackPenguin();
  }
  drawExpression(motion);
  ctx.restore();
}

function drawSpriteFrame(sprite, meta) {
  const animationName = activeAnimationName();
  const animation = meta.animations?.[animationName] || meta.animations?.idle;
  if (!animation) return;
  const elapsed = Math.max(0, performance.now() - state.actionStartedAt);
  const fps = animation.fps || 6;
  const frameDuration = 1000 / fps;
  const rawIndex = Math.floor(elapsed / frameDuration);
  const frameIndex = animation.loop ? rawIndex % animation.frames : Math.min(rawIndex, animation.frames - 1);
  const sx = frameIndex * meta.frameWidth;
  const sy = animation.row * meta.frameHeight;
  ctx.save();
  ctx.shadowColor = "rgba(10, 32, 48, 0.38)";
  ctx.shadowBlur = 8;
  ctx.drawImage(
    sprite,
    sx,
    sy,
    meta.frameWidth,
    meta.frameHeight,
    -104,
    -190,
    208,
    234
  );
  ctx.restore();
}

function activeAnimationName() {
  if (state.pose === "wave" || state.pose === "fish" || state.pose === "diary") return "wave";
  if (state.pose === "waddle") return state.direction < 0 ? "waddle-left" : "waddle-right";
  if (state.pose === "warm" || state.pose === "settle") return "warm";
  if (state.pose === "sleep") return "sleep";
  return "idle";
}

function petMotion() {
  const p = easeInOut(actionProgress());
  const phase = state.t * 0.075;
  const motion = { x: 0, y: 0, lean: Math.sin(phase) * 0.014, sx: 1, sy: 1, wingLift: 0 };

  if (state.pose === "wave") {
    const wave = Math.sin(p * Math.PI);
    motion.y = -3 * wave;
    motion.lean = 0.022 * wave;
    motion.sx = 1 + 0.006 * wave;
    motion.sy = 1 - 0.004 * wave;
    motion.wingLift = wave * 0.68;
  } else if (state.pose === "hop") {
    const hop = Math.sin(p * Math.PI);
    motion.y = -24 * hop;
    motion.sx = 1 + 0.018 * hop;
    motion.sy = 1 - 0.02 * hop;
    motion.wingLift = hop * 0.72;
  } else if (state.pose === "waddle") {
    const step = Math.sin(p * Math.PI * 4);
    motion.x = step * 2.5;
    motion.y = -Math.abs(step) * 3.5;
    motion.lean = state.direction * 0.045 + step * 0.022;
    motion.sx = 1 + Math.abs(step) * 0.006;
    motion.sy = 1 - Math.abs(step) * 0.005;
  } else if (state.pose === "warm") {
    const warm = Math.sin(p * Math.PI);
    motion.y = -4 * warm;
    motion.lean = -0.025 * warm;
  } else if (state.pose === "settle") {
    const settle = Math.sin(p * Math.PI);
    motion.y = 5 * settle;
    motion.sx = 1.012;
    motion.sy = 0.988;
  } else if (state.pose === "waiting") {
    motion.lean = -0.035 + Math.sin(phase * 0.6) * 0.012;
    motion.y = Math.sin(phase * 0.5) * 2;
  } else if (state.pose === "sleep") {
    motion.y = 8 + Math.sin(phase * 0.45) * 2;
    motion.lean = -0.06;
    motion.sx = 0.94;
    motion.sy = 0.94;
  }

  return motion;
}

function drawExpression(motion) {
  if (!["wave", "hop", "warm", "fish", "diary", "waiting", "sleep"].includes(state.pose)) return;
  ctx.save();
  if (state.pose === "fish") {
    ctx.fillStyle = "#6fd2f6";
    ellipse(-48, -28, 18, 8);
    ctx.fillStyle = "#24536c";
    ctx.beginPath();
    ctx.moveTo(-64, -28);
    ctx.lineTo(-78, -38);
    ctx.lineTo(-78, -18);
    ctx.closePath();
    ctx.fill();
  }
  if (state.pose === "diary") {
    ctx.fillStyle = "rgba(255, 244, 205, 0.92)";
    roundRect(-34, -24, 68, 44, 5);
    ctx.fill();
    ctx.strokeStyle = "#b98942";
    ctx.stroke();
    ctx.strokeStyle = "rgba(80,60,40,0.35)";
    for (let y = -13; y < 11; y += 9) line(-22, y, 24, y);
  }
  if (state.pose === "waiting") {
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ellipse(46, -132, 4, 4);
    ellipse(60, -138, 3, 3);
    ellipse(71, -146, 2, 2);
  }
  if (state.pose === "sleep") {
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "16px ui-monospace, Consolas, monospace";
    ctx.fillText("Z", 54, -132);
    ctx.fillText("z", 70, -148);
  }
  ctx.restore();
}

function drawProps() {
  ctx.save();
  ctx.fillStyle = "rgba(6, 16, 26, 0.18)";
  ellipse(240, 286, 116, 18);
  drawFishBox(78, 252);
  drawLamp(382, 234);
  if (state.room === 1) drawRadio(350, 276);
  if (state.room === 2) drawDiaryShelf(66, 98);
  ctx.restore();
}

function drawFishBox(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#176c78";
  roundRect(-34, -22, 68, 42, 8);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  roundRect(-24, -14, 48, 14, 5);
  ctx.fill();
  ctx.fillStyle = "#d7f7ff";
  ctx.font = "11px ui-monospace, Consolas, monospace";
  ctx.fillText(String(state.fish).padStart(2, "0"), -8, 14);
  ctx.restore();
}

function drawLamp(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = "#1b5c78";
  ctx.lineWidth = 4;
  line(0, 18, 0, -44);
  ctx.fillStyle = "#ffd47a";
  ellipse(0, -50, 28, 16);
  ctx.fillStyle = `rgba(255, 212, 122, ${0.08 + state.warmth / 500})`;
  ellipse(0, -24, 72, 80);
  ctx.restore();
}

function drawRadio(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#24435a";
  roundRect(-36, -24, 72, 44, 8);
  ctx.fill();
  ctx.fillStyle = "#f8f5db";
  ellipse(-15, -2, 11, 11);
  ctx.strokeStyle = "#f8f5db";
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) line(6, -12 + i * 8, 24, -12 + i * 8);
  ctx.restore();
}

function drawDiaryShelf(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(11, 33, 50, 0.34)";
  roundRect(-36, -20, 72, 54, 8);
  ctx.fill();
  ctx.fillStyle = "#ffd47a";
  for (let i = 0; i < 4; i++) roundRect(-26 + i * 14, -11, 9, 35, 3), ctx.fill();
  ctx.restore();
}

function drawGlow() {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = `rgba(255, 212, 122, ${0.04 + state.action * 0.08})`;
  ellipse(240, 176, 170 + state.action * 32, 120 + state.action * 18);
  ctx.restore();
}

function drawHud() {
  modeLabel.textContent = "PENGUIN POD";
  valueLabel.textContent = moodLabel();
  const meters = [
    ["FISH", String(state.fish)],
    ["WARM", `${Math.round(state.warmth)}%`],
    ["TRUST", `${Math.round(state.trust)}%`],
    ["TEMP", tempLabel()],
  ];
  meterRail.innerHTML = meters.map((item, index) => (
    `<div class="meter ${index === state.focus ? "is-hot" : ""}"><span>${item[0]}</span><b>${item[1]}</b></div>`
  )).join("");
}

function drawCaption() {
  const lines = {
    boot: "Loading the ice room.",
    idle: "The penguin breathes quietly and watches the room.",
    walking: "It waddles to the other side of the ice room.",
    fish: "Fresh fish logged. The pouch looks heavier.",
    lamp: "The warm lamp is tuned for the next nap.",
    diary: diaryLine(),
    waiting: "It is pressed to the glass, waiting for a key press.",
    sleep: "The diary is closed. The penguin is asleep.",
    cozy: "The room cools down into a softer rhythm.",
    happy: "It notices you and gives a small wing wave.",
  };
  caption.textContent = lines[state.mood] || lines.idle;
}

function drawFallbackPenguin() {
  ctx.fillStyle = "#05070a";
  ellipse(0, -96, 48, 45);
  ellipse(0, -20, 62, 88);
  ctx.fillStyle = "#fff8ee";
  ellipse(0, -18, 38, 62);
  ctx.fillStyle = "#f15d2a";
  ellipse(0, -94, 28, 18);
  ctx.fillStyle = "#fff";
  ellipse(-19, -113, 9, 12);
  ellipse(19, -113, 9, 12);
  ctx.fillStyle = "#0b1117";
  ellipse(-19, -113, 4, 6);
  ellipse(19, -113, 4, 6);
  ctx.fillStyle = "#f68a2a";
  ellipse(-26, 52, 30, 12);
  ellipse(26, 52, 30, 12);
}

function moodBob() {
  if (reducedMotion) return 0;
  const phase = state.t * 0.075;
  if (state.pose === "sleep") return 8 + Math.sin(phase * 0.45) * 1.6;
  if (state.pose === "waiting") return Math.sin(phase * 0.5) * 1.4;
  return Math.sin(phase) * 1.7;
}

function moodScale() {
  if (state.pose === "sleep") return 0.9;
  if (state.pose === "waiting") return 0.96;
  return 1 + Math.sin(state.t * 0.052) * 0.01 + state.action * 0.01;
}

function moodLabel() {
  const names = {
    boot: "BOOT",
    idle: "IDLE",
    happy: "HELLO",
    walking: "WADDLE",
    fish: "FISH",
    lamp: "LAMP",
    diary: "DIARY",
    waiting: "WAIT",
    sleep: "SLEEP",
    cozy: "COZY",
  };
  return names[state.mood] || "READY";
}

function easeInOut(value) {
  return value < 0.5
    ? 2 * value * value
    : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

function diaryLine() {
  const count = state.diary.length;
  if (count === 0) return "No diary yet. Press Space, 1, 2, or 3 to make one.";
  return `Diary sorted ${count} moments. Biggest fish reserved for you.`;
}

function addDiary(text) {
  const entry = { at: new Date().toISOString(), text };
  state.diary = [entry, ...state.diary].slice(0, 8);
  localStorage.setItem("pingu.diary", JSON.stringify(state.diary));
}

function loadDiary() {
  try {
    const value = JSON.parse(localStorage.getItem("pingu.diary") || "[]");
    return Array.isArray(value) ? value.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function persistCare() {
  localStorage.setItem("pingu.fish", String(state.fish));
  localStorage.setItem("pingu.warmth", String(state.warmth));
  localStorage.setItem("pingu.trust", String(state.trust));
}

function fallbackHardware() {
  return {
    build_id: BUILD_ID,
    prompt: PROMPT,
    runtime: "offline_preview",
    available_apis: ["/api/status", "./hardware-result.json"],
    sensors: { cpu_temp_c: 42.5, mem_available_kb: 512000, disk_percent: 37, loadavg: "0.20 0.16 0.09" },
    display: { width: 480, height: 360, touch: false },
    bluetooth: { adapter_present: false, adapter_powered: false, paired_phone_detected: false },
  };
}

function tempLabel() {
  const value = state.hardware?.sensors?.cpu_temp_c || state.hardware?.system?.cpu_temp_c || 42.5;
  return `${Math.round(value)}C`;
}

function loadImage(src) {
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  return image;
}

function getReadyImage(image) {
  return image && image.complete && image.naturalWidth > 0 ? image : null;
}

function makeSnow(count) {
  return Array.from({ length: count }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    r: 0.8 + Math.random() * 1.8,
    speed: 0.18 + Math.random() * 0.72,
    alpha: 0.28 + Math.random() * 0.52,
    seed: Math.random() * 10,
  }));
}

function makeBubbles(count) {
  return Array.from({ length: count }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    r: 2 + Math.random() * 8,
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

function ellipse(x, y, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
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
