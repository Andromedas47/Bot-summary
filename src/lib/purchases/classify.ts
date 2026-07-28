import type {
  PurchaseBlockClassification,
  PurchaseBlockInput,
} from "./types";

export const PURCHASE_RESERVED_PREFIXES = [
  "เริ่มซื้อ",
  "ซื้อรายการ",
  "สรุปค่าใช้จ่ายซื้อ",
  "ปิดซื้อ",
] as const;

const HEADER_OPENER =
  /^เริ่มซื้อ [0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4} (?:[0-9]{2}:[0-9]{2}|ไม่ทราบเวลา)$/u;
const ITEM_OPENER = /^ซื้อรายการ [0-9]+$/u;
const COSTS_OPENER = /^สรุปค่าใช้จ่ายซื้อ$/u;
const CLOSE_OPENER = /^ปิดซื้อ [0-9]+ รายการ$/u;

export function startsWithPurchaseReservedPrefix(line: string): boolean {
  return PURCHASE_RESERVED_PREFIXES.some((prefix) => line.startsWith(prefix));
}

export function classifyPurchaseFirstLine(
  line: string,
): PurchaseBlockClassification {
  if (HEADER_OPENER.test(line)) return "HEADER";
  if (ITEM_OPENER.test(line)) return "ITEM";
  if (COSTS_OPENER.test(line)) return "COSTS";
  if (CLOSE_OPENER.test(line)) return "CLOSE";
  if (startsWithPurchaseReservedPrefix(line)) {
    return "INVALID_RESERVED_PURCHASE_BLOCK";
  }
  return "NOT_PURCHASE";
}

export function classifyPurchaseBlock(
  input: PurchaseBlockInput,
): PurchaseBlockClassification {
  const firstNonblank = input.span.lines.find(
    (line) => line.normalizedText.length > 0,
  );
  if (!firstNonblank) return "EMPTY_BLOCK";
  return classifyPurchaseFirstLine(firstNonblank.normalizedText);
}
