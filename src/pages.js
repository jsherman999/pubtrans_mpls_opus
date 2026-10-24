// Phone layout shared by the simulation page and the street viewer: the map and a panel as two
// full-screen pages side by side. Swipe left from the right edge, flick the map left or tap the
// tab to turn to the panel; swipe it right or tap its back button to return. A slow drag on the
// map still pans it. The page's CSS places the panel off-screen to the right and shows it with
// the `open` class; on wide screens isPhone() is false and nothing here reacts.
(function (root) {
  "use strict";

  // panel: the panel element; edge: the strip along the map's right edge that starts a swipe;
  // tab: the button on it; back: the panel's button back to the map; canvas: the map canvas and
  // mapView its MplsMapView (a flick undoes the pan it caused). onChange(open) after each change.
  function createPages({ panel, edge, tab, back, canvas, mapView, isPhone, onChange }) {
    let open = false, dragging = false, swipedAt = -1e9;

    function setOpen(o) {
      open = o;
      panel.classList.toggle("open", o);
      panel.style.transform = ""; panel.style.transition = "";
      panel.inert = isPhone() && !o;
      back.setAttribute("aria-expanded", String(o));
      tab.setAttribute("aria-expanded", String(o));
      if (onChange) onChange(o);
    }

    // The panel follows a horizontal drag on `el`; on release it settles open or closed.
    function swipe(el, opening, accept) {
      let start = null, last = null, vx = 0;
      el.addEventListener("pointerdown", (e) => {
        start = isPhone() && open !== opening && (!accept || accept(e)) ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
        last = { x: e.clientX, t: e.timeStamp }; vx = 0;
      });
      el.addEventListener("pointermove", (e) => {
        if (!start || e.pointerId !== start.id) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!dragging) {
          if (Math.hypot(dx, dy) < 10) return;
          // Vertical, or the wrong way: not a page swipe (the panel scrolls, the tab ignores it).
          if (Math.abs(dx) < Math.abs(dy) * 1.2 || (opening ? dx > 0 : dx < 0)) { start = null; return; }
          dragging = true;
          if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
          panel.style.transition = "none";
        }
        const w = root.innerWidth;
        panel.style.transform = `translateX(${Math.max(0, Math.min(w, (opening ? w : 0) + dx))}px)`;
        const dt = e.timeStamp - last.t;
        if (dt > 0) vx = (e.clientX - last.x) / dt;
        last = { x: e.clientX, t: e.timeStamp };
      });
      const end = (e) => {
        if (!start || e.pointerId !== start.id) return;
        if (dragging) {
          const dx = e.clientX - start.x, w = root.innerWidth;
          const flung = opening ? dx < -w * 0.25 || vx < -0.4 : dx > w * 0.25 || vx > 0.4;
          dragging = false; swipedAt = performance.now();
          setOpen(e.type === "pointercancel" ? open : flung === opening);
        }
        start = null;
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      // A swipe that ends over a button is not a press of it.
      el.addEventListener("click", (e) => { if (performance.now() - swipedAt < 400) { e.stopPropagation(); e.preventDefault(); } }, true);
    }
    swipe(edge, true);
    // Sliders and menus keep their own horizontal drags.
    swipe(panel, false, (e) => !(e.target && e.target.closest && e.target.closest("input[type=range], select")));
    tab.addEventListener("click", () => setOpen(true));
    back.addEventListener("click", () => setOpen(!open));

    // A quick leftward flick on the map turns to the panel and undoes the pan it caused.
    let down = 0, flick = null;
    canvas.addEventListener("pointerdown", (e) => {
      down++;
      const v = mapView.view;
      flick = down === 1 && isPhone() ? { x: e.clientX, y: e.clientY, t: e.timeStamp, ox: v.ox, oy: v.oy } : null;
    });
    const up = (e) => {
      down = Math.max(0, down - 1);
      const f = flick; flick = null;
      if (!f || e.type !== "pointerup") return;
      const dx = e.clientX - f.x, dy = e.clientY - f.y, dt = Math.max(1, e.timeStamp - f.t);
      if (dx < -60 && Math.abs(dx) > 2 * Math.abs(dy) && dt < 250 && -dx / dt > 0.5) {
        mapView.view.ox = f.ox; mapView.view.oy = f.oy; mapView.requestDraw();
        setOpen(true);
      }
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);

    setOpen(false);
    return { setOpen, get open() { return open; }, get dragging() { return dragging; } };
  }

  const api = { createPages };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsPages = api;
})(typeof window !== "undefined" ? window : globalThis);
