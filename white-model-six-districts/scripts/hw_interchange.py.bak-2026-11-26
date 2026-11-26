#!/usr/bin/env python3
"""高速路口白模 §7.14 — 匝道层高判定（共享模块：分析脚本与生成器共用）。
规则（§7.10，2026-11-25 A8 标准叠加公式，取代旧 6.25+(L-1)*5.25m）：
  每层 6.9m = 净空 5.0m（CJJ 37-2012 表 3.4.3 机动车道最小净高）+ 结构深 1.9m
  （30m 标准跨小箱梁 1.7-1.9m 取中 1.8m + 桥面铺装 0.10m），deck(L) = L x 6.9m；
  bridge 文件有 numeric deck_height_m 的用桥文件值（实测优先：成温顶层 32m、
  府青制高点 15m、二环区间中点 12.0m）；缺 layer 的匝道不默认 layer1，
  按端点连接推断；定不下来的留平、进缺口。顶点高沿路长在两端高之间线性插值
  （坡，不是台阶）。节点图用全部顶点（不只是端点）：OSM 里匝道端点常落在
  主线中段顶点上。
旧规则废止原因：每层只加 5.25m 相当于结构深只算 0.25m，30m 跨箱梁实际
  1.7-1.9m，系统性偏矮且层数越高偏得越多（实测：府青 L2 低 3.5m）。
定不下来的留平、进缺口。顶点高沿路长在两端高之间线性插值（坡，不是台阶）。
节点图用全部顶点（不只是端点）：OSM 里匝道端点常落在主线中段顶点上。

两阶段：
  1. estimate_endpoints：端点高取该节点上其他路的 own-deck/地面证据（迭代 5 轮），
     未定端点保持 None（不许拿本路另一端高来填——那会把坡填平）。
  2. reconcile：用各路在该节点的实际高（own deck / 端点高 / 沿线插值高）做节点共识；
     共识一致则采用；共识与本路端点高差 >1m 且本路在该高上无直通延续（对向 ±35°、
     同类路）时，本路端点向共识高靠（上匝道/下匝道的坡头），记 conflict；
     有直通延续的保持自身高（主线穿过节点）。仍定不下来的留平、进缺口。
"""
import json, math, collections

LINK = {"motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
SCOPE = LINK | {"motorway"}
LON_M = 111320.0 * math.cos(math.radians(30.665))
LAT_M = 110540.0

def layer_deck(layer):
    if layer is None:
        return None, "no-layer"
    try:
        L = int(layer)
    except Exception:
        return None, "bad-layer"
    if L >= 1:
        return round(L * 6.9, 2), "layer-standard-stack"
    if L == 0:
        return 0.0, "layer0-ground"
    return None, "underpass"

def own_deck(road, bdeck):
    """本路自身 deck：bridge 文件 numeric 值优先，其次 layer 规则。返回 (deck|None, method)。
    例外（§7.10，已退役 2026-11-25 零平桥）：bridge 文件里若仍有记为"待核实"的桥
    （在 bdeck 里 deck 为 None），不许用 layer 规则兜底——留平，不编高度。
    2026-11-25 起 bridges-v1.json 已无"待核实"（全部 9,399 座均有数值桥面高，
    推算值标方法与误差），此分支不再触发，仅作防御保留。
    桥文件里根本没有记录的 bridge 路，才允许 layer 规则兜底。"""
    if road.get("bridge"):
        if road["osm_id"] in bdeck:
            d, m = bdeck[road["osm_id"]]
            if d is not None:
                return d, "bridge-deck:" + (m or "?")
            return None, "bridge-pending-flat"
    d, m = layer_deck(road.get("layer"))
    if d is not None:
        return d, m
    return None, "no-own-deck"

def key_of(lon, lat):
    return (round(lon, 5), round(lat, 5))

def way_pts(road):
    pf = road["points_flat"]
    return [(pf[i], pf[i + 1]) for i in range(0, len(pf) - 1, 2)]

def is_ground_evidence(road):
    """该路在某节点出现，是否证明该节点在地面：非 scope 普通路（无 layer 无 bridge），
    或 layer==0，或 bridge=='no'。scope 的 _link 无 layer 时不算地面证据（它本身可能高架）。"""
    if road.get("layer") is not None:
        try:
            if int(road["layer"]) == 0:
                return True
        except Exception:
            pass
    if road.get("bridge") == "no":
        return True
    if road["highway"] not in SCOPE and road.get("bridge") is None and road.get("layer") is None:
        return True
    return False

def build_node_index(roads, bdeck):
    """node -> {'elev': {osm_id: deck>0}, 'ground': set(osm_id), 'ways': set(osm_id)}，
    按全部顶点建（匝道端点常落在主线中段顶点上）。"""
    nodes = collections.defaultdict(lambda: {"elev": {}, "ground": set(), "ways": set()})
    for r in roads:
        pts = way_pts(r)
        if len(pts) < 2:
            continue
        deck, _ = own_deck(r, bdeck)
        ground = is_ground_evidence(r)
        for p in pts:
            n = nodes[key_of(*p)]
            n["ways"].add(r["osm_id"])
            if deck is not None and deck > 0:
                n["elev"][r["osm_id"]] = deck
            if ground:
                n["ground"].add(r["osm_id"])
    return nodes

def vertex_heights(pts, start_h, end_h):
    """顶点插值高（米制沿路长线性插值）。返回与 pts 等长的高度列表。
    端点为 None 时用另一端（仅用于插值中间点，不作为端点判定依据）。"""
    sh = start_h if start_h is not None else end_h
    eh = end_h if end_h is not None else start_h
    if sh is None or eh is None:
        return [0.0] * len(pts)
    total = 0.0
    cum = [0.0]
    for i in range(1, len(pts)):
        total += math.hypot((pts[i][0] - pts[i - 1][0]) * LON_M,
                            (pts[i][1] - pts[i - 1][1]) * LAT_M)
        cum.append(total)
    if total <= 0:
        return [sh] * len(pts)
    return [sh + (eh - sh) * (c / total) for c in cum]

def _bearing(p_from, p_to):
    dx = (p_to[0] - p_from[0]) * LON_M
    dz = (p_to[1] - p_from[1]) * LAT_M
    return math.degrees(math.atan2(dx, dz)) % 360.0

def _angle_diff(a, b):
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)

def _same_family(h1, h2):
    if h1 == h2:
        return True
    return (h1 == "motorway" and h2 == "motorway_link") or \
           (h1 == "motorway_link" and h2 == "motorway") or \
           (h1 == "trunk" and h2 == "trunk_link") or \
           (h1 == "trunk_link" and h2 == "trunk")

def estimate_endpoints(scope_roads, nodes, bdeck, iterations=5):
    """第一阶段：端点高取节点上其他路的 own-deck/地面证据（迭代收敛）。
    未定端点保持 None。返回 {osm_id: {...}}（start_h/end_h 可能为 None）。"""
    info = {}
    for r in scope_roads:
        pts = way_pts(r)
        if len(pts) < 2:
            continue
        deck, meth = own_deck(r, bdeck)
        lay = r.get("layer")
        under = False
        if lay is not None:
            try:
                under = int(lay) <= -1
            except Exception:
                pass
        info[r["osm_id"]] = {"road": r, "own_deck": deck, "own_meth": meth,
                             "start_h": 0.0 if under else deck,
                             "end_h": 0.0 if under else deck,
                             "underpass": under}
    for _ in range(iterations):
        changed = False
        for oid, d in info.items():
            if d["underpass"]:
                continue
            r = d["road"]
            pts = way_pts(r)
            for end, attr in ((pts[0], "start_h"), (pts[-1], "end_h")):
                if d[attr] is not None:
                    continue
                n = nodes.get(key_of(*end))
                if n is None:
                    continue
                others = [v for k, v in n["elev"].items() if k != oid]
                if others:
                    h = max(others)
                elif n["ground"] - {oid}:
                    h = 0.0
                else:
                    continue
                d[attr] = h
                changed = True
        if not changed:
            break
    return info

def reconcile(info, roads_by_id, nodes, bdeck, rounds=3):
    """第二阶段：节点共识调和。返回 (out, stats)。
    out: {osm_id: {osm_id, highway, name, layer, bridge, tunnel, length_m,
                    start_h, end_h, method, own_deck, conflict}}，端点高不再为 None
                    （flat-undetermined 的记 0.0 并标方法）。"""
    stats = collections.Counter()
    # 各路在各节点的实际高：scope 路用插值顶点高；非 scope 路用 own deck / 地面 0
    def node_heights_at(node_key, exclude_oid):
        """返回 [(osm_id, highway, height, bearing_or_None)]：其他路在该节点的高。
        bearing 仅对端点落在该节点的路给出（出节点方向）；中段顶点 bearing=None。"""
        out = []
        n = nodes.get(node_key)
        if n is None:
            return out
        for oid in n["ways"]:
            if oid == exclude_oid:
                continue
            r = roads_by_id.get(oid)
            if r is None:
                continue
            pts = way_pts(r)
            if len(pts) < 2:
                continue
            if oid in info:
                d = info[oid]
                vh = vertex_heights(pts, d["start_h"], d["end_h"])
                idxs = [i for i, p in enumerate(pts) if key_of(*p) == node_key]
                for i in idxs:
                    brg = None
                    if i == 0:
                        brg = _bearing(pts[0], pts[1])
                    elif i == len(pts) - 1:
                        brg = _bearing(pts[-1], pts[-2])
                    out.append((oid, r["highway"], vh[i], brg))
            else:
                deck, _ = own_deck(r, bdeck)
                h = deck if deck is not None else (0.0 if is_ground_evidence(r) else None)
                if h is None:
                    continue
                idxs = [i for i, p in enumerate(pts) if key_of(*p) == node_key]
                for i in idxs:
                    brg = None
                    if i == 0:
                        brg = _bearing(pts[0], pts[1])
                    elif i == len(pts) - 1:
                        brg = _bearing(pts[-1], pts[-2])
                    out.append((oid, r["highway"], h, brg))
        return out

    for _ in range(rounds):
        changed = False
        for oid, d in list(info.items()):
            if d["underpass"]:
                continue
            # §7.12 特型桥 pin：桥面高来自 bridge-shapes.json 的 numeric deck，
            # 端点不许被节点共识（地面引道）拉平；否则拱/塔浮在平桥面上方。
            # 代价：桥台处桥面与地面引道存在高差台阶（引道爬坡未建模），见 GAPS。
            if (d.get("own_meth") or "").endswith("distinctive-bridge-shape-7.12"):
                continue
            r = d["road"]
            pts = way_pts(r)
            for end_idx, attr in ((0, "start_h"), (len(pts) - 1, "end_h")):
                end = pts[end_idx]
                nk = key_of(*end)
                others = node_heights_at(nk, oid)
                if not others:
                    continue
                hs = [h for _, _, h, _ in others]
                cur = d[attr]
                other_end = d["end_h"] if attr == "start_h" else d["start_h"]
                # 本路出节点方向（用于直通延续判断）
                if end_idx == 0:
                    my_brg = _bearing(pts[0], pts[1])
                else:
                    my_brg = _bearing(pts[-1], pts[-2])
                if max(hs) - min(hs) <= 0.5:
                    consensus = sum(hs) / len(hs)
                    if cur is None:
                        d[attr] = consensus
                        stats["reconciled_none_to_consensus"] += 1
                        changed = True
                    elif abs(cur - consensus) > 1.0:
                        # 直通延续？同类路、对向 ±35°、同高
                        cont = any(_same_family(r["highway"], h2) and brg is not None
                                   and _angle_diff(brg, (my_brg + 180.0) % 360.0) <= 35.0
                                   and abs(h - cur) <= 0.5
                                   for _, h2, h, brg in others)
                        if not cont:
                            d[attr] = consensus
                            d.setdefault("conflicts", []).append(
                                {"node": nk, "from": cur, "to": consensus})
                            stats["reconciled_to_consensus"] += 1
                            changed = True
                else:
                    # 共识不一致：未定端点取离另一端高最近的那个
                    if cur is None:
                        ref = other_end if other_end is not None else (d["own_deck"] or 0.0)
                        best = min(hs, key=lambda h: abs(h - ref))
                        d[attr] = best
                        stats["reconciled_none_to_nearest"] += 1
                        changed = True
        if not changed:
            break
    out = {}
    for oid, d in info.items():
        r = d["road"]
        if d["underpass"]:
            out[oid] = {"osm_id": oid, "highway": r["highway"], "name": r.get("name"),
                        "layer": r.get("layer"), "bridge": r.get("bridge"),
                        "tunnel": r.get("tunnel"), "length_m": r.get("length_m"),
                        "start_h": 0.0, "end_h": 0.0, "method": "underpass-ground",
                        "own_deck": d["own_deck"],
                        "conflict": (d.get("conflicts") or [None])[0] if d.get("conflicts") else None}
            continue
        sh, eh = d["start_h"], d["end_h"]
        own = d["own_deck"]
        conflict = None
        if d.get("conflicts"):
            c = d["conflicts"][0]
            conflict = {"own_deck": own, "node": c["node"], "from": c["from"], "to": c["to"]}
        elif own is not None and sh is not None and eh is not None and \
                (abs(sh - own) > 1.0 or abs(eh - own) > 1.0):
            conflict = {"own_deck": own, "start_h": sh, "end_h": eh}
        if sh is None and eh is None:
            if own is not None:
                sh = eh = own
                method = "own-" + d["own_meth"]
            else:
                sh = eh = 0.0
                method = "flat-undetermined"
                stats["flat_undetermined"] += 1
        elif sh is None or eh is None:
            # 一端仍未定：用已定端（短 stub，接点不明，记方法）
            known = eh if sh is None else sh
            fill = own if own is not None else known
            if sh is None:
                sh = fill
            else:
                eh = fill
            method = "one-end-unknown"
            stats["one_end_unknown"] += 1
        elif own is None:
            method = "endpoint-inferred"
        elif abs(sh - own) < 0.01 and abs(eh - own) < 0.01:
            method = "own-" + d["own_meth"]
        else:
            method = "endpoint-slope"
        out[oid] = {"osm_id": oid, "highway": r["highway"], "name": r.get("name"),
                    "layer": r.get("layer"), "bridge": r.get("bridge"),
                    "tunnel": r.get("tunnel"), "length_m": r.get("length_m"),
                    "start_h": sh, "end_h": eh, "method": method,
                    "own_deck": own, "conflict": conflict}
    return out, stats
