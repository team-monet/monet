/**
 * The moment spool.
 *
 * THE PROPERTY EVERY TEST HERE IS ABOUT: a record that was never written must leave something
 * behind. The old journal swallowed every write failure and left the file merely shorter than the
 * truth, which is indistinguishable from a quiet day. So the assertions below care most about the
 * sequence number — the thing that turns a swallowed write into a hole somebody can name — and
 * about the fields whose ABSENCE would be read as a verdict.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOMENT_ACTION_RENDERING_MAX_CHARS,
  MOMENT_SPOOL_FORMAT,
  appendMomentRecord,
  mintMomentId,
  parseMomentSpoolLine,
  readMomentSpool,
  renderAction,
  spoolInterception,
  startMomentRun,
} from "../moment-spool";
import type { MomentRun } from "../moment-spool";

const dirs: string[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-moment-spool-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the run declares itself inside its own sequence", () => {
  it("writes a run-start record at seq 0 naming the writer role", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const run = startMomentRun(path, "host-hook");
    const [first] = lines(path);
    expect(first).toMatchObject({
      v: MOMENT_SPOOL_FORMAT,
      kind: "run-start",
      runId: run.runId,
      seq: 0,
      writerRole: "host-hook",
    });
    // The declaration consumed seq 0, so a run whose declaration is LOST reports a hole at 0 rather
    // than silently becoming a run of unknown role.
    expect(run.seq).toBe(1);
  });

  it("increments the sequence by one per append", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const run = startMomentRun(path, "core");
    for (let i = 0; i < 3; i += 1) appendMomentRecord(run, { kind: "ask", momentId: `m${i}`, askedAt: "t" });
    expect(lines(path).map((line) => line.seq)).toEqual([0, 1, 2, 3]);
  });

  it("two runs of the same role sequence independently", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const a = startMomentRun(path, "core");
    const b = startMomentRun(path, "core");
    appendMomentRecord(a, { kind: "ask", momentId: "m", askedAt: "t" });
    appendMomentRecord(b, { kind: "ask", momentId: "m", askedAt: "t" });
    expect(a.runId).not.toBe(b.runId);
    const bySeq = lines(path).filter((line) => line.runId === a.runId);
    expect(bySeq.map((line) => line.seq)).toEqual([0, 1]);
  });
});

describe("a swallowed write is still a consumed sequence number", () => {
  // THE WHOLE POINT. Recording must never fail a user's tool call, so the append swallows
  // everything — and that is only safe because the number was taken before the write was tried.
  it("consumes the sequence number even when the file cannot be opened", () => {
    const run: MomentRun = {
      path: join(mkTmp(), "no-such-directory", "moments.jsonl"),
      writerRole: "host-hook",
      runId: "run-a",
      seq: 0,
    };
    expect(() => appendMomentRecord(run, { kind: "ask", momentId: "m", askedAt: "t" })).not.toThrow();
    expect(() => appendMomentRecord(run, { kind: "ask", momentId: "m", askedAt: "t" })).not.toThrow();
    expect(run.seq).toBe(2);
  });

  it("consumes the sequence number even when the payload cannot be serialized", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const run = startMomentRun(path, "core");
    const cyclic: Record<string, unknown> = { kind: "ask", momentId: "m", askedAt: "t" };
    cyclic.self = cyclic;
    expect(() => appendMomentRecord(run, cyclic)).not.toThrow();
    expect(run.seq).toBe(2);
    // Nothing was written for seq 1, which is exactly the hole the fold is meant to name.
    expect(lines(path).map((line) => line.seq)).toEqual([0]);
  });

  it("is a no-op with no sink, and still advances the sequence", () => {
    const run: MomentRun = { path: null, writerRole: "core", runId: "run-a", seq: 0 };
    appendMomentRecord(run, { kind: "ask", momentId: "m", askedAt: "t" });
    expect(run.seq).toBe(1);
  });
});

describe("silence is a value", () => {
  it("writes an empty rule set and a silent disposition rather than omitting them", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const run = startMomentRun(path, "host-hook");
    const momentId = mintMomentId();
    spoolInterception(run, {
      momentId,
      at: "2026-08-19T00:00:00.000Z",
      toolUseId: null,
      circle: "acme-widgets",
      sessionId: null,
      surface: "Bash",
      action: "git status",
      stageId: null,
      ruleIds: [],
      disposition: "silent",
      deliveredRuleIds: [],
    });
    const record = lines(path)[1];
    expect(record).toMatchObject({ kind: "interception", momentId, ruleIds: [], deliveredRuleIds: [], disposition: "silent" });
    // Present-and-null, not absent: "no session was known" must not read as "no session field".
    expect(Object.prototype.hasOwnProperty.call(record, "sessionId")).toBe(true);
    expect(record.sessionId).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(record, "stageId")).toBe(true);
    expect(record.stageId).toBeNull();
  });

  it("records an uninterceptable surface as ungoverned", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const run = startMomentRun(path, "core");
    spoolInterception(run, {
      momentId: mintMomentId(),
      at: "2026-08-19T00:00:00.000Z",
      toolUseId: null,
      circle: "acme-widgets",
      sessionId: "s1",
      surface: "WebFetch",
      action: "https://example.invalid",
      stageId: null,
      ruleIds: [],
      disposition: "ungoverned",
      deliveredRuleIds: [],
    });
    expect(lines(path)[1]).toMatchObject({ disposition: "ungoverned" });
  });
});

describe("an action is bounded without losing its identity", () => {
  it("hashes the whole action and reports the true length when the rendering is clipped", () => {
    const action = "x".repeat(MOMENT_ACTION_RENDERING_MAX_CHARS + 500);
    const rendered = renderAction(action);
    expect(rendered.actionRendering).toHaveLength(MOMENT_ACTION_RENDERING_MAX_CHARS);
    expect(rendered.actionClipped).toBe(true);
    expect(rendered.actionChars).toBe(action.length);
    // Two moments over the same oversized action are still provably the same action.
    expect(rendered.actionSha256).toBe(renderAction(action).actionSha256);
    expect(rendered.actionSha256).not.toBe(renderAction(`${action}!`).actionSha256);
  });

  it("hashes short actions too, so identity does not depend on size", () => {
    const rendered = renderAction("git status");
    expect(rendered.actionClipped).toBe(false);
    expect(rendered.actionRendering).toBe("git status");
    expect(rendered.actionSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("reading the spool", () => {
  it("reads from a byte cursor and stops just past the last complete line", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const run = startMomentRun(path, "core");
    appendMomentRecord(run, { kind: "ask", momentId: "m1", askedAt: "t" });
    const first = readMomentSpool(path, 0);
    expect(first.records).toHaveLength(2);

    appendMomentRecord(run, { kind: "ask", momentId: "m2", askedAt: "t" });
    const second = readMomentSpool(path, first.nextCursor);
    expect(second.records).toHaveLength(1);
    expect(second.records[0]).toMatchObject({ kind: "ask", momentId: "m2", seq: 2 });
  });

  it("leaves a torn trailing line for the next read instead of discarding it", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const run = startMomentRun(path, "core");
    appendFileSync(path, `{"v":1,"runId":"${run.runId}","seq":1,"kind":"ask","momentId":"m1","aske`);
    const torn = readMomentSpool(path, 0);
    expect(torn.records).toHaveLength(1);
    expect(torn.malformedLines).toBe(0);

    appendFileSync(path, `dAt":"t"}\n`);
    const whole = readMomentSpool(path, torn.nextCursor);
    expect(whole.records).toHaveLength(1);
    expect(whole.records[0]).toMatchObject({ kind: "ask", momentId: "m1" });
  });

  it("starts over when the cursor points past the end of the file", () => {
    const path = join(mkTmp(), "moments.jsonl");
    startMomentRun(path, "core");
    const read = readMomentSpool(path, 1_000_000);
    expect(read.restartedFromZero).toBe(true);
    expect(read.records).toHaveLength(1);
  });

  it("treats a missing file as the ordinary state before the first append", () => {
    const read = readMomentSpool(join(mkTmp(), "absent.jsonl"), 0);
    expect(read).toMatchObject({ records: [], malformedLines: 0, nextCursor: 0, restartedFromZero: false });
  });

  it("counts a garbage line without letting it stop the fold", () => {
    const path = join(mkTmp(), "moments.jsonl");
    writeFileSync(path, `not json at all\n{"v":1,"runId":"r","seq":0,"kind":"ask","momentId":"m","askedAt":"t"}\n`);
    const read = readMomentSpool(path, 0);
    expect(read.malformedLines).toBe(1);
    expect(read.records).toHaveLength(1);
  });

  it("separates a line from a newer format from a corrupt one", () => {
    expect(parseMomentSpoolLine(`{"v":${MOMENT_SPOOL_FORMAT + 1},"runId":"r","seq":0,"kind":"ask"}`)).toBe(
      "future-version",
    );
    expect(parseMomentSpoolLine(`{"v":1,"runId":"r","seq":0,"kind":"ask"}`)).toBeNull();
    const path = join(mkTmp(), "moments.jsonl");
    writeFileSync(path, `{"v":99,"runId":"r","seq":0,"kind":"ask","momentId":"m","askedAt":"t"}\n`);
    const read = readMomentSpool(path, 0);
    expect(read).toMatchObject({ futureVersionLines: 1, malformedLines: 0 });
  });

  it("refuses a half-recognised interception rather than folding a row that is not an observation", () => {
    // ruleIds missing entirely: the one field whose absence would be read as "nothing was bound".
    expect(
      parseMomentSpoolLine(
        `{"v":1,"runId":"r","seq":1,"kind":"interception","momentId":"m","at":"t","sessionId":null,` +
          `"surface":"Bash","actionSha256":"a","actionRendering":"x","actionChars":1,"actionClipped":false,` +
          `"stageId":null,"disposition":"silent","deliveredRuleIds":[]}`,
      ),
    ).toBeNull();
  });
});

/*
 * WHY THE APPEND LOOPS ON `writeSync`'s RETURN, stated as a test of the HAZARD rather than of the
 * loop, because only one of those two is honestly testable here.
 *
 * That `fs.writeSync` does not loop is already MEASURED in this repo and does not need re-measuring:
 * `startup-diagnosis.ts`'s `writeFully` records asking for 1 MiB against a bounded pipe and getting
 * 8192 back (Codex round 1, PR #79).
 *
 * WHAT IS NOT TESTED, SAID PLAINLY: no test here drives a real short write. A short write needs a
 * bounded sink, and `appendMomentRecord` opens its own regular file by path, where a 20 KB append
 * does not short-write on any filesystem this suite runs on. A "large record round-trips whole"
 * test was written first and then DELETED for exactly that reason — it passed identically with the
 * loop removed, which makes it a green that cannot fail rather than evidence.
 *
 * What IS testable, and is the whole reason the loop earns its place, is the consequence a fragment
 * has in THIS file: the spool is newline-framed and every append opens `"a"`, so a fragment carries
 * no trailing newline and the next append lands its whole line directly behind it. The reader then
 * takes the two as ONE line and loses BOTH — the record that was short AND a record that wrote
 * perfectly. That is a property of the framing, it is deterministic, and it is asserted below.
 */
describe("a fragment in the spool eats the record written after it", () => {
  it("loses the NEIGHBOUR too, which is the damage the append's write loop exists to prevent", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const run = startMomentRun(path, "core");
    // Exactly what a short write leaves behind: a partial line, no trailing newline.
    appendFileSync(path, `{"v":${MOMENT_SPOOL_FORMAT},"runId":"${run.runId}","seq":1,"kind":"ask","mom`);
    run.seq = 2;
    // A perfectly good record, appended behind it by the ordinary path.
    appendMomentRecord(run, { kind: "ask", momentId: mintMomentId(), askedAt: "t" });

    const read = readMomentSpool(path, 0);
    // The run-start survives; the fragment and the GOOD record behind it are read as one bad line.
    expect(read.records).toHaveLength(1);
    expect(read.records[0]).toMatchObject({ seq: 0, kind: "run-start" });
    expect(read.malformedLines).toBe(1);
    // Both seq 1 and seq 2 are now holes, though only seq 1 ever failed to write.
    expect(read.records.some((r) => r.seq === 2)).toBe(false);
  });

  it("keeps the neighbour when the line before it is whole — the same two appends, undamaged", () => {
    // The control the test above needs to mean anything: identical shape, no fragment, both land.
    const path = join(mkTmp(), "moments.jsonl");
    const run = startMomentRun(path, "core");
    appendMomentRecord(run, { kind: "ask", momentId: mintMomentId(), askedAt: "t" });
    appendMomentRecord(run, { kind: "ask", momentId: mintMomentId(), askedAt: "t" });

    const read = readMomentSpool(path, 0);
    expect(read.malformedLines).toBe(0);
    expect(read.records.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
  });
});
