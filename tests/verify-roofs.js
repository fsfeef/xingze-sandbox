// verify-roofs.js — 1 路房顶截图验收（分段、可断点续跑）
// 用法（实例 dsw-foxdlkzn0y3rnnkded 上，库 clone 自 fsfeef/xingze-sandbox）：
//   cd <repo> && python3 -m http.server 8000 &   # 仓库根目录起静态服务（另开终端）
//   node tests/verify-roofs.js --stage=all        # 全跑；中途断了重跑同一条命令即续跑
//   node tests/verify-roofs.js --stage=boot       # 只跑一段：boot | roofs | shots
//   node tests/verify-roofs.js --stage=all --force  # 全重跑
// 环境变量：SANDBOX_URL（默认 http://localhost:8000/app/），
//   CHROMIUM_PATH（默认 /home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome）
// 断点续跑：tests/.roofs-verify-state.json 记录每段结果；重跑时已完成且产物齐全的
//   段直接跳过（--force 强制重跑）。每段自带超时上限，单段最长约 4 分钟；
//   三段连跑也远不到 1 小时——实例 1 小时无操作自动关机，段与段之间别晾着。
// 本脚本不改任何 app 文件：roofs.js 用动态 import 挂进真沙盘（接线前）；
//   接线完成后把 page.evaluate 里的 dynamic import 改成直接读 window.__roofs 即可。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = __dirname;
const STATE_FILE = path.join(OUT, '.roofs-verify-state.json');
const SANDBOX_URL = process.env.SANDBOX_URL || 'http://localhost:8000/app/';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome';
const args = process.argv.slice(2);
const stageArg = (args.find((a) => a.startsWith('--stage=')) || '--stage=all').slice(8);
const force = args.includes('--force');
const minChunks = parseInt((args.find((a) => a.startsWith('--min-chunks=')) || '--min-chunks=60').slice(13), 10);
// 断点续跑说明：.roofs-verify-state.json 只记每段的结果（给人和实例操作员看）；
//   是否跳过一段只看本进程内的标志（pageBooted/roofsDone/shotsDone）——
//   跨进程重跑必然是新页面，checkpoint 不能跳过导航（旧版这么写是 bug：
//   新页面空白时跳过 boot 会让 roofs 直接 init 一个不存在的 __sandbox）。
const log = (...a) => console.log(`[verify-roofs ${new Date().toISOString().slice(11, 19)}]`, ...a);

function loadPlaywright() {
  const tries = ['playwright-core',
    '/tmp/f-verify/node_modules/playwright-core',
    '/home/hatch/workspace/jiubei-playtest/driver/node_modules/playwright-core',
    '/home/hatch/workspace/.agent-scratch/pwtest/node_modules/playwright-core'];
  for (const t of tries) {
    try { return require(t); } catch (e) { /* next */ }
  }
  throw new Error('playwright-core not found; npm i playwright-core or set NODE_PATH');
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); }
function shot(page, name) {
  // 小机器上 SwiftShader 截图常 30s 抓不出：120s 超时 + 一次重试
  return page.screenshot({ path: path.join(OUT, name), timeout: 120000 }).catch(async (e) => {
    log('shot retry ' + name + ': ' + e.message.split('\n')[0]);
    await page.waitForTimeout(5000);
    return page.screenshot({ path: path.join(OUT, name), timeout: 120000 });
  });
}
function checkServer() {
  try {
    execSync(`curl -sf -o /dev/null --max-time 10 ${SANDBOX_URL}`, { stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}

async function launchBrowser() {
  const { chromium } = loadPlaywright();
  return chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
  });
}
// 注意：/tmp 曾被各路 playwright profile 塞到 98% 致浏览器起不来；跑本脚本前先清
//   /tmp/playwright_chromiumdev_profile-*（只清没在用的），或用 TMPDIR 指到别处跑。

let pageBooted = false, roofsDone = false, shotsDone = false;

async function stageBoot(page, state) {
  if (pageBooted && !force) { log('boot: skipped (this page already booted)'); return state.boot; }
  const errors = [];
  const failedReqs = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => failedReqs.push(r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.status() + ' ' + r.url()); });
  const t0 = Date.now();
  // 小机器上首航可能被残留 Chrome 抢占 CPU 而拖慢：120s 超时 + 一次重试
  let navigated = false;
  for (let attempt = 0; attempt < 2 && !navigated; attempt++) {
    try {
      await page.goto(SANDBOX_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      navigated = true;
    } catch (e) {
      log('goto attempt ' + (attempt + 1) + ' failed: ' + e.message.split('\n')[0]);
      if (attempt === 1) throw e;
      await page.waitForTimeout(5000);
    }
  }
  try {
    await page.waitForFunction(() => {
      const s = document.getElementById('start-overlay');
      const e = document.getElementById('error-overlay');
      return (s && s.style.display === 'flex') || (e && e.style.display === 'flex');
    }, undefined, { timeout: 240000 });
  } catch (e) { errors.push('timeout waiting for boot overlay'); }
  const boot = { ok: errors.length === 0, bootMs: Date.now() - t0, at: new Date().toISOString(), errors: errors.slice(0, 10), failedReqs: failedReqs.slice(0, 10) };
  // 诊断：哪个 overlay 在显示、enter 按钮在不在（verify-six.js 同款等待后直接点；
  // 本机小机器上曾出现 overlay 已现但按钮 30s 不可见，须先看清再点）
  const ov = await page.evaluate(() => {
    const g = (id) => { const e = document.getElementById(id); return e ? { display: e.style.display, visible: e.offsetParent !== null } : null; };
    const b = document.getElementById('enter-btn');
    return { start: g('start-overlay'), error: g('error-overlay'), errorText: (document.getElementById('error-text') || {}).textContent ? document.getElementById('error-text').textContent.slice(0, 300) : '', enterBtn: b ? { visible: b.offsetParent !== null, disabled: b.disabled } : null };
  });
  boot.overlay = ov;
  log('overlay: ' + JSON.stringify(ov));
  if (ov.error && ov.error.display === 'flex') throw new Error('boot error overlay: ' + ov.errorText);
  // 按钮是异步填进 overlay 的：overlay 现身不等于按钮已在，等它可见再点
  // （对照脚本曾在此卡 60s：overlay flex 了，#enter-btn 还没进 DOM）
  await page.waitForSelector('#enter-btn', { state: 'visible', timeout: 120000 });
  // DOM 直接点：Playwright 的 click 在小机器上曾卡在 performing click（页面有两个
  // #enter-btn，渲染忙）；按钮只是普通 click 监听，DOM 点等效
  await page.evaluate(() => { const b = document.getElementById('enter-btn'); if (b) b.click(); });
  await page.waitForTimeout(2000);
  // 等流式加载：小机器多人共用时 __sandboxStats 出现很慢，放宽到 240s；
  // 每 30s 记一次进度；__sandbox 已在但 stats 未出也算进得去（只记警告）
  let s0 = null, hasSandbox = false;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(2000);
    const r = await page.evaluate(() => ({ s: (window.__sandboxStats && window.__sandboxStats.six) || null, hasSandbox: !!window.__sandbox }));
    s0 = r.s; hasSandbox = r.hasSandbox;
    if (s0) break;
    if (i % 15 === 14) log('stream wait ' + ((i + 1) * 2) + 's: hasSandbox=' + hasSandbox + ' stats=null');
  }
  boot.stream = s0;
  boot.hasSandbox = hasSandbox;
  boot.ok = boot.ok && (!!s0 || hasSandbox);
  if (!s0) log('WARN: stream stats never appeared, but __sandbox present=' + hasSandbox + '; continuing');
  state.boot = boot; state._errors = errors; state._failedReqs = failedReqs;
  pageBooted = true;
  saveState(state);
  log('boot: ' + JSON.stringify(boot));
  if (!boot.ok) throw new Error('boot stage failed: ' + JSON.stringify(boot));
  return boot;
}

async function stageRoofs(page, state) {
  if (roofsDone && !force) { log('roofs: skipped (done in this process)'); return state.roofs; }
  const initRes = await page.evaluate(async () => {
    const m = await import('/app/roofs.js');
    const r = await m.init(window.__sandbox);
    return { ok: r && r.ok, hasRoofs: !!window.__roofs };
  });
  log('roofs init: ' + JSON.stringify(initRes));
  if (!initRes.ok) throw new Error('roofs init failed');
  let roofs = null, prevChunks = -1, stable = 0;
  for (let i = 0; i < 75; i++) {
    await page.waitForTimeout(2000);
    roofs = await page.evaluate(() => window.__roofs || null);
    if (roofs && roofs.chunksProcessed >= minChunks) break;
    // 处理完且 3 轮不再增长 = 流式已稳定，直接收（不等满 150s）
    if (roofs && roofs.chunksProcessed === prevChunks) { if (++stable >= 3) break; } else stable = 0;
    prevChunks = roofs ? roofs.chunksProcessed : -1;
  }
  const snap = roofs && { chunks: roofs.chunksProcessed, clusters: roofs.clusters, forms: roofs.roofForms, edges: roofs.parapetEdges, built: roofs.landmarksBuilt, skipped: roofs.landmarksSkipped, tower: roofs.towerRegistered, phase1: roofs.phase1Clusters, phase2: roofs.phase2Clusters, digest: roofs.digest };
  const res = { ok: !!roofs && roofs.chunksProcessed >= minChunks, at: new Date().toISOString(), snapshot: snap, landmarks: roofs ? roofs.landmarks : null };
  state.roofs = res;
  roofsDone = true;
  saveState(state);
  log('roofs: ' + JSON.stringify(snap));
  if (!res.ok) throw new Error('roofs stage failed: chunksProcessed < ' + minChunks + ' ' + JSON.stringify(snap));
  return res;
}

async function waitRoofsSettle(page, maxSec, tag) {
  // 飞过去会流进新块，处理（2 块/900ms）要跟上：等 chunksProcessed 连续 3 轮不变再拍，
  // 否则近景拍到的是还没着色的白顶（第 8 轮 shot 02 就是这么白的）
  let prev = -1, stable = 0;
  for (let i = 0; i < maxSec / 2; i++) {
    await page.waitForTimeout(2000);
    const r = await page.evaluate(() => window.__roofs || null);
    const c = r ? r.chunksProcessed : -1;
    if (c === prev) { if (++stable >= 3) { log(tag + ' settled at ' + c + ' chunks'); return; } } else stable = 0;
    prev = c;
  }
  log(tag + ' settle timeout, chunks=' + prev);
}

async function stageShots(page, state) {
  const done = roofsDone && shotsDone && !force;
  if (done) { log('shots: skipped (done ' + state.shots.at + ')'); return state.shots; }
  await page.waitForTimeout(3000);
  await shot(page, 'surpass-roofs-01-day-aerial.png');
  log('shot 01 day aerial');
  // 地标飞行是“最好有”：列表是异步填的（曾出现过 click 时容器还是 null），
  // 等不到就记警告跳过近景，夜景验收（shot 04/05）不受影响，继续跑
  let lm = 'skipped:no-list';
  try {
    await page.waitForFunction(() => document.querySelectorAll('#list-landmarks button').length > 0, undefined, { timeout: 120000 });
    lm = await page.evaluate(() => {
      const box = document.getElementById('list-landmarks');
      const btns = box ? [...box.querySelectorAll('button')] : [...document.querySelectorAll('button')];
      const t = btns.find((b) => b.textContent.includes('武侯祠')) || btns[0];
      if (!t) return 'no-item';
      const name = t.textContent.trim().slice(0, 40);
      t.click();
      return 'clicked:' + name;
    });
    log('landmark: ' + lm);
    await waitRoofsSettle(page, 60, 'landmark');
    await shot(page, 'surpass-roofs-02-landmark-close.png');
    log('shot 02 landmark close');
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(400); }
    await waitRoofsSettle(page, 40, 'zoomed');
    await shot(page, 'surpass-roofs-03-landmark-zoomed.png');
    log('shot 03 landmark zoomed');
  } catch (e) {
    log('WARN landmark flight skipped: ' + e.message.split('\n')[0] + ' (lm=' + lm + ')');
  }
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '22'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(3000);
  await shot(page, 'surpass-roofs-04-night.png');
  log('shot 04 night');
  // 夜景重做验收（14:41 令）：夜里 22:00 鸟瞰——镜头拉回高空，看屋顶霓虹是否成片、楼顶是否黑成一片
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(400); }
  await waitRoofsSettle(page, 40, 'night-aerial');
  await shot(page, 'surpass-roofs-05-night-aerial.png');
  log('shot 05 night aerial');
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '10'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1500);
  const roofs = await page.evaluate(() => window.__roofs || null);
  const res = { ok: true, at: new Date().toISOString(), landmark: lm, files: ['surpass-roofs-01-day-aerial.png', 'surpass-roofs-02-landmark-close.png', 'surpass-roofs-03-landmark-zoomed.png', 'surpass-roofs-04-night.png', 'surpass-roofs-05-night-aerial.png'], roofsFinal: roofs && { chunks: roofs.chunksProcessed, clusters: roofs.clusters, forms: roofs.roofForms, edges: roofs.parapetEdges, built: roofs.landmarksBuilt } };
  state.shots = res;
  shotsDone = true;
  saveState(state);
  log('shots: ' + JSON.stringify(res));
  return res;
}

(async () => {
  if (!checkServer()) {
    console.error(`SANDBOX_URL unreachable: ${SANDBOX_URL}\nStart it first (repo root, another terminal):\n  cd ${ROOT} && python3 -m http.server 8000`);
    process.exit(2);
  }
  const state = loadState();
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    // 单跑某段时自动补齐前置段（shots 须先有 roofs，roofs 须先有 boot）
    const run = stageArg === 'all' ? ['boot', 'roofs', 'shots']
      : stageArg === 'shots' ? ['boot', 'roofs', 'shots']
      : stageArg === 'roofs' ? ['boot', 'roofs']
      : [stageArg];
    if (!['boot', 'roofs', 'shots', 'all'].includes(stageArg)) throw new Error('unknown --stage=' + stageArg);
    if (run.includes('boot')) await stageBoot(page, state);
    if (run.includes('roofs')) await stageRoofs(page, state);
    if (run.includes('shots')) await stageShots(page, state);
    log('ERRORS(' + (state._errors || []).length + '): ' + JSON.stringify((state._errors || []).slice(0, 10)));
    log('FAILED REQUESTS(' + (state._failedReqs || []).length + '): ' + JSON.stringify((state._failedReqs || []).slice(0, 10)));
    log('DONE stage=' + stageArg);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
