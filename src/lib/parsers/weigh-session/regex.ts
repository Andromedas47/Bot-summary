/**
 * All regex patterns for the weigh-session parser.
 *
 * Thai Unicode block U+0E00–U+0E7F covers letters, vowels, and tone marks.
 * Quantity lines use the trailing-dot format produced by scales: "38.1.โล".
 */

// Thai character class (letters + vowel signs + tone marks, all in U+0E00-U+0E7F)
const TH = "\\u0E00-\\u0E7F";
const MARKET = `${TH}\\d\\sฯๆ().\\-/`;

export const RE = {
  // "18:53 เสือ <content>" — time separator can be colon or dot
  // Captures: [1]=time, [2]=sender, [3]=content
  TIME_PREFIX: /^(\d{1,2}[:.]\d{2})\s+(\S+)\s+([\s\S]*)$/,

  // Item line — dot after item number is optional per real examples:
  //   "1.หมอนทอง119บาท"  (with dot)
  //   "2หมอนทอง119บาท"   (no dot)
  // Lazy Thai match stops naturally before the trailing digits+บาท.
  // Captures: [1]=item_number, [2]=product_name, [3]=price
  ITEM: new RegExp(`^(\\d+)\\.?\\s*([${TH}][${TH}\\s]*?)(\\d+(?:\\.\\d+)?)\\s*บาท\\s*$`),

  // Item line without an item number. Used for short correction messages.
  // Captures: [1]=product_name, [2]=price
  ITEM_NO_INDEX: new RegExp(`^([${TH}][${TH}\\s]*?)(\\d+(?:\\.\\d+)?)\\s*บาท\\s*$`),

  // Quantity with unit — trailing dot before unit is optional (scale output format):
  //   "38โล"  "18.5โล"  "38.1.โล"  "28.โล"
  //   "9ลูก"  "23.ลูก"  "6.ลูก"
  //   "13.กล่อง"  "20.แพค"  "5แพค"  "1แพ็ค"  "1แพ็ก"  "1เเพ็ค"
  //   Common typo variants: "แพต" "แพ็ด" "เเพค" "แผค"
  //   "3กำ"  "2มัด"  "5ถุง"  "16หัว"  "1แพ็ค"  "4หวี"
  //   "1เครือ"  "2เข่ง"  "3พวง"  "5ลัง"
  // Captures: [1]=amount, [2]=unit
  QUANTITY: /^(\d+(?:\.\d+)?)\.?\s*(โล|ลูก|กล่อง|แพค|แพ็ค|แพ็ก|เเพ็ค|เเพค|แพต|แพ็ด|แผค|กำ|มัด|ถุง|หัว|หวี|เครือ|เข่ง|พวง|ลัง)\s*$/,

  // Full-line date (anchored to avoid false matches inside item lines):
  //   "25/5/69"   → short Buddhist year 2569 → Gregorian 2026
  //   "18/5/2568" → full Buddhist year  2568 → Gregorian 2025
  // Captures: [1]=day, [2]=month, [3]=year
  DATE_ONLY:    /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.]((?:25)?\d{2})\s*$/,
  DATE_IN_TEXT: /(\d{1,2})[\/\-.](\d{1,2})[\/\-.]((?:25)?\d{2})/,

  // Session title contains รายการชั่ง, เบิก, คืน, or คืนเสีย.
  // Also matches "พี่ดำ-วิหาร เบิก 26/5/2569" via the เบิก keyword.
  SESSION_START: /รายการชั่ง|เบิก|คืนเสีย|คืน|(?:^|\s)เสีย\s+\d{1,2}\/\d{1,2}\/\d{4}/,

  // All observed end markers start with จบรายการ
  SESSION_END: /^จบรายการ/,

  // Section / transaction-type header lines (matched against content after TIME_PREFIX strip):
  //   รายการชั่งเบิก  → เบิก
  //   รายการเบิกเพิ่ม  → เบิกเพิ่ม
  //   รายการชั่งคืน   → คืน
  //   คืนเสีย         → คืนเสีย
  TX_TYPE_BEIK_PHERM: /รายการเบิกเพิ่ม|เบิกเพิ่ม/,
  TX_TYPE_BEIK:       /รายการชั่งเบิก|รายการเบิก|เบิก/,
  TX_TYPE_KUEN_SIA:   /คืนเสีย/,
  TX_TYPE_KUEN:       /รายการชั่งคืน|รายการคืน|คืน/,

  // "พี่ดำ-วิหาร เบิก" or "พี่ดำ-วิหาร เบิกเพิ่ม 26/5/2569"
  // seller = before dash, market = between dash and tx-type keyword
  // Captures: [1]=seller, [2]=market, [3]=tx_type_keyword
  SELLER_MARKET: new RegExp(
    `^([${TH}\\d\\s]+?)-([${MARKET}]+?)\\s+(ชั่งคืนเพิ่ม|คืนเพิ่ม|เบิกเพิ่ม|เบิก|คืนเสีย|คืน)`,
  ),

  // Manual slip session open: "ส่งสลิปมือ 17/06/2569"
  // Anchored at ส่งสลิปมือ only — allows arbitrary prefix (e.g. sender name).
  // Captures: [1]=date string (DD/MM/YY or DD/MM/YYYY Buddhist)
  MANUAL_SLIP_OPEN: /ส่งสลิปมือ\s+(\d{1,2}\/\d{1,2}\/(?:25)?\d{2})/,

  // Manual slip session close: "จบสลิปมือ"
  MANUAL_SLIP_CLOSE: /^จบสลิปมือ\s*$/,

  // ชั่งคืนเพิ่ม / คืนเพิ่ม — append-return transaction type (V2).
  // Must be tested BEFORE TX_TYPE_KUEN to prevent misclassification as คืน.
  TX_TYPE_APPEND_RETURN: /ชั่งคืนเพิ่ม|คืนเพิ่ม/,

  // LINE-first settlement command (V2): "ส่งเงิน 24/06/2569" or "ปิดยอด 24/06/2569"
  // Captures: [1]=date string (Buddhist DD/MM/YY or DD/MM/YYYY)
  SETTLEMENT_CMD: /^(?:ส่งเงิน|ปิดยอด)\s+(\d{1,2}\/\d{1,2}\/(?:25)?\d{2})\s*$/,

  // Settlement / finance summary lines — must never become produce items.
  RESERVED_FINANCIAL:
    /^(?:ยอดเบิก|ยอดคืนเสีย|ยอดคืน|ยอดที่ต้องขายได้|ยอดเงินโอน|ยอดสลิปมือ|ยอดรวมสลิป|ยอดรวม|ส่งเงินจริง|ส่งเงินขาด|ส่งเงินเกิน|เงินโอนไม่ขาด|ยอดเงินขาด|ตรวจสลิป|ขาดจากยอดเงินโอน)\b/,
} as const;

export function isReservedFinancialLine(content: string): boolean {
  return RE.RESERVED_FINANCIAL.test(content.trim());
}
