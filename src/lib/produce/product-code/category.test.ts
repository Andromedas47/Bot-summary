import { describe, expect, test } from "bun:test";
import { PRODUCT_CODE_ENTRIES } from "./dictionary";
import {
  UNCATEGORIZED_CATEGORY_ID,
  dictionaryCategoryFor,
  dictionaryEntryFor,
  reportCategoryHeading,
} from "./category";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { stockCategoryFor } from "@/lib/summary/stock-categories";

describe("dictionaryCategoryFor", () => {
  test("1. dictionary fruit resolves to ผลไม้", () => {
    expect(dictionaryCategoryFor("มะม่วงเขียวมรกต")).toBe("ม");
    expect(dictionaryCategoryFor("พุทราไทย")).toBe("ม");
    expect(dictionaryCategoryFor("สับปะรด")).toBe("ม");
    expect(reportCategoryHeading("ม")).toBe("🍉 ผลไม้");
  });

  test("2. dictionary vegetable resolves to ผัก", () => {
    expect(dictionaryCategoryFor("กวางตุ้งไทย")).toBe("ผ");
    expect(dictionaryCategoryFor("กระเทียมกลีบ")).toBe("ผ");
    expect(reportCategoryHeading("ผ")).toBe("🥬 ผัก");
  });

  test("3. dictionary dry/fish product resolves to ของแห้ง category", () => {
    expect(dictionaryCategoryFor("กะปิ")).toBe("ป");
    expect(dictionaryCategoryFor("ปลาซิว")).toBe("ป");
    expect(reportCategoryHeading("ป")).toBe("🐟 ปลา / อาหารแห้ง / ของแห้ง");
  });

  test("4. dictionary durian resolves to ทุเรียน", () => {
    expect(dictionaryCategoryFor("หมอนทอง")).toBe("ท");
    expect(dictionaryCategoryFor("หมอนทองเก่า")).toBe("ท");
    expect(reportCategoryHeading("ท")).toBe("🥭 ทุเรียน");
  });

  test("5. dictionary mushroom resolves to เห็ด", () => {
    expect(dictionaryCategoryFor("เห็ดแพ็ครวม")).toBe("ห");
    expect(dictionaryCategoryFor("เห็ดนางฟ้า")).toBe("ห");
    expect(reportCategoryHeading("ห")).toBe("🍄 เห็ด");
  });

  test("6. dictionary special item resolves to รายการพิเศษ", () => {
    expect(dictionaryCategoryFor("ผลไม้กล่อง")).toBe("พ");
    expect(dictionaryCategoryFor("มะระถุง")).toBe("พ");
    expect(reportCategoryHeading("พ")).toBe("📦 รายการพิเศษ");
  });

  test("7. reviewed alias resolves through canonical dictionary identity", () => {
    expect(normalizeProductName("อะโวคาโด้")).toBe("อะโวคาโด");
    expect(dictionaryCategoryFor(normalizeProductName("อะโวคาโด้"))).toBe("ม");
    expect(normalizeProductName("สัปรด")).toBe("สับปะรด");
    expect(dictionaryCategoryFor(normalizeProductName("สัปรด"))).toBe("ม");
    expect(normalizeProductName("หมอน")).toBe("หมอนทอง");
    expect(dictionaryCategoryFor(normalizeProductName("หมอน"))).toBe("ท");
  });

  test("8. unknown product stays ไม่จัดหมวด", () => {
    expect(dictionaryCategoryFor("สินค้าABC")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("ของแปลกใหม่ไม่เคยเจอ")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("   ")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(reportCategoryHeading(UNCATEGORIZED_CATEGORY_ID)).toBe("❓ ไม่จัดหมวด");
  });

  test("9. no fuzzy category guessing", () => {
    expect(dictionaryCategoryFor("แตงโมมม")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("กระชายย")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("ทุเรียนXYZ")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("ปลากระป๋องXYZ")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("มะม่วง")).toBe(UNCATEGORIZED_CATEGORY_ID);
    // Production spelling variants with no reviewed alias stay uncategorized.
    expect(dictionaryCategoryFor("เห็ดแพครวม")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("ไซมัส")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("ใบมะกรุด")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("คน้าใหญ่")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor(normalizeProductName("สินค้าABC"))).toBe(UNCATEGORIZED_CATEGORY_ID);
  });

  test("a reviewed alias is required before lookup — the alias itself is not in the dictionary", () => {
    expect(dictionaryCategoryFor("อะโวคาโด้")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("สัปรด")).toBe(UNCATEGORIZED_CATEGORY_ID);
  });

  test("every enabled dictionary category code is one of the six approved namespaces", () => {
    for (const entry of PRODUCT_CODE_ENTRIES) {
      expect(["ท", "ม", "ผ", "ป", "ห", "พ"]).toContain(entry.categoryCode);
      expect(dictionaryCategoryFor(entry.canonicalName)).toBe(entry.categoryCode as "ท" | "ม" | "ผ" | "ป" | "ห" | "พ");
    }
  });

  test("enabled canonical names do not collide across categories", () => {
    const seen = new Map<string, string>();
    for (const entry of PRODUCT_CODE_ENTRIES) {
      if (!entry.enabled) continue;
      const key = entry.canonicalName.normalize("NFC");
      const previous = seen.get(key);
      if (previous) expect(previous).toBe(entry.categoryCode);
      else seen.set(key, entry.categoryCode);
    }
  });
});

describe("2026-08-14 production products no longer fall into ไม่จัดหมวด", () => {
  const classified: Array<[string, ReportCategoryExpectation]> = [
    ["มะม่วงเขียวมรกต", "ม"],
    ["พุทราไทย", "ม"],
    ["หมอนทองเก่า", "ท"],
    ["ปลาลิ้นหมา", "ป"],
    ["ปลาซิว", "ป"],
    ["ปลาผีเสื้อ", "ป"],
    ["ปลาหมึกกะตอย", "ป"],
    ["ปลาหวานแดง", "ป"],
    ["ปลาหวานไม่งา", "ป"],
    ["กะปิ", "ป"],
    ["ปลาทูหอม", "ป"],
    ["ปลาหมึกแผ่น", "ป"],
    ["ปลากิมสั่ว", "ป"],
    ["ปลาทาโร่", "ป"],
    ["ปลาหวานงา", "ป"],
    ["ปลาจวด", "ป"],
  ];

  test.each(classified)("%s → dictionary %s (was uncategorized on the stock-category list)", (name, id) => {
    expect(stockCategoryFor(name)).toBe("ไม่จัดหมวด");
    expect(dictionaryCategoryFor(name)).toBe(id);
    expect(dictionaryEntryFor(name)?.canonicalName).toBe(name);
  });

  test("reviewed aliases from that day classify through the canonical dictionary row", () => {
    expect(dictionaryCategoryFor(normalizeProductName("อะโวคาโด้"))).toBe("ม");
    expect(dictionaryCategoryFor(normalizeProductName("สัปรด"))).toBe("ม");
  });

  test("unreviewed production spellings stay ไม่จัดหมวด rather than being invented", () => {
    for (const name of ["ไซมัส", "ใบมะกรุด", "คน้าใหญ่", "เห็ดแพครวม", "หอยเชล", "กล่ำปี", "นำเต้า", "สับปรด", "อินทผรัม"]) {
      expect(dictionaryCategoryFor(name)).toBe(UNCATEGORIZED_CATEGORY_ID);
      expect(normalizeProductName(name)).toBe(name);
    }
  });
});

type ReportCategoryExpectation = "ท" | "ม" | "ผ" | "ป" | "ห" | "พ";
