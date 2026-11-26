// skin.js — A 路：楼皮（星泽市 · 游戏画面风格）
// ████████ 停（STOPPED 2026-11-26 14:10，林萧最新令，取代 14:02“马上贴图”）████████
// 贴图停了：本文件不要接线、不要 init，等他后面再说。init() 会直接返回
// { ok:false, stopped }，不挂任何材质、不出图。文件留着不删，恢复时把下面的
// STOPPED 守卫去掉即可（程序化 canvas 第一版 + FLUX 换图槽位都在里面，没动）。
// 做法（方案 §3.2 + 13:48 贴图四样）：不重建几何、不改包、不碰 app.js / six-loader.js。
//   ① 立面按高度带 + 分区上游戏画面风格色（低 #1B2340 / 中 #2A3358 / 高 #3A4A7A，
//      超高层玻璃幕墙单独一档 #46588A），用分块几何已有的顶点色通道做。
//      分块是非索引合并几何（POSITION/NORMAL/COLOR_0，无 UV）：立面三角面按所属楼栋
//      （顶面聚类出的 footprint bbox）定高度带；桥面/地面侧面不在任何 bbox 内，原色保留。
//   ② 夜晚发光窗：分块几何无 UV，canvas 贴图贴不上去——等价做法是 shader 窗格：
//      按世界坐标划窗（2.8m × 3.4m），位置哈希种子定亮/暗与三色（粉 #FF2E88 / 青 #00F0FF /
//      暖黄 #FFD166），只在立面（|ny|<0.45）生效；夜里 uNight=1，白天霓虹降 40%（uGlow=0.6）。
//      另加幕墙竖线辉光（y>30m）与超高层楼层线微光（玻璃反射近似）。
//   ③ canvas 贴图（贴图四样，程序化第一版，无缝：图案周期整除 256）：
//      楼立面 facadeAtlas（map + emissiveMap，三色亮窗）→ 底商灯箱条（有 UV 的新建几何）；
//      夜间亮窗 nightAtlas 与 facadeAtlas 同源（按窗洞生成，见 makeFacadeAtlas）。
//      屋面 roofTex 与铺装 pavingTex 在 roofs.js 里生成（同一套无缝做法），四样分工见 TEXTURE_SLOTS。
//      不用 gpt-image；FLUX 图集是二期——管线已备好（见 TEXTURE_SLOTS.flux），
//      换机之前不跑、不宣称已出图。
//   ④ 底商灯箱：H>=25m 的楼，底层南侧加一条带立面贴图的灯箱（合并成每块 1 个 mesh）。
//   ⑤ 白膜/热力：loader 切换材质时本模块不插手（白膜下霓虹收起）；normal 模式才挂 matSkin。
// 楼高口径：层数×3.2 + OSM 标签（v2.1）；顶高取分块几何实测顶面 y。
// 依赖：window.__sandbox（scene/THREE/sixLoader/sixIndex/state）。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---- 贴图槽位：四样现状 + FLUX 换图接口 ----
// FLUX 管线（已备好，未跑）：~/workspace/chengdu-city/skin/flux-10c-workflow.json
//   （ComfyUI，FLUX.2 klein 4B，img2img，steps=8，cfg=1.0，denoise=0.35，seed=1234567）。
//   GPU 纠正（13:58 实测）：他开的八核三十二G是 CPU 实例（dsw-y692m9ab40vtmwac3n），没显卡，
//   FLUX 跑不了；能跑的 24G GPU 实例停着，额度 14h23m，启动按钮是灰的（须先关 CPU 那台）；
//   24G 那台他自己来开，等他说开好了再上；他没说之前 FLUX 别动，别在 CPU 那台上硬跑。
//   出图后把 PNG 放进 app/textures-flux/，调 setFluxTextures({ facade, roof, paving, night })
//   即可换上（facade/night 本模块直接换；roof/paving 存在 window.__fluxTextureURLs 供 roofs.js 取）。
//   8 核 32G 是纯 CPU、没显卡，做不了贴图；192G 不许碰。
export const TEXTURE_SLOTS = {
  facade: { kind: '楼立面', status: 'canvas-procedural', owner: 'skin.js', flux: null },
  roof: { kind: '屋面', status: 'canvas-procedural', owner: 'roofs.js', flux: null },
  paving: { kind: '铺装', status: 'canvas-procedural', owner: 'roofs.js', flux: null },
  night: { kind: '夜间亮窗', status: 'canvas-procedural+shader', owner: 'skin.js', flux: null },
  flux: { status: 'not-run', note: 'FLUX.2 klein 4B 管线已备好；CPU 实例无显卡跑不了，24G 那台他自己来开，等他说开好了再上，未出图' },
};

const FACADE_BANDS = [
  { h: 12, c: [0x1b, 0x23, 0x40] },
  { h: 30, c: [0x2a, 0x33, 0x58] },
  { h: 80, c: [0x3a, 0x4a, 0x7a] },
  { h: 1e9, c: [0x46, 0x58, 0x8a] }, // 超高层：玻璃幕墙档
];

function splitmix(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}
function hash2(x, z) {
  let h = (Math.round(x * 10) * 73856093) ^ (Math.round(z * 10) * 19349663);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  return h;
}

// ---- canvas 贴图：楼立面 + 夜间亮窗（复用 app.js facadeTextures 的做法：8 列 × 14 行窗格，种子定亮窗）----
// 无缝：窗格 256/8=32、256/14 不整除——改 8 列 × 16 行（16px 一格），周期整除 256。
function makeFacadeAtlas() {
  const rnd = splitmix(11);
  const cMap = document.createElement('canvas'); cMap.width = cMap.height = 256;
  const cEmi = document.createElement('canvas'); cEmi.width = cEmi.height = 256;
  const m = cMap.getContext('2d'), e = cEmi.getContext('2d');
  m.fillStyle = '#1b2340'; m.fillRect(0, 0, 256, 256);
  const grad = m.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)'); grad.addColorStop(0.5, 'rgba(255,255,255,0)'); grad.addColorStop(1, 'rgba(255,255,255,0.08)');
  m.fillStyle = grad; m.fillRect(0, 0, 256, 256);
  e.fillStyle = '#000'; e.fillRect(0, 0, 256, 256);
  const cols = 8, rows = 16, ww = 256 / cols, hh = 256 / rows;
  const litColors = ['#ff2e88', '#00f0ff', '#ffd166'];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = c * ww + 5, y = r * hh + 3, w = ww - 10, h = hh - 6;
    m.fillStyle = 'rgba(10,14,28,0.9)'; m.fillRect(x, y, w, h);
    m.fillStyle = 'rgba(255,255,255,0.10)'; m.fillRect(x, y, w, 2);
    if (rnd() < 0.45) { e.fillStyle = litColors[Math.floor(rnd() * 3)]; e.fillRect(x, y, w, h); }
  }
  const map = new THREE.CanvasTexture(cMap);
  const emissiveMap = new THREE.CanvasTexture(cEmi);
  map.colorSpace = THREE.SRGBColorSpace; emissiveMap.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  emissiveMap.wrapS = emissiveMap.wrapT = THREE.RepeatWrapping;
  return { map, emissiveMap };
}

// ---- 顶面聚类（与 roofs.js 同法：共享顶点并查集；只为定每栋楼的高度带）----
function clusterTopFaces(geo) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  const idx = geo.index ? geo.index.array : null;
  const nTri = idx ? idx.length / 3 : pos.length / 9;
  const top = [];
  for (let t = 0; t < nTri; t++) {
    let ny = 0;
    for (let k = 0; k < 3; k++) ny += nrm[(idx ? idx[t * 3 + k] : t * 3 + k) * 3 + 1];
    if (ny / 3 > 0.85) top.push(t);
  }
  const parent = new Int32Array(nTri).fill(-1);
  const find = (a) => { let r = a; while (parent[r] >= 0) r = parent[r]; while (parent[a] >= 0) { const n = parent[a]; parent[a] = r; a = n; } return r; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const keyOwner = new Map();
  for (const t of top) {
    parent[t] = t;
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t * 3 + k] : t * 3 + k;
      const key = Math.round(pos[vi * 3] * 2) + ',' + Math.round(pos[vi * 3 + 2] * 2);
      const o = keyOwner.get(key);
      if (o === undefined) keyOwner.set(key, t); else union(t, o);
    }
  }
  const groups = new Map();
  for (const t of top) {
    const r = find(t);
    let g = groups.get(r);
    if (!g) { g = { x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9, topY: -1e9, area: 0 }; groups.set(r, g); }
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t * 3 + k] : t * 3 + k;
      const x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2];
      if (x < g.x0) g.x0 = x; if (x > g.x1) g.x1 = x;
      if (z < g.z0) g.z0 = z; if (z > g.z1) g.z1 = z;
      if (y > g.topY) g.topY = y;
    }
    const a = [pos[(idx ? idx[t * 3] : t * 3) * 3], pos[(idx ? idx[t * 3] : t * 3) * 3 + 2]];
    const b = [pos[(idx ? idx[t * 3 + 1] : t * 3 + 1) * 3], pos[(idx ? idx[t * 3 + 1] : t * 3 + 1) * 3 + 2]];
    const c = [pos[(idx ? idx[t * 3 + 2] : t * 3 + 2) * 3], pos[(idx ? idx[t * 3 + 2] : t * 3 + 2) * 3 + 2]];
    g.area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  const out = [];
  for (const g of groups.values()) {
    const w = g.x1 - g.x0, d = g.z1 - g.z0;
    if (g.area < 25 || Math.min(w, d) < 5) continue;
    out.push({ ...g, cx: (g.x0 + g.x1) / 2, cz: (g.z0 + g.z1) / 2, w, d, h: Math.max(0, g.topY - 3) });
  }
  out.sort((a, b) => b.area - a.area);
  return out.slice(0, 500);
}

let ctx = null, THREE_ = null;
let matSkin = null, matShop = null, facadeAtlas = null;
let skinUniforms = null;
let mode = 'normal';
let timer = null, nightTimer = null;
const processed = new WeakSet();
const S = {
  chunksProcessed: 0, chunksHighSkinned: 0, clusters: 0,
  facadeVertsTotal: 0, facadeVertsRecolored: 0, shopfronts: 0, shopfrontMeshes: 0,
  textures: { facade: 'canvas-procedural', roof: 'canvas-procedural(roofs.js)', paving: 'canvas-procedural(roofs.js)', night: 'canvas-procedural+shader' },
  flux: 'not-run (CPU 实例无显卡，等他说 24G 开好了再上，未出图)',
};

function bandColor(h, rng) {
  for (const b of FACADE_BANDS) {
    if (h < b.h) {
      const j = 0.95 + rng() * 0.10;
      return [Math.min(1, (b.c[0] / 255) * j), Math.min(1, (b.c[1] / 255) * j), Math.min(1, (b.c[2] / 255) * j)];
    }
  }
  return [0.27, 0.35, 0.54];
}

function makeSkinMaterial() {
  const mat = new THREE_.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.3 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = { value: 0 };
    shader.uniforms.uGlow = { value: 0.6 };
    shader.uniforms.uLit = { value: 0.45 };
    skinUniforms = shader.uniforms;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSkinWP; varying vec3 vSkinN;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvSkinWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSkinN = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSkinWP; varying vec3 vSkinN;\nuniform float uNight; uniform float uGlow; uniform float uLit;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  vec3 sN = normalize(vSkinN);
  if (abs(sN.y) < 0.45) {
    float su = abs(sN.x) > 0.5 ? vSkinWP.z : vSkinWP.x;
    float sv = vSkinWP.y;
    float col = floor(su / 2.8);
    float row = floor(sv / 3.4);
    float h1 = fract(sin(dot(vec2(col, row), vec2(12.9898, 78.233))) * 43758.5453);
    float h2 = fract(sin(dot(vec2(col, row), vec2(26.651, 11.135))) * 24634.6345);
    vec2 f = vec2(fract(su / 2.8), fract(sv / 3.4));
    float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.28, f.y) * step(f.y, 0.72);
    float lit = step(h1, uLit);
    vec3 wc = h2 < 0.4 ? vec3(1.0, 0.18, 0.53) : (h2 < 0.75 ? vec3(0.0, 0.94, 1.0) : vec3(1.0, 0.82, 0.40));
    totalEmissiveRadiance += win * lit * wc * uNight * 2.4;
    float stripe = step(fract(su / 13.0), 0.035) * step(30.0, sv);
    totalEmissiveRadiance += stripe * vec3(0.0, 0.94, 1.0) * uGlow * 1.7;
    float floorLine = step(fract(sv / 3.4), 0.06) * step(80.0, sv);
    totalEmissiveRadiance += floorLine * vec3(0.45, 0.65, 1.0) * uGlow * 0.35;
  }
}`);
  };
  return mat;
}

function processChunk(mesh, isHigh) {
  const geo = mesh.geometry;
  if (!geo || !geo.attributes.position || !geo.attributes.normal || !geo.attributes.color) return;
  const clusters = clusterTopFaces(geo);
  S.clusters += clusters.length;
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  const colAttr = geo.attributes.color.array;
  const idx = geo.index ? geo.index.array : null;
  const nTri = idx ? idx.length / 3 : pos.length / 9;
  // 立面重着色：侧面三角按形心落进哪个楼栋 bbox 定高度带（非索引几何才写顶点色）
  if (!idx) {
    for (let t = 0; t < nTri; t++) {
      let ny = 0, cx = 0, cz = 0;
      for (let k = 0; k < 3; k++) {
        const vi = t * 3 + k;
        ny += nrm[vi * 3 + 1]; cx += pos[vi * 3]; cz += pos[vi * 3 + 2];
      }
      ny /= 3; cx /= 3; cz /= 3;
      if (ny > 0.7 || ny < -0.7) continue; // 只动立面；顶面归 roofs.js
      S.facadeVertsTotal += 3;
      let best = null;
      for (const g of clusters) {
        if (cx >= g.x0 - 2 && cx <= g.x1 + 2 && cz >= g.z0 - 2 && cz <= g.z1 + 2) {
          if (!best || g.area < best.area) best = g;
        }
      }
      if (!best) continue;
      const rng = splitmix(hash2(best.cx, best.cz));
      const c = bandColor(best.h, rng);
      for (let k = 0; k < 3; k++) {
        const vi = t * 3 + k;
        colAttr[vi * 3] = c[0]; colAttr[vi * 3 + 1] = c[1]; colAttr[vi * 3 + 2] = c[2];
      }
      S.facadeVertsRecolored += 3;
    }
    geo.attributes.color.needsUpdate = true;
  }
  // 挂皮材质：只在近处 high 档块上生效（mid 远景只留顶点色，不花 shader 的钱）
  if (isHigh && mode === 'normal') {
    mesh.material = matSkin;
    S.chunksHighSkinned++;
  }
  // 底商灯箱：H>=25 的楼，底层南侧一条（每块合并成 1 个 mesh）
  if (isHigh && clusters.length) {
    let gy = 3;
    try { if (ctx.sixLoader && ctx.sixLoader.groundHeightAt) gy = ctx.sixLoader.groundHeightAt(clusters[0].cx, clusters[0].cz); } catch (e) { /* keep 3 */ }
    const geos = [];
    let n = 0;
    for (const g of clusters) {
      if (g.h < 25 || n >= 24) continue;
      const w = Math.min(g.w * 0.6, 40);
      const bg = new THREE_.BoxGeometry(w, 3.2, 0.5);
      const uv = bg.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(1, w / 7), uv.getY(i) * 1);
      bg.translate(g.cx, gy + 1.6, g.z1 + 0.35);
      geos.push(bg);
      n++;
    }
    if (geos.length) {
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      const m = new THREE_.Mesh(merged, matShop);
      m.matrixAutoUpdate = false;
      m.frustumCulled = true;
      m.name = 'skin-shopfronts';
      ctx.scene.add(m);
      S.shopfronts += n;
      S.shopfrontMeshes++;
    }
  }
}

function chunkLevelOf(mesh) {
  // mesh 往上找到 six-chunks 的直属子根，对照 loader 的 high/mid 判定档位
  if (!ctx.sixLoader || !ctx.sixLoader.chunkGroup) return false;
  let o = mesh;
  while (o && o.parent && o.parent !== ctx.sixLoader.chunkGroup) o = o.parent;
  if (!o || !ctx.sixLoader.chunks) return true;
  for (const e of ctx.sixLoader.chunks.values()) {
    if (e.high === o) return true;
    if (e.mid === o) return false;
  }
  return true;
}

function tick() {
  if (!ctx || !ctx.sixLoader || !ctx.sixLoader.chunkGroup) return;
  let budget = 4;
  const meshes = [];
  ctx.sixLoader.chunkGroup.traverse((o) => { if (o.isMesh && o.geometry) meshes.push(o); });
  for (const m of meshes) {
    if (budget <= 0) break;
    if (processed.has(m)) continue;
    processed.add(m);
    budget--;
    try { processChunk(m, chunkLevelOf(m)); S.chunksProcessed++; } catch (e) { console.error('[skin] chunk failed', e); }
  }
  syncNight();
  window.__skin = stats();
}

function syncNight() {
  const night = ctx && ctx.state ? (ctx.state.night || 0) : 0;
  if (skinUniforms) {
    skinUniforms.uNight.value = night;
    skinUniforms.uGlow.value = 0.6 + 0.4 * night; // 白天霓虹降 40% 但不断
  }
  if (matShop) matShop.emissiveIntensity = 0.15 + night * 1.6;
}

export function setDisplay(m) {
  mode = m || 'normal';
  // normal：已处理的 high 块挂回 matSkin；white/heat：loader 已换 clay/heat，本模块不插手
  if (mode === 'normal' && ctx && ctx.sixLoader && ctx.sixLoader.chunkGroup) {
    ctx.sixLoader.chunkGroup.traverse((o) => {
      if (o.isMesh && processed.has(o) && chunkLevelOf(o)) o.material = matSkin;
    });
  }
  syncNight();
  window.__skin = stats();
}

export function stats() {
  return { ...S, mode, textures: { ...S.textures }, flux: S.flux };
}

// FLUX 换图槽位：出图后调这个函数换上（facade/night 本模块直接换；
// roof/paving 存在 window.__fluxTextureURLs，供 roofs.js / 协调员取）。
export function setFluxTextures(slots) {
  console.warn('[skin] STOPPED 2026-11-26 14:10: FLUX 停了，等他后面再说');
  return { ok: false, stopped: '2026-11-26 14:10' };
}
export function setFluxTexturesParked(slots) {
  const loader = new THREE_.TextureLoader();
  const apply = (url, onTex) => {
    loader.load(url, (t) => {
      t.colorSpace = THREE_.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE_.RepeatWrapping;
      onTex(t);
    }, undefined, (e) => console.error('[skin] flux texture failed', url, e));
  };
  if (slots.facade) apply(slots.facade, (t) => { facadeAtlas.map = t; TEXTURE_SLOTS.facade.status = 'flux'; TEXTURE_SLOTS.facade.flux = slots.facade; S.textures.facade = 'flux:' + slots.facade; });
  if (slots.night) apply(slots.night, (t) => { facadeAtlas.emissiveMap = t; TEXTURE_SLOTS.night.status = 'flux'; TEXTURE_SLOTS.night.flux = slots.night; S.textures.night = 'flux:' + slots.night; });
  if (slots.roof || slots.paving) {
    window.__fluxTextureURLs = { ...(window.__fluxTextureURLs || {}), ...(slots.roof ? { roof: slots.roof } : {}), ...(slots.paving ? { paving: slots.paving } : {}) };
    if (slots.roof) { TEXTURE_SLOTS.roof.status = 'flux-pending(roofs.js)'; TEXTURE_SLOTS.roof.flux = slots.roof; }
    if (slots.paving) { TEXTURE_SLOTS.paving.status = 'flux-pending(roofs.js)'; TEXTURE_SLOTS.paving.flux = slots.paving; }
  }
  window.__skin = stats();
  return { ok: true };
}

export async function init(c) {
  console.warn('[skin] STOPPED 2026-11-26 14:10: 贴图停了，等他后面再说，不接线');
  return { ok: false, stopped: '2026-11-26 14:10' };
}
export async function initParked(c) {
  ctx = c; THREE_ = c.THREE;
  if (!THREE_ || !c.scene) throw new Error('[skin] ctx 缺 THREE/scene');
  facadeAtlas = makeFacadeAtlas();
  matSkin = makeSkinMaterial();
  matShop = new THREE_.MeshStandardMaterial({
    map: facadeAtlas.map, emissiveMap: facadeAtlas.emissiveMap,
    emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.6, metalness: 0.2,
  });
  // 跟着 loader 的显示切换走（包一层，不改 six-loader.js；与 roofs.js 的包链式工作）
  if (c.sixLoader && !c.sixLoader.__skinWrapped) {
    c.sixLoader.__skinWrapped = true;
    const orig = c.sixLoader.setDisplay.bind(c.sixLoader);
    c.sixLoader.setDisplay = (m) => { orig(m); setDisplay(m); };
  }
  tick();
  timer = setInterval(tick, 900);
  nightTimer = setInterval(syncNight, 500);
  window.__skin = stats();
  window.__skinTextureSlots = TEXTURE_SLOTS;
  console.log('[skin] init ok');
  return { ok: true };
}
