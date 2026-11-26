// 加载全量核查 + 修复验证 — 虚拟城市沙盘 6 路（加载核查）
// 跑：cd ~/workspace/virtual-city && NODE_PATH=/tmp/f-verify/node_modules node tests/load-audit-2026-11-26.js
// 要求：http://localhost:8000 正在服务 ~/workspace/virtual-city（不在就自己起一个）
// 验收：六区包每一块、每一层都能加载出来；six-loader 相关失败请求数必须是 0。
//   非 six-loader 的失败（如 maps.js 取 six-names.json 线上 404）单独列出，不计入本路验收，
//   但会写进报告给总协调。
// 做法：
//   Phase 0（Node 直连）：索引里的每一个文件都 GET 一遍——状态码 + GLB 魔数 + 长度对账。
//   Phase 1（浏览器）：启动沙盘，途中故意断一次远山瓦片 + 一次 mid 块（各 abort 一次），
//     看加载器能不能自己重试恢复；收 console 错误 / pageerror / 失败请求。
//   Phase 2（浏览器）：飞遍全城 13 个点（6 区中心 + 98_93 + 339 塔 + 4 个边角 + 中心），
//     每点等流式加载稳定、失败数为 0，截图 load-* 留证。
//   Phase 3（浏览器内）：用页面自己的 GLTFLoader + MeshoptDecoder 把包里全部 6,424 个 GLB
//     逐个解码一遍（不经过 six-loader 的队列），证明每个文件在真实解码器里都能打开。
// 退出码：six-loader 相关失败（失败请求 / console 错误 / 收尾 failedLive>0 / 解码失败）>0 则 exit 1。
const { chromium } = require('playwright-core');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = '/home/hatch/workspace/virtual-city';
const OUT = path.join(ROOT, 'tests');
const BASE = 'http://localhost:8000';
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome';
const PKG = 'white-model-six-districts';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// 只读前 12 字节验 GLB 魔数 + 长度字段，同时对 Content-Length；不下载整个文件。
function probeFile(url, expectBytes, farIndexBytes) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { Connection: 'keep-alive' } }, (res) => {
      const status = res.statusCode;
      const len = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
      let head = Buffer.alloc(0);
      let done = false;
      const finish = (r) => { if (!done) { done = true; try { res.destroy(); } catch (e) {} resolve(r); } };
      res.on('data', (c) => {
        if (head.length < 12) head = Buffer.concat([head, c]).slice(0, 12);
        if (head.length >= 12) {
          const magic = head.readUInt32LE(0);
          const glbLen = head.readUInt32LE(8);
          finish({ url, status, len, magicOk: magic === 0x46546c67, glbLen, expectBytes, farIndexBytes: !!farIndexBytes });
        }
      });
      res.on('end', () => finish({ url, status, len, magicOk: head.length >= 12 && head.readUInt32LE(0) === 0x46546c67, glbLen: head.length >= 12 ? head.readUInt32LE(8) : null, expectBytes, farIndexBytes: !!farIndexBytes }));
      res.on('error', (e) => finish({ url, status, len, error: e.message, farIndexBytes: !!farIndexBytes }));
    });
    req.on('error', (e) => resolve({ url, status: 0, error: e.message, farIndexBytes: !!farIndexBytes }));
    req.setTimeout(15000, () => { try { req.destroy(); } catch (e) {} resolve({ url, status: 0, error: 'timeout', farIndexBytes: !!farIndexBytes }); });
  });
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function ensureServer() {
  try {
    const r = await probeFile(`${BASE}/app/`, null);
    if (r.status === 200) { log('server 8000 already up'); return null; }
  } catch (e) {}
  log('starting local server on 8000');
  const p = spawn('python3', ['-m', 'http.server', '8000'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  p.unref();
  for (let k = 0; k < 20; k++) {
    await sleep(500);
    try { const r = await probeFile(`${BASE}/app/`, null); if (r.status === 200) return p; } catch (e) {}
  }
  throw new Error('local server did not come up on 8000');
}

(async () => {
  const serverProc = await ensureServer();
  const report = { phase0: {}, phase1: {}, phase2: [], phase3: {}, gate: {} };
  const sixFailures = []; // 计入 6 路验收的失败
  const otherFailures = []; // 非 six-loader 的失败（单独列，不计入本路）

  // ---------- Phase 0：全量文件直连核查 ----------
  log('Phase 0: full-file HTTP audit');
  const mani = await getJSON(`${BASE}/${PKG}/chunks/index/manifest.json`);
  const rows = mani.rows || [];
  const shardMaps = {};
  const recs = {};
  for (const cz of rows) {
    const d = await getJSON(`${BASE}/${PKG}/chunks/index/shard_${cz}.json`);
    shardMaps[cz] = d.chunks || d;
    Object.assign(recs, shardMaps[cz]);
  }
  const terrainIdx = (await getJSON(`${BASE}/${PKG}/terrain/index.json`)).terrain || {};
  const farIdx = (await getJSON(`${BASE}/${PKG}/terrain/far/index.json`)).terrain_far || {};
  const sixIndex = await getJSON(`${BASE}/data/six-index.json`);
  const keys = Object.keys(recs);
  log(`index: chunks=${keys.length} rows=${rows.length} terrain=${Object.keys(terrainIdx).length} far=${Object.keys(farIdx).length}`);

  const jobs = [];
  for (const k of keys) {
    const r = recs[k];
    if (r.bytes_high > 0) jobs.push({ url: `${BASE}/${PKG}/chunks/${k}_high.glb`, expectBytes: r.bytes_high, kind: 'chunk-high' });
    if (r.bytes_mid > 0 && r.sha256_mid) jobs.push({ url: `${BASE}/${PKG}/chunks/${k}_mid.glb`, expectBytes: r.bytes_mid, kind: 'chunk-mid' });
  }
  for (const k of Object.keys(terrainIdx)) jobs.push({ url: `${BASE}/${PKG}/terrain/${k}.glb`, expectBytes: terrainIdx[k].bytes, kind: 'terrain' });
  for (const k of Object.keys(farIdx)) jobs.push({ url: `${BASE}/${PKG}/terrain/far/${k}.glb`, expectBytes: farIdx[k].bytes, kind: 'far', farIndexBytes: true });
  jobs.push({ url: `${BASE}/${PKG}/fabric.glb`, expectBytes: null, kind: 'fabric' });
  const zeroChunks = keys.filter((k) => recs[k].bytes_high === 0 && recs[k].bytes_mid === 0);
  const noMid = keys.filter((k) => !(recs[k].bytes_mid > 0 && recs[k].sha256_mid) && !(recs[k].bytes_high === 0 && recs[k].bytes_mid === 0));
  log(`probe files: ${jobs.length} (zero-byte chunks skipped: ${zeroChunks.join(',')}; no-mid non-empty: ${noMid.length})`);
  const results = await mapPool(jobs, 16, (j) => probeFile(j.url, j.expectBytes, j.farIndexBytes));
  const badStatus = results.filter((r) => r.status !== 200);
  const badMagic = results.filter((r) => r.status === 200 && r.magicOk === false);
  const sizeMismatch = results.filter((r) => r.status === 200 && r.expectBytes && r.len !== null && r.len !== r.expectBytes && !r.farIndexBytes);
  const farSizeMismatch = results.filter((r) => r.status === 200 && r.farIndexBytes && r.len !== null && r.len !== r.expectBytes);
  const glbLenMismatch = results.filter((r) => r.status === 200 && r.glbLen !== null && r.len !== null && r.glbLen !== r.len);
  report.phase0 = {
    filesProbed: jobs.length, chunks: keys.length, zeroByteChunks: zeroChunks,
    noMidNonEmpty: noMid.length, badStatus: badStatus.map((r) => `${r.status} ${r.url} ${r.error || ''}`),
    badMagic: badMagic.map((r) => r.url), sizeMismatch: sizeMismatch.map((r) => `${r.url} index=${r.expectBytes} disk=${r.len}`),
    farIndexBytesStale: farSizeMismatch.length, glbLenMismatch: glbLenMismatch.map((r) => r.url),
  };
  log(`Phase 0: probed=${jobs.length} badStatus=${badStatus.length} badMagic=${badMagic.length} sizeMismatch=${sizeMismatch.length} farIndexBytesStale=${farSizeMismatch.length} glbLenMismatch=${glbLenMismatch.length}`);
  for (const r of badStatus) sixFailures.push('phase0 status: ' + r.status + ' ' + r.url);
  for (const r of badMagic) sixFailures.push('phase0 bad GLB magic: ' + r.url);
  for (const r of sizeMismatch) sixFailures.push('phase0 size mismatch: ' + r.url);

  // 断点目标：离中心最近的远山瓦片 + 中环（1800–3500m）里一个有 mid 的块
  const farSorted = Object.entries(farIdx).map(([k, t]) => ({ k, d: Math.hypot(t.tx * 3960 + 1980, t.tz * 3960 + 1980) })).sort((a, b) => a.d - b.d);
  const farTarget = farSorted[0].k;
  let midTarget = null;
  for (const k of keys) {
    const r = recs[k];
    if (!(r.bytes_mid > 0 && r.sha256_mid)) continue;
    const d = Math.hypot(r.x0 + 250, r.z0 + 250);
    if (d > 1800 && d < 3500) { midTarget = k; break; }
  }
  log(`fault-injection targets: far=${farTarget} (nearest, ${Math.round(farSorted[0].d)}m) mid=${midTarget}`);

  // ---------- Phase 1+2：浏览器 ----------
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  const injectedFailures = []; // 故意断的那几次（断点目标）：记下来单独列，不计入验收失败数
  // 目录断点：远山 index（loadCatalog 三个目录之一），供站级重试验证用
  const catalogTarget = 'terrain/far/index.json';
  const isInjected = (u) => u.includes(farTarget) || (midTarget && u.includes(midTarget)) || u.includes(catalogTarget);
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 300)));
  page.on('requestfailed', (r) => {
    const u = r.url();
    const entry = 'requestfailed ' + u + ' ' + ((r.failure() || {}).errorText || '');
    if (isInjected(u)) injectedFailures.push(entry);
    else if (u.includes('white-model-six-districts') || u.includes('six-index.json')) sixFailures.push(entry); else otherFailures.push(entry);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) {
      const u = r.url();
      const entry = r.status() + ' ' + u;
      if (isInjected(u)) injectedFailures.push(entry);
      else if (u.includes('white-model-six-districts') || u.includes('six-index.json')) sixFailures.push(entry); else otherFailures.push(entry);
    }
  });
  // 故障注入：各 abort 一次，之后放行，看重试能不能恢复
  const abortOnce = new Map();
  const setupAbort = async (substr) => {
    await page.route(`**/${substr}`, async (route) => {
      if (!abortOnce.get(substr)) { abortOnce.set(substr, Date.now()); await route.abort('failed'); }
      else await route.continue();
    });
  };
  await setupAbort(`terrain/far/${farTarget}.glb`);
  if (midTarget) await setupAbort(`chunks/${midTarget}_mid.glb`);
  // 目录断点：远山 index 连断 3 次——正好耗尽 _fetchJSON 的 3 次重试，第一次 loadCatalog
  // 必然失败，触发站级重试（2s 后整站再跑一次）；第 4 次请求放行，站级重试应成功。
  // 这样同时验了两层：单址重试 3 次不够时，站级重试兜底（线上 15:02 CDN 边缘不一致的场景）。
  let catalogAborts = 0;
  await page.route(`**/${catalogTarget}`, async (route) => {
    if (catalogAborts < 3) { catalogAborts++; await route.abort('failed'); }
    else await route.continue();
  });

  const getSix = () => page.evaluate(() => (window.__sandboxStats && window.__sandboxStats.six) || null);
  // 故障目标的请求时间线（重试到底发没发、多久恢复，写进报告）
  const faultTimeline = [];
  const stampFault = (kind, url) => faultTimeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${kind} ${url}`);
  const isFaultUrl = (u) => u.includes(farTarget) || (midTarget && u.includes(midTarget)) || u.includes(catalogTarget);
  page.on('request', (r) => { if (isFaultUrl(r.url())) stampFault('REQ', r.url()); });
  page.on('response', (r) => { if (isFaultUrl(r.url())) stampFault('RESP ' + r.status(), r.url()); });
  page.on('requestfailed', (r) => { if (isFaultUrl(r.url())) stampFault('REQFAIL', r.url()); });
  const faultT0 = Date.now();
  const t0 = Date.now();
  await page.goto(`${BASE}/app/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForFunction(() => {
      const s = document.getElementById('start-overlay');
      const e = document.getElementById('error-overlay');
      return (s && s.style.display === 'flex') || (e && e.style.display === 'flex');
    }, { timeout: 240000 });
  } catch (e) { sixFailures.push('boot timeout: no overlay in 240s'); }
  const bootMs = Date.now() - t0;
  const bootState = await page.evaluate(() => ({
    start: document.getElementById('start-overlay').style.display,
    error: document.getElementById('error-overlay').style.display,
    errorText: document.getElementById('error-text').textContent.slice(0, 200),
  }));
  log('boot: ' + JSON.stringify({ bootMs, ...bootState }));
  if (bootState.start !== 'flex') sixFailures.push('boot failed: start overlay not shown; error=' + bootState.errorText);
  // 注意：index.html 里 #enter-btn 有两个（开始页 + 错误页重名 id），不要用 page.click('#enter-btn')，
  // 主线程忙时 actionability 等待会超时；直接点开始页里的那个。
  await page.evaluate(() => document.querySelector('#start-overlay #enter-btn').click());
  await page.waitForTimeout(1500);

  const settle = async (label, timeoutMs = 90000) => {
    // 稳定 = 计数签名不变 + 窗口内无新增失败 + 按当前目标逐项对数无缺块；
    // 只看“计数不变”不够：SwiftShader 下统计会滞后一站，旧地方的数能原样顶过两轮 polling。
    let prev = null; let prevFailed = null; let stable = 0; let last = null; let lastDiag = null; const tStart = Date.now();
    while (Date.now() - tStart < timeoutMs) {
      await page.waitForTimeout(3000);
      const s = await getSix();
      if (!s) continue;
      last = s;
      const sig = `${s.chunksHigh}/${s.chunksMid}/${s.terrainTiles}/${s.farTiles}`;
      const noNewFail = (s.failedLive === undefined) ? (prevFailed === null || s.filesFailed === prevFailed) : (s.failedLive === 0);
      if (sig === prev && noNewFail) {
        stable++;
        if (stable >= 2) {
          lastDiag = await diagnose();
          const diagClean = lastDiag.missingFar.length === 0 && lastDiag.missingTerrain.length === 0
            && lastDiag.missingChunkCount === 0 && lastDiag.failedChunks.length === 0
            && (lastDiag.failedLive === null || lastDiag.failedLive === 0);
          if (diagClean) break;
          log(`settle ${label}: signature stable but diagnose not clean: ` + JSON.stringify(lastDiag));
          stable = 0;
        }
      } else stable = 0;
      prev = sig; prevFailed = s.filesFailed;
    }
    const clean = lastDiag ? (lastDiag.missingFar.length === 0 && lastDiag.missingTerrain.length === 0
      && lastDiag.missingChunkCount === 0 && lastDiag.failedChunks.length === 0
      && (lastDiag.failedLive === null || lastDiag.failedLive === 0)) : false;
    log(`settle ${label}: ${Math.round((Date.now() - tStart) / 1000)}s stable=${stable >= 2} clean=${clean} stats=${JSON.stringify(last)}`);
    return { label, ms: Date.now() - tStart, clean, stable: stable >= 2, stats: last, diag: lastDiag };
  };

  // 逐项对缺块：期望的地形/远山瓦片 vs 实际已加载；失败中的块/瓦片；加载中标记残留
  const diagnose = () => page.evaluate(() => {
    const L = window.__sandbox.sixLoader;
    const view = window.__sandbox.state;
    const tx = view.target.x, tz = view.target.z;
    const cands = [];
    for (const [key, t] of Object.entries(L.farIndex || {})) {
      const cx = t.tx * 3960 + 1980, cz = t.tz * 3960 + 1980;
      const d = Math.hypot(cx - tx, cz - tz);
      if (d < 120000) cands.push({ key, d });
    }
    cands.sort((a, b) => a.d - b.d);
    const wantFar = cands.slice(0, 96).map((c) => c.key);
    const missingFar = wantFar.filter((k) => !L.far.has(k));
    const wantTerrain = [];
    for (const [key, t] of Object.entries(L.terrainIndex || {})) {
      const cx = t.tx * 2000 + 990, cz = t.tz * 2000 + 990;
      if (Math.hypot(cx - tx, cz - tz) < 6000) wantTerrain.push(key);
    }
    const missingTerrain = wantTerrain.filter((k) => !L.terrain.has(k));
    const failedChunks = [...L.chunks.entries()]
      .filter(([, e]) => {
        // 只算当前视角下该要的那档缺失：近处缺 high、远处缺 mid；high 在位时 mid 缺失不算缺块
        const d = e._camDist !== undefined ? e._camDist : 0;
        if (d < 1800) return e.failHighAt && !e.high;
        return e.failMidAt && !e.mid && e.rec.bytes_mid > 0 && e.rec.sha256_mid;
      })
      .map(([k, e]) => ({ k, retries: e.retries, high: !!e.high, mid: !!e.mid }));
    // 按当前目标逐项对数：索引里该有的块 vs 实际在位（任一档在位即算有）——
    // SwiftShader 下统计会滞后一站，只看“计数不变”会把旧地方的数当成新地方的过关
    let wantHigh = 0, wantMid = 0;
    const missingChunks = [];
    for (const sm of L.shards.values()) {
      if (!sm || typeof sm !== 'object' || sm instanceof Promise) continue;
      for (const [key, rec] of Object.entries(sm)) {
        if (!rec || (rec.bytes_high === 0 && rec.bytes_mid === 0)) continue;
        const d = Math.hypot(rec.x0 + 250 - tx, rec.z0 + 250 - tz);
        const e = L.chunks.get(key);
        const has = !!(e && (e.high || e.mid));
        if (d < 1800 && rec.bytes_high > 0) { wantHigh++; if (!has) missingChunks.push(key + ':high'); }
        else if (d >= 1800 && d < 3500 && rec.bytes_mid > 0 && rec.sha256_mid) { wantMid++; if (!has) missingChunks.push(key + ':mid'); }
      }
    }
    const failedLive = (L.statsSnapshot && L.statsSnapshot().failedLive !== undefined)
      ? L.statsSnapshot().failedLive : null;
    return {
      wantFar: wantFar.length, missingFar,
      wantTerrain: wantTerrain.length, missingTerrain,
      wantHigh, wantMid, missingChunks: missingChunks.slice(0, 20), missingChunkCount: missingChunks.length,
      failedTiles: [...L._failedTiles.entries()].map(([k, v]) => ({ k, retryInSec: Math.max(0, Math.round((v - performance.now()) / 1000)) })),
      failedChunks, failedLive,
      loadingMarkers: [...L.far.keys(), ...L.terrain.keys()].filter((k) => k.endsWith(':loading')),
    };
  });
  const shot = (name) => page.screenshot({ path: path.join(OUT, name), timeout: 120000 });

  const center = await settle('center', 120000);
  const centerDiag = center.diag || await diagnose();
  log('diagnose center: ' + JSON.stringify(centerDiag));
  const centerClean = center.clean;
  report.phase1 = { bootMs, bootState, centerSettle: center, centerDiag, centerClean, consoleErrors: consoleErrors.slice(0, 20) };
  if (!centerClean) sixFailures.push('center not clean: ' + JSON.stringify({ stats: center.stats, diag: centerDiag }));
  // 故障恢复耗时：从 abort 到 failedLive 回 0（若字段不存在，用 filesFailed 不再增长近似）
  const faultRecovered = abortOnce.size > 0 && centerClean;
  report.phase1.faultInjection = { targets: { far: farTarget, mid: midTarget }, aborted: [...abortOnce.keys()], recoveredByCenterSettle: faultRecovered };
  // 目录站级重试：第一次 loadCatalog 必须失败过一次（_catalogAttempts>=2），且启动成功
  const catalogAttempts = await page.evaluate(() => (window.__sandbox.sixLoader && window.__sandbox.sixLoader._catalogAttempts) || null);
  const catalogRetryOk = catalogAborts === 3 && catalogAttempts >= 2 && bootState.start === 'flex';
  report.phase1.catalogRetry = { catalogAborts, catalogAttempts, ok: catalogRetryOk };
  log(`catalogRetry: aborted=${catalogAborts} attempts=${catalogAttempts} ok=${catalogRetryOk}`);
  if (!catalogRetryOk) sixFailures.push(`catalog site-retry not proven: aborted=${catalogAborts} attempts=${catalogAttempts} bootStart=${bootState.start}`);

  // ---------- Phase 2：飞遍全城 ----------
  const dists = sixIndex.districts || [];
  const waypoints = [
    { name: 'center', x: 0, z: 0 },
    ...dists.map((d) => ({ name: 'district-' + d.name, x: d.center[0], z: d.center[1] })),
    { name: 'chunk-98_93-empty', x: -10750, z: -4250 },
    { name: 'tower-339', x: 2492.5, z: -179.1 },
    // 边缘点必须在六区裁剪范围内才有块：包围盒四角（±14000，±16000）在区外，本来就是 0 块，
    // 拿它们当“加载失败”判是错的；只留 NE 角当区外负对照（期望就是 0 块、0 失败、不发 404）
    { name: 'edge-W', x: -12000, z: 0 },
    { name: 'edge-N', x: 0, z: -15000 },
    { name: 'edge-E', x: 12000, z: 0 },
    { name: 'edge-S', x: 0, z: 13000 },
    { name: 'outside-NE-control', x: 14000, z: -16000, expectEmpty: true },
  ];
  for (let wi = 0; wi < waypoints.length; wi++) {
    const w = waypoints[wi];
    await page.evaluate(({ x, z }) => {
      const sb = window.__sandbox;
      sb.state.mode = 'aerial';
      sb.state.target.set(x, 0, z);
      sb.state.dist = 6000;
    }, { x: w.x, z: w.z });
    const s = await settle(w.name, 60000);
    const d = s.diag || await diagnose();
    const ok = s.clean;
    report.phase2.push({ waypoint: w.name, x: w.x, z: w.z, ...s, diag: d, ok });
    if (!ok) sixFailures.push(`waypoint ${w.name} not clean: ` + JSON.stringify({ stats: s.stats, diag: d }));
    // 文件名必须唯一：中文区名经 ASCII 过滤会撞成同一个 load-district-.png，前面加序号
    const slug = String(wi).padStart(2, '0') + '-' + w.name.replace(/[^\x00-\x7F]+/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    await shot(`load-${slug}.png`);
    log(`shot load-${slug}.png`);
  }

  // ---------- Phase 2b：夜里复查（林萧 14:41 截图：黑方块/网格线/外围黑是加载问题，不是灯光） ----------
  // 同样的点夜里再飞一遍：没加载出来的地方夜里就是黑方块，白天看不出来。
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '22'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(2000);
  log('night time label: ' + await page.evaluate(() => document.getElementById('time-label').textContent));
  for (const w of [{ name: 'night-center', x: 0, z: 0 }, { name: 'night-edge-E', x: 12000, z: 0 }, { name: 'night-98_93', x: -10750, z: -4250 }]) {
    await page.evaluate(({ x, z }) => {
      const sb = window.__sandbox;
      sb.state.mode = 'aerial';
      sb.state.target.set(x, 0, z);
      sb.state.dist = 6000;
    }, { x: w.x, z: w.z });
    const s = await settle(w.name, 60000);
    const d = s.diag || await diagnose();
    const ok = s.clean;
    report.phase2.push({ waypoint: w.name, x: w.x, z: w.z, night: true, ...s, diag: d, ok });
    if (!ok) sixFailures.push(`waypoint ${w.name} not clean: ` + JSON.stringify({ stats: s.stats, diag: d }));
    const slug = w.name.replace(/[^a-z0-9]+/gi, '-');
    await shot(`load-${slug}.png`);
    log(`shot load-${slug}.png`);
  }
  await page.evaluate(() => {
    const s = document.getElementById('time-slider');
    s.value = '10'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1500);

  // ---------- Phase 2c：滑动不掉块（林萧 14:43：从一头拖到另一头，块不能掉、不能黑、不能闪没） ----------
  await page.evaluate(({ x, z }) => {
    const sb = window.__sandbox;
    sb.state.mode = 'aerial';
    sb.state.target.set(x, 0, z);
    sb.state.dist = 6000;
  }, { x: -4000, z: -4000 }); // 拖动起点改到城里（原来 -14000,-14000 在区外，本来就没块，测不出掉块）
  await settle('drag-start', 60000);
  await page.mouse.move(640, 400);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) { await page.mouse.move(640 + i * 20, 400 - i * 6); await page.waitForTimeout(120); }
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.mouse.move(640, 400);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) { await page.mouse.move(640 - i * 20, 400 + i * 6); await page.waitForTimeout(120); }
  await page.mouse.up();
  await page.waitForTimeout(500);
  await shot('load-drag-mid.png');
  log('shot load-drag-mid.png (right after drag, before settle)');
  const dragSettle = await settle('after-drag', 90000);
  const dragDiag = dragSettle.diag || await diagnose();
  const dragOk = dragSettle.clean;
  report.phase2.push({ waypoint: 'after-drag', ...dragSettle, diag: dragDiag, ok: dragOk });
  if (!dragOk) sixFailures.push('after-drag not clean: ' + JSON.stringify({ stats: dragSettle.stats, diag: dragDiag }));
  await shot('load-after-drag.png');
  log('shot load-after-drag.png');

  // ---------- Phase 3：浏览器内全量 GLB 解码 ----------
  log('Phase 3: in-browser decode of every GLB');
  const allUrls = jobs.filter((j) => j.url.endsWith('.glb')).map((j) => j.url);
  page.setDefaultTimeout(1500000); // 全量解码要跑很久；这版 playwright-core 的 evaluate 不接受第三个 timeout 参数
  const sweep = await page.evaluate(async (urls) => {
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const fails = [];
    let done = 0;
    const dispose = (root) => {
      root.traverse((o) => {
        if (o.isMesh || o.isLine || o.isPoints) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of ms) { if (m) m.dispose(); }
          }
        }
      });
    };
    const CONC = 4;
    let idx = 0;
    const worker = async () => {
      while (idx < urls.length) {
        const u = urls[idx++];
        try {
          const g = await loader.loadAsync(u);
          dispose(g.scene);
        } catch (e) {
          fails.push(u + ' :: ' + String((e && e.message) || e).slice(0, 200));
        }
        done++;
        if (done % 500 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    };
    const t0 = Date.now();
    await Promise.all(Array.from({ length: CONC }, worker));
    return { total: urls.length, decoded: done, failed: fails, ms: Date.now() - t0 };
  }, allUrls);
  log(`Phase 3: total=${sweep.total} decoded=${sweep.decoded} failed=${sweep.failed.length} ms=${sweep.ms}`);
  report.phase3 = sweep;
  for (const f of sweep.failed.slice(0, 50)) sixFailures.push('phase3 decode failed: ' + f);
  if (sweep.failed.length > 50) sixFailures.push(`phase3 decode failed: ... +${sweep.failed.length - 50} more`);

  // ---------- 收尾 ----------
  const finalStats = await getSix();
  const finalDiag = await diagnose();
  const finalClean = finalDiag.missingFar.length === 0 && finalDiag.missingTerrain.length === 0
    && finalDiag.failedChunks.length === 0 && (finalDiag.failedLive === null || finalDiag.failedLive === 0);
  if (!finalClean) sixFailures.push('final diagnose not clean: ' + JSON.stringify(finalDiag));
  // console 错误里去掉注入断点那几次（带目标 URL 的 + 对应的无 URL 的 Failed to load resource，
  // 再加站级重试那条预期的 '[six] loadCatalog failed, retrying'）
  let genericResourceLeft = injectedFailures.length;
  const unexpectedConsole = consoleErrors.filter((e) => {
    if (e.includes(farTarget) || (midTarget && e.includes(midTarget)) || e.includes(catalogTarget)) return false;
    if (e.includes('loadCatalog failed, retrying')) return false;
    if (e.startsWith('Failed to load resource') && genericResourceLeft > 0) { genericResourceLeft--; return false; }
    return true;
  });
  report.gate = {
    sixFailures: sixFailures.length, otherFailures: otherFailures.length,
    consoleErrors: consoleErrors.length, unexpectedConsole: unexpectedConsole.length,
    injectedFailures,
    finalStats, finalClean, finalDiag,
    faultTimeline,
    sixFailureList: sixFailures.slice(0, 30), otherFailureList: otherFailures.slice(0, 30),
  };
  log('FINAL sixFailures=' + sixFailures.length + ' otherFailures=' + otherFailures.length + ' consoleErrors=' + consoleErrors.length + ' unexpectedConsole=' + unexpectedConsole.length + ' injectedRecovered=' + injectedFailures.length + ' finalClean=' + finalClean);
  log('FINAL STATS ' + JSON.stringify(finalStats));
  log('FAULT TIMELINE ' + JSON.stringify(faultTimeline, null, 1));
  log('INJECTED (recovered, not counted) ' + JSON.stringify(injectedFailures, null, 1));
  log('SIX FAILURES ' + JSON.stringify(sixFailures, null, 1));
  log('OTHER FAILURES ' + JSON.stringify(otherFailures, null, 1));
  log('CONSOLE ERRORS ' + JSON.stringify(consoleErrors.slice(0, 20), null, 1));
  await browser.close();
  if (serverProc) { try { serverProc.kill(); } catch (e) {} }
  log('DONE exit=' + (sixFailures.length || unexpectedConsole.length ? 1 : 0));
  process.exit(sixFailures.length || unexpectedConsole.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
