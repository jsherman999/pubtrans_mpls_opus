#!/usr/bin/env node
// Fleet-size sweep on the Census demand: runs the same seeded morning with the fleet scaled by
// each factor and reports rider waits, so the smallest fleet that meets a target average wait can
// be read off. Headless (no page), Node only.
//
//   node tools/fleet_sweep.cjs                         # defaults below
//   node tools/fleet_sweep.cjs --scales 0.6,1,1.5,2,3 --until 10:00 --target 8 --sampling 20
//   node tools/fleet_sweep.cjs --out data/fleet_sweep.json
//
// The average wait counts every rider who asked for a ride since 05:30, those still waiting at
// the end included (the source app's "Avg queue").
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const G = require(path.join(ROOT, "src/graph.js"));
const R = require(path.join(ROOT, "src/routing.js"));
const Sim = require(path.join(ROOT, "src/sim.js"));

function load(file, key) {
  const sb = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sb);
  return sb.window[key];
}

function parseArgs(argv) {
  const a = { scales: [0.3, 0.4, 0.6, 0.8, 1, 1.2, 1.6], until: "10:00", target: 15, sampling: 20, seed: 1, day: 2, carShare: 0.5, out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, ""), v = argv[i + 1];
    if (k === "scales") a.scales = v.split(",").map(Number);
    else if (k === "until") a.until = v;
    else if (k === "target") a.target = Number(v);
    else if (["sampling", "seed", "day"].includes(k)) a[k] = Number(v);
    else if (k === "car-share") a.carShare = Number(v);
    else if (k === "out") a.out = v;
    else continue;
    i++;
  }
  return a;
}

// One run: the default fleet times `scale`, from 05:30 to `until`.
function runOnce(graph, router, demandRaw, scale, a) {
  const base = Sim.DEFAULTS.demandFleet;
  const opts = { seed: a.seed, demand: demandRaw, router, sampling: a.sampling, day: a.day, carShare: a.carShare,
    sedans: Math.round(base.sedans * scale), shuttles: Math.round(base.shuttles * scale), buses: Math.round(base.buses * scale) };
  const sim = Sim.createSim(graph, opts);
  const [h, m] = a.until.split(":").map(Number);
  const steps = Math.round((h * 60 + m - sim.state.minute) * 60 / Sim.STEP);
  const t0 = Date.now();
  let worstFrame = 0;
  for (let i = 0; i < steps; i += 10) {
    const f0 = process.hrtime.bigint();
    sim.run(Math.min(10, steps - i));
    worstFrame = Math.max(worstFrame, Number(process.hrtime.bigint() - f0) / 1e6);
  }
  const S = sim.state, c = sim.counts();
  const waits = S.recentTrips.map((x) => x.wait / 60).sort((x, y) => x - y);
  const K = sim.scale;
  return {
    scale,
    fleet: { sedans: opts.sedans * K, shuttles: opts.shuttles * K, buses: opts.buses * K, total: (opts.sedans + opts.shuttles + opts.buses) * K },
    avgWaitMin: +(sim.averageQueueMinutes() || 0).toFixed(2),
    p90WaitMin: waits.length ? +waits[Math.floor(waits.length * 0.9)].toFixed(1) : null,   // last 1,000 riders delivered
    stillWaiting: S.queue.length * K,
    delivered: S.completedPeople,
    avgRideMin: S.completed ? +(S.rideSeconds / S.completed / 60).toFixed(2) : null,
    pooledShare: S.completed ? +(S.pooled / Math.max(1, S.completed + S.queue.length)).toFixed(3) : 0,
    charging: c.charging * K, energyMWh: +(S.energyKwh / 1000).toFixed(1),
    seconds: +((Date.now() - t0) / 1000).toFixed(1), worstFrameMs: +worstFrame.toFixed(1),
  };
}

function sweep(a, log = console.log) {
  const graph = G.decodeMplsGraph(load("data/mpls_graph.js", "MPLS_GRAPH"));
  const demandRaw = load("data/mpls_demand.js", "MPLS_DEMAND");
  const router = R.createRouter(graph);
  const rows = [];
  for (const scale of a.scales) {
    const r = runOnce(graph, router, demandRaw, scale, a);
    rows.push(r);
    log(`fleet ×${scale}: ${r.fleet.total.toLocaleString()} vehicles (${r.fleet.sedans} sedans, ${r.fleet.shuttles} shuttles, ${r.fleet.buses} buses) · ` +
      `avg wait ${r.avgWaitMin} min · still waiting ${r.stillWaiting.toLocaleString()} · delivered ${r.delivered.toLocaleString()} · ` +
      `${r.seconds} s run, worst 10-step frame ${r.worstFrameMs} ms`);
  }
  const meets = rows.filter((r) => r.avgWaitMin <= a.target).sort((x, y) => x.fleet.total - y.fleet.total)[0] || null;
  return { settings: a, rows, recommended: meets && { scale: meets.scale, fleet: meets.fleet, avgWaitMin: meets.avgWaitMin } };
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  const result = sweep(a);
  console.log(result.recommended
    ? `smallest fleet meeting ${a.target} min average wait by ${a.until}: ×${result.recommended.scale} = ${result.recommended.fleet.total.toLocaleString()} vehicles (${result.recommended.avgWaitMin} min)`
    : `no fleet in the sweep meets ${a.target} min; try larger scales`);
  if (a.out) { fs.writeFileSync(path.join(ROOT, a.out), JSON.stringify(result, null, 2) + "\n"); console.log(`wrote ${a.out}`); }
}

module.exports = { sweep, runOnce, parseArgs };
