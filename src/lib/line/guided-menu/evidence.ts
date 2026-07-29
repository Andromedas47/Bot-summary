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
  buildNoActiveSellerMarketsMessage,
  buildSellerSelectMessages,
  buildTransactionTypeMessage,
  buildUnmappedMessage,
} from "./messages";
import type { GuidedMenuSeller } from "./menu-state-types";
import type { GuidedMenuLineMessage } from "./ux-types";

/** Stable 16-byte entropy → valid gpm1 wire token for evidence snapshots. */
export function fixedEvidenceToken(byte: number): string {
  return encodeMenuToken(Buffer.alloc(16, byte & 0xff));
}

export type Slice2EvidenceBundle = {
  transaction_type: GuidedMenuLineMessage[];
  seller: GuidedMenuLineMessage[];
  market: GuidedMenuLineMessage[];
  date: GuidedMenuLineMessage[];
  confirm: GuidedMenuLineMessage[];
  no_seller_markets: GuidedMenuLineMessage[];
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
  const sellers: GuidedMenuSeller[] = [
    ["ki", "กี้"],
    ["ohm", "โอม"],
    ["jiew", "จิ๋ว"],
    ["noi", "น้อย"],
    ["tan", "แทน"],
    ["tom", "ต้อม"],
    ["wut", "วุฒิ"],
    ["kwan", "ขวัญ"],
    ["mint", "มิ้น"],
    ["phi_dam", "พี่ดำ"],
    ["pla", "ปลา"],
    ["toey", "เต้ย"],
    ["nu_lek", "หนูเล็ก"],
    ["pa_lee", "ป้าลี"],
  ].map(([sellerCode, label], index) => ({
    sellerCode: sellerCode!,
    label: label!,
    active: true,
    sortOrder: (index + 1) * 10,
  }));
  const sellerTokens = new Map(
    sellers.map((seller, index) => [
      seller.sellerCode,
      fixedEvidenceToken(index + 4),
    ]),
  );
  const tBackRoot = fixedEvidenceToken(18);
  const tCancel = fixedEvidenceToken(19);
  const tMarket = fixedEvidenceToken(20);
  const tBackSeller = fixedEvidenceToken(21);
  const tToday = fixedEvidenceToken(22);
  const tYesterday = fixedEvidenceToken(23);
  const tBackMarket = fixedEvidenceToken(24);
  const tConfirm = fixedEvidenceToken(25);
  const tBackDate = fixedEvidenceToken(26);
  const tCancel2 = fixedEvidenceToken(27);

  return {
    transaction_type: [
      buildTransactionTypeMessage({
        withdraw: tWithdraw,
        return: tReturn,
        damagedReturn: tDamaged,
      }),
    ],
    seller: buildSellerSelectMessages({
      transactionType: "withdraw",
      sellers,
      sellerTokens,
      backToken: tBackRoot,
      cancelToken: tCancel,
    }),
    market: [
      buildMarketSelectMessage({
        transactionType: "withdraw",
        sellerLabel: "กี้",
        markets: [{ code: "wat_thung_lanna", label: "วัดทุ่งลานนา" }],
        marketTokens: new Map([["wat_thung_lanna", tMarket]]),
        backToken: tBackSeller,
        cancelToken: tCancel,
      }),
    ],
    date: [
      buildDateSelectMessage({
        transactionType: "withdraw",
        sellerLabel: "กี้",
        marketLabel: "วัดทุ่งลานนา",
        todayToken: tToday,
        yesterdayToken: tYesterday,
        backToken: tBackMarket,
        cancelToken: tCancel,
      }),
    ],
    confirm: [
      buildConfirmPreviewMessage({
        transactionType: "withdraw",
        sellerLabel: "กี้",
        marketLabel: "วัดทุ่งลานนา",
        dateThaiShort: "25/07/2569",
        confirmToken: tConfirm,
        backToken: tBackDate,
        cancelToken: tCancel2,
      }),
    ],
    no_seller_markets: [buildNoActiveSellerMarketsMessage()],
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
