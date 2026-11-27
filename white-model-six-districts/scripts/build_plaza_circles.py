#!/usr/bin/env python3
"""星泽广场三圆 — 独立构建脚本 (plaza-step1 v2, 2026-11-27)。

读数据层 data/plaza-circles-v2.json, 生成白模六区包外的叠加 GLB
white-model-six-districts/plaza-circles.glb, 供验收截图与 D 路对照。

v2 取代 v1 (1->2 作废): 参考站广场圆盘上有 3 个圆形结构 (左/中/右),
圆盘本身也是一个大圆 (Ø150m)。本层全部按白膜做: 白/浅灰几何,
不贴纹理、不上色 (参考站默认视图的深灰/金/金绿/金粉, 白膜下都变白/浅灰)。

- 圆盘: R75 平圆盘, 中心 (-161.5,-567.0) (广场中心, 非太阳神鸟)。
- 左 (西): 太阳神鸟 — 深色圆盘 R18.5 (OSM Ø37m 平台) + 金绿分层雕塑质量体
  (柱 + 2 层圆盘 + 3 段螺旋弧; 精修鸟形属 step-2, 本层不做)。
- 中: 花盘 — OSM 实测圆形平台 R7.3 (0.3-0.8m) + 8 瓣花形浮雕。
- 右 (东): 站环圆形剧场 — OSM 圆形站环 R27.3, 8 级台阶下沉 4m + 中央分层构筑。

- 不改任何块 GLB, 不跑 build_six.py 全量, 不碰 build_six.py 本身。
- 几何/GLB 工具直接 import build_six (与 D 路烘焙同一套口径)。
- 用法: python3 white-model-six-districts/scripts/build_plaza_circles.py
  输出: ../plaza-circles.glb + ../plaza-circles-summary.json。
- 接进游戏 (D 路, 待老大排): 见数据文件 ground_cut/conflicts——
  build_six.py 里加 "plaza_circles" 块键, 用本脚本同款函数把本数据文件
  的圆盘与三结构按块分桶, hi+mid 两档都进, 只重跑 [119,100]、[119,101] 两块。
  本 GLB 只是验收叠加层, 不进游戏包。
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, "/home/hatch/.local/lib/python3.12/site-packages")
import build_six as bs  # noqa: E402  (只 import 工具; main() 有 __main__ 守卫, 不会跑)

VC = "/home/hatch/workspace/virtual-city"
DATA = os.path.join(VC, "data", "plaza-circles-v2.json")
OUT_GLB = os.path.join(VC, "white-model-six-districts", "plaza-circles.glb")
OUT_SUMMARY = os.path.join(VC, "white-model-six-districts",
                           "plaza-circles-summary.json")

SEG = 64  # 大圆分段数


def circle_pts(cx, cz, r, n=SEG):
    pts = []
    for i in range(n):
        a = 2.0 * math.pi * i / n
        pts.append([cx + r * math.cos(a), cz + r * math.sin(a)])
    return pts


def annulus_top(acc, cx, cz, r_out, r_in, y, rgb, n=SEG):
    """平环顶面 (r_in..r_out), 法线向上。"""
    up = [0, 1, 0]
    for i in range(n):
        a0 = 2.0 * math.pi * i / n
        a1 = 2.0 * math.pi * (i + 1) / n
        o0 = [cx + r_out * math.cos(a0), y, cz + r_out * math.sin(a0)]
        o1 = [cx + r_out * math.cos(a1), y, cz + r_out * math.sin(a1)]
        i0 = [cx + r_in * math.cos(a0), y, cz + r_in * math.sin(a0)]
        i1 = [cx + r_in * math.cos(a1), y, cz + r_in * math.sin(a1)]
        acc.quad(o0, o1, i1, i0, up, rgb)


def disc_top(acc, cx, cz, r, y, rgb, n=SEG):
    """实心圆盘顶面, 法线向上。"""
    up = [0, 1, 0]
    c = [cx, y, cz]
    ring = circle_pts(cx, cz, r, n)
    for i in range(n):
        p0 = [ring[i][0], y, ring[i][1]]
        p1 = [ring[(i + 1) % n][0], y, ring[(i + 1) % n][1]]
        acc.tri(c, p0, p1, up, rgb)


def wall_band(acc, cx, cz, r, y_top, y_bot, rgb, n=SEG, inward=True):
    """半径 r 处的竖直圆柱面 (y_bot..y_top)。
    inward=True: 法线指圆心 (碗内台阶立面); False: 法线向外 (岛/柱侧壁)。"""
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
    """扇形环顶面 (角度 a0..a1 度), 法线向上。"""
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
    """扇形竖直圆柱面 (角度 a0..a1 度)。"""
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


def cylinder(acc, cx, cz, r, y0, y1, rgb, n=SEG):
    """实心圆柱 (顶面 + 侧壁, 法线向外)。"""
    disc_top(acc, cx, cz, r, y1, rgb, n)
    wall_band(acc, cx, cz, r, y1, y0, rgb, n, inward=False)


def thick_disc(acc, cx, cz, r, y0, y1, rgb, n=SEG):
    """薄圆盘 (顶面 + 侧壁), 与 cylinder 同构, 语义上是层板。"""
    cylinder(acc, cx, cz, r, y0, y1, rgb, n)


def disc_with_hole(acc, cx, cz, r, y, rgb, hole_cx, hole_cz, hole_r,
                   n_rings=12, n_sectors=48, buf=2.0):
    """带偏心圆洞的圆盘顶面 (极坐标网格: 环 x 扇区)。
    只保留中心在盘内 (r<=R) 且在洞外 (距洞心 >= hole_r+buf) 的格子;
    洞边呈网格锯齿 (约 3m), 由剧场 rim 环 (R24-27.3, 高出圆盘 0.04)
    盖住, 残留缝隙下是 landuse 铺装 (同色系), 不可见。
    外缘跟圆 (无锯齿), 中心为扇形。"""
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
                # 中心扇形: 1 个三角
                acc.tri([cx, y, cz], pt(r1, a0), pt(r1, a1), up, rgb)
            else:
                acc.quad(pt(r0, a0), pt(r0, a1), pt(r1, a1), pt(r1, a0),
                         up, rgb)
            kept += 1
    return kept


def main():
    spec = json.load(open(DATA))
    hi = bs.Acc()
    hl = bs.LineAcc()

    # ---- 圆盘: Ø150m 平圆盘 (广场地面), 东侧站环处留洞 ----
    disc = spec["disc"]
    dcx, dcz = float(disc["center"]["x"]), float(disc["center"]["z"])
    g_disc = bs.ground(dcx, dcz)
    right0 = {s["id"]: s for s in spec["structures"]}["right_amphitheatre"]
    rx0 = float(right0["center"]["x"])
    rz0 = float(right0["center"]["z"])
    kept = disc_with_hole(hi, dcx, dcz, float(disc["radius_m"]),
                          g_disc + float(disc["y_rel_ground"]),
                          disc["color"], rx0, rz0,
                          float(right0["ring"]["radius_m"]))
    print(f"disc: R={disc['radius_m']} centre ({dcx},{dcz}) ground={g_disc:.2f} "
          f"grid cells kept={kept}/576 (hole for amphitheatre)")
    # 圆盘竖沿 (2026-11-27 加深): 外圈 3m 宽环顶 +0.30, 外壁 + 内壁竖直
    if disc.get("rim"):
        rim = disc["rim"]
        annulus_top(hi, dcx, dcz, float(rim["r_out"]), float(rim["r_in"]),
                    g_disc + float(rim["y_rel_ground"]), rim["color"])
        wall_band(hi, dcx, dcz, float(rim["r_out"]),
                  g_disc + float(rim["y_rel_ground"]),
                  g_disc + float(disc["y_rel_ground"]), rim["color"],
                  inward=False)
        wall_band(hi, dcx, dcz, float(rim["r_in"]),
                  g_disc + float(rim["y_rel_ground"]),
                  g_disc + float(disc["y_rel_ground"]), rim["color"],
                  inward=True)

    structs = {s["id"]: s for s in spec["structures"]}

    # ---- 左: 太阳神鸟 (深色圆盘 + 分层雕塑) ----
    left = structs["left_sunbird"]
    lx, lz = float(left["center"]["x"]), float(left["center"]["z"])
    g_left = bs.ground(lx, lz)
    dd = left["dark_disc"]
    # 2026-11-27 加深: 深盘改厚盘 (盘面 +0.06 起, 顶 +0.30), 带竖直侧壁
    thick_disc(hi, lx, lz, float(dd["radius_m"]),
               g_left + float(disc["y_rel_ground"]),
               g_left + float(dd["y_rel_ground"]), dd["color"])
    # 基座: OSM 实测 20 边形 (v1 小圆原样)
    small = left["plinth"]
    for key in ("outer", "inner"):
        part = small[key]
        ring = [list(bs.lonlat_to_m(lon, lat)) for lon, lat in part["points_lonlat"]]
        if ring[0] == ring[-1]:
            ring = ring[:-1]
        y0 = g_left + float(part["y0_rel_ground"])
        y1 = g_left + float(part["y1_rel_ground"])
        rgb = bs.shade_by_height(float(part["y1_rel_ground"]))
        bs.prism(hi, ring, y0, y1, rgb)
    # 雕塑: 柱 + 2 层圆盘 + 3 段螺旋弧 (质量体, 推算)
    sc = left["sculpture"]
    scol = sc["color"]
    for part in sc["parts"]:
        if part["shape"] == "cylinder":
            cylinder(hi, lx, lz, float(part["radius_m"]),
                     g_left + float(part["y0_rel_ground"]),
                     g_left + float(part["y1_rel_ground"]), scol)
        elif part["shape"] == "disc":
            y1 = g_left + float(part["y_rel_ground"])
            thick_disc(hi, lx, lz, float(part["radius_m"]),
                       y1 - float(part["thickness_m"]), y1, scol)
        elif part["shape"].startswith("3 arc"):
            ys = part["y_rel_ground"]
            span = float(part["span_deg"])
            step = float(part["rotation_step_deg"])
            th = float(part["thickness_m"])
            r_out = float(part.get("r_out_m", 5.5))
            r_in = float(part.get("r_in_m", 4.0))
            for j, y in enumerate(ys):
                a0 = j * step
                a1 = a0 + span
                y1 = g_left + float(y)
                arc_annulus_top(hi, lx, lz, r_out, r_in, y1, scol, a0, a1)
                arc_wall_band(hi, lx, lz, r_out, y1, y1 - th, scol, a0, a1,
                              inward=False)
                arc_wall_band(hi, lx, lz, r_in, y1, y1 - th, scol, a0, a1,
                              inward=True)
    print(f"left sunbird: dark disc R{dd['radius_m']} + sculpture "
          f"column to +11m, discs R6.5/R8.5, spiral to +14m")

    # ---- 中: 花盘 (OSM 实测圆台 + 8 瓣花形浮雕) ----
    mid = structs["mid_flower"]
    mx, mz = float(mid["center"]["x"]), float(mid["center"]["z"])
    g_mid = bs.ground(mx, mz)
    d = mid["disc"]
    ring = [list(bs.lonlat_to_m(lon, lat)) for lon, lat in d["points_lonlat"]]
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    bs.prism(hi, ring, g_mid + float(d["y0_rel_ground"]),
             g_mid + float(d["y1_rel_ground"]), d["color"])
    fl = mid["flower"]
    fcol = fl["color"]
    # 花心圆盘
    cd = fl["centre_disc"]
    cylinder(hi, mx, mz, float(cd["radius_m"]),
             g_mid + float(cd["y0_rel_ground"]),
             g_mid + float(cd["y1_rel_ground"]), fcol)
    # 8 瓣花瓣
    pt = fl["petals"]
    for k in range(int(pt["count"])):
        a = 2.0 * math.pi * k / int(pt["count"])
        px = mx + float(pt["ring_radius_m"]) * math.cos(a)
        pz = mz + float(pt["ring_radius_m"]) * math.sin(a)
        cylinder(hi, px, pz, float(pt["radius_m"]),
                 g_mid + float(pt["y0_rel_ground"]),
                 g_mid + float(pt["y1_rel_ground"]), fcol)
    print(f"mid flower: platform R{d['radius_m']} 0.3-0.8m + "
          f"{pt['count']} petals R{pt['radius_m']} at R{pt['ring_radius_m']}")

    # ---- 右: 站环圆形剧场 (8 级台阶下沉 + 中央分层构筑) ----
    right = structs["right_amphitheatre"]
    rx, rz = float(right["center"]["x"]), float(right["center"]["z"])
    g_right = bs.ground(rx, rz)
    rim = right["rim"]
    annulus_top(hi, rx, rz, float(rim["r_out"]), float(rim["r_in"]),
                g_right + float(rim["y_rel_ground"]), rim["color"])
    for t in right["steps"]["treads"]:
        y = g_right + float(t["y_rel_ground"])
        annulus_top(hi, rx, rz, float(t["r_out"]), float(t["r_in"]), y,
                    t["color"])
        y_prev = y + float(right["steps"]["rise_m"])
        wall_band(hi, rx, rz, float(t["r_out"]), y_prev, y,
                  t["color"], inward=True)
    floor = right["floor"]
    disc_top(hi, rx, rz, float(floor["radius_m"]),
             g_right + float(floor["y_rel_ground"]), floor["color"])
    cs = right["central_structure"]
    for part in cs["parts"]:
        cylinder(hi, rx, rz, float(part["radius_m"]),
                 g_right + float(part["y0_rel_ground"]),
                 g_right + float(part["y1_rel_ground"]), cs["color"])
    print(f"right amphitheatre: R={right['ring']['radius_m']} rim "
          f"{rim['r_in']}..{rim['r_out']} steps=8x{right['steps']['rise_m']}m depth={right['steps']['depth_m']}m "
          f"floor R{floor['radius_m']} central tiers R6/R4")

    # 描边线: 圆盘外圈 + 站环外圈 (与块内线同口径, 另起 mesh1)
    _disc_pts = circle_pts(dcx, dcz, float(disc["radius_m"]), SEG)
    _disc_pts.append(_disc_pts[0])
    hl.ring(_disc_pts, lambda x, z: g_disc + 0.32, [0.45, 0.45, 0.48])
    _ring_pts = circle_pts(rx, rz, float(right["ring"]["radius_m"]), SEG)
    _ring_pts.append(_ring_pts[0])
    hl.ring(_ring_pts, lambda x, z: g_right + 0.47, [0.45, 0.45, 0.48])

    sha, size = bs.write_glb2(OUT_GLB, hi, hl)
    summary = {
        "version": spec["version"],
        "disc_centre": {"x": dcx, "z": dcz},
        "structures": {
            s["id"]: {"center": s["center"]}
            for s in spec["structures"]
        },
        "triangles": hi.tris(),
        "lines": hl.count(),
        "glb": OUT_GLB,
        "glb_bytes": size,
        "sha256": sha,
        "bounds": {"x": [dcx - 75.0, dcx + 75.0],
                   "z": [dcz - 75.0, dcz + 75.0],
                   "y": [round(g_right - 6.0, 2), round(g_left + 14.0, 2)]},
        "chunks_affected": spec["chunks_affected"],
    }
    json.dump(summary, open(OUT_SUMMARY, "w"), ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
