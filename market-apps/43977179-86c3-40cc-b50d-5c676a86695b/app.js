const BUILD_ID = 'vb-mpy9o0v7-ef1092';
const PROMPT = '帮我生成一个桌面的篮球';

window.VibeBoardHardware = {
  getStatus: async function() {
    try {
      const resp = await fetch('/api/status');
      if (!resp.ok) throw new Error('status fetch failed');
      return await resp.json();
    } catch (e) {
      return { error: e.message };
    }
  },
  getProgramResult: async function() {
    try {
      const resp = await fetch('./hardware-result.json');
      if (!resp.ok) throw new Error('result fetch failed');
      return await resp.json();
    } catch (e) {
      return { error: e.message };
    }
  },
  getSnapshot: function() {
    return {
      buildId: BUILD_ID,
      prompt: PROMPT,
      score: parseInt(document.getElementById('score-value').textContent),
      attempts: parseInt(document.getElementById('attempts-value').textContent),
      accuracy: document.getElementById('accuracy-value').textContent,
      timestamp: new Date().toISOString()
    };
  }
};

(function() {
  let score = 0;
  let attempts = 0;
  let hits = 0;
  let shooting = false;

  const ball = document.getElementById('ball');
  const scoreEl = document.getElementById('score-value');
  const attemptsEl = document.getElementById('attempts-value');
  const accuracyEl = document.getElementById('accuracy-value');
  const shootBtn = document.getElementById('shoot-btn');
  const resetBtn = document.getElementById('reset-btn');
  const statusBadge = document.getElementById('status-badge');
  const cpuTempEl = document.getElementById('cpu-temp');
  const memInfoEl = document.getElementById('mem-info');
  const uptimeInfoEl = document.getElementById('uptime-info');

  function updateAccuracy() {
    const acc = attempts === 0 ? 0 : Math.round((hits / attempts) * 100);
    accuracyEl.textContent = acc + '%';
  }

  function shoot() {
    if (shooting) return;
    shooting = true;
    shootBtn.disabled = true;
    statusBadge.textContent = '投篮中...';

    attempts++;
    attemptsEl.textContent = attempts;

    const isScore = Math.random() < 0.45;

    ball.className = '';
    void ball.offsetWidth;

    if (isScore) {
      ball.className = 'ball-scored';
      score++;
      hits++;
      scoreEl.textContent = score;
      statusBadge.textContent = '命中!';
    } else {
      ball.className = 'ball-shooting';
      statusBadge.textContent = '未中';
    }

    updateAccuracy();

    setTimeout(() => {
      ball.className = 'ball-idle';
      shooting = false;
      shootBtn.disabled = false;
      statusBadge.textContent = '准备就绪';
    }, isScore ? 800 : 600);
  }

  function resetGame() {
    if (shooting) return;
    score = 0;
    attempts = 0;
    hits = 0;
    scoreEl.textContent = '0';
    attemptsEl.textContent = '0';
    accuracyEl.textContent = '0%';
    ball.className = 'ball-idle';
    statusBadge.textContent = '已重置';
  }

  async function updateSystemInfo() {
    try {
      const status = await window.VibeBoardHardware.getStatus();
      if (status && !status.error) {
        cpuTempEl.textContent = 'CPU: ' + (status.cpu_temp || '--') + 'C';
        memInfoEl.textContent = 'MEM: ' + (status.memory?.percent || '--') + '%';
        uptimeInfoEl.textContent = '运行: ' + (status.uptime || '--');
      }
    } catch (e) {
      // silent fail
    }
  }

  shootBtn.addEventListener('click', shoot);
  resetBtn.addEventListener('click', resetGame);

  updateSystemInfo();
  setInterval(updateSystemInfo, 15000);

  statusBadge.textContent = '准备就绪';
})();
