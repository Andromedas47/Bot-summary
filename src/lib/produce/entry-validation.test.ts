import { describe, it, expect } from "bun:test";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  validateProduceEntry,
  computeValidationDigest,
  type ProduceValidationException,
  type RoundMasterRow,
} from "./entry-validation";
import {
  buildBlockingValidationReply,
  buildReviewValidationReply,
} from "./entry-validation-message";

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// Every case below is a real Production failure pattern (P4A §18), anonymized
// only where the market/seller name is irrelevant to the behaviour.

function item(overrides: Partial<WeighSessionItem> & { product_name: string }): WeighSessionItem {
  return {
    item_number: 1,
    price_per_unit: 100,
    quantity: 1,
    unit: "โล",
    section: "main",
    transaction_type: "เบิก",
    pricing_mode: "unit",
    basis_quantity: null,
    basis_unit: null,
    basis_price: null,
    ...overrides,
  };
}

function session(items: WeighSessionItem[]): WeighSession {
  return {
    date: "2026-08-09",
    staff_name: "ดำ",
    sender_name: null,
    transaction_time: "18:00",
    session_title: "ราชพฤกษ์",
    session_kind: "main",
    declared_transaction_type: null,
    items: items.map((entry, index) => ({ ...entry, item_number: index + 1 })),
    parse_errors: [],
  };
}

function master(rows: Array<Partial<RoundMasterRow> & { product_name: string }>): RoundMasterRow[] {
  return rows.map((row) => ({
    unit: "โล",
    quantity: 1,
    price_per_unit: 100,
    transaction_type: "เบิก",
    ...row,
  }));
}

function bound(parsed: WeighSession, roundRows: RoundMasterRow[] = []) {
  return validateProduceEntry({ parsed, roundRows, roundBound: true });
}

function kinds(exceptions: ProduceValidationException[]): string[] {
  return exceptions.map((exception) => exception.kind);
}

// ── CASE A — unknown unit ─────────────────────────────────────────────────────

describe("unknown unit", () => {
  it("blocks a good return booked in โลก against a โล withdrawal", () => {
    const result = bound(
      session([
        item({ product_name: "มังคุด", quantity: 15.4, unit: "โลก", price_per_unit: 45, transaction_type: "คืน" }),
      ]),
      master([{ product_name: "มังคุด", quantity: 15.9, price_per_unit: 45 }]),
    );

    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toEqual(["unknown_unit"]);
    const [exception] = result.blocking;
    expect(exception.kind === "unknown_unit" && exception.suggestion).toBe("โล");
  });

  it("blocks the same unit typed on a withdrawal line too", () => {
    const result = bound(session([item({ product_name: "มังคุด", unit: "โลก" })]));
    expect(kinds(result.blocking)).toEqual(["unknown_unit"]);
  });

  it("blocks even when the session carries no round binding at all", () => {
    const result = validateProduceEntry({
      parsed: session([item({ product_name: "มังคุด", unit: "โลก" })]),
      roundRows: [],
      roundBound: false,
    });
    expect(result.status).toBe("blocked");
  });

  it("reaches the gate from real operator text", () => {
    const parsed = parseWeighSession(
      ["18:53 ดำ-ราชพฤกษ์ ชั่งคืน", "18:53 ดำ 1.มังคุด45บาท", "", "15.4โลก"].join("\n"),
      "2026-08-09",
    );
    const returned = parsed.items.find((entry) => entry.product_name.includes("มังคุด"));
    expect(returned?.unit).toBe("โลก");
    expect(bound(parsed, master([{ product_name: "มังคุด", quantity: 15.9, price_per_unit: 45 }])).status)
      .toBe("blocked");
  });

  it("never invents a unit for something genuinely unrecognizable", () => {
    const result = bound(session([item({ product_name: "มังคุด", unit: "xyzzy" })]));
    const [exception] = result.blocking;
    expect(exception.kind === "unknown_unit" && exception.suggestion).toBeNull();
  });
});

// ── CASES B/C — product typo ──────────────────────────────────────────────────

describe("product identity", () => {
  const pomegranate = master([
    { product_name: "ทับทิม", unit: "ลูก", quantity: 15, price_per_unit: 15 },
  ]);

  it("blocks ทับทิบ and suggests ทับทิม instead of merging them", () => {
    const result = bound(
      session([
        item({ product_name: "ทับทิบ", unit: "ลูก", quantity: 9, price_per_unit: 15, transaction_type: "คืน" }),
      ]),
      pomegranate,
    );

    expect(result.status).toBe("blocked");
    const [exception] = result.blocking;
    expect(exception.kind).toBe("product_not_withdrawn");
    expect(exception.kind === "product_not_withdrawn" && exception.suggestions).toEqual(["ทับทิม"]);
  });

  it("blocks the same typo in a second market's round independently", () => {
    const result = bound(
      session([
        item({ product_name: "ทับทิบ", unit: "ลูก", quantity: 9, price_per_unit: 15, transaction_type: "คืน" }),
        item({ product_name: "ทับทิม", unit: "ลูก", quantity: 1, price_per_unit: 15, transaction_type: "คืนเสีย" }),
      ]),
      master([{ product_name: "ทับทิม", unit: "ลูก", quantity: 23, price_per_unit: 15 }]),
    );
    expect(kinds(result.blocking)).toEqual(["product_not_withdrawn"]);
  });

  it("keeps an approved alias working — หมอน withdrawn, หมอนทอง returned", () => {
    const result = bound(
      session([
        item({ product_name: "หมอนทอง", quantity: 7.5, price_per_unit: 119, transaction_type: "คืน" }),
      ]),
      master([
        { product_name: "หมอน", quantity: 10.6, price_per_unit: 119 },
        { product_name: "หมอน", quantity: 43.9, price_per_unit: 100 },
      ]),
    );
    expect(result.status).toBe("clean");
  });

  it("never auto-merges เขียวมรกต with เขียวมรกตเก่า", () => {
    const result = bound(
      session([
        item({ product_name: "เขียวมรกตเก่า", quantity: 2, price_per_unit: 80, transaction_type: "คืน" }),
      ]),
      master([{ product_name: "เขียวมรกต", quantity: 10, price_per_unit: 80 }]),
    );
    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toEqual(["product_not_withdrawn"]);
  });

  it("blocks a known product returned in a unit it was never withdrawn in", () => {
    const result = bound(
      session([
        item({ product_name: "ทับทิม", unit: "กล่อง", quantity: 2, price_per_unit: 15, transaction_type: "คืน" }),
      ]),
      pomegranate,
    );
    const [exception] = result.blocking;
    expect(exception.kind).toBe("unit_not_withdrawn");
    expect(exception.kind === "unit_not_withdrawn" && exception.withdrawnUnits).toEqual(["ลูก"]);
  });

  it("blocks a return with no withdrawal anywhere in a bound round", () => {
    const result = bound(
      session([item({ product_name: "ลำไย", quantity: 3, transaction_type: "คืน" })]),
      [],
    );
    expect(kinds(result.blocking)).toEqual(["product_not_withdrawn"]);
  });

  it("leaves an unbound legacy session alone rather than guessing its round", () => {
    const result = validateProduceEntry({
      parsed: session([item({ product_name: "ลำไย", quantity: 3, transaction_type: "คืน" })]),
      roundRows: [],
      roundBound: false,
    });
    expect(result.status).toBe("clean");
  });
});

// ── CASE D — several legitimate price buckets ─────────────────────────────────

describe("price buckets", () => {
  const durian = master([
    { product_name: "หมอน", quantity: 10.6, price_per_unit: 119 },
    { product_name: "หมอน", quantity: 4.4, price_per_unit: 100 },
    { product_name: "หมอน", quantity: 43.9, price_per_unit: 100 },
    { product_name: "หมอน", quantity: 25.5, price_per_unit: 100 },
  ]);

  it("accepts both 100 and 119 on the same product without a warning", () => {
    const result = bound(
      session([
        item({ product_name: "หมอนทอง", quantity: 7.5, price_per_unit: 119, transaction_type: "คืน" }),
        item({ product_name: "หมอนทอง", quantity: 27.8, price_per_unit: 100, transaction_type: "คืน" }),
        item({ product_name: "หมอนทอง", quantity: 3.4, price_per_unit: 100, transaction_type: "คืนเสีย" }),
      ]),
      durian,
    );
    expect(result.status).toBe("clean");
  });

  it("asks for review on a price that is in neither bucket", () => {
    const result = bound(
      session([
        item({ product_name: "หมอนทอง", quantity: 8, price_per_unit: 109, transaction_type: "คืน" }),
      ]),
      durian,
    );
    expect(result.status).toBe("review_required");
    const [exception] = result.reviews;
    expect(exception.kind === "price_not_withdrawn" && exception.withdrawnPrices).toEqual([100, 119]);
    expect(exception.kind === "price_not_withdrawn" && exception.enteredPrice).toBe(109);
  });
});

// ── CASE E — a price change is allowed, never coerced ─────────────────────────

describe("price change", () => {
  it("reviews 120 against a withdrawal of 100 and keeps the entered price", () => {
    const parsed = session([
      item({ product_name: "อะโวคาโด", quantity: 4, price_per_unit: 120, transaction_type: "คืน" }),
    ]);
    const result = bound(parsed, master([{ product_name: "อะโวคาโด", quantity: 10, price_per_unit: 100 }]));

    expect(result.status).toBe("review_required");
    expect(result.blocking).toEqual([]);
    // Nothing was rewritten: the item still carries what the operator typed.
    expect(parsed.items[0].price_per_unit).toBe(120);
  });

  it("does not review a return whose product has no withdrawal price at all", () => {
    const result = bound(
      session([item({ product_name: "ส้ม", quantity: 1, price_per_unit: 55, transaction_type: "คืน" })]),
      master([{ product_name: "ส้ม", quantity: 5, price_per_unit: null }]),
    );
    expect(result.status).toBe("clean");
  });
});

// ── CASE J — the inventory invariant ──────────────────────────────────────────

describe("quantity invariant", () => {
  it("blocks when good + damaged returns exceed the withdrawal", () => {
    const result = bound(
      session([
        item({ product_name: "ทุเรียน", quantity: 9, transaction_type: "คืน" }),
        item({ product_name: "ทุเรียน", quantity: 3, transaction_type: "คืนเสีย" }),
      ]),
      master([{ product_name: "ทุเรียน", quantity: 10 }]),
    );

    expect(result.status).toBe("blocked");
    const [exception] = result.blocking;
    expect(exception.kind).toBe("return_exceeds_withdrawal");
    expect(exception.kind === "return_exceeds_withdrawal" && exception.excessQuantity).toBe(2);
  });

  it("aggregates across every price bucket instead of per bucket", () => {
    const result = bound(
      session([item({ product_name: "หมอนทอง", quantity: 14, price_per_unit: 100, transaction_type: "คืน" })]),
      master([
        { product_name: "หมอน", quantity: 10, price_per_unit: 100 },
        { product_name: "หมอน", quantity: 5, price_per_unit: 119 },
      ]),
    );
    expect(result.status).toBe("clean");
  });

  it("counts returns already finalized elsewhere in the round", () => {
    const result = bound(
      session([item({ product_name: "ทุเรียน", quantity: 4, transaction_type: "คืน" })]),
      master([
        { product_name: "ทุเรียน", quantity: 10 },
        { product_name: "ทุเรียน", quantity: 7, transaction_type: "คืน" },
      ]),
    );
    expect(kinds(result.blocking)).toEqual(["return_exceeds_withdrawal"]);
  });

  it("counts an additional withdrawal batch towards the master", () => {
    const result = bound(
      session([item({ product_name: "ทุเรียน", quantity: 14, transaction_type: "คืน" })]),
      master([
        { product_name: "ทุเรียน", quantity: 10 },
        { product_name: "ทุเรียน", quantity: 5, transaction_type: "เบิกเพิ่ม" },
      ]),
    );
    expect(result.status).toBe("clean");
  });

  it("passes a return that exactly matches the withdrawal", () => {
    const result = bound(
      session([item({ product_name: "ทุเรียน", quantity: 10, transaction_type: "คืน" })]),
      master([{ product_name: "ทุเรียน", quantity: 10 }]),
    );
    expect(result.status).toBe("clean");
  });
});

// ── The clean path stays clean ────────────────────────────────────────────────

describe("clean sessions", () => {
  it("raises nothing for a plain withdrawal-only session", () => {
    const result = bound(
      session([
        item({ product_name: "หมอนทอง", quantity: 38, price_per_unit: 119 }),
        item({ product_name: "กระดุม", quantity: 30.3, price_per_unit: 100 }),
      ]),
    );
    expect(result).toMatchObject({ status: "clean", blocking: [], reviews: [] });
  });

  it("validates a single document that carries both its withdrawal and its return", () => {
    const result = bound(
      session([
        item({ product_name: "มังคุด", quantity: 15.9, price_per_unit: 45 }),
        item({ product_name: "มังคุด", quantity: 15.4, price_per_unit: 45, transaction_type: "คืน" }),
      ]),
    );
    expect(result.status).toBe("clean");
  });
});

// ── Digest ────────────────────────────────────────────────────────────────────

describe("validation digest", () => {
  const roundRows = master([{ product_name: "อะโวคาโด", quantity: 10, price_per_unit: 100 }]);
  const priced = (price: number) =>
    session([item({ product_name: "อะโวคาโด", quantity: 4, price_per_unit: price, transaction_type: "คืน" })]);

  it("is stable for identical content", () => {
    expect(bound(priced(120), roundRows).digest).toBe(bound(priced(120), roundRows).digest);
  });

  it("changes when the session content changes", () => {
    expect(bound(priced(120), roundRows).digest).not.toBe(bound(priced(130), roundRows).digest);
  });

  it("changes when an unrelated line is added after the preview", () => {
    const before = bound(priced(120), roundRows);
    const after = bound(
      session([
        item({ product_name: "อะโวคาโด", quantity: 4, price_per_unit: 120, transaction_type: "คืน" }),
        item({ product_name: "อะโวคาโด", quantity: 1, price_per_unit: 100, transaction_type: "คืนเสีย" }),
      ]),
      roundRows,
    );
    expect(after.digest).not.toBe(before.digest);
  });

  it("does not depend on exception ordering", () => {
    const parsed = priced(120);
    const forward = computeValidationDigest(parsed, [], [
      { kind: "price_not_withdrawn", severity: "review_required", itemNumber: 1, productName: "a", unit: "โล", quantity: 1, enteredPrice: 2, withdrawnPrices: [1] },
      { kind: "price_not_withdrawn", severity: "review_required", itemNumber: 2, productName: "b", unit: "โล", quantity: 1, enteredPrice: 2, withdrawnPrices: [1] },
    ]);
    const reversed = computeValidationDigest(parsed, [], [
      { kind: "price_not_withdrawn", severity: "review_required", itemNumber: 2, productName: "b", unit: "โล", quantity: 1, enteredPrice: 2, withdrawnPrices: [1] },
      { kind: "price_not_withdrawn", severity: "review_required", itemNumber: 1, productName: "a", unit: "โล", quantity: 1, enteredPrice: 2, withdrawnPrices: [1] },
    ]);
    expect(forward).toBe(reversed);
  });
});

// ── Operator-facing text ──────────────────────────────────────────────────────

describe("replies", () => {
  it("reports the unit mismatch and its suggestion, and says nothing was saved", () => {
    const result = bound(
      session([item({ product_name: "มังคุด", quantity: 15.4, unit: "โลก", price_per_unit: 45, transaction_type: "คืน" })]),
      master([{ product_name: "มังคุด", quantity: 15.9, price_per_unit: 45 }]),
    );
    const reply = buildBlockingValidationReply(result);
    expect(reply).toContain("มังคุด");
    expect(reply).toContain("โลก");
    expect(reply).toContain("น่าจะเป็น: โล");
    expect(reply).toContain("ระบบยังไม่ได้บันทึกอะไร");
  });

  it("shows both withdrawal prices next to the entered one", () => {
    const result = bound(
      session([item({ product_name: "หมอนทอง", quantity: 8, price_per_unit: 109, transaction_type: "คืน" })]),
      master([
        { product_name: "หมอน", quantity: 10, price_per_unit: 100 },
        { product_name: "หมอน", quantity: 5, price_per_unit: 119 },
      ]),
    );
    const reply = buildReviewValidationReply(result);
    expect(reply).toContain("109");
    expect(reply).toContain("100, 119");
    expect(reply).toContain("ยืนยัน");
  });

  it("summarizes instead of listing when a session is pathological", () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      item({ product_name: `ของ${index}`, unit: "โลก", quantity: 1 }),
    );
    const reply = buildBlockingValidationReply(bound(session(items)));
    expect(reply).toContain("และอีก 15 รายการ");
    expect([...reply].length).toBeLessThan(2000);
  });
});
