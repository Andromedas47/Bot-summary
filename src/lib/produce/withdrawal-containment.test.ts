/**
 * The application half of the containment guard (P0-B).
 *
 * The database decides containment; this module decides what is even eligible
 * to be compared. Getting that scope wrong is the expensive failure mode —
 * including `เบิกเพิ่ม` would refuse legitimate second batches, and excluding a
 * plain withdrawal would let the โด้ incident through again.
 */
import { describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  canonicalItemMultisetContains,
  canonicalWithdrawalItemLines,
} from "@/lib/produce/business-fingerprint";

const ISO_DATE = "2026-08-16";
const DATE = "16/8/2569";

const DURIAN = ["1.หมอนทอง100บาท", "3.9โล", "2.หมอนทอง100บาท", "23.2โล"];
const DRY_GOODS = ["3.กระชาย20บาท", "6แพค"];

function doc(head: string, rows: string[] = DURIAN) {
  return parseWeighSession(
    [`โด้-ตลาด72 ${head} ${DATE}`, ...rows, `จบรายการ${head}`].join("\n"),
    ISO_DATE,
  );
}

describe("containment scope", () => {
  it("a plain เบิก document is comparable", () => {
    // Each item is a product line plus its quantity line, so DURIAN is 2 items.
    expect(canonicalWithdrawalItemLines(doc("เบิก"))).toHaveLength(2);
  });

  it("เบิกเพิ่ม is NOT comparable — an append is intentional", () => {
    const append = doc("เบิกเพิ่ม");
    expect(append.session_kind).toBe("additional");
    expect(canonicalWithdrawalItemLines(append)).toBeNull();
  });

  it("a return is not a withdrawal", () => {
    expect(canonicalWithdrawalItemLines(doc("ชั่งคืน"))).toBeNull();
  });

  it("a damaged return is not a withdrawal", () => {
    expect(canonicalWithdrawalItemLines(doc("คืนเสีย"))).toBeNull();
  });

  it("a document with no items is not comparable", () => {
    const empty = parseWeighSession(`โด้-ตลาด72 เบิก ${DATE}`, ISO_DATE);
    expect(canonicalWithdrawalItemLines(empty)).toBeNull();
  });

  it("the multiset is order-insensitive", () => {
    const forward = canonicalWithdrawalItemLines(doc("เบิก", [...DURIAN, ...DRY_GOODS]))!;
    const reordered = canonicalWithdrawalItemLines(
      doc("เบิก", [...DRY_GOODS, ...DURIAN]),
    )!;
    expect([...forward].sort()).toEqual([...reordered].sort());
  });

  it("the multiset keeps duplicate rows", () => {
    // Two separately numbered items with identical business content. Item
    // numbers are audit metadata and never enter the canonical line, so both
    // must survive as the SAME string rather than collapsing to one.
    const twice = canonicalWithdrawalItemLines(
      doc("เบิก", ["3.กระชาย20บาท", "6แพค", "4.กระชาย20บาท", "6แพค"]),
    )!;
    expect(twice).toHaveLength(2);
    expect(twice[0]).toBe(twice[1]);
  });
});

describe("multiset containment mirrors the SQL helper", () => {
  it("ignores order", () => {
    expect(canonicalItemMultisetContains(["b", "a", "c"], ["c", "a"])).toBe(true);
  });

  it("respects multiplicity", () => {
    expect(canonicalItemMultisetContains(["a", "b"], ["a", "a"])).toBe(false);
    expect(canonicalItemMultisetContains(["a", "a", "b"], ["a", "a"])).toBe(true);
  });

  it("refuses a line that is simply absent", () => {
    expect(canonicalItemMultisetContains(["a"], ["b"])).toBe(false);
  });

  it("holds for the โด้ incident", () => {
    const first = canonicalWithdrawalItemLines(doc("เบิก", DURIAN))!;
    const resend = canonicalWithdrawalItemLines(doc("เบิก", [...DURIAN, ...DRY_GOODS]))!;
    expect(canonicalItemMultisetContains(resend, first)).toBe(true);
    expect(canonicalItemMultisetContains(first, resend)).toBe(false);
  });

  it("one differing quantity is not containment", () => {
    const first = canonicalWithdrawalItemLines(doc("เบิก", DURIAN))!;
    const changed = canonicalWithdrawalItemLines(
      doc("เบิก", ["1.หมอนทอง100บาท", "3.9โล", "2.หมอนทอง100บาท", "23.3โล", ...DRY_GOODS]),
    )!;
    expect(canonicalItemMultisetContains(changed, first)).toBe(false);
  });

  it("one differing price is not containment", () => {
    const first = canonicalWithdrawalItemLines(doc("เบิก", DURIAN))!;
    const changed = canonicalWithdrawalItemLines(
      doc("เบิก", ["1.หมอนทอง100บาท", "3.9โล", "2.หมอนทอง105บาท", "23.2โล", ...DRY_GOODS]),
    )!;
    expect(canonicalItemMultisetContains(changed, first)).toBe(false);
  });
});
