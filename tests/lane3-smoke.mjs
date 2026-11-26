// lane3-smoke.mjs — 3 路第二段 Node 逻辑冒烟（不依赖浏览器）
// 验：people 64 人（48 原拨 + 16 生活拨，四种姿态各 4）、street 16 地标街面计数、
// playercar 表盘读数/指针/夜光 + tris 口径（顶点数/3 == stats.tris）。
import fs from 'node:fs';

const VENDOR = '/home/hatch/workspace/virtual-city/app/vendor';
const importMap = {
  imports: {
    three: VENDOR + '/three.module.js',
    'three/addons/utils/BufferGeometryUtils.js': VENDOR + '/addons/utils/BufferGeometryUtils.js',
  },
};
fs.writeFileSync('/tmp/lane3-importmap.json', JSON.stringify(importMap));

// ---- 最小 DOM stub ----
const gradStub = { addColorStop() {} };
const ctx2d = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradStub;
    if (prop === 'measureText') return () => ({ width: 0 });
    if (prop === 'getImageData') return () => ({ data: [] });
    return () => {};
  },
  set() { return true; },
});
const fakeCanvas = () => {
  const cv = { width: 0, height: 0, getContext: () => ctx2d, toDataURL: () => '' };
  return cv;
};
globalThis.window = {};
globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : { style: {} }),
  getElementById: () => null,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.self = globalThis;

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures.push(name);
};

const THREE = await import('three');
const sceneChildren = [];
const fakeScene = {
  add(o) { sceneChildren.push(o); },
  traverse() { /* 场景里没有 app.js 的车组，走 standalone 兜底 */ },
};
const ctx = {
  THREE, scene: fakeScene,
  sixLoader: { groundHeightAt: () => 3.0 },
  state: { night: 1 },
};

// ---------- people ----------
const people = await import('./people.js');
const pRet = people.init(ctx);
check('people count=64', pRet.count === 64, `count=${pRet.count} base=${pRet.baseCount} life=${pRet.lifeCount} total=${pRet.total}`);
check('people baseCount=48', pRet.baseCount === 48);
check('people lifeCount=16', pRet.lifeCount === 16);
const life = window.__people.getLifePositions();
const byKind = {};
for (const l of life) byKind[l.life] = (byKind[l.life] || 0) + 1;
check('life kinds 4/4/4/4', byKind.dog === 4 && byKind.bag === 4 && byKind.phone === 4 && byKind.wait === 4, JSON.stringify(byKind));
check('getPositions=64', window.__people.getPositions().length === 64);
// 行人走几步：走路的动、等车的站着不动
const before = window.__people.getPositions().map((p) => [p.x, p.z]);
people.init; // (init 已跑过 tick 桩，不重复 init)
for (let k = 0; k < 10; k++) window.__people.update(0.016);
const after = window.__people.getPositions().map((p) => [p.x, p.z]);
let movedWalk = 0, movedWait = 0, nWait = 0;
life.forEach((l, i) => {
  const idx = 48 + i;
  const d = Math.hypot(after[idx][0] - before[idx][0], after[idx][1] - before[idx][1]);
  if (l.life === 'wait') { nWait++; if (d > 0.001) movedWait++; }
  else if (d > 0.001) movedWalk++;
});
check('walkers move (12/12)', movedWalk === 12, `moved=${movedWalk}`);
check('waiters stand still', movedWait === 0 && nWait === 4, `movedWait=${movedWait}`);
// 不许 5 个一模一样的排一列：读实例色（躯干/头/发/腿四件），全身外观完全相同的最多几人
const kids = window.__people.group.children;
const colAt = (mesh, i) => { const a = mesh.instanceColor.array; return [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]].map((v) => v.toFixed(3)).join(','); };
const tupCount = {};
for (let i = 0; i < 64; i++) {
  const key = [colAt(kids[0], i), colAt(kids[1], i), colAt(kids[2], i), colAt(kids[4], i)].join('|');
  tupCount[key] = (tupCount[key] || 0) + 1;
}
const maxDup = Math.max(...Object.values(tupCount));
check('no 5 identical looks (max dup <=2)', maxDup <= 2, `maxDup=${maxDup} distinctLooks=${Object.keys(tupCount).length}`);

// ---------- street ----------
const street = await import('./street.js');
const sRet = street.init(ctx);
check('street trees.total still 220', sRet.trees.total === 220, JSON.stringify(sRet.trees));
check('street lanterns still 66', sRet.lanterns.lanterns === 66, JSON.stringify(sRet.lanterns));
const ls = sRet.landmarkStreets;
check('landmarkStreets landmarks=16', ls.landmarks === 16, JSON.stringify(ls));
check('paving disc 9 / square 7', ls.paving.disc === 9 && ls.paving.square === 7, JSON.stringify(ls.paving));
check('planters 48 / puffs 52', ls.planters === 48 && ls.puffs === 52, `planters=${ls.planters} puffs=${ls.puffs}`);
check('ornaments lantern 8 / ball 2 / pillar 6', ls.ornaments.lantern === 8 && ls.ornaments.ball === 2 && ls.ornaments.pillar === 6, JSON.stringify(ls.ornaments));
check('calibrated bench 16 / bin 16', ls.bench === 16 && ls.bin === 16, `bench=${ls.bench} bin=${ls.bin}`);
// 白膜切换不报错、霓虹柱收起来
street.setDisplay('white');
street.setDisplay('normal');
people.setDisplay('white');
people.setDisplay('normal');
check('setDisplay white/normal round-trip ok', true);

// ---------- playercar ----------
const car = await import('./playercar.js');
const cRet = await car.init(ctx);
check('car replaced', cRet.stats.replaced === true, JSON.stringify(cRet.stats));
// tris 口径：遍历车组所有网格顶点数/3 == stats.tris
let verts = 0, meshes = 0;
cRet.group.traverse((o) => {
  if (o.isMesh && o.geometry && o.geometry.attributes.position) {
    verts += o.geometry.attributes.position.count; meshes++;
  }
});
check('tris verts/3 == stats.tris', verts / 3 === cRet.stats.tris, `verts=${verts} tris=${cRet.stats.tris} meshes=${meshes}`);
// 表盘：手动读数 + 夜光
cRet.setNight(1);
cRet.setDial(60, 4000);
check('dial speed 60', cRet.dials.speedKmh === 60, JSON.stringify(cRet.dials));
check('dial rpm 4000', cRet.dials.rpm === 4000);
check('dial glow night=1.0', cRet.dials.glow === 1, `glow=${cRet.dials.glow}`);
const needles = [];
cRet.group.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position && o.geometry.attributes.position.count === 6 && o.material && o.material.vertexColors) needles.push(o); });
cRet.setNight(0);
cRet.setDial(0, 800);
check('dial glow day=0.32', cRet.dials.glow === 0.32, `glow=${cRet.dials.glow}`);
cRet.setDial(120, 8000);
check('needle speed at 120km/h = -120deg', Math.abs(needles[0].rotation.z - (-Math.PI * 2 / 3)) < 1e-6, `rot=${needles[0] && needles[0].rotation.z}`);
check('needle tach at 8000rpm = -120deg', Math.abs(needles[1].rotation.z - (-Math.PI * 2 / 3)) < 1e-6, `rot=${needles[1] && needles[1].rotation.z}`);
cRet.setDial(0, 800);
check('needle speed at 0 = +120deg', Math.abs(needles[0].rotation.z - (Math.PI * 2 / 3)) < 1e-6, `rot=${needles[0] && needles[0].rotation.z}`);
const sp = cRet.group.children;
check('dial api present', typeof cRet.setDial === 'function' && typeof cRet.setNight === 'function');

console.log(failures.length ? `\nSMOKE FAIL: ${failures.join(', ')}` : '\nSMOKE ALL PASS');
process.exit(failures.length ? 1 : 0);
