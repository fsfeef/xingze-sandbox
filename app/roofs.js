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
//   ⑥ 白膜模式（16:28 令改）：屋顶实体 + 地标不再整个藏掉，换浅灰白陶土色 #f2f0ea 显示
//   （与 six-loader matClay 同色同粗糙度），只藏霓虹——白天航拍里屋顶形状和地标还在、
//   是干净的浅色；热力模式：霓虹隐藏、实体保留。霓虹只在夜里亮（见 setNight）。
//   正常模式颜色仍按配色表 §4（深蓝带），不动。
//   ⑦ 一环以外（Phase 2）：参考站只覆盖一环内外，一环以外没人可抄——用同一套
//      方法（管线 §6）、拿我们自己的六区 OSM 数据（分块几何实测顶面 + 位置哈希
//      种子）自己建出来，不空着、不瞎编；一环内/外同一套分型，计数分开报
//      （phase1Clusters / phase2Clusters）；高度口径一律层数×3.2 + OSM 标签（v2.1），
//      顶高取分块几何实测顶面 y，估算标估算；只有揽星塔 339m、双星塔 218m 是核实数。
//   ⑧ 园内亭子（2026-11-26 16:32 令：公园先做亭子）：25 地标园里 4 个园先行——
//      望星公园 / 云锦湖 / 星泽艺术公园 / 云竹熊猫苑（PAVILION_PARKS）；其余园以后补。
//      亭子只做屋顶+柱+台基三件，不做室内；落地 y=0，位置 = 地标登记点 +
//      位置哈希种子偏移，不猜坐标、不编园界（登记里只有点，没有园的范围）。
//      云锦湖在 SKIP8 里（不做单体屋顶），园内亭子是地面小品，不走单体屋顶，照样做。
//      亭顶只用已有古建套件（四坡顶/八角亭顶/重檐），柱用八角柱，台基/檐板用倒角板，
//      不加 solid 盒子（G6 白名单不动）；不做熊猫造型（红线同上）。
// 地标名：只用 six-names.json 的新名。运行时 six-index.json 里仍是旧名，
//   本文件用 OLD_TO_NEW（逐字抄 six-names.json）把旧名换成新名再分派；
//   对外输出（stats/landmarkState）一律新名，旧名只出现在换名表这一处。
// 比例纠错（14:11）：参考的错不搬——参考 339 塔标签 339m、模型 113m 级，
//   我们按真 339m（4 路 tower-fix.js）；本文件揽星塔只登记，不量不建。
// 依赖：window.__sandbox（scene/THREE/sixLoader/sixIndex/state）。

// ---- 第二段生产简报（blender-director 法：先简报后动手）----
// 资产：全城屋顶（通用楼 + 16 座地标屋顶）；目标：网页 Three.js r170 沙盘；
// 风格：游戏画面（冷蓝紫 + 霓虹）；体量预算：每分块 solid+neon 各 1 个合并 mesh，
//   地标 solid+neon+metal 各 1 个；不新增 draw call 大户（金属只进地标）。
// 顺序（林萧 16:26：先技能、后照人家的方法；方法 = 阿哲那套，见 extract-from-formulasearch-2026-11-26.md）：
//   ① 数据层：分块几何实测顶面聚类（clusterTopFaces，已有）；② 地标逐处重建：16 座各一个形制，
//   一座一座改（buildLandmarkRoof）；③ 两套构件库：古建库（檐板/四坡顶/宝顶/重檐/八角亭/牌坊）
//   + 现代库（退台/皇冠/Mansard/倒角冠顶/弧顶/锯齿顶），构件是我们自己的通用形制；
//   ④ 像素回归：tests/verify-roofs.js（白天鸟瞰 + 地标近景 + 夜里 22:00）+ tests/pixel-regress.js，
//   改完截图对比，突变报警；⑤ 子代理独立检查审查过再合并：tests/roofs-seed-sweep.mjs
//   （确定性 + 分布 + 几何门，Node 直跑）先过，过了才算交活。
// 技能落点（12 个全读过，见本文件末尾对照表）：procedural-gen（Pattern 1 子种子 / Pattern 2
//   自有 PRNG 钉测试 / Pattern 3 加权表 / Pattern 4 种子扫掠）、procedural-modeling（楼生成链：
//   足迹→挤出→屋顶类型开关→材质号；参数极值验证）、img2threejs（分阶段建造 + 多角度门）、
//   video2threejs（规则 8 单一连续面、规则 11 闭合体+绕向、规则 15 截图自评）、
//   threejs-materials-lighting（标准材质默认、霓虹用无光材质、金属冠顶单独材质）、
//   threejs-3d-generator / threejs-image-generator / 5 个 Blender 技能：没用，原因见末尾对照表。
// 参考截图至今未到（配色表 29 行：已见 0 / 转述 15 / 未见 14）：青瓦/深色砖的归属与色值
//   仍按方案 §4 走，不编参考颜色；比例修正只用坡度规则（瓦顶坡度 30°±5°、Mansard 下坡 60°–70°），
//   不写“照参考量过”的数。
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

// ---- 园内亭子规划表（2026-11-26 16:32 令；新名；forms 按座取，首座是主亭）----
// 望星公园 3 座（八角主亭 + 四坡 + 重檐）；云锦湖 3 座（四坡主亭 + 八角 + 四坡）；
// 星泽艺术公园 2 座（八角 + 四坡）；云竹熊猫苑 2 座（四坡 + 八角）。合计 10 座。
const PAVILION_PARKS = {
  '望星公园':     { forms: ['octagon', 'hip', 'double-eave'], neon: 2 },
  '云锦湖':       { forms: ['hip', 'octagon', 'hip'],         neon: 1 },
  '星泽艺术公园': { forms: ['octagon', 'hip'],                neon: 2 },
  '云竹熊猫苑':   { forms: ['hip', 'octagon'],                neon: 0 },
};
// 单座亭子：台基（两级倒角板，顶面 y=1.0）+ 柱（八角柱，顶到檐板底）+ 檐板（倒角板）
//   + 亭顶（四坡/八角/重檐三选一）+ 宝顶；霓虹只描一道檐线（夜里亮，白膜/白天藏）。
//   尺寸：主亭 11m、余亭 8m；柱高 3.0m；瓦顶坡度≈30°（rise ≈ size×0.3，见文件头坡度规则）。
//   一个 solid 盒子都不加：台基/檐板是倒角板，柱是八角柱，顶是真斜面。
function pushPavilion(solid, neon, metal, cx, cz, form, size, accent) {
  const tile = [0.16, 0.21, 0.40];       // 古建瓦顶：冷蓝紫调（配色表 R05 落法）
  const eave = [0.12, 0.15, 0.28];       // 檐板
  const colC = [0.22, 0.24, 0.38];       // 柱：冷蓝紫里的深青灰（不另编暖木色）
  const steel = [0.62, 0.68, 0.85];      // 宝顶金属
  const skirt = [0.16, 0.20, 0.35];      // 台基
  pushChamferCrown(solid, cx, 0, cz, size + 2.4, 0.6, size + 2.4, skirt);
  pushChamferCrown(solid, cx, 0.6, cz, size + 1.2, 0.4, size + 1.2, skirt);
  const colH = 3.0, eaveY = 1.0 + colH;
  if (form === 'octagon') {
    const r = size * 0.36;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      pushCylinder(solid, cx + Math.cos(a) * r, 1.0, cz + Math.sin(a) * r, 0.26, colH, colC, 8);
    }
  } else {
    const o = size * 0.36;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      pushCylinder(solid, cx + sx * o, 1.0, cz + sz * o, 0.28, colH, colC, 8);
    }
  }
  pushChamferCrown(solid, cx, eaveY, cz, size + 1.8, 0.8, size + 1.8, eave);
  for (const [dx, dz, len, ry] of [[0, -(size + 1.8) / 2, size + 1.8, 0], [0, (size + 1.8) / 2, size + 1.8, 0], [-(size + 1.8) / 2, 0, size + 1.8, Math.PI / 2], [(size + 1.8) / 2, 0, size + 1.8, Math.PI / 2]]) {
    pushBox(neon, cx + dx, eaveY + 0.2, cz + dz, len, 0.3, 0.45, accent, ry);
  }
  const roofY = eaveY + 0.8;
  if (form === 'octagon') {
    const rh = Math.max(2.5, Math.min(4.5, size * 0.32));
    pushOctPyramid(solid, cx, roofY, cz, (size + 1.4) * 0.62, rh, tile);
    pushFinial(metal, cx, roofY + rh, cz, 1.1, steel);
  } else if (form === 'double-eave') {
    const ph1 = Math.max(2.5, Math.min(4, size * 0.28));
    const ph2 = Math.max(2, Math.min(3.2, size * 0.22));
    pushPyramid(solid, cx, roofY, cz, size + 1.4, ph1, size + 1.4, tile);
    pushChamferCrown(solid, cx, roofY + ph1, cz, size * 0.62 + 1.2, 0.7, size * 0.62 + 1.2, eave);
    pushPyramid(solid, cx, roofY + ph1 + 0.7, cz, size * 0.62 + 0.8, ph2, size * 0.62 + 0.8, tile);
    pushFinial(metal, cx, roofY + ph1 + 0.7 + ph2, cz, 1.0, steel);
  } else { // hip：四坡顶
    const rh = Math.max(2.5, Math.min(4.5, size * 0.3));
    pushPyramid(solid, cx, roofY, cz, size + 1.4, rh, size + 1.4, tile);
    pushFinial(metal, cx, roofY + rh, cz, 1.1, steel);
  }
}
// 园内亭子布点：沿地标登记点（lm.x/lm.z）布点，种子只来自地标位置。
//   clearR = 地标基座半宽 + 12m（亭子不埋进基座里）；云锦湖无基座，w 传 0，clearR=0。
//   角度 = 种子基角 + 均分 + 抖动；半径 = clearR + 8 + 逐座外扩 9m + 抖动 0–8m。
//   同一园每次同一批亭子（种子钉死）；园界不在登记里，半径只保不撞基座，不保不出园。
function buildGardenPavilions(newName, lm, w, solid, neon, metal) {
  const plan = PAVILION_PARKS[newName];
  if (!plan) return 0;
  const accent = NEON[plan.neon];
  const rng = splitmix(hash2(lm.x, lm.z) ^ 0x9A71);
  const baseAngle = rng() * Math.PI * 2;
  const clearR = w ? (w * 1.35) / 2 + 12 : 0;
  let n = 0;
  plan.forms.forEach((form, i) => {
    const ang = baseAngle + (i / plan.forms.length) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    const r = clearR + 8 + i * 9 + rng() * 8;
    const px = lm.x + Math.cos(ang) * r;
    const pz = lm.z + Math.sin(ang) * r;
    pushPavilion(solid, neon, metal, px, pz, form, i === 0 ? 11 : 8, accent);
    n++;
  });
  return n;
}

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
function pushMansard(bag, cx, y0, cz, w, h, d, color) {
  // Mansard 顶（unreal ② 语法楼盖顶 + procedural-modeling 屋顶类型开关）：
  // 四面斜坡（下坡 60°–70°，顶口每边内收 35%）+ 平顶盖。不是盒子：斜面是真斜面，
  // 顶盖是平顶，侧面 4 个梯形（各 2 三角）+ 顶盖 2 三角。
  const hw = w / 2, hd = d / 2, k = 0.65;
  const tw = hw * k, td = hd * k, y1 = y0 + h;
  const B = [[cx - hw, y0, cz - hd], [cx + hw, y0, cz - hd], [cx + hw, y0, cz + hd], [cx - hw, y0, cz + hd]];
  const T = [[cx - tw, y1, cz - td], [cx + tw, y1, cz - td], [cx + tw, y1, cz + td], [cx - tw, y1, cz + td]];
  for (let i = 0; i < 4; i++) {
    const a = B[i], b = B[(i + 1) % 4], c = T[(i + 1) % 4], e = T[i];
    const n = outwardNormal(a, b, c, cx, y0 + h / 2, cz);
    emitTri(bag, a, b, c, n, color);
    emitTri(bag, a, c, e, n, color);
  }
  emitTri(bag, T[0], T[1], T[2], [0, 1, 0], color);
  emitTri(bag, T[0], T[2], T[3], [0, 1, 0], color);
}
function pushChamferCrown(bag, cx, y0, cz, w, h, d, color) {
  // 倒角冠顶（unreal ② 皇冠盖顶的棱角做法）：竖向 45° 切角的八边形柱，
  // 切角量 = 短边 28%。方块盒子四个直角全切掉，顶盖扇形封顶。
  // h 很小时就是一块倒角板（檐板/裙楼/雨棚都用它，不再用 pushBox 做板）。
  const hw = w / 2, hd = d / 2, c = Math.min(hw, hd) * 0.28;
  const ring = (y) => [
    [cx - hw + c, y, cz - hd], [cx + hw - c, y, cz - hd],
    [cx + hw, y, cz - hd + c], [cx + hw, y, cz + hd - c],
    [cx + hw - c, y, cz + hd], [cx - hw + c, y, cz + hd],
    [cx - hw, y, cz + hd - c], [cx - hw, y, cz - hd + c],
  ];
  const B = ring(y0), T = ring(y0 + h);
  for (let i = 0; i < 8; i++) {
    const a = B[i], b = B[(i + 1) % 8], c2 = T[(i + 1) % 8], e = T[i];
    const n = outwardNormal(a, b, c2, cx, y0 + h / 2, cz);
    emitTri(bag, a, b, c2, n, color);
    emitTri(bag, a, c2, e, n, color);
  }
  const cc = [cx, y0 + h, cz];
  for (let i = 0; i < 8; i++) emitTri(bag, cc, T[i], T[(i + 1) % 8], [0, 1, 0], color);
}
function pushHipFromHull(bag, hull, topY, rise, color) {
  // 按真实轮廓的四坡顶（procedural-modeling：足迹→屋顶；video2threejs 规则 8：
  // 一个连续面，不用几个盒子拼）：凸包向形心内收 70% 成脊环，侧面 4+ 边梯形 + 顶盖扇形。
  // hull 必须是凸包（convexHull 出来的就是），少于 3 点直接退。
  if (!hull || hull.length < 3) return false;
  let gx = 0, gz = 0;
  for (const p of hull) { gx += p[0]; gz += p[1]; }
  gx /= hull.length; gz /= hull.length;
  const y1 = topY + rise;
  const ring = hull.map((p) => [gx + (p[0] - gx) * 0.3, y1, gz + (p[1] - gz) * 0.3]);
  for (let i = 0; i < hull.length; i++) {
    const a = [hull[i][0], topY, hull[i][1]];
    const b = [hull[(i + 1) % hull.length][0], topY, hull[(i + 1) % hull.length][1]];
    const c = ring[(i + 1) % hull.length], e = ring[i];
    const n = outwardNormal(a, b, c, gx, topY + rise / 2, gz);
    emitTri(bag, a, b, c, n, color);
    emitTri(bag, a, c, e, n, color);
  }
  const cc = [gx, y1, gz];
  for (let i = 0; i < ring.length; i++) emitTri(bag, cc, ring[i], ring[(i + 1) % ring.length], [0, 1, 0], color);
  return true;
}
function pushFinial(bag, cx, y0, cz, r, color) {
  // 宝顶 / 塔尖小件（古建库）：八角柱 + 小四坡顶，不用方块。
  pushCylinder(bag, cx, y0, cz, r, 1.8, color, 8);
  pushPyramid(bag, cx, y0 + 1.8, cz, r * 1.7, 1.6, r * 1.7, color);
}
function pushNeonFrame(bag, cx, y, cz, w, d, color) {
  // 霓虹框：四条细线（线条，不是体量）。pushBox 只剩这种薄板/线条。
  pushBox(bag, cx, y, cz - d / 2, w, 0.22, 0.3, color);
  pushBox(bag, cx, y, cz + d / 2, w, 0.22, 0.3, color);
  pushBox(bag, cx - w / 2, y, cz, 0.3, 0.22, d, color);
  pushBox(bag, cx + w / 2, y, cz, 0.3, 0.22, d, color);
}
// procedural-gen Pattern 3：加权表抽取（权重是相对的；roll==total 的浮点边沿落到最后一项）。
function weightedPick(rng, table) {
  let total = 0;
  for (const [, w] of table) total += w;
  let roll = rng() * total;
  for (const [item, w] of table) { roll -= w; if (roll < 0) return item; }
  return table[table.length - 1][0];
}
// 屋顶语法（unreal ② PCG 语法生成 + 退台 + 皇冠屋顶，落到我们自己的分型表）：
//   规则 = 高度带 → 形制加权表；同一栋种子固定，同一栋每次同一个顶。
//   高层 = 退台 + 皇冠盖顶（Mansard / 倒角 / 按轮廓四坡，三选一）；中层 = 坡顶系；
//   低层 = 坡顶 / 三角坡 / 平顶+斜顶机房。方块盒子不再是任何一条规则的产物。
const ROOF_GRAMMAR = {
  high: [['mansard-crown', 0.45], ['chamfer-crown', 0.35], ['hip-crown', 0.20]],
  mid: [['hip', 0.30], ['gable', 0.25], ['mansard', 0.20], ['setback', 0.15], ['round', 0.10]],
  low: [['hip', 0.40], ['gable', 0.30], ['flat-plant', 0.30]],
};
function bagToMesh(THREE, bag, material) {
  if (!bag.pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(bag.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(bag.nrm, 3));
  if (bag.col && bag.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(bag.col, 3));
  if (bag.uv && bag.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(bag.uv, 2));
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, material);
  m.userData.origMat = material; // 白膜换陶土色时凭这个换回来
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
let matSolid = null, matNeon = null, matMetal = null, matClay = null;
let mode = 'normal';
let nightFrac = 0, nightExplicit = false; // 夜色 0 白天 … 1 深夜（setNight 存；未调过则 tick 从 ctx.state.night 取）
let timer = null;
const processed = new WeakSet();
const chunkDigest = new Map(); // chunkKey -> digest（确定性校验）
const clustersByChunk = new Map(); // chunkKey -> [{cx,cz,topY,w,d}]
const landmarkState = new Map(); // 新名 -> {built|registered|skipped, form, topY, heightVerified}
const S = { chunksProcessed: 0, clusters: 0, roofForms: 0, parapetEdges: 0, landmarksBuilt: 0, landmarksTotal: 0, landmarksSkipped: 0, towerRegistered: false, digest: '0', phase1Clusters: 0, phase2Clusters: 0, grammar: {}, pavilions: 0, pavilionsByPark: {} };

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

// ---- 白模代理盒管线（unreal ① 落到 roofs.js 的白模规则；准确落点见文件末尾对照表）----
// 分区 → 街区网格 → 拔高 → 生成，地面锚定修正：
//   分区：PHASE1 一环盒子 + phase1/phase2 计数；街区网格：clusterTopFaces 按共享顶点
//   并查集聚成一栋楼的顶；拔高：实测 topY + 层数×3.2 高度带；生成：applyRoofGrammar；
//   地面锚定修正：裙楼/基座一律 y0=0 落地，屋顶构件锚在实测 topY。
// 阶段 0 Blockout（代理盒）：clusterTopFaces 给的足迹（凸包）+ 顶高 + 高度带就是代理盒，
//   先定空间构图（这栋在哪、多大、多高），不画任何细部；阶段 1 结构：退台层级；
//   阶段 2 形态：语法表选形制（Mansard / 四坡 / 三角坡 / 倒角冠顶 / 圆角顶）；
//   阶段 3 材质/灯光：高度带冷蓝紫 + 霓虹框/角部信标（img2threejs 分阶段建造：
//   blockout → structure → form → material → lighting，一阶段一阶段过，不一口吃成）。
// proxy 只读几何实测值，不编数；form 由语法表 + 子种子定。
function applyRoofGrammar(g, hull, solid, neon, rngForm, neonC) {
  const topY = g.topY, cx = g.cx, cz = g.cz;
  const crownC = [0.20, 0.25, 0.45];
  const crownC2 = [0.23, 0.29, 0.48];
  const tileC = [0.16, 0.21, 0.40];
  let form;
  if (g.h >= 60) {
    form = weightedPick(rngForm, ROOF_GRAMMAR.high);
    const iw = g.w * 0.62, id = g.d * 0.62;
    const ch = 4 + rngForm() * 3;
    const tierHull = hull.map((p) => { const gx = cx, gz = cz; return [gx + (p[0] - gx) * 0.62, gz + (p[1] - gz) * 0.62]; });
    if (form === 'mansard-crown') {
      pushChamferCrown(solid, cx, topY, cz, iw, ch * 0.55, id, crownC);
      pushMansard(solid, cx, topY + ch * 0.55, cz, iw * 0.68, ch * 0.45, id * 0.68, crownC2);
    } else if (form === 'chamfer-crown') {
      pushChamferCrown(solid, cx, topY, cz, iw, ch * 0.6, id, crownC);
      pushChamferCrown(solid, cx, topY + ch * 0.6, cz, iw * 0.62, ch * 0.4, id * 0.62, crownC2);
    } else { // hip-crown：退台 + 按真实轮廓的四坡顶
      pushChamferCrown(solid, cx, topY, cz, iw, ch * 0.55, id, crownC);
      pushHipFromHull(solid, tierHull, topY + ch * 0.55, ch * 0.45, crownC2);
    }
    pushNeonFrame(neon, cx, topY + ch, cz, iw * 0.62, id * 0.62, neonC);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      pushCylinder(neon, cx + sx * iw * 0.44, topY + ch, cz + sz * id * 0.44, 0.45, 1.6, neonC, 8);
    }
  } else if (g.h >= 20) {
    form = weightedPick(rngForm, ROOF_GRAMMAR.mid);
    if (form === 'setback' && g.h < 40) form = 'hip'; // 退台只给中高层（R03/L03），不够高退回四坡顶
    if (form === 'hip') {
      if (!pushHipFromHull(solid, hull, topY, Math.max(2.5, Math.min(9, Math.min(g.w, g.d) * 0.22)), tileC)) {
        pushPyramid(solid, cx, topY, cz, g.w * 0.96, Math.max(2.5, Math.min(9, Math.min(g.w, g.d) * 0.22)), g.d * 0.96, tileC);
      }
    } else if (form === 'gable') {
      pushPrism(solid, cx, topY, cz, g.w * 0.96, Math.max(2, Math.min(7, Math.min(g.w, g.d) * 0.18)), g.d * 0.96, tileC, g.w >= g.d);
    } else if (form === 'mansard') {
      pushMansard(solid, cx, topY, cz, g.w * 0.96, Math.max(2.5, Math.min(7, Math.min(g.w, g.d) * 0.2)), g.d * 0.96, tileC);
    } else if (form === 'setback') {
      pushChamferCrown(solid, cx, topY, cz, g.w * 0.7, 3, g.d * 0.7, crownC);
      pushMansard(solid, cx, topY + 3, cz, g.w * 0.45, 2.2, g.d * 0.45, crownC2);
      pushNeonFrame(neon, cx, topY + 5.2, cz, g.w * 0.45, g.d * 0.45, neonC);
    } else { // round：圆角顶
      pushCylinder(solid, cx, topY, cz, Math.min(g.w, g.d) * 0.36, 2.5 + rngForm() * 1.5, [0.17, 0.22, 0.41]);
    }
  } else {
    form = weightedPick(rngForm, ROOF_GRAMMAR.low);
    if (form === 'hip') {
      if (!pushHipFromHull(solid, hull, topY, Math.max(2, Math.min(4, Math.min(g.w, g.d) * 0.2)), tileC)) {
        pushPyramid(solid, cx, topY, cz, g.w * 0.9, Math.max(2, Math.min(4, Math.min(g.w, g.d) * 0.2)), g.d * 0.9, tileC);
      }
    } else if (form === 'gable') {
      pushPrism(solid, cx, topY, cz, g.w * 0.9, Math.max(2, Math.min(4, Math.min(g.w, g.d) * 0.18)), g.d * 0.9, tileC, g.w >= g.d);
    } else { // flat-plant：平顶 + 斜顶机房（机房不再是方块盒子）
      pushMansard(solid, cx, topY, cz, g.w * 0.3, 2.2 + rngForm() * 1.2, g.d * 0.3, [0.18, 0.23, 0.42]);
      pushPyramid(solid, cx - g.w * 0.22, topY, cz + g.d * 0.2, 3.6, 1.4, 3.6, [0.15, 0.19, 0.36]);
    }
  }
  S.grammar[form] = (S.grammar[form] || 0) + 1;
  return form;
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
    // ③ 确定性分型：白模代理盒（足迹 + 顶高 + 高度带）→ 屋顶语法（见 applyRoofGrammar）。
    //    一环内/外同一套方法；语法表 + 子种子定形，方块盒子不再是任何一条规则的产物。
    applyRoofGrammar(g, hull, solid, neon, rngForm, neonC);
    forms++;
    // 裙楼：H>=30 且大底盘（高层/中高层商业体量），不再只限 H>=60；两级倒角板，不是单盒子
    if (g.h >= 30 && g.w >= 30 && g.d >= 25) {
      pushChamferCrown(solid, g.cx, 0, g.cz, g.w * 1.12, 3.3, g.d * 1.12, [0.16, 0.20, 0.35]);
      pushChamferCrown(solid, g.cx, 3.3, g.cz, g.w * 1.06, 2.2, g.d * 1.06, [0.16, 0.20, 0.35]);
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
function buildLandmarkRoof(spec, lm, topY, w, d, solid, neon, metal) {
  const accent = NEON[spec.neon];
  const accent2 = NEON[(spec.neon + 1) % NEON.length];
  const x = lm.x, z = lm.z;
  const tile = [0.16, 0.21, 0.40];       // 古建瓦顶：冷蓝紫调（配色表 R05 落法，不抄参考瓦色）
  const tileDark = [0.14, 0.18, 0.36];   // 灰瓦街区：更暗的冷蓝紫灰
  const eave = [0.12, 0.15, 0.28];       // 檐板
  const crown = [0.23, 0.29, 0.48];      // 现代冠顶
  const skirt = [0.16, 0.20, 0.35];      // 裙楼/底座
  const steel = [0.62, 0.68, 0.85];      // 金属冠顶盖板（threejs-materials-lighting：金属单独材质）
  const eaveLine = (cx, cz, ew, ed, y) => {
    for (const [dx, dz, len, ry] of [[0, -ed / 2, ew, 0], [0, ed / 2, ew, 0], [-ew / 2, 0, ed, Math.PI / 2], [ew / 2, 0, ed, Math.PI / 2]]) {
      pushBox(neon, cx + dx, y, cz + dz, len, 0.35, 0.5, accent, ry);
    }
  };
  const podium = (pw, pd, ph = 5) => { // 两级倒角板，不是单盒子
    pushChamferCrown(solid, x, 0, z, pw, ph * 0.6, pd, skirt);
    pushChamferCrown(solid, x, ph * 0.6, z, pw * 0.94, ph * 0.4, pd * 0.94, skirt);
  };
  const eaveSlab = (cx, cz, ew, ed, y) => pushChamferCrown(solid, cx, y, cz, ew, 1.0, ed, eave);
  switch (spec.form) {
    case 'pavilion': { // 望星公园：园内古建亭顶 + 一座小亭
      eaveSlab(x, z, w * 0.5 + 6, d * 0.5 + 6, topY);
      pushPyramid(solid, x, topY + 1, z, w * 0.5 + 3, Math.max(4, Math.min(14, Math.min(w, d) * 0.2)), d * 0.5 + 3, tile);
      pushFinial(metal, x, topY + 1 + Math.max(4, Math.min(14, Math.min(w, d) * 0.2)), z, 1.6, steel);
      eaveLine(x, z, w * 0.5 + 6, d * 0.5 + 6, topY + 0.4);
      eaveSlab(x + w * 0.32, z + d * 0.3, 10, 10, topY);
      pushPyramid(solid, x + w * 0.32, topY + 0.8, z + d * 0.3, 11, 3.5, 11, tile);
      break;
    }
    case 'ancient-hall': // 凌霄祠：大殿四坡顶 + 檐板 + 宝顶 + 两配殿小顶
    case 'taoist': { // 紫气宫：三清殿四坡顶 + 八角亭 + 山门（与古建殿共用大殿做法，亭为八角）
      const ph = Math.max(4, Math.min(18, Math.min(w, d) * 0.28));
      eaveSlab(x, z, w + 8, d + 8, topY);
      pushPyramid(solid, x, topY + 1, z, w + 5, ph, d + 5, tile);
      pushFinial(metal, x, topY + 1 + ph, z, 1.2, steel);
      eaveLine(x, z, w + 8, d + 8, topY + 0.4);
      pushChamferCrown(solid, x - w * 0.3, topY, z + d * 0.3, 8, 3.2, 8, tile);
      pushPyramid(solid, x - w * 0.3, topY + 3.2, z + d * 0.3, 9, 3, 9, tile);
      if (spec.form === 'taoist') {
        pushCylinder(solid, x + w * 0.32, topY, z - d * 0.28, 5, 2.2, eave, 8);
        pushOctPyramid(solid, x + w * 0.32, topY + 2.2, z - d * 0.28, 6.5, 4, tile);
        pushChamferCrown(solid, x, topY, z + d * 0.42, 10, 3, 3, tile); // 山门
      }
      break;
    }
    case 'cottage': { // 听涛草堂：低坡三角顶 + 亭小顶 + 廊
      pushPrism(solid, x, topY, z, w * 0.96, Math.max(2.5, Math.min(5, Math.min(w, d) * 0.14)), d * 0.96, tile, w >= d);
      eaveSlab(x + w * 0.3, z + d * 0.28, 9, 9, topY);
      pushPyramid(solid, x + w * 0.3, topY + 0.8, z + d * 0.28, 10, 3.2, 10, tile);
      pushChamferCrown(solid, x - w * 0.32, topY, z - d * 0.3, 14, 1.6, 4, tile); // 廊
      break;
    }
    case 'alley': // 青石双巷：古建街区屋顶，一排小三角坡顶 + 院门小顶
    case 'lowtile': { // 星光里：低层灰瓦街区屋顶，一排低层小三角坡顶
      const c = spec.form === 'lowtile' ? tileDark : tile;
      const n = 4;
      pushGableRow(solid, x, topY, z, w * 0.96, spec.form === 'lowtile' ? 2.5 : 3.2, d * 0.9, c, n, w >= d);
      pushChamferCrown(solid, x, topY, z - d * 0.42, 8, 2.6, 2.5, c); // 院门
      pushPyramid(solid, x, topY + 2.6, z - d * 0.42, 9, 2.2, 4, c);
      break;
    }
    case 'temple': { // 云林禅院：大殿四坡顶 + 山门 + 三叠小塔
      const ph = Math.max(4, Math.min(18, Math.min(w, d) * 0.28));
      eaveSlab(x, z, w + 8, d + 8, topY);
      pushPyramid(solid, x, topY + 1, z, w + 5, ph, d + 5, tile);
      pushFinial(metal, x, topY + 1 + ph, z, 1.2, steel);
      eaveLine(x, z, w + 8, d + 8, topY + 0.4);
      pushChamferCrown(solid, x, topY, z + d * 0.42, 10, 3, 3, tile); // 山门
      let ty = topY; // 三叠小塔（通用塔形，不抄任何实塔）：倒角檐板 + 四坡顶逐层收
      for (const s of [9, 7, 5]) { pushChamferCrown(solid, x + w * 0.32, ty, z - d * 0.3, s, 1.2, s, eave); pushPyramid(solid, x + w * 0.32, ty + 1.2, z - d * 0.3, s + 1, 2.4, s + 1, tile); ty += 3.6; }
      break;
    }
    case 'panda-modern': { // 云竹熊猫苑：通用现代冠顶 + 霓虹框 + LED 带（不做熊猫造型）
      const iw = w * 0.68, id = d * 0.68, ch = 8;
      pushChamferCrown(solid, x, topY, z, iw, ch * 0.6, id, crown);
      pushMansard(solid, x, topY + ch * 0.6, z, iw * 0.66, ch * 0.4, id * 0.66, [0.27, 0.35, 0.62]);
      pushChamferCrown(metal, x, topY + ch, z, iw * 0.6, 0.3, id * 0.6, steel); // 金属盖板
      pushNeonFrame(neon, x, topY + ch, z, iw, id, accent);
      pushBox(neon, x, topY + 1, z - id / 2 - 0.4, iw * 0.55, 5, 0.5, accent2);
      podium(w * 1.08, d * 1.08);
      break;
    }
    case 'tomb': { // 青石陵：封土冢形圆顶 + 祠堂坡顶
      pushCylinder(solid, x, topY, z, Math.min(w, d) * 0.36, 5, tileDark, 24);
      pushPyramid(solid, x, topY + 5, z, Math.min(w, d) * 0.3, 3.5, Math.min(w, d) * 0.3, tile);
      eaveSlab(x + w * 0.3, z + d * 0.28, 10, 10, topY);
      pushPyramid(solid, x + w * 0.3, topY + 0.8, z + d * 0.28, 11, 3, 11, tile);
      break;
    }
    case 'station': { // 星泽东站：现代大跨度屋顶，宽跨浅坡顶 + 雨棚 + 幕墙竖线
      const sw = Math.max(w, 80), sd = Math.max(d, 50);
      pushPrism(solid, x, topY, z, sw * 0.96, Math.max(4, Math.min(8, sd * 0.12)), sd * 0.96, crown, true);
      pushBox(neon, x, topY + Math.max(4, Math.min(8, sd * 0.12)), z, sw * 0.9, 0.3, 0.6, accent);
      pushChamferCrown(solid, x, topY - 2, z + sd * 0.55, sw * 0.9, 1.2, 12, skirt); // 雨棚（倒角板）
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
      pushCylinder(solid, x + w * 0.42, topY, z + d * 0.32, 2.2, 26, tileDark, 12); // 烟囱
      pushBox(neon, x, topY + 1, z - d * 0.45, w * 0.5, 2.2, 0.5, accent); // 霓虹招牌带（通用字由 skin/街面画，本文件只留色带）
      break;
    }
    case 'supertall': { // 星环中心：超高层冠顶，两级退台 + Mansard 盖顶 + 金属盖板 + 角部信标；大体量底盘
      const bw = Math.max(w, 110), bd = Math.max(d, 80);
      const iw = bw * 0.6, id = bd * 0.6, ch = 11;
      podium(bw * 1.08, bd * 1.08, 8);
      pushChamferCrown(solid, x, topY, z, iw, ch * 0.6, id, crown);
      pushMansard(solid, x, topY + ch * 0.6, z, iw * 0.66, ch * 0.4, id * 0.66, [0.27, 0.35, 0.62]);
      pushChamferCrown(metal, x, topY + ch, z, iw * 0.6, 0.3, id * 0.6, steel); // 金属盖板
      pushNeonFrame(neon, x, topY + ch, z, iw * 0.62, id * 0.62, accent);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        pushCylinder(neon, x + sx * iw * 0.44, topY + ch, z + sz * id * 0.44, 0.45, 2.2, accent, 8);
      }
      // 弧顶裙房（benchmark LM15：弧顶 + 裙楼）：底盘一角的低弧顶附楼
      pushArcRoof(solid, x - bw * 0.32, 6, z + bd * 0.3, Math.min(bw, bd) * 0.16, bw * 0.3, crown);
      break;
    }
    case 'museum': { // 星泽艺术公园：美术馆弧顶 + 幕墙竖线 + 亭廊小顶
      const r = Math.min(w, d) * 0.32;
      pushArcRoof(solid, x, topY, z, r, Math.max(w * 0.8, 40), crown);
      pushChamferCrown(solid, x, topY, z, w * 0.8, 1.0, d * 0.8, eave);
      for (const t of [-0.3, 0, 0.3]) {
        pushBox(solid, x + t * w * 0.8, 3, z - d * 0.4, 0.9, topY - 3, 0.9, CURTAIN);
        pushBox(neon, x + t * w * 0.8, 3, z - d * 0.4, 0.35, topY - 3, 0.35, NEON[1]);
      }
      eaveSlab(x + w * 0.32, z + d * 0.3, 9, 9, topY);
      pushPyramid(solid, x + w * 0.32, topY + 0.8, z + d * 0.3, 10, 3, 10, tile);
      break;
    }
    case 'double-eave': { // 望星楼：重檐坡顶，两叠四坡顶 + 两道檐板
      const ph1 = Math.max(3, Math.min(12, Math.min(w, d) * 0.2));
      const ph2 = Math.max(3, Math.min(10, Math.min(w, d) * 0.16));
      eaveSlab(x, z, w + 8, d + 8, topY);
      pushPyramid(solid, x, topY + 1, z, w + 5, ph1, d + 5, tile);
      eaveLine(x, z, w + 8, d + 8, topY + 0.4);
      eaveSlab(x, z, w * 0.62 + 6, d * 0.62 + 6, topY + 1 + ph1);
      pushPyramid(solid, x, topY + 2 + ph1, z, w * 0.62 + 3, ph2, d * 0.62 + 3, tile);
      pushFinial(metal, x, topY + 2 + ph1 + ph2, z, 1.2, steel);
      eaveLine(x, z, w * 0.62 + 6, d * 0.62 + 6, topY + 1 + ph1 + 0.4);
      break;
    }
    case 'twin': { // 双星塔：双塔冠顶，两座错开退台冠顶，粉/青各一座（218m 为核实数，见 state）
      const off = Math.max(18, w * 0.22);
      const iw = Math.max(20, w * 0.34), id = Math.max(20, d * 0.5), ch = 9;
      for (const [sx, ac] of [[-1, NEON[0]], [1, NEON[1]]]) {
        const tx = x + sx * off;
        pushChamferCrown(solid, tx, topY, z, iw, ch * 0.6, id, crown);
        pushMansard(solid, tx, topY + ch * 0.6, z, iw * 0.66, ch * 0.4, id * 0.66, [0.27, 0.35, 0.62]);
        pushChamferCrown(metal, tx, topY + ch, z, iw * 0.6, 0.3, id * 0.6, steel); // 金属盖板
        pushNeonFrame(neon, tx, topY + ch, z, iw * 0.62, id * 0.62, ac);
        pushCylinder(neon, tx, topY + ch, z, 0.4, 2.0, ac, 8); // 信标柱
      }
      podium(w * 1.15, d * 1.15, 5);
      break;
    }
    case 'arcade': { // 灯影里：古建街区屋顶，一排青瓦坡顶 + 牌坊
      pushGableRow(solid, x, topY, z, w * 0.96, 3.2, d * 0.9, tile, 4, w >= d);
      // 牌坊：两柱（八角柱） + 额枋（倒角板） + 小四坡顶（通用形制，不抄任何实景牌坊）
      pushCylinder(solid, x - 6, topY, z - d * 0.42, 0.7, 6, tileDark, 8);
      pushCylinder(solid, x + 6, topY, z - d * 0.42, 0.7, 6, tileDark, 8);
      pushChamferCrown(solid, x, topY + 6, z - d * 0.42, 14, 1.0, 1.6, eave);
      pushPyramid(solid, x, topY + 7, z - d * 0.42, 15, 2.5, 3.5, tile);
      break;
    }
    default: { // 兜底：现代退台冠顶 + 霓虹框（不应走到这里；走到即说明 LANDMARK_FORM 漏了新名）
      const iw = w * 0.68, id = d * 0.68, ch = 5;
      pushChamferCrown(solid, x, topY, z, iw, ch * 0.6, id, crown);
      pushMansard(solid, x, topY + ch * 0.6, z, iw * 0.66, ch * 0.4, id * 0.66, [0.27, 0.35, 0.62]);
      pushNeonFrame(neon, x, topY + ch, z, iw, id, accent);
      console.warn('[roofs] landmark form missing for', lm);
      break;
    }
  }
}

// 地标袋合并进地标组（重建三块合并几何，避免 16 座 × N 个 draw call；金属单独一块，
//   不进分块）。主屋顶与园内亭子共用这一条合并路径；四项全合（pos/nrm/col/uv）。
function mergeLandmarkBags(solid, neon, metal) {
  const oldS = landmarkGroup.getObjectByName('landmark-solid');
  const oldN = landmarkGroup.getObjectByName('landmark-neon');
  const oldM = landmarkGroup.getObjectByName('landmark-metal');
  const accS = oldS ? oldS.userData.bag : newBag();
  const accN = oldN ? oldN.userData.bag : newBag();
  const accM = oldM ? oldM.userData.bag : newBag();
  for (const k of ['pos', 'nrm', 'col', 'uv']) { accS[k].push(...solid[k]); accN[k].push(...neon[k]); accM[k].push(...metal[k]); }
  if (oldS) { landmarkGroup.remove(oldS); oldS.geometry.dispose(); }
  if (oldN) { landmarkGroup.remove(oldN); oldN.geometry.dispose(); }
  if (oldM) { landmarkGroup.remove(oldM); oldM.geometry.dispose(); }
  const mS = bagToMesh(THREE, accS, matSolid);
  const mN = bagToMesh(THREE, accN, matNeon);
  const mM = bagToMesh(THREE, accM, matMetal);
  if (mS) { mS.name = 'landmark-solid'; mS.userData.bag = accS; landmarkGroup.add(mS); }
  if (mN) { mN.name = 'landmark-neon'; mN.userData.bag = accN; landmarkGroup.add(mN); }
  if (mM) { mM.name = 'landmark-metal'; mM.userData.bag = accM; landmarkGroup.add(mM); }
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
    // 例外：园内亭子（16:32 令）——云锦湖是 4 个先行园之一，亭子是地面小品，
    //   不走单体屋顶，在这里单独建亭子、单独登记，仍计 skipped（主屋顶没做）。
    if (PAVILION_PARKS[newName]) {
      const solid = newBag(), neon = newBag(), metal = newBag();
      const n = buildGardenPavilions(newName, lm, 0, solid, neon, metal);
      mergeLandmarkBags(solid, neon, metal);
      landmarkState.set(newName, { built: false, skipped: true, form: 'pavilion-park', topY: 0, pavilions: n });
      S.pavilions += n; S.pavilionsByPark[newName] = n;
    } else {
      landmarkState.set(newName, { built: false, skipped: true, form: 'not-lane1', topY: 0 });
    }
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
  // 16:28 令：地标先立起来、航拍一眼能认——形制足迹按最近楼群放大 1.6 倍、最小 64m，
  //   不能淹没在楼海里；高度在 buildLandmarkRoof 里各形制另行加高（见各 case）。
  const w = near ? Math.max(64, near.w * 1.6) : 64;
  const d = near ? Math.max(64, near.d * 1.6) : 64;
  const solid = newBag(), neon = newBag(), metal = newBag();
  buildLandmarkRoof(spec, lm, topY, w, d, solid, neon, metal);
  // 园内亭子（16:32 令）：4 个先行园在主屋顶之外另建地面亭子，同一批袋子一起合并。
  const pavN = buildGardenPavilions(newName, lm, w, solid, neon, metal);
  if (pavN) { S.pavilions += pavN; S.pavilionsByPark[newName] = pavN; }
  // 地标基座：每座通用两级倒角基座，足迹 1.35×，从地面起——航拍里先认出一块
  //   distinct 的基座，再认屋顶形制。已有自带 podium 的 4 座会叠成三级台基。
  pushChamferCrown(solid, lm.x, 0, lm.z, w * 1.35, 3.6, d * 1.35, [0.16, 0.20, 0.35]);
  pushChamferCrown(solid, lm.x, 3.6, lm.z, w * 1.28, 2.4, d * 1.28, [0.16, 0.20, 0.35]);
  mergeLandmarkBags(solid, neon, metal);
  landmarkState.set(newName, { built: true, form: spec.form, topY, heightVerified: VERIFIED_HEIGHT[newName] || null, pavilions: pavN });
  S.landmarksBuilt++;
}

function tick() {
  if (!ctx || !ctx.sixLoader || !ctx.sixLoader.chunkGroup) return;
  // 夜色兜底：setNight 没调过时，从沙盘 state.night 取（applyTime 每帧都算，不用等接线）。
  if (!nightExplicit && ctx.state && typeof ctx.state.night === 'number') {
    nightFrac = Math.min(1, Math.max(0, ctx.state.night));
  }
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
  const nightOn = nightFrac >= 0.5; // 霓虹只在夜里亮（16:28 令）：白天满屏粉蓝杂点就是它
  roofGroup.visible = true; // 实体白天/夜里/白膜都显示；白膜只换陶土色，不藏
  neonGroup.visible = !white && !heat && nightOn;
  landmarkGroup.visible = true;
  const ln = landmarkGroup.getObjectByName('landmark-neon');
  if (ln) ln.visible = !white && !heat && nightOn;
  const lm = landmarkGroup.getObjectByName('landmark-metal');
  if (lm) lm.visible = !white; // 金属盖板跟实体走：白膜换陶土色，热力留
  applyClay(white);
}
// 白膜换陶土色：实体 mesh（solid/metal）换无顶点色的 #f2f0ea 材质，
// 与 six-loader matClay 同色同粗糙度（0xf2f0ea / 0.95），霓虹 mesh 不动（已隐藏）。
function applyClay(white) {
  if (!matClay) return;
  for (const grp of [roofGroup, landmarkGroup]) {
    if (!grp) continue;
    grp.traverse((o) => {
      if (!o.isMesh || !o.userData) return;
      const orig = o.userData.origMat;
      if (orig === matSolid || orig === matMetal) o.material = white ? matClay : orig;
    });
  }
}

function statsSnapshot() {
  return {
    ...S,
    night: +nightFrac.toFixed(2),
    chunkDigest: Object.fromEntries(chunkDigest),
    landmarks: [...landmarkState.entries()].map(([name, v]) => ({ name, built: v.built, form: v.form || null, topY: +(+v.topY || 0).toFixed(1), heightVerified: v.heightVerified || null, skipped: !!v.skipped, registered: !!v.registered, pavilions: v.pavilions || 0 })),
  };
}

export function setDisplay(m) {
  mode = m || 'normal';
  applyMode();
  window.__roofs = statsSnapshot();
}

// 夜色接口（16:28 令，接口名就叫 setNight）：总协调在 app.js applyTime 里调，
//   与 roads/sun 同一个 state.night（0 白天 … 1 深夜，22:00 为 1、10:00 为 0）。
//   未接线前 tick 每轮从 ctx.state.night 取，夜里截图不断霓虹。
export function setNight(n) {
  nightExplicit = true;
  nightFrac = Math.min(1, Math.max(0, +n || 0));
  applyMode();
  window.__roofs = statsSnapshot();
}

export function stats() { return statsSnapshot(); }

// 测试导出（procedural-gen Pattern 2：把自有 PRNG 钉在测试里，重构改了输出就露馅）
export const __roofTest = { splitmix, hash2, roofColorFor, outwardNormal, emitTri, pushBox, newBag, pushMansard, pushChamferCrown, pushHipFromHull, pushFinial, pushNeonFrame, weightedPick, ROOF_GRAMMAR, applyRoofGrammar, pushPyramid, pushOctPyramid, pushCylinder, pushPavilion, buildGardenPavilions, PAVILION_PARKS, getGroups: () => ({ roofGroup, neonGroup, landmarkGroup, matClay, matSolid, matNeon, matMetal }) };

// ---- 技能—文件对照表（林萧 16:23/16:25 死令：装上的技能用起来；用不上的说清为什么）----
// 用上的：
//   procedural-gen → 本文件：Pattern 1 子种子（rngColor/rngForm/rngNeon，种子只来自位置）；
//     Pattern 2 自有 SplitMix64 + 钉在 tests/roofs-seed-sweep.mjs；Pattern 3 加权表
//     （weightedPick + ROOF_GRAMMAR）；Pattern 4 种子扫掠（tests/roofs-seed-sweep.mjs，200 种）。
//   procedural-modeling → 本文件：楼生成链“足迹→挤出→屋顶类型开关→材质号”（clusterTopFaces 足迹
//     → applyRoofGrammar 类型开关 → 顶面高度带着色）；pushHipFromHull 按真实足迹出坡顶；
//     参数极值验证在扫掠脚本里（种子 0/42/9999 + 极小/极大足迹）。
//   img2threejs → 本文件：分阶段建造（Blockout 代理盒 → 结构退台 → 形态语法 → 材质/灯光，
//     见 applyRoofGrammar 前注释）；多角度门（白天鸟瞰 + 地标近景 + 夜里 22:00 三张截图验收，
//     tests/verify-roofs.js）；“改进不是完成”，截图未验不报完成。
//   video2threejs → 本文件：规则 8 单一连续面（Mansard/四坡顶/倒角冠顶是连续面，不再拿盒子拼
//     屋顶）；规则 11 闭合体 + 正确绕向（emitTri + outwardNormal，扫掠脚本数着验）；
//     规则 15 截图自评（改完三张截图 + 自评表，见报告）；规则 5 颜色取自像素——没用上，
//     参考像素至今未到（配色表已见 0 行），颜色仍按方案 §4，不编。
//   threejs-materials-lighting → 本文件：默认 MeshStandardMaterial（matSolid）；霓虹用
//     MeshBasicMaterial（matNeon，无光材质）；金属冠顶单独 MeshStandardMaterial（matMetal，
//     metalness 0.6 / roughness 0.35，只进地标）；r170（vendor three REVISION 170，技能验到 r187，
//     本文件只用 r170 已有的 API，不碰 r187 新特性）。
//   blender-director → 本文件：先简报后动手（文件头生产简报 + 技能路由）；参考图匹配流程
//     （Reference Analysis → 相机 → 几何分层 → 材质 → 比对循环）只落了“几何分层 + 比对循环”
//     两步——参考截图未到，Reference Analysis 与相机匹配做不了，已在报告里写明。
//   dsh-blender-modeling → 本文件：§0.5.1 冻结规格（ROOF_GRAMMAR + 两套构件库是冻结的合同，
//     不许各处自造常量）；§0.5.3 单件自证再合并（扫掠脚本先过再算交活）；§0.6.1 先量再建——
//     没做到量：无标定的参考图不能写尺寸，比例只用坡度规则；§0.8 门不过不交付（扫掠门 +
//     截图门，任一不过不报完成）。
//   blender-modeler / blender-cinematic-modeling / blender-game-models → 方法借用，不落代码：
//     blockout 先行、修饰器栈序（退台→倒角→冠顶）、清理清单（合并重顶点/法线朝外/无散面，
//     落在 emitTri + 扫掠脚本的几何门里）。不落 Blender 执行：本路交付物是浏览器里跑的程序化
//     JS，没有 Blender/MCP 环节；Blender 产 .glb 要进沙盘须动 six-loader.js/app.js（禁碰），
//     且 2026-11-24 已定“图片生成 3D 建模的路堵死”，离线建模不进本管线。
// 没用的（说清为什么）：
//   threejs-3d-generator（Tripo API）：要 TRIPO_API_KEY + 按次付费出 GLB；本路是白模先行、
//     程序化代码生成，不许外部资产进包，且无 key、无预算。2026-11-24“画 3D 建模的路堵死”也堵这条。
//   threejs-image-generator（Gemini 图像 API）：要 GEMINI_API_KEY + 出 2D 图；白模阶段不许贴图
//     （14:10 先白模后贴图），且无 key。贴图二期（FLUX）由 A 路排期，不在本段。
//   video2threejs（视频重建）：没有屋顶参考视频可重建；只借了规则 8/11/15 的方法。
//   img2threejs 的 projection-first / GLB 轨道：没有逐栋参考图/GLB，投不了；只借了分阶段 + 多角度门。
//   MPFB：仍禁用（林萧直接否过），未用。
// unreal-agent-harness 四条准确落点（老大重申版；无 LICENSE，只学思路，不抄代码、
//   不拿资产，不能商用；学完报每条落到哪个文件哪一段）：
//   ① 白模代理盒管线——分区→街区网格→拔高→生成，地面锚定修正 → 本文件 roofs.js：
//     分区（PHASE1 一环盒子 + phase1Clusters/phase2Clusters 计数）；街区网格
//     （clusterTopFaces：共享顶点并查集聚成一栋楼的顶 = 街区网格的楼栋单元）；拔高
//     （实测 topY + 层数×3.2 高度带）；生成（applyRoofGrammar 语法生成）；地面锚定修正
//     （裙楼/基座/雨棚一律 y0=0 落地，屋顶构件锚在实测 topY，不用估算顶高）；
//     六区白模批量规则（tick 每轮 2 块 + 12 万三角预算，啃完让出主线程）。
//   ② 楼的语法生成——按楼层/开间拼墙窗角柱，高度分层、退台、皇冠/Mansard 屋顶用独立构件
//     盖顶（不改主体） → 本文件 roofs.js：墙窗角柱（H≥60 幕墙竖线 CURTAIN + #00F0FF 竖线、
//     H≥30 转角亮边，按凸包角点拼）；高度分层（ROOF_COLORS 高度带 + H≥60/40/30/20 分层）；
//     退台（两级倒角退台）；皇冠/Mansard 独立构件盖顶（pushMansard/pushChamferCrown/
//     pushHipFromHull 只盖在 topY 之上，主体分块 GLB 不动）。诚实边界：本路不按楼层逐层拼墙
//     （主体不动是原则），墙窗角柱只落了幕墙竖线 + 转角亮边两档；逐层拼墙是 skin.js/二期的事。
//   ③ 发光窗参数 → 4 路 sun.js（不归本路）；④ 黄昏调校 → 4 路 sun.js/weather.js（不归本路）。

export async function init(c) {
  ctx = c; THREE = c.THREE;
  if (!THREE || !c.scene) throw new Error('[roofs] ctx 缺 THREE/scene');
  matSolid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.12 });
  matNeon = new THREE.MeshBasicMaterial({ vertexColors: true });
  // threejs-materials-lighting Pattern 1/2：默认标准材质（受光 + 环境）；霓虹用无光材质
  // （自发光，不吃光）；金属冠顶盖板单独一种标准材质（高金属、低粗糙），只进地标。
  matMetal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.6 });
  // 白膜陶土色：与 six-loader matClay 同色同粗糙度（0xf2f0ea / 0.95），无顶点色。
  matClay = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.95, metalness: 0 });
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
  // 接线接口（总协调：app.js applyTime 里已调 window.__roofsApi.setNight(state.night)，有守卫）：
  //   setNight(n) 夜色 0…1；setDisplay(m) 模式；stats() 快照。霓虹只在 normal + 夜里亮。
  window.__roofsApi = { setNight, setDisplay, stats };
  window.__roofs = statsSnapshot();
  console.log('[roofs] init ok');
  return { ok: true };
}
