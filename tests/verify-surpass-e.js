// E 路验证：tower-fix + perf 在真沙盘里动态加载实测
// 跑：cd ~/workspace/virtual-city && node tests/verify-surpass-e.js
// 要求：http://localhost:8000 正在服务 ~/workspace/virtual-city
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname);
// 可移植：输出目录跟脚本走；Chromium 路径用环境变量 CHROMIUM_PATH 指定，
// 不指定时 playwright-core 自己从缓存找；沙盘地址用 SANDBOX_URL 覆盖。
const APP_URL = process.env.SANDBOX_URL || 'http://localhost:8000/app/';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || undefined;
// 截图：首选页内同步渲染一次后直接读 canvas（toDataURL），绕开合成器截图；
// SwiftShader + 多路并行抢 CPU 时 page.screenshot 曾连续超时（30s/120s 都挂过）。
// dom=true 的那张（测量值字条在 DOM 层）先试 page.screenshot，超时再回落到 canvas。
async function shot(page, name, dom = false) {
  if (dom) {
    try { await page.screenshot({ path: path.join(OUT, name), timeout: 60000 }); return; }
    catch (e) { log('page.screenshot failed for ' + name + ': ' + e.message.split('\n')[0] + '; fallback to canvas capture'); }
  }
  const dataUrl = await page.evaluate(() => {
    const sb = window.__sandbox;
    if (sb.composer) sb.composer.render();
    else sb.renderer.render(sb.scene, sb.camera);
    return sb.renderer.domElement.toDataURL('image/png');
  }, undefined, { timeout: 120000 });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
}
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=960,600'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('crash', () => errors.push('PAGE CRASHED'));
  const errors = [];
  const failedReqs = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => failedReqs.push(r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.status() + ' ' + r.url()); });

  const t0 = Date.now();
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try {
    await page.waitForFunction(() => {
      const s = document.getElementById('start-overlay');
      const e = document.getElementById('error-overlay');
      return (s && s.style.display === 'flex') || (e && e.style.display === 'flex');
    }, { timeout: 240000 });
  } catch (e) { errors.push('timeout waiting for boot overlay'); }
  const bootMs = Date.now() - t0;
  log('bootMs(first screen, overlay shown)=' + bootMs);
  // #enter-btn 有两个同名元素（开始层 + 报错层），用开始层内的那个点
  await page.evaluate(() => document.querySelector('#start-overlay #enter-btn').click());
  await sleep(2000);

  // 等流式加载稳定：farTiles >= 90 且两轮不变
  let far = 0, stable = 0, prevFar = -1, prevH = -1;
  for (let i = 0; i < 45; i++) {
    await sleep(4000);
    const s = await page.evaluate(() => (window.__sandboxStats && window.__sandboxStats.six) || null);
    if (!s) continue;
    far = s.farTiles;
    if (s.farTiles === prevFar && s.chunksHigh === prevH && s.farTiles >= 90) { stable++; if (stable >= 2) break; }
    else stable = 0;
    prevFar = s.farTiles; prevH = s.chunksHigh;
  }
  const statsPre = await page.evaluate(() => window.__sandboxStats || null);
  log('stats pre-modules: ' + JSON.stringify(statsPre));
  const groundBefore = await page.evaluate(() => window.__sandbox.sixLoader.groundHeightAt(2492.5, -179.1));
  log('groundHeightAt tower before merge: ' + groundBefore);

  // 总览相机（与基线同一机位），量合并前 draw call（取 3 次中位）
  async function setOverview() {
    await page.evaluate(() => {
      const s = window.__sandbox.state;
      s.mode = 'aerial'; s.target.set(0, 0, 0); s.dist = 6000; s.el = 0.6; s.yaw = 0.3;
    });
    await sleep(2500);
  }
  async function callsMedian() {
    const xs = [];
    for (let i = 0; i < 3; i++) { xs.push(await page.evaluate(() => window.__sandbox.renderer.info.render.calls)); await sleep(1000); }
    xs.sort((a, b) => a - b);
    return xs[1];
  }
  await setOverview();
  const callsBefore = await callsMedian();
  log('drawCalls BEFORE (overview, median of 3): ' + callsBefore);
  await shot(page, 'surpass-e-overview-before.png');

  // 动态加载两个模块（不改 app.js / index.html）
  const initRes = await page.evaluate(async () => {
    const t = await import('/app/tower-fix.js');
    const tw = await t.init(window.__sandbox);
    const p = await import('/app/perf.js');
    const pf = await p.init(window.__sandbox);
    return { tower: tw.measure(), perf: pf.stats() };
  });
  log('init result: ' + JSON.stringify(initRes));

  // 等 perf 合并完成（rebuilds>=1 且 far 全合）
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const ps = await page.evaluate(() => window.__perf.stats());
    if (ps.rebuilds >= 1 && ps.far >= 90) { log('perf stats: ' + JSON.stringify(ps)); break; }
    if (i === 19) log('perf stats (timeout, last): ' + JSON.stringify(ps));
  }
  const groundAfter = await page.evaluate(() => window.__sandbox.sixLoader.groundHeightAt(2492.5, -179.1));
  log('groundHeightAt tower after merge: ' + groundAfter + ' (before=' + groundBefore + ')');

  await setOverview();
  const callsAfter = await callsMedian();
  log('drawCalls AFTER (overview, median of 3): ' + callsAfter);
  await shot(page, 'surpass-e-overview.png');

  // 塔近景：相机摆到塔前，目标点抬到 150m 让整塔入画
  await page.evaluate(() => {
    const s = window.__sandbox.state;
    s.mode = 'aerial'; s.target.set(2492.5, 150, -179.1); s.dist = 900; s.el = 0.35; s.yaw = 0.6;
  });
  await sleep(6000); // 等塔附近分块流进来 + perf 重建
  const towerMeasure = await page.evaluate(() => window.__towerFix.measure());
  log('tower measure: ' + JSON.stringify(towerMeasure));
  await shot(page, 'surpass-e-tower-day.png');

  // 测量值截图：页面临时叠加测量字条（不改任何文件）
  await page.evaluate((m) => {
    const d = document.createElement('div');
    d.id = 'e-measure-badge';
    d.textContent = `339塔实测: 地面 ${m.groundY}m · 塔顶 ${m.topY}m · 塔高 ${m.height}m (目标 339m, 误差 ${m.error}m, ±5m ${m.within5m ? '通过' : '不通过'})`;
    d.style.cssText = 'position:fixed;left:12px;top:64px;z-index:9999;background:#0b1026;color:#00f0ff;font:16px monospace;padding:8px 12px;border:1px solid #00f0ff;border-radius:6px;';
    document.body.appendChild(d);
  }, towerMeasure);
  await sleep(500);
  await shot(page, 'surpass-e-tower-measure.png', true);
  await page.evaluate(() => document.getElementById('e-measure-badge')?.remove());

  // 夜景塔
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '22'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(3000);
  await shot(page, 'surpass-e-tower-night.png');
  log('time label night: ' + await page.evaluate(() => document.getElementById('time-label').textContent));

  // 白膜：霓虹应收起
  await page.click('#tgl-white');
  await sleep(1500);
  await page.evaluate(() => window.__towerFix.setDisplay('white'));
  await page.evaluate(() => window.__perf.setDisplay('white'));
  await sleep(1000);
  const whiteState = await page.evaluate(() => ({
    ringsVisible: window.__towerFix.group.children.filter((o) => o.geometry && o.geometry.type === 'TorusGeometry').map((o) => o.visible),
  }));
  log('white mode rings visible: ' + JSON.stringify(whiteState));
  await shot(page, 'surpass-e-tower-white.png');
  await page.click('#tgl-white');
  await page.evaluate(() => window.__towerFix.setDisplay('normal'));
  await page.evaluate(() => window.__perf.setDisplay('normal'));
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '10'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(1000);

  const statsFinal = await page.evaluate(() => window.__sandboxStats || null);
  log('stats final: ' + JSON.stringify(statsFinal));
  log('perf final: ' + JSON.stringify(await page.evaluate(() => window.__perf.stats())));
  log('ERRORS(' + errors.length + '): ' + JSON.stringify(errors, null, 1));
  log('FAILED REQUESTS(' + failedReqs.length + '): ' + JSON.stringify(failedReqs.slice(0, 20), null, 1));
  await browser.close();
  log('DONE');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
