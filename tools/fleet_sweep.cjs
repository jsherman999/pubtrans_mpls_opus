#!/usr/bin/env node
// Fleet-size sweep on the Census demand: runs the same seeded morning with the fleet scaled by
// each factor and reports rider waits, so the smallest fleet that meets a target average wait can
// be read off. Headless (no page), Node only.
//
//   node tools/fleet_sweep.cjs                         # defaults below
//   node tools/fleet_sweep.cjs --totals 4000,8000,12000 --mix 0.1,0.6,0.3 --until 10:00 --target 10
//   node tools/fleet_sweep.cjs --scales 0.6,1,1.5          # multiples of the default fleet instead
//   node tools/fleet_sweep.cjs --out data/fleet_sweep.json
//
// --mix is the share of vehicles that are sedans, shuttles and buses; --car-share is the share of
// today's car trips still driven; --keep-transit leaves today's transit riders on transit.
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
  const a = { scales: null, totals: [3000, 4000, 5000, 6000, 8000, 10000], mix: [0.1, 0.6, 0.3], until: "10:00", target: 10,
    sampling: 5, seed: 1, day: 2, carShare: 0.9, transitReplaced: true, out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, ""), v = argv[i + 1];
    if (k === "scales") { a.scales = v.split(",").map(Number); a.totals = null; }
    else if (k === "totals") { a.totals = v.split(",").map(Number); a.scales = null; }
    else if (k === "mix") a.mix = v.split(",").map(Number);
    else if (k === "until") a.until = v;
    else if (k === "target") a.target = Number(v);
    else if (["sampling", "seed", "day"].includes(k)) a[k] = Number(v);
    else if (k === "car-share") a.carShare = Number(v);
    else if (k === "keep-transit") { a.transitReplaced = false; continue; }
    else if (k === "out") a.out = v;
    else continue;
    i++;
  }
  return a;
}

// One run from 05:30 to `until`: the default fleet times `scale`, or `total` real vehicles split
// by `a.mix`.
function runOnce(graph, router, demandRaw, size, a) {
  const base = Sim.DEFAULTS.demandFleet, n = (x) => Math.max(0, Math.round(x / a.sampling));
  const fleet = a.totals ? { sedans: n(size * a.mix[0]), shuttles: n(size * a.mix[1]), buses: n(size * a.mix[2]) }
    : { sedans: Math.round(base.sedans * size), shuttles: Math.round(base.shuttles * size), buses: Math.round(base.buses * size) };
  const scale = size;
  const opts = { seed: a.seed, demand: demandRaw, router, sampling: a.sampling, day: a.day, carShare: a.carShare,
    transitReplaced: a.transitReplaced, ...fleet };
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
  const fl = S.vehicles.filter((v) => Sim.FLEET_KINDS.includes(v.kind));
  const km = fl.reduce((s2, v) => s2 + v.odo, 0) / 1000 * K;
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
    ridersPerVehicleHour: +(S.completedPeople / ((opts.sedans + opts.shuttles + opts.buses) * K) / ((h * 60 + m - 330) / 60)).toFixed(2),
    fleetKm: Math.round(km), stuckJumps: sim.motion.stats.jumps,
    seconds: +((Date.now() - t0) / 1000).toFixed(1), worstFrameMs: +worstFrame.toFixed(1),
  };
}

function sweep(a, log = console.log) {
  const graph = G.decodeMplsGraph(load("data/mpls_graph.js", "MPLS_GRAPH"));
  const demandRaw = load("data/mpls_demand.js", "MPLS_DEMAND");
  const router = R.createRouter(graph);
  const rows = [];
  for (const scale of a.totals || a.scales) {
    const r = runOnce(graph, router, demandRaw, scale, a);
    rows.push(r);
    log(`fleet ${a.totals ? "" : "×"}${scale}: ${r.fleet.total.toLocaleString()} vehicles (${r.fleet.sedans} sedans, ${r.fleet.shuttles} shuttles, ${r.fleet.buses} buses) · ` +
      `avg wait ${r.avgWaitMin} min · still waiting ${r.stillWaiting.toLocaleString()} · delivered ${r.delivered.toLocaleString()} ` +
      `(${r.ridersPerVehicleHour}/vehicle-hour) · avg ride ${r.avgRideMin} min · ` +
      `${r.seconds} s run, worst 10-step frame ${r.worstFrameMs} ms`);
  }
  const meets = rows.filter((r) => r.avgWaitMin <= a.target).sort((x, y) => x.fleet.total - y.fleet.total)[0] || null;
  return { settings: a, rows, recommended: meets && { scale: meets.scale, fleet: meets.fleet, avgWaitMin: meets.avgWaitMin } };
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  const result = sweep(a);
  console.log(result.recommended
    ? `smallest fleet meeting ${a.target} min average wait by ${a.until}: ${result.recommended.fleet.total.toLocaleString()} vehicles (${result.recommended.avgWaitMin} min)`
    : `no fleet in the sweep meets ${a.target} min; try larger scales`);
  if (a.out) { fs.writeFileSync(path.join(ROOT, a.out), JSON.stringify(result, null, 2) + "\n"); console.log(`wrote ${a.out}`); }
}

module.exports = { sweep, runOnce, parseArgs };
