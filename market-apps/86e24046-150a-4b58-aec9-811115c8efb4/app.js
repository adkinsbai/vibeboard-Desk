const BUILD_ID = 'vb-mpy7la4q-f99b45';
const PROMPT = '做一个旋转的圆圈';

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
  getSnapshot: async function() {
    const status = await this.getStatus();
    const result = await this.getProgramResult();
    return { status, result, buildId: BUILD_ID, prompt: PROMPT };
  }
};

function updateUI(data) {
  const s = data || {};
  document.getElementById('status-value').textContent = s.hostname || '--';
  document.getElementById('temp-value').textContent = s.cpu_temp ? s.cpu_temp + 'C' : '--';
  if (s.memory) {
    document.getElementById('mem-value').textContent = s.memory.used_h + ' / ' + s.memory.total_h;
  } else {
    document.getElementById('mem-value').textContent = '--';
  }
  if (s.disk) {
    document.getElementById('disk-value').textContent = s.disk.used_h + ' / ' + s.disk.total_h;
  } else {
    document.getElementById('disk-value').textContent = '--';
  }
  document.getElementById('uptime-value').textContent = s.uptime || '--';
  document.getElementById('build-badge').textContent = BUILD_ID;
}

async function poll() {
  const hw = window.VibeBoardHardware;
  const snap = await hw.getSnapshot();
  if (snap.status && !snap.status.error) {
    updateUI(snap.status);
  } else {
    // keep last good values, show fallback
    document.getElementById('status-value').textContent = 'connecting...';
  }
}

// initial load
document.addEventListener('DOMContentLoaded', () => {
  poll();
  setInterval(poll, 5000);
});