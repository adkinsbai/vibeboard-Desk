// Mac screen overlay + background image drag/resize tool
// Press Ctrl+D to toggle debug mode

(function() {
  const macPhoto = document.querySelector('.mac-photo');
  const overlay = document.querySelector('.mac-screen-overlay');
  const macImg = document.querySelector('.mac-photo-img');
  if (!macPhoto || !overlay || !macImg) return;

  // Create UI
  const coordsDiv = document.createElement('div');
  coordsDiv.className = 'debug-coords';
  coordsDiv.innerHTML = `
    <div id="debugPanel" style="display:none">
      <div style="margin-bottom:8px;color:#fff;font-size:11px">
        <b>蓝色框</b>: 拖动移动 / 拖动边角调整大小 / 滚轮缩放<br>
        <b>背景图</b>: 按住 Shift 拖动移动 / Shift+滚轮缩放
      </div>
      <div id="coordsInfo" style="margin-bottom:8px"></div>
      <button id="confirmBtn" style="padding:4px 12px;background:#22c55e;color:#000;border:none;border-radius:4px;cursor:pointer;font-size:12px">✓ 确认位置</button>
      <button id="closeDebugBtn" style="padding:4px 12px;background:#ef4444;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;margin-left:6px">关闭</button>
    </div>
  `;
  document.body.appendChild(coordsDiv);

  const debugPanel = document.getElementById('debugPanel');
  const coordsInfo = document.getElementById('coordsInfo');
  const confirmBtn = document.getElementById('confirmBtn');
  const closeDebugBtn = document.getElementById('closeDebugBtn');

  let debugMode = false;

  // State
  let dragTarget = null;
  let dragEdge = null;
  let startMouseX, startMouseY;
  let startLeft, startTop, startWidth, startHeight;
  let imgScale = 1;
  let imgOffsetX = 0, imgOffsetY = 0;

  // Read current overlay values
  function readOverlay() {
    const cs = getComputedStyle(overlay);
    return {
      left: parseFloat(cs.left) / macPhoto.offsetWidth * 100,
      top: parseFloat(cs.top) / macPhoto.offsetHeight * 100,
      width: parseFloat(cs.width) / macPhoto.offsetWidth * 100,
      height: parseFloat(cs.height) / macPhoto.offsetHeight * 100
    };
  }

  function updateCoords() {
    const r = readOverlay();
    coordsInfo.innerHTML = `
      <div style="color:#38bdf8;margin-bottom:4px"><b>屏幕框 (蓝色)</b></div>
      <div>left: ${r.left.toFixed(1)}% &nbsp; top: ${r.top.toFixed(1)}%</div>
      <div>width: ${r.width.toFixed(1)}% &nbsp; height: ${r.height.toFixed(1)}%</div>
      <div style="color:#22c55e;margin-top:6px;margin-bottom:4px"><b>背景图</b></div>
      <div>scale: ${imgScale.toFixed(2)} &nbsp; offsetX: ${imgOffsetX.toFixed(0)}px &nbsp; offsetY: ${imgOffsetY.toFixed(0)}px</div>
    `;
  }

  function toggleDebug() {
    debugMode = !debugMode;
    debugPanel.style.display = debugMode ? 'block' : 'none';
    macPhoto.classList.toggle('debug-mode', debugMode);
    if (debugMode) {
      addHandles();
      updateCoords();
      overlay.style.pointerEvents = 'auto';
    } else {
      removeHandles();
      overlay.style.pointerEvents = '';
    }
  }

  function addHandles() {
    removeHandles();
    const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    handles.forEach(dir => {
      const h = document.createElement('div');
      h.className = 'resize-handle handle-' + dir;
      h.dataset.dir = dir;
      overlay.appendChild(h);
    });
  }

  function removeHandles() {
    overlay.querySelectorAll('.resize-handle').forEach(h => h.remove());
  }

  // Mouse down
  document.addEventListener('mousedown', (e) => {
    if (!debugMode) return;

    // Resize handle
    if (e.target.classList.contains('resize-handle')) {
      dragTarget = 'overlay';
      dragEdge = e.target.dataset.dir;
      startMouseX = e.clientX;
      startMouseY = e.clientY;
      const r = readOverlay();
      startLeft = r.left;
      startTop = r.top;
      startWidth = r.width;
      startHeight = r.height;
      e.preventDefault();
      return;
    }

    // Overlay move
    if (e.target === overlay) {
      if (e.shiftKey) return;
      dragTarget = 'overlay';
      dragEdge = 'move';
      startMouseX = e.clientX;
      startMouseY = e.clientY;
      const r = readOverlay();
      startLeft = r.left;
      startTop = r.top;
      e.preventDefault();
      return;
    }

    // Image move (Shift)
    if (e.shiftKey && e.target === macImg) {
      dragTarget = 'image';
      dragEdge = 'move';
      startMouseX = e.clientX;
      startMouseY = e.clientY;
      startLeft = imgOffsetX;
      startTop = imgOffsetY;
      e.preventDefault();
    }
  });

  // Mouse move
  document.addEventListener('mousemove', (e) => {
    if (!dragTarget) return;

    const rect = macPhoto.getBoundingClientRect();
    const dxPct = ((e.clientX - startMouseX) / rect.width) * 100;
    const dyPct = ((e.clientY - startMouseY) / rect.height) * 100;

    if (dragTarget === 'overlay') {
      if (dragEdge === 'move') {
        overlay.style.left = Math.max(0, Math.min(95, startLeft + dxPct)).toFixed(1) + '%';
        overlay.style.top = Math.max(0, Math.min(95, startTop + dyPct)).toFixed(1) + '%';
      } else {
        let newLeft = startLeft;
        let newTop = startTop;
        let newWidth = startWidth;
        let newHeight = startHeight;

        if (dragEdge.includes('e')) {
          newWidth = Math.max(5, Math.min(95 - startLeft, startWidth + dxPct));
        }
        if (dragEdge.includes('w')) {
          const maxDx = startWidth - 5;
          const clampedDx = Math.max(-startLeft, Math.min(maxDx, dxPct));
          newWidth = startWidth - clampedDx;
          newLeft = startLeft + clampedDx;
        }
        if (dragEdge.includes('s')) {
          newHeight = Math.max(3, Math.min(95 - startTop, startHeight + dyPct));
        }
        if (dragEdge.includes('n')) {
          const maxDy = startHeight - 3;
          const clampedDy = Math.max(-startTop, Math.min(maxDy, dyPct));
          newHeight = startHeight - clampedDy;
          newTop = startTop + clampedDy;
        }

        overlay.style.left = newLeft.toFixed(1) + '%';
        overlay.style.top = newTop.toFixed(1) + '%';
        overlay.style.width = newWidth.toFixed(1) + '%';
        overlay.style.height = newHeight.toFixed(1) + '%';
      }
    }

    if (dragTarget === 'image') {
      imgOffsetX = startLeft + (e.clientX - startMouseX);
      imgOffsetY = startTop + (e.clientY - startMouseY);
      macImg.style.transform = `translate(${imgOffsetX}px, ${imgOffsetY}px) scale(${imgScale})`;
    }

    updateCoords();
  });

  document.addEventListener('mouseup', () => {
    dragTarget = null;
    dragEdge = null;
  });

  // Scroll wheel
  macPhoto.addEventListener('wheel', (e) => {
    if (!debugMode) return;
    e.preventDefault();

    if (e.shiftKey) {
      // Scale image
      const factor = e.deltaY > 0 ? 0.95 : 1.05;
      imgScale = Math.max(0.3, Math.min(3, imgScale * factor));
      macImg.style.transform = `translate(${imgOffsetX}px, ${imgOffsetY}px) scale(${imgScale})`;
    } else {
      // Scale overlay
      const r = readOverlay();
      const dw = e.deltaY > 0 ? -0.5 : 0.5;
      const dh = dw * (r.height / r.width);
      const newW = Math.max(5, Math.min(80, r.width + dw));
      const newH = Math.max(3, Math.min(50, r.height + dh));
      overlay.style.width = newW.toFixed(1) + '%';
      overlay.style.height = newH.toFixed(1) + '%';
    }
    updateCoords();
  }, { passive: false });

  // Confirm button
  confirmBtn.addEventListener('click', () => {
    const r = readOverlay();
    const result = [
      '=== 屏幕框 ===',
      `left: ${r.left.toFixed(1)}%`,
      `top: ${r.top.toFixed(1)}%`,
      `width: ${r.width.toFixed(1)}%`,
      `height: ${r.height.toFixed(1)}%`,
      '',
      '=== 背景图 ===',
      `scale: ${imgScale.toFixed(2)}`,
      `offsetX: ${imgOffsetX.toFixed(0)}px`,
      `offsetY: ${imgOffsetY.toFixed(0)}px`
    ].join('\n');

    coordsInfo.innerHTML += `<pre style="background:#1a1a2e;padding:6px;margin-top:8px;border-radius:4px;white-space:pre-wrap;font-size:11px">${result}</pre>`;
    navigator.clipboard.writeText(result).then(() => {
      confirmBtn.textContent = '✓ 已复制';
      setTimeout(() => confirmBtn.textContent = '✓ 确认位置', 1500);
    });
  });

  // Close button
  closeDebugBtn.addEventListener('click', toggleDebug);

  // Ctrl+D toggle
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'd') {
      e.preventDefault();
      toggleDebug();
    }
  });
})();
