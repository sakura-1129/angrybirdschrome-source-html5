// Angry Birds 经典空中飞鼠 (Air Mouse) 终极优化版
(function() {
  console.log('[Gesture] 初始化经典空中飞鼠系统...');

  // 摄像头与识别核心
  let cameraStream = null;
  let handsDetector = null;
  let isCameraActive = false;
  let isGrabbing = false;
  let lastGrabState = false;
  let isMinimized = false;

  let grabStartX = 0;
  let grabStartY = 0;

  // 灵敏度倍率：默认 2.4x (小范围挥动覆盖全屏，手绝不出画)
  let sensitivity = 2.4; 

  // 坐标平滑 (动态自适应滤波：快动跟手、慢动抗抖)
  let smoothX = 0.5;
  let smoothY = 0.5;

  // 防抖投票机制 (3 帧抓取确认，2 帧释放确认，彻底消除拉弓中途误滑脱)
  let grabConfidence = 0;
  const CONFIRM_GRAB_FRAMES = 3;   
  const CONFIRM_RELEASE_FRAMES = 2; 

  // 手势模式：'both' (捏合或握拳), 'pinch' (仅指尖捏合), 'fist' (仅手掌抓拳)
  let gestureMode = 'both'; 

  // 并发互斥锁与心跳防假死 (彻底杜绝掉线)
  let isProcessingFrame = false;
  let lastFrameSentTime = 0;
  let lastResultTime = Date.now();
  let watchdogTimer = null;
  let freezeCounter = 0;
  const TARGET_FRAME_INTERVAL = 30; // 稳定 ~33 FPS

  // DOM 元素引用
  let container, videoEl, canvasEl, ctx, badgeEl, pointerEl, toggleBtn, minBtn;
  let sensValEl, modeBtnEl;

  function createUI() {
    container = document.createElement('div');
    container.id = 'gesture-container';
    container.innerHTML = `
      <div id="gesture-min-icon" title="点击展开飞鼠面板">🖱️</div>
      <div id="gesture-header">
        <span id="gesture-header-title">🖱️ 空中飞鼠</span>
        <div style="display:flex; gap:4px;">
          <button id="gesture-toggle-btn" class="gesture-btn">开启</button>
          <button id="gesture-min-btn" class="gesture-btn" title="折叠">−</button>
        </div>
      </div>
      <div id="gesture-video-wrapper">
        <video id="gesture-video" autoplay playsinline muted></video>
        <canvas id="gesture-canvas" width="240" height="180"></canvas>
      </div>
      <div id="gesture-status">
        <span style="font-size:11px; color:#aaa;">飞鼠状态:</span>
        <span id="gesture-badge" class="gesture-badge badge-idle">等待开启</span>
      </div>
      <div id="gesture-controls">
        <div class="control-row">
          <span>活动灵敏度:</span>
          <div style="display:flex; align-items:center; gap:4px;">
            <button id="sens-dec" class="step-btn">−</button>
            <span id="sens-val" style="font-weight:bold; color:#ffcc00; width:28px; text-align:center;">2.4x</span>
            <button id="sens-inc" class="step-btn">+</button>
          </div>
        </div>
        <div class="control-row">
          <span>按键手势:</span>
          <button id="mode-btn" class="gesture-btn" style="background:#2b3a55; border:1px solid #4a638f;">捏合+握拳</button>
        </div>
      </div>
    `;
    document.body.appendChild(container);

    // 屏幕上的飞鼠准星
    pointerEl = document.createElement('div');
    pointerEl.id = 'gesture-pointer';
    document.body.appendChild(pointerEl);

    videoEl = document.getElementById('gesture-video');
    canvasEl = document.getElementById('gesture-canvas');
    ctx = canvasEl.getContext('2d');
    badgeEl = document.getElementById('gesture-badge');
    toggleBtn = document.getElementById('gesture-toggle-btn');
    minBtn = document.getElementById('gesture-min-btn');
    sensValEl = document.getElementById('sens-val');
    modeBtnEl = document.getElementById('mode-btn');

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCamera();
    });

    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMinimize();
    });

    container.addEventListener('click', () => {
      if (isMinimized) toggleMinimize();
    });

    // 灵敏度加减按钮
    document.getElementById('sens-dec').addEventListener('click', (e) => {
      e.stopPropagation();
      sensitivity = Math.max(1.2, +(sensitivity - 0.3).toFixed(1));
      sensValEl.textContent = sensitivity + 'x';
    });

    document.getElementById('sens-inc').addEventListener('click', (e) => {
      e.stopPropagation();
      sensitivity = Math.min(4.0, +(sensitivity + 0.3).toFixed(1));
      sensValEl.textContent = sensitivity + 'x';
    });

    // 手势模式切换
    modeBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (gestureMode === 'both') {
        gestureMode = 'pinch';
        modeBtnEl.textContent = '仅指尖捏合';
        modeBtnEl.style.borderColor = '#00f0ff';
      } else if (gestureMode === 'pinch') {
        gestureMode = 'fist';
        modeBtnEl.textContent = '仅手掌抓拳';
        modeBtnEl.style.borderColor = '#ff3300';
      } else {
        gestureMode = 'both';
        modeBtnEl.textContent = '捏合+握拳';
        modeBtnEl.style.borderColor = '#4a638f';
      }
    });

    makeDraggable(container, document.getElementById('gesture-header'));

    if (window.location.protocol === 'file:') {
      badgeEl.textContent = '请用bat启动';
      badgeEl.className = 'gesture-badge badge-grab';
    }
  }

  function toggleMinimize() {
    isMinimized = !isMinimized;
    if (isMinimized) {
      container.classList.add('minimized');
    } else {
      container.classList.remove('minimized');
    }
  }

  function makeDraggable(el, handle) {
    let p1 = 0, p2 = 0, p3 = 0, p4 = 0;
    handle.onmousedown = (e) => {
      e.preventDefault();
      p3 = e.clientX;
      p4 = e.clientY;
      document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
      document.onmousemove = (ev) => {
        ev.preventDefault();
        p1 = p3 - ev.clientX;
        p2 = p4 - ev.clientY;
        p3 = ev.clientX;
        p4 = ev.clientY;
        el.style.top = (el.offsetTop - p2) + "px";
        el.style.left = (el.offsetLeft - p1) + "px";
        el.style.bottom = "auto";
        el.style.right = "auto";
      };
    };
  }

  function loadLocalScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.charset = 'utf-8';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed: ' + src));
      document.head.appendChild(script);
    });
  }

  async function initLocalMediaPipe() {
    badgeEl.textContent = '载入模型...';
    try {
      if (typeof Hands === 'undefined') {
        await loadLocalScript('mediapipe/camera_utils/camera_utils.js');
        await loadLocalScript('mediapipe/hands/hands.js');
      }

      handsDetector = new Hands({
        locateFile: (file) => 'mediapipe/hands/' + file
      });

      handsDetector.setOptions({
        maxNumHands: 1,
        modelComplexity: 0,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5
      });

      handsDetector.onResults(onHandResults);
      console.log('[Gesture] 本地 MediaPipe 准备完毕');
      return true;
    } catch (err) {
      console.error('[Gesture] 模型失败:', err);
      badgeEl.textContent = '模型失败';
      return false;
    }
  }

  async function getCameraStreamRobust() {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } }
      });
    } catch (e1) {}

    try {
      return await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (e2) {}

    if (navigator.mediaDevices.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevs = devices.filter(d => d.kind === 'videoinput');
      for (const dev of videoDevs) {
        try {
          return await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: dev.deviceId } }
          });
        } catch (e3) {}
      }
    }
    throw new Error('NotReadableError');
  }

  async function toggleCamera() {
    if (isCameraActive) {
      stopCamera();
    } else {
      await startCamera();
    }
  }

  async function startCamera() {
    if (window.location.protocol === 'file:') {
      alert('请双击运行【一键启动.bat】打开游戏！');
      return;
    }

    toggleBtn.disabled = true;
    toggleBtn.textContent = '启动...';
    badgeEl.textContent = '连接镜头...';

    try {
      cameraStream = await getCameraStreamRobust();
      videoEl.srcObject = cameraStream;
      await videoEl.play();

      isCameraActive = true;
      toggleBtn.textContent = '关闭';
      toggleBtn.disabled = false;
      badgeEl.textContent = '🟢 飞鼠就绪';
      badgeEl.className = 'gesture-badge badge-hover';
      pointerEl.style.display = 'block';

      if (!handsDetector) {
        await initLocalMediaPipe();
      }

      startWatchdog();
      processFrame();
    } catch (err) {
      console.error('[Gesture] 启动失败:', err);
      toggleBtn.disabled = false;
      toggleBtn.textContent = '开启';
      badgeEl.textContent = '启动失败';
      badgeEl.className = 'gesture-badge badge-grab';
      alert('无法开启摄像头，请检查权限或设备连接！');
    }
  }

  function stopCamera() {
    stopWatchdog();
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    videoEl.srcObject = null;
    isCameraActive = false;
    toggleBtn.textContent = '开启';
    badgeEl.textContent = '已关闭';
    badgeEl.className = 'gesture-badge badge-idle';
    pointerEl.style.display = 'none';

    if (isGrabbing) triggerRelease();
  }

  function startWatchdog() {
    stopWatchdog();
    lastResultTime = Date.now();
    freezeCounter = 0;

    watchdogTimer = setInterval(async () => {
      if (!isCameraActive) return;

      const silenceMs = Date.now() - lastResultTime;
      if (silenceMs > 2500 && videoEl.readyState >= 2) {
        freezeCounter++;
        console.warn(`[Gesture] 飞鼠引擎疑似掉线 (${silenceMs}ms)，自动恢复...`);
        badgeEl.textContent = '🔄 自动恢复中';
        badgeEl.className = 'gesture-badge badge-idle';

        isProcessingFrame = false;

        if (freezeCounter >= 2) {
          try {
            await initLocalMediaPipe();
            freezeCounter = 0;
            console.log('[Gesture] 飞鼠引擎已热重置并恢复！');
          } catch (e) {
            console.error('[Gesture] 热重置失败:', e);
          }
        }
        lastResultTime = Date.now();
      }
    }, 1000);
  }

  function stopWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  async function processFrame() {
    if (!isCameraActive) return;

    const now = performance.now();
    if ((now - lastFrameSentTime >= TARGET_FRAME_INTERVAL) && !isProcessingFrame) {
      if (videoEl.readyState >= 2 && handsDetector) {
        isProcessingFrame = true;
        lastFrameSentTime = now;
        try {
          await handsDetector.send({ image: videoEl });
        } catch (e) {
          console.warn('[Gesture] 单帧波动跳过:', e);
        } finally {
          isProcessingFrame = false;
        }
      }
    }

    if (videoEl.paused && isCameraActive) {
      videoEl.play().catch(() => {});
    }

    requestAnimationFrame(processFrame);
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function getGameTarget() {
    return document.querySelector('#playn-root canvas') || 
           document.querySelector('canvas') || 
           document.getElementById('playn-root');
  }

  function dispatchGameMouseEvent(type, clientX, clientY) {
    const target = getGameTarget();
    if (!target) return;

    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: clientX,
      clientY: clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      buttons: (type === 'mouseup') ? 0 : 1
    });

    target.dispatchEvent(event);

    const topEl = document.elementFromPoint(clientX, clientY);
    if (topEl && topEl !== target && topEl !== pointerEl && !container.contains(topEl)) {
      topEl.dispatchEvent(event);
    }
  }

  function triggerGrab(clientX, clientY) {
    isGrabbing = true;
    grabStartX = clientX;
    grabStartY = clientY;
    badgeEl.textContent = '✊ 蓄力拉弓中';
    badgeEl.className = 'gesture-badge badge-grab';
    pointerEl.className = 'pointer-grab';
    dispatchGameMouseEvent('mousedown', clientX, clientY);
  }

  function triggerDrag(clientX, clientY) {
    dispatchGameMouseEvent('mousemove', clientX, clientY);
  }

  function triggerRelease(clientX, clientY) {
    isGrabbing = false;
    badgeEl.textContent = '🚀 发射！';
    badgeEl.className = 'gesture-badge badge-hover';
    pointerEl.className = '';

    const target = getGameTarget();
    if (target && (clientX === undefined || clientY === undefined)) {
      const rect = target.getBoundingClientRect();
      clientX = rect.left + smoothX * rect.width;
      clientY = rect.top + smoothY * rect.height;
    }

    dispatchGameMouseEvent('mouseup', clientX, clientY);

    const dragDist = Math.hypot(clientX - grabStartX, clientY - grabStartY);
    if (dragDist < 25) {
      dispatchGameMouseEvent('click', clientX, clientY);
    }

    setTimeout(() => {
      if (!isGrabbing && isCameraActive) {
        badgeEl.textContent = '🖐 瞄准移动中';
        badgeEl.className = 'gesture-badge badge-hover';
      }
    }, 350);
  }

  function isFingerCurled(landmarks, tipIdx, pipIdx) {
    const wrist = landmarks[0];
    const dTip = Math.hypot(landmarks[tipIdx].x - wrist.x, landmarks[tipIdx].y - wrist.y);
    const dPip = Math.hypot(landmarks[pipIdx].x - wrist.x, landmarks[pipIdx].y - wrist.y);
    return dTip < (dPip * 1.02);
  }

  function drawHandTargetBox(landmarks) {
    const w = canvasEl.width;
    const h = canvasEl.height;
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    landmarks.forEach(pt => {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    });

    const padX = (maxX - minX) * 0.15;
    const padY = (maxY - minY) * 0.15;
    const bx = Math.max(0, minX - padX) * w;
    const by = Math.max(0, minY - padY) * h;
    const bw = Math.min(w, (maxX - minX + padX * 2) * w);
    const bh = Math.min(h, (maxY - minY + padY * 2) * h);

    ctx.strokeStyle = isGrabbing ? '#ff3300' : '#00f0ff';
    ctx.lineWidth = 2.5;
    const len = 12;

    ctx.beginPath();
    ctx.moveTo(bx, by + len); ctx.lineTo(bx, by); ctx.lineTo(bx + len, by);
    ctx.moveTo(bx + bw - len, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + len);
    ctx.moveTo(bx, by + bh - len); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + len, by + bh);
    ctx.moveTo(bx + bw - len, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - len);
    ctx.stroke();
  }

  function onHandResults(results) {
    lastResultTime = Date.now();
    freezeCounter = 0;

    try {
      const w = canvasEl.width;
      const h = canvasEl.height;
      ctx.clearRect(0, 0, w, h);

      // 胸前/桌面舒适高度映射（手微动即可覆盖全屏，绝不出画）
      const spanX = 0.52 / (sensitivity / 2.0);
      const spanY = 0.48 / (sensitivity / 2.0);
      const zoneMinX = 0.5 - spanX / 2;
      const zoneMaxX = 0.5 + spanX / 2;
      const zoneMinY = 0.62 - spanY / 2; 
      const zoneMaxY = 0.62 + spanY / 2;

      if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        if (isGrabbing) triggerRelease();
        grabConfidence = 0;
        badgeEl.textContent = '请伸出手掌';
        badgeEl.className = 'gesture-badge badge-idle';
        return;
      }

      const landmarks = results.multiHandLandmarks[0];

      drawHandSkeleton(landmarks);
      drawHandTargetBox(landmarks);

      const thumbTip = landmarks[4];
      const indexTip = landmarks[8];
      const indexMcp = landmarks[5];
      const pinkyMcp = landmarks[17];

      // 1. 坐标映射 (胸前人体工程学映射)
      const rawX = 1.0 - (thumbTip.x + indexTip.x) / 2;
      const rawY = (thumbTip.y + indexTip.y) / 2;

      const targetNormX = clamp((rawX - zoneMinX) / (zoneMaxX - zoneMinX), 0, 1);
      const targetNormY = clamp((rawY - zoneMinY) / (zoneMaxY - zoneMinY), 0, 1);

      // 速度自适应平滑（高速跟手，微调时极稳）
      const moveDist = Math.hypot(targetNormX - smoothX, targetNormY - smoothY);
      const alpha = clamp(0.28 + moveDist * 2.2, 0.28, 0.85);

      smoothX += (targetNormX - smoothX) * alpha;
      smoothY += (targetNormY - smoothY) * alpha;

      const gameTarget = getGameTarget();
      let clientX = window.innerWidth * smoothX;
      let clientY = window.innerHeight * smoothY;

      if (gameTarget) {
        const rect = gameTarget.getBoundingClientRect();
        clientX = rect.left + smoothX * rect.width;
        clientY = rect.top + smoothY * rect.height;
      }

      pointerEl.style.left = `${clientX}px`;
      pointerEl.style.top = `${clientY}px`;

      // 2. 健壮按键判定 (抗旋转几何比例)
      const palmWidth = Math.max(0.08, Math.hypot(indexMcp.x - pinkyMcp.x, indexMcp.y - pinkyMcp.y));
      const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
      const pinchRatio = pinchDist / palmWidth;
      const isPinch = pinchRatio < 0.38;

      const curledCount = (isFingerCurled(landmarks, 8, 6) ? 1 : 0) +
                          (isFingerCurled(landmarks, 12, 10) ? 1 : 0) +
                          (isFingerCurled(landmarks, 16, 14) ? 1 : 0) +
                          (isFingerCurled(landmarks, 20, 18) ? 1 : 0);
      const isFist = (curledCount >= 3);

      let rawIntent = false;
      if (gestureMode === 'pinch') {
        rawIntent = isPinch;
      } else if (gestureMode === 'fist') {
        rawIntent = isFist;
      } else {
        rawIntent = isPinch || isFist;
      }

      // 3. 多帧连续投票防抖
      if (rawIntent) {
        grabConfidence = Math.min(CONFIRM_GRAB_FRAMES, grabConfidence + 1);
      } else {
        grabConfidence = Math.max(-CONFIRM_RELEASE_FRAMES, grabConfidence - 1);
      }

      let currentGrab = isGrabbing;
      if (grabConfidence >= CONFIRM_GRAB_FRAMES) {
        currentGrab = true;
      } else if (grabConfidence <= -CONFIRM_RELEASE_FRAMES) {
        currentGrab = false;
      }

      // 4. 原生鼠标事件分发
      if (currentGrab && !lastGrabState) {
        triggerGrab(clientX, clientY);
      } else if (currentGrab && lastGrabState) {
        triggerDrag(clientX, clientY);
      } else if (!currentGrab && lastGrabState) {
        triggerRelease(clientX, clientY);
      } else {
        if (!isGrabbing) {
          badgeEl.textContent = '🖐 瞄准移动中';
          badgeEl.className = 'gesture-badge badge-hover';
          dispatchGameMouseEvent('mousemove', clientX, clientY);
        }
      }

      lastGrabState = currentGrab;
    } catch (err) {
      console.warn('[Gesture] onHandResults 异常兜底:', err);
    }
  }

  function drawHandSkeleton(landmarks) {
    const w = canvasEl.width;
    const h = canvasEl.height;

    const connections = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [0,9],[9,10],[10,11],[11,12],
      [0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],
      [5,9],[9,13],[13,17]
    ];

    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 1.8;
    connections.forEach(([i, j]) => {
      ctx.beginPath();
      ctx.moveTo(landmarks[i].x * w, landmarks[i].y * h);
      ctx.lineTo(landmarks[j].x * w, landmarks[j].y * h);
      ctx.stroke();
    });

    landmarks.forEach((pt, index) => {
      ctx.beginPath();
      ctx.arc(pt.x * w, pt.y * h, (index === 4 || index === 8) ? 4 : 2, 0, 2 * Math.PI);
      ctx.fillStyle = (index === 4 || index === 8) ? '#ffcc00' : '#ffffff';
      ctx.fill();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createUI);
  } else {
    createUI();
  }
})();
