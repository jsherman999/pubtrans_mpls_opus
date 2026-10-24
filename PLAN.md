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

### Phase 1 — Street-network pipeline (`tools/build_osm.py`) ✅
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

### Phase 2 — Street map view (`viewer.html`) ✅
- Standalone viewer that loads `data/mpls_graph.js`: fits the whole area on load and on resize
  until the user moves the map; wheel/pinch zoom around the pointer; drag to pan; Fit button.
- Level of detail: service roads/alleys hidden when zoomed out; names, signals, stops, one-way
  arrows and portals appear as you zoom in; each road class batched into one path per frame.
- Tap/click a street to inspect name, class, speed, lanes, one-way, bridge, psv-only.
- Portal markers (205 on the real network) are hidden at whole-area zoom and grow to full size
  by street zoom, so they do not crowd the edge of the map.
- Light/dark aware; device-pixel-ratio-correct canvas; same coordinate conventions the sim will use.
- Exit: whole area visible on a phone at load; smooth pan/zoom; street inspection works.
  This canvas/transform code becomes the sim's map layer in Phase 3.

### Phase 3 — Engine port onto the real graph
Split into four steps so each lands green on its own.

**3a — Routing core (`src/routing.js`) ✅**
- Directed arcs flattened into compressed arrays; costs are seconds (length at posted speed plus
  an expected wait at signal approaches and stop signs).
- Binary-heap A* (straight-line distance at the network's top speed; exact, never overestimates)
  with plain Dijkstra available for checks. Modes: private car vs shuttle/bus (`psvOnly` links).
- Bans (Set or per-arc array), per-arc extra cost (congestion; `Infinity` closes an arc),
  no U-turns through portals unless asked.
- `kShortest`: the source app's ban-one-arc approach over a bounded sample of the best route's
  arcs, keeping alternatives that share < 80 % of their length with ones already chosen.
- LRU route cache with `invalidate()`; `routePoints` for drawing; grid-indexed `nearestNode`.
- `viewer.html` gains **Plan a route**: tap a start and an end to see the private-car and shuttle
  routes with times and distances.
- Tests: `node tests/routing.test.cjs` — A* equals Dijkstra on every pair of the fixture in both
  modes, legality (one-ways, contraflow, transit mall, portals), bans/closures, alternatives,
  cache, nearest node; benchmark on a seeded 7,000-node synthetic grid the size of the study area.
- Result: 0.46 ms per route on desktop Node (1,716 nodes settled vs 3,426 for Dijkstra); three
  alternatives 7 ms. Leaves headroom under the 3 ms phone budget.

**3b — Signal timing (`src/traffic.js`) ✅**
- Controllers alternate their two phase groups with the source app's timing (30 s green, 3 s
  transition), with deterministic per-controller offsets; `signalWait`, `canEnter`,
  `controlDelay` (stop signs hold 3 s). Cluster-internal links never stop.
- Tests (in `tests/routing.test.cjs`): no two conflicting greens, each group green 30 s per cycle,
  waits bounded, internal links never wait, stop-sign holds.

**3c — Vehicle motion on real links (`src/motion.js`) ✅**
- Vehicle state on an arc: `(arc, s, lane)`; positions from the link polyline with a per-lane
  offset to the right of travel; time-based movement at the link speed carried across short
  links, as in the source's `stepCars`.
- Per-direction lane occupancy (each lane a front-first queue, `lanes` from OSM, at least one)
  replaces `edgeKey(a,b)` claims. Car following keeps the source's 8 m gap within a lane and
  across arc boundaries along the vehicle's own route; a vehicle joins the lane with the most
  room. Leaders move before followers within a step (recursively, cycle-safe), so platoons move
  together instead of in list order.
- Controls from 3b at the stop line: red signals hold (checked at the exact time the vehicle
  reaches the line), stop signs hold 3 s, closed arcs (`setClosed`) hold traffic upstream and
  spill back across links. No control applies on a route's final arc (arrival at the curb).
- `checkRoute` refuses illegal routes (shuttle-only arcs for private cars, gaps, portal transit);
  `check()` audits lane bookkeeping, spacing, positions and legality for tests.
- `connectedCore(mode)` in `src/routing.js`: the largest set of intersections that reach one
  another without leaving the map. On the real network it is 4,855 of 5,122 (5.2 % are
  reachable only via the outside), so trips are placed in the core; freeway through-traffic
  runs portal to portal (48 freeway entry→exit routes longer than 1.5 km).
- Tests: `node tests/motion.test.cjs` — carry across short links, gaps within a link and across
  a node, red-light hold and ordered discharge, stop-sign hold, a closed approach that queues
  16 cars back across links and drains them first-in-first-out once reopened, multi-lane
  queues, legality; 300 vehicles for an hour on a signalized grid (all drain afterwards); on
  the real network 400 vehicles plus 40 freeway through-trips, then 3,400 vehicles with no
  queue wait over 2 minutes (no gridlock).
- Result: 0.08 ms per 3 s step for 400 vehicles and 0.6 ms for 3,400 on desktop Node.

**3d — Engine integration (`index.html` → real graph) ✅**
- The source app moved unchanged to `source/index.html` (its regression suite still runs against
  it); `index.html` is now the simulation on real streets. The engine is a DOM-free module,
  `src/sim.js`, seeded (no `Math.random`), so the page, the tests and later headless runs share it.
- Grid assumptions replaced: no `GRID_N`/`nodeColRow`/`nodeId(c,r)`/`BUILDINGS{col,row}`,
  suburbs, cul-de-sacs, Juniper Park & Ride or 100 m blocks. Routes are router arcs, movement is
  `src/motion.js`, signals are `src/traffic.js`.
- Ported: 3-second steps with playback repeating whole steps; 07:30 start and day rollover;
  worker/student/errand/commuter schedules; request queue; dispatch phases (origin sweeps under
  backlog, sedan carpools, same-destination pools, singles) with the nearest idle vehicle instead
  of the first; multi-stop trips with one rider boarding per step; idle return to the nearest
  depot; on-the-way ride sharing (≤ 400 m extra per trip at 100 %, stop order and per-stop budget
  kept, capacity over the whole itinerary, four vehicles per step); police/fire incidents that
  close the responder's arrival direction (5/10 min) with detours for everyone else; vehicle
  trouble with a recovery vehicle that keeps riders' boarding times; private traffic; live fleet
  and population changes with retiring vehicles; passenger metrics as in the source.
- Real-network specifics: trips start and end only in the connected core (3c); private visitors
  enter at a portal, park at a place, then leave through a portal; freeway through-traffic runs
  edge to edge on the 48 freeway entry→exit routes. Fleet vehicles may use shuttle-only streets,
  private cars may not.
- Placeholder demand: 130 seeded places on curbside street nodes (homes weighted by units,
  employers, schools, groceries, transit hubs), 2,500 people. Depots at five approximate parking
  ramps (ABC, Leamington, Downtown East, UMN West Bank, UMN East Bank); police/fire base near
  City Hall. Phase 5 replaces the places with census/LODES zones.
- Routing at scale: one backward route tree per stop (`router.treeTo`/`pathTo`, built on first
  use) answers every trip into a place, depot, base or exit portal, and ride-sharing leg lengths
  come from the same trees with straight-line branch-and-bound, so the AM peak runs about 2 % of
  the point-to-point searches it would otherwise need.
- Map: the viewer's canvas code is now `src/mapview.js`, shared by `viewer.html` and
  `index.html`. One map view with vehicles (dots zoomed out, to-scale shapes in their lanes up
  close, private traffic drawn beneath the fleet), per-approach signal heads, closures, places
  with waiting counts, depots with parked counts; tap a vehicle (route, stops, riders, follow) or
  a place. Wide screens get a side panel, phones a bottom sheet; the map fits clear of both.
- Not ported (later phases or dropped): Driver POV, building designs and the seven views
  (Phase 7); rail (open decision 1); interactive trip planning, narration and scripted
  obstacles; neighborhood-dedicated buses (buses now take sweeps and large pools); the
  claim-count "gridlock" score and claim-weighted routing (Phase 4 adds volume/capacity delay);
  stadium/event surges (Phase 5).
- Tests: `node tests/sim.test.cjs` (placement in the core, a 2.5 h seeded regression run with
  audits of legality, gaps, capacity and a ledger that every rider is in exactly one place,
  determinism at 1× vs 20× and across reset, dispatch phases, ride sharing, emergencies,
  breakdown recovery, private and through traffic, live fleet changes) and
  `node tests/page.test.cjs` (the page headless: fits a phone, 20× frames, picking, follow,
  every control).
- Result: peak 476 vehicles on the road (≈ 860 in the simulation including parked visitors).
  One 20× frame (20 steps) of simulation: 4.4 ms average over the AM peak in Node and 12 ms
  median in desktop Chrome with drawing about 1–2 ms more (Apple-silicon desktop). Not yet timed
  on a phone: at a typical 4–5× slower mid-range phone that is roughly 50–70 ms of the 100 ms
  frame, so the exit target looks reachable but is unverified.

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
| 1 | done | Real build committed (`62a31dd`): 5,327 nodes, 6,614 links, 11,007 arcs, 459 km, 541 KB; all Mississippi road bridges in the box (Plymouth, Hennepin, 3rd Ave, I-35W, 10th Ave, Washington Ave, I-94, Franklin); downtown one-way pairs; Nicollet Mall and the Washington Ave transitway shuttle-only; 1.07 % of length dropped by SCC pruning. |
| 2 | done | `viewer.html` shows the real network. Portal markers hidden/shrunk when zoomed out. |
| 3a | done | Router + viewer route preview; A* 0.46 ms/route on a 7,000-node grid (0.12 ms on the real network). |
| 3b | done | Signal timing and stop-sign holds. |
| 3c | done | `src/motion.js`: lanes, 8 m following across links, signals, stop signs, closures; connected core. 400 vehicles 0.08 ms/step. |
| 3d | done | `index.html` runs the ported engine (`src/sim.js`) on real streets; source app kept at `source/index.html`; map layer shared as `src/mapview.js`. Peak 476 vehicles on the road; 20× frame ≈ 12 ms sim in desktop Chrome. Phone timing still to measure on a device. |
| 4–9 | not started | |
