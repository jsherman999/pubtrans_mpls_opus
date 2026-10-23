// Decoder for data/mpls_graph.js (format: docs/DATA_FORMAT.md).
// Shared by viewer.html and, from Phase 3, the simulation. No dependencies.
(function (root) {
  "use strict";

  const DIR_AB = 1, DIR_BA = 2, DIR_AB_PSV = 4, DIR_BA_PSV = 8;
  const FLAG_BRIDGE = 1, FLAG_TUNNEL = 2, FLAG_STOP_AT_A = 4, FLAG_STOP_AT_B = 8;
  const NODE_PORTAL = 1, NODE_SIGNAL = 2;
  const SIG_NONE = -1, SIG_INTERNAL = 2;

  function decodeMplsGraph(raw) {
    if (!raw || raw.v !== 1) throw new Error("Unsupported street graph format: expected version 1");
    const u = raw.unitsPerMeter;
    const N = raw.nodes.x.length;
    const nodes = {
      count: N,
      x: new Float64Array(N),
      y: new Float64Array(N),
      flags: Uint8Array.from(raw.nodes.flags),
      ctl: Int32Array.from(raw.nodes.ctl),
    };
    for (let i = 0; i < N; i++) {
      nodes.x[i] = raw.nodes.x[i] / u;
      nodes.y[i] = raw.nodes.y[i] / u;
    }

    const L = raw.links;
    const M = L.a.length;
    const links = new Array(M);
    const out = Array.from({ length: N }, () => []);   // directed arcs leaving each node
    const inc = Array.from({ length: N }, () => []);   // directed arcs arriving at each node
    const shapes = raw.shapes;
    let off = 0;
    for (let j = 0; j < M; j++) {
      const a = L.a[j], b = L.b[j], n = L.shp[j];
      const pts = new Float64Array((n + 2) * 2);
      let px = raw.nodes.x[a], py = raw.nodes.y[a];
      pts[0] = px / u; pts[1] = py / u;
      for (let k = 1; k <= n; k++) {
        px += shapes[off++]; py += shapes[off++];
        pts[k * 2] = px / u; pts[k * 2 + 1] = py / u;
      }
      pts[(n + 1) * 2] = nodes.x[b]; pts[(n + 1) * 2 + 1] = nodes.y[b];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, geoLen = 0;
      for (let k = 0; k < pts.length; k += 2) {
        if (k) geoLen += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
        if (pts[k] < minX) minX = pts[k];
        if (pts[k] > maxX) maxX = pts[k];
        if (pts[k + 1] < minY) minY = pts[k + 1];
        if (pts[k + 1] > maxY) maxY = pts[k + 1];
      }
      const dir = L.dir[j];
      const link = {
        id: j, a, b, dir,
        kph: L.kph[j], lanesAB: L.lf[j], lanesBA: L.lb[j],
        cls: L.cls[j], className: raw.classes[L.cls[j]],
        flags: L.flags[j], name: raw.names[L.name[j]] || "",
        sigA: L.sigA[j], sigB: L.sigB[j],
        // Length from the decoded geometry so pointAlong() ends exactly on the far node.
        len: geoLen, way: L.way[j],
        pts, bbox: [minX, minY, maxX, maxY],
        oneWay: !((dir & (DIR_AB | DIR_AB_PSV)) && (dir & (DIR_BA | DIR_BA_PSV))),
        psvOnlyAB: !(dir & DIR_AB) && !!(dir & DIR_AB_PSV),
        psvOnlyBA: !(dir & DIR_BA) && !!(dir & DIR_BA_PSV),
      };
      link.psvOnly = !(dir & (DIR_AB | DIR_BA));
      links[j] = link;
      if (dir & (DIR_AB | DIR_AB_PSV)) {
        const arc = { link, from: a, to: b, forward: true, psvOnly: link.psvOnlyAB,
          signal: link.sigB, stop: !!(link.flags & FLAG_STOP_AT_B) };
        out[a].push(arc); inc[b].push(arc);
      }
      if (dir & (DIR_BA | DIR_BA_PSV)) {
        const arc = { link, from: b, to: a, forward: false, psvOnly: link.psvOnlyBA,
          signal: link.sigA, stop: !!(link.flags & FLAG_STOP_AT_A) };
        out[b].push(arc); inc[a].push(arc);
      }
    }
    if (off !== shapes.length) throw new Error("Street graph geometry is truncated or corrupt");

    return {
      label: raw.label || "",
      attribution: raw.attribution,
      bbox: raw.bbox,
      width: raw.size[0] / u,
      height: raw.size[1] / u,
      classes: raw.classes,
      nodes, links, out, inc,
      controllers: raw.controllers.axis.map((axis, id) => ({ id, axis })),
    };
  }

  // Point at distance s (meters) along a link, measured from the start of travel.
  function pointAlong(link, s, forward = true) {
    const p = link.pts, n = p.length / 2;
    let d = forward ? s : link.len - s;
    if (d <= 0) return [p[0], p[1]];
    for (let k = 0; k < n - 1; k++) {
      const dx = p[k * 2 + 2] - p[k * 2], dy = p[k * 2 + 3] - p[k * 2 + 1];
      const seg = Math.hypot(dx, dy);
      if (d <= seg) {
        const t = seg ? d / seg : 0;
        return [p[k * 2] + dx * t, p[k * 2 + 1] + dy * t];
      }
      d -= seg;
    }
    return [p[(n - 1) * 2], p[(n - 1) * 2 + 1]];
  }

  // Squared distance from (x, y) to the link polyline.
  function distanceToLink2(link, x, y) {
    const p = link.pts;
    let best = Infinity;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k], ay = p[k + 1], bx = p[k + 2], by = p[k + 3];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + dx * t - x, ey = ay + dy * t - y;
      const d2 = ex * ex + ey * ey;
      if (d2 < best) best = d2;
    }
    return best;
  }

  // Uniform grid over link bounding boxes for picking and culling.
  function buildLinkIndex(graph, cell = 100) {
    const cols = Math.max(1, Math.ceil(graph.width / cell) + 2);
    const rows = Math.max(1, Math.ceil(graph.height / cell) + 2);
    const buckets = new Map();
    const key = (c, r) => r * cols + c;
    const clampC = (v) => Math.min(cols - 1, Math.max(0, Math.floor(v / cell) + 1));
    const clampR = (v) => Math.min(rows - 1, Math.max(0, Math.floor(v / cell) + 1));
    for (const link of graph.links) {
      const [x0, y0, x1, y1] = link.bbox;
      for (let r = clampR(y0); r <= clampR(y1); r++)
        for (let c = clampC(x0); c <= clampC(x1); c++) {
          const k = key(c, r);
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(link);
        }
    }
    return {
      nearest(x, y, maxDist) {
        let best = null, bestD2 = maxDist * maxDist;
        const seen = new Set();
        for (let r = clampR(y - maxDist); r <= clampR(y + maxDist); r++)
          for (let c = clampC(x - maxDist); c <= clampC(x + maxDist); c++)
            for (const link of buckets.get(key(c, r)) || []) {
              if (seen.has(link)) continue;
              seen.add(link);
              const d2 = distanceToLink2(link, x, y);
              if (d2 < bestD2) { bestD2 = d2; best = link; }
            }
        return best;
      },
    };
  }

  const api = {
    decodeMplsGraph, pointAlong, distanceToLink2, buildLinkIndex,
    DIR_AB, DIR_BA, DIR_AB_PSV, DIR_BA_PSV,
    FLAG_BRIDGE, FLAG_TUNNEL, FLAG_STOP_AT_A, FLAG_STOP_AT_B,
    NODE_PORTAL, NODE_SIGNAL, SIG_NONE, SIG_INTERNAL,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsGraph = api;
})(typeof window !== "undefined" ? window : globalThis);
