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

  const gates = overview.gate;
  const conformance = gates.conformance;
  const owedByUser = conformance.unanswered;
  const owedByAgent = conformance.notAsked;
  if (
    gates.total > 0 || gates.retirementCandidates || gates.unexplainedDenies || gates.unreadStages ||
    owedByUser > 0 || owedByAgent > 0 || gates.losses > 0 || gates.unopened > 0 ||
    gates.unattributed > 0
  ) {
    lines.push(bold("GATE"));
    if (gates.total > 0) {
      // `ungoverned` is its own number and never folded into silences: a silence is a claim that the
      // gate LOOKED and nothing was bound, and these are the moments nothing evaluated at all.
      lines.push(truncate(dim(
        `  ${gates.total} moments · ${gates.fires} fired · ${gates.silences} silent · ` +
        `${gates.ungoverned} ungoverned · ${gates.delivered} delivered`,
      ), width));
    }
    // ITS OWN LINE, because it is in no other number here: `total` counts THIS circle's moments and
    // these have no circle at all, so without a line of their own an opened section could show
    // nothing. A moment the gate observed but could not attribute is a gate that failed before it
    // resolved a circle — a defect to look at, not a quiet state.
    if (gates.unattributed > 0) {
      lines.push(truncate(yellow(
        `  ${gates.unattributed} observed with no circle resolved — not counted in any circle`,
      ), width));
    }

    // THE TWO PENDING STATES, ON SEPARATE LINES AND NEVER SUMMED. They have different owners and
    // different remedies: one is a queue the user owes an answer to, the other is the agent failing
    // to ask. A single "pending" line would be the exact collapse this record exists to prevent.
    if (conformance.followed > 0 || conformance.notFollowed > 0) {
      lines.push(truncate(dim(
        `  answered: ${conformance.followed} followed · ${conformance.notFollowed} not followed`,
      ), width));
    }
    if (owedByUser > 0) {
      lines.push(truncate(`  awaiting you: ${owedByUser} asked, not yet answered`, width));
    }
    if (owedByAgent > 0) {
      lines.push(truncate(yellow(`  never asked: ${owedByAgent} read and acted on without asking`), width));
    }

    // WHAT THE RECORD KNOWS IT NEVER RECEIVED. Surfaced because a record that quietly holds less
    // than it should is the failure the sequence exists to make impossible.
    if (gates.losses > 0) {
      lines.push(truncate(yellow(`  ${gates.losses} gaps in the record`), width));
    }
    // Debris: attached to, never observed at interception. Excluded from every rate above (it is
    // not a governed moment) and therefore reported here, because excluding a loss from the counts
    // must not be the same as hiding it.
    if (gates.unopened > 0) {
      lines.push(truncate(yellow(`  ${gates.unopened} moments attached to but never observed`), width));
    }
    if (conformance.unjoinableReads > 0) {
      lines.push(truncate(dim(`  ${conformance.unjoinableReads} reads that named no moment`), width));
    }

    for (const candidate of gates.retirementCandidates ?? []) {
      lines.push(truncate(`  retire [${candidate.conceptId.slice(0, 8)}] ${candidate.title} · ${candidate.modelTag}`, width));
    }
    if (gates.retirementCandidatesOmitted) lines.push(dim(`  ${gates.retirementCandidatesOmitted} more retirement candidates omitted`));
    for (const deny of gates.unexplainedDenies ?? []) {
      lines.push(truncate(`  repair [${deny.conceptId.slice(0, 8)}] ${deny.stageName}  ·  ${deny.title}`, width));
    }
    if (gates.unexplainedDeniesOmitted) lines.push(dim(`  ${gates.unexplainedDeniesOmitted} more unexplained denies omitted`));

    // A stage with a live rule that nothing has ever asked for. Not an error — it is the one gate
    // state that reads exactly like health, which is why it is worth a line at all.
    //
    // NO WINDOW IN THE LABEL ANY MORE, and that is a strengthening rather than a loss. This used to
    // read "unread/30d" because the count came from events inside a window, so "unread" could not be
    // told from "last read just outside it". The claim is now over every read the record holds, so
    // "never" is the honest word and the qualifier would be the misleading one.
    for (const stage of gates.unreadStages ?? []) {
      lines.push(truncate(`  never looked up [${stage.stageId.slice(0, 8)}] ${stage.stageName}`, width));
    }
    if (gates.unreadStagesOmitted) lines.push(dim(`  ${gates.unreadStagesOmitted} more never-looked-up stages omitted`));
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
    !gates.retirementCandidates && !gates.unexplainedDenies && !gates.unreadStages &&
    gates.conformance.notAsked === 0 && gates.conformance.unanswered === 0 && gates.losses === 0 &&
    // THIS LIST AND THE GATE SECTION'S OWN VISIBILITY CHECK ARE THE SAME SET. Mechanical on
    // purpose, and grep-checkable: anything that can OPEN that section must also suppress the
    // all-clear, or the page tells a human both things at once.
    //
    // BE SUSPICIOUS OF THIS RULE — it has been wrong three times. `unopened` was wired into the
    // section and not into here (R2). `unjoinableReads` was missed the same way (N3). Then the fix
    // for that went the wrong direction (G2): adding it here made the all-clear UNREACHABLE, because
    // `moment_reads` has no DELETE anywhere and an unjoinable read is the documented normal case —
    // a `stage_lookup` from `agent_context`, with no interception behind it. One such lookup on a
    // brand-new store retired "no curation work queued" permanently, with nothing to act on. A
    // signal that never fires is the same failure as one that always fires.
    //
    // So `unjoinableReads` was removed from BOTH lists rather than added to this one. It is `dim`
    // and informational; it rides inside the section when something else opens it, and the two
    // lists stay identical. If you are adding a condition here, add it to the visibility check in
    // the same commit — and if it is a number that only grows and has a benign normal case, it
    // belongs in neither.
    gates.unopened === 0 &&
    // ADDED TO BOTH LISTS IN ONE CHANGE, per the rule above. Weighed against that rule's own
    // counter-example first: `unattributed` is NOT the `unjoinableReads` case. It has no benign
    // normal path — the gate resolves a circle on every ordinary invocation, including a
    // user-global install where it resolves one per invocation rather than from a pin — so a
    // nonzero value marks a gate that failed before attribution, it can fall again as a later
    // record supplies the missing circle, and it is actionable while it stands.
    gates.unattributed === 0 &&
    !overview.legacyStarConcepts
  ) {
    lines.push(green("no curation work queued"));
    lines.push("");
  }

  lines.push(dim("read-only · fetch <id> to inspect evidence"));
  return lines.map((line) => truncate(line, width)).join("\n");
}
