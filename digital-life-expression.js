function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function clampSigned(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(-1, number));
}

function smooth(current, target, factor = 0.08) {
  return current + (target - current) * factor;
}

function mixColor(a, b, amount) {
  const t = clamp(amount);
  const ah = a.replace("#", "");
  const bh = b.replace("#", "");
  const ar = parseInt(ah.slice(0, 2), 16);
  const ag = parseInt(ah.slice(2, 4), 16);
  const ab = parseInt(ah.slice(4, 6), 16);
  const br = parseInt(bh.slice(0, 2), 16);
  const bg = parseInt(bh.slice(2, 4), 16);
  const bb = parseInt(bh.slice(4, 6), 16);
  const rr = Math.round(ar + (br - ar) * t).toString(16).padStart(2, "0");
  const rg = Math.round(ag + (bg - ag) * t).toString(16).padStart(2, "0");
  const rb = Math.round(ab + (bb - ab) * t).toString(16).padStart(2, "0");
  return `#${rr}${rg}${rb}`;
}

export function createDigitalLifeExpression(canvas, options = {}) {
  const ctx = canvas.getContext("2d", { alpha: true });
  const target = {
    state: "idle",
    mood: "calm",
    energy: 0.7,
    stress: 0.08,
    curiosity: 0.5,
    loneliness: 0.2,
    dopamine: 0,
    arousal: 0.35,
    valence: 0,
    dominance: 0,
    trust: 0.5,
    anger: 0,
    boredom: 0.18,
    voiceLevel: 0,
    voicePitch: 0.45,
  };
  const current = { ...target };
  let reducedMotion = Boolean(options.reducedMotion);
  let raf = 0;
  let startedAt = performance.now();

  const stateProfiles = {
    idle: { base: 0.012, voice: 0.04, speed: 0.18, frequency: 1.05, jitter: 0.02, glow: 0.35, markers: 0.18 },
    sleep: { base: 0.002, voice: 0, speed: 0.035, frequency: 0.5, jitter: 0, glow: 0.12, markers: 0.02 },
    listening: { base: 0.025, voice: 0.08, speed: 0.32, frequency: 1.7, jitter: 0.02, glow: 0.48, markers: 0.28 },
    thinking: { base: 0.018, voice: 0.02, speed: 0.22, frequency: 1.25, jitter: 0.015, glow: 0.42, markers: 0.42 },
    speaking: { base: 0.055, voice: 0.72, speed: 0.72, frequency: 2.2, jitter: 0.03, glow: 0.75, markers: 0.32 },
    happy: { base: 0.07, voice: 0.08, speed: 0.68, frequency: 2.35, jitter: 0.018, glow: 0.78, markers: 0.5 },
    angry: { base: 0.095, voice: 0.08, speed: 1.05, frequency: 3.35, jitter: 0.22, glow: 0.92, markers: 0.18 },
    lonely: { base: 0.018, voice: 0.02, speed: 0.12, frequency: 0.78, jitter: 0.01, glow: 0.28, markers: 0.12 },
    nearby: { base: 0.022, voice: 0.04, speed: 0.25, frequency: 1.35, jitter: 0.015, glow: 0.48, markers: 0.24 },
    away: { base: 0.006, voice: 0, speed: 0.06, frequency: 0.62, jitter: 0, glow: 0.16, markers: 0.05 },
  };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function visualState() {
    if (stateProfiles[target.state]) return target.state;
    if (target.energy < 0.16) return "sleep";
    if (target.anger > 0.55 || (target.stress > 0.68 && target.valence < 0.05)) return "angry";
    if (target.loneliness > 0.68 && target.valence < 0.2) return "lonely";
    if (target.valence > 0.42 && target.trust > 0.54) return "happy";
    return "idle";
  }

  function visualProfile() {
    return stateProfiles[visualState()] || stateProfiles.idle;
  }

  function palette() {
    const state = visualState();
    if (state === "sleep") return { line: "#d6d7ff", glow: "#7a6ff0", bg: "#677575" };
    if (state === "listening") return { line: "#effcff", glow: "#4cc9f0", bg: "#afc4ad" };
    if (state === "speaking") return { line: "#fbffd5", glow: "#d7ff46", bg: "#afc4ad" };
    if (state === "angry") return { line: "#fff2ec", glow: "#ff4f3e", bg: "#a98580" };
    if (state === "happy") return { line: "#fbffd5", glow: "#d7ff46", bg: "#b5c994" };
    if (state === "lonely") return { line: "#e8e6ff", glow: "#7a6ff0", bg: "#8084a0" };
    if (state === "thinking") return { line: "#effcff", glow: "#4cc9f0", bg: "#a9bdaa" };
    if (state === "away") return { line: "#d6e0e1", glow: "#687076", bg: "#6f7f7b" };

    const warm = clamp((target.valence + 1) / 2);
    const stressed = clamp(target.stress);
    const lonely = clamp(target.loneliness);
    const line = mixColor(mixColor("#effcff", "#fbffd5", warm), "#fff2ec", stressed * 0.55);
    const glow = mixColor(mixColor("#4cc9f0", "#d7ff46", warm), "#ff4f3e", stressed * 0.65);
    const bg = mixColor(mixColor("#afc4ad", "#b5c994", warm), "#8084a0", lonely * 0.45);
    return { line, glow, bg };
  }

  function setState(next = {}) {
    target.state = next.state || target.state;
    target.mood = next.mood || target.mood;
    target.energy = clamp(next.energy ?? target.energy);
    target.stress = clamp(next.stress ?? target.stress);
    target.curiosity = clamp(next.curiosity ?? target.curiosity);
    target.loneliness = clamp(next.loneliness ?? target.loneliness);
    target.dopamine = clamp((next.dopamine ?? target.dopamine) * 0.5 + 0.5);
    target.arousal = clamp(next.arousal ?? target.arousal);
    target.valence = clampSigned(next.valence ?? target.valence);
    target.dominance = clampSigned(next.dominance ?? target.dominance);
    target.trust = clamp(next.trust ?? target.trust);
    target.anger = clamp(next.anger ?? target.anger);
    target.boredom = clamp(next.boredom ?? target.boredom);
    target.voiceLevel = clamp(next.voiceLevel ?? target.voiceLevel);
    target.voicePitch = clamp(next.voicePitch ?? target.voicePitch);
    canvas.dataset.expressionState = visualState();
  }

  function drawBackground(width, height, colors) {
    const gradient = ctx.createRadialGradient(width * 0.5, height * 0.45, 0, width * 0.5, height * 0.5, width * 0.7);
    gradient.addColorStop(0, colors.bg);
    gradient.addColorStop(1, "#6f7f7b");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    const profile = visualProfile();
    ctx.globalAlpha = target.state === "sleep" ? 0.045 : 0.08 + profile.glow * 0.08;
    ctx.fillStyle = "#f8f4ea";
    for (let y = 0; y < height; y += 6) {
      ctx.fillRect(0, y, width, 1);
    }
    ctx.globalAlpha = 1;
  }

  function drawLifeLine(width, height, time, colors) {
    const centerY = height * 0.52;
    const span = width * 0.76;
    const startX = (width - span) / 2;
    const points = 96;
    const stability = clamp((current.dominance + 1) / 2);
    const state = visualState();
    const profile = visualProfile();
    const voice = state === "speaking" ? Math.max(current.voiceLevel, 0.18 + current.arousal * 0.2) : current.voiceLevel * profile.voice;
    const joy = clamp(current.valence) * 0.08 + current.dopamine * 0.08;
    const anger = state === "angry" ? 0.28 + current.stress * 0.22 : current.stress * 0.1;
    const loneliness = state === "lonely" ? current.loneliness * 0.08 : 0;
    const intensity = clamp(profile.base + voice * profile.voice + joy + anger + loneliness, 0.001, 0.95);
    const frequency = profile.frequency + current.voicePitch * profile.voice * 3.4 + current.curiosity * 0.9 + current.stress * 1.6;
    const phase = time * 0.001 * profile.speed * (0.35 + current.arousal * 1.3 + voice * 1.8);
    const motion = reducedMotion ? 0.15 : 1;
    const lineHeight = state === "sleep" ? height * 0.026 : height * 0.22;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = colors.glow;
    ctx.shadowBlur = 8 + profile.glow * 22 + intensity * 18;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = Math.max(2, height * (state === "sleep" ? 0.012 : 0.016 + intensity * 0.01));

    ctx.beginPath();
    for (let i = 0; i <= points; i += 1) {
      const t = i / points;
      const x = startX + t * span;
      const envelope = Math.sin(Math.PI * t);
      const harmonic =
        Math.sin(t * Math.PI * frequency + phase * 10) * 0.65 +
        Math.sin(t * Math.PI * (frequency * 2.17) - phase * 7) * 0.25 +
        Math.sin(t * Math.PI * (frequency * 0.47) + phase * 4) * 0.18;
      const hardJitter =
        Math.sin(time * 0.018 + i * 3.1) * profile.jitter * (0.45 + current.stress) * height * (1.2 - stability);
      const breath = Math.sin(time * 0.0007) * height * (state === "sleep" ? 0.006 : 0.002);
      const y = centerY + breath + (harmonic * envelope * lineHeight * intensity + hardJitter) * motion;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (state !== "sleep" && profile.glow > 0.18) {
      const glowWidth = span * (0.08 + intensity * 0.34);
      const glowX = startX + ((phase * 78 + time * 0.02 * current.curiosity) % span);
      const beam = ctx.createLinearGradient(glowX - glowWidth, 0, glowX + glowWidth, 0);
      beam.addColorStop(0, "rgba(255,255,255,0)");
      beam.addColorStop(0.5, `rgba(255,255,255,${0.08 + profile.glow * 0.24})`);
      beam.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = beam;
      ctx.fillRect(startX, centerY - height * 0.32, span, height * 0.64);
    }
  }

  function drawMarkers(width, height, time, colors) {
    const profile = visualProfile();
    if (profile.markers <= 0.03) return;
    const count = 9;
    const centerX = width * 0.5;
    const centerY = height * 0.52;
    const radiusX = width * 0.38;
    const radiusY = height * 0.2;
    ctx.fillStyle = colors.line;
    ctx.globalAlpha = profile.markers * (0.35 + current.curiosity * 0.65);
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + time * 0.00025 * profile.speed * (reducedMotion ? 0.1 : 1);
      const x = centerX + Math.cos(angle) * radiusX;
      const y = centerY + Math.sin(angle) * radiusY;
      const r = 0.9 + Math.sin(time * 0.001 + i) * 0.45 + current.dopamine * 1.1 + profile.markers * 1.2;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.6, r), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function animate(now) {
    raf = requestAnimationFrame(animate);
    resize();
    const width = canvas.width;
    const height = canvas.height;
    current.energy = smooth(current.energy, target.energy, 0.04);
    current.stress = smooth(current.stress, target.stress, 0.06);
    current.curiosity = smooth(current.curiosity, target.curiosity, 0.05);
    current.loneliness = smooth(current.loneliness, target.loneliness, 0.05);
    current.dopamine = smooth(current.dopamine, target.dopamine, 0.04);
    current.arousal = smooth(current.arousal, target.arousal, 0.05);
    current.valence = smooth(current.valence, target.valence, 0.05);
    current.dominance = smooth(current.dominance, target.dominance, 0.04);
    current.trust = smooth(current.trust, target.trust, 0.04);
    current.anger = smooth(current.anger, target.anger, 0.06);
    current.boredom = smooth(current.boredom, target.boredom, 0.04);
    current.voiceLevel = smooth(current.voiceLevel, target.voiceLevel, 0.14);
    current.voicePitch = smooth(current.voicePitch, target.voicePitch, 0.1);

    const colors = palette();
    drawBackground(width, height, colors);
    drawMarkers(width, height, now - startedAt, colors);
    drawLifeLine(width, height, now - startedAt, colors);
  }

  function setReducedMotion(value) {
    reducedMotion = Boolean(value);
  }

  function dispose() {
    cancelAnimationFrame(raf);
  }

  resize();
  animate(startedAt);

  return { setState, setReducedMotion, dispose };
}
