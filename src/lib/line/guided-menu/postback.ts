import {
  ALL_TX_CODES,
  type DecodePostbackResult,
  type GuidedMenuAction,
  type GuidedMenuDateMode,
  type GuidedMenuTxCode,
  type GuidedProducePostbackV1,
} from "./types";

export const GUIDED_MENU_POSTBACK_PREFIX = "gpm.v1.";
export const GUIDED_MENU_POSTBACK_VERSION = 1 as const;

const ACTIONS = new Set<GuidedMenuAction>([
  "menu",
  "select_tx",
  "select_market",
  "other_market",
  "select_date",
  "custom_date",
  "set_custom_date",
  "confirm_open",
  "start_session",
  "status",
  "close_ask",
  "close_confirm",
  "close_cancel",
  "back",
]);

const DATE_MODES = new Set<GuidedMenuDateMode>(["today", "yesterday", "custom"]);
const TX_CODES = new Set<string>(ALL_TX_CODES);

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): Uint8Array | null {
  try {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (padded.length % 4)) % 4;
    const b64 = padded + "=".repeat(padLen);
    const bin = typeof atob === "function"
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function isValidIsoCalendarDate(iso: string): boolean {
  const match = ISO_DATE_RE.exec(iso);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return (
    utcNoon.getUTCFullYear() === year
    && utcNoon.getUTCMonth() === month - 1
    && utcNoon.getUTCDate() === day
  );
}

function assertPayloadShape(raw: unknown): DecodePostbackResult {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "payload_not_object" };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.v !== 1) {
    return { ok: false, reason: "unsupported_version" };
  }

  if (typeof obj.a !== "string" || !ACTIONS.has(obj.a as GuidedMenuAction)) {
    return { ok: false, reason: "invalid_action" };
  }

  const payload: GuidedProducePostbackV1 = {
    v: 1,
    a: obj.a as GuidedMenuAction,
  };

  if ("tok" in obj) {
    if (obj.tok != null && typeof obj.tok !== "string") {
      return { ok: false, reason: "invalid_tok" };
    }
    if (typeof obj.tok === "string") {
      if (obj.tok.length > 64) return { ok: false, reason: "tok_too_long" };
      payload.tok = obj.tok;
    }
  }

  if ("tx" in obj && obj.tx != null) {
    if (typeof obj.tx !== "string" || !TX_CODES.has(obj.tx)) {
      return { ok: false, reason: "invalid_tx" };
    }
    payload.tx = obj.tx as GuidedMenuTxCode;
  }

  if ("mid" in obj && obj.mid != null) {
    if (typeof obj.mid !== "string" || !/^[a-z0-9_]{1,32}$/.test(obj.mid)) {
      return { ok: false, reason: "invalid_mid" };
    }
    payload.mid = obj.mid;
  }

  if ("dm" in obj && obj.dm != null) {
    if (typeof obj.dm !== "string" || !DATE_MODES.has(obj.dm as GuidedMenuDateMode)) {
      return { ok: false, reason: "invalid_dm" };
    }
    payload.dm = obj.dm as GuidedMenuDateMode;
  }

  if ("iso" in obj && obj.iso != null) {
    if (typeof obj.iso !== "string" || !isValidIsoCalendarDate(obj.iso)) {
      return { ok: false, reason: "invalid_iso" };
    }
    payload.iso = obj.iso;
  }

  // Reject unknown keys so tampered payloads cannot smuggle labels.
  const allowed = new Set(["v", "a", "tok", "tx", "mid", "dm", "iso"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `unknown_field:${key}` };
    }
  }

  return { ok: true, payload };
}

/** Encode a validated postback object into compact versioned LINE postback data. */
export function encodeGuidedMenuPostback(payload: GuidedProducePostbackV1): string {
  if (payload.v !== 1) {
    throw new Error("Only postback v1 is supported");
  }
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  const encoded = `${GUIDED_MENU_POSTBACK_PREFIX}${toBase64Url(bytes)}`;
  if (encoded.length > 300) {
    throw new Error(`Postback data exceeds LINE 300-char limit (${encoded.length})`);
  }
  return encoded;
}

/**
 * Decode and validate postback data.
 * Rejects malformed, wrong-version, unknown-field, and invalid code payloads.
 */
export function decodeGuidedMenuPostback(data: string): DecodePostbackResult {
  if (typeof data !== "string" || data.length === 0 || data.length > 300) {
    return { ok: false, reason: "invalid_length" };
  }

  if (!data.startsWith(GUIDED_MENU_POSTBACK_PREFIX)) {
    return { ok: false, reason: "missing_prefix" };
  }

  const body = data.slice(GUIDED_MENU_POSTBACK_PREFIX.length);
  const bytes = fromBase64Url(body);
  if (!bytes) return { ok: false, reason: "invalid_encoding" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  return assertPayloadShape(parsed);
}

export function postbackData(
  action: GuidedMenuAction,
  extras: Omit<GuidedProducePostbackV1, "v" | "a"> = {},
): string {
  return encodeGuidedMenuPostback({ v: 1, a: action, ...extras });
}
