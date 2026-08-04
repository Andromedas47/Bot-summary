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
import {
  HOUSE_STOCK_PRICED_PARSER_VERSION,
  PHYSICAL_INVENTORY_PARSER_VERSION,
} from "./types";

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

  test("compact no-space bundle pricing: pricing qty/unit is never the remaining stock", () => {
    const parsed = parsePhysicalInventoryDocument(
      "ผลไม้คงเหลือในบ้าน\n4/8/69\n1ส้มไต้หวัน3โล100บาท\n16.โล\nจบ",
      { requireUnitPrice: true },
    );
    const item = parsed.items[0]!;
    expect(item.resolutionStatus).toBe("ACCEPTED_NORMALIZED");
    expect(item.rawProductDescription).toBe("ส้มไต้หวัน");
    expect(item.quantity).toBe(16);
    expect(item.rawUnit).toBe("โล");
    // 100 บาท for every 3 โล → 33.33 บาท/โล (half-up rounded to the satang).
    expect(item.unitPriceSatang).toBe(3_333);
  });

  test("compact no-space standard pricing (no pricing basis embedded)", () => {
    const parsed = parsePhysicalInventoryDocument(
      "ผลไม้คงเหลือในบ้าน\n4/8/69\n2อะโวอาโด้120บาท\n25.1.โล\nจบ",
      { requireUnitPrice: true },
    );
    const item = parsed.items[0]!;
    expect(item.resolutionStatus).toBe("ACCEPTED_NORMALIZED");
    expect(item.rawProductDescription).toBe("อะโวอาโด้");
    expect(item.quantity).toBe(25.1);
    expect(item.rawUnit).toBe("โล");
    expect(item.unitPriceSatang).toBe(12_000);
  });

  test("decimal-with-dot remaining quantity normalizes without breaking the fraction", () => {
    const cases: Array<[string, number, string]> = [
      ["16.โล", 16, "โล"],
      ["25.1.โล", 25.1, "โล"],
      ["88.ลูก", 88, "ลูก"],
      ["47.4โล", 47.4, "โล"],
    ];
    for (const [line, quantity, unit] of cases) {
      const parsed = parsePhysicalInventoryDocument(
        `ผลไม้คงเหลือในบ้าน\n4/8/69\n1มะม่วง10บาท\n${line}\nจบ`,
        { requireUnitPrice: true },
      );
      const item = parsed.items[0]!;
      expect([item.quantity, item.rawUnit]).toEqual([quantity, unit]);
      expect(item.resolutionStatus).not.toBe("REJECTED");
    }
  });

  test("15-item regression fixture: header, bundle + standard compact pricing, repeated products all accepted", () => {
    const FIXTURE = [
      "ผลไม้คงเหลือในบ้าน", "4/8/69", "",
      "1ส้มไต้หวัน3โล100บาท", "16.โล", "",
      "2อะโวอาโด้120บาท", "25.1.โล", "",
      "3เขียวมรกต30บาท", "49.4.โล", "",
      "4แอปเปิ้ล10บาท", "88.ลูก", "",
      "5สาลี่10บาท", "216.ลูก", "",
      "6หมอน100บาท", "29.6.โล", "",
      "7หมอน100บาท", "26.5.โล", "",
      "8หมอน100บาท", "38.1.โล", "",
      "9หมอน100บาท", "31.2.โล", "",
      "10หมอน100บาท", "37.7.โล", "",
      "11หมอน119บาท", "45.2.โล", "",
      "12หมอน119บาท", "47.2.โล", "",
      "13หมอน119บาท", "45.5.โล", "",
      "14หมอน119บาท", "52.7.โล", "",
      "15หมอน119บาท", "47.4โล", "",
      "จบ",
    ].join("\n");

    const parsed = parsePhysicalInventoryDocument(FIXTURE, { requireUnitPrice: true });
    expect(parsed.businessDate).toBe("2026-08-04");
    expect(parsed.closeText).toBe("จบ");
    expect(parsed.items).toHaveLength(15);
    expect(parsed.items.every((item) => item.resolutionStatus !== "REJECTED")).toBe(true);
    expect(parsed.items.map((item) => item.sequence)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
    // "หมอน" repeats 10 times (sequences 6-15) with distinct quantities — none merged or dropped.
    const หมอนQuantities = parsed.items
      .filter((item) => item.rawProductDescription === "หมอน")
      .map((item) => item.quantity);
    expect(หมอนQuantities).toEqual([29.6, 26.5, 38.1, 31.2, 37.7, 45.2, 47.2, 45.5, 52.7, 47.4]);
  });
});

describe("priced House Stock summary", () => {
  test("bundle-priced entries show the original bundle expression, not just the derived per-unit price", () => {
    const parsed = parsePhysicalInventoryDocument(
      "ผลไม้คงเหลือในบ้าน\n4/8/69\n1ส้มไต้หวัน3โล100บาท\n16.โล\nจบ",
      { requireUnitPrice: true },
    );
    const item = parsed.items[0]!;
    const report = buildHouseStockReport("2026-08-04", [row({
      raw_text: item.rawText,
      raw_product_description: item.rawProductDescription,
      normalized_product: item.normalizedProduct,
      quantity: item.quantity!,
      unit_price_satang: item.unitPriceSatang!,
      raw_unit: item.rawUnit,
      normalized_unit: item.normalizedUnit,
    })]);
    const text = report.messages.join("\n\n");
    // Shows the computed per-unit price for valuation AND the original
    // "3 โล for 100 บาท" the staff actually typed — never just 33.33 บาท
    // alone, which would misrepresent what was entered.
    expect(text).toContain("ส้มไต้หวัน — 33.33 บาท/กก. (ซื้อ 3 กก. 100 บาท)");
    expect(text).toContain("16 กก.");
    expect(text).toContain("มูลค่า 533.28 บาท");
  });

  test("standard (non-bundle) pricing never gets a bundle note", () => {
    // row()'s default raw_text is plain spaced pricing with no embedded
    // pricing qty/unit — must render exactly as before this change.
    const report = buildHouseStockReport("2026-08-03", [row()]);
    const text = report.messages.join("\n\n");
    expect(text).toContain("เขียวมรกต — 30 บาท/กก.");
    expect(text).not.toContain("ซื้อ");
  });

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
  function supabaseWith(
    snapshots: Array<{ id: string; business_date: string; parser_version: string }>,
    items: Item[] = [],
  ) {
    return { from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select() { return this; },
        eq(column: string, value: unknown) { filters[column] = value; return this; },
        is() { return this; },
        order() { return this; },
      then(resolve: (value: unknown) => unknown) {
          const rows = table === "physical_inventory_snapshots" ? snapshots : items;
          const data = rows.filter((entry) =>
            Object.entries(filters).every(([column, value]) =>
              (entry as unknown as Record<string, unknown>)[column] === value));
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    } } as unknown as Parameters<typeof fetchAuthoritativeHouseStockReport>[0];
  }

  const snapshot = (id: string, parserVersion: string) => ({
    id,
    business_date: "2026-08-03",
    warehouse_code: "MAIN",
    status: "finalized",
    parser_version: parserVersion,
  });

  test("legacy Physical Inventory snapshot is ignored", async () => {
    const supabase = supabaseWith([snapshot("legacy", PHYSICAL_INVENTORY_PARSER_VERSION)]);
    expect(await fetchAuthoritativeHouseStockReport(supabase, "2026-08-03")).toBeNull();
  });

  test("legacy plus priced snapshot selects only the priced snapshot", async () => {
    const supabase = supabaseWith([
      snapshot("legacy", PHYSICAL_INVENTORY_PARSER_VERSION),
      snapshot("priced", HOUSE_STOCK_PRICED_PARSER_VERSION),
    ], [row({ snapshot_id: "priced" })]);
    const report = await fetchAuthoritativeHouseStockReport(supabase, "2026-08-03");
    expect(report).toMatchObject({ itemCount: 1, totalValueSatang: 149_100 });
  });

  test("two priced snapshots still conflict instead of summing", async () => {
    const supabase = supabaseWith([
      snapshot("one", HOUSE_STOCK_PRICED_PARSER_VERSION),
      snapshot("two", HOUSE_STOCK_PRICED_PARSER_VERSION),
    ]);
    await expect(fetchAuthoritativeHouseStockReport(supabase, "2026-08-03"))
      .rejects.toBeInstanceOf(HouseStockSnapshotConflictError);
  });
});
