// 339电视塔修复（E 路 · surpass §3.4②）
// 程序化重建 339m 塔，盖住六区包里只有 113m 的旧几何；不改包、不拆包。
// 游戏画面风格配色：冷蓝紫塔身 + 电青 #00F0FF 霓虹环 + 品红 #FF2E88 发光塔尖。
// 用法（接线，见报告）：
//   const m = await import('./tower-fix.js'); await m.init(window.__sandbox);
// 导出：init(ctx), setDisplay(mode), measure()
const TOWER = { x: 2492.5, z: -179.1, height: 339 };
const C = {
  body: 0x2a3358, deck: 0x3a4a7a, mast: 0x1b2340,
  cyan: 0x00f0ff, magenta: 0xff2e88, clay: 0xf2f0ea,
};

let api = null;

export function measure() {
  if (!api) return { ok: false, error: 'tower-fix not initialised' };
  return api.measure();
}

export function setDisplay(mode) {
  if (api) api.setDisplay(mode);
}

export async function init(ctx) {
  const THREE = ctx.THREE;
  const scene = ctx.scene;
  const loader = ctx.sixLoader;
  if (!THREE || !scene) throw new Error('[tower-fix] ctx missing THREE/scene');
  if (api) return api; // 幂等：重复 init 不再建第二座塔

  // 地面高：走 loader 的地形射线；射不到用平原兜底 3.0（与 loader 一致）
  let groundY = 3.0;
  try {
    if (loader && typeof loader.groundHeightAt === 'function') {
      groundY = loader.groundHeightAt(TOWER.x, TOWER.z);
    }
  } catch (e) { console.warn('[tower-fix] groundHeightAt failed, use 3.0', e); }
  if (!isFinite(groundY)) groundY = 3.0;

  const bodyMat = new THREE.MeshStandardMaterial({
    color: C.body, roughness: 0.55, metalness: 0.35, emissive: 0x141a33, emissiveIntensity: 0.6,
  });
  const deckMat = new THREE.MeshStandardMaterial({
    color: C.deck, roughness: 0.5, metalness: 0.4, emissive: 0x1b2340, emissiveIntensity: 0.6,
  });
  const mastMat = new THREE.MeshStandardMaterial({
    color: C.mast, roughness: 0.45, metalness: 0.5, emissive: 0x0b1026, emissiveIntensity: 0.8,
  });
  const ringMat = new THREE.MeshBasicMaterial({ color: C.cyan });
  const tipMat = new THREE.MeshBasicMaterial({ color: C.magenta });
  // 材质口径（threejs-materials-lighting）：塔身用 MeshStandardMaterial（受光），
  // 霓虹环/发光塔尖用 MeshBasicMaterial（不吃光的纯色发光体）；高度用 Box3 量
  // （threejs-gltf-loading Pattern 1：量包围盒报尺寸，见 measure()）
  const clayMat = new THREE.MeshStandardMaterial({ color: C.clay, roughness: 0.95, metalness: 0 });

  const group = new THREE.Group();
  group.name = 'tower-339-fix';

  // 各段均为相对高度（y0 = 地面），顶端精确落在 339m
  const bodyParts = []; // 白膜模式要换 clay 的部件
  const rings = [];     // 白膜模式要藏起来的霓虹环
  function addPart(geo, mat, y, list) {
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    m.userData.mat = mat;
    group.add(m);
    (list || bodyParts).push(m);
    return m;
  }
  function addRing(y, radius, tube) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 48), ringMat);
    m.rotation.x = Math.PI / 2;
    m.position.y = y;
    group.add(m);
    rings.push(m);
    return m;
  }

  // 底座：0–16m，下口半径 42m —— 包住原 113m 旧塔的塔基与塔身下段
  addPart(new THREE.CylinderGeometry(30, 42, 16, 16), bodyMat, 8);
  // 收分主塔身：16–170m，30 → 15m（旧塔 113m 全高都在此段半径内）
  addPart(new THREE.CylinderGeometry(15, 30, 154, 16), bodyMat, 93);
  // 塔楼 1：170–184m，半径 21m
  addPart(new THREE.CylinderGeometry(21, 21, 14, 16), deckMat, 177);
  // 上塔身：184–256m，14 → 8m
  addPart(new THREE.CylinderGeometry(8, 14, 72, 16), bodyMat, 220);
  // 塔楼 2：256–270m，半径 15m
  addPart(new THREE.CylinderGeometry(15, 15, 14, 16), deckMat, 263);
  // 天线杆：270–328m，7 → 1.2m
  addPart(new THREE.CylinderGeometry(1.2, 7, 58, 12), mastMat, 299);
  // 发光塔尖：328–339m，品红，顶端精确 339m（杆顶 328m 与尖底 328m 对接，无悬空缝）
  const tip = addPart(new THREE.CylinderGeometry(0.05, 1.2, 11, 12), tipMat, 333.5);

  // 电青霓虹环：底座顶、两座塔楼上下沿、天线杆根
  addRing(16, 31, 0.8);
  addRing(170, 21.5, 0.8);
  addRing(184, 21.5, 0.8);
  addRing(256, 15.5, 0.7);
  addRing(270, 15.5, 0.7);
  addRing(328, 2.0, 0.5);

  group.position.set(TOWER.x, groundY, TOWER.z);
  scene.add(group);

  function doMeasure() {
    const box = new THREE.Box3().setFromObject(group);
    const topY = box.max.y;
    const height = topY - groundY;
    return {
      ok: true, groundY: +groundY.toFixed(2), topY: +topY.toFixed(2),
      height: +height.toFixed(2), target: TOWER.height,
      error: +(height - TOWER.height).toFixed(2),
      within5m: Math.abs(height - TOWER.height) <= 5,
    };
  }

  function doSetDisplay(mode) {
    const white = mode === 'white';
    for (const m of bodyParts) m.material = white ? clayMat : m.userData.mat;
    tip.material = white ? clayMat : tipMat;
    for (const r of rings) r.visible = !white;
  }

  api = {
    group, groundY, target: TOWER.height,
    measure: doMeasure, setDisplay: doSetDisplay,
    dispose() {
      scene.remove(group);
      group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      for (const m of [bodyMat, deckMat, mastMat, ringMat, tipMat, clayMat]) m.dispose();
      api = null;
    },
  };
  // 挂到 window 供 headless 验证直接量
  try { window.__towerFix = api; } catch (e) { /* non-browser */ }
  console.log('[tower-fix] built at', TOWER.x, TOWER.z, 'groundY=', groundY.toFixed(2),
    'measured=', JSON.stringify(doMeasure()));
  return api;
}
