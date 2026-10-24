// Engine tests on the real street network (src/sim.js): the source app's invariants ported to
// real streets — legal moves only, capacity, rider conservation and completion, determinism
// across playback speeds, reset, dispatch phases, ride sharing, emergencies with one-direction
// closures, breakdown recovery, private and freeway through-traffic, live fleet changes — plus
// the 300-vehicle regression run with its timing. Run: node tests/sim.test.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const G = require(path.join(ROOT, "src/graph.js"));
const R = require(path.join(ROOT, "src/routing.js"));
const Sim = require(path.join(ROOT, "src/sim.js"));

const sb = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "data/mpls_graph.js"), "utf8"), sb);
const graph = G.decodeMplsGraph(sb.window.MPLS_GRAPH);
const router = R.createRouter(graph);   // shared: its caches and trees only depend on the graph
const make = (o = {}) => Sim.createSim(graph, { router, ...o });
const isPortal = (v) => !!(graph.nodes.flags[v] & G.NODE_PORTAL);

function assertClean(sim) {
  const p = sim.audit();
  assert.deepStrictEqual(p, [], p.slice(0, 5).join("; "));
}
// Every request ever made is in exactly one place: queued, assigned and waiting, aboard, or done.
function riderLedger(sim, all) {
  const S = sim.state;
  const where = new Map();
  const mark = (r, w) => { assert.ok(!where.has(r.id), `r#${r.id} both ${where.get(r.id)} and ${w}`); where.set(r.id, w); };
  for (const r of S.queue) mark(r, "queued");
  for (const v of S.vehicles) {
    for (const r of v.riders) mark(r, "aboard " + v.id);
    for (const r of v.pickupQueue) if (!v.riders.includes(r)) mark(r, "assigned " + v.id);
  }
  for (const r of all.values()) if (r.completedAt != null) mark(r, "done");
  for (const r of all.values()) assert.ok(where.has(r.id), `r#${r.id} was lost`);
  return where;
}
// Collect request objects as they appear, so the ledger can find lost ones.
function trackRequests(sim, all) {
  for (const r of sim.state.queue) all.set(r.id, r);
  for (const v of sim.state.vehicles) { for (const r of v.riders) all.set(r.id, r); for (const r of v.pickupQueue) all.set(r.id, r); }
}

// ------------------------------------------------------------ placement on the connected core
{
  const sim = make();
  const S = sim.state;
  assert.ok(S.places.length >= 120, `placeholder places (${S.places.length})`);
  for (const p of [...S.places, ...S.depots, S.base]) {
    assert.ok(sim.core.inCore[p.node], `${p.name} is outside the connected core`);
    assert.ok(!isPortal(p.node));
  }
  assert.strictEqual(new Set(S.places.map((p) => p.node)).size, S.places.length, "one place per node");
  assert.ok(S.depots.length === 5 && new Set(S.depots.map((d) => d.node)).size === 5, "five distinct depots");
  // Depots snap close to their (approximate) ramp coordinates.
  for (const [i, d] of S.depots.entries()) {
    const site = Sim.DEFAULTS.depots[i];
    const [s, w, n, e] = graph.bbox;
    const x = (site.lon - w) / (e - w) * graph.width, y = (n - site.lat) / (n - s) * graph.height;
    assert.ok(Math.hypot(d.x - x, d.y - y) < 150, `${d.name} snapped ${Math.round(Math.hypot(d.x - x, d.y - y))} m away`);
  }
  for (const a of S.places) for (const b of [S.places[0], S.depots[0]]) assert.ok(sim.routeAvoiding(a.node, b.node, R.MODE_PSV), "places reach each other");
  const P = sim.portals;
  assert.ok(P.freewayIn.length >= 4 && P.freewayOut.length >= 4 && P.throughRoutes.length >= 20);
  assert.ok(P.throughRoutes.every((r) => isPortal(r.from) && isPortal(r.to) && r.length > 1500));
  assert.ok(P.localEntries.length > 100 && P.localExits.length > 100);
  console.log(`PASS: ${S.places.length} placeholder places, 5 depots and the base all in the connected core; ` +
    `${P.throughRoutes.length} freeway through-routes, ${P.localEntries.length} local entry portals.`);
}

// ------------------------------------------------------------ regression run: legality, capacity, conservation, 300+ vehicles, timing
{
  const sim = make({ seed: 7 });
  const all = new Map();
  let maxOnRoad = 0, worst = 0, peakMs = 0, peakMinutes = 0;
  const t0 = Date.now();
  for (let minute = 0; minute < 150; minute++) {
    for (let k = 0; k < 20; k++) {
      sim.step();
      trackRequests(sim, all);
    }
    // A 20-step block is one frame at 20× playback.
    const s0 = process.hrtime.bigint();
    sim.run(20);
    const ms = Number(process.hrtime.bigint() - s0) / 1e6;
    trackRequests(sim, all);
    if (ms > worst) worst = ms;
    if (minute >= 20 && minute < 80) { peakMs += ms; peakMinutes++; }
    const c = sim.counts();
    if (c.onRoad > maxOnRoad) maxOnRoad = c.onRoad;
    if (minute % 5 === 0) { assertClean(sim); riderLedger(sim, all); }
    for (const v of sim.state.vehicles) {
      assert.ok(v.riders.length <= v.capacity, `${v.id} over capacity`);
      if (v.kind === "private" && v.route) for (const a of v.route) assert.ok(!sim.router.arcs[a].psvOnly, "private car routed on a shuttle-only arc");
      if (v.route) for (let i = 0; i < v.route.length - 1; i++) assert.ok(!isPortal(sim.router.arcs[v.route[i]].to), "route passes through a portal");
    }
    for (const r of sim.state.queue) assert.ok(sim.core.inCore[r.pickup] && sim.core.inCore[r.dropoff], "trips start and end in the core");
  }
  assertClean(sim);
  const ledger = riderLedger(sim, all);
  const S = sim.state;
  assert.ok(maxOnRoad >= 300, `peak vehicles on the road ${maxOnRoad} (need 300+)`);
  assert.ok(S.completed > 1500, `completed rides ${S.completed}`);
  assert.ok(S.pooled > 200 && S.sharedPickups > 50, "pooling and ride sharing happen");
  assert.ok(sim.averageQueueMinutes() > 0 && S.rideSeconds / S.completed > 120);
  assert.strictEqual([...ledger.values()].filter((w) => w === "done").length, S.completed, "completed count matches the riders delivered");
  const perFrame = peakMs / peakMinutes;
  assert.ok(perFrame < 30, `a 20× frame of simulation took ${perFrame.toFixed(1)} ms at peak`);
  console.log(`PASS: 2.5 h from 07:30 (seed 7): ${S.completed} rides delivered, ${S.pooled} pooled, ${S.sharedPickups} shared pickups, ` +
    `peak ${maxOnRoad} vehicles on the road; audit clean, no rider lost or duplicated, capacity and legality hold. ` +
    `20× frame: ${perFrame.toFixed(1)} ms average over the AM peak, worst ${worst.toFixed(1)} ms (desktop Node; ${(Date.now() - t0) / 1000} s run).`);
}

// ------------------------------------------------------------ determinism across playback speeds, seeds and reset
{
  const a = make({ seed: 11 }), b = make({ seed: 11 }), c = make({ seed: 12 });
  a.run(600);
  for (let i = 0; i < 30; i++) b.run(20);
  c.run(600);
  assert.strictEqual(a.snapshot(), b.snapshot(), "1× and 20× playback give identical simulations");
  assert.notStrictEqual(a.snapshot(), c.snapshot(), "another seed gives another day");
  a.reset();
  const fresh = make({ seed: 11 });
  assert.strictEqual(a.snapshot(), fresh.snapshot(), "reset restores the start of the day");
  const S = a.state;
  assert.ok(S.t === 0 && S.queue.length === 0 && S.completed === 0 && S.incidents.length === 0 && S.closures.size === 0);
  assert.ok(S.vehicles.every((v) => ["sedan", "shuttle", "bus"].includes(v.kind) && v.state === "idle" && S.depots.some((d) => d.node === v.node)));
  console.log("PASS: identical runs at 1× and 20×, different seeds differ, Reset day restores the opening state.");
}

// ------------------------------------------------------------ dispatch phases
{
  const sim = make({ population: 0, privateTraffic: 0, rareEvents: false });
  const S = sim.state;
  const home = S.byType.residential, work = S.byType.employer;
  // Same pickup and destination: one sedan carpool.
  const carpool = [0, 1, 2].map(() => sim.addRequest(home[0], work[0]));
  sim.dispatch();
  const sedan = S.vehicles.find((v) => v.pickupQueue.includes(carpool[0]));
  assert.ok(sedan && sedan.kind === "sedan" && carpool.every((r) => sedan.pickupQueue.includes(r)), "sedan carpool");
  // Same destination, different pickups: a shuttle pool, pickups before dropoffs.
  const pool = [1, 2, 3, 4, 5].map((i) => sim.addRequest(home[i], work[1]));
  sim.dispatch();
  const shuttle = S.vehicles.find((v) => v.pickupQueue.includes(pool[0]));
  assert.ok(shuttle && shuttle.kind === "shuttle" && pool.every((r) => shuttle.pickupQueue.includes(r)), "shuttle pool");
  const types = [shuttle.active, ...shuttle.segments].map((s) => s.type);
  assert.strictEqual(types.lastIndexOf("pickup") < types.indexOf("dropoff"), true);
  // Heavy backlog at one origin: a bus sweep.
  const sweep = Array.from({ length: 18 }, (_, i) => sim.addRequest(home[6], work[2 + (i % 6)]));
  sim.dispatch();
  const bus = S.vehicles.find((v) => v.pickupQueue.includes(sweep[0]));
  assert.ok(bus && bus.kind === "bus" && bus.pickupQueue.length === 18, "bus sweep of the busiest origin");
  // A single rider: the nearest idle sedan.
  const single = sim.addRequest(home[7], work[7]);
  sim.dispatch();
  const car = S.vehicles.find((v) => v.pickupQueue.includes(single));
  assert.strictEqual(car.kind, "sedan");
  const idleSedans = S.vehicles.filter((v) => v.kind === "sedan" && v.state === "idle" && v !== car);
  const d = (v) => Math.hypot(graph.nodes.x[v.node] - home[7].x, graph.nodes.y[v.node] - home[7].y);
  assert.ok(idleSedans.every((v) => d(v) >= d(car) - 1e-9), "nearest idle sedan");
  assert.strictEqual(S.queue.length, 0);
  // Everyone is delivered.
  for (let i = 0; i < 1200 && S.completed < 27; i++) sim.step();
  assert.strictEqual(S.completed, 27, `all 27 riders delivered (${S.completed})`);
  assertClean(sim);
  console.log("PASS: sedan carpool, shuttle pool (pickups first), bus sweep of an 18-rider backlog, nearest idle sedan; all 27 delivered.");
}

// ------------------------------------------------------------ ride sharing: insertion, capacity, budget, stop order
{
  const sim = make({ population: 0, privateTraffic: 0, rareEvents: false, sedans: 0, buses: 0 });
  const S = sim.state;
  const homes = S.byType.residential, jobs = S.byType.employer;
  // A long pooled trip, then a request near its first pickup going near its destination.
  const far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const [from, to] = [homes, jobs].map((list) => list.slice().sort((p, q) => p.x - q.x));
  const first = sim.addRequest(from[0], to[to.length - 1]);
  const second = sim.addRequest(from[1], to[to.length - 1]);
  sim.dispatch();
  const v = S.vehicles.find((x) => x.pickupQueue.includes(first));
  const originalOrder = [v.active, ...v.segments].map((s) => s.node);
  // A rider at the same place as the first pickup, to the same destination: zero detour.
  const extra = sim.addRequest(from[0], to[to.length - 1]);
  sim.setRideSharing(0);
  assert.strictEqual(sim.tryShareRide(v), false, "0 % ride sharing adds nobody");
  sim.setRideSharing(100);
  assert.strictEqual(sim.tryShareRide(v), true, "on-the-way pickup inserted");
  assert.ok(v.pickupQueue.includes(extra) && !S.queue.includes(extra));
  const after = [v.active, ...v.segments].map((s) => s.node);
  let k = 0;
  for (const n of after) if (n === originalOrder[k]) k++;
  assert.strictEqual(k, originalOrder.length, "existing stops keep their order");
  assert.ok(v.sharingDetour <= 400 + 1e-6);
  // Far-away riders are not picked up on the way.
  const remote = sim.addRequest(from[from.length - 1], to[0]);
  assert.ok(far(from[from.length - 1], from[0]) > 2000);
  assert.strictEqual(sim.tryShareRide(v), false, "a rider kilometres off the route waits for dispatch");
  // Capacity: fill the shuttle's seats and nobody more is added.
  S.queue.splice(S.queue.indexOf(remote), 1);
  while (v.pickupQueue.length < v.capacity) { sim.addRequest(from[0], to[to.length - 1]); assert.ok(sim.tryShareRide(v)); }
  sim.addRequest(from[0], to[to.length - 1]);
  assert.strictEqual(sim.tryShareRide(v), false, "a full shuttle takes no one else");
  for (let i = 0; i < 1500 && S.completed < v.capacity; i++) { sim.step(); assert.ok(v.riders.length <= v.capacity); }
  assert.ok(S.completed >= v.capacity, "shared riders delivered");
  assertClean(sim);
  console.log("PASS: ride sharing off at 0 %, zero-detour insertion keeps stop order within the 400 m budget, distant riders and full shuttles refused.");
}

// ------------------------------------------------------------ emergencies: one-direction closure, detours, cleanup
{
  const sim = make({ seed: 5, rareEvents: false, privateTraffic: 1 });
  sim.run(200);
  const S = sim.state;
  const target = S.places.find((p) => p.type === "employer");
  const inc = sim.triggerEmergency("fire", target);
  assert.strictEqual(inc.responders.length, 4);
  let closedArc = -1, closedAt = -1;
  const entered = [];
  for (let i = 0; i < 400 && closedArc < 0; i++) {
    sim.step();
    if (S.closures.size) { closedArc = [...S.closures.keys()][0]; closedAt = S.t; }
  }
  assert.ok(closedArc >= 0, "first fire truck on scene closes its arrival direction");
  const arc = sim.router.arcs[closedArc];
  assert.strictEqual(arc.to, target.node);
  const reverse = sim.router.arcs.findIndex((a) => a.link === arc.link && a !== arc);
  if (reverse >= 0) assert.ok(!sim.motion.closed[reverse], "the opposite direction stays open");
  // New routes avoid the closure (responders to this incident excepted).
  const r = sim.routeAvoiding(arc.from, target.node, R.MODE_PSV);
  assert.ok(r && !r.arcs.includes(closedArc), "detour around the closure");
  const onArc = new Set(S.vehicles.filter((v) => v.lane >= 0 && v.route[v.ri] === closedArc).map((v) => v.id));
  while (S.closures.size) {
    sim.step();
    // (The step that lifts the closure reopens the arc before anyone moves.)
    if (S.closures.has(closedArc))
      for (const v of S.vehicles) if (v.lane >= 0 && v.route[v.ri] === closedArc && !onArc.has(v.id) && v.passTag !== inc.id) entered.push(v.id);
    for (const v of S.vehicles) if (v.lane >= 0 && v.route[v.ri] === closedArc) onArc.add(v.id);
    assertClean(sim);
  }
  assert.deepStrictEqual(entered, [], "only this incident's responders drive into the closed direction");
  assert.ok(S.t - closedAt >= 10 * 60 - 3, "fire scenes close the road for 10 minutes");
  for (let i = 0; i < 800 && S.incidents.length; i++) sim.step();
  assert.strictEqual(S.incidents.length, 0, "incident finished");
  assert.ok(!S.vehicles.some((v) => ["police", "fire", "firecar"].includes(v.kind)), "responders return and leave");
  const p = sim.triggerEmergency("police", S.places[3]);
  assert.deepStrictEqual(p.responders.map((v) => v.kind), ["police"]);
  console.log("PASS: fire crew closes only its arrival direction for 10 min, others detour and never enter it, responders return; police send one car.");
}

// ------------------------------------------------------------ breakdown and recovery
{
  const sim = make({ seed: 9, rareEvents: false });
  const S = sim.state;
  let victim = null;
  for (let i = 0; i < 2000 && !victim; i++) {
    sim.step();
    victim = S.vehicles.find((v) => v.kind === "shuttle" && v.riders.length >= 2 && v.lane >= 0 && v.state === "enroute_dropoff");
  }
  assert.ok(victim, "a loaded shuttle on the road");
  const riders = victim.riders.slice();
  const boarded = riders.map((r) => r.pickedUpAt);
  sim.breakdown(victim);
  let rescue = null;
  for (let i = 0; i < 200 && !rescue; i++) { sim.step(); rescue = S.vehicles.find((v) => v.kind === "recovery"); }
  assert.ok(rescue && victim.state === "trouble", "stalled at the next intersection, recovery dispatched");
  assert.strictEqual(victim.lane, -1, "stalled vehicle is off the road");
  for (let i = 0; i < 2000 && !riders.every((r) => r.completedAt != null); i++) { sim.step(); assertClean(sim); }
  assert.ok(riders.every((r) => r.completedAt != null), "every stranded rider delivered");
  assert.deepStrictEqual(riders.map((r) => r.pickedUpAt), boarded, "boarding times preserved");
  for (let i = 0; i < 1500 && (victim.state !== "idle" || S.vehicles.some((v) => v.kind === "recovery")); i++) sim.step();
  assert.strictEqual(victim.state, "idle", "repaired shuttle back in service");
  assert.ok(!S.vehicles.some((v) => v.kind === "recovery"), "recovery vehicle leaves after its run");
  console.log("PASS: breakdown pulls over at the next intersection; recovery delivers every rider with boarding times kept; shuttle repaired.");
}

// ------------------------------------------------------------ private traffic and freeway through-traffic
{
  const sim = make({ seed: 4, population: 0, sedans: 0, shuttles: 0, buses: 0, rareEvents: false, privateTraffic: 2 });
  const S = sim.state;
  const seen = new Map();
  const exits = new Set(sim.portals.freewayOut);
  let throughDone = 0, localDone = 0;
  for (let i = 0; i < 2400; i++) {
    const before = new Set(S.vehicles);
    sim.step();
    for (const v of S.vehicles) if (!seen.has(v)) seen.set(v, { start: v.node, through: !!v.through });
    for (const v of before) if (!S.vehicles.includes(v) && v.removed) {
      const info = seen.get(v);
      assert.ok(isPortal(v.node), `${v.id} left the map at a portal`);
      if (info.through) { assert.ok(exits.has(v.node), "through-traffic leaves on a freeway"); throughDone++; }
      else localDone++;
    }
    if (i % 100 === 0) assertClean(sim);
  }
  for (const [, info] of seen) assert.ok(isPortal(info.start), "private traffic enters at a portal");
  assert.ok(S.parked.length > 0 && S.parked.every((v) => v.state === "private_parked" && sim.core.inCore[v.node]), "visitors park in the core");
  for (let i = 1; i < S.parked.length; i++) assert.ok(S.parked[i - 1].departAt <= S.parked[i].departAt, "parked cars queue by departure time");
  assert.ok(throughDone > 300 && localDone > 20, `through ${throughDone}, local round trips ${localDone}`);
  sim.setPrivateTraffic(0);
  const n = S.vehicles.length;
  sim.run(100);
  assert.ok(S.vehicles.length <= n, "no new private traffic at 0×");
  console.log(`PASS: private traffic enters at portals, visitors park in the core and leave; ${throughDone} freeway through-trips exit on a freeway.`);
}

// ------------------------------------------------------------ live fleet and population changes
{
  const sim = make({ seed: 2, rareEvents: false });
  const S = sim.state;
  sim.run(300);
  const busy = S.vehicles.filter((v) => v.kind === "shuttle" && v.state !== "idle").length;
  assert.ok(busy > 10);
  sim.setFleet("shuttle", 10);
  assert.strictEqual(sim.countFleet("shuttle"), 10);
  const retiring = S.vehicles.filter((v) => v.kind === "shuttle" && v.retiring);
  assert.ok(retiring.length > 0, "busy shuttles retire after their riders");
  for (let i = 0; i < 2500 && S.vehicles.some((v) => v.kind === "shuttle" && v.retiring); i++) { sim.step(); assertClean(sim); }
  assert.strictEqual(S.vehicles.filter((v) => v.kind === "shuttle").length, 10, "retired shuttles leave once empty");
  assert.ok(retiring.every((v) => v.riders.length === 0 && v.pickupQueue.length === 0));
  sim.setFleet("bus", 14);
  assert.strictEqual(S.vehicles.filter((v) => v.kind === "bus").length, 14);
  sim.setPopulation(1000);
  assert.strictEqual(S.humans.length, 1000);
  sim.setPopulation(3000);
  assert.strictEqual(S.humans.length, 3000);
  console.log("PASS: fleet shrinks by retiring busy vehicles after their riders, grows at depots; population adjusts live.");
}
