// rail.js — 星泽市 · 国铁补线（铁路路，2026-11-27）
// 新模块，不动 roads.js（R 路在改它）、不动 build_six.py（D3 在改它）。
// 只读 data/rail-six-districts-v1.json（OSM railway=rail 六区实抽，见报告）。
//
// 做法（数据层 OSM 直出 + 规则层批量，不手摆坐标、不编数据）：
//   只画 class=gap 的 run：地面/高架段（tunnel 为空），且不在 roads.js
//   RAIL_DATA 25m 内（已画过的不重画，不双画、不闪烁）。
//   默认只画 4 站 2.5km 内的 gap（站前站后补齐）；setMode('gap-all')
//   可画全六区 gap（204.0km，含各处联络线/专用线/站场）。
//   class=hidden（tunnel=yes / building_passage）永远不画——地下段藏，
//   跟地铁隧道同一个规矩。class=covered 不画（buildRail 已画）。
//
// 几何口径（与 roads.js buildRail 对齐，避免盖错层）：
//   道床 5.0m（站场 yard 也是 5.0m——D16 航拍可读性，见 BED_W_YARD）、
//   双轨 ±0.75m、钢轨半宽 0.12m、轨枕每 20m、接触网杆每 100m（只画
//   非 yard 的命名线）、桥墩每 30m（只画 bridge 段，墩高 = deck - 地面，
//   地面由 deck 规则反推：bridge 段 deck = 地面 + max(7.5, layer*6.9)）。
//   y：道床 deck+0.05、轨枕 deck+0.12、钢轨 deck+0.28（buildRail 同值）。
//   颜色：道床 #1B2340、钢轨 #8B9CC8、轨枕 #141A2E（roads.js PAL 同值）。
//   白膜下不漂白：两个 mesh 都加 __keepColor（roads.js buildRail 的
//   railMesh/neonMesh 现在还没加，见报告接线第 1 条——R 路加两行；
//   本模块自己的 mesh 已加，不依赖那两行）。
// 导出：init(ctx) / setDisplay(mode) / setNight(v) / setMode(mode)。
// 纯函数 visibleRuns 导出，供单测 / V 路核对（不依赖 THREE / window）。
export { visibleRuns };

const RAIL_URLS = ['../data/rail-six-districts-v1.json', './data/rail-six-districts-v1.json'];
const BED_W_LINE = 5.0, BED_W_YARD = 5.0;   // 道床宽：正线 5.0m / 站场 5.0m（D16：站场原 3.0m 在 800m 航拍下约 1px，咽喉 4 股道读不出来；站场线间距中位 6.5m，5.0m 床仍留 1–2m 缝，不糊成板）
const SLEEPER_W_LINE = 2.6, SLEEPER_W_YARD = 2.6;
const RAIL_OFF = 0.75, RAIL_HW = 0.12;      // 双轨偏移 ±0.75m，钢轨半宽 0.12m
const SLEEPER_EVERY = 20, MAST_EVERY = 100, PIER_EVERY = 30;
const BED_C = '#1B2340', STEEL_C = '#8B9CC8', SLEEPER_C = '#141A2E'; // roads.js PAL 同值
const STATION_R = 2500; // 默认只画 4 站 2.5km 内的 gap

let _ctx = null, _THREE = null, _group = null, _railMat = null;
let _mode = 'gap-stations', _display = 'white', _night = 0, _started = false;
let _data = null, _dataReady = null, _dataResolve = null;
const _stats = { runs: 0, gapKm: 0, segs: 0, masts: 0, piers: 0, stations: {} };
function log(...a) { console.log('[rail]', ...a); }

// ---------- 纯函数（不依赖 THREE，可单测） ----------
// 默认 gap-stations：class=gap 且 station 非空（4 站 2.5km 内）；
// gap-all：全部 class=gap。hidden / covered 永远不进画集。
function visibleRuns(runs, mode) {
  const list = [];
  for (const r of runs || []) {
    if (r.class !== 'gap') continue;
    if (mode === 'gap-all') { list.push(r); continue; }
    if (r.station) list.push(r);
  }
  return list;
}

// ---------- 小几何 builder（非索引 + 平面法线 + 顶点色，合并成 1 个 mesh） ----------
// 与 roads.js makeBuilder 同构（独立实现，不 import roads.js，免得 R 路改动牵连）。
function makeBuilder(THREE) {
  const pos = [], nor = [], col = [];
  const tmpC = new THREE.Color();
  function rgb(hex) { tmpC.set(hex); return [tmpC.r, tmpC.g, tmpC.b]; }
  function pushTri(a, b, c, color) {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (let i = 0; i < 3; i++) { nor.push(nx, ny, nz); col.push(color[0], color[1], color[2]); }
  }
  function quad(a, b, c, d, color) { pushTri(a, b, c, color); pushTri(a, c, d, color); }
  function beam(a, b, r, color) { // 方杆：沿 a→b，截面 2r×2r（接触网杆用）
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    let px = -dz / l, pz = dx / l; // 水平法向
    if (Math.hypot(px, pz) < 1e-6) { px = 1; pz = 0; }
    const o1 = [px * r, 0, pz * r], o2 = [0, r, 0];
    const c = (s, s1, s2) => [s[0] + s1 * o1[0] + s2 * o2[0], s[1] + s1 * o1[1] + s2 * o2[1], s[2] + s1 * o1[2] + s2 * o2[2]];
    const A = [c(a, 1, 1), c(a, 1, -1), c(a, -1, -1), c(a, -1, 1)];
    const B = [c(b, 1, 1), c(b, 1, -1), c(b, -1, -1), c(b, -1, 1)];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      quad(A[i], B[i], B[j], A[j], color);
    }
  }
  function box(cx, cy, cz, w, h, d, ry, color) { // 水平旋转盒（桥墩用）
    const c = Math.cos(ry), s = Math.sin(ry), hw = w / 2, hd = d / 2, hh = h / 2;
    const corner = (sx, sz, sy) => [
      cx + (sx * hw * c + sz * hd * s), cy + sy * hh, cz + (-sx * hw * s + sz * hd * c)];
    const t = [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)];
    const b = [corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1)];
    quad(t[0], t[1], t[2], t[3], color);
    quad(b[3], b[2], b[1], b[0], color);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      quad(t[i], t[j], b[j], b[i], color);
    }
  }
  function buildGeometry() {
    const g = new _THREE.BufferGeometry();
    g.setAttribute('position', new _THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new _THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new _THREE.Float32BufferAttribute(col, 3));
    return g;
  }
  return { rgb, quad, beam, box, buildGeometry };
}

function routeInfo(pts) { // pts: [x, z, deck]；返回累计长 + 采样用表
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { pts, cum, total: cum[cum.length - 1] };
}
function sampleRoute(info, d) {
  const { pts, cum } = info;
  if (d <= 0) return { x: pts[0][0], y: pts[0][2], z: pts[0][1], fx: 0, fz: 1 };
  if (d >= info.total) {
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return { x: b[0], y: b[2], z: b[1], fx: (b[0] - a[0]) / l, fz: (b[1] - a[1]) / l };
  }
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const a = pts[i - 1], b = pts[i];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const t = (d - cum[i - 1]) / l;
  return {
    x: a[0] + (b[0] - a[0]) * t, y: a[2] + (b[2] - a[2]) * t, z: a[1] + (b[1] - a[1]) * t,
    fx: (b[0] - a[0]) / l, fz: (b[1] - a[1]) / l,
  };
}

function buildRuns(THREE, group, runs) {
  const bed = makeBuilder(THREE);
  const bedC = bed.rgb(BED_C), railC = bed.rgb(STEEL_C), slC = bed.rgb(SLEEPER_C);
  let gapKm = 0, segs = 0, masts = 0, piers = 0;
  const perStation = {};
  for (const r of runs) {
    const pts = r.pts; // [x, z, deck]
    if (!pts || pts.length < 2) continue;
    const bedW = r.yard ? BED_W_YARD : BED_W_LINE;
    const slW = r.yard ? SLEEPER_W_YARD : SLEEPER_W_LINE;
    const info = routeInfo(pts);
    gapKm += info.total / 1000;
    if (r.station) perStation[r.station] = (perStation[r.station] || 0) + info.total / 1000;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      const px = -dz / l, pz = dx / l;
      const y0 = a[2] + 0.05, y1 = b[2] + 0.05; // 道床面
      const hw = bedW / 2;
      bed.quad([a[0] + px * hw, y0, a[1] + pz * hw], [b[0] + px * hw, y1, b[1] + pz * hw],
        [b[0] - px * hw, y1, b[1] - pz * hw], [a[0] - px * hw, y0, a[1] - pz * hw], bedC);
      for (const side of [-1, 1]) { // 双轨 ±0.75m，轨面 +0.28
        const off = side * RAIL_OFF, rw = RAIL_HW;
        const ry0 = a[2] + 0.28, ry1 = b[2] + 0.28;
        bed.quad([a[0] + px * (off - rw), ry0, a[1] + pz * (off - rw)],
          [b[0] + px * (off - rw), ry1, b[1] + pz * (off - rw)],
          [b[0] + px * (off + rw), ry1, b[1] + pz * (off + rw)],
          [a[0] + px * (off + rw), ry0, a[1] + pz * (off + rw)], railC);
      }
      segs++;
      const n = Math.floor(l / SLEEPER_EVERY); // 轨枕每 20m
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / Math.max(n, 1);
        const cx = a[0] + dx * t, cz = a[1] + dz * t, cy = a[2] + (b[2] - a[2]) * t + 0.12;
        const hx = dx / l * 0.35, hz = dz / l * 0.35;
        const wx = px * slW / 2, wz = pz * slW / 2;
        bed.quad([cx - hx - wx, cy, cz - hz - wz], [cx + hx - wx, cy, cz + hz - wz],
          [cx + hx + wx, cy, cz + hz + wz], [cx - hx + wx, cy, cz - hz + wz], slC);
      }
    }
    if (!r.yard) { // 接触网杆：命名线每 100m 一根，侧向 +2.4m，杆高 6m + 横臂
      for (let d = 0; d < info.total; d += MAST_EVERY) {
        const s = sampleRoute(info, d);
        const mx = s.x - s.fz * 2.4, mz = s.z + s.fx * 2.4;
        bed.beam([mx, s.y, mz], [mx, s.y + 6, mz], 0.09, railC);
        bed.beam([mx, s.y + 5.6, mz], [s.x - s.fz * 0.6, s.y + 5.6, s.z + s.fx * 0.6], 0.07, railC);
        masts++;
      }
    }
    if (r.bridge === 'yes' || r.bridge === 'viaduct') { // 高架桥墩：每 30m，地面 → 桥面底
      let L = 1; try { L = parseInt(r.layer, 10) || 1; } catch (e) { /* 默认 1 层 */ }
      const h = Math.max(7.5, L >= 2 ? L * 6.9 : 7.5); // 墩高 = deck - 地面（数据层同规则）
      if (h > 2) {
        for (let d = PIER_EVERY / 2; d < info.total; d += PIER_EVERY) {
          const s = sampleRoute(info, d);
          bed.box(s.x, s.y - h / 2, s.z, 1.4, h, 1.4, Math.atan2(s.fx, s.fz), bedC);
          piers++;
        }
      }
    }
  }
  _railMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.1 });
  const mesh = new THREE.Mesh(bed.buildGeometry(), _railMat);
  mesh.matrixAutoUpdate = false; mesh.updateMatrix();
  mesh.userData.__keepColor = true; // 白膜下不漂白：铁轨是路网骨架（roads.js 同款豁免）
  group.add(mesh);
  _stats.runs = runs.length;
  _stats.gapKm = +gapKm.toFixed(2);
  _stats.segs = segs; _stats.masts = masts; _stats.piers = piers;
  _stats.stations = Object.fromEntries(Object.entries(perStation).map(([k, v]) => [k, +v.toFixed(2)]));
  setNight(_night);
}

async function loadData() {
  for (const url of RAIL_URLS) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const json = await r.json();
      if (!json || !json.runs) continue;
      return json;
    } catch (e) { /* 下一个候选 */ }
  }
  return null;
}

function rebuild() {
  if (!_group || !_data) return;
  while (_group.children.length) {
    const c = _group.children.pop();
    if (c.geometry) c.geometry.dispose();
  }
  const runs = visibleRuns(_data.runs, _mode);
  buildRuns(_THREE, _group, runs);
  log('built mode=' + _mode, JSON.stringify(_stats));
}

// ---------- init / setDisplay / setNight / setMode ----------
export async function init(ctx) {
  if (_started) return window.__rail;
  _started = true;
  _ctx = ctx; _THREE = ctx.THREE;
  const THREE = ctx.THREE, scene = ctx.scene;
  if (!scene || !THREE) throw new Error('[rail] ctx.scene / ctx.THREE 缺失');
  _dataReady = new Promise((res) => { _dataResolve = res; });
  _group = new THREE.Group();
  _group.name = 'rail-gap';
  scene.add(_group);
  _data = await loadData();
  if (!_data) {
    console.warn('[rail] rail-six-districts-v1.json 加载失败，补线缺失');
    if (_dataResolve) _dataResolve(false);
    return { ok: false, stopped: 'no-rail-data' };
  }
  rebuild();
  const api = {
    group: _group, stats: _stats, dataReady: _dataReady,
    setDisplay, setNight, setMode,
  };
  window.__rail = api;
  if (_dataResolve) _dataResolve(true);
  return api;
}

export function setDisplay(mode) {
  _display = mode || 'normal';
  // 白膜 / 正常都不漂白（mesh 自带 __keepColor）；只有热力图藏起本组（热力只看楼高）。
  if (_group) _group.visible = (_display !== 'heat');
  if (_display !== 'white') setNight(_night);
  log('display ->', _display, _group ? ('group.visible=' + _group.visible) : '');
}

export function setNight(v) {
  _night = v || 0;
  if (_railMat) { _railMat.emissive.set(BED_C); _railMat.emissiveIntensity = 0.25 * _night; }
}

export function setMode(mode) {
  if (mode !== 'gap-stations' && mode !== 'gap-all') return false;
  _mode = mode;
  rebuild();
  return true;
}
