import { describe, expect, test } from "bun:test";
import {
  CLOSE_TWO,
  COSTS_NO_VAT,
  HEADER_KNOWN,
  ITEM_ONE,
  ITEM_TWO_UNKNOWN,
} from "@/lib/purchases/test-helpers";
import {
  buildPurchaseReceiptDraftInput,
  parsePurchaseCaptureAssembly,
  sortPurchaseCaptureIngests,
} from "./parser-adapter";
import type { PurchaseCaptureParseContext } from "./parser-adapter";

const CLOSE_ONE = "ปิดซื้อ 1 รายการ";

const context: PurchaseCaptureParseContext = {
  sourceType: "group",
  sourceId: "G-test",
  senderLineUserId: "U-test",
  openedLineEventId: "evt-open",
};

function ingest(
  lineEventId: string,
  lineTimestampMs: number,
  rawText: string,
  ingestOrdinal: number,
) {
  return {
    line_event_id: lineEventId,
    line_timestamp_ms: lineTimestampMs,
    kind: "item" as const,
    raw_text: rawText,
    ingest_ordinal: ingestOrdinal,
    line_message_id: `msg-${lineEventId}`,
    raw_message_id: null,
  };
}

const emptyRegistries = {
  products: new Map(),
  units: new Map(),
};

describe("purchase capture parser adapter", () => {
  test("sorts ingests by line_timestamp_ms then line_event_id", () => {
    const sorted = sortPurchaseCaptureIngests([
      ingest("evt-b", 2000, "B", 2),
      ingest("evt-a", 1000, "A", 3),
      ingest("evt-c", 2000, "C", 1),
    ]);
    expect(sorted.map((row) => row.line_event_id)).toEqual(["evt-a", "evt-b", "evt-c"]);
  });

  test("opposite HTTP/admission order gives identical assembly", () => {
    const chunks = [HEADER_KNOWN, ITEM_ONE, COSTS_NO_VAT, CLOSE_ONE];
    const admissionOrder = [
      ingest("evt-close", 5000, CLOSE_ONE, 4),
      ingest("evt-costs", 4000, COSTS_NO_VAT, 3),
      ingest("evt-item", 3000, ITEM_ONE, 2),
      ingest("evt-header", 2000, HEADER_KNOWN, 1),
    ];
    const documentOrder = [
      ingest("evt-header", 2000, HEADER_KNOWN, 99),
      ingest("evt-item", 3000, ITEM_ONE, 98),
      ingest("evt-costs", 4000, COSTS_NO_VAT, 97),
      ingest("evt-close", 5000, CLOSE_ONE, 4),
    ];

    const assemblyA = parsePurchaseCaptureAssembly(admissionOrder, context);
    const assemblyB = parsePurchaseCaptureAssembly(documentOrder, context);
    expect(assemblyA.status).toBe("COMPLETE");
    expect(assemblyB.status).toBe("COMPLETE");
    expect(assemblyA.evidence.rawTextChunks.map((c) => c.chunkOrdinal)).toEqual(
      assemblyB.evidence.rawTextChunks.map((c) => c.chunkOrdinal),
    );
    expect(assemblyA.evidence.rawTextChunks.map((c) => c.rawText)).toEqual(chunks);
  });

  test("one-message complete document", () => {
    const raw = [HEADER_KNOWN, ITEM_ONE, COSTS_NO_VAT, CLOSE_ONE].join("\n\n");
    const assembly = parsePurchaseCaptureAssembly(
      [ingest("evt-all", 1000, raw, 1)],
      context,
    );
    expect(assembly.status).toBe("COMPLETE");
    const draft = buildPurchaseReceiptDraftInput({
      assembly,
      context,
      ...emptyRegistries,
    });
    expect(draft).not.toBeNull();
    expect(draft?.documentNamespace).toBe("line-text");
    expect(draft?.documentKey).toBe("evt-open");
  });

  test("supplier key and raw are emitted as a pair", () => {
    // purchase_receipts_supplier_pairing rejects a raw supplier with a NULL key.
    const raw = [HEADER_KNOWN, ITEM_ONE, COSTS_NO_VAT, CLOSE_ONE].join("\n\n");
    const assembly = parsePurchaseCaptureAssembly([ingest("evt-all", 1000, raw, 1)], context);
    const draft = buildPurchaseReceiptDraftInput({ assembly, context, ...emptyRegistries });
    expect(draft?.supplierRaw).toBe("ร้านเจ๊แดง");
    expect(draft?.supplierKey).toBe("ร้านเจ๊แดง");
  });

  test("multi-message complete document", () => {
    const ingests = [
      ingest("evt-header", 1000, HEADER_KNOWN, 1),
      ingest("evt-item", 2000, ITEM_ONE, 2),
      ingest("evt-costs", 3000, COSTS_NO_VAT, 3),
      ingest("evt-close", 4000, CLOSE_ONE, 4),
    ];
    const assembly = parsePurchaseCaptureAssembly(ingests, context);
    expect(assembly.status).toBe("COMPLETE");
    expect(assembly.evidence.rawTextChunks).toHaveLength(4);
  });

  test("missing close → INCOMPLETE assembly", () => {
    const assembly = parsePurchaseCaptureAssembly(
      [
        ingest("evt-header", 1000, HEADER_KNOWN, 1),
        ingest("evt-item", 2000, ITEM_ONE, 2),
        ingest("evt-costs", 3000, COSTS_NO_VAT, 3),
      ],
      context,
    );
    expect(assembly.status).toBe("INCOMPLETE");
    expect(buildPurchaseReceiptDraftInput({ assembly, context, ...emptyRegistries })).toBeNull();
  });

  test("close count mismatch → INCOMPLETE", () => {
    const assembly = parsePurchaseCaptureAssembly(
      [
        ingest("evt-header", 1000, HEADER_KNOWN, 1),
        ingest("evt-item", 2000, ITEM_ONE, 2),
        ingest("evt-item2", 2500, ITEM_TWO_UNKNOWN, 3),
        ingest("evt-costs", 3000, COSTS_NO_VAT, 4),
        ingest("evt-close", 4000, "ปิดซื้อ 1 รายการ", 5),
      ],
      context,
    );
    expect(assembly.status).toBe("INCOMPLETE");
  });

  test("review flags remain non-blocking in draft", () => {
    const assembly = parsePurchaseCaptureAssembly(
      [
        ingest("evt-header", 1000, HEADER_KNOWN, 1),
        ingest("evt-item", 2000, ITEM_ONE, 2),
        ingest("evt-unknown", 2500, ITEM_TWO_UNKNOWN, 3),
        ingest("evt-costs", 3000, COSTS_NO_VAT, 4),
        ingest("evt-close", 4000, CLOSE_TWO, 5),
      ],
      context,
    );
    expect(assembly.status).toBe("COMPLETE");
    expect(assembly.reviewFlags.length).toBeGreaterThan(0);
    const draft = buildPurchaseReceiptDraftInput({ assembly, context, ...emptyRegistries });
    expect(draft).not.toBeNull();
    expect((draft?.reviewFlags ?? []).length).toBeGreaterThan(0);
  });

  test("preserves every original raw evidence chunk", () => {
    const ingests = [
      ingest("evt-header", 1000, HEADER_KNOWN, 1),
      ingest("evt-item", 2000, ITEM_ONE, 2),
      ingest("evt-costs", 3000, COSTS_NO_VAT, 3),
      ingest("evt-close", 4000, CLOSE_ONE, 4),
    ];
    const assembly = parsePurchaseCaptureAssembly(ingests, context);
    const draft = buildPurchaseReceiptDraftInput({ assembly, context, ...emptyRegistries });
    const chunks = (draft?.sourceEvidence as { rawTextChunks?: Array<{ rawText: string }> })
      ?.rawTextChunks ?? [];
    expect(chunks.map((c) => c.rawText)).toEqual([
      HEADER_KNOWN,
      ITEM_ONE,
      COSTS_NO_VAT,
      CLOSE_ONE,
    ]);
  });
});
