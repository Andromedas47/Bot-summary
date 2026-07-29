/**
 * Deterministic Guided Menu Slice 2 evidence builders.
 * Tokens are fixed so focused tests never rewrite random wire values.
 */

import { encodeMenuToken } from "./menu-token";
import {
  buildConfirmPlaceholderMessage,
  buildConfirmPreviewMessage,
  buildCancelledMessage,
  buildDateSelectMessage,
  buildInvalidMenuMessage,
  buildMarketSelectMessage,
  buildTransactionTypeMessage,
  buildUnmappedMessage,
} from "./messages";
import type { GuidedMenuLineMessage } from "./ux-types";

/** Stable 16-byte entropy → valid gpm1 wire token for evidence snapshots. */
export function fixedEvidenceToken(byte: number): string {
  return encodeMenuToken(Buffer.alloc(16, byte & 0xff));
}

export type Slice2EvidenceBundle = {
  transaction_type: GuidedMenuLineMessage[];
  market: GuidedMenuLineMessage[];
  date: GuidedMenuLineMessage[];
  confirm: GuidedMenuLineMessage[];
  confirm_placeholder: GuidedMenuLineMessage[];
  cancelled: GuidedMenuLineMessage[];
  unmapped: GuidedMenuLineMessage[];
  invalid: GuidedMenuLineMessage[];
};

/** Build the committed Thai UX evidence using deterministic tokens only. */
export function buildSlice2EvidenceMessages(): Slice2EvidenceBundle {
  const tWithdraw = fixedEvidenceToken(1);
  const tReturn = fixedEvidenceToken(2);
  const tDamaged = fixedEvidenceToken(3);
  const tKee = fixedEvidenceToken(4);
  const tBackRoot = fixedEvidenceToken(5);
  const tCancel = fixedEvidenceToken(6);
  const tToday = fixedEvidenceToken(7);
  const tYesterday = fixedEvidenceToken(8);
  const tBackMarket = fixedEvidenceToken(9);
  const tConfirm = fixedEvidenceToken(10);
  const tBackDate = fixedEvidenceToken(11);
  const tCancel2 = fixedEvidenceToken(12);

  return {
    transaction_type: [
      buildTransactionTypeMessage({
        withdraw: tWithdraw,
        return: tReturn,
        damagedReturn: tDamaged,
      }),
    ],
    market: [
      buildMarketSelectMessage({
        transactionType: "withdraw",
        sellerLabel: "พี่ดำ",
        markets: [{ code: "kee", label: "ตลาดกี้" }],
        marketTokens: new Map([["kee", tKee]]),
        backToken: tBackRoot,
        cancelToken: tCancel,
      }),
    ],
    date: [
      buildDateSelectMessage({
        transactionType: "withdraw",
        sellerLabel: "พี่ดำ",
        marketLabel: "ตลาดกี้",
        todayToken: tToday,
        yesterdayToken: tYesterday,
        backToken: tBackMarket,
        cancelToken: tCancel,
      }),
    ],
    confirm: [
      buildConfirmPreviewMessage({
        transactionType: "withdraw",
        sellerLabel: "พี่ดำ",
        marketLabel: "ตลาดกี้",
        dateThaiShort: "29/07/2569",
        confirmToken: tConfirm,
        backToken: tBackDate,
        cancelToken: tCancel2,
      }),
    ],
    confirm_placeholder: [buildConfirmPlaceholderMessage()],
    cancelled: [buildCancelledMessage()],
    unmapped: [buildUnmappedMessage()],
    invalid: [buildInvalidMenuMessage()],
  };
}

/** Replace any gpm1 token with a stable placeholder for structural comparison. */
export function normalizeEvidenceTokens(value: unknown): unknown {
  if (typeof value === "string") {
    return /^gpm1:[A-Za-z0-9_-]+$/.test(value) ? "gpm1:<token>" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeEvidenceTokens(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeEvidenceTokens(v);
    }
    return out;
  }
  return value;
}
