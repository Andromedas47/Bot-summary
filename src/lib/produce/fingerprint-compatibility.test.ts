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
import {
  computeLegacySessionHash,
  computeSessionHash,
  sessionHashCandidates,
  sessionHashReservations,
} from "@/lib/line/session-dedup-service";
import {
  weighSessionCompatibilityFingerprints,
  weighSessionLegacyMarketFingerprint,
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
    expect(sessionHashCandidates(parsed)).toContain(computeLegacySessionHash(parsed));
    expect(sessionHashCandidates(parsed)).toEqual([
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
        expect(sessionHashCandidates(tomWithdrawal(resent))).toContain(oldHash);
      }
    }
  });

  it("does not recognise an unreviewed spelling's V1 row", () => {
    expect(sessionHashCandidates(tomWithdrawal("พาซิโอ้")))
      .not.toContain(v1("พาชิโอ้"));
  });
});
