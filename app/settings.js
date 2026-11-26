// 星泽市 · 设置（4 路 settings.js）
// 五个开关：白天 / 夜景 / 下雨 / 下雪 / 白膜（雾不在面板里，仍走 weather.js 的 setFog 接口）。
// 互斥关系（写死，不靠口头约定）：
//   白天 ↔ 夜景：二选一，切一个自动灭另一个（时间轴 10:00 / 22:00 跟着切，亮窗跟着灭/亮）；
//   下雨 / 下雪：可与夜景叠加（雨夜、雪夜都行），雨雪之间也可同开（先开的定天色）；
//   白膜：与夜景可并存，但白膜开时亮窗/雨雪粒子/雪顶一律归零只看体块，关白膜恢复原档；
//   面板与帮助栏互斥：设置面板打开时帮助栏收起，点“?”开帮助时设置面板先收起，两者永不同时盖画面。
// 只通过 window.__sandbox 的 ctx + 现有 DOM（#time-slider / #tgl-white / #tgl-bloom）驱动 app.js
// 已有的逻辑，不改 app.js / six-loader.js / index.html，不新写时间轴。
// 夜景重做（验收 24，D 路的部分）：夜景 = 时间 22:00 + 泛光开（发光窗/灯光带辉光），
// 白天 = 时间 10:00 + 泛光关；白天霓虹亮度降 40% 但不断（neonLevel 白 0.6 / 夜 1.0，
// 供 A/F 路的霓虹对象调用）。亮窗由 sun.js 的夜景灯光系统提供（shader 亮窗 + 天光抬底），
// 本模块只驱动开关（applyNight/applyDay 调 sun.setNight），不重复实现。
// 日照分析是 Phase 3：本轮不做，只留 sunAnalysis() 接口。
// 首次打开不自动弹任何层：面板默认隐藏，只留“设置”和“?”两个可点的按钮。
// 开关样式借鉴 Lucian UX/UI #433（拉伸滑块 + 弹簧回弹，样式在 shell-overrides.css）。

let ctx = null;
let weatherApi = null, weatherLoading = null;
let sunApi = null, sunLoading = null;
const S = { day: true, night: false, rain: false, snow: false, fog: 0, white: false, display: 'normal' };
let panel = null;

function ensureShellCss() {
  if (document.getElementById('d-shell-css')) return;
  const l = document.createElement('link');
  l.id = 'd-shell-css'; l.rel = 'stylesheet'; l.href = './shell-overrides.css';
  document.head.appendChild(l);
}

function $(s) { return document.querySelector(s); }
function toast(msg) {
  const el = $('#toast');
  if (el) { el.textContent = msg; el.style.opacity = 1; clearTimeout(toast._t); toast._t = setTimeout(() => { el.style.opacity = 0; }, 2200); }
}

function setTime(hour) {
  const s = $('#time-slider');
  if (!s) return false;
  s.value = String(hour);
  s.dispatchEvent(new Event('input', { bubbles: true }));
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function setBloom(on) {
  const b = $('#tgl-bloom');
  if (!b) return;
  const isOn = b.getAttribute('aria-pressed') === 'true';
  if (on !== isOn) b.click();
}

async function getWeather() {
  if (weatherApi) return weatherApi;
  if (window.__dWeather) { weatherApi = window.__dWeather; return weatherApi; }
  if (!weatherLoading) {
    weatherLoading = import('./weather.js').then((m) => {
      weatherApi = m.init(ctx);
      return weatherApi;
    }).catch((e) => { console.error('[d-settings] weather load failed', e); weatherLoading = null; return null; });
  }
  return weatherLoading;
}

// 夜景灯光（sun.js）：懒加载，开关拨动时立刻把亮窗/天光底线拨到对应档；
// sun.js 的 tick 本来就跟 state.night，这通调用只是让它不等下一帧
async function getSun() {
  if (sunApi) return sunApi;
  if (window.__dSun) { sunApi = window.__dSun; return sunApi; }
  if (!sunLoading) {
    sunLoading = import('./sun.js').then((m) => {
      sunApi = m.init(ctx);
      return sunApi;
    }).catch((e) => { console.error('[d-settings] sun load failed', e); sunLoading = null; return null; });
  }
  return sunLoading;
}

function rowEl(id) { return panel ? panel.querySelector(`[data-key="${id}"]`) : null; }
function paintRow(id, on) {
  const r = rowEl(id);
  if (!r) return;
  r.classList.toggle('on', !!on);
  const input = r.querySelector('input[type=checkbox]');
  if (input) input.checked = !!on; // 开关状态以这里为准：白天/夜景互斥时另一档的勾必须同步灭掉
}

// 设置面板 ↔ 帮助栏互斥：面板打开期间帮助栏收起（display:none + 去 d-show），
// 面板收起时按原样恢复；点“?”开帮助时先收面板。两者永不同时盖画面。
let helpHiddenBySettings = false, helpWasShown = false;
function hideHelpForPanel() {
  const help = $('#help');
  if (!help) return;
  helpWasShown = help.classList.contains('d-show') || getComputedStyle(help).display !== 'none';
  helpHiddenBySettings = true;
  help.classList.remove('d-show');
  help.style.display = 'none';
}
function restoreHelp() {
  if (!helpHiddenBySettings) return;
  helpHiddenBySettings = false;
  const help = $('#help');
  if (!help) return;
  help.style.display = '';
  if (helpWasShown && window.innerWidth <= 760) help.classList.add('d-show');
}
function openSettings() {
  hideHelpForPanel();
  panel.style.display = 'block';
  const b = $('#d-settings-btn');
  if (b) { b.setAttribute('aria-pressed', 'true'); b.classList.add('active'); }
}
function closeSettings() {
  panel.style.display = 'none';
  const b = $('#d-settings-btn');
  if (b) { b.setAttribute('aria-pressed', 'false'); b.classList.remove('active'); }
  restoreHelp();
}

function applyDay() {
  S.day = true; S.night = false;
  setTime(10); setBloom(false); // 白天：冷蓝天 + 泛光关；霓虹亮度降 40% 但不断（neonLevel 0.6）
  getSun().then((s) => { if (s && s.setNight) s.setNight(0); }); // 亮窗归零
  paintRow('day', true); paintRow('night', false);
  toast('白天 · 霓虹亮度降 40% 但不断');
}
function applyNight() {
  S.night = true; S.day = false;
  setTime(22); setBloom(true); // 夜景重做（D 路部分）：22:00 + 泛光开，发光窗/灯光带辉光
  getSun().then((s) => { if (s && s.setNight) s.setNight(1); }); // 亮窗全开 + 天光抬底
  paintRow('night', true); paintRow('day', false);
  toast('夜景 · 泛光已开');
}
function applyWhite(on) {
  S.white = !!on;
  const b = $('#tgl-white');
  if (b) {
    const isOn = b.getAttribute('aria-pressed') === 'true';
    if (on !== isOn) b.click(); // 走 app.js 原有白膜逻辑（sixLoader.setDisplay），双向同步靠 observer
  }
  paintRow('white', S.white);
  document.body.classList.toggle('d-white', S.white);
}
async function applyRain(on) {
  const w = await getWeather();
  if (!w) { paintRow('rain', false); toast('天气模块未加载，雨开不了'); return; }
  S.rain = w.setRain(on);
  paintRow('rain', S.rain);
  if (S.rain) toast('下雨 · 路面变暗反光');
}
async function applySnow(on) {
  const w = await getWeather();
  if (!w) { paintRow('snow', false); toast('天气模块未加载，雪开不了'); return; }
  S.snow = w.setSnow(on);
  paintRow('snow', S.snow);
  if (S.snow) toast('下雪 · 地面盖白');
}
async function applyFog(v) {
  const w = await getWeather();
  if (!w) { toast('天气模块未加载，雾开不了'); return; }
  S.fog = w.setFog(v);
  const r = rowEl('fog');
  if (r) { r.classList.toggle('on', S.fog > 0); const s = r.querySelector('input[type=range]'); if (s) s.value = String(Math.round(S.fog * 100)); }
}

function makeRow(key, label, tag) {
  const lab = document.createElement('label');
  lab.className = 'd-sw-row'; lab.dataset.key = key;
  lab.innerHTML = `<input type="checkbox" role="switch" aria-label="${label}"><span class="d-sw" aria-hidden="true"></span><span>${label}</span>${tag ? `<span class="tag">${tag}</span>` : ''}`;
  lab.addEventListener('pointerdown', () => lab.classList.add('is-press'));
  for (const t of ['pointerup', 'pointerleave', 'pointercancel']) lab.addEventListener(t, () => lab.classList.remove('is-press'));
  lab.querySelector('input').addEventListener('change', (e) => {
    const on = e.target.checked;
    if (key === 'day' && on) applyDay();
    else if (key === 'night' && on) applyNight();
    else if (key === 'day' || key === 'night') { /* 关掉白天/夜景不反跳时间轴，只灭灯 */ if (key === 'day') S.day = false; else S.night = false; paintRow(key, false); }
    else if (key === 'rain') applyRain(on);
    else if (key === 'snow') applySnow(on);
    else if (key === 'white') applyWhite(on);
  });
  return lab;
}

export function init(c) {
  ctx = c;
  ensureShellCss();
  if (panel) return window.__dSettings;

  // 设置按钮 + 帮助按钮：只挂进现有 #toggles，不改 index.html
  const toggles = $('#toggles');
  if (toggles && !$('#d-settings-btn')) {
    const b = document.createElement('button');
    b.className = 'tgl'; b.id = 'd-settings-btn'; b.setAttribute('aria-pressed', 'false');
    b.textContent = '设置';
    b.addEventListener('click', () => {
      if (panel.style.display === 'block') closeSettings();
      else openSettings();
    });
    toggles.appendChild(b);
    const h = document.createElement('button');
    h.id = 'd-help-btn'; h.textContent = '?'; h.setAttribute('aria-label', '帮助');
    h.addEventListener('click', () => {
      if (panel.style.display === 'block') closeSettings(); // 开帮助先收设置面板，两者不同时占画面
      const help = $('#help');
      if (!help) return;
      const showing = help.classList.toggle('d-show');
      if (window.innerWidth > 760) help.style.display = showing || help.style.display === 'none' ? '' : 'none';
      if (window.innerWidth <= 760 && !showing) help.classList.remove('d-show');
    });
    toggles.appendChild(h);
  }

  panel = document.createElement('aside');
  panel.id = 'd-settings';
  panel.className = 'd-panel';
  panel.style.display = 'none'; // 首次打开不自动弹
  panel.innerHTML = `<h2>设置 <button id="d-settings-close" aria-label="收起设置">✕</button></h2>
    <div class="sub">游戏设置 · 白天夜景雨雪白膜</div>`;
  panel.appendChild(makeRow('day', '白天', '10:00'));
  panel.appendChild(makeRow('night', '夜景', '22:00 + 泛光'));
  panel.appendChild(makeRow('rain', '下雨', '粒子雨'));
  panel.appendChild(makeRow('snow', '下雪', '地面盖白'));
  panel.appendChild(makeRow('white', '白膜', '快捷同步'));
  const foot = document.createElement('div');
  foot.className = 'sub';
  foot.style.marginTop = '8px';
  foot.innerHTML = `互斥：白天↔夜景二选一；雨/雪可叠夜景，也可互叠；白膜开时亮窗·雨雪·雪顶归零，关白膜恢复。<br>设置面板打开时帮助栏收起，点“?”开帮助时面板先收起。<br>白天霓虹亮度降 40% 但不断，全程亮闪闪。`;
  panel.appendChild(foot);
  panel.querySelector('#d-settings-close').addEventListener('click', () => closeSettings());
  document.body.appendChild(panel);

  // 双向同步：顶栏白膜开关 / 时间轴变了，设置面板跟着变
  const whiteBtn = $('#tgl-white');
  if (whiteBtn && window.MutationObserver) {
    new MutationObserver(() => {
      S.white = whiteBtn.getAttribute('aria-pressed') === 'true';
      paintRow('white', S.white);
      document.body.classList.toggle('d-white', S.white);
    }).observe(whiteBtn, { attributes: true, attributeFilter: ['aria-pressed'] });
  }
  const slider = $('#time-slider');
  if (slider) {
    slider.addEventListener('input', () => {
      const h = parseFloat(slider.value);
      const isNight = h >= 20 || h < 6;
      S.night = isNight; S.day = !isNight;
      paintRow('night', isNight); paintRow('day', !isNight);
    });
  }
  paintRow('day', true);

  const api = {
    get state() { return { ...S, neon: neonLevel(), rules: { dayNight: 'exclusive', rainSnowWithNight: 'stackable', rainSnowTogether: 'stackable', white: 'hides-night-rain-snow-until-off', helpVsPanel: 'exclusive' } }; },
    setTime, applyDay, applyNight, applyWhite, applyRain, applySnow, applyFog,
    neonLevel,
    // 日照分析：13:52 已提前到现在做，见 app/sun.js；这里只做转发，不重复实现
    sunAnalysis: async () => {
      if (window.__dSun) return window.__dSun.state;
      try {
        const m = await import('./sun.js');
        return m.init(ctx).state;
      } catch (e) { return { status: 'sun-module-load-failed', error: String(e && e.message || e) }; }
    },
    open: () => openSettings(),
    close: () => closeSettings(),
  };
  window.__dSettings = api;
  return api;
}

export function neonLevel() {
  const st = (ctx && ctx.state) || {};
  const night = typeof st.night === 'number' ? st.night : (st.hour >= 20 || st.hour < 6 ? 1 : 0);
  return 1 - 0.4 * (1 - night); // 白天 0.6，夜里 1.0
}

export function setDisplay(mode) {
  S.display = mode;
  const white = mode === 'white';
  S.white = white;
  paintRow('white', white);
  document.body.classList.toggle('d-white', white);
}
