// Capacity and congestion on the street graph (Phase 4). No dependencies.
//
// Each directed arc gets a capacity from its lanes and road-class saturation flow
// (src/motion.js SAT_FLOW), scaled by the approach's green share at signals. Every update measures the
// arc's inflow (smoothed over about five minutes) and the vehicles queued on it, and turns them
// into an expected extra delay for routing:
//   BPR term    free-flow time × 0.15 × (flow / capacity)^4, the classic volume/capacity curve
//   queue term  vehicles queued beyond what one green clears, divided by the discharge rate
// Small delays (under DEADBAND seconds) count as zero, so routes through free-flowing streets
// keep using the free-flow route trees. Chokepoints (the Mississippi road bridges, freeway
// ramps and map-edge entries) are summarised for the live panel.
(function (root) {
  "use strict";

  const isNode = typeof module !== "undefined" && module.exports;

  const PERIOD = 60;          // s between updates
  const TAU = 300;            // s, smoothing time constant for flows
  const DEADBAND = 6;         // s of extra delay below which an arc counts as free-flowing
  const MAX_EXTRA = 1800;     // s, cap on one arc's extra delay
  const DETOUR_MIN = 20;      // s of route delay before a congestion-aware search is worth it
  const NODE_PORTAL = 1;

  // Mississippi road bridges in the study area: name pattern, approximate centre, search radius.
  const BRIDGES = [
    { name: "Plymouth Avenue Bridge", match: /Plymouth/, lat: 44.9927, lon: -93.2742, r: 120 },
    { name: "Hennepin Avenue Bridge", match: /Hennepin/, lat: 44.9852, lon: -93.2642, r: 220 },
    { name: "3rd Avenue Bridge", match: /3rd Avenue Bridge/, lat: 44.9832, lon: -93.2595, r: 300 },
    { name: "I-35W Bridge", match: /I 35W/, lat: 44.9790, lon: -93.2448, r: 240 },
    { name: "10th Avenue Bridge", match: /10th Avenue/, lat: 44.9782, lon: -93.2441, r: 360 },
    { name: "Washington Avenue Bridge", match: /Washington Avenue/, lat: 44.9731, lon: -93.2400, r: 220 },
    { name: "I-94 (Dartmouth) Bridge", match: /^I 94/, lat: 44.9658, lon: -93.2265, r: 240 },
    { name: "Franklin Avenue Bridge", match: /Franklin/, lat: 44.9636, lon: -93.2230, r: 200 },
  ];
  const COMPASS = ["eastbound", "southeastbound", "southbound", "southwestbound", "westbound", "northwestbound", "northbound", "northeastbound"];
  const compass = (dx, dy) => COMPASS[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];   // y points south

  function createCongestion(graph, router, motion, signals, opts = {}) {
    const arcs = router.arcs, A = arcs.length;
    const nflags = graph.nodes.flags;
    const capacity = new Float64Array(A), clearPerGreen = new Float64Array(A), free = new Float64Array(A);
    for (let i = 0; i < A; i++) {
      const lanes = motion.laneCount[i], sat = 3600 / (motion.headway[i] || 3600 / 1800);
      const green = motion.controlled[i] ? signals.greenFor(arcs[i]) : 0;
      capacity[i] = lanes * sat * (motion.controlled[i] ? green / signals.cycle : 1);
      clearPerGreen[i] = motion.controlled[i] ? lanes * green / (3600 / sat) : 0;
      free[i] = arcs[i].baseTime;
    }
    const flow = new Float64Array(A), queue = new Float64Array(A), extra = new Float64Array(A);
    const lastEntries = Float64Array.from(motion.entries);
    let lastT = null, epoch = 0, congestedArcs = 0;

    function update(t, vehicles) {
      if (lastT == null) { lastT = t; lastEntries.set(motion.entries); return; }
      const span = t - lastT;
      if (span <= 0) return;
      const alpha = 1 - Math.exp(-span / TAU);
      for (let i = 0; i < A; i++) {
        const rate = (motion.entries[i] - lastEntries[i]) / span * 3600;
        flow[i] += (rate - flow[i]) * alpha;
      }
      lastEntries.set(motion.entries);
      lastT = t;
      queue.fill(0);
      for (const v of vehicles) if (v.lane >= 0 && (v.waiting === "queue" || v.waiting === "signal" || v.waiting === "stop")) queue[v.route[v.ri]] += v.pcu || 1;   // in cars
      congestedArcs = 0;
      for (let i = 0; i < A; i++) {
        const x = Math.min(flow[i] / capacity[i], 1.5);
        const bpr = free[i] * 0.15 * x * x * x * x;
        const excess = Math.max(0, queue[i] - clearPerGreen[i]);
        let e = bpr + excess / (capacity[i] / 3600);
        if (e < DEADBAND) e = 0;
        extra[i] = Math.min(e, MAX_EXTRA);
        if (e > 0) congestedArcs++;
      }
      epoch++;
    }

    // Expected time to drive arcs[from..] of a route, including congestion.
    function routeTime(route, from = 0) {
      let s = 0;
      for (let i = from; i < route.length; i++) s += free[route[i]] + extra[route[i]];
      return s;
    }
    // Is congestion on this (free-flow) route worth searching for a way around? Only when the
    // delay it adds exceeds DETOUR_MIN seconds and a tenth of the trip: below that the detour can
    // save little, and skipping the search keeps routing on the cached free-flow trees.
    function pathDelayed(route) {
      if (!congestedArcs) return false;
      let d = 0, t = 0;
      for (const a of route) { d += extra[a]; t += free[a]; }
      return d > DETOUR_MIN && d > 0.1 * t;
    }

    // ---------------------------------------------------------------- chokepoints
    const [s, w, n, e] = graph.bbox;
    const toXY = (lat, lon) => [(lon - w) / (e - w) * graph.width, (n - lat) / (n - s) * graph.height];
    const mid = (l) => { const p = l.pts, k = (p.length / 2) >> 1; return [p[k * 2], p[k * 2 + 1]]; };
    const arcVec = (arc) => {
      const p = arc.link.pts, m = p.length / 2;
      const dx = p[(m - 1) * 2] - p[0], dy = p[(m - 1) * 2 + 1] - p[1];
      return arc.forward ? [dx, dy] : [-dx, -dy];
    };
    // Group arcs into directions along the first arc's axis; each direction reports its
    // bottleneck capacity, its flow, and the queue on it and on the arcs feeding it.
    function directions(list) {
      if (!list.length) return [];
      const [ax, ay] = arcVec(list[0]);
      const groups = [[], []];
      for (const arc of list) { const [dx, dy] = arcVec(arc); groups[dx * ax + dy * ay >= 0 ? 0 : 1].push(arc); }
      return groups.filter((g) => g.length).map((g) => {
        let sx = 0, sy = 0;
        for (const arc of g) { const [dx, dy] = arcVec(arc); sx += dx; sy += dy; }
        const ids = new Set(g.map((a) => a.id));
        const feeders = [];
        for (const arc of g) for (const f of graph.inc[arc.from]) if (!ids.has(f.id) && f.to === arc.from) feeders.push(f.id);
        return { label: compass(sx, sy), arcs: [...ids], feeders: [...new Set(feeders)] };
      });
    }
    const bridges = BRIDGES.map((b) => {
      const [x, y] = toXY(b.lat, b.lon);
      const list = arcs.filter((arc) => (arc.link.flags & 1) && b.match.test(arc.link.name) &&
        Math.hypot(mid(arc.link)[0] - x, mid(arc.link)[1] - y) <= b.r);
      return { kind: "bridge", name: b.name, x, y, dirs: directions(list) };
    }).filter((b) => b.dirs.length);

    // Freeway ramps: chains of consecutive ramp arcs, named from the streets at their ends.
    const isRamp = (arc) => /^(motorway_link|trunk_link)$/.test(arc.link.className);
    const ramps = [];
    for (const arc of arcs) {
      if (!isRamp(arc) || graph.inc[arc.from].some((f) => isRamp(f) && f.link !== arc.link)) continue;
      const chain = [arc];
      let cur = arc;
      for (let k = 0; k < 20; k++) {
        const outs = graph.out[cur.to].filter((o) => isRamp(o) && o.link !== cur.link);
        if (outs.length !== 1 || graph.inc[cur.to].filter(isRamp).length > 1) break;
        cur = outs[0];
        chain.push(cur);
      }
      const fromName = graph.inc[arc.from].find((f) => !isRamp(f) && f.link.name)?.link.name;
      const toName = graph.out[cur.to].find((o) => !isRamp(o) && o.link.name)?.link.name;
      const label = fromName && toName ? `${fromName} → ${toName}` : toName ? `ramp to ${toName}` : fromName ? `ramp from ${fromName}` : "freeway ramp";
      const [x, y] = mid(chain[chain.length >> 1].link);
      ramps.push({ kind: "ramp", name: label, x, y, dirs: [{ label: "", arcs: chain.map((c) => c.id), feeders: graph.inc[arc.from].filter((f) => !isRamp(f)).map((f) => f.id) }] });
    }

    // Map-edge entries: where traffic arrives from outside.
    const portals = [];
    for (let v = 0; v < graph.nodes.count; v++) {
      if (!(nflags[v] & NODE_PORTAL)) continue;
      const outs = graph.out[v].filter((a) => !a.psvOnly);
      if (!outs.length) continue;
      const x = graph.nodes.x[v], y = graph.nodes.y[v];
      const edge = ["west", "east", "north", "south"][[x, graph.width - x, y, graph.height - y].reduce((bi, d, i, a) => (d < a[bi] ? i : bi), 0)];
      const road = outs.find((a) => a.link.name)?.link.name || outs[0].link.className;
      portals.push({ kind: "portal", node: v, name: `${road} (${edge} edge)`, x, y, dirs: [{ label: "", arcs: outs.map((a) => a.id), feeders: [] }] });
    }

    function measure(c, vehicles) {
      let worst = 0, total = 0, q = 0;
      const dirs = c.dirs.map((d) => {
        let f = 0, cap = Infinity, dq = 0;
        for (const a of d.arcs) { if (flow[a] > f) f = flow[a]; if (capacity[a] < cap) cap = capacity[a]; dq += queue[a]; }
        for (const a of d.feeders) dq += queue[a];
        const vc = cap < Infinity ? f / cap : 0;
        if (vc > worst) worst = vc;
        total += f; q += dq;
        return { label: d.label, flow: f, capacity: cap, vc, queue: dq };
      });
      if (c.kind === "portal" && vehicles) for (const v of vehicles) if (v.lane < 0 && v.route && v.node === c.node) q += v.pcu || 1;
      return { kind: c.kind, name: c.name, x: c.x, y: c.y, flow: total, vc: worst, queue: q, dirs };
    }
    // Live summary: every bridge, and the most loaded ramps and entries.
    function chokepoints(vehicles, top = 4) {
      const rank = (list) => list.map((c) => measure(c, vehicles))
        .sort((a, b) => b.queue - a.queue || b.vc - a.vc).slice(0, top);
      return { bridges: bridges.map((b) => measure(b, vehicles)), ramps: rank(ramps), portals: rank(portals) };
    }

    function reset() {
      flow.fill(0); queue.fill(0); extra.fill(0);
      lastT = null; congestedArcs = 0; epoch++;
    }

    return {
      capacity, flow, queue, extra, free, bridges, ramps, portals, PERIOD,
      update, reset, routeTime, pathDelayed, chokepoints, measure,
      cost: (i) => extra[i],
      get epoch() { return epoch; },
      get congestedArcs() { return congestedArcs; },
    };
  }

  const api = { createCongestion, BRIDGES, PERIOD, DEADBAND };
  if (isNode) module.exports = api;
  else root.MplsCongestion = api;
})(typeof window !== "undefined" ? window : globalThis);
