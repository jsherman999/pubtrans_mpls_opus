// Traffic control on the decoded street graph (src/graph.js). No dependencies.
//
// Each signal controller (a cluster of OpenStreetMap signal nodes, see docs/DATA_FORMAT.md)
// alternates its two phase groups with the source app's cycle: 66 s, two 3 s transitions in
// which neither group may enter. The 60 s of green is split between the groups in proportion to
// the capacity of their approaches (lanes × road-class saturation flow), at least 15 s each, so
// an arterial crossing a side street gets the longer green (Phase 5; the source split it 30/30,
// which `split: false` keeps). Controllers get deterministic offsets so the city's signals are
// not all in step; a coordinated plan can replace offsets later.
// Stop signs hold a vehicle for STOP_HOLD seconds before it may enter the intersection.
(function (root) {
  "use strict";

  const STOP_HOLD = 3;
  // Saturation flow by road class, cars per hour per lane (as src/motion.js), for green splits.
  const SAT = {
    motorway: 2100, motorway_link: 1800, trunk: 1900, trunk_link: 1700, primary: 1800,
    primary_link: 1600, secondary: 1750, secondary_link: 1600, tertiary: 1700, tertiary_link: 1500,
    unclassified: 1600, residential: 1500, living_street: 1200, service: 1200, busway: 1800,
  };

  function createSignals(graph, opts = {}) {
    const green = opts.green ?? 30;            // mean green per group
    const amber = opts.amber ?? 3;
    const cycle = 2 * (green + amber);
    const minGreen = Math.min(green, opts.minGreen ?? 15);
    const count = graph.controllers.length;
    const offsets = new Float64Array(count);
    for (let c = 0; c < count; c++) {
      // Knuth multiplicative hash of the controller id, spread over the cycle.
      const hsh = (Math.imul(c + 1 + (opts.seed || 0), 2654435761) >>> 0) / 4294967296;
      offsets[c] = opts.offsets ? opts.offsets[c] : hsh * cycle;
    }
    const ctlOf = graph.nodes.ctl;
    // Green time of each group at each controller.
    const g0 = new Float64Array(count).fill(green), g1 = new Float64Array(count).fill(green);
    if (opts.split !== false) {
      const w0 = new Float64Array(count), w1 = new Float64Array(count);
      for (let v = 0; v < graph.nodes.count; v++) {
        const c = ctlOf[v];
        if (c < 0) continue;
        for (const arc of graph.inc[v]) {
          if (arc.signal !== 0 && arc.signal !== 1) continue;
          const l = arc.link, lanes = Math.max(1, arc.forward ? l.lanesAB : l.lanesBA);
          const w = lanes * (SAT[l.className] || 1500);
          if (arc.signal === 0) w0[c] += w; else w1[c] += w;
        }
      }
      for (let c = 0; c < count; c++) {
        if (!(w0[c] + w1[c] > 0)) continue;
        const g = Math.min(2 * green - minGreen, Math.max(minGreen, 2 * green * w0[c] / (w0[c] + w1[c])));
        g0[c] = g; g1[c] = 2 * green - g;
      }
    }
    const greenOf = (c, group) => (group === 0 ? g0[c] : g1[c]);

    // Phase position of controller c at time t (seconds): which group is green, if any, and
    // how long until the given group's next green starts.
    function phase(c, t) {
      let tc = (t + offsets[c]) % cycle;
      if (tc < 0) tc += cycle;
      if (tc < g0[c]) return { green: 0, tc };
      if (tc < g0[c] + amber) return { green: -1, tc };
      if (tc < g0[c] + amber + g1[c]) return { green: 1, tc };
      return { green: -1, tc };
    }

    // Seconds a vehicle arriving on `arc` at time t must wait for its signal (0 if green or none).
    function signalWait(arc, t) {
      const g = arc.signal;
      if (g !== 0 && g !== 1) return 0;
      const c = ctlOf[arc.to];
      if (c < 0) return 0;
      const { tc } = phase(c, t);
      const start = g === 0 ? 0 : g0[c] + amber, len = greenOf(c, g);
      if (tc >= start && tc < start + len) return 0;
      let wait = start - tc;
      if (wait < 0) wait += cycle;
      return wait;
    }

    function canEnter(arc, t) { return signalWait(arc, t) === 0; }

    // Seconds a vehicle arriving on `arc` at t must hold: signal wait, else a stop-sign hold.
    function controlDelay(arc, t) {
      const w = signalWait(arc, t);
      if (w > 0) return w;
      return arc.stop ? STOP_HOLD : 0;
    }

    // Green seconds per cycle for an arc's approach (0 if unsignalized), and its share of the cycle.
    function greenFor(arc) {
      const g = arc.signal, c = ctlOf[arc.to];
      return (g === 0 || g === 1) && c >= 0 ? greenOf(c, g) : 0;
    }
    const greenShare = (arc) => greenFor(arc) / cycle;

    return { cycle, green, amber, offsets, g0, g1, phase, signalWait, canEnter, controlDelay, greenFor, greenShare };
  }

  const api = { createSignals, STOP_HOLD };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsTraffic = api;
})(typeof window !== "undefined" ? window : globalThis);
