// Simulation engine on the real street graph: demand, dispatch, pooling, ride sharing, private
// traffic, emergencies and metrics, ported from the source app's index.html onto
// src/routing.js (routes), src/traffic.js (signals) and src/motion.js (vehicle movement).
// No DOM and no Math.random: every run is reproducible from its seed, and playback speed only
// changes how many fixed 3-second steps run per frame.
(function (root) {
  "use strict";

  const isNode = typeof module !== "undefined" && module.exports;
  const R = isNode ? require("./routing.js") : root.MplsRouting;
  const T = isNode ? require("./traffic.js") : root.MplsTraffic;
  const M = isNode ? require("./motion.js") : root.MplsMotion;
  const C = isNode ? require("./congestion.js") : root.MplsCongestion;
  const { MODE_GENERAL, MODE_PSV } = R;

  const STEP = 3;                       // s, fixed simulation step (source SIM_MIN_PER_TICK)
  const DAY_START = 7 * 60 + 30;        // minutes; 07:30, the school rush
  const POOL_WINDOW = 30 * 60;          // s a request stays poolable
  const SURGE_QUEUE = 16;               // queue length that triggers origin sweeps
  const SWEEP_MIN = 3;                  // riders waiting at one origin to justify a sweep
  const IDLE_RETURN = 3 * 60;           // s an idle vehicle lingers before heading to a depot
  const SHARE_BUDGET = 400;             // m of extra driving per trip at 100 % ride sharing
  const BOARD_SECONDS = 3;              // per rider, one rider per step
  const NODE_PORTAL = 1;

  const CAPACITY = { sedan: 4, shuttle: 8, bus: 20, police: 4, fire: 6, firecar: 4, recovery: 8, private: 1 };
  const PCU = { bus: 2, fire: 2, recovery: 1.5 };   // lane space and stop-line time, in cars
  const FLEET_KINDS = ["sedan", "shuttle", "bus"];
  const FLEET_KEY = { sedan: "sedans", shuttle: "shuttles", bus: "buses" };   // settings keys
  const RESPONDERS = ["police", "fire", "firecar"];

  // Defaults. Places are placeholder demand (seeded random street nodes) until Phase 5's census
  // and LODES zones; depot and base coordinates are approximate.
  const DEFAULTS = {
    seed: 1,
    population: 2500,
    sedans: 60, shuttles: 60, buses: 10,
    rideSharing: 100,                   // %, on-the-way pickups for shuttles and buses
    privateTraffic: 1,                  // × baseline private arrivals and freeway through-traffic
    trafficScale: 4,                    // real cars each private-car agent stands for (its PCU)
    places: { residential: 80, employer: 30, school: 4, grocery: 12, station: 4 },
    placeSpacing: 140,                  // m between placeholder places
    depots: [
      { name: "ABC Ramps (North Loop)", lat: 44.9816, lon: -93.2776 },
      { name: "Leamington Ramp (Downtown)", lat: 44.9728, lon: -93.2722 },
      { name: "Downtown East Ramp", lat: 44.9753, lon: -93.2593 },
      { name: "UMN West Bank Ramp", lat: 44.9707, lon: -93.2432 },
      { name: "UMN East Bank Ramp", lat: 44.9739, lon: -93.2300 },
    ],
    base: { name: "Police / Fire (City Hall)", lat: 44.9774, lon: -93.2654 },
    localPerHour: 2500,                 // real cars entering at the map edge per hour at 1×, off-peak
    throughPerHour: 2500,               // real freeway through-trips per hour at 1×, off-peak
    amPeak: 3,                          // extra arrivals at 08:00, × the base rate (×4 in all)
    throughPeak: 0.8,                   // extra freeway through-traffic at 08:00, × the base rate
    congestionRouting: true,            // routes and drivers in queues avoid congested streets
    rareEvents: true,
  };

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createSim(graph, options = {}) {
    const opts = { ...DEFAULTS, ...options, places: { ...DEFAULTS.places, ...(options.places || {}) } };
    const router = options.router || R.createRouter(graph);
    const signals = T.createSignals(graph, { seed: opts.seed });
    const motion = M.createMotion(graph, router, signals);
    const congestion = C.createCongestion(graph, router, motion, signals);
    const arcs = router.arcs;
    const nx = graph.nodes.x, ny = graph.nodes.y, nflags = graph.nodes.flags;
    const core = router.connectedCore(MODE_GENERAL);
    const dist = (a, b) => { const dx = nx[a] - nx[b], dy = ny[a] - ny[b]; return Math.sqrt(dx * dx + dy * dy); };
    const isPortal = (v) => !!(nflags[v] & NODE_PORTAL);

    const settings = {
      population: opts.population, sedans: opts.sedans, shuttles: opts.shuttles, buses: opts.buses,
      rideSharing: opts.rideSharing, privateTraffic: opts.privateTraffic,
    };

    // ------------------------------------------------------------------ geography
    const toXY = (lat, lon) => {
      const [s, w, n, e] = graph.bbox;
      return [(lon - w) / (e - w) * graph.width, (n - lat) / (n - s) * graph.height];
    };
    // Nodes that make sensible curbside stops: in the core, on a street (not a freeway, ramp or
    // service road only).
    const STREET = /^(primary|secondary|tertiary|unclassified|residential|living_street)$/;
    const curb = new Uint8Array(graph.nodes.count);
    for (const v of core.nodes)
      if (graph.out[v].some((a) => STREET.test(a.link.className)) && graph.inc[v].some((a) => STREET.test(a.link.className))) curb[v] = 1;
    const curbNodes = core.nodes.filter((v) => curb[v]);
    function nearestCurb(x, y) {
      const v = router.nearestNode(x, y, (n) => curb[n]);
      return v >= 0 ? v : router.nearestNode(x, y, (n) => core.inCore[n]);
    }
    function streetName(v) {
      for (const a of graph.out[v]) if (a.link.name && STREET.test(a.link.className)) return a.link.name;
      for (const a of graph.out[v]) if (a.link.name) return a.link.name;
      return "unnamed street";
    }

    const TYPE_LABEL = { residential: "Homes", employer: "Employer", school: "School", grocery: "Grocery", station: "Transit hub" };
    function makePlaces(rng) {
      const places = [], taken = [];
      const types = Object.keys(opts.places);
      for (const type of types) {
        for (let i = 0; i < opts.places[type]; i++) {
          let node = -1;
          for (let k = 0; k < 60 && node < 0; k++) {
            const v = curbNodes[Math.floor(rng() * curbNodes.length)];
            if (taken.every((u) => dist(u, v) >= opts.placeSpacing)) node = v;
          }
          if (node < 0) continue;
          taken.push(node);
          const p = { id: places.length, type, node, x: nx[node], y: ny[node], name: "" };
          if (type === "residential") p.units = 8 + Math.floor(rng() * 113);
          places.push(p);
        }
      }
      const seen = new Map();
      for (const p of places) {
        const base = `${TYPE_LABEL[p.type]} · ${streetName(p.node)}`;
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        p.name = n > 1 ? `${base} ${n}` : base;
      }
      return places;
    }
    function snapSite(site, kind) {
      const [x, y] = toXY(site.lat, site.lon);
      const node = nearestCurb(x, y);
      return { name: site.name, kind, node, x: nx[node], y: ny[node] };
    }

    // Portals for private traffic. Freeway through-traffic runs edge to edge.
    const FREEWAY = /^(motorway|trunk)$/;
    const entries = [], exits = [], freewayIn = [], freewayOut = [];
    for (let v = 0; v < graph.nodes.count; v++) {
      if (!isPortal(v)) continue;
      const outs = graph.out[v].filter((a) => !a.psvOnly), ins = graph.inc[v].filter((a) => !a.psvOnly);
      if (outs.length) entries.push(v);
      if (ins.length) exits.push(v);
      if (outs.some((a) => FREEWAY.test(a.link.className))) freewayIn.push(v);
      if (ins.some((a) => FREEWAY.test(a.link.className))) freewayOut.push(v);
    }
    const throughRoutes = [];
    for (const a of freewayIn) for (const b of freewayOut) {
      const r = router.route(a, b, { mode: MODE_GENERAL });
      if (r && r.length > 1500) throughRoutes.push(r);
    }
    // Local visitors enter where the road reaches the core, and leave the same way.
    const localEntries = [], localExits = [];
    for (const v of entries) { const r = router.route(v, core.nodes[0]); if (r) localEntries.push(v); }
    for (const v of exits) { const r = router.route(core.nodes[0], v); if (r) localExits.push(v); }
    // Traffic enters and leaves in proportion to the capacity of the road at the edge, so
    // freeways and arterials carry most of it.
    const edgeWeight = (list) => { let c = 0; return list.map((a) => (c += a.reduce((s, arc) => s + congestion.capacity[arc.id], 0))); };
    const entryWeight = edgeWeight(localEntries.map((v) => graph.out[v].filter((a) => !a.psvOnly)));
    const exitWeight = edgeWeight(localExits.map((v) => graph.inc[v].filter((a) => !a.psvOnly)));
    const throughWeight = edgeWeight(throughRoutes.map((r) => [arcs[r.arcs[0]]]));

    // ------------------------------------------------------------------ state
    let rng, S;
    function freshState() {
      rng = mulberry32(opts.seed);
      const places = makePlaces(rng);
      const byType = {};
      for (const p of places) (byType[p.type] = byType[p.type] || []).push(p);
      S = {
        t: 0, minute: DAY_START, day: 0,
        places, byType,
        depots: opts.depots.map((d) => snapSite(d, "depot")),
        base: snapSite(opts.base, "base"),
        humans: [], agenda: [], agendaPos: 0,
        queue: [], vehicles: [], parked: [], atPortal: [], incidents: [], closures: new Map(),
        seq: {}, nextReq: 1, nextIncident: 1,
        completed: 0, rideSeconds: 0, boardedWaitSeconds: 0, boardedCount: 0,
        pooled: 0, sharedPickups: 0, sharingCursor: 0, reroutes: 0,
        localCredit: 0, throughCredit: 0,
        nextPolice: 0, nextFire: 0, nextTrouble: 0,
        log: [], logSeq: 0, history: [], recentTrips: [],
      };
      S.nextPolice = rareAfter(180 * 60); S.nextFire = rareAfter(600 * 60); S.nextTrouble = rareAfter(480 * 60);
      stopNode.fill(0);
      for (const p of [...S.places, ...S.depots, S.base]) stopNode[p.node] = 1;
      for (const v of localExits) stopNode[v] = 1;   // visitors leave through these
      setPopulation(settings.population);
      for (const kind of FLEET_KINDS) setFleet(kind, settings[FLEET_KEY[kind]]);
    }
    const rareAfter = (mean) => S.t + mean * (0.5 + rng());
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];

    function log(cat, msg) {
      S.log.push({ n: ++S.logSeq, t: S.t, minute: S.minute, cat, msg });
      if (S.log.length > 500) S.log.splice(0, S.log.length - 500);
    }

    // ------------------------------------------------------------------ population (source makeHuman)
    function pickResidential() {
      const homes = S.byType.residential;
      let choice = rng() * homes.reduce((sum, b) => sum + b.units, 0);
      for (const b of homes) { choice -= b.units; if (choice < 0) return b; }
      return homes[homes.length - 1];
    }
    function makeHuman(id) {
      const home = pickResidential();
      const roll = rng();
      const profile = roll < 0.6 ? "worker" : roll < 0.8 ? "student" : roll < 0.9 ? "errand" : "commuter";
      const jitter = () => (rng() - 0.5) * 60;
      const h = { id, home, profile, schedule: [] };
      const add = (minute, from, to) => { if (from.node !== to.node) h.schedule.push({ minute, from, to, human: h }); };
      if (profile === "worker") {
        const work = pick(S.byType.employer);
        add(8 * 60 + jitter(), home, work); add(17 * 60 + jitter(), work, home);
      } else if (profile === "student") {
        const s = pick(S.byType.school);
        add(7 * 60 + 30 + jitter(), home, s); add(15 * 60 + jitter(), s, home);
      } else if (profile === "errand") {
        const g = pick(S.byType.grocery);
        add(10 * 60 + jitter(), home, g); add(11 * 60 + jitter(), g, home);
        if (rng() < 0.4) { const g2 = pick(S.byType.grocery); add(14 * 60 + jitter(), home, g2); add(15 * 60 + jitter(), g2, home); }
      } else {
        const st = pick(S.byType.station);
        add(9 * 60 + jitter(), home, st); add(18 * 60 + jitter(), st, home);
      }
      return h;
    }
    function rebuildAgenda() {
      S.agenda = [];
      for (const h of S.humans) for (const s of h.schedule) S.agenda.push(s);
      S.agenda.sort((a, b) => a.minute - b.minute || a.human.id - b.human.id);
      S.agendaPos = 0;
      while (S.agendaPos < S.agenda.length && S.agenda[S.agendaPos].minute < S.minute) S.agendaPos++;
    }
    function setPopulation(n) {
      settings.population = n = Math.max(0, Math.round(n));
      while (S.humans.length < n) S.humans.push(makeHuman(S.humans.length));
      if (S.humans.length > n) S.humans.length = n;
      rebuildAgenda();
    }
    function checkSchedules() {
      while (S.agendaPos < S.agenda.length && S.agenda[S.agendaPos].minute <= S.minute) {
        const s = S.agenda[S.agendaPos++];
        const req = { id: S.nextReq++, human: s.human.id, profile: s.human.profile, from: s.from, to: s.to,
          pickup: s.from.node, dropoff: s.to.node, requestedAt: S.t, pickedUpAt: null, completedAt: null };
        S.queue.push(req);
        log("REQUEST", `r#${req.id} ${req.profile} #${req.human}: ${s.from.name} → ${s.to.name}`);
      }
    }
    // A ride request between two places, as a scheduled trip would make (also for tests).
    function addRequest(from, to, profile = "manual") {
      if (from.node === to.node) return null;
      const req = { id: S.nextReq++, human: -1, profile, from, to, pickup: from.node, dropoff: to.node,
        requestedAt: S.t, pickedUpAt: null, completedAt: null };
      S.queue.push(req);
      log("REQUEST", `r#${req.id} ${profile}: ${from.name} → ${to.name}`);
      return req;
    }
    function advanceClock() {
      S.t += STEP;
      S.minute += STEP / 60;
      if (S.minute >= 24 * 60) {
        S.minute = DAY_START + (S.minute - 24 * 60);
        S.day++;
        S.agendaPos = 0;
        while (S.agendaPos < S.agenda.length && S.agenda[S.agendaPos].minute < S.minute) S.agendaPos++;
      }
    }

    // ------------------------------------------------------------------ passenger accounting (source)
    function boardPassenger(r) {
      r.pickedUpAt = S.t;
      if (!r.queueRecorded) { S.boardedWaitSeconds += Math.max(0, S.t - r.requestedAt); S.boardedCount++; r.queueRecorded = true; }
    }
    function completePassenger(r) {
      if (!Number.isFinite(r.pickedUpAt) || r.completedAt != null) return false;
      r.completedAt = S.t;
      S.completed++;
      S.rideSeconds += S.t - r.pickedUpAt;
      S.recentTrips.push({ ride: S.t - r.pickedUpAt, wait: r.pickedUpAt - r.requestedAt });
      if (S.recentTrips.length > 1000) S.recentTrips.splice(0, S.recentTrips.length - 1000);
      return true;
    }
    function waitingRequests() {
      const waiting = new Set(S.queue);
      for (const v of S.vehicles) for (const r of v.pickupQueue) waiting.add(r);
      return waiting;
    }
    // Running mean request-to-boarding wait, including riders still waiting (source averageQueueMinutes).
    function averageQueueMinutes() {
      let total = S.boardedWaitSeconds, count = S.boardedCount;
      for (const r of waitingRequests()) if (r.pickedUpAt == null && !r.queueRecorded) { total += Math.max(0, S.t - r.requestedAt); count++; }
      return count ? total / count / 60 : null;
    }
    function currentQueueWaitMinutes() {
      let total = 0, count = 0;
      for (const r of waitingRequests()) if (r.pickedUpAt == null && !r.queueRecorded) { total += Math.max(0, S.t - r.requestedAt); count++; }
      return count ? total / count / 60 : 0;
    }

    // ------------------------------------------------------------------ vehicles
    function makeVehicle(kind, node, extra = {}) {
      S.seq[kind] = (S.seq[kind] || 0) + 1;
      const v = {
        id: `${kind}-${S.seq[kind]}`, kind,
        mode: kind === "private" ? MODE_GENERAL : MODE_PSV,
        capacity: CAPACITY[kind], state: "idle", retiring: false,
        riders: [], pickupQueue: [], segments: [], active: null, boarding: null,
        idleSince: S.t, sharingDetour: 0, odo: 0, speedFactor: 1, pcu: PCU[kind] || 1,
        ...extra,
      };
      motion.place(v, node);
      v.heading = 0;
      S.vehicles.push(v);
      return v;
    }
    function removeVehicle(v) {
      motion.remove(v);
      const i = S.vehicles.indexOf(v);
      if (i >= 0) S.vehicles.splice(i, 1);
      v.removed = true;
    }
    const countFleet = (kind) => S.vehicles.reduce((n, v) => n + (v.kind === kind && !v.retiring ? 1 : 0), 0);
    function setFleet(kind, n) {
      n = Math.max(0, Math.round(n));
      settings[FLEET_KEY[kind]] = n;
      let have = countFleet(kind);
      // Revive retiring vehicles first, then add at depots in turn.
      for (const v of S.vehicles) if (have < n && v.kind === kind && v.retiring) { v.retiring = false; have++; }
      while (have < n) {
        const depot = S.depots[(S.seq[kind] || 0) % S.depots.length];
        const v = makeVehicle(kind, depot.node);
        v.depot = depot;
        have++;
      }
      // Remove parked idle vehicles first; busy ones finish their riders, then leave.
      const mine = S.vehicles.filter((v) => v.kind === kind && !v.retiring);
      mine.sort((a, b) => score(a) - score(b));
      function score(v) { return v.state === "idle" ? (atDepot(v) ? 0 : 1) : v.riders.length + v.pickupQueue.length + 2; }
      for (let i = 0; have > n && i < mine.length; i++, have--) {
        const v = mine[i];
        if (v.state === "idle" && atDepot(v)) { removeVehicle(v); continue; }
        v.retiring = true;
        if (v.state === "idle") sendToDepot(v);
      }
    }
    const atDepot = (v) => v.lane < 0 && S.depots.some((d) => d.node === v.node);
    function nearestDepot(v) {
      const node = anchorNode(v);
      let best = S.depots[0], bd = Infinity;
      for (const d of S.depots) { const dd = dist(node, d.node); if (dd < bd) { bd = dd; best = d; } }
      return best;
    }
    // Node a vehicle's next route starts from: its node when parked, else the end of its arc.
    function anchorNode(v) { return v.lane >= 0 ? arcs[v.route[v.ri]].to : v.node; }

    // ------------------------------------------------------------------ routing helpers
    const bannedArcs = new Uint8Array(router.arcCount);
    let bannedCount = 0;
    function routeAvoiding(from, to, mode, passTag = 0) {
      if (from === to) return { from, to, arcs: [], time: 0, length: 0 };
      const r = stopNode[to] ? router.pathTo(treeFor(to, mode), from) : router.route(from, to, { mode });
      if (!r) return r;
      // The free-flow best route is still the best when it avoids every closure and every
      // congested arc (extra costs are never negative); otherwise search with them.
      let detour = false;
      if (bannedCount) for (const a of r.arcs) if (bannedArcs[a] && motion.closed[a] !== passTag) { detour = true; break; }
      if (!detour && opts.congestionRouting && congestion.pathDelayed(r.arcs)) detour = true;
      if (!detour) return r;
      if (jamEpoch !== congestion.epoch + bannedCount * 1e6) { jamCache.clear(); jamEpoch = congestion.epoch + bannedCount * 1e6; }
      const key = (from * graph.nodes.count + to) * 8 + mode * 2 + (passTag ? 1 : 0);
      if (jamCache.has(key) && !passTag) return jamCache.get(key);
      const extra = opts.congestionRouting ? congestion.extra : null;
      const res = router.search(from, to, { mode, cost: (a) => (bannedArcs[a] && motion.closed[a] !== passTag ? Infinity : extra ? extra[a] : 0) });
      if (!passTag) { if (jamCache.size > 4000) jamCache.clear(); jamCache.set(key, res); }
      return res;
    }
    // Congestion-aware routes, valid until the next congestion update or closure change.
    const jamCache = new Map();
    let jamEpoch = -1;
    // Almost every trip ends at a stop: a place, a depot, the emergency base or a portal where
    // visitors leave (about 300 nodes). One backward route tree per stop, built on first use
    // (about 1 ms and 43 KB each), answers every route into it from anywhere, so dispatch, ride
    // sharing and private traffic rarely run a point-to-point search.
    const stopNode = new Uint8Array(graph.nodes.count);
    const trees = new Map();
    function treeFor(node, mode) {
      const key = node * 4 + mode;
      let tree = trees.get(key);
      if (!tree) { tree = router.treeTo(node, { mode }); trees.set(key, tree); }
      return tree;
    }
    // Fastest-route length for ride-sharing comparisons; null if there is no legal route.
    function routeLength(a, b, mode) {
      if (bannedCount || !stopNode[b]) { const r = routeAvoiding(a, b, mode); return r ? r.length : null; }
      const l = treeFor(b, mode).length[a];
      return l < Infinity ? l : null;
    }

    // Arcs to drive from where the vehicle is now to `node`, or null if there is no legal way.
    function routeFrom(v, node) {
      if (v.lane >= 0) {
        const cur = v.route[v.ri];
        const tail = routeAvoiding(arcs[cur].to, node, v.mode, v.passTag || 0);
        if (!tail) return null;
        return { arcs: [cur, ...tail.arcs], length: motion.len[cur] - v.s + tail.length };
      }
      const r = routeAvoiding(v.node, node, v.mode, v.passTag || 0);
      return r ? { arcs: r.arcs, length: r.length } : null;
    }
    // Start driving to `node`. Arrival is handled by onArrive, immediately if already there.
    function driveTo(v, node) {
      const r = routeFrom(v, node);
      if (!r) return false;
      v.target = node;
      if (!r.arcs.length) { motion.setRoute(v, []); onArrive(v); return true; }
      motion.setRoute(v, r.arcs);
      return true;
    }

    // ------------------------------------------------------------------ dispatch (source dispatch)
    // Nearest idle vehicle of a kind to a node, by straight-line distance. During dispatch the
    // idle vehicles are listed once, so a long queue with no free vehicles costs little.
    let idleList = null;
    function findIdle(kind, node) {
      let best = null, bd = Infinity;
      for (const v of idleList || S.vehicles) {
        if (v.kind !== kind || v.state !== "idle" || v.retiring) continue;
        const d = dist(anchorNode(v), node);
        if (d < bd) { bd = d; best = v; }
      }
      return best;
    }
    // Greedy nearest-neighbour visiting order over nodes.
    function nearestOrder(start, nodes) {
      const rest = nodes.slice(), order = [];
      let cur = start;
      while (rest.length) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < rest.length; i++) { const d = dist(cur, rest[i]); if (d < bd) { bd = d; bi = i; } }
        cur = rest.splice(bi, 1)[0];
        order.push(cur);
      }
      return order;
    }

    // Board riders grouped by pickup (nearest-neighbour order), then alight them grouped by
    // destination, as in the source. Used for singles, carpools, pools and sweeps alike.
    function assignMultiStop(v, reqs, tag) {
      const pickups = new Map(), drops = new Map();
      for (const r of reqs) {
        if (!pickups.has(r.pickup)) pickups.set(r.pickup, []);
        pickups.get(r.pickup).push(r);
        if (!drops.has(r.dropoff)) drops.set(r.dropoff, []);
        drops.get(r.dropoff).push(r);
      }
      const start = anchorNode(v);
      const pickupOrder = nearestOrder(start, [...pickups.keys()]);
      const dropOrder = nearestOrder(pickupOrder[pickupOrder.length - 1], [...drops.keys()]);
      const segments = [];
      let cursor = start;
      for (const node of pickupOrder) {
        if (!routeAvoiding(cursor, node, v.mode)) return false;
        segments.push({ type: "pickup", node, reqs: pickups.get(node) });
        cursor = node;
      }
      for (const node of dropOrder) {
        if (!routeAvoiding(cursor, node, v.mode)) return false;
        segments.push({ type: "dropoff", node, reqs: drops.get(node) });
        cursor = node;
      }
      v.sharingDetour = 0;
      v.pickupQueue = reqs.slice();
      v.riders = [];
      v.segments = segments;
      log(tag === "POOL" || tag === "SWEEP" ? "POOL" : "DISPATCH",
        `${v.id} ${tag} · ${reqs.length} rider${reqs.length === 1 ? "" : "s"} · ${pickupOrder.length} pickup${pickupOrder.length === 1 ? "" : "s"} → ${dropOrder.length} stop${dropOrder.length === 1 ? "" : "s"}`);
      startNextSegment(v);
      return true;
    }
    function startNextSegment(v) {
      const seg = v.segments.shift() || null;
      v.active = seg;
      if (!seg) return finishTrip(v);
      v.state = seg.type === "depot" ? "returning" : seg.type === "pickup" ? "enroute_pickup" : "enroute_dropoff";
      if (!driveTo(v, seg.node)) strand(v, seg.node);
    }
    // No legal way to the next stop right now (closures): stop at the end of this block and retry.
    function strand(v, node) {
      if (v.lane >= 0) motion.setRoute(v, [v.route[v.ri]]);
      v.state = "stranded"; v.strandedNode = node;
    }

    function dispatch() {
      if (!S.queue.length) return;
      idleList = S.vehicles.filter((v) => v.state === "idle" && !v.retiring && FLEET_KINDS.includes(v.kind));
      if (idleList.length) assignAll();
      idleList = null;
    }
    function assignAll() {
      const done = new Set();
      const pending = () => S.queue.filter((r) => !done.has(r.id));
      const groupBy = (keyFn) => {
        const m = new Map();
        for (const r of pending()) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
        return m;
      };
      // A — origin sweeps under heavy backlog: a bus (or shuttle) collects the busiest origin.
      while (S.queue.length - done.size >= SURGE_QUEUE) {
        let best = null;
        for (const [, reqs] of groupBy((r) => r.pickup)) if (reqs.length >= SWEEP_MIN && (!best || reqs.length > best.length)) best = reqs;
        if (!best) break;
        const v = (best.length > CAPACITY.shuttle && findIdle("bus", best[0].pickup)) || findIdle("shuttle", best[0].pickup) || findIdle("bus", best[0].pickup);
        if (!v) break;
        const group = best.slice(0, v.capacity);
        if (!assignMultiStop(v, group, "SWEEP")) break;
        for (const r of group) done.add(r.id);
        S.pooled += group.length;
      }
      // B — sedan carpools: 2–4 riders with the same pickup and destination.
      for (const [, reqs] of groupBy((r) => r.pickup + ">" + r.dropoff)) {
        let rest = reqs.filter((r) => !done.has(r.id));
        while (rest.length >= 2) {
          const v = findIdle("sedan", rest[0].pickup);
          if (!v) break;
          const group = rest.slice(0, v.capacity);
          if (!assignMultiStop(v, group, "SEDAN")) break;
          for (const r of group) done.add(r.id);
          S.pooled += group.length;
          rest = rest.filter((r) => !done.has(r.id));
        }
      }
      // C — pools: 2+ riders to the same destination within the pooling window; a bus when
      // more riders than a shuttle seats.
      for (const [, reqs] of groupBy((r) => r.dropoff)) {
        const poolable = reqs.filter((r) => !done.has(r.id) && S.t - r.requestedAt < POOL_WINDOW);
        if (poolable.length < 2) continue;
        const v = (poolable.length > CAPACITY.shuttle && findIdle("bus", poolable[0].pickup)) || findIdle("shuttle", poolable[0].pickup);
        if (!v) continue;
        const group = poolable.slice(0, v.capacity);
        if (assignMultiStop(v, group, "POOL")) {
          for (const r of group) done.add(r.id);
          S.pooled += group.length;
        }
      }
      // D — singles: one rider per vehicle, sedan first.
      for (const r of pending()) {
        const v = findIdle("sedan", r.pickup) || findIdle("shuttle", r.pickup);
        if (!v) break;
        if (assignMultiStop(v, [r], "SINGLE")) done.add(r.id);
      }
      if (done.size) S.queue = S.queue.filter((r) => !done.has(r.id));
    }

    function sendToDepot(v) {
      const d = nearestDepot(v);
      v.depot = d;
      v.active = null; v.segments = [];
      v.state = "returning";
      if (!driveTo(v, d.node)) { v.state = "idle"; v.idleSince = S.t; }
    }
    // Idle vehicles that linger away from a depot drive to the nearest one (source returnIdleCars).
    function returnIdle() {
      for (const v of S.vehicles.slice()) {
        if (v.state !== "idle" || !FLEET_KINDS.includes(v.kind) || atDepot(v)) continue;
        if (S.t - v.idleSince < IDLE_RETURN && !v.retiring) continue;
        sendToDepot(v);
      }
    }

    // ------------------------------------------------------------------ ride sharing (source tryShareRide)
    function sharingStops(v) {
      const d = nearestDepot(v);
      if (v.state === "idle" || v.state === "returning") return [{ type: "depot", node: d.node, reqs: [] }];
      const stops = [v.active, ...v.segments].filter(Boolean).map((s) => ({ type: s.type, node: s.node, reqs: s.reqs }));
      if (stops.length && stops[stops.length - 1].type !== "depot") stops.push({ type: "depot", node: d.node, reqs: [] });
      return stops;
    }
    function sharingCapacity(v, stops) {
      let load = v.riders.length;
      for (const s of stops) {
        if (s.type === "pickup") load += s.reqs.length;
        if (s.type === "dropoff") load -= s.reqs.length;
        if (load < 0 || load > v.capacity) return false;
      }
      return load === 0;
    }
    function tryShareRide(v) {
      if (!settings.rideSharing || !S.queue.length || v.retiring || (v.kind !== "bus" && v.kind !== "shuttle")) return false;
      if (!["idle", "returning", "enroute_pickup", "enroute_dropoff"].includes(v.state)) return false;
      if (v.state === "idle" && atDepot(v)) return false;
      const anchor = anchorNode(v);
      const stops = sharingStops(v);
      // Trip-wide budget, so repeated admissions cannot pile up detours (source: 4 blocks).
      const allowance = SHARE_BUDGET * settings.rideSharing / 100 - v.sharingDetour;
      if (allowance < 0) return false;
      const points = [anchor, ...stops.map((s) => s.node)];
      if (v.lane >= 0) for (let i = v.ri + 1; i < v.route.length; i += 4) points.push(arcs[v.route[i]].to);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of points) { x0 = Math.min(x0, nx[p]); x1 = Math.max(x1, nx[p]); y0 = Math.min(y0, ny[p]); y1 = Math.max(y1, ny[p]); }
      x0 -= allowance; y0 -= allowance; x1 += allowance; y1 += allowance;
      const proximity = (r) => {
        const x = nx[r.pickup], y = ny[r.pickup];
        if (x < x0 || x > x1 || y < y0 || y > y1) return Infinity;
        let m = Infinity;
        for (const p of points) { const d = dist(r.pickup, p); if (d < m) m = d; }
        return m;
      };
      const candidates = S.queue.map((r) => ({ r, near: proximity(r) }))
        .filter((c) => c.near <= allowance)
        .sort((a, b) => a.near - b.near || a.r.requestedAt - b.r.requestedAt).slice(0, 12);
      if (!candidates.length) return false;
      const legLength = (a, b) => routeLength(a, b, v.mode);
      const legs = [];
      let cursor = anchor, baseDistance = 0;
      for (const s of stops) {
        // The first leg is what is left of the route being driven, when it goes there.
        const l = !legs.length && v.lane >= 0 && v.target === s.node ? routeRest(v) : legLength(cursor, s.node);
        if (l == null) return false;
        legs.push(l); baseDistance += l; cursor = s.node;
      }
      const last = stops[stops.length - 1].type === "depot" ? stops.length - 1 : stops.length;
      const slots = [...new Set([...Array.from({ length: Math.min(last + 1, 6) }, (_, i) => i), last])];
      const nodeAt = (i) => (i === 0 ? anchor : stops[i - 1].node);   // stop before slot i
      const after = (i) => (i < stops.length ? stops[i].node : null);  // stop at slot i
      for (const { r } of candidates) {
        // Straight-line lower bound on the added distance for each insertion (real legs are never
        // shorter than the straight line), then branch and bound: evaluate the most promising
        // insertions first and stop once no remaining one can beat the best found.
        const combos = [];
        for (const pi of slots) for (const di of slots) {
          if (di < pi) continue;
          let lb;
          if (pi === di) {
            const b = after(pi);
            lb = dist(nodeAt(pi), r.pickup) + dist(r.pickup, r.dropoff) + (b != null ? dist(r.dropoff, b) - legs[pi] : 0);
          } else {
            const b = after(pi), d = after(di);
            lb = dist(nodeAt(pi), r.pickup) + (b != null ? dist(r.pickup, b) - legs[pi] : 0) +
                 dist(nodeAt(di), r.dropoff) + (d != null ? dist(r.dropoff, d) - legs[di] : 0);
          }
          if (lb <= allowance + 1e-7) combos.push({ pi, di, lb });
        }
        combos.sort((a, b) => a.lb - b.lb || a.pi - b.pi || a.di - b.di);
        let best = null;
        for (const { pi, di, lb } of combos) {
          if (best && baseDistance + lb >= best.total) break;
          const list = stops.slice();
          list.splice(di, 0, { type: "dropoff", node: r.dropoff, reqs: [r] });
          list.splice(pi, 0, { type: "pickup", node: r.pickup, reqs: [r] });
          if (!sharingCapacity(v, list)) continue;
          // Leg lengths; legs between two original stops that stay adjacent are reused.
          let c = anchor, prevOrig = 0, oi = 0, total = 0, ok = true;
          const lens = [];
          for (const st of list) {
            const orig = st === stops[oi];
            const l = orig && prevOrig === oi ? legs[oi] : legLength(c, st.node);
            if (l == null) { ok = false; break; }
            lens.push(l); total += l; c = st.node;
            if (orig) { oi++; prevOrig = oi; } else prevOrig = -1;
          }
          if (!ok) continue;
          const extra = Math.max(0, total - baseDistance);
          if (extra > allowance + 1e-7) continue;
          // Limit travel added before each promised stop too: a later saving must not hide a
          // long detour imposed on a passenger already aboard.
          let proposed = 0, original = 0, valid = true;
          oi = 0;
          for (let i = 0; i < list.length; i++) {
            proposed += lens[i];
            if (list[i] !== stops[oi]) continue;
            original += legs[oi++];
            if (proposed - original > allowance + 1e-7) { valid = false; break; }
          }
          if (!valid) continue;
          if (!best || total < best.total) best = { list, total, extra };
        }
        if (!best) continue;
        v.pickupQueue.push(r);
        v.segments = best.list.map((s) => ({ type: s.type, node: s.node, reqs: s.reqs }));
        v.sharingDetour += best.extra;
        S.queue.splice(S.queue.indexOf(r), 1);
        S.sharedPickups++; S.pooled++;
        log("POOL", `${v.id} on-the-way pickup r#${r.id} at ${r.from.name} → ${r.to.name} · +${Math.round(best.extra)} m · sharing ${settings.rideSharing}%`);
        startNextSegment(v);
        return true;
      }
      return false;
    }
    // Length of a vehicle's route beyond the arc it is on.
    function routeRest(v) {
      let l = 0;
      for (let i = v.ri + 1; i < v.route.length; i++) l += motion.len[v.route[i]];
      return l;
    }
    function shareQueuedRides() {
      if (!settings.rideSharing || !S.queue.length) return;
      const fleet = S.vehicles.filter((v) => (v.kind === "bus" || v.kind === "shuttle") && !v.retiring);
      // Bounded work per step, rotating through the fleet (source: four vehicles per tick).
      for (let i = 0; i < Math.min(4, fleet.length); i++) tryShareRide(fleet[(S.sharingCursor + i) % fleet.length]);
      S.sharingCursor = fleet.length ? (S.sharingCursor + 4) % fleet.length : 0;
    }

    // ------------------------------------------------------------------ arrivals and boarding
    function onArrive(v) {
      if (v.kind === "private") return arrivePrivate(v);
      if (RESPONDERS.includes(v.kind)) return arriveResponder(v);
      if (v.kind === "recovery" && v.state === "recovery_outbound") return arriveRecovery(v);
      if (v.troublePending && v.riders.length) return stall(v);
      v.troublePending = false;
      if (v.state === "stranded" || v.state === "trouble" || v.state === "repair") return;
      if (v.state === "idle") { v.idleSince = S.t; return; }
      // Pulled over short of the stop (a breakdown check or replan cut the route): keep going.
      const goal = v.active ? v.active.node : v.state === "returning" && v.depot ? v.depot.node : v.node;
      if (v.node !== goal) { if (!driveTo(v, goal)) strand(v, goal); return; }
      if (v.state === "returning" && (!v.active || v.active.type === "depot")) {
        if (v.active) return finishTrip(v);
        if (v.retiring || v.kind === "recovery") return removeVehicle(v);
        v.state = "idle"; v.idleSince = S.t;
        return;
      }
      const seg = v.active;
      if (!seg) return finishTrip(v);
      if (seg.type === "pickup") {
        // One passenger boards per step; the waiting count ticks down as riders climb aboard.
        v.boarding = seg.reqs.filter((r) => v.pickupQueue.includes(r) && !v.riders.includes(r));
        v.state = "boarding";
        return;
      }
      if (seg.type === "dropoff") {
        let n = 0;
        for (const r of seg.reqs) {
          const i = v.riders.indexOf(r);
          if (i < 0) continue;
          v.riders.splice(i, 1);
          if (completePassenger(r)) n++;
        }
        if (n) log("DROPOFF", `${v.id} dropped off ${n} rider${n === 1 ? "" : "s"} at ${seg.reqs[0].to.name}`);
        return startNextSegment(v);
      }
      if (seg.type === "depot") return finishTrip(v);
    }
    function tickBoarding() {
      for (const v of S.vehicles.slice()) {
        if (v.state !== "boarding") continue;
        if (v.boarding && v.boarding.length) {
          const r = v.boarding.shift();
          boardPassenger(r);
          v.riders.push(r);
          const qi = v.pickupQueue.indexOf(r);
          if (qi >= 0) v.pickupQueue.splice(qi, 1);
          log("PICKUP", `${v.id} boarded r#${r.id} at ${r.from.name} (aboard ${v.riders.length}/${v.capacity})`);
        } else {
          v.boarding = null;
          startNextSegment(v);
        }
      }
    }
    function finishTrip(v) {
      let n = 0;
      for (const r of v.riders) if (completePassenger(r)) n++;
      if (n) log("DROPOFF", `${v.id} dropped off ${n} remaining rider${n === 1 ? "" : "s"}`);
      for (const r of v.pickupQueue) if (r.pickedUpAt == null && !S.queue.includes(r)) S.queue.push(r);
      v.riders = []; v.pickupQueue = []; v.segments = []; v.active = null; v.boarding = null;
      v.sharingDetour = 0; v.troublePending = false;
      if (v.lane >= 0) motion.setRoute(v, [v.route[v.ri]]);   // pull over at the end of this block
      v.state = "idle"; v.idleSince = S.t;
      if (v.retiring) sendToDepot(v);
    }

    // ------------------------------------------------------------------ private traffic
    // Morning peak shape: a bell centred on 08:00 (standard deviation 35 minutes).
    const amPeak = (minute) => Math.exp(-0.5 * ((minute - 480) / 35) ** 2);
    function pickWeighted(list, cum) {
      const x = rng() * cum[cum.length - 1];
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] > x) hi = m; else lo = m + 1; }
      return list[lo];
    }
    function spawnLocal() {
      if (!localEntries.length) return null;
      // In the morning most visitors are commuters bound for a job or school, staying all day.
      const commuter = rng() < 0.9 * amPeak(S.minute);
      const targets = commuter ? S.byType.employer.concat(S.byType.employer, S.byType.school) : S.places;
      for (let attempt = 0; attempt < 8; attempt++) {
        const from = pickWeighted(localEntries, entryWeight), to = pick(targets);
        if (portalBusy(from)) continue;
        const r = routeAvoiding(from, to.node, MODE_GENERAL);
        if (!r || !r.arcs.length) continue;
        const v = makeVehicle("private", from, { state: "private_in", destination: to, commuter, pcu: opts.trafficScale });
        motion.setRoute(v, r.arcs);
        S.atPortal.push(v);
        return v;
      }
      return null;
    }
    function spawnThrough() {
      if (!throughRoutes.length) return null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = pickWeighted(throughRoutes, throughWeight);
        if (portalBusy(r.from)) continue;
        const v = makeVehicle("private", r.from, { state: "private_through", through: true, pcu: opts.trafficScale });
        motion.setRoute(v, r.arcs);
        S.atPortal.push(v);
        return v;
      }
      return null;
    }
    // A portal already holding a car that has not yet found room to enter takes no more.
    function portalBusy(node) {
      if (S.atPortal.length > 32) S.atPortal = S.atPortal.filter((v) => v.lane < 0 && v.route && !v.removed);
      for (const v of S.atPortal) if (v.lane < 0 && v.route && !v.removed && v.node === node) return true;
      return false;
    }
    function arrivePrivate(v) {
      if (v.state === "private_through" || v.state === "private_out") return removeVehicle(v);
      // Visitors park off-street for a while, then leave the area.
      v.state = "private_parked";
      // Commuters leave between 16:15 and 18:45; other visitors after 5 to 60 minutes.
      const stay = v.commuter ? Math.max(60, 16.25 * 60 + rng() * 150 - S.minute) : 5 + rng() * 55;
      v.departAt = S.t + stay * 60;
      // Parked cars leave the vehicle list (thousands by mid-morning) for a queue by departure.
      const i = S.vehicles.indexOf(v);
      if (i >= 0) S.vehicles.splice(i, 1);
      let lo = 0, hi = S.parked.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (S.parked[m].departAt <= v.departAt) lo = m + 1; else hi = m; }
      S.parked.splice(lo, 0, v);
    }
    function tickPrivateTraffic() {
      const rate = settings.privateTraffic, peak = amPeak(S.minute);
      const agents = rate / opts.trafficScale * STEP / 3600;
      S.localCredit = Math.min(4, S.localCredit + agents * opts.localPerHour * (1 + opts.amPeak * peak));
      while (S.localCredit >= 1) { S.localCredit -= 1; spawnLocal(); }
      S.throughCredit = Math.min(4, S.throughCredit + agents * opts.throughPerHour * (1 + opts.throughPeak * peak));
      while (S.throughCredit >= 1) { S.throughCredit -= 1; spawnThrough(); }
      while (S.parked.length && S.parked[0].departAt <= S.t) {
        const v = S.parked.shift();
        const exit = localExits.length ? pickWeighted(localExits, exitWeight) : null;
        const r = exit != null ? routeAvoiding(v.node, exit, MODE_GENERAL) : null;
        if (!r || !r.arcs.length) { v.removed = true; continue; }
        v.state = "private_out";
        S.vehicles.push(v);
        motion.setRoute(v, r.arcs);
      }
    }

    // ------------------------------------------------------------------ emergencies (source)
    function close(arc, incident, until) {
      const prev = S.closures.get(arc);
      if (prev && prev.until >= until) return;
      if (!prev) { bannedArcs[arc] = 1; bannedCount++; }
      S.closures.set(arc, { arc, until, incident: incident.id });
      motion.setClosed(arc, incident.id);
    }
    function reopen(arc) {
      if (!S.closures.has(arc)) return;
      S.closures.delete(arc);
      bannedArcs[arc] = 0; bannedCount--;
      motion.setClosed(arc, 0);
      log("TRAFFIC", `Emergency closure lifted on ${arcs[arc].link.name || "unnamed street"}`);
    }
    function triggerEmergency(kind = rng() < 0.7 ? "police" : "fire", target = null) {
      const sites = S.places.filter((p) => p.type !== "station");
      target = target || pick(sites);
      const incident = { id: S.nextIncident++, kind, target, responders: [], finished: false, startedAt: S.t };
      S.incidents.push(incident);
      const kinds = kind === "police" ? ["police"] : ["fire", "fire", "firecar", "firecar"];
      for (const k of kinds) {
        const v = makeVehicle(k, S.base.node, { incident, passTag: incident.id, state: "emergency_outbound" });
        incident.responders.push(v);
        if (!driveTo(v, target.node)) v.state = "emergency_wait";
      }
      log("EMERGENCY", `${kind.toUpperCase()} #${incident.id} dispatched to ${target.name} · ${kinds.length} vehicle${kinds.length > 1 ? "s" : ""}`);
      return incident;
    }
    function arriveResponder(v) {
      const incident = v.incident;
      if (v.state === "emergency_outbound") {
        v.state = "emergency_scene";
        v.sceneUntil = S.t + (incident.kind === "police" ? 5 : 10) * 60;
        // Block the direction the responder arrived from, for the scene time.
        if (v.lastArc != null && v.lastArc >= 0) close(v.lastArc, incident, v.sceneUntil);
        log("EMERGENCY", `${v.id} on scene at ${incident.target.name} · arrival direction closed ${incident.kind === "police" ? 5 : 10} min`);
        return;
      }
      if (v.state === "emergency_return") {
        v.state = "response_done";
        removeVehicle(v);
        if (incident.responders.every((r) => r.state === "response_done")) {
          incident.finished = true;
          log("EMERGENCY", `${incident.kind.toUpperCase()} #${incident.id} complete`);
        }
      }
    }
    function tickEmergencies() {
      for (const [arc, c] of [...S.closures]) if (c.until <= S.t) reopen(arc);
      for (const v of S.vehicles.slice()) {
        if (v.state === "emergency_scene" && S.t >= v.sceneUntil) {
          v.state = "emergency_return";
          if (!driveTo(v, S.base.node)) v.state = "emergency_return_wait";
          else log("EMERGENCY", `${v.id} leaving scene for ${S.base.name}`);
        } else if (v.state === "emergency_wait" && driveTo(v, v.incident.target.node)) {
          v.state = "emergency_outbound";
        } else if (v.state === "emergency_return_wait") {
          v.state = "emergency_return";
          if (!driveTo(v, S.base.node)) v.state = "emergency_return_wait";
        } else if (v.state === "repair" && S.t >= v.repairUntil) {
          log("RECOVERY", `${v.id} repaired · returning to depot`);
          v.state = "idle"; v.idleSince = S.t;
          sendToDepot(v);
        } else if (v.state === "recovery_wait") {
          planRecoveryDrops(v);
        } else if (v.state === "stranded" && driveTo(v, v.strandedNode)) {
          v.state = v.active?.type === "pickup" ? "enroute_pickup" : v.active?.type === "depot" ? "returning" : "enroute_dropoff";
        }
      }
      for (let i = S.incidents.length - 1; i >= 0; i--) if (S.incidents[i].finished) S.incidents.splice(i, 1);
    }
    function tickRareEvents() {
      if (!opts.rareEvents) return;
      if (S.t >= S.nextPolice) { triggerEmergency("police"); S.nextPolice = rareAfter(180 * 60); }
      if (S.t >= S.nextFire) { triggerEmergency("fire"); S.nextFire = rareAfter(600 * 60); }
      if (S.t >= S.nextTrouble) {
        const eligible = S.vehicles.filter((v) => FLEET_KINDS.includes(v.kind) && !v.retiring && v.riders.length && v.lane >= 0 &&
          (v.state === "enroute_pickup" || v.state === "enroute_dropoff"));
        if (eligible.length) breakdown(pick(eligible));
        S.nextTrouble = rareAfter(480 * 60);
      }
    }
    // Vehicle trouble: pull over at the end of the current block; a recovery vehicle collects
    // the riders, keeping their boarding times and destinations.
    function breakdown(v) {
      v.troublePending = true;
      if (v.lane >= 0) motion.setRoute(v, [v.route[v.ri]]);
      log("BREAKDOWN", `${v.id} detects vehicle trouble · pulling over at the next intersection`);
    }
    function stall(v) {
      v.troublePending = false;
      for (const r of v.pickupQueue) if (!v.riders.includes(r) && r.pickedUpAt == null) S.queue.push(r);
      v.pickupQueue = []; v.segments = []; v.active = null; v.boarding = null;
      v.state = "trouble";
      const depot = nearestDepot(v);
      const rescue = makeVehicle("recovery", depot.node, { state: "recovery_outbound", rescueTarget: v, depot });
      rescue.capacity = Math.max(rescue.capacity, v.capacity);
      if (!driveTo(rescue, v.node)) rescue.state = "recovery_outbound_wait";
      log("BREAKDOWN", `${v.id} stalled at ${streetName(v.node)} · ${v.riders.length} passengers aboard`);
      log("RECOVERY", `${rescue.id} dispatched from ${depot.name}`);
    }
    function arriveRecovery(v) {
      const stalled = v.rescueTarget;
      v.rescueTarget = null;
      v.riders = stalled.riders.splice(0);
      stalled.state = "repair"; stalled.repairUntil = S.t + 5 * 60;
      log("RECOVERY", `${v.id} took ${v.riders.length} passengers from ${stalled.id}`);
      planRecoveryDrops(v);
    }
    function planRecoveryDrops(v) {
      const drops = new Map();
      for (const r of v.riders) { if (!drops.has(r.dropoff)) drops.set(r.dropoff, []); drops.get(r.dropoff).push(r); }
      let cursor = anchorNode(v);
      v.segments = [];
      for (const node of nearestOrder(cursor, [...drops.keys()])) {
        if (!routeAvoiding(cursor, node, v.mode)) { v.state = "recovery_wait"; return; }
        v.segments.push({ type: "dropoff", node, reqs: drops.get(node) });
        cursor = node;
      }
      v.segments.push({ type: "depot", node: nearestDepot(v).node, reqs: [] });
      v.retiring = true;   // recovery vehicles leave once back at the depot
      startNextSegment(v);
    }
    function retryRecovery() {
      for (const v of S.vehicles) if (v.state === "recovery_outbound_wait" && driveTo(v, v.rescueTarget.node)) v.state = "recovery_outbound";
    }

    // ------------------------------------------------------------------ movement
    const onRoad = [];
    function moveVehicles() {
      onRoad.length = 0;
      for (const v of S.vehicles) if (v.route) onRoad.push(v);
      const arrived = motion.step(onRoad, S.t - STEP, STEP);
      for (const v of arrived) if (!v.removed) onArrive(v);
      for (const v of onRoad) v.queuedFor = v.route && v.waiting === "queue" ? (v.queuedFor || 0) + STEP : 0;
      if (opts.congestionRouting && congestion.congestedArcs) rerouteQueued();
      // Vehicles held at a closure find a way around it.
      for (const v of onRoad) {
        if (v.waiting !== "closed" || v.removed || !v.route) continue;
        const dest = arcs[v.route[v.route.length - 1]].to;
        const r = routeFrom(v, dest);
        if (r && r.arcs.length) { motion.setRoute(v, r.arcs); log("REPLAN", `${v.id} detouring around a closure`); }
      }
    }

    // Drivers stuck in a queue for a minute, with real congestion still ahead, look for a faster
    // way to where they are going: up to four per step (longest wait first), at most every two
    // minutes each (five after finding nothing better). Freeway through-traffic
    // and responders keep their routes.
    function rerouteQueued() {
      const cands = [];
      for (const v of onRoad) {
        if (v.queuedFor < 60 || v.removed || !v.route || v.lane < 0 || v.through || v.incident || v.ri >= v.route.length - 1) continue;
        if (S.t < (v.rerouteAfter ?? 0)) continue;
        cands.push(v);
      }
      cands.sort((a, b) => b.queuedFor - a.queuedFor);
      let tries = 0;
      for (const v of cands) {
        if (tries >= 4) break;
        v.rerouteAfter = S.t + 300;   // look again in five minutes unless a better way turns up
        // Worth a search only if the rest of the route runs into real congestion.
        if (!congestion.pathDelayed(v.route.slice(v.ri + 1))) continue;
        tries++;
        const dest = arcs[v.route[v.route.length - 1]].to;
        const cur = congestion.routeTime(v.route, v.ri + 1);
        const alt = routeFrom(v, dest);
        if (!alt || alt.arcs.length < 2) continue;
        const altTime = congestion.routeTime(alt.arcs, 1);
        if (altTime < cur * 0.85 && cur - altTime > 30) {
          v.rerouteAfter = S.t + 120;
          motion.setRoute(v, alt.arcs);
          S.reroutes++;
          log("REPLAN", `${v.id} leaves a queue on ${arcs[v.route[0]].link.name || "an unnamed street"} · saves about ${Math.round((cur - altTime) / 60)} min`);
        }
      }
    }

    // ------------------------------------------------------------------ step
    function step() {
      advanceClock();
      checkSchedules();
      tickPrivateTraffic();
      tickRareEvents();
      tickEmergencies();
      retryRecovery();
      tickBoarding();
      shareQueuedRides();
      dispatch();
      returnIdle();
      moveVehicles();
      if (S.t % congestion.PERIOD === 0) congestion.update(S.t, S.vehicles);
      if (Math.round(S.t / STEP) % 20 === 0) sample();
    }
    function run(n) { for (let i = 0; i < n; i++) step(); }

    function counts() {
      const c = { onRoad: 0, queued: 0, atSignal: 0, fleetBusy: 0, fleetIdle: 0, private: 0, through: 0, responders: 0, parked: 0, privateCars: 0, byKind: {} };
      for (const v of S.vehicles) {
        c.byKind[v.kind] = (c.byKind[v.kind] || 0) + 1;
        if (v.lane >= 0) {
          c.onRoad++;
          if (v.waiting === "queue") c.queued++;
          else if (v.waiting === "signal" || v.waiting === "stop") c.atSignal++;
        }
        if (FLEET_KINDS.includes(v.kind)) { if (v.state === "idle") c.fleetIdle++; else c.fleetBusy++; }
        else if (v.kind === "private") {
          if (v.through) c.through++; else c.private++;
          if (v.lane >= 0) c.privateCars += v.pcu;
        }
        else c.responders++;
      }
      c.parked = S.parked.length;
      return c;
    }
    function sample() {
      const c = counts();
      S.history.push({ t: S.t, minute: S.minute, w: currentQueueWaitMinutes(), q: S.queue.length, onRoad: c.onRoad, queued: c.queued });
      if (S.history.length > 240) S.history.splice(0, S.history.length - 240);
    }

    // Consistency audit for tests: motion bookkeeping plus engine-level invariants.
    function audit() {
      const problems = motion.check(S.vehicles);
      for (const v of S.vehicles) {
        if (v.riders.length > v.capacity) problems.push(`${v.id}: ${v.riders.length} riders, capacity ${v.capacity}`);
        if (v.route) {
          try { motion.checkRoute(v, v.route); } catch (e) { problems.push(e.message); }
        }
        if (v.lane >= 0 && !Number.isFinite(v.s)) problems.push(`${v.id}: bad position`);
      }
      return problems;
    }

    // Remaining route as a polyline from the vehicle's current position, for drawing.
    function remainingPoints(v) {
      if (!v.route) return [];
      const out = [];
      const p = motion.locate(v, 0);
      if (p) out.push(p.x, p.y);
      for (let i = v.ri; i < v.route.length; i++) {
        const arc = arcs[v.route[i]], pts = arc.link.pts, m = pts.length / 2;
        for (let k = 1; k < m; k++) {
          const idx = arc.forward ? k : m - 1 - k;
          if (i === v.ri) {
            // Skip shape points already passed on the current arc.
            const along = arc.forward ? k : m - 1 - k;
            if (cumulative(arc.link, along, arc.forward) <= v.s) continue;
          }
          out.push(pts[idx * 2], pts[idx * 2 + 1]);
        }
      }
      return out;
    }
    function cumulative(link, k, forward) {
      const p = link.pts;
      let d = 0;
      for (let i = 0; i < k; i++) d += Math.hypot(p[i * 2 + 2] - p[i * 2], p[i * 2 + 3] - p[i * 2 + 1]);
      return forward ? d : link.len - d;
    }

    function snapshot() {
      return JSON.stringify({
        t: S.t, minute: S.minute, completed: S.completed, ride: S.rideSeconds, pooled: S.pooled, shared: S.sharedPickups,
        queue: S.queue.map((r) => r.id),
        vehicles: S.vehicles.map((v) => [v.id, v.state, v.route ? v.route.length : -1, v.ri, Math.round(v.s * 1000), v.lane, v.node,
          v.riders.map((r) => r.id), v.pickupQueue.map((r) => r.id)]),
        closures: [...S.closures.keys()], parked: S.parked.map((v) => v.id),
      });
    }

    function reset() {
      for (const v of S.vehicles.slice()) removeVehicle(v);
      for (const arc of [...S.closures.keys()]) { bannedArcs[arc] = 0; motion.setClosed(arc, 0); }
      bannedCount = 0;
      congestion.reset();
      freshState();
      log("RESET", "Day reset");
    }

    freshState();

    return {
      graph, router, signals, motion, congestion, core, settings,
      chokepoints: (top) => congestion.chokepoints(S.vehicles, top),
      get state() { return S; },
      step, run, reset,
      setPopulation, setFleet, triggerEmergency, breakdown, addRequest,
      setRideSharing(p) { settings.rideSharing = Math.max(0, Math.min(100, p)); },
      setPrivateTraffic(x) { settings.privateTraffic = Math.max(0, x); },
      averageQueueMinutes, currentQueueWaitMinutes, counts, audit, snapshot, remainingPoints,
      locate: (v) => motion.locate(v),
      dispatch, tryShareRide, assignMultiStop, routeAvoiding,
      portals: { entries, exits, freewayIn, freewayOut, throughRoutes, localEntries, localExits },
      countFleet, clock() { const m = Math.floor(S.minute); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; },
    };
  }

  const api = { createSim, DEFAULTS, STEP, DAY_START, CAPACITY, FLEET_KINDS, mulberry32 };
  if (isNode) module.exports = api;
  else root.MplsSim = api;
})(typeof window !== "undefined" ? window : globalThis);
