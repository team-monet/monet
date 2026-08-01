import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const MATERIALIZE_MANIFEST = "materialize.json";
const BEGIN_MARKER = /<!-- BEGIN monet:skeleton(?: [^\r\n]*?)? -->/;
const END_MARKER = "<!-- END monet:skeleton -->";

export const MIRROR_STALE_INSTRUCTION =
  "Report the divergence to the user and ask which side is the truth. If the store is the truth, run `monet materialize`; if a hand-edit to the file is the truth, re-declare that edit through memory_declare, then run `monet materialize`. Never repair without the user's confirmation.";

export type MirrorStaleReason = "block-missing" | "block-edited" | "store-moved";

export interface MirrorStaleEntry {
  path: string;
  reason: MirrorStaleReason;
}

export interface SkeletonStateMember {
  conceptId: string;
  body: string;
  breadth: "global" | "local";
}

export interface SkeletonMirrorInspection {
  globalCovered: boolean;
  localCovered: boolean;
  mirrorStale?: MirrorStaleEntry[];
  instruction?: string;
}

type MaterializedEntry = {
  blockHash: string;
  skeletonState: string;
  when: number;
};

type SurfaceScope = "global" | { circle: string };
type Surface = { path: string; scope: SurfaceScope };
type MaterializeManifest = {
  surfaces: Surface[];
  materialized: Record<string, MaterializedEntry>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(text: string): MaterializeManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.surfaces) || !isRecord(value.materialized)) return null;

  const surfaces: Surface[] = [];
  for (const candidate of value.surfaces) {
    if (!isRecord(candidate) || typeof candidate.path !== "string" || !isAbsolute(candidate.path)) return null;
    const scope = candidate.scope;
    if (scope !== "global" && (!isRecord(scope) || typeof scope.circle !== "string")) return null;
    surfaces.push({ path: candidate.path, scope: scope as SurfaceScope });
  }

  const materialized: Record<string, MaterializedEntry> = Object.create(null) as Record<string, MaterializedEntry>;
  for (const [path, candidate] of Object.entries(value.materialized)) {
    if (
      !isRecord(candidate) ||
      typeof candidate.blockHash !== "string" ||
      typeof candidate.skeletonState !== "string" ||
      typeof candidate.when !== "number" ||
      !Number.isFinite(candidate.when)
    ) return null;
    materialized[path] = {
      blockHash: candidate.blockHash,
      skeletonState: candidate.skeletonState,
      when: candidate.when,
    };
  }
  return { surfaces, materialized };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Hash the contract's canonical JSON with exact key order and no whitespace. conceptId ordering is
 * raw JavaScript code-unit order (`<`/`>`), never localeCompare/ICU. The manifest's `materialized`
 * lookup uses the raw absolute string from `surfaces[].path` — no realpath, case-folding, Unicode
 * normalization, or other path normalization. `when` is provenance only and never affects freshness.
 */
export function skeletonStateHash(members: readonly SkeletonStateMember[]): string {
  const canonical = [...members]
    .sort((a, b) => a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0)
    .map(({ conceptId, body, breadth }) => ({ conceptId, body, breadth }));
  return sha256(JSON.stringify(canonical));
}

/** Block hash span: BEGIN marker's first byte through the END marker's final `>`, inclusive; any trailing newline is excluded. */
function skeletonBlock(text: string): string | null {
  const match = BEGIN_MARKER.exec(text);
  if (match === null || match.index === undefined) return null;
  const end = text.indexOf(END_MARKER, match.index + match[0].length);
  if (end < 0) return null;
  return text.slice(match.index, end + END_MARKER.length);
}

/**
 * Compare the registered standing skeleton surfaces with current store state. A missing or invalid
 * registry is bootstrap, not an error. Circle-scoped surfaces are matched after the caller resolves
 * aliases, so registrations survive circle renames. Only relevant surfaces are read, and each
 * distinct registered path is read at most once.
 */
export function inspectSkeletonMirrors(
  storeHome: string | null,
  circle: string,
  members: readonly SkeletonStateMember[],
  resolveCircle: (circle: string) => string = (value) => value,
): SkeletonMirrorInspection {
  if (storeHome === null) return { globalCovered: false, localCovered: false };

  let manifestText: string;
  try {
    manifestText = readFileSync(join(storeHome, MATERIALIZE_MANIFEST), "utf8");
  } catch {
    return { globalCovered: false, localCovered: false };
  }
  const manifest = parseManifest(manifestText);
  if (manifest === null) return { globalCovered: false, localCovered: false };

  const relevant = manifest.surfaces.filter((surface) =>
    surface.scope === "global" || resolveCircle(surface.scope.circle) === circle,
  );
  const globalCovered = relevant.some((surface) => surface.scope === "global");
  const localCovered = relevant.some((surface) => surface.scope !== "global");
  const globalState = skeletonStateHash(members.filter((member) => member.breadth === "global"));
  const localState = skeletonStateHash(members.filter((member) => member.breadth === "local"));

  const fileCache = new Map<string, string | null>();
  const stale: MirrorStaleEntry[] = [];
  for (const surface of relevant) {
    if (!fileCache.has(surface.path)) {
      try {
        fileCache.set(surface.path, readFileSync(surface.path, "utf8"));
      } catch {
        fileCache.set(surface.path, null);
      }
    }
    const fileText = fileCache.get(surface.path) ?? null;
    const block = fileText === null ? null : skeletonBlock(fileText);
    const materialized = Object.prototype.hasOwnProperty.call(manifest.materialized, surface.path)
      ? manifest.materialized[surface.path]
      : undefined;
    let reason: MirrorStaleReason | null = null;
    if (block === null || materialized === undefined) reason = "block-missing";
    else if (sha256(block) !== materialized.blockHash) reason = "block-edited";
    else {
      const currentState = surface.scope === "global" ? globalState : localState;
      if (materialized.skeletonState !== currentState) reason = "store-moved";
    }
    if (reason !== null) stale.push({ path: surface.path, reason });
  }

  return {
    globalCovered,
    localCovered,
    ...(stale.length > 0 ? { mirrorStale: stale, instruction: MIRROR_STALE_INSTRUCTION } : {}),
  };
}
