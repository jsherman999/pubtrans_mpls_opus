// Building footprints (data/mpls_buildings.js, built by tools/build_buildings.py): decoding, a
// spatial index, and the 3D parts each building is drawn with — a plain extrusion for most, a
// hand-built design for six landmarks. Shared by the map (top-down footprints) and the Driver
// POV (src/pov.js). No dependencies.
//
// A part is { poly: [x0, y0, x1, y1, ...] (meters, map coordinates), z0, z1 (number, or an array
// with one top height per vertex for sloped roofs), wall, roof } plus optional { kind: "bowl",
// inner } for stadium seating. Colours are hex strings; the POV shades walls by orientation.
(function (root) {
  "use strict";

  const WALL = {   // by kind (see tools/build_buildings.py KINDS)
    house: "#b9ad9c", apartments: "#a99887", commercial: "#a7a29a", office: "#8e9aa6", university: "#b08a6e",
    civic: "#a59a88", industrial: "#9b9488", garage: "#8f8a83", parking: "#9a9690", stadium: "#8c8f94",
    church: "#a3907c", other: "#a39d94",
  };
  const ROOF = "#6f6b66";

  function decodeBuildings(raw) {
    if (!raw || raw.v !== 1) throw new Error("Unsupported buildings format: expected version 1");
    const B = raw.buildings, u = raw.unit, P = raw.pts;
    const list = new Array(B.n.length);
    let off = 0;
    for (let i = 0; i < B.n.length; i++) {
      const n = B.n[i], pts = new Float32Array(n * 2);
      let x = B.x0[i], y = B.y0[i];
      pts[0] = x * u; pts[1] = y * u;
      let minX = pts[0], maxX = pts[0], minY = pts[1], maxY = pts[1], sx = pts[0], sy = pts[1];
      for (let k = 1; k < n; k++) {
        x += P[off++]; y += P[off++];
        const px = x * u, py = y * u;
        pts[k * 2] = px; pts[k * 2 + 1] = py;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        sx += px; sy += py;
      }
      const kind = raw.kinds[B.k[i]];
      list[i] = {
        i, pts, n, h: B.h[i] / 10, mh: B.mh[i] / 10, kind, name: raw.names[B.name[i]] || "",
        cx: sx / n, cy: sy / n, bbox: [minX, minY, maxX, maxY],
        r: Math.hypot(maxX - minX, maxY - minY) / 2, parts: null,
      };
    }
    if (off !== P.length) throw new Error("Building geometry is truncated or corrupt");
    // 100 m grid over bounding boxes.
    const CELL = 100, grid = new Map();
    const key = (cx, cy) => cy * 4096 + cx;
    for (const b of list) {
      for (let cy = Math.floor(b.bbox[1] / CELL); cy <= Math.floor(b.bbox[3] / CELL); cy++)
        for (let cx = Math.floor(b.bbox[0] / CELL); cx <= Math.floor(b.bbox[2] / CELL); cx++) {
          const k = key(cx, cy);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(b);
        }
    }
    let stamp = 0;
    // Buildings whose bounding box meets the rectangle, each once.
    function query(x0, y0, x1, y1) {
      stamp++;
      const out = [];
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++)
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
          for (const b of grid.get(key(cx, cy)) || []) {
            if (b.seen === stamp) continue;
            b.seen = stamp;
            if (b.bbox[2] >= x0 && b.bbox[0] <= x1 && b.bbox[3] >= y0 && b.bbox[1] <= y1) out.push(b);
          }
      return out;
    }
    const byName = new Map();
    for (const b of list) if (b.name) { if (!byName.has(b.name)) byName.set(b.name, []); byName.get(b.name).push(b); }
    return { list, query, byName, attribution: raw.attribution };
  }

  // ---------------------------------------------------------------- 3D parts
  const flat = (b) => Array.from(b.pts);
  const area = (p) => { let a = 0; for (let i = 0; i < p.length; i += 2) { const j = (i + 2) % p.length; a += p[i] * p[j + 1] - p[j] * p[i + 1]; } return a / 2; };
  function scaled(p, cx, cy, f) { const out = []; for (let i = 0; i < p.length; i += 2) out.push(cx + (p[i] - cx) * f, cy + (p[i + 1] - cy) * f); return out; }
  function box(cx, cy, hx, hy, ang, z0, z1, wall, roof) {
    const c = Math.cos(ang), s = Math.sin(ang), poly = [];
    for (const [a, d] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) poly.push(cx + a * c - d * s, cy + a * s + d * c);
    return { poly, z0, z1, wall, roof: roof || wall };
  }

  // Hand-built designs for six landmarks (Phase 7). Shapes are simplified from photographs and
  // the OSM footprint; heights from OSM where tagged.
  const DESIGNS = {
    // Zinc walls and a translucent roof sloping from the high prow facing downtown (west) down
    // toward the east end.
    "US Bank Stadium": (b) => {
      const p = flat(b), [x0, , x1] = b.bbox;
      const top = [];
      for (let i = 0; i < p.length; i += 2) top.push(b.h - 40 * (p[i] - x0) / (x1 - x0 || 1));
      return [{ poly: p, z0: 0, z1: top, wall: "#3e4852", roof: "#c4d2dc" }];
    },
    // Blue glass, its zigzag corners already in the footprint.
    "IDS Tower": (b) => [{ poly: flat(b), z0: b.mh, z1: b.h, wall: "#3c6e9c", roof: "#2b4c6c" }],
    // Dark arena with its green roof.
    "Target Center": (b) => [{ poly: flat(b), z0: 0, z1: b.h, wall: "#5d524b", roof: "#5f8f4e" }],
    // Brick hall with a columned portico on the side facing the mall (south: largest y).
    "Northrop Memorial Auditorium": (b) => {
      const p = flat(b), parts = [{ poly: p, z0: 0, z1: Math.max(b.h, 22), wall: "#9c5a3c", roof: "#6c665f" }];
      let best = -1, bi = 0;
      for (let i = 0; i < p.length; i += 2) {
        const j = (i + 2) % p.length, len = Math.hypot(p[j] - p[i], p[j + 1] - p[i + 1]);
        const score = (p[i + 1] + p[j + 1]) / 2 + len * 0.5;
        if (len > 25 && score > best) { best = score; bi = i; }
      }
      const j = (bi + 2) % p.length, ax = p[bi], ay = p[bi + 1], bx = p[j], by = p[j + 1];
      const len = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / len, uy = (by - ay) / len;
      const nx = uy, ny = -ux;   // outward for counter-clockwise rings (x east, y south)
      const ang = Math.atan2(uy, ux), cols = 10, span = Math.min(len * 0.6, 50);
      for (let k = 0; k < cols; k++) {
        const t = (len - span) / 2 + span * k / (cols - 1);
        parts.push(box(ax + ux * t + nx * 3, ay + uy * t + ny * 3, 0.7, 0.7, ang, 0, 18, "#e2dccf"));
      }
      parts.push(box(ax + ux * len / 2 + nx * 3, ay + uy * len / 2 + ny * 3, span / 2 + 1.5, 1.6, ang, 18, 21, "#d8d1c3"));
      return parts;
    },
    // Brick union with its central tower.
    "Coffman Memorial Union": (b) => [
      { poly: flat(b), z0: 0, z1: b.h, wall: "#a8653f", roof: "#5e5a55" },
      box(b.cx, b.cy, 7, 7, 0, b.h, b.h + 16, "#a8653f", "#4f4b47"),
    ],
    // Horseshoe bowl: limestone outer wall, maroon seating sloping to the field, green field.
    "Huntington Bank Stadium": (b) => {
      const outer = flat(b), inner = scaled(outer, b.cx, b.cy, 0.62);
      return [
        { poly: outer, z0: 0, z1: 26, wall: "#b49a7a", roof: null, kind: "bowl", inner, innerZ: 3, seats: "#7a0019", field: "#4f8a3c" },
      ];
    },
  };

  // Parts for a building, built once and cached.
  function partsOf(b) {
    if (b.parts) return b.parts;
    const d = DESIGNS[b.name];
    if (d) b.parts = d(b);
    else {
      const p = flat(b);
      if (area(p) < 0) { /* rings are stored counter-clockwise; keep as is */ }
      b.parts = [{ poly: p, z0: b.mh, z1: b.h, wall: WALL[b.kind] || WALL.other, roof: ROOF }];
    }
    b.landmark = !!d;
    return b.parts;
  }

  const api = { decodeBuildings, partsOf, DESIGNS, WALL, LANDMARKS: Object.keys(DESIGNS) };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsBuildings = api;
})(typeof window !== "undefined" ? window : globalThis);
