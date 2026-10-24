"""Tests for tools/build_buildings.py on a small synthetic OSM response.

Run: python3 -m unittest discover -s tests -p "test_*.py"
"""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "tools"))

import build_buildings as bb  # noqa: E402

BBOX = (44.9600, -93.2920, 44.9970, -93.2150)
DLAT, DLON = 1 / 111132.0, 1 / 78900.0   # about a meter each way at this latitude


def square(lat, lon, size_m, extra=()):
    """Closed ring of (lat, lon) points; `extra` inserts collinear midpoints on the first edge."""
    pts = [(lat, lon)]
    for f in extra:
        pts.append((lat, lon + f * size_m * DLON))
    pts += [(lat, lon + size_m * DLON), (lat + size_m * DLAT, lon + size_m * DLON), (lat + size_m * DLAT, lon), (lat, lon)]
    return [{"lat": a, "lon": b} for a, b in pts]


def way(i, ring, **tags):
    return {"type": "way", "id": i, "tags": tags, "geometry": ring}


OSM = {"elements": [
    way(1, square(44.9750, -93.2700, 30), building="office", height="120"),             # height tag
    way(2, square(44.9760, -93.2700, 20), building="apartments", **{"building:levels": "6"}),   # levels
    way(3, square(44.9770, -93.2700, 12), building="house"),                            # default for type
    way(4, square(44.9780, -93.2700, 3), building="shed"),                              # too small
    way(5, square(45.1000, -93.2700, 30), building="yes"),                              # outside the box
    # An outline with a tower part inside: the part is drawn, the outline dropped.
    way(6, square(44.9790, -93.2700, 60), building="yes", name="Tower Block"),
    way(7, square(44.9792, -93.2697, 20), **{"building:part": "yes", "height": "656 ft", "min_height": "10"}),
    # A landmark outline keeps its own shape; parts inside it are dropped.
    way(8, square(44.9800, -93.2600, 80), building="stadium", name="US Bank Stadium", height="83"),
    way(9, square(44.9802, -93.2598, 20), **{"building:part": "roof"}),
    # A stadium mapped only as leisure=stadium.
    way(10, square(44.9700, -93.2300, 100), leisure="stadium", name="Huntington Bank Stadium"),
    # Collinear points are simplified away.
    way(11, square(44.9710, -93.2500, 40, extra=(0.25, 0.5, 0.75)), building="retail"),
    # A multipolygon whose outer ring comes in two ways.
    {"type": "relation", "id": 12, "tags": {"building": "university", "type": "multipolygon"}, "members": [
        {"role": "outer", "geometry": square(44.9720, -93.2400, 50)[:3]},
        {"role": "outer", "geometry": square(44.9720, -93.2400, 50)[2:]},
    ]},
]}


def decode(data):
    """Python mirror of src/buildings.js decoding."""
    B, u, P = data["buildings"], data["unit"], data["pts"]
    out, off = [], 0
    for i in range(len(B["n"])):
        x, y = B["x0"][i], B["y0"][i]
        pts = [(x * u, y * u)]
        for _ in range(B["n"][i] - 1):
            x += P[off]
            y += P[off + 1]
            off += 2
            pts.append((x * u, y * u))
        out.append({"pts": pts, "h": B["h"][i] / 10, "mh": B["mh"][i] / 10, "kind": data["kinds"][B["k"][i]],
                    "name": data["names"][B["name"][i]]})
    assert off == len(P)
    return out


class BuildBuildingsTest(unittest.TestCase):
    def setUp(self):
        self.data, self.report = bb.build(OSM, BBOX)
        self.b = decode(self.data)

    def find(self, name=None, h=None):
        return [x for x in self.b if (name is None or x["name"] == name) and (h is None or abs(x["h"] - h) < 0.6)]

    def test_heights(self):
        self.assertTrue(self.find(h=120))
        self.assertTrue(self.find(h=6 * bb.LEVEL_M))
        self.assertTrue(self.find(h=bb.DEFAULT_HEIGHT["house"]))
        part = self.find(h=656 * 0.3048)[0]
        self.assertAlmostEqual(part["mh"], 10, places=1)
        self.assertEqual(self.report["height_sources"]["height tag"], 3)   # the office, the tower part, US Bank Stadium

    def test_drops(self):
        d = self.report["dropped"]
        self.assertEqual(d["too small"], 1)
        self.assertEqual(d["outside box"], 1)
        self.assertEqual(d["outline with parts"], 1)
        self.assertEqual(d["part inside a landmark"], 1)
        self.assertFalse(self.find("Tower Block"), "outline with a part is drawn by the part")

    def test_landmarks(self):
        self.assertEqual(self.report["landmarks_missing"], ["IDS Tower", "Target Center", "Northrop Memorial Auditorium", "Coffman Memorial Union"])
        stadium = self.find("Huntington Bank Stadium")[0]
        self.assertEqual(stadium["kind"], "stadium")
        self.assertEqual(stadium["h"], bb.DEFAULT_HEIGHT["stadium"])
        self.assertEqual(self.find("US Bank Stadium")[0]["h"], 83)

    def test_geometry(self):
        for x in self.b:
            self.assertGreaterEqual(len(x["pts"]), 3)
            self.assertGreater(bb.polygon_area(x["pts"]), 0, "rings stored with positive area (x east, y south)")
        retail = [x for x in self.b if x["kind"] == "commercial"][0]
        self.assertEqual(len(retail["pts"]), 4, "collinear points simplified away")
        uni = [x for x in self.b if x["kind"] == "university"][0]
        self.assertAlmostEqual(bb.polygon_area(uni["pts"]), 2500, delta=60, msg="relation outer ways joined")

    def test_parse_number(self):
        self.assertEqual(bb.parse_number("12"), 12)
        self.assertAlmostEqual(bb.parse_number("100 ft"), 30.48)
        self.assertEqual(bb.parse_number("15 m"), 15)
        self.assertIsNone(bb.parse_number("tall"))

    def test_output(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "b.js")
            n = bb.write_js(self.data, path)
            with open(path, encoding="utf-8") as f:
                body = f.read().split("window.MPLS_BUILDINGS=", 1)[1].rstrip().rstrip(";")
            self.assertEqual(len(body), n)
            self.assertEqual(json.loads(body)["v"], 1)


if __name__ == "__main__":
    unittest.main()
