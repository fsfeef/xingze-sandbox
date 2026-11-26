// 性能：远山 + 城区地形运行时合并（E 路 · surpass §3.17）
// 远山 96 片、城区地形瓦片共用同一材质 matTerrain（MeshStandardMaterial，vertexColors），
// 运行时把它们克隆合并成 1 个网格，原瓦片隐藏（visible=false），不重建几何、不改 loader、不改包。
// 合并用 three/addons 的 BufferGeometryUtils.mergeGeometries（vendor 里已有，
// importmap "three/addons/" → ./vendor/addons/，three r170）；合并不成时走手动数组拼接兜底。
// loader 仍在管理瓦片的增删（视角移动时换片）：本模块每 1.5s 对一次签名，
// 瓦片集合变了就重建合并网格；原瓦片被 loader 卸掉时合并体不受影响（克隆的几何）。
// 用法（接线，见报告）：
//   const m = await import('./perf.js'); await m.init(window.__sandbox);
// 导出：init(ctx), setDisplay(mode)
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const POLL_MS = 1500;
let api = null;

export function setDisplay(mode) {
  if (api) api.setDisplay(mode);
}

export async function init(ctx) {
  const THREE = ctx.THREE;
  const scene = ctx.scene;
  const loader = ctx.sixLoader;
  if (!THREE || !scene || !loader) throw new Error('[perf] ctx missing THREE/scene/sixLoader');
  if (api) return api; // 幂等

  const clayMat = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.95, metalness: 0 });
  let merged = null;      // 合并后的唯一网格
  let mergedGeom = null;
  let lastSig = '';
  let lastStats = { far: 0, terrain: 0, mergedTriangles: 0, method: 'none', rebuilds: 0, lastRebuildAt: null };
  let timer = null;
  let display = 'normal';

  // 当前在 loader 管理下的地形类网格（key 不含 ':loading' 的占位）
  function trackedMeshes() {
    const out = [];
    for (const [key, v] of loader.far || []) {
      if (typeof key === 'string' && key.endsWith(':loading')) continue;
      if (v && v.isMesh) out.push({ kind: 'far', key, mesh: v });
    }
    for (const [key, v] of loader.terrain || []) {
      if (typeof key === 'string' && key.endsWith(':loading')) continue;
      if (v && v.isMesh) out.push({ kind: 'terrain', key, mesh: v });
    }
    return out;
  }
  function signature(list) {
    return list.map((e) => e.kind[0] + ':' + e.key).sort().join('|');
  }

  // 归一化一块几何：只留 position/normal/color（matTerrain 只要这三样），
  // 缺 normal 就算，缺 color 就补白；全部转非索引，保证 mergeGeometries 能拼。
  function normalize(geo) {
    let g = geo;
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'color'].includes(name)) g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.color) {
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3).fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    if (g.index) g = g.toNonIndexed();
    return g;
  }

  // 手动兜底：mergeGeometries 返回 null（属性不一致）时直接拼数组
  function manualMerge(geos) {
    let total = 0;
    for (const g of geos) total += g.attributes.position.count;
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    let o = 0;
    for (const g of geos) {
      const n = g.attributes.position.count;
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      col.set(g.attributes.color.array, o * 3);
      o += n;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return out;
  }

  function rebuild(list) {
    const geos = [];
    for (const { mesh } of list) {
      try {
        mesh.updateMatrix();
        const g = normalize(mesh.geometry.clone());
        g.applyMatrix4(mesh.matrix);
        geos.push(g);
      } catch (e) { console.warn('[perf] skip tile', e); }
    }
    if (!geos.length) return false;
    let mergedGeo = null;
    let method = 'none';
    try { mergedGeo = mergeGeometries(geos, false); method = 'BufferGeometryUtils.mergeGeometries'; } catch (e) { mergedGeo = null; }
    if (!mergedGeo) { mergedGeo = manualMerge(geos); method = 'manual-fallback'; }
    for (const g of geos) g.dispose();
    // 换掉旧合并体
    if (merged) { scene.remove(merged); merged.geometry.dispose(); merged = null; }
    if (mergedGeom) { mergedGeom.dispose(); mergedGeom = null; }
    mergedGeom = mergedGeo;
    merged = new THREE.Mesh(mergedGeom, display === 'white' ? clayMat : loader.matTerrain);
    merged.name = 'far-merged';
    merged.frustumCulled = false; // 合并体覆盖全城，不参与视锥剔除
    scene.add(merged);
    // 原瓦片隐藏：渲染器跳过 invisible 对象，draw call 随之消失；loader 仍管它们的增删
    for (const { mesh } of list) mesh.visible = false;
    const farN = list.filter((e) => e.kind === 'far').length;
    const terN = list.filter((e) => e.kind === 'terrain').length;
    lastStats = {
      far: farN, terrain: terN,
      mergedTriangles: Math.round(mergedGeom.attributes.position.count / 3),
      method, rebuilds: lastStats.rebuilds + 1, lastRebuildAt: new Date().toISOString(),
    };
    console.log('[perf] merged', JSON.stringify(lastStats));
    return true;
  }

  function tick() {
    const list = trackedMeshes();
    if (!list.length) return;
    const sig = signature(list);
    if (sig !== lastSig) {
      if (rebuild(list)) lastSig = sig;
    } else {
      // loader 新加的瓦片默认 visible=true：立即藏起来，避免与合并体重叠闪烁
      for (const { mesh } of list) if (mesh.visible) mesh.visible = false;
    }
  }

  timer = setInterval(tick, POLL_MS);
  tick();

  function stats() {
    const calls = ctx.renderer ? ctx.renderer.info.render.calls : null;
    return { ...lastStats, drawCallsNow: calls, mergedVisible: !!merged, signature: lastSig.slice(0, 80) };
  }

  function doSetDisplay(mode) {
    display = mode;
    if (merged) merged.material = mode === 'white' ? clayMat : loader.matTerrain;
  }

  api = {
    stats, setDisplay: doSetDisplay,
    dispose() {
      if (timer) clearInterval(timer);
      if (merged) { scene.remove(merged); merged.geometry.dispose(); merged = null; }
      clayMat.dispose();
      api = null;
    },
  };
  try { window.__perf = api; } catch (e) { /* non-browser */ }
  console.log('[perf] init: BufferGeometryUtils.mergeGeometries available, polling far+terrain');
  return api;
}
