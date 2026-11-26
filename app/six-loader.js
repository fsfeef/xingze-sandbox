// 六区白模 GLB 流式加载器（星泽市沙盘 · 六区包）
// 数据源：~/workspace/virtual-city/white-model-six-districts/
//   chunks/index/manifest.json（行清单）→ chunks/index/shard_{cz}.json（按行取块）
//   chunks/{cx}_{cz}_high.glb / _mid.glb（500m 分块，世界坐标已烘焙，Y-up）
//   terrain/t_*.glb（城区地形，2000m 间距）+ terrain/far/f_*.glb（远山，3960m，自带位移）
//   fabric.glb（全城粗坯，远景底）
// 做法：fabric 常驻当远景底 + 近处 high 档 + 中环 mid 档，远糙近细；
//   材质全城共享 4 套（常态/热力/白膜/线），不随分块新建材质；
//   缺口只标不补：98_93 为空块直接跳过，97 块无 mid 文件则远处仍用 high。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const PKG = '../white-model-six-districts';
const CHUNK = 500, OX = -60000, OZ = -51000;
const HIGH_R = 1800;      // 距视点目标：high 档半径
const MID_R = 3500;       // mid 档半径（之外靠 fabric 粗坯）
const UNLOAD_PAD = 500;   // 卸载滞后，避免反复加载
const TERRAIN_R = 6000;   // 城区地形瓦片半径
const FAR_MAX = 96;       // 远山瓦片上限（按距离取最近）
const FAR_R = 120000;
const MAX_CONCURRENT = 6;

// 释放 GLB 自带材质（共享材质不释放；兼容多材质数组）
function disposeMaterial(mat, keep = []) {
  if (!mat) return;
  const list = Array.isArray(mat) ? mat : [mat];
  for (const m of list) if (m && !keep.includes(m)) m.dispose();
}

function heatGLSL() {
  // 注意：末尾必须留换行，否则拼到 fragmentShader 开头时 "}" 会和下一行的 #define 挤在同一行导致编译失败
  return `
  vec3 sixHeatColor(float h) {
    float t = clamp(h / 220.0, 0.0, 1.0);
    vec3 c;
    if (t < 0.5) c = mix(vec3(0.35, 0.62, 0.95), vec3(0.95, 0.85, 0.25), t * 2.0);
    else c = mix(vec3(0.95, 0.85, 0.25), vec3(0.90, 0.20, 0.15), (t - 0.5) * 2.0);
    return c;
  }
`;
}

export class SixLoader {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.onProgress = opts.onProgress || null;
    this.onLog = opts.onLog || null;
    this.manager = new THREE.LoadingManager();
    this.loader = new GLTFLoader(this.manager);
    // 远山瓦片是 gltfpack 压过的 meshopt（EXT_meshopt_compression），必须配解码器，否则 96 片全失败
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this._failedTiles = new Map(); // 地形/远山失败瓦片：30s 内不重试，防失败风暴拖垮帧率
    this.chunks = new Map();      // key "cx_cz" -> {cx,cz,x0,z0,rec,high,mid,level,failedAt,retries}
    this.shards = new Map();      // cz -> {chunks:{...}} | 'loading' | Promise
    this.rows = null;             // manifest rows
    this.terrainIndex = null;     // {t_tx_tz: {tx,tz}}
    this.farIndex = null;         // {f_tx_tz: {tx,tz}}
    this.terrain = new Map();     // key -> mesh
    this.far = new Map();         // key -> mesh
    this.fabric = null;
    this.display = 'normal';
    this.buildingMeshes = new Set(); // 参与热力/白膜切换的三角网格（分块 + fabric）
    this.stats = {
      chunksHigh: 0, chunksMid: 0, chunksLoaded: 0, chunksFailed: 0,
      terrainTiles: 0, farTiles: 0, fabricLoaded: false,
      filesLoaded: 0, filesFailed: 0,
    };
    this._tmpV = new THREE.Vector3();
    this._raycaster = new THREE.Raycaster();
    this._rayDown = new THREE.Vector3(0, -1, 0);
    this._groundCache = { x: 0, z: 0, y: 0, t: 0 };
    this._lastUpdate = 0;
    this._firstLog = new Set();
    this._loadQueue = [];         // {key, level, dist}
    this._activeLoads = 0;
    this._initialDone = false;

    // 全城共享材质（不随分块新建，避免 program/材质爆炸）
    this.matNormal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    this.matClay = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.95, metalness: 0 });
    this.matHeat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
    this.matHeat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSixWorldY;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSixWorldY = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = (heatGLSL() + shader.fragmentShader)
        .replace('#include <common>', '#include <common>\nvarying vec3 vSixWorldY;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb = sixHeatColor(vSixWorldY.y);');
    };
    this.matLine = new THREE.LineBasicMaterial({ vertexColors: true });
    this.matFabric = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
    });
    // fabric 是全城粗坯，与精细块重叠，热力/白膜模式也要保留 polygonOffset 防闪烁
    this.matFabricClay = new THREE.MeshStandardMaterial({
      color: 0xf2f0ea, roughness: 0.95, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
    });
    this.matFabricHeat = new THREE.MeshStandardMaterial({
      roughness: 0.85, metalness: 0.05,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
    });
    this.matFabricHeat.onBeforeCompile = this.matHeat.onBeforeCompile;
    this.matTerrain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });

    // 地形组（供地面高度射线查询）
    this.terrainGroup = new THREE.Group();
    this.terrainGroup.name = 'six-terrain';
    scene.add(this.terrainGroup);
    this.chunkGroup = new THREE.Group();
    this.chunkGroup.name = 'six-chunks';
    scene.add(this.chunkGroup);
    this.fabricGroup = new THREE.Group();
    this.fabricGroup.name = 'six-fabric';
    scene.add(this.fabricGroup);
  }

  _log(msg) { if (this.onLog) this.onLog(msg); else console.log('[six]', msg); }

  _triMat() {
    return this.display === 'heat' ? this.matHeat : this.display === 'white' ? this.matClay : this.matNormal;
  }

  // ---------- 目录 ----------
  async _fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }

  async loadCatalog() {
    const mani = await this._fetchJSON(`${PKG}/chunks/index/manifest.json`);
    this.rows = mani.rows || [];
    const ti = await this._fetchJSON(`${PKG}/terrain/index.json`);
    this.terrainIndex = ti.terrain || {};
    const fi = await this._fetchJSON(`${PKG}/terrain/far/index.json`);
    this.farIndex = fi.terrain_far || {};
    this._log(`catalog: rows=${this.rows.length} terrain=${Object.keys(this.terrainIndex).length} far=${Object.keys(this.farIndex).length}`);
  }

  async _shard(cz) {
    if (this.shards.has(cz)) return this.shards.get(cz);
    const p = this._fetchJSON(`${PKG}/chunks/index/shard_${cz}.json`).then((d) => {
      const chunks = d.chunks || d;
      this.shards.set(cz, chunks);
      return chunks;
    }).catch((e) => {
      console.error('[six] shard failed', cz, e);
      this.shards.set(cz, {});
      return {};
    });
    this.shards.set(cz, p);
    return p;
  }

  async _rowsFor(tz, radius) {
    // 行号 cz = floor((z - OZ)/500)；取 tz±radius 覆盖的行，并行取 shard
    const r0 = Math.floor((tz - radius - OZ) / CHUNK);
    const r1 = Math.floor((tz + radius - OZ) / CHUNK);
    const rows = [];
    for (let cz = r0; cz <= r1; cz++) {
      if (!this.rows || this.rows.includes(cz)) rows.push(cz);
    }
    return Promise.all(rows.map((cz) => this._shard(cz)));
  }

  _chunkCenter(rec) { return { x: rec.x0 + CHUNK / 2, z: rec.z0 + CHUNK / 2 }; }

  // ---------- GLB 加载 ----------
  _applySharedMaterials(root) {
    root.traverse((o) => {
      if (!o.isMesh && !o.isLine) return;
      o.matrixAutoUpdate = false;
      o.updateMatrix();
      if (o.isMesh) {
        // 分块自带材质与共享材质参数一致（白底 rough 0.95），直接替换并释放原材质
        disposeMaterial(o.material, [this.matNormal, this.matClay, this.matHeat, this.matFabric]);
        o.material = this._triMat();
        this.buildingMeshes.add(o);
      } else if (o.isLine) {
        disposeMaterial(o.material, [this.matLine]);
        o.material = this.matLine;
      }
      o.frustumCulled = true;
    });
  }

  _logBoundsOnce(tag, root) {
    if (this._firstLog.has(tag)) return;
    this._firstLog.add(tag);
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3(); box.getSize(size);
    const c = new THREE.Vector3(); box.getCenter(c);
    this._log(`${tag} bounds center=(${c.x.toFixed(0)},${c.y.toFixed(1)},${c.z.toFixed(0)}) size=(${size.x.toFixed(0)},${size.y.toFixed(1)},${size.z.toFixed(0)})`);
  }

  async _loadGLB(url) {
    const gltf = await this.loader.loadAsync(url);
    this.stats.filesLoaded++;
    return gltf.scene;
  }

  async _loadChunkFile(key, level) {
    const e = this.chunks.get(key);
    if (!e) return;
    const url = `${PKG}/chunks/${key}_${level}.glb`;
    try {
      const root = await this._loadGLB(url);
      if (!this.chunks.has(key)) { // 加载期间已被卸载：释放已解码的几何与材质
        root.traverse((o) => {
          if (o.isMesh || o.isLine) {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
              if (Array.isArray(o.material)) o.material.forEach((m) => { if (m) m.dispose(); });
              else o.material.dispose();
            }
          }
        });
        return;
      }
      this._applySharedMaterials(root);
      this._logBoundsOnce(`chunk-${level}`, root);
      e[level] = root;
      this.chunkGroup.add(root);
      this.stats.chunksLoaded++;
      if (level === 'high') this.stats.chunksHigh++;
      else this.stats.chunksMid++;
      this._setChunkLevel(e);
    } catch (err) {
      this.stats.filesFailed++;
      this.stats.chunksFailed++;
      console.error('[six] chunk load failed', url, err);
      e.failedAt = performance.now();
      e.retries = (e.retries || 0) + 1;
    }
  }

  _setChunkLevel(e) {
    // 手动 LOD：近处 high，远处 mid（无 mid 则一直 high）
    const d = e._camDist !== undefined ? e._camDist : 0;
    const showHigh = !e.mid || d < HIGH_R;
    if (e.high) e.high.visible = showHigh;
    if (e.mid) e.mid.visible = !showHigh;
    e.level = showHigh ? 'high' : 'mid';
  }

  _disposeChunk(key) {
    const e = this.chunks.get(key);
    if (!e) return;
    for (const lvl of ['high', 'mid']) {
      const root = e[lvl];
      if (!root) continue;
      this.chunkGroup.remove(root);
      root.traverse((o) => {
        if (o.isMesh || o.isLine) {
          if (o.geometry) o.geometry.dispose();
          this.buildingMeshes.delete(o);
          // 材质是共享的，不释放
        }
      });
      if (lvl === 'high') this.stats.chunksHigh--;
      else this.stats.chunksMid--;
      this.stats.chunksLoaded--;
    }
    this.chunks.delete(key);
  }

  // ---------- 主更新（节流 250ms，由 app.js 每帧调用） ----------
  update(view) {
    const now = performance.now();
    if (now - this._lastUpdate < 250 && this._initialDone) return;
    this._lastUpdate = now;
    this._view = view;
    this._refresh(view).catch((e) => console.error('[six] refresh failed', e));
  }

  async _refresh(view) {
    const now = performance.now();
    const { tx, tz, camX, camY, camZ, mode, aerialDist } = view;
    // 1) 取目标附近行的分块记录
    const shardMaps = await this._rowsFor(tz, MID_R + UNLOAD_PAD);
    const near = new Map(); // key -> {rec, dist}
    for (const sm of shardMaps) {
      for (const [key, rec] of Object.entries(sm)) {
        if (!rec || rec.bytes_high === 0 && rec.bytes_mid === 0) continue; // 空块（98_93）跳过
        const c = this._chunkCenter(rec);
        const d = Math.hypot(c.x - tx, c.z - tz);
        if (d < MID_R + UNLOAD_PAD) near.set(key, { rec, dist: d });
      }
    }
    // 2) 卸载出界的分块（滞后半径外）
    for (const [key, e] of [...this.chunks.entries()]) {
      const n = near.get(key);
      if (!n) {
        // 不在附近行里：按中心距目标判断（行外也可能仍在半径内，保守起见只卸确定远的）
        const c = this._chunkCenter(e.rec);
        if (Math.hypot(c.x - tx, c.z - tz) > MID_R + UNLOAD_PAD) this._disposeChunk(key);
      }
    }
    // 3) 入队需要加载的分块（近处优先）
    const want = [];
    for (const [key, { rec, dist }] of near.entries()) {
      let e = this.chunks.get(key);
      if (!e) {
        e = { cx: rec.cx, cz: rec.cz, x0: rec.x0, z0: rec.z0, rec, high: null, mid: null, level: null, retries: 0, failedAt: 0 };
        this.chunks.set(key, e);
      }
      const needHigh = dist < HIGH_R;
      const needMid = dist < MID_R && rec.bytes_mid > 0 && rec.sha256_mid;
      if (needHigh && !e.high && !e._loadingHigh && !(e.failedAt && e.retries >= 1 && now - e.failedAt < 10000)) {
        want.push({ key, level: 'high', dist });
      } else if (!needHigh && needMid && !e.mid && !e._loadingMid && !(e.failedAt && e.retries >= 1 && now - e.failedAt < 10000)) {
        want.push({ key, level: 'mid', dist });
      }
      // 远处已有 high 但无 mid 时不额外加载 mid（high 顶着）
    }
    want.sort((a, b) => a.dist - b.dist);
    for (const w of want) {
      const e = this.chunks.get(w.key);
      if (!e) continue;
      if (w.level === 'high') e._loadingHigh = true; else e._loadingMid = true;
      this._pumpLoad(w);
    }
    // 4) LOD 可见切换（按相机距离）
    for (const e of this.chunks.values()) {
      const c = this._chunkCenter(e.rec);
      e._camDist = Math.hypot(c.x - camX, c.z - camZ, 0);
      // 相机高度也计入（航拍高空看远处仍用 mid）
      const dy = Math.max(0, camY - 60);
      e._camDist = Math.hypot(e._camDist, dy * 0.6);
      this._setChunkLevel(e);
    }
    // 5) fabric 远景底：航拍很近时隐藏，避免与近处分块重叠闪烁
    if (this.fabric) {
      this.fabric.visible = !(mode === 'aerial' && aerialDist < 800);
    }
    // 6) 地形 + 远山
    this._refreshTerrain(tx, tz);
  }

  _pumpLoad(w) {
    if (this._activeLoads >= MAX_CONCURRENT) {
      setTimeout(() => this._pumpLoad(w), 120);
      return;
    }
    this._activeLoads++;
    const e = this.chunks.get(w.key);
    this._loadChunkFile(w.key, w.level).finally(() => {
      this._activeLoads--;
      const e2 = this.chunks.get(w.key);
      if (e2) {
        if (w.level === 'high') e2._loadingHigh = false; else e2._loadingMid = false;
      }
    });
  }

  async _refreshTerrain(tx, tz) {
    if (!this.terrainIndex) return;
    // 城区地形：2000m 间距，取目标 ±TERRAIN_R 内的瓦片
    const want = new Set();
    for (const [key, t] of Object.entries(this.terrainIndex)) {
      const cx = t.tx * 2000 + 990, cz = t.tz * 2000 + 990;
      if (Math.hypot(cx - tx, cz - tz) < TERRAIN_R) want.add(key);
    }
    for (const key of [...this.terrain.keys()]) {
      if (!want.has(key)) {
        const m = this.terrain.get(key);
        this.terrainGroup.remove(m);
        if (m.geometry) m.geometry.dispose();
        this.terrain.delete(key);
        this.stats.terrainTiles--;
      }
    }
    for (const key of want) {
      if (this.terrain.has(key) || this.terrain.get(key + ':loading')) continue;
      const fAt = this._failedTiles.get('t:' + key);
      if (fAt && performance.now() - fAt < 30000) continue; // 30s 内不重试失败瓦片
      this.terrain.set(key + ':loading', true);
      this._loadGLB(`${PKG}/terrain/${key}.glb`).then((root) => {
        this.terrain.delete(key + ':loading');
        const mesh = root.children[0] || root;
        if (mesh.isMesh) {
          disposeMaterial(mesh.material, [this.matTerrain]);
          mesh.material = this.matTerrain;
          mesh.matrixAutoUpdate = false; mesh.updateMatrix();
          mesh.frustumCulled = true;
          this.terrainGroup.add(mesh);
          this.terrain.set(key, mesh);
          this.stats.terrainTiles++;
          this._logBoundsOnce('terrain', mesh);
        }
      }).catch((err) => {
        this.terrain.delete(key + ':loading');
        this.stats.filesFailed++;
        this._failedTiles.set('t:' + key, performance.now());
        console.error('[six] terrain load failed', key, err);
      });
    }
    // 远山：取最近 FAR_MAX 片
    if (this.farIndex) {
      const cands = [];
      for (const [key, t] of Object.entries(this.farIndex)) {
        const cx = t.tx * 3960 + 1980, cz = t.tz * 3960 + 1980;
        const d = Math.hypot(cx - tx, cz - tz);
        if (d < FAR_R) cands.push({ key, d });
      }
      cands.sort((a, b) => a.d - b.d);
      const wantFar = new Set(cands.slice(0, FAR_MAX).map((c) => c.key));
      for (const key of [...this.far.keys()]) {
        if (!wantFar.has(key)) {
          const m = this.far.get(key);
          this.terrainGroup.remove(m);
          if (m.geometry) m.geometry.dispose();
          this.far.delete(key);
          this.stats.farTiles--;
        }
      }
      for (const key of wantFar) {
        if (this.far.has(key) || this.far.get(key + ':loading')) continue;
        const fAt = this._failedTiles.get('f:' + key);
        if (fAt && performance.now() - fAt < 30000) continue; // 30s 内不重试失败瓦片
        this.far.set(key + ':loading', true);
        this._loadGLB(`${PKG}/terrain/far/${key}.glb`).then((root) => {
          this.far.delete(key + ':loading');
          const mesh = root.children[0] || root;
          if (mesh.isMesh) {
            disposeMaterial(mesh.material, [this.matTerrain]);
            mesh.material = this.matTerrain;
            mesh.matrixAutoUpdate = false; mesh.updateMatrix();
            mesh.frustumCulled = true;
            this.terrainGroup.add(mesh);
            this.far.set(key, mesh);
            this.stats.farTiles++;
            this._logBoundsOnce('far', mesh);
          }
        }).catch((err) => {
          this.far.delete(key + ':loading');
          this.stats.filesFailed++;
          this._failedTiles.set('f:' + key, performance.now());
          console.error('[six] far terrain load failed', key, err);
        });
      }
    }
  }

  // ---------- 初始加载（fabric + 目标附近首批分块 + 地形） ----------
  async loadInitial(view, onProgress) {
    await this.loadCatalog();
    // fabric 常驻
    try {
      const root = await this._loadGLB(`${PKG}/fabric.glb`);
      root.traverse((o) => {
        if (o.isMesh) {
          disposeMaterial(o.material, [this.matFabric]);
          o.material = this.matFabric;
          o.matrixAutoUpdate = false; o.updateMatrix();
          this.buildingMeshes.add(o);
          this.fabricMesh = o;
        }
      });
      this.fabric = root;
      this.fabricGroup.add(root);
      this.stats.fabricLoaded = true;
      this._logBoundsOnce('fabric', root);
    } catch (err) {
      this.stats.filesFailed++;
      console.error('[six] fabric load failed', err);
    }
    // 首批只等 high 档（近处）；mid 环由 update() 流式补，不阻塞首屏
    const shardMaps = await this._rowsFor(view.tz, MID_R + UNLOAD_PAD);
    const jobs = [];
    for (const sm of shardMaps) {
      for (const [key, rec] of Object.entries(sm)) {
        if (!rec || rec.bytes_high === 0 && rec.bytes_mid === 0) continue;
        const c = this._chunkCenter(rec);
        const d = Math.hypot(c.x - view.tx, c.z - view.tz);
        if (d < HIGH_R) {
          if (!this.chunks.has(key)) {
            this.chunks.set(key, { cx: rec.cx, cz: rec.cz, x0: rec.x0, z0: rec.z0, rec, high: null, mid: null, level: null, retries: 0, failedAt: 0 });
          }
          jobs.push({ key, level: 'high', dist: d });
        }
      }
    }
    jobs.sort((a, b) => a.dist - b.dist);
    let done = 0;
    const total = jobs.length + 1; // +fabric
    const tick = () => { done++; if (onProgress) onProgress(done / total); };
    tick(); // fabric 已完成
    // 分批并发加载首批
    const BATCH = MAX_CONCURRENT;
    for (let i = 0; i < jobs.length; i += BATCH) {
      const batch = jobs.slice(i, i + BATCH);
      await Promise.all(batch.map(async (w) => {
        const e = this.chunks.get(w.key);
        if (e) { if (w.level === 'high') e._loadingHigh = true; else e._loadingMid = true; }
        try { await this._loadChunkFile(w.key, w.level); } finally {
          const e2 = this.chunks.get(w.key);
          if (e2) { if (w.level === 'high') e2._loadingHigh = false; else e2._loadingMid = false; }
          tick();
        }
      }));
    }
    // 首批地形（不等远山）
    this._refreshTerrain(view.tx, view.tz);
    this._initialDone = true;
    this.update(view); // 立即刷新一次 LOD/可见性
  }

  // ---------- 显示模式 ----------
  setDisplay(mode) {
    this.display = mode;
    const tri = this._triMat();
    for (const m of this.buildingMeshes) {
      // fabric 与分块三角网格都参与切换；线网格不在 buildingMeshes 里
      m.material = tri;
    }
    // fabric 单独处理：保留 polygonOffset，防与精细块重叠闪烁
    if (this.fabricMesh) {
      this.fabricMesh.material = mode === 'heat' ? this.matFabricHeat
        : mode === 'white' ? this.matFabricClay : this.matFabric;
    }
  }

  // ---------- 地面高度（走路/开车用，节流缓存） ----------
  groundHeightAt(x, z) {
    const now = performance.now();
    const c = this._groundCache;
    if (now - c.t < 150 && Math.hypot(x - c.x, z - c.z) < 2) return c.y;
    this._tmpV.set(x, 300, z);
    this._raycaster.set(this._tmpV, this._rayDown);
    this._raycaster.far = 400;
    const hits = this._raycaster.intersectObjects(this.terrainGroup.children, false);
    let y = null;
    if (hits.length) y = hits[0].point.y;
    // 兜底：平原地面约 0~5m，用上次值或 3.0
    if (y === null || !isFinite(y)) y = (now - c.t < 5000) ? c.y : 3.0;
    c.x = x; c.z = z; c.y = y; c.t = now;
    return y;
  }

  statsSnapshot() {
    return { ...this.stats };
  }
}
