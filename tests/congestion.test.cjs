// Capacity and congestion (src/congestion.js) and the Phase 4 exit check: in a seeded AM peak on
// the real network, congestion forms at known pinch points and clears afterwards.
// Run: node tests/congestion.test.cjs
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
const C = require(path.join(ROOT, "src/congestion.js"));
const Sim = require(path.join(ROOT, "src/sim.js"));
const { tiny } = require("./fixtures/tiny.cjs");

// ------------------------------------------------------------ capacity, delay, diversion and recovery
{
  // O -(primary, 3 lanes)- S, then two ways to T: A via a1 (short, but a signal at T) or B via
  // b1 (longer, no signal), then on to the destination D. Demand of 1,200 cars an hour exceeds
  // what route A's signal passes.
  const g = tiny([[-300, 0], [0, 0], [300, 0], [300, 300], [600, 0, 2, 0], [700, 0]],
    [{ a: 0, b: 1, cls: 1, lf: 3 }, { a: 1, b: 2 }, { a: 2, b: 4, sigB: 0 }, { a: 1, b: 3 }, { a: 3, b: 4 }, { a: 4, b: 5, cls: 1, lf: 2 }],
    1, ["residential", "primary"]);
  const router = R.createRouter(g);
  const signals = T.createSignals(g, { offsets: [0], split: false });
  const motion = M.createMotion(g, router, signals);
  const cong = C.createCongestion(g, router, motion, signals);
  const arc = (a, b) => router.arcs.findIndex((x) => x.from === a && x.to === b);
  const OS = arc(0, 1), SA = arc(1, 2), AT = arc(2, 4), SB = arc(1, 3);
  assert.strictEqual(cong.capacity[OS], 3 * 1800, "3 primary lanes: 5,400 cars an hour");
  assert.strictEqual(cong.capacity[SA], 1500, "a residential lane: 1,500 cars an hour");
  assert.ok(Math.abs(cong.capacity[AT] - 1500 * signals.greenFor(router.arcs[AT]) / signals.cycle) < 1e-9, "a signal approach gets its green share");

  const run = (congestionRouting) => {
    const m = M.createMotion(g, router, signals), c = C.createCongestion(g, router, m, signals);
    const cars = [];
    let viaB = 0, viaA = 0, worstQueue = 0, t = 0, n = 0;
    const spawn = () => {
      let r = router.route(0, 5);
      if (congestionRouting && c.pathDelayed(r.arcs)) r = router.search(0, 5, { cost: c.cost });
      const v = { id: "c" + n++, mode: R.MODE_GENERAL, viaB: r.arcs.includes(SB) };
      m.place(v, 0); m.setRoute(v, r.arcs); cars.push(v);
    };
    for (; t < 3600; t += 3) {
      spawn();                                   // one car every 3 s
      for (const v of m.step(cars.filter((x) => x.route), t, 3)) { if (v.viaB) viaB++; else viaA++; }
      if ((t + 3) % 60 === 0) c.update(t + 3, cars);
      worstQueue = Math.max(worstQueue, m.occupancy[SA] + m.occupancy[OS]);
    }
    const peakExtra = c.extra[SA];
    // Demand stops: the queue drains and the delay estimate returns to zero.
    let clearedAt = null;
    for (; t < 3600 + 3600; t += 3) {
      m.step(cars.filter((x) => x.route), t, 3);
      if ((t + 3) % 60 === 0) { c.update(t + 3, cars); if (clearedAt == null && c.congestedArcs === 0) clearedAt = t + 3; }
    }
    assert.deepStrictEqual(m.check(cars), []);
    return { viaA, viaB, worstQueue, peakExtra, clearedAt, left: cars.filter((x) => x.route).length };
  };
  const fixed = run(false), smart = run(true);
  assert.strictEqual(fixed.viaB, 0, "free-flow routing sends everyone the short way");
  assert.ok(fixed.peakExtra > 60, `the overloaded approach shows a large delay (${Math.round(fixed.peakExtra)} s)`);
  assert.ok(smart.viaB > 0.25 * (smart.viaA + smart.viaB), `congestion-aware routes divert (${smart.viaB} of ${smart.viaA + smart.viaB} via B)`);
  assert.ok(smart.worstQueue < fixed.worstQueue * 0.6, `diversion keeps the queue shorter (${smart.worstQueue} vs ${fixed.worstQueue})`);
  assert.strictEqual(smart.left, 0); assert.strictEqual(fixed.left, 0);
  assert.ok(smart.clearedAt != null && smart.clearedAt - 3600 <= 900, `delay estimates return to zero within 15 min (${smart.clearedAt - 3600} s)`);
  console.log(`PASS: capacities from lanes, class and green share; an overloaded signal approach builds ${Math.round(fixed.peakExtra)} s of delay; ` +
    `congestion-aware routing diverts ${Math.round(100 * smart.viaB / (smart.viaA + smart.viaB))} % and cuts the worst queue from ${fixed.worstQueue} to ${smart.worstQueue} cars; clears in ${Math.round((smart.clearedAt - 3600) / 60)} min.`);
}

// ------------------------------------------------------------ real network: chokepoints and a seeded AM peak
{
  const sb = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "data/mpls_graph.js"), "utf8"), sb);
  const graph = G.decodeMplsGraph(sb.window.MPLS_GRAPH);
  const sim = Sim.createSim(graph, { seed: 1 });
  const cong = sim.congestion;
  assert.strictEqual(cong.bridges.length, 8, "all eight Mississippi road bridges found");
  for (const b of cong.bridges) assert.strictEqual(b.dirs.length, 2, `${b.name}: both directions`);
  assert.ok(cong.ramps.length > 50 && cong.portals.length > 150);
  const i35 = cong.bridges.find((b) => b.name === "I-35W Bridge");
  for (const d of i35.dirs) assert.ok(Math.min(...d.arcs.map((a) => cong.capacity[a])) >= 4 * 2100, "I-35W: four freeway lanes each way");

  // 07:30 to 10:30. Record the worst chokepoint queue and network-wide queueing over time.
  const timeline = [];
  let peak = { queue: 0 }, peakFlowI35 = 0;
  for (let minute = 0; minute < 180; minute++) {
    sim.run(20);
    if ((minute + 1) % 5) continue;
    const c = sim.chokepoints(3);
    const all = [...c.bridges, ...c.ramps];
    const worst = all.reduce((a, b) => (b.queue > a.queue ? b : a));
    const counts = sim.counts();
    timeline.push({ clock: sim.clock(), worst, queued: counts.queued, congested: cong.congestedArcs });
    if (worst.queue > peak.queue) peak = { ...worst, clock: sim.clock() };
    const f = c.bridges.find((b) => b.name === "I-35W Bridge").flow;
    if (f > peakFlowI35) peakFlowI35 = f;
    assert.deepStrictEqual(sim.audit(), []);
  }
  const at = (clock) => timeline.find((x) => x.clock >= clock);
  const rush = timeline.filter((x) => x.clock >= "07:50" && x.clock <= "08:45");
  const late = timeline.filter((x) => x.clock >= "10:00");
  const rushQueued = Math.max(...rush.map((x) => x.queued)), lateQueued = Math.max(...late.map((x) => x.queued));
  // Forms: a real queue (tens of cars) at a bridge or freeway ramp during the rush, at the
  // I-35W crossing and its University of Minnesota exits.
  assert.ok(peak.queue >= 30, `a chokepoint queue of 30+ cars forms (worst ${peak.queue} at ${peak.name})`);
  assert.ok(peak.clock >= "07:45" && peak.clock <= "09:00", `during the morning rush (${peak.clock})`);
  assert.ok(/I.35W/.test(peak.name), `at the I-35W crossing or its ramps (${peak.name})`);
  assert.ok(peakFlowI35 > 3000, `the I-35W bridge carries rush-hour volumes (${Math.round(peakFlowI35)} cars/h)`);
  // Clears: by 10:00 chokepoint queues are short and network queueing is a fraction of the rush.
  assert.ok(late.every((x) => x.worst.queue <= 10), `chokepoints clear by 10:00 (${late.map((x) => x.worst.queue).join(", ")})`);
  assert.ok(lateQueued < rushQueued / 3, `queued vehicles fall from ${rushQueued} to ${lateQueued}`);
  assert.ok(Math.max(...late.map((x) => x.congested)) <= Math.max(...rush.map((x) => x.congested)) / 3);
  assert.ok(sim.state.reroutes > 0, "drivers in queues find other ways");
  console.log(`PASS: 8 bridges, ${cong.ramps.length} ramps, ${cong.portals.length} entries. Seeded AM peak: worst queue ${peak.queue} cars at ` +
    `${peak.name} (${peak.clock}); I-35W bridge up to ${Math.round(peakFlowI35)} cars/h; queued vehicles ${rushQueued} in the rush → ${lateQueued} after 10:00; ` +
    `${sim.state.reroutes} reroutes. At 08:15: ${at("08:15").congested} congested arcs; at 10:15: ${at("10:15").congested}.`);
}
