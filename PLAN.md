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

### Phase 4 — Capacity and congestion ✅
- Per-lane capacity from OSM lanes × road-class saturation flow (2,100 cars/h/lane on freeways
  down to 1,200 on service roads), × the green share (30 of 66 s) at signals
  (`src/motion.js` `SAT_FLOW`, `src/congestion.js`).
- Stop lines discharge at saturation flow: one car per headway per lane (2.4 s on a residential
  street), with 2 s start-up lost time for the first car away from a red. A car now waits for
  green inside its 3 s step instead of until the next step.
- Queues spill back across links (3c). New in 4: **merges take turns** (the lane or curb that has
  waited longest to join an arc holds a claim; without it a freeway lane starved for 50 minutes
  behind a busier one), and **keep clear** (no stopping inside arcs shorter than 25 m, the
  insides of intersections, unless there is room beyond). Together they keep oversaturated
  traffic from locking up: 3,400 cars on free-flow routes queue heavily at the freeway ramps
  but all drain.
- Sampled private traffic: each private car on the map stands for 4 real cars (`pcu`), taking
  4 × 8 m of lane and 4 headways at stop lines and drawn as 4 cars nose to tail. Demand is in
  real cars: 5,000 an hour across the map edge off-peak, 14,500 at 08:00 (AM commuters to jobs
  and schools who leave between 16:15 and 18:45, visitors, freeway through-traffic), entering and
  leaving in proportion to the edge road's capacity. Parked cars leave the active list.
- Congestion cost replaces route claims: per arc, inflow smoothed over 5 min and cars queued,
  turned into extra delay = BPR (free time × 0.15 × (v/c)⁴) + queued cars beyond one green ÷
  discharge rate; under 6 s counts as zero. Routes search around congestion only when the
  free-flow route would lose more than 20 s and 10 % of its time, so most routing stays on the
  cached trees. Drivers stuck in a queue for a minute with congestion still ahead look for a
  faster way (four per step, at most every two minutes each).
- Chokepoint panel and map: all eight Mississippi road bridges (Plymouth, Hennepin, 3rd Ave,
  I-35W, 10th Ave, Washington Ave, I-94 Dartmouth, Franklin), the four busiest of 75 freeway
  ramps and of 173 map-edge entries, each with flow (cars/h), share of capacity and queue; tap to
  find it on the map. A congestion layer draws slow (amber) and jammed (red, ≥ 1 min) directions.
- Tests: `node tests/congestion.test.cjs` (capacities; an overloaded signal approach builds 91 s
  of delay; congestion-aware routing diverts 49 % and cuts the queue from 151 to 19 cars, then
  clears; the eight bridges resolve in both directions; the seeded AM peak below) plus motion
  tests for saturation flow, start-up lost time, pcu agents, merge turns and keep-clear.
- Result (seed 1): the worst queue, 121 cars, forms at 08:05 at the I-35W exit to Southeast
  11th Avenue / University Avenue (the UMN exits), backing onto the I-35W bridge, which carries
  up to 5,200 cars/h; East Hennepin and the 10th Ave Bridge approach also queue. Network queueing
  falls from 178 cars in the rush to 20 after 10:00, chokepoint queues to ≤ 10 cars, congested
  segments from 34 to 1; 124 reroutes. Simulation cost at the peak (≈ 700 agents on the road
  standing for 2,200 private cars plus the fleet): about 11 ms per 20× frame in Node and 22 ms in
  desktop Chrome, roughly double Phase 3d. When a frame overruns, playback slows rather than
  skipping steps.

### Phase 5 — Demand model (`tools/build_demand.py` → `data/mpls_demand.js`, `src/demand.js`) ✅
- Inputs (public, fetched by `python3 tools/build_demand.py --fetch`): 2020 Census blocks
  (TIGERweb: population, housing units, internal points; the Census API now needs a key, the
  TIGERweb layer does not), 2020 tracts (home locations of commuters), LEHD LODES 2023 for
  Minnesota (WAC jobs by sector, OD main + aux home→work flows), OpenStreetMap parking (877 ramps
  and lots, 172k spaces, mostly estimated from footprints). Raw downloads in `data/raw/demand/`.
- Zones: the 822 inhabited or working census blocks in the box, snapped at run time to the
  nearest curbside node in the connected core (~720 places).
- Generators (`src/demand.js`), all at full scale then sampled:
  - **Commuters** from LODES OD: inside the box (10,296 block pairs), inbound by home direction
    (16 sectors; enter at map-edge roads in that direction weighted by their capacity), outbound;
    start times by job sector; health-care jobs at HCMC and the M Health Fairview campuses keep
    7/15/23 h shifts; daily presence by sector and weekday (hybrid office work: 80 % Tue–Wed,
    52 % Fri, ~8 % weekends; other work ~90 %).
  - **UMN**: 38,000 students on the Minneapolis campus on a weekday (assumption), 45 % living in
    the box near campus, the rest arriving from outside; 6 % cross between banks every hour
    09:00–16:00. Staff come from LODES (education jobs on campus).
  - **Errands** by residents (0.4 tours/day, local: distance decay 1.2 km) and **visitors** from
    outside (1.2 per retail or food-service job), toward shops and restaurants.
  - **Events**: arrivals in the 90 minutes before the start, a surge at the end; the page offers
    Twins, Vikings, Timberwolves and Gophers games (Twins 19:10 on the default Wednesday).
  - Modes: trips under 800 m inside the box are walked (counted, not simulated); the rest are
    today's car or transit trips (car shares by purpose, e.g. 55 % of inbound commuters).
    Transit riders take SDEV shuttles; **Car trips kept** (default 50 %, Phase 6 lever brought
    forward) keeps that share of today's car trips as cars and moves the rest to shuttles.
    Riders from outside board at an **edge hub**, the curb nearest their map-edge road.
- In the engine: a Census day starts at 05:30; drivers into a zone park at a ramp or lot within
  600 m (the driver walks the rest) and leave from one; residents keep cars at home. **Sampling
  1:20** by default (1:10 selectable): every rider, shuttle and car agent stands for 20, and
  every count shown is scaled back. Road effects: agents take 20 × the stop-line headway but at
  most 4 cars of lane space (an agent 160 m long locked the downtown grid by length alone;
  large models scale storage less than flow for small samples, as MATSim does).
- Made necessary by real demand: **signal green splits** by approach capacity (arterials get up
  to 45 of 60 s); **gridlock relief** (SUMO-style: a car unable to move for 5 minutes because
  the road beyond is full jumps ahead along its route; counted); compact route trees (11 KB) in
  a 1,600-tree cache.
- Tests: `python3 -m unittest` (`tests/test_build_demand.py`: zones inside the box, job groups,
  internal/inbound/outbound flows, directions incl. out-of-state, downtown subset, parking
  estimates, output round trip) and `node tests/demand.test.cjs` (totals against the data and
  targets, sampling, AM/PM shape, day of week, events, and a Census-demand morning in the
  engine); the page test now also boots the page with Census demand.
- **Exit check** (`tests/demand.test.cjs`):
  | Target (plan) | Model | |
  |---|---|---|
  | ~200k jobs | 226,448 LODES 2023 jobs in the box (155,556 in downtown) | +13 % (within the test's 15 %) |
  | ~75 % daily presence | 79 % on an average weekday; 193,317 jobs present on Wednesday | within 10 % |
  | UMN population | 61,275 on the Minneapolis campus on Wednesday (38,000 students, assumed, + 23,275 staff present) | input assumption |
  | ~45k downtown residents | **35,696** (2020 Census, downtown outline); 114,464 in the whole box | **−21 %: missed.** The 45k came from post-2020 estimates of a wider downtown; the model keeps the Census count |
  | AM/PM shape | Wednesday: 720,800 person trips; peaks 08:00–09:00 (92,100, 5× the 11:00 hour) and 16:00–17:00 (86,200, 3.6× noon); inbound commuters 06:30–09:30 in, 15:00–19:00 out; Friday −21 % commutes, Sunday errands +30 % | ✓ |
  | Sampled totals | 1:10 and 1:20 agents × weight within 10 % per purpose, 2 % overall | ✓ |
- Result in the engine (seed 2, Wednesday, 05:30–09:00, 1:20): 76,000 riders delivered, 25 %
  of motorised trips by car, up to 7,700 cars on the road, 43 gridlock jumps in 9,900 agent
  trips, nothing unrouted. The default fleet (60 sedans, 260 shuttles, 60 buses agents =
  7,600 vehicles) is fully busy by 08:00 and waits grow to 15+ minutes: sizing it is Phase 6.
  Desktop Chrome at 08:15: about 22 ms of simulation per 20× frame (33 ms with drawing).

### Phase 6 — SDEV scenario and fleet at scale ✅
- Scenario controls (page and engine): **car trips kept** (Phase 5), **today's transit riders
  ride shuttles** on/off (off: they are counted as transit, not simulated), **pooling** 0–100 %
  (0: one rider per trip; otherwise riders from the same area to the same area share, areas
  pooling% × 6 m = 600 m at 100 %, plus on-the-way pickups up to pooling% × 4 m of detour),
  fleet size by type (4-, 8-, 20-seat steppers in real vehicles), **depots** (switch each open
  or closed, open a new one at any place; kept across Reset day; the last cannot close),
  **electric fleet** on/off, **rebalancing** on/off.
- Pooling by area at both ends: pooling only by destination (the source's rule) made shuttles
  tour pickups kilometres apart and pushed waits past 30 minutes on the real map.
- Dispatch scaling: free vehicles indexed in a 400 m grid per type with ring search (same answer
  as a full scan, tested); request-driven ride sharing — the eight oldest waiting riders each
  ask the four nearest moving shuttles or buses — plus two vehicles in turn scanning the queue;
  dispatch checks legs with route-tree lengths instead of full searches; one en-route reroute
  per step.
- Rebalancing: every 5 minutes, idle vehicles move toward 800 m areas where the next 30 minutes
  should bring more pickups than one idle vehicle per four. The forecast is another seeded
  realisation of the day (what history would say), not the actual requests. With it, the
  nearest free shuttle is 294 m from the riders of the next half hour at 06:45 (1,023 m
  without). Idle vehicles wait 30 minutes before heading to a depot.
- Electric fleet: battery and use per type (sedan 60 kWh, 0.18 kWh/km; shuttle 110 kWh,
  0.32 kWh/km; bus 400 kWh, 1.3 kWh/km), charging at depots at 50/150/150 kW from below 25 %
  to 80 %, no new riders below 15 %, full batteries each morning. Unlimited chargers per depot
  for now. Morning service rarely needs a charge (fleet at 90 % by 10:00).
- Fleet-size sweep: `node tools/fleet_sweep.cjs` (real-vehicle totals split 10 % sedans,
  60 % shuttles, 30 % buses by default; 05:30–10:00 Wednesday; 1:5 sampling; options for mix,
  car share, keeping transit, target wait). See **Fleet sizing, revisited** below for the
  current results; the first sweep (19,000 vehicles for a 13.5-minute wait at 1:20) was wrong.
- Tests: `node tests/fleet.test.cjs` (grid search vs full scan, pooling on/off and compact pools,
  transit and car-share levers, depots, battery use/charging/dispatch cut-off, rebalancing, AM
  peak speed, a two-size sweep that picks the default).
- **Fleet sizing, revisited** (after the Phase 7 review). The 19,000 figure was inflated by
  sampling: at 1:20 a rider agent pools only with other agents, so pooling sees demand 20×
  sparser than reality, and moving vehicles carried 0.4–2.6 riders. Fixes: riders and the fleet
  are sampled 1:10 on the page and 1:5 in the sweep while private cars stay 1:20 (cars are
  thinned per tour so both legs agree); dispatch drops assigned vehicles from its grid (a long
  queue no longer rescans every cell); rebalancing moves only vehicles idle 5 minutes, one per
  six expected pickups, at most 10 % of idle vehicles per round. At 1:5 the peak load of a
  moving vehicle rises to about 3.9 riders. The sweep then shows the real constraint
  (`data/fleet_sweep.json`, `data/fleet_sweep_keep_transit.json`):
  | Scenario | Fleet | Avg wait | Waiting at 10:00 | Delivered by 10:00 | Riders/vehicle-hour |
  |---|---|---|---|---|---|
  | Transit **and** half of car trips → SDEV | 4,000 | 47.0 min | 73,400 | 82,500 | 4.6 |
  | | 8,000 (default) | 30.6 min | 35,000 | 100,700 | 2.8 |
  | | 12,000 | 23.5 min | 10,100 | 105,500 | 2.0 |
  | | 16,000 | 23.5 min | 5,300 | 105,800 | 1.5 |
  | Transit kept, half of car trips → SDEV | 2,000 | 21.1 min | 1,500 | 49,800 | 5.5 |
  | | 3,000 | 12.6 min | 0 | 54,300 | 4.0 |
  | | **4,000** | **8.7 min** | 0 | 56,000 | 3.1 |
  | | 5,000 | 6.8 min | 0 | 56,800 | 2.5 |
  With all transit replaced, peak requests reach 76,000 people an hour; deliveries level off near
  105,000 by 10:00 from about 10,000 vehicles because the streets are full (most agents on the
  road are queued, rides take 25 minutes), so no van fleet meets a 15-minute average and adding
  vehicles beyond ~10,000 only adds congestion. Keeping today's transit and moving half of the
  car trips to SDEVs needs about **4,000 vehicles** for an 8.7-minute average wait. The page
  defaults to 8,000 vehicles in the all-transit scenario (where deliveries level off).
- **Exit:** AM peak 07:00–10:00 with the default (1:10, 8,000 vehicles): 20 ms average (p95 26 ms)
  per 10 steps in Node, about 40 ms in desktop Chrome with drawing — 10× holds. The sweep finds
  the fleet for a target wait where one exists (4,000 vehicles for 10 minutes with transit kept).

### Phase 7 — Buildings and Driver POV (`tools/build_buildings.py` → `data/mpls_buildings.js`) ✅
- Footprints: `python3 tools/build_buildings.py --fetch` (Overpass: buildings, building parts,
  stadiums) → 10,680 buildings, 66,352 points after 0.6 m simplification, 559 KB, loaded after the
  page starts. Heights: 131 from `height`, 1,852 from levels, 8,697 by kind (house 7 m,
  apartments 13 m, office 20 m…); OSM building parts replace their outlines (171), so towers
  mapped as parts (IDS 241 m, Capella 237 m, Wells Fargo 236 m…) stand at their height.
- Map: footprints from 0.5 px/m, shaded by height (under 15 m, under 40 m, taller) with
  landmarks accented, one path per shade.
- Driver POV (`src/pov.js`): **Ride along** in a vehicle's details opens a driver's-seat view
  (eye 1.3 m in a sedan, 2.0 m in a shuttle, 2.6 m in a bus), interpolated between simulation
  steps so it moves smoothly at any speed. Roads within 260 m, buildings within 450 m in the field
  of view plus the skyline (towers over 60 m to 1.5 km), small low buildings beyond 250 m
  skipped, walls back-face culled and drawn far to near, edges only within 140 m, roofs only
  from above, other vehicles within 160 m as boxes.
- Landmark designs (`src/buildings.js`): U.S. Bank Stadium (zinc walls, roof sloping from the
  83 m prow), IDS Tower (blue glass), Target Center (green roof), Northrop (brick with a
  ten-column portico on the mall side), Coffman Union (brick with its central tower), Huntington
  Bank Stadium (horseshoe bowl: limestone wall, maroon seating, field).
- Tests: `tests/test_build_buildings.py` (height sources and units, parts replacing outlines,
  landmark outlines keeping theirs, stadiums mapped as `leisure`, drops, simplification,
  multipolygon rings, output) and `node tests/pov.test.cjs` (decoding, grid query = brute force,
  landmark geometry, the IDS Tower in view up Nicollet Mall and gone when turned around, bounded
  work, vehicles culled by distance, frame time); the page test rides along.
- **Exit:** downtown on Nicollet Mall the POV draws at most about 80 buildings and 350 faces;
  0.3 ms of geometry per frame in Node, 0.4–0.5 ms per frame of drawing calls in desktop Chrome
  (median; p90 0.9 ms) with the page at 60+ fps at both desktop and phone viewport sizes. A
  phone at 4–5× slower would spend 2–5 ms a frame, well inside 30–60 fps — not yet confirmed on
  a real phone.

### Phase 8 — Metrics, export and headless runs ✅
- Metrics (`src/metrics.js`, fed by the engine every step, in real people and vehicles): fleet
  VMT and VHT, empty (deadhead) miles and share, occupancy (passenger-miles per vehicle-mile),
  utilisation (fleet time carrying or fetching riders vs idle and charging), each by vehicle
  type; rider wait and ride distributions (1-minute bins, percentiles); private-car VMT and VHT;
  energy and charging; gridlock jumps; a 15-minute time series (requests, deliveries, waiting,
  fleet busy/idle/charging, fleet and empty miles, cars on the road, congested segments); hourly
  river-bridge crossings by direction.
- CSV export: `sim.csv("summary" | "series" | "bridges" | "distributions")`; the page's **Run
  metrics** panel shows the headline figures and downloads the four CSVs.
- Headless runner `tools/run_scenario.cjs`: seeded single runs, or `--vary
  fleet|carShare|pooling|sampling|day` sweeps writing `sweep.csv` (one row of metrics per value)
  and `sweep.svg` (average wait and riders delivered against the setting: two panels sharing the
  x axis, one measure each), plus each run's CSVs.
- Recorded sweeps (`docs/results/`, 05:30–10:00 Wednesday, 1:5):
  | Transit kept, half of car trips → SDEV | 1,000 | 2,000 | 3,000 | 4,000 | 5,000 |
  |---|---|---|---|---|---|
  | Average wait (min) | 44.6 | 21.1 | 12.6 | 8.7 | 6.8 |
  | Riders delivered | 37,570 | 49,765 | 54,320 | 56,030 | 56,805 |
  | Occupancy · empty miles | 2.77 · 34 % | 2.07 · 37 % | 1.50 · 40 % | 1.20 · 41 % | 1.06 · 43 % |

  | Transit replaced too | 4,000 | 6,000 | 8,000 | 10,000 | 12,000 | 16,000 |
  |---|---|---|---|---|---|---|
  | Average wait (min) | 47.0 | 36.2 | 30.6 | 26.5 | 23.5 | 23.5 |
  | Riders delivered | 82,470 | 95,670 | 100,710 | 105,505 | 105,470 | 105,750 |
  | Occupancy · empty miles | 2.26 · 37 % | 2.17 · 38 % | 2.05 · 38 % | 1.85 · 39 % | 1.70 · 40 % | 1.49 · 40 % |
- Tests: `node tests/metrics.test.cjs` (fleet miles = odometers, empty ≤ total, by-type sums,
  every delivered rider in both distributions, fleet hours = fleet × time, the 15-minute rows sum
  to the totals, hourly bridge rows, CSV shapes; a seeded two-run sweep writes `sweep.csv`, a
  two-panel `sweep.svg` and per-run CSVs, and repeats exactly). The page test reads the panel.
- **Exit:** `node tools/run_scenario.cjs --vary fleet=...` produces the CSV and the chart above.

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
2. Default agent sampling ratio (1:20 assumed). **Decided in Phase 5:** 1:20 default, 1:10 selectable.
3. Whether remaining private vehicles may use bus-only lanes (assumed no).
4. Depot locations (assumed: a handful of existing parking ramps, configurable). **Phase 6:** five
   ramps by default; open, close or add depots on the page.

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
| 4 | done | Saturation flow, merge turns, keep-clear, pcu-4 private agents with real-scale demand, BPR + queue delay routing and en-route diversion, chokepoint panel and congestion layer. AM peak: 121-car queue at the I-35W UMN exits at 08:05, cleared by 10:00. ≈ 22 ms per 20× frame in desktop Chrome at the peak. |
| 5 | done | Census 2020 blocks + LODES 2023 + OSM parking → 822 zones, 114k residents, 226k jobs; commuters, UMN, hospitals, errands, visitors, events by day of week; 721k trips on a Wednesday with 08–09 and 16–17 peaks; 1:20 agents; car-share lever, edge hubs, parking, green splits, gridlock relief. Downtown-residents target missed (35.7k Census vs 45k plan). |
| 6 | done | Scenario controls (transit, cars kept, pooling, fleet, depots, EV, rebalancing); grid dispatch and request-driven sharing; area pooling; rebalancing to a forecast; battery and charging; fleet sweep. Revised after Phase 7: riders/fleet sampled 1:10 (sweep 1:5), cars 1:20; all-transit scenario is street-capacity bound (~105k delivered by 10:00 from ~10,000 vehicles); with transit kept, 4,000 vehicles give an 8.7-min wait. |
| 7 | done | 10,680 OSM buildings with heights (parts for towers), footprints on the map, ride-along Driver POV with culling and LOD, six landmark designs; ~0.5 ms per POV frame in desktop Chrome downtown. |
| Fleet fix | done | Riders/fleet 1:10 (sweeps 1:5), cars 1:20; dispatch index and rebalancing fixes; all-transit scenario is street-bound (~105k riders by 10:00), transit-kept scenario needs ~4,000 vehicles for 8.7 min. |
| 8 | done | Metrics (VMT/VHT, deadhead, occupancy, utilisation, distributions, series, bridge loads), CSV export on the page, `tools/run_scenario.cjs` sweeps with CSV + SVG chart, recorded in `docs/results/`. |
| 9 | not started | |
