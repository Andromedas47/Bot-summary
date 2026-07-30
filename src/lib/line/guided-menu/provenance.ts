/**
 * Guided provenance — proving a plain-text command came from a template WE
 * generated, for THIS operator, round and purpose.
 *
 * The problem this exists for: the White Sheet, slip-header and settlement
 * templates are ordinary LINE text. Nothing in the text distinguishes
 *
 *   (a) the template the bot just handed operator A, sent back unedited except
 *       for the numbers, from
 *   (b) a legitimate legacy command someone has typed by hand for years, from
 *   (c) A's template copied by operator B, or edited onto another market/date.
 *
 * Guessing from the text alone forced a choice between blocking (b) and allowing
 * (c). A marker removes the guess: templates carry one extra opaque line, and a
 * message that carries it is held to the strict guided rules while a message
 * that does not is judged only by whether the TARGET it names is owned.
 *
 * Design
 * ------
 *   marker  = "#gp1." + base64url(HMAC-SHA256(key, canonical)[0..16])
 *   key     = LINE_CHANNEL_SECRET — the server secret the webhook already needs
 *             in order to verify LINE's own signatures (src/lib/line/verify.ts).
 *             Reused under its own domain-separation label so a guided marker can
 *             never be confused with, or produced from, a webhook signature.
 *   canonical = purpose ⋮ sourceId ⋮ lineUserId ⋮ market ⋮ businessDate ⋮ generation
 *
 * Properties this gives, and why each matters:
 *
 *   - it is a MAC, not an encoding: no database id, seller name or amount is
 *     exposed, and the fields cannot be read back out of it;
 *   - verification recomputes the expected marker from the AUTHORITATIVE context
 *     (the journey row + the sender's identity) and compares in constant time,
 *     so there is nothing to parse out of attacker-controlled input;
 *   - copying A's message gives B a marker computed for A's lineUserId, which
 *     cannot match B's; editing the market or date changes the canonical string;
 *     a random or truncated marker fails the compare;
 *   - the session generation is in the canonical string, so a template from a
 *     rotated round does not authorise the new one.
 *
 * With no secret configured nothing is signed, `sign` returns null and templates
 * simply carry no marker: they fall back to the unmarked path, which is still
 * ownership-checked. Verification without a secret always fails — a message
 * claiming a marker we cannot check is refused, never trusted.
 *
 * No migration and no state table: the marker is recomputable, so nothing needs
 * to be stored or expired.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { normalizedMarketLabel } from "@/lib/market";

/** Marker wire prefix. `gp1` is the format version. */
export const GUIDED_MARKER_PREFIX = "#gp1.";
/** 16 bytes of HMAC output, base64url — 22 characters. */
const GUIDED_MARKER_BYTES = 16;
const GUIDED_MARKER_BODY_RE = /^[A-Za-z0-9_-]{22}$/;
const GUIDED_MARKER_LINE_RE = /^#gp1\.[A-Za-z0-9_-]{22}$/;
/** Domain separation: this key is also LINE's webhook signing secret. */
const GUIDED_MARKER_DOMAIN = "bot-summary/guided-provenance/v1";
/** ASCII unit separator: cannot occur in a LINE label, so fields cannot merge. */
const FIELD_SEPARATOR = "\u001f";

/** Which template a marker authorises. A slip marker cannot file a White Sheet. */
export type GuidedMarkerPurpose = "white_sheet" | "slip_open" | "settlement";

export type GuidedMarkerFields = {
  purpose: GuidedMarkerPurpose;
  /** LINE group/room/user id the round lives in. */
  sourceId: string;
  /** The operator the template was generated for. */
  lineUserId: string;
  marketLabelNormalized: string;
  businessDate: string;
  /** The produce session generation the round is standing on. */
  sessionGeneration: string;
};

/** The secret, or null when the deployment has none configured. */
export function guidedProvenanceSecret(): string | null {
  const secret = process.env.LINE_CHANNEL_SECRET?.trim();
  return secret ? secret : null;
}

function canonical(fields: GuidedMarkerFields): string | null {
  const market = normalizedMarketLabel(fields.marketLabelNormalized);
  const parts = [
    fields.purpose,
    fields.sourceId.trim(),
    fields.lineUserId.trim(),
    market,
    fields.businessDate.trim(),
    String(fields.sessionGeneration ?? "").trim(),
  ];
  // A field we do not have is not a field we may sign around.
  if (parts.some((part) => part.length === 0)) return null;
  return [GUIDED_MARKER_DOMAIN, ...parts].join(FIELD_SEPARATOR);
}

/**
 * The marker for one template, or null when it cannot be signed (missing field
 * or no configured secret). A null marker is not an error: the template is sent
 * unmarked and the unmarked ownership path applies.
 */
export function signGuidedMarker(
  fields: GuidedMarkerFields,
  secret: string | null = guidedProvenanceSecret(),
): string | null {
  if (!secret) return null;
  const payload = canonical(fields);
  if (!payload) return null;
  const digest = createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest()
    .subarray(0, GUIDED_MARKER_BYTES);
  return `${GUIDED_MARKER_PREFIX}${digest.toString("base64url")}`;
}

/**
 * Split a message into the text the existing parsers see and the marker line.
 *
 * The marker is removed BEFORE any parser runs, so no parser had to learn about
 * it: every existing command keeps its exact syntax and its exact error
 * messages. A message with no marker line comes back unchanged.
 */
export function extractGuidedMarker(text: string): {
  text: string;
  marker: string | null;
} {
  if (!text.includes(GUIDED_MARKER_PREFIX)) return { text, marker: null };
  const lines = text.split("\n");
  const kept: string[] = [];
  let marker: string | null = null;
  for (const line of lines) {
    const candidate = line.trim();
    if (GUIDED_MARKER_LINE_RE.test(candidate)) {
      // Two different markers in one message is a tampered message, not a
      // template: keep the first and let verification decide, but never merge.
      marker ??= candidate;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), marker };
}

/** True when a string is shaped like a marker at all. */
export function isGuidedMarker(value: string): boolean {
  return GUIDED_MARKER_LINE_RE.test(value.trim());
}

/**
 * Does `marker` prove this exact template? Constant-time, and false for every
 * malformed, missing-secret or mismatched case.
 */
export function verifyGuidedMarker(
  marker: string | null | undefined,
  fields: GuidedMarkerFields,
  secret: string | null = guidedProvenanceSecret(),
): boolean {
  if (!marker) return false;
  const provided = marker.trim();
  if (!provided.startsWith(GUIDED_MARKER_PREFIX)) return false;
  const body = provided.slice(GUIDED_MARKER_PREFIX.length);
  if (!GUIDED_MARKER_BODY_RE.test(body)) return false;

  const expected = signGuidedMarker(fields, secret);
  if (!expected) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Append the marker to a generated template, or return it unchanged. */
export function withGuidedMarker(
  template: string,
  fields: GuidedMarkerFields,
  secret: string | null = guidedProvenanceSecret(),
): string {
  const marker = signGuidedMarker(fields, secret);
  return marker ? `${template}\n${marker}` : template;
}
