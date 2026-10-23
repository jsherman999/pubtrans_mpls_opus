# PubTrans — 15 minute city

[Open the simulation](https://jsherman999.github.io/pubtrans_15_minute_city/)

A browser-only autonomous transit simulation adapted from [pubtrans_solved](https://github.com/jsherman999/pubtrans_solved), source commit `77c245254cbefd0a4acf77f18662736988c48592`. Vanilla JavaScript and Canvas, no dependencies or build step.

## The region

- A **6 × 6 block center**, using 7 × 7 intersections. Blocks represent 100 m, so the center is 600 m across. The “15 minute city” label describes the center's scale; the simulation models vehicle trips, not pedestrian accessibility.
- Five neighborhoods with **24 individual residences each**, two winding boulevard branches and four cul-de-sacs per neighborhood.
- The original four neighborhoods retain their randomized side-of-city placement and separation from zero (direct connection) to 1,609 m (about a mile). The fifth, **Juniper Commons**, always connects at the southeast corner, with its entrance 60 m from that corner (less than one 100 m block). Its boulevards extend outward from this attached entrance.
- Sedans and shuttles share one connected road graph, serving neighborhood-to-center, center, local neighborhood and cross-neighborhood trips.
- Central Station occupies the northwest corner block. The off-map approach is at 75° to horizontal streets; a dedicated line continues through the center to Juniper Park & Ride. Moving three-car trains serve both stations in both directions and continue off the opposite map edge, with a maximum of 60 passengers.

## Using it

Scroll through the regional overview, city center, and five neighborhood maps. Each map has a Pause/Resume button in its upper-right corner that controls the whole simulation, including interactive driving. All map buttons and the Controls button stay synchronized. Sticky shortcuts jump to the regional map, the city center and Controls / POV; the neighborhood maps follow by scrolling. The Guide opens with a tip: pause to examine the simulation's state, and switch Driver POV at any time by tapping another vehicle. On desktop, the controls remain in a sidebar; on phones they follow the maps and metrics.

**Auto:** runs immediately at 1×. Change speed, pause/resume, reset the day, adjust population or fleet, and tap a moving vehicle on any map to watch its driver POV. Tapping a vehicle while paused switches the view without resuming the simulation. Otherwise Driver POV rides one bus for the whole simulation: it starts on the Juniper Commons bus, whose neighborhood adjoins the center, and stays with it through depot waits and Reset day. Exiting a tapped vehicle returns to that bus; the view changes bus only if the followed bus is removed from the fleet. Reset day preserves the geography; refresh randomizes it.

**Interactive:** select the mode in Controls, tap a source building and destination on any maps, then return to Controls / POV and press Plan and Drive. Candidate routes, congestion scoring, obstacles, replanning and driver POV work across the region. A cul-de-sac has only one exit, so some origin/destination pairs have fewer than three distinct routes.

The fleet starts with 15 sedans (4 seats), 14 shuttles (8 seats), and five large purple buses (20 seats each), serving 450 simulated people by default (adjustable up to 800). Individual houses are potential origins/destinations, not one person per house. Worker, student, errand and commuter profiles retain their original schedules; suburban residents also generate neighborhood visits. School/train surges, pooling, boarding one passenger per tick, stoplights, stop signs, one-way streets, automatic depot returns, metrics, and inline/pop-out debug logs are retained.

Optional Anthropic narration still uses the source app's direct browser API call. Paste a key in Settings; it is held in memory and cleared by refresh. Core simulation needs no API key. The optional paid API call is not covered by the automated tests.

## Distance and simulation time

The center is **6 × 6 blocks (36 blocks)**, each 100 m long. Movement is calculated from actual road length and explicit cruising speeds: **20 km/h (12 mph)** on neighborhood roads, **25 km/h (16 mph)** downtown, and **35 km/h (22 mph)** on connecting roads. One mile at those speeds takes about 4.8, 3.9, or 2.8 minutes of uninterrupted driving, respectively.

Each simulation step represents **3 seconds**. Boarding takes one step per passenger, plus a nine-second departure pause after the last passenger; stop signs hold for 3 seconds, traffic signals have 30-second green/red phases with 3-second transitions, and obstacle responses take 6–9 seconds. Passenger ride time still includes the time spent aboard during other pickups, stops and detours. These are illustrative operating assumptions, not measured local transit performance.

The playback slider repeats complete simulation steps: **1× and 20× produce the same simulated ride durations**, but at different viewing speeds. At 1×, each nominal 100 ms display tick advances three simulated seconds (30 simulated seconds per real second); slow devices may take longer to process a tick.

The old calibration moved vehicles at only 3 km/h and counted 18 seconds per boarding passenger at 1×. More seriously, playback speed multiplied the clock and motion but not boarding/stop timers, inflating their simulated duration at higher playback speeds. Both issues are corrected.

Validation with 300 people, default fleet and 100% sharing, across three seeded 12-hour runs at 20×: average rides changed from **122–149 minutes** to **2.2–2.6 minutes**, with **992–1,020 completed riders**. These are overall averages including short city/apartment trips; longer neighborhood or pooled trips can take more time. With the current 450-person default and 212 downtown units, three seeded 12-hour runs at 20× completed **1,645–1,684 riders**, with **2.7–3.3 minute** average rides, **2.6–3.3 minute** average queues and no riders still waiting at the end of the day. Tests also compare identical seeded worlds at 1× and 20× and verify physical travel speeds.

The chosen speeds are conservative relative to [NACTO urban target-speed guidance](https://nacto.org/publication/urban-street-design-guide/design-controls/design-speed/), which discusses 20 mph neighborhood zones. Boarding is modeled at 3 seconds per person; [NACTO's boarding guidance](https://nacto.org/publication/better-boarding-better-buses/) explains why dwell time must be accounted for separately from driving.

## Live ride statistics

**Completed** counts every passenger delivered since Reset day and continues beyond 1,000. The separate diagnostic trip history retains only the latest 1,000 records to bound memory.

**Avg ride (min)** is the mean of each completed passenger's own boarding-to-dropoff duration across all completions since Reset day. It excludes time waiting for pickup and vehicle activity before boarding or after dropoff. Time spent aboard during other pickups, stops or detours remains part of that person's ride. A monotonic simulation clock keeps durations valid across daily schedule rollover, and interactive driving advances the same clock. Reset day clears the count and average.

**Avg queue (min)** is a separate running mean across riders who have boarded and riders still awaiting pickup since Reset day. Boarded riders contribute their final request-to-boarding wait; unassigned and assigned-but-not-boarded riders contribute their wait so far. Each request counts once, and reassigning a rider after vehicle removal preserves the original request time. Reset day clears this metric as well. Canceled requests from removed population members no longer contribute while unserved.

## City apartments and defaults

Downtown has **212 housing units** in five buildings: **Riverbend Apts** (100 apartments), **Birch Hgts** and **Oak Hgts** (40 apartments each), **Cedar Block** (24 apartments) and **Maple Row** (8 townhouses). With the 120 suburban houses, that makes 332 homes. Home assignment and residential event destinations are weighted by housing units, so each unit is one potential home. Residents count toward the selected population rather than being added on top.

The default population is 450, which keeps about 1.35 residents per home, the ratio of the earlier 300-person default across 224 homes. The suburbs keep about 160 residents, and downtown has about 290 on a typical load (Riverbend about 135, each 40-unit building about 54, Cedar Block about 33, Maple Row about 11). Assignment is random, so exact counts vary per page load. Hillside is the remaining school; Riverbend school events have been removed. Downtown housing shares one map color and lists its unit count under the building name.

New page loads start with **450 people, 15 sedans, 14 shuttles, five large buses and 100% ride sharing**. Reset day retains the current live fleet/demand settings. Fleet & demand uses fixed columns so buttons and counts remain aligned when digits change.

## Houses and passenger transfers

Each neighborhood has four cul-de-sacs, now with two homes served at each turning circle. Adding one home to each cul-de-sac increases each development from 20 to 24 homes, for 120 suburban residences overall.

In Driver POV, suburban homes are low ranch houses with varied exterior colors, proportions, gabled/hipped roofs, doors, windows and stoops.

## Downtown buildings

Every downtown building has its own Driver POV design, with named signs readable up close:

- **Central Stn:** brick head house with arched windows, a clock tower and a platform canopy over the through tracks.
- **NorthCo:** stepped limestone tower on a podium with a gold mast. **EastBank:** blue glass curtain-wall tower with a lit lobby and slanted crown.
- **SouthLabs:** low white lab with ribbon windows, rooftop plant, exhaust stacks and a parking lot. **WestWorks:** converted brick factory with loft windows, sawtooth roof and chimney.
- **Hillside:** brick school with a pedimented entrance and clock, playground, lawn and flagpole.
- **GreenMart:** supermarket with a lit glass front, striped awning and parking. **CityFoods:** corner market with awnings, produce stands, flats above and a water tank.
- **Police / Fire:** three-bay fire hall with hose tower beside a blue-banded police station.
- **Riverbend Apts:** U-shaped block with balconies around a courtyard garden. **Birch Hgts:** white mid-rise with glass balconies, penthouse and podium roof garden. **Oak Hgts:** brick building with bay windows and a slate mansard. **Cedar Block:** timber-clad L-shaped block. **Maple Row:** eight townhouses with stoops and mixed cornices and gables.

Top-down maps keep the type colors and add each building's roof plan: setbacks, rooftop equipment, lawns, lots and trees.

**Juniper Park & Ride** follows its straight stretch of track: side platforms with yellow edge lines under red-trimmed canopies, a brick ticket hall with signs and a clock facing the access road and the tracks, a drop-off plaza with a bus shelter and parking sign, a lit parking lot with parked cars, and a lawn with trees across the line. Its map plan turns with the track. In Driver POV, train coaches are painted in the same back-to-front order as buildings, and stations order them with their platforms, canopies and halls, so buildings in front of a train hide it.

## Live metrics and debug stream

The Live metrics graph plots two lines, each scaled to its own visible maximum (labeled in the series color): **Queue wait**, the average minutes waited so far by riders still awaiting pickup (including those already assigned a vehicle), and **Queued**, the number of requests not yet assigned a vehicle. The Debug stream panel has a **Pop window** button that opens the same stream in its own window, like the button in Controls.

Each actual passenger transfer creates a small moving stick figure between the building and the vehicle stop: yellow for boarding and green for alighting. Group dropoffs stagger the figures for readability. Boarding figures are synchronized with a nine-simulated-second departure pause, scaled to playback speed, and end before the vehicle leaves. Effects also appear in Driver POV when within its field of view, and Reset day clears them. The animations are visual only and do not alter passenger accounting or boarding timing.

## Large neighborhood buses

Each development starts with one dedicated 20-seat bus. Buses get first choice of waiting trips between their assigned neighborhood and any center destination, including schools, workplaces, groceries and Central Station, throughout the day. The oldest eligible request selects inbound or outbound service; each run pools up to 20 riders in that direction. Smaller vehicles handle remaining demand, including local and cross-neighborhood trips.

Fleet & demand has a separate bus count, active count and +/− controls, plus a live breakdown by neighborhood. Added buses go to the least-served neighborhood. Removal reduces the most-served neighborhood first, using an idle bus when possible. Busy buses finish their assigned pickups and dropoffs before leaving the simulation; the panel shows pending retirements. Bus assignments survive Reset day. Purple, larger map vehicles and the driver POV caption identify buses and their assigned development.

## Ride sharing control

In Fleet & demand, **Ride sharing** starts at **100%**. Set it to **0% (baseline)** to retain fixed trips and the original pooling. Higher settings allow buses and shuttles already out on the road to collect additional **unassigned** requests along their remaining service or return to Central Station. Try 50% first; increase if you prefer more pooling over direct trips.

- 10% permits up to 40 m of additional driving per trip; 50% permits 200 m; 100% permits 400 m. Boarding stops add time beyond this distance budget.
- Existing pickup/dropoff order is preserved. Capacity accounts for passengers aboard and promised pickups at every future stop. A newly added request always has a pickup before its dropoff.
- Buses still serve only trips between their assigned development and center. Retiring buses and interactive vehicles do not accept opportunistic riders.
- The planner includes the return to Central Station when evaluating savings, allowing an outbound vehicle to collect inbound riders on its way back. The vehicle keeps its current position when the plan changes.
- A live count shows on-the-way pickups assigned, and the debug stream explains each added ride and its extra distance. Existing assigned riders keep their vehicle; the control does not transfer reservations from other cars. Turning the slider back to zero stops further additions but honors trips already accepted.

## Run locally

Open `index.html` directly, or:

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. For regression checks, with Node installed:

```sh
node tests/simulation.cjs
```

The regression harness loads the actual application script with a minimal DOM/Canvas stub. It checks 12 randomized worlds for home counts, distance bounds, directed connectivity, local and cross-region routes, road-only vehicle positions, capacity limits, completed trips, train events and reset. Browser checks separately cover mobile rendering and interactive route selection.

## GitHub Pages

Publish the repository's `main` branch, `/ (root)`, in Settings → Pages. `.nojekyll` keeps this a plain static site. No secrets, server, package install or build workflow is required.

## Implementation

All runtime code is in `index.html`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the source app's subsystems and adaptation details.

## Emergencies and roadside recovery

The central Police / Fire station has garage bays and blue/red panels in Driver POV. Its dedicated response vehicles do not reduce the adjustable transit fleet:

- Blue police sedans respond roughly every 1.5–4.5 simulated hours, stop for five minutes, collect one passenger and return to the station.
- Red fire shuttles and pink support sedans respond roughly every 5–15 simulated hours. Two trucks and two sedans stop for ten minutes and return.
- **Trigger Emergency** immediately dispatches a random police (70%) or fire (30%) incident to a residence or business and resumes Auto mode.
- Responders close their arrival direction while on scene. Transit vehicles detour when possible or wait; the opposite direction remains open. Overlapping incidents keep their own closure timers.
- Roughly every 4–12 simulated hours an occupied public vehicle may develop trouble. It pulls aside at the next road node and a white recovery vehicle is dispatched immediately. Riders transfer, then continue to their individual destinations with their original pickup times preserved. The stalled vehicle returns to service after a five-minute repair following rescue.

The debug stream logs dispatch, arrival, road reopening, police pickup, return, breakdown and passenger recovery. Reset day clears incidents, closures and recovery vehicles.

## Human-driven traffic and gridlock breakdown

Lime-green cars marked **H** make persistent trips between buildings. They follow road speeds, one-way streets, stop signs, lights, emergency closures and obstacles, then either continue local trips or depart via the interstate ramps. They reserve their routes like fleet vehicles, so routing accounts for them. All moving vehicles follow traffic in the same direction with an eight-meter gap, including across road nodes; vehicles in the opposite direction are independent.

The **Human-driven traffic** slider starts at **1×**, preserving baseline arrivals of one car per 11.925 simulated minutes (about five/hour). Each step above 1× adds five retained cars, up to 145 at 30×. These cars arrive gradually from the interstate, pause briefly at destinations and make repeat local trips. Lowering the slider sends excess cars out via an on-ramp after their current trip. Baseline traffic makes one metro visit before exiting. Spawn points are checked for space and blocked starts retry later. Public fleet sizes, demand and completed passenger metrics exclude these private trips.

The live horizontal chart decomposes Gridlock into public-fleet route reservations, human-driven route reservations, emergency/recovery route reservations and obstructed road segments. Contributions are divided by the number of road segments and sum to the score; bars show percentage shares. Obstructions on the same segment are counted once. This is a route-pressure indicator, not measured traffic density or a percent of vehicles stopped. A separate live count shows vehicles slowing/waiting behind traffic. Human cars no longer trigger the old one-shot six-second stop and fixed slowdown.

## Train service

Southeast-bound services launch at 07:31:30, 11:30, 13:00 and 17:15; the opposite-direction service follows each launch 15 simulated minutes later. The first service starts after three seconds of 1× playback, including after Reset day. Trains travel at 50 km/h and dwell for one simulated minute at each platform. Each white/blue train has three bus-length carriages and a 60-person total limit. Morning services carry the scheduled Central Station arrivals plus 20 park-and-ride arrivals; the evening service can arrive full. Actual dropoffs generate road-fleet requests only when the train stops. Eight feeder requests to the park-and-ride accompany each service. Riders delivered to either station wait for an outbound train; seats are filled up to capacity, with excess riders waiting for later service. Private cars arriving at a station also contribute a boarding passenger.

Southeast-bound trains serve Central then Juniper Park & Ride and continue off-map beyond Juniper. Northwest-bound trains enter from beyond Juniper, serve Park & Ride then Central, and continue off the northwest map edge. Neither reverses. Opposing trains use parallel tracks in one corridor and board waiting outbound passengers at both stations. Road crossings close ahead of the train and stay closed through the rear carriage, in both travel directions. Closures affect routing, movement and the road-obstruction contribution to Gridlock. Train aboard/rail waiting values appear in Live state; `TRAIN` messages report service, stops, counts and crossing changes. Reset clears trains, waiting rail passengers and gates.

Trains also serve unassigned on-the-way ride requests on the domestic section, in either direction. Both buildings must be within 100 meters (one block) of the rail alignment, and the destination must be at least 30 meters farther along the current direction. The train considers pickups within the next block and boards only requests still unassigned when it reaches the stop. Extra stops take 30 simulated seconds; scheduled station stops remain intact. Local riders share the same 60 seats, receive a later destination stop, and contribute to the existing passenger ride/queue averages. `TRAIN` debug messages identify each pickup and completed dropoff. Already-assigned road passengers are never transferred by this feature.

Development access roads follow gentle curved alignments. The interstate crosses the development whose entry is farthest from the city center, with two directed carriageways, curved on/off ramps, 100 km/h mainline speeds and 30 km/h ramps. Other geometric crossings are grade-separated: local roads connect only at the ramps. The highway continues beyond both map edges.
