"""Synthetic Overpass response exercising every rule in tools/build_osm.py.

Not real Minneapolis streets. Coordinates are laid out in local meters (x east, y south from the
north edge) inside FIXTURE_BBOX and converted to lat/lon with the build script's projection.

    y=60..150   Circle Dr (closed loop) hanging off A Ave's north end
    y=150       1st St  two-way residential, A..D Ave
    y=300       2nd St  one-way east, primary, 3 lanes, 25 mph; signals at B Ave and a
                        two-node signal cluster at C Ave (450 and 460)
    y=450       3rd St  one-way west (oneway=-1), 2 lanes, bus contraflow (oneway:psv=no)
    x=150       A Ave   two-way secondary
    x=300       B Ave   two-way; bridge south of 3rd St; leaves the box at the south edge
    x=450       C Ave   transit mall (highway=pedestrian + bus=designated)
    x=600       D Ave   two-way tertiary, stop sign 10 m before 2nd St (southbound approach)
    y=600/620   I 99    motorway carriageways crossing the box west-east, with ramps to A Ave
    excluded:   Private Dr (access=private), a parking aisle, Island Rd (disconnected),
                Trap St (one-way dead end)
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "tools"))
from build_osm import Projection  # noqa: E402

FIXTURE_BBOX = (44.9700, -93.2700, 44.9760, -93.2600)


def make_fixture():
    proj = Projection(FIXTURE_BBOX)
    nodes = {}
    elements = []
    node_tags = {
        (300, 300): {"highway": "traffic_signals"},
        (450, 300): {"highway": "traffic_signals"},
        (460, 300): {"highway": "traffic_signals"},
        (600, 290): {"highway": "stop"},
    }

    def nid(x, y):
        key = (x, y)
        if key not in nodes:
            nodes[key] = 1000 + len(nodes)
            lat = proj.n - y / proj.m_per_deg_lat
            lon = proj.w + x / proj.m_per_deg_lon
            el = {"type": "node", "id": nodes[key], "lat": round(lat, 8), "lon": round(lon, 8)}
            if key in node_tags:
                el["tags"] = node_tags[key]
            elements.append(el)
        return nodes[key]

    way_id = [500]

    def way(points, **tags):
        way_id[0] += 1
        elements.append({"type": "way", "id": way_id[0], "nodes": [nid(*p) for p in points], "tags": tags})
        return way_id[0]

    # Grid
    way([(150, 150), (300, 150), (450, 150), (600, 150)], highway="residential", name="1st St")
    way([(150, 300), (300, 300), (450, 300), (460, 300), (600, 300)],
        highway="primary", name="2nd St", oneway="yes", lanes="3", maxspeed="25 mph")
    way([(150, 450), (300, 450), (450, 450), (600, 450)],
        highway="secondary", name="3rd St", oneway="-1", lanes="2", **{"oneway:psv": "no"})
    way([(150, 150), (150, 300), (150, 450)], highway="secondary", name="A Ave", maxspeed="40")
    way([(300, 150), (300, 300), (300, 450)], highway="tertiary", name="B Ave")
    way([(300, 450), (300, 480), (300, 560)], highway="tertiary", name="B Ave", bridge="yes")
    way([(300, 560), (300, 700)], highway="tertiary", name="B Ave")
    way([(450, 150), (450, 300), (450, 450)], highway="pedestrian", name="C Ave Mall", bus="designated")
    way([(600, 150), (600, 290), (600, 300), (600, 450)], highway="tertiary", name="D Ave")
    # Closed loop
    way([(150, 150), (100, 100), (150, 60), (200, 100), (150, 150)], highway="residential", name="Circle Dr")
    # Motorway pair crossing the box, with ramps
    way([(-200, 600), (200, 600), (1000, 600)], highway="motorway", name="", ref="I 99", lanes="3")
    way([(1000, 620), (100, 620), (-200, 620)], highway="motorway", name="", ref="I 99", lanes="3")
    way([(200, 600), (170, 520), (150, 450)], highway="motorway_link")
    way([(150, 450), (120, 540), (100, 620)], highway="motorway_link")
    # Excluded or pruned
    way([(600, 450), (700, 500)], highway="residential", name="Private Dr", access="private")
    way([(450, 150), (520, 100)], highway="service", service="parking_aisle")
    way([(700, 50), (750, 80)], highway="residential", name="Island Rd")
    way([(600, 150), (700, 100)], highway="residential", name="Trap St", oneway="yes")

    return {"version": 0.6, "generator": "pubtrans fixture", "elements": elements}, FIXTURE_BBOX
