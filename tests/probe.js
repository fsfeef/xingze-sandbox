// 聚焦探针：只抓沙盘启动失败的真实错误
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => console.log('[console.' + m.type() + '] ' + m.text().slice(0, 500)));
  page.on('pageerror', (e) => console.log('[pageerror] ' + (e.stack || e.message).slice(0, 800)));
  page.on('requestfailed', (r) => console.log('[reqfail] ' + r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('response', (r) => { if (r.status() >= 400) console.log('[http' + r.status() + '] ' + r.url()); });
  await page.goto('http://localhost:8000/app/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(15000);
  const st = await page.evaluate(() => ({
    started: !!window.__sandboxStarted,
    stats: window.__sandboxStats || null,
    start: document.getElementById('start-overlay').style.display,
    error: document.getElementById('error-overlay').style.display,
    errorText: document.getElementById('error-text').textContent,
    loading: document.getElementById('loading-overlay').style.display,
    webgl: (() => { try { const c = document.createElement('canvas'); return !!c.getContext('webgl2'); } catch (e) { return 'err:' + e.message; } })(),
  }));
  console.log('STATE ' + JSON.stringify(st, null, 1));
  await page.screenshot({ path: '/home/hatch/workspace/virtual-city/tests/00-boot-error.png' });
  await browser.close();
  console.log('DONE');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
