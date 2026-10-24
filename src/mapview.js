// Zoomable street map on a canvas, shared by viewer.html and the simulation page. Draws the
// decoded street graph (src/graph.js) with level of detail, handles pan/zoom/pinch/keyboard and
// reports taps in world coordinates; pages add their own layers through `overlay`.
// Colours come from CSS custom properties on :root (--bg, --street, --arterial, --motorway,
// --psv, --signal, --portal, --casing, --select, --text, --halo, plus any listed in themeKeys).
(function (root) {
  "use strict";

  const CLASS_STYLE = {
    // width in meters at full zoom, minimum width in pixels, colour token, draw layer, min zoom (px per m)
    service:        { w: 4.5, min: 0.5, color: "street",   layer: 0, minZoom: 0.35 },
    living_street:  { w: 6,   min: 0.6, color: "street",   layer: 1, minZoom: 0 },
    residential:    { w: 7,   min: 0.7, color: "street",   layer: 1, minZoom: 0 },
    unclassified:   { w: 7,   min: 0.7, color: "street",   layer: 1, minZoom: 0 },
    tertiary_link:  { w: 6,   min: 0.8, color: "arterial", layer: 2, minZoom: 0 },
    tertiary:       { w: 9,   min: 0.9, color: "arterial", layer: 2, minZoom: 0 },
    secondary_link: { w: 6,   min: 0.9, color: "arterial", layer: 3, minZoom: 0 },
    secondary:      { w: 10,  min: 1.1, color: "arterial", layer: 3, minZoom: 0 },
    primary_link:   { w: 6,   min: 1.0, color: "arterial", layer: 4, minZoom: 0 },
    primary:        { w: 11,  min: 1.3, color: "arterial", layer: 4, minZoom: 0 },
    trunk_link:     { w: 6,   min: 1.0, color: "motorway", layer: 5, minZoom: 0 },
    trunk:          { w: 13,  min: 1.5, color: "motorway", layer: 5, minZoom: 0 },
    motorway_link:  { w: 6,   min: 1.0, color: "motorway", layer: 5, minZoom: 0 },
    motorway:       { w: 16,  min: 1.8, color: "motorway", layer: 6, minZoom: 0 },
    busway:         { w: 8,   min: 1.2, color: "psv",      layer: 7, minZoom: 0 },
  };
  const FRIENDLY_CLASS = {
    motorway: "Freeway", motorway_link: "Freeway ramp", trunk: "Expressway", trunk_link: "Expressway ramp",
    primary: "Primary arterial", primary_link: "Arterial ramp", secondary: "Secondary arterial",
    secondary_link: "Arterial ramp", tertiary: "Collector street", tertiary_link: "Collector ramp",
    unclassified: "Local street", residential: "Residential street", living_street: "Shared street",
    service: "Service road", busway: "Transitway",
  };
  const DETAIL_ZOOM = 1.2;   // px per meter: arrows, signals, stops
  const LABEL_ZOOM = 0.9;
  const MAX_ZOOM = 24;
  // Portal (off-map road) markers: hidden at whole-area zoom, where 200+ of them line the edge,
  // then grow to full size by DETAIL_ZOOM.
  const PORTAL_ZOOM = 0.25;
  function portalMarkerRadius(scale) {
    if (scale < PORTAL_ZOOM) return 0;
    return 2.5 + 3.5 * Math.min(1, (scale - PORTAL_ZOOM) / (DETAIL_ZOOM - PORTAL_ZOOM));
  }
  const BASE_THEME = ["bg", "street", "arterial", "motorway", "psv", "signal", "portal", "casing", "select", "text", "halo"];

  // options: canvas, graph, overlay(ctx, map) drawn after the streets, onTap(wx, wy) for a
  // click/tap that did not drag, onEscape(), themeKeys (extra CSS tokens), padding (px or
  // function returning { left, right, top, bottom } kept clear of panels when fitting).
  function createMapView(options) {
    const { canvas, graph } = options;
    const ctx = canvas.getContext("2d");
    const MG = root.MplsGraph;
    const theme = {};
    function readTheme() {
      const cs = getComputedStyle(document.documentElement);
      for (const k of BASE_THEME.concat(options.themeKeys || [])) theme[k] = cs.getPropertyValue("--" + k).trim();
    }
    readTheme();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readTheme(); requestDraw(); });

    // Links grouped by draw layer
    const layers = [];
    for (const l of graph.links) {
      const st = CLASS_STYLE[l.className] || CLASS_STYLE.residential;
      l.style = st;
      const layer = l.psvOnly ? 7 : st.layer;
      (layers[layer] = layers[layer] || []).push(l);
    }
    const bridges = graph.links.filter((l) => l.flags & MG.FLAG_BRIDGE);
    const portals = [], signalNodes = [];
    for (let i = 0; i < graph.nodes.count; i++) {
      if (graph.nodes.flags[i] & MG.NODE_PORTAL) portals.push(i);
      if (graph.nodes.flags[i] & MG.NODE_SIGNAL) signalNodes.push(i);
    }

    // ---------------------------------------------------------------- view transform
    const view = { scale: 1, ox: 0, oy: 0, fitScale: 1, userMoved: false, cssW: 0, cssH: 0, dpr: 1 };
    function insets() {
      const p = typeof options.padding === "function" ? options.padding() : null;
      return p || { left: 0, right: 0, top: 0, bottom: 0 };
    }
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w === view.cssW && h === view.cssH && canvas.width === Math.round(w * dpr)) return;
      const cx = (view.cssW / 2 - view.ox) / view.scale, cy = (view.cssH / 2 - view.oy) / view.scale;
      view.cssW = w; view.cssH = h; view.dpr = dpr;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      view.fitScale = fitScale();
      if (!view.userMoved) fit();
      else { view.ox = w / 2 - cx * view.scale; view.oy = h / 2 - cy * view.scale; }
      requestDraw();
    }
    function fitScale() {
      const { left, right, top, bottom } = insets();
      const w = view.cssW - left - right, h = view.cssH - top - bottom;
      const pad = Math.min(48, Math.min(w, h) * 0.06);
      return Math.max(1e-3, Math.min((w - 2 * pad) / graph.width, (h - 2 * pad) / graph.height));
    }
    function fit() {
      const { left, right, top, bottom } = insets();
      view.scale = view.fitScale = fitScale();
      view.ox = left + (view.cssW - left - right - graph.width * view.scale) / 2;
      view.oy = top + (view.cssH - top - bottom - graph.height * view.scale) / 2;
      view.userMoved = false;
      requestDraw();
    }
    function zoomAt(factor, sx, sy) {
      const next = Math.min(MAX_ZOOM, Math.max(view.fitScale * 0.5, view.scale * factor));
      const k = next / view.scale;
      view.ox = sx - (sx - view.ox) * k;
      view.oy = sy - (sy - view.oy) * k;
      view.scale = next;
      view.userMoved = true;
      requestDraw();
    }
    // Centre the view on a world point at a given scale (or the current one).
    function centerOn(wx, wy, scale = view.scale) {
      view.scale = Math.min(MAX_ZOOM, Math.max(view.fitScale * 0.5, scale));
      view.ox = view.cssW / 2 - wx * view.scale;
      view.oy = view.cssH / 2 - wy * view.scale;
      view.userMoved = true;
      requestDraw();
    }
    function pan(dx, dy) { view.ox += dx; view.oy += dy; view.userMoved = true; requestDraw(); }
    const toWorld = (sx, sy) => [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale];
    const toScreen = (wx, wy) => [wx * view.scale + view.ox, wy * view.scale + view.oy];

    // ---------------------------------------------------------------- drawing
    let drawQueued = false;
    function requestDraw() {
      if (drawQueued) return;
      drawQueued = true;
      requestAnimationFrame(() => { drawQueued = false; draw(); });
    }

    function tracePath(l) {
      const p = l.pts, s = view.scale, ox = view.ox, oy = view.oy;
      ctx.moveTo(p[0] * s + ox, p[1] * s + oy);
      for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k] * s + ox, p[k + 1] * s + oy);
    }
    function visible(l, x0, y0, x1, y1) {
      const b = l.bbox;
      return b[2] >= x0 && b[0] <= x1 && b[3] >= y0 && b[1] <= y1;
    }
    function widthFor(st) { return Math.max(st.min, st.w * view.scale * 0.8); }
    const bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };

    function draw() {
      resize();
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, view.cssW, view.cssH);
      const margin = 40 / view.scale;
      const [x0, y0] = toWorld(0, 0), [x1, y1] = toWorld(view.cssW, view.cssH);
      const vx0 = x0 - margin, vy0 = y0 - margin, vx1 = x1 + margin, vy1 = y1 + margin;
      Object.assign(bounds, { x0: vx0, y0: vy0, x1: vx1, y1: vy1 });
      ctx.lineCap = "round"; ctx.lineJoin = "round";

      // Study-area outline
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = theme.casing; ctx.lineWidth = 1;
      ctx.strokeRect(view.ox, view.oy, graph.width * view.scale, graph.height * view.scale);
      ctx.setLineDash([]);

      // Bridge casings
      for (const l of bridges) {
        if (!visible(l, vx0, vy0, vx1, vy1) || view.scale < l.style.minZoom) continue;
        ctx.beginPath(); tracePath(l);
        ctx.strokeStyle = theme.casing; ctx.lineWidth = widthFor(l.style) + Math.max(2, 3 * view.scale);
        ctx.stroke();
      }

      // Roads by layer, one path per (layer, colour, width)
      for (let li = 0; li < layers.length; li++) {
        const list = layers[li];
        if (!list) continue;
        const batches = new Map();
        for (const l of list) {
          if (view.scale < l.style.minZoom || !visible(l, vx0, vy0, vx1, vy1)) continue;
          const color = l.psvOnly ? "psv" : l.style.color;
          const w = widthFor(l.style);
          const key = color + "|" + w.toFixed(2);
          if (!batches.has(key)) batches.set(key, { color, w, links: [] });
          batches.get(key).links.push(l);
        }
        for (const b of batches.values()) {
          ctx.beginPath();
          for (const l of b.links) tracePath(l);
          ctx.strokeStyle = theme[b.color]; ctx.lineWidth = b.w;
          if (li === 7) ctx.setLineDash([Math.max(4, b.w * 2), Math.max(3, b.w * 1.2)]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      if (view.scale >= DETAIL_ZOOM) drawDetail(vx0, vy0, vx1, vy1);
      if (view.scale >= LABEL_ZOOM && options.labels !== false) drawLabels(vx0, vy0, vx1, vy1);
      drawPortals();
      if (options.overlay) options.overlay(ctx, api);
      if (options.afterDraw) options.afterDraw(api);
    }

    function drawDetail(vx0, vy0, vx1, vy1) {
      const s = view.scale;
      // One-way arrows
      ctx.fillStyle = theme.bg;
      ctx.beginPath();
      for (const l of graph.links) {
        if (!l.oneWay || !visible(l, vx0, vy0, vx1, vy1) || l.len * s < 60) continue;
        const fwd = !!(l.dir & (MG.DIR_AB | MG.DIR_AB_PSV));
        const step = 160 / s;   // one arrow every 160 px of street
        for (let d = Math.min(l.len / 2, step / 2); d < l.len - 5 / s; d += step) {
          const p = MG.pointAlong(l, d, fwd), q = MG.pointAlong(l, d + 1, fwd);
          const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
          const size = Math.min(7, Math.max(3, widthFor(l.style) * 0.45));
          const cx = p[0] * s + view.ox, cy = p[1] * s + view.oy;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          ctx.moveTo(cx + ca * size, cy + sa * size);
          ctx.lineTo(cx - ca * size - sa * size * 0.7, cy - sa * size + ca * size * 0.7);
          ctx.lineTo(cx - ca * size + sa * size * 0.7, cy - sa * size - ca * size * 0.7);
          ctx.closePath();
        }
      }
      ctx.fill();

      // Stop sign approaches: a small diamond a few meters before the stop line
      ctx.fillStyle = theme.signal;
      ctx.beginPath();
      for (const l of graph.links) {
        if (!(l.flags & (MG.FLAG_STOP_AT_A | MG.FLAG_STOP_AT_B)) || !visible(l, vx0, vy0, vx1, vy1)) continue;
        for (const atB of [true, false]) {
          if (!(l.flags & (atB ? MG.FLAG_STOP_AT_B : MG.FLAG_STOP_AT_A))) continue;
          const back = Math.min(l.len * 0.4, 8);
          const p = MG.pointAlong(l, l.len - back, atB);
          const cx = p[0] * s + view.ox, cy = p[1] * s + view.oy, r = 3.5;
          ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
        }
      }
      ctx.fill();

      // Signals
      if (options.drawSignals) options.drawSignals(ctx, api, signalNodes);
      else {
        ctx.beginPath();
        for (const i of signalNodes) {
          const x = graph.nodes.x[i], y = graph.nodes.y[i];
          if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
          const cx = x * s + view.ox, cy = y * s + view.oy;
          ctx.moveTo(cx + 4, cy); ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        }
        ctx.fillStyle = theme.signal; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = theme.bg; ctx.stroke();
      }
    }

    function drawLabels(vx0, vy0, vx1, vy1) {
      const s = view.scale;
      const size = Math.round(Math.min(15, 10 + (s - LABEL_ZOOM) * 2));
      ctx.font = `600 ${size}px "Avenir Next", "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.lineWidth = 3; ctx.strokeStyle = theme.halo; ctx.fillStyle = theme.text;
      const occupied = new Set();
      const cell = 28;
      const placedByName = new Map();
      const candidates = graph.links
        .filter((l) => l.name && visible(l, vx0, vy0, vx1, vy1) && s >= l.style.minZoom)
        .sort((a, b) => b.style.layer - a.style.layer || b.len - a.len);
      for (const l of candidates) {
        // Longest on-screen piece of any straight segment of this link
        const p = l.pts;
        let bestLen = 0, mx = 0, my = 0, ang = 0;
        for (let k = 0; k + 3 < p.length; k += 2) {
          const ax = p[k] * s + view.ox, ay = p[k + 1] * s + view.oy;
          const bx = p[k + 2] * s + view.ox, by = p[k + 3] * s + view.oy;
          const clip = clipToScreen(ax, ay, bx, by, 8);
          if (!clip) continue;
          const [t0, t1] = clip;
          const len = Math.hypot(bx - ax, by - ay) * (t1 - t0);
          if (len > bestLen) {
            const tm = (t0 + t1) / 2;
            bestLen = len; mx = ax + (bx - ax) * tm; my = ay + (by - ay) * tm;
            ang = Math.atan2(by - ay, bx - ax);
          }
        }
        const text = l.name;
        const tw = ctx.measureText(text).width;
        if (bestLen < tw + 16) continue;
        const prior = placedByName.get(text) || [];
        if (prior.some(([px, py]) => Math.hypot(px - mx, py - my) < 260)) continue;
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        // Coarse collision test along the label's axis
        const cells = [];
        const steps = Math.ceil(tw / cell) + 1;
        for (let i = 0; i <= steps; i++) {
          const t = (i / steps - 0.5) * tw;
          cells.push(Math.floor((mx + Math.cos(ang) * t) / cell) + "," + Math.floor((my + Math.sin(ang) * t) / cell));
        }
        if (cells.some((c) => occupied.has(c))) continue;
        cells.forEach((c) => occupied.add(c));
        prior.push([mx, my]); placedByName.set(text, prior);
        ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
        ctx.strokeText(text, 0, 0); ctx.fillText(text, 0, 0);
        ctx.restore();
      }
    }

    // Parametric range [t0, t1] of segment a->b inside the screen (inset by pad), or null.
    function clipToScreen(ax, ay, bx, by, pad) {
      const dx = bx - ax, dy = by - ay;
      let t0 = 0, t1 = 1;
      for (const [pk, qk] of [[-dx, ax - pad], [dx, view.cssW - pad - ax], [-dy, ay - pad], [dy, view.cssH - pad - ay]]) {
        if (pk === 0) { if (qk < 0) return null; continue; }
        const r = qk / pk;
        if (pk < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
        else { if (r < t0) return null; if (r < t1) t1 = r; }
      }
      return t1 > t0 ? [t0, t1] : null;
    }

    function drawPortals() {
      const s = view.scale, r = portalMarkerRadius(s);
      if (!r) return;
      ctx.fillStyle = theme.portal;
      ctx.beginPath();
      for (const i of portals) {
        const x = graph.nodes.x[i] * s + view.ox, y = graph.nodes.y[i] * s + view.oy;
        if (x < -10 || y < -10 || x > view.cssW + 10 || y > view.cssH + 10) continue;
        // Point outward from the nearest edge of the area
        const w = graph.width, h = graph.height, gx = graph.nodes.x[i], gy = graph.nodes.y[i];
        const d = [gx, w - gx, gy, h - gy];
        const m = d.indexOf(Math.min(...d));
        const ang = [Math.PI, 0, -Math.PI / 2, Math.PI / 2][m];
        const ca = Math.cos(ang), sa = Math.sin(ang);
        ctx.moveTo(x + ca * r, y + sa * r);
        ctx.lineTo(x - ca * r * 0.6 - sa * r * 0.7, y - sa * r * 0.6 + ca * r * 0.7);
        ctx.lineTo(x - ca * r * 0.6 + sa * r * 0.7, y - sa * r * 0.6 - ca * r * 0.7);
        ctx.closePath();
      }
      ctx.fill();
    }

    // Highlight a link (selection).
    function strokeLink(l, color) {
      ctx.beginPath(); tracePath(l);
      ctx.strokeStyle = color; ctx.globalAlpha = 0.25;
      ctx.lineWidth = widthFor(l.style) + 10; ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = Math.max(2, widthFor(l.style)); ctx.stroke();
    }
    // Stroke a world polyline [x0, y0, x1, y1, ...] with a halo.
    function strokePolyline(p, color, width) {
      if (p.length < 4) return;
      const s = view.scale;
      ctx.beginPath();
      ctx.moveTo(p[0] * s + view.ox, p[1] * s + view.oy);
      for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k] * s + view.ox, p[k + 1] * s + view.oy);
      ctx.strokeStyle = theme.halo; ctx.lineWidth = width + 4; ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    }

    // ---------------------------------------------------------------- input
    const pointers = new Map();
    let tap = null, pinch = null;
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      tap = pointers.size === 1 ? { x: e.offsetX, y: e.offsetY, t: performance.now() } : null;
      if (pointers.size === 2) pinch = pinchState();
    });
    function pinchState() {
      const [a, b] = [...pointers.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
    canvas.addEventListener("pointermove", (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.offsetX - p.x, dy = e.offsetY - p.y;
      p.x = e.offsetX; p.y = e.offsetY;
      if (tap && Math.hypot(e.offsetX - tap.x, e.offsetY - tap.y) > 6) tap = null;
      if (pointers.size === 1) pan(dx, dy);
      else if (pointers.size === 2 && pinch) {
        const now = pinchState();
        if (pinch.d > 0) zoomAt(now.d / pinch.d, now.mx, now.my);
        pan(now.mx - pinch.mx, now.my - pinch.my);
        pinch = now;
      }
    });
    function endPointer(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (tap && pointers.size === 0 && performance.now() - tap.t < 500 && options.onTap) {
        const [wx, wy] = toWorld(e.offsetX, e.offsetY);
        options.onTap(wx, wy, e.offsetX, e.offsetY);
      }
      tap = null;
    }
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", (e) => { tap = null; endPointer(e); });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.cssH : 1;
      zoomAt(Math.exp(-e.deltaY * unit * 0.0015), e.offsetX, e.offsetY);
    }, { passive: false });
    canvas.addEventListener("dblclick", (e) => zoomAt(2, e.offsetX, e.offsetY));
    canvas.addEventListener("keydown", (e) => {
      const step = 80;
      const actions = {
        "+": () => zoomAt(1.4, view.cssW / 2, view.cssH / 2), "=": () => zoomAt(1.4, view.cssW / 2, view.cssH / 2),
        "-": () => zoomAt(1 / 1.4, view.cssW / 2, view.cssH / 2), "0": fit, "f": fit,
        ArrowLeft: () => pan(step, 0), ArrowRight: () => pan(-step, 0),
        ArrowUp: () => pan(0, step), ArrowDown: () => pan(0, -step),
        Escape: () => options.onEscape && options.onEscape(),
      };
      if (actions[e.key]) { e.preventDefault(); actions[e.key](); }
    });
    window.addEventListener("resize", requestDraw);

    const api = {
      graph, ctx, canvas, view, theme, bounds,
      fit, zoomAt, pan, centerOn, toWorld, toScreen, requestDraw, draw, readTheme, resize,
      widthFor, tracePath, strokeLink, strokePolyline, portalMarkerRadius,
    };
    resize();
    fit();
    return api;
  }

  const api = { createMapView, CLASS_STYLE, FRIENDLY_CLASS, DETAIL_ZOOM, LABEL_ZOOM, MAX_ZOOM, PORTAL_ZOOM, portalMarkerRadius };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsMapView = api;
})(typeof window !== "undefined" ? window : globalThis);
