// street.js — F 路：街面实时层（路灯亮化 / 街具 / 店面门面 / 街上实时验走法）
// 方案 §3.14 / 验收表第 15 行 + 第 24 行（夜景重做，F 路管路灯亮化）。
// 路灯做法（13:50 改向后）：学他那摆放——灯沿路走、两侧交错、等距、夜里全亮。
// 我们的 141,756 盏是实灯：位置只在分块 GLB 的线几何里（CJJ45 间距沿真实 OSM
// 路放置，见 build_six.py:994-1005，灯杆线色 C_LAMP=[0.62,0.62,0.65]），
// six-loader 不暴露灯位列表。本模块运行时直接从已加载分块的线几何里按灯色
// 把实灯位置读出来（灯杆顶端 = 灯头），夜里全部加上发光点——不是另编一套
// 假灯位。参考沙盘灯位间距的具体数字在已读到的文字版/方法里没给，无法核实，
// 不编数字；我们执行的是包里实灯自身的放置规则（CJJ45 间距沿路）。
// 灯杆本身已在包里是线，不再另做杆；本模块只加夜里灯头亮点 + 光晕。
// 店面招牌字全部是自己画的通用字（canvas 绘制），无任何真实品牌。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STREET_SEGMENTS, mulberry32 } from './people.js';

export const NEON_PINK = 0xFF2E88;
export const NEON_CYAN = 0x00F0FF;
export const NEON_PURPLE = 0x8B5CFF;
export const NEON_ORANGE = 0xFF9F1C;
export const LAMP_WARM = 0xFFD166;

// “街上实时验”走法：星泽广场 → 星熙路 → 星光里（six-names.json 虚构名）
export const ROUTE_WAYPOINTS = [
  [-114.9, -570.4],   // 星泽广场
  [1155.7, -994.9],   // 星熙路
  [1390.3, -963.9],   // 星光里
];
// 沿路线每 100m 一个采样点（含起点终点）
export function routeSamples(step = 100) {
  const pts = [];
  for (let s = 0; s < ROUTE_WAYPOINTS.length - 1; s++) {
    const [x0, z0] = ROUTE_WAYPOINTS[s];
    const [x1, z1] = ROUTE_WAYPOINTS[s + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.round(len / step);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      pts.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
    }
  }
  pts.push([...ROUTE_WAYPOINTS[ROUTE_WAYPOINTS.length - 1]]);
  return pts;
}

let ctx = null;
let group = null;
let lampGlow = null;   // Points：夜里光晕（全部实灯）
let lampHeads = null;  // Points：灯头亮点（全部实灯）
let lampCount = 0;
let lampScanTimer = 0;
// harvest 状态：按分块 root 去重（high/mid 两档会重复同一盏灯；分块卸载要清掉）
const lampByRoot = new Map(); // rootUuid -> Float32Array 位置（每盏灯一个头点）
const scannedRoots = new Set();
let shopSignMats = []; // 每块招牌的材质（昼夜亮度调节用）
let neonMeshes = [];   // 霓虹件（白膜模式要收起来）
let origInstanceColors = new Map(); // mesh.uuid -> Map(index -> hex)
let rafId = 0;
let lastT = 0;
let displayMode = 'normal';

function groundY(x, z) {
  try {
    if (ctx && ctx.sixLoader && ctx.sixLoader.groundHeightAt) return ctx.sixLoader.groundHeightAt(x, z);
  } catch (e) { /* fall through */ }
  return 3.0;
}

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.rotateX(rx).rotateY(ry).rotateZ(rz);
  g.translate(x, y, z);
  return g;
}
function cyl(rt, rb, h, x, y, z, seg = 8) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  g.translate(x, y, z);
  return g;
}

function glowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  return tex;
}

function signTexture(word, colorHex) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#0B1026';
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = colorHex;
  g.lineWidth = 6;
  g.strokeRect(6, 6, 500, 116);
  g.font = 'bold 64px "PingFang SC","Microsoft YaHei",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = colorHex;
  g.shadowBlur = 28;
  g.fillStyle = colorHex;
  g.fillText(word, 256, 68);
  // 描两次，霓虹更亮
  g.fillText(word, 256, 68);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- ① 路灯亮化：从已加载分块的线几何里读实灯位置 ----------
// 包里灯杆是竖线段，顶点色 C_LAMP=[0.62,0.62,0.65]（build_six.py:604），
// 与桥线 [0.45,0.45,0.52]、特殊线 [0.42,0.42,0.50] 严格区分。线段顶端即灯头。
// 1m 短竖线是隧道顶灯（地下，不可见），按杆长 >2m 滤掉。
const LAMP_RGB = [0.62, 0.62, 0.65];
function harvestLamps() {
  const THREE_ = ctx.THREE;
  const loader = ctx.sixLoader;
  if (!loader || !loader.chunkGroup) return 0;
  let changed = false;
  const live = new Set();
  loader.chunkGroup.traverse((o) => {
    if (!o.isLine) return;
    const root = o.parent;
    const key = root ? root.uuid : o.uuid;
    live.add(key);
    if (scannedRoots.has(key)) return;
    scannedRoots.add(key);
    const pos = o.geometry && o.geometry.attributes.position;
    const col = o.geometry && o.geometry.attributes.color;
    if (!pos || !col) return;
    const pts = [];
    const seen = new Set();
    for (let i = 0; i + 1 < pos.count; i += 2) {
      const r0 = col.getX(i), g0 = col.getY(i), b0 = col.getZ(i);
      if (Math.abs(r0 - LAMP_RGB[0]) > 0.02 || Math.abs(g0 - LAMP_RGB[1]) > 0.02 || Math.abs(b0 - LAMP_RGB[2]) > 0.02) continue;
      const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i);
      const x1 = pos.getX(i + 1), y1 = pos.getY(i + 1), z1 = pos.getZ(i + 1);
      const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      if (len < 2) continue; // 隧道顶灯 1m 短线，滤掉
      const tx = y1 > y0 ? x1 : x0, ty = Math.max(y0, y1), tz = y1 > y0 ? z1 : z0;
      const qk = `${tx.toFixed(1)},${tz.toFixed(1)}`;
      if (seen.has(qk)) continue;
      seen.add(qk);
      pts.push(tx, ty, tz);
    }
    if (pts.length) {
      lampByRoot.set(key, new Float32Array(pts));
      changed = true;
    }
  });
  // 分块卸载了就清掉它的灯
  for (const k of [...lampByRoot.keys()]) {
    if (!live.has(k)) { lampByRoot.delete(k); scannedRoots.delete(k); changed = true; }
  }
  if (!changed) return lampCount;
  // 合并全部实灯头点，重建两个 Points（光晕 + 灯头亮点），draw call 恒为 2
  let total = 0;
  for (const arr of lampByRoot.values()) total += arr.length / 3;
  const posArr = new Float32Array(total * 3);
  const colArr = new Float32Array(total * 3);
  const headColArr = new Float32Array(total * 3);
  const c = new THREE_.Color();
  let w = 0;
  for (const arr of lampByRoot.values()) {
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i], y = arr[i + 1], z = arr[i + 2];
      posArr[w * 3] = x; posArr[w * 3 + 1] = y; posArr[w * 3 + 2] = z;
      // 两档交错：暖黄 #FFD166 为主，每 3 盏一盏霓虹青 #00F0FF（按空间哈希定死）
      const cyan = ((Math.floor(x / 30) + Math.floor(z / 30)) % 3 + 3) % 3 === 0;
      c.setHex(cyan ? NEON_CYAN : LAMP_WARM);
      colArr[w * 3] = c.r; colArr[w * 3 + 1] = c.g; colArr[w * 3 + 2] = c.b;
      c.setHex(0xFFF6E0);
      headColArr[w * 3] = c.r; headColArr[w * 3 + 1] = c.g; headColArr[w * 3 + 2] = c.b;
      w++;
    }
  }
  lampGlow.geometry.setAttribute('position', new THREE_.BufferAttribute(posArr, 3));
  lampGlow.geometry.setAttribute('color', new THREE_.BufferAttribute(colArr, 3));
  lampGlow.geometry.attributes.position.needsUpdate = true;
  if (lampGlow.geometry.attributes.color) lampGlow.geometry.attributes.color.needsUpdate = true;
  lampGlow.geometry.computeBoundingSphere();
  lampHeads.geometry.setAttribute('position', new THREE_.BufferAttribute(posArr, 3));
  lampHeads.geometry.setAttribute('color', new THREE_.BufferAttribute(headColArr, 3));
  lampHeads.geometry.attributes.position.needsUpdate = true;
  if (lampHeads.geometry.attributes.color) lampHeads.geometry.attributes.color.needsUpdate = true;
  lampHeads.geometry.computeBoundingSphere();
  lampCount = total;
  return lampCount;
}

function buildLamps() {
  const THREE_ = ctx.THREE;
  // 两个 Points：光晕（大、加色混合）+ 灯头亮点（小、实心），灯再多也是 2 个 draw call
  const mkPoints = (size, map, blending) => {
    const geo = new THREE_.BufferGeometry();
    geo.setAttribute('position', new THREE_.BufferAttribute(new Float32Array(0), 3));
    geo.setAttribute('color', new THREE_.BufferAttribute(new Float32Array(0), 3));
    const mat = new THREE_.PointsMaterial({
      size, map, vertexColors: true, transparent: true, opacity: 0,
      blending, depthWrite: false, sizeAttenuation: true,
    });
    const p = new THREE_.Points(geo, mat);
    p.frustumCulled = false;
    return p;
  };
  lampGlow = mkPoints(26, glowTexture(), THREE_.AdditiveBlending);
  lampGlow.name = 'surpass-lamp-glow';
  lampHeads = mkPoints(7, glowTexture(), THREE_.NormalBlending);
  lampHeads.name = 'surpass-lamp-heads';
  group.add(lampGlow);
  group.add(lampHeads);
  neonMeshes.push(lampHeads, lampGlow);
  // 分块是流式加载的：每 2.5 秒重扫一次，新加载的分块进来灯就进来
  harvestLamps();
  clearInterval(lampScanTimer);
  lampScanTimer = setInterval(harvestLamps, 2500);
  return lampCount;
}

// ---------- ② 街具：长椅 / 垃圾桶 / 指示牌 / 红绿灯 ----------
function buildFurniture() {
  const THREE_ = ctx.THREE;
  const rnd = mulberry32(0x51AB);
  const placements = { bench: [], bin: [], sign: [], light: [] };
  // 沿主街每 ~120m 一组街具，两侧交错，同种成排有差别（旋转/缩放/颜色按种子变）
  for (const seg of STREET_SEGMENTS) {
    if (seg.id.startsWith('X')) continue;
    const dx = seg.b[0] - seg.a[0], dz = seg.b[1] - seg.a[1];
    const len = Math.hypot(dx, dz);
    const nx = -dz / len, nz = dx / len;
    const n = Math.max(1, Math.floor(len / 120));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const side = (i % 2 === 0 ? 1 : -1) * 9.5;
      const x = seg.a[0] + dx * t + nx * side;
      const z = seg.a[1] + dz * t + nz * side;
      const heading = Math.atan2(dx, dz) + Math.PI / 2;
      placements.bench.push({ x, z, heading: heading + (rnd() - 0.5) * 0.2, s: 0.9 + rnd() * 0.25 });
      placements.bin.push({ x: x + nx * 2.5, z: z + nz * 2.5, heading: 0, s: 0.9 + rnd() * 0.2 });
    }
  }
  // 指示牌：路口 + 地标周边
  const signSpots = [
    [-114.9, -570.4, '广场东路'], [500, -770, '星泽大道'], [1155.7, -994.9, '霓虹街'],
    [1390.3, -963.9, '星光里'], [1155.7, -600, '步行街'], [1155.7, -1400, '霓虹街'],
    [-500, -570.4, '广场西路'], [300, -570.4, '广场东路'],
  ];
  for (const [x, z, word] of signSpots) placements.sign.push({ x, z, heading: rnd() * Math.PI, s: 1, word });
  // 红绿灯：4 个路口
  const lightSpots = [[500, -762], [1141, -994.9], [-114.9, -556], [1390.3, -950]];
  for (const [x, z] of lightSpots) placements.light.push({ x, z, heading: rnd() * Math.PI * 2, s: 1 });
  // 地标广场街具：16 座 Phase-1 地标周边各 2 长椅 + 2 垃圾桶
  // （对照卡 LM01/LM03/LM05/LM07/LM09/LM11/LM14 等 F 项；坐标抄 data/six-names.json，
  // 环形摆在地标外 14m，避开地标本体）
  const LANDMARK_SPOTS = [
    [-1042.8, -344.9], [-1659.4, -1999.7], [-3884.7, -334.9], [-1636.4, 300.7],
    [17.2, 1047.9], [-1962.9, 1224.8], [-2555.7, -213.3], [1764.7, -2305.9],
    [-114.9, -570.4], [1390.3, -963.9], [-2089.3, -294.0], [2042.4, -2501.5],
    [2388.1, -3676.6], [-1707.3, -1808.4], [2492.5, -179.1], [1155.7, -994.9],
  ];
  for (const [lx, lz] of LANDMARK_SPOTS) {
    for (let k = 0; k < 2; k++) {
      const a = rnd() * Math.PI * 2;
      const bx = lx + Math.cos(a) * 14, bz = lz + Math.sin(a) * 14;
      placements.bench.push({ x: bx, z: bz, heading: a + Math.PI / 2, s: 0.9 + rnd() * 0.25 });
      placements.bin.push({ x: bx + Math.cos(a + 1) * 2.5, z: bz + Math.sin(a + 1) * 2.5, heading: 0, s: 0.9 + rnd() * 0.2 });
    }
  }

  const c = new THREE_.Color();
  const m = new THREE_.Matrix4();
  const q = new THREE_.Quaternion();
  const e = new THREE_.Euler();
  const v = new THREE_.Vector3();
  const sv = new THREE_.Vector3();
  const place = (mesh, list, colorFn) => {
    const colors = new Map();
    list.forEach((p, i) => {
      e.set(0, p.heading, 0); q.setFromEuler(e);
      v.set(p.x, groundY(p.x, p.z), p.z);
      sv.set(p.s, p.s, p.s);
      m.compose(v, q, sv);
      mesh.setMatrixAt(i, m);
      const hex = colorFn(p, i);
      mesh.setColorAt(i, c.setHex(hex));
      colors.set(i, hex);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    origInstanceColors.set(mesh.uuid, colors);
    mesh.frustumCulled = false;
    group.add(mesh);
  };

  // 长椅：座 + 靠背 + 两腿，合并成一个几何
  const benchGeo = mergeGeometries([
    box(1.9, 0.09, 0.55, 0, 0.46, 0),
    box(1.9, 0.5, 0.08, 0, 0.78, -0.26),
    box(0.08, 0.46, 0.5, -0.8, 0.23, 0),
    box(0.08, 0.46, 0.5, 0.8, 0.23, 0),
  ]);
  const bench = new THREE_.InstancedMesh(benchGeo, new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }), placements.bench.length);
  const benchCols = [0x6B4423, 0x4A5D23, 0x2A3358, 0x5B2E8B, 0x334155];
  place(bench, placements.bench, (p, i) => benchCols[i % benchCols.length]);

  // 垃圾桶：圆筒 + 盖
  const binGeo = mergeGeometries([
    cyl(0.32, 0.28, 0.85, 0, 0.43, 0, 10),
    cyl(0.34, 0.34, 0.06, 0, 0.88, 0, 10),
  ]);
  const bin = new THREE_.InstancedMesh(binGeo, new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.4 }), placements.bin.length);
  const binCols = [0x1B2340, 0x14532D, 0x3F3F46, 0x0F766E];
  place(bin, placements.bin, (p, i) => binCols[i % binCols.length]);

  // 指示牌：杆 + 牌（牌色按种子变，霓虹蓝/粉/青）
  const signGeo = mergeGeometries([
    cyl(0.05, 0.06, 2.6, 0, 1.3, 0),
    box(1.5, 0.45, 0.06, 0, 2.5, 0),
  ]);
  const sign = new THREE_.InstancedMesh(signGeo, new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }), placements.sign.length);
  const signCols = [0x00F0FF, 0xFF2E88, 0x8B5CFF, 0xFF9F1C];
  place(sign, placements.sign, (p, i) => signCols[i % signCols.length]);
  // 指示牌文字：4 块带通用字（其余只看色块，省 draw call）
  const signWords = ['星泽大道', '霓虹街', '步行街', '广场东路'];
  placements.sign.slice(0, 4).forEach((p, i) => {
    const tex = signTexture(signWords[i], '#00F0FF');
    const mat = new THREE_.MeshBasicMaterial({ map: tex, transparent: true });
    shopSignMats.push(mat);
    const plane = new THREE_.Mesh(new THREE_.PlaneGeometry(1.5, 0.38), mat);
    plane.position.set(p.x, groundY(p.x, p.z) + 2.5, p.z);
    plane.rotation.y = p.heading;
    group.add(plane);
    neonMeshes.push(plane);
  });

  // 红绿灯：杆 + 灯箱
  const lightGeo = mergeGeometries([
    cyl(0.06, 0.08, 4.2, 0, 2.1, 0),
    box(0.34, 0.95, 0.3, 0, 4.0, 0),
  ]);
  const light = new THREE_.InstancedMesh(lightGeo, new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.3 }), placements.light.length);
  place(light, placements.light, () => 0x1F2937);
  // 灯珠：每杆 3 颗，红/黄/绿按种子亮一颗（其余暗色）
  const dotGeo = new THREE_.SphereGeometry(0.09, 8, 6);
  const dots = new THREE_.InstancedMesh(dotGeo, new THREE_.MeshBasicMaterial({ color: 0xffffff }), placements.light.length * 3);
  const dotColors = new Map();
  placements.light.forEach((p, li) => {
    const lit = Math.floor(rnd() * 3); // 0 红 1 黄 2 绿
    const ys = [4.28, 4.0, 3.72];
    const cols = [0xFF2E2E, 0xFFB020, 0x22E07A];
    for (let k = 0; k < 3; k++) {
      const idx = li * 3 + k;
      const y = groundY(p.x, p.z);
      e.set(0, p.heading, 0); q.setFromEuler(e);
      v.set(p.x, y + ys[k], p.z + 0.16);
      sv.set(1, 1, 1);
      m.compose(v, q, sv);
      dots.setMatrixAt(idx, m);
      const hex = k === lit ? cols[k] : 0x222222;
      dots.setColorAt(idx, c.setHex(hex));
      dotColors.set(idx, hex);
    }
  });
  dots.instanceMatrix.needsUpdate = true;
  if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
  origInstanceColors.set(dots.uuid, dotColors);
  dots.frustumCulled = false;
  group.add(dots);
  neonMeshes.push(dots);
  return {
    bench: placements.bench.length, bin: placements.bin.length,
    sign: placements.sign.length, light: placements.light.length,
  };
}

// ---------- ③ 店面门面：主商业街一楼霓虹招牌 ----------
// 通用字，自己画；无任何真实品牌。
const SHOP_WORDS = ['面馆', '茶室', '书店', '花店', '甜品', '潮玩', '咖啡', '便利店', '拉面', '火锅', '奶茶', '理发'];
const SHOP_NEON = ['#FF2E88', '#00F0FF', '#8B5CFF', '#FF9F1C', '#FFD166', '#7DF9FF'];
function buildShops() {
  const THREE_ = ctx.THREE;
  const rnd = mulberry32(0x5EED);
  // 三条街：星熙路段（S1 末段）、星光里段（S2）、纵穿星熙路（S3 中段）
  const strips = [
    { a: [820, -881], b: [1155.7, -994.9], n: 8 },   // 星熙路
    { a: [1180, -994.9], b: [1390.3, -963.9], n: 4 }, // 星光里
    { a: [1155.7, -1250], b: [1155.7, -800], n: 6 },  // 纵街
  ];
  const shops = [];
  for (const st of strips) {
    const dx = st.b[0] - st.a[0], dz = st.b[1] - st.a[1];
    const len = Math.hypot(dx, dz);
    const nx = -dz / len, nz = dx / len;
    for (let i = 0; i < st.n; i++) {
      const t = (i + 0.5) / st.n;
      const side = (i % 2 === 0 ? 1 : -1) * 11;
      shops.push({
        x: st.a[0] + dx * t + nx * side,
        z: st.a[1] + dz * t + nz * side,
        heading: Math.atan2(dx, dz) + (side > 0 ? Math.PI / 2 : -Math.PI / 2),
        word: SHOP_WORDS[Math.floor(rnd() * SHOP_WORDS.length)],
        neon: SHOP_NEON[Math.floor(rnd() * SHOP_NEON.length)],
        w: 5.5 + rnd() * 2,
      });
    }
  }
  // 店体：InstancedMesh；雨棚：InstancedMesh；霓虹框：InstancedMesh（发光）
  const baseGeo = box(1, 1, 1, 0, 0.5, 0); // 单位盒，实例缩放成店面
  const base = new THREE_.InstancedMesh(baseGeo, new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }), shops.length);
  const awnGeo = box(1, 0.08, 1, 0, 0, 0.5);
  const awn = new THREE_.InstancedMesh(awnGeo, new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }), shops.length);
  // 霓虹框：顶条 + 两侧条合并
  const trimGeo = mergeGeometries([
    box(1, 0.12, 0.1, 0, 0.94, 0.52),
    box(0.12, 1, 0.1, -0.5, 0.5, 0.52),
    box(0.12, 1, 0.1, 0.5, 0.5, 0.52),
  ]);
  const trim = new THREE_.InstancedMesh(trimGeo, new THREE_.MeshBasicMaterial({ color: 0xffffff }), shops.length);
  const m = new THREE_.Matrix4();
  const q = new THREE_.Quaternion();
  const e = new THREE_.Euler();
  const v = new THREE_.Vector3();
  const sv = new THREE_.Vector3();
  const c = new THREE_.Color();
  const baseCols = new Map(), awnCols = new Map(), trimCols = new Map();
  const basePalette = [0x1B2340, 0x2A3358, 0x3A2A4A, 0x1F3A4A];
  shops.forEach((sh, i) => {
    const y = groundY(sh.x, sh.z);
    e.set(0, sh.heading, 0); q.setFromEuler(e);
    v.set(sh.x, y, sh.z); sv.set(sh.w, 4.2, 3.2);
    m.compose(v, q, sv);
    base.setMatrixAt(i, m);
    const bc = basePalette[i % basePalette.length];
    base.setColorAt(i, c.setHex(bc)); baseCols.set(i, bc);
    // 雨棚：斜出 1.2m
    v.set(sh.x, y + 3.0, sh.z); sv.set(sh.w, 1, 1.4);
    m.compose(v, q, sv);
    awn.setMatrixAt(i, m);
    const ac = [0xFF2E88, 0x00F0FF, 0x8B5CFF, 0xFF9F1C][i % 4];
    awn.setColorAt(i, c.setHex(ac)); awnCols.set(i, ac);
    // 霓虹框
    v.set(sh.x, y, sh.z); sv.set(sh.w, 4.2, 3.2);
    m.compose(v, q, sv);
    trim.setMatrixAt(i, m);
    trim.setColorAt(i, c.setHex(parseInt(sh.neon.slice(1), 16))); trimCols.set(i, parseInt(sh.neon.slice(1), 16));
    // 招牌：canvas 画的通用字，带灯箱进深（牌面凸出店面 0.15m）
    const tex = signTexture(sh.word, sh.neon);
    const mat = new THREE_.MeshBasicMaterial({ map: tex });
    shopSignMats.push(mat);
    const plane = new THREE_.Mesh(new THREE_.PlaneGeometry(sh.w * 0.8, 1.0), mat);
    const fx = Math.sin(sh.heading), fz = Math.cos(sh.heading);
    plane.position.set(sh.x + fx * 1.75, y + 3.7, sh.z + fz * 1.75);
    plane.rotation.y = sh.heading;
    group.add(plane);
    neonMeshes.push(plane);
    // 灯箱底板：发光面，门面有进深
    const glow = new THREE_.Mesh(
      new THREE_.PlaneGeometry(sh.w * 0.9, 2.2),
      new THREE_.MeshBasicMaterial({ color: new THREE_.Color(sh.neon), transparent: true, opacity: 0.28 }),
    );
    glow.position.set(sh.x + fx * 1.68, y + 1.6, sh.z + fz * 1.68);
    glow.rotation.y = sh.heading;
    group.add(glow);
    neonMeshes.push(glow);
  });
  for (const [mesh, map] of [[base, baseCols], [awn, awnCols], [trim, trimCols]]) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    origInstanceColors.set(mesh.uuid, map);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  neonMeshes.push(trim);
  return shops.length;
}

// ---------- ④ 行道树：Phase-1 五条街，一街一种树形 ----------
// 包里 13,674 棵树是 app.js 的单形小绿点（二十面体冠，近看没树样）。
// 本模块沿 Phase-1 五条街（STREET_SEGMENTS S1–S5）补种近景行道树：
// 同一条街两边同种成排，不同街道换种；种的区别只靠树形——
// S1 圆冠 / S2 尖塔 / S3 扁冠 / S4 小圆冠 / S5 柱形。
// 绿只用 app.js 已有的树绿色系（setHSL 0.29–0.35, 0.5–0.7, 0.32–0.46），
// 树干同款 0x6B4A2F；不自造新配色。间距 34m 与 app.js 行道树同款。
// 一环以外：本轮只做到 Phase-1 五条街；包里 13,674 棵远景树仍在，
// 一环以外近景分种是 Phase 2（路在分块 GLB 线几何里，见报告）。
const TREE_SPECIES = ['round', 'spire', 'flat', 'small', 'column'];
const TREE_FORM_NAME = { round: '圆冠', spire: '尖塔', flat: '扁冠', small: '小圆冠', column: '柱形' };
const TREE_SPACING = 34; // 与 app.js 行道树同款间距
const TREE_OFFSET = 8;   // 路中线两侧 8m（人行道外缘；行人走 4.5–7m，不挡路）
function buildTrees() {
  const THREE_ = ctx.THREE;
  const streets = STREET_SEGMENTS.filter((s) => !s.id.startsWith('X'));
  // 先算点位：每条街一种树形，两侧同种
  const perSpecies = { round: [], spire: [], flat: [], small: [], column: [] };
  const perStreet = {};
  streets.forEach((seg, si) => {
    const species = TREE_SPECIES[si % TREE_SPECIES.length];
    const rnd = mulberry32(0x7EE5 + si * 7919);
    const dx = seg.b[0] - seg.a[0], dz = seg.b[1] - seg.a[1];
    const len = Math.hypot(dx, dz);
    const nx = -dz / len, nz = dx / len;
    const n = Math.max(1, Math.floor(len / TREE_SPACING));
    const list = [];
    for (let i = 0; i <= n; i++) {
      const t = (i + 0.5) / n;
      for (const side of [-1, 1]) {
        const jx = (rnd() - 0.5) * 1.2, jz = (rnd() - 0.5) * 1.2;
        const x = seg.a[0] + dx * t + nx * side * TREE_OFFSET + jx;
        const z = seg.a[1] + dz * t + nz * side * TREE_OFFSET + jz;
        const p = { x, z, s: 0.85 + rnd() * 0.4, rot: rnd() * Math.PI * 2 };
        list.push(p);
        perSpecies[species].push(p);
      }
    }
    perStreet[seg.id] = { species, form: TREE_FORM_NAME[species], count: list.length };
  });
  // 树冠几何（原点在地面，树干高 2.4m 同款；冠形即种的区别）
  const canopyGeo = (species) => {
    let g;
    if (species === 'spire') { g = new THREE_.ConeGeometry(1.35, 4.4, 8); g.translate(0, 4.6, 0); }
    else if (species === 'flat') { g = new THREE_.IcosahedronGeometry(2.3, 0); g.scale(1, 0.42, 1); g.translate(0, 3.5, 0); }
    else if (species === 'small') { g = new THREE_.IcosahedronGeometry(1.25, 0); g.scale(1, 0.9, 1); g.translate(0, 3.1, 0); }
    else if (species === 'column') { g = new THREE_.CylinderGeometry(0.95, 1.05, 4.2, 8); g.translate(0, 4.5, 0); }
    else { g = new THREE_.IcosahedronGeometry(1.9, 0); g.scale(1, 0.82, 1); g.translate(0, 3.6, 0); } // 圆冠：app.js 同款
    return g;
  };
  const c = new THREE_.Color();
  const dummy = new THREE_.Object3D();
  // 树干：一个 InstancedMesh，全种共用（白底 + 实例色，走白膜切换）
  const total = Object.values(perSpecies).reduce((s, l) => s + l.length, 0);
  const trunkGeo = new THREE_.CylinderGeometry(0.22, 0.34, 2.4, 5);
  trunkGeo.translate(0, 1.2, 0);
  const trunks = new THREE_.InstancedMesh(trunkGeo, new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }), total);
  const trunkCols = new Map();
  let ti = 0;
  for (const list of Object.values(perSpecies)) {
    for (const p of list) {
      dummy.position.set(p.x, groundY(p.x, p.z), p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.s);
      dummy.updateMatrix();
      trunks.setMatrixAt(ti, dummy.matrix);
      trunks.setColorAt(ti, c.setHex(0x6B4A2F));
      trunkCols.set(ti, 0x6B4A2F);
      ti++;
    }
  }
  trunks.instanceMatrix.needsUpdate = true;
  if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
  origInstanceColors.set(trunks.uuid, trunkCols);
  trunks.frustumCulled = false;
  group.add(trunks);
  // 树冠：一种树形一个 InstancedMesh（5 个 draw call），绿用 app.js 同款 HSL 绿系
  const counts = {};
  for (const species of TREE_SPECIES) {
    const list = perSpecies[species];
    if (!list.length) continue;
    const mesh = new THREE_.InstancedMesh(
      canopyGeo(species),
      new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }),
      list.length,
    );
    const cols = new Map();
    const rnd = mulberry32(0xC010 + TREE_SPECIES.indexOf(species));
    list.forEach((p, i) => {
      dummy.position.set(p.x, groundY(p.x, p.z), p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      // app.js 同款：setHSL(0.29+rnd*0.06, 0.5+rnd*0.2, 0.32+rnd*0.14)
      c.setHSL(0.29 + rnd() * 0.06, 0.5 + rnd() * 0.2, 0.32 + rnd() * 0.14);
      mesh.setColorAt(i, c);
      cols.set(i, c.getHex()); // 存数字：setDisplay 恢复时 setHex(数字）
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    origInstanceColors.set(mesh.uuid, cols);
    mesh.frustumCulled = false;
    group.add(mesh);
    counts[species] = list.length;
  }
  return { total, perStreet, perSpecies: counts };
}

// ---------- ⑤ 红灯笼：青石双巷 / 灯影里 / 星光里 ----------
// 对照卡 LM06/LM17/LM25：F 在古街巷加红灯笼（自画通用形制，不抄任何实景）。
// 参考那边街面有红灯笼（配色表 S06 转述）；我们用自己的通用灯笼：
// 红球 + 金顶 + 穗子，两排对挂、中间拉线。白膜模式收起来（进 neonMeshes）。
const LANTERN_SPOTS = [
  { a: [-1716, 300.7], b: [-1556, 300.7], n: 10 },      // 青石双巷
  { a: [-1787, -1808.4], b: [-1627, -1808.4], n: 10 }, // 灯影里
  { a: [1180, -994.9], b: [1390.3, -963.9], n: 13 },   // 星光里（沿 S2）
];
function buildLanterns() {
  const THREE_ = ctx.THREE;
  const rnd = mulberry32(0x1A17);
  const lanterns = []; // {x, z} 挂点（线高 3.45m，灯挂线下）
  const wires = [];    // {x, z, heading} 拉线（横跨街道）
  for (const sp of LANTERN_SPOTS) {
    const dx = sp.b[0] - sp.a[0], dz = sp.b[1] - sp.a[1];
    const len = Math.hypot(dx, dz);
    const nx = -dz / len, nz = dx / len;
    for (let i = 0; i < sp.n; i++) {
      const t = (i + 0.5) / sp.n;
      const cx = sp.a[0] + dx * t, cz = sp.a[1] + dz * t;
      wires.push({ x: cx, z: cz, heading: Math.atan2(nx, nz) });
      for (const side of [-1, 1]) {
        lanterns.push({ x: cx + nx * side * 3, z: cz + nz * side * 3 });
      }
    }
  }
  const c = new THREE_.Color();
  const dummy = new THREE_.Object3D();
  // 拉线：细暗盒，横跨街道（+1 draw call）
  const wireGeo = new THREE_.BoxGeometry(0.05, 0.05, 7);
  const wireMesh = new THREE_.InstancedMesh(wireGeo, new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), wires.length);
  const wireCols = new Map();
  wires.forEach((w, i) => {
    dummy.position.set(w.x, groundY(w.x, w.z) + 3.45, w.z);
    dummy.rotation.set(0, w.heading, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    wireMesh.setMatrixAt(i, dummy.matrix);
    wireMesh.setColorAt(i, c.setHex(0x2A2A2E));
    wireCols.set(i, 0x2A2A2E);
  });
  wireMesh.instanceMatrix.needsUpdate = true;
  if (wireMesh.instanceColor) wireMesh.instanceColor.needsUpdate = true;
  origInstanceColors.set(wireMesh.uuid, wireCols);
  wireMesh.frustumCulled = false;
  group.add(wireMesh);
  // 灯笼：红球 + 金顶 + 穗子合并成一个几何（原点在挂线处，灯身垂在线下）
  const ballGeo = new THREE_.SphereGeometry(0.3, 10, 8);
  ballGeo.scale(1, 0.82, 1);
  ballGeo.translate(0, -0.35, 0);
  const lanternGeo = mergeGeometries([
    ballGeo,
    cyl(0.08, 0.08, 0.06, 0, -0.03, 0, 6),
    cyl(0.06, 0.06, 0.05, 0, -0.62, 0, 6),
    box(0.05, 0.18, 0.02, 0, -0.73, 0),
  ]);
  const lanternMesh = new THREE_.InstancedMesh(
    lanternGeo,
    new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0xFF2A00, emissiveIntensity: 0.35 }),
    lanterns.length,
  );
  const lanternCols = new Map();
  const reds = [0xD9382B, 0xC22E22, 0xE8402F];
  lanterns.forEach((p, i) => {
    dummy.position.set(p.x, groundY(p.x, p.z) + 3.45, p.z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
    dummy.scale.setScalar(0.9 + rnd() * 0.25);
    dummy.updateMatrix();
    lanternMesh.setMatrixAt(i, dummy.matrix);
    const hex = reds[Math.floor(rnd() * reds.length)];
    lanternMesh.setColorAt(i, c.setHex(hex));
    lanternCols.set(i, hex);
  });
  lanternMesh.instanceMatrix.needsUpdate = true;
  if (lanternMesh.instanceColor) lanternMesh.instanceColor.needsUpdate = true;
  origInstanceColors.set(lanternMesh.uuid, lanternCols);
  lanternMesh.frustumCulled = false;
  group.add(lanternMesh);
  neonMeshes.push(lanternMesh); // 白膜收起来；拉线留着（街具）
  return { lanterns: lanterns.length, wires: wires.length };
}

// ---------- ⑥ 地标周边街面：16 座 Phase-1 地标门口细节 ----------
// 对照卡 LM01/LM02/LM03/LM05/LM06/LM07/LM09/LM11/LM12/LM14/LM17/LM18/LM20/LM21/LM22/LM25
// 的 F 项（街面）：每座门口铺装变化（形状/颜色/尺寸逐座不同）、路边花坛/花箱、
// 街角小品；长椅/垃圾桶按地标入口朝向逐座校对位置——朝向门口、避开铺装和花坛，
// 距离/角度/朝向每座都不同，不许整片复制粘贴（buildFurniture 里的地标环是统一
// 14m 环形，本段是逐座校对的第二套）。
// 配色按配色表 §4（游戏画面风格）：铺装冷灰蓝/暖石/砖红各档拉开，霓虹只用
// §4 四色。坐标抄 data/six-names.json（虚构名）。
const LANDMARK_STREETS = [
  { id: 'LM01', x: -1042.8, z: -344.9, pave: 'disc', paveColor: 0x8A93B8, flower: 0xFF2E88, orn: 'ball' },    // 望星公园
  { id: 'LM02', x: 1155.7, z: -994.9, pave: 'square', paveColor: 0xC9B18C, flower: 0xFF9F1C, orn: 'pillar' }, // 星熙路
  { id: 'LM03', x: -1659.4, z: -1999.7, pave: 'disc', paveColor: 0x7A4A3A, flower: 0xE8402F, orn: 'lantern' }, // 凌霄祠
  { id: 'LM05', x: -3884.7, z: -334.9, pave: 'disc', paveColor: 0x7A8B7A, flower: 0xFFF6E0, orn: 'lantern' },  // 听涛草堂
  { id: 'LM06', x: -1636.4, z: 300.7, pave: 'square', paveColor: 0xA8B8D8, flower: 0xE8402F, orn: 'lantern' }, // 青石双巷
  { id: 'LM07', x: 17.2, z: 1047.9, pave: 'disc', paveColor: 0x5B6B8C, flower: 0xFFD166, orn: 'lantern' },     // 云林禅院
  { id: 'LM09', x: -1962.9, z: 1224.8, pave: 'square', paveColor: 0x9A7B8C, flower: 0xFFF6E0, orn: 'lantern' }, // 青石陵
  { id: 'LM11', x: -2555.7, z: -213.3, pave: 'disc', paveColor: 0x6B7A8C, flower: 0x8B5CFF, orn: 'lantern' },   // 紫气宫
  { id: 'LM12', x: 1764.7, z: -2305.9, pave: 'square', paveColor: 0x2C3E66, flower: 0x00F0FF, orn: 'pillar' }, // 霓虹桥
  { id: 'LM14', x: -114.9, z: -570.4, pave: 'disc', paveColor: 0xC2A878, flower: 0xFF2E88, orn: 'ball' },     // 星泽广场
  { id: 'LM17', x: 1390.3, z: -963.9, pave: 'square', paveColor: 0xB89A6A, flower: 0xE8402F, orn: 'pillar' },  // 星光里
  { id: 'LM18', x: 2492.5, z: -179.1, pave: 'disc', paveColor: 0x46589E, flower: 0x00F0FF, orn: 'pillar' },    // 揽星塔
  { id: 'LM20', x: -2089.3, z: -294.0, pave: 'square', paveColor: 0x8C7A5B, flower: 0xFFD166, orn: 'pillar' }, // 琴韵路
  { id: 'LM21', x: 2042.4, z: -2501.5, pave: 'disc', paveColor: 0x7A6B8C, flower: 0xFF9F1C, orn: 'pillar' },   // 九虹桥
  { id: 'LM22', x: 2388.1, z: -3676.6, pave: 'square', paveColor: 0x6B8C7A, flower: 0xFF2E88, orn: 'lantern' }, // 望星楼
  { id: 'LM25', x: -1707.3, z: -1808.4, pave: 'disc', paveColor: 0xA88C6B, flower: 0xE8402F, orn: 'lantern' }, // 灯影里
];
function buildLandmarkStreets() {
  const THREE_ = ctx.THREE;
  const c = new THREE_.Color();
  const dummy = new THREE_.Object3D();
  const discs = [], squares = [], planters = [], puffs = [];
  const lanterns = [], balls = [], pillars = [], benches = [], bins = [];
  const planterCols = [0x6B4423, 0x4A5D23, 0x2A3358, 0x334155];
  const benchCols = [0x6B4423, 0x4A5D23, 0x2A3358, 0x5B2E8B, 0x334155];
  const binCols = [0x1B2340, 0x14532D, 0x3F3F46, 0x0F766E];
  const pillarCols = [0x00F0FF, 0xFF2E88, 0x8B5CFF, 0xFF9F1C];
  LANDMARK_STREETS.forEach((lm, li) => {
    const rnd = mulberry32(0x1A9D + li * 104729);
    const th = rnd() * Math.PI * 2; // 入口朝向（逐座不同，种子定死）
    const ex = Math.cos(th), ez = Math.sin(th);
    const px = -ez, pz = ex; // 入口方向的法向
    const cx = lm.x + ex * 9, cz = lm.z + ez * 9; // 门口铺装中心
    const paveSize = 10 + rnd() * 6; // 铺装直径 10–16m，逐座不同
    if (lm.pave === 'disc') discs.push({ x: cx, z: cz, rot: rnd() * Math.PI, sx: paveSize / 2, sy: 1, sz: paveSize / 2, color: lm.paveColor });
    else squares.push({ x: cx, z: cz, rot: rnd() * Math.PI, sx: paveSize, sy: 1, sz: paveSize * 0.85, color: lm.paveColor });
    // 花箱：3 只，沿铺装边一字排开，每只旋转/缩放/箱色不同，花色逐只变
    for (let k = -1; k <= 1; k++) {
      const bx = cx + px * k * 3.4 + (rnd() - 0.5) * 1.2;
      const bz = cz + pz * k * 3.4 + (rnd() - 0.5) * 1.2;
      planters.push({ x: bx, z: bz, rot: th + (rnd() - 0.5) * 0.35, sx: 0.9 + rnd() * 0.3, sy: 0.9 + rnd() * 0.3, sz: 0.9 + rnd() * 0.3, color: planterCols[(li + k + 4) % planterCols.length] });
      puffs.push({ x: bx, z: bz, rot: rnd() * Math.PI * 2, sx: 0.8 + rnd() * 0.5, sy: 0.8 + rnd() * 0.5, sz: 0.8 + rnd() * 0.5, color: k === 0 ? lm.flower : (k < 0 ? 0xFFF6E0 : lm.flower) });
    }
    // 街角小品：入口外侧 15m 处 1 件（公园/广场类再加 2 丛花）
    const ox = lm.x + ex * 15, oz = lm.z + ez * 15;
    if (lm.orn === 'lantern') lanterns.push({ x: ox, z: oz, rot: rnd() * Math.PI * 2, sx: 0.9 + rnd() * 0.3, sy: 0.9 + rnd() * 0.3, sz: 0.9 + rnd() * 0.3, color: 0x8C8C96 });
    else if (lm.orn === 'ball') {
      balls.push({ x: ox, z: oz, rot: 0, sx: 0.9 + rnd() * 0.3, sy: 0.9 + rnd() * 0.3, sz: 0.9 + rnd() * 0.3, color: 0x9AA3B8 });
      puffs.push({ x: ox + 1.6, z: oz + 0.8, rot: 0, sx: 1.1, sy: 1.1, sz: 1.1, color: lm.flower });
      puffs.push({ x: ox - 1.2, z: oz + 1.4, rot: 0, sx: 0.9, sy: 0.9, sz: 0.9, color: 0xFFF6E0 });
    } else pillars.push({ x: ox, z: oz, rot: rnd() * Math.PI, sx: 1, sy: 0.9 + rnd() * 0.3, sz: 1, color: pillarCols[li % pillarCols.length] });
    // 长椅/垃圾桶逐座校对：朝向地标门口、距离 11–17m 不等、角度带 jitter，
    // 垃圾桶在长椅侧边 2.2m，不与铺装/花箱重叠
    const ba = th + (rnd() - 0.5) * 1.4;
    const bd = 11 + rnd() * 6;
    const bx = lm.x + Math.cos(ba) * bd, bz = lm.z + Math.sin(ba) * bd;
    const heading = Math.atan2(lm.x - bx, lm.z - bz) + (rnd() - 0.5) * 0.25;
    benches.push({ x: bx, z: bz, rot: heading, sx: 0.9 + rnd() * 0.25, sy: 0.9 + rnd() * 0.25, sz: 0.9 + rnd() * 0.25, color: benchCols[li % benchCols.length] });
    const nx = Math.cos(heading + Math.PI / 2), nz = Math.sin(heading + Math.PI / 2);
    bins.push({ x: bx + nx * 2.2, z: bz + nz * 2.2, rot: 0, sx: 0.9 + rnd() * 0.2, sy: 0.9 + rnd() * 0.2, sz: 0.9 + rnd() * 0.2, color: binCols[li % binCols.length] });
  });
  const place = (mesh, list) => {
    const colors = new Map();
    list.forEach((p, i) => {
      dummy.position.set(p.x, groundY(p.x, p.z), p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.set(p.sx, p.sy, p.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, c.setHex(p.color));
      colors.set(i, p.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    origInstanceColors.set(mesh.uuid, colors);
    mesh.frustumCulled = false;
    group.add(mesh);
  };
  const std = () => new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
  // 门口铺装：圆盘 / 方砖两档（几何原点在地面，实例缩放定尺寸）
  const discGeo = new THREE_.CylinderGeometry(1, 1, 0.08, 24);
  discGeo.translate(0, 0.04, 0);
  const disc = new THREE_.InstancedMesh(discGeo, std(), discs.length);
  place(disc, discs);
  const sqGeo = new THREE_.BoxGeometry(1, 0.08, 1);
  sqGeo.translate(0, 0.04, 0);
  const square = new THREE_.InstancedMesh(sqGeo, std(), squares.length);
  place(square, squares);
  // 花箱 + 花丛
  const planterGeo = new THREE_.BoxGeometry(1.2, 0.5, 0.5);
  planterGeo.translate(0, 0.25, 0);
  const planter = new THREE_.InstancedMesh(planterGeo, std(), planters.length);
  place(planter, planters);
  const puffGeo = new THREE_.IcosahedronGeometry(0.34, 0);
  puffGeo.scale(1, 0.62, 1);
  puffGeo.translate(0, 0.62, 0);
  const puff = new THREE_.InstancedMesh(puffGeo, new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), puffs.length);
  place(puff, puffs);
  // 街角小品三档：石灯（古建类）/ 石球（公园广场类）/ 霓虹柱（现代商业类）
  const roof = cyl(0.02, 0.42, 0.22, 0, 1.1, 0, 4);
  roof.rotateY(Math.PI / 4);
  const lanternGeo = mergeGeometries([
    box(0.55, 0.14, 0.55, 0, 0.07, 0),
    box(0.2, 0.55, 0.2, 0, 0.42, 0),
    box(0.34, 0.3, 0.34, 0, 0.84, 0),
    roof,
  ]);
  const lantern = new THREE_.InstancedMesh(lanternGeo, std(), lanterns.length);
  place(lantern, lanterns);
  const ballGeo = mergeGeometries([
    box(0.9, 0.25, 0.9, 0, 0.125, 0),
    (() => { const s = new THREE_.SphereGeometry(0.42, 12, 8); s.translate(0, 0.67, 0); return s; })(),
  ]);
  const ball = new THREE_.InstancedMesh(ballGeo, std(), balls.length);
  place(ball, balls);
  const pillarGeo = new THREE_.BoxGeometry(0.18, 2.3, 0.18);
  pillarGeo.translate(0, 1.15, 0);
  const pillar = new THREE_.InstancedMesh(pillarGeo, new THREE_.MeshBasicMaterial({ color: 0xffffff }), pillars.length);
  place(pillar, pillars);
  neonMeshes.push(pillar); // 霓虹柱：白膜模式收起来
  // 逐座校对的长椅 / 垃圾桶（与 buildFurniture 的统一环形是两套）
  const benchGeo = mergeGeometries([
    box(1.9, 0.09, 0.55, 0, 0.46, 0),
    box(1.9, 0.5, 0.08, 0, 0.78, -0.26),
    box(0.08, 0.46, 0.5, -0.8, 0.23, 0),
    box(0.08, 0.46, 0.5, 0.8, 0.23, 0),
  ]);
  const bench = new THREE_.InstancedMesh(benchGeo, std(), benches.length);
  place(bench, benches);
  const binGeo = mergeGeometries([
    cyl(0.32, 0.28, 0.85, 0, 0.43, 0, 10),
    cyl(0.34, 0.34, 0.06, 0, 0.88, 0, 10),
  ]);
  const bin = new THREE_.InstancedMesh(binGeo, new THREE_.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.4 }), bins.length);
  place(bin, bins);
  return {
    landmarks: LANDMARK_STREETS.length,
    paving: { disc: discs.length, square: squares.length },
    planters: planters.length, puffs: puffs.length,
    ornaments: { lantern: lanterns.length, ball: balls.length, pillar: pillars.length },
    bench: benches.length, bin: bins.length,
  };
}

function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
  lastT = now;
  if (ctx && ctx.state && lampGlow) {
    const night = ctx.state.night ?? 0;
    const on = displayMode !== 'white';
    // 夜里全部实灯亮、白天不亮；白天霓虹亮度降 40% 但不断（方案 §3.10⑤）
    lampGlow.material.opacity = on ? night * 0.9 : 0;
    lampHeads.material.opacity = on ? 0.12 + night * 0.88 : 0;
    const dim = on ? 0.6 + 0.4 * night : 0.6;
    for (const mat of shopSignMats) mat.color.setScalar(dim);
  }
  rafId = requestAnimationFrame(tick);
}

export function init(c) {
  ctx = c;
  group = new ctx.THREE.Group();
  group.name = 'surpass-street';
  ctx.scene.add(group);
  const lamps = buildLamps();
  const furniture = buildFurniture();
  const shops = buildShops();
  const trees = buildTrees();
  const lanterns = buildLanterns();
  const landmarkStreets = buildLandmarkStreets();
  lastT = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
  const samples = routeSamples(100);
  window.__street = {
    group,
    get lamps() { return lampCount; },
    furniture,
    shops,
    trees,
    lanterns,
    landmarkStreets,
    route: samples,
    routeWaypoints: ROUTE_WAYPOINTS,
    refreshLamps: harvestLamps,
  };
  return { group, get lamps() { return lampCount; }, furniture, shops, trees, lanterns, landmarkStreets, route: samples };
}

export function setDisplay(mode) {
  displayMode = mode;
  if (!group) return;
  const c = new THREE.Color();
  if (mode === 'white') {
    // 白膜：霓虹收起来，全部变回白膜
    for (const [uuid, map] of origInstanceColors) {
      let mesh = null;
      group.traverse((o) => { if (o.uuid === uuid) mesh = o; });
      if (!mesh || !mesh.setColorAt) continue;
      for (const [i, hex] of map) mesh.setColorAt(+i, c.setHex(0xffffff));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const m of neonMeshes) m.visible = false;
    if (lampGlow) lampGlow.material.opacity = 0;
  } else {
    for (const [uuid, map] of origInstanceColors) {
      let mesh = null;
      group.traverse((o) => { if (o.uuid === uuid) mesh = o; });
      if (!mesh || !mesh.setColorAt) continue;
      for (const [i, hex] of map) mesh.setColorAt(+i, c.setHex(hex));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const m of neonMeshes) m.visible = true;
  }
}
