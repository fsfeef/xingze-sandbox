// 六区白模接进沙盘 — 验证脚本（playwright-core + SwiftShader）
// 跑：cd ~/workspace/virtual-city && node tests/verify-six.js
// 要求：http://localhost:8000 正在服务 ~/workspace/virtual-city
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = '/home/hatch/workspace/virtual-city/tests';
fs.mkdirSync(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
const log = (...a) => console.log(...a);

(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  const failedReqs = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => failedReqs.push(r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.status() + ' ' + r.url()); });

  const t0 = Date.now();
  await page.goto('http://localhost:8000/app/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  let boot = 'unknown';
  try {
    await page.waitForFunction(() => {
      const s = document.getElementById('start-overlay');
      const e = document.getElementById('error-overlay');
      return (s && s.style.display === 'flex') || (e && e.style.display === 'flex');
    }, { timeout: 240000 });
    boot = 'overlay-shown';
  } catch (e) { errors.push('timeout waiting for boot overlay'); boot = 'timeout'; }
  const bootMs = Date.now() - t0;
  const st = await page.evaluate(() => ({
    start: document.getElementById('start-overlay').style.display,
    error: document.getElementById('error-overlay').style.display,
    errorText: document.getElementById('error-text').textContent.slice(0, 300),
    mockBadge: document.getElementById('mock-badge').style.display,
    dataNote: document.getElementById('data-note').textContent,
    buildings: document.getElementById('stat-buildings').textContent,
    trees: document.getElementById('stat-trees').textContent,
    six: window.__sandboxStats ? window.__sandboxStats.six : null,
  }));
  log(JSON.stringify({ boot, bootMs, ...st }, null, 1));

  if (st.start !== 'flex') { log('BOOT FAILED'); await browser.close(); process.exit(1); }
  await page.click('#enter-btn');
  await page.waitForTimeout(2000);

  // 等流式加载稳定：先等 __sandboxStats 出现（SwiftShader 下首次写入要等数秒），再等 chunksHigh/Mid 不再增长
  let s0 = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    s0 = await page.evaluate(() => (window.__sandboxStats && window.__sandboxStats.six) || null);
    if (s0) break;
  }
  log('stats first seen: ' + JSON.stringify(s0));
  let prevH = -1, prevM = -1, stable = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const s = await page.evaluate(() => (window.__sandboxStats && window.__sandboxStats.six) || null);
    if (!s) break;
    if (s.chunksHigh === prevH && s.chunksMid === prevM) { stable++; if (stable >= 3) break; }
    else stable = 0;
    prevH = s.chunksHigh; prevM = s.chunksMid;
  }
  const stats1 = await page.evaluate(() => window.__sandboxStats || null);
  log('stats after stream settle: ' + JSON.stringify(stats1));
  await shot(page, 'six-01-day-aerial.png');

  // 小地图是否画上了总览图（采样像素，不应全是底色）
  const mmCheck = await page.evaluate(() => {
    const cv = document.getElementById('minimap');
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let varied = 0;
    for (let i = 0; i < d.length; i += 400) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.abs(r - 223) > 12 || Math.abs(g - 229) > 12 || Math.abs(b - 234) > 12) varied++;
    }
    return { sampled: d.length / 400, varied };
  });
  log('minimap pixels: ' + JSON.stringify(mmCheck));

  // idle fps 5s（SwiftShader 仅供参考，不是真机指标）
  const fpsIdle = await page.evaluate(() => new Promise((res) => {
    let n = 0; const t = performance.now();
    const tick = () => { n++; if (performance.now() - t < 5000) requestAnimationFrame(tick); else res((n / 5).toFixed(1)); };
    requestAnimationFrame(tick);
  }));
  log('fps idle 5s (SwiftShader): ' + fpsIdle);

  // 拖动
  await page.mouse.move(640, 400);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(640 + i * 18, 400 - i * 4); await page.waitForTimeout(60); }
  await page.mouse.up();
  await page.waitForTimeout(2000);
  await shot(page, 'six-02-after-drag.png');
  log('drag done');

  // 滚轮放大看近景
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(400); }
  await page.waitForTimeout(3000);
  await shot(page, 'six-03-zoomed.png');
  const statsZoom = await page.evaluate(() => window.__sandboxStats || null);
  log('stats zoomed: ' + JSON.stringify(statsZoom));

  // 夜晚
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '22'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(3000);
  log('time label after set 22: ' + await page.evaluate(() => document.getElementById('time-label').textContent));
  await shot(page, 'six-04-night.png');
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '10'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1500);

  // 热力图
  await page.click('#tgl-heat');
  await page.waitForTimeout(1500);
  await shot(page, 'six-05-heatmap.png');
  log('heat pressed: ' + await page.evaluate(() => document.getElementById('tgl-heat').getAttribute('aria-pressed')));
  await page.click('#tgl-heat');
  await page.waitForTimeout(500);

  // 白膜
  await page.click('#tgl-white');
  await page.waitForTimeout(1500);
  await shot(page, 'six-06-whitemodel.png');
  log('white pressed: ' + await page.evaluate(() => document.getElementById('tgl-white').getAttribute('aria-pressed')));
  await page.click('#tgl-white');
  await page.waitForTimeout(500);

  // 地标飞行：339电视塔
  const lm = await page.evaluate(() => {
    const box = document.getElementById('list-landmarks');
    const btns = [...box.querySelectorAll('button')];
    const t = btns.find((b) => b.textContent.includes('339电视塔')) || btns[0];
    if (!t) return 'no-item';
    const name = t.textContent.trim().slice(0, 40);
    t.click();
    return 'clicked:' + name;
  });
  log('landmark: ' + lm);
  await page.waitForTimeout(4000);
  await shot(page, 'six-07-landmark-339.png');

  // 小地图点按飞行（点小地图中心偏右）
  const mm = await page.evaluate(() => {
    const r = document.getElementById('minimap').getBoundingClientRect();
    return { x: r.x + r.width * 0.62, y: r.y + r.height * 0.38, w: r.width, h: r.height };
  });
  await page.mouse.click(mm.x, mm.y);
  await page.waitForTimeout(4000);
  await shot(page, 'six-08-minimap-fly.png');
  log('minimap click done');

  // 走路模式（切过去 3 秒，看地面高度/报错）
  await page.click('#mode-seg button[data-mode="walk"]');
  await page.waitForTimeout(3000);
  await shot(page, 'six-09-walk.png');
  log('walk mode entered');

  // 开车模式（切过去 3 秒）
  await page.click('#mode-seg button[data-mode="drive"]');
  await page.waitForTimeout(3000);
  await shot(page, 'six-10-drive.png');
  log('drive mode entered, speed: ' + await page.evaluate(() => document.getElementById('drive-speed').textContent));
  await page.click('#mode-seg button[data-mode="aerial"]');
  await page.waitForTimeout(2000);

  // 面板：先关（#panel-toggle 默认隐藏，关后面板才出现），再点 toggle 重新打开
  try {
    await page.click('#panel-close');
    await page.waitForTimeout(800);
    const toggleVisible = await page.evaluate(() => getComputedStyle(document.getElementById('panel-toggle')).display !== 'none');
    log('panel-toggle visible after close: ' + toggleVisible);
    await page.click('#panel-toggle');
    await page.waitForTimeout(1000);
  } catch (e) { errors.push('panel step: ' + e.message); }
  await shot(page, 'six-11-panel.png');
  const panelVisible = await page.evaluate(() => {
    const p = document.getElementById('panel');
    const cs = getComputedStyle(p);
    return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity };
  });
  log('panel after reopen: ' + JSON.stringify(panelVisible));

  const stats2 = await page.evaluate(() => window.__sandboxStats || null);
  log('stats final: ' + JSON.stringify(stats2));
  log('ERRORS(' + errors.length + '): ' + JSON.stringify(errors, null, 1));
  log('FAILED REQUESTS(' + failedReqs.length + '): ' + JSON.stringify(failedReqs.slice(0, 20), null, 1));
  await browser.close();
  log('DONE');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
