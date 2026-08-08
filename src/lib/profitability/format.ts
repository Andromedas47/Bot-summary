/**
 * P3 profitability — Thai plain-text presentation.
 *
 * Presentation only: every number here comes from the snapshot the migration
 * froze. No arithmetic, no re-derivation, and above all no relabelling — the
 * same discipline the P1 sales report follows (see src/lib/sales/message.ts).
 *
 * Two rules do the safety work in this file:
 *
 *   1. An INCOMPLETE snapshot says so at the very top, in its own block, before
 *      any figure appears. Every profit/loss line in an INCOMPLETE snapshot
 *      then carries an explicit "ยังไม่รับรอง" marker, so no figure can be read
 *      as certified no matter which line a reader's eye lands on first.
 *   2. An absent (null) term renders as MONEY_UNPROVABLE — never "0", never
 *      "-". null means the migration could not prove that figure; printing a
 *      zero would turn "we do not know" into "there was none", which is a
 *      different and false claim about the day's money.
 *
 * ── satang → baht ───────────────────────────────────────────────────────────
 * The shared helper satangToBahtText (src/lib/sales/calculate.ts) takes a
 * `number` and cannot be reused here: P3 satang are numeric(24,0) and routinely
 * exceed Number.MAX_SAFE_INTEGER, so passing one through it would round the
 * figure before it was ever printed. satangStringToBahtText below is the
 * string-in/string-out equivalent: BigInt division and string grouping only, no
 * floating-point division by 100 anywhere, and it deliberately produces the
 * same "-1,234.56" shape so the two reports read alike.
 */

import type {
  ProfitabilityIncompleteReason,
  ProfitabilitySnapshot,
} from "./types";

export const PROFITABILITY_TITLE = "📊 สรุปกำไร/ขาดทุน";

/** The only wording allowed above a snapshot whose figures are not certified. */
export const PROFITABILITY_INCOMPLETE_HEADING = "⛔ ยังรับรองตัวเลขไม่ได้";
export const PROFITABILITY_INCOMPLETE_NOTICE =
  "หมายเหตุ: ตัวเลขด้านล่างยังพิสูจน์ไม่ครบ ห้ามใช้อ้างอิงเป็นผลกำไร/ขาดทุนที่รับรองแล้ว";
export const PROFITABILITY_CERTIFIED_HEADING = "✅ รับรองตัวเลขครบถ้วน";
/** Suffix on every money line of an INCOMPLETE snapshot. */
export const PROFITABILITY_UNCERTIFIED_SUFFIX = "(ยังไม่รับรอง)";
export const PROFITABILITY_REASON_HEADING = "สาเหตุที่ยังรับรองไม่ได้";

/** Used wherever a money figure would otherwise print a misleading 0.00 or a dash. */
export const PROFITABILITY_MONEY_UNPROVABLE = "ไม่สามารถพิสูจน์ได้";

export const PROFITABILITY_COGS_LABEL = "ต้นทุนสินค้าที่ขาย (COGS)";
export const PROFITABILITY_DAMAGE_LOSS_LABEL = "มูลค่าของเสีย";
export const PROFITABILITY_STANDARD_MARGIN_LABEL = "กำไรขั้นต้นตามราคากลาง";
export const PROFITABILITY_OPERATING_PL_LABEL = "กำไร/ขาดทุนจากการดำเนินงาน (คาดการณ์)";
export const PROFITABILITY_SHORTAGE_OVERAGE_LABEL = "เงินขาด/เกิน";
export const PROFITABILITY_REALIZED_PL_LABEL = "กำไร/ขาดทุนที่เกิดขึ้นจริง";

/** Plain-language names for every reason the migration can emit. */
const REASON_LABELS: Record<ProfitabilityIncompleteReason, string> = {
  accountability_round_cancelled: "รอบความรับผิดชอบถูกยกเลิก",
  accountability_round_open: "รอบความรับผิดชอบยังไม่ปิด",
  good_return_cost_unvalued: "รายการคืนยังไม่มีต้นทุนกำกับ",
  good_return_quantity_mismatch: "จำนวนคืนในคลังไม่ตรงกับที่ชั่ง",
  issue_cost_unvalued: "รายการเบิกยังไม่มีต้นทุนกำกับ",
  issue_movement_unbound: "ไม่มีรายการเบิกในคลังผูกกับรายการนี้",
  issue_quantity_mismatch: "จำนวนเบิกในคลังไม่ตรงกับที่ชั่ง",
  missing_central_price: "ไม่มีราคากลาง",
  missing_verified_transfers: "ยังไม่มียอดเงินโอนที่ตรวจสอบแล้ว",
  no_round_activity: "รอบนี้ยังไม่มีรายการ",
  pending_produce_sessions: "ยังมีชุดข้อมูลที่ปิดไม่สำเร็จ",
  produce_item_unattributed: "มีรายการที่ยังไม่ได้ระบุสินค้า/หน่วย",
  purchasing_expenses_unattributable: "ยังระบุค่าใช้จ่ายในการซื้อไม่ได้",
  unsupported_round_movement: "มีรายการคลังประเภทที่ยังไม่รองรับผูกกับรอบนี้",
  white_sheet_missing: "ยังไม่มีใบขาวของรอบนี้",
  white_sheet_not_finalized: "ใบขาวยังไม่ได้ปิดยอด",
};

export function profitabilityReasonLabel(reason: ProfitabilityIncompleteReason): string {
  return REASON_LABELS[reason];
}

const SATANG_PER_BAHT = BigInt(100);

/** Thousands separators for an arbitrarily long digit string. No Number involved. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(?:[0-9]{3})+$)/gu, ",");
}

/**
 * Exact satang decimal string → baht text, e.g. "-123456789012345678901234"
 * → "-1,234,567,890,123,456,789,012.34".
 *
 * Pure integer-string arithmetic: the string is split on its sign, parsed with
 * BigInt, and divided by 100 in BigInt. No IEEE-754 double touches the value at
 * any point, so a figure far beyond Number.MAX_SAFE_INTEGER renders exactly.
 *
 * A fractional input is refused rather than rounded: every money column in this
 * layer is numeric(24,0) with a `= trunc()` CHECK, so a fractional satang here
 * means the value did not come from that column and must not be shown as money.
 */
export function satangStringToBahtText(satang: string): string {
  if (typeof satang !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(satang)) {
    throw new Error(`profitability: expected exact whole satang, got ${JSON.stringify(satang)}`);
  }
  const negative = satang.startsWith("-");
  const magnitude = BigInt(negative ? satang.slice(1) : satang);
  const baht = magnitude / SATANG_PER_BAHT;
  const remainder = magnitude % SATANG_PER_BAHT;
  // Zero keeps no sign: "-0" is not a number a reader should ever be shown.
  const sign = negative && magnitude !== BigInt(0) ? "-" : "";
  return `${sign}${groupThousands(baht.toString())}.${remainder.toString().padStart(2, "0")}`;
}

/** True when the exact satang string is strictly negative. Sign only, no arithmetic. */
function isNegativeSatang(satang: string): boolean {
  return satang.startsWith("-") && BigInt(satang.slice(1)) !== BigInt(0);
}

/**
 * One labelled money line.
 *
 * `certified` false appends the "ยังไม่รับรอง" marker to a figure that IS
 * present — an absent figure needs no marker, because MONEY_UNPROVABLE already
 * says something stronger.
 */
function moneyLine(label: string, satang: string | null, certified: boolean): string {
  if (satang === null) return `${label}: ${PROFITABILITY_MONEY_UNPROVABLE}`;
  const suffix = certified ? "" : ` ${PROFITABILITY_UNCERTIFIED_SUFFIX}`;
  return `${label}: ${satangStringToBahtText(satang)} บาท${suffix}`;
}

/**
 * Cash difference reads as a direction, not just a sign: "-250.00" alone is
 * easy to misread as a loss rather than as cash missing from the envelope.
 */
function shortageOverageLine(satang: string | null, certified: boolean): string {
  const base = moneyLine(PROFITABILITY_SHORTAGE_OVERAGE_LABEL, satang, certified);
  if (satang === null) return base;
  if (isNegativeSatang(satang)) return `${base} (เงินขาด)`;
  if (BigInt(satang) === BigInt(0)) return `${base} (พอดี)`;
  return `${base} (เงินเกิน)`;
}

/**
 * The snapshot as one Thai plain-text block.
 *
 * Order is deliberate: identity, then the certification verdict, then the
 * reasons, then the figures. A reader must know whether these numbers can be
 * trusted before reading any of them.
 */
export function formatProfitabilitySnapshot(snapshot: ProfitabilitySnapshot): string {
  const certified = snapshot.certificationState === "CERTIFIED";

  const header = [
    PROFITABILITY_TITLE,
    `รอบความรับผิดชอบ ${snapshot.accountabilityRoundId}`,
    `ฉบับที่ ${snapshot.revision}`,
  ].join("\n");

  const verdict = certified
    ? PROFITABILITY_CERTIFIED_HEADING
    : [PROFITABILITY_INCOMPLETE_HEADING, PROFITABILITY_INCOMPLETE_NOTICE].join("\n");

  const reasons = snapshot.incompleteReasons.length === 0
    ? []
    : [
      [
        PROFITABILITY_REASON_HEADING,
        ...snapshot.incompleteReasons.map((reason) => `• ${profitabilityReasonLabel(reason)}`),
      ].join("\n"),
    ];

  const figures = [
    moneyLine(PROFITABILITY_COGS_LABEL, snapshot.cogsSoldSatang, certified),
    moneyLine(PROFITABILITY_DAMAGE_LOSS_LABEL, snapshot.damageLossSatang, certified),
    moneyLine(PROFITABILITY_STANDARD_MARGIN_LABEL, snapshot.standardMarginSatang, certified),
    moneyLine(PROFITABILITY_OPERATING_PL_LABEL, snapshot.expectedOperatingPlSatang, certified),
    shortageOverageLine(snapshot.shortageOverageSatang, certified),
    moneyLine(PROFITABILITY_REALIZED_PL_LABEL, snapshot.realizedPlSatang, certified),
  ].join("\n");

  return [header, verdict, ...reasons, figures].join("\n\n");
}
