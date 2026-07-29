/**
 * Fail-closed validation tests.
 *
 * Every case here is a response the database should never send. The point is
 * that if one ever arrives — a renamed field, a NULL where a value belongs, a
 * future contract version, a total that quietly became zero — the client
 * REFUSES it rather than handing P2C a plausible-looking object.
 */
import { describe, expect, test } from "bun:test";
import {
  PurchaseContractViolationError,
  parseConfirmationPayload,
  parseConfirmationResponse,
} from "./validate";

const RECEIPT_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);

function validItem(overrides: Record<string, unknown> = {}) {
  return {
    receipt_item_id: ITEM_ID,
    item_ordinal: 1,
    item_number: "1",
    product_key: "mango",
    raw_product_text: "มะม่วง",
    product_identity_status: "RESOLVED",
    quantity: "2.5",
    unit_key: "kg",
    raw_unit: "กก.",
    unit_identity_status: "RESOLVED",
    unit_cost: "12.3456",
    price_unit_text: null,
    price_unit_status: "NOT_APPLICABLE",
    line_amount_satang: "3086",
    source_evidence: {},
    ...overrides,
  };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: "p2b-purchase-confirm-v1",
    receipt_id: RECEIPT_ID,
    document_namespace: "line-text",
    document_key: "DOC 1",
    parser_contract_version: "p2b-slice-a-v1",
    source: {
      source_type: "group",
      source_id: "G1",
      sender_line_user_id: null,
      source_line_event_id: "evt-1",
      source_raw_message_id: null,
      source_evidence: {},
    },
    business_date: "2026-07-29",
    purchase_time: null,
    supplier_key: null,
    supplier_raw: null,
    supplier_ref: null,
    reference_text: null,
    intended_warehouse_code: "MAIN",
    vat_kind: "NONE",
    vat_included_in_item_prices: null,
    vat_recoverable: null,
    item_count: 1,
    items: [validItem()],
    totals: {
      line_subtotal_satang: "3086",
      freight_satang: "0",
      handling_satang: "0",
      discount_satang: "0",
      vat_satang: null,
      payable_total_satang: "3086",
      declared_total_satang: null,
      reconciliation_status: "COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE",
    },
    blockers: [],
    has_blocking_blockers: false,
    posts_inventory_movement: false,
    posts_valuation: false,
    ...overrides,
  };
}

function validResponse(overrides: Record<string, unknown> = {}) {
  return {
    receipt_id: RECEIPT_ID,
    confirmation: {
      contract_version: "p2b-purchase-confirm-v1",
      canonical_form: "purchase-receipt-canonical-json-v1",
      hash_algorithm: "sha256",
      hash: HASH,
      confirmation_key: "ck-1",
      confirmed_at: "2026-07-29T03:00:00.000Z",
      confirmed_by: "tester",
      payload: validPayload(),
    },
    lifecycle: { status: "confirmed", posting_locked_at: null, posting_locked_by: null },
    void: null,
    correction: { supersedes_receipt_id: null, superseded_by_receipt_id: null },
    p2c_dedupe_key: `purchase-receipt-confirmation:v1:${RECEIPT_ID}:${HASH}`,
    replayed: false,
    ...overrides,
  };
}

describe("happy path", () => {
  test("accepts a well-formed confirmation response", () => {
    const parsed = parseConfirmationResponse(validResponse());
    expect(parsed.receiptId).toBe(RECEIPT_ID);
    expect(parsed.confirmation.hash).toBe(HASH);
    expect(parsed.confirmation.payload.items[0]!.receipt_item_id).toBe(ITEM_ID);
    expect(parsed.lifecycle.status).toBe("confirmed");
    expect(parsed.void).toBeNull();
  });

  test("accepts a voided receipt and still returns the frozen contract", () => {
    const parsed = parseConfirmationResponse(
      validResponse({
        lifecycle: { status: "void", posting_locked_at: null, posting_locked_by: null },
        void: { voided_at: "2026-07-29T04:00:00.000Z", voided_by: "staff", void_reason: "dupe" },
      }),
    );
    expect(parsed.lifecycle.status).toBe("void");
    expect(parsed.void?.void_reason).toBe("dupe");
    // History survives the void.
    expect(parsed.confirmation.payload.items).toHaveLength(1);
  });
});

describe("version and shape gates", () => {
  test("rejects an unsupported contract version", () => {
    const bad = validResponse();
    bad.confirmation.contract_version = "p2b-purchase-confirm-v2";
    expect(() => parseConfirmationResponse(bad)).toThrow(PurchaseContractViolationError);
  });

  test("rejects an unsupported canonical form", () => {
    const bad = validResponse();
    bad.confirmation.canonical_form = "raw-jsonb-text";
    expect(() => parseConfirmationResponse(bad)).toThrow(/canonical form/u);
  });

  test("rejects an unsupported hash algorithm", () => {
    const bad = validResponse();
    bad.confirmation.hash_algorithm = "md5";
    expect(() => parseConfirmationResponse(bad)).toThrow(/hash algorithm/u);
  });

  test("rejects a malformed hash", () => {
    const bad = validResponse();
    bad.confirmation.hash = "not-a-hash";
    expect(() => parseConfirmationResponse(bad)).toThrow(/sha256/u);
  });

  test("rejects a non-object response", () => {
    expect(() => parseConfirmationResponse(null)).toThrow(PurchaseContractViolationError);
    expect(() => parseConfirmationResponse([])).toThrow(PurchaseContractViolationError);
    expect(() => parseConfirmationResponse("ok")).toThrow(PurchaseContractViolationError);
  });

  test("rejects a malformed receipt UUID", () => {
    expect(() => parseConfirmationResponse(validResponse({ receipt_id: "123" }))).toThrow(/UUID/u);
  });

  test("rejects a malformed item UUID", () => {
    const bad = validPayload({ items: [validItem({ receipt_item_id: "nope" })] });
    expect(() => parseConfirmationPayload(bad)).toThrow(/UUID/u);
  });
});

describe("absent values never become strings", () => {
  test("an absent required key is an error, not the string 'undefined'", () => {
    const bad = validPayload();
    delete (bad as Record<string, unknown>).document_key;
    let message = "";
    try {
      parseConfirmationPayload(bad);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/document_key/u);
    expect(message).not.toMatch(/"undefined"/u);
  });

  test("an absent nullable key is distinguished from an explicit null", () => {
    const bad = validPayload();
    delete (bad as Record<string, unknown>).supplier_key;
    expect(() => parseConfirmationPayload(bad)).toThrow(/required key is absent/u);
    // Explicit null is fine.
    expect(parseConfirmationPayload(validPayload({ supplier_key: null })).supplier_key).toBeNull();
  });

  test("a null where a value is required is rejected", () => {
    expect(() => parseConfirmationPayload(validPayload({ document_key: null }))).toThrow(
      /expected a string/u,
    );
  });
});

describe("numeric grammar", () => {
  test("rejects a JS number where a lossless string is required", () => {
    const bad = validPayload({ items: [validItem({ line_amount_satang: 3086 })] });
    expect(() => parseConfirmationPayload(bad)).toThrow(/expected a string or null, got number/u);
  });

  test("rejects exponent notation in a decimal string", () => {
    const bad = validPayload({ items: [validItem({ quantity: "2.5e3" })] });
    expect(() => parseConfirmationPayload(bad)).toThrow(/decimal string/u);
  });

  test("rejects NaN and empty numeric strings", () => {
    expect(() => parseConfirmationPayload(validPayload({ items: [validItem({ quantity: "NaN" })] })))
      .toThrow(/decimal string/u);
    expect(() => parseConfirmationPayload(validPayload({ items: [validItem({ quantity: "" })] })))
      .toThrow(PurchaseContractViolationError);
  });

  test("accepts a value far beyond Number.MAX_SAFE_INTEGER without loss", () => {
    const huge = "123456789012345678901234567";
    const parsed = parseConfirmationPayload(
      validPayload({
        items: [validItem({ line_amount_satang: huge })],
        totals: {
          line_subtotal_satang: huge,
          freight_satang: "0",
          handling_satang: "0",
          discount_satang: "0",
          vat_satang: null,
          payable_total_satang: huge,
          declared_total_satang: null,
          reconciliation_status: "COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE",
        },
      }),
    );
    expect(parsed.items[0]!.line_amount_satang).toBe(huge);
    expect(parsed.totals.payable_total_satang).toBe(huge);
  });
});

describe("missing unit cost is never zero", () => {
  test("rejects a stated amount on a line with no rate", () => {
    const bad = validPayload({
      items: [validItem({ unit_cost: null, line_amount_satang: "0" })],
    });
    expect(() => parseConfirmationPayload(bad)).toThrow(/null together/u);
  });

  test("rejects a null amount on a line that has a rate", () => {
    const bad = validPayload({
      items: [validItem({ unit_cost: "1", line_amount_satang: null })],
    });
    expect(() => parseConfirmationPayload(bad)).toThrow(/null together/u);
  });

  test("rejects a computed subtotal while a rate is missing", () => {
    const bad = validPayload({
      items: [validItem({ unit_cost: null, line_amount_satang: null })],
      totals: {
        line_subtotal_satang: "0",
        freight_satang: "0",
        handling_satang: "0",
        discount_satang: "0",
        vat_satang: null,
        payable_total_satang: "0",
        declared_total_satang: null,
        reconciliation_status: "NOT_COMPUTABLE_MISSING_UNIT_COST",
      },
      blockers: [
        {
          code: "MISSING_UNIT_COST",
          severity: "BLOCKING",
          item_count: 1,
          item_ordinals: [1],
          detail: "no rate",
        },
      ],
      has_blocking_blockers: true,
    });
    expect(() => parseConfirmationPayload(bad)).toThrow(/null subtotal and payable/u);
  });
});

describe("structural invariants", () => {
  test("rejects item_count disagreeing with the item list", () => {
    expect(() => parseConfirmationPayload(validPayload({ item_count: 2 }))).toThrow(/disagrees/u);
  });

  test("rejects a non-dense ordinal sequence", () => {
    const bad = validPayload({
      item_count: 2,
      items: [validItem({ item_ordinal: 1 }), validItem({ item_ordinal: 3 })],
    });
    expect(() => parseConfirmationPayload(bad)).toThrow(/dense 1\.\.n/u);
  });

  test("rejects has_blocking_blockers disagreeing with the blocker list", () => {
    const bad = validPayload({
      blockers: [
        {
          code: "MISSING_UNIT_COST",
          severity: "BLOCKING",
          item_count: 1,
          item_ordinals: [1],
          detail: "x",
        },
      ],
      has_blocking_blockers: false,
    });
    expect(() => parseConfirmationPayload(bad)).toThrow(/disagrees with the blocker list/u);
  });

  test("rejects an unknown blocker code", () => {
    const bad = validPayload({
      blockers: [
        { code: "SOMETHING_NEW", severity: "BLOCKING", item_count: 0, item_ordinals: [], detail: "x" },
      ],
      has_blocking_blockers: true,
    });
    expect(() => parseConfirmationPayload(bad)).toThrow(/expected one of/u);
  });

  test("rejects a payload claiming P2B posted movement or valuation", () => {
    expect(() => parseConfirmationPayload(validPayload({ posts_inventory_movement: true })))
      .toThrow(/posts_inventory_movement/u);
    expect(() => parseConfirmationPayload(validPayload({ posts_valuation: true })))
      .toThrow(/posts_valuation/u);
  });

  test("rejects a declared total in contract v1", () => {
    const bad = validPayload({
      totals: {
        line_subtotal_satang: "3086",
        freight_satang: "0",
        handling_satang: "0",
        discount_satang: "0",
        vat_satang: null,
        payable_total_satang: "3086",
        declared_total_satang: "9999",
        reconciliation_status: "COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE",
      },
    });
    expect(() => parseConfirmationPayload(bad)).toThrow(/expected null in contract v1/u);
  });

  test("rejects price unit text disagreeing with its status", () => {
    const bad = validPayload({
      items: [validItem({ price_unit_text: "ลัง", price_unit_status: "NOT_APPLICABLE" })],
    });
    expect(() => parseConfirmationPayload(bad)).toThrow(/disagree/u);
  });
});

describe("cross-field consistency", () => {
  test("rejects a payload receipt_id that disagrees with the envelope", () => {
    const bad = validResponse();
    bad.confirmation.payload.receipt_id = "33333333-3333-4333-8333-333333333333";
    expect(() => parseConfirmationResponse(bad)).toThrow(/disagrees with the response receipt_id/u);
  });

  test("rejects void metadata that disagrees with lifecycle status", () => {
    const bad = validResponse({
      lifecycle: { status: "void", posting_locked_at: null, posting_locked_by: null },
      void: null,
    });
    expect(() => parseConfirmationResponse(bad)).toThrow(/disagrees with lifecycle status/u);
  });

  test("rejects a dedupe key that does not match the documented identity", () => {
    expect(() => parseConfirmationResponse(validResponse({ p2c_dedupe_key: "whatever" })))
      .toThrow(/dedupe identity/u);
  });

  test("rejects a missing replayed flag", () => {
    const bad = validResponse();
    delete (bad as Record<string, unknown>).replayed;
    expect(() => parseConfirmationResponse(bad)).toThrow(/replayed/u);
  });
});
