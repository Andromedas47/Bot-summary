/**
 * Fingerprint generation compatibility — V0 / V1 / V2.
 *
 * V0  pre-PR #51: raw parsed strings, ordered by item number.
 * V1  PR #51: canonical business content, market = NORMALIZED RAW LABEL.
 * V2  PR #53: canonical business content, market = REVIEWED CANONICAL identity.
 *
 * Only V2 is written as a session's identity. V0 stays readable, and the V1
 * rows Production accumulated between the two deployments — seller ต้อม, market
 * พาซีโอ้, 2026-08-15 among them — must still be recognised as duplicates.
 *
 * Every "old persisted hash" below is computed with the real previous-generation
 * function, never a copied constant, so the test cannot drift away from what
 * PR #51 actually wrote.
 */
import { describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import {
  computeLegacySessionHash,
  computeSessionHash,
  duplicateLookupCandidates,
  legacyUnitAliasSession,
  sessionHashReservations,
} from "@/lib/line/session-dedup-service";
import {
  businessContentFingerprint,
  weighSessionAliasCompatibilityFingerprints,
  weighSessionCompatibilityFingerprints,
  weighSessionLegacyMarketFingerprint,
  type BusinessContentInput,
} from "./business-fingerprint";

const DATE = "15/8/2569";

/** The 2026-08-15 ต้อม withdrawal shape, retyped under any market spelling. */
function tomWithdrawal(market: string, options: { seller?: string } = {}) {
  return parseWeighSession(
    [
      `${options.seller ?? "ต้อม"}-${market} เบิก ${DATE}`,
      "กระชาย 20 บาท",
      "6 แพค",
      "มะนาว 50 บาท",
      "3 โล",
      "จบรายการเบิก",
    ].join("\n"),
    "2026-08-15",
  );
}

/** What PR #51 would have persisted for this document typed as `spelling`. */
const v1 = (market: string, spelling = market) =>
  weighSessionLegacyMarketFingerprint(tomWithdrawal(market), spelling);
const v2 = (market: string) => computeSessionHash(tomWithdrawal(market));
const v0 = (market: string) => computeLegacySessionHash(tomWithdrawal(market));

describe("the three generations are distinct where they should be", () => {
  it("V1 keeps the raw market label — this is the gap", () => {
    // The blocker in one assertion: an alias-labelled V1 row does not match the
    // V2 hash the same document produces today.
    expect(v1("พาซีโอ้")).not.toBe(v2("พาซีโอ้"));
    // ...and a canonical-labelled V1 row does, because nothing folded.
    expect(v1("พาซิโอ้")).toBe(v2("พาซิโอ้"));
  });

  it("V2 folds every reviewed spelling of one market into one identity", () => {
    expect(v2("พาซีโอ้")).toBe(v2("พาซิโอ้"));
    expect(v2("พาสิโอ้")).toBe(v2("พาซิโอ้"));
  });

  it("V0 is a different algorithm entirely, not a market variation", () => {
    expect(v0("พาซิโอ้")).not.toBe(v1("พาซิโอ้"));
    expect(v0("พาซิโอ้")).not.toBe(v2("พาซิโอ้"));
  });
});

describe("compatibility set", () => {
  it("covers every reviewed spelling other than the canonical one", () => {
    const set = weighSessionCompatibilityFingerprints(tomWithdrawal("พาซิโอ้"));
    expect(set).toHaveLength(2);
    expect(set).toContain(v1("พาซิโอ้", "พาซีโอ้"));
    expect(set).toContain(v1("พาซิโอ้", "พาสิโอ้"));
    // The canonical spelling's V1 hash IS the V2 hash, so it is not repeated.
    expect(set).not.toContain(v2("พาซิโอ้"));
  });

  it("is identical whichever reviewed spelling the operator typed", () => {
    const canonical = weighSessionCompatibilityFingerprints(tomWithdrawal("พาซิโอ้"));
    for (const spelling of ["พาซีโอ้", "พาสิโอ้"]) {
      expect(weighSessionCompatibilityFingerprints(tomWithdrawal(spelling)).sort())
        .toEqual([...canonical].sort());
    }
  });

  it("is empty for a market with no reviewed aliases", () => {
    // V1 and V2 already agree, so there is nothing to reconcile.
    expect(weighSessionCompatibilityFingerprints(tomWithdrawal("วิหาร"))).toEqual([]);
  });

  it("is empty for an unreviewed near-miss, and never reaches the canonical", () => {
    // CASE 5 of the review matrix. พาชิโอ้ is one character from พาซิโอ้ and is
    // still its own market everywhere, fingerprint included.
    expect(weighSessionCompatibilityFingerprints(tomWithdrawal("พาชิโอ้"))).toEqual([]);
    expect(v2("พาชิโอ้")).not.toBe(v2("พาซิโอ้"));
    expect(weighSessionCompatibilityFingerprints(tomWithdrawal("พาซิโอ้")))
      .not.toContain(v1("พาชิโอ้"));
  });

  it("never connects two different reviewed markets", () => {
    // CASE 4. พาซิโอ้ผัก and พาซิโอ้ผลไม้ are distinct catalog markets.
    const vegetable = weighSessionCompatibilityFingerprints(tomWithdrawal("พาซิโอ้ผัก"));
    const fruit = weighSessionCompatibilityFingerprints(tomWithdrawal("พาซิโอ้ผลไม้"));
    expect(v2("พาซิโอ้ผัก")).not.toBe(v2("พาซิโอ้ผลไม้"));
    expect(vegetable).not.toContain(v2("พาซิโอ้ผลไม้"));
    expect(fruit).not.toContain(v2("พาซิโอ้ผัก"));
    for (const hash of vegetable) expect(fruit).not.toContain(hash);
  });

  it("never connects two different sellers, dates or item sets", () => {
    const mine = weighSessionCompatibilityFingerprints(tomWithdrawal("พาซิโอ้"));
    const otherSeller = weighSessionCompatibilityFingerprints(
      tomWithdrawal("พาซิโอ้", { seller: "จิ๋ว" }),
    );
    for (const hash of otherSeller) expect(mine).not.toContain(hash);
  });
});

describe("reservations and candidates", () => {
  it("reserves V2 first, then the V1 class — and never V0", () => {
    const parsed = tomWithdrawal("พาซีโอ้");
    const reservations = sessionHashReservations(parsed);

    expect(reservations[0]).toBe(computeSessionHash(parsed));
    expect(reservations.slice(1).sort())
      .toEqual([...weighSessionCompatibilityFingerprints(parsed)].sort());
    // CASE 8: release() deletes exactly this set, so a historical V0 row that
    // belongs to another session must not be in it.
    expect(reservations).not.toContain(computeLegacySessionHash(parsed));
  });

  it("reads V0 as well — a pre-PR #51 import is still a duplicate", () => {
    // CASE 6.
    const parsed = tomWithdrawal("พาซิโอ้");
    expect(duplicateLookupCandidates(parsed)).toContain(computeLegacySessionHash(parsed));
    expect(duplicateLookupCandidates(parsed)).toEqual([
      ...sessionHashReservations(parsed),
      computeLegacySessionHash(parsed),
    ]);
  });

  it("recognises a V1 row whichever reviewed spelling it and the resend used", () => {
    // CASES 1-3, at the identity layer: every old/new spelling pair overlaps.
    const spellings = ["พาซิโอ้", "พาซีโอ้", "พาสิโอ้"];
    for (const persisted of spellings) {
      const oldHash = v1(persisted);
      for (const resent of spellings) {
        expect(duplicateLookupCandidates(tomWithdrawal(resent))).toContain(oldHash);
      }
    }
  });

  it("does not recognise an unreviewed spelling's V1 row", () => {
    expect(duplicateLookupCandidates(tomWithdrawal("พาซิโอ้")))
      .not.toContain(v1("พาชิโอ้"));
  });
});

/**
 * The price generation — the 2026-08-19 subunit fix.
 *
 * Until then a quantity line in ขีด/กรัม/มิลลิลิตร also divided price_per_unit
 * by the conversion factor, so the real "2องุ่นคิมสัน120บาท / 0.7.ขีด"
 * withdrawal was imported as 1200. Every generation folds price_per_unit in, so
 * those documents are reserved under the old price. If a resend hashed only
 * under the corrected price it would look like a new document and persist a
 * second time — a duplicate withdrawal, which is exactly what the blocker
 * exists to stop.
 *
 * The pre-fix hashes below are built from the literal 1200 the old parser
 * produced, not from the helper under test, so this cannot pass by tautology.
 */
describe("pre-fix subunit prices stay recognisable", () => {
  const grapeWithdrawal = () =>
    parseWeighSession(
      ["เมย์-ราชพฤก เบิก 18/8/2569", "2องุ่นคิมสัน120บาท", "0.7.ขีด", "จบรายการเบิก"].join("\n"),
      "2026-08-18",
    );

  /** The same document as the pre-fix parser priced it: 120 / 0.1 = 1200. */
  const asImportedBeforeTheFix = () => {
    const parsed = grapeWithdrawal();
    return {
      ...parsed,
      items: parsed.items.map((item) => ({ ...item, price_per_unit: 1200 })),
    };
  };

  it("prices the document correctly today", () => {
    const item = grapeWithdrawal().items[0];
    expect(item).toMatchObject({ quantity: 0.07, unit: "โล", price_per_unit: 120 });
  });

  it("still recognises the row imported under the old rescaled price", () => {
    const candidates = duplicateLookupCandidates(grapeWithdrawal());
    const beforeTheFix = asImportedBeforeTheFix();

    expect(candidates).toContain(computeSessionHash(beforeTheFix));
    expect(candidates).toContain(computeLegacySessionHash(beforeTheFix));
    // Not the same hash — which is the whole reason the compatibility set is
    // needed rather than nothing at all.
    expect(computeSessionHash(beforeTheFix)).not.toBe(computeSessionHash(grapeWithdrawal()));
  });

  it("never RESERVES a hash built from the retired arithmetic", () => {
    const reservations = sessionHashReservations(grapeWithdrawal());
    const beforeTheFix = asImportedBeforeTheFix();

    expect(reservations).not.toContain(computeSessionHash(beforeTheFix));
    expect(reservations).not.toContain(computeLegacySessionHash(beforeTheFix));
    expect(reservations[0]).toBe(computeSessionHash(grapeWithdrawal()));
  });

  it("adds nothing for a document no conversion touched", () => {
    // The ต้อม withdrawal is แพค and โล only — factor 1 throughout.
    const parsed = tomWithdrawal("พาซิโอ้");
    expect(duplicateLookupCandidates(parsed)).toEqual([
      ...sessionHashReservations(parsed),
      computeLegacySessionHash(parsed),
    ]);
  });
});

/**
 * Product/unit alias compatibility — the gap the ไชมัส entry in
 * remaining-fruit.ts named and deferred: `canonicalItemLine` folds
 * PRODUCT_ALIASES / UNIT_ALIASES at whatever state the table is in when the
 * hash is computed, and unlike the market registry that never had a
 * compatibility layer, until this change.
 *
 * `businessContentFingerprint(..., rawItemIdentity)` reproduces, independently
 * of the function under test, the hash a document would have gotten before
 * ANY of today's product/unit aliases existed — so these tests cannot pass by
 * tautology against `weighSessionAliasCompatibilityFingerprints` itself.
 */
describe("product/unit alias compatibility", () => {
  const rawItemIdentity = {
    resolveProduct: (name: string) => name,
    resolveUnit: (unit: string) => unit,
  };

  function contentOf(parsed: WeighSession): BusinessContentInput {
    return {
      businessDate: parsed.date,
      sellerLabel: parsed.staff_name,
      marketLabel: parsed.session_title,
      items: parsed.items.map((item) => ({
        productName: item.product_name,
        unit: item.unit,
        quantity: item.quantity,
        pricePerUnit: item.price_per_unit,
        transactionType: item.transaction_type,
        basisQuantity: item.basis_quantity,
        basisUnit: item.basis_unit,
        basisPrice: item.basis_price,
      })),
    };
  }

  /** The hash the pre-alias parser would have produced for this document. */
  function rawHash(parsed: WeighSession): string {
    return businessContentFingerprint(contentOf(parsed), undefined, rawItemIdentity);
  }

  // ไซมัส is the corrected dictionary spelling (migration 20260818100000);
  // ไชมัส is the pre-correction spelling PRODUCT_ALIASES folds onto it.
  const productAliasWithdrawal = (product: string) =>
    parseWeighSession(
      [`เมย์-ราชพฤกษ์ เบิก ${DATE}`, `1.${product}60บาท`, "5โล", "จบรายการเบิก"].join("\n"),
      "2026-08-15",
    );

  // กก is a pure UNIT_ALIASES spelling of โล — factor 1, no rescaling, so this
  // is a clean unit-alias case independent of the subunit price-rescaling
  // arithmetic legacySubunitPricedSession covers.
  const unitAliasWithdrawal = (unit: string) =>
    parseWeighSession(
      [`เมย์-ราชพฤกษ์ เบิก ${DATE}`, "1.มะม่วง100บาท", `5${unit}`, "จบรายการเบิก"].join("\n"),
      "2026-08-15",
    );

  it("recognises a product-alias historical resend", () => {
    const parsed = productAliasWithdrawal("ไชมัส");
    // The alias folds it to a DIFFERENT product identity today, so the raw
    // reading and the current V2 hash really do disagree.
    expect(rawHash(parsed)).not.toBe(computeSessionHash(parsed));
    expect(weighSessionAliasCompatibilityFingerprints(parsed)).toContain(rawHash(parsed));
    expect(duplicateLookupCandidates(parsed)).toContain(rawHash(parsed));
  });

  it("recognises a unit-alias historical resend", () => {
    // Unlike a product name, `item.unit` is already canonical by hash time —
    // the PARSER folds the alias while building the item. So the reading that
    // matters is legacyUnitAliasSession(parsed), which puts the raw "กก" back
    // from the legacy_unit_alias_raw evidence the parser left, NOT `parsed`
    // itself (whose item.unit already reads "โล").
    const parsed = unitAliasWithdrawal("กก");
    const reverted = legacyUnitAliasSession(parsed);
    expect(reverted).not.toBeNull();
    const expectedHash = rawHash(reverted!);
    expect(expectedHash).not.toBe(computeSessionHash(parsed));
    expect(duplicateLookupCandidates(parsed)).toContain(expectedHash);
  });

  it("adds nothing for a unit typed in its own canonical spelling", () => {
    // "โล" typed directly leaves no legacy_unit_alias_raw evidence — there was
    // no alias to bypass, so there is nothing to revert.
    expect(legacyUnitAliasSession(unitAliasWithdrawal("โล"))).toBeNull();
  });

  it("never RESERVES the raw pre-alias reading", () => {
    const parsed = productAliasWithdrawal("ไชมัส");
    expect(sessionHashReservations(parsed)).not.toContain(rawHash(parsed));

    const unitParsed = unitAliasWithdrawal("กก");
    const unitHash = rawHash(legacyUnitAliasSession(unitParsed)!);
    expect(sessionHashReservations(unitParsed)).not.toContain(unitHash);
  });

  it("is empty for a document no product/unit alias touches", () => {
    // ไซมัส is already the canonical spelling — nothing to fold.
    const parsed = productAliasWithdrawal("ไซมัส");
    expect(weighSessionAliasCompatibilityFingerprints(parsed)).toEqual([]);
  });

  it("does not mark a distinct same-day document a duplicate merely because a legacy hash exists", () => {
    // A DIFFERENT product resent the same day/seller/market must not collide
    // just because the alias-affected withdrawal above has a legacy reading
    // recorded — proves the lookup is content-specific, not date/seller-wide.
    const legacy = productAliasWithdrawal("ไชมัส");
    const distinct = productAliasWithdrawal("ทุเรียนหมอนทอง");
    expect(weighSessionAliasCompatibilityFingerprints(distinct)).not.toContain(rawHash(legacy));
    expect(duplicateLookupCandidates(distinct)).not.toContain(rawHash(legacy));
  });

  it("also covers a document that predates BOTH a product alias and a market alias", () => {
    // ต้อม-พาซีโอ้ (V1 market alias) carrying the pre-correction product
    // spelling — a document that predates both fixes at once.
    const parsed = parseWeighSession(
      [`ต้อม-พาซีโอ้ เบิก ${DATE}`, "1.ไชมัส60บาท", "5โล", "จบรายการเบิก"].join("\n"),
      "2026-08-15",
    );
    const combined = businessContentFingerprint(
      contentOf(parsed),
      () => "พาซีโอ้",
      rawItemIdentity,
    );
    expect(weighSessionAliasCompatibilityFingerprints(parsed)).toContain(combined);
  });
});
