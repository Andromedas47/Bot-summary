/**
 * P4A with Product Codes — the point of the whole feature.
 *
 * A code resolves to a canonical product name in the parser, so by the time
 * the entry gate sees an item there is no such thing as "a coded row". These
 * tests prove that in the direction that matters: a withdrawal keyed one way
 * and a return keyed the other must land on the same master cell, and every
 * existing refusal — price, unit, quantity invariant — must still fire when it
 * does.
 *
 * Each case drives real documents through the real parser rather than
 * hand-built item fixtures, because the resolution being tested happens inside
 * the parse.
 */
import { describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import {
  masterRowsFromSession,
  validateProduceEntry,
  type ProduceValidationException,
  type RoundMasterRow,
} from "./entry-validation";

const SELLER_MARKET = "กี้-วัดทุ่งลานนา";
const DATE = "13/8/2569";

function withdrawal(...lines: string[]): WeighSession {
  return parseWeighSession(
    [`${SELLER_MARKET} เบิก ${DATE}`, ...lines, "จบรายการเบิก"].join("\n"),
  );
}

function goodReturn(...lines: string[]): WeighSession {
  return parseWeighSession(
    [`${SELLER_MARKET} ชั่งคืน ${DATE}`, ...lines, "จบรายการชั่งคืน"].join("\n"),
  );
}

function damagedReturn(...lines: string[]): WeighSession {
  return parseWeighSession(
    [`${SELLER_MARKET} คืนเสีย ${DATE}`, ...lines, "จบรายการคืนเสีย"].join("\n"),
  );
}

/** The round's finalized withdrawal master, as P4A would have loaded it. */
function roundOf(...sessions: WeighSession[]): RoundMasterRow[] {
  return sessions.flatMap(masterRowsFromSession);
}

function validate(parsed: WeighSession, roundRows: RoundMasterRow[]) {
  expect(parsed.parse_errors).toEqual([]);
  return validateProduceEntry({ parsed, roundRows, roundBound: true });
}

const kinds = (exceptions: ProduceValidationException[]) => exceptions.map((e) => e.kind);

// ── CASE B — code out, word back ────────────────────────────────────────────

describe("CASE B — withdrawn by code, returned by word", () => {
  it("matches ม02 against กล้วยน้ำว้า", () => {
    const round = roundOf(withdrawal("ม02 35 บาท", "8 โล"));
    const result = validate(goodReturn("กล้วยน้ำว้า 35 บาท", "3 โล"), round);

    expect(result.status).toBe("clean");
    expect(result.blocking).toEqual([]);
  });
});

// ── CASE C — word out, code back ────────────────────────────────────────────

describe("CASE C — withdrawn by word, returned by code", () => {
  it("matches กล้วยน้ำว้า against ม02", () => {
    const round = roundOf(withdrawal("กล้วยน้ำว้า 35 บาท", "8 โล"));
    const result = validate(goodReturn("ม02 35 บาท", "3 โล"), round);

    expect(result.status).toBe("clean");
    expect(result.blocking).toEqual([]);
  });
});

// ── CASE D — code both ways ─────────────────────────────────────────────────

describe("CASE D — withdrawn and returned by the same code", () => {
  it("matches ม02 against ม02", () => {
    const round = roundOf(withdrawal("ม02 35 บาท", "8 โล"));
    const result = validate(goodReturn("ม02 35 บาท", "3 โล"), round);

    expect(result.status).toBe("clean");
  });

  it("still refuses a product that was never withdrawn in this round", () => {
    // The dictionary is not an allowlist, but the round still is: ม01 is a
    // perfectly valid code for a product this round never took out.
    const round = roundOf(withdrawal("ม02 35 บาท", "8 โล"));
    const result = validate(goodReturn("ม01 50 บาท", "1 โล"), round);

    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toContain("product_not_withdrawn");
    // And it names the product, not the code the operator typed.
    expect(result.blocking[0]).toMatchObject({ productName: "กล้วยไข่" });
  });
});

// ── CASE E — price drift remains visible but non-blocking ───────────────────

describe("CASE E — price mismatch through a code", () => {
  it("accepts a changed price with an advisory", () => {
    const round = roundOf(withdrawal("ม01 50 บาท", "2 โล"));
    const result = validate(goodReturn("ม01 60 บาท", "1 โล"), round);

    expect(result.status).toBe("clean");
    expect(kinds(result.advisories)).toContain("price_not_withdrawn");
    expect(result.advisories[0]).toMatchObject({
      productName: "กล้วยไข่", enteredPrice: 60, withdrawnPrices: [50],
    });
  });

  it("advises on a price change across the code/word boundary too", () => {
    const round = roundOf(withdrawal("กล้วยไข่ 50 บาท", "2 โล"));
    const result = validate(goodReturn("ม01 60 บาท", "1 โล"), round);

    expect(result.status).toBe("clean");
    expect(kinds(result.advisories)).toContain("price_not_withdrawn");
  });
});

// ── CASE F — unit mismatch stays fail-closed ────────────────────────────────

describe("CASE F — unit mismatch through a code", () => {
  it("blocks a return booked in a unit the product was never withdrawn in", () => {
    const round = roundOf(withdrawal("ม01 50 บาท", "2 โล"));
    const result = validate(goodReturn("ม01 50 บาท", "2 กล่อง"), round);

    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toContain("unit_not_withdrawn");
    expect(result.blocking[0]).toMatchObject({
      productName: "กล้วยไข่", unit: "กล่อง", withdrawnUnits: ["โล"],
    });
  });

  it("blocks a unit that is not shop vocabulary at all", () => {
    const round = roundOf(withdrawal("ม01 50 บาท", "2 โล"));
    const result = validate(goodReturn("ม01 50 บาท", "2 โลก"), round);

    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toContain("unknown_unit");
  });
});

// ── CASE G — return may not exceed withdrawal ───────────────────────────────

describe("CASE G — return exceeds withdrawal", () => {
  it("blocks returning 3 โล against a 2 โล withdrawal", () => {
    const round = roundOf(withdrawal("ม01 50 บาท", "2 โล"));
    const result = validate(goodReturn("ม01 50 บาท", "3 โล"), round);

    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toContain("return_exceeds_withdrawal");
    expect(result.blocking.find((e) => e.kind === "return_exceeds_withdrawal")).toMatchObject({
      productName: "กล้วยไข่", withdrawnQuantity: 2, goodReturnQuantity: 3, excessQuantity: 1,
    });
  });

  it("blocks it across the code/word boundary", () => {
    const round = roundOf(withdrawal("กล้วยไข่ 50 บาท", "2 โล"));
    const result = validate(goodReturn("ม01 50 บาท", "3 โล"), round);

    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toContain("return_exceeds_withdrawal");
  });
});

// ── CASE H — good + damaged may not exceed withdrawal ───────────────────────

describe("CASE H — good return plus damaged exceeds withdrawal", () => {
  it("blocks 4 โล good + 2 โล damaged against a 5 โล withdrawal", () => {
    const round = roundOf(
      withdrawal("ม01 50 บาท", "5 โล"),
      goodReturn("ม01 50 บาท", "4 โล"),
    );
    const result = validate(damagedReturn("ม01 50 บาท", "2 โล"), round);

    expect(result.status).toBe("blocked");
    const excess = result.blocking.find((e) => e.kind === "return_exceeds_withdrawal");
    expect(excess).toMatchObject({
      productName: "กล้วยไข่",
      withdrawnQuantity: 5,
      goodReturnQuantity: 4,
      damagedQuantity: 2,
      excessQuantity: 1,
    });
  });

  it("allows the same shape when it fits inside the withdrawal", () => {
    const round = roundOf(
      withdrawal("ม01 50 บาท", "5 โล"),
      goodReturn("ม01 50 บาท", "3 โล"),
    );
    const result = validate(damagedReturn("ม01 50 บาท", "2 โล"), round);

    expect(result.status).toBe("clean");
  });

  it("blocks a mixed-notation round the same way", () => {
    // Withdrawal by code, good return by word, damaged return by code.
    const round = roundOf(
      withdrawal("ม01 50 บาท", "5 โล"),
      goodReturn("กล้วยไข่ 50 บาท", "4 โล"),
    );
    const result = validate(damagedReturn("ม01 50 บาท", "2 โล"), round);

    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toContain("return_exceeds_withdrawal");
  });
});

// ── The dictionary is not an allowlist, at gate level too ───────────────────

describe("uncoded products go through the gate unchanged", () => {
  it("validates a brand-new uncoded product normally", () => {
    const round = roundOf(withdrawal("เสาวรส 50 บาท", "10 โล"));

    expect(validate(goodReturn("เสาวรส 50 บาท", "4 โล"), round).status).toBe("clean");
    expect(validate(goodReturn("เสาวรส 50 บาท", "11 โล"), round).status).toBe("blocked");
  });

  it("validates a product excluded from the dictionary normally", () => {
    const round = roundOf(withdrawal("เขียวมรกตเก่า 80 บาท", "6 โล"));

    expect(validate(goodReturn("เขียวมรกตเก่า 80 บาท", "2 โล"), round).status).toBe("clean");
  });

  it("keeps a coded and an uncoded product apart in one round", () => {
    const round = roundOf(withdrawal(
      "ม01 50 บาท", "2 โล",
      "เสาวรส 60 บาท", "3 โล",
    ));
    const result = validate(goodReturn(
      "กล้วยไข่ 50 บาท", "1 โล",
      "เสาวรส 60 บาท", "1 โล",
    ), round);

    expect(result.status).toBe("clean");
  });
});

// ── A coded document produces the same verdict as a typed one ───────────────

describe("code and word documents validate identically", () => {
  it("produces the same exception set either way", () => {
    const codedRound = roundOf(withdrawal("ม01 50 บาท", "2 โล"));
    const wordRound = roundOf(withdrawal("กล้วยไข่ 50 บาท", "2 โล"));

    const coded = validate(goodReturn("ม01 50 บาท", "3 โล"), codedRound);
    const words = validate(goodReturn("กล้วยไข่ 50 บาท", "3 โล"), wordRound);

    expect(coded.status).toBe(words.status);
    expect(kinds(coded.blocking)).toEqual(kinds(words.blocking));
    // Identical content means an identical digest — the confirmation a human
    // approves is bound to the data, not to how it was typed.
    expect(coded.digest).toBe(words.digest);
  });
});
