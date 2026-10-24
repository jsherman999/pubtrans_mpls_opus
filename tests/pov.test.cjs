// Buildings (src/buildings.js on data/mpls_buildings.js) and the Driver POV (src/pov.js):
// decoding, the spatial index, landmark designs, and POV rendering downtown — what is drawn,
// what is culled, and how long a frame takes. Run: node tests/pov.test.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const G = require(path.join(ROOT, "src/graph.js"));
global.MplsBuildings = require(path.join(ROOT, "src/buildings.js"));
const P = require(path.join(ROOT, "src/pov.js"));
const MB = global.MplsBuildings;
const load = (file, key) => { const sb = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sb); return sb.window[key]; };
const raw = load("data/mpls_buildings.js", "MPLS_BUILDINGS");
const report = JSON.parse(fs.readFileSync(path.join(ROOT, "data/mpls_buildings.report.json"), "utf8"));
const graph = G.decodeMplsGraph(load("data/mpls_graph.js", "MPLS_GRAPH"));

// ------------------------------------------------------------ decoding and index
const B = MB.decodeBuildings(raw);
{
  assert.strictEqual(B.list.length, report.buildings);
  assert.ok(B.list.length > 10000, "the study area's buildings");
  assert.strictEqual(B.list.reduce((s, b) => s + b.n, 0), report.points);
  for (const b of B.list) {
    assert.ok(b.n >= 3 && b.h > 0 && b.mh < b.h);
    assert.ok(b.cx >= -100 && b.cx <= graph.width + 100 && b.cy >= -100 && b.cy <= graph.height + 100, "inside the box");
  }
  // Query matches a brute-force bounding-box search.
  for (const [x0, y0, x1, y1] of [[1000, 1500, 1400, 1900], [4000, 2000, 4600, 2600], [0, 0, 200, 200]]) {
    const brute = B.list.filter((b) => b.bbox[2] >= x0 && b.bbox[0] <= x1 && b.bbox[3] >= y0 && b.bbox[1] <= y1);
    assert.deepStrictEqual(B.query(x0, y0, x1, y1).map((b) => b.i).sort((a, b) => a - b), brute.map((b) => b.i));
  }
  const tallest = B.list.reduce((a, b) => (b.h > a.h ? b : a));
  assert.strictEqual(tallest.name, "IDS Tower");
  assert.strictEqual(tallest.h, 241);
  const bad = JSON.parse(JSON.stringify(raw)); bad.pts.pop();
  assert.throws(() => MB.decodeBuildings(bad));
  console.log(`PASS: ${B.list.length.toLocaleString()} buildings decoded (${report.height_sources.levels + report.height_sources["height tag"]} with OSM heights or levels), ` +
    `grid query = brute force, tallest IDS Tower 241 m.`);
}

// ------------------------------------------------------------ landmark designs
{
  for (const name of MB.LANDMARKS) {
    const b = (B.byName.get(name) || [])[0];
    assert.ok(b, `${name} is in the data`);
    const parts = MB.partsOf(b);
    assert.ok(b.landmark && parts.length >= 1);
    for (const part of parts) {
      assert.ok(part.poly.length >= 6 && part.poly.every(Number.isFinite));
      const tops = Array.isArray(part.z1) ? part.z1 : [part.z1];
      assert.ok(tops.every((z) => z > part.z0), `${name}: tops above bases`);
    }
  }
  const usb = MB.partsOf(B.byName.get("US Bank Stadium")[0])[0];
  assert.ok(Math.max(...usb.z1) === 83 && Math.min(...usb.z1) < 50, "U.S. Bank Stadium roof slopes from its 83 m prow");
  const northrop = MB.partsOf(B.byName.get("Northrop Memorial Auditorium")[0]);
  assert.strictEqual(northrop.filter((p) => p.wall === "#e2dccf").length, 10, "Northrop's ten columns");
  const coffman = MB.partsOf(B.byName.get("Coffman Memorial Union")[0]);
  assert.ok(coffman[1].z1 > coffman[0].z1, "Coffman's tower rises above the union");
  const bowl = MB.partsOf(B.byName.get("Huntington Bank Stadium")[0])[0];
  assert.strictEqual(bowl.kind, "bowl");
  assert.ok(bowl.inner.length === bowl.poly.length);
  // An ordinary building is one extrusion coloured by its kind.
  const house = B.list.find((b) => b.kind === "house");
  assert.deepStrictEqual(MB.partsOf(house).map((p) => [p.z0, p.z1, p.wall]), [[house.mh, house.h, MB.WALL.house]]);
  console.log("PASS: six landmark designs — sloped U.S. Bank Stadium, glass IDS Tower, green-roofed Target Center, Northrop's portico, Coffman's tower, Huntington's bowl.");
}

// ------------------------------------------------------------ POV downtown
{
  const calls = { fill: 0, stroke: 0, lineTo: 0 };
  const ctx = new Proxy({}, {
    get(t, p) { if (p in t) return t[p]; if (p === "createLinearGradient") return () => ({ addColorStop() {} }); if (p in calls) return () => { calls[p]++; }; return () => {}; },
    set(t, p, v) { t[p] = v; return true; },
  });
  const pov = P.createPov({ graph, buildings: B });
  const ids = B.byName.get("IDS Tower")[0];
  // Cameras on Nicollet Mall 250–600 m from the IDS Tower, looking at it.
  const mall = graph.links.filter((l) => l.name === "Nicollet Mall");
  const cams = [];
  for (const l of mall) {
    const [x, y] = G.pointAlong(l, l.len / 2), d = Math.hypot(x - ids.cx, y - ids.cy);
    if (d > 250 && d < 600) cams.push({ x, y, z: 2.0, heading: Math.atan2(ids.cy - y, ids.cx - x) });
  }
  assert.ok(cams.length >= 3);
  const times = [];
  for (const cam of cams) {
    const s = pov.draw(ctx, 520, 325, cam, []);
    assert.ok(s.landmarks.includes("IDS Tower"), "the IDS Tower is in view up Nicollet Mall");
    assert.ok(s.buildings > 15 && s.faces > 40 && s.roads > 20, `a street scene (${JSON.stringify(s)})`);
    // Turned around, the tower is behind and not drawn.
    const back = pov.draw(ctx, 520, 325, { ...cam, heading: cam.heading + Math.PI }, []);
    assert.ok(!back.landmarks.includes("IDS Tower"), "nothing behind the camera is drawn");
    for (let k = 0; k < 30; k++) { const t0 = process.hrtime.bigint(); pov.draw(ctx, 520, 325, cam, []); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  }
  times.sort((a, b) => a - b);
  const med = times[times.length >> 1], p95 = times[Math.floor(times.length * 0.95)];
  // Culling: nothing behind, no building beyond 450 m except towers out to 1.5 km.
  const far = pov.draw(ctx, 520, 325, { x: graph.width / 2, y: graph.height / 2, z: 1.5, heading: 0 }, []);
  assert.ok(far.buildings < 400 && far.faces < 2500, `bounded work (${far.buildings} buildings, ${far.faces} faces)`);
  // Another vehicle 20 m ahead is drawn; one 300 m away is not.
  const cam = cams[0];
  const ahead = { x: cam.x + Math.cos(cam.heading) * 20, y: cam.y + Math.sin(cam.heading) * 20, heading: cam.heading, color: "#ea580c" };
  const distant = { ...ahead, x: cam.x + Math.cos(cam.heading) * 300, y: cam.y + Math.sin(cam.heading) * 300 };
  assert.strictEqual(pov.draw(ctx, 520, 325, cam, [ahead, distant]).vehicles, 1);
  assert.ok(med < 2 && p95 < 4, `POV geometry ${med.toFixed(2)} ms median, ${p95.toFixed(2)} ms p95`);
  console.log(`PASS: POV up Nicollet Mall toward the IDS Tower: ${cams.length} cameras, about ${far.buildings} buildings and ${far.faces} faces at most; ` +
    `nothing behind the camera or beyond 450 m (towers 1.5 km) drawn; ${med.toFixed(2)} ms median (p95 ${p95.toFixed(2)}) of geometry per frame in Node.`);
}
