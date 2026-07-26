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
    const a = await c.store("Rule A: always branch before committing.");
    const b = await c.store("Rule B: branch, then commit, then push.");
    const d = await c.store("Rule D: a third, unrelated rule.");
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
    const a = await c.store("Rule A, the original.");
    const b = await c.store("Rule B, its successor.");
    const d = await c.store("Rule C, the successor's successor.");
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
    const a = await c.store("Rule A.");
    const b = await c.store("Rule B.");
    const d = await c.store("Rule C.");
    const e = await c.store("Rule D.");
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
    const rule1 = await c.store("Rule one under that principle.");
    const rule2 = await c.store("Rule two under that principle.");
    const successor = await c.store("The rule that replaces rule one.");

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
// THE regression: graph maintenance cannot touch normative record
// ---------------------------------------------------------------------------
describe("wipe immunity", () => {
  it("survives every graph-maintenance operation that wipes memory_edge", async () => {
    const c = core();
    // Related concepts stored in one (implicit) session, so the similarity graph really does carry
    // `related`/`co_occurred` edges for the operations below to destroy.
    const principle = await c.store("Encode principles, not procedures, when writing rules.");
    const rule = await c.store("Encode principles, not procedures, in the rule capture path.");
    const successor = await c.store("Encode principles, not procedures — revised wording.");
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
    const a = await c.store("A rule that will move house.");
    const b = await c.store("The rule that replaces it.");
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
    const a = await c.store("A rule in a circle about to be renamed.", { circle: "old-name" });
    const b = await c.store("Its successor, same circle.", { circle: "old-name" });
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
  it("carries both tables across export → graft, and dedupes on a replay", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const principle = await src.store("Encode principles, not procedures.");
    const rule = await src.store("A rule derived from that principle.");
    const successor = await src.store("The rule that supersedes it.");
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
    const a = await local.store("The rule everyone is trying to replace.");
    const b = await local.store("Successor chosen on this machine.");
    const peerChoice = await local.store("Successor chosen on the other machine.");
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

    const rule = await a.store("The rule that will be retired on machine A.");
    const successor = await a.store("Its successor, which stays active.");
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
    const rule = await a.store("A rule in a circle about to be renamed.", { circle: "old-name" });
    const succ = await a.store("Its successor.", { circle: "old-name" });
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
    const a = await local.store("Rule A.");
    const b = await local.store("Rule B.");
    const d = await local.store("Rule C.");
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

  it("flags rows stranded by a MERGING reassignCircle, which hard-deletes the source concept", async () => {
    // The one orphan class reachable through an ordinary public operation, and therefore the shape
    // slice 5 has to decide repair for (F4 — merge re-homing semantics — is explicitly NOT decided
    // here). A merging reassignCircle folds the source into the target and hard-deletes the source
    // row; every normative row naming the dead id is stranded, because append-only forbids
    // rewriting src/dst and no consumer exists yet to say whether they should be re-pointed at the
    // survivor, dropped, or kept as evidence the rule once existed.
    const c = new MonetCore(":memory:"); // default thresholds so the merge branch is reachable
    const text = "Branch before committing, always, without exception.";
    const doomed = await c.store(text, { circle: "default" });
    const survivor = await c.store(text, { circle: "work" });
    expect(doomed.conceptId).not.toBe(survivor.conceptId);

    const successor = await c.store("A quite different rule that supersedes it.", { circle: "default" });
    c.addLifecycleEdge({ family: "supersession", srcConceptId: doomed.conceptId, dstConceptId: successor.conceptId, bornOf: "correction" });
    c.addLifecycleEdge({ family: "provenance", srcConceptId: doomed.conceptId, dstSpan: SPAN, bornOf: "correction", eventRef: "obs-1" });
    c.recordRatification({ subjectConceptId: doomed.conceptId, verdict: "approve" });

    const result = c.reassignCircle(doomed.conceptId, "work");
    expect(result).toMatchObject({ action: "merged", mergedIntoId: survivor.conceptId });
    // The source concept row really is gone — this is a hard delete, not a retirement.
    expect(raw(c).prepare(`SELECT 1 FROM concepts WHERE id = ?`).get(doomed.conceptId)).toBeUndefined();

    // The normative rows survive the deletion (graph maintenance never touches them) and are now
    // genuinely stranded.
    const stranded = c.getLifecycleEdges(doomed.conceptId, { direction: "both" });
    expect(stranded).toHaveLength(2);
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
    // or not yet synced" is precisely the merge re-homing question deferred to slice 5, and
    // silently withholding the record would destroy the evidence that slice needs to decide with.
    // The peer is not left guessing — the hard deletion travels beside it in concept_deletions,
    // so a receiving store has both facts and can apply whatever repair slice 5 settles on.
    const payload = c.exportDelta(0);
    expect(payload.lifecycleEdges).toHaveLength(2);
    expect(payload.ratifications).toHaveLength(1);
    expect((raw(c).prepare(`SELECT concept_id FROM concept_deletions`).all() as Array<{ concept_id: string }>)
      .map((r) => r.concept_id)).toContain(doomed.conceptId);
  });

  it("renames a circle held open by nothing but normative rows", async () => {
    // Normative rows outlive their concepts by design (hard-delete consolidation strands them), so
    // a circle can be populated by nothing else. Counting only concepts made "circle not found"
    // fire for exactly the rows the rename-follows path exists to move.
    const c = new MonetCore(":memory:");
    const text = "Branch before committing, always, without exception.";
    const doomed = await c.store(text, { circle: "orphan-circle" });
    await c.store(text, { circle: "elsewhere" });
    const succ = await c.store("A different rule.", { circle: "orphan-circle" });
    c.addLifecycleEdge({ family: "supersession", srcConceptId: doomed.conceptId, dstConceptId: succ.conceptId, bornOf: "correction" });
    c.recordRatification({ subjectConceptId: doomed.conceptId, verdict: "approve" });

    // Empty the circle of concepts: merge one away, move the other out.
    expect(c.reassignCircle(doomed.conceptId, "elsewhere")).toMatchObject({ action: "merged" });
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
