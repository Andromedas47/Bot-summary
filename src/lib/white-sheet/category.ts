import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import type { ProductCategory } from "./types";

/**
 * Conservative, explicit product-name rules backed by names already handled by
 * the produce parser/report fixtures. Unknown or ambiguous names intentionally
 * remain uncategorized instead of being guessed from a market label or cultivar.
 */
const CATEGORY_KEYWORDS: ReadonlyArray<{
  category: Exclude<ProductCategory, "uncategorized">;
  keywords: readonly string[];
}> = [
  { category: "durian", keywords: ["ทุเรียน"] },
  {
    category: "fruit",
    keywords: [
      "แตงโม",
      "มะม่วง",
      "เงาะ",
      "ลำไย",
      "มังคุด",
      "แก้วมังกร",
      "ลองกอง",
      "แอปเปิ้ล",
    ],
  },
  {
    category: "vegetable",
    keywords: [
      "ผัก",
      "กะหล่ำ",
      "ถั่วพู",
      "มังลัก",
      "ตั้งโอ๋",
    ],
  },
];

export function classifyProduct(productName: string): ProductCategory {
  const normalized = normalizeProductName(productName);

  for (const rule of CATEGORY_KEYWORDS) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
      return rule.category;
    }
  }

  return "uncategorized";
}
