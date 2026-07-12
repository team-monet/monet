import { createHash } from "node:crypto";

export const SOURCE_CHUNKER_VERSION = "v2";

const CONTENT_HASH_PREFIX = "monet-src-content/v1:sha256:";
const CHUNK_FINGERPRINT_DOMAIN = "monet-src-ingest/v1";
const OPERATION_ID_DOMAIN = "monet-src-op/v2";
export const DEFAULT_SOURCE_MAX_CHUNKS = 100_000;

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
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[|>{]/.test(value) || (key !== "tags" && value.startsWith("["))) {
      return {
        bodyLines: lines,
        metadata: emptyMetadata(),
        diagnostic: {
          code: "invalid-frontmatter",
          message: "frontmatter supports only flat scalar values and a flat tags list",
          relativePath,
        },
      };
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
  try {
    checkDeadline(input.deadlineExceeded);
    const normalizedText = input.text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
    checkDeadline(input.deadlineExceeded);
    const parsed = parseFrontmatter(normalizedText.split("\n"), input.relativePath, input.deadlineExceeded);
    if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
    const metadata = canonicalizeSourceChunkMetadata(parsed.metadata);

    const sections = sectionsFromMarkdown(parsed.bodyLines, input.deadlineExceeded);
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
        chunks.push({
          relativePath: input.relativePath,
          headingPath: [...section.headingPath],
          occurrence: section.occurrence,
          segmentIndex,
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

  return { chunks, diagnostics, complete: diagnostics.length === 0 };
}
