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
      // THE HOME COMES BEFORE THE CONTENT, not beside ratifiedBy where the rest of the provenance
      // sits (Codex round 1). `content` is the only unbounded field on this line, so anything after
      // it is what `truncate` eats first — and a foreign member losing its home to truncation is
      // exactly the failure this field exists to prevent. Omitted when absent, matching the wire:
      // no home means the member is homed in the circle this render's header already names.
      const home = member.homeCircle !== undefined ? ` · from ${member.homeCircle}` : "";
      lines.push(truncate(`  ${member.species}${home} · ${member.content}${member.ratifiedBy ? ` · ${member.ratifiedBy}` : ""}`, width));
    }
    lines.push("");
  }

  const gates = overview.gate;
  const conformance = gates.conformance;
  const owedByUser = conformance.unanswered;
  // TWO POPULATIONS, NOT ONE, because the record can speak for only one of them. `notAsked` is
  // moments where rules were read and no question was put; whether an action followed is not
  // recorded since #85 retired interception, so a lookup made to READ rules sits in it beside one
  // that governed a real act. `notAskedWithAction` is the subset carrying a stored action — real
  // outstanding work, and nonzero only on a store that predates #85 or folded a spool that did.
  // Collapsing them either accuses the agent over an inventory sweep or prints the all-clear over
  // real debt, and an upgraded store holds both kinds at once.
  const neverAskedWithAction = conformance.notAskedWithAction;
  const neverAskedUnknown = conformance.notAsked - neverAskedWithAction;
  if (
    gates.total > 0 || gates.retirementCandidates || gates.unexplainedDenies || gates.unreadStages ||
    owedByUser > 0 || neverAskedWithAction > 0 || gates.losses > 0 || gates.unopened > 0 ||
    gates.unattributed > 0
  ) {
    lines.push(bold("GATE"));
    if (gates.total > 0) {
      // ONE NUMBER, BECAUSE THERE IS ONLY ONE POPULATION LEFT TO NAME. This line carried rates
      // ("fired", "silent", "delivered") until 2026-08-22, and an `ungoverned` count beside the
      // total until later the same day. The rates went because nothing writes the columns they read.
      // `ungoverned` went because it reads `rule_ids IS NULL`, which is what the sole surviving
      // writer hard-codes — so it equalled `total` on everything this build records, and the line
      // was printing one population under two names. See `MomentCounts`.
      lines.push(truncate(dim(`  ${gates.total} moments`), width));
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
    // different remedies: one is a queue the user owes an answer to, the other is the agent not
    // recording. A single "pending" line would be the exact collapse this record exists to prevent.
    //
    // "recorded", NOT "answered", AND "not recorded", NOT "never asked" (#150). Nothing asks now:
    // the agent records its own reading, so question-and-answer wording described a flow that no
    // longer runs and made every unrecorded moment read as an unasked question. `awaiting you`
    // keeps its wording — it counts only moments where `conformance_ask` really did put one.
    if (conformance.followed > 0 || conformance.notFollowed > 0) {
      lines.push(truncate(dim(
        `  recorded: ${conformance.followed} followed · ${conformance.notFollowed} not followed`,
      ), width));
    }
    if (owedByUser > 0) {
      lines.push(truncate(`  awaiting you: ${owedByUser} asked, not yet answered`, width));
    }
    if (neverAskedWithAction > 0) {
      // THE CLAIM THE RECORD CAN MAKE: an action is stored on these, so a missing question is real
      // debt. In both lists, and yellow, because it is actionable while it stands.
      lines.push(truncate(yellow(`  not recorded: ${neverAskedWithAction} read, acted on, nothing recorded`), width));
    }
    if (neverAskedUnknown > 0) {
      // IN NEITHER LIST, by the rule stated at the all-clear below: a number that only grows and
      // has a benign normal case belongs in neither. Nothing removes a moment from this population
      // except asking about it, and a lookup made to READ rules — an inventory sweep, a probe — is
      // the benign normal case, with no action to ask about and so no honest way to clear it. While
      // it was `yellow` and in both lists, one such lookup retired "no curation work queued" for
      // the life of the store: the same failure `unjoinableReads` was moved out of both lists for.
      lines.push(truncate(dim(`  not recorded: ${neverAskedUnknown} delivered rules, nothing recorded`), width));
    }
    // READ, BUT TOO LATE TO HAVE ACTED ON IT. Dim and unactionable on purpose: a PreToolUse
    // advisory reaches the model beside the tool result on this host, so for every moment a
    // host-side hook recorded this is the NORMAL end state rather than a fault anyone can clear.
    // Monet ships nothing that delivers there now, so the population can only shrink relative to
    // the rest — it is still shown, so that a delivered rule the agent actually went and read is
    // not rendered as one nobody engaged with.
    //
    // IN NEITHER GATING LIST, and that is the G2 lesson applied rather than repeated: a number with
    // a benign normal case that only grows would make the all-clear unreachable if it suppressed it,
    // and would open the section forever if it opened it. It rides inside the section, which any
    // recorded moment already opens.
    if (conformance.readLate > 0) {
      lines.push(truncate(dim(
        `  ${conformance.readLate} read after acting — delivered and engaged with, never judgeable`,
      ), width));
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
    gates.conformance.notAskedWithAction === 0 && gates.conformance.unanswered === 0 && gates.losses === 0 &&
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
