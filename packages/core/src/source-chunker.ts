import { createHash } from "node:crypto";

// REVIEW FIX (Codex P1 finding 1): v3->v4 for the frontmatter array-tolerance change (a flat
// scalar list is now accepted for any key, not just `tags`) — a CLASSIFICATION change, exactly
// like the v2->v3 minimum-chunk-merge bump before it (see source-scanner.test.ts). Without this,
// an already-registered, already-synced source whose working tree hasn't otherwise changed takes
// beginSourceRun's unchanged-snapshot/config noop path (source-ledger.ts) forever — the parser
// never runs again, so a previously-skipped array-frontmatter file stays skipped until a user
// edits the repo or its source config, even on a build that would now accept it. Bumping this
// constant changes computeSourceIngestConfigHash (source-scanner.ts) and therefore
// computeSourceIngestFingerprint (below) for every chunk, which defeats BOTH the source-level noop
// short-circuit AND materializeStagedBindings' (source-sync.ts) per-chunk unchanged-content skip on
// the very next sync of any existing source — forcing one full, real re-scan and re-materialization
// pass regardless of whether the underlying file bytes changed at all.
// v5 (#135): chunk embedding input now carries the file title and heading path
// (contextualizeSourceChunk, engine.ts). The stored content is unchanged, so nothing below would
// notice on its own — an unchanged revision takes the source-level noop path and a rescan carries
// matching fingerprints through materializeStagedBindings' per-chunk skip, leaving every existing
// chunk on its old body-only vector until someone edited the file. Bumping the version is what
// forces one full re-materialization and repairs the stores this change targets (Codex review).
export const SOURCE_CHUNKER_VERSION = "v5";

const CONTENT_HASH_PREFIX = "monet-src-content/v1:sha256:";
const CHUNK_FINGERPRINT_DOMAIN = "monet-src-ingest/v1";
const OPERATION_ID_DOMAIN = "monet-src-op/v2";
export const DEFAULT_SOURCE_MAX_CHUNKS = 100_000;
/**
 * Minimum-chunk merge pass (chunk-quality design, ratified): a section whose trimmed body is
 * under this many UTF-8 bytes is never emitted as its own chunk — see mergeUndersizedSections.
 */
export const MIN_SOURCE_SECTION_BYTES = 200;

class SourceParseDeadlineError extends Error {}
class SourceChunkBudgetError extends Error {}

function checkDeadline(deadlineExceeded?: () => boolean): void {
  if (deadlineExceeded?.()) throw new SourceParseDeadlineError("source parse deadline exceeded");
}

export interface SourceChunkMetadata {
  tags: string[];
  scope: string | null;
  /** Other flat, string-valued YAML frontmatter in UTF-8 byte order by key. */
  frontmatter: Record<string, string>;
}

export interface SourceChunk {
  relativePath: string;
  headingPath: string[];
  /** One-based occurrence of this exact heading path in the file. */
  occurrence: number;
  /** One-based segment within the section. */
  segmentIndex: number;
  /**
   * One-based emission order across the WHOLE file (post-merge). headingPath/occurrence alone
   * cannot recover cross-heading document order (a lexicographic heading comparison would sort
   * "## Apple" before "## Zebra" even when Zebra appears first in the file) — this is the
   * explicit position key a file concept's body reconstruction sorts by (ADR: document order).
   */
  documentSequence: number;
  body: string;
  metadata: SourceChunkMetadata;
  contentHash: string;
  ingestFingerprint: string;
  /** Deterministic path-local reference. The connector may prefix its source authority. */
  sourceRef: string;
}

export interface SourceChunkDiagnostic {
  code: "invalid-frontmatter" | "chunk-budget-exceeded" | "parse-time-exceeded";
  message: string;
  relativePath: string;
}

export interface ChunkSourceTextInput {
  relativePath: string;
  /** Strictly decoded and LF-normalized source text. */
  text: string;
  /** Hash of the original bytes, retained for scanner/ledger correlation. */
  fileContentHash: string;
  /** Hash of the effective scanner/chunker configuration. */
  ingestConfigHash: string;
  /** Inclusive UTF-8 body-byte limit. */
  maxChunkBytes: number;
  /** Cooperative deadline checked throughout parsing and segmentation. */
  deadlineExceeded?: () => boolean;
  /** Inclusive output cardinality budget. */
  maxChunks?: number;
}

export interface ChunkSourceTextResult {
  chunks: SourceChunk[];
  diagnostics: SourceChunkDiagnostic[];
  complete: boolean;
  /**
   * The file's frontmatter `title:` value, trimmed, or null when absent/blank. Always populated
   * from the same frontmatter parse that produces per-chunk metadata — even when the file has
   * ZERO sections (frontmatter-only or empty body) and therefore emits zero chunks, so a file's
   * display title (deriveSourceFileTitle) never depends on it having any chunks at all.
   */
  frontmatterTitle: string | null;
}

interface Section {
  headingPath: string[];
  occurrence: number;
  lines: string[];
}

interface FrontmatterResult {
  bodyLines: string[];
  metadata: SourceChunkMetadata;
  diagnostic?: SourceChunkDiagnostic;
}

interface SegmentUnit {
  text: string;
  fenced: boolean;
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function canonicalizeSourceChunkMetadata(metadata: SourceChunkMetadata): SourceChunkMetadata {
  return {
    tags: [...new Set(metadata.tags)].sort(compareUtf8),
    scope: metadata.scope,
    frontmatter: Object.fromEntries(Object.entries(metadata.frontmatter).sort(([a], [b]) => compareUtf8(a, b))),
  };
}

function canonicalMetadataJson(metadata: SourceChunkMetadata): string {
  const canonical = canonicalizeSourceChunkMetadata(metadata);
  return JSON.stringify([
    ["tags", canonical.tags],
    ["scope", canonical.scope],
    ["frontmatter", Object.entries(canonical.frontmatter)],
  ]);
}

export function computeSourceIngestFingerprint(input: {
  contentHash: string;
  headingPath: readonly string[];
  metadata: SourceChunkMetadata;
  ingestConfigHash: string;
}): string {
  return hashSourceDomain(CHUNK_FINGERPRINT_DOMAIN, [
    input.contentHash,
    JSON.stringify(input.headingPath),
    canonicalMetadataJson(input.metadata),
    SOURCE_CHUNKER_VERSION,
    input.ingestConfigHash,
  ]);
}

/**
 * Hash a fixed ordered field vector. The domain is NUL-terminated and every field is
 * prefixed by an unsigned 64-bit big-endian UTF-8 byte length, so concatenations cannot alias.
 */
export function hashSourceDomain(domain: string, fields: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  hash.update(Buffer.from([0]));
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return `${domain}:sha256:${hash.digest("hex")}`;
}

/** Hash exact bytes without newline or Unicode normalization. */
export function computeSourceContentHash(bytes: Uint8Array): string {
  return `${CONTENT_HASH_PREFIX}${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Stable retry/idempotency key. No caller-controlled field is concatenated ambiguously. */
export function computeSourceOperationId(
  sourceId: string,
  bindingId: string,
  fingerprint: string,
  snapshotId: string,
  generation: number,
): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("generation must be a positive safe integer");
  return hashSourceDomain(OPERATION_ID_DOMAIN, [sourceId, bindingId, fingerprint, snapshotId, String(generation)]);
}

export interface SourceHeadingIdentity {
  relativePath: string;
  headingPath: readonly string[];
  occurrence: number;
}

export function sourceHeadingIdentityKey(identity: SourceHeadingIdentity): string {
  return JSON.stringify([identity.relativePath, identity.headingPath, identity.occurrence]);
}

/** Canonical ref occurrences are assigned by natural identity, never caller or input order. */
export function computeSourceRefOccurrences(identities: readonly SourceHeadingIdentity[]): Map<string, number> {
  const groups = new Map<string, Map<string, SourceHeadingIdentity>>();
  for (const identity of identities) {
    const groupKey = JSON.stringify([identity.relativePath, sourceHeadingAnchor(identity.headingPath)]);
    const group = groups.get(groupKey) ?? new Map<string, SourceHeadingIdentity>();
    group.set(sourceHeadingIdentityKey(identity), identity);
    groups.set(groupKey, group);
  }
  const result = new Map<string, number>();
  for (const group of groups.values()) {
    const keys = [...group.keys()].sort(compareUtf8);
    keys.forEach((key, index) => result.set(key, index + 1));
  }
  return result;
}

/**
 * A YAML flow-sequence value (`[a, b, c]`) reduced to its flat scalar elements — comma-split,
 * trimmed, with matching outer quotes stripped per element (the same per-item shape `tags`' own
 * dedicated parsing below produces). Returns `null` when this substrate's flat frontmatter model
 * cannot represent the value: a mismatched bracket; a stray `[`, `]`, or `{` surviving inside the
 * stripped payload (checked before splitting, so a quoted item can't hide one) — a nested array or
 * an array of objects/maps; or (REVIEW FIX, Codex P2 finding 3) an UNQUOTED item that is itself an
 * implicit YAML flow-mapping entry (`name: Priya`, no braces) — `attendees: [name: Priya]` is a
 * flow sequence containing a mapping entry, not a flat scalar, and silently ingesting it as the
 * literal string "name: Priya" would break the fail-closed contract this substrate promises for
 * genuinely nested frontmatter. A colon immediately followed by whitespace, or a colon at the very
 * end of the trimmed item, is YAML's own mapping-key indicator — checked on the UNQUOTED item only
 * (a quoted item like "10:30 meeting" or "name: Priya" is unambiguously a scalar; quoting is exactly
 * how YAML lets a colon be literal).
 */
function parseFlatScalarList(value: string): string[] | null {
  if (!(value.startsWith("[") && value.endsWith("]"))) return null;
  const payload = value.slice(1, -1);
  if (/[\[\]{}]/.test(payload)) return null;
  if (payload === "") return [];
  const result: string[] = [];
  for (const raw of payload.split(",").map((item) => item.trim())) {
    if (raw === "") continue; // matches the prior .filter(Boolean) semantics
    const quoted =
      raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    if (!quoted && /:(\s|$)/.test(raw)) return null; // implicit flow-mapping entry — genuinely nested
    result.push(quoted ? raw.slice(1, -1) : raw);
  }
  return result;
}

function parseFrontmatter(lines: string[], relativePath: string, deadlineExceeded?: () => boolean): FrontmatterResult {
  const emptyMetadata = (): SourceChunkMetadata => ({ tags: [], scope: null, frontmatter: {} });
  if (lines[0] !== "---") return { bodyLines: lines, metadata: emptyMetadata() };
  const end = lines.slice(1).findIndex((line) => line === "---" || line === "...");
  if (end < 0) {
    return {
      bodyLines: lines,
      metadata: emptyMetadata(),
      diagnostic: {
        code: "invalid-frontmatter",
        message: "opening frontmatter delimiter has no closing delimiter",
        relativePath,
      },
    };
  }

  const flat: Record<string, string> = {};
  for (const line of lines.slice(1, end + 1)) {
    checkDeadline(deadlineExceeded);
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^[ \t]/.test(line)) {
      return {
        bodyLines: lines,
        metadata: emptyMetadata(),
        diagnostic: {
          code: "invalid-frontmatter",
          message: "nested or multiline frontmatter is unsupported",
          relativePath,
        },
      };
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      return {
        bodyLines: lines,
        metadata: emptyMetadata(),
        diagnostic: {
          code: "invalid-frontmatter",
          message: "frontmatter supports only flat key: value entries",
          relativePath,
        },
      };
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key || key in flat) {
      return {
        bodyLines: lines,
        metadata: emptyMetadata(),
        diagnostic: {
          code: "invalid-frontmatter",
          message: key ? `duplicate frontmatter key: ${key}` : "frontmatter key must be nonempty",
          relativePath,
        },
      };
    }
    // REVIEW FIX (Codex P2 finding 2): captured BEFORE stripping — a quoted value is unambiguously
    // a scalar in YAML (quoting is exactly how a scalar that LOOKS like other syntax, e.g.
    // `title: "[Draft]"` or `alias: "[ADR-42]"`, stays a literal scalar). Stripping the quotes
    // first and then re-inspecting the RESULT for a leading `[` — the bug this fixes — cannot tell
    // "[Draft]" (a literal scalar, originally quoted) apart from [Draft] (an actual one-item flow
    // sequence, never quoted); only the pre-strip form carries that distinction.
    const rawValueWasQuoted =
      value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (rawValueWasQuoted) {
      value = value.slice(1, -1);
    }
    if (/^[|>{]/.test(value)) {
      return {
        bodyLines: lines,
        metadata: emptyMetadata(),
        diagnostic: {
          code: "invalid-frontmatter",
          message: "frontmatter supports only flat scalar values, flat scalar lists, and a flat tags list",
          relativePath,
        },
      };
    }
    // Real vaults (Obsidian, etc.) use array-valued frontmatter routinely for keys other than
    // `tags` — attendees, participants, aliases, ... A flat scalar list (no nested array/object)
    // is accepted for ANY key and stored the same shape a plain scalar is: frontmatter is a flat
    // Record<string,string> (canonicalizeSourceChunkMetadata sorts/hashes it as such), so the list
    // is joined back into one comma-separated string rather than inventing a second value shape.
    // `tags` keeps its own dedicated (pre-existing, untouched) bracket handling below — its raw
    // bracketed value passes through here unchanged so that code sees exactly what it saw before.
    // Gated on !rawValueWasQuoted (Codex P2 finding 2): an originally-quoted value is never a list
    // candidate, however bracket-shaped it looks post-strip — see rawValueWasQuoted's own comment.
    if (!rawValueWasQuoted && value.startsWith("[") && key !== "tags") {
      const list = parseFlatScalarList(value);
      if (list === null) {
        return {
          bodyLines: lines,
          metadata: emptyMetadata(),
          diagnostic: {
            code: "invalid-frontmatter",
            message: "frontmatter supports only flat scalar values, flat scalar lists, and a flat tags list",
            relativePath,
          },
        };
      }
      value = list.join(", ");
    }
    flat[key] = value;
  }
  const rawTags = flat.tags ?? "";
  let tagPayload = rawTags;
  if (tagPayload.startsWith("[") || tagPayload.endsWith("]")) {
    if (!(tagPayload.startsWith("[") && tagPayload.endsWith("]"))) {
      return {
        bodyLines: lines,
        metadata: emptyMetadata(),
        diagnostic: { code: "invalid-frontmatter", message: "tags must be a flat scalar list", relativePath },
      };
    }
    tagPayload = tagPayload.slice(1, -1);
  }
  if (/[\[\]{}]/.test(tagPayload)) {
    return {
      bodyLines: lines,
      metadata: emptyMetadata(),
      diagnostic: { code: "invalid-frontmatter", message: "tags must be a flat scalar list", relativePath },
    };
  }
  const tags = tagPayload === ""
    ? []
    : tagPayload.split(",").map((tag) => tag.trim().replace(/^(?:"(.*)"|'(.*)')$/, "$1$2")).filter(Boolean);
  const scope = flat.scope === undefined || flat.scope === "" ? null : flat.scope;
  const { tags: _tags, scope: _scope, ...frontmatter } = flat;
  return {
    bodyLines: lines.slice(end + 2),
    metadata: canonicalizeSourceChunkMetadata({ tags, scope, frontmatter }),
  };
}

/**
 * CODEX FIX (3606534097), John's ruling "A" (shared-classifier, extract-and-share not duplicate):
 * the scanner's pure per-file content checks — UTF-8 validity and frontmatter validity — extracted
 * into one shared, pure function of bytes (no walk state, no I/O). The scanner's processFile calls
 * this as an early gate (source-scanner.ts); the materializer calls it pre-seal, only for the small
 * set of previously-published-and-currently-selected paths, to detect a case pre-seal
 * carry-forward (blocker 5a) structurally cannot: a path still Git-selected this run whose FRESH
 * content would fail the scanner. Deliberately excludes chunk-budget-exceeded — that diagnostic
 * depends on cumulative chunk usage across the whole walk (maxChunks - chunks-used-so-far), so it
 * is not a pure function of one file's bytes and cannot be predicted pre-seal; see the
 * order-dependent residual handling in syncSource (source-sync.ts) for that case instead.
 */
export interface SourceFileClassification {
  /** LF-normalized, BOM-stripped decoded text — present only when the file classifies as valid. */
  text?: string;
  /** Present only when the file classifies as invalid; identical in shape and message text to
   * what the scanner/chunker would independently have produced for the same bytes. */
  diagnostic?: { code: "invalid-utf8" | "invalid-frontmatter"; message: string; relativePath: string };
}

export function classifySourceFileContent(
  bytes: Uint8Array, relativePath: string, deadlineExceeded?: () => boolean,
): SourceFileClassification {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n");
  } catch {
    return { diagnostic: { code: "invalid-utf8", message: "included file is not strict UTF-8", relativePath } };
  }
  // Mirrors chunkSourceText's own (otherwise redundant) normalization exactly, so classification
  // is decided against precisely the same text chunkSourceText would itself parse.
  const normalizedText = decoded.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
  const parsed = parseFrontmatter(normalizedText.split("\n"), relativePath, deadlineExceeded);
  // parseFrontmatter's own diagnostic literals are exhaustively code: "invalid-frontmatter" (never
  // chunk-budget-exceeded/parse-time-exceeded, which chunkSourceText raises elsewhere, not here) —
  // reconstructed rather than narrowed so callers get a precisely-typed, exhaustive result.
  if (parsed.diagnostic) return { diagnostic: { code: "invalid-frontmatter", message: parsed.diagnostic.message, relativePath } };
  return { text: normalizedText };
}

function openingFence(line: string): { marker: "`" | "~"; length: number } | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  // CommonMark does not permit a backtick in a backtick fence's info string.
  if (match[2][0] === "`" && match[3].includes("`")) return undefined;
  return { marker: match[2][0] as "`" | "~", length: match[2].length };
}

function isClosingFence(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const marker = fence.marker === "`" ? "`" : "~";
  const match = new RegExp(`^ {0,3}(${marker}{${fence.length},})[ \\t]*$`).exec(line);
  return match !== null;
}

function atxHeading(line: string): { level: number; text: string } | undefined {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line);
  if (!match) return undefined;
  const raw = match[2] ?? "";
  const text = raw.replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level: match[1].length, text };
}

function sectionsFromMarkdown(lines: string[], deadlineExceeded?: () => boolean): Section[] {
  const sections: Section[] = [];
  const hierarchy: Array<{ level: number; text: string }> = [];
  const occurrences = new Map<string, number>();
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let current: Section = { headingPath: [], occurrence: 1, lines: [] };

  const finish = (): void => {
    if (current.lines.length > 0 || current.headingPath.length > 0) sections.push(current);
  };

  for (const line of lines) {
    checkDeadline(deadlineExceeded);
    if (fence) {
      current.lines.push(line);
      if (isClosingFence(line, fence)) fence = undefined;
      continue;
    }
    const opened = openingFence(line);
    if (opened) {
      fence = opened;
      current.lines.push(line);
      continue;
    }
    const heading = atxHeading(line);
    if (!heading) {
      current.lines.push(line);
      continue;
    }

    finish();
    while (hierarchy.length > 0 && hierarchy[hierarchy.length - 1].level >= heading.level) hierarchy.pop();
    hierarchy.push(heading);
    const headingPath = hierarchy.map((entry) => entry.text);
    const key = JSON.stringify(headingPath);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    current = { headingPath, occurrence, lines: [] };
  }
  finish();
  return sections;
}

function sectionBodyBytes(lines: readonly string[]): number {
  return Buffer.byteLength(trimBlankEdges([...lines]).join("\n"), "utf8");
}

function concatSectionLines(a: readonly string[], b: readonly string[]): string[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  return [...a, "", ...b];
}

/**
 * Minimum-chunk merge pass (chunk-quality design, ratified): a section whose trimmed body is
 * under MIN_SOURCE_SECTION_BYTES is never emitted as its own chunk. Byte size alone decides it —
 * a lone fenced code block or a one-line "See Also" section merges exactly like an undersized
 * prose section; nothing here special-cases fences (segmentUnits downstream still recognizes a
 * fence as its own unit regardless of which section(s) contributed the surrounding lines).
 *
 * An undersized section's lines carry FORWARD into the next section, which keeps ITS heading
 * identity (the earlier, smaller section's identity is dropped — it never becomes a chunk of its
 * own). A run of consecutive undersized sections keeps accumulating forward as long as the
 * accumulated content stays under the minimum; the cap always wins over the minimum, though —
 * merging forward never manufactures a section exceeding maxChunkBytes, so a merge that would
 * bust the cap is skipped and the undersized section is emitted standalone instead (still small,
 * but never oversized). A trailing undersized run at EOF has no next section to merge into, so it
 * instead merges BACKWARD into the section before it (again capped at maxChunkBytes), keeping
 * THAT section's identity. Horizontal rules were never section boundaries to begin with (ATX
 * headings only — sectionsFromMarkdown) so there is nothing special to do for them here.
 */
function mergeUndersizedSections(sections: Section[], maxChunkBytes: number, deadlineExceeded?: () => boolean): Section[] {
  if (sections.length <= 1) return sections;
  const merged: Section[] = [];
  let pending: Section | undefined;
  for (const section of sections) {
    checkDeadline(deadlineExceeded);
    if (pending === undefined) {
      pending = section;
      continue;
    }
    if (sectionBodyBytes(pending.lines) >= MIN_SOURCE_SECTION_BYTES) {
      merged.push(pending);
      pending = section;
      continue;
    }
    // Forward merge: the smaller, earlier `pending` flows into `section`, which keeps its own
    // heading identity — pending's identity is dropped, exactly as the docstring above describes.
    const combinedLines = concatSectionLines(pending.lines, section.lines);
    if (sectionBodyBytes(combinedLines) > maxChunkBytes) {
      merged.push(pending);
      pending = section;
      continue;
    }
    pending = { headingPath: section.headingPath, occurrence: section.occurrence, lines: combinedLines };
  }
  if (pending !== undefined) {
    if (sectionBodyBytes(pending.lines) < MIN_SOURCE_SECTION_BYTES && merged.length > 0) {
      // Backward merge (EOF only): no next section exists, so the trailing undersized run flows
      // INTO the previous emitted section instead, which keeps ITS identity.
      const last = merged[merged.length - 1];
      const combinedLines = concatSectionLines(last.lines, pending.lines);
      if (sectionBodyBytes(combinedLines) <= maxChunkBytes) {
        merged[merged.length - 1] = { headingPath: last.headingPath, occurrence: last.occurrence, lines: combinedLines };
      } else {
        merged.push(pending);
      }
    } else {
      merged.push(pending);
    }
  }
  return merged;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

function segmentUnits(lines: string[], deadlineExceeded?: () => boolean): SegmentUnit[] {
  const units: SegmentUnit[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let fencedLines: string[] = [];
  let paragraphLines: string[] = [];
  const flushParagraph = (): void => {
    if (paragraphLines.length > 0) units.push({ text: paragraphLines.join(""), fenced: false });
    paragraphLines = [];
  };
  for (let index = 0; index < lines.length; index++) {
    checkDeadline(deadlineExceeded);
    const lineWithSeparator = index === lines.length - 1 ? lines[index] : `${lines[index]}\n`;
    if (fence) {
      fencedLines.push(lineWithSeparator);
      if (isClosingFence(lines[index], fence)) {
        units.push({ text: fencedLines.join(""), fenced: true });
        fencedLines = [];
        fence = undefined;
      }
      continue;
    }
    const opened = openingFence(lines[index]);
    if (opened) {
      flushParagraph();
      fence = opened;
      fencedLines = [lineWithSeparator];
    } else {
      paragraphLines.push(lineWithSeparator);
      if (lines[index].trim() === "") flushParagraph();
    }
  }
  if (fencedLines.length > 0) units.push({ text: fencedLines.join(""), fenced: true });
  flushParagraph();
  return units;
}

function splitUtf8(text: string, maxBytes: number, maxParts: number, deadlineExceeded?: () => boolean): string[] {
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const codePoint of text) {
    checkDeadline(deadlineExceeded);
    const size = Buffer.byteLength(codePoint, "utf8");
    if (currentBytes > 0 && currentBytes + size > maxBytes) {
      if (parts.length >= maxParts) throw new SourceChunkBudgetError();
      parts.push(current);
      current = "";
      currentBytes = 0;
    }
    // A valid Unicode scalar is at most four UTF-8 bytes. A smaller configured limit
    // cannot represent this body without emitting an over-budget chunk.
    if (size > maxBytes) return [];
    current += codePoint;
    currentBytes += size;
  }
  if (current.length > 0 || text.length === 0) {
    if (parts.length >= maxParts) throw new SourceChunkBudgetError();
    parts.push(current);
  }
  return parts;
}

function splitNonFenceUnit(text: string, maxBytes: number, maxParts: number, deadlineExceeded?: () => boolean): string[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [text];
  const parts: string[] = [];
  let current = "";
  for (const line of lines) {
    checkDeadline(deadlineExceeded);
    if (Buffer.byteLength(line, "utf8") > maxBytes) {
      if (current) {
        if (parts.length >= maxParts) throw new SourceChunkBudgetError();
        parts.push(current);
        current = "";
      }
      const split = splitUtf8(line, maxBytes, maxParts - parts.length, deadlineExceeded);
      if (split.length === 0) return [];
      for (let index = 0; index < split.length - 1; index++) parts.push(split[index]);
      current = split[split.length - 1];
      continue;
    }
    if (current && Buffer.byteLength(current, "utf8") + Buffer.byteLength(line, "utf8") > maxBytes) {
      if (parts.length >= maxParts) throw new SourceChunkBudgetError();
      parts.push(current);
      current = "";
    }
    current += line;
  }
  if (current || parts.length === 0) {
    if (parts.length >= maxParts) throw new SourceChunkBudgetError();
    parts.push(current);
  }
  return parts;
}

function segmentSection(lines: string[], maxChunkBytes: number, maxSegments: number, deadlineExceeded?: () => boolean): string[] | undefined {
  checkDeadline(deadlineExceeded);
  if (maxSegments < 1) throw new SourceChunkBudgetError();
  const trimmed = trimBlankEdges(lines);
  if (trimmed.length === 0) return [""];
  const units = segmentUnits(trimmed, deadlineExceeded);
  const segments: string[] = [];
  let current = "";
  for (const unit of units) {
    checkDeadline(deadlineExceeded);
    const unitBytes = Buffer.byteLength(unit.text, "utf8");
    if (unitBytes > maxChunkBytes) {
      if (unit.fenced) return undefined;
      const pieces = splitNonFenceUnit(
        unit.text,
        maxChunkBytes,
        maxSegments - segments.length - (current ? 1 : 0),
        deadlineExceeded,
      );
      if (pieces.length === 0) return undefined;
      if (current) {
        if (segments.length >= maxSegments) throw new SourceChunkBudgetError();
        segments.push(current);
        current = "";
      }
      for (let index = 0; index < pieces.length - 1; index++) segments.push(pieces[index]);
      current = pieces[pieces.length - 1];
      continue;
    }
    if (current && Buffer.byteLength(current, "utf8") + unitBytes > maxChunkBytes) {
      if (segments.length >= maxSegments) throw new SourceChunkBudgetError();
      segments.push(current);
      current = "";
    }
    current += unit.text;
  }
  if (current || segments.length === 0) {
    if (segments.length >= maxSegments) throw new SourceChunkBudgetError();
    segments.push(current);
  }
  return segments.map((segment) => segment.replace(/\n+$/, ""));
}

export function sourceHeadingAnchor(headingPath: readonly string[]): string {
  if (headingPath.length === 0) return "_root";
  const joined = headingPath.join("/").normalize("NFC").toLowerCase();
  const slug = joined
    .replace(/[^\p{Letter}\p{Number}/ _-]+/gu, "")
    .trim()
    .replace(/[ _]+/g, "-")
    .replace(/-+/g, "-");
  return slug || "_untitled";
}

/**
 * A source file's display title (file=concept, ratified): its frontmatter `title:` value when
 * present and non-blank, else the filename with its extension stripped. Pure function of the
 * already-parsed frontmatter title and the file's relative path — no I/O, no re-parsing, and no
 * dependency on the file having any chunks (a frontmatter-only or empty file still gets a title).
 */
export function deriveSourceFileTitle(frontmatterTitle: string | null, relativePath: string): string {
  const trimmed = frontmatterTitle?.trim();
  if (trimmed) return trimmed;
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function encodeRelativePath(relativePath: string): string {
  return relativePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function makeSourceRef(
  relativePath: string,
  headingPath: readonly string[],
  occurrence: number,
): string {
  return `${encodeRelativePath(relativePath)}#${encodeURIComponent(sourceHeadingAnchor(headingPath))}~${occurrence}`;
}

/**
 * Parse LF-normalized Markdown into deterministic heading sections. ATX headings inside
 * CommonMark-style backtick/tilde fences are data, never boundaries. Oversized sections are
 * segmented at line boundaries; a fence is atomic and therefore fails closed if it exceeds
 * the inclusive chunk budget.
 */
export function chunkSourceText(input: ChunkSourceTextInput): ChunkSourceTextResult {
  if (!Number.isSafeInteger(input.maxChunkBytes) || input.maxChunkBytes < 1) {
    throw new Error("maxChunkBytes must be a positive safe integer");
  }
  const maxChunks = input.maxChunks ?? DEFAULT_SOURCE_MAX_CHUNKS;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 0) throw new Error("maxChunks must be a nonnegative safe integer");
  const chunks: SourceChunk[] = [];
  const diagnostics: SourceChunkDiagnostic[] = [];
  let documentSequence = 0;
  // Populated as soon as frontmatter is parsed, independent of chunk count (a frontmatter-only or
  // empty-body file still resolves a title) and left null if parsing never gets that far.
  let frontmatterTitle: string | null = null;
  try {
    checkDeadline(input.deadlineExceeded);
    const normalizedText = input.text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
    checkDeadline(input.deadlineExceeded);
    const parsed = parseFrontmatter(normalizedText.split("\n"), input.relativePath, input.deadlineExceeded);
    if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
    const metadata = canonicalizeSourceChunkMetadata(parsed.metadata);
    frontmatterTitle = metadata.frontmatter.title ? metadata.frontmatter.title : null;

    const rawSections = sectionsFromMarkdown(parsed.bodyLines, input.deadlineExceeded);
    checkDeadline(input.deadlineExceeded);
    const sections = mergeUndersizedSections(rawSections, input.maxChunkBytes, input.deadlineExceeded);
    checkDeadline(input.deadlineExceeded);
    const sourceRefOccurrences = computeSourceRefOccurrences(sections.map((section) => ({
      relativePath: input.relativePath,
      headingPath: section.headingPath,
      occurrence: section.occurrence,
    })));
    checkDeadline(input.deadlineExceeded);
    for (const section of sections) {
      checkDeadline(input.deadlineExceeded);
      const sourceRefOccurrence = sourceRefOccurrences.get(sourceHeadingIdentityKey({
        relativePath: input.relativePath,
        headingPath: section.headingPath,
        occurrence: section.occurrence,
      }))!;
      const bodies = segmentSection(section.lines, input.maxChunkBytes, maxChunks - chunks.length, input.deadlineExceeded);
      if (!bodies) {
        diagnostics.push({
          code: "chunk-budget-exceeded",
          message: `a fenced block exceeds the inclusive ${input.maxChunkBytes}-byte chunk limit`,
          relativePath: input.relativePath,
        });
        continue;
      }
      bodies.forEach((body, zeroBasedSegmentIndex) => {
        checkDeadline(input.deadlineExceeded);
        const segmentIndex = zeroBasedSegmentIndex + 1;
        const contentHash = computeSourceContentHash(Buffer.from(body, "utf8"));
        const ingestFingerprint = computeSourceIngestFingerprint({
          contentHash, headingPath: section.headingPath, metadata, ingestConfigHash: input.ingestConfigHash,
        });
        documentSequence += 1;
        chunks.push({
          relativePath: input.relativePath,
          headingPath: [...section.headingPath],
          occurrence: section.occurrence,
          segmentIndex,
          documentSequence,
          body,
          metadata: canonicalizeSourceChunkMetadata(metadata),
          contentHash,
          ingestFingerprint,
          sourceRef: makeSourceRef(input.relativePath, section.headingPath, sourceRefOccurrence),
        });
      });
    }
  } catch (error) {
    if (error instanceof SourceParseDeadlineError) {
      diagnostics.push({ code: "parse-time-exceeded", message: "source parsing exceeded its inclusive deadline", relativePath: input.relativePath });
    } else if (error instanceof SourceChunkBudgetError) {
      diagnostics.push({ code: "chunk-budget-exceeded", message: `source exceeds the inclusive ${maxChunks}-chunk limit`, relativePath: input.relativePath });
    } else {
      throw error;
    }
  }

  return { chunks, diagnostics, complete: diagnostics.length === 0, frontmatterTitle };
}
