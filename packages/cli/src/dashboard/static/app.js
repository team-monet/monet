/* ── Monet Dashboard — app.js ── */
/* Vanilla JS + Canvas. No frameworks, no CDN. */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const KIND_COLORS = {
  fact:         '#60a5fa',
  decision:     '#c084fc',
  project:      '#34d399',
  architecture: '#f59e0b',
  feedback:     '#f472b6',
  reference:    '#818cf8',
  pattern:      '#2dd4bf',
  workstream:   '#a78bfa',
  issue:        '#f87171',
  insight:      '#fbbf24',
  user:         '#6ee7b7',
  procedure:    '#a3e635',
  gotcha:       '#fb923c',
};

const EDGE_COLORS = {
  about:               '#4ec9b0',
  related:             '#818cf8',
  co_occurred:         '#55527a',
  follows:             '#f59e0b',
  possible_duplicate_of: '#f87171',
};

const EDGE_DEFAULTS = {
  about:               false,
  related:             true, // drawn by default (shows all semantic links); exerts only a gentle layout pull so it doesn't clump
  co_occurred:         false,
  follows:             true,
  possible_duplicate_of: true,
};

const EDGE_DASHED = new Set(['possible_duplicate_of']);

// ── State ────────────────────────────────────────────────────────────────────

let DATA = null;         // /api/graph payload
let ENTITIES = null;     // /api/entities payload (lazy)
// Generation counter — incremented when Refresh clears the ENTITIES cache.
// fetchEntities() captures the counter at call time; if it has changed when the
// response arrives, the result is discarded so a slow in-flight response from a
// prior Refresh cannot overwrite a freshly-invalidated cache.
let _entitiesGen = 0;

const state = {
  circle: 'all',
  search: '',
  selectedId: null,
  activeTab: 'graph',
  kindsOff: new Set(),
  flags: new Set(),
  minConfidence: 0,
  edgeTypes: { ...EDGE_DEFAULTS },
  minWeight: 0,
  entityOverlay: false,
  conceptSort: { col: 'updated_at', dir: -1 },
  entitySort: { col: 'df', dir: -1 },
};

// ── localStorage persistence ─────────────────────────────────────────────────

const LS_KEY = 'monet-dash:v1';
const LS_SCHEMA_V = 8; // bumped 2026-06-20: invalidates cameras written by premature onCircleChange scheduleSave (were saved before sim settled, so pointed at wrong world region)

function lsGet() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed.__v === LS_SCHEMA_V) return parsed;
    // One-time migration from __v:7 → __v:8: strip only cam_* entries (the
    // only thing that was ever poisoned — positions/pins were always correct and
    // round-trip-verified at 0px). Everything else (pos_*, pin_*, UI) is preserved.
    // Any other version mismatch is treated as a full schema reset (unknown shape).
    if (parsed.__v === 7) {
      const migrated = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k.startsWith('cam_')) continue; // strip poisoned cameras
        migrated[k] = v;
      }
      migrated.__v = LS_SCHEMA_V;
      try { localStorage.setItem(LS_KEY, JSON.stringify(migrated)); } catch (_) {}
      return migrated;
    }
    return {}; // unknown version — full reset
  } catch (_) { return {}; }
}

function lsSet(data) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ __v: LS_SCHEMA_V, ...data }));
  } catch (_) { /* quota / private mode */ }
}

// Debounced save — call whenever meaningful state changes
let _lsTimer = null;
function scheduleSave() {
  if (_lsTimer) clearTimeout(_lsTimer);
  _lsTimer = setTimeout(persistState, 300);
}

function persistState() {
  const stored = lsGet();

  // Positions keyed per circle (id → [x,y])
  const posKey = 'pos_' + state.circle;
  const camKey = 'cam_' + state.circle;
  const pinKey = 'pin_' + state.circle;

  const posMap = {};
  const pinMap = {};
  for (const n of SIM.nodes) {
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
      posMap[n.id] = [Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10];
      if (n.pinned) pinMap[n.id] = true;
    }
  }

  // Only persist the camera when the sim has settled. If the sim hasn't settled
  // (SIM.settledOnce is false) the camera may still reflect the outgoing circle —
  // writing it here would re-introduce the "poisoned cam_<circle>" bug under __v:8
  // (the schema bump that retired it). Preserve any previously-written camera instead.
  const camEntry = SIM.settledOnce
    ? {
        scale: Math.round(CVS.scale * 1000) / 1000,
        tx: Math.round(CVS.tx * 10) / 10,
        ty: Math.round(CVS.ty * 10) / 10,
      }
    : stored[camKey]; // keep existing value (undefined → omitted from payload)

  const payload = {
    ...stored,
    [posKey]: posMap,
    [pinKey]: pinMap,
    ...(camEntry !== undefined ? { [camKey]: camEntry } : {}),
    // UI state
    circle: state.circle,
    activeTab: state.activeTab,
    kindsOff: [...state.kindsOff],
    edgeTypes: { ...state.edgeTypes },
    minConfidence: state.minConfidence,
    minWeight: state.minWeight,
    entityOverlay: state.entityOverlay,
  };
  lsSet(payload);
}

// Restore positions + pins for current circle from localStorage
// Returns { posMap, pinMap, camera } or null
function restoreForCircle(circle) {
  const stored = lsGet();
  const posKey = 'pos_' + circle;
  const camKey = 'cam_' + circle;
  const pinKey = 'pin_' + circle;
  return {
    posMap: stored[posKey] || null,
    pinMap: stored[pinKey] || null,
    camera: stored[camKey] || null,
  };
}

// Clear saved positions/pins/camera for current circle
function clearSavedLayout(circle) {
  const stored = lsGet();
  delete stored['pos_' + circle];
  delete stored['pin_' + circle];
  delete stored['cam_' + circle];
  lsSet(stored);
}

// Restore UI state (filters, active tab) from localStorage on init
function restoreUiState() {
  const stored = lsGet();
  if (!stored.__v) return;

  if (stored.circle) state.circle = stored.circle;
  if (stored.activeTab) state.activeTab = stored.activeTab;
  if (Array.isArray(stored.kindsOff)) state.kindsOff = new Set(stored.kindsOff);
  if (stored.edgeTypes) {
    for (const k of Object.keys(EDGE_DEFAULTS)) {
      if (k in stored.edgeTypes) state.edgeTypes[k] = stored.edgeTypes[k];
    }
  }
  if (typeof stored.minConfidence === 'number') state.minConfidence = stored.minConfidence;
  if (typeof stored.minWeight === 'number') state.minWeight = stored.minWeight;
  if (typeof stored.entityOverlay === 'boolean') state.entityOverlay = stored.entityOverlay;
}

// ── Utility ──────────────────────────────────────────────────────────────────

function kindColor(k) { return KIND_COLORS[k] || '#64748b'; }
function edgeColor(t) { return EDGE_COLORS[t] || '#444'; }

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtRelTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(ms);
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Light markdown renderer (headings, bold, italic, code, lists, links, wikilinks)
function renderMd(text, conceptMap) {
  if (!text) return '';
  // Strip NUL bytes before anything else — prevents user-supplied \x00CODE{n}\x00
  // strings from colliding with the placeholder tokens inserted during fenced-code
  // extraction, which would cause content displacement or "undefined" leaks.
  text = String(text).replace(/\x00/g, '');
  let html = escHtml(text);

  // Extract ALL code (fenced blocks + inline spans) BEFORE wikilink expansion so
  // [[wikilink]] inside code renders literally instead of becoming an <a>.
  // Restore happens last, after all other passes, so code content is never
  // re-processed by bold/italic/heading/paragraph rules.
  const codeBlocks = [];

  // Fenced code blocks — extract first so the inner lines never see any other pass.
  html = html.replace(/```[\s\S]*?```/g, (m) => {
    const inner = m.slice(3, -3).replace(/^\w+\n/, '');
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${inner}</code></pre>`);
    return `\x00CODE${idx}\x00`;
  });

  // Inline code spans — extract second (after fenced, before wikilinks).
  html = html.replace(/`([^`]+)`/g, (_, c) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<code>${c}</code>`);
    return `\x00CODE${idx}\x00`;
  });

  // Wikilinks [[slug]] -> clickable (runs AFTER code extraction so [[...]] inside
  // code blocks/spans are already behind placeholder tokens and won't be expanded).
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_, slug) => {
    const target = conceptMap ? (conceptMap[slug] || conceptMap[slug.toLowerCase()]) : null;
    if (target) {
      return `<a href="#" class="wikilink" data-id="${escHtml(target.id)}">${escHtml(slug)}</a>`;
    }
    return `<span style="color:var(--text-muted)">[[${escHtml(slug)}]]</span>`;
  });

  // Bold — boundary-aware: a literal/wildcard * (tag v*, select *, 3*4) must NOT
  // start emphasis. Opening ** preceded by start/non-word and followed by non-space;
  // closing ** preceded by non-space and not followed by a word char.
  html = html.replace(/(^|[^\w*])\*\*(?=\S)([^*\n]*?\S)\*\*(?![\w])/g, '$1<strong>$2</strong>');
  // Underscore bold only at word boundaries — never inside snake_case identifiers.
  html = html.replace(/(^|[^\w])__([^_]+?)__(?![\w])/g, '$1<strong>$2</strong>');

  // Italic — same boundary rules for single * (so "on tag v*" stays literal).
  html = html.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w])/g, '$1<em>$2</em>');
  // Underscore italic only at word boundaries — so memory_fetch / source_refs etc.
  // stay literal and don't get italicized between two snake_case underscores.
  html = html.replace(/(^|[^\w])_([^_]+?)_(?![\w])/g, '$1<em>$2</em>');

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Unordered lists (basic)
  html = html.replace(/^[*\-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>(\n|$))+/g, m => `<ul>${m}</ul>`);

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs (lines not already wrapped)
  const lines = html.split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { out.push(''); continue; }
    if (t.startsWith('<h') || t.startsWith('<ul') || t.startsWith('<li') || t.startsWith('<pre') || t.startsWith('<code') || t.startsWith('\x00CODE')) {
      out.push(t);
    } else {
      out.push(`<p>${t}</p>`);
    }
  }

  // Restore fenced code blocks and inline code spans (all tokenised above).
  return out.join('\n').replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[+i]);
}

// Build concept lookup maps
function buildConceptMaps(concepts) {
  const byId = {};
  const bySlug = {};
  const byTitle = {};
  for (const c of concepts) {
    byId[c.id] = c;
    if (c.slug) bySlug[c.slug] = c;
    if (c.title) byTitle[c.title.toLowerCase()] = c;
  }
  // Combined map for wikilinks: slug + title (lowercased)
  const wikiMap = { ...bySlug };
  for (const c of concepts) {
    if (c.title) wikiMap[c.title.toLowerCase()] = c;
    if (c.slug) wikiMap[c.slug.toLowerCase()] = c;
  }
  return { byId, bySlug, byTitle, wikiMap };
}

// ── Derived data helpers ─────────────────────────────────────────────────────

function getFilteredConcepts() {
  if (!DATA) return [];
  const search = state.search.toLowerCase();
  return DATA.concepts.filter(c => {
    if (state.circle !== 'all') {
      // Match by circle (resolving alias)
      const canon = aliasMap()[c.circle] || c.circle;
      if (canon !== state.circle && c.circle !== state.circle) return false;
    }
    if (state.kindsOff.has(c.kind)) return false;
    if (state.flags.has('disputed') && c.status !== 'disputed') return false;
    if (state.flags.has('dirty') && !c.dirty) return false;
    if (state.flags.has('has-contradiction')) {
      const hasC = DATA.contradictions.some(ct => ct.concept_id === c.id && ct.status === 'open');
      if (!hasC) return false;
    }
    if (state.flags.has('possible-duplicate')) {
      const hasDup = DATA.edges.some(e =>
        e.type === 'possible_duplicate_of' && (e.src_id === c.id || e.dst_id === c.id));
      if (!hasDup) return false;
    }
    if (state.minConfidence > 0 && (c.confidence === null || c.confidence < state.minConfidence)) return false;
    if (search) {
      if (!c.title.toLowerCase().includes(search) &&
          !(c.slug || '').toLowerCase().includes(search) &&
          !(c.body || '').toLowerCase().includes(search)) return false;
    }
    return true;
  });
}

function getFilteredEdges(nodeIds) {
  if (!DATA) return [];
  const idSet = new Set(nodeIds);
  return DATA.edges.filter(e => {
    if (!state.edgeTypes[e.type]) return false;
    if ((e.weight ?? 0) < state.minWeight) return false;
    if (!idSet.has(e.src_id) || !idSet.has(e.dst_id)) return false;
    return true;
  });
}

function aliasMap() {
  if (!DATA) return {};
  const m = {};
  for (const a of DATA.aliases) m[a.from_name] = a.to_name;
  return m;
}

function canonicalCircle(name) {
  return aliasMap()[name] || name;
}

function degreeCounts() {
  if (!DATA) return {};
  const deg = {};
  for (const e of DATA.edges) {
    deg[e.src_id] = (deg[e.src_id] || 0) + 1;
    deg[e.dst_id] = (deg[e.dst_id] || 0) + 1;
  }
  return deg;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchGraph() {
  const r = await fetch('/api/graph');
  if (!r.ok) throw new Error(`/api/graph returned ${r.status}`);
  return r.json();
}

async function fetchEntities() {
  if (ENTITIES) return ENTITIES;
  // Capture generation at call time so a delayed response from a prior Refresh
  // (which set ENTITIES=null and incremented _entitiesGen) cannot repopulate the
  // cache after it was intentionally cleared (entities refresh race, round-5 fix).
  const gen = _entitiesGen;
  const r = await fetch('/api/entities');
  if (!r.ok) throw new Error(`/api/entities returned ${r.status}`);
  const data = await r.json();
  if (_entitiesGen !== gen) return ENTITIES; // stale — discard
  ENTITIES = data;
  return ENTITIES;
}

// ── Top bar & stat bar ───────────────────────────────────────────────────────

function renderTopBar() {
  const sel = document.getElementById('circle-selector');
  sel.innerHTML = '';
  const circles = ['all', ...DATA.circles.map(c => c.canonicalName)];
  for (const name of circles) {
    const btn = document.createElement('button');
    btn.className = 'circle-btn' + (state.circle === name ? ' active' : '');
    if (name === 'all') {
      btn.textContent = `All (${DATA.counts.concepts})`;
    } else {
      const ci = DATA.circles.find(c => c.canonicalName === name);
      btn.textContent = `${name} (${ci ? ci.conceptCount : ''})`;
    }
    btn.onclick = () => { state.circle = name; onCircleChange(); };
    sel.appendChild(btn);
  }
}

function renderStatBar() {
  const bar = document.getElementById('statbar');
  const c = DATA.counts;
  const h = DATA.health;
  const chips = [
    { val: c.concepts, lbl: 'concepts', cls: '' },
    { val: c.observations, lbl: 'observations', cls: '' },
    { val: c.edgesLive, lbl: 'live edges', cls: '' },
    { val: c.entities, lbl: 'entities', cls: '' },
    { val: h.avgConfidence !== null ? (h.avgConfidence * 100).toFixed(0) + '%' : '—', lbl: 'avg conf', cls: h.avgConfidence > 0.7 ? 'ok' : h.avgConfidence > 0.4 ? 'warn' : '' },
    { val: h.graphDensity !== null ? h.graphDensity.toFixed(1) : '—', lbl: 'density', cls: '' },
    { val: c.disputed, lbl: 'disputed', cls: c.disputed > 0 ? 'danger' : '' },
    { val: c.contradictionsOpen, lbl: 'open contradictions', cls: c.contradictionsOpen > 0 ? 'warn' : '' },
    { val: c.possibleDuplicatePairs, lbl: 'dup pairs', cls: c.possibleDuplicatePairs > 0 ? 'accent' : '' },
    { val: c.dirty, lbl: 'dirty', cls: c.dirty > 0 ? 'warn' : '' },
    { val: c.sessions, lbl: 'sessions', cls: '' },
  ];
  bar.innerHTML = chips.map(chip =>
    `<div class="stat-chip ${chip.cls}">
      <span class="val">${chip.val}</span>
      <span class="lbl">${chip.lbl}</span>
    </div>`
  ).join('');
}

// ── Left rail ────────────────────────────────────────────────────────────────

function renderRail() {
  renderKindChips();
  renderEdgeTypeRows();
}

function renderKindChips() {
  const kindCounts = {};
  for (const c of DATA.concepts) {
    kindCounts[c.kind] = (kindCounts[c.kind] || 0) + 1;
  }
  const el = document.getElementById('kind-chips');
  el.innerHTML = '';
  for (const [kind, color] of Object.entries(KIND_COLORS)) {
    const cnt = kindCounts[kind] || 0;
    if (cnt === 0) continue;
    const off = state.kindsOff.has(kind);
    const chip = document.createElement('div');
    chip.className = 'kind-chip' + (off ? ' off' : '');
    chip.innerHTML = `<span class="dot" style="background:${color}"></span>${kind} <span style="color:var(--text-muted);font-size:10px">${cnt}</span>`;
    chip.onclick = () => toggleKind(kind);
    el.appendChild(chip);
  }
}

const EDGE_TYPE_ORDER = ['related', 'follows', 'possible_duplicate_of', 'about', 'co_occurred'];

function renderEdgeTypeRows() {
  const edgeCounts = {};
  for (const e of DATA.edges) {
    edgeCounts[e.type] = (edgeCounts[e.type] || 0) + 1;
  }
  const el = document.getElementById('edge-type-rows');
  el.innerHTML = '';
  for (const type of EDGE_TYPE_ORDER) {
    const on = state.edgeTypes[type];
    const row = document.createElement('div');
    row.className = 'edge-row' + (on ? ' active' : '') + (EDGE_DASHED.has(type) ? ' dashed' : '');
    const color = edgeColor(type);
    row.innerHTML = `
      <span class="edge-swatch" style="background:${color};opacity:0.8"></span>
      <span>${type.replace(/_/g, ' ')}</span>
      <span class="edge-cnt">${edgeCounts[type] || 0}</span>
    `;
    row.onclick = () => {
      state.edgeTypes[type] = !state.edgeTypes[type];
      renderEdgeTypeRows();
      redrawGraph();
      rerenderActiveView();
      scheduleSave();
    };
    el.appendChild(row);
  }
}

function toggleKind(kind) {
  if (state.kindsOff.has(kind)) state.kindsOff.delete(kind);
  else state.kindsOff.add(kind);
  renderKindChips();
  redrawGraph();
  rerenderActiveView();
  scheduleSave();
}

// ── Circle change ────────────────────────────────────────────────────────────

function onCircleChange() {
  renderTopBar();
  // Frozen restore of the incoming circle's saved layout + camera — do NOT scatter
  // and reheat (that made every dot dance and settle into a ring on each switch).
  // New/unseen nodes settle locally while existing ones stay pinned; the charge
  // distance-floor prevents the close-proximity explosions the old scatter avoided.
  redrawGraph(false);
  rerenderActiveView();
  // NOTE: do NOT call scheduleSave() here. The sim settle path (tick) and the
  // frozen-restore path (initSim) both call scheduleSave() once the camera is
  // correct. Calling it here fires 300ms after the circle switch — long before
  // the fresh sim settles (~7.6s) — and bakes the old camera (from the outgoing
  // circle) into cam_<new-circle>, causing the "camera on empty space" bug on
  // the second visit.
}

// ── Graph simulation ─────────────────────────────────────────────────────────

const SIM = {
  nodes: [],
  edges: [],
  alpha: 1,
  alphaTarget: 0,      // gentle drag target; tick decays toward this
  alphaDecay: 0.015,
  alphaMin: 0.001,
  velDecay: 0.4,
  running: false,
  rafId: null,
  settledOnce: false,   // whether fitToView has fired for the current node set
  frozenRestore: false, // true while a frozen-restore is in progress (blocks resizeCanvas reheat)
  pendingResetSave: false, // true after Reset Layout click; cleared when tick settle saves

  // Headless pre-settle: true while the synchronous physics loop is running before
  // the first paint. drawFrame() is a no-op during this window, giving a paint count
  // of exactly 0 between layout-start and the fade-in reveal.
  presettling: false,
  // Instrumentation: counts how many times drawFrame() was called during presettling.
  // Should always be 0 after a fresh settle; exposed on SIM for in-browser verification.
  paintsDuringPresettle: 0,

  // Entity overlay nodes
  entityNodes: [],
  entityEdges: [],
};

// ── Spring-physics neighbor-follow tunables ───────────────────────────────────
// Localized spring integrator — active set gets real momentum/trailing, no global dance.
const FOLLOW_HOP_LIMIT          = 2;     // BFS depth from dragged node to include
const FOLLOW_REST_LEN           = 130;   // fallback rest length (per-edge rest lens stored at drag start)
const FOLLOW_SPRING_K           = 0.012; // spring stiffness (lower = more lag/overshoot)
const FOLLOW_FRICTION           = 0.85;  // velocity damping per tick during active drag (momentum/trailing feel)
const FOLLOW_FRICTION_SETTLE    = 0.70;  // stronger damping during post-release settle phase (fast calm)
const FOLLOW_MAX_SPEED          = 8;     // per-node speed clamp (px/tick) — prevents runaway on dense hubs
const FOLLOW_DT                 = 1.0;   // integrator timestep (tuning unit; 1 = natural)
const FOLLOW_REPULSION          = 0;     // repulsion disabled: dense graphs sustain oscillation; spring+friction alone is sufficient
const FOLLOW_ENERGY_THRESHOLD   = 1.5;   // kinetic-energy SUM below this → settle done (sparse graphs terminate early; dense graphs use the tick cap)
const FOLLOW_MAX_SETTLE_TICKS   = 90;    // safety cap: stop settling after this many ticks (~1.5s)

// Canvas state
const CVS = {
  el: null,
  ctx: null,
  width: 0,
  height: 0,
  tx: 0, ty: 0,
  scale: 1,
  dragging: false,
  dragStart: null,
  panStart: null,
  dragNode: null,      // node currently being dragged (exempt from clamps)
  dragMoved: false,    // true once cursor moved > threshold (click vs drag)
  hoveredId: null,
  selectedId: null,

  // Spring-physics neighbor-follow state — populated on drag start.
  // Map<nodeId, { node, vx, vy }> — active follower nodes (not the leader).
  // vx/vy are the spring integrator velocities, updated each tick.
  dragFollowSet: null,
  // Adjacency within the active set: Map<nodeId, nodeId[]> — only edges between
  // active nodes (+ leader). Used by the spring integrator to apply spring forces.
  dragActiveAdj: null,
  // Per-edge rest lengths captured at drag start (actual distances, not nominal).
  // Map<"srcId:dstId", number> — stored both directions so integrator lookup works
  // from either endpoint. Eliminates grab-pop caused by nominal vs actual mismatch.
  dragActiveRestLens: null,
  // true while the post-release settle loop is running (integrator keeps going
  // after mouseup until kinetic energy falls below threshold or tick cap hit).
  dragSettling: false,
  dragSettleTicks: 0,
};

function initCanvas() {
  CVS.el = document.getElementById('graph-canvas');
  CVS.ctx = CVS.el.getContext('2d');
  resizeCanvas();

  CVS.el.addEventListener('mousedown', onMouseDown);
  CVS.el.addEventListener('mousemove', onMouseMove);
  CVS.el.addEventListener('mouseup', onMouseUp);
  CVS.el.addEventListener('mouseleave', onMouseLeave);
  CVS.el.addEventListener('dblclick', onDblClick);
  CVS.el.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', resizeCanvas);

}

// Grow/shrink the canvas IN STEP with the detail panel's width animation: run
// resizeCanvas every frame for the transition window, then stop. Bounded by a deadline
// (unlike a ResizeObserver, which fed back into graph-view's size and hung the page).
// Called from the panel open/close so the graph expands as the panel slides, not only
// when the animation finishes.
let _resizeAnimUntil = 0, _resizeAnimRaf = null;
function animateCanvasResize(durationMs = 300) {
  _resizeAnimUntil = performance.now() + durationMs;
  if (_resizeAnimRaf) return; // a loop is already running; the new deadline extends it
  const step = () => {
    const gv = document.getElementById('graph-view');
    if (gv && gv.clientHeight > 0 && gv.clientWidth > 0) resizeCanvas();
    if (performance.now() < _resizeAnimUntil) {
      _resizeAnimRaf = requestAnimationFrame(step);
    } else {
      _resizeAnimRaf = null;
    }
  };
  _resizeAnimRaf = requestAnimationFrame(step);
}

// Smoothly pan the camera so a node sits at the centre of the (visible) graph canvas.
// The target is recomputed every frame so it tracks the canvas shrinking as the detail
// panel opens — the node lands centred in the FINAL graph area, not the pre-open one.
let _panRaf = null, _panUntil = 0;
function panToNode(node, durationMs = 420) {
  if (!node) return;
  _panUntil = performance.now() + durationMs;
  if (_panRaf) cancelAnimationFrame(_panRaf);
  const step = () => {
    const targetTx = (CVS.width / 2 - node.x) * CVS.scale;
    const targetTy = (CVS.height / 2 - node.y) * CVS.scale;
    CVS.tx += (targetTx - CVS.tx) * 0.2;
    CVS.ty += (targetTy - CVS.ty) * 0.2;
    if (performance.now() < _panUntil) {
      _panRaf = requestAnimationFrame(step);
    } else {
      CVS.tx = (CVS.width / 2 - node.x) * CVS.scale; // settle exactly on centre
      CVS.ty = (CVS.height / 2 - node.y) * CVS.scale;
      _panRaf = null;
      scheduleSave();
    }
  };
  _panRaf = requestAnimationFrame(step);
}

function resizeCanvas() {
  const view = document.getElementById('graph-view');
  const prevH = CVS.height;
  CVS.width = view.clientWidth;
  CVS.height = view.clientHeight;
  CVS.el.width = CVS.width * devicePixelRatio;
  CVS.el.height = CVS.height * devicePixelRatio;
  CVS.el.style.width = CVS.width + 'px';
  CVS.el.style.height = CVS.height + 'px';
  // Use setTransform instead of scale so the DPR transform resets on every call
  // (scale() compounds across calls; setTransform always starts from identity)
  CVS.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  // If height just became non-zero (was 0 from a stale layout or a first-paint race),
  // reposition all sim nodes to the real canvas center and reheat the simulation so
  // the force layout runs with correct geometry.
  // EXCEPTION: skip this when in frozen-restore mode — the saved positions are correct
  // and we must not scatter + reheat them.
  if (prevH === 0 && CVS.height > 0 && SIM.nodes && SIM.nodes.length > 0 && !SIM.frozenRestore && !SIM.presettling) {
    const cx = CVS.width / 2, cy = CVS.height / 2;
    // Re-seed using cluster anchors in "all" mode (same logic as seedPos in initSim)
    const _rszAnchors = null; // organic layout: seed randomly, let forces organize
    const _rszAlias = DATA ? aliasMap() : {};
    for (const n of [...SIM.nodes, ...SIM.entityNodes]) {
      if (_rszAnchors && n.circle) {
        const canon = _rszAlias[n.circle] || n.circle;
        const anchor = _rszAnchors[canon];
        if (anchor) {
          n.x = anchor.ax + (Math.random() - 0.5) * 120;
          n.y = anchor.ay + (Math.random() - 0.5) * 120;
        } else {
          n.x = cx + (Math.random() - 0.5) * 200;
          n.y = cy + (Math.random() - 0.5) * 200;
        }
      } else {
        n.x = cx + (Math.random() - 0.5) * 300;
        n.y = cy + (Math.random() - 0.5) * 300;
      }
    }
    reheat(1);
  }

  drawFrame();
}

function resetView() {
  CVS.tx = 0;
  CVS.ty = 0;
  CVS.scale = 1;
}

// ── fitToView — frame all visible nodes with padding ─────────────────────────
// After settle (or filter change), compute the bounding box of node positions
// and set tx/ty/scale so nodes fill the canvas with ~9% padding on each side.
// This runs in world coordinates: nodes live in [0..W, 0..H] space but the
// camera transform is: screenXY = translate(tx + W/2, ty + H/2) → scale →
// translate(-W/2, -H/2) applied to worldXY.
// So: screenX = (worldX - W/2) * scale + tx + W/2
// Inverting for a desired screen rect [padPx..W-padPx, padPx..H-padPx]:
//   scale = (availW / bbW, availH / bbH).min
//   tx = screenCenterX - worldCenterX * scale  (where screenCenter = W/2)
//   ty = screenCenterY - worldCenterY * scale
function fitToView(nodes) {
  if (!nodes || nodes.length === 0) return;
  const W = CVS.width, H = CVS.height;
  if (W === 0 || H === 0) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    // Only include nodes with fully finite, non-exploded coordinates.
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    const r = (n.r || 8) + 18; // +18 covers label text below the node
    if (n.x - r < minX) minX = n.x - r;
    if (n.x + r > maxX) maxX = n.x + r;
    if (n.y - r < minY) minY = n.y - r;
    if (n.y + r > maxY) maxY = n.y + r;
  }

  // If no finite nodes or bbox is degenerate, fall back to a centered identity
  // view so the canvas is never zoomed to nothing.
  if (!isFinite(minX) || !isFinite(maxX)) {
    CVS.scale = 1;
    CVS.tx = 0;
    CVS.ty = 0;
    return;
  }

  const PAD = 0.09; // 9% padding each side
  const bbW = maxX - minX;
  const bbH = maxY - minY;
  const availW = W * (1 - 2 * PAD);
  const availH = H * (1 - 2 * PAD);

  // For a degenerate point/line bbox use a reasonable default scale.
  const fitScale = (bbW < 1 && bbH < 1)
    ? 1
    : Math.min(
        bbW > 0 ? availW / bbW : Infinity,
        bbH > 0 ? availH / bbH : Infinity,
        1.5  // cap zoom-in at 1.5× so small circles (6 nodes) don't balloon
      );

  // Guard: never zoom out to near-zero (protects against exploded positions
  // that somehow survived the finite check).
  const safeScale = Math.max(fitScale, 0.05);

  const bbCX = (minX + maxX) / 2;
  const bbCY = (minY + maxY) / 2;

  // screen = (world - W/2)*scale + tx + W/2
  // We want bbCenter to map to screen center (W/2, H/2):
  //   W/2 = (bbCX - W/2)*scale + tx + W/2  →  tx = -(bbCX - W/2)*scale
  CVS.scale = safeScale;
  CVS.tx = -(bbCX - W / 2) * safeScale;
  CVS.ty = -(bbCY - H / 2) * safeScale;
}

// ── Physics ──────────────────────────────────────────────────────────────────

// frozenRestore=true: skip simulation, apply saved camera immediately, only
// settle new (unsaved) nodes with a very brief low-alpha burst that won't
// disturb the pinned saved nodes.
function initSim(nodes, edges, entityNodes, entityEdges, frozenRestore = false) {
  SIM.nodes = nodes;
  SIM.edges = edges;
  SIM.entityNodes = entityNodes;
  SIM.entityEdges = entityEdges;
  // Invalidate cached hub set so it recomputes with new edges
  drawFrame._hubSet = null;
  drawFrame._hubSetVersion = -1;

  const cx = CVS.width / 2 || 625;
  const cy = CVS.height / 2 || 400;
  // Positions more than this distance from canvas centre are considered
  // exploded/stale and are re-scattered rather than preserved.
  const MAX_SANE = Math.max(CVS.width, CVS.height, 1000) * 4;

  // In "all" mode, pre-compute circle anchors for cluster seeding so fresh
  // nodes start near their circle's anchor rather than in a random central blob.
  const _seedAnchors = null; // organic layout: seed randomly, let forces organize
  const _seedAliasMap = DATA ? aliasMap() : {};

  function seedPos(n) {
    const sane = Number.isFinite(n.x) && Number.isFinite(n.y)
      && Math.abs(n.x - cx) < MAX_SANE && Math.abs(n.y - cy) < MAX_SANE;
    if (!sane) {
      if (_seedAnchors && n.circle) {
        // Cluster seed: place node near its circle's anchor with small jitter (~60px)
        const canon = _seedAliasMap[n.circle] || n.circle;
        const anchor = _seedAnchors[canon];
        if (anchor) {
          const jitter = 60;
          n.x = anchor.ax + (Math.random() - 0.5) * jitter * 2;
          n.y = anchor.ay + (Math.random() - 0.5) * jitter * 2;
        } else {
          // Unknown circle — fall back to center disc
          n.x = cx + (Math.random() - 0.5) * 200;
          n.y = cy + (Math.random() - 0.5) * 200;
        }
      } else {
        // Single-circle mode or entity node: tight centered disc
        n.x = cx + (Math.random() - 0.5) * 300;
        n.y = cy + (Math.random() - 0.5) * 300;
      }
    }
    n.vx = 0;
    n.vy = 0;
  }

  for (const n of nodes) {
    seedPos(n);
    n.pinned = n.pinned || false;
  }
  for (const n of entityNodes) {
    seedPos(n);
    n.pinned = false;
  }

  if (frozenRestore) {
    // TRUE FREEZE: saved nodes already have their exact positions (set in buildGraph).
    // We must NOT run stepSim at all — not even a brief low-alpha sub-settle — because
    // the per-circle grouping force and per-cluster centroid clamp in stepSim will
    // move nodes even at low alpha, causing the ~60-106px drift seen in "all" mode.
    // New (unsaved) nodes are placed near the centroid/anchor in buildGraph with ±60px
    // jitter; they appear at that position immediately without any further relaxation.
    // This guarantees pixel-stable restore: 0px drift on reload.
    SIM.settledOnce = true;  // prevent fitToView from firing (camera already restored)
    SIM.frozenRestore = false; // not in a live frozen-restore sub-settle; resizeCanvas safe
    SIM.alpha = 0;
    SIM.running = false;
    // Restore original pinned state for all saved nodes immediately (no sim needed).
    for (const n of SIM.nodes) {
      if (n._savedPos) n.pinned = n._savedPinned || false;
    }

    // Entity-only settle: when the entity overlay is active and entity nodes are
    // newly added (no saved positions), they would otherwise sit at random seed
    // positions because the frozen-restore path skips all stepSim() calls.
    // Fix: run a compact spring-attraction loop that moves ONLY entity nodes
    // toward their linked concept nodes (which already have correct frozen positions).
    // Concept nodes are kept pinned throughout so this never disturbs the frozen layout.
    if (entityNodes.length > 0) {
      const ENT_ITERS   = 120;   // enough to converge without perceptible cost
      const ENT_SPRING  = 0.12;  // strong attraction — no repulsion to fight
      const ENT_DECAY   = 0.75;  // velocity damping per tick
      // Build a lookup: entity node id → linked concept node objects
      const entLinks = new Map(); // entityNode.id → concept node[]
      for (const ee of entityEdges) {
        // entityEdge: _src = concept node, _dst = entity node
        if (!ee._src || !ee._dst) continue;
        const eid = ee._dst.id;
        if (!entLinks.has(eid)) entLinks.set(eid, []);
        entLinks.get(eid).push(ee._src);
      }
      for (let i = 0; i < ENT_ITERS; i++) {
        for (const en of entityNodes) {
          const targets = entLinks.get(en.id);
          if (!targets || targets.length === 0) continue;
          // Attract toward the centroid of linked concept nodes
          let tx = 0, ty = 0;
          for (const t of targets) { tx += t.x; ty += t.y; }
          tx /= targets.length; ty /= targets.length;
          const dx = tx - en.x, dy = ty - en.y;
          en.vx = (en.vx + dx * ENT_SPRING) * ENT_DECAY;
          en.vy = (en.vy + dy * ENT_SPRING) * ENT_DECAY;
          en.x += en.vx;
          en.y += en.vy;
        }
      }
    }

    scheduleSave(); // persist positions (idempotent — same values as what was saved)
    startLoop();
  } else {
    // FRESH SIM — headless pre-settle: run physics to completion OFF-SCREEN, then
    // reveal the already-arranged graph with a fade-in. The user never sees scatter.
    //
    // Steps:
    //   1. Hide canvas (opacity:0) so any stray rAF paint during startup is invisible.
    //   2. Mark presettling=true so drawFrame() is a no-op (paint count stays 0).
    //   3. Run the same stepSim loop synchronously until alpha<=alphaMin (cap 1000 iter).
    //   4. Apply fitToView / saved camera exactly as the tick settle path does.
    //   5. Mark settledOnce=true, save state, clear presettling.
    //   6. Start the normal render loop (tick) — it now just redraws a static settled graph.
    //   7. Fade canvas in (opacity:0→1, CSS handles 350ms ease transition).

    SIM.alpha = 1;
    SIM.running = false;      // tick loop not started yet; physics runs synchronously below
    SIM.settledOnce = false;
    SIM.frozenRestore = false;
    SIM.presettling = true;
    SIM.paintsDuringPresettle = 0;

    // Hide canvas before any rAF can fire (the canvas may briefly be visible at
    // opacity:1 from a prior layout; set to 0 synchronously so the transition starts clean).
    if (CVS.el) CVS.el.style.opacity = '0';

    // Synchronous physics loop — same decay/step as tick(), no painting.
    // Cap at 1500 iterations as an absolute safety bound (167 nodes settles in ~460 iters).
    const MAX_ITER = 1500;
    let iter = 0;
    while (SIM.alpha > SIM.alphaMin && iter < MAX_ITER) {
      SIM.alpha += (SIM.alphaTarget - SIM.alpha) * SIM.alphaDecay;
      stepSim();
      iter++;
    }
    // Clamp alpha to 0 whether we hit alphaMin or the cap.
    SIM.alpha = 0;

    // Apply camera: fresh-path ALWAYS fits to view.
    // A saved camera is only meaningful when saved POSITIONS are also restored — that is
    // the frozen-restore branch (≥70% saved positions), which is handled separately above
    // and keeps its camera + node-count sanity check. Here the node positions were just
    // computed from scratch, so a previously-saved camera would frame a stale layout
    // (the exact "camera on empty space" bug class). Always frame the freshly-settled nodes.
    fitToView([...SIM.nodes, ...SIM.entityNodes]);

    SIM.settledOnce = true;
    SIM.presettling = false;
    SIM.running = false;

    // Clear pendingResetSave here (the tick settle branch is bypassed in this path).
    SIM.pendingResetSave = false;

    scheduleSave();

    // Log settle stats to console for verification (paint count should be 0).
    console.log(
      '[monet-graph] headless pre-settle complete:',
      iter + ' iters,',
      'alpha=' + SIM.alpha.toFixed(6) + ',',
      'paintsDuringPresettle=' + SIM.paintsDuringPresettle
    );

    // Start the perpetual render loop — draws the static settled graph.
    startLoop();

    // Fade in: set opacity to 1 (CSS transition handles the 350ms ease).
    // Use setTimeout(0) rather than rAF so the reveal fires even in headless/throttled
    // environments where rAF may not advance between JS turns. The CSS transition is
    // triggered by the style change itself, not by a rAF callback — so the visual fade
    // works correctly in real browsers regardless of which scheduler fires first.
    setTimeout(() => {
      if (CVS.el) CVS.el.style.opacity = '1';
    }, 0);
  }
}

function startLoop() {
  if (SIM.rafId) cancelAnimationFrame(SIM.rafId);
  SIM.rafId = requestAnimationFrame(tick);
}

function tick() {
  if (SIM.running) {
    // Decay alpha toward alphaTarget (0 normally; ~0.15 during drag)
    SIM.alpha += (SIM.alphaTarget - SIM.alpha) * SIM.alphaDecay;
    if (SIM.alpha > SIM.alphaMin || SIM.alphaTarget > 0) {
      stepSim();
    }
    if (SIM.alpha <= SIM.alphaMin && SIM.alphaTarget <= 0) {
      SIM.running = false;
      SIM.alpha = 0;
      if (!SIM.settledOnce) {
        // Normal settle: apply saved camera or fit to view, then save.
        // We also schedule a confirmatory re-fit 200 ms later so any residual
        // drift (from nodes still coasting at settle moment) is corrected and
        // the user always sees a fully-framed graph on first load.
        // This branch ONLY runs on a genuine fresh sim (frozenRestore is always
        // false here because the frozen-restore path never lets settledOnce stay false).
        SIM.settledOnce = true;
        const { camera } = restoreForCircle(state.circle);
        if (camera && Number.isFinite(camera.scale) && camera.scale > 0) {
          CVS.scale = camera.scale;
          CVS.tx = camera.tx;
          CVS.ty = camera.ty;
        } else {
          fitToView([...SIM.nodes, ...SIM.entityNodes]);
          // Confirmatory re-fit: captures any coasting movement after alpha=0.
          // Gated by !SIM.frozenRestore (already false here, but explicit for clarity)
          // and !SIM.running so it doesn't fire if a new sim started in the meantime.
          setTimeout(() => {
            if (!SIM.running && !SIM.frozenRestore) fitToView([...SIM.nodes, ...SIM.entityNodes]);
          }, 200);
        }
        scheduleSave();
        // If Reset Layout was clicked, also capture the settled positions now that
        // the sim has genuinely settled (primary save path — more accurate than the
        // 10s backstop timer which may save an intermediate state).
        if (SIM.pendingResetSave) {
          SIM.pendingResetSave = false;
          scheduleSave();
        }
      }
    }
  }
  // ── Spring-physics neighbor-follow integrator ────────────────────────────────
  // Runs UNCONDITIONALLY every frame (outside SIM.running gate) — a drag never
  // reheats the global sim so SIM.running is false during drags; this block MUST
  // live here, not inside the if (SIM.running) block above, or it would be dead.
  // Self-guarded by dragging/settling flags. Covers both:
  //   (a) active drag: leader pinned to cursor, followers spring toward it
  //   (b) post-release settle: leader fixed at drop, followers damp to rest
  const _springActive = (CVS.dragging && CVS.dragMoved && CVS.dragFollowSet && CVS.dragNode)
                     || (CVS.dragSettling && CVS.dragFollowSet && CVS.dragNode);
  if (_springActive) {
    const leader = CVS.dragNode;
    const followSet = CVS.dragFollowSet;
    const activeAdj = CVS.dragActiveAdj;
    const activeRestLens = CVS.dragActiveRestLens;

    // Build a quick lookup: nodeId → entry (for spring force between followers)
    // The leader is accessible directly as `leader`.
    const entryById = new Map();
    entryById.set(leader.id, { node: leader, vx: 0, vy: 0 }); // leader: v always 0
    for (const [id, entry] of followSet) entryById.set(id, entry);

    // Pick friction based on phase: stronger damping during settle, drag feel during active drag.
    const frict = CVS.dragSettling ? FOLLOW_FRICTION_SETTLE : FOLLOW_FRICTION;

    // Integrate each follower
    for (const [id, entry] of followSet) {
      const n = entry.node;
      let fx = 0, fy = 0;

      // Spring forces: only to other ACTIVE nodes (+ leader) via activeAdj
      const neighbors = activeAdj ? activeAdj.get(id) : null;
      if (neighbors) {
        for (const nid of neighbors) {
          const other = entryById.get(nid);
          if (!other) continue;
          const ox = other.node.x, oy = other.node.y;
          let dx = ox - n.x, dy = oy - n.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          // Use per-edge rest length captured at drag start (actual distance, not nominal).
          // Eliminates grab-pop: springs start at zero extension, so no force at t=0.
          const restLen = activeRestLens ? (activeRestLens.get(id + ':' + nid) ?? FOLLOW_REST_LEN) : FOLLOW_REST_LEN;
          const f = FOLLOW_SPRING_K * (dist - restLen);
          fx += f * dx / dist;
          fy += f * dy / dist;
        }
      }

      // Optional mild repulsion among active followers only (prevents overlap).
      // Distance-gated: only applied within 2×REST_LEN so large clusters don't
      // generate O(n²) forces that overwhelm spring damping and prevent settle.
      // Skipped entirely when FOLLOW_REPULSION=0 (disabled for dense graphs).
      if (FOLLOW_REPULSION > 0) {
        const _repCutoff2 = (FOLLOW_REST_LEN * 2) ** 2;
        for (const [oid, oentry] of followSet) {
          if (oid === id) continue;
          const ox = oentry.node.x, oy = oentry.node.y;
          const dx = n.x - ox, dy = n.y - oy;
          const dist2 = dx * dx + dy * dy;
          if (dist2 > _repCutoff2) continue; // skip distant pairs
          const dist2c = Math.max(dist2, 100);
          const dist = Math.sqrt(dist2c);
          const f = FOLLOW_REPULSION / dist2c;
          fx += f * dx / dist;
          fy += f * dy / dist;
        }
      }

      // Integrate: velocity + friction, then position
      entry.vx = (entry.vx + fx * FOLLOW_DT) * frict;
      entry.vy = (entry.vy + fy * FOLLOW_DT) * frict;

      // Per-node speed clamp: prevents runaway on dense hubs during settle.
      const spd = Math.sqrt(entry.vx * entry.vx + entry.vy * entry.vy);
      if (spd > FOLLOW_MAX_SPEED) { const s = FOLLOW_MAX_SPEED / spd; entry.vx *= s; entry.vy *= s; }

      n.x += entry.vx;
      n.y += entry.vy;
      // Zero global sim velocity so stepSim can't fight back
      n.vx = 0;
      n.vy = 0;
    }
    // Leader: pinned to cursor during drag (handled in onMouseMove),
    // fixed at drop position during settle — just zero its sim velocity.
    leader.vx = 0;
    leader.vy = 0;

    // Post-release settle termination check
    if (CVS.dragSettling) {
      CVS.dragSettleTicks++;
      let ke = 0;
      for (const entry of followSet.values()) {
        ke += entry.vx * entry.vx + entry.vy * entry.vy;
      }
      if (ke < FOLLOW_ENERGY_THRESHOLD || CVS.dragSettleTicks >= FOLLOW_MAX_SETTLE_TICKS) {
        // Settle complete — zero all velocities, clear state, persist positions
        for (const entry of followSet.values()) {
          entry.vx = 0; entry.vy = 0;
          entry.node.vx = 0; entry.node.vy = 0;
        }
        leader.vx = 0; leader.vy = 0;
        CVS.dragFollowSet = null;
        CVS.dragActiveAdj = null;
        CVS.dragActiveRestLens = null;
        CVS.dragSettling = false;
        CVS.dragSettleTicks = 0;
        scheduleSave();
      }
    }
  }
  drawFrame();
  SIM.rafId = requestAnimationFrame(tick);
}

function reheat(amount = 0.3) {
  SIM.alpha = Math.min(1, SIM.alpha + amount);
  SIM.running = true;
}

function setAlphaTarget(target) {
  SIM.alphaTarget = target;
  if (target > 0 && !SIM.running) {
    SIM.running = true;
    if (!SIM.rafId) startLoop();
  }
}

// Circle anchor positions for per-circle grouping force in "all" mode.
// Arranged in an evenly-spaced ring around the canvas centre.
// Populated lazily in stepSim when state.circle === 'all'.
let _circleAnchors = null;
let _circleAnchorVersion = '';

// Per-cluster footprint radius — AREA-proportional so larger circles visually
// occupy more space.  sqrt(count) means AREA ∝ count (perceptually correct).
// K=14, MIN_R=40, MAX_R=160 chosen so example-circle (86 nodes) gets ~130px and
// with-monet (6 nodes) gets ~40px (floor) → ratio ~3.25× for a 14× node diff.
// MIN_R raised from 28→40 so tiny clusters have enough room for physical nodes.
const CLUSTER_K    = 14;
const CLUSTER_MIN  = 40;
const CLUSTER_MAX  = 160;
function clusterRadius(count) {
  return Math.max(CLUSTER_MIN, Math.min(CLUSTER_MAX, CLUSTER_K * Math.sqrt(count)));
}

function getCircleAnchors() {
  if (!DATA) return {};
  const circles = DATA.circles.map(c => c.canonicalName);
  const W = CVS.width || 1250, H = CVS.height || 800;
  // Include canvas size in cache key so anchors recompute on resize
  const key = circles.join(',') + '@' + W + 'x' + H;
  if (_circleAnchorVersion === key && _circleAnchors) return _circleAnchors;
  _circleAnchorVersion = key;
  const cx = W / 2, cy = H / 2;
  const out = {};

  if (circles.length <= 1) {
    // Single circle: place at center
    if (circles.length === 1) out[circles[0]] = { ax: cx, ay: cy };
    _circleAnchors = out;
    return out;
  }

  // Size-aware placement: put the LARGEST cluster at the centre, ring the rest
  // as satellites.  This separates the two biggest clusters (example-circle vs
  // example-project) — they're never adjacent.
  // Sort by conceptCount descending
  const sorted = [...DATA.circles].sort((a, b) => b.conceptCount - a.conceptCount);
  const centerCircle = sorted[0];          // largest → center
  const satellites   = sorted.slice(1);   // rest → ring

  out[centerCircle.canonicalName] = { ax: cx, ay: cy };

  // Per-cluster radii for center and each satellite
  const centerR = clusterRadius(centerCircle.conceptCount);
  const satR = satellites.map(ci => clusterRadius(ci.conceptCount));

  // GAP between cluster edges (center↔satellite and satellite↔satellite)
  const GAP = 44;

  // Each satellite's distance from canvas center:
  //   d_i = R_center + GAP + R_i
  // This gives uniform edge-to-edge gap between center and every satellite.
  const satDist = satR.map(r => centerR + GAP + r);

  // Angle assignment — distribute angles weighted by each satellite's radius so
  // large satellites get more angular room, reducing adjacent-overlap risk.
  // Total weight = sum of all satellite radii; each satellite gets
  //   angle_share = 2π × (R_i / totalWeight)
  const totalWeight = satR.reduce((s, r) => s + r, 0);
  const angles = [];
  let cumAngle = -Math.PI / 2; // start at top
  for (let i = 0; i < satellites.length; i++) {
    const share = (2 * Math.PI) * (satR[i] / totalWeight);
    angles.push(cumAngle + share / 2); // place satellite at center of its slice
    cumAngle += share;
  }

  // Anti-overlap pass: for every adjacent satellite pair, check if their
  // bounding circles would overlap (center-to-center < R_i + R_j + GAP).
  // If so, increase satDist[i] or satDist[j] (the smaller one) until clear.
  for (let iter = 0; iter < 3; iter++) { // iterate to handle chain-pushes
    for (let i = 0; i < satellites.length; i++) {
      const j = (i + 1) % satellites.length;
      const ai = angles[i], aj = angles[j];
      const di = satDist[i], dj = satDist[j];
      // Center-to-center distance between satellite i and j
      const dx = di * Math.cos(ai) - dj * Math.cos(aj);
      const dy = di * Math.sin(ai) - dj * Math.sin(aj);
      const cc = Math.sqrt(dx * dx + dy * dy);
      const minCC = satR[i] + satR[j] + GAP;
      if (cc < minCC) {
        // Push both satellites outward equally
        const deficit = (minCC - cc) / 2;
        satDist[i] = satDist[i] + deficit;
        satDist[j] = satDist[j] + deficit;
      }
    }
  }

  satellites.forEach((ci, i) => {
    out[ci.canonicalName] = {
      ax: cx + Math.cos(angles[i]) * satDist[i],
      ay: cy + Math.sin(angles[i]) * satDist[i],
    };
  });

  _circleAnchors = out;
  return out;
}

function stepSim() {
  const allNodes = [...SIM.nodes, ...SIM.entityNodes];
  const allEdges = [...SIM.edges, ...SIM.entityEdges];
  const n = allNodes.length;
  const alpha = SIM.alpha;
  const W = CVS.width, H = CVS.height;
  const cx = W / 2, cy = H / 2;
  const dragNode = CVS.dragNode; // exempt from clamps while being dragged

  // ── Pre-compute per-cluster data (needed for circle-aware charge) ──────────
  // Build node→circle lookup and per-cluster anchor + radius in "all" mode so
  // we can apply a weaker charge between same-cluster nodes.
  let _nodeCluster = null; // node.id → canonName
  let _clusterR    = null; // canonName → clampR
  let _clusterAnchorMap = null;
  let _clusterCnt  = null; // canonName → count
  if (state.circle === 'all' && DATA) {
    _clusterAnchorMap = getCircleAnchors();
    const _am = aliasMap();
    _nodeCluster = {};
    _clusterCnt  = {};
    for (const node of SIM.nodes) {
      const canon = _am[node.circle] || node.circle;
      _nodeCluster[node.id] = canon;
      _clusterCnt[canon] = (_clusterCnt[canon] || 0) + 1;
    }
    _clusterR = {};
    for (const [name, cnt] of Object.entries(_clusterCnt)) {
      _clusterR[name] = clusterRadius(cnt);
    }
  }

  // ── Charge repulsion ──────────────────────────────────────────────────────
  // In "all" mode, apply a REDUCED charge between same-cluster node pairs so
  // intra-cluster repulsion can't blast nodes to the rim.  Cross-cluster pairs
  // keep the full charge so clusters separate cleanly.
  // INTRA_FACTOR=0.18 means same-cluster charge is ~18% of cross-cluster.
  // CHARGE scaled by node count as before (−820 at 161 nodes).
  const CHARGE = Math.max(-6000, -1600 - n * 22);
  const INTRA_CHARGE_FACTOR = 1.0; // organic: full charge everywhere (no cluster reduction)
  for (let i = 0; i < n; i++) {
    const a = allNodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = allNodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      // Floor the distance so charge can't blow up at close range (stability with small dots).
      const dist2 = Math.max(dx * dx + dy * dy, 100);
      const dist = Math.sqrt(dist2);
      // Same cluster → weaker repulsion so nodes spread into the disc interior
      // rather than piling against the cluster boundary.
      const sameCluster = _nodeCluster
        ? (_nodeCluster[a.id] && _nodeCluster[a.id] === _nodeCluster[b.id])
        : false;
      const q = sameCluster ? CHARGE * INTRA_CHARGE_FACTOR : CHARGE;
      const f = (q * alpha) / dist2;
      const fx = f * dx / dist, fy = f * dy / dist;
      if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
      if (!b.pinned) { b.vx += fx; b.vy += fy; }
    }
  }

  // ── Spring forces along edges ─────────────────────────────────────────────
  // Layout is DRIVEN by the sparse structural edges (follows / possible_duplicate_of)
  // so the graph stays spread. Dense semantic edges (related) are still DRAWN to show
  // all connections, but exert only a GENTLE pull so they don't collapse it into a ball.
  // about / co_occurred are drawn-only when toggled on (no layout force at all).
  const LINK_DIST = 130;
  const layoutStrength = (type) => {
    if (type === 'follows' || type === 'possible_duplicate_of') return 0.02;
    if (type === 'related') return 0.0028;
    return 0; // about, co_occurred: drawn but do not drive the layout
  };
  for (const e of allEdges) {
    const a = e._src, b = e._dst;
    if (!a || !b) continue;
    const ls = layoutStrength(e.type);
    if (ls === 0) continue;
    let dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const strength = ls * alpha;
    const delta = (dist - LINK_DIST) / dist * strength;
    const fx = dx * delta, fy = dy * delta;
    if (!a.pinned) { a.vx += fx; a.vy += fy; }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
  }

  // ── Center gravity ─────────────────────────────────────────────────────────
  // In "all" mode: very weak global gravity (0.012) to prevent off-screen drift.
  // In single-circle mode: stronger (0.10) to keep the cloud centered.
  const GRAVITY = (state.circle === 'all' ? 0.007 : 0.06) * alpha;
  for (const node of allNodes) {
    if (node.pinned) continue;
    node.vx += (cx - node.x) * GRAVITY;
    node.vy += (cy - node.y) * GRAVITY;
  }

  // ── Per-circle grouping + inward disc fill (only in "all" mode) ────────────
  // Two complementary pulls toward the cluster anchor:
  //   GROUP_STR (0.055): flat pull toward anchor — keeps clusters cohesive.
  //   DISC_FILL: inward pull proportional to how far the node is from the anchor,
  //     expressed as a fraction of clampR — activates gently near the edge and
  //     strengthens as the node approaches the boundary.  This fills the disc
  //     interior by giving nodes a restoring force toward the center that grows
  //     with radius, counteracting the outward charge.
  // (Organic layout) Per-circle anchor grouping + disc-fill removed. Clustering now
  // emerges purely from edge link-forces; circles still cohere because their edges are
  // within-circle and same-cluster charge is reduced. No forced geometry, no circles.

  // ── Collision avoidance (short-range, node-circle separation) ─────────────
  // Prevents nodes from overlapping. Same-cluster pairs use a reduced collision
  // strength (COL_INTRA) so that near-boundary packing doesn't eject nodes
  // beyond the containment radius — the disc-fill inward force can then win.
  const COL       = 0.8;   // collision strength (uniform — organic)
  const COL_INTRA = 0.8;   // organic: same separation everywhere
  for (let i = 0; i < n; i++) {
    const a = allNodes[i];
    const ra = a.r || 8;
    for (let j = i + 1; j < n; j++) {
      const b = allNodes[j];
      const rb = b.r || 8;
      let dx = b.x - a.x, dy = b.y - a.y;
      // Intra-cluster: no extra gutter (just node radii) so small clusters don't
      // force nodes outside Rc. Cross-cluster keeps the +6px gutter.
      const sameCluster = _nodeCluster
        ? (_nodeCluster[a.id] && _nodeCluster[a.id] === _nodeCluster[b.id])
        : false;
      const gutter = 16; // organic: uniform breathing room between all dots
      const colStr = COL;
      const minD = ra + rb + gutter;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      if (dist < minD) {
        const overlap = (minD - dist) / dist * colStr;
        const fx = dx * overlap, fy = dy * overlap;
        if (!a.pinned) { a.vx -= fx * 0.5; a.vy -= fy * 0.5; }
        if (!b.pinned) { b.vx += fx * 0.5; b.vy += fy * 0.5; }
      }
    }
  }

  // ── Soft canvas boundary ───────────────────────────────────────────────────
  // Gently push nodes back inside a padded world rect; exempt dragged node.
  const BOUND_PAD = 50; // contain so the layout settles and fills the frame evenly
  const BOUND_STR = 0.26;
  const bL = BOUND_PAD, bR = W - BOUND_PAD;
  const bT = BOUND_PAD, bB = H - BOUND_PAD;
  for (const node of allNodes) {
    if (node.pinned) continue;
    if (node === dragNode) continue;
    if (node.x < bL) node.vx += (bL - node.x) * BOUND_STR;
    if (node.x > bR) node.vx += (bR - node.x) * BOUND_STR;
    if (node.y < bT) node.vy += (bT - node.y) * BOUND_STR;
    if (node.y > bB) node.vy += (bB - node.y) * BOUND_STR;
  }

  // ── Integrate ──────────────────────────────────────────────────────────────
  for (const node of allNodes) {
    if (node.pinned) continue;
    node.vx *= SIM.velDecay;
    node.vy *= SIM.velDecay;
    node.x += node.vx;
    node.y += node.vy;
  }

  // ── Soft radial containment + absolute backstop ───────────────────────────
  // Replaces the previous hard clamp (which was the root cause of the donut).
  // Strategy:
  //   • Within the cluster disc (d ≤ clampR): no containment — nodes settle freely.
  //   • Soft zone (clampR < d ≤ clampR*1.3): spring force grows quadratically,
  //     dragging nodes back in while still allowing some overshoot.
  //   • Hard backstop at clampR*1.35: absolute position clamp as last resort
  //     to prevent complete escape (replaces old clampR hard wall).
  // This preserves proportional sizing (clampR unchanged) but turns the rigid
  // wall into a soft border that nodes naturally avoid rather than pile against.
  const minDim = Math.min(W, H) || 800;
  if (state.circle === 'all' && DATA) {
    // (Organic layout) Per-cluster radial containment removed — no forced circle shells.
    // Entity nodes: global clamp (unchanged)
    let esum_x = 0, esum_y = 0;
    for (const node of SIM.entityNodes) { esum_x += node.x; esum_y += node.y; }
    const ent_n = SIM.entityNodes.length || 1;
    const eCX = esum_x / ent_n, eCY = esum_y / ent_n;
    const entRmax = Math.max(300, minDim * 0.45);
    for (const node of SIM.entityNodes) {
      if (node === dragNode) continue;
      if (CVS.dragFollowSet && CVS.dragFollowSet.has(node.id)) continue;
      const dx = node.x - eCX, dy = node.y - eCY;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      if (d > entRmax) {
        node.x = eCX + (dx / d) * entRmax;
        node.y = eCY + (dy / d) * entRmax;
        const dot = node.vx * (dx / d) + node.vy * (dy / d);
        if (dot > 0) { node.vx -= dot * (dx / d); node.vy -= dot * (dy / d); }
      }
    }
  } else {
    // Single-circle mode: global centroid clamp (unchanged)
    const Rmax = Math.min(minDim * 0.44, 60 + Math.sqrt(n) * 28);
    let sumX = 0, sumY = 0;
    for (const node of allNodes) { sumX += node.x; sumY += node.y; }
    const centX = sumX / n, centY = sumY / n;
    for (const node of allNodes) {
      if (node.pinned) continue;
      if (node === dragNode) continue;
      if (CVS.dragFollowSet && CVS.dragFollowSet.has(node.id)) continue;
      const dx = node.x - centX, dy = node.y - centY;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      if (d > Rmax) {
        node.x = centX + (dx / d) * Rmax;
        node.y = centY + (dy / d) * Rmax;
        const dot = node.vx * (dx / d) + node.vy * (dy / d);
        if (dot > 0) { node.vx -= dot * (dx / d); node.vy -= dot * (dy / d); }
      }
    }
  }
}

// ── Draw ─────────────────────────────────────────────────────────────────────

function drawFrame() {
  // During headless pre-settle the canvas is hidden (opacity:0) and we must not
  // paint intermediate frames — the whole point is zero visible churn.
  // Count any spurious calls so we can assert 0 in the browser console.
  if (SIM.presettling) {
    SIM.paintsDuringPresettle++;
    return;
  }

  const ctx = CVS.ctx;
  const W = CVS.width, H = CVS.height;
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  ctx.translate(CVS.tx + W / 2, CVS.ty + H / 2);
  ctx.scale(CVS.scale, CVS.scale);
  ctx.translate(-W / 2, -H / 2);

  const allNodes = [...SIM.nodes, ...SIM.entityNodes];
  const allEdges = [...SIM.edges, ...SIM.entityEdges];

  const hovered = CVS.hoveredId;
  const selected = state.selectedId;

  // Determine neighbor set for dimming
  let neighbors = null;
  if (hovered || selected) {
    const focusId = hovered || selected;
    neighbors = new Set([focusId]);
    for (const e of allEdges) {
      if (e._src && e._dst) {
        if (e._src.id === focusId) neighbors.add(e._dst.id);
        else if (e._dst.id === focusId) neighbors.add(e._src.id);
      }
    }
  }

  // Compute hub set: top-8 concept nodes by degree (for always-on labels).
  // Cache on the function object so label-drawing inside node loop can read it.
  if (!drawFrame._hubSet || drawFrame._hubSetVersion !== SIM.nodes.length) {
    const degMap = {};
    for (const e of allEdges) {
      if (e._src) degMap[e._src.id] = (degMap[e._src.id] || 0) + 1;
      if (e._dst) degMap[e._dst.id] = (degMap[e._dst.id] || 0) + 1;
    }
    const sorted = SIM.nodes.slice().sort((a, b) => (degMap[b.id] || 0) - (degMap[a.id] || 0));
    drawFrame._hubSet = new Set(sorted.slice(0, 5).map(n => n.id));
    drawFrame._hubSetVersion = SIM.nodes.length;
    // Expose degree map for assertions (dev hook)
    drawFrame._degMap = degMap;
  }

  // (Organic layout) Per-circle halos + cluster labels removed — no spatial circles
  // to label. Node identity comes from hub labels, hover, and the detail panel.

  // Draw edges — curved quadratic bezier arcs for a premium look
  for (const e of allEdges) {
    const a = e._src, b = e._dst;
    if (!a || !b) continue;
    const isEntity = e._entity;
    // Base opacity: concept edges are a soft 0.15 so the web reads as delicate
    // rather than harsh; possible_duplicate_of (dashed/red) gets 0.28 to stay
    // visible; entity overlay stays 0.18; hover/select brightens to 0.85.
    const baseOpacity = isEntity
      ? 0.18
      : (e.type === 'possible_duplicate_of' ? 0.28 : 0.15);
    const opacity = neighbors
      ? (neighbors.has(a.id) && neighbors.has(b.id) ? 0.85 : 0.05)
      : baseOpacity;

    // Compute bezier control point: perpendicular offset at edge midpoint.
    // Curvature is proportional to edge length, capped so short edges stay subtle.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const edgeDx = b.x - a.x, edgeDy = b.y - a.y;
    const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1;
    // Perpendicular unit vector (rotate 90°)
    const perpX = -edgeDy / edgeLen;
    const perpY = edgeDx / edgeLen;
    // Curvature offset: ~8% of edge length, capped at 30px
    const curv = Math.min(edgeLen * 0.08, 30);
    const cpX = mx + perpX * curv;
    const cpY = my + perpY * curv;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = isEntity ? '#aaa' : edgeColor(e.type);
    // Thinner strokes (max 1.5px) so edges read as a web, not thick lines
    const w = e.weight ? Math.max(0.5, Math.min(1.5, e.weight * 0.3)) : 0.8;
    ctx.lineWidth = w;

    if (EDGE_DASHED.has(e.type)) {
      ctx.setLineDash([4, 4]);
    }

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(cpX, cpY, b.x, b.y);
    ctx.stroke();

    // Arrowhead for 'follows' edges — position at curve endpoint
    if (e.type === 'follows') {
      // Tangent at end of quadratic bezier: direction from CP to B
      const tanX = b.x - cpX, tanY = b.y - cpY;
      const angle = Math.atan2(tanY, tanX);
      const ar = b.r || 8;
      // Walk back along tangent to land on node circumference
      const tanLen = Math.sqrt(tanX * tanX + tanY * tanY) || 1;
      const ex = b.x - (tanX / tanLen) * ar;
      const ey = b.y - (tanY / tanLen) * ar;
      ctx.globalAlpha = opacity;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - 10 * Math.cos(angle - 0.45), ey - 10 * Math.sin(angle - 0.45));
      ctx.lineTo(ex - 10 * Math.cos(angle + 0.45), ey - 10 * Math.sin(angle + 0.45));
      ctx.closePath();
      ctx.fillStyle = edgeColor(e.type);
      ctx.fill();
    }

    ctx.setLineDash([]);
    ctx.restore();
  }

  // Draw nodes
  for (const node of allNodes) {
    const isEntity = node._entity;
    const isHovered = node.id === hovered;
    const isSelected = node.id === selected;
    const isDimmed = neighbors && !neighbors.has(node.id);

    ctx.save();
    ctx.globalAlpha = isDimmed ? 0.12 : 1;

    const r = node.r || 8;
    const color = isEntity ? '#888' : kindColor(node.kind);

    // (Organic layout) No ambient per-node glow — crisp small dots, cleaner web.

    // Glow for selected/hovered
    if (isHovered || isSelected) {
      ctx.shadowBlur = 20;
      ctx.shadowColor = color;
    }

    // (Organic layout) Dirty glow removed from graph — surfaced in Health/table instead.

    // Draw main circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = isDimmed ? 0.12 : (isEntity ? 0.5 : 0.9);
    ctx.fill();

    ctx.shadowBlur = 0;

    // Disputed ring
    if (node.status === 'disputed') {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = isDimmed ? 0.08 : 0.9;
      ctx.stroke();
    }

    // (Organic layout) Dirty dashed ring removed from graph — too noisy at 51 nodes.

    // Selected ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
    }

    // Pinned indicator — small anchor dot above the node
    if (node.pinned && !isEntity && !isDimmed) {
      ctx.beginPath();
      ctx.arc(node.x, node.y - r - 5, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#7c6ddb';
      ctx.globalAlpha = 0.85;
      ctx.fill();
    }

    // Label gating — show labels only for:
    //   1. hovered node + its direct neighbors (handled below outside node loop)
    //   2. selected node
    //   3. top-degree hub nodes (hubSet computed in drawFrame, before node loop)
    const isHub = drawFrame._hubSet && drawFrame._hubSet.has(node.id);
    const showLabel = !isEntity && (isSelected || isHub);
    if (showLabel) {
      const label = node.title ? (node.title.length > 28 ? node.title.slice(0, 27) + '…' : node.title) : node.id;
      const labelAlpha = isDimmed ? 0.12 : (isSelected ? 1 : 0.65);
      ctx.globalAlpha = labelAlpha;
      const fontSize = isSelected ? 12 : 11;
      ctx.font = `${isSelected ? 600 : 400} ${fontSize}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      // Dark halo/background for readability over edges
      ctx.shadowBlur = 8;
      ctx.shadowColor = 'rgba(0,0,0,0.95)';
      ctx.fillStyle = '#e2e0f0';
      ctx.fillText(label, node.x, node.y + r + 13);
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  // Hover-neighbor labels — draw on top of everything so they're always readable.
  // Show the hovered node's label prominently + direct-neighbor labels dimly.
  if (hovered) {
    for (const node of allNodes) {
      if (node._entity) continue;
      const isHoveredNode = node.id === hovered;
      const isNeighbor = neighbors && neighbors.has(node.id) && !isHoveredNode;
      if (!isHoveredNode && !isNeighbor) continue;

      const r = node.r || 8;
      const label = node.title ? (node.title.length > 28 ? node.title.slice(0, 27) + '…' : node.title) : node.id;
      ctx.save();
      ctx.font = `${isHoveredNode ? 700 : 400} ${isHoveredNode ? 13 : 11}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.shadowBlur = 10;
      ctx.shadowColor = 'rgba(0,0,0,0.98)';
      ctx.fillStyle = isHoveredNode ? '#ffffff' : '#b0adc8';
      ctx.globalAlpha = isHoveredNode ? 1 : 0.8;
      ctx.fillText(label, node.x, node.y + r + 14);
      ctx.shadowBlur = 0;
      ctx.restore();
    }
  }

  ctx.restore();

  // Update overlay text
  const shown = SIM.nodes.length + SIM.entityNodes.length;
  const shownEdges = SIM.edges.length + SIM.entityEdges.length;
  document.getElementById('graph-overlay').textContent =
    `${shown} nodes / ${shownEdges} edges shown`;
}

// ── Mouse interactions ───────────────────────────────────────────────────────

function worldPos(ex, ey) {
  const W = CVS.width, H = CVS.height;
  return {
    x: (ex - W / 2 - CVS.tx) / CVS.scale + W / 2,
    y: (ey - H / 2 - CVS.ty) / CVS.scale + H / 2,
  };
}

function hitNode(wx, wy) {
  const allNodes = [...SIM.nodes, ...SIM.entityNodes];
  for (const n of allNodes) {
    const dx = n.x - wx, dy = n.y - wy;
    const r = n.r || 8;
    if (dx * dx + dy * dy <= (r + 4) * (r + 4)) return n;
  }
  return null;
}

// Movement threshold in screen pixels to distinguish click from drag
const DRAG_THRESHOLD = 5;

// Build the spring-physics follow set for a drag starting on `leaderNode`.
// BFS over the CURRENTLY-ENABLED edge set (respecting state.edgeTypes toggles),
// undirected, out to FOLLOW_HOP_LIMIT hops.
// Returns { followSet, activeAdj } where:
//   followSet: Map<nodeId, { node, vx, vy }> — followers only (not the leader)
//   activeAdj: Map<nodeId, nodeId[]> — edges within the active set (incl. leader)
//     used by the spring integrator (springs only to other active nodes, never
//     to boundary nodes, so the cluster stays where dragged — no anchor-pull).
// The leader itself is NOT in followSet (it's pinned to cursor each frame).
// Precomputed once per drag start — not rebuilt on every mousemove.
function buildDragFollowSet(leaderNode) {
  // Build undirected adjacency from the currently-drawn edge set.
  // We use SIM.edges (concept edges only — entity edges are never draggable).
  const adj = new Map(); // nodeId → Set<nodeId>
  for (const e of SIM.edges) {
    if (!e._src || !e._dst) continue;
    // Respect the edge-type toggles the user actually sees
    if (!state.edgeTypes[e.type]) continue;
    const sid = e._src.id, did = e._dst.id;
    if (!adj.has(sid)) adj.set(sid, new Set());
    if (!adj.has(did)) adj.set(did, new Set());
    adj.get(sid).add(did);
    adj.get(did).add(sid);
  }

  const followSet = new Map(); // nodeId → { node, vx, vy }
  const visited = new Set([leaderNode.id]);
  let frontier = [leaderNode.id];

  const nodeById = {};
  for (const n of SIM.nodes) nodeById[n.id] = n;

  for (let hop = 1; hop <= FOLLOW_HOP_LIMIT; hop++) {
    const nextFrontier = [];
    for (const id of frontier) {
      const neighbors = adj.get(id);
      if (!neighbors) continue;
      for (const nid of neighbors) {
        if (visited.has(nid)) continue;
        visited.add(nid);
        const n = nodeById[nid];
        if (!n) continue;
        followSet.set(nid, { node: n, vx: 0, vy: 0 });
        nextFrontier.push(nid);
      }
    }
    frontier = nextFrontier;
  }

  // Build adjacency restricted to the active set (leader + followers).
  // Spring forces only flow between active nodes so the cluster can move freely
  // without being anchored back by non-active boundary connections.
  const activeIds = new Set([leaderNode.id, ...followSet.keys()]);
  const activeAdj = new Map(); // nodeId → nodeId[]
  for (const id of activeIds) activeAdj.set(id, []);

  // Capture per-edge rest lengths as ACTUAL current distances between endpoints.
  // This eliminates grab-pop: spring extensions start at zero, so no initial force.
  // Stored in both directions so the integrator can look up from either endpoint.
  const activeRestLens = new Map(); // "srcId:dstId" → distance

  for (const e of SIM.edges) {
    if (!e._src || !e._dst) continue;
    if (!state.edgeTypes[e.type]) continue;
    const sid = e._src.id, did = e._dst.id;
    if (activeIds.has(sid) && activeIds.has(did)) {
      activeAdj.get(sid).push(did);
      activeAdj.get(did).push(sid);
      // Compute actual distance at drag start and store both directions
      const dx = e._dst.x - e._src.x, dy = e._dst.y - e._src.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      activeRestLens.set(sid + ':' + did, dist);
      activeRestLens.set(did + ':' + sid, dist);
    }
  }

  return { followSet, activeAdj, activeRestLens };
}

function onMouseDown(e) {
  const rect = CVS.el.getBoundingClientRect();
  const { x, y } = worldPos(e.clientX - rect.left, e.clientY - rect.top);
  const node = hitNode(x, y);
  if (node) {
    CVS.dragging = true;
    CVS.dragNode = node;
    CVS.dragMoved = false;
    CVS.dragStart = { mx: e.clientX, my: e.clientY, nx: node.x, ny: node.y };
    // Precompute the spring follow set once at drag start (not per-mousemove).
    // Only built for concept nodes (entity nodes are never a drag source for follows).
    if (!node._entity) {
      const built = buildDragFollowSet(node);
      CVS.dragFollowSet = built.followSet;
      CVS.dragActiveAdj = built.activeAdj;
      CVS.dragActiveRestLens = built.activeRestLens;
    } else {
      CVS.dragFollowSet = null;
      CVS.dragActiveAdj = null;
      CVS.dragActiveRestLens = null;
    }
    CVS.dragSettling = false;
    CVS.dragSettleTicks = 0;
    // Don't pin yet — wait for actual movement (click vs drag disambiguation)
  } else {
    CVS.dragging = true;
    CVS.dragNode = null;
    CVS.dragMoved = false;
    CVS.dragFollowSet = null;
    CVS.dragActiveRestLens = null;
    CVS.dragLeaderStart = null;
    CVS.panStart = { mx: e.clientX, my: e.clientY, tx: CVS.tx, ty: CVS.ty };
  }
}

function onMouseMove(e) {
  const rect = CVS.el.getBoundingClientRect();
  const { x, y } = worldPos(e.clientX - rect.left, e.clientY - rect.top);

  if (CVS.dragging && CVS.dragNode) {
    const ds = CVS.dragStart;
    const screenDx = e.clientX - ds.mx;
    const screenDy = e.clientY - ds.my;
    const screenMoved = Math.sqrt(screenDx * screenDx + screenDy * screenDy);

    if (!CVS.dragMoved && screenMoved >= DRAG_THRESHOLD) {
      // First time we cross the threshold — commit to drag mode
      CVS.dragMoved = true;
      CVS.dragNode.pinned = true; // sticky: stays where dropped
      // Do NOT reheat the global sim. With the firm gravity that keeps the layout
      // stable, turning physics back on pulls every node toward the equilibrium and
      // makes them collapse to centre and jitter. The perpetual rAF render loop
      // redraws every frame regardless, so moving just the grabbed node (below)
      // updates the view while the rest of the layout stays exactly put.
    }

    if (CVS.dragMoved) {
      // Pin node directly to cursor — no physics offset, no clamp interference
      CVS.dragNode.x = ds.nx + screenDx / CVS.scale;
      CVS.dragNode.y = ds.ny + screenDy / CVS.scale;
      CVS.dragNode.vx = 0;
      CVS.dragNode.vy = 0;
      scheduleSave();
    }

    // Keep hover/tooltip on the dragged node during drag
    if (CVS.hoveredId !== CVS.dragNode.id) {
      CVS.hoveredId = CVS.dragNode.id;
      if (!CVS.dragNode._entity) showTooltip(e, CVS.dragNode);
    } else if (!CVS.dragNode._entity) {
      moveTooltip(e);
    }
    return;
  }

  if (CVS.dragging && CVS.panStart) {
    const ds = CVS.panStart;
    CVS.tx = ds.tx + (e.clientX - ds.mx);
    CVS.ty = ds.ty + (e.clientY - ds.my);
    scheduleSave();
    return;
  }

  // Hover detection when not dragging
  const node = hitNode(x, y);
  const newHover = node ? node.id : null;
  if (newHover !== CVS.hoveredId) {
    CVS.hoveredId = newHover;
    if (newHover && !node._entity) showTooltip(e, node);
    else hideTooltip();
  } else if (newHover && !node._entity) {
    moveTooltip(e);
  }
}

function onMouseUp(e) {
  if (CVS.dragNode && CVS.dragging) {
    if (!CVS.dragMoved) {
      // Pure click (no movement) — select concept, do NOT pin
      const node = CVS.dragNode;
      node.pinned = false;
      if (!node._entity) { selectConcept(node.id); panToNode(node); }
    } else {
      // Actual drag — sticky drop: keep node pinned where released.
      // Enter damped settle: integrator keeps running after mouseup until kinetic
      // energy drops below threshold (or max ticks). Do NOT snap followers —
      // they coast to rest with real momentum. No global reheat.
      setAlphaTarget(0);
      if (CVS.dragFollowSet) {
        CVS.dragSettling = true;
        CVS.dragSettleTicks = 0;
        // dragFollowSet / dragActiveAdj / dragNode left in place for the integrator.
        // scheduleSave() is called by the integrator when settling completes.
      } else {
        scheduleSave();
      }
    }
  }

  // Clear drag interaction flags but KEEP dragNode/dragFollowSet/dragActiveAdj alive
  // if we're entering settle mode — the tick() integrator needs them.
  CVS.dragging = false;
  CVS.panStart = null;
  CVS.dragStart = null;
  CVS.dragMoved = false;
  if (!CVS.dragSettling) {
    CVS.dragNode = null;
    CVS.dragFollowSet = null;
    CVS.dragActiveAdj = null;
    CVS.dragActiveRestLens = null;
  }
}

function onDblClick(e) {
  const rect = CVS.el.getBoundingClientRect();
  const { x, y } = worldPos(e.clientX - rect.left, e.clientY - rect.top);
  const node = hitNode(x, y);
  if (node && node.pinned) {
    // Unpin — release and give gentle nudge so sim re-absorbs it
    node.pinned = false;
    node.vx = (Math.random() - 0.5) * 2;
    node.vy = (Math.random() - 0.5) * 2;
    reheat(0.12);
    scheduleSave();
  }
}

function onMouseLeave() {
  if (CVS.dragging && CVS.dragNode && CVS.dragMoved) {
    // Left canvas during drag — sticky drop at last position.
    // Enter damped settle (same as onMouseUp release path — no snap).
    setAlphaTarget(0);
    if (CVS.dragFollowSet) {
      CVS.dragSettling = true;
      CVS.dragSettleTicks = 0;
      // dragNode/dragFollowSet/dragActiveAdj left alive for the integrator.
    } else {
      scheduleSave();
    }
  }
  CVS.dragging = false;
  CVS.panStart = null;
  CVS.dragStart = null;
  CVS.dragMoved = false;
  if (!CVS.dragSettling) {
    CVS.dragNode = null;
    CVS.dragFollowSet = null;
    CVS.dragActiveAdj = null;
    CVS.dragActiveRestLens = null;
  }
  hideTooltip();
  CVS.hoveredId = null;
}

function onWheel(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  const rect = CVS.el.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const W = CVS.width, H = CVS.height;
  // Zoom toward cursor
  const wx = (mx - W / 2 - CVS.tx) / CVS.scale;
  const wy = (my - H / 2 - CVS.ty) / CVS.scale;
  CVS.scale = Math.max(0.1, Math.min(6, CVS.scale * factor));
  CVS.tx = mx - W / 2 - wx * CVS.scale;
  CVS.ty = my - H / 2 - wy * CVS.scale;
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

function showTooltip(e, node) {
  const tt = document.getElementById('tooltip');
  document.getElementById('tt-title').textContent = node.title || node.id;
  document.getElementById('tt-kind').innerHTML =
    `<span style="color:${kindColor(node.kind)}">${escHtml(node.kind)}</span>` +
    (node.circle ? ` · <span style="color:var(--text-muted)">${escHtml(canonicalCircle(node.circle))}</span>` : '');
  const parts = [];
  if (node.confidence !== null && node.confidence !== undefined) parts.push(`conf ${(node.confidence * 100).toFixed(0)}%`);
  if (node.support_count) parts.push(`support ${node.support_count}`);
  if (node.status === 'disputed') parts.push('⚠ disputed');
  if (node.dirty) parts.push('dirty');
  document.getElementById('tt-meta').textContent = parts.join(' · ');
  const conf = node.confidence !== null && node.confidence !== undefined ? node.confidence : null;
  document.getElementById('tt-conf-fill').style.width = conf !== null ? `${(conf * 100).toFixed(0)}%` : '0%';
  tt.style.display = 'block';
  moveTooltip(e);
}

function moveTooltip(e) {
  const tt = document.getElementById('tooltip');
  const x = e.clientX + 14, y = e.clientY - 10;
  const W = window.innerWidth, H = window.innerHeight;
  tt.style.left = Math.min(x, W - 290) + 'px';
  tt.style.top = Math.min(y, H - 140) + 'px';
}

function hideTooltip() {
  document.getElementById('tooltip').style.display = 'none';
}

// ── Graph build ──────────────────────────────────────────────────────────────

const nodePositions = {}; // persist positions across re-builds
// Track which circle the in-memory positions were captured under.  When
// switching to a different circle the stale unscoped positions must not
// shadow the per-circle localStorage data (cross-circle layout contamination).
let _nodePositionsCircle = null;

// scatter=true forces all nodes to be re-seeded around canvas centre rather
// than reusing saved positions.  Use on circle changes so nodes from a prior
// dense layout don't start so close together that charge forces explode.
function buildGraph(scatter = false) {
  const concepts = getFilteredConcepts();
  const nodeIds = new Set(concepts.map(c => c.id));
  const edges = getFilteredEdges([...nodeIds]);
  const degMap = degreeCounts();

  // Load per-circle saved positions and pins from localStorage
  const { posMap: lsPosMap, pinMap: lsPinMap, camera: lsCamera } = restoreForCircle(state.circle);

  // Determine if we have a "complete enough" saved layout to freeze-restore.
  // A saved layout qualifies if at least 70% of current nodes have saved positions.
  // When scatter=true we never freeze (fresh sim requested).
  // In-memory positions are only valid when they were captured under the same circle.
  const inMemValid = _nodePositionsCircle === state.circle;
  let frozenRestore = false;
  if (!scatter && lsPosMap) {
    const savedCount = concepts.filter(c =>
      (inMemValid && nodePositions[c.id]) || lsPosMap[c.id]
    ).length;
    frozenRestore = concepts.length > 0 && (savedCount / concepts.length) >= 0.70;
  }

  // Compute centroid of saved positions (for placing new/unsaved nodes nearby)
  let savedCX = CVS.width / 2 || 625;
  let savedCY = CVS.height / 2 || 400;
  if (frozenRestore) {
    let sumX = 0, sumY = 0, cnt = 0;
    for (const c of concepts) {
      const inMem = inMemValid ? nodePositions[c.id] : null;
      let px, py;
      if (inMem) { px = inMem.x; py = inMem.y; }
      else if (lsPosMap && lsPosMap[c.id]) { [px, py] = lsPosMap[c.id]; }
      if (px !== undefined && py !== undefined) { sumX += px; sumY += py; cnt++; }
    }
    if (cnt > 0) { savedCX = sumX / cnt; savedCY = sumY / cnt; }
  }

  // Build node objects
  const nodes = concepts.map(c => {
    const deg = degMap[c.id] || 0;
    // Small dots sized by DEGREE (connectivity) — hubs read bigger, leaves are tiny.
    const r = 1.1 + Math.min(4.5, Math.sqrt(deg) * 0.72);
    // Priority: (1) in-memory nodePositions (current session), (2) localStorage (across sessions)
    // When scattering, ignore all saved positions.
    // inMemValid (computed above) gates in-memory positions to the same circle —
    // prevents cross-circle contamination where outgoing coordinates overwrite the
    // incoming circle's saved layout.
    let savedX, savedY, savedPinned = false, hasSavedPos = false;
    if (!scatter) {
      const inMem = inMemValid ? nodePositions[c.id] : null;
      if (inMem) {
        savedX = inMem.x;
        savedY = inMem.y;
        savedPinned = inMem.pinned || false;
        hasSavedPos = true;
      } else if (lsPosMap && lsPosMap[c.id]) {
        const [px, py] = lsPosMap[c.id];
        savedX = px;
        savedY = py;
        savedPinned = lsPinMap ? (lsPinMap[c.id] || false) : false;
        hasSavedPos = true;
      }
    }

    // For frozen restore: new nodes (no saved pos) get placed near saved centroid
    // so they settle locally without displacing the frozen graph.
    if (frozenRestore && !hasSavedPos) {
      savedX = savedCX + (Math.random() - 0.5) * 120;
      savedY = savedCY + (Math.random() - 0.5) * 120;
    }

    const node = {
      id: c.id,
      title: c.title,
      kind: c.kind,
      status: c.status,
      confidence: c.confidence,
      circle: c.circle,
      dirty: c.dirty,
      support_count: c.support_count,
      r,
      x: savedX,
      y: savedY,
      vx: 0, vy: 0,
      // In frozen restore: pin saved nodes so they stay put during new-node settle.
      // New nodes are NOT pinned so they can find their position.
      pinned: frozenRestore ? (hasSavedPos ? true : false) : savedPinned,
      _savedPos: hasSavedPos,        // marker for initSim frozen-restore logic
      _savedPinned: savedPinned,     // original pinned state to restore after settle
      _entity: false,
    };
    return node;
  });

  const nodeById = {};
  for (const n of nodes) nodeById[n.id] = n;

  // Build edge objects
  const edgeObjs = edges.map(e => ({
    ...e,
    _src: nodeById[e.src_id],
    _dst: nodeById[e.dst_id],
    _entity: false,
  })).filter(e => e._src && e._dst);

  // Entity overlay
  let entityNodes = [], entityEdges = [];
  if (state.entityOverlay && ENTITIES) {
    const { entities, links } = ENTITIES;
    // Only top entities for the current circle
    const circleLinks = state.circle === 'all'
      ? links
      : links.filter(l => nodeIds.has(l.concept_id));

    // Count links per entity, keyed by (scope, entity_key) so two circles
    // sharing the same entity_key produce separate overlay nodes.
    const entLinkCnt = {};
    for (const l of circleLinks) {
      if (nodeIds.has(l.concept_id)) {
        const ck = l.scope + '\x00' + l.entity_key;
        entLinkCnt[ck] = (entLinkCnt[ck] || 0) + 1;
      }
    }
    // Top 40 by link count (composite keys, sorted descending)
    const topEntKeys = Object.entries(entLinkCnt)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([k]) => k);
    const topEntSet = new Set(topEntKeys);

    const entMap = {};
    for (const e of entities) {
      const ck = e.scope + '\x00' + e.key;
      if (topEntSet.has(ck)) {
        const n = {
          id: 'ent:' + e.scope + '\x00' + e.key,
          title: e.surface,
          kind: e.kind,
          r: 5,
          x: undefined, y: undefined,
          vx: 0, vy: 0,
          pinned: false,
          _entity: true,
        };
        entityNodes.push(n);
        entMap[ck] = n;
      }
    }
    for (const l of circleLinks) {
      const ck = l.scope + '\x00' + l.entity_key;
      if (nodeIds.has(l.concept_id) && topEntSet.has(ck)) {
        const src = nodeById[l.concept_id];
        const dst = entMap[ck];
        if (src && dst) {
          entityEdges.push({
            id: `ent-${l.concept_id}-${l.scope}-${l.entity_key}`,
            _src: src,
            _dst: dst,
            type: 'entity',
            weight: 1,
            _entity: true,
          });
        }
      }
    }
  }

  // Apply the saved camera immediately for frozen restore (before simulation starts).
  // This ensures the camera frames the saved layout from frame 1, not after settle.
  // Sanity-check: verify that the saved camera actually puts the node cloud on-screen.
  // If not (stale camera written before fix, or layout shifted), fall through to
  // fitToView instead of restoring an off-screen camera.
  // initSim(frozenRestore=true) sets settledOnce=true, so the tick settle path never
  // runs here — fitToView on the reject path is the ONLY fit that can fire.
  // NOTE: placed AFTER entityNodes is built so the visibility set is complete.
  if (frozenRestore && lsCamera && Number.isFinite(lsCamera.scale) && lsCamera.scale > 0) {
    const W = CVS.width || 1019, H = CVS.height || 582;
    const { scale: cs, tx: ctx_, ty: cty } = lsCamera;
    // Build the visible set the same way every other fitToView call does:
    // concepts + entity nodes when the overlay is active.
    const visibleNodes = state.entityOverlay
      ? [...nodes, ...entityNodes]
      : nodes;
    // Count how many nodes project inside the viewport under the saved camera.
    // Using a fraction-of-nodes-on-screen metric rather than bbox area:
    //   • immune to single-node / collinear circles (no zero-area trap)
    //   • a node that IS in-viewport is correctly counted even when siblings are not
    let onScreen = 0;
    for (const n of visibleNodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      const sx = (n.x - W / 2) * cs + ctx_ + W / 2;
      const sy = (n.y - H / 2) * cs + cty + H / 2;
      if (sx >= 0 && sx <= W && sy >= 0 && sy <= H) onScreen++;
    }
    const total = visibleNodes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y)).length;
    // Accept the saved camera if at least 50% of visible nodes are on-screen.
    // Fall back to fitToView (same visible set) when the saved camera is stale.
    if (total === 0 || onScreen / total >= 0.5) {
      CVS.scale = cs;
      CVS.tx = ctx_;
      CVS.ty = cty;
    } else {
      fitToView(visibleNodes);
    }
  }

  initSim(nodes, edgeObjs, entityNodes, entityEdges, frozenRestore);
  // Stamp AFTER SIM.nodes are built for this circle. This ensures
  // _nodePositionsCircle always equals the circle that owns the current
  // SIM.nodes. redrawGraph snapshots those nodes into nodePositions, so the
  // snapshot's origin circle == _nodePositionsCircle. On a circle switch,
  // buildGraph reads inMemValid = (_nodePositionsCircle[=OLD] === state.circle[=NEW])
  // = false → falls through to per-circle lsPosMap (correct). On a same-circle
  // redraw (filter toggle), inMemValid = (X === X) = true → reuses in-memory
  // positions (0px drift preserved).
  _nodePositionsCircle = state.circle;
}

function redrawGraph(resetCamera = false) {
  // Save positions from current nodes (only finite, sane positions are useful).
  for (const n of SIM.nodes) {
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
      nodePositions[n.id] = { x: n.x, y: n.y, pinned: n.pinned || false };
    }
  }
  if (resetCamera) {
    resetView();
    // Clear only the camera for the incoming circle so fitToView re-centers after settle.
    // Leave saved positions intact — if this circle was visited before, nodes will be
    // re-seeded from scratch (scatter=true), then fit; the saved positions are for
    // returning to the SAME circle later.
    try {
      const stored = lsGet();
      delete stored['cam_' + state.circle];
      lsSet(stored);
    } catch (_) {}
  }
  // On a circle change (resetCamera=true) scatter all nodes fresh so they
  // don't inherit a dense cluster from the prior layout — close proximity
  // causes charge-force explosions in the first few sim ticks.
  buildGraph(/* scatter= */ resetCamera);
}

// ── Concept selection / detail panel ────────────────────────────────────────

function selectConcept(id) {
  state.selectedId = id;
  CVS.selectedId = id;
  renderDetailPanel(id);
  // In concepts tab, highlight row
  document.querySelectorAll('#concepts-tbody tr').forEach(r => {
    r.classList.toggle('selected', r.dataset.id === id);
  });
}

function deselectConcept() {
  state.selectedId = null;
  CVS.selectedId = null;
  document.getElementById('detail').classList.remove('open');
  animateCanvasResize(); // grow the canvas as the panel slides closed
  document.querySelectorAll('#concepts-tbody tr').forEach(r => r.classList.remove('selected'));
}

async function renderDetailPanel(id) {
  const maps = buildConceptMaps(DATA.concepts);
  const concept = maps.byId[id];
  if (!concept) return;

  document.getElementById('detail').classList.add('open');
  animateCanvasResize(); // shrink the canvas as the panel slides open
  document.getElementById('detail-title').textContent = concept.title;

  const scroll = document.getElementById('detail-scroll');
  scroll.scrollTop = 0;

  // ── Build ALL markup first, set innerHTML once, then attach ALL handlers. ──
  // Rationale: `innerHTML +=` re-parses the subtree and drops event listeners
  // that were attached to elements in the previous parse (including wikilink
  // click handlers).  One assignment avoids the reparsing cycle entirely.

  // Meta grid
  const conf = concept.confidence !== null && concept.confidence !== undefined
    ? `<div class="conf-bar-wrap"><div class="conf-bar"><div class="conf-fill" style="width:${(concept.confidence * 100).toFixed(0)}%"></div></div><span class="conf-val">${(concept.confidence * 100).toFixed(0)}%</span></div>`
    : '<span style="color:var(--text-muted)">—</span>';

  const statusBadges = [
    `<span class="kind-badge" style="color:${kindColor(concept.kind)};border:1px solid ${kindColor(concept.kind)}40;background:${kindColor(concept.kind)}12">${escHtml(concept.kind)}</span>`,
    concept.status === 'disputed' ? `<span class="badge-disputed">disputed</span>` : '',
    concept.dirty ? `<span class="badge-dirty">dirty</span>` : '',
  ].filter(Boolean).join(' ');

  const revInfo = DATA.revisionsCount.find(r => r.concept_id === id);

  let html = `
    <div style="margin-bottom:14px">${statusBadges}</div>
    <div class="detail-meta-grid">
      <div class="detail-meta-item">
        <div class="detail-meta-lbl">Circle</div>
        <div class="detail-meta-val">${escHtml(canonicalCircle(concept.circle))}</div>
      </div>
      <div class="detail-meta-item">
        <div class="detail-meta-lbl">Confidence</div>
        <div class="detail-meta-val">${conf}</div>
      </div>
      <div class="detail-meta-item">
        <div class="detail-meta-lbl">Support</div>
        <div class="detail-meta-val">${concept.support_count || 0}</div>
      </div>
      <div class="detail-meta-item">
        <div class="detail-meta-lbl">Usefulness</div>
        <div class="detail-meta-val">${concept.usefulness_score || '—'}</div>
      </div>
      <div class="detail-meta-item">
        <div class="detail-meta-lbl">Version</div>
        <div class="detail-meta-val">v${concept.version || 1}${revInfo ? ` (${revInfo.n} revisions)` : ''}</div>
      </div>
      <div class="detail-meta-item">
        <div class="detail-meta-lbl">Updated</div>
        <div class="detail-meta-val" style="font-size:11px">${fmtRelTime(concept.updated_at)}</div>
      </div>
      <div class="detail-meta-item">
        <div class="detail-meta-lbl">Created</div>
        <div class="detail-meta-val" style="font-size:11px">${fmtDate(concept.created_at)}</div>
      </div>
      <div class="detail-meta-item">
        <div class="detail-meta-lbl">Last confirmed</div>
        <div class="detail-meta-val" style="font-size:11px">${concept.last_confirmed_at ? fmtRelTime(concept.last_confirmed_at) : '—'}</div>
      </div>
    </div>
  `;

  // Body (intentional markdown render — renderMd is trusted output)
  if (concept.body) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">Body</div>
        <div class="body-render">${renderMd(concept.body, maps.wikiMap)}</div>
      </div>
    `;
  }

  // Observations
  const obs = DATA.observations.filter(o => o.concept_id === id);
  if (obs.length) {
    const collId = 'obs-' + id;
    html += `
      <div class="detail-section">
        <div class="collapsible-hdr open" data-target="${collId}">
          <span class="arr">▶</span>
          <span class="detail-section-title" style="margin:0">Evidence <span class="ds-cnt">${obs.length}</span></span>
        </div>
        <div class="collapsible-body open" id="${collId}">
          ${obs.slice(0, 20).map(o => `
            <div class="obs-item">
              <div class="obs-content">${escHtml(o.content)}</div>
              <div class="obs-meta">${escHtml(o.author_agent_id || '?')} · ${fmtRelTime(o.created_at)}${o.source_refs ? ' · ' + escHtml(o.source_refs) : ''}</div>
            </div>
          `).join('')}
          ${obs.length > 20 ? `<div style="padding:4px 10px;font-size:11px;color:var(--text-muted)">…and ${obs.length - 20} more</div>` : ''}
        </div>
      </div>
    `;
  }

  // Connected concepts by type
  const connEdges = DATA.edges.filter(e => e.src_id === id || e.dst_id === id);
  if (connEdges.length) {
    const byType = {};
    for (const e of connEdges) {
      if (!byType[e.type]) byType[e.type] = [];
      const otherId = e.src_id === id ? e.dst_id : e.src_id;
      const other = maps.byId[otherId];
      if (other) byType[e.type].push({ concept: other, weight: e.weight, dir: e.src_id === id ? 'out' : 'in' });
    }
    let connHtml = '<div class="detail-section"><div class="detail-section-title">Connections</div>';
    for (const [type, items] of Object.entries(byType)) {
      connHtml += `<div class="conn-group">
        <div class="conn-group-title">
          <span class="edge-swatch" style="width:14px;height:3px;background:${edgeColor(type)};border-radius:2px;display:inline-block;margin-right:2px"></span>
          ${escHtml(type.replace(/_/g, ' '))} (${items.length})
        </div>
        ${items.slice(0, 15).map(item => `
          <div class="conn-link" data-id="${escHtml(item.concept.id)}">
            <span class="dot kind-dot-inline" style="background:${kindColor(item.concept.kind)}"></span>
            <span>${escHtml(item.concept.title)}</span>
            ${item.weight ? `<span class="wt">${item.weight.toFixed ? item.weight.toFixed(2) : item.weight}</span>` : ''}
          </div>
        `).join('')}
        ${items.length > 15 ? `<div style="padding:2px 8px;font-size:10.5px;color:var(--text-muted)">…and ${items.length - 15} more</div>` : ''}
      </div>`;
    }
    connHtml += '</div>';
    html += connHtml;
  }

  // Entities placeholder — inserted here so the section lands between Connections
  // and Contradictions after the single innerHTML assignment.  The actual content
  // is populated by appendEntitySection() / lazy-load logic below, which targets
  // this element by id.
  const entPlaceholderId = 'ent-placeholder-' + id;
  html += `<div id="${entPlaceholderId}"></div>`;

  // Contradictions
  const contras = DATA.contradictions.filter(ct => ct.concept_id === id);
  if (contras.length) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">Contradictions <span class="ds-cnt">${contras.length}</span></div>
        ${contras.map(ct => `
          <div class="contra-item">
            <span class="contra-status ${escHtml(ct.status)}">${escHtml(ct.status)}</span>
            <div class="contra-detail">${escHtml(ct.detail || ct.kind)}</div>
            ${ct.resolved_at ? `<div style="font-size:10.5px;color:var(--text-muted);margin-top:3px">Resolved ${fmtRelTime(ct.resolved_at)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // Source refs
  if (concept.source_refs) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">Source refs</div>
        <div style="font-size:11.5px;color:var(--text-dim);word-break:break-all">${escHtml(concept.source_refs)}</div>
      </div>
    `;
  }

  // Aliases
  if (concept.aliases) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">Aliases</div>
        <div style="font-size:11.5px;color:var(--text-dim)">${escHtml(concept.aliases)}</div>
      </div>
    `;
  }

  // ── Single innerHTML assignment: all markup is now in the DOM ──
  scroll.innerHTML = html;

  // ── Attach all handlers now that the DOM is stable ──

  // Wikilink click handler (body section)
  scroll.querySelectorAll('.wikilink').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      selectConcept(a.dataset.id);
    });
  });

  // Connected-concept click handlers
  scroll.querySelectorAll('.conn-link[data-id]').forEach(el => {
    el.addEventListener('click', () => selectConcept(el.dataset.id));
  });

  // Collapsible section handlers
  scroll.querySelectorAll('.collapsible-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const target = document.getElementById(hdr.dataset.target);
      if (!target) return;
      hdr.classList.toggle('open');
      target.classList.toggle('open');
    });
  });

  // Entities section — populate the placeholder element that was baked into html
  // at the correct position (between Connections and Contradictions).  Targeting
  // by id avoids any DOM append after innerHTML, preserving section order.
  const entPlaceholder = document.getElementById(entPlaceholderId);
  if (ENTITIES) {
    appendEntitySection(scroll, id, entPlaceholder);
  } else {
    // Show a lazy-load shell inside the placeholder until entities are fetched.
    const lazyShell = document.createElement('div');
    lazyShell.className = 'detail-section';
    lazyShell.id = 'ent-section-' + id;
    lazyShell.innerHTML = `
      <div class="detail-section-title">Entities
        <button id="load-ent-btn" style="margin-left:8px;font-size:10.5px;padding:2px 7px;border-radius:4px;border:1px solid var(--glass-border);background:var(--glass);color:var(--text-dim);cursor:pointer">Load</button>
      </div>
    `;
    if (entPlaceholder) entPlaceholder.replaceWith(lazyShell);
    lazyShell.querySelector('#load-ent-btn').addEventListener('click', async () => {
      await fetchEntities();
      if (state.activeTab === 'entities') renderEntitiesTable();
      // Guard against a stale continuation: if the user selected a different
      // concept while the fetch was in flight, the panel has already been
      // replaced (innerHTML) and lazyShell is no longer in the DOM.  Abort
      // rather than appending this concept's entities into the new panel.
      if (state.selectedId !== id || !lazyShell.isConnected) return;
      appendEntitySection(scroll, id, lazyShell);
    });
  }
}

function appendEntitySection(scroll, conceptId, placeholder) {
  if (!ENTITIES) return;
  const { entities, links } = ENTITIES;
  // Gather (scope, entity_key) pairs for this concept so each scope's entity
  // is treated independently — prevents another scope's surface/kind winning.
  const conceptLinks = links.filter(l => l.concept_id === conceptId);
  if (!conceptLinks.length) {
    // No entities for this concept — remove the placeholder stub from the DOM.
    if (placeholder && placeholder.parentNode) placeholder.remove();
    return;
  }
  // Build a map keyed by composite (scope + NUL + entity_key)
  const entMap = {};
  for (const e of entities) entMap[e.scope + '\x00' + e.key] = e;
  const myEnts = conceptLinks
    .map(l => entMap[l.scope + '\x00' + l.entity_key])
    .filter(Boolean)
    // Deduplicate: a concept may link to the same (scope, key) pair more than once
    .filter((e, i, arr) => arr.findIndex(x => x.scope === e.scope && x.key === e.key) === i);

  // Group by kind
  const byKind = {};
  for (const e of myEnts) {
    if (!byKind[e.kind]) byKind[e.kind] = [];
    byKind[e.kind].push(e);
  }

  const section = document.createElement('div');
  section.className = 'detail-section';
  section.innerHTML = `
    <div class="detail-section-title">Entities <span class="ds-cnt">${myEnts.length}</span></div>
    ${Object.entries(byKind).map(([kind, items]) => `
      <div style="margin-bottom:8px">
        <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:4px">${escHtml(kind)}</div>
        <div class="entity-chips">
          ${items.map(e => `<span class="entity-chip ek-${escHtml(e.kind)}">${escHtml(e.surface)}</span>`).join('')}
        </div>
      </div>
    `).join('')}
  `;

  if (placeholder) placeholder.replaceWith(section);
  else scroll.appendChild(section);
}

// ── Concepts table view ──────────────────────────────────────────────────────

function renderConceptsTable() {
  const concepts = getFilteredConcepts();
  const degMap = degreeCounts();
  const { col, dir } = state.conceptSort;

  const sorted = [...concepts].sort((a, b) => {
    let av = col === 'degree' ? (degMap[a.id] || 0) : a[col];
    let bv = col === 'degree' ? (degMap[b.id] || 0) : b[col];
    if (av === null || av === undefined) av = col === 'updated_at' ? 0 : '';
    if (bv === null || bv === undefined) bv = col === 'updated_at' ? 0 : '';
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });

  const tbody = document.getElementById('concepts-tbody');
  tbody.innerHTML = '';

  for (const c of sorted) {
    const tr = document.createElement('tr');
    tr.dataset.id = c.id;
    if (c.id === state.selectedId) tr.classList.add('selected');
    const conf = c.confidence !== null && c.confidence !== undefined;
    tr.innerHTML = `
      <td class="td-title"><div class="td-title-inner" title="${escHtml(c.title)}">${escHtml(c.title)}</div></td>
      <td><span class="kind-badge" style="color:${kindColor(c.kind)}"><span class="dot kind-dot-inline" style="background:${kindColor(c.kind)}"></span>${escHtml(c.kind)}</span></td>
      <td style="color:var(--text-dim);font-size:11px">${escHtml(canonicalCircle(c.circle))}</td>
      <td>
        ${conf ? `<div class="conf-bar-wrap"><div class="conf-bar"><div class="conf-fill" style="width:${(c.confidence * 100).toFixed(0)}%"></div></div><span class="conf-val">${(c.confidence * 100).toFixed(0)}%</span></div>` : '<span style="color:var(--text-muted)">—</span>'}
      </td>
      <td style="color:var(--text-dim)">${c.support_count || 0}</td>
      <td style="color:var(--text-dim)">${degMap[c.id] || 0}</td>
      <td style="color:var(--text-muted);font-size:11px">${fmtRelTime(c.updated_at)}</td>
    `;
    tr.addEventListener('click', () => selectConcept(c.id));
    tbody.appendChild(tr);
  }

  // Update sort arrows
  document.querySelectorAll('#concepts-table thead th').forEach(th => {
    const isSorted = th.dataset.col === col;
    th.classList.toggle('sorted', isSorted);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = isSorted ? (dir > 0 ? '↑' : '↓') : '↕';
  });
}

// ── Entities view ────────────────────────────────────────────────────────────

async function renderEntitiesTable() {
  await fetchEntities();
  const { entities, links } = ENTITIES;

  // Count concepts per entity, keyed by (entity_key + scope) so a key present
  // in two circles doesn't inflate either circle's count.
  const entConcepts = {};
  for (const l of links) {
    const k = l.entity_key + '\x00' + l.scope;
    entConcepts[k] = (entConcepts[k] || 0) + 1;
  }

  // Filter by circle
  let rows = entities.map(e => ({ ...e, conceptCount: entConcepts[e.key + '\x00' + e.scope] || 0 }));
  if (state.circle !== 'all') {
    rows = rows.filter(e => {
      const canon = canonicalCircle(e.scope);
      return canon === state.circle || e.scope === state.circle;
    });
  }
  if (state.search) {
    const s = state.search.toLowerCase();
    rows = rows.filter(e => e.surface.toLowerCase().includes(s));
  }

  const { col, dir } = state.entitySort;
  rows.sort((a, b) => {
    let av = a[col], bv = b[col];
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });

  const tbody = document.getElementById('entities-tbody');
  tbody.innerHTML = '';

  for (const e of rows.slice(0, 500)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="ek-${escHtml(e.kind)}" style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(e.surface)}">${escHtml(e.surface)}</td>
      <td><span class="kind-badge">${escHtml(e.kind)}</span></td>
      <td style="color:var(--text-dim);font-size:11px">${escHtml(canonicalCircle(e.scope))}</td>
      <td style="color:var(--text-dim)">${e.df}</td>
      <td style="color:var(--text-dim)">${e.conceptCount}</td>
    `;
    tbody.appendChild(tr);
  }

  // Sort headers
  document.querySelectorAll('#entities-table thead th').forEach(th => {
    const isSorted = th.dataset.col === col;
    th.classList.toggle('sorted', isSorted);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = isSorted ? (dir > 0 ? '↑' : '↓') : '↕';
  });
}

// ── Timeline view ────────────────────────────────────────────────────────────

function renderTimeline() {
  const concepts = getFilteredConcepts();
  const sorted = [...concepts].filter(c => c.created_at).sort((a, b) => a.created_at - b.created_at);
  if (!sorted.length) {
    const canvas = document.getElementById('timeline-canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    const list = document.getElementById('timeline-list');
    if (list) {
      list.innerHTML = '<div style="padding:24px 16px;color:var(--text-muted);font-size:13px">No concepts with dates match the current filter.</div>';
    }
    return;
  }

  // Draw bar chart on canvas
  const canvas = document.getElementById('timeline-canvas');
  const W = canvas.offsetWidth || 800;
  canvas.width = W * devicePixelRatio;
  canvas.height = 180 * devicePixelRatio;
  canvas.style.width = W + 'px';
  canvas.style.height = '180px';
  const ctx = canvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);

  // Bucket by day (range is ~10 days for this store, so month/year labels all collapse)
  const minT = sorted[0].created_at;
  const maxT = sorted[sorted.length - 1].created_at;
  const range = maxT - minT || 1;
  const DAY_MS = 24 * 3600 * 1000;
  // Choose granularity: if range < 60 days use per-day buckets, else fall back to weeks
  const bucketCount = range < 60 * DAY_MS
    ? Math.min(60, Math.max(8, Math.ceil(range / DAY_MS)))
    : Math.min(48, Math.max(8, Math.ceil(range / (7 * DAY_MS))));
  const bucketSize = range / bucketCount;
  const buckets = new Array(bucketCount).fill(null).map(() => ({ total: 0, kinds: {} }));

  for (const c of sorted) {
    const idx = Math.min(bucketCount - 1, Math.floor((c.created_at - minT) / bucketSize));
    buckets[idx].total++;
    if (!buckets[idx].kinds[c.kind]) buckets[idx].kinds[c.kind] = 0;
    buckets[idx].kinds[c.kind]++;
  }

  const maxBucket = Math.max(...buckets.map(b => b.total), 1);
  const padL = 40, padR = 16, padT = 16, padB = 36;
  const cW = W - padL - padR, cH = 180 - padT - padB;
  const bW = Math.max(2, cW / bucketCount - 2);

  ctx.fillStyle = 'rgba(255,255,255,0.02)';
  ctx.fillRect(0, 0, W, 180);

  // Y-axis lines
  for (let i = 0; i <= 4; i++) {
    const y = padT + cH - (i / 4) * cH;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + cW, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = `10px -apple-system, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(Math.round((i / 4) * maxBucket), padL - 4, y + 3);
  }

  // Bars (stacked by kind)
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const x = padL + i * (cW / bucketCount);
    let yOff = 0;
    for (const [kind, cnt] of Object.entries(b.kinds)) {
      const bH = (cnt / maxBucket) * cH;
      ctx.fillStyle = kindColor(kind) + 'cc';
      ctx.beginPath();
      ctx.roundRect(x + 1, padT + cH - yOff - bH, bW, bH, [2, 2, 0, 0]);
      ctx.fill();
      yOff += bH;
    }
    // X-axis label every ~8 buckets
    if (i % Math.max(1, Math.floor(bucketCount / 8)) === 0) {
      const t = new Date(minT + i * bucketSize);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      // Use day-level format when range is short; fall back to month+year for long ranges
      const labelFmt = range < 60 * DAY_MS
        ? t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : t.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      ctx.fillText(labelFmt, x + bW / 2, padT + cH + 18);
    }
  }

  // Render list below
  const list = document.getElementById('timeline-list');
  list.innerHTML = '';
  for (const c of [...sorted].reverse().slice(0, 80)) {
    const div = document.createElement('div');
    div.className = 'tl-item';
    div.innerHTML = `
      <div class="tl-date">${fmtDate(c.created_at)}</div>
      <div>
        <div class="tl-title">${escHtml(c.title)}</div>
        <div class="tl-meta">
          <span class="kind-dot-inline dot" style="background:${kindColor(c.kind)}"></span>
          ${escHtml(c.kind)} · ${escHtml(canonicalCircle(c.circle))}
        </div>
      </div>
    `;
    div.addEventListener('click', () => {
      selectConcept(c.id);
      switchTab('graph');
    });
    list.appendChild(div);
  }
}

// ── Health view ──────────────────────────────────────────────────────────────

function renderHealth() {
  const el = document.getElementById('health-view');
  el.innerHTML = '';
  const maps = buildConceptMaps(DATA.concepts);

  // Open contradictions
  const openContras = DATA.contradictions.filter(c => c.status === 'open');
  {
    const sec = document.createElement('div');
    sec.className = 'health-section';
    sec.innerHTML = `
      <div class="health-section-hdr">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="8"/><circle cx="8" cy="11" r="0.8" fill="currentColor"/></svg>
        Open contradictions
        <span class="health-cnt ${openContras.length > 0 ? 'danger' : 'ok'}">${openContras.length}</span>
      </div>
      <div class="health-items">
        ${openContras.length === 0 ? '<div style="padding:14px 16px;color:var(--text-muted);font-size:12px">All clear</div>' :
          openContras.map(ct => {
            const concept = maps.byId[ct.concept_id];
            return `
              <div class="health-item" data-id="${escHtml(ct.concept_id)}">
                <div class="h-icon">
                  <span style="color:var(--danger)">⚠</span>
                </div>
                <div>
                  <div class="h-title">${escHtml(concept ? concept.title : ct.concept_id)}</div>
                  <div class="h-meta">${escHtml(ct.detail || ct.kind)}</div>
                  <div class="h-meta" style="margin-top:2px">Detected ${fmtRelTime(ct.detected_at)}</div>
                </div>
              </div>
            `;
          }).join('')}
      </div>
    `;
    el.appendChild(sec);
  }

  // Possible duplicates
  const dupEdges = DATA.edges.filter(e => e.type === 'possible_duplicate_of');
  {
    const sec = document.createElement('div');
    sec.className = 'health-section';
    sec.innerHTML = `
      <div class="health-section-hdr">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="1" width="9" height="9" rx="2"/><rect x="6" y="6" width="9" height="9" rx="2"/></svg>
        Possible duplicate pairs
        <span class="health-cnt ${dupEdges.length > 0 ? 'warn' : 'ok'}">${dupEdges.length}</span>
      </div>
      <div class="health-items">
        ${dupEdges.length === 0 ? '<div style="padding:14px 16px;color:var(--text-muted);font-size:12px">None detected</div>' :
          dupEdges.map(e => {
            const src = maps.byId[e.src_id];
            const dst = maps.byId[e.dst_id];
            return `
              <div class="dup-pair" data-src="${escHtml(e.src_id)}" data-dst="${escHtml(e.dst_id)}">
                <div>
                  <div class="dp-title">
                    <span class="dot kind-dot-inline" style="background:${kindColor(src ? src.kind : 'unknown')}"></span>
                    ${escHtml(src ? src.title : e.src_id)}
                  </div>
                  <div style="font-size:10.5px;color:var(--text-muted);margin-top:1px">${src ? escHtml(canonicalCircle(src.circle)) : ''}</div>
                </div>
                <div class="dp-sep">≈</div>
                <div>
                  <div class="dp-title">
                    <span class="dot kind-dot-inline" style="background:${kindColor(dst ? dst.kind : 'unknown')}"></span>
                    ${escHtml(dst ? dst.title : e.dst_id)}
                  </div>
                  <div style="font-size:10.5px;color:var(--text-muted);margin-top:1px">${dst ? escHtml(canonicalCircle(dst.circle)) : ''}</div>
                </div>
                ${e.weight ? `<div style="margin-left:auto;font-size:10.5px;color:var(--text-muted)">${e.weight.toFixed ? e.weight.toFixed(2) : e.weight}</div>` : ''}
              </div>
            `;
          }).join('')}
      </div>
    `;
    el.appendChild(sec);

    sec.querySelectorAll('.dup-pair').forEach(row => {
      row.addEventListener('click', () => selectConcept(row.dataset.src));
    });
  }

  // Disputed concepts
  const disputed = DATA.concepts.filter(c => c.status === 'disputed');
  {
    const sec = document.createElement('div');
    sec.className = 'health-section';
    sec.innerHTML = `
      <div class="health-section-hdr">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 2v8M8 13v1"/></svg>
        Disputed concepts
        <span class="health-cnt ${disputed.length > 0 ? 'danger' : 'ok'}">${disputed.length}</span>
      </div>
      <div class="health-items">
        ${disputed.length === 0 ? '<div style="padding:14px 16px;color:var(--text-muted);font-size:12px">None</div>' :
          disputed.map(c => `
            <div class="health-item" data-id="${escHtml(c.id)}">
              <div>
                <div class="h-title">${escHtml(c.title)}</div>
                <div class="h-meta">${escHtml(c.kind)} · ${escHtml(canonicalCircle(c.circle))}</div>
              </div>
            </div>
          `).join('')}
      </div>
    `;
    el.appendChild(sec);
    sec.querySelectorAll('.health-item').forEach(item => {
      item.addEventListener('click', () => selectConcept(item.dataset.id));
    });
  }

  // Dirty concepts
  const dirty = DATA.concepts.filter(c => c.dirty);
  {
    const sec = document.createElement('div');
    sec.className = 'health-section';
    sec.innerHTML = `
      <div class="health-section-hdr">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 14L8 2l6 12H2z"/></svg>
        Dirty concepts (need update)
        <span class="health-cnt ${dirty.length > 20 ? 'danger' : dirty.length > 0 ? 'warn' : 'ok'}">${dirty.length}</span>
      </div>
      <div class="health-items">
        ${dirty.length === 0 ? '<div style="padding:14px 16px;color:var(--text-muted);font-size:12px">All up to date</div>' :
          dirty.slice(0, 20).map(c => `
            <div class="health-item" data-id="${escHtml(c.id)}">
              <div>
                <div class="h-title">${escHtml(c.title)}</div>
                <div class="h-meta">${escHtml(c.kind)} · ${escHtml(canonicalCircle(c.circle))} · updated ${fmtRelTime(c.updated_at)}</div>
              </div>
            </div>
          `).join('')}
        ${dirty.length > 20 ? `<div style="padding:8px 16px;font-size:11px;color:var(--text-muted)">…and ${dirty.length - 20} more</div>` : ''}
      </div>
    `;
    el.appendChild(sec);
    sec.querySelectorAll('.health-item').forEach(item => {
      item.addEventListener('click', () => selectConcept(item.dataset.id));
    });
  }

  // Low confidence
  const lowConf = DATA.concepts.filter(c => c.confidence !== null && c.confidence !== undefined && c.confidence < 0.4)
    .sort((a, b) => (a.confidence || 0) - (b.confidence || 0));
  {
    const sec = document.createElement('div');
    sec.className = 'health-section';
    sec.innerHTML = `
      <div class="health-section-hdr">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 1v9"/><circle cx="8" cy="14" r="1" fill="currentColor"/></svg>
        Low-confidence concepts (&lt;40%)
        <span class="health-cnt ${lowConf.length > 0 ? 'warn' : 'ok'}">${lowConf.length}</span>
      </div>
      <div class="health-items">
        ${lowConf.length === 0 ? '<div style="padding:14px 16px;color:var(--text-muted);font-size:12px">None below 40%</div>' :
          lowConf.slice(0, 15).map(c => `
            <div class="health-item" data-id="${escHtml(c.id)}">
              <div style="flex:1">
                <div class="h-title">${escHtml(c.title)}</div>
                <div class="h-meta">${escHtml(c.kind)} · ${escHtml(canonicalCircle(c.circle))}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:13px;font-weight:600;color:var(--warn)">${(c.confidence * 100).toFixed(0)}%</div>
              </div>
            </div>
          `).join('')}
      </div>
    `;
    el.appendChild(sec);
    sec.querySelectorAll('.health-item').forEach(item => {
      item.addEventListener('click', () => selectConcept(item.dataset.id));
    });
  }

  // Circle health summary
  {
    const sec = document.createElement('div');
    sec.className = 'health-section';
    sec.innerHTML = `
      <div class="health-section-hdr">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="7"/><path d="M5 8l2 2 4-4"/></svg>
        Store overview by circle
      </div>
      <div class="health-items">
        ${DATA.circles.map(ci => `
          <div class="health-item" style="cursor:default">
            <div style="flex:1">
              <div class="h-title">${escHtml(ci.canonicalName)}</div>
              <div class="h-meta">${ci.conceptCount} concepts · ${ci.observationCount} observations · ${ci.edgeCount} edges · ${ci.entityCount} entities</div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    el.appendChild(sec);
  }
}

// ── Tab switching ────────────────────────────────────────────────────────────

function switchTab(tab) {
  state.activeTab = tab;
  scheduleSave();
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `${tab}-view`));

  if (tab === 'graph') {
    resizeCanvas();
  } else if (tab === 'concepts') {
    renderConceptsTable();
  } else if (tab === 'entities') {
    renderEntitiesTable();
  } else if (tab === 'timeline') {
    setTimeout(renderTimeline, 50); // let layout settle
  } else if (tab === 'health') {
    renderHealth();
  }
}

// ── Active-view rerender ─────────────────────────────────────────────────────
// Single entry point called after ANY filter/state change that affects
// getFilteredConcepts() so that whichever tab is currently visible
// (Concepts / Entities / Timeline / Health) is always kept in sync with the graph.
// Callers must ALSO call redrawGraph() for the canvas; this function handles the tab.
// Graph tab itself needs no call here — redrawGraph() handles the canvas directly.
function rerenderActiveView() {
  if (state.activeTab === 'concepts') renderConceptsTable();
  else if (state.activeTab === 'entities') renderEntitiesTable();
  else if (state.activeTab === 'timeline') renderTimeline();
  else if (state.activeTab === 'health') renderHealth();
  // 'graph' tab: canvas is kept current by redrawGraph(); nothing more to do here.
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Restore UI state from localStorage BEFORE fetching so circle/tab are correct
  restoreUiState();

  try {
    DATA = await fetchGraph();
  } catch (err) {
    document.getElementById('loading').querySelector('.loading-msg').textContent =
      'Failed to load: ' + err.message;
    return;
  }

  // Validate restored circle against the loaded store.  If state.circle was
  // persisted for a different --dir store (or a circle that no longer exists),
  // neither the canonical nor the raw name will appear in DATA.circles, and
  // getFilteredConcepts() would silently return [] → blank dashboard.
  // Reset to 'all' so the user always sees data rather than an empty graph.
  if (state.circle !== 'all') {
    const knownNames = new Set([
      ...DATA.circles.map(c => c.canonicalName),
      // Also accept raw names in case the alias map isn't symmetric
      ...DATA.aliases.map((a) => a.from_name),
      ...DATA.aliases.map((a) => a.to_name),
    ]);
    if (!knownNames.has(state.circle)) {
      state.circle = 'all';
    }
  }

  // Hide loading
  const loading = document.getElementById('loading');
  loading.classList.add('hidden');
  setTimeout(() => loading.remove(), 500);

  renderTopBar();
  renderStatBar();
  renderRail();

  // Sync slider UI to restored state
  const confSlider = document.getElementById('conf-slider');
  if (confSlider) {
    confSlider.value = state.minConfidence;
    document.getElementById('conf-val').textContent = state.minConfidence.toFixed(2);
  }
  const weightSlider = document.getElementById('weight-slider');
  if (weightSlider) {
    weightSlider.value = state.minWeight;
    document.getElementById('weight-val').textContent = state.minWeight.toFixed(1);
  }
  // Sync entity overlay chip
  const eChip = document.querySelector('.flag-chip[data-flag="entity-overlay"]');
  if (eChip) eChip.classList.toggle('active', state.entityOverlay);

  initCanvas();

  // If the entity overlay was persisted on but ENTITIES is null (first load or
  // after a page reload), fetch entities before drawing so the overlay actually
  // renders on the first graph build rather than silently skipping entity nodes.
  if (state.entityOverlay && !ENTITIES) {
    await fetchEntities();
  }

  buildGraph();

  // Switch to restored tab (after canvas is initialized)
  if (state.activeTab && state.activeTab !== 'graph') {
    switchTab(state.activeTab);
  }

  // Concepts table sort headers
  document.querySelectorAll('#concepts-table thead th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.conceptSort.col === col) {
        state.conceptSort.dir *= -1;
      } else {
        state.conceptSort.col = col;
        state.conceptSort.dir = -1;
      }
      renderConceptsTable();
    });
  });

  // Entities table sort headers
  document.querySelectorAll('#entities-table thead th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.entitySort.col === col) {
        state.entitySort.dir *= -1;
      } else {
        state.entitySort.col = col;
        state.entitySort.dir = -1;
      }
      renderEntitiesTable();
    });
  });

  // Tab buttons
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Close detail
  document.getElementById('detail-close').addEventListener('click', deselectConcept);

  // Search
  document.getElementById('search-input').addEventListener('input', e => {
    state.search = e.target.value;
    redrawGraph();
    rerenderActiveView();
  });

  // Confidence slider
  document.getElementById('conf-slider').addEventListener('input', e => {
    state.minConfidence = +e.target.value;
    document.getElementById('conf-val').textContent = state.minConfidence.toFixed(2);
    redrawGraph();
    rerenderActiveView();
    scheduleSave();
  });

  // Weight slider
  document.getElementById('weight-slider').addEventListener('input', e => {
    state.minWeight = +e.target.value;
    document.getElementById('weight-val').textContent = state.minWeight.toFixed(1);
    redrawGraph();
    rerenderActiveView();
    scheduleSave();
  });

  // Flag chips
  document.querySelectorAll('.flag-chip[data-flag]').forEach(chip => {
    const flag = chip.dataset.flag;
    if (flag === 'entity-overlay') {
      chip.addEventListener('click', async () => {
        state.entityOverlay = !state.entityOverlay;
        chip.classList.toggle('active', state.entityOverlay);
        if (state.entityOverlay && !ENTITIES) {
          await fetchEntities();
        }
        redrawGraph();
        rerenderActiveView();
      });
    } else {
      chip.addEventListener('click', () => {
        if (state.flags.has(flag)) state.flags.delete(flag);
        else state.flags.add(flag);
        chip.classList.toggle('active', state.flags.has(flag));
        redrawGraph();
        rerenderActiveView();
      });
    }
  });

  // Double-click graph overlay to fit to view
  document.getElementById('graph-overlay').addEventListener('dblclick', () => {
    fitToView([...SIM.nodes, ...SIM.entityNodes]);
    scheduleSave();
  });

  // Reset layout button — clears all pins and saved positions for current circle
  document.getElementById('reset-layout-btn').addEventListener('click', () => {
    // Clear ALL in-memory positions so a mid-reset redrawGraph() call can't
    // snapshot stale/scattered positions and trigger a frozenRestore.
    for (const id of Object.keys(nodePositions)) delete nodePositions[id];
    clearSavedLayout(state.circle);
    resetView();
    // buildGraph(true) → initSim(frozenRestore=false) → headless pre-settle
    // runs synchronously and calls fitToView + scheduleSave internally, then
    // sets SIM.settledOnce=true and SIM.running=false.  The async tick-settle
    // path (the old SIM.pendingResetSave mechanism) never fires after a headless
    // pre-settle, so the fitted camera was never persisted on Reset Layout → reload.
    // Fix: after buildGraph returns (pre-settle is complete), explicitly fit and
    // save so the correctly-framed camera is written to localStorage immediately.
    buildGraph(true);
    // headless pre-settle is now complete; SIM.settledOnce=true, SIM.running=false.
    fitToView([...SIM.nodes, ...SIM.entityNodes]);
    scheduleSave();
  });

  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', async () => {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spinning');
    try {
      DATA = await fetchGraph();
      // Invalidate the entities cache and bump the generation counter so any
      // in-flight /api/entities response that arrives after this point is discarded
      // (entities refresh race, round-5 class-A fix).
      ENTITIES = null;
      _entitiesGen++;
      // If the entity overlay is on, refetch entities BEFORE redrawing so the
      // overlay survives a Refresh.  buildGraph checks `state.entityOverlay && ENTITIES`
      // and silently skips entity nodes when ENTITIES is null — which is the window
      // that exists between the cache-clear above and the fetch completing.
      // fetchEntities() honours the generation token, so a stale response still can't
      // repopulate the cache after a second rapid Refresh.
      if (state.entityOverlay) {
        await fetchEntities();
      }
      renderTopBar();
      renderStatBar();
      renderRail();
      redrawGraph();
      // Rerender whichever tab is active — stale rows stay visible otherwise.
      // redrawGraph() only updates the canvas; tab views need an explicit call.
      rerenderActiveView();
    } finally {
      btn.classList.remove('spinning');
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target === document.getElementById('search-input')) {
      if (e.key === 'Escape') { e.target.value = ''; state.search = ''; redrawGraph(); rerenderActiveView(); e.target.blur(); }
      return;
    }
    if (e.key === '/') { e.preventDefault(); document.getElementById('search-input').focus(); }
    if (e.key === 'Escape') deselectConcept();
    if (e.key === 'f' || e.key === 'F') { fitToView([...SIM.nodes, ...SIM.entityNodes]); scheduleSave(); }
    if (e.key === '1') switchTab('graph');
    if (e.key === '2') switchTab('concepts');
    if (e.key === '3') switchTab('entities');
    if (e.key === '4') switchTab('timeline');
    if (e.key === '5') switchTab('health');
  });

  // Health item click handlers added per render
  document.getElementById('health-view').addEventListener('click', e => {
    const item = e.target.closest('[data-id]');
    if (item) {
      selectConcept(item.dataset.id);
      switchTab('graph');
    }
  });

  // Save state on before-unload
  window.addEventListener('beforeunload', () => {
    persistState();
  });
}

document.addEventListener('DOMContentLoaded', init);
