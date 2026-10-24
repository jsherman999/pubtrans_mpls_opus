// Run metrics for the simulation (Phase 8): distance and time driven, empty driving, occupancy,
// fleet utilisation, rider wait and ride distributions, a 15-minute time series and hourly
// river-bridge crossings, all in real people and vehicles (agents × their weight), plus CSV
// export. Fed by src/sim.js each step; no DOM. No dependencies.
(function (root) {
  "use strict";

  const MILE = 1609.344;
  const FLEET = ["sedan", "shuttle", "bus"];

  function createMetrics({ step, scale }) {
    const M = {};
    function reset() {
      Object.assign(M, {
        fleetMeters: 0, emptyMeters: 0, paxMeters: 0, fleetSeconds: 0,   // real vehicle-meters, vehicle-seconds
        carMeters: 0, carSeconds: 0,
        byKind: Object.fromEntries(FLEET.map((k) => [k, { meters: 0, emptyMeters: 0, paxMeters: 0 }])),
        stateSeconds: {},                                                // fleet vehicle-seconds by state group
        wait: new Float64Array(121), ride: new Float64Array(121),         // people by whole minutes, last bin 120+
        riders: 0, series: [], bridgeHours: [],
        lastSeries: null, lastBridge: null,
      });
    }
    reset();
    const group = (v) => (v.state === "idle" ? "idle" : v.state === "repositioning" ? "repositioning"
      : v.state === "charging" || v.state === "to_charge" ? "charging"
      : v.state === "returning" ? "returning" : v.riders.length ? "carrying riders" : "to pickup");

    // One simulation step: odometer deltas and time on the road, per vehicle.
    function onStep(sim) {
      const S = sim.state;
      for (const v of S.vehicles) {
        const d = v.odo - (v.metOdo ?? v.odo);
        v.metOdo = v.odo;
        if (v.kind === "private") {
          if (d > 0) M.carMeters += d * v.pcu;
          if (v.lane >= 0) M.carSeconds += step * v.pcu;
          continue;
        }
        if (!FLEET.includes(v.kind)) continue;
        const k = M.byKind[v.kind];
        if (d > 0) {
          const real = d * scale;
          M.fleetMeters += real; k.meters += real;
          if (!v.riders.length) { M.emptyMeters += real; k.emptyMeters += real; }
          M.paxMeters += real * v.riders.length; k.paxMeters += real * v.riders.length;
        }
        if (v.lane >= 0) M.fleetSeconds += step * scale;
        const g = group(v);
        M.stateSeconds[g] = (M.stateSeconds[g] || 0) + step * scale;
      }
    }
    function onComplete(r, t) {
      const w = r.weight || 1;
      M.wait[Math.min(120, Math.floor((r.pickedUpAt - r.requestedAt) / 60))] += w;
      M.ride[Math.min(120, Math.floor((t - r.pickedUpAt) / 60))] += w;
      M.riders += w;
    }
    // Every 15 minutes: one row of the time series. Every hour: bridge crossings by direction.
    function sample(sim) {
      const S = sim.state, c = sim.counts(), K = scale;
      const prev = M.lastSeries || { delivered: 0, requested: 0, fleetMeters: 0, emptyMeters: 0 };
      const requested = S.demand ? S.shuttleTrips : (S.nextReq - 1) * K;
      const row = {
        clock: sim.clock(), minute: Math.round(S.minute),
        requested: requested - prev.requested,
        delivered: S.completedPeople - prev.delivered,
        waiting: S.queue.length * K,
        avgWaitMin: +(sim.currentQueueWaitMinutes() || 0).toFixed(2),
        fleetBusy: c.fleetBusy * K, fleetIdle: c.fleetIdle * K, charging: c.charging * K,
        fleetMiles: +((M.fleetMeters - prev.fleetMeters) / MILE).toFixed(1),
        emptyMiles: +((M.emptyMeters - prev.emptyMeters) / MILE).toFixed(1),
        carsOnRoad: c.privateCars, congestedSegments: sim.congestion.congestedArcs,
      };
      M.series.push(row);
      M.lastSeries = { delivered: S.completedPeople, requested, fleetMeters: M.fleetMeters, emptyMeters: M.emptyMeters };
    }
    function sampleBridges(sim) {
      const entries = sim.motion.entries;
      const now = sim.congestion.bridges.map((b) => b.dirs.map((d) => Math.max(...d.arcs.map((a) => entries[a]))));
      if (M.lastBridge) {
        const row = { clock: sim.clock() };
        sim.congestion.bridges.forEach((b, i) => b.dirs.forEach((d, j) => { row[`${b.name} ${d.label}`] = Math.round(now[i][j] - M.lastBridge[i][j]); }));
        M.bridgeHours.push(row);
      }
      M.lastBridge = now;
    }

    // Percentile of a minute histogram.
    function percentile(hist, p) {
      const total = hist.reduce((a, b) => a + b, 0);
      if (!total) return null;
      let acc = 0;
      for (let i = 0; i < hist.length; i++) { acc += hist[i]; if (acc >= p * total) return i + 0.5; }
      return hist.length - 0.5;
    }
    function summary(sim) {
      const S = sim.state, secs = Object.values(M.stateSeconds).reduce((a, b) => a + b, 0) || 1;
      const busy = secs - (M.stateSeconds.idle || 0) - (M.stateSeconds.charging || 0);
      return {
        clock: sim.clock(), sampling: scale,
        ridesRequested: S.demand ? S.shuttleTrips : null, ridesDelivered: S.completedPeople, stillWaiting: S.queue.length * scale,
        avgWaitMin: +(sim.averageQueueMinutes() || 0).toFixed(2),
        waitP50Min: percentile(M.wait, 0.5), waitP90Min: percentile(M.wait, 0.9),
        rideP50Min: percentile(M.ride, 0.5), rideP90Min: percentile(M.ride, 0.9),
        pooledRiders: S.pooled * scale,
        fleetVehicles: S.vehicles.filter((v) => FLEET.includes(v.kind)).length * scale,
        fleetVMT: Math.round(M.fleetMeters / MILE), fleetVHT: Math.round(M.fleetSeconds / 3600),
        deadheadPct: M.fleetMeters ? +(100 * M.emptyMeters / M.fleetMeters).toFixed(1) : null,
        occupancy: M.fleetMeters ? +(M.paxMeters / M.fleetMeters).toFixed(2) : null,   // passenger-miles per vehicle-mile
        utilizationPct: +(100 * busy / secs).toFixed(1),
        carVMT: Math.round(M.carMeters / MILE), carVHT: Math.round(M.carSeconds / 3600),
        walkTrips: S.walked || 0, carTrips: S.carTrips || 0,
        energyMWh: +((S.energyKwh || 0) / 1000).toFixed(1), chargeSessions: (S.chargeSessions || 0) * scale,
        gridlockJumps: sim.motion.stats.jumps,
      };
    }

    // ---------------------------------------------------------------- CSV
    const cell = (v) => (v == null ? "" : typeof v === "number" ? String(v) : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    function table(rows) {
      if (!rows.length) return "";
      const cols = Object.keys(rows[0]);
      return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
    }
    function seriesCSV() { return table(M.series); }
    function bridgesCSV() { return table(M.bridgeHours); }
    function distributionsCSV() {
      const rows = [];
      for (let i = 0; i <= 120; i++) rows.push({ minutes: i === 120 ? "120+" : i, waitingPeople: Math.round(M.wait[i]), ridingPeople: Math.round(M.ride[i]) });
      return table(rows);
    }
    function summaryCSV(sim) {
      const s = summary(sim);
      const rows = Object.entries(s).map(([metric, value]) => ({ metric, value }));
      for (const [k, b] of Object.entries(M.byKind)) {
        rows.push({ metric: `${k} VMT`, value: Math.round(b.meters / MILE) });
        rows.push({ metric: `${k} deadhead %`, value: b.meters ? +(100 * b.emptyMeters / b.meters).toFixed(1) : "" });
        rows.push({ metric: `${k} occupancy`, value: b.meters ? +(b.paxMeters / b.meters).toFixed(2) : "" });
      }
      for (const [g, sec] of Object.entries(M.stateSeconds)) rows.push({ metric: `fleet hours ${g}`, value: Math.round(sec / 3600) });
      return table(rows);
    }

    return { data: M, reset, onStep, onComplete, sample, sampleBridges, summary, percentile, seriesCSV, bridgesCSV, distributionsCSV, summaryCSV, table };
  }

  const api = { createMetrics, MILE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsMetrics = api;
})(typeof window !== "undefined" ? window : globalThis);
