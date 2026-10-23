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

## Run locally

```
python3 -m http.server 8000
```

Open http://localhost:8000. Source-app regression suite (slow, several minutes):

```
node tests/simulation.cjs
```
