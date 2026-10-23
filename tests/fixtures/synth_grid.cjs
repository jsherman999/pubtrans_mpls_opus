// Synthetic street grid in data/mpls_graph.js format (docs/DATA_FORMAT.md), sized like the real
// study area (about 6 km x 4 km, ~7,000 nodes), for routing correctness checks and benchmarks.
// Not real streets. Seeded, so every run builds the same network.
"use strict";

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSynthGrid({ cols = 100, rows = 70, spacing = 60, seed = 7, dropRate = 0.03 } = {}) {
  const rnd = mulberry32(seed);
  const U = 10;
  const id = (c, r) => r * cols + c;
  const nodes = { x: [], y: [], flags: [], ctl: [] };
  const axis = [];
  const isArterial = (i) => i % 10 === 5;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      nodes.x.push(Math.round((c + 0.5) * spacing * U));
      nodes.y.push(Math.round((r + 0.5) * spacing * U));
      const signal = (isArterial(r) && c % 3 === 0) || (isArterial(c) && r % 3 === 0);
      const portal = c === 0 || r === 0 || c === cols - 1 || r === rows - 1;
      nodes.flags.push((portal ? 1 : 0) | (signal && !portal ? 2 : 0));
      if (signal && !portal) { nodes.ctl.push(axis.length); axis.push(0); } else nodes.ctl.push(-1);
    }
  const L = { a: [], b: [], dir: [], kph: [], lf: [], lb: [], cls: [], flags: [], name: [],
    sigA: [], sigB: [], len: [], way: [], shp: [] };
  const add = (a, b, dir, kph, horizontal) => {
    if (rnd() < dropRate) return;
    const sig = (v) => (nodes.flags[v] & 2 ? (horizontal ? 0 : 1) : -1);
    const stopFlags = !(nodes.flags[b] & 2) && !(nodes.flags[a] & 2) && rnd() < 0.15 ? 8 : 0;
    L.a.push(a); L.b.push(b); L.dir.push(dir); L.kph.push(kph);
    L.lf.push(dir & 1 ? 1 : 0); L.lb.push(dir & 2 ? 1 : 0);
    L.cls.push(kph > 45 ? 4 : 11); L.flags.push(stopFlags); L.name.push(0);
    L.sigA.push(sig(a)); L.sigB.push(sig(b));
    L.len.push(spacing * U); L.way.push(L.a.length); L.shp.push(0);
  };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c + 1 < cols; c++) {
      // Rows alternate one-way east / one-way west in pairs, like downtown's one-way grid;
      // arterial rows are two-way. One row in 13 is a shuttle-only transit mall.
      const kph = isArterial(r) ? 56 : 40;
      let dir = isArterial(r) ? 3 : (r % 4 < 2 ? 1 : 2);
      if (r % 13 === 6) dir = 12;
      add(id(c, r), id(c + 1, r), dir, kph, true);
    }
  for (let c = 0; c < cols; c++)
    for (let r = 0; r + 1 < rows; r++)
      add(id(c, r), id(c, r + 1), 3, isArterial(c) ? 56 : 40, false);
  return {
    v: 1, label: "Synthetic grid", attribution: "Synthetic test data (not real streets)",
    bbox: [0, 0, 0, 0], size: [cols * spacing * U, rows * spacing * U], unitsPerMeter: U,
    classes: ["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
      "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential",
      "living_street", "service", "busway"],
    names: [""], nodes, controllers: { axis }, links: L, shapes: [],
  };
}

module.exports = { makeSynthGrid, mulberry32 };
