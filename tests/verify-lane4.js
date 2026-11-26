// 4 路验证 · 分段可断点续跑（第二段：塔；第三段：太阳/天气/设置/地图）
// 跑法（本机 / 八核实例 dsw-foxdlkzn0y3rnnkded 上都一样）：
//   git clone https://github.com/fsfeef/xingze-sandbox.git   # 实例上先 clone，全套 310MB 包在里面
//   cd xingze-sandbox && python3 -m http.server 8000          # 服务根目录就是仓库根
//   npm i -D playwright-core   # 或设 NODE_PATH 指到已有 playwright-core；Chromium 用 CHROMIUM_PATH 指
//   node tests/verify-lane4.js --all                          # 全跑
//   node tests/verify-lane4.js --stage 5                       # 只跑一段
//   node tests/verify-lane4.js --resume                        # 断了续跑：跳过检查点里已过的段
// 每段独立起浏览器、等沙盘 ready、验完写检查点就退出，单段约 1–3 分钟，
// 实例 1 小时无操作自动关机也不怕：续跑只跑没过的段。检查点：tests/lane4-checkpoint.json
// 截图：tests/lane4-s<段>-*.png。BASE 可用 --base 或 LANE4_BASE 覆盖，默认 http://localhost:8000/app/
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CKPT = path.join(DIR, 'lane4-checkpoint.json');
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').slice(7)
  || process.env.LANE4_BASE || 'http://localhost:8000/app/';

let playwright;
try { playwright = require('playwright-core'); }
catch (e) {
  const p = process.env.PLAYWRIGHT_CORE_PATH;
  if (p) playwright = require(p);
  else { console.error('FATAL: playwright-core 未找到。装：npm i -D playwright-core，或设 PLAYWRIGHT_CORE_PATH 指到它。'); process.exit(2); }
}
const CHROMIUM = process.env.CHROMIUM_PATH || '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome';

function loadCkpt() { try { return JSON.parse(fs.readFileSync(CKPT, 'utf8')); } catch (e) { return { stages: {} }; } }
function saveCkpt(c) { fs.writeFileSync(CKPT, JSON.stringify(c, null, 2)); }

async function launch(pageSetup) {
  const opts = { args: ['--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'] };
  if (CHROMIUM && fs.existsSync(CHROMIUM)) opts.executablePath = CHROMIUM;
  const browser = await playwright.chromium.launch(opts);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [], failedReqs = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => failedReqs.push(r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.status() + ' ' + r.url()); });
  const t0 = Date.now();
  let navigated = false;
  for (let i = 0; i < 3 && !navigated; i++) {
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
      navigated = true;
    } catch (e) {
      console.log(`[launch] goto 第 ${i + 1} 次失败：${String(e.message || e).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!navigated) throw new Error('goto 3 次都失败，服务或小机器瞬时过载');
  await page.waitForFunction(() => window.__sandbox, { timeout: 240000 });
  // 开始遮罩是 init() 后半段才显示的（__sandbox 出现得更早）：等它出来再点进入，不然点早了会被 init 盖回来
  await page.waitForFunction(() => {
    const s = document.getElementById('start-overlay');
    const e = document.getElementById('error-overlay');
    return (s && s.style.display === 'flex') || (e && e.style.display === 'flex');
  }, { timeout: 240000 });
  const errShown = await page.evaluate(() => document.getElementById('error-overlay').style.display === 'flex');
  if (errShown) throw new Error('沙盘 error-overlay：' + await page.evaluate(() => document.getElementById('error-text').textContent));
  const bootMs = Date.now() - t0;
  await page.evaluate(() => { const b = document.querySelector('#enter-btn'); if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 800));
  return { browser, page, errors, failedReqs, bootMs };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SwiftShader 下全城截图很慢：120 秒超时 + 重试一次；截图失败只记 shotOk=false，
// 不丢本段的功能结果（检查点照写），截图留到实例上补拍
async function shot(page, name) {
  for (let i = 0; i < 2; i++) {
    try { await page.screenshot({ path: path.join(DIR, name), timeout: 120000 }); return true; }
    catch (e) { console.log(`[shot] ${name} 第 ${i + 1} 次失败：${String(e.message || e).slice(0, 80)}`); await sleep(5000); }
  }
  return false;
}
function finish(browser, ckpt, stage, result, errors, failedReqs) {
  result.errors = errors; result.failedReqs = failedReqs.slice(0, 10);
  result.pass = errors.length === 0 && failedReqs.length === 0 && result.ok !== false;
  ckpt.stages[stage] = result;
  saveCkpt(ckpt);
  console.log(`[stage ${stage}] pass=${result.pass} ` + JSON.stringify(result));
  return browser.close();
}
function flyTo(page, x, z, dist, el) {
  return page.evaluate(({ x, z, dist, el }) => {
    const st = window.__sandbox.state;
    st.mode = 'aerial'; st.target.set(x, 0, z); st.dist = dist; st.el = el; st.yaw = -0.65;
  }, { x, z, dist, el });
}
function setHour(page, h) {
  return page.evaluate((h) => {
    const s = document.querySelector('#time-slider');
    s.value = String(h);
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, h);
}

const STAGES = {
  // 第二段：339 塔量出来 339m±5m（白天 / 夜景 / 白膜三张截图）
  1: async (ckpt) => {
    const { browser, page, errors, failedReqs, bootMs } = await launch();
    const m = await page.evaluate(async () => {
      const t = await import('./tower-fix.js');
      const api = await t.init(window.__sandbox);
      return { measure: t.measure(), apiOk: !!api };
    });
    const ok = m.measure.ok && m.measure.within5m && Math.abs(m.measure.error) <= 5;
    await flyTo(page, 2492.5, -179.1, 700, 0.45);
    await sleep(2500);
    const shotDay = await shot(page, 'lane4-s1-tower-day.png');
    await setHour(page, 22); await sleep(2000);
    const shotNight = await shot(page, 'lane4-s1-tower-night.png');
    await page.evaluate(async () => { (await import('./tower-fix.js')).setDisplay('white'); });
    await sleep(1500);
    const shotWhite = await shot(page, 'lane4-s1-tower-white.png');
    await page.evaluate(async () => { (await import('./tower-fix.js')).setDisplay('normal'); });
    await setHour(page, 10);
    await finish(browser, ckpt, 1, { ok, bootMs, shots: { day: shotDay, night: shotNight, white: shotWhite }, ...m }, errors, failedReqs);
  },
  // 第三段之一：太阳（纬度 30.66° 真太阳时，四档）
  2: async (ckpt) => {
    const { browser, page, errors, failedReqs, bootMs } = await launch();
    const r = await page.evaluate(async () => {
      const sun = await import('./sun.js');
      const api = sun.init(window.__sandbox);
      const out = {
        preset: api.state.preset, lat: api.state.lat, lon: api.state.lon,
        noonWinterAlt: +api.sunPos(12, 355).alt.toFixed(1),
        noonSummerAlt: +api.sunPos(12, 172).alt.toFixed(1),
        winterDay: +api.dayLength(355).toFixed(1),
        summerDay: +api.dayLength(172).toFixed(1),
        springDay: +api.dayLength(79).toFixed(1),
        dahanDay: +api.dayLength(20).toFixed(1),
      };
      api.setOn(true); api.setPreset('winter');
      out.on = api.state.on; out.winter = { sunrise: +api.state.sunrise.toFixed(2), sunset: +api.state.sunset.toFixed(2), length: +api.state.length.toFixed(1) };
      return out;
    });
    const ok = r.lat === 30.66 && r.winterDay >= 9.5 && r.winterDay <= 10.5
      && r.summerDay >= 13.5 && r.summerDay <= 14.5 && r.noonWinterAlt > 30 && r.noonWinterAlt < 40
      && r.noonSummerAlt > 70 && r.noonSummerAlt < 85 && r.on === true;
    await sleep(1200); await shot(page, 'lane4-s2-sun-winter.png');
    await finish(browser, ckpt, 2, { ok, bootMs, ...r }, errors, failedReqs);
  },
  // 第三段之二：天气（雨 / 雪 / 雾）
  3: async (ckpt) => {
    const { browser, page, errors, failedReqs, bootMs } = await launch();
    const r = await page.evaluate(async () => {
      const w = await import('./weather.js');
      const api = w.init(window.__sandbox);
      const fog0 = window.__sandbox.scene.fog ? { near: window.__sandbox.scene.fog.near, far: window.__sandbox.scene.fog.far } : null;
      const rainOn = api.setRain(true);
      const snowOn = api.setSnow(true);
      const fog = api.setFog(0.5);
      const fogMid = window.__sandbox.scene.fog ? { near: window.__sandbox.scene.fog.near, far: window.__sandbox.scene.fog.far } : null;
      api.setFog(0); api.setSnow(false); api.setRain(false);
      const restoredFog = window.__sandbox.scene.fog ? { near: window.__sandbox.scene.fog.near, far: window.__sandbox.scene.fog.far } : null;
      return { rainOn, snowOn, fog, fog0, fogMid, restoredFog, restored: api.state };
    });
    // 雾 0.5 时 near/far 按实测基准线性收；关雾后必须回到实测基准（六区 4000/40000），不是写死的 1400/5200
    const near05 = Math.max(300, r.fog0.near * 0.625), far05 = r.fog0.far - (r.fog0.far - 1450) * 0.5;
    const ok = r.rainOn && r.snowOn && r.fog === 0.5 && r.fogMid
      && Math.abs(r.fogMid.near - near05) < 1 && Math.abs(r.fogMid.far - far05) < 1
      && r.restoredFog && r.restoredFog.near === r.fog0.near && r.restoredFog.far === r.fog0.far
      && r.restored.rain === false && r.restored.snow === false && r.restored.fog === 0;
    await page.evaluate(async () => { const w = await import('./weather.js'); w.init(window.__sandbox).setRain(true); });
    await sleep(1500); await shot(page, 'lane4-s3-rain.png');
    await finish(browser, ckpt, 3, { ok, bootMs, ...r }, errors, failedReqs);
  },
  // 第三段之三：设置（正好五个开关）
  4: async (ckpt) => {
    const { browser, page, errors, failedReqs, bootMs } = await launch();
    const r = await page.evaluate(async () => {
      const st = await import('./settings.js');
      const api = st.init(window.__sandbox);
      api.open();
      const rows = [...document.querySelectorAll('#d-settings .d-sw-row')].map((e) => e.dataset.key);
      api.applyNight();
      const night = { hour: document.querySelector('#time-slider').value, night: api.state.night };
      api.applyDay();
      const day = { hour: document.querySelector('#time-slider').value, day: api.state.day };
      return { rows, night, day, neonDay: api.neonLevel() };
    });
    const ok = JSON.stringify(r.rows) === JSON.stringify(['day', 'night', 'rain', 'snow', 'white'])
      && r.night.hour === '22' && r.day.hour === '10';
    await sleep(600); await shot(page, 'lane4-s4-settings.png');
    await finish(browser, ckpt, 4, { ok, bootMs, ...r }, errors, failedReqs);
  },
  // 第三段之四：地图（小地图 + 放大 + 跟随 + 回位 + 环视 + K06 tint）
  5: async (ckpt) => {
    const { browser, page, errors, failedReqs, bootMs } = await launch();
    const r = await page.evaluate(async () => {
      const mp = await import('./maps.js');
      const api = mp.init(window.__sandbox);
      const out = { check: api.checkMinimap() };
      // 放大：量三个时刻的盒子宽，验证“先小、再慢慢放大”真在长
      const opened = api.zoom.open();
      const sizes = [];
      const box = document.querySelector('#d-map-zoom');
      sizes.push(Math.round(box.getBoundingClientRect().width));
      await new Promise((res) => setTimeout(res, 300));
      sizes.push(Math.round(box.getBoundingClientRect().width));
      await new Promise((res) => setTimeout(res, 800));
      sizes.push(Math.round(box.getBoundingClientRect().width));
      out.zoom = {
        opened, sizes,
        isOpen: api.zoom.isOpen, follow: api.zoom.follow,
        labels: api.zoom.labels, labelsLoaded: api.zoom.labelsLoaded,
        homeBtn: !!document.querySelector('#d-map-home-btn'),
        expandBtn: !!document.querySelector('#d-map-expand-btn'),
        tint: !!document.querySelector('#d-minimap-tint'),
        tintOpacity: document.querySelector('#d-minimap-tint') ? getComputedStyle(document.querySelector('#d-minimap-tint')).opacity : null,
      };
      // 拖动 → 跟随暂停；回位 → 跟随恢复
      const cv = document.querySelector('#d-map-zoom-cv');
      const rect = cv.getBoundingClientRect();
      cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: rect.left + 200, clientY: rect.top + 200 }));
      cv.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: rect.left + 260, clientY: rect.top + 200 }));
      cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: rect.left + 260, clientY: rect.top + 200 }));
      out.afterDragFollow = api.zoom.follow;
      api.zoom.recenter();
      out.afterRecenterFollow = api.zoom.follow;
      // 环视：进 → 转 → 出，位置恢复快照
      const st = window.__sandbox.state;
      const before = { yaw: st.yaw, el: st.el, dist: st.dist };
      const entered = api.orbit.enter();
      st.yaw -= 0.5;
      const turned = st.yaw;
      api.orbit.exit();
      out.orbit = { entered, turnedYaw: +turned.toFixed(2), restoredYaw: +st.yaw.toFixed(2), beforeYaw: +before.yaw.toFixed(2) };
      return out;
    });
    const z = r.zoom;
    const ok = r.check.ok && z.opened && z.sizes[0] <= 200 && z.sizes[2] > 400
      && z.labels === 25 && z.labelsLoaded && z.homeBtn && z.expandBtn && z.tint
      && r.afterDragFollow === false && r.afterRecenterFollow === true
      && r.orbit.entered && Math.abs(r.orbit.restoredYaw - r.orbit.beforeYaw) < 0.01;
    await sleep(1000); await shot(page, 'lane4-s5-zoom.png');
    await page.evaluate(() => { window.__dMaps && window.__dMaps.zoom.close(); });
    await finish(browser, ckpt, 5, { ok, bootMs, ...r }, errors, failedReqs);
  },
  // 汇总：读检查点，报总账
  6: async (ckpt) => {
    const done = Object.keys(ckpt.stages).map(Number).sort();
    const all = [1, 2, 3, 4, 5].every((n) => ckpt.stages[n] && ckpt.stages[n].pass);
    console.log('[stage 6] stages done:', done, 'ALL_PASS:', all);
    ckpt.summary = { allPass: all, at: new Date().toISOString() };
    saveCkpt(ckpt);
    if (!all) process.exitCode = 1;
  },
};

(async () => {
  const args = process.argv.slice(2);
  const ckpt = loadCkpt();
  let list = [];
  if (args.includes('--all')) list = [1, 2, 3, 4, 5, 6];
  else if (args.includes('--resume')) list = [1, 2, 3, 4, 5].filter((n) => !(ckpt.stages[n] && ckpt.stages[n].pass)).concat([6]);
  else {
    const m = args.find((a) => a.startsWith('--stage='));
    if (m) list = [parseInt(m.slice(8), 10)];
  }
  if (!list.length) { console.log('用法：node tests/verify-lane4.js --all | --stage=N | --resume [--base=URL]'); process.exit(2); }
  for (const n of list) {
    if (!STAGES[n]) { console.error('未知段：', n); process.exit(2); }
    console.log(`--- stage ${n} ---`);
    await STAGES[n](ckpt);
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
