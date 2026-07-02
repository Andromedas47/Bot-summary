export type TransactionType = "เบิก" | "เบิกเพิ่ม" | "คืน" | "คืนเสีย";
export type PricingMode     = "unit" | "basis";

export interface WeighSessionItem {
  item_number:      number;
  product_name:     string;
  /** Display/back-compat per-unit price. For basis rows this is a rounded
   *  approximation — round(basis_price / basis_quantity, 2) — never the
   *  source of truth for totals; use basis_quantity/basis_unit/basis_price. */
  price_per_unit:   number;
  quantity:         number | null;
  /** Any non-empty unit text is accepted. Known spellings are normalized to
   *  a canonical form (see units.ts); unrecognized units persist as-is. */
  unit:             string | null;
  section:          string;
  transaction_type: TransactionType;
  /** "basis" for lines like "3หัว20บาท" (3 หัว for 20 บาท); "unit" for the
   *  ordinary "<product><price>บาท" + "<qty><unit>" form. */
  pricing_mode:     PricingMode;
  /** Bundled price basis, already resolved to canonical unit/quantity (see
   *  units.ts). Null for pricing_mode "unit". Total must be computed as
   *  round(quantity * basis_price / basis_quantity, 2), never pre-divided. */
  basis_quantity:   number | null;
  basis_unit:       string | null;
  basis_price:      number | null;
}

export interface WeighSession {
  /** ISO 8601 date converted from Thai Buddhist year, e.g. "2026-05-25" */
  date:             string | null;
  /** คนขาย — from "พี่ดำ-วิหาร เบิก" header, or falls back to sender_name */
  staff_name:       string;
  /** ผู้ส่ง LINE — from TIME_PREFIX sender field */
  sender_name:      string | null;
  /** "HH:MM" from first TIME_PREFIX in the message */
  transaction_time: string | null;
  session_title:    string | null;
  items:            WeighSessionItem[];
  parse_errors:     string[];
}
