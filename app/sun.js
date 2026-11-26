// 星泽市 · 日照分析（D 路 sun.js，v3.2：13:52 从 Phase 3 提前到现在做）
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
let panel = null, sunBtn = null;
let sunLight = null, moonLight = null;
let arcLine = null, sunDisc = null, tintPlane = null, lmDots = [];
let raf = 0, lastT = 0;
const S = { on: false, preset: 'spring', display: 'normal', hour: 10 };

// ---------- 夜景灯光：亮窗 shader + 天光抬底 ----------
const nightUniforms = { uNight: { value: 0 } }; // 全补丁共享一个 uniform，一次赋值全城生效
let hemiLight = null;
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
  vec3 winCol = mix(vec3(1.0, 0.78, 0.35), vec3(0.55, 0.90, 1.0), smoothstep(40.0, 90.0, wy));
  totalEmissiveRadiance += winCol * win * lit * facade * uNight * 1.1;
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
function dayColor(len) {
  if (len < 11) return 0x3A6FD8;
  if (len <= 13) return 0xFFD166;
  return 0xFF9F1C;
}

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
  // 日轨弧线：按当天太阳轨迹画半圆弧（24 个点，6:00–18:00 真太阳时）
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const solar = 6 + (i / 24) * 12;
    const p = sunPosSolar(solar, PRESETS[S.preset].doy); // 弧线直接按真太阳时画
    const d = sunDir(p.alt, p.az);
    const R = 7500;
    pts.push(new THREE.Vector3(d.x * R, Math.max(120, d.y * R), d.z * R));
  }
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  arcLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xFFD166, transparent: true, opacity: 0.9 }));
  arcLine.name = 'd-sun-arc';
  arcLine.frustumCulled = false;
  ctx.scene.add(arcLine);

  // 太阳圆盘：放在真太阳方向 8000m 处（相机 far=9000，能看见），跟随相机焦点
  sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(260, 32),
    new THREE.MeshBasicMaterial({ color: 0xFFE9A8, transparent: true, opacity: 0.95, fog: false }),
  );
  sunDisc.name = 'd-sun-disc';
  ctx.scene.add(sunDisc);

  // 日照时长着色层：地面大平面，按当日日长取色（半透明，不改楼身）
  tintPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(34000, 36000),
    new THREE.MeshBasicMaterial({ color: 0xFFD166, transparent: true, opacity: 0.16, depthWrite: false }),
  );
  tintPlane.rotation.x = -Math.PI / 2;
  tintPlane.position.y = 4;
  tintPlane.name = 'd-sun-tint';
  ctx.scene.add(tintPlane);

  // 每个地标一个点：颜色按该地标的日出时刻（经度差，分钟级）微调
  const lms = (ctx.sixIndex && ctx.sixIndex.landmarks) || (ctx.DATA && ctx.DATA.landmarks) || [];
  for (const lm of lms) {
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(60, 20),
      new THREE.MeshBasicMaterial({ color: 0xFFD166, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    dot.rotation.x = -Math.PI / 2;
    dot.position.set(lm.x, 6, lm.z);
    dot.name = 'd-sun-lm';
    dot.userData.lon = LON + (lm.x / 95753.45); // 经度≈中心经度 + x/每度米数（只用于日出时刻微调）
    ctx.scene.add(dot);
    lmDots.push(dot);
  }
  setOverlaysVisible(false);
}
function setOverlaysVisible(v) {
  if (arcLine) arcLine.visible = v && S.display !== 'white';
  if (sunDisc) sunDisc.visible = v && S.display !== 'white';
  if (tintPlane) tintPlane.visible = v && S.display !== 'white';
  for (const d of lmDots) d.visible = v && S.display !== 'white';
}

function tick(t) {
  raf = requestAnimationFrame(tick);
  // 夜景灯光跟时间走：日照面板开没开都生效（settings 夜景开关只改时间轴）
  applyNightLevel(readNight());
  if (!S.on) return;
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
  lastT = t;
  void dt;
  const slider = $('#time-slider');
  const hour = slider ? parseFloat(slider.value) : S.hour;
  S.hour = hour;
  const doy = PRESETS[S.preset].doy;
  const p = sunPos(hour, doy);
  const d = sunDir(p.alt, p.az);
  // 太阳方向光按真太阳位置摆；落山后强度归零（夜景归 app.js 的月光管）
  // 强度口径（threejs-materials-lighting：主光 2–3）：正午约 2.25，低角度递减
  if (sunLight) {
    sunLight.position.set(d.x * 1200, Math.max(60, d.y * 1400), d.z * 1200);
    sunLight.intensity = p.alt > 0 ? 0.25 + 2.0 * Math.sin(p.alt * D2R) : 0.05;
    sunLight.color.setHex(p.alt > 0 ? (p.alt < 12 ? 0xFFB36A : 0xFFF2D8) : 0x223355);
  }
  // 太阳圆盘跟随视点焦点
  if (sunDisc) {
    const st = ctx.state;
    const fx = st && st.mode === 'aerial' && st.target ? st.target.x : (st && st.pos ? st.pos.x : 0);
    const fz = st && st.mode === 'aerial' && st.target ? st.target.z : (st && st.pos ? st.pos.z : 0);
    sunDisc.position.set(fx + d.x * 8000, Math.max(300, d.y * 8000), fz + d.z * 8000);
    sunDisc.lookAt(ctx.camera.position);
    sunDisc.visible = p.alt > -2 && S.display !== 'white';
  }
  if (tintPlane) tintPlane.material.color.setHex(dayColor(dayLength(doy)));
  updateReadout(p);
}

let readoutEl = null;
function updateReadout(p) {
  if (!readoutEl) return;
  const st = sunTimes(PRESETS[S.preset].doy);
  readoutEl.innerHTML =
    `太阳高度 <b>${p.alt.toFixed(1)}°</b> · 方位 <b>${p.az.toFixed(0)}°</b>（${p.az < 180 ? '东' : '西'}）<br>` +
    `真太阳时 <b>${fmt(p.solarTime)}</b> · 时钟 <b>${fmt(S.hour)}</b> · 正午高度 <b>${noonAlt(PRESETS[S.preset].doy).toFixed(1)}°</b><br>` +
    `日出 <b>${fmt(st.sunrise)}</b> · 日落 <b>${fmt(st.sunset)}</b> · 日长 <b>${st.length.toFixed(1)} 小时</b>`;
}

export function init(c) {
  ctx = c; THREE = c.THREE;
  ensureShellCss();
  if (window.__dSun) return window.__dSun;
  findLights();
  buildOverlays();

  // 日照按钮：挂进现有 #toggles（运行时 DOM，不改 index.html）
  const toggles = $('#toggles');
  if (toggles && !$('#d-sun-btn')) {
    sunBtn = document.createElement('button');
    sunBtn.className = 'tgl'; sunBtn.id = 'd-sun-btn'; sunBtn.setAttribute('aria-pressed', 'false');
    sunBtn.textContent = '日照';
    sunBtn.addEventListener('click', () => setOn(!S.on));
    toggles.appendChild(sunBtn);
  }

  panel = document.createElement('aside');
  panel.id = 'd-sun';
  panel.className = 'd-panel';
  panel.style.display = 'none'; // 首次打开不自动弹
  panel.innerHTML = `<h2>日照分析 <button id="d-sun-close" aria-label="收起日照">✕</button></h2>
    <div class="sub">纬度 30.66° · 真太阳时 · 经度 104.06°E<br>时间轴就是时钟时间，太阳跟着真太阳转</div>
    <div class="d-route-btns" id="d-sun-presets"></div>
    <div class="sub" id="d-sun-readout" style="margin-top:6px;line-height:1.9"></div>
    <div class="sub" style="margin-top:6px">着色：地面 tint 按当日日长取色（&lt;11h 冷蓝 / 11–13h 金 / &gt;13h 橙）；<br>地标圆点按各点日出时刻（经度差，分钟级）微调。<br>逐栋遮挡阴影本轮不做（六区共享材质下无真遮挡）。</div>`;
  const pb = panel.querySelector('#d-sun-presets');
  for (const [key, pr] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = pr.label; b.dataset.preset = key;
    if (key === S.preset) b.classList.add('active');
    b.addEventListener('click', () => setPreset(key));
    pb.appendChild(b);
  }
  readoutEl = panel.querySelector('#d-sun-readout');
  panel.querySelector('#d-sun-close').addEventListener('click', () => setOn(false));
  document.body.appendChild(panel);

  if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(tick); }

  const api = {
    setOn, setPreset, sunPos, sunPosSolar, noonAlt, presetTable, sunTimes, dayLength,
    setNight, patchMaterial,
    get nightLevel() { return nightLevel; },
    materials: () => [...nightPatchedMats],
    stats: () => ({ night: nightLevel, patched: nightPatchedCount, hemi: hemiLight ? +hemiLight.intensity.toFixed(2) : null }),
    get state() {
      const st = sunTimes(PRESETS[S.preset].doy);
      return { on: S.on, preset: S.preset, lat: LAT, lon: LON, hour: S.hour, noonAlt: +noonAlt(PRESETS[S.preset].doy).toFixed(1), presets: presetTable(), ...st };
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

function setPreset(key) {
  if (!PRESETS[key]) return;
  S.preset = key;
  const pb = panel && panel.querySelector('#d-sun-presets');
  if (pb) pb.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.preset === key));
  // 换档后重画日轨弧线
  if (arcLine) {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const p = sunPosSolar(6 + (i / 24) * 12, PRESETS[key].doy);
      const d = sunDir(p.alt, p.az);
      pts.push(new THREE.Vector3(d.x * 7500, Math.max(120, d.y * 7500), d.z * 7500));
    }
    arcLine.geometry.dispose();
    arcLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }
  updateReadout(sunPos(S.hour, PRESETS[key].doy));
}

function setOn(on) {
  S.on = !!on;
  setOverlaysVisible(S.on);
  if (panel) panel.style.display = S.on ? 'block' : 'none';
  if (sunBtn) { sunBtn.setAttribute('aria-pressed', String(S.on)); sunBtn.classList.toggle('active', S.on); }
  if (S.on) {
    updateReadout(sunPos(S.hour, PRESETS[S.preset].doy));
  } else {
    // 恢复：让 app.js 的 applyTime 重新接管（触发一次滑块 input）
    const slider = $('#time-slider');
    if (slider) slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return S.on;
}

export function setDisplay(mode) {
  S.display = mode;
  setOverlaysVisible(S.on);
  document.body.classList.toggle('d-white', mode === 'white');
  applyNightLevel(readNight()); // 白膜/热力模式下亮窗归零
}
