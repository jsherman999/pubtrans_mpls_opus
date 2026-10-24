// Daily travel demand from data/mpls_demand.js (Census blocks and LEHD LODES, built by
// tools/build_demand.py). No dependencies, no DOM, no Math.random: a day is reproducible from
// its seed. generate() returns the day's person trips at full scale as counts per purpose and
// hour, plus a time-ordered list of sampled agent trips (1 agent : `sampling` people). Mode
// shares, presence and timing are calibrated to public counts (PLAN.md, Phase 10).
//
// A trip runs between two locations: { zone: i } (a census block inside the study area) or
// { sector: k } (outside the area, in compass sector k of 16, clockwise from north, as seen
// from the area's centre). Modes: "walk" (short trips inside the area; counted, not
// simulated: short trips, and longer ones walked or cycled today), "shuttle" (transit today: an
// SDEV ride request) and "drive" (private car, carpools included).
//
// Generators (all at full scale, then sampled):
//   commuters    LODES home-to-work flows: inside the area (internalOD), arriving from outside
//                (inbound, by home direction) and leaving it (outbound); presence by sector of
//                work and day of week (hybrid office work); start times by sector, shift
//                changes for health-care jobs at the hospitals
//   students     University of Minnesota attendance on the Minneapolis campus, living inside or
//                arriving from outside, timed to the class schedule; trips between the banks at
//                each class change
//   errands      residents' shopping and eating out, towards retail and food-service jobs
//   visitors     people from outside coming to shop, eat and visit, in proportion to those jobs
//                (errands and visitors are the day's background; `background: false` drops them)
//   events       a game or concert at a venue: arrivals before the start, a surge at the end
(function (root) {
  "use strict";

  const SECTORS = 16;
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  // Share of jobs whose holder comes in that day. Office work is hybrid (downtown runs at 70–75 %
  // of its pre-pandemic workers Tuesday to Thursday, Downtown Council 2025); most other work is not.
  const PRESENCE = {
    office: [0.55, 0.72, 0.72, 0.70, 0.45, 0.08, 0.05],
    other: [0.90, 0.91, 0.91, 0.90, 0.88, 0.55, 0.45],
    edu: [0.85, 0.85, 0.85, 0.83, 0.70, 0.12, 0.06],
  };
  const STUDENT_DAY = [1.0, 1.0, 1.0, 0.95, 0.75, 0.08, 0.05];
  // UMN class start times (classroom.umn.edu): 50-minute classes on Monday, Wednesday and Friday,
  // 75-minute classes on Tuesday and Thursday, 15 minutes between them. Students arrive for their
  // first class (earlier ones more likely) and cross between the banks at each change.
  const CLASSES = {
    mwf: { length: 50, starts: [480, 545, 610, 675, 740, 805, 870, 935, 1000], first: [24, 20, 16, 12, 10, 8, 5, 3, 2] },
    tth: { length: 75, starts: [495, 585, 675, 780, 870, 960], first: [30, 25, 18, 14, 9, 4] },
  };
  const DEFAULTS = {
    sampling: 10,               // people per simulated agent
    day: 2,                     // Wednesday
    seed: 1,
    walkMeters: 800,            // trips inside the area shorter than this are walked
    // Today's modes for trips longer than walkMeters: "active" walks or cycles, "transit" rides
    // transit (what SDEV shuttles replace), the rest drive. Commuters into the area follow ACS 2024
    // (72 % drive alone and 9 % carpool to Minneapolis jobs) with downtown's higher transit use;
    // together they match fall 2025 Metro Transit boardings in the area (PLAN.md, Phase 10).
    modes: {
      inbound: { active: 0.05, transit: { office: 0.16, edu: 0.12, health: 0.10, other: 0.08 } },
      outbound: { active: 0.10, transit: 0.15 },
      students: { active: 0.15, transit: 0.45 },   // arriving from outside the area
      visitors: { active: 0.05, transit: 0.15 },
      events: { active: 0.05, transit: 0.22 },     // Twins and Vikings fans: a fifth to a quarter by rail
      // Inside the area walking and cycling fall off with distance (local()); of the trips left,
      // `transit` ride transit and the rest drive.
      residents: { active: 0.75, transit: 0.35 },
      campus: { active: 0.90, transit: 0.70 },     // students living near campus
    },
    background: true,           // residents' errands and visitors through the day
    errandRate: 0.40,           // errand tours per resident per day
    errandMeters: 1200,         // distance decay of errand destinations
    visitorsPerJob: 1.2,        // visitors per retail or food-service job per day
    classCrossing: 0.04,        // share of attending students changing banks at each class change
    classRide: 0.35,            // of those, the share riding (Campus Connector or Green Line today)
    eventLocal: 0.10,           // share of an event's crowd living inside the area
    events: [{ venue: "Target Field", start: 19 * 60 + 10, attendance: 22000, length: 180 }],
    dayStart: 5 * 60 + 30,      // trips before this are not simulated (people already in place)
  };

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createDemand(raw, base = {}) {
    if (!raw || raw.v !== 1) throw new Error("Unsupported demand format: expected version 1");
    const Z = raw.zones, nz = Z.x.length;
    const zones = Array.from({ length: nz }, (_, i) => ({
      i, x: Z.x[i], y: Z.y[i], pop: Z.pop[i], hu: Z.hu[i], jobs: Z.jobs[i],
      office: Z.office[i], retail: Z.retail[i], food: Z.food[i], health: Z.health[i], edu: Z.edu[i],
      inbound: Z.inbound[i], outbound: Z.outbound[i],
    }));
    const near = (z, site, r) => Math.hypot(z.x - site.x, z.y - site.y) <= r;
    const hospitalZone = zones.map((z) => raw.hospitals.some((h) => near(z, h, h.r)));
    const campusOf = zones.map((z) => raw.campus.findIndex((c) => near(z, c, c.r)));
    const venueByName = new Map(raw.venues.map((v) => [v.name, v]));
    const totalOf = (key) => zones.reduce((s, z) => s + z[key], 0);

    function generate(options = {}) {
      const o = { ...DEFAULTS, ...base, ...options, modes: { ...DEFAULTS.modes, ...(base.modes || {}), ...(options.modes || {}) } };
      const rng = mulberry32(o.seed * 7919 + o.day);
      const N = o.sampling, day = o.day;
      const normal = (mu, sd) => { const u = 1 - rng(), v = rng(); return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
      const pickCum = (cum) => { const x = rng() * cum[cum.length - 1]; let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] > x) hi = m; else lo = m + 1; } return lo; };
      const cumOf = (arr) => { let c = 0; return arr.map((v) => (c += v)); };
      // Agents for a full-scale count: stochastic rounding keeps the expected total exact.
      const agents = (count) => { const a = count / N; const k = Math.floor(a); return k + (rng() < a - k ? 1 : 0); };

      const trips = [];
      const full = {};                                   // person trips by purpose
      const hourly = Array.from({ length: 24 }, () => ({ walk: 0, shuttle: 0, drive: 0 }));
      const count = (purpose, minute, mode, people) => {
        full[purpose] = (full[purpose] || 0) + people;
        const h = Math.floor(minute / 60);
        if (h >= 0 && h < 24) hourly[h][mode] += people;
      };
      const dist = (a, b) => (a.zone != null && b.zone != null ? Math.hypot(zones[a.zone].x - zones[b.zone].x, zones[a.zone].y - zones[b.zone].y) : Infinity);
      // Today's modes inside the area: walking and cycling fall off with distance.
      const local = (from, to, m) => {
        const active = m.active * clamp(1 - (dist(from, to) - 800) / 4000, 0.35, 1);
        return { active, transit: (1 - active) * m.transit };
      };
      // A person's outbound and return legs. Counts every trip at full scale (expected value)
      // and emits sampled agents; both legs of a sampled person are emitted together. `split`
      // gives today's active and transit shares (the rest drive) beyond walking distance.
      function tour(purpose, from, to, leave, back, people, split) {
        const walking = dist(from, to) < o.walkMeters;
        const drive = 1 - split.active - split.transit;
        const k = agents(people);
        for (let j = 0; j < k; j++) {
          const r = rng();
          const mode = walking || r < split.active ? "walk" : r < split.active + drive ? "drive" : "shuttle";
          const t0 = leave(), t1 = back == null ? null : back(t0);
          const tag = Math.floor(rng() * 1e9);   // shared by both legs of the tour
          trips.push({ minute: t0, purpose, from, to, mode, weight: N, tag });
          if (t1 != null && t1 < 24 * 60) trips.push({ minute: t1, purpose, from: to, to: from, mode, weight: N, returning: true, tag });
        }
        // Expected full-scale counts by mode and hour, from the same distributions.
        const share = walking ? { walk: 1, shuttle: 0, drive: 0 } : { walk: split.active, shuttle: split.transit, drive };
        for (const [mode, f] of Object.entries(share)) {
          if (!f) continue;
          const t0 = leave();
          count(purpose, t0, mode, people * f);
          if (back != null) { const t1 = back(t0); if (t1 < 24 * 60) count(purpose, t1, mode, people * f); }
        }
      }

      // Work start time by job type at a zone; returns [leave, back] generators.
      function shift(z, group) {
        if (group === "health" && hospitalZone[z]) {
          const r = rng();
          const start = r < 0.55 ? 7 * 60 : r < 0.85 ? 15 * 60 : 23 * 60;
          return [() => start - clamp(normal(25, 10), 5, 60), (t) => t + 8.5 * 60 + clamp(normal(10, 8), 0, 40)];
        }
        if (group === "office") return [() => clamp(normal(8.25 * 60, 65), 6.25 * 60, 10.75 * 60), (t) => t + clamp(normal(8.6 * 60, 50), 6 * 60, 11 * 60)];
        if (group === "edu") return [() => clamp(normal(8 * 60, 40), 6.5 * 60, 10 * 60), (t) => t + clamp(normal(8.5 * 60, 45), 6 * 60, 10.5 * 60)];
        if (group === "retail") return [() => clamp(7.5 * 60 + rng() * 6 * 60, 7 * 60, 14 * 60), (t) => t + 8 * 60];
        if (group === "food") {
          const r = rng(), mu = r < 0.3 ? 6.5 * 60 : r < 0.7 ? 10 * 60 : 16 * 60;
          return [() => clamp(normal(mu, 40), 5 * 60, 18 * 60), (t) => t + clamp(normal(7.5 * 60, 40), 5 * 60, 10 * 60)];
        }
        return [() => clamp(normal(7.75 * 60, 55), 5.5 * 60, 11 * 60), (t) => t + clamp(normal(8.7 * 60, 45), 6 * 60, 11 * 60)];
      }
      // Split a zone's workers by job type, with that type's presence today.
      function groupsOf(z) {
        const zz = zones[z], other = Math.max(0, zz.jobs - zz.office - zz.retail - zz.food - zz.health - zz.edu);
        const parts = [["office", zz.office, PRESENCE.office[day]], ["retail", zz.retail, PRESENCE.other[day]],
          ["food", zz.food, PRESENCE.other[day]], ["health", zz.health, PRESENCE.other[day]],
          ["edu", zz.edu, PRESENCE.edu[day]], ["other", other, PRESENCE.other[day]]];
        const tot = zz.jobs || 1;
        return parts.filter((p) => p[1] > 0).map(([g, n, pres]) => [g, n / tot, pres]);
      }
      const sectorCum = cumOf(raw.inboundBySector), outCum = cumOf(raw.outboundBySector);

      // Commuters inside the area.
      for (const [h, w, k] of raw.internalOD)
        for (const [g, share, pres] of groupsOf(w)) {
          const [leave, back] = shift(w, g);
          const from = { zone: h }, to = { zone: w };
          tour("work", from, to, leave, back, k * share * pres, local(from, to, o.modes.residents));
        }
      // Commuters from outside, entering from the direction of home.
      for (let w = 0; w < nz; w++) {
        if (!zones[w].inbound) continue;
        for (const [g, share, pres] of groupsOf(w)) {
          const people = zones[w].inbound * share * pres;
          const split = { active: o.modes.inbound.active, transit: o.modes.inbound.transit[g] ?? o.modes.inbound.transit.other };
          // Spread each zone's commuters over home directions by the area-wide distribution.
          for (let s = 0; s < SECTORS; s++) {
            const part = people * raw.inboundBySector[s] / sectorCum[SECTORS - 1];
            if (part <= 0) continue;
            const [leave, back] = shift(w, g);
            tour("work", { sector: s }, { zone: w }, leave, back, part, split);
          }
        }
      }
      // Residents working outside the area.
      const outPres = 0.7 * PRESENCE.office[day] + 0.3 * PRESENCE.other[day];
      for (let hz = 0; hz < nz; hz++) {
        if (!zones[hz].outbound) continue;
        for (let s = 0; s < SECTORS; s++) {
          const part = zones[hz].outbound * outPres * raw.outboundBySector[s] / outCum[SECTORS - 1];
          if (part <= 0) continue;
          tour("work", { zone: hz }, { sector: s }, () => clamp(normal(7.6 * 60, 45), 5.5 * 60, 10 * 60),
            (t) => t + clamp(normal(9.5 * 60, 50), 7 * 60, 12 * 60), part, o.modes.outbound);
        }
      }

      // University of Minnesota students.
      const attending = raw.campusStudents * STUDENT_DAY[day];
      const campusZones = raw.campus.map((c, ci) => zones.filter((z) => campusOf[z.i] === ci && (z.jobs || z.pop)));
      const campusCum = campusZones.map((list) => cumOf(list.map((z) => z.edu + z.jobs * 0.1 + 1)));
      const homesNear = zones.filter((z) => z.pop && raw.campus.some((c) => near(z, c, 1500)));
      const homeCum = cumOf(homesNear.map((z) => z.pop));
      // Students leave home for their first class (from outside the area earlier) and go home
      // after one to three classes and some time on campus.
      const cls = day === 1 || day === 3 ? CLASSES.tth : CLASSES.mwf, firstCum = cumOf(cls.first);
      const studentDay = (lead) => {
        let first = 0;
        return [() => { first = pickCum(firstCum); return cls.starts[first] - lead[0] - rng() * (lead[1] - lead[0]); },
          () => cls.starts[Math.min(cls.starts.length - 1, first + Math.floor(rng() * 3))] + cls.length + rng() * 90];
      };
      const studentGroups = 400;   // spread students over this many home/campus pairs
      for (let k = 0; k < studentGroups; k++) {
        const ci = rng() < raw.campus[0].share ? 0 : 1;
        const dest = { zone: campusZones[ci][pickCum(campusCum[ci])].i };
        const people = attending / studentGroups;
        const home = { zone: homesNear[pickCum(homeCum)].i };
        tour("school", home, dest, ...studentDay([8, 30]), people * raw.campusLiveInBox, local(home, dest, o.modes.campus));
        tour("school", { sector: pickCum(sectorCum) }, dest, ...studentDay([15, 50]), people * (1 - raw.campusLiveInBox), o.modes.students);
      }
      // Class changes between the East and West Bank: most walk the Washington Avenue Bridge.
      for (const start of cls.starts.slice(1)) {
        const crossing = attending * o.classCrossing;
        for (let k = 0; k < 20; k++) {
          const from = rng() < raw.campus[0].share ? 0 : 1, to = 1 - from;
          const a = { zone: campusZones[from][pickCum(campusCum[from])].i }, b = { zone: campusZones[to][pickCum(campusCum[to])].i };
          tour("class change", a, b, () => start - 15 + rng() * 10, null, crossing / 20, { active: 1 - o.classRide, transit: o.classRide });
        }
      }

      // Residents' errands and visitors from outside, towards shops and restaurants.
      const attract = zones.map((z) => z.retail + z.food);
      const attractCum = cumOf(attract);
      const errandDay = day < 5 ? 1 : 1.3;
      const errandTime = () => clamp(normal(14.5 * 60, 3 * 60), 9 * 60, 21 * 60);
      // Errands stay local: destinations weighted by shops and restaurants, decaying with distance.
      for (let hz = 0; hz < nz && o.background; hz++) {
        if (!zones[hz].pop) continue;
        const people = zones[hz].pop * o.errandRate * errandDay;
        const zh = zones[hz];
        const cum = cumOf(zones.map((z, i) => attract[i] * Math.exp(-Math.hypot(z.x - zh.x, z.y - zh.y) / o.errandMeters)));
        if (!(cum[nz - 1] > 0)) continue;
        const dests = 3;
        for (let k = 0; k < dests; k++) {
          const from = { zone: hz }, to = { zone: pickCum(cum) };
          tour("errand", from, to, errandTime, (t) => t + 30 + rng() * 60, people / dests, local(from, to, o.modes.residents));
        }
      }
      const visitors = totalOf("retail") * o.visitorsPerJob + totalOf("food") * o.visitorsPerJob;
      const visitorDay = day < 5 ? 1 : 1.4;
      for (let k = 0; k < 300 && o.background; k++)
        tour("visit", { sector: pickCum(sectorCum) }, { zone: pickCum(attractCum) }, () => clamp(normal(14 * 60, 3 * 60), 9 * 60, 21 * 60),
          (t) => t + 60 + rng() * 120, visitors * visitorDay / 300, o.modes.visitors);

      // Events: arrivals in the 90 minutes before the start, departures in a surge at the end.
      for (const ev of o.events || []) {
        const venue = venueByName.get(ev.venue);
        if (!venue) continue;
        let vz = 0, best = Infinity;
        for (const z of zones) { const d = Math.hypot(z.x - venue.x, z.y - venue.y); if (d < best) { best = d; vz = z.i; } }
        const end = ev.start + (ev.length || 180);
        const arriveEv = () => clamp(normal(ev.start - 40, 25), ev.start - 120, ev.start + 10);
        const leaveEv = () => clamp(end + Math.abs(normal(0, 25)), end - 20, end + 75);   // the crowd clears over ~45 min
        const groups = 120;
        const popCum = cumOf(zones.map((z) => z.pop));
        for (let k = 0; k < groups; k++) {
          const people = ev.attendance / groups;
          tour("event", { sector: pickCum(sectorCum) }, { zone: vz }, arriveEv, () => leaveEv(), people * (1 - o.eventLocal), o.modes.events);
          const home = { zone: pickCum(popCum) }, venueZone = { zone: vz };
          tour("event", home, venueZone, arriveEv, () => leaveEv(), people * o.eventLocal, local(home, venueZone, o.modes.residents));
        }
      }

      trips.sort((a, b) => a.minute - b.minute);
      const simulated = trips.filter((t) => t.minute >= o.dayStart);
      const totalTrips = Object.values(full).reduce((a, b) => a + b, 0);
      const summary = {
        day: DAYS[day], sampling: N,
        residents: totalOf("pop"), jobs: totalOf("jobs"),
        jobsPresent: zones.reduce((s, z, i) => s + groupsOf(i).reduce((t, [, share, pres]) => t + z.jobs * share * pres, 0), 0),
        campusAttendance: attending + zones.reduce((s, z, i) => s + (campusOf[i] >= 0 ? z.edu * PRESENCE.edu[day] : 0), 0),
        personTrips: totalTrips, byPurpose: full, hourly,
        agentTrips: trips.length, simulatedAgentTrips: simulated.length,
      };
      return { trips: simulated, all: trips, summary };
    }

    return { zones, raw, generate, hospitalZone, campusOf, DAYS };
  }

  const api = { createDemand, DEFAULTS, DAYS, PRESENCE, SECTORS, CLASSES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsDemand = api;
})(typeof window !== "undefined" ? window : globalThis);
