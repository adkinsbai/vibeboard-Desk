const BUILD_ID = "makivo-my-ai-pet";
const PROMPT = "A local voice-created pixel pet for MAKIVO One.";

const canvas = document.getElementById("petCanvas");
const ctx = canvas.getContext("2d");
const petName = document.getElementById("petName");
const petDetails = document.getElementById("petDetails");
const eventLine = document.getElementById("eventLine");
const stageLabel = document.getElementById("stageLabel");
const transcript = document.getElementById("transcript");
const voiceInput = document.getElementById("voiceInput");
const inputStatus = document.getElementById("inputStatus");

const state = {
  connection_mode: "offline",
  input_mode: "voice-text-fallback",
  stage: "ready",
  tick: 0,
  pet: { stage: "ready", species: "star", color: "lime", personality: "curious", hobby: "exploring", name: "小小新朋友" },
  transcript: "",
  recognition: false,
};

const colors = { lime: "#d8ff55", blue: "#75c8ff", pink: "#ff6f91", orange: "#ffb35c", violet: "#b89cff" };
const speciesNames = { fox: "小狐狸", cat: "小猫", rabbit: "小兔", bear: "小熊", star: "小星星" };
const colorNames = { blue: "蓝色", pink: "粉色", orange: "橘色", violet: "紫色", lime: "荧光绿" };
const hobbyNames = { singing: "唱歌", drawing: "画画", coding: "编程", exploring: "探险" };

window.VibeBoardHardware = {
  async getStatus() { return { ok: true, mode: "offline", touch: false, audio: ["speaker", "microphone"] }; },
  async getProgramResult() { return { build_id: BUILD_ID, runtime: "local_device_app", offline: true }; },
  getSnapshot() { return { build_id: BUILD_ID, prompt: PROMPT, stage: state.stage, pet: { ...state.pet } }; },
};

window.MakivoPetSimulator = {
  getState() { return typeof structuredClone === "function" ? structuredClone(state) : JSON.parse(JSON.stringify(state)); },
  parseTranscript,
};

function parseTranscript(value) {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();
  const species = /狐|狐狸|fox/.test(lower) ? "fox" : /兔|兔子|rabbit/.test(lower) ? "rabbit" : /熊|bear/.test(lower) ? "bear" : /猫|cat/.test(lower) ? "cat" : "star";
  const color = /蓝|blue/.test(lower) ? "blue" : /粉|pink/.test(lower) ? "pink" : /橘|orange/.test(lower) ? "orange" : /紫|violet|purple/.test(lower) ? "violet" : "lime";
  const hobby = /唱|歌|sing/.test(lower) ? "singing" : /画|draw|paint/.test(lower) ? "drawing" : /编程|代码|code/.test(lower) ? "coding" : "exploring";
  const personality = /勇敢|brave/.test(lower) ? "brave" : /安静|quiet/.test(lower) ? "gentle" : /聪明|smart/.test(lower) ? "clever" : "curious";
  const name = `${colorNames[color]}${speciesNames[species]}`;
  return { species, color, hobby, personality, name };
}

async function hatchPet(value) {
  const description = String(value || "").trim() || "一只荧光绿的小星星，喜欢探险";
  state.transcript = description;
  state.pet = { ...state.pet, ...parseTranscript(description), stage: "hatching" };
  state.stage = "hatching";
  state.recognition = false;
  transcript.textContent = `VOICE > ${description}`;
  stageLabel.textContent = "HATCHING / LOCAL BUILD";
  eventLine.textContent = "正在把声音拼成像素伙伴…";
  renderCopy();
  await new Promise(resolve => setTimeout(resolve, 720));
  state.pet.stage = "ready";
  state.stage = "ready";
  stageLabel.textContent = "VOICE MAGIC PET";
  eventLine.textContent = "声音已变成一只新伙伴。";
  renderCopy();
}

function renderCopy() {
  petName.textContent = state.pet.name;
  petDetails.textContent = `${colorNames[state.pet.color]} · ${speciesNames[state.pet.species]} · 爱${hobbyNames[state.pet.hobby]}`;
}

document.getElementById("voiceForm").addEventListener("submit", event => {
  event.preventDefault();
  hatchPet(voiceInput.value);
});

document.getElementById("voiceButton").addEventListener("click", () => {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    inputStatus.textContent = "浏览器无麦克风时可直接输入";
    voiceInput.focus();
    return;
  }
  const recognition = new Recognition();
  recognition.lang = "zh-CN";
  recognition.interimResults = false;
  state.recognition = true;
  state.stage = "listening";
  stageLabel.textContent = "LISTENING / SAY A PET";
  inputStatus.textContent = "正在听…";
  recognition.onresult = event => {
    voiceInput.value = event.results[0][0].transcript;
    state.recognition = false;
    document.getElementById("voiceForm").requestSubmit();
  };
  recognition.onerror = () => { state.recognition = false; state.stage = "ready"; inputStatus.textContent = "听取失败，请输入文字"; };
  recognition.onend = () => { state.recognition = false; if (state.stage === "listening") state.stage = "ready"; };
  recognition.start();
});

function pixel(x, y, w, h, fill) { ctx.fillStyle = fill; ctx.fillRect(Math.round(x), Math.round(y), w, h); }

function draw() {
  state.tick += 1;
  const t = state.tick;
  ctx.clearRect(0, 0, 480, 360);
  ctx.fillStyle = "#0b100d"; ctx.fillRect(0, 0, 480, 360);
  ctx.fillStyle = "rgba(216,255,85,.05)";
  for (let x = 0; x < 480; x += 16) ctx.fillRect(x, 0, 1, 360);
  for (let y = 0; y < 360; y += 16) ctx.fillRect(0, y, 480, 1);
  for (let i = 0; i < 22; i += 1) {
    const x = (i * 83 + t * (i % 3 === 0 ? .18 : -.08)) % 480;
    const y = 30 + ((i * 47) % 190);
    pixel(x, y, 3, 3, i % 2 ? "#263627" : "#405b36");
  }
  const accent = colors[state.pet.color] || colors.lime;
  const bob = Math.sin(t / 15) * (state.stage === "hatching" ? 4 : 2);
  if (state.stage === "hatching") drawEgg(330, 142 + bob, accent, t);
  else drawPet(state.pet.species, 330, 130 + bob, accent, t);
  pixel(268, 276, 138, 5, "#18241a");
  pixel(286, 281, 102, 2, accent);
  requestAnimationFrame(draw);
}

function drawEgg(x, y, accent, t) {
  const jitter = Math.sin(t / 4) * 2;
  pixel(x - 38 + jitter, y - 45, 76, 90, "#15231a");
  pixel(x - 30 + jitter, y - 53, 60, 8, accent);
  pixel(x - 46 + jitter, y - 35, 8, 70, accent);
  pixel(x + 38 + jitter, y - 35, 8, 70, accent);
  pixel(x - 30 + jitter, y + 45, 60, 8, accent);
  pixel(x - 14 + jitter, y - 12, 8, 8, "#f6f7ef");
  pixel(x + 14 + jitter, y - 12, 8, 8, "#f6f7ef");
  pixel(x - 6 + jitter, y + 16, 12, 4, "#ff6f91");
}

function drawPet(species, x, y, accent, t) {
  const blink = Math.floor(t / 90) % 7 === 0;
  const dark = "#101b14";
  const face = "#1a2b1d";
  if (species === "fox") { pixel(x - 54, y - 48, 26, 26, accent); pixel(x + 28, y - 48, 26, 26, accent); pixel(x - 62, y - 30, 124, 86, accent); pixel(x - 48, y + 28, 96, 35, accent); }
  else if (species === "rabbit") { pixel(x - 40, y - 78, 20, 42, accent); pixel(x + 20, y - 78, 20, 42, accent); pixel(x - 58, y - 42, 116, 105, accent); }
  else if (species === "bear") { pixel(x - 68, y - 30, 24, 32, accent); pixel(x + 44, y - 30, 24, 32, accent); pixel(x - 62, y - 47, 124, 110, accent); }
  else if (species === "cat") { pixel(x - 55, y - 56, 23, 30, accent); pixel(x + 32, y - 56, 23, 30, accent); pixel(x - 60, y - 35, 120, 100, accent); }
  else { pixel(x - 50, y - 18, 100, 36, accent); pixel(x - 18, y - 50, 36, 100, accent); pixel(x - 38, y - 38, 76, 76, accent); }
  pixel(x - 44, y - 23, 88, 76, face);
  pixel(x - 24, y - 5, 14, blink ? 4 : 14, "#f6f7ef"); pixel(x + 10, y - 5, 14, blink ? 4 : 14, "#f6f7ef");
  pixel(x - 19, y - 1, 5, 8, accent); pixel(x + 15, y - 1, 5, 8, accent);
  pixel(x - 5, y + 18, 10, 6, "#ff6f91"); pixel(x - 18, y + 38, 36, 4, accent);
  pixel(x - 72, y + 36, 14, 5, accent); pixel(x + 58, y + 36, 14, 5, accent);
}

renderCopy();
draw();
