import { describe, expect, test } from "bun:test";
import {
  PURCHASE_CONTRACT_VERSION,
  PURCHASE_INTENDED_WAREHOUSE_MAIN,
  PURCHASE_QUANTITY_MAX_SCALE,
  PURCHASE_QUANTITY_MAX_TOTAL_DIGITS,
  PURCHASE_UNIT_RATE_MAX_SCALE,
  PURCHASE_UNIT_RATE_MAX_TOTAL_DIGITS,
  assemblePurchaseEvidence,
  createGuidedPurchaseCommandEnvelope,
  createPurchaseTextChunk,
  extractPurchaseCommandsFromTextChunks,
  parseExactDecimal,
  parseExactDocumentMoney,
  type AddPurchaseItemCommand,
  type ClosePurchaseCommand,
  type GuidedPostbackEvidenceMetadata,
  type OpenPurchaseCommand,
  type PurchaseCommand,
  type PurchaseCommandEnvelope,
  type SetPurchaseCostsCommand,
} from "./index";
import {
  COMPLETE_DOCUMENT,
  COSTS_NO_VAT,
  COSTS_POSITIVE_VAT,
  HEADER_KNOWN,
  HEADER_UNKNOWN,
  ITEM_ONE,
  ITEM_TWO_UNKNOWN,
  lineEvidence,
  makeChunk,
} from "./test-helpers";

function issueCodes(result: ReturnType<typeof assemblePurchaseEvidence>) {
  return result.errors.map((error) => error.code);
}

function textEnvelopes(raw: string) {
  const chunk = makeChunk(raw);
  return {
    chunks: [chunk],
    envelopes: extractPurchaseCommandsFromTextChunks([chunk]),
  };
}

function assembleText(raw: string) {
  const { chunks, envelopes } = textEnvelopes(raw);
  return assemblePurchaseEvidence({
    chunks,
    postbackEvidence: [],
    commandEnvelopes: envelopes,
  });
}

function exactQuantity(raw: string) {
  const result = parseExactDecimal(raw, {
    maxTotalDigits: PURCHASE_QUANTITY_MAX_TOTAL_DIGITS,
    maxScale: PURCHASE_QUANTITY_MAX_SCALE,
  });
  if (!result.ok) throw new Error("Invalid exact quantity test fixture");
  return result.value;
}

function exactRate(raw: string) {
  const result = parseExactDecimal(raw, {
    maxTotalDigits: PURCHASE_UNIT_RATE_MAX_TOTAL_DIGITS,
    maxScale: PURCHASE_UNIT_RATE_MAX_SCALE,
  });
  if (!result.ok) throw new Error("Invalid exact rate test fixture");
  return result.value;
}

function exactMoney(raw: string) {
  const result = parseExactDocumentMoney(raw);
  if (!result.ok) throw new Error("Invalid exact money test fixture");
  return result.value;
}

const DIRECT_OPEN: OpenPurchaseCommand = {
  kind: "OPEN_PURCHASE",
  contractVersion: PURCHASE_CONTRACT_VERSION,
  purchaseDate: "2026-07-28",
  purchaseDateText: { raw: "28/07/2569", normalized: "28/07/2569" },
  purchaseTime: "06:30",
  purchaseTimeText: { raw: "06:30", normalized: "06:30" },
  supplierText: { raw: "ร้านเจ๊แดง", normalized: "ร้านเจ๊แดง" },
  referenceText: { raw: "INV-123", normalized: "INV-123" },
  referenceDeclarationText: { raw: "INV-123", normalized: "INV-123" },
  intendedWarehouseCode: PURCHASE_INTENDED_WAREHOUSE_MAIN,
};

const DIRECT_ITEM: AddPurchaseItemCommand = {
  kind: "ADD_PURCHASE_ITEM",
  contractVersion: PURCHASE_CONTRACT_VERSION,
  itemNumber: BigInt(1),
  itemNumberText: { raw: "1", normalized: "1" },
  productText: { raw: "หมอนทอง", normalized: "หมอนทอง" },
  quantity: exactQuantity("120"),
  quantityText: { raw: "120", normalized: "120" },
  unitText: { raw: "โล", normalized: "โล" },
  unitRate: exactRate("85"),
  unitRateText: { raw: "85", normalized: "85" },
  priceUnitText: { raw: "โล", normalized: "โล" },
};

const DIRECT_COSTS: SetPurchaseCostsCommand = {
  kind: "SET_PURCHASE_COSTS",
  contractVersion: PURCHASE_CONTRACT_VERSION,
  freight: exactMoney("300"),
  freightText: { raw: "300", normalized: "300" },
  handling: exactMoney("50"),
  handlingText: { raw: "50", normalized: "50" },
  discount: exactMoney("100"),
  discountText: { raw: "100", normalized: "100" },
  vat: {
    kind: "NONE",
    declarationText: { raw: "ไม่มี", normalized: "ไม่มี" },
  },
};

const DIRECT_COSTS_POSITIVE_VAT: SetPurchaseCostsCommand = {
  ...DIRECT_COSTS,
  vat: {
    kind: "AMOUNT",
    amount: exactMoney("70"),
    declarationText: { raw: "70 บาท", normalized: "70 บาท" },
    includedInItemPrices: true,
    includedInItemPricesText: { raw: "ใช่", normalized: "ใช่" },
    recoverable: true,
    recoverableText: { raw: "ใช่", normalized: "ใช่" },
  },
};

const DIRECT_CLOSE: ClosePurchaseCommand = {
  kind: "CLOSE_PURCHASE",
  contractVersion: PURCHASE_CONTRACT_VERSION,
  expectedItemCount: BigInt(1),
  expectedItemCountText: { raw: "1", normalized: "1" },
};

function postbackEvidence(
  ordinal: number,
): GuidedPostbackEvidenceMetadata {
  return {
    source: "GUIDED_POSTBACK",
    postbackEventId: `postback-${ordinal}`,
    eventTimestampMs: BigInt("1785232800000") + BigInt(ordinal),
    rawPostbackData: `opaque:v1:${ordinal}`,
    action: `purchase.action.${ordinal}`,
  };
}

describe("purchase evidence assembler happy paths", () => {
  test("assembles one complete pasted document structurally", () => {
    const result = assembleText(COMPLETE_DOCUMENT);
    expect(result.status).toBe("COMPLETE");
    expect(result.errors).toEqual([]);
    expect(result.evidence.header?.kind).toBe("OPEN_PURCHASE");
    expect(result.evidence.items).toHaveLength(2);
    expect(result.evidence.costs?.kind).toBe("SET_PURCHASE_COSTS");
    expect(result.evidence.close?.expectedItemCount).toBe(BigInt(2));
    expect(result.evidence.intendedWarehouseCode).toBe("MAIN");
    expect(result.evidence.rawTextChunks[0]?.rawText).toBe(COMPLETE_DOCUMENT);
  });

  test("separate ordered LINE messages produce domain-equivalent commands", () => {
    const pastedChunk = makeChunk(COMPLETE_DOCUMENT);
    const pasted = extractPurchaseCommandsFromTextChunks([pastedChunk]);
    const separateChunks = [
      makeChunk(HEADER_KNOWN, 1),
      makeChunk(ITEM_ONE, 2),
      makeChunk(ITEM_TWO_UNKNOWN, 3),
      makeChunk(COSTS_NO_VAT, 4),
      makeChunk("ปิดซื้อ 2 รายการ", 5),
    ];
    const separate = extractPurchaseCommandsFromTextChunks(separateChunks);
    expect(separate.map((envelope) => envelope.command)).toEqual(
      pasted.map((envelope) => envelope.command),
    );

    const assembled = assemblePurchaseEvidence({
      chunks: separateChunks,
      postbackEvidence: [],
      commandEnvelopes: separate,
    });
    expect(assembled.status).toBe("COMPLETE");
    expect(assembled.evidence.rawTextChunks).toHaveLength(5);
  });

  test("positive VAT is complete in pasted and separate-chunk evidence", () => {
    const raw = [
      HEADER_KNOWN,
      ITEM_ONE,
      COSTS_POSITIVE_VAT,
      "ปิดซื้อ 1 รายการ",
    ].join("\n\n");
    const pasted = assembleText(raw);
    expect(pasted.status).toBe("COMPLETE");
    expect(pasted.evidence.costs?.vat.kind).toBe("AMOUNT");
    if (pasted.evidence.costs?.vat.kind === "AMOUNT") {
      expect(pasted.evidence.costs.vat.amount.satang).toBe(BigInt(7000));
    }

    const chunks = [
      makeChunk(HEADER_KNOWN, 1),
      makeChunk(ITEM_ONE, 2),
      makeChunk(COSTS_POSITIVE_VAT, 3),
      makeChunk("ปิดซื้อ 1 รายการ", 4),
    ];
    const commandEnvelopes = extractPurchaseCommandsFromTextChunks(chunks);
    const separate = assemblePurchaseEvidence({
      chunks,
      postbackEvidence: [],
      commandEnvelopes,
    });
    expect(separate.status).toBe("COMPLETE");
    expect(commandEnvelopes.map((entry) => entry.command)).toEqual(
      pasted.commandEnvelopes.map((entry) => entry.command),
    );
  });

  test("review flags do not make structurally complete evidence incomplete", () => {
    const raw = [
      HEADER_UNKNOWN,
      ITEM_ONE.replace("ราคา: 85 บาท/โล", "ราคา: ไม่ทราบ"),
      COSTS_NO_VAT,
      "ปิดซื้อ 1 รายการ",
    ].join("\n\n");
    const result = assembleText(raw);
    expect(result.status).toBe("COMPLETE");
    expect(result.reviewFlags.map((flag) => flag.code)).toEqual([
      "UNKNOWN_PURCHASE_TIME",
      "NO_REFERENCE",
      "MISSING_UNIT_RATE",
    ]);
  });

  test("repeated products remain independent item commands", () => {
    const second = ITEM_ONE
      .replace("ซื้อรายการ 1", "ซื้อรายการ 2")
      .replace("120 โล", "5 โล");
    const result = assembleText(
      [HEADER_KNOWN, ITEM_ONE, second, COSTS_NO_VAT, "ปิดซื้อ 2 รายการ"].join(
        "\n\n",
      ),
    );
    expect(result.status).toBe("COMPLETE");
    expect(result.evidence.items.map((item) => item.productText.raw)).toEqual([
      "หมอนทอง",
      "หมอนทอง",
    ]);
    expect(
      result.evidence.items.map((item) => item.quantity.coefficient),
    ).toEqual([BigInt("120"), BigInt("5")]);
  });
});

describe("assembler preserves evidence and fails closed", () => {
  test("retains invalid candidates instead of inventing commands", () => {
    const raw = [
      HEADER_KNOWN,
      ITEM_ONE,
      "ซื้อรายการX",
      COSTS_NO_VAT,
      "ปิดซื้อ 1 รายการ",
    ].join("\n\n");
    const result = assembleText(raw);
    expect(result.status).toBe("INCOMPLETE");
    const invalid = result.commandEnvelopes.find(
      (envelope) => envelope.status === "INVALID",
    );
    expect(invalid?.command).toBeNull();
    expect(invalid?.errors.map((error) => error.code)).toContain(
      "INVALID_RESERVED_PURCHASE_BLOCK",
    );
  });

  test("fails closed for an INVALID envelope even if a caller omitted errors", () => {
    const parsed = textEnvelopes(COMPLETE_DOCUMENT);
    const provenance = parsed.envelopes[0]?.provenance;
    expect(provenance).toBeDefined();
    if (!provenance) return;
    const invalidWithoutErrors: PurchaseCommandEnvelope = {
      status: "INVALID",
      commandOrdinal: 6,
      command: null,
      provenance,
      errors: [],
      reviewFlags: [],
    };
    const result = assemblePurchaseEvidence({
      chunks: parsed.chunks,
      postbackEvidence: [],
      commandEnvelopes: [...parsed.envelopes, invalidWithoutErrors],
    });
    expect(result.status).toBe("INCOMPLETE");
    expect(issueCodes(result)).toContain("UNRECOGNIZED_LINE");
  });

  test("retains blank, unrelated, and invalid raw chunks independently", () => {
    const commandChunk = makeChunk(COMPLETE_DOCUMENT, 1);
    const blankChunk = makeChunk("\n\n", 2);
    const unrelatedChunk = makeChunk("ordinary chat", 3);
    const envelopes = extractPurchaseCommandsFromTextChunks([
      commandChunk,
      blankChunk,
      unrelatedChunk,
    ]);
    const result = assemblePurchaseEvidence({
      chunks: [commandChunk, blankChunk, unrelatedChunk],
      postbackEvidence: [],
      commandEnvelopes: envelopes,
    });
    expect(result.evidence.rawTextChunks.map((chunk) => chunk.rawText)).toEqual([
      COMPLETE_DOCUMENT,
      "\n\n",
      "ordinary chat",
    ]);
    expect(result.status).toBe("INCOMPLETE");
    expect(issueCodes(result)).toContain("UNRECOGNIZED_LINE");
  });

  test("does not sort descending timestamps or supplied command order", () => {
    const chunks = [
      createPurchaseTextChunk({
        chunkId: "header",
        chunkOrdinal: 1,
        rawText: HEADER_KNOWN,
        evidence: lineEvidence("header", "2000"),
      }),
      createPurchaseTextChunk({
        chunkId: "item",
        chunkOrdinal: 2,
        rawText: ITEM_ONE,
        evidence: lineEvidence("item", "1000"),
      }),
      createPurchaseTextChunk({
        chunkId: "costs",
        chunkOrdinal: 3,
        rawText: COSTS_NO_VAT,
        evidence: lineEvidence("costs", "500"),
      }),
      createPurchaseTextChunk({
        chunkId: "close",
        chunkOrdinal: 4,
        rawText: "ปิดซื้อ 1 รายการ",
        evidence: lineEvidence("close", "100"),
      }),
    ];
    const envelopes = extractPurchaseCommandsFromTextChunks(chunks);
    const result = assemblePurchaseEvidence({
      chunks,
      postbackEvidence: [],
      commandEnvelopes: envelopes,
    });
    expect(result.status).toBe("COMPLETE");
    expect(result.commandEnvelopes.map((entry) => entry.command?.kind)).toEqual([
      "OPEN_PURCHASE",
      "ADD_PURCHASE_ITEM",
      "SET_PURCHASE_COSTS",
      "CLOSE_PURCHASE",
    ]);
  });

  test("accepts frozen input arrays without mutating or sorting them", () => {
    const chunk = makeChunk(COMPLETE_DOCUMENT);
    const chunks = Object.freeze([chunk]);
    const envelopes = Object.freeze(
      extractPurchaseCommandsFromTextChunks(chunks),
    );
    const input = Object.freeze({
      chunks,
      postbackEvidence: Object.freeze([]),
      commandEnvelopes: envelopes,
    });
    const before = envelopes.map((envelope) => envelope.commandOrdinal);
    expect(() => assemblePurchaseEvidence(input)).not.toThrow();
    expect(envelopes.map((envelope) => envelope.commandOrdinal)).toEqual(before);
  });

  test("flags nonmonotonic command and chunk ordinals without sorting", () => {
    const first = makeChunk(HEADER_KNOWN, 2, "later");
    const second = makeChunk(ITEM_ONE, 1, "earlier");
    const parsed = extractPurchaseCommandsFromTextChunks([first, second]);
    const reversedOrdinals = parsed.map((envelope, index) => ({
      ...envelope,
      commandOrdinal: index === 0 ? 2 : 1,
    })) as PurchaseCommandEnvelope[];
    const result = assemblePurchaseEvidence({
      chunks: [first, second],
      postbackEvidence: [],
      commandEnvelopes: reversedOrdinals,
    });
    expect(issueCodes(result)).toContain("OUT_OF_ORDER_EVIDENCE");
    expect(result.commandEnvelopes).toEqual(reversedOrdinals);
  });

  test("retains supplied postback evidence independently of commands", () => {
    const evidence = postbackEvidence(99);
    const result = assemblePurchaseEvidence({
      chunks: [],
      postbackEvidence: [evidence],
      commandEnvelopes: [],
    });
    expect(result.evidence.postbackEvidence).toEqual([evidence]);
    expect(result.status).toBe("INCOMPLETE");
  });
});

describe("assembler structural diagnostics", () => {
  test("reports missing header", () => {
    const result = assembleText(
      [ITEM_ONE, COSTS_NO_VAT, "ปิดซื้อ 1 รายการ"].join("\n\n"),
    );
    expect(issueCodes(result)).toContain("MISSING_HEADER");
    expect(issueCodes(result)).toContain("ITEM_BEFORE_HEADER");
  });

  test("reports duplicate and non-first header", () => {
    const result = assembleText(
      [
        ITEM_ONE,
        HEADER_KNOWN,
        HEADER_KNOWN,
        COSTS_NO_VAT,
        "ปิดซื้อ 1 รายการ",
      ].join("\n\n"),
    );
    expect(issueCodes(result)).toContain("HEADER_NOT_FIRST");
    expect(issueCodes(result)).toContain("DUPLICATE_HEADER");
    expect(issueCodes(result)).toContain("ITEM_BEFORE_HEADER");
  });

  test("reports no parsed items using the frozen missing-item-field code", () => {
    const result = assembleText(
      [HEADER_KNOWN, COSTS_NO_VAT, "ปิดซื้อ 1 รายการ"].join("\n\n"),
    );
    expect(issueCodes(result)).toContain("MISSING_ITEM_FIELD");
    expect(result.status).toBe("INCOMPLETE");
  });

  test("reports missing, duplicate, and misordered costs", () => {
    const missing = assembleText(
      [HEADER_KNOWN, ITEM_ONE, "ปิดซื้อ 1 รายการ"].join("\n\n"),
    );
    expect(issueCodes(missing)).toContain("MISSING_COSTS");

    const duplicate = assembleText(
      [
        HEADER_KNOWN,
        ITEM_ONE,
        COSTS_NO_VAT,
        COSTS_NO_VAT,
        "ปิดซื้อ 1 รายการ",
      ].join("\n\n"),
    );
    expect(issueCodes(duplicate)).toContain("DUPLICATE_COSTS");

    const before = assembleText(
      [HEADER_KNOWN, COSTS_NO_VAT, ITEM_ONE, "ปิดซื้อ 1 รายการ"].join(
        "\n\n",
      ),
    );
    expect(issueCodes(before)).toContain("COSTS_BEFORE_ITEM");
  });

  test("reports missing, duplicate, mismatched, and non-final close", () => {
    const missing = assembleText(
      [HEADER_KNOWN, ITEM_ONE, COSTS_NO_VAT].join("\n\n"),
    );
    expect(issueCodes(missing)).toContain("MISSING_CLOSE");

    const duplicate = assembleText(
      [
        HEADER_KNOWN,
        ITEM_ONE,
        COSTS_NO_VAT,
        "ปิดซื้อ 1 รายการ",
        "ปิดซื้อ 1 รายการ",
      ].join("\n\n"),
    );
    expect(issueCodes(duplicate)).toContain("DUPLICATE_CLOSE");
    expect(issueCodes(duplicate)).toContain("CLOSE_NOT_LAST");
    expect(issueCodes(duplicate)).toContain("COMMAND_AFTER_CLOSE");

    const mismatch = assembleText(
      [HEADER_KNOWN, ITEM_ONE, COSTS_NO_VAT, "ปิดซื้อ 2 รายการ"].join(
        "\n\n",
      ),
    );
    expect(issueCodes(mismatch)).toContain("CLOSE_COUNT_MISMATCH");
  });

  test("commands and invalid candidates after close remain visible", () => {
    const result = assembleText(
      [
        HEADER_KNOWN,
        ITEM_ONE,
        COSTS_NO_VAT,
        "ปิดซื้อ 2 รายการ",
        ITEM_TWO_UNKNOWN,
        "unknown after close",
      ].join("\n\n"),
    );
    expect(issueCodes(result)).toContain("CLOSE_NOT_LAST");
    expect(issueCodes(result).filter((code) => code === "COMMAND_AFTER_CLOSE"))
      .toHaveLength(2);
    expect(result.evidence.items).toHaveLength(2);
    expect(result.commandEnvelopes.at(-1)?.status).toBe("INVALID");
  });

  test("duplicate, gapped, and descending item numbers remain unsorted", () => {
    const itemOneDuplicate = ITEM_ONE.replace("หมอนทอง", "หมอน");
    const itemThree = ITEM_ONE
      .replace("ซื้อรายการ 1", "ซื้อรายการ 3")
      .replace("หมอนทอง", "สาลี่");
    const itemTwo = ITEM_ONE
      .replace("ซื้อรายการ 1", "ซื้อรายการ 2")
      .replace("หมอนทอง", "สาลี่น้ำผึ้ง");
    const result = assembleText(
      [
        HEADER_KNOWN,
        ITEM_ONE,
        itemOneDuplicate,
        itemThree,
        itemTwo,
        COSTS_NO_VAT,
        "ปิดซื้อ 4 รายการ",
      ].join("\n\n"),
    );
    expect(result.evidence.items.map((item) => item.itemNumber)).toEqual([
      BigInt(1),
      BigInt(1),
      BigInt(3),
      BigInt(2),
    ]);
    expect(issueCodes(result)).toContain("DUPLICATE_ITEM_NUMBER");
    expect(issueCodes(result)).toContain("ITEM_NUMBER_GAP");
  });
});

describe("guided-menu typed command convergence", () => {
  test("all four text commands equal directly typed postback commands", () => {
    const text = extractPurchaseCommandsFromTextChunks([
      makeChunk(
        [
          HEADER_KNOWN,
          ITEM_ONE,
          COSTS_POSITIVE_VAT,
          "ปิดซื้อ 1 รายการ",
        ].join("\n\n"),
      ),
    ]);
    const direct: PurchaseCommand[] = [
      DIRECT_OPEN,
      DIRECT_ITEM,
      DIRECT_COSTS_POSITIVE_VAT,
      DIRECT_CLOSE,
    ];
    expect(text.map((entry) => entry.command)).toEqual(direct);

    const guided = direct.map((command, index) =>
      createGuidedPurchaseCommandEnvelope({
        commandOrdinal: index + 1,
        command,
        evidence: postbackEvidence(index + 1),
      }),
    );
    expect(guided.map((entry) => entry.command)).toEqual(
      text.map((entry) => entry.command),
    );
    expect(
      guided.every(
        (entry) =>
          entry.status === "PARSED"
          && entry.provenance.source === "GUIDED_POSTBACK",
      ),
    ).toBe(true);
  });

  test("assembles a complete all-postback command stream without text chunks", () => {
    const evidence = [1, 2, 3, 4].map(postbackEvidence);
    const envelopes = [
      DIRECT_OPEN,
      DIRECT_ITEM,
      DIRECT_COSTS,
      DIRECT_CLOSE,
    ].map((command, index) =>
      createGuidedPurchaseCommandEnvelope({
        commandOrdinal: index + 1,
        command,
        evidence: evidence[index]!,
      }),
    );
    const result = assemblePurchaseEvidence({
      chunks: [],
      postbackEvidence: evidence,
      commandEnvelopes: envelopes,
    });
    expect(result.status).toBe("COMPLETE");
    expect(result.evidence.rawTextChunks).toEqual([]);
    expect(result.evidence.postbackEvidence).toEqual(evidence);
    expect(
      result.commandEnvelopes.every(
        (envelope) => envelope.provenance.source === "GUIDED_POSTBACK",
      ),
    ).toBe(true);
  });

  test("supports postback open/close around text item/cost blocks", () => {
    const itemChunk = makeChunk(ITEM_ONE, 2, "item-text");
    const costsChunk = makeChunk(COSTS_NO_VAT, 3, "costs-text");
    const text = extractPurchaseCommandsFromTextChunks([
      itemChunk,
      costsChunk,
    ]).map((envelope, index) => ({
      ...envelope,
      commandOrdinal: index + 2,
    })) as PurchaseCommandEnvelope[];
    const openEvidence = postbackEvidence(1);
    const closeEvidence = postbackEvidence(4);
    const envelopes = [
      createGuidedPurchaseCommandEnvelope({
        commandOrdinal: 1,
        command: DIRECT_OPEN,
        evidence: openEvidence,
      }),
      ...text,
      createGuidedPurchaseCommandEnvelope({
        commandOrdinal: 4,
        command: DIRECT_CLOSE,
        evidence: closeEvidence,
      }),
    ];
    const result = assemblePurchaseEvidence({
      chunks: [itemChunk, costsChunk],
      postbackEvidence: [openEvidence, closeEvidence],
      commandEnvelopes: envelopes,
    });
    expect(result.status).toBe("COMPLETE");
    expect(result.commandEnvelopes.map((entry) => entry.provenance.source)).toEqual([
      "GUIDED_POSTBACK",
      "TEXT_BLOCK",
      "TEXT_BLOCK",
      "GUIDED_POSTBACK",
    ]);
  });

  test("opaque postback data cannot alter typed command business fields", () => {
    const first = createGuidedPurchaseCommandEnvelope({
      commandOrdinal: 1,
      command: DIRECT_OPEN,
      evidence: {
        ...postbackEvidence(1),
        rawPostbackData: "opaque:not-thai:not-a-command",
      },
    });
    const second = createGuidedPurchaseCommandEnvelope({
      commandOrdinal: 1,
      command: DIRECT_OPEN,
      evidence: {
        ...postbackEvidence(1),
        rawPostbackData: "another|opaque|value",
      },
    });
    expect(first.command).toEqual(second.command);
    expect(first.provenance).not.toEqual(second.provenance);
  });

  test("guided commands derive mandatory review flags at the shared boundary", () => {
    const unknownHeader: OpenPurchaseCommand = {
      ...DIRECT_OPEN,
      purchaseTime: null,
      purchaseTimeText: {
        raw: "ไม่ทราบเวลา",
        normalized: "ไม่ทราบเวลา",
      },
      referenceText: null,
      referenceDeclarationText: { raw: "ไม่มี", normalized: "ไม่มี" },
    };
    const missingRate: AddPurchaseItemCommand = {
      ...DIRECT_ITEM,
      unitRate: null,
      unitRateText: { raw: "ไม่ทราบ", normalized: "ไม่ทราบ" },
      priceUnitText: null,
    };
    const zeroMismatch: AddPurchaseItemCommand = {
      ...DIRECT_ITEM,
      unitRate: exactRate("0"),
      unitRateText: { raw: "0", normalized: "0" },
      priceUnitText: { raw: "ตะกร้า", normalized: "ตะกร้า" },
    };

    const openEnvelope = createGuidedPurchaseCommandEnvelope({
      commandOrdinal: 1,
      command: unknownHeader,
      evidence: postbackEvidence(1),
    });
    const missingEnvelope = createGuidedPurchaseCommandEnvelope({
      commandOrdinal: 2,
      command: missingRate,
      evidence: postbackEvidence(2),
    });
    const zeroEnvelope = createGuidedPurchaseCommandEnvelope({
      commandOrdinal: 3,
      command: zeroMismatch,
      evidence: postbackEvidence(3),
    });
    expect(openEnvelope.reviewFlags.map((flag) => flag.code)).toEqual([
      "UNKNOWN_PURCHASE_TIME",
      "NO_REFERENCE",
    ]);
    expect(missingEnvelope.reviewFlags.map((flag) => flag.code)).toEqual([
      "MISSING_UNIT_RATE",
    ]);
    expect(zeroEnvelope.reviewFlags.map((flag) => flag.code)).toEqual([
      "ZERO_UNIT_RATE",
      "PRICE_UNIT_REQUIRES_RESOLUTION",
    ]);
  });

  test.each([
    [
      {
        ...DIRECT_OPEN,
        purchaseDate: "2026-02-30",
        purchaseDateText: { raw: "30/02/2569", normalized: "30/02/2569" },
      } as PurchaseCommand,
      "INVALID_PURCHASE_DATE",
    ],
    [
      {
        ...DIRECT_ITEM,
        itemNumber: BigInt(501),
        itemNumberText: { raw: "501", normalized: "501" },
      } as PurchaseCommand,
      "INVALID_ITEM_NUMBER",
    ],
    [
      {
        ...DIRECT_ITEM,
        quantity: exactQuantity("0"),
        quantityText: { raw: "0", normalized: "0" },
      } as PurchaseCommand,
      "INVALID_QUANTITY",
    ],
    [
      {
        ...DIRECT_COSTS_POSITIVE_VAT,
        vat: {
          ...DIRECT_COSTS_POSITIVE_VAT.vat,
          kind: "AMOUNT",
          amount: exactMoney("0"),
          declarationText: { raw: "0 บาท", normalized: "0 บาท" },
        },
      } as PurchaseCommand,
      "VAT_ZERO_MUST_USE_NONE",
    ],
    [
      {
        ...DIRECT_CLOSE,
        expectedItemCount: BigInt(0),
        expectedItemCountText: { raw: "0", normalized: "0" },
      } as PurchaseCommand,
      "CLOSE_COUNT_MISMATCH",
    ],
  ] as const)(
    "guided typed values fail closed with %s",
    (command, expectedCode) => {
      const envelope = createGuidedPurchaseCommandEnvelope({
        commandOrdinal: 1,
        command,
        evidence: postbackEvidence(1),
      });
      expect(envelope.status).toBe("INVALID");
      expect(envelope.command).toBeNull();
      expect(envelope.errors.map((error) => error.code)).toContain(
        expectedCode,
      );
    },
  );

  test.each([
    [
      {
        ...DIRECT_OPEN,
        purchaseTime: null,
      } as PurchaseCommand,
      "INVALID_PURCHASE_TIME",
    ],
    [
      {
        ...DIRECT_OPEN,
        referenceText: null,
      } as PurchaseCommand,
      "MISSING_REFERENCE_DECLARATION",
    ],
    [
      {
        ...DIRECT_ITEM,
        unitRate: null,
        priceUnitText: null,
      } as PurchaseCommand,
      "INVALID_UNIT_RATE",
    ],
    [
      {
        ...DIRECT_COSTS,
        vat: {
          kind: "NONE",
          declarationText: { raw: "70 บาท", normalized: "70 บาท" },
        },
      } as PurchaseCommand,
      "INVALID_VAT_DECLARATION",
    ],
    [
      {
        ...DIRECT_COSTS,
        vat: {
          ...DIRECT_COSTS.vat,
          includedInItemPrices: true,
          includedInItemPricesText: { raw: "ใช่", normalized: "ใช่" },
        },
      } as PurchaseCommand,
      "INVALID_VAT_DECLARATION",
    ],
    [
      {
        ...DIRECT_COSTS_POSITIVE_VAT,
        vat: {
          ...DIRECT_COSTS_POSITIVE_VAT.vat,
          declarationText: { raw: "71 บาท", normalized: "71 บาท" },
        },
      } as PurchaseCommand,
      "INVALID_VAT_DECLARATION",
    ],
    [
      {
        ...DIRECT_COSTS_POSITIVE_VAT,
        vat: {
          ...DIRECT_COSTS_POSITIVE_VAT.vat,
          includedInItemPrices: false,
        },
      } as PurchaseCommand,
      "INVALID_VAT_DECLARATION",
    ],
    [
      {
        ...DIRECT_COSTS_POSITIVE_VAT,
        vat: {
          ...DIRECT_COSTS_POSITIVE_VAT.vat,
          recoverable: false,
        },
      } as PurchaseCommand,
      "INVALID_VAT_DECLARATION",
    ],
  ] as const)(
    "guided declarations must agree with typed value semantics",
    (command, expectedCode) => {
      const envelope = createGuidedPurchaseCommandEnvelope({
        commandOrdinal: 1,
        command,
        evidence: postbackEvidence(1),
      });
      expect(envelope.status).toBe("INVALID");
      expect(envelope.reviewFlags).toEqual([]);
      expect(envelope.errors.map((error) => error.code)).toContain(
        expectedCode,
      );
    },
  );
});
