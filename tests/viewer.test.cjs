// Decoder checks plus a headless smoke test of viewer.html (DOM and Canvas stubbed).
// Run: node tests/viewer.test.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const G = require(path.join(ROOT, "src/graph.js"));

// ---------------------------------------------------------------- decoder
function loadRaw(file) {
  const sandbox = { window: {} };
  vm.runInNewContext(read(file), sandbox);
  return sandbox.window.MPLS_GRAPH;
}
{
  const raw = loadRaw("data/sample_graph.js");
  const g = G.decodeMplsGraph(raw);
  assert.strictEqual(g.links.length, raw.links.a.length);
  for (const l of g.links) {
    const n = l.pts.length / 2;
    assert.strictEqual(l.pts[0], g.nodes.x[l.a]);
    assert.strictEqual(l.pts[(n - 1) * 2 + 1], g.nodes.y[l.b]);
    let geo = 0;
    for (let k = 0; k + 3 < l.pts.length; k += 2) geo += Math.hypot(l.pts[k + 2] - l.pts[k], l.pts[k + 3] - l.pts[k + 1]);
    assert.ok(Math.abs(geo - l.len) < 0.5, `length mismatch on link ${l.id}`);
    const end = G.pointAlong(l, l.len, true);
    assert.ok(Math.hypot(end[0] - g.nodes.x[l.b], end[1] - g.nodes.y[l.b]) < 1e-6);
    const start = G.pointAlong(l, l.len, false);
    assert.ok(Math.hypot(start[0] - g.nodes.x[l.a], start[1] - g.nodes.y[l.a]) < 1e-6);
  }
  // Arc counts follow the direction bits.
  let arcs = 0;
  for (const list of g.out) arcs += list.length;
  const expected = g.links.reduce((s, l) => s + (l.dir & 5 ? 1 : 0) + (l.dir & 10 ? 1 : 0), 0);
  assert.strictEqual(arcs, expected);
  // Shuttle-only arcs exist (transit mall and bus contraflow) and are flagged.
  assert.ok(g.out.flat().some((a) => a.psvOnly));
  // Stop and signal metadata travel with arcs.
  assert.strictEqual(g.inc.flat().filter((a) => a.stop).length, 1);
  assert.ok(g.inc.flat().some((a) => a.signal === 0) && g.inc.flat().some((a) => a.signal === 1));
  // Picking finds the nearest street.
  const idx = G.buildLinkIndex(g, 50);
  const mall = g.links.find((l) => l.name === "C Ave Mall");
  const [mx, my] = G.pointAlong(mall, mall.len / 2);
  assert.strictEqual(idx.nearest(mx + 3, my, 20), mall);
  assert.strictEqual(idx.nearest(-500, -500, 20), null);
  // Corrupt data is rejected.
  const bad = JSON.parse(JSON.stringify(raw));
  bad.shapes.pop();
  assert.throws(() => G.decodeMplsGraph(bad));
  assert.throws(() => G.decodeMplsGraph({ v: 99 }));
  console.log("PASS: decoder geometry, arcs, shuttle-only access, stops, signals, picking, corruption checks.");
}

// ---------------------------------------------------------------- viewer smoke test
function element(id) {
  const listeners = {};
  return {
    id, textContent: "", innerHTML: "", hidden: false, href: "", style: {}, children: [],
    attrs: {},
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
      contains(c) { return this.set.has(c); },
      toggle(c, force) { const on = force === undefined ? !this.set.has(c) : !!force; if (on) this.set.add(c); else this.set.delete(c); return on; },
    },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    fire(t, ev) { (listeners[t] || []).forEach((fn) => fn(ev)); },
    setAttribute(k, v) { this.attrs[k] = v; },
    replaceChildren() { this.children = []; },
    append(...c) { this.children.push(...c); },
    setPointerCapture() {},
  };
}

function runViewer({ withRealData }) {
  const html = read("viewer.html");
  const inline = html.split("<script>")[1].split("</script>")[0];
  const calls = { stroke: 0, fill: 0, fillText: 0 };
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "measureText") return (t) => ({ width: String(t).length * 7 });
      if (prop in calls) return () => { calls[prop]++; };
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  const els = {};
  const canvas = element("map");
  Object.assign(canvas, { clientWidth: 390, clientHeight: 780, width: 300, height: 150, getContext: () => ctx });
  els.map = canvas;
  const rafQueue = [];
  const errors = [];
  const sandbox = {
    console: { log() {}, error: (e) => errors.push(e) },
    Math, Map, Set, Promise, Error, JSON, Number, String, Array, Float64Array, Uint8Array, Int32Array, Uint32Array, Object,
    performance: { now: () => Date.now() },
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    getComputedStyle: () => ({ getPropertyValue: () => " #123456" }),
    matchMedia: (q) => ({ matches: q.includes("max-width: 760px"), addEventListener() {} }),   // phone layout
    devicePixelRatio: 3,
    innerWidth: 390,
    addEventListener() {},
    document: {
      documentElement: {},
      title: "",
      getElementById: (id) => (els[id] = els[id] || element(id)),
      createElement: () => element(""),
      head: {
        appendChild(s) {
          setTimeout(() => {
            if (s.src === "data/mpls_graph.js" && !withRealData) return s.onerror(new Error("404"));
            const file = s.src === "data/mpls_graph.js" ? "data/sample_graph.js" : s.src;
            vm.runInContext(read(file), sandbox);
            s.onload();
          }, 0);
        },
      },
    },
    setTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("src/graph.js"), sandbox);
  vm.runInContext(read("src/routing.js"), sandbox);
  vm.runInContext(read("src/mapview.js"), sandbox);
  vm.runInContext(read("src/pages.js"), sandbox);
  vm.runInContext(inline, sandbox);
  const flush = () => { while (rafQueue.length) rafQueue.shift()(); };
  return new Promise((resolve) => setTimeout(() => { flush(); resolve({ sandbox, els, calls, flush, errors }); }, 20));
}

(async () => {
  const { sandbox, els, calls, flush, errors } = await runViewer({ withRealData: false });
  assert.deepStrictEqual(errors, []);
  const v = sandbox.mplsViewer;
  assert.ok(v, "viewer started");
  assert.strictEqual(els.sampleNotice.hidden, false, "sample notice shown when real data is missing");
  assert.strictEqual(els.areaName.textContent, "Synthetic test network");
  // Whole area fits on a 390 x 780 phone screen at load.
  const { view, graph } = v;
  assert.ok(view.ox >= 0 && view.oy >= 0, "area starts inside the screen");
  assert.ok(view.ox + graph.width * view.scale <= 390 + 1e-6);
  assert.ok(view.oy + graph.height * view.scale <= 780 + 1e-6);
  assert.ok(calls.stroke > 0);
  // Portal markers: hidden when the whole real study area (6.1 km wide) fits a phone (~0.06 px/m)
  // or a desktop window (~0.2 px/m), small in between, full size up close.
  assert.strictEqual(v.portalMarkerRadius(0.06), 0);
  assert.strictEqual(v.portalMarkerRadius(0.2), 0);
  assert.ok(v.portalMarkerRadius(0.4) > 0 && v.portalMarkerRadius(0.4) < v.portalMarkerRadius(1.2));
  assert.strictEqual(v.portalMarkerRadius(5), 6);
  // Zoom to street level on a street: details and labels draw without errors.
  const first = graph.links.find((l) => l.name === "2nd St");
  const [fx, fy] = sandbox.MplsGraph.pointAlong(first, first.len / 2);
  v.zoomAt(8, fx * view.scale + view.ox, fy * view.scale + view.oy);
  flush();
  assert.ok(view.scale <= 24 && view.scale > 1.2, `street zoom reached (${view.scale})`);
  assert.ok(calls.fillText > 0, "street names drawn at street zoom");
  // Zoom limits.
  v.zoomAt(1e-6, 195, 390);
  assert.ok(view.scale >= view.fitScale * 0.5 - 1e-9);
  v.fit();
  flush();
  // Tap a street: pointer down/up at the transit mall midpoint selects it.
  const mall = graph.links.find((l) => l.name === "C Ave Mall");
  const [wx, wy] = sandbox.MplsGraph.pointAlong(mall, mall.len / 2);
  const sx = wx * view.scale + view.ox, sy = wy * view.scale + view.oy;
  els.map.fire("pointerdown", { pointerId: 1, offsetX: sx, offsetY: sy });
  els.map.fire("pointerup", { pointerId: 1, offsetX: sx, offsetY: sy });
  flush();
  assert.ok(els.inspect.classList.contains("open"));
  assert.strictEqual(els.inspectName.textContent, "C Ave Mall");
  const rows = els.inspectList.children.map((c) => c.textContent);
  assert.ok(rows.includes("Shuttles and buses only"));
  assert.ok(els.inspectOsm.href.startsWith("https://www.openstreetmap.org/way/"));
  // Drag pans and marks the view as user-moved.
  const before = view.ox;
  els.map.fire("pointerdown", { pointerId: 2, offsetX: 100, offsetY: 100 });
  els.map.fire("pointermove", { pointerId: 2, offsetX: 160, offsetY: 100 });
  els.map.fire("pointerup", { pointerId: 2, offsetX: 160, offsetY: 100 });
  assert.ok(Math.abs(view.ox - before - 60) < 1e-6 && view.userMoved);
  // A drag is not a tap: selection unchanged, panel still open.
  assert.ok(els.inspect.classList.contains("open"));
  // Fit button restores the full view.
  els.fit.fire("click");
  assert.strictEqual(view.userMoved, false);
  // Route preview: tap a start and an end on 3rd St (one-way west for cars, shuttle contraflow east).
  const tapAt = (x, y) => {
    els.map.fire("pointerdown", { pointerId: 3, offsetX: x * view.scale + view.ox, offsetY: y * view.scale + view.oy });
    els.map.fire("pointerup", { pointerId: 3, offsetX: x * view.scale + view.ox, offsetY: y * view.scale + view.oy });
    flush();
  };
  els.routeToggle.fire("click");
  assert.ok(v.trip.on && els.routePanel.classList.contains("open"));
  assert.ok(!els.inspect.classList.contains("open"), "route mode closes street details");
  assert.strictEqual(els.routeHint.textContent, "Tap where the trip starts.");
  tapAt(150, 450);
  assert.strictEqual(els.routeHint.textContent, "Tap where the trip ends.");
  tapAt(600, 450);
  assert.ok(v.trip.car && v.trip.shuttle, "both routes found");
  assert.ok(v.trip.shuttle.time < v.trip.car.time, "contraflow makes the shuttle faster");
  const lines = els.routeResults.children.map((li) => li.children[1].textContent);
  assert.ok(lines[0].startsWith("Private car: ") && lines[1].startsWith("Shuttle: "));
  assert.ok(els.routeHint.textContent.startsWith("The shuttle uses transit-only streets."));
  tapAt(300, 150);
  assert.ok(v.trip.to === -1 && !v.trip.car, "a third tap starts a new trip");
  els.routeToggle.fire("click");
  assert.ok(!v.trip.on && !els.routePanel.classList.contains("open"));
  // Phone pages: the title card is a full-screen page beside the map, opened by the tab, a swipe
  // left from the right edge or a flick of the map, and closed by its Map button or a swipe right.
  const isOpen = () => els.title.classList.contains("open");
  const swipe = (el, pts) => {
    const at = ([x, y, t]) => ({ clientX: x, clientY: y, offsetX: x, offsetY: y, timeStamp: t, pointerId: 9, target: el });
    el.fire("pointerdown", at(pts[0]));
    for (const p of pts.slice(1)) el.fire("pointermove", at(p));
    el.fire("pointerup", { type: "pointerup", ...at(pts[pts.length - 1]) });
  };
  assert.ok(!isOpen() && els.title.inert, "info page starts off-screen and out of the tab order");
  els.statsTab.fire("click");
  assert.ok(isOpen() && !els.title.inert && els.sheetToggle.attrs["aria-expanded"] === "true", "tab opens the info page");
  els.sheetToggle.fire("click");
  assert.ok(!isOpen(), "Map button closes it");
  swipe(els.swipeEdge, [[385, 400, 0], [370, 402, 30], [300, 405, 80], [240, 405, 130]]);
  assert.ok(isOpen(), "swipe left from the edge opens the info page");
  swipe(els.title, [[60, 300, 1000], [80, 301, 1030], [150, 305, 1080], [220, 305, 1130]]);
  assert.ok(!isOpen(), "swipe right shows the map");
  const ox = view.ox;
  swipe(els.map, [[300, 400, 2000], [250, 402, 2040], [180, 404, 2090]]);
  assert.ok(isOpen() && view.ox === ox, "a quick flick left on the map opens the info page and leaves the map where it was");
  els.sheetToggle.fire("click");
  swipe(els.map, [[300, 400, 3000], [280, 401, 3300], [200, 402, 3900]]);
  assert.ok(!isOpen() && view.ox !== ox, "a slow drag on the map pans it");
  assert.deepStrictEqual(errors, []);
  // Real data path: no sample notice.
  const real = await runViewer({ withRealData: true });
  assert.strictEqual(real.els.sampleNotice.hidden, true);
  console.log("PASS: viewer loads with fallback, fits a phone screen, zooms, labels, picks, pans, refits, previews routes and swipes to the info page.");
})().catch((e) => { console.error(e); process.exit(1); });
