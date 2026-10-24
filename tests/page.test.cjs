// Headless smoke test of the simulation page (index.html) on the real street network: DOM and
// Canvas are stubbed, timers are driven by hand. Checks the whole area fits a phone at load,
// frames at 20× advance the simulation and draw hundreds of vehicles, tapping picks a vehicle
// and a place, and the playback, fleet, demand and emergency controls work.
// Run: node tests/page.test.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function element(id) {
  const listeners = {};
  return {
    id, textContent: "", innerHTML: "", hidden: false, href: "", value: "", style: { setProperty() {} },
    children: [], dataset: {}, attrs: {}, offsetWidth: 0, clientWidth: 0, clientHeight: 0,
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
      contains(c) { return this.set.has(c); },
      toggle(c) { if (this.set.has(c)) { this.set.delete(c); return false; } this.set.add(c); return true; },
    },
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    fire(t, ev = {}) { (listeners[t] || []).forEach((fn) => fn({ preventDefault() {}, ...ev })); },
    setAttribute(k, v) { this.attrs[k] = v; },
    replaceChildren() { this.children = []; },
    append(...c) { this.children.push(...c); },
    insertBefore(c, ref) { const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    setPointerCapture() {},
  };
}

const html = read("index.html");
const inline = html.split("<script>")[1].split("</script>")[0];
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
assert.deepStrictEqual(scripts, ["data/mpls_graph.js", "data/mpls_demand.js", "src/graph.js", "src/routing.js", "src/traffic.js",
  "src/motion.js", "src/congestion.js", "src/demand.js", "src/metrics.js", "src/sim.js", "src/mapview.js", "src/buildings.js", "src/pov.js"],
  "page loads the data and engine modules in order");

// Boot the page headless. Without data/mpls_demand.js it runs the placeholder demand.
function boot({ withDemand }) {

const calls = { fill: 0, stroke: 0, arc: 0, fillText: 0 };
const ctx = new Proxy({}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (prop === "measureText") return (t) => ({ width: String(t).length * 7 });
    if (prop === "createLinearGradient") return () => ({ addColorStop() {} });
    if (prop in calls) return () => { calls[prop]++; };
    return () => {};
  },
  set(target, prop, value) { target[prop] = value; return true; },
});
const els = {};
const getEl = (id) => (els[id] = els[id] || element(id));
const canvas = getEl("map");
Object.assign(canvas, { clientWidth: 390, clientHeight: 780, width: 300, height: 150, getContext: () => ctx });
for (const id of ["chartWait", "chartQueued", "chartPlan", "povCanvas"]) Object.assign(getEl(id), { clientWidth: 300, clientHeight: 56, getContext: () => ctx });
const steppers = [];
for (const [step, by] of [["population", -250], ["population", 250], ["sedan", -5], ["sedan", 5], ["shuttle", -5], ["shuttle", 5], ["bus", -2], ["bus", 2]]) {
  const b = element(""); b.dataset = { step, by: String(by) }; steppers.push(b);
}
const timers = [], rafs = [], errors = [];
let now = 0;
const sandbox = {
  console: { log() {}, error: (e) => errors.push(e), warn() {} },
  performance: { now: () => now },
  requestAnimationFrame: (fn) => rafs.push(fn),
  setTimeout: (fn, ms) => timers.push(fn),
  getComputedStyle: () => ({ getPropertyValue: () => " #123456" }),
  matchMedia: (q) => ({ matches: q.includes("max-width: 760px"), addEventListener() {} }),   // phone layout
  devicePixelRatio: 3,
  addEventListener() {},
  location: { search: "", href: "index.html" },
  URLSearchParams,
  document: {
    documentElement: { style: { setProperty() {} } },
    title: "",
    getElementById: getEl,
    createElement: () => element(""),
    // Scripts added at run time (the building footprints) load straight away.
    head: { appendChild(sc) { vm.runInContext(read(sc.src), sandbox, { filename: sc.src }); if (sc.onload) sc.onload(); } },
    querySelectorAll: (sel) => (sel === "[data-step]" ? steppers : []),
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const s of scripts) if (withDemand || s !== "data/mpls_demand.js") vm.runInContext(read(s), sandbox, { filename: s });
vm.runInContext(inline, sandbox, { filename: "index.html" });
assert.deepStrictEqual(errors, []);
const page = sandbox.mplsSim;
assert.ok(page, "page started");
const frame = () => { now += 100; const t = timers.splice(0); t.forEach((fn) => fn()); rafs.splice(0).forEach((fn) => fn()); };   // one animation frame
return { page, els, steppers, frame, errors, calls, sandbox };
}

// ============================================================ placeholder demand (no Census file)
{
const { page, els, steppers, frame, errors, calls } = boot({ withDemand: false });
const { sim, map } = page;
const { view, graph } = map;

// The whole study area fits a phone screen at load, clear of the title card and the sheet.
assert.ok(view.ox >= 0 && view.ox + graph.width * view.scale <= 390 + 1e-6);
assert.ok(view.oy >= 64 - 1e-6 && view.oy + graph.height * view.scale <= 780 - 64 + 1e-6, "map fits between the title card and the bottom sheet");
assert.strictEqual(map.portalMarkerRadius(view.scale), 0, "portal markers hidden at whole-area zoom");

// 20× playback: each frame advances 20 steps (one simulated minute) and draws.
els.speed.fire("input", { target: { value: "20" } });
assert.strictEqual(page.speed, 20);
assert.strictEqual(els.speedVal.textContent, "20×");
const t0 = sim.state.t;
for (let i = 0; i < 40; i++) frame();
assert.strictEqual(sim.state.t - t0, 40 * 20 * 3, "40 frames at 20× = 40 simulated minutes");
assert.deepStrictEqual(errors, []);
const onRoad = sim.counts().onRoad;
assert.ok(onRoad >= 250, `vehicles on the road after 40 minutes (${onRoad})`);
assert.ok(calls.arc > onRoad, "vehicles drawn");
page.refresh();   // the HUD refreshes every 250 ms of wall time, not every frame
assert.strictEqual(els.clock.textContent, "08:10");
assert.match(els.status.textContent, /vehicles on the road/);
assert.ok(Number(els.hDone.textContent.replace(/,/g, "")) > 0, "completed rides shown");
assert.ok(els.log.children.length > 0, "event log filled");
assert.strictEqual(sim.audit().length, 0, sim.audit().slice(0, 3).join("; "));

// Chokepoint panel: eight river bridges, then ramps and entries; a row centres the map on it.
const groups = els.choke.children.filter((c) => c.textContent && !c.children.length);
assert.deepStrictEqual(groups.map((g) => g.textContent), ["River bridges", "Busiest freeway ramps", "Busiest entries at the map edge"]);
const rows = els.choke.children.filter((c) => c.children.length);
assert.strictEqual(rows.length, 8 + 4 + 4);
assert.match(rows[3].children[1].textContent, /^[\d,]+ cars\/h · \d+ % of capacity$/);
assert.match(rows[3].attrs["aria-label"], /I-35W Bridge/);
rows[3].fire("click");
const i35 = sim.congestion.bridges[3];
assert.ok(Math.abs((view.cssW / 2 - view.ox) / view.scale - i35.x) < 1e-6, "map centred on the I-35W bridge");
els.congestionLayer.fire("change", { target: { checked: false } });
els.congestionLayer.fire("change", { target: { checked: true } });
assert.match(els.hCongestion.textContent, /^\d+ · \d+$/);
frame();
map.fit();

// Tap a fleet vehicle on the road (paused, so it holds still): details open; Follow keeps it centred.
els.pause.fire("click");
map.zoomAt(12, 195, 390);
frame();
const others = sim.state.vehicles.filter((x) => x.lane >= 0 || !["idle", "private_parked"].includes(x.state)).map((x) => [x, sim.locate(x)]);
const v = sim.state.vehicles.find((x) => {
  if (x.kind !== "shuttle" || x.lane < 0) return false;
  const p = sim.locate(x);
  return others.every(([o, q]) => o === x || !q || Math.hypot(q.x - p.x, q.y - p.y) > 15);   // nobody else under the finger
});
map.centerOn(sim.locate(v).x, sim.locate(v).y, 3);
frame();
const p = sim.locate(v);
const [sx, sy] = map.toScreen(p.x, p.y);
els.map.fire("pointerdown", { pointerId: 1, offsetX: sx, offsetY: sy });
els.map.fire("pointerup", { pointerId: 1, offsetX: sx, offsetY: sy });
assert.strictEqual(page.selected, v, "tap picks the vehicle under the finger");
assert.ok(els.info.classList.contains("open"));
assert.match(els.infoTitle.textContent, /^Shuttle /);
assert.ok(els.infoList.children.some((c) => c.textContent === "Riders"));
els.follow.fire("click");
els.pause.fire("click");
for (let i = 0; i < 3; i++) frame();
const q = sim.locate(v);
assert.ok(Math.abs(q.x * view.scale + view.ox - 195) < 1 && Math.abs(q.y * view.scale + view.oy - 390) < 1, "followed vehicle stays centred");
// Tap a place (one with no vehicle beside it: vehicles win ties under the finger). Paused, and
// Follow off, so the view stays put.
els.follow.fire("click");
assert.strictEqual(els.follow.attrs["aria-pressed"], "false");
els.pause.fire("click");
const place = sim.state.places.find((pl) => sim.state.vehicles.every((x) => {
  const q = (x.lane >= 0 || !["idle", "private_parked"].includes(x.state)) && sim.locate(x);
  return !q || Math.hypot(q.x - pl.x, q.y - pl.y) > 15;
}));
map.centerOn(place.x, place.y, 2);
frame();
els.map.fire("pointerdown", { pointerId: 2, offsetX: 195, offsetY: 390 });
els.map.fire("pointerup", { pointerId: 2, offsetX: 195, offsetY: 390 });
assert.strictEqual(page.selected, place);
assert.strictEqual(els.infoTitle.textContent, place.name);
els.infoClose.fire("click");
assert.ok(!els.info.classList.contains("open"));
els.pause.fire("click");

// Controls.
els.pause.fire("click");
assert.ok(page.paused && els.pauseMap.textContent === "Resume", "map and panel pause buttons stay in step");
const held = sim.state.t;
frame(); frame();
assert.strictEqual(sim.state.t, held, "paused");
els.pauseMap.fire("click");
assert.ok(!page.paused);
frame();
assert.ok(sim.state.t > held);
const sedans = sim.countFleet("sedan");
steppers[3].fire("click");
assert.strictEqual(sim.countFleet("sedan"), sedans + 5);
assert.strictEqual(els.sSedan.textContent, String(sedans + 5));
steppers[6].fire("click");
assert.strictEqual(sim.countFleet("bus"), 8);
steppers[1].fire("click");
assert.strictEqual(sim.settings.population, 2750);
els.rideSharing.fire("input", { target: { value: "0" } });
assert.strictEqual(sim.settings.rideSharing, 0);
assert.match(els.sharingHint.textContent, /^Off/);
els.privateTraffic.fire("input", { target: { value: "2" } });
assert.strictEqual(sim.settings.privateTraffic, 2);
assert.match(els.privateHint.textContent, /^About 10,000 cars an hour cross the map edge off-peak and 29,000 at 08:00/);
els.emergency.fire("click");
assert.strictEqual(sim.state.incidents.length >= 1, true);
frame();
assert.notStrictEqual(els.hEmergency.textContent, "None");
els.sheetToggle.fire("click");
assert.ok(els.panel.classList.contains("open") && els.sheetToggle.attrs["aria-expanded"] === "true");
els.reset.fire("click");
assert.ok(sim.state.t === 0 && sim.state.completed === 0 && els.clock.textContent === "07:30");
assert.strictEqual(els.log.children.length, 1, "log restarts with the reset entry");
assert.strictEqual(els.log.children[0].children[2].textContent, "Day reset");
frame();
assert.deepStrictEqual(errors, []);
console.log(`PASS: page fits a phone at load, 20× frames advance a minute each and draw ${onRoad} vehicles, ` +
  "tap selects and follows a shuttle and shows a place, pause/speed/fleet/population/sharing/traffic/emergency/reset controls work.");
}

// ============================================================ Census demand (the page as shipped)
{
const { page, els, steppers, frame, errors, calls, sandbox } = boot({ withDemand: true });
const { sim, map } = page;
const K = sim.scale;
assert.ok(sim.demand && K === 10, `Census demand at 1:10 (demand ${!!sim.demand}, K ${K})`);
assert.strictEqual(els.demandBox.hidden, false);
assert.strictEqual(els.popStepper.hidden, true, "population comes from the Census, not a stepper");
assert.strictEqual(els.clock.textContent, "05:30");
assert.strictEqual(els.day.children.length, 7);
assert.strictEqual(els.day.value, "2", "Wednesday");
assert.strictEqual(els.event.value, "1", "Twins game tonight");
assert.match(els.dPeople.textContent, /^114,464 · 19\d,\d{3}$/);
assert.match(els.dTrips.textContent, /^\d+k · \d+k · \d+k$/);
els.speed.fire("input", { target: { value: "20" } });
for (let i = 0; i < 150; i++) frame();          // 05:30 to 08:00
page.refresh();
assert.strictEqual(els.clock.textContent, "08:00");
assert.deepStrictEqual(errors, []);
assert.strictEqual(sim.audit().length, 0);
// Counts on the panel are real people and vehicles.
assert.strictEqual(els.hDone.textContent, (sim.state.completed * K).toLocaleString());
assert.strictEqual(els.sShuttle.textContent, (sim.countFleet("shuttle") * K).toLocaleString());
const road = Number(els.hRoad.textContent.replace(/,/g, ""));
assert.ok(road > 5000, `rush-hour vehicles on the road (${road})`);
assert.match(els.status.textContent, /vehicles on the road · [\d,]+ waiting · [\d,]+ rides done/);
// Run metrics in real numbers.
assert.match(els.mVmt.textContent, /^[\d,]+ mi · [\d.]+ %$/);
assert.match(els.mWait.textContent, /^[\d.]+ · [\d.]+ min$/);
assert.ok(Number(els.mOcc.textContent) > 0.3);
// Car share lever: fewer cars kept means more shuttle trips planned.
const before = els.dTrips.textContent;
els.carShare.fire("input", { target: { value: "10" } });
assert.strictEqual(sim.settings.carShare, 0.1);
assert.notStrictEqual(els.dTrips.textContent, before);
assert.match(els.carShareHint.textContent, /^10 % of the trips made by car today are still driven/);
// Plan chart hover readout.
els.chartPlan.fire("pointermove", { offsetX: 8.5 * (300 / 24) });
assert.match(els.planTip.textContent, /^08:00–09:00 · [\d,]+ by shuttle · [\d,]+ by car · [\d,]+ on foot$/);
// Day and event restart the day; sampling reloads the page with ?sampling.
els.day.fire("change", { target: { value: "6" } });
assert.ok(sim.state.dayOfWeek === 6 && sim.state.t === 0 && els.clock.textContent === "05:30");
els.event.fire("change", { target: { value: "2" } });
assert.strictEqual(sim.settings.events[0].venue, "U.S. Bank Stadium");
const sunday = sim.state.plan;
assert.ok(sunday.day === "Sunday" && sunday.byPurpose.event > 120000, "Vikings game on Sunday");
els.sampling.fire("change", { target: { value: "5" } });
assert.match(sandbox.location.search, /^sampling=5$/, "sampling change reloads with ?sampling=5");
// Building footprints load after start and draw once zoomed in.
assert.ok(page.buildings && page.buildings.list.length > 10000, "buildings loaded");
const ids = page.buildings.byName.get("IDS Tower")[0];
map.centerOn(ids.cx, ids.cy, 1.5);
const fills = calls.fill;
frame();
assert.ok(calls.fill > fills + 4, "footprints drawn at street zoom");
map.fit();
// The vehicle panel says how many real vehicles an agent stands for.
for (let i = 0; i < 60; i++) frame();
const v = sim.state.vehicles.find((x) => x.kind === "shuttle" && x.lane >= 0);
page.select(v);
assert.ok(els.infoList.children.some((c) => c.textContent === "10 vehicles travelling together (1 : 10 sample)"));
// Ride along: the driver view opens and redraws every animation frame.
els.rideAlong.fire("click");
assert.ok(els.pov.classList.contains("open"));
assert.match(els.povTitle.textContent, /^Riding with shuttle \d+$/);
const before0 = page.povFrames;
for (let i = 0; i < 5; i++) frame();
assert.ok(page.povFrames >= before0 + 5, "driver view redrawn each frame");
assert.ok(page.pov.stats.roads > 0, "the street is drawn");
els.povClose.fire("click");
assert.ok(!els.pov.classList.contains("open"));
assert.deepStrictEqual(errors, []);
console.log(`PASS: Census demand on the page (1:10): 05:30 start, Wednesday with a Twins game, ${road.toLocaleString()} vehicles on the road at 08:00 in real numbers, ` +
  "car-share lever, plan chart readout, day/event/sampling controls, agent scale in the details panel, footprints, ride-along driver view.");
}
