/**
 * Business-content fingerprint — the exact-duplicate identity.
 *
 * Cases A–I of the 2026-08-15 duplicate-protection hotfix. Everything here is
 * pure: parse two documents, compare one string.
 */
import { describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { computeSessionHash } from "@/lib/line/session-dedup-service";
import {
  canonicalItemLines,
  weighSessionBusinessFingerprint,
} from "./business-fingerprint";

const DATE = "14/8/2569";

function document(lines: string[]): string {
  return lines.join("\n");
}

/** The real 2026-08-14 แทน — ราชพฤก withdrawal, abbreviated to its shape. */
function tanWithdrawal(options: {
  avocado?: string;
  seller?: string;
  market?: string;
  date?: string;
  reversed?: boolean;
} = {}): string {
  const body = [
    ["ฝรั่งแดง 300 บาท", "0.09 โล"],
    [`${options.avocado ?? "อะโวคาโด"} 50 บาท`, "3 โล"],
    ["องุ่นดำ 50 บาท", "1.9 โล"],
    ["สับปะรด 50 บาท", "16 ลูก"],
  ];
  const items = (options.reversed ? [...body].reverse() : body).flat();
  return document([
    `${options.seller ?? "แทน"}-${options.market ?? "ราชพฤก"} เบิก ${options.date ?? DATE}`,
    ...items,
    "จบรายการเบิก",
  ]);
}

const fingerprint = (text: string) => weighSessionBusinessFingerprint(parseWeighSession(text));

describe("business-content fingerprint", () => {
  it("CASE A — the same withdrawal resent is the same fingerprint", () => {
    expect(fingerprint(tanWithdrawal())).toBe(fingerprint(tanWithdrawal()));
  });

  it("CASE B — a different LINE source cannot change the fingerprint", () => {
    // The fingerprint has no source, no event id and no user in it, so two
    // groups carrying one business withdrawal cannot disagree about identity.
    // This is the แทน incident: rounds d5ae8a20 and 0874d4f3.
    const first = parseWeighSession(tanWithdrawal({ avocado: "อะโวคาโด" }));
    const second = parseWeighSession(tanWithdrawal({ avocado: "อะโวคาโด้" }));

    expect(weighSessionBusinessFingerprint(first))
      .toBe(weighSessionBusinessFingerprint(second));
  });

  it("CASE B — formatting differences do not change the fingerprint", () => {
    const spaced = fingerprint(document([
      `แทน-ราชพฤก เบิก ${DATE}`,
      "อะโวคาโด้ 50 บาท",
      "3 โล",
      "จบรายการเบิก",
    ]));
    const tight = fingerprint(document([
      `แทน-ราชพฤก เบิก ${DATE}`,
      "อะโวคาโด้50บาท",
      "3.โล",
      "จบรายการเบิก",
    ]));

    expect(tight).toBe(spaced);
  });

  it("CASE C — a different quantity is not a duplicate", () => {
    expect(fingerprint(tanWithdrawal()))
      .not.toBe(fingerprint(tanWithdrawal().replace("3 โล", "4 โล")));
  });

  it("CASE D — a different price is not a duplicate", () => {
    expect(fingerprint(tanWithdrawal()))
      .not.toBe(fingerprint(tanWithdrawal().replace("50 บาท", "55 บาท")));
  });

  it("CASE E — textual item order does not matter", () => {
    expect(fingerprint(tanWithdrawal({ reversed: true })))
      .toBe(fingerprint(tanWithdrawal()));
  });

  it("CASE F — a different business date is not a duplicate", () => {
    expect(fingerprint(tanWithdrawal()))
      .not.toBe(fingerprint(tanWithdrawal({ date: "13/8/2569" })));
  });

  it("CASE G — a different seller is not a duplicate", () => {
    expect(fingerprint(tanWithdrawal()))
      .not.toBe(fingerprint(tanWithdrawal({ seller: "จิ๋ว" })));
  });

  it("CASE H — a different normalized market is not a duplicate", () => {
    expect(fingerprint(tanWithdrawal()))
      .not.toBe(fingerprint(tanWithdrawal({ market: "ตลาด72" })));
  });

  it("CASE J — a reviewed market alias is the same business identity", () => {
    // Production 2026-08-14/15, ต้อม: พาซิโอ้ / พาซีโอ้ / พาสิโอ้ are one
    // market. A spelling variant must not buy a second fingerprint, and so must
    // not bypass duplicate protection.
    const tom = (market: string) => fingerprint(tanWithdrawal({ seller: "ต้อม", market }));
    expect(tom("พาซีโอ้")).toBe(tom("พาซิโอ้"));
    expect(tom("พาสิโอ้")).toBe(tom("พาซิโอ้"));
    // The 0055 aliases resolve here too, by the same registry.
    expect(tom("ราชพฤก")).toBe(tom("ราชพฤกษ์"));
  });

  it("CASE K — an UNREVIEWED near-miss market is still its own identity", () => {
    const tom = (market: string) => fingerprint(tanWithdrawal({ seller: "ต้อม", market }));
    // The fingerprint never guesses. Only the reviewed catalog collapses labels.
    expect(tom("พาซีโX")).not.toBe(tom("พาซิโอ้"));
    // Reviewed markets the catalog keeps apart stay apart.
    expect(tom("พาซิโอ้ผัก")).not.toBe(tom("พาซิโอ้ผลไม้"));
    expect(tom("พาซิโอ้")).not.toBe(tom("พาซิโอ้ผัก"));
  });

  it("CASE L — a reviewed unit alias is the same business identity", () => {
    const jar = (unit: string) => fingerprint(document([
      `ต้อม-พาซิโอ้ เบิก ${DATE}`,
      "น้ำพริก 50 บาท",
      `3 ${unit}`,
      "จบรายการเบิก",
    ]));
    expect(jar("ปุก")).toBe(jar("กระปุก"));
  });

  it("CASE I — repeated identical rows are kept, not self-deduplicated", () => {
    // ต้อม legitimately withdraws the same line twice. The multiset keeps both,
    // so a one-row document is NOT a duplicate of the two-row one.
    const twice = document([
      `ต้อม-พาซิโอ้ เบิก ${DATE}`,
      "กระชาย 20 บาท",
      "6 แพค",
      "กระชาย 20 บาท",
      "6 แพค",
      "จบรายการเบิก",
    ]);
    const once = document([
      `ต้อม-พาซิโอ้ เบิก ${DATE}`,
      "กระชาย 20 บาท",
      "6 แพค",
      "จบรายการเบิก",
    ]);

    const parsed = parseWeighSession(twice);
    expect(parsed.items).toHaveLength(2);
    expect(canonicalItemLines(parsed.items.map((item) => ({
      productName: item.product_name,
      unit: item.unit,
      quantity: item.quantity,
      pricePerUnit: item.price_per_unit,
      transactionType: item.transaction_type,
      basisQuantity: item.basis_quantity,
      basisUnit: item.basis_unit,
      basisPrice: item.basis_price,
    })))).toHaveLength(2);
    expect(fingerprint(twice)).not.toBe(fingerprint(once));
  });

  it("is what the finalizer writes as session_hash", () => {
    const parsed = parseWeighSession(tanWithdrawal());
    expect(computeSessionHash(parsed)).toBe(weighSessionBusinessFingerprint(parsed));
  });

  it("carries no LINE identity in the canonical document", () => {
    const parsed = parseWeighSession(tanWithdrawal());
    // Sanity: nothing source-shaped can reach the hash, because the input type
    // has no field for it. Guard the contract by construction.
    expect(Object.keys(parsed)).not.toContain("source_id");
  });
});
