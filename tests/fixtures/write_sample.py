"""Regenerate data/sample_graph.js from the synthetic fixture (used by viewer.html until the
real Minneapolis build exists). Run from the repository root: python3 tests/fixtures/write_sample.py"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "tools"))
sys.path.insert(0, HERE)

import build_osm  # noqa: E402
from osm_fixture import make_fixture  # noqa: E402

osm, bbox = make_fixture()
graph, _ = build_osm.build(osm, bbox, label="Synthetic test network")
graph["attribution"] = "Synthetic test data (not real streets)"
out = os.path.join(HERE, "..", "..", "data", "sample_graph.js")
build_osm.write_js(graph, out)
print("wrote", os.path.normpath(out))
