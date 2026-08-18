/**
 * Product vocabulary guard — suggestion ranking and the withdrawal-intake gate.
 *
 * Every fixture named "Production" is a finalized withdrawal from the
 * 2026-08-15 read-only audit: nine distinct product names on that day did not
 * match any approved dictionary spelling, and all but three were misspellings
 * of a product that already has a code.
 */
import { describe, expect, it } from "bun:test";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { PRODUCT_CODE_ENTRIES } from "./product-code/dictionary";
import {
  approvedProductCode,
  isApprovedProductName,
  suggestDictionaryProducts,
} from "./product-vocabulary";
import {
  validateProduceEntry,
  type ProduceValidationException,
  type ProduceValidationResult,
} from "./entry-validation";
import { buildReviewValidationReply } from "./entry-validation-message";

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
    date: "2026-08-15",
    staff_name: "แทน",
    sender_name: null,
    transaction_time: "06:00",
    session_title: "ราชพฤก",
    session_kind: "main",
    declared_transaction_type: "เบิก",
    items: items.map((entry, index) => ({ ...entry, item_number: index + 1 })),
    parse_errors: [],
  };
}

function withdraw(...names: string[]): ProduceValidationResult {
  return validateProduceEntry({
    parsed: session(names.map((product_name) => item({ product_name }))),
    roundRows: [],
    roundBound: true,
  });
}

type VocabularyException = Extract<
  ProduceValidationException,
  { kind: "unknown_product_vocabulary" }
>;

function vocabulary(result: ProduceValidationResult): VocabularyException[] {
  return result.reviews.filter(
    (exception): exception is VocabularyException =>
      exception.kind === "unknown_product_vocabulary",
  );
}

/** The canonical names suggested for a single-item withdrawal, in rank order. */
function suggestedNames(name: string): string[] {
  return suggestDictionaryProducts(name).map((candidate) => candidate.canonicalName);
}

// ── The dictionary as reference vocabulary ───────────────────────────────────

describe("approved vocabulary", () => {
  it("recognises every enabled canonical name and reports its code", () => {
    for (const entry of PRODUCT_CODE_ENTRIES) {
      if (!entry.enabled) continue;
      expect(isApprovedProductName(entry.canonicalName)).toBe(true);
      expect(approvedProductCode(entry.canonicalName)).toBe(entry.code);
    }
  });

  it("normalizes whitespace and NFC only — never spelling", () => {
    expect(isApprovedProductName("  มะม่วงเขียวมรกต  ")).toBe(true);
    expect(isApprovedProductName("เครื่องต้มยำ")).toBe(true);
    expect(isApprovedProductName("เครื่อง   ต้มยำ")).toBe(false);
    expect(isApprovedProductName("ปลาหมึก แผ่น")).toBe(false);
    // อะโวคาโด้ has a reviewed REPORTING alias to อะโวคาโด. That does not make
    // it an approved spelling — resolving it here is exactly the silent
    // acceptance this guard exists to stop.
    expect(isApprovedProductName("อะโวคาโด้")).toBe(false);
  });

  it("suggests nothing for a product that is already approved", () => {
    expect(suggestDictionaryProducts("มะม่วงเขียวมรกต")).not.toContainEqual(
      expect.objectContaining({ canonicalName: "มะม่วงเขียวมรกต" }),
    );
  });
});

// ── Production fixtures, 2026-08-15 ──────────────────────────────────────────

describe("Production 2026-08-15 withdrawal spellings", () => {
  it("CASE A — มะม่วงเขียวรกต (แทน / ราชพฤก) reviews and suggests ม31", () => {
    const result = withdraw("มะม่วงเขียวรกต");
    expect(result.status).toBe("review_required");
    const [exception] = vocabulary(result);
    expect(exception).toMatchObject({
      kind: "unknown_product_vocabulary",
      severity: "review_required",
      itemNumber: 1,
      productName: "มะม่วงเขียวรกต",
    });
    expect(exception).toHaveProperty("suggestions");
    expect(suggestDictionaryProducts("มะม่วงเขียวรกต")[0]).toEqual({
      productCode: "ม31",
      canonicalName: "มะม่วงเขียวมรกต",
    });
  });

  it("CASE B — เขียวมรกต (ดำ / วัดตะกล่ำ) suggests the full name without mapping to it", () => {
    expect(suggestedNames("เขียวมรกต")).toContain("มะม่วงเขียวมรกต");
    const result = withdraw("เขียวมรกต");
    expect(result.status).toBe("review_required");
    // Suggestion is not identity: the entered name is untouched everywhere.
    expect(vocabulary(result)[0]).toMatchObject({ productName: "เขียวมรกต" });
  });

  it("CASE C — สับปรด suggests สับปะรด", () => {
    expect(suggestedNames("สับปรด")[0]).toBe("สับปะรด");
  });

  it("CASE D — ไชมัส suggests ไซมัส (reviewed alias, tier 0, after 20260818100000)", () => {
    // ไซมัส is ม54's corrected canonical spelling as of 20260818100000, so the
    // direction inverts: the legacy misspelling ไชมัส is the unapproved input,
    // and it carries a reviewed PRODUCT_ALIASES entry to ไซมัส — the strongest
    // evidence tier suggestDictionaryProducts has.
    expect(suggestedNames("ไชมัส")[0]).toBe("ไซมัส");
  });

  it("CASE E — อินทผรัม suggests อินทผลัม", () => {
    expect(suggestedNames("อินทผรัม")[0]).toBe("อินทผลัม");
  });

  it("CASE F — อินมผรัม, two characters out, still reaches อินทผลัม", () => {
    expect(suggestedNames("อินมผรัม")).toContain("อินทผลัม");
  });

  it("CASE G — the approved spelling มะม่วงเขียวมรกต is clean", () => {
    expect(withdraw("มะม่วงเขียวมรกต").status).toBe("clean");
  });

  it("CASE H — the code ม31 resolves to the canonical name and is clean", () => {
    const parsed = parseWeighSession(
      ["แทน-ราชพฤก เบิก 15/8/2569", "ม31 30 บาท", "8 โล", "จบรายการเบิก"].join("\n"),
    );
    expect(parsed.items[0].product_name).toBe("มะม่วงเขียวมรกต");
    expect(
      validateProduceEntry({ parsed, roundRows: [], roundBound: true }).status,
    ).toBe("clean");
  });

  it("CASE I — a genuinely new product reviews with no forced suggestion", () => {
    const result = withdraw("สินค้าใหม่ABC");
    expect(result.status).toBe("review_required");
    expect(vocabulary(result)[0]).toMatchObject({
      productName: "สินค้าใหม่ABC",
      suggestions: [],
    });
  });

  it("CASE I — the same, through the real parser, on a name the parser accepts", () => {
    // A Latin-bearing product name never reaches validation: the parser already
    // refuses "สินค้าXYZ 50 บาท" as an unrecognized line, which is its own
    // fail-closed path and is unchanged here.
    const parsed = parseWeighSession(
      [
        "แทน-ราชพฤก เบิก 15/8/2569",
        "ฝรั่งสายพันธุ์ใหม่ 60 บาท",
        "5 โล",
        "จบรายการเบิก",
      ].join("\n"),
    );
    expect(parsed.parse_errors).toEqual([]);
    const result = validateProduceEntry({ parsed, roundRows: [], roundBound: true });
    expect(result.status).toBe("review_required");
    expect(vocabulary(result)[0]).toMatchObject({
      productName: "ฝรั่งสายพันธุ์ใหม่",
      suggestions: [],
    });
  });

  it("CASE J — ปลาอินทรีย์ may suggest ปลาอินทรี but is never mapped to it", () => {
    expect(suggestedNames("ปลาอินทรีย์")).toContain("ปลาอินทรี");
    expect(isApprovedProductName("ปลาอินทรีย์")).toBe(false);
    expect(vocabulary(withdraw("ปลาอินทรีย์"))[0]).toMatchObject({
      productName: "ปลาอินทรีย์",
    });
  });

  it("CASE K — หมึกกระตอย reaches ปลาหมึกกะตอย through the shared run, not a merge", () => {
    expect(suggestedNames("หมึกกระตอย")).toContain("ปลาหมึกกะตอย");
    expect(vocabulary(withdraw("หมึกกระตอย"))[0]).toMatchObject({
      productName: "หมึกกระตอย",
    });
  });

  it("อะโวคาโด้ — the reviewed alias is shown as the canonical spelling, not applied", () => {
    expect(suggestDictionaryProducts("อะโวคาโด้")[0]).toEqual({
      productCode: "ม59",
      canonicalName: "อะโวคาโด",
    });
    expect(vocabulary(withdraw("อะโวคาโด้"))[0]).toMatchObject({
      productName: "อะโวคาโด้",
    });
  });
});

// ── Suggestion safety ────────────────────────────────────────────────────────

describe("suggestions are never identity", () => {
  it("returns at most three candidates", () => {
    for (const name of ["ปลาทู", "หมอนทองx", "กะหล่ำปี", "เขียวมรกต"]) {
      expect(suggestDictionaryProducts(name).length).toBeLessThanOrEqual(3);
    }
  });

  it("is deterministic across repeated calls", () => {
    const once = suggestDictionaryProducts("อินมผรัม");
    expect(suggestDictionaryProducts("อินมผรัม")).toEqual(once);
  });

  it("does not force a candidate onto an unrelated name", () => {
    expect(suggestDictionaryProducts("ฝรั่งสายพันธุ์ใหม่ของสวนลุงมี")).toEqual([]);
  });

  it("never rewrites the entered product name", () => {
    const parsed = session([item({ product_name: "อินทผรัม" })]);
    validateProduceEntry({ parsed, roundRows: [], roundBound: true });
    expect(parsed.items[0].product_name).toBe("อินทผรัม");
  });

  it("does not mutate the dictionary", () => {
    const before = PRODUCT_CODE_ENTRIES.length;
    withdraw("สินค้าใหม่ABC", "อินทผรัม", "เขียวมรกต");
    expect(PRODUCT_CODE_ENTRIES).toHaveLength(before);
    expect(isApprovedProductName("สินค้าใหม่ABC")).toBe(false);
  });
});

// ── Scope ────────────────────────────────────────────────────────────────────

describe("guard scope", () => {
  it("applies to เบิกเพิ่ม, the additional withdrawal batch", () => {
    const parsed = session([
      item({ product_name: "อินทผรัม", transaction_type: "เบิกเพิ่ม" }),
    ]);
    const result = validateProduceEntry({ parsed, roundRows: [], roundBound: true });
    expect(vocabulary(result)).toHaveLength(1);
  });

  it("does not apply to คืน or คืนเสีย — a return is judged against the master", () => {
    const parsed = session([
      item({ product_name: "อินทผลัม", transaction_type: "เบิก", quantity: 5 }),
      item({ product_name: "อินทผรัม", transaction_type: "คืน", quantity: 1 }),
    ]);
    const result = validateProduceEntry({ parsed, roundRows: [], roundBound: true });
    expect(vocabulary(result)).toHaveLength(0);
    // The return is unmatched for its own, separate reason.
    expect(result.blocking.map((exception) => exception.kind)).toEqual([
      "product_not_withdrawn",
    ]);
  });

  it("keeps unknown_product_vocabulary and product_not_withdrawn separate", () => {
    const parsed = session([
      item({ product_name: "อินทผรัม", transaction_type: "เบิก", quantity: 5 }),
      item({ product_name: "องุ่นดำ", transaction_type: "คืน", quantity: 1 }),
    ]);
    const result = validateProduceEntry({ parsed, roundRows: [], roundBound: true });
    expect(vocabulary(result)).toHaveLength(1);
    expect(result.blocking.map((exception) => exception.kind)).toEqual([
      "product_not_withdrawn",
    ]);
    // Blocking wins: an unresolvable return is not downgraded by a review.
    expect(result.status).toBe("blocked");
  });

  it("reports one exception per distinct spelling, at its first item number", () => {
    const result = withdraw("อินทผรัม", "มะม่วงเขียวมรกต", "อินทผรัม", "สับปรด");
    const exceptions = vocabulary(result);
    expect(exceptions.map((exception) => exception.itemNumber)).toEqual([1, 4]);
  });

  it("lists every suspicious name in one reply, ordered by item number", () => {
    // ไซมัส is ม54's approved spelling as of 20260818100000 and no longer
    // exercises the review path (CASE D above). "ฝรั่งสายพันธุ์ใหม่ของสวนลุงมี"
    // replaces it — a name proven genuinely absent from the dictionary with no
    // near match (see "does not force a candidate onto an unrelated name").
    const result = withdraw(
      "มะม่วงเขียวรกต", "มะม่วงเขียวมรกต", "ฝรั่งสายพันธุ์ใหม่ของสวนลุงมี", "สินค้าXYZ",
    );
    expect(vocabulary(result)).toHaveLength(3);
    const reply = buildReviewValidationReply(result);
    expect(reply).toContain("⚠️ พบ 3 ชื่อสินค้าที่ไม่ตรงกับรายการมาตรฐาน");
    expect(reply.indexOf("มะม่วงเขียวรกต")).toBeLessThan(
      reply.indexOf("ฝรั่งสายพันธุ์ใหม่ของสวนลุงมี"),
    );
    expect(reply).toContain("ม31 — มะม่วงเขียวมรกต");
    expect(reply).toContain("ไม่พบชื่อใกล้เคียงในรายการมาตรฐาน");
    expect(reply).toContain("หากเป็นสินค้าใหม่จริง");
  });
});

// ── Confirmation binding ─────────────────────────────────────────────────────

// ── 20260818100000 dictionary cleanup ───────────────────────────────────────

describe("20260818100000 dictionary cleanup — ม54 correction and ม63–ม68", () => {
  it("accepts every new exact canonical name — ไซมัส plus the six new ม products", () => {
    for (const name of [
      "ไซมัส",
      "มะม่วงจิ้ว",
      "ลูกพีชเล็ก",
      "ลูกพีชใหญ่",
      "ลูกไหนเขียว",
      "ลูกไหนดำ",
      "องุ่นคิมสัน",
    ]) {
      expect(isApprovedProductName(name)).toBe(true);
    }
  });

  it("still fails closed for a genuinely unknown product — review_required, not blocking", () => {
    const invented = "ผลไม้ที่ไม่มีจริงเลย";
    expect(isApprovedProductName(invented)).toBe(false);
    const result = withdraw(invented);
    expect(result.status).toBe("review_required");
    expect(vocabulary(result)[0]).toMatchObject({
      kind: "unknown_product_vocabulary",
      severity: "review_required",
      productName: invented,
    });
  });

  it("the legacy alias spelling ไชมัส is NOT itself an approved dictionary spelling", () => {
    // PRODUCT_ALIASES rewrites ไชมัส → ไซมัส for REPORTING identity only; the
    // Vocabulary Guard does not consult PRODUCT_ALIASES, so the raw legacy
    // spelling is still unapproved — same shape as อะโวคาโด้ above.
    expect(isApprovedProductName("ไชมัส")).toBe(false);
  });
});

describe("dictionary cleanup extension — ม69–ม71 and the เขียวมรกต alias", () => {
  it("accepts every new exact canonical name — ส้มแมนดาริน, องุ่นเคียวโฮ, ลิ้นจี่", () => {
    for (const name of ["ส้มแมนดาริน", "องุ่นเคียวโฮ", "ลิ้นจี่"]) {
      expect(isApprovedProductName(name)).toBe(true);
    }
  });

  it("เขียวมรกต is NOT itself an approved dictionary spelling", () => {
    // PRODUCT_ALIASES rewrites เขียวมรกต → มะม่วงเขียวมรกต for REPORTING identity
    // only; the Vocabulary Guard does not consult PRODUCT_ALIASES, so an alias
    // source spelling is never itself an approved dictionary spelling — same
    // shape as อะโวคาโด้ and ไชมัส above. This asserts the true current
    // behavior of isApprovedProductName, not a desired change.
    expect(isApprovedProductName("เขียวมรกต")).toBe(false);
  });
});

describe("review digest", () => {
  it("changes when a suspicious spelling is corrected", () => {
    const before = withdraw("มะม่วงเขียวรกต").digest;
    const after = withdraw("มะม่วงเขียวมรกต").digest;
    expect(after).not.toBe(before);
  });

  it("changes when an unrelated item is added after the review was shown", () => {
    const before = withdraw("สินค้าใหม่ABC").digest;
    const after = withdraw("สินค้าใหม่ABC", "องุ่นดำ").digest;
    expect(after).not.toBe(before);
  });

  it("is stable for the same document", () => {
    expect(withdraw("สินค้าใหม่ABC").digest).toBe(withdraw("สินค้าใหม่ABC").digest);
  });
});
