/**
 * Pure financial calculation core — zero I/O, zero dependencies.
 * All monetary values are Thai Baht as plain numbers.
 * See MASTER.md for the full specification.
 *
 * Null semantics: null means the value is unknown/not yet recorded.
 * Numeric zero means a confirmed real value of zero.
 * No difference (money or slip) may be calculated from incomplete inputs.
 */

// ── Six produce categories ────────────────────────────────────────────────────

export interface SixCategoryAmounts {
  เบิก: number;
  เบิกเพิ่ม: number;
  คืน: number;
  คืนเพิ่ม: number;
  คืนเสีย: number;
  คืนเสียเพิ่ม: number;
}

export function zeroCategoryAmounts(): SixCategoryAmounts {
  return { เบิก: 0, เบิกเพิ่ม: 0, คืน: 0, คืนเพิ่ม: 0, คืนเสีย: 0, คืนเสียเพิ่ม: 0 };
}

// ── Transaction-type mapper ───────────────────────────────────────────────────

export type CanonicalCategory =
  | 'เบิก' | 'เบิกเพิ่ม'
  | 'คืน'  | 'คืนเพิ่ม'
  | 'คืนเสีย' | 'คืนเสียเพิ่ม';

/**
 * Maps a database transaction_type string to one of the six canonical categories.
 * Handles the legacy "ชั่งคืนเพิ่ม" → "คืนเพิ่ม" rename.
 * Returns null for any unrecognised type — callers must not silently ignore nulls.
 */
export function mapTransactionType(type: string): CanonicalCategory | null {
  switch (type) {
    case 'เบิก':          return 'เบิก';
    case 'เบิกเพิ่ม':    return 'เบิกเพิ่ม';
    case 'คืน':           return 'คืน';
    case 'คืนเพิ่ม':     return 'คืนเพิ่ม';
    case 'ชั่งคืนเพิ่ม':  return 'คืนเพิ่ม'; // legacy rename
    case 'คืนเสีย':      return 'คืนเสีย';
    case 'คืนเสียเพิ่ม': return 'คืนเสียเพิ่ม';
    default:              return null;
  }
}

// ── Produce rollups ───────────────────────────────────────────────────────────

export interface ProduceResult {
  รวมเบิก: number;
  รวมคืน: number;
  รวมคืนเสีย: number;
  ยอดที่ต้องขายได้: number;
}

export function computeProduce(cats: SixCategoryAmounts): ProduceResult {
  const รวมเบิก    = cats.เบิก + cats.เบิกเพิ่ม;
  const รวมคืน     = cats.คืน + cats.คืนเพิ่ม;
  const รวมคืนเสีย = cats.คืนเสีย + cats.คืนเสียเพิ่ม;
  return {
    รวมเบิก,
    รวมคืน,
    รวมคืนเสีย,
    ยอดที่ต้องขายได้: รวมเบิก - รวมคืน - รวมคืนเสีย,
  };
}

// ── Settlement ────────────────────────────────────────────────────────────────

/**
 * Finance figures from the white sheet.
 * Each required field is number | null — null means not yet recorded.
 * Zero is a valid confirmed value and must never be treated as missing.
 * ค่าแรง / เงินสดเหลือ are display-only breakdowns of ส่งเงินสด; never used in the formula.
 */
export interface FinanceInput {
  เงินโอน: number | null;
  ค่าใช้จ่าย: number | null;
  ส่งเงินสด: number | null;
  /** Display-only breakdown of ส่งเงินสด — never re-added to the total. */
  ค่าแรง?: number;
  /** Display-only breakdown of ส่งเงินสด — never re-added to the total. */
  เงินสดเหลือ?: number;
}

export type MoneyStatus =
  | 'รอกรอกข้อมูลการเงิน'
  | 'ส่งเงินครบ'
  | 'ส่งเงินขาด'
  | 'ส่งเงินเกิน';

export interface SettlementResult {
  /** null when finance is incomplete */
  ยอดขายในใบ: number | null;
  /** null when finance is incomplete */
  ส่วนต่างเงิน: number | null;
  status: MoneyStatus;
  /** |ส่วนต่างเงิน| for "ส่งเงินขาด/ส่งเงินเกิน X.XX บาท" display; null when incomplete */
  displayAmount: number | null;
}

export function computeSettlement(
  ยอดที่ต้องขายได้: number,
  finance: FinanceInput | null,
): SettlementResult {
  const incomplete: SettlementResult = {
    ยอดขายในใบ: null, ส่วนต่างเงิน: null,
    status: 'รอกรอกข้อมูลการเงิน', displayAmount: null,
  };

  if (!finance) return incomplete;

  const transfer = finance.เงินโอน;
  const expenses = finance.ค่าใช้จ่าย;
  const cashSent = finance.ส่งเงินสด;
  if (transfer === null || expenses === null || cashSent === null) return incomplete;

  const ยอดขายในใบ  = transfer + expenses + cashSent;
  const ส่วนต่างเงิน = ยอดที่ต้องขายได้ - ยอดขายในใบ;
  const status: MoneyStatus =
    ส่วนต่างเงิน > 0 ? 'ส่งเงินขาด' :
    ส่วนต่างเงิน < 0 ? 'ส่งเงินเกิน' :
    'ส่งเงินครบ';
  return { ยอดขายในใบ, ส่วนต่างเงิน, status, displayAmount: Math.abs(ส่วนต่างเงิน) };
}

// ── Slip reconciliation (independent of settlement) ───────────────────────────

export type SlipStatus =
  | 'รอยอดเงินโอน'
  | 'รอตรวจสลิป'
  | 'สลิปตรงยอดโอน'
  | 'ยอดโอนมากกว่าสลิปที่พบ'
  | 'ยอดสลิปมากกว่ายอดโอน';

export interface SlipResult {
  /** null when transfer amount or slip total is not yet available */
  ส่วนต่างสลิป: number | null;
  status: SlipStatus;
  /** |ส่วนต่างสลิป| for display; null when status is not a comparison result */
  displayAmount: number | null;
}

/**
 * @param เงินโอนในใบ - null when no transfer amount has been recorded yet
 * @param ยอดสลิปที่ตรวจแล้ว - null when slips have not been checked yet
 */
export function computeSlipDiff(
  เงินโอนในใบ: number | null,
  ยอดสลิปที่ตรวจแล้ว: number | null,
): SlipResult {
  if (เงินโอนในใบ === null) {
    return { ส่วนต่างสลิป: null, status: 'รอยอดเงินโอน', displayAmount: null };
  }
  if (ยอดสลิปที่ตรวจแล้ว === null) {
    return { ส่วนต่างสลิป: null, status: 'รอตรวจสลิป', displayAmount: null };
  }
  const diff = เงินโอนในใบ - ยอดสลิปที่ตรวจแล้ว;
  const status: SlipStatus =
    diff > 0 ? 'ยอดโอนมากกว่าสลิปที่พบ' :
    diff < 0 ? 'ยอดสลิปมากกว่ายอดโอน' :
    'สลิปตรงยอดโอน';
  return { ส่วนต่างสลิป: diff, status, displayAmount: Math.abs(diff) };
}
