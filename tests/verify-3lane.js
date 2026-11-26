// verify-3lane.js — 3 路（树/街面/人/车）分步验证，可断点续跑（给 8 核 CPU 实例用）
// 用法（实例上，仓库根目录）：
//   git clone https://github.com/fsfeef/xingze-sandbox.git && cd xingze-sandbox
//   npm i playwright-core            # 或 NODE_PATH 指到已有 playwright-core
//   # chromium：npx playwright-core install chromium，或设 CHROME_PATH 指到现成 chrome
//   node tests/verify-3lane.js                 # 全跑（每步独立起浏览器）
//   node tests/verify-3lane.js --from 3         # 从第 3 步续跑（前面已过的步跳过）
//   node tests/verify-3lane.js --only 2 --force # 只重跑第 2 步
// 每步 < 5 分钟；检查点 tests/.verify-3lane-checkpoint.json；步与步之间无共享状态，
// 实例 1 小时无操作自动关也不怕，起来接着跑 --from N 就行。
// 本地服务：8000 端口没起时脚本自己起 python3 -m http.server（detached，不随脚本退出而死）。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tests');
const CKPT = path.join(OUT, '.verify-3lane-checkpoint.json');
const PORT = 8000;

function loadPw() {
  const tries = ['playwright-core', '/tmp/f-verify/node_modules/playwright-core', path.join(ROOT, 'node_modules', 'playwright-core')];
  for (const t of tries) {
    try { return require(t); } catch (e) { /* next */ }
  }
  console.error('找不到 playwright-core：先 npm i playwright-core，或设 NODE_PATH');
  process.exit(2);
}
const { chromium } = loadPw();

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const home = process.env.HOME || '/home/hatch';
  for (const v of ['chromium-1255', 'chromium-1148']) {
    const p = path.join(home, '.cache', 'ms-playwright', v, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined; // 让 playwright 自己找（已 npx install 过的）
}
const log = (...a) => console.log(...a);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), timeout: 120000 });

function readCkpt() {
  try { return JSON.parse(fs.readFileSync(CKPT, 'utf8')); } catch (e) { return {}; }
}
function writeCkpt(c) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(CKPT, JSON.stringify(c, null, 2)); }

function httpOk() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/app/', timeout: 5000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function ensureServer() {
  if (await httpOk()) { log('server: 已在跑 :8000'); return; }
  log('server: 起 python3 -m http.server 8000（detached）');
  const p = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', ROOT],
    { detached: true, stdio: 'ignore' });
  p.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await httpOk()) { log('server: 起来了'); return; }
  }
  throw new Error('8000 服务起不来');
}

async function launch() {
  const browser = await chromium.launch({
    executablePath: chromePath(),
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=960,600', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const errors = [];
  const failedReqs = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => failedReqs.push(r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.status() + ' ' + r.url()); });
  return { browser, page, errors, failedReqs };
}
async function boot(page, errors) {
  await page.goto(`http://localhost:${PORT}/app/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try {
    await page.waitForFunction(() => {
      const s = document.getElementById('start-overlay');
      const e = document.getElementById('error-overlay');
      return (s && s.style.display === 'flex') || (e && e.style.display === 'flex');
    }, { timeout: 240000 });
  } catch (e) { errors.push('timeout waiting for boot overlay'); }
  await page.evaluate(() => document.getElementById('enter-btn').click());
  await page.waitForTimeout(2000);
  let six = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    six = await page.evaluate(() => (window.__sandboxStats && window.__sandboxStats.six) || null);
    if (six) break;
  }
  if (!six) {
    const diag = await page.evaluate(() => {
      const s = document.getElementById('start-overlay');
      const e = document.getElementById('error-overlay');
      return {
        startDisplay: s ? s.style.display : 'missing',
        errorDisplay: e ? e.style.display : 'missing',
        errorText: e ? e.textContent.slice(0, 200) : '',
        hasStats: !!window.__sandboxStats,
        hasSandbox: !!window.__sandbox,
      };
    }).catch(() => ({}));
    throw new Error('六区 stats 没出现 ' + JSON.stringify(diag));
  }
  return six;
}
async function loadModules(page) {
  return page.evaluate(async () => {
    const people = await import('/app/people.js');
    const street = await import('/app/street.js');
    const car = await import('/app/playercar.js');
    const p = people.init(window.__sandbox);
    const s = street.init(window.__sandbox);
    const c = await car.init(window.__sandbox);
    window.__lane3 = { people, street, car };
    return {
      people: p.count,
      street: { lamps: s.lamps, furniture: s.furniture, shops: s.shops, trees: s.trees, lanterns: s.lanterns },
      car: c.stats,
    };
  });
}
function camTo(page, x, z, tx, tz, pitch = -0.02) {
  return page.evaluate(([x, z, tx, tz, pitch]) => {
    const sb = window.__sandbox;
    const gy = sb.sixLoader.groundHeightAt(x, z);
    sb.state.pos.set(x, gy + 1.7, z);
    sb.state.lookYaw = Math.atan2(-(tx - x), -(tz - z));
    sb.state.lookPitch = pitch;
    sb.state.fov = 62;
  }, [x, z, tx, tz, pitch]);
}
function finish(browser, errors, failedReqs, ok, data) {
  return browser.close().then(() => ({ ok: ok && errors.length === 0 && failedReqs.length === 0, errors, failedReqs, ...data }));
}

const STEPS = {
  1: {
    name: 'boot：沙盘启动，六区 stats 出现，0 报错',
    run: async () => {
      const { browser, page, errors, failedReqs } = await launch();
      const six = await boot(page, errors);
      return finish(browser, errors, failedReqs, !!six, { six });
    },
  },
  2: {
    name: 'load：三模块加载，树/灯笼/街具计数 + tris 口径复核（顶点数/3 == stats.tris）',
    run: async () => {
      const { browser, page, errors, failedReqs } = await launch();
      await boot(page, errors);
      const loaded = await loadModules(page);
      await page.waitForTimeout(2000);
      const trisCheck = await page.evaluate(() => {
        const g = window.__playercar.group;
        let verts = 0, meshes = 0;
        g.traverse((o) => {
          if (o.isMesh && o.geometry && o.geometry.attributes.position) {
            verts += o.geometry.attributes.position.count; meshes++;
          }
        });
        return { verts, meshes, trisShouldBe: verts / 3, trisReported: window.__playercar.stats.tris };
      });
      const ok = loaded.people === 64 // 48 基础 + 16 生活拨（2026-11-26 3 路第二段）
        && loaded.street.trees.total === 220
        && loaded.street.lanterns.lanterns === 66
        && loaded.car.replaced === true
        && trisCheck.trisShouldBe === trisCheck.trisReported;
      log('loaded: ' + JSON.stringify(loaded));
      log('tris check: ' + JSON.stringify(trisCheck));
      return finish(browser, errors, failedReqs, ok, { loaded, trisCheck });
    },
  },
  3: {
    name: 'shots：树 / 灯笼 / 行人近景 / 跟随 / 车内 5 张截图',
    run: async () => {
      const { browser, page, errors, failedReqs } = await launch();
      await boot(page, errors);
      await loadModules(page);
      await page.waitForTimeout(2000);
      // 树：S1 中段看过去
      await camTo(page, 500, -790, 1155.7, -994.9);
      await page.waitForTimeout(1500);
      await shot(page, 'surpass-3lane-trees.png');
      // 灯笼：星光里
      await camTo(page, 1250, -1010, 1390.3, -963.9);
      await page.waitForTimeout(1500);
      await shot(page, 'surpass-3lane-lanterns.png');
      // 行人近景：取第 1 个行人，从两个对角各拍一张（行人朝向不定，
      // 一张必能看到脸：验头发不盖眼、长发不秃顶）
      const ped = await page.evaluate(() => {
        const ps = window.__people.getPositions();
        return ps[0];
      });
      await camTo(page, ped.x + 2.2, ped.z + 2.2, ped.x, ped.z, -0.05);
      await page.waitForTimeout(800);
      await shot(page, 'surpass-3lane-ped-a.png');
      await camTo(page, ped.x - 2.2, ped.z - 2.2, ped.x, ped.z, -0.05);
      await page.waitForTimeout(800);
      await shot(page, 'surpass-3lane-ped-b.png');
      log('ped closeup at: ' + JSON.stringify(ped));
      // 开车跟随 + 车内
      await page.evaluate(() => document.querySelector('#mode-seg button[data-mode="drive"]').click());
      await page.waitForTimeout(1500);
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(2000);
      await page.keyboard.up('KeyW');
      await page.waitForTimeout(500);
      const speed1 = await page.evaluate(() => document.getElementById('drive-speed').textContent);
      log('drive speed after W 2s: ' + speed1);
      await shot(page, 'surpass-3lane-car-follow.png');
      await page.evaluate(() => document.getElementById('view-toggle').click());
      await page.waitForTimeout(1500);
      await shot(page, 'surpass-3lane-car-interior.png');
      return finish(browser, errors, failedReqs, true, { ped, speed1 });
    },
  },
  4: {
    name: 'white：白膜切换（街面/行人），夜里灯光收起、无报错',
    run: async () => {
      const { browser, page, errors, failedReqs } = await launch();
      await boot(page, errors);
      await loadModules(page);
      await page.waitForTimeout(1000);
      const r = await page.evaluate(() => {
        const { street, people } = window.__lane3;
        street.setDisplay('white');
        people.setDisplay('white');
        const glow = window.__street.group.getObjectByName('surpass-lamp-glow').material.opacity;
        street.setDisplay('normal');
        people.setDisplay('normal');
        return { glowWhite: glow };
      });
      const ok = r.glowWhite === 0;
      log('white mode: ' + JSON.stringify(r));
      return finish(browser, errors, failedReqs, ok, r);
    },
  },
  5: {
    name: 'report：汇总检查点，出 PASS/FAIL',
    run: async () => {
      const c = readCkpt();
      const done = [1, 2, 3, 4].map((n) => ({ step: n, ok: !!(c[n] && c[n].ok) }));
      const pass = done.every((d) => d.ok);
      log('steps: ' + JSON.stringify(done));
      log(pass ? 'LANE3 PASS' : 'LANE3 FAIL — 看上面哪步 ok:false，重跑那步：node tests/verify-3lane.js --only N --force');
      return { ok: pass, steps: done };
    },
  },
};

(async () => {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? Number(args[args.indexOf('--only') + 1]) : null;
  const from = args.includes('--from') ? Number(args[args.indexOf('--from') + 1]) : 1;
  const force = args.includes('--force');
  await ensureServer();
  const ckpt = readCkpt();
  let wanted = only ? [only] : [1, 2, 3, 4, 5].filter((n) => n >= from);
  let allOk = true;
  for (const n of wanted) {
    if (!force && ckpt[n] && ckpt[n].ok && n !== 5) { log(`step ${n} 已过（检查点），跳过；重跑加 --force`); continue; }
    log(`=== step ${n}: ${STEPS[n].name} ===`);
    const t0 = Date.now();
    try {
      const r = await STEPS[n].run();
      ckpt[n] = { ok: r.ok, ts: new Date().toISOString(), ms: Date.now() - t0, ...r };
      writeCkpt(ckpt);
      log(`step ${n}: ${r.ok ? 'OK' : 'FAIL'} (${Date.now() - t0}ms)`);
      if (!r.ok) { allOk = false; if (!only) break; }
    } catch (e) {
      ckpt[n] = { ok: false, ts: new Date().toISOString(), ms: Date.now() - t0, error: e.message };
      writeCkpt(ckpt);
      log(`step ${n}: CRASH ${e.message}`);
      allOk = false;
      break;
    }
  }
  if (wanted.includes(5) && allOk) {
    const r = await STEPS[5].run();
    ckpt[5] = { ok: r.ok, ts: new Date().toISOString(), ...r };
    writeCkpt(ckpt);
    allOk = r.ok;
  }
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error('runner crashed: ' + (e && e.message)); process.exit(2); });
