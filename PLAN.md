# PubTrans MPLS — phased build plan

Goal: port the [pubtrans_15_minute_city](https://github.com/jsherman999/pubtrans_15_minute_city)
autonomous-transit simulation (source commit `60774088fd727f49125c9bb2e979839fe8b3be2c`) from its
generated 6 × 6 grid onto the real street network of **downtown Minneapolis plus the University of
Minnesota East and West Bank campuses**, then use it to model auto-routed SDEV (self-driving electric
vehicle) shuttle traffic when public transit and most private vehicles are replaced by SDEV shuttles.

The map must be street-accurate, open with the entire study area in view, and zoom/pan down to
individual streets.

## Ground rules

- **Runtime stays dependency-free.** Plain HTML + vanilla JS + Canvas, served by GitHub Pages.
  No bundler, no npm install, no external map tiles, no backend.
- **Geography comes from an offline build step.** Python scripts in `tools/` (standard library only)
  fetch OpenStreetMap data once, process it, and write compact `data/*.js` files that are committed.
  The page loads them with `<script src>` so it still works from `file://` and on Pages.
- **Raw downloads are not committed** (`data/raw/` is gitignored). Processed outputs are.
- **Every phase ends green:** its own tests pass, the page loads without console errors, and the
  phase's exit criteria below are checked off in this file.
- **Attribution:** street and building data © OpenStreetMap contributors (ODbL). Census data
  (LEHD LODES, decennial/ACS) is public domain. Credit both in the UI footer and README.

## Study area

| | |
|---|---|
| Data bounding box | S 44.9600, W −93.2920, N 44.9970, E −93.2150 (≈ 6.1 km × 4.1 km) |
| West Bank / downtown | North Loop, Warehouse District, Downtown West/East, Loring Park, Elliot Park, Cedar-Riverside, UMN West Bank |
| East Bank | Nicollet Island/East Bank, Marcy-Holmes, Dinkytown, UMN East Bank, Stadium Village |
| Edges | Roads crossing the box edge become **portals** (off-map entries/exits), as the source app does for its interstate |

The box is a parameter of `tools/build_osm.py` and can be widened later without code changes.

## Phases

### Phase 0 — Bootstrap ✅
- Import the source app unchanged (`index.html`, `tests/simulation.cjs`, `ARCHITECTURE.md`),
  keep its README as `docs/SOURCE_README.md`, add this plan, `.nojekyll`, `.gitignore`.
- Exit: repo builds and serves exactly like the source; plan committed.

### Phase 1 — Street-network pipeline (`tools/build_osm.py`) ✅ code / ⏳ real data
- Fetch drivable ways from Overpass for the box (+ buffer), or read a saved raw file.
- Filter: drop `access`/`motor_vehicle=no|private`, parking aisles, driveways, drive-throughs.
  Keep **transit-only streets** (Nicollet Mall, Washington Ave transitway, etc.) as `psvOnly`
  links: usable by SDEV shuttles, not by remaining private cars.
- Per link: direction (oneway yes/-1, motorways, roundabouts), speed (`maxspeed` or class default,
  Minneapolis 20/25 mph defaults), lanes per direction, road class, bridge/tunnel flags, name.
- Simplify to a topological graph (intersections, dead ends, signals, stops, attribute changes)
  with each link carrying its polyline geometry, so routing works on thousands — not tens of
  thousands — of nodes while drawing stays street-accurate.
- Clip ways at the box edge, creating portal nodes. Keep the largest strongly connected
  component, treating all portals as connected through the outside world.
- Traffic control: `traffic_signals` nodes clustered (≤ 30 m) into controllers, each approach given
  a phase group (0/1) from the controller's dominant axis; `highway=stop` mapped to the approach it
  governs (OSM `direction` tag, else toward the nearer intersection).
- Output `data/mpls_graph.js` (format in `docs/DATA_FORMAT.md`) and a validation report
  `data/mpls_graph.report.json` (counts, km by class, dropped components, bridges by name,
  portals, psv-only streets).
- Tests: `python3 -m unittest discover -s tests -p "test_*.py"` against a synthetic OSM fixture.
- Exit: real build run; report shows every expected Mississippi road bridge in the box, the
  downtown one-way pairs, Nicollet Mall as psv-only, and < 2 % of link length dropped by SCC pruning.

### Phase 2 — Street map view (`viewer.html`)
- Standalone viewer that loads `data/mpls_graph.js`: fits the whole area on load and on resize
  until the user moves the map; wheel/pinch zoom around the pointer; drag to pan; Fit button.
- Level of detail: service roads/alleys hidden when zoomed out; names, signals, stops, one-way
  arrows and portals appear as you zoom in; each road class batched into one path per frame.
- Tap/click a street to inspect name, class, speed, lanes, one-way, bridge, psv-only.
- Light/dark aware; device-pixel-ratio-correct canvas; same coordinate conventions the sim will use.
- Exit: whole area visible on a phone at load; smooth pan/zoom; street inspection works.
  This canvas/transform code becomes the sim's map layer in Phase 3.

### Phase 3 — Engine port onto the real graph
- Replace grid assumptions: `GRID_N`, `nodeColRow`, `nodeId(c,r)`, `BUILDINGS{col,row}`, the
  generated suburbs/cul-de-sacs, Juniper Park & Ride and the 100 m block constants.
- **Directed links** replace `edgeKey(a,b)` + `oneWay`; claims, following and closures become
  per-direction. Positions interpolate along link polylines (`pointAlong(link, s)`).
- **Routing:** binary-heap A* (straight-line distance / max speed heuristic) replaces the O(n²)
  Dijkstra; `kShortest` keeps the ban-edge approach; route cache keyed by (from,to,congestion epoch).
- **Signals:** controllers drive phase groups from Phase 1 instead of horizontal/vertical tests;
  links internal to a controller cluster never stop. Stop signs from mapped approaches.
- **psv-only links** routable by fleet shuttles/buses, not by human-driven cars.
- One map view (Phase 2) replaces the seven fixed views; vehicle picking inverts its transform.
- Depots at real parking ramps / surface lots (configurable list of nodes).
- Port `tests/simulation.cjs` invariants to the real graph (legal moves only, capacity, completion).
- Exit: 300+ vehicles run at 20× on a mid-range phone; no illegal moves in the regression run.

### Phase 4 — Capacity and congestion
- Per-link capacity from lanes × class saturation flow; queues spill back across links; signal
  approaches discharge at saturation flow during green.
- Congestion cost moves from "claims on an edge" to a volume/capacity (BPR-style) delay.
- Chokepoint panel: river bridges, freeway ramps and portals with live load and queue length.
- Exit: congestion forms and clears plausibly at known pinch points in a seeded AM peak.

### Phase 5 — Demand model (`tools/build_demand.py` → `data/mpls_demand.js`)
- Zones: census blocks (or block groups) clipped to the box, each snapped to nearby street nodes.
- Residents by block (decennial census / ACS), jobs by block (LEHD LODES WAC), UMN class-change
  pulses on both banks, hospital shifts (Hennepin Healthcare), retail/errand trips.
- Inbound commuters enter at portals weighted by approach volumes (I-94, I-35W, I-394, Hwy 55,
  Hiawatha, University/Washington/Hennepin/Central, etc.).
- Time-of-day profiles with hybrid-work day-of-week factor; event surges (U.S. Bank Stadium,
  Target Field, Target Center, Huntington Bank Stadium).
- Agent sampling ratio 1:N (default 1:20) with every reported metric scaled back to full size.
- Exit: daily totals within ±10 % of targets (~45k downtown residents, ~200k jobs at ~75 % daily
  presence, UMN population) and a sensible AM/PM shape.

### Phase 6 — SDEV scenario and fleet at scale
- Controls: share of remaining private vehicles, transit replaced (on/off), pooling level,
  fleet size by vehicle type (4-seat, 8-seat, 20-seat), depots.
- Dispatch scaling: spatial hash for nearest-vehicle search, bounded candidate sets, idle
  rebalancing toward forecast demand.
- Optional EV state: battery, charging at depots, charge-time penalty.
- Exit: a full AM peak at 1:20 runs at ≥ 10× on desktop; fleet-size sweep finds the size that
  meets a target average wait.

### Phase 7 — Buildings and Driver POV (`tools/build_buildings.py` → `data/mpls_buildings.js`)
- OSM footprints with `height` / `building:levels`; simplified, clipped, quantized.
- Top-down footprints at higher zoom; POV extrudes footprints with distance culling and LOD.
- Hand-built designs only for landmarks (U.S. Bank Stadium, IDS Center, Target Center,
  Northrop, Coffman Union, Huntington Bank Stadium).
- Exit: POV holds frame rate on a phone downtown.

### Phase 8 — Metrics, export and headless runs
- VMT, VHT, deadhead %, occupancy, wait/ride distributions, bridge loads, fleet utilization.
- CSV export; seeded headless runner in Node (`tools/run_scenario.cjs`) for scenario sweeps.
- Exit: a sweep of fleet sizes produces a CSV and a summary chart.

### Phase 9 — Polish and publish
- README/ARCHITECTURE rewrite, attribution footer, mobile layout pass, GitHub Pages.

## Performance budget (targets)

| Item | Target |
|---|---|
| Graph after simplification | ≤ 8,000 nodes, ≤ 12,000 directed links |
| `data/mpls_graph.js` | ≤ 1 MB |
| Single route (A*) | ≤ 3 ms on a mid-range phone |
| Map frame, whole area | ≤ 8 ms (one batched path per road class) |

## Open decisions

1. Keep light rail (Green/Blue Line) as an optional mode on real alignments, or drop rail entirely
   for the "all transit replaced" scenario? (Plan assumes optional, off by default.)
2. Default agent sampling ratio (1:20 assumed).
3. Whether remaining private vehicles may use bus-only lanes (assumed no).
4. Depot locations (assumed: a handful of existing parking ramps, configurable).

## Progress log

| Phase | Status | Notes |
|---|---|---|
| 0 | done | Source imported unchanged at `60774088`. |
| 1 | code done | Pipeline + fixture tests pass. Needs one real run with network access to Overpass. |
| 2–9 | not started | |
