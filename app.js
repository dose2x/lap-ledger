(function () {
  'use strict';

  const $app = document.getElementById('app');
  const $banner = document.getElementById('banner');
  const API = String(window.LEDGER_API || '').replace(/[/]+$/, '');
  const PALETTE = ['var(--c-aaron)', 'var(--c-mia)', 'var(--c-dev)', 'var(--c-4)', 'var(--c-5)', 'var(--c-6)'];
  const DRIVER_COLOR = {};            // driver id -> css color, filled after data loads (you first)
  const DRIVER_VAR = DRIVER_COLOR;
  let notesCache = {};

  const state = { mode: 'me', query: '', drivers: null, sel: null, comboId: null, chart: 'line' };
  try { if (localStorage.getItem('ledger.chart') === 'bar') state.chart = 'bar'; } catch (e) { /* storage blocked */ }

  /* ---------- theme ---------- */
  const themeBtn = document.getElementById('theme');
  function syncTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeBtn.setAttribute('aria-checked', String(dark));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#0D131A' : '#111A24';
  }
  syncTheme();
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ledger.theme', next); } catch (e) { /* storage blocked */ }
    syncTheme();
  });
  let DATA = null;
  let chartCtx = null;   // what the chart on screen was drawn from, so a resize can redraw just the chart

  /* ---------- helpers ---------- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = ms => { const m = Math.floor(ms / 60000); const s = (ms % 60000) / 1000; return m + ':' + s.toFixed(3).padStart(6, '0'); };
  const fmtGap = ms => (ms < 0 ? '−' : '+') + (Math.abs(ms) / 1000).toFixed(3);
  const dateStr = at => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const dateLong = at => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const driverOf = id => DATA.drivers.find(d => d.id === id) || { id, name: id, initials: id.slice(0, 2).toUpperCase() };
  const fval = f => (typeof f.value === 'number' ? f.value.toFixed(f.dec) : String(f.value)) + f.unit;
  const notesKey = id => 'ledger.notes.' + id;
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  };

  function visibleLaps(combo, drivers) {          // drivers === null means everyone
    return drivers ? combo.laps.filter(l => drivers.has(l.driver)) : combo.laps;
  }
  const driverRank = id => { const i = DATA.drivers.findIndex(d => d.id === id); return i < 0 ? 999 : i; };
  function bestOf(laps) {
    return laps.reduce((b, l) => (!b || l.ms < b.ms ? l : b), null);
  }

  /* ---------- notes ---------- */
  const getNote = id => (DATA.isSample ? store.get(notesKey(id)) : notesCache[id] || '');
  let noteTimer;
  let pending = null;   // { id, text } waiting for its debounce timer
  function flushNote() {
    if (!pending) return;
    clearTimeout(noteTimer);
    const p = pending; pending = null;
    sendNote(p.id, p.text);
  }
  function saveNote(id, text) {
    const $s = document.getElementById('note-state');
    if (DATA.isSample) {
      const ok = store.set(notesKey(id), text);
      $s.textContent = ok ? 'Saved on this device' : 'Could not save. Browser storage is blocked.';
      return;
    }
    if (pending && pending.id !== id) flushNote();
    notesCache[id] = text;
    pending = { id, text };
    $s.textContent = 'Saving…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNote, 700);
  }
  async function sendNote(id, text) {
    const $s = document.getElementById('note-state');
    const say = msg => { if ($s) $s.textContent = msg; };
    let key = store.get('ledger.editkey');
    if (!key) { key = (prompt('Enter the edit key to save notes') || '').trim(); if (!key) { say('Not saved. An edit key is needed.'); return; } }
    try {
      const res = await fetch(API + '/api/notes/' + id, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json', 'x-edit-key': key }, body: JSON.stringify({ body: text }) });
      if (res.status === 401) { store.set('ledger.editkey', ''); say('Not saved. That edit key was wrong.'); return; }
      if (!res.ok) throw new Error(res.status);
      store.set('ledger.editkey', key);
      say('Saved. Shared with your team');
    } catch (e) { say('Could not save. Check your connection and try again.'); }
  }

  /* ---------- data ---------- */
  async function load() {
    try {
      const res = await fetch(API + '/api/combos', { headers: { accept: 'application/json' } });
      if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
        const live = await res.json();
        if (live.combos && live.combos.length) return live;
        return { ...window.SAMPLE, waiting: true };
      }
    } catch (e) { /* no backend yet */ }
    return window.SAMPLE;
  }

  /* ---------- home ---------- */
  function renderHome() {
    const q = state.query.trim().toLowerCase();
    const mine = new Set([DATA.me]);
    const pool = state.mode === 'me' ? mine : null;
    const rows = DATA.combos
      .map(c => {
        const laps = visibleLaps(c, pool);
        return { c, laps, best: bestOf(laps) };
      })
      .filter(x => x.best && (!q || (x.c.car + ' ' + x.c.track).toLowerCase().includes(q)))
      .sort((a, b) => b.laps[b.laps.length - 1].at - a.laps[a.laps.length - 1].at);

    $app.innerHTML = `
      <div class="find">
        <input id="q" type="search" inputmode="search" autocomplete="off" spellcheck="false"
               placeholder="Search car or track" aria-label="Search car or track" value="${esc(state.query)}">
      </div>
      <p class="count" aria-live="polite">${rows.length} car and track ${rows.length === 1 ? 'combo' : 'combos'}${q ? ' match' : ''}</p>
      ${rows.length ? `<ul class="rows">${rows.map(x => `
        <li><a class="row" href="#/combo/${x.c.id}">
          <span><span class="car">${esc(x.c.car)}</span><br><span class="track">${esc(x.c.track)}</span></span>
          <span><span class="time">${fmt(x.best.ms)}</span>${state.mode === 'team' ? `<div class="who">${esc(driverOf(x.best.driver).name)}</div>` : ''}</span>
          <span class="meta"><span>${x.laps.length} laps</span><span>·</span><span>last driven ${dateStr(x.laps[x.laps.length - 1].at)}</span></span>
        </a></li>`).join('')}</ul>`
        : `<div class="empty"><strong>No combos found</strong>${q ? 'Try a shorter search, like the car model or the track name.' : 'No laps yet. Drive a session in iRacing and sync from Garage61.'}</div>`}`;

    const input = document.getElementById('q');
    input.addEventListener('input', () => {
      state.query = input.value;
      const pos = input.selectionStart;
      renderHome();
      const n = document.getElementById('q');
      n.focus(); n.setSelectionRange(pos, pos);
    });
  }

  /* ---------- detail ---------- */
  function renderDetail(id) {
    const combo = DATA.combos.find(c => c.id === id);
    if (!combo) { location.hash = '#/'; return; }
    if (state.comboId !== id) {
      state.comboId = id;
      state.drivers = new Set(state.mode === 'me' ? [DATA.me] : combo.laps.map(l => l.driver));
      state.sel = null;
    }
    const present = [...new Set(combo.laps.map(l => l.driver))]
      .sort((a, b) => driverRank(a) - driverRank(b)).map(driverOf);
    state.drivers = new Set([...state.drivers].filter(d => present.some(p => p.id === d)));
    if (!state.drivers.size) state.drivers.add(present[0].id);

    const laps = visibleLaps(combo, state.drivers);
    const best = bestOf(laps);
    const first = laps[0];
    if (!state.sel || !laps.some(l => l.id === state.sel)) state.sel = best.id;
    const sel = laps.find(l => l.id === state.sel);

    // status per lap: PB at the time for that driver
    const runBest = {}; const status = {};
    laps.forEach(l => {
      if (runBest[l.driver] == null || l.ms < runBest[l.driver]) { status[l.id] = 'pb'; runBest[l.driver] = l.ms; }
    });
    status[best.id] = 'best';

    const multi = state.drivers.size > 1;
    const gainMs = first && !multi ? first.ms - best.ms : null;

    $app.innerHTML = `
      <a class="back" href="#/">← All combos</a>
      <h1 class="combo">${esc(combo.car)}</h1>
      <p class="combo-track">${esc(combo.track)}</p>

      <div class="stats">
        <div><div class="label">Best lap${multi ? ' · ' + esc(driverOf(best.driver).name) : ''}</div><div class="best-time">${fmt(best.ms)}</div></div>
        <div class="sub">
          <div><span class="label">Laps</span><b>${laps.length}</b></div>
          ${gainMs != null && gainMs > 0 ? `<div><span class="label">Gained since lap 1</span><b class="gain">${fmtGap(-gainMs)}</b></div>` : ''}
          <div><span class="label">Last driven</span><b style="font-size:17px">${dateLong(laps[laps.length - 1].at)}</b></div>
        </div>
      </div>

      ${present.length > 1 ? `<div class="chips" role="group" aria-label="Drivers shown">${present.map(d => `
        <button class="chip" type="button" data-driver="${d.id}" aria-pressed="${state.drivers.has(d.id)}" style="--c:${DRIVER_COLOR[d.id] || '#555'}"><i></i>${esc(d.name)}</button>`).join('')}</div>` : ''}

      <section class="card" aria-labelledby="h-prog">
        <div class="card-head">
          <h2 id="h-prog">Progress</h2>
          <div class="seg sm" role="group" aria-label="Graph type">
            <button type="button" data-chart="line" aria-pressed="${state.chart === 'line'}">Line</button>
            <button type="button" data-chart="bar" aria-pressed="${state.chart === 'bar'}">Bars</button>
          </div>
        </div>
        <p class="hint">${state.chart === 'bar' ? 'Taller bar is a faster lap. ' : 'Lower is faster. '}Tap a lap to see its setup.</p>
        <div id="chart"></div>
        <div class="legend">
          <span><i style="background:var(--best)"></i>Best lap</span>
          <span><i style="background:var(--pb)"></i>New personal best</span>
          <span><i style="background:#9AA6B2"></i>Other laps</span>
        </div>
      </section>

      <div class="two">
        <section class="card" aria-labelledby="h-laps">
          <h2 id="h-laps">Laps<small>Newest first</small></h2>
          <ul class="laps">${laps.slice().reverse().map(l => `
            <li><button class="lap" type="button" data-lap="${l.id}" ${l.id === state.sel ? 'aria-current="true"' : ''} style="--c:${DRIVER_COLOR[l.driver] || '#555'}">
              <span class="d">${dateStr(l.at)}</span>
              <span class="who-cell"><span class="t">${fmt(l.ms)}</span>${status[l.id] === 'best' ? '<span class="tag best">Best</span>' : status[l.id] === 'pb' ? '<span class="tag pb">PB</span>' : ''}${multi ? `<span class="dr">${esc(driverOf(l.driver).initials)}</span>` : ''}</span>
              <span class="g">${l.id === best.id ? '' : fmtGap(l.ms - best.ms)}</span>
            </button></li>`).join('')}</ul>
        </section>

        <section class="card" aria-labelledby="h-set">
          <h2 id="h-set">Setup</h2>
          ${setupHtml(combo, sel, best)}
        </section>
      </div>

      <section class="card" aria-labelledby="h-notes">
        <h2 id="h-notes">Notes</h2>
        <textarea id="notes" aria-label="Notes for this car and track" placeholder="What works here? Example: understeers in T3, try a softer front bar.">${esc(getNote(combo.id))}</textarea>
        <div class="note-foot"><span id="note-state">${DATA.isSample ? 'Saved on this device' : 'Shared with your team'}</span><button class="btn ghost" type="button" id="share">Copy link to this combo</button></div>
      </section>`;

    chartCtx = { laps, status, selId: sel.id, multi };
    drawChart(document.getElementById('chart'), laps, status, sel.id, multi);
  }

  function setupHtml(combo, lap, best) {
    const setup = combo.setups[lap.setupId];
    if (!setup) return '<div class="empty"><strong>No setup stored for this lap</strong>The Garage61 public API does not share setups yet, so setups have to be added another way.</div>';
    const ref = combo.setups[best.setupId];
    const same = lap.setupId === best.setupId;
    const refMap = {};
    if (ref) ref.sections.forEach(s => s.fields.forEach(f => { refMap[s.title + '|' + f.name] = f; }));
    let changes = 0;
    const secs = setup.sections.map(s => `
      <div class="sec"><h3>${esc(s.title)}</h3><dl>${s.fields.map(f => {
        const r = refMap[s.title + '|' + f.name];
        const diff = !same && r && String(r.value) !== String(f.value);
        if (diff) changes++;
        return `<div class="f${diff ? ' changed' : ''}"><dt>${esc(f.name)}</dt><dd>${fval(f)}${diff ? `<span class="was">best lap: ${fval(r)}</span>` : ''}</dd></div>`;
      }).join('')}</dl></div>`).join('');
    const head = same
      ? `Setup from the best lap, <b>${fmt(lap.ms)}</b>`
      : !ref
      ? `Setup from <b>${fmt(lap.ms)}</b> on ${dateStr(lap.at)}. Your best lap has no stored setup to compare against.`
      : `Setup from <b>${fmt(lap.ms)}</b> on ${dateStr(lap.at)}. ${changes ? `${changes} ${changes === 1 ? 'value differs' : 'values differ'} from your best lap.` : 'Same values as your best lap.'}`;
    return `<p class="sheet-head">${head}</p><div class="sections">${secs}</div>`;
  }

  /* ---------- chart ---------- */
  function drawChart(el, laps, status, selId, multi) {
    const W = Math.max(280, el.clientWidth || 340);
    const H = Math.round(Math.min(320, Math.max(230, W * 0.5)));
    const pad = { l: 58, r: 12, t: 22, b: 26 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const bars = state.chart === 'bar';
    const n = laps.length;
    const ts = laps.map(l => l.ms);
    const best = Math.min(...ts);
    const sorted = ts.slice().sort((a, b) => a - b);
    let hi = sorted[Math.min(n - 1, Math.floor(n * 0.92))];
    if (hi - best < 600) hi = best + 600;
    const lo = best - (hi - best) * 0.1;
    hi += (hi - best) * 0.06;
    const X = i => bars ? pad.l + (i + 0.5) / n * pw : pad.l + (n === 1 ? pw / 2 : i / (n - 1) * pw);
    // Line: slower is higher, so improving laps trend down. Bars: taller is faster.
    const Y = bars ? t => pad.t + (Math.min(t, hi) - lo) / (hi - lo) * ph
                   : t => pad.t + (hi - Math.min(t, hi)) / (hi - lo) * ph;
    const floor = pad.t + ph;
    const mono = 'font-family="JetBrains Mono,monospace"';

    let g = '';
    for (let k = 0; k <= 3; k++) {
      const t = lo + (hi - lo) * k / 3;
      const y = Y(t);
      g += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>` +
        `<text class="tick" x="${pad.l - 8}" y="${y + 4}" text-anchor="end" ${mono} font-size="11">${fmt(Math.round(t))}</text>`;
    }

    const colorOf = (l, cls) => {
      if (cls === 'best') return 'var(--best)';
      if (cls === 'pb') return multi ? (DRIVER_VAR[l.driver] || 'var(--ink)') : 'var(--pb)';
      return 'var(--dot)';
    };

    if (bars) {
      const gap = n > 45 ? 1 : 2;
      const bw = Math.max(2, pw / n - gap);
      laps.forEach((l, i) => {
        const cls = status[l.id];
        const y = Y(l.ms);
        g += `<rect class="pt${l.id === selId ? ' sel' : ''}" data-lap="${l.id}" x="${X(i) - bw / 2}" y="${y}" width="${bw}" height="${Math.max(2, floor - y)}" rx="1.5" style="fill:${colorOf(l, cls)}" tabindex="0" role="button" aria-label="Lap ${fmt(l.ms)}, ${dateStr(l.at)}"/>`;
      });
    } else {
      // straight line from each personal best to the next, one line per driver
      [...new Set(laps.map(l => l.driver))].forEach(d => {
        let cur = Infinity, path = '', len = 0, px = 0, py = 0;
        laps.forEach((l, i) => {
          if (l.driver !== d || l.ms >= cur) return;
          const x = X(i), y = Y(l.ms);
          if (!path) path = `M${x},${y}`; else { path += ` L${x},${y}`; len += Math.hypot(x - px, y - py); }
          px = x; py = y; cur = l.ms;
        });
        if (len) g += `<path class="trend" d="${path}" style="stroke:${DRIVER_VAR[d] || 'var(--ink)'};--len:${Math.ceil(len) + 4}"/>`;
      });
      const order = { undefined: 0, pb: 1, best: 2 };
      laps.map((l, i) => [l, i]).sort((a, b) => order[status[a[0].id]] - order[status[b[0].id]]).forEach(([l, i]) => {
        const cls = status[l.id];
        const r = cls === 'best' ? 6.5 : cls === 'pb' ? 4.5 : 3;
        const x = X(i), y = Y(l.ms);
        if (l.id === selId) g += `<circle class="ring" cx="${x}" cy="${y}" r="${r + 5}"/>`;
        g += `<circle class="pt" data-lap="${l.id}" cx="${x}" cy="${y}" r="${r}" style="fill:${colorOf(l, cls)}" tabindex="0" role="button" aria-label="Lap ${fmt(l.ms)}, ${dateStr(l.at)}"/>`;
      });
    }

    const by = Y(best);
    g += `<line class="bestline" x1="${pad.l}" x2="${W - pad.r}" y1="${by}" y2="${by}" stroke-width="1.5" stroke-dasharray="5 4"/>` +
      `<text class="bestlabel" x="${pad.l + 6}" y="${by - 7}" ${mono} font-size="11" font-weight="600">BEST ${fmt(best)}</text>` +
      `<text class="tick" x="${pad.l}" y="${H - 6}" font-size="11">${dateStr(laps[0].at)}</text>` +
      `<text class="tick" x="${W - pad.r}" y="${H - 6}" text-anchor="end" font-size="11">${dateStr(laps[n - 1].at)}</text>`;

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="${bars ? 'Bar graph of lap times, taller bars are faster laps' : 'Line graph of lap times, lower is faster'}">${g}</svg>`;
  }

  /* ---------- events ---------- */
  function selectLap(id) { state.sel = id; route(); }

  document.addEventListener('click', e => {
    const mode = e.target.closest('[data-mode]');
    if (mode) {
      state.mode = mode.dataset.mode;
      state.comboId = null;
      document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === mode)));
      return route();
    }
    const ct = e.target.closest('[data-chart]');
    if (ct) {
      state.chart = ct.dataset.chart;
      try { localStorage.setItem('ledger.chart', state.chart); } catch (err) { /* storage blocked */ }
      return route();
    }
    const chip = e.target.closest('[data-driver]');
    if (chip) {
      const d = chip.dataset.driver;
      if (state.drivers.has(d)) { if (state.drivers.size > 1) state.drivers.delete(d); } else state.drivers.add(d);
      return route();
    }
    const lap = e.target.closest('[data-lap]');
    if (lap) return selectLap(lap.dataset.lap);
    if (e.target.id === 'share') {
      const url = location.href;
      const done = () => { const s = document.getElementById('note-state'); if (s) s.textContent = 'Link copied'; };
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(done, () => { prompt('Copy this link', url); });
    }
  });
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains("pt")) {
      e.preventDefault(); selectLap(e.target.dataset.lap);
    }
  });
  document.addEventListener('input', e => {
    if (e.target.id !== 'notes') return;
    saveNote(state.comboId, e.target.value);
  });

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const el = document.getElementById('chart');
      const svg = el && el.firstElementChild;
      // The phone keyboard and the address bar fire resize without changing the width; leave the page alone then.
      if (!chartCtx || !svg || Math.abs(el.clientWidth - svg.getAttribute('width')) < 2) return;
      drawChart(el, chartCtx.laps, chartCtx.status, chartCtx.selId, chartCtx.multi);
    }, 150);
  });
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNote(); });
  window.addEventListener('pagehide', flushNote);

  function route() {
    flushNote();
    const m = location.hash.match(/^#\/combo\/(.+)$/);
    if (m) renderDetail(m[1]); else { state.comboId = null; renderHome(); }
  }

  /* ---------- boot ---------- */
  load().then(async d => {
    DATA = d;
    const order = [d.me, ...d.drivers.map(x => x.id).filter(x => x !== d.me)].filter(Boolean);
    order.forEach((id, i) => { DRIVER_COLOR[id] = PALETTE[i % PALETTE.length]; });
    if (!d.isSample) {
      try { const r = await fetch(API + '/api/notes'); if (r.ok) notesCache = await r.json(); } catch (e) { /* notes load later */ }
    }
    if (d.isSample) {
      $banner.hidden = false;
      $banner.innerHTML = `<span>Sample data. ${d.waiting ? 'No laps have synced from Garage61 yet.' : 'Garage61 is not connected yet.'}</span>`;
    }
    route();
  });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && location.hostname !== 'localhost') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
