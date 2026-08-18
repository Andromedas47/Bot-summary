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
const BASE_MIGRATION = join(
  HERE, "..", "..", "..", "..",
  "supabase", "migrations", "20260813090000_produce_product_code_dictionary.sql",
);
const CLEANUP_MIGRATION = join(
  HERE, "..", "..", "..", "..",
  "supabase", "migrations", "20260818100000_produce_product_dictionary_cleanup.sql",
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

/** Rows inserted by a migration's own `INSERT ... VALUES` block, in file order. */
function insertedRowsOf(migrationPath: string): Row[] {
  const sql = readFileSync(migrationPath, "utf8");
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

/**
 * The seed rows the base Production migration (20260813090000) actually
 * inserts, verbatim.
 */
function baseMigrationRows(): Row[] {
  return insertedRowsOf(BASE_MIGRATION);
}

/**
 * A migration applied ON TOP of the base seed: either new rows inserted at a
 * named position, or a canonical_name correction to an existing code (the
 * ONLY identity mutation allowed, and only because 20260818100000 proves it is
 * a spelling correction of the same product, not a repoint).
 *
 * Adding a future migration is: append one more entry here naming the file,
 * where its new rows land (the code they follow), and any renames it makes.
 */
interface AppliedMigration {
  file: string;
  /** New rows this migration inserts, spliced in immediately after this code. */
  insertAfterCode: string;
  /** code -> corrected canonicalName, applied to rows from earlier migrations. */
  renames?: Record<string, string>;
}

const APPLIED_MIGRATIONS: AppliedMigration[] = [
  {
    file: CLEANUP_MIGRATION,
    insertAfterCode: "ม62",
    renames: { "ม54": "ไซมัส" }, // ไซมัส
  },
];

/**
 * The dictionary state a Production database would actually have after every
 * migration applies, in order: start from the base seed, then for each later
 * migration apply its renames to the rows already accumulated and splice in
 * its own new rows at the named anchor. This is deliberately independent of
 * dictionary.csv / dictionary.ts — it reconstructs the DB's truth purely from
 * the migration files, so a hand-edit to the CSV or the generated module that
 * drifts from what the migrations actually do fails here.
 */
function migrationRows(): Row[] {
  let rows = baseMigrationRows();

  for (const migration of APPLIED_MIGRATIONS) {
    if (migration.renames) {
      const renames = migration.renames;
      rows = rows.map((row) => (renames[row.code] ? { ...row, canonicalName: renames[row.code] } : row));
    }

    const inserted = insertedRowsOf(migration.file);
    const anchor = rows.findIndex((row) => row.code === migration.insertAfterCode);
    if (anchor === -1) {
      throw new Error(`${migration.file}: insertAfterCode ${migration.insertAfterCode} not found`);
    }
    rows = [...rows.slice(0, anchor + 1), ...inserted, ...rows.slice(anchor + 1)];
  }

  return rows;
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
  it("carries exactly the 259 approved codes", () => {
    expect(PRODUCT_CODE_COUNT).toBe(259);
    expect(PRODUCT_CODE_ENABLED_COUNT).toBe(259);
    expect(PRODUCT_CODE_ENTRIES).toHaveLength(259);
    expect(csvRows()).toHaveLength(259);
  });

  it("matches the CSV row for row, in the approved order and numbering", () => {
    // Order matters: re-sorting the CSV would renumber the approved codes.
    expect(moduleRows()).toEqual(csvRows());
  });

  it("composes to the identical rows once every migration is applied in order", () => {
    // migrationRows() replays the base seed (20260813090000) plus every
    // migration layered on top of it (20260818100000's ม54 correction and its
    // six new rows) — the actual sequence a Production database runs. That
    // composed result has to equal the approved CSV, or the migrations and the
    // CSV have drifted apart.
    expect(migrationRows()).toEqual(csvRows());
  });

  it("keeps the approved namespace ranges", () => {
    const counts = new Map<string, number>();
    for (const entry of PRODUCT_CODE_ENTRIES) {
      counts.set(entry.categoryCode, (counts.get(entry.categoryCode) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      ม: 68, ผ: 118, ป: 36, ท: 26, ห: 4, พ: 7,
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
    ["ม54", "ไซมัส"],
    ["ม62", "แอปเปิ้ล"],
    ["ม68", "องุ่นคิมสัน"],
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
  // ม63-ม68 exist as of 20260818100000, so ม69 — the code right past the new
  // boundary — is the genuinely unissued example, not ม63.
  for (const code of ["ม99", "ม999", "ผ999", "ป99", "ท99", "ห99", "พ99", "ผ119", "ม69"]) {
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

describe("20260818100000 dictionary cleanup — ม54 correction and ม63–ม68", () => {
  it("ม54 resolves to the corrected spelling ไซมัส", () => {
    expect(resolveProductCode("ม54")).toBe("ไซมัส");
  });

  const NEW_CODES: Array<[string, string]> = [
    ["ม63", "มะม่วงจิ้ว"],
    ["ม64", "ลูกพีชเล็ก"],
    ["ม65", "ลูกพีชใหญ่"],
    ["ม66", "ลูกไหนเขียว"],
    ["ม67", "ลูกไหนดำ"],
    ["ม68", "องุ่นคิมสัน"],
  ];

  for (const [code, canonicalName] of NEW_CODES) {
    it(`${code} → ${canonicalName}`, () => {
      expect(resolveProductCode(code)).toBe(canonicalName);
    });
  }

  describe("independence — the new rows are not a merge of an existing code", () => {
    it("the pre-existing ม42/ม43/ม44 codes still resolve to their own products", () => {
      expect(resolveProductCode("ม42")).toBe("ลูกพีช");
      expect(resolveProductCode("ม43")).toBe("ลูกไหน");
      expect(resolveProductCode("ม44")).toBe("ลูกไหนแดง");
    });

    it("small/large/color variants resolve to codes distinct from their base product's code", () => {
      expect(resolveProductCode("ม64")).not.toBe(resolveProductCode("ม42")); // ลูกพีชเล็ก !== ลูกพีช
      expect(resolveProductCode("ม65")).not.toBe(resolveProductCode("ม42")); // ลูกพีชใหญ่ !== ลูกพีช
      expect(resolveProductCode("ม66")).not.toBe(resolveProductCode("ม43")); // ลูกไหนเขียว !== ลูกไหน
      expect(resolveProductCode("ม67")).not.toBe(resolveProductCode("ม43")); // ลูกไหนดำ !== ลูกไหน
    });
  });

  it("no product code collision — the new codes each appear exactly once in the full set", () => {
    const codes = PRODUCT_CODE_ENTRIES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length); // full-set targeted re-check
    for (const code of ["ม63", "ม64", "ม65", "ม66", "ม67", "ม68"]) {
      expect(codes.filter((c) => c === code)).toHaveLength(1);
    }
  });
});
