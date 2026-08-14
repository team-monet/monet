/**
 * Transcript spans — the address a provenance edge points at.
 *
 * A provenance edge (rule → transcript span) has to name a *location inside a conversation*, which
 * is not a concept id and not an ordinary `source_refs` string. It gets its own URI scheme so that
 * a span is distinguishable from every other kind of reference by inspection alone:
 *
 *     span://<host>/<session-id>#<anchor>
 *
 * `host` names the agent host that produced the transcript (`claude-code`, and whatever comes
 * later). `session-id` identifies the conversation within that host. `anchor` locates the region
 * within the session, and its grammar is HOST-SPECIFIC: this module interprets `claude-code`
 * anchors (`L<start>-L<end>`, a JSONL line range) and carries every other host's anchor OPAQUELY.
 * Carrying an unknown anchor rather than rejecting it is deliberate — a new host must be storable
 * before its anchor grammar is understood here, otherwise adding a host is a schema migration.
 *
 * ENCODING RULE (the reason parse/format are a matched pair rather than string concatenation):
 * `session-id` and `anchor` are percent-encoded with encodeURIComponent/decodeURIComponent; `host`
 * is not encoded at all and is instead restricted to a grammar that needs no escaping. That makes
 * the three delimiters (`://`, the first `/`, the first `#`) unambiguous: a session id containing
 * `/` or `#` cannot forge a boundary, because formatSpan escapes both and parseSpan rejects a raw
 * one.
 *
 * The mapping is BIJECTIVE, deliberately: parseSpan accepts only the exact spelling formatSpan
 * emits, so `parseSpan(formatSpan(x))` deep-equals `x` AND `formatSpan(parseSpan(s)) === s` for
 * every `s` that parses at all. A lenient parser would be friendlier and wrong — a span is stored
 * in a column and compared by string equality, and two spellings of one location would silently
 * defeat that comparison.
 */

/** The parts of a span URI. `anchor` is host-specific and uninterpreted at this level. */
export interface TranscriptSpan {
  /** Agent host that produced the transcript, e.g. `claude-code`. Lowercase, unescaped. */
  host: string;
  /** Conversation identifier within `host`. Any non-empty string; escaped in the URI. */
  sessionId: string;
  /** Host-specific location within the session. Any non-empty string; escaped in the URI. */
  anchor: string;
}

/** The scheme prefix every span URI starts with. */
export const SPAN_SCHEME = "span://";

/**
 * Hosts are a small closed vocabulary of agent products, not user data, so they get a grammar
 * strict enough to need no escaping: lowercase alphanumerics, `-` and `.`, leading alphanumeric.
 * Anything else is a caller bug rather than an exotic-but-valid identifier.
 */
const HOST_RE = /^[a-z0-9][a-z0-9.-]*$/;

/** The first host with an interpreted anchor grammar. */
export const CLAUDE_CODE_HOST = "claude-code";

/** `claude-code` anchors address a line range in the session's JSONL transcript, 1-based inclusive. */
export interface ClaudeCodeAnchor {
  startLine: number;
  endLine: number;
}

// No leading zeros: `L01-L02` would otherwise be a second spelling of the location `L1-L2` formats,
// reintroducing at the anchor layer exactly the ambiguity the URI layer's canonicity rule removes.
const CLAUDE_CODE_ANCHOR_RE = /^L(0|[1-9]\d*)-L(0|[1-9]\d*)$/;

/**
 * Anchor validators for hosts whose grammar this build understands. A host in this table has its
 * anchors CHECKED by parseSpan; every other host's anchor stays opaque.
 *
 * The asymmetry is the design, not an oversight: a new host must be storable before its grammar is
 * understood here (otherwise adding a host is a schema migration), while a host we DO understand
 * must not accept two spellings of one location — string equality on `dst_span` is how provenance
 * edges are compared.
 */
const HOST_ANCHOR_VALIDATORS: Record<string, (anchor: string) => boolean> = {
  [CLAUDE_CODE_HOST]: (anchor) => parseClaudeCodeAnchor(anchor) !== null,
};

/**
 * Cheap syntactic test for "this string claims to be a span". Deliberately NOT
 * `parseSpan(s) !== null`: the two answer different questions. A caller sorting a mixed list of
 * `source_refs` uses this to decide whether a string is in the span namespace at all; a MALFORMED
 * span must then fail loudly through parseSpan rather than being silently misfiled as an ordinary
 * reference, which is exactly what a `parseSpan(s) !== null` test would do.
 */
export function isSpanRef(value: string): boolean {
  return value.startsWith(SPAN_SCHEME);
}

/**
 * Build a canonical span URI. Throws on an unusable span rather than returning null: producing a
 * reference is a write path, and a malformed host/session/anchor is a programming error that must
 * not reach the database as a plausible-looking string.
 */
export function formatSpan(span: TranscriptSpan): string {
  if (!HOST_RE.test(span.host)) {
    throw new Error(
      `span host '${span.host}' is not a valid host (lowercase alphanumerics, '-' and '.', leading alphanumeric)`,
    );
  }
  if (span.sessionId.length === 0) throw new Error("span session id must not be empty");
  if (span.anchor.length === 0) throw new Error("span anchor must not be empty");
  // The SAME per-host validator parseSpan applies. Without this the two halves disagree: formatSpan
  // would happily emit `span://claude-code/s#line-1`, which parseSpan then rejects — a URI the
  // library produced and cannot read back, which is the bijection broken from the writing side.
  const validate = HOST_ANCHOR_VALIDATORS[span.host];
  if (validate && !validate(span.anchor)) {
    throw new Error(`span anchor ${JSON.stringify(span.anchor)} is not valid for host '${span.host}'`);
  }
  return `${SPAN_SCHEME}${span.host}/${encodeField(span.sessionId, "session id")}#${encodeField(span.anchor, "anchor")}`;
}

/**
 * encodeURIComponent throws URIError on a lone surrogate — a string that is valid JS but has no
 * UTF-8 encoding. The length/emptiness guards above cannot see it, so without this the function
 * escapes a raw "URI malformed" with no indication of which field or value caused it. Rethrow in
 * the same shape as every other formatSpan rejection.
 */
function encodeField(value: string, field: string): string {
  try {
    return encodeURIComponent(value);
  } catch (cause) {
    throw new Error(`span ${field} ${JSON.stringify(value)} is not encodable (unpaired surrogate)`, { cause });
  }
}

/**
 * Parse a span URI, strictly. Returns null for every string that is not a well-formed span —
 * including ordinary `source_refs` values, which is how a caller tells the two apart. Rejects a
 * raw `/` in the session-id position and a raw `#` in the anchor position: both would be an
 * ambiguous parse, and formatSpan never emits them.
 */
export function parseSpan(uri: string): TranscriptSpan | null {
  if (!uri.startsWith(SPAN_SCHEME)) return null;
  const rest = uri.slice(SPAN_SCHEME.length);

  const hashIndex = rest.indexOf("#");
  if (hashIndex === -1) return null; // a span addresses a REGION, so the anchor is mandatory
  const head = rest.slice(0, hashIndex);
  const rawAnchor = rest.slice(hashIndex + 1);
  if (rawAnchor.includes("#")) return null;

  const slashIndex = head.indexOf("/");
  if (slashIndex === -1) return null;
  const host = head.slice(0, slashIndex);
  const rawSessionId = head.slice(slashIndex + 1);
  if (rawSessionId.includes("/")) return null;

  if (!HOST_RE.test(host)) return null;
  if (rawSessionId.length === 0 || rawAnchor.length === 0) return null;

  let sessionId: string;
  let anchor: string;
  try {
    // Malformed escapes ('%ZZ', a trailing '%') throw URIError — a malformed span, not a crash.
    sessionId = decodeURIComponent(rawSessionId);
    anchor = decodeURIComponent(rawAnchor);
  } catch {
    return null;
  }
  if (sessionId.length === 0 || anchor.length === 0) return null;

  // CANONICITY. A span is stored in a column and compared by string equality, so two spellings must
  // never denote one location — otherwise two provenance edges could address the same transcript
  // region and never compare equal. Requiring the input to be exactly what formatSpan would emit
  // makes the mapping bijective: `span://h/s#a/b` is rejected in favour of `span://h/s#a%2Fb`.
  if (encodeURIComponent(sessionId) !== rawSessionId || encodeURIComponent(anchor) !== rawAnchor) return null;

  // Known hosts validate their own anchor grammar; unknown hosts stay opaque (see the table).
  const validate = HOST_ANCHOR_VALIDATORS[host];
  if (validate && !validate(anchor)) return null;

  return { host, sessionId, anchor };
}

/**
 * Interpret a `claude-code` anchor. Returns null when the anchor is not a well-formed line range,
 * which is the normal answer for any other host's anchor — those stay opaque by design.
 */
export function parseClaudeCodeAnchor(anchor: string): ClaudeCodeAnchor | null {
  const match = CLAUDE_CODE_ANCHOR_RE.exec(anchor);
  if (!match) return null;
  const startLine = Number(match[1]);
  const endLine = Number(match[2]);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) return null;
  if (startLine < 1 || endLine < startLine) return null;
  return { startLine, endLine };
}

/** Build a `claude-code` anchor from a 1-based inclusive JSONL line range. */
export function formatClaudeCodeAnchor(range: ClaudeCodeAnchor): string {
  const { startLine, endLine } = range;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error(`invalid claude-code line range L${startLine}-L${endLine}`);
  }
  return `L${startLine}-L${endLine}`;
}
