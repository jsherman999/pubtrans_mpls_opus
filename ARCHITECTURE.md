# Architecture and source adaptation

## Original behavior

The source is a single HTML document: CSS and controls, graph/building data, schedule-driven population, dispatch, vehicle state machines, interactive planning, top-down rendering, perspective rendering, metrics, and startup.

- `BUILDINGS`, `buildingsByType`, `nodeXY`, `adj`, and `edges` connect semantic destinations to pickup nodes.
- `makeHuman` creates randomized worker/student/errand/commuter schedules; `checkSchedules` and `fireEvent` enqueue requests.
- `dispatch` groups requests into same-origin sedan carpools, same-destination shuttle pools, overloaded-origin sweeps, then singles. Multi-stop routes keep ordered pickup/dropoff segments and reserve road edges.
- `dijkstra` respects directed streets and weights congestion; `kShortest` bans selected edges to find route alternatives. Some tree-like suburban routes necessarily share their only exit.
- `stepCars` handles travel, one-rider-per-tick boarding, traffic waits, obstacles and trip completion. Idle cars return to Central Station. Live fleet removal requeues affected requests.
- Auto mode runs schedule demand and random obstacles. Interactive mode pauses the background fleet and follows a selected trip with scripted obstacles and optional narration.
- Top-down maps render buildings, roads, traffic, congestion, waiting counts, routes, obstacles and cars. Driver POV projects the same world geometry into an offscreen Canvas and copies it to the cockpit.
- The 100 ms tick advances simulation time, updates demand/dispatch/vehicles, refreshes UI, records metrics and renders. Debug logs cap at 500 entries; trip history and graph samples are bounded.

## Adaptation

The original center indexing remains, now 7 intersections per side. Additional nodes use explicit coordinates in `extraNodes`. All roads, including curve samples, enter the same graph. Residential buildings have explicit centers, small footprints and nearby road access nodes, so drawing, picking, waiting badges, destinations and POV all agree.

Four outward sectors retain randomized offsets and gaps. A fifth development fans outward from a fixed entrance connected to the southeast city corner, 60 m away. Each cul-de-sac has a second residence sharing its access node. Quadratic curves are sampled into traversable segments; dead ends have turning circles. Distance-weighted routing and distance-based vehicle progress prevent short curve segments from artificially slowing cars. One-way streets remain inside the grid, avoiding disconnected suburban access roads.

Seven independent view transforms share the same live state. Pointer coordinates are inverted through the selected view before picking a car or building. Only onscreen maps render each tick to limit phone workload. The sidebar cockpit remains based on world coordinates. Native document scrolling and sticky shortcuts replace the original viewport-locked layout.

Canvas backing buffers follow CSS display dimensions multiplied by device pixel ratio, while map coordinates (780 × 780) and POV projection coordinates (640 × 640) stay fixed. Each visible frame checks sizing, so window resizing, browser zoom and monitor density changes redraw at native resolution. The POV buffer matches the cockpit pixel-for-pixel; metrics use the same sizing helper. Unchanged buffers are reused.

Rail has a dedicated polyline and train state machine, separate from road vehicles. `setupRail` builds the 75° external approach, city alignment and a visibility-graph detour around Juniper homes. Road/rail intersections become crossing gates. `tickTrains` advances three-coach trains, handles platform dwell and passenger transfers, and updates `railBlockedEdges` from the complete train footprint plus advance warning. Road routing/movement and the gridlock breakdown respect these gates. Scheduled events launch trains; road requests are injected at actual alighting. Outbound road completions enter platform waiting lists. Reset clears trains, platform queues and crossings.

## Residential rendering and transfers

`drawRanchFPV` replaces suburban residential block extrusions with low walls, doors, windows, a stoop and gable/hip roof polygons. Styles are derived deterministically from the building name; house fronts face their road access node.

## Downtown building designs

`BUILDING_DESIGNS` describes each downtown building as a few convex parts (boxes, extruded gable/vault/sawtooth profiles, frustums, pyramids, octagonal prisms, trees) in block-local coordinates, written facing south and turned by quarter turns. `makeBuildingDesign` builds them once at startup into `buildingDesigns`, a Map outside the building objects, so request/vehicle state serialization is unchanged. Styling uses a name-seeded generator and never consumes `Math.random`, preserving seeded simulation runs. Parts stay inside the ±44 POV road inset and clear the rail corridor. Juniper Park & Ride is written along its track (x along the rail, +y to its right) and built by `setupBuildingDesignsAlongRail` after `setupRail`; its design keeps the rail heading as an angle, and drawing, culling, signs and map plans rotate local points at render time while ordering stays axis-aligned in the local frame.

Train coaches are design parts too (`coachPart`). `drawBuildingsFPV` lets each trackside design (Central Stn, Park & Ride) claim coaches inside its footprint and order them with its own parts; every other coach sorts among buildings by distance. The live graph samples `currentQueueWaitMinutes` and the queue length.

Faces carry flat decorations (window grids with lit panes, doors, balconies, awnings, cornices, bay windows, clocks) drawn right after their face, plus signs whose text is affine-mapped onto the projected sign corners. `drawDesignFPV` culls buildings behind or beside the view, back-face culls faces and batches each decoration layer into one path fill. Fine detail and signs are skipped beyond `FPV_DETAIL_DIST`. Standing parts never overlap on all three axes, so `orderDesignParts` always finds a separating plane: it paints ground surfaces first, then repeatedly takes the farthest part with nothing behind it (`partBehind`). `drawDesignPlan` draws the same parts as a top-down roof plan clipped to the building square. Residential `units` weight home assignment; the population default of 450 keeps the earlier residents-per-home ratio.

## Followed bus

`updateCockpitFocal` shows a tapped car or interactive trip when there is one; otherwise it shows `followedBus`. `pickFollowedBus` chooses the Juniper Commons bus, whose neighborhood adjoins the center, and falls back to any other bus only when the followed one leaves `cars`. Reset day keeps the same bus.

`animateTransfer` is called at actual boarding and dropoff transitions, once per request. It snapshots the building center and vehicle stop position. Alighting effects interpolate for 650 ms of wall-clock time, with a 65 ms stagger for groups. Boarding effects use a playback-scaled duration and are explicitly ended when the nine-simulated-second departure pause expires, and renders as a stick figure in the maps and POV. Completed effects are pruned every tick, including while paused. Reset clears all effects. The animations never modify simulation state or count as traffic obstacles.

## Dedicated neighborhood buses

`makeCar("bus", id, development)` creates a purple 20-seat vehicle. `busDirection` restricts automatic bus assignments to inbound or outbound trips for its neighborhood. Before the original dispatch phases, available buses group eligible requests in the oldest request's direction and pass up to 20 requests to the existing multi-stop boarding/routing state machine. The remainder flows through the original sedan/shuttle phases.

Bus counts and availability exclude vehicles marked `retiring`. Such vehicles complete their already assigned service; `retireFinishedBuses` removes them only when no passengers or pickups remain and clears all their road claims and viewing references. Additional buses fill the least-served development and removals favor the most-served, keeping coverage balanced. The live panel reports both assignments and pending retirements.

## Opportunistic ride sharing

`shareQueuedRides` runs before ordinary dispatch when the 0–100% slider is enabled. It rotates through at most four buses/shuttles per tick. `tryShareRide` considers up to 12 nearby unassigned requests, inserts pickup/dropoff pairs into a bounded set of stop positions, and includes the final depot return in its distance comparison. Directed Dijkstra routes are cached within each vehicle evaluation. Capacity is checked over the entire stop sequence, including future reservations.

Existing stop order is immutable. Both total added driving and added driving before each existing stop must fit the remaining trip budget (up to four 100 m blocks at 100%). The accumulated extra distance is tracked until trip completion. Boarding time is additional and explicitly disclosed in the control. Replanning preserves the current edge and fractional progress; all road claims are replaced for the updated itinerary. Retiring and interactive vehicles are excluded, and buses retain neighborhood eligibility. A depot segment completes the shared trip through the existing vehicle state machine.

## Scope and assumptions

This remains an illustrative simulation, not an engineering traffic or accessibility model. The source's profiles, fleet, pooling strategy, traffic behavior and optional API narration are preserved. Routing still uses a simple Dijkstra queue and approximate alternate paths; “congestion” means route claims, not measured road capacity. Travel timing uses explicit road speeds and fixed simulation steps. No external map tiles, backend, geolocation or geographic dataset is needed.

## Passenger timing and totals

`simElapsed` advances monotonically while simulation time runs, independently of the daily display clock. Request timestamps, boarding timestamps and idle-depot timers use this clock. Each actual boarding calls `boardPassenger`; each delivered passenger calls `completePassenger` once. `completedCount` and `completedRideMinutes` accumulate without using the bounded history length. The HUD reports their ratio, while `completedTrips` retains only the latest 1,000 per-person ride/wait records. Daily clock rollover preserves ongoing timestamps; Reset day resets the clocks and aggregates.

## Calibrated simulation steps

`roadPath` marks neighborhood edges at 20 km/h and connector edges at 35 km/h; center grid edges use 25 km/h. `stepCars` spends elapsed seconds against each traversed edge's distance and speed, carrying remaining time across short curve segments. `simulationStep` advances the clock, dispatch, boarding, signals, traffic waits and obstacles together by three seconds. `tick` repeats whole steps according to playback speed, then renders once. Thus playback speed cannot lengthen passenger boarding or signal delays in simulated minutes. A seeded regression compares complete vehicle/queue/ride state at 1× and 20×.

Emergency vehicles use ordinary road routing/movement with dedicated outbound, scene and return states. `directionalBlocks` records incident-specific directed closures; Dijkstra and movement both respect them, while responders bypass their own incident's closure. Scene timers and rare-event schedules use `simElapsed`. Recovery requeues unboarded reservations and transfers existing rider request objects into dropoff-only segments, preserving timing and completion accounting. Route retries retain riders without replaying transfers. Emergency fleets are separate from public fleet controls and are removed after returning; repaired public vehicles return to the depot.

Private traffic uses `kind: human`, ordinary `stepCars` routing/traffic control, and `human_done` cleanup. `tickHumanTraffic` accumulates arrival credit against the original expected human obstacle rate (79.5 ticks × 3 kinds); the old human obstacle slot is skipped so jaywalker/truck rates stay unchanged. A directed-lane snapshot and `followingRoom` constrain per-tick travel behind leaders with an eight-meter gap, looking across subsequent route segments. Gridlock decomposition classifies edge claim IDs by vehicle kind and adds deduplicated active obstruction segments. The chart renders as responsive HTML bars with numeric values and percentages.

Flexible train stops cache each building's nearest projection onto the domestic rail alignment. `nextLocalTrainStop` chooses the nearest onboard dropoff or compatible nearby unassigned pickup; `serveLocalTrainStop` removes requests from the shared queue only at boarding, records normal passenger timestamps, and retains destination stop distances. A separate local dwell type preserves the scheduled leg and station order. Requests with opposite-direction destinations, distant endpoints or no remaining seat stay with road dispatch.

Through rail service retains a separate `parkRailDistance` inside the extended polyline. Each scheduled event queues two opposing trains with monotonic `dueAt` timestamps 15 simulated minutes apart; neither changes direction. The first daily event is 1.5 sim minutes after `DAY_START` (three seconds at 1×), and reset rearms it. Station dwell advances toward the next station or opposite off-map portal. Rendering offsets the two directions onto parallel tracks; crossing closures are the union of every active train’s complete footprint. Flexible stops project onto the domestic Central–Juniper segment only.

The development connectors use sampled sinusoidal offsets while preserving their endpoints. Interstate carriageways have directed mainline edges and curved directed ramps connected at the farthest development entry. Mainline portal nodes are excluded from map fitting so roads run off-map. Human traffic has a baseline visit stream plus a bounded retained pool `(slider - 1) * 5`; retained cars alternate local trips and short destination waits, and excess cars are flagged to leave via on-ramps when the slider falls. Following lookahead covers highway speeds.
