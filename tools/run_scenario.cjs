#!/usr/bin/env node
// Headless scenario runner (Phase 8): runs the Census-demand simulation in Node, seeded, and
// writes its metrics as CSV. With --vary it runs one scenario per value and also writes a
// summary table and chart.
//
//   node tools/run_scenario.cjs --until 10:00 --fleet 5000 --out-dir results/base
//       -> summary.csv, series.csv (15-minute rows), bridges.csv (hourly crossings),
//          distributions.csv (wait and ride minutes)
//   node tools/run_scenario.cjs --vary fleet=2000,3000,4000,5000 --keep-transit --out-dir results/sweep
//       -> sweep.csv (one row per value), sweep.svg (average wait and riders delivered against
//          the varied setting), and each run's CSVs in a subfolder
//
// Settings: --fleet (real vehicles), --mix sedans,shuttles,buses shares, --car-share 0-1,
// --keep-transit, --pooling 0-100, --sampling 5|10|20, --day 0-6 (Monday = 0), --seed,
// --until HH:MM, --no-ev, --no-rebalance. --vary takes fleet, carShare, pooling, sampling or day.
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

const DEFAULTS = { fleet: 5000, mix: [0.1, 0.6, 0.3], carShare: 0.9, transitReplaced: true, pooling: 100, sampling: 10,
  day: 2, seed: 1, until: "10:00", ev: true, rebalance: true, vary: null, outDir: null };

function parseArgs(argv) {
  const a = { ...DEFAULTS, mix: DEFAULTS.mix.slice() };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, ""), v = argv[i + 1];
    const take = () => { i++; return v; };
    if (k === "fleet") a.fleet = Number(take());
    else if (k === "mix") a.mix = take().split(",").map(Number);
    else if (k === "car-share") a.carShare = Number(take());
    else if (k === "keep-transit") a.transitReplaced = false;
    else if (k === "pooling") a.pooling = Number(take());
    else if (k === "sampling") a.sampling = Number(take());
    else if (k === "day") a.day = Number(take());
    else if (k === "seed") a.seed = Number(take());
    else if (k === "until") a.until = take();
    else if (k === "no-ev") a.ev = false;
    else if (k === "no-rebalance") a.rebalance = false;
    else if (k === "out-dir") a.outDir = take();
    else if (k === "vary") { const [name, list] = take().split("="); a.vary = { name, values: list.split(",").map(Number) }; }
    else throw new Error(`unknown option --${k}`);
  }
  return a;
}

let shared = null;
function world() {
  if (!shared) {
    const graph = G.decodeMplsGraph(load("data/mpls_graph.js", "MPLS_GRAPH"));
    shared = { graph, router: R.createRouter(graph), demand: load("data/mpls_demand.js", "MPLS_DEMAND") };
  }
  return shared;
}

// One seeded run; returns the simulation (for its metrics) and the summary.
function runScenario(a) {
  const { graph, router, demand } = world();
  const n = (share) => Math.max(0, Math.round(a.fleet * share / a.sampling));
  const sim = Sim.createSim(graph, {
    router, demand, seed: a.seed, sampling: a.sampling, day: a.day, carShare: a.carShare, transitReplaced: a.transitReplaced,
    rideSharing: a.pooling, ev: a.ev, rebalance: a.rebalance, sedans: n(a.mix[0]), shuttles: n(a.mix[1]), buses: n(a.mix[2]),
  });
  const [h, m] = a.until.split(":").map(Number);
  const steps = Math.max(0, Math.round((h * 60 + m - sim.state.minute) * 60 / Sim.STEP));
  const t0 = Date.now();
  sim.run(steps);
  const summary = { ...sim.summary(), runSeconds: +((Date.now() - t0) / 1000).toFixed(1) };
  return { sim, summary };
}

function writeRun(dir, sim) {
  fs.mkdirSync(dir, { recursive: true });
  for (const kind of ["summary", "series", "bridges", "distributions"]) fs.writeFileSync(path.join(dir, `${kind}.csv`), sim.csv(kind));
}

const cell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function toCSV(rows) {
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

// A two-panel SVG: average wait (left) and riders delivered (right) against the varied
// setting. Two measures, two charts sharing the x values (no dual axis); one series each, so
// the titles name them; values labelled at each point.
function chartSVG(rows, xName, xLabel, until, scenario) {
  const W = 760, H = 350, pad = { l: 56, r: 18, t: 86, b: 52 }, gap = 48;
  const pw = (W - pad.l - pad.r - gap) / 2, ph = H - pad.t - pad.b;
  const xs = rows.map((r) => r[xName]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const fmt = (v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 10) / 10));
  const panel = (ox, key, title, unit) => {
    const ys = rows.map((r) => r[key]);
    // Round tick steps (1, 2, 2.5 or 5 × a power of ten), four of them or so.
    const raw = (Math.max(...ys) * 1.1 || 1) / 4, mag = 10 ** Math.floor(Math.log10(raw));
    const stepV = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((x) => x >= raw);
    const top = stepV * 4;
    const X = (v) => ox + (x1 === x0 ? pw / 2 : ((v - x0) / (x1 - x0)) * pw);
    const Y = (v) => pad.t + ph - (v / top) * ph;
    let g = `<text x="${ox}" y="${pad.t - 26}" class="t">${title}</text><text x="${ox}" y="${pad.t - 10}" class="s">${unit}</text>`;
    for (let k = 0; k <= 4; k++) {
      const v = stepV * k, y = Y(v);
      g += `<line x1="${ox}" x2="${ox + pw}" y1="${y}" y2="${y}" class="grid"/><text x="${ox - 8}" y="${y + 4}" class="ax" text-anchor="end">${fmt(v)}</text>`;
    }
    for (const v of xs) g += `<text x="${X(v)}" y="${pad.t + ph + 18}" class="ax" text-anchor="middle">${fmt(v)}</text>`;
    g += `<text x="${ox + pw / 2}" y="${pad.t + ph + 40}" class="ax" text-anchor="middle">${xLabel}</text>`;
    g += `<path d="${rows.map((r, i) => `${i ? "L" : "M"}${X(r[xName]).toFixed(1)},${Y(r[key]).toFixed(1)}`).join("")}" class="line"/>`;
    for (const r of rows) g += `<circle cx="${X(r[xName]).toFixed(1)}" cy="${Y(r[key]).toFixed(1)}" r="4.5" class="dot"/>` +
      `<text x="${X(r[xName]).toFixed(1)}" y="${(Y(r[key]) - 10).toFixed(1)}" class="v" text-anchor="middle">${fmt(r[key])}</text>`;
    return g;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Average wait and riders delivered by ${xLabel}">
<style>
  .bg{fill:#fcfcfb} .t{font:600 14px system-ui,sans-serif;fill:#0b0b0b} .s,.ax{font:12px system-ui,sans-serif;fill:#52514e}
  .v{font:600 11px system-ui,sans-serif;fill:#0b0b0b} .grid{stroke:#e4e2dc;stroke-width:1} .line{fill:none;stroke:#2a78d6;stroke-width:2}
  .dot{fill:#2a78d6;stroke:#fcfcfb;stroke-width:2} .cap{font:12px system-ui,sans-serif;fill:#52514e}
  @media (prefers-color-scheme: dark){.bg{fill:#1a1a19}.t,.v{fill:#f0efec}.s,.ax,.cap{fill:#c3c2b7}.grid{stroke:#34332f}.line{stroke:#3987e5}.dot{fill:#3987e5;stroke:#1a1a19}}
</style>
<rect width="${W}" height="${H}" class="bg"/>
<text x="${pad.l}" y="26" class="t">${scenario}</text>
${panel(pad.l, "avgWaitMin", "Average wait", "minutes, riders requesting since 05:30")}
${panel(pad.l + pw + gap, "ridesDelivered", `Riders delivered by ${until}`, "people")}
</svg>
`;
}

function main(argv) {
  const a = parseArgs(argv);
  const scenario = `${a.transitReplaced ? "Transit replaced" : "Transit kept"}, ${Math.round(a.carShare * 100)} % of car trips kept, ` +
    `${a.fleet.toLocaleString()} vehicles, pooling ${a.pooling} %, 1:${a.sampling}, day ${a.day}, seed ${a.seed}`;
  if (!a.vary) {
    const { sim, summary } = runScenario(a);
    if (a.outDir) writeRun(a.outDir, sim);
    console.log(scenario);
    console.log(summary);
    return { summary };
  }
  const key = { fleet: "fleet", carShare: "carShare", pooling: "pooling", sampling: "sampling", day: "day" }[a.vary.name];
  if (!key) throw new Error(`--vary takes fleet, carShare, pooling, sampling or day, not ${a.vary.name}`);
  const rows = [];
  for (const value of a.vary.values) {
    const run = { ...a, [key]: value };
    const { sim, summary } = runScenario(run);
    if (a.outDir) writeRun(path.join(a.outDir, `${key}-${value}`), sim);
    rows.push({ [key]: value, ...summary });
    console.log(`${key} ${value}: avg wait ${summary.avgWaitMin} min · delivered ${summary.ridesDelivered.toLocaleString()} · ` +
      `occupancy ${summary.occupancy} · deadhead ${summary.deadheadPct} % · fleet VMT ${summary.fleetVMT.toLocaleString()} · ${summary.runSeconds} s`);
  }
  const labels = { fleet: "fleet size (vehicles)", carShare: "share of car trips kept", pooling: "pooling (%)", sampling: "people per agent", day: "day of week (0 = Monday)" };
  const title = `${a.transitReplaced ? "Transit replaced" : "Transit kept"}, ${Math.round(a.carShare * 100)} % of car trips kept · 05:30–${a.until}, Wednesday, 1:${a.sampling}`;
  if (a.outDir) {
    fs.mkdirSync(a.outDir, { recursive: true });
    fs.writeFileSync(path.join(a.outDir, "sweep.csv"), toCSV(rows));
    fs.writeFileSync(path.join(a.outDir, "sweep.svg"), chartSVG(rows, key, labels[key], a.until, title));
    console.log(`wrote ${path.join(a.outDir, "sweep.csv")} and sweep.svg`);
  }
  return { rows };
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { parseArgs, runScenario, chartSVG, toCSV, main, DEFAULTS };
