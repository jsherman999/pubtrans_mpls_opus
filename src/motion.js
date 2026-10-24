// Vehicle motion on the decoded street graph (src/graph.js), using the router's directed arcs
// (src/routing.js) and signal timing (src/traffic.js). No dependencies.
//
// A vehicle on the road is at distance `s` (meters) along arc `route[ri]`, in one of that arc's
// lanes. Each step spends elapsed seconds at the arc's posted speed and carries what is left
// across short arcs, as the source app's stepCars does. Vehicles in a lane keep the source's
// 8 m following gap, looking across arc boundaries along their own route; they stop at the stop
// line for red signals, hold at stop signs, and wait before closed arcs. Each lane is a queue
// (front first), so per-direction lane occupancy replaces the source's edgeKey(a, b) claims.
//
// Vehicle fields used here (the engine owns the objects and may add its own):
//   mode         MODE_GENERAL (private cars) or MODE_PSV (shuttles, buses, responders)
//   route        arc ids being driven, or null; ri is the current index into it
//   s, lane      position on route[ri]; lane is -1 while the vehicle is off the road at a node
//   node         node the vehicle is parked at while off the road
//   hold         seconds left of a stop-sign hold; cleared marks the hold as served
//   speedFactor  optional multiplier on posted speed (default 1)
//   passTag      closure tag this vehicle may drive through (responders at their own incident)
//   lastArc      arc the vehicle arrived on (set on arrival); odo, meters driven
//   waiting      why the vehicle stopped short this step: "queue", "signal", "stop",
//                "closed", or null if it used the whole step (or arrived)
(function (root) {
  "use strict";

  const GAP = 8;                 // m, the source app's following gap
  const MODE_PSV = 2;
  const NODE_PORTAL = 1;
  const EPS = 1e-9;

  function createMotion(graph, router, signals, opts = {}) {
    const gap = opts.gap ?? GAP;
    const stopHold = opts.stopHold ?? 3;
    const arcs = router.arcs;
    const A = arcs.length;
    const len = new Float64Array(A), mps = new Float64Array(A), laneCount = new Uint8Array(A);
    const controlled = new Uint8Array(A), stopSign = new Uint8Array(A), psvOnly = new Uint8Array(A);
    for (let i = 0; i < A; i++) {
      const arc = arcs[i], l = arc.link;
      len[i] = l.len;
      mps[i] = Math.max(l.kph, 5) / 3.6;
      laneCount[i] = Math.max(1, Math.min(8, arc.forward ? l.lanesAB : l.lanesBA));
      controlled[i] = arc.signal === 0 || arc.signal === 1 ? 1 : 0;
      stopSign[i] = arc.stop ? 1 : 0;
      psvOnly[i] = arc.psvOnly ? 1 : 0;
    }
    const lanes = new Array(A);              // lanes[arc][k] = vehicles, front first; lazily built
    const occupancy = new Int32Array(A);     // vehicles on each arc, all lanes
    const closed = new Int32Array(A);        // 0 open, else the closure's tag (see setClosed)
    const nflags = graph.nodes.flags;
    let stamp = 0;

    function lanesOf(a) {
      let ls = lanes[a];
      if (!ls) { ls = lanes[a] = []; for (let k = 0; k < laneCount[a]; k++) ls.push([]); }
      return ls;
    }

    // Route legality for the vehicle's mode: contiguous, no shuttle-only arcs for private cars,
    // and no passing through a portal (a route may start or end at one).
    function checkRoute(v, route) {
      for (let i = 0; i < route.length; i++) {
        const a = route[i];
        if (!(a >= 0 && a < A)) throw new Error(`${v.id}: arc ${a} does not exist`);
        if (psvOnly[a] && v.mode !== MODE_PSV) throw new Error(`${v.id}: arc ${a} is for shuttles and buses only`);
        if (i && arcs[route[i - 1]].to !== arcs[a].from) throw new Error(`${v.id}: route is not contiguous at ${i}`);
        if (i < route.length - 1 && (nflags[arcs[a].to] & NODE_PORTAL)) throw new Error(`${v.id}: route passes through a portal`);
      }
    }

    // Park a vehicle off the road at a node (start of day, or teleporting between scenarios).
    function place(v, node) {
      leaveLane(v);
      v.route = null; v.ri = 0; v.s = 0; v.lane = -1; v.node = node;
      v.hold = 0; v.cleared = false; v.waiting = null;
      v.speedFactor = v.speedFactor ?? 1;
    }

    // Give a vehicle a new route. A vehicle on the road keeps its arc and position, so the new
    // route must start with the arc it is on; a parked vehicle's route must start at its node.
    // An empty route means the vehicle has already arrived.
    function setRoute(v, route) {
      if (v.lane >= 0) {
        if (!route.length || route[0] !== v.route[v.ri]) throw new Error(`${v.id}: new route must start on arc ${v.route[v.ri]}`);
      } else if (route.length && arcs[route[0]].from !== v.node) {
        throw new Error(`${v.id}: route starts at ${arcs[route[0]].from}, vehicle is at ${v.node}`);
      }
      checkRoute(v, route);
      v.route = route.length ? route : null;
      v.ri = 0;
      v.waiting = null;
    }

    // Arc the vehicle is on, or -1 when parked.
    const currentArc = (v) => (v.lane >= 0 ? v.route[v.ri] : -1);

    function leaveLane(v) {
      if (!(v.lane >= 0)) return;
      const a = v.route[v.ri], q = lanes[a][v.lane];
      const i = q.indexOf(v);
      if (i >= 0) q.splice(i, 1);
      occupancy[a]--;
      v.lane = -1;
    }

    // Take a vehicle off the road where it stands (breakdown, removal). It becomes parked at the
    // node it was heading to; drawing keeps its last position.
    function remove(v) {
      if (v.lane >= 0) v.node = arcs[v.route[v.ri]].to;
      leaveLane(v);
      v.route = null; v.ri = 0;
    }

    function enter(v, a, k) {
      lanesOf(a)[k].push(v);
      occupancy[a]++;
      v.lane = k; v.s = 0; v.cleared = false; v.hold = 0;
    }

    // Best lane to join on arc a: the one whose last vehicle is farthest along. Returns the lane
    // and the room (meters) a vehicle entering it has before the following gap, Infinity if empty.
    // Tail vehicles that have not moved yet this step move first, so platoons flow together.
    let pickLane = 0;
    function entryRoom(a) {
      const ls = lanesOf(a);
      let best = -Infinity, bestLane = 0;
      for (let k = 0; k < ls.length; k++) {
        const q = ls[k];
        let tail = q[q.length - 1];
        if (tail && tail.due === stamp && !tail.busy) { advance(tail); tail = q[q.length - 1]; }
        const room = tail ? tail.s - gap : Infinity;
        if (room > best) { best = room; bestLane = k; }
      }
      pickLane = bestLane;   // set last: advancing a tail may have called entryRoom recursively
      return best;
    }

    // Free distance past the end of the current arc along the route before the following gap to
    // the next vehicle ahead; Infinity once at least `gap` meters are clear.
    function aheadRoom(v) {
      let acc = 0;
      for (let j = v.ri + 1; j < v.route.length; j++) {
        const a = v.route[j];
        if (blocked(v, a)) return acc;
        const room = entryRoom(a);
        if (room !== Infinity) return acc + room;
        acc += len[a];
        if (acc >= gap) return Infinity;
      }
      return Infinity;
    }

    let arrivals = null, t0 = 0, dt = 0;

    function advance(v) {
      if (v.due !== stamp || v.busy) return;
      if (!v.route) return done(v);
      v.busy = true;
      v.waiting = null;
      let remaining = dt;
      const factor = v.speedFactor ?? 1;

      // Parked at a node: join the first arc when it has room.
      if (v.lane < 0) {
        const a = v.route[0];
        const room = blocked(v, a) ? -1 : entryRoom(a);
        if (room < 0) { v.waiting = blocked(v, a) ? "closed" : "queue"; return done(v); }
        enter(v, a, pickLane);
        v.ri = 0;
      }

      while (remaining > EPS) {
        const a = v.route[v.ri], L = len[a];
        const q = lanes[a][v.lane];
        let k = q.indexOf(v);
        if (k > 0 && q[k - 1].due === stamp && !q[k - 1].busy) { advance(q[k - 1]); k = q.indexOf(v); }
        let lim = k > 0 ? q[k - 1].s - gap : L + Math.min(0, aheadRoom(v));
        if (lim > L) lim = L;
        const speed = mps[a] * factor;
        if (lim > v.s) {
          const travel = Math.min(lim - v.s, remaining * speed);
          v.s += travel;
          v.odo = (v.odo || 0) + travel;
          remaining -= travel / speed;
        }
        if (v.s < L - 1e-6) {
          if (remaining > EPS) v.waiting = "queue";
          break;
        }
        v.s = L;
        if (v.ri === v.route.length - 1) {            // arrived: pull over at the node
          v.node = arcs[a].to;
          v.lastArc = a;
          leaveLane(v);
          v.route = null; v.ri = 0;
          arrivals.push(v);
          break;
        }
        if (controlled[a] && !signals.canEnter(arcs[a], t0 + dt - remaining)) { v.waiting = "signal"; break; }
        if (stopSign[a] && !v.cleared) {
          if (!(v.hold > 0)) v.hold = stopHold;
          const h = Math.min(v.hold, remaining);
          v.hold -= h; remaining -= h;
          if (v.hold > EPS) { v.waiting = "stop"; break; }
          v.hold = 0; v.cleared = true;
          if (remaining <= EPS) break;
        }
        const next = v.route[v.ri + 1];
        if (blocked(v, next)) { v.waiting = "closed"; break; }
        const room = entryRoom(next);
        if (room < 0) { v.waiting = "queue"; break; }
        const lane = pickLane;
        leaveLane(v);
        v.ri++;
        enter(v, next, lane);
      }
      return done(v);
    }
    function done(v) { v.due = 0; v.busy = false; }

    // Advance every vehicle in `list` from time t by dt seconds. Returns the vehicles that
    // reached the end of their route during the step, in the order they arrived. Vehicles are
    // moved in list order, except that a vehicle's leaders (in its lane, or at the back of the
    // lane it is about to join) move first when they are in the list too. Vehicles left out
    // stay where they are and act as obstacles.
    function step(list, t, seconds) {
      stamp++;
      t0 = t; dt = seconds;
      arrivals = [];
      for (const v of list) v.due = stamp;
      for (const v of list) advance(v);
      const out = arrivals;
      arrivals = null;
      return out;
    }

    // Close an arc to traffic (value true, or a positive tag) or reopen it (false / 0). Vehicles
    // whose passTag equals the tag may still use it.
    function setClosed(a, value) { closed[a] = value === true ? -1 : value ? value : 0; }
    function blocked(v, a) { return closed[a] !== 0 && closed[a] !== v.passTag; }

    // World position and heading of a vehicle. Lanes are offset to the right of travel, so
    // opposing traffic and side-by-side lanes do not draw on top of each other.
    function locate(v, laneWidth = 3.2) {
      if (v.lane < 0) {
        if (v.node == null) return null;
        return { x: graph.nodes.x[v.node], y: graph.nodes.y[v.node], heading: v.heading || 0 };
      }
      const arc = arcs[v.route[v.ri]], l = arc.link;
      const s = Math.min(v.s, len[v.route[v.ri]]);
      const p = pointAt(l, s, arc.forward);
      const off = l.oneWay ? (v.lane - (laneCount[v.route[v.ri]] - 1) / 2) * laneWidth : (v.lane + 0.5) * laneWidth;
      const ca = Math.cos(p.h), sa = Math.sin(p.h);
      v.heading = p.h;
      return { x: p.x - sa * off, y: p.y + ca * off, heading: p.h };
    }

    // Point and direction of travel at distance s along a link.
    function pointAt(l, s, forward) {
      const p = l.pts, n = p.length / 2;
      let d = forward ? s : l.len - s;
      for (let k = 0; k < n - 1; k++) {
        const dx = p[k * 2 + 2] - p[k * 2], dy = p[k * 2 + 3] - p[k * 2 + 1];
        const seg = Math.hypot(dx, dy);
        if (d <= seg || k === n - 2) {
          const t = seg ? Math.max(0, Math.min(1, d / seg)) : 0;
          const h = Math.atan2(dy, dx);
          return { x: p[k * 2] + dx * t, y: p[k * 2 + 1] + dy * t, h: forward ? h : h + Math.PI };
        }
        d -= seg;
      }
      return { x: p[0], y: p[1], h: 0 };
    }

    // Consistency check for tests: lane membership, spacing, legal arcs and positions.
    function check(list) {
      const problems = [];
      let onRoad = 0;
      for (let a = 0; a < A; a++) {
        const ls = lanes[a];
        if (!ls) { if (occupancy[a]) problems.push(`arc ${a}: occupancy without lanes`); continue; }
        let n = 0;
        for (let k = 0; k < ls.length; k++) {
          const q = ls[k];
          n += q.length;
          for (let i = 0; i < q.length; i++) {
            const v = q[i];
            if (v.lane !== k || !v.route || v.route[v.ri] !== a) problems.push(`${v.id}: lane bookkeeping on arc ${a}`);
            if (!(v.s >= -1e-6 && v.s <= len[a] + 1e-6)) problems.push(`${v.id}: s=${v.s} outside arc ${a}`);
            if (psvOnly[a] && v.mode !== MODE_PSV) problems.push(`${v.id}: private vehicle on shuttle-only arc ${a}`);
            if (i && q[i - 1].s - v.s < gap - 1e-6) problems.push(`${v.id}: ${(q[i - 1].s - v.s).toFixed(2)} m behind ${q[i - 1].id} on arc ${a}`);
          }
        }
        if (n !== occupancy[a]) problems.push(`arc ${a}: occupancy ${occupancy[a]} vs ${n} in lanes`);
        onRoad += n;
      }
      if (list) {
        let listed = 0;
        for (const v of list) if (v.lane >= 0) listed++;
        if (listed !== onRoad) problems.push(`${onRoad} vehicles in lanes, ${listed} listed on the road`);
      }
      return problems;
    }

    return {
      gap, lanes, occupancy, closed, laneCount, len,
      place, setRoute, remove, step, setClosed, currentArc, locate, check, checkRoute,
    };
  }

  const api = { createMotion, GAP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsMotion = api;
})(typeof window !== "undefined" ? window : globalThis);
