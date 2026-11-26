// 虚拟城市沙盘 — 超过版整轮验收脚本（5 路）
// 在 tests/verify-six.js 基础上扩；塔动态加载沿用 tests/verify-surpass-e.js 的做法（不改 app 代码）。
// 场景/材质核对按技能 threejs-scene-setup（Verify：renderer.info + context-loss/restore）
// 与 threejs-materials-lighting（Verify：灯光/环境/toneMapping/sRGB 探针）的做法取数，不手写凑合。
//
// 跑（本机或 8 核实例，仓库根目录 clone 即 fsfeef/xingze-sandbox）：
//   cd <repo> && (python3 -m http.server 8000 &) && node tests/verify-surpass.js
//   node tests/verify-surpass.js --only-rename            # 只跑静态改名，不启动浏览器
//   node tests/verify-surpass.js --stages rename,boot,scene
//   node tests/verify-surpass.js --resume                  # 断点续跑：跳过上次已 PASS 的阶段
//   node tests/verify-surpass.js --from tower              # 从 tower 阶段往后跑
// 环境变量：SANDBOX_URL（默认 http://localhost:8000/app/）、CHROMIUM_PATH（不设则自动找缓存）。
// 实例 1 小时无操作自动关：大跑拆成小段、勤跑，每次只跑一两个阶段就够，--resume 接上。
// 每个阶段跑完立即写盘 tests/surpass-verify-result.json + tests/surpass-verify-<stage>.json，
// 中途被杀也不丢已过的阶段。截图存 tests/surpass-verify-*.png。
//
// 通过条件（exit 0）：核心项全过。核心 = R1 静态改名 + R2 启动 + R3 console 0/失败请求 0
//   + R3b 加载失败数 0（six-loader filesFailed，6 路的数、我只报）
//   + R2b 加载全通（六区扫点：无黑块、无空白、失败 0）+ R2c 滑动不掉块（拖贯穿：不掉块、不黑、不冻住）
//   + R4 白天/夜景 + R4b 夜景档（22:00 鸟瞰+街面：亮窗成片、路灯成片亮、路看得见、无黑块、无纯黑区）
//   + R5 走路 + R6 开车 + R7 小地图 + R8 339 塔 339m±5m + R9 线上改名。
// 顺序（14:42 纠正）：先验加载全通（loadthrough/slide），再验夜景灯光（night）；
//   夜景截图里的大片黑、黑方块、网格线是加载问题，不是灯光问题——加载不过，夜景档不判灯光。
// 清单复核（37 项 + benchmark）是第二 verdict：P0 未过同样记 FAIL 并影响 exit 0；
//   P1/P2 未过记 FAIL 但不改 exit 码（数值如实打印在汇总里）；机验不了的记 SKIP-人工对照。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// playwright-core 懒加载：--only-rename 不需要浏览器，没装也能跑；
// 实例上先跑 npm i -D playwright-core，再 npx playwright install chromium（或设 CHROMIUM_PATH）。
let _pw = null;
function loadPlaywright() {
  if (_pw) return _pw;
  try { _pw = require('playwright-core'); }
  catch (e) {
    throw new Error('playwright-core 未装：先跑 npm i -D playwright-core，再 npx playwright install chromium（或设 CHROMIUM_PATH 指到现成 chromium）');
  }
  return _pw;
}

const ROOT = path.resolve(__dirname, '..');
const OUT = __dirname;
const RESULT_FILE = path.join(OUT, 'surpass-verify-result.json');
const APP_URL = process.env.SANDBOX_URL || 'http://localhost:8000/app/';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH
  || (fs.existsSync('/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome')
    ? '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome' : undefined);
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// ---- 改名 Tier-1（与 rename-audit-2026-11-26.md 同一串；six-names.json 的 old 字段除外）----
const RENAME_PATTERN = '人民公园|春熙路|武侯祠|锦城湖|杜甫草堂|宽窄巷子|文殊院|熊猫基地|永陵|成都东站|青羊宫|安顺桥|东郊记忆|天府广场|环球中心|天府艺术公园|太古里|339电视塔|府河|琴台路|九眼桥|望江楼|锦江|交子大道双子塔|锦里|武侯|金牛|成华|青羊|高新南区|成都|天府|麓湖|兴隆湖|东安湖|九眼|安顺|人南|南门桥';
const TIER2_PATTERN = '一环|中环|绕城';
// 配色表 §4 落法锚点（reference-color-table-2026-11-26.md）：只验“该有的色在不在”，
// 不验“只能有这些色”（人物肤色/发色、车漆、植被、窗光渐变等本就不在表内）。
const COLOR_ANCHORS = [
  { file: 'app/roofs.js', colors: ['#232C52', '#2A3766', '#33417A', '#3A4A8C', '#46589E', '#FF2E88', '#00F0FF', '#8B5CFF', '#FF9F1C'] },
  { file: 'app/roads.js', colors: ['#141A2E', '#FFE600', '#E8F0FF', '#2C3E66'] },
  { file: 'app/tower-fix.js', colors: ['#00F0FF', '#FF2E88'] },
  { file: 'app/street.js', colors: ['#FFD166', '#7DF9FF'] },
];
// 不能抄禁词（benchmark §6 / reference-watch §4）：只许出现在“不做/不许/红线/不抄”的禁令语境里。
const DENY_WORDS = ['IFS', '爬墙熊猫'];

const STAGES = ['rename', 'boot', 'loadthrough', 'slide', 'daynight', 'night', 'scene', 'modes', 'minimap', 'tower', 'checklist', 'viewpoints', 'walkshots'];
const BROWSER_STAGES = STAGES.filter((s) => s !== 'rename');

function grepLines(pattern, cwd) {
  try {
    const out = execFileSync('grep', ['-rn', '-E', pattern, 'app', 'data'], { cwd, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // grep 无匹配
    throw e;
  }
}

// ---- 结果写盘（每阶段立即写，断点续跑的依据）----
let result = { startedAt: nowIso(), updatedAt: nowIso(), stages: {}, core: {}, checklist: {} };
function loadSaved() {
  try { const s = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')); if (s && s.stages) return s; } catch (e) { /* 无旧结果 */ }
  return null;
}
function saveResult() {
  result.updatedAt = nowIso();
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 1));
  for (const [name, st] of Object.entries(result.stages)) {
    fs.writeFileSync(path.join(OUT, `surpass-verify-${name}.json`), JSON.stringify(st, null, 1));
  }
}
function setStage(name, entry) {
  result.stages[name] = { ...entry, at: nowIso() };
  saveResult();
  log(`[stage ${name}] ${entry.status}${entry.note ? ' — ' + entry.note : ''}`);
}

// ---- 截图：先试 page.screenshot，超时回落 canvas 直读（沿用 verify-surpass-e.js 的做法）----
async function shot(page, name, dom = false) {
  const file = path.join(OUT, name);
  if (dom) {
    try { await page.screenshot({ path: file, timeout: 60000 }); return file; }
    catch (e) { log(`page.screenshot failed for ${name}: ${String(e.message).split('\n')[0]}; fallback to canvas capture`); }
  } else {
    try { await page.screenshot({ path: file, timeout: 60000 }); return file; }
    catch (e) { log(`page.screenshot failed for ${name}: ${String(e.message).split('\n')[0]}; fallback to canvas capture`); }
  }
  // canvas 直读回落：evaluate 只传函数本体（本版 playwright-core 的 evaluate 最多 2 参，
  // 传第 3 个 options 会报 Too many arguments——2026-11-26 整轮 loadthrough 段实测撞上，已修）。
  const dataUrl = await page.evaluate(() => {
    const sb = window.__sandbox;
    if (sb.composer) sb.composer.render();
    else sb.renderer.render(sb.scene, sb.camera);
    return sb.renderer.domElement.toDataURL('image/png');
  });
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
}

// ---- 阶段 1：静态改名 + 配色锚点 + 禁词（无浏览器，秒级）----
function stageRename() {
  const hits = grepLines(RENAME_PATTERN, ROOT).filter((l) => !l.startsWith('data/six-names.json:'));
  const tier2 = grepLines(TIER2_PATTERN, ROOT);
  let names = null, namesErr = null;
  try {
    names = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/six-names.json'), 'utf8'));
  } catch (e) { namesErr = String(e.message); }
  const namesOk = !!names && (names.landmarks || []).length === 25 && (names.districts || []).length === 6
    && names.landmarks.every((l) => l.new && l.new !== l.old) && names.districts.every((d) => d.new && d.new !== d.old);
  // 配色锚点：该有的色在不在
  const anchors = [];
  for (const a of COLOR_ANCHORS) {
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, a.file), 'utf8'); } catch (e) { /* 缺文件 */ }
    for (const c of a.colors) {
      const hit = text.toLowerCase().includes(c.toLowerCase()) || text.includes(c.replace('#', '0x'));
      anchors.push({ file: a.file, color: c, present: hit });
    }
  }
  const anchorsMissing = anchors.filter((a) => !a.present);
  // 禁词：只许在禁令语境里出现
  const denyHits = [];
  for (const w of DENY_WORDS) {
    for (const l of grepLines(w, ROOT)) {
      if (!/不做|不许|红线|不抄|禁|不带/.test(l)) denyHits.push(l);
    }
  }
  const pass = hits.length === 0 && namesOk && anchorsMissing.length === 0 && denyHits.length === 0;
  setStage('rename', {
    status: pass ? 'pass' : 'fail', core: 'R1',
    renameHits: hits.length, renameHitLines: hits.slice(0, 60),
    tier2Lines: tier2.length, tier2Note: '只计数，不判 FAIL（范围用语，等总协调定夺）',
    sixNamesOk: namesOk, sixNamesError: namesErr,
    colorAnchorsMissing: anchorsMissing, colorAnchorsTotal: anchors.length,
    denyHits,
    note: `Tier-1 ${hits.length} 行；six-names ${namesOk ? '25+6 OK' : '异常'}；配色锚点缺 ${anchorsMissing.length}/${anchors.length}；禁词违规 ${denyHits.length} 处`,
  });
  return pass;
}

// ---- 浏览器上下文 ----
const ctx = { browser: null, page: null, errors: [], failedReqs: [], entered: false, bootMs: 0 };
async function launchBrowser() {
  if (ctx.browser) return ctx.page;
  // 先确认服务可达（实例上常忘起 http.server）
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(APP_URL, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    throw new Error(`沙盘服务不可达 ${APP_URL}（${e.message}）。实例上先跑：cd <repo> && nohup python3 -m http.server 8000 >/tmp/http8000.log 2>&1 &`);
  }
  ctx.browser = await loadPlaywright().chromium.launch({
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
  });
  ctx.page = await ctx.browser.newPage({ viewport: { width: 1280, height: 800 } });
  ctx.page.on('console', (m) => { if (m.type() === 'error') ctx.errors.push('console: ' + m.text()); });
  ctx.page.on('pageerror', (e) => ctx.errors.push('pageerror: ' + e.message));
  ctx.page.on('requestfailed', (r) => ctx.failedReqs.push(r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  ctx.page.on('response', (r) => { if (r.status() >= 400) ctx.failedReqs.push(r.status() + ' ' + r.url()); });
  return ctx.page;
}
// 进入沙盘（boot 阶段与各浏览器阶段共用；断点续跑时重进不重判）
async function ensureEntered() {
  if (ctx.entered) return;
  const page = await launchBrowser();
  const t0 = Date.now();
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try {
    await page.waitForFunction(() => {
      const s = document.getElementById('start-overlay');
      const e = document.getElementById('error-overlay');
      return (s && s.style.display === 'flex') || (e && e.style.display === 'flex');
    }, { timeout: 240000 });
  } catch (e) { ctx.errors.push('timeout waiting for boot overlay'); }
  ctx.bootMs = Date.now() - t0;
  const st = await page.evaluate(() => ({
    start: document.getElementById('start-overlay').style.display,
    error: document.getElementById('error-overlay').style.display,
    errorText: (document.getElementById('error-text') || {}).textContent?.slice(0, 200) || '',
    dataNote: (document.getElementById('data-note') || {}).textContent || '',
  }));
  if (st.start !== 'flex') throw new Error('BOOT FAILED: start-overlay 未出现：' + JSON.stringify(st));
  await page.evaluate(() => document.querySelector('#start-overlay #enter-btn').click());
  await sleep(2000);
  // 等流式加载稳定（沿用 verify-six.js：chunksHigh/Mid 三轮不变）
  let prevH = -1, prevM = -1, stable = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const s = await page.evaluate(() => (window.__sandboxStats && window.__sandboxStats.six) || null);
    if (!s) continue;
    if (s.chunksHigh === prevH && s.chunksMid === prevM) { stable++; if (stable >= 3) break; }
    else stable = 0;
    prevH = s.chunksHigh; prevM = s.chunksMid;
  }
  ctx.entered = true;
  ctx.bootState = st;
}

// ---- 阶段 2：启动 ----
async function stageBoot() {
  await ensureEntered();
  const page = ctx.page;
  const stats = await page.evaluate(() => window.__sandboxStats || null);
  // 加载失败数（6 路的数，我只报：six-loader statsSnapshot 的 filesFailed，目标 0；
  // 修法归 6 路 tests/load-audit-2026-11-26.js，我不碰 six-loader.js）
  const six = stats && stats.six ? stats.six : null;
  const loadFailed = six ? { filesFailed: six.filesFailed ?? null, filesLoaded: six.filesLoaded ?? null } : null;
  const pass = !!stats && (loadFailed === null || loadFailed.filesFailed === null || loadFailed.filesFailed === 0);
  setStage('boot', {
    status: pass ? 'pass' : 'fail', core: 'R2',
    bootMs: ctx.bootMs, stats, loadFailed,
    note: `启动 ${ctx.bootMs}ms，__sandboxStats ${stats ? '已见' : '未见'}；加载失败 ${loadFailed ? loadFailed.filesFailed : '?'}（已加载 ${loadFailed ? loadFailed.filesLoaded : '?'}，目标 0）`,
  });
  return pass;
}

// ---- 阶段 3：加载全通（14:42 先验加载）----
// 六区区中心逐个飞过去：块要流进来（filesLoaded 涨）、失败数不动、无黑块、无空白。
// 区中心抄 data/six-index.json districts[].center。白天跑：白天画布亮，黑块只能是缺块。
const DISTRICT_CENTERS = [
  { id: 'yunwu', name: '云武区', x: -3969.0, z: -6394.3 },
  { id: 'jinze', name: '金泽区', x: -1058.1, z: 7435.3 },
  { id: 'xingjiang', name: '星江区', x: 4553.7, z: -6764.0 },
  { id: 'huaxing', name: '华兴区', x: 7313.3, z: 2880.3 },
  { id: 'qingyun', name: '青云区', x: -8192.0, z: 1891.5 },
  { id: 'zexin', name: '泽新南区', x: 180.0, z: -11640.8 },
];
async function stageLoadthrough() {
  await ensureEntered();
  const page = ctx.page;
  const before = await sixStats();
  const points = [];
  let worstBlack = 0, worstBlock = 0;
  for (const d of DISTRICT_CENTERS) {
    await page.evaluate((p) => {
      const s = window.__sandbox.state;
      s.mode = 'aerial'; s.target.set(p.x, 0, p.z); s.dist = 4000; s.el = 0.6; s.yaw = 0.3;
    }, d);
    await sleep(7000); // 等附近分块流进来
    const sample = await canvasSample();
    const st = await sixStats();
    const black = sample.blackPct ?? 99, block = sample.largestBlackPct ?? 99;
    worstBlack = Math.max(worstBlack, black); worstBlock = Math.max(worstBlock, block);
    points.push({ ...d, blackPct: black, largestBlackPct: block, meanLum: sample.meanLuminance, filesLoaded: st ? st.filesLoaded : null, filesFailed: st ? st.filesFailed : null });
    await shot(page, `surpass-verify-load-${d.id}.png`);
  }
  const after = await sixStats();
  const failedDelta = (after && before) ? (after.filesFailed - before.filesFailed) : null;
  const pass = failedDelta === 0 && worstBlack < 1 && worstBlock < 1;
  setStage('loadthrough', {
    status: pass ? 'pass' : 'fail', core: 'R2b', checklist: ['加载全通'],
    points, filesFailedBefore: before ? before.filesFailed : null, filesFailedAfter: after ? after.filesFailed : null, failedDelta,
    worstBlackPct: worstBlack, worstLargestBlackPct: worstBlock,
    note: `六区扫点：失败增量 ${failedDelta}（目标 0）；最黑点 blackPct=${worstBlack}%、最大黑块=${worstBlock}%（门限 <1%）；已知缺口 98_93 空块（加载器跳过不报错）、97 块无 mid（远处用 high 代）不在此判`,
  });
  return pass;
}

// ---- 阶段 4：滑动不掉块（14:43 滑动令）----
// 从地图一头拖到另一头：5 条横扫（中央带，避开左右面板与右下小地图），边滑边录——
// 块掉没掉、黑块出没出、卡没卡。判：失败增量 0；每扫完黑块 <1%；页面不冻住
// （2 秒窗内最大帧间隔 <5000ms）。SwiftShader 下绝对 fps 无意义，只报数、不判 fps。
async function stageSlide() {
  await ensureEntered();
  const page = ctx.page;
  await page.evaluate(() => {
    const s = window.__sandbox.state;
    s.mode = 'aerial'; s.target.set(-12000, 0, 0); s.dist = 6000; s.el = 0.6; s.yaw = 0.3;
  });
  await sleep(4000);
  const before = await sixStats();
  const errBefore = ctx.failedReqs.length;
  await shot(page, 'surpass-verify-slide-before.png');
  const sweeps = [];
  let worstBlack = 0, worstBlock = 0, worstGap = 0;
  for (let k = 0; k < 5; k++) {
    const y = 160 + k * 50;
    const probeP = frameProbe(2000); // 与拖动并行采帧间隔
    await page.mouse.move(400, y);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) { await page.mouse.move(400 + i * 40, y); await sleep(50); }
    await page.mouse.up();
    const fp = await probeP;
    await sleep(2500); // 等沿途分块流进来
    const sample = await canvasSample();
    const black = sample.blackPct ?? 99, block = sample.largestBlackPct ?? 99;
    worstBlack = Math.max(worstBlack, black); worstBlock = Math.max(worstBlock, block);
    worstGap = Math.max(worstGap, fp.maxGapMs || 0);
    sweeps.push({ sweep: k + 1, y, fps: fp.fps, maxGapMs: fp.maxGapMs, blackPct: black, largestBlackPct: block });
  }
  const after = await sixStats();
  const failedDelta = (after && before) ? (after.filesFailed - before.filesFailed) : null;
  const reqDelta = ctx.failedReqs.length - errBefore;
  await shot(page, 'surpass-verify-slide-after.png');
  await page.evaluate(() => {
    const s = window.__sandbox.state;
    s.target.set(0, 0, 0); s.dist = 6000; s.el = 0.6; s.yaw = 0.3;
  });
  const pass = failedDelta === 0 && reqDelta === 0 && worstBlack < 1 && worstBlock < 1 && worstGap < 5000;
  setStage('slide', {
    status: pass ? 'pass' : 'fail', core: 'R2c',
    sweeps, failedDelta, reqDelta, worstBlackPct: worstBlack, worstLargestBlackPct: worstBlock, worstGapMs: worstGap,
    note: `5 条横扫：失败增量 ${failedDelta}、请求失败增量 ${reqDelta}（目标 0）；最黑 blackPct=${worstBlack}%、最大黑块=${worstBlock}%（门限 <1%）；最大帧间隔 ${worstGap}ms（冻住门限 <5000ms；SwiftShader fps 只报数：${sweeps.map((s) => s.fps).join('/')})`,
  });
  return pass;
}

// threejs-scene-setup Verify：renderer.info + canvas 尺寸；
// threejs-materials-lighting Verify：灯光/环境/toneMapping/sRGB 探针（经 __sandbox 取数）。
async function sceneProbe() {
  return ctx.page.evaluate(() => {
    const sb = window.__sandbox;
    const lights = [], casters = [], srgbMissing = [];
    const matTypes = {};
    let meshes = 0, textured = 0, emissive = 0;
    sb.scene.traverse((o) => {
      if (o.isLight) lights.push(`${o.type}:${o.intensity}${o.castShadow ? ':shadow' : ''}`);
      if (o.isMesh) {
        meshes++;
        if (o.castShadow) casters.push(o.name || o.type);
        for (const m of [].concat(o.material ?? [])) {
          if (!m || !m.type) continue;
          matTypes[m.type] = (matTypes[m.type] || 0) + 1;
          if (m.map) textured++;
          if (m.map && m.map.colorSpace !== 'srgb') srgbMissing.push(m.name || m.type);
          if (m.emissive && m.emissiveIntensity > 0 && (m.emissive.r + m.emissive.g + m.emissive.b) > 0) emissive++;
        }
      }
    });
    return {
      drawCalls: sb.renderer.info.render.calls,
      triangles: sb.renderer.info.render.triangles,
      geometries: sb.renderer.info.memory.geometries,
      canvas: [sb.renderer.domElement.width, sb.renderer.domElement.height],
      pixelRatio: sb.renderer.getPixelRatio(),
      lights, environment: !!sb.scene.environment,
      shadowMap: sb.renderer.shadowMap.enabled, shadowCasters: casters.length,
      toneMapping: sb.renderer.toneMapping,
      colorMapsNotSRGB: srgbMissing.slice(0, 10),
      meshes, texturedMeshes: textured, emissiveMeshes: emissive, matTypes,
    };
  });
}
// 画布亮度采样（同步渲染后立即读，与 verify-surpass-e.js 同法；读不到记 unreadable，不判错）
// 含黑块分析：lum<10 的连通块（缺块/未加载在画布上就是黑的，见 14:41 夜景截图）；
// lum<4 为纯黑。亮度分档 + 暖亮（发光窗/路灯暖黄）/ 冷亮（霓虹青）用于夜景档。
async function canvasSample() {
  try {
    return await ctx.page.evaluate(() => {
      const sb = window.__sandbox;
      if (sb.composer) sb.composer.render();
      else sb.renderer.render(sb.scene, sb.camera);
      const c = sb.renderer.domElement;
      const W = 160, H = 100;
      const t = document.createElement('canvas');
      t.width = W; t.height = H;
      const x = t.getContext('2d');
      x.drawImage(c, 0, 0, W, H);
      const d = x.getImageData(0, 0, W, H).data;
      const n = W * H;
      const lum = new Float32Array(n);
      let sum = 0, bright = 0, dark = 0, mid = 0, warm = 0, cool = 0, pure = 0, near = 0;
      const seen = new Set();
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lum[p] = l; sum += l;
        if (l >= 120) { bright++; if (r > 150 && r > b + 30) warm++; if (b > 150 && b > r + 30) cool++; }
        if (l < 16) dark++;
        if (l >= 40 && l < 120) mid++;
        if (l < 4) pure++;
        if (l < 10) near++;
        seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      }
      // 最大连通黑块（4 连通，160x100 网格）
      const largest = (thresh) => {
        const black = new Uint8Array(n);
        for (let p = 0; p < n; p++) black[p] = lum[p] < thresh ? 1 : 0;
        const vis = new Uint8Array(n);
        let best = 0;
        for (let p = 0; p < n; p++) {
          if (!black[p] || vis[p]) continue;
          let size = 0; const stack = [p]; vis[p] = 1;
          while (stack.length) {
            const j = stack.pop(); size++;
            const cx = j % W, cy = (j / W) | 0;
            const nb = [cx > 0 ? j - 1 : -1, cx < W - 1 ? j + 1 : -1, cy > 0 ? j - W : -1, cy < H - 1 ? j + W : -1];
            for (const k of nb) if (k >= 0 && black[k] && !vis[k]) { vis[k] = 1; stack.push(k); }
          }
          if (size > best) best = size;
        }
        return +(best / n * 100).toFixed(2);
      };
      const pct = (v) => +(v / n * 100).toFixed(2);
      return {
        meanLuminance: +(sum / n).toFixed(1), brightPct: pct(bright),
        darkPct: pct(dark), midPct: pct(mid), warmBrightPct: pct(warm), coolBrightPct: pct(cool),
        pureBlackPct: pct(pure), blackPct: pct(near),
        largestPureBlackPct: largest(4), largestBlackPct: largest(10),
        distinctColors: seen.size,
      };
    }, undefined, { timeout: 60000 });
  } catch (e) { return { unreadable: String(e.message).split('\n')[0] }; }
}
// 帧率/卡顿探针：2 秒内 rAF 计数 + 最大帧间隔（SwiftShader 下绝对 fps 无意义，只判“冻没冻住”）
async function frameProbe(ms = 2000) {
  return ctx.page.evaluate((dur) => new Promise((res) => {
    let n = 0, last = performance.now(), maxGap = 0;
    const t0 = performance.now();
    const tick = (t) => {
      n++; if (t - last > maxGap) maxGap = t - last; last = t;
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
      else res({ frames: n, fps: +(n / (dur / 1000)).toFixed(1), maxGapMs: Math.round(maxGap) });
    };
    requestAnimationFrame(tick);
  }), ms, { timeout: 30000 });
}
function sixStats() {
  return ctx.page.evaluate(() => (window.__sandboxStats && window.__sandboxStats.six) || null);
}

// ---- 阶段 7：场景/材质核对（按两技能 Verify 取数）----
async function stageScene() {
  await ensureEntered();
  const page = ctx.page;
  const day = await sceneProbe();
  const canvasDay = await canvasSample();
  // context-loss/restore（threejs-scene-setup Verify）：丢上下文再恢复，场景须还在
  let restored = null;
  try {
    await page.evaluate(async () => {
      const r = window.__sandbox.renderer;
      if (r.forceContextLoss) {
        r.forceContextLoss();
        await new Promise((res) => setTimeout(res, 500));
        r.forceContextRestore();
        await new Promise((res) => setTimeout(res, 800));
      }
    });
    await sleep(1500);
    restored = await page.evaluate(() => ({
      calls: window.__sandbox.renderer.info.render.calls,
      canvas: [window.__sandbox.renderer.domElement.width, window.__sandbox.renderer.domElement.height],
    }));
  } catch (e) { restored = { error: String(e.message).split('\n')[0] }; }
  await shot(page, 'surpass-verify-scene-day.png');
  const canvasBlank = canvasDay.distinctColors !== undefined && canvasDay.distinctColors <= 1;
  const pass = day.lights.length > 0 || day.environment;
  const srgbOk = (day.colorMapsNotSRGB || []).length === 0;
  setStage('scene', {
    status: pass && srgbOk && !canvasBlank ? 'pass' : 'fail', core: null, checklist: ['L01', 'L02', 'L13'],
    dayProbe: day, canvasDay, restored,
    note: `灯光 ${day.lights.length} 盏（${day.lights.slice(0, 4).join(', ') || '无'}），环境 ${day.environment ? '有' : '无'}，toneMapping=${day.toneMapping}，非 sRGB 贴图 ${day.colorMapsNotSRGB.length}，网格 ${day.meshes}（带贴图 ${day.texturedMeshes}，发光 ${day.emissiveMeshes}），drawCalls=${day.drawCalls}，画布 ${canvasDay.distinctColors ?? '?'} 色，context-restore calls=${restored && restored.calls}`,
  });
  return pass && srgbOk && !canvasBlank;
}

async function setTime(hour) {
  await ctx.page.evaluate((h) => {
    const s = document.getElementById('time-slider');
    s.value = String(h);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, hour);
  await sleep(3000);
  return ctx.page.evaluate(() => ({
    slider: document.getElementById('time-slider').value,
    label: document.getElementById('time-label').textContent,
  }));
}

// ---- 阶段 5：白天 / 夜景 ----
async function stageDaynight() {
  await ensureEntered();
  const page = ctx.page;
  const day = await setTime(10);
  const canvasDay = await canvasSample();
  await shot(page, 'surpass-verify-day.png');
  const night = await setTime(22);
  const canvasNight = await canvasSample();
  const nightProbe = await sceneProbe();
  await shot(page, 'surpass-verify-night.png');
  await setTime(10);
  const pass = Number(day.slider) === 10 && Number(night.slider) === 22;
  setStage('daynight', {
    status: pass ? 'pass' : 'fail', core: 'R4', checklist: ['L02', 'S06', 'L08'],
    day, night, canvasDay, canvasNight,
    nightEmissiveMeshes: nightProbe.emissiveMeshes, nightLights: nightProbe.lights,
    note: `白天 label=${day.label}，夜晚 label=${night.label}；夜画布均亮 ${canvasNight.meanLuminance}、亮点 ${canvasNight.brightPct}%、${canvasNight.distinctColors} 色；夜发光网格 ${nightProbe.emissiveMeshes}（L02/S06 由 G 路对照截图判）`,
  });
  return pass;
}

// ---- 阶段 6：夜景档（14:41 夜景重做令；顺序按 14:42：加载先过，灯光后验）----
// 22:00 鸟瞰 + 街面两档：楼亮窗成片、路灯成片亮、路看得见、无黑块、无纯黑区、无网格线、失败请求 0。
// 门限是存在性级别的初版门限（基线实测见报告 §11）：
//   亮窗：暖亮像素（发光窗暖黄 #FFD166）鸟瞰 ≥0.5% 或发光网格 >0；
//   路灯：street.js 已接线且 lamps>0，且街面亮像素 ≥1%；
//   路看得见：鸟瞰亮像素 ≥1% 且冷亮（霓虹青）≥0.5%；
//   黑块：纯黑 <1% 且最大纯黑块 <1%（两档都判）；网格线：截图人工判（G 路）。
// 跑完回 10:00 白天，免得影响后面的阶段。
async function stageNight() {
  await ensureEntered();
  const page = ctx.page;
  const errBefore = ctx.errors.length, reqBefore = ctx.failedReqs.length;
  await setTime(22);
  // 鸟瞰
  await page.evaluate(() => {
    const s = window.__sandbox.state;
    s.mode = 'aerial'; s.target.set(0, 0, 0); s.dist = 6000; s.el = 0.6; s.yaw = 0.3;
  });
  await sleep(6000);
  const aerialSample = await canvasSample();
  const aerialProbe = await sceneProbe();
  await shot(page, 'surpass-verify-night-aerial.png');
  // 街面：星熙路走路视角
  await page.evaluate(() => {
    const s = window.__sandbox.state;
    s.mode = 'aerial'; s.target.set(1155.7, 0, -994.9); s.dist = 600; s.el = 0.6; s.yaw = 0.3;
  });
  await sleep(2500);
  await page.click('#mode-seg button[data-mode="walk"]');
  await sleep(4000);
  const streetMode = await page.evaluate(() => window.__sandbox.state.mode);
  const streetSample = await canvasSample();
  const streetInfo = await page.evaluate(() => ({
    streetWired: !!window.__street,
    lamps: window.__street ? window.__street.lamps : null,
    skinWired: !!window.__skin,
  }));
  await shot(page, 'surpass-verify-night-street.png');
  await page.click('#mode-seg button[data-mode="aerial"]');
  await setTime(10);
  await sleep(1000);
  const windows = (aerialSample.warmBrightPct ?? 0) >= 0.5 || (aerialProbe.emissiveMeshes ?? 0) > 0;
  const lamps = streetInfo.streetWired && (streetInfo.lamps ?? 0) > 0 && (streetSample.brightPct ?? 0) >= 1;
  const roads = (aerialSample.brightPct ?? 0) >= 1 && (aerialSample.coolBrightPct ?? 0) >= 0.5;
  const noBlack = (aerialSample.pureBlackPct ?? 99) < 1 && (aerialSample.largestPureBlackPct ?? 99) < 1
    && (streetSample.pureBlackPct ?? 99) < 1 && (streetSample.largestPureBlackPct ?? 99) < 1;
  const reqDelta = ctx.failedReqs.length - reqBefore;
  const errDelta = ctx.errors.length - errBefore;
  const pass = windows && lamps && roads && noBlack && reqDelta === 0;
  setStage('night', {
    status: pass ? 'pass' : 'fail', core: 'R4b', checklist: ['L02', 'S06', 'L08', '夜景重做'],
    aerialSample, aerialEmissiveMeshes: aerialProbe.emissiveMeshes, streetSample, streetMode, streetInfo,
    checks: { windows, lamps, roads, noBlack, gridLines: 'manual-G路看截图', failedReqDelta: reqDelta, errDelta },
    note: `亮窗 ${windows ? '过' : '不过'}（鸟瞰暖亮 ${aerialSample.warmBrightPct}%、发光网格 ${aerialProbe.emissiveMeshes}）；路灯 ${lamps ? '过' : '不过'}（street 接线 ${streetInfo.streetWired ? '是' : '否'}、lamps=${streetInfo.lamps}、街面亮 ${streetSample.brightPct}%）；路 ${roads ? '看得见' : '看不见'}（鸟瞰亮 ${aerialSample.brightPct}%、冷亮 ${aerialSample.coolBrightPct}%）；黑块 ${noBlack ? '无' : '有'}（鸟瞰纯黑 ${aerialSample.pureBlackPct}%/最大 ${aerialSample.largestPureBlackPct}%，街面纯黑 ${streetSample.pureBlackPct}%/最大 ${streetSample.largestPureBlackPct}%）；网格线人工看截图；失败请求增量 ${reqDelta}`,
  });
  return pass;
}

// ---- 阶段 8：走路 / 开车 ----
async function stageModes() {
  await ensureEntered();
  const page = ctx.page;
  await page.click('#mode-seg button[data-mode="walk"]');
  await sleep(3000);
  const walkMode = await page.evaluate(() => window.__sandbox.state.mode);
  await shot(page, 'surpass-verify-walk.png');
  await page.click('#mode-seg button[data-mode="drive"]');
  await sleep(2000);
  const speedBefore = await page.evaluate(() => document.getElementById('drive-speed').textContent);
  await page.keyboard.down('KeyW');
  await sleep(3000);
  await page.keyboard.up('KeyW');
  await sleep(500);
  const drive = await page.evaluate(() => ({
    mode: window.__sandbox.state.mode,
    speed: document.getElementById('drive-speed').textContent,
    camY: +window.__sandbox.camera.position.y.toFixed(1),
    carView: window.__sandbox.state.carView,
  }));
  const speedNum = parseFloat(drive.speed) || 0;
  await shot(page, 'surpass-verify-drive.png');
  // S08 车内视角：点按钮，文案须翻成“跟随视角”，state.carView 须变 interior；再点回来
  let interior = null;
  try {
    await page.click('#view-toggle');
    await sleep(1200);
    interior = await page.evaluate(() => ({
      btn: document.getElementById('view-toggle').textContent,
      carView: window.__sandbox.state.carView,
    }));
    await page.click('#view-toggle');
    await sleep(800);
  } catch (e) { interior = { error: String(e.message).split('\n')[0] }; }
  await page.click('#mode-seg button[data-mode="aerial"]');
  await sleep(1500);
  const pass = walkMode === 'walk' && drive.mode === 'drive' && speedNum > 0;
  const followCam = drive.camY < 150; // S09：跟随视角相机须贴近地面，不是高空俯瞰
  setStage('modes', {
    status: pass ? 'pass' : 'fail', core: 'R5/R6', checklist: ['S08', 'S09'],
    walkMode, speedBefore, drive, speedNum, followCam, interior,
    note: `走路 mode=${walkMode}；开车 mode=${drive.mode}，油门后 ${drive.speed}（之前 ${speedBefore}），相机高 ${drive.camY}m（跟随 ${followCam ? '是' : '否'}）；车内视角切换 ${JSON.stringify(interior)}`,
  });
  return pass;
}

// ---- 阶段 9：小地图 ----
async function stageMinimap() {
  await ensureEntered();
  const page = ctx.page;
  const mmCheck = await page.evaluate(() => {
    const cv = document.getElementById('minimap');
    const ctx2 = cv.getContext('2d');
    const d = ctx2.getImageData(0, 0, cv.width, cv.height).data;
    let varied = 0;
    for (let i = 0; i < d.length; i += 400) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.abs(r - 223) > 12 || Math.abs(g - 229) > 12 || Math.abs(b - 234) > 12) varied++;
    }
    return { sampled: Math.round(d.length / 400), varied };
  });
  const before = await page.evaluate(() => ({ x: window.__sandbox.state.target.x, z: window.__sandbox.state.target.z }));
  const mm = await page.evaluate(() => {
    const r = document.getElementById('minimap').getBoundingClientRect();
    return { x: r.x + r.width * 0.62, y: r.y + r.height * 0.38 };
  });
  await page.mouse.click(mm.x, mm.y);
  await sleep(4000);
  const after = await page.evaluate(() => ({ x: window.__sandbox.state.target.x, z: window.__sandbox.state.target.z }));
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  await shot(page, 'surpass-verify-minimap-fly.png');
  const pass = mmCheck.varied > 5 && moved > 500;
  setStage('minimap', {
    status: pass ? 'pass' : 'fail', core: 'R7', checklist: ['K06'],
    mmCheck, moved: +moved.toFixed(0),
    note: `小地图变色像素 ${mmCheck.varied}/${mmCheck.sampled}；点按飞行视点移动 ${moved.toFixed(0)}m（K06 配色由 G 路对照截图判）`,
  });
  return pass;
}

// ---- 阶段 10：339 塔 ----
async function stageTower() {
  await ensureEntered();
  const page = ctx.page;
  let measure = null, initErr = null;
  try {
    measure = await page.evaluate(async () => {
      const t = await import('/app/tower-fix.js');
      const tw = await t.init(window.__sandbox);
      return tw.measure();
    }, undefined, { timeout: 120000 });
  } catch (e) { initErr = String(e.message).split('\n')[0]; }
  // 塔近景机位（沿用 verify-surpass-e.js）
  await page.evaluate(() => {
    const s = window.__sandbox.state;
    s.mode = 'aerial'; s.target.set(2492.5, 150, -179.1); s.dist = 900; s.el = 0.35; s.yaw = 0.6;
  });
  await sleep(5000);
  await shot(page, 'surpass-verify-tower-day.png');
  if (measure && measure.ok) {
    await page.evaluate((m) => {
      const d = document.createElement('div');
      d.id = 'verify-measure-badge';
      d.textContent = `339塔实测: 地面 ${m.groundY}m · 塔顶 ${m.topY}m · 塔高 ${m.height}m (目标 339m, 误差 ${m.error}m, ±5m ${m.within5m ? '通过' : '不通过'})`;
      d.style.cssText = 'position:fixed;left:12px;top:64px;z-index:9999;background:#0b1026;color:#00f0ff;font:16px monospace;padding:8px 12px;border:1px solid #00f0ff;border-radius:6px;';
      document.body.appendChild(d);
    }, measure);
    await sleep(500);
    await shot(page, 'surpass-verify-tower-measure.png', true);
    await page.evaluate(() => document.getElementById('verify-measure-badge')?.remove());
  }
  // 白膜：霓虹环须收起
  let whiteRings = null;
  try {
    await page.evaluate(() => window.__towerFix.setDisplay('white'));
    await sleep(800);
    whiteRings = await page.evaluate(() =>
      window.__towerFix.group.children.filter((o) => o.geometry && o.geometry.type === 'TorusGeometry').map((o) => o.visible));
    await page.evaluate(() => window.__towerFix.setDisplay('normal'));
  } catch (e) { whiteRings = { error: String(e.message).split('\n')[0] }; }
  const pass = !!(measure && measure.ok && measure.within5m);
  setStage('tower', {
    status: pass ? 'pass' : 'fail', core: 'R8', checklist: ['L04'],
    measure, initErr, whiteRings,
    note: measure && measure.ok
      ? `塔高 ${measure.height}m（目标 339m，误差 ${measure.error}m，±5m ${measure.within5m ? '通过' : '不通过'}）；白膜霓虹环可见=${JSON.stringify(whiteRings)}`
      : `塔量失败：${initErr || 'measure 未返回 ok'}`,
  });
  return pass;
}

// ---- 阶段 11：清单 DOM 复核（K02/K01/L07/K09/K03/K04/K05 + 线上改名 R9）----
async function stageChecklist() {
  await ensureEntered();
  const page = ctx.page;
  const dom = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, visible: getComputedStyle(el).display !== 'none' };
    };
    const help = rect(q('#help')), top = rect(q('#topbar'));
    let overlap = 0;
    if (help && top) {
      const ox = Math.max(0, Math.min(help.x + help.w, top.x + top.w) - Math.max(help.x, top.x));
      const oy = Math.max(0, Math.min(help.y + help.h, top.y + top.h) - Math.max(help.y, top.y));
      overlap = ox * oy;
    }
    const lmTexts = [...document.querySelectorAll('#list-landmarks button')].map((b) => b.textContent.trim());
    const zoneTexts = [...document.querySelectorAll('#list-zones button')].map((b) => b.textContent.trim());
    const legend = (q('#panel-legend') || {}).textContent || '';
    return {
      heatPresent: !!q('#tgl-heat'), tourPresent: !!q('#tgl-tour'),
      panelPresent: !!q('#panel'), listPresent: !!q('#list'),
      helpOverlapPx2: overlap, helpRect: help, topRect: top,
      dataNote: (q('#data-note') || {}).textContent || '',
      calls: window.__sandboxStats ? window.__sandboxStats.calls : null,
      orbitBtn: !!([...document.querySelectorAll('#mode-seg button')].find((b) => b.textContent.includes('环视'))),
      dMaps: !!window.__dMaps, dSun: !!window.__dSun, sunBtn: !!q('#d-sun-btn'),
      dSettings: !!window.__dSettings, settingsBtn: !!q('#d-settings-btn'),
      dWeather: !!window.__dWeather,
      lmTexts, zoneTexts, legendHasOld: null, bodyText: document.body.innerText.slice(0, 4000),
    };
  });
  const re = new RegExp(RENAME_PATTERN);
  const liveHits = [...dom.lmTexts, ...dom.zoneTexts].filter((t) => re.test(t));
  const towerBtn = dom.lmTexts.find((t) => t.includes('揽星塔') || t.includes('339电视塔')) || null;
  const denyLive = ['IFS', '爬墙熊猫'].filter((w) => dom.bodyText.includes(w));
  // K03/K04/K05：模块未接线（window 句柄不在）记 SKIP-未接线；接了但按钮不在记 FAIL
  const orbit = dom.orbitBtn ? 'pass' : (dom.dMaps ? 'fail' : 'skip-未接线');
  const sun = dom.sunBtn ? 'pass' : (dom.dSun ? 'fail' : 'skip-未接线');
  const settings = dom.settingsBtn ? 'pass' : (dom.dSettings ? 'fail' : 'skip-未接线');
  const weather = dom.dWeather ? 'pass' : 'skip-未接线';
  const k02pass = !dom.heatPresent && !dom.tourPresent && !dom.panelPresent && !dom.listPresent;
  const k01pass = dom.helpOverlapPx2 === 0;
  const l07pass = dom.dataNote.includes('推算');
  const k09 = dom.calls === null ? 'skip-未读到' : (dom.calls <= 250 ? 'pass' : 'fail');
  const r9 = dom.lmTexts.length === 0 && dom.zoneTexts.length === 0
    ? 'skip-无展示面（列表已摘，见 K02）'
    : (liveHits.length === 0 && towerBtn && towerBtn.includes('揽星塔') ? 'pass' : 'fail');
  const p0fail = !k02pass || r9 === 'fail' || denyLive.length > 0;
  setStage('checklist', {
    status: p0fail ? 'fail' : 'pass', core: 'R9/K02',
    k02Removed: { heat: !dom.heatPresent, tour: !dom.tourPresent, cityDataPanel: !dom.panelPresent, landmarkList: !dom.listPresent, pass: k02pass },
    k01HelpOverlapPx2: dom.helpOverlapPx2, k01Pass: k01pass,
    l07DataNoteHas推算: l07pass, dataNote: dom.dataNote.slice(0, 200),
    k09DrawCalls: dom.calls, k09,
    k03Orbit: orbit, k05Sun: sun, k04Settings: settings, k04Weather: weather,
    liveRename: { status: r9, liveHits, towerBtn, lmCount: dom.lmTexts.length, zoneCount: dom.zoneTexts.length },
    denyLive,
    note: `K02 已砍功能摘除 ${k02pass ? '是' : '否'}（热力 ${dom.heatPresent ? '在' : '已摘'}，导览 ${dom.tourPresent ? '在' : '已摘'}，城市数据面板 ${dom.panelPresent ? '在' : '已摘'}，地标列表 ${dom.listPresent ? '在' : '已摘'}）；K01 帮助条重叠 ${dom.helpOverlapPx2}px²；L07 data-note 含推算 ${l07pass ? '是' : '否'}；K09 drawCalls=${dom.calls}（${k09}）；K03 环视 ${orbit}，K05 日照 ${sun}，K04 设置 ${settings} / 天气 ${weather}；线上改名 ${r9}（塔按钮：${towerBtn}）`,
  });
  return !p0fail;
}

// ---- 阶段 12：补拍 benchmark 缺的 6 个抽查视点（S15–S20，青云 3 + 高新南 3）----
const VIEWPOINTS = [
  { id: 'S15', dist: '青云区', x: -8192, z: 1891 },
  { id: 'S16', dist: '青云区', x: -6700, z: 1100 },
  { id: 'S17', dist: '青云区', x: -9600, z: 2700 },
  { id: 'S18', dist: '泽新南区', x: 180, z: -11640 },
  { id: 'S19', dist: '泽新南区', x: 1400, z: -10800 },
  { id: 'S20', dist: '泽新南区', x: -1100, z: -12500 },
];
async function stageViewpoints() {
  await ensureEntered();
  const page = ctx.page;
  const shots = [];
  for (const v of VIEWPOINTS) {
    await page.evaluate((p) => {
      const s = window.__sandbox.state;
      s.mode = 'aerial'; s.target.set(p.x, 0, p.z); s.dist = 500; s.el = 0.5; s.yaw = 0.3;
    }, v);
    await sleep(8000); // 等附近分块流进来
    const name = `surpass-verify-${v.id.toLowerCase()}.png`;
    await shot(page, name);
    shots.push({ ...v, file: name });
  }
  setStage('viewpoints', {
    status: 'pass', core: null, checklist: ['benchmark-S15-S20'],
    shots,
    note: `补拍 6 个抽查视点（benchmark 缺的 S15–S20）：${shots.map((s) => s.id).join('、')}，各 dist 500m / el 0.5，10:00 白天`,
  });
  return true;
}

// ---- 阶段 13：补拍 3 张走路街面（星泽广场 → 星熙路 → 星光里）----
const WALK_SPOTS = [
  { id: 'walk-plaza', name: '星泽广场', x: -114.9, z: -570.4 },
  { id: 'walk-xingxi', name: '星熙路', x: 1155.7, z: -994.9 },
  { id: 'walk-xingguang', name: '星光里', x: 1390.3, z: -963.9 },
];
async function stageWalkshots() {
  await ensureEntered();
  const page = ctx.page;
  const shots = [];
  for (const w of WALK_SPOTS) {
    await page.evaluate((p) => {
      const s = window.__sandbox.state;
      s.mode = 'aerial'; s.target.set(p.x, 0, p.z); s.dist = 600; s.el = 0.6; s.yaw = 0.3;
    }, w);
    await sleep(2500);
    await page.click('#mode-seg button[data-mode="walk"]');
    await sleep(4000); // 走路落点 + 附近分块
    const mode = await page.evaluate(() => window.__sandbox.state.mode);
    const name = `surpass-verify-${w.id}.png`;
    await shot(page, name);
    shots.push({ ...w, mode, file: name });
    await page.click('#mode-seg button[data-mode="aerial"]');
    await sleep(1200);
  }
  const pass = shots.every((s) => s.mode === 'walk');
  setStage('walkshots', {
    status: pass ? 'pass' : 'fail', core: null, checklist: ['benchmark-走路街面', 'S04', 'S05'],
    shots,
    note: `补拍 3 张走路街面：${shots.map((s) => `${s.name}(${s.mode})`).join('、')}（S04/S05 有人有店与否由 G 路对照截图判）`,
  });
  return pass;
}

const STAGE_FNS = {
  rename: stageRename, boot: stageBoot, loadthrough: stageLoadthrough, slide: stageSlide,
  daynight: stageDaynight, night: stageNight, scene: stageScene,
  modes: stageModes, minimap: stageMinimap, tower: stageTower, checklist: stageChecklist,
  viewpoints: stageViewpoints, walkshots: stageWalkshots,
};

function parseArgs(argv) {
  const a = { stages: null, from: null, resume: false, onlyRename: false, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') a.help = true;
    else if (arg === '--resume') a.resume = true;
    else if (arg === '--only-rename') a.onlyRename = true;
    else if (arg.startsWith('--stages=')) a.stages = arg.slice(9).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--from=')) a.from = arg.slice(7).trim();
    else if (arg === '--list-stages') { log('stages: ' + STAGES.join(', ')); process.exit(0); }
    else { log('未知参数：' + arg + '（--help 看用法）'); process.exit(2); }
  }
  return a;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(`用法：node tests/verify-surpass.js [--only-rename] [--stages a,b] [--from <stage>] [--resume] [--list-stages]
阶段：${STAGES.join(', ')}
  rename      静态改名 + 配色锚点 + 禁词（无浏览器，秒级）
  boot        启动 + 流式加载稳定
  loadthrough 加载全通：六区区中心逐个飞（无黑块、无空白、失败 0）
  slide       滑动不掉块：5 条横扫拖贯穿（不掉块、不黑、不冻住）
  daynight    白天 10:00 / 夜景 22:00
  night       夜景档：22:00 鸟瞰 + 街面（亮窗/路灯/路/黑块/网格线）
  scene       场景/材质核对（renderer.info + 灯光/环境/sRGB 探针 + context-loss 恢复）
  modes       走路 / 开车（油门测速 + 跟随视角 + 车内视角切换）
  minimap     小地图像素 + 点按飞行
  tower       339 塔动态加载量高 339m±5m + 白膜霓虹环
  checklist   清单 DOM 复核（K02/K01/L07/K09/K03/K04/K05 + 线上改名 R9）
  viewpoints  补拍 benchmark 缺的 S15–S20（6 个抽查视点）
  walkshots   补拍 3 张走路街面（星泽广场/星熙路/星光里）
环境：SANDBOX_URL（默认 http://localhost:8000/app/）、CHROMIUM_PATH。
实例上：先 cd <repo> && nohup python3 -m http.server 8000 >/tmp/http8000.log 2>&1 &；每段跑一两个阶段，--resume 续跑。`);
    process.exit(0);
  }
  let selected = STAGES.slice();
  if (args.onlyRename) selected = ['rename'];
  if (args.stages) {
    const bad = args.stages.filter((s) => !STAGES.includes(s));
    if (bad.length) { log('未知阶段：' + bad.join(',')); process.exit(2); }
    selected = args.stages;
  }
  if (args.from) {
    const i = STAGES.indexOf(args.from);
    if (i < 0) { log('未知阶段：' + args.from); process.exit(2); }
    selected = selected.filter((s) => STAGES.indexOf(s) >= i);
  }
  const saved = args.resume ? loadSaved() : null;
  if (saved) {
    result = saved;
    result.startedAt = saved.startedAt || nowIso();
    log(`--resume：读到旧结果 ${RESULT_FILE}，已 PASS 的阶段跳过（boot/rename 每次重跑）`);
  }
  log(`verify-surpass：${APP_URL}，阶段：${selected.join(', ')}`);
  const coreFail = [];
  try {
    for (const name of selected) {
      if (saved && saved.stages && saved.stages[name] && saved.stages[name].status === 'pass'
        && name !== 'boot' && name !== 'rename') {
        log(`[stage ${name}] skip-resumed（上次已 PASS）`);
        continue;
      }
      const ok = await STAGE_FNS[name]();
      if (!ok && ['rename', 'boot', 'loadthrough', 'slide', 'daynight', 'night', 'modes', 'minimap', 'tower', 'checklist'].includes(name)) coreFail.push(name);
    }
  } catch (e) {
    log('FATAL ' + String(e && e.stack || e));
    saveResult();
    process.exit(1);
  } finally {
    if (ctx.browser) await ctx.browser.close().catch(() => {});
  }
  // R3 全程 tally：console 0 报错 + 失败请求 0（只在跑过浏览器阶段时判）
  const ranBrowser = selected.some((s) => BROWSER_STAGES.includes(s));
  const r3pass = !ranBrowser || (ctx.errors.length === 0 && ctx.failedReqs.length === 0);
  result.core = {
    R1_rename: result.stages.rename?.status || 'not-run',
    R2_boot: result.stages.boot?.status || 'not-run',
    R2b_loadthrough: result.stages.loadthrough?.status || 'not-run',
    R2c_slide: result.stages.slide?.status || 'not-run',
    R3_console0_failedReq0: ranBrowser ? (r3pass ? 'pass' : 'fail') : 'not-run',
    R3b_loadFailedFiles: result.stages.boot?.loadFailed ?? 'not-run', // 6 路的数，只报：目标 0
    R4_daynight: result.stages.daynight?.status || 'not-run',
    R4b_nightGrade: result.stages.night?.status || 'not-run',
    R5_walk: result.stages.modes?.status || 'not-run',
    R6_drive: result.stages.modes?.status || 'not-run',
    R7_minimap: result.stages.minimap?.status || 'not-run',
    R8_tower339: result.stages.tower?.status || 'not-run',
    R9_liveRename: result.stages.checklist?.status || 'not-run',
    errors: ctx.errors, failedReqs: ctx.failedReqs.slice(0, 20),
  };
  if (ranBrowser && !r3pass) coreFail.push('console/failedReq');
  const p1p2 = [];
  if (result.stages.checklist) {
    const c = result.stages.checklist;
    if (c.k09 === 'fail') p1p2.push('K09 drawCalls=' + c.k09DrawCalls + '（>250，P1）');
    if (!c.k01Pass) p1p2.push('K01 帮助条被顶栏盖（P1）');
    if (c.k03Orbit === 'fail') p1p2.push('K03 环视已接线但按钮不在（P1）');
    if (c.k05Sun === 'fail') p1p2.push('K05 日照已接线但按钮不在（P1）');
    if (c.k04Settings === 'fail') p1p2.push('K04 设置已接线但面板不在（P1）');
    if (!c.l07DataNoteHas推算) p1p2.push('L07 推算未标注（P2）');
  }
  result.checklist = { p1p2Fail: p1p2 };
  saveResult();
  log('==== 汇总 ====');
  log(JSON.stringify({ core: result.core, failedStages: coreFail, p1p2Fail: p1p2 }, null, 1));
  log(coreFail.length === 0 ? 'CORE PASS' : 'CORE FAIL：' + coreFail.join(', '));
  if (p1p2.length) log('P1/P2 未过（不改 exit 码，见汇总）：' + p1p2.join('；'));
  process.exit(coreFail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
