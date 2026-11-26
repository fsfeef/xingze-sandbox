// playercar.js — 星泽市 · 玩家真车 + 车内视角（C 路新增，验收表第 29 行）
// 玩家开的车是真车：按现实 SUV 车型做（车身、玻璃座舱、轮子、车灯、
// 保险杠、格栅、后视镜、行李架齐全），无标无牌，不许简易方块车。
// 最高 120km/h 是 app.js 里已有的上限（MAX_FWD 33.3m/s），本模块不动物理；
// 开车物理和相机切换都在 app.js，本模块只提供车模 + 车内陈设。
// 车内视角：app.js 的 interior 相机在车内局部 (0, 1.35, +0.4) 处朝车头看，
// 本模块在车内建好仪表盘、方向盘、座椅、中控、后视镜，挡风玻璃是透明玻璃，
// 从驾驶座看出去是路面。跟随视角沿用 app.js 的跟随相机。
// 仪表盘夜里发光：转速/速度双表盘（canvas 自画刻度 + 霓虹环，微光），
// 指针每帧按车速/转速转，亮度跟 app.js 的 state.night 走（白天微亮、夜里发光）。
// 车速从页面 #drive-speed 读（app.js 每帧在写）；不碰 roads.js 的车灯。
//
// 接线方式（由总协调统一做，本模块不改 app.js）：
//   方式 A（推荐，最小补丁，见报告）：app.js 末尾 __sandbox 块之后加
//     import('./playercar.js').then((m) => m.init(window.__sandbox));
//   本模块会先在场景里找到 app.js 建的车组（body 2×0.65×4.4 的红盒特征），
//   把它的三个简易子件换成真车，组本身不动，所以开车物理/相机继续走 app.js。
//   方式 B（更稳）：同时在 __sandbox 里暴露 carGroup（见报告补丁 2），
//   本模块优先用 ctx.carGroup，找不到才按特征扫描。
// 导出：init(ctx) / setDisplay(mode)。
// 注意：白膜/热力模式下玩家车保持可见（它是玩家座驾，不是布景）；
// 车身颜色固定深蓝，暂不提供换色接口（顶点色已烘进几何，换色要重建）。

let _ctx = null, _THREE = null, _group = null, _started = false;
let _mode = 'normal';
// 仪表盘双表盘（夜里发光）：表盘面材质 + 指针网格 + 当前读数；
// 手动覆盖（setDial/setNight）只供接线/测试用，平时读 #drive-speed 和 state.night。
let _dialFaceMats = [], _dialNeedles = [];
let _dialState = { speedKmh: 0, rpm: 800, night: 0, glow: 0.32 };
let _manualSpeed = null, _manualRpm = null, _manualNight = null;
let _dialTickStarted = false;
const _stats = { replaced: false, meshes: 0, tris: 0, foundBy: '' };
function log(...a) { console.log('[playercar]', ...a); }

// ---------- 小几何 builder（与 roads.js 同款做法：非索引 + 平面法线 + 顶点色） ----------
function makeBuilder(THREE) {
  const pos = [], nor = [], col = [], uv = [];
  const tmpC = new THREE.Color();
  function rgb(hex) { tmpC.set(hex); return [tmpC.r, tmpC.g, tmpC.b]; }
  function pushTri(a, b, c, color) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const p of [a, b, c]) { pos.push(p[0], p[1], p[2]); nor.push(nx, ny, nz); col.push(color[0], color[1], color[2]); }
  }
  function quad(a, b, c, d, color) { pushTri(a, b, c, color); pushTri(a, c, d, color); }
  // 带 UV 的 quad（表盘面贴 canvas 纹理用；a=(0,0) b=(1,0) c=(1,1) d=(0,1)）
  function quadUV(a, b, c, d, color) {
    pushTri(a, b, c, color); pushTri(a, c, d, color);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  }
  function corners(cx, cy, cz, sx, sy, sz, rot) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const out = [];
    for (const [x, y, z] of [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz]]) {
      out.push([cx + rot(x, y, z)[0], cy + rot(x, y, z)[1], cz + rot(x, y, z)[2]]);
    }
    return out;
  }
  function boxFrom(v, color) {
    quad(v[0], v[3], v[2], v[1], color);
    quad(v[4], v[5], v[6], v[7], color);
    quad(v[0], v[1], v[5], v[4], color);
    quad(v[3], v[7], v[6], v[2], color);
    quad(v[0], v[4], v[7], v[3], color);
    quad(v[1], v[2], v[6], v[5], color);
  }
  function box(cx, cy, cz, sx, sy, sz, ry, color) {
    const c = Math.cos(ry || 0), s = Math.sin(ry || 0);
    boxFrom(corners(cx, cy, cz, sx, sy, sz, (x, y, z) => [x * c + z * s, y, -x * s + z * c]), color);
  }
  function boxRX(cx, cy, cz, sx, sy, sz, rx, color) {
    const c = Math.cos(rx || 0), s = Math.sin(rx || 0);
    boxFrom(corners(cx, cy, cz, sx, sy, sz, (x, y, z) => [x, y * c - z * s, y * s + z * c]), color);
  }
  function beam(p0, p1, half, color) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const ax = dx / len, ay = dy / len, az = dz / len;
    let bx = 0, by = 1, bz = 0;
    if (Math.abs(ay) > 0.9) { bx = 1; by = 0; bz = 0; }
    let ux = by * az - bz * ay, uy = bz * ax - bx * az, uz = bx * ay - by * ax;
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
    const c = [];
    for (const [su, sv] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
      c.push([ux * half * su + vx * half * sv, uy * half * su + vy * half * sv, uz * half * su + vz * half * sv]);
    }
    const q0 = c.map((o) => [p0[0] + o[0], p0[1] + o[1], p0[2] + o[2]]);
    const q1 = c.map((o) => [p1[0] + o[0], p1[1] + o[1], p1[2] + o[2]]);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; quad(q0[i], q1[i], q1[j], q0[j], color); }
    quad(q0[0], q0[3], q0[2], q0[1], color);
    quad(q1[0], q1[1], q1[2], q1[3], color);
  }
  function cyl(p0, p1, r, seg, color) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const ax = dx / len, ay = dy / len, az = dz / len;
    let bx = 0, by = 1, bz = 0;
    if (Math.abs(ay) > 0.9) { bx = 1; by = 0; bz = 0; }
    let ux = by * az - bz * ay, uy = bz * ax - bx * az, uz = bx * ay - by * ax;
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
    const ring = (p) => {
      const out = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        out.push([p[0] + (ux * ca + vx * sa) * r, p[1] + (uy * ca + vy * sa) * r, p[2] + (uz * ca + vz * sa) * r]);
      }
      return out;
    };
    const r0 = ring(p0), r1 = ring(p1);
    for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; quad(r0[i], r1[i], r1[j], r0[j], color); }
    const c0 = [p0[0], p0[1], p0[2]], c1 = [p1[0], p1[1], p1[2]];
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      pushTri(c0, r0[j], r0[i], color);
      pushTri(c1, r1[i], r1[j], color);
    }
  }
  function buildGeometry(withUV) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    if (withUV) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeBoundingSphere();
    return g;
  }
  return { rgb, quad, quadUV, box, boxRX, beam, cyl, buildGeometry, get count() { return pos.length / 3; } };
}

// ---------- 仪表盘表盘面：canvas 自画（通用表盘，无品牌） ----------
// 240° 表幅：0 在 8 点钟方向，满量程在 4 点钟方向，12 点是中点。
// 刻度 + 霓虹环 + 红线区 + 数字，全部自画。
function dialTexture(THREE, kind, accentHex) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  const cx = 128, cy = 128;
  const at = (v, r) => {
    const a = (-120 + 240 * v) * Math.PI / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  };
  g.fillStyle = '#0B1026';
  g.fillRect(0, 0, 256, 256);
  // 霓虹外环（发光感靠 shadowBlur）
  g.strokeStyle = accentHex;
  g.lineWidth = 5;
  g.shadowColor = accentHex;
  g.shadowBlur = 18;
  g.beginPath(); g.arc(cx, cy, 116, 0, Math.PI * 2); g.stroke();
  g.shadowBlur = 0;
  g.strokeStyle = '#2A3358';
  g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, 100, 0, Math.PI * 2); g.stroke();
  // 红线区（最后 22% 表幅）
  g.strokeStyle = '#FF2E3E';
  g.lineWidth = 6;
  g.beginPath();
  const [rx0, ry0] = at(0.78, 116);
  const [rx1, ry1] = at(1, 116);
  g.arc(cx, cy, 116, Math.atan2(ry0 - cy, rx0 - cx), Math.atan2(ry1 - cy, rx1 - cx));
  g.stroke();
  // 刻度：13 大格 + 小格
  for (let k = 0; k <= 40; k++) {
    const v = k / 40;
    const major = k % 4 === 0;
    const [x0, y0] = at(v, major ? 96 : 102);
    const [x1, y1] = at(v, 110);
    g.strokeStyle = major ? '#E8F0FF' : '#5B6B8C';
    g.lineWidth = major ? 4 : 2;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  }
  // 数字：速度 0/30/60/90/120，转速 0/2/4/6/8（×1000rpm）
  g.fillStyle = '#E8F0FF';
  g.font = 'bold 24px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const nums = kind === 'speed' ? ['0', '30', '60', '90', '120'] : ['0', '2', '4', '6', '8'];
  nums.forEach((n, i) => {
    const [x, y] = at(i / (nums.length - 1), 74);
    g.fillText(n, x, y);
  });
  g.fillStyle = accentHex;
  g.font = 'bold 17px sans-serif';
  g.fillText(kind === 'speed' ? 'km/h' : 'x1000 rpm', cx, 168);
  // 中心毂
  g.fillStyle = '#1B2340';
  g.beginPath(); g.arc(cx, cy, 11, 0, Math.PI * 2); g.fill();
  g.fillStyle = accentHex;
  g.beginPath(); g.arc(cx, cy, 4, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- 真车（SUV，深蓝 #16283F，无标无牌；局部 +Z 为车头） ----------
function buildPlayerCar(THREE) {
  const body = makeBuilder(THREE), glass = makeBuilder(THREE), lights = makeBuilder(THREE);
  const bodyC = body.rgb('#16283F'), trimC = body.rgb('#222831'), darkC = body.rgb('#15181C');
  const seatC = body.rgb('#3A3F4A'), dashC = body.rgb('#23272E'), headC = body.rgb('#2A2E35');
  const glassC = glass.rgb('#9FC4E8');
  const headC2 = lights.rgb('#FFF3B0'), tailC = lights.rgb('#FF2E3E'), scrC = lights.rgb('#7DF9FF');
  const L = 4.6, W = 1.92;
  // ---- 外观 ----
  body.box(0, 0.68, -0.05, W, 0.62, L, 0, bodyC); // 主车身
  body.box(0, 0.93, 1.75, W - 0.06, 0.16, 1.0, 0, bodyC); // 机盖
  body.box(0, 0.93, -1.75, W - 0.06, 0.16, 0.9, 0, bodyC); // 尾盖
  body.box(0, 0.42, L / 2 + 0.02, W, 0.22, 0.2, 0, trimC); // 前包围
  body.box(0, 0.42, -L / 2 - 0.02, W, 0.22, 0.2, 0, trimC); // 后包围
  body.box(0, 0.72, L / 2 + 0.03, 1.1, 0.16, 0.06, 0, darkC); // 格栅（无标，空白）
  body.box(0, 0.52, L / 2 + 0.06, 0.52, 0.12, 0.03, 0, darkC); // 前牌照位（空的，不装牌）
  body.box(0, 0.52, -L / 2 - 0.06, 0.52, 0.12, 0.03, 0, darkC); // 后牌照位（空的，不装牌）
  body.box(0, 0.36, 0, W + 0.02, 0.1, L - 0.6, 0, trimC); // 侧裙
  for (const sx of [-1, 1]) {
    body.box(sx * (W / 2 + 0.06), 1.08, 0.75, 0.08, 0.14, 0.22, 0, bodyC); // 后视镜
    body.box(sx * (W / 2 + 0.01), 0.88, 0.35, 0.03, 0.05, 0.32, 0, trimC); // 前门把手
    body.box(sx * (W / 2 + 0.01), 0.88, -0.55, 0.03, 0.05, 0.32, 0, trimC); // 后门把手
    body.box(sx * 0.55, 1.62, -0.2, 0.06, 0.06, 2.2, 0, trimC); // 行李架
  }
  body.box(0, 0.42, -L / 2 - 0.12, 0.12, 0.1, 0.12, 0, trimC); // 排气
  // ---- 座舱：车顶 + 立柱 + 顶篷 ----
  body.box(0, 1.55, -0.2, 1.74, 0.09, 2.5, 0, bodyC); // 车顶
  body.box(0, 1.5, -0.2, 1.68, 0.04, 2.44, 0, headC); // 顶篷（内）
  for (const sx of [-1, 1]) {
    body.beam([sx * 0.82, 1.02, 1.0], [sx * 0.74, 1.5, 0.42], 0.05, bodyC); // A 柱
    body.box(sx * 0.84, 1.28, -0.3, 0.07, 0.5, 0.09, 0, bodyC); // B 柱
    body.beam([sx * 0.82, 1.02, -1.42], [sx * 0.74, 1.5, -1.1], 0.05, bodyC); // C 柱
  }
  // ---- 玻璃（透明，挡风玻璃可从车内看出去） ----
  glass.quad([-0.8, 1.04, 1.02], [0.8, 1.04, 1.02], [0.72, 1.5, 0.42], [-0.72, 1.5, 0.42], glassC); // 挡风
  glass.quad([-0.8, 1.04, -1.42], [-0.72, 1.5, -1.1], [0.72, 1.5, -1.1], [0.8, 1.04, -1.42], glassC); // 后窗
  for (const sx of [-1, 1]) {
    glass.quad(
      [sx * 0.86, 1.06, -1.1], [sx * 0.86, 1.06, 0.85],
      [sx * 0.86, 1.48, 0.85], [sx * 0.86, 1.48, -1.1], glassC); // 侧窗
  }
  // ---- 车内：仪表盘 + 方向盘 + 中控 + 座椅（驾驶座在左侧，x +0.38） ----
  body.box(0, 0.42, 0, 1.72, 0.06, 4.1, 0, darkC); // 地板
  body.box(0, 1.08, 0.98, 1.66, 0.3, 0.55, 0, dashC); // 仪表盘
  body.box(0, 1.26, 0.98, 1.66, 0.08, 0.45, 0, dashC); // 仪表台上沿
  body.box(0, 0.92, 0.15, 0.32, 0.22, 1.1, 0, dashC); // 中控
  body.box(0, 1.06, -0.1, 0.2, 0.08, 0.3, 0, trimC); // 换挡杆座
  body.box(0, 1.48, 0.48, 0.3, 0.09, 0.04, 0, darkC); // 后视镜
  body.beam([0, 1.5, 0.5], [0, 1.44, 0.48], 0.02, darkC); // 后视镜杆
  body.box(-0.38, 1.5, 0.42, 0.5, 0.03, 0.3, 0, headC); // 遮阳板（副驾）
  body.box(0.38, 1.5, 0.42, 0.5, 0.03, 0.3, 0, headC); // 遮阳板（驾驶）
  // 方向盘：8 段圆环 + 两辐条 + 轮毂 + 转向柱（中心在驾驶座前方）
  const wc = [0.38, 1.18, 0.68], wr = 0.2, tilt = 0.45;
  const up = [0, Math.cos(tilt), Math.sin(tilt)];
  const ringPt = (a) => {
    const ca = Math.cos(a), sa = Math.sin(a);
    return [wc[0] + ca * wr, wc[1] + sa * wr * up[1], wc[2] + sa * wr * up[2]];
  };
  for (let k = 0; k < 8; k++) {
    const p = ringPt((k / 8) * Math.PI * 2);
    body.box(p[0], p[1], p[2], 0.055, 0.055, 0.055, 0, darkC);
  }
  body.beam(wc, ringPt(Math.PI * 1.15), 0.03, darkC);
  body.beam(wc, ringPt(Math.PI * 1.85), 0.03, darkC);
  body.cyl([wc[0], wc[1], wc[2] - 0.04], [wc[0], wc[1], wc[2] + 0.04], 0.05, 8, trimC);
  body.beam([0.38, 1.02, 0.98], wc, 0.035, darkC); // 转向柱
  // 座椅：前排两座 + 后排长椅 + 头枕
  for (const sx of [-0.38, 0.38]) {
    body.box(sx, 0.82, 0.1, 0.52, 0.2, 0.52, 0, seatC);
    body.boxRX(sx, 1.1, -0.2, 0.52, 0.66, 0.16, -0.16, seatC);
    body.box(sx, 1.46, -0.32, 0.26, 0.14, 0.1, 0, seatC);
  }
  body.box(0, 0.82, -1.0, 1.55, 0.2, 0.5, 0, seatC);
  body.boxRX(0, 1.12, -1.32, 1.55, 0.62, 0.16, -0.16, seatC);
  for (const sx of [-0.5, 0, 0.5]) body.box(sx, 1.46, -1.42, 0.26, 0.14, 0.1, 0, seatC);
  for (const sx of [-1, 1]) body.box(sx * 0.87, 1.0, 0.2, 0.05, 0.4, 2.0, 0, dashC); // 车门内板
  // ---- 车灯（发光块，夜里即车灯）+ 仪表屏 ----
  for (const sx of [-1, 1]) {
    lights.box(sx * 0.62, 0.84, L / 2 + 0.03, 0.36, 0.12, 0.08, 0, headC2); // 前大灯
    lights.box(sx * 0.62, 0.7, L / 2 + 0.03, 0.3, 0.04, 0.06, 0, headC2); // 日行灯带
    lights.box(sx * 0.62, 0.84, -L / 2 - 0.03, 0.32, 0.1, 0.08, 0, tailC); // 尾灯
  }
  lights.box(0.38, 1.24, 0.86, 0.5, 0.16, 0.04, 0, scrC); // 仪表屏（驾驶侧）
  lights.box(0, 1.18, 0.72, 0.34, 0.2, 0.04, 0, scrC); // 中控屏
  // ---- 仪表盘夜里发光：转速/速度双表盘（微光） ----
  // 表盘面：canvas 自画刻度 + 霓虹环；指针是独立小网格，每帧按车速/转速转；
  // 亮度跟夜色走（白天微亮、夜里发光）。几何走同款非索引 builder，
  // 顶点数/3 == tris 的验算口径不变（表盘三角数计入 _stats.tris）。
  // 位置：仪表台后沿（z=0.695，贴着仪表盘朝驾驶员的面），驾驶侧速度表、中间偏左转速表。
  const dialGroups = [];
  const dialFaceMats = [];
  const dialNeedles = [];
  let dialTris = 0;
  const makeDial = (kind, accentHex, needleHex, x) => {
    const face = makeBuilder(THREE);
    const R = 0.11;
    face.quadUV([-R, -R, 0], [R, -R, 0], [R, R, 0], [-R, R, 0], face.rgb('#FFFFFF'));
    const faceMesh = new THREE.Mesh(face.buildGeometry(true),
      new THREE.MeshBasicMaterial({ map: dialTexture(THREE, kind, accentHex), transparent: true, opacity: 0.32 }));
    const needle = makeBuilder(THREE);
    needle.quad([-0.013, 0, 0], [0.013, 0, 0], [0.008, 0.105, 0], [-0.008, 0.105, 0], needle.rgb(needleHex));
    const needleMesh = new THREE.Mesh(needle.buildGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true }));
    needleMesh.position.z = 0.006;
    const grp = new THREE.Group();
    grp.add(faceMesh, needleMesh);
    grp.position.set(x, 1.10, 0.695);
    grp.rotation.y = Math.PI; // 表盘面朝驾驶员（车内 -Z 方向）
    dialGroups.push(grp);
    dialFaceMats.push(faceMesh.material);
    dialNeedles.push(needleMesh);
    dialTris += (face.count + needle.count) / 3;
    return grp;
  };
  makeDial('speed', '#00F0FF', '#E8F0FF', 0.38);   // 速度表：青环 + 白针
  makeDial('tach', '#FF9F1C', '#FF9F1C', -0.30);   // 转速表：橙环 + 橙针
  // ---- 轮子 ----
  for (const sx of [-1, 1]) for (const sz of [1.45, -1.45]) {
    const x0 = sx * (W / 2 - 0.02), x1 = sx * (W / 2 + 0.22);
    body.cyl([x0, 0.36, sz], [x1, 0.36, sz], 0.36, 10, darkC);
    body.cyl([x1 - 0.02, 0.36, sz], [x1 + 0.03, 0.36, sz], 0.2, 8, trimC);
  }
  const bodyMesh = new THREE.Mesh(body.buildGeometry(),
    new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.35 }));
  const glassMesh = new THREE.Mesh(glass.buildGeometry(),
    new THREE.MeshStandardMaterial({
      vertexColors: true, transparent: true, opacity: 0.3,
      metalness: 0.9, roughness: 0.1, side: THREE.DoubleSide, depthWrite: false,
    }));
  const lightMesh = new THREE.Mesh(lights.buildGeometry(),
    new THREE.MeshBasicMaterial({ vertexColors: true }));
  // builder 是非索引几何：count 数的是顶点数（每三角 3 个顶点），三角面数 = 顶点数 / 3。
  // 之前直接把顶点数当 tris 报，大了 3 倍。
  _stats.tris = (body.count + glass.count + lights.count) / 3 + dialTris;
  _stats.meshes = 3 + dialGroups.length * 2; // 车身/玻璃/车灯 + 每表盘 2 个网格（面+针）
  return { bodyMesh, glassMesh, lightMesh, dialGroups, dialFaceMats, dialNeedles };
}

// ---------- 找 app.js 的车组 ----------
function findCarGroup(scene) {
  let found = null;
  scene.traverse((o) => {
    if (found || !o.isGroup || !o.children) return;
    for (const ch of o.children) {
      const g = ch.geometry;
      if (ch.isMesh && g && g.parameters &&
        g.parameters.width === 2 && g.parameters.height === 0.65 && g.parameters.depth === 4.4) {
        found = o; return;
      }
    }
  });
  return found;
}
function disposeChildren(group) {
  for (const ch of [...group.children]) {
    group.remove(ch);
    if (ch.geometry) ch.geometry.dispose();
    if (ch.material) {
      if (Array.isArray(ch.material)) ch.material.forEach((m) => m.dispose());
      else ch.material.dispose();
    }
  }
}

export async function init(ctx) {
  if (_started) return window.__playercar;
  _started = true;
  _ctx = ctx; _THREE = ctx.THREE;
  const THREE = ctx.THREE, scene = ctx.scene;
  if (!scene || !THREE) throw new Error('[playercar] ctx.scene / ctx.THREE 缺失');
  let group = ctx.carGroup || null;
  if (group) _stats.foundBy = 'ctx.carGroup';
  else {
    group = findCarGroup(scene);
    if (group) _stats.foundBy = 'scene-scan (body 2x0.65x4.4)';
  }
  if (!group) {
    // 兜底：建自己的组（没有 app.js 的驱动同步，只能静置展示；见报告补丁）
    log('WARN: 场景里没找到 app.js 的车组，建独立展示组（不会跟开车走）');
    group = new THREE.Group();
    group.name = 'player-car-standalone';
    group.position.set(-114.9, 0, -570.4);
    scene.add(group);
    _stats.foundBy = 'standalone';
  }
  _group = group;
  _group.name = 'player-car';
  disposeChildren(_group);
  const { bodyMesh, glassMesh, lightMesh, dialGroups, dialFaceMats, dialNeedles } = buildPlayerCar(THREE);
  _group.add(bodyMesh, glassMesh, lightMesh);
  for (const dg of dialGroups) _group.add(dg);
  _dialFaceMats = dialFaceMats;
  _dialNeedles = dialNeedles;
  _stats.replaced = true;
  log(`done (${_stats.foundBy}), tris=${_stats.tris}`);
  // 表盘每帧：亮度跟夜色、指针跟车速/转速（读 #drive-speed，不碰 roads.js 的车灯）
  if (!_dialTickStarted) {
    _dialTickStarted = true;
    const loop = () => { updateDials(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  const api = {
    group: _group, stats: _stats, setDisplay,
    dials: _dialState,
    setDial(kmh, rpm) { _manualSpeed = kmh; if (rpm != null) _manualRpm = rpm; updateDials(); },
    setNight(n) { _manualNight = n; updateDials(); },
    clearDialOverride() { _manualSpeed = null; _manualRpm = null; _manualNight = null; },
    probe: () => ({
      groupName: _group.name, children: _group.children.length,
      pos: [_group.position.x, _group.position.y, _group.position.z],
      rotY: _group.rotation.y, foundBy: _stats.foundBy,
      dials: { ..._dialState },
    }),
  };
  window.__playercar = api;
  return api;
}

// ---------- 仪表盘夜里发光：表盘亮度 + 指针角度，每帧更新 ----------
function updateDials() {
  if (!_dialFaceMats.length) return;
  const now = performance.now() / 1000;
  const night = _manualNight != null ? _manualNight : (_ctx && _ctx.state ? _ctx.state.night || 0 : 0);
  let kmh = 0;
  if (_manualSpeed != null) kmh = _manualSpeed;
  else {
    const el = document.getElementById('drive-speed');
    if (el) {
      const m = /(\d+(?:\.\d+)?)/.exec(el.textContent || '');
      if (m) kmh = parseFloat(m[1]);
    }
  }
  // 转速：没接发动机数据，按车速推（怠速 800rpm + 车速×45，带一点怠速抖动）
  const rpm = _manualRpm != null ? _manualRpm
    : 800 + kmh * 45 + (kmh > 0.5 ? Math.sin(now * 2.3) * 40 : Math.sin(now * 1.7) * 25);
  // 微光：白天 0.32（表盘看得见、不刺眼），夜里 1.0（霓虹环发光）
  const glow = 0.32 + 0.68 * Math.max(0, Math.min(1, night));
  for (const m of _dialFaceMats) m.opacity = glow;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  // 240° 表幅：指针角 a = -120°..+120°（12 点方向为中点）；针几何朝 +Y，
  // rotation.z = -a（见 dialTexture 的刻度算法，针尖与刻度对齐）。
  const aSpeed = (-120 + 240 * clamp01(kmh / 120)) * Math.PI / 180;
  const aTach = (-120 + 240 * clamp01(rpm / 8000)) * Math.PI / 180;
  if (_dialNeedles[0]) _dialNeedles[0].rotation.z = -aSpeed;
  if (_dialNeedles[1]) _dialNeedles[1].rotation.z = -aTach;
  _dialState.speedKmh = Math.round(kmh);
  _dialState.rpm = Math.round(rpm);
  _dialState.night = +night.toFixed(2);
  _dialState.glow = +glow.toFixed(2);
}

export function setDisplay(mode) {
  _mode = mode || 'normal';
  // 玩家车是座驾不是布景：白膜/热力模式下也保持可见（与 roads.js 的隐藏规则不同）。
  if (_group) _group.visible = true;
  log('display ->', _mode, '(player car stays visible)');
}
