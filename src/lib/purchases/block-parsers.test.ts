import { describe, expect, test } from "bun:test";
import {
  createPurchaseTextChunk,
  parsePurchaseCloseBlock,
  parsePurchaseCostsBlock,
  parsePurchaseHeaderBlock,
  parsePurchaseItemBlock,
  segmentPurchaseChunk,
  type PurchaseBlockParseResult,
} from "./index";
import {
  COSTS_NO_VAT,
  COSTS_POSITIVE_VAT,
  HEADER_KNOWN,
  HEADER_UNKNOWN,
  ITEM_ONE,
  firstBlock,
  lineEvidence,
  makeChunk,
  wholeChunkBlock,
} from "./test-helpers";

function issueCodes(result: PurchaseBlockParseResult): string[] {
  return result.errors.map((error) => error.code);
}

function flagCodes(result: PurchaseBlockParseResult): string[] {
  return result.reviewFlags.map((flag) => flag.code);
}

describe("purchase header parser", () => {
  test("parses a known purchase time and preserves intended destination only", () => {
    const result = parsePurchaseHeaderBlock(firstBlock(HEADER_KNOWN));
    expect(result.status).toBe("PARSED");
    if (result.status !== "PARSED" || result.command.kind !== "OPEN_PURCHASE") {
      return;
    }
    expect(result.command.purchaseDate).toBe("2026-07-28");
    expect(result.command.purchaseTime).toBe("06:30");
    expect(result.command.supplierText).toEqual({
      raw: "ร้านเจ๊แดง",
      normalized: "ร้านเจ๊แดง",
    });
    expect(result.command.referenceText?.raw).toBe("INV-123");
    expect(result.command.intendedWarehouseCode).toBe("MAIN");
    expect("warehouseCode" in result.command).toBe(false);
    expect("receipt" in result.command).toBe(false);
  });

  test("unknown time stays null and LINE event time remains metadata only", () => {
    const earlyChunk = makeChunk(HEADER_UNKNOWN);
    const lateChunk = createPurchaseTextChunk({
      chunkId: "late-time",
      chunkOrdinal: 2,
      rawText: HEADER_UNKNOWN,
      evidence: lineEvidence("late-time", "9999999999999"),
    });
    const earlyBlock = segmentPurchaseChunk(earlyChunk)[0];
    const lateBlock = segmentPurchaseChunk(lateChunk)[0];
    expect(earlyBlock).toBeDefined();
    expect(lateBlock).toBeDefined();
    if (!earlyBlock || !lateBlock) return;
    const earlyResult = parsePurchaseHeaderBlock(earlyBlock);
    const lateResult = parsePurchaseHeaderBlock(lateBlock);
    expect(earlyResult.status).toBe("PARSED");
    expect(lateResult.status).toBe("PARSED");
    if (
      earlyResult.status !== "PARSED"
      || earlyResult.command.kind !== "OPEN_PURCHASE"
      || lateResult.status !== "PARSED"
      || lateResult.command.kind !== "OPEN_PURCHASE"
    ) {
      return;
    }
    expect(earlyResult.command.purchaseTime).toBeNull();
    expect(lateResult.command.purchaseTime).toBeNull();
    expect(flagCodes(earlyResult)).toContain("UNKNOWN_PURCHASE_TIME");
    expect(flagCodes(earlyResult)).toContain("NO_REFERENCE");
    expect(earlyResult.command.referenceText).toBeNull();
    expect(earlyChunk.evidence.eventTimestampMs).toBe(
      lineEvidence("1").eventTimestampMs,
    );
    expect(lateChunk.evidence.eventTimestampMs).toBe(BigInt("9999999999999"));
  });

  test.each([
    ["1/1/2569", "2026-01-01"],
    ["29/2/2567", "2024-02-29"],
    ["31/12/2599", "2056-12-31"],
  ])("accepts real D/M/25YY date %s", (rawDate, isoDate) => {
    const result = parsePurchaseHeaderBlock(
      firstBlock(HEADER_KNOWN.replace("28/07/2569", rawDate)),
    );
    expect(result.status).toBe("PARSED");
    if (result.status !== "PARSED" || result.command.kind !== "OPEN_PURCHASE") {
      return;
    }
    expect(result.command.purchaseDate).toBe(isoDate);
  });

  test.each([
    "29/2/2569",
    "31/4/2569",
    "0/1/2569",
    "1/0/2569",
    "28/07/2026",
    "28/07/2499",
  ])("rejects invalid or non-25YY date %s", (rawDate) => {
    const result = parsePurchaseHeaderBlock(
      firstBlock(HEADER_KNOWN.replace("28/07/2569", rawDate)),
    );
    expect(result.status).toBe("INVALID");
    expect(issueCodes(result)).toContain("INVALID_PURCHASE_DATE");
  });

  test.each(["00:00", "23:59"])("accepts valid exact time %s", (time) => {
    const result = parsePurchaseHeaderBlock(
      firstBlock(HEADER_KNOWN.replace("06:30", time)),
    );
    expect(result.status).toBe("PARSED");
  });

  test.each(["24:00", "07:60", "7:05"])("rejects invalid time %s", (time) => {
    const block = firstBlock(HEADER_KNOWN.replace("06:30", time));
    const result = parsePurchaseHeaderBlock(block);
    expect(result.status).toBe("INVALID");
    expect(issueCodes(result)).toContain(
      time === "7:05"
        ? "INVALID_RESERVED_PURCHASE_BLOCK"
        : "INVALID_PURCHASE_TIME",
    );
  });

  test("rejects two-digit years as old syntax", () => {
    const result = parsePurchaseHeaderBlock(
      firstBlock(HEADER_KNOWN.replace("2569", "69")),
    );
    expect(result.status).toBe("INVALID");
    expect(issueCodes(result)).toContain("INVALID_RESERVED_PURCHASE_BLOCK");
  });

  test("rejects empty supplier and missing reference declaration", () => {
    const result = parsePurchaseHeaderBlock(
      firstBlock(`เริ่มซื้อ 28/07/2569 06:30
ผู้ขาย:${" "}
อ้างอิง: INV-123
ปลายทาง: MAIN`),
    );
    expect(issueCodes(result)).toContain("MISSING_SUPPLIER");
    expect(issueCodes(result)).toContain("MISSING_REFERENCE_DECLARATION");
  });

  test.each([
    "ปลายทาง: main",
    "ปลายทาง: MAIN_SELLABLE",
    "เข้าคลัง: MAIN",
  ])("rejects non-frozen destination line %p", (destination) => {
    const result = parsePurchaseHeaderBlock(
      firstBlock(HEADER_KNOWN.replace("ปลายทาง: MAIN", destination)),
    );
    expect(result.status).toBe("INVALID");
    expect(issueCodes(result)).toContain("INVALID_INTENDED_WAREHOUSE");
  });

  test("preserves supplier text containing existing router keywords", () => {
    const supplier = "ร้าน เบิก คืน สลิป จบรายการ ปิดซื้อ";
    const result = parsePurchaseHeaderBlock(
      firstBlock(HEADER_KNOWN.replace("ร้านเจ๊แดง", supplier)),
    );
    expect(result.status).toBe("PARSED");
    if (result.status !== "PARSED" || result.command.kind !== "OPEN_PURCHASE") {
      return;
    }
    expect(result.command.supplierText.raw).toBe(supplier);
    expect(result.command.supplierText.normalized).toBe(supplier);
  });

  test("preserves raw spelling separately from NFC-normalized supplier", () => {
    const rawSupplier = "Cafe\u0301  Supplier";
    const result = parsePurchaseHeaderBlock(
      firstBlock(HEADER_KNOWN.replace("ร้านเจ๊แดง", rawSupplier)),
    );
    expect(result.status).toBe("PARSED");
    if (result.status !== "PARSED" || result.command.kind !== "OPEN_PURCHASE") {
      return;
    }
    expect(result.command.supplierText.raw).toBe(rawSupplier);
    expect(result.command.supplierText.normalized).toBe("Café  Supplier");
  });

  test("allows outer ASCII whitespace but rejects doubled internal field syntax", () => {
    const outer = HEADER_KNOWN
      .split("\n")
      .map((line) => `\t${line} \t`)
      .join("\n");
    expect(parsePurchaseHeaderBlock(firstBlock(outer)).status).toBe("PARSED");

    const doubled = parsePurchaseHeaderBlock(
      firstBlock(HEADER_KNOWN.replace("ผู้ขาย: ", "ผู้ขาย:  ")),
    );
    expect(doubled.status).toBe("INVALID");
    expect(issueCodes(doubled)).toContain("MISSING_SUPPLIER");
  });

  test("rejects full-width colon and swapped header labels", () => {
    const fullWidth = parsePurchaseHeaderBlock(
      firstBlock(HEADER_KNOWN.replace("ผู้ขาย:", "ผู้ขาย：")),
    );
    const swapped = parsePurchaseHeaderBlock(
      firstBlock(`เริ่มซื้อ 28/07/2569 06:30
ใบอ้างอิง: INV-123
ผู้ขาย: ร้านเจ๊แดง
ปลายทาง: MAIN`),
    );
    expect(issueCodes(fullWidth)).toContain("MISSING_SUPPLIER");
    expect(swapped.status).toBe("INVALID");
  });
});

describe("purchase item parser", () => {
  test("parses exact quantity and rate without conversion", () => {
    const result = parsePurchaseItemBlock(firstBlock(ITEM_ONE));
    expect(result.status).toBe("PARSED");
    if (
      result.status !== "PARSED"
      || result.command.kind !== "ADD_PURCHASE_ITEM"
    ) {
      return;
    }
    expect(result.command.itemNumber).toBe(BigInt(1));
    expect(result.command.productText.raw).toBe("หมอนทอง");
    expect(result.command.quantity.coefficient).toBe(BigInt("120"));
    expect(result.command.quantity.scale).toBe(0);
    expect(result.command.unitText.raw).toBe("โล");
    expect(result.command.unitRate?.coefficient).toBe(BigInt("85"));
    expect(result.command.priceUnitText?.raw).toBe("โล");
  });

  test.each([
    ["หมอน", "หมอนทอง"],
    ["สาลี่", "สาลี่น้ำผึ้ง"],
  ])("keeps %s and %s as distinct products", (first, second) => {
    const firstResult = parsePurchaseItemBlock(
      firstBlock(ITEM_ONE.replace("หมอนทอง", first)),
    );
    const secondResult = parsePurchaseItemBlock(
      firstBlock(ITEM_ONE.replace("หมอนทอง", second)),
    );
    expect(firstResult.status).toBe("PARSED");
    expect(secondResult.status).toBe("PARSED");
    if (
      firstResult.status !== "PARSED"
      || firstResult.command.kind !== "ADD_PURCHASE_ITEM"
      || secondResult.status !== "PARSED"
      || secondResult.command.kind !== "ADD_PURCHASE_ITEM"
    ) {
      return;
    }
    expect(firstResult.command.productText.normalized).not.toBe(
      secondResult.command.productText.normalized,
    );
  });

  test.each(["ตะกร้า", "ลัง", "แพ็ก", "ถุง", "กรัม", "ลูก"])(
    "preserves unit %s without conversion",
    (unit) => {
      const result = parsePurchaseItemBlock(
        firstBlock(
          ITEM_ONE
            .replace("120 โล", `6 ${unit}`)
            .replace("85 บาท/โล", `85 บาท/${unit}`),
        ),
      );
      expect(result.status).toBe("PARSED");
      if (
        result.status !== "PARSED"
        || result.command.kind !== "ADD_PURCHASE_ITEM"
      ) {
        return;
      }
      expect(result.command.quantity.coefficient).toBe(BigInt(6));
      expect(result.command.unitText.raw).toBe(unit);
      expect(result.command.priceUnitText?.raw).toBe(unit);
    },
  );

  test("unknown price creates no rate or price unit and only a review flag", () => {
    const result = parsePurchaseItemBlock(
      firstBlock(ITEM_ONE.replace("ราคา: 85 บาท/โล", "ราคา: ไม่ทราบ")),
    );
    expect(result.status).toBe("PARSED");
    if (
      result.status !== "PARSED"
      || result.command.kind !== "ADD_PURCHASE_ITEM"
    ) {
      return;
    }
    expect(result.command.unitRate).toBeNull();
    expect(result.command.priceUnitText).toBeNull();
    expect(flagCodes(result)).toEqual(["MISSING_UNIT_RATE"]);
  });

  test("zero rate stays exact and requires review", () => {
    const result = parsePurchaseItemBlock(
      firstBlock(ITEM_ONE.replace("85 บาท/โล", "0.0000 บาท/โล")),
    );
    expect(result.status).toBe("PARSED");
    if (
      result.status !== "PARSED"
      || result.command.kind !== "ADD_PURCHASE_ITEM"
    ) {
      return;
    }
    expect(result.command.unitRate?.coefficient).toBe(BigInt(0));
    expect(result.command.unitRate?.scale).toBe(4);
    expect(flagCodes(result)).toEqual(["ZERO_UNIT_RATE"]);
  });

  test("unequal units remain independent and require resolution", () => {
    const result = parsePurchaseItemBlock(
      firstBlock(ITEM_ONE.replace("บาท/โล", "บาท/กก")),
    );
    expect(result.status).toBe("PARSED");
    if (
      result.status !== "PARSED"
      || result.command.kind !== "ADD_PURCHASE_ITEM"
    ) {
      return;
    }
    expect(result.command.unitText.raw).toBe("โล");
    expect(result.command.priceUnitText?.raw).toBe("กก");
    expect(flagCodes(result)).toContain("PRICE_UNIT_REQUIRES_RESOLUTION");
  });

  test("NFC-equivalent units do not create a mismatch flag", () => {
    const result = parsePurchaseItemBlock(
      firstBlock(`ซื้อรายการ 1
สินค้า: product
จำนวน: 1 e\u0301
ราคา: 2 บาท/é`),
    );
    expect(result.status).toBe("PARSED");
    expect(flagCodes(result)).not.toContain("PRICE_UNIT_REQUIRES_RESOLUTION");
  });

  test("product description preserves packaging, grade, color and router words", () => {
    const product = "องุ่น เบิก คืน สลิป จบรายการ ตะกร้าแดง เกรด A";
    const result = parsePurchaseItemBlock(
      firstBlock(ITEM_ONE.replace("หมอนทอง", product)),
    );
    expect(result.status).toBe("PARSED");
    if (
      result.status !== "PARSED"
      || result.command.kind !== "ADD_PURCHASE_ITEM"
    ) {
      return;
    }
    expect(result.command.productText.raw).toBe(product);
    expect(result.command.productText.normalized).toBe(product);
  });

  test.each(["0", "501"])("rejects out-of-range item number %s", (number) => {
    const result = parsePurchaseItemBlock(
      firstBlock(ITEM_ONE.replace("ซื้อรายการ 1", `ซื้อรายการ ${number}`)),
    );
    expect(issueCodes(result)).toContain("INVALID_ITEM_NUMBER");
  });

  test("accepts item number 500", () => {
    expect(
      parsePurchaseItemBlock(
        firstBlock(ITEM_ONE.replace("ซื้อรายการ 1", "ซื้อรายการ 500")),
      ).status,
    ).toBe("PARSED");
  });

  test.each(["0", "-1"])("rejects nonpositive quantity %s", (quantity) => {
    const result = parsePurchaseItemBlock(
      firstBlock(ITEM_ONE.replace("120 โล", `${quantity} โล`)),
    );
    expect(result.status).toBe("INVALID");
    expect(issueCodes(result)).toContain("INVALID_QUANTITY");
  });

  test("reports exact numeric scale and digit overflow codes", () => {
    const scale = parsePurchaseItemBlock(
      firstBlock(ITEM_ONE.replace("120 โล", "1.1234567 โล")),
    );
    const digits = parsePurchaseItemBlock(
      firstBlock(ITEM_ONE.replace("120 โล", "1000000000000.000000 โล")),
    );
    expect(issueCodes(scale)).toContain("NUMERIC_SCALE_EXCEEDED");
    expect(issueCodes(digits)).toContain("NUMERIC_VALUE_TOO_LARGE");
  });

  test("rejects invalid and overflowing unit rates without throwing", () => {
    const invalid = parsePurchaseItemBlock(
      firstBlock(ITEM_ONE.replace("85 บาท/โล", "-1 บาท/โล")),
    );
    const overflow = parsePurchaseItemBlock(
      firstBlock(
        ITEM_ONE.replace("85 บาท/โล", "100000000000000.0000 บาท/โล"),
      ),
    );
    expect(issueCodes(invalid)).toContain("INVALID_UNIT_RATE");
    expect(issueCodes(overflow)).toContain("NUMERIC_VALUE_TOO_LARGE");
  });

  test("rejects enormous item number before bigint construction", () => {
    const result = parsePurchaseItemBlock(
      firstBlock(
        ITEM_ONE.replace("ซื้อรายการ 1", `ซื้อรายการ ${"9".repeat(10_000)}`),
      ),
    );
    expect(issueCodes(result)).toContain("INVALID_ITEM_NUMBER");
  });

  test("rejects missing fields and surplus nonblank lines", () => {
    const result = parsePurchaseItemBlock(
      wholeChunkBlock(`${ITEM_ONE}\nunrecognized`),
    );
    expect(result.status).toBe("INVALID");
    expect(issueCodes(result)).toContain("UNRECOGNIZED_LINE");
  });
});

describe("purchase costs and VAT parser", () => {
  test("parses mandatory costs with explicit zero and no VAT", () => {
    const result = parsePurchaseCostsBlock(
      firstBlock(
        COSTS_NO_VAT
          .replace("300 บาท", "0 บาท")
          .replace("50 บาท", "0.00 บาท"),
      ),
    );
    expect(result.status).toBe("PARSED");
    if (
      result.status !== "PARSED"
      || result.command.kind !== "SET_PURCHASE_COSTS"
    ) {
      return;
    }
    expect(result.command.freight.satang).toBe(BigInt(0));
    expect(result.command.freight.decimal.raw).toBe("0");
    expect(result.command.handling.satang).toBe(BigInt(0));
    expect(result.command.discount.satang).toBe(BigInt("10000"));
    expect(result.command.vat.kind).toBe("NONE");
  });

  test.each([
    ["ใช่", "ใช่", true, true],
    ["ใช่", "ไม่ใช่", true, false],
    ["ไม่ใช่", "ใช่", false, true],
    ["ไม่ใช่", "ไม่ใช่", false, false],
  ])(
    "parses positive VAT details %s/%s",
    (includedText, recoverableText, included, recoverable) => {
      const raw = COSTS_POSITIVE_VAT
        .replace("ภาษีรวมในราคาสินค้า: ใช่", `ภาษีรวมในราคาสินค้า: ${includedText}`)
        .replace("ภาษีขอคืนได้: ใช่", `ภาษีขอคืนได้: ${recoverableText}`);
      const result = parsePurchaseCostsBlock(firstBlock(raw));
      expect(result.status).toBe("PARSED");
      if (
        result.status !== "PARSED"
        || result.command.kind !== "SET_PURCHASE_COSTS"
        || result.command.vat.kind !== "AMOUNT"
      ) {
        return;
      }
      expect(result.command.vat.amount.satang).toBe(BigInt("7000"));
      expect(result.command.vat.includedInItemPrices).toBe(included);
      expect(result.command.vat.recoverable).toBe(recoverable);
    },
  );

  test.each(["0", "0.0", "00.00"])(
    "rejects numeric zero VAT %s with the dedicated error",
    (zero) => {
      const result = parsePurchaseCostsBlock(
        firstBlock(
          COSTS_NO_VAT.replace(
            "ภาษีมูลค่าเพิ่ม: ไม่มี",
            `ภาษีมูลค่าเพิ่ม: ${zero} บาท`,
          ),
        ),
      );
      expect(result.status).toBe("INVALID");
      expect(issueCodes(result)).toContain("VAT_ZERO_MUST_USE_NONE");
    },
  );

  test("forbids VAT details with ไม่มี", () => {
    const result = parsePurchaseCostsBlock(
      wholeChunkBlock(`${COSTS_NO_VAT}
ภาษีรวมในราคาสินค้า: ใช่
ภาษีขอคืนได้: ใช่`),
    );
    expect(result.status).toBe("INVALID");
    expect(issueCodes(result)).toContain("INVALID_VAT_DECLARATION");
  });

  test("requires both details for positive VAT", () => {
    const missingRecoverable = COSTS_POSITIVE_VAT.replace(
      "\nภาษีขอคืนได้: ใช่",
      "",
    );
    const result = parsePurchaseCostsBlock(
      wholeChunkBlock(missingRecoverable),
    );
    expect(result.status).toBe("INVALID");
    expect(issueCodes(result)).toContain("INVALID_VAT_DECLARATION");
  });

  test("rejects swapped or duplicate positive VAT detail labels", () => {
    const swapped = parsePurchaseCostsBlock(
      wholeChunkBlock(
        COSTS_POSITIVE_VAT
          .replace("ภาษีรวมในราคาสินค้า: ใช่", "TEMP")
          .replace("ภาษีขอคืนได้: ใช่", "ภาษีรวมในราคาสินค้า: ใช่")
          .replace("TEMP", "ภาษีขอคืนได้: ใช่"),
      ),
    );
    const duplicate = parsePurchaseCostsBlock(
      wholeChunkBlock(
        COSTS_POSITIVE_VAT.replace(
          "ภาษีขอคืนได้: ใช่",
          "ภาษีรวมในราคาสินค้า: ใช่",
        ),
      ),
    );
    expect(issueCodes(swapped)).toContain("INVALID_VAT_DECLARATION");
    expect(issueCodes(duplicate)).toContain("INVALID_VAT_DECLARATION");
  });

  test("does not accept ไม่มี บาท as the no-VAT literal", () => {
    const result = parsePurchaseCostsBlock(
      firstBlock(
        COSTS_NO_VAT.replace(
          "ภาษีมูลค่าเพิ่ม: ไม่มี",
          "ภาษีมูลค่าเพิ่ม: ไม่มี บาท",
        ),
      ),
    );
    expect(result.status).toBe("INVALID");
    expect(issueCodes(result)).toContain("INVALID_VAT_DECLARATION");
  });

  test.each(["จริง", " yes", "ใช่ "])(
    "rejects nonexact VAT boolean %p",
    (value) => {
      const raw = COSTS_POSITIVE_VAT.replace(
        "ภาษีรวมในราคาสินค้า: ใช่",
        `ภาษีรวมในราคาสินค้า: ${value}`,
      );
      const result = parsePurchaseCostsBlock(wholeChunkBlock(raw));
      if (value === "ใช่ ") {
        // Trailing ASCII whitespace is the only allowed outer matching trim.
        expect(result.status).toBe("PARSED");
      } else {
        expect(result.status).toBe("INVALID");
        expect(issueCodes(result)).toContain("INVALID_VAT_DECLARATION");
      }
    },
  );

  test("rejects missing mandatory document money and money overflow", () => {
    const missing = parsePurchaseCostsBlock(
      firstBlock(COSTS_NO_VAT.replace("ค่าขนส่ง", "ขนส่ง")),
    );
    const overflow = parsePurchaseCostsBlock(
      firstBlock(
        COSTS_NO_VAT.replace("300 บาท", "10000000000000.00 บาท"),
      ),
    );
    expect(issueCodes(missing)).toContain("INVALID_DOCUMENT_MONEY");
    expect(issueCodes(overflow)).toContain("NUMERIC_VALUE_TOO_LARGE");
  });

  test("rejects money scale overflow without rounding", () => {
    const result = parsePurchaseCostsBlock(
      firstBlock(COSTS_NO_VAT.replace("300 บาท", "1.234 บาท")),
    );
    expect(issueCodes(result)).toContain("NUMERIC_SCALE_EXCEEDED");
  });
});

describe("purchase close parser", () => {
  test.each(["1", "500"])("accepts close count %s", (count) => {
    const result = parsePurchaseCloseBlock(
      firstBlock(`ปิดซื้อ ${count} รายการ`),
    );
    expect(result.status).toBe("PARSED");
  });

  test.each(["0", "501"])("rejects out-of-range close count %s", (count) => {
    const result = parsePurchaseCloseBlock(
      firstBlock(`ปิดซื้อ ${count} รายการ`),
    );
    expect(result.status).toBe("INVALID");
    expect(issueCodes(result)).toContain("CLOSE_COUNT_MISMATCH");
  });

  test.each(["ปิดซื้อ", "ปิดซื้อ -1 รายการ", "ปิดซื้อ 1.0 รายการ"])(
    "rejects malformed close %p",
    (raw) => {
      const result = parsePurchaseCloseBlock(firstBlock(raw));
      expect(result.status).toBe("INVALID");
      expect(issueCodes(result)).toContain(
        "INVALID_RESERVED_PURCHASE_BLOCK",
      );
    },
  );

  test("rejects an enormous close count before bigint construction", () => {
    const result = parsePurchaseCloseBlock(
      firstBlock(`ปิดซื้อ ${"9".repeat(10_000)} รายการ`),
    );
    expect(issueCodes(result)).toContain("CLOSE_COUNT_MISMATCH");
  });
});

describe("all public block parsers are nonthrowing for malformed user text", () => {
  const malformed = [
    "",
    "\uD800",
    "ordinary text",
    "9".repeat(10_000),
    "เริ่มซื้อ",
    "ซื้อรายการX",
  ];
  const parsers = [
    parsePurchaseHeaderBlock,
    parsePurchaseItemBlock,
    parsePurchaseCostsBlock,
    parsePurchaseCloseBlock,
  ];

  for (const parser of parsers) {
    for (const raw of malformed) {
      test(`${parser.name} does not throw for ${JSON.stringify(raw.slice(0, 20))}`, () => {
        expect(() => parser(wholeChunkBlock(raw))).not.toThrow();
        expect(parser(wholeChunkBlock(raw)).status).toBe("INVALID");
      });
    }
  }
});
