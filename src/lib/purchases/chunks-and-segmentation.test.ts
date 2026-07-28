import { describe, expect, test } from "bun:test";
import {
  classifyPurchaseBlock,
  createPurchaseTextChunk,
  extractPurchaseCommandsFromTextChunks,
  segmentPurchaseChunk,
} from "./index";
import {
  CLOSE_TWO,
  COMPLETE_DOCUMENT,
  COSTS_NO_VAT,
  HEADER_KNOWN,
  ITEM_ONE,
  ITEM_TWO_UNKNOWN,
  firstBlock,
  lineEvidence,
  makeChunk,
  wholeChunkBlock,
} from "./test-helpers";

function codes(
  envelopes: ReturnType<typeof extractPurchaseCommandsFromTextChunks>,
): string[] {
  return envelopes.flatMap((envelope) =>
    envelope.errors.map((error) => error.code),
  );
}

describe("raw purchase chunks", () => {
  test("normalizes line endings separately while preserving every raw line", () => {
    const chunk = makeChunk("a\r\nb\rc\n");
    expect(chunk.rawText).toBe("a\r\nb\rc\n");
    expect(chunk.normalizedParsingText).toBe("a\nb\nc\n");
    expect(chunk.lines.map((line) => line.rawText)).toEqual([
      "a",
      "b",
      "c",
      "",
    ]);
    expect(chunk.lines.map((line) => [line.startOffset, line.endOffset])).toEqual([
      [0, 1],
      [3, 4],
      [5, 6],
      [7, 7],
    ]);
  });

  test("measures offsets against original UTF-16 before NFC or CRLF folding", () => {
    const rawText = "ก😀e\u0301\r\nข";
    const chunk = makeChunk(rawText);
    expect(chunk.lines).toHaveLength(2);
    expect(chunk.lines[0]).toMatchObject({
      lineNumber: 1,
      startOffset: 0,
      endOffset: 5,
      rawText: "ก😀e\u0301",
      parsingText: "ก😀é",
    });
    expect(chunk.lines[1]).toMatchObject({
      lineNumber: 2,
      startOffset: 7,
      endOffset: 8,
      rawText: "ข",
    });
    for (const line of chunk.lines) {
      expect(rawText.slice(line.startOffset, line.endOffset)).toBe(line.rawText);
    }
  });

  test("removes a BOM only from the first parsing line", () => {
    const chunk = makeChunk("\uFEFFเริ่มซื้อ\n\uFEFFผู้ขาย");
    expect(chunk.lines[0]?.rawText.startsWith("\uFEFF")).toBe(true);
    expect(chunk.lines[0]?.parsingText).toBe("เริ่มซื้อ");
    expect(chunk.lines[1]?.parsingText).toBe("\uFEFFผู้ขาย");
  });

  test("trims only outer ASCII space/tab and preserves internal whitespace", () => {
    const chunk = makeChunk("\t  สินค้า: ของ  ดี \t\n\u00A0ข้อความ\u00A0");
    expect(chunk.lines[0]?.normalizedText).toBe("สินค้า: ของ  ดี");
    expect(chunk.lines[1]?.normalizedText).toBe("\u00A0ข้อความ\u00A0");
  });

  test("retains event timestamp solely as evidence metadata", () => {
    const evidence = lineEvidence("time", "9999999999999");
    const chunk = createPurchaseTextChunk({
      chunkId: "time",
      chunkOrdinal: 1,
      rawText: HEADER_KNOWN,
      evidence,
    });
    expect(chunk.evidence).toBe(evidence);
    expect(chunk.evidence.eventTimestampMs).toBe(BigInt("9999999999999"));
  });
});

describe("purchase block classification", () => {
  test.each([
    [HEADER_KNOWN, "HEADER"],
    [ITEM_ONE, "ITEM"],
    [COSTS_NO_VAT, "COSTS"],
    [CLOSE_TWO, "CLOSE"],
    ["ordinary chat", "NOT_PURCHASE"],
    ["", "EMPTY_BLOCK"],
  ])("classifies %p as %s", (raw, expected) => {
    expect(classifyPurchaseBlock(wholeChunkBlock(raw))).toBe(
      expected as ReturnType<typeof classifyPurchaseBlock>,
    );
  });

  test.each([
    "เริ่มซื้อ",
    "เริ่มซื้อขาย 28/07/2569",
    "ซื้อรายการX",
    "สรุปค่าใช้จ่ายซื้อเพิ่ม",
    "ปิดซื้อ",
  ])("retains malformed reserved opener %p", (raw) => {
    expect(classifyPurchaseBlock(firstBlock(raw))).toBe(
      "INVALID_RESERVED_PURCHASE_BLOCK",
    );
    const envelope = extractPurchaseCommandsFromTextChunks([makeChunk(raw)])[0];
    expect(envelope?.status).toBe("INVALID");
    expect(envelope?.command).toBeNull();
    expect(envelope?.errors.map((error) => error.code)).toContain(
      "INVALID_RESERVED_PURCHASE_BLOCK",
    );
  });

  test("ordinary text containing a reserved word away from the start is not purchase", () => {
    expect(
      classifyPurchaseBlock(firstBlock("ช่วยดูคำว่า เริ่มซื้อ ให้หน่อย")),
    ).toBe("NOT_PURCHASE");
  });

  test("does not treat NBSP as allowed outer matching whitespace", () => {
    expect(
      classifyPurchaseBlock(firstBlock(`\u00A0${HEADER_KNOWN}`)),
    ).toBe("NOT_PURCHASE");
  });

  test("does not collapse doubled opener whitespace", () => {
    expect(
      classifyPurchaseBlock(
        firstBlock(HEADER_KNOWN.replace("เริ่มซื้อ ", "เริ่มซื้อ  ")),
      ),
    ).toBe("INVALID_RESERVED_PURCHASE_BLOCK");
  });

  test("semantic bounds remain the specialized parser's responsibility", () => {
    expect(classifyPurchaseBlock(firstBlock("ซื้อรายการ 501"))).toBe("ITEM");
    expect(classifyPurchaseBlock(firstBlock("ปิดซื้อ 0 รายการ"))).toBe("CLOSE");
  });
});

describe("purchase block segmentation", () => {
  test("segments one complete pasted document into five ordered candidates", () => {
    const blocks = segmentPurchaseChunk(makeChunk(COMPLETE_DOCUMENT));
    expect(blocks.map((block) => classifyPurchaseBlock(block))).toEqual([
      "HEADER",
      "ITEM",
      "ITEM",
      "COSTS",
      "CLOSE",
    ]);
    expect(
      extractPurchaseCommandsFromTextChunks([makeChunk(COMPLETE_DOCUMENT)]),
    ).toHaveLength(5);
  });

  test("segments adjacent complete blocks without blank separators", () => {
    const raw = [HEADER_KNOWN, ITEM_ONE, COSTS_NO_VAT, "ปิดซื้อ 1 รายการ"].join(
      "\n",
    );
    expect(
      segmentPurchaseChunk(makeChunk(raw)).map(classifyPurchaseBlock),
    ).toEqual(["HEADER", "ITEM", "COSTS", "CLOSE"]);
  });

  test("blank lines inside a candidate remain in raw block evidence", () => {
    const raw = `เริ่มซื้อ 28/07/2569 06:30

ผู้ขาย: ร้านเจ๊แดง
ใบอ้างอิง: INV-123
ปลายทาง: MAIN`;
    const block = segmentPurchaseChunk(makeChunk(raw))[0];
    expect(block?.span.rawText).toBe(raw);
    expect(block?.span.lines.some((line) => line.rawText === "")).toBe(true);
  });

  test("malformed reserved and unknown candidates retain their positions", () => {
    const raw = `เริ่มซื้อผิด
${ITEM_ONE}
unknown evidence
${CLOSE_TWO}`;
    const envelopes = extractPurchaseCommandsFromTextChunks([makeChunk(raw)]);
    expect(envelopes.map((envelope) => envelope.status)).toEqual([
      "INVALID",
      "PARSED",
      "INVALID",
      "PARSED",
    ]);
    expect(envelopes.map((envelope) => envelope.commandOrdinal)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  test("a complete block followed by unknown text preserves both", () => {
    const envelopes = extractPurchaseCommandsFromTextChunks([
      makeChunk(`${HEADER_KNOWN}\nunknown trailing line`),
    ]);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]?.status).toBe("PARSED");
    expect(envelopes[1]?.status).toBe("INVALID");
    expect(codes(envelopes)).toContain("UNRECOGNIZED_LINE");
  });

  test("retains forbidden no-VAT detail lines with the costs candidate", () => {
    const envelopes = extractPurchaseCommandsFromTextChunks([
      makeChunk(`${COSTS_NO_VAT}
ภาษีรวมในราคาสินค้า: ใช่
ภาษีขอคืนได้: ใช่`),
    ]);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.status).toBe("INVALID");
    expect(codes(envelopes)).toContain("INVALID_VAT_DECLARATION");
  });
});

describe("deterministic cross-chunk split detection", () => {
  test.each([
    [
      `เริ่มซื้อ 28/07/2569 06:30
ผู้ขาย: ร้านเจ๊แดง`,
      `ใบอ้างอิง: INV-123
ปลายทาง: MAIN`,
    ],
    [
      `ซื้อรายการ 1
สินค้า: หมอนทอง
จำนวน: 120 โล`,
      "ราคา: 85 บาท/โล",
    ],
    [
      `สรุปค่าใช้จ่ายซื้อ
ค่าขนส่ง: 300 บาท
ค่าจัดการ: 50 บาท
ส่วนลด: 100 บาท`,
      "ภาษีมูลค่าเพิ่ม: ไม่มี",
    ],
    [
      `สรุปค่าใช้จ่ายซื้อ
ค่าขนส่ง: 300 บาท
ค่าจัดการ: 50 บาท
ส่วนลด: 100 บาท
ภาษีมูลค่าเพิ่ม: 70 บาท`,
      `ภาษีรวมในราคาสินค้า: ใช่
ภาษีขอคืนได้: ใช่`,
    ],
  ])("flags a proven continuation but never joins it", (first, second) => {
    const envelopes = extractPurchaseCommandsFromTextChunks([
      makeChunk(first, 1),
      makeChunk(second, 2),
    ]);
    expect(codes(envelopes)).toContain("BLOCK_SPLIT_ACROSS_CHUNKS");
    expect(envelopes.every((envelope) => envelope.status === "INVALID")).toBe(
      true,
    );
  });

  test.each([
    [
      `ซื้อรายการ 1
สินค้า: หมอนทอง
จำนวน: 120 โล`,
      "ordinary chat",
    ],
    [
      `ซื้อรายการ 1
สินค้า: หมอนทอง
จำนวน: 120 โล`,
      ITEM_TWO_UNKNOWN,
    ],
    [ITEM_ONE, "ราคา: 85 บาท/โล"],
    ["ปิดซื้อ", "2 รายการ"],
    ["ordinary chat", "ราคา: 85 บาท/โล"],
    [
      `ซื้อรายการ 1
สินค้า: หมอนทอง
จำนวน: 120 โล`,
      "ราคา:: 85 บาท/โล",
    ],
  ])("does not guess a split for %p followed by %p", (first, second) => {
    const envelopes = extractPurchaseCommandsFromTextChunks([
      makeChunk(first, 1),
      makeChunk(second, 2),
    ]);
    expect(codes(envelopes)).not.toContain("BLOCK_SPLIT_ACROSS_CHUNKS");
  });

  test("a blank-only chunk breaks deterministic adjacency", () => {
    const envelopes = extractPurchaseCommandsFromTextChunks([
      makeChunk(
        `ซื้อรายการ 1
สินค้า: หมอนทอง
จำนวน: 120 โล`,
        1,
      ),
      makeChunk("\n", 2),
      makeChunk("ราคา: 85 บาท/โล", 3),
    ]);
    expect(codes(envelopes)).not.toContain("BLOCK_SPLIT_ACROSS_CHUNKS");
  });

  test("adjacent supplied chunks remain adjacent when ordinals have gaps", () => {
    const envelopes = extractPurchaseCommandsFromTextChunks([
      makeChunk(
        `ซื้อรายการ 1
สินค้า: หมอนทอง
จำนวน: 120 โล`,
        1,
      ),
      makeChunk("ราคา: 85 บาท/โล", 3),
    ]);
    expect(codes(envelopes)).toContain("BLOCK_SPLIT_ACROSS_CHUNKS");
  });

  test("retains a wholly blank chunk as EMPTY_BLOCK evidence", () => {
    const envelopes = extractPurchaseCommandsFromTextChunks([
      makeChunk("\n\t\n", 1),
    ]);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.status).toBe("INVALID");
    expect(codes(envelopes)).toEqual(["EMPTY_BLOCK"]);
  });
});
