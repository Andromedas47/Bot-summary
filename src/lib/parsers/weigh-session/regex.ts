/**
 * All regex patterns for the weigh-session parser.
 *
 * Thai Unicode block U+0E00–U+0E7F covers letters, vowels, and tone marks.
 * Quantity lines use the trailing-dot format produced by scales: "38.1.โล".
 */

// Thai character class (letters + vowel signs + tone marks, all in U+0E00-U+0E7F)
const TH = "\\u0E00-\\u0E7F";

export const RE = {
  // "18:53 เสือ <content>" — time separator can be colon or dot
  // Captures: [1]=time, [2]=sender, [3]=content
  TIME_PREFIX: /^(\d{1,2}[:.]\d{2})\s+(\S+)\s+([\s\S]*)$/,

  // Item line — dot after item number is optional per real examples:
  //   "1.หมอนทอง119บาท"  (with dot)
  //   "2หมอนทอง119บาท"   (no dot)
  // Lazy Thai match stops naturally before the trailing digits+บาท.
  // Captures: [1]=item_number, [2]=product_name, [3]=price
  ITEM: new RegExp(`^(\\d+)\\.?([${TH}][${TH}\\s]*?)(\\d+(?:\\.\\d+)?)\\s*บาท\\s*$`),

  // Quantity with unit — trailing dot before unit is optional (scale output format):
  //   "38โล"  "18.5โล"  "38.1.โล"  "28.โล"
  //   "9ลูก"  "23.ลูก"  "6.ลูก"
  //   "13.กล่อง"
  // Captures: [1]=amount, [2]=unit
  QUANTITY: /^(\d+(?:\.\d+)?)\.?\s*(โล|ลูก|กล่อง)\s*$/,

  // Full-line date (anchored to avoid false matches inside item lines):
  //   "25/5/69"   → short Buddhist year 2569 → Gregorian 2026
  //   "18/5/2568" → full Buddhist year  2568 → Gregorian 2025
  // Captures: [1]=day, [2]=month, [3]=year
  DATE_ONLY:    /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.]((?:25)?\d{2})\s*$/,
  DATE_IN_TEXT: /(\d{1,2})[\/\-.](\d{1,2})[\/\-.]((?:25)?\d{2})/,

  // Session title contains รายการชั่ง, เบิก, คืน, or คืนเสีย.
  // Also matches "พี่ดำ-วิหาร เบิก 26/5/2569" via the เบิก keyword.
  SESSION_START: /รายการชั่ง|เบิก|คืนเสีย|คืน/,

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
    `^([${TH}]+)-([${TH}\\s]+?)\\s+(เบิกเพิ่ม|เบิก|คืนเสีย|คืน)`,
  ),
} as const;
