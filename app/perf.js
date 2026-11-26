// 性能：远山 + 城区地形运行时合并 + 分块建筑/线/屋顶按瓦片合并 + 街面/路网合并（E 路 · surpass §3.17）
// 远山 96 片、城区地形瓦片共用同一材质 matTerrain（MeshStandardMaterial，vertexColors），
// 运行时把它们克隆合并成 1 个网格，原瓦片隐藏（visible=false），不重建几何、不改 loader、不改包。
// 分块建筑（每块 1 三角 mesh + 1 线 mesh，共享 matNormal/matLine）与屋顶
// （每块 1 solid + 1 neon mesh，共享 matSolid/matNeon）按 2000m 瓦片（4×4 分块）合并：
// 瓦片集合/LOD 档变了只重建变了的那片瓦片，loader 仍管增删，合并体只读克隆几何。
// 三角 mesh 全城 1 体（16 片→1，总共 17 万三角，任一片变了整体重建也便宜），线 mesh 全城 1 体（16→1）；
// 屋顶 solid/neon 仍按瓦片（重建代价大，单片 8 万三角，成组会放大单次重建）。
// 街面（surpass-street，93 对象→约 20 体）：InstancedMesh 烘焙成静态几何，按材质签名分组；
//   贴图招牌（22 面）拼一张 2048×1024 图集（透明/不透明各 1 体）；霓虹件（Basic 材质 +
//   带自发光的 Standard）单独成组，显隐跟 lampHeads 的 opacity 走（street.js 的 tick 每帧
//   写它：白膜/关灯时 opacity 归零＝霓虹该藏）；实例色变化（白膜切换）触发重建。
//   大实例集不烘焙（单 mesh 烘焙超 10 万三角就跳过，留原样）：InstancedMesh 本来就只有
//   1 个 draw call，烘焙不省调用，只把 2.7 万棵树展开成 250 万三角（≈340MB），
//   内存爆炸还拖垮 SwiftShader。
// 路网（roads-surpass，37→约 33 体）：只并 8 个静态无光面（按 polygonOffset 分组），
//   合并体共用源材质实例（_whitewash 漂白/setNight 自发光走共享实例传播）；行驶的 10 辆车
//   （车身+车灯，随 updateCars 每帧移动）不动；灯光池/雨层/路名牌不动。
// 霓虹合并体结论（2026-11-26 探针 5，绕开白膜锁直接调 __roofsApi.setDisplay('normal')）：
//   强制显示后 calls +18、tris +131.7 万——合并霓虹画得出来；白膜下它是被 roofs.js 按设计
//   藏掉的（neonGroup.visible=false），不是画不出来。之前诊断“26 个可见却不画”是 stale
//   帧读数 artifact，不是渲染 bug。
// 流式加载与合并的冲突点：loader 每 250ms 可能换档（high↔mid）或上下块，合并体按 1.5s
// 轮询签名重建——档位翻转后最多 1.5s 内合并体仍是旧档（只差细节档，不缺块、不闪黑洞）；
// 原 mesh 在合并建成后才藏（建成前继续画），重建失败时源 mesh 保持可见，不丢东西。
// 合并不成时走手动数组拼接兜底。
// mergeGeometries 报错根因（2026-11-26 夜验 2 条、塔点补测 4 条）：它内部先打
// console.error 再返回 null——调用前必须预检（见 precheckMerge，逐条对照 vendor 里
// 9 处 error：index 状态、属性名集/数量、morphTargetsRelative、morphAttributes、
// mergeAttributes 的数组类型/itemSize/normalized/gpuType），预检不过直接走 manualMerge，
// 绝不调 mergeGeometries，不让它有机会打 error。normalize 也剥掉 morphAttributes，
// 并修了 VEC4 颜色 normalized 时漏除 255/65535 的旧 bug。
// loader 仍在管理瓦片的增删（视角移动时换片）：本模块每 1.5s 对一次签名，
// 瓦片集合变了就重建合并网格；原瓦片被 loader 卸掉时合并体不受影响（克隆的几何）。
// 用法（接线，见报告）：
//   const m = await import('./perf.js'); await m.init(window.__sandbox);
// 导出：init(ctx), setDisplay(mode)
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const POLL_MS = 1500;
const TILE_CHUNKS = 4; // 2000m 一片瓦片
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
  let merged = null;      // 地形合并后的唯一网格
  let mergedGeom = null;
  let lastSig = '';
  let lastStats = { far: 0, terrain: 0, mergedTriangles: 0, method: 'none', rebuilds: 0, lastRebuildAt: null };
  let timer = null;
  let display = 'normal';

  // 瓦片合并态：tileKey -> { solid, neon }（tri 已全局、line 已全局，见下）
  const tileState = new Map();
  // 三角全城 1 体、线全城 1 体：各一条 syncKind 记录（三角总共 17 万，重建便宜；
  // 屋顶 solid 130 万仍按瓦片，成组会放大单次重建）
  let triGlobalState = null;
  let lineGlobalState = null;
  // 街面 / 路网合并态（见 syncStreet / syncRoads）
  let streetState = null;
  let roadsState = null;
  let streetCalls = 0, streetTris = 0, roadsCalls = 0, roadsTris = 0;
  const tileStats = {
    tiles: 0, triCalls: 0, lineCalls: 0, solidCalls: 0, neonCalls: 0,
    triTris: 0, solidTris: 0, neonTris: 0, hiddenChunkMeshes: 0, hiddenRoofMeshes: 0,
    rebuilds: 0, manualMerges: 0,
  };

  // ---------- 归一化 + 预检 + 手动拼接（地形/分块/屋顶共用） ----------
  // 归一化一块几何：只留 keep 里的属性，缺 normal 就算，缺 color 就补白；
  // 全部转非索引、全部转 Float32Array，否则 mergeGeometries 会因各瓦片属性数组
  // 类型不一致而报 console.error（GLB 的 COLOR_0 有的瓦片是 Float32、有的瓦片是
  // normalized Uint8，类型不一 merge 就失败；2026-11-26 诊断 2 报了 2 条正是这个）。
  // morphAttributes 直接剥掉：静态合并体不需要 morph，留着只会触发另一条校验分支。
  function normalize(geo, keep) {
    let g = geo;
    g.morphAttributes = {};
    g.morphTargetsRelative = false;
    for (const name of Object.keys(g.attributes)) {
      if (!keep.includes(name)) g.deleteAttribute(name);
    }
    // 交错属性先摊平（mergeGeometries 只认同类数组；摊平后一律 Float32）
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name];
      if (a && a.isInterleavedBufferAttribute) {
        const n = a.count, itemSize = a.itemSize;
        const max = a.normalized ? (a.array instanceof Uint16Array ? 65535 : 255) : 1;
        const out = new Float32Array(n * itemSize);
        for (let i = 0; i < n; i++) for (let j = 0; j < itemSize; j++) out[i * itemSize + j] = a.getComponent(i, j) / max;
        g.setAttribute(name, new THREE.BufferAttribute(out, itemSize));
      }
    }
    if (keep.includes('normal') && !g.attributes.normal) g.computeVertexNormals();
    if (keep.includes('color') && !g.attributes.color) {
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3).fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name];
      if (!a) continue;
      // color 有的瓦片是 VEC4（带 alpha）、有的是 VEC3：统一砍成 3 分量，
      // 否则 mergeGeometries 报 itemSize 不一致（诊断 3 的 2 条正是这个）。
      // 注意：normalized 整数数组要先除 255/65535 再砍，旧代码直接抄原值会把颜色抄成 0–255。
      if (name === 'color' && a.itemSize === 4) {
        const src = a.array;
        const max = a.normalized ? (src instanceof Uint16Array ? 65535 : 255) : 1;
        const out = new Float32Array((src.length / 4) * 3);
        for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
          out[j] = src[i] / max; out[j + 1] = src[i + 1] / max; out[j + 2] = src[i + 2] / max;
        }
        g.setAttribute(name, new THREE.BufferAttribute(out, 3));
        continue;
      }
      if (!(a.array instanceof Float32Array)) {
        const src = a.array;
        const max = a.normalized ? (src instanceof Uint16Array ? 65535 : 255) : 1;
        const out = new Float32Array(src.length);
        for (let i = 0; i < src.length; i++) out[i] = src[i] / max;
        g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
      }
    }
    return g;
  }

  // 预检：逐条复刻 vendor BufferGeometryUtils.mergeGeometries 里的 error 条件
  // （index 状态 / 属性名集 / 属性数量 / morphTargetsRelative / morphAttributes /
  //  mergeAttributes 的数组类型 / itemSize / normalized / gpuType / 交错）。
  // 任何一条不过就返回 { ok:false }，调用方直接走 manualMerge，绝不调 mergeGeometries。
  function precheckMerge(geos) {
    if (!geos.length) return { ok: false, reason: 'empty' };
    const g0 = geos[0];
    if (!g0.attributes.position || !g0.attributes.position.count) return { ok: false, reason: 'no-position' };
    const indexed = g0.index !== null;
    const names0 = Object.keys(g0.attributes).sort().join(',');
    const morph0 = Object.keys(g0.morphAttributes || {}).sort().join(',');
    for (let i = 0; i < geos.length; i++) {
      const g = geos[i];
      if ((g.index !== null) !== indexed) return { ok: false, reason: 'index-mismatch@' + i };
      if (!g.attributes.position || !g.attributes.position.count) return { ok: false, reason: 'no-position@' + i };
      if (Object.keys(g.attributes).sort().join(',') !== names0) return { ok: false, reason: 'attr-names@' + i };
      if (Object.keys(g.morphAttributes || {}).sort().join(',') !== morph0) return { ok: false, reason: 'morph-attrs@' + i };
      if (g.morphTargetsRelative !== g0.morphTargetsRelative) return { ok: false, reason: 'morph-relative@' + i };
      for (const name of Object.keys(g0.attributes)) {
        const a = g0.attributes[name], b = g.attributes[name];
        if (a.itemSize !== b.itemSize) return { ok: false, reason: 'itemSize:' + name + '@' + i };
        if (a.array.constructor !== b.array.constructor) return { ok: false, reason: 'array-type:' + name + '@' + i };
        if (!!a.normalized !== !!b.normalized) return { ok: false, reason: 'normalized:' + name + '@' + i };
        if ((a.gpuType ?? null) !== (b.gpuType ?? null)) return { ok: false, reason: 'gpuType:' + name + '@' + i };
        if (!!a.isInterleavedBufferAttribute !== !!b.isInterleavedBufferAttribute) return { ok: false, reason: 'interleaved:' + name + '@' + i };
      }
    }
    return { ok: true };
  }

  // 手动兜底：只合所有几何共有的属性（position 必有），属性不一致的直接丢掉那一项，
  // 不抛错、不打 console.error；类型已由 normalize 统一成 Float32。
  function manualMerge(geos) {
    const shared = Object.keys(geos[0].attributes).filter((name) =>
      geos.every((g) => g.attributes[name] && g.attributes[name].itemSize === geos[0].attributes[name].itemSize));
    if (!shared.includes('position')) throw new Error('[perf] manualMerge: no shared position');
    let total = 0;
    for (const g of geos) total += g.attributes.position.count;
    const out = new THREE.BufferGeometry();
    for (const name of shared) {
      const itemSize = geos[0].attributes[name].itemSize;
      const arr = new Float32Array(total * itemSize);
      let o = 0;
      for (const g of geos) {
        const a = g.attributes[name];
        let src = a.array;
        if (!(src instanceof Float32Array)) {
          const max = a.normalized ? (src instanceof Uint16Array ? 65535 : 255) : 1;
          const tmp = new Float32Array(src.length);
          for (let i = 0; i < src.length; i++) tmp[i] = src[i] / max;
          src = tmp;
        }
        arr.set(src, o * itemSize);
        o += a.count;
      }
      out.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
    }
    return out;
  }

  // 合并一批几何：预检过了才调 mergeGeometries；预检不过直接手动拼，不给它打 error 的机会
  function mergeBatch(geos) {
    const chk = precheckMerge(geos);
    if (chk.ok) {
      const g = mergeGeometries(geos, false);
      if (g) return { geometry: g, method: 'mergeGeometries' };
      // 预检过了仍返回 null（vendor 里未列出的分支）：不再调第二次，直接手动拼
      tileStats.manualMerges++;
      return { geometry: manualMerge(geos), method: 'manual-after-null' };
    }
    tileStats.manualMerges++;
    return { geometry: manualMerge(geos), method: 'manual-precheck:' + chk.reason };
  }

  // ---------- 远山 + 地形合并（原有逻辑，改走 mergeBatch） ----------
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

  function rebuildTerrain(list) {
    const geos = [];
    for (const { mesh } of list) {
      try {
        mesh.updateMatrix();
        const g = normalize(mesh.geometry.clone(), ['position', 'normal', 'color']);
        g.applyMatrix4(mesh.matrix);
        geos.push(g);
      } catch (e) { console.warn('[perf] skip tile', e); }
    }
    if (!geos.length) return false;
    const { geometry: mergedGeo, method } = mergeBatch(geos);
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

  // ---------- 分块建筑 / 线 / 屋顶：按 2000m 瓦片合并 ----------
  function tileOfKey(key) {
    const p = String(key).split('_');
    if (p.length !== 2) return null;
    const cx = Number(p[0]), cz = Number(p[1]);
    if (!isFinite(cx) || !isFinite(cz)) return null;
    return Math.floor(cx / TILE_CHUNKS) + '_' + Math.floor(cz / TILE_CHUNKS);
  }

  // 收集本轮要合的源 mesh。档位只认 loader.e.level，不认 mesh.visible——
  // 合并后源 mesh 会被藏起来（visible=false），再认 visible 下轮就认不出档位了。
  function collectTiles() {
    const tiles = new Map();
    const get = (tk) => {
      let t = tiles.get(tk);
      if (!t) { t = { tri: [], line: [], solid: [], neon: [] }; tiles.set(tk, t); }
      return t;
    };
    for (const [key, e] of loader.chunks) {
      const level = e.level || (e.high ? 'high' : e.mid ? 'mid' : null);
      const root = level === 'high' ? e.high : level === 'mid' ? e.mid : null;
      if (!root) continue;
      const tk = tileOfKey(key);
      if (!tk) continue;
      const t = get(tk);
      root.traverse((o) => {
        if (o.isMesh) t.tri.push({ key, level, mesh: o });
        else if (o.isLine) t.line.push({ key, level, mesh: o });
      });
    }
    const roofGroup = scene.getObjectByName('surpass-roofs');
    const neonGroup = scene.getObjectByName('surpass-roofs-neon');
    if (roofGroup) {
      for (const m of roofGroup.children) {
        if (!m.isMesh) continue;
        const key = String(m.name || '').replace(/^roofs-solid-/, '');
        const tk = tileOfKey(key);
        if (!tk) continue;
        get(tk).solid.push({ key, mesh: m });
      }
    }
    if (neonGroup) {
      for (const m of neonGroup.children) {
        if (!m.isMesh) continue;
        const key = String(m.name || '').replace(/^roofs-neon-/, '');
        const tk = tileOfKey(key);
        if (!tk) continue;
        get(tk).neon.push({ key, mesh: m });
      }
    }
    return { tiles, roofGroup, neonGroup };
  }

  function sigOf(entries) {
    return entries.map((e) => (e.key || '') + ':' + (e.level || '') + ':' + e.mesh.uuid).sort().join('|');
  }

  function buildMerged(entries, keep, material, isLine, name) {
    const geos = [];
    for (const { mesh } of entries) {
      try {
        mesh.updateWorldMatrix(true, false);
        const g = normalize(mesh.geometry.clone(), keep);
        g.applyMatrix4(mesh.matrixWorld);
        geos.push(g);
      } catch (e) { console.warn('[perf] skip source', e); }
    }
    if (!geos.length) return null;
    const { geometry, method } = mergeBatch(geos);
    for (const g of geos) g.dispose();
    geometry.computeBoundingSphere();
    const out = isLine ? new THREE.LineSegments(geometry, material) : new THREE.Mesh(geometry, material);
    out.name = name;
    out.frustumCulled = true; // 瓦片级包围球，屏幕外整片剔除
    out.matrixAutoUpdate = false;
    out.updateMatrix();
    return { merged: out, method, tris: Math.round(geometry.attributes.position.count / 3), sources: entries.length };
  }

  function dropKind(rec) {
    if (rec && rec.merged) {
      scene.remove(rec.merged);
      rec.merged.geometry.dispose();
    }
  }

  // 同步一种合并体：签名没变只换材质（白膜/热力切换不重建）；签名变了重建，
  // 建成了才藏源 mesh（建成前源 mesh 继续画，不闪；建不成源 mesh 留着，不丢东西）。
  function syncKind(prev, entries, keep, material, isLine, name) {
    const sig = sigOf(entries);
    if (prev && prev.sig === sig && prev.merged) {
      if (material && prev.merged.material !== material) prev.merged.material = material;
      return prev;
    }
    if (prev) dropKind(prev);
    if (!entries.length || !material) return { sig, merged: null, tris: 0 };
    const built = buildMerged(entries, keep, material, isLine, name);
    if (!built) return { sig, merged: null, tris: 0 };
    scene.add(built.merged);
    for (const { mesh } of entries) mesh.visible = false;
    tileStats.rebuilds++;
    console.log('[perf] tile', name, 'sources=' + built.sources, 'tris=' + built.tris, 'method=' + built.method);
    return { sig, merged: built.merged, tris: built.tris };
  }

  function repMat(entries) {
    for (const { mesh } of entries) if (mesh.material) return mesh.material;
    return null;
  }

  function syncMaterials(neonGroup) {
    const triMat = (typeof loader._triMat === 'function') ? loader._triMat() : loader.matNormal;
    if (triGlobalState && triGlobalState.merged && triMat && triGlobalState.merged.material !== triMat) triGlobalState.merged.material = triMat;
    for (const st of tileState.values()) {
      if (st.neon && st.neon.merged) {
        // 霓虹只跟 neonGroup 的显隐走（夜里亮、白天/白膜/热力藏），与源 mesh 的材质无关
        const want = neonGroup ? neonGroup.visible : true;
        if (st.neon.merged.visible !== want) st.neon.merged.visible = want;
      }
    }
    // 屋顶实体材质不走这里：每轮 syncKind 已用本瓦片源 mesh 的当前材质镜像
    // （白膜切换时 roofs.js 换源材质，合并体跟上，不自己算模式）。
  }

  // ---------- 通用小件：顶点色填充 / UV 重映射 / 材质结构签名 ----------
  // matSigShort 只含结构身份（类型/粗糙/金属/透明/面/顶点色/贴图有无/自发光/偏移），
  // 不含 color：street.js 的 tick 每帧改招牌材质 color（昼夜调光），roads 的 _whitewash
  // 改 color/vertexColors——那些走共享实例或镜像传播，不触发重建；含进来会每轮重建。
  function fillColor(g, r, gg, b) {
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = r; arr[i * 3 + 1] = gg; arr[i * 3 + 2] = b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  function remapUV(g, slot) {
    const uv = g.attributes.uv;
    if (!uv) return;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      uv.setXY(i, slot.u0 + u * (slot.u1 - slot.u0), slot.v0 + v * (slot.v1 - slot.v0));
    }
    uv.needsUpdate = true;
  }
  function matSigShort(m) {
    if (!m) return 'none';
    if (Array.isArray(m)) return 'ARRAY';
    return [m.type, m.roughness ?? '-', m.metalness ?? '-', m.transparent ? 1 : 0, m.opacity ?? 1,
      m.side ?? 0, m.vertexColors ? 1 : 0, m.map ? 1 : 0, m.emissive ? m.emissive.getHexString() : '-',
      m.emissiveIntensity ?? '-', m.polygonOffset ? 1 : 0, m.polygonOffsetFactor ?? 0,
      m.polygonOffsetUnits ?? 0].join('|');
  }

  // ---------- 街面 street 合并 ----------
  // 源：surpass-street 组下全部 Mesh/InstancedMesh（2 个 Points 不动）。
  // 霓虹判定：MeshBasicMaterial，或 Standard 但自发光非黑（红灯笼 mesh）——与 street.js
  // neonMeshes 列表一致（它把所有 Basic 件 + 红灯笼都推进去了）。
  // 显隐：源 mesh 被合并后藏起来（visible=false），street.js 的 setDisplay 再写它们的
  // visible 也读不出来——所以霓虹显隐不读源 mesh，读 lampHeads 的 opacity：
  // street.js 的 tick 每帧写它，白膜/关灯时归零＝霓虹该藏，正常时 ≥0.12＝该亮。
  function streetGroupKey(o) {
    const m = o.material || {};
    const neon = m.type === 'MeshBasicMaterial' || (m.emissive && m.emissive.getHex() !== 0);
    const tag = neon ? 'neon' : 'plain';
    if (m.map) return 'atlas|' + (m.transparent ? 't' : 'o') + '|' + tag;
    if (m.type === 'MeshBasicMaterial') {
      if (o.isInstancedMesh) return 'basic-inst|' + tag;
      return 'basic-plain|' + (m.transparent ? 't' : 'o') + '|' + (m.opacity ?? 1) + '|' + tag;
    }
    return 'std|' + (m.roughness ?? '-') + '|' + (m.metalness ?? '-') + '|' +
      (m.emissive ? m.emissive.getHexString() : '0') + '|' + (m.emissiveIntensity ?? '-') + '|' +
      (m.transparent ? 't' : 'o') + '|' + (m.opacity ?? 1) + '|' + tag;
  }
  function streetGroupMaterial(key, first, atlasTex) {
    const m = first.material;
    if (key.startsWith('atlas|')) {
      return new THREE.MeshBasicMaterial({ map: atlasTex, transparent: key.split('|')[1] === 't' });
    }
    if (key.startsWith('basic-')) {
      return new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: !!m.transparent, opacity: m.opacity ?? 1, side: m.side ?? 0 });
    }
    return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: m.roughness ?? 0.85, metalness: m.metalness ?? 0, emissive: m.emissive ? m.emissive.clone() : 0x000000, emissiveIntensity: m.emissiveIntensity ?? 1, vertexColors: true, transparent: !!m.transparent, opacity: m.opacity ?? 1, side: m.side ?? 0 });
  }
  // 烘焙一个街面源对象：InstancedMesh 按实例展开（世界矩阵×实例色），普通 Mesh 取世界矩阵。
  // 返回世界空间的归一化几何数组（调用方再 mergeBatch 一次并完）。
  function bakeStreetItem(o, uvSlot) {
    const keep = ['position', 'normal', 'color', 'uv'];
    o.updateWorldMatrix(true, false);
    if (o.isInstancedMesh) {
      const out = [];
      const m4 = new THREE.Matrix4();
      const tmp = new THREE.Matrix4();
      const col = new THREE.Color();
      const hasIC = !!o.instanceColor;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m4);
        const g = normalize(o.geometry.clone(), keep);
        g.applyMatrix4(tmp.multiplyMatrices(o.matrixWorld, m4));
        if (hasIC) { o.getColorAt(i, col); fillColor(g, col.r, col.g, col.b); }
        else fillColor(g, 1, 1, 1);
        out.push(g);
      }
      return out;
    }
    const g = normalize(o.geometry.clone(), keep);
    g.applyMatrix4(o.matrixWorld);
    const m = o.material;
    if (m && m.map && uvSlot) remapUV(g, uvSlot);
    else if (m && m.type === 'MeshBasicMaterial') fillColor(g, m.color.r, m.color.g, m.color.b);
    else fillColor(g, 1, 1, 1);
    return [g];
  }
  // 图集：全部贴图招牌（signTexture 画的 512×128 canvas）拼一张 2048×1024，
  // 每块 1:1 不缩放；flipY=true 的贴图，canvas 行顶对应 v1（见 v0/v1 算法）。
  function buildAtlas(items) {
    const SLOT_W = 512, SLOT_H = 128, COLS = 4;
    const rows = Math.max(1, Math.ceil(items.length / COLS));
    const cv = document.createElement('canvas');
    cv.width = COLS * SLOT_W; cv.height = rows * SLOT_H;
    const g2d = cv.getContext('2d');
    const slots = new Map();
    const sorted = [...items].sort((a, b) => (a.uuid < b.uuid ? -1 : 1));
    sorted.forEach((o, i) => {
      const col = i % COLS, row = Math.floor(i / COLS);
      const img = o.material.map.image;
      if (img) g2d.drawImage(img, col * SLOT_W, row * SLOT_H, SLOT_W, SLOT_H);
      const u0 = (col * SLOT_W) / cv.width, u1 = ((col + 1) * SLOT_W) / cv.width;
      const v1 = 1 - (row * SLOT_H) / cv.height, v0 = v1 - SLOT_H / cv.height;
      slots.set(o.uuid, { u0, v0, u1, v1 });
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { tex, slots };
  }
  function streetSig(items) {
    return items.map((o) => {
      let ic = '';
      if (o.isInstancedMesh && o.instanceColor) {
        const a = o.instanceColor.array, n = o.count;
        const idx = [0, Math.floor(n / 2), n - 1].filter((v, i, s) => s.indexOf(v) === i);
        ic = idx.map((k) => a[k * 3].toFixed(3) + ',' + a[k * 3 + 1].toFixed(3) + ',' + a[k * 3 + 2].toFixed(3)).join(';');
      }
      return o.uuid + '@' + (o.geometry ? o.geometry.uuid : '') + '@' + (o.isInstancedMesh ? o.count : 1) + '@' + matSigShort(o.material) + '@' + ic;
    }).sort().join('|');
  }
  function dropStreet() {
    if (!streetState) return;
    for (const gr of streetState.groups) {
      // 注意：只撤网格、只 dispose 几何，不 dispose 材质——app.js 开机时调
      // renderer.compileAsync 做着色器预编译，它的轮询读 materialProperties.currentProgram；
      // 此时 dispose 材质会把 currentProgram 置空，轮询里 program.isReady() 直接炸掉
      // （‘Cannot read properties of undefined (reading 'isReady')’），开机卡在
      // compileAsync 之前、连第一帧都渲不出来。材质不 dispose 只是留一个程序缓存
      // 项（同参数材质共用），重建又极少，忽略不计。
      if (gr.merged) { scene.remove(gr.merged); gr.merged.geometry.dispose(); }
    }
    if (streetState.atlasTex) streetState.atlasTex.dispose();
    streetState = null;
    streetCalls = 0; streetTris = 0;
  }
  function mirrorStreet(items) {
    if (!streetState) return;
    const g = scene.getObjectByName('surpass-street');
    const groupVis = g ? g.visible : true;
    // 霓虹开关：lampHeads 的 opacity 是 street.js tick 的输出，白膜时归零
    let neonOn = true;
    if (g) {
      const heads = g.getObjectByName('surpass-lamp-heads');
      if (heads && heads.material) neonOn = heads.material.opacity > 0.02;
    }
    for (const gr of streetState.groups) {
      const want = groupVis && (gr.neon ? neonOn : true);
      if (gr.merged.visible !== want) gr.merged.visible = want;
    }
    // 招牌调光：street.js 的 tick 把全部 shopSignMats 设成同一标量，镜像一份到图集材质
    let dim = null;
    for (const o of items) {
      if (o.material && o.material.map) { dim = o.material.color; break; }
    }
    if (dim) {
      for (const gr of streetState.groups) {
        if (gr.key.startsWith('atlas|') && gr.material.color) gr.material.color.copy(dim);
      }
    }
    // 灯晕/灯头 Points：opacity 归零时直接藏（street.js 的 tick 只改 opacity，不管显隐）
    if (g) {
      for (const p of g.children) {
        if (p.isPoints && p.material) {
          const want = p.material.opacity > 0.02;
          if (p.visible !== want) p.visible = want;
        }
      }
    }
  }
  function syncStreet() {
    const g = scene.getObjectByName('surpass-street');
    if (!g) return;
    const items = [];
    g.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.geometry) items.push(o); });
    if (!items.length) return;
    const sig = streetSig(items);
    if (streetState && streetState.sig === sig) { mirrorStreet(items); return; }
    dropStreet();
    const byKey = new Map();
    for (const o of items) {
      const k = streetGroupKey(o);
      let arr = byKey.get(k); if (!arr) { arr = []; byKey.set(k, arr); }
      arr.push(o);
    }
    const atlasItems = items.filter((o) => o.material && o.material.map);
    const atlas = atlasItems.length ? buildAtlas(atlasItems) : null;
    const groups = [];
    let calls = 0, tris = 0;
    for (const [key, arr] of byKey) {
      const geos = [];
      const baked = [];
      for (const o of arr) {
        // 大实例集（树之类）不烘焙：InstancedMesh 本来就只有 1 个 draw call，烘焙
        // 不省调用，只把实例数×几何三角全展开成静态几何（全城 2.7 万棵树约 250 万
        // 三角 ≈ 340MB），内存爆炸还拖垮 SwiftShader。留原样画，省内存不丢调用。
        if (o.isInstancedMesh) {
          const base = o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
          if (o.count * base > 100000) continue;
        }
        const slot = atlas ? atlas.slots.get(o.uuid) : null;
        let bakedGeos;
        try { bakedGeos = bakeStreetItem(o, slot); } catch (e) { console.warn('[perf] skip street source', e); continue; }
        geos.push(...bakedGeos);
        baked.push(o);
      }
      if (!geos.length) continue;
      const { geometry } = mergeBatch(geos);
      for (const gg of geos) gg.dispose();
      geometry.computeBoundingSphere();
      const material = streetGroupMaterial(key, arr[0], atlas ? atlas.tex : null);
      const merged = new THREE.Mesh(geometry, material);
      merged.name = 'street-merged-' + key.replace(/\|/g, '-');
      merged.frustumCulled = false; // 街面遍布全城，包围球无意义，关剔除
      merged.matrixAutoUpdate = false;
      merged.updateMatrix();
      scene.add(merged);
      for (const o of baked) o.visible = false;
      groups.push({ key, merged, material, sources: baked, neon: key.endsWith('|neon') });
      calls++;
      tris += Math.round(geometry.attributes.position.count / 3);
    }
    streetState = { sig, groups, atlasTex: atlas ? atlas.tex : null };
    streetCalls = calls; streetTris = tris;
    mirrorStreet(items);
    console.log('[perf] street merged groups=' + calls + ' tris=' + tris);
  }

  // ---------- 路网 roads 合并 ----------
  // 只并 roads-surpass 组直属的静态无光面（MeshBasicMaterial、无贴图、顶点色）：
  // 路面主/次、标线、桥面、桥霓虹、轨霓虹共 8 个，按 polygonOffset 分组。
  // 行驶的 10 辆车（车身+车灯在各自 Group 里，每帧 updateCars 移动）是孙子辈，直属
  // 筛选天然排除；灯光池/雨层带贴图或透明，排除；路名牌带贴图，排除。
  // 合并体共用源材质实例（不 clone）：_whitewash 漂白/setNight 自发光走共享实例传播，
  // 否则白膜下合并路会留彩色。显隐跟 roads 组走（热力图藏整组）。
  function roadsGroupKey(o) {
    const m = o.material || {};
    return 'basic|' + (m.polygonOffset ? 1 : 0) + '|' + (m.polygonOffsetFactor ?? 0) + '|' +
      (m.polygonOffsetUnits ?? 0) + '|' + (m.transparent ? 1 : 0) + '|' + (m.opacity ?? 1) + '|' + (m.side ?? 0);
  }
  function roadsSig(items) {
    return items.map((o) => o.uuid + '@' + (o.geometry ? o.geometry.uuid : '') + '@' + roadsGroupKey(o)).sort().join('|');
  }
  function dropRoads() {
    if (!roadsState) return;
    for (const gr of roadsState.groups) {
      if (gr.merged) { scene.remove(gr.merged); gr.merged.geometry.dispose(); }
    }
    roadsState = null;
    roadsCalls = 0; roadsTris = 0;
  }
  function syncRoads() {
    const g = scene.getObjectByName('roads-surpass');
    if (!g) return;
    const items = [];
    for (const o of g.children) {
      if (!o.isMesh || !o.geometry) continue;
      const m = o.material;
      // 注意：白膜 _whitewash 会把路材质的 vertexColors 改成 false、map 置空，
      // 所以不过滤 vertexColors/map 的当前值，只认结构身份；灯光池（Additive）、
      // 路名牌（DoubleSide）靠 blending/side 排除——它俩在白膜下 map 被置空，
      // 只看 map 会误并进来。
      if (!m || m.type !== 'MeshBasicMaterial' || m.map) continue;
      if ((m.side ?? 0) !== 0) continue;
      if (m.blending !== undefined && m.blending !== THREE.NormalBlending) continue;
      items.push(o);
    }
    if (!items.length) { if (roadsState) dropRoads(); return; }
    const sig = roadsSig(items);
    if (roadsState && roadsState.sig === sig) {
      const want = g.visible;
      for (const gr of roadsState.groups) if (gr.merged.visible !== want) gr.merged.visible = want;
      return;
    }
    dropRoads();
    const byKey = new Map();
    for (const o of items) {
      const k = roadsGroupKey(o);
      let arr = byKey.get(k); if (!arr) { arr = []; byKey.set(k, arr); }
      arr.push(o);
    }
    const groups = [];
    let calls = 0, tris = 0;
    for (const [key, arr] of byKey) {
      const geos = [];
      for (const o of arr) {
        try {
          o.updateWorldMatrix(true, false);
          const gg = normalize(o.geometry.clone(), ['position', 'normal', 'color', 'uv']);
          gg.applyMatrix4(o.matrixWorld);
          geos.push(gg);
        } catch (e) { console.warn('[perf] skip roads source', e); }
      }
      if (!geos.length) continue;
      const { geometry } = mergeBatch(geos);
      for (const gg of geos) gg.dispose();
      geometry.computeBoundingSphere();
      const merged = new THREE.Mesh(geometry, arr[0].material); // 共用源材质实例
      merged.name = 'roads-merged-' + key.replace(/\|/g, '-');
      merged.frustumCulled = false; // 路网遍布全城
      merged.matrixAutoUpdate = false;
      merged.updateMatrix();
      scene.add(merged);
      for (const o of arr) o.visible = false;
      groups.push({ key, merged, sources: arr });
      calls++;
      tris += Math.round(geometry.attributes.position.count / 3);
    }
    roadsState = { sig, groups };
    roadsCalls = calls; roadsTris = tris;
    console.log('[perf] roads merged groups=' + calls + ' tris=' + tris);
  }

  function tickTiles() {
    const { tiles, roofGroup, neonGroup } = collectTiles();
    const triMat = (typeof loader._triMat === 'function') ? loader._triMat() : loader.matNormal;
    const lineMat = loader.matLine;
    // 三角：全城 1 体（16 片→1，省 5 个调用；总共 17 万三角，任一片变了整
    // 体重建也便宜）。线：全城 1 体（16→1），任一瓦片线变了就重建（线总共 1 万三角）
    const allTri = [];
    for (const t of tiles.values()) allTri.push(...t.tri);
    triGlobalState = syncKind(triGlobalState, allTri, ['position', 'normal', 'color'], triMat, false, 'chunk-merged-tri-global');
    const allLines = [];
    for (const t of tiles.values()) allLines.push(...t.line);
    lineGlobalState = syncKind(lineGlobalState, allLines, ['position', 'color'], lineMat, true, 'chunk-merged-line-global');
    // 屋顶仍按瓦片（单片 8 万三角，成组会放大单次重建）
    for (const [tk, t] of tiles) {
      let st = tileState.get(tk);
      if (!st) { st = { solid: null, neon: null }; tileState.set(tk, st); }
      // 屋顶实体/霓虹的材质从本瓦片源 mesh 取（白膜时源 mesh 已被 roofs 换成陶土色，镜像即正确）
      st.solid = syncKind(st.solid, t.solid, ['position', 'normal', 'color', 'uv'], repMat(t.solid), false, 'roof-merged-solid-' + tk);
      st.neon = syncKind(st.neon, t.neon, ['position', 'normal', 'color', 'uv'], repMat(t.neon), false, 'roof-merged-neon-' + tk);
      if (st.neon && st.neon.merged && neonGroup) st.neon.merged.visible = neonGroup.visible;
    }
    // 瓦片消失（整片分块被卸掉）：撤掉它的屋顶合并体（三角组/线全局走上面的组清理）
    for (const [tk, st] of [...tileState.entries()]) {
      if (tiles.has(tk)) continue;
      dropKind(st.solid); dropKind(st.neon);
      tileState.delete(tk);
    }
    syncMaterials(neonGroup);
    try { syncStreet(); } catch (e) { console.warn('[perf] syncStreet failed', e); }
    try { syncRoads(); } catch (e) { console.warn('[perf] syncRoads failed', e); }
    // 统计（只计当前在场的合并体）
    let triCalls = 0, lineCalls = 0, solidCalls = 0, neonCalls = 0, triTris = 0, solidTris = 0, neonTris = 0;
    if (triGlobalState && triGlobalState.merged) { triCalls = 1; triTris = triGlobalState.tris || 0; }
    if (lineGlobalState && lineGlobalState.merged) lineCalls = 1;
    for (const st of tileState.values()) {
      if (st.solid && st.solid.merged) { solidCalls++; solidTris += st.solid.tris || 0; }
      if (st.neon && st.neon.merged && st.neon.merged.visible) { neonCalls++; neonTris += st.neon.tris || 0; }
    }
    tileStats.tiles = tileState.size;
    tileStats.triCalls = triCalls; tileStats.lineCalls = lineCalls;
    tileStats.solidCalls = solidCalls; tileStats.neonCalls = neonCalls;
    tileStats.triTris = triTris; tileStats.solidTris = solidTris; tileStats.neonTris = neonTris;
  }

  function tick() {
    const list = trackedMeshes();
    if (list.length) {
      const sig = signature(list);
      if (sig !== lastSig) {
        if (rebuildTerrain(list)) lastSig = sig;
      } else {
        // loader 新加的瓦片默认 visible=true：立即藏起来，避免与合并体重叠闪烁
        for (const { mesh } of list) if (mesh.visible) mesh.visible = false;
      }
    }
    try { tickTiles(); } catch (e) { console.warn('[perf] tickTiles failed', e); }
  }

  timer = setInterval(tick, POLL_MS);
  tick();

  function stats() {
    const calls = ctx.renderer ? ctx.renderer.info.render.calls : null;
    return {
      ...lastStats, drawCallsNow: calls, mergedVisible: !!merged, signature: lastSig.slice(0, 80),
      tiles: { ...tileStats, streetCalls, streetTris, roadsCalls, roadsTris, lineGlobal: lineGlobalState && lineGlobalState.merged ? 1 : 0 },
    };
  }

  function doSetDisplay(mode) {
    display = mode;
    if (merged) merged.material = mode === 'white' ? clayMat : loader.matTerrain;
    // 分块/屋顶合并体的材质不同步重建：下一轮 tick 的 syncKind/syncMaterials 会镜像源材质；
    // 这里立即同步一次，白膜切换不留一帧旧色
    try {
      const triMat = (typeof loader._triMat === 'function') ? loader._triMat() : loader.matNormal;
      if (triGlobalState && triGlobalState.merged && triMat) triGlobalState.merged.material = triMat;
      for (const st of tileState.values()) {
        if (st.solid && st.solid.merged) {
          const src = scene.getObjectByName('surpass-roofs');
          const rep = src && src.children.find((m) => m.isMesh && m.material);
          if (rep) st.solid.merged.material = rep.material;
        }
      }
    } catch (e) { /* 材质同步失败不阻断显示切换 */ }
  }

  api = {
    stats, setDisplay: doSetDisplay,
    dispose() {
      if (timer) clearInterval(timer);
      if (merged) { scene.remove(merged); merged.geometry.dispose(); merged = null; }
      dropKind(triGlobalState); triGlobalState = null;
      dropKind(lineGlobalState); lineGlobalState = null;
      for (const st of tileState.values()) {
        dropKind(st.solid); dropKind(st.neon);
      }
      tileState.clear();
      dropStreet();
      dropRoads();
      // 还原：分块按 loader 当前档位恢复显隐，屋顶全部恢复可见
      for (const [, e] of loader.chunks) {
        const level = e.level || (e.high ? 'high' : e.mid ? 'mid' : null);
        for (const lvl of ['high', 'mid']) {
          const root = e[lvl];
          if (!root) continue;
          root.traverse((o) => { if (o.isMesh || o.isLine) o.visible = (lvl === level); });
        }
      }
      for (const gname of ['surpass-roofs', 'surpass-roofs-neon']) {
        const g = scene.getObjectByName(gname);
        if (g) g.traverse((o) => { if (o.isMesh) o.visible = true; });
      }
      for (const gname of ['surpass-street', 'roads-surpass']) {
        const g = scene.getObjectByName(gname);
        if (g) g.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isPoints) o.visible = true; });
      }
      clayMat.dispose();
      api = null;
    },
  };
  try { window.__perf = api; } catch (e) { /* non-browser */ }
  console.log('[perf] init: BufferGeometryUtils.mergeGeometries available, polling far+terrain+tiles');
  return api;
}
