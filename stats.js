/* Lap Ledger: driving-statistics maths. Pure functions with no page code, so the browser (Stats pages) and the tests
   (node test/stats.test.mjs) use the very same code.

   This is a port of dashboard/analysis.py from the OHND-Test-Reports dashboard it replaces, and the tests check it
   against that Python code on real data. All figures sum over statistics rows, one per day / car / track / session:
     { day: "2024-11-12", car: 1, track: 31, sessionType: 1, events: 1, timeOnTrack: 2396.6, lapsDriven: 21,
       cleanLapsDriven: 10 }       (team statistics rows also carry "user", the driver's slug)
   Clean % is always a ratio of sums (never an average of percentages) and is 0 when there are no laps. */
(function (root) {
  'use strict';

  const DAY = 86400000;
  // Garage61's numeric session types are not in its API reference; these are the labels used everywhere in Lap Ledger.
  const SESSION_TYPES = { 1: 'Practice', 2: 'Qualifying', 3: 'Race' };
  const SESSION_ORDER = ['Practice', 'Qualifying', 'Race'];

  const sessionLabel = code => {
    const n = Number(code);
    if (code == null || code === '' || !Number.isInteger(n)) return 'Unknown';
    return SESSION_TYPES[n] || `Session ${n}`;
  };
  const trackLabel = t => {
    const name = t.name || `Track #${t.id}`;
    const variant = String(t.variant || '').trim();
    return variant ? `${name} – ${variant}` : name;
  };
  const floorDay = ms => Math.floor(ms / DAY) * DAY;                   // UTC midnight of that moment's date
  const dayMs = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
  const num = v => { const n = Number(v); return v === null || v === '' || !Number.isFinite(n) ? 0 : n; };
  /** Today's date as UTC midnight of the viewer's local calendar date (what the dashboard compares seasons against). */
  const todayMs = (now = new Date()) => Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

  /** iRacing seasons as [{ name, short, start, end }], newest first; start and end are UTC midnights in ms. */
  function buildSeasons(platforms) {
    const out = [];
    for (const p of platforms || []) {
      if (!p || p.id !== 'iracing') continue;
      for (const s of p.seasons || []) {
        const start = Date.parse(s.start), end = Date.parse(s.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        out.push({ name: s.name || s.shortName || 'Season', short: s.shortName || s.name, start: floorDay(start), end: floorDay(end) });
      }
    }
    return out.sort((a, b) => b.start - a.start);
  }

  /**
   * One row per statistics row, with names, class, session label and iRacing season/week added.
   * `lookups`: { cars: [{id,name}], tracks: [{id,name,variant}], carGroups: [{name,cars:[id]}], platforms: [...] }.
   * A car or track with no name is shown as "Car #id" / "Track #id" rather than dropped.
   */
  function enrich(stats, lookups = {}) {
    const raw = stats && Array.isArray(stats.drivingStatistics) ? stats.drivingStatistics : [];
    const carNames = new Map((lookups.cars || []).filter(Boolean).map(c => [c.id, c.name]));
    const trackNames = new Map((lookups.tracks || []).filter(Boolean).map(t => [t.id, trackLabel(t)]));
    const classes = new Map();
    for (const g of lookups.carGroups || []) {
      if (!g) continue;
      for (const id of g.cars || []) { if (!classes.has(id)) classes.set(id, []); classes.get(id).push(g.name || ''); }
    }
    const seasons = buildSeasons(lookups.platforms);
    const rows = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const day = dayMs(r.day);
      if (!Number.isFinite(day)) continue;
      const row = {
        day, dayStr: String(r.day).slice(0, 10), car: r.car, track: r.track, sessionType: r.sessionType,
        session: sessionLabel(r.sessionType), events: num(r.events), seconds: num(r.timeOnTrack), laps: num(r.lapsDriven), clean: num(r.cleanLapsDriven),
        carName: carNames.get(r.car) || `Car #${r.car}`,
        trackName: trackNames.get(r.track) || `Track #${r.track}`,
        carClasses: [...new Set(classes.get(r.car) || [])].sort(),
        carClass: [...new Set(classes.get(r.car) || [])].sort().join(', ') || '—',
        season: null, week: null
      };
      if (r.user != null) row.user = r.user;
      for (const s of seasons) {                                          // newest first, so an older season wins an overlap, as in the dashboard
        if (day >= s.start && day < s.end) { row.season = s.name; row.week = Math.floor((day - s.start) / DAY / 7) + 1; }
      }
      rows.push(row);
    }
    return rows;
  }

  /** Totals per group (laps, clean laps, clean %, hours, events, days driven, last day), sorted by time on track. */
  function summarize(rows, keyOf, metaOf) {
    const groups = new Map();
    for (const r of rows) {
      const key = keyOf(r);
      let g = groups.get(key);
      if (!g) { g = { key, ...(metaOf ? metaOf(r) : {}), laps: 0, clean: 0, seconds: 0, events: 0, dayset: new Set(), last: -Infinity }; groups.set(key, g); }
      g.laps += r.laps; g.clean += r.clean; g.seconds += r.seconds; g.events += r.events;
      g.dayset.add(r.day);
      if (r.day > g.last) g.last = r.day;
    }
    const out = [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));   // groupby order, then...
    for (const g of out) { g.days = g.dayset.size; delete g.dayset; g.cleanPct = g.laps > 0 ? (g.clean / g.laps) * 100 : 0; g.hours = g.seconds / 3600; }
    return out.sort((a, b) => b.hours - a.hours);                                                      // ...most time on track first (stable)
  }

  /** Headline numbers for a (possibly filtered) set of rows. */
  function totals(rows) {
    let laps = 0, clean = 0, seconds = 0, events = 0, first = null, last = null;
    const days = new Set(), tracks = new Set(), cars = new Set();
    for (const r of rows) {
      laps += r.laps; clean += r.clean; seconds += r.seconds; events += r.events;
      days.add(r.day); tracks.add(r.track); cars.add(r.car);
      if (last === null || r.day > last) last = r.day;
      if (first === null || r.day < first) first = r.day;       // (no Math.min(...rows): thousands of arguments overflow the stack)
    }
    return { laps, clean, cleanPct: laps ? (clean / laps) * 100 : 0, hours: seconds / 3600, events, days: days.size, tracks: tracks.size, cars: cars.size, first, last };
  }

  /** The n groups with the lowest clean % among those with at least minLaps laps. */
  function needsWork(summary, minLaps = 50, n = 3) {
    return summary.filter(g => g.laps >= minLaps).sort((a, b) => a.cleanPct - b.cleanPct).slice(0, n);
  }

  /** Clean % per month per session type; months with fewer than minLaps laps in a session type are left out. */
  function monthlyCleanPct(rows, minLaps = 20) {
    const m = new Map();
    for (const r of rows) {
      const d = new Date(r.day);
      const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      const key = month + '|' + r.session;
      const g = m.get(key) || { month, session: r.session, laps: 0, clean: 0 };
      g.laps += r.laps; g.clean += r.clean;
      m.set(key, g);
    }
    return [...m.values()].filter(g => g.laps >= minLaps).map(g => ({ ...g, cleanPct: (g.clean / g.laps) * 100 }))
      .sort((a, b) => a.month - b.month || (a.session < b.session ? -1 : 1));
  }

  /** Laps and clean laps per calendar month (all sessions), for the laps-per-month chart. */
  function monthlyLaps(rows) {
    const m = new Map();
    for (const r of rows) {
      const d = new Date(r.day);
      const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      const g = m.get(month) || { month, laps: 0, clean: 0 };
      g.laps += r.laps; g.clean += r.clean;
      m.set(month, g);
    }
    return [...m.values()].sort((a, b) => a.month - b.month);
  }

  /** Per track: practice vs race clean %, for tracks with at least minLaps of each, biggest gap (practice cleaner) first. */
  function practiceRaceGap(rows, minLaps = 20) {
    const s = summarize(rows.filter(r => r.session === 'Practice' || r.session === 'Race'), r => r.trackName + '\u0000' + r.session, r => ({ track: r.trackName, session: r.session }));
    const by = new Map();
    for (const g of s) { const t = by.get(g.track) || {}; t[g.session] = g; by.set(g.track, t); }
    const out = [];
    for (const [track, t] of by) {
      if (!t.Practice || !t.Race) continue;
      if (t.Practice.laps < minLaps || t.Race.laps < minLaps) continue;
      out.push({ track, practiceLaps: t.Practice.laps, raceLaps: t.Race.laps, practicePct: t.Practice.cleanPct, racePct: t.Race.cleanPct, gap: t.Practice.cleanPct - t.Race.cleanPct });
    }
    return out.sort((a, b) => b.gap - a.gap);
  }

  /** Time ranges for the filters. `range`: 'all' | 'season' (latest season driven) | '30' | '90' | '365'. */
  function rangeFilter(rows, range, today = todayMs()) {
    if (range === 'season') {
      const latest = latestSeasonName(rows);
      return latest ? rows.filter(r => r.season === latest) : rows;
    }
    const days = { 30: 30, 90: 90, 365: 365 }[range];
    return days ? rows.filter(r => r.day >= today + DAY - days * DAY) : rows;
  }
  function latestSeasonName(rows) {
    let latest = null, day = -Infinity;
    for (const r of rows) if (r.season && r.day > day) { day = r.day; latest = r.season; }
    return latest;
  }
  /** Keep only the chosen session types. `chosen` is a Set of labels; null or undefined means all. */
  const sessionFilter = (rows, chosen) => (chosen ? rows.filter(r => chosen.has(r.session)) : rows);
  /** Session labels present in the rows, Practice / Qualifying / Race first, anything else after in order. */
  function sessionOptions(rows) {
    const have = new Set(rows.map(r => r.session));
    return [...SESSION_ORDER.filter(s => have.has(s)), ...[...have].filter(s => !SESSION_ORDER.includes(s)).sort()];
  }

  /** Rows split by class: a car in two classes counts toward each (the dashboard's "Car classes" view). */
  function explodeClasses(rows) {
    const out = [];
    for (const r of rows) for (const c of (r.carClasses && r.carClasses.length ? r.carClasses : [r.carClass])) out.push({ ...r, carClass: c });   // the array, so a class name with a comma stays whole
    return out;
  }

  /* ---- seasons -------------------------------------------------------------------------------------------- */

  /** Names of the seasons driven in, newest first by the first day driven in each. */
  function seasonsDriven(rows) {
    const first = new Map();
    for (const r of rows) if (r.season && (!first.has(r.season) || r.day < first.get(r.season))) first.set(r.season, r.day);
    return [...first.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  }

  /**
   * One season against the one before it. A season still in progress is compared with only the same number of weeks
   * of the previous one, so a half-finished season does not look like a slump.
   * Returns { order, current, previous, previousName, weeksSoFar, totals, previousTotals }.
   */
  function seasonCompare(rows, seasons, selected, today = todayMs()) {
    const inSeason = rows.filter(r => r.season);
    const order = seasonsDriven(inSeason);
    const current = inSeason.filter(r => r.season === selected);
    const at = order.indexOf(selected);
    const previousName = at >= 0 && at + 1 < order.length ? order[at + 1] : null;
    let previous = previousName ? inSeason.filter(r => r.season === previousName) : null;
    const info = seasons.find(s => s.name === selected);
    let weeksSoFar = null;
    if (info && info.start <= today && today < info.end) {
      weeksSoFar = Math.floor((today - info.start) / DAY / 7) + 1;
      if (previous) previous = previous.filter(r => r.week <= weeksSoFar);
    }
    return { order, current, previous, previousName, weeksSoFar, totals: totals(current), previousTotals: previous ? totals(previous) : null };
  }

  /** Laps and clean laps for weeks 1..max of the rows' season, with zeros filled in. */
  function weeklyLaps(current) {
    if (!current.length) return [];
    let max = 0;
    for (const r of current) if (r.week > max) max = r.week;
    const out = Array.from({ length: max }, (_, i) => ({ week: i + 1, laps: 0, clean: 0 }));
    for (const r of current) { out[r.week - 1].laps += r.laps; out[r.week - 1].clean += r.clean; }
    return out;
  }

  /** The week-by-week table: top two tracks and cars by time, laps, clean % and hours. */
  function weekTable(current) {
    const byWeek = new Map();
    for (const r of current) { if (!byWeek.has(r.week)) byWeek.set(r.week, []); byWeek.get(r.week).push(r); }
    const top = (rows, field) => {
      const t = new Map();
      for (const r of rows) t.set(r[field], (t.get(r[field]) || 0) + r.seconds);
      return [...t.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
    };
    return [...byWeek.entries()].sort((a, b) => a[0] - b[0]).map(([week, rows]) => {
      const t = totals(rows);
      return { week, tracks: top(rows, 'trackName'), cars: top(rows, 'carName'), laps: t.laps, cleanPct: t.cleanPct, hours: t.hours };
    });
  }

  /** Every season driven, newest first, with its totals. */
  function allSeasons(rows) {
    const inSeason = rows.filter(r => r.season);
    const by = new Map(summarize(inSeason, r => r.season).map(g => [g.key, g]));
    return seasonsDriven(inSeason).map(name => by.get(name));
  }

  /* ---- formatting ---------------------------------------------------------------------------------------- */

  /** "12.3 h", or minutes under an hour. */
  const fmtHours = h => (h >= 1 ? `${h.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h` : `${Math.round(h * 60)} min`);
  /** "12h 34m", "3m 05s", "42s". */
  function fmtDuration(seconds) {
    const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return `${h.toLocaleString('en-US')}h ${m}m`;
    if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
    return `${sec}s`;
  }
  /** "Rating" display for an iRacing rating: "—" when there is none (Garage61 sends -1). */
  const ratingText = r => (r.rating === -1 || r.rating == null ? '—' : String(r.ratingDisplayAs ?? r.rating));
  const prettyCategory = c => String(c || '').replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
  const prettyRatingType = t => String(t || '').replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()).replace('Irating', 'iRating');

  /** A /me/accounts item's ratings as a table: { categories: [...], types: [...], cell(category, type) }. */
  function ratingsTable(ratings) {
    const cats = [], types = [], cells = new Map();
    for (const r of ratings || []) {
      if (!r || typeof r !== 'object') continue;
      const c = prettyCategory(r.category), t = prettyRatingType(r.type);
      if (!cats.includes(c)) cats.push(c);
      if (!types.includes(t)) types.push(t);
      if (!cells.has(c + '|' + t)) cells.set(c + '|' + t, ratingText(r));
    }
    const byName = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });   // iRating before Safety Rating
    cats.sort(byName); types.sort(byName);
    return { categories: cats, types, cell: (c, t) => cells.get(c + '|' + t) || '' };
  }

  const api = {
    DAY, SESSION_TYPES, SESSION_ORDER, sessionLabel, trackLabel, buildSeasons, enrich, summarize, totals, needsWork, monthlyCleanPct, monthlyLaps,
    practiceRaceGap, rangeFilter, latestSeasonName, sessionFilter, sessionOptions, explodeClasses, seasonsDriven, seasonCompare, weeklyLaps, weekTable,
    allSeasons, fmtHours, fmtDuration, ratingText, ratingsTable, todayMs, dayMs
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LedgerStats = api;
})(typeof self !== 'undefined' ? self : this);
