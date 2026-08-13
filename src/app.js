'use strict';

(() => {
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: false });
  const video = document.getElementById('camera-feed');
  const statusEl = document.getElementById('status');
  const hintEl = document.getElementById('hint');
  const btnCamera = document.getElementById('btn-camera');
  const btnDemo = document.getElementById('btn-demo');
  const btnReset = document.getElementById('btn-reset');
  const rangeEl = document.getElementById('smooth-range');
  const valueEl = document.getElementById('smooth-value');

  const VISION_WASM_DIR = 'vendor/mediapipe/tasks-vision/wasm/';
  const HAND_MODEL_PATH = 'vendor/mediapipe/models/hand_landmarker.task';
  const SEGMENT_MODEL_PATH = 'vendor/mediapipe/models/selfie_segmenter.tflite';
  const FINGERTIP_INDICES = [4, 8, 12, 20];
  const FX_SCALE = 0.32;
  const FILTER_OPACITY = 0.68;
  const HALFTONE_CELL = 4;
  const HALFTONE_MAX_R = HALFTONE_CELL * 0.85;

  const SURFACE_CONFIGS = {
    red: {
      name: 'red',
      base: 'rgba(255, 255, 255, 1)',
      dots: [
        'rgba(150, 24, 40, 1)',
        'rgba(126, 16, 30, 1)',
        'rgba(168, 30, 48, 1)',
      ],
      personOnly: true,
      minDot: 0.06,
      contrast: 2.4,
      opacity: 1,
    },
    blue: {
      name: 'blue',
      base: 'rgba(0, 0, 238, 1)',
      comic: true,
      scale: 0.5,
      opacity: 1,
    },
    green: {
      name: 'green',
      base: 'rgba(214, 240, 214, 1)',
      dots: [
        'rgba(12, 42, 152, 1)',
        'rgba(20, 58, 172, 1)',
        'rgba(6, 30, 122, 1)',
      ],
      personOnly: true,
      minDot: 0.06,
      contrast: 2.4,
      opacity: 1,
    },
  };

  const state = {
    mode: 'idle', // idle | camera | demo
    running: false,
    processing: false,
    frame: 0,
    smoothing: 0.55,
    hands: null,
    segMask: null,
    personClassIndex: 1,
    smoothLum: {},
    smoothHands: null,
    lastDemoHands: null,
  };

  let handLandmarker = null;
  let imageSegmenter = null;
  let modelsReady = false;
  let modelsPromise = null;
  let stream = null;
  let statusTimer = null;
  const canvasPool = {};

  const demoParticles = Array.from({ length: 72 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: Math.random() * 1.8 + 0.5,
    s: Math.random() * 0.00012 + 0.00004,
    a: Math.random() * 0.34 + 0.08,
  }));

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }

  function getCanvas(w, h, key) {
    const k = key + '_' + w + '_' + h;
    let c = canvasPool[k];
    if (!c) {
      c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w));
      c.height = Math.max(1, Math.round(h));
      canvasPool[k] = c;
    }
    return c;
  }

  function showStatus(text, kind, ms) {
    statusEl.textContent = text;
    statusEl.className = 'status visible ' + (kind || 'info');
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (ms > 0) {
      statusTimer = setTimeout(() => {
        statusEl.classList.remove('visible');
      }, ms);
    }
  }

  function showHint(text) {
    hintEl.textContent = text;
    hintEl.classList.add('visible');
  }

  function hideHint() {
    hintEl.classList.remove('visible');
  }

  function ensureModels() {
    if (modelsReady) return Promise.resolve(true);
    if (modelsPromise) return modelsPromise;
    modelsPromise = loadModels().finally(() => {
      if (!modelsReady) modelsPromise = null;
    });
    return modelsPromise;
  }

  async function loadModels() {
    showStatus('正在加载 MediaPipe 模型…', 'info', 0);
    try {
      const visionMod = await import('../vendor/mediapipe/tasks-vision/vision_bundle.mjs');
      const vision = await visionMod.FilesetResolver.forVisionTasks(VISION_WASM_DIR);
      handLandmarker = await createHandLandmarker(visionMod.HandLandmarker, vision);
      imageSegmenter = await createImageSegmenter(visionMod.ImageSegmenter, vision);
      modelsReady = true;
      showStatus('MediaPipe 模型加载完成。', 'ok', 2500);
      return true;
    } catch (err) {
      console.error('MediaPipe init failed:', err);
      showStatus('MediaPipe 模型加载失败，请确认 vendor/mediapipe 目录完整后刷新重试。', 'error', 8000);
      return false;
    }
  }

  async function createHandLandmarker(HandLandmarker, vision) {
    const options = {
      baseOptions: {
        modelAssetPath: HAND_MODEL_PATH,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
    try {
      return await HandLandmarker.createFromOptions(vision, options);
    } catch (err) {
      console.warn('GPU 初始化失败，回退 CPU：', err);
      options.baseOptions.delegate = 'CPU';
      return await HandLandmarker.createFromOptions(vision, options);
    }
  }

  async function createImageSegmenter(ImageSegmenter, vision) {
    const options = {
      baseOptions: {
        modelAssetPath: SEGMENT_MODEL_PATH,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: true,
    };
    let segmenter = null;
    try {
      segmenter = await ImageSegmenter.createFromOptions(vision, options);
    } catch (err) {
      console.warn('GPU 初始化失败，回退 CPU：', err);
      options.baseOptions.delegate = 'CPU';
      segmenter = await ImageSegmenter.createFromOptions(vision, options);
    }
    try {
      const labels = segmenter.getLabels();
      if (labels.length === 1) {
        state.personClassIndex = 0;
      } else {
        const personIdx = labels.indexOf('person');
        if (personIdx >= 0) {
          state.personClassIndex = personIdx;
        } else {
          const selfieIdx = labels.indexOf('selfie');
          state.personClassIndex = selfieIdx >= 0 ? selfieIdx : 1;
        }
      }
    } catch (err) {
      // keep the default person class index
    }
    return segmenter;
  }

  function maskToImageData(mask) {
    const values = mask.getAsUint8Array();
    const img = new ImageData(mask.width, mask.height);
    const personIdx = state.personClassIndex >= 0 ? state.personClassIndex : 1;
    for (let i = 0; i < values.length; i++) {
      const idx = i * 4;
      const isPerson = values[i] === personIdx || (personIdx === 1 && values[i] === 255);
      const v = isPerson ? 255 : 0;
      img.data[idx] = v;
      img.data[idx + 1] = v;
      img.data[idx + 2] = v;
      img.data[idx + 3] = v;
    }
    return img;
  }

  function maskToImageDataFromConfidence(mask) {
    const values = mask.getAsFloat32Array();
    const img = new ImageData(mask.width, mask.height);
    let max = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] > max) max = values[i];
    }
    const threshold = max > 1 ? 128 : 0.5;
    for (let i = 0; i < values.length; i++) {
      const idx = i * 4;
      const v = values[i] >= threshold ? 255 : 0;
      img.data[idx] = v;
      img.data[idx + 1] = v;
      img.data[idx + 2] = v;
      img.data[idx + 3] = v;
    }
    return img;
  }

  function checkCameraSupport() {
    if (location.protocol === 'file:') {
      showStatus('请双击“启动AR.bat”通过本地服务器打开页面，file:// 方式无法调用摄像头。', 'error', 8000);
      return false;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showStatus('当前浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge。', 'error', 8000);
      return false;
    }
    return true;
  }

  function handleCameraError(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      showStatus('摄像头权限被拒绝：请在浏览器地址栏允许摄像头访问后重试。', 'error', 8000);
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      showStatus('未找到摄像头：请检查摄像头连接后重试。', 'error', 8000);
    } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      showStatus('摄像头正被其他软件占用：请关闭占用摄像头的程序后重试。', 'error', 8000);
    } else {
      showStatus('无法启动摄像头：' + (err && err.message ? err.message : '未知错误'), 'error', 8000);
    }
  }

  async function startCamera() {
    if (state.mode === 'camera') return;
    if (!checkCameraSupport()) return;
    const ok = await ensureModels();
    if (!ok) return;
    showStatus('正在启动摄像头…', 'info', 0);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch (err) {
      handleCameraError(err);
      return;
    }
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    try {
      await video.play();
    } catch (_) {
      // play can reject when permission state is odd; stream still works
    }
    await new Promise((resolve) => {
      if (video.videoWidth > 0) {
        resolve();
      } else {
        video.onloadedmetadata = () => resolve();
      }
    });

    stream.getTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (state.mode === 'camera') {
          showStatus('摄像头连接已断开。', 'error', 5000);
          stopCamera();
        }
      });
    });

    state.mode = 'camera';
    state.frame = 0;
    state.smoothHands = null;
    startLoop();
    document.body.classList.add('immersive');
    showStatus('摄像头已启动，请将双手同时放入画面。', 'ok', 3200);
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;
    state.mode = 'idle';
    state.hands = null;
    state.segMask = null;
    state.smoothHands = null;
    document.body.classList.remove('immersive');
    hideHint();
    drawIdle();
  }

  function startDemo() {
    if (state.mode === 'demo') return;
    stopCamera();
    state.mode = 'demo';
    state.frame = 0;
    state.smoothHands = null;
    startLoop();
    document.body.classList.add('immersive');
    showStatus('演示模式已启动，将自动生成三块色面。', 'ok', 3000);
  }

  function resetAll() {
    stopLoop();
    stopCamera();
    showStatus('已重置。', 'info', 1800);
  }

  function startLoop() {
    if (state.running) return;
    state.running = true;
    requestAnimationFrame(tick);
  }

  function stopLoop() {
    state.running = false;
  }

  async function tick(t) {
    if (!state.running) return;
    requestAnimationFrame(tick);
    state.frame++;
    if (state.mode === 'camera' && !state.processing && video.readyState >= 2) {
      state.processing = true;
      try {
        const ts = performance.now();
        const handsRes = await handLandmarker.detectForVideo(video, ts);
        state.hands = handsRes.landmarks;
        if (state.frame % 2 === 0) {
          const segRes = await imageSegmenter.segmentForVideo(video, ts);
          try {
            if (segRes.confidenceMasks && segRes.confidenceMasks.length > 0) {
              const idx = state.personClassIndex >= 0 ? state.personClassIndex : 0;
              const personMask = segRes.confidenceMasks[idx] || segRes.confidenceMasks[0];
              state.segMask = maskToImageDataFromConfidence(personMask);
            } else if (segRes.categoryMask) {
              state.segMask = maskToImageData(segRes.categoryMask);
            }
          } catch (err) {
            console.error('Segmentation mask conversion failed:', err);
          } finally {
            if (segRes.categoryMask) segRes.categoryMask.close();
            if (segRes.confidenceMasks) {
              segRes.confidenceMasks.forEach((m) => m.close());
            }
          }
        }
      } catch (err) {
        console.error('MediaPipe frame error:', err);
      } finally {
        state.processing = false;
      }
    }
    render(t);
  }

  function getCoverLayout(vw, vh, cw, ch) {
    const scale = Math.max(cw / vw, ch / vh);
    const sw = vw * scale;
    const sh = vh * scale;
    return {
      scale,
      sw,
      sh,
      dx: (cw - sw) / 2,
      dy: (ch - sh) / 2,
    };
  }

  function drawMirroredVideo(targetCtx, vw, vh, cw, ch) {
    const l = getCoverLayout(vw, vh, cw, ch);
    targetCtx.save();
    targetCtx.setTransform(-1, 0, 0, 1, cw, 0);
    targetCtx.drawImage(video, l.dx, l.dy, l.sw, l.sh);
    targetCtx.setTransform(1, 0, 0, 1, 0, 0);
    targetCtx.restore();
  }

  function toScreenPoint(p, vw, vh, cw, ch) {
    const l = getCoverLayout(vw, vh, cw, ch);
    return {
      x: cw - (p.x * l.sw + l.dx),
      y: p.y * l.sh + l.dy,
    };
  }

  function normalizeHands(hands, cw, ch) {
    if (!hands || hands.length === 0) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    return hands.map((hand) => hand.map((p) => toScreenPoint(p, vw, vh, cw, ch)));
  }

  function sortHands(hands) {
    const avgX = (hand) => hand.reduce((sum, p) => sum + p.x, 0) / hand.length;
    return [...hands].sort((a, b) => avgX(a) - avgX(b));
  }

  function smoothHands(hands) {
    const alpha = 1 - state.smoothing * 0.9;
    const out = [];
    for (let h = 0; h < hands.length; h++) {
      const prev = state.smoothHands && state.smoothHands[h];
      const prevValid = prev && prev.length === hands[h].length;
      const pts = hands[h].map((p, i) => {
        if (!prevValid || !prev[i]) return { x: p.x, y: p.y };
        return {
          x: prev[i].x + (p.x - prev[i].x) * alpha,
          y: prev[i].y + (p.y - prev[i].y) * alpha,
        };
      });
      out.push(pts);
    }
    state.smoothHands = out;
    return out;
  }

  function buildQuads(left, right) {
    return [
      { name: 'red', pts: [left[4], left[8], right[8], right[4]] },
      { name: 'blue', pts: [left[8], left[12], right[12], right[8]] },
      { name: 'green', pts: [left[12], left[20], right[20], right[12]] },
    ];
  }

  function traceQuad(c, pts) {
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    c.lineTo(pts[1].x, pts[1].y);
    c.lineTo(pts[2].x, pts[2].y);
    c.lineTo(pts[3].x, pts[3].y);
    c.closePath();
  }

  function quadBounds(pts, pad) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const x = Math.max(0, Math.floor(minX - pad));
    const y = Math.max(0, Math.floor(minY - pad));
    const w = Math.ceil(maxX + pad) - x;
    const h = Math.ceil(maxY + pad) - y;
    if (w < 1 || h < 1) return null;
    return { x, y, w, h };
  }

  function hash2(a, b, seed) {
    let h = (a * 374761393 + b * 668265263 + seed) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }

  function getGrainCanvas(w, h) {
    const key = 'grain_' + w + '_' + h;
    let c = canvasPool[key];
    if (!c) {
      c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      const img = g.createImageData(w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const rnd = Math.random();
        if (rnd < 0.008) {
          const a = 24 + Math.random() * 62;
          d[i] = 22;
          d[i + 1] = 8;
          d[i + 2] = 11;
          d[i + 3] = a;
        } else if (rnd < 0.02) {
          const a = 24 + Math.random() * 58;
          d[i] = 255;
          d[i + 1] = 255;
          d[i + 2] = 255;
          d[i + 3] = a;
        } else if (rnd < 0.03) {
          const a = 20 + Math.random() * 46;
          d[i] = 168 + Math.random() * 44;
          d[i + 1] = 16 + Math.random() * 24;
          d[i + 2] = 30 + Math.random() * 28;
          d[i + 3] = a;
        }
      }
      g.putImageData(img, 0, 0);
      g.fillStyle = 'rgba(96, 24, 34, 0.05)';
      for (let y = 0; y < h; y += 5) {
        if (Math.random() < 0.012) {
          g.fillRect(0, y, w, 1);
        }
      }
      canvasPool[key] = c;
    }
    return c;
  }

  function smoothPersonRange(key, min, max) {
    if (!key) return { min, max };
    const s = state.smoothLum[key];
    if (!s) {
      state.smoothLum[key] = { min, max };
      return { min, max };
    }
    s.min += (min - s.min) * 0.25;
    s.max += (max - s.max) * 0.25;
    return { min: s.min, max: s.max };
  }

  function applyRedFx(fctx, fw, fh, qs, cutout, cw, ch) {
    applyHalftoneFx(fctx, fw, fh, qs, cutout, cw, ch, SURFACE_CONFIGS.red);
  }

  function applyBlueFx(fctx, fw, fh, qs, cutout, cw, ch) {
    const cfg = SURFACE_CONFIGS.blue;
    if (cfg.lines) {
      applyLineFx(fctx, fw, fh, qs, cutout, cw, ch, cfg);
      return;
    }
    if (cfg.comic) {
      applyComicFx(fctx, fw, fh, qs, cutout, cw, ch, cfg);
      return;
    }
    if (cfg.negative) {
      applyNegativeFx(fctx, fw, fh, qs, cutout, cw, ch, cfg);
      return;
    }
    applyHalftoneFx(fctx, fw, fh, qs, cutout, cw, ch, cfg);
  }

  function applyGreenFx(fctx, fw, fh, qs, cutout, cw, ch) {
    applyHalftoneFx(fctx, fw, fh, qs, cutout, cw, ch, SURFACE_CONFIGS.green);
  }

  function applyLineFx(fctx, fw, fh, qs, cutout, cw, ch, cfg) {
    const b = quadBounds(qs, 0);
    if (!b || b.w < 2 || b.h < 2) return;

    fctx.fillStyle = cfg.base;
    fctx.fillRect(b.x, b.y, b.w, b.h);

    if (!cutout) return;

    const lum = getCanvas(fw, fh, 'lum');
    const lctx = lum.getContext('2d');
    lctx.clearRect(0, 0, fw, fh);
    lctx.drawImage(cutout, 0, 0, cw, ch, 0, 0, fw, fh);

    const img = lctx.getImageData(b.x, b.y, b.w, b.h);
    const cell = HALFTONE_CELL;

    let personMin = Infinity;
    let personMax = -Infinity;
    let personSamples = 0;
    for (let sy = 0; sy < b.h; sy += 4) {
      const srow = sy * b.w;
      for (let sx = 0; sx < b.w; sx += 4) {
        const si = (srow + sx) * 4;
        if (img.data[si + 3] >= 10) {
          const sl = (img.data[si] + img.data[si + 1] + img.data[si + 2]) / 3;
          if (sl < personMin) personMin = sl;
          if (sl > personMax) personMax = sl;
          personSamples++;
        }
      }
    }
    const adaptive = personSamples > 8 && personMax - personMin >= 24;
    const range = Math.max(1, personMax - personMin);
    const contrast = cfg.contrast != null ? cfg.contrast : 1.6;
    const minLine = cfg.minLine != null ? cfg.minLine : 0.05;

    fctx.save();
    fctx.lineCap = 'round';
    for (let gy = 0; gy < b.h; gy += cell) {
      for (let gx = 0; gx < b.w; gx += cell) {
        let lumSum = 0;
        let alphaSum = 0;
        let n = 0;
        const gyEnd = Math.min(gy + cell, b.h);
        const gxEnd = Math.min(gx + cell, b.w);
        for (let yy = gy; yy < gyEnd; yy++) {
          const row = yy * b.w;
          for (let xx = gx; xx < gxEnd; xx++) {
            const i = (row + xx) * 4;
            lumSum += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
            alphaSum += img.data[i + 3];
            n++;
          }
        }
        const avgAlpha = n ? alphaSum / n : 0;
        if (avgAlpha < 10) continue;
        const lumValue = n ? lumSum / n : 255;
        let d;
        if (adaptive) {
          d = (personMax - lumValue) / range;
        } else {
          d = (255 - lumValue) / 255;
          d = (d - 0.42) * 2.0 + 0.5;
        }
        d = Math.max(0, Math.min(1, d));
        d = Math.pow(d, contrast);
        if (d < minLine) continue;

        const h = hash2(gx, gy, 0x6a09e667);
        const rnd = h / 4294967295;
        const jx = (rnd - 0.5) * 0.9;
        const jy = (((h >>> 8) / 4294967295) - 0.5) * 0.9;
        const cx = b.x + gx + cell / 2 + jx;
        const cy = b.y + gy + cell / 2 + jy;
        const len = cell * (0.5 + d * 1.0);
        const width = 0.6 + d * 1.4;
        const angleBase = ((h >>> 16) % 2 === 0 ? -1 : 1) * (Math.PI / 4);
        const angle = angleBase + (rnd - 0.5) * 0.2;

        fctx.strokeStyle = cfg.lineColor || 'rgba(6, 6, 20, 1)';
        fctx.lineWidth = width;
        fctx.beginPath();
        fctx.moveTo(cx - Math.cos(angle) * len / 2, cy - Math.sin(angle) * len / 2);
        fctx.lineTo(cx + Math.cos(angle) * len / 2, cy + Math.sin(angle) * len / 2);
        fctx.stroke();
      }
    }
    fctx.restore();
  }

  function applyComicFx(fctx, fw, fh, qs, cutout, cw, ch, cfg) {
    const b = quadBounds(qs, 0);
    if (!b || b.w < 2 || b.h < 2) return;

    fctx.fillStyle = cfg.base;
    fctx.fillRect(b.x, b.y, b.w, b.h);

    if (!cutout) return;

    const comic = getCanvas(fw, fh, 'comic');
    const cctx = comic.getContext('2d');
    cctx.clearRect(0, 0, fw, fh);
    cctx.drawImage(cutout, 0, 0, cw, ch, 0, 0, fw, fh);

    const img = cctx.getImageData(0, 0, fw, fh);
    const d = img.data;

    let personMin = 255;
    let personMax = 0;
    let personSamples = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 10) continue;
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (lum < personMin) personMin = lum;
      if (lum > personMax) personMax = lum;
      personSamples++;
    }
    const hasRange = personSamples > 8 && personMax - personMin >= 8;
    const sm = hasRange ? smoothPersonRange(cfg.name, personMin, personMax) : { min: personMin, max: personMax };
    const range = Math.max(1, sm.max - sm.min);
    const threshold = sm.min + range * 0.32;

    for (let y = 0; y < fh; y++) {
      const row = y * fw;
      for (let x = 0; x < fw; x++) {
        const p = y * fw + x;
        const i = p * 4;
        if (d[i + 3] < 10) continue;
        const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        const h = hash2(x, y, 0x51ab3f7d);
        const noise = (h / 4294967295 - 0.5) * 12;
        const v = lum + noise < threshold ? 0 : 255;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
      }
    }

    cctx.putImageData(img, 0, 0);
    fctx.drawImage(comic, 0, 0);
  }

  function applyNegativeFx(fctx, fw, fh, qs, cutout, cw, ch, cfg) {
    const b = quadBounds(qs, 0);
    if (!b || b.w < 2 || b.h < 2) return;

    fctx.fillStyle = cfg.base;
    fctx.fillRect(b.x, b.y, b.w, b.h);

    if (!cutout) return;

    const neon = cfg.neon || {};
    const saturate = neon.saturate != null ? neon.saturate : 2.3;
    const contrast = neon.contrast != null ? neon.contrast : 1.65;
    const glowAlpha = neon.glow != null ? neon.glow : 0.6;
    const glowPx = Math.max(2, Math.round(Math.min(fw, fh) * 0.02));

    fctx.save();
    fctx.globalAlpha = glowAlpha;
    fctx.globalCompositeOperation = 'lighter';
    fctx.filter =
      'invert(1) saturate(' + saturate + ') contrast(' + contrast + ') brightness(1.4) blur(' + glowPx + 'px)';
    fctx.drawImage(cutout, 0, 0, cw, ch, 0, 0, fw, fh);
    fctx.restore();

    fctx.save();
    fctx.filter = 'invert(1) saturate(' + saturate + ') contrast(' + contrast + ')';
    fctx.drawImage(cutout, 0, 0, cw, ch, 0, 0, fw, fh);
    fctx.restore();
  }

  function applyHalftoneFx(fctx, fw, fh, qs, cutout, cw, ch, cfg) {
    const b = quadBounds(qs, 0);
    if (!b || b.w < 2 || b.h < 2) return;

    fctx.fillStyle = cfg.base;
    fctx.fillRect(b.x, b.y, b.w, b.h);

    if (!cutout) return;

    const lum = getCanvas(fw, fh, 'lum');
    const lctx = lum.getContext('2d');
    lctx.clearRect(0, 0, fw, fh);
    if (state.mode === 'camera' && video.videoWidth > 0 && !cfg.personOnly) {
      drawMirroredVideo(lctx, video.videoWidth, video.videoHeight, fw, fh);
    } else if (cutout) {
      lctx.drawImage(cutout, 0, 0, cw, ch, 0, 0, fw, fh);
    }

    const img = lctx.getImageData(b.x, b.y, b.w, b.h);
    const cell = HALFTONE_CELL;
    const maxR = HALFTONE_MAX_R;

    let personMin = Infinity;
    let personMax = -Infinity;
    let personSamples = 0;
    if (cfg.personOnly) {
      for (let sy = 0; sy < b.h; sy += 4) {
        const srow = sy * b.w;
        for (let sx = 0; sx < b.w; sx += 4) {
          const si = (srow + sx) * 4;
          if (img.data[si + 3] >= 10) {
            const lum = (img.data[si] + img.data[si + 1] + img.data[si + 2]) / 3;
            if (lum < personMin) personMin = lum;
            if (lum > personMax) personMax = lum;
            personSamples++;
          }
        }
      }
    }
    const hasRange = cfg.personOnly && personSamples > 8 && personMax - personMin >= 24;
    const sm = hasRange ? smoothPersonRange(cfg.name, personMin, personMax) : { min: personMin, max: personMax };
    const adaptiveLum = hasRange && sm.max - sm.min >= 24;

    for (let gy = 0; gy < b.h; gy += cell) {
      for (let gx = 0; gx < b.w; gx += cell) {
        let lumSum = 0;
        let alphaSum = 0;
        let n = 0;
        const gyEnd = Math.min(gy + cell, b.h);
        const gxEnd = Math.min(gx + cell, b.w);
        for (let yy = gy; yy < gyEnd; yy++) {
          const row = yy * b.w;
          for (let xx = gx; xx < gxEnd; xx++) {
            const i = (row + xx) * 4;
            lumSum += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
            alphaSum += img.data[i + 3];
            n++;
          }
        }
        const avgAlpha = n ? alphaSum / n : 0;
        if (cfg.personOnly && avgAlpha < 10) continue;
        let d = 0;
        if (avgAlpha >= 10) {
          const lumValue = n ? lumSum / n : 255;
          if (adaptiveLum) {
            const range = Math.max(1, sm.max - sm.min);
            d = Math.max(0, Math.min(1, (sm.max - lumValue) / range));
            d = Math.pow(d, cfg.contrast != null ? cfg.contrast : 1.8);
          } else {
            d = Math.max(0, Math.min(1, (255 - lumValue) / 255));
            d = Math.max(0, Math.min(1, (d - 0.42) * 2.0 + 0.5));
          }
          if (cfg.minDot != null) d = Math.max(cfg.minDot, d);
        }

        const h = hash2(gx, gy, 0x9e3779b9);
        const rnd = h / 4294967295;
        let color;
        if (cfg.mixed) {
          if (d > 0.52) {
            color = cfg.dots[0];
          } else if (d > 0.26) {
            color = rnd < 0.5 ? cfg.dots[1] : cfg.dots[2];
          } else {
            color = cfg.dots[3];
          }
        } else {
          color = cfg.dots[h % cfg.dots.length];
        }

        const r = Math.max(0.5, Math.sqrt(d) * maxR);

        const jx = (rnd - 0.5) * 0.7;
        const jy = (((h >>> 8) / 4294967295) - 0.5) * 0.7;
        fctx.fillStyle = color;
        fctx.beginPath();
        fctx.arc(b.x + gx + cell / 2 + jx, b.y + gy + cell / 2 + jy, r, 0, Math.PI * 2);
        fctx.fill();
      }
    }
  }

  function featherQuad(fxCanvas, qs, blurPx) {
    const w = fxCanvas.width;
    const h = fxCanvas.height;
    const mask = getCanvas(w, h, 'mask');
    const mctx = mask.getContext('2d');
    mctx.clearRect(0, 0, w, h);
    mctx.filter = 'blur(' + blurPx + 'px)';
    mctx.fillStyle = '#ffffff';
    traceQuad(mctx, qs);
    mctx.fill();
    mctx.filter = 'none';

    const fctx = fxCanvas.getContext('2d');
    fctx.globalCompositeOperation = 'destination-in';
    fctx.drawImage(mask, 0, 0);
    fctx.globalCompositeOperation = 'source-over';
  }

  function renderQuadFx(q, cutout, cw, ch) {
    const cfg = SURFACE_CONFIGS[q.name] || {};
    const scale = cfg.scale != null ? cfg.scale : FX_SCALE;
    const fw = Math.max(8, Math.round(cw * scale));
    const fh = Math.max(8, Math.round(ch * scale));
    const fx = getCanvas(fw, fh, 'fx');
    const fctx = fx.getContext('2d');
    fctx.clearRect(0, 0, fw, fh);
    const qs = q.pts.map((p) => ({
      x: p.x * fw / cw,
      y: p.y * fh / ch,
    }));

    fctx.save();
    traceQuad(fctx, qs);
    fctx.clip();
    if (cutout) {
      fctx.drawImage(cutout, 0, 0, cw, ch, 0, 0, fw, fh);
    }
    if (q.name === 'red') {
      applyRedFx(fctx, fw, fh, qs, cutout, cw, ch);
    } else if (q.name === 'blue') {
      applyBlueFx(fctx, fw, fh, qs, cutout, cw, ch);
    } else {
      applyGreenFx(fctx, fw, fh, qs, cutout, cw, ch);
    }
    fctx.restore();

    featherQuad(fx, qs, 0.7);
    return fx;
  }

  function drawQuadEdges(quads) {
    ctx.save();
    ctx.lineJoin = 'round';
    for (const q of quads) {
      ctx.beginPath();
      traceQuad(ctx, q.pts);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.96)';
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFingertipMarks(hands) {
    ctx.save();
    for (const hand of hands) {
      for (const idx of FINGERTIP_INDICES) {
        const p = hand[idx];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function makeCutout(cw, ch) {
    const cut = getCanvas(cw, ch, 'cutout');
    const cctx = cut.getContext('2d');
    cctx.clearRect(0, 0, cw, ch);

    if (state.mode === 'camera') {
      if (!state.segMask) return null;
      const img = state.segMask;
      const mask = getCanvas(img.width, img.height, 'maskraw');
      mask.getContext('2d').putImageData(img, 0, 0);

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;

      const overlay = getCanvas(vw, vh, 'maskoverlay');
      const octx = overlay.getContext('2d');
      octx.clearRect(0, 0, vw, vh);
      octx.drawImage(mask, 0, 0, img.width, img.height, 0, 0, vw, vh);

      cctx.filter = 'blur(6px)';
      const l = getCoverLayout(vw, vh, cw, ch);
      cctx.save();
      cctx.setTransform(-1, 0, 0, 1, cw, 0);
      cctx.drawImage(overlay, l.dx, l.dy, l.sw, l.sh);
      cctx.restore();
      cctx.filter = 'none';

      cctx.globalCompositeOperation = 'source-in';
      drawMirroredVideo(cctx, video.videoWidth, video.videoHeight, cw, ch);
      cctx.globalCompositeOperation = 'source-over';
      return cut;
    }

    if (state.mode === 'demo') {
      drawDemoPerson(cctx, cw, ch, state.lastDemoHands);
      return cut;
    }
    return null;
  }

  function drawDemoScene(t, cw, ch) {
    const grad = ctx.createLinearGradient(0, 0, 0, ch);
    grad.addColorStop(0, '#0b0e13');
    grad.addColorStop(0.55, '#182028');
    grad.addColorStop(1, '#0c1116');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, ch);

    ctx.save();
    for (const p of demoParticles) {
      const y = (((p.y - (t / 1000) * p.s * cw) % 1) + 1) % 1;
      ctx.globalAlpha = p.a;
      ctx.fillStyle = '#9fb4c4';
      ctx.beginPath();
      ctx.arc(p.x * cw, y * ch, p.r * (cw / 1600), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    const vg = ctx.createRadialGradient(
      cw / 2,
      ch * 0.45,
      Math.min(cw, ch) * 0.35,
      cw / 2,
      ch * 0.5,
      Math.max(cw, ch) * 0.75
    );
    vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vg.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, cw, ch);
  }

  function drawDemoPerson(cctx, cw, ch, hands) {
    const cx = cw * 0.5;
    const headY = ch * 0.3;
    const headR = Math.min(cw, ch) * 0.085;

    cctx.save();
    cctx.filter = 'blur(1.5px)';

    const bodyGrad = cctx.createLinearGradient(0, ch * 0.34, 0, ch * 0.95);
    bodyGrad.addColorStop(0, '#d9d6cd');
    bodyGrad.addColorStop(0.45, '#b6b4ac');
    bodyGrad.addColorStop(1, '#7f837d');
    cctx.fillStyle = bodyGrad;
    cctx.beginPath();
    cctx.moveTo(cx - cw * 0.17, ch * 0.36);
    cctx.lineTo(cx + cw * 0.17, ch * 0.36);
    cctx.lineTo(cx + cw * 0.14, ch * 0.92);
    cctx.lineTo(cx - cw * 0.14, ch * 0.92);
    cctx.closePath();
    cctx.fill();

    cctx.fillStyle = '#e4e0d6';
    cctx.beginPath();
    cctx.arc(cx, headY, headR, 0, Math.PI * 2);
    cctx.fill();

    cctx.fillStyle = 'rgba(70, 74, 72, 0.32)';
    cctx.fillRect(cx - headR * 0.38, headY + headR * 0.12, headR * 0.76, headR * 0.14);

    cctx.strokeStyle = '#b4b2aa';
    cctx.lineWidth = Math.min(cw, ch) * 0.045;
    cctx.lineCap = 'round';
    const shoulderL = { x: cx - cw * 0.16, y: ch * 0.37 };
    const shoulderR = { x: cx + cw * 0.16, y: ch * 0.37 };
    if (hands && hands[0]) {
      cctx.beginPath();
      cctx.moveTo(shoulderL.x, shoulderL.y);
      cctx.lineTo(hands[0][0].x, hands[0][0].y);
      cctx.stroke();
    }
    if (hands && hands[1]) {
      cctx.beginPath();
      cctx.moveTo(shoulderR.x, shoulderR.y);
      cctx.lineTo(hands[1][0].x, hands[1][0].y);
      cctx.stroke();
    }

    cctx.restore();
  }

  function buildHandTemplate(cx, cy, rot, scale, spread, mirror) {
    const pts = new Array(21);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const m = mirror || 1;
    const tf = (x, y) => {
      const sx = x * scale * m;
      const sy = y * scale;
      return {
        x: cx + sx * cos - sy * sin,
        y: cy + sx * sin + sy * cos,
      };
    };
    const finger = (base, tip, mcpIdx, pipIdx, dipIdx, tipIdx) => {
      pts[mcpIdx] = tf(base.x, base.y);
      pts[pipIdx] = tf(
        base.x + (tip.x - base.x) * 0.42,
        base.y + (tip.y - base.y) * 0.42
      );
      pts[dipIdx] = tf(
        base.x + (tip.x - base.x) * 0.72,
        base.y + (tip.y - base.y) * 0.72
      );
      pts[tipIdx] = tf(tip.x, tip.y);
    };

    pts[0] = tf(0, 0.42);
    pts[1] = tf(0.14, 0.18);
    pts[2] = tf(0.26, 0.12);
    pts[3] = tf(0.37, 0.02);
    pts[4] = tf(0.46, -0.06);

    finger({ x: 0.1, y: 0.1 }, { x: 0.13, y: -0.52 * spread }, 5, 6, 7, 8);
    finger({ x: 0.03, y: 0.12 }, { x: 0.03, y: -0.6 * spread }, 9, 10, 11, 12);
    finger({ x: -0.04, y: 0.1 }, { x: -0.06, y: -0.5 * spread }, 13, 14, 15, 16);
    finger({ x: -0.12, y: 0.07 }, { x: -0.18, y: -0.36 * spread }, 17, 18, 19, 20);
    return pts;
  }

  function demoHands(t, cw, ch) {
    const sec = t / 1000;
    const spread = 0.68 + Math.sin(sec * 0.8) * 0.26;
    const scale = 0.95 + Math.sin(sec * 0.55) * 0.1;
    const lc = {
      x: 0.27 + Math.sin(sec * 0.45) * 0.035,
      y: 0.58 + Math.sin(sec * 0.72) * 0.03,
    };
    const rc = {
      x: 0.73 + Math.cos(sec * 0.42) * 0.035,
      y: 0.58 + Math.cos(sec * 0.66) * 0.03,
    };
    const l = buildHandTemplate(lc.x, lc.y, Math.sin(sec * 0.5) * 0.05, scale, spread, 1);
    const r = buildHandTemplate(rc.x, rc.y, Math.cos(sec * 0.45) * 0.05, scale, spread, -1);
    const hands = [l, r];
    state.lastDemoHands = hands.map((hand) =>
      hand.map((p) => ({ x: p.x * cw, y: p.y * ch }))
    );
    return state.lastDemoHands;
  }

  function drawIdle() {
    const cw = canvas.width;
    const ch = canvas.height;
    const g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, '#0a0d11');
    g.addColorStop(1, '#12181f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
  }

  function render(t) {
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (state.mode === 'camera' && video.videoWidth > 0) {
      drawMirroredVideo(ctx, video.videoWidth, video.videoHeight, cw, ch);
    } else if (state.mode === 'demo') {
      drawDemoScene(t, cw, ch);
    } else {
      drawIdle();
      return;
    }

    let rawHands = null;
    if (state.mode === 'camera') {
      rawHands = normalizeHands(state.hands, cw, ch);
    } else if (state.mode === 'demo') {
      rawHands = demoHands(t, cw, ch);
    }

    if (!rawHands || rawHands.length < 2) {
      if (state.mode === 'camera' && rawHands && rawHands.length === 1) {
        showHint('只识别到一只手，请将双手同时放入画面');
      } else {
        hideHint();
      }
      return;
    }
    hideHint();

    const sorted = sortHands(rawHands);
    const smooth = smoothHands(sorted);
    const cutout = makeCutout(cw, ch);
    const quads = buildQuads(smooth[0], smooth[1]);
    for (const q of quads) {
      const fx = renderQuadFx(q, cutout, cw, ch);
      const cfg = SURFACE_CONFIGS[q.name];
      ctx.globalAlpha = cfg && cfg.opacity != null ? cfg.opacity : FILTER_OPACITY;
      ctx.drawImage(fx, 0, 0, cw, ch);
      ctx.globalAlpha = 1;
    }
    drawQuadEdges(quads);
  }

  btnCamera.addEventListener('click', startCamera);
  btnDemo.addEventListener('click', startDemo);
  btnReset.addEventListener('click', resetAll);
  rangeEl.addEventListener('input', () => {
    state.smoothing = Number(rangeEl.value) / 100;
    valueEl.textContent = rangeEl.value;
  });
  window.addEventListener('resize', resize);

  resize();
  drawIdle();
  if (location.protocol !== 'file:') {
    ensureModels().then((ok) => {
      if (ok) document.body.dataset.mediapipeReady = '1';
    });
  }
  if (location.protocol === 'file:') {
    showStatus('请双击“启动AR.bat”通过本地服务器打开页面，file:// 方式无法调用摄像头。', 'error', 8000);
  }
})();
