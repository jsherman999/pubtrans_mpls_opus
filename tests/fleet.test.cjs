// Phase 6: SDEV scenario controls and the fleet at scale — grid-indexed dispatch, pooling by area,
// transit and car-share levers, depots, electric range and charging, rebalancing toward expected
// riders — and the exit checks: a full AM peak at 1:20 fast enough for 10× playback on desktop,
// and a fleet-size sweep that finds the fleet meeting a target average wait.
// Run: node tests/fleet.test.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const G = require(path.join(ROOT, "src/graph.js"));
const R = require(path.join(ROOT, "src/routing.js"));
const Sim = require(path.join(ROOT, "src/sim.js"));
const { sweep } = require(path.join(ROOT, "tools/fleet_sweep.cjs"));
const load = (file, key) => { const sb = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sb); return sb.window[key]; };
const graph = G.decodeMplsGraph(load("data/mpls_graph.js", "MPLS_GRAPH"));
const demandRaw = load("data/mpls_demand.js", "MPLS_DEMAND");
const router = R.createRouter(graph);
const census = (o = {}) => Sim.createSim(graph, { router, seed: 3, demand: demandRaw, ...o });
const place = (o = {}) => Sim.createSim(graph, { router, seed: 3, rareEvents: false, ...o });
const dist = (a, b) => Math.hypot(graph.nodes.x[a] - graph.nodes.x[b], graph.nodes.y[a] - graph.nodes.y[b]);
const anchor = (sim, v) => (v.lane >= 0 ? sim.router.arcs[v.route[v.ri]].to : v.node);

// ------------------------------------------------------------ grid-indexed nearest vehicle
{
  const sim = census();
  sim.run(20 * 90);                                  // 07:00: vehicles spread out
  const core = sim.core.nodes;
  for (let k = 0; k < 300; k++) {
    const node = core[(k * 7919) % core.length];
    for (const kind of ["sedan", "shuttle", "bus"]) {
      sim.clearIndex();
      const brute = sim.findIdle(kind, node);
      sim.indexAvailable();
      const fast = sim.findIdle(kind, node);
      sim.clearIndex();
      assert.strictEqual(!!fast, !!brute);
      if (brute) assert.ok(Math.abs(dist(anchor(sim, fast), node) - dist(anchor(sim, brute), node)) < 1e-9, "grid search finds the nearest vehicle");
    }
  }
  console.log("PASS: grid-indexed dispatch finds the same nearest free vehicle as a full scan (300 places, three kinds).");
}

// ------------------------------------------------------------ pooling by area, and pooling off
{
  const pooled = census({ rideSharing: 100 }), solo = census({ rideSharing: 0 });
  pooled.run(20 * 150); solo.run(20 * 150);
  assert.strictEqual(solo.state.pooled, 0, "pooling 0 %: one rider per trip");
  assert.strictEqual(solo.state.sharedPickups, 0);
  assert.ok(pooled.state.pooled > 1000, `pooling 100 %: riders share (${pooled.state.pooled})`);
  // Pools and carpools stay compact: every group's pickups lie in one 600 m area, as do its dropoffs.
  const cell = (n) => `${Math.floor(graph.nodes.x[n] / 600)},${Math.floor(graph.nodes.y[n] / 600)}`;
  let checked = 0;
  for (const v of pooled.state.vehicles) {
    const reqs = [...new Set([...v.riders, ...v.pickupQueue])];
    if (!["POOL", "SEDAN"].includes(v.assignTag) || reqs.length < 2 || v.sharedCount > 0) continue;   // no on-the-way additions
    checked++;
    assert.strictEqual(new Set(reqs.map((r) => cell(r.pickup))).size, 1, `${v.id} pickups in one area`);
    assert.strictEqual(new Set(reqs.map((r) => cell(r.dropoff))).size, 1, `${v.id} dropoffs in one area`);
  }
  assert.ok(checked > 5, `pools in progress checked (${checked})`);
  assert.ok(pooled.averageQueueMinutes() < solo.averageQueueMinutes(), "pooling shortens waits when vehicles are scarce");
  console.log(`PASS: pooling 100 % pools ${(pooled.state.pooled * 20).toLocaleString()} riders by 08:00 in compact 600 m areas ` +
    `(avg wait ${pooled.averageQueueMinutes().toFixed(1)} min vs ${solo.averageQueueMinutes().toFixed(1)} min with pooling off).`);
}

// ------------------------------------------------------------ transit and car-share levers
{
  const on = census(), off = census({ transitReplaced: false }), allCars = census({ carShare: 1 }), noCars = census({ carShare: 0 });
  for (const s of [on, off, allCars, noCars]) s.run(20 * 120);
  assert.strictEqual(on.state.transitTrips, 0);
  assert.ok(off.state.transitTrips > 0 && off.state.shuttleTrips < on.state.shuttleTrips * 0.75, "without transit replacement, transit riders are not shuttle riders");
  assert.ok(allCars.state.carTrips > on.state.carTrips * 1.6 && noCars.state.carTrips === 0, "car share 100 % / 0 %");
  assert.ok(noCars.state.shuttleTrips > on.state.shuttleTrips, "every car trip moved to shuttles");
  console.log(`PASS: by 07:30, transit replaced: ${on.state.shuttleTrips.toLocaleString()} shuttle trips; not replaced: ${off.state.shuttleTrips.toLocaleString()} ` +
    `(+${off.state.transitTrips.toLocaleString()} on transit); cars kept 100 %: ${allCars.state.carTrips.toLocaleString()} car trips, 0 %: none.`);
}

// ------------------------------------------------------------ depots
{
  const sim = place();
  const S = sim.state;
  assert.strictEqual(S.depots.filter((d) => d.active).length, 5);
  const first = S.depots[0];
  const parked = S.vehicles.filter((v) => v.node === first.node && v.lane < 0).length;
  assert.ok(parked > 0);
  assert.ok(sim.setDepotActive(0, false));
  sim.run(200);
  assert.strictEqual(S.vehicles.filter((v) => v.node === first.node && v.lane < 0 && v.state === "idle").length, 0, "a closed depot's vehicles leave");
  for (let i = 1; i < 4; i++) sim.setDepotActive(i, false);
  assert.strictEqual(sim.setDepotActive(4, false), false, "the last open depot stays open");
  const node = S.places.find((p) => p.type === "employer").node;
  const d = sim.addDepot(node, "Test depot");
  assert.ok(d && d.active && S.depots.length === 6);
  sim.setFleet("sedan", sim.countFleet("sedan") + 10);
  const fresh = S.vehicles.filter((v) => v.kind === "sedan").slice(-10);
  assert.ok(fresh.every((v) => S.depots.some((x) => x.active && x.node === v.node)), "new vehicles start at open depots");
  sim.reset();
  assert.strictEqual(sim.state.depots.length, 6, "depot changes survive Reset day");
  assert.deepStrictEqual(sim.state.depots.map((x) => x.active), [false, false, false, false, true, true]);
  console.log("PASS: closing a depot moves its vehicles to an open one, the last cannot close, a new depot takes new vehicles, Reset day keeps the change.");
}

// ------------------------------------------------------------ electric fleet
{
  const sim = place({ population: 0, privateTraffic: 0 });
  const S = sim.state;
  const v = S.vehicles.find((x) => x.kind === "shuttle");
  assert.strictEqual(v.battery, 110); assert.strictEqual(v.kwh, 110);
  // Drive it to the far side of the map and back: energy follows the odometer.
  const far = S.places.reduce((a, p) => (dist(p.node, v.node) > dist(a.node, v.node) ? p : a));
  v.state = "repositioning"; v.target = far.node;
  sim.motion.setRoute(v, sim.routeAvoiding(v.node, far.node, R.MODE_PSV).arcs);
  for (let i = 0; i < 400 && v.state === "repositioning"; i++) sim.step();
  const used = 110 - v.kwh;
  assert.ok(Math.abs(used - v.odo / 1000 * 0.32) < 0.01, `energy ${used.toFixed(2)} kWh for ${(v.odo / 1000).toFixed(2)} km`);
  // A nearly flat shuttle is not dispatched; it drives to a depot, charges to 80 % and returns to service.
  v.kwh = 0.1 * v.battery;
  const req = sim.addRequest(S.places[0], S.places[1]);
  sim.indexAvailable();
  assert.notStrictEqual(sim.findIdle("shuttle", req.pickup), v, "below 15 % a vehicle takes no riders");
  sim.clearIndex();
  let charged = false, sawCharging = false;
  for (let i = 0; i < 4000 && !charged; i++) {
    sim.step();
    if (v.state === "charging") { sawCharging = true; assert.ok(S.depots.some((d) => d.node === v.node)); }
    if (sawCharging && v.state === "idle") charged = true;
  }
  assert.ok(charged && v.kwh >= 0.8 * v.battery - 1e-9, `charged to ${Math.round(100 * v.kwh / v.battery)} %`);
  assert.ok(S.chargeSessions >= 1);
  // At 150 kW from 10 % to 80 %: 77 kWh takes about 31 minutes.
  console.log(`PASS: a shuttle uses 0.32 kWh/km (${used.toFixed(1)} kWh for ${(v.odo / 1000).toFixed(1)} km); below 15 % it takes no riders, charges at a depot to 80 % and returns to service.`);
}

// ------------------------------------------------------------ rebalancing toward expected riders
{
  const withR = census(), without = census({ rebalance: false });
  // 06:45, before the rush: how far is the nearest free shuttle from each rider who asks in the next 30 minutes?
  withR.run(20 * 75); without.run(20 * 75);
  assert.ok(withR.state.repositions > 20, `idle vehicles repositioned (${withR.state.repositions})`);
  const upcoming = withR.state.trips.filter((t) => t.minute >= withR.state.minute && t.minute < withR.state.minute + 30 && t.mode === "shuttle" && t.from.zone != null);
  const meanDistance = (sim) => {
    const free = sim.state.vehicles.filter((v) => v.kind === "shuttle" && (v.state === "idle" || v.state === "repositioning"));
    const nodes = free.map((v) => (v.state === "repositioning" ? v.target : anchor(sim, v)));
    const zoneNodes = upcoming.map((t) => sim.state.places.find((p) => p.zones && p.zones.includes(t.from.zone)).node);
    return zoneNodes.reduce((s, z) => s + Math.min(...nodes.map((n) => dist(n, z))), 0) / zoneNodes.length;
  };
  const a = meanDistance(withR), b = meanDistance(without);
  assert.ok(a < b * 0.9, `free shuttles sit nearer to upcoming riders (${Math.round(a)} m vs ${Math.round(b)} m)`);
  console.log(`PASS: rebalancing moves ${withR.state.repositions} idle agents by 06:45; the nearest free shuttle is ${Math.round(a)} m from upcoming riders (${Math.round(b)} m without).`);
}

// ------------------------------------------------------------ exit: AM peak speed and the fleet-size sweep
{
  const sim = census({ seed: 1 });
  const times = [];
  const steps = (10 * 60 - 5.5 * 60) * 20;
  for (let i = 0; i < steps; i += 10) {
    const t0 = process.hrtime.bigint();
    sim.run(10);
    if (sim.state.minute >= 7 * 60) times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((x, y) => x - y);
  const avg = times.reduce((x, y) => x + y, 0) / times.length, p95 = times[Math.floor(times.length * 0.95)];
  // 10× playback = 10 steps per 100 ms frame. Desktop Chrome runs this code about 1.5–2× slower
  // than Node (measured in Phases 3d–5), and drawing takes a few ms more.
  assert.ok(avg < 35 && p95 < 50, `AM peak at 1:20: ${avg.toFixed(1)} ms average, ${p95.toFixed(1)} ms p95 per 10 steps`);
  assert.deepStrictEqual(sim.audit(), []);

  const result = sweep({ scales: [0.4, 1], until: "10:00", target: 15, sampling: 20, seed: 1, day: 2, carShare: 0.5 }, () => {});
  const [small, big] = result.rows;
  assert.ok(small.avgWaitMin > big.avgWaitMin + 5, `a bigger fleet cuts waits (${small.avgWaitMin} → ${big.avgWaitMin} min)`);
  assert.ok(result.recommended && result.recommended.scale === 1, "the sweep picks the fleet that meets the 15-minute target (the default)");
  assert.ok(big.stillWaiting < 1000);
  console.log(`PASS: AM peak 07:00–10:00 at 1:20 runs ${avg.toFixed(1)} ms average (p95 ${p95.toFixed(1)}) per 10 steps in Node; ` +
    `sweep: ${small.fleet.total.toLocaleString()} vehicles → ${small.avgWaitMin} min average wait, ${big.fleet.total.toLocaleString()} → ${big.avgWaitMin} min, ` +
    `recommended ×${result.recommended.scale} for 15 min.`);
}
