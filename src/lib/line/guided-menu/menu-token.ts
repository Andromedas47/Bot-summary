/**
 * Opaque Guided Menu postback token format: `gpm1:<base64url-raw>`.
 * Raw entropy is 16 bytes (128 bits). Business values never embed in the token.
 */

import { createHash } from "crypto";

export const MENU_TOKEN_PREFIX = "gpm1:";
export const MENU_TOKEN_RAW_BYTES = 16;
/** Compact wire form stays well under LINE postback data limits (~300 bytes). */
export const MENU_TOKEN_MAX_WIRE_LENGTH = 64;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type MenuTokenParseFailure =
  | "empty"
  | "wrong_prefix"
  | "invalid_charset"
  | "bad_padding"
  | "wrong_length"
  | "oversize"
  | "whitespace"
  | "unicode";

export type MenuTokenParseResult =
  | { ok: true; raw: Buffer }
  | { ok: false; reason: MenuTokenParseFailure };

export function generateRawMenuToken(randomBytes: (n: number) => Buffer): Buffer {
  const raw = randomBytes(MENU_TOKEN_RAW_BYTES);
  if (raw.length !== MENU_TOKEN_RAW_BYTES) {
    throw new Error(`menu token entropy must be ${MENU_TOKEN_RAW_BYTES} bytes`);
  }
  return raw;
}

export function encodeMenuToken(raw: Buffer): string {
  if (raw.length !== MENU_TOKEN_RAW_BYTES) {
    throw new Error(`menu token entropy must be ${MENU_TOKEN_RAW_BYTES} bytes`);
  }
  return `${MENU_TOKEN_PREFIX}${raw.toString("base64url")}`;
}

export function parseMenuToken(wire: string): MenuTokenParseResult {
  if (typeof wire !== "string") {
    return { ok: false, reason: "empty" };
  }
  if (wire.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (wire.length > MENU_TOKEN_MAX_WIRE_LENGTH) {
    return { ok: false, reason: "oversize" };
  }
  if (/\s/.test(wire)) {
    return { ok: false, reason: "whitespace" };
  }
  if (/[^\x00-\x7F]/.test(wire)) {
    return { ok: false, reason: "unicode" };
  }
  if (!wire.startsWith(MENU_TOKEN_PREFIX)) {
    return { ok: false, reason: "wrong_prefix" };
  }
  const body = wire.slice(MENU_TOKEN_PREFIX.length);
  if (body.length === 0) {
    return { ok: false, reason: "wrong_length" };
  }
  if (body.includes("=")) {
    return { ok: false, reason: "bad_padding" };
  }
  if (!BASE64URL_RE.test(body)) {
    return { ok: false, reason: "invalid_charset" };
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(body, "base64url");
  } catch {
    return { ok: false, reason: "invalid_charset" };
  }
  if (raw.length !== MENU_TOKEN_RAW_BYTES) {
    return { ok: false, reason: "wrong_length" };
  }
  // Reject non-canonical encodings (truncation / alternate alphabet tricks).
  if (raw.toString("base64url") !== body) {
    return { ok: false, reason: "invalid_charset" };
  }
  return { ok: true, raw };
}

export function hashMenuToken(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function hashMenuTokenWire(wire: string): string | null {
  const parsed = parseMenuToken(wire);
  if (!parsed.ok) return null;
  return hashMenuToken(parsed.raw);
}
