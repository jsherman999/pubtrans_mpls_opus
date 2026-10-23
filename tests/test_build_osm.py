"""Tests for tools/build_osm.py. Run: python3 -m unittest discover -s tests -p "test_*.py" """

import math
import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
sys.path.insert(0, os.path.join(HERE, "fixtures"))

import build_osm as b  # noqa: E402
from osm_fixture import make_fixture  # noqa: E402


def decode(graph):
    """Python mirror of src/graph.js decoding, for assertions."""
    u = graph["unitsPerMeter"]
    nx, ny = graph["nodes"]["x"], graph["nodes"]["y"]
    L = graph["links"]
    shapes = graph["shapes"]
    links = []
    off = 0
    for i in range(len(L["a"])):
        a, bb = L["a"][i], L["b"][i]
        px, py = nx[a], ny[a]
        pts = [(px / u, py / u)]
        for _ in range(L["shp"][i]):
            px += shapes[off]
            py += shapes[off + 1]
            off += 2
            pts.append((px / u, py / u))
        pts.append((nx[bb] / u, ny[bb] / u))
        links.append({k: L[k][i] for k in L} | {"pts": pts, "nameStr": graph["names"][L["name"][i]]})
    assert off == len(shapes)
    return links


def near(pts, x, y, tol=0.6):
    return any(math.hypot(px - x, py - y) <= tol for px, py in pts)


class TagParsing(unittest.TestCase):
    def test_speed(self):
        self.assertAlmostEqual(b.parse_speed_kph({"highway": "primary", "maxspeed": "25 mph"}), 40.2, places=1)
        self.assertEqual(b.parse_speed_kph({"highway": "primary", "maxspeed": "40"}), 40.0)
        self.assertAlmostEqual(b.parse_speed_kph({"highway": "residential", "maxspeed": "none"}), 32.2, places=1)
        self.assertAlmostEqual(b.parse_speed_kph({"highway": "motorway"}), 88.5, places=1)

    def test_oneway(self):
        self.assertEqual(b.parse_oneway({"highway": "residential", "oneway": "yes"}), 1)
        self.assertEqual(b.parse_oneway({"highway": "residential", "oneway": "-1"}), -1)
        self.assertEqual(b.parse_oneway({"highway": "motorway"}), 1)
        self.assertEqual(b.parse_oneway({"highway": "primary", "junction": "roundabout"}), 1)
        self.assertEqual(b.parse_oneway({"highway": "primary"}), 0)
        self.assertIsNone(b.parse_oneway({"highway": "primary", "oneway": "reversible"}))

    def test_access(self):
        self.assertEqual(b.access_class({"highway": "residential"}), "general")
        self.assertIsNone(b.access_class({"highway": "residential", "access": "private"}))
        self.assertEqual(b.access_class({"highway": "secondary", "motor_vehicle": "no", "psv": "yes"}), "psv")
        self.assertEqual(b.access_class({"highway": "secondary", "access": "no", "motorcar": "yes"}), "general")
        self.assertEqual(b.access_class({"highway": "pedestrian", "bus": "designated"}), "psv")
        self.assertIsNone(b.access_class({"highway": "pedestrian"}))
        self.assertIsNone(b.access_class({"highway": "service", "service": "parking_aisle"}))
        self.assertIsNone(b.access_class({"highway": "footway"}))

    def test_lanes(self):
        self.assertEqual(b.parse_lanes({"highway": "primary", "lanes": "3"}, 1), (3, 0))
        self.assertEqual(b.parse_lanes({"highway": "primary", "lanes": "4"}, 0), (2, 2))
        self.assertEqual(b.parse_lanes({"highway": "primary", "lanes": "3", "lanes:forward": "2"}, 0), (2, 1))
        self.assertEqual(b.parse_lanes({"highway": "residential"}, 0), (1, 1))
        self.assertEqual(b.parse_lanes({"highway": "motorway"}, 1), (3, 0))


class Clipping(unittest.TestCase):
    def test_liang_barsky(self):
        self.assertEqual(b.liang_barsky((1, 1), (2, 2), 10, 10), (0.0, 1.0))
        self.assertIsNone(b.liang_barsky((-5, -5), (-1, -1), 10, 10))
        t0, t1 = b.liang_barsky((-10, 5), (20, 5), 10, 10)
        self.assertAlmostEqual(t0, 1 / 3)
        self.assertAlmostEqual(t1, 2 / 3)
        t0, t1 = b.liang_barsky((5, 5), (5, 20), 10, 10)
        self.assertEqual(t0, 0.0)
        self.assertAlmostEqual(t1, 1 / 3)


class FixtureBuild(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        osm, bbox = make_fixture()
        cls.graph, cls.report = b.build(osm, bbox, label="fixture")
        cls.links = decode(cls.graph)
        cls.by_name = {}
        for l in cls.links:
            cls.by_name.setdefault(l["nameStr"], []).append(l)

    def test_excluded_and_pruned(self):
        names = set(self.by_name)
        for gone in ("Private Dr", "Island Rd", "Trap St"):
            self.assertNotIn(gone, names)
        self.assertEqual(self.report["skipped_ways"].get("not drivable"), 2)
        self.assertEqual(sorted(self.report["dropped_by_connectivity"]["names"]), ["Island Rd", "Trap St"])

    def test_link_endpoints_and_lengths(self):
        nodes = self.graph["nodes"]
        u = self.graph["unitsPerMeter"]
        for l in self.links:
            self.assertNotEqual(l["a"], l["b"])
            geo = sum(math.hypot(q[0] - p[0], q[1] - p[1]) for p, q in zip(l["pts"], l["pts"][1:]))
            self.assertAlmostEqual(l["len"] / u, geo, delta=0.5)
            self.assertEqual(l["pts"][0], (nodes["x"][l["a"]] / u, nodes["y"][l["a"]] / u))

    def test_topology_is_split_at_intersections(self):
        # 1st St crosses A, B, C, D: three links between four intersections.
        self.assertEqual(len(self.by_name["1st St"]), 3)

    def test_directions(self):
        for l in self.by_name["2nd St"]:
            self.assertEqual(l["dir"], b.DIR_AB)
            self.assertEqual(l["lf"], 3)
            self.assertAlmostEqual(l["kph"], 40.2, places=1)
        for l in self.by_name["3rd St"]:
            self.assertEqual(l["dir"], b.DIR_BA | b.DIR_AB_PSV)
            self.assertEqual((l["lf"], l["lb"]), (1, 2))
        for l in self.by_name["C Ave Mall"]:
            self.assertEqual(l["dir"], b.DIR_AB_PSV | b.DIR_BA_PSV)
            self.assertEqual(self.graph["classes"][l["cls"]], "busway")
        self.assertIn("C Ave Mall", self.report["psv_only_m"])
        for l in self.by_name["A Ave"]:
            self.assertEqual(l["kph"], 40.0)

    def test_portals(self):
        portals = self.report["portals"]
        self.assertEqual(len(portals), 5)
        motorway = [p for p in portals if p["class"] == "motorway"]
        self.assertEqual(sum(p["entry"] for p in motorway), 2)
        self.assertEqual(sum(p["exit"] for p in motorway), 2)
        flags = self.graph["nodes"]["flags"]
        self.assertEqual(sum(1 for f in flags if f & b.NODE_PORTAL), 5)
        # Portals sit exactly on the box edge.
        w, h = self.report["size_m"]
        for p in portals:
            on_edge = min(abs(p["x_m"]), abs(p["x_m"] - w), abs(p["y_m"]), abs(p["y_m"] - h))
            self.assertLess(on_edge, 0.2)

    def test_loop_split(self):
        loop = self.by_name["Circle Dr"]
        self.assertEqual(len(loop), 2)
        self.assertTrue(all(len(l["pts"]) >= 3 for l in loop))

    def test_bridge(self):
        self.assertIn("B Ave", self.report["bridges_m"])
        bridged = [l for l in self.by_name["B Ave"] if l["flags"] & b.FLAG_BRIDGE]
        self.assertEqual(len(bridged), 1)
        self.assertAlmostEqual(bridged[0]["len"] / 10, 110, delta=0.5)

    def test_signals(self):
        self.assertEqual(self.report["signal_controllers"], 2)
        self.assertEqual(self.report["signalized_nodes"], 3)
        internal = [l for l in self.by_name["2nd St"] if near(l["pts"][:1], 450, 300) and near(l["pts"][-1:], 460, 300)]
        self.assertEqual(len(internal), 1)
        self.assertEqual((internal[0]["sigA"], internal[0]["sigB"]), (b.SIG_INTERNAL, b.SIG_INTERNAL))
        # At B Ave / 2nd St: eastbound 2nd St in one phase group, B Ave approaches in the other.
        east = [l for l in self.by_name["2nd St"] if near(l["pts"][-1:], 300, 300)][0]
        b_north = [l for l in self.by_name["B Ave"] if near(l["pts"][-1:], 300, 300)][0]
        b_south = [l for l in self.by_name["B Ave"] if near(l["pts"][:1], 300, 300)][0]
        self.assertIn(east["sigB"], (0, 1))
        self.assertEqual(b_north["sigB"], b_south["sigA"])
        self.assertNotEqual(east["sigB"], b_north["sigB"])
        # Departing ends of signalized nodes are not approaches.
        self.assertEqual(b_south["sigB"], b.SIG_NONE)

    def test_stop_sign(self):
        approach = [l for l in self.by_name["D Ave"] if near(l["pts"][-1:], 600, 290)][0]
        tail = [l for l in self.by_name["D Ave"] if near(l["pts"][:1], 600, 290)][0]
        self.assertTrue(approach["flags"] & b.FLAG_STOP_AT_B)
        self.assertFalse(approach["flags"] & b.FLAG_STOP_AT_A)
        self.assertFalse(tail["flags"] & (b.FLAG_STOP_AT_A | b.FLAG_STOP_AT_B))
        self.assertEqual(self.report["stop_approaches"], 1)

    def test_strong_connectivity(self):
        """Every node reaches every other node when portals are joined through the outside."""
        n = len(self.graph["nodes"]["x"])
        fwd = {i: set() for i in range(n)}
        rev = {i: set() for i in range(n)}
        for l in self.links:
            if l["dir"] & (b.DIR_AB | b.DIR_AB_PSV):
                fwd[l["a"]].add(l["b"]); rev[l["b"]].add(l["a"])
            if l["dir"] & (b.DIR_BA | b.DIR_BA_PSV):
                fwd[l["b"]].add(l["a"]); rev[l["a"]].add(l["b"])
        portals = [i for i, f in enumerate(self.graph["nodes"]["flags"]) if f & b.NODE_PORTAL]
        for p in portals:
            for q in portals:
                fwd[p].add(q); rev[q].add(p)
        self.assertEqual(len(b.bfs(0, fwd)), n)
        self.assertEqual(len(b.bfs(0, rev)), n)

    def test_output_is_valid_js(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "g.js")
            b.write_js(self.graph, path)
            with open(path, encoding="utf-8") as f:
                text = f.read()
            self.assertIn("window.MPLS_GRAPH={", text)
            self.assertIn("OpenStreetMap", text)


if __name__ == "__main__":
    unittest.main()
