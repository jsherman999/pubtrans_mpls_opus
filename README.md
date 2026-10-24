# PubTrans MPLS

What would downtown Minneapolis and the University of Minnesota look like if buses and many
private cars were replaced by self-driving electric (SDEV) shuttles? This simulation runs a
whole weekday of trips, built from the Census, on the real street network: SDEV sedans,
shuttles and buses dispatched to riders and pooling them, sharing the streets with the private
cars that remain and with freeway through-traffic, at signals that discharge at lane capacity.

**Live:** https://jsherman999.github.io/pubtrans_mpls_opus/ (simulation) ·
[street map](https://jsherman999.github.io/pubtrans_mpls_opus/viewer.html) ·
[original grid app](https://jsherman999.github.io/pubtrans_mpls_opus/source/index.html)

![The simulation at 08:10 on a Wednesday: 15,000 vehicles on the road, congestion in red and orange on the river crossings and freeway exits, the live-state panel on the right](docs/img/sim.jpg)

Adapted from [pubtrans_15_minute_city](https://github.com/jsherman999/pubtrans_15_minute_city)
(source commit `60774088fd727f49125c9bb2e979839fe8b3be2c`), which ran on a generated 6 × 6 grid.
The original app is kept unchanged at [`source/index.html`](source/index.html); its
documentation is [`docs/SOURCE_README.md`](docs/SOURCE_README.md) and
[`docs/SOURCE_ARCHITECTURE.md`](docs/SOURCE_ARCHITECTURE.md).

- [What it models](#what-it-models)
- [Using the page](#using-the-page)
- [Results: how big a fleet?](#results-how-big-a-fleet)
- [Run locally](#run-locally)
- [Headless runs and sweeps](#headless-runs-and-sweeps)
- [Data builds](#data-builds)
- [Tests](#tests)
- [Limits](#limits)
- [Credits](#credits)

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). How it was built, phase by phase, with the
measurements behind each step: [PLAN.md](PLAN.md). Data formats:
[docs/DATA_FORMAT.md](docs/DATA_FORMAT.md).

## What it models

- **The area:** downtown Minneapolis (North Loop to Elliot Park), Cedar-Riverside and the UMN
  West Bank, Nicollet Island, Marcy-Holmes, Dinkytown, the UMN East Bank and Stadium Village:
  a 6.1 × 4.1 km box with 5,327 intersections, 459 km of drivable street, 356 signal
  controllers, all eight Mississippi road bridges, and 205 roads leaving the map.
- **The people:** 114,000 residents and 226,000 jobs from the 2020 Census and LEHD LODES 2023:
  commuters who arrive from the direction of their homes (and work from home on some days),
  hospital shifts, UMN students between classes, errands, visitors and an evening Twins game.
  About 720,000 trips on a Wednesday, with the morning and evening peaks where they should be.
- **The choice of mode:** short trips are walked; of the rest, a lever sets how many of today's
  car trips are still driven, and whether today's transit riders use SDEVs instead.
- **The fleet:** sedans (4 seats), shuttles (8) and buses (20), electric with batteries and
  charging, from five parking-ramp depots (open, close or add your own). Riders are pooled by
  area, picked up by vehicles already passing, and the idle fleet is rebalanced toward the next
  half hour's demand.
- **The streets:** lanes, one-ways, transit-only streets (Nicollet Mall, the Washington Avenue
  transitway) that SDEVs may use and cars may not, signals with green split by approach,
  saturation flow, queues that spill back, congestion that drivers route around, and police
  and fire emergencies that close streets.

## Using the page

Drag, scroll or pinch to move around the map. Tap a vehicle to see its riders and route, then
**Follow** it or **Ride along** in a driver's-seat view among the city's buildings (with the
IDS Tower, U.S. Bank Stadium, Target Center, Northrop, Coffman Union and Huntington Bank Stadium
modelled). Tap a stop to see who is waiting there.

![Riding along with a shuttle on South 8th Street, the IDS Tower ahead](docs/img/pov.jpg)

The panel (a bottom sheet on phones) has:

- **Playback:** speed from 1× (30× real time) up, reset, trigger an emergency.
- **Scenario:** day of the week, people per agent, share of car trips kept, transit replaced or
  kept, pooling, fleet size by vehicle type, depots, battery-electric operation, rebalancing.
- **Live state** with charts of wait and queue, **Run metrics** (fleet and car miles and hours,
  empty share, occupancy, utilisation, wait and ride percentiles) with CSV downloads, the
  **Chokepoints** (river bridges, freeway ramps, map-edge entries) and an event log.

<img src="docs/img/phone.jpg" width="260" alt="The simulation on a phone in dark mode, the map above and the controls in a bottom sheet">

`viewer.html` is the street map on its own: tap a street for its speed, lanes, direction and
OSM way, or **Plan a route** to compare the fastest car route with the fastest shuttle route.

![The street map viewer](docs/img/viewer.jpg)

## Results: how big a fleet?

A Wednesday morning, 05:30–10:00, half of today's car trips moved to SDEVs, simulated at 1:5
(each rider and fleet agent stands for five), recorded in [`docs/results/`](docs/results/):

| Transit kept | 1,000 | 2,000 | 3,000 | **4,000** | 5,000 |
|---|---|---|---|---|---|
| Average wait (min) | 44.6 | 21.1 | 12.6 | **8.7** | 6.8 |
| Riders delivered | 37,570 | 49,765 | 54,320 | 56,030 | 56,805 |

| Transit replaced too | 4,000 | 6,000 | 8,000 | 10,000 | 12,000 | 16,000 |
|---|---|---|---|---|---|---|
| Average wait (min) | 47.0 | 36.2 | 30.6 | 26.5 | 23.5 | 23.5 |
| Riders delivered | 82,470 | 95,670 | 100,710 | 105,505 | 105,470 | 105,750 |

- **Keeping today's transit**, about **4,000 vehicles** carry half of today's car trips with an
  average wait under 9 minutes.
- **Replacing transit as well**, requests peak at about 76,000 people an hour. Deliveries level
  off near 105,000 by 10:00 from about 10,000 vehicles: the streets are full, rides take
  25 minutes, and more vehicles only add to the queues. No fleet of vans reaches a 15-minute
  average wait in this scenario; what limits it is street capacity at the bridges and freeway
  exits, not the number of vehicles. The page defaults to 8,000 vehicles in this scenario.

An earlier sweep suggested 19,000 vehicles; that was an artefact of coarse sampling (at 1:20,
pooling saw a demand 20 times sparser than reality). "Fleet sizing, revisited" in
[PLAN.md](PLAN.md) has the story.

## Run locally

No build step and no dependencies. Serve the folder and open it:

```
python3 -m http.server 8000
```

- http://localhost:8000 — the simulation
- http://localhost:8000/viewer.html — the street map
- http://localhost:8000/source/index.html — the original grid app

The pages also open straight from the file system (`file://`).

## Headless runs and sweeps

The same engine runs in Node (18 or later), seeded, for scenario runs and sweeps:

```
node tools/run_scenario.cjs --until 10:00 --fleet 8000 --out-dir results/base
node tools/run_scenario.cjs --vary fleet=2000,3000,4000,5000 --keep-transit --sampling 5 --out-dir results/sweep
```

A single run writes `summary.csv` (fleet and car miles and hours, empty share, occupancy,
utilisation, wait and ride percentiles, energy), `series.csv` (every 15 minutes),
`bridges.csv` (hourly crossings of the eight river bridges by direction) and
`distributions.csv` (riders by minutes waited and ridden). `--vary fleet|carShare|pooling|sampling|day`
runs one scenario per value and adds `sweep.csv` and `sweep.svg` (average wait and riders
delivered against the varied setting). Other options: `--mix sedans,shuttles,buses` (shares),
`--car-share 0-1`, `--keep-transit`, `--pooling 0-100`, `--day 0-6` (Monday = 0), `--seed`,
`--no-ev`, `--no-rebalance`. The page's Run metrics panel downloads the same CSVs.

`tools/fleet_sweep.cjs` searches for the smallest fleet that meets a target wait:

```
node tools/fleet_sweep.cjs --totals 4000,8000,12000 --until 10:00 --target 10 --out data/fleet_sweep.json
node tools/fleet_sweep.cjs --totals 2000,3000,4000 --keep-transit
```

## Data builds

The data in `data/` is generated by three offline builds (Python 3, standard library only) and
committed, so nothing here needs to run to use the pages. Each needs network access with
`--fetch`, saves its raw downloads to `data/raw/` (not committed), and writes a report to review.

```
python3 tools/build_osm.py --fetch         # streets   -> data/mpls_graph.js      (541 KB)
python3 tools/build_demand.py --fetch      # Census    -> data/mpls_demand.js     (223 KB)
python3 tools/build_buildings.py --fetch   # buildings -> data/mpls_buildings.js  (573 KB)
```

Rebuild from saved downloads by leaving out `--fetch` (`build_osm.py` takes
`--input data/raw/osm_roads.json`). The study box is the `--bbox S W N E` option of each build.

## Tests

```
python3 -m unittest discover -s tests -p "test_*.py"   # street, demand and building pipelines
node tests/viewer.test.cjs                             # decoder and street viewer
node tests/routing.test.cjs                            # router, signals, 7,000-node benchmark
node tests/motion.test.cjs                             # vehicle motion, up to 3,400 vehicles
node tests/sim.test.cjs                                # engine on the real network
node tests/congestion.test.cjs                         # capacity, congestion, AM peak
node tests/demand.test.cjs                             # Census demand, daily totals, AM/PM shape
node tests/fleet.test.cjs                              # scenario controls, fleet at scale, sweep
node tests/pov.test.cjs                                # buildings, landmarks, driver view
node tests/metrics.test.cjs                            # run metrics, CSV export, scenario runner
node tests/page.test.cjs                               # simulation page, headless
node tests/publish.test.cjs                            # assets, links, attribution, size budgets
node tests/simulation.cjs                              # original grid app (slow, ~2 minutes)
```

## Limits

This is an illustrative model, not a calibrated forecast.

- Trip timing, mode shares, hybrid work and student travel are modelled from Census counts and
  stated assumptions (see [PLAN.md](PLAN.md)), not from a travel survey.
- Road capacity uses lanes and saturation flow by road class; turn lanes, signal coordination
  and pedestrians are not modelled. Light rail is not modelled.
- People outside the box appear only as trips crossing its edge.
- Most parking capacities are estimated from footprints, and most building heights are
  defaults by building type.
- Agents stand for groups of people and vehicles (1:10 on the page); pooling at coarser
  sampling sees a sparser demand than reality.
- Phones have not been timed on a device; the morning peak at 20× may be slow on older phones.

## Credits

- Street, building and parking data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors, available under the Open Database License (ODbL).
- Population and housing: U.S. Census Bureau, 2020 Census (P.L. 94-171), through TIGERweb.
  Jobs and commutes: U.S. Census Bureau, LEHD Origin-Destination Employment Statistics (LODES)
  2023. Public domain.
- Simulation design from [pubtrans_15_minute_city](https://github.com/jsherman999/pubtrans_15_minute_city).
