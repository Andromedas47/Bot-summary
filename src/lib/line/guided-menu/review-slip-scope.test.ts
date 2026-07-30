/**
 * PR #10 review finding #4 — the per-slip list must have exactly the scope the
 * reconciliation loaders use, so that a slip shown as อ่านสำเร็จ is one that
 * actually contributes to checked_slip_total.
 *
 * The authoritative window is half-open: startUtc <= t < endUtc.
 */

import { describe, expect, it } from "bun:test";
import { RoundFakeDatabase } from "./test-fake-round-db";
import { buildGuidedRoundReport, loadGuidedSlipRows } from "./round-close";
import { businessDateToUtcRange } from "@/lib/reconciliation";
import { listKnownProduceMarketLabels } from "@/lib/white-sheet";
import type { GuidedJourneyContext } from "./journey";

const SOURCE = "G-1";
const DATE = "2026-07-29";
const MARKET = "วัดทุ่งลานนา";
const OTHER_MARKET = "หน้าเซเวน";

const { startUtc, endUtc } = businessDateToUtcRange(DATE);
const MID_WINDOW = "2026-07-29T05:00:00Z";

const CONTEXT: GuidedJourneyContext = {
  sessionKey: "group:G-1:user:U-op-1",
  sourceId: SOURCE,
  lineUserId: "U-op-1",
  sellerLabel: "กี้",
  marketLabel: MARKET,
  marketLabelNormalized: MARKET,
  businessDate: DATE,
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

function baseDb(markets: string[] = [MARKET]): RoundFakeDatabase {
  const db = new RoundFakeDatabase();
  for (const market of markets) {
    db.seedKnownMarket({ sourceId: SOURCE, businessDate: DATE, marketName: market });
  }
  return db;
}

function seedSlip(
  db: RoundFakeDatabase,
  input: {
    id: string;
    market?: string | null;
    amount?: number;
    receivedAt?: string;
    transactionTime?: string | null;
    status?: string;
  },
): void {
  db.seed("slip_evidences", [
    {
      id: `ev-${input.id}`,
      source_id: SOURCE,
      market_label: input.market === undefined ? MARKET : input.market,
      market_label_normalized: input.market === undefined ? MARKET : input.market,
      received_at: input.receivedAt ?? MID_WINDOW,
    },
  ]);
  db.seed("slip_checks", [
    {
      id: input.id,
      evidence_id: `ev-${input.id}`,
      status: input.status ?? "EXTRACTED",
      transfer_amount: input.amount ?? 1000,
      reference_id: `ref-${input.id}`,
      transaction_time: input.transactionTime ?? MID_WINDOW,
      created_at: MID_WINDOW,
    },
  ]);
}

async function rows(db: RoundFakeDatabase, markets: string[] = [MARKET]) {
  const known = new Set(
    await listKnownProduceMarketLabels(db.asClient(), SOURCE, DATE),
  );
  for (const market of markets) expect(known.has(market)).toBe(true);
  return loadGuidedSlipRows(db.asClient(), CONTEXT, known);
}

describe("slip list scope matches the reconciliation scope", () => {
  it("omits a slip attributed to another KNOWN market instead of calling it unclear", async () => {
    const db = baseDb([MARKET, OTHER_MARKET]);
    seedSlip(db, { id: "mine" });
    seedSlip(db, { id: "theirs", market: OTHER_MARKET });

    const list = await rows(db, [MARKET, OTHER_MARKET]);
    expect(list.map((row) => row.checkId)).toEqual(["mine"]);
  });

  it("still reports an unknown or missing market as ตลาดไม่ชัด", async () => {
    const db = baseDb();
    seedSlip(db, { id: "unknown-market", market: "ตลาดที่ไม่รู้จัก" });
    seedSlip(db, { id: "no-market", market: null });

    const list = await rows(db);
    expect(list.map((row) => [row.checkId, row.status])).toEqual([
      ["unknown-market", "market_unclear"],
      ["no-market", "market_unclear"],
    ]);
  });

  it("includes received_at exactly at the window start", async () => {
    const db = baseDb();
    seedSlip(db, { id: "start", receivedAt: startUtc });
    const list = await rows(db);
    expect(list.map((row) => row.checkId)).toEqual(["start"]);
  });

  it("excludes received_at exactly at the window end", async () => {
    const db = baseDb();
    seedSlip(db, { id: "end", receivedAt: endUtc });
    const list = await rows(db);
    expect(list).toEqual([]);
  });

  it("treats a transaction time exactly at the start as inside", async () => {
    const db = baseDb();
    seedSlip(db, { id: "tx-start", transactionTime: startUtc });
    const list = await rows(db);
    expect(list[0]).toMatchObject({ checkId: "tx-start", status: "verified" });
  });

  it("treats a transaction time exactly at the end as outside", async () => {
    const db = baseDb();
    seedSlip(db, { id: "tx-end", transactionTime: endUtc });
    const list = await rows(db);
    expect(list[0]).toMatchObject({ checkId: "tx-end", status: "date_mismatch" });
  });

  it("treats a transaction time before the start as outside", async () => {
    const db = baseDb();
    seedSlip(db, { id: "tx-early", transactionTime: "2026-07-27T05:00:00Z" });
    const list = await rows(db);
    expect(list[0]).toMatchObject({ status: "date_mismatch" });
  });
});

describe("every verified row is inside the authoritative total", () => {
  it("sums exactly the amounts of the verified rows", async () => {
    const db = baseDb([MARKET, OTHER_MARKET]);
    seedSlip(db, { id: "a", amount: 8000 });
    seedSlip(db, { id: "b", amount: 4000 });
    // None of these may reach the total.
    seedSlip(db, { id: "other-market", market: OTHER_MARKET, amount: 999 });
    seedSlip(db, { id: "unknown-market", market: "ไม่รู้จัก", amount: 777 });
    seedSlip(db, { id: "after-window", receivedAt: endUtc, amount: 555 });
    seedSlip(db, { id: "needs-review", status: "NEED_REVIEW", amount: 333 });

    const report = await buildGuidedRoundReport(db.asClient(), CONTEXT, true);
    const verified = report.slips.filter((row) => row.status === "verified");
    const verifiedSum = verified.reduce((sum, row) => sum + (row.amount ?? 0), 0);

    expect(verified.map((row) => row.checkId).sort()).toEqual(["a", "b"]);
    expect(verifiedSum).toBe(12000);
    // The authoritative loader agrees with what the operator was shown.
    expect(report.totals.aiVerifiedTotal).toBe(12000);
    expect(report.totals.checkedSlipTotal).toBe(12000);
    // And nothing verified is missing from the total.
    expect(report.totals.aiVerifiedTotal).toBeGreaterThanOrEqual(verifiedSum);
  });

  it("never lists another market's slip in this round's report", async () => {
    const db = baseDb([MARKET, OTHER_MARKET]);
    seedSlip(db, { id: "theirs", market: OTHER_MARKET, amount: 5000 });

    const report = await buildGuidedRoundReport(db.asClient(), CONTEXT, true);
    expect(report.slips).toEqual([]);
    expect(report.totals.aiVerifiedTotal).toBe(0);
    // Another market's slip is skipped by the loader, not counted as unresolved,
    // so it raises no attribution blocker for this round either.
    expect(report.blockers).not.toContain("attribution_ambiguous");
  });

  it("keeps a date_mismatch slip inside the total, as the loader does", async () => {
    const db = baseDb();
    seedSlip(db, { id: "odd-time", amount: 1500, transactionTime: endUtc });

    const report = await buildGuidedRoundReport(db.asClient(), CONTEXT, true);
    expect(report.slips[0]).toMatchObject({ status: "date_mismatch" });
    // The money loaders scope by received_at only: the status is a warning about
    // the bank timestamp, never a claim that the amount was excluded.
    expect(report.totals.aiVerifiedTotal).toBe(1500);
  });
});
