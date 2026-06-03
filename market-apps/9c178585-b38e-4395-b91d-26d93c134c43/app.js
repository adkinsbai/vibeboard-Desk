const BUILD_ID = 'vb-mpy7pyts-9b3609';
const PROMPT = '贪吃蛇游戏，边界不死，有头';

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreValue = document.getElementById('score-value');
const buildInfo = document.getElementById('build-info');
const promptInfo = document.getElementById('prompt-info');

buildInfo.textContent = 'Build: ' + BUILD_ID;
promptInfo.textContent = 'Prompt: ' + PROMPT;

// Game constants
const GRID_SIZE = 15;
const TILE_SIZE = canvas.width / GRID_SIZE;

// Game state
let snake = [];
let food = { x: 7, y: 7 };
let direction = { x: 1, y: 0 };
let nextDirection = { x: 1, y: 0 };
let score = 0;
let gameOver = false;
let gameLoop = null;
let speed = 150;

// Hardware interface
window.VibeBoardHardware = {
  getStatus: function() {
    return fetch('/api/status')
      .then(r => r.json())
      .catch(() => ({ error: 'unavailable' }));
  },
  getProgramResult: function() {
    return fetch('./hardware-result.json')
      .then(r => r.json())
      .catch(() => ({ error: 'unavailable' }));
  },
  getSnapshot: function() {
    return canvas.toDataURL('image/png');
  }
};

// Initialize snake with a head and short body
function initGame() {
  snake = [
    { x: 7, y: 7 },  // head
    { x: 6, y: 7 },
    { x: 5, y: 7 }
  ];
  direction = { x: 1, y: 0 };
  nextDirection = { x: 1, y: 0 };
  score = 0;
  gameOver = false;
  scoreValue.textContent = '0';
  placeFood();
  draw();
}

function placeFood() {
  let freeCells = [];
  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE; j++) {
      if (!snake.some(s => s.x === i && s.y === j)) {
        freeCells.push({ x: i, y: j });
      }
    }
  }
  if (freeCells.length === 0) {
    // Win condition - full board
    gameOver = true;
    return;
  }
  const idx = Math.floor(Math.random() * freeCells.length);
  food = freeCells[idx];
}

function update() {
  if (gameOver) return;

  direction = { ...nextDirection };

  const head = snake[0];
  const newHead = {
    x: head.x + direction.x,
    y: head.y + direction.y
  };

  // Wrap around boundaries (no death)
  if (newHead.x < 0) newHead.x = GRID_SIZE - 1;
  if (newHead.x >= GRID_SIZE) newHead.x = 0;
  if (newHead.y < 0) newHead.y = GRID_SIZE - 1;
  if (newHead.y >= GRID_SIZE) newHead.y = 0;

  // Check if food eaten
  const ate = (newHead.x === food.x && newHead.y === food.y);

  // Move snake
  snake.unshift(newHead);
  if (!ate) {
    snake.pop();
  } else {
    score += 10;
    scoreValue.textContent = score;
    placeFood();
    if (gameOver) return;
  }

  // Self-collision check (skip head itself)
  const headCollision = snake.slice(1).some(s => s.x === newHead.x && s.y === newHead.y);
  if (headCollision) {
    // Wrap around: just continue, no death
    // But to avoid weirdness, we allow it - snake can overlap itself
    // Actually let's not kill, just let it pass through
  }

  draw();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw grid lines (subtle)
  ctx.strokeStyle = '#1a1a3e';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= GRID_SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(i * TILE_SIZE, 0);
    ctx.lineTo(i * TILE_SIZE, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * TILE_SIZE);
    ctx.lineTo(canvas.width, i * TILE_SIZE);
    ctx.stroke();
  }

  // Draw snake body (segments)
  for (let i = 1; i < snake.length; i++) {
    const s = snake[i];
    ctx.fillStyle = '#4caf50';
    ctx.shadowBlur = 4;
    ctx.shadowColor = '#4caf50';
    ctx.fillRect(s.x * TILE_SIZE + 1, s.y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
    ctx.shadowBlur = 0;
  }

  // Draw snake head (distinct, larger, with eyes)
  const head = snake[0];
  ctx.fillStyle = '#8bc34a';
  ctx.shadowBlur = 8;
  ctx.shadowColor = '#8bc34a';
  ctx.fillRect(head.x * TILE_SIZE, head.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
  ctx.shadowBlur = 0;
  // Eyes
  ctx.fillStyle = '#000';
  const eyeSize = 3;
  const eyeOffset = 4;
  if (direction.x === 1) {
    ctx.fillRect(head.x * TILE_SIZE + TILE_SIZE - eyeOffset - eyeSize, head.y * TILE_SIZE + eyeOffset, eyeSize, eyeSize);
    ctx.fillRect(head.x * TILE_SIZE + TILE_SIZE - eyeOffset - eyeSize, head.y * TILE_SIZE + TILE_SIZE - eyeOffset - eyeSize, eyeSize, eyeSize);
  } else if (direction.x === -1) {
    ctx.fillRect(head.x * TILE_SIZE + eyeOffset, head.y * TILE_SIZE + eyeOffset, eyeSize, eyeSize);
    ctx.fillRect(head.x * TILE_SIZE + eyeOffset, head.y * TILE_SIZE + TILE_SIZE - eyeOffset - eyeSize, eyeSize, eyeSize);
  } else if (direction.y === 1) {
    ctx.fillRect(head.x * TILE_SIZE + eyeOffset, head.y * TILE_SIZE + TILE_SIZE - eyeOffset - eyeSize, eyeSize, eyeSize);
    ctx.fillRect(head.x * TILE_SIZE + TILE_SIZE - eyeOffset - eyeSize, head.y * TILE_SIZE + TILE_SIZE - eyeOffset - eyeSize, eyeSize, eyeSize);
  } else if (direction.y === -1) {
    ctx.fillRect(head.x * TILE_SIZE + eyeOffset, head.y * TILE_SIZE + eyeOffset, eyeSize, eyeSize);
    ctx.fillRect(head.x * TILE_SIZE + TILE_SIZE - eyeOffset - eyeSize, head.y * TILE_SIZE + eyeOffset, eyeSize, eyeSize);
  }

  // Draw food (apple)
  ctx.fillStyle = '#e94560';
  ctx.shadowBlur = 10;
  ctx.shadowColor = '#e94560';
  ctx.beginPath();
  ctx.arc(food.x * TILE_SIZE + TILE_SIZE/2, food.y * TILE_SIZE + TILE_SIZE/2, TILE_SIZE/2 - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  // Stem
  ctx.fillStyle = '#4a2';
  ctx.fillRect(food.x * TILE_SIZE + TILE_SIZE/2 - 1, food.y * TILE_SIZE + 2, 2, 4);
}

// Keyboard controls
document.addEventListener('keydown', (e) => {
  if (gameOver) {
    if (e.key === ' ' || e.key === 'Enter') {
      initGame();
    }
    return;
  }
  switch (e.key) {
    case 'ArrowUp':
      if (direction.y !== 1) nextDirection = { x: 0, y: -1 };
      break;
    case 'ArrowDown':
      if (direction.y !== -1) nextDirection = { x: 0, y: 1 };
      break;
    case 'ArrowLeft':
      if (direction.x !== 1) nextDirection = { x: -1, y: 0 };
      break;
    case 'ArrowRight':
      if (direction.x !== -1) nextDirection = { x: 1, y: 0 };
      break;
  }
});

// Start game
initGame();
gameLoop = setInterval(update, speed);

// Fetch hardware status periodically
setInterval(() => {
  window.VibeBoardHardware.getStatus().then(data => {
    const indicator = document.getElementById('status-indicator');
    if (data && !data.error) {
      indicator.style.background = '#4caf50';
    } else {
      indicator.style.background = '#f44336';
    }
  }).catch(() => {
    document.getElementById('status-indicator').style.background = '#f44336';
  });
}, 5000);

// Fetch hardware result once
window.VibeBoardHardware.getProgramResult().then(data => {
  if (data && data.runtime) {
    console.log('Hardware runtime:', data.runtime);
  }
}).catch(() => {});