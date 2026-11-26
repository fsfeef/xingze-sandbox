// 收尾探针：console 错误收集 + HUD 实测数 + 面板收起/展开流程
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.message || '').slice(0, 300)));
  page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url()));
  page.on('response', (r) => { if (r.status() >= 400) errors.push('http' + r.status() + ': ' + r.url()); });
  await page.goto('http://localhost:8000/app/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('start-overlay').style.display === 'flex', { timeout: 90000 });
  await page.click('#enter-btn');
  await page.waitForTimeout(25000);
  const s1 = await page.evaluate(() => ({
    stats: window.__sandboxStats || null,
    hud: {
      fps: document.getElementById('stat-fps').textContent,
      calls: document.getElementById('stat-calls').textContent,
      tris: document.getElementById('stat-tris').textContent,
      buildings: document.getElementById('stat-buildings').textContent,
      trees: document.getElementById('stat-trees').textContent,
    },
  }));
  console.log('AFTER-25S ' + JSON.stringify(s1));
  // 面板收起/展开
  await page.click('#panel-close');
  await page.waitForTimeout(1500);
  const p1 = await page.evaluate(() => ({
    panelHidden: document.getElementById('panel').classList.contains('hidden'),
    toggleShow: document.getElementById('panel-toggle').classList.contains('show'),
    toggleVisible: getComputedStyle(document.getElementById('panel-toggle')).display,
  }));
  console.log('PANEL-CLOSED ' + JSON.stringify(p1));
  await page.click('#panel-toggle');
  await page.waitForTimeout(1500);
  const p2 = await page.evaluate(() => ({
    panelHidden: document.getElementById('panel').classList.contains('hidden'),
    toggleShow: document.getElementById('panel-toggle').classList.contains('show'),
  }));
  console.log('PANEL-REOPENED ' + JSON.stringify(p2));
  await page.screenshot({ path: '/home/hatch/workspace/virtual-city/tests/08-panel.png' });
  console.log('ERRORS(' + errors.length + '): ' + JSON.stringify(errors));
  await browser.close();
  console.log('DONE');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
