// Routing (src/routing.js) and signal timing (src/traffic.js) checks, plus a benchmark on a
// synthetic grid the size of the real study area. Run: node tests/routing.test.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const G = require(path.join(ROOT, "src/graph.js"));
const R = require(path.join(ROOT, "src/routing.js"));
const T = require(path.join(ROOT, "src/traffic.js"));
const { makeSynthGrid, mulberry32 } = require("./fixtures/synth_grid.cjs");

function loadRaw(file) {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox);
  return sandbox.window.MPLS_GRAPH;
}

// Every arc legal for the mode, contiguous from `from` to `to`, times and lengths add up.
function checkRoute(router, g, r, from, to, mode) {
  assert.strictEqual(r.from, from); assert.strictEqual(r.to, to);
  let at = from, time = 0, len = 0;
  for (const i of r.arcs) {
    const arc = router.arcs[i];
    assert.strictEqual(arc.from, at, "route is not contiguous");
    if (mode !== R.MODE_PSV) assert.ok(!arc.psvOnly, "private route used a shuttle-only arc");
    if (arc.from !== from) assert.ok(!(g.nodes.flags[arc.from] & G.NODE_PORTAL), "route passed through a portal");
    time += arc.baseTime; len += arc.link.len;
    at = arc.to;
  }
  assert.strictEqual(at, to);
  assert.ok(Math.abs(time - r.time) < 1e-6 && Math.abs(len - r.length) < 1e-6);
}

// ------------------------------------------------------------ sample network (fixture)
{
  const g = G.decodeMplsGraph(loadRaw("data/sample_graph.js"));
  const router = R.createRouter(g);
  const N = g.nodes.count;
  let pairs = 0, psvFaster = 0;
  for (let a = 0; a < N; a++)
    for (let b = 0; b < N; b++) {
      for (const mode of [R.MODE_GENERAL, R.MODE_PSV]) {
        const astar = router.route(a, b, { mode });
        const dijk = router.search(a, b, { mode, heuristic: false });
        assert.strictEqual(!!astar, !!dijk, `A* and Dijkstra disagree on reachability ${a}->${b}`);
        if (!astar) continue;
        assert.ok(Math.abs(astar.time - dijk.time) < 1e-9, `A* not optimal ${a}->${b}`);
        checkRoute(router, g, astar, a, b, mode);
        pairs++;
      }
      const gen = router.route(a, b), psv = router.route(a, b, { mode: R.MODE_PSV });
      if (gen && psv) {
        assert.ok(psv.time <= gen.time + 1e-9, "shuttles can never be slower than private cars");
        if (psv.time < gen.time - 1e-9) psvFaster++;
      }
    }
  assert.ok(pairs > 300, `too few routable pairs (${pairs})`);
  assert.ok(psvFaster > 0, "shuttle-only streets never helped; fixture lost its transit mall?");

  // One-way streets: 2nd St (nodes 4..8) runs east only.
  const east = router.route(4, 8);
  assert.ok(east.arcs.every((i) => router.arcs[i].link.name === "2nd St"), "eastbound should stay on 2nd St");
  const west = router.route(8, 4);
  assert.ok(west.arcs.every((i) => !(router.arcs[i].link.name === "2nd St" && !router.arcs[i].forward) ), "no westbound 2nd St arc exists");
  // 3rd St (nodes 9..12): general traffic westbound only; shuttles also eastbound (contraflow).
  const gen3 = router.route(9, 12), psv3 = router.route(9, 12, { mode: R.MODE_PSV });
  assert.ok(psv3.arcs.some((i) => router.arcs[i].psvOnly), "shuttle should use the contraflow lane");
  assert.ok(!gen3.arcs.some((i) => router.arcs[i].link.name === "3rd St" && router.arcs[i].forward));

  // Bans and closures.
  const ban = new Set([east.arcs[1]]);
  const detour = router.search(4, 8, { banned: ban });
  assert.ok(detour && !detour.arcs.includes(east.arcs[1]) && detour.time > east.time);
  const closed = router.search(4, 8, { cost: (i) => (i === east.arcs[1] ? Infinity : 0) });
  assert.deepStrictEqual(closed.arcs, detour.arcs);
  const arr = new Uint8Array(router.arcCount); arr[east.arcs[1]] = 1;
  assert.deepStrictEqual(router.search(4, 8, { banned: arr }).arcs, detour.arcs);

  // Alternatives: best first, distinct, never faster than the best.
  const alts = router.kShortest(0, 12, 3);
  assert.ok(alts.length >= 2, "expected at least two alternatives across the grid");
  assert.deepStrictEqual(alts[0].arcs, router.route(0, 12).arcs);
  for (let i = 1; i < alts.length; i++) {
    assert.ok(alts[i].time >= alts[0].time - 1e-9);
    assert.notDeepStrictEqual(alts[i].arcs, alts[0].arcs);
    checkRoute(router, g, alts[i], 0, 12, R.MODE_GENERAL);
  }

  // Cache: repeat hits, invalidate clears.
  const hits = router.stats.cacheHits;
  router.route(0, 12); router.route(0, 12);
  assert.ok(router.stats.cacheHits >= hits + 2);
  const ep = router.epoch; router.invalidate(); assert.strictEqual(router.epoch, ep + 1);

  // Route polyline starts and ends on the nodes and follows travel direction.
  const pts = router.routePoints(west);
  assert.ok(Math.hypot(pts[0] - g.nodes.x[8], pts[1] - g.nodes.y[8]) < 1e-6);
  assert.ok(Math.hypot(pts[pts.length - 2] - g.nodes.x[4], pts[pts.length - 1] - g.nodes.y[4]) < 1e-6);

  // Nearest node agrees with brute force.
  const rnd = mulberry32(3);
  for (let k = 0; k < 200; k++) {
    const x = rnd() * g.width, y = rnd() * g.height;
    let best = -1, bd = Infinity;
    for (let v = 0; v < N; v++) { const d = Math.hypot(g.nodes.x[v] - x, g.nodes.y[v] - y); if (d < bd) { bd = d; best = v; } }
    const got = router.nearestNode(x, y);
    assert.ok(Math.abs(Math.hypot(g.nodes.x[got] - x, g.nodes.y[got] - y) - bd) < 1e-9);
  }
  const notPortal = router.nearestNode(0, g.height, (v) => !(g.nodes.flags[v] & G.NODE_PORTAL));
  assert.ok(!(g.nodes.flags[notPortal] & G.NODE_PORTAL));

  // Connected core: no portals, every pair mutually reachable without leaving the map, and the
  // shuttle core contains the private-car core.
  for (const mode of [R.MODE_GENERAL, R.MODE_PSV]) {
    const core = router.connectedCore(mode);
    assert.ok(core.size > 0 && core.size <= core.interior);
    for (const a of core.nodes) {
      assert.ok(!(g.nodes.flags[a] & G.NODE_PORTAL));
      for (const b of core.nodes) assert.ok(router.route(a, b, { mode }), `core ${a}->${b} unreachable`);
    }
    assert.strictEqual(router.connectedCore(mode), core, "cached");
  }
  assert.ok(router.connectedCore(R.MODE_GENERAL).nodes.every((v) => router.connectedCore(R.MODE_PSV).inCore[v]));

  // Signals: never two greens at once, waits bounded, cluster-internal links never stop.
  const sig = T.createSignals(g);
  for (let c = 0; c < g.controllers.length; c++)
    for (let t = 0; t < sig.cycle * 2; t += 0.5) {
      const p = sig.phase(c, t);
      assert.ok(p.green === -1 || p.green === 0 || p.green === 1);
    }
  let signalArcs = 0, internal = 0, stops = 0;
  for (const arc of router.arcs) {
    if (arc.signal === 0 || arc.signal === 1) {
      signalArcs++;
      let greenTime = 0;
      for (let t = 0; t < sig.cycle; t += 0.25) {
        const w = sig.signalWait(arc, t);
        assert.ok(w >= 0 && w <= sig.cycle - sig.greenFor(arc) + 1e-9);
        if (w === 0) greenTime += 0.25;
        else assert.ok(sig.canEnter(arc, t + w), "arc must be green once its wait is over");
      }
      assert.ok(Math.abs(greenTime - sig.greenFor(arc)) <= 0.5, "each group is green for its split of the cycle");
      assert.ok(sig.greenFor(arc) >= 15 && sig.greenFor(arc) <= 45);
      // Cross streets at the same controller are never green together.
      for (const other of g.inc[arc.to])
        if ((other.signal === 0 || other.signal === 1) && other.signal !== arc.signal)
          for (let t = 0; t < sig.cycle; t += 1) assert.ok(!(sig.canEnter(arc, t) && sig.canEnter(other, t)));
    } else if (arc.signal === 2) {
      internal++;
      assert.strictEqual(sig.signalWait(arc, 12.3), 0);
    }
    if (arc.stop && arc.signal === -1) { stops++; assert.strictEqual(sig.controlDelay(arc, 0), T.STOP_HOLD); }
  }
  assert.ok(signalArcs > 0 && internal > 0 && stops > 0, "fixture should exercise signals, clusters and stops");
  // Green splits follow approach capacity; both groups share the 60 s of green.
  for (let c = 0; c < g.controllers.length; c++) assert.ok(Math.abs(sig.g0[c] + sig.g1[c] - 60) < 1e-9);
  const even = T.createSignals(g, { split: false });
  assert.ok([...even.g0].every((x) => x === 30), "split: false keeps the source's 30/30");
  console.log(`PASS: sample network — ${pairs} optimal routes in both modes, one-ways, contraflow, transit mall, bans, alternatives, cache, nearest node, connected core, signals.`);
}

// ------------------------------------------------------------ synthetic study-area-size grid
{
  const g = G.decodeMplsGraph(makeSynthGrid());
  const t0 = Date.now();
  const router = R.createRouter(g);
  const buildMs = Date.now() - t0;
  const N = g.nodes.count;
  const rnd = mulberry32(11);
  const interior = [];
  for (let v = 0; v < N; v++) if (!(g.nodes.flags[v] & G.NODE_PORTAL)) interior.push(v);
  const pick = () => interior[Math.floor(rnd() * interior.length)];
  const pairs = Array.from({ length: 400 }, () => [pick(), pick()]);

  // Correctness against Dijkstra on a sample of pairs, both modes.
  for (const [a, b] of pairs.slice(0, 120))
    for (const mode of [R.MODE_GENERAL, R.MODE_PSV]) {
      const x = router.search(a, b, { mode }), y = router.search(a, b, { mode, heuristic: false });
      assert.strictEqual(!!x, !!y);
      if (x) { assert.ok(Math.abs(x.time - y.time) < 1e-6); checkRoute(router, g, x, a, b, mode); }
    }

  const bench = (opts) => {
    const s0 = router.stats.settled, start = process.hrtime.bigint();
    let found = 0;
    for (const [a, b] of pairs) if (router.search(a, b, opts)) found++;
    const ms = Number(process.hrtime.bigint() - start) / 1e6 / pairs.length;
    return { ms, settled: (router.stats.settled - s0) / pairs.length, found };
  };
  bench({}); // warm up the JIT
  const astar = bench({}), dijk = bench({ heuristic: false });
  const kStart = process.hrtime.bigint();
  for (const [a, b] of pairs.slice(0, 50)) router.kShortest(a, b, 3);
  const kMs = Number(process.hrtime.bigint() - kStart) / 1e6 / 50;
  assert.ok(astar.found > pairs.length * 0.95, "synthetic grid should be almost fully connected");
  assert.ok(astar.settled < dijk.settled, "A* should settle fewer nodes than Dijkstra");
  assert.ok(astar.ms < 3, `A* averaged ${astar.ms.toFixed(2)} ms, budget is 3 ms`);
  console.log(`PASS: synthetic ${N}-node grid (${router.arcCount} arcs, router built in ${buildMs} ms). ` +
    `A* ${astar.ms.toFixed(2)} ms/route (${Math.round(astar.settled)} nodes settled) vs Dijkstra ` +
    `${dijk.ms.toFixed(2)} ms (${Math.round(dijk.settled)}); 3 alternatives ${kMs.toFixed(1)} ms.`);
}
