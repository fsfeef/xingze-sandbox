#!/usr/bin/env python3
"""全城白模生成器 v3（format_version=3，总攻版）。
只读源数据，输出到 white-model/chunks|terrain|fabric.glb + index/manifest。
用法：python3 build_chunks.py [--chunk-range A B] [--only TYPE] [--limit N]
       [--heights FILE] [--only-chunks FILE]
可断点续跑：generation-log.json 记录已完成块（format_version 3 强制全量重建）。

v3 相对 v2 的改动（2026-11-25 总攻）：
- 地形 DEM 换 6 瓦片 Copernicus（data/batch1/dem/chengdu-dem-90m-full-latlon.npy，
  lon 102.8-105.0 / lat 30.0-31.6，row0=北）；旧 4 瓦片 data/dem/chengdu-dem-90m.npy
  已实测证实错误（西南平原读 2000m、青城山读 646m、九顶山读 417m），停用。
  DATUM 524 -> 506（新 DEM 天府广场 506.1 -> 约 0）。兴隆湖湖面 DEM 单元压到 464m。
- 水：batch1 water-v1（线 4,089 + 面 1,891）+ 11 条湖记录（9 个湖名）已拼 multipolygon（lakes-assembled-v1）；
  六区内 5 条记录（北湖/锦城湖/白鹭湾×2/升仙湖），其余 6 条在区外（裁剪所致，非缺失；
  其中青龙湖 rel 10660802 几何落在 lon 105.56，源文件损坏待重拼）；
  水面/用地按分块裁剪入块（clip），不只按质心入块。
- 用地：landuse-v1 15,164 面（park/green/residential/commercial/industrial/parking/square）
  按类别画地面色块（简化到 ≤64 点，<200m² 跳过，洞忽略）。
- 国铁：national-rail-v1（24,438 线 / 530 站）按模型范围过滤；4 大站 + 龙泉驿站加粗。
- 路灯：lamps-city 418,888 盏画杆线（high 层；位置为沿真实 OSM 路按 CJJ45 间距放置，非 OSM 原值）。
- 植被：WorldCover 10m 树盖 60m 步长采样（封顶 20 万棵，哈希定高 4-8m，估算/采样）+
  OSM natural=tree 实测单木 1,207 棵（真实位置，高度哈希估算）。
- 绿道：路名含“绿道”的 155 条（绕城绿道 84、龙泉山森林绿道 33、锦江绿道 16 等）画 4m 绿带。
- 机场：aeroway-v1（天府/双流跑道 5 条含真实宽度 45/60m、滑行道、停机坪）。
- 特型桥：bridge-shapes.json 7 座按 params 建（悬索塔+主缆+吊索、贯通拱、V 墩、廊桥顶、九孔拱），
  2 环特征（红牌楼牌坊 12m、二环人南斜拉塔 30m）；锦江斜拉桥只建桥面、不编造桥塔。
- 车行道：road-widths-v1 画带宽面（high 层；步行道仍画线；高架路仍画线）。
- 山上点位：mountain-pois-v1 有名山峰/观景点在模型范围内画小标记（范围外进远景地形）。
- 楼高默认 v2.1（md5 89553a02，实测 3,427 栋）。接楼高按建筑轮廓 join，绝对不许按数组下标。
- 缺口不许造假顶上：补不上的空着、进 GAPS.md；来源标注四档（真实/估算/参考/未核实），推算标推算。
- 军事/敏感用地、商标 logo、雕塑 1:1 等红线见 STANDARD.md，不在此展开。
"""
import json, math, os, sys, struct, hashlib, argparse, glob
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hw_interchange import (LINK, SCOPE, own_deck, key_of, way_pts,
                            build_node_index, estimate_endpoints, reconcile,
                            vertex_heights)

FORMAT_VERSION = 3
# SIX-DISTRICT CROP (2026-11-25): sources stay READ-ONLY in chengdu-city;
# output goes to the virtual-city six-district directory.
ROOT = "/home/hatch/workspace/chengdu-city"
DATA = os.path.join(ROOT, "data")
WM = os.path.join(ROOT, "white-model")
OUT = "/home/hatch/workspace/virtual-city/white-model-six-districts"
VC = "/home/hatch/workspace/virtual-city"   # 2026-11-27 D3：桥/公园/BRT/水口数据文件所在目录
CHUNK = 500.0
OX, OZ = -60000.0, -51000.0   # chunk 网格原点（米；覆盖道路/河流外延）
DATUM = 506.0                 # DEM 绝对高程 - 506（6 瓦片新 DEM 天府广场 506.1 -> 约 0）
COSLAT = math.cos(math.radians(30.665))
LON_M = 111320.0 * COSLAT     # 每经度米数 ~95726
LAT_M = 110540.0              # 每纬度米数

# ---- 六区裁剪（2026-11-25）：只留六个区（锦江/青羊/金牛/武侯/成华/高新南区）
# 内的要素，区外全部删掉。楼按轮廓中心点判断；多边形按真实裁剪；线/点按中点/点判断。
import sys as _sys
_sys.path.insert(0, "/home/hatch/.local/lib/python3.12/site-packages")
from shapely.geometry import Polygon as _ShpPolygon, MultiPolygon as _ShpMulti, Point as _ShpPoint, LineString as _ShpLine
from shapely.ops import unary_union as _unary_union
from shapely.prepared import prep as _prep
try:
    from shapely import constrained_delaunay_triangles as _cdt
except Exception:
    _cdt = None  # fallback: holed roofs degrade to exterior-ring top (warn at use)
_DISTRICTS = {}
for _name, _rings in json.load(open("/home/hatch/workspace/virtual-city/district-polygons.json")).items():
    _ps = []
    for _ring in _rings:
        _m = [((lon - 104.065) * LON_M, (lat - 30.665) * LAT_M) for lon, lat in _ring]
        if len(_m) >= 3:
            _ps.append(_ShpPolygon(_m))
    _u = _unary_union(_ps)
    if not _u.is_valid:
        _u = _u.buffer(0)
    _DISTRICTS[_name] = _u
_UNION = _unary_union(list(_DISTRICTS.values()))
if not _UNION.is_valid:
    _UNION = _UNION.buffer(0)
_PREP_UNION = _prep(_UNION)
def _in6(x, z):
    """点是否在六区内（covers：落在边界线上也算区内，不丢边界楼）。"""
    return _PREP_UNION.covers(_ShpPoint(x, z))
def _clip_ring_to_6(ring_m):
    """米制环裁到六区并集；返回 [ring, ...]（米制点列）。空 = 全在区外。"""
    try:
        _p = _ShpPolygon(ring_m)
    except Exception:
        return []
    if not _p.is_valid:
        _p = _p.buffer(0)
    _inter = _p.intersection(_UNION)
    _out = []
    if _inter.is_empty:
        return _out
    _geoms = list(_inter.geoms) if _inter.geom_type in ("MultiPolygon", "GeometryCollection") else [_inter]
    for _g in _geoms:
        if _g.geom_type == "Polygon":
            _ext = [[float(a), float(b)] for a, b in _g.exterior.coords]
            if len(_ext) >= 3:
                _out.append(_ext)
    return _out
def _tile_hits_6(tx, tz):
    """2000m 地形瓦片是否与六区相交。"""
    _r = _ShpPolygon([(tx*2000.0, tz*2000.0), (tx*2000.0+2000.0, tz*2000.0),
                      (tx*2000.0+2000.0, tz*2000.0+2000.0), (tx*2000.0, tz*2000.0+2000.0)])
    return _UNION.intersects(_r)

# 2026-11-26 补空环：远山内框 inner_rect（x -59400~39600、z -51480~39600，
# 即 lon 103.445~104.479、lat 30.199~31.023；远山瓦片全部落在其外）。
# 城区 169 片只覆盖六区，内框与城区矩形之间 1976 片瓦片是空的（龙泉山脊 914m、
# 青城山都在环内），只有 70x70km 平绿兜底面。补法：与六区瓦片同一套代码、同一份
# DEM6（6 瓦片 Copernicus，lon 102.8-105.0/lat 30.0-31.6 已覆盖全环，无空值），
# 按 2000m/90m 同口径生成环内瓦片；不用 GEDTM30（裸地 DTM，与城区 DSM 口径不同，
# 接缝处会出 3m（平原）~60m（林木陡坡）台阶）。新瓦片共 2131 片（环内 2300 - 已有 169）。
_INNER_RECT = (-59400.0, -51480.0, 39600.0, 39600.0)
def _tile_hits_ring(tx, tz):
    """2000m 地形瓦片是否与远山内框相交（补空环用）。"""
    _x0, _z0, _x1, _z1 = _INNER_RECT
    return not (tx*2000.0+2000.0 <= _x0 or tx*2000.0 >= _x1 or
                tz*2000.0+2000.0 <= _z0 or tz*2000.0 >= _z1)
print(f"six-district filter: union area {_UNION.area/1e6:.1f} km2, districts {sorted(_DISTRICTS)}", flush=True)

def lonlat_to_m(lon, lat):
    return (lon - 104.065) * LON_M, (lat - 30.665) * LAT_M

def point_in_poly_lonlat(lon, lat, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]; xj, yj = ring[j]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def clip_poly_to_rect(ring, x0, z0, x1, z1):
    """Sutherland-Hodgman：把米制多边形裁到矩形内。ring = [[x, z], ...]。"""
    def clip_edge(poly, inside_fn, intersect_fn):
        if not poly: return []
        out = []
        for i in range(len(poly)):
            cur = poly[i]; prv = poly[i-1]
            cin = inside_fn(cur); pin = inside_fn(prv)
            if cin:
                if not pin:
                    out.append(intersect_fn(prv, cur))
                out.append(cur)
            elif pin:
                out.append(intersect_fn(prv, cur))
        return out
    def inter_x(p1, p2, xv):
        t = (xv - p1[0]) / (p2[0] - p1[0]) if p2[0] != p1[0] else 0.0
        return [xv, p1[1] + (p2[1] - p1[1]) * t]
    def inter_z(p1, p2, zv):
        t = (zv - p1[1]) / (p2[1] - p1[1]) if p2[1] != p1[1] else 0.0
        return [p1[0] + (p2[0] - p1[0]) * t, zv]
    poly = [list(p) for p in ring]
    poly = clip_edge(poly, lambda p: p[0] >= x0, lambda a, b: inter_x(a, b, x0))
    poly = clip_edge(poly, lambda p: p[0] <= x1, lambda a, b: inter_x(a, b, x1))
    poly = clip_edge(poly, lambda p: p[1] >= z0, lambda a, b: inter_z(a, b, z0))
    poly = clip_edge(poly, lambda p: p[1] <= z1, lambda a, b: inter_z(a, b, z1))
    return poly

CHUNK_KEYS = ["b", "roads", "rivers", "water", "water_islands", "metro_line", "metro_elev", "stations",
              "entrances", "entrances_est", "station_hall", "station_platform", "landmarks", "bridges", "footbridges", "compounds", "railway",
              "elev", "piers", "toll_booths", "toll_plazas", "landuse", "natrail",
              "natrail_stations", "lamps", "lamps_bridge", "lamps_tunnel", "flowers", "trees", "greenway", "runway", "aprons",
              "special_lines", "special_tris", "road_ribbons", "vpiers", "mt_pois",
              "tunnels", "tunnel_portals", "river_rails",
              "guardrails", "brt_platforms", "park_paths", "park_amenities",
              "park_pavilions", "park_leisure", "plaza_circles", "foot_stairs"]  # 2026-11-26 修底子：隧道段计数/洞口/河岸栏杆
              # 2026-11-27 D3：高架护栏 / BRT 站台 / 园路 / 公园小品 / 亭子 / 天桥楼梯

def new_chunk():
    return {k: [] for k in CHUNK_KEYS}

def bucket_poly(chunks, ring_m, value, key):
    """米制多边形按 500m 分块裁剪入块；返回入块数。value 随片存（如颜色）。
    六区裁剪版：先把环裁到六区并集（区外部分丢掉），再按块裁剪。"""
    if len(ring_m) < 3: return 0
    n = 0
    for _ring in _clip_ring_to_6(ring_m):
        xs = [p[0] for p in _ring]; zs = [p[1] for p in _ring]
        cx0 = int((min(xs) - OX) // CHUNK); cx1 = int((max(xs) - OX) // CHUNK)
        cz0 = int((min(zs) - OZ) // CHUNK); cz1 = int((max(zs) - OZ) // CHUNK)
        for cx in range(cx0, cx1+1):
            for cz in range(cz0, cz1+1):
                x0, z0 = OX + cx*CHUNK, OZ + cz*CHUNK
                piece = clip_poly_to_rect(_ring, x0, z0, x0+CHUNK, z0+CHUNK)
                if len(piece) >= 3:
                    chunks.setdefault((cx, cz), new_chunk())[key].append((piece, value))
                    n += 1
    return n

_TREE_SHADES = [[0.32, 0.52, 0.28], [0.38, 0.58, 0.32], [0.28, 0.48, 0.30]]

# ---------------- DEM ----------------
# v3：6 瓦片 Copernicus（lon 102.8-105.0 / lat 30.0-31.6，row0=北，90m）。
# 旧 4 瓦片 data/dem/chengdu-dem-90m.npy 已实测证实错误（西南平原读 2028m、青城山 646m、
# 九顶山 417m），停用，绝不混用。
_dem6 = np.load(os.path.join(DATA, "batch1", "dem", "chengdu-dem-90m-full-latlon.npy"))
# 兴隆湖湖面修正到 464m（生态环境部美丽河湖优秀案例 2025-07-21：水位长期稳定在标高464米；DEM 里没有这个人工湖，湖面按官方湖面高程压平）
# v3.2 第 16 项注：16 号补丁建议“压平判定排除洞内格子”，本次有意不采纳——
# 实测兴隆湖 10 座岛质心处原始 DEM 为 467.7-481.0m（建湖前的老地形，湖心 470.3m），
# 排除后岛面 ground() 会读 468-481m，岛塞将浮在 464m 湖面上方 4-17m；保持全环压平，
# 岛塞按 _XL_LEVEL+0.15 落座，与水面一致（补丁原文亦承认“塞子仍有效”）。
try:
    _lakes0 = json.load(open(os.path.join(WM, "data", "lakes-assembled-v1.json")))
    _xl = None
    for _lk in _lakes0.get("lakes", []):
        if _lk.get("name") == "兴隆湖" and _lk.get("rings"):
            _xl = max(_lk["rings"], key=lambda r: r["area_m2"])
            break
    if _xl:
        _ring = _xl["points"]
        _lons = [p[0] for p in _ring]; _lats = [p[1] for p in _ring]
        _j0 = int((31.6 - max(_lats)) / 0.0008333333333333334)
        _j1 = int((31.6 - min(_lats)) / 0.0008333333333333334)
        _i0 = int((min(_lons) - 102.8) / 0.0008333333333333334)
        _i1 = int((max(_lons) - 102.8) / 0.0008333333333333334)
        _nfix = 0
        for _j in range(max(_j0, 0), min(_j1+1, 1920)):
            for _i in range(max(_i0, 0), min(_i1+1, 2640)):
                _lon = 102.8 + _i*0.0008333333333333334
                _lat = 31.6 - _j*0.0008333333333333334
                if point_in_poly_lonlat(_lon, _lat, _ring):
                    _dem6[_j, _i] = 464.0
                    _nfix += 1
        print(f"xinglonghu DEM fix: {_nfix} cells set to 464m (lake area {_xl['area_m2']/1e6:.2f} km2)")
except Exception as _e:
    print(f"WARN xinglonghu DEM fix skipped: {_e}")
from functools import lru_cache
@lru_cache(maxsize=4000000)
def _ground_cached(xi, zi):
    lat = 30.665 + zi / LAT_M
    lon = 104.065 + xi / LON_M
    j = int((31.6 - lat) / 0.0008333333333333334)
    i = int((lon - 102.8) / 0.0008333333333333334)
    j = min(max(j, 0), 1919); i = min(max(i, 0), 2639)
    return float(_dem6[j, i]) - DATUM
def ground(x, z):
    return _ground_cached(int(x), int(z))

# ---------------- 几何累加器 ----------------
class Acc:  # 三角面：非索引 + 平面法线 + 顶点色
    def __init__(self):
        self.pos, self.nor, self.col = [], [], []
    def tri(self, a, b, c, n, rgb):
        ux, uy, uz = b[0]-a[0], b[1]-a[1], b[2]-a[2]
        vx, vy, vz = c[0]-a[0], c[1]-a[1], c[2]-a[2]
        cx, cy, cz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
        if cx*n[0]+cy*n[1]+cz*n[2] < 0:
            b, c = c, b
        for p in (a, b, c):
            self.pos += p; self.nor += n; self.col += rgb
    def quad(self, p1, p2, p3, p4, n, rgb):
        self.tri(p1, p2, p3, n, rgb); self.tri(p1, p3, p4, n, rgb)
    def tris(self):
        return len(self.pos) // 9

class LineAcc:  # 线段：成对顶点 + 顶点色（无线宽，不编宽度）
    def __init__(self):
        self.pos, self.col = [], []
    def seg(self, a, b, rgb):
        self.pos += a; self.pos += b; self.col += rgb; self.col += rgb
    def polyline(self, pts, y_fn, rgb):
        for i in range(len(pts)-1):
            ax, az = pts[i]; bx, bz = pts[i+1]
            if abs(bx-ax) < 0.01 and abs(bz-az) < 0.01:
                continue
            self.seg([ax, y_fn(ax, az), az], [bx, y_fn(bx, bz), bz], rgb)
    def ring(self, pts, y_fn, rgb):
        self.polyline(pts, y_fn, rgb)
    def count(self):
        return len(self.pos) // 6

def hex_rgb(h):
    h = h.lstrip("#")
    return [int(h[0:2], 16)/255, int(h[2:4], 16)/255, int(h[4:6], 16)/255]

def shade_by_height(h):
    if h < 12: return [0.91, 0.91, 0.91]
    if h < 25: return [0.87, 0.87, 0.87]
    if h < 50: return [0.82, 0.82, 0.82]
    if h < 100: return [0.77, 0.77, 0.77]
    return [0.70, 0.70, 0.70]

def clean_ring(p):
    r = [[float(a), float(b)] for a, b in p]
    if len(r) > 1 and r[0] == r[-1]:
        r = r[:-1]
    return r

def signed_area(p):
    s = 0.0
    for i in range(len(p)):
        x1, z1 = p[i]; x2, z2 = p[(i+1) % len(p)]
        s += x1*z2 - x2*z1
    return s / 2

def ear_clip(p):
    n = len(p)
    if n < 3: return []
    if n == 3: return [(0, 1, 2)]
    pts = list(range(n))
    if signed_area(p) < 0:
        pts = pts[::-1]
    def cross(i, j, k):
        ax, az = p[pts[i]]; bx, bz = p[pts[j]]; cx, cz = p[pts[k]]
        return (bx-ax)*(cz-az) - (bz-az)*(cx-ax)
    def in_tri(px, pz, ax, az, bx, bz, cx, cz):
        d1 = (px-bx)*(az-bz) - (pz-bz)*(ax-bx)
        d2 = (px-cx)*(bz-cz) - (pz-cz)*(bx-cx)
        d3 = (px-ax)*(cz-az) - (pz-az)*(cx-ax)
        return not ((d1 > 0 and (d2 < 0 or d3 < 0)) or (d1 < 0 and (d2 > 0 or d3 > 0)))
    tris = []
    guard = 0
    while len(pts) > 3 and guard < 10000:
        guard += 1
        m = len(pts); done = False
        for i in range(m):
            ip, ic, ink = pts[(i-1) % m], pts[i], pts[(i+1) % m]
            if cross((i-1) % m, i, (i+1) % m) <= 1e-9:
                continue
            ax, az = p[ip]; bx, bz = p[ic]; cx, cz = p[ink]
            ok = True
            for j in pts:
                if j in (ip, ic, ink): continue
                if in_tri(p[j][0], p[j][1], ax, az, bx, bz, cx, cz):
                    ok = False; break
            if ok:
                tris.append((ip, ic, ink)); del pts[i]; done = True; break
        if not done:
            break
    if len(pts) == 3:
        tris.append(tuple(pts))
    return tris

def _tri_area(ring, tris):
    return sum(abs((ring[b][0] - ring[a][0]) * (ring[c][1] - ring[a][1])
                   - (ring[c][0] - ring[a][0]) * (ring[b][1] - ring[a][1])) / 2
               for a, b, c in tris)


def _pip_m(x, z, ring):
    inside = False; n = len(ring); j = n - 1
    for i in range(n):
        xi, zi = ring[i]; xj, zj = ring[j]
        if ((zi > z) != (zj > z)) and (x < (xj - xi) * (z - zi) / (zj - zi) + xi):
            inside = not inside
        j = i
    return inside


def triangulate_plug(ring):
    """v3.2 第 16 项：岛塞三角化（refinement-prep/16-lake-islands/
    build_chunks_holes_patch.py 的参考实现原样合入）。
    scipy Delaunay + 内部 Steiner 网格点、三角质心在环内过滤，与现有
    ear_clip 两者取优（面积更接近环面积者）。无 scipy 时只用 ear_clip
    （38 座岛误差 >6%，验收里写明）。返回 (tris, pts)。"""
    try:
        import numpy as _np
        from scipy.spatial import Delaunay as _Delaunay
    except Exception:
        return ear_clip(ring), [list(p) for p in ring]
    pts = [list(p) for p in ring]
    xs = [p[0] for p in ring]; zs = [p[1] for p in ring]
    area = abs(signed_area(ring))
    step = max(8.0, math.sqrt(area) / 10.0)
    x = min(xs) + step
    while x < max(xs):
        z = min(zs) + step
        while z < max(zs):
            if _pip_m(x, z, ring):
                pts.append([x, z])
            z += step
        x += step
    P = _np.array(pts, dtype=float)
    del_tris, del_pts = [], pts
    if len(P) >= 3:
        try:
            d = _Delaunay(P)
            for a, b, c in d.simplices:
                t = P[[a, b, c]]
                if abs(float(_np.cross(t[1] - t[0], t[2] - t[0]))) < 1e-9:
                    continue
                cx, cz = t.mean(axis=0)
                if _pip_m(float(cx), float(cz), ring):
                    del_tris.append((int(a), int(b), int(c)))
        except Exception:
            del_tris = []
    ear_tris = ear_clip(ring)
    a_del = _tri_area(del_pts, del_tris) if del_tris else 0.0
    a_ear = _tri_area([list(p) for p in ring], ear_tris)
    if a_del >= a_ear:
        return del_tris, del_pts
    return ear_tris, [list(p) for p in ring]


def _convex_hull(pts):
    """单调链凸包（v3.2 第 17 项：多条 OSM 站台轮廓合并为一站台环用）。"""
    pts = sorted(set(map(tuple, pts)))
    if len(pts) <= 1:
        return [list(p) for p in pts]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo = []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    up = []
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return [list(p) for p in lo[:-1] + up[:-1]]


def _expand_ring(ring, d):
    """环按质心径向外扩 d 米（v3.2 第 17 项：站厅 = 站台环外扩 8m，推测）。"""
    cx = sum(p[0] for p in ring) / len(ring)
    cz = sum(p[1] for p in ring) / len(ring)
    out = []
    for x, z in ring:
        dx, dz = x - cx, z - cz
        L = math.hypot(dx, dz) or 1.0
        out.append([x + dx / L * d, z + dz / L * d])
    return out


def _rect_ring(x, z, L, W, heading_deg):
    """中心 (x, z)、长 L、宽 W、走向 heading_deg（atan2(dz, dx)，0-180°）
    的旋转矩形环（v3.2 第 17 项 fallback 站台/站厅）。"""
    a = math.radians(heading_deg)
    ux, uz = math.cos(a), math.sin(a)
    vx, vz = -uz, ux
    return [[x + dx * ux + dy * vx, z + dx * uz + dy * vz]
            for dx, dy in [(-L / 2, -W / 2), (L / 2, -W / 2),
                           (L / 2, W / 2), (-L / 2, W / 2)]]


def prism(acc, ring, y0, y1, rgb):
    """素棱柱：墙 + 顶。只用轮廓 + 高度，不加女儿墙/退台等程序造型。
    墙法线按环绕向定（与 _wall_ring 外环同法：s=sign(有向面积)，
    n=(s*dz, -s*dx)/边长）。质心法对凹环会错边（26932 塔 8 边环 3 条锯齿边
    法线内翻，6 个墙三角错），故不用；凸环两种算法逐边一致，已验过。"""
    s = 1.0 if signed_area(ring) >= 0 else -1.0
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]; x2, z2 = ring[(i+1) % n]
        dx, dz = x2-x1, z2-z1
        ln = math.hypot(dx, dz)
        if ln < 0.01: continue
        nx, nz = s * dz / ln, -s * dx / ln
        acc.quad([x1, y0, z1], [x2, y0, z2], [x2, y1, z2], [x1, y1, z1], [nx, 0, nz], rgb)
    up = [0, 1, 0]
    for (a, b, c) in ear_clip(ring):
        acc.tri([ring[a][0], y1, ring[a][1]], [ring[b][0], y1, ring[b][1]],
                [ring[c][0], y1, ring[c][1]], up, rgb)

def flat_poly(acc, ring, y, rgb):
    up = [0, 1, 0]
    for (a, b, c) in ear_clip(ring):
        acc.tri([ring[a][0], y, ring[a][1]], [ring[b][0], y, ring[b][1]],
                [ring[c][0], y, ring[c][1]], up, rgb)

# ---- 2026-11-27 D3：星泽广场三圆几何助手（与 build_plaza_circles.py 同款函数、同参数；独立脚本只出验收叠加层，本处是进游戏包的烘焙口径）----
_PZ_SEG = 64  # 大圆分段数
def circle_pts(cx, cz, r, n=_PZ_SEG):
    pts = []
    for i in range(n):
        a = 2.0 * math.pi * i / n
        pts.append([cx + r * math.cos(a), cz + r * math.sin(a)])
    return pts
def annulus_top(acc, cx, cz, r_out, r_in, y, rgb, n=_PZ_SEG):
    """平环顶面 (r_in..r_out)，法线向上。"""
    up = [0, 1, 0]
    for i in range(n):
        a0 = 2.0 * math.pi * i / n
        a1 = 2.0 * math.pi * (i + 1) / n
        o0 = [cx + r_out * math.cos(a0), y, cz + r_out * math.sin(a0)]
        o1 = [cx + r_out * math.cos(a1), y, cz + r_out * math.sin(a1)]
        i0 = [cx + r_in * math.cos(a0), y, cz + r_in * math.sin(a0)]
        i1 = [cx + r_in * math.cos(a1), y, cz + r_in * math.sin(a1)]
        acc.quad(o0, o1, i1, i0, up, rgb)
def disc_top(acc, cx, cz, r, y, rgb, n=_PZ_SEG):
    """实心圆盘顶面，法线向上。"""
    up = [0, 1, 0]
    c = [cx, y, cz]
    ring = circle_pts(cx, cz, r, n)
    for i in range(n):
        p0 = [ring[i][0], y, ring[i][1]]
        p1 = [ring[(i + 1) % n][0], y, ring[(i + 1) % n][1]]
        acc.tri(c, p0, p1, up, rgb)
def wall_band(acc, cx, cz, r, y_top, y_bot, rgb, n=_PZ_SEG, inward=True):
    """半径 r 处的竖直圆柱面 (y_bot..y_top)。
    inward=True：法线指圆心（碗内台阶立面）；False：法线向外（岛/柱侧壁）。"""
    for i in range(n):
        a0 = 2.0 * math.pi * i / n
        a1 = 2.0 * math.pi * (i + 1) / n
        am = (a0 + a1) / 2.0
        s = -1.0 if inward else 1.0
        nrm = [s * math.cos(am), 0, s * math.sin(am)]
        t0 = [cx + r * math.cos(a0), y_top, cz + r * math.sin(a0)]
        t1 = [cx + r * math.cos(a1), y_top, cz + r * math.sin(a1)]
        b0 = [cx + r * math.cos(a0), y_bot, cz + r * math.sin(a0)]
        b1 = [cx + r * math.cos(a1), y_bot, cz + r * math.sin(a1)]
        acc.quad(t0, t1, b1, b0, nrm, rgb)
def arc_annulus_top(acc, cx, cz, r_out, r_in, y, rgb, a0_deg, a1_deg, n=16):
    """扇形环顶面（角度 a0..a1 度），法线向上。"""
    up = [0, 1, 0]
    a0 = math.radians(a0_deg)
    a1 = math.radians(a1_deg)
    for i in range(n):
        f0 = i / n
        f1 = (i + 1) / n
        ang0 = a0 + (a1 - a0) * f0
        ang1 = a0 + (a1 - a0) * f1
        o0 = [cx + r_out * math.cos(ang0), y, cz + r_out * math.sin(ang0)]
        o1 = [cx + r_out * math.cos(ang1), y, cz + r_out * math.sin(ang1)]
        i0 = [cx + r_in * math.cos(ang0), y, cz + r_in * math.sin(ang0)]
        i1 = [cx + r_in * math.cos(ang1), y, cz + r_in * math.sin(ang1)]
        acc.quad(o0, o1, i1, i0, up, rgb)
def arc_wall_band(acc, cx, cz, r, y_top, y_bot, rgb, a0_deg, a1_deg,
                  n=16, inward=False):
    """扇形竖直圆柱面（角度 a0..a1 度）。"""
    a0 = math.radians(a0_deg)
    a1 = math.radians(a1_deg)
    for i in range(n):
        f0 = i / n
        f1 = (i + 1) / n
        ang0 = a0 + (a1 - a0) * f0
        ang1 = a0 + (a1 - a0) * f1
        am = (ang0 + ang1) / 2.0
        s = -1.0 if inward else 1.0
        nrm = [s * math.cos(am), 0, s * math.sin(am)]
        t0 = [cx + r * math.cos(ang0), y_top, cz + r * math.sin(ang0)]
        t1 = [cx + r * math.cos(ang1), y_top, cz + r * math.sin(ang1)]
        b0 = [cx + r * math.cos(ang0), y_bot, cz + r * math.sin(ang0)]
        b1 = [cx + r * math.cos(ang1), y_bot, cz + r * math.sin(ang1)]
        acc.quad(t0, t1, b1, b0, nrm, rgb)
def cylinder(acc, cx, cz, r, y0, y1, rgb, n=_PZ_SEG):
    """实心圆柱（顶面 + 侧壁，法线向外）。"""
    disc_top(acc, cx, cz, r, y1, rgb, n)
    wall_band(acc, cx, cz, r, y1, y0, rgb, n, inward=False)
def thick_disc(acc, cx, cz, r, y0, y1, rgb, n=_PZ_SEG):
    """薄圆盘（顶面 + 侧壁），与 cylinder 同构，语义上是层板。"""
    cylinder(acc, cx, cz, r, y0, y1, rgb, n)
def disc_with_hole(acc, cx, cz, r, y, rgb, hole_cx, hole_cz, hole_r,
                   n_rings=12, n_sectors=48, buf=2.0):
    """带偏心圆洞的圆盘顶面（极坐标网格：环 x 扇区）。
    只保留中心在盘内（r<=R）且在洞外（距洞心 >= hole_r+buf）的格子；
    洞边呈网格锯齿（约 3m），由剧场 rim 环（R24-27.3，高出圆盘 0.04）盖住，
    残留缝隙下是地形（[0.85]，与圆盘 [0.84] 同色系），不可见。外缘跟圆（无锯齿），中心为扇形。"""
    up = [0, 1, 0]
    ring_r = [r * i / n_rings for i in range(n_rings + 1)]
    hr = hole_r + buf
    kept = 0
    for i in range(n_rings):
        r0, r1 = ring_r[i], ring_r[i + 1]
        for j in range(n_sectors):
            a0 = 2.0 * math.pi * j / n_sectors
            a1 = 2.0 * math.pi * (j + 1) / n_sectors
            am = (a0 + a1) / 2.0
            rm = (r0 + r1) / 2.0
            ccx = cx + rm * math.cos(am)
            ccz = cz + rm * math.sin(am)
            if (ccx - hole_cx) ** 2 + (ccz - hole_cz) ** 2 < hr * hr:
                continue
            def pt(rr, ang):
                return [cx + rr * math.cos(ang), y, cz + rr * math.sin(ang)]
            if i == 0:
                acc.tri([cx, y, cz], pt(r1, a0), pt(r1, a1), up, rgb)
            else:
                acc.quad(pt(r0, a0), pt(r0, a1), pt(r1, a1), pt(r1, a0),
                         up, rgb)
            kept += 1
    return kept
# 广场圆环烘焙排除的 3 栋冲突楼（_corr_fp，heights-v2.1 ctx 环）：
# db5d961c293fb5d4 花盘楼 549931755（GloBFP 错标 38.6m，OSM 实测 0.8m）；
# ef5fef285088f342 Ø37m 圆台楼（3.0m 层数推算，与实测基座 2.5m 矛盾）；
# da21298429a62791 剧场中心八边形楼（h 2.0m，y -2.0..0.0，挡碗底/中央构筑）。
_PLAZA_EXCLUDE_FP = {"db5d961c293fb5d4", "ef5fef285088f342", "da21298429a62791"}

# ---- 2026-11-26 satellite-fix 样板 · 重叠楼综合体 (overlap-complex-v1) ----
# 只服务建模层 virtual-city/data/overlap-complex-v1.json 的 2 处样板（7 条足迹），
# 全城其他楼一律走上面的素棱柱。Acc.tri 按给定法线自动纠绕向，故这里只给对法线。
def _wall_ring(acc, ring, y0, y1, rgb, is_hole=False):
    """单环竖墙。可见侧：外环朝外（远离多边形内部）、洞环朝洞内（朝向塔）。
    环绕向任意（OSM 原环可 CW 可 CCW；shapely 外环 CCW、内环 CW）：
    外环 CCW / 洞环 CW 时可见侧为边方向右手侧，否则为左手侧。
    质心法对凹环会错边，故不用 prism() 的质心法线。"""
    s = 1.0 if signed_area(ring) >= 0 else -1.0
    k = s if not is_hole else -s
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]; x2, z2 = ring[(i + 1) % n]
        dx, dz = x2 - x1, z2 - z1
        ln = math.hypot(dx, dz)
        if ln < 0.01: continue
        nx, nz = k * dz / ln, -k * dx / ln
        acc.quad([x1, y0, z1], [x2, y0, z2], [x2, y1, z2], [x1, y1, z1],
                 [nx, 0, nz], rgb)

def _holed_prism(acc, ring, holes, y0, y1, rgb):
    """带洞棱柱：外环墙（可带塔位缺口）+ 洞壁 + 洞顶（约束 Delaunay，精确贴洞）。
    holes=[] 时退化为单体棱柱，但顶面仍走 CDT——生成器 ear_clip 会在凹环上
    卡住（美术馆花瓣环 52 点只剖出 33/50 个三角，顶面缺 2755 m2），故样板楼
    一律走 CDT 顶。"""
    _wall_ring(acc, ring, y0, y1, rgb)
    for hr in holes:
        _wall_ring(acc, hr, y0, y1, rgb, is_hole=True)
    poly = _ShpPolygon(ring, holes=[[(x, z) for x, z in h] for h in holes])
    up = [0, 1, 0]
    if _cdt is not None:
        try:
            tris = _cdt(poly)
            geoms = list(tris.geoms) if hasattr(tris, "geoms") else [tris]
            for t in geoms:
                pts = list(t.exterior.coords)[:3]
                acc.tri([pts[0][0], y1, pts[0][1]], [pts[1][0], y1, pts[1][1]],
                        [pts[2][0], y1, pts[2][1]], up, rgb)
            return
        except Exception as _e:
            print(f"WARN holed roof CDT failed ({_e}); falling back to exterior top")
    for (a, b, c) in ear_clip(ring):
        acc.tri([ring[a][0], y1, ring[a][1]], [ring[b][0], y1, ring[b][1]],
                [ring[c][0], y1, ring[c][1]], up, rgb)

def _parapet(acc, ring, y, h=0.5, t=0.3, rgb=None):
    """女儿墙：沿屋顶外环每边一条薄墙（外立面 + 内立面 + 顶盖），高 0.5m、厚 0.3m。
    内法线取边方向左手侧（CCW 外环的内侧）；环为 CW 时翻向（按 signed_area 判定）。
    退化细条环（内收 t 后不足 1 m²，如 0163-P2 的 16.6 m² 三角细条，
    内收仅剩 0.02 m²）：顶盖按边逐块建、不裁剪，会在片内重叠双倍、
    并伸出环外（实测带子 32.1 m² vs 期望 16.6）。环窄到连 0.3m 盖都
    放不下时不建女儿墙（平顶）。口径与验证器 band 跳过一致
    （inner.area < 1.0，2026-11-26 总协调）。"""
    if rgb is None: rgb = [0.91, 0.91, 0.91]
    _inner = _ShpPolygon(ring).buffer(-t, join_style=2)
    if _inner.is_empty or _inner.area < 1.0:
        return
    s = 1.0 if signed_area(ring) >= 0 else -1.0
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]; x2, z2 = ring[(i + 1) % n]
        dx, dz = x2 - x1, z2 - z1
        ln = math.hypot(dx, dz)
        if ln < 0.01: continue
        ix, iz = -dz / ln * s, dx / ln * s
        ox, oz = -ix, -iz
        acc.quad([x1, y, z1], [x2, y, z2], [x2, y + h, z2], [x1, y + h, z1],
                 [ox, 0, oz], rgb)
        acc.quad([x1 + ix * t, y, z1 + iz * t], [x2 + ix * t, y, z2 + iz * t],
                 [x2 + ix * t, y + h, z2 + iz * t], [x1 + ix * t, y + h, z1 + iz * t],
                 [ix, 0, iz], rgb)
        acc.quad([x1, y + h, z1], [x2, y + h, z2],
                 [x2 + ix * t, y + h, z2 + iz * t], [x1 + ix * t, y + h, z1 + iz * t],
                 [0, 1, 0], rgb)

# ---------------- GLB 写出 ----------------
def _pack_glb(gltf, bin_data):
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    bin_data += b"\x00" * ((-len(bin_data)) % 4)
    out = b"glTF" + struct.pack("<II", 2, 12+8+len(js)+8+len(bin_data))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(bin_data), 0x004E4942) + bin_data
    return out

def write_glb(path, acc):
    """单三角网格（地形/fabric 用）。"""
    pos = np.array(acc.pos, dtype="<f4"); nor = np.array(acc.nor, dtype="<f4")
    col = np.array(acc.col, dtype="<f4")
    nverts = len(pos)//3
    bin_data = pos.tobytes() + nor.tobytes() + col.tobytes()
    gltf = {"asset": {"version": "2.0", "generator": "chengdu-white-model-stage1-v2"},
            "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2},
                                        "material": 0, "mode": 4}]}],
            "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1],
                            "metallicFactor": 0.0, "roughnessFactor": 0.95}}],
            "accessors": [
                {"bufferView": 0, "componentType": 5126, "count": nverts, "type": "VEC3",
                 "min": pos.reshape(-1, 3).min(axis=0).tolist(), "max": pos.reshape(-1, 3).max(axis=0).tolist()},
                {"bufferView": 1, "componentType": 5126, "count": nverts, "type": "VEC3"},
                {"bufferView": 2, "componentType": 5126, "count": nverts, "type": "VEC3"}],
            "bufferViews": [
                {"buffer": 0, "byteOffset": 0, "byteLength": len(pos.tobytes())},
                {"buffer": 0, "byteOffset": len(pos.tobytes()), "byteLength": len(nor.tobytes())},
                {"buffer": 0, "byteOffset": len(pos.tobytes())+len(nor.tobytes()), "byteLength": len(col.tobytes())}],
            "buffers": [{"byteLength": len(bin_data)}]}
    out = _pack_glb(gltf, bin_data)
    with open(path, "wb") as f:
        f.write(out)
    return hashlib.sha256(out).hexdigest(), len(out)

def write_glb2(path, tri, lines):
    """双网格：mesh0 三角面（建筑/水面/标记盒），mesh1 线段（路/河/桥/铁路/地铁线/小区轮廓）。
    任一为空时只写另一 mesh；都空返回 (None, 0)。"""
    has_tri = tri.tris() > 0
    has_lines = lines.count() > 0
    if not has_tri and not has_lines:
        return None, 0
    parts, accessors, buffer_views, meshes, nodes = [], [], [], [], []
    off = 0
    def add_part(arr):
        nonlocal off
        b = arr.tobytes()
        parts.append(b)
        buffer_views.append({"buffer": 0, "byteOffset": off, "byteLength": len(b)})
        off += len(b)
        return len(buffer_views) - 1
    if has_tri:
        pos = np.array(tri.pos, dtype="<f4"); nor = np.array(tri.nor, dtype="<f4")
        col = np.array(tri.col, dtype="<f4")
        nverts = len(pos)//3
        bv0 = add_part(pos); bv1 = add_part(nor); bv2 = add_part(col)
        accessors += [
            {"bufferView": bv0, "componentType": 5126, "count": nverts, "type": "VEC3",
             "min": pos.reshape(-1, 3).min(axis=0).tolist(), "max": pos.reshape(-1, 3).max(axis=0).tolist()},
            {"bufferView": bv1, "componentType": 5126, "count": nverts, "type": "VEC3"},
            {"bufferView": bv2, "componentType": 5126, "count": nverts, "type": "VEC3"}]
        meshes.append({"primitives": [{"attributes": {"POSITION": len(accessors)-3, "NORMAL": len(accessors)-2, "COLOR_0": len(accessors)-1},
                                      "material": 0, "mode": 4}]})
        nodes.append({"mesh": len(meshes)-1})
    if has_lines:
        lpos = np.array(lines.pos, dtype="<f4"); lcol = np.array(lines.col, dtype="<f4")
        nlverts = len(lpos)//3
        bv3 = add_part(lpos); bv4 = add_part(lcol)
        accessors += [
            {"bufferView": bv3, "componentType": 5126, "count": nlverts, "type": "VEC3",
             "min": lpos.reshape(-1, 3).min(axis=0).tolist(), "max": lpos.reshape(-1, 3).max(axis=0).tolist()},
            {"bufferView": bv4, "componentType": 5126, "count": nlverts, "type": "VEC3"}]
        meshes.append({"primitives": [{"attributes": {"POSITION": len(accessors)-2, "COLOR_0": len(accessors)-1},
                                      "material": 1, "mode": 1}]})
        nodes.append({"mesh": len(meshes)-1})
    bin_data = b"".join(parts)
    gltf = {"asset": {"version": "2.0", "generator": "chengdu-white-model-stage1-v2"},
            "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}], "nodes": nodes,
            "meshes": meshes,
            "materials": [
                {"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1],
                 "metallicFactor": 0.0, "roughnessFactor": 0.95}},
                {"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1],
                 "metallicFactor": 0.0, "roughnessFactor": 0.95}}],
            "accessors": accessors, "bufferViews": buffer_views,
            "buffers": [{"byteLength": len(bin_data)}]}
    out = _pack_glb(gltf, bin_data)
    with open(path, "wb") as f:
        f.write(out)
    return hashlib.sha256(out).hexdigest(), len(out)

# ---------------- 数据加载 ----------------
def load_all(heights_file="city-wide-heights-v2.1.json"):
    with open(os.path.join(DATA, heights_file)) as f:
        v2 = json.load(f)
    with open(os.path.join(DATA, "city-wide.json")) as f:
        cw = json.load(f)
    with open(os.path.join(DATA, "roads", "roads-all-levels-v1.json")) as f:
        roads_all = json.load(f)
    with open(os.path.join(DATA, "bridges", "bridges-v1.json")) as f:
        bridges = json.load(f)
    with open(os.path.join(DATA, "metro.json")) as f:
        metro = json.load(f)
    with open(os.path.join(DATA, "compound-names.json")) as f:
        compounds = json.load(f)
    rail_path = os.path.join(WM, "data", "railway-v1.json")
    railway = json.load(open(rail_path)) if os.path.exists(rail_path) else {"ways": []}
    return v2, cw, roads_all, bridges, metro, compounds, railway

def chunk_key(x, z):
    return (int((x-OX)//CHUNK), int((z-OZ)//CHUNK))

ROAD_MAJOR = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
              "secondary", "secondary_link", "tertiary", "tertiary_link"}
ROAD_FOOT = {"footway", "path", "cycleway", "steps", "pedestrian", "track"}
C_ROAD_MAJOR = [0.55, 0.55, 0.55]
C_ROAD_MINOR = [0.72, 0.72, 0.72]
C_ROAD_FOOT = [0.82, 0.82, 0.82]
C_WATER = [0.62, 0.72, 0.78]
C_RAIL = [0.30, 0.30, 0.33]      # 2026-11-26 修底子：河岸栏杆（顶梁+立柱，1px 线，与路/河线同画法）
C_PORTAL = [0.60, 0.60, 0.62]    # 2026-11-26 修底子：隧道洞门框（示意尺寸，见 tunnel_portals）
C_BRIDGE = [0.45, 0.45, 0.52]
C_FOOTBRIDGE = [0.60, 0.60, 0.66]
C_ELEV_RAMP = [0.38, 0.38, 0.48]   # 高速匝道/主线高架（§7.14）
# ---- §7.14 立体桥面（2026-11-25 立交立体，林萧 12:30 定）：高架路按实体建，不只画线 ----
DECK_THICK_VEH = 1.9    # 车行桥面结构深 = A8 叠加公式里的 1.9m（箱梁 1.8 + 铺装 0.10）
DECK_THICK_FOOT = 0.8   # 人行天桥钢梁约 0.6 + 铺装约 0.1（A8 人行公式），取 0.8
PIER_HALF = 0.8         # 桥墩方柱半边 0.8m（1.6m 见方，示意尺寸；墩位按既有 30m 间距规则，非实测墩位）
DECK_FALLBACK_HALF = {"motorway": 5.25, "motorway_link": 3.5, "trunk": 5.25,
    "trunk_link": 3.5, "primary": 5.25, "primary_link": 3.5, "secondary": 4.5,
    "secondary_link": 3.5, "tertiary": 4.0, "tertiary_link": 3.5,
    "footway": 1.5, "cycleway": 1.5, "steps": 1.5, "path": 1.5, "pedestrian": 1.5}
# 宽度缺省值 = road-widths-v1.json 里的中位数（motorway 10.5m / _link 7.0m），推算，标 fallback
# 2026-11-27 D3 路灯高：lamps-city 新 tiles 自带 h（12/10/8/6m 四档，灯路重提）；
# 桥灯 tiles 无 h 字段，按 hw 用同一张表映射（与 city tiles 的 hw→h 分布一致：
# 主干道含 secondary → 12m；tertiary → 10m；residential/unclassified → 8m；其余 6m）。
LAMP_H_BY_HW = {"motorway": 12.0, "motorway_link": 12.0, "trunk": 12.0, "trunk_link": 12.0,
                "primary": 12.0, "primary_link": 12.0, "secondary": 12.0, "secondary_link": 12.0,
                "tertiary": 10.0, "tertiary_link": 10.0,
                "residential": 8.0, "unclassified": 8.0}
LAMP_H_DEFAULT = 6.0
def lamp_height(lp):
    """2026-11-27 D3 灯高：有 h 用 h（lamps-city 新 tiles 四档 12/10/8/6m）；
    无 h 按 hw 查表（桥灯 tiles 无 h）；再无则回落 style（9.12/8.05m 旧值）。"""
    if lp.get("h") is not None:
        return float(lp["h"])
    if lp.get("hw") in LAMP_H_BY_HW:
        return LAMP_H_BY_HW[lp["hw"]]
    return 9.12 if lp.get("style", 0) == 0 else 8.05
_DECK_SHADES = [[0.40, 0.40, 0.50], [0.50, 0.50, 0.60], [0.60, 0.60, 0.68],
                [0.70, 0.70, 0.76], [0.80, 0.80, 0.84]]  # L1 最深 → L5 最浅
def deck_top_shade(layer, mean_h):
    """桥面顶面分档色：按 OSM layer 原值分档（L1 最深 → L5 最浅），缺 layer 按桥面高分档。
    目的：地面一眼看出几层。注意二环各层 deck 同为 12.0m（区间中点口径），
    层间区分靠 layer 分档 + 几何位置，不靠绝对高度。"""
    band = None
    try:
        band = int(layer) if layer is not None else None
    except Exception:
        band = None
    if band is None:
        band = 1 if mean_h < 7 else 2 if mean_h < 14 else 3 if mean_h < 21 else 4 if mean_h < 28 else 5
    return _DECK_SHADES[max(1, min(5, band)) - 1]
C_TOLL = [0.45, 0.45, 0.48]        # 收费亭示意盒 / 收费站轮廓（§7.14）
C_ELEV = [0.78, 0.78, 0.78]
C_COMPOUND = [0.65, 0.55, 0.35]
C_LU_PARK = [0.55, 0.75, 0.55]
C_LU_GREEN = [0.45, 0.65, 0.40]
C_LU_RES = [0.88, 0.86, 0.82]
C_LU_COM = [0.85, 0.80, 0.75]
C_LU_IND = [0.80, 0.80, 0.82]
C_LU_PARKING = [0.78, 0.78, 0.78]
C_LU_SQUARE = [0.82, 0.82, 0.80]
C_NATRAIL = [0.30, 0.30, 0.34]
C_LAMP = [0.62, 0.62, 0.65]
C_FLOWER = [0.85, 0.45, 0.65]  # 花坛（v3.2，第 19 项；OSM landuse=flowerbed 实抽几何）
C_GREENWAY = [0.30, 0.55, 0.30]
C_RUNWAY = [0.55, 0.55, 0.58]
C_TAXIWAY = [0.60, 0.60, 0.62]
C_APRON = [0.62, 0.62, 0.64]
C_SPECIAL = [0.42, 0.42, 0.50]
LU_COLOR = {"park": C_LU_PARK, "green": C_LU_GREEN, "residential": C_LU_RES,
            "commercial": C_LU_COM, "industrial": C_LU_IND, "parking": C_LU_PARKING,
            "square": C_LU_SQUARE}
KEY_STATIONS = {"成都东", "成都", "成都南", "成都西", "成都龙泉驿"}
MODEL_LON = (103.44, 104.69)   # 国铁/山上点位过滤：白模网格经度范围
MODEL_LAT = (30.16, 31.13)     # 白模网格纬度范围

def rail_color(val):
    if val == "rail": return [0.30, 0.30, 0.34]
    if val in ("subway",): return [0.45, 0.25, 0.55]
    if val in ("tram", "light_rail", "monorail", "miniature"): return [0.55, 0.45, 0.25]
    if val in ("platform", "station", "halt", "turntable", "traverser"): return [0.50, 0.50, 0.50]
    return [0.75, 0.75, 0.75]  # abandoned/disused/razed/proposed/construction 等非现役状态

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunk-range", nargs=2, type=int, default=None, metavar=("A", "B"))
    ap.add_argument("--only", choices=["buildings", "terrain", "fabric", "all"], default="all")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--heights", default="city-wide-heights-v2.1.json",
                    help="楼高文件（data/ 下；v2.1 起用 city-wide-heights-v2.1.json）")
    ap.add_argument("--only-chunks", default=None,
                    help="JSON 文件，内为 [[cx,cz],...]，只重建这些块（强制重建）")
    args = ap.parse_args()
    os.makedirs(os.path.join(OUT, "chunks"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "terrain"), exist_ok=True)
    log_path = os.path.join(OUT, "generation-log.json")
    log = json.load(open(log_path)) if os.path.exists(log_path) else {"done": {}, "errors": [], "format_version": FORMAT_VERSION}

    v2, cw, roads_all, bridges, metro, compounds, railway = load_all(args.heights)
    # ---- v3 新增数据源（缺文件则空着，不造假） ----
    def _load_json(path, default):
        try:
            with open(path) as f: return json.load(f)
        except Exception as e:
            print(f"WARN missing {path}: {e}")
            return default
    water_v1 = _load_json(os.path.join(DATA, "batch1", "osm", "water-v1.json"),
                          {"water_lines": [], "water_polys": []})
    # ---- 2026-11-27 D3 水面并集（米制 points_local；供过水补桥定段 + 道路跳水段 + 栏杆抠洞） ----
    _wpolys = []
    for _wp in water_v1.get("water_polys", []):
        _pl = _wp.get("points_local") or []
        if len(_pl) < 3:
            continue
        try:
            _pp = _ShpPolygon(_pl)
            if not _pp.is_valid:
                _pp = _pp.buffer(0)
            if not _pp.is_empty and _pp.area > 0:
                _wpolys.append(_pp)
        except Exception:
            continue
    _WATER_UNION = _unary_union(_wpolys) if _wpolys else None
    _PREP_WATER = _prep(_WATER_UNION) if _WATER_UNION is not None else None
    def _in_water(_x, _z):
        return bool(_PREP_WATER is not None and _PREP_WATER.contains(_ShpPoint(_x, _z)))
    def _seg_water_len(_a, _b):
        # 段 a->b 落在水面多边形内的长度（m）。只碰岸线=0；长段斜跨窄河时中点落在水外也能量到。
        if _PREP_WATER is None:
            return 0.0
        try:
            _ln = _ShpLine([_a, _b])
            if not _PREP_WATER.intersects(_ln):
                return 0.0
            _g = _WATER_UNION.intersection(_ln)
            return float(_g.length) if not _g.is_empty else 0.0
        except Exception:
            return 0.0
    print(f"water union: {len(_wpolys)} polys, area {(_WATER_UNION.area/1e6 if _WATER_UNION is not None else 0):.2f} km2")
    landuse = _load_json(os.path.join(DATA, "landuse", "landuse-v1.json"), {"features": []})
    widths = _load_json(os.path.join(DATA, "roads", "road-widths-v1.json"), {"roads": []})
    width_by_id = {}
    for _wr in widths.get("roads", []):
        if _wr.get("width_m"):
            width_by_id[_wr["osm_id"]] = (float(_wr["width_m"]), _wr.get("width_source", ""))
    print(f"road widths: {len(width_by_id)} (of {len(roads_all['roads'])} roads)")
    natrail = _load_json(os.path.join(DATA, "rail", "national-rail-v1.json"),
                         {"rail_lines": [], "stations": []})
    lakes = _load_json(os.path.join(WM, "data", "lakes-assembled-v1.json"), {"lakes": []})
    shapes = _load_json(os.path.join(WM, "data", "bridge-shapes.json"),
                        {"shapes": [], "ring_features": []})
    street_trees = _load_json(os.path.join(WM, "data", "street-trees-v1.json"), {"points": []})
    aeroway = _load_json(os.path.join(WM, "data", "aeroway-v1.json"), {"features": []})
    mt_pois = _load_json(os.path.join(WM, "data", "mountain-pois-v1.json"), {"points": []})
    # ---- 2026-11-27 D3 数据文件（各数据路交付，只消费、不重做；缺文件则空着，不造假） ----
    _elev_ovr = _load_json(os.path.join(VC, "data", "bridge-elev-overrides-v1.json"),
                      {"restores": [], "pins": [], "cascade": []})
    _fbdecks = _load_json(os.path.join(VC, "data", "bridge-fb-decks-v1.json"), {"decks": []})
    _bpiers = _load_json(os.path.join(VC, "data", "bridge-piers-v1.json"), {"piers": []})
    _brails = _load_json(os.path.join(VC, "data", "bridge-guardrails-v1.json"), {"guardrails": []})
    _bstairs = _load_json(os.path.join(VC, "data", "bridge-footbridge-stairs-v1.json"), {"footbridges": []})
    _nportals = _load_json(os.path.join(VC, "data", "tunnel-portals-nonvehicle-v1.json"), {"portals": []})
    _brt = _load_json(os.path.join(VC, "data", "brt-stations-v1.json"), {"stations": []})
    _parks = _load_json(os.path.join(VC, "data", "six-parks-v1.json"), {"paths": [], "trees": {}})
    _pamen = _load_json(os.path.join(VC, "data", "park-amenities-v1.json"), {"items": []})
    _pleis = _load_json(os.path.join(VC, "data", "six-park-leisure.json"), {"items": []})
    _plaza = _load_json(os.path.join(VC, "data", "plaza-circles-v2.json"), {"disc": {}, "structures": []})
    # 广场圆盘（R75）shapely 圆：landuse ground_cut 用；地形碗压点在 terrain 段另算
    _pz_disc = None; _pz_disc_prep = None
    if _plaza.get("disc"):
        _dc = _plaza["disc"]["center"]
        _pz_disc = _ShpPoint(float(_dc["x"]), float(_dc["z"])).buffer(float(_plaza["disc"]["radius_m"]), resolution=16)
        _pz_disc_prep = _prep(_pz_disc)
    _xcross = _load_json(os.path.join(VC, "water-crossing-verdicts-2026-11-27.json"), [])
    print(f"D3 data: overrides restores {len(_elev_ovr.get('restores', []))} pins {len(_elev_ovr.get('pins', []))} "
          f"cascade {len(_elev_ovr.get('cascade', []))}; FB decks {len(_fbdecks.get('decks', []))}; "
          f"piers {len(_bpiers.get('piers', []))}; guardrails {len(_brails.get('guardrails', []))}; "
          f"footbridge stairs {len(_bstairs.get('footbridges', []))}; non-vehicle portals "
          f"{len(_nportals.get('portals', []))}; BRT {len(_brt.get('stations', []))}; "
          f"park paths {len(_parks.get('paths', []))}; park amenities {len(_pamen.get('items', []))}; "
          f"park leisure {len(_pleis.get('items', []))}; "
          f"plaza circles {len(_plaza.get('structures', []))} structures + disc; "
          f"water crossings {len(_xcross) if isinstance(_xcross, list) else 0}")
    _wc = None
    try:
        _wcz = np.load(os.path.join(DATA, "batch1", "worldcover", "worldcover-bone-bbox-10m.npz"))
        _wc = _wcz["grid"]
        print(f"worldcover: shape {_wc.shape}, tree cells {int((_wc == 10).sum())}")
    except Exception as _e:
        print(f"WARN worldcover not loaded: {_e}")
    print(f"heights source: {args.heights}")
    # ---- §7.14 高架路高程（hw_interchange 共享模块，与分析脚本同一套判定） ----
    # 高架集 = 全部 scope 路（motorway + 全部 _link，含缺 layer 靠端点推断的匝道）
    #          + 其他 own_deck>0 的路（高架桥/人行天桥）。2026-11-25 零平桥后全部
    # 9,399 座桥均有数值 deck（跨河基值 3.0m / 铁路高架 7.5m / 地铁高架 9.0m /
    # 人行跨河 2.0m，方法与误差见 bridges-v1.json），§7.10 留平规则已退役。
    # 端点推断 + 节点共识调和（坡，不是台阶）。2026-11-25 立交立体：高架段另建实体桥面
    # （顶面+底面+两侧，厚 1.9m/0.8m，宽取 road-widths-v1，顶面按 OSM layer 分档着色，
    # 顶面同时进 mid）与实心方柱桥墩（地面→桥面底，每 ~30m，墩位示意）；只改立交生成逻辑。
    bdeck = {}
    for _b in bridges["bridges"] + bridges["footbridges"]:
        _d = _b.get("deck_height_m")
        bdeck[_b["osm_id"]] = (float(_d) if isinstance(_d, (int, float)) else None,
                               _b.get("height_method"))
    # §7.12 例外：7 座特型桥的桥面高按 layer1 推断（bridge-shapes.json deck_height_m=6.25），
    # 不受 bridges 文件旧“待核实”留平规则约束（该规则 2026-11-25 已退役）；否则特型桥的拱/塔会浮在平桥面上方
    _ovr = 0
    for _sh in shapes.get("shapes", []):
        _dh = _sh.get("deck_height_m")
        if _dh is None: continue
        for _oid in _sh.get("deck_osm_ids") or []:
            bdeck[_oid] = (float(_dh), "distinctive-bridge-shape-7.12")
            _ovr += 1
    print(f"distinctive bridge decks overridden to 6.25m: {_ovr} ways")
    _roads_by_id = {r["osm_id"]: r for r in roads_all["roads"]}
    _nodes = build_node_index(roads_all["roads"], bdeck)
    _elev_roads = [r for r in roads_all["roads"]
                   if (r["highway"] in SCOPE or (own_deck(r, bdeck)[0] or 0) > 0)
                   and r.get("tunnel") != "yes"]  # 2026-11-26 修底子：隧道在地下，不进高架集（否则会被画成高架桥面）
    # 注意：scope（motorway + 全部 _link）必须全进高架集，不只是 own_deck>0 的——
    # 缺 layer 的匝道自身无 deck，但端点推断可能给它 6.9m 的坡头（另一端接地；
    # 2026-11-25 A8 标准叠加公式，旧 6.25m 已废止）；
    # 只按 own_deck 筛会把它漏掉，画平后在高速接头处断开 6.25m。
    _info0 = estimate_endpoints(_elev_roads, _nodes, bdeck)
    elev_info, _rstats = reconcile(_info0, _roads_by_id, _nodes, bdeck)
    print(f"elevated ways: {len(elev_info)} (scope motorway/_link: "
          f"{sum(1 for v in elev_info.values() if v['highway'] in SCOPE)}, "
          f"of which max-end>0: "
          f"{sum(1 for v in elev_info.values() if max(v['start_h'], v['end_h']) > 0)}); "
          f"reconcile: {dict(_rstats)}")
    # ---- 2026-11-27 D3 桥路：elev overrides（bridge-elev-overrides-v1.json 单一事实源） ----
    # reconcile 之后、任何 elev 消费之前应用。restores/cascade/pins 各条的 vertex_heights_m
    # 直接顶替 vertex_heights() 的插值（坡已烤进顶点高，ramps[] 只是审计 trail）。
    # hw_interchange.py 的恢复/pin 代码已回退（只留 docstring 标签修正），避免双份事实源。
    _ovr_n = {"restores": 0, "cascade": 0, "pins": 0, "missing": 0, "vh_mismatch": 0}
    for _sec in ("restores", "cascade", "pins"):
        for _en in _elev_ovr.get(_sec, []):
            _oid = _en.get("osm_id")
            _ev = elev_info.get(_oid)
            if _ev is None:
                _ovr_n["missing"] += 1
                continue
            _vh = _en.get("vertex_heights_m") or []
            _npts = len(way_pts(_roads_by_id[_oid])) if _oid in _roads_by_id else 0
            if _vh and len(_vh) == _npts:
                _ev["vertex_heights_m"] = [float(v) for v in _vh]
                _ev["start_h"] = float(_vh[0])
                _ev["end_h"] = float(_vh[-1])
            else:
                if _vh:
                    _ovr_n["vh_mismatch"] += 1
                if "start_h_m" in _en:
                    _ev["start_h"] = float(_en["start_h_m"])
                if "end_h_m" in _en:
                    _ev["end_h"] = float(_en["end_h_m"])
            _ovr_n[_sec] += 1
    print(f"elev overrides applied: {_ovr_n} (source bridge-elev-overrides-v1.json)")
    # 收费站（PBF 实抽，toll-booths-v1.json；无文件则跳过，不造假）
    toll_path = os.path.join(WM, "data", "toll-booths-v1.json")
    toll = json.load(open(toll_path)) if os.path.exists(toll_path) else \
        {"booth_points": [], "ways": []}
    print(f"toll booth points: {len(toll['booth_points'])}, plaza ways: {len(toll['ways'])}")
    # 高架路顶点高索引：收费亭落座用（亭点落在高架匝道上时按桥面高，不按地面）
    _node_elev_h = {}
    for _oid, _ev in elev_info.items():
        _r = _roads_by_id[_oid]
        _lp = way_pts(_r)
        _vh = _ev.get("vertex_heights_m") or vertex_heights(_lp, _ev["start_h"], _ev["end_h"])
        for _p, _h in zip(_lp, _vh):
            _node_elev_h.setdefault(key_of(*_p), []).append(_h)
    # ---- 2026-11-27 D3 预计算：FB 实心桥面段 + 过水补桥段/墩 + 桥面投影格网 + BRT 站台 ----
    # FB decks：bridge-fb-decks-v1.json（六区内 377 条 / 2,508 段，坡已烤进 vertex_heights_m）。
    # 过水补桥：water-crossing-verdicts B=23（真缺桥；A/C/D 一律不建）。每处只建 verdict 点
    #   所在的过水段 + 两端各一节引桥坡（坡长=端头 OSM 段长，FB 同规则）；车行桥面 3.0m/
    #   厚 1.9m（跨河基值），步行桥面 2.0m/厚 0.8m（人行跨河基值）；宽取 road-widths-v1 或等级 fallback。
    # 桥面投影格网（100m）：供河岸栏杆桥处抠洞（落入桥面投影的栏杆段/立柱去掉）。
    def _elev_vh(_oid, _ev, _lp):
        _bvh = _ev.get("vertex_heights_m")
        if _bvh and len(_bvh) == len(_lp):
            return [float(v) for v in _bvh]
        return vertex_heights(_lp, _ev["start_h"], _ev["end_h"])
    _fbdeck_segs = []   # (a, b, ha, hb, hw2, thick, lay)
    _fb_n = {"ways": 0, "segs": 0, "in_elev_skipped": 0, "vh_mismatch": 0}
    for _d in _fbdecks.get("decks", []):
        if not _d.get("in_six"):
            continue
        _oid = _d["osm_id"]
        if _oid in elev_info:
            _fb_n["in_elev_skipped"] += 1
            continue
        _pf = _d.get("points_lonlat") or []
        _pts = [lonlat_to_m(_pf[i], _pf[i+1]) for i in range(0, len(_pf)-1, 2)]
        _vh = _d.get("vertex_heights_m") or []
        if len(_pts) < 2 or len(_vh) != len(_pts):
            _fb_n["vh_mismatch"] += 1
            continue
        _hw2 = float(_d["width_m"]) / 2.0
        _thick = float(_d.get("thickness_m", 1.9))
        _lay = _d.get("layer")
        for i in range(len(_pts)-1):
            _fbdeck_segs.append((_pts[i], _pts[i+1], float(_vh[i]), float(_vh[i+1]), _hw2, _thick, _lay))
        _fb_n["ways"] += 1
        _fb_n["segs"] += len(_pts)-1
    print(f"FB decks precomputed: {_fb_n}")
    # 过水补桥
    _XCROSS_IDS = set()
    _xcross_decks = []   # (a, b, ha, hb, hw2, thick, lay)
    _xcross_piers = []   # (x, z, deck_h, thick)
    _xc_n = {"built": 0, "road_missing": 0, "no_water_run": 0, "runs": 0, "segs": 0, "piers": 0}
    for _xc in (_xcross if isinstance(_xcross, list) else []):
        if _xc.get("verdict") != "B":
            continue
        _oid = _xc.get("road_osm_id")
        _r = _roads_by_id.get(_oid)
        if _r is None:
            _xc_n["road_missing"] += 1
            continue
        _pf = _r.get("points_flat") or []
        _pts = [lonlat_to_m(_pf[i], _pf[i+1]) for i in range(0, len(_pf)-1, 2)]
        if len(_pts) < 2:
            _xc_n["road_missing"] += 1
            continue
        # 2026-11-27 D3 fix: 以段-水面交叠长度（>0.5m）定过水段，不用中点测试——
        # 长段斜跨窄河时中点落在水外，旧法漏掉 7 处（0004/0007/0009/0017/0019/0049/0051）。
        # 一条路可有多段过水（如 0053 过水库两臂），全部建桥。
        _runs = []
        _cur = None
        for i in range(len(_pts)-1):
            if _seg_water_len(_pts[i], _pts[i+1]) > 0.5:
                if _cur is None:
                    _cur = [i, i]
                else:
                    _cur[1] = i
            else:
                if _cur is not None:
                    _runs.append(tuple(_cur)); _cur = None
        if _cur is not None:
            _runs.append(tuple(_cur))
        if not _runs:
            _xc_n["no_water_run"] += 1
            continue
        _hw = _r.get("highway")
        if _hw in ("footway", "cycleway", "steps", "path", "pedestrian"):
            _dh, _thick = 2.0, DECK_THICK_FOOT
        else:
            _dh, _thick = 3.0, DECK_THICK_VEH
        _w = width_by_id.get(_oid)
        _hw2 = _w[0]/2.0 if _w else DECK_FALLBACK_HALF.get(_hw, 4.5)
        _lay = _r.get("layer")
        for (_lo, _hi) in _runs:
            _seg_h = {i: (_dh, _dh) for i in range(_lo, _hi+1)}
            if _lo > 0:
                _seg_h[_lo-1] = (0.0, _dh)
            elif _hi > _lo:
                _seg_h[_lo] = (0.0, _dh)  # 过水段顶到路头：首段自做上坡
            if _hi < len(_pts)-2:
                _seg_h[_hi+1] = (_dh, 0.0)
            elif _hi > _lo:
                _seg_h[_hi] = (_dh, 0.0)  # 过水段顶到路尾：末段自做下坡
            for i in sorted(_seg_h):
                _xcross_decks.append((_pts[i], _pts[i+1], _seg_h[i][0], _seg_h[i][1], _hw2, _thick, _lay))
                _xc_n["segs"] += 1
            _xc_n["runs"] += 1
            if _dh > 2.0:
                _run = _pts[_lo:_hi+2]
                _tot = 0.0
                _cum = [0.0]
                for i in range(1, len(_run)):
                    _tot += math.hypot(_run[i][0]-_run[i-1][0], _run[i][1]-_run[i-1][1])
                    _cum.append(_tot)
                _d = 30.0
                while _d < _tot:
                    _j = next(i for i in range(1, len(_cum)) if _cum[i] >= _d)
                    _f = (_d-_cum[_j-1])/max(_cum[_j]-_cum[_j-1], 1e-9)
                    _px = _run[_j-1][0]+(_run[_j][0]-_run[_j-1][0])*_f
                    _pz = _run[_j-1][1]+(_run[_j][1]-_run[_j-1][1])*_f
                    _xcross_piers.append((_px, _pz, _dh, _thick))
                    _xc_n["piers"] += 1
                    _d += 30.0
        _XCROSS_IDS.add(_oid)
        _xc_n["built"] += 1
    print(f"water-crossing bridges (B=23): {_xc_n}")
    # 桥面投影格网（elev + FB + 过水补桥；只含 max(ha,hb)>0.05 的段）
    _deck_grid = {}
    def _deck_grid_add(_ax, _az, _bx, _bz, _hw2):
        _x0 = int(min(_ax, _bx)-_hw2)//100; _x1 = int(max(_ax, _bx)+_hw2)//100
        _z0 = int(min(_az, _bz)-_hw2)//100; _z1 = int(max(_az, _bz)+_hw2)//100
        for _cx in range(_x0, _x1+1):
            for _cz in range(_z0, _z1+1):
                _deck_grid.setdefault((_cx, _cz), []).append((_ax, _az, _bx, _bz, _hw2))
    def _deck_hit(_x, _z):
        for (_ax, _az, _bx, _bz, _hw2) in _deck_grid.get((int(_x)//100, int(_z)//100), []):
            _dx, _dz = _bx-_ax, _bz-_az
            _l2 = _dx*_dx+_dz*_dz
            _t = 0.0 if _l2 == 0 else max(0.0, min(1.0, ((_x-_ax)*_dx+(_z-_az)*_dz)/_l2))
            if ((_x-(_ax+_t*_dx))**2+(_z-(_az+_t*_dz))**2)**0.5 < _hw2:
                return True
        return False
    _grid_n = 0
    for _oid, _ev in elev_info.items():
        _r = _roads_by_id[_oid]
        _lp = way_pts(_r)
        _vh = _elev_vh(_oid, _ev, _lp)
        _pts = [lonlat_to_m(lon, lat) for lon, lat in _lp]
        _w = width_by_id.get(_oid)
        _hw2 = _w[0]/2.0 if _w else DECK_FALLBACK_HALF.get(_ev["highway"], 4.5)
        for i in range(len(_pts)-1):
            if max(_vh[i], _vh[i+1]) > 0.05:
                _deck_grid_add(_pts[i][0], _pts[i][1], _pts[i+1][0], _pts[i+1][1], _hw2)
                _grid_n += 1
    for (_a, _b, _ha, _hb, _hw2, _thick, _lay) in _fbdeck_segs + _xcross_decks:
        if max(_ha, _hb) > 0.05:
            _deck_grid_add(_a[0], _a[1], _b[0], _b[1], _hw2)
            _grid_n += 1
    print(f"deck projection grid: {_grid_n} segments in {len(_deck_grid)} cells")
    # BRT 站台：站台跟所在段桥面高（snap 点最近段插值），不在 elev 里则落地面
    _brt_platforms = []   # (x, z, deck_h, heading_deg)
    _brt_n = {"built": 0, "ground": 0, "way_missing": 0}
    for _st in _brt.get("stations", []):
        _oid = _st.get("brt_osm_id")
        _r = _roads_by_id.get(_oid)
        if _r is None:
            _brt_n["way_missing"] += 1
            continue
        _sx, _sz = float(_st.get("snap_x", _st["x"])), float(_st.get("snap_z", _st["z"]))
        _lp = way_pts(_r)
        _pts = [lonlat_to_m(lon, lat) for lon, lat in _lp]
        _best, _bd = 0, 1e18
        for i in range(len(_pts)-1):
            _mx, _mz = (_pts[i][0]+_pts[i+1][0])/2, (_pts[i][1]+_pts[i+1][1])/2
            _dd = (_mx-_sx)**2+(_mz-_sz)**2
            if _dd < _bd:
                _bd, _best = _dd, i
        _dx, _dz = _pts[_best+1][0]-_pts[_best][0], _pts[_best+1][1]-_pts[_best][1]
        _hd = math.degrees(math.atan2(_dz, _dx))
        _ev = elev_info.get(_oid)
        if _ev is None:
            _dh = 0.0
            _brt_n["ground"] += 1
        else:
            _vh = _elev_vh(_oid, _ev, _lp)
            _seglen = math.hypot(_dx, _dz) or 1.0
            _t = max(0.0, min(1.0, ((_sx-_pts[_best][0])*_dx+(_sz-_pts[_best][1])*_dz)/(_seglen*_seglen)))
            _dh = _vh[_best]+(_vh[_best+1]-_vh[_best])*_t
        _brt_platforms.append((_sx, _sz, float(_dh), float(_hd)))
        _brt_n["built"] += 1
    print(f"BRT platforms: {_brt_n}")
    # 硬约束（楼高调查定稿）：建筑直接读楼高文件（轮廓+高度同一记录），没有任何 join。
    # 绝对不许按数组下标把 v2 高度往骨文件（63,160 栋）或其他几何上贴——下标错位
    # （骨 idx 100 = v2 idx 426），圈外 21,405 栋会全错位；如需贴合，一律按轮廓匹配。
    # v2 不可重跑（build_heights_v2.py 断言失败 + /tmp/globfp_bbox.pkl 已删），只用现成文件。
    # ---- 2026-11-26 修底子·建筑位置修正层 v1（只改建筑足迹，不动其他要素） ----
    # 修正层：virtual-city/data/building-corrections-v1.json（clip 沿实测路/水边裁足迹、
    # delete 重复/全在水里/裁完无剩、add OSM 有而模型缺的 4 栋；共 134 条）。
    # 匹配按足迹指纹：clean_ring 后坐标 0.1m 舍入排序 md5，与修正层同口径。
    # 同指纹多栋时 delete 只删 delete_count 栋（9813/9817 同一 OSM way 667581162
    # 两遍，留一栋）。clip 一栋变多片时按片拆成多条记录（同高）；分片质心所在
    # 分块由下文 ck() 按新环重算，跨块自动归位。
    def _corr_fp(_ring):
        _pts = sorted((round(float(_x), 1), round(float(_z), 1)) for _x, _z in _ring)
        return hashlib.md5(json.dumps(_pts).encode()).hexdigest()[:16]
    def _apply_corrections(_buildings):
        _path = "/home/hatch/workspace/virtual-city/data/building-corrections-v1.json"
        try:
            _corr = json.load(open(_path))
        except Exception as _e:
            print(f"corrections: no layer ({_e}); buildings as-is")
            return _buildings
        _by_fp = {}
        for _en in _corr.get("entries", []):
            if _en["type"] in ("clip", "delete"):
                _by_fp.setdefault(_en["fp"], []).append(_en)
        _out, _n = [], {"clip": 0, "delete": 0, "add": 0}
        for _b in _buildings:
            _fp = _corr_fp(clean_ring(_b["p"]))
            _hits = _by_fp.get(_fp)
            if not _hits:
                _out.append(_b)
                continue
            _en = _hits.pop(0)
            if _en["type"] == "delete":
                _n["delete"] += 1
                continue
            for _pc in _en["pieces"]:
                _nb = dict(_b)
                _nb["p"] = [[float(a), float(b)] for a, b in _pc]
                _out.append(_nb)
            _n["clip"] += 1
        for _en in _corr.get("entries", []):
            if _en["type"] != "add":
                continue
            for _pc in _en["pieces"]:
                _out.append({"p": [[float(a), float(b)] for a, b in _pc],
                             "h": float(_en["height_m"]), "t": "yes",
                             "h_orig": float(_en["height_m"]),
                             "height_source": _en.get("height_source", "corrections-v1"),
                             "height_confidence": _en.get("height_confidence", "low")})
            _n["add"] += 1
        print(f"corrections v1 applied: clip {_n['clip']} buildings, "
              f"delete {_n['delete']}, add {_n['add']} -> {len(_out)} buildings "
              f"(was {len(_buildings)})")
        return _out
    buildings = _apply_corrections(v2["buildings_ctx"])
    # ---- 2026-11-26 satellite-fix 样板 · 重叠楼综合体 v1（只动 2 处、7 条足迹） ----
    # 层文件 virtual-city/data/overlap-complex-v2.json（不存在时回退 v1）；
    # 匹配按 _corr_fp（与修正层同口径）。任一条对不上（指纹/洞环）即大声失败，
    # 不静默造旧盒子。
    def _apply_overlap_complex(_buildings):
        _v2 = "/home/hatch/workspace/virtual-city/data/overlap-complex-v2.json"
        _v1 = "/home/hatch/workspace/virtual-city/data/overlap-complex-v1.json"
        _path = _v2 if os.path.exists(_v2) else _v1
        try:
            _layer = json.load(open(_path))
        except Exception as _e:
            print(f"overlap-complex: no layer ({_e}); buildings as-is")
            return _buildings
        print(f"overlap-complex: layer {_path} version {_layer.get('version')}")
        _by_fp = {e["fp"]: e for e in _layer.get("entries", [])}
        if not _by_fp:
            return _buildings
        # 逐裙楼地面：每处 podium / split 片用自己的 ground_ref（现算复核，
        # 差 >0.05m 用现算值并打印）；不再取第一个 podium 当全局地面。
        def _ground_checked(_ref, _label):
            _g = ground(float(_ref["x"]), float(_ref["z"]))
            if abs(_g - float(_ref["ground"])) > 0.05:
                print(f"overlap-complex: {_label} ground ref mismatch "
                      f"layer={_ref['ground']} now={_g:.2f}; using now")
            return _g
        _ground_by_podium_fp = {}
        _ground_by_piece = {}
        for _e in _layer["entries"]:
            if _e["action"] == "podium":
                _ground_by_podium_fp[_e["fp"]] = _ground_checked(
                    _e["ground_ref"], f"podium {_e.get('raw_idx')}")
            elif _e["action"] == "split_podium":
                for _pc in _e["pieces"]:
                    _ground_by_piece[_pc["piece_id"]] = _ground_checked(
                        _pc["ground_ref"], f"split piece {_pc['piece_id']}")
        def _tower_ground(_en):
            _pid = _en.get("ground_ref_piece")
            if _pid is not None:
                if _pid not in _ground_by_piece:
                    raise SystemExit(f"overlap-complex: tower {_en.get('raw_idx')} "
                                     f"ground_ref_piece {_pid!r} not a split piece; "
                                     f"refusing to build")
                return _ground_by_piece[_pid]
            _pfp = _en.get("ground_ref_fp")
            if _pfp is not None and _pfp in _ground_by_podium_fp:
                return _ground_by_podium_fp[_pfp]
            raise SystemExit(f"overlap-complex: tower {_en.get('raw_idx')} has no "
                             f"resolvable podium ground (ground_ref_fp={_pfp!r}, "
                             f"ground_ref_piece={_pid!r}); refusing to build")
        _out, _n = [], {"merge_keep": 0, "drop": 0, "podium": 0, "split_podium": 0, "tower": 0}
        _unmatched = []
        for _b in _buildings:
            _fp = _corr_fp(clean_ring(_b["p"]))
            _en = _by_fp.get(_fp)
            if _en is None:
                _out.append(_b)
                continue
            _by_fp.pop(_fp)
            _act = _en["action"]
            if _act == "drop_merged_into":
                _n["drop"] += 1
                continue
            if _act == "merge_keep":
                _nb = dict(_b)
                _nb["h"] = float(_en["height_m"])
                _nb["cdt_top"] = True  # 凹花瓣环：ear_clip 会卡住丢顶面，改走 CDT 顶
                _nb["roof_parapet"] = True
                _nb["equip"] = _en["roof"]["equip_boxes"]
                _out.append(_nb)
                _n["merge_keep"] += 1
                continue
            if _act == "podium":
                _ring = clean_ring(_b["p"])
                _poly = _ShpPolygon(_ring)
                for _hh in _en["holes"]:
                    _hfp = _corr_fp(clean_ring(_hh["ring"]))
                    if _hfp != _hh["fp"]:
                        raise SystemExit(f"overlap-complex: podium hole fp mismatch "
                                         f"(entry {_hh['fp']} vs ring {_hfp}); refusing to build")
                    _poly = _poly.difference(_ShpPolygon(clean_ring(_hh["ring"])))
                if _poly.geom_type == "MultiPolygon":
                    # 减洞后退化 MultiPolygon：洞环贴着裙楼外边（68510 sliver
                    # 洞）会切出面积为 0 的幽灵片；只留非退化片，恰一片时用
                    # 它，多片非退化 = 真分裂，改走 split_podium。
                    _parts = [g for g in _poly.geoms if g.area >= 0.01]
                    if len(_parts) != 1:
                        raise SystemExit(
                            f"overlap-complex: podium-minus-towers split into "
                            f"{len(_parts)} non-degenerate pieces; use split_podium")
                    _poly = _parts[0]
                if not _poly.is_valid or _poly.geom_type != "Polygon":
                    raise SystemExit("overlap-complex: podium-minus-towers is not a valid Polygon")
                _nb = dict(_b)
                _nb["p"] = [[float(a), float(c)] for a, c in list(_poly.exterior.coords)[:-1]]
                _nb["holes"] = [[[float(a), float(c)] for a, c in list(_it.coords)[:-1]]
                                for _it in _poly.interiors]
                _nb["h"] = float(_en["height_m"])
                _g = _ground_by_podium_fp.get(_fp)
                if _g is None:
                    raise SystemExit(f"overlap-complex: podium {_fp} has no ground_ref; "
                                     f"refusing to build")
                _nb["y0_abs"] = float(_g)
                _nb["y1_abs"] = float(_g) + float(_en["height_m"])
                _nb["roof_parapet"] = True
                _nb["equip"] = _en["roof"]["equip_boxes"]
                _out.append(_nb)
                _n["podium"] += 1
                continue
            if _act == "split_podium":
                # 一栋楼进、多片楼出：每片按 podium 同法（减洞、定绝对高、
                # 女儿墙 + 设备盒）；洞环指纹不匹配大声失败。
                for _pc in _en["pieces"]:
                    _pring = clean_ring(_pc["ring"])
                    _ppoly = _ShpPolygon(_pring)
                    for _hh in _pc.get("holes", []):
                        _hfp = _corr_fp(clean_ring(_hh["ring"]))
                        if _hfp != _hh["fp"]:
                            raise SystemExit(f"overlap-complex: split piece "
                                             f"{_pc['piece_id']} hole fp mismatch "
                                             f"(entry {_hh['fp']} vs ring {_hfp}); "
                                             f"refusing to build")
                        _ppoly = _ppoly.difference(_ShpPolygon(clean_ring(_hh["ring"])))
                    if _ppoly.geom_type == "MultiPolygon":
                        # 同裙楼：洞环贴边切出的 0 面积幽灵片只留非退化片，
                        # 恰一片时用它，多片非退化 = 真分裂。
                        _parts = [g for g in _ppoly.geoms if g.area >= 0.01]
                        if len(_parts) != 1:
                            raise SystemExit(
                                f"overlap-complex: split piece "
                                f"{_pc['piece_id']} minus-towers split into "
                                f"{len(_parts)} non-degenerate pieces")
                        _ppoly = _parts[0]
                    if not _ppoly.is_valid or _ppoly.geom_type != "Polygon":
                        raise SystemExit(f"overlap-complex: split piece "
                                         f"{_pc['piece_id']} minus-towers is not a "
                                         f"valid Polygon")
                    _pg = _ground_by_piece.get(_pc["piece_id"])
                    if _pg is None:
                        raise SystemExit(f"overlap-complex: split piece "
                                         f"{_pc['piece_id']} has no ground_ref; "
                                         f"refusing to build")
                    _nb = dict(_b)
                    _nb["p"] = [[float(a), float(c)] for a, c in
                                list(_ppoly.exterior.coords)[:-1]]
                    _nb["holes"] = [[[float(a), float(c)] for a, c in
                                     list(_it.coords)[:-1]]
                                    for _it in _ppoly.interiors]
                    _nb["h"] = float(_pc["height_m"])
                    _nb["y0_abs"] = float(_pg)
                    _nb["y1_abs"] = float(_pg) + float(_pc["height_m"])
                    _nb["roof_parapet"] = True
                    _nb["equip"] = _pc["roof"]["equip_boxes"]
                    _out.append(_nb)
                    _n["split_podium"] += 1
                continue
            if _act == "tower":
                _ring = clean_ring(_b["p"])
                _htot = float(_en["height_m"])
                _base = float(_en["base_m"])
                _cr = _en["crown"]
                _nb = dict(_b)
                _gt = _tower_ground(_en)
                _nb["y0_abs"] = float(_gt) + _base
                _nb["y1_abs"] = float(_gt) + _htot
                _tp = _ShpPolygon(_ring)
                _crown_rings = []
                for _inset, _ya, _yb in (
                        (float(_cr["inset1_m"]), _nb["y1_abs"] - float(_cr["shaft_top_m"]),
                         _nb["y1_abs"] - float(_cr["mid_top_m"])),
                        (float(_cr["inset2_m"]), _nb["y1_abs"] - float(_cr["mid_top_m"]),
                         _nb["y1_abs"])):
                    # 短塔 stub：冠顶退台落在裙楼顶之下时该层高为零，跳过（不建
                    # 倒置/零高棱柱）。stub < 1.5m 用平顶（两层全零 → 无冠顶，
                    # 纯棱柱）；1.5m ≤ stub < 4.0m 用单级退台（只留 -1.5m 一层）；
                    # stub ≥ 4.0m 两级退台不变。0108（stub 0.7m）、0090（stub
                    # 3.9m），2026-11-26 总协调定。
                    if _yb <= _ya:
                        continue
                    _q = _tp.buffer(-_inset)
                    if _q.is_empty or _q.geom_type != "Polygon":
                        print(f"WARN overlap-complex: tower {_fp} crown inset "
                              f"{_inset}m failed; tower stays plain prism")
                        _crown_rings = []
                        break
                    _crown_rings.append(([[float(a), float(c)] for a, c in
                                          list(_q.exterior.coords)[:-1]], _ya, _yb))
                if _crown_rings:
                    _nb["crown_rings"] = _crown_rings
                    _nb["crown_shaft_top"] = _crown_rings[0][1]
                _out.append(_nb)
                _n["tower"] += 1
                continue
            raise SystemExit(f"overlap-complex: unknown action {_act}")
        for _fp, _en in _by_fp.items():
            _unmatched.append((_en["action"], _en.get("raw_idx")))
        if _unmatched:
            raise SystemExit(f"overlap-complex: {_unmatched} layer entries did not match "
                             f"any building; refusing to build")
        print(f"overlap-complex {_layer.get('version')} applied: merge_keep {_n['merge_keep']}, "
              f"drop {_n['drop']}, podium {_n['podium']}, split_podium {_n['split_podium']}, "
              f"tower {_n['tower']} "
              f"-> {len(_out)} buildings (was {len(_buildings)})")
        return _out
    buildings = _apply_overlap_complex(buildings)
    rivers = cw["rivers"]; water = cw["water"]; fabric = cw["fabric"]
    landmarks = cw["landmarks"]

    # ---- 分块归集 ----
    chunks = {}
    def ck(x, z):
        # 六区裁剪：区外的要素进丢弃槽（不建块、不写盘），区内才进 chunks。
        if _in6(x, z):
            return chunks.setdefault(chunk_key(x, z), new_chunk())
        return new_chunk()
    _plaza_excl_n = 0
    for b in buildings:
        ring = clean_ring(b["p"])
        if len(ring) < 3: continue
        if _corr_fp(ring) in _PLAZA_EXCLUDE_FP:
            _plaza_excl_n += 1
            continue  # 2026-11-27 D3 广场圆环：烘焙时排除 3 栋冲突楼（广场层取而代之）
        cx = sum(p[0] for p in ring)/len(ring); cz = sum(p[1] for p in ring)/len(ring)
        ck(cx, cz)["b"].append(b)
    print(f"plaza bake exclusions: {_plaza_excl_n} buildings skipped (expect 3: flower / Ø37m platform / amphitheatre centre)")
    # 全部道路 75,937 条：画线（无宽度）；bridge!=None（且不是 bridge='no'）的走桥梁层，
    # 避免重复画；高架路（elev_info）由高架循环按高程画，不在这里画平线
    _road_skip_n = 0   # 2026-11-27 D3：过水补桥段跳过的地面线段数
    for r in roads_all["roads"]:
        if r.get("bridge") not in (None, "no"):
            continue
        if r["osm_id"] in elev_info:
            continue
        if r.get("tunnel") == "yes":
            # 2026-11-26 修底子：隧道段在地下，不画地面线/带面（修前是按普通路画在地面上）；
            # 只记入 tunnels 键计数（洞口另见 tunnel_portals）。building_passage 不算隧道，照常画地面。
            pf = r["points_flat"]
            pts = [lonlat_to_m(pf[i], pf[i+1]) for i in range(0, len(pf)-1, 2)]
            for i in range(len(pts)-1):
                mx, mz = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
                ck(mx, mz)["tunnels"].append((pts[i], pts[i+1]))
            continue
        pf = r["points_flat"]
        pts = [lonlat_to_m(pf[i], pf[i+1]) for i in range(0, len(pf)-1, 2)]
        if len(pts) < 2: continue
        hw = r["highway"]
        rgb = C_ROAD_MAJOR if hw in ROAD_MAJOR else (C_ROAD_FOOT if hw in ROAD_FOOT else C_ROAD_MINOR)
        for i in range(len(pts)-1):
            mx, mz = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
            if r["osm_id"] in _XCROSS_IDS and _seg_water_len(pts[i], pts[i+1]) > 0.5:
                _road_skip_n += 1
                continue  # 2026-11-27 D3 过水补桥段：地面线不画（桥面另建），只留两端引桥坡外的地面路
            ck(mx, mz)["roads"].append((pts[i], pts[i+1], rgb))
        # v3: 车行道按 road-widths-v1 画带宽面（high 层）；步行道仍画线
        _w = width_by_id.get(r["osm_id"])
        if _w and hw not in ROAD_FOOT:
            _hw2 = _w[0] / 2.0
            for i in range(len(pts)-1):
                mx, mz = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
                if r["osm_id"] in _XCROSS_IDS and _seg_water_len(pts[i], pts[i+1]) > 0.5:
                    continue  # 过水补桥段：地面带面不画
                ck(mx, mz)["road_ribbons"].append((pts[i], pts[i+1], _hw2, rgb))
    print(f"roads: ground segments skipped for water-crossing bridges: {_road_skip_n}")
    # v3: 绿道（路名含“绿道”的全部 155 条，含高空栈道桥段）画 4m 绿带
    for r in roads_all["roads"]:
        if r.get("tunnel") == "yes":
            continue  # 2026-11-26 修底子：隧道段绿道也不画地面绿带（全框 2 条）
        if "绿道" in (r.get("name") or ""):
            pf = r["points_flat"]
            pts = [lonlat_to_m(pf[i], pf[i+1]) for i in range(0, len(pf)-1, 2)]
            for i in range(len(pts)-1):
                mx, mz = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
                ck(mx, mz)["greenway"].append((pts[i], pts[i+1]))
    # ---- 2026-11-26 修底子：隧道洞口（主干车行隧道）----
    # 洞口 = tunnel=yes 的车行路端点，且该端点连着非隧道地面路（与地面交接处，OSM 节点共享判定）。
    # 位置/走向/半宽取自 OSM 原值（半宽取 road-widths-v1，缺省按 DECK_FALLBACK_HALF）；
    # 洞门框尺寸（柱 0.8m 见方、净空 4.5m、顶梁高 1.0m、框面在洞口外 0.4m）为示意尺寸，非实测。
    # 只做主干车行隧道（motorway/trunk/primary/secondary/tertiary + 各 _link）；
    # 人行/非机动车/服务路隧道只记 tunnels 计数，洞口待后续；地铁/国铁隧道不在此列（洞口是车站）。
    _PORTAL_HW = {"motorway", "motorway_link", "trunk", "trunk_link", "primary",
                  "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link"}
    _node_ways = {}
    for _r in roads_all["roads"]:
        _pf = _r.get("points_flat") or []
        _pp = [(_pf[i], _pf[i+1]) for i in range(0, len(_pf)-1, 2)]
        if len(_pp) < 2: continue
        for _j in (0, len(_pp)-1):
            _node_ways.setdefault((round(_pp[_j][0], 7), round(_pp[_j][1], 7)), []).append(_r)
    _portal_n = 0
    for _r in roads_all["roads"]:
        if _r.get("tunnel") != "yes" or _r.get("highway") not in _PORTAL_HW:
            continue
        _pf = _r.get("points_flat") or []
        _pp = [lonlat_to_m(_pf[i], _pf[i+1]) for i in range(0, len(_pf)-1, 2)]
        if len(_pp) < 2: continue
        _w = width_by_id.get(_r["osm_id"])
        _half = (_w[0] / 2.0) if _w else DECK_FALLBACK_HALF.get(_r["highway"], 5.0)
        _wsrc = _w[1] if _w else "fallback"
        for _end in (0, 1):
            _lonlat = (_pf[0], _pf[1]) if _end == 0 else (_pf[-2], _pf[-1])
            _key = (round(_lonlat[0], 7), round(_lonlat[1], 7))
            _nbrs = [o for o in _node_ways.get(_key, []) if o["osm_id"] != _r["osm_id"]]
            if not any(o.get("tunnel") in (None, "no", False) for o in _nbrs):
                continue  # 端点只连隧道段（延续）或悬空：不是洞口
            if _end == 0:
                _dx, _dz = _pp[0][0]-_pp[1][0], _pp[0][1]-_pp[1][1]
            else:
                _dx, _dz = _pp[-1][0]-_pp[-2][0], _pp[-1][1]-_pp[-2][1]
            _hd = math.degrees(math.atan2(_dz, _dx))
            _p = _pp[0] if _end == 0 else _pp[-1]
            if not _in6(_p[0], _p[1]):
                continue
            ck(_p[0], _p[1])["tunnel_portals"].append((_p[0], _p[1], _hd, _half, _r.get("name") or "", _wsrc))
            _portal_n += 1
    print(f"tunnel portals (vehicle, to-surface, in six districts): {_portal_n}")
    # ---- 2026-11-27 D3 非车行洞口（tunnel-portals-nonvehicle-v1.json，to-surface 口径 235 个） ----
    # 与车行框同款 C_PORTAL 尺寸（写块循环共用 tunnel_portals 渲染）；挂起的 83 个不建：
    # 72 个 building_passage 不算隧道、10 个中段节点、1 个六区外。
    _portal_nv = 0
    for _np in _nportals.get("portals", []):
        _x, _z = float(_np["x_m"]), float(_np["z_m"])
        if not _in6(_x, _z):
            continue
        ck(_x, _z)["tunnel_portals"].append((_x, _z, float(_np["heading_deg"]),
                                            float(_np["half_width_m"]), _np.get("name") or "",
                                            _np.get("width_source") or "file"))
        _portal_nv += 1
    print(f"tunnel portals (non-vehicle, to-surface, in six districts): {_portal_nv} (total frames {_portal_n + _portal_nv})")
    # v3: 水用 batch1 water-v1（线 4,089 + 面 1,891）+ 11 条湖记录（9 个湖名）已拼 multipolygon；
    # 大湖面片与水面按分块裁剪入块；落在湖面片内的 water 面片去重
    if water_v1.get("water_lines") or water_v1.get("water_polys"):
        _lake_rings_lonlat = []
        for _lk in lakes.get("lakes", []):
            for _rg in _lk.get("rings", []):
                _lake_rings_lonlat.append(_rg["points"])
        # ---- v3.2 第 16 项：湖心岛岛塞法（135 座岛，134 塞 + 1 个 6m2 退化洞不画）----
        # 岛几何以 lake-islands-v1.json 为准（含 lakes 文件 holes 之外漏掉的
        # 2 座兴隆湖岛）；rings[1:] 里与岛重复的环跳过，不当水面重复画。
        _isl = _load_json(os.path.join(WM, "refinement-prep", "16-lake-islands",
                                       "lake-islands-v1.json"), {"islands": []})
        _isl_rings_lonlat = []
        _isl_n = 0
        for _s in _isl.get("islands", []):
            if (_s.get("area_m2") or 0) < 10:
                continue  # 退化洞（兴隆湖 6m2，疑似伪影）：不画塞子，只记问题清单
            _pts = _s.get("hole_points_lonlat") or []
            if len(_pts) < 3:
                continue
            _isl_rings_lonlat.append(_pts)
            _ringm = [lonlat_to_m(lon, lat) for lon, lat in _pts]
            bucket_poly(chunks, _ringm, C_LU_GREEN, "water_islands")
            _isl_n += 1
        print(f"lake islands plugged: {_isl_n} (of {len(_isl.get('islands', []))} listed)")

        def _is_dup_island_ring(ring_lonlat):
            _rm = [lonlat_to_m(lon, lat) for lon, lat in ring_lonlat]
            _cx = sum(p[0] for p in _rm) / len(_rm)
            _cz = sum(p[1] for p in _rm) / len(_rm)
            _a = abs(signed_area(_rm))
            for _irg in _isl_rings_lonlat:
                _im = [lonlat_to_m(lon, lat) for lon, lat in _irg]
                _ix = sum(p[0] for p in _im) / len(_im)
                _iz = sum(p[1] for p in _im) / len(_im)
                _ia = abs(signed_area(_im))
                if math.hypot(_cx - _ix, _cz - _iz) < 1.0 and \
                        abs(_a - _ia) / max(_ia, 1.0) < 0.01:
                    return True
            return False
        for _rg in _lake_rings_lonlat:
            if _is_dup_island_ring(_rg):
                continue
            _ringm = [lonlat_to_m(lon, lat) for lon, lat in _rg]
            bucket_poly(chunks, _ringm, C_WATER, "water")
        for _wp in water_v1.get("water_polys", []):
            _pts = _wp.get("points") or []
            if len(_pts) < 3: continue
            _cx = sum(p[0] for p in _pts)/len(_pts)
            _cy = sum(p[1] for p in _pts)/len(_pts)
            if any(point_in_poly_lonlat(_cx, _cy, _rg) for _rg in _lake_rings_lonlat) \
                    and not any(point_in_poly_lonlat(_cx, _cy, _irg) for _irg in _isl_rings_lonlat):
                continue  # 在湖环内且不在岛环内才去重；岛上水面（岛上池塘）保留
            _ringm = [lonlat_to_m(lon, lat) for lon, lat in _pts]
            bucket_poly(chunks, _ringm, C_WATER, "water")
        # ---- 2026-11-26 修底子：河岸栏杆（river_rails），跟着河一起做 ----
        # 沿真实水面边界走：water=river 的水面多边形边界（六区内 93 个）+ 六区内 5 条湖记录的外环。
        # 栏杆 = 顶梁（边界折线，地面+1.1m）+ 立柱（沿边界每 ~10m 一根，地面→+1.1m），
        # 元组 (a, b, kind)：kind 0 = 顶梁段，kind 1 = 立柱（a == b 的 xz）。
        # 1.1m 高、10m 间距为示意尺寸，非实测；边界取自 OSM 原值。
        # canal/stream/drain/ditch 不做栏杆（多为沟渠）；桥跨处未抠洞（已知局限，见报告）。
        _rail_cut = {"segs": 0, "posts": 0}   # 2026-11-27 D3：桥处抠洞（落入桥面投影的栏杆段/立柱去掉）
        def _rail_ring(_ringm):
            for i in range(len(_ringm)):
                a = _ringm[i]; b = _ringm[(i+1) % len(_ringm)]
                mx, mz = (a[0]+b[0])/2, (a[1]+b[1])/2
                if _deck_hit(mx, mz):
                    _rail_cut["segs"] += 1   # 栏杆段落入桥面投影：抠掉
                else:
                    ck(mx, mz)["river_rails"].append((a, b, 0))
                _el = math.hypot(b[0]-a[0], b[1]-a[1])
                _npost = int(_el // 10.0)
                for _k in range(1, _npost+1):
                    _t = _k*10.0/_el
                    _px = a[0]+(b[0]-a[0])*_t; _pz = a[1]+(b[1]-a[1])*_t
                    if _deck_hit(_px, _pz):
                        _rail_cut["posts"] += 1
                        continue
                    ck(_px, _pz)["river_rails"].append(((_px, _pz), (_px, _pz), 1))
        _rail_n = 0
        for _wp in water_v1.get("water_polys", []):
            if _wp.get("water") != "river": continue
            _pts = _wp.get("points") or []
            if len(_pts) < 3: continue
            _ringm = [lonlat_to_m(lon, lat) for lon, lat in _pts]
            if not any(_in6(x, z) for x, z in _ringm): continue
            _rail_ring(_ringm); _rail_n += 1
        for _lk in lakes.get("lakes", []):
            if not _lk.get("rings"): continue
            _outer = max(_lk["rings"], key=lambda r: r["area_m2"])
            _ringm = [lonlat_to_m(lon, lat) for lon, lat in _outer["points"]]
            if not any(_in6(x, z) for x, z in _ringm): continue
            _rail_ring(_ringm); _rail_n += 1
        print(f"river rails: {_rail_n} water boundaries (river polys + lake outer rings in six districts); "
              f"cut at bridge decks: {_rail_cut['segs']} rail segs, {_rail_cut['posts']} posts")
        for _wl in water_v1.get("water_lines", []):
            _pts = [lonlat_to_m(lon, lat) for lon, lat in (_wl.get("points") or [])]
            for i in range(len(_pts)-1):
                mx, mz = (_pts[i][0]+_pts[i+1][0])/2, (_pts[i][1]+_pts[i+1][1])/2
                ck(mx, mz)["rivers"].append((_pts[i], _pts[i+1]))
    else:
        for r in rivers:
            pts = [[float(a), float(b)] for a, b in r["p"]]
            for i in range(len(pts)-1):
                mx, mz = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
                ck(mx, mz)["rivers"].append((pts[i], pts[i+1]))
        for w in water:
            ring = clean_ring(w["p"])
            if len(ring) < 3: continue
            bucket_poly(chunks, ring, C_WATER, "water")
    # 桥梁 9,399：不在 elev_info 里的画平线（铁路高架等不在 roads 文件里的路仍走平，
    # 只做形状线）；在 elev_info 里的由高架循环按高程画，不在这里重复画平线。
    # 2026-11-25 零平桥后全部 9,399 座均有数值桥面高（推算值标方法与误差），§7.10 留平规则已退役。
    # 2026-11-27 D3 FB 平桥：bridge-fb-decks-v1.json 里的 377 条六区内 way 改实心桥面，
    # 这里不再画地面+0.3m 平线（否则桥面上下两条线重叠）；8 条 layer=0 地面桥（held）仍画平线。
    _fb_deck_ids = {_d["osm_id"] for _d in _fbdecks.get("decks", []) if _d.get("in_six")}
    _flat_skip = 0
    for b in bridges["bridges"]:
        if b["osm_id"] in elev_info or b["osm_id"] in _fb_deck_ids:
            if b["osm_id"] in _fb_deck_ids:
                _flat_skip += 1
            continue
        pf = b["points_flat"]
        pts = [lonlat_to_m(pf[i], pf[i+1]) for i in range(0, len(pf)-1, 2)]
        for i in range(len(pts)-1):
            mx, mz = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
            ck(mx, mz)["bridges"].append((pts[i], pts[i+1]))
    for b in bridges["footbridges"]:
        if b["osm_id"] in elev_info or b["osm_id"] in _fb_deck_ids:
            if b["osm_id"] in _fb_deck_ids:
                _flat_skip += 1
            continue
        pf = b["points_flat"]
        pts = [lonlat_to_m(pf[i], pf[i+1]) for i in range(0, len(pf)-1, 2)]
        for i in range(len(pts)-1):
            mx, mz = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
            ck(mx, mz)["footbridges"].append((pts[i], pts[i+1]))
    print(f"flat bridge lines skipped for FB solid decks: {_flat_skip} ways")
    # 地铁线路：按 ref 去重取第一条方向，画线（无线宽）
    seen_ref = set()
    for ln in metro["lines"]:
        if ln["ref"] in seen_ref: continue
        seen_ref.add(ln["ref"])
        rgb = hex_rgb(ln.get("colour") or "#888888")
        pts = [lonlat_to_m(lon, lat) for lon, lat in ln["points"]]
        for i in range(len(pts)-1):
            mx, mz = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
            ck(mx, mz)["metro_line"].append((pts[i], pts[i+1], rgb))
    for w in metro["elevated_ways"]:
        pts = [lonlat_to_m(lon, lat) for lon, lat in w["pts"]]
        for i in range(len(pts)-1):
            mx, mz = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
            ck(mx, mz)["metro_elev"].append((pts[i], pts[i+1]))
    for s in metro["stations"]:
        ck(s["x"], s["z"])["stations"].append(s)
    for e in metro["entrances"]:
        ck(e["x"], e["z"])["entrances"].append(e)
    # ---- 地铁口估算 v1（2026-11-25）：161 站 714 口，全部 method=推算、verification_status=未核对。
    # 与 819 个 OSM 实测口严格分开：单独进 entrances_est 键、单独计数、单独颜色；
    # 绝不混进 entrances、不许当实测。只留六区内的口（区外删掉）。
    try:
        _est = json.load(open(os.path.join(DATA, "metro", "metro-entrances-estimated-v1.json")))
        _est_n, _est_in = 0, 0
        for _st in _est.get("stations", []):
            for _ex in _st.get("exits", []):
                _est_n += 1
                _ex_x, _ex_z = lonlat_to_m(float(_ex["lon"]), float(_ex["lat"]))
                if not _in6(_ex_x, _ex_z):
                    continue
                _est_in += 1
                ck(_ex_x, _ex_z)["entrances_est"].append({
                    "station": _st.get("station"), "exit_ref": _ex.get("exit_ref"),
                    "x": _ex_x, "z": _ex_z,
                    "method": "推算",
                    "verification_status": "未核对",
                    "description": _ex.get("description", ""),
                    "corner": _ex.get("corner", ""),
                    "dist_to_station_m": _ex.get("dist_to_station_m")})
        print(f"metro entrances estimated v1: {_est_in} of {_est_n} inside six districts (all method=推算, 未核对)", flush=True)
    except Exception as _e:
        print(f"WARN metro entrances estimated v1 not loaded: {_e!r}", flush=True)
    # ---- v3.2 第 17 项：地铁站厅/站台（369 站；3 unknown 站跳过，不编）----
    # 尺寸除 OSM 站台轮廓外均为推测（数据文件逐项标注）。OSM 站 24 座（2026-11-27 D3 补升仙湖站）：
    # 多条 platform way 轮廓用凸包合并为一站台环（逐条轮廓见源数据）；
    # fallback 站 345 座：站台 120x12m 矩形，走向 = 最近线路段方向角。
    # 站厅 = 站台环外扩 8m。地下站台顶 -12m / 站厅 -6.0 至 -1.5m；
    # 高架站台板 10.1m / 站厅地面层 0.4 至 5.4m（绝对高，DEM-506 口径）。
    _sgeo = _load_json(os.path.join(WM, "refinement-prep", "17-metro-stations",
                                    "metro-stations-geometry-v1.json"),
                       {"stations": []})
    _st_n = {"hall": 0, "platform": 0, "skipped_unknown": 0}
    for _st in _sgeo.get("stations", []):
        if _st.get("kind") == "unknown":
            _st_n["skipped_unknown"] += 1
            continue
        _x, _z = _st["x_m"], _st["z_m"]
        _plat = _st["platform"]; _hall = _st["hall"]
        _top = float(_plat["top_y_m"])
        if _plat.get("source") == "osm_platform_ways":
            _pts = [p for _w in _st.get("platform_ways", [])
                    for p in _w.get("outline_m", [])]
            _pring = _convex_hull(_pts) if len(_pts) >= 3 else None
            if _pring is None or len(_pring) < 3:
                # 3 站的 OSM 站台 way 只有 2 个点（线，非多边形：钓鱼嘴、
                # 东郊记忆、植物园），无法成环——改用 120x12m fallback 矩形
                # （推测，与无轮廓站同口径），不丢站。
                _pring = _rect_ring(_x, _z, 120.0, 12.0,
                                    float(_st.get("line_heading_deg") or 0.0))
                _hring = _rect_ring(_x, _z, 136.0, 28.0,
                                    float(_st.get("line_heading_deg") or 0.0))
            else:
                _hring = _expand_ring(_pring, 8.0)
        else:
            _fb = _plat["fallback_box"]
            _pring = _rect_ring(_x, _z, float(_fb["length_m"]),
                                float(_fb["width_m"]), float(_fb["heading_deg"]))
            _hring = _rect_ring(_x, _z, float(_fb["length_m"]) + 16,
                                float(_fb["width_m"]) + 16, float(_fb["heading_deg"]))
        bucket_poly(chunks, clean_ring(_pring), (_top - 1.0, _top),
                    "station_platform")
        bucket_poly(chunks, clean_ring(_hring),
                    (float(_hall["y0_m"]), float(_hall["y1_m"])), "station_hall")
        _st_n["platform"] += 1
        _st_n["hall"] += 1
    print(f"metro station hall/platform: {_st_n}")
    for lm in landmarks:
        ck(lm["x"], lm["z"])["landmarks"].append(lm)
    # 小区 5,068：地面轮廓线（真实外环）+ 大门估计标记
    for cp in compounds["compounds"]:
        pts = [lonlat_to_m(lon, lat) for lon, lat in cp["points"]]
        if len(pts) < 3: continue
        cx, cz = lonlat_to_m(*cp["centroid"])
        ck(cx, cz)["compounds"].append(cp)
    # 铁路（PBF 实抽）：画线；隧道段（subway tunnel=yes）同层、颜色同 subway
    # 2026-11-27 D3 铁路：tunnel=yes/building_passage 的段跳过不画（与车行隧道排除地面画法同规矩）；
    # 隧道中心线格网供 natrail 反查去重（national-rail-v1.json 无 tunnel 标签）。
    _rail_tunnel_ids = set()
    _rail_tunnel_grid = {}
    _rail_skip = {"ways": 0, "km": 0.0}
    for w in railway["ways"]:
        if w.get("tunnel") not in ("yes", "building_passage"):
            continue
        _rail_tunnel_ids.add(w["osm_id"])
        _pf = w.get("points_flat") or []
        _pts = [lonlat_to_m(_pf[i], _pf[i+1]) for i in range(0, len(_pf)-1, 2)]
        for i in range(len(_pts)-1):
            _x0 = int(min(_pts[i][0], _pts[i+1][0])-20)//100; _x1 = int(max(_pts[i][0], _pts[i+1][0])+20)//100
            _z0 = int(min(_pts[i][1], _pts[i+1][1])-20)//100; _z1 = int(max(_pts[i][1], _pts[i+1][1])+20)//100
            for _cx in range(_x0, _x1+1):
                for _cz in range(_z0, _z1+1):
                    _rail_tunnel_grid.setdefault((_cx, _cz), []).append((_pts[i], _pts[i+1]))
    def _rail_tunnel_hit(_x, _z, _r=20.0):
        for (_a, _b) in _rail_tunnel_grid.get((int(_x)//100, int(_z)//100), []):
            _dx, _dz = _b[0]-_a[0], _b[1]-_a[1]
            _l2 = _dx*_dx+_dz*_dz
            _t = 0.0 if _l2 == 0 else max(0.0, min(1.0, ((_x-_a[0])*_dx+(_z-_a[1])*_dz)/_l2))
            if ((_x-(_a[0]+_t*_dx))**2+(_z-(_a[1]+_t*_dz))**2)**0.5 <= _r:
                return True
        return False
    for w in railway["ways"]:
        if w.get("tunnel") in ("yes", "building_passage"):
            _rail_skip["ways"] += 1
            _pf = w.get("points_flat") or []
            _pts = [lonlat_to_m(_pf[i], _pf[i+1]) for i in range(0, len(_pf)-1, 2)]
            for i in range(len(_pts)-1):
                _rail_skip["km"] += math.hypot(_pts[i+1][0]-_pts[i][0], _pts[i+1][1]-_pts[i][1])/1000.0
            continue
        pf = w["points_flat"]
        pts = [lonlat_to_m(pf[i], pf[i+1]) for i in range(0, len(pf)-1, 2)]
        if len(pts) < 2: continue
        rgb = rail_color(w["railway"])
        for i in range(len(pts)-1):
            mx, mz = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
            ck(mx, mz)["railway"].append((pts[i], pts[i+1], rgb))
    print(f"railway tunnel segments skipped: {_rail_skip['ways']} ways, {_rail_skip['km']:.2f} km")
    # ---- v3: 地面用地 15,164 面（按类别画地面色块；简化到 ≤64 点；<200m² 跳过；洞忽略） ----
    # 2026-11-27 D3 广场圆环 ground_cut：与 R75 圆盘相交的 landuse 面先减去圆盘再分桶（圆盘地面由广场层提供，不留双层地面）
    _pz_cut_n = 0
    for _f in landuse.get("features", []):
        _pts = _f.get("points") or []
        if len(_pts) < 3: continue
        if (_f.get("area_m2") or 0) < 200: continue
        _ring = [lonlat_to_m(lon, lat) for lon, lat in _pts]
        if len(_ring) > 64:
            _step = len(_ring) / 64.0
            _ring = [_ring[int(i*_step)] for i in range(64)]
        if _pz_disc is not None:
            try:
                _lp = _ShpPolygon(_ring)
                _hit = _lp.is_valid and _pz_disc_prep.intersects(_lp)
            except Exception:
                _hit = False
            if _hit:
                try:
                    _diff = _lp.difference(_pz_disc)
                except Exception:
                    _diff = None
                if _diff is None or _diff.is_empty:
                    continue
                if _diff.geom_type == "Polygon":
                    _parts = [_diff]
                elif _diff.geom_type == "MultiPolygon":
                    _parts = list(_diff.geoms)
                else:  # GeometryCollection：只取其中多边形部分并记一笔（洞按既有“洞忽略”口径，不静默丢）
                    _parts = [g for g in getattr(_diff, "geoms", []) if g.geom_type == "Polygon"]
                    print(f"WARN plaza landuse cut: GeometryCollection, kept {len(_parts)} polygon parts")
                for _pp in _parts:
                    if _pp.is_empty or _pp.area < 200: continue
                    bucket_poly(chunks, [[float(a), float(b)] for a, b in _pp.exterior.coords],
                                LU_COLOR.get(_f.get("category"), [0.85, 0.85, 0.85]), "landuse")
                _pz_cut_n += 1
                continue
        bucket_poly(chunks, _ring, LU_COLOR.get(_f.get("category"), [0.85, 0.85, 0.85]), "landuse")
    print(f"plaza landuse cut: {_pz_cut_n} faces cut by R75 disc")
    # ---- v3: 国铁（24,438 线 / 530 站）按模型范围过滤 ----
    _nt_skip = {"lines_by_id": 0, "segs_by_proximity": 0}
    for _rl in natrail.get("rail_lines", []):
        if _rl.get("osm_id") in _rail_tunnel_ids:
            _nt_skip["lines_by_id"] += 1
            continue  # 整条 way 在 railway-v1 里标 tunnel：全是隧道，不画
        _rpts = _rl.get("points") or []
        _pts = [lonlat_to_m(lon, lat) for lon, lat in _rpts]
        for i in range(len(_pts)-1):
            _mlon = (_rpts[i][0]+_rpts[i+1][0])/2
            _mlat = (_rpts[i][1]+_rpts[i+1][1])/2
            if not (MODEL_LON[0] <= _mlon <= MODEL_LON[1] and MODEL_LAT[0] <= _mlat <= MODEL_LAT[1]):
                continue
            mx, mz = (_pts[i][0]+_pts[i+1][0])/2, (_pts[i][1]+_pts[i+1][1])/2
            if _rail_tunnel_hit(mx, mz):
                _nt_skip["segs_by_proximity"] += 1
                continue  # 段中点 20m 内有铁路隧道中心线：隧道细线不画
            ck(mx, mz)["natrail"].append((_pts[i], _pts[i+1]))
    print(f"natrail tunnel segments skipped: {_nt_skip}")
    for _st in natrail.get("stations", []):
        if _st.get("lon") is None or _st.get("lat") is None: continue
        if not (MODEL_LON[0] <= _st["lon"] <= MODEL_LON[1] and MODEL_LAT[0] <= _st["lat"] <= MODEL_LAT[1]):
            continue
        _x, _z = lonlat_to_m(_st["lon"], _st["lat"])
        ck(_x, _z)["natrail_stations"].append((_x, _z, _st.get("name") in KEY_STATIONS))
    # ---- v3: 路灯（lamps-city；位置为沿真实 OSM 路按 CJJ45 间距放置，非 OSM 原值） ----
    _lamp_n = 0
    for _tf in sorted(glob.glob(os.path.join(DATA, "lamps-city", "tiles", "tile_*.json"))):
        try:
            _lamps = json.load(open(_tf))
        except Exception:
            continue
        for _lp in _lamps:
            _x, _z = float(_lp["x"]), float(_lp["y"])
            _h = lamp_height(_lp)   # 2026-11-27 D3：新 tiles 自带 h（12/10/8/6m），无 h 回落 style
            ck(_x, _z)["lamps"].append((_x, _z, _h))
            _lamp_n += 1
    print(f"lamps bucketed: {_lamp_n}")
    # ---- v3.2 第 18 项：桥隧灯（桥杆灯 42,530 + 隧道顶灯 5,864；与地面灯分键）----
    # 口径：桥隧灯不用建成区过滤（构筑物照明与周边有无建筑无关，CJJ45）。
    # 桥面高取灯记录 base_y_m（与白模已画桥面同一套数；跨河桥文件值是
    # “桥面至水面高”，base_y 误差 ±2-5m，逐盏标 deck_error_m）。
    # 隧道顶灯无杆，记洞内高（地面高 - 洞深，洞深按 layer 推测，未实测）。
    _bt_n = {"bridge": 0, "tunnel": 0}
    for _tf in sorted(glob.glob(os.path.join(
            WM, "refinement-prep", "18-bridge-tunnel-lamps", "tiles", "tile_*.json"))):
        try:
            _bl = json.load(open(_tf))
        except Exception:
            continue
        for _lp in _bl:
            _x, _z = float(_lp["x"]), float(_lp["y"])
            if _lp.get("kind") == "bridge_pole":
                ck(_x, _z)["lamps_bridge"].append(
                    (_x, _z, lamp_height(_lp),   # 2026-11-27 D3：桥灯无 h，按 hw 查表（与城灯同表）
                     float(_lp["base_y_m"])))
                _bt_n["bridge"] += 1
            else:
                ck(_x, _z)["lamps_tunnel"].append((_x, _z, float(_lp["base_y_m"])))
                _bt_n["tunnel"] += 1
    print(f"bridge/tunnel lamps bucketed: {_bt_n}")
    # ---- v3.2 第 19 项：花坛（bbox 内 26 条：25 面实抽几何 + 1 点）----
    # 花坛几何从四川 PBF 实抽（flowers-geometry-v1.json），不编位置；
    # 单点花坛（三角花坛 node 9623147712）画 6x6m 标记方（点要素示意，推测尺寸）。
    # 花园 291 面已在 landuse 里以 park 类别画入（v3.1 已有），此处不重复画。
    _flg = _load_json(os.path.join(WM, "refinement-prep", "19-flowers",
                                   "flowers-geometry-v1.json"), {"records": []})
    _fl_n = 0
    for _fr in _flg.get("records", []):
        if _fr.get("kind") == "way":
            _pts = _fr.get("points_lonlat") or []
            if len(_pts) < 3:
                continue
            _ring = [lonlat_to_m(lon, lat) for lon, lat in _pts]
            bucket_poly(chunks, clean_ring(_ring), C_FLOWER, "flowers")
            _fl_n += 1
        elif _fr.get("kind") == "node" and _fr.get("point_lonlat"):
            _nx, _nz = lonlat_to_m(*_fr["point_lonlat"])
            _sq = [[_nx - 3, _nz - 3], [_nx + 3, _nz - 3],
                   [_nx + 3, _nz + 3], [_nx - 3, _nz + 3]]
            bucket_poly(chunks, _sq, C_FLOWER, "flowers")
            _fl_n += 1
    print(f"flowerbeds bucketed: {_fl_n}")
    # ---- v3: 树（OSM 实测单木 1,207 棵真实位置 + WorldCover 10m 树盖采样） ----
    for _tp in street_trees.get("points", []):
        _x, _z = lonlat_to_m(_tp[0], _tp[1])
        _hh = 4 + ((int(_x*7) ^ int(_z*13)) % 5)
        _ww = 2.0 + (((int(_x*3) ^ int(_z*11)) % 3) * 0.5)
        ck(_x, _z)["trees"].append((_x, _z, float(_hh), _ww, _TREE_SHADES[(int(_x)+int(_z)) % 3]))
    if _wc is not None:
        _STRIDE = 6
        _sub = _wc[::_STRIDE, ::_STRIDE]
        _rws, _cls = np.where(_sub == 10)
        _tot = len(_rws)
        _MAXT = 200000
        _thr = 1000 if _tot <= _MAXT else int(1000 * _MAXT / _tot)
        _hsh = ((_rws * 73856093) ^ (_cls * 19349663)) % 1000
        _keep = _hsh < _thr
        _rws, _cls = _rws[_keep], _cls[_keep]
        _per_chunk = {}
        _ntrees = 0
        for _rw, _cl in zip(_rws.tolist(), _cls.tolist()):
            _r0, _c0 = _rw*_STRIDE, _cl*_STRIDE
            _x = -30170.0 + (_c0+0.5)*10.0
            _z = 31510.0 - (_r0+0.5)*10.0
            _k = chunk_key(_x, _z)
            if _per_chunk.get(_k, 0) >= 300: continue
            _per_chunk[_k] = _per_chunk.get(_k, 0) + 1
            _hh = 4 + ((_rw*31 + _cl*17) % 5)
            _ww = 2.0 + (((_rw*7 + _cl*13) % 3) * 0.5)
            _sh = _TREE_SHADES[(_rw + _cl) % 3]
            ck(_x, _z)["trees"].append((_x, _z, float(_hh), _ww, _sh))
            _ntrees += 1
        print(f"worldcover sampled trees: {_ntrees} (candidates {_tot}, hash-kept {len(_rws)})")
    # ---- v3: 机场（跑道/滑行道按真实宽度画带；停机坪画地面片） ----
    for _af in aeroway.get("features", []):
        _pts = [lonlat_to_m(lon, lat) for lon, lat in _af["points"]]
        if _af["aeroway"] == "apron":
            if len(_pts) >= 3:
                bucket_poly(chunks, _pts, C_APRON, "aprons")
            continue
        _w = _af.get("width_m")
        try: _w = float(_w) if _w is not None else None
        except Exception: _w = None
        if _w is None:
            _w = 45.0 if _af["aeroway"] == "runway" else 15.0
        _rgb = C_RUNWAY if _af["aeroway"] == "runway" else C_TAXIWAY
        for i in range(len(_pts)-1):
            mx, mz = (_pts[i][0]+_pts[i+1][0])/2, (_pts[i][1]+_pts[i+1][1])/2
            ck(mx, mz)["runway"].append((_pts[i], _pts[i+1], _w/2.0, _rgb))
    # ---- v3: 山上点位（有名山峰/观景点，模型范围内画小标记；范围外进远景地形） ----
    for _mp in mt_pois.get("points", []):
        if not _mp.get("name"): continue
        if not (MODEL_LON[0] <= _mp["lon"] <= MODEL_LON[1] and MODEL_LAT[0] <= _mp["lat"] <= MODEL_LAT[1]):
            continue
        _x, _z = lonlat_to_m(_mp["lon"], _mp["lat"])
        ck(_x, _z)["mt_pois"].append((_x, _z))
    # ---- v3: 特型桥（bridge-shapes.json，7 座 + 2 环特征） ----
    _bridge_by_id = {b["osm_id"]: b for b in bridges["bridges"] + bridges["footbridges"]}
    def _cum(pts):
        c = [0.0]
        for i in range(1, len(pts)):
            c.append(c[-1] + math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]))
        return c
    def _at(pts, cum, frac):
        target = cum[-1] * frac
        j = next((i for i in range(1, len(cum)) if cum[i] >= target), len(cum)-1)
        f = (target - cum[j-1]) / max(cum[j]-cum[j-1], 1e-9)
        x = pts[j-1][0] + (pts[j][0]-pts[j-1][0])*f
        z = pts[j-1][1] + (pts[j][1]-pts[j-1][1])*f
        tl = math.hypot(pts[j][0]-pts[j-1][0], pts[j][1]-pts[j-1][1]) or 1.0
        return x, z, (pts[j][0]-pts[j-1][0])/tl, (pts[j][1]-pts[j-1][1])/tl
    def _deck_pts(osm_ids):
        _ways = []
        for oid in osm_ids or []:
            b = _bridge_by_id.get(oid)
            if not b: continue
            pf = b.get("points_flat") or []
            pts = [lonlat_to_m(pf[i], pf[i+1]) for i in range(0, len(pf)-1, 2)]
            if len(pts) >= 2: _ways.append(pts)
        if not _ways: return None
        if len(_ways) == 1: return _ways[0]
        # 2026-11-26 方向归一（双向桥 bug 修）：成对双向桥的两条 way 在 OSM 里
        # 方向相反（各行其道），直接按同 frac 取点平均会把 600m 桥面压成几米的点团
        # （修前实测：九眼桥 226m 桥 9 孔拱 144 个顶点压进 1.4m×0.0m；云龙湾/
        # 天保湾/锦江斜拉/天府大道月牙桥同病，另 3 座在六区外本次不进包）。
        # 以首条 way 为基准，其余 way 若反向（起止点与基准的终起点更近）先翻转再平均。
        _ref = _ways[0]
        _oriented = [_ref]
        for _w in _ways[1:]:
            _d_same = math.hypot(_w[0][0]-_ref[0][0], _w[0][1]-_ref[0][1]) + \
                      math.hypot(_w[-1][0]-_ref[-1][0], _w[-1][1]-_ref[-1][1])
            _d_opp = math.hypot(_w[0][0]-_ref[-1][0], _w[0][1]-_ref[-1][1]) + \
                     math.hypot(_w[-1][0]-_ref[0][0], _w[-1][1]-_ref[0][1])
            _oriented.append(list(reversed(_w)) if _d_opp < _d_same else _w)
        _ways = _oriented
        _avg = []
        for _k in range(51):
            _f = _k/50.0
            _xs, _zs = [], []
            for _w in _ways:
                _c = _cum(_w)
                _x, _z, _, _ = _at(_w, _c, _f)
                _xs.append(_x); _zs.append(_z)
            _avg.append([sum(_xs)/len(_xs), sum(_zs)/len(_zs)])
        return _avg
    V_PIER_WAYS = set()
    RING_WAY_IDS = {r["osm_id"] for r in roads_all["roads"] if "二环" in (r.get("name") or "")}
    PAIFANG_LOC = None
    def _ring_dir(x, z):
        best = None
        for r in roads_all["roads"]:
            if "二环" not in (r.get("name") or ""): continue
            pf = r["points_flat"]
            ppts = [lonlat_to_m(pf[i], pf[i+1]) for i in range(0, len(pf)-1, 2)]
            for i in range(len(ppts)-1):
                mx, mz = (ppts[i][0]+ppts[i+1][0])/2, (ppts[i][1]+ppts[i+1][1])/2
                d = math.hypot(mx-x, mz-z)
                if best is None or d < best[0]:
                    tl = math.hypot(ppts[i+1][0]-ppts[i][0], ppts[i+1][1]-ppts[i][1]) or 1.0
                    best = (d, (ppts[i+1][0]-ppts[i][0])/tl, (ppts[i+1][1]-ppts[i][1])/tl)
        return (best[1], best[2]) if best else (1.0, 0.0)
    def _bucket_line3d(a, b):
        mx, mz = (a[0]+b[0])/2, (a[2]+b[2])/2
        ck(mx, mz)["special_lines"].append((a, b))
    for _sh in shapes.get("shapes", []):
        _sid = _sh.get("id")
        _deck_h = float(_sh.get("deck_height_m") or 6.25)
        _pts = _deck_pts(_sh.get("deck_osm_ids") or [])
        if _pts is None and _sid == "jinmahu":
            _ol = None
            for _oid in _sh.get("outline_osm_ids") or []:
                _b = _bridge_by_id.get(_oid)
                if _b and _b.get("points_flat"):
                    _ol = _b["points_flat"]; break
            if _ol:
                _op = [lonlat_to_m(_ol[i], _ol[i+1]) for i in range(0, len(_ol)-1, 2)]
                _best = None
                for _i in range(len(_op)):
                    for _j in range(_i+1, len(_op)):
                        _d = math.hypot(_op[_j][0]-_op[_i][0], _op[_j][1]-_op[_i][1])
                        if _best is None or _d > _best[0]: _best = (_d, _op[_i], _op[_j])
                if _best: _pts = [_best[1], _best[2]]
        if _pts is None or len(_pts) < 2:
            print(f"WARN special bridge {_sid}: no deck centreline, skipped")
            continue
        _clen = _cum(_pts)
        _par = _sh.get("params") or {}
        _typ = _sh.get("type")
        def _deck_y(x, z):
            return ground(x, z) + _deck_h
        if _typ == "suspension_twin_tower":
            _fr = _par.get("tower_offset_frac") or [0.331, 0.669]
            _th = float(_par.get("tower_height_m") or 67)
            _sag = float(_par.get("cable_sag_m") or 20.5)
            _tops = []
            for _f in _fr:
                _x, _z, _tx, _tz = _at(_pts, _clen, _f)
                _y = _deck_y(_x, _z)
                _px, _pz = -_tz*2.5, _tx*2.5
                _bucket_line3d([_x+_px, _y, _z+_pz], [_x+_px, _y+_th, _z+_pz])
                _bucket_line3d([_x-_px, _y, _z-_pz], [_x-_px, _y+_th, _z-_pz])
                _bucket_line3d([_x+_px, _y+_th, _z+_pz], [_x-_px, _y+_th, _z-_pz])
                _tops.append((_x, _z, _y+_th))
            if len(_tops) == 2:
                (x1, z1, y1), (x2, z2, y2) = _tops
                _prev = None
                for _i in range(21):
                    _t = _i/20
                    _x = x1 + (x2-x1)*_t; _z = z1 + (z2-z1)*_t
                    _y = y1 + (y2-y1)*_t - _sag*4*_t*(1-_t)
                    if _prev: _bucket_line3d(_prev, [_x, _y, _z])
                    _prev = [_x, _y, _z]
                _span = math.hypot(x2-x1, z2-z1)
                _n = max(1, int(_span // 20))
                for _k in range(1, _n):
                    _t = _k/_n
                    _x = x1 + (x2-x1)*_t; _z = z1 + (z2-z1)*_t
                    _cy = y1 + (y2-y1)*_t - _sag*4*_t*(1-_t)
                    _dy = _deck_y(_x, _z)
                    _bucket_line3d([_x, _dy, _z], [_x, _cy, _z])
                for (_tx_, _tz_, _ty_), (_ex, _ez) in [(_tops[0], _pts[0]), (_tops[1], _pts[-1])]:
                    _bucket_line3d([_tx_, _ty_, _tz_], [_ex, _deck_y(_ex, _ez), _ez])
        elif _typ in ("arch_through_steel_truss", "arch_through_cfst_tied"):
            _fr = _par.get("arch_span_frac") or [0.365, 0.635]
            _rise = float(_par.get("arch_rise_m") or 40)
            _f0, _f1 = _fr[0], _fr[1]
            for _off in (-3.0, 0.0, 3.0):
                _prev = None
                for _i in range(25):
                    _t = _i/24
                    _f = _f0 + (_f1-_f0)*_t
                    _x, _z, _tx, _tz = _at(_pts, _clen, _f)
                    _px, _pz = -_tz*_off, _tx*_off
                    _y = _deck_y(_x, _z) + _rise*4*_t*(1-_t)
                    _p = [_x+_px, _y, _z+_pz]
                    if _prev: _bucket_line3d(_prev, _p)
                    _prev = _p
        elif _typ == "curved_deck_v_piers":
            for _oid in _sh.get("deck_osm_ids") or []:
                V_PIER_WAYS.add(_oid)
        elif _typ == "corridor_stone_arch":
            _frs = _par.get("arch_span_frac") or [[0, 0.311], [0.311, 0.689], [0.689, 1.0]]
            _ratio = float(_par.get("arch_rise_ratio") or 0.25)
            for (_f0, _f1) in _frs:
                _span = (_f1-_f0) * _clen[-1]
                _rise = _span * _ratio
                _prev = None
                for _i in range(13):
                    _t = _i/12
                    _f = _f0 + (_f1-_f0)*_t
                    _x, _z, _tx, _tz = _at(_pts, _clen, _f)
                    _dy = _deck_y(_x, _z)
                    _spring = max(_dy - _rise, ground(_x, _z) + 0.2)
                    _y = _spring + (_dy - 0.3 - _spring) * 4*_t*(1-_t)
                    _p = [_x, _y, _z]
                    if _prev: _bucket_line3d(_prev, _p)
                    _prev = _p
            _roof_h = float(_par.get("corridor_roof_height_m") or 8)
            _x0, _z0 = _pts[0]; _x1, _z1 = _pts[-1]
            _tl = math.hypot(_x1-_x0, _z1-_z0) or 1.0
            _tx, _tz = (_x1-_x0)/_tl, (_z1-_z0)/_tl
            _px, _pz = -_tz*4.0, _tx*4.0
            _ring = [[_x0+_px, _z0+_pz], [_x1+_px, _z1+_pz], [_x1-_px, _z1-_pz], [_x0-_px, _z0-_pz]]
            _gy0 = ground((_x0+_x1)/2, (_z0+_z1)/2) + _deck_h
            ck((_x0+_x1)/2, (_z0+_z1)/2)["special_tris"].append((_ring, _gy0, _gy0+_roof_h, [0.70, 0.62, 0.50]))
        elif _typ == "multi_arch_stone":
            _n = int(_par.get("arch_count") or 9)
            for _k in range(_n):
                _f0, _f1 = _k/_n, (_k+1)/_n
                _span = (_f1-_f0) * _clen[-1]
                _rise = _span * float(_par.get("arch_rise_ratio") or 0.25)
                _prev = None
                for _i in range(9):
                    _t = _i/8
                    _f = _f0 + (_f1-_f0)*_t
                    _x, _z, _tx, _tz = _at(_pts, _clen, _f)
                    _dy = _deck_y(_x, _z)
                    _spring = max(_dy - _rise, ground(_x, _z) + 0.2)
                    _y = _spring + (_dy - 0.3 - _spring) * 4*_t*(1-_t)
                    _p = [_x, _y, _z]
                    if _prev: _bucket_line3d(_prev, _p)
                    _prev = _p
        # cable_stayed_deck_only：只建桥面，不编造桥塔
    for _rf in shapes.get("ring_features", []):
        _loc = _rf.get("location_m") or {}
        _x, _z = float(_loc.get("x", 0)), float(_loc.get("z", 0))
        _par = _rf.get("params") or {}
        _tx, _tz = _ring_dir(_x, _z)
        _px, _pz = -_tz, _tx
        _dy = ground(_x, _z)
        if _rf.get("id") == "hongpailou_paifang":
            PAIFANG_LOC = (_x, _z)
            _w = float(_par.get("archway_width_m") or 25) / 2
            _h = float(_par.get("archway_height_m") or 12)
            _deck = _dy + 10.0
            for _s in (-1, 1):
                ck(_x, _z)["special_lines"].append(([_x+_px*_w*_s, _deck, _z+_pz*_w*_s], [_x+_px*_w*_s, _deck+_h, _z+_pz*_w*_s]))
            ck(_x, _z)["special_lines"].append(([_x+_px*_w, _deck+_h, _z+_pz*_w], [_x-_px*_w, _deck+_h, _z-_pz*_w]))
        elif _rf.get("id") == "rennan_cable_tower":
            _th = float(_par.get("tower_height_m") or 30)
            _deck = _dy + 10.0
            _spread = float(_par.get("leg_spread_m") or 12) / 2
            _top = [_x, _deck+_th, _z]
            for _s in (-1, 1):
                ck(_x, _z)["special_lines"].append(([_x+_px*_spread*_s, _deck, _z+_pz*_spread*_s], _top))
            _cb = float(_par.get("cross_beam_height_m") or 12)
            ck(_x, _z)["special_lines"].append(([_x+_px*_spread, _deck+_cb, _z+_pz*_spread], [_x-_px*_spread, _deck+_cb, _z-_pz*_spread]))
            for _off in _par.get("cable_fan_offsets_m") or [20, 40, 60]:
                for _s in (-1, 1):
                    ck(_x, _z)["special_lines"].append((_top, [_x+_tx*_off*_s, _deck, _z+_tz*_off*_s]))

    # ---- 高架路（§7.14）：按端点高沿路长插值画坡线；高度>2m 处每 ~30m 立桥墩 ----
    # 2026-11-25 立交立体：每段再加实体桥面（顶面 + 底面 + 两侧，厚 1.9m 车行 / 0.8m 人行，
    # 宽取 road-widths-v1，缺省按等级中位数推算标 fallback）；桥墩改实心方柱（地面→桥面底）。
    # 顶面按 OSM layer 分档着色（L1 深 → L5 浅），缺 layer 按桥面高分档；匝道坡度仍由
    # vertex_heights 沿路长线性插值给出（坡，不是台阶），桥面顶面跟着坡走。
    _deck_w_file = 0
    _deck_w_fallback = 0
    for oid, ev in elev_info.items():
        r = _roads_by_id[oid]
        lp = way_pts(r)
        if len(lp) < 2:
            continue
        vh = _elev_vh(oid, ev, lp)   # 2026-11-27 D3：overrides 烤好的顶点高优先，缺省沿路长插值
        pts = [lonlat_to_m(lon, lat) for lon, lat in lp]
        hw = ev["highway"]
        if hw in ("footway", "cycleway", "steps", "path", "pedestrian"):
            rgb = C_FOOTBRIDGE
        elif hw in SCOPE:
            rgb = C_ELEV_RAMP
        else:
            rgb = C_BRIDGE
        is_ramp = hw in SCOPE
        _thick = DECK_THICK_FOOT if hw in ("footway", "cycleway", "steps", "path", "pedestrian") else DECK_THICK_VEH
        _w = width_by_id.get(oid)
        if _w:
            _hw2 = _w[0] / 2.0
        else:
            _hw2 = DECK_FALLBACK_HALF.get(hw, 4.5)
        _lay = ev.get("layer")
        total = 0.0
        cum = [0.0]
        for i in range(1, len(pts)):
            total += math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1])
            cum.append(total)
        for i in range(len(pts)-1):
            mx, mz = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
            ck(mx, mz)["elev"].append((pts[i], pts[i+1], vh[i], vh[i+1], rgb, is_ramp, _hw2, _thick, _lay))
            if _w:
                _deck_w_file += 1
            else:
                _deck_w_fallback += 1
        # 桥墩：沿路长每 30m 一根（高度>2m 的区段），地面→桥面
        # 2026-11-27 D3：普通墩改走 bridge-piers-v1.json（墩位已分类：路边/空地/水里/
        # 隔离带/挪人行道/一跨过去掉）；此处只保留 V 墩与红牌楼牌坊缺口（文件里已排除这两类）。
        if total > 0:
            d = 30.0
            while d < total:
                j = next(i for i in range(1, len(cum)) if cum[i] >= d)
                f = (d - cum[j-1]) / max(cum[j]-cum[j-1], 1e-9)
                px = pts[j-1][0] + (pts[j][0]-pts[j-1][0]) * f
                pz = pts[j-1][1] + (pts[j][1]-pts[j-1][1]) * f
                ph = vh[j-1] + (vh[j]-vh[j-1]) * f
                if ph > 2.0:
                    if oid in V_PIER_WAYS:
                        _tx, _tz = pts[j][0]-pts[j-1][0], pts[j][1]-pts[j-1][1]
                        _tl = math.hypot(_tx, _tz) or 1.0
                        ck(px, pz)["vpiers"].append((px, pz, ph, _tx/_tl, _tz/_tl))
                    elif oid in RING_WAY_IDS and PAIFANG_LOC and math.hypot(px-PAIFANG_LOC[0], pz-PAIFANG_LOC[1]) < 33.08:
                        pass  # 红牌楼牌坊处 66.16m 桥墩空缺（公开记录最长单跨）
                    # else：普通墩由 bridge-piers-v1.json 提供，不在这里重复建
                d += 30.0
    print(f"deck widths: file { _deck_w_file} segs, fallback { _deck_w_fallback} segs")
    # ---- 2026-11-27 D3：FB 实心桥面 + 过水补桥 + 桥墩文件 + 护栏 + 天桥楼梯 + BRT + 公园 ----
    # FB/过水补桥段进 elev 键（与 §7.14 同款元组：写块循环画实心桥面 + 线；两端高 ≤0.05m 的段只留线）。
    _fb_buck_n = 0; _fb_buck_fb = 0; _fb_buck_xc = 0
    for _idx, (_a, _b, _ha, _hb, _hw2, _thick, _lay) in enumerate(_fbdeck_segs + _xcross_decks):
        _mx, _mz = (_a[0]+_b[0])/2, (_a[1]+_b[1])/2
        if not _in6(_mx, _mz):
            continue  # 区外段进丢弃槽，不计数
        ck(_mx, _mz)["elev"].append((_a, _b, _ha, _hb, C_BRIDGE, False, _hw2, _thick, _lay))
        _fb_buck_n += 1
        if _idx < len(_fbdeck_segs):
            _fb_buck_fb += 1
        else:
            _fb_buck_xc += 1
    print(f"FB + crossing deck segs bucketed into elev: {_fb_buck_n} (FB {_fb_buck_fb} in-six of {len(_fbdeck_segs)}, crossing {_fb_buck_xc} of {len(_xcross_decks)})")
    # 桥墩（bridge-piers-v1.json）：shift_to_sidewalk 用移位坐标；drop_span_over 不建；
    # V 墩 9 站 + 牌坊缺口 4 站不在文件里（上文内联逻辑已处理，不重复建）。
    _pier_n = {"built": 0, "shifted": 0, "dropped": 0}
    for _p in _bpiers.get("piers", []):
        if _p.get("action") == "drop_span_over":
            _pier_n["dropped"] += 1
            continue
        if _p.get("action") == "shift_to_sidewalk":
            _x, _z = float(_p["shifted_x_m"]), float(_p["shifted_z_m"])
            _pier_n["shifted"] += 1
        else:
            _x, _z = float(_p["x_m"]), float(_p["z_m"])
        ck(_x, _z)["piers"].append((_x, _z, float(_p["deck_h_m"]), float(_p.get("thick_m", 1.9))))
        _pier_n["built"] += 1
    for (_x, _z, _h, _thick) in _xcross_piers:
        ck(_x, _z)["piers"].append((_x, _z, _h, _thick))
    print(f"piers from file: {_pier_n}; crossing piers: {len(_xcross_piers)}")
    # 高架护栏（bridge-guardrails-v1.json）：每条 run 按段入块（与全码线要素同规则），
    # 元组 ((x1,z1,deck_h1),(x2,z2,deck_h2))；写块时 y = 地面 + deck_h + 1.1m。
    _gr_n = {"runs": 0, "segs": 0}
    for _g in _brails.get("guardrails", []):
        _pts = _g.get("pts", [])
        if len(_pts) < 2:
            continue
        _gr_n["runs"] += 1
        for i in range(len(_pts)-1):
            _a, _b = _pts[i], _pts[i+1]
            _mx, _mz = (_a[0]+_b[0])/2, (_a[1]+_b[1])/2
            ck(_mx, _mz)["guardrails"].append(((float(_a[0]), float(_a[1]), float(_a[2])),
                                               (float(_b[0]), float(_b[1]), float(_b[2]))))
            _gr_n["segs"] += 1
    print(f"guardrails bucketed: {_gr_n}")
    # 人行天桥楼梯/坡道（bridge-footbridge-stairs-v1.json）：stair_needed 的端头才建
    _stair_n = 0
    for _fb in _bstairs.get("footbridges", []):
        for _e in _fb.get("ends", []):
            if not _e.get("stair_needed"):
                continue
            ck(float(_e["x_m"]), float(_e["z_m"]))["foot_stairs"].append(
                (float(_e["x_m"]), float(_e["z_m"]), float(_e["deck_h_m"]),
                 float(_e["heading_out_deg"]), float(_e["run_m"]), float(_e["width_m"])))
            _stair_n += 1
    print(f"footbridge stairs bucketed: {_stair_n}")
    # BRT 站台（brt-stations-v1.json）：24x3m 板 + 雨棚 + 栏杆（示意尺寸），跟所在段桥面高
    for (_sx, _sz, _dh, _hd) in _brt_platforms:
        ck(_sx, _sz)["brt_platforms"].append((_sx, _sz, _dh, _hd))
    print(f"BRT platforms bucketed: {len(_brt_platforms)}")
    # ---- 2026-11-27 D3 公园精细（six-parks-v1.json + park-amenities-v1.json；4 名园） ----
    # 园路：3,310 runs（已裁到六区）按 footway/path 画 1.5m 半宽窄带（写块循环 park_paths）。
    # 园内水/园内建筑已在通用水/楼循环里画（本文件只审计计数，不重复画）。
    _pp_n = 0
    for _run in _parks.get("paths", []):
        _pts = _run.get("pts_m") or []
        for i in range(len(_pts)-1):
            _a, _b = _pts[i], _pts[i+1]
            _mx, _mz = (_a[0]+_b[0])/2, (_a[1]+_b[1])/2
            ck(_mx, _mz)["park_paths"].append((_a, _b, 1.5, C_ROAD_FOOT))
            _pp_n += 1
    # 公园小品：厕所 3x2x2.5m、kiosk 2.5x2x2.5m（示意尺寸）；亭子：环 + 柱 + 顶（示意 2.4m 柱 + 0.3m 顶）。
    _pa_n = {"toilet": 0, "kiosk": 0, "pavilion": 0}
    for _it in _pamen.get("items", []):
        _k = _it.get("kind")
        _x, _z = float(_it["x"]), float(_it["z"])
        if _k in ("toilet", "kiosk"):
            ck(_x, _z)["park_amenities"].append((_x, _z, _k))
            _pa_n[_k] += 1
        elif _k in ("pavilion", "pavilion_roof", "pavilion_shelter"):
            _ring = _it.get("ring")
            if not _ring:
                _ring = [[_x-2, _z-2], [_x+2, _z-2], [_x+2, _z+2], [_x-2, _z+2]]   # 节点亭默认 4x4m
            ck(_x, _z)["park_pavilions"].append(([[float(a), float(b)] for a, b in _ring], _k))
            _pa_n["pavilion"] += 1
    print(f"park paths bucketed: {_pp_n} segs; park amenities: {_pa_n}")
    # 名园密种树（six-parks-v1.json trees.named_parks，20m 采样；树高沿用哈希估算 4-8m）
    _pt_n = 0
    for _pk, _td in (_parks.get("trees", {}) or {}).get("named_parks", {}).items():
        for (_tx, _tz) in _td.get("points", []):
            _hh = 4 + ((int(_tx*7) ^ int(_tz*13)) % 5)
            _ww = 2.0 + (((int(_tx*3) ^ int(_tz*11)) % 3) * 0.5)
            _sh = _TREE_SHADES[(int(_tx)+int(_tz)) % 3]
            ck(_tx, _tz)["trees"].append((_tx, _tz, float(_hh), _ww, _sh))
            _pt_n += 1
    print(f"named-park dense trees bucketed: {_pt_n}")
    # 园内 OSM 单木 71（six-parks trees.osm_trees_in_parks，实测位置；树高沿用哈希估算 4-8m）
    _ot_n = 0
    for _ot in (_parks.get("trees", {}) or {}).get("osm_trees_in_parks", []):
        _tx, _tz = float(_ot["x"]), float(_ot["z"])
        _hh = 4 + ((int(_tx*7) ^ int(_tz*13)) % 5)
        _ww = 2.0 + (((int(_tx*3) ^ int(_tz*11)) % 3) * 0.5)
        _sh = _TREE_SHADES[(int(_tx)+int(_tz)) % 3]
        ck(_tx, _tz)["trees"].append((_tx, _tz, float(_hh), _ww, _sh))
        _ot_n += 1
    print(f"park OSM single trees bucketed: {_ot_n}")
    # 健身/游乐（six-park-leisure.json，2026-11-27 Parks2 交接：D3 直接消费；OSM 31 实测 + 种子 17 示意；
    # G04 熊猫基地 2 项无公园面、位置仅为地标中心示意，跳过不画）
    _pl_n = {"fitness_station_osm": 0, "fitness_station_seeded": 0, "playground_osm": 0, "playground_seeded": 0, "flagged_skipped": 0}
    for _li in _pleis.get("items", []):
        if _li.get("flag"):
            _pl_n["flagged_skipped"] += 1
            continue
        _k = _li.get("kind")
        _src = _li.get("source", "")
        if _k not in ("fitness_station", "playground"):
            continue
        ck(float(_li["x"]), float(_li["z"]))["park_leisure"].append((float(_li["x"]), float(_li["z"]), _k, _src))
        _pl_n[f"{_k}_{'osm' if _src == 'osm' else 'seeded'}"] += 1
    print(f"park leisure bucketed: {_pl_n}")
    # ---- 2026-11-27 D3：星泽广场三圆（plaza-circles-v2.json，数据层；独立脚本只出验收叠加层，不进包）----
    # 几何与 build_plaza_circles.py 同款函数、同参数；进临时 Acc 后按三角重心分桶（hi+mid 两档都进）。
    _pz_acc = Acc(); _pz_lines = LineAcc()
    _pz_disc_d = _plaza.get("disc", {})
    _pz_structs = {s["id"]: s for s in _plaza.get("structures", [])}
    _pz_kept = 0
    if _pz_disc_d and _pz_structs:
        _dcx, _dcz = float(_pz_disc_d["center"]["x"]), float(_pz_disc_d["center"]["z"])
        _g_disc = ground(_dcx, _dcz)
        _right0 = _pz_structs["right_amphitheatre"]
        _rx0 = float(_right0["center"]["x"]); _rz0 = float(_right0["center"]["z"])
        _pz_kept = disc_with_hole(_pz_acc, _dcx, _dcz, float(_pz_disc_d["radius_m"]),
                                  _g_disc + float(_pz_disc_d["y_rel_ground"]),
                                  _pz_disc_d["color"], _rx0, _rz0,
                                  float(_right0["ring"]["radius_m"]))
        # 圆盘竖沿 (2026-11-27 加深): 外圈 3m 宽环顶 +0.30, 外壁 + 内壁竖直
        _rim_d = _pz_disc_d.get("rim")
        if _rim_d:
            annulus_top(_pz_acc, _dcx, _dcz, float(_rim_d["r_out"]), float(_rim_d["r_in"]),
                        _g_disc + float(_rim_d["y_rel_ground"]), _rim_d["color"])
            wall_band(_pz_acc, _dcx, _dcz, float(_rim_d["r_out"]),
                      _g_disc + float(_rim_d["y_rel_ground"]),
                      _g_disc + float(_pz_disc_d["y_rel_ground"]), _rim_d["color"],
                      inward=False)
            wall_band(_pz_acc, _dcx, _dcz, float(_rim_d["r_in"]),
                      _g_disc + float(_rim_d["y_rel_ground"]),
                      _g_disc + float(_pz_disc_d["y_rel_ground"]), _rim_d["color"],
                      inward=True)
        # 左：太阳神鸟（深色圆盘 + 基座两环 + 分层雕塑）
        _left = _pz_structs["left_sunbird"]
        _lx, _lz = float(_left["center"]["x"]), float(_left["center"]["z"])
        _g_left = ground(_lx, _lz)
        _dd = _left["dark_disc"]
        # 2026-11-27 加深: 深盘改厚盘 (盘面 +0.06 起, 顶 +0.30), 带竖直侧壁
        thick_disc(_pz_acc, _lx, _lz, float(_dd["radius_m"]),
                   _g_left + float(_pz_disc_d["y_rel_ground"]),
                   _g_left + float(_dd["y_rel_ground"]), _dd["color"])
        _small = _left["plinth"]
        for _key in ("outer", "inner"):
            _part = _small[_key]
            _ring = [list(lonlat_to_m(lon, lat)) for lon, lat in _part["points_lonlat"]]
            if _ring[0] == _ring[-1]:
                _ring = _ring[:-1]
            _y0 = _g_left + float(_part["y0_rel_ground"])
            _y1 = _g_left + float(_part["y1_rel_ground"])
            _rgb = shade_by_height(float(_part["y1_rel_ground"]))
            prism(_pz_acc, _ring, _y0, _y1, _rgb)
        _sc = _left["sculpture"]
        _scol = _sc["color"]
        for _part in _sc["parts"]:
            if _part["shape"] == "cylinder":
                cylinder(_pz_acc, _lx, _lz, float(_part["radius_m"]),
                         _g_left + float(_part["y0_rel_ground"]),
                         _g_left + float(_part["y1_rel_ground"]), _scol)
            elif _part["shape"] == "disc":
                _y1 = _g_left + float(_part["y_rel_ground"])
                thick_disc(_pz_acc, _lx, _lz, float(_part["radius_m"]),
                           _y1 - float(_part["thickness_m"]), _y1, _scol)
            elif _part["shape"].startswith("3 arc"):
                _ys = _part["y_rel_ground"]
                _span = float(_part["span_deg"])
                _step = float(_part["rotation_step_deg"])
                _th = float(_part["thickness_m"])
                _r_out = float(_part.get("r_out_m", 5.5))
                _r_in = float(_part.get("r_in_m", 4.0))
                for _j, _y in enumerate(_ys):
                    _a0 = _j * _step
                    _a1 = _a0 + _span
                    _y1 = _g_left + float(_y)
                    arc_annulus_top(_pz_acc, _lx, _lz, _r_out, _r_in, _y1, _scol, _a0, _a1)
                    arc_wall_band(_pz_acc, _lx, _lz, _r_out, _y1, _y1 - _th, _scol, _a0, _a1, inward=False)
                    arc_wall_band(_pz_acc, _lx, _lz, _r_in, _y1, _y1 - _th, _scol, _a0, _a1, inward=True)
        # 中：花盘（OSM 实测圆台 + 8 瓣花形浮雕）
        _midf = _pz_structs["mid_flower"]
        _mx, _mz = float(_midf["center"]["x"]), float(_midf["center"]["z"])
        _g_mid = ground(_mx, _mz)
        _d = _midf["disc"]
        _ring = [list(lonlat_to_m(lon, lat)) for lon, lat in _d["points_lonlat"]]
        if _ring[0] == _ring[-1]:
            _ring = _ring[:-1]
        prism(_pz_acc, _ring, _g_mid + float(_d["y0_rel_ground"]),
              _g_mid + float(_d["y1_rel_ground"]), _d["color"])
        _fl = _midf["flower"]
        _fcol = _fl["color"]
        _cd = _fl["centre_disc"]
        cylinder(_pz_acc, _mx, _mz, float(_cd["radius_m"]),
                 _g_mid + float(_cd["y0_rel_ground"]),
                 _g_mid + float(_cd["y1_rel_ground"]), _fcol)
        _pt = _fl["petals"]
        for _k in range(int(_pt["count"])):
            _a = 2.0 * math.pi * _k / int(_pt["count"])
            _px = _mx + float(_pt["ring_radius_m"]) * math.cos(_a)
            _pz = _mz + float(_pt["ring_radius_m"]) * math.sin(_a)
            cylinder(_pz_acc, _px, _pz, float(_pt["radius_m"]),
                     _g_mid + float(_pt["y0_rel_ground"]),
                     _g_mid + float(_pt["y1_rel_ground"]), _fcol)
        # 右：站环圆形剧场（外圈环 + 8 级台阶下沉 + 碗底 + 中央分层构筑）
        _right = _pz_structs["right_amphitheatre"]
        _rx, _rz = float(_right["center"]["x"]), float(_right["center"]["z"])
        _g_right = ground(_rx, _rz)
        _rim = _right["rim"]
        annulus_top(_pz_acc, _rx, _rz, float(_rim["r_out"]), float(_rim["r_in"]),
                    _g_right + float(_rim["y_rel_ground"]), _rim["color"])
        for _t in _right["steps"]["treads"]:
            _y = _g_right + float(_t["y_rel_ground"])
            annulus_top(_pz_acc, _rx, _rz, float(_t["r_out"]), float(_t["r_in"]), _y, _t["color"])
            _y_prev = _y + float(_right["steps"]["rise_m"])
            wall_band(_pz_acc, _rx, _rz, float(_t["r_out"]), _y_prev, _y, _t["color"], inward=True)
        _floor = _right["floor"]
        disc_top(_pz_acc, _rx, _rz, float(_floor["radius_m"]),
                 _g_right + float(_floor["y_rel_ground"]), _floor["color"])
        _cs = _right["central_structure"]
        for _part in _cs["parts"]:
            cylinder(_pz_acc, _rx, _rz, float(_part["radius_m"]),
                     _g_right + float(_part["y0_rel_ground"]),
                     _g_right + float(_part["y1_rel_ground"]), _cs["color"])
        # 描边线：圆盘外圈 + 站环外圈
        _disc_pts = circle_pts(_dcx, _dcz, float(_pz_disc_d["radius_m"]), _PZ_SEG)
        _disc_pts.append(_disc_pts[0])
        _pz_lines.ring(_disc_pts, lambda x, z: _g_disc + 0.32, [0.45, 0.45, 0.48])
        _ring_pts = circle_pts(_rx, _rz, float(_right["ring"]["radius_m"]), _PZ_SEG)
        _ring_pts.append(_ring_pts[0])
        _pz_lines.ring(_ring_pts, lambda x, z: _g_right + 0.47, [0.45, 0.45, 0.48])
    # 按三角/线段重心分桶（圆盘跨 119_100/119_101 两块，重心定块）
    _pz_n = 0
    for _i in range(0, len(_pz_acc.pos), 9):
        _a = _pz_acc.pos[_i:_i+3]; _b = _pz_acc.pos[_i+3:_i+6]; _cc = _pz_acc.pos[_i+6:_i+9]
        _n = _pz_acc.nor[_i:_i+3]; _rgb = _pz_acc.col[_i:_i+3]
        _mx = (_a[0]+_b[0]+_cc[0])/3.0; _mz = (_a[2]+_b[2]+_cc[2])/3.0
        ck(_mx, _mz)["plaza_circles"].append(("tri", _a, _b, _cc, _n, _rgb))
        _pz_n += 1
    for _i in range(0, len(_pz_lines.pos), 6):
        _a = _pz_lines.pos[_i:_i+3]; _b = _pz_lines.pos[_i+3:_i+6]; _rgb = _pz_lines.col[_i:_i+3]
        _mx = (_a[0]+_b[0])/2.0; _mz = (_a[2]+_b[2])/2.0
        ck(_mx, _mz)["plaza_circles"].append(("seg", _a, _b, _rgb))
        _pz_n += 1
    print(f"plaza circles bucketed: {_pz_n} tris+segs (temp Acc {_pz_acc.tris()} tris, disc grid kept {_pz_kept}/576; overlay is 6399 tris)")
    # ---- 收费站（§7.14，PBF 实抽）：亭点为示意盒，落在高架上时按桥面高落座 ----
    for p in toll["booth_points"]:
        x, z = lonlat_to_m(p["lon"], p["lat"])
        hs = _node_elev_h.get(key_of(p["lon"], p["lat"]), [])
        deck_h = max(hs) if hs else None
        ck(x, z)["toll_booths"].append((x, z, deck_h))
    for w in toll["ways"]:
        pf = w["points_flat"]
        pts = [lonlat_to_m(pf[i], pf[i+1]) for i in range(0, len(pf)-1, 2)]
        if len(pts) < 3:
            continue
        cx = sum(p[0] for p in pts)/len(pts); cz = sum(p[1] for p in pts)/len(pts)
        ck(cx, cz)["toll_plazas"].append(pts)

    keys = sorted(chunks.keys())
    force = set()
    # 兴隆湖环（最大外环）+ 官方湖面高程：湖面水/入湖河段按“点在环内或环上”取湖面高。
    # DEM 补丁按格心判定，岸边碎片的中心格心可能落在环外（中心在环内、格心在环外），
    # 那时 ground() 会返回旧农田高程，碎片浮在湖面上；凹形碎片的中心甚至落在环外，
    # 所以水面片要按顶点判定，河段按端点判定。
    _xl_ring = None
    _xl_ringm = []
    _xl_bbox = None
    for _lk in lakes.get("lakes", []):
        if _lk.get("name") == "兴隆湖" and _lk.get("rings"):
            _xl_ring = max(_lk["rings"], key=lambda r: r["area_m2"])["points"]
            break
    if _xl_ring:
        _xl_ringm = [lonlat_to_m(lon, lat) for lon, lat in _xl_ring]
        _xs = [p[0] for p in _xl_ringm]; _zs = [p[1] for p in _xl_ringm]
        _xl_bbox = (min(_xs), min(_zs), max(_xs), max(_zs))
    _XL_LEVEL = 464.0 - DATUM  # 兴隆湖官方湖面 464m（生态环境部 2025-07-21），相对高程
    def _in_xinglong(x, z):
        """点在兴隆湖环内或环上（环上容差 1m）。环外点先过 bbox 速判。"""
        if not _xl_ring:
            return False
        if not (_xl_bbox[0]-1 <= x <= _xl_bbox[2]+1 and _xl_bbox[1]-1 <= z <= _xl_bbox[3]+1):
            return False
        if point_in_poly_lonlat(104.065+x/LON_M, 30.665+z/LAT_M, _xl_ring):
            return True
        n = len(_xl_ringm)
        for _i in range(n):
            _ax, _az = _xl_ringm[_i]; _bx, _bz = _xl_ringm[(_i+1) % n]
            _dx, _dz = _bx-_ax, _bz-_az
            _l2 = _dx*_dx+_dz*_dz
            _t = 0.0 if _l2 == 0 else max(0.0, min(1.0, ((x-_ax)*_dx+(z-_az)*_dz)/_l2))
            if ((x-(_ax+_t*_dx))**2+(z-(_az+_t*_dz))**2) ** 0.5 <= 1.0:
                return True
        return False
    if args.only_chunks:
        wanted = [tuple(c) for c in json.load(open(args.only_chunks))]
        force = set(f"{c[0]}_{c[1]}" for c in wanted)
        keys = [k for k in keys if k in set(wanted)]
        print(f"only-chunks: {len(keys)} requested, {len(wanted)-len(keys)} not in occupied chunks")
    if args.chunk_range:
        keys = keys[args.chunk_range[0]:args.chunk_range[1]]
    if args.limit:
        keys = keys[:args.limit]
    print(f"occupied chunks: {len(chunks)}, to build: {len(keys)}")

    index = {}
    done_n = 0
    for ki, k in enumerate(keys):
        c = chunks[k]
        tag = f"{k[0]}_{k[1]}"
        hi_path = os.path.join(OUT, "chunks", f"{tag}_high.glb")
        mid_path = os.path.join(OUT, "chunks", f"{tag}_mid.glb")
        prev = log["done"].get(tag)
        if prev and tag not in force and prev.get("format_version") == FORMAT_VERSION and os.path.exists(hi_path) and (os.path.exists(mid_path) or not prev.get("bytes_mid")):
            index[tag] = prev; done_n += 1; continue
        try:
            hi, mid, hl, ml = Acc(), Acc(), LineAcc(), LineAcc()
            gy = lambda x, z: ground(x, z)
            for b in c["b"]:
                ring = clean_ring(b["p"]); h = float(b["h"])
                cx = sum(p[0] for p in ring)/len(ring); cz = sum(p[1] for p in ring)/len(ring)
                # overlap-complex 层可定绝对高程（塔基 = 裙楼顶面，保证塔基与裙楼顶严丝合缝）
                y0 = float(b.get("y0_abs", ground(cx, cz)))
                y1 = float(b.get("y1_abs", y0 + h))
                rgb = shade_by_height(h)
                if b.get("holes") is not None or b.get("cdt_top"):
                    _holed_prism(hi, ring, b.get("holes") or [], y0, y1, rgb)
                elif b.get("crown_rings"):
                    prism(hi, ring, y0, b["crown_rings"][0][1], rgb)
                    for (_cring, _ca, _cb) in b["crown_rings"]:
                        prism(hi, _cring, _ca, _cb, rgb)
                else:
                    prism(hi, ring, y0, y1, rgb)
                if b.get("roof_parapet"):
                    _parapet(hi, ring, y1, 0.5, 0.3, rgb)
                for _bx in b.get("equip", []):
                    _ex, _ez = float(_bx["x"]), float(_bx["z"])
                    _ew, _ed, _eh = float(_bx["w"]), float(_bx["d"]), float(_bx["h"])
                    prism(hi, [[_ex - _ew / 2, _ez - _ed / 2], [_ex + _ew / 2, _ez - _ed / 2],
                               [_ex + _ew / 2, _ez + _ed / 2], [_ex - _ew / 2, _ez + _ed / 2]],
                          y1, y1 + _eh, [0.95, 0.95, 0.95])
                xs = [p[0] for p in ring]; zs = [p[1] for p in ring]
                box = [[min(xs), min(zs)], [max(xs), min(zs)], [max(xs), max(zs)], [min(xs), max(zs)]]
                prism(mid, box, y0, y1, rgb)
            for (a, b, rgb) in c["roads"]:
                hl.seg([a[0], gy(a[0], a[1])+0.3, a[1]], [b[0], gy(b[0], b[1])+0.3, b[1]], rgb)
            for (a, b, hw2, rgb) in c["road_ribbons"]:
                _dx, _dz = b[0]-a[0], b[1]-a[1]
                _ln = math.hypot(_dx, _dz) or 1.0
                _px, _pz = -_dz/_ln*hw2, _dx/_ln*hw2
                _ya, _yb = gy(a[0], a[1])+0.05, gy(b[0], b[1])+0.05
                hi.quad([a[0]+_px, _ya, a[1]+_pz], [b[0]+_px, _yb, b[1]+_pz],
                        [b[0]-_px, _yb, b[1]-_pz], [a[0]-_px, _ya, a[1]-_pz], [0, 1, 0], rgb)
            for (a, b) in c["greenway"]:
                _dx, _dz = b[0]-a[0], b[1]-a[1]
                _ln = math.hypot(_dx, _dz) or 1.0
                _px, _pz = -_dz/_ln*2.0, _dx/_ln*2.0
                _ya, _yb = gy(a[0], a[1])+0.08, gy(b[0], b[1])+0.08
                hi.quad([a[0]+_px, _ya, a[1]+_pz], [b[0]+_px, _yb, b[1]+_pz],
                        [b[0]-_px, _yb, b[1]-_pz], [a[0]-_px, _ya, a[1]-_pz], [0, 1, 0], C_GREENWAY)
            for (a, b, hw2, rgb) in c["runway"]:
                _dx, _dz = b[0]-a[0], b[1]-a[1]
                _ln = math.hypot(_dx, _dz) or 1.0
                _px, _pz = -_dz/_ln*hw2, _dx/_ln*hw2
                _ya, _yb = gy(a[0], a[1])+0.06, gy(b[0], b[1])+0.06
                hi.quad([a[0]+_px, _ya, a[1]+_pz], [b[0]+_px, _yb, b[1]+_pz],
                        [b[0]-_px, _yb, b[1]-_pz], [a[0]-_px, _ya, a[1]-_pz], [0, 1, 0], rgb)
            for (a, b) in c["rivers"]:
                _ya = _XL_LEVEL+0.15 if _in_xinglong(a[0], a[1]) else gy(a[0], a[1])+0.15
                _yb = _XL_LEVEL+0.15 if _in_xinglong(b[0], b[1]) else gy(b[0], b[1])+0.15
                hl.seg([a[0], _ya, a[1]], [b[0], _yb, b[1]], C_WATER)
                ml.seg([a[0], _ya, a[1]], [b[0], _yb, b[1]], C_WATER)
            for (a, b, kind) in c["river_rails"]:
                # 2026-11-26 修底子：河岸栏杆。kind 0 顶梁（地面+1.1m），kind 1 立柱（地面→+1.1m）。
                if kind == 1:
                    _yb0 = gy(a[0], a[1])
                    hl.seg([a[0], _yb0, a[1]], [a[0], _yb0+1.1, a[1]], C_RAIL)
                    ml.seg([a[0], _yb0, a[1]], [a[0], _yb0+1.1, a[1]], C_RAIL)
                else:
                    _ya = gy(a[0], a[1])+1.1; _yb = gy(b[0], b[1])+1.1
                    hl.seg([a[0], _ya, a[1]], [b[0], _yb, b[1]], C_RAIL)
                    ml.seg([a[0], _ya, a[1]], [b[0], _yb, b[1]], C_RAIL)
            for (x, z, hd, half_w, _nm, _ws) in c["tunnel_portals"]:
                # 2026-11-26 修底子：隧道洞门框（high 档）。两根边柱 + 顶梁，横跨路宽，面朝洞外方向 hd。
                # 尺寸示意（柱 0.8m 见方、净空 4.5m、梁高 1.0m、框面在洞口外 0.4m）；位置/走向/半宽取自 OSM。
                _y0 = gy(x, z)
                _ux, _uz = math.cos(math.radians(hd)), math.sin(math.radians(hd))
                _vx, _vz = -_uz, _ux
                _hw2 = half_w + 0.8
                _fx, _fz = x - _ux*0.4, z - _uz*0.4
                for _s in (-1, 1):
                    _px = _fx + _vx*_s*_hw2; _pz = _fz + _vz*_s*_hw2
                    _corn = [[_px + _vx*0.4*_a + _ux*0.4*_b, _pz + _vz*0.4*_a + _uz*0.4*_b]
                             for _a, _b in [(-1, -1), (1, -1), (1, 1), (-1, 1)]]
                    prism(hi, _corn, _y0, _y0+5.5, C_PORTAL)
                _lx1, _lz1 = _fx - _vx*_hw2, _fz - _vz*_hw2
                _lx2, _lz2 = _fx + _vx*_hw2, _fz + _vz*_hw2
                _bx, _bz = _ux*0.5, _uz*0.5
                prism(hi, [[_lx1-_bx, _lz1-_bz], [_lx2-_bx, _lz2-_bz],
                          [_lx2+_bx, _lz2+_bz], [_lx1+_bx, _lz1+_bz]], _y0+4.5, _y0+5.5, C_PORTAL)
            for (ring, rgb) in c["water"]:
                _cx = sum(p[0] for p in ring)/len(ring); _cz = sum(p[1] for p in ring)/len(ring)
                _wy = ground(_cx, _cz)+0.15
                if _xl_ring and (_in_xinglong(_cx, _cz) or any(_in_xinglong(p[0], p[1]) for p in ring)):
                    _wy = _XL_LEVEL+0.15  # 顶点/中心在兴隆湖环内或环上：按官方湖面 464m
                flat_poly(hi, ring, _wy, rgb)
                flat_poly(mid, ring, _wy, rgb)  # 2026-11-26 修底子：水面进 mid 档（修前 mid 无水，远看河湖消失）
            for (ring, rgb) in c["water_islands"]:
                # v3.2 第 16 项：岛塞（陆地绿，盖在水面之上 0.15m；兴隆湖岛按官方湖面高）
                _cx = sum(p[0] for p in ring)/len(ring); _cz = sum(p[1] for p in ring)/len(ring)
                _wy = ground(_cx, _cz)+0.15
                if _xl_ring and (_in_xinglong(_cx, _cz) or any(_in_xinglong(p[0], p[1]) for p in ring)):
                    _wy = _XL_LEVEL+0.15
                _tris, _pts = triangulate_plug(ring)
                for (a, b, cc) in _tris:
                    hi.tri([_pts[a][0], _wy, _pts[a][1]], [_pts[b][0], _wy, _pts[b][1]],
                           [_pts[cc][0], _wy, _pts[cc][1]], [0, 1, 0], rgb)
                flat_poly(mid, ring, _wy, rgb)  # 2026-11-26 修底子：岛塞进 mid 档（与水面同高，避免远看岛浮在无水地面上）
            for (ring, rgb) in c["landuse"]:
                _cx = sum(p[0] for p in ring)/len(ring); _cz = sum(p[1] for p in ring)/len(ring)
                flat_poly(hi, ring, ground(_cx, _cz)+0.04, rgb)
                flat_poly(mid, ring, ground(_cx, _cz)+0.04, rgb)
            for (ring, rgb) in c["flowers"]:
                # v3.2 第 19 项：花坛（粉色 flats，高出地面 0.06m，盖在 landuse 之上）
                _cx = sum(p[0] for p in ring)/len(ring); _cz = sum(p[1] for p in ring)/len(ring)
                flat_poly(hi, ring, ground(_cx, _cz)+0.06, rgb)
            for (ring, rgb) in c["aprons"]:
                _cx = sum(p[0] for p in ring)/len(ring); _cz = sum(p[1] for p in ring)/len(ring)
                flat_poly(hi, ring, ground(_cx, _cz)+0.07, rgb)
            for (a, b) in c["bridges"]:
                hl.seg([a[0], gy(a[0], a[1])+0.3, a[1]], [b[0], gy(b[0], b[1])+0.3, b[1]], C_BRIDGE)
            for (a, b) in c["footbridges"]:
                hl.seg([a[0], gy(a[0], a[1])+0.3, a[1]], [b[0], gy(b[0], b[1])+0.3, b[1]], C_FOOTBRIDGE)
            for (a, b, ha, hb, rgb, is_ramp, hw2, thick, lay) in c["elev"]:
                hl.seg([a[0], gy(a[0], a[1])+ha+0.3, a[1]], [b[0], gy(b[0], b[1])+hb+0.3, b[1]], rgb)
                ml.seg([a[0], gy(a[0], a[1])+ha+0.3, a[1]], [b[0], gy(b[0], b[1])+hb+0.3, b[1]], rgb)
                # 实体桥面（立交立体 2026-11-25）：顶面 + 底面 + 两侧；顶面同时进 mid（远处俯瞰有层次）。
                # 下穿/地面段（两端高 ≤0.05m）不建实体，只留线，避免与地形重叠闪烁。
                if max(ha, hb) > 0.05:
                    _dx, _dz = b[0]-a[0], b[1]-a[1]
                    _ln = math.hypot(_dx, _dz)
                    if _ln >= 0.01:
                        _px, _pz = -_dz/_ln*hw2, _dx/_ln*hw2
                        _nx, _nz = -_dz/_ln, _dx/_ln
                        _yta, _ytb = gy(a[0], a[1])+ha, gy(b[0], b[1])+hb
                        _yba, _ybb = _yta-thick, _ytb-thick
                        _top = deck_top_shade(lay, (ha+hb)/2)
                        _side = [v*0.72 for v in _top]
                        hi.quad([a[0]+_px, _yta, a[1]+_pz], [b[0]+_px, _ytb, b[1]+_pz],
                                [b[0]-_px, _ytb, b[1]-_pz], [a[0]-_px, _yta, a[1]-_pz], [0, 1, 0], _top)
                        mid.quad([a[0]+_px, _yta, a[1]+_pz], [b[0]+_px, _ytb, b[1]+_pz],
                                 [b[0]-_px, _ytb, b[1]-_pz], [a[0]-_px, _yta, a[1]-_pz], [0, 1, 0], _top)
                        hi.quad([a[0]+_px, _yba, a[1]+_pz], [a[0]-_px, _yba, a[1]-_pz],
                                [b[0]-_px, _ybb, b[1]-_pz], [b[0]+_px, _ybb, b[1]+_pz], [0, -1, 0], _side)
                        hi.quad([a[0]+_px, _yta, a[1]+_pz], [a[0]+_px, _yba, a[1]+_pz],
                                [b[0]+_px, _ybb, b[1]+_pz], [b[0]+_px, _ytb, b[1]+_pz], [_nx, 0, _nz], _side)
                        hi.quad([a[0]-_px, _yba, a[1]-_pz], [a[0]-_px, _yta, a[1]-_pz],
                                [b[0]-_px, _ytb, b[1]-_pz], [b[0]-_px, _ybb, b[1]-_pz], [-_nx, 0, -_nz], _side)
            for (x, z, h, thick) in c["piers"]:
                # 实心方柱桥墩（立交立体 2026-11-25）：地面→桥面底，不顶穿桥面；过矮（<0.5m）跳过
                y0 = ground(x, z)
                y1 = y0 + h - thick
                if y1 - y0 >= 0.5:
                    _s = PIER_HALF
                    prism(hi, [[x-_s, z-_s], [x+_s, z-_s], [x+_s, z+_s], [x-_s, z+_s]],
                          y0, y1, C_BRIDGE)
            for (x, z, dh) in c["toll_booths"]:
                y0 = ground(x, z) + (dh or 0.0)
                box = [[x-1.5, z-2], [x+1.5, z-2], [x+1.5, z+2], [x-1.5, z+2]]
                prism(hi, box, y0+0.3, y0+2.8, C_TOLL)
            for ring in c["toll_plazas"]:
                hl.ring(ring, lambda x, z: gy(x, z)+0.35, C_TOLL)
            for (a, b, rgb) in c["metro_line"]:
                hl.seg([a[0], gy(a[0], a[1])+0.4, a[1]], [b[0], gy(b[0], b[1])+0.4, b[1]], rgb)
            for (a, b) in c["metro_elev"]:
                hl.seg([a[0], gy(a[0], a[1])+9.0, a[1]], [b[0], gy(b[0], b[1])+9.0, b[1]], C_ELEV)
                ml.seg([a[0], gy(a[0], a[1])+9.0, a[1]], [b[0], gy(b[0], b[1])+9.0, b[1]], C_ELEV)
            for (a, b, rgb) in c["railway"]:
                hl.seg([a[0], gy(a[0], a[1])+0.3, a[1]], [b[0], gy(b[0], b[1])+0.3, b[1]], rgb)
                ml.seg([a[0], gy(a[0], a[1])+0.3, a[1]], [b[0], gy(b[0], b[1])+0.3, b[1]], rgb)
            for (a, b) in c["natrail"]:
                hl.seg([a[0], gy(a[0], a[1])+0.35, a[1]], [b[0], gy(b[0], b[1])+0.35, b[1]], C_NATRAIL)
                ml.seg([a[0], gy(a[0], a[1])+0.35, a[1]], [b[0], gy(b[0], b[1])+0.35, b[1]], C_NATRAIL)
            for (sx, sz, is_key) in c["natrail_stations"]:
                _y0 = ground(sx, sz)
                _s = 6 if is_key else 2
                _h = 8 if is_key else 3
                box = [[sx-_s, sz-_s], [sx+_s, sz-_s], [sx+_s, sz+_s], [sx-_s, sz+_s]]
                prism(hi, box, _y0+0.35, _y0+0.35+_h, [0.50, 0.50, 0.55])
            for cp in c["compounds"]:
                pts = [lonlat_to_m(lon, lat) for lon, lat in cp["points"]]
                hl.ring(pts, lambda x, z: gy(x, z)+0.35, C_COMPOUND)
                gx, gz = lonlat_to_m(*cp["gate_estimate"])
                gy0 = ground(gx, gz)
                box = [[gx-2, gz-2], [gx+2, gz-2], [gx+2, gz+2], [gx-2, gz+2]]
                prism(hi, box, gy0+0.35, gy0+2.35, C_COMPOUND)
            for s in c["stations"]:
                y0 = ground(s["x"], s["z"])
                box = [[s["x"]-6, s["z"]-6], [s["x"]+6, s["z"]-6], [s["x"]+6, s["z"]+6], [s["x"]-6, s["z"]+6]]
                prism(hi, box, y0+0.4, y0+4.4, [0.55, 0.55, 0.60])
            for (ring, (y0, y1)) in c["station_hall"]:
                # v3.2 第 17 项：站厅（地下站厅在地面之下，几何仍进 GLB 备以后用）
                prism(hi, ring, y0, y1, [0.50, 0.50, 0.58])
            for (ring, (y0, y1)) in c["station_platform"]:
                # v3.2 第 17 项：站台（板厚 1m；地下 -12m / 高架 10.1m，绝对高）
                prism(hi, ring, y0, y1, [0.55, 0.55, 0.60])
            for e in c["entrances"]:
                y0 = ground(e["x"], e["z"])
                box = [[e["x"]-3, e["z"]-2], [e["x"]+3, e["z"]-2], [e["x"]+3, e["z"]+2], [e["x"]-3, e["z"]+2]]
                prism(hi, box, y0+0.4, y0+3.4, [0.60, 0.60, 0.65])  # v3.2: 出入口亭 3x3x2m -> 6x4x3m（推测）
            for e in c["entrances_est"]:
                # 估算口：琥珀色小亭（5x3x2.5m），与 OSM 实测口灰色亭严格区分，一眼可辨
                y0 = ground(e["x"], e["z"])
                box = [[e["x"]-2.5, e["z"]-1.5], [e["x"]+2.5, e["z"]-1.5], [e["x"]+2.5, e["z"]+1.5], [e["x"]-2.5, e["z"]+1.5]]
                prism(hi, box, y0+0.4, y0+2.9, [0.85, 0.60, 0.15])
            # 2026-11-27 D3：地标 8x8x14m 标记方块已删。B 路报的星光里 198m 塔、星河 41.2m 楼
            # 经 GLB 三角形核实都在（塔顶 196.2m、楼顶 46.4m，顶面面积与足迹分毫不差）；
            # B 的“缺失”是顶点口径问题（strict contains 漏掉了落在足迹边界上的棱柱角点）。
            # 25 处地标都有真实体（楼/园区/水面/路桥），标记方块是诊断占位物，留着会歪曲白模，故删；
            # 地标点仍在 c["landmarks"] 与 chunks/index.json 里计数，app 侧运行时标记不受影响。
            for (x, z, h) in c["lamps"]:
                _y0 = ground(x, z)
                hl.seg([x, _y0+0.3, z], [x, _y0+h+0.3, z], C_LAMP)
            for (x, z, h, yb) in c["lamps_bridge"]:
                # v3.2 第 18 项：桥杆灯（灯杆底座在桥面高 yb 绝对高，不再加 ground）
                hl.seg([x, yb + 0.3, z], [x, yb + h + 0.3, z], C_LAMP)
            for (x, z, yb) in c["lamps_tunnel"]:
                # v3.2 第 18 项：隧道顶灯（地下，地面上不可见；1m 短竖线标记进 GLB 备以后用）
                hl.seg([x, yb, z], [x, yb + 1.0, z], C_LAMP)
            # ---- 2026-11-27 D3：高架护栏 / BRT 站台 / 园路 / 公园小品 / 亭子 / 天桥楼梯 ----
            for ((x1, z1, h1), (x2, z2, h2)) in c["guardrails"]:
                # 护栏：桥面两侧 3D 线，y = 地面 + deck_h + 1.1m；匝道口已在数据里断开
                hl.seg([x1, gy(x1, z1)+h1+1.1, z1], [x2, gy(x2, z2)+h2+1.1, z2], C_RAIL)
            for (x, z, dh, hd) in c["brt_platforms"]:
                # BRT 站台：24x3m 板（0.3m 厚）+ 4 柱雨棚（+3.0m）+ 两侧栏杆线（示意尺寸）
                _y0 = ground(x, z) + dh
                _ux, _uz = math.cos(math.radians(hd)), math.sin(math.radians(hd))
                _vx, _vz = -_uz, _ux
                _corn = [[x+_ux*12*_a+_vx*1.5*_b, z+_uz*12*_a+_vz*1.5*_b]
                         for _a, _b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
                prism(hi, _corn, _y0, _y0+0.3, [0.70, 0.70, 0.72])
                prism(hi, _corn, _y0+3.0, _y0+3.2, [0.60, 0.60, 0.65])
                for _s in (-1, 1):
                    for _t in (-1, 1):
                        _px = x+_ux*11*_t+_vx*1.2*_s; _pz = z+_uz*11*_t+_vz*1.2*_s
                        prism(hi, [[_px-0.15, _pz-0.15], [_px+0.15, _pz-0.15],
                                  [_px+0.15, _pz+0.15], [_px-0.15, _pz+0.15]],
                              _y0+0.3, _y0+3.0, [0.55, 0.55, 0.60])
                for _s in (-1, 1):
                    _ax, _az = x-_ux*12+_vx*1.5*_s, z-_uz*12+_vz*1.5*_s
                    _bx, _bz = x+_ux*12+_vx*1.5*_s, z+_uz*12+_vz*1.5*_s
                    hl.seg([_ax, _y0+1.2, _az], [_bx, _y0+1.2, _bz], C_RAIL)
            for (a, b, hw2, rgb) in c["park_paths"]:
                # 园路：1.5m 半宽窄带（地面+0.05m，与 road_ribbons 同画法）
                _dx, _dz = b[0]-a[0], b[1]-a[1]
                _ln = math.hypot(_dx, _dz) or 1.0
                _px, _pz = -_dz/_ln*hw2, _dx/_ln*hw2
                _ya, _yb = gy(a[0], a[1])+0.05, gy(b[0], b[1])+0.05
                hi.quad([a[0]+_px, _ya, a[1]+_pz], [b[0]+_px, _yb, b[1]+_pz],
                        [b[0]-_px, _yb, b[1]-_pz], [a[0]-_px, _ya, a[1]-_pz], [0, 1, 0], rgb)
            for (x, z, kind) in c["park_amenities"]:
                # 公园小品（示意尺寸）：厕所 3x2x2.5m，kiosk 2.5x2x2.5m
                _y0 = ground(x, z)
                if kind == "toilet":
                    _box = [[x-1.5, z-1], [x+1.5, z-1], [x+1.5, z+1], [x-1.5, z+1]]
                    prism(hi, _box, _y0+0.05, _y0+2.55, [0.65, 0.68, 0.72])
                else:
                    _box = [[x-1.25, z-1], [x+1.25, z-1], [x+1.25, z+1], [x-1.25, z+1]]
                    prism(hi, _box, _y0+0.05, _y0+2.55, [0.75, 0.70, 0.60])
            for (ring, kind) in c["park_pavilions"]:
                # 亭子（示意）：环顶板（2.4–2.7m）+ 沿环每 ~5m 一根 0.3m 柱；无环的节点亭已按 4x4m 默认环入块
                _ring = clean_ring(ring)
                if len(_ring) < 3:
                    continue
                _cx = sum(p[0] for p in _ring)/len(_ring); _cz = sum(p[1] for p in _ring)/len(_ring)
                _y0 = ground(_cx, _cz)
                prism(hi, _ring, _y0+2.4, _y0+2.7, [0.72, 0.68, 0.60])
                _acc = 0.0
                for i in range(len(_ring)):
                    _a, _b = _ring[i], _ring[(i+1) % len(_ring)]
                    _acc += math.hypot(_b[0]-_a[0], _b[1]-_a[1])
                    if _acc >= 5.0 or i == 0:
                        _acc = 0.0
                        _px, _pz = _a
                        prism(hi, [[_px-0.15, _pz-0.15], [_px+0.15, _pz-0.15],
                                  [_px+0.15, _pz+0.15], [_px-0.15, _pz+0.15]],
                              _y0, _y0+2.4, [0.60, 0.58, 0.52])
            for (x, z, kind, src) in c["park_leisure"]:
                # 健身/游乐（示意尺寸）：fitness 一组 2.5x1.5x1.2m 器材簇；playground 4x3m 垫 + 两根 2.2m 高小架柱
                _y0 = ground(x, z)
                if kind == "fitness_station":
                    _box = [[x-1.25, z-0.75], [x+1.25, z-0.75], [x+1.25, z+0.75], [x-1.25, z+0.75]]
                    prism(hi, _box, _y0+0.05, _y0+1.25, [0.55, 0.62, 0.70])
                else:
                    _box = [[x-2, z-1.5], [x+2, z-1.5], [x+2, z+1.5], [x-2, z+1.5]]
                    prism(hi, _box, _y0+0.05, _y0+0.35, [0.80, 0.70, 0.55])
                    for _px in (x-1.5, x+1.5):
                        prism(hi, [[_px-0.15, z-1.5], [_px+0.15, z-1.5],
                                  [_px+0.15, z-1.2], [_px-0.15, z-1.2]],
                              _y0+0.35, _y0+2.2, [0.60, 0.58, 0.52])
            for _it in c["plaza_circles"]:
                # 星泽广场三圆（hi+mid 两档都进；三角/线段按重心已分桶）
                if _it[0] == "tri":
                    _, _a, _b, _cc, _n, _rgb = _it
                    hi.tri(_a, _b, _cc, _n, _rgb)
                    mid.tri(_a, _b, _cc, _n, _rgb)
                else:
                    _, _a, _b, _rgb = _it
                    hl.seg(_a, _b, _rgb)
                    ml.seg(_a, _b, _rgb)
            for (x, z, dh, hd, run, w) in c["foot_stairs"]:
                # 天桥楼梯/坡道（示意尺寸：run = deck×1.8，台阶高 0.17m）：自桥端向外下坡的斜面
                _y0 = ground(x, z)
                _ux, _uz = math.cos(math.radians(hd)), math.sin(math.radians(hd))
                _vx, _vz = -_uz, _ux
                _tx, _tz = x+_ux*run, z+_uz*run
                _hw2 = w/2.0
                hi.quad([x+_vx*_hw2, _y0+dh, z+_vz*_hw2], [_tx+_vx*_hw2, _y0, _tz+_vz*_hw2],
                        [_tx-_vx*_hw2, _y0, _tz-_vz*_hw2], [x-_vx*_hw2, _y0+dh, z-_vz*_hw2],
                        [0, 1, 0], C_FOOTBRIDGE)
            for (x, z, h, w, rgb) in c["trees"]:
                _y0 = ground(x, z)
                hi.quad([x-w/2, _y0+0.3, z], [x+w/2, _y0+0.3, z], [x+w/2, _y0+h, z], [x-w/2, _y0+h, z], [0, 0, 1], rgb)
                hi.quad([x, _y0+0.3, z-w/2], [x, _y0+0.3, z+w/2], [x, _y0+h, z+w/2], [x, _y0+h, z-w/2], [1, 0, 0], rgb)
            for (x, z, h, tx, tz) in c["vpiers"]:
                _y0 = ground(x, z)
                _px, _pz = -tz*4.0, tx*4.0
                hl.seg([x+_px, _y0+0.3, z+_pz], [x, _y0+h+0.3, z], C_BRIDGE)
                hl.seg([x-_px, _y0+0.3, z-_pz], [x, _y0+h+0.3, z], C_BRIDGE)
            for (a, b) in c["special_lines"]:
                hl.seg(a, b, C_SPECIAL)
            for (ring, y0, y1, rgb) in c["special_tris"]:
                prism(hi, ring, y0, y1, rgb)
            for (x, z) in c["mt_pois"]:
                _y0 = ground(x, z)
                box = [[x-2, z-2], [x+2, z-2], [x+2, z+2], [x-2, z+2]]
                prism(hi, box, _y0+0.3, _y0+3.3, [0.70, 0.60, 0.40])
            sha_hi, size_hi = write_glb2(hi_path, hi, hl) if (hi.tris() or hl.count()) else (None, 0)
            sha_mid, size_mid = write_glb2(mid_path, mid, ml) if (mid.tris() or ml.count()) else (None, 0)
            if size_hi == 0 and os.path.exists(hi_path):
                os.remove(hi_path)
            if size_mid == 0 and os.path.exists(mid_path):
                os.remove(mid_path)
            conf = {"high": 0, "medium": 0, "low": 0}
            for b in c["b"]:
                conf[b.get("height_confidence", "low")] = conf.get(b.get("height_confidence", "low"), 0)+1
            rec = {"cx": k[0], "cz": k[1], "format_version": FORMAT_VERSION,
                   "x0": OX+k[0]*CHUNK, "z0": OZ+k[1]*CHUNK,
                   "buildings": len(c["b"]), "road_segs": len(c["roads"]),
                   "bridge_segs": len(c["bridges"])+len(c["footbridges"]),
                   "railway_segs": len(c["railway"]),
                   "compounds": len(c["compounds"]),
                   "compound_osm_ids": [cp["osm_id"] for cp in c["compounds"]],
                   "stations": len(c["stations"]), "entrances": len(c["entrances"]), "entrances_est": len(c["entrances_est"]),
                   "station_hall": len(c["station_hall"]),
                   "station_platform": len(c["station_platform"]),
                   "water_islands": len(c["water_islands"]),
                   "rivers": len(c["rivers"]),
                   "water": len(c["water"]),
                   "tunnels": len(c["tunnels"]),
                   "tunnel_portals": len(c["tunnel_portals"]),
                   "river_rails": len(c["river_rails"]),
                   "flowers": len(c["flowers"]),
                   "landmarks": len(c["landmarks"]),
                   "elevated_segs": len(c["elev"]),
                   "ramp_segs": sum(1 for e in c["elev"] if e[5]),
                   "deck_segs": len(c["elev"]),
                   "piers": len(c["piers"]),
                   "toll_booths": len(c["toll_booths"]),
                   "toll_plazas": len(c["toll_plazas"]),
                   "landuse_polys": len(c["landuse"]),
                   "natrail_segs": len(c["natrail"]),
                   "natrail_stations": len(c["natrail_stations"]),
                   "lamps": len(c["lamps"]),
                   "lamps_bridge": len(c["lamps_bridge"]),
                   "lamps_tunnel": len(c["lamps_tunnel"]),
                   "trees": len(c["trees"]),
                   "greenway_segs": len(c["greenway"]),
                   "road_ribbons": len(c["road_ribbons"]),
                   "guardrails": len(c["guardrails"]),
                   "brt_platforms": len(c["brt_platforms"]),
                   "park_paths": len(c["park_paths"]),
                   "park_amenities": len(c["park_amenities"]),
                   "park_pavilions": len(c["park_pavilions"]),
                   "park_leisure": len(c["park_leisure"]),
                   "plaza_circles": len(c["plaza_circles"]),
                   "foot_stairs": len(c["foot_stairs"]),
                   "runway_segs": len(c["runway"]),
                   "aprons": len(c["aprons"]),
                   "special_lines": len(c["special_lines"]),
                   "special_tris": len(c["special_tris"]),
                   "vpiers": len(c["vpiers"]),
                   "mt_pois": len(c["mt_pois"]),
                   "tris_high": hi.tris(), "tris_mid": mid.tris(),
                   "lines_high": hl.count(), "lines_mid": ml.count(),
                   "bytes_high": size_hi, "bytes_mid": size_mid,
                   "sha256_high": sha_hi, "sha256_mid": sha_mid,
                   "height_confidence": conf}
            index[tag] = rec; log["done"][tag] = rec; done_n += 1
        except Exception as ex:
            log["errors"].append({"chunk": tag, "error": repr(ex)})
            print(f"ERR {tag}: {ex!r}")
        if ki % 200 == 0:
            json.dump(log, open(log_path, "w"))
            print(f"  {ki}/{len(keys)} chunks, done {done_n}")
    json.dump(log, open(log_path, "w"))

    # ---- 地形分块（2000m，90m 采样；已建的不重建） ----
    if args.only in ("terrain", "all"):
        T = 2000.0
        tx0, tx1 = int(OX//T), int(38000//T)
        tz0, tz1 = int(OZ//T), int(39000//T)
        terr_index = {}
        import numpy as _np
        for tx in range(tx0, tx1+1):
            for tz in range(tz0, tz1+1):
                tag = f"t_{tx}_{tz}"
                path = os.path.join(OUT, "terrain", f"{tag}.glb")
                if not (_tile_hits_6(tx, tz) or _tile_hits_ring(tx, tz)):
                    continue
                if os.path.exists(path) and log["done"].get(tag):
                    terr_index[tag] = log["done"][tag]; continue
                x0, z0 = tx*T, tz*T
                nx = int(T/90)+1
                acc = Acc()
                grid = [[ground(x0+i*90, z0+j*90) for i in range(nx)] for j in range(nx)]
                # 2026-11-27 D3 广场圆环 ground_cut：站环碗（中心 -114.9,-565.3，R27.3）内地形采样点压到碗底以下（-8.5；碗底 ground-6.0 ≈ -8.04，2026-11-27 加深 4.0->6.0m）
                if (tx, tz) == (-1, -1):
                    for _jj in range(nx):
                        for _ii in range(nx):
                            if (x0+_ii*90+114.9)**2 + (z0+_jj*90+565.3)**2 < 27.3**2:
                                grid[_jj][_ii] = -8.5
                rgb = [0.85, 0.85, 0.85]
                for j in range(nx-1):
                    for i in range(nx-1):
                        a = [x0+i*90, grid[j][i], z0+j*90]
                        b = [x0+(i+1)*90, grid[j][i+1], z0+j*90]
                        c2 = [x0+(i+1)*90, grid[j+1][i+1], z0+(j+1)*90]
                        d = [x0+i*90, grid[j+1][i], z0+(j+1)*90]
                        # 绕向：法线须朝上（旧绕向朝下，地形从上看被剔除、不可见——v2 遗留 bug）
                        n1 = _np.cross(_np.array(d)-_np.array(a), _np.array(b)-_np.array(a))
                        n1 = n1/(_np.linalg.norm(n1) or 1)
                        acc.tri(a, d, b, n1.tolist(), rgb)
                        n2 = _np.cross(_np.array(d)-_np.array(b), _np.array(c2)-_np.array(b))
                        n2 = n2/(_np.linalg.norm(n2) or 1)
                        acc.tri(b, d, c2, n2.tolist(), rgb)
                sha, size = write_glb(path, acc)
                rec = {"tx": tx, "tz": tz, "tris": acc.tris(), "bytes": size, "sha256": sha}
                terr_index[tag] = rec; log["done"][tag] = rec
        json.dump({"terrain": terr_index}, open(os.path.join(OUT, "terrain", "index.json"), "w"))
        json.dump(log, open(log_path, "w"))
        print(f"terrain tiles: {len(terr_index)}")

    # ---- 远景 fabric（已建的不重建） ----
    if args.only in ("fabric", "all"):
        fpath = os.path.join(OUT, "fabric.glb")
        if not (os.path.exists(fpath) and log["done"].get("fabric")):
            acc = Acc()
            _fab_n = 0
            for cell in fabric:
                x, z, h = float(cell["x"]), float(cell["z"]), float(cell["h"])
                if not _in6(x, z):
                    continue
                _fab_n += 1
                box = [[x-100, z-100], [x+100, z-100], [x+100, z+100], [x-100, z+100]]
                prism(acc, box, ground(x, z), ground(x, z)+h, shade_by_height(h))
            sha, size = write_glb(fpath, acc)
            log["done"]["fabric"] = {"cells": _fab_n, "tris": acc.tris(), "bytes": size, "sha256": sha}
            print(f"fabric (six districts): {_fab_n} cells kept of {len(fabric)}", flush=True)
            json.dump(log, open(log_path, "w"))
            print(f"fabric: {len(fabric)} cells, {acc.tris()} tris, {size} bytes")

    idx_path = os.path.join(OUT, "chunks", "index.json")
    merged = {}
    if os.path.exists(idx_path):
        try: merged = json.load(open(idx_path)).get("chunks", {})
        except Exception: merged = {}
    merged.update(index)
    _hh = hashlib.md5()
    with open(os.path.join(DATA, args.heights), "rb") as _f:
        for _chunk in iter(lambda: _f.read(1 << 20), b""):
            _hh.update(_chunk)
    heights_md5 = _hh.hexdigest()
    json.dump({"chunks": merged, "format_version": FORMAT_VERSION, "generated": "2026-11-27",
               "heights": args.heights, "heights_md5": heights_md5,
               "source": f"{args.heights} (md5 {heights_md5}) + city-wide.json + roads-all-levels-v1.json + bridges-v1.json + metro.json (369 stations / 820 entrances, 2026-11-27 D3 补升仙湖站 + D口） + compound-names.json + railway-v1.json (PBF实抽) + toll-booths-v1.json (PBF实抽) + chengdu-dem-90m-full-latlon.npy 6-tile Copernicus (read-only; 兴隆湖湖面压到 464m) + water-v1.json (2026-11-27 河/水更新：+8 water=river 多边形，md5 a54fc4b3…) + lakes-assembled-v1.json (2026-11-27：青龙湖 1 外环+2 岛洞，md5 9dd3ffd8…) + landuse-v1.json + road-widths-v1.json + national-rail-v1.json + lamps-city + worldcover-bone-bbox-10m.npz + street-trees-v1.json + aeroway-v1.json + mountain-pois-v1.json + bridge-shapes.json + lake-islands-v1.json (2026-11-27：139 岛，+4 锦江河岛塞，md5 6c06457d…) + metro-stations-geometry-v1.json (v3.2 站厅/站台) + bridge-tunnel-lamps tiles (v3.2 桥隧灯) + flowers-geometry-v1.json (v3.2 花坛，PBF实抽) + tunnels-v1.json (2026-11-26: tunnel=yes 排除地面画法；主干车行隧道洞口为示意尺寸洞门框） + river_rails (2026-11-26: water=river 边界 + 湖外环，示意 1.1m 高/10m 间距；2026-11-27 D3：桥处抠洞） + building-corrections-v1.json (2026-11-26: 建筑足迹修正层 134 条 clip/delete/add，见 virtual-city/data/building-corrections-v1.json) + bridge-elev-overrides-v1.json + bridge-fb-decks-v1.json + bridge-piers-v1.json + bridge-guardrails-v1.json + bridge-footbridge-stairs-v1.json + tunnel-portals-nonvehicle-v1.json (2026-11-27 桥路 7 文件） + brt-stations-v1.json + six-parks-v1.json + park-amenities-v1.json + six-park-leisure.json (2026-11-27 公园 Parks2 收尾：厕所 119 独立/kiosk 9/亭子代用 40 含真 gazebo 3 座全在北湖/园路 3,310/园内水 134/健身游乐 48=OSM 31+种子 17，G04 2 项无面跳过；桂溪 100.7ha） + water-crossing-verdicts-2026-11-27.json (2026-11-27 河/水：B=23 真缺桥补建） + plaza-circles-v2.json (2026-11-27 广场三圆：圆盘 R75 + 太阳神鸟/花盘/站环剧场；landuse 减 R75 圆盘；地形 t_-1_-1 碗内压到 -8.5；烘焙排除 3 栋冲突楼；2026-11-27 加深 v2.1-deep：圆盘竖沿 +0.30、花瓣 0.6m、剧场 8x0.75m 深 6.0m）",
               "elevated_note": "metro elevated deck 9.0m pending-verification",
               "interchange_note": "elevated ways (§7.14): own_deck>0 roads drawn at interpolated deck heights (standard stacking rule L*6.9m: clearance 5.0m CJJ37-2012 + structure 1.9m, inferred; measured overrides: chengwen top 32m, fuqing crest 15m, second-ring range midpoint 12.0m ESTIMATE not measured; zero-flat 2026-11-25: all 9,399 bridges have numeric deck heights (river base 3.0m, rail viaduct base 7.5m, metro viaduct base 9.0m, footbridge river base 2.0m; methods+errors in bridges-v1.json); solid decks since 2026-11-25 (deck slabs: top+bottom+sides, 1.9m thick vehicle / 0.8m footbridge, width from road-widths-v1 or grade-tier median fallback, top face shaded by OSM layer L1 dark to L5 light, top face also in mid LOD; piers as solid 1.6m square columns every ~30m where deck>2m, ground to deck underside, pier positions schematic not surveyed; V-piers of curved special bridges stay as paired lines; 66.16m pier gap kept at Hongpailou paifang); toll booths as 3x4m marker boxes, plaza outlines as ground rings; 2026-11-27 D3: elev heights single source of truth = bridge-elev-overrides-v1.json (restores 1,486 + pins 3 + cascade 57, vertex heights baked incl approach ramps); piers from bridge-piers-v1.json (27,500, classified beside-road/open/water/median/sidewalk-shifted/span-dropped); guardrails from bridge-guardrails-v1.json (>2m only, broken at ramp mouths); BRT platforms follow segment deck height",
               "bridge_note": "non-elevated bridges (rail viaducts not in roads file) follow road level (flat lines); all deck_height_m numeric since 2026-11-25 zero-flat, estimates labelled with method+error in bridges-v1.json; 2026-11-27 D3: FB flat bridges now solid decks (bridge-fb-decks-v1.json, 377 ways / 2,508 segs in six districts, 1.9m veh / 0.8m foot), only 8 layer=0 at-grade ways stay flat lines; 23 true-missing water-crossing bridges built (water-crossing-verdicts B=23: veh deck 3.0m / foot 2.0m, one end segment as approach ramp); 4 suspension ramps on hold (no towers/cables, tags suspect, await street view)",
               "width_note": "carriageways drawn as ribbons from road-widths-v1.json (real-osm 150 + lanes-calc 6205 + grade-tier 52108 推算；footways stay lines); runway widths from OSM tags (45/60m), taxiway default 15m 推算",
               "dem_note": "DEM = 6-tile Copernicus GLO-30 (lon 102.8-105.0, lat 30.0-31.6), datum 506; old 4-tile chengdu-dem-90m.npy verified wrong and retired; core plain 478-568m mean 507.6 (flat, NOT a basin); Xinglong Lake cells flattened to 464m",
               "vegetation_note": "trees: WorldCover 10m tree mask sampled at 60m stride, hash-capped 200k, height 4-8m by hash (sampled/估算); OSM natural=tree 1207 at real positions (height by hash, 估算); flowerbeds v3.2: 26 OSM flowerbeds in bbox (25 ways + 1 node, PBF实抽几何；9 in 14km circle) drawn pink as flowers; gardens: 291 leisure=garden faces already in landuse as park (v3.1), not double-drawn",
               "lakes_note": "11 lake entries (9 distinct names) assembled from OSM multipolygon relations by osmium export (real geometry); 5 entries inside six districts (北湖/锦城湖/白鹭湾x2/升仙湖), 6 outside by crop (龙泉湖/兴隆湖/麓湖/东安湖/青龙湖x2); 青龙湖 rel 10660802 is a reservoir 128.6km east of six districts, NOT the real 成华青龙湖 (rel 12264762, never broken); inner rings are island holes, skipped when matching lake-islands-v1.json (97 of 98 matched); lake islands since v3.2: 139 islands listed (2026-11-27 river update: +4 锦江河 plugs; drawn count in generation log; 1 degenerate 6m2 hole skipped, not silently dropped; 2 small plugs err -9.5%/-6.1%; without scipy 38 plugs err >6%)",
               "greenway_note": "greenways = roads whose name contains 绿道 (155 ways: 绕城绿道 84, 龙泉山森林绿道 33, 锦江绿道 16, 毗河绿道 11, others 11), drawn as 4m green ribbons"},
              open(idx_path, "w"))
    print(f"DONE chunks built this run: {done_n}/{len(keys)}")
    print(f"errors: {len(log['errors'])}")

if __name__ == "__main__":
    main()
