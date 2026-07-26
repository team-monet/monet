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
  if (gs && (gs.windowTotal > 0 || gs.unverifiedPatterns.length > 0)) {
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
    if (gs.unverifiedPatterns.length > 0) {
      out.push(truncate(yellow(`  ${gs.unverifiedPatterns.length} pattern(s) never fired`) + dim(" — declare to replace, or leave inert"), width));
      for (const up of gs.unverifiedPatterns) {
        out.push(truncate(dim(`      ${up.stageName}  [${up.patterns.join(" | ")}]  (${up.origin})`), width));
      }
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
