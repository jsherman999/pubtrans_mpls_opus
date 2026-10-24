// Phase 8: run metrics (src/metrics.js via src/sim.js), CSV export and the headless scenario
// runner (tools/run_scenario.cjs). Checks that the metrics add up against the simulation's own
// odometers and riders, that the CSVs are complete, and that a fleet sweep writes its table and
// chart. Run: node tests/metrics.test.cjs
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const Sim = require(path.join(ROOT, "src/sim.js"));
const run = require(path.join(ROOT, "tools/run_scenario.cjs"));
const MILE = 1609.344;
const parse = (csv) => { const [head, ...rows] = csv.trim().split("\n"); const cols = head.split(","); return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v]))); };

// ------------------------------------------------------------ metrics add up
{
  const { sim, summary } = run.runScenario({ ...run.DEFAULTS, until: "08:30", sampling: 10 });
  const S = sim.state, K = sim.scale, M = sim.metrics.data;
  const fleet = S.vehicles.filter((v) => Sim.FLEET_KINDS.includes(v.kind));
  // Fleet distance equals the odometers (vehicles never leave the fleet in this run).
  const odo = fleet.reduce((s, v) => s + v.odo, 0) * K;
  assert.ok(Math.abs(M.fleetMeters - odo) < 1, `fleet meters ${M.fleetMeters} vs odometers ${odo}`);
  assert.strictEqual(summary.fleetVMT, Math.round(odo / MILE));
  assert.ok(M.emptyMeters <= M.fleetMeters && summary.deadheadPct > 0 && summary.deadheadPct < 100);
  assert.ok(summary.occupancy > 0.3 && summary.occupancy < 8, `occupancy ${summary.occupancy}`);
  assert.ok(Math.abs(M.byKind.sedan.meters + M.byKind.shuttle.meters + M.byKind.bus.meters - M.fleetMeters) < 1);
  // Every delivered rider is in both distributions once.
  const sum = (h) => h.reduce((a, b) => a + b, 0);
  assert.strictEqual(sum(M.wait), S.completedPeople);
  assert.strictEqual(sum(M.ride), S.completedPeople);
  assert.ok(summary.waitP50Min <= summary.waitP90Min && summary.rideP50Min <= summary.rideP90Min);
  // Fleet time adds up to fleet size × elapsed time.
  const hours = Object.values(M.stateSeconds).reduce((a, b) => a + b, 0) / 3600;
  assert.ok(Math.abs(hours - fleet.length * K * S.t / 3600) < 1, `fleet hours ${hours}`);
  assert.ok(summary.utilizationPct > 0 && summary.utilizationPct <= 100);
  assert.ok(summary.carVMT > 0 && summary.carVHT > 0);
  // 15-minute series: 05:45 … 08:30, deliveries summing to the total.
  const series = parse(sim.csv("series"));
  assert.strictEqual(series.length, 12);
  assert.strictEqual(series[0].clock, "05:45"); assert.strictEqual(series.at(-1).clock, "08:30");
  assert.strictEqual(series.reduce((s, r) => s + Number(r.delivered), 0), S.completedPeople);
  assert.ok(Math.abs(series.reduce((s, r) => s + Number(r.fleetMiles), 0) - M.fleetMeters / MILE) < 1);
  // Hourly bridge crossings: 07:00 and 08:00 rows (the first full clock hours), every bridge
  // direction, the I-35W bridge busiest in the morning.
  const bridges = parse(sim.csv("bridges"));
  assert.deepStrictEqual(bridges.map((r) => r.clock), ["07:00", "08:00"]);
  assert.strictEqual(Object.keys(bridges[0]).length, 1 + 16);
  const i35 = Number(bridges[1]["I-35W Bridge northbound"]) + Number(bridges[1]["I-35W Bridge southbound"]);
  assert.ok(i35 > 1000, `I-35W crossings 07:00–08:00: ${i35}`);
  const dist = parse(sim.csv("distributions"));
  assert.strictEqual(dist.length, 121);
  const summaryRows = parse(sim.csv("summary"));
  assert.ok(summaryRows.find((r) => r.metric === "shuttle deadhead %") && summaryRows.find((r) => r.metric === "fleet hours idle"));
  console.log(`PASS: metrics at 08:30 — ${summary.fleetVMT.toLocaleString()} fleet miles (${summary.deadheadPct} % empty), occupancy ${summary.occupancy}, ` +
    `utilisation ${summary.utilizationPct} %, waits p50/p90 ${summary.waitP50Min}/${summary.waitP90Min} min, rides ${summary.rideP50Min}/${summary.rideP90Min} min; ` +
    `odometers, riders, fleet hours and 15-minute rows all add up; I-35W ${i35.toLocaleString()} crossings 07:00–08:00.`);
}

// ------------------------------------------------------------ headless runner: a seeded sweep with CSV and chart
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "pubtrans-sweep-"));
  const args = ["--vary", "fleet=1000,3000", "--keep-transit", "--until", "08:00", "--sampling", "20", "--seed", "4", "--out-dir", out];
  const { rows } = run.main(args);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows[0].avgWaitMin > rows[1].avgWaitMin, "a larger fleet waits less");
  const csv = parse(fs.readFileSync(path.join(out, "sweep.csv"), "utf8"));
  assert.deepStrictEqual(csv.map((r) => r.fleet), ["1000", "3000"]);
  assert.ok(["avgWaitMin", "ridesDelivered", "fleetVMT", "deadheadPct", "occupancy", "utilizationPct"].every((k) => k in csv[0]));
  const svg = fs.readFileSync(path.join(out, "sweep.svg"), "utf8");
  assert.ok(svg.startsWith("<svg") && svg.trim().endsWith("</svg>"));
  assert.strictEqual((svg.match(/<path /g) || []).length, 2, "one line per panel");
  assert.strictEqual((svg.match(/<circle /g) || []).length, 4, "one marker per run in each panel");
  for (const sub of ["fleet-1000", "fleet-3000"]) for (const f of ["summary", "series", "bridges", "distributions"])
    assert.ok(fs.statSync(path.join(out, sub, `${f}.csv`)).size > 0);
  // Seeded: the same arguments give the same table.
  const again = fs.mkdtempSync(path.join(os.tmpdir(), "pubtrans-sweep-"));
  run.main(args.slice(0, -1).concat(again));
  const strip = (t) => t.split("\n").map((l) => l.split(",").slice(0, -1).join(",")).join("\n");   // drop run time
  assert.strictEqual(strip(fs.readFileSync(path.join(again, "sweep.csv"), "utf8")), strip(fs.readFileSync(path.join(out, "sweep.csv"), "utf8")));
  assert.throws(() => run.parseArgs(["--bogus"]), /unknown option/);
  console.log(`PASS: run_scenario.cjs sweep (fleet 1,000 and 3,000) writes sweep.csv, a two-panel sweep.svg and each run's CSVs; seeded runs repeat exactly.`);
}
