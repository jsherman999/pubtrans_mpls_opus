"""Tests for tools/build_demand.py on a small synthetic input.

Run: python3 -m unittest discover -s tests -p "test_*.py"
"""

import gzip
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "tools"))

import build_demand as bd  # noqa: E402

BBOX = (44.9600, -93.2920, 44.9970, -93.2150)


def block(geoid, lat, lon, pop, hu=0):
    return {"GEOID": geoid, "POP100": pop, "HU100": hu, "INTPTLAT": f"{lat:+.7f}", "INTPTLON": f"{lon:+.7f}"}


def wac(geoid, total, **sectors):
    row = {"w_geocode": geoid, "C000": str(total)}
    for i in range(1, 21):
        row[f"CNS{i:02d}"] = str(sectors.get(f"CNS{i:02d}", 0))
    return row


def od(w, h, n):
    return {"w_geocode": w, "h_geocode": h, "S000": str(n)}


# Four blocks inside the box (downtown home, downtown office, campus, riverfront), one outside.
HOME = "270531001001000"
OFFICE = "270531001001001"
CAMPUS = "270531002002000"
EMPTY = "270531002002001"
OUTSIDE = "270539999001000"
BLOCKS = [
    block(HOME, 44.9790, -93.2700, 1200, 700),        # inside the downtown outline
    block(OFFICE, 44.9770, -93.2680, 30, 10),
    block(CAMPUS, 44.9740, -93.2340, 800, 300),
    block(EMPTY, 44.9650, -93.2200, 0, 0),             # no people, no jobs: dropped
    block(OUTSIDE, 45.1000, -93.3000, 5000, 2000),     # outside the box
]
TRACTS = [
    {"GEOID": "27053100100", "INTPTLAT": "+44.9780", "INTPTLON": "-93.2690"},
    {"GEOID": "27053999900", "INTPTLAT": "+45.1000", "INTPTLON": "-93.2700"},   # due north
    {"GEOID": "27037010000", "INTPTLAT": "+44.8000", "INTPTLON": "-93.2500"},   # due south
]
WAC = [
    wac(OFFICE, 1000, CNS10=600, CNS07=100, CNS18=100, CNS16=50, CNS15=0),
    wac(CAMPUS, 500, CNS15=450, CNS18=50),
    wac(OUTSIDE, 9999, CNS10=9999),                    # job outside: ignored
]
OD_MAIN = [
    od(OFFICE, HOME, 100),                             # internal
    od(OFFICE, OUTSIDE, 600),                          # inbound from the north
    od(OFFICE, "270370100001000", 250),                # inbound from the south (Dakota County)
    od(CAMPUS, HOME, 40),                              # internal
    od(CAMPUS, "270370100001000", 410),                # inbound from the south
    od(OUTSIDE, HOME, 300),                            # outbound to the north
    od(OUTSIDE, OUTSIDE, 777),                         # unrelated
]
OD_AUX = [od(OFFICE, "551234567890123", 50)]           # from Wisconsin: east
PARKING = {"elements": [
    {"type": "way", "tags": {"amenity": "parking", "parking": "multi-storey", "name": "Ramp A"},
     "bounds": {"minlat": 44.9780, "minlon": -93.2710, "maxlat": 44.9785, "maxlon": -93.2700}},
    {"type": "way", "tags": {"amenity": "parking", "parking": "surface", "capacity": "120"},
     "bounds": {"minlat": 44.9700, "minlon": -93.2400, "maxlat": 44.9702, "maxlon": -93.2398}},
    {"type": "node", "tags": {"amenity": "parking", "capacity": "8"}, "lat": 44.97, "lon": -93.25},   # too small
    {"type": "way", "tags": {"amenity": "parking", "parking": "street_side", "capacity": "40"},
     "bounds": {"minlat": 44.9700, "minlon": -93.2500, "maxlat": 44.9701, "maxlon": -93.2490}},   # on-street: out
]}


class BuildDemandTest(unittest.TestCase):
    def setUp(self):
        self.demand, self.report = bd.build(BLOCKS, TRACTS, iter(WAC), iter(OD_MAIN), iter(OD_AUX), BBOX, 2023, PARKING)

    def test_zones_inside_box_only(self):
        z = self.demand["zones"]
        self.assertEqual(self.report["blocks_in_box"], 4)
        self.assertEqual(self.report["zones_kept"], 3, "the empty block is dropped, the outside one never kept")
        self.assertEqual(sum(z["pop"]), 2030)
        self.assertEqual(sum(z["jobs"]), 1500)
        self.assertEqual(self.report["residents"], 2030)
        for x, y in zip(z["x"], z["y"]):
            self.assertTrue(0 <= x <= 6074 and 0 <= y <= 4112)

    def test_job_groups(self):
        g = self.report["jobs_by_group"]
        self.assertEqual(g, {"office": 600, "retail": 100, "food": 150, "health": 50, "edu": 450})

    def test_commuter_flows(self):
        c = self.report["commuters"]
        self.assertEqual(c["internal"], 140)
        self.assertEqual(c["inbound"], 600 + 250 + 410 + 50)
        self.assertEqual(c["outbound"], 300)
        self.assertEqual(c["od_vs_wac_jobs"], round((140 + 1310) / 1500, 4))
        self.assertEqual(sorted(map(tuple, self.demand["internalOD"])), [(0, 1, 100), (0, 2, 40)])

    def test_directions(self):
        s = self.demand["inboundBySector"]
        self.assertEqual(len(s), 16)
        self.assertEqual(s[0], 600, "home tract due north: sector 0")
        self.assertEqual(s[8], 250 + 410, "Dakota County tract due south: sector 8")
        self.assertEqual(s[4], 50, "Wisconsin: east")
        self.assertEqual(self.demand["outboundBySector"][0], 300)

    def test_downtown_and_sites(self):
        self.assertEqual(self.report["downtown"]["residents"], 1230)
        self.assertEqual(self.report["downtown"]["jobs"], 1000)
        self.assertEqual([c["name"] for c in self.demand["campus"]], ["UMN East Bank", "UMN West Bank"])
        self.assertEqual(len(self.demand["venues"]), 4)

    def test_parking(self):
        p = self.demand["parking"]
        self.assertEqual(len(p), 2, "tiny and on-street parking are left out")
        ramp = next(f for f in p if f["name"] == "Ramp A")
        self.assertTrue(ramp["estimated"])
        self.assertGreater(ramp["capacity"], 300, "a five-level ramp on ~4,000 m2")
        lot = next(f for f in p if not f["estimated"])
        self.assertEqual(lot["capacity"], 120)

    def test_write_and_reload(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "demand.js")
            n = bd.write_js(self.demand, path)
            with open(path, encoding="utf-8") as f:
                text = f.read()
            self.assertTrue(text.startswith("// Generated by tools/build_demand.py"))
            body = text.split("window.MPLS_DEMAND=", 1)[1].rstrip().rstrip(";")
            self.assertEqual(len(body), n)
            self.assertEqual(json.loads(body)["v"], 1)

    def test_lumped_jobs_spread_over_floor_space(self):
        # 3,000 office jobs filed under one block with a small building; a big office building
        # 150 m away (nearest another block's point) takes the excess, with its commuters.
        lump, tower = "270531001001002", "270531001001003"
        blocks = BLOCKS + [block(lump, 44.9800, -93.2650, 0), block(tower, 44.9800, -93.2631, 0)]
        wac_rows = WAC + [wac(lump, 3000, CNS10=3000)]
        od_rows = OD_MAIN + [od(lump, "270370100001000", 2900), od(lump, HOME, 100)]
        proj = bd.Projection(BBOX)
        unit = 0.5

        def box(lat, lon, half_m, storeys, kind):
            x, y = proj.xy(lat, lon)
            q = [(round((x - half_m) / unit), round((y - half_m) / unit)), (round((x + half_m) / unit), round((y - half_m) / unit)),
                 (round((x + half_m) / unit), round((y + half_m) / unit)), (round((x - half_m) / unit), round((y + half_m) / unit))]
            return q, storeys, kind
        shapes = [box(44.9800, -93.2650, 10, 2, 2), box(44.9800, -93.2631, 30, 20, 3)]   # 800 m2 of commercial; 72,000 m2 of offices
        b = {"n": [], "h": [], "mh": [], "k": [], "x0": [], "y0": []}
        pts = []
        for q, storeys, kind in shapes:
            b["n"].append(4); b["h"].append(round(storeys * bd.STOREY_M * 10)); b["mh"].append(0); b["k"].append(kind)
            b["x0"].append(q[0][0]); b["y0"].append(q[0][1])
            for i in range(1, 4):
                pts += [q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]]
        buildings = {"unit": unit, "kinds": ["house", "apartments", "commercial", "office"], "buildings": b, "pts": pts}
        demand, report = bd.build(blocks, TRACTS, iter(wac_rows), iter(od_rows), iter(OD_AUX), BBOX, 2023, PARKING, buildings)
        z = demand["zones"]
        kept = [HOME, OFFICE, CAMPUS, lump, tower]       # blocks in the box with people or jobs, in order
        li, ti = kept.index(lump), kept.index(tower)
        self.assertEqual(report["jobs"], 4500, "every job is kept")
        self.assertEqual(report["commuters"]["internal"] + report["commuters"]["inbound"], 140 + 1310 + 100 + 2900)
        self.assertLessEqual(z["jobs"][li], 800 / bd.M2_PER_JOB_MIN + 2, "the small building keeps what its floor space holds")
        self.assertGreater(z["jobs"][ti], 2900)
        self.assertEqual(z["jobs"][li] + z["jobs"][ti], 3000)
        self.assertEqual(z["office"][li] + z["office"][ti], 3000)
        self.assertEqual(z["inbound"][li] + z["inbound"][ti], 2900)
        self.assertEqual(sum(k for h, w, k in demand["internalOD"] if w in (li, ti)), 100, "internal commuters move along")
        self.assertEqual([r[0] for r in report["jobs_spread"]], [lump])

    def test_no_buildings_no_spreading(self):
        self.assertEqual(self.report["jobs_spread"], [])
        self.assertIn("no building data", " ".join(self.report["warnings"]))

    def test_load_inputs_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            for name, obj in (("blocks.json", BLOCKS), ("tracts.json", TRACTS), ("parking.json", PARKING)):
                with open(os.path.join(d, name), "w") as f:
                    json.dump(obj, f)
            for name, rows in (("mn_wac_S000_JT00_2023.csv.gz", WAC), ("mn_od_main_JT00_2023.csv.gz", OD_MAIN),
                               ("mn_od_aux_JT00_2023.csv.gz", OD_AUX)):
                with gzip.open(os.path.join(d, name), "wt", newline="") as f:
                    keys = list(rows[0].keys())
                    f.write(",".join(keys) + "\n")
                    for r in rows:
                        f.write(",".join(r[k] for k in keys) + "\n")
            blocks, tracts, w, om, oa, parking = bd.load_inputs(d, 2023)
            demand, report = bd.build(blocks, tracts, w, om, oa, BBOX, 2023, parking)
            self.assertEqual(report["jobs"], 1500)
            self.assertEqual(report["commuters"], self.report["commuters"])


if __name__ == "__main__":
    unittest.main()
