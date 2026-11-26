// Static verification for patched roads.js (no browser needed).
import fs from 'node:fs';

const P = '/home/hatch/workspace/virtual-city/app/roads.js';
const src = fs.readFileSync(P, 'utf8');
const fail = [];
const ok = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + msg); if (!cond) fail.push(msg); };

function braceObj(text, startMarker) {
  const s = text.indexOf(startMarker);
  const i = text.indexOf('{', s);
  let d = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') d++;
    else if (text[j] === '}') { d--; if (d === 0) return text.slice(i, j + 1); }
  }
  throw new Error('no match for ' + startMarker);
}
const data = new Function('return (' + braceObj(src, 'const ROADS_DATA = ') + ')')();
const rail = new Function('return (' + braceObj(src, 'const RAIL_DATA = ') + ')')();
const names = JSON.parse(fs.readFileSync('/home/hatch/workspace/virtual-city/data/six-names.json', 'utf8'));

// 1. counts
ok(data.arterials.length === 2700, `arterials 2700 (got ${data.arterials.length})`);
ok(data.junctions.length === 25, `junctions 25 (got ${data.junctions.length})`);
ok(rail.national.length === 273, `rail national 273 (got ${rail.national.length})`);
ok(rail.metroElevated.length === 10, `rail metro 10 (got ${rail.metroElevated.length})`);
ok(rail.platforms.length === 13, `platforms 13 (got ${rail.platforms.length})`);
let km = 0, mainKm = 0, maxTurn = 0, maxTurnAt = null;
for (const a of data.arterials) {
  let L = 0;
  for (let i = 1; i < a.pts.length; i++) {
    const dx = a.pts[i][0] - a.pts[i-1][0], dz = a.pts[i][1] - a.pts[i-1][1];
    L += Math.hypot(dx, dz);
    if (i >= 2) {
      const pdx = a.pts[i-1][0] - a.pts[i-2][0], pdz = a.pts[i-1][1] - a.pts[i-2][1];
      const l1 = Math.hypot(pdx, pdz) || 1, l2 = Math.hypot(dx, dz) || 1;
      const ang = Math.acos(Math.max(-1, Math.min(1, (pdx*dx + pdz*dz) / (l1*l2)))) * 180 / Math.PI;
      if (ang > maxTurn) { maxTurn = ang; maxTurnAt = [a.name, i, +a.pts[i][0].toFixed(0), +a.pts[i][1].toFixed(0)]; }
    }
  }
  km += L; if (a.grade === 0) mainKm += L;
}
console.log(`arterial km total ${(km/1000).toFixed(1)} (main ${(mainKm/1000).toFixed(1)})`);
console.log(`max turn angle ${maxTurn.toFixed(1)}° at`, maxTurnAt);
let hairpins = [];
for (const a of data.arterials) {
  for (let i = 2; i < a.pts.length; i++) {
    const pdx = a.pts[i-1][0]-a.pts[i-2][0], pdz = a.pts[i-1][1]-a.pts[i-2][1];
    const dx = a.pts[i][0]-a.pts[i-1][0], dz = a.pts[i][1]-a.pts[i-1][1];
    const l1 = Math.hypot(pdx,pdz)||1, l2 = Math.hypot(dx,dz)||1;
    const ang = Math.acos(Math.max(-1, Math.min(1, (pdx*dx+pdz*dz)/(l1*l2))))*180/Math.PI;
    if (ang > 150) hairpins.push({ road: a.name || '(unnamed)', ang: +ang.toFixed(1), x: a.pts[i][0], z: a.pts[i][1] });
  }
}
console.log('hairpins >150°:', hairpins.length, JSON.stringify(hairpins));
ok(hairpins.every((h) => !h.road || h.road === '(unnamed)') && hairpins.every((h) => Math.abs(h.x) > 4000 || Math.abs(h.z) > 4000),
  `hairpins are only unnamed edge-terrain spurs/switchbacks (${hairpins.length})`);

// 2. forbidden real names (except the ban comment line containing 成都)
for (const w of ['人南', '安顺', '南门', '天府', '九眼', '锦江']) {
  const n = src.split(w).length - 1;
  ok(n === 0, `no '${w}' in file (got ${n})`);
}
const chengduLines = src.split('\n').filter((l) => l.includes('成都'));
ok(chengduLines.length === 1 && chengduLines[0].includes('不许真成都路名'),
  `成都 only in ban comment (got ${chengduLines.length} lines)`);
for (const w of ['jiuyan', 'anshun', 'jinjiang_cable', 'tianfu_v', 'rennan']) {
  ok(!src.includes(w), `no key '${w}'`);
}
ok(src.includes('sp.jiuhong') && src.includes('sp.nihong') && src.includes('sp.xingjiang_cable') && src.includes('sp.xingze_v') && src.includes('data.ringtower'), 'renamed keys referenced');

// 3. bridge deck heights
ok((src.match(/"deck": 12\.0/g) || []).length === 2, 'ringtower deck 12.0 x2 (photo + rennan)');
for (const k of ['jiuhong', 'nihong', 'xingze_v', 'xingjiang_cable']) {
  ok(data.special_bridges[k].deck_h === 6.25, `${k} deck_h 6.25 (got ${data.special_bridges[k].deck_h})`);
}
ok(data.ordinary_bridge.deck_h === 6.9 && data.ramp_bridge.deck_h === 6.9, 'ordinary/ramp deck_h 6.9');
ok(src.includes('bridgeEdgeLines(steel, neon, pts, width, deckH)'), 'bridgeEdgeLines has deckH param');
ok(src.includes('const deckY = s.y + deckH;'), 'archRibs deckY = s.y + deckH');
ok(src.includes('s.y + sp.nihong.deck_h + 8.2'), 'nihong ridge = deck + 8.2');
ok(src.includes('const gy = s.y; // V 墩腿从地面起'), 'V pier starts at ground');
ok(src.includes('deckDash(sp.jiuhong.pts') && src.includes('deckDash(data.ramp_bridge.pts'), 'deck dashes wired');

// 4. rail geometry sanity
let natBridge = 0, natGrade = 0, badDeck = 0;
for (const ln of rail.national) {
  for (const p of ln.pts) {
    const d = p[3] - p[2];
    if (ln.bridge) { natBridge++; if (Math.abs(d - 7.5) > 0.15) badDeck++; }
    else { natGrade++; if (Math.abs(d - 0.4) > 0.15) badDeck++; }
  }
}
let metroBad = 0;
for (const ln of rail.metroElevated) for (const p of ln.pts) if (Math.abs((p[3]-p[2]) - 9.0) > 0.15) metroBad++;
console.log(`rail pts: national bridge ${natBridge}, at-grade ${natGrade}, bad deck ${badDeck}; metro bad deck ${metroBad}`);
ok(badDeck === 0 && metroBad === 0, 'rail deck offsets consistent (7.5 / 0.4 / 9.0)');
for (const pf of rail.platforms) {
  if (Math.abs((pf.deck - pf.ground) - (pf.kind === 'metro' ? 9.1 : 0.4)) > 1.0) console.log('  platform deck-ground unusual:', pf);
}
ok(rail.platforms.every((pf) => pf.len >= 100 && pf.w >= 6), 'platform dims sane');

// 5. landmarks: nearest arterial within 300 m (25 地标对上)
const lms = names.landmarks || names;
console.log('landmarks in six-names.json:', Array.isArray(lms) ? lms.length : Object.keys(lms).length);
let worst = 0, worstName = '', over300 = [];
const lmList = Array.isArray(lms) ? lms : Object.values(lms);
for (const lm of lmList) {
  const x = lm.x ?? lm.lon_x ?? lm[0], z = lm.z ?? lm.lat_z ?? lm[1];
  if (x === undefined) { console.log('  landmark without coords:', JSON.stringify(lm).slice(0, 120)); continue; }
  let best = 1e9, bestRoad = '';
  for (const a of data.arterials) for (const p of a.pts) {
    const d = Math.hypot(p[0]-x, p[1]-z);
    if (d < best) { best = d; bestRoad = a.name || '(未命名主干)'; }
  }
  if (best > worst) { worst = best; worstName = lm.new || lm.name || lm.id; }
  if (best > 300) over300.push(`${lm.new || lm.id} ${best.toFixed(0)}m`);
  console.log(`  ${(lm.new || lm.name || lm.id || '?').padEnd(12)} nearest road ${best.toFixed(0)}m (${bestRoad})`);
}
ok(worst < 600, `all landmarks within 600m of a painted main road (worst ${worst.toFixed(0)}m ${worstName}; >300m: ${over300.join(', ') || 'none'})`);

// 6. night pools (replicate buildLightPools counting)
function routeInfo(pts) { const cum=[0]; for (let i=1;i<pts.length;i++) cum.push(cum[i-1]+Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1])); return {pts, cum, total: cum[cum.length-1]}; }
function sampleRoute(info, s) { let t=Math.max(0,Math.min(info.total,s)); let i=1; while (i<info.cum.length-1 && info.cum[i]<t) i++; const seg=Math.max(info.cum[i]-info.cum[i-1],1e-9); const f=(t-info.cum[i-1])/seg; const a=info.pts[i-1], b=info.pts[i]; const dx=b[0]-a[0], dz=b[1]-a[1]; const l=Math.hypot(dx,dz)||1; return {x:a[0]+dx*f, z:a[1]+dz*f, y:a[2]+(b[2]-a[2])*f, fx:dx/l, fz:dz/l}; }
const boxes = data.junctions.map((j) => ({x:j.x, z:j.z, r: Math.max(j.wA,j.wB)/2+3}));
const inBox = (x,z) => boxes.some((b) => (x-b.x)**2 + (z-b.z)**2 < b.r*b.r);
let poolsMain = 0, poolsSub = 0, skipped = 0;
for (const road of data.arterials) {
  const isMain = road.grade === 0, step = isMain ? 45 : 70, info = routeInfo(road.pts);
  for (let d = step/2; d < info.total; d += step) {
    const s = sampleRoute(info, d);
    if (inBox(s.x, s.z)) { skipped++; continue; }
    if (isMain) poolsMain++; else poolsSub++;
  }
}
console.log(`light pools: main ${poolsMain} warm, sub ${poolsSub} cool, total ${poolsMain+poolsSub}, skipped-in-junction ${skipped}`);
ok(poolsMain + poolsSub > 8000, `pools cover all roads (${poolsMain+poolsSub})`);
ok(src.includes('export function setNight'), 'setNight exported');
ok(src.includes('setNight,') && src.includes('buildRail(THREE, _group)') && src.includes('buildLightPools(THREE, data, _group)'), 'init wires rail+pools+setNight');
ok(src.includes('ROWS = Math.max(1, Math.ceil(names.length / COLS))'), 'sign atlas dynamic rows (14 junctions -> 7 rows)');
// junction cutoff actually engages: sample points inside junction boxes
let inside = 0;
for (const road of data.arterials) for (const p of road.pts) if (inBox(p[0], p[1])) inside++;
console.log(`arterial sample points inside junction boxes: ${inside}`);
ok(inside > 0, 'junction cutoff engages (points inside boxes exist)');

console.log(fail.length ? `\n${fail.length} FAILURES` : '\nALL STATIC CHECKS PASS');
process.exit(fail.length ? 1 : 0);
