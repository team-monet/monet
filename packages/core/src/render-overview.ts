import type { MemoryOverview, PossibleDuplicatePair } from "./engine";

interface RenderOpts {
  color?: boolean;
  width?: number;
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const ANSI_AT = new RegExp(`^${ESC}\\[[0-9;]*m`);
const vlen = (value: string): number => value.replace(ANSI, "").length;

function truncate(value: string, width: number): string {
  if (vlen(value) <= width) return value;
  let out = "";
  let visible = 0;
  let index = 0;
  while (index < value.length && visible < width - 1) {
    const match = value.slice(index).match(ANSI_AT);
    if (match) {
      out += match[0];
      index += match[0].length;
    } else {
      out += value[index++];
      visible++;
    }
  }
  return `${out}…`;
}

/** Pure terminal rendering of the actionable overview workbench. */
export function renderOverview(overview: MemoryOverview, opts: RenderOpts = {}): string {
  const width = opts.width ?? 84;
  const color = opts.color ?? false;
  const paint = (code: string, value: string): string => color ? `${ESC}[${code}m${value}${ESC}[0m` : value;
  const bold = (value: string): string => paint("1", value);
  const dim = (value: string): string => paint("2", value);
  const yellow = (value: string): string => paint("33", value);
  const green = (value: string): string => paint("32", value);
  const lines: string[] = [
    bold("MONET · curation workbench"),
    truncate(dim(`circle: ${overview.circle} · ${overview.counts.concepts} memories · ${overview.counts.observations} observations`), width),
    "",
  ];

  if (overview.livingModel.length > 0) {
    lines.push(bold("LIVING MODEL"));
    for (const card of overview.livingModel) {
      lines.push(truncate(`  ${card.kind} · ${card.title} · ${card.supportCount} obs`, width));
    }
    lines.push("");
  }

  const renderWorklist = (
    heading: string,
    cards: NonNullable<MemoryOverview["dirty"]>,
    omitted: number | undefined,
  ): void => {
    lines.push(yellow(bold(heading)) + (omitted ? dim(` · ${omitted} more omitted`) : ""));
    for (const card of cards) {
      lines.push(truncate(`  [${card.id.slice(0, 8)}] ${card.slug} · ${card.kind} · ${card.observationCount} obs`, width));
    }
    lines.push("");
  };
  if (overview.dirty) renderWorklist("DIRTY · SYNTHESIS QUEUE", overview.dirty, overview.dirtyOmitted);
  if (overview.stale) renderWorklist("STALE · RE-CONFIRMATION QUEUE", overview.stale, overview.staleOmitted);

  if (overview.openContradictions.length > 0 || overview.openContradictionsOmitted) {
    lines.push(yellow(bold("OPEN CONTRADICTIONS")) + (overview.openContradictionsOmitted ? dim(` · ${overview.openContradictionsOmitted} more omitted`) : ""));
    for (const contradiction of overview.openContradictions) {
      lines.push(truncate(`  [${contradiction.conceptId.slice(0, 8)}] ${contradiction.conceptTitle} · ${contradiction.detail}`, width));
    }
    lines.push("");
  }

  const renderPairs = (heading: string, pairs: PossibleDuplicatePair[], total: number): void => {
    if (pairs.length === 0) return;
    lines.push(yellow(bold(heading)) + (total > pairs.length ? dim(` · showing ${pairs.length} of ${total}`) : ""));
    for (const pair of pairs) {
      lines.push(truncate(`  [${pair.conceptAId.slice(0, 8)}] ${pair.conceptATitle} / [${pair.conceptBId.slice(0, 8)}] ${pair.conceptBTitle} · ${pair.score.toFixed(3)}`, width));
    }
    lines.push("");
  };
  renderPairs("POSSIBLE DUPLICATES", overview.possibleDuplicates, overview.counts.possibleDuplicates);
  if (overview.extractionCandidates.length > 0) {
    lines.push(dim("rules at different stages that may share one reason"));
  }
  renderPairs("EXTRACTION CANDIDATES", overview.extractionCandidates, overview.counts.extractionCandidates);

  if (overview.skeleton.length > 0) {
    lines.push(bold("SKELETON") + (overview.counts.skeleton > overview.skeleton.length ? dim(` · showing ${overview.skeleton.length} of ${overview.counts.skeleton}`) : ""));
    for (const member of overview.skeleton) {
      lines.push(truncate(`  ${member.species} · ${member.content}${member.ratifiedBy ? ` · ${member.ratifiedBy}` : ""}`, width));
    }
    lines.push("");
  }

  const gates = overview.gateStats;
  if (gates.windowTotal > 0 || gates.retirementCandidates || gates.unexplainedDenies || gates.unreadStages) {
    lines.push(bold("GATE EXCEPTIONS"));
    if (gates.windowTotal > 0) {
      lines.push(truncate(dim(`  ${gates.windowTotal} asked · ${gates.fires} fires · ${gates.silences} silences · ${gates.overflows} overflows · ${gates.delivered} delivered`), width));
    }
    for (const candidate of gates.retirementCandidates ?? []) {
      lines.push(truncate(`  retire [${candidate.conceptId.slice(0, 8)}] ${candidate.title} · ${candidate.modelTag}`, width));
    }
    if (gates.retirementCandidatesOmitted) lines.push(dim(`  ${gates.retirementCandidatesOmitted} more retirement candidates omitted`));
    for (const deny of gates.unexplainedDenies ?? []) {
      lines.push(truncate(`  repair [${deny.conceptId.slice(0, 8)}] ${deny.stageName}  ·  ${deny.title}`, width));
    }
    if (gates.unexplainedDeniesOmitted) lines.push(dim(`  ${gates.unexplainedDeniesOmitted} more unexplained denies omitted`));
    // A stage with a live rule that nothing has asked for. Not an error — it is the one gate state
    // that reads exactly like health, which is why it is worth a line at all.
    //
    // THE WINDOW IS IN THE LABEL (Codex P2 on PR #51, and it was right). `byStageRead` counts within
    // `windowDays`, so a bare "unread" cannot be told apart from "last read just outside the
    // window" — and the reader would take the narrower claim for the permanent one. This whole
    // change is about not writing a verdict where the value is unavailable; the renderer was quietly
    // doing it one layer above the query.
    for (const stage of gates.unreadStages ?? []) {
      lines.push(truncate(`  unread/${gates.windowDays}d [${stage.stageId.slice(0, 8)}] ${stage.stageName}`, width));
    }
    if (gates.unreadStagesOmitted) lines.push(dim(`  ${gates.unreadStagesOmitted} more unread stages omitted`));
    lines.push("");
  }

  if (overview.legacyStarConcepts) {
    lines.push(yellow(bold("LEGACY-STAR FILING")));
    lines.push(`${overview.legacyStarConcepts} migrated memories still need a human filing decision`);
    lines.push("");
  }

  if (
    overview.counts.dirty === 0 && overview.counts.stale === 0 && overview.counts.disputed === 0 &&
    overview.counts.possibleDuplicates === 0 && overview.counts.extractionCandidates === 0 &&
    !gates.retirementCandidates && !gates.unexplainedDenies && !gates.unreadStages && !overview.legacyStarConcepts
  ) {
    lines.push(green("no curation work queued"));
    lines.push("");
  }

  lines.push(dim("read-only · fetch <id> to inspect evidence"));
  return lines.map((line) => truncate(line, width)).join("\n");
}
