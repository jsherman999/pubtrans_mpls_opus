#!/usr/bin/env python3
"""Build building footprints with heights for PubTrans MPLS from OpenStreetMap.

Standard library only. Typical use:

    python3 tools/build_buildings.py --fetch            # download from Overpass, then build
    python3 tools/build_buildings.py                    # rebuild from data/raw/buildings/osm_buildings.json

Outputs (format in docs/DATA_FORMAT.md):
    data/mpls_buildings.js           window.MPLS_BUILDINGS = {...}  (committed)
    data/mpls_buildings.report.json  counts, height sources, tallest, landmarks (committed)

Building data (c) OpenStreetMap contributors, ODbL.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from build_osm import DEFAULT_BBOX, Projection  # noqa: E402

FORMAT_VERSION = 1
OVERPASS = "https://overpass-api.de/api/interpreter"
UNIT = 0.5                 # meters per stored coordinate unit
SIMPLIFY_M = 0.6           # Douglas-Peucker tolerance
MIN_AREA_M2 = 15           # smaller footprints (sheds, kiosks) are dropped
LEVEL_M = 3.3              # meters per storey when only building:levels is known

# Kinds used for colour and default height. Index order is the stored kind id.
KINDS = ["house", "apartments", "commercial", "office", "university", "civic", "industrial",
         "garage", "parking", "stadium", "church", "other"]
KIND_OF = {
    "house": "house", "detached": "house", "semidetached_house": "house", "terrace": "house", "bungalow": "house",
    "residential": "apartments", "apartments": "apartments", "dormitory": "apartments",
    "retail": "commercial", "commercial": "commercial", "hotel": "commercial", "supermarket": "commercial",
    "office": "office", "university": "university", "college": "university", "school": "university",
    "public": "civic", "government": "civic", "hospital": "civic", "civic": "civic", "train_station": "civic",
    "industrial": "industrial", "warehouse": "industrial", "service": "industrial",
    "garage": "garage", "garages": "garage", "shed": "garage", "roof": "garage", "carport": "garage",
    "parking": "parking", "stadium": "stadium", "church": "church", "cathedral": "church", "chapel": "church",
}
DEFAULT_HEIGHT = {   # meters, when OSM has neither height nor levels
    "house": 7, "apartments": 13, "commercial": 10, "office": 20, "university": 15, "civic": 15,
    "industrial": 9, "garage": 3, "parking": 15, "stadium": 30, "church": 15, "other": 9,
}
# Towers OSM has no height or parts for. Approximate public figures, used only as a fallback.
KNOWN_HEIGHTS = {"Wells Fargo Center": 236, "Foshay Tower": 136}
# Landmarks drawn with hand-built designs in src/buildings.js (matched by OSM name). The IDS
# tower is an OSM building:part; for the others the outline is kept and any parts inside it are
# dropped, since the design replaces them.
LANDMARKS = ["US Bank Stadium", "IDS Tower", "Target Center", "Northrop Memorial Auditorium",
             "Coffman Memorial Union", "Huntington Bank Stadium"]
LANDMARK_OUTLINES = set(LANDMARKS) - {"IDS Tower"}


def fetch(bbox, retries=3):
    s, w, n, e = bbox
    box = f"({s},{w},{n},{e})"
    query = (f'[out:json][timeout:240];(way["building"]{box};relation["building"]{box};'
             f'way["building:part"]{box};way["leisure"="stadium"]{box};);out geom;')
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(OVERPASS, data=data, headers={"User-Agent": "pubtrans-mpls-build/1"})
            with urllib.request.urlopen(req, timeout=300) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # network errors, busy servers
            last = exc
    raise RuntimeError(f"Overpass download failed: {last}")


def parse_number(text):
    if text is None:
        return None
    t = str(text).strip().lower().replace(",", ".")
    for unit, f in (("ft", 0.3048), ("'", 0.3048), ("m", 1.0)):
        if t.endswith(unit):
            t, factor = t[: -len(unit)].strip(), f
            break
    else:
        factor = 1.0
    try:
        return float(t.split(";")[0]) * factor
    except ValueError:
        return None


def polygon_area(pts):
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return a / 2


def centroid(pts):
    a = polygon_area(pts)
    if abs(a) < 1e-9:
        return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
    cx = cy = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        f = x1 * y2 - x2 * y1
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    return cx / (6 * a), cy / (6 * a)


def inside(x, y, pts):
    c = False
    for i in range(len(pts)):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % len(pts)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def simplify(pts, tol):
    """Douglas-Peucker on an open polyline."""
    if len(pts) < 3:
        return pts
    (ax, ay), (bx, by) = pts[0], pts[-1]
    dx, dy = bx - ax, by - ay
    norm = math.hypot(dx, dy) or 1e-9
    best, idx = -1.0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = abs(dy * (px - ax) - dx * (py - ay)) / norm if norm > 1e-9 else math.hypot(px - ax, py - ay)
        if d > best:
            best, idx = d, i
    if best <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[: idx + 1], tol)[:-1] + simplify(pts[idx:], tol)


def simplify_ring(pts, tol):
    """Simplify a closed ring, keeping at least a triangle."""
    if len(pts) <= 4:
        return pts
    # Split at the point farthest from the first so both halves are open polylines.
    far = max(range(len(pts)), key=lambda i: math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]))
    a = simplify(pts[: far + 1], tol)
    b = simplify(pts[far:] + [pts[0]], tol)
    out = a[:-1] + b[:-1]
    return out if len(out) >= 3 else pts


def outer_rings(el):
    """Outer rings of a way or multipolygon relation, as lists of (lat, lon)."""
    if el["type"] == "way":
        g = el.get("geometry") or []
        return [[(p["lat"], p["lon"]) for p in g]] if len(g) >= 4 else []
    rings, pending = [], [m.get("geometry") or [] for m in el.get("members", []) if m.get("role") == "outer"]
    pending = [[(p["lat"], p["lon"]) for p in g] for g in pending if g]
    while pending:   # join outer ways end to end into closed rings
        ring = pending.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, seg in enumerate(pending):
                if seg[0] == ring[-1]:
                    ring += seg[1:]
                elif seg[-1] == ring[-1]:
                    ring += seg[::-1][1:]
                else:
                    continue
                pending.pop(i)
                changed = True
                break
        if len(ring) >= 4:
            rings.append(ring)
    return rings


def height_of(tags, kind, report):
    h = parse_number(tags.get("height"))
    if h is not None and h > 0:
        report["height_sources"]["height tag"] += 1
        return h
    levels = parse_number(tags.get("building:levels"))
    roof_levels = parse_number(tags.get("roof:levels")) or 0
    if levels is not None and levels > 0:
        report["height_sources"]["levels"] += 1
        return (levels + roof_levels * 0.5) * LEVEL_M
    name = tags.get("name")
    if name in KNOWN_HEIGHTS:
        report["height_sources"]["known tower"] += 1
        return KNOWN_HEIGHTS[name]
    report["height_sources"]["default for type"] += 1
    return DEFAULT_HEIGHT[kind]


def min_height_of(tags):
    mh = parse_number(tags.get("min_height"))
    if mh is not None:
        return mh
    ml = parse_number(tags.get("building:min_level"))
    return ml * LEVEL_M if ml else 0.0


def build(osm, bbox):
    proj = Projection(bbox)
    report = {"format_version": FORMAT_VERSION, "elements": len(osm.get("elements", [])),
              "height_sources": {"height tag": 0, "levels": 0, "known tower": 0, "default for type": 0},
              "dropped": {"outside box": 0, "too small": 0, "outline with parts": 0, "part inside a landmark": 0,
                          "bad geometry": 0},
              "warnings": []}
    candidates = []
    for el in osm.get("elements", []):
        tags = el.get("tags", {})
        is_part = "building:part" in tags and "building" not in tags
        btype = tags.get("building") or ("stadium" if tags.get("leisure") == "stadium" else tags.get("building:part", "yes"))
        if btype == "no":
            continue
        for ring in outer_rings(el):
            pts = [proj.xy(lat, lon) for lat, lon in ring]
            if pts[0] == pts[-1]:
                pts = pts[:-1]
            if len(pts) < 3:
                report["dropped"]["bad geometry"] += 1
                continue
            area = abs(polygon_area(pts))
            if area < MIN_AREA_M2:
                report["dropped"]["too small"] += 1
                continue
            cx, cy = centroid(pts)
            if not proj.inside(cx, cy):
                report["dropped"]["outside box"] += 1
                continue
            candidates.append({"tags": tags, "pts": pts, "area": area, "cx": cx, "cy": cy, "part": is_part,
                               "type": btype, "stadium_only": "building" not in tags and not is_part})

    # Simple 3D buildings: an outline with building:parts inside is drawn by its parts. A
    # stadium mapped only as leisure=stadium is dropped when a building covers it.
    parts = [c for c in candidates if c["part"]]
    cell = 100.0
    grid = {}
    for p in parts:
        grid.setdefault((int(p["cx"] // cell), int(p["cy"] // cell)), []).append(p)
    outlines = [c for c in candidates if not c["part"] and c["tags"].get("name") in LANDMARK_OUTLINES]
    keep = []
    for c in candidates:
        if c["part"] and any(inside(c["cx"], c["cy"], o["pts"]) for o in outlines):
            report["dropped"]["part inside a landmark"] += 1
            continue
        if not c["part"] and c["tags"].get("name") not in LANDMARK_OUTLINES:
            xs, ys = [p[0] for p in c["pts"]], [p[1] for p in c["pts"]]
            covered = False
            for gx in range(int(min(xs) // cell), int(max(xs) // cell) + 1):
                for gy in range(int(min(ys) // cell), int(max(ys) // cell) + 1):
                    for p in grid.get((gx, gy), []):
                        if inside(p["cx"], p["cy"], c["pts"]) and p["area"] < c["area"] * 1.2:
                            covered = True
                            break
            if covered:
                report["dropped"]["outline with parts"] += 1
                continue
        keep.append(c)

    names, name_id = [""], {"": 0}
    out = {"n": [], "h": [], "mh": [], "k": [], "name": [], "x0": [], "y0": []}
    deltas = []
    tallest = []
    for c in keep:
        tags = c["tags"]
        kind = KIND_OF.get(c["type"], "other")
        if c["stadium_only"]:
            kind = "stadium"
        h = height_of(tags, kind, report)
        mh = min(min_height_of(tags), h - 1)
        ring = simplify_ring(c["pts"], SIMPLIFY_M)
        if polygon_area(ring) < 0:      # store counter-clockwise in screen terms (x east, y south)
            ring = ring[::-1]
        q = [(round(x / UNIT), round(y / UNIT)) for x, y in ring]
        q = [p for i, p in enumerate(q) if p != q[i - 1]]
        if len(q) < 3:
            report["dropped"]["bad geometry"] += 1
            continue
        name = tags.get("name", "")
        if name not in name_id:
            name_id[name] = len(names)
            names.append(name)
        out["n"].append(len(q))
        out["h"].append(round(h * 10))
        out["mh"].append(round(max(0, mh) * 10))
        out["k"].append(KINDS.index(kind))
        out["name"].append(name_id[name])
        out["x0"].append(q[0][0])
        out["y0"].append(q[0][1])
        for i in range(1, len(q)):
            deltas += [q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]]
        tallest.append((h, name or tags.get("addr:street", "unnamed")))

    data = {
        "v": FORMAT_VERSION,
        "attribution": "Building data © OpenStreetMap contributors (ODbL)",
        "bbox": list(bbox), "unit": UNIT, "kinds": KINDS, "names": names,
        "buildings": out, "pts": deltas,
    }
    tallest.sort(reverse=True)
    report.update({
        "buildings": len(out["n"]),
        "points": sum(out["n"]),
        "tallest": [{"name": n, "height_m": round(h, 1)} for h, n in tallest[:15]],
        "landmarks_found": [n for n in LANDMARKS if n in name_id],
        "landmarks_missing": [n for n in LANDMARKS if n not in name_id],
        "by_kind": {k: out["k"].count(i) for i, k in enumerate(KINDS)},
    })
    return data, report


def write_js(obj, path, var="MPLS_BUILDINGS"):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    body = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    with open(path, "w", encoding="utf-8") as f:
        f.write("// Generated by tools/build_buildings.py — do not edit by hand.\n")
        f.write(f"// {obj['attribution']}\n")
        f.write(f"window.{var}={body};\n")
    return len(body)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("S", "W", "N", "E"), default=DEFAULT_BBOX)
    ap.add_argument("--fetch", action="store_true", help="download from Overpass first")
    ap.add_argument("--input", default="data/raw/buildings/osm_buildings.json")
    ap.add_argument("--out", default="data/mpls_buildings.js")
    ap.add_argument("--report", default="data/mpls_buildings.report.json")
    args = ap.parse_args(argv)
    bbox = tuple(args.bbox)
    if args.fetch:
        osm = fetch(bbox)
        os.makedirs(os.path.dirname(args.input), exist_ok=True)
        with open(args.input, "w") as f:
            json.dump(osm, f)
    with open(args.input, encoding="utf-8") as f:
        osm = json.load(f)
    data, report = build(osm, bbox)
    report["output_bytes"] = write_js(data, args.out)
    with open(args.report, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {args.out} ({report['output_bytes'] / 1024:.0f} KB): {report['buildings']:,} buildings, "
          f"{report['points']:,} points; heights {report['height_sources']}; landmarks missing {report['landmarks_missing']}")
    for w in report["warnings"]:
        print("WARNING:", w, file=sys.stderr)


if __name__ == "__main__":
    main()
