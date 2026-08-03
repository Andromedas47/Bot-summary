import { describe, expect, test } from "bun:test";
import type { Database } from "@/types/database";
import { countCodePoints, LINE_MESSAGE_MAX_CODE_POINTS } from "@/lib/summary/line-chunking";
import { parsePhysicalInventoryDocument } from "./parse";
import {
  buildHouseStockInvalidMessage,
  buildHouseStockReport,
  fetchAuthoritativeHouseStockReport,
  HouseStockSnapshotConflictError,
} from "./house-stock-report";

type Item = Database["public"]["Tables"]["physical_inventory_items"]["Row"];

const COMPLETE = `ผลไม้คงเหลือในบ้าน 3/8/69

1 เขียวมรกต 30 บาท
49.7 โล

2. เขียวมรกต 30.00 บาท
50.1 กก

3) น้อยหน่า 35 บาท
19 กิโลกรัม

จบ`;

function row(overrides: Partial<Item> = {}): Item {
  return {
    id: crypto.randomUUID(),
    snapshot_id: "snapshot",
    item_ordinal: 1,
    staff_sequence: 1,
    raw_text: "1 เขียวมรกต 30 บาท\n49.7 โล",
    raw_product_description: "เขียวมรกต",
    normalized_product: "เขียวมรกต",
    quantity: 49.7,
    unit_price_satang: 3_000,
    raw_unit: "โล",
    normalized_unit: "โล",
    resolution_status: "ACCEPTED_NORMALIZED",
    reason: null,
    created_at: "2026-08-03T00:00:00Z",
    ...overrides,
  };
}

describe("priced House Stock parser", () => {
  test("header/date on one line, numbering variants, aliases, decimal price, and complete message", () => {
    const parsed = parsePhysicalInventoryDocument(COMPLETE, { requireUnitPrice: true });
    expect(parsed.businessDate).toBe("2026-08-03");
    expect(parsed.closeText).toBe("จบ");
    expect(parsed.items.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(parsed.items.map((item) => item.unitPriceSatang)).toEqual([3_000, 3_000, 3_500]);
    expect(parsed.items.map((item) => item.normalizedUnit)).toEqual(["โล", "โล", "โล"]);
    expect(parsed.items.every((item) => item.resolutionStatus === "ACCEPTED_NORMALIZED")).toBe(true);
  });

  test("header/date on separate lines and existing aliases still work", () => {
    for (const header of ["สตอกผลไม้คงเหลือ", "สต๊อกผลไม้คงเหลือ", "สตอกผลไม้คงเหลือวันนี้"]) {
      const parsed = parsePhysicalInventoryDocument(`${header}\n3/8/69\n1 ทุเรียน 30.50 บาท\n1 โล\nจบ`, {
        requireUnitPrice: true,
      });
      expect(parsed.businessDate).toBe("2026-08-03");
      expect(parsed.items[0]?.unitPriceSatang).toBe(3_050);
    }
  });

  test("missing/invalid price and missing/zero/negative quantity or unit fail closed per item", () => {
    const cases = [
      ["1 ทุเรียน\n1 โล", "missing_unit_price"],
      ["1 ทุเรียน 0 บาท\n1 โล", "invalid_unit_price"],
      ["1 ทุเรียน -2 บาท\n1 โล", "invalid_unit_price"],
      ["1 ทุเรียน 30 บาท\nจบ", "missing_quantity"],
      ["1 ทุเรียน 30 บาท\n0 โล", "zero_quantity"],
      ["1 ทุเรียน 30 บาท\n-1 โล", "negative_quantity"],
      ["1 ทุเรียน 30 บาท\n1", "missing_unit"],
    ];
    for (const [body, reason] of cases) {
      const parsed = parsePhysicalInventoryDocument(`ผลไม้คงเหลือในบ้าน 3/8/69\n${body}\nจบ`, {
        requireUnitPrice: true,
      });
      expect(parsed.items[0]?.resolutionStatus).toBe("REJECTED");
      expect(parsed.items[0]?.reason).toBe(reason);
    }
  });

  test("invalid reply identifies exact items", () => {
    const parsed = parsePhysicalInventoryDocument(
      "ผลไม้คงเหลือในบ้าน 3/8/69\n1 ทุเรียน\n1 โล\n2 มังคุด 30 บาท\n2\nจบ",
      { requireUnitPrice: true },
    );
    expect(buildHouseStockInvalidMessage(parsed.items)).toContain("รายการที่ 1: ไม่พบราคาต่อหน่วย");
    expect(buildHouseStockInvalidMessage(parsed.items)).toContain("รายการที่ 2: จำนวนหรือหน่วยไม่ถูกต้อง");
  });
});

describe("priced House Stock summary", () => {
  test("exact example aggregates only same product/unit/price and rounds each item", () => {
    const report = buildHouseStockReport("2026-08-03", [
      row(),
      row({ id: crypto.randomUUID(), item_ordinal: 2, staff_sequence: 2, quantity: 50.1 }),
      row({
        id: crypto.randomUUID(), item_ordinal: 3, staff_sequence: 3,
        raw_product_description: "น้อยหน่า", normalized_product: "น้อยหน่า",
        quantity: 19, unit_price_satang: 3_500,
      }),
    ]);
    const text = report.messages.join("\n\n");
    expect(text).toBe(`🏠 สรุปสต๊อกคงเหลือในบ้าน
ข้อมูลวันที่ 3 สิงหาคม 2569

1. เขียวมรกต — 30 บาท/กก.
49.7 + 50.1 = 99.8 กก.
มูลค่า 2,994.00 บาท

2. น้อยหน่า — 35 บาท/กก.
19 กก.
มูลค่า 665.00 บาท

รวม 118.8 กก.
รวมมูลค่า 3,659.00 บาท`);
    expect(report).toMatchObject({ itemCount: 3, groupCount: 2, totalValueSatang: 365_900 });
  });

  test("different prices and units stay separate; mixed totals never add units", () => {
    const report = buildHouseStockReport("2026-08-03", [
      row({ quantity: 1 }),
      row({ id: crypto.randomUUID(), item_ordinal: 2, quantity: 2, unit_price_satang: 3_050 }),
      row({ id: crypto.randomUUID(), item_ordinal: 3, quantity: 25, raw_unit: "ลูก", normalized_unit: "ลูก" }),
      row({ id: crypto.randomUUID(), item_ordinal: 4, quantity: 3, raw_unit: "กล่อง", normalized_unit: "กล่อง" }),
    ]);
    const text = report.messages.join("\n\n");
    expect(report.groupCount).toBe(4);
    expect(text).toContain("รวมตามหน่วย");
    expect(text).toContain("กก. — 3 กก.");
    expect(text).toContain("ลูก — 25 ลูก");
    expect(text).toContain("กล่อง — 3 กล่อง");
  });

  test("LINE chunks stay within 4000 code points, never split or duplicate grouped rows, totals stay invariant", () => {
    const items = Array.from({ length: 100 }, (_, index) => row({
      id: crypto.randomUUID(),
      item_ordinal: index + 1,
      raw_product_description: `สินค้า-${index}-${"ย".repeat(80)}`,
      normalized_product: `สินค้า-${index}-${"ย".repeat(80)}`,
      quantity: 1,
      unit_price_satang: 101,
    }));
    const report = buildHouseStockReport("2026-08-03", items);
    expect(report.messages.every((message) => countCodePoints(message) <= LINE_MESSAGE_MAX_CODE_POINTS)).toBe(true);
    const text = report.messages.join("\n\n");
    for (let index = 0; index < items.length; index += 1) {
      expect(text.match(new RegExp(`สินค้า-${index}-`, "g"))?.length).toBe(1);
    }
    expect(text).toContain(`รวมมูลค่า 101.00 บาท`);
  });
});

describe("authoritative House Stock snapshot", () => {
  test("several active snapshots conflict instead of summing", async () => {
    const query = {
      select() { return this; }, eq() { return this; }, is() { return this; },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve({ data: [{ id: "one" }, { id: "two" }], error: null }).then(resolve);
      },
    };
    const supabase = { from: () => query } as unknown as Parameters<typeof fetchAuthoritativeHouseStockReport>[0];
    await expect(fetchAuthoritativeHouseStockReport(supabase, "2026-08-03"))
      .rejects.toBeInstanceOf(HouseStockSnapshotConflictError);
  });
});
