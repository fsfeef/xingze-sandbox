// 像素回归（E 路 · surpass §3.17，学参考帖子的 playwright 像素回归做法）
// 每次跑完把截图与上一轮同名截图做像素对比（在页面里用 canvas 读像素算差异），
// 突变（大面积变色 / 缺块）报警。
// 用法：
//   node tests/pixel-regress.js --baseline   # 把当前 tests/surpass-e-*.png 存为基线
//   node tests/pixel-regress.js              # 与基线对比，超阈值 exit 1
// 要求：http://localhost:8000 正在服务 ~/workspace/virtual-city
// 阈值：单通道差 >30 的像素占比 >5%，或平均绝对差 >10，即报警。
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname);
const BASE = path.join(DIR, 'pixel-baseline');
// 可移植：目录跟脚本走；Chromium 路径用 CHROMIUM_PATH，不指定时 playwright 自己找；
// 沙盘地址用 SANDBOX_URL 覆盖（默认 http://localhost:8000/tests/）。
const BASE_URL = (process.env.SANDBOX_URL || 'http://localhost:8000/tests/').replace(/\/app\/?$/, '/tests/').replace(/\/$/, '/');
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || undefined;
const MEAN_ALARM = 10;      // 平均绝对差（0–255）
const CHANGED_ALARM = 5;    // 变化像素占比 %（单通道差 >30）
const CHANGED_DELTA = 30;

const isBaseline = process.argv.includes('--baseline');

(async () => {
  const current = fs.readdirSync(DIR).filter((f) => f.startsWith('surpass-e-') && f.endsWith('.png')).sort();
  if (!current.length) { console.log('no surpass-e-*.png found in tests/'); process.exit(2); }
  if (isBaseline) {
    fs.mkdirSync(BASE, { recursive: true });
    for (const f of current) fs.copyFileSync(path.join(DIR, f), path.join(BASE, f));
    console.log(`baseline stored: ${current.length} files -> tests/pixel-baseline/`);
    console.log(current.join('\n'));
    process.exit(0);
  }
  const baseline = fs.existsSync(BASE) ? fs.readdirSync(BASE).filter((f) => f.endsWith('.png')) : [];
  if (!baseline.length) {
    console.log('no baseline yet. run: node tests/pixel-regress.js --baseline');
    process.exit(2);
  }
  const browser = await chromium.launch({
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');
  let alarms = 0;
  for (const f of current) {
    if (!baseline.includes(f)) { console.log(`${f}: NO BASELINE (new file, skipped)`); continue; }
    const r = await page.evaluate(async ({ a, b, delta }) => {
      async function load(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
        const bmp = await createImageBitmap(await res.blob());
        const cv = document.createElement('canvas');
        cv.width = bmp.width; cv.height = bmp.height;
        cv.getContext('2d').drawImage(bmp, 0, 0);
        return { w: bmp.width, h: bmp.height, data: cv.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data };
      }
      const A = await load(a), B = await load(b);
      if (A.w !== B.w || A.h !== B.h) return { sameSize: false, w: [A.w, B.w], h: [A.h, B.h] };
      let sum = 0, changed = 0;
      const n = A.w * A.h;
      for (let i = 0; i < A.data.length; i += 4) {
        const d0 = Math.abs(A.data[i] - B.data[i]);
        const d1 = Math.abs(A.data[i + 1] - B.data[i + 1]);
        const d2 = Math.abs(A.data[i + 2] - B.data[i + 2]);
        sum += d0 + d1 + d2;
        if (Math.max(d0, d1, d2) > delta) changed++;
      }
      return { sameSize: true, w: A.w, h: A.h, meanAbsDiff: +(sum / (n * 3)).toFixed(3), changedPct: +(100 * changed / n).toFixed(3) };
    }, { a: BASE_URL + 'pixel-baseline/' + f, b: BASE_URL + f, delta: CHANGED_DELTA });
    const alarm = r.sameSize && (r.meanAbsDiff > MEAN_ALARM || r.changedPct > CHANGED_ALARM);
    if (alarm) alarms++;
    console.log(`${f}: ${r.sameSize ? `meanAbsDiff=${r.meanAbsDiff} changedPct=${r.changedPct}% ${r.w}x${r.h}` : `SIZE MISMATCH baseline ${r.w} vs current ${r.h}`} ${alarm ? '<< ALARM 突变' : 'ok'}`);
  }
  await browser.close();
  console.log(alarms ? `RESULT: ${alarms} ALARM(S) — 突变，需人工看图` : 'RESULT: all compared files within threshold');
  process.exit(alarms ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
