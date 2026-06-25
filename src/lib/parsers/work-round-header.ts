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

export type WorkRoundHeader = ExplicitHeader | GenericHeader;

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

  // Generic: any recognised session-start keyword
  // Also check APPEND_RE which is not covered by SESSION_START.
  if (RE.SESSION_START.test(content) || APPEND_RE.test(content)) {
    return { type: "generic", txIntent: detectTxIntent(content) };
  }

  return null;
}
