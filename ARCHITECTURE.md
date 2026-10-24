# Architecture

PubTrans MPLS simulates self-driving electric (SDEV) shuttles, sedans and buses serving downtown
Minneapolis and the University of Minnesota on the real street network, with private traffic,
signals, congestion and a day of trips built from the Census. Everything runs in the browser
(plain HTML, vanilla JavaScript, Canvas; no build step, no server, no map tiles) and the same
engine runs headless in Node for tests and scenario sweeps.

The original grid app this was ported from is kept at `source/index.html`; its design is in
[`docs/SOURCE_ARCHITECTURE.md`](docs/SOURCE_ARCHITECTURE.md). [`PLAN.md`](PLAN.md) records how
each phase was built, measured and checked.

## Layout

```
index.html            simulation page            viewer.html         street map + route preview
source/index.html     original grid app (unchanged but for the phone pages)
src/                  browser + Node modules, no dependencies, loaded with <script src>
  graph.js            decode data/mpls_graph.js; link geometry; link picking index
  routing.js          arcs in CSR arrays; A*/Dijkstra; backward route trees; connected core
  traffic.js          signal controllers: cycle, green splits, waits; stop-sign holds
  motion.js           vehicles in lanes: following, saturation flow, merges, closures, gridlock relief
  congestion.js       capacities, measured flow and queues, BPR + queue delay; chokepoints
  demand.js           a day of person trips from data/mpls_demand.js, sampled into agents
  sim.js              the engine: demand release, dispatch, pooling, ride sharing, fleet, private
                      traffic, emergencies, EV charging, rebalancing, metrics hooks
  metrics.js          VMT/VHT, deadhead, occupancy, utilisation, distributions, series, CSV
  mapview.js          zoomable canvas map shared by both pages
  buildings.js        footprint decoding, spatial index, landmark designs
  pov.js              driver's-seat perspective view
  pages.js            phone layout shared by all three pages: map and panel as swipeable pages
tools/                offline builds (Python, standard library) and Node runners
  build_osm.py        OpenStreetMap streets      -> data/mpls_graph.js
  build_demand.py     Census blocks, LODES, OSM parking -> data/mpls_demand.js
  build_buildings.py  OpenStreetMap buildings    -> data/mpls_buildings.js
  run_scenario.cjs    headless runs and sweeps   -> CSV + SVG
  fleet_sweep.cjs     fleet-size sweep           -> data/fleet_sweep*.json
data/                 generated, committed data (raw downloads in data/raw/, ignored)
tests/                Node and Python tests (see README)
docs/                 data formats, recorded results, source-app docs
```

## Data

Three offline builds turn public data into compact `window.X = {...}` scripts the pages load
with `<script src>`, so they work from `file://` and GitHub Pages. Formats are in
[`docs/DATA_FORMAT.md`](docs/DATA_FORMAT.md).

- **Streets** (`data/mpls_graph.js`, 541 KB): OSM drivable ways in the box S 44.960, W −93.292,
  N 44.997, E −93.215, simplified to 5,327 topological nodes and 6,614 links (11,007 directed
  arcs) with geometry, speeds, lanes, one-ways, shuttle-only streets, bridges, signal controllers
  and stop approaches. Roads leaving the box end at 205 portals.
- **Demand** (`data/mpls_demand.js`, 224 KB): 876 census blocks with residents (2020 Census) and
  jobs by sector (LEHD LODES 2023, with jobs filed under one address spread over nearby floor
  space); home-to-work flows inside the box and by direction to and from it; UMN campus,
  hospitals and venues; 877 parking facilities.
- **Buildings** (`data/mpls_buildings.js`, 573 KB, loaded after the page starts): 10,680
  footprints with heights.

## The engine

`MplsSim.createSim(graph, options)` returns a seeded, DOM-free simulation. Time advances in
fixed 3-second steps; playback speed only changes how many steps run per 100 ms frame, so
results never depend on speed. One step:

1. Advance the clock; release the trips due (or, without Census data, the placeholder
   schedules).
2. Private traffic: commuters, visitors and residents' cars from the trip list (cars are
   sampled more coarsely than riders), plus freeway through-traffic portal to portal.
3. Emergencies (police and fire close the direction they arrive from), breakdowns and recovery.
4. Boarding (one rider agent per step), ride sharing (waiting riders ask nearby moving vehicles;
   vehicles scan the queue), dispatch (sweeps, carpools and pools by area, then singles, each
   from the nearest free vehicle through a 400 m grid), idle returns and charging trips.
5. Rebalancing every 5 minutes toward a forecast of the next half hour.
6. Movement (`motion.step`), arrivals, energy, metrics; congestion measures every minute.

**Routing.** Costs are seconds at posted speeds plus expected signal and stop delays. Trips into
the ~1,300 stops (zones, depots, edge hubs, parking lots, exits) follow cached backward route
trees (one Dijkstra per destination, 11 KB each, LRU); everything else uses A*. A route avoids
closures and congestion only when its free-flow version would meet them (extra costs are never
negative, so the free-flow route is otherwise still best). Drivers stuck in queues may reroute.

**Motion.** A vehicle is at `(arc, s, lane)`. Each lane is a front-first queue with an 8 m gap
per car; stop lines discharge one car per saturation headway (lanes × class flow × the signal's
green split); the first car away from a red loses 2 s; merges serve the lane that has waited
longest; vehicles never stop inside short intersection arcs unless there is room beyond; after
5 minutes truly stuck a vehicle jumps ahead along its route (counted).

**Sampling.** A rider agent stands for `sampling` people (10 on the page, 5 in sweeps) and a fleet
agent for that many vehicles; a car agent stands for 20 cars. Agents take `pcu` × the stop-line
headway but at most 4 cars of lane space. Every number shown or exported is scaled back to real
people and vehicles.

**Demand.** `src/demand.js` builds a full-scale day (commuters with sector start times, hybrid
presence by weekday and hospital shifts; UMN students timed to the class schedule and changing
banks between classes; errands and visitors, which can be switched off; events), then samples
agents with stochastic rounding. Each trip gets today's mode: walked under 800 m; beyond that
walked or cycled, driven, or on transit with shares by who travels, calibrated to ACS 2024
commuting and fall 2025 Metro Transit boardings (PLAN.md, Phase 10). Trips from outside enter in
the compass sector of home: drivers at a map-edge road in that direction, shuttle riders at its
edge hub. Two scenario levers apply at release: the share of today's car trips still driven
(90 % by default), and whether today's transit riders use SDEV shuttles.

## The pages

`index.html` builds the engine, the shared map view and the panels. The map draws streets by
class (one path per class and width), footprints from 0.5 px/m, congestion offset beside each
street, signals per approach, places and waiting counts, and vehicles (dots far out, scaled
shapes up close, sampled cars as several cars nose to tail). Picking inverts the view transform.
**Ride along** opens the driver's-seat view (`src/pov.js`): roads, extruded buildings with
back-face and distance culling, the skyline out to 1.5 km, landmark designs and nearby
vehicles, drawn far to near and interpolated between steps. The panel holds playback, scenario and
fleet controls, live state, run metrics with CSV export, chokepoints, the event log and the key.
On phones it is a second full-screen page beside the map (`src/pages.js`), turned to by a swipe
or flick left and back by a swipe right.

`viewer.html` is the street map on its own, with street inspection and a car-vs-shuttle route
preview. On phones its title card (area, key, links) is the second page in the same way.

## Performance (desktop, Apple silicon)

| | |
|---|---|
| A* route on the real network | 0.12 ms |
| Census AM peak, 1:10, 5,000-vehicle fleet | ~19 ms per 10 steps in Node, ~40 ms per 10× frame in Chrome with drawing |
| Driver view downtown | ~0.5 ms of drawing calls per frame, ≤ ~80 buildings |

Phones have not been measured on a device; at 4–5× slower the default 10× playback should fit,
20× at the morning peak may not.

## Limits

This is an illustrative model, not a calibrated forecast. Trips and their timing are modelled
from Census counts and stated assumptions; road capacity ignores turn lanes and signal
coordination; parking capacities are mostly estimated from footprints; building heights are
mostly defaults by type; pooling at coarse sampling still sees a sparser demand than reality.
