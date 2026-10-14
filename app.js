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
    const key = editKey();
    if (!key) { say('Not saved. An edit key is needed.'); return; }
    try {
      const res = await fetch(API + '/api/notes/' + id, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json', 'x-edit-key': key }, body: JSON.stringify({ body: text }) });
      if (res.status === 401) { store.set('ledger.editkey', ''); say('Not saved. That edit key was wrong.'); return; }
      if (res.status === 429) { say(await lockoutText(res)); return; }
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
        if (live.combos && live.combos.length) return { ...live, apiOk: true };
        return { ...window.SAMPLE, waiting: true, apiOk: true };
      }
    } catch (e) { /* no backend yet */ }
    return window.SAMPLE;
  }

  /* ---------- setup files (.sto) ---------- */
  // iRacing's .sto format is not readable outside iRacing, so a setup is kept as the file itself (to download and
  // load back into the sim) plus a short note of the key values. Sample mode keeps files on this device only.
  const MAX_SETUP_BYTES = 512 * 1024;
  const localFiles = id => { try { return JSON.parse(store.get('ledger.files.' + id) || '[]'); } catch (e) { return []; } };
  const filesOf = combo => (DATA.isSample ? localFiles(combo.id) : combo.files || []);
  const kb = n => (n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB');
  const fileHref = f => (DATA.isSample ? 'data:application/octet-stream;base64,' + f.b64 : API + '/api/setup-files/' + f.id);
  const fileToB64 = f => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(f);
  });
  // After too many wrong keys the Worker answers 429 with a message saying how long to wait.
  const lockoutText = async res => (await res.json().catch(() => ({}))).error || 'Too many wrong keys. Try again in a few minutes.';
  function editKey() {
    let key = store.get('ledger.editkey');
    if (!key) key = (prompt('Enter the edit key to save changes') || '').trim();
    return key;
  }
  // Keeps the setup form (chosen file, typed note, checkbox) when the page re-renders, e.g. after tapping a lap.
  function captureSetupForm(comboId) {
    const f = document.getElementById('sf-form');
    if (!f || f.dataset.combo !== comboId) return null;
    const file = f.file.files[0], note = f.note.value, attach = f.attach.checked;
    return file || note || !attach ? { file, note, attach } : null;
  }
  function restoreSetupForm(kept) {
    const f = kept && document.getElementById('sf-form');
    if (!f) return;
    if (kept.file) { const dt = new DataTransfer(); dt.items.add(kept.file); f.file.files = dt.files; }
    f.note.value = kept.note;
    f.attach.checked = kept.attach;
  }

  function filesHtml(combo, sel) {
    const files = filesOf(combo).slice().sort((a, b) => (b.lapId === sel.id) - (a.lapId === sel.id) || b.at - a.at);
    const rows = files.map(f => {
      const lap = f.lapId && combo.laps.find(l => l.id === f.lapId);
      const here = f.lapId === sel.id;
      return `<li class="sfile${here ? ' here' : ''}">
        <div class="sf-main">
          <a class="sf-name" href="${esc(fileHref(f))}" download="${esc(f.name)}">${esc(f.name)}</a>
          ${here ? '<span class="tag pb">This lap</span>' : ''}
          <span class="sf-meta">${kb(f.size)} · added ${dateLong(f.at)}${lap ? ` · used on ${fmt(lap.ms)} (${dateStr(lap.at)})` : ''}</span>
        </div>
        ${f.note ? `<p class="sf-note">${esc(f.note)}</p>` : ''}
        <button class="btn ghost sm" type="button" data-del-file="${esc(f.id)}">Delete</button>
      </li>`;
    }).join('');
    return `<div class="sfiles">
      <h3 class="sf-h">Setup files</h3>
      ${rows ? `<ul class="sf-list">${rows}</ul>` : '<p class="sf-empty">No setup files yet. Add the .sto file you used here, then download it later to load it back into iRacing.</p>'}
      <form id="sf-form" class="sf-form" data-combo="${esc(combo.id)}">
        <label class="sf-field">Setup file (.sto)<input type="file" name="file" accept=".sto" required></label>
        <label class="sf-field">Key values or what changed<textarea name="note" rows="2" maxlength="500" placeholder="Example: rear wing 8, front ARB 3, brake bias 54.5"></textarea></label>
        <label class="sf-check"><input type="checkbox" name="attach" checked> Used on the selected lap, <b>${fmt(sel.ms)}</b></label>
        <div class="sf-actions"><button class="btn" type="submit">Add setup file</button><span id="sf-state" role="status"></span></div>
      </form>
    </div>`;
  }

  async function addSetupFile(form) {
    const say = m => { const s = document.getElementById('sf-state'); if (s) s.textContent = m; };
    const file = form.file.files[0];
    if (!file) return say('Choose a .sto file first.');
    if (!file.name.toLowerCase().endsWith('.sto')) return say('Only iRacing setup files (.sto) can be added.');
    if (file.size > MAX_SETUP_BYTES) return say('That file is over 512 KB.');
    const comboId = state.comboId;              // read once: the user may navigate while the upload is in flight
    const lapId = form.attach.checked ? state.sel : '';
    const note = form.note.value.trim();
    say('Adding…');
    try {
      if (DATA.isSample) {
        const list = localFiles(comboId);
        if (list.reduce((n, f) => n + f.size, 0) + file.size > 150 * 1024) return say('Sample mode keeps files on this device only, up to about 150 KB.');
        list.push({ id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), lapId, name: file.name, size: file.size, note, at: Date.now(), b64: await fileToB64(file) });
        if (!store.set('ledger.files.' + comboId, JSON.stringify(list))) return say('Could not save. Browser storage is blocked.');
      } else {
        const key = editKey();
        if (!key) return say('Not added. An edit key is needed.');
        const body = new FormData();
        body.append('file', file);
        body.append('lap', lapId);
        body.append('note', note);
        const res = await fetch(API + '/api/combos/' + comboId + '/setup-files', { method: 'POST', headers: { 'x-edit-key': key }, body });
        if (res.status === 401) { store.set('ledger.editkey', ''); return say('Not added. That edit key was wrong.'); }
        if (res.status === 429) return say(await lockoutText(res));
        if (!res.ok) return say((await res.json().catch(() => ({}))).error || 'Could not add the file. Try again.');
        store.set('ledger.editkey', key);
        // The server's reply describes the stored file, so the list can be updated without another request.
        const added = await res.json();
        const combo = DATA.combos.find(c => c.id === comboId);
        if (combo) combo.files = [added, ...(combo.files || [])];
      }
      form.reset();
      route();
    } catch (e) { say('Could not add the file. Check your connection and try again.'); }
  }

  async function deleteSetupFile(id) {
    if (!confirm('Delete this setup file?')) return;
    const comboId = state.comboId;
    try {
      if (DATA.isSample) {
        store.set('ledger.files.' + comboId, JSON.stringify(localFiles(comboId).filter(f => f.id !== id)));
      } else {
        const key = editKey();
        if (!key) return;
        const res = await fetch(API + '/api/setup-files/' + id, { method: 'DELETE', headers: { 'x-edit-key': key } });
        if (res.status === 401) { store.set('ledger.editkey', ''); return alert('That edit key was wrong.'); }
        if (res.status === 429) return alert(await lockoutText(res));
        if (!res.ok) throw new Error(res.status);
        store.set('ledger.editkey', key);
        const combo = DATA.combos.find(c => c.id === comboId);
        if (combo) combo.files = (combo.files || []).filter(f => f.id !== id);
      }
      route();
    } catch (e) { alert('Could not delete the file. Check your connection and try again.'); }
  }

  /* ---------- import laps (Garage61 CSV export) ---------- */
  // Garage61's export lists the laps but not which car or track they belong to, so the user picks both. The Worker
  // stores them as imported laps and the Garage61 sync replaces them once the API returns the same laps.
  const imp = {
    parsed: null, catalog: null, maps: null, items: null, byId: null, candidates: [],
    sel: { cars: null, tracks: null }, active: -1, reading: 0,
    ready: Promise.resolve(), markReady: () => {}            // settles once the car and track list has loaded
  };
  const SESSION_NAMES = { 1: 'Practice', 2: 'Qualifying', 3: 'Race' };
  const dayLabel = day => new Date(day + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function parseExport(text) {
    const table = parseCsv(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text).filter(r => r.some(c => c.trim()));
    if (!table.length) return { error: 'That file is empty.' };
    const head = table[0].map(h => h.trim().toLowerCase());
    const col = name => head.indexOf(name);
    const missing = ['lap time', 'started at', 'driver'].filter(n => col(n) < 0);
    if (missing.length) return { error: 'This does not look like a Garage61 lap export. Missing columns: ' + missing.join(', ') + '.' };
    const iT = col('lap time'), iAt = col('started at'), iDr = col('driver'), iClean = col('clean'), iAir = col('air temperature'), iTrack = col('track temp');
    const laps = [];
    let unclean = 0, badTime = 0, badDate = 0, noDriver = 0;
    for (const r of table.slice(1)) {
      const t = parseLapTime(r[iT]), driver = (r[iDr] || '').trim(), at = (r[iAt] || '').trim();
      if (!(t > 5 && t < 3600)) { badTime++; continue; }
      if (!Number.isFinite(Date.parse(at))) { badDate++; continue; }
      if (!driver) { noDriver++; continue; }
      if (iClean >= 0 && !['1', 'true'].includes((r[iClean] || '').trim().toLowerCase())) { unclean++; continue; }
      laps.push({ t, at, driver, air: iAir >= 0 ? r[iAir] : null, track: iTrack >= 0 ? r[iTrack] : null });
    }
    return {
      laps, total: table.length - 1, unclean, badTime, badDate, noDriver, unreadable: badTime + badDate + noDriver,
      drivers: [...new Set(laps.map(l => l.driver))], best: laps.length ? Math.min(...laps.map(l => l.t)) : null
    };
  }

  // Garage61 writes lap times in seconds ("90.532"); also accepts minutes and seconds ("1:30.532").
  function parseLapTime(text) {
    const s = String(text == null ? '' : text).trim();
    const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s);
    return m ? Number(m[1]) * 60 + Number(m[2]) : (s === '' ? NaN : Number(s));
  }

  function summaryHtml(p) {
    if (!p) return '';
    if (p.error) return `<p class="imp-bad">${esc(p.error)}</p>`;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const left = [];
    if (p.unclean) left.push(plural(p.unclean, 'unclean lap', 'unclean laps'));
    if (p.badTime) left.push(plural(p.badTime, 'row with a lap time that could not be read', 'rows with lap times that could not be read'));
    if (p.badDate) left.push(plural(p.badDate, 'row with a start time that could not be read', 'rows with start times that could not be read'));
    if (p.noDriver) left.push(plural(p.noDriver, 'row with no driver', 'rows with no driver'));
    const leftText = left.length ? ` Left out: ${left.join(', ')}.` : '';
    if (!p.laps.length) {
      return `<p class="imp-bad">Nothing in this file can be imported.${leftText}${p.badTime || p.badDate ? ' If the times look normal in the file, the export format may have changed.' : ''}</p>`;
    }
    return `<p><b>${plural(p.laps.length, 'clean lap', 'clean laps')}</b> will be imported.${leftText}
      Driver${p.drivers.length === 1 ? '' : 's'}: ${p.drivers.map(esc).join(', ')}. Best lap <b class="mono">${fmt(Math.round(p.best * 1000))}</b>.</p>`;
  }

  // Name the user types or picks -> catalog id. A name shared by several entries gets its id appended.
  function labelMap(list, label) {
    const seen = {};
    list.forEach(x => { const k = label(x).toLowerCase(); seen[k] = (seen[k] || 0) + 1; });
    const map = new Map();
    list.forEach(x => { let l = label(x); if (seen[l.toLowerCase()] > 1) l += ' #' + x.id; map.set(l.toLowerCase(), { id: x.id, label: l }); });
    return map;
  }

  async function renderImport() {
    imp.parsed = null;
    imp.reading++;                                        // a file still being read belongs to the old page
    imp.ready = new Promise(resolve => { imp.markReady = resolve; });
    const head = '<a class="back" href="#/">← All combos</a><h1 class="combo">Import laps</h1><p class="combo-track">From a Garage61 export file</p>';
    if (!DATA.apiOk) {
      $app.innerHTML = head + '<div class="empty"><strong>Importing needs the live app</strong>This copy is not connected to your Lap Ledger server, so there is nowhere to save the laps.</div>';
      return;
    }
    $app.innerHTML = head + `
      <section class="card">
        <form id="imp-form" class="sf-form" novalidate>
          <p class="hint">In Garage61, export the laps for one car and track as a CSV file, then choose it here. The file does not say which car and track it is for, so you pick them below.</p>
          <label class="sf-field">Export file (.csv)<input id="imp-file" type="file" accept=".csv,text/csv"></label>
          <div id="imp-summary" class="imp-summary" aria-live="polite"></div>
          <div id="imp-suggest" class="imp-suggest" aria-live="polite"></div>
          <div class="pick">
            <label class="sf-field">Car<input id="imp-car" name="car" data-pick="cars" role="combobox" aria-expanded="false" aria-controls="imp-car-list" autocomplete="off" spellcheck="false" placeholder="Search, for example Mercedes"></label>
            <ul id="imp-car-list" class="pick-list" role="listbox" hidden></ul>
          </div>
          <div class="pick">
            <label class="sf-field">Track<input id="imp-track" name="track" data-pick="tracks" role="combobox" aria-expanded="false" aria-controls="imp-track-list" autocomplete="off" spellcheck="false" placeholder="Search, for example Interlagos or Mugello"></label>
            <ul id="imp-track-list" class="pick-list" role="listbox" hidden></ul>
          </div>
          <div class="sf-actions"><button class="btn" type="submit" id="imp-go">Import laps</button><span id="imp-state" role="status"></span></div>
        </form>
      </section>`;
    if (!imp.catalog) {
      try { const r = await fetch(API + '/api/catalog'); if (r.ok) imp.catalog = await r.json(); } catch (e) { /* shown below */ }
    }
    if (!document.getElementById('imp-car')) return;      // the user moved on while the list loaded
    if (!imp.catalog || !imp.catalog.cars.length) {
      document.getElementById('imp-state').textContent = 'The car and track list is not available yet. Run a sync once, then reload this page.';
      imp.markReady();
      return;
    }
    const build = (map, alias) => [...map.values()].map(v => ({ id: v.id, label: v.label, hay: norm(v.label + ' ' + alias(v.label)) }));
    imp.maps = {
      cars: labelMap(imp.catalog.cars, c => c.name),
      tracks: labelMap(imp.catalog.tracks, t => (t.variant ? `${t.name} (${t.variant})` : t.name))
    };
    imp.items = { cars: build(imp.maps.cars, () => ''), tracks: build(imp.maps.tracks, trackAlias) };
    imp.byId = {
      cars: new Map([...imp.maps.cars.values()].map(v => [v.id, v.label])),
      tracks: new Map([...imp.maps.tracks.values()].map(v => [v.id, v.label]))
    };
    imp.sel = { cars: null, tracks: null };
    imp.active = -1;
    imp.markReady();
    // The user may have started typing while the list loaded; show their suggestions now.
    const typing = document.activeElement;
    if (typing && typing.dataset && typing.dataset.pick && typing.value) showPicks(typing);
  }

  /* Car and track search: ignores accents and capitals, matches words in any order, knows common nicknames. */
  const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const TRACK_ALIASES = [
    ['jose carlos pace', 'interlagos sao paulo brazil'], ['hermanos rodriguez', 'mexico city'], ['enzo e dino ferrari', 'imola'],
    ['circuit of the americas', 'cota austin texas'], ['gilles villeneuve', 'montreal canada'], ['sarthe', 'le mans'],
    ['spa-francorchamps', 'spa belgium'], ['catalunya', 'barcelona spain'], ['red bull ring', 'spielberg austria'],
    ['hungaroring', 'budapest hungary'], ['zandvoort', 'netherlands holland'], ['okayama', 'japan'], ['suzuka', 'japan'],
    ['silverstone', 'england uk'], ['brands hatch', 'england uk'], ['donington', 'england uk'], ['oulton park', 'england uk'],
    ['lime rock', 'connecticut'], ['road atlanta', 'braselton georgia'], ['watkins glen', 'new york'], ['laguna seca', 'monterey california'],
    ['daytona', 'florida'], ['sebring', 'florida'], ['indianapolis', 'indy']
  ];
  const trackAlias = label => { const n = norm(label); return TRACK_ALIASES.filter(([k]) => n.includes(k)).map(a => a[1]).join(' '); };
  const PICK_MAX = 8;

  function pickMatches(kind, query) {
    const words = norm(query).split(' ').filter(Boolean);
    if (!words.length || !imp.items) return [];
    return imp.items[kind].filter(it => words.every(w => it.hay.includes(w)));
  }
  function showPicks(input) {
    const kind = input.dataset.pick;
    const list = document.getElementById(input.getAttribute('aria-controls'));
    if (!imp.items) {                                     // the car and track list is still loading
      list.innerHTML = '<li class="pick-more">Loading the list…</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      return;
    }
    const all = pickMatches(kind, input.value), shown = all.slice(0, PICK_MAX);
    imp.active = shown.length ? 0 : -1;
    list.innerHTML = shown.map((it, i) => `<li role="option" id="${list.id}-${i}" aria-selected="${i === 0}"><button type="button" tabindex="-1" data-pick-id="${it.id}" data-pick-kind="${kind}" data-pick-label="${esc(it.label)}">${esc(it.label)}</button></li>`).join('')
      + (all.length > PICK_MAX ? `<li class="pick-more">${all.length - PICK_MAX} more. Type more words to narrow it down.</li>` : '')
      + (!all.length && input.value.trim() ? '<li class="pick-more">No match. Try fewer words, or the track\'s nickname.</li>' : '');
    list.hidden = !list.innerHTML;
    input.setAttribute('aria-expanded', String(!list.hidden));
  }
  function hidePicks(input) {
    const list = document.getElementById(input.getAttribute('aria-controls'));
    if (list) list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }
  function choosePick(kind, id, label) {
    const input = document.querySelector(`[data-pick="${kind}"]`);
    input.value = label;
    imp.sel[kind] = id;
    hidePicks(input);
  }
  function movePick(input, step) {
    const list = document.getElementById(input.getAttribute('aria-controls'));
    const buttons = [...list.querySelectorAll('button')];
    if (!buttons.length) return;
    imp.active = (imp.active + step + buttons.length) % buttons.length;
    buttons.forEach((b, i) => b.parentElement.setAttribute('aria-selected', String(i === imp.active)));
    buttons[imp.active].scrollIntoView({ block: 'nearest' });
  }

  async function onImportFile(file) {
    const box = document.getElementById('imp-summary');
    const ticket = ++imp.reading;                         // only the newest file chosen may set the result
    const suggest = document.getElementById('imp-suggest');
    if (suggest) suggest.innerHTML = '';
    if (!file) { imp.parsed = null; if (box) box.innerHTML = ''; return; }
    imp.parsed = null;
    if (box) box.innerHTML = '';
    const parsed = file.size > 2 * 1024 * 1024
      ? { error: 'That file is over 2 MB, which is too large for a lap export.' }
      : parseExport(await file.text());
    if (ticket !== imp.reading) return;
    imp.parsed = parsed;
    if (box) box.innerHTML = summaryHtml(imp.parsed);
    offerSuggestion(ticket);
  }

  /* Suggesting the car and track: the export names neither, but its dates and clean-lap count can be matched against
     the driver's own Garage61 driving history (done by the Worker). It is only a suggestion; the fields stay editable. */
  function offerSuggestion(ticket) {
    const box = document.getElementById('imp-suggest');
    const p = imp.parsed;
    if (!box || !p || p.error || !p.laps.length) return;
    if (store.get('ledger.editkey')) runSuggestion(ticket, store.get('ledger.editkey'));
    else box.innerHTML = '<button type="button" class="btn ghost sm" data-suggest>Suggest the car and track from my Garage61 history</button>';   // asking for the key unprompted would surprise
  }

  async function runSuggestion(ticket, key) {
    const box = document.getElementById('imp-suggest');
    const p = imp.parsed;
    const note = (text, cls = 'imp-hint') => { if (box && ticket === imp.reading) box.innerHTML = `<p class="${cls}">${text}</p>`; };
    note('Checking your Garage61 driving history…');
    await imp.ready;
    if (ticket !== imp.reading || !box) return;
    if (!imp.byId) return note('The car and track list is not available, so nothing can be suggested.');
    const days = [...new Set(p.laps.map(l => new Date(l.at).toISOString().slice(0, 10)))].sort();
    try {
      const res = await fetch(API + '/api/guess-combo', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-edit-key': key },
        body: JSON.stringify({ days, clean: p.laps.length, rows: p.total })
      });
      if (ticket !== imp.reading) return;
      if (res.status === 401) { store.set('ledger.editkey', ''); return note('That edit key was wrong, so nothing was suggested.'); }
      if (res.status === 429) return note(await lockoutText(res));
      const out = await res.json().catch(() => ({}));
      if (!res.ok) return note((out.error || 'Your driving history could not be checked.') + ' Pick the car and track yourself.');
      store.set('ledger.editkey', key);
      showCandidates((out.candidates || []).filter(c => imp.byId.cars.has(c.car) && imp.byId.tracks.has(c.track)), ticket);
    } catch (e) { note('Your driving history could not be checked. Pick the car and track yourself.'); }
  }

  function candidateText(c) {
    const when = c.days.length > 1 ? `${dayLabel(c.days[0])} to ${dayLabel(c.days[c.days.length - 1])}` : dayLabel(c.days[0]);
    const what = c.match === 'session' ? SESSION_NAMES[c.session] || 'Session' : 'all sessions that day';
    return `<b>${esc(imp.byId.cars.get(c.car))}</b> at <b>${esc(imp.byId.tracks.get(c.track))}</b> (${what}, ${c.clean} clean ${c.clean === 1 ? 'lap' : 'laps'}, ${when})`;
  }

  function applyCandidate(c) {
    choosePick('cars', c.car, imp.byId.cars.get(c.car));
    choosePick('tracks', c.track, imp.byId.tracks.get(c.track));
    const box = document.getElementById('imp-suggest');
    if (box) box.innerHTML = `<p class="imp-ok">Matched from your Garage61 history: ${candidateText(c)}. Change them below if this is wrong.</p>`;
  }

  function showCandidates(list, ticket) {
    const box = document.getElementById('imp-suggest');
    if (!box || ticket !== imp.reading) return;
    imp.candidates = list;
    if (!list.length) {
      box.innerHTML = '<p class="imp-hint">No match in your Garage61 driving history. It only knows your own laps, so pick the car and track yourself.</p>';
      return;
    }
    const untouched = !imp.sel.cars && !imp.sel.tracks && !document.getElementById('imp-car').value.trim() && !document.getElementById('imp-track').value.trim();
    if (list.length === 1 && untouched) return applyCandidate(list[0]);
    box.innerHTML = `<p class="imp-hint">${list.length === 1 ? 'Your Garage61 history suggests:' : 'More than one session in your history fits. Which is this export?'}</p>
      <div class="imp-cands">${list.map((c, i) => `<button type="button" class="btn ghost" data-suggest-pick="${i}">${candidateText(c)}</button>`).join('')}</div>`;
  }

  async function runImport(form) {
    const say = m => { const s = document.getElementById('imp-state'); if (s) s.textContent = m; };
    const p = imp.parsed;
    if (!p || p.error || !p.laps.length) return say('Choose a Garage61 export file with clean laps first.');
    if (!imp.maps) return say('The car and track list is not loaded yet.');
    // A choice made from the list, or a full name typed exactly (accents and capitals aside).
    const resolve = (kind, input) => imp.sel[kind] || (imp.items[kind].find(it => norm(it.label) === norm(input.value.trim())) || {}).id;
    const car = resolve('cars', form.car);
    const track = resolve('tracks', form.track);
    if (!car) return say('Pick the car from the suggestions.');
    if (!track) return say('Pick the track from the suggestions.');
    const key = editKey();
    if (!key) return say('Not imported. An edit key is needed.');
    const go = document.getElementById('imp-go');
    go.disabled = true;
    let added = 0, skipped = 0;
    try {
      for (let i = 0; i < p.laps.length; i += 400) {
        say(`Importing… ${Math.min(i + 400, p.laps.length)} of ${p.laps.length}`);
        const res = await fetch(API + '/api/import-laps', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-edit-key': key },
          body: JSON.stringify({ car, track, laps: p.laps.slice(i, i + 400) })
        });
        if (res.status === 401) { store.set('ledger.editkey', ''); return say('Not imported. That edit key was wrong.'); }
        if (res.status === 429) return say(await lockoutText(res));
        const out = await res.json().catch(() => ({}));
        if (!res.ok) return say((out.error || 'Could not import. Try again.') + (added ? ` ${added} laps were added before this.` : ''));
        added += out.added; skipped += out.skipped;
      }
      store.set('ledger.editkey', key);
      const r = await fetch(API + '/api/combos', { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      await adopt({ ...(await r.json()), apiOk: true });
      const target = '#/combo/' + car + '-' + track;
      if (location.hash === target) route(); else location.hash = target;
    } catch (e) {
      say(`Could not finish. ${added ? added + ' laps were added; reload the app to see them.' : 'Check your connection and try again.'}`);
    } finally { go.disabled = false; }
  }

  // Undo for an import: removes the laps that came from export files for this car and track.
  async function removeImported() {
    const comboId = state.comboId;
    const combo = DATA.combos.find(c => c.id === comboId);
    const say = m => { const s = document.getElementById('imp-undo-state'); if (s) s.textContent = m; };
    if (!combo || !confirm(`Remove the ${combo.imported} imported laps for ${combo.car} at ${combo.track}? Laps that came from Garage61 itself are not touched.`)) return;
    const key = editKey();
    if (!key) return say('Not removed. An edit key is needed.');
    say('Removing…');
    try {
      const res = await fetch(API + '/api/combos/' + comboId + '/imported-laps', { method: 'DELETE', headers: { 'x-edit-key': key } });
      if (res.status === 401) { store.set('ledger.editkey', ''); return say('Not removed. That edit key was wrong.'); }
      if (res.status === 429) return say(await lockoutText(res));
      if (!res.ok) throw new Error(res.status);
      store.set('ledger.editkey', key);
      const r = await fetch(API + '/api/combos', { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      await adopt({ ...(await r.json()), apiOk: true });
      if (DATA.combos.some(c => c.id === comboId)) route(); else location.hash = '#/';
    } catch (e) { say('Could not remove the laps. Check your connection and try again.'); }
  }

  /* ---------- standings (XtremeScoring series tables) ---------- */
  // The Worker reads the leagues' public standings widgets and shares the result for a few minutes (see /api/standings).
  const tabsHtml = active => `<nav class="tabs" aria-label="Sections">
      <a href="#/" ${active === 'laps' ? 'aria-current="page"' : ''}>Laps</a>
      <a href="#/standings" ${active === 'standings' ? 'aria-current="page"' : ''}>Standings</a></nav>`;
  const ordinal = n => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };
  const standings = { data: null, at: 0 };

  async function loadStandings(force) {
    if (!force && standings.data && Date.now() - standings.at < 60000) return standings.data;
    const res = await fetch(API + '/api/standings', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(res.status);
    standings.data = await res.json();
    standings.at = Date.now();
    return standings.data;
  }

  function standingSummary(s) {
    const m = s.mine;
    if (!m) {
      // The name on XtremeScoring may be written differently from the one in the Worker settings.
      const alike = (s.similar || []).map(esc).join(', ');
      return alike
        ? `<p class="imp-hint">Your name was not found in this series. Similar names in the table: <b>${alike}</b>. If that is you, the name in the Worker settings needs to match it.</p>`
        : '<p class="imp-hint">You are not listed in this series.</p>';
    }
    const rows = (s.classes.find(c => c.name === m.class) || { rows: [] }).rows;
    const at = rows.findIndex(r => r.me);                          // neighbours come from where the row really is, not from its position number
    const ahead = at > 0 ? rows[at - 1] : null;
    const behind = at >= 0 ? rows[at + 1] : null;
    const chips = [];
    chips.push(m.toLeader === 0 ? '<span class="chip-gap good">You lead</span>' : `<span class="chip-gap">${Math.abs(m.toLeader)} behind the leader</span>`);
    if (ahead) {
      const gap = ahead.pts - m.pts;
      chips.push(gap === 0 ? `<span class="chip-gap">level with ${ordinal(ahead.pos)}</span>` : `<span class="chip-gap">${gap} behind ${ordinal(ahead.pos)}</span>`);
    }
    if (behind) chips.push(`<span class="chip-gap ${m.pts - behind.pts > 0 ? 'good' : ''}">${m.pts - behind.pts} ahead of ${ordinal(behind.pos)}</span>`);
    return `<div class="st-me">
        <div class="st-pos">${esc(ordinal(m.pos))}</div>
        <div><div class="st-line"><b>${m.pts} points</b> · ${esc(m.class)}, ${m.of} drivers</div>
        <div class="st-chips">${chips.join('')}</div></div></div>`;
  }

  function classTable(c, open) {
    const move = r => (r.chg > 0 ? `<span class="up">▲${r.chg}</span>` : r.chg < 0 ? `<span class="down">▼${-r.chg}</span>` : '');
    return `<details class="st-class"${open ? ' open' : ''}><summary>${esc(c.name)} <small>${c.rows.length} drivers</small></summary>
      <div class="st-wrap"><table class="st-table"><caption class="sr-only">${esc(c.name)} standings</caption>
        <thead><tr><th scope="col">Pos</th><th scope="col">Driver</th><th scope="col" class="st-car">Car</th><th scope="col" class="num">Pts</th><th scope="col" class="num">Gap</th></tr></thead>
        <tbody>${c.rows.map(r => `<tr${r.me ? ' class="me" aria-current="true"' : ''}>
          <td>${r.pos} ${move(r)}</td>
          <td>${r.number ? `<span class="st-no">#${esc(r.number)}</span> ` : ''}${esc(r.driver)}</td>
          <td class="st-car">${esc(r.car || '')}</td>
          <td class="num">${r.pts ?? ''}</td>
          <td class="num">${r.toLeader === 0 ? 'Leader' : r.toLeader ?? ''}</td></tr>`).join('')}</tbody></table></div></details>`;
  }

  const clock = at => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  function seriesCard(s) {
    if (s.error) {
      // A changed page layout needs a fix on our side, so say that; a plain outage just needs a little time.
      const hint = s.kind === 'format' ? '' : ' Try again in a minute.';
      return `<section class="card"><h2>${esc(s.name)}</h2><p class="${s.kind === 'format' ? 'imp-bad' : 'imp-hint'}">${esc(s.error)}${hint}</p></section>`;
    }
    // The last good read is shown when XtremeScoring cannot be reached or its page changed; say how old it is.
    const staleNote = s.stale
      ? `<p class="${s.staleReason === 'format' ? 'imp-bad' : 'imp-hint'}">${s.staleReason === 'format'
          ? 'XtremeScoring seems to have changed how its standings page is laid out, so these are the last standings that could be read'
          : 'XtremeScoring could not be reached, so these are the last standings that could be read'}${s.asOf ? ` (${esc(clock(s.asOf))})` : ''}.</p>`
      : '';
    return `<section class="card st-card" aria-label="${esc(s.name)}">
      <h2>${esc(s.name)}${s.title ? `<small>${esc(s.title)}</small>` : ''}</h2>
      ${staleNote}
      ${standingSummary(s)}
      ${s.classes.map(c => classTable(c, s.mine && s.mine.class === c.name)).join('')}
    </section>`;
  }

  async function renderStandings(force) {
    const head = tabsHtml('standings');
    if (!DATA.apiOk) {
      $app.innerHTML = head + '<div class="empty"><strong>Standings need the live app</strong>This copy is not connected to your Lap Ledger server.</div>';
      return;
    }
    if (!standings.data) $app.innerHTML = head + '<p class="imp-hint st-load">Loading standings…</p>';
    let data;
    try { data = await loadStandings(force); }
    catch (e) {
      if (location.hash !== '#/standings') return;
      $app.innerHTML = head + '<div class="empty"><strong>Standings did not load</strong>Check your connection, then <button type="button" class="btn ghost sm" data-standings-reload>try again</button>.</div>';
      return;
    }
    if (location.hash !== '#/standings') return;                  // the user moved on while it loaded
    const updated = clock(data.fetchedAt);
    $app.innerHTML = head + (data.series.length ? data.series.map(seriesCard).join('')
      : '<div class="empty"><strong>No series set up</strong>Add a standings address in the Worker settings.</div>')
      + `<p class="st-foot">Live from XtremeScoring. Updated ${esc(updated)}. <button type="button" class="btn ghost sm" data-standings-reload>Refresh</button></p>`;
  }

  /* ---------- home ---------- */
  function renderHome() {
    const q = state.query.trim().toLowerCase();
    const mine = new Set([DATA.me]);
    const pool = state.mode === 'me' && DATA.me ? mine : null;
    const rows = DATA.combos
      .map(c => {
        const laps = visibleLaps(c, pool);
        return { c, laps, best: bestOf(laps) };
      })
      .filter(x => x.best && (!q || (x.c.car + ' ' + x.c.track).toLowerCase().includes(q)))
      .sort((a, b) => b.laps[b.laps.length - 1].at - a.laps[a.laps.length - 1].at);

    $app.innerHTML = `
      ${tabsHtml('laps')}
      <div class="find">
        <input id="q" type="search" inputmode="search" autocomplete="off" spellcheck="false"
               placeholder="Search car or track" aria-label="Search car or track" value="${esc(state.query)}">
      </div>
      <div class="count-row">
        <p class="count" aria-live="polite">${rows.length} car and track ${rows.length === 1 ? 'combo' : 'combos'}${q ? ' match' : ''}</p>
        <a class="imp-link" href="#/import">Import laps</a>
      </div>
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
    const keptForm = captureSetupForm(id);

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
          ${filesHtml(combo, sel)}
        </section>
      </div>

      <section class="card" aria-labelledby="h-notes">
        <h2 id="h-notes">Notes</h2>
        <textarea id="notes" aria-label="Notes for this car and track" placeholder="What works here? Example: understeers in T3, try a softer front bar.">${esc(getNote(combo.id))}</textarea>
        <div class="note-foot"><span id="note-state">${DATA.isSample ? 'Saved on this device' : 'Shared with your team'}</span><button class="btn ghost" type="button" id="share">Copy link to this combo</button></div>
      </section>
      ${!DATA.isSample && combo.imported ? `
      <section class="card" aria-labelledby="h-imp">
        <h2 id="h-imp">Imported laps</h2>
        <p class="imp-note"><b>${combo.imported}</b> of these laps came from a Garage61 export file. When Garage61 lets the app read laps directly, the sync replaces them with the real ones.
          If you picked the wrong car or track, remove them and import the file again.</p>
        <div class="sf-actions"><button class="btn ghost" type="button" data-del-imported>Remove imported laps</button><span id="imp-undo-state" role="status"></span></div>
      </section>` : ''}`;

    restoreSetupForm(keptForm);
    chartCtx = { laps, status, selId: sel.id, multi };
    drawChart(document.getElementById('chart'), laps, status, sel.id, multi);
  }

  function setupHtml(combo, lap, best) {
    const setup = combo.setups[lap.setupId];
    if (!setup) return '<div class="empty"><strong>No setup values stored for this lap</strong>Garage61 does not share setups with other apps yet. Add the .sto file below, and note the key values.</div>';
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
    const pick = e.target.closest('[data-pick-id]');
    if (pick) return choosePick(pick.dataset.pickKind, Number(pick.dataset.pickId), pick.dataset.pickLabel);
    if (e.target.closest('[data-del-imported]')) return removeImported();
    if (e.target.closest('[data-standings-reload]')) return renderStandings(true);
    if (e.target.closest('[data-suggest]')) { const key = editKey(); if (key) runSuggestion(imp.reading, key); return; }
    const sp = e.target.closest('[data-suggest-pick]');
    if (sp) { const c = imp.candidates[Number(sp.dataset.suggestPick)]; if (c) applyCandidate(c); return; }
    const del = e.target.closest('[data-del-file]');
    if (del) return deleteSetupFile(del.dataset.delFile);
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
    const input = e.target.dataset && e.target.dataset.pick ? e.target : null;
    if (!input) return;
    const list = document.getElementById(input.getAttribute('aria-controls'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) showPicks(input);
      else movePick(input, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && !list.hidden) {
      const b = list.querySelectorAll('button')[Math.max(imp.active, 0)];
      if (b) { e.preventDefault(); choosePick(b.dataset.pickKind, Number(b.dataset.pickId), b.dataset.pickLabel); }
    } else if (e.key === 'Escape') hidePicks(input);
  });
  document.addEventListener('focusout', e => {
    if (e.target.dataset && e.target.dataset.pick) setTimeout(() => hidePicks(e.target), 150);   // after a tap on a suggestion lands
  });
  document.addEventListener('submit', e => {
    if (e.target.id === 'sf-form') { e.preventDefault(); addSetupFile(e.target); }
    else if (e.target.id === 'imp-form') { e.preventDefault(); runImport(e.target); }
  });
  document.addEventListener('change', e => { if (e.target.id === 'imp-file') onImportFile(e.target.files[0]); });
  document.addEventListener('input', e => {
    if (e.target.dataset && e.target.dataset.pick) { imp.sel[e.target.dataset.pick] = null; showPicks(e.target); return; }
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
    if (m) renderDetail(m[1]);
    else if (location.hash === '#/import') { state.comboId = null; renderImport(); }
    else if (location.hash === '#/standings') { state.comboId = null; renderStandings(false); }
    else { state.comboId = null; renderHome(); }
  }

  /* ---------- boot ---------- */
  // Makes `d` the data on screen: driver colors, shared notes and the sample-data banner.
  async function adopt(d) {
    DATA = d;
    state.comboId = null;
    Object.keys(DRIVER_COLOR).forEach(k => delete DRIVER_COLOR[k]);
    const order = [d.me, ...d.drivers.map(x => x.id).filter(x => x !== d.me)].filter(Boolean);
    order.forEach((id, i) => { DRIVER_COLOR[id] = PALETTE[i % PALETTE.length]; });
    if (!d.isSample) {
      try { const r = await fetch(API + '/api/notes'); if (r.ok) notesCache = await r.json(); } catch (e) { /* notes load later */ }
    }
    $banner.hidden = !d.isSample;
    if (d.isSample) {
      $banner.innerHTML = `<span>Sample data. ${d.waiting ? 'No laps have synced from Garage61 yet. <a href="#/import">Import a Garage61 export</a> to see your own.' : 'Garage61 is not connected yet.'}</span>`;
    }
  }
  load().then(async d => { await adopt(d); route(); });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && location.hostname !== 'localhost') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
