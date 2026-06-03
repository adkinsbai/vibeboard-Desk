const BUILD_ID = 'vb-mpyadigk-08b381';
const PROMPT = 'Racing game with arrow keys, avoid oncoming cars, game over on crash, SPACE to restart';

window.VibeBoardHardware = {
  getStatus: async function() {
    try {
      const resp = await fetch('/api/status');
      return await resp.json();
    } catch(e) {
      return {error: 'fetch failed', message: e.message};
    }
  },
  getProgramResult: async function() {
    try {
      const resp = await fetch('./hardware-result.json');
      return await resp.json();
    } catch(e) {
      return {error: 'fetch failed', message: e.message};
    }
  },
  getSnapshot: function() {
    const canvas = document.getElementById('gameCanvas');
    if (!canvas) return null;
    return canvas.toDataURL('image/png');
  }
};

(function() {
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const scoreDisplay = document.getElementById('scoreDisplay');
  const statusDisplay = document.getElementById('statusDisplay');
  const gameOverOverlay = document.getElementById('gameOverOverlay');
  const finalScore = document.getElementById('finalScore');

  // Game state
  let gameRunning = false;
  let score = 0;
  let frameId = null;

  // Player car
  const player = {
    x: 220,
    y: 300,
    width: 40,
    height: 50,
    speed: 4
  };

  // Oncoming cars
  let obstacles = [];
  const obstacleWidth = 40;
  const obstacleHeight = 50;
  const minGap = 60;
  const maxGap = 120;
  const obstacleSpeed = 3;
  let spawnCounter = 0;
  let spawnInterval = 40;

  // Road lanes (3 lanes)
  const lanes = [80, 220, 360];
  const laneWidth = 120;

  // Keys
  const keys = {
    ArrowUp: false,
    ArrowDown: false,
    ArrowLeft: false,
    ArrowRight: false
  };

  function resetGame() {
    gameRunning = true;
    score = 0;
    obstacles = [];
    spawnCounter = 0;
    spawnInterval = 40;
    player.x = 220;
    player.y = 300;
    gameOverOverlay.classList.add('hidden');
    statusDisplay.textContent = 'Running';
    scoreDisplay.textContent = 'Score: 0';
  }

  function gameOver() {
    gameRunning = false;
    statusDisplay.textContent = 'Game Over';
    finalScore.textContent = 'Score: ' + score;
    gameOverOverlay.classList.remove('hidden');
  }

  function spawnObstacle() {
    const laneIndex = Math.floor(Math.random() * 3);
    const x = lanes[laneIndex] - obstacleWidth / 2;
    obstacles.push({
      x: x,
      y: -obstacleHeight,
      width: obstacleWidth,
      height: obstacleHeight,
      lane: laneIndex
    });
  }

  function update() {
    if (!gameRunning) return;

    // Player movement
    if (keys.ArrowUp && player.y > 10) player.y -= player.speed;
    if (keys.ArrowDown && player.y < 310) player.y += player.speed;
    if (keys.ArrowLeft && player.x > 10) player.x -= player.speed;
    if (keys.ArrowRight && player.x < 430) player.x += player.speed;

    // Spawn obstacles
    spawnCounter++;
    if (spawnCounter >= spawnInterval) {
      spawnCounter = 0;
      spawnObstacle();
      // Gradually increase difficulty
      if (spawnInterval > 20) spawnInterval -= 0.5;
    }

    // Move obstacles
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const obs = obstacles[i];
      obs.y += obstacleSpeed;

      // Collision detection
      if (obs.y + obs.height > player.y && obs.y < player.y + player.height) {
        if (obs.x + obs.width > player.x && obs.x < player.x + player.width) {
          gameOver();
          return;
        }
      }

      // Remove if off screen
      if (obs.y > 360) {
        obstacles.splice(i, 1);
        score++;
        scoreDisplay.textContent = 'Score: ' + score;
      }
    }
  }

  function drawRoad() {
    // Road background
    ctx.fillStyle = '#2a2a3e';
    ctx.fillRect(0, 0, 480, 360);

    // Lane markings
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 15]);
    for (let i = 0; i < 3; i++) {
      const laneX = lanes[i];
      ctx.beginPath();
      ctx.moveTo(laneX, 0);
      ctx.lineTo(laneX, 360);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Road edges
    ctx.strokeStyle = '#ff0';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(10, 360);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(470, 0);
    ctx.lineTo(470, 360);
    ctx.stroke();
  }

  function drawPlayer() {
    ctx.fillStyle = '#00aaff';
    ctx.shadowColor = '#00aaff';
    ctx.shadowBlur = 10;
    ctx.fillRect(player.x, player.y, player.width, player.height);
    // Windshield
    ctx.fillStyle = '#88ddff';
    ctx.shadowBlur = 0;
    ctx.fillRect(player.x + 8, player.y + 8, 24, 12);
    // Wheels
    ctx.fillStyle = '#333';
    ctx.fillRect(player.x - 4, player.y + 6, 6, 12);
    ctx.fillRect(player.x + player.width - 2, player.y + 6, 6, 12);
    ctx.fillRect(player.x - 4, player.y + player.height - 18, 6, 12);
    ctx.fillRect(player.x + player.width - 2, player.y + player.height - 18, 6, 12);
    ctx.shadowBlur = 0;
  }

  function drawObstacles() {
    for (const obs of obstacles) {
      ctx.fillStyle = '#ff4444';
      ctx.shadowColor = '#ff4444';
      ctx.shadowBlur = 8;
      ctx.fillRect(obs.x, obs.y, obs.width, obs.height);
      // Windshield
      ctx.fillStyle = '#ffaaaa';
      ctx.shadowBlur = 0;
      ctx.fillRect(obs.x + 8, obs.y + 8, 24, 12);
      // Wheels
      ctx.fillStyle = '#333';
      ctx.fillRect(obs.x - 4, obs.y + 6, 6, 12);
      ctx.fillRect(obs.x + obs.width - 2, obs.y + 6, 6, 12);
      ctx.fillRect(obs.x - 4, obs.y + obs.height - 18, 6, 12);
      ctx.fillRect(obs.x + obs.width - 2, obs.y + obs.height - 18, 6, 12);
      ctx.shadowBlur = 0;
    }
  }

  function draw() {
    drawRoad();
    drawObstacles();
    drawPlayer();
  }

  function gameLoop() {
    update();
    draw();
    frameId = requestAnimationFrame(gameLoop);
  }

  // Keyboard controls
  document.addEventListener('keydown', function(e) {
    if (e.key === ' ') {
      e.preventDefault();
      if (!gameRunning) {
        resetGame();
      }
      return;
    }
    if (e.key in keys) {
      e.preventDefault();
      keys[e.key] = true;
    }
  });

  document.addEventListener('keyup', function(e) {
    if (e.key in keys) {
      e.preventDefault();
      keys[e.key] = false;
    }
  });

  // Start game
  resetGame();
  gameLoop();

  // Fetch hardware info for display (optional, not blocking)
  window.VibeBoardHardware.getStatus().then(function(data) {
    if (data && !data.error) {
      const hostEl = document.getElementById('hostname');
      const cpuEl = document.getElementById('cpuTemp');
      const memEl = document.getElementById('memory');
      const diskEl = document.getElementById('disk');
      const wifiEl = document.getElementById('wifi');
      const ipEl = document.getElementById('ip');
      if (hostEl) hostEl.textContent = data.hostname || '-';
      if (cpuEl) cpuEl.textContent = data.cpu_temp || '-';
      if (memEl && data.memory) memEl.textContent = data.memory.used_h + '/' + data.memory.total_h;
      if (diskEl && data.disk) diskEl.textContent = data.disk.used_h + '/' + data.disk.total_h;
      if (wifiEl && data.network) wifiEl.textContent = data.network.wifi || '-';
      if (ipEl && data.network && data.network.addresses) ipEl.textContent = data.network.addresses[0] || '-';
    }
  }).catch(function(){});
})();
