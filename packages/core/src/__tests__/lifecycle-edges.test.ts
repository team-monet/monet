/**
 * Lifecycle edges — derivation / provenance / supersession as first-class objects, plus the
 * ratification record and the `span://` scheme a provenance edge addresses.
 *
 * The load-bearing guarantee, and the reason these rows live in their own table rather than in
 * `memory_edge`, is WIPE IMMUNITY: `unwindConceptGraph` runs an untyped
 * `DELETE FROM memory_edge WHERE scope = ? AND (src_id = ? OR dst_id = ?)` at seven call sites, and
 * `rederiveConceptGraph` only recreates what it can re-derive. Normative record cannot be
 * re-derived. The "survives every graph-maintenance operation" test below is therefore the point of
 * the whole slice, not an edge case: it drives the real public operations that reach each of those
 * unwind sites and asserts the normative rows come back byte-identical.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";
import type { EmbeddingProvider } from "../embedding";
import type { GraftPayload } from "../sync-types";
import {
  formatClaudeCodeAnchor,
  formatSpan,
  isSpanRef,
  parseClaudeCodeAnchor,
  parseSpan,
} from "../spans";
import { inspectLifecycleEdgeIntegrity } from "../diagnostics";

/** Dedup disabled so every store() yields its own concept. */
function core(opts: { syncDeviceId?: string; embedder?: EmbeddingProvider } = {}): MonetCore {
  return new MonetCore(":memory:", {
    tauAttach: 1.1,
    tauAmbiguous: 1.1,
    syncDeviceId: opts.syncDeviceId,
    embedder: opts.embedder,
  });
}

/** A real rule endpoint for supersession-family tests; plain store() creates a fact. */
const storeRule = (c: MonetCore, content: string, stage: string, circle?: string) =>
  c.store(content, { circle, kind: "rule", rule: { stage, scope: "domain" } });

type RawDb = { prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] } };
const raw = (c: MonetCore): RawDb => (c as unknown as { db: RawDb }).db;

/** Full-row snapshot, stable order — the "byte-identical" comparison unit. */
const snapshot = (c: MonetCore, table: "lifecycle_edges" | "ratifications"): string =>
  JSON.stringify(raw(c).prepare(`SELECT * FROM ${table} ORDER BY id`).all());

const SPAN = "span://claude-code/sess-1#L10-L42";

// ---------------------------------------------------------------------------
// span format
// ---------------------------------------------------------------------------
describe("span:// format", () => {
  it("round-trips format → parse for ordinary spans", () => {
    const span = { host: "claude-code", sessionId: "0d3f-91aa", anchor: "L1-L2" };
    expect(formatSpan(span)).toBe("span://claude-code/0d3f-91aa#L1-L2");
    expect(parseSpan(formatSpan(span))).toEqual(span);
  });

  it("round-trips session ids and anchors containing every reserved delimiter", () => {
    // The encoding rule is the reason the grammar is unambiguous: encodeURIComponent escapes
    // '/', '#', '%', '?' and space, so none of them can forge a boundary.
    for (const sessionId of ["a/b", "a#b", "a%b", "a b", "a?b=c", "sess://weird", "ünïcøde", "100%"]) {
      const uri = formatSpan({ host: "claude-code", sessionId, anchor: "L1-L1" });
      expect(parseSpan(uri)).toEqual({ host: "claude-code", sessionId, anchor: "L1-L1" });
    }
    for (const anchor of ["a#b", "a/b", "50%", "msg 7", "§weird"]) {
      const uri = formatSpan({ host: "other-host", sessionId: "s", anchor });
      expect(parseSpan(uri)).toEqual({ host: "other-host", sessionId: "s", anchor });
    }
  });

  it("is canonical: parse → format returns the identical URI", () => {
    for (const uri of [SPAN, "span://claude-code/a%2Fb#L1-L1", "span://x.y-z/s#anchor"]) {
      const parsed = parseSpan(uri)!;
      expect(parsed).not.toBeNull();
      expect(formatSpan(parsed)).toBe(uri);
    }
  });

  it("returns null for non-span strings rather than throwing", () => {
    for (const value of [
      "",
      "file:///Users/x/notes.md",
      "https://example.com/a#b",
      "git:abc123",
      "just some prose",
      "span:/claude-code/s#a", // one slash short of the scheme
    ]) {
      expect(parseSpan(value)).toBeNull();
    }
  });

  it("rejects malformed spans: missing anchor, missing session, bad host, bad escapes", () => {
    for (const value of [
      "span://claude-code/sess", // no '#anchor' — a span addresses a region, not a session
      "span://claude-code/sess#", // empty anchor
      "span://claude-code/#L1-L1", // empty session id
      "span:///sess#L1-L1", // empty host
      "span://claude-code#L1-L1", // no '/' separator at all
      "span://Claude-Code/s#a", // uppercase host is outside the grammar
      "span://claude code/s#a", // space in host
      "span://claude-code/a/b#L1-L1", // raw '/' in the session position is ambiguous
      "span://claude-code/s#a#b", // raw second '#'
      "span://claude-code/%ZZ#L1-L1", // malformed percent escape
      "span://claude-code/s#%E0%A4", // truncated escape sequence
    ]) {
      expect(parseSpan(value), value).toBeNull();
    }
  });

  it("formatSpan throws on inputs it cannot render canonically", () => {
    expect(() => formatSpan({ host: "BAD", sessionId: "s", anchor: "a" })).toThrow(/not a valid host/);
    expect(() => formatSpan({ host: "claude-code", sessionId: "", anchor: "a" })).toThrow(/session id/);
    expect(() => formatSpan({ host: "claude-code", sessionId: "s", anchor: "" })).toThrow(/anchor/);
  });

  it("names the field on an unpaired surrogate instead of leaking a raw URIError", () => {
    // Valid JS, no UTF-8 encoding — encodeURIComponent throws URIError and the length guards
    // above cannot see it.
    expect(() => formatSpan({ host: "claude-code", sessionId: "\uD800", anchor: "L1-L1" }))
      .toThrow(/span session id .* is not encodable \(unpaired surrogate\)/);
    // Unknown host, so the anchor reaches the encoder rather than being caught by a host grammar
    // first (a claude-code anchor containing a surrogate fails the line-range check earlier).
    expect(() => formatSpan({ host: "some-future-host", sessionId: "s", anchor: "bad\uDFFFtail" }))
      .toThrow(/span anchor .* is not encodable \(unpaired surrogate\)/);
    // A correctly paired surrogate (an astral-plane character) still round-trips.
    const emoji = { host: "claude-code", sessionId: "s\u{1F600}", anchor: "L1-L1" };
    expect(parseSpan(formatSpan(emoji))).toEqual(emoji);
  });

  it("isSpanRef answers a different question from parseSpan, on purpose", () => {
    // A malformed span still CLAIMS the namespace: it must surface as a broken span, never be
    // silently misfiled as an ordinary source ref.
    expect(isSpanRef("span://claude-code/s")).toBe(true);
    expect(parseSpan("span://claude-code/s")).toBeNull();
    expect(isSpanRef("file:///tmp/x.md")).toBe(false);
  });

  it("interprets claude-code anchors and carries unknown hosts' anchors opaquely", () => {
    expect(parseClaudeCodeAnchor("L10-L42")).toEqual({ startLine: 10, endLine: 42 });
    expect(parseClaudeCodeAnchor("L7-L7")).toEqual({ startLine: 7, endLine: 7 });
    expect(formatClaudeCodeAnchor({ startLine: 10, endLine: 42 })).toBe("L10-L42");
    // Not a claude-code range — null, not a throw.
    for (const bad of ["L0-L1", "L5-L4", "L1", "10-42", "msg:7", "", "Lx-Ly"]) {
      expect(parseClaudeCodeAnchor(bad), bad).toBeNull();
    }
    expect(() => formatClaudeCodeAnchor({ startLine: 5, endLine: 4 })).toThrow(/invalid claude-code line range/);

    // A future host's anchor grammar is unknown here and must survive untouched.
    const canonical = formatSpan({ host: "some-future-host", sessionId: "s", anchor: "chunk:7/offset:12" });
    expect(canonical).toBe("span://some-future-host/s#chunk%3A7%2Foffset%3A12");
    const parsed = parseSpan(canonical)!;
    expect(parsed.anchor).toBe("chunk:7/offset:12");
    expect(parseClaudeCodeAnchor(parsed.anchor)).toBeNull(); // uninterpreted, still valid
  });

  it("validates a KNOWN host's anchor grammar while unknown hosts stay opaque", () => {
    // L01-L02 would be a second spelling of the location L1-L2 formats — the same ambiguity the
    // URI layer's canonicity rule removes, reappearing one layer down for the one host whose
    // grammar this build understands.
    expect(parseClaudeCodeAnchor("L01-L02")).toBeNull();
    expect(parseSpan("span://claude-code/s#L01-L02")).toBeNull();
    expect(parseSpan("span://claude-code/s#L1-L0")).toBeNull(); // end before start
    expect(parseSpan("span://claude-code/s#L0-L1")).toBeNull(); // lines are 1-based
    expect(parseSpan("span://claude-code/s#msg:7")).toBeNull(); // not a line range at all
    expect(parseSpan("span://claude-code/s#L1-L2")).toEqual({ host: "claude-code", sessionId: "s", anchor: "L1-L2" });

    // The asymmetry is the design: an unknown host must be storable before its grammar is known.
    expect(parseSpan("span://some-future-host/s#L01-L02"))
      .toEqual({ host: "some-future-host", sessionId: "s", anchor: "L01-L02" });
    expect(parseSpan("span://some-future-host/s#msg%3A7"))
      .toEqual({ host: "some-future-host", sessionId: "s", anchor: "msg:7" });
  });

  it("formatSpan will not emit an anchor parseSpan would reject", () => {
    // The bijection has to hold from the WRITING side too: a URI this library produces and cannot
    // read back is worse than a rejected input, because it reaches the database before failing.
    for (const anchor of ["line-1", "L01-L02", "L0-L1", "L2-L1", "msg:7", "L1"]) {
      expect(() => formatSpan({ host: "claude-code", sessionId: "s", anchor }), anchor)
        .toThrow(/is not valid for host 'claude-code'/);
    }
    expect(formatSpan({ host: "claude-code", sessionId: "s", anchor: "L1-L2" }))
      .toBe("span://claude-code/s#L1-L2");

    // Opacity control: an unknown host's anchor is not validated at either end, and still round-trips.
    const opaque = { host: "some-future-host", sessionId: "s", anchor: "line-1" };
    expect(parseSpan(formatSpan(opaque))).toEqual(opaque);
  });

  it("is bijective: only the exact canonical spelling of a location parses", () => {
    // Two spellings of one span would defeat equality comparison on a stored dst_span.
    expect(parseSpan("span://h/s#a%2Fb")).toEqual({ host: "h", sessionId: "s", anchor: "a/b" });
    expect(parseSpan("span://h/s#a/b")).toBeNull(); // same location, non-canonical spelling
    expect(parseSpan("span://h/s#a%2fb")).toBeNull(); // lowercase escape is not what format emits
    expect(parseSpan("span://h/s#L1%2DL2")).toBeNull(); // needlessly escaped unreserved character
    expect(parseSpan("span://h/s#L1-L2")).toEqual({ host: "h", sessionId: "s", anchor: "L1-L2" });
  });
});

// ---------------------------------------------------------------------------
// schema constraints — asserted against the DATABASE, bypassing the API
// ---------------------------------------------------------------------------
describe("lifecycle_edges schema constraints", () => {
  const insert = (c: MonetCore, cols: Partial<Record<string, unknown>>): void => {
    const row = {
      id: "e1", family: "derivation", src_concept_id: "a", dst_concept_id: "b", dst_span: null,
      born_of: "correction", event_ref: null, circle: "default", created_at: 1, sync_updated_at: 1,
      ...cols,
    };
    raw(c).prepare(
      `INSERT INTO lifecycle_edges
         (id, family, src_concept_id, dst_concept_id, dst_span, born_of, event_ref, circle, created_at, sync_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.family, row.src_concept_id, row.dst_concept_id, row.dst_span,
      row.born_of, row.event_ref, row.circle, row.created_at, row.sync_updated_at);
  };

  it("rejects both polarities of the provenance destination shape", () => {
    const c = core();
    // Legal shapes first, so the failures below are about the polarity and nothing else.
    expect(() => insert(c, { id: "ok-d" })).not.toThrow();
    expect(() => insert(c, { id: "ok-p", family: "provenance", dst_concept_id: null, dst_span: SPAN })).not.toThrow();

    // provenance WITHOUT a span, and provenance WITH a concept.
    expect(() => insert(c, { id: "x1", family: "provenance", dst_concept_id: null, dst_span: null }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insert(c, { id: "x2", family: "provenance", dst_concept_id: "b", dst_span: SPAN }))
      .toThrow(/CHECK constraint failed/);

    // ...and the mirror image: a non-provenance edge WITH a span, and WITHOUT a concept.
    expect(() => insert(c, { id: "x3", family: "derivation", dst_concept_id: "b", dst_span: SPAN }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insert(c, { id: "x4", family: "derivation", dst_concept_id: null, dst_span: null }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insert(c, { id: "x5", family: "supersession", dst_concept_id: null, dst_span: null }))
      .toThrow(/CHECK constraint failed/);
  });

  it("rejects unknown families, unknown births, and ratification-born rows without their record", () => {
    const c = core();
    expect(() => insert(c, { id: "y1", family: "governs" })).toThrow(/CHECK constraint failed/);
    expect(() => insert(c, { id: "y2", born_of: "vibes" })).toThrow(/CHECK constraint failed/);
    expect(() => insert(c, { id: "y3", born_of: "ratification", event_ref: null }))
      .toThrow(/CHECK constraint failed/);
    expect(() => insert(c, { id: "y4", born_of: "ratification", event_ref: "rat-1" })).not.toThrow();
  });

  it("allows a supersession chain but only one direct successor per rule", () => {
    const c = core();
    insert(c, { id: "s1", family: "supersession", src_concept_id: "A", dst_concept_id: "B" });
    // A second successor for A is refused by the partial unique index...
    expect(() => insert(c, { id: "s2", family: "supersession", src_concept_id: "A", dst_concept_id: "C" }))
      .toThrow(/UNIQUE constraint failed/);
    // ...while B → C extends the chain, because the index constrains the SOURCE only.
    expect(() => insert(c, { id: "s3", family: "supersession", src_concept_id: "B", dst_concept_id: "C" })).not.toThrow();
    // The uniqueness is partial: derivation and provenance from the same source stay unconstrained.
    expect(() => insert(c, { id: "d1", src_concept_id: "A", dst_concept_id: "B" })).not.toThrow();
    expect(() => insert(c, { id: "d2", src_concept_id: "A", dst_concept_id: "C" })).not.toThrow();
    expect(() => insert(c, { id: "p1", family: "provenance", src_concept_id: "A", dst_concept_id: null, dst_span: SPAN })).not.toThrow();
    expect(() => insert(c, { id: "p2", family: "provenance", src_concept_id: "A", dst_concept_id: null, dst_span: "span://claude-code/s2#L1-L1" })).not.toThrow();
  });

  it("rejects a self-edge at raw SQL, not only through the API", () => {
    const c = core();
    expect(() => insert(c, { id: "z1", src_concept_id: "A", dst_concept_id: "A" })).toThrow(/CHECK constraint failed/);
    expect(() => insert(c, { id: "z2", family: "supersession", src_concept_id: "A", dst_concept_id: "A" }))
      .toThrow(/CHECK constraint failed/);
    // A provenance row's null destination must not trip the same CHECK.
    expect(() => insert(c, { id: "z3", family: "provenance", src_concept_id: "A", dst_concept_id: null, dst_span: SPAN }))
      .not.toThrow();
  });

  it("rejects an unknown ratification verdict", () => {
    const c = core();
    expect(() =>
      raw(c).prepare(
        `INSERT INTO ratifications (id, subject_concept_id, verdict, packet, ratified_by, circle, created_at, sync_updated_at)
         VALUES ('r1','c','maybe',NULL,NULL,'default',1,1)`,
      ).run(),
    ).toThrow(/CHECK constraint failed/);
  });
});

// ---------------------------------------------------------------------------
// engine API
// ---------------------------------------------------------------------------
describe("addLifecycleEdge validation", () => {
  it("names the incumbent successor when a second one is attempted", async () => {
    const c = core();
    const a = await storeRule(c, "Rule A: always branch before committing.", "commit rule");
    const b = await storeRule(c, "Rule B: branch, then commit, then push.", "commit rule");
    const d = await storeRule(c, "Rule D: a third, unrelated rule.", "commit rule");
    const first = c.addLifecycleEdge({
      family: "supersession", srcConceptId: a.conceptId, dstConceptId: b.conceptId, bornOf: "correction",
    });
    expect(() =>
      c.addLifecycleEdge({
        family: "supersession", srcConceptId: a.conceptId, dstConceptId: d.conceptId, bornOf: "correction",
      }),
    ).toThrow(new RegExp(`already superseded by '${b.conceptId}'.*${first.id}`));
  });

  it("permits a chain: A→B then B→C", async () => {
    const c = core();
    const a = await storeRule(c, "Rule A, the original.", "chain rule");
    const b = await storeRule(c, "Rule B, its successor.", "chain rule");
    const d = await storeRule(c, "Rule C, the successor's successor.", "chain rule");
    c.addLifecycleEdge({ family: "supersession", srcConceptId: a.conceptId, dstConceptId: b.conceptId, bornOf: "correction" });
    expect(() =>
      c.addLifecycleEdge({ family: "supersession", srcConceptId: b.conceptId, dstConceptId: d.conceptId, bornOf: "correction" }),
    ).not.toThrow();
    expect(c.getLifecycleEdges(b.conceptId, { direction: "both", family: "supersession" })).toHaveLength(2);
  });

  it("refuses a supersession edge that would close a cycle", async () => {
    // Uniqueness alone cannot catch this: in A→B, B has no successor of its own, so B→A passes
    // every other check. A ring makes "every rule is ultimately superseded by itself" true and
    // breaks resolving the currently governing rule by walking to the end of a chain.
    const c = core();
    const a = await storeRule(c, "Rule A.", "cycle rule");
    const b = await storeRule(c, "Rule B.", "cycle rule");
    const d = await storeRule(c, "Rule C.", "cycle rule");
    const e = await storeRule(c, "Rule D.", "cycle rule");
    const sup = (src: string, dst: string) =>
      c.addLifecycleEdge({ family: "supersession", srcConceptId: src, dstConceptId: dst, bornOf: "correction" });

    sup(a.conceptId, b.conceptId);
    // 2-cycle: B → A closes the ring, and the error names the path.
    expect(() => sup(b.conceptId, a.conceptId))
      .toThrow(new RegExp(`would close a cycle: ${b.conceptId} → ${a.conceptId} → ${b.conceptId}`));

    // 3-cycle: extend to A→B→C legally, then C → A must be refused.
    sup(b.conceptId, d.conceptId);
    expect(() => sup(d.conceptId, a.conceptId)).toThrow(/would close a cycle/);

    // A long legal chain still extends: A→B→C→D.
    expect(() => sup(d.conceptId, e.conceptId)).not.toThrow();
    expect(c.getLifecycleEdges(d.conceptId, { direction: "out", family: "supersession" })[0]!.dst_concept_id)
      .toBe(e.conceptId);
  });

  it("refuses a cross-circle normative edge", async () => {
    const c = core();
    const home = await c.store("A principle that lives at home.", { circle: "home" });
    const work = await c.store("A rule that lives at work.", { circle: "work" });
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: home.conceptId, dstConceptId: work.conceptId, bornOf: "extraction" }),
    ).toThrow(/would cross circles: source '.*' is in 'home', destination '.*' is in 'work'/);
  });

  it("refuses a self-edge, an unknown endpoint, and a mismatched destination shape", async () => {
    const c = core();
    const a = await c.store("A rule about rules.");
    const b = await c.store("Another rule.");
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: a.conceptId, dstConceptId: a.conceptId, bornOf: "extraction" }),
    ).toThrow(/cannot point a concept at itself/);
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: "ghost", dstConceptId: b.conceptId, bornOf: "extraction" }),
    ).toThrow(/source concept 'ghost' does not exist/);
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: a.conceptId, dstConceptId: "ghost", bornOf: "extraction" }),
    ).toThrow(/destination concept 'ghost' does not exist/);
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: a.conceptId, bornOf: "extraction" }),
    ).toThrow(/requires dstConceptId/);
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: a.conceptId, dstConceptId: b.conceptId, dstSpan: SPAN, bornOf: "extraction" }),
    ).toThrow(/must not carry dstSpan/);
    expect(() =>
      c.addLifecycleEdge({ family: "provenance", srcConceptId: a.conceptId, dstConceptId: b.conceptId, dstSpan: SPAN, bornOf: "correction" }),
    ).toThrow(/must not carry dstConceptId/);
    expect(() =>
      c.addLifecycleEdge({ family: "provenance", srcConceptId: a.conceptId, bornOf: "correction" }),
    ).toThrow(/requires dstSpan/);
    expect(() =>
      c.addLifecycleEdge({ family: "ratifies" as never, srcConceptId: a.conceptId, dstConceptId: b.conceptId, bornOf: "extraction" }),
    ).toThrow(/family 'ratifies' is not one of/);
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: a.conceptId, dstConceptId: b.conceptId, bornOf: "hunch" as never }),
    ).toThrow(/born_of 'hunch' is not one of/);
  });

  it("refuses connector-owned and workstream endpoints at write time", async () => {
    const c = core();
    const native = await c.store("An ordinary native rule.");
    const other = await c.store("Another ordinary native rule.");
    const source = await c.storeSource("A chunk of connector-owned source truth.", { sourceRefs: ["source://docs/rules.md#a~1"] });
    const workstream = await c.saveWorkstream({ status: "active", openQuestions: [], nextSteps: ["ship edges"] });

    // Without this guard the write succeeds, reads see it, and the export silently drops it forever
    // — no counter, no diagnostic, and the dangling sweep stays quiet because the endpoint resolves.
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: native.conceptId, dstConceptId: source.conceptId, bornOf: "extraction" }),
    ).toThrow(/destination concept '.*' is connector-owned \(kind 'source'\)/);
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: source.conceptId, dstConceptId: native.conceptId, bornOf: "extraction" }),
    ).toThrow(/source concept '.*' is connector-owned \(kind 'source'\)/);
    expect(() =>
      c.addLifecycleEdge({ family: "provenance", srcConceptId: source.conceptId, dstSpan: SPAN, bornOf: "correction" }),
    ).toThrow(/source concept '.*' is connector-owned/);
    expect(() =>
      c.addLifecycleEdge({ family: "supersession", srcConceptId: native.conceptId, dstConceptId: workstream.id, bornOf: "correction" }),
    ).toThrow(/destination concept '.*' is a workstream .* derived cache/);
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: workstream.id, dstConceptId: native.conceptId, bornOf: "extraction" }),
    ).toThrow(/source concept '.*' is a workstream/);
    expect(() => c.recordRatification({ subjectConceptId: source.conceptId, verdict: "approve" }))
      .toThrow(/subject concept '.*' is connector-owned/);
    expect(() => c.recordRatification({ subjectConceptId: workstream.id, verdict: "approve" }))
      .toThrow(/subject concept '.*' is a workstream/);

    // Control: the same shapes between two native concepts are accepted, and nothing landed above.
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: native.conceptId, dstConceptId: other.conceptId, bornOf: "extraction" }),
    ).not.toThrow();
    expect(() => c.recordRatification({ subjectConceptId: native.conceptId, verdict: "approve" })).not.toThrow();
    expect((raw(c).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges`).get() as { n: number }).n).toBe(1);
    expect((raw(c).prepare(`SELECT COUNT(*) AS n FROM ratifications`).get() as { n: number }).n).toBe(1);
  });

  it("rejects a provenance dstSpan that is an ordinary source ref", async () => {
    const c = core();
    const a = await c.store("A rule born from a correction.");
    for (const notASpan of [
      "file:///Users/x/notes.md#heading",
      "git:repo@abc123:docs/rules.md",
      "sess-1:L10-L42",
      "L10-L42",
      "span://claude-code/sess-1", // claims the namespace but is malformed
    ]) {
      expect(() =>
        c.addLifecycleEdge({ family: "provenance", srcConceptId: a.conceptId, dstSpan: notASpan, bornOf: "correction" }),
      ).toThrow(/is not a span:\/\/ URI/);
    }
    expect(() =>
      c.addLifecycleEdge({ family: "provenance", srcConceptId: a.conceptId, dstSpan: SPAN, bornOf: "correction" }),
    ).not.toThrow();
  });

  it("requires a ratification-born edge to name a ratification that actually exists", async () => {
    const c = core();
    const p = await c.store("A principle awaiting ratification.");
    const r = await c.store("A rule it would govern.");
    expect(() =>
      c.addLifecycleEdge({ family: "derivation", srcConceptId: p.conceptId, dstConceptId: r.conceptId, bornOf: "ratification" }),
    ).toThrow(/requires eventRef/);

    // Non-null is not enough: an edge claiming ratified authority that cites nothing is the worst
    // failure available to a substrate whose job is making authority auditable.
    expect(() =>
      c.addLifecycleEdge({
        family: "derivation", srcConceptId: p.conceptId, dstConceptId: r.conceptId,
        bornOf: "ratification", eventRef: "no-such-ratification",
      }),
    ).toThrow(/eventRef 'no-such-ratification' does not name a ratification on record/);

    // A ratification in another circle is equally not this edge's warrant.
    const elsewhere = await c.store("A principle in another circle.", { circle: "work" });
    const foreign = c.recordRatification({ subjectConceptId: elsewhere.conceptId, verdict: "approve" });
    expect(() =>
      c.addLifecycleEdge({
        family: "derivation", srcConceptId: p.conceptId, dstConceptId: r.conceptId,
        bornOf: "ratification", eventRef: foreign.id,
      }),
    ).toThrow(/names a ratification in circle 'work', but the edge is in 'default'/);

    const ratification = c.recordRatification({ subjectConceptId: p.conceptId, verdict: "approve" });
    const edge = c.addLifecycleEdge({
      family: "derivation", srcConceptId: p.conceptId, dstConceptId: r.conceptId,
      bornOf: "ratification", eventRef: ratification.id,
    });
    expect(edge.event_ref).toBe(ratification.id);
  });
});

describe("lifecycle edge reads", () => {
  it("round-trips edges by direction and family, and walks one derivation hop", async () => {
    const c = core();
    const principle = await c.store("Encode principles, not procedures.");
    const rule1 = await storeRule(c, "Rule one under that principle.", "read rule");
    const rule2 = await c.store("Rule two under that principle.");
    const successor = await storeRule(c, "The rule that replaces rule one.", "read rule");

    const d1 = c.addLifecycleEdge({ family: "derivation", srcConceptId: principle.conceptId, dstConceptId: rule1.conceptId, bornOf: "extraction" });
    const d2 = c.addLifecycleEdge({ family: "derivation", srcConceptId: principle.conceptId, dstConceptId: rule2.conceptId, bornOf: "extraction" });
    const prov = c.addLifecycleEdge({ family: "provenance", srcConceptId: rule1.conceptId, dstSpan: SPAN, bornOf: "correction", eventRef: "obs-9" });
    const sup = c.addLifecycleEdge({ family: "supersession", srcConceptId: rule1.conceptId, dstConceptId: successor.conceptId, bornOf: "correction" });

    expect(c.getLifecycleEdges(principle.conceptId, { direction: "out" }).map((e) => e.id)).toEqual([d1.id, d2.id]);
    expect(c.getLifecycleEdges(principle.conceptId, { direction: "in" })).toEqual([]);
    expect(c.getLifecycleEdges(rule1.conceptId, { direction: "both" }).map((e) => e.id).sort())
      .toEqual([d1.id, prov.id, sup.id].sort());
    expect(c.getLifecycleEdges(rule1.conceptId, { direction: "out", family: "provenance" }).map((e) => e.id)).toEqual([prov.id]);
    expect(c.getLifecycleEdges(rule1.conceptId, { direction: "in", family: "derivation" }).map((e) => e.id)).toEqual([d1.id]);
    // A provenance edge has no concept destination, so an inbound provenance query is empty, not an error.
    expect(c.getLifecycleEdges(rule1.conceptId, { direction: "in", family: "provenance" })).toEqual([]);

    // walkDerivation is ONE hop in each direction.
    expect(c.walkDerivation(principle.conceptId, "out").sort()).toEqual([rule1.conceptId, rule2.conceptId].sort());
    expect(c.walkDerivation(rule1.conceptId, "in")).toEqual([principle.conceptId]);
    expect(c.walkDerivation(rule1.conceptId, "out")).toEqual([]); // supersession is not derivation
    expect(c.walkDerivation(successor.conceptId, "in")).toEqual([]);

    // The stored row carries the act, not a scalar authority flag.
    expect(prov).toMatchObject({ family: "provenance", dst_concept_id: null, dst_span: SPAN, born_of: "correction", event_ref: "obs-9" });
    expect(d1).toMatchObject({ family: "derivation", dst_span: null, born_of: "extraction" });
  });

  it("round-trips ratifications newest-first", async () => {
    const c = core();
    const p = await c.store("A principle under review.");
    const other = await c.store("An unrelated principle.");
    const first = c.recordRatification({ subjectConceptId: p.conceptId, verdict: "approve", packet: JSON.stringify({ rules: 3 }), ratifiedBy: "john" });
    const second = c.recordRatification({ subjectConceptId: p.conceptId, verdict: "re-ratify", ratifiedBy: "john" });
    const third = c.recordRatification({ subjectConceptId: p.conceptId, verdict: "retire" });
    c.recordRatification({ subjectConceptId: other.conceptId, verdict: "reject" });

    const rows = c.getRatifications(p.conceptId);
    expect(rows.map((r) => r.id)).toEqual([third.id, second.id, first.id]);
    expect(rows.map((r) => r.verdict)).toEqual(["retire", "re-ratify", "approve"]);
    expect(rows[2]).toMatchObject({ packet: JSON.stringify({ rules: 3 }), ratified_by: "john", circle: "default" });
    expect(rows[0]!.packet).toBeNull();
    expect(c.getRatifications("ghost")).toEqual([]);
    expect(() => c.recordRatification({ subjectConceptId: "ghost", verdict: "approve" })).toThrow(/does not exist/);
    expect(() => c.recordRatification({ subjectConceptId: p.conceptId, verdict: "maybe" as never })).toThrow(/verdict 'maybe' is not one of/);
  });
});

// ---------------------------------------------------------------------------
// memory_ratify (ratify()) — the human-approval surface, the OTHER skeleton entrance
// ---------------------------------------------------------------------------
describe("ratify() — the human-approval surface", () => {
  it("validates candidateId existence, kind, and circle before recording anything", async () => {
    const c = core();
    const principle = await c.store("A principle awaiting ratification.", { kind: "principle" });
    const fact = await c.store("An ordinary fact, not a skeleton candidate.");

    await expect(c.ratify({ candidateId: "ghost", verdict: "approve" }))
      .rejects.toThrow(/candidateId 'ghost' does not exist/);
    await expect(c.ratify({ candidateId: fact.conceptId, verdict: "approve" }))
      .rejects.toThrow(/is kind 'fact', not 'principle' or 'preference'/);
    await expect(c.ratify({ candidateId: principle.conceptId, verdict: "approve", circle: "elsewhere" }))
      .rejects.toThrow(/is in circle 'default', not 'elsewhere'/);
    await expect(c.ratify({ candidateId: principle.conceptId, verdict: "maybe" as never }))
      .rejects.toThrow(/verdict 'maybe' is not one of/);

    // Nothing above should have recorded a ratification.
    expect(c.getRatifications(principle.conceptId)).toHaveLength(0);
    c.close();
  });

  it("approve with memberRuleIds writes one derivation edge per member, eventRef the ratification id", async () => {
    const c = core();
    const principle = await c.store("A principle with two member rules.", { kind: "principle" });
    // REAL RULES: a derivation edge may only name kind "rule" (see the member-kind test below).
    const ruleA = await c.store("Rule A, one member.", { kind: "rule", rule: { stage: "gate a", scope: "domain" } });
    const ruleB = await c.store("Rule B, the other member.", { kind: "rule", rule: { stage: "gate b", scope: "domain" } });

    const r = await c.ratify({
      candidateId: principle.conceptId,
      verdict: "approve",
      memberRuleIds: [ruleA.conceptId, ruleB.conceptId],
      ratifiedBy: "john",
      // Engine-level packet is `string | null` (see RatifyInput's own comment: pre-serialized by
      // the caller). The MCP layer (mcp-server.ts) does this JSON.stringify for a real tool call;
      // calling ratify() directly here means the test must do it too.
      packet: JSON.stringify({ rules: [ruleA.conceptId, ruleB.conceptId], reason: "shared root cause" }),
    });
    expect(r.verdict).toBe("approve");
    expect(r.conceptId).toBe(principle.conceptId);
    expect(r.edgeIds).toHaveLength(2);

    const ratifications = c.getRatifications(principle.conceptId);
    expect(ratifications).toHaveLength(1);
    expect(ratifications[0]).toMatchObject({ verdict: "approve", ratified_by: "john" });
    // Packet is stored OPAQUE and VERBATIM — the MCP layer JSON.stringifies it; the engine never
    // inspects it, so what round-trips is exactly what was handed in.
    expect(JSON.parse(ratifications[0]!.packet!)).toEqual({ rules: [ruleA.conceptId, ruleB.conceptId], reason: "shared root cause" });

    const derived = c.walkDerivation(principle.conceptId, "out");
    expect(derived.sort()).toEqual([ruleA.conceptId, ruleB.conceptId].sort());
    for (const edge of c.getLifecycleEdges(principle.conceptId, { direction: "out", family: "derivation" })) {
      expect(edge).toMatchObject({ born_of: "ratification", event_ref: r.ratificationId });
    }
    // Delivery is read from the skeleton surface, not repeated in the write acknowledgement.
    expect(c.skeleton().some((e) => e.conceptId === principle.conceptId)).toBe(true);
    c.close();
  });

  it("ratifies a global-breadth candidate without changing its breadth", async () => {
    const c = core();
    const declared = await c.declare({
      species: "principle", content: "A globally governing principle.", circle: "*",
    });
    if (declared.species !== "principle") throw new Error("unreachable");

    const ratified = await c.ratify({
      candidateId: declared.conceptId, verdict: "re-ratify", circle: "default", ratifiedBy: "john",
    });
    expect(c.skeleton().find((entry) => entry.conceptId === declared.conceptId))
      .toMatchObject({ breadth: "global", ratifiedBy: "john" });
    expect(c.skeleton("another-circle").find((entry) => entry.conceptId === declared.conceptId))
      .toMatchObject({ breadth: "global" });
    c.close();
  });

  it("re-ratify with memberRuleIds ALSO writes edges; reject/retire never do, even when memberRuleIds is given", async () => {
    const c = core();
    const principle = await c.store("A principle re-ratified after doubt.", { kind: "principle" });
    const rule = await c.store("Its one member rule.", { kind: "rule", rule: { stage: "some gate", scope: "domain" } });

    await c.ratify({ candidateId: principle.conceptId, verdict: "retire" });
    const reRatified = await c.ratify({ candidateId: principle.conceptId, verdict: "re-ratify", memberRuleIds: [rule.conceptId] });
    expect(reRatified.edgeIds).toHaveLength(1);

    const other = await c.store("A second principle, only ever rejected/retired.", { kind: "principle" });
    const rejectResult = await c.ratify({ candidateId: other.conceptId, verdict: "reject", memberRuleIds: [rule.conceptId] });
    expect(rejectResult.edgeIds).toHaveLength(0);
    const retireResult = await c.ratify({ candidateId: other.conceptId, verdict: "retire", memberRuleIds: [rule.conceptId] });
    expect(retireResult.edgeIds).toHaveLength(0);
    // Ratification history is append-only regardless — every verdict is still recorded.
    expect(c.getRatifications(other.conceptId).map((row) => row.verdict)).toEqual(["retire", "reject"]);
    c.close();
  });

  it("refuses a memberRuleId that is not kind 'rule', before writing anything at all", async () => {
    // The contract is "derivation edges principle → rule" (review round 1, item 3). addLifecycleEdge
    // itself only enforces governability, so without this check a member id naming a fact minted an
    // edge asserting the principle GENERATES that fact.
    const c = core();
    const principle = await c.store("A principle with a mis-typed member list.", { kind: "principle" });
    const realRule = await c.store("A genuine member rule.", { kind: "rule", rule: { stage: "some gate", scope: "domain" } });
    const fact = await c.store("An ordinary fact that is not a rule.");

    await expect(
      c.ratify({ candidateId: principle.conceptId, verdict: "approve", memberRuleIds: [fact.conceptId] }),
    ).rejects.toThrow(new RegExp(`member rule '${fact.conceptId}' is kind 'fact', not 'rule'`));
    await expect(
      c.ratify({ candidateId: principle.conceptId, verdict: "approve", memberRuleIds: [realRule.conceptId, "ghost"] }),
    ).rejects.toThrow(/member rule 'ghost' does not exist/);

    // VALIDATED UP FRONT: the good id in position 1 of the second call left no edge behind, and
    // neither call recorded a ratification.
    expect(c.walkDerivation(principle.conceptId, "out")).toEqual([]);
    expect(c.getRatifications(principle.conceptId)).toHaveLength(0);

    // Control: the same call with only the real rule succeeds.
    const ok = await c.ratify({ candidateId: principle.conceptId, verdict: "approve", memberRuleIds: [realRule.conceptId] });
    expect(ok.edgeIds).toHaveLength(1);
    c.close();
  });

  it("names the dated cross-circle deferral when a member rule lives in a different circle", async () => {
    const c = core();
    const principle = await c.store("A principle at home.", { circle: "home", kind: "principle" });
    const rule = await c.store("A rule at work.", { circle: "work", kind: "rule", rule: { stage: "work gate", scope: "domain" } });
    await expect(
      c.ratify({ candidateId: principle.conceptId, verdict: "approve", memberRuleIds: [rule.conceptId], circle: "home" }),
    ).rejects.toThrow(/Cross-circle skeleton membership is deliberately undecided \(dated deferral, 2026-07-29\)/);
    // The refusal must not have left a partial edge behind.
    expect(c.walkDerivation(principle.conceptId, "out")).toEqual([]);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// skeleton() — derived membership, latest-ratification-wins
// ---------------------------------------------------------------------------
describe("skeleton() — derived membership, never a stored flag", () => {
  it("two approves in a row is idempotent membership", async () => {
    const c = core();
    const principle = await c.store("Idempotent under repeated approval.", { kind: "principle" });
    await c.ratify({ candidateId: principle.conceptId, verdict: "approve" });
    await c.ratify({ candidateId: principle.conceptId, verdict: "approve" });
    const members = c.skeleton().filter((e) => e.conceptId === principle.conceptId);
    expect(members).toHaveLength(1);
    c.close();
  });

  it("approve then retire takes a concept OUT of the skeleton", async () => {
    const c = core();
    const principle = await c.store("Approved, then impeached.", { kind: "principle" });
    await c.ratify({ candidateId: principle.conceptId, verdict: "approve" });
    expect(c.skeleton().some((e) => e.conceptId === principle.conceptId)).toBe(true);
    await c.ratify({ candidateId: principle.conceptId, verdict: "retire" });
    expect(c.skeleton().some((e) => e.conceptId === principle.conceptId)).toBe(false);
    c.close();
  });

  it("retire then re-ratify brings a concept BACK into the skeleton", async () => {
    const c = core();
    const principle = await c.store("Impeached, then reinstated.", { kind: "principle" });
    await c.ratify({ candidateId: principle.conceptId, verdict: "approve" });
    await c.ratify({ candidateId: principle.conceptId, verdict: "retire" });
    expect(c.skeleton().some((e) => e.conceptId === principle.conceptId)).toBe(false);
    await c.ratify({ candidateId: principle.conceptId, verdict: "re-ratify" });
    expect(c.skeleton().some((e) => e.conceptId === principle.conceptId)).toBe(true);
    c.close();
  });

  it("a reject-only concept never enters the skeleton", async () => {
    const c = core();
    const principle = await c.store("Rejected outright, never approved.", { kind: "principle" });
    await c.ratify({ candidateId: principle.conceptId, verdict: "reject" });
    expect(c.skeleton().some((e) => e.conceptId === principle.conceptId)).toBe(false);
    c.close();
  });

  it("delivers OLDEST ratification first, so truncation drops the newest, not the settled core", async () => {
    // Delivery order IS truncation order — every consumer caps a prefix (review round 1, item 7).
    const c = core();
    const first = await c.store("The oldest principle, long settled.", { kind: "principle" });
    const second = await c.store("A later principle.", { kind: "principle" });
    const third = await c.store("The newest principle.", { kind: "principle" });
    await c.ratify({ candidateId: first.conceptId, verdict: "approve" });
    await c.ratify({ candidateId: second.conceptId, verdict: "approve" });
    await c.ratify({ candidateId: third.conceptId, verdict: "approve" });

    expect(c.skeleton().map((e) => e.conceptId))
      .toEqual([first.conceptId, second.conceptId, third.conceptId]);

    // RATIFICATION TIME, NOT CONCEPT AGE: re-ratifying the oldest moves it to the END, because its
    // membership is only as old as the ruling that granted it.
    await c.ratify({ candidateId: first.conceptId, verdict: "re-ratify" });
    expect(c.skeleton().map((e) => e.conceptId))
      .toEqual([second.conceptId, third.conceptId, first.conceptId]);
    c.close();
  });

  it("unions local and global members, with no shadowing or double-delivery in the home circle", async () => {
    const c = core();
    const localHome = await c.declare({
      species: "principle", content: "A local principle at home.", circle: "home",
    });
    const localElsewhere = await c.declare({
      species: "principle", content: "A local principle elsewhere.", circle: "elsewhere",
    });
    // A global declaration keeps the default circle as its home.
    const global = await c.declare({
      species: "preference", content: "A preference delivered everywhere.", circle: "*",
    });
    if (localHome.species !== "principle" || localElsewhere.species !== "principle" || global.species !== "preference") {
      throw new Error("unreachable");
    }

    expect(c.skeleton("home").map((entry) => entry.conceptId).sort())
      .toEqual([localHome.conceptId, global.conceptId].sort());
    expect(c.skeleton("elsewhere").map((entry) => entry.conceptId).sort())
      .toEqual([localElsewhere.conceptId, global.conceptId].sort());
    expect(c.skeleton("unseen").map((entry) => entry.conceptId)).toEqual([global.conceptId]);

    // The global member's home is "default" and the union predicate returns it once there, not once
    // through each side of the union. Local members remain explicitly distinguishable to renderers.
    expect(c.skeleton("default").filter((entry) => entry.conceptId === global.conceptId)).toHaveLength(1);
    expect(c.skeleton("default").find((entry) => entry.conceptId === global.conceptId)?.breadth).toBe("global");
    expect(c.skeleton("home").find((entry) => entry.conceptId === localHome.conceptId)?.breadth).toBe("local");
    expect(c.overview("elsewhere").skeleton.map((entry) => entry.conceptId).sort())
      .toEqual([localElsewhere.conceptId, global.conceptId].sort());
    c.close();
  });

  it("re-declaration preserves existing breadth when circle is omitted and narrows it when local is explicit", async () => {
    const c = new MonetCore(":memory:");
    const content = "An explicitly global preference whose wording is restated.";
    const global = await c.declare({ species: "preference", content, circle: "*" });
    if (global.species !== "preference") throw new Error("unreachable");

    const preserved = await c.declare({ species: "preference", content });
    if (preserved.species !== "preference") throw new Error("unreachable");
    expect(preserved.conceptId).toBe(global.conceptId);
    expect(c.skeleton("elsewhere").find((entry) => entry.conceptId === global.conceptId)?.breadth).toBe("global");

    const narrowed = await c.declare({ species: "preference", content, circle: "default" });
    if (narrowed.species !== "preference") throw new Error("unreachable");
    expect(narrowed.conceptId).toBe(global.conceptId);
    expect(c.skeleton("elsewhere").some((entry) => entry.conceptId === global.conceptId)).toBe(false);
    expect(c.skeleton("default").find((entry) => entry.conceptId === global.conceptId)?.breadth).toBe("local");
    c.close();
  });

  it("keeps authority derived from ratifications rather than a scalar membership flag", async () => {
    const c = core();
    const principle = await c.store("A principle at home.", { circle: "home", kind: "principle" });
    const preference = await c.store("A preference at home.", { circle: "home", kind: "preference" });
    await c.ratify({ candidateId: principle.conceptId, verdict: "approve", circle: "home" });
    await c.ratify({ candidateId: preference.conceptId, verdict: "approve", circle: "home" });

    const home = c.skeleton("home");
    expect(home.map((e) => e.conceptId).sort()).toEqual([principle.conceptId, preference.conceptId].sort());
    expect(home.find((e) => e.conceptId === principle.conceptId)!.species).toBe("principle");
    expect(home.find((e) => e.conceptId === preference.conceptId)!.species).toBe("preference");

    // skeleton_breadth controls delivery scope only. Membership itself remains derived solely from
    // the latest ratification join; no scalar ratified/approved/authority flag exists.
    const row = raw(c).prepare(`SELECT * FROM concepts WHERE id = ?`).get(principle.conceptId) as Record<string, unknown>;
    expect(Object.keys(row).some((key) => /ratif|approved|authority/i.test(key))).toBe(false);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// THE regression: graph maintenance cannot touch normative record
// ---------------------------------------------------------------------------
describe("wipe immunity", () => {
  it("survives every graph-maintenance operation that wipes memory_edge", async () => {
    const c = core();
    // Related concepts stored in one (implicit) session, so the similarity graph really does carry
    // `related`/`co_occurred` edges for the operations below to destroy.
    const principle = await c.store("Encode principles, not procedures, when writing rules.");
    const rule = await storeRule(c, "Encode principles, not procedures, in the rule capture path.", "capture rule");
    const successor = await storeRule(c, "Encode principles, not procedures — revised wording.", "capture rule");
    await c.store("A second observation on the rule concept.", { attachTo: rule.conceptId });

    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle.conceptId, dstConceptId: rule.conceptId, bornOf: "extraction" });
    c.addLifecycleEdge({ family: "provenance", srcConceptId: rule.conceptId, dstSpan: SPAN, bornOf: "correction", eventRef: "obs-1" });
    c.addLifecycleEdge({ family: "provenance", srcConceptId: rule.conceptId, dstSpan: "span://claude-code/sess-2#L1-L9", bornOf: "correction", eventRef: "obs-2" });
    c.addLifecycleEdge({ family: "supersession", srcConceptId: rule.conceptId, dstConceptId: successor.conceptId, bornOf: "correction" });
    c.recordRatification({ subjectConceptId: principle.conceptId, verdict: "approve", packet: JSON.stringify({ evidence: 2 }), ratifiedBy: "john" });

    const edgesBefore = snapshot(c, "lifecycle_edges");
    const ratificationsBefore = snapshot(c, "ratifications");
    const memoryEdgesOn = (id: string): number =>
      (raw(c).prepare(`SELECT COUNT(*) AS n FROM memory_edge WHERE src_id = ? OR dst_id = ?`).get(id, id) as { n: number }).n;
    // Non-vacuity precondition: the destructive operations must have something to destroy.
    expect(memoryEdgesOn(rule.conceptId)).toBeGreaterThan(0);

    // 1. detach with rederive (non-consolidating) — unwind sites inside detach().
    const fetched = (await c.getConcept(rule.conceptId, { synthesize: false }))!;
    const secondObs = fetched.observations[1]!.id;
    await c.detach(rule.conceptId, [secondObs]);

    // 2. retire + restore — the unwind inside retireConcept(), and restoreConcept()'s rederive.
    expect(c.retireConcept(rule.conceptId)).not.toBeNull();
    // THE proof, caught mid-flight: retirement's untyped DELETE has just erased every memory_edge
    // row touching this concept, and every lifecycle edge on it is still there. This is precisely
    // what would have been lost had the normative edges lived in memory_edge.
    expect(memoryEdgesOn(rule.conceptId)).toBe(0);
    expect(c.getLifecycleEdges(rule.conceptId, { direction: "both" })).toHaveLength(4);
    expect(c.restoreConcept(rule.conceptId)).not.toBeNull();

    // 3. reassignCircle → moveConcept's unwind, the site with NO possible_duplicate_of carve-out.
    expect(c.reassignCircle(rule.conceptId, "work")).not.toBeNull();
    expect(c.reassignCircle(rule.conceptId, "default")).not.toBeNull();

    // 4. the reembed path: a full embedding migration, whose final graph phase replaces the
    //    model-derived `related` family for every native concept.
    const migration = await c.migrateEmbeddings({ targetModelId: new HashingEmbeddingProvider().modelId });
    expect(migration.failures).toEqual([]);

    // The normative record is byte-identical across the whole battery.
    expect(snapshot(c, "lifecycle_edges")).toBe(edgesBefore);
    expect(snapshot(c, "ratifications")).toBe(ratificationsBefore);
    expect(c.getLifecycleEdges(rule.conceptId, { direction: "both" })).toHaveLength(4);
    expect(c.getRatifications(principle.conceptId)).toHaveLength(1);
  });

  it("keeps the edge's circle at its birth value across a concept move", async () => {
    // Documented consequence of append-only: `circle` records where the ACT happened. Nothing
    // rewrites it when the concept later moves, and no consumer reads it yet. Pinned here so the
    // slice that gives `circle` a consumer has to decide deliberately rather than inherit silently.
    const c = core();
    const a = await storeRule(c, "A rule that will move house.", "moving rule");
    const b = await storeRule(c, "The rule that replaces it.", "moving rule");
    const edge = c.addLifecycleEdge({ family: "supersession", srcConceptId: a.conceptId, dstConceptId: b.conceptId, bornOf: "correction" });
    expect(edge.circle).toBe("default");
    c.reassignCircle(a.conceptId, "work");
    expect(c.getLifecycleEdges(a.conceptId, { direction: "out" })[0]!.circle).toBe("default");
  });

  it("FOLLOWS a circle rename, unlike a concept move", async () => {
    // The mirror of the pin directly above, and the distinction is real. A concept MOVE leaves the
    // old circle existing, so the edge keeps the circle its act happened in. A circle RENAME renames
    // the locality itself — the old name ceases to exist and every sibling scope-bearing table
    // (concepts, observations, memory_edge, entities, concept_entities) follows it — so a normative
    // row left behind would name a circle that is gone and read as empty forever.
    const c = core();
    const a = await storeRule(c, "A rule in a circle about to be renamed.", "rename rule", "old-name");
    const b = await storeRule(c, "Its successor, same circle.", "rename rule", "old-name");
    c.addLifecycleEdge({ family: "supersession", srcConceptId: a.conceptId, dstConceptId: b.conceptId, bornOf: "correction" });
    c.addLifecycleEdge({ family: "provenance", srcConceptId: a.conceptId, dstSpan: SPAN, bornOf: "correction", eventRef: "obs-1" });
    c.recordRatification({ subjectConceptId: a.conceptId, verdict: "approve" });

    c.renameCircle("old-name", "new-name");

    const conceptCircle = (raw(c).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(a.conceptId) as { circle: string }).circle;
    expect(conceptCircle).toBe("new-name");
    for (const edge of c.getLifecycleEdges(a.conceptId, { direction: "both" })) expect(edge.circle).toBe("new-name");
    expect(c.getRatifications(a.conceptId)[0]!.circle).toBe("new-name");
    // Nothing is stranded under the name that no longer exists.
    expect((raw(c).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges WHERE circle = 'old-name'`).get() as { n: number }).n).toBe(0);
    expect((raw(c).prepare(`SELECT COUNT(*) AS n FROM ratifications WHERE circle = 'old-name'`).get() as { n: number }).n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------
describe("lifecycle edge sync", () => {
  it("syncs global skeleton breadth with the concept so peers deliver the same union", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const global = await src.declare({
      species: "principle", content: "A global principle survives relay.", circle: "*",
    });
    if (global.species !== "principle") throw new Error("unreachable");

    const payload = src.exportDelta(0);
    expect(payload.schemaVersion).toBe(15);
    expect(payload.concepts.find((row) => row.id === global.conceptId)?.skeleton_breadth).toBe("global");
    dst.graftRows(payload);
    expect(dst.skeleton("a-circle-with-no-local-members").find((entry) => entry.conceptId === global.conceptId))
      .toMatchObject({ breadth: "global" });
  });

  it("carries both tables across export → graft, and dedupes on a replay", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const principle = await src.store("Encode principles, not procedures.");
    const rule = await storeRule(src, "A rule derived from that principle.", "sync rule");
    const successor = await storeRule(src, "The rule that supersedes it.", "sync rule");
    const ratification = src.recordRatification({ subjectConceptId: principle.conceptId, verdict: "approve", packet: "{}", ratifiedBy: "john" });
    const derivation = src.addLifecycleEdge({
      family: "derivation", srcConceptId: principle.conceptId, dstConceptId: rule.conceptId,
      bornOf: "ratification", eventRef: ratification.id,
    });
    const provenance = src.addLifecycleEdge({ family: "provenance", srcConceptId: rule.conceptId, dstSpan: SPAN, bornOf: "correction", eventRef: "obs-1" });
    const supersession = src.addLifecycleEdge({ family: "supersession", srcConceptId: rule.conceptId, dstConceptId: successor.conceptId, bornOf: "correction" });

    const payload = src.exportDelta(0);
    expect(payload.lifecycleEdges?.map((e) => e.id).sort()).toEqual([derivation.id, provenance.id, supersession.id].sort());
    expect(payload.ratifications?.map((r) => r.id)).toEqual([ratification.id]);

    const result = await dst.graftRows(payload);
    expect(result.inserted.lifecycle_edges).toBe(3);
    expect(result.inserted.ratifications).toBe(1);

    // Semantic content survives intact, including the span and the birth act.
    const landed = dst.getLifecycleEdges(rule.conceptId, { direction: "both" });
    expect(landed.map((e) => e.id).sort()).toEqual([derivation.id, provenance.id, supersession.id].sort());
    expect(landed.find((e) => e.family === "provenance")).toMatchObject({ dst_span: SPAN, born_of: "correction", event_ref: "obs-1" });
    expect(dst.walkDerivation(principle.conceptId, "out")).toEqual([rule.conceptId]);
    expect(dst.getRatifications(principle.conceptId)[0]).toMatchObject({
      id: ratification.id, verdict: "approve", packet: "{}", ratified_by: "john",
    });
    // created_at is the semantic birth time and survives the relay; sync_updated_at is restamped.
    expect(dst.getLifecycleEdges(rule.conceptId, { direction: "out", family: "provenance" })[0]!.created_at)
      .toBe(provenance.created_at);

    // Append-only rows are immutable, so a replay is a pure no-op.
    const replay = await dst.graftRows(payload);
    expect(replay.inserted.lifecycle_edges).toBe(0);
    expect(replay.inserted.ratifications).toBe(0);
    expect(replay.skipped.lifecycle_edges).toBe(3);
    expect(replay.skipped.ratifications).toBe(1);

    // A round trip back out of the receiver re-exports the same normative rows.
    expect(dst.exportDelta(0).lifecycleEdges?.map((e) => e.id).sort())
      .toEqual([derivation.id, provenance.id, supersession.id].sort());
  });

  it("keeps a graft atomic when two replicas name different successors for one rule", async () => {
    const local = core({ syncDeviceId: "machine-a" });
    const a = await storeRule(local, "The rule everyone is trying to replace.", "divergent rule");
    const b = await storeRule(local, "Successor chosen on this machine.", "divergent rule");
    const peerChoice = await storeRule(local, "Successor chosen on the other machine.", "divergent rule");
    const mine = local.addLifecycleEdge({ family: "supersession", srcConceptId: a.conceptId, dstConceptId: b.conceptId, bornOf: "correction" });

    // A peer's payload naming a DIFFERENT successor for the same rule. The partial unique index
    // would abort the whole graft; the incumbent wins and the challenger is counted as skipped.
    const payload = local.exportDelta(0);
    const theirs = { ...payload.lifecycleEdges![0]!, id: "peer-edge-1", dst_concept_id: peerChoice.conceptId };
    const result = local.graftRows({ ...payload, lifecycleEdges: [theirs] });
    expect(result.skipped.lifecycle_edges).toBe(1);
    expect(result.inserted.lifecycle_edges).toBe(0);
    expect(local.getLifecycleEdges(a.conceptId, { direction: "out", family: "supersession" }).map((e) => e.id)).toEqual([mine.id]);
    // The graft as a whole still committed — the challenger was skipped, not fatal.
    expect(local.getLifecycleEdges(a.conceptId, { direction: "out" })[0]!.dst_concept_id).toBe(b.conceptId);
  });

  it("relays a dangling normative record onward through A → B → C", async () => {
    // The common pairing: A retires a rule, so its concept row is excluded from the export while
    // its supersession/provenance edges still travel. B legitimately receives DANGLING rows. If the
    // export INNER-joined its endpoints, B could never re-export them and C would never receive the
    // audit record at all. The normative record replicates independently of endpoint liveness.
    const a = core({ syncDeviceId: "machine-a" });
    const b = core({ syncDeviceId: "machine-b" });
    const cc = core({ syncDeviceId: "machine-c" });

    const rule = await storeRule(a, "The rule that will be retired on machine A.", "retired sync rule");
    const successor = await storeRule(a, "Its successor, which stays active.", "retired sync rule");
    const ratification = a.recordRatification({ subjectConceptId: rule.conceptId, verdict: "retire", ratifiedBy: "john" });
    a.addLifecycleEdge({ family: "supersession", srcConceptId: rule.conceptId, dstConceptId: successor.conceptId, bornOf: "correction" });
    a.addLifecycleEdge({ family: "provenance", srcConceptId: rule.conceptId, dstSpan: SPAN, bornOf: "correction", eventRef: "obs-1" });
    a.addLifecycleEdge({
      family: "derivation", srcConceptId: successor.conceptId, dstConceptId: rule.conceptId,
      bornOf: "ratification", eventRef: ratification.id,
    });
    a.retireConcept(rule.conceptId);

    // A → B. The retired concept row is withheld; the normative rows are not.
    const fromA = a.exportDelta(0);
    expect(fromA.concepts.map((c) => c.id)).not.toContain(rule.conceptId);
    expect(fromA.lifecycleEdges).toHaveLength(3);
    expect(b.graftRows(fromA).inserted).toMatchObject({ lifecycle_edges: 3, ratifications: 1 });

    // B holds them as genuinely dangling — this is the state the INNER join could not re-export.
    const bSweep = b.lifecycleEdgeIntegrity();
    expect(bSweep.dangling).toHaveLength(3);
    expect(bSweep.danglingRatifications).toHaveLength(1);

    // B → C: the whole audit record relays onward.
    const fromB = b.exportDelta(0);
    expect(fromB.lifecycleEdges?.map((e) => e.id).sort()).toEqual(fromA.lifecycleEdges!.map((e) => e.id).sort());
    expect(cc.graftRows(fromB).inserted).toMatchObject({ lifecycle_edges: 3, ratifications: 1 });
    expect(cc.getLifecycleEdges(rule.conceptId, { direction: "both" })).toHaveLength(3);
    expect(cc.getRatifications(rule.conceptId)[0]).toMatchObject({ verdict: "retire", ratified_by: "john" });
    expect(cc.getLifecycleEdges(rule.conceptId, { direction: "out", family: "provenance" })[0]!.dst_span).toBe(SPAN);

    // A restores the rule and syncs; C's endpoint resolves and its sweep goes quiet.
    a.restoreConcept(rule.conceptId);
    const restored = a.exportDelta(0);
    b.graftRows(restored);
    cc.graftRows(b.exportDelta(0));
    expect(cc.lifecycleEdgeIntegrity().dangling).toEqual([]);
    expect(cc.lifecycleEdgeIntegrity().danglingRatifications).toEqual([]);
    expect(cc.walkDerivation(successor.conceptId, "out")).toEqual([rule.conceptId]);
  });

  it("still refuses to relay THROUGH a store where the endpoint is source-owned", async () => {
    // The LEFT join relaxes liveness, not authority. Security stays three-deep: refused at write on
    // the origin, dropped by the export guard wherever the row is visible, and rejected by every
    // hop's graft backdoor guard against ITS OWN local source-owned set.
    const relay = core({ syncDeviceId: "machine-relay" });
    const peer = core({ syncDeviceId: "machine-peer" });
    const shadowed = await relay.storeSource("Connector-owned on the relay.", { sourceRefs: ["source://docs/x.md#a~1"] });
    const native = await peer.store("Native on the peer.");
    const other = await peer.store("Another native on the peer.");
    peer.addLifecycleEdge({ family: "derivation", srcConceptId: native.conceptId, dstConceptId: other.conceptId, bornOf: "extraction" });

    // A payload whose edge names an id the RELAY holds as source-owned.
    const payload = peer.exportDelta(0);
    const forged = { ...payload.lifecycleEdges![0]!, id: "forged-1", dst_concept_id: shadowed.conceptId };
    expect(() => relay.graftRows({ ...payload, lifecycleEdges: [forged] }))
      .toThrow(/graftRows cannot mutate source-owned concepts/);
    expect((raw(relay).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges`).get() as { n: number }).n).toBe(0);

    // And a locally source-owned endpoint is never exported even if a row somehow exists.
    raw(relay).prepare(
      `INSERT INTO lifecycle_edges (id, family, src_concept_id, dst_concept_id, dst_span, born_of, event_ref, circle, created_at, sync_updated_at)
       VALUES ('smuggled','provenance',?,NULL,?, 'correction','obs-1','default',1,1)`,
    ).run(shadowed.conceptId, SPAN);
    expect(relay.exportDelta(0).lifecycleEdges).toEqual([]);
  });

  it("converges a circle rename across replicas, and a stale rename cannot clobber a newer one", async () => {
    // Two halves, both required. (a) The rename must ADVANCE sync_updated_at or an incremental
    // export never selects the rows and the rename is invisible forever. (b) The graft must be able
    // to UPDATE circle — with ON CONFLICT(id) DO NOTHING even a full re-export leaves the receiver
    // holding the dead circle name.
    const a = core({ syncDeviceId: "machine-a" });
    const b = core({ syncDeviceId: "machine-b" });
    const rule = await storeRule(a, "A rule in a circle about to be renamed.", "replica rename rule", "old-name");
    const succ = await storeRule(a, "Its successor.", "replica rename rule", "old-name");
    a.addLifecycleEdge({ family: "supersession", srcConceptId: rule.conceptId, dstConceptId: succ.conceptId, bornOf: "correction" });
    a.recordRatification({ subjectConceptId: rule.conceptId, verdict: "approve" });
    b.graftRows(a.exportDelta(0));
    expect(b.getLifecycleEdges(rule.conceptId, { direction: "out" })[0]!.circle).toBe("old-name");

    // Cursor taken BEFORE the rename: this is an incremental export, not a full one.
    const cursor = a.exportDelta(0).exportedAt + 1;
    a.renameCircle("old-name", "new-name");
    const delta = a.exportDelta(cursor);
    expect(delta.lifecycleEdges).toHaveLength(1); // (a) the rename is visible to an incremental export
    expect(delta.ratifications).toHaveLength(1);

    b.graftRows(delta);
    expect(b.getLifecycleEdges(rule.conceptId, { direction: "out" })[0]!.circle).toBe("new-name"); // (b)
    expect(b.getRatifications(rule.conceptId)[0]!.circle).toBe("new-name");

    // A stale rename (lower sync_revision) must not clobber the newer locality.
    const stale = {
      ...delta.lifecycleEdges![0]!, circle: "stale-name", sync_revision: 0, sync_writer: "machine-a",
    };
    const staleRat = {
      ...delta.ratifications![0]!, circle: "stale-name", sync_revision: 0, sync_writer: "machine-a",
    };
    const result = b.graftRows({ ...delta, lifecycleEdges: [stale], ratifications: [staleRat] });
    expect(result.skipped.lifecycle_edges).toBe(1);
    expect(result.skipped.ratifications).toBe(1);
    expect(b.getLifecycleEdges(rule.conceptId, { direction: "out" })[0]!.circle).toBe("new-name");
    expect(b.getRatifications(rule.conceptId)[0]!.circle).toBe("new-name");

    // Only the locality moved — every act field is untouched by the rename round trip.
    const landed = b.getLifecycleEdges(rule.conceptId, { direction: "out" })[0]!;
    const origin = a.getLifecycleEdges(rule.conceptId, { direction: "out" })[0]!;
    expect(landed).toMatchObject({
      id: origin.id, family: origin.family, src_concept_id: origin.src_concept_id,
      dst_concept_id: origin.dst_concept_id, born_of: origin.born_of, created_at: origin.created_at,
    });
  });

  it("refuses a payload from a protocol version newer than this build understands", async () => {
    // Before the ceiling every version test was `>= v8` with no upper bound, so a payload claiming
    // ANY version was treated as v8 — a sender carrying tables this build had never heard of would
    // have its rows silently dropped while its cursor advanced past them, losing them for good.
    const src = core();
    const dst = core();
    const a = await src.store("A rule.");
    const b = await src.store("Another rule.");
    src.addLifecycleEdge({ family: "derivation", srcConceptId: a.conceptId, dstConceptId: b.conceptId, bornOf: "extraction" });
    const payload = src.exportDelta(0);
    expect(payload.schemaVersion).toBeGreaterThan(8); // the lifecycle tables bumped the protocol

    const fromTheFuture = { ...payload, schemaVersion: payload.schemaVersion! + 1 };
    expect(() => dst.graftRows(fromTheFuture))
      .toThrow(/cannot apply a payload at protocol version .*this build understands up to/);
    // Rejected, NOT silently dropped: nothing landed at all.
    expect((raw(dst).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges`).get() as { n: number }).n).toBe(0);
    // The current version still applies normally.
    expect(dst.graftRows(payload).inserted.lifecycle_edges).toBe(1);
  });

  it("ratchets the local clock past imported acts so causal ordering survives a fast peer", async () => {
    // created_at is read CAUSALLY here (newest-first ordering answers "which verdict came last"),
    // unlike memory_edge's timestamps. A peer whose clock ran ahead would otherwise leave every
    // subsequent LOCAL act stamped below the imported ones and sorting as older.
    const fast = core({ syncDeviceId: "machine-fast" });
    const slow = core({ syncDeviceId: "machine-slow" });
    const subject = await slow.store("The principle under review.");

    // Manufacture a payload whose act is stamped far in the future relative to the slow store.
    const localClock = (raw(slow).prepare(`SELECT last_mutation_at AS t FROM sync_meta WHERE singleton = 1`)
      .get() as { t: number }).t;
    const future = localClock + 5_000_000;
    const carrier = fast.exportDelta(0);
    const imported = {
      id: "peer-ratification-1", subject_concept_id: subject.conceptId, verdict: "approve",
      packet: null, ratified_by: "peer", circle: "default",
      created_at: future, sync_updated_at: future,
    };
    slow.graftRows({ ...carrier, concepts: [], observations: [], ratifications: [imported] });
    expect(slow.getRatifications(subject.conceptId)).toHaveLength(1);

    // A LOCAL verdict recorded afterwards is causally later and must sort first.
    const local = slow.recordRatification({ subjectConceptId: subject.conceptId, verdict: "retire" });
    expect(local.created_at).toBeGreaterThan(future);
    expect(slow.getRatifications(subject.conceptId).map((r) => r.id)).toEqual([local.id, "peer-ratification-1"]);
  });

  it("refuses grafted rows naming a locally-resolvable workstream or connector-owned endpoint", async () => {
    // The backdoor guard covers source-owned ids; a workstream slipped through. Where the endpoint
    // IS locally resolvable it must pass the same predicate the local write path applies.
    const dst = core();
    const src = core();
    const a = await src.store("A rule.");
    const b = await src.store("Another rule.");
    src.addLifecycleEdge({ family: "derivation", srcConceptId: a.conceptId, dstConceptId: b.conceptId, bornOf: "extraction" });
    const base = src.exportDelta(0);
    const good = base.lifecycleEdges![0]!;

    const workstream = await dst.saveWorkstream({ status: "active", openQuestions: [], nextSteps: ["ship"] });
    expect(() => dst.graftRows({ ...base, lifecycleEdges: [{ ...good, dst_concept_id: workstream.id }] }))
      .toThrow(/destination concept '.*' is a workstream .* derived cache/);
    expect(() => dst.graftRows({ ...base, lifecycleEdges: [{ ...good, src_concept_id: workstream.id }] }))
      .toThrow(/source concept '.*' is a workstream/);
    expect(() => dst.graftRows({ ...base, ratifications: [{
      id: "r1", subject_concept_id: workstream.id, verdict: "approve", packet: null,
      ratified_by: null, circle: "default", created_at: 1, sync_updated_at: 1,
    }] })).toThrow(/subject concept '.*' is a workstream/);
    expect((raw(dst).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges`).get() as { n: number }).n).toBe(0);

    // An endpoint this store cannot resolve still travels — F2 is unchanged by the new guard.
    // (`edges` is cleared because memory_edge has its OWN, stricter endpoint-resolution preflight;
    // this assertion is about the lifecycle guard, not that one.)
    const relayed = dst.graftRows({ ...base, edges: [], edgeComponents: [],
      lifecycleEdges: [{ ...good, id: "dangling-1", src_concept_id: "never-seen-here" }] });
    expect(relayed.inserted.lifecycle_edges).toBe(1);
    expect(dst.lifecycleEdgeIntegrity().dangling.map((d) => d.id)).toEqual(["dangling-1"]);
  });

  it("skips grafted supersession rows that would close a cycle, landing only the acyclic prefix", async () => {
    // The local walk guards addLifecycleEdge, but the graft loop inserts raw rows: an incoming B→A
    // could land beside a local A→B, or one payload could carry a whole ring.
    const local = core({ syncDeviceId: "machine-a" });
    const a = await storeRule(local, "Rule A.", "graft cycle rule");
    const b = await storeRule(local, "Rule B.", "graft cycle rule");
    const d = await storeRule(local, "Rule C.", "graft cycle rule C");
    const mine = local.addLifecycleEdge({
      family: "supersession", srcConceptId: a.conceptId, dstConceptId: b.conceptId, bornOf: "correction",
    });
    const base = local.exportDelta(0);
    const template = base.lifecycleEdges![0]!;
    const edge = (id: string, src: string, dst: string) =>
      ({ ...template, id, src_concept_id: src, dst_concept_id: dst, family: "supersession" });

    // Case 1: a grafted B→A against a local A→B is skipped; the local edge stands.
    const r1 = local.graftRows({ ...base, lifecycleEdges: [edge("peer-BA", b.conceptId, a.conceptId)] });
    expect(r1.skipped.lifecycle_edges).toBe(1);
    expect(r1.inserted.lifecycle_edges).toBe(0);
    expect(local.getLifecycleEdges(a.conceptId, { direction: "out", family: "supersession" }).map((e) => e.id))
      .toEqual([mine.id]);

    // Case 2: one payload carrying a whole 3-ring lands only its acyclic prefix, in payload order.
    const fresh = core({ syncDeviceId: "machine-b" });
    fresh.graftRows({ ...base, lifecycleEdges: [] }); // concepts only
    const ring = fresh.graftRows({ ...base, lifecycleEdges: [
      edge("ring-1", a.conceptId, b.conceptId),
      edge("ring-2", b.conceptId, d.conceptId),
      edge("ring-3", d.conceptId, a.conceptId), // closes the ring — refused
    ] });
    expect(ring.inserted.lifecycle_edges).toBe(2);
    expect(ring.skipped.lifecycle_edges).toBe(1);
    expect(fresh.getLifecycleEdges(d.conceptId, { direction: "out", family: "supersession" })).toEqual([]);
    expect(fresh.walkDerivation(a.conceptId, "out")).toEqual([]); // untouched family

    // Case 3: a legal chain still lands in full.
    const chain = core({ syncDeviceId: "machine-c" });
    chain.graftRows({ ...base, lifecycleEdges: [] });
    const ok = chain.graftRows({ ...base, lifecycleEdges: [
      edge("chain-1", a.conceptId, b.conceptId),
      edge("chain-2", b.conceptId, d.conceptId),
    ] });
    expect(ok.inserted.lifecycle_edges).toBe(2);
    expect(ok.skipped.lifecycle_edges).toBe(0);
  });

  it("lands ratifications before the edges that cite them within one payload", async () => {
    // Graft is deliberately structural and checks no existence today, but a payload legitimately
    // carries a ratification-born edge beside its ratification. Ordering follows the reference
    // direction so a future graft-side check cannot reject a self-consistent payload.
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const p = await src.store("A principle.");
    const r = await src.store("A rule it governs.");
    const ratification = src.recordRatification({ subjectConceptId: p.conceptId, verdict: "approve" });
    const edge = src.addLifecycleEdge({
      family: "derivation", srcConceptId: p.conceptId, dstConceptId: r.conceptId,
      bornOf: "ratification", eventRef: ratification.id,
    });

    const order: string[] = [];
    const realPrepare = raw(dst).prepare.bind(raw(dst));
    (raw(dst) as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes("INSERT INTO ratifications")) order.push("ratifications");
      if (sql.includes("INSERT INTO lifecycle_edges")) order.push("lifecycle_edges");
      return realPrepare(sql);
    };
    const result = dst.graftRows(src.exportDelta(0));
    (raw(dst) as unknown as { prepare: unknown }).prepare = realPrepare;

    expect(result.inserted).toMatchObject({ lifecycle_edges: 1, ratifications: 1 });
    expect(order).toEqual(["ratifications", "lifecycle_edges"]);
    // The pair is self-consistent on the receiver: the edge's warrant resolves.
    const landed = dst.getLifecycleEdges(p.conceptId, { direction: "out" })[0]!;
    expect(landed.id).toBe(edge.id);
    expect(dst.getRatifications(p.conceptId).map((x) => x.id)).toContain(landed.event_ref);
  });

  it("refuses a malformed or source-targeting normative payload", async () => {
    const dst = core();
    const src = core();
    const a = await src.store("A rule.");
    const b = await src.store("Another rule.");
    src.addLifecycleEdge({ family: "derivation", srcConceptId: a.conceptId, dstConceptId: b.conceptId, bornOf: "extraction" });
    const base = src.exportDelta(0);
    const good = base.lifecycleEdges![0]!;
    const bad = (over: Partial<GraftPayload["lifecycleEdges"] extends (infer T)[] | undefined ? T : never>): GraftPayload =>
      ({ ...base, lifecycleEdges: [{ ...good, ...over }] });

    expect(() => dst.graftRows(bad({ family: "governs" }))).toThrow(/unknown family 'governs'/);
    expect(() => dst.graftRows(bad({ born_of: "vibes" }))).toThrow(/unknown born_of 'vibes'/);
    expect(() => dst.graftRows(bad({ dst_span: SPAN }))).toThrow(/destination shape its family 'derivation' forbids/);
    expect(() => dst.graftRows(bad({ family: "provenance", dst_concept_id: null, dst_span: "not-a-span" })))
      .toThrow(/not a span:\/\/ URI/);
    expect(() => dst.graftRows(bad({ dst_concept_id: good.src_concept_id }))).toThrow(/points a concept at itself/);
    expect(() => dst.graftRows(bad({ born_of: "ratification", event_ref: null })))
      .toThrow(/ratification-born without an event_ref/);
    expect(() => dst.graftRows({ ...base, ratifications: [{
      id: "r1", subject_concept_id: good.src_concept_id, verdict: "maybe", packet: null,
      ratified_by: null, circle: "default", created_at: 1, sync_updated_at: 1,
    }] })).toThrow(/unknown verdict 'maybe'/);

    // Nothing landed: every rejection happened before the transaction wrote a row.
    expect((raw(dst).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges`).get() as { n: number }).n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------
describe("dangling lifecycle edge sweep", () => {
  it("stays quiet on a healthy store and flags a manufactured orphan", async () => {
    const c = core();
    const principle = await c.store("A principle with real members.");
    const rule = await c.store("A rule it derives.");
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle.conceptId, dstConceptId: rule.conceptId, bornOf: "extraction" });
    c.addLifecycleEdge({ family: "provenance", srcConceptId: rule.conceptId, dstSpan: SPAN, bornOf: "correction", eventRef: "obs-1" });
    c.recordRatification({ subjectConceptId: principle.conceptId, verdict: "approve" });

    const clean = c.lifecycleEdgeIntegrity();
    expect(clean).toMatchObject({ tablesPresent: true, edgesChecked: 2, ratificationsChecked: 1 });
    expect(clean.dangling).toEqual([]);
    expect(clean.danglingRatifications).toEqual([]);

    // Manufacture the one orphan class that remains reachable: the concept row goes away
    // (a full-consolidation detach deletes the source outright) while the normative rows persist.
    raw(c).prepare(`DELETE FROM concepts WHERE id = ?`).run(rule.conceptId);

    const swept = c.lifecycleEdgeIntegrity();
    expect(swept.edgesChecked).toBe(2);
    expect(swept.dangling).toHaveLength(2);
    expect(swept.dangling.find((d) => d.family === "derivation")).toMatchObject({
      missing: ["dst"], srcConceptId: principle.conceptId, dstConceptId: rule.conceptId, circle: "default",
    });
    // A provenance edge addresses a span, so its null destination is never reported as missing.
    expect(swept.dangling.find((d) => d.family === "provenance")).toMatchObject({ missing: ["src"], dstConceptId: null });
    expect(swept.danglingRatifications).toEqual([]);

    raw(c).prepare(`DELETE FROM concepts WHERE id = ?`).run(principle.conceptId);
    const both = c.lifecycleEdgeIntegrity();
    expect(both.dangling.find((d) => d.family === "derivation")!.missing).toEqual(["src", "dst"]);
    expect(both.danglingRatifications).toHaveLength(1);
    expect(both.danglingRatifications[0]).toMatchObject({ subjectConceptId: principle.conceptId, circle: "default" });

    // Report-only: the sweep never repairs.
    expect((raw(c).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges`).get() as { n: number }).n).toBe(2);
  });

  it("REFUSES a MERGING reassignCircle that would strand normative record (was: flagged it afterwards)", async () => {
    // SUPERSEDES THIS TEST'S ORIGINAL ASSERTION (skeleton-entrances slice, review round 1, item 4).
    // It used to pin the merge SUCCEEDING and the rows being flagged as stranded afterwards, and its
    // own comment named that "the shape slice 5 has to decide repair for". Slice 5 decided: refuse,
    // do not re-home. hardDeleteNativeConcept's chokepoint now fires here, so this ordinary public
    // operation can no longer silently destroy the endpoint of an append-only normative row.
    //
    // Reachable only through the ENGINE API on a non-normative kind: reassignCircle already refuses
    // to auto-merge rule/principle/preference, and no MCP surface can ratify a fact — memory_ratify
    // requires kind principle|preference. The sweep's own coverage for genuinely stranded rows
    // (rows written by a build that predates this guard) is the test immediately below.
    const c = new MonetCore(":memory:"); // default thresholds so the merge branch is reachable
    const text = "Branch before committing, always, without exception.";
    const doomed = await c.store(text, { circle: "default" });
    const survivor = await c.store(text, { circle: "work" });
    expect(doomed.conceptId).not.toBe(survivor.conceptId);

    const successor = await c.store("A quite different concept it derives.", { circle: "default" });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: doomed.conceptId, dstConceptId: successor.conceptId, bornOf: "extraction" });
    c.addLifecycleEdge({ family: "provenance", srcConceptId: doomed.conceptId, dstSpan: SPAN, bornOf: "correction", eventRef: "obs-1" });
    c.recordRatification({ subjectConceptId: doomed.conceptId, verdict: "approve" });

    expect(() => c.reassignCircle(doomed.conceptId, "work"))
      .toThrow(/cannot hard delete concept .*: it carries 1 ratification\(s\) and 2 lifecycle edge\(s\)/);

    // ROLLED BACK WHOLE: the concept, its evidence and its normative rows are all exactly as before.
    expect(raw(c).prepare(`SELECT 1 FROM concepts WHERE id = ?`).get(doomed.conceptId)).toBeTruthy();
    expect(raw(c).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(doomed.conceptId))
      .toMatchObject({ circle: "default" });
    expect(c.getLifecycleEdges(doomed.conceptId, { direction: "both" })).toHaveLength(2);
    expect(c.getRatifications(doomed.conceptId)).toHaveLength(1);
    // Nothing was tombstoned either — a refused delete is not a delete.
    expect((raw(c).prepare(`SELECT concept_id FROM concept_deletions`).all() as Array<{ concept_id: string }>)
      .map((r) => r.concept_id)).not.toContain(doomed.conceptId);
    c.close();
  });

  it("flags — and still exports — rows stranded by a build that predates the chokepoint", async () => {
    // The sweep's own regression, preserved from the test above after the guard closed the public
    // path that used to produce this state. A store written by an older build can still HOLD it, so
    // the report-only sweep and the relay behaviour both still have to work; the state is therefore
    // constructed the way such a store would already contain it — the concept row gone, its
    // tombstone recorded, the append-only normative rows left behind.
    const c = core();
    const doomed = await storeRule(c, "A rule that a pre-chokepoint build consolidated away.", "stranded rule");
    const successor = await storeRule(c, "A quite different rule that supersedes it.", "stranded rule");
    c.addLifecycleEdge({ family: "supersession", srcConceptId: doomed.conceptId, dstConceptId: successor.conceptId, bornOf: "correction" });
    c.addLifecycleEdge({ family: "provenance", srcConceptId: doomed.conceptId, dstSpan: SPAN, bornOf: "correction", eventRef: "obs-1" });
    c.recordRatification({ subjectConceptId: doomed.conceptId, verdict: "approve" });

    raw(c).prepare(`DELETE FROM concepts WHERE id = ?`).run(doomed.conceptId);
    raw(c).prepare(
      `INSERT INTO concept_deletions (concept_id, deleted_at, updated_at, writer_id, concept_kind)
       VALUES (?, 1, 1, 'older-build', 'native')`,
    ).run(doomed.conceptId);

    // The normative rows survive the deletion (graph maintenance never touches them) and are now
    // genuinely stranded.
    expect(c.getLifecycleEdges(doomed.conceptId, { direction: "both" })).toHaveLength(2);
    expect(c.getRatifications(doomed.conceptId)).toHaveLength(1);

    const sweep = c.lifecycleEdgeIntegrity();
    expect(sweep.dangling.map((d) => d.family).sort()).toEqual(["provenance", "supersession"]);
    for (const row of sweep.dangling) expect(row.missing).toEqual(["src"]);
    expect(sweep.danglingRatifications).toHaveLength(1);
    expect(sweep.danglingRatifications[0]).toMatchObject({ subjectConceptId: doomed.conceptId });

    // Report-only: nothing was repaired or removed.
    expect(c.getLifecycleEdges(doomed.conceptId, { direction: "both" })).toHaveLength(2);

    // AND THEY STILL EXPORT. This follows necessarily from the relay rule above (the export joins
    // both endpoints LEFT so a dangling row can travel), and it is the right default even here:
    // distinguishing "endpoint absent because hard-deleted" from "endpoint absent because retired
    // or not yet synced" is precisely the merge re-homing question still deferred, and silently
    // withholding the record would destroy the evidence a later slice needs to decide with. The
    // peer is not left guessing — the hard deletion travels beside it in concept_deletions, so a
    // receiving store has both facts and can apply whatever repair that slice settles on.
    const payload = c.exportDelta(0);
    expect(payload.lifecycleEdges).toHaveLength(2);
    expect(payload.ratifications).toHaveLength(1);
    expect((raw(c).prepare(`SELECT concept_id FROM concept_deletions`).all() as Array<{ concept_id: string }>)
      .map((r) => r.concept_id)).toContain(doomed.conceptId);
    c.close();
  });

  // -------------------------------------------------------------------------
  // F4 GUARDS (skeleton-entrances slice, item 6): the SAME data-loss shape the test just above
  // demonstrates for reassignCircle's merge — but through memory_detach's own full-consolidation
  // path, which this slice actually closes (a refusal, not the deliberately-unbuilt re-homing).
  // -------------------------------------------------------------------------
  describe("F4 — detach's full-consolidation guard against stranding normative record", () => {
    it("refuses to consolidate away a concept carrying ratifications", async () => {
      const c = core();
      const doomed = await c.store("A principle about to be wrongly consolidated.", { kind: "principle" });
      const survivor = await c.store("A similar principle, the merge target.", { kind: "principle" });
      await c.ratify({ candidateId: doomed.conceptId, verdict: "approve" });

      await expect(
        c.detach(doomed.conceptId, [doomed.observationId], { destConceptId: survivor.conceptId }),
      ).rejects.toThrow(/it carries 1 ratification\(s\), which this hard delete would strand.*Retire it via memory_ratify/);

      // Refused BEFORE any mutation — the concept and its ratification are both still there.
      expect(c.getRatifications(doomed.conceptId)).toHaveLength(1);
      expect(raw(c).prepare(`SELECT 1 FROM concepts WHERE id = ?`).get(doomed.conceptId)).toBeTruthy();
      c.close();
    });

    it("refuses to consolidate away a concept with a lifecycle edge attached, at EITHER endpoint", async () => {
      const c = core();
      const principle = await c.store("A principle with a member rule.", { kind: "principle" });
      const rule = await c.store("Its member rule — about to be wrongly consolidated.");
      const otherRule = await c.store("A different rule, the merge target.");
      c.addLifecycleEdge({ family: "derivation", srcConceptId: principle.conceptId, dstConceptId: rule.conceptId, bornOf: "extraction" });

      // As the SOURCE (src_concept_id) of the edge.
      await expect(
        c.detach(principle.conceptId, [principle.observationId], { destConceptId: otherRule.conceptId }),
      ).rejects.toThrow(/1 lifecycle edge\(s\).*would strand/);

      // As the DESTINATION (dst_concept_id) of the SAME edge.
      const anotherPrinciple = await c.store("Another principle, a merge target for the rule.", { kind: "principle" });
      await expect(
        c.detach(rule.conceptId, [rule.observationId], { destConceptId: anotherPrinciple.conceptId }),
      ).rejects.toThrow(/1 lifecycle edge\(s\).*would strand/);

      // Refused before any mutation on either attempt.
      expect(c.walkDerivation(principle.conceptId, "out")).toEqual([rule.conceptId]);
      c.close();
    });

    it("does NOT refuse an ordinary consolidation with no normative record attached — the guard is scoped, not a blanket ban", async () => {
      const c = core();
      const plain = await c.store("An ordinary fact with nothing attached.");
      const dest = await c.store("Its consolidation target.");
      await expect(
        c.detach(plain.conceptId, [plain.observationId], { destConceptId: dest.conceptId }),
      ).resolves.toMatchObject({ sourceDeleted: true, destAction: "attached" });
      c.close();
    });

    it("the chokepoint fires for a caller that never learned to ask — a peer's tombstone is SKIPPED, not thrown", async () => {
      // The relayed half of the chokepoint's posture (review round 1, item 4), mirroring the deny
      // guard's exactly: hardDeleteNativeConcept refuses on BOTH paths, and the graft deletion loop
      // keeps that unreachable by pre-checking and counting the skip — a throw there would abort a
      // whole graft over one row.
      const a = core({ syncDeviceId: "machine-a" });
      const b = core({ syncDeviceId: "machine-b" });
      const shared = await a.store("A concept both machines hold.");
      const other = await a.store("Another concept.");
      b.graftRows(a.exportDelta(0));

      // B ratifies it locally; A deletes it and relays the tombstone. (A itself is free to: its own
      // copy carries no normative record — the ratification below is B's alone.)
      b.recordRatification({ subjectConceptId: shared.conceptId, verdict: "approve" });
      await a.detach(shared.conceptId, [shared.observationId], { destConceptId: other.conceptId });

      // The graft SUCCEEDS as a whole — the deletion row lands, the local concept survives with the
      // record that names it, and nothing throws.
      const result = b.graftRows(a.exportDelta(0));
      expect(result).toBeTruthy();
      expect(raw(b).prepare(`SELECT 1 FROM concepts WHERE id = ?`).get(shared.conceptId)).toBeTruthy();
      expect(b.getRatifications(shared.conceptId)).toHaveLength(1);
      // The peer's tombstone is still on file, so a later re-homing slice has both facts.
      expect(raw(b).prepare(`SELECT 1 FROM concept_deletions WHERE concept_id = ?`).get(shared.conceptId)).toBeTruthy();
      a.close();
      b.close();
    });
  });

  it("renames a circle held open by nothing but normative rows", async () => {
    // Normative rows outlive their concepts' PRESENCE IN A CIRCLE by design — an edge records the
    // circle its act happened in and append-only forbids rewriting it, so an ordinary move leaves
    // the row behind (see "keeps the edge's circle at its birth value across a concept move").
    // Counting only concepts made "circle not found" fire for exactly the rows the rename-follows
    // path exists to move.
    const c = new MonetCore(":memory:");
    const text = "Branch before committing, always, without exception.";
    const doomed = await storeRule(c, text, "orphan circle rule", "orphan-circle");
    await c.store(text, { circle: "elsewhere" });
    const succ = await storeRule(c, "A different rule.", "orphan circle rule", "orphan-circle");
    c.addLifecycleEdge({ family: "supersession", srcConceptId: doomed.conceptId, dstConceptId: succ.conceptId, bornOf: "correction" });
    c.recordRatification({ subjectConceptId: doomed.conceptId, verdict: "approve" });

    // Empty the circle of concepts: MOVE both out. `forceNew` on the first is load-bearing as of
    // the chokepoint (review round 1, item 4) — an auto-merge here would hard-delete a concept
    // carrying normative record, which is now refused outright. The rows this test is about are
    // left behind by the move exactly as they were by the merge, so its subject is unchanged.
    expect(c.reassignCircle(doomed.conceptId, "elsewhere", { resolution: "forceNew" })).toMatchObject({ action: "moved" });
    c.reassignCircle(succ.conceptId, "elsewhere");
    expect((raw(c).prepare(`SELECT COUNT(*) AS n FROM concepts WHERE circle = 'orphan-circle'`).get() as { n: number }).n).toBe(0);
    // ...but the normative rows are still there, holding the circle open.
    expect((raw(c).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges WHERE circle = 'orphan-circle'`).get() as { n: number }).n).toBe(1);

    expect(() => c.renameCircle("orphan-circle", "renamed-circle")).not.toThrow();
    expect(c.getLifecycleEdges(doomed.conceptId, { direction: "both" })[0]!.circle).toBe("renamed-circle");
    expect(c.getRatifications(doomed.conceptId)[0]!.circle).toBe("renamed-circle");
    expect((raw(c).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges WHERE circle = 'orphan-circle'`).get() as { n: number }).n).toBe(0);
  });

  it("reports cleanly against a store that predates the tables", () => {
    const c = core();
    raw(c).prepare(`DROP TABLE lifecycle_edges`).run();
    expect(inspectLifecycleEdgeIntegrity(raw(c))).toEqual({
      tablesPresent: false, edgesChecked: 0, ratificationsChecked: 0, dangling: [], danglingRatifications: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Codex PR #102 round — verdict recording, actor default, retired candidates,
// and normative locality under circle moves
// ---------------------------------------------------------------------------

describe("ratify() and reassignCircle() — Codex PR #102 fixes", () => {
  it("reject and retire record even with a stale or invalid memberRuleIds list — only entry verdicts validate members", async () => {
    const c = core();
    const principle = await c.store("A principle judged on stale evidence.", { kind: "principle" });
    const fact = await c.store("Not a rule at all.");

    // The public contract says memberRuleIds is IGNORED for reject/retire — a bad list must never
    // block recording the ruling itself.
    const rejected = await c.ratify({
      candidateId: principle.conceptId, verdict: "reject",
      memberRuleIds: [fact.conceptId, "ghost-id"],
    });
    expect(rejected.verdict).toBe("reject");
    expect(rejected.edgeIds).toHaveLength(0);
    expect(c.getRatifications(principle.conceptId)).toHaveLength(1);

    // The same list on an ENTRY verdict still refuses, before anything is written.
    await expect(
      c.ratify({ candidateId: principle.conceptId, verdict: "approve", memberRuleIds: [fact.conceptId] }),
    ).rejects.toThrow(/is kind 'fact', not 'rule'/);
    expect(c.getRatifications(principle.conceptId)).toHaveLength(1);
    c.close();
  });

  it("ratifiedBy defaults to the calling agent, matching the declaration entrance", async () => {
    const c = core();
    const principle = await c.store("A principle ratified without naming the actor.", { kind: "principle" });
    await c.ratify({ candidateId: principle.conceptId, verdict: "approve" });
    const rows = c.getRatifications(principle.conceptId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ratified_by).toBe("local-agent");
    const entry = c.skeleton().find((e) => e.conceptId === principle.conceptId);
    expect(entry?.ratifiedBy).toBe("local-agent");
    c.close();
  });

  it("memberRuleIds is principle-only: a preference ratifies, but never as a parent of rules", async () => {
    const c = core();
    const preference = await c.store("Write as a peer, never assistant scaffolding.", { kind: "preference" });
    const rule = await c.store("A rule someone tried to hang on it.", { kind: "rule", rule: { stage: "gate p", scope: "domain" } });

    await expect(
      c.ratify({ candidateId: preference.conceptId, verdict: "approve", memberRuleIds: [rule.conceptId] }),
    ).rejects.toThrow(/memberRuleIds is principle-only/);
    expect(c.getRatifications(preference.conceptId)).toHaveLength(0);

    // Without the evidence list the preference enters the skeleton normally.
    const r = await c.ratify({ candidateId: preference.conceptId, verdict: "approve" });
    expect(r.edgeIds).toHaveLength(0);
    expect(c.skeleton().some((e) => e.conceptId === preference.conceptId)).toBe(true);
    c.close();
  });

  it("clamps a command-shaped advisory's tool name so the fixed advisory field stays bounded", async () => {
    const c = core();
    const d = await c.declare({
      species: "principle",
      content: `${"x".repeat(50_000)}: do the thing`,
      exitsEvidence: "a counterexample",
    });
    if (d.species !== "principle") throw new Error("expected the principle declare variant");
    const shaped = d.advisories.find((a) => a.kind === "stage_shaped");
    expect(shaped).toBeDefined();
    expect(shaped!.message.length).toBeLessThan(400);
    c.close();
  });

  it("a duplicated member id mints exactly one derivation edge; a disputed candidate refuses entry verdicts until mediation", async () => {
    const c = core();
    const principle = await c.store("A principle with a doubled member.", { kind: "principle" });
    const rule = await c.store("The one member.", { kind: "rule", rule: { stage: "gate d", scope: "domain" } });
    const r = await c.ratify({
      candidateId: principle.conceptId, verdict: "approve",
      memberRuleIds: [rule.conceptId, rule.conceptId, rule.conceptId],
    });
    expect(r.edgeIds).toHaveLength(1);
    expect(c.walkDerivation(principle.conceptId, "out")).toHaveLength(1);

    const flagged = c.flagContradiction(principle.conceptId, { detail: "contested" });
    await expect(c.ratify({ candidateId: principle.conceptId, verdict: "re-ratify" }))
      .rejects.toThrow(/is disputed: an open contradiction contests it/);
    c.resolveContradiction(flagged.id, { decision: "dismiss" });
    const back = await c.ratify({ candidateId: principle.conceptId, verdict: "re-ratify" });
    expect(back.verdict).toBe("re-ratify");
    expect(c.skeleton().some((e) => e.conceptId === principle.conceptId)).toBe(true);
    c.close();
  });

  it("a momentless declaration refuses an instance, like stage and patterns", async () => {
    const c = core();
    await expect(
      c.declare({ species: "principle", content: "A principle.", instance: "Bash:git push --force" }),
    ).rejects.toThrow(/carries no instance/);
    c.close();
  });

  it("a disputed principle stops governing immediately; mediation restores membership", async () => {
    const c = core();
    const p = await c.store("Contested wisdom.", { kind: "principle" });
    await c.ratify({ candidateId: p.conceptId, verdict: "approve" });
    expect(c.skeleton().some((e) => e.conceptId === p.conceptId)).toBe(true);

    const flagged = c.flagContradiction(p.conceptId, { detail: "reality disagrees" });
    expect(c.skeleton().some((e) => e.conceptId === p.conceptId)).toBe(false);

    c.resolveContradiction(flagged.id, { decision: "dismiss" });
    expect(c.skeleton().some((e) => e.conceptId === p.conceptId)).toBe(true);
    c.close();
  });

  it("an entry verdict cannot resurrect a retired candidate; retire itself still records", async () => {
    const c = core();
    const principle = await c.store("A principle that later retires.", { kind: "principle" });
    await c.ratify({ candidateId: principle.conceptId, verdict: "approve" });
    c.retireConcept(principle.conceptId);
    expect(c.skeleton().find((e) => e.conceptId === principle.conceptId)).toBeUndefined();

    await expect(c.ratify({ candidateId: principle.conceptId, verdict: "approve" }))
      .rejects.toThrow(/is retired: an entry verdict cannot resurrect it/);
    await expect(c.ratify({ candidateId: principle.conceptId, verdict: "re-ratify" }))
      .rejects.toThrow(/is retired/);
    // A non-entry verdict on a retired concept is a legitimate durable ruling.
    const retired = await c.ratify({ candidateId: principle.conceptId, verdict: "retire" });
    expect(retired.verdict).toBe("retire");
    c.close();
  });

  it("a moved principle's membership follows the CONCEPT while the ratification keeps its birth circle — the decided consumer contract", async () => {
    // This is the deliberate decision the birth-value pin above demanded ("the slice that gives
    // `circle` a consumer has to decide deliberately rather than inherit silently"): skeleton()
    // became that consumer's neighbour in 5-A, and it reads the CONCEPT's circle, never the row's.
    // So delivery follows a move; the append-only record stays where the act happened; and a
    // ratified derivation surviving a move (members filed elsewhere) is the same cross-circle
    // membership question ratify() already defers, dated 2026-07-29, to the materialization slice.
    const c = core();
    const d = await c.declare({ species: "principle", content: "Name what would prove you wrong." });
    if (d.species !== "principle") throw new Error("expected the principle declare variant");
    const id = d.conceptId;
    expect(c.skeleton().some((e) => e.conceptId === id)).toBe(true);

    const moved = c.reassignCircle(id, "work");
    expect(moved!.action).toBe("moved");
    expect(c.skeleton().some((e) => e.conceptId === id)).toBe(false);
    expect(c.skeleton("work").some((e) => e.conceptId === id)).toBe(true);
    // Birth locality, per the substrate's pinned doctrine — only a circle RENAME rewrites it.
    const rows = c.getRatifications(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.circle).toBe("default");

    // And a ratified derivation does not block the move in either direction: the relationship is
    // read by concept id, circle-blind, so it survives intact.
    const principle = await c.store("A principle with one member.", { kind: "principle", circle: "work" });
    const rule = await c.store("The member rule.", { kind: "rule", circle: "work", rule: { stage: "gate m", scope: "domain" } });
    await c.ratify({ candidateId: principle.conceptId, verdict: "approve", memberRuleIds: [rule.conceptId], circle: "work" });
    expect(c.reassignCircle(principle.conceptId, "elsewhere")!.action).toBe("moved");
    expect(c.skeleton("elsewhere").some((e) => e.conceptId === principle.conceptId)).toBe(true);
    expect(c.walkDerivation(principle.conceptId, "out")).toHaveLength(1);
    c.close();
  });
});
