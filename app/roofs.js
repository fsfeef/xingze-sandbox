// roofs.js — 1 路：楼+屋顶（星泽市 · 游戏画面风格）
// 做法（方案 §3.1 + 管线 our-pipeline-2026-11-26.md §2/§6）：不重建、不改包、
//   不碰 app.js / six-loader.js / tower-fix.js / 配色表 / six-names.json。
//   ① 分块 GLB 是非索引合并几何（POSITION/NORMAL/COLOR_0，无 UV）：
//      顶面 = 法线朝上（ny>0.85）的三角面；按共享顶点位置并查集聚成"一栋楼的顶"。
//   ② 顶面逐面重着色（高度带冷蓝紫）；顶面轮廓（凸包）加女儿墙 + 霓虹顶线。
//   ③ 按位置哈希种子确定性分型（SplitMix64，同一栋每次加载同一个顶）：
//      高层两级退台冠顶 + 幕墙竖线 + 转角亮边 / 中层坡顶·四坡顶·三角坡顶·圆角顶 /
//      低层平顶 + 屋顶机房盒子；大底盘另加裙楼（h>=30）；
//      圆角/棱角两种顶形按种子分（13:49：圆角还是棱角照参考图；参考截图未到，
//      本轮两种都做、种子固定，等截图到了再调比例）。
//   ④ 25 地标里 1 路只做屋顶造型的 16 座（归属表 lane-coordination §5），每座一个
//      独立形制（见 LANDMARK_FORM）：古建风（檐板+四坡顶+宝顶/重檐/八角亭）/
//      现代风（退台冠顶+霓虹框+LED屏）/ 工业锯齿顶 / 大跨度站房屋顶 / 低层灰瓦街区。
//      构件是我们自己建的通用形制，不抄参考某座楼的具体设计。
//      红线（13:56）：不做 IFS 爬墙熊猫雕塑、不照搬任何标志性艺术品——云竹熊猫苑
//      只做通用现代冠顶（竹林/场馆归 3 路街面，不做熊猫造型）；不照搬品牌 logo /
//      店招 / 官方 logo；贴图只用自己画的 canvas（本轮白模先行，不出贴图）。
//   ⑤ 8 座屋顶栏是"—"的地标（星熙路/云锦湖/霓虹桥/星泽广场/星河/琴韵路/
//      九虹桥/星江）1 路不做单体屋顶，只登记为 skipped；揽星塔不做任何几何，
//      只登记（塔身归 4 路 tower-fix.js，真 339m；本文件不碰 tower-fix.js）。
//   ⑥ 白膜模式：全部附加几何隐藏，变回白膜；热力模式：霓虹隐藏、实体保留。
//   ⑦ 一环以外（Phase 2）：参考站只覆盖一环内外，一环以外没人可抄——用同一套
//      方法（管线 §6）、拿我们自己的六区 OSM 数据（分块几何实测顶面 + 位置哈希
//      种子）自己建出来，不空着、不瞎编；一环内/外同一套分型，计数分开报
//      （phase1Clusters / phase2Clusters）；高度口径一律层数×3.2 + OSM 标签（v2.1），
//      顶高取分块几何实测顶面 y，估算标估算；只有揽星塔 339m、双星塔 218m 是核实数。
// 地标名：只用 six-names.json 的新名。运行时 six-index.json 里仍是旧名，
//   本文件用 OLD_TO_NEW（逐字抄 six-names.json）把旧名换成新名再分派；
//   对外输出（stats/landmarkState）一律新名，旧名只出现在换名表这一处。
// 比例纠错（14:11）：参考的错不搬——参考 339 塔标签 339m、模型 113m 级，
//   我们按真 339m（4 路 tower-fix.js）；本文件揽星塔只登记，不量不建。
// 依赖：window.__sandbox（scene/THREE/sixLoader/sixIndex/state）。

const ROOF_COLORS = [
  { h: 12, c: [0x23, 0x2c, 0x52] },   // 低层 #232C52
  { h: 30, c: [0x2a, 0x37, 0x66] },   // 中低 #2A3766
  { h: 60, c: [0x33, 0x41, 0x7a] },   // 中高 #33417A
  { h: 120, c: [0x3a, 0x4a, 0x8c] },  // 高层 #3A4A8C
  { h: 1e9, c: [0x46, 0x58, 0x9e] },  // 超高层 #46589E
];
const NEON = [
  [1.0, 0.18, 0.53], // #FF2E88 粉
  [0.0, 0.94, 1.0],  // #00F0FF 青
  [0.55, 0.36, 1.0], // #8B5CFF 紫
  [1.0, 0.62, 0.11], // #FF9F1C 橙
];
const PHASE1 = { x0: -4115, x1: 3885, z0: -4570, z1: 3430 }; // 一环大小（方案 §3.16）
// 配色只用配色表 + 方案 §4（冷蓝紫 + 霓虹，已落盘色值）；幕墙档 #3A4A7A + 竖线 #00F0FF。
const CURTAIN = [0x3a / 255, 0x4a / 255, 0x7a / 255]; // 玻璃幕墙冷灰蓝

// ---- 地标换名表（逐字抄 data/six-names.json；旧名只出现在这里）----
const OLD_TO_NEW = {
  '人民公园': '望星公园', '春熙路': '星熙路', '武侯祠': '凌霄祠', '锦城湖': '云锦湖',
  '杜甫草堂': '听涛草堂', '宽窄巷子': '青石双巷', '文殊院': '云林禅院', '熊猫基地': '云竹熊猫苑',
  '永陵': '青石陵', '成都东站': '星泽东站', '青羊宫': '紫气宫', '安顺桥': '霓虹桥',
  '东郊记忆': '铁光记忆园', '天府广场': '星泽广场', '环球中心': '星环中心',
  '天府艺术公园': '星泽艺术公园', '太古里': '星光里', '339电视塔': '揽星塔',
  '府河': '星河', '琴台路': '琴韵路', '九眼桥': '九虹桥', '望江楼': '望星楼',
  '锦江': '星江', '交子大道双子塔': '双星塔', '锦里': '灯影里',
};
// 1 路做屋顶造型的 16 座（新名；归属表 §5）。form = 屋顶形制，neon = 霓虹主色下标。
const LANDMARK_FORM = {
  '望星公园':   { form: 'pavilion',   neon: 2, note: '园内古建亭顶：亭顶+檐板+宝顶，另加一座小亭' },
  '凌霄祠':     { form: 'ancient-hall', neon: 0, note: '古建屋顶：大殿四坡顶+檐板+宝顶+两配殿小顶' },
  '听涛草堂':   { form: 'cottage',    neon: 1, note: '古建屋顶：草堂低坡三角顶+亭小顶+廊' },
  '青石双巷':   { form: 'alley',      neon: 3, note: '古建街区屋顶：一排小三角坡顶+院门小顶' },
  '云林禅院':   { form: 'temple',     neon: 1, note: '古建屋顶：大殿四坡顶+山门+三叠小塔' },
  '云竹熊猫苑': { form: 'panda-modern', neon: 0, note: '通用现代冠顶+霓虹框+LED带；不做爬墙熊猫、不做熊猫造型' },
  '青石陵':     { form: 'tomb',       neon: 3, note: '古建屋顶：封土冢形圆顶+祠堂坡顶' },
  '星泽东站':   { form: 'station',    neon: 1, note: '现代大跨度屋顶：宽跨浅坡顶+雨棚+幕墙竖线' },
  '紫气宫':     { form: 'taoist',     neon: 2, note: '古建屋顶：三清殿四坡顶+八角亭+山门' },
  '铁光记忆园': { form: 'industrial', neon: 3, note: '工业风屋顶：锯齿顶+烟囱' },
  '星环中心':   { form: 'supertall',  neon: 0, note: '超高层冠顶：两级退台+霓虹框+角部信标；大体量底盘' },
  '星泽艺术公园': { form: 'museum',   neon: 2, note: '屋顶：美术馆弧顶+幕墙竖线+亭廊小顶' },
  '星光里':     { form: 'lowtile',    neon: 1, note: '低层灰瓦街区屋顶：一排低层小三角坡顶（冷蓝紫灰瓦调）' },
  '望星楼':     { form: 'double-eave', neon: 3, note: '古建楼屋顶：重檐坡顶（两叠四坡顶+两道檐板）' },
  '双星塔':     { form: 'twin',       neon: 0, note: '双塔冠顶（218m核实数）：两座错开退台冠顶，粉/青各一座' },
  '灯影里':     { form: 'arcade',     neon: 0, note: '古建街区屋顶：一排青瓦坡顶+牌坊' },
};
// 屋顶栏是"—"的 8 座：1 路不做单体屋顶，只登记。
const SKIP8 = new Set(['星熙路', '云锦湖', '霓虹桥', '星泽广场', '星河', '琴韵路', '九虹桥', '星江']);
const TOWER_NEW = '揽星塔'; // 不做任何几何，只登记；塔身归 4 路 tower-fix.js
// 核实高度（只这两座有核实数；其余一律不写数，只写口径）
const VERIFIED_HEIGHT = { '揽星塔': 339, '双星塔': 218 };

// ---- 确定性种子（procedural-gen：自有 PRNG，种子只来自位置）----
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
function roofColorFor(h, rng) {
  for (const b of ROOF_COLORS) {
    if (h < b.h) {
      const j = 0.94 + rng() * 0.12;
      return [Math.min(1, (b.c[0] / 255) * j), Math.min(1, (b.c[1] / 255) * j), Math.min(1, (b.c[2] / 255) * j)];
    }
  }
  return [0.27, 0.35, 0.62];
}

// ---- 手工合并几何：positions / normals / colors 三个数组，逐栋 append ----
// 三角面发射：绕向必须与法线一致（几何法线 (b-a)×(c-a) 要与 n 同向），
// 否则 FrontSide 材质会把面剔掉——旧版全部 builders 绕向都是反的：
//   从上往下看，看到的是盒子的底面（法线属性朝下，标准材质不着光 = 纯黑板），
//   霓虹能看见只因 MeshBasicMaterial 不吃光。截图第 7/8 轮中央那块黑板就是
//   凌霄祠檐板盒子的底面；小黑方块是机房盒子/冠顶盒子的底面。
//   之前 outwardNormal 只翻了法线属性，没翻绕向，所以第 8 轮黑板原样还在。
//   修正后：法线与绕向都朝外，emitTri 是唯一出口。
function newBag() { return { pos: [], nrm: [], col: [], uv: [] }; }
function emitTri(bag, p0, p1, p2, n, color) {
  const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
  let a = p0, b = p1, c = p2;
  if (cx * n[0] + cy * n[1] + cz * n[2] < 0) { b = p2; c = p1; } // 绕向反了就换 b/c
  for (const p of [a, b, c]) { bag.pos.push(p[0], p[1], p[2]); bag.nrm.push(n[0], n[1], n[2]); bag.col.push(color[0], color[1], color[2]); pushUV(bag, p, n); }
}
function pushUV(bag, p, n) {
  // 世界坐标平面映射（4m 一块贴图），无缝贴图周期 64px=4m 对齐
  if (Math.abs(n[1]) > 0.5) bag.uv.push(p[0] / 4, p[2] / 4);
  else if (Math.abs(n[0]) > 0.5) bag.uv.push(p[2] / 4, p[1] / 4);
  else bag.uv.push(p[0] / 4, p[1] / 4);
}
function pushBox(bag, cx, y0, cz, w, h, d, color, ry = 0) {
  // 轴对齐盒，绕 Y 转 ry（弧度）；36 顶点，法线按面写
  const hw = w / 2, hd = d / 2, y1 = y0 + h;
  const c = Math.cos(ry), s = Math.sin(ry);
  const P = (x, y, z) => [cx + x * c + z * s, y, cz - x * s + z * c];
  const faces = [
    [[-hw, y0, -hd], [hw, y0, -hd], [hw, y1, -hd], [-hw, y0, -hd], [hw, y1, -hd], [-hw, y1, -hd], [0, 0, -1]],
    [[hw, y0, hd], [-hw, y0, hd], [-hw, y1, hd], [hw, y0, hd], [-hw, y1, hd], [hw, y1, hd], [0, 0, 1]],
    [[-hw, y0, hd], [-hw, y0, -hd], [-hw, y1, -hd], [-hw, y0, hd], [-hw, y1, -hd], [-hw, y1, hd], [-1, 0, 0]],
    [[hw, y0, -hd], [hw, y0, hd], [hw, y1, hd], [hw, y0, -hd], [hw, y1, hd], [hw, y1, -hd], [1, 0, 0]],
    [[-hw, y1, -hd], [hw, y1, -hd], [hw, y1, hd], [-hw, y1, -hd], [hw, y1, hd], [-hw, y1, hd], [0, 1, 0]],
    [[-hw, y0, hd], [hw, y0, hd], [hw, y0, -hd], [-hw, y0, hd], [hw, y0, -hd], [-hw, y0, -hd], [0, -1, 0]],
  ];
  for (const f of faces) {
    const n = f[6];
    const nx = n[0] * c + n[2] * s, nz = -n[0] * s + n[2] * c;
    const nn = [nx, n[1], nz];
    const v = [];
    for (let i = 0; i < 6; i++) v.push(P(f[i][0], f[i][1], f[i][2]));
    emitTri(bag, v[0], v[1], v[2], nn, color);
    emitTri(bag, v[3], v[4], v[5], nn, color);
  }
}
// 法线一律朝外：由绕向算出 n 后，用（三角面心 - 体心）的点积验方向，反了就翻。
// （截图实测抓到：旧版 pushPyramid/pushPrism/pushOctPyramid 的坡面法线朝下，
//   白天航拍里坡顶全是黑板——凌霄祠大殿顶在图里就是中央那块黑板。）
function outwardNormal(p0, p1, p2, cx, cy, cz) {
  const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const L = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / L, n[1] / L, n[2] / L];
  const mx = (p0[0] + p1[0] + p2[0]) / 3 - cx, my = (p0[1] + p1[1] + p2[1]) / 3 - cy, mz = (p0[2] + p1[2] + p2[2]) / 3 - cz;
  if (n[0] * mx + n[1] * my + n[2] * mz < 0) n = [-n[0], -n[1], -n[2]];
  return n;
}
function pushPyramid(bag, cx, y0, cz, w, h, d, color) {
  // 四坡顶：底面矩形 + 顶点；底边按 45° 对角，顶面 4 个三角
  const hw = w / 2, hd = d / 2, apex = [cx, y0 + h, cz];
  const corners = [[cx - hw, y0, cz - hd], [cx + hw, y0, cz - hd], [cx + hw, y0, cz + hd], [cx - hw, y0, cz + hd]];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const n = outwardNormal(a, b, apex, cx, y0 + h / 2, cz);
    emitTri(bag, a, b, apex, n, color);
  }
}
function pushOctPyramid(bag, cx, y0, cz, r, h, color) {
  // 八角亭顶：八边形底 + 顶点（8 个三角）；r 为外接圆半径
  const apex = [cx, y0 + h, cz];
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 1) / 8) * Math.PI * 2;
    const a = [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r];
    const b = [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r];
    const n = outwardNormal(a, b, apex, cx, y0 + h / 2, cz);
    emitTri(bag, a, b, apex, n, color);
  }
}
function pushArcRoof(bag, cx, y0, cz, r, len, color) {
  // 弧顶（半圆柱壳，脊沿 X）：侧面 12 段 + 两端半圆扇；用于美术馆/站房大跨度顶
  const seg = 12, yA = y0;
  const P = (a, x) => [x, yA + Math.sin(a) * r, cz + Math.cos(a) * r];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI, a1 = ((i + 1) / seg) * Math.PI;
    const n0 = [0, Math.sin((a0 + a1) / 2), Math.cos((a0 + a1) / 2)];
    const quad = [P(a0, cx - len / 2), P(a1, cx - len / 2), P(a1, cx + len / 2), P(a0, cx + len / 2)];
    for (const tri of [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]]) {
      emitTri(bag, tri[0], tri[1], tri[2], n0, color);
    }
  }
  for (const sx of [-1, 1]) {
    const x = cx + sx * len / 2, n = [sx, 0, 0];
    const c0 = [x, yA, cz];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI, a1 = ((i + 1) / seg) * Math.PI;
      emitTri(bag, c0, P(a0, x), P(a1, x), n, color);
    }
  }
}
function pushGableRow(bag, cx, y0, cz, w, h, d, color, n, alongX = true) {
  // 一排小三角坡顶（街区屋顶）：n 个等分小坡顶沿 X（或 Z）排开
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n - 0.5;
    const px = alongX ? cx + t * w : cx;
    const pz = alongX ? cz : cz + t * w;
    const sw = alongX ? w / n * 0.94 : d;
    const sd = alongX ? d : w / n * 0.94;
    pushPrism(bag, px, y0, pz, sw, h, sd, color, sw >= sd);
  }
}
function pushPrism(bag, cx, y0, cz, w, h, d, color, ridgeX) {
  // 三角坡顶（gable）：ridge 沿较长轴
  const hw = w / 2, hd = d / 2;
  const ridge = ridgeX ? [[cx - hw, y0 + h, cz], [cx + hw, y0 + h, cz]] : [[cx, y0 + h, cz - hd], [cx, y0 + h, cz + hd]];
  const quads = ridgeX
    ? [[[cx - hw, y0, cz - hd], [cx + hw, y0, cz - hd], ridge[1], ridge[0]], [[cx + hw, y0, cz + hd], [cx - hw, y0, cz + hd], ridge[0], ridge[1]]]
    : [[[cx - hw, y0, cz - hd], [cx - hw, y0, cz + hd], ridge[1], ridge[0]], [[cx + hw, y0, cz + hd], [cx + hw, y0, cz - hd], ridge[0], ridge[1]]];
  const tris = ridgeX
    ? [[[cx - hw, y0, cz - hd], [cx - hw, y0, cz + hd], ridge[0]], [[cx + hw, y0, cz + hd], [cx + hw, y0, cz - hd], ridge[1]]]
    : [[[cx - hw, y0, cz - hd], [cx + hw, y0, cz - hd], ridge[0]], [[cx - hw, y0, cz + hd], [cx + hw, y0, cz + hd], ridge[1]]];
  const emit = (pts) => {
    const n = outwardNormal(pts[0], pts[1], pts[2], cx, y0 + h / 2, cz);
    emitTri(bag, pts[0], pts[1], pts[2], n, color);
  };
  for (const q of quads) { emit([q[0], q[1], q[2]]); emit([q[0], q[2], q[3]]); }
  for (const t of tris) emit(t);
}
function pushCylinder(bag, cx, y0, cz, r, h, color, seg = 20) {
  // 圆角顶（鼓形）：侧面 + 顶盖
  const y1 = y0 + h;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r];
    const p1 = [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r];
    const q0 = [p0[0], y1, p0[2]], q1 = [p1[0], y1, p1[2]];
    const n0 = [Math.cos(a0), 0, Math.sin(a0)], n1 = [Math.cos(a1), 0, Math.sin(a1)];
    emitTri(bag, p0, p1, q1, n1, color);
    emitTri(bag, p0, q1, q0, n0, color);
    const c = [cx, y1, cz];
    emitTri(bag, q0, q1, c, [0, 1, 0], color);
  }
}
function bagToMesh(THREE, bag, material) {
  if (!bag.pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(bag.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(bag.nrm, 3));
  if (bag.col && bag.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(bag.col, 3));
  if (bag.uv && bag.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(bag.uv, 2));
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, material);
  m.matrixAutoUpdate = false;
  m.frustumCulled = true;
  return m;
}
// 凸包（单调链），返回 [x,z] 序列
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const pt of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop(); lower.push(pt); }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) { const pt = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop(); upper.push(pt); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

let ctx = null, THREE = null;
let roofGroup = null, neonGroup = null, landmarkGroup = null;
let matSolid = null, matNeon = null;
let mode = 'normal';
let timer = null;
const processed = new WeakSet();
const chunkDigest = new Map(); // chunkKey -> digest（确定性校验）
const clustersByChunk = new Map(); // chunkKey -> [{cx,cz,topY,w,d}]
const landmarkState = new Map(); // 新名 -> {built|registered|skipped, form, topY, heightVerified}
const S = { chunksProcessed: 0, clusters: 0, roofForms: 0, parapetEdges: 0, landmarksBuilt: 0, landmarksTotal: 0, landmarksSkipped: 0, towerRegistered: false, digest: '0', phase1Clusters: 0, phase2Clusters: 0 };

function digestAdd(v) {
  S.digest = ((parseInt(S.digest, 16) ^ (v >>> 0)) >>> 0).toString(16).padStart(8, '0');
}

function clusterTopFaces(geo) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  const idx = geo.index ? geo.index.array : null;
  const nTri = idx ? idx.length / 3 : pos.length / 9;
  const top = []; // tri indices with ny>0.85
  for (let t = 0; t < nTri; t++) {
    let ny = 0;
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t * 3 + k] : t * 3 + k;
      ny += nrm[vi * 3 + 1];
    }
    if (ny / 3 > 0.85) top.push(t);
  }
  // 并查集：共享量化顶点 (x,z) 的顶面三角连成一栋
  const parent = new Int32Array(nTri).fill(-1);
  const find = (a) => { let r = a; while (parent[r] >= 0) r = parent[r]; while (parent[a] >= 0) { const n = parent[a]; parent[a] = r; a = n; } return r; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const keyOwner = new Map();
  for (const t of top) {
    // 根节点 parent 保持 -1（上一版 parent[t] = t 让 find() 自指死循环；
    // roofs.js 从未接线跑过，此 bug 一直没暴露，harness 实测抓到，已修）
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
    if (!g) { g = { tris: [], x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9, topY: -1e9, area: 0, pts: new Map() }; groups.set(r, g); }
    g.tris.push(t);
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t * 3 + k] : t * 3 + k;
      const x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2];
      if (x < g.x0) g.x0 = x; if (x > g.x1) g.x1 = x;
      if (z < g.z0) g.z0 = z; if (z > g.z1) g.z1 = z;
      if (y > g.topY) g.topY = y;
      g.pts.set(Math.round(x * 10) + ',' + Math.round(z * 10), [x, z]);
    }
    // 投影面积（xz 平面）
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

function buildChunkRoofs(mesh, key) {
  const geo = mesh.geometry;
  if (!geo || !geo.attributes.position || !geo.attributes.normal || !geo.attributes.color) return null;
  const clusters = clusterTopFaces(geo);
  const solid = newBag(), neon = newBag();
  const colAttr = geo.attributes.color.array;
  const pos = geo.attributes.position.array;
  const idx = geo.index ? geo.index.array : null;
  let forms = 0, edges = 0;
  for (const g of clusters) {
    // procedural-gen Pattern 1：一个流包打天下会让后加的 roll 洗掉前面的选择——
    // 按系统派生子种子（颜色 / 体形 / 霓虹各一路），种子只来自楼栋位置。
    const seed = hash2(g.cx, g.cz);
    const rngColor = splitmix(seed ^ 0xC0103);
    const rngForm = splitmix(seed ^ 0xF0A11);
    const rngNeon = splitmix(seed ^ 0x9E010);
    const rc = roofColorFor(g.h, rngColor);
    // ① 顶面重着色（非索引几何才安全：顶点不与立面共享；索引几何跳过重着色）
    if (!idx) {
      for (const t of g.tris) {
        for (let k = 0; k < 3; k++) {
          const vi = t * 3 + k;
          colAttr[vi * 3] = rc[0]; colAttr[vi * 3 + 1] = rc[1]; colAttr[vi * 3 + 2] = rc[2];
        }
      }
    }
    const neonC = NEON[Math.floor(rngNeon() * NEON.length)];
    // 转角：H>=30 的楼，轮廓角点加竖向霓虹条（幕墙转角亮边，从顶往下 14m）
    if (g.h >= 30) {
      const hull0 = convexHull([...g.pts.values()]);
      const step = Math.max(1, Math.floor(hull0.length / 4));
      for (let i = 0; i < hull0.length && i < step * 4; i += step) {
        pushBox(neon, hull0[i][0], g.topY - 14, hull0[i][1], 0.55, 14, 0.55, neonC);
      }
    }
    // 幕墙：H>=60 的楼，立面加冷灰蓝幕墙竖线（#3A4A7A 体 + #00F0FF 竖线，从地面 3m 到顶）
    if (g.h >= 60) {
      const hullM = convexHull([...g.pts.values()]);
      const nStrip = Math.min(6, Math.max(4, Math.floor(hullM.length / 2)));
      for (let i = 0; i < nStrip; i++) {
        const p = hullM[Math.floor((i * hullM.length) / nStrip)];
        pushBox(solid, p[0], 3, p[1], 0.9, g.h, 0.9, CURTAIN);
        pushBox(neon, p[0], 3, p[1], 0.35, g.h, 0.35, NEON[1]);
      }
    }
    // ② 女儿墙 + 霓虹顶线（凸包边沿）
    const hull = convexHull([...g.pts.values()]);
    if (hull.length >= 3) {
      const wallC = [0.10, 0.13, 0.25];
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i], b = hull[(i + 1) % hull.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 2) continue;
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        const ry = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
        pushBox(solid, mx, g.topY, mz, len, 0.9, 0.35, wallC, ry);
        pushBox(neon, mx, g.topY + 0.9, mz, len, 0.12, 0.28, neonC, ry); // 霓虹顶线收细（截图验：0.42 太粗，满城描边）
        edges++;
      }
    }
    // ③ 确定性分型（体形：退台 / 坡顶 / 圆角顶 / 机房 / 裙楼；一环内/外同一套方法）
    const roll = rngForm(), roll2 = rngForm();
    const topY = g.topY;
    if (g.h >= 60) {
      // 高层：两级退台冠顶 + 霓虹框 + 角部信标（退台，不再是单一方块顶）
      const iw = g.w * 0.62, id = g.d * 0.62;
      const ch = 4 + rngForm() * 3;
      if (roll2 < 0.25) {
        pushCylinder(solid, g.cx, topY, g.cz, Math.min(iw, id) * 0.42, ch, [0.20, 0.25, 0.45]);
        pushCylinder(neon, g.cx, topY + ch, g.cz, Math.min(iw, id) * 0.42, 0.22, neonC);
      } else {
        pushBox(solid, g.cx, topY, g.cz, iw, ch * 0.62, id, [0.20, 0.25, 0.45]);
        pushBox(solid, g.cx, topY + ch * 0.62, g.cz, iw * 0.62, ch * 0.38, id * 0.62, [0.23, 0.29, 0.48]);
        pushBox(neon, g.cx, topY + ch, g.cz, iw * 0.62, 0.22, id * 0.62, neonC);
        pushBox(neon, g.cx, topY + ch, g.cz, iw * 0.57, 0.22, id * 0.57, [0.10, 0.13, 0.25]);
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          pushBox(neon, g.cx + sx * iw * 0.44, topY + ch, g.cz + sz * id * 0.44, 0.7, 1.6, 0.7, neonC);
        }
      }
      forms++;
    } else if (g.h >= 20) {
      if (g.h >= 40 && roll < 0.25) {
        // 中高层退台顶（R03/L03：退台不只高层有，中层也要有）
        pushBox(solid, g.cx, topY, g.cz, g.w * 0.7, 3, g.d * 0.7, [0.20, 0.25, 0.45]);
        pushBox(solid, g.cx, topY + 3, g.cz, g.w * 0.45, 2.2, g.d * 0.45, [0.23, 0.29, 0.48]);
        pushBox(neon, g.cx, topY + 5.2, g.cz, g.w * 0.45, 0.22, g.d * 0.45, neonC);
        forms++;
      } else if (roll < 0.38) {
        pushPyramid(solid, g.cx, topY, g.cz, g.w * 0.96, Math.max(2.5, Math.min(9, Math.min(g.w, g.d) * 0.22)), g.d * 0.96, [0.16, 0.21, 0.40]);
        forms++;
      } else if (roll < 0.72) {
        pushBox(solid, g.cx, topY, g.cz, g.w * 0.32, 2.5 + rngForm() * 1.5, g.d * 0.32, [0.18, 0.23, 0.42]);
        pushBox(solid, g.cx + g.w * 0.25, topY, g.cz - g.d * 0.22, 2.2, 1.2, 2.2, [0.15, 0.19, 0.36]);
        forms++;
      } else if (roll2 < 0.3) {
        pushCylinder(solid, g.cx, topY, g.cz, Math.min(g.w, g.d) * 0.36, 2.5 + rngForm() * 1.5, [0.17, 0.22, 0.41]);
        forms++;
      } else {
        pushPrism(solid, g.cx, topY, g.cz, g.w * 0.96, Math.max(2, Math.min(7, Math.min(g.w, g.d) * 0.18)), g.d * 0.96, [0.16, 0.21, 0.40], g.w >= g.d);
        forms++;
      }
    } else {
      if (roll < 0.3) {
        pushPyramid(solid, g.cx, topY, g.cz, g.w * 0.9, Math.max(2, Math.min(4, Math.min(g.w, g.d) * 0.2)), g.d * 0.9, [0.15, 0.20, 0.38]);
        forms++;
      } else if (roll < 0.7) {
        pushBox(solid, g.cx, topY, g.cz, g.w * 0.3, 2.2 + rngForm() * 1.2, g.d * 0.3, [0.18, 0.23, 0.42]);
        pushBox(solid, g.cx - g.w * 0.22, topY, g.cz + g.d * 0.2, 1.8, 1.0, 1.8, [0.15, 0.19, 0.36]);
        forms++;
      }
    }
    // 裙楼：H>=30 且大底盘（高层/中高层商业体量），不再只限 H>=60
    if (g.h >= 30 && g.w >= 30 && g.d >= 25) {
      pushBox(solid, g.cx, 0, g.cz, g.w * 1.12, 5.5, g.d * 1.12, [0.16, 0.20, 0.35]);
    }
    digestAdd(hash2(g.cx, g.cz) ^ Math.round(g.h * 10) ^ Math.round(g.area));
    if (g.cx >= PHASE1.x0 && g.cx <= PHASE1.x1 && g.cz >= PHASE1.z0 && g.cz <= PHASE1.z1) S.phase1Clusters++;
    else S.phase2Clusters++;
  }
  if (!idx) geo.attributes.color.needsUpdate = true;
  chunkDigest.set(key, S.digest);
  const mSolid = bagToMesh(THREE, solid, matSolid);
  const mNeon = bagToMesh(THREE, neon, matNeon);
  if (mSolid) { mSolid.name = 'roofs-solid-' + key; roofGroup.add(mSolid); }
  if (mNeon) { mNeon.name = 'roofs-neon-' + key; neonGroup.add(mNeon); }
  S.clusters += clusters.length;
  S.roofForms += forms;
  S.parapetEdges += edges;
  clustersByChunk.set(key, clusters.map((g) => ({ cx: g.cx, cz: g.cz, topY: g.topY, w: g.w, d: g.d, h: g.h })));
  return clusters.length;
}

function nearestClusterTop(x, z, r) {
  let best = null;
  for (const list of clustersByChunk.values()) {
    for (const c of list) {
      const d = Math.hypot(c.cx - x, c.cz - z);
      if (d < r && (!best || c.topY > best.topY)) best = c;
    }
  }
  return best;
}

// ---- 16 座地标屋顶造型（每座一个独立形制；新名分派；构件为通用形制）----
function buildLandmarkRoof(spec, lm, topY, w, d, solid, neon) {
  const accent = NEON[spec.neon];
  const accent2 = NEON[(spec.neon + 1) % NEON.length];
  const x = lm.x, z = lm.z;
  const tile = [0.16, 0.21, 0.40];       // 古建瓦顶：冷蓝紫调（配色表 R05 落法，不抄参考瓦色）
  const tileDark = [0.14, 0.18, 0.36];   // 灰瓦街区：更暗的冷蓝紫灰
  const eave = [0.12, 0.15, 0.28];       // 檐板
  const crown = [0.23, 0.29, 0.48];      // 现代冠顶
  const skirt = [0.16, 0.20, 0.35];      // 裙楼/底座
  const eaveLine = (cx, cz, ew, ed, y) => {
    for (const [dx, dz, len, ry] of [[0, -ed / 2, ew, 0], [0, ed / 2, ew, 0], [-ew / 2, 0, ed, Math.PI / 2], [ew / 2, 0, ed, Math.PI / 2]]) {
      pushBox(neon, cx + dx, y, cz + dz, len, 0.35, 0.5, accent, ry);
    }
  };
  const podium = (pw, pd, ph = 5) => pushBox(solid, x, 0, z, pw, ph, pd, skirt);
  switch (spec.form) {
    case 'pavilion': { // 望星公园：园内古建亭顶 + 一座小亭
      pushBox(solid, x, topY, z, w * 0.5 + 6, 1.0, d * 0.5 + 6, eave);
      pushPyramid(solid, x, topY + 1, z, w * 0.5 + 3, Math.max(4, Math.min(9, Math.min(w, d) * 0.2)), d * 0.5 + 3, tile);
      pushBox(solid, x, topY + 1 + Math.max(4, Math.min(9, Math.min(w, d) * 0.2)), z, 2.2, 2.4, 2.2, crown);
      eaveLine(x, z, w * 0.5 + 6, d * 0.5 + 6, topY + 0.4);
      pushBox(solid, x + w * 0.32, topY, z + d * 0.3, 10, 0.8, 10, eave);
      pushPyramid(solid, x + w * 0.32, topY + 0.8, z + d * 0.3, 11, 3.5, 11, tile);
      break;
    }
    case 'ancient-hall': // 凌霄祠：大殿四坡顶 + 檐板 + 宝顶 + 两配殿小顶
    case 'taoist': { // 紫气宫：三清殿四坡顶 + 八角亭 + 山门（与古建殿共用大殿做法，亭为八角）
      const ph = Math.max(4, Math.min(12, Math.min(w, d) * 0.28));
      pushBox(solid, x, topY, z, w + 8, 1.0, d + 8, eave);
      pushPyramid(solid, x, topY + 1, z, w + 5, ph, d + 5, tile);
      pushBox(solid, x, topY + 1 + ph, z, 2.4, 2.6, 2.4, crown);
      eaveLine(x, z, w + 8, d + 8, topY + 0.4);
      pushBox(solid, x - w * 0.3, topY, z + d * 0.3, 8, 3.2, 8, tile);
      pushPyramid(solid, x - w * 0.3, topY + 3.2, z + d * 0.3, 9, 3, 9, tile);
      if (spec.form === 'taoist') {
        pushCylinder(solid, x + w * 0.32, topY, z - d * 0.28, 5, 2.2, eave, 8);
        pushOctPyramid(solid, x + w * 0.32, topY + 2.2, z - d * 0.28, 6.5, 4, tile);
        pushBox(solid, x, topY, z + d * 0.42, 10, 3, 3, tile); // 山门
      }
      break;
    }
    case 'cottage': { // 听涛草堂：低坡三角顶 + 亭小顶 + 廊
      pushPrism(solid, x, topY, z, w * 0.96, Math.max(2.5, Math.min(5, Math.min(w, d) * 0.14)), d * 0.96, tile, w >= d);
      pushBox(solid, x + w * 0.3, topY, z + d * 0.28, 9, 0.8, 9, eave);
      pushPyramid(solid, x + w * 0.3, topY + 0.8, z + d * 0.28, 10, 3.2, 10, tile);
      pushBox(solid, x - w * 0.32, topY, z - d * 0.3, 14, 1.6, 4, tile); // 廊
      break;
    }
    case 'alley': // 青石双巷：古建街区屋顶，一排小三角坡顶 + 院门小顶
    case 'lowtile': { // 星光里：低层灰瓦街区屋顶，一排低层小三角坡顶
      const c = spec.form === 'lowtile' ? tileDark : tile;
      const n = 4;
      pushGableRow(solid, x, topY, z, w * 0.96, spec.form === 'lowtile' ? 2.5 : 3.2, d * 0.9, c, n, w >= d);
      pushBox(solid, x, topY, z - d * 0.42, 8, 2.6, 2.5, c); // 院门
      pushPyramid(solid, x, topY + 2.6, z - d * 0.42, 9, 2.2, 4, c);
      break;
    }
    case 'temple': { // 云林禅院：大殿四坡顶 + 山门 + 三叠小塔
      const ph = Math.max(4, Math.min(12, Math.min(w, d) * 0.28));
      pushBox(solid, x, topY, z, w + 8, 1.0, d + 8, eave);
      pushPyramid(solid, x, topY + 1, z, w + 5, ph, d + 5, tile);
      pushBox(solid, x, topY + 1 + ph, z, 2.4, 2.6, 2.4, crown);
      eaveLine(x, z, w + 8, d + 8, topY + 0.4);
      pushBox(solid, x, topY, z + d * 0.42, 10, 3, 3, tile); // 山门
      let ty = topY; // 三叠小塔（通用塔形，不抄任何实塔）
      for (const s of [9, 7, 5]) { pushBox(solid, x + w * 0.32, ty, z - d * 0.3, s, 1.2, s, eave); pushPyramid(solid, x + w * 0.32, ty + 1.2, z - d * 0.3, s + 1, 2.4, s + 1, tile); ty += 3.6; }
      break;
    }
    case 'panda-modern': { // 云竹熊猫苑：通用现代冠顶 + 霓虹框 + LED 带（不做熊猫造型）
      const iw = w * 0.68, id = d * 0.68, ch = 5;
      pushBox(solid, x, topY, z, iw, ch, id, crown);
      pushBox(neon, x, topY + ch, z, iw, 0.3, id, accent);
      pushBox(neon, x, topY + ch, z, iw * 0.9, 0.3, id * 0.9, skirt);
      pushBox(neon, x, topY + 1, z - id / 2 - 0.4, iw * 0.55, 5, 0.5, accent2);
      podium(w * 1.08, d * 1.08);
      break;
    }
    case 'tomb': { // 青石陵：封土冢形圆顶 + 祠堂坡顶
      pushCylinder(solid, x, topY, z, Math.min(w, d) * 0.36, 3.5, tileDark, 24);
      pushPyramid(solid, x, topY + 3.5, z, Math.min(w, d) * 0.3, 2.5, Math.min(w, d) * 0.3, tile);
      pushBox(solid, x + w * 0.3, topY, z + d * 0.28, 10, 0.8, 10, eave);
      pushPyramid(solid, x + w * 0.3, topY + 0.8, z + d * 0.28, 11, 3, 11, tile);
      break;
    }
    case 'station': { // 星泽东站：现代大跨度屋顶，宽跨浅坡顶 + 雨棚 + 幕墙竖线
      const sw = Math.max(w, 80), sd = Math.max(d, 50);
      pushPrism(solid, x, topY, z, sw * 0.96, Math.max(4, Math.min(8, sd * 0.12)), sd * 0.96, crown, true);
      pushBox(neon, x, topY + Math.max(4, Math.min(8, sd * 0.12)), z, sw * 0.9, 0.3, 0.6, accent);
      pushBox(solid, x, topY - 2, z + sd * 0.55, sw * 0.9, 1.2, 12, skirt); // 雨棚
      for (const t of [-0.375, -0.125, 0.125, 0.375]) {
        pushBox(solid, x + t * sw, 3, z - sd * 0.48, 0.9, topY - 3, 0.9, CURTAIN);
        pushBox(neon, x + t * sw, 3, z - sd * 0.48, 0.35, topY - 3, 0.35, NEON[1]);
      }
      podium(sw * 1.05, sd * 1.05, 4);
      break;
    }
    case 'industrial': { // 铁光记忆园：工业风屋顶，锯齿顶 + 烟囱
      const n = 3, sw = (w * 0.96) / n;
      for (let i = 0; i < n; i++) {
        const px = x + (i - (n - 1) / 2) * sw;
        pushPrism(solid, px, topY, z, sw * 0.94, 3.5, d * 0.9, tileDark, false);
        pushBox(solid, px + sw * 0.3, topY + 3.5, z, sw * 0.3, 1.6, d * 0.9, crown); // 锯齿竖面
      }
      pushCylinder(solid, x + w * 0.42, topY, z + d * 0.32, 2.2, 18, tileDark, 12); // 烟囱
      pushBox(neon, x, topY + 1, z - d * 0.45, w * 0.5, 2.2, 0.5, accent); // 霓虹招牌带（通用字由 skin/街面画，本文件只留色带）
      break;
    }
    case 'supertall': { // 星环中心：超高层冠顶，两级退台 + 霓虹框 + 角部信标；大体量底盘
      const bw = Math.max(w, 110), bd = Math.max(d, 80);
      const iw = bw * 0.6, id = bd * 0.6, ch = 7;
      podium(bw * 1.08, bd * 1.08, 6);
      pushBox(solid, x, topY, z, iw, ch * 0.6, id, crown);
      pushBox(solid, x, topY + ch * 0.6, z, iw * 0.62, ch * 0.4, id * 0.62, [0.27, 0.35, 0.62]);
      pushBox(neon, x, topY + ch, z, iw * 0.62, 0.3, id * 0.62, accent);
      pushBox(neon, x, topY + ch, z, iw * 0.56, 0.3, id * 0.56, skirt);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        pushBox(neon, x + sx * iw * 0.44, topY + ch, z + sz * id * 0.44, 0.8, 2.2, 0.8, accent);
      }
      break;
    }
    case 'museum': { // 星泽艺术公园：美术馆弧顶 + 幕墙竖线 + 亭廊小顶
      const r = Math.min(w, d) * 0.32;
      pushArcRoof(solid, x, topY, z, r, Math.max(w * 0.8, 40), crown);
      pushBox(solid, x, topY, z, w * 0.8, 1.0, d * 0.8, eave);
      for (const t of [-0.3, 0, 0.3]) {
        pushBox(solid, x + t * w * 0.8, 3, z - d * 0.4, 0.9, topY - 3, 0.9, CURTAIN);
        pushBox(neon, x + t * w * 0.8, 3, z - d * 0.4, 0.35, topY - 3, 0.35, NEON[1]);
      }
      pushBox(solid, x + w * 0.32, topY, z + d * 0.3, 9, 0.8, 9, eave);
      pushPyramid(solid, x + w * 0.32, topY + 0.8, z + d * 0.3, 10, 3, 10, tile);
      break;
    }
    case 'double-eave': { // 望星楼：重檐坡顶，两叠四坡顶 + 两道檐板
      const ph1 = Math.max(3, Math.min(8, Math.min(w, d) * 0.2));
      const ph2 = Math.max(3, Math.min(7, Math.min(w, d) * 0.16));
      pushBox(solid, x, topY, z, w + 8, 1.0, d + 8, eave);
      pushPyramid(solid, x, topY + 1, z, w + 5, ph1, d + 5, tile);
      eaveLine(x, z, w + 8, d + 8, topY + 0.4);
      pushBox(solid, x, topY + 1 + ph1, z, w * 0.62 + 6, 1.0, d * 0.62 + 6, eave);
      pushPyramid(solid, x, topY + 2 + ph1, z, w * 0.62 + 3, ph2, d * 0.62 + 3, tile);
      pushBox(solid, x, topY + 2 + ph1 + ph2, z, 2.4, 2.6, 2.4, crown);
      eaveLine(x, z, w * 0.62 + 6, d * 0.62 + 6, topY + 1 + ph1 + 0.4);
      break;
    }
    case 'twin': { // 双星塔：双塔冠顶，两座错开退台冠顶，粉/青各一座（218m 为核实数，见 state）
      const off = Math.max(18, w * 0.22);
      const iw = Math.max(20, w * 0.34), id = Math.max(20, d * 0.5), ch = 6;
      for (const [sx, ac] of [[-1, NEON[0]], [1, NEON[1]]]) {
        const tx = x + sx * off;
        pushBox(solid, tx, topY, z, iw, ch * 0.6, id, crown);
        pushBox(solid, tx, topY + ch * 0.6, z, iw * 0.62, ch * 0.4, id * 0.62, [0.27, 0.35, 0.62]);
        pushBox(neon, tx, topY + ch, z, iw * 0.62, 0.3, id * 0.62, ac);
        pushBox(neon, tx, topY + ch, z, iw * 0.3, 2.0, 0.6, ac);
      }
      podium(w * 1.15, d * 1.15, 5);
      break;
    }
    case 'arcade': { // 灯影里：古建街区屋顶，一排青瓦坡顶 + 牌坊
      pushGableRow(solid, x, topY, z, w * 0.96, 3.2, d * 0.9, tile, 4, w >= d);
      // 牌坊：两柱 + 额枋 + 小四坡顶（通用形制，不抄任何实景牌坊）
      pushBox(solid, x - 6, topY, z - d * 0.42, 1.2, 6, 1.2, tileDark);
      pushBox(solid, x + 6, topY, z - d * 0.42, 1.2, 6, 1.2, tileDark);
      pushBox(solid, x, topY + 6, z - d * 0.42, 14, 1.0, 1.6, eave);
      pushPyramid(solid, x, topY + 7, z - d * 0.42, 15, 2.5, 3.5, tile);
      break;
    }
    default: { // 兜底：现代退台冠顶 + 霓虹框（不应走到这里；走到即说明 LANDMARK_FORM 漏了新名）
      const iw = w * 0.68, id = d * 0.68, ch = 5;
      pushBox(solid, x, topY, z, iw, ch, id, crown);
      pushBox(neon, x, topY + ch, z, iw, 0.3, id, accent);
      console.warn('[roofs] landmark form missing for', lm);
      break;
    }
  }
}

function buildLandmark(lm, idx) {
  // 旧名 -> 新名（只用新名分派、登记、输出）
  const newName = OLD_TO_NEW[lm.name] || lm.name;
  if (newName === TOWER_NEW) {
    // 揽星塔：不做任何几何，只登记。塔身归 4 路 tower-fix.js（真 339m）。
    landmarkState.set(newName, { built: false, registered: true, form: 'tower-registered-only', topY: 339, heightVerified: 339 });
    S.towerRegistered = true;
    return;
  }
  if (SKIP8.has(newName)) {
    // 屋顶栏"—"的 8 座：不做单体屋顶，只登记（街面/道路归 3/2 路）。
    landmarkState.set(newName, { built: false, skipped: true, form: 'not-lane1', topY: 0 });
    S.landmarksSkipped++;
    return;
  }
  const spec = LANDMARK_FORM[newName];
  if (!spec) {
    landmarkState.set(newName, { built: false, skipped: true, form: 'unknown-name', topY: 0 });
    console.warn('[roofs] landmark not in LANDMARK_FORM:', lm.name, '->', newName);
    return;
  }
  const near = nearestClusterTop(lm.x, lm.z, 130);
  const topY = near ? near.topY : 15;
  const w = near ? Math.max(24, near.w) : 40;
  const d = near ? Math.max(24, near.d) : 40;
  const solid = newBag(), neon = newBag();
  buildLandmarkRoof(spec, lm, topY, w, d, solid, neon);
  // 合并进地标组（重建两块合并几何，避免 16 座 × N 个 draw call）
  const oldS = landmarkGroup.getObjectByName('landmark-solid');
  const oldN = landmarkGroup.getObjectByName('landmark-neon');
  const accS = oldS ? oldS.userData.bag : newBag();
  const accN = oldN ? oldN.userData.bag : newBag();
  // 修复：旧版只合 pos/nrm/col，漏了 uv，属性长度会错位；四项全合。
  for (const k of ['pos', 'nrm', 'col', 'uv']) { accS[k].push(...solid[k]); accN[k].push(...neon[k]); }
  if (oldS) { landmarkGroup.remove(oldS); oldS.geometry.dispose(); }
  if (oldN) { landmarkGroup.remove(oldN); oldN.geometry.dispose(); }
  const mS = bagToMesh(THREE, accS, matSolid);
  const mN = bagToMesh(THREE, accN, matNeon);
  if (mS) { mS.name = 'landmark-solid'; mS.userData.bag = accS; landmarkGroup.add(mS); }
  if (mN) { mN.name = 'landmark-neon'; mN.userData.bag = accN; landmarkGroup.add(mN); }
  landmarkState.set(newName, { built: true, form: spec.form, topY, heightVerified: VERIFIED_HEIGHT[newName] || null });
  S.landmarksBuilt++;
}

function tick() {
  if (!ctx || !ctx.sixLoader || !ctx.sixLoader.chunkGroup) return;
  // 小机器上渲染器曾在 roofs 处理时崩过（SwiftShader + 大包 + 多路共用）：
  // 每 tick 只啃 2 块、且三角面预算 12 万，啃完就让出主线程，不一次堵死渲染。
  let budget = 2, triBudget = 120000;
  const meshes = [];
  ctx.sixLoader.chunkGroup.traverse((o) => { if (o.isMesh && o.geometry) meshes.push(o); });
  for (const m of meshes) {
    if (budget <= 0 || triBudget <= 0) break;
    if (processed.has(m)) continue;
    processed.add(m);
    budget--;
    const triCount = m.geometry.index
      ? m.geometry.index.array.length / 3
      : m.geometry.attributes.position.array.length / 9;
    triBudget -= triCount;
    // 分块 key：取几何包围盒中心反推 chunk（500m，OX=-60000，OZ=-51000）
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox;
    const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
    const key = Math.floor((cx + 60000) / 500) + '_' + Math.floor((cz + 51000) / 500);
    try { buildChunkRoofs(m, key); S.chunksProcessed++; } catch (e) { console.error('[roofs] chunk failed', key, e); }
  }
  // 地标：等附近分块处理出顶高后再建；60s 内没等到用 fallback 顶高。
  // 揽星塔与 8 座"—"只登记不建几何，也走同一条登记路径。
  const lms = (ctx.sixIndex && ctx.sixIndex.landmarks) || (ctx.DATA && ctx.DATA.landmarks) || [];
  S.landmarksTotal = lms.length;
  const now = performance.now();
  lms.forEach((lm, i) => {
    const newName = OLD_TO_NEW[lm.name] || lm.name;
    if (landmarkState.has(newName)) return;
    const near = nearestClusterTop(lm.x, lm.z, 130);
    if (near || now - (tick._t0 || (tick._t0 = now)) > 60000) {
      try { buildLandmark(lm, i); } catch (e) { console.error('[roofs] landmark failed', lm.name, e); landmarkState.set(newName, { built: false, topY: 0 }); }
    }
  });
  applyMode();
  window.__roofs = statsSnapshot();
}

function applyMode() {
  if (!roofGroup) return;
  const white = mode === 'white', heat = mode === 'heat';
  roofGroup.visible = !white;
  neonGroup.visible = !white && !heat;
  landmarkGroup.visible = !white;
  const ln = landmarkGroup.getObjectByName('landmark-neon');
  if (ln) ln.visible = !white && !heat;
}

function statsSnapshot() {
  return {
    ...S,
    chunkDigest: Object.fromEntries(chunkDigest),
    landmarks: [...landmarkState.entries()].map(([name, v]) => ({ name, built: v.built, form: v.form || null, topY: +(+v.topY || 0).toFixed(1), heightVerified: v.heightVerified || null, skipped: !!v.skipped, registered: !!v.registered })),
  };
}

export function setDisplay(m) {
  mode = m || 'normal';
  applyMode();
  window.__roofs = statsSnapshot();
}

export function stats() { return statsSnapshot(); }

// 测试导出（procedural-gen Pattern 2：把自有 PRNG 钉在测试里，重构改了输出就露馅）
export const __roofTest = { splitmix, hash2, roofColorFor, outwardNormal, emitTri, pushBox, newBag };

export async function init(c) {
  ctx = c; THREE = c.THREE;
  if (!THREE || !c.scene) throw new Error('[roofs] ctx 缺 THREE/scene');
  matSolid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.12 });
  matNeon = new THREE.MeshBasicMaterial({ vertexColors: true });
  roofGroup = new THREE.Group(); roofGroup.name = 'surpass-roofs';
  neonGroup = new THREE.Group(); neonGroup.name = 'surpass-roofs-neon';
  landmarkGroup = new THREE.Group(); landmarkGroup.name = 'surpass-landmarks';
  c.scene.add(roofGroup); c.scene.add(neonGroup); c.scene.add(landmarkGroup);
  // 跟着 loader 的显示切换走（包一层，不改 six-loader.js；skin.js 再包一层也能链式工作）
  if (c.sixLoader && !c.sixLoader.__roofsWrapped) {
    c.sixLoader.__roofsWrapped = true;
    const orig = c.sixLoader.setDisplay.bind(c.sixLoader);
    c.sixLoader.setDisplay = (m) => { orig(m); setDisplay(m); };
  }
  tick._t0 = performance.now();
  // 首 tick 不在 init 里同步跑（曾堵渲染主线程），900ms 后由 interval 带起来
  timer = setInterval(tick, 900);
  window.__roofs = statsSnapshot();
  console.log('[roofs] init ok');
  return { ok: true };
}
