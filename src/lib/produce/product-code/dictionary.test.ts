/**
 * The dictionary has three copies — the approved CSV, the generated runtime
 * module, and the migration seed — and they are only safe while all three say
 * exactly the same thing. These tests are what makes that true, so a hand-edit
 * to any one of them fails here instead of in Production.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRODUCT_CODE_COUNT,
  PRODUCT_CODE_ENABLED_COUNT,
  PRODUCT_CODE_ENTRIES,
} from "./dictionary";
import {
  isProductCodeToken,
  resolveItemLineProductCode,
  resolveProductCode,
} from "./resolver";

const HERE = import.meta.dir;
const MIGRATION = join(
  HERE, "..", "..", "..", "..",
  "supabase", "migrations", "20260813090000_produce_product_code_dictionary.sql",
);

interface Row {
  code: string;
  categoryCode: string;
  category: string;
  canonicalName: string;
  enabled: boolean;
}

/** The approved CSV, read the same way the generator reads it. */
function csvRows(): Row[] {
  const text = readFileSync(join(HERE, "dictionary.csv"), "utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  expect(lines.shift()).toBe("code,category_code,category,canonical_name,active_dictionary");

  return lines.map((line) => {
    const [code, categoryCode, category, canonicalName, active] = line.split(",").map((p) => p.trim());
    return { code, categoryCode, category, canonicalName, enabled: active === "True" };
  });
}

/** The seed rows the Production migration actually inserts. */
function migrationRows(): Row[] {
  const sql = readFileSync(MIGRATION, "utf8");
  return [...sql.matchAll(/^ {2}\('(.+?)', '(.+?)', '(.+?)', '(.+?)', (true|false)\)/gmu)].map(
    (m) => ({
      code: m[1],
      categoryCode: m[2],
      category: m[3],
      canonicalName: m[4],
      enabled: m[5] === "true",
    }),
  );
}

const moduleRows = (): Row[] =>
  PRODUCT_CODE_ENTRIES.map((e) => ({
    code: e.code,
    categoryCode: e.categoryCode,
    category: e.category,
    canonicalName: e.canonicalName,
    enabled: e.enabled,
  }));

describe("the approved dictionary is the source of truth", () => {
  it("carries exactly the 253 approved codes", () => {
    expect(PRODUCT_CODE_COUNT).toBe(253);
    expect(PRODUCT_CODE_ENABLED_COUNT).toBe(253);
    expect(PRODUCT_CODE_ENTRIES).toHaveLength(253);
    expect(csvRows()).toHaveLength(253);
  });

  it("matches the CSV row for row, in the approved order and numbering", () => {
    // Order matters: re-sorting the CSV would renumber the approved codes.
    expect(moduleRows()).toEqual(csvRows());
  });

  it("seeds the migration with the identical rows", () => {
    expect(migrationRows()).toEqual(csvRows());
  });

  it("keeps the approved namespace ranges", () => {
    const counts = new Map<string, number>();
    for (const entry of PRODUCT_CODE_ENTRIES) {
      counts.set(entry.categoryCode, (counts.get(entry.categoryCode) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      ม: 62, ผ: 118, ป: 36, ท: 26, ห: 4, พ: 7,
    });
  });

  it("never issues one code twice", () => {
    const codes = PRODUCT_CODE_ENTRIES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("real mappings from the approved CSV resolve", () => {
  // One representative per namespace, plus the boundary codes of each range.
  const cases: Array<[string, string]> = [
    ["ม01", "กล้วยไข่"],
    ["ม02", "กล้วยน้ำว้า"],
    ["ม62", "แอปเปิ้ล"],
    ["ผ01", "ฝักกระเจี๊ยบ"],
    ["ผ07", "กระเทียมหัว"],
    ["ผ99", "ใบตั้งโอ๋"],
    ["ผ100", "ใบบัวบก"],
    ["ผ118", "ข้าวคั่ว"],
    ["ป01", "กะปิ"],
    ["ป36", "หอยเชลล์"],
    ["ท01", "ทุเรียน"],
    ["ท26", "ภูเขาไฟลูกค้าเคลม"],
    ["ห01", "เห็ดนางฟ้า"],
    ["ห04", "เห็ดออรินจิ"],
    ["พ01", "ผลไม้กล่อง"],
    ["พ07", "มะระถุง"],
  ];

  for (const [code, canonicalName] of cases) {
    it(`${code} → ${canonicalName}`, () => {
      expect(resolveProductCode(code)).toBe(canonicalName);
    });
  }

  it("resolves codes past two digits — ผ runs to ผ118", () => {
    expect(resolveProductCode("ผ100")).not.toBeNull();
    expect(resolveProductCode("ผ118")).not.toBeNull();
  });
});

describe("unregistered codes do not resolve", () => {
  for (const code of ["ม99", "ม999", "ผ999", "ป99", "ท99", "ห99", "พ99", "ผ119", "ม63"]) {
    it(`${code} is unknown`, () => {
      expect(resolveProductCode(code)).toBeNull();
      expect(resolveItemLineProductCode(`${code} 50 บาท`)).toEqual({ kind: "unknown", code });
    });
  }
});

describe("code recognition is narrow", () => {
  it("recognizes only a namespace character followed by digits", () => {
    expect(isProductCodeToken("ม01")).toBe(true);
    expect(isProductCodeToken("ผ118")).toBe(true);
    expect(isProductCodeToken("กล้วยน้ำว้า")).toBe(false);
    expect(isProductCodeToken("มะม่วง")).toBe(false);
    expect(isProductCodeToken("ปลาหวานแดง")).toBe(false);
    expect(isProductCodeToken("ผักกาดขาว")).toBe(false);
    expect(isProductCodeToken("01")).toBe(false);
    expect(isProductCodeToken("ก01")).toBe(false);
  });

  it("leaves an ordinary product line completely alone", () => {
    for (const line of [
      "กล้วยน้ำว้า 35 บาท",
      "1.ปลาหวานแดง100บาท",
      "เสาวรส 50 บาท",
      "มะม่วงน้ำดอกไม้ 40 บาท",
      "85ผักกาดขาว3หัว20บาท",
    ]) {
      expect(resolveItemLineProductCode(line)).toEqual({ kind: "none", content: line });
    }
  });

  it("never touches a seller/market header, a date, or a closer", () => {
    for (const line of [
      "กี้-วัดทุ่งลานนา เบิก 13/8/2569",
      "มิ้น-ทรัพย์พันธ์2 ชั่งคืน 11/8/2569",
      "ผ่องศรี-ปากคลอง เบิกเพิ่ม 13/8/2569",
      "13/8/2569",
      "จบรายการเบิก",
      "รายการชั่งเบิก",
      // The adversarial one: a seller whose name really is a namespace
      // character plus digits. The dash is not whitespace, so the boundary
      // never matches and the header parses as a header.
      "ม1-ตลาด เบิก 13/8/2569",
      "ผ2-คลองเตย ชั่งคืน 13/8/2569",
    ]) {
      expect(resolveItemLineProductCode(line)).toEqual({ kind: "none", content: line });
    }
  });

  it("leaves the compact scale form untouched — a code needs a separator", () => {
    // "ม0150บาท" has no boundary between code and price and is genuinely
    // ambiguous, so it keeps reading exactly as it did before codes existed.
    expect(resolveItemLineProductCode("ม0150บาท")).toEqual({
      kind: "none",
      content: "ม0150บาท",
    });
  });

  it("rewrites only the product token, behind an optional item number", () => {
    expect(resolveItemLineProductCode("ม02 35 บาท")).toMatchObject({
      kind: "resolved",
      content: "กล้วยน้ำว้า 35 บาท",
      code: "ม02",
    });
    expect(resolveItemLineProductCode("1.ม02 35 บาท")).toMatchObject({
      kind: "resolved",
      content: "1.กล้วยน้ำว้า 35 บาท",
    });
    expect(resolveItemLineProductCode("85ผ51 3หัว20บาท")).toMatchObject({
      kind: "resolved",
      content: "85ผักกาดขาว 3หัว20บาท",
    });
  });
});
