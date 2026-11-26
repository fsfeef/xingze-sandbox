// 虚拟城市沙盘验证脚本：playwright-core + /opt/meta-chromium/chrome + SwiftShader
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url() + ' ' + ((r.failure() || {}).errorText || '')));

  const t0 = Date.now();
  await page.goto('http://localhost:8000/app/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  let boot = 'unknown';
  try {
    await page.waitForFunction(() => {
      const s = document.getElementById('start-overlay');
      const e = document.getElementById('error-overlay');
      return (s && s.style.display === 'flex') || (e && e.style.display === 'flex');
    }, { timeout: 90000 });
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
  }));
  log(JSON.stringify({ boot, bootMs, ...st }));

  if (st.start === 'flex') {
    await page.click('#enter-btn');
    await page.waitForTimeout(5000);
  }
  const stats1 = await page.evaluate(() => window.__sandboxStats || null);
  log('stats after enter: ' + JSON.stringify(stats1));
  await shot(page, '01-day-aerial.png');

  // idle fps over 5s
  const fpsIdle = await page.evaluate(() => new Promise((res) => {
    let n = 0; const t = performance.now();
    const tick = () => { n++; if (performance.now() - t < 5000) requestAnimationFrame(tick); else res((n / 5).toFixed(1)); };
    requestAnimationFrame(tick);
  }));
  log('fps idle 5s: ' + fpsIdle);

  // drag test
  const camBefore = await page.evaluate(() => window.__sandboxCam ? JSON.stringify(window.__sandboxCam()) : 'n/a');
  await page.mouse.move(640, 400);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(640 + i * 18, 400 - i * 4); await page.waitForTimeout(60); }
  await page.mouse.up();
  await page.waitForTimeout(1500);
  await shot(page, '02-after-drag.png');
  log('drag done, cam before: ' + camBefore);

  // night via time slider
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '22'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(3000);
  const timeLabel = await page.evaluate(() => document.getElementById('time-label').textContent);
  log('time label after set 22: ' + timeLabel);
  await shot(page, '03-night.png');

  // back to day 10
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '10'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1500);

  // heatmap toggle
  await page.click('#tgl-heat');
  await page.waitForTimeout(1200);
  await shot(page, '04-heatmap.png');
  log('heat pressed: ' + await page.evaluate(() => document.getElementById('tgl-heat').getAttribute('aria-pressed')));
  await page.click('#tgl-heat');
  await page.waitForTimeout(500);

  // white model toggle
  await page.click('#tgl-white');
  await page.waitForTimeout(1200);
  await shot(page, '05-whitemodel.png');
  log('white pressed: ' + await page.evaluate(() => document.getElementById('tgl-white').getAttribute('aria-pressed')));
  await page.click('#tgl-white');
  await page.waitForTimeout(500);

  // landmark fly: click first item in #list-landmarks
  const lm = await page.evaluate(() => {
    const box = document.getElementById('list-landmarks');
    if (!box) return 'no-list';
    const el = box.querySelector('button, a, [data-fly], div');
    if (!el) return 'no-item:' + box.children.length;
    const t = el.textContent.trim().slice(0, 40);
    el.click();
    return 'clicked:' + t;
  });
  log('landmark: ' + lm);
  await page.waitForTimeout(3000);
  await shot(page, '06-landmark-fly.png');

  // minimap click (center of #minimap)
  const mm = await page.evaluate(() => {
    const r = document.getElementById('minimap').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  });
  log('minimap box: ' + JSON.stringify(mm));
  await page.mouse.click(mm.x, mm.y);
  await page.waitForTimeout(3000);
  await shot(page, '07-minimap-fly.png');

  // left panel open
  await page.click('#panel-toggle');
  await page.waitForTimeout(1000);
  await shot(page, '08-panel.png');
  const panelVisible = await page.evaluate(() => {
    const p = document.getElementById('panel');
    const cs = getComputedStyle(p);
    return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity };
  });
  log('panel: ' + JSON.stringify(panelVisible));

  const stats2 = await page.evaluate(() => window.__sandboxStats || null);
  log('stats final: ' + JSON.stringify(stats2));
  log('ERRORS(' + errors.length + '): ' + JSON.stringify(errors, null, 1));
  await browser.close();
  log('DONE');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
