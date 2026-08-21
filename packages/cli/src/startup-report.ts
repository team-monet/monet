import path from "node:path";
import { recordStartupFailure, startupPhaseOf, type StartupPhase } from "@team-monet/core";
import { getDbPath, getStartupFailurePath } from "./db/index.js";

/**
 * What every entry point does with a startup failure (#13).
 *
 * ONE FUNCTION FOR BOTH LAUNCH PATHS. `monet start` (cli.ts) and the bare stdio entry (index.ts)
 * are the same long-running server reached two ways, and this file exists so the diagnosis does not
 * depend on which one a host happens to spawn — the same argument bootstrap.ts's own
 * `gateSidecarPath`/`momentSpoolPath` comments make about the mirror and the spool, applied to the
 * one record written when the server never gets far enough to maintain either.
 *
 * STDERR IS NOT DROPPED, IT IS SUPPLEMENTED. The existing stderr message stays exactly where it is
 * — it is what an operator running `monet start` in a terminal reads, and it is what Claude Code
 * files under `mcp-logs-monet/` in its own cache. What it cannot be is FINDABLE: no monet surface
 * names that cache, and another host may discard the stream. The file is the addressable copy.
 */
export interface StartupFailureContext {
  /** The SAME resolved project dir the store was opened from — never a second cwd-rooted notion. */
  projectDir: string;
  /**
   * Whether `createMonetCoreMcpServer` had already returned when this failed. Only used when the
   * error carries no phase tag of its own: past that call the transport IS live, so a death is
   * post-connect rather than unknown, and the record should not flatten the two together.
   */
  transportConnected: boolean;
}

/**
 * Write the startup diagnosis beside the store and point stderr at it.
 *
 * The pointer line is deliberately SELF-CONTAINED — it names the phase and the path in one
 * sentence — because the two entry points print their error message at different moments relative
 * to this call (cli.ts's `start` rethrows into the shared `parseAsync` handler, index.ts prints
 * first), so this line has to read correctly either side of it.
 *
 * Never throws: recordStartupFailure is total, and everything else here is path arithmetic.
 */
export function reportStartupFailure(error: unknown, context: StartupFailureContext): void {
  const fallbackPhase: StartupPhase = context.transportConnected ? "post-connect" : "unknown";
  const phase = startupPhaseOf(error) ?? fallbackPhase;
  const written = recordStartupFailure({
    store: path.resolve(getDbPath(context.projectDir)),
    error,
    fallbackPhase,
  });
  if (written === null) {
    // THE ONE CASE THAT MUST NOT BE SILENT. A record that could not be written and says nothing
    // about it leaves a reader who checks the expected path and finds nothing concluding "no
    // startup ever failed" — the exact conflation between an absent record and an absent event
    // this change exists to end.
    // "THIS STDERR", not "the message below": the two entry points print their error message on
    // opposite sides of this call (cli.ts rethrows into the shared handler, index.ts prints first),
    // so naming a direction is wrong at one of them. The dev entry point mirrors this wording.
    console.error(
      `monet: startup failed in phase '${phase}'; could not write the diagnosis to ` +
        `${getStartupFailurePath(context.projectDir)} — this stderr is the only record.`,
    );
    return;
  }
  // "IS AT", not "written to". recordStartupFailure declines to publish over a record that is
  // already NEWER than this one (a second server failing against the same store at the same
  // instant), and returns the path anyway because the file still holds the most recent startup
  // diagnosis — which is what the line is directing the reader to. Claiming authorship of it would
  // be false in exactly that case.
  console.error(`monet: startup failed in phase '${phase}'; the full startup diagnosis is at ${written}`);
}
