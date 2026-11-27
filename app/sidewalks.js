// sidewalks.js — 星泽市 · 人行道 + 中央绿化带（人行道/绿化带路，2026-11-27）
// 新模块，不动 roads.js（R 路在改它）。只读 window.__roads.data（ROADS_DATA，
// roads.js 内嵌的 OSM 路网：arterials + junctions）+ data/small-roads-v1.json。
//
// 做法（数据层 OSM 直出 + 规则层批量，不手摆坐标、不编数据）：
//   人行道：地面车行道两侧各一条浅灰窄条，跟车行道带面分开画。
//     宽（老大 2026-11-27 01:49 定）：主干道每边 3m，次干道每边 2.5m，
//     支路 / 居住区小路每边 2m。
//     有：地面上的主干道、次干道、支路、居住区小路。
//     没有：高架和高速（不许行人）、上下匝道（_link）、步行街（整条路都
//     是给人走的）、人行道 / 自行车道 / 小径本身。
//     判定口径：roads.js 的 road.nosw 标志（walk-flags 脚本打好：高架 /
//     高速 / 匝道）+ 小路网文件本身就是车行小路网。arterials 里没有
//     highway 字段，highway 类型用等级（grade）+ 宽度代理：grade 0 =
//     主干（trunk/primary），grade 1 = 次干（secondary/tertiary），
//     small-roads = 支路及以下（residential/service/unclassified）。
//   中央绿化带：宽的双向主干道中间的绿色条带，主干道 3m（一般 2–5m）。
//     只画有隔离带的宽双向主干道，次干道 / 支路 / 小路没有隔离带不画。
//     数据里 road.med 标志全城只有 1 段（25m，紫气东大道），不够画；
//     真正的隔离带在数据里是“分隔式双幅路”：同一条主干道的两条平行
//     单幅（同名、同等级、同宽、平行、幅距 8–24m）——两幅之间的带子
//     就是中央隔离带。本模块按点配对找出来，绿带画在两幅的中线上，
//     宽 3m（老大定）；人行道只画两幅的外侧，内侧不画（内侧对着绿化
//     带，不是人行道）。幅距实测：宽 14m 的双幅路幅距 11–17m（宽是按
//     车道/等级给的整幅宽，两幅各算一次就重叠了），所以配对不用
//     “间隙 ≥0.5”当条件，绿带宽也不按间隙算，直接定 3m。
//     未配对的宽双向主干道（grade 0、非单向 ow=0、宽 ≥14m）中线画 3m
//     绿带（含 med=1 的那 1 段）；单幅单向的宽主干道不画中线绿带——
//     它的中线是单幅车行道的中间，不是隔离带。
//   桥墩在绿带里：桥墩是 D 路分块 GLB 里的几何（桥面 >2m 处约 30m 一根，
//     放隔离带 / 人行道 / 河里），本模块只负责把绿带画到墩子脚下该在
//     的位置（地面宽双向主干道中线），不画墩子。
//
// 几何口径（与 roads.js 对齐，避免盖错层）：
//   带面宽 ribbonWidth：主干 width×1.5、次干 width+4（roads.js AERIAL）。
//   人行道内缘 = 带面外缘 + 0.5m；人行道 y = 路点 y + 0.24（roads.js
//   旧人行道 +0.18、标线 +0.42，夹在中间不闪）；绿带 y = 路点 y + 0.52
//   （高于车行道带面 +0.30 与中心虚线 +0.45，盖住中线，路口处断开）。
//   小路：带面半宽 (max(w,3)+1.5)/2（roads.js buildSmallRoads 同口径），
//   人行道内缘 = 带面外缘 + 0.3m，y = 路点 y + 0.22（小路带面 +0.15 之上）。
//   路口：25 个路口盒（junctions，半径 = 两路半宽之大者 + 3m）内人行道 /
//   绿带都断开，斑马线位置不压。
//   去重：ROADS_DATA 里 195 段是同几何双名路（如夜澜大道 / 云锦北大道
//   同一段路两个名），按几何去重后再画，否则同位双画闪烁。
//
// 颜色：人行道浅灰 #C9CCD2（比车行道浅、比地面 0xe8e9ea 略深，跟参考站
//   浅灰人行道对）；绿带 #5A9158。白膜下人行道保持浅灰、绿带保持绿——
//   与 roads.js 路带白膜豁免（__keepColor）同一条调和口径：路的本体是
//   骨架例外，漂成陶土色就和地面糊在一起看不见了。
// 导出：init(ctx) / setDisplay(mode) / setNight(v)。
// 纯函数也导出，供单测 / V 路核对（不依赖 THREE / window）。
export { dedupeArterials, groupByName, pairedRunsFor, junctionBoxes, ribbonWidth, stripAlong, makeBuilder, routeLen };
// 接线（总协调加，见报告）：WIRING 里 roads 之后加 ['sidewalks', './sidewalks.js']；
//   app.js setDisplay 广播列表里加 '__sidewalks'，applyTime 夜色传播里加
//   window.__sidewalks.setNight（可选：夜里人行道微发光）。
// 注意：roads.js buildRoadPaint 里还留着旧的主干人行道（只做主干两侧，
//   3.4m 宽，y +0.18），它上面写着“sidewalks.js 接手时应删掉本块”——
//   本模块没动 roads.js，旧块还在；新带 y +0.24 盖在旧带之上不闪，但外侧
//   会多出 0.4m 旧色边（#8B94B5）。接线时请 R 路删掉旧块（见报告）。

const SW_W = { 0: 3, 1: 2.5 };       // 动脉人行道宽：主干 3m / 次干 2.5m
const SMALL_SW_W = 2;                // 支路 / 居住区小路人行道宽 2m
const MED_W_MAIN = 3;                // 主干道中央绿化带宽 3m（一般 2–5m）
const SW_Y = 0.24, MED_Y = 0.52, SMALL_SW_Y = 0.22;
const SW_COLOR = [0.585, 0.605, 0.645];   // #C9CCD2 浅灰（已转线性值，供顶点色用）
const MED_COLOR = [0.102, 0.283, 0.098];  // #5A9158 绿带（已转线性值）
const SMALL_ROAD_URLS = ['../data/small-roads-v1.json', './data/small-roads-v1.json'];

let _ctx = null, _THREE = null, _group = null, _swMat = null, _medMat = null;
let _mode = 'white', _night = 0, _started = false;
let _smallReady = null, _smallResolve = null;
const _stats = {
  arterials: 0, deduped: 0, pairs: 0, pairKm: 0, singleWideKm: 0,
  sidewalkKm: 0, medianKm: 0, medianSegs: 0,
  smallRoads: 0, smallRoadKm: 0, smallSidewalkKm: 0,
  quads: 0,
};
let _arterialGrid = null; // 地面动脉段空间格（64m），供小路人行道避让动脉车行道用
function log(...a) { console.log('[sidewalks]', ...a); }

// ---------- 纯函数（不依赖 THREE，可单测） ----------
// 带面宽：与 roads.js ribbonWidth / AERIAL 同口径
function ribbonWidth(road) {
  return road.grade === 0 ? road.width * 1.5 : road.width + 4;
}
function segLen(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
function routeLen(pts) {
  let t = 0;
  for (let i = 1; i < pts.length; i++) t += segLen(pts[i - 1], pts[i]);
  return t;
}
// 按几何去重：同 pts（双名路）只留第一段
function dedupeArterials(arterials) {
  const seen = new Set(), out = [];
  for (const a of arterials) {
    const k = JSON.stringify(a.pts);
    if (seen.has(k)) continue;
    seen.add(k); out.push(a);
  }
  return { list: out, removed: arterials.length - out.length };
}
function junctionBoxes(junctions) {
  return (junctions || []).map((j) => ({ x: j.x, z: j.z, r: Math.max(j.wA, j.wB) / 2 + 3 }));
}
function inJunctionBox(boxes, x, z) {
  for (const b of boxes) {
    const dx = x - b.x, dz = z - b.z;
    if (dx * dx + dz * dz < b.r * b.r) return true;
  }
  return false;
}
function _nearestOnSeg(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + dx * t, a[1] + dz * t];
}
function _nearestOnPoly(p, pts) {
  let best = null, bd = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const q = _nearestOnSeg(p, pts[i - 1], pts[i]);
    const dd = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (dd < bd) { bd = dd; best = q; }
  }
  return { pt: best, d: bd };
}
function _endDir(a) {
  const f = a.pts[0], l = a.pts[a.pts.length - 1];
  const dx = l[0] - f[0], dz = l[1] - f[1], L = Math.hypot(dx, dz) || 1;
  return [dx / L, dz / L];
}
// 分隔式双幅路：不按“段”一对一配对（长段常被对面切成多段，一对一
// 会丢掉大半隔离带），按点配——每点在同名同等级同宽的段里找平行
// 伙伴（间隙 0.5–6m、30m 内）。同名分组后每点只查组内段。
function groupByName(cands) {
  const groups = new Map();
  for (const a of cands) {
    const k = a.name + '|' + a.grade + '|' + a.width;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return groups;
}
// 一幅路的配对分段：返回 { paired, single }；paired 段为 { pts, dAt, gapAt }
//（中线点 + 幅距 + 间隙），single 段为 { pts }（原点）。段按“两端是否
// 都有伙伴”切分，相邻段共用分界点。
function pairedRunsFor(seg, group) {
  const [fx, fz] = _endDir(seg);
  const PAR = Math.cos(10 * Math.PI / 180);
  const mates = group.filter((o) => o !== seg).map((o) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of o.pts) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1];
    }
    return { o, dir: _endDir(o), x0, x1, z0, z1 };
  });
  const mid = [], dAt = [], gapAt = [], isPair = [], partnerAt = [];
  for (const p of seg.pts) {
    let best = null, bestD = Infinity;
    for (const m of mates) {
      if (p[0] < m.x0 - 30 || p[0] > m.x1 + 30 || p[1] < m.z0 - 30 || p[1] > m.z1 + 30) continue;
      if (Math.abs(fx * m.dir[0] + fz * m.dir[1]) < PAR) continue;
      const nb = _nearestOnPoly(p, m.o.pts);
      if (nb.d < bestD) { bestD = nb.d; best = { nb, other: m.o }; }
    }
    // 伙伴判定：平行（<10°）+ 幅距 D 在 8–24m 内。注意不用“间隙 =
    // D − 宽 ≥0.5”当条件：实测宽 14m 的双幅路幅距只有 11–17m（宽是
    // 按车道/等级给的整幅宽，两幅各算一次就重叠了），间隙会算成负数；
    // 隔离带宽直接按老大定的主干道 3m 画在中线上。
    if (best && bestD >= 8 && bestD <= 24 && bestD < 30) {
      const nb = best.nb;
      let oy = best.other.pts[0][2];
      let bd = Infinity;
      for (const q of best.other.pts) {
        const dd = Math.hypot(q[0] - nb.pt[0], q[1] - nb.pt[1]);
        if (dd < bd) { bd = dd; oy = q[2]; }
      }
      mid.push([(p[0] + nb.pt[0]) / 2, (p[1] + nb.pt[1]) / 2, (p[2] + oy) / 2]);
      dAt.push(bestD);
      gapAt.push(bestD - seg.width);
      isPair.push(true);
      partnerAt.push(best.other);
    } else {
      mid.push([p[0], p[1], p[2]]);
      dAt.push(0);
      gapAt.push(0);
      isPair.push(false);
      partnerAt.push(null);
    }
  }
  const paired = [], single = [];
  let start = 0, curPair = null;
  const segPair = (j) => isPair[j] && isPair[j + 1];
  for (let j = 0; j < mid.length - 1; j++) {
    const p = segPair(j);
    if (curPair === null) { curPair = p; start = j; }
    else if (p !== curPair) {
      if (curPair) paired.push({ pts: mid.slice(start, j + 1), dAt: dAt.slice(start, j + 1), gapAt: gapAt.slice(start, j + 1), partner: partnerAt[start] });
      else single.push({ pts: seg.pts.slice(start, j + 1) });
      curPair = p; start = j;
    }
  }
  if (curPair !== null) {
    if (curPair) paired.push({ pts: mid.slice(start), dAt: dAt.slice(start), gapAt: gapAt.slice(start), partner: partnerAt[start] });
    else single.push({ pts: seg.pts.slice(start) });
  }
  return { paired, single, grade: seg.grade, width: seg.width, name: seg.name };
}

// ---------- 小几何 builder（顶点色 + 面法线，合并成 1 个 mesh） ----------
function makeBuilder() {
  const pos = [], nor = [], col = [];
  function quad(a, b, c, d, color) {
    // 三角顺序 [a,c,b],[a,d,c]，法线 (c-a)×(b-a)：朝上（+y）。
    // 之前是 [a,b,c],[a,c,d]、法线朝下，FrontSide 下从上面看不见——
    // 2026-11-27 晚实测：绿带几何存在（距中线 6m 内有三角），图里却
    // 没有绿，法线 (0,-1891,0) 朝下就是原因。人行道同 builder 同 bug。
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2];
    const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const p of [a, c, b, a, d, c]) {
      pos.push(p[0], p[1], p[2]); nor.push(nx, ny, nz);
      col.push(color[0], color[1], color[2]);
    }
  }
  function buildGeometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
    return g;
  }
  return { quad, buildGeometry, get count() { return pos.length / 3; } };
}
// 沿折线画一条偏移带：每段按该段方向取法向，两端偏移可不同（off0/off1
// 为带中心到折线的距离，hw 为带半宽，yOff 为高程抬升）。路口盒内、或
// skipFn(中点 x, z) 为真时跳过该段。
function stripAlong(builder, pts, offAt, hw, yOff, boxes, color, skipFn) {
  let km = 0, quads = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    if (l < 0.5) continue;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (inJunctionBox(boxes, mx, mz)) continue;
    if (skipFn && skipFn(mx, mz)) continue;
    const px = -dz / l, pz = dx / l;
    const o0 = offAt(i - 1), o1 = offAt(i);
    const y0 = a[2] + yOff, y1 = b[2] + yOff;
    builder.quad(
      [a[0] + px * (o0 - hw), y0, a[1] + pz * (o0 - hw)],
      [b[0] + px * (o1 - hw), y1, b[1] + pz * (o1 - hw)],
      [b[0] + px * (o1 + hw), y1, b[1] + pz * (o1 + hw)],
      [a[0] + px * (o0 + hw), y0, a[1] + pz * (o0 + hw)], color);
    km += l; quads++;
  }
  return { km, quads };
}
const _constOff = (v) => () => v;

// ---------- 动脉空间格：小路人行道不得横穿地面动脉车行道 ----------
// 地面动脉段按 64m 格索引；查一点是否落在某动脉带面（半宽 + 1m）内。
// 只含地面动脉（!nosw）：高架在空中，小路人行道从桥下过是正常的，不避让。
const _GRID_CELL = 64;
function buildArterialGrid(eligible) {
  const grid = new Map();
  const key = (cx, cz) => cx + ',' + cz;
  for (const road of eligible) {
    const hw = ribbonWidth(road) / 2;
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1], b = road.pts[i];
      const seg = { ax: a[0], az: a[1], bx: b[0], bz: b[1], hw };
      const x0 = Math.floor(Math.min(a[0], b[0]) / _GRID_CELL), x1 = Math.floor(Math.max(a[0], b[0]) / _GRID_CELL);
      const z0 = Math.floor(Math.min(a[1], b[1]) / _GRID_CELL), z1 = Math.floor(Math.max(a[1], b[1]) / _GRID_CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(seg);
      }
    }
  }
  return grid;
}
function _nearArterial(x, z) {
  if (!_arterialGrid) return false;
  const cx = Math.floor(x / _GRID_CELL), cz = Math.floor(z / _GRID_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const segs = _arterialGrid.get((cx + dx) + ',' + (cz + dz));
    if (!segs) continue;
    for (const s of segs) {
      const q = _nearestOnSeg([x, z], [s.ax, s.az], [s.bx, s.bz]);
      if (Math.hypot(q[0] - x, q[1] - z) < s.hw + 1.0) return true;
    }
  }
  return false;
}

// ---------- 动脉人行道 + 绿带 ----------
function buildArterials(THREE, data, group) {
  const sw = makeBuilder(), med = makeBuilder();
  const boxes = junctionBoxes(data.junctions);
  const { list, removed } = dedupeArterials(data.arterials || []);
  _stats.arterials = data.arterials.length;
  _stats.deduped = removed;
  const eligible = list.filter((a) => !a.nosw && a.pts && a.pts.length >= 2 && a.width > 0);
  _arterialGrid = buildArterialGrid(eligible);
  const groups = groupByName(eligible.filter((a) => a.width >= 10.5));
  const idxOf = new Map(eligible.map((a, i) => [a, i]));
  let pairSegs = 0;

  // 宽幅路（≥10.5m）先按点配对：重叠段走双幅处理（中线绿带仅主干 +
  // 两幅外侧人行道），悬空段按单幅处理（两侧人行道、无绿带）
  for (const road of eligible) {
    if (road.width < 10.5) continue;
    const runs = pairedRunsFor(road, groups.get(road.name + '|' + road.grade + '|' + road.width) || [road]);
    const swW = SW_W[road.grade] ?? 2.5, swHW = swW / 2;
    const rbHW = ribbonWidth(road) / 2;
    let hasPair = false;
    for (const run of runs.paired) {
      hasPair = true;
      // 两幅各算一次中线会同位双画：只由序号小的一幅画这段（partner 侧跳过）
      if (run.partner && idxOf.get(road) > idxOf.get(run.partner)) continue;
      pairSegs++;
      const L = routeLen(run.pts);
      _stats.pairKm += L / 1000;
      for (const side of [-1, 1]) {
        const r = stripAlong(sw, run.pts,
          (i) => side * (run.dAt[i] / 2 + rbHW + 0.5 + swHW),
          swHW, SW_Y, boxes, SW_COLOR);
        _stats.sidewalkKm += r.km / 1000; _stats.quads += r.quads;
      }
      if (road.grade === 0) {
        // 中央绿化带：主干道 3m（老大定），画在两幅中线上
        const r = stripAlong(med, run.pts, _constOff(0), MED_W_MAIN / 2, MED_Y, boxes, MED_COLOR);
        _stats.medianKm += r.km / 1000; _stats.medianSegs++; _stats.quads += r.quads;
      }
    }
    for (const run of runs.single) {
      _stats.singleWideKm += routeLen(run.pts) / 1000;
      for (const side of [-1, 1]) {
        const r = stripAlong(sw, run.pts,
          _constOff(side * (rbHW + 0.5 + swHW)), swHW, SW_Y, boxes, SW_COLOR);
        _stats.sidewalkKm += r.km / 1000; _stats.quads += r.quads;
      }
    }
    // 整段都没配上、又是宽双向主干道：中线画绿带（med 标志，或
    // grade 0 + 非单向 + 宽 ≥14m）
    if (!hasPair && road.grade === 0 && (road.med || (!road.ow && road.width >= 14))) {
      const r = stripAlong(med, road.pts, _constOff(0), MED_W_MAIN / 2, MED_Y, boxes, MED_COLOR);
      _stats.medianKm += r.km / 1000; _stats.medianSegs++; _stats.quads += r.quads;
    }
  }
  _stats.pairs = pairSegs;

  // 窄幅路（<10.5m）：两侧人行道（配对只针对宽幅路）
  for (const road of eligible) {
    if (road.width >= 10.5) continue;
    const swW = SW_W[road.grade] ?? 2.5, swHW = swW / 2;
    const rbHW = ribbonWidth(road) / 2;
    for (const side of [-1, 1]) {
      const r = stripAlong(sw, road.pts,
        _constOff(side * (rbHW + 0.5 + swHW)), swHW, SW_Y, boxes, SW_COLOR);
      _stats.sidewalkKm += r.km / 1000; _stats.quads += r.quads;
    }
  }

  _swMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  _medMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const swMesh = new THREE.Mesh(sw.buildGeometry(THREE), _swMat);
  swMesh.name = 'sidewalk-surface';
  swMesh.matrixAutoUpdate = false; swMesh.updateMatrix();
  const medMesh = new THREE.Mesh(med.buildGeometry(THREE), _medMat);
  medMesh.name = 'median-green';
  medMesh.matrixAutoUpdate = false; medMesh.updateMatrix();
  group.add(swMesh, medMesh);
  log(`arterials: ${eligible.length} eligible, ${_stats.pairs} paired runs (${_stats.pairKm.toFixed(1)} km), ` +
    `sidewalk ${_stats.sidewalkKm.toFixed(1)} km, median ${_stats.medianKm.toFixed(1)} km / ${_stats.medianSegs} segs, ` +
    `deduped ${removed}`);
}

// ---------- 小路人行道（data/small-roads-v1.json，异步，不阻塞启动） ----------
// pts 是 [x, y, z]（y = DEM-506）；带面半宽 (max(w,3)+1.5)/2，与 roads.js
// buildSmallRoads 同口径；人行道每边 2m，内缘 = 带面外缘 + 0.3m。
function buildSmallRoads(THREE, group, json) {
  const sw = makeBuilder();
  const boxes = junctionBoxes(_ctx && window.__roads ? window.__roads.data.junctions : []);
  let n = 0, km = 0;
  for (const road of json.roads || []) {
    const pts = road.pts;
    if (!pts || pts.length < 2) continue;
    const hw = (Math.max(road.w || 3, 3) + 1.5) / 2;
    n++;
    // 转成 [x, z, y] 供 stripAlong 用；落在地面动脉带面上的段跳过
    //（小路人行道不横穿主干道车行道），路口盒内也断开。
    const p3 = pts.map((p) => [p[0], p[2], p[1]]);
    for (const side of [-1, 1]) {
      const r = stripAlong(sw, p3,
        _constOff(side * (hw + 0.3 + SMALL_SW_W / 2)),
        SMALL_SW_W / 2, SMALL_SW_Y, boxes, SW_COLOR, _nearArterial);
      km += r.km; _stats.quads += r.quads;
    }
  }
  // 路长（中心线）单独算
  let roadKm = 0;
  for (const road of json.roads || []) {
    const pts = road.pts;
    if (!pts || pts.length < 2) continue;
    for (let i = 1; i < pts.length; i++) {
      roadKm += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
    }
  }
  _stats.smallRoads = n;
  _stats.smallRoadKm = +(roadKm / 1000).toFixed(1);
  _stats.smallSidewalkKm = +(km / 1000).toFixed(1);
  const mesh = new THREE.Mesh(sw.buildGeometry(THREE), _swMat);
  mesh.name = 'sidewalk-small';
  mesh.matrixAutoUpdate = false; mesh.updateMatrix();
  group.add(mesh);
  log(`small roads: ${n} roads, ${Math.round(roadKm / 1000)} km road, sidewalk ${_stats.smallSidewalkKm} km`);
  return mesh;
}
async function loadSmallRoads(THREE, group) {
  for (const url of SMALL_ROAD_URLS) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const json = await r.json();
      if (!json || !json.roads) continue;
      buildSmallRoads(THREE, group, json);
      if (_smallResolve) _smallResolve(true);
      return true;
    } catch (e) { /* 下一个候选 */ }
  }
  console.warn('[sidewalks] small-roads-v1.json 加载失败，小路人行道缺失');
  if (_smallResolve) _smallResolve(false);
  return false;
}

// ---------- init / setDisplay / setNight ----------
export async function init(ctx) {
  if (_started) return window.__sidewalks;
  _started = true;
  _ctx = ctx; _THREE = ctx.THREE;
  const THREE = ctx.THREE, scene = ctx.scene;
  if (!scene || !THREE) throw new Error('[sidewalks] ctx.scene / ctx.THREE 缺失');
  _smallReady = new Promise((res) => { _smallResolve = res; });
  // 等 roads 先接好（WIRING 顺序保证 roads 在前；防御性等 5 秒）
  const t0 = performance.now();
  while (!window.__roads?.data?.arterials && performance.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const data = window.__roads?.data;
  if (!data || !data.arterials) {
    console.warn('[sidewalks] window.__roads.data 缺失（roads 未接线？），跳过');
    if (_smallResolve) _smallResolve(false);
    return { ok: false, stopped: 'no-roads-data' };
  }
  _group = new THREE.Group();
  _group.name = 'sidewalks';
  scene.add(_group);
  buildArterials(THREE, data, _group);
  loadSmallRoads(THREE, _group); // 异步取，到了就并进组（不阻塞启动）
  const api = {
    group: _group, stats: _stats,
    smallRoadsReady: _smallReady,
    setDisplay, setNight,
  };
  window.__sidewalks = api;
  log('built', JSON.stringify(_stats));
  return api;
}

export function setDisplay(mode) {
  _mode = mode || 'normal';
  // 白膜 / 正常都不漂白：人行道浅灰、绿带绿色是路的本体（与 roads.js
  // 路带 __keepColor 豁免同一口径）；只有热力图藏起本组（热力只看楼高）。
  if (_group) _group.visible = (_mode !== 'heat');
  if (_mode !== 'white') setNight(_night);
  log('display ->', _mode, _group ? ('group.visible=' + _group.visible) : '');
}

export function setNight(v) {
  _night = Math.max(0, Math.min(1, +v || 0));
  // 夜里人行道微发光（与 roads.js _walkMat 同口径 0.35×night）；绿带不发光。
  if (_swMat) {
    _swMat.emissive.setRGB(SW_COLOR[0], SW_COLOR[1], SW_COLOR[2]);
    _swMat.emissiveIntensity = _mode === 'white' ? 0 : 0.35 * _night;
  }
}
