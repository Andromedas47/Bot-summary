import { describe, expect, test } from "bun:test";
import { UNCATEGORIZED_CATEGORY_ID } from "@/lib/produce/product-code/category";
import {
  produceCategoryTotals,
  resolveProduceCategory,
  satangOf,
  type ProduceCategoryRow,
} from "./produce-category-totals";

function row(overrides: Partial<ProduceCategoryRow> = {}): ProduceCategoryRow {
  return {
    product_name: "หมอนทอง",
    transaction_type: "เบิก",
    total_amount: 100,
    ...overrides,
  };
}

describe("satangOf", () => {
  test("converts a whole-baht float exactly", () => {
    expect(satangOf(1000)).toBe(100_000);
  });

  test("14.5 × 50 = 725.00 baht converts with no drift", () => {
    expect(satangOf(725)).toBe(72_500);
  });

  test("2.5 × 35 = 87.50 baht converts with no drift", () => {
    expect(satangOf(87.5)).toBe(8_750);
  });

  test("rounds a sub-satang remainder half-up", () => {
    expect(satangOf(1.005)).toBe(101); // 100.5 -> 101 (half-up), never float-truncated to 100
    expect(satangOf(1.004)).toBe(100);
  });

  test("null/undefined/non-finite amounts are 0 satang, never dropped rows", () => {
    expect(satangOf(null)).toBe(0);
    expect(satangOf(undefined)).toBe(0);
    expect(satangOf(NaN)).toBe(0);
  });

  test("negative amounts preserve sign", () => {
    expect(satangOf(-12.5)).toBe(-1_250);
  });
});

describe("resolveProduceCategory", () => {
  test("classifies an exact canonical dictionary name", () => {
    expect(resolveProduceCategory("หมอนทอง")).toBe("ท");
    expect(resolveProduceCategory("กล้วยไข่")).toBe("ม");
    expect(resolveProduceCategory("กระชาย")).toBe("ผ");
    expect(resolveProduceCategory("เห็ดนางฟ้า")).toBe("ห");
    expect(resolveProduceCategory("ผลไม้กล่อง")).toBe("พ");
  });

  test("a reviewed alias resolves to the same category as its canonical name", () => {
    // "หมอน" is the confirmed shop-floor shorthand for "หมอนทอง" (PRODUCT_ALIASES).
    expect(resolveProduceCategory("หมอน")).toBe(resolveProduceCategory("หมอนทอง"));
    expect(resolveProduceCategory("หมอน")).toBe("ท");
  });

  test("an unknown product lands in ไม่จัดหมวด", () => {
    expect(resolveProduceCategory("มะม่วงต่างดาว")).toBe("uncategorized");
  });
});

describe("produceCategoryTotals", () => {
  test("single category: one product, one bucket", () => {
    const result = produceCategoryTotals([
      row({ product_name: "หมอนทอง", transaction_type: "เบิก", total_amount: 1000 }),
    ]);
    expect(result.เบิก.categories).toEqual([
      { id: "ท", label: "ทุเรียน", heading: "🥭 ทุเรียน", totalSatang: 100_000, itemCount: 1 },
    ]);
    expect(result.เบิก.totalSatang).toBe(100_000);
    expect(result.คืน.categories).toEqual([]);
    expect(result.คืนเสีย.categories).toEqual([]);
    expect(result.skipped).toBe(0);
  });

  test("multiple categories in one document, ordered by REPORT_CATEGORY_ORDER", () => {
    const result = produceCategoryTotals([
      row({ product_name: "เห็ดนางฟ้า", transaction_type: "เบิก", total_amount: 200 }),
      row({ product_name: "หมอนทอง", transaction_type: "เบิก", total_amount: 1000 }),
      row({ product_name: "กล้วยไข่", transaction_type: "เบิก", total_amount: 300 }),
    ]);
    // ท (ทุเรียน) before ม (ผลไม้) before ห (เห็ด) — REPORT_CATEGORY_ORDER, not insertion order.
    expect(result.เบิก.categories.map((c) => c.id)).toEqual(["ท", "ม", "ห"]);
    expect(result.เบิก.totalSatang).toBe(100_000 + 30_000 + 20_000);
  });

  test("SUM(per-category subtotals) === SUM(all rows), exactly, as integers", () => {
    const rows = [
      row({ product_name: "หมอนทอง", transaction_type: "เบิก", total_amount: 14.5 * 50 }), // 725.00
      row({ product_name: "กระชาย", transaction_type: "เบิก", total_amount: 2.5 * 35 }), // 87.50
      row({ product_name: "มะม่วงต่างดาว", transaction_type: "เบิก", total_amount: 19.99 }),
    ];
    const result = produceCategoryTotals(rows);
    const flatSum = rows.reduce((sum, r) => sum + satangOf(r.total_amount), 0);
    const categorySum = result.เบิก.categories.reduce((sum, c) => sum + c.totalSatang, 0);
    expect(categorySum).toBe(flatSum);
    expect(categorySum).toBe(result.เบิก.totalSatang);
    expect(result.เบิก.totalSatang).toBe(72_500 + 8_750 + 1_999);
  });

  test("an unknown product lands in ไม่จัดหมวด and is still counted in the grand total", () => {
    const result = produceCategoryTotals([
      row({ product_name: "หมอนทอง", transaction_type: "เบิก", total_amount: 1000 }),
      row({ product_name: "มะม่วงต่างดาว", transaction_type: "เบิก", total_amount: 500 }),
    ]);
    const uncategorized = result.เบิก.categories.find((c) => c.id === "uncategorized");
    expect(uncategorized).toEqual({
      id: "uncategorized",
      label: "ไม่จัดหมวด",
      heading: "❓ ไม่จัดหมวด",
      totalSatang: 50_000,
      itemCount: 1,
    });
    expect(result.เบิก.totalSatang).toBe(150_000);
  });

  test("good return (คืน) and bad return (คืนเสีย) bucket separately", () => {
    const result = produceCategoryTotals([
      row({ product_name: "หมอนทอง", transaction_type: "เบิก", total_amount: 1000 }),
      row({ product_name: "หมอนทอง", transaction_type: "คืน", total_amount: 200 }),
      row({ product_name: "หมอนทอง", transaction_type: "คืนเสีย", total_amount: 50 }),
    ]);
    expect(result.เบิก.totalSatang).toBe(100_000);
    expect(result.คืน.totalSatang).toBe(20_000);
    expect(result.คืนเสีย.totalSatang).toBe(5_000);
    expect(result.netSatang).toBe(100_000 - 20_000 - 5_000);
  });

  test("เบิกเพิ่ม folds into เบิก (and ชั่งคืนเพิ่ม/คืนเสียเพิ่ม fold into their base types)", () => {
    const result = produceCategoryTotals([
      row({ product_name: "หมอนทอง", transaction_type: "เบิก", total_amount: 1000 }),
      row({ product_name: "หมอนทอง", transaction_type: "เบิกเพิ่ม", total_amount: 500 }),
      row({ product_name: "หมอนทอง", transaction_type: "ชั่งคืนเพิ่ม", total_amount: 100 }),
      row({ product_name: "หมอนทอง", transaction_type: "คืนเสียเพิ่ม", total_amount: 30 }),
    ]);
    expect(result.เบิก.totalSatang).toBe(150_000);
    expect(result.เบิก.categories[0]!.itemCount).toBe(2);
    expect(result.คืน.totalSatang).toBe(10_000);
    expect(result.คืนเสีย.totalSatang).toBe(3_000);
  });

  test("an unrecognized transaction_type is excluded from every bucket but counted in skipped", () => {
    const result = produceCategoryTotals([
      row({ product_name: "หมอนทอง", transaction_type: "เบิก", total_amount: 1000 }),
      row({ product_name: "หมอนทอง", transaction_type: "ปรับปรุงสต๊อก", total_amount: 9999 }),
    ]);
    expect(result.skipped).toBe(1);
    expect(result.เบิก.totalSatang).toBe(100_000);
    expect(result.คืน.totalSatang + result.คืนเสีย.totalSatang).toBe(0);
  });

  test("row-order independence: shuffled rows produce identical totals", () => {
    const rows = [
      row({ product_name: "หมอนทอง", transaction_type: "เบิก", total_amount: 1000 }),
      row({ product_name: "เห็ดนางฟ้า", transaction_type: "เบิก", total_amount: 250 }),
      row({ product_name: "หมอนทอง", transaction_type: "คืน", total_amount: 150 }),
      row({ product_name: "มะม่วงต่างดาว", transaction_type: "คืนเสีย", total_amount: 42.5 }),
      row({ product_name: "กระชาย", transaction_type: "เบิกเพิ่ม", total_amount: 87.5 }),
    ];
    const reversed = [...rows].reverse();
    const shuffled = [rows[3]!, rows[0]!, rows[4]!, rows[1]!, rows[2]!];

    const a = produceCategoryTotals(rows);
    const b = produceCategoryTotals(reversed);
    const c = produceCategoryTotals(shuffled);

    expect(b.เบิก.totalSatang).toBe(a.เบิก.totalSatang);
    expect(b.คืน.totalSatang).toBe(a.คืน.totalSatang);
    expect(b.คืนเสีย.totalSatang).toBe(a.คืนเสีย.totalSatang);
    expect(b.netSatang).toBe(a.netSatang);
    expect(c.เบิก.totalSatang).toBe(a.เบิก.totalSatang);
    expect(c.คืน.totalSatang).toBe(a.คืน.totalSatang);
    expect(c.คืนเสีย.totalSatang).toBe(a.คืนเสีย.totalSatang);
    expect(c.netSatang).toBe(a.netSatang);
  });

  test("empty categories are omitted from the ordered array", () => {
    const result = produceCategoryTotals([row({ product_name: "หมอนทอง", transaction_type: "เบิก", total_amount: 1000 })]);
    expect(result.เบิก.categories).toHaveLength(1);
    expect(result.คืน.categories).toEqual([]);
    expect(result.คืนเสีย.categories).toEqual([]);
  });

  describe("knownNames is caller context, never self-derived", () => {
    // `เพิ่ม` is a prefix the alias layer may strip, but only when the caller
    // authorizes it. Deriving that authorization from the rows themselves made
    // a row's category depend on its neighbours.
    const prefixed = [row({ product_name: "เพิ่มหมอนทอง", transaction_type: "เบิก", total_amount: 100 })];

    test("defaults to a pure function of each row's own name", () => {
      expect(produceCategoryTotals(prefixed).เบิก.categories[0]!.id)
        .toBe(UNCATEGORIZED_CATEGORY_ID);
    });

    test("a sibling row cannot authorize the strip on its own", () => {
      const withSibling = [
        ...prefixed,
        row({ product_name: "หมอนทอง", transaction_type: "เบิก", total_amount: 100 }),
      ];
      const ids = produceCategoryTotals(withSibling).เบิก.categories.map((c) => c.id);
      expect(ids).toContain(UNCATEGORIZED_CATEGORY_ID);
      expect(ids).toContain("ท");
    });

    test("an explicit knownNames set from a caller with real context does authorize it", () => {
      // What a day-wide report would legitimately pass.
      const result = produceCategoryTotals(prefixed, new Set(["หมอนทอง"]));
      expect(result.เบิก.categories).toHaveLength(1);
      expect(result.เบิก.categories[0]!.id).toBe("ท");
      // Reclassifying must never move money.
      expect(result.เบิก.totalSatang).toBe(10_000);
    });
  });
});
