import {
  MonetCore,
  chooseStoreEmbedder,
  type EmbeddingProvider,
} from "@team-monet/core";

export interface ServedCoreOptions {
  scopeContext: string;
  defaultCircle: string;
  /**
   * Where to materialize the gate mirror (4b-D, component B). OPTIONAL, deliberately — matching
   * `MonetCoreOptions.gateSidecarPath`'s own "NO DEFAULT" stance (engine.ts: unset means
   * declarations write no file at all): a caller that omits this gets exactly today's behavior
   * (no mirror maintenance), which is the correct default for anything that ISN'T the one
   * long-running serving process this option exists for.
   *
   * ONE WRITER SURFACE. This is the FIRST call site in this client that ever passes
   * `gateSidecarPath` — before this, NOTHING materialized the mirror automatically (checked: no
   * caller anywhere in this codebase passed the option; the live `~/.monet/gate-mirror.json` file
   * that predates this change existed only because a script ran it by hand once). Callers of
   * THIS function are cli.ts's `start` action and src/index.ts's stdio entry point — both are the
   * same long-running MCP server, just two launch paths — never a short-lived command
   * (status/doctor/source/gate all construct their OWN core through a DIFFERENT open* function in
   * this same file, none of which gained this option). The core already owns WHEN to
   * rematerialize (the generation-bump contract inside declare()/refreshGateSidecar — see
   * engine.ts); this option only supplies WHERE, and only for the process actually positioned to
   * keep that file honest on every gate-relevant write.
   */
  gateSidecarPath?: string;
  /**
   * Where the gate journal is appended — the per-evaluation record carrying rule IDENTITY, which
   * the sqlite `gate_events` row does not (it records `rule_count` and stage ids only, so "declared
   * but never fired" is unanswerable from it).
   *
   * OPTIONAL for the same reason `gateSidecarPath` above is, and passed on exactly the same terms:
   * `MonetCoreOptions.gateJournalPath` has NO DEFAULT in engine.ts (`opts.gateJournalPath ?? null`,
   * and null makes the whole journal one null check — `beginGateJournal` returns a no-op closer),
   * deliberately so that no core built by a test or a one-off script appends into a real store. A
   * caller that omits this therefore gets exactly today's behavior; the two callers of THIS function
   * pass it UNCONDITIONALLY, matching `gateSidecarPath`'s own precedent — optional at the seam, not
   * optional at the entry points.
   *
   * WHY IT HAD TO BE DECLARED HERE (monet-client#75): `openServedCore` spreads this interface into
   * `new MonetCore(...)`, so an option absent from this type never reaches the engine no matter
   * what a caller writes. Before this field existed, the ONLY wiring of `gateJournalPath` anywhere
   * was monet-core's dev-only `scripts/mcp-cli.ts` — whose own comment calls itself "THE JOURNAL'S
   * ONLY PRODUCTION WIRING" — which the shipped binary never runs. The result measured on a real
   * store: 20704 journal lines from `host-hook` and `gate-cli`, and ZERO from `stage-lookup` or
   * `core-gate`, against 146 `stage_lookup` calls that did write their sqlite rows over the same
   * window. Both MCP-originated mouths journaled nothing, silently, and it is not reconstructible
   * after the fact.
   */
  gateJournalPath?: string;
}

type StoreEmbedderSelector = (dbPath: string) => Promise<EmbeddingProvider>;

/** Open a core that will be served, selecting the embedder from the store's durable pin first. */
export async function openServedCore(
  dbPath: string,
  options: ServedCoreOptions,
  selectEmbedder: StoreEmbedderSelector = chooseStoreEmbedder,
): Promise<MonetCore> {
  const embedder = await selectEmbedder(dbPath);
  return new MonetCore(dbPath, { ...options, embedder });
}

/** Open the non-embedding status path without allowing construction to mint a pin. */
export function openStatusCore(dbPath: string, embedder?: EmbeddingProvider): MonetCore {
  return new MonetCore(dbPath, { ...(embedder ? { embedder } : {}), deferCreatedPin: true });
}
