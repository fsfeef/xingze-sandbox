// 星泽市 · 虚拟城市沙盘 — app.js
// Three.js r170 · 性能优先：合并几何 + InstancedMesh，draw call 预算 < 60
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SixLoader } from './six-loader.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const toast = (msg, ms = 2200) => {
  const el = $('#toast'); el.textContent = msg; el.style.opacity = 1;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.style.opacity = 0; }, ms);
};

// ---------- fallback mini data (fetch 失败也不白屏) ----------
const FALLBACK = {
  meta: { name: '星泽市', size_m: 2000, seed: 20261125, mock: true },
  roads: [
    { id: 'R0', name: '环城大道', kind: 'ring', width_m: 28, points: [[-800, 0], [0, -800], [800, 0], [0, 800], [-800, 0]] },
    { id: 'A0', name: '中央大道', kind: 'avenue', width_m: 24, points: [[0, -900], [0, 900]] },
    { id: 'A1', name: '滨江大道', kind: 'avenue', width_m: 24, points: [[-900, 0], [900, 0]] },
  ],
  blocks: [
    { id: 'B0', zone: 'cbd', polygon: [[-200, -200], [200, -200], [200, 200], [-200, 200]] },
    { id: 'B1', zone: 'park', polygon: [[-190, -190], [190, -190], [190, 170], [-190, 170]] },
  ],
  buildings: [
    { id: 'BL0', zone: 'cbd', footprint: [[-40, -40], [40, -40], [40, 40], [-40, 40]], height_m: 180, floors: 56, podium_h_m: 10, roof: 'spire', facade: 'glass' },
    { id: 'BL1', zone: 'cbd', footprint: [[120, 60], [170, 60], [170, 110], [120, 110]], height_m: 90, floors: 28, podium_h_m: 8, roof: 'setback', facade: 'glass' },
    { id: 'BL2', zone: 'cbd', footprint: [[-170, 80], [-120, 80], [-120, 130], [-170, 130]], height_m: 45, floors: 14, podium_h_m: 0, roof: 'flat', facade: 'brick' },
  ],
  parks: [{ id: 'P0', name: '中央公园', polygon: [[-190, -190], [190, -190], [190, 170], [-190, 170]], trees: 120 }],
  water: [{ id: 'W1', kind: 'lake', polygon: [[-60, -60], [120, -60], [120, 60], [-60, 60]] }],
  landmarks: [{ id: 'L0', name: '星泽塔', kind: 'tower', x: 0, z: 0, height_m: 268, footprint: [[-27, -27], [27, -27], [27, 27], [-27, 27]] }],
};

// ---------- 数据归一化（生成器用 type，mock 用 kind；闭合环路补段）----------
function normalizeData(data) {
  const roadKind = { arterial: 'avenue', avenue: 'avenue', radial: 'avenue', ring: 'ring', minor: 'street' };
  for (const r of data.roads || []) {
    if (!r.kind) r.kind = roadKind[r.type] || 'street';
    if (r.closed && r.points.length > 2) {
      const f = r.points[0], l = r.points[r.points.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) r.points.push([f[0], f[1]]);
    }
  }
  for (const w of data.water || []) if (!w.kind) w.kind = w.type || 'river';
  for (const lm of data.landmarks || []) if (!lm.kind) lm.kind = lm.type || 'tower';
  return data;
}

let DATA = null;

// ---------- 六区白模模式 ----------
let sixMode = false, sixLoader = null, sixIndex = null;
let minimapImg = null; // 小地图底图（总览图预览）
// 活动范围：六区包 | 程序化小城
function BOUNDS() {
  return sixMode
    ? { x: [-16500, 16500], z: [-19500, 16000], dist: [180, 20000] }
    : { x: [-1050, 1050], z: [-1050, 1050], dist: [180, 1900] };
}
// 地面高度：六区模式用加载器的地形射线，city 模式地面就是 y=0
function groundY(x, z) {
  return (sixMode && sixLoader) ? sixLoader.groundHeightAt(x, z) : 0;
}
// 日月星距离倍率：六区城 33km 宽，日月星必须放到 20 倍远处才不穿帮
const SKY_SCALE = () => (sixMode ? 20 : 1);

// ---------- renderer / scene ----------
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b5e0);
scene.fog = new THREE.Fog(0x9db8d6, 1400, 5200);
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 9000);

const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x5a6b52, 0.9);
scene.add(hemi);
const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
sunLight.position.set(600, 900, 300);
scene.add(sunLight);
const moonLight = new THREE.DirectionalLight(0x8fa8ff, 0.0);
moonLight.position.set(-500, 700, -300);
scene.add(moonLight);

// ---------- state ----------
const state = {
  mode: 'aerial',
  target: new THREE.Vector3(0, 0, 0),   // 航拍环绕目标
  yaw: -0.65, el: 0.62, dist: 980,       // 航拍球面参数
  pos: new THREE.Vector3(0, 1.7, 420),   // 走路/飞行相机位置
  lookYaw: Math.PI, lookPitch: -0.04,    // 走路/飞行朝向
  fov: 55,
  hour: 10, playing: false,
  night: 0,                              // 0 白天 … 1 深夜
  display: 'white',                     // normal | heat | white（默认白膜：白天航拍干净浅灰白块）
  bloom: false,
  tour: false,
  carView: 'follow',                     // follow | interior
};
const car = { x: 0, z: 120, heading: 0, speed: 0 };
const keys = new Set();
const joy = { x: 0, y: 0, active: false };
let flyAnim = null;      // {p0,t0,p1,t1,start,dur}
let tourTimer = null, tourIdx = 0;

// ---------- helpers ----------
function bboxOf(poly) {
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
}
function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function seededRand(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function shapeGeo(poly, y) {
  const shape = new THREE.Shape();
  poly.forEach(([x, z], i) => { if (i === 0) shape.moveTo(x, -z); else shape.lineTo(x, -z); });
  shape.closePath();
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}
function addColorAttr(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function scaleBoxUV(geo, w, h) {
  const uv = geo.attributes.uv;
  const su = Math.max(1, w / 7), sv = Math.max(1, h / 3.4);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geo;
}
// 三角棱柱屋顶（ridge 沿 x）
function prismGeo(w, h, d) {
  const hw = w / 2, hd = d / 2;
  const v = [
    // 前坡 (z=-hd)
    -hw, 0, -hd, hw, 0, -hd, hw, h, 0, -hw, 0, -hd, hw, h, 0, -hw, h, 0,
    // 后坡 (z=+hd)
    hw, 0, hd, -hw, 0, hd, -hw, h, 0, hw, 0, hd, -hw, h, 0, hw, h, 0,
    // 左三角
    -hw, 0, -hd, -hw, h, 0, -hw, 0, hd,
    // 右三角
    hw, 0, hd, hw, h, 0, hw, 0, -hd,
    // 底
    -hw, 0, -hd, -hw, 0, hd, hw, 0, hd, -hw, 0, -hd, hw, 0, hd, hw, 0, -hd,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  const uv = new Float32Array((v.length / 3) * 2);
  for (let i = 0; i < uv.length; i += 2) { uv[i] = 0.5; uv[i + 1] = 0.5; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}
// 道路带状几何（每段一个四边形，y 固定）
function ribbonGeo(roads, widthFn, y) {
  const pos = [], norm = [], uv = [];
  const push = (ax, az, bx, bz, w) => {
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
    const px = -dz / len * w / 2, pz = dx / len * w / 2;
    const quad = [[ax + px, az + pz], [bx + px, bz + pz], [bx - px, bz - pz], [ax + px, az + pz], [bx - px, bz - pz], [ax - px, az - pz]];
    for (const [x, z] of quad) { pos.push(x, y, z); norm.push(0, 1, 0); uv.push(0, 0); }
  };
  for (const r of roads) {
    const w = widthFn(r);
    for (let i = 0; i < r.points.length - 1; i++) push(r.points[i][0], r.points[i][1], r.points[i + 1][0], r.points[i + 1][1], w);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
// 车道虚线标线
function markingGeo(roads, y) {
  const pos = [], norm = [], uv = [];
  for (const r of roads) {
    if (r.kind === 'alley') continue;
    for (let i = 0; i < r.points.length - 1; i++) {
      const [ax, az] = r.points[i], [bx, bz] = r.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.floor(len / 14);
      for (let k = 0; k < n; k++) {
        const t0 = (k * 14 + 2) / len, t1 = (k * 14 + 8) / len;
        const x0 = lerp(ax, bx, t0), z0 = lerp(az, bz, t0), x1 = lerp(ax, bx, t1), z1 = lerp(az, bz, t1);
        const dx = bx - ax, dz = bz - az, L = len || 1;
        const px = -dz / L * 0.28, pz = dx / L * 0.28;
        const quad = [[x0 + px, z0 + pz], [x1 + px, z1 + pz], [x1 - px, z1 - pz], [x0 + px, z0 + pz], [x1 - px, z1 - pz], [x0 - px, z0 - pz]];
        for (const [x, z] of quad) { pos.push(x, y, z); norm.push(0, 1, 0); uv.push(0, 0); }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

// ---------- 窗光贴图 ----------
function facadeTextures(base, litRatio, seed) {
  const rnd = seededRand(seed);
  const cMap = document.createElement('canvas'); cMap.width = cMap.height = 256;
  const cEmi = document.createElement('canvas'); cEmi.width = cEmi.height = 256;
  const m = cMap.getContext('2d'), e = cEmi.getContext('2d');
  m.fillStyle = base; m.fillRect(0, 0, 256, 256);
  // 轻微竖向光泽（玻璃）
  const grad = m.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)'); grad.addColorStop(0.5, 'rgba(255,255,255,0)'); grad.addColorStop(1, 'rgba(255,255,255,0.08)');
  m.fillStyle = grad; m.fillRect(0, 0, 256, 256);
  e.fillStyle = '#000'; e.fillRect(0, 0, 256, 256);
  const cols = 8, rows = 14, ww = 256 / cols, hh = 256 / rows;
  const warm = ['#ffd27a', '#ffb46a', '#fff2c8', '#ffc46a'];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = c * ww + 5, y = r * hh + 4, w = ww - 10, h = hh - 8;
    m.fillStyle = 'rgba(18,22,30,0.85)'; m.fillRect(x, y, w, h);
    m.fillStyle = 'rgba(255,255,255,0.10)'; m.fillRect(x, y, w, 2);
    if (rnd() < litRatio) { e.fillStyle = warm[(rnd() * warm.length) | 0]; e.fillRect(x, y, w, h); }
  }
  const map = new THREE.CanvasTexture(cMap);
  const emissiveMap = new THREE.CanvasTexture(cEmi);
  map.colorSpace = THREE.SRGBColorSpace; emissiveMap.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  emissiveMap.wrapS = emissiveMap.wrapT = THREE.RepeatWrapping;
  return { map, emissiveMap };
}

// ---------- 场景构建 ----------
const ZONE_COLOR = { cbd: 0x4f8ef7, commercial: 0xf5a623, residential: 0x7bc47f, civic: 0x9b7ede, park: 0x4caf6d, water: 0x3f7fb8 };
const ZONE_NAME = { cbd: '商务区', commercial: '商业区', residential: '住宅区', civic: '市政区', park: '公园绿地', water: '水域' };
const ZONE_HEX = { cbd: '#4f8ef7', commercial: '#f5a623', residential: '#7bc47f', civic: '#9b7ede', park: '#4caf6d', water: '#3f7fb8' };
const BLOCK_COLOR = { cbd: 0xb9bec8, commercial: 0xcac3b2, residential: 0xc2cdbd, civic: 0xb7bfcc, park: 0x86b573, water: 0x9db8c4 };

let buildingGroup, heatGroup, normalMeshes = [], facadeMats = {}, lampHeadMat, sunMesh, moonMesh, stars;
let carGroup;

function heatColor(h) {
  // 楼高着色：低蓝 → 中黄 → 高红
  const t = clamp(h / 220, 0, 1);
  const c = new THREE.Color();
  if (t < 0.5) c.setHSL(0.58 - t * 0.3, 0.75, 0.55);
  else c.setHSL(0.13 - (t - 0.5) * 0.26, 0.85, 0.55);
  return c;
}

function buildSkyBodies() {
  // 太阳 / 月亮 / 星星（city 模式与六区模式共用；六区按 SKY_SCALE 放远）
  const SS = SKY_SCALE();
  sunMesh = new THREE.Mesh(new THREE.CircleGeometry(70 * SS, 24), new THREE.MeshBasicMaterial({ color: 0xffd76a, fog: false }));
  moonMesh = new THREE.Mesh(new THREE.CircleGeometry(46 * SS, 24), new THREE.MeshBasicMaterial({ color: 0xe8ecf5, fog: false }));
  scene.add(sunMesh, moonMesh);
  const starPos = [];
  const sRnd = seededRand(5);
  for (let i = 0; i < 420; i++) {
    const a = sRnd() * Math.PI * 2, e2 = sRnd() * Math.PI * 0.42 + 0.08;
    const R = 4200 * SS;
    starPos.push(Math.cos(a) * Math.cos(e2) * R, Math.sin(e2) * R, Math.sin(a) * Math.cos(e2) * R);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.4, transparent: true, opacity: 0, fog: false, sizeAttenuation: false }));
  scene.add(stars);
}

function buildCar() {
  // 开车用的车（平时隐藏；city 模式与六区模式共用）
  carGroup = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.65, 4.4), new THREE.MeshStandardMaterial({ color: 0xd8443c, metalness: 0.6, roughness: 0.35 }));
  body.position.y = 0.62;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 2.1), new THREE.MeshStandardMaterial({ color: 0x222831, metalness: 0.7, roughness: 0.2 }));
  cabin.position.set(0, 1.2, -0.25);
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.3, 10); wheelGeo.rotateZ(Math.PI / 2);
  const wheelGeos = [[-0.95, 0.36, 1.45], [0.95, 0.36, 1.45], [-0.95, 0.36, -1.45], [0.95, 0.36, -1.45]]
    .map(([x, y, z]) => wheelGeo.clone().applyMatrix4(new THREE.Matrix4().makeTranslation(x, y, z)));
  const wheels = new THREE.Mesh(mergeGeometries(wheelGeos), new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.9 }));
  carGroup.add(body, cabin, wheels);
  carGroup.visible = false;
  scene.add(carGroup);
}

function buildCity(data) {
  const M = new THREE.Matrix4();
  // 地面
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(5600, 5600),
    new THREE.MeshStandardMaterial({ color: 0x8fa07a, roughness: 1, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05;
  ground.matrixAutoUpdate = false; ground.updateMatrix();
  scene.add(ground);

  // 街区（按用地着色，合并 1 call）
  const blockGeos = data.blocks.map((b) => addColorAttr(shapeGeo(b.polygon, 0.02), BLOCK_COLOR[b.zone] ?? 0xcccccc));
  const blocksMesh = new THREE.Mesh(mergeGeometries(blockGeos),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
  blocksMesh.matrixAutoUpdate = false; blocksMesh.updateMatrix();
  scene.add(blocksMesh);

  // 道路：人行道底 + 沥青 + 标线（3 calls）
  const walkMesh = new THREE.Mesh(ribbonGeo(data.roads, (r) => r.width_m + 6, 0.03),
    new THREE.MeshStandardMaterial({ color: 0xb9b3a4, roughness: 0.95 }));
  const roadMesh = new THREE.Mesh(ribbonGeo(data.roads, (r) => r.width_m, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.92 }));
  const markMesh = new THREE.Mesh(markingGeo(data.roads, 0.09),
    new THREE.MeshStandardMaterial({ color: 0xd8d2a0, roughness: 0.8 }));
  for (const m of [walkMesh, roadMesh, markMesh]) { m.matrixAutoUpdate = false; m.updateMatrix(); scene.add(m); }

  // 水面（合并 1 call）
  const waterGeos = data.water.map((w) => shapeGeo(w.polygon, 0.12));
  const waterMesh = new THREE.Mesh(mergeGeometries(waterGeos),
    new THREE.MeshStandardMaterial({ color: 0x3f7fb8, roughness: 0.15, metalness: 0.35, transparent: true, opacity: 0.88 }));
  waterMesh.matrixAutoUpdate = false; waterMesh.updateMatrix();
  scene.add(waterMesh);

  // ---- 建筑：裙楼 + 塔身 + 屋顶分开建模，按 facade 合并 ----
  const texGlass = facadeTextures('#8fa8bd', 0.55, 11);
  const texBrick = facadeTextures('#a9805e', 0.42, 23);
  const texConc = facadeTextures('#b4b8bc', 0.3, 37);
  facadeMats = {
    glass: new THREE.MeshStandardMaterial({ map: texGlass.map, emissiveMap: texGlass.emissiveMap, emissive: 0xffbf6e, emissiveIntensity: 0, metalness: 0.55, roughness: 0.32 }),
    brick: new THREE.MeshStandardMaterial({ map: texBrick.map, emissiveMap: texBrick.emissiveMap, emissive: 0xffbf6e, emissiveIntensity: 0, metalness: 0.05, roughness: 0.9 }),
    concrete: new THREE.MeshStandardMaterial({ map: texConc.map, emissiveMap: texConc.emissiveMap, emissive: 0xffbf6e, emissiveIntensity: 0, metalness: 0.05, roughness: 0.85 }),
  };
  const podiumMat = new THREE.MeshStandardMaterial({ color: 0x8d939b, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x6f747c, roughness: 0.9 });
  const clayMat = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.95 });

  const towerGeos = { glass: [], brick: [], concrete: [] };
  const heatGeos = { glass: [], brick: [], concrete: [] };
  const podiumGeos = [], roofGeos = [], heatPodium = [], heatRoof = [];
  const place = (list, geo, cx, y, cz) => { geo.applyMatrix4(new THREE.Matrix4().makeTranslation(cx, y, cz)); list.push(geo); };

  for (const b of data.buildings) {
    const { cx, cz, w, d } = bboxOf(b.footprint);
    const h = b.height_m, ph = b.podium_h_m || 0;
    const towerH = Math.max(4, h - ph);
    const hc = heatColor(h);
    // 裙楼
    if (ph > 0) {
      const g = scaleBoxUV(new THREE.BoxGeometry(w + 6, ph, d + 6), w + 6, ph);
      place(podiumGeos, g, cx, ph / 2, cz);
      place(heatPodium, addColorAttr(scaleBoxUV(new THREE.BoxGeometry(w + 6, ph, d + 6), w + 6, ph), hc), cx, ph / 2, cz);
    }
    // 塔身
    const tg = scaleBoxUV(new THREE.BoxGeometry(w, towerH, d), w, towerH);
    place(towerGeos[b.facade] || towerGeos.concrete, tg, cx, ph + towerH / 2, cz);
    place(heatGeos[b.facade] || heatGeos.concrete, addColorAttr(scaleBoxUV(new THREE.BoxGeometry(w, towerH, d), w, towerH), hc), cx, ph + towerH / 2, cz);
    // 屋顶
    const ry = ph + towerH;
    let rg;
    if (b.roof === 'pitched') rg = prismGeo(w, Math.min(6, w * 0.22), d);
    else if (b.roof === 'spire') rg = new THREE.ConeGeometry(Math.max(w, d) * 0.62, Math.min(26, h * 0.16), 4);
    else if (b.roof === 'setback') rg = new THREE.BoxGeometry(w * 0.62, Math.max(3, h * 0.05), d * 0.62);
    else rg = new THREE.BoxGeometry(w * 0.96, 1.2, d * 0.96);
    if (b.roof === 'spire') rg.rotateY(Math.PI / 4);
    if (rg.index) rg = rg.toNonIndexed(); // 屋顶合并：Box/Cone 是 indexed、棱柱不是，统一转 non-indexed 才能合
    const roofY = b.roof === 'pitched' ? ry : ry + (b.roof === 'spire' ? Math.min(26, h * 0.16) / 2 : (b.roof === 'setback' ? Math.max(3, h * 0.05) / 2 : 0.6));
    place(roofGeos, rg, cx, roofY, cz);
    // 热力屋顶用同形（颜色同楼高）
    let hg;
    if (b.roof === 'pitched') hg = prismGeo(w, Math.min(6, w * 0.22), d);
    else if (b.roof === 'spire') { hg = new THREE.ConeGeometry(Math.max(w, d) * 0.62, Math.min(26, h * 0.16), 4); hg.rotateY(Math.PI / 4); }
    else if (b.roof === 'setback') hg = new THREE.BoxGeometry(w * 0.62, Math.max(3, h * 0.05), d * 0.62);
    else hg = new THREE.BoxGeometry(w * 0.96, 1.2, d * 0.96);
    if (hg.index) hg = hg.toNonIndexed();
    place(heatRoof, addColorAttr(hg, hc), cx, roofY, cz);
  }

  buildingGroup = new THREE.Group();
  heatGroup = new THREE.Group();
  heatGroup.visible = false;
  const heatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
  normalMeshes = [];
  for (const f of ['glass', 'brick', 'concrete']) {
    if (!towerGeos[f].length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(towerGeos[f]), facadeMats[f]);
    mesh.userData.mat = facadeMats[f]; mesh.userData.clay = clayMat;
    buildingGroup.add(mesh); normalMeshes.push(mesh);
    const hm = new THREE.Mesh(mergeGeometries(heatGeos[f]), heatMat);
    heatGroup.add(hm);
  }
  if (podiumGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(podiumGeos), podiumMat);
    mesh.userData.mat = podiumMat; mesh.userData.clay = clayMat;
    buildingGroup.add(mesh); normalMeshes.push(mesh);
    heatGroup.add(new THREE.Mesh(mergeGeometries(heatPodium), heatMat));
  }
  if (roofGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(roofGeos), roofMat);
    mesh.userData.mat = roofMat; mesh.userData.clay = clayMat;
    buildingGroup.add(mesh); normalMeshes.push(mesh);
    heatGroup.add(new THREE.Mesh(mergeGeometries(heatRoof), heatMat));
  }
  for (const g of [buildingGroup, heatGroup]) { g.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); }); }
  scene.add(buildingGroup, heatGroup);

  // ---- 树：InstancedMesh，多种子变体（树干 + 树冠 = 2 calls）----
  const treeSpots = [];
  const rnd = seededRand(20261125);
  for (const p of data.parks) {
    const bb = bboxOf(p.polygon);
    let placed = 0, guard = 0;
    while (placed < p.trees && guard++ < p.trees * 8) {
      const x = bb.cx + (rnd() - 0.5) * bb.w * 0.96, z = bb.cz + (rnd() - 0.5) * bb.d * 0.96;
      if (pointInPoly(x, z, p.polygon) && !pointInPoly(x, z, (data.water.find((w) => w.kind === 'lake') || { polygon: [] }).polygon)) {
        treeSpots.push([x, z]); placed++;
      }
    }
  }
  // 行道树：沿主干道两侧
  for (const r of data.roads.filter((x) => x.kind === 'avenue' || x.kind === 'ring')) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const [ax, az] = r.points[i], [bx, bz] = r.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az), n = Math.floor(len / 34);
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n, x = lerp(ax, bx, t), z = lerp(az, bz, t);
        const dx = (bx - ax) / (len || 1), dz = (bz - az) / (len || 1);
        const off = r.width_m / 2 + 4;
        treeSpots.push([x - dz * off, z + dx * off]);
        if (rnd() < 0.7) treeSpots.push([x + dz * off, z - dx * off]);
      }
    }
  }
  const treeCount = treeSpots.length;
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 2.4, 5); trunkGeo.translate(0, 1.2, 0);
  const canopyGeo = new THREE.IcosahedronGeometry(1.9, 0); canopyGeo.scale(1, 0.82, 1); canopyGeo.translate(0, 3.6, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 }), treeCount);
  const canopies = new THREE.InstancedMesh(canopyGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), treeCount);
  const dummy = new THREE.Object3D(), col = new THREE.Color();
  treeSpots.forEach(([x, z], i) => {
    const s = 0.75 + rnd() * 0.65;
    dummy.position.set(x, 0, z); dummy.rotation.y = rnd() * Math.PI * 2;
    dummy.scale.setScalar(s); dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix); canopies.setMatrixAt(i, dummy.matrix);
    col.setHSL(0.29 + rnd() * 0.06, 0.5 + rnd() * 0.2, 0.32 + rnd() * 0.14);
    canopies.setColorAt(i, col);
  });
  trunks.instanceMatrix.needsUpdate = true; canopies.instanceMatrix.needsUpdate = true;
  if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
  trunks.matrixAutoUpdate = false; canopies.matrixAutoUpdate = false;
  scene.add(trunks, canopies);

  // ---- 路灯：InstancedMesh（灯杆 + 灯头 = 2 calls）----
  const lampSpots = [];
  for (const r of data.roads.filter((x) => x.kind === 'avenue' || x.kind === 'ring')) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const [ax, az] = r.points[i], [bx, bz] = r.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az), n = Math.floor(len / 46);
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n, x = lerp(ax, bx, t), z = lerp(az, bz, t);
        const dx = (bx - ax) / (len || 1), dz = (bz - az) / (len || 1);
        const off = r.width_m / 2 + 1.6;
        lampSpots.push([x - dz * off, z + dx * off]);
      }
    }
  }
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 7, 5); poleGeo.translate(0, 3.5, 0);
  const headGeo = new THREE.SphereGeometry(0.34, 6, 5); headGeo.translate(0, 7.1, 0);
  const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.7, metalness: 0.5 }), lampSpots.length);
  lampHeadMat = new THREE.MeshStandardMaterial({ color: 0x555555, emissive: 0xffc46a, emissiveIntensity: 0.05 });
  const heads = new THREE.InstancedMesh(headGeo, lampHeadMat, lampSpots.length);
  lampSpots.forEach(([x, z], i) => { dummy.position.set(x, 0, z); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); poles.setMatrixAt(i, dummy.matrix); heads.setMatrixAt(i, dummy.matrix); });
  poles.instanceMatrix.needsUpdate = true; heads.instanceMatrix.needsUpdate = true;
  scene.add(poles, heads);

  // ---- 城外远山：程序化环形山体（1 call；有真实 terrain.peaks 就按峰位/峰高生成）----
  const SEG = 160, RINGS = 7;
  const mPos = [], mCol = [], mIdx = [];
  const mRnd = seededRand(77);
  const peaks = (data.terrain && data.terrain.peaks) || null;
  const ridgeH = (a) => {
    if (peaks) {
      let h = 30;
      for (const p of peaks) {
        const pa = THREE.MathUtils.degToRad(p.angle_deg);
        let d = Math.abs(a - pa);
        if (d > Math.PI) d = Math.PI * 2 - d;
        const w = (p.radius_m / p.distance_m) * 1.6;
        h += p.height_m * Math.exp(-(d * d) / (w * w));
      }
      return Math.min(260, h);
    }
    const phases = [[0.3, 1.1], [2.1, 0.8], [4.4, 1.2]];
    let h = 0;
    phases.forEach(([p, amp], k) => { h += Math.sin(a * (k + 2) + p) * amp; });
    return Math.max(40, 150 + h * 90);
  };
  for (let j = 0; j <= RINGS; j++) {
    const r = 1350 + (j / RINGS) * 850;
    const prof = Math.sin((j / RINGS) * Math.PI * 0.85); // 中间高、两边低
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const h = ridgeH(a) * prof;
      mPos.push(Math.cos(a) * r, h, Math.sin(a) * r);
      const c = new THREE.Color();
      if (h > 300) c.setHex(0xdfe6ea); else if (h > 180) c.setHex(0x8a8f96); else if (h > 60) c.setHex(0x6b7f5e); else c.setHex(0x5a7d4a);
      mCol.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < RINGS; j++) for (let i = 0; i < SEG; i++) {
    const a = j * (SEG + 1) + i, b = a + 1, c2 = a + SEG + 1, d = c2 + 1;
    mIdx.push(a, c2, b, b, c2, d);
  }
  const mGeo = new THREE.BufferGeometry();
  mGeo.setAttribute('position', new THREE.Float32BufferAttribute(mPos, 3));
  mGeo.setAttribute('color', new THREE.Float32BufferAttribute(mCol, 3));
  mGeo.setIndex(mIdx); mGeo.computeVertexNormals();
  const mountains = new THREE.Mesh(mGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  mountains.matrixAutoUpdate = false; mountains.updateMatrix();
  scene.add(mountains);

  buildSkyBodies();
  buildCar();

  return { treeCount, lampCount: lampSpots.length };
}

// ---------- 六区白模模式 ----------
async function buildSix(index) {
  sixIndex = index;
  buildSkyBodies();
  buildCar();
  // 地面兜底面：低于六区地形最低点，填地形瓦片间的缝和包外空地
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(70000, 70000),
    new THREE.MeshStandardMaterial({ color: 0x8fa07a, roughness: 1, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -2.5;
  ground.matrixAutoUpdate = false; ground.updateMatrix();
  scene.add(ground);
  // 相机 / 雾按六区尺度放大
  camera.far = 90000; camera.updateProjectionMatrix();
  scene.fog = new THREE.Fog(0x9db8d6, 4000, 40000);
  // 初始视角：星泽广场上空俯瞰
  state.target.set(0, 0, 0);
  state.dist = 6000; state.el = 0.62;
  state.pos.set(0, 1.7, 420);
  sixLoader = new SixLoader(scene);
  const view = { tx: 0, tz: 0, camX: 0, camY: 6000, camZ: 0, mode: 'aerial', aerialDist: 6000 };
  await sixLoader.loadInitial(view, (p) => {
    const el = document.querySelector('#loading-overlay .sub');
    if (el) el.textContent = `虚拟城市沙盘 · 正在搭建主城区… ${Math.round(p * 100)}%`;
  });
  minimapImg = new Image();
  minimapImg.onload = () => drawMinimap();
  minimapImg.src = sixIndex.minimap.image;
}

// ---------- 时间 / 天空 ----------
const SKY_STOPS = [
  { h: 0, sky: 0x0b1026, fog: 0x0b1026, sun: 0x223355, sunI: 0.05, hemiI: 0.25, night: 1 },
  { h: 5, sky: 0x0b1026, fog: 0x0e142e, sun: 0x223355, sunI: 0.05, hemiI: 0.25, night: 1 },
  { h: 6.5, sky: 0xff9a5c, fog: 0xe8a06a, sun: 0xffb36a, sunI: 1.2, hemiI: 0.55, night: 0.25 },
  { h: 8, sky: 0x87b5e0, fog: 0x9db8d6, sun: 0xfff2d8, sunI: 2.2, hemiI: 0.9, night: 0 },
  { h: 16.5, sky: 0x87b5e0, fog: 0x9db8d6, sun: 0xfff2d8, sunI: 2.2, hemiI: 0.9, night: 0 },
  { h: 18.5, sky: 0xff7e4a, fog: 0xd88a5e, sun: 0xff9a4a, sunI: 1.1, hemiI: 0.5, night: 0.35 },
  { h: 20, sky: 0x0e1430, fog: 0x0e1430, sun: 0x223355, sunI: 0.08, hemiI: 0.28, night: 1 },
  { h: 24, sky: 0x0b1026, fog: 0x0b1026, sun: 0x223355, sunI: 0.05, hemiI: 0.25, night: 1 },
];
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
let _autoNight = false; // 昼夜自动切显示的上一状态（false 白天）
function applyTime(hour) {
  state.hour = hour;
  let a = SKY_STOPS[0], b = SKY_STOPS[SKY_STOPS.length - 1];
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    if (hour >= SKY_STOPS[i].h && hour <= SKY_STOPS[i + 1].h) { a = SKY_STOPS[i]; b = SKY_STOPS[i + 1]; break; }
  }
  const t = (hour - a.h) / Math.max(0.01, b.h - a.h);
  scene.background.copy(_c1.setHex(a.sky)).lerp(_c2.setHex(b.sky), t);
  scene.fog.color.copy(_c1.setHex(a.fog)).lerp(_c2.setHex(b.fog), t);
  sunLight.color.copy(_c1.setHex(a.sun)).lerp(_c2.setHex(b.sun), t);
  sunLight.intensity = lerp(a.sunI, b.sunI, t);
  hemi.intensity = lerp(a.hemiI, b.hemiI, t);
  state.night = lerp(a.night, b.night, t);
  moonLight.intensity = state.night * 0.35;
  // 夜色传播给接线模块（roads 灯光池/路面微光、sun 亮窗 shader；各自幂等）
  if (window.__roads && window.__roads.setNight) { try { window.__roads.setNight(state.night); } catch (e) { /* 夜色传播失败不阻断时间轴 */ } }
  if (window.__dSunNight && window.__dSunNight.setNight) { try { window.__dSunNight.setNight(state.night); } catch (e) { /* 同上 */ } }
  if (window.__roofsApi && window.__roofsApi.setNight) { try { window.__roofsApi.setNight(state.night); } catch (e) { /* 同上 */ } }
  // 白模阶段锁死白膜：夜里也不切回正常（2026-11-26 17:06 令：游戏里颜色全撤）
  // 只在昼夜边界切换时动一次；手动白膜按钮在其间不受顶（applyTime 只在时间变化时跑）
  const _isNight = state.night >= 0.5;
  if (_isNight !== _autoNight) {
    _autoNight = _isNight;
    if (state.display === 'white' || state.display === 'normal') setDisplay('white');
  }
  const winGlow = state.night;
  for (const m of Object.values(facadeMats)) m.emissiveIntensity = winGlow * 1.7;
  if (lampHeadMat) lampHeadMat.emissiveIntensity = 0.05 + winGlow * 2.4;
  if (stars) stars.material.opacity = winGlow * 0.9;
  // 太阳 / 月亮位置（六区按 SKY_SCALE 放远，否则航拍高空会穿帮）
  const SS = SKY_SCALE();
  const sunAng = ((hour - 6) / 12) * Math.PI;
  const sunEl = Math.sin(sunAng);
  sunMesh.position.set(Math.cos(sunAng) * 3400 * SS, Math.max(-400 * SS, sunEl * 2600 * SS), 900 * SS);
  sunMesh.visible = sunEl > -0.12;
  sunMesh.lookAt(camera.position);
  const moonAng = sunAng + Math.PI;
  const moonEl = Math.sin(moonAng);
  moonMesh.position.set(Math.cos(moonAng) * 3400 * SS, Math.max(-400 * SS, moonEl * 2600 * SS), -900 * SS);
  moonMesh.visible = moonEl > -0.05;
  moonMesh.lookAt(camera.position);
  // 太阳光方向跟随太阳
  if (sunEl > 0) sunLight.position.set(Math.cos(sunAng) * 1200, Math.max(200, sunEl * 1400), 600);
  else moonLight.position.set(Math.cos(moonAng) * 1200, Math.max(200, moonEl * 1400), -600);
  // 时间标签
  const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60);
  const label = hour < 5 ? '深夜' : hour < 6.5 ? '黎明' : hour < 8 ? '清晨' : hour < 16.5 ? '白天' : hour < 18.5 ? '傍晚' : hour < 20 ? '黄昏' : '夜晚';
  $('#time-label').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${label}`;
  const slider = $('#time-slider');
  if (document.activeElement !== slider) slider.value = String(hour);
}

// ---------- 相机控制（第一人称硬标准：滑动拉画面本身；捏合只变 FOV；镜头绝不自己转）----------
function syncCamera() {
  if (state.mode === 'aerial') {
    const ce = Math.cos(state.el), se = Math.sin(state.el);
    camera.position.set(
      state.target.x + state.dist * ce * Math.sin(state.yaw),
      state.target.y + state.dist * se,
      state.target.z + state.dist * ce * Math.cos(state.yaw));
    camera.lookAt(state.target);
  } else if (state.mode === 'drive') {
    // 在 animate() 里跟车
  } else {
    camera.position.copy(state.pos);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(state.lookYaw);
    camera.rotateX(state.lookPitch);
  }
  if (camera.fov !== state.fov) { camera.fov = state.fov; camera.updateProjectionMatrix(); }
}
function groundForward() {
  if (state.mode === 'aerial') {
    const f = new THREE.Vector3().subVectors(state.target, camera.position); f.y = 0;
    return f.normalize();
  }
  return new THREE.Vector3(-Math.sin(state.lookYaw), 0, -Math.cos(state.lookYaw));
}
function panBy(dxPx, dyPx) {
  const f = groundForward();
  const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
  const k = state.mode === 'aerial' ? state.dist * 0.0011 : 0.05;
  const off = new THREE.Vector3().addScaledVector(right, -dxPx * k).addScaledVector(f, dyPx * k);
  const B = BOUNDS();
  if (state.mode === 'aerial') {
    state.target.add(off);
    state.target.x = clamp(state.target.x, B.x[0], B.x[1]);
    state.target.z = clamp(state.target.z, B.z[0], B.z[1]);
  } else if (state.mode === 'walk' || state.mode === 'fly') {
    state.pos.add(off);
    state.pos.x = clamp(state.pos.x, B.x[0], B.x[1]);
    state.pos.z = clamp(state.pos.z, B.z[0], B.z[1]);
  }
  stopTour('已接管视角');
}
function zoomBy(factor) {
  // factor > 1 = 放大
  if (state.mode === 'aerial') state.dist = clamp(state.dist / factor, ...BOUNDS().dist);
  else state.fov = clamp(state.fov / factor, 35, 90); // 捏合只变 FOV，相机不动
}
function wheelZoom(deltaY) {
  if (state.mode === 'aerial') state.dist = clamp(state.dist * (1 + deltaY * 0.001), ...BOUNDS().dist);
  else if (state.mode === 'fly') state.pos.y = clamp(state.pos.y - deltaY * 0.06, 8, 600);
  else state.fov = clamp(state.fov + deltaY * 0.02, 35, 90);
}

// 指针：单指拖动平移，双指捏合缩放
const pointers = new Map();
let pinchDist0 = 0;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist0 = Math.hypot(a.x - b.x, a.y - b.y);
  }
  flyAnim = null;
  stopTour();
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    flyAnim = null;
    panBy(dx, dy);
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist0 > 0 && d > 0) zoomBy(d / pinchDist0);
    pinchDist0 = d;
  }
});
const endPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchDist0 = 0; };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); flyAnim = null; wheelZoom(e.deltaY); }, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- 飞行（传送落点要准）----------
function flyTo(x, z, opts = {}) {
  const p0 = camera.position.clone();
  let p1, t1;
  if (state.mode === 'walk') {
    p1 = new THREE.Vector3(x + 16, groundY(x + 16, z + 16) + 1.7, z + 16);
    t1 = new THREE.Vector3(x, 6, z);
  } else if (state.mode === 'fly') {
    p1 = new THREE.Vector3(x, 110, z + 140);
    t1 = new THREE.Vector3(x, 10, z);
  } else if (state.mode === 'drive') {
    const B = BOUNDS();
    car.x = clamp(x, B.x[0] + 50, B.x[1] - 50); car.z = clamp(z, B.z[0] + 50, B.z[1] - 50); car.speed = 0;
    toast('已把车开到目标附近');
    return;
  } else {
    const dist = opts.dist || 420;
    p1 = new THREE.Vector3(x + dist * Math.sin(state.yaw) * 0.55, dist * 0.62, z + dist * Math.cos(state.yaw) * 0.55);
    t1 = new THREE.Vector3(x, 0, z);
  }
  const t0 = state.mode === 'aerial' ? state.target.clone()
    : new THREE.Vector3().copy(camera.position).add(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).multiplyScalar(30));
  flyAnim = { p0, t0, p1, t1, start: performance.now(), dur: 1400 };
}
function finishFlyAnim() {
  if (!flyAnim) return;
  const { p1, t1 } = flyAnim;
  if (state.mode === 'aerial') {
    state.target.copy(t1);
    const off = new THREE.Vector3().subVectors(p1, t1);
    state.dist = clamp(off.length(), ...BOUNDS().dist);
    state.el = Math.asin(clamp(off.y / state.dist, -0.9, 0.95));
    state.yaw = Math.atan2(off.x, off.z);
  } else if (state.mode === 'walk' || state.mode === 'fly') {
    state.pos.copy(p1);
    const d = new THREE.Vector3().subVectors(t1, p1).normalize();
    state.lookYaw = Math.atan2(-d.x, -d.z);
    state.lookPitch = clamp(Math.asin(clamp(d.y, -1, 1)), -1.2, 1.2);
  }
  flyAnim = null;
}

// ---------- 模式切换 ----------
function setMode(mode) {
  if (state.mode === mode) return;
  stopTour();
  const prev = state.mode;
  state.mode = mode;
  document.querySelectorAll('#mode-seg button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
  });
  $('#drive-bar').classList.toggle('show', mode === 'drive');
  carGroup.visible = mode === 'drive';
  if (mode === 'drive') {
    // 车停在当前视点地面处
    const gp = prev === 'aerial' ? state.target : state.pos;
    const B = BOUNDS();
    car.x = clamp(gp.x, B.x[0] + 50, B.x[1] - 50); car.z = clamp(gp.z, B.z[0] + 50, B.z[1] - 50);
    car.heading = prev === 'aerial' ? state.yaw + Math.PI : state.lookYaw;
    car.speed = 0;
    toast('开车：W 油门 · S 刹车 · A/D 转向');
  } else if (mode === 'walk') {
    const gp = prev === 'aerial' ? state.target : state.pos;
    state.pos.set(gp.x, groundY(gp.x, gp.z + 24) + 1.7, gp.z + 24);
    state.lookYaw = prev === 'aerial' ? state.yaw + Math.PI : state.lookYaw;
    state.lookPitch = -0.02; state.fov = 62;
  } else if (mode === 'fly') {
    const gp = prev === 'aerial' ? state.target : state.pos;
    state.pos.set(gp.x, 120, gp.z + 160);
    state.lookYaw = prev === 'aerial' ? state.yaw + Math.PI : state.lookYaw;
    state.lookPitch = -0.25; state.fov = 55;
  } else if (mode === 'aerial') {
    const gp = prev === 'drive' ? new THREE.Vector3(car.x, 0, car.z) : state.pos;
    state.target.set(gp.x, 0, gp.z);
    state.dist = 700; state.el = 0.62;
  }
  syncCamera();
}
document.querySelectorAll('#mode-seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---------- 键盘 ----------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (e.code === 'KeyV') setMode(state.mode === 'aerial' ? 'walk' : 'aerial');
  if (e.code === 'Escape') stopTour();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

// ---------- 摇杆 ----------
(function setupJoystick() {
  const el = $('#joystick'), knob = $('#joy-knob');
  let pid = null;
  const setKnob = (dx, dy) => { knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`; };
  el.addEventListener('pointerdown', (e) => { pid = e.pointerId; el.setPointerCapture(pid); });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const r = el.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy), max = 42;
    if (len > max) { dx *= max / len; dy *= max / len; }
    setKnob(dx, dy);
    joy.x = dx / max; joy.y = dy / max; joy.active = true;
  });
  const end = () => { pid = null; joy.x = 0; joy.y = 0; joy.active = false; setKnob(0, 0); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
})();

// ---------- 显示模式：热力 / 白膜 ----------
const clayMat = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.95 });
function setDisplay(mode) {
  state.display = mode;
  const heat = mode === 'heat', white = mode === 'white';
  if (sixMode) {
    sixLoader.setDisplay(mode); // 六区：共享材质切换（分块 + fabric）——不许改这行
  } else {
    buildingGroup.visible = !heat;
    heatGroup.visible = heat;
    for (const m of normalMeshes) m.material = white ? clayMat : m.userData.mat;
  }
  // 接线模块的显示切换（roofs 经 sixLoader 包装链式调用，不在这里重复调；
  // skin 停了（STOP 守卫），window.__skin 不存在，不传播）
  for (const k of ['__roads', '__dSun', '__people', '__playercar', '__dWeather', '__dMaps', '__towerFix', '__street', '__perf']) {
    const m = window[k];
    if (m && typeof m.setDisplay === 'function') { try { m.setDisplay(mode); } catch (e) { console.warn('[sandbox] setDisplay failed:', k, e); } }
  }
  $('#tgl-white').classList.toggle('active', white);
  $('#tgl-white').setAttribute('aria-pressed', String(white));
  toast(heat ? '热力图：按楼高着色（蓝矮 · 红高）' : white ? '白膜模式' : '已恢复正常材质');
}
$('#tgl-white').addEventListener('click', () => setDisplay(state.display === 'white' ? 'normal' : 'white'));

// ---------- 泛光（默认关；开时走 EffectComposer）----------
let composer = null, bloomPass = null;
function ensureComposer() {
  if (composer) return;
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.4, 0.85);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
}
$('#tgl-bloom').addEventListener('click', () => {
  state.bloom = !state.bloom;
  if (state.bloom) ensureComposer();
  $('#tgl-bloom').classList.toggle('active', state.bloom);
  $('#tgl-bloom').setAttribute('aria-pressed', String(state.bloom));
  toast(state.bloom ? '泛光已开（夜景更亮）' : '泛光已关');
});

// ---------- 导览已砍（13:47 令）：只留空壳，旧调用点不报错 ----------
// stopTour 曾是导览开关；导览、热力图、城市数据、地标分区面板已全部拿掉。
// panBy / 指针 / 飞往等处仍调 stopTour()，空壳接住，不做任何事。
function stopTour() {}

// ---------- 时间轴 ----------
$('#time-slider').addEventListener('input', (e) => { stopPlay(); applyTime(parseFloat(e.target.value)); });
function stopPlay() {
  state.playing = false;
  $('#play-btn').textContent = '▶';
}
$('#play-btn').addEventListener('click', () => {
  state.playing = !state.playing;
  $('#play-btn').textContent = state.playing ? '⏸' : '▶';
});

// ---------- 驾驶栏 ----------
$('#view-toggle').addEventListener('click', () => {
  state.carView = state.carView === 'follow' ? 'interior' : 'follow';
  $('#view-toggle').textContent = state.carView === 'follow' ? '车内视角' : '跟随视角';
  $('#view-toggle').classList.toggle('active', state.carView === 'interior');
});
$('#drive-exit').addEventListener('click', () => setMode('aerial'));

// ---------- 图表 / 列表 / 小地图 ----------
// （城市数据面板、地标/分区列表已拿掉：drawCharts / buildLists / drawChartsSix / buildListsSix
//  不再被 init 调用，留着备用，不删函数体。）
function drawCharts(data) {
  const counts = {};
  for (const b of data.buildings) counts[b.zone] = (counts[b.zone] || 0) + 1;
  const zones = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const bar = $('#chart-bar'), bctx = bar.getContext('2d');
  const W = bar.width, H = bar.height;
  bctx.clearRect(0, 0, W, H);
  bctx.fillStyle = '#fff'; bctx.font = '22px sans-serif';
  const max = Math.max(...Object.values(counts), 1);
  const bw = (W - 40) / zones.length;
  zones.forEach((z, i) => {
    const h = (counts[z] / max) * (H - 70);
    const x = 20 + i * bw + bw * 0.18;
    bctx.fillStyle = ZONE_HEX[z];
    bctx.fillRect(x, H - 34 - h, bw * 0.64, h);
    bctx.fillStyle = '#fff'; bctx.textAlign = 'center';
    bctx.fillText(String(counts[z]), x + bw * 0.32, H - 40 - h);
    bctx.fillStyle = 'rgba(255,255,255,.65)';
    bctx.fillText(ZONE_NAME[z] || z, x + bw * 0.32, H - 10);
  });
  // 环形图：用地面积占比
  const area = {};
  for (const b of data.blocks) {
    const { w, d } = bboxOf(b.polygon);
    area[b.zone] = (area[b.zone] || 0) + w * d;
  }
  const donut = $('#chart-donut'), dctx = donut.getContext('2d');
  dctx.clearRect(0, 0, donut.width, donut.height);
  const total = Object.values(area).reduce((s, v) => s + v, 0) || 1;
  let a0 = -Math.PI / 2;
  const cx = donut.width / 2, cy = donut.height / 2, R = 96, r = 58;
  for (const z of Object.keys(area)) {
    const a1 = a0 + (area[z] / total) * Math.PI * 2;
    dctx.beginPath(); dctx.moveTo(cx, cy);
    dctx.arc(cx, cy, R, a0, a1); dctx.arc(cx, cy, r, a1, a0, true); dctx.closePath();
    dctx.fillStyle = ZONE_HEX[z]; dctx.fill();
    a0 = a1;
  }
  dctx.fillStyle = '#fff'; dctx.font = 'bold 24px sans-serif'; dctx.textAlign = 'center';
  dctx.fillText(`${data.buildings.length} 栋`, cx, cy - 4);
  dctx.fillStyle = 'rgba(255,255,255,.6)'; dctx.font = '20px sans-serif';
  dctx.fillText('建筑总数', cx, cy + 24);
  $('#panel-legend').innerHTML = Object.keys(area).map((z) =>
    `<i style="background:${ZONE_HEX[z]}"></i>${ZONE_NAME[z] || z} ${Math.round((area[z] / total) * 100)}%`).join('　');
}
function buildLists(data) {
  const lmBox = $('#list-landmarks');
  lmBox.innerHTML = '';
  for (const lm of data.landmarks) {
    const b = document.createElement('button');
    b.className = 'item';
    b.innerHTML = `<span>${lm.name}</span><span>${lm.height_m} m</span>`;
    b.addEventListener('click', () => { stopTour(); flyTo(lm.x, lm.z, { dist: 380 }); toast(`飞往 ${lm.name}`); });
    lmBox.appendChild(b);
  }
  const zBox = $('#list-zones');
  zBox.innerHTML = '';
  const zoneCenter = {};
  for (const b of data.blocks) {
    const { cx, cz } = bboxOf(b.polygon);
    (zoneCenter[b.zone] = zoneCenter[b.zone] || []).push([cx, cz]);
  }
  const counts = {};
  for (const b of data.buildings) counts[b.zone] = (counts[b.zone] || 0) + 1;
  for (const z of Object.keys(zoneCenter)) {
    const pts = zoneCenter[z];
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const b = document.createElement('button');
    b.className = 'item';
    b.innerHTML = `<span>${ZONE_NAME[z] || z}</span><span>${counts[z] || 0} 栋</span>`;
    b.addEventListener('click', () => { stopTour(); flyTo(cx, cz, { dist: 620 }); toast(`飞往${ZONE_NAME[z] || z}`); });
    zBox.appendChild(b);
  }
}
// ---------- 六区图表 / 列表（柱状图按区楼数，环形图按区面积） ----------
const SIX_COLORS = ['#4f8ef7', '#f5a623', '#7bc47f', '#9b7ede', '#4caf6d', '#e26d5a'];
function drawChartsSix(six) {
  const dists = six.districts;
  const bar = $('#chart-bar'), bctx = bar.getContext('2d');
  const W = bar.width, H = bar.height;
  bctx.clearRect(0, 0, W, H);
  bctx.fillStyle = '#fff'; bctx.font = '22px sans-serif';
  const max = Math.max(...dists.map((d) => d.buildings), 1);
  const bw = (W - 40) / dists.length;
  dists.forEach((d, i) => {
    const h = (d.buildings / max) * (H - 70);
    const x = 20 + i * bw + bw * 0.18;
    bctx.fillStyle = SIX_COLORS[i % SIX_COLORS.length];
    bctx.fillRect(x, H - 34 - h, bw * 0.64, h);
    bctx.fillStyle = '#fff'; bctx.textAlign = 'center';
    bctx.fillText(String(d.buildings.toLocaleString()), x + bw * 0.32, H - 40 - h);
    bctx.fillStyle = 'rgba(255,255,255,.65)';
    bctx.fillText(d.name, x + bw * 0.32, H - 10);
  });
  const total = dists.reduce((s, d) => s + d.area_km2, 0) || 1;
  const donut = $('#chart-donut'), dctx = donut.getContext('2d');
  dctx.clearRect(0, 0, donut.width, donut.height);
  let a0 = -Math.PI / 2;
  const cx = donut.width / 2, cy = donut.height / 2, R = 96, r = 58;
  dists.forEach((d, i) => {
    const a1 = a0 + (d.area_km2 / total) * Math.PI * 2;
    dctx.beginPath(); dctx.moveTo(cx, cy);
    dctx.arc(cx, cy, R, a0, a1); dctx.arc(cx, cy, r, a1, a0, true); dctx.closePath();
    dctx.fillStyle = SIX_COLORS[i % SIX_COLORS.length]; dctx.fill();
    a0 = a1;
  });
  dctx.fillStyle = '#fff'; dctx.font = 'bold 24px sans-serif'; dctx.textAlign = 'center';
  dctx.fillText(`${six.counts.buildings.toLocaleString()} 栋`, cx, cy - 4);
  dctx.fillStyle = 'rgba(255,255,255,.6)'; dctx.font = '20px sans-serif';
  dctx.fillText('建筑总数', cx, cy + 24);
  $('#panel-legend').innerHTML = dists.map((d, i) =>
    `<i style="background:${SIX_COLORS[i % SIX_COLORS.length]}"></i>${d.name} ${Math.round((d.area_km2 / total) * 100)}%`).join('　');
}
function buildListsSix(six) {
  const lmBox = $('#list-landmarks');
  lmBox.innerHTML = '';
  for (const lm of six.landmarks) {
    const b = document.createElement('button');
    b.className = 'item';
    // 高度只标核实过的两座（揽星塔 339m、双星塔 218m），其余不写假数
    b.innerHTML = `<span>${lm.name}</span><span>${lm.height_m ? lm.height_m + ' m' : '地标'}</span>`;
    b.addEventListener('click', () => { stopTour(); flyTo(lm.x, lm.z, { dist: 380 }); toast(`飞往 ${lm.name}`); });
    lmBox.appendChild(b);
  }
  const zBox = $('#list-zones');
  zBox.innerHTML = '';
  for (const d of six.districts) {
    const b = document.createElement('button');
    b.className = 'item';
    b.innerHTML = `<span>${d.name}</span><span>${d.buildings.toLocaleString()} 栋</span>`;
    b.addEventListener('click', () => {
      stopTour();
      const dist = clamp(Math.sqrt(d.area_km2) * 1100, 4000, 14000);
      flyTo(d.center[0], d.center[1], { dist }); toast(`飞往${d.name}`);
    });
    zBox.appendChild(b);
  }
}
// 小地图（六区）：总览图预览当底图 + 地标点 + 玩家蓝点
function drawMinimapSix() {
  const cv = $('#minimap'), ctx = cv.getContext('2d');
  const W = cv.width, mm = sixIndex.minimap;
  const X = (x) => ((x - mm.x0) / (mm.x1 - mm.x0)) * W;
  const Z = (z) => ((mm.z1 - z) / (mm.z1 - mm.z0)) * W;
  ctx.fillStyle = '#dfe5ea'; ctx.fillRect(0, 0, W, W);
  if (minimapImg && minimapImg.complete && minimapImg.naturalWidth) {
    ctx.drawImage(minimapImg, 0, 0, W, W);
  }
  for (const lm of sixIndex.landmarks) {
    ctx.beginPath(); ctx.arc(X(lm.x), Z(lm.z), 5, 0, Math.PI * 2);
    ctx.fillStyle = '#e9a92c'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  const pp = state.mode === 'aerial' ? state.target : state.mode === 'drive' ? new THREE.Vector3(car.x, 0, car.z) : state.pos;
  ctx.beginPath(); ctx.arc(X(pp.x), Z(pp.z), 7, 0, Math.PI * 2);
  ctx.fillStyle = '#2f6fed'; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
}

function drawMinimap() {
  if (!DATA) return;
  if (sixMode) { drawMinimapSix(); return; }
  const cv = $('#minimap'), ctx = cv.getContext('2d');
  const W = cv.width, S = W / 2300; // 世界 ±1150 → 画布
  const X = (x) => (x + 1150) * S, Z = (z) => (z + 1150) * S;
  ctx.fillStyle = '#dfe5ea'; ctx.fillRect(0, 0, W, W);
  for (const b of DATA.blocks) {
    ctx.beginPath();
    b.polygon.forEach(([x, z], i) => { if (i === 0) ctx.moveTo(X(x), Z(z)); else ctx.lineTo(X(x), Z(z)); });
    ctx.closePath();
    ctx.fillStyle = ZONE_HEX[b.zone] + 'cc'; ctx.fill();
  }
  for (const w of DATA.water) {
    ctx.beginPath();
    w.polygon.forEach(([x, z], i) => { if (i === 0) ctx.moveTo(X(x), Z(z)); else ctx.lineTo(X(x), Z(z)); });
    ctx.closePath(); ctx.fillStyle = '#3f7fb8'; ctx.fill();
  }
  for (const r of DATA.roads) {
    ctx.beginPath();
    r.points.forEach(([x, z], i) => { if (i === 0) ctx.moveTo(X(x), Z(z)); else ctx.lineTo(X(x), Z(z)); });
    ctx.strokeStyle = r.kind === 'ring' || r.kind === 'avenue' ? '#ffffff' : '#b9bec4';
    ctx.lineWidth = r.kind === 'alley' ? 1 : r.kind === 'avenue' || r.kind === 'ring' ? 4 : 2;
    ctx.stroke();
  }
  for (const lm of DATA.landmarks) {
    ctx.beginPath(); ctx.arc(X(lm.x), Z(lm.z), 5, 0, Math.PI * 2);
    ctx.fillStyle = '#e9a92c'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // 玩家蓝点
  const pp = state.mode === 'aerial' ? state.target : state.mode === 'drive' ? new THREE.Vector3(car.x, 0, car.z) : state.pos;
  ctx.beginPath(); ctx.arc(X(pp.x), Z(pp.z), 7, 0, Math.PI * 2);
  ctx.fillStyle = '#2f6fed'; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
}
$('#minimap').addEventListener('click', (e) => {
  const r = e.target.getBoundingClientRect();
  if (sixMode) {
    const mm = sixIndex.minimap;
    const wx = mm.x0 + ((e.clientX - r.left) / r.width) * (mm.x1 - mm.x0);
    const wz = mm.z1 - ((e.clientY - r.top) / r.height) * (mm.z1 - mm.z0);
    stopTour();
    flyTo(wx, wz, { dist: 520 });
    return;
  }
  const wx = ((e.clientX - r.left) / r.width) * 2300 - 1150;
  const wz = ((e.clientY - r.top) / r.height) * 2300 - 1150;
  stopTour();
  flyTo(clamp(wx, -1050, 1050), clamp(wz, -1050, 1050), { dist: 520 });
});

// ---------- 主循环 ----------
let lastT = performance.now(), fpsEMA = 60, statTimer = 0, mapTimer = 0;
const _fwd = new THREE.Vector3(), _rgt = new THREE.Vector3();
function animate(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  fpsEMA = lerp(fpsEMA, 1 / Math.max(dt, 0.001), 0.05);

  if (state.playing) {
    let h = state.hour + dt * 0.25; // 24h 约 96 秒播完
    if (h >= 24) h -= 24;
    applyTime(h);
  }

  // 飞行插值
  if (flyAnim) {
    const t = clamp((now - flyAnim.start) / flyAnim.dur, 0, 1);
    const e = easeInOut(t);
    camera.position.lerpVectors(flyAnim.p0, flyAnim.p1, e);
    const look = new THREE.Vector3().lerpVectors(flyAnim.t0, flyAnim.t1, e);
    camera.lookAt(look);
    if (t >= 1) finishFlyAnim();
  } else if (state.mode === 'drive') {
    // 开车物理
    const fwdIn = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) + (joy.active ? -joy.y : 0);
    const backIn = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const steerIn = (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0)
      + (joy.active ? -joy.x : 0);
    if (fwdIn > 0) car.speed += 14 * fwdIn * dt;
    if (backIn > 0) car.speed -= (car.speed > 0.5 ? 26 : 8) * dt;
    car.speed -= car.speed * 0.55 * dt; // 阻力
    car.speed = clamp(car.speed, -6, sixMode ? 33 : 22); // 六区 120 km/h（他定的数）
    if (Math.abs(car.speed) > 0.05) car.heading += steerIn * 1.5 * dt * Math.sign(car.speed) * clamp(Math.abs(car.speed) / 8, 0.25, 1);
    car.x += Math.sin(car.heading) * car.speed * dt;
    car.z += Math.cos(car.heading) * car.speed * dt;
    const B = BOUNDS();
    if (car.x < B.x[0] || car.x > B.x[1] || car.z < B.z[0] || car.z > B.z[1]) { car.speed *= -0.2; car.x = clamp(car.x, B.x[0], B.x[1]); car.z = clamp(car.z, B.z[0], B.z[1]); }
    const gy = groundY(car.x, car.z);
    carGroup.position.set(car.x, gy, car.z);
    carGroup.rotation.y = car.heading;
    $('#drive-speed').textContent = `${Math.round(Math.abs(car.speed) * 3.6)} km/h`;
    if (state.carView === 'follow') {
      const bx = car.x - Math.sin(car.heading) * 15, bz = car.z - Math.cos(car.heading) * 15;
      camera.position.lerp(new THREE.Vector3(bx, gy + 6.5, bz), 1 - Math.pow(0.001, dt));
      camera.lookAt(car.x, gy + 1.6, car.z);
    } else {
      camera.position.set(car.x + Math.sin(car.heading) * 0.4, gy + 1.35, car.z + Math.cos(car.heading) * 0.4);
      camera.rotation.set(0, 0, 0);
      camera.rotateY(car.heading + Math.PI);
      camera.rotateX(-0.03);
    }
    if (camera.fov !== 62) { camera.fov = 62; camera.updateProjectionMatrix(); }
  } else if (state.mode === 'walk' || state.mode === 'fly') {
    // WASD / 摇杆移动；左右转（摇杆 X / A D），滑动本身只平移不转镜头
    const speed = state.mode === 'walk' ? (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 20 : 7) : (keys.has('ShiftLeft') ? 130 : 42);
    let fwd = 0, strafe = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
    if (keys.has('KeyQ') && state.mode === 'fly') state.pos.y = clamp(state.pos.y + 26 * dt, 8, 600);
    if (keys.has('KeyE') && state.mode === 'fly') state.pos.y = clamp(state.pos.y - 26 * dt, 8, 600);
    if (joy.active) { fwd += -joy.y; state.lookYaw += -joy.x * 1.7 * dt; }
    if (keys.has('KeyA') || keys.has('ArrowLeft')) state.lookYaw += 1.9 * dt;
    if (keys.has('KeyD') || keys.has('ArrowRight')) state.lookYaw -= 1.9 * dt;
    _fwd.set(-Math.sin(state.lookYaw), 0, -Math.cos(state.lookYaw));
    _rgt.set(-_fwd.z, 0, _fwd.x);
    state.pos.addScaledVector(_fwd, fwd * speed * dt);
    state.pos.addScaledVector(_rgt, strafe * speed * dt);
    if (state.mode === 'walk') state.pos.y = groundY(state.pos.x, state.pos.z) + 1.7;
    const B2 = BOUNDS();
    state.pos.x = clamp(state.pos.x, B2.x[0], B2.x[1]);
    state.pos.z = clamp(state.pos.z, B2.z[0], B2.z[1]);
    syncCamera();
  } else {
    // 航拍：WASD 平移目标点
    const panSpeed = state.dist * 0.55 * dt;
    const f = groundForward();
    const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    if (keys.has('KeyW') || keys.has('ArrowUp')) state.target.addScaledVector(f, panSpeed);
    if (keys.has('KeyS') || keys.has('ArrowDown')) state.target.addScaledVector(f, -panSpeed);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) state.target.addScaledVector(r, -panSpeed);
    if (keys.has('KeyD') || keys.has('ArrowRight')) state.target.addScaledVector(r, panSpeed);
    const B3 = BOUNDS();
    state.target.x = clamp(state.target.x, B3.x[0], B3.x[1]);
    state.target.z = clamp(state.target.z, B3.z[0], B3.z[1]);
    syncCamera();
  }

  // 六区流式加载（节流在 loader 内部，250ms）
  if (sixMode && sixLoader) {
    const view = state.mode === 'aerial'
      ? { tx: state.target.x, tz: state.target.z, camX: camera.position.x, camY: camera.position.y, camZ: camera.position.z, mode: 'aerial', aerialDist: state.dist }
      : state.mode === 'drive'
        ? { tx: car.x, tz: car.z, camX: camera.position.x, camY: camera.position.y, camZ: camera.position.z, mode: 'drive', aerialDist: 0 }
        : { tx: state.pos.x, tz: state.pos.z, camX: camera.position.x, camY: camera.position.y, camZ: camera.position.z, mode: state.mode, aerialDist: 0 };
    sixLoader.update(view);
  }

  if (state.bloom && composer) composer.render();
  else renderer.render(scene, camera);

  // 统计（每 0.5s）
  statTimer += dt;
  if (statTimer > 0.5) {
    statTimer = 0;
    $('#stat-fps').textContent = `${fpsEMA.toFixed(0)} FPS`;
    $('#stat-calls').textContent = renderer.info.render.calls;
    $('#stat-tris').textContent = renderer.info.render.triangles.toLocaleString();
    window.__sandboxStats = { fps: Math.round(fpsEMA), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, six: (sixMode && sixLoader) ? sixLoader.statsSnapshot() : null };
  }
  mapTimer += dt;
  if (mapTimer > 0.4) { mapTimer = 0; drawMinimap(); }
}

// ---------- 启动 ----------
async function loadData() {
  for (const url of ['../data/city.json', './data/city.json']) {
    try {
      const res = await fetch(url);
      if (res.ok) { const j = await res.json(); if (j && j.buildings && j.buildings.length) return j; }
    } catch (e) { /* try next */ }
  }
  return FALLBACK;
}
// ---------- 超过方案模块接线（总协调 2026-11-26 15:33 接线令） ----------
// 每个模块单独 try/catch：一个模块坏了只记失败，不阻断启动和其他模块。
// 顺序：塔 → 屋顶 → 路 → 街面/人 → 玩家车 → 太阳 → 天气 → 设置 → 地图。
// settings 依赖 __dWeather/__dSun（懒取），须在 weather/sun 之后 init。
// 不碰 sixLoader.setDisplay 共享材质切换逻辑（roofs 经包装链式调用）。
const WIRING = [
  ['tower-fix', './tower-fix.js'],
  ['roofs', './roofs.js'],
  ['roads', './roads.js'],
  ['street', './street.js'],
  ['people', './people.js'],
  ['playercar', './playercar.js'],
  ['sun', './sun.js'],
  ['weather', './weather.js'],
  ['settings', './settings.js'],
  ['maps', './maps.js'],
  ['perf', './perf.js'],
  ['skin', './skin.js'],
];
async function wireSurpassModules() {
  const res = { ok: [], stopped: [], failed: [] };
  for (const [name, url] of WIRING) {
    try {
      const m = await import(url);
      if (typeof m.init !== 'function') throw new Error('no init export');
      const r = await m.init(window.__sandbox);
      // skin.js 这类带 STOP 守卫的模块：init 返回 { ok:false, stopped }，不挂东西——记 stopped，不算失败
      if (r && r.stopped) { res.stopped.push({ name, stopped: r.stopped }); console.log('[wiring] stopped:', name, r.stopped); }
      else { res.ok.push(name); console.log('[wiring] ok:', name); }
    } catch (e) {
      res.failed.push({ name, error: String((e && e.message) || e) });
      console.error('[wiring] FAILED:', name, e);
    }
  }
  window.__wiring = res;
  console.log('[wiring] done:', JSON.stringify(res));
  return res;
}

async function init() {
  try {
    // 六区白模优先；six-index.json 不存在或损坏才走 city.json 程序化小城
    let six = null;
    for (const url of ['../data/six-index.json', './data/six-index.json']) {
      try {
        const res = await fetch(url);
        if (res.ok) { six = await res.json(); break; }
      } catch (e) { /* try next */ }
    }
    if (six && six.counts && six.landmarks && six.landmarks.length) {
      sixMode = true;
      await buildSix(six);
      DATA = {
        meta: { name: six.meta.name, version: six.meta.version, mock: false, six: true },
        buildings: [], roads: [], blocks: [], water: [], parks: [],
        landmarks: six.landmarks, districts: six.districts, terrain: { peaks: null },
      };
      // 城市数据面板、地标/分区列表已拿掉（13:47 令），不再画图表、不再建列表。
      drawMinimap();
      await wireSurpassModules();
      $('#stat-buildings').textContent = six.counts.buildings.toLocaleString();
      $('#stat-trees').textContent = six.counts.trees.toLocaleString();
      $('#mock-badge').style.display = 'none';
      $('#data-note').textContent = `六区白模 ${six.meta.version}：${six.counts.buildings.toLocaleString()} 栋楼 · ${six.counts.road_segs.toLocaleString()} 段路 · ${six.counts.stations} 个地铁站（572 实测口 + 446 推算口，未核对）· ${six.counts.landmarks} 个地标 · 桥 ${six.counts.bridge_segs} 段 · 路灯 ${six.counts.lamps.toLocaleString()} 盏 · 树 ${six.counts.trees.toLocaleString()} 棵`;
      applyTime(10);
      setDisplay('white'); // 默认白膜：白天航拍干净浅灰白块（16:28 令）；白模阶段夜里也不切回正常（17:06 令）
      syncCamera();
      await renderer.compileAsync(scene, camera);
      $('#loading-overlay').style.display = 'none';
      $('#start-overlay').style.display = 'flex';
      renderer.setAnimationLoop(animate);
      window.__sandboxStarted = true;
      console.log('[sandbox] six-districts mode:', six.counts);
      return;
    }
    DATA = normalizeData(await loadData());
    const counts = buildCity(DATA);
    drawMinimap();
    $('#stat-buildings').textContent = DATA.buildings.length;
    $('#stat-trees').textContent = counts.treeCount;
    // 数据说明：mock 还是真实数据，如实标
    const isMock = !!(DATA.meta && DATA.meta.mock);
    $('#mock-badge').style.display = isMock ? '' : 'none';
    $('#data-note').textContent = isMock
      ? `当前为 mock 数据：${DATA.buildings.length} 栋楼，等生成工人的真实 city.json 后替换`
      : `真实数据 v${(DATA.meta && DATA.meta.version) || '1.0'}：${DATA.buildings.length} 栋楼 · ${DATA.roads.length} 条路 · ${DATA.landmarks.length} 个地标 · 最高 ${Math.max(...DATA.buildings.map((b) => b.height_m))} m`;
    applyTime(10);
    syncCamera();
    await renderer.compileAsync(scene, camera);
    $('#loading-overlay').style.display = 'none';
    $('#start-overlay').style.display = 'flex';
    renderer.setAnimationLoop(animate);
    window.__sandboxStarted = true;
    if (DATA.meta && DATA.meta.mock) console.log('[sandbox] using MOCK city.json:', DATA.buildings.length, 'buildings');
  } catch (err) {
    console.error(err);
    $('#loading-overlay').style.display = 'none';
    $('#error-text').textContent = '初始化失败：' + (err && err.message ? err.message : err);
    $('#error-overlay').style.display = 'flex';
  }
}
$('#enter-btn').addEventListener('click', () => {
  $('#start-overlay').style.display = 'none';
  window.__sandboxStarted = true;
  toast('星泽市沙盘 · 拖动平移，点小地图飞过去');
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
});
init();
// surpass hook (2026-11-26): expose internals for the surpass modules
// (roofs/skin/roads/maps/tour/settings/weather/people/street/tower-fix/perf).
// Modules receive this ctx and must NOT edit app.js / six-loader.js / index.html.
window.__sandbox = {
  scene, camera, renderer, state, THREE,
  get sixLoader() { return sixLoader; },
  get sixIndex() { return sixIndex; },
  get DATA() { return DATA; },
  get composer() { try { return composer; } catch (e) { return null; } }
};
