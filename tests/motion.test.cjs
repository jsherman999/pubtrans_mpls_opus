// Vehicle motion (src/motion.js): time-based movement across short links, following gaps
// within and across links, signals, stop signs, closures with spill-back and drain, lanes,
// legality, a random stress run, and a 400-vehicle run on the real street network.
// Run: node tests/motion.test.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const G = require(path.join(ROOT, "src/graph.js"));
const R = require(path.join(ROOT, "src/routing.js"));
const T = require(path.join(ROOT, "src/traffic.js"));
const M = require(path.join(ROOT, "src/motion.js"));
const { makeSynthGrid, mulberry32 } = require("./fixtures/synth_grid.cjs");

// Small hand-built network in data/mpls_graph.js format. nodes: [x, y, flags?, ctl?] in meters;
// links: { a, b, dir = 1, kph = 36, lf = 1, lb = 0, flags = 0, sigA = -1, sigB = -1 }.
function tiny(nodes, links, controllers = 0) {
  const U = 10;
  const raw = {
    v: 1, label: "tiny", attribution: "test", bbox: [0, 0, 0, 0], size: [5000 * U, 5000 * U], unitsPerMeter: U,
    classes: ["residential"], names: [""],
    nodes: { x: nodes.map((n) => n[0] * U), y: nodes.map((n) => n[1] * U), flags: nodes.map((n) => n[2] || 0), ctl: nodes.map((n) => n[3] ?? -1) },
    controllers: { axis: Array(controllers).fill(0) },
    links: { a: [], b: [], dir: [], kph: [], lf: [], lb: [], cls: [], flags: [], name: [], sigA: [], sigB: [], len: [], way: [], shp: [] },
    shapes: [],
  };
  for (const l of links) {
    const L = raw.links;
    L.a.push(l.a); L.b.push(l.b); L.dir.push(l.dir ?? 1); L.kph.push(l.kph ?? 36);
    L.lf.push(l.lf ?? 1); L.lb.push(l.lb ?? 0); L.cls.push(0); L.flags.push(l.flags ?? 0); L.name.push(0);
    L.sigA.push(l.sigA ?? -1); L.sigB.push(l.sigB ?? -1); L.len.push(0); L.way.push(1); L.shp.push(0);
  }
  return G.decodeMplsGraph(raw);
}
function world(g, sigOpts = {}) {
  const router = R.createRouter(g);
  const signals = T.createSignals(g, sigOpts);
  const motion = M.createMotion(g, router, signals);
  return { g, router, signals, motion };
}
const arcOf = (router, from, to) => router.arcs.findIndex((a) => a.from === from && a.to === to);
function vehicle(id, mode = R.MODE_GENERAL) { return { id, mode }; }
function routeOf(w, from, to, mode = R.MODE_GENERAL) { return w.router.search(from, to, { mode }).arcs; }
function assertClean(motion, list) {
  const p = motion.check(list);
  assert.deepStrictEqual(p, [], p.slice(0, 5).join("; "));
}

// ------------------------------------------------------------ time-based movement, carried across short links
{
  // 10 m/s corridor: three 5 m links, then 85 m, then 100 m.
  const w = world(tiny([[0, 0], [5, 0], [10, 0], [15, 0], [100, 0], [200, 0]],
    [0, 1, 2, 3, 4].map((i) => ({ a: i, b: i + 1 }))));
  const v = vehicle("v");
  w.motion.place(v, 0);
  w.motion.setRoute(v, routeOf(w, 0, 5));
  w.motion.step([v], 0, 3);
  assert.strictEqual(v.ri, 3, "30 m in 3 s crosses the three short links");
  assert.ok(Math.abs(v.s - 15) < 1e-9, `15 m along the fourth link (got ${v.s})`);
  const pos = w.motion.locate(v);
  assert.ok(Math.abs(pos.x - 30) < 1e-9 && Math.abs(pos.y) < 1e-9, "position is 30 m from the start, on the centreline of a one-way");
  let arrived = [];
  for (let t = 3; t < 30 && !arrived.length; t += 3) arrived = w.motion.step([v], t, 3);
  assert.deepStrictEqual(arrived, [v]);
  assert.strictEqual(v.node, 5); assert.strictEqual(v.lane, -1); assert.strictEqual(v.route, null);
  assertClean(w.motion, [v]);
  console.log("PASS: time-based movement carries across short links and arrives at the route's end node.");
}

// ------------------------------------------------------------ following gap within and across links, red signal
{
  // 0 -(100 m)- 1 -(4 m)- 2[signal] -(96 m)- 3. Arc 1->2 is phase group 1: red for t in [0, 33).
  const w = world(tiny([[0, 0], [100, 0], [104, 0, 2, 0], [200, 0]],
    [{ a: 0, b: 1 }, { a: 1, b: 2, sigB: 1 }, { a: 2, b: 3 }], 1), { offsets: [0] });
  const lead = vehicle("lead"), follow = vehicle("follow"), third = vehicle("third");
  for (const v of [lead, follow, third]) { w.motion.place(v, 0); w.motion.setRoute(v, routeOf(w, 0, 3)); }
  // They leave node 0 one second apart; afterwards the list is deliberately back to front, and
  // leaders still move before their followers.
  w.motion.step([lead], 0, 1); w.motion.step([lead, follow], 1, 1); w.motion.step([lead, follow, third], 2, 1);
  const list = [third, follow, lead];
  for (let t = 3; t < 30; t += 1) { w.motion.step(list, t, 1); assertClean(w.motion, list); }
  const a01 = arcOf(w.router, 0, 1), a12 = arcOf(w.router, 1, 2);
  assert.strictEqual(lead.route[lead.ri], a12); assert.ok(Math.abs(lead.s - 4) < 1e-9, "leader waits at the stop line");
  assert.strictEqual(lead.waiting, "signal");
  assert.strictEqual(follow.route[follow.ri], a01);
  assert.ok(Math.abs(follow.s - 96) < 1e-9, `follower keeps 8 m across the node (s=${follow.s})`);
  assert.ok(Math.abs(third.s - 88) < 1e-9, "third car queues 8 m behind the second");
  assert.strictEqual(follow.waiting, "queue");
  assert.ok(!w.signals.canEnter(w.router.arcs[a12], 32.9) && w.signals.canEnter(w.router.arcs[a12], 33));
  let order = [];
  for (let t = 30; t < 80; t += 1) { order.push(...w.motion.step(list, t, 1)); assertClean(w.motion, list); }
  assert.deepStrictEqual(order.map((v) => v.id), ["lead", "follow", "third"], "queue discharges in order once green");
  console.log("PASS: 8 m gap within a link and across a node, red-light hold at the stop line, ordered discharge on green.");
}

// ------------------------------------------------------------ stop sign hold
{
  const w = world(tiny([[0, 0], [30, 0], [60, 0]], [{ a: 0, b: 1, flags: 8 }, { a: 1, b: 2 }]));
  const v = vehicle("v");
  w.motion.place(v, 0); w.motion.setRoute(v, routeOf(w, 0, 2));
  w.motion.step([v], 0, 3);                      // reaches the stop line at exactly 3 s
  assert.ok(Math.abs(v.s - 30) < 1e-9 && v.ri === 0);
  w.motion.step([v], 3, 2);
  assert.ok(v.ri === 0 && v.waiting === "stop", "still holding after 2 s");
  w.motion.step([v], 5, 2);                      // 1 s of hold left, then 1 s of travel
  assert.strictEqual(v.ri, 1); assert.ok(Math.abs(v.s - 10) < 1e-9, `moves on after the ${T.STOP_HOLD} s hold (s=${v.s})`);
  console.log("PASS: stop signs hold for 3 s at the line, then the vehicle continues within the same step.");
}

// ------------------------------------------------------------ closed approach: spill-back and drain
{
  // 0 -(60)- 1 -(60)- 2 -(60)- 3 -(60)- 4; arc 2->3 closed.
  const xs = [0, 60, 120, 180, 240];
  const w = world(tiny(xs.map((x) => [x, 0]), [0, 1, 2, 3].map((i) => ({ a: i, b: i + 1 }))));
  const cars = Array.from({ length: 18 }, (_, i) => vehicle("c" + i));
  for (const v of cars) { w.motion.place(v, 0); w.motion.setRoute(v, routeOf(w, 0, 4)); }
  const closedArc = arcOf(w.router, 2, 3);
  w.motion.setClosed(closedArc, true);
  let arrived = [];
  for (let t = 0; t < 300; t += 3) { arrived.push(...w.motion.step(cars, t, 3)); assertClean(w.motion, cars); }
  assert.strictEqual(arrived.length, 0, "nothing passes a closed arc");
  // 120 m of road before the closure holds 16 cars at 8 m spacing (front car at the line, last
  // one at the start of the first link).
  const onRoad = cars.filter((v) => v.lane >= 0);
  assert.strictEqual(onRoad.length, 16, `queue fills both links (${onRoad.length})`);
  assert.ok(onRoad.some((v) => v.route[v.ri] === arcOf(w.router, 0, 1)), "queue spills back onto the upstream link");
  assert.strictEqual(cars.filter((v) => v.lane < 0).length, 2, "the rest wait at their start node");
  assert.strictEqual(w.motion.occupancy[closedArc], 0);
  w.motion.setClosed(closedArc, false);
  for (let t = 300; t < 900 && arrived.length < cars.length; t += 3) { arrived.push(...w.motion.step(cars, t, 3)); assertClean(w.motion, cars); }
  assert.strictEqual(arrived.length, cars.length, "every vehicle drains once the approach reopens");
  assert.deepStrictEqual(arrived.map((v) => v.id), cars.map((v) => v.id), "first in, first out");
  console.log("PASS: a closed approach queues traffic back across links and drains it all, in order, once reopened.");
}

// ------------------------------------------------------------ lanes and legality
{
  // Two-lane one-way 0->1 with a red signal at 1; 1->2 shuttle-only.
  const w = world(tiny([[0, 0], [50, 0, 2, 0], [100, 0]],
    [{ a: 0, b: 1, lf: 2, sigB: 1 }, { a: 1, b: 2, dir: 4 }], 1), { offsets: [0] });
  const a = vehicle("a"), b = vehicle("b");
  for (const v of [a, b]) { w.motion.place(v, 0); w.motion.setRoute(v, [arcOf(w.router, 0, 1)]); }
  w.motion.setRoute(a, [arcOf(w.router, 0, 1)]);
  const red = vehicle("red"), red2 = vehicle("red2");
  const toEnd = routeOf(w, 0, 2, R.MODE_PSV);
  for (const v of [red, red2]) { v.mode = R.MODE_PSV; w.motion.place(v, 0); w.motion.setRoute(v, toEnd); }
  for (let t = 0; t < 20; t += 1) w.motion.step([red, red2], t, 1);
  assert.ok(red.lane !== red2.lane && Math.abs(red.s - 50) < 1e-9 && Math.abs(red2.s - 50) < 1e-9, "two lanes queue side by side at the line");
  const pa = w.motion.locate(red), pb = w.motion.locate(red2);
  assert.ok(Math.abs(pa.y - pb.y) > 3, "side-by-side lanes draw apart");
  const car = vehicle("car");
  w.motion.place(car, 0);
  assert.throws(() => w.motion.setRoute(car, toEnd), /shuttles and buses only/);
  assert.throws(() => w.motion.setRoute(car, [arcOf(w.router, 1, 2)]), /starts at/);
  console.log("PASS: multi-lane approaches, lane offsets, shuttle-only arcs refused to private cars, routes must start where the car is.");
}

// ------------------------------------------------------------ random stress on a signalized synthetic grid
{
  const g = G.decodeMplsGraph(makeSynthGrid({ cols: 16, rows: 12, seed: 5 }));
  const w = world(g);
  const rnd = mulberry32(9);
  const core = w.router.connectedCore(R.MODE_GENERAL).nodes;
  const pick = () => core[Math.floor(rnd() * core.length)];
  const fleet = [];
  const assign = (v) => {
    for (let k = 0; k < 20; k++) {
      const to = pick();
      const r = w.router.route(v.node, to, { mode: v.mode });
      if (r && r.arcs.length) { w.motion.setRoute(v, r.arcs); return true; }
    }
    return false;
  };
  for (let i = 0; i < 300; i++) {
    const v = vehicle("s" + i, i % 3 ? R.MODE_GENERAL : R.MODE_PSV);
    w.motion.place(v, pick());
    assign(v);
    fleet.push(v);
  }
  let trips = 0, t = 0, maxQueue = 0;
  for (; t < 3600; t += 3) {
    for (const v of w.motion.step(fleet, t, 3)) { trips++; assign(v); }
    if (t % 30 === 0) assertClean(w.motion, fleet);
    for (let a = 0; a < w.router.arcCount; a++) if (w.motion.occupancy[a] > maxQueue) maxQueue = w.motion.occupancy[a];
  }
  // Stop giving out new trips; everything still on the road must reach its destination.
  let draining = fleet.filter((v) => v.route).length;
  const drainStart = t;
  for (; t < drainStart + 3600 && draining; t += 3) {
    draining -= w.motion.step(fleet, t, 3).length;
    if (t % 30 === 0) assertClean(w.motion, fleet);
  }
  assert.strictEqual(draining, 0, `${draining} vehicles never arrived (gridlock?)`);
  assert.ok(trips > 1500, `only ${trips} trips completed in an hour`);
  assertClean(w.motion, fleet);
  console.log(`PASS: 300 vehicles, 1 h on a signalized ${g.nodes.count}-node grid: ${trips} trips, gaps and legality hold every check, ` +
    `longest arc queue ${maxQueue}, everyone drains in ${Math.round((t - drainStart) / 60)} min.`);
}

// ------------------------------------------------------------ real street network: connected core, freeway through-trips, 400 vehicles
{
  const file = path.join(ROOT, "data/mpls_graph.js");
  if (!fs.existsSync(file)) { console.log("SKIP: data/mpls_graph.js not built"); return; }
  const sb = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sb);
  const g = G.decodeMplsGraph(sb.window.MPLS_GRAPH);
  const w = world(g);
  const core = w.router.connectedCore(R.MODE_GENERAL);
  const psvCore = w.router.connectedCore(R.MODE_PSV);
  const outside = 1 - core.size / core.interior;
  assert.ok(outside > 0.02 && outside < 0.08, `about 5 % of intersections outside the core (${(outside * 100).toFixed(1)} %)`);
  for (const v of core.nodes) assert.ok(psvCore.inCore[v], "the shuttle core contains the private-car core");
  const rnd = mulberry32(21);
  const pick = () => core.nodes[Math.floor(rnd() * core.nodes.length)];
  for (let k = 0; k < 150; k++) assert.ok(w.router.route(pick(), pick()), "core nodes reach one another without leaving the map");

  // Freeway through-traffic: portal-to-portal trips between freeway entries and exits.
  const freeway = (arc) => /^(motorway|trunk)$/.test(arc.link.className);
  const entries = [], exits = [];
  for (let v = 0; v < g.nodes.count; v++) {
    if (!(g.nodes.flags[v] & G.NODE_PORTAL)) continue;
    if (g.out[v].some(freeway)) entries.push(v);
    if (g.inc[v].some(freeway)) exits.push(v);
  }
  assert.ok(entries.length >= 4 && exits.length >= 4, "freeway portals at the area edge");
  const through = [];
  for (const a of entries) for (const b of exits) {
    const r = w.router.route(a, b);
    if (r && r.length > 1500) through.push(r);
  }
  assert.ok(through.length >= 8, `freeway through-routes across the area (${through.length})`);

  const fleet = [];
  const assign = (v) => {
    for (let k = 0; k < 20; k++) {
      const r = w.router.route(v.node, pick(), { mode: v.mode });
      if (r && r.arcs.length) { w.motion.setRoute(v, r.arcs); return; }
    }
  };
  for (let i = 0; i < 360; i++) {
    const v = vehicle("m" + i, i % 2 ? R.MODE_GENERAL : R.MODE_PSV);
    w.motion.place(v, pick()); assign(v); fleet.push(v);
  }
  const throughCars = [];
  for (let i = 0; i < 40; i++) {
    const r = through[i % through.length];
    const v = vehicle("x" + i);
    w.motion.place(v, r.from); w.motion.setRoute(v, r.arcs);
    throughCars.push(v); fleet.push(v);
  }
  let trips = 0, throughDone = 0, steps = 0, ms = 0;
  for (let t = 0; t < 1800; t += 3) {
    const t0 = process.hrtime.bigint();
    const done = w.motion.step(fleet, t, 3);
    ms += Number(process.hrtime.bigint() - t0) / 1e6; steps++;
    for (const v of done) {
      if (v.id[0] === "x") { throughDone++; assert.ok(exits.includes(v.node), "through-trips leave at a freeway exit"); continue; }
      trips++; assign(v);
    }
    if (t % 60 === 0) assertClean(w.motion, fleet);
  }
  assertClean(w.motion, fleet);
  assert.ok(throughDone >= 30, `freeway through-trips completed (${throughDone}/40)`);
  assert.ok(trips > 600, `trips completed on the real network (${trips})`);
  const perStep = ms / steps;
  assert.ok(perStep < 3, `motion step for 400 vehicles took ${perStep.toFixed(2)} ms`);
  // Dense traffic: 3,000 more private cars join the 400 above. Nobody waits in a queue for more than 5 minutes (no
  // gridlock), and lane bookkeeping survives heavy multi-lane merging.
  const dense = fleet.slice();
  for (let i = 0; i < 3000; i++) { const v = vehicle("d" + i); w.motion.place(v, pick()); assign(v); dense.push(v); }
  let denseTrips = 0, worstQueue = 0, denseMs = 0;
  for (let t = 1800; t < 3000; t += 3) {
    const t0 = process.hrtime.bigint();
    const done = w.motion.step(dense, t, 3);
    denseMs += Number(process.hrtime.bigint() - t0) / 1e6;
    for (const v of done) { denseTrips++; if (v.id[0] !== "x") assign(v); }
    for (const v of dense) { v.queued = v.route && v.waiting === "queue" ? (v.queued || 0) + 3 : 0; if (v.queued > worstQueue) worstQueue = v.queued; }
    if (t % 120 === 0) assertClean(w.motion, dense);
  }
  assert.ok(worstQueue < 300, `a car queued for ${worstQueue} s (gridlock)`);
  console.log(`PASS: real network, 3,400 vehicles for 20 more min: ${denseTrips} trips, longest continuous queue wait ${worstQueue} s, ` +
    `${(denseMs / 400).toFixed(2)} ms per step.`);
  console.log(`PASS: real network — core ${core.size} of ${core.interior} intersections (${(outside * 100).toFixed(1)} % only reachable via the outside), ` +
    `${through.length} freeway through-routes, 400 vehicles for 30 min: ${trips} trips + ${throughDone} through-trips, ` +
    `${perStep.toFixed(2)} ms per 3 s step.`);
}
