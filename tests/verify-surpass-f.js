// F 路验证：people.js + street.js 在真沙盘里动态加载，0 报错，出截图
// 跑：cd ~/workspace/virtual-city && node tests/verify-surpass-f.js
// 截图：tests/surpass-f-*.png
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = '/home/hatch/workspace/virtual-city/tests';
fs.mkdirSync(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), timeout: 120000 });
const log = (...a) => console.log(...a);

let browser = null;
(async () => {
  browser = await chromium.launch({
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=960,600', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const errors = [];
  const failedReqs = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => failedReqs.push(r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.status() + ' ' + r.url()); });

  const t0 = Date.now();
  await page.goto('http://localhost:8000/app/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  try {
    await page.waitForFunction(() => {
      const s = document.getElementById('start-overlay');
      const e = document.getElementById('error-overlay');
      return (s && s.style.display === 'flex') || (e && e.style.display === 'flex');
    }, { timeout: 240000 });
  } catch (e) { errors.push('timeout waiting for boot overlay'); }
  log('bootMs: ' + (Date.now() - t0));
  await page.evaluate(() => document.getElementById('enter-btn').click());
  await page.waitForTimeout(2000);
  let s0 = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    s0 = await page.evaluate(() => (window.__sandboxStats && window.__sandboxStats.six) || null);
    if (s0) break;
  }
  log('stats first seen: ' + JSON.stringify(s0));

  // 相机助手：走路视角，(x,z) 站位，看向 (tx,tz)
  await page.evaluate(() => {
    window.__fCam = (x, z, tx, tz, pitch = -0.02) => {
      const sb = window.__sandbox;
      const gy = sb.sixLoader.groundHeightAt(x, z);
      sb.state.pos.set(x, gy + 1.7, z);
      sb.state.lookYaw = Math.atan2(-(tx - x), -(tz - z));
      sb.state.lookPitch = pitch;
      sb.state.fov = 62;
    };
  });

  // 动态加载 F 路两个模块（接线钩子 window.__sandbox）
  const loaded = await page.evaluate(async () => {
    const people = await import('/app/people.js');
    const street = await import('/app/street.js');
    const p = people.init(window.__sandbox);
    const s = street.init(window.__sandbox);
    window.__fMods = { people, street };
    return {
      people: p.count,
      street: { lamps: s.lamps, furniture: s.furniture, shops: s.shops, routePts: s.route.length },
    };
  });
  log('modules loaded: ' + JSON.stringify(loaded));
  await page.waitForTimeout(2000);
  // 实灯收割：等分块流式加载 + 2.5s 重扫，灯数稳定后再验
  let lampCount = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(2500);
    lampCount = await page.evaluate(() => window.__street.lamps);
    log(`lamp harvest poll ${i}: ${lampCount}`);
    if (lampCount > 500) break;
  }
  log('lamps harvested (real, from chunk line geometry): ' + lampCount);

  // 切走路模式
  await page.evaluate(() => document.querySelector('#mode-seg button[data-mode="walk"]').click());
  await page.waitForTimeout(1500);

  // 行人走得动：两次采样位置
  const posA = await page.evaluate(() => window.__people.getPositions());
  // headless 下 SwiftShader 约 1fps，rAF 帧率极低、dt 又钳在 0.05s：直接以模拟时间
  // 推进 3 秒验步态/位移（真机 60fps 下 rAF 每帧推进，同样代码正常走）
  await page.evaluate(() => window.__people.update(3));
  const posB = await page.evaluate(() => window.__people.getPositions());
  let moved = 0, movedDist = [];
  for (let i = 0; i < posA.length; i++) {
    const d = Math.hypot(posB[i].x - posA[i].x, posB[i].z - posA[i].z);
    movedDist.push(+d.toFixed(1));
    if (d > 1) moved++;
  }
  log(`pedestrians moved >1m in 3s: ${moved}/${posA.length} dists=${JSON.stringify(movedDist.slice(0, 12))}...`);

  // ① 走路视角行人：站 S1 中段，看向春熙路方向（行人最密段）
  await page.evaluate(() => window.__fCam(430, -748, 700, -830));
  await page.waitForTimeout(1500);
  await shot(page, 'surpass-f-walk-people.png');
  // 视野内行人估算：把行人投影到相机前方 40m、±35° 锥内
  const inView = await page.evaluate(() => {
    const sb = window.__sandbox;
    const cam = sb.camera.position;
    const fwd = { x: -Math.sin(sb.state.lookYaw), z: -Math.cos(sb.state.lookYaw) };
    let n = 0;
    for (const p of window.__people.getPositions()) {
      const dx = p.x - cam.x, dz = p.z - cam.z;
      const d = Math.hypot(dx, dz);
      if (d > 45 || d < 0.5) continue;
      const dot = (dx * fwd.x + dz * fwd.z) / d;
      if (dot > 0.82) n++;
    }
    return n;
  });
  log('pedestrians in walk view cone: ' + inView);

  // ② 行人近景：离最近的行人 3.5m
  await page.evaluate(() => {
    const sb = window.__sandbox;
    const cam = sb.camera.position;
    const ps = window.__people.getPositions();
    let best = null, bd = 1e9;
    for (const p of ps) {
      const d = Math.hypot(p.x - cam.x, p.z - cam.z);
      if (d < bd) { bd = d; best = p; }
    }
    const p = best;
    // 站到行人侧前方 3.5m
    const fx = p.x + 2.5, fz = p.z + 2.5;
    window.__fCam(fx, fz, p.x, p.z, -0.05);
    window.__fClosePed = p;
  });
  await page.waitForTimeout(1200);
  await shot(page, 'surpass-f-ped-closeup.png');
  log('closeup ped: ' + JSON.stringify(await page.evaluate(() => window.__fClosePed)));

  // ③ 夜景重做（第 24 行）：同一机位白天/夜景对照，夜里街面看得清
  await page.evaluate(() => window.__fCam(430, -748, 700, -830));
  await page.waitForTimeout(1200);
  await shot(page, 'surpass-f-night-day.png');
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '22'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__fCam(430, -748, 700, -830));
  await page.waitForTimeout(1200);
  const nightState = await page.evaluate(() => ({
    night: window.__sandbox.state.night,
    glowOpacity: window.__street.group.getObjectByName('surpass-lamp-glow').material.opacity,
    headsOpacity: window.__street.group.getObjectByName('surpass-lamp-heads').material.opacity,
    lamps: window.__street.lamps,
  }));
  log('night state: ' + JSON.stringify(nightState));
  await shot(page, 'surpass-f-night-lamps.png');

  // ④ 街具：路口 (500,-770) 附近，长椅/垃圾桶/指示牌/红绿灯都在这圈
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '10'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__fCam(488, -756, 512, -778, -0.08));
  await page.waitForTimeout(1200);
  await shot(page, 'surpass-f-furniture.png');

  // ⑤ 三条街霓虹招牌
  const neonSpots = [
    ['surpass-f-neon-chunxi.png', 1100, -970, 1155.7, -1050],   // 春熙路
    ['surpass-f-neon-taikoo.png', 1330, -940, 1390.3, -990],    // 太古里
    ['surpass-f-neon-cross.png', 1130, -1150, 1155.7, -1000],   // 纵街
  ];
  for (const [name, x, z, tx, tz] of neonSpots) {
    await page.evaluate(([x, z, tx, tz]) => window.__fCam(x, z, tx, tz, -0.03), [x, z, tx, tz]);
    await page.waitForTimeout(1200);
    await shot(page, name);
  }

  // ⑥ “街上实时验”：沿路线每 100m 一张走路视角
  const route = await page.evaluate(() => window.__street.route);
  log('route samples: ' + route.length);
  for (let i = 0; i < route.length; i++) {
    const [x, z] = route[i];
    const nxt = route[Math.min(i + 1, route.length - 1)];
    await page.evaluate(([x, z, nx, nz]) => window.__fCam(x, z, nx, nz, -0.02), [x, z, nxt[0], nxt[1]]);
    await page.waitForTimeout(900);
    await shot(page, `surpass-f-route-${String(i).padStart(2, '0')}.png`);
  }

  // ⑦ 白膜：调模块 setDisplay('white')，霓虹应收起
  await page.evaluate(() => {
    window.__fMods.people.setDisplay('white');
    window.__fMods.street.setDisplay('white');
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__fCam(430, -748, 700, -830));
  await page.waitForTimeout(800);
  await shot(page, 'surpass-f-white.png');
  const whiteState = await page.evaluate(() => ({
    glowOpacity: window.__street.group.getObjectByName('surpass-lamp-glow').material.opacity,
  }));
  log('white mode: ' + JSON.stringify(whiteState));
  await page.evaluate(() => {
    window.__fMods.people.setDisplay('normal');
    window.__fMods.street.setDisplay('normal');
  });
  await page.waitForTimeout(800);

  // draw calls（街面视角）
  const dc = await page.evaluate(() => window.__sandbox.renderer.info.render.calls);
  log('draw calls at street level: ' + dc);
  const stats2 = await page.evaluate(() => window.__sandboxStats || null);
  log('stats final: ' + JSON.stringify(stats2));
  log('ERRORS(' + errors.length + '): ' + JSON.stringify(errors, null, 1));
  log('FAILED REQUESTS(' + failedReqs.length + '): ' + JSON.stringify(failedReqs.slice(0, 20), null, 1));
  await browser.close();
  log('DONE');
})().catch(async (e) => { console.error('FATAL', e); try { await browser.close(); } catch (_) {} process.exit(1); });
