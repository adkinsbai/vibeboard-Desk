const BUILD_ID = 'vb-mpy89n16-6787ab';
const PROMPT = '帮我做一个像素化背景的庄园，里面有两个小人在到处乱走，还有一头牛';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Pixel manor entities
const manor = {
  ground: 280,
  houseX: 60,
  houseY: 180,
  barnX: 340,
  barnY: 200,
  treePositions: [
    {x: 20, y: 200}, {x: 440, y: 180}, {x: 120, y: 260}, {x: 380, y: 280}
  ],
  fenceSegments: [
    {x1: 0, y1: 300, x2: 480, y2: 300},
    {x1: 0, y1: 310, x2: 480, y2: 310}
  ]
};

// Two little people + one cow
const people = [
  {x: 100, y: 250, dir: 1, speed: 0.4, color: '#c44'},
  {x: 300, y: 240, dir: -1, speed: 0.3, color: '#48c'}
];
const cow = {x: 200, y: 270, dir: 1, speed: 0.2, color: '#ba9'};

function drawPixelRect(x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.floor(x), Math.floor(y), w, h);
}

function drawPixelatedBackground() {
  // Sky gradient (pixel bands)
  for (let i = 0; i < 18; i++) {
    const shade = 100 + i * 6;
    ctx.fillStyle = `rgb(60, ${shade}, 120)`;
    ctx.fillRect(0, i * 20, 480, 20);
  }
  // Ground
  ctx.fillStyle = '#4a7a3a';
  ctx.fillRect(0, manor.ground, 480, 80);
  // Grass texture
  for (let i = 0; i < 60; i++) {
    const gx = Math.floor(Math.random() * 480);
    const gy = manor.ground + Math.floor(Math.random() * 80);
    ctx.fillStyle = ['#5a8a4a','#3a6a2a','#6a9a5a'][Math.floor(Math.random()*3)];
    ctx.fillRect(gx, gy, 4, 4);
  }
}

function drawHouse() {
  const hx = manor.houseX, hy = manor.houseY;
  // Walls
  drawPixelRect(hx, hy, 80, 60, '#8b6b4b');
  // Roof
  ctx.fillStyle = '#6a3a2a';
  ctx.beginPath();
  ctx.moveTo(hx-10, hy);
  ctx.lineTo(hx+40, hy-30);
  ctx.lineTo(hx+90, hy);
  ctx.closePath();
  ctx.fill();
  // Door
  drawPixelRect(hx+30, hy+30, 20, 30, '#4a2a1a');
  // Windows
  drawPixelRect(hx+10, hy+15, 15, 15, '#aad4ff');
  drawPixelRect(hx+55, hy+15, 15, 15, '#aad4ff');
}

function drawBarn() {
  const bx = manor.barnX, by = manor.barnY;
  drawPixelRect(bx, by, 70, 50, '#7a4a2a');
  ctx.fillStyle = '#5a3a1a';
  ctx.beginPath();
  ctx.moveTo(bx-5, by);
  ctx.lineTo(bx+35, by-25);
  ctx.lineTo(bx+75, by);
  ctx.closePath();
  ctx.fill();
  drawPixelRect(bx+25, by+20, 20, 30, '#3a2a1a');
}

function drawTrees() {
  manor.treePositions.forEach(t => {
    drawPixelRect(t.x, t.y, 8, 20, '#5a3a1a');
    ctx.fillStyle = '#2a6a2a';
    ctx.beginPath();
    ctx.arc(t.x+4, t.y-6, 14, 0, Math.PI*2);
    ctx.fill();
  });
}

function drawFence() {
  ctx.strokeStyle = '#6a4a2a';
  ctx.lineWidth = 3;
  manor.fenceSegments.forEach(f => {
    ctx.beginPath();
    ctx.moveTo(f.x1, f.y1);
    ctx.lineTo(f.x2, f.y2);
    ctx.stroke();
  });
  // posts
  for (let x = 0; x < 480; x += 40) {
    drawPixelRect(x, 295, 4, 20, '#5a3a1a');
  }
}

function drawPerson(p) {
  // Body
  drawPixelRect(p.x-3, p.y-12, 6, 12, p.color);
  // Head
  drawPixelRect(p.x-4, p.y-18, 8, 8, '#f0c8a0');
  // Legs
  drawPixelRect(p.x-3, p.y, 3, 8, '#333');
  drawPixelRect(p.x, p.y, 3, 8, '#333');
  // Arms
  drawPixelRect(p.x-6, p.y-10, 3, 6, p.color);
  drawPixelRect(p.x+3, p.y-10, 3, 6, p.color);
}

function drawCow(c) {
  // Body
  drawPixelRect(c.x-8, c.y-8, 16, 10, c.color);
  // Head
  drawPixelRect(c.x+10, c.y-10, 8, 8, c.color);
  // Legs
  drawPixelRect(c.x-6, c.y+2, 3, 8, '#666');
  drawPixelRect(c.x+3, c.y+2, 3, 8, '#666');
  // Horns
  drawPixelRect(c.x+12, c.y-14, 2, 4, '#ddd');
  drawPixelRect(c.x+16, c.y-14, 2, 4, '#ddd');
  // Eye
  drawPixelRect(c.x+13, c.y-8, 2, 2, '#222');
}

function updateEntities() {
  people.forEach(p => {
    p.x += p.dir * p.speed;
    if (p.x < 20 || p.x > 460) p.dir *= -1;
    // occasional random direction change
    if (Math.random() < 0.01) p.dir *= -1;
  });
  cow.x += cow.dir * cow.speed;
  if (cow.x < 30 || cow.x > 450) cow.dir *= -1;
  if (Math.random() < 0.005) cow.dir *= -1;
}

function drawScene() {
  ctx.clearRect(0, 0, 480, 360);
  drawPixelatedBackground();
  drawFence();
  drawTrees();
  drawHouse();
  drawBarn();
  people.forEach(drawPerson);
  drawCow(cow);
}

function loop() {
  updateEntities();
  drawScene();
  requestAnimationFrame(loop);
}

// Hardware interface
window.VibeBoardHardware = {
  getStatus: async function() {
    try {
      const resp = await fetch('/api/status');
      return await resp.json();
    } catch(e) {
      return {error: 'status unavailable'};
    }
  },
  getProgramResult: async function() {
    try {
      const resp = await fetch('./hardware-result.json');
      return await resp.json();
    } catch(e) {
      return {error: 'result unavailable'};
    }
  },
  getSnapshot: function() {
    return canvas.toDataURL('image/png');
  }
};

// Start
loop();

// Periodic status check (non-blocking)
setInterval(async () => {
  const status = await window.VibeBoardHardware.getStatus();
  const indicator = document.getElementById('status-indicator');
  if (status && !status.error) {
    indicator.style.color = '#7f7';
  } else {
    indicator.style.color = '#f77';
  }
}, 10000);