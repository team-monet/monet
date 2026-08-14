import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

// The blank-pane trap (issue #72). switchTab() activates a view by matching
// `${tab}-view` against the DOM; a tab id with no matching container leaves
// EVERY .view inactive and renders a silently blank content pane — it throws
// nothing, so only an assertion catches it. That is reachable three ways: the
// hardcoded `state.activeTab` default, an `activeTab` restored from
// localStorage, and any switchTab() call site (e.g. the number-key shortcuts).
// These tests pin the invariant "some view is always active" rather than one
// particular landing tab, so #73 can repoint the default without touching them.

const APP_URL = new URL("../dashboard/static/app.js", import.meta.url);
const INDEX_URL = new URL("../dashboard/static/index.html", import.meta.url);

/** Tab ids and view container ids as they actually ship in index.html. */
function shippedTabs(): { tabIds: string[]; viewIds: string[] } {
  const html = fs.readFileSync(INDEX_URL, "utf8");
  return {
    tabIds: [...html.matchAll(/<button class="tab-btn" data-tab="([^"]+)"/g)].map(m => m[1]),
    viewIds: [...html.matchAll(/<div id="([\w-]+)-view" class="view"/g)].map(m => m[1]),
  };
}

function fakeClassList() {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      toggle: (name: string, force?: boolean) => {
        if (force) classes.add(name); else classes.delete(name);
      },
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
  };
}

/**
 * Runs the real app.js against a DOM built from the real index.html tab markup.
 * The per-tab renderers are stubbed — this exercises tab/view activation only,
 * which is exactly where the blank pane appears.
 */
function loadTabHarness() {
  const { tabIds, viewIds } = shippedTabs();
  const original = fs.readFileSync(APP_URL, "utf8");
  const expose = `
globalThis.scheduleSave = () => {};
globalThis.resizeCanvas = () => {};
globalThis.renderConceptsTable = () => {};
globalThis.renderEntitiesTable = () => {};
globalThis.renderTimeline = () => {};
globalThis.renderSources = () => {};
globalThis.renderHealth = () => {};
globalThis.__tabTest = { state, switchTab, restoreUiState, LS_KEY, LS_SCHEMA_V };`;
  const source = original.replace(
    "document.addEventListener('DOMContentLoaded', init);",
    expose,
  );
  if (source === original) throw new Error("dashboard test exposure marker not found");

  const buttons = tabIds.map(tab => ({ dataset: { tab }, ...fakeClassList() }));
  const views = viewIds.map(id => ({ id: `${id}-view`, ...fakeClassList() }));

  const stored = new Map<string, string>();
  const context = vm.createContext({
    console,
    fetch: vi.fn(() => new Promise(() => {})),
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k: string) => (stored.has(k) ? stored.get(k)! : null),
      setItem: (k: string, v: string) => { stored.set(k, v); },
      removeItem: (k: string) => { stored.delete(k); },
    },
    document: {
      getElementById: (id: string) => views.find(v => v.id === id) ?? null,
      querySelectorAll: (sel: string) =>
        sel === ".tab-btn" ? buttons : sel === ".view" ? views : [],
    },
  });
  new vm.Script(source, { filename: "dashboard-app.js" }).runInContext(context);
  const api = (context as any).__tabTest;

  return {
    state: api.state,
    switchTab: api.switchTab as (tab: string) => void,
    restoreUiState: api.restoreUiState as () => void,
    tabIds,
    /** Persist a UI-state payload the way the dashboard itself would. */
    setStored(payload: Record<string, unknown>) {
      stored.set(api.LS_KEY, JSON.stringify({ __v: api.LS_SCHEMA_V, ...payload }));
    },
    activeViewIds: () => views.filter(v => v.classes.has("active")).map(v => v.id),
    activeTabIds: () => buttons.filter(b => b.classes.has("active")).map(b => b.dataset.tab),
  };
}

interface FakeEl {
  id: string;
  classes: Set<string>;
  classList: ReturnType<typeof fakeClassList>["classList"];
  style: Record<string, string>;
  dataset: Record<string, string>;
  value: string;
  textContent: string;
  innerHTML: string;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  [k: string]: unknown;
}

interface BuildGraphCall {
  graphViewActive: boolean;
  width: number;
  height: number;
}

/**
 * Runs the real init() against a DOM that models the one CSS rule this is about:
 * `.view { display:none }` / `.view.active { display:flex }` — so #graph-view
 * measures 0x0 until switchTab() activates it (style.css:407-413, and no view
 * carries `active` in index.html).
 *
 * Unlike loadTabHarness, which stubs resizeCanvas away, this harness runs the
 * REAL initCanvas()/resizeCanvas(): the sizing path is the thing under test.
 * Only what is not under test is stubbed — the network load, the painters, the
 * per-tab renderers, and buildGraph itself (replaced by a recorder that captures
 * the canvas dimensions at the moment the layout would be built).
 */
function loadInitHarness(viewWidth = 1019, viewHeight = 582) {
  const { tabIds, viewIds } = shippedTabs();
  const original = fs.readFileSync(APP_URL, "utf8");
  const source = original.replace(
    "document.addEventListener('DOMContentLoaded', init);",
    "globalThis.__initTest = { init, state, CVS, LS_KEY, LS_SCHEMA_V };",
  );
  if (source === original) throw new Error("dashboard test exposure marker not found");

  const canvasCtx = { setTransform: () => {} };
  const elements = new Map<string, FakeEl>();
  const makeEl = (id: string): FakeEl => ({
    id,
    ...fakeClassList(),
    style: {},
    dataset: {},
    value: "",
    textContent: "",
    innerHTML: "",
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    remove: () => {},
    focus: () => {},
    blur: () => {},
    appendChild: () => {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getContext: () => canvasCtx,
  });

  const views = viewIds.map(id => makeEl(`${id}-view`));
  for (const v of views) elements.set(v.id, v);
  const graphView = elements.get("graph-view")!;
  // The whole point: a hidden view has no box, an active one does.
  Object.defineProperty(graphView, "clientWidth", {
    get: () => (graphView.classes.has("active") ? viewWidth : 0),
  });
  Object.defineProperty(graphView, "clientHeight", {
    get: () => (graphView.classes.has("active") ? viewHeight : 0),
  });

  const buttons = tabIds.map(tab => {
    const btn = makeEl(`tab-btn-${tab}`);
    btn.dataset.tab = tab;
    return btn;
  });
  const stored = new Map<string, string>();
  const context = vm.createContext({
    console,
    fetch: vi.fn(() => new Promise(() => {})),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    performance: { now: () => 0 },
    devicePixelRatio: 1,
    window: { addEventListener: () => {} },
    localStorage: {
      getItem: (k: string) => (stored.has(k) ? stored.get(k)! : null),
      setItem: (k: string, v: string) => { stored.set(k, v); },
      removeItem: (k: string) => { stored.delete(k); },
    },
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) {
          // View containers are exactly the ones index.html ships — an unknown
          // `<tab>-view` must stay null so tabViewExists() keeps its meaning.
          if (id.endsWith("-view")) return null;
          elements.set(id, makeEl(id));
        }
        return elements.get(id)!;
      },
      querySelector: () => null,
      querySelectorAll: (sel: string) =>
        sel.startsWith(".tab-btn") ? buttons : sel === ".view" ? views : [],
      addEventListener: () => {},
    },
  });
  new vm.Script(source, { filename: "dashboard-app.js" }).runInContext(context);
  const ctx = context as Record<string, unknown>;
  const api = ctx.__initTest as { init: () => Promise<void>; state: { activeTab: string }; CVS: { width: number; height: number }; LS_KEY: string; LS_SCHEMA_V: number };

  // Top-level `function` declarations land on the vm context's global object, so
  // reassigning them here intercepts the calls init() makes through it.
  ctx.reloadGraph = async () => ({ generation: 0, includeRetired: false });
  ctx.isCurrentGraphRequest = () => true;
  ctx.renderTopBar = () => {};
  ctx.renderStatBar = () => {};
  ctx.renderRail = () => {};
  ctx.drawFrame = () => {};

  const renderCounts: Record<string, number> = {};
  for (const name of ["renderConceptsTable", "renderEntitiesTable", "renderTimeline", "renderSources", "renderHealth"]) {
    renderCounts[name] = 0;
    ctx[name] = () => { renderCounts[name]! += 1; };
  }

  const buildGraphCalls: BuildGraphCall[] = [];
  ctx.buildGraph = () => {
    buildGraphCalls.push({
      graphViewActive: graphView.classes.has("active"),
      width: api.CVS.width,
      height: api.CVS.height,
    });
  };

  return {
    init: api.init,
    state: api.state,
    buildGraphCalls,
    renderCounts,
    viewWidth,
    viewHeight,
    setStored(payload: Record<string, unknown>) {
      stored.set(api.LS_KEY, JSON.stringify({ __v: api.LS_SCHEMA_V, ...payload }));
    },
  };
}

describe("dashboard tab markup", () => {
  it("ships exactly one view container per tab button", () => {
    const { tabIds, viewIds } = shippedTabs();
    expect(tabIds.length).toBeGreaterThan(0);
    expect([...viewIds].sort()).toEqual([...tabIds].sort());
  });
});

describe("dashboard landing tab never lands on a blank pane", () => {
  it("references no tab id that index.html does not ship", () => {
    // Catches the default `activeTab:` literal and every switchTab('...') call
    // site, including the number-key shortcuts — none of which throw when the
    // tab is dead, so a static check is the only thing that sees them.
    const app = fs.readFileSync(APP_URL, "utf8");
    const referenced = new Set<string>([
      ...[...app.matchAll(/switchTab\('([^']+)'\)/g)].map(m => m[1]),
      ...[...app.matchAll(/activeTab:\s*'([^']+)'/g)].map(m => m[1]),
    ]);
    const shipped = new Set(shippedTabs().tabIds);
    expect([...referenced].filter(t => !shipped.has(t))).toEqual([]);
  });

  it("activates a view for the hardcoded default tab", () => {
    const h = loadTabHarness();
    expect(h.tabIds).toContain(h.state.activeTab);
    h.switchTab(h.state.activeTab);
    expect(h.activeViewIds()).toEqual([`${h.state.activeTab}-view`]);
    expect(h.activeTabIds()).toEqual([h.state.activeTab]);
  });

  it("falls back to a real view for an unknown tab instead of blanking the pane", () => {
    // 'firstblock' is the concrete regression (a retired tab still persisted in
    // localStorage); the arbitrary id pins the whole class, so the next removed
    // tab cannot reopen this hole.
    for (const unknown of ["firstblock", "no-such-tab"]) {
      const h = loadTabHarness();
      h.switchTab(unknown);
      expect(h.tabIds).toContain(h.state.activeTab);
      expect(h.activeViewIds()).toEqual([`${h.state.activeTab}-view`]);
    }
  });

  it("recovers when a retired tab is restored from localStorage", () => {
    const h = loadTabHarness();
    h.setStored({ activeTab: "firstblock" });
    h.restoreUiState();
    h.switchTab(h.state.activeTab); // mirrors init()'s restored-tab step
    expect(h.tabIds).toContain(h.state.activeTab);
    expect(h.activeViewIds()).toEqual([`${h.state.activeTab}-view`]);
  });

  it("activates a view for every tab that can be restored, graph included", () => {
    for (const tab of loadTabHarness().tabIds) {
      const h = loadTabHarness();
      h.setStored({ activeTab: tab });
      h.restoreUiState();
      h.switchTab(h.state.activeTab);
      expect(h.activeViewIds()).toEqual([`${tab}-view`]);
    }
  });

  it("applies the restored tab at init with no per-tab exemption", () => {
    // switchTab() is the ONLY code that sets .active on a view, so any tab it
    // is not called for renders nothing. init() used to skip it when the
    // restored tab was 'graph' — harmless while the default was 'firstblock',
    // fatal the moment 'graph' becomes reachable as a landing tab.
    const app = fs.readFileSync(APP_URL, "utf8");
    expect(app).toContain("switchTab(state.activeTab);");
    expect(app).not.toMatch(/state\.activeTab !== '[\w-]+'/);
  });
});

// Codex P1 on PR #78. Making 'graph' the landing tab put the graph view on the
// path that init() takes on every load — and init() built the layout before it
// activated any view. #graph-view therefore measured 0x0 through initCanvas()
// and buildGraph(): initSim seeded on its fallback dimensions (`CVS.width / 2
// || 625`), fitToView() bailed out at `W === 0`, and the activation that came
// afterwards drove resizeCanvas() through its zero-to-positive branch — which
// re-scatters every node and calls reheat(1) with SIM.settledOnce already true,
// so tick()'s settle branch never refits or saves the reheated layout and any
// positions restored from localStorage are thrown away.
describe("dashboard sizes the graph canvas before it builds the layout", () => {
  it("has the graph view active and the canvas measured when buildGraph runs", async () => {
    const h = loadInitHarness();
    expect(h.state.activeTab).toBe("graph"); // the landing tab this pins
    await h.init();
    expect(h.buildGraphCalls).toEqual([
      { graphViewActive: true, width: h.viewWidth, height: h.viewHeight },
    ]);
  });

  it("still measures the canvas first when graph is the tab restored from localStorage", async () => {
    const h = loadInitHarness();
    h.setStored({ activeTab: "graph" });
    await h.init();
    expect(h.buildGraphCalls).toHaveLength(1);
    expect(h.buildGraphCalls[0]!.graphViewActive).toBe(true);
    expect(h.buildGraphCalls[0]!.height).toBeGreaterThan(0);
  });

  it("runs a non-graph landing tab's renderer exactly once and still builds the graph", async () => {
    // switchTab() does more than toggle classes — it fires the per-tab render.
    // Activating before the build must not skip that render or run it twice.
    const h = loadInitHarness();
    h.setStored({ activeTab: "concepts" });
    await h.init();
    expect(h.state.activeTab).toBe("concepts");
    expect(h.renderCounts.renderConceptsTable).toBe(1);
    expect(h.buildGraphCalls).toHaveLength(1);
  });
});
