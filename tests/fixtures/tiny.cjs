// Small hand-built networks in data/mpls_graph.js format for motion and congestion tests.
"use strict";
const path = require("path");
const G = require(path.join(__dirname, "../../src/graph.js"));

// Small hand-built network in data/mpls_graph.js format. nodes: [x, y, flags?, ctl?] in meters;
// links: { a, b, dir = 1, kph = 36, lf = 1, lb = 0, flags = 0, sigA = -1, sigB = -1 }.
function tiny(nodes, links, controllers = 0, classes = ["residential"]) {
  const U = 10;
  const raw = {
    v: 1, label: "tiny", attribution: "test", bbox: [0, 0, 0, 0], size: [5000 * U, 5000 * U], unitsPerMeter: U,
    classes, names: [""],
    nodes: { x: nodes.map((n) => n[0] * U), y: nodes.map((n) => n[1] * U), flags: nodes.map((n) => n[2] || 0), ctl: nodes.map((n) => n[3] ?? -1) },
    controllers: { axis: Array(controllers).fill(0) },
    links: { a: [], b: [], dir: [], kph: [], lf: [], lb: [], cls: [], flags: [], name: [], sigA: [], sigB: [], len: [], way: [], shp: [] },
    shapes: [],
  };
  for (const l of links) {
    const L = raw.links;
    L.a.push(l.a); L.b.push(l.b); L.dir.push(l.dir ?? 1); L.kph.push(l.kph ?? 36);
    L.lf.push(l.lf ?? 1); L.lb.push(l.lb ?? 0); L.cls.push(l.cls ?? 0); L.flags.push(l.flags ?? 0); L.name.push(0);
    L.sigA.push(l.sigA ?? -1); L.sigB.push(l.sigB ?? -1); L.len.push(0); L.way.push(1); L.shp.push(0);
  }
  return G.decodeMplsGraph(raw);
}

module.exports = { tiny };
