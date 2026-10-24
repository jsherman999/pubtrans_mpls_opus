// Daily travel demand from data/mpls_demand.js (Census blocks and LEHD LODES, built by
// tools/build_demand.py). No dependencies, no DOM, no Math.random: a day is reproducible from
// its seed. generate() returns the day's person trips at full scale as counts per purpose and
// hour, plus a time-ordered list of sampled agent trips (1 agent : `sampling` people).
//
// A trip runs between two locations: { zone: i } (a census block inside the study area) or
// { sector: k } (outside the area, in compass sector k of 16, clockwise from north, as seen
// from the area's centre). Modes: "walk" (short trips inside the area; counted, not
// simulated), "shuttle" (SDEV ride request) and "drive" (private car).
//
// Generators (all at full scale, then sampled):
//   commuters    LODES home-to-work flows: inside the area (internalOD), arriving from outside
//                (inbound, by home direction) and leaving it (outbound); presence by sector of
//                work and day of week (hybrid office work); start times by sector, shift
//                changes for health-care jobs at the hospitals
//   students     University of Minnesota attendance on the Minneapolis campus, living inside or
//                arriving from outside; hourly class-change trips between the banks
//   errands      residents' shopping and eating out, towards retail and food-service jobs
//   visitors     people from outside coming to shop, eat and visit, in proportion to those jobs
//   events       a game or concert at a venue: arrivals before the start, a surge at the end
(function (root) {
  "use strict";

  const SECTORS = 16;
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  // Share of jobs whose holder comes in that day. Office work is hybrid; most other work is not.
  const PRESENCE = {
    office: [0.62, 0.80, 0.80, 0.76, 0.52, 0.10, 0.06],
    other: [0.90, 0.91, 0.91, 0.90, 0.88, 0.55, 0.45],
    edu: [0.90, 0.92, 0.92, 0.90, 0.78, 0.15, 0.08],
  };
  const STUDENT_DAY = [1.0, 1.0, 1.0, 0.95, 0.75, 0.08, 0.05];
  const DEFAULTS = {
    sampling: 10,               // people per simulated agent
    day: 2,                     // Wednesday
    seed: 1,
    walkMeters: 800,            // trips inside the area shorter than this are walked
    // Share of trips made by private car today (the rest are public transit today, replaced by
    // SDEV shuttles in the simulation, which can also replace a share of the car trips).
    drive: { internal: 0.25, inbound: 0.55, outbound: 0.6, students: 0.30, visitors: 0.65, events: 0.55 },
    errandRate: 0.40,           // errand tours per resident per day
    errandMeters: 1200,         // distance decay of errand destinations
    visitorsPerJob: 1.2,        // visitors per retail or food-service job per day
    classChange: 0.06,          // share of attending students crossing between banks each hour
    events: [{ venue: "Target Field", start: 19 * 60 + 10, attendance: 25000, length: 180 }],
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
      const o = { ...DEFAULTS, ...base, ...options, drive: { ...DEFAULTS.drive, ...(base.drive || {}), ...(options.drive || {}) } };
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
      // A person's outbound and return legs. Counts every trip at full scale (expected value)
      // and emits sampled agents; both legs of a sampled person are emitted together.
      function tour(purpose, from, to, leave, back, people, driveShare) {
        const walking = dist(from, to) < o.walkMeters;
        const k = agents(people);
        for (let j = 0; j < k; j++) {
          const mode = walking ? "walk" : rng() < driveShare ? "drive" : "shuttle";
          const t0 = leave(), t1 = back == null ? null : back(t0);
          const tag = Math.floor(rng() * 1e9);   // shared by both legs of the tour
          trips.push({ minute: t0, purpose, from, to, mode, weight: N, tag });
          if (t1 != null && t1 < 24 * 60) trips.push({ minute: t1, purpose, from: to, to: from, mode, weight: N, returning: true, tag });
        }
        // Expected full-scale counts by mode and hour, from the same distributions.
        const share = walking ? { walk: 1, shuttle: 0, drive: 0 } : { walk: 0, shuttle: 1 - driveShare, drive: driveShare };
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
        if (group === "office") return [() => clamp(normal(8.25 * 60, 45), 6.25 * 60, 10.5 * 60), (t) => t + clamp(normal(8.6 * 60, 50), 6 * 60, 11 * 60)];
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
          tour("work", { zone: h }, { zone: w }, leave, back, k * share * pres, o.drive.internal);
        }
      // Commuters from outside, entering from the direction of home.
      for (let w = 0; w < nz; w++) {
        if (!zones[w].inbound) continue;
        for (const [g, share, pres] of groupsOf(w)) {
          const people = zones[w].inbound * share * pres;
          // Spread each zone's commuters over home directions by the area-wide distribution.
          for (let s = 0; s < SECTORS; s++) {
            const part = people * raw.inboundBySector[s] / sectorCum[SECTORS - 1];
            if (part <= 0) continue;
            const [leave, back] = shift(w, g);
            tour("work", { sector: s }, { zone: w }, leave, back, part, o.drive.inbound);
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
            (t) => t + clamp(normal(9.5 * 60, 50), 7 * 60, 12 * 60), part, o.drive.outbound);
        }
      }

      // University of Minnesota students.
      const attending = raw.campusStudents * STUDENT_DAY[day];
      const campusZones = raw.campus.map((c, ci) => zones.filter((z) => campusOf[z.i] === ci && (z.jobs || z.pop)));
      const campusCum = campusZones.map((list) => cumOf(list.map((z) => z.edu + z.jobs * 0.1 + 1)));
      const homesNear = zones.filter((z) => z.pop && raw.campus.some((c) => near(z, c, 1500)));
      const homeCum = cumOf(homesNear.map((z) => z.pop));
      const arrive = () => { const r = rng(); return clamp(r < 0.45 ? normal(8.3 * 60, 30) : r < 0.8 ? normal(10 * 60, 45) : normal(12 * 60, 60), 7 * 60, 15 * 60); };
      const stay = (t) => t + 3 * 60 + rng() * 5 * 60;
      const studentGroups = 400;   // spread students over this many home/campus pairs
      for (let k = 0; k < studentGroups; k++) {
        const ci = rng() < raw.campus[0].share ? 0 : 1;
        const dest = { zone: campusZones[ci][pickCum(campusCum[ci])].i };
        const people = attending / studentGroups;
        tour("school", { zone: homesNear[pickCum(homeCum)].i }, dest, arrive, stay, people * raw.campusLiveInBox, 0.05);
        tour("school", { sector: pickCum(sectorCum) }, dest, arrive, stay, people * (1 - raw.campusLiveInBox), o.drive.students);
      }
      // Class changes between the East and West Bank, on the hour from 09:00 to 16:00.
      for (let h = 9; h <= 16; h++) {
        const crossing = attending * o.classChange;
        for (let k = 0; k < 20; k++) {
          const from = rng() < raw.campus[0].share ? 0 : 1, to = 1 - from;
          const a = { zone: campusZones[from][pickCum(campusCum[from])].i }, b = { zone: campusZones[to][pickCum(campusCum[to])].i };
          tour("class change", a, b, () => h * 60 - 12 + rng() * 12, null, crossing / 20, 0);
        }
      }

      // Residents' errands and visitors from outside, towards shops and restaurants.
      const attract = zones.map((z) => z.retail + z.food);
      const attractCum = cumOf(attract);
      const errandDay = day < 5 ? 1 : 1.3;
      const errandTime = () => clamp(normal(14.5 * 60, 3 * 60), 9 * 60, 21 * 60);
      // Errands stay local: destinations weighted by shops and restaurants, decaying with distance.
      for (let hz = 0; hz < nz; hz++) {
        if (!zones[hz].pop) continue;
        const people = zones[hz].pop * o.errandRate * errandDay;
        const zh = zones[hz];
        const cum = cumOf(zones.map((z, i) => attract[i] * Math.exp(-Math.hypot(z.x - zh.x, z.y - zh.y) / o.errandMeters)));
        if (!(cum[nz - 1] > 0)) continue;
        const dests = 3;
        for (let k = 0; k < dests; k++)
          tour("errand", { zone: hz }, { zone: pickCum(cum) }, errandTime, (t) => t + 30 + rng() * 60, people / dests, o.drive.internal);
      }
      const visitors = totalOf("retail") * o.visitorsPerJob + totalOf("food") * o.visitorsPerJob;
      const visitorDay = day < 5 ? 1 : 1.4;
      for (let k = 0; k < 300; k++)
        tour("visit", { sector: pickCum(sectorCum) }, { zone: pickCum(attractCum) }, () => clamp(normal(14 * 60, 3 * 60), 9 * 60, 21 * 60),
          (t) => t + 60 + rng() * 120, visitors * visitorDay / 300, o.drive.visitors);

      // Events: arrivals in the 90 minutes before the start, departures in a surge at the end.
      for (const ev of o.events || []) {
        const venue = venueByName.get(ev.venue);
        if (!venue) continue;
        let vz = 0, best = Infinity;
        for (const z of zones) { const d = Math.hypot(z.x - venue.x, z.y - venue.y); if (d < best) { best = d; vz = z.i; } }
        const end = ev.start + (ev.length || 180);
        const arriveEv = () => clamp(normal(ev.start - 40, 25), ev.start - 120, ev.start + 10);
        const leaveEv = () => clamp(end + Math.abs(normal(0, 15)), end - 20, end + 60);
        const groups = 120;
        const popCum = cumOf(zones.map((z) => z.pop));
        for (let k = 0; k < groups; k++) {
          const people = ev.attendance / groups;
          tour("event", { sector: pickCum(sectorCum) }, { zone: vz }, arriveEv, () => leaveEv(), people * 0.75, o.drive.events);
          const home = pickCum(popCum);
          tour("event", { zone: home }, { zone: vz }, arriveEv, () => leaveEv(), people * 0.25, o.drive.internal);
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

  const api = { createDemand, DEFAULTS, DAYS, PRESENCE, SECTORS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MplsDemand = api;
})(typeof window !== "undefined" ? window : globalThis);
