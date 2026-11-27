// traffic.js — 星泽市 · 1000 辆 AI 交通车（游戏层动态交通，不是白模几何）
// 任务（2026-11-27 01:56–01:58 老大定，方案 §14）：1000 辆 AI 交通车（含公交车），
// GLB 模型，流式加载，保证 60fps。车不要烤进块 GLB 里。
//
// 做法：
//   模型 — Kenney Car Kit 3.1（CC0，app/assets/cars/ 已有 15 个 GLB）+ 程序化顶点色
//     公交 bus.glb（9.5m，road-step1-bus-gen 生成，长玻璃带 + 车门）。每辆模型在加载时
//     把全部 mesh 合并成 1 个几何 → 1 个 InstancedMesh → 全城最多 16 个 draw call。
//     Kenney GLB 贴图是外链 Textures/colormap.png（已从 Kenney 官方 zip 拷进
//     app/assets/cars/Textures/colormap.png，CC0，12,371 字节；没它车是白的）。
//     Kenney 车约 3.2m 长、1.5m 宽（比真车小一圈），按目标尺寸非均匀缩放到真车尺寸
//     （轿车 4.6m、SUV 4.5m、货车 5.0m、公交 9.5m）；车头一律 +Z（前轮在 +Z 端，
//     公交前脸琥珀灯在 +Z、尾部红灯在 -Z，已验 GLB 顶点色确认）。
//     无车标、无车牌：Kenney 贴图是纯色板、无文字；公交是顶点色、无文字（已验）。
//   颜色 — 同型号靠 instanceColor  tint（8 色盘）区分；落位后做一次 80m 去重 pass，
//     远场回收时再重 roll：同屏 80m 内不出现两辆（型号 + 颜色）相同的车。
//   路网 — 只读 window.__roads.data.arterials（3,700 段，2,019.7km），不动 roads.js。
//     端点 4m 量化 + 3m 内并点建成图；车到段尾按“最直”选下一段（单向段只许顺向进），
//     死胡同掉头（lat 换侧，平滑变道）；靠右：lat 恒向行驶方向右侧 width/4（与 roads.js
//     updateCars 同一套规则：lat=+w/4，右向量由行驶方向导出，掉头时 lat 取反再滑回去）。
//   流式 — 每 150ms 按相机焦点选 400m 内、最近最多 160 辆写实例矩阵；其余只算位置
//     不渲染。160 辆 × 单车约 600 三角 ≈ 10 万三角，draw call 恒为 ≤16，与 1000 辆总数无关。
//   密度 — 1000 辆撒在 2,019km 路上是 2km 一辆，街面永远看不见“大量车”，所以：
//     ① 初始 70% 落在市中心 1,600m 内的主干道、30% 落全城主干道；② 远场回收：每 2s
//     把焦点 1,200m 外的车按批搬回焦点附近主干道上离焦点最近的点（±100m 抖动，
//     落点在焦点 400m 内才看得见；玩家看不见的地方换位，不闪；近处的车永不传送）。
//     玩家走到哪，哪的路就车多；总数恒为 1000。
//   白膜 — 默认白膜下换陶土材质（与 roads.js _whitewash 同色 0xe9e7e0）；切回正常恢复
//     贴图/顶点色。夜里 setNight 只记值：GLB 单 mesh 车没有独立车灯层，车灯是后续项。
//   兜底 — 单个 GLB 加载失败时用程序化盒式车顶替（顶点色），交通不断；roads 数据
//     20s 内没到则 init 返回 { ok:false, stopped:'no-roads-data' }，不炸页面。
// 接线（总协调加，不动本文件）：见文件末尾 WIRING 注释。
// 导出：init(ctx) / setDisplay(mode) / setNight(v) / setRain(on) + 纯函数（供节点测试）。
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------- 常量 ----------
export const TOTAL_CARS = 1000;
export const BUS_SHARE = 0.10;            // 100 辆公交
const RENDER_R = 400;                     // 流式渲染半径（m）
const RECYCLE_R = 1200;                   // 超出此半径的车可被回收
const MAX_VISIBLE = 160;                  // 同时渲染上限（辆）
const SELECT_EVERY = 0.15;                // 选车节流（s）
const RECYCLE_EVERY = 2.0;                // 回收节流（s）
const RECYCLE_BATCH = 40;                 // 每轮最多回收辆数
const PLACE_GAP = 45;                     // 同向同段落车最小间距（m）
const DEDUP_R = 80;                       // 同（型号+颜色）去重半径（m）
const CLAY = 0xe9e7e0;                    // 白膜陶土色（与 roads.js _CLAY 一致）

// 型号表：file（app/assets/cars/ 下）、目标尺寸（m，真车）、权重（%）、速度（m/s）
// Kenney 实测包围盒约长 3.2m / 宽 1.5m / 高 1.0–1.6m，加载时缩放到目标尺寸。
export const MODELS = [
  { file: 'sedan.glb',           model: 'sedan',     L: 4.6, W: 1.86, H: 1.45, w: 14, v: [9, 14],  kind: 'car' },
  { file: 'suv.glb',             model: 'suv',       L: 4.5, W: 1.92, H: 1.70, w: 12, v: [9, 13],  kind: 'car' },
  { file: 'hatchback-sports.glb',model: 'hatch',     L: 3.9, W: 1.80, H: 1.40, w: 8,  v: [9, 14],  kind: 'car' },
  { file: 'taxi.glb',            model: 'taxi',      L: 4.6, W: 1.86, H: 1.50, w: 8,  v: [9, 14],  kind: 'car' },
  { file: 'sedan-sports.glb',    model: 'sports',    L: 4.3, W: 2.00, H: 1.35, w: 7,  v: [10, 15], kind: 'car' },
  { file: 'suv-luxury.glb',      model: 'suv-lux',   L: 4.5, W: 1.92, H: 1.70, w: 6,  v: [9, 13],  kind: 'car' },
  { file: 'van.glb',             model: 'van',       L: 4.8, W: 1.90, H: 1.90, w: 7,  v: [8, 12],  kind: 'car' },
  { file: 'truck.glb',           model: 'truck',     L: 5.0, W: 1.95, H: 1.90, w: 6,  v: [7, 10],  kind: 'heavy' },
  { file: 'delivery.glb',        model: 'delivery',  L: 4.9, W: 1.95, H: 2.20, w: 6,  v: [7, 10],  kind: 'heavy' },
  { file: 'truck-flat.glb',      model: 'truckflat', L: 5.0, W: 1.95, H: 1.80, w: 4,  v: [7, 10],  kind: 'heavy' },
  { file: 'delivery-flat.glb',   model: 'deliveryflat', L: 4.9, W: 1.95, H: 1.80, w: 4, v: [7, 10], kind: 'heavy' },
  { file: 'police.glb',          model: 'police',    L: 4.6, W: 1.90, H: 1.50, w: 2,  v: [10, 14], kind: 'special' },
  { file: 'ambulance.glb',       model: 'ambulance', L: 5.0, W: 1.95, H: 2.40, w: 2,  v: [9, 13],  kind: 'special' },
  { file: 'firetruck.glb',       model: 'firetruck', L: 5.2, W: 2.00, H: 2.40, w: 2,  v: [8, 11],  kind: 'special' },
  { file: 'garbage-truck.glb',   model: 'garbage',   L: 5.5, W: 2.00, H: 2.40, w: 2,  v: [7, 9],   kind: 'heavy' },
  { file: 'bus.glb',             model: 'bus',       L: 9.5, W: 2.50, H: 3.00, w: 10, v: [8, 8],   kind: 'bus' },
];
// 8 色 tint（instanceColor 乘数，近白不抢贴图本色；窗/轮胎在贴图里是深色，乘后仍深）
export const TINTS = [
  '#ffffff', '#dfe3e8', '#cfe0f0', '#f0d2cc',
  '#f0e6c8', '#d2e4d2', '#b9c4d0', '#e8dcc8',
];
const BUS_TINTS = ['#ffffff', '#cfe0f0', '#d2e4d2', '#f0e6c8'];

function seededRand(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const log = (...a) => console.log('[traffic]', ...a);

// ---------- 路线采样（与 roads.js routeInfo/sampleRoute 同口径：pts=[x,z,y]） ----------
export function routeInfo(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { pts, cum, total: cum[cum.length - 1] };
}
export function sampleRoute(info, s) {
  const { pts, cum, total } = info;
  let t = s;
  if (t < 0) t = 0;
  if (t > total) t = total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < t) i++;
  const segLen = Math.max(cum[i] - cum[i - 1], 1e-9);
  const f = (t - cum[i - 1]) / segLen;
  const a = pts[i - 1], b = pts[i];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  return {
    x: a[0] + dx * f, z: a[1] + dz * f, y: a[2] + (b[2] - a[2]) * f,
    fx: dx / l, fz: dz / l,
  };
}

// ---------- 路网图：端点 4m 量化 + 方向感知并点 ----------
// arterials[i] = { pts:[[x,z,y]...], width, grade, ow, name }。返回：
// { segs:[{info,total,width,grade,ow,nodeA,nodeB,midX,midZ}],
//   adj: Map<nodeId, [{seg,end}]> }；end 0=段首接点，1=段尾接点。
// 并点规则：端点中心距 ≤3m 直接并；3–8m 的只在“不是对向平行”时并——
// T 字路口侧路端点落在主路边线外（距主路中线半个路宽，约 5–7m），必须并上，
// 车才能拐进主路；对向车道（双向路的两条单向带）在路口两端相距 8m 左右、
// 朝向反平行（点积 ≈ -1），绝不能并，否则车会在路口跳对向车道。
export function buildRoadGraph(arterials) {
  const keyOf = (x, z) => `${Math.round(x / 4)},${Math.round(z / 4)}`;
  const keys = new Map(); // key -> {x, z}
  const segEnds = [];
  for (const a of arterials) {
    const p0 = a.pts[0], p1 = a.pts[a.pts.length - 1];
    const k0 = keyOf(p0[0], p0[1]), k1 = keyOf(p1[0], p1[1]);
    if (!keys.has(k0)) keys.set(k0, { x: p0[0], z: p0[1] });
    if (!keys.has(k1)) keys.set(k1, { x: p1[0], z: p1[1] });
    segEnds.push([k0, k1]);
  }
  // 每个端点 key 上各段“离开该点”的行驶方向（用于并点时的方向判断）
  const keyDirs = new Map(); // key -> [{hx, hz}]
  arterials.forEach((a, i) => {
    const pts = a.pts, n = pts.length;
    const push = (k, hx, hz) => {
      if (!keyDirs.has(k)) keyDirs.set(k, []);
      keyDirs.get(k).push({ hx, hz });
    };
    let dx = pts[1][0] - pts[0][0], dz = pts[1][1] - pts[0][1];
    let l = Math.hypot(dx, dz) || 1;
    push(segEnds[i][0], dx / l, dz / l);
    dx = pts[n - 2][0] - pts[n - 1][0]; dz = pts[n - 2][1] - pts[n - 1][1];
    l = Math.hypot(dx, dz) || 1;
    push(segEnds[i][1], dx / l, dz / l);
  });
  // 并查集：12m 格邻域内、中心距 ≤12m 的端点，方向不过于反平行就并成一个节点
  const keyList = [...keys.keys()];
  const parent = new Map(keyList.map((k) => [k, k]));
  const find = (k) => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    let n = k;
    while (parent.get(n) !== r) { const nx = parent.get(n); parent.set(n, r); n = nx; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const canMerge = (k1, k2) => {
    const c1 = keys.get(k1), c2 = keys.get(k2);
    const d = Math.hypot(c1.x - c2.x, c1.z - c2.z);
    if (d <= 3.0) return true;
    if (d > 12.0) return false;
    // 3–12m：存在一对方向点积 > -0.3（同向续接或拐弯）才并；全反平行（对向车道）不并
    for (const a of keyDirs.get(k1) || []) {
      for (const b of keyDirs.get(k2) || []) {
        if (a.hx * b.hx + a.hz * b.hz > -0.3) return true;
      }
    }
    return false;
  };
  const cell = new Map();
  for (const k of keyList) {
    const c = keys.get(k);
    const ck = `${Math.floor(c.x / 12)},${Math.floor(c.z / 12)}`;
    if (!cell.has(ck)) cell.set(ck, []);
    cell.get(ck).push(k);
  }
  for (const k of keyList) {
    const c = keys.get(k);
    const cx = Math.floor(c.x / 12), cz = Math.floor(c.z / 12);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const nb = cell.get(`${cx + dx},${cz + dz}`) || [];
      for (const k2 of nb) {
        if (k2 <= k) continue;
        if (canMerge(k, k2)) union(k, k2);
      }
    }
  }
  const nodeId = new Map();
  const nodeOf = (k) => {
    const r = find(k);
    if (!nodeId.has(r)) nodeId.set(r, nodeId.size);
    return nodeId.get(r);
  };
  const segs = [];
  const adj = new Map();
  const addAdj = (n, seg, end) => {
    if (!adj.has(n)) adj.set(n, []);
    adj.get(n).push({ seg, end });
  };
  arterials.forEach((a, i) => {
    const info = routeInfo(a.pts);
    const nA = nodeOf(segEnds[i][0]), nB = nodeOf(segEnds[i][1]);
    const mid = sampleRoute(info, info.total / 2);
    segs.push({
      info, total: info.total, width: a.width || 7, grade: a.grade ?? 1,
      ow: a.ow === 1 ? 1 : 0, name: a.name || '', nodeA: nA, nodeB: nB,
      midX: mid.x, midZ: mid.z, owInferred: 0,
    });
    addAdj(nA, i, 0);
    addAdj(nB, i, 1);
  });
  // 缺口定向：主干道上短的双向段（<250m），若两头都是同名 OSM 单向段顺链通过
  // （一头进、一头出、朝向对得上），它是单向路中间没打 oneway 标签的缺口——按链向
  // 定为单向（owInferred=1，推算标推算；朝向反了就把 pts 掉头再定）。否则车会在缺口里
  // 逆行撞上死胡同再掉头（环星大道那种 60–125m 缺口夹在 1km 单向段中间就是这么来的）。
  // 跑 3 轮，让连续缺口互相借上下文。
  let gapOriented = 0;
  const owInAt = (node, name) => (adj.get(node) || []).filter(
    (c) => segs[c.seg].ow === 1 && segs[c.seg].name === name && c.end === 1);
  const owOutAt = (node, name) => (adj.get(node) || []).filter(
    (c) => segs[c.seg].ow === 1 && segs[c.seg].name === name && c.end === 0);
  for (let pass = 0; pass < 3; pass++) {
    let changed = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.ow === 1 || seg.total >= 250 || !seg.name) continue;
      // 正向：单向段进 nodeA、单向段出 nodeB，朝向与本段 pts 顺向对得上
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
      const fwd = owInAt(seg.nodeA, seg.name).length > 0 && owOutAt(seg.nodeB, seg.name).length > 0
        && dot(exitHeading(segs[owInAt(seg.nodeA, seg.name)[0].seg], 1), entryHeading(seg, 0)) > 0.5
        && dot(exitHeading(seg, 1), entryHeading(segs[owOutAt(seg.nodeB, seg.name)[0].seg], 0)) > 0.5;
      // 反向：单向段进 nodeB、单向段出 nodeA（本段 pts 存反了）
      const rev = !fwd && owInAt(seg.nodeB, seg.name).length > 0 && owOutAt(seg.nodeA, seg.name).length > 0
        && dot(exitHeading(segs[owInAt(seg.nodeB, seg.name)[0].seg], 1), entryHeading(seg, 1)) > 0.5
        && dot(exitHeading(seg, -1), entryHeading(segs[owOutAt(seg.nodeA, seg.name)[0].seg], 0)) > 0.5;
      if (!fwd && !rev) continue;
      if (rev) {
        // pts 掉头：info 重算，nodeA/nodeB 对调，adj 里本段的 end 标志取反
        seg.info = routeInfo([...seg.info.pts].reverse());
        const tmp = seg.nodeA; seg.nodeA = seg.nodeB; seg.nodeB = tmp;
        for (const n of [seg.nodeA, seg.nodeB]) {
          for (const c of adj.get(n) || []) if (c.seg === i) c.end = 1 - c.end;
        }
      }
      seg.ow = 1;
      seg.owInferred = 1;
      gapOriented++;
      changed++;
    }
    if (!changed) break;
  }
  return { segs, adj, nodeCount: nodeId.size, gapOriented };
}

// 驶出方向（单位向量）：dir>0 从段尾出，dir<0 从段首出
function exitHeading(seg, dir) {
  const pts = seg.info.pts, n = pts.length;
  let dx, dz;
  if (dir > 0) { dx = pts[n - 1][0] - pts[n - 2][0]; dz = pts[n - 1][1] - pts[n - 2][1]; }
  else { dx = pts[0][0] - pts[1][0]; dz = pts[0][1] - pts[1][1]; }
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}
// 从某端进入候选段时的行驶方向：end 0=段首进（顺 pts），1=段尾进（逆 pts）
function entryHeading(seg, end) {
  const pts = seg.info.pts, n = pts.length;
  let dx, dz;
  if (end === 0) { dx = pts[1][0] - pts[0][0]; dz = pts[1][1] - pts[0][1]; }
  else { dx = pts[n - 2][0] - pts[n - 1][0]; dz = pts[n - 2][1] - pts[n - 1][1]; }
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}
// 从某段末端出发的可选下一段（单向段只许顺向进；不含本段）。
// 返回 [{seg, dir, score}]，score = 出弯朝向与进弯朝向的点积（越直越大）。
function exitsAt(graph, segIdx, dir) {
  const seg = graph.segs[segIdx];
  const node = dir > 0 ? seg.nodeB : seg.nodeA;
  const [ex, ez] = exitHeading(seg, dir);
  const out = [];
  for (const cand of graph.adj.get(node) || []) {
    if (cand.seg === segIdx) continue;
    const cs = graph.segs[cand.seg];
    const entryDir = cand.end === 0 ? 1 : -1;
    if (cs.ow === 1 && entryDir < 0) continue; // 单向段不许逆行进入
    const [hx, hz] = entryHeading(cs, cand.end);
    out.push({ seg: cand.seg, dir: entryDir, score: ex * hx + ez * hz });
  }
  return out;
}
// 该段沿 dir 走到头有没有出路（不含掉头）
export function hasExit(graph, segIdx, dir) {
  return exitsAt(graph, segIdx, dir).length > 0;
}
// 活路：走到头之后还有路走。DFS 看穿单向链：任一分支通到双向段（能掉头）、
// 绕回已走过的段（成环就是通路）、或深入 6 段仍没断头，都算活路；
// 只有所有分支都在 6 段内撞上死胡同，才是单向陷阱。
export function hasLiveExit(graph, segIdx, dir, depth = 0, seen = null) {
  const seenSet = seen || new Set();
  const key = `${segIdx}:${dir}`;
  if (seenSet.has(key)) return true; // 成环 → 通路
  if (depth >= 6) return true; // 深入 6 段没断头 → 通路
  seenSet.add(key);
  for (const c of exitsAt(graph, segIdx, dir)) {
    const cs = graph.segs[c.seg];
    if (cs.ow !== 1) { seenSet.delete(key); return true; } // 双向段 → 能掉头
    if (hasLiveExit(graph, c.seg, c.dir, depth + 1, seenSet)) { seenSet.delete(key); return true; }
  }
  seenSet.delete(key);
  return false;
}
// 到段尾选下一段：最直的优先；单向段只许从段首进；没有可选段返回 null（掉头）。
// 单向陷阱过滤：不进“走到底是死胡同（链）”的单向段（进去就只能冻住等回收），
// 除非没有别的路；双向段死胡同没关系（可以掉头）。
export function pickNext(graph, segIdx, dir) {
  const cands = exitsAt(graph, segIdx, dir);
  if (!cands.length) return null;
  const live = cands.filter((c) => {
    const cs = graph.segs[c.seg];
    return cs.ow !== 1 || hasLiveExit(graph, c.seg, c.dir);
  });
  if (!live.length) {
    // 全是单向陷阱：双向段宁可掉头也不进陷阱；单向段已无路可退，只能进最直的陷阱
    if (graph.segs[segIdx].ow !== 1) return null;
  }
  const pool = live.length ? live : cands;
  let best = null, bestScore = -2;
  for (const c of pool) {
    if (c.score < -0.7) continue; // 不直接折返（除非无路可走，见下）
    if (c.score > bestScore) { bestScore = c.score; best = { seg: c.seg, dir: c.dir }; }
  }
  if (best) return best;
  // 退路：允许折返进最直的段（不断头路口）；仍没有则 null → 掉头
  for (const c of pool) {
    if (c.score > bestScore) { bestScore = c.score; best = { seg: c.seg, dir: c.dir }; }
  }
  return best;
}

// ---------- 车队编成：1000 辆，公交恰 10%，型号按权重 ----------
// 返回 [{modelIdx, tintIdx}]，顺序即落位顺序（公交均匀散开）。
export function assignFleet(total, rand) {
  const busIdx = MODELS.findIndex((m) => m.model === 'bus');
  const nonBus = MODELS.map((m, i) => ({ i, w: m.model === 'bus' ? 0 : m.w }));
  const wSum = nonBus.reduce((s, e) => s + e.w, 0);
  const fleet = [];
  for (let n = 0; n < total; n++) {
    let modelIdx;
    if ((n + 1) % 10 === 0) modelIdx = busIdx; // 每 10 辆 1 辆公交
    else {
      let r = rand() * wSum;
      modelIdx = nonBus[0].i;
      for (const e of nonBus) { r -= e.w; if (r <= 0) { modelIdx = e.i; break; } }
    }
    const tints = MODELS[modelIdx].model === 'bus' ? BUS_TINTS : TINTS;
    const tintIdx = (n * 3 + modelIdx * 5) % tints.length;
    fleet.push({ modelIdx, tintIdx });
  }
  return fleet;
}

// ---------- 落位：主干道上按 45m 间距摆，70% 市中心、30% 全城 ----------
// graph.segs 须有 midX/midZ/total/width/grade。返回 cars[]（x/z/y/heading 已算好）。
export function placeCars(graph, fleet, rand) {
  const eligible = (s) => s.grade === 0 && s.width >= 7 && s.total >= 60;
  const midDist2 = (s) => s.midX * s.midX + s.midZ * s.midZ;
  const poolA = [], poolB = [];
  graph.segs.forEach((s, i) => {
    if (!eligible(s)) return;
    (midDist2(s) <= 1600 * 1600 ? poolA : poolB).push(i);
  });
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  shuffle(poolA); shuffle(poolB);
  const cars = [];
  const placeOn = (segIdx, want) => {
    const seg = graph.segs[segIdx];
    const dirs = seg.ow === 1 ? [1] : [1, -1]; // 单向段只许顺向落位
    if (seg.ow === 1 && !hasLiveExit(graph, segIdx, 1)) return; // 单向陷阱段不落位（走到底是死胡同链）
    for (const dir of dirs) {
      if (cars.length >= want) return;
      const cap = Math.max(1, Math.floor((seg.total - 30) / PLACE_GAP));
      for (let k = 0; k < cap && cars.length < want; k++) {
        const f = fleet[cars.length];
        const def = MODELS[f.modelIdx];
        const s = Math.min(seg.total - 10, 15 + k * PLACE_GAP + rand() * 15);
        const speed = def.v[0] + rand() * (def.v[1] - def.v[0]);
        cars.push(mkCar(segIdx, s, dir, def, f, speed, seg));
      }
    }
  };
  const mkCar = (segIdx, s, dir, def, f, speed, seg) => {
    const car = {
      seg: segIdx, s, dir, lat: seg.width / 4, width: seg.width, total: seg.total,
      speed, modelIdx: f.modelIdx, tintIdx: f.tintIdx,
      model: def.model, x: 0, z: 0, y: 0, heading: 0, visible: false, dist2: Infinity,
    };
    positionCar(graph, car);
    return car;
  };
  const targetA = Math.round(fleet.length * 0.7);
  for (const si of poolA) { if (cars.length >= targetA) break; placeOn(si, targetA); }
  for (const si of poolB) { if (cars.length >= fleet.length) break; placeOn(si, fleet.length); }
  // 兜底：主干道没摆满（不应发生）→ 任意宽 ≥7 的段
  if (cars.length < fleet.length) {
    const rest = [];
    graph.segs.forEach((s, i) => { if (s.width >= 7 && s.total >= 60) rest.push(i); });
    shuffle(rest);
    for (const si of rest) { if (cars.length >= fleet.length) break; placeOn(si, fleet.length); }
  }
  dedupTints(cars);
  return cars;
}

// 去重 pass：80m 内同（型号+颜色）换 tint（最多 4 次）
export function dedupTints(cars) {
  const cell = new Map();
  const ck = (x, z) => `${Math.floor(x / DEDUP_R)},${Math.floor(z / DEDUP_R)}`;
  for (const c of cars) {
    const k = ck(c.x, c.z);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(c);
  }
  const clash = (c) => {
    const cx = Math.floor(c.x / DEDUP_R), cz = Math.floor(c.z / DEDUP_R);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const o of cell.get(`${cx + dx},${cz + dz}`) || []) {
        if (o === c) continue;
        if (o.modelIdx === c.modelIdx && o.tintIdx === c.tintIdx) {
          const d2 = (o.x - c.x) ** 2 + (o.z - c.z) ** 2;
          if (d2 < DEDUP_R * DEDUP_R) return true;
        }
      }
    }
    return false;
  };
  for (const c of cars) {
    const tints = MODELS[c.modelIdx].model === 'bus' ? BUS_TINTS : TINTS;
    let tries = 0;
    while (clash(c) && tries++ < 4) c.tintIdx = (c.tintIdx + 1) % tints.length;
  }
}

// 单辆车按当前 seg/s/dir/lat 算出 x/z/y/heading（与 roads.js updateCars 同规则）
export function positionCar(graph, car) {
  const seg = graph.segs[car.seg];
  const p = sampleRoute(seg.info, car.s);
  const fx = p.fx * car.dir, fz = p.fz * car.dir;
  const rx = -fz, rz = fx; // 右侧
  car.x = p.x + rx * car.lat;
  car.z = p.z + rz * car.lat;
  car.y = p.y + 0.02;
  car.heading = Math.atan2(fx, fz);
}

// ---------- 流式选车：焦点 R 内最近 MAX_VISIBLE 辆 ----------
// 返回 visible[]（按距离升序）；同时写 car.visible / car.dist2。
// 贪心去重：已选的车里 80m 内有同（型号+颜色）就跳过这辆（它继续跑，下次再选），
// 同屏 80m 内绝不出现两辆一样的车。
export function selectVisible(cars, fx, fz, R = RENDER_R, maxN = MAX_VISIBLE) {
  const R2 = R * R;
  const near = [];
  for (const c of cars) {
    const dx = c.x - fx, dz = c.z - fz;
    const d2 = dx * dx + dz * dz;
    c.dist2 = d2;
    c.visible = false;
    if (d2 < R2) near.push(c);
  }
  near.sort((a, b) => a.dist2 - b.dist2);
  const visible = [];
  const D2 = DEDUP_R * DEDUP_R;
  for (const c of near) {
    if (visible.length >= maxN) break;
    let clash = false;
    for (const o of visible) {
      if (o.modelIdx === c.modelIdx && o.tintIdx === c.tintIdx) {
        const d2 = (o.x - c.x) ** 2 + (o.z - c.z) ** 2;
        if (d2 < D2) { clash = true; break; }
      }
    }
    if (!clash) visible.push(c);
  }
  for (const c of visible) c.visible = true;
  return visible;
}

// ---------- 程序化兜底车（GLB 加载失败时）：盒式车身 + 座舱 + 4 轮，顶点色 ----------
function fallbackCarGeometry(THREE, def) {
  const geos = [];
  const paint = (geo, hex) => {
    const c = new THREE.Color(hex);
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
  };
  const box = (w, h, d, x, y, z, hex) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.applyMatrix4(new THREE.Matrix4().makeTranslation(x, y, z));
    return paint(g, hex);
  };
  const L = def.L, W = def.W;
  geos.push(box(W, 0.6, L, 0, 0.6, 0, 0x8a94a6));                       // 车身
  geos.push(box(W - 0.3, 0.55, L * 0.45, 0, 1.15, -L * 0.05, 0x1a2432)); // 座舱玻璃
  for (const sx of [-1, 1]) for (const sz of [L / 2 - 0.8, -L / 2 + 0.8]) {
    geos.push(box(0.25, 0.7, 0.7, sx * (W / 2 - 0.05), 0.35, sz, 0x14171c)); // 轮
  }
  if (def.model === 'bus') {
    geos.push(box(W + 0.02, 0.7, L - 1.2, 0, 1.95, 0, 0x16202e)); // 玻璃带
  }
  const g = mergeGeometries(geos.map((x) => (x.index ? x.toNonIndexed() : x)));
  g.computeBoundingSphere();
  return g;
}

// ---------- 模块状态 ----------
let api = null;
let _THREE = null, _scene = null, _ctx = null;
let _group = null, _graph = null, _cars = [], _carsByModel = [];
let _modelStates = []; // [{def, mesh, origMat, capacity, tris}]
let _clayMat = null;
let _display = 'normal', _night = 0, _rain = false;
let _raf = 0, _lastT = 0, _selectAcc = 1, _recycleAcc = 0;
let _started = false;
let _stats = {
  total: 0, visible: 0, buses: 0, busVisible: 0, modelsLoaded: 0,
  fallbackModels: [], drawCalls: 0, renderedTris: 0,
  lastUpdateMs: 0, lastSelectMs: 0, recycles: 0, initMs: 0,
};

export function setDisplay(mode) { if (api) api.setDisplay(mode); }
export function setNight(v) { if (api) api.setNight(v); }
export function setRain(on) { if (api) api.setRain(on); }

export async function init(ctx) {
  if (api) return api;
  if (_started) return api;
  _started = true;
  const t0 = performance.now();
  _ctx = ctx;
  _THREE = ctx.THREE;
  _scene = ctx.scene;
  if (!_THREE || !_scene) throw new Error('[traffic] ctx.THREE / ctx.scene 缺失');
  const THREE = _THREE;

  // 等路网数据（roads.js 先接线；init 在 WIRING 里排在 roads 之后）
  let roadsData = null;
  for (let i = 0; i < 80; i++) {
    roadsData = (typeof window !== 'undefined' && window.__roads) ? window.__roads.data : null;
    if (roadsData && roadsData.arterials && roadsData.arterials.length) break;
    await sleep(250);
  }
  if (!roadsData || !roadsData.arterials) {
    log('roads 数据 20s 未到，停住（不炸页面）');
    return { ok: false, stopped: 'no-roads-data' };
  }
  const arterials = roadsData.arterials;
  _graph = buildRoadGraph(arterials);
  const rand = seededRand(20261127);
  const fleet = assignFleet(TOTAL_CARS, rand);
  _cars = placeCars(_graph, fleet, rand);
  _stats.total = _cars.length;
  _stats.buses = _cars.filter((c) => c.model === 'bus').length;
  _stats.gapOriented = _graph.gapOriented || 0;
  log(`路网图：${_graph.segs.length} 段 / ${_graph.nodeCount} 节点 / 缺口定向 ${_stats.gapOriented} 段；落位 ${_cars.length} 辆（含公交 ${_stats.buses}）`);

  // ---------- 加载 GLB：每模型合并成 1 几何 + 1 InstancedMesh ----------
  _group = new THREE.Group();
  _group.name = 'traffic-1000';
  _scene.add(_group);
  _clayMat = new THREE.MeshStandardMaterial({ color: CLAY, roughness: 0.95, metalness: 0 });
  _carsByModel = MODELS.map(() => []);
  for (const c of _cars) _carsByModel[c.modelIdx].push(c);

  const loader = new GLTFLoader();
  const loadOne = async (def, mi) => {
    const url = new URL(`./assets/cars/${def.file}`, import.meta.url).toString();
    try {
      const gltf = await loader.loadAsync(url);
      gltf.scene.updateMatrixWorld(true);
      const geos = [];
      let material = null;
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        if (!material && o.material) material = o.material;
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        g.deleteAttribute('tangent');
        if (g.morphAttributes) g.morphAttributes = {};
        geos.push(g);
      });
      if (!geos.length || !material) throw new Error('empty glb: ' + def.file);
      const allIndexed = geos.every((g) => !!g.index);
      const norm = allIndexed ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g));
      let merged = null;
      try { merged = mergeGeometries(norm, false); } catch (e) { merged = null; }
      if (!merged) throw new Error('merge failed: ' + def.file);
      merged.computeBoundingBox();
      const bb = merged.boundingBox;
      const size = new THREE.Vector3();
      bb.getSize(size);
      const s = new THREE.Matrix4().makeScale(
        def.W / Math.max(size.x, 0.01),
        def.H / Math.max(size.y, 0.01),
        def.L / Math.max(size.z, 0.01));
      merged.applyMatrix4(s);
      merged.computeBoundingSphere();
      const tris = (merged.index ? merged.index.count : merged.attributes.position.count) / 3;
      return { def, mi, geometry: merged, material, tris, fallback: false };
    } catch (e) {
      console.warn('[traffic] GLB 失败，用程序化兜底车：', def.file, e);
      const geometry = fallbackCarGeometry(THREE, def);
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 });
      const tris = geometry.attributes.position.count / 3;
      return { def, mi, geometry, material, tris, fallback: true };
    }
  };
  const built = await Promise.all(MODELS.map((def, mi) => loadOne(def, mi)));
  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  for (const b of built) {
    const capacity = Math.max(1, _carsByModel[b.mi].length);
    const mesh = new THREE.InstancedMesh(b.geometry, b.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // 实例分散全城，整体包围盒不可信，靠流式选车裁剪
    mesh.count = 0;
    mesh.visible = false;
    mesh.userData.model = b.def.model;
    // 初始矩阵写单位阵，避免未写槽位残留脏数据
    dummy.position.set(0, -100, 0);
    dummy.updateMatrix();
    for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    _group.add(mesh);
    _modelStates.push({ def: b.def, mesh, origMat: b.material, capacity, tris: b.tris });
    if (b.fallback) _stats.fallbackModels.push(b.def.file);
  }
  _stats.modelsLoaded = built.length;
  _stats.renderedTris = 0; // 实际渲染三角在 writeInstances 里按可见辆数算
  log(`模型 ${_stats.modelsLoaded}/16 就绪（兜底：${_stats.fallbackModels.join(',') || '无'}），单车三角（16 型合计）${_modelStates.reduce((s, m) => s + m.tris, 0)}`);

  // 初始显示模式（app 默认白膜）
  _display = (ctx.state && ctx.state.display) || 'normal';
  applyDisplay();

  // ---------- 主循环：只更新位置，不抢 app.js 的渲染循环 ----------
  _lastT = performance.now();
  const tick = (t) => {
    _raf = requestAnimationFrame(tick);
    const dt = Math.min(0.05, Math.max(0.001, (t - _lastT) / 1000));
    _lastT = t;
    const u0 = performance.now();
    updateCars(dt);
    _stats.lastUpdateMs = performance.now() - u0;
    _selectAcc += dt;
    if (_selectAcc >= SELECT_EVERY) {
      _selectAcc = 0;
      const s0 = performance.now();
      writeInstances();
      _stats.lastSelectMs = performance.now() - s0;
    }
    _recycleAcc += dt;
    if (_recycleAcc >= RECYCLE_EVERY) {
      _recycleAcc = 0;
      recycleFar();
    }
  };
  _raf = requestAnimationFrame(tick);

  _stats.initMs = Math.round(performance.now() - t0);
  api = {
    group: _group, cars: _cars, graph: _graph, stats: _stats,
    getStats: () => ({
      ..._stats,
      visibleByModel: _modelStates.map((m) => ({ model: m.def.model, shown: m.mesh.count })),
      focus: _lastFocus,
    }),
    setDisplay(mode) {
      _display = mode || 'normal';
      applyDisplay();
      _selectAcc = SELECT_EVERY; // 下一帧立即重写实例色
    },
    setNight(v) { _night = clamp(+v || 0, 0, 1); },
    setRain(on) { _rain = !!on; },
  };
  try { window.__traffic = api; } catch (e) { /* non-browser */ }
  log(`init 完成 ${_stats.initMs}ms：${_stats.total} 辆 / ${_stats.buses} 公交 / ${_modelStates.length} 模型`);
  return api;
}

// ---------- 每帧：1000 辆沿路网走（纯函数，供节点测试） ----------
export function stepCars(graph, cars, dt) {
  for (const car of cars) {
    if (car._deadEnd) continue; // 单向死胡同冻住，等回收（见 recycleFar），绝不掉头逆行
    car.s += car.dir * car.speed * dt;
    let guard = 0;
    while ((car.s > car.total || car.s < 0) && guard++ < 4) {
      const atEnd = car.s > car.total;
      const nx = pickNext(graph, car.seg, car.dir);
      if (nx) {
        const nseg = graph.segs[nx.seg];
        car.seg = nx.seg;
        car.dir = nx.dir;
        car.total = nseg.total;
        car.width = nseg.width;
        car.s = nx.dir > 0 ? 0.5 : nseg.total - 0.5;
      } else if (graph.segs[car.seg].ow === 1) {
        // 单向段走到真死胡同：冻住等回收，不掉头（掉头就是逆行）
        car.s = atEnd ? car.total : 0;
        car._deadEnd = true;
      } else {
        // 双向段死胡同：掉头，lat 换侧（随后滑向新右侧）
        car.s = atEnd ? car.total : 0;
        car.dir = -car.dir;
        car.lat = -car.lat;
      }
    }
    car.s = clamp(car.s, 0, car.total);
    // 横向滑向行驶方向右侧 width/4（3 m/s，与 roads.js 同速）
    const targetLat = car.width / 4;
    car.lat += clamp(targetLat - car.lat, -3 * dt, 3 * dt);
    positionCar(graph, car);
  }
}
function updateCars(dt) {
  stepCars(_graph, _cars, dt);
}

// ---------- 相机焦点 ----------
let _lastFocus = { x: 0, z: 0, mode: 'aerial' };
function getFocus() {
  const st = _ctx.state || {};
  const cam = _ctx.camera;
  if (st.mode === 'aerial' && st.target) {
    _lastFocus = { x: st.target.x, z: st.target.z, mode: 'aerial' };
  } else if (cam) {
    _lastFocus = { x: cam.position.x, z: cam.position.z, mode: st.mode || 'camera' };
  }
  return _lastFocus;
}

// ---------- 流式写实例：焦点 400m 内最近 160 辆 ----------
let _tmpM = null, _tmpQ = null, _tmpV = null, _tmpS = null;
function writeInstances() {
  const THREE = _THREE;
  if (!_tmpM) {
    _tmpM = new THREE.Matrix4();
    _tmpQ = new THREE.Quaternion();
    _tmpV = new THREE.Vector3();
    _tmpS = new THREE.Vector3(1, 1, 1);
  }
  const f = getFocus();
  const visible = selectVisible(_cars, f.x, f.z);
  _stats.visible = visible.length;
  _stats.busVisible = visible.filter((c) => c.model === 'bus').length;
  const white = _display === 'white';
  const up = new THREE.Vector3(0, 1, 0);
  let draws = 0;
  for (let mi = 0; mi < _modelStates.length; mi++) {
    const st = _modelStates[mi];
    const mesh = st.mesh;
    let n = 0;
    for (const car of _carsByModel[mi]) {
      if (!car.visible) continue;
      _tmpQ.setFromAxisAngle(up, car.heading);
      _tmpV.set(car.x, car.y, car.z);
      _tmpM.compose(_tmpV, _tmpQ, _tmpS);
      mesh.setMatrixAt(n, _tmpM);
      if (white) mesh.setColorAt(n, _tmpColorWhite());
      else mesh.setColorAt(n, _tmpColorTint(car));
      n++;
    }
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      draws++;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
  _stats.drawCalls = draws;
  _stats.renderedTris = Math.round(_modelStates.reduce((s, m) => s + m.mesh.count * m.tris, 0));
}
const _whiteColor = { c: null };
function _tmpColorWhite() {
  if (!_whiteColor.c) _whiteColor.c = new _THREE.Color(0xffffff);
  return _whiteColor.c;
}
const _tintCache = new Map();
function _tmpColorTint(car) {
  const tints = MODELS[car.modelIdx].model === 'bus' ? BUS_TINTS : TINTS;
  const key = `${car.modelIdx}:${car.tintIdx}`;
  if (!_tintCache.has(key)) _tintCache.set(key, new _THREE.Color(tints[car.tintIdx % tints.length]));
  return _tintCache.get(key);
}

// ---------- 白膜切换：换陶土材质；切回恢复原材质 ----------
function applyDisplay() {
  if (!_modelStates.length) return;
  const white = _display === 'white';
  for (const st of _modelStates) {
    st.mesh.material = white ? _clayMat : st.origMat;
  }
}

// ---------- 远场回收：焦点 1,200m 外的车搬回焦点附近主干道 ----------
// 选段（纯函数，供测试）：挑离焦点最近的主干道（宽 ≥10.5、长 ≥80m），
// 返回 {seg, s}——s 是该段上离焦点最近的弧长位置，车落过去就在焦点 400m 内看得见。
// 附近没有则逐档放宽（700m → 1,200m → 全城最近主干道）。
export function pickRespawnSeg(graph, fx, fz, rand) {
  const segDist = (seg) => {
    // 段到焦点的最短距离 + 对应弧长（逐节算点到线段距离）
    const pts = seg.info.pts;
    let bestD2 = Infinity, bestS = 0, acc = 0;
    for (let p = 1; p < pts.length; p++) {
      const ax = pts[p - 1][0], az = pts[p - 1][1], bx = pts[p][0], bz = pts[p][1];
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      let t = ((fx - ax) * dx + (fz - az) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t, pz = az + dz * t;
      const d2 = (fx - px) ** 2 + (fz - pz) ** 2;
      if (d2 < bestD2) { bestD2 = d2; bestS = acc + Math.sqrt(L2) * t; }
      acc += Math.sqrt(L2);
    }
    return { dist: Math.sqrt(bestD2), sArc: bestS };
  };
  const cands = graph.segs
    .map((seg, i) => ({ i, seg, ...segDist(seg) }))
    .filter((e) => e.seg.width >= 7 && e.seg.total >= 60);
  for (const maxD of [400, 700, 1200]) {
    const pool = cands.filter((e) => e.dist < maxD)
      .sort((a, b) => (a.seg.grade - b.seg.grade) || (a.dist - b.dist))
      .slice(0, 12); // 主干道优先，取最近的 12 段里随机挑
    if (pool.length >= 3) {
      const e = pool[(rand() * pool.length) | 0];
      return { seg: e.i, s: e.sArc };
    }
  }
  if (cands.length) {
    cands.sort((a, b) => a.dist - b.dist);
    const e = cands[0];
    return { seg: e.i, s: e.sArc };
  }
  return { seg: -1, s: 0 };
}
// 一轮远场回收（纯函数，供节点测试）：把焦点 1,200m 外的车（以及冻住的
// 单向死胡同车）按批搬回焦点附近主干道；返回搬了几辆。
export function recycleStep(graph, cars, fx, fz, randFn = Math.random) {
  const R2 = RECYCLE_R * RECYCLE_R;
  const placed = []; // 本轮已落位：[seg, dir, s]，同段同向留 30m 间距，不叠车
  let moved = 0;
  for (const car of cars) {
    if (moved >= RECYCLE_BATCH) break;
    if (!car._deadEnd && (car.dist2 < R2 || car.visible)) continue;
    if (!car._deadEnd && randFn() > 0.5) continue; // 每轮只动一半，避免全城同帧换位
    let segIdx = -1, seg = null, segS = 0, pickTries = 0;
    while (pickTries++ < 5) { // 单向陷阱段不回收进去（走到底是死胡同链）
      const cand = pickRespawnSeg(graph, fx, fz, randFn);
      if (cand.seg < 0) return moved;
      const cs = graph.segs[cand.seg];
      if (cs.ow === 1 && !hasLiveExit(graph, cand.seg, 1)) continue;
      segIdx = cand.seg; seg = cs; segS = cand.s;
      break;
    }
    if (segIdx < 0) continue;
    car.seg = segIdx;
    car.total = seg.total;
    car.width = seg.width;
    car.dir = seg.ow === 1 ? 1 : (randFn() < 0.5 ? 1 : -1); // 单向段只许顺向
    let s = segS + (randFn() - 0.5) * 300;
    for (const p of placed) {
      if (p.seg === segIdx && p.dir === car.dir && Math.abs(p.s - s) < 30) s = p.s + 35;
    }
    car.s = Math.min(Math.max(5, s), Math.max(5, seg.total - 5));
    placed.push({ seg: segIdx, dir: car.dir, s: car.s });
    car.lat = seg.width / 4;
    car._deadEnd = false;
    positionCar(graph, car);
    // 回收后去重：80m 内撞（型号+颜色）就换 tint
    const tints = MODELS[car.modelIdx].model === 'bus' ? BUS_TINTS : TINTS;
    let tries = 0;
    while (tries++ < 4) {
      let clash = false;
      for (const o of cars) {
        if (o === car || !o.visible) continue;
        if (o.modelIdx === car.modelIdx && o.tintIdx === car.tintIdx) {
          const d2 = (o.x - car.x) ** 2 + (o.z - car.z) ** 2;
          if (d2 < DEDUP_R * DEDUP_R) { clash = true; break; }
        }
      }
      if (!clash) break;
      car.tintIdx = (car.tintIdx + 1) % tints.length;
    }
    moved++;
  }
  return moved;
}
function recycleFar() {
  const f = getFocus();
  const moved = recycleStep(_graph, _cars, f.x, f.z, Math.random);
  if (moved) { _stats.recycles += moved; _selectAcc = SELECT_EVERY; }
}

// ---------- 接线（总协调加，traffic.js 不动 app.js / roads.js） ----------
// app.js WIRING 里 roads 之后加一行：
//   ['traffic', './traffic.js'],
// app.js setDisplay 的传播列表里加 '__traffic'（与 '__roads' 同列）：
//   for (const k of ['__roads', '__traffic', '__dSun', ...]) { ... }
// app.js applyTime 的夜色传播里加一行（setNight 接口已备好）：
//   if (window.__traffic && window.__traffic.setNight) { try { window.__traffic.setNight(state.night); } catch (e) {} }
// 验收（控制台）：
//   window.__traffic.getStats()        // total/visible/buses/busVisible/drawCalls/lastUpdateMs/lastSelectMs
//   window.__sandboxStats              // fps / calls / triangles（app.js 每 0.5s 写）
