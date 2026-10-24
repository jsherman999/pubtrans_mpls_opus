#!/usr/bin/env python3
"""Build the travel-demand inputs for PubTrans MPLS from public Census data.

Standard library only. Typical use:

    python3 tools/build_demand.py --fetch               # download, then build
    python3 tools/build_demand.py --input-dir data/raw/demand   # rebuild from saved downloads

Sources (public domain):
    2020 Census blocks (TIGERweb): population and housing units, internal points
    2020 Census tracts (TIGERweb): internal points, to place commuters' home locations
    LEHD LODES 8 (Minnesota): workplace jobs by sector (WAC) and home-to-work flows (OD main
        and aux), latest year available by default
    OpenStreetMap (Overpass): parking ramps and lots, where car trips into the area end
        (c) OpenStreetMap contributors, ODbL

Outputs (format in docs/DATA_FORMAT.md):
    data/mpls_demand.js           window.MPLS_DEMAND = {...}  (committed, loaded by the page)
    data/mpls_demand.report.json  totals and checks           (committed)
    data/raw/demand/              downloads                   (gitignored)
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from build_osm import DEFAULT_BBOX, Projection  # noqa: E402

FORMAT_VERSION = 1
LODES_YEAR = 2023
TIGERWEB = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer"
BLOCK_LAYER = 2        # 2020 Census Blocks (POP100, HU100)
TRACT_LAYER = 10       # Census 2020 tracts
LODES = "https://lehd.ces.census.gov/data/lodes/LODES8/mn"
OVERPASS = "https://overpass-api.de/api/interpreter"
SQM_PER_SPACE = 28        # gross floor area per parking space, when OSM has no capacity tag
DEFAULT_LEVELS = {"multi-storey": 5, "underground": 2, "surface": 1, "rooftop": 1}
MIN_SPACES = 20           # smaller lots are left out
STATE = "27"           # Minnesota
SECTORS = 16           # commuter directions, 22.5 degrees each, clockwise from north

# LODES NAICS sector columns grouped by how their workers travel.
JOB_GROUPS = {
    "office": ["CNS09", "CNS10", "CNS11", "CNS12", "CNS13", "CNS14", "CNS20"],   # hybrid work applies
    "retail": ["CNS07"],
    "food": ["CNS18"],                  # accommodation and food service
    "health": ["CNS16"],
    "edu": ["CNS15"],
}

# Rough direction from Minneapolis to neighbouring states, for out-of-state commuters (aux file).
STATE_BEARING = {"55": 90.0, "19": 180.0, "38": 300.0, "46": 225.0}
DEFAULT_STATE_BEARING = 180.0

# Special generators. Locations are approximate; numbers are documented assumptions (see
# PLAN.md Phase 5), not Census data.
CAMPUS = [
    {"name": "UMN East Bank", "lat": 44.9740, "lon": -93.2340, "r": 900, "share": 0.72},
    {"name": "UMN West Bank", "lat": 44.9715, "lon": -93.2440, "r": 450, "share": 0.28},
]
CAMPUS_STUDENTS = 38000          # students on the Minneapolis campus on a typical weekday
CAMPUS_LIVE_IN_BOX = 0.45        # share of them living inside the study area
HOSPITALS = [
    {"name": "Hennepin County Medical Center", "lat": 44.9727, "lon": -93.2614, "r": 350},
    {"name": "M Health Fairview University Medical Center (East Bank)", "lat": 44.9690, "lon": -93.2310, "r": 300},
    {"name": "M Health Fairview University Medical Center (West Bank)", "lat": 44.9677, "lon": -93.2372, "r": 250},
]
VENUES = [
    {"name": "U.S. Bank Stadium", "lat": 44.9736, "lon": -93.2575, "capacity": 66000},
    {"name": "Target Field", "lat": 44.9817, "lon": -93.2776, "capacity": 38500},
    {"name": "Target Center", "lat": 44.9795, "lon": -93.2761, "capacity": 19000},
    {"name": "Huntington Bank Stadium", "lat": 44.9765, "lon": -93.2245, "capacity": 50800},
]
# Downtown (Downtown West and East, North Loop, Loring Park, Elliot Park), approximate outline.
DOWNTOWN = [(44.9910, -93.2830), (44.9895, -93.2690), (44.9840, -93.2560), (44.9760, -93.2470),
            (44.9700, -93.2520), (44.9640, -93.2700), (44.9670, -93.2860), (44.9790, -93.2880)]


# --------------------------------------------------------------------------------------
# Downloads
# --------------------------------------------------------------------------------------

def http_get(url, retries=3, data=None):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "pubtrans-mpls-build/1"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                return resp.read()
        except Exception as exc:  # network errors, busy servers
            last = exc
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {last}")


def tigerweb_query(layer, params, page=2000):
    """All features of a TIGERweb layer query (attributes only), following pagination."""
    out, offset = [], 0
    while True:
        q = dict(params, f="json", returnGeometry="false", resultOffset=offset, resultRecordCount=page)
        data = json.loads(http_get(f"{TIGERWEB}/{layer}/query?" + urllib.parse.urlencode(q)))
        if "error" in data:
            raise RuntimeError(f"TIGERweb error: {data['error']}")
        feats = [f["attributes"] for f in data.get("features", [])]
        out.extend(feats)
        if not data.get("exceededTransferLimit") and len(feats) < page:
            return out
        offset += len(feats)


def fetch_all(bbox, raw_dir, year):
    os.makedirs(raw_dir, exist_ok=True)
    s, w, n, e = bbox
    blocks = tigerweb_query(BLOCK_LAYER, {
        "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope", "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects", "outFields": "GEOID,POP100,HU100,INTPTLAT,INTPTLON",
    })
    with open(os.path.join(raw_dir, "blocks.json"), "w") as f:
        json.dump(blocks, f)
    tracts = tigerweb_query(TRACT_LAYER, {"where": f"STATE='{STATE}'", "outFields": "GEOID,INTPTLAT,INTPTLON"})
    with open(os.path.join(raw_dir, "tracts.json"), "w") as f:
        json.dump(tracts, f)
    s_, w_, n_, e_ = bbox
    query = f'[out:json][timeout:120];(nwr["amenity"="parking"]({s_},{w_},{n_},{e_}););out bb tags;'
    parking = json.loads(http_get(OVERPASS, data=urllib.parse.urlencode({"data": query}).encode()))
    with open(os.path.join(raw_dir, "parking.json"), "w") as f:
        json.dump(parking, f)
    for name in (f"wac/mn_wac_S000_JT00_{year}.csv.gz", f"od/mn_od_main_JT00_{year}.csv.gz", f"od/mn_od_aux_JT00_{year}.csv.gz"):
        data = http_get(f"{LODES}/{name}")
        with open(os.path.join(raw_dir, os.path.basename(name)), "wb") as f:
            f.write(data)
    print(f"saved {len(blocks)} blocks, {len(tracts)} tracts and LODES {year} files to {raw_dir}")


def read_csv_gz(path):
    with gzip.open(path, "rt", newline="") as f:
        yield from csv.DictReader(f)


# --------------------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------------------

def point_in_polygon(lat, lon, poly):
    inside = False
    for i in range(len(poly)):
        (y1, x1), (y2, x2) = poly[i], poly[(i + 1) % len(poly)]
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def sector_of(bearing):
    return int(((bearing % 360) + 360 / SECTORS / 2) // (360 / SECTORS)) % SECTORS


def bearing_deg(lat0, lon0, lat1, lon1):
    """Compass bearing (degrees clockwise from north) from point 0 to point 1."""
    dy = (lat1 - lat0) * 111132.0
    dx = (lon1 - lon0) * 111320.0 * math.cos(math.radians(lat0))
    return math.degrees(math.atan2(dx, dy)) % 360


def parking_facilities(osm, proj):
    """Parking ramps and lots with an estimated number of spaces."""
    out = []
    for el in osm.get("elements", []):
        t = el.get("tags", {})
        if t.get("access") in ("no",) or t.get("parking") in ("street_side", "lane", "layby"):
            continue
        kind = t.get("parking", "surface")
        if "bounds" in el:
            b = el["bounds"]
            lat, lon = (b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2
            x0, y0 = proj.xy(b["maxlat"], b["minlon"])
            x1, y1 = proj.xy(b["minlat"], b["maxlon"])
            area = abs(x1 - x0) * abs(y1 - y0) * 0.75   # bounding box to footprint
        elif "lat" in el:
            lat, lon, area = el["lat"], el["lon"], 0
        else:
            continue
        cap = None
        try:
            cap = int(str(t.get("capacity", "")).split(";")[0])
        except ValueError:
            pass
        if cap is None:
            try:
                levels = float(t.get("building:levels") or t.get("parking:levels") or t.get("levels"))
            except (TypeError, ValueError):
                levels = DEFAULT_LEVELS.get(kind, 1)
            cap = int(area * levels / SQM_PER_SPACE)
        if cap < MIN_SPACES:
            continue
        x, y = proj.xy(lat, lon)
        if not proj.inside(x, y):
            continue
        out.append({"name": t.get("name", ""), "kind": kind, "x": round(x), "y": round(y), "capacity": cap,
                    "estimated": "capacity" not in t})
    return out


def build(blocks, tracts, wac_rows, od_main_rows, od_aux_rows, bbox, year=LODES_YEAR, parking_osm=None):
    proj = Projection(bbox)
    s, w, n, e = bbox
    clat, clon = (s + n) / 2, (w + e) / 2

    # Blocks whose internal point is inside the box.
    zone_of, zones = {}, []
    for b in blocks:
        lat, lon = float(b["INTPTLAT"]), float(b["INTPTLON"])
        if not (s <= lat <= n and w <= lon <= e):
            continue
        x, y = proj.xy(lat, lon)
        zone_of[b["GEOID"]] = len(zones)
        zones.append({"geoid": b["GEOID"], "lat": lat, "lon": lon, "x": x, "y": y,
                      "pop": int(b["POP100"] or 0), "hu": int(b["HU100"] or 0),
                      "jobs": 0, **{g: 0 for g in JOB_GROUPS}, "inbound": 0, "outbound": 0, "internal": 0})

    for r in wac_rows:
        z = zone_of.get(r["w_geocode"])
        if z is None:
            continue
        zz = zones[z]
        zz["jobs"] += int(r["C000"])
        for g, cols in JOB_GROUPS.items():
            zz[g] += sum(int(r[c]) for c in cols)

    tract_pos = {t["GEOID"]: (float(t["INTPTLAT"]), float(t["INTPTLON"])) for t in tracts}
    inbound_sector = [0] * SECTORS
    outbound_sector = [0] * SECTORS
    internal_od = defaultdict(int)
    unplaced = 0

    def home_bearing(h_geocode):
        pos = tract_pos.get(h_geocode[:11])
        if pos is None:
            return None
        return bearing_deg(clat, clon, *pos)

    for r in od_main_rows:
        wz, hz = zone_of.get(r["w_geocode"]), zone_of.get(r["h_geocode"])
        if wz is None and hz is None:
            continue
        k = int(r["S000"])
        if wz is not None and hz is not None:
            zones[wz]["internal"] += k
            internal_od[(hz, wz)] += k
        elif wz is not None:
            zones[wz]["inbound"] += k
            bearing = home_bearing(r["h_geocode"])
            if bearing is None:
                unplaced += k
            else:
                inbound_sector[sector_of(bearing)] += k
        else:
            zones[hz]["outbound"] += k
            pos = tract_pos.get(r["w_geocode"][:11])
            if pos:
                outbound_sector[sector_of(bearing_deg(clat, clon, *pos))] += k
    for r in od_aux_rows:   # jobs in Minnesota held by out-of-state residents
        wz = zone_of.get(r["w_geocode"])
        if wz is None:
            continue
        k = int(r["S000"])
        zones[wz]["inbound"] += k
        inbound_sector[sector_of(STATE_BEARING.get(r["h_geocode"][:2], DEFAULT_STATE_BEARING))] += k

    def site(sp):
        x, y = proj.xy(sp["lat"], sp["lon"])
        return {**sp, "x": round(x), "y": round(y)}

    kept = [z for z in zones if z["pop"] or z["jobs"] or z["outbound"]]
    index = {id(z): i for i, z in enumerate(kept)}
    old_to_new = {i: index[id(z)] for i, z in enumerate(zones) if id(z) in index}
    cols = ["pop", "hu", "jobs", *JOB_GROUPS, "inbound", "outbound"]
    demand = {
        "v": FORMAT_VERSION,
        "attribution": "U.S. Census Bureau: 2020 Census, LEHD LODES (public domain); parking © OpenStreetMap contributors (ODbL)",
        "sources": {"census": 2020, "lodes": year},
        "bbox": list(bbox),
        "zones": {"x": [round(z["x"]) for z in kept], "y": [round(z["y"]) for z in kept],
                  **{c: [z[c] for z in kept] for c in cols}},
        # Home zone, work zone, workers: commutes with both ends inside the study area.
        "internalOD": [[old_to_new[h], old_to_new[w_], k] for (h, w_), k in sorted(internal_od.items())
                       if h in old_to_new and w_ in old_to_new],
        "inboundBySector": inbound_sector,
        "outboundBySector": outbound_sector,
        "campus": [site(c) for c in CAMPUS],
        "campusStudents": CAMPUS_STUDENTS,
        "campusLiveInBox": CAMPUS_LIVE_IN_BOX,
        "hospitals": [site(h) for h in HOSPITALS],
        "venues": [site(v) for v in VENUES],
        "parking": parking_facilities(parking_osm or {}, proj),
    }

    downtown = [z for z in zones if point_in_polygon(z["lat"], z["lon"], DOWNTOWN)]
    tot = lambda key, zs=zones: sum(z[key] for z in zs)  # noqa: E731
    report = {
        "format_version": FORMAT_VERSION,
        "lodes_year": year,
        "blocks_in_box": len(zones),
        "zones_kept": len(kept),
        "residents": tot("pop"),
        "housing_units": tot("hu"),
        "jobs": tot("jobs"),
        "jobs_by_group": {g: tot(g) for g in JOB_GROUPS},
        "commuters": {
            "internal": tot("internal"),
            "inbound": tot("inbound"),
            "outbound": tot("outbound"),
            "inbound_unplaced": unplaced,
            "od_vs_wac_jobs": round((tot("internal") + tot("inbound")) / max(1, tot("jobs")), 4),
        },
        "inbound_by_sector": inbound_sector,
        "outbound_by_sector": outbound_sector,
        "downtown": {"residents": tot("pop", downtown), "jobs": tot("jobs", downtown)},
        "internal_od_pairs": len(demand["internalOD"]),
        "parking": {
            "facilities": len(demand["parking"]),
            "spaces": sum(p["capacity"] for p in demand["parking"]),
            "ramps": sum(1 for p in demand["parking"] if p["kind"] in ("multi-storey", "underground")),
            "spaces_estimated": sum(p["capacity"] for p in demand["parking"] if p["estimated"]),
        },
        "warnings": [],
    }
    if abs(report["commuters"]["od_vs_wac_jobs"] - 1) > 0.05:
        report["warnings"].append("OD flows and WAC job counts differ by more than 5 %")
    if unplaced > 0.02 * max(1, report["commuters"]["inbound"]):
        report["warnings"].append(f"{unplaced} inbound commuters have no home tract position")
    return demand, report


def load_inputs(raw_dir, year):
    with open(os.path.join(raw_dir, "blocks.json")) as f:
        blocks = json.load(f)
    with open(os.path.join(raw_dir, "tracts.json")) as f:
        tracts = json.load(f)
    p = lambda name: os.path.join(raw_dir, name)  # noqa: E731
    parking = {}
    if os.path.exists(p("parking.json")):
        with open(p("parking.json")) as f:
            parking = json.load(f)
    return (blocks, tracts, read_csv_gz(p(f"mn_wac_S000_JT00_{year}.csv.gz")),
            read_csv_gz(p(f"mn_od_main_JT00_{year}.csv.gz")), read_csv_gz(p(f"mn_od_aux_JT00_{year}.csv.gz")), parking)


def write_js(obj, path, var="MPLS_DEMAND"):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    body = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    with open(path, "w", encoding="utf-8") as f:
        f.write("// Generated by tools/build_demand.py — do not edit by hand.\n")
        f.write(f"// {obj['attribution']}\n")
        f.write(f"window.{var}={body};\n")
    return len(body)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("S", "W", "N", "E"), default=DEFAULT_BBOX)
    ap.add_argument("--year", type=int, default=LODES_YEAR, help="LODES year")
    ap.add_argument("--fetch", action="store_true", help="download the Census and LODES inputs first")
    ap.add_argument("--input-dir", default="data/raw/demand")
    ap.add_argument("--out", default="data/mpls_demand.js")
    ap.add_argument("--report", default="data/mpls_demand.report.json")
    args = ap.parse_args(argv)
    bbox = tuple(args.bbox)
    if args.fetch:
        fetch_all(bbox, args.input_dir, args.year)
    blocks, tracts, wac, od_main, od_aux, parking = load_inputs(args.input_dir, args.year)
    demand, report = build(blocks, tracts, wac, od_main, od_aux, bbox, args.year, parking)
    report["output_bytes"] = write_js(demand, args.out)
    with open(args.report, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
        f.write("\n")
    c = report["commuters"]
    print(f"wrote {args.out} ({report['output_bytes'] / 1024:.0f} KB): {report['zones_kept']} zones, "
          f"{report['residents']:,} residents, {report['jobs']:,} jobs; commuters {c['internal']:,} internal, "
          f"{c['inbound']:,} inbound, {c['outbound']:,} outbound; downtown {report['downtown']['residents']:,} residents; "
          f"{report['parking']['facilities']} parking facilities, {report['parking']['spaces']:,} spaces")
    for w in report["warnings"]:
        print("WARNING:", w, file=sys.stderr)


if __name__ == "__main__":
    main()
