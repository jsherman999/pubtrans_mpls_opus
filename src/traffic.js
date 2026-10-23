// Traffic control on the decoded street graph (src/graph.js). No dependencies.
//
// Each signal controller (a cluster of OpenStreetMap signal nodes, see docs/DATA_FORMAT.md)
// alternates its two phase groups, using the source app's timing: 30 s green per group with a
// 3 s transition in which neither group may enter. Controllers get deterministic offsets so the
// city's signals are not all in step; a coordinated plan can replace offsets later.
// Stop signs hold a vehicle for STOP_HOLD seconds before it may enter the intersection.
(function (root) {
  "use strict";

  const STOP_HOLD = 3;

  function createSignals(graph, opts = {}) {
    const green = opts.green ?? 30;
    const amber = opts.amber ?? 3;
    const cycle = 2 * (green + amber);
    const count = graph.controllers.length;
    const offsets = new Float64Array(count);
    for (let c = 0; c < count; c++) {
      // Knuth multiplicative hash of the controller id, spread over the cycle.
      const hsh = (Math.imul(c + 1 + (opts.seed || 0), 2654435761) >>> 0) / 4294967296;
      offsets[c] = opts.offsets ? opts.offsets[c] : hsh * cycle;
    }
    const ctlOf = graph.nodes.ctl;

    // Phase position of controller c at time t (seconds): which group is green, if any, and
    // how long until the given group's next green starts.
    function phase(c, t) {
      let tc = (t + offsets[c]) % cycle;
      if (tc < 0) tc += cycle;
      if (tc < green) return { green: 0, tc };
      if (tc < green + amber) return { green: -1, tc };
      if (tc < 2 * green + amber) return { green: 1, tc };
      return { green: -1, tc };
    }

    // Seconds a vehicle arriving on `arc` at time t must wait for its signal (0 if green or none).
    function signalWait(arc, t) {
      const g = arc.signal;
      if (g !== 0 && g !== 1) return 0;
      const c = ctlOf[arc.to];
      if (c < 0) return 0;
      const { tc } = phase(c, t);
      const start = g === 0 ? 0 : green + amber;
      if (tc >= start && tc < start + green) return 0;
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

    return { cycle, green, amber, offsets, phase, signalWait, canEnter, controlDelay };
  }

  const api = { createSignals, STOP_HOLD };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsTraffic = api;
})(typeof window !== "undefined" ? window : globalThis);
