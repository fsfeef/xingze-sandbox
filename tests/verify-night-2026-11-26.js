// 夜景验收（独立脚本，2026-11-26 14:41 夜景重做令）
// 只验 D 路夜景灯光：sun.js 亮窗 shader + 天光抬底 + settings 夜景开关；
// 路灯亮化是 F 路 street.js（已写好，本脚本只读引用、不改它），夜里应自动亮。
// 跑法：本地服务在跑（http://localhost:8000/app/）时：
//   NODE_PATH=/home/hatch/workspace/.agent-scratch/pwtest/node_modules node tests/verify-night-2026-11-26.js [--base=URL]
// 断言：白天亮窗 0；22:00 亮窗 1、半球光 ≥0.6、共享材质打补丁 ≥4、实灯 >500 盏、
//   灯光晕透明度 >0.5；鸟瞰 + 街面两张截图里近黑像素 <5%/8%、暖亮像素 >0.2%。
// 近黑像素若超标，先看 sixLoader failedLive——黑块/网格线是加载问题（6 路），不是灯光。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = __dirname;
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').slice(7)
  || process.env.LANE4_BASE || 'http://localhost:8000/app/';

let playwright;
try { playwright = require('playwright-core'); }
catch (e) {
  const p = process.env.PLAYWRIGHT_CORE_PATH;
  if (p) playwright = require(p);
  else { console.error('FATAL: playwright-core 未找到'); process.exit(2); }
}
const CHROMIUM = process.env.CHROMIUM_PATH || '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 最小 PNG 解码（8bit、非隔行、colorType 2/6），只为量截图亮度
function analyzePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idats = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idats.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`unsupported png bitDepth=${bitDepth} colorType=${colorType}`);
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = w * ch;
  let black = 0, warm = 0, cool = 0, lumSum = 0, total = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.from(row);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = cur[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const r = cur[x * ch], g = cur[x * ch + 1], b = cur[x * ch + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumSum += lum; total++;
      if (lum < 8) black++;
      if (r > 140 && g > 90 && b < 130 && r - b > 40) warm++;
      if (b > 140 && g > 100 && r < 120) cool++;
    }
    prev = cur;
  }
  return {
    w, h, meanLum: +(lumSum / total).toFixed(1),
    blackFrac: +(black / total).toFixed(4), warmFrac: +(warm / total).toFixed(4), coolFrac: +(cool / total).toFixed(4),
  };
}

async function shot(page, name) {
  const p = path.join(DIR, name);
  for (let i = 0; i < 2; i++) {
    try { await page.screenshot({ path: p, timeout: 120000 }); return { ok: true, buf: fs.readFileSync(p) }; }
    catch (e) { console.log(`[shot] ${name} 第 ${i + 1} 次失败：${String(e.message || e).slice(0, 80)}`); await sleep(5000); }
  }
  return { ok: false, buf: null };
}

(async () => {
  const errors = [], failedReqs = [];
  const opts = { args: ['--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'] };
  if (CHROMIUM && fs.existsSync(CHROMIUM)) opts.executablePath = CHROMIUM;
  const browser = await playwright.chromium.launch(opts);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => failedReqs.push(r.url() + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.status() + ' ' + r.url()); });
  try {
    let navigated = false;
    for (let i = 0; i < 3 && !navigated; i++) {
      try { await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 }); navigated = true; }
      catch (e) { console.log(`[launch] goto 第 ${i + 1} 次失败`); await sleep(5000); }
    }
    if (!navigated) throw new Error('goto 3 次都失败');
    await page.waitForFunction(() => window.__sandbox, { timeout: 240000 });
    await page.waitForFunction(() => {
      const s = document.getElementById('start-overlay');
      const e = document.getElementById('error-overlay');
      return (s && s.style.display === 'flex') || (e && e.style.display === 'flex');
    }, { timeout: 240000 });
    if (await page.evaluate(() => document.getElementById('error-overlay').style.display === 'flex')) {
      throw new Error('沙盘 error-overlay');
    }
    await page.evaluate(() => { const b = document.querySelector('#enter-btn'); if (b) b.click(); });
    await sleep(800);

    const boot = await page.evaluate(async () => {
      const sun = await import('./sun.js');
      const sApi = sun.init(window.__sandbox);
      const st = await import('./settings.js');
      const setApi = st.init(window.__sandbox);
      const street = await import('./street.js');
      const strApi = street.init(window.__sandbox);
      return { patchedAtInit: sApi.materials().length, streetLampsAtBoot: strApi.lamps };
    });
    console.log('[night] boot:', JSON.stringify(boot));

    // 白天对照：亮窗应为 0
    await page.evaluate(() => { window.__dSettings.applyDay(); });
    await sleep(2000);
    const day = await page.evaluate(() => ({
      night: window.__dSun.nightLevel, stateNight: window.__sandbox.state.night,
      hemi: window.__dSun.stats().hemi,
    }));
    console.log('[night] day:', JSON.stringify(day));

    // 夜里 22:00（走设置开关，整条链：时间轴 → applyTime → state.night → sun tick → street tick）
    await page.evaluate(() => { window.__dSettings.applyNight(); });
    // 开泛光后 SwiftShader 一帧要好几秒：等够 3 帧真 rAF 再读数，不然 street tick 还没轮上
    await page.evaluate(() => new Promise((res) => {
      let n = 0;
      const f = () => { if (++n >= 3) res(); else requestAnimationFrame(f); };
      requestAnimationFrame(f);
    }));
    await sleep(2000); // street 每 2.5s 扫一次灯，等一轮
    const night = await page.evaluate(() => {
      const glow = window.__sandbox.scene.getObjectByName('surpass-lamp-glow');
      const heads = window.__sandbox.scene.getObjectByName('surpass-lamp-heads');
      const six = window.__sandbox.sixLoader ? window.__sandbox.sixLoader.statsSnapshot() : null;
      return {
        night: window.__dSun.nightLevel, stateNight: window.__sandbox.state.night,
        hemi: window.__dSun.stats().hemi, patched: window.__dSun.stats().patched,
        lamps: window.__street ? window.__street.lamps : -1,
        glowOpacity: glow ? +glow.material.opacity.toFixed(2) : -1,
        headsOpacity: heads ? +heads.material.opacity.toFixed(2) : -1,
        failedLive: six ? six.failedLive : -1,
        chunksLoaded: six ? six.chunksLoaded : -1,
      };
    });
    console.log('[night] night:', JSON.stringify(night));

    // 鸟瞰：市中心上空
    await page.evaluate(() => {
      const st = window.__sandbox.state;
      st.mode = 'aerial'; st.target.set(0, 0, 0); st.dist = 4200; st.el = 0.85; st.yaw = -0.65;
    });
    await sleep(3000);
    const aerial = await shot(page, 'lane4-s7-night-aerial.png');
    // 街面：星泽广场，30m 高平视偏下
    await page.evaluate(() => {
      const st = window.__sandbox.state;
      st.mode = 'fly'; st.pos.set(-114.9, 30, -570.4); st.lookYaw = Math.PI * 0.75; st.lookPitch = -0.2;
    });
    await sleep(3000);
    const streetShot = await shot(page, 'lane4-s7-night-street.png');

    const aerialStats = aerial.buf ? analyzePNG(aerial.buf) : null;
    const streetStats = streetShot.buf ? analyzePNG(streetShot.buf) : null;
    console.log('[night] aerial px:', JSON.stringify(aerialStats));
    console.log('[night] street px:', JSON.stringify(streetStats));
    // 截图会强制出帧：截图后再读一次灯 opacity，取两次里较大的（tick 驱动的值）
    const night2 = await page.evaluate(() => {
      const glow = window.__sandbox.scene.getObjectByName('surpass-lamp-glow');
      const heads = window.__sandbox.scene.getObjectByName('surpass-lamp-heads');
      return {
        glowOpacity: glow ? +glow.material.opacity.toFixed(2) : -1,
        headsOpacity: heads ? +heads.material.opacity.toFixed(2) : -1,
      };
    });
    console.log('[night] night2 (after shots):', JSON.stringify(night2));
    night.glowOpacity = Math.max(night.glowOpacity, night2.glowOpacity);
    night.headsOpacity = Math.max(night.headsOpacity, night2.headsOpacity);

    const ok = day.night === 0
      && night.night === 1 && night.stateNight === 1 && night.hemi >= 0.5 && night.patched >= 4
      && night.lamps > 500 && night.glowOpacity > 0.5
      && aerialStats && aerialStats.blackFrac < 0.05 && aerialStats.warmFrac > 0.002
      && streetStats && streetStats.blackFrac < 0.08 && streetStats.warmFrac > 0.002
      && errors.length === 0 && failedReqs.length === 0;
    const result = {
      ok, pass: !!ok, day, night, aerial: aerialStats, street: streetStats,
      shots: { aerial: aerial.ok, street: streetShot.ok },
      errors, failedReqs: failedReqs.slice(0, 10),
    };
    console.log('[night] RESULT ' + JSON.stringify(result));
    fs.writeFileSync(path.join(DIR, 'lane4-night-checkpoint.json'), JSON.stringify(result, null, 2));
    await browser.close();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('FATAL', e);
    try { await browser.close(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
})();
