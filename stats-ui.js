/* Lap Ledger: the Stats pages (Overview, Tracks & cars, Seasons, Practice vs race, Team).
   The Worker (/api/stats) hands over Garage61's raw statistics; all maths is in stats.js and this file only lays the
   results out. Team statistics need the edit key because they show teammates' driving.
   app.js provides the shared helpers through window.Ledger and calls LedgerStatsUI.render() for any #/stats route. */
(function () {
  'use strict';

  const S = window.LedgerStats;
  const L = () => window.Ledger;
  const esc = s => L().esc(s);

  /* ---- small formatting helpers -------------------------------------------------------------------------- */
  const n0 = n => Math.round(n).toLocaleString('en-US');
  const pct = n => `${Math.round(n)}%`;
  const signed = (n, fmt, unit = '') => `${n < 0 ? '−' : '+'}${fmt(Math.abs(n))}${unit}`;
  const dateText = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const monthText = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const clock = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const hint = (text, cls = 'imp-hint') => `<p class="${cls}">${text}</p>`;
  const sessionColor = name => ({ Practice: 'var(--c-practice)', Qualifying: 'var(--c-qual)', Race: 'var(--c-race)' }[name] || 'var(--c-other)');

  /* ---- state ---------------------------------------------------------------------------------------------- */
  const st = {
    data: null, rows: [], seasons: [], lookups: null, loading: null,
    tc: { range: 'all', sessions: null, view: 'tracks' },
    se: { sessions: null, season: null },
    pv: { range: 'all' },
    tm: { id: null, range: 'all', sessions: null },
    teams: {}                                              // team id -> { state, rows, members, message, at }
  };
  let token = 0;                                           // a newer render makes older, slower ones stop

  async function loadData(force) {
    if (st.data && !force) return st.data;
    if (st.loading) return st.loading;
    st.loading = (async () => {
      const res = await fetch(L().API + '/api/stats', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      st.lookups = {
        cars: data.cars || [], tracks: data.tracks || [],
        carGroups: (data.carGroups && data.carGroups.items) || [], platforms: (data.platforms && data.platforms.items) || []
      };
      st.rows = S.enrich(data.statistics, st.lookups);
      st.seasons = S.buildSeasons(st.lookups.platforms);
      st.data = data;
      return data;
    })().finally(() => { st.loading = null; });
    return st.loading;
  }

  /* ---- shared pieces -------------------------------------------------------------------------------------- */
  const PAGES = [['', 'Overview'], ['tracks', 'Tracks & cars'], ['seasons', 'Seasons'], ['practice', 'Practice vs race'], ['team', 'Team']];
  const subnav = active => `<nav class="subnav" aria-label="Stats pages">${PAGES.map(([k, label]) =>
    `<a href="#/stats${k ? '/' + k : ''}"${k === active ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  const shell = (active, inner) => L().tabsHtml('stats') + subnav(active) + inner;

  function rangeSelect(key, value) {
    const season = S.latestSeasonName(st.rows);
    const options = [['all', 'All time'], ...(season ? [['season', `Latest season (${season})`]] : []), ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months']];
    return `<label class="flt">Time range<select data-sf="${key}.range">${options.map(([v, l]) =>
      `<option value="${v}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  }
  function sessionBoxes(key, selected, rows) {
    return `<fieldset class="flt"><legend>Session types</legend>${S.sessionOptions(rows).map(o =>
      `<label class="chk"><input type="checkbox" data-sf="${key}.session" value="${esc(o)}"${!selected || selected.has(o) ? ' checked' : ''}> <span class="dot" style="background:${sessionColor(o)}"></span>${esc(o)}</label>`).join('')}</fieldset>`;
  }
  const filterBar = inner => `<div class="filters">${inner}</div>`;

  const tile = (label, value, delta = '', title = '') => `<div class="tile"${title ? ` title="${esc(title)}"` : ''}><span class="label">${esc(label)}</span><b>${value}</b>${delta ? `<small>${delta}</small>` : ''}</div>`;
  const tiles = list => `<div class="tiles">${list.join('')}</div>`;

  /** A table. `cols`: [{ label, get(row) -> html, num, opt }]. `opt` columns are hidden on narrow screens. */
  function table(cols, rows, caption) {
    return `<div class="st-wrap"><table class="st-table"><caption class="sr-only">${esc(caption)}</caption><thead><tr>${cols.map(c =>
      `<th scope="col" class="${c.num ? 'num ' : ''}${c.opt ? 'opt' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r =>
      `<tr>${cols.map(c => `<td class="${c.num ? 'num ' : ''}${c.opt ? 'opt ' : ''}${c.wrap ? 'wrap' : ''}">${c.get(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  const groupCols = (nameLabel, name, extra = []) => [
    { label: nameLabel, get: name, wrap: true }, ...extra,
    { label: 'Laps', num: true, get: g => n0(g.laps) }, { label: 'Clean %', num: true, get: g => pct(g.cleanPct) },
    { label: 'Hours', num: true, get: g => (g.hours).toFixed(1) },
    { label: 'Events', num: true, opt: true, get: g => n0(g.events) }, { label: 'Days', num: true, opt: true, get: g => n0(g.days) },
    { label: 'Last driven', opt: true, get: g => dateText(g.last) }
  ];

  /* ---- charts (inline SVG and HTML, themed through CSS variables) ------------------------------------------- */
  const niceMax = v => { const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };

  /** Bars of all laps with clean laps drawn in front, one pair per label. */
  function overlayBars(labels, all, clean, aria) {
    const W = 640, H = 240, pl = 46, pr = 8, pt = 10, pb = 28, n = labels.length;
    const max = niceMax(Math.max(1, ...all)), bw = (W - pl - pr) / n, y = v => pt + (H - pt - pb) * (1 - v / max);
    const step = Math.ceil(n / 8);
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11">${n0(v)}</text>`;
    }
    labels.forEach((label, i) => {
      const x = pl + i * bw, w = bw * 0.78, off = bw * 0.11;
      g += `<g><title>${esc(label)}: ${n0(all[i])} laps, ${n0(clean[i])} clean</title>`
        + `<rect x="${x + off}" y="${y(all[i])}" width="${w}" height="${Math.max(0, H - pb - y(all[i]))}" rx="1.5" style="fill:var(--c-all)"/>`
        + `<rect x="${x + off + w * 0.2}" y="${y(clean[i])}" width="${w * 0.6}" height="${Math.max(0, H - pb - y(clean[i]))}" rx="1.5" style="fill:var(--c-series)"/></g>`;
      if (i % step === 0) g += `<text class="tick" x="${x + bw / 2}" y="${H - 9}" text-anchor="middle" font-size="11">${esc(label)}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${g}</svg>`
      + `<div class="legend"><span><i style="background:var(--c-all)"></i>All laps</span><span><i style="background:var(--c-series)"></i>Clean laps</span></div>`;
  }

  /** One line per series over the same months; y is 0 to 100 %. */
  function lineChart(months, series, aria) {
    const W = 640, H = 260, pl = 40, pr = 12, pt = 10, pb = 28, n = months.length;
    const x = i => pl + (n === 1 ? (W - pl - pr) / 2 : (i * (W - pl - pr)) / (n - 1)), y = v => pt + (H - pt - pb) * (1 - v / 100);
    const step = Math.ceil(n / 8);
    let g = '';
    for (let v = 0; v <= 100; v += 25) g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11">${v}%</text>`;
    months.forEach((m, i) => { if (i % step === 0) g += `<text class="tick" x="${x(i)}" y="${H - 9}" text-anchor="middle" font-size="11">${esc(monthText(m))}</text>`; });
    for (const s of series) {
      const pts = s.points.map(p => ({ ...p, x: x(months.indexOf(p.month)), y: y(p.cleanPct) }));
      if (pts.length > 1) g += `<polyline fill="none" stroke-width="2" stroke-linejoin="round" style="stroke:${sessionColor(s.name)}" points="${pts.map(p => `${p.x},${p.y}`).join(' ')}"/>`;
      for (const p of pts) g += `<circle cx="${p.x}" cy="${p.y}" r="4" style="fill:${sessionColor(s.name)}"><title>${esc(s.name)}, ${esc(monthText(p.month))}: ${pct(p.cleanPct)} clean over ${n0(p.laps)} laps</title></circle>`;
    }
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${g}</svg>`
      + `<div class="legend">${series.map(s => `<span><i style="background:${sessionColor(s.name)}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  }

  /** Horizontal bars of hours on track, longest first. */
  function hbars(groups) {
    const max = Math.max(...groups.map(g => g.hours), 0.0001);
    return `<div class="hb" role="list">${groups.map(g => `<div class="hb-row" role="listitem">
      <div class="hb-name">${esc(g.name)}</div>
      <div class="hb-bar"><i style="width:${Math.max(2, (g.hours / max) * 100)}%"></i></div>
      <div class="hb-val">${S.fmtHours(g.hours)}</div>
      <div class="hb-sub">${n0(g.laps)} laps · ${pct(g.cleanPct)} clean</div></div>`).join('')}</div>`;
  }

  const leastClean = (summary, noun) => {
    const worst = S.needsWork(summary);
    return worst.length
      ? `<div class="callout"><b>Least clean ${noun}</b> (with 50+ laps)<ul>${worst.map(g => `<li><b>${esc(g.name)}</b> — ${pct(g.cleanPct)} clean over ${n0(g.laps)} laps</li>`).join('')}</ul></div>` : '';
  };

  const sessionNote = () => hint('Garage61 labels each session with a number. These pages read 1 as Practice, 2 as Qualifying and 3 as Race; any other number shows as "Session N".');

  /* ---- pages ----------------------------------------------------------------------------------------------- */
  function overview() {
    const me = st.data.me || {};
    const full = [me.firstName, me.lastName].filter(Boolean).join(' ');
    const title = me.nickName || full || me.slug || 'Unknown driver';
    const details = [me.nickName && full ? full : '', me.slug ? `garage61.net/@${me.slug}` : '', me.subscriptionPlan ? `${String(me.subscriptionPlan).replace(/^./, c => c.toUpperCase())} plan` : ''].filter(Boolean).map(esc).join(' · ');
    let out = `<section class="card"><h2 class="st-title">${esc(title)}</h2>${details ? `<p class="sub-line">${details}</p>` : ''}</section>`;

    if (!st.rows.length) out += `<section class="card"><h2>Driving statistics</h2>${hint('No driving statistics yet. Drive a session with Garage61 running, then check back.')}</section>`;
    else {
      const t = S.totals(st.rows), months = S.monthlyLaps(st.rows);
      out += `<section class="card"><h2>Driving statistics</h2>${tiles([
        tile('Laps driven', n0(t.laps)), tile('Clean laps', pct(t.cleanPct), '', `${n0(t.clean)} clean laps`), tile('Time on track', S.fmtDuration(t.hours * 3600)),
        tile('Events', n0(t.events)), tile('Days driven', n0(t.days))])}
        <p class="sub-line">Since ${esc(dateText(t.first))}</p>
        <h3 class="st-h">Laps per month</h3>${overlayBars(months.map(m => monthText(m.month)), months.map(m => m.laps), months.map(m => m.clean), `Laps per month, ${months.length} months, ${n0(t.laps)} laps in total`)}</section>`;
    }

    const accounts = (st.data.accounts && st.data.accounts.items) || [];
    out += `<section class="card"><h2>Linked accounts</h2>${(st.data.problems || {}).accounts ? hint('Linked accounts did not load.') : !accounts.length ? hint('No linked accounts (for example iRacing) found.') : accounts.map(a => {
      const platform = typeof a.platform === 'object' && a.platform ? a.platform.name : String(a.platform || '');
      const rt = S.ratingsTable(a.ratings);
      return `<div class="acct"><b>${esc(a.name || 'Unknown')}</b><div class="sub-line">${esc(platform.toLowerCase() === 'iracing' ? 'iRacing' : platform.replace(/^./, c => c.toUpperCase()) || 'Unknown platform')} · ID ${esc(a.id ?? '?')}</div>`
        + (rt.categories.length ? `<div class="st-wrap"><table class="st-table rt"><thead><tr><th scope="col">Category</th>${rt.types.map(t => `<th scope="col" class="num">${esc(t)}</th>`).join('')}</tr></thead><tbody>${rt.categories.map(c =>
          `<tr><th scope="row">${esc(c)}</th>${rt.types.map(t => `<td class="num">${esc(rt.cell(c, t))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '') + '</div>';
    }).join('')}</section>`;

    const teams = ((st.data.teams && st.data.teams.items) || []).slice().sort((a, b) => Number(!!b.isOwner) - Number(!!a.isOwner));
    out += `<section class="card"><h2>Teams</h2>${(st.data.problems || {}).teams ? hint('Teams did not load.') : !teams.length ? hint('You have not joined any teams yet.') : `<ul class="teams">${teams.map(t =>
      `<li><b>${esc(t.name || 'Unnamed team')}</b>${t.isOwner ? ' <span class="tag pb">Owner</span>' : ''}<div class="sub-line">${esc(t.slug || '')}</div></li>`).join('')}</ul>`}</section>`;
    return out;
  }

  function tracksPage() {
    const f = st.tc;
    const rows = S.sessionFilter(S.rangeFilter(st.rows, f.range), f.sessions);
    const bar = filterBar(rangeSelect('tc', f.range) + sessionBoxes('tc', f.sessions, st.rows));
    if (!rows.length) return bar + hint('No driving in this time range and session selection.');
    const t = S.totals(rows);
    const head = tiles([tile('Laps', n0(t.laps)), tile('Clean laps', pct(t.cleanPct), '', `${n0(t.clean)} clean laps`), tile('Time on track', S.fmtHours(t.hours)), tile('Tracks', n0(t.tracks)), tile('Cars', n0(t.cars))]);
    const views = [['tracks', 'Tracks'], ['cars', 'Cars'], ['classes', 'Car classes']];
    const seg = `<div class="seg sm" role="group" aria-label="Group by">${views.map(([k, l]) => `<button type="button" data-st-view="${k}" aria-pressed="${f.view === k}">${l}</button>`).join('')}</div>`;
    let body;
    if (f.view === 'tracks') {
      const g = S.summarize(rows, r => r.trackName, r => ({ name: r.trackName }));
      body = `<h3 class="st-h">Most time on track — top ${Math.min(12, g.length)} tracks</h3>${hbars(g.slice(0, 12))}${leastClean(g, 'tracks')}${table(groupCols('Track', x => esc(x.name)), g, 'Tracks')}`;
    } else if (f.view === 'cars') {
      const g = S.summarize(rows, r => r.carName + '\u0000' + r.carClass, r => ({ name: r.carName, carClass: r.carClass }));
      body = `<h3 class="st-h">Most time on track — top ${Math.min(12, g.length)} cars</h3>${hbars(g.slice(0, 12))}${leastClean(g, 'cars')}${table(groupCols('Car', x => esc(x.name), [{ label: 'Class', get: x => esc(x.carClass) }]), g, 'Cars')}`;
    } else {
      const g = S.summarize(S.explodeClasses(rows), r => r.carClass, r => ({ name: r.carClass === '—' ? 'No class' : r.carClass }));
      body = `${hint('A car in more than one class (for example GT3 and an endurance group) counts toward each.')}${table(groupCols('Class', x => esc(x.name)), g, 'Car classes')}`;
    }
    const unnamed = rows.filter(r => r.trackName.startsWith('Track #') || r.carName.startsWith('Car #')).length;
    return bar + head + `<section class="card"><div class="card-head">${seg}</div>${body}</section>`
      + (unnamed ? hint(`${n0(unnamed)} rows use a car or track Garage61 did not return a name for; they are shown by number.`) : '');
  }

  function seasonsPage() {
    const f = st.se;
    if (!st.seasons.length) return hint('Season dates did not load, so your driving cannot be matched to iRacing seasons.', 'imp-bad');
    const rows = S.sessionFilter(st.rows, f.sessions);
    const bar = filterBar(sessionBoxes('se', f.sessions, st.rows));
    const inSeason = rows.filter(r => r.season);
    if (!inSeason.length) return bar + hint('No driving in the selected sessions could be matched to an iRacing season.');
    const order = S.seasonsDriven(inSeason);
    const selected = f.season && order.includes(f.season) ? f.season : order[0];
    const c = S.seasonCompare(rows, st.seasons, selected), t = c.totals, p = c.previousTotals;
    const d = (key, fmt, unit = '') => (p ? signed(t[key] - p[key], fmt, unit) : '');
    const picker = `<label class="flt">Season<select data-sf="se.season">${order.map(o => `<option value="${esc(o)}"${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    const caption = c.previousName && c.weeksSoFar ? `${esc(selected)} is in progress (week ${c.weeksSoFar}), so changes are compared with the first ${c.weeksSoFar} weeks of ${esc(c.previousName)}.`
      : c.previousName ? `Changes are compared with ${esc(c.previousName)}.` : '';
    const weekly = S.weeklyLaps(c.current);
    const wt = S.weekTable(c.current);
    const all = S.allSeasons(rows);
    return filterBar(picker + sessionBoxes('se', f.sessions, st.rows))
      + tiles([tile('Laps', n0(t.laps), d('laps', n0)), tile('Clean laps', pct(t.cleanPct), d('cleanPct', n0, ' pts')), tile('Time on track', S.fmtHours(t.hours), d('hours', x => x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }), ' h')),
        tile('Events', n0(t.events), d('events', n0)), tile('Days driven', n0(t.days), d('days', n0))])
      + (caption ? hint(caption) : '')
      + `<section class="card"><h2>Laps by week</h2>${overlayBars(weekly.map(w => `Week ${w.week}`), weekly.map(w => w.laps), weekly.map(w => w.clean), `Laps by week in ${selected}`)}</section>`
      + `<section class="card"><h2>Week by week</h2>${table([
        { label: 'Week', get: w => w.week }, { label: 'Tracks', wrap: true, get: w => esc(w.tracks.join(', ')) }, { label: 'Cars', opt: true, wrap: true, get: w => esc(w.cars.join(', ')) },
        { label: 'Laps', num: true, get: w => n0(w.laps) }, { label: 'Clean %', num: true, get: w => pct(w.cleanPct) }, { label: 'Hours', num: true, get: w => w.hours.toFixed(1) }], wt, 'Week by week')}</section>`
      + `<section class="card"><h2>All seasons</h2>${table([
        { label: 'Season', get: g => esc(g.key) }, { label: 'Laps', num: true, get: g => n0(g.laps) }, { label: 'Clean %', num: true, get: g => pct(g.cleanPct) },
        { label: 'Hours', num: true, get: g => g.hours.toFixed(1) }, { label: 'Events', num: true, opt: true, get: g => n0(g.events) }, { label: 'Days', num: true, opt: true, get: g => n0(g.days) }], all, 'All seasons')}</section>`;
  }

  function practicePage() {
    const f = st.pv;
    const rows = S.rangeFilter(st.rows, f.range);
    const bar = filterBar(rangeSelect('pv', f.range));
    if (!rows.length) return bar + hint('No driving in this time range.');
    const order = S.SESSION_ORDER;
    const by = S.summarize(rows, r => r.session, r => ({ name: r.session })).sort((a, b) => (order.indexOf(a.name) < 0 ? 99 : order.indexOf(a.name)) - (order.indexOf(b.name) < 0 ? 99 : order.indexOf(b.name)));
    const cards = `<div class="tiles">${by.map(g => `<div class="tile"><span class="label"><span class="dot" style="background:${sessionColor(g.name)}"></span>${esc(g.name)}</span><b>${pct(g.cleanPct)}</b><small>clean laps</small><small>${n0(g.laps)} laps · ${S.fmtHours(g.hours)} · ${n0(g.events)} events</small></div>`).join('')}</div>`;
    const prac = by.find(g => g.name === 'Practice'), race = by.find(g => g.name === 'Race');
    const diff = prac && race ? prac.cleanPct - race.cleanPct : null;
    const line = diff === null ? '' : `<p class="st-line">${diff > 0 ? `Your race laps are <b>${Math.round(diff)} points less clean</b> than your practice laps.` : `Your race laps are <b>${Math.round(-diff)} points cleaner</b> than your practice laps.`}</p>`;
    const monthly = S.monthlyCleanPct(rows);
    let trend = '';
    if (monthly.length) {
      const months = [...new Set(monthly.map(m => m.month))].sort((a, b) => a - b);
      const names = [...order.filter(s => monthly.some(m => m.session === s)), ...[...new Set(monthly.map(m => m.session))].filter(s => !order.includes(s)).sort()];
      trend = `<section class="card"><h2>Clean-lap rate by month</h2>${lineChart(months, names.map(n => ({ name: n, points: monthly.filter(m => m.session === n) })), 'Clean-lap rate by month for each session type')}${hint('Months with fewer than 20 laps in a session type are left out, so a handful of laps cannot swing the line.')}</section>`;
    }
    const gap = S.practiceRaceGap(rows);
    const costs = `<section class="card"><h2>Tracks where racing costs you the most</h2>${!gap.length
      ? hint('Not enough tracks with both practice and race laps (20+ of each) in this time range.')
      : hint('Tracks with 20+ practice laps and 20+ race laps. Gap = practice clean % minus race clean %.') + table([
        { label: 'Track', wrap: true, get: g => esc(g.track) }, { label: 'Practice', num: true, get: g => `${pct(g.practicePct)}<small> ${n0(g.practiceLaps)} laps</small>` },
        { label: 'Race', num: true, get: g => `${pct(g.racePct)}<small> ${n0(g.raceLaps)} laps</small>` }, { label: 'Gap (pts)', num: true, get: g => (g.gap >= 0 ? '+' : '−') + Math.abs(Math.round(g.gap)) }], gap, 'Practice versus race by track')}</section>`;
    return bar + `<section class="card"><h2>Clean laps by session type</h2>${cards}${line}</section>` + trend + costs + sessionNote();
  }

  /* ---- team (needs the edit key) ----------------------------------------------------------------------------- */
  const teamList = () => ((st.data.teams && st.data.teams.items) || []).slice().sort((a, b) => Number(!!b.isOwner) - Number(!!a.isOwner));

  async function loadTeam(id) {
    const key = L().store.get('ledger.editkey');
    const rec = (st.teams[id] = { state: 'loading' });
    try {
      const res = await fetch(L().API + '/api/stats/team/' + id, { headers: { accept: 'application/json', 'x-edit-key': key } });
      if (res.status === 401) { L().store.set('ledger.editkey', ''); rec.state = 'locked'; rec.message = 'That edit key was wrong.'; }
      else if (res.status === 429) { rec.state = 'error'; rec.message = await L().lockoutText(res); }
      else if (!res.ok) { rec.state = 'error'; rec.message = 'This team\'s statistics could not be loaded right now.'; }
      else {
        const data = await res.json();
        if (data.tooBig) rec.state = 'toobig';
        else {
          rec.state = 'ready'; rec.at = data.generatedAt;
          rec.rows = S.enrich(data.statistics, st.lookups);
          rec.members = new Map(((data.detail && data.detail.members) || []).map(m => [m.slug, [m.firstName, m.lastName].filter(Boolean).join(' ') || m.slug]));
        }
      }
    } catch (e) { rec.state = 'error'; rec.message = 'Check your connection and try again.'; }
    if (location.hash.startsWith('#/stats/team')) render();
  }

  function teamPage() {
    const teams = teamList();
    if (!teams.length) return hint('You have not joined any teams yet.');
    if (!teams.some(t => t.id === st.tm.id)) st.tm.id = teams[0].id;                    // teams you own come first
    const id = st.tm.id, name = (teams.find(t => t.id === id) || {}).name || 'this team';
    const picker = `<label class="flt">Team<select data-sf="tm.team">${teams.map(t => `<option value="${esc(t.id)}"${t.id === id ? ' selected' : ''}>${esc(t.name)}${t.isOwner ? ' (owner)' : ''}</option>`).join('')}</select></label>`;
    let rec = st.teams[id];
    if (!rec) {
      if (L().store.get('ledger.editkey')) { loadTeam(id); rec = { state: 'loading' }; } else rec = { state: 'locked' };
    }
    const locked = `<section class="card"><h2>Team statistics are private</h2><p class="imp-note">They show what your teammates drove: days, tracks and laps for each driver, so they need your edit key.</p>${rec.message ? hint(esc(rec.message), 'imp-bad') : ''}<div class="sf-actions"><button type="button" class="btn" data-st-unlock>Unlock with edit key</button></div></section>`;
    if (rec.state === 'locked') return filterBar(picker) + locked;
    if (rec.state === 'loading') return filterBar(picker) + hint(`Loading statistics for ${esc(name)}…`, 'imp-hint st-load');
    if (rec.state === 'toobig') return filterBar(picker) + `<section class="card"><h2>${esc(name)}</h2>${hint('This team has too much driving history to load here (over 4 MB of data). Smaller teams, such as OHND Racing, work.')}</section>`;
    if (rec.state === 'error') return filterBar(picker) + `<section class="card"><h2>${esc(name)}</h2>${hint(esc(rec.message || 'This team\'s statistics could not be loaded.'), 'imp-bad')}<div class="sf-actions"><button type="button" class="btn ghost" data-st-team-retry>Try again</button></div></section>`;

    const f = st.tm;
    const rows = S.sessionFilter(S.rangeFilter(rec.rows, f.range), f.sessions);
    const bar = filterBar(picker + rangeSelect('tm', f.range) + sessionBoxes('tm', f.sessions, rec.rows));
    if (!rec.rows.length) return bar + hint('No driving statistics for this team yet.');
    if (!rows.length) return bar + hint('No driving in this time range and session selection.');
    const t = S.totals(rows), months = S.monthlyLaps(rows);
    const who = slug => (rec.members && rec.members.get(slug)) || slug || 'Unknown driver';
    const drivers = S.summarize(rows, r => r.user || '', r => ({ slug: r.user || '' })).map(g => ({ ...g, name: who(g.slug) }));
    const tracks = S.summarize(rows, r => r.trackName, r => ({ name: r.trackName })), cars = S.summarize(rows, r => r.carName + '\u0000' + r.carClass, r => ({ name: r.carName, carClass: r.carClass }));
    const top = (list, n = 15) => (list.length > n ? list.slice(0, n) : list);
    const more = (list, n = 15) => (list.length > n ? hint(`Showing the top ${n} of ${n0(list.length)} by time on track.`) : '');
    return bar
      + tiles([tile('Laps', n0(t.laps)), tile('Clean laps', pct(t.cleanPct), '', `${n0(t.clean)} clean laps`), tile('Time on track', S.fmtDuration(t.hours * 3600)), tile('Events', n0(t.events)), tile('Days driven', n0(t.days)), tile('Drivers', n0(drivers.length))])
      + `<section class="card"><h2>Laps per month</h2>${overlayBars(months.map(m => monthText(m.month)), months.map(m => m.laps), months.map(m => m.clean), 'Team laps per month')}</section>`
      + `<section class="card"><h2>Drivers</h2>${table(groupCols('Driver', x => esc(x.name)), top(drivers, 25), 'Drivers')}${more(drivers, 25)}</section>`
      + `<section class="card"><h2>Tracks</h2>${table(groupCols('Track', x => esc(x.name)), top(tracks), 'Team tracks')}${more(tracks)}</section>`
      + `<section class="card"><h2>Cars</h2>${table(groupCols('Car', x => esc(x.name), [{ label: 'Class', opt: true, get: x => esc(x.carClass) }]), top(cars), 'Team cars')}${more(cars)}</section>`
      + `<p class="st-foot">Team statistics, updated ${esc(clock(rec.at))}. Visible only with your edit key.</p>`;
  }

  /* ---- rendering ---------------------------------------------------------------------------------------------- */
  const pageOf = () => (location.hash.replace(/^#\/stats\/?/, '') || '').split('?')[0];

  async function render(force) {
    const my = ++token;
    const page = ['tracks', 'seasons', 'practice', 'team'].includes(pageOf()) ? pageOf() : '';
    const app = L().app;
    if (!L().apiOk) { app.innerHTML = shell(page, '<div class="empty"><strong>Stats need the live app</strong>This copy is not connected to your Lap Ledger server.</div>'); return; }
    if (!st.data || force) app.innerHTML = shell(page, '<p class="imp-hint st-load">Loading your statistics…</p>');
    try { await loadData(force); }
    catch (e) {
      if (my !== token) return;
      app.innerHTML = shell(page, '<div class="empty"><strong>Statistics did not load</strong>Check your connection, then <button type="button" class="btn ghost sm" data-st-reload>try again</button>.</div>');
      return;
    }
    if (my !== token || !location.hash.startsWith('#/stats')) return;
    const focus = document.activeElement && document.activeElement.dataset ? { sf: document.activeElement.dataset.sf, value: document.activeElement.value } : null;
    const names = st.data.problems && st.data.problems.lookups && page !== '' ? hint('Car and track names did not load, so some are shown by number.', 'imp-bad') : '';
    const empty = !st.rows.length && page !== '' && page !== 'team';
    const body = empty ? '<div class="empty"><strong>No driving statistics yet</strong>Drive a session with Garage61 running, then check back.</div>'
      : { '': overview, tracks: tracksPage, seasons: seasonsPage, practice: practicePage, team: teamPage }[page]();
    app.innerHTML = shell(page, names + body) + (!['tracks', 'seasons', 'practice'].includes(page) || !st.data.generatedAt ? '' : `<p class="st-foot">Statistics from Garage61, updated ${esc(clock(st.data.generatedAt))}.</p>`);
    if (focus && focus.sf) {                                // keep keyboard focus on the control that was just changed
      const sel = `[data-sf="${focus.sf}"]` + (focus.value && focus.sf.endsWith('.session') ? `[value="${CSS.escape(focus.value)}"]` : '');
      const again = app.querySelector(sel); if (again) again.focus();
    }
  }

  /* ---- events ---------------------------------------------------------------------------------------------------- */
  document.addEventListener('change', e => {
    const t = e.target;
    if (!t.dataset || !t.dataset.sf) return;
    const [page, field] = t.dataset.sf.split('.');
    if (field === 'range') st[page].range = t.value;
    else if (field === 'season') st.se.season = t.value;
    else if (field === 'team') st.tm.id = t.value;
    else if (field === 'session') {
      const boxes = [...t.closest('fieldset').querySelectorAll('input[type=checkbox]')];
      const chosen = boxes.filter(b => b.checked).map(b => b.value);
      st[page].sessions = chosen.length === boxes.length ? null : new Set(chosen);
    }
    render();
  });
  document.addEventListener('click', e => {
    if (!location.hash.startsWith('#/stats')) return;
    const view = e.target.closest('[data-st-view]');
    if (view) { st.tc.view = view.dataset.stView; render(); return; }
    if (e.target.closest('[data-st-reload]')) { render(true); return; }
    if (e.target.closest('[data-st-unlock]')) {
      const key = L().editKey();
      if (key) { L().store.set('ledger.editkey', key); delete st.teams[st.tm.id]; render(); }     // kept only if the Worker accepts it (loadTeam clears a wrong one)
      return;
    }
    if (e.target.closest('[data-st-team-retry]')) { delete st.teams[st.tm.id]; render(); }
  });

  window.LedgerStatsUI = { render, state: st };
})();
