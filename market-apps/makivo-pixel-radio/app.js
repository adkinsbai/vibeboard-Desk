const BUILD_ID = "makivo-pixel-radio";
const PROMPT = "A bundled local pixel radio for MAKIVO One with lyrics and reactive visuals.";

const canvas = document.getElementById("visualizer");
const ctx = canvas.getContext("2d");
const trackTitle = document.getElementById("trackTitle");
const trackArtist = document.getElementById("trackArtist");
const trackIndex = document.getElementById("trackIndex");
const lyricLine = document.getElementById("lyricLine");
const playButton = document.getElementById("playButton");
const timeLabel = document.getElementById("timeLabel");

const tracks = [
  { title: "Neon Orbit", artist: "MAKIVO HOUSE BAND", bpm: 104, mood: "GLOW", color: "#d8ff55", notes: [220, 277, 330, 415], lyrics: [[0, "按下播放，让像素开始呼吸。"], [1800, "绕过一颗发光的小星球。"], [3800, "每一个节拍，都在桌面起飞。"]] },
  { title: "Pixel Tide", artist: "MAKIVO HOUSE BAND", bpm: 92, mood: "WAVE", color: "#6de5e7", notes: [196, 247, 294, 370], lyrics: [[0, "像素潮汐，轻轻推着夜色。"], [2000, "蓝色的光在屏幕上漫开。"], [4000, "把今天的心情调成海。"]] },
  { title: "Arcade Sprint", artist: "MAKIVO HOUSE BAND", bpm: 128, mood: "RUSH", color: "#ff6f91", notes: [165, 196, 247, 330], lyrics: [[0, "准备，三、二、一，出发！"], [1600, "街机灯牌在耳边闪烁。"], [3400, "下一关，还是你来命名。"]] },
  { title: "Moon Garden", artist: "MAKIVO HOUSE BAND", bpm: 76, mood: "DREAM", color: "#b89cff", notes: [174, 220, 261, 349], lyrics: [[0, "月亮把花园调成了紫色。"], [2300, "一朵旋律正在悄悄长大。"], [4600, "晚安，创作者。"]] },
  { title: "Story Spark", artist: "MAKIVO HOUSE BAND", bpm: 110, mood: "TALE", color: "#ffb35c", notes: [196, 262, 330, 392], lyrics: [[0, "从一个声音开始一段故事。"], [1900, "主角踩着鼓点登场。"], [3900, "结尾，留给下一次播放。"]] },
  { title: "Word Jump", artist: "MAKIVO HOUSE BAND", bpm: 118, mood: "PLAY", color: "#75c8ff", notes: [208, 247, 311, 415], lyrics: [[0, "一个词，也可以跳成一首歌。"], [1700, "把想法放进节拍里。"], [3600, "听见了吗？这是你的作品。"]] },
];

const state = {
  connection_mode: "offline",
  catalog_source: "bundled",
  audio_source: "embedded-synth",
  tracks,
  selected_track: tracks[0].title,
  selected_index: 0,
  playing: false,
  elapsed_ms: 0,
  current_lyric: tracks[0].lyrics[0][1],
  visualizer_frame: 0,
  tick: 0,
  audio_context: "not_started",
};

let audioContext = null;
let noteTimer = null;
let startedAt = 0;
let pausedAt = 0;

window.VibeBoardHardware = {
  async getStatus() { return { ok: true, mode: "offline", touch: false, speaker: true, microphone: true }; },
  async getProgramResult() { return { build_id: BUILD_ID, runtime: "local_device_app", offline: true, catalog_source: "bundled" }; },
  getSnapshot() { return { build_id: BUILD_ID, prompt: PROMPT, track: state.selected_track, playing: state.playing, lyric: state.current_lyric }; },
};

window.MakivoRadioSimulator = {
  getState() { return typeof structuredClone === "function" ? structuredClone(state) : JSON.parse(JSON.stringify(state)); },
  tracks,
};

function selectedTrack() { return tracks[state.selected_index]; }

function renderTrack() {
  const track = selectedTrack();
  document.documentElement.style.setProperty("--accent", track.color);
  trackIndex.textContent = `TRACK ${String(state.selected_index + 1).padStart(2, "0")} / ${String(tracks.length).padStart(2, "0")}`;
  trackTitle.textContent = track.title;
  trackArtist.textContent = `${track.artist} · ${track.bpm} BPM · ${track.mood}`;
  lyricLine.textContent = state.current_lyric;
  playButton.textContent = state.playing ? "PAUSE" : "PLAY";
  document.getElementById("modeLabel").textContent = state.playing ? "SPEAKER PLAYING" : "SPEAKER READY";
}

function chooseTrack(delta) {
  state.selected_index = (state.selected_index + delta + tracks.length) % tracks.length;
  state.selected_track = selectedTrack().title;
  state.elapsed_ms = 0;
  pausedAt = 0;
  state.current_lyric = selectedTrack().lyrics[0][1];
  if (state.playing) startSynthLoop();
  renderTrack();
}

function ensureAudio() {
  if (audioContext) return audioContext;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) { state.audio_context = "unavailable_visual_only"; return null; }
  audioContext = new AudioCtor();
  state.audio_context = "local_web_audio";
  return audioContext;
}

function playNote(frequency, duration = .18) {
  const context = ensureAudio();
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "square";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(.035, context.currentTime + .015);
  gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + duration + .03);
}

function startSynthLoop() {
  clearInterval(noteTimer);
  let note = 0;
  const track = selectedTrack();
  noteTimer = setInterval(() => {
    if (!state.playing) return;
    playNote(track.notes[note % track.notes.length]);
    note += 1;
  }, Math.round(60000 / track.bpm));
}

function togglePlayback() {
  state.playing = !state.playing;
  if (state.playing) {
    ensureAudio()?.resume?.();
    startedAt = performance.now() - pausedAt;
    startSynthLoop();
  } else {
    pausedAt = state.elapsed_ms;
    clearInterval(noteTimer);
    noteTimer = null;
  }
  renderTrack();
}

function updatePlayback() {
  if (!state.playing) return;
  state.elapsed_ms = performance.now() - startedAt;
  const track = selectedTrack();
  const elapsed = state.elapsed_ms % 6200;
  const lines = track.lyrics;
  let active = lines[0][1];
  for (const [at, text] of lines) if (elapsed >= at) active = text;
  state.current_lyric = active;
  lyricLine.textContent = active;
  timeLabel.textContent = `00:${String(Math.floor(elapsed / 1000)).padStart(2, "0")}`;
}

function draw() {
  state.tick += 1;
  state.visualizer_frame += 1;
  updatePlayback();
  const track = selectedTrack();
  const accent = track.color;
  ctx.fillStyle = "#080b16"; ctx.fillRect(0, 0, 480, 360);
  ctx.fillStyle = "rgba(255,255,255,.045)";
  for (let y = 0; y < 360; y += 16) ctx.fillRect(0, y, 480, 1);
  for (let x = 0; x < 480; x += 16) ctx.fillRect(x, 0, 1, 360);
  const energy = state.playing ? .75 + Math.sin(state.tick / 6) * .2 : .2 + Math.sin(state.tick / 22) * .04;
  for (let i = 0; i < 24; i += 1) {
    const bar = 8 + Math.abs(Math.sin(state.tick / (8 + i % 5) + i)) * 62 * energy;
    const x = 16 + i * 19;
    ctx.fillStyle = i % 3 === 0 ? accent : "rgba(109,229,231,.52)";
    ctx.fillRect(x, 250 - bar, 11, bar);
    ctx.fillStyle = "rgba(255,255,255,.12)";
    ctx.fillRect(x, 254, 11, 2);
  }
  ctx.globalAlpha = .25 + energy * .25;
  ctx.strokeStyle = accent; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= 480; x += 8) {
    const y = 185 + Math.sin(x / 23 + state.tick / 10) * 20 * energy + Math.sin(x / 8 + state.tick / 16) * 7;
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.globalAlpha = 1;
  ctx.fillStyle = accent; ctx.fillRect(30, 214, 4, 4);
  requestAnimationFrame(draw);
}

playButton.addEventListener("click", togglePlayback);
document.getElementById("previousButton").addEventListener("click", () => chooseTrack(-1));
document.getElementById("nextButton").addEventListener("click", () => chooseTrack(1));
window.addEventListener("keydown", event => {
  if (event.key === " ") { event.preventDefault(); togglePlayback(); }
  if (event.key === "ArrowRight") chooseTrack(1);
  if (event.key === "ArrowLeft") chooseTrack(-1);
});

renderTrack();
draw();
