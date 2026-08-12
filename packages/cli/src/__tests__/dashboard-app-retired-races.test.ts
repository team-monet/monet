import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type PendingRequest = {
  url: string;
  resolve: (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
};

type DashboardHarness = {
  api: any;
  requests: PendingRequest[];
  respond: (index: number, payload: unknown) => void;
  refreshClasses: Set<string>;
  entitiesBody: { innerHTML: string };
};

function graphPayload(label: string, overrides: Record<string, unknown> = {}) {
  return {
    label,
    aliases: [],
    circles: [],
    concepts: [],
    ...overrides,
  };
}

function loadDashboard(): DashboardHarness {
  const appPath = new URL("../dashboard/static/app.js", import.meta.url);
  const original = fs.readFileSync(appPath, "utf8");
  const expose = `
globalThis.__dashboardTest = {
  state,
  STALE_REQUEST,
  fetchEntities,
  fetchSources,
  invalidateDependentCaches,
  reloadGraph,
  reconcileCurrentCircle,
  reconcileSelectedDetail,
  renderEntitiesTable,
  cache: () => ({
    data: DATA,
    entities: ENTITIES,
    entitiesMode: _entitiesMode,
    sources: SOURCES,
    entitiesGen: _entitiesGen,
    sourcesGen: _sourcesGen,
    graphGen: _graphRequestGen,
  }),
};`;
  const source = original.replace(
    "document.addEventListener('DOMContentLoaded', init);",
    expose,
  );
  if (source === original) throw new Error("dashboard test exposure marker not found");

  const requests: PendingRequest[] = [];
  const fetchMock = vi.fn((url: string) => new Promise((resolve) => {
    requests.push({ url, resolve: resolve as PendingRequest["resolve"] });
  }));
  const refreshClasses = new Set<string>();
  const refreshButton = {
    classList: {
      add: (name: string) => refreshClasses.add(name),
      remove: (name: string) => refreshClasses.delete(name),
      contains: (name: string) => refreshClasses.has(name),
    },
  };
  const entitiesBody = { innerHTML: "entities-unchanged" };
  const elements: Record<string, unknown> = {
    "refresh-btn": refreshButton,
    "entities-tbody": entitiesBody,
  };
  const document = {
    getElementById: (id: string) => elements[id] ?? null,
    querySelectorAll: () => [],
  };

  const context = vm.createContext({
    console,
    document,
    fetch: fetchMock,
    setTimeout,
    clearTimeout,
  });
  new vm.Script(source, { filename: "dashboard-app.js" }).runInContext(context);

  return {
    api: (context as any).__dashboardTest,
    requests,
    refreshClasses,
    entitiesBody,
    respond(index, payload) {
      requests[index].resolve({ ok: true, status: 200, json: async () => payload });
    },
  };
}

async function flushPromises() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe("dashboard visibility request coordination", () => {
  it("commits and renders only the latest graph across a same-mode triple toggle", async () => {
    const h = loadDashboard();
    const renders: string[] = [];

    const first = h.api.reloadGraph({
      invalidateCaches: true,
      render: () => renders.push("first"),
    });
    h.api.state.showRetired = true;
    const second = h.api.reloadGraph({
      invalidateCaches: true,
      render: () => renders.push("second"),
    });
    h.api.state.showRetired = false;
    const third = h.api.reloadGraph({
      invalidateCaches: true,
      render: () => renders.push("third"),
    });

    expect(h.requests.map(r => r.url)).toEqual([
      "/api/graph",
      "/api/graph?includeRetired=1",
      "/api/graph",
    ]);
    expect(h.refreshClasses.has("spinning")).toBe(true);

    h.respond(0, graphPayload("old-same-mode"));
    expect(await first).toBe(h.api.STALE_REQUEST);
    expect(h.refreshClasses.has("spinning")).toBe(true);

    h.respond(1, graphPayload("old-other-mode"));
    expect(await second).toBe(h.api.STALE_REQUEST);
    expect(h.refreshClasses.has("spinning")).toBe(true);

    h.respond(2, graphPayload("latest"));
    await third;
    expect(h.api.cache().data.label).toBe("latest");
    expect(renders).toEqual(["third"]);
    expect(h.refreshClasses.has("spinning")).toBe(false);
  });

  it("rerenders surviving detail after matching entities and never after a stale overlay", async () => {
    const h = loadDashboard();
    const renders: string[] = [];
    const detailRenders: string[] = [];
    let detail = "";
    h.api.state.entityOverlay = true;
    h.api.state.selectedId = "selected";
    const detailCallbacks = {
      close: vi.fn(),
      render: () => {
        const entities = h.api.cache().entities;
        detail = entities ? `entity:${entities.entities[0].key}` : "Load";
        detailRenders.push(detail);
      },
    };

    const first = h.api.reloadGraph({
      invalidateCaches: true,
      render: () => renders.push("first"),
      detailCallbacks,
    });
    h.respond(0, graphPayload("first", { concepts: [{ id: "selected" }] }));
    await flushPromises();
    expect(h.requests[1].url).toBe("/api/entities");
    expect(detail).toBe("Load");

    const second = h.api.reloadGraph({
      invalidateCaches: true,
      render: () => renders.push("second"),
      detailCallbacks,
    });
    h.respond(2, graphPayload("second", { concepts: [{ id: "selected" }] }));
    await flushPromises();
    expect(h.requests[3].url).toBe("/api/entities");
    expect(detailRenders).toEqual(["Load", "Load"]);

    h.respond(1, { entities: [{ key: "old" }], links: [] });
    expect(await first).toBe(h.api.STALE_REQUEST);
    expect(renders).toEqual([]);
    expect(detailRenders).toEqual(["Load", "Load"]);
    expect(h.refreshClasses.has("spinning")).toBe(true);

    h.respond(3, { entities: [{ key: "new" }], links: [] });
    await second;
    expect(h.api.cache().data.label).toBe("second");
    expect(h.api.cache().entities.entities[0].key).toBe("new");
    expect(renders).toEqual(["second"]);
    expect(detail).toBe("entity:new");
    expect(detailRenders).toEqual(["Load", "Load", "entity:new"]);
    expect(h.refreshClasses.has("spinning")).toBe(false);
  });
});

describe("dashboard graph reconciliation", () => {
  it("canonicalizes a live raw alias and rejects an alias whose circle disappeared", () => {
    const h = loadDashboard();
    h.api.state.circle = "raw-live";
    h.api.reconcileCurrentCircle(graphPayload("live", {
      aliases: [{ from_name: "raw-live", to_name: "canonical-live" }],
      circles: [{ canonicalName: "canonical-live" }],
    }));
    expect(h.api.state.circle).toBe("canonical-live");

    h.api.state.circle = "raw-retired-only";
    h.api.reconcileCurrentCircle(graphPayload("filtered", {
      aliases: [{ from_name: "raw-retired-only", to_name: "retired-only" }],
      circles: [{ canonicalName: "canonical-live" }],
    }));
    expect(h.api.state.circle).toBe("all");
  });

  it("closes a vanished detail selection and rerenders a surviving one", () => {
    const h = loadDashboard();
    const closed: string[] = [];
    const rendered: string[] = [];
    h.api.state.selectedId = "selected";

    h.api.reconcileSelectedDetail(graphPayload("missing"), {
      close: () => closed.push("selected"),
      render: (id: string) => rendered.push(id),
    });
    h.api.reconcileSelectedDetail(graphPayload("present", {
      concepts: [{ id: "selected" }],
    }), {
      close: () => closed.push("selected-again"),
      render: (id: string) => rendered.push(id),
    });

    expect(closed).toEqual(["selected"]);
    expect(rendered).toEqual(["selected"]);
  });
});

describe("dashboard visibility-dependent caches", () => {
  it("returns an entity sentinel so stale table continuations neither cache nor crash", async () => {
    const h = loadDashboard();
    h.api.state.showRetired = true;
    const oldRender = h.api.renderEntitiesTable();
    expect(h.requests[0].url).toBe("/api/entities?includeRetired=1");

    h.api.invalidateDependentCaches(false);
    const currentRender = h.api.renderEntitiesTable();
    expect(h.requests[1].url).toBe("/api/entities?includeRetired=1");

    h.respond(0, { entities: [{ key: "old" }], links: [] });
    await oldRender;
    expect(h.entitiesBody.innerHTML).toBe("entities-unchanged");
    expect(h.api.cache().entities).toBe(null);

    h.respond(1, { entities: [], links: [] });
    await currentRender;
    expect(h.entitiesBody.innerHTML).toBe("");
    expect(h.api.cache().entitiesMode).toBe(true);

    await h.api.renderEntitiesTable();
    expect(h.requests).toHaveLength(2);
  });

  it("keeps Sources on visibility toggle but invalidates it on manual Refresh", async () => {
    const h = loadDashboard();
    const sources = h.api.fetchSources();
    h.respond(0, { sources: [{ id: "source" }] });
    await sources;
    const initialSourcesGen = h.api.cache().sourcesGen;

    const toggle = h.api.reloadGraph({
      invalidateCaches: true,
      invalidateSources: false,
      spinner: false,
      render: null,
    });
    expect(h.api.cache().sources.sources[0].id).toBe("source");
    expect(h.api.cache().sourcesGen).toBe(initialSourcesGen);
    h.respond(1, graphPayload("toggle"));
    await toggle;

    const refresh = h.api.reloadGraph({
      invalidateCaches: true,
      invalidateSources: true,
      spinner: false,
      render: null,
    });
    expect(h.api.cache().sources).toBe(null);
    expect(h.api.cache().sourcesGen).toBe(initialSourcesGen + 1);
    h.respond(2, graphPayload("refresh"));
    await refresh;
  });
});
