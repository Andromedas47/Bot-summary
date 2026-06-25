/**
 * Classifies a produce-session header line as either an explicit header
 * (contains seller + market) or a generic header (transaction type only).
 *
 * Explicit: "กี้-วัดทุ่งลานนา เบิก 24/06/2569"
 *   → ExplicitHeader { sellerName: "กี้", marketName: "วัดทุ่งลานนา", txIntent: "เบิก" }
 *
 * Generic: "เบิก", "คืน", "คืนเสีย", "รายการชั่งเบิก", "ชั่งคืนเพิ่ม", ...
 *   → GenericHeader { txIntent: "เบิก" }
 *
 * Handles LINE export prefix "HH:MM sender content" automatically.
 */

import { RE } from "@/lib/parsers/weigh-session/regex";

export type TxIntent =
  | "เบิก"
  | "เบิกเพิ่ม"
  | "คืน"
  | "คืนเสีย"
  | "ชั่งคืนเพิ่ม";

export interface ExplicitHeader {
  type:       "explicit";
  sellerName: string;
  marketName: string;
  txIntent:   TxIntent;
}

export interface GenericHeader {
  type:     "generic";
  txIntent: TxIntent;
}

export interface SellerOnlyHeader {
  type:       "seller_only";
  sellerName: string;
  txIntent:   TxIntent;
}

export type WorkRoundHeader = ExplicitHeader | GenericHeader | SellerOnlyHeader;

// Pattern for append-return (ชั่งคืนเพิ่ม / คืนเพิ่ม).
// Checked before the standard คืน pattern to avoid misclassification.
const APPEND_RE = /ชั่งคืนเพิ่ม|คืนเพิ่ม/;

function detectTxIntent(text: string): TxIntent {
  if (APPEND_RE.test(text))              return "ชั่งคืนเพิ่ม";
  if (RE.TX_TYPE_BEIK_PHERM.test(text)) return "เบิกเพิ่ม";
  if (RE.TX_TYPE_KUEN_SIA.test(text))   return "คืนเสีย";
  if (RE.TX_TYPE_KUEN.test(text))       return "คืน";
  return "เบิก";
}

/**
 * Classifies the first content-bearing line of a produce-session message.
 * Strips LINE export TIME_PREFIX before matching.
 * Returns null if the line does not look like a produce-session header at all.
 */
export function classifyHeader(line: string): WorkRoundHeader | null {
  const prefixMatch = line.match(RE.TIME_PREFIX);
  const content     = prefixMatch ? prefixMatch[3].trim() : line.trim();

  // Explicit: "seller-market txType [date]"
  const smMatch = content.match(RE.SELLER_MARKET);
  if (smMatch) {
    return {
      type:       "explicit",
      sellerName: smMatch[1].trim(),
      marketName: smMatch[2].trim(),
      txIntent:   detectTxIntent(smMatch[3]),
    };
  }

  const sellerOnlyMatch = content.match(INCOMPLETE_SELLER_TX);
  if (sellerOnlyMatch) {
    return {
      type:       "seller_only",
      sellerName: sellerOnlyMatch[1].trim(),
      txIntent:   detectTxIntent(sellerOnlyMatch[2]),
    };
  }

  // Generic: any recognised session-start keyword
  // Also check APPEND_RE which is not covered by SESSION_START.
  if (RE.SESSION_START.test(content) || APPEND_RE.test(content)) {
    return { type: "generic", txIntent: detectTxIntent(content) };
  }

  return null;
}

function headerContent(line: string): string {
  const prefixMatch = line.match(RE.TIME_PREFIX);
  return prefixMatch ? prefixMatch[3].trim() : line.trim();
}

// Standalone transaction keywords — no seller-market required.
const GENERIC_HEADER_START =
  /^(?:รายการชั่ง|รายการเบิก|รายการคืน|ชั่งคืนเพิ่ม|คืนเพิ่ม|เบิก(?:\s|$|เพิ่ม)|คืนเสีย|คืน(?:\s|$)|เสีย\s+\d)/;

const INCOMPLETE_SELLER_TX = new RegExp(
  "^([\\u0E00-\\u0E7F\\d\\s]+?)\\s+(ชั่งคืนเพิ่ม|คืนเพิ่ม|ชั่งคืน|เบิกเพิ่ม|เบิก|คืนเสีย|คืน)(?:\\s|\\d|$)",
);

/**
 * Detects a seller name + transaction type without the required `-market` separator.
 * Example: "น้อย เบิก 25/6/2569" — must not start pending accumulation.
 */
export function isIncompleteProduceHeader(line: string): boolean {
  const content = headerContent(line);
  if (!content) return false;
  if (RE.SELLER_MARKET.test(content)) return false;
  if (GENERIC_HEADER_START.test(content)) return false;
  const sellerOnlyMatch = content.match(INCOMPLETE_SELLER_TX);
  if (!sellerOnlyMatch) return false;
  const intent = detectTxIntent(sellerOnlyMatch[2]);
  return intent === "เบิก" || intent === "เบิกเพิ่ม";
}

/** Standalone "รายการเบิกเพิ่ม" / "เบิกเพิ่ม" — continues an existing Work Round, not a new header. */
export function isProduceAppendLine(line: string): boolean {
  const content = headerContent(line);
  if (!content || RE.SELLER_MARKET.test(content)) return false;
  return RE.TX_TYPE_BEIK_PHERM.test(content);
}

/** Explicit seller-market produce-append header, e.g. "ทดลองใหม่-ตลาดจำลอง รายการเบิกเพิ่ม 28/6/2569". */
export function isExplicitProduceAppendHeader(line: string): boolean {
  const hdr = classifyHeader(line);
  return hdr?.type === "explicit" && hdr.txIntent === "เบิกเพิ่ม";
}

export function hasExplicitProduceAppendStart(text: string): boolean {
  return text.split("\n").some((l) => isExplicitProduceAppendHeader(l.trim()));
}
