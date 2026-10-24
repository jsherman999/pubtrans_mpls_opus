// Publishing checks (Phase 9): what GitHub Pages serves. Every script, stylesheet and image a
// page references exists and is relative (so the site works from a project subpath and from
// file://) and nothing loads from another host; each page has a title and a phone viewport;
// the OpenStreetMap and Census credits are shown; local links in the docs resolve; data and
// screenshots stay inside their size budgets; raw downloads are not committed.
// Run: node tests/publish.test.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const KB = 1024;

// ------------------------------------------------------------ pages
const PAGES = ["index.html", "viewer.html", "source/index.html"];
{
  let refs = 0;
  for (const page of PAGES) {
    const html = read(page), dir = path.dirname(page);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/, `${page}: phone viewport`);
    assert.match(html, /<title>[^<]+<\/title>/, `${page}: title`);
    // Static references plus scripts the page adds later (the buildings, loaded after start).
    const found = [...html.matchAll(/\b(?:src|href)="([^"#]+)"/g)].map((m) => m[1])
      .concat([...html.matchAll(/\.src = "([^"]+)"/g)].map((m) => m[1]));
    for (const url of found) {
      if (/^https?:\/\//.test(url)) {
        // Outside links are allowed only as anchors (credits, sources), never as resources.
        assert.ok(!new RegExp(`<(?:script|link|img)[^>]+(?:src|href)="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(html), `${page}: no resources from other hosts (${url})`);
        continue;
      }
      if (/^(mailto:|data:|javascript:)/.test(url)) continue;
      assert.ok(!url.startsWith("/"), `${page}: relative path, not ${url}`);
      assert.ok(exists(path.join(dir, url)), `${page}: ${url} exists`);
      refs++;
    }
  }
  assert.ok(exists(".nojekyll"), ".nojekyll keeps Pages from running Jekyll");
  assert.ok(refs >= 15, `references checked (${refs})`);
  // Credits on the pages that show the data.
  const sim = read("index.html"), viewer = read("viewer.html");
  for (const [name, html] of [["index.html", sim], ["viewer.html", viewer]])
    assert.match(html, /© <a href="https:\/\/www\.openstreetmap\.org\/copyright"[^>]*>OpenStreetMap<\/a> contributors/, `${name}: OpenStreetMap credit`);
  assert.match(sim, /Census data: U\.S\. Census Bureau/, "index.html: Census credit");
  console.log(`PASS: ${PAGES.length} pages — titles, phone viewports, ${refs} local references all present and relative, nothing loaded ` +
    `from another host, .nojekyll, OpenStreetMap and Census credits.`);
}

// ------------------------------------------------------------ docs
{
  const DOCS = ["README.md", "ARCHITECTURE.md", "PLAN.md", "docs/DATA_FORMAT.md", "docs/SOURCE_ARCHITECTURE.md", "docs/SOURCE_README.md"];
  let links = 0;
  for (const doc of DOCS) {
    const md = read(doc), dir = path.dirname(doc);
    const targets = [...md.matchAll(/\]\(([^)\s]+)\)/g), ...md.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
    for (const t of targets) {
      if (/^(https?:|mailto:|#)/.test(t)) continue;
      const file = t.split("#")[0];
      assert.ok(exists(path.join(dir, file)), `${doc}: link to ${t} resolves`);
      links++;
    }
  }
  const readme = read("README.md");
  for (const credit of ["OpenStreetMap", "Open Database License", "2020 Census", "LODES"]) assert.ok(readme.includes(credit), `README credits ${credit}`);
  for (const img of ["docs/img/sim.jpg", "docs/img/pov.jpg", "docs/img/viewer.jpg", "docs/img/phone.jpg"]) assert.ok(readme.includes(img), `README shows ${img}`);
  console.log(`PASS: ${links} local links in ${DOCS.length} documents resolve; README carries the screenshots and data credits.`);
}

// ------------------------------------------------------------ size budgets
{
  const BUDGET = {
    "data/mpls_graph.js": 1024 * KB,       // PLAN.md performance budget
    "data/mpls_demand.js": 512 * KB,
    "data/mpls_buildings.js": 1024 * KB,   // loaded after the page starts
  };
  const sizes = {};
  for (const [file, max] of Object.entries(BUDGET)) {
    sizes[file] = fs.statSync(path.join(ROOT, file)).size;
    assert.ok(sizes[file] <= max, `${file}: ${Math.round(sizes[file] / KB)} KB within ${max / KB} KB`);
  }
  // Everything the simulation page loads before it starts.
  const first = ["data/mpls_graph.js", "data/mpls_demand.js", ...[...read("index.html").matchAll(/<script src="(src\/[^"]+)"/g)].map((m) => m[1])]
    .reduce((s, f) => s + fs.statSync(path.join(ROOT, f)).size, 0);
  assert.ok(first <= 1200 * KB, `first load ${Math.round(first / KB)} KB`);
  const imgs = fs.readdirSync(path.join(ROOT, "docs/img"));
  for (const f of imgs) {
    const size = fs.statSync(path.join(ROOT, "docs/img", f)).size;
    assert.ok(/\.(jpg|png|svg)$/.test(f) && size <= 300 * KB, `docs/img/${f}: ${Math.round(size / KB)} KB`);
  }
  console.log(`PASS: data within budget (streets ${Math.round(sizes["data/mpls_graph.js"] / KB)} KB, demand ${Math.round(sizes["data/mpls_demand.js"] / KB)} KB, ` +
    `buildings ${Math.round(sizes["data/mpls_buildings.js"] / KB)} KB); ${Math.round(first / KB)} KB before the page starts; ${imgs.length} screenshots ≤ 300 KB each.`);
}

// ------------------------------------------------------------ what is committed
{
  let tracked = null;
  try { tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n"); } catch { /* not a git checkout */ }
  if (tracked) {
    assert.ok(!tracked.some((f) => f.startsWith("data/raw/")), "raw downloads are not committed");
    assert.ok(!tracked.some((f) => /(^|\/)(__pycache__|node_modules)\/|\.pyc$|\.DS_Store$/.test(f)), "no caches committed");
    console.log(`PASS: ${tracked.filter(Boolean).length} tracked files, no raw downloads or caches.`);
  } else console.log("SKIP: not a git checkout.");
}
