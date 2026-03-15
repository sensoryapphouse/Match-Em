'use strict';

/* ── Match 'em ── */

// Disable long-press / right-click context menu
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Global error handler — prevents the app from silently breaking
window.addEventListener('error', (e) => {
  console.error('Unhandled error:', e.message, 'at', e.filename, ':', e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled promise rejection:', e.reason);
});

const $ = s => { try { return document.querySelector(s); } catch (_) { return null; } };
const $$ = s => { try { return document.querySelectorAll(s); } catch (_) { return []; } };

let activities = null;   // loaded from activities.json
let currentTopic = null;
let currentActivity = null;
let chainIndex = 0;
let currentStep = null;
let rewarding = false;
let audioCtx = null;

// Scanning / switch accessibility
let scanMode = localStorage.getItem('matchem_scanMode') || 'off'; // 'off'|'1switch'|'2switch'
let scanObjects = [];    // [{el, logRect:{x0,y0,x1,y1}}]
let scanIndex = -1;
let scanTimerId = null;
let scanTiming = parseInt(localStorage.getItem('matchem_scanTiming') || '2000');

// SVG cache - avoid re-fetching the same SVG files
const svgCache = {};

/* ────────── screens ────────── */
function showScreen(id) {
  try {
    $$('.screen').forEach(s => s.classList.remove('active'));
    const target = $(id);
    if (target) target.classList.add('active');
    else console.warn('showScreen: element not found:', id);
  } catch (e) {
    console.error('showScreen error:', e);
  }
}

/* ────────── audio ────────── */
function ensureAudio() {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { console.warn('Web Audio API not supported'); return; }
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch (e) {
    console.error('ensureAudio error:', e);
  }
}

const sndCache = {};
function loadSound(url) {
  if (!url) return Promise.resolve(null);
  if (sndCache[url]) return Promise.resolve(sndCache[url]);
  if (!audioCtx) { ensureAudio(); if (!audioCtx) return Promise.resolve(null); }
  return fetch(url)
    .then(r => {
      if (!r.ok && r.status !== 0) throw new Error('HTTP ' + r.status + ' loading ' + url);
      return r.arrayBuffer();
    })
    .then(buf => audioCtx.decodeAudioData(buf))
    .then(decoded => { sndCache[url] = decoded; return decoded; })
    .catch(e => { console.warn('loadSound failed for', url, e.message); return null; });
}

function playSound(url) {
  if (!url) return;
  try {
    ensureAudio();
    if (!audioCtx) return;
    loadSound(url).then(buf => {
      if (!buf) return;
      try {
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(audioCtx.destination);
        src.start();
      } catch (e) {
        console.warn('playSound playback error:', e.message);
      }
    });
  } catch (e) {
    console.warn('playSound error:', e.message);
  }
}

/* ────────── load pre-converted SVG ────────── */
async function loadSvgOrImg(url) {
  if (!url || typeof url !== 'string') return null;
  if (svgCache[url]) return svgCache[url];
  if (url.toLowerCase().endsWith('.svg')) {
    try {
      const resp = await fetch(url);
      if (!resp.ok && resp.status !== 0) return null;
      const svg = await resp.text();
      if (svg) svgCache[url] = svg;
      return svg || null;
    } catch (e) {
      console.warn('SVG fetch failed for', url, e.message || e);
      return null;
    }
  }
  return null;
}

/* ────────── sizing ────────── */
function sizeGameArea() {
  const area = $('#game-area');
  if (!area) return;
  area.style.width = window.innerWidth + 'px';
  area.style.height = window.innerHeight + 'px';
  // Re-compensate stretch if game is active
  if (currentStep) {
    const svgEl = $('#game-pic').querySelector('svg');
    if (svgEl) compensateStretch(svgEl);
  }
  // Reposition scan highlight if active
  if (scanIndex >= 0 && scanObjects.length > 0) {
    highlightObject(scanIndex);
  }
}

// Border rect removal and curve smoothing are now applied during pre-conversion
// (convert.html). The SVG files in svg/ are ready to use directly.

// With preserveAspectRatio="none", the SVG is stretched to fill the screen.
// This distorts individual shapes. Compensate by applying an inverse X-scale
// to each sub-image around its centre point, so positions stay spread out
// but each shape maintains its original aspect ratio.
function compensateStretch(svgEl) {
  const vb = svgEl.viewBox.baseVal;
  if (!vb || vb.width <= 0 || vb.height <= 0) return;

  const container = svgEl.parentElement;
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  if (cw <= 0 || ch <= 0) return;

  // How much X is stretched relative to Y
  const xScale = cw / vb.width;  // px per viewBox unit in X
  const yScale = ch / vb.height; // px per viewBox unit in Y
  const ratio = yScale / xScale; // < 1 means X is stretched wider

  if (Math.abs(ratio - 1) < 0.01) return; // negligible

  // Find all object groups (immediate children of the top-level region group)
  const topGroup = svgEl.querySelector(':scope > g.mdcr-region');
  if (!topGroup) return;

  for (const el of topGroup.children) {
    if (el.tagName === 'metadata') continue;
    try {
      const bbox = el.getBBox();
      if (bbox.width === 0 && bbox.height === 0) continue;
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;
      // Scale X around centre point to restore aspect ratio
      el.setAttribute('transform',
        `translate(${cx}, ${cy}) scale(${ratio}, 1) translate(${-cx}, ${-cy})`
      );
    } catch (e) { /* getBBox can fail on hidden elements */ }
  }
}

window.addEventListener('resize', sizeGameArea);

/* ────────── scanning / switch accessibility ────────── */

function enumerateScanObjects(svgEl, goal) {
  const result = [];
  const topGroup = svgEl.querySelector(':scope > g.mdcr-region');
  if (!topGroup) return result;
  const vb = svgEl.viewBox.baseVal;
  // Goal vertical band — used to exclude reference/model images positioned away from options
  const goalY0 = goal ? Math.min(goal[1], goal[3]) : null;
  const goalY1 = goal ? Math.max(goal[1], goal[3]) : null;
  for (const el of topGroup.children) {
    if (el.tagName === 'metadata') continue;
    try {
      const bbox = el.getBBox();
      if (bbox.width === 0 && bbox.height === 0) continue;
      // Skip background fills that span most of the viewBox
      if (vb && vb.width > 0 && vb.height > 0 &&
          bbox.width > vb.width * 0.9 && bbox.height > vb.height * 0.9) continue;
      // Skip thin/flat elements (decorative lines, dividers, etc.)
      const aspect = Math.min(bbox.width, bbox.height) / Math.max(bbox.width, bbox.height);
      if (aspect < 0.15) continue;
      // Skip reference/model images that don't overlap vertically with the goal area
      if (goalY0 !== null && goalY1 !== null) {
        const objY0 = bbox.y;
        const objY1 = bbox.y + bbox.height;
        if (objY1 < goalY0 || objY0 > goalY1) continue;
      }
      result.push({
        el,
        logRect: { x0: bbox.x, y0: bbox.y, x1: bbox.x + bbox.width, y1: bbox.y + bbox.height }
      });
    } catch (e) { /* getBBox can fail on hidden elements */ }
  }
  return result;
}

function highlightObject(index) {
  const hl = $('#scan-highlight');
  if (!hl || index < 0 || index >= scanObjects.length) {
    if (hl) hl.style.display = 'none';
    return;
  }
  const obj = scanObjects[index];
  const elRect = obj.el.getBoundingClientRect();
  const area = $('#game-area');
  if (!area) return;
  const areaRect = area.getBoundingClientRect();
  const pad = 10;
  hl.style.left = (elRect.left - areaRect.left - pad) + 'px';
  hl.style.top = (elRect.top - areaRect.top - pad) + 'px';
  hl.style.width = (elRect.width + pad * 2) + 'px';
  hl.style.height = (elRect.height + pad * 2) + 'px';
  hl.style.display = 'block';
}

function scanSwitch2() {
  if (rewarding || !currentStep || scanObjects.length === 0) return;
  scanIndex = (scanIndex + 1) % scanObjects.length;
  highlightObject(scanIndex);
}

function scanSwitch1() {
  if (rewarding || !currentStep || scanIndex < 0 || scanIndex >= scanObjects.length) return;
  const obj = scanObjects[scanIndex].logRect;
  const goal = currentStep.goal;
  if (!Array.isArray(goal) || goal.length < 4) return;
  const gx0 = Math.min(goal[0], goal[2]), gy0 = Math.min(goal[1], goal[3]);
  const gx1 = Math.max(goal[0], goal[2]), gy1 = Math.max(goal[1], goal[3]);
  if (obj.x0 < gx1 && obj.x1 > gx0 && obj.y0 < gy1 && obj.y1 > gy0) {
    gotIt();
  } else {
    playSound(currentStep.startSound);
    flashFeedback(false);
  }
}

function startScanning() {
  stopScanning();
  const svgEl = $('#game-pic')?.querySelector('svg');
  if (!svgEl) return;
  scanObjects = enumerateScanObjects(svgEl, currentStep?.goal);
  if (scanObjects.length === 0) return;
  scanIndex = -1;
  scanSwitch2(); // highlight first object
  if (scanMode === '1switch') {
    scanTimerId = setInterval(scanSwitch2, scanTiming);
  }
}

function stopScanning() {
  if (scanTimerId) { clearInterval(scanTimerId); scanTimerId = null; }
  const hl = $('#scan-highlight');
  if (hl) hl.style.display = 'none';
  scanIndex = -1;
  scanObjects = [];
}

/* ────────── selection screen (VB6 layout: 5 buttons + nav arrows) ────────── */
const PAGE_SIZE = 4;
let topicStart = 0;
let activityStart = 0;

/* Topic icons removed - using .gif thumbnails from VB6 */

// Explicit topic display order
const TOPIC_ORDER = [
  '2 and 3 - Simple', 'Colours', 'Shapes I', 'Shapes II',
  'Colours - Complex', 'Pictures', 'Parts', 'Silhouette'
];

function getTopicNames() {
  if (!activities || !activities.topics) return [];
  // Return topics in the explicit order, filtering to those that exist
  return TOPIC_ORDER.filter(t => activities.topics[t]);
}

function showSelect() {
  stopScanning();
  if (!activities || !activities.topics) {
    console.warn('showSelect: activities not loaded yet');
    return;
  }
  showScreen('#select-screen');
  const topics = getTopicNames();
  if (topics.length === 0) return;
  if (!currentTopic) {
    // First load — start from beginning
    topicStart = 0;
    renderTopics();
    selectTopic(topics[0]);
  } else {
    // Returning from game — preserve current position
    const idx = topics.indexOf(currentTopic);
    if (idx >= 0) topicStart = Math.floor(idx / PAGE_SIZE) * PAGE_SIZE;
    renderTopics();
    renderActivities(currentTopic);
  }
}

/** Get the first chain step data for a topic (from its first activity) */
function getTopicThumbData(topicName) {
  try {
    const topic = activities.topics[topicName];
    if (!topic || !topic.activities || !topic.activities[0]) return null;
    const act = topic.activities[0];
    if (!act.chain || !act.chain[0]) return null;
    const step = act.chain[0];
    // Override thumbnail background for topics that look too similar
    const thumbBgOverrides = {
      'Shapes I': { backPic: 'backgrounds/Real world patterns/grass.jpg' }
    };
    if (thumbBgOverrides[topicName]) {
      return { ...step, ...thumbBgOverrides[topicName] };
    }
    return step;
  } catch (_) { return null; }
}

/** Get the first chain step data for a specific activity */
function getActivityThumbData(topicName, actIndex) {
  try {
    const act = activities.topics[topicName].activities[actIndex];
    if (!act || !act.chain || !act.chain[0]) return null;
    return act.chain[0];
  } catch (_) { return null; }
}

/** Load an image and return a promise */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed: ' + src));
    img.src = src;
  });
}

/**
 * Generate a thumbnail by rendering the activity's game view onto a canvas.
 * Uses the same widescreen rendering pipeline as the actual game:
 * background colour → background image → SVG stretched with compensateStretch.
 */
async function generateThumb(stepData) {
  if (!stepData || !stepData.pic) return null;
  // Render at 16:9 widescreen (same proportions as the game display)
  // so shapes are spread apart exactly as they appear in-game
  const W = 640, H = 360;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // 1. Background colour
  ctx.fillStyle = stepData.background || '#000000';
  ctx.fillRect(0, 0, W, H);

  // 2. Background image (if any)
  if (stepData.backPic) {
    try {
      const bgImg = await loadImage(stepData.backPic);
      ctx.drawImage(bgImg, 0, 0, W, H);
    } catch (_) { /* use colour only */ }
  }

  // 3. SVG content — stretch to fill (preserveAspectRatio="none") then
  //    apply compensateStretch to restore individual shape aspect ratios,
  //    exactly as the game does at runtime
  const svgText = await loadSvgOrImg(stepData.pic);
  if (!svgText) return canvas.toDataURL('image/png');

  // Parse SVG into a temporary DOM element so compensateStretch can use getBBox
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:' + W + 'px;height:' + H + 'px;';
  wrapper.innerHTML = svgText;
  document.body.appendChild(wrapper);
  try {
    const svgEl = wrapper.querySelector('svg');
    if (svgEl) {
      svgEl.style.width = W + 'px';
      svgEl.style.height = H + 'px';
      svgEl.setAttribute('preserveAspectRatio', 'none');
      compensateStretch(svgEl);
      // Serialise the modified SVG and draw onto canvas
      const serialised = new XMLSerializer().serializeToString(svgEl);
      const blob = new Blob([serialised], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      try {
        const svgImg = await loadImage(url);
        ctx.drawImage(svgImg, 0, 0, W, H);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } finally {
    document.body.removeChild(wrapper);
  }
  return canvas.toDataURL('image/png');
}

/** Render a canvas-captured thumbnail into a button */
function loadThumbSvg(btn, stepData) {
  if (!stepData || !stepData.pic) return;
  generateThumb(stepData).then(dataUrl => {
    if (!dataUrl) return;
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '';
    img.draggable = false;
    img.style.cssText = 'width:100%;height:100%;object-fit:fill;border-radius:6px;';
    btn.appendChild(img);
  }).catch(() => { /* keep button empty on failure */ });
}

function renderTopics() {
  const row = $('#topic-row');
  if (!row) return;
  row.innerHTML = '';
  const topics = getTopicNames();
  if (topics.length === 0) return;
  const end = Math.min(topicStart + PAGE_SIZE, topics.length);
  for (let i = topicStart; i < end; i++) {
    const name = topics[i];
    if (!name) continue;
    const btn = document.createElement('button');
    btn.className = 'topic-btn';
    if (name === currentTopic) btn.classList.add('selected');
    // Load crisp SVG thumbnail with background from the topic's first activity
    loadThumbSvg(btn, getTopicThumbData(name));
    btn.addEventListener('click', () => selectTopic(name));
    row.appendChild(btn);
  }
  // Nav arrows
  const leftBtn = $('#topic-left');
  const rightBtn = $('#topic-right');
  if (leftBtn) leftBtn.classList.toggle('visible', topicStart > 0);
  if (rightBtn) rightBtn.classList.toggle('visible', end < topics.length);
}

function selectTopic(name) {
  if (!name || !activities || !activities.topics[name]) return;
  currentTopic = name;
  // Update selected state on visible buttons
  const topics = getTopicNames();
  const row = $('#topic-row');
  if (row) {
    const btns = row.querySelectorAll('.topic-btn');
    btns.forEach((btn, i) => {
      const idx = topicStart + i;
      btn.classList.toggle('selected', idx < topics.length && topics[idx] === name);
    });
  }
  activityStart = 0;
  renderActivities(name);
}

function renderActivities(name) {
  const row = $('#activity-row');
  if (!row) return;
  row.innerHTML = '';
  const topic = activities && activities.topics ? activities.topics[name] : null;
  if (!topic || !Array.isArray(topic.activities) || topic.activities.length === 0) return;
  const acts = topic.activities;
  const end = Math.min(activityStart + PAGE_SIZE, acts.length);
  for (let i = activityStart; i < end; i++) {
    const act = acts[i];
    if (!act || !act.name) continue;
    const btn = document.createElement('button');
    btn.className = 'activity-btn';
    // Load crisp SVG thumbnail with background from the activity's first step
    loadThumbSvg(btn, getActivityThumbData(name, i));
    const actIndex = i;
    btn.addEventListener('click', () => {
      ensureAudio();
      startActivity(name, actIndex);
    });
    row.appendChild(btn);
  }
  // Nav arrows
  const leftBtn = $('#activity-left');
  const rightBtn = $('#activity-right');
  if (leftBtn) leftBtn.classList.toggle('visible', activityStart > 0);
  if (rightBtn) rightBtn.classList.toggle('visible', end < acts.length);
}

// Navigation arrow handlers (with null guards for DOM elements)
const topicLeftEl = $('#topic-left');
const topicRightEl = $('#topic-right');
const actLeftEl = $('#activity-left');
if (topicLeftEl) topicLeftEl.addEventListener('click', () => {
  topicStart = Math.max(0, topicStart - PAGE_SIZE);
  renderTopics();
});
if (topicRightEl) topicRightEl.addEventListener('click', () => {
  const topics = getTopicNames();
  if (topicStart + PAGE_SIZE < topics.length) {
    topicStart += PAGE_SIZE;
    renderTopics();
  }
});
if (actLeftEl) actLeftEl.addEventListener('click', () => {
  activityStart = Math.max(0, activityStart - PAGE_SIZE);
  if (currentTopic) renderActivities(currentTopic);
});
const actRightEl = $('#activity-right');
if (actRightEl) actRightEl.addEventListener('click', () => {
  if (!currentTopic || !activities || !activities.topics[currentTopic]) return;
  const acts = activities.topics[currentTopic].activities;
  if (Array.isArray(acts) && activityStart + PAGE_SIZE < acts.length) {
    activityStart += PAGE_SIZE;
    renderActivities(currentTopic);
  }
});

const backBtnEl = $('#btn-back-game');
if (backBtnEl) backBtnEl.addEventListener('click', () => showSelect());

/* ────────── settings panel ────────── */
(function initSettings() {
  const btn = $('#btn-settings');
  const panel = $('#settings-panel');
  if (!btn || !panel) return;

  btn.addEventListener('click', () => {
    panel.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') &&
        !panel.contains(e.target) &&
        !btn.contains(e.target)) {
      panel.classList.add('hidden');
    }
  });

  // Highlight the active mode button
  function updateModeButtons() {
    $$('.scan-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === scanMode);
    });
    const speedRow = $('#scan-speed-row');
    if (speedRow) {
      speedRow.classList.toggle('hidden', scanMode === 'off');
    }
  }

  $$('.scan-mode-btn').forEach(b => {
    b.addEventListener('click', () => {
      scanMode = b.dataset.mode;
      localStorage.setItem('matchem_scanMode', scanMode);
      updateModeButtons();
    });
  });

  const speedSlider = $('#scan-speed');
  if (speedSlider) {
    speedSlider.value = scanTiming;
    speedSlider.addEventListener('input', () => {
      scanTiming = parseInt(speedSlider.value);
      localStorage.setItem('matchem_scanTiming', String(scanTiming));
    });
  }

  updateModeButtons();
})();

/* ────────── game ────────── */
function startActivity(topicName, activityIndex) {
  if (!activities || !activities.topics || !activities.topics[topicName]) {
    console.error('startActivity: invalid topic', topicName);
    return;
  }
  const acts = activities.topics[topicName].activities;
  if (!Array.isArray(acts) || activityIndex < 0 || activityIndex >= acts.length) {
    console.error('startActivity: invalid activity index', activityIndex);
    return;
  }
  currentTopic = topicName;
  currentActivity = acts[activityIndex];
  if (!currentActivity || !Array.isArray(currentActivity.chain) || currentActivity.chain.length === 0) {
    console.error('startActivity: activity has no chain');
    return;
  }
  chainIndex = 0;
  showScreen('#game-screen');
  sizeGameArea();
  loadStep();
}

async function loadStep() {
  try {
    if (!currentActivity || !Array.isArray(currentActivity.chain) || currentActivity.chain.length === 0) {
      console.error('loadStep: no valid chain');
      showSelect();
      return;
    }
    if (chainIndex < 0 || chainIndex >= currentActivity.chain.length) {
      chainIndex = 0;
    }
    currentStep = currentActivity.chain[chainIndex];
    if (!currentStep) {
      console.error('loadStep: null step at index', chainIndex);
      showSelect();
      return;
    }
    rewarding = false;

    const bg = $('#game-bg');
    const picContainer = $('#game-pic');
    const reward = $('#reward-area');
    if (!bg || !picContainer || !reward) {
      console.error('loadStep: missing DOM elements');
      return;
    }

    // Background
    if (currentStep.backPic) {
      bg.style.backgroundImage = `url('${currentStep.backPic}')`;
      bg.style.backgroundColor = currentStep.background || '#000000';
    } else {
      bg.style.backgroundImage = 'none';
      bg.style.backgroundColor = currentStep.background || '#000000';
    }

    // Clear previous content
    reward.style.display = 'none';
    picContainer.innerHTML = '';

    // Load main picture
    if (currentStep.pic) {
      const svgText = await loadSvgOrImg(currentStep.pic);
      if (svgText) {
        // SVG loaded
        picContainer.innerHTML = svgText;
        const svgEl = picContainer.querySelector('svg');
        if (svgEl) {
          svgEl.removeAttribute('width');
          svgEl.removeAttribute('height');
          svgEl.style.width = '100%';
          svgEl.style.height = '100%';
          // Stretch SVG to fill screen; we compensate individual shapes below
          svgEl.setAttribute('preserveAspectRatio', 'none');
          // Adjust each sub-image to maintain its aspect ratio around its centre
          compensateStretch(svgEl);
        }
      } else {
        // Fallback to img for PNG files
        const img = document.createElement('img');
        img.src = currentStep.pic;
        img.alt = '';
        img.draggable = false;
        img.onerror = () => { console.warn('Failed to load image:', currentStep.pic); };
        picContainer.appendChild(img);
      }
    }

    // Preload sounds
    // VB6 mapping: SoundNames(0)=StartSound→ERROR, SoundNames(1)=BumpSound→FINISH, SoundNames(2)=FinishSound→START
    if (currentStep.startSound) loadSound(currentStep.startSound);
    if (currentStep.bumpSound) loadSound(currentStep.bumpSound);
    if (currentStep.finishSound) {
      playSound(currentStep.finishSound);
    }

    // Start scanning after SVG has rendered
    if (scanMode !== 'off') {
      setTimeout(startScanning, 300);
    }
  } catch (e) {
    console.error('loadStep error:', e);
  }
}

/* ────────── pointer input ────────── */
const gamePicEl = $('#game-pic');
if (gamePicEl) {
  gamePicEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ensureAudio();
    if (scanMode === 'off') {
      handleTouchOrClick(e.clientX, e.clientY);
    } else if (scanMode === '1switch') {
      scanSwitch1();
    } else if (scanMode === '2switch') {
      // Left half of screen = switch 1 (select), right half = switch 2 (advance)
      const midX = window.innerWidth / 2;
      if (e.clientX < midX) {
        scanSwitch1();
      } else {
        scanSwitch2();
      }
    }
  });
}

/* ────────── click detection ────────── */
function handleTouchOrClick(clientX, clientY) {
  if (rewarding || !currentStep) return;

  const picContainer = $('#game-pic');
  if (!picContainer) return;
  const rect = picContainer.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  const px = clientX - rect.left;
  const py = clientY - rect.top;

  const goal = currentStep.goal;
  if (!Array.isArray(goal) || goal.length < 4) {
    console.warn('handleTouchOrClick: invalid goal data');
    return;
  }
  const wext = currentStep.windowExt || [400, 300];
  if (wext[0] <= 0 || wext[1] <= 0) return;

  // game-pic is sized to match SVG aspect ratio, so simple proportional mapping works
  // (no letterboxing offset needed since preserveAspectRatio="none" on the SVG)
  const logX = px / rect.width * wext[0];
  const logY = py / rect.height * wext[1];

  // Check if inside goal rectangle
  const x0 = Math.min(goal[0], goal[2]);
  const y0 = Math.min(goal[1], goal[3]);
  const x1 = Math.max(goal[0], goal[2]);
  const y1 = Math.max(goal[1], goal[3]);

  if (logX >= x0 && logX <= x1 && logY >= y0 && logY <= y1) {
    gotIt();
  } else {
    playSound(currentStep.startSound); // VB6: ERROR_SOUND = SoundNames(0) = StartSound config
    flashFeedback(false);
  }
}

/* ────────── correct answer ────────── */
function gotIt() {
  if (!currentStep) return;
  stopScanning();
  rewarding = true;
  playSound(currentStep.bumpSound); // VB6: FINISH_SOUND = SoundNames(1) = BumpSound config
  showReward();
}

function autoAdvance() {
  if (rewarding || !currentStep || !currentActivity) return;
  gotIt();
}

async function showReward() {
  try {
    if (!currentStep) return;
    const rewardType = currentStep.reward || 0;
    const rewardPic = currentStep.rewardPic;
    const rPos = currentStep.rewardPos;
    const wext = currentStep.windowExt || [400, 300];

    const area = $('#game-area');
    const rd = $('#reward-area');
    if (!area || !rd) return;
    const aw = area.clientWidth;
    const ah = area.clientHeight;
    if (aw <= 0 || ah <= 0) return;

    // Position reward relative to game area (game-pic fills the full area)
    if (Array.isArray(rPos) && rPos.length >= 4 && wext[0] > 0 && wext[1] > 0) {
      const rx0 = rPos[0] / wext[0] * aw;
      const ry0 = rPos[1] / wext[1] * ah;
      const rx1 = rPos[2] / wext[0] * aw;
      const ry1 = rPos[3] / wext[1] * ah;
      rd.style.left = rx0 + 'px';
      rd.style.top = ry0 + 'px';
      rd.style.width = Math.max(1, rx1 - rx0) + 'px';
      rd.style.height = Math.max(1, ry1 - ry0) + 'px';
    } else {
      // Fallback: centre reward at quarter size
      rd.style.left = (aw * 0.25) + 'px';
      rd.style.top = (ah * 0.25) + 'px';
      rd.style.width = (aw * 0.5) + 'px';
      rd.style.height = (ah * 0.5) + 'px';
    }
    rd.innerHTML = '';

    if (rewardPic) {
      const svgText = await loadSvgOrImg(rewardPic);
      if (svgText) {
        rd.innerHTML = svgText;
        const svgEl = rd.querySelector('svg');
        if (svgEl) {
          svgEl.removeAttribute('width');
          svgEl.removeAttribute('height');
          svgEl.style.width = '100%';
          svgEl.style.height = '100%';
        }
      } else {
        const img = document.createElement('img');
        img.src = rewardPic;
        img.alt = '';
        img.draggable = false;
        img.onerror = () => { console.warn('Failed to load reward image:', rewardPic); };
        rd.appendChild(img);
      }
    }
    rd.style.display = 'block';

    // Run reward animation
    animateReward(rewardType, rd, () => {
      setTimeout(() => {
        if (!currentActivity || !Array.isArray(currentActivity.chain)) {
          showSelect();
          return;
        }
        chainIndex++;
        if (chainIndex >= currentActivity.chain.length) {
          showSelect();
        } else {
          loadStep();
        }
      }, 400);
    });
  } catch (e) {
    console.error('showReward error:', e);
    // Recover by advancing
    chainIndex++;
    if (!currentActivity || chainIndex >= (currentActivity.chain?.length || 0)) {
      showSelect();
    } else {
      loadStep();
    }
  }
}

/* ────────── reward animations (24 types) ────────── */
function animateReward(type, el, onDone) {
  if (!el || typeof onDone !== 'function') { if (onDone) onDone(); return; }
  const dur = 1200;
  const start = performance.now();
  const origLeft = parseFloat(el.style.left) || 0;
  const origTop = parseFloat(el.style.top) || 0;
  const origW = parseFloat(el.style.width) || 100;
  const origH = parseFloat(el.style.height) || 100;
  const area = $('#game-area');
  const areaW = area ? area.clientWidth : window.innerWidth;
  const areaH = area ? area.clientHeight : window.innerHeight;

  function tick(now) {
    const t = Math.min((now - start) / dur, 1);

    switch (type) {
      case 0: break;
      case 1:
        el.style.left = (Math.random() * (areaW - origW)) + 'px';
        el.style.top = (Math.random() * (areaH - origH)) + 'px';
        break;
      case 2:
        el.style.left = (origLeft + (Math.random() - 0.5) * 20) + 'px';
        el.style.top = (origTop + (Math.random() - 0.5) * 20) + 'px';
        break;
      case 3:
        { const s = 1 + Math.sin(t * Math.PI * 6) * 0.3;
        el.style.transform = `scale(${s})`; }
        break;
      case 4:
        el.style.left = (origLeft - origLeft * t - origW * t) + 'px';
        break;
      case 5:
        el.style.left = (origLeft + (areaW - origLeft) * t) + 'px';
        break;
      case 6:
        el.style.top = (origTop - origTop * t - origH * t) + 'px';
        break;
      case 7:
        el.style.top = (origTop + (areaH - origTop) * t) + 'px';
        break;
      case 8:
        el.style.opacity = Math.sin(t * Math.PI * 8) > 0 ? '1' : '0';
        break;
      case 9:
        el.style.transform = `rotate(${t * 360}deg)`;
        break;
      case 10:
        { const s = 1 - t;
        el.style.transform = `scale(${s})`; }
        break;
      case 11:
        el.style.transform = `scaleX(${1 - t})`;
        break;
      case 12:
        el.style.transform = `scaleY(${1 - t})`;
        break;
      case 13:
        { const s = 1 + t * 3;
        el.style.transform = `scale(${s})`; }
        break;
      case 14:
        el.style.transform = `scaleX(${Math.cos(t * Math.PI * 2)})`;
        break;
      case 15:
        el.style.transform = `scaleY(${Math.cos(t * Math.PI * 2)})`;
        break;
      case 16:
        el.style.left = (origLeft - origLeft * t - origW * t) + 'px';
        el.style.top = (origTop + (Math.random() - 0.5) * 30) + 'px';
        break;
      case 17:
        el.style.left = (origLeft + (areaW - origLeft) * t) + 'px';
        el.style.top = (origTop + (Math.random() - 0.5) * 30) + 'px';
        break;
      case 18:
        el.style.top = (origTop - origTop * t - origH * t) + 'px';
        el.style.left = (origLeft + (Math.random() - 0.5) * 30) + 'px';
        break;
      case 19:
        el.style.top = (origTop + (areaH - origTop) * t) + 'px';
        el.style.left = (origLeft + (Math.random() - 0.5) * 30) + 'px';
        break;
      case 20:
      case 21:
        { const bg = $('#game-bg');
        bg.style.backgroundColor = `rgb(${rCol()},${rCol()},${rCol()})`; }
        break;
      case 22:
      case 23:
        el.style.filter = `hue-rotate(${t * 720}deg)`;
        break;
      case 24:
        { const bg2 = $('#game-bg');
        bg2.style.backgroundColor = `rgb(${rCol()},${rCol()},${rCol()})`;
        el.style.filter = `hue-rotate(${t * 720}deg)`; }
        break;
    }

    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      el.style.transform = '';
      el.style.opacity = '1';
      el.style.filter = '';
      el.style.left = origLeft + 'px';
      el.style.top = origTop + 'px';
      onDone();
    }
  }

  if (type === 0) {
    setTimeout(onDone, 600);
  } else {
    requestAnimationFrame(tick);
  }
}

function rCol() {
  return Math.floor(Math.random() * 3) * 127;
}

/* ────────── visual feedback ────────── */
function flashFeedback(correct) {
  try {
    const canvas = $('#fx-canvas');
    const area = $('#game-area');
    if (!canvas || !area) return;
    canvas.width = area.clientWidth || window.innerWidth;
    canvas.height = area.clientHeight || window.innerHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = correct ? 'rgba(0, 200, 0, 0.3)' : 'rgba(200, 0, 0, 0.3)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setTimeout(() => {
      try { ctx.clearRect(0, 0, canvas.width, canvas.height); }
      catch (_) { /* canvas may have been removed */ }
    }, 200);
  } catch (e) {
    console.warn('flashFeedback error:', e.message);
  }
}

/* ────────── keyboard ────────── */
document.addEventListener('keydown', (e) => {
  try {
    const gameScreen = $('#game-screen');
    if (!gameScreen || !gameScreen.classList.contains('active')) return;
    if (e.key === 'Escape') {
      showSelect();
      return;
    }
    if (e.key === ' ' || e.key === '1' || e.key === 'Enter' || e.key === '2') {
      e.preventDefault();
      ensureAudio();
      if (scanMode === 'off') {
        autoAdvance();
      } else if (scanMode === '1switch') {
        scanSwitch1();
      } else if (scanMode === '2switch') {
        if (e.key === ' ' || e.key === '1') {
          scanSwitch1();
        } else {
          scanSwitch2();
        }
      }
    }
  } catch (err) {
    console.warn('keydown handler error:', err.message);
  }
});

/* ────────── gamepad ────────── */
let gpPolling = false;
let gpPrevButtons = false;

function startGamepadPoll() {
  if (gpPolling) return;
  gpPolling = true;
  requestAnimationFrame(pollGamepad);
}

function pollGamepad() {
  try {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    let anyConnected = false;
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (!gp) continue;
      anyConnected = true;
      const gameScreen = $('#game-screen');
      if (gameScreen && gameScreen.classList.contains('active')) {
        const b0 = gp.buttons[0]?.pressed || false;
        const b1 = gp.buttons[1]?.pressed || false;
        const b2 = gp.buttons[2]?.pressed || false;
        const b3 = gp.buttons[3]?.pressed || false;
        const anyNow = b0 || b1 || b2 || b3;
        if (anyNow && !gpPrevButtons) {
          ensureAudio();
          if (scanMode === 'off') {
            autoAdvance();
          } else if (scanMode === '1switch') {
            scanSwitch1();
          } else if (scanMode === '2switch') {
            if (b0 || b2) scanSwitch1();
            else scanSwitch2();
          }
        }
        gpPrevButtons = anyNow;
      }
      break;
    }
    if (anyConnected) requestAnimationFrame(pollGamepad);
    else gpPolling = false;
  } catch (e) {
    console.warn('pollGamepad error:', e.message);
    gpPolling = false;
  }
}

window.addEventListener('gamepadconnected', startGamepadPoll);

/* ────────── background animations using activity images ────────── */

// Full pool of representative SVG images from all topics
const ALL_BG_SVGS = [
  'svg/2 and 3 - Simple/odd 1.svg', 'svg/2 and 3 - Simple/odd 3.svg',
  'svg/2 and 3 - Simple/odd 5.svg', 'svg/2 and 3 - Simple/odd 7.svg',
  'svg/2 and 3 - Simple/3 1.svg', 'svg/2 and 3 - Simple/3 5.svg',
  'svg/2 and 3 - Simple/3 9.svg', 'svg/2 and 3 - Simple/2 3.svg',
  'svg/2 and 3 - Simple/Shape 1 2.svg', 'svg/2 and 3 - Simple/Shape 1 6.svg',
  'svg/Colours/circle1.svg', 'svg/Colours/circle3.svg',
  'svg/Colours/circle5.svg', 'svg/Colours/circle7.svg',
  'svg/Colours/triangle2.svg', 'svg/Colours/triangle5.svg',
  'svg/Colours/triangle8.svg', 'svg/Colours/odd line3.svg',
  'svg/Colours/odd line7.svg', 'svg/Colours/in line4.svg',
  'svg/Colours - Complex/Complex11.svg', 'svg/Colours - Complex/Complex21.svg',
  'svg/Colours - Complex/Complex31.svg', 'svg/Colours - Complex/Complex41.svg',
  'svg/Colours - Complex/Complex15.svg', 'svg/Colours - Complex/Complex25.svg',
  'svg/Parts/a1.svg', 'svg/Parts/a4.svg', 'svg/Parts/a7.svg',
  'svg/Parts/k2.svg', 'svg/Parts/k4.svg', 'svg/Parts/k7.svg',
  'svg/Parts/t1.svg', 'svg/Parts/t5.svg', 'svg/Parts/t8.svg',
  'svg/Pictures/pic11.svg', 'svg/Pictures/pic15.svg', 'svg/Pictures/pic19.svg',
  'svg/Pictures/pic22.svg', 'svg/Pictures/pic28.svg', 'svg/Pictures/pic31.svg',
  'svg/Pictures/pic35.svg', 'svg/Pictures/pic41.svg', 'svg/Pictures/pic45.svg',
  'svg/Pictures/pic51.svg', 'svg/Pictures/pic55.svg', 'svg/Pictures/pic59.svg',
  'svg/Shapes I/shape11.svg', 'svg/Shapes I/shape15.svg', 'svg/Shapes I/shape19.svg',
  'svg/Shapes I/shape22.svg', 'svg/Shapes I/shape25.svg', 'svg/Shapes I/shape29.svg',
  'svg/Shapes I/shape33.svg', 'svg/Shapes I/shape37.svg',
  'svg/Shapes II/odd11.svg', 'svg/Shapes II/odd15.svg', 'svg/Shapes II/odd21.svg',
  'svg/Shapes II/odd25.svg', 'svg/Shapes II/odd31.svg', 'svg/Shapes II/odd35.svg',
  'svg/Shapes II/Shape11.svg', 'svg/Shapes II/Shape15.svg',
  'svg/Shapes II/Shape21.svg', 'svg/Shapes II/Shape25.svg',
  'svg/Silhouette/ab1 1.svg', 'svg/Silhouette/ab1 4.svg', 'svg/Silhouette/ab1 7.svg',
  'svg/Silhouette/ab2 2.svg', 'svg/Silhouette/ab2 5.svg',
  'svg/Silhouette/ap2.svg', 'svg/Silhouette/ap5.svg',
  'svg/Silhouette/bl2.svg', 'svg/Silhouette/bl5.svg',
  'svg/Silhouette/d1.svg', 'svg/Silhouette/d5.svg', 'svg/Silhouette/d9.svg',
];

/** Fisher-Yates shuffle (in-place) */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Pick n random unique items from array */
function pickRandom(arr, n) {
  const copy = arr.slice();
  shuffle(copy);
  return copy.slice(0, Math.min(n, copy.length));
}

// Multiple float animation styles so each image moves differently
const FLOAT_ANIMS = ['floatA', 'floatB', 'floatC', 'floatD', 'floatE'];

/**
 * Extract a single random sub-image from a multi-image SVG.
 * Each SVG contains 3-5 sub-images arranged in the game layout;
 * this picks one and returns a new SVG showing just that element.
 */
function extractRandomSubImage(svgText, picUrl) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:400px;height:300px;';
  wrapper.innerHTML = svgText;
  document.body.appendChild(wrapper);
  try {
    const svgEl = wrapper.querySelector('svg');
    if (!svgEl) return null;
    svgEl.style.width = '400px';
    svgEl.style.height = '300px';
    const topGroup = svgEl.querySelector('g.mdcr-region');
    if (!topGroup) return null;
    // Get viewBox dimensions for size filtering
    const vb = svgEl.viewBox.baseVal;
    const svgW = (vb && vb.width > 0) ? vb.width : 400;
    const svgH = (vb && vb.height > 0) ? vb.height : 300;
    // Collect child elements that are real content (skip empty/border rects
    // and skip composite groups that span most of the SVG width — these
    // contain multiple sub-images arranged in a row)
    const contentItems = [];
    for (const child of topGroup.children) {
      if (child.tagName === 'rect') {
        const fill = child.getAttribute('fill');
        if (!fill || fill === 'none') continue;
      }
      try {
        const bbox = child.getBBox();
        if (bbox.width > 5 && bbox.height > 5) {
          // Skip composite rows: groups wider than 50% of the SVG that
          // are much wider than tall (aspect ratio < 0.5) — these are
          // rows of multiple images, not single sub-images
          if (bbox.width > svgW * 0.5 && bbox.height / bbox.width < 0.5) continue;
          contentItems.push({ el: child, bbox });
        }
      } catch (_) { /* skip elements where getBBox fails */ }
    }
    if (contentItems.length === 0) return null;
    // Pick one random sub-image
    const picked = contentItems[Math.floor(Math.random() * contentItems.length)];
    const { bbox } = picked;
    // Add 10% padding around the bounding box
    const pad = Math.max(bbox.width, bbox.height) * 0.1;
    const vbX = bbox.x - pad;
    const vbY = bbox.y - pad;
    const vbW = bbox.width + pad * 2;
    const vbH = bbox.height + pad * 2;
    // Clone element into a new standalone SVG
    const ns = 'http://www.w3.org/2000/svg';
    const newSvg = document.createElementNS(ns, 'svg');
    newSvg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
    newSvg.setAttribute('xmlns', ns);
    newSvg.style.width = '100%';
    newSvg.style.height = '100%';
    newSvg.appendChild(picked.el.cloneNode(true));
    return newSvg.outerHTML;
  } catch (e) {
    console.warn('extractRandomSubImage error:', e.message);
    return null;
  } finally {
    document.body.removeChild(wrapper);
  }
}

function spawnBackgroundShapes() {
  const screen = $('#select-screen');
  if (!screen) return;

  const COLS = 6, ROWS = 3;
  const NUM_IMAGES = COLS * ROWS; // 18 images in a 6×3 grid
  const chosen = pickRandom(ALL_BG_SVGS, NUM_IMAGES);

  // Pre-compute grid cell positions so images are evenly spaced
  const cellW = 100 / COLS;  // % width per cell
  const cellH = 100 / ROWS;  // % height per cell
  const gridSlots = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      gridSlots.push({ col: c, row: r });
    }
  }
  shuffle(gridSlots); // randomise which slot each image gets

  chosen.forEach((svgUrl, idx) => {
    const slot = gridSlots[idx];
    loadSvgOrImg(svgUrl).then(svgText => {
      if (!svgText) return;
      const singleSvg = extractRandomSubImage(svgText, svgUrl);
      if (!singleSvg) return;
      const el = document.createElement('div');
      el.className = 'bg-float-img';
      el.innerHTML = singleSvg;
      // Vary size randomly, scaling with viewport
      const baseSize = Math.min(window.innerWidth, window.innerHeight) * 0.12;
      const size = baseSize + Math.floor(Math.random() * baseSize * 0.6);
      el.style.width = size + 'px';
      el.style.height = size + 'px';
      // Place within grid cell with random jitter (keeps images spaced apart)
      const jitterX = Math.random() * (cellW - 12); // keep within cell bounds
      const jitterY = Math.random() * (cellH - 12);
      el.style.left = (slot.col * cellW + jitterX) + '%';
      el.style.top  = (slot.row * cellH + jitterY) + '%';
      // Random animation
      const anim = FLOAT_ANIMS[Math.floor(Math.random() * FLOAT_ANIMS.length)];
      const dur = 8 + Math.random() * 14;
      const delay = Math.random() * 10;
      el.style.animation = `${anim} ${dur}s ease-in-out ${delay}s infinite`;
      el.style.opacity = String(0.25 + Math.random() * 0.2);
      screen.appendChild(el);
    }).catch(() => { /* silently skip failed SVG loads */ });
  });

  // Small sparkle dots
  const colors = ['#ff4466', '#44ccff', '#44ff88', '#ffaa33', '#cc66ff', '#ff66aa'];
  for (let i = 0; i < 15; i++) {
    const dot = document.createElement('div');
    dot.className = 'bg-particle';
    const size = 3 + Math.random() * 5;
    dot.style.width = size + 'px';
    dot.style.height = size + 'px';
    dot.style.borderRadius = '50%';
    dot.style.left = Math.random() * 100 + '%';
    dot.style.top = Math.random() * 100 + '%';
    dot.style.background = colors[Math.floor(Math.random() * colors.length)];
    dot.style.animation = `sparkle ${3 + Math.random() * 4}s ease-in-out ${Math.random() * 5}s infinite`;
    screen.appendChild(dot);
  }
}

/* ────────── init ────────── */
async function init() {
  try {
    sizeGameArea();
    spawnBackgroundShapes();
    const resp = await fetch('activities.json');
    if (!resp.ok && resp.status !== 0) throw new Error('HTTP ' + resp.status + ' loading activities.json');
    const data = await resp.json();
    if (!data || !data.topics) throw new Error('Invalid activities.json format');
    activities = data;
    showSelect();
  } catch (e) {
    console.error('init error:', e);
    // Show a user-visible error
    const screen = $('#select-screen');
    if (screen) {
      const msg = document.createElement('div');
      msg.style.cssText = 'color:#ff6666;font-size:20px;text-align:center;padding:40px;z-index:100;position:relative;';
      msg.textContent = 'Failed to load activities. Please refresh.';
      screen.appendChild(msg);
    }
  }
}

init();
