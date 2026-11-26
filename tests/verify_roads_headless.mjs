// Headless verification for roads.js — runs ON THE 8-CORE INSTANCE (not the small VM).
// Steps (each skippable/resumable via --step and the state file):
//   static : node --check + /tmp/verify_roads.mjs (counts, names, bridge math, landmarks, pools)
//   load   : serve repo, open /app/, collect console/pageerror/failed-requests,
//            dynamic-import roads.js, init(window.__sandbox), assert stats + render info
//   night  : 22:00 via #time-slider + Roads.setNight(1); aerial + 2 street screenshots;
//            in-page brightness analysis of each screenshot (roads must be visible, not black)
// Usage:
//   node verify_roads_headless.mjs [--repo PATH] [--port 8123] [--step static|load|night|all]
//   [--state /tmp/roads_headless_state.json]
// Copy /tmp/verify_roads.mjs to the instance first. Playwright + chromium required
// (npm i playwright && npx playwright install chromium). Each step < 10 min;
// if the instance auto-shuts down (>1h idle), rerun with the same --state to resume.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const REPO = opt('--repo', '/home/hatch/workspace/virtual-city');
const PORT = +opt('--port', '8123');
const STEP = opt('--step', 'all');
const STATE = opt('--state', '/tmp/roads_headless_state.json');

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const done = (s) => { state[s] = { ok: true, at: new Date().toISOString() }; saveState(); };
const failed = [];
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failed.push(msg); };

// ---------- static ----------
function runStatic() {
  if (state.static?.ok && STEP !== 'static') { console.log('static: skipped (done)'); return; }
  console.log('== step static ==');
  const c1 = spawnSync('node', ['--check', path.join(REPO, 'app/roads.js')], { encoding: 'utf8' });
  check(c1.status === 0, 'node --check roads.js');
  const c2 = spawnSync('node', ['/tmp/verify_roads.mjs'], { encoding: 'utf8' });
  process.stdout.write(c2.stdout || '');
  if (c2.stderr) process.stdout.write(c2.stderr);
  check(c2.status === 0, 'verify_roads.mjs all static checks');
  if (!failed.length) done('static');
}

// ---------- static server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      const fp = path.join(REPO, p === '/' ? 'app/index.html' : p);
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); res.end('nf'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(PORT, '127.0.0.1', () => { console.log('serving', REPO, 'on', PORT); resolve(srv); });
  });
}

// ---------- brightness analysis (in page, dependency-free) ----------
async function brightness(page, buf) {
  const b64 = buf.toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    let bright = 0, sum = 0, warm = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l;
      if (l > 40) bright++;
      if (d[i] > 150 && d[i + 1] > 120 && d[i + 2] < 120) warm++;
    }
    return { w: img.width, h: img.height, meanLum: +(sum / n).toFixed(1), brightFrac: +(bright / n).toFixed(4), warmFrac: +(warm / n).toFixed(4) };
  }, b64);
}

async function runBrowser(onlyNight) {
  let pw;
  try { pw = await import('playwright'); } catch (e) {
    console.error('FAIL playwright not installed: npm i playwright && npx playwright install chromium');
    failed.push('playwright missing');
    return;
  }
  const { chromium } = pw;
  const srv = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const failedReqs = [], pageErrs = [], consoleErrs = [];
  page.on('requestfailed', (r) => failedReqs.push(r.url() + ' :: ' + (r.failure()?.errorText || '')));
  page.on('pageerror', (e) => pageErrs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
  try {
    console.log('== step load ==');
    await page.goto(`http://127.0.0.1:${PORT}/app/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__sandboxStarted === true, null, { timeout: 240000 });
    console.log('sandbox started');
    // init roads.js against the live sandbox
    const initRes = await page.evaluate(async () => {
      const m = await import('./roads.js');
      const api = await m.init(window.__sandbox);
      await new Promise((r) => setTimeout(r, 3000));
      const info = window.__sandbox.renderer.info.render;
      return { stats: api ? api.stats : null, calls: info.calls, triangles: info.triangles, groupVisible: api ? api.group.visible : null, hasSetNight: typeof m.setNight === 'function' };
    });
    console.log('roads init:', JSON.stringify(initRes));
    check(!!initRes.stats, 'roads.init returned api');
    check(initRes.stats?.arterials === 2700, `stats arterials 2700 (got ${initRes.stats?.arterials})`);
    check(initRes.stats?.junctions === 14, `stats junctions 14 (got ${initRes.stats?.junctions})`);
    check(initRes.stats?.pools === 37677, `stats pools 37677 (got ${initRes.stats?.pools})`);
    check((initRes.stats?.railKm || 0) > 100, `stats railKm > 100km (got ${initRes.stats?.railKm})`);
    check(initRes.stats?.platforms === 13, `stats platforms 13 (got ${initRes.stats?.platforms})`);
    check(initRes.hasSetNight, 'setNight exported');
    check(initRes.calls > 0 && initRes.triangles > 0, `render calls ${initRes.calls} triangles ${initRes.triangles}`);
    if (!onlyNight) done('load');

    if (STEP === 'all' || STEP === 'night') {
      if (state.night?.ok && STEP !== 'night') { console.log('night: skipped (done)'); return; }
      console.log('== step night (22:00) ==');
      // day aerial first (comparison)
      await setTime(page, 10);
      await setNight(page, 0);
      await setCam(page, { mode: 'aerial', tx: 0, tz: 0, dist: 12000, el: 1.35, yaw: 0 });
      const dayShot = await page.screenshot({ path: path.join(REPO, 'tests/roads-day-aerial.png') });
      const dayB = await brightness(page, dayShot);
      console.log('day aerial brightness:', JSON.stringify(dayB));
      // night 22:00
      await setTime(page, 22);
      await setNight(page, 1);
      await setCam(page, { mode: 'aerial', tx: 0, tz: 0, dist: 12000, el: 1.35, yaw: 0 });
      const nightShot = await page.screenshot({ path: path.join(REPO, 'tests/roads-night-aerial.png') });
      const nightB = await brightness(page, nightShot);
      console.log('night aerial brightness:', JSON.stringify(nightB));
      check(nightB.brightFrac >= 0.005, `night aerial roads visible (brightFrac ${nightB.brightFrac} >= 0.005)`);
      check(nightB.warmFrac > 0, `night aerial has warm light pools (warmFrac ${nightB.warmFrac})`);
      // street: ring-1 main road (环星大道 near (400, 1713))
      await setCam(page, { mode: 'walk', px: 400, py: 8, pz: 1713, yaw: 0.1, pitch: -0.05 });
      const s1 = await page.screenshot({ path: path.join(REPO, 'tests/roads-night-street-ring1.png') });
      const s1B = await brightness(page, s1);
      console.log('night street ring-1 brightness:', JSON.stringify(s1B));
      check(s1B.brightFrac >= 0.02, `night street ring-1 roads visible (brightFrac ${s1B.brightFrac} >= 0.02)`);
      // street: outer main road near 星泽东站 (7137, -3752)
      await setCam(page, { mode: 'walk', px: 7137, py: 8, pz: -3752, yaw: 2.6, pitch: -0.05 });
      const s2 = await page.screenshot({ path: path.join(REPO, 'tests/roads-night-street-east.png') });
      const s2B = await brightness(page, s2);
      console.log('night street east brightness:', JSON.stringify(s2B));
      check(s2B.brightFrac >= 0.02, `night street east roads visible (brightFrac ${s2B.brightFrac} >= 0.02)`);
      if (!failed.length) done('night');
    }
    // request accounting (chunk failures are the coordinator's loading job, reported separately)
    const chunkFails = failedReqs.filter((u) => u.includes('/chunks/') || u.includes('terrain') || u.includes('six-districts'));
    const otherFails = failedReqs.filter((u) => !chunkFails.includes(u));
    console.log(`failed requests: total ${failedReqs.length} (non-chunk ${otherFails.length}, chunk/terrain ${chunkFails.length})`);
    for (const u of otherFails.slice(0, 10)) console.log('  FAIL-REQ', u);
    for (const u of chunkFails.slice(0, 10)) console.log('  CHUNK-FAIL (coordinator loading)', u);
    check(otherFails.length === 0, `0 non-chunk failed requests (got ${otherFails.length})`);
    check(pageErrs.length === 0, `0 pageerrors (got ${pageErrs.length}: ${pageErrs.slice(0, 3).join(' | ')})`);
    console.log('console errors:', consoleErrs.length, consoleErrs.slice(0, 3));
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
}

async function setTime(page, h) {
  await page.evaluate((h) => {
    const s = document.querySelector('#time-slider');
    if (s) { s.value = String(h); s.dispatchEvent(new Event('input', { bubbles: true })); }
  }, h);
  await page.waitForTimeout(1200);
}
async function setNight(page, v) {
  await page.evaluate((v) => { if (window.__roads) window.__roads.setNight(v); }, v);
  await page.waitForTimeout(800);
}
async function setCam(page, c) {
  await page.evaluate((c) => {
    const st = window.__sandbox.state;
    st.mode = c.mode;
    if (c.mode === 'aerial') {
      st.target.set(c.tx, 0, c.tz); st.dist = c.dist; st.el = c.el; st.yaw = c.yaw;
    } else {
      st.pos.set(c.px, c.py, c.pz); st.lookYaw = c.yaw; st.lookPitch = c.pitch;
    }
  }, c);
  await page.waitForTimeout(2000);
}

if (STEP === 'static' || STEP === 'all') runStatic();
if (STEP === 'load' || STEP === 'night' || STEP === 'all') {
  await runBrowser(STEP === 'night');
}
console.log(failed.length ? `\n${failed.length} FAILURES: ${failed.join('; ')}` : '\nHEADLESS CHECKS PASS');
process.exit(failed.length ? 1 : 0);
