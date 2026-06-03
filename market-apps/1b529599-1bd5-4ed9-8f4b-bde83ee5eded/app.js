const BUILD_ID = 'vb-mpya9p0j-4f4459';
const PROMPT = '给我生成一个虚拟的热带鱼缸，里面有海草和鱼，还有石头';

window.VibeBoardHardware = {
  getStatus: async function() {
    try {
      const resp = await fetch('/api/status');
      return await resp.json();
    } catch(e) {
      return { error: 'fetch_failed', detail: e.message };
    }
  },
  getProgramResult: async function() {
    try {
      const resp = await fetch('./hardware-result.json');
      return await resp.json();
    } catch(e) {
      return { error: 'fetch_failed', detail: e.message };
    }
  },
  getSnapshot: async function() {
    return { build_id: BUILD_ID, prompt: PROMPT, timestamp: Date.now() };
  }
};

(function() {
  const canvas = document.getElementById('tankCanvas');
  const ctx = canvas.getContext('2d');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  // Fish data
  const fishList = [];
  const NUM_FISH = 6;
  const FISH_COLORS = ['#ff6b6b','#ffa94d','#ffd43b','#69db7c','#4dabf7','#da77f2'];
  for (let i = 0; i < NUM_FISH; i++) {
    fishList.push({
      x: 60 + Math.random() * 360,
      y: 80 + Math.random() * 200,
      vx: (0.3 + Math.random() * 0.6) * (Math.random() > 0.5 ? 1 : -1),
      vy: (0.1 + Math.random() * 0.3) * (Math.random() > 0.5 ? 1 : -1),
      color: FISH_COLORS[i % FISH_COLORS.length],
      size: 8 + Math.random() * 6,
      tailPhase: Math.random() * Math.PI * 2
    });
  }

  // Seaweed data
  const seaweedList = [];
  for (let i = 0; i < 8; i++) {
    seaweedList.push({
      x: 30 + i * 55 + Math.random() * 20,
      height: 60 + Math.random() * 80,
      sway: Math.random() * 0.4 + 0.2,
      phase: Math.random() * Math.PI * 2,
      color: `hsl(${120 + Math.random() * 30}, 70%, ${35 + Math.random() * 20}%)`
    });
  }

  // Rocks
  const rocks = [
    { x: 30, y: 290, w: 60, h: 40, color: '#5a4a3a' },
    { x: 100, y: 280, w: 50, h: 50, color: '#6b5b4b' },
    { x: 180, y: 295, w: 70, h: 35, color: '#4d3e2e' },
    { x: 280, y: 285, w: 55, h: 45, color: '#5e4e3e' },
    { x: 370, y: 290, w: 65, h: 40, color: '#6a5a4a' },
    { x: 430, y: 300, w: 40, h: 30, color: '#4f3f2f' }
  ];

  // Bubbles
  const bubbles = [];
  for (let i = 0; i < 12; i++) {
    bubbles.push({
      x: Math.random() * 480,
      y: 300 + Math.random() * 60,
      r: 2 + Math.random() * 4,
      speed: 0.2 + Math.random() * 0.4,
      wobble: Math.random() * 0.5
    });
  }

  let time = 0;

  function drawBackground() {
    // Water gradient
    const grad = ctx.createLinearGradient(0, 0, 0, 360);
    grad.addColorStop(0, '#0a2a4a');
    grad.addColorStop(0.5, '#0d3d5c');
    grad.addColorStop(1, '#0a2a3a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 480, 360);

    // Sandy bottom
    ctx.fillStyle = '#c4a882';
    ctx.beginPath();
    ctx.rect(0, 300, 480, 60);
    ctx.fill();
    ctx.fillStyle = '#b89b72';
    for (let i = 0; i < 30; i++) {
      ctx.beginPath();
      ctx.arc(Math.random() * 480, 300 + Math.random() * 60, 2 + Math.random() * 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawRocks() {
    for (const r of rocks) {
      ctx.fillStyle = r.color;
      ctx.beginPath();
      ctx.ellipse(r.x + r.w/2, r.y + r.h/2, r.w/2, r.h/2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.ellipse(r.x + r.w/2 - 5, r.y + r.h/2 - 5, r.w/4, r.h/4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawSeaweed(t) {
    for (const s of seaweedList) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const segments = 10;
      for (let i = 0; i <= segments; i++) {
        const y = 300 - (s.height * i / segments);
        const swayOffset = Math.sin(t * s.sway + i * 0.5 + s.phase) * 8;
        const x = s.x + swayOffset;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // Leaf detail
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 3;
      for (let i = 2; i < segments; i += 3) {
        const y = 300 - (s.height * i / segments);
        const swayOffset = Math.sin(t * s.sway + i * 0.5 + s.phase) * 8;
        const x = s.x + swayOffset;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 10, y - 8);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 10, y - 8);
        ctx.stroke();
      }
    }
  }

  function drawFish(t) {
    for (const f of fishList) {
      // Body
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, f.size * 1.2, f.size * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      // Tail
      ctx.fillStyle = f.color;
      ctx.beginPath();
      const tailWag = Math.sin(t * 3 + f.tailPhase) * 4;
      ctx.moveTo(f.x - f.size * 1.1, f.y);
      ctx.lineTo(f.x - f.size * 1.8, f.y - 6 + tailWag);
      ctx.lineTo(f.x - f.size * 1.8, f.y + 6 + tailWag);
      ctx.closePath();
      ctx.fill();
      // Eye
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(f.x + f.size * 0.4, f.y - 2, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.arc(f.x + f.size * 0.5, f.y - 2, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function updateFish() {
    for (const f of fishList) {
      f.x += f.vx;
      f.y += f.vy;
      if (f.x < 20 || f.x > 460) f.vx *= -1;
      if (f.y < 40 || f.y > 270) f.vy *= -1;
      // Gentle random turn
      if (Math.random() < 0.005) {
        f.vx += (Math.random() - 0.5) * 0.2;
        f.vy += (Math.random() - 0.5) * 0.2;
        const mag = Math.sqrt(f.vx*f.vx + f.vy*f.vy);
        if (mag > 1.0) { f.vx /= mag; f.vy /= mag; }
      }
    }
  }

  function drawBubbles(t) {
    ctx.fillStyle = 'rgba(200,230,255,0.3)';
    for (const b of bubbles) {
      b.y -= b.speed;
      b.x += Math.sin(t + b.wobble) * 0.3;
      if (b.y < -10) { b.y = 310; b.x = Math.random() * 480; }
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      // Highlight
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.arc(b.x - 1, b.y - 1, b.r * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(200,230,255,0.3)';
    }
  }

  function updateStatus() {
    window.VibeBoardHardware.getStatus().then(data => {
      if (data && !data.error) {
        statusDot.className = 'dot';
        statusText.textContent = 'Board: ' + (data.hostname || 'online');
      } else {
        statusDot.className = 'dot offline';
        statusText.textContent = 'Offline';
      }
    }).catch(() => {
      statusDot.className = 'dot offline';
      statusText.textContent = 'Offline';
    });
  }

  function animate() {
    time += 0.02;
    updateFish();
    drawBackground();
    drawRocks();
    drawSeaweed(time);
    drawBubbles(time);
    drawFish(time);
    requestAnimationFrame(animate);
  }

  updateStatus();
  setInterval(updateStatus, 15000);
  animate();
})();