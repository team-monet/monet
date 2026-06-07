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
import type { MemoryOverview, EntityHub, ConnectedConcept } from "./engine";

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

  out.push(dim(`read-only · monet knows ${o.circle}   → fetch <id> to read one`));
  return out.join("\n");
}
