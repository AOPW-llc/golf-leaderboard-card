/**
 * Golf Leaderboard Card
 * Custom Lovelace card for Home Assistant
 * https://github.com/AOPW-llc/golf-leaderboard-card
 *
 * A classic hand-operated tournament scoreboard, drawn live: per-hole running
 * scores over the top 10 (or players you pick), with the real par for every
 * hole of the course being played.
 *
 * Data sources (unofficial public feeds, no API key):
 *   - ESPN scoreboard API       — current / selected PGA Tour event + scores
 *   - ESPN core events API      — course hole pars
 *   - Masters.com scores feed   — used only during the Masters, when available
 *
 * Card config:
 *   type: custom:golf-leaderboard-card
 *   title: LEADERS            # optional, text in the arch (default LEADERS)
 *   refresh_interval: 5       # optional, minutes between refreshes (default 5)
 *   tournament_id: '401703504'# optional, pin an ESPN event id
 *   toggle_entity: input_boolean.x  # optional, mirrors Live/Custom view
 */

const VERSION = '1.0.0';
const CARD_TAG = 'golf-leaderboard-card';

// ─── Data sources ────────────────────────────────────────────────────────────
const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const ESPN_EVENT_URL = (id) =>
  `https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/events/${id}?lang=en&region=us`;
const MASTERS_URL = (year) =>
  `https://www.masters.com/en_US/scores/feeds/${year}/scores.json`;

// ─── Board geometry (SVG user units; the board scales to the card width) ─────
const G = {
  W: 2000, H: 1125,
  left: 15, right: 1985,
  archTop: 20, top: 150,         // arch peak / top edge of the grid
  hdr1: 232, hdr2: 312,          // bottom of HOLE row / bottom of PAR row
  bottom: 1110,
  priorR: 100, nameR: 435,       // right edges of PRIOR and name columns
  rows: 10,
};
G.holeW = (G.right - G.nameR) / 18;
G.rowH  = (G.bottom - G.hdr2) / G.rows;
const holeX  = (i) => G.nameR + G.holeW * (i + 0.5);
const rowTop = (i) => G.hdr2 + G.rowH * i;
const rowCY  = (i) => rowTop(i) + G.rowH / 2;
// Rows are grouped 1 / 3 / 3 / 3 with heavy rules between groups
const HEAVY_ROWS = [1, 4, 7];

// ─── Colors ──────────────────────────────────────────────────────────────────
const SCORE_UNDER = '#cc0000';   // red   (under par)
const SCORE_OVER  = '#006600';   // green (over par / even)
const FRAME       = '#14283a';
const INK         = '#111111';

// ─── localStorage keys ───────────────────────────────────────────────────────
const STORAGE_KEY       = 'golf-leaderboard-custom';
const STORAGE_EVENT_KEY = 'golf-leaderboard-event';
const STORAGE_SAVED_KEY = 'golf-leaderboard-saved';
// Keys used by the pre-release tournament-leaderboard-card; read once to migrate
const LEGACY_KEYS = {
  [STORAGE_KEY]:       'tournament-leaderboard-custom',
  [STORAGE_EVENT_KEY]: 'tournament-leaderboard-event',
  [STORAGE_SAVED_KEY]: 'tournament-leaderboard-saved',
};

function lsGet(key) {
  try {
    const v = localStorage.getItem(key);
    if (v != null) return v;
    const legacy = localStorage.getItem(LEGACY_KEYS[key]);
    if (legacy != null) localStorage.setItem(key, legacy);
    return legacy;
  } catch (_) { return null; }
}
function lsSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (_) {}
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class GolfLeaderboardCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._players         = [];
    this._roundInfo       = {};          // { current, final, currentLabel } for the event
    this._roundSel        = null;        // round picked in the footer; null = follow current
    this._customRows      = new Array(10).fill(null); // 10 slots, each null or player id
    this._savedRows       = new Array(10).fill(null); // persisted saved list
    this._savedDraft      = new Array(10).fill(null); // working copy while in saved view
    this._savedDirty      = false;                    // unsaved changes in saved view
    this._mode            = 'default';   // 'default' | 'custom' | 'saved'
    this._loading         = true;
    this._error           = null;
    this._info            = {};
    this._config          = {};
    this._lastUpdated     = null;
    this._hass            = null;
    this._events          = [];          // [{id, label, dates}] from ESPN calendar
    this._selectedEventId = lsGet(STORAGE_EVENT_KEY) || null;
    this._currentEventId  = null;        // event ID of currently displayed data
    this._pars            = [];          // 18 pars for the displayed course
    this._parsCache       = {};          // eventId -> {pars, course}
    this._loadCustom();
    this._loadSaved();
  }

  // ─── Lovelace lifecycle ───────────────────────────────────────────────────

  setConfig(config) {
    this._config = config || {};
    if (this.isConnected) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const entity = this._config.toggle_entity;
    if (entity) {
      const state = hass.states[entity];
      const newMode = state?.state === 'on' ? 'custom' : 'default';
      if (newMode !== this._mode && this._mode !== 'saved') {
        this._mode = newMode;
        this._render();
      }
    }
  }

  connectedCallback() {
    this._render();
    this._fetch();
    const ms = Math.max(1, Number(this._config.refresh_interval ?? 5)) * 60 * 1000;
    clearInterval(this._timer);
    this._timer = setInterval(() => this._fetch(), ms);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  getCardSize() { return 8; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }
  static getStubConfig() { return { refresh_interval: 5 }; }

  static getConfigForm() {
    return {
      schema: [
        { name: 'title', selector: { text: {} } },
        { name: 'refresh_interval', selector: { number: { min: 1, max: 60, mode: 'box', unit_of_measurement: 'min' } } },
        { name: 'tournament_id', selector: { text: {} } },
        { name: 'toggle_entity', selector: { entity: { domain: 'input_boolean' } } },
      ],
      computeLabel: (s) => ({
        title: 'Title (default: LEADERS)',
        refresh_interval: 'Refresh interval',
        tournament_id: 'ESPN tournament ID (optional, pins one event)',
        toggle_entity: 'Toggle entity (optional, mirrors Live/Custom view)',
      }[s.name]),
    };
  }

  // ─── Custom / saved rows persistence ──────────────────────────────────────

  _loadCustom() {
    try {
      const s = lsGet(STORAGE_KEY);
      if (s) this._customRows = JSON.parse(s).concat(new Array(10).fill(null)).slice(0, 10);
    } catch (_) {}
  }

  _saveCustom() { lsSet(STORAGE_KEY, JSON.stringify(this._customRows)); }

  _loadSaved() {
    try {
      const s = lsGet(STORAGE_SAVED_KEY);
      if (s) this._savedRows = JSON.parse(s).concat(new Array(10).fill(null)).slice(0, 10);
    } catch (_) {}
  }

  _writeSaved() { lsSet(STORAGE_SAVED_KEY, JSON.stringify(this._savedRows)); }

  _setCustomRow(rowIndex, playerId) {
    this._customRows[rowIndex] = playerId || null;
    this._saveCustom();
    this._render();
  }

  _setSavedRow(rowIndex, playerId) {
    this._savedDraft[rowIndex] = playerId || null;
    this._savedDirty = true;
    this._render();
  }

  _isInCustom(id) { return this._customRows.includes(id); }
  _savedExists()  { return this._savedRows.some(Boolean); }

  _setMode(mode) {
    const prev = this._mode;
    // Leaving saved view with unsaved draft: silently discard
    if (prev === 'saved' && this._savedDirty && mode !== 'saved') {
      this._savedDraft = [...this._savedRows];
      this._savedDirty = false;
    }
    // Entering saved view: load persisted list into draft
    if (mode === 'saved' && prev !== 'saved') {
      this._savedDraft = [...this._savedRows];
      this._savedDirty = false;
    }
    this._mode = mode;
    const entity = this._config.toggle_entity;
    if (entity && this._hass && (mode === 'default' || mode === 'custom')) {
      this._hass.callService('input_boolean', mode === 'custom' ? 'turn_on' : 'turn_off',
        { entity_id: entity });
    }
    this._render();
  }

  _clearCustom() {
    this._customRows = new Array(10).fill(null);
    this._saveCustom();
    this._render();
  }

  _clearSaved() {
    this._savedRows  = new Array(10).fill(null);
    this._savedDraft = new Array(10).fill(null);
    this._savedDirty = false;
    this._writeSaved();
    this._render();
  }

  _handleSaveBtnClick() {
    if (this._savedExists() && !this._savedDirty) {
      // "Saved" state — navigate to saved view
      if (this._mode !== 'saved') this._setMode('saved');
    } else if (this._mode === 'saved' && this._savedDirty) {
      // "Save" from saved view — commit draft
      this._savedRows = [...this._savedDraft];
      this._writeSaved();
      this._savedDirty = false;
      this._render();
    } else if (this._mode === 'custom') {
      // "Save" from custom view — snapshot current custom selections
      this._savedRows = [...this._customRows];
      this._writeSaved();
      this._render();
    } else if (this._mode === 'default') {
      // "Save" from live view — snapshot current top-10 displayed players
      const top10 = this._boardPlayers().filter(p => !p.cut).slice(0, 10);
      this._savedRows = new Array(10).fill(null);
      top10.forEach((p, i) => { this._savedRows[i] = p.id ?? p.name; });
      this._writeSaved();
      this._render();
    }
  }

  // ─── Data fetching ────────────────────────────────────────────────────────

  async _getJSON(url) {
    try {
      const r = await fetch(url, { cache: 'no-store', mode: 'cors', signal: AbortSignal.timeout(10000) });
      return r.ok ? await r.json() : null;
    } catch (_) { return null; }
  }

  async _fetch() {
    if (this._fetching) return;
    this._fetching = true;
    try { await this._doFetch(); } finally { this._fetching = false; }
  }

  async _doFetch() {
    const tid = this._selectedEventId ?? this._config.tournament_id ?? null;

    // The current-week scoreboard also carries the season calendar for the event picker
    const current = await this._getJSON(ESPN_URL);
    if (!this._events.length && current) {
      const cutoff = Date.now() + 14 * 24 * 60 * 60 * 1000;
      this._events = (current.leagues?.[0]?.calendar ?? [])
        .filter(e => new Date(e.startDate).getTime() <= cutoff)
        .map(e => ({ id: e.id, label: e.label, dates: e.startDate.slice(0, 10).replace(/-/g, '') }));
    }

    let data = current;
    if (tid && current?.events?.[0]?.id !== String(tid)) {
      // ESPN ignores tournamentId unless dates= is also given; events outside this
      // season's calendar get their date from the core events API
      let evDates = this._events.find(e => e.id === String(tid))?.dates;
      if (!evDates) {
        const d = await this._getJSON(ESPN_EVENT_URL(tid));
        evDates = d?.date ? d.date.slice(0, 10).replace(/-/g, '') : '';
      }
      data = await this._getJSON(`${ESPN_URL}?tournamentId=${tid}${evDates ? `&dates=${evDates}` : ''}`);
    }

    const ev = tid
      ? data?.events?.find(e => e.id === String(tid))
      : data?.events?.[0];
    if (!ev) {
      this._players = []; this._pars = []; this._roundInfo = {};
      this._error = tid ? `Tournament ${tid} not found.` : 'No tournament data available right now.';
      this._loading = false;
      this._render();
      return;
    }

    await this._loadCourse(ev.id);

    // During the Masters, prefer Masters.com's own feed (hole-by-hole, faster)
    if (/masters tournament/i.test(ev.name ?? '')) {
      const year = new Date(ev.date ?? Date.now()).getFullYear();
      const m = await this._getJSON(MASTERS_URL(year));
      if (m && this._parseMasters(m, ev)) return;
    }

    this._parseESPN(ev);
  }

  async _loadCourse(eventId) {
    if (!this._parsCache[eventId]) {
      const d = await this._getJSON(ESPN_EVENT_URL(eventId));
      const course = d?.courses?.[0];
      const pars = new Array(18).fill(null);
      (course?.holes ?? []).forEach(h => {
        if (h.number >= 1 && h.number <= 18) pars[h.number - 1] = h.shotsToPar ?? null;
      });
      // Only cache a successful lookup so a network blip retries next refresh
      if (course) this._parsCache[eventId] = { pars, course: course.name ?? '' };
      else return void (this._pars = pars);
    }
    this._pars = this._parsCache[eventId].pars;
    this._info.course = this._parsCache[eventId].course;
  }
  // ─── Parsed data model ────────────────────────────────────────────────────
  // Both parsers produce this._players = [{ id, name, missedCut, rounds }], where
  // rounds[n] = { total, holes: [{ col, toPar }] } for each round 1–4 with data
  // (holes in playing order), and this._roundInfo = { current, final, currentLabel }.
  // _boardPlayers(round) turns that into what the board shows for any round.

  _newEvent(ev) {
    if (ev.id !== this._currentEventId) this._roundSel = null;
    this._currentEventId = ev.id;
    this._info = { ...this._info, eventName: ev.name, startDate: ev.date };
  }

  _finishParse(players, roundInfo) {
    this._players   = players;
    this._roundInfo = roundInfo;
    this._loading = false; this._error = null; this._lastUpdated = new Date();
    this._render();
    return true;
  }

  // ─── Masters.com parser ───────────────────────────────────────────────────

  _parseMasters(data, ev) {
    const players = data?.data?.player;
    if (!players?.length) return false;
    // statusRound: one char per round — F=Finished, P=Pre/Pending, N=N/A, anything else = in progress
    const statusRound = data?.data?.statusRound ?? '';
    let lastFinished = 0, activeRound = 0;
    for (let i = 0; i < statusRound.length; i++) {
      const ch = statusRound[i];
      if (ch === 'F') { lastFinished = i + 1; }
      else if (ch !== 'N' && ch !== 'P') { activeRound = i + 1; break; }
    }
    // currentRound: '1' marks the active round (e.g. "0100" = R2). statusRound can lag at 'P'
    // after players have teed off, so this is the fallback for the round actually in play.
    const currentRoundStr = data?.data?.currentRound ?? '';
    const currentRoundFromField = currentRoundStr.indexOf('1') + 1;
    const current = Math.min(4, activeRound || currentRoundFromField || lastFinished);
    let currentLabel;
    if (activeRound || (currentRoundFromField && currentRoundFromField > lastFinished)) {
      currentLabel = `Round ${activeRound || currentRoundFromField}`;
    } else if (lastFinished === 4) {
      currentLabel = 'Final';
    } else if (lastFinished) {
      currentLabel = `Round ${lastFinished} (F)`;
    } else {
      currentLabel = 'Scheduled';
    }
    this._newEvent(ev);
    const pars = data?.data?.pars ?? {};
    const curPars = pars[`round${current}`];
    if (curPars?.length === 18) this._pars = curPars.map(n => Number(n) || null);

    const parsed = players.map(p => {
      const rounds = {};
      for (let r = 1; r <= 4; r++) {
        // scores[] holds raw strokes by hole number, null for holes not yet played
        const sc = p[`round${r}`]?.scores ?? [];
        const rp = pars[`round${r}`] ?? this._pars;
        // Two-tee starts: a round with hole 10 but not hole 1 began on the back nine
        const backStart = sc[0] == null && sc[9] != null;
        const order = Array.from({ length: 18 }, (_, i) => backStart ? (i + 9) % 18 : i);
        const holes = [];
        order.forEach(col => {
          const s = sc[col], par = Number(rp?.[col]);
          if (s != null && par) holes.push({ col, toPar: s - par });
        });
        if (holes.length) rounds[r] = { total: holes.reduce((t, h) => t + h.toPar, 0), holes };
      }
      return {
        id:        p.id ?? p.full_name,
        name:      p.full_name ?? 'Unknown',
        // Cut players have no position once round 3 starts
        missedCut: current > 2 && !p.pos,
        rounds,
      };
    });
    return this._finishParse(parsed, { current, final: lastFinished === 4, currentLabel });
  }

  // ─── ESPN parser ──────────────────────────────────────────────────────────

  _parseESPN(ev) {
    const comp      = ev.competitions?.[0] ?? {};
    const status    = comp.status ?? ev.status ?? {};
    const typeState = status.type?.state ?? '';
    const typeName  = status.type?.name ?? '';
    const period    = status.period ?? 0;
    const isFinal   = typeState === 'post' || typeName === 'STATUS_FINAL';
    let currentLabel = '';
    if (typeState === 'pre' || typeName === 'STATUS_SCHEDULED') {
      currentLabel = 'Scheduled';
    } else if (isFinal) {
      currentLabel = (period >= 1 && period <= 3) ? `Round ${period} (F)` : 'Final';
    } else if (period >= 1) {
      currentLabel = period > 4 ? 'Playoff' : `Round ${period}`;
    }
    this._newEvent(ev);

    const parsed = (comp.competitors ?? []).map(c => {
      const rounds = {};
      // Regulation rounds only: a playoff is reported as period 5+
      (c.linescores ?? []).forEach(r => {
        if (!(r.period >= 1 && r.period <= 4)) return;
        // Running order is the order ESPN lists them; h.period is the hole number,
        // so back-nine starters fill in from hole 10
        const holes = [];
        (r.linescores ?? []).forEach((h, idx) => {
          const col = (h.period ?? idx + 1) - 1;
          if (col < 0 || col >= 18) return;
          // ESPN labels some big numbers (+3 and worse) as "OTHER"; fall back to strokes
          // minus par. A hole we can't score is left blank rather than corrupting totals.
          const toPar = this._toPar(h.scoreType?.displayValue)
            ?? (h.value != null && this._pars[col] != null ? h.value - this._pars[col] : null);
          if (toPar != null) holes.push({ col, toPar });
        });
        // ESPN pads rounds not yet played with empty / '-' placeholders
        const total = this._toPar(r.displayValue)
          ?? (holes.length ? holes.reduce((t, h) => t + h.toPar, 0) : null);
        if (total != null || holes.length) rounds[r.period] = { total: total ?? 0, holes };
      });
      return {
        id:        c.id ?? c.athlete?.displayName,
        name:      c.athlete?.displayName ?? 'Unknown',
        missedCut: false,
        rounds,
      };
    });
    // Once an event is over, a "round" only a handful of players have scores for is a
    // playoff, not regulation — e.g. a weather-shortened 54-hole event decided by a 3-hole
    // aggregate playoff that ESPN files as round 4. Drop such rounds so the field isn't
    // marked cut. (During play a thin round just means early tee times, so leave it.)
    const eventDone = isFinal && period >= 4;
    const played = (r) => parsed.filter(p => p.rounds[r]).length;
    let last = Math.max(0, ...parsed.flatMap(p => Object.keys(p.rounds).map(Number)));
    while (eventDone && last > 1 && played(last) < played(last - 1) / 2) {
      parsed.forEach(p => { delete p.rounds[last]; });
      last--;
    }
    const current = eventDone ? last : Math.min(4, Math.max(period, last));
    return this._finishParse(parsed, { current, final: eventDone, currentLabel });
  }

  // ─── Round view ───────────────────────────────────────────────────────────

  _roundOptions() {
    const { current = 0, currentLabel } = this._roundInfo ?? {};
    return Array.from({ length: current }, (_, i) => {
      const r = i + 1;
      return { round: r, label: r === current ? currentLabel : (r === 4 ? 'Final' : `Round ${r}`) };
    });
  }

  _activeRound() {
    const current = this._roundInfo?.current ?? 0;
    return this._roundSel && this._roundSel <= current ? this._roundSel : current;
  }

  // Players as the board shows them for round R: score from earlier rounds in the
  // PRIOR column, running total through each hole of round R, ranked by score
  // through round R (so an earlier round shows the board as it stood then).
  _boardPlayers(R = this._activeRound()) {
    if (!R) return [];
    const { current, final } = this._roundInfo;
    return this._players.map(p => {
      const rd = p.rounds[R];
      let prior = null;
      if (R > 1) {
        prior = 0;
        for (let r = 1; r < R; r++) prior += p.rounds[r]?.total ?? 0;
      }
      let running = prior ?? 0;
      const holes = [];
      (rd?.holes ?? []).forEach(h => { running += h.toPar; holes[h.col] = running; });
      return {
        id:         p.id,
        name:       p.name,
        priorScore: prior,
        holes,
        scoreVal:   running,
        // Missing a weekend round only proves a missed cut once that round is over;
        // until then the player may simply not have teed off yet
        cut: R > 2 && (p.missedCut || (!rd && (R < current || final))),
      };
    }).sort((a, b) => a.scoreVal - b.scoreVal);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _numScore(s) {
    if (s == null || s === 'E' || s === '') return 0;
    if (typeof s === 'number') return s;
    const n = parseInt(s, 10);
    return isNaN(n) ? 999 : n;
  }

  // Strict score-to-par parse: 'E' → 0, '+2' / '-1' → number, anything else → null
  _toPar(s) {
    if (s === 'E') return 0;
    return /^[+-]?\d+$/.test(s ?? '') ? parseInt(s, 10) : null;
  }

  _fmtScore(s) {
    const n = this._numScore(s);
    return n === 999 ? '' : String(Math.abs(n));
  }

  _scoreColor(s) {
    return this._numScore(s) < 0 ? SCORE_UNDER : SCORE_OVER;
  }

  _abbrevName(fullName) {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) return fullName;
    // "Rory McIlroy" → "R. McIlroy"; long last names drop the initial and truncate
    const last = parts.slice(1).join(' ');
    return last.length > 10 ? last.substring(0, 10) : `${parts[0][0]}. ${last}`;
  }

  _timeAgo() {
    if (!this._lastUpdated) return '';
    const sec = Math.round((Date.now() - this._lastUpdated) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  }

  _stateMessage() {
    if (this._loading) return 'Loading…';
    if (this._error) return this._error;
    if (this._roundInfo?.currentLabel === 'Scheduled' && !this._players.some(p => Object.keys(p.rounds).length)) {
      const d = this._info.startDate ? new Date(this._info.startDate) : null;
      // ESPN start dates are date-only values stamped as midnight ET (04:00Z/05:00Z);
      // formatting in UTC keeps the same calendar day for every viewer
      const when = d && !isNaN(d)
        ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
        : '';
      return `${this._info.eventName ?? 'Tournament'}${when ? ` — starts ${when}` : ''}`;
    }
    return '';
  }

  // ─── Board drawing (SVG) ──────────────────────────────────────────────────

  _boardSVG(rows) {
    const { W, H, left, right, top, hdr1, hdr2, bottom, priorR, nameR } = G;
    const title = esc(this._config.title ?? 'LEADERS');
    const lines = [];
    const line = (x1, y1, x2, y2, w) =>
      lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${w}"/>`);

    // Header rules
    line(priorR, hdr1, right, hdr1, 2);
    line(left, hdr2, right, hdr2, 2);
    // Row rules: heavy between groups, light inside a group
    for (let i = 1; i < G.rows; i++) {
      const heavy = HEAVY_ROWS.includes(i);
      line(left, rowTop(i), right, rowTop(i), heavy ? 6 : 2);
    }
    // Column rules
    line(priorR, top, priorR, bottom, 3);
    line(nameR, top, nameR, bottom, 6);
    for (let h = 1; h < 18; h++) {
      const x = G.nameR + G.holeW * h;
      line(x, top, x, bottom, h === 9 ? 6 : 2);
    }

    const holeNums = Array.from({ length: 18 }, (_, i) =>
      `<text x="${holeX(i)}" y="${(top + hdr1) / 2}">${i + 1}</text>`).join('');
    const pars = this._pars.map((p, i) => p == null ? '' :
      `<text x="${holeX(i)}" y="${(hdr1 + hdr2) / 2}">${p}</text>`).join('');
    const prior = 'PRIOR'.split('').map((ch, i) =>
      `<text x="${(left + priorR) / 2}" y="${top + 24 + i * 32}">${ch}</text>`).join('');

    const msg = this._stateMessage();
    // Message sits on a white plate so the grid rules don't run through it
    const msgW = msg.length * 21 + 80;
    const msgSVG = msg ? `
      <rect class="msg-plate" x="${(W - msgW) / 2}" y="${rowCY(5) - 40}" width="${msgW}" height="80" rx="12"/>
      <text class="msg" x="${W / 2}" y="${rowCY(5)}">${esc(msg)}</text>` : '';

    return `
      <svg class="board" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title} scoreboard">
        <defs><clipPath id="name-col"><rect x="${priorR}" y="${hdr2}" width="${nameR - priorR - 6}" height="${bottom - hdr2}"/></clipPath></defs>
        <path class="frame" d="M${left},${top} C${left},${top - 90} ${W * 0.2},${G.archTop} ${W / 2},${G.archTop}
                 C${W * 0.8},${G.archTop} ${right},${top - 90} ${right},${top} L${right},${bottom} L${left},${bottom} Z"/>
        <text class="title" x="${W / 2 + 5}" y="${(G.archTop + top) / 2 + 8}">${title}</text>
        <g class="rules">${lines.join('')}</g>
        <path class="frame-line" d="M${left},${top} L${right},${top}"/>
        <text class="label" x="${(priorR + nameR) / 2}" y="${(top + hdr1) / 2}">HOLE</text>
        <text class="label" x="${(priorR + nameR) / 2}" y="${(hdr1 + hdr2) / 2}">PAR</text>
        <g class="prior-label">${prior}</g>
        <g class="hdr">${holeNums}${pars}</g>
        <g class="scores">${rows}</g>
        ${msgSVG}
      </svg>`;
  }

  _rowSVG(i, p, { star = false } = {}) {
    const y = rowCY(i);
    const name = this._abbrevName(p.name);
    // Long names shrink to fit the column rather than being cut off
    // (~27 units per bold character at the 50px default size; sized against 30 for
    // margin, since wide letters like m/w run over the average)
    const room = G.nameR - G.priorR - 30;
    const fit = name.length * 27 > room
      ? ` style="font-size:${Math.max(30, Math.floor(50 * room / (name.length * 30)))}px"` : '';
    let out = `<text class="name" x="${G.priorR + 16}" y="${y}"${fit} clip-path="url(#name-col)">${esc(name)}</text>`;
    if (p.cut) {
      return out + `<text x="${(G.left + G.priorR) / 2}" y="${y}" style="fill:${INK}">C</text>`;
    }
    if (p.priorScore != null) {
      out += `<text x="${(G.left + G.priorR) / 2}" y="${y}" style="fill:${this._scoreColor(p.priorScore)}">${this._fmtScore(p.priorScore)}</text>`;
    }
    p.holes.forEach((val, h) => {
      if (val == null) return;
      out += `<text x="${holeX(h)}" y="${y}" style="fill:${this._scoreColor(val)}">${this._fmtScore(val)}</text>`;
    });
    if (star) out += `<text class="star" x="${G.left + 14}" y="${rowTop(i) + 18}">★</text>`;
    return out;
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  _render() {
    if (!this.shadowRoot) return;
    const mode    = this._mode;
    const refresh = this._config.refresh_interval ?? 5;
    const board = this._boardPlayers();
    const active = board.filter(pl => !pl.cut);
    const allByName = [...board].sort((a, b) => a.name.localeCompare(b.name));
    const byId = (id) => board.find(pl => (pl.id ?? pl.name) === id);

    let rowsSVG = '';
    let selects = '';
    for (let i = 0; i < G.rows; i++) {
      if (mode === 'custom' || mode === 'saved') {
        const rowData    = mode === 'saved' ? this._savedDraft : this._customRows;
        const selectedId = rowData[i];
        const p = selectedId ? byId(selectedId) : null;
        const opts = `<option value="">select</option>` + allByName.map(pl => {
          const pid = pl.id ?? pl.name;
          return `<option value="${esc(pid)}"${pid === selectedId ? ' selected' : ''}>${esc(pl.name)}</option>`;
        }).join('');
        // Once a player is picked the select goes transparent but stays tappable over the name
        const pos = `top:${(rowTop(i) + 6) / G.H * 100}%;left:${(G.priorR + 6) / G.W * 100}%;` +
          `width:${(G.nameR - G.priorR - 14) / G.W * 100}%;height:${(G.rowH - 12) / G.H * 100}%`;
        selects += `<select class="row-select" data-row="${i}" data-mode="${mode}"
          style="${pos};opacity:${p ? 0 : 1}">${opts}</select>`;
        if (p) rowsSVG += this._rowSVG(i, p);
      } else {
        if (this._loading || this._error) continue;
        const p = active[i];
        if (p) rowsSVG += this._rowSVG(i, p, { star: this._isInCustom(p.id ?? p.name) });
      }
    }

    const updated = this._lastUpdated ? `Updated ${this._timeAgo()}` : `Refreshes every ${refresh}m`;

    // Save / Saved button state
    const saveLabel = this._savedExists() && !this._savedDirty ? 'Saved' : 'Save';
    let saveBtnClass = 'view-btn';
    if (mode === 'saved' && this._savedDirty) {
      saveBtnClass += ' save-dirty';    // unsaved changes in Saved view
    } else if (mode === 'saved') {
      saveBtnClass += ' active';
    } else if (saveLabel === 'Save' && mode === 'custom' && this._customRows.some(Boolean)) {
      saveBtnClass += ' save-pending';  // Custom has players not yet saved
    } else if (saveLabel === 'Save' && mode === 'default' && active.length) {
      saveBtnClass += ' save-pending';  // Live has players ready to save
    }

    const selectedEv = this._selectedEventId ?? this._currentEventId;
    // Round label doubles as a round picker: the visible text is unchanged and an
    // invisible native <select> laid over it opens the choice of rounds when tapped
    const rounds = this._roundOptions();
    const activeRound = this._activeRound();
    const roundText = rounds.find(o => o.round === activeRound)?.label ?? this._roundInfo?.currentLabel ?? '';
    const roundHTML = rounds.length > 1
      ? `<span class="round-pick">${esc(roundText)}<select id="round-select" aria-label="Round">${
          rounds.map(o => `<option value="${o.round}"${o.round === activeRound ? ' selected' : ''}>${esc(o.label)}</option>`).join('')
        }</select></span>`
      : esc(roundText);
    const banner = [roundHTML, this._info.course ? esc(this._info.course) : ''].filter(Boolean).join(' · ');

    this.shadowRoot.innerHTML = `
      <style>${this._css()}</style>
      <ha-card>
        <div class="card">
          <div class="board-wrap">
            ${this._boardSVG(rowsSVG)}
            <div class="overlay">${selects}</div>
          </div>
          <div class="footer">
            <div class="footer-left">
              <div class="view-btns">
                <button class="view-btn${mode === 'default' ? ' active' : ''}" id="btn-default">Live</button>
                <button class="view-btn${mode === 'custom' ? ' active' : ''}" id="btn-custom">Custom</button>
                <button class="${saveBtnClass}" id="btn-save">${saveLabel}</button>
                <button class="round-btn${(mode !== 'custom' && mode !== 'saved') ? ' invisible' : ''}" id="btn-clear"
                  title="${mode === 'saved' ? 'Clear Saved list' : 'Clear Custom board'}">✕</button>
              </div>
              ${banner ? `<div class="footer-banner">${banner}</div>` : ''}
            </div>
            <div class="footer-selects">
              <button class="round-btn" id="refresh-btn" title="Refresh">↻</button>
              <div class="footer-select-col">
                <select class="footer-select" id="event-select">
                  ${this._events.length
                    ? this._events.map(e => `<option value="${esc(e.id)}"${e.id === selectedEv ? ' selected' : ''}>${esc(e.label)}</option>`).join('')
                    : `<option value="">Event</option>`}
                </select>
                <span class="footer-updated">${updated}</span>
              </div>
            </div>
          </div>
        </div>
      </ha-card>`;

    // ── Events ───────────────────────────────────────────────────────────────
    const $ = (sel) => this.shadowRoot.querySelector(sel);
    $('#refresh-btn')?.addEventListener('click', e => { e.stopPropagation(); this._fetch(); });
    $('#btn-default')?.addEventListener('click', () => this._setMode('default'));
    $('#btn-custom')?.addEventListener('click', () => this._setMode('custom'));
    $('#btn-save')?.addEventListener('click', () => this._handleSaveBtnClick());
    $('#btn-clear')?.addEventListener('click', e => {
      e.stopPropagation();
      if (this._mode === 'saved') this._clearSaved();
      else if (this._mode === 'custom') this._clearCustom();
    });
    $('#event-select')?.addEventListener('change', e => {
      e.stopPropagation();
      this._selectedEventId = e.target.value || null;
      lsSet(STORAGE_EVENT_KEY, this._selectedEventId);
      this._players = []; this._pars = []; this._info = {};
      this._roundInfo = {}; this._roundSel = null;
      this._loading = true; this._error = null;
      this._render();
      this._fetch();
    });
    $('#round-select')?.addEventListener('change', e => {
      e.stopPropagation();
      const r = parseInt(e.target.value, 10);
      // Picking the current round goes back to following the live round
      this._roundSel = r === this._roundInfo?.current ? null : r;
      this._render();
    });
    $('#round-select')?.addEventListener('click', e => e.stopPropagation());
    this.shadowRoot.querySelectorAll('.row-select').forEach(sel => {
      sel.addEventListener('change', e => {
        e.stopPropagation();
        const row = parseInt(sel.dataset.row, 10);
        if (sel.dataset.mode === 'saved') this._setSavedRow(row, sel.value);
        else this._setCustomRow(row, sel.value);
      });
      // Keep taps on the dropdown from reaching the dashboard
      sel.addEventListener('click', e => e.stopPropagation());
    });
  }

  // ─── CSS ──────────────────────────────────────────────────────────────────

  _css() {
    return `
      :host { display: block; }
      .card {
        background: #000;
        border-radius: var(--ha-card-border-radius, 12px);
        overflow: hidden;
        font-family: 'Arial Narrow', Arial, sans-serif;
      }

      /* ── Scoreboard ── */
      .board-wrap { position: relative; width: 100%; line-height: 0; container-type: inline-size; background: #fff; }
      .board { display: block; width: 100%; height: auto; }
      .board text {
        font-family: 'Arial Narrow', Arial, sans-serif;
        font-weight: bold;
        font-size: 50px;
        text-anchor: middle;
        dominant-baseline: central;
        fill: ${INK};
      }
      .board .frame { fill: #fff; stroke: ${FRAME}; stroke-width: 8; stroke-linejoin: round; }
      .board .frame-line { stroke: ${FRAME}; stroke-width: 8; }
      .board .rules line { stroke: ${INK}; }
      .board .title { font-family: Arial, sans-serif; font-size: 80px; font-weight: 900; letter-spacing: 10px; }
      .board .label { font-family: Arial, sans-serif; font-size: 44px; font-weight: 900; }
      .board .prior-label text { font-family: Arial, sans-serif; font-size: 24px; font-weight: 900; }
      .board .hdr text { font-family: Arial, sans-serif; font-size: 44px; font-weight: 500; }
      .board .name { text-anchor: start; }
      .board .star { font-size: 22px; fill: #c8a951; }
      .board .msg { font-family: Arial, sans-serif; font-size: 40px; font-weight: 600; fill: #555; }
      .board .msg-plate { fill: #fff; stroke: ${FRAME}; stroke-width: 3; }

      /* ── Overlay: custom-mode player dropdowns ── */
      .overlay { position: absolute; inset: 0; pointer-events: none; }
      .row-select {
        position: absolute;
        background: rgba(255,255,255,0.92);
        border: 1px solid #c8a951;
        border-radius: 3px;
        font-size: 2.6cqw;
        font-family: 'Arial Narrow', Arial, sans-serif;
        cursor: pointer;
        pointer-events: all;
        padding: 0 4px;
        box-sizing: border-box;
        color: #000;
      }
      .row-select:focus { outline: 2px solid #c8a951; }

      /* ── Footer ── */
      .footer {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 12px;
        background: #1a3a1a;
        border-top: 2px solid #c8a951;
        font-family: Georgia, serif;
      }
      .footer-left { display: flex; flex-direction: column; justify-content: space-between; align-self: stretch; gap: 4px; min-width: 0; }
      .footer-banner { color: #527052; font-size: 11px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .round-pick { position: relative; display: inline-block; cursor: pointer; }
      .round-pick select {
        position: absolute; inset: 0; width: 100%; height: 100%;
        opacity: 0; cursor: pointer; font-size: 16px; /* 16px stops iOS zooming on focus */
      }
      .footer-selects { display: flex; gap: 6px; align-items: flex-start; }
      .footer-select-col { display: flex; flex-direction: column; gap: 2px; }
      .footer-select {
        background: transparent;
        border: 1px solid #527052;
        color: #8ab88a;
        border-radius: 4px;
        padding: 3px 6px;
        font-size: 11px;
        font-family: Georgia, serif;
        cursor: pointer;
        width: 28cqw;
        min-width: 110px;
        max-width: 200px;
      }
      .footer-select:hover { border-color: #c8a951; color: #c8a951; }
      .footer-select:focus { outline: 1px solid #c8a951; }
      .footer-select option { background: #1a3a1a; color: #8ab88a; }
      .footer-updated { color: #527052; font-size: 10px; }

      .view-btns { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
      .view-btn {
        background: transparent;
        border: 1px solid #527052;
        color: #527052;
        border-radius: 4px;
        padding: 3px 0;
        width: 54px;
        font-size: 11px;
        font-family: Georgia, serif;
        font-weight: bold;
        cursor: pointer;
        transition: background 0.2s, color 0.2s, border-color 0.2s;
      }
      .view-btn:hover { border-color: #8ab88a; color: #8ab88a; }
      .view-btn.active { background: #c8a951; border-color: #c8a951; color: #1a3a1a; }
      .view-btn.save-pending { border-color: #c8a951; color: #c8a951; }
      .view-btn.save-dirty { background: #1a3a1a; border-color: #c8a951; color: #c8a951; }

      .round-btn {
        background: transparent;
        border: 1px solid #527052;
        color: #527052;
        width: 18px; height: 18px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 11px;
        line-height: 1;
        padding: 0;
      }
      .round-btn:hover { border-color: #c8a951; color: #c8a951; }
      .round-btn.invisible { visibility: hidden; pointer-events: none; }
    `;
  }
}

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, GolfLeaderboardCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: 'Golf Leaderboard Card',
  description: 'Classic tournament scoreboard with live PGA Tour scoring, real course pars, and a pick-your-players view.',
  preview: true,
  documentationURL: 'https://github.com/AOPW-llc/golf-leaderboard-card',
});

console.info(`%c GOLF-LEADERBOARD-CARD %c v${VERSION} `,
  'color:#fff;background:#1a3a1a;font-weight:bold', 'color:#1a3a1a;background:#c8a951');
