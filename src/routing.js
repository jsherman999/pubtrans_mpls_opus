// Routing on the decoded street graph (src/graph.js). No dependencies.
//
// Costs are travel times in seconds: link length at the posted speed, plus an expected delay
// for arriving at a signal approach or a stop sign. A* uses straight-line distance at the
// network's top speed as its heuristic, which never overestimates because a link's polyline
// is never shorter than the straight line between its ends.
(function (root) {
  "use strict";

  const MODE_GENERAL = 1;   // private cars: no shuttle/bus-only links
  const MODE_PSV = 2;       // SDEV shuttles and buses: may use shuttle/bus-only links
  const NODE_PORTAL = 1;

  // Binary min-heap of (priority, id) with lazy deletion; callers skip stale entries.
  class MinHeap {
    constructor(cap = 1024) {
      this.pri = new Float64Array(cap);
      this.ids = new Int32Array(cap);
      this.n = 0;
    }
    clear() { this.n = 0; }
    push(id, p) {
      if (this.n === this.ids.length) {
        const pri = new Float64Array(this.n * 2), ids = new Int32Array(this.n * 2);
        pri.set(this.pri); ids.set(this.ids);
        this.pri = pri; this.ids = ids;
      }
      let i = this.n++;
      const pr = this.pri, id_ = this.ids;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (pr[parent] <= p) break;
        pr[i] = pr[parent]; id_[i] = id_[parent];
        i = parent;
      }
      pr[i] = p; id_[i] = id;
    }
    // Removes the minimum; returns its id. Its priority is left in this.top.
    pop() {
      const pr = this.pri, ids = this.ids;
      const id = ids[0];
      this.top = pr[0];
      const n = --this.n;
      if (n > 0) {
        const p = pr[n], last = ids[n];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && pr[c + 1] < pr[c]) c++;
          if (pr[c] >= p) break;
          pr[i] = pr[c]; ids[i] = ids[c];
          i = c;
        }
        pr[i] = p; ids[i] = last;
      }
      return id;
    }
  }

  function createRouter(graph, opts = {}) {
    const signalDelay = opts.signalDelay ?? 8;   // s, expected wait arriving at a signal approach
    const stopDelay = opts.stopDelay ?? 4;       // s, stop-sign hold plus braking
    const cacheLimit = opts.cacheLimit ?? 5000;

    const N = graph.nodes.count;
    const nx = graph.nodes.x, ny = graph.nodes.y, nflags = graph.nodes.flags;

    // Flatten every directed arc into compressed (CSR) arrays.
    const arcs = [];
    const outStart = new Int32Array(N + 1);
    for (let v = 0; v < N; v++) {
      outStart[v] = arcs.length;
      for (const arc of graph.out[v]) { arc.id = arcs.length; arcs.push(arc); }
    }
    outStart[N] = arcs.length;
    const A = arcs.length;
    const arcTo = new Int32Array(A), arcFrom = new Int32Array(A);
    const arcLen = new Float64Array(A), arcTime = new Float64Array(A);
    const arcPsvOnly = new Uint8Array(A);
    let maxMps = 0;
    for (let i = 0; i < A; i++) {
      const arc = arcs[i], mps = Math.max(arc.link.kph, 5) / 3.6;
      if (mps > maxMps) maxMps = mps;
      arcFrom[i] = arc.from; arcTo[i] = arc.to;
      arcLen[i] = arc.link.len;
      arcPsvOnly[i] = arc.psvOnly ? 1 : 0;
      const control = (arc.signal === 0 || arc.signal === 1) ? signalDelay : arc.stop ? stopDelay : 0;
      arc.baseTime = arcTime[i] = arc.link.len / mps + control;
    }
    const invMax = maxMps > 0 ? 1 / maxMps : 0;

    // Per-search scratch, reset by stamping instead of clearing.
    const dist = new Float64Array(N);
    const prev = new Int32Array(N);
    const seenStamp = new Uint32Array(N);
    const doneStamp = new Uint32Array(N);
    let stamp = 0;
    const heap = new MinHeap(4096);

    const cache = new Map();
    let epoch = 0;
    const stats = { searches: 0, settled: 0, cacheHits: 0 };

    // One shortest-time search. options:
    //   mode       MODE_GENERAL (default) or MODE_PSV
    //   banned     Set of arc ids, or Uint8Array indexed by arc id, that may not be used
    //   cost(id)   extra seconds for arc id (congestion, closures as Infinity); must be >= 0
    //              to keep A* exact, or pass heuristic: false
    //   heuristic  false gives plain Dijkstra
    //   portalTransit  true lets a route pass through a portal (off-map U-turn); default false
    function search(from, to, o = {}) {
      if (from === to) return { from, to, arcs: [], time: 0, length: 0 };
      const mode = o.mode || MODE_GENERAL;
      const banned = o.banned;
      const bannedSet = banned instanceof Set ? banned : null;
      const bannedArr = banned && !bannedSet ? banned : null;
      const extra = o.cost || null;
      const useH = o.heuristic !== false;
      const portalTransit = !!o.portalTransit;
      if (++stamp === 0xffffffff) { seenStamp.fill(0); doneStamp.fill(0); stamp = 1; }
      stats.searches++;
      const tx = nx[to], ty = ny[to];
      const h = useH ? (v) => Math.hypot(nx[v] - tx, ny[v] - ty) * invMax : () => 0;

      heap.clear();
      dist[from] = 0; prev[from] = -1; seenStamp[from] = stamp;
      heap.push(from, h(from));
      while (heap.n) {
        const v = heap.pop();
        if (doneStamp[v] === stamp) continue;
        doneStamp[v] = stamp;
        stats.settled++;
        if (v === to) break;
        if (v !== from && !portalTransit && (nflags[v] & NODE_PORTAL)) continue;
        const dv = dist[v];
        for (let i = outStart[v], end = outStart[v + 1]; i < end; i++) {
          if (arcPsvOnly[i] && mode !== MODE_PSV) continue;
          if (bannedSet ? bannedSet.has(i) : bannedArr && bannedArr[i]) continue;
          let c = arcTime[i];
          if (extra) {
            const e = extra(i);
            if (!(e < Infinity)) continue;
            c += e;
          }
          const w = arcTo[i], nd = dv + c;
          if (seenStamp[w] !== stamp || nd < dist[w]) {
            if (doneStamp[w] === stamp) continue;
            seenStamp[w] = stamp; dist[w] = nd; prev[w] = i;
            heap.push(w, nd + h(w));
          }
        }
      }
      if (doneStamp[to] !== stamp) return null;
      const path = [];
      let length = 0;
      for (let v = to; v !== from;) {
        const i = prev[v];
        path.push(i);
        length += arcLen[i];
        v = arcFrom[i];
      }
      path.reverse();
      return { from, to, arcs: path, time: dist[to], length };
    }

    // Cached shortest route for the plain case (no bans or extra cost). invalidate() clears it,
    // e.g. when congestion weights change enough to matter. Cached results are shared: treat
    // them as read-only.
    function route(from, to, o = {}) {
      if (o.banned || o.cost || o.heuristic === false || o.portalTransit) return search(from, to, o);
      const key = from * N * 4 + to * 4 + (o.mode || MODE_GENERAL);
      const hit = cache.get(key);
      if (hit !== undefined) {
        stats.cacheHits++;
        cache.delete(key); cache.set(key, hit);   // refresh LRU position
        return hit;
      }
      const r = search(from, to, o);
      cache.set(key, r);
      if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
      return r;
    }

    function invalidate() { cache.clear(); epoch++; }

    // Up to k distinct alternatives, best first. Like the source app, alternatives come from
    // banning arcs of the best route one at a time (a bounded sample of them), then keeping
    // routes that differ enough from those already chosen (shared length / length < maxOverlap).
    function kShortest(from, to, k = 3, o = {}) {
      const best = search(from, to, o);
      if (!best) return [];
      if (k <= 1 || !best.arcs.length) return [best];
      const maxOverlap = o.maxOverlap ?? 0.8;
      const samples = o.samples ?? 12;
      const baseBan = o.banned instanceof Set ? o.banned : null;
      const found = [];
      const seen = new Set([best.arcs.join(",")]);
      const n = best.arcs.length;
      const step = Math.max(1, Math.floor(n / samples));
      for (let j = Math.floor(step / 2); j < n; j += step) {
        const ban = new Set(baseBan || []);
        ban.add(best.arcs[j]);
        const r = search(from, to, { ...o, banned: ban });
        if (!r) continue;
        const key = r.arcs.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(r);
      }
      found.sort((p, q) => p.time - q.time);
      const chosen = [best];
      for (const r of found) {
        if (chosen.length >= k) break;
        if (chosen.every((c) => overlap(r, c) < maxOverlap)) chosen.push(r);
      }
      return chosen;
    }

    function overlap(r, c) {
      const s = new Set(c.arcs.map((i) => arcs[i].link.id));
      let shared = 0;
      for (const i of r.arcs) if (s.has(arcs[i].link.id)) shared += arcLen[i];
      return r.length ? shared / Math.min(r.length, c.length || r.length) : 1;
    }

    // Polyline [x0, y0, x1, y1, ...] in meters for drawing a route.
    function routePoints(r) {
      const out = [];
      for (let n = 0; n < r.arcs.length; n++) {
        const arc = arcs[r.arcs[n]], p = arc.link.pts, m = p.length / 2;
        for (let k = (n ? 1 : 0); k < m; k++) {
          const idx = arc.forward ? k : m - 1 - k;
          out.push(p[idx * 2], p[idx * 2 + 1]);
        }
      }
      return out;
    }

    // Nearest node to (x, y), optionally filtered (e.g. skip portals). Uniform grid lookup.
    const CELL = 150;
    const gcols = Math.max(1, Math.ceil(graph.width / CELL) + 1);
    const grows = Math.max(1, Math.ceil(graph.height / CELL) + 1);
    const grid = new Map();
    const cellOf = (x, y) => Math.min(grows - 1, Math.max(0, Math.floor(y / CELL))) * gcols +
      Math.min(gcols - 1, Math.max(0, Math.floor(x / CELL)));
    for (let v = 0; v < N; v++) {
      const c = cellOf(nx[v], ny[v]);
      if (!grid.has(c)) grid.set(c, []);
      grid.get(c).push(v);
    }
    function nearestNode(x, y, accept = null) {
      const c0 = Math.min(gcols - 1, Math.max(0, Math.floor(x / CELL)));
      const r0 = Math.min(grows - 1, Math.max(0, Math.floor(y / CELL)));
      let best = -1, bestD = Infinity;
      for (let ring = 0; ring < Math.max(gcols, grows); ring++) {
        for (let r = r0 - ring; r <= r0 + ring; r++) {
          if (r < 0 || r >= grows) continue;
          for (let c = c0 - ring; c <= c0 + ring; c++) {
            if (c < 0 || c >= gcols) continue;
            if (ring && r !== r0 - ring && r !== r0 + ring && c !== c0 - ring && c !== c0 + ring) continue;
            for (const v of grid.get(r * gcols + c) || []) {
              if (accept && !accept(v)) continue;
              const d = Math.hypot(nx[v] - x, ny[v] - y);
              if (d < bestD) { bestD = d; best = v; }
            }
          }
        }
        // Any node outside this ring is at least ring * CELL away.
        if (best >= 0 && bestD <= ring * CELL) break;
      }
      return best;
    }

    return {
      arcs, arcCount: A, maxSpeedMps: maxMps,
      route, search, kShortest, invalidate, routePoints, nearestNode,
      get epoch() { return epoch; },
      stats,
    };
  }

  const api = { createRouter, MinHeap, MODE_GENERAL, MODE_PSV };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsRouting = api;
})(typeof window !== "undefined" ? window : globalThis);
