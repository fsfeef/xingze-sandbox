// 星泽市 · 小地图（4 路 maps.js）
// 只做小地图：不做大地图、不做导览、不做热力、不做测距、不标 POI 图标。
// 放大动效按 Lucian UX/UI #475 Morphing popover（MIT）移植：宽 .52s
// cubic-bezier(.32,1.32,.5,1)、高 .56s cubic-bezier(.32,1.25,.5,1)，颜色换成
// 我们自己的游戏画面风格；开关沿用 #433（.d-sw 样式在 shell-overrides.css，
// 与 #433 的 54×32 拉伸滑块 + 弹簧回弹一致，本文件不重复造）。
// K06（对照清单）：小地图换游戏画面风格——小图盖一层深蓝 multiply tint
// （#0B1026，不改 app.js 的画布像素，点按飞行不受影响）、放大层画完总览图
// 再罩一层深蓝，底色 #0E1530；白膜模式下两层 tint 都收起。
// 现有 #minimap-wrap / #minimap 是 app.js 画的（总览图预览 + 地标金点 +
// 玩家蓝点 + 点按飞行），本模块不重画、不抢它的 0.4s 重绘，只做四件事：
// ① 保住可见：四种模式（鸟瞰/街面/夜景/白膜）下都强制可见，加霓虹边框与状态条；
// ② 自检：checkMinimap() 采样画布像素，空图能报出来；
// ③ 点开先是小地图、再慢慢放大：点“放大”先以小尺寸弹出，再用 0.6s 过渡
//    放大到大尺寸；放大层是本模块自己的 canvas，裁总览图、只看玩家周围
//    6km 一圈（六区全境都适用，一环以外也一样，总览图就是六区 OSM 数据画的）；
// ④ 跟着玩家实时动：放大层每 300ms 以玩家为中心重画，拖动平移后跟随暂停，
//    点“回到我的位置”恢复跟随、平滑回到玩家身上。
// 名字只在地图里：放大层上只画地标的虚构名（data/six-names.json，按坐标对上
// six-index.json，25/25 全对上才显示；对不上/取不到就不显示，绝不自编名、
// 绝不回落到真名；新名一旦等于任何旧名直接丢弃，见 loadLabels）；3D 场景里不加任何浮动标签；放大层上不画 POI 图标，
// 只有文字。本模块不向 3D 场景加任何对象（无 Sprite、无标签、无 POI 图标）：名字只画在放大层 canvas 上。注意：小图上的地标金点是 app.js drawMinimapSix 画的，本模块
// 动不了 app.js，去掉金点要总协调在 app.js 里改（见报告“还差什么”）。
// 环视（方案 §3.11）：与航拍并列的模式按钮，拖动绕目标点转，捏合/滚轮改距离。
// 只动航拍层面的 state.yaw/el/dist/target，绝不碰走路/开车/飞行的第一人称硬标准
// （滑动拉画面、捏合只变 FOV、镜头绝不自己转）；退出环视恢复进入前的快照，位置不乱。

let ctx = null;
let badge = null, orbitBtn = null, timer = 0;
const orbit = { active: false, snap: null, pointers: new Map(), pinch0: 0 };

// ---------- 放大层 ----------
const ZOOM_WORLD = 6000;          // 放大层一次看 6000m 宽（约 11 倍于总览）
const ZOOM_PX = 672;              // 放大层 canvas 内部分辨率
const ZOOM_MAX = 520;             // 放大层最大 CSS 边长
let zoomBox = null, zoomCv = null, zoomCtx2d = null, zoomImg = null;
let zoomTimer = 0, zoomAnim = 0;
let zoomLabels = [];              // [{x, z, name}] 虚构名，按坐标对上
let labelsLoaded = false;
let labelsDropped = 0;            // 新名等于旧名被丢弃的数量（应为 0）
let displayMode = 'normal';       // normal | white（白膜时两层 tint 收起）
let tintDiv = null;
const zoom = { open: false, follow: true, cx: 0, cz: 0, drag: null, moved: 0 };

// cubic-bezier 求值（Lucian #475 的两条曲线直接拿来用，JS 逐帧算，不依赖合成器帧）
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  function sx(t) { return ((ax * t + bx) * t + cx) * t; }
  function sy(t) { return ((ay * t + by) * t + cy) * t; }
  function dx(t) { return (3 * ax * t + 2 * bx) * t + cx; }
  return (x) => {
    let t = x;
    for (let i = 0; i < 5; i++) { const e = sx(t) - x; if (Math.abs(e) < 1e-4) break; t -= e / (dx(t) || 1e-6); }
    return sy(clamp(t, 0, 1));
  };
}
const easeW = cubicBezier(0.32, 1.32, 0.5, 1);   // #475 宽 .52s
const easeH = cubicBezier(0.32, 1.25, 0.5, 1);   // #475 高 .56s
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// JS 逐帧改尺寸：终态由定时器保证落到目标值，不靠 CSS 过渡/合成器帧
function animateBoxSize(from, to, done) {
  if (zoomAnim) { clearInterval(zoomAnim); zoomAnim = 0; }
  if (reduceMotion() || from === to) {
    if (zoomBox) { zoomBox.style.width = to + 'px'; zoomBox.style.height = to + 'px'; }
    if (done) done();
    return;
  }
  const t0 = performance.now();
  zoomAnim = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / 560);
    const w = from + (to - from) * easeW(k), h = from + (to - from) * easeH(k);
    if (zoomBox) { zoomBox.style.width = Math.round(w) + 'px'; zoomBox.style.height = Math.round(h) + 'px'; }
    if (k >= 1) { clearInterval(zoomAnim); zoomAnim = 0; if (done) done(); }
  }, 16);
}

function ensureShellCss() {
  if (document.getElementById('d-shell-css')) return;
  const l = document.createElement('link');
  l.id = 'd-shell-css'; l.rel = 'stylesheet'; l.href = './shell-overrides.css';
  document.head.appendChild(l);
}
function $(s) { return document.querySelector(s); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function playerPos() {
  const st = ctx.state;
  if (!st) return { x: 0, z: 0, label: '—' };
  if (st.mode === 'aerial' && st.target) return { x: st.target.x, z: st.target.z, label: '航拍' };
  if (st.mode === 'drive' && ctx.camera) return { x: ctx.camera.position.x, z: ctx.camera.position.z, label: '开车' };
  if (st.pos) return { x: st.pos.x, z: st.pos.z, label: st.mode === 'walk' ? '走路' : st.mode === 'fly' ? '飞行' : st.mode };
  return { x: 0, z: 0, label: st.mode || '—' };
}

function updateBadge() {
  const wrap = $('#minimap-wrap');
  if (wrap && wrap.style.display === 'none') wrap.style.display = ''; // 四种模式下全可见
  if (!badge) return;
  const p = playerPos();
  const mode = (ctx.state && ctx.state.display) || 'normal';
  const modeName = mode === 'white' ? '白膜' : mode === 'heat' ? '热力' : '正常';
  const fol = zoom.open ? (zoom.follow ? ' · 跟随中' : ' · 跟随已暂停') : '';
  badge.textContent = `${p.label} · ${modeName} · x ${Math.round(p.x)} z ${Math.round(p.z)}${fol}`;
}

// 自检：小地图画布是不是空图（采样像素，与底色不同的点占比）
function checkMinimap() {
  const wrap = $('#minimap-wrap');
  const cv = $('#minimap');
  if (!wrap || !cv) return { ok: false, reason: 'no-minimap-dom' };
  const cs = getComputedStyle(wrap);
  const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && wrap.getBoundingClientRect().width > 50;
  let varied = 0, sampled = 0;
  try {
    const c2 = cv.getContext('2d');
    const d = c2.getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 0; i < d.length; i += 400) {
      sampled++;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.abs(r - 223) > 12 || Math.abs(g - 229) > 12 || Math.abs(b - 234) > 12) varied++;
    }
  } catch (e) { return { ok: false, reason: 'canvas-read-failed', visible }; }
  return { ok: visible && varied > 5, visible, varied, sampled, mode: (ctx.state && ctx.state.mode) || null, display: (ctx.state && ctx.state.display) || null };
}

// ---------- 放大层：虚构名 ----------
async function loadLabels() {
  try {
    const r = await fetch('../data/six-names.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const names = await r.json();
    const six = ctx.sixIndex;
    const oldNames = new Set([...(names.landmarks || []).map((lm) => lm.old), ...(names.districts || []).map((d) => d.old)]);
    const byCoord = new Map();
    for (const lm of (names.landmarks || [])) byCoord.set(lm.x + ',' + lm.z, lm.new);
    const out = [];
    let dropped = 0;
    for (const lm of ((six && six.landmarks) || [])) {
      const n = byCoord.get(lm.x + ',' + lm.z);
      if (!n) continue; // 对不上就不显示，绝不自编名、不回落真名
      if (oldNames.has(n)) { dropped++; continue; } // 新名绝不能等于任何旧名，等于就丢弃
      out.push({ x: lm.x, z: lm.z, name: n });
    }
    zoomLabels = out;
    labelsDropped = dropped;
    labelsLoaded = true;
  } catch (e) {
    console.warn('[d-maps] six-names.json 取不到，放大层不显示地标名', e);
    zoomLabels = [];
    labelsDropped = 0;
    labelsLoaded = false;
  }
}

// ---------- 放大层：画 ----------
// 世界 → 放大层 canvas 像素（x 东向右，z 南向下）
function zoomProject(x, z) {
  const half = ZOOM_WORLD / 2;
  return { px: ((x - (zoom.cx - half)) / ZOOM_WORLD) * ZOOM_PX, py: (((zoom.cz + half) - z) / ZOOM_WORLD) * ZOOM_PX };
}

function drawZoom() {
  if (!zoom.open || !zoomCv || !zoomCtx2d) return;
  const c = zoomCtx2d;
  const mm = ctx.sixIndex && ctx.sixIndex.minimap;
  c.fillStyle = '#0E1530'; // 地图底（方案 §4）
  c.fillRect(0, 0, ZOOM_PX, ZOOM_PX);
  if (zoomImg && zoomImg.complete && zoomImg.naturalWidth && mm) {
    // 总览图裁出玩家周围一圈：图上像素按 minimap  bounds 换算
    const half = ZOOM_WORLD / 2;
    const x0 = zoom.cx - half, x1 = zoom.cx + half, z0 = zoom.cz - half, z1 = zoom.cz + half;
    const iw = zoomImg.naturalWidth, ih = zoomImg.naturalHeight;
    const sx = ((x0 - mm.x0) / (mm.x1 - mm.x0)) * iw;
    const sy = ((mm.z1 - z1) / (mm.z1 - mm.z0)) * ih;
    const sw = ((x1 - x0) / (mm.x1 - mm.x0)) * iw;
    const sh = ((z1 - z0) / (mm.z1 - mm.z0)) * ih;
    c.drawImage(zoomImg, sx, sy, sw, sh, 0, 0, ZOOM_PX, ZOOM_PX);
    // K06：总览图是浅色预览，罩一层深蓝推向游戏画面风格（白膜模式不罩）
    if (displayMode !== 'white') { c.fillStyle = 'rgba(11,16,38,0.38)'; c.fillRect(0, 0, ZOOM_PX, ZOOM_PX); }
  }
  // 地标名：只画文字，不画 POI 图标；只画视野里的，最多 10 个、按离中心远近排
  const half = ZOOM_WORLD / 2;
  const inView = zoomLabels
    .filter((lm) => Math.abs(lm.x - zoom.cx) <= half && Math.abs(lm.z - zoom.cz) <= half)
    .map((lm) => ({ ...lm, d: Math.hypot(lm.x - zoom.cx, lm.z - zoom.cz) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 10);
  c.font = '600 21px system-ui, sans-serif';
  c.textBaseline = 'middle';
  for (const lm of inView) {
    const p = zoomProject(lm.x, lm.z);
    const w = c.measureText(lm.name).width + 18;
    const bx = clamp(p.px + 12, 4, ZOOM_PX - w - 4), by = clamp(p.py - 14, 4, ZOOM_PX - 32);
    c.fillStyle = 'rgba(11,16,38,0.88)';
    c.beginPath();
    if (c.roundRect) c.roundRect(bx, by, w, 28, 14); else c.rect(bx, by, w, 28);
    c.fill();
    c.fillStyle = '#E8F0FF';
    c.fillText(lm.name, bx + 9, by + 15);
  }
  // 玩家：蓝点 + 白圈（不画朝向箭头：开车 heading 不在 ctx 里，画错方向比不画更糟）
  const pp = playerPos();
  const p = zoomProject(pp.x, pp.z);
  c.beginPath(); c.arc(p.px, p.py, 26, 0, Math.PI * 2);
  c.fillStyle = 'rgba(47,111,237,0.25)'; c.fill();
  c.beginPath(); c.arc(p.px, p.py, 11, 0, Math.PI * 2);
  c.fillStyle = '#2f6fed'; c.fill();
  c.lineWidth = 3; c.strokeStyle = '#fff'; c.stroke();
}

function zoomTick() {
  if (!zoom.open) return;
  const p = playerPos();
  if (zoom.follow) {
    // 跟随：中心每 300ms 向玩家滑过去（0.25 插值），走路/开车/飞行都实时跟
    zoom.cx += (p.x - zoom.cx) * 0.25;
    zoom.cz += (p.z - zoom.cz) * 0.25;
    if (Math.abs(p.x - zoom.cx) < 1 && Math.abs(p.z - zoom.cz) < 1) { zoom.cx = p.x; zoom.cz = p.z; }
  }
  drawZoom();
  updateBadge();
}

function zoomTargetSize() {
  return Math.max(240, Math.min(ZOOM_MAX, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.8)));
}

function zoomOpen() {
  if (zoom.open || !zoomBox) return false;
  const mm = ctx.sixIndex && ctx.sixIndex.minimap;
  if (!mm) return false; // 非六区模式不开（总览图 bounds 只在 six-index 里有）
  const p = playerPos();
  zoom.cx = p.x; zoom.cz = p.z; zoom.follow = true;
  zoom.open = true;
  // 点开先是小地图：先以小尺寸弹出，再用 #475 的曲线慢慢放大到目标尺寸
  const small = Math.round(($('#minimap') || { getBoundingClientRect: () => ({ width: 168 }) }).getBoundingClientRect().width) || 168;
  zoomBox.style.display = 'block';
  zoomBox.style.width = small + 'px';
  zoomBox.style.height = small + 'px';
  drawZoom();
  animateBoxSize(small, zoomTargetSize());
  if (!zoomTimer) zoomTimer = setInterval(zoomTick, 300);
  updateBadge();
  return true;
}

function zoomClose() {
  if (!zoom.open || !zoomBox) return;
  zoom.open = false;
  if (zoomTimer) { clearInterval(zoomTimer); zoomTimer = 0; }
  // 先缩回小尺寸再藏，收起来也慢慢来（#475：收回缩成 pill）
  const small = Math.round(($('#minimap') || { getBoundingClientRect: () => ({ width: 168 }) }).getBoundingClientRect().width) || 168;
  animateBoxSize(parseInt(zoomBox.style.width, 10) || small, small, () => { if (!zoom.open) zoomBox.style.display = 'none'; });
  updateBadge();
}

function zoomRecenter() {
  // “回到我的位置”：恢复跟随；中心由 zoomTick 每 300ms 向玩家滑回去，不瞬跳
  zoom.follow = true;
  updateBadge();
}

function buildZoomUI() {
  const wrap = $('#minimap-wrap');
  if (!wrap || $('#d-map-zoom')) return;
  wrap.style.position = wrap.style.position || 'fixed';

  zoomBox = document.createElement('div');
  zoomBox.id = 'd-map-zoom';
  zoomBox.style.cssText = 'display:none;position:absolute;right:0;bottom:0;z-index:5;'
    + 'border:1.5px solid rgba(0,240,255,.55);border-radius:14px;overflow:hidden;'
    + 'box-shadow:0 0 18px -4px rgba(0,240,255,.55),0 12px 28px -14px rgba(0,0,0,.7);'
    + 'background:#0E1530;touch-action:none;'; // 尺寸由 animateBoxSize（#475 曲线）逐帧改，不用 CSS 过渡
  zoomCv = document.createElement('canvas');
  zoomCv.id = 'd-map-zoom-cv';
  zoomCv.width = ZOOM_PX; zoomCv.height = ZOOM_PX;
  zoomCv.style.cssText = 'width:100%;height:100%;display:block;cursor:grab;';
  zoomBox.appendChild(zoomCv);
  zoomCtx2d = zoomCv.getContext('2d');

  const homeBtn = document.createElement('button');
  homeBtn.id = 'd-map-home-btn';
  homeBtn.textContent = '回到我的位置';
  homeBtn.style.cssText = 'position:absolute;left:8px;bottom:8px;z-index:6;'
    + 'border:1px solid rgba(0,240,255,.5);background:rgba(14,21,48,.92);color:#7DF9FF;'
    + 'border-radius:999px;padding:7px 12px;font-size:12px;font-weight:700;';
  homeBtn.addEventListener('click', (e) => { e.stopPropagation(); zoomRecenter(); });
  zoomBox.appendChild(homeBtn);

  const closeBtn = document.createElement('button');
  closeBtn.id = 'd-map-zoom-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', '收起放大地图');
  closeBtn.style.cssText = 'position:absolute;right:8px;top:8px;z-index:6;width:28px;height:28px;'
    + 'border-radius:50%;border:1px solid rgba(255,255,255,.4);background:rgba(14,21,48,.92);'
    + 'color:#fff;font-size:14px;line-height:1;';
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); zoomClose(); });
  zoomBox.appendChild(closeBtn);

  // 拖动平移：跟随暂停，中心跟着手走；抬手后不自动回，等“回到我的位置”
  zoomCv.addEventListener('pointerdown', (e) => {
    zoom.drag = { x: e.clientX, y: e.clientY, cx: zoom.cx, cz: zoom.cz };
    zoom.moved = 0;
    zoomCv.setPointerCapture(e.pointerId);
    zoomCv.style.cursor = 'grabbing';
  });
  zoomCv.addEventListener('pointermove', (e) => {
    if (!zoom.drag) return;
    const dx = e.clientX - zoom.drag.x, dy = e.clientY - zoom.drag.y;
    zoom.moved = Math.max(zoom.moved, Math.abs(dx) + Math.abs(dy));
    const rect = zoomCv.getBoundingClientRect();
    const mPerPx = ZOOM_WORLD / rect.width;
    zoom.cx = zoom.drag.cx - dx * mPerPx;
    zoom.cz = zoom.drag.cz + dy * mPerPx; // 屏幕向下 = 世界 z 向南（变大）
    zoom.follow = false;
    drawZoom();
    updateBadge();
  });
  const endDrag = () => { zoom.drag = null; zoomCv.style.cursor = 'grab'; };
  zoomCv.addEventListener('pointerup', endDrag);
  zoomCv.addEventListener('pointercancel', endDrag);

  wrap.appendChild(zoomBox);

  // “放大”按钮：挂在状态条下面，不抢小地图本身的点按飞行
  if (!$('#d-map-expand-btn')) {
    const b = document.createElement('button');
    b.id = 'd-map-expand-btn';
    b.textContent = '放大';
    b.style.cssText = 'margin-top:6px;border:1px solid rgba(0,240,255,.5);background:rgba(0,240,255,.1);'
      + 'color:#7DF9FF;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700;';
    b.addEventListener('click', () => { if (zoom.open) zoomClose(); else zoomOpen(); });
    wrap.appendChild(b);
  }

  // 总览图：和 app.js 同一张（six-index.minimap.image），只读来画放大层
  const mm = ctx.sixIndex && ctx.sixIndex.minimap;
  if (mm && mm.image) {
    zoomImg = new Image();
    zoomImg.src = mm.image;
  }
}

// K06：小图深蓝 tint——盖在 #minimap 上一层 multiply 深蓝（#0B1026），
// 只改观感，不改 app.js 画布像素，点按飞行照常（pointer-events:none）；
// 白膜模式收起（setDisplay 里切 opacity）
function positionTint() {
  const cv = $('#minimap');
  if (!tintDiv || !cv) return;
  tintDiv.style.left = cv.offsetLeft + 'px';
  tintDiv.style.top = cv.offsetTop + 'px';
  tintDiv.style.width = cv.offsetWidth + 'px';
  tintDiv.style.height = cv.offsetHeight + 'px';
}
function buildMinimapTint() {
  const wrap = $('#minimap-wrap');
  const cv = $('#minimap');
  if (!wrap || !cv || $('#d-minimap-tint')) return;
  tintDiv = document.createElement('div');
  tintDiv.id = 'd-minimap-tint';
  tintDiv.setAttribute('aria-hidden', 'true');
  tintDiv.style.cssText = 'position:absolute;z-index:2;pointer-events:none;'
    + 'background:#0B1026;opacity:0.30;mix-blend-mode:multiply;border-radius:14px;';
  wrap.appendChild(tintDiv);
  positionTint();
  window.addEventListener('resize', positionTint);
}

// ---------- 环视 ----------
function orbitEnter() {
  const st = ctx.state;
  if (!st || st.mode !== 'aerial') return false;
  orbit.snap = { x: st.target.x, z: st.target.z, yaw: st.yaw, el: st.el, dist: st.dist };
  orbit.active = true;
  if (orbitBtn) orbitBtn.classList.add('orbit-on');
  return true;
}
function orbitExit(restore = true) {
  if (!orbit.active) return;
  orbit.active = false;
  orbit.pointers.clear(); orbit.pinch0 = 0;
  if (restore && orbit.snap) {
    const st = ctx.state;
    st.target.set(orbit.snap.x, 0, orbit.snap.z);
    st.yaw = orbit.snap.yaw; st.el = orbit.snap.el; st.dist = orbit.snap.dist;
  }
  if (orbitBtn) orbitBtn.classList.remove('orbit-on');
}
function orbitTargetTo(x, z) {
  if (!orbit.active) return;
  const st = ctx.state;
  st.target.set(x, 0, z);
  st.dist = clamp(st.dist, 180, 20000);
}

function onPointerDown(e) {
  if (!orbit.active || !e.target || e.target.id !== 'scene') return;
  e.stopPropagation(); e.preventDefault();
  orbit.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (orbit.pointers.size === 2) {
    const [a, b] = [...orbit.pointers.values()];
    orbit.pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
  }
}
function onPointerMove(e) {
  if (!orbit.active || !orbit.pointers.has(e.pointerId)) return;
  e.stopPropagation();
  const prev = orbit.pointers.get(e.pointerId);
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  orbit.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const st = ctx.state;
  if (orbit.pointers.size === 1) {
    st.yaw -= dx * 0.005; // 拖动绕目标点转（只改航拍球面角，不碰第一人称）
    st.el = clamp(st.el - dy * 0.003, 0.08, 1.45);
  } else if (orbit.pointers.size === 2) {
    const [a, b] = [...orbit.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (orbit.pinch0 > 0 && d > 0) st.dist = clamp(st.dist * (orbit.pinch0 / d), 180, 20000);
    orbit.pinch0 = d;
  }
}
function onPointerUp(e) {
  if (!orbit.active) return;
  orbit.pointers.delete(e.pointerId);
  if (orbit.pointers.size < 2) orbit.pinch0 = 0;
}
function onWheel(e) {
  if (!orbit.active || !e.target || e.target.id !== 'scene') return;
  e.stopPropagation(); e.preventDefault();
  const st = ctx.state;
  st.dist = clamp(st.dist * (1 + e.deltaY * 0.001), 180, 20000); // 滚轮改距离（只在环视里）
}

export function init(c) {
  ctx = c;
  ensureShellCss();
  if (window.__dMaps) return window.__dMaps;

  // 小地图状态条（挂在现有 #minimap-wrap 里，不改 index.html）
  const wrap = $('#minimap-wrap');
  if (wrap && !$('#d-minimap-badge')) {
    badge = document.createElement('div');
    badge.id = 'd-minimap-badge';
    // 定宽：坐标文字每 500ms 变长会撑宽 #minimap-wrap（右锚定），导致
    // #minimap 画布在屏上左右漂移，点按换算用的矩形与点击瞬间不一致
    // （1px ≈ 285m，20px 漂移就是 5km 误差）。定宽后画布位置恒定。
    badge.style.cssText = 'display:block;width:200px;margin:0 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    badge.textContent = '小地图 · 点按飞行';
    wrap.appendChild(badge);
  }
  if (!timer) timer = setInterval(updateBadge, 500);
  updateBadge();

  // 放大层（小地图点开 → 慢慢放大 → 跟随 → 回到我的位置）+ 小图深蓝 tint（K06）
  buildZoomUI();
  buildMinimapTint();
  loadLabels();

  // 环视按钮：插进现有 #mode-seg，与航拍并列（运行时 DOM，不改 index.html）
  const seg = $('#mode-seg');
  if (seg && !$('#d-orbit-btn')) {
    orbitBtn = document.createElement('button');
    orbitBtn.id = 'd-orbit-btn';
    orbitBtn.textContent = '环视';
    orbitBtn.setAttribute('aria-pressed', 'false');
    orbitBtn.addEventListener('click', () => {
      if (orbit.active) { orbitExit(true); orbitBtn.setAttribute('aria-pressed', 'false'); }
      else if (orbitEnter()) { orbitBtn.setAttribute('aria-pressed', 'true'); }
    });
    seg.appendChild(orbitBtn);
    // 切到别的模式时环视自动退出（第一人称硬标准不受影响）
    seg.querySelectorAll('button[data-mode]').forEach((b) => b.addEventListener('click', () => {
      if (orbit.active) { orbitExit(true); orbitBtn.setAttribute('aria-pressed', 'false'); }
    }));
  }

  // 点地标后环视目标切到地标（只在环视开着时；用现有列表按钮，不改 app.js）
  const lmBox = $('#list-landmarks');
  if (lmBox) {
    lmBox.addEventListener('click', (e) => {
      if (!orbit.active) return;
      const btn = e.target.closest('button');
      if (!btn) return;
      const name = (btn.querySelector('span') || btn).textContent.trim();
      const lms = (ctx.sixIndex && ctx.sixIndex.landmarks) || (ctx.DATA && ctx.DATA.landmarks) || [];
      const lm = lms.find((m) => m.name === name);
      if (lm) orbitTargetTo(lm.x, lm.z);
    });
  }
  // 点小地图后环视目标切到该点（app.js 原有点按飞行照常走）
  const mm = $('#minimap');
  if (mm) {
    mm.addEventListener('click', (e) => {
      if (!orbit.active) return;
      const six = ctx.sixIndex;
      if (!six || !six.minimap) return;
      const r = mm.getBoundingClientRect();
      const wx = six.minimap.x0 + ((e.clientX - r.left) / r.width) * (six.minimap.x1 - six.minimap.x0);
      const wz = six.minimap.z1 - ((e.clientY - r.top) / r.height) * (six.minimap.z1 - six.minimap.z0);
      orbitTargetTo(wx, wz);
    });
  }

  // 捕获阶段拦截画布指针/滚轮：环视开着时 app.js 的平移/缩放不抢事件
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerUp, true);
  window.addEventListener('wheel', onWheel, true);

  const api = {
    checkMinimap, updateBadge, playerPos,
    zoom: {
      open: () => zoomOpen(),
      close: () => zoomClose(),
      recenter: () => zoomRecenter(),
      get isOpen() { return zoom.open; },
      get follow() { return zoom.follow; },
      get labels() { return zoomLabels.length; },
      get labelsLoaded() { return labelsLoaded; },
      get labelsDropped() { return labelsDropped; },
    },
    orbit: {
      get active() { return orbit.active; },
      enter: orbitEnter, exit: () => orbitExit(true), targetTo: orbitTargetTo,
    },
    get state() { return { orbit: orbit.active, zoomOpen: zoom.open, zoomFollow: zoom.follow, labels: zoomLabels.length, labelsLoaded, labelsDropped, labelsVerified: labelsLoaded && labelsDropped === 0 }; },
  };
  window.__dMaps = api;
  return api;
}

export function setDisplay(mode) {
  // 四种模式下小地图全可见：白膜/热力模式也不许藏
  displayMode = mode;
  const wrap = $('#minimap-wrap');
  if (wrap) wrap.style.display = '';
  if (zoomBox) zoomBox.style.borderColor = mode === 'white' ? 'rgba(255,255,255,.5)' : 'rgba(0,240,255,.55)';
  if (tintDiv) tintDiv.style.opacity = mode === 'white' ? '0' : '0.30'; // 白膜收起深蓝 tint
  if (zoom.open) drawZoom(); // 白膜切回来重画放大层（tint 有/无）
  document.body.classList.toggle('d-white', mode === 'white');
  updateBadge();
}
