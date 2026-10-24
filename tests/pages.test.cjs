// Phone pages (src/pages.js) in the original grid app's mode: no panning map, so the whole maps
// page is the swipe area. Elements are stubbed; the simulation page and the street viewer cover
// the edge-strip and map-flick mode in page.test.cjs and viewer.test.cjs.
// Run: node tests/pages.test.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
global.innerWidth = 390;
const { createPages } = require(path.join(ROOT, "src/pages.js"));

function element(id, closestMatches = []) {
  const listeners = {};
  const set = new Set();
  return {
    id, style: {}, attrs: {}, inert: false,
    classList: {
      toggle(c, force) { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; },
      contains(c) { return set.has(c); },
    },
    closest: (sel) => closestMatches.find((m) => sel.split(", ").includes(m)) || null,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    fire(t, ev = {}) {
      const e = { ...ev, preventDefault() {}, stopPropagation() { e.stopped = true; } };
      (listeners[t] || []).forEach((fn) => fn(e));
      return e;
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    setPointerCapture() {},
  };
}

let phone = true;
const body = element("body"), controls = element("controls"), tab = element("pages-tab"), back = element("pages-back");
const changes = [];
const pages = createPages({ panel: controls, edge: body, tab, back, isPhone: () => phone, onChange: (o) => changes.push(o),
  edgeAccept: (e) => !(e.target.closest && e.target.closest(".map-nav, dialog, .help-tooltip, input[type=range], select")) });
const isOpen = () => controls.classList.contains("open");
let id = 0;
const swipe = (el, pts, target = el, end = "pointerup") => {
  const pointerId = ++id;
  const at = ([x, y, t]) => ({ clientX: x, clientY: y, timeStamp: t, pointerId, target });
  el.fire("pointerdown", at(pts[0]));
  for (const p of pts.slice(1)) el.fire("pointermove", at(p));
  el.fire(end, { type: end, ...at(pts[pts.length - 1]) });
};
const left = (t0) => [[330, 500, t0], [320, 501, t0 + 20], [250, 503, t0 + 60], [120, 505, t0 + 120]];
const right = (t0) => [[80, 400, t0], [95, 401, t0 + 20], [180, 402, t0 + 60], [320, 403, t0 + 120]];

assert.ok(!isOpen() && controls.inert && back.attrs["aria-expanded"] === "false", "controls start off-screen and inert");
swipe(body, left(0), element("map-canvas"));
assert.ok(isOpen() && !controls.inert && controls.style.transform === "", "a swipe left anywhere on the maps opens the controls");
// The swipe's own click (on a map canvas or a button) is swallowed so it does not spectate a car.
assert.ok(body.fire("click").stopped, "the click that ends a swipe is swallowed");
assert.deepStrictEqual(changes, [false, true]);
swipe(controls, [[200, 700, 1000], [205, 640, 1020], [208, 500, 1060]], controls, "pointercancel");
assert.ok(isOpen(), "a vertical scroll of the controls keeps them open");
swipe(controls, right(2000), element("speed", ["input[type=range]"]));
assert.ok(isOpen(), "dragging the speed slider is not a swipe");
swipe(controls, right(3000));
assert.ok(!isOpen() && controls.inert, "a swipe right returns to the maps");
swipe(body, left(4000), element("nav", [".map-nav"]));
assert.ok(!isOpen(), "sideways scrolling of the map shortcuts is not a swipe");
swipe(body, [[200, 300, 5000], [205, 360, 5020], [210, 600, 5080]], body, "pointercancel");
assert.ok(!isOpen(), "scrolling the maps page is not a swipe");
swipe(body, [[330, 500, 6000], [320, 500, 6200], [290, 500, 6500], [270, 500, 6800]]);
assert.ok(!isOpen(), "a short, slow pull settles back to the maps");
tab.fire("click");
assert.ok(isOpen(), "the Controls tab opens them");
back.fire("click");
assert.ok(!isOpen(), "the Maps button closes them");
phone = false;
swipe(body, left(7000));
assert.ok(!isOpen(), "wide screens ignore swipes");
pages.setOpen(false);
assert.ok(!controls.inert, "the side panel stays reachable on wide screens");

// The original grid app loads the module after its own script and wires it to its sidebar.
const html = fs.readFileSync(path.join(ROOT, "source/index.html"), "utf8");
assert.ok(html.indexOf('<script src="../src/pages.js"></script>') > html.indexOf("setInterval(tick, BASE_TICK_MS);"), "loaded after the app");
for (const idRef of ["pages-tab", "pages-back"]) assert.match(html, new RegExp(`id="${idRef}"`));
assert.match(html, /panel: document\.getElementById\("controls"\), edge: document\.body/);
console.log("PASS: original grid app phone pages — swipe left anywhere on the maps, swipe right back, sliders, shortcut bar and " +
  "scrolling left alone, tab and back button, wide screens unaffected.");
