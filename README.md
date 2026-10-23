# PubTrans MPLS

Autonomous SDEV (self-driving electric vehicle) shuttle simulation on the real street network of
downtown Minneapolis and the University of Minnesota East and West Bank campuses.

Adapted from [pubtrans_15_minute_city](https://github.com/jsherman999/pubtrans_15_minute_city)
(source commit `60774088fd727f49125c9bb2e979839fe8b3be2c`). The imported app still runs unchanged
from `index.html` while the port is in progress; its original documentation is in
[`docs/SOURCE_README.md`](docs/SOURCE_README.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md).

See **[PLAN.md](PLAN.md)** for the phased build plan and current progress.

Street data © OpenStreetMap contributors (ODbL).

## Build the street network

Street geometry comes from OpenStreetMap through a one-time offline build (Python 3 standard
library only). It needs network access to the Overpass API:

```
python3 tools/build_osm.py --fetch
```

This writes `data/mpls_graph.js` (loaded by the page) and `data/mpls_graph.report.json` (review
it), and saves the raw download to `data/raw/` (gitignored). Rebuild from a saved download with
`--input data/raw/osm_roads.json`. Format: [`docs/DATA_FORMAT.md`](docs/DATA_FORMAT.md).

Pipeline tests:

```
python3 -m unittest discover -s tests -p "test_*.py"
```

## Street map viewer

`viewer.html` draws the street network: it opens with the whole area in view; drag to pan,
scroll or pinch to zoom, tap a street for its details (speed limit, lanes, one-way, shuttle-only,
bridge, OSM way). Until `data/mpls_graph.js` has been built it shows a small synthetic test
network from `data/sample_graph.js`.

## Run locally

```
python3 -m http.server 8000
```

Open http://localhost:8000/viewer.html for the street map, or http://localhost:8000 for the
imported simulation (still the original grid until Phase 3).

Tap **Plan a route**, then a start and an end, to compare the fastest private-car route with the
fastest shuttle route (shuttles may also use transit-only streets and contraflow lanes).

Viewer, decoder and routing tests (the routing test also benchmarks a 7,000-node synthetic grid):

```
node tests/viewer.test.cjs
node tests/routing.test.cjs
```

Source-app regression suite (slow, several minutes):

```
node tests/simulation.cjs
```
