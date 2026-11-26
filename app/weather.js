// 星泽市 · 天气（D 路 weather.js）
// 雨 / 雪 / 雾。只通过 window.__sandbox 的 ctx 拿 scene/camera/state/THREE，
// 不改 app.js / six-loader.js / index.html。粒子用 THREE.Points，
// 雨后反光 = 压暗天空 + 雾色 + 曝光 + 一层跟随玩家的湿路面反光面（只改光，不改几何）。
// 雪盖白：地面盖白片（跟随玩家）+ 屋顶盖白（共享材质补丁：法线朝上的面按 uSnow
// 向雪白混色，不用逐栋屋顶高度——six-index.json 里没有屋顶高度，不造假高度；
// 墙面（法线水平）不盖白，只有顶面白）。白膜模式下 uSnow 归零。
// 雾：只调 scene.fog 的 near/far，near 保底 300m，绝不挡近景。
// 白天霓虹降 40% 但不断：本模块记 neonLevel（白天 0.6 / 夜里 1.0），
// 供 A/F 路的霓虹对象调用 applyNeonLevel；本模块自己的粒子不受影响。
// ── 第三段（2026-11-26，林萧 16:21 + 16:23 技能令）──
//    黄昏调校落 weather.js：雾色/雨天/雪面跟 sun.js 的黄昏因子走——
//    太阳高度是单一来源（sun.js goldenSun/dusk），本模块只读
//    window.__dSun.dusk().factor，不自己算太阳、不复写日出日落时刻。
//    雾的 near/far 口径不动（verify-lane4 stage 3 按实测基准断言数值）；
//    黄昏只改颜色（雾色向 app.js 18.5 档雾金 0xd88a5e 偏、雨天向暖暗偏、
//    雪面向暖偏），因子归零时精确还原。湿路面 PBR 修正见 setRain：
//    按 threejs-materials-lighting 的 PBR 表，湿沥青是电介质，
//    metalness 0.85（金属）是错的，改 0.0、roughness 0.12；无环境贴图
//    时低粗糙度本身不产生真反射，湿面仍靠压暗 + 低粗糙 + 雾色，不造假镜面。

let FOG_BASE = { near: 1400, far: 5200 }; // 兜底（city 模式）；init() 里按场景实测雾重读——六区模式 app.js 是 4000/40000，写死就错
let ctx = null, THREE = null;
let rain = null, snow = null, wetPlane = null, snowGround = null;
let raf = 0, lastT = 0;
const S = { rain: false, snow: false, fog: 0, night: 0, display: 'normal' };
let savedFog = null, savedBg = null, savedExposure = 1.05;

function ensureShellCss() {
  if (document.getElementById('d-shell-css')) return;
  const l = document.createElement('link');
  l.id = 'd-shell-css'; l.rel = 'stylesheet'; l.href = './shell-overrides.css';
  document.head.appendChild(l);
}

// ---------- 第三段：黄昏（只读 sun.js 的黄昏因子，不自己算太阳） ----------
// threejs-scene/references/lighting.md：雾色 = 地平线色；一个时段的所有
// 光值要一起动。太阳高度是单一来源（sun.js goldenSun），本模块每帧只读
// window.__dSun.dusk().factor（0…1），雾/雨天/雪面一起向暖金偏；因子
// 归零时按抓到的基准色精确还原，不留染色。sun.js 未加载时因子为 0，
// 天气表现与改前完全一致（退化安全）。
const DUSK_FOG_GOLD = 0xd88a5e;   // 雾金：app.js 18.5 档雾色（单一来源是 app.js）
const DUSK_RAIN_SKY = 0x2e1f2e;   // 黄昏雨天：暖暗（雨天夜色 0x0b1026 向暖偏）
const DUSK_SNOW_WARM = 0xf2e3d5; // 黄昏雪面：暖白（雪地原色 0xeaf2ff 向暖偏）
export { DUSK_FOG_GOLD, DUSK_RAIN_SKY, DUSK_SNOW_WARM };
export function mixHex(a, b, t) {
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return (r << 16) | (g << 8) | bl;
}
export function readDuskFactor() {
  try {
    const d = window.__dSun && typeof window.__dSun.dusk === 'function' ? window.__dSun.dusk() : null;
    if (d && typeof d.factor === 'number' && isFinite(d.factor)) return Math.max(0, Math.min(1, d.factor));
  } catch (e) { /* sun.js 未就绪就当白天处理 */ }
  return 0;
}
// 黄昏 tint 基准：首次见黄昏时抓当时颜色 + 时钟；时钟动了 >0.1h 就重抓，
// 免得 applyTime 改过颜色后还拿旧基准还原。因子归零时按基准还原并清掉。
let duskBase = null;
function applyDuskTint() {
  if (!ctx || !ctx.scene) return;
  const f = readDuskFactor();
  const hour = ctx.state && typeof ctx.state.hour === 'number' ? ctx.state.hour : null;
  if (f <= 0) {
    if (duskBase) {
      if (ctx.scene.fog && duskBase.fog !== null) ctx.scene.fog.color.setHex(duskBase.fog);
      if (S.rain && ctx.scene.background && duskBase.bg !== null) ctx.scene.background.setHex(duskBase.bg);
      if (snowGround && duskBase.snow !== null) snowGround.material.color.setHex(duskBase.snow);
      duskBase = null;
    }
    return;
  }
  if (!duskBase || (hour !== null && Math.abs(hour - duskBase.hour) > 0.1)) {
    if (duskBase) {
      // 时钟动了：先按旧基准还原，清掉基准，下一帧再抓新鲜的未染色（不拿已染色的当基准累积）
      if (ctx.scene.fog && duskBase.fog !== null) ctx.scene.fog.color.setHex(duskBase.fog);
      if (S.rain && ctx.scene.background && duskBase.bg !== null) ctx.scene.background.setHex(duskBase.bg);
      if (snowGround && duskBase.snow !== null) snowGround.material.color.setHex(duskBase.snow);
      duskBase = null;
      return;
    }
    duskBase = {
      hour: hour === null ? 0 : hour,
      fog: ctx.scene.fog ? ctx.scene.fog.color.getHex() : null,
      bg: ctx.scene.background && ctx.scene.background.isColor ? ctx.scene.background.getHex() : null,
      snow: snowGround ? snowGround.material.color.getHex() : null,
    };
  }
  // 雾色向地平线金偏（雾开着时偏 0.8，没开雾只偏 0.4，不抢主色）
  if (ctx.scene.fog && duskBase.fog !== null) ctx.scene.fog.color.setHex(mixHex(duskBase.fog, DUSK_FOG_GOLD, f * (S.fog > 0 ? 0.8 : 0.4)));
  // 雨天向暖暗偏；雪面向暖偏
  if (S.rain && ctx.scene.background && duskBase.bg !== null) ctx.scene.background.setHex(mixHex(duskBase.bg, DUSK_RAIN_SKY, f * 0.8));
  if (S.snow && snowGround && duskBase.snow !== null) snowGround.material.color.setHex(mixHex(duskBase.snow, DUSK_SNOW_WARM, f * 0.7));
}

function makePoints(n, color, size, opacity) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  const vel = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 1600;
    pos[i * 3 + 1] = Math.random() * 500;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 1600;
    vel[i] = 0.6 + Math.random() * 0.4;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    color, size, transparent: true, opacity,
    sizeAttenuation: true, depthWrite: false,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.userData.vel = vel;
  p.visible = false;
  return p;
}

// ---------- 屋顶盖白：共享材质补丁（uSnow），与 sun.js 亮窗补丁同法 ----------
// 顶面（法线朝上）按 uSnow 向雪白混色；只改漫反射色，不改几何、不改高度。
// 链式保留已有的 onBeforeCompile（亮窗补丁、楼高着色都在链上，谁先打谁后打都能共存）。
const snowUniforms = { uSnow: { value: 0 } };
let snowPatchedMats = [];
function snowOnBeforeCompile(shader) {
  shader.uniforms.uSnow = snowUniforms.uSnow;
  shader.vertexShader = 'varying vec3 vSnowNormal;\n' + shader.vertexShader
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvSnowNormal = normalize(mat3(modelMatrix) * objectNormal);');
  if (shader.fragmentShader.includes('#include <color_fragment>')) {
    shader.fragmentShader = 'uniform float uSnow;\nvarying vec3 vSnowNormal;\n' + shader.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 1.0), uSnow * smoothstep(0.55, 0.85, vSnowNormal.y));');
  } else {
    console.warn('[d-weather] snow patch skipped: no color_fragment in this material');
  }
}
function ensureSnowCacheKey(mat) {
  // 已包好且没被后打的补丁盖掉就不再重复包（否则 ':snow' 后缀越叠越长）。
  if (mat.userData.__dSnowKeyFn === mat.customProgramCacheKey) return;
  const prevKey = mat.customProgramCacheKey;
  const base = typeof prevKey === 'function' ? prevKey : null;
  // 注意：Material 默认的 customProgramCacheKey 是原型方法，里面用 this.onBeforeCompile；
  // 直接存引用再裸调 base() 会丢 this（严格模式下 this 为 undefined），渲染取缓存键时就报
  // "Cannot read properties of undefined (reading 'onBeforeCompile')"；必须 base.call(mat)。
  // sun.js 先打过补丁时它已被换成箭头函数，call 也无害。
  const fn = () => (base ? base.call(mat) : 'std') + ':snow';
  mat.customProgramCacheKey = fn;
  mat.userData.__dSnowKeyFn = fn;
}
function patchSnowMaterial(mat) {
  if (!mat || mat.userData.__dSnowPatched) return false;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    snowOnBeforeCompile(shader);
  };
  mat.userData.__dSnowPatched = true;
  ensureSnowCacheKey(mat);
  mat.needsUpdate = true;
  snowPatchedMats.push(mat);
  return true;
}
function applySnowLevel() {
  if (ctx && ctx.sixLoader) {
    const loader = ctx.sixLoader;
    for (const m of [loader.matNormal, loader.matClay, loader.matFabric, loader.matHeat, loader.matFabricHeat]) patchSnowMaterial(m);
    for (const m of snowPatchedMats) ensureSnowCacheKey(m);
  }
  snowUniforms.uSnow.value = (S.snow && S.display !== 'white') ? 1 : 0;
  if (snowGround) snowGround.visible = S.snow && S.display !== 'white';
}

function focus() {  const st = ctx.state;
  if (!st) return { x: 0, z: 0 };
  if (st.mode === 'aerial' && st.target) return { x: st.target.x, z: st.target.z };
  if (st.pos) return { x: st.pos.x, z: st.pos.z };
  if (ctx.camera) return { x: ctx.camera.position.x, z: ctx.camera.position.z };
  return { x: 0, z: 0 };
}

function tick(t) {
  raf = requestAnimationFrame(tick);
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
  lastT = t;
  const f = focus();
  if (rain && rain.visible) {
    const a = rain.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) {
      let y = a.getY(i) - 420 * rain.userData.vel[i] * dt;
      if (y < 0) { y = 420 + Math.random() * 80; a.setX(i, f.x + (Math.random() - 0.5) * 1600); a.setZ(i, f.z + (Math.random() - 0.5) * 1600); }
      a.setY(i, y);
    }
    a.needsUpdate = true;
    rain.position.set(0, 0, 0);
  }
  if (snow && snow.visible) {
    const a = snow.geometry.attributes.position;
    const drift = t * 0.00004;
    for (let i = 0; i < a.count; i++) {
      let y = a.getY(i) - 55 * snow.userData.vel[i] * dt;
      if (y < 0) { y = 380 + Math.random() * 60; a.setX(i, f.x + (Math.random() - 0.5) * 1600); a.setZ(i, f.z + (Math.random() - 0.5) * 1600); }
      a.setY(i, y);
      a.setX(i, a.getX(i) + Math.sin(drift + i) * 0.15);
    }
    a.needsUpdate = true;
  }
  if (wetPlane && wetPlane.visible) { wetPlane.position.set(f.x, planeY(f), f.z); }
  if (snowGround && snowGround.visible) { snowGround.position.set(f.x, planeY(f), f.z); }
  // 黄昏 tint：雾/雨天/雪面跟太阳高度走（每帧只读因子、按基准混色，不累积染色）
  // dt 已按 threejs-scene-setup Pattern 3 钳制 0.05；循环归 app.js 管，本模块不另起 setAnimationLoop。
  applyDuskTint();
}

// 盖白/湿面片的高度：跟地形走，不写死 2.5m。街面实测：写死 2.5m 时片子埋在草地
// 形下面，雪开了地面还是绿的。取 sixLoader.groundHeightAt（塔用的同一个接口）+0.3m，
// 500ms/100m 节流，不逐帧射线。
let groundYCache = { x: 0, z: 0, y: 2.5, t: 0 };
function planeY(f) {
  const now = performance.now();
  if (now - groundYCache.t > 500 || Math.hypot(f.x - groundYCache.x, f.z - groundYCache.z) > 100) {
    let y = 2.5;
    try {
      const loader = ctx && ctx.sixLoader;
      if (loader && typeof loader.groundHeightAt === 'function') {
        const g = loader.groundHeightAt(f.x, f.z);
        if (isFinite(g)) y = g + 0.3;
      }
    } catch (e) { /* 取不到就用 2.5m 兜底 */ }
    groundYCache = { x: f.x, z: f.z, y, t: now };
  }
  return groundYCache.y;
}

function setRain(on) {
  S.rain = !!on;
  if (!rain) return S.rain;
  rain.visible = S.rain && S.display !== 'white';
  if (S.rain) {
    if (!savedBg) { savedBg = ctx.scene.background ? ctx.scene.background.clone() : null; savedExposure = ctx.renderer.toneMappingExposure; }
    // 雨天压暗：这里只压到夜色 0x0b1026，黄昏向暖的偏色归 tick 的 applyDuskTint
    // 统一管（只一处混色，不在 setRain 里再混一次，免得重复偏暖）
    if (ctx.scene.background) ctx.scene.background.setHex(0x0B1026); // 天空压暗
    if (ctx.scene.fog) { if (!savedFog) savedFog = { near: ctx.scene.fog.near, far: ctx.scene.fog.far, color: ctx.scene.fog.color.clone() }; ctx.scene.fog.color.setHex(0x1A2340); }
    ctx.renderer.toneMappingExposure = 0.85; // 路面变暗
    if (!wetPlane) {
      wetPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(3600, 3600),
        // PBR（threejs-materials-lighting 表）：湿沥青是电介质，metalness 必须 0
        // （原来 0.85 是金属，错）；roughness 0.12 低粗糙 + 压暗 + 雾色出湿面，
        // 无环境贴图时不造假镜面反射（白模先行，不贴图）。
        new THREE.MeshStandardMaterial({ color: 0x0E1530, roughness: 0.12, metalness: 0.0, transparent: true, opacity: 0.28 }),
      );
      wetPlane.rotation.x = -Math.PI / 2;
      wetPlane.name = 'd-wet-plane';
      ctx.scene.add(wetPlane);
    }
    wetPlane.visible = S.display !== 'white';
  } else {
    if (wetPlane) wetPlane.visible = false;
    if (!S.snow) restoreSky();
  }
  return S.rain;
}

function setSnow(on) {
  S.snow = !!on;
  if (!snow) return S.snow;
  snow.visible = S.snow && S.display !== 'white';
  if (S.snow) {
    if (!savedBg) { savedBg = ctx.scene.background ? ctx.scene.background.clone() : null; savedExposure = ctx.renderer.toneMappingExposure; }
    if (ctx.scene.background) ctx.scene.background.setHex(0x9DB8D6);
    if (!snowGround) {
      snowGround = new THREE.Mesh(
        new THREE.PlaneGeometry(3600, 3600),
        new THREE.MeshStandardMaterial({ color: 0xEAF2FF, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.8 }),
      );
      snowGround.rotation.x = -Math.PI / 2;
      snowGround.name = 'd-snow-ground';
      ctx.scene.add(snowGround);
    }
    applySnowLevel(); // 地面盖白片 + 屋顶盖白（uSnow 顶面混色）
  } else {
    applySnowLevel(); // uSnow 归零，屋顶恢复
    if (!S.rain) restoreSky();
  }
  return S.snow;
}

function restoreSky() {
  if (savedBg && ctx.scene.background) ctx.scene.background.copy(savedBg);
  if (savedFog && ctx.scene.fog) { ctx.scene.fog.near = savedFog.near; ctx.scene.fog.far = savedFog.far; ctx.scene.fog.color.copy(savedFog.color); }
  ctx.renderer.toneMappingExposure = savedExposure || 1.05;
  savedBg = null; savedFog = null;
}

// 雾浓度 0..1：远山淡出，near 保底 300m 不挡近景；0 = 回到场景实测的雾（六区 4000/40000）
// far 从实测值线性收到 1450m（1.0 时远山淡出），near 从实测值收到 25%（保底 300m）
function setFog(v) {
  S.fog = Math.max(0, Math.min(1, v));
  const fog = ctx.scene.fog;
  if (!fog) return S.fog;
  if (S.fog <= 0) { fog.near = FOG_BASE.near; fog.far = FOG_BASE.far; return 0; }
  fog.near = Math.max(300, FOG_BASE.near * (1 - S.fog * 0.75));
  fog.far = FOG_BASE.far - (FOG_BASE.far - 1450) * S.fog;
  return S.fog;
}

function neonLevel() {
  // 白天降 40% 但不断（0.6），夜里 1.0；按 state.hour / state.night 粗算
  const st = ctx.state || {};
  const night = typeof st.night === 'number' ? st.night : (st.hour >= 20 || st.hour < 6 ? 1 : 0);
  S.night = night;
  return 1 - 0.4 * (1 - night);
}

export function init(c) {
  ctx = c; THREE = c.THREE;
  ensureShellCss();
  // 雾的基准按场景实测值来（app.js：city 模式 1400/5200，六区模式 4000/40000）
  if (ctx.scene.fog) FOG_BASE = { near: ctx.scene.fog.near, far: ctx.scene.fog.far };
  rain = makePoints(1500, 0x7FB2E8, 2.2, 0.55);
  rain.name = 'd-rain';
  snow = makePoints(1200, 0xFFFFFF, 3.2, 0.9);
  snow.name = 'd-snow';
  ctx.scene.add(rain); ctx.scene.add(snow);
  if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(tick); }
  const api = {
    setRain, setSnow, setFog, neonLevel, readDuskFactor, mixHex,
    get state() { return { ...S, neon: neonLevel(), snowRoof: snowUniforms.uSnow.value, snowPatched: snowPatchedMats.length, dusk: readDuskFactor() }; },
    materials: () => [...snowPatchedMats],
    // 日照分析见 app/sun.js（D 路，13:52 已提前做），本模块不做，只留转发口
    sunAnalysis: () => ({ status: 'see-sun-module', note: '日照分析在 app/sun.js，window.__dSun' }),
    applyNeonLevel: (level) => level, // 供 A/F 路霓虹对象调用的钩子（本模块无自有霓虹对象）
  };
  window.__dWeather = api;
  return api;
}

export function setDisplay(mode) {
  S.display = mode;
  const hide = mode === 'white';
  if (rain) rain.visible = S.rain && !hide;
  if (snow) snow.visible = S.snow && !hide;
  if (wetPlane) wetPlane.visible = S.rain && !hide;
  applySnowLevel(); // 白膜下屋顶盖白归零、地面盖白片隐藏；切回来恢复
  document.body.classList.toggle('d-white', mode === 'white');
}
