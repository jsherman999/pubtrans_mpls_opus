#!/usr/bin/env python3
"""Build the street graph for PubTrans MPLS from OpenStreetMap.

Standard library only. Typical use:

    python3 tools/build_osm.py --fetch              # download from Overpass, then build
    python3 tools/build_osm.py --input data/raw/osm_roads.json   # rebuild from a saved download

Outputs (see docs/DATA_FORMAT.md):
    data/mpls_graph.js           window.MPLS_GRAPH = {...}  (committed, loaded by the page)
    data/mpls_graph.report.json  validation report          (committed)
    data/raw/osm_roads.json      raw Overpass response      (gitignored)

Street data (c) OpenStreetMap contributors, ODbL.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict

FORMAT_VERSION = 1
UNITS_PER_METER = 10  # coordinates and lengths are stored as integer decimeters

# Downtown Minneapolis + UMN East and West Bank (south, west, north, east).
DEFAULT_BBOX = (44.9600, -93.2920, 44.9970, -93.2150)
DEFAULT_BUFFER_M = 250.0
DEFAULT_OVERPASS = "https://overpass-api.de/api/interpreter"

# Road classes, most to least important. Index order is the stored class id.
CLASSES = [
    "motorway", "motorway_link", "trunk", "trunk_link",
    "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential",
    "living_street", "service", "busway",
]
CLASS_ID = {c: i for i, c in enumerate(CLASSES)}

# Default speeds in mph when maxspeed is missing (Minneapolis: 20 mph residential, 25 mph arterials).
DEFAULT_MPH = {
    "motorway": 55, "motorway_link": 30, "trunk": 40, "trunk_link": 25,
    "primary": 25, "primary_link": 20, "secondary": 25, "secondary_link": 20,
    "tertiary": 25, "tertiary_link": 20, "unclassified": 20, "residential": 20,
    "living_street": 10, "service": 10, "busway": 25, "pedestrian": 10,
}

EXCLUDED_SERVICE = {"parking_aisle", "driveway", "drive-through", "drive_through", "emergency_access"}
NO_ACCESS = {"no", "private", "agricultural", "forestry", "military", "delivery"}
YES_ACCESS = {"yes", "designated", "permissive"}
MPH_TO_KPH = 1.609344

# Direction bits stored per link (a = first node, b = last node, in OSM way order).
DIR_AB = 1        # general traffic may travel a -> b
DIR_BA = 2        # general traffic may travel b -> a
DIR_AB_PSV = 4    # shuttles/buses only, a -> b
DIR_BA_PSV = 8    # shuttles/buses only, b -> a

# Link flag bits.
FLAG_BRIDGE = 1
FLAG_TUNNEL = 2
FLAG_STOP_AT_A = 4   # traffic arriving at a (travelling b -> a) must stop
FLAG_STOP_AT_B = 8   # traffic arriving at b (travelling a -> b) must stop

# Node flag bits.
NODE_PORTAL = 1
NODE_SIGNAL = 2

# Signal approach values stored per link end.
SIG_NONE = -1
SIG_INTERNAL = 2     # link lies inside one controller cluster: never stops

SIGNAL_CLUSTER_M = 30.0


# --------------------------------------------------------------------------------------
# Projection
# --------------------------------------------------------------------------------------

class Projection:
    """Local equirectangular projection: x east, y south (canvas convention), meters."""

    def __init__(self, bbox):
        s, w, n, e = bbox
        self.s, self.w, self.n, self.e = s, w, n, e
        phi = math.radians((s + n) / 2)
        self.m_per_deg_lat = 111132.954 - 559.822 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
        self.m_per_deg_lon = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi)
        self.width = (e - w) * self.m_per_deg_lon
        self.height = (n - s) * self.m_per_deg_lat

    def xy(self, lat, lon):
        return ((lon - self.w) * self.m_per_deg_lon, (self.n - lat) * self.m_per_deg_lat)

    def inside(self, x, y, eps=1e-6):
        return -eps <= x <= self.width + eps and -eps <= y <= self.height + eps


def buffered_bbox(bbox, buffer_m):
    s, w, n, e = bbox
    proj = Projection(bbox)
    dlat = buffer_m / proj.m_per_deg_lat
    dlon = buffer_m / proj.m_per_deg_lon
    return (s - dlat, w - dlon, n + dlat, e + dlon)


# --------------------------------------------------------------------------------------
# Overpass
# --------------------------------------------------------------------------------------

def overpass_query(bbox):
    s, w, n, e = bbox
    box = f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})"
    classes = "|".join(CLASSES)
    return (
        "[out:json][timeout:180];("
        f'way["highway"~"^({classes})$"]{box};'
        # Transit malls are sometimes mapped as pedestrian streets that allow buses.
        f'way["highway"="pedestrian"]["bus"~"^(yes|designated)$"]{box};'
        f'way["highway"="pedestrian"]["psv"~"^(yes|designated)$"]{box};'
        ");(._;>;);out body;"
    )


def fetch_overpass(bbox, url=DEFAULT_OVERPASS, retries=3):
    query = overpass_query(bbox)
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "pubtrans-mpls-build/1"})
            with urllib.request.urlopen(req, timeout=240) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # network errors, 429/504 from busy servers
            last = exc
            wait = 15 * (attempt + 1)
            print(f"Overpass request failed ({exc}); retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"Overpass download failed: {last}")


# --------------------------------------------------------------------------------------
# Tag interpretation
# --------------------------------------------------------------------------------------

def access_class(tags):
    """Return 'general', 'psv' (shuttles/buses only) or None (not drivable)."""
    hw = tags.get("highway")
    psv_ok = hw == "busway" or tags.get("psv") in YES_ACCESS or tags.get("bus") in YES_ACCESS
    if hw == "pedestrian":
        return "psv" if psv_ok else None
    if hw not in CLASS_ID:
        return None
    if tags.get("area") == "yes":
        return None
    if hw == "service" and tags.get("service") in EXCLUDED_SERVICE:
        return None
    if hw == "busway":
        return "psv"
    # Most specific tag wins: motorcar > motor_vehicle > vehicle > access.
    general = None
    for key in ("motorcar", "motor_vehicle", "vehicle", "access"):
        if key in tags:
            general = tags[key]
            break
    if general in NO_ACCESS:
        return "psv" if psv_ok else None
    return "general"


def parse_oneway(tags):
    """Return +1 (way order), -1 (reverse) or 0 (both directions). None = closed (reversible)."""
    v = (tags.get("oneway") or "").lower()
    if v in ("yes", "true", "1"):
        return 1
    if v in ("-1", "reverse"):
        return -1
    if v in ("no", "false", "0"):
        return 0
    if v in ("reversible", "alternating"):
        return None
    hw = tags.get("highway")
    if hw in ("motorway", "motorway_link") or tags.get("junction") in ("roundabout", "circular"):
        return 1
    return 0


def psv_contraflow(tags):
    return (tags.get("oneway:psv") or tags.get("oneway:bus") or "").lower() == "no"


def parse_speed_kph(tags):
    hw = tags.get("highway")
    raw = (tags.get("maxspeed") or "").strip().lower()
    if raw:
        num = ""
        for ch in raw:
            if ch.isdigit() or ch == ".":
                num += ch
            elif num:
                break
        if num:
            try:
                val = float(num)
                if val > 0:
                    return round(val * MPH_TO_KPH, 1) if "mph" in raw else round(val, 1)
            except ValueError:
                pass
    return round(DEFAULT_MPH.get(hw, 20) * MPH_TO_KPH, 1)


def parse_int(v):
    try:
        return int(str(v).split(";")[0].strip())
    except (TypeError, ValueError):
        return None


def parse_lanes(tags, oneway):
    """Return (lanes in way direction, lanes against way direction)."""
    hw = tags.get("highway")
    fwd = parse_int(tags.get("lanes:forward"))
    bwd = parse_int(tags.get("lanes:backward"))
    total = parse_int(tags.get("lanes"))
    if oneway in (1, -1):
        n = total or fwd or bwd or default_lanes(hw, True)
        n = max(1, n)
        return (n, 0) if oneway == 1 else (0, n)
    if fwd and bwd:
        return max(1, fwd), max(1, bwd)
    if total:
        if fwd:
            return max(1, fwd), max(1, total - fwd)
        if bwd:
            return max(1, total - bwd), max(1, bwd)
        f = max(1, (total + 1) // 2)
        return f, max(1, total - f)
    d = default_lanes(hw, False)
    return d, d


def default_lanes(hw, oneway):
    if hw == "motorway":
        return 3
    if hw == "trunk":
        return 2
    if hw in ("primary", "secondary") and oneway:
        return 2
    return 1


def is_yes(v):
    return v is not None and v not in ("no", "false", "0")


# --------------------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------------------

def liang_barsky(p, q, width, height):
    """Clip segment p->q to [0,width]x[0,height]; return (t0, t1) or None."""
    x0, y0 = p
    dx, dy = q[0] - x0, q[1] - y0
    t0, t1 = 0.0, 1.0
    for pk, qk in ((-dx, x0), (dx, width - x0), (-dy, y0), (dy, height - y0)):
        if abs(pk) < 1e-12:
            if qk < -1e-9:
                return None
            continue
        r = qk / pk
        if pk < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    if t1 - t0 < 1e-9:
        return None
    return t0, t1


def seg_len(p, q):
    return math.hypot(q[0] - p[0], q[1] - p[1])


def bearing(p, q):
    """Direction of travel p->q in degrees, canvas coordinates (0 = east, 90 = south)."""
    return math.degrees(math.atan2(q[1] - p[1], q[0] - p[0])) % 360.0


def angle_diff_mod(a, b, period):
    d = (a - b) % period
    return min(d, period - d)


# --------------------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------------------

def build(osm, bbox=DEFAULT_BBOX, alleys=False, label="Downtown Minneapolis + UMN East/West Bank"):
    """Turn an Overpass JSON response into (graph, report). Pure function; no I/O."""
    proj = Projection(bbox)
    warnings = []

    osm_nodes = {}
    osm_ways = []
    for el in osm.get("elements", []):
        if el.get("type") == "node":
            osm_nodes[el["id"]] = el
        elif el.get("type") == "way":
            osm_ways.append(el)

    # ---- 1. usable ways, clipped into pieces --------------------------------------
    coords = {}           # node key -> (x, y)
    node_tags = {}        # node key -> tags (real OSM nodes only)
    portal_keys = set()
    pieces = []           # (way, [node keys]) in way order

    def node_xy(nid):
        if nid not in coords:
            n = osm_nodes[nid]
            coords[nid] = proj.xy(n["lat"], n["lon"])
            if n.get("tags"):
                node_tags[nid] = n["tags"]
        return coords[nid]

    skipped = defaultdict(int)
    for way in osm_ways:
        tags = way.get("tags", {})
        acc = access_class(tags)
        if acc is None:
            skipped["not drivable"] += 1
            continue
        if not alleys and tags.get("highway") == "service" and tags.get("service") == "alley":
            skipped["alley"] += 1
            continue
        oneway = parse_oneway(tags)
        if oneway is None:
            skipped["reversible"] += 1
            continue
        refs = [r for r in way.get("nodes", []) if r in osm_nodes]
        if len(refs) < 2:
            skipped["missing nodes"] += 1
            continue
        cur = None
        for i in range(len(refs) - 1):
            p, q = node_xy(refs[i]), node_xy(refs[i + 1])
            clip = liang_barsky(p, q, proj.width, proj.height)
            if clip is None:
                if cur:
                    pieces.append((way, cur))
                    cur = None
                continue
            t0, t1 = clip
            if cur is None:
                if t0 <= 1e-9:
                    cur = [refs[i]]
                else:
                    cur = [make_portal(coords, portal_keys, way["id"], i, t0, p, q)]
            if t1 >= 1 - 1e-9:
                cur.append(refs[i + 1])
            else:
                cur.append(make_portal(coords, portal_keys, way["id"], i, t1, p, q))
                pieces.append((way, cur))
                cur = None
        if cur:
            pieces.append((way, cur))

    pieces = [(w, keys) for w, keys in pieces if len(keys) >= 2]

    # ---- 2. topological nodes -------------------------------------------------------
    uses = defaultdict(int)
    topo = set(portal_keys)
    for _, keys in pieces:
        topo.add(keys[0])
        topo.add(keys[-1])
        seen = set()
        for k in keys:
            uses[k] += 1
            if k in seen:
                topo.add(k)  # way loops back on itself
            seen.add(k)
    for k, n in uses.items():
        if n >= 2:
            topo.add(k)
    for k, t in node_tags.items():
        if k in uses and t.get("highway") in ("traffic_signals", "stop"):
            topo.add(k)

    # ---- 3. links -------------------------------------------------------------------
    links = []
    for way, keys in pieces:
        tags = way.get("tags", {})
        attrs = way_attrs(way, tags)
        start = 0
        for i in range(1, len(keys)):
            if keys[i] in topo:
                seg = keys[start:i + 1]
                for part in split_loop(seg, topo):
                    links.append(make_link(part, attrs, coords))
                start = i
    links = [l for l in links if l["len"] > 0.05 and l["a"] != l["b"]]

    # ---- 4. strongly connected core (portals joined through the outside world) ----
    total_len = sum(l["len"] for l in links)
    keep_nodes = strongly_connected_core(links, portal_keys)
    dropped = [l for l in links if l["a"] not in keep_nodes or l["b"] not in keep_nodes]
    links = [l for l in links if l["a"] in keep_nodes and l["b"] in keep_nodes]
    dropped_len = sum(l["len"] for l in dropped)

    # ---- 5. index nodes -------------------------------------------------------------
    used = []
    index = {}
    for l in links:
        for k in (l["a"], l["b"]):
            if k not in index:
                index[k] = len(used)
                used.append(k)

    # ---- 6. traffic control ---------------------------------------------------------
    controllers, node_ctl = cluster_signals(used, coords, node_tags)
    assign_signal_groups(links, controllers, node_ctl, coords, node_tags)
    stop_count = assign_stops(links, used, coords, node_tags)

    # ---- 7. encode ------------------------------------------------------------------
    graph, report = encode(proj, bbox, used, index, coords, portal_keys, node_ctl, controllers,
                           links, stop_count)
    graph["label"] = label
    report["skipped_ways"] = dict(skipped)
    report["dropped_by_connectivity"] = {
        "links": len(dropped),
        "km": round(dropped_len / 1000, 3),
        "percent_of_length": round(100 * dropped_len / total_len, 2) if total_len else 0.0,
        "names": sorted({l["name"] for l in dropped if l["name"]})[:50],
    }
    if report["dropped_by_connectivity"]["percent_of_length"] > 2:
        warnings.append("More than 2% of road length was dropped by connectivity pruning.")
    report["warnings"] = warnings
    return graph, report


def make_portal(coords, portal_keys, way_id, i, t, p, q):
    key = f"portal:{way_id}:{i}:{t:.6f}"
    coords[key] = (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)
    portal_keys.add(key)
    return key


def way_attrs(way, tags):
    oneway = parse_oneway(tags)
    lanes_f, lanes_b = parse_lanes(tags, oneway)
    acc = access_class(tags)
    if oneway == 1:
        dir_mask = DIR_AB
        if psv_contraflow(tags):
            dir_mask |= DIR_BA_PSV
            lanes_b = max(lanes_b, 1)
    elif oneway == -1:
        dir_mask = DIR_BA
        if psv_contraflow(tags):
            dir_mask |= DIR_AB_PSV
            lanes_f = max(lanes_f, 1)
    else:
        dir_mask = DIR_AB | DIR_BA
    if acc == "psv":
        # Convert general permissions into shuttle-only permissions.
        dir_mask = ((DIR_AB_PSV if dir_mask & (DIR_AB | DIR_AB_PSV) else 0)
                    | (DIR_BA_PSV if dir_mask & (DIR_BA | DIR_BA_PSV) else 0))
    flags = 0
    if is_yes(tags.get("bridge")):
        flags |= FLAG_BRIDGE
    if is_yes(tags.get("tunnel")):
        flags |= FLAG_TUNNEL
    return {
        "way": way["id"],
        "cls": CLASS_ID.get(tags["highway"], CLASS_ID["busway"]),  # pedestrian transit malls -> busway
        "dir": dir_mask,
        "kph": parse_speed_kph(tags),
        "lf": lanes_f,
        "lb": lanes_b,
        "flags": flags,
        "name": tags.get("name") or tags.get("ref") or "",
    }


def split_loop(seg, topo):
    """A link whose ends coincide is split at its middle node so every link joins two nodes."""
    if seg[0] != seg[-1]:
        return [seg]
    if len(seg) < 4:
        return []  # degenerate
    mid = len(seg) // 2
    topo.add(seg[mid])
    return [seg[:mid + 1], seg[mid:]]


def make_link(keys, attrs, coords):
    pts = [coords[k] for k in keys]
    length = sum(seg_len(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    link = dict(attrs)
    link.update({"a": keys[0], "b": keys[-1], "pts": pts, "len": length,
                 "sigA": SIG_NONE, "sigB": SIG_NONE})
    return link


def arcs_of(link):
    """Directed arcs (from, to) allowed for any fleet vehicle."""
    out = []
    if link["dir"] & (DIR_AB | DIR_AB_PSV):
        out.append((link["a"], link["b"]))
    if link["dir"] & (DIR_BA | DIR_BA_PSV):
        out.append((link["b"], link["a"]))
    return out


def strongly_connected_core(links, portal_keys):
    """Nodes in the SCC that contains the outside world (all portals connect through it)."""
    world = "__world__"
    fwd = defaultdict(list)
    rev = defaultdict(list)
    nodes = set()
    for l in links:
        for u, v in arcs_of(l):
            fwd[u].append(v)
            rev[v].append(u)
            nodes.update((u, v))
    for p in portal_keys:
        if p in nodes:
            fwd[world].append(p); rev[p].append(world)
            fwd[p].append(world); rev[world].append(p)
    if not portal_keys & nodes:
        # No portals (tiny test areas): fall back to the largest SCC.
        return largest_scc(nodes, fwd, rev)
    reach_f = bfs(world, fwd)
    reach_b = bfs(world, rev)
    core = (reach_f & reach_b) - {world}
    return core


def bfs(start, graph):
    seen = {start}
    stack = [start]
    while stack:
        u = stack.pop()
        for v in graph.get(u, ()):
            if v not in seen:
                seen.add(v)
                stack.append(v)
    return seen


def largest_scc(nodes, fwd, rev):
    remaining = set(nodes)
    best = set()
    while remaining:
        s = next(iter(remaining))
        comp = bfs(s, fwd) & bfs(s, rev)
        remaining -= comp
        if len(comp) > len(best):
            best = comp
    return best


def cluster_signals(used, coords, node_tags):
    sig = [k for k in used if node_tags.get(k, {}).get("highway") == "traffic_signals"]
    parent = {k: k for k in sig}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    cell = SIGNAL_CLUSTER_M
    grid = defaultdict(list)
    for k in sig:
        x, y = coords[k]
        grid[(int(x // cell), int(y // cell))].append(k)
    for k in sig:
        x, y = coords[k]
        cx, cy = int(x // cell), int(y // cell)
        for gx in (cx - 1, cx, cx + 1):
            for gy in (cy - 1, cy, cy + 1):
                for j in grid.get((gx, gy), ()):
                    if j != k and seg_len(coords[k], coords[j]) <= cell:
                        ra, rb = find(k), find(j)
                        if ra != rb:
                            parent[ra] = rb
    groups = defaultdict(list)
    for k in sig:
        groups[find(k)].append(k)
    controllers = []
    node_ctl = {}
    for members in groups.values():
        cid = len(controllers)
        controllers.append({"nodes": members, "axis": 0.0})
        for k in members:
            node_ctl[k] = cid
    return controllers, node_ctl


def arrival_bearing(link, at_b):
    pts = link["pts"]
    return bearing(pts[-2], pts[-1]) if at_b else bearing(pts[1], pts[0])


def signal_applies(tags, link, at_b):
    """Honour traffic_signals:direction=forward/backward (relative to the OSM way)."""
    d = (tags.get("traffic_signals:direction") or tags.get("direction") or "").lower()
    if d == "forward":
        return at_b
    if d == "backward":
        return not at_b
    return True


def assign_signal_groups(links, controllers, node_ctl, coords, node_tags):
    approaches = defaultdict(list)   # cid -> [(link, at_b, bearing)]
    for l in links:
        ca, cb = node_ctl.get(l["a"]), node_ctl.get(l["b"])
        if ca is not None and ca == cb:
            l["sigA"] = l["sigB"] = SIG_INTERNAL
            continue
        if cb is not None and l["dir"] & (DIR_AB | DIR_AB_PSV) and signal_applies(node_tags[l["b"]], l, True):
            approaches[cb].append((l, True, arrival_bearing(l, True)))
        if ca is not None and l["dir"] & (DIR_BA | DIR_BA_PSV) and signal_applies(node_tags[l["a"]], l, False):
            approaches[ca].append((l, False, arrival_bearing(l, False)))
    for cid, apps in approaches.items():
        # Orientation of the crossing, modulo 90 degrees (4x angle mean).
        sx = sum(math.cos(math.radians(4 * b)) for _, _, b in apps)
        sy = sum(math.sin(math.radians(4 * b)) for _, _, b in apps)
        if abs(sx) + abs(sy) < 1e-6:
            axis = apps[0][2] % 90.0
        else:
            axis = (math.degrees(math.atan2(sy, sx)) / 4.0) % 90.0
        controllers[cid]["axis"] = axis
        for l, at_b, b in apps:
            group = 0 if angle_diff_mod(b, axis, 180.0) <= 45.0 else 1
            l["sigB" if at_b else "sigA"] = group


def assign_stops(links, used, coords, node_tags):
    """Mark which arrivals stop at highway=stop nodes. Returns number of stopped approaches."""
    at_node = defaultdict(list)  # node -> [(link, at_b)] arrivals
    touching = defaultdict(list)  # node -> links with an end at the node
    for l in links:
        touching[l["a"]].append(l)
        touching[l["b"]].append(l)
        if l["dir"] & (DIR_AB | DIR_AB_PSV):
            at_node[l["b"]].append((l, True))
        if l["dir"] & (DIR_BA | DIR_BA_PSV):
            at_node[l["a"]].append((l, False))
    count = 0
    for k in used:
        tags = node_tags.get(k, {})
        if tags.get("highway") != "stop":
            continue
        arrivals = at_node.get(k, [])
        if not arrivals:
            continue
        direction = (tags.get("direction") or "").lower()
        if tags.get("stop") == "all":
            chosen = arrivals
        elif direction in ("forward", "backward"):
            chosen = [(l, at_b) for l, at_b in arrivals if at_b == (direction == "forward")]
        else:
            incident = touching[k]
            if len(incident) == 2:
                # Stop sign on an approach just before an intersection: it governs travel
                # toward the nearer end (the shorter link).
                shorter = min(incident, key=lambda l: l["len"])
                chosen = [(l, at_b) for l, at_b in arrivals if l is not shorter]
            else:
                # Tagged on the intersection itself: stop the lowest-class approaches.
                worst = max(l["cls"] for l, _ in arrivals)
                chosen = [(l, at_b) for l, at_b in arrivals if l["cls"] == worst]
        for l, at_b in chosen:
            flag = FLAG_STOP_AT_B if at_b else FLAG_STOP_AT_A
            if not l["flags"] & flag:
                l["flags"] |= flag
                count += 1
    return count


def q(v):
    return int(round(v * UNITS_PER_METER))


def encode(proj, bbox, used, index, coords, portal_keys, node_ctl, controllers, links, stop_count):
    names = [""]
    name_id = {"": 0}
    nx, ny, nflags, nctl = [], [], [], []
    for k in used:
        x, y = coords[k]
        nx.append(q(x))
        ny.append(q(y))
        f = 0
        if k in portal_keys:
            f |= NODE_PORTAL
        if k in node_ctl:
            f |= NODE_SIGNAL
        nflags.append(f)
        nctl.append(node_ctl.get(k, -1))

    cols = {key: [] for key in ("a", "b", "dir", "kph", "lf", "lb", "cls", "flags", "name",
                                "sigA", "sigB", "len", "way", "shp")}
    shapes = []
    km_by_class = defaultdict(float)
    bridges = defaultdict(float)
    psv_only = defaultdict(float)
    for l in links:
        if l["name"] not in name_id:
            name_id[l["name"]] = len(names)
            names.append(l["name"])
        cols["a"].append(index[l["a"]])
        cols["b"].append(index[l["b"]])
        cols["dir"].append(l["dir"])
        cols["kph"].append(l["kph"])
        cols["lf"].append(l["lf"])
        cols["lb"].append(l["lb"])
        cols["cls"].append(l["cls"])
        cols["flags"].append(l["flags"])
        cols["name"].append(name_id[l["name"]])
        cols["sigA"].append(l["sigA"])
        cols["sigB"].append(l["sigB"])
        cols["len"].append(q(l["len"]))
        cols["way"].append(l["way"])
        interior = l["pts"][1:-1]
        cols["shp"].append(len(interior))
        px, py = q(l["pts"][0][0]), q(l["pts"][0][1])
        for x, y in interior:
            ix, iy = q(x), q(y)
            shapes.extend((ix - px, iy - py))
            px, py = ix, iy
        km_by_class[CLASSES[l["cls"]]] += l["len"] / 1000
        if l["flags"] & FLAG_BRIDGE:
            bridges[l["name"] or "(unnamed)"] += l["len"]
        if not l["dir"] & (DIR_AB | DIR_BA):
            psv_only[l["name"] or "(unnamed)"] += l["len"]

    graph = {
        "v": FORMAT_VERSION,
        "attribution": "Street data \u00a9 OpenStreetMap contributors (ODbL)",
        "bbox": list(bbox),
        "size": [q(proj.width), q(proj.height)],
        "unitsPerMeter": UNITS_PER_METER,
        "classes": CLASSES,
        "names": names,
        "nodes": {"x": nx, "y": ny, "flags": nflags, "ctl": nctl},
        "controllers": {"axis": [round(c["axis"], 1) for c in controllers]},
        "links": cols,
        "shapes": shapes,
    }

    portals = []
    for k in used:
        if k in portal_keys:
            i = index[k]
            ins = sum(1 for l in links if (l["a"] == k and l["dir"] & (DIR_AB | DIR_AB_PSV))
                      or (l["b"] == k and l["dir"] & (DIR_BA | DIR_BA_PSV)))
            outs = sum(1 for l in links if (l["b"] == k and l["dir"] & (DIR_AB | DIR_AB_PSV))
                       or (l["a"] == k and l["dir"] & (DIR_BA | DIR_BA_PSV)))
            road = next((l for l in links if k in (l["a"], l["b"])), None)
            portals.append({"node": i, "name": road["name"] if road else "",
                            "class": CLASSES[road["cls"]] if road else "",
                            "entry": ins > 0, "exit": outs > 0,
                            "x_m": round(coords[k][0], 1) + 0.0, "y_m": round(coords[k][1], 1) + 0.0})
    report = {
        "format_version": FORMAT_VERSION,
        "bbox": list(bbox),
        "size_m": [round(proj.width, 1), round(proj.height, 1)],
        "nodes": len(used),
        "links": len(links),
        "directed_arcs": sum(len(arcs_of(l)) for l in links),
        "km_total": round(sum(km_by_class.values()), 2),
        "km_by_class": {k: round(v, 2) for k, v in sorted(km_by_class.items(), key=lambda kv: -kv[1])},
        "signal_controllers": len(controllers),
        "signalized_nodes": sum(1 for k in used if k in node_ctl),
        "stop_approaches": stop_count,
        "portals": portals,
        "bridges_m": {k: round(v, 1) for k, v in sorted(bridges.items())},
        "psv_only_m": {k: round(v, 1) for k, v in sorted(psv_only.items())},
    }
    return graph, report


# --------------------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------------------

def write_js(graph, path, var="MPLS_GRAPH"):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    body = json.dumps(graph, separators=(",", ":"), ensure_ascii=False)
    with open(path, "w", encoding="utf-8") as f:
        f.write("// Generated by tools/build_osm.py \u2014 do not edit by hand.\n")
        f.write(f"// {graph['attribution']}\n")
        f.write(f"window.{var}={body};\n")
    return len(body)


def write_json(obj, path):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("S", "W", "N", "E"), default=DEFAULT_BBOX)
    ap.add_argument("--buffer-m", type=float, default=DEFAULT_BUFFER_M,
                    help="extra download margin so ways crossing the edge are complete")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--fetch", action="store_true", help="download from Overpass")
    src.add_argument("--input", help="saved Overpass JSON response")
    ap.add_argument("--raw-out", default="data/raw/osm_roads.json")
    ap.add_argument("--overpass-url", default=DEFAULT_OVERPASS)
    ap.add_argument("--out", default="data/mpls_graph.js")
    ap.add_argument("--report", default="data/mpls_graph.report.json")
    ap.add_argument("--var", default="MPLS_GRAPH", help="global variable name in the output")
    ap.add_argument("--alleys", action="store_true", help="include service=alley")
    ap.add_argument("--label", default="Downtown Minneapolis + UMN East/West Bank")
    args = ap.parse_args(argv)

    bbox = tuple(args.bbox)
    if args.fetch:
        osm = fetch_overpass(buffered_bbox(bbox, args.buffer_m), args.overpass_url)
        write_json(osm, args.raw_out)
        print(f"saved raw download to {args.raw_out}")
    else:
        with open(args.input, encoding="utf-8") as f:
            osm = json.load(f)

    graph, report = build(osm, bbox, alleys=args.alleys, label=args.label)
    size = write_js(graph, args.out, args.var)
    report["output_bytes"] = size
    write_json(report, args.report)
    print(f"wrote {args.out} ({size / 1024:.0f} KB): {report['nodes']} nodes, {report['links']} links, "
          f"{report['km_total']} km, {report['signal_controllers']} signal controllers, "
          f"{len(report['portals'])} portals")
    for w in report["warnings"]:
        print("WARNING:", w, file=sys.stderr)


if __name__ == "__main__":
    main()
