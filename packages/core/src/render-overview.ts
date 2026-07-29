/**
 * Pure terminal renderer for the "what your agent knows" overview.
 * No DB, no I/O — takes a MemoryOverview and returns a string. The KNOWLEDGE GRAPH box is the
 * visual center of gravity: entity hubs + most-connected memories + a connection histogram are
 * the connective tissue a flat memory list structurally cannot show. Every number is a real
 * count/mean from the snapshot; empty sections are OMITTED, never stubbed.
 *
 * Color is opt-in (raw ANSI, no dependency). color:false yields byte-identical layout with zero
 * escape bytes; stripping the colored output yields exactly the plain output. Width math counts
 * VISIBLE characters, so colored substrings never break alignment and no line exceeds `width`.
 */
import type { MemoryOverview, EntityHub, ConnectedConcept, PossibleDuplicatePair } from "./engine";
import { DECIDED_RESOLUTION_MODES } from "./resolution";

interface RenderOpts {
  color?: boolean;
  width?: number;
}

/**
 * How many unexplained denies are named individually before the list is summarized. The header line
 * always carries the true total, so capping shortens the view without ever understating the
 * population — which is the one thing this disclosure must not do.
 */
const UNEXPLAINED_DENIES_SHOWN = 5;

const ESC = String.fromCharCode(27); // \x1b — built at runtime to keep raw escape bytes out of source
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const ANSI_AT = new RegExp(`^${ESC}\\[[0-9;]*m`);
const vlen = (s: string): number => s.replace(ANSI, "").length;
const padEndV = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - vlen(s)));
const padStartV = (s: string, w: number): string => " ".repeat(Math.max(0, w - vlen(s))) + s;

/** Truncate by VISIBLE width, preserving ANSI codes (so colored stripped === plain). */
const truncate = (s: string, w: number): string => {
  if (vlen(s) <= w) return s;
  let out = "";
  let vis = 0;
  let i = 0;
  while (i < s.length && vis < w - 1) {
    const m = s.slice(i).match(ANSI_AT);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    out += s[i];
    vis++;
    i++;
  }
  return out + "…";
};

const KIND_GLYPH: Record<string, string> = {
  decision: "◆",
  insight: "✦",
  issue: "⚑",
  preference: "★",
  fact: "✔",
  procedure: "▸",
  correction: "✎",
  // The two normative kinds. `principle` reads as the skeleton's own mark; `preference` already had
  // a glyph above and keeps it, since a declared preference IS the same kind this table named.
  principle: "◈",
  rule: "▸",
};
const glyph = (kind: string): string => KIND_GLYPH[kind] ?? "·";

export function renderOverview(o: MemoryOverview, opts: RenderOpts = {}): string {
  const width = opts.width ?? 84;
  const color = opts.color ?? false;
  const c = (code: string, s: string): string => (color ? `${ESC}[${code}m${s}${ESC}[0m` : s);
  const dim = (s: string): string => c("2", s);
  const bold = (s: string): string => c("1", s);
  const yellow = (s: string): string => c("33", s);
  const green = (s: string): string => c("32", s);
  const cyan = (s: string): string => c("36", s);

  const out: string[] = [];

  const box = (title: string, lines: string[], heavy: boolean): string[] => {
    const [tl, tr, bl, br, h, v] = heavy ? ["╔", "╗", "╚", "╝", "═", "║"] : ["┌", "┐", "└", "┘", "─", "│"];
    const innerW = width - 4;
    const tint = (s: string): string => (heavy ? cyan(s) : dim(s));
    const fill = Math.max(0, width - vlen(`${tl}${h} ${title} `) - 1);
    const res: string[] = [tint(`${tl}${h} `) + bold(title) + " " + tint(h.repeat(fill) + tr)];
    for (const l of lines) res.push(tint(v) + " " + padEndV(truncate(l, innerW), innerW) + " " + tint(v));
    res.push(tint(bl + h.repeat(width - 2) + br));
    return res;
  };

  const k = o.counts;
  const strap = `circle: ${o.circle} · ${k.concepts} memories · ${k.observations} observations · ${k.edges} connections · avg confidence ${Math.round(o.health.avgConfidence * 100)}% · MiniLM, no LLM`;
  out.push(...box("MONET · what your agent knows", [strap], false));
  out.push("");

  if (o.livingModel.length) {
    out.push(bold("LIVING MODEL") + dim("  — what it leans on, ranked"));
    const titleW = width - 28;
    for (const m of o.livingModel) {
      const filled = Math.round(m.confidence * 10);
      const bar = green("█".repeat(filled)) + dim("░".repeat(10 - filled));
      out.push(`  ${glyph(m.kind)} ${padEndV(truncate(m.title, titleW), titleW)} ${bar} ${m.confidence.toFixed(2).slice(1)} ${dim(`·${m.supportCount} obs`)}`);
    }
    out.push("");
  }

  if (o.activeThreads.length) {
    out.push(bold("ACTIVE THREADS") + dim("  — where you left off"));
    for (const t of o.activeThreads) {
      const slot = t.nextSteps[0]
        ? dim("→ next: ") + t.nextSteps[0]
        : t.openQuestions[0]
          ? dim("? open: ") + t.openQuestions[0]
          : "";
      out.push(truncate(`  [${t.status}] ${t.title}${slot ? "   " + slot : ""}`, width));
    }
    out.push("");
  }

  const g = o.graph;
  const graphLines: string[] = [];
  if (g.hubs.length) {
    graphLines.push(dim("entity hubs — everything it knows touches…"));
    const maxM = Math.max(...g.hubs.map((hb: EntityHub) => hb.members), 1);
    const surfW = Math.min(24, Math.max(...g.hubs.map((hb) => Math.min(hb.surface.length, 24))));
    for (const hb of g.hubs) {
      const bar = cyan("█".repeat(Math.max(1, Math.round((hb.members / maxM) * 12))));
      graphLines.push(`  ${padEndV(truncate(hb.surface, surfW), surfW)}  ${bar} ${hb.members}`);
    }
  }
  if (g.connected.length) {
    graphLines.push(dim("most connected — worked-together / causal"));
    for (const cc of g.connected as ConnectedConcept[]) {
      graphLines.push(`  ${padStartV(String(cc.degree), 2)} ${glyph(cc.kind)} ${cc.title}`);
    }
  }
  if (g.edgesByType.length) {
    const maxC = Math.max(...g.edgesByType.map((e) => e.count), 1);
    const hist = g.edgesByType
      .map((e) => `${e.type} ${cyan("█".repeat(Math.max(1, Math.round((e.count / maxC) * 6))))} ${e.count}`)
      .join(dim(" · "));
    graphLines.push(dim("connections   ") + hist);
  }
  if (g.thread) {
    graphLines.push(cyan("▸") + ` worked together: ${bold(g.thread.label)} — ${g.thread.size} memories`);
  }
  if (graphLines.length) {
    out.push(...box("KNOWLEDGE GRAPH", graphLines, true));
    out.push("");
  } else if (k.concepts > 0) {
    out.push(dim(`(knowledge graph still forming — ${k.edges} connections so far)`));
    out.push("");
  }

  if (o.openContradictions.length || k.stale > 0 || k.dirty > 0) {
    out.push(yellow(bold("⚠ NEEDS ATTENTION")));
    for (const ct of o.openContradictions) {
      out.push(truncate(`  ${yellow("⚠")} contradiction (${ct.kind})  "${ct.conceptTitle}"`, width));
      if (ct.detail) out.push(truncate(dim(`        ${ct.detail}`), width));
    }
    const bits: string[] = [];
    if (k.stale > 0) bits.push(`${k.stale} memories stale (unconfirmed >30d)`);
    if (k.dirty > 0) bits.push(`${k.dirty} awaiting synthesis`);
    if (bits.length) out.push(dim(`  · ${bits.join(" · ")}`));
    out.push("");
  } else if (k.concepts > 0) {
    out.push(green("✓") + dim(" no open contradictions · nothing stale"));
    out.push("");
  }

  // THE ALWAYS-ON SKELETON (skeleton-entrances slice, review round 1, item 5). This is the human
  // curation surface, so a JSON field on the MCP response does not discharge contract 7's "minimal
  // curation surfacing" — the same standard RESOLUTION and GATES below already hold themselves to.
  // Placed above POSSIBLE DUPLICATES because it is what GOVERNS rather than what needs mediating.
  // The header carries the true total whenever the list is capped, so a capped view shortens
  // without ever understating the population — UNEXPLAINED_DENIES_SHOWN's own discipline.
  if (o.skeleton?.length) {
    const total = k.skeleton ?? o.skeleton.length;
    const capped = total > o.skeleton.length ? dim(`  (showing ${o.skeleton.length} of ${total})`) : "";
    out.push(bold("SKELETON") + dim("  — always-on, ratified") + capped);
    for (const s of o.skeleton) {
      const who = s.ratifiedBy ? dim(` · ${s.ratifiedBy}`) : "";
      out.push(truncate(`  ${glyph(s.species)} ${s.content}${who}`, width));
    }
    out.push("");
  }

  if (o.possibleDuplicates?.length) {
    out.push(yellow(bold("POSSIBLE DUPLICATES")));
    for (const pd of o.possibleDuplicates as PossibleDuplicatePair[]) {
      const aId = dim(`[${pd.conceptAId.slice(0, 8)}]`);
      const bId = dim(`[${pd.conceptBId.slice(0, 8)}]`);
      out.push(truncate(`  · ${pd.conceptATitle} ${aId} / ${pd.conceptBTitle} ${bId}  (score: ${pd.score.toFixed(3)})`, width));
    }
    out.push("");
  }

  // HOW RESOLUTION HAS BEEN DECIDING (src/resolution.ts). The design's empirical check on "find by
  // evidence, confirm by identity" is fork rate and misfile rate "visible in curation" — and this
  // is the human curation surface, so a JSON field on the MCP response does not discharge it.
  // Compact by design: one line of mode counts plus the rate that matters, under the duplicate
  // pairs those forks produced. Suppressed entirely on a store with no decided writes yet, where
  // it would be a row of zeros telling nobody anything.
  const rs = o.resolutionStats;
  if (rs && rs.decidedTotal > 0) {
    const decided = rs.byMode.filter((m) => DECIDED_RESOLUTION_MODES.includes(m.mode));
    const paired = decided
      .filter((m) => m.mode === "fork-signal" || m.mode === "ambiguous-fork" || m.mode === "blur-duplicate")
      .reduce((sum, m) => sum + m.count, 0);
    out.push(bold("RESOLUTION") + dim(`  — how new evidence landed, last ${rs.windowDays}d`));
    out.push(truncate(dim(`  ${decided.map((m) => `${m.mode} ${m.count}`).join(" · ")}`), width));
    out.push(truncate(
      dim(`  ${rs.decidedTotal} decided · ${((paired / rs.decidedTotal) * 100).toFixed(0)}% surfaced a possible duplicate`),
      width,
    ));
    out.push("");
  }

  // HOW THE GATES HAVE BEEN FIRING (src/gates.ts). The gate-firing design names its own measures —
  // "fire precision and silence rate" — and this is the human curation surface, so a JSON field on
  // the MCP response does not discharge them. Two lines: the rates, then the dead-pattern watchlist
  // (a stage whose pattern has never matched anything is the failure mode a mechanically-seeded
  // pattern actually has). Suppressed on a store that has never been asked, where it would be a row
  // of zeros telling nobody anything — but NOT suppressed when there are only silences: a gate that
  // never fires is exactly what this section exists to make visible.
  const gs = o.gateStats;
  // `recognizedCount` (review fix, item 4): byMatcher's recognized-lookup count reaches no human
  // otherwise — a JSON field on the MCP response does not discharge a disclosure whose whole
  // purpose is that a human sees it, same standard this section already holds itself to below.
  // Computed before the suppression check because it must ALSO be able to un-suppress the whole
  // section: a store where every gate event is a recognized lookup (zero mechanical fires) has
  // `windowTotal === 0` — windowTotal is mechanical-only by construction (see gateStats' own
  // comment) — and without this term such a store would never show a GATES section at all despite
  // real recognized activity.
  const recognizedCount = gs?.byMatcher.find((m) => m.matcher === "recognized")?.count ?? 0;
  // `unexplainedDenies` joins the suppression condition rather than riding inside it: a store that
  // has never been asked can still hold a relayed deny that cannot explain itself, and that is
  // precisely the store where nobody is going to notice on their own. The section comment above
  // applies with full force here — a JSON field on the MCP response does not discharge a
  // disclosure whose whole purpose is that a human sees it.
  if (gs && (gs.windowTotal > 0 || recognizedCount > 0 || gs.unverifiedPatterns.length > 0 || gs.unexplainedDenies.length > 0)) {
    out.push(bold("GATES") + dim(`  — what fired at the moment of action, last ${gs.windowDays}d`));
    if (gs.windowTotal > 0) {
      out.push(truncate(
        dim(`  ${gs.windowTotal} asked · ${gs.fires} matched a stage · ${gs.silences} silent · ${gs.delivered} delivered a rule`),
        width,
      ));
      for (const st of gs.byStage) {
        out.push(truncate(`  ${padStartV(String(st.fires), 3)} × ${st.stageName}`, width));
      }
    }
    if (recognizedCount > 0) {
      out.push(truncate(dim(`  ${recognizedCount} asked by recognition (stage_lookup)`), width));
    }
    if (gs.unverifiedPatterns.length > 0) {
      out.push(truncate(yellow(`  ${gs.unverifiedPatterns.length} pattern(s) never fired`) + dim(" — declare to replace, or leave inert"), width));
      for (const up of gs.unverifiedPatterns) {
        out.push(truncate(dim(`      ${up.stageName}  [${up.patterns.join(" | ")}]  (${up.origin})`), width));
      }
    }
    if (gs.unexplainedDenies.length > 0) {
      // Named as a repair, not an alarm. These denies are working; what is missing is the sentence
      // shown to whoever they stop, and only a human can supply it — so the rules are NAMED here.
      // `stageName` and the rule text are exactly what a repairing declaration takes, which is the
      // difference between this line and one that sends somebody off to go find the row.
      out.push(truncate(
        yellow(`  ${gs.unexplainedDenies.length} deny(s) arrived with no reason`) + dim(" — declare the same rule with a reason to repair"),
        width,
      ));
      for (const ud of gs.unexplainedDenies.slice(0, UNEXPLAINED_DENIES_SHOWN)) {
        // THE ID LEADS, and that is a deliberate break from the POSSIBLE DUPLICATES block above,
        // which trails it. The form is the same — 8 hex characters in brackets, dim — but placement
        // is not decoration here: this line is truncated to `width`, and a trailing id is the first
        // thing a long rule title pushes off the end. Titles are not unique, they are the concept's
        // FIRST LINE rather than its content, and this list exists so somebody can fetch the exact
        // rule before redeclaring it. Losing the id to truncation would leave a repair queue whose
        // rows cannot identify what to repair — and redeclaring by a title that matched two rules
        // repairs the wrong one. Truncation now eats the recognition aid and keeps the identifier.
        const id = dim(`[${ud.conceptId.slice(0, 8)}]`);
        out.push(truncate(`      ${id} ${dim(`${ud.stageName}  ·  ${ud.title}`)}`, width));
      }
      // The population is small by construction — local creation is refused, so every one of these
      // arrived by relay — but "small by construction" is an argument, not a guarantee, and a
      // curation view that becomes a wall of text is one people stop reading.
      const hidden = gs.unexplainedDenies.length - UNEXPLAINED_DENIES_SHOWN;
      if (hidden > 0) out.push(truncate(dim(`      … and ${hidden} more`), width));
    }
    out.push("");
  }

  if (o.otherCircles && o.otherCircles.length > 0) {
    out.push(bold("OTHER ROOMS") + dim("  — other circles in this store"));
    for (const oc of o.otherCircles) {
      out.push(truncate(`  ${padEndV(oc.circle, 28)}  ${oc.concepts} memories`, width));
    }
    out.push("");
  }

  out.push(dim(`read-only · monet knows ${o.circle}   → fetch <id> to read one`));
  return out.join("\n");
}
