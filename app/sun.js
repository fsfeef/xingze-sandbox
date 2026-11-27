// 星泽市 · 太阳与黄昏光（D 路 sun.js）：真太阳位置 + 金色时刻 + 夜景灯光。日照分析面板已拿掉（2026-11-26 老大令：游戏不要查看器功能）。
// 太阳模拟真的太阳去转动着照：纬度 30.66°（六区中心纬度），真太阳时。
// 算法：标准太阳位置公式（赤纬 + 均时差 + 时角），不抄参考站的代码，只用公开天文公式。
//   赤纬 δ = 23.45°·sin(360·(284+N)/365)，N 为年积日
//   均时差 EoT = 9.87·sin2B − 7.53·cosB − 1.5·sinB（分），B = 360/365·(N−81)
//   真太阳时 = 时钟时间 + EoT + 4·(经度 − 120)（分），经度取六区中心约 104.06°E，标准子午线 120°E（UTC+8）
//   时角 H = 15°·(真太阳时 − 12)；高度角 sinα = sinφ·sinδ + cosφ·cosδ·cosH
//   方位角 cosA = (sinδ − sinα·sinφ)/(cosα·cosφ)，上午东、下午西
//   日出/日落：cosH0 = −tanφ·tanδ，日长 = 2·H0/15 小时
// 预设四档：冬至 12-21（N=355）/ 大寒 01-20（N=20）/ 春分 03-20（N=79）/ 夏至 06-21（N=172）。
// 正午太阳高度（真太阳时 12:00，公式 90−|φ−δ|，φ=30.66°）：冬至 35.9° / 大寒 39.0° /
// 春分 58.5° / 夏至 82.8°。注意：时钟 12:00 不是真太阳时 12:00（经度差 + 均时差约 −1h），
// 时钟正午量的高度会低 2–9°；验高度角以真太阳时 12:00（noonAlt）为准。
// 驱动：时间轴（#time-slider 的小时）就是时钟时间；本模块每帧按真太阳位置摆
// 场景里的太阳方向光（在 scene 里找 DirectionalLight，非月光那盏）+ 自己画的日轨弧线
// + 日照时长着色层。app.js 的 applyTime 只在滑块输入/播放时跑一次，本模块的 rAF
// 在其后按真太阳位置接管太阳方向；关掉分析时恢复：重新触发一次滑块 input，让 applyTime 接回去。
// 日照时长着色：全城同纬度，日长基本一致（经度差只改几分钟日出时刻），所以着色层
// 按当日日长取色（<11h 冷蓝 / 11–13h 金 / >13h 橙）铺在地面上 + 面板列出日出/日落/
// 日长 + 每个地标的日出时刻（经度差造成，分钟级，诚实标）；不伪造逐栋阴影——
// 逐栋遮挡要阴影贴图/射线，六区共享材质下做不了真遮挡，见报告。
// 夜景也按他那个学：太阳落山后本模块把太阳光强度归零，月光那盏不动（app.js 管）。
// ── 夜景灯光（D 路，14:41 夜景重做令；纠正 14:42：黑块/网格线是加载问题，归 6 路，
//    本系统只管灯光，验收排在加载验收之后）──
//    亮窗：程序化 shader 亮窗（不是 canvas 纹理——分块 GLB 没有 UV，只有
//    POSITION/NORMAL/COLOR_0，emissiveMap 贴不上去；核对过 100_101_high.glb）。
//    做法：给 six-loader 的共享材质打 onBeforeCompile 补丁，用世界坐标算窗：
//    3.2m 一层、2.6m 一格窗洞，只画近竖直立面（屋顶/地面不画）；12m×2 层一个亮暗块，
//    同一块内同亮同暗，成片亮不是逐窗噪点；分层亮窗比——低层（<12m，商铺）65% 暖黄、
//    中层 40%、高层（>60m）20% 偏冷青。白天 0，夜里 1，中间按 state.night 渐变。
//    路灯：不重复建——F 路 street.js 已实现（从分块线几何按灯色 C_LAMP 读 141,756 盏实灯位，
//    2 个 Points：光晕 + 灯头亮点），它的 tick 跟 state.night，夜里自动全亮。
//    天光抬底线：夜里半球光强度不低于 0.5（只抬不降，白天不动），任何地方不许纯黑；
//    塔身霓虹环/塔尖是 Basic 材质，夜里本来就亮，不用另做。
// ── 挂接接口（给 6 路 six-loader.js；six-loader.js 不用改任何代码、不调本模块）──
//    本模块 init() 后自动从 window.__sandbox.sixLoader 取共享材质打补丁
//    （matNormal/matClay/matFabric/matHeat/matFabricHeat；分块流式加载不影响，
//    材质全城共享、只打一次；matHeat 原有 onBeforeCompile 会被链式保留）。
//    以后 six-loader 新增共享材质，或某个材质被重建，调
//    window.__dSunNight.patchMaterial(mat) 补打即可。
//    window.__dSunNight = { setNight(n), patchMaterial(mat), materials(), stats() }
// 可移植：只用相对路径 ./shell-overrides.css，不依赖本机绝对路径；
// localhost:8000 起服务就能跑（验证以后搬到八核三十二G那台也一样）。
// ── 第三段（2026-11-26，林萧 16:21“用起来、学起来”+ 16:23 技能令）──
//    per-simmons/unreal-agent-harness 的方法论只学思路，不抄代码、不拿资产
//    （该仓库无 LICENSE，不能直接当开源免费商用）：① PCG 分阶段生成 +
//    agent 自己截图 QA（act→capture→refdiff→fix）的循环 → 本段只做参数
//    化 + 可断言的纯函数 + 截图验，不改结构；② PBR + 发光窗 →
//    WINDOW_PARAMS（见下）：发光窗按色温分层、逐块亮度抖动；③ 夜景只
//    做到黄昏/金色时刻 → DUSK（见下）：金色时刻跟真太阳高度走，不跟
//    时钟走（app.js 的黄昏档是时钟固定 18.5，冬至日落 18:03、夏至日落
//    约 20:00，固定档在两头都错位）。夜景验收三条不变：分层亮窗比
//    0.65/0.40/0.20、12m×2 层成片亮、不逐窗噪点；白模先行，不贴图、不 FLUX。
//    技能（先读 SKILL.md 再写）：threejs-materials-lighting（主光 2–3、
//    半球光填充、ACES、emissive 走 PBR）；threejs-scene-setup（dt 钳制
//    0.05、像素比与循环归 app.js 管，本模块不另起 setAnimationLoop）；
//    threejs-gltf-loading / project-settings / lucian-uxui 见报告对照表
//    （本段未用，原因写在 ~/workspace/virtual-city/tests/lane4-s3-dusk-verify.mjs 头注 + 段报告里）。

const LAT = 30.66;          // 六区中心纬度（°）
const LON = 104.06;         // 六区中心经度（°），只用于真太阳时换算
const STD_MERIDIAN = 120;   // UTC+8 标准子午线
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

const PRESETS = {
  winter: { label: '冬至', month: 12, day: 21, doy: 355 },
  dahan: { label: '大寒', month: 1, day: 20, doy: 20 },
  spring: { label: '春分', month: 3, day: 20, doy: 79 },
  summer: { label: '夏至', month: 6, day: 21, doy: 172 },
};

let ctx = null, THREE = null;

let sunLight = null, moonLight = null;
let sunDisc = null;
let raf = 0, lastT = 0;
const S = { preset: 'winter', display: 'normal', hour: 16.6 }; // D18：默认冬至 16:36（16:36 高度角 15.5°、影长 3.6×楼高；春分 16:36 高度角 35.1°、影长 1.42×，和 10:00 的 1.45× 几乎一样，单改时间没用）

// ---------- 第三段参数：发光窗 PBR + 黄昏（单一来源，weather.js 只读这里） ----------
// WINDOW_PARAMS：亮窗的全部可调参数。分层亮窗比与成片块尺寸是已验收结构，
// 一律不动；只调色温分层、发光强度、逐块亮度抖动三处。
const WINDOW_PARAMS = {
  blockW: 12, blockFloors: 2, floorH: 3.2, winW: 2.6, // 成片块：12m × 2 层（验收结构，不动）
  ratios: { low: 0.65, mid: 0.40, high: 0.20 },       // 分层亮窗比（验收结构，不动）
  // 色温分层（UE 材质实例式：每层一个固定色温，不做连续渐变，免得中层发脏）：
  // 低层 <12m 商铺 2700K 暖黄 / 中层 12–60m 3500K 暖白 / 高层 >60m 6500K 冷白；
  // 带边只在 10–14m / 56–64m 窄带过渡，每层内部是平色。
  colors: { low: [1.0, 0.72, 0.32], mid: [1.0, 0.82, 0.52], high: [0.62, 0.82, 1.0] },
  emissive: 1.35,    // 发光强度：1.1 → 1.35（ACES 下夜里成片亮，不爆；逐窗不加亮）
  blockGain: 0.15,   // 逐块亮度抖动 ±15%（以 12m 亮暗块为单位，不以窗为单位，不噪点）
};
// DUSK：金色时刻。跟太阳高度角走，不跟时钟走；日落前后各一段，不是两档跳变。
const DUSK = {
  altHi: 12, altLo: -2,           // 金色时刻带：高度角 -2° … 12°
  goldFog: 0xd88a5e,               // 雾金：取 app.js 18.5 档的雾色（单一来源是 app.js，此处只复述数值）
  goldTint: 0xff9a4a,             // 地面 tint 金
  hemiSkyGold: 0xffd9a0, hemiGroundGold: 0x8a6a52, // 半球光黄昏色
  // 太阳色温/强度档（高度角 → 颜色/强度；25° 以上回归白天公式 0.25+2·sin(alt)）：
  // -2° 夜色 / 0° 2200K / 3° 3000K / 6° 峰值 / 12° 收尾 / 25° 白天
  stops: [
    { alt: -2, color: 0x223355, intensity: 0.05 },
    { alt: 0, color: 0xff7e3a, intensity: 0.55 },
    { alt: 3, color: 0xff9a4a, intensity: 1.15 },
    { alt: 6, color: 0xffb36a, intensity: 1.30 },
    { alt: 12, color: 0xffc98a, intensity: 1.05 },
    { alt: 25, color: 0xfff2d8, intensity: 0.25 + 2.0 * Math.sin(25 * D2R) },
  ],
};
function sstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
// 金色时刻因子：带内 1，带外 0，边缘 smoothstep 过渡（纯函数，可 node 断言）
export function duskFactor(alt) {
  return sstep(DUSK.altLo, DUSK.altLo + 4, alt) * (1 - sstep(DUSK.altHi - 4, DUSK.altHi, alt));
}
function lerpHex(a, b, t) {
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return (r << 16) | (g << 8) | bl;
}
// 太阳金色时刻：高度角 → {color, intensity, dusk}（纯函数，可 node 断言）
export function goldenSun(alt) {
  const dusk = duskFactor(alt);
  if (alt <= DUSK.stops[0].alt) return { color: DUSK.stops[0].color, intensity: DUSK.stops[0].intensity, dusk: 0 };
  if (alt >= 25) return { color: 0xfff2d8, intensity: 0.25 + 2.0 * Math.sin(alt * D2R), dusk: 0 };
  for (let i = 0; i < DUSK.stops.length - 1; i++) {
    const a = DUSK.stops[i], b = DUSK.stops[i + 1];
    if (alt >= a.alt && alt <= b.alt) {
      const t = (alt - a.alt) / (b.alt - a.alt);
      return { color: lerpHex(a.color, b.color, t), intensity: a.intensity + (b.intensity - a.intensity) * t, dusk };
    }
  }
  return { color: 0xfff2d8, intensity: 0.25 + 2.0 * Math.sin(alt * D2R), dusk };
}
// 纯函数/参数表出口（供 node 单元断言直接 import，不用起浏览器；浏览器里 api 也透出同一份）
export { WINDOW_PARAMS, DUSK, sunPos, sunTimes, noonAlt };

// ---------- 夜景灯光：亮窗 shader + 天光抬底 ----------
const nightUniforms = { uNight: { value: 0 } }; // 全补丁共享一个 uniform，一次赋值全城生效
let hemiLight = null;
let hemiBaseSkyHex = null, hemiBaseGroundHex = null; // 半球光原色 hex（黄昏 tint 的还原基准，首次见光时抓）
let nightLevel = 0;
let nightPatchDone = false;
let nightPatchedCount = 0;
const nightPatchedMats = [];
// 亮窗 GLSL：只画立面，按层分层成片亮（24m×4 层一个亮暗块）
const NIGHT_FRAG = `
{
  float upness = abs(vNightNormal.y);
  float facade = 1.0 - smoothstep(0.35, 0.65, upness);
  float wy = vNightWorld.y;
  vec2 gp = abs(vNightNormal.x) > abs(vNightNormal.z) ? vNightWorld.zy : vNightWorld.xy;
  float floorIdx = floor(wy / 3.2);
  vec2 f = fract(vec2(gp.x / 2.6, wy / 3.2));
  float win = step(0.25, f.x) * step(f.x, 0.75) * step(0.28, f.y) * step(f.y, 0.72);
  vec2 bcell = vec2(floor(gp.x / 12.0), floor(floorIdx / 2.0));
  float h1 = fract(sin(dot(bcell, vec2(127.1, 311.7))) * 43758.5453);
  float ratio = wy < 12.0 ? 0.65 : (wy > 60.0 ? 0.20 : 0.40);
  float lit = step(h1, ratio);
  // 色温分层（WINDOW_PARAMS.colors）：每层平色，窄带过渡，不连续渐变；
  // 逐块亮度抖动 ±15%（第二个 hash，仍以 12m 亮暗块为单位，不以窗为单位）。
  vec3 winCol = mix(vec3(1.0, 0.72, 0.32), vec3(1.0, 0.82, 0.52), smoothstep(10.0, 14.0, wy));
  winCol = mix(winCol, vec3(0.62, 0.82, 1.0), smoothstep(56.0, 64.0, wy));
  float h2 = fract(sin(dot(bcell + 7.3, vec2(269.5, 183.3))) * 43758.5453);
  float blockGain = 0.85 + 0.30 * h2;
  totalEmissiveRadiance += winCol * win * lit * facade * uNight * 1.35 * blockGain;
}`;
function nightOnBeforeCompile(shader) {
  shader.uniforms.uNight = nightUniforms.uNight;
  shader.vertexShader = 'varying vec3 vNightWorld;\nvarying vec3 vNightNormal;\n' + shader.vertexShader
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvNightNormal = normalize(mat3(modelMatrix) * objectNormal);')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvNightWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = 'uniform float uNight;\nvarying vec3 vNightWorld;\nvarying vec3 vNightNormal;\n' + shader.fragmentShader
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + NIGHT_FRAG);
}
// 给一个材质打亮窗补丁：已有 onBeforeCompile（matHeat 的楼高着色）链式保留，不覆盖
function patchMaterial(mat) {
  if (!mat || mat.userData.__dNightPatched) return false;
  const prev = mat.onBeforeCompile;
  const isHeat = !!prev;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    nightOnBeforeCompile(shader);
  };
  mat.userData.__dNightPatched = true;
  mat.userData.__dNightHeat = isHeat;
  mat.customProgramCacheKey = () => 'dNight:' + (mat.vertexColors ? 'vc:' : 'nvc:') + (isHeat ? 'heat' : 'std');
  mat.needsUpdate = true;
  nightPatchedCount++;
  nightPatchedMats.push(mat);
  return true;
}
function patchSharedMaterials() {
  if (nightPatchDone || !ctx) return;
  const loader = ctx.sixLoader;
  if (!loader) return; // 接线顺序不定：loader 还没建就等下一帧 tick 再试
  const mats = [loader.matNormal, loader.matClay, loader.matFabric, loader.matHeat, loader.matFabricHeat];
  for (const m of mats) patchMaterial(m);
  nightPatchDone = true;
}
function readNight() {
  const st = ctx && ctx.state;
  if (st && typeof st.night === 'number') return clamp(st.night, 0, 1);
  const h = st && typeof st.hour === 'number' ? st.hour : S.hour;
  return (h >= 20 || h < 6) ? 1 : 0;
}
// 夜里亮度：白膜/热力模式下亮窗归零；半球光抬底线只抬不降
function applyNightLevel(n) {
  patchSharedMaterials();
  const eff = S.display === 'normal' ? clamp(n, 0, 1) : 0;
  nightLevel = eff;
  nightUniforms.uNight.value = eff;
  if (!hemiLight && ctx) ctx.scene.traverse((o) => { if (!hemiLight && o.isHemisphereLight) hemiLight = o; });
  if (hemiLight && eff > 0) hemiLight.intensity = Math.max(hemiLight.intensity, 0.25 + 0.25 * eff);
}
function setNight(n) {
  const v = clamp(+n || 0, 0, 1);
  applyNightLevel(v);
  return nightLevel;
}

function ensureShellCss() {
  if (document.getElementById('d-shell-css')) return;
  const l = document.createElement('link');
  l.id = 'd-shell-css'; l.rel = 'stylesheet'; l.href = './shell-overrides.css';
  document.head.appendChild(l);
}
function $(s) { return document.querySelector(s); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function declination(doy) { return 23.45 * Math.sin((360 * (284 + doy) / 365) * D2R); }
function equationOfTime(doy) {
  const B = (360 / 365 * (doy - 81)) * D2R;
  return 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // 分
}
// 真太阳位置：输入时钟小时，返回 {alt, az, solarTime}
function sunPos(clockHour, doy) {
  const dec = declination(doy);
  const eot = equationOfTime(doy);
  const solarTime = clockHour + (eot + 4 * (LON - STD_MERIDIAN)) / 60;
  const p = sunPosSolar(solarTime, doy);
  p.solarTime = solarTime;
  p.dec = dec;
  return p;
}
// 直接按真太阳时算位置（日轨弧线用这个，不再把真太阳时当成时钟时间传给 sunPos）
function sunPosSolar(solarHour, doy) {
  const dec = declination(doy);
  const H = (solarHour - 12) * 15;
  const lat = LAT * D2R, decR = dec * D2R, hR = H * D2R;
  const sinAlt = Math.sin(lat) * Math.sin(decR) + Math.cos(lat) * Math.cos(decR) * Math.cos(hR);
  const alt = Math.asin(clamp(sinAlt, -1, 1)) * R2D;
  const cosAz = (Math.sin(decR) - Math.sin(alt * D2R) * Math.sin(lat)) / (Math.cos(alt * D2R) * Math.cos(lat) + 1e-9);
  let az = Math.acos(clamp(cosAz, -1, 1)) * R2D;
  if (H > 0) az = 360 - az; // 下午在西边
  return { alt, az, solarTime: solarHour, dec };
}
// 正午太阳高度（真太阳时 12:00）：90 − |纬度 − 赤纬|
function noonAlt(doy) {
  return 90 - Math.abs(LAT - declination(doy));
}
// 四档一览：每档的赤纬/正午高度/日出/日落/日长（供无头验收直接断言，不用再从时钟正午反推）
function presetTable() {
  const out = {};
  for (const [key, pr] of Object.entries(PRESETS)) {
    const st = sunTimes(pr.doy);
    out[key] = {
      label: pr.label, doy: pr.doy,
      dec: +declination(pr.doy).toFixed(2),
      noonAlt: +noonAlt(pr.doy).toFixed(1),
      sunrise: +st.sunrise.toFixed(2), sunset: +st.sunset.toFixed(2),
      length: +st.length.toFixed(2),
    };
  }
  return out;
}
function dayLength(doy) {
  const dec = declination(doy) * D2R, lat = LAT * D2R;
  const cosH0 = -Math.tan(lat) * Math.tan(dec);
  if (cosH0 <= -1) return 24;
  if (cosH0 >= 1) return 0;
  return (2 * Math.acos(cosH0) * R2D) / 15; // 小时
}
function sunTimes(doy) {
  const dec = declination(doy);
  const len = dayLength(doy);
  const eot = equationOfTime(doy);
  const corr = (eot + 4 * (LON - STD_MERIDIAN)) / 60; // 时钟时间 = 真太阳时 − corr
  const noonSolar = 12;
  const riseSolar = noonSolar - len / 2, setSolar = noonSolar + len / 2;
  return { sunrise: riseSolar - corr, sunset: setSolar - corr, length: len, dec };
}
function fmt(h) {
  if (!isFinite(h)) return '—';
  h = ((h % 24) + 24) % 24;
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
// 日长取色：<11h 冷蓝 / 11–13h 金 / >13h 橙
function findLights() {
  sunLight = null; moonLight = null;
  ctx.scene.traverse((o) => {
    if (!o.isDirectionalLight) return;
    // app.js：moonLight 颜色 0x8fa8ff；另一盏方向光就是太阳
    if (o.color && o.color.getHex() === 0x8fa8ff) moonLight = o;
    else if (!sunLight) sunLight = o;
  });
}

function sunDir(alt, az) {
  // 方位角：0=北，90=东；three 里 x 东、z 南（-z 为北与 app.js 的 shapeGeo 一致）
  const a = alt * D2R, z = az * D2R;
  return {
    x: Math.cos(a) * Math.sin(z),
    y: Math.sin(a),
    z: -Math.cos(a) * Math.cos(z),
  };
}

function buildOverlays() {
  // 只留太阳圆盘（游戏里看得见的太阳）：放在真太阳方向 8000m 处（相机 far=9000，能看见），跟随相机焦点。
  // 日轨弧线、地面 tint、地标圆点都是日照分析的工具，已拿掉（2026-11-26 老大令：游戏不要查看器功能）。
  sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(260, 32),
    new THREE.MeshBasicMaterial({ color: 0xFFE9A8, transparent: true, opacity: 0.95, fog: false }),
  );
  sunDisc.name = 'd-sun-disc';
  sunDisc.visible = false;
  ctx.scene.add(sunDisc);
}

function tick(t) {
  raf = requestAnimationFrame(tick);
  // 太阳跟时间轴走：不用开任何面板（日照分析面板已拿掉，太阳定位不再挂在面板开关上）
  applyNightLevel(readNight());
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
  lastT = t;
  void dt;
  const slider = $('#time-slider');
  const hour = slider ? parseFloat(slider.value) : S.hour;
  S.hour = hour;
  const doy = PRESETS[S.preset].doy;
  const p = sunPos(hour, doy);
  const d = sunDir(p.alt, p.az);
  const g = goldenSun(p.alt); // 金色时刻：太阳色/强度/黄昏因子一次算好，灯/盘/tint/半球光共用
  // 太阳方向光按真太阳位置摆；落山后强度归零（夜景归 app.js 的月光管）
  // 强度口径（threejs-materials-lighting：主光 2–3）：正午约 2.25，低角度按
  // goldenSun 档走——6° 峰值 1.30（app.js 黄昏档 1.1–1.2 的同量级），25° 以上
  // 回归 0.25+2·sin(alt)；颜色按色温档走，不再是 alt<12 二档跳变。
  if (sunLight) {
    sunLight.position.set(d.x * 1200, Math.max(60, d.y * 1400), d.z * 1200);
    sunLight.intensity = g.intensity;
    sunLight.color.setHex(g.color);
  }
  // 半球光黄昏 tint（只改颜色，不改强度——强度归 app.js applyTime 管）：
  // 黄昏因子 >0 时向暖金偏，=0 时精确还原原色。
  if (hemiLight) {
    if (hemiBaseSkyHex === null) { hemiBaseSkyHex = hemiLight.color.getHex(); hemiBaseGroundHex = hemiLight.groundColor.getHex(); }
    if (g.dusk > 0) {
      hemiLight.color.setHex(lerpHex(hemiBaseSkyHex, DUSK.hemiSkyGold, g.dusk * 0.6));
      hemiLight.groundColor.setHex(lerpHex(hemiBaseGroundHex, DUSK.hemiGroundGold, g.dusk * 0.6));
    } else {
      hemiLight.color.setHex(hemiBaseSkyHex);
      hemiLight.groundColor.setHex(hemiBaseGroundHex);
    }
  }
  // 太阳圆盘跟随视点焦点
  if (sunDisc) {
    const st = ctx.state;
    const fx = st && st.mode === 'aerial' && st.target ? st.target.x : (st && st.pos ? st.pos.x : 0);
    const fz = st && st.mode === 'aerial' && st.target ? st.target.z : (st && st.pos ? st.pos.z : 0);
    sunDisc.position.set(fx + d.x * 8000, Math.max(300, d.y * 8000), fz + d.z * 8000);
    sunDisc.lookAt(ctx.camera.position);
    sunDisc.material.color.setHex(g.color);
    sunDisc.material.opacity = p.alt > -2 ? (g.dusk > 0 ? 1.0 : 0.95) : 0;
    sunDisc.visible = p.alt > -2 && S.display !== 'white';
  }
}

export function init(c) {
  ctx = c; THREE = c.THREE;
  ensureShellCss();
  if (window.__dSun) return window.__dSun;
  findLights();
  buildOverlays();

  if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(tick); }

  const api = {
    sunPos, sunPosSolar, noonAlt, presetTable, sunTimes, dayLength,
    setNight, patchMaterial, goldenSun, duskFactor,
    windowParams: () => JSON.parse(JSON.stringify(WINDOW_PARAMS)),
    duskParams: () => ({ altHi: DUSK.altHi, altLo: DUSK.altLo, goldFog: DUSK.goldFog, goldTint: DUSK.goldTint }),
    // 黄昏快照（weather.js 只读这个，不自己算太阳；单一来源）
    dusk: () => {
      const p = sunPos(S.hour, PRESETS[S.preset].doy);
      const gg = goldenSun(p.alt);
      const st = sunTimes(PRESETS[S.preset].doy);
      return { alt: +p.alt.toFixed(1), factor: +gg.dusk.toFixed(2), color: gg.color, intensity: +gg.intensity.toFixed(2), sunset: +st.sunset.toFixed(2), sunrise: +st.sunrise.toFixed(2) };
    },
    get nightLevel() { return nightLevel; },
    materials: () => [...nightPatchedMats],
    stats: () => ({ night: nightLevel, patched: nightPatchedCount, hemi: hemiLight ? +hemiLight.intensity.toFixed(2) : null, windowEmissive: WINDOW_PARAMS.emissive, dusk: api.dusk() }),
    get state() {
      const st = sunTimes(PRESETS[S.preset].doy);
      return { preset: S.preset, lat: LAT, lon: LON, hour: S.hour, noonAlt: +noonAlt(PRESETS[S.preset].doy).toFixed(1), presets: presetTable(), ...st };
    },
  };
  window.__dSun = api;
  // 夜景挂接接口（给 6 路 six-loader.js）：见文件头注释
  window.__dSunNight = {
    setNight, patchMaterial,
    materials: () => [...nightPatchedMats],
    stats: () => ({ night: nightLevel, patched: nightPatchedCount, hemi: hemiLight ? +hemiLight.intensity.toFixed(2) : null }),
  };
  return api;
}

export function setDisplay(mode) {
  S.display = mode;
  document.body.classList.toggle('d-white', mode === 'white');
  applyNightLevel(readNight()); // 白膜/热力模式下亮窗归零
}
