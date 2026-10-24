// Driver POV: a perspective view from a vehicle, drawn on a canvas — roads from the street graph,
// buildings extruded from their footprints (src/buildings.js), landmark designs, other vehicles.
// Distance culling and level of detail keep it to a few hundred faces downtown. No dependencies.
//
// Camera space follows the source app: fwd along the heading, right to the driver's right,
// z up; map coordinates are x east, y south (meters).
(function (root) {
  "use strict";

  const FOV = 75 * Math.PI / 180;
  const NEAR = 1.5;
  const FAR_BUILDINGS = 450;      // m: buildings beyond are not drawn...
  const FAR_TALL = 1500;          // ...except towers over 60 m, the skyline
  const FAR_ROADS = 260;
  const DETAIL = 140;             // m: edges stroked and roofs shaded only nearer than this
  const LIGHT = [0.55, -0.35, 0.76];   // sun from the south-east, up (x east, y south, z up)
  const ROAD_W = { motorway: 12, motorway_link: 7, trunk: 10, trunk_link: 7, primary: 13, secondary: 12, tertiary: 10,
    residential: 8, unclassified: 8, service: 5, living_street: 6, busway: 7 };

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
    return `rgb(${c(16)},${c(8)},${c(0)})`;
  }

  function createPov(options) {
    const { graph, buildings } = options;
    const MB = root.MplsBuildings;
    // Road segments in a 100 m grid.
    const CELL = 100, roadGrid = new Map();
    const key = (cx, cy) => cy * 4096 + cx;
    for (const l of graph.links) {
      const p = l.pts, w = ROAD_W[l.className] || 8;
      for (let k = 0; k + 3 < p.length; k += 2) {
        const seg = { x0: p[k], y0: p[k + 1], x1: p[k + 2], y1: p[k + 3], w, psv: l.psvOnly };
        const cx = Math.floor((p[k] + p[k + 2]) / 2 / CELL), cy = Math.floor((p[k + 1] + p[k + 3]) / 2 / CELL);
        if (!roadGrid.has(key(cx, cy))) roadGrid.set(key(cx, cy), []);
        roadGrid.get(key(cx, cy)).push(seg);
      }
    }
    const stats = { buildings: 0, faces: 0, roads: 0, vehicles: 0, ms: 0, landmarks: [] };
    const tall = buildings ? buildings.list.filter((b) => b.h > 60) : [];
    let frame = 1;
    let W = 0, H = 0, F = 0, HZ = 0;

    function render(ctx, w, h, cam, vehicles = []) {
      const t0 = (root.performance || Date).now();
      W = w; H = h; F = (W / 2) / Math.tan(FOV / 2); HZ = H * 0.52;
      const cos = Math.cos(cam.heading), sin = Math.sin(cam.heading);
      const toCam = (x, y, z) => { const dx = x - cam.x, dy = y - cam.y; return [dx * cos + dy * sin, -dx * sin + dy * cos, z - cam.z]; };
      const proj = (v) => [W / 2 + F * v[1] / v[0], HZ - F * v[2] / v[0]];
      // Near-plane clip, then project and trace; returns false when nothing is in front.
      function trace(verts) {
        const out = [];
        for (let i = 0; i < verts.length; i++) {
          const a = verts[i], b = verts[(i + 1) % verts.length];
          if (a[0] >= NEAR) out.push(a);
          if ((a[0] >= NEAR) !== (b[0] >= NEAR)) {
            const t = (NEAR - a[0]) / (b[0] - a[0]);
            out.push([NEAR, a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
          }
        }
        if (out.length < 3) return false;
        ctx.beginPath();
        let [px, py] = proj(out[0]);
        ctx.moveTo(px, py);
        for (let i = 1; i < out.length; i++) { [px, py] = proj(out[i]); ctx.lineTo(px, py); }
        ctx.closePath();
        return true;
      }
      stats.buildings = stats.faces = stats.roads = stats.vehicles = 0;
      stats.landmarks = [];

      // Sky and ground.
      const sky = ctx.createLinearGradient(0, 0, 0, HZ);
      sky.addColorStop(0, "#9cc3e6"); sky.addColorStop(1, "#dfe9f1");
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, HZ + 1);
      ctx.fillStyle = "#aaa79d"; ctx.fillRect(0, HZ, W, H - HZ);

      // Roads: quads on the ground, batched.
      ctx.beginPath();
      const r0x = Math.floor((cam.x - FAR_ROADS) / CELL), r1x = Math.floor((cam.x + FAR_ROADS) / CELL);
      const r0y = Math.floor((cam.y - FAR_ROADS) / CELL), r1y = Math.floor((cam.y + FAR_ROADS) / CELL);
      ctx.fillStyle = "#575b61";
      for (let cy = r0y; cy <= r1y; cy++) for (let cx = r0x; cx <= r1x; cx++) {
        for (const s of roadGrid.get(key(cx, cy)) || []) {
          const a = toCam(s.x0, s.y0, 0), b = toCam(s.x1, s.y1, 0);
          if (a[0] < NEAR && b[0] < NEAR) continue;
          if (Math.min(Math.hypot(a[0], a[1]), Math.hypot(b[0], b[1])) > FAR_ROADS) continue;
          const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) || 1, nx = -(s.y1 - s.y0) / len * s.w / 2, ny = (s.x1 - s.x0) / len * s.w / 2;
          const q = [toCam(s.x0 + nx, s.y0 + ny, 0), toCam(s.x1 + nx, s.y1 + ny, 0), toCam(s.x1 - nx, s.y1 - ny, 0), toCam(s.x0 - nx, s.y0 - ny, 0)];
          if (trace(q)) { ctx.fill(); stats.roads++; }
        }
      }

      // Buildings and vehicles, far to near.
      const items = [];
      if (buildings) {
        // Nearby buildings from the grid, plus the skyline: towers over 60 m out to 1.5 km.
        const near = buildings.query(cam.x - FAR_BUILDINGS, cam.y - FAR_BUILDINGS, cam.x + FAR_BUILDINGS, cam.y + FAR_BUILDINGS);
        for (const b of near) b.povNear = frame;
        frame++;
        for (const b of tall) if (b.povNear !== frame - 1) near.push(b);
        for (const b of near) {
          const c = toCam(b.cx, b.cy, 0), d = Math.hypot(c[0], c[1]);
          if (d - b.r > (b.h > 60 ? FAR_TALL : FAR_BUILDINGS) || c[0] + b.r < NEAR) continue;
          // Outside the field of view (with the footprint's radius as margin)?
          if (Math.abs(c[1]) - b.r > (c[0] + b.r) * Math.tan(FOV / 2) + 5) continue;
          // Small low buildings far away add nothing.
          if (d > 250 && b.h < 10 && b.r < 12) continue;
          items.push({ d, b });
        }
      }
      for (const v of vehicles) {
        const c = toCam(v.x, v.y, 0), d = Math.hypot(c[0], c[1]);
        if (d > 160 || c[0] < NEAR - 4) continue;
        items.push({ d, v });
      }
      items.sort((p, q) => q.d - p.d);
      for (const it of items) {
        if (it.v) { drawVehicle(it.v, toCam, trace); stats.vehicles++; continue; }
        for (const part of MB.partsOf(it.b)) drawPart(part, it.d, toCam, trace, ctx);
        stats.buildings++;
        if (it.b.landmark) stats.landmarks.push(it.b.name);
      }
      stats.ms = (root.performance || Date).now() - t0;
      return stats;
    }

    // One extruded part: visible walls (facing the camera) far to near, then the roof.
    function drawPart(part, dist, toCam, trace, ctx) {
      const p = part.poly, n = p.length / 2, z0 = part.z0;
      const top = (i) => (Array.isArray(part.z1) ? part.z1[i] : part.z1);
      const walls = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
        // Outward normal of a counter-clockwise ring in x-east, y-south coordinates.
        const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey) || 1, nx = ey / len, ny = -ex / len;
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        if ((mx - camRef.x) * nx + (my - camRef.y) * ny >= 0) continue;   // faces away from the camera
        walls.push({ i, j, d: Math.hypot(mx - camRef.x, my - camRef.y), light: 0.72 + 0.28 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1]) });
      }
      // A stadium bowl: field, then seating sloping up to the rim, then the outer walls in front.
      if (part.kind === "bowl") {
        const q = part.inner, m = q.length / 2;
        const field = [];
        for (let i = 0; i < m; i++) field.push(toCam(q[i * 2], q[i * 2 + 1], part.innerZ));
        if (trace(field)) { ctx.fillStyle = part.field; ctx.fill(); }
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m;
          if (!trace([toCam(p[i * 2], p[i * 2 + 1], top(i)), toCam(p[j * 2], p[j * 2 + 1], top(j)), toCam(q[j * 2], q[j * 2 + 1], part.innerZ), toCam(q[i * 2], q[i * 2 + 1], part.innerZ)])) continue;
          ctx.fillStyle = shade(part.seats, 0.85 + 0.15 * ((i % 2) ? 1 : 0)); ctx.fill();
        }
      }
      walls.sort((a, b) => b.d - a.d);
      const detail = dist < DETAIL;
      for (const w of walls) {
        const ax = p[w.i * 2], ay = p[w.i * 2 + 1], bx = p[w.j * 2], by = p[w.j * 2 + 1];
        if (!trace([toCam(ax, ay, z0), toCam(bx, by, z0), toCam(bx, by, top(w.j)), toCam(ax, ay, top(w.i))])) continue;
        ctx.fillStyle = shade(part.wall, w.light); ctx.fill();
        if (detail) { ctx.strokeStyle = "rgba(40,40,40,0.25)"; ctx.lineWidth = 1; ctx.stroke(); }
        stats.faces++;
      }
      if (part.kind === "bowl") return;
      // Roofs only show from above (a low roof seen from a bus, say).
      if (part.roof && camRef.z > Math.max(...(Array.isArray(part.z1) ? part.z1 : [part.z1]))) {
        const roof = [];
        for (let i = 0; i < n; i++) roof.push(toCam(p[i * 2], p[i * 2 + 1], top(i)));
        if (trace(roof)) { ctx.fillStyle = part.roof; ctx.fill(); stats.faces++; }
      }
    }

    function drawVehicle(v, toCam, trace) {
      const L = v.len || 4.8, Wd = v.width || 1.9, Hh = v.height || 1.6;
      const c = Math.cos(v.heading), s = Math.sin(v.heading);
      const corners = [[0, -Wd / 2], [0, Wd / 2], [-L, Wd / 2], [-L, -Wd / 2]].map(([a, b]) => [v.x + a * c - b * s, v.y + a * s + b * c]);
      const ctx = currentCtx;
      // Back, sides and top as one solid block (painter's order is good enough at this size).
      const top = corners.map(([x, y]) => toCam(x, y, Hh));
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        if (trace([toCam(...corners[i], 0), toCam(...corners[j], 0), toCam(...corners[j], Hh), toCam(...corners[i], Hh)])) { ctx.fillStyle = shade(v.color, 0.8); ctx.fill(); }
      }
      if (trace(top)) { ctx.fillStyle = v.color; ctx.fill(); }
    }

    // render() needs the camera inside drawPart/drawVehicle; keep a reference per frame.
    let camRef = { x: 0, y: 0, z: 0 }, currentCtx = null;
    function draw(ctx, w, h, cam, vehicles) {
      camRef = cam; currentCtx = ctx;
      return render(ctx, w, h, cam, vehicles);
    }
    return { draw, stats, FAR_BUILDINGS, FAR_ROADS };
  }

  const api = { createPov, FOV, NEAR };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsPov = api;
})(typeof window !== "undefined" ? window : globalThis);
