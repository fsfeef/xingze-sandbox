// people.js — F 路：程序化行人（原创通用角色，全程序化，不用 Mixamo）
// 方案 §3.13 / 验收表第 14 行。游戏画面风格 · 星泽市。
// 做法：three-procedural-locomotion 的思路（逐帧由速度/朝向算步态：摆臂、迈腿、
// 身体起伏），但不用它的库——仓库里没有骨骼模型可供驱动，行人是程序化拼装体，
// 步态直接写在每帧的矩阵里。Mixamo 资产未用：仓库内无任何 FBX 资产，Mixamo
// 下载需账号登录，无法在 headless 环境核实许可；全程序化即零许可风险。
// 性能：全身 9 个 InstancedMesh（躯干/头/短发/长发/左腿/右腿/左臂/右臂/眼睛
// + 1 个霓虹胸条 = 10 个 draw call），64 个行人（48 人原拨 + 16 人街头生活拨）
// 每人种子不同，衣服/发型/肤色/身高/步速/步幅全按种子变，绝无 5 个一模一样的行人排一列。
// 第二拨道具另 3 个 draw call（狗/菜篮/手机各 1 个 InstancedMesh）。
// 绝不是胶囊人：头（球）+ 头发 + 眼睛 + 躯干（上衣）+ 双臂 + 双腿 + 鞋，近看有人样。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------- 种子随机（确定性：同一行人每次加载同一个样子） ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 街道（人行道）-----------
// 地名按 data/six-names.json 虚构名。S1 星泽广场→星熙路，S2 星熙路→星光里，
// S3 纵穿星熙路，S4 横穿星泽广场，S5 纵穿星光里；X1/X2 是路口斑马线横穿段。
export const STREET_SEGMENTS = [
  { id: 'S1', a: [-114.9, -570.4], b: [1155.7, -994.9], weight: 14 },
  { id: 'S2', a: [1155.7, -994.9], b: [1390.3, -963.9], weight: 6 },
  { id: 'S3', a: [1155.7, -1400], b: [1155.7, -600], weight: 10 },
  { id: 'S4', a: [-500, -570.4], b: [300, -570.4], weight: 6 },
  { id: 'S5', a: [1390.3, -1200], b: [1390.3, -700], weight: 6 },
  { id: 'X1', a: [500, -790], b: [500, -762], weight: 3 },   // 斑马线：横穿 S1
  { id: 'X2', a: [1141, -994.9], b: [1170, -994.9], weight: 3 }, // 斑马线：横穿 S3
];

const SKINS = [0xE8B98F, 0xD9A06B, 0xC98A5A, 0xF0C8A0, 0xB97A4E];
const JACKETS = [0x1B2340, 0x274B63, 0x8B2E5E, 0xC75B12, 0x3A3F4A, 0x5B2E8B, 0x1F6B4A, 0xA83232, 0x2A3358, 0x0F766E, 0x7A1F3D, 0x334155];
const PANTS = [0x1E293B, 0x334155, 0x3F3F46, 0x1B2340, 0x44403C, 0x292524];
const HAIRS = [0x14100C, 0x3B2314, 0x6B4423, 0x9A9A9A, 0x00F0FF, 0xFF2E88]; // 最后两色是游戏画面风格染发，少数
const NEON = [0xFF2E88, 0x00F0FF, 0x8B5CFF, 0xFF9F1C];

const COUNT = 48;
const LIFE_COUNT = 16; // 第二拨：街头生活行人（遛狗 4 / 买菜 4 / 等车 4 / 看手机 4）
const TOTAL = COUNT + LIFE_COUNT; // 64：48 人原样不动，后面追加 16 人

let ctx = null;
let group = null;
let parts = null;      // { torso, head, hairCap, hairLong, legL, legR, armL, armR, eyes, accent }
let props = null;      // 第二拨道具 { dog, bag, phone }（各一个 InstancedMesh）
let propOrigColors = null; // 白膜恢复用：道具每实例的原色
let pedestrians = [];
let rafId = 0;
let lastT = 0;
let displayMode = 'normal';
let origColors = null; // white 模式恢复用：每部件每实例的原色

function groundY(x, z) {
  try {
    if (ctx && ctx.sixLoader && ctx.sixLoader.groundHeightAt) return ctx.sixLoader.groundHeightAt(x, z);
  } catch (e) { /* fall through */ }
  return 3.0;
}

function segPoint(seg, t, side) {
  const dx = seg.b[0] - seg.a[0], dz = seg.b[1] - seg.a[1];
  const len = Math.hypot(dx, dz);
  const nx = -dz / len, nz = dx / len; // 法向（人行道偏移方向）
  const x = seg.a[0] + dx * t + nx * side;
  const z = seg.a[1] + dz * t + nz * side;
  return { x, z, heading: Math.atan2(dx, dz) };
}

function buildPedestrians() {
  pedestrians = [];
  // 按 weight 分配人数
  const totalW = STREET_SEGMENTS.reduce((s, g) => s + g.weight, 0);
  let idx = 0;
  for (const seg of STREET_SEGMENTS) {
    const n = Math.max(2, Math.round((seg.weight / totalW) * COUNT));
    for (let i = 0; i < n && idx < COUNT; i++, idx++) {
      const rnd = mulberry32(0x9E3779B9 + idx * 7919);
      const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
      pedestrians.push({
        seed: idx,
        seg,
        t: rnd(),                       // 沿街位置
        dir: rnd() < 0.5 ? 1 : -1,       // 往返方向
        side: (rnd() < 0.5 ? -1 : 1) * (4.5 + rnd() * 2.5), // 人行道一侧
        speed: 0.9 + rnd() * 0.6,        // 0.9–1.5 m/s
        phase: rnd() * Math.PI * 2,
        stride: 0.5 + rnd() * 0.18,      // 摆腿幅度
        armSwing: 0.32 + rnd() * 0.18,
        scale: 0.92 + rnd() * 0.16,      // 身高 1.58–1.86m
        skin: SKINS[Math.floor(rnd() * SKINS.length)],
        jacket: JACKETS[Math.floor(rnd() * JACKETS.length)],
        pants: PANTS[Math.floor(rnd() * PANTS.length)],
        hair: HAIRS[Math.floor(rnd() * HAIRS.length)],
        hairLong: rnd() < 0.35,          // 长发 35%
        neon: rnd() < 0.45 ? NEON[Math.floor(rnd() * NEON.length)] : 0, // 45% 有霓虹胸条
        heading: 0,
        x: 0, z: 0, y: 0,
        bob: 0,
        headYaw: 0, // 头预判转向（three-procedural-locomotion：头/胸先于脚转向）
      });
    }
  }
  // 补齐到 COUNT（上面取整可能少 1–2 个）
  while (pedestrians.length < COUNT) {
    const seg = STREET_SEGMENTS[0];
    const rnd = mulberry32(1234 + pedestrians.length * 31);
    pedestrians.push({
      seed: pedestrians.length, seg, t: rnd(), dir: 1, side: 5 + rnd() * 2,
      speed: 1.0 + rnd() * 0.4, phase: rnd() * 6.28, stride: 0.55, armSwing: 0.38,
      scale: 0.95 + rnd() * 0.1, skin: SKINS[0], jacket: JACKETS[0], pants: PANTS[0],
      hair: HAIRS[0], hairLong: false, neon: 0, heading: 0, x: 0, z: 0, y: 0, bob: 0, headYaw: 0,
    });
  }
  for (const p of pedestrians) {
    const pt = segPoint(p.seg, p.t, p.side);
    p.x = pt.x; p.z = pt.z; p.y = groundY(pt.x, pt.z);
    p.heading = pt.heading + (p.dir < 0 ? Math.PI : 0);
  }
  // ---- 第二拨：街头生活行人（16 人；48 人原样不动，在后面追加） ----
  // 姿态四种：遛狗（牵狗慢走）、买菜（提菜篮慢走）、等车（路边站着、四处张望）、
  // 看手机（低头、单手举手机慢走）。每人种子不同，衣服/发型/肤色/身高/步速全变，
  // 绝无 5 个一模一样的排一列；道具（狗/菜篮/手机）也是程序化拼装，不是胶囊人。
  const segById = Object.fromEntries(STREET_SEGMENTS.map((s) => [s.id, s]));
  const lifeKinds = [
    ...['S1', 'S2', 'S3', 'S5'].map((segId) => ({ life: 'dog', segId })),
    ...['S1', 'S3', 'S4', 'S2'].map((segId) => ({ life: 'bag', segId })),
    ...['S2', 'S3', 'S5', 'S1'].map((segId) => ({ life: 'phone', segId })),
    ...['S1', 'S3', 'S2', 'S4'].map((segId) => ({ life: 'wait', segId })),
  ];
  const DOG_COATS = [0x8B5A2B, 0x2A2A2E, 0xD9C8A8, 0x6B4423];
  const BAG_COLS = [0xC75B12, 0x1F6B4A, 0x8B2E5E, 0x274B63];
  const WAIT_T = [0.5, 0.3, 0.5, 0.7]; // 4 个等车人的固定站位（沿街位置）
  lifeKinds.forEach((def, k) => {
    const idx = pedestrians.length;
    const rnd = mulberry32(0x11FE + idx * 104729);
    const seg = segById[def.segId];
    const p = {
      seed: idx, seg,
      t: def.life === 'wait' ? WAIT_T[k - 12] : rnd(),
      dir: rnd() < 0.5 ? 1 : -1,
      side: (rnd() < 0.5 ? -1 : 1) * (4.5 + rnd() * 2.5),
      speed: def.life === 'dog' ? 0.7 + rnd() * 0.3 : def.life === 'bag' ? 0.8 + rnd() * 0.3 : def.life === 'phone' ? 0.6 + rnd() * 0.25 : 0,
      phase: rnd() * Math.PI * 2,
      stride: 0.5 + rnd() * 0.18,
      armSwing: 0.32 + rnd() * 0.18,
      scale: 0.92 + rnd() * 0.16,
      skin: SKINS[Math.floor(rnd() * SKINS.length)],
      jacket: JACKETS[Math.floor(rnd() * JACKETS.length)],
      pants: PANTS[Math.floor(rnd() * PANTS.length)],
      hair: HAIRS[Math.floor(rnd() * HAIRS.length)],
      hairLong: rnd() < 0.35,
      neon: rnd() < 0.45 ? NEON[Math.floor(rnd() * NEON.length)] : 0,
      heading: 0, x: 0, z: 0, y: 0, bob: 0, headYaw: 0,
      life: def.life,
      dogColor: DOG_COATS[k % DOG_COATS.length],
      dogScale: 0.7 + rnd() * 0.5,
      bagColor: BAG_COLS[k % BAG_COLS.length],
      bagSide: rnd() < 0.5 ? -1 : 1,
      waitPhone: def.life === 'wait' && (k % 2 === 0), // 4 个等车人里 2 个低头看手机
    };
    if (def.life === 'wait') { p.side = (k % 2 === 0 ? 1 : -1) * 6; p.dir = 1; }
    pedestrians.push(p);
    const pt = segPoint(p.seg, p.t, p.side);
    p.x = pt.x; p.z = pt.z; p.y = groundY(pt.x, pt.z);
    p.heading = pt.heading + (p.dir < 0 ? Math.PI : 0);
  });
  // 道具序号（狗/菜篮/手机各一个 InstancedMesh，按 life 拨内序号排）
  let _d = 0, _b = 0, _p = 0;
  for (const p of pedestrians) {
    if (p.life === 'dog') p.propIndex = _d++;
    else if (p.life === 'bag') p.propIndex = _b++;
    else if (p.life === 'phone' || (p.life === 'wait' && p.waitPhone)) p.propIndex = _p++;
  }
}

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function buildMeshes() {
  const THREE_ = ctx.THREE;
  group = new THREE_.Group();
  group.name = 'surpass-people';

  // 腿：盒 + 鞋合并，几何原点在髋关节（绕髋摆动）
  const legGeo = mergeGeometries([
    box(0.14, 0.82, 0.16, 0, -0.41, 0),
    box(0.15, 0.08, 0.30, 0, -0.82, 0.05),
  ]);
  // 臂：几何原点在肩关节
  const armGeo = box(0.10, 0.62, 0.12, 0, -0.31, 0);
  const torsoGeo = new THREE_.BoxGeometry(0.44, 0.58, 0.26);
  const headGeo = new THREE_.SphereGeometry(0.115, 14, 10);
  const hairCapGeo = new THREE_.SphereGeometry(0.125, 12, 8, 0, Math.PI * 2, 0, 1.25);
  // 发盖下沿 θ=1.25rad（≈72°）：眼睛在 θ≈85° 处，下沿停在眼睛上方，不盖眼。
  // 之前 1.9rad（≈109°）下沿盖到眼下，眼睛被发盖遮住。
  hairCapGeo.scale(1, 0.9, 1);
  const hairLongGeo = box(0.26, 0.36, 0.10, 0, -0.10, -0.09);
  const eyeGeo = new THREE_.SphereGeometry(0.016, 6, 5);
  const accentGeo = new THREE_.BoxGeometry(0.46, 0.05, 0.28);

  const mat = (color, opts = {}) => new THREE_.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...opts });
  const mk = (geo, material, count) => {
    const m = new THREE_.InstancedMesh(geo, material, count);
    m.instanceMatrix.setUsage(THREE_.DynamicDrawUsage);
    m.frustumCulled = false;
    group.add(m);
    return m;
  };
  parts = {
    torso: mk(torsoGeo, mat(0xffffff), TOTAL),
    head: mk(headGeo, mat(0xffffff), TOTAL),
    hairCap: mk(hairCapGeo, mat(0xffffff), TOTAL),
    hairLong: mk(hairLongGeo, mat(0xffffff), TOTAL),
    legL: mk(legGeo, mat(0xffffff), TOTAL),
    legR: mk(legGeo, mat(0xffffff), TOTAL),
    armL: mk(armGeo, mat(0xffffff), TOTAL),
    armR: mk(armGeo, mat(0xffffff), TOTAL),
    eyes: mk(eyeGeo, new THREE_.MeshBasicMaterial({ color: 0x111111 }), TOTAL * 2),
    accent: mk(accentGeo, new THREE_.MeshBasicMaterial({ color: 0xffffff }), TOTAL),
  };

  // 第二拨道具：狗 / 菜篮 / 手机（程序化拼装，近看有物；原点说明见各几何）
  // 狗：身 + 头 + 嘴 + 双耳 + 四腿 + 竖尾，原点在地面中心，朝向 +Z。
  const dogGeo = mergeGeometries([
    box(0.18, 0.2, 0.44, 0, 0.32, 0),
    box(0.16, 0.16, 0.18, 0, 0.44, 0.28),
    box(0.08, 0.08, 0.12, 0, 0.4, 0.4),
    box(0.05, 0.1, 0.05, -0.06, 0.54, 0.26),
    box(0.05, 0.1, 0.05, 0.06, 0.54, 0.26),
    box(0.05, 0.22, 0.05, -0.07, 0.11, 0.14),
    box(0.05, 0.22, 0.05, 0.07, 0.11, 0.14),
    box(0.05, 0.22, 0.05, -0.07, 0.11, -0.14),
    box(0.05, 0.22, 0.05, 0.07, 0.11, -0.14),
    box(0.04, 0.2, 0.04, 0, 0.42, -0.26),
  ]);
  // 菜篮：袋身 + 双提手，原点在提手握点，袋身垂在下方。
  const bagGeo = mergeGeometries([
    box(0.22, 0.34, 0.12, 0, -0.28, 0),
    box(0.02, 0.14, 0.02, -0.07, -0.06, 0),
    box(0.02, 0.14, 0.02, 0.07, -0.06, 0),
    box(0.16, 0.02, 0.02, 0, 0.01, 0),
  ]);
  // 手机：小方块，亮屏（Basic 材质本色发光）。
  const phoneGeo = new THREE_.BoxGeometry(0.07, 0.14, 0.015);
  props = {
    dog: mk(dogGeo, mat(0xffffff), 4),
    bag: mk(bagGeo, mat(0xffffff), 4),
    phone: mk(phoneGeo, new THREE_.MeshBasicMaterial({ color: 0xffffff }), 6),
  };
  const PHONE_COLS = [0x7DF9FF, 0xFFD166, 0xE8F0FF];
  propOrigColors = {};
  const setPC = (mesh, i, hex) => {
    mesh.setColorAt(i, c.setHex(hex));
    (propOrigColors[mesh.uuid] = propOrigColors[mesh.uuid] || {})[i] = hex;
  };
  // 道具颜色在下面 const c 声明之后统一赋（setPC 只定义、不立即调用，避免 TDZ）。

  // 每实例颜色（种子定死）
  const c = new THREE_.Color();
  origColors = {};
  const setC = (mesh, i, hex) => {
    mesh.setColorAt(i, c.setHex(hex));
    (origColors[mesh.uuid] = origColors[mesh.uuid] || {})[i] = hex;
  };
  pedestrians.forEach((p, i) => {
    setC(parts.torso, i, p.jacket);
    setC(parts.head, i, p.skin);
    setC(parts.legL, i, p.pants);
    setC(parts.legR, i, p.pants);
    setC(parts.armL, i, p.jacket);
    setC(parts.armR, i, p.jacket);
    setC(parts.hairCap, i, p.hair);
    setC(parts.hairLong, i, p.hair);
    setC(parts.accent, i, p.neon || 0x000000);
  });
  for (const m of Object.values(parts)) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  // 第二拨道具颜色（每只狗/每个菜篮/每部手机颜色不同）
  pedestrians.forEach((p) => {
    if (p.life === 'dog') setPC(props.dog, p.propIndex, p.dogColor);
    else if (p.life === 'bag') setPC(props.bag, p.propIndex, p.bagColor);
    else if (p.life === 'phone' || (p.life === 'wait' && p.waitPhone)) setPC(props.phone, p.propIndex, PHONE_COLS[p.propIndex % PHONE_COLS.length]);
  });
  for (const m of Object.values(props)) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  ctx.scene.add(group);
}

const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

function setPart(mesh, i, rootM, px, py, pz, rx, ry, rz, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(px, py, pz);
  _s.set(sx, sy, sz);
  _local.compose(_v, _q, _s);
  _m.multiplyMatrices(rootM, _local);
  mesh.setMatrixAt(i, _m);
}

function update(dt) {
  if (!parts) return;
  const tNow = performance.now() / 1000;
  for (let i = 0; i < pedestrians.length; i++) {
    const p = pedestrians[i];
    const isWait = p.life === 'wait';
    const isPhone = p.life === 'phone' || (isWait && p.waitPhone);
    const isBag = p.life === 'bag';
    const isDog = p.life === 'dog';
    // 沿街走，到端点掉头；等车人站着不动，只四处张望
    const segLen = Math.hypot(p.seg.b[0] - p.seg.a[0], p.seg.b[1] - p.seg.a[1]);
    if (!isWait) {
      p.t += (p.dir * p.speed * dt) / segLen;
      if (p.t > 0.98) { p.t = 0.98; p.dir = -1; }
      if (p.t < 0.02) { p.t = 0.02; p.dir = 1; }
    }
    const pt = segPoint(p.seg, p.t, p.side);
    // 朝向平滑转向（掉头不瞬切）
    const targetHeading = pt.heading + (p.dir < 0 ? Math.PI : 0);
    let dh = targetHeading - p.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    p.heading += dh * Math.min(1, dt * 4);
    // three-procedural-locomotion：按剩余转角减速（掉头时步子放慢），
    // 头/胸预判新朝向（头先转，胸跟一半，脚最后到位）。
    // 等车人：头慢慢左右张望（看车来了没有），身体轻微晃。
    const turnFactor = 1 - Math.min(1, Math.abs(dh) / Math.PI) * 0.5;
    const headTarget = isWait
      ? Math.sin(tNow * 0.45 + p.seed * 1.7) * 0.5
      : Math.max(-0.35, Math.min(0.35, dh * 0.5));
    p.headYaw += (headTarget - p.headYaw) * Math.min(1, dt * (isWait ? 3 : 6));
    p.x = pt.x; p.z = pt.z;
    p.y = groundY(p.x, p.z);
    // 步态：摆腿 / 摆臂 / 身体起伏（three-procedural-locomotion 的逐帧思路）。
    // 步频跟速度走、跟腿长走（腿长 ∝ scale，步频 ∝ speed / scale）；转弯时减速。
    // 等车人站着：不迈腿，只用 phase 当轻晃时钟。
    if (!isWait) p.phase += dt * p.speed * 4.8 * turnFactor / p.scale;
    else p.phase += dt * 0.9;
    const sw = isWait ? 0 : Math.sin(p.phase) * p.stride;
    const sw2 = isWait ? 0 : Math.sin(p.phase + Math.PI) * p.stride;
    const armSw = isWait ? Math.sin(p.phase) * 0.04 : Math.sin(p.phase + Math.PI) * p.armSwing;
    const armSw2 = isWait ? Math.sin(p.phase + 1) * 0.04 : Math.sin(p.phase) * p.armSwing;
    p.bob = isWait ? 0 : Math.abs(Math.cos(p.phase)) * 0.035;
    const hip = 0.88 * p.scale;
    const s = p.scale;
    _e.set(0, p.heading, 0);
    _q.setFromEuler(_e);
    _v.set(p.x, p.y + p.bob, p.z);
    _s.set(s, s, s);
    _root.compose(_v, _q, _s);
    setPart(parts.legL, i, _root, -0.11, hip, 0, sw, 0, 0);
    setPart(parts.legR, i, _root, 0.11, hip, 0, sw2, 0, 0);
    // 手臂：看手机的人右臂屈起举手机；提菜篮的人提篮那侧手臂少摆、篮子跟着晃；
    // 等车人手臂自然下垂轻晃。
    if (isPhone) {
      setPart(parts.armL, i, _root, -0.28, hip + 0.52, 0, armSw, 0, 0.08);
      setPart(parts.armR, i, _root, 0.28, hip + 0.52, 0, -1.05, 0, -0.12);
    } else if (isBag && p.bagSide < 0) {
      setPart(parts.armL, i, _root, -0.28, hip + 0.52, 0, armSw * 0.25, 0, 0.08);
      setPart(parts.armR, i, _root, 0.28, hip + 0.52, 0, armSw2, 0, -0.08);
    } else if (isBag) {
      setPart(parts.armL, i, _root, -0.28, hip + 0.52, 0, armSw, 0, 0.08);
      setPart(parts.armR, i, _root, 0.28, hip + 0.52, 0, armSw2 * 0.25, 0, -0.08);
    } else {
      setPart(parts.armL, i, _root, -0.28, hip + 0.52, 0, armSw, 0, 0.08);
      setPart(parts.armR, i, _root, 0.28, hip + 0.52, 0, armSw2, 0, -0.08);
    }
    const lean = isWait ? Math.sin(p.phase) * 0.03 : 0.06;
    setPart(parts.torso, i, _root, 0, hip + 0.29, 0, lean, p.headYaw * 0.5, Math.sin(p.phase) * 0.04);
    const headY = hip + 0.58 + 0.14;
    // 看手机的人低头（rx 正值 = 脸朝下）；发盖跟着头一起俯仰，不歪。
    const headPitch = isPhone ? 0.26 : -0.04;
    setPart(parts.head, i, _root, 0, headY, 0, headPitch, p.headYaw, 0);
    // 发盖长短发都有（长发只留脑后发片会秃顶）；长发再加脑后发片。
    setPart(parts.hairCap, i, _root, 0, headY + 0.02, -0.01, headPitch, 0, 0);
    if (p.hairLong) {
      setPart(parts.hairLong, i, _root, 0, headY + 0.02, 0, headPitch, 0, 0);
    } else {
      setPart(parts.hairLong, i, _root, 0, 0, 0, 0, 0, 0, 0.001, 0.001, 0.001);
    }
    // 眼睛：两颗，朝向与身体一致（在 root 空间里 z+ 为脸朝向）
    setPart(parts.eyes, i * 2, _root, -0.045, headY + 0.01, 0.105, 0, 0, 0);
    setPart(parts.eyes, i * 2 + 1, _root, 0.045, headY + 0.01, 0.105, 0, 0, 0);
    // 霓虹胸条：无霓虹的行人缩到 0 藏起
    const nScale = p.neon ? 1 : 0.001;
    setPart(parts.accent, i, _root, 0, hip + 0.38, 0, 0.06, 0, 0, nScale, nScale, nScale);
    // 第二拨道具：狗跟在主人身后偏右、菜篮挂在提篮的手上、手机举在脸前
    if (props) {
      if (isDog) {
        const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
        const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
        const dx = p.x - fx * 0.85 + rx * 0.4, dz = p.z - fz * 0.85 + rz * 0.4;
        _e.set(0, p.heading + Math.sin(tNow + p.phase) * 0.15, 0);
        _q.setFromEuler(_e);
        _v.set(dx, groundY(dx, dz) + Math.abs(Math.cos(p.phase)) * 0.03, dz);
        _s.set(p.dogScale, p.dogScale, p.dogScale);
        _m.compose(_v, _q, _s);
        props.dog.setMatrixAt(p.propIndex, _m);
      } else if (isBag) {
        setPart(props.bag, p.propIndex, _root, p.bagSide * 0.28, hip - 0.10 + Math.sin(p.phase) * 0.04, 0.03, armSw * 0.3, 0, 0);
      }
      if (isPhone) {
        setPart(props.phone, p.propIndex, _root, 0.28, hip + 0.95, 0.30, -0.35, 0, 0.1);
      }
    }
  }
  for (const m of Object.values(parts)) m.instanceMatrix.needsUpdate = true;
  if (props) for (const m of Object.values(props)) m.instanceMatrix.needsUpdate = true;
}

function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
  lastT = now;
  update(dt);
  rafId = requestAnimationFrame(tick);
}

export function init(c) {
  ctx = c;
  buildPedestrians();
  buildMeshes();
  update(0);
  lastT = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
  window.__people = {
    count: pedestrians.length,
    baseCount: COUNT,
    lifeCount: LIFE_COUNT,
    total: TOTAL,
    group,
    getPositions: () => pedestrians.map((p) => ({ x: +p.x.toFixed(1), z: +p.z.toFixed(1), seg: p.seg.id, life: p.life || 'walk' })),
    getLifePositions: () => pedestrians.filter((p) => p.life).map((p) => ({ x: +p.x.toFixed(1), z: +p.z.toFixed(1), seg: p.seg.id, life: p.life })),
    update,
  };
  return { group, count: pedestrians.length, baseCount: COUNT, lifeCount: LIFE_COUNT, total: TOTAL };
}

export function setDisplay(mode) {
  displayMode = mode;
  if (!parts) return;
  const c = new THREE.Color();
  if (mode === 'white') {
    // 白膜：霓虹收起来，全部变回白膜
    for (const [uuid, map] of Object.entries(origColors)) {
      const mesh = Object.values(parts).find((m) => m.uuid === uuid);
      if (!mesh) continue;
      for (const [i, hex] of Object.entries(map)) mesh.setColorAt(+i, c.setHex(0xffffff));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    parts.accent.visible = false;
    parts.eyes.visible = false;
    if (props) {
      for (const [uuid, map] of Object.entries(propOrigColors)) {
        const mesh = Object.values(props).find((m) => m.uuid === uuid);
        if (!mesh) continue;
        for (const [i, hex] of Object.entries(map)) mesh.setColorAt(+i, c.setHex(0xffffff));
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      props.phone.visible = false; // 亮屏手机是霓虹件，白膜收起来
    }
  } else {
    for (const [uuid, map] of Object.entries(origColors)) {
      const mesh = Object.values(parts).find((m) => m.uuid === uuid);
      if (!mesh) continue;
      for (const [i, hex] of Object.entries(map)) mesh.setColorAt(+i, c.setHex(hex));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    parts.accent.visible = true;
    parts.eyes.visible = true;
    if (props) {
      for (const [uuid, map] of Object.entries(propOrigColors)) {
        const mesh = Object.values(props).find((m) => m.uuid === uuid);
        if (!mesh) continue;
        for (const [i, hex] of Object.entries(map)) mesh.setColorAt(+i, c.setHex(hex));
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      props.phone.visible = true;
    }
  }
}

export function getCount() { return pedestrians.length; }
export function getBaseCount() { return COUNT; }
export function getLifeCount() { return LIFE_COUNT; }
