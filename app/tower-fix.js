// 339电视塔重建（2026-11-27 塑形 v2：按实拍剪影，不再是扁盒子/蓝板）
// 天府熊猫塔（四川广播电视塔 / 锦绣天府塔），总高 339m，成华区猛追湾。
// 实测尺寸来源（bang.cn 天府熊猫塔介绍 + zh/en Wikipedia 天府熊猫塔）：
//   塔高 339m；天线桅杆 87.5m（257m 机房平台上）；屋顶 257m；顶楼 230m；
//   观光层：室内 208m / 室外 218m；上塔楼 204–218m 区域，10 层，高 46m，最大直径 36m；
//   塔身长 153m；塔座高 49.7m，其中基台 63×63m 方形、高 15.4m，共三层；
//   下塔楼（发射机房）为扁正锥台，悬在四根斜撑之间，高 28m、六层，最大直径 54m，
//   17.2m 层设 2m 宽环形参观走道；塔身为四肢状、八边形外附四条腿，
//   四条腿沿斜线向上收分——面对任意一根斜撑看去呈“川”字；
//   上塔楼为正锥台（幕墙向下倾斜），两个“蘑菇/盖碗茶”形塔楼是全塔最认的特征。
// 几何（相对高度，地面 y0；顶端精确 339m，measure 误差 0）：
//   方基台 63×63×15.4（0–15.4）→ 四斜腿（2–52m，向内收）→
//   环形走道盘 R28（16.2–17.2）→ 下塔楼扁锥台 R20→R27（17.2–45.2，Ø54m）→
//   八边形主塔身 R13→R9（50–203，153m）→
//   上塔楼下锥台 R12→R18（204–218）→ 室外观光平台盘 R19（217.6–218.8）→
//   上塔楼上锥台 R18→R13（218–232）→ 收分段 R13→R10（232–250）→
//   机房顶 R10→R8（250–257）→ 天线桅杆 R3→R0.8（257–336）→ 塔尖锥 R0.8→0.05（336–339）。
// 颜色：只用白膜灰系——默认模式浅灰混凝土（不再是深蓝板 + 电青霓虹环 + 品红塔尖，
//   那套配色已随旧扁盒子一起撤掉）；白膜模式换陶土色 clay，与六区白膜同口径。
//   不上色、不贴图：两档都是纯色标准材质，形靠几何。
// 用法（接线，见报告）：
//   const m = await import('./tower-fix.js'); await m.init(window.__sandbox);
// 导出：init(ctx), setDisplay(mode), measure()
const TOWER = { x: 2492.5, z: -179.1, height: 339 };
const C = {
  concrete: 0xd9d9d4, // 浅灰混凝土（默认模式）
  disc: 0xcfcfc9,     // 两座塔楼略深一档，剪影分层
  mast: 0xc4c4be,     // 天线杆略深
  clay: 0xf2f0ea,     // 白膜陶土色
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

  const concreteMat = new THREE.MeshStandardMaterial({ color: C.concrete, roughness: 0.9, metalness: 0 });
  const discMat = new THREE.MeshStandardMaterial({ color: C.disc, roughness: 0.9, metalness: 0 });
  const mastMat = new THREE.MeshStandardMaterial({ color: C.mast, roughness: 0.85, metalness: 0.05 });
  const clayMat = new THREE.MeshStandardMaterial({ color: C.clay, roughness: 0.95, metalness: 0 });

  const group = new THREE.Group();
  group.name = 'tower-339-fix';

  const bodyParts = []; // 白膜模式要换 clay 的部件
  function addPart(geo, mat, y) {
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    m.userData.mat = mat;
    group.add(m);
    bodyParts.push(m);
    return m;
  }
  // 圆台/圆柱段：rTop, rBottom, y0, y1, segments, mat
  function frustum(rTop, rBottom, y0, y1, seg, mat) {
    return addPart(new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, seg), mat, (y0 + y1) / 2);
  }

  // 方基台：63×63m，高 15.4m（实测），0–15.4m
  addPart(new THREE.BoxGeometry(63, 15.4, 63), concreteMat, 7.7);
  // 四条斜腿：从基台四角 (±26, 2) 向内收到 (±10, 52)，四边形截面梁（实测“四肢状、八边形外附四条腿”）
  {
    const up = new THREE.Vector3(0, 1, 0);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const p0 = new THREE.Vector3(sx * 26, 2, sz * 26);
      const p1 = new THREE.Vector3(sx * 10, 52, sz * 10);
      const dir = p1.clone().sub(p0);
      const len = dir.length();
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 3.4, len, 4), concreteMat);
      leg.position.copy(p0).add(p1).multiplyScalar(0.5);
      leg.quaternion.setFromUnitVectors(up, dir.clone().normalize());
      leg.rotateY(Math.PI / 4); // 方截面外表面朝外
      leg.userData.mat = concreteMat;
      group.add(leg);
      bodyParts.push(leg);
    }
  }
  // 环形参观走道盘：R28，16.2–17.2m（实测 17.2m 层 2m 宽环形走道）
  frustum(28, 28, 16.2, 17.2, 24, discMat);
  // 下塔楼（发射机房）：扁正锥台，R20→R27，17.2–45.2m（实测高 28m，最大直径 54m）
  frustum(27, 20, 17.2, 45.2, 24, discMat);
  // 八边形主塔身：R13→R9，50–203m（实测塔身长 153m）
  frustum(9, 13, 50, 203, 8, concreteMat);
  // 上塔楼下锥台（正锥台，向上外扩）：R12→R18，204–218m（实测最大直径 36m）
  frustum(18, 12, 204, 218, 16, discMat);
  // 室外观光平台盘：R19，217.6–218.8m（实测 218m 室外观光层）
  frustum(19, 19, 217.6, 218.8, 24, discMat);
  // 上塔楼上锥台：R18→R13，218–232m（顶楼 230m 在此段）
  frustum(13, 18, 218, 232, 16, discMat);
  // 收分段：R13→R10，232–250m
  frustum(10, 13, 232, 250, 16, concreteMat);
  // 机房顶：R10→R8，250–257m（实测屋顶 257m）
  frustum(8, 10, 250, 257, 12, concreteMat);
  // 天线桅杆：R3→R0.8，257–336m（实测桅杆 87.5m，257m 平台上）
  frustum(0.8, 3.0, 257, 336, 12, mastMat);
  // 塔尖锥：R0.8→0.05，336–339m，顶端精确 339m
  frustum(0.05, 0.8, 336, 339, 12, mastMat);

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
  }

  api = {
    group, groundY, target: TOWER.height,
    measure: doMeasure, setDisplay: doSetDisplay,
    dispose() {
      scene.remove(group);
      group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      for (const m of [concreteMat, discMat, mastMat, clayMat]) m.dispose();
      api = null;
    },
  };
  // 挂到 window 供 headless 验证直接量
  try { window.__towerFix = api; } catch (e) { /* non-browser */ }
  console.log('[tower-fix] built at', TOWER.x, TOWER.z, 'groundY=', groundY.toFixed(2),
    'measured=', JSON.stringify(doMeasure()));
  return api;
}
