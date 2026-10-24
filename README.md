# PubTrans MPLS

Autonomous SDEV (self-driving electric vehicle) shuttle simulation on the real street network of
downtown Minneapolis and the University of Minnesota East and West Bank campuses.

Adapted from [pubtrans_15_minute_city](https://github.com/jsherman999/pubtrans_15_minute_city)
(source commit `60774088fd727f49125c9bb2e979839fe8b3be2c`). The original grid app is kept
unchanged at [`source/index.html`](source/index.html); its documentation is in
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

## Street map viewer

`viewer.html` draws the street network: it opens with the whole area in view; drag to pan,
scroll or pinch to zoom, tap a street for its details (speed limit, lanes, one-way, shuttle-only,
bridge, OSM way). If `data/mpls_graph.js` is missing it falls back to a small synthetic test
network from `data/sample_graph.js`.

## Simulation

`index.html` runs the shuttle simulation on the real streets: sedans, shuttles and buses
dispatched from five parking-ramp depots to riders' scheduled trips (placeholder homes, jobs,
schools, groceries and hubs until the census/jobs demand model), with pooling and on-the-way
ride sharing, private traffic and freeway through-traffic entering at the map edge, signals that
discharge at lane capacity, congestion that routes and drivers avoid, police/fire closures and
breakdowns. The Chokepoints panel tracks the river bridges, freeway ramps and map-edge entries. Drag, scroll or pinch the map; tap a vehicle to
see its riders and route (and follow it), or a place to see who is waiting. The panel (a bottom
sheet on phones) has playback speed, fleet and demand controls, live metrics and an event log.

## Run locally

```
python3 -m http.server 8000
```

Open http://localhost:8000 for the simulation, http://localhost:8000/viewer.html for the street
map, or http://localhost:8000/source/index.html for the original grid app.

In the street viewer, tap **Plan a route**, then a start and an end, to compare the fastest
private-car route with the fastest shuttle route (shuttles may also use transit-only streets and
contraflow lanes).

## Tests

```
python3 -m unittest discover -s tests -p "test_*.py"   # street pipeline
node tests/viewer.test.cjs                             # decoder and street viewer
node tests/routing.test.cjs                            # router, signals, 7,000-node benchmark
node tests/motion.test.cjs                             # vehicle motion, up to 3,400 vehicles
node tests/sim.test.cjs                                # engine on the real network
node tests/congestion.test.cjs                         # capacity, congestion, AM peak
node tests/page.test.cjs                               # simulation page, headless
node tests/simulation.cjs                              # original grid app (slow, ~2 minutes)
```
