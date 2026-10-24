// Demand model (src/demand.js on data/mpls_demand.js) and the engine running it (src/sim.js):
// Phase 5's exit checks — daily totals against Census/LODES and the plan's targets, sampled
// agents scaling back to full size, a sensible AM/PM shape, day-of-week and event effects — plus
// a seeded demand-driven simulation morning. Run: node tests/demand.test.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const G = require(path.join(ROOT, "src/graph.js"));
const D = require(path.join(ROOT, "src/demand.js"));
const Sim = require(path.join(ROOT, "src/sim.js"));
const load = (file, key) => { const sb = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sb); return sb.window[key]; };
const raw = load("data/mpls_demand.js", "MPLS_DEMAND");
const report = JSON.parse(fs.readFileSync(path.join(ROOT, "data/mpls_demand.report.json"), "utf8"));
const demand = D.createDemand(raw);
const within = (x, target, tol) => Math.abs(x / target - 1) <= tol;

// ------------------------------------------------------------ inputs and daily totals
{
  const sum = (k) => raw.zones[k].reduce((a, b) => a + b, 0);
  assert.strictEqual(sum("pop"), report.residents, "zones carry every resident of the 2020 Census blocks");
  assert.strictEqual(sum("jobs"), report.jobs, "and every LODES job");
  assert.strictEqual(report.commuters.od_vs_wac_jobs, 1, "LODES flows account for every job");
  assert.deepStrictEqual(report.warnings, []);
  const days = [0, 1, 2, 3, 4].map((day) => demand.generate({ day }).summary);
  const presence = days.reduce((s, d) => s + d.jobsPresent / d.jobs, 0) / 5;
  const wed = days[2];
  // The plan's targets: ~45k downtown residents, ~200k jobs at ~75 % daily presence, the UMN
  // population. Census and LODES give the first two; the UMN figure is an input assumption.
  const targets = [
    ["jobs in the study area (LODES 2023)", report.jobs, 200000, 0.15],
    ["average weekday presence", presence, 0.75, 0.10],
    ["UMN Minneapolis campus attendance, Wednesday (students + staff present)", wed.campusAttendance, 38000 + 0.92 * 25299, 0.10],
  ];
  for (const [name, value, target, tol] of targets) assert.ok(within(value, target, tol), `${name}: ${Math.round(value)} vs ${target}`);
  // Downtown residents: the 2020 Census count inside the downtown outline is below the plan's
  // ~45k (which reflects later, wider estimates); recorded, not hidden.
  assert.ok(report.downtown.residents > 30000 && report.downtown.residents < 45000, `downtown residents ${report.downtown.residents}`);
  console.log(`PASS: ${report.residents.toLocaleString()} residents, ${report.jobs.toLocaleString()} jobs (${Math.round(presence * 100)} % present on an average weekday, ` +
    `${Math.round(wed.jobsPresent).toLocaleString()} on Wednesday), UMN attendance ${Math.round(wed.campusAttendance).toLocaleString()}, ` +
    `downtown ${report.downtown.residents.toLocaleString()} residents (2020); Wednesday ${Math.round(wed.personTrips).toLocaleString()} person trips.`);
}

// ------------------------------------------------------------ sampling scales back to full size
{
  for (const sampling of [10, 20]) {
    const g = demand.generate({ sampling, day: 2, seed: 3 });
    const sampled = {};
    for (const t of g.all) sampled[t.purpose] = (sampled[t.purpose] || 0) + t.weight;
    for (const [purpose, full] of Object.entries(g.summary.byPurpose))
      assert.ok(within(sampled[purpose], full, 0.1), `1:${sampling} ${purpose}: ${sampled[purpose]} sampled vs ${Math.round(full)}`);
    const total = Object.values(sampled).reduce((a, b) => a + b, 0);
    assert.ok(within(total, g.summary.personTrips, 0.02), `1:${sampling} total ${total} vs ${Math.round(g.summary.personTrips)}`);
    assert.ok(g.all.every((t) => t.weight === sampling));
    assert.ok(g.trips.every((t, i) => !i || g.trips[i - 1].minute <= t.minute), "time ordered");
  }
  const a = demand.generate({ seed: 5 }), b = demand.generate({ seed: 5 }), c = demand.generate({ seed: 6 });
  assert.deepStrictEqual(a.all.slice(0, 50), b.all.slice(0, 50), "same seed, same day");
  assert.notDeepStrictEqual(a.all.slice(0, 50), c.all.slice(0, 50));
  console.log("PASS: sampled agents (1:10 and 1:20) add back up to the full-scale trips of every purpose within 10 % (total within 2 %); reproducible from the seed.");
}

// ------------------------------------------------------------ AM/PM shape, days, events
{
  const wed = demand.generate({ day: 2 });
  const H = wed.summary.hourly.map((h) => h.walk + h.shuttle + h.drive);
  const peakOf = (from, to) => { let best = from; for (let h = from; h < to; h++) if (H[h] > H[best]) best = h; return best; };
  const am = peakOf(5, 12), pm = peakOf(12, 21);
  assert.ok(am >= 7 && am <= 8, `morning peak hour starts at ${am}:00`);
  assert.ok(pm >= 15 && pm <= 17, `evening peak hour starts at ${pm}:00`);
  assert.ok(H[am] > 2.5 * H[11], `morning peak ${Math.round(H[am])} vs late morning ${Math.round(H[11])}`);
  assert.ok(H[pm] > 1.8 * H[12], `evening peak ${Math.round(H[pm])} vs noon ${Math.round(H[12])}`);
  assert.ok(H[3] === 0, "nobody travels at 3 am");
  // Inbound commuters arrive in the morning and leave in the evening.
  const inbound = wed.all.filter((t) => t.purpose === "work" && t.from.sector != null);
  const outboundLegs = wed.all.filter((t) => t.purpose === "work" && t.to.sector != null && t.returning);
  const share = (list, a, b) => list.filter((t) => t.minute >= a * 60 && t.minute < b * 60).length / list.length;
  assert.ok(share(inbound, 6.5, 9.5) > 0.6, `most inbound commutes arrive 06:30–09:30 (${Math.round(share(inbound, 6.5, 9.5) * 100)} %)`);
  assert.ok(share(outboundLegs, 15, 19) > 0.6, `and most go home 15:00–19:00 (${Math.round(share(outboundLegs, 15, 19) * 100)} %)`);
  // Hybrid work: Friday and the weekend are lighter; errands and visits fill the weekend.
  const fri = demand.generate({ day: 4 }).summary, sun = demand.generate({ day: 6 }).summary;
  assert.ok(fri.byPurpose.work < 0.85 * wed.summary.byPurpose.work, "Friday has fewer commutes");
  assert.ok(sun.byPurpose.work < 0.3 * wed.summary.byPurpose.work && sun.byPurpose.errand > wed.summary.byPurpose.errand);
  // An event: arrivals before the start, a surge as it ends.
  const ev = { venue: "U.S. Bank Stadium", start: 12 * 60, attendance: 66000, length: 210 };
  const game = demand.generate({ day: 6, events: [ev] }), none = demand.generate({ day: 6, events: [] });
  const evTrips = game.all.filter((t) => t.purpose === "event");
  const evPeople = evTrips.reduce((s, t) => s + t.weight, 0);
  assert.ok(within(evPeople, 2 * 66000, 0.05), `66,000 fans, two trips each (${evPeople})`);
  const after = evTrips.filter((t) => t.returning), before = evTrips.filter((t) => !t.returning);
  assert.ok(before.every((t) => t.minute <= ev.start + 10) && after.every((t) => t.minute >= ev.start + ev.length - 20));
  assert.ok(game.summary.hourly[15].drive + game.summary.hourly[15].shuttle > 2 * (none.summary.hourly[15].drive + none.summary.hourly[15].shuttle),
    "the 15:00 hour surges when the game ends");
  console.log(`PASS: Wednesday peaks ${am}:00–${am + 1}:00 (${Math.round(H[am]).toLocaleString()} trips) and ${pm}:00–${pm + 1}:00 ` +
    `(${Math.round(H[pm]).toLocaleString()}); inbound commuters arrive 06:30–09:30 and leave 15:00–19:00; Friday and Sunday lighter; a 66,000-fan game surges at its end.`);
}

// ------------------------------------------------------------ the engine on Census demand
{
  const graph = G.decodeMplsGraph(load("data/mpls_graph.js", "MPLS_GRAPH"));
  const sim = Sim.createSim(graph, { seed: 2, demand: raw });
  const S = sim.state;
  assert.strictEqual(sim.scale, 20, "1:20 sampling by default");
  assert.ok(S.vehicles.every((v) => v.pcu === (v.kind === "bus" ? 40 : 20)), "every fleet agent stands for 20 vehicles");
  assert.strictEqual(S.minute, 5.5 * 60, "a Census-demand day starts at 05:30");
  assert.ok(S.places.length > 600 && S.places.every((p) => sim.core.inCore[p.node]), "zones and edge hubs sit in the connected core");
  const hubs = S.places.filter((p) => p.hub);
  assert.ok(hubs.length > 100 && hubs.every((h) => h.portals.length > 0));
  assert.ok(sim.parkingLots.length > 100 && sim.parkingLots.every((l) => sim.core.inCore[l.node]));
  let maxRoad = 0, maxCars = 0;
  for (let minute = 0; minute < 210; minute++) {   // 05:30 to 09:00
    sim.run(20);
    const c = sim.counts();
    maxRoad = Math.max(maxRoad, c.onRoad); maxCars = Math.max(maxCars, c.privateCars);
    if (minute % 15 === 14) assert.deepStrictEqual(sim.audit(), []);
  }
  assert.strictEqual(sim.clock(), "09:00");
  assert.ok(S.completed > 1000, `rides completed (${S.completed} agents = ${S.completedPeople.toLocaleString()} people)`);
  assert.strictEqual(S.completedPeople, S.completed * 20, "each completed ride counts 20 people");
  const released = S.carTrips + S.shuttleTrips + S.walked + S.unrouted;
  const due = S.trips.filter((t) => t.minute <= S.minute).reduce((s, t) => s + t.weight, 0);
  assert.strictEqual(released, due, "every trip due so far was released once");
  assert.ok(S.unrouted <= 0.002 * released, `trips without a route: ${S.unrouted}`);
  const carShare = S.carTrips / (S.carTrips + S.shuttleTrips);
  assert.ok(carShare > 0.15 && carShare < 0.4, `half of today's car trips switch to shuttles (car share now ${Math.round(carShare * 100)} %)`);
  assert.ok(maxCars > 3000, `rush-hour private traffic (${maxCars} cars on the road)`);
  // Gridlock relief should be rare: under 3 % of car and shuttle agent trips (the default fleet
  // of 19,000 vehicles loads the network hard at the peak).
  const agentTrips = (S.carTrips + S.shuttleTrips) / 20;
  assert.ok(sim.motion.stats.jumps < 0.03 * agentTrips, `gridlock jumps ${sim.motion.stats.jumps} of ${Math.round(agentTrips)} agent trips`);
  // The car-share lever: all of today's drivers keep their cars.
  const more = Sim.createSim(graph, { seed: 2, demand: raw, carShare: 1 });
  more.run(20 * 150);
  assert.ok(more.state.carTrips > 1.6 * S.carTrips * 150 / 210 * 0.8, "carShare 1 keeps today's car traffic");
  console.log(`PASS: Census-demand morning 05:30–09:00 at 1:20: ${S.completed.toLocaleString()} rides (${S.completedPeople.toLocaleString()} people), ` +
    `${Math.round(carShare * 100)} % of motorised trips by car, up to ${maxCars.toLocaleString()} cars and ${maxRoad} agents on the road, ` +
    `${sim.motion.stats.jumps} gridlock jumps in ${Math.round(agentTrips).toLocaleString()} agent trips, ${S.unrouted} unrouted; audit clean.`);
}
