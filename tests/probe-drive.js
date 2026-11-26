// 补测：开车按住 W 是否真的跑起来、走路按住 W 是否移动（六区模式地面高度已接 terrain）
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const OUT = '/home/hatch/workspace/virtual-city/tests';
const log = (...a) => console.log(...a);
(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
  await page.goto('http://localhost:8000/app/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const s = document.getElementById('start-overlay');
    return s && s.style.display === 'flex';
  }, { timeout: 240000 });
  await page.click('#enter-btn');
  await page.waitForTimeout(15000); // 等首批流式加载
  // 开车：W 3 秒
  await page.click('#mode-seg button[data-mode="drive"]');
  await page.waitForTimeout(2000);
  const d0 = await page.evaluate(() => ({ speed: document.getElementById('drive-speed').textContent }));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');
  const d1 = await page.evaluate(() => ({ speed: document.getElementById('drive-speed').textContent }));
  await page.screenshot({ path: path.join(OUT, 'six-12-drive-moving.png') });
  log('drive speed before W: ' + d0.speed + ' | after 3s W: ' + d1.speed);
  // 走路：W 3 秒（看小地图蓝点是否移动）
  await page.click('#mode-seg button[data-mode="aerial"]');
  await page.waitForTimeout(1500);
  await page.click('#mode-seg button[data-mode="walk"]');
  await page.waitForTimeout(2000);
  const w0 = await page.evaluate(() => {
    const cv = document.getElementById('minimap');
    return cv.toDataURL().length;
  });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: path.join(OUT, 'six-13-walk-moving.png') });
  log('walk W held 3s, minimap dataURL len (sanity): ' + w0);
  log('ERRORS(' + errors.length + '): ' + JSON.stringify(errors));
  await browser.close();
  log('DONE');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
