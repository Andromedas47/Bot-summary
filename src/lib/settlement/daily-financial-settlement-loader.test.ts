/**
 * End-to-end coverage for getDailyFinancialSettlement wired against the real
 * reused tables (digital_white_sheet_cash_entries, slip_evidences/slip_checks,
 * manual_slip_sessions/manual_slip_entries, transfer_reconciliations) through
 * the shared in-memory FakeDatabase — not the pure formula alone. This is the
 * exact exported service contract Task 5 will import.
 */

import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { FakeDatabase } from "@/lib/summary/test-fake-supabase";
import { getDailyFinancialSettlement } from "./daily-financial-settlement";
import { loadWhiteSheetCashEntry } from "@/lib/white-sheet/persist";

const client = (db: FakeDatabase): SupabaseClient<Database> =>
  db as unknown as SupabaseClient<Database>;

const SOURCE_ID = "group-1";
const MARKET = "ตลาดกลาง";

function seedCashEntry(db: FakeDatabase, businessDate: string, overrides: Record<string, unknown>) {
  db.seed("digital_white_sheet_cash_entries", [
    {
      id: `entry-${businessDate}`,
      source_id: SOURCE_ID,
      market_label_normalized: MARKET,
      business_date: businessDate,
      labor: 0,
      location_fee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      other_note: null,
      actual_cash_submitted: 0,
      white_sheet_sales: null,
      owner_cash: null,
      finalized_at: null,
      finalized_by: null,
      accountability_round_id: null,
      created_at: `${businessDate}T00:00:00Z`,
      updated_at: `${businessDate}T00:00:00Z`,
      ...overrides,
    },
  ]);
}

describe("getDailyFinancialSettlement — historical fixtures via the real tables", () => {
  it("22 Aug closes exactly matched", async () => {
    const db = new FakeDatabase();
    seedCashEntry(db, "2026-08-22", {
      labor: 4160,
      location_fee: 1000,
      bag: 500,
      snack: 500,
      other: 1030,
      actual_cash_submitted: 9553,
      white_sheet_sales: 28632,
      owner_cash: 1500,
    });
    // ยอดโอน 10,389 modeled as a single closed manual-slip entry — no AI slip
    // evidence needed for this fixture.
    db.seed("manual_slip_sessions", [
      { id: "sess-1", source_id: SOURCE_ID, business_date: "2026-08-22", status: "closed", market_label: MARKET },
    ]);
    db.seed("manual_slip_entries", [{ session_id: "sess-1", amount: 10389 }]);

    const result = await getDailyFinancialSettlement(client(db), {
      sourceId: SOURCE_ID,
      marketLabelNormalized: MARKET,
      businessDate: "2026-08-22",
    });

    expect(result.status).toBe("CLOSED_MATCHED");
    expect(result.whiteSheetSales).toBe(28632);
    expect(result.transferTotal).toBe(10389);
    expect(result.ownerCash).toBe(1500);
    expect(result.expensesTotal).toBe(3030);
    expect(result.wagesTotal).toBe(4160);
    expect(result.expectedCash).toBe(9553);
    expect(result.difference).toBe(0);
  });

  it("21 Aug closes exactly matched with zero owner cash", async () => {
    const db = new FakeDatabase();
    seedCashEntry(db, "2026-08-21", {
      labor: 5540,
      location_fee: 800,
      bag: 400,
      snack: 400,
      other: 875,
      actual_cash_submitted: 9017,
      white_sheet_sales: 24740,
      owner_cash: 0,
    });
    db.seed("manual_slip_sessions", [
      { id: "sess-2", source_id: SOURCE_ID, business_date: "2026-08-21", status: "closed", market_label: MARKET },
    ]);
    db.seed("manual_slip_entries", [{ session_id: "sess-2", amount: 7708 }]);

    const result = await getDailyFinancialSettlement(client(db), {
      sourceId: SOURCE_ID,
      marketLabelNormalized: MARKET,
      businessDate: "2026-08-21",
    });

    expect(result.status).toBe("CLOSED_MATCHED");
    expect(result.difference).toBe(0);
  });
});

describe("getDailyFinancialSettlement — INCOMPLETE / uncertainty", () => {
  it("no cash entry row at all reports INCOMPLETE, never CLOSED_MATCHED", async () => {
    const db = new FakeDatabase();
    const result = await getDailyFinancialSettlement(client(db), {
      sourceId: SOURCE_ID,
      marketLabelNormalized: MARKET,
      businessDate: "2026-08-23",
    });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.missingInputs).toEqual([
      "white_sheet_sales",
      "owner_cash",
      "expenses",
      "wages",
      "actual_cash",
    ]);
  });

  it("submitted entry missing white_sheet_sales/owner_cash reports INCOMPLETE for exactly those", async () => {
    const db = new FakeDatabase();
    seedCashEntry(db, "2026-08-24", {
      labor: 100,
      actual_cash_submitted: 500,
      // white_sheet_sales / owner_cash left null — not yet entered.
    });
    const result = await getDailyFinancialSettlement(client(db), {
      sourceId: SOURCE_ID,
      marketLabelNormalized: MARKET,
      businessDate: "2026-08-24",
    });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.missingInputs).toEqual(["white_sheet_sales", "owner_cash"]);
  });

  it("no transfer_reconciliations row yet is reported as uncertainty, not a block", async () => {
    const db = new FakeDatabase();
    seedCashEntry(db, "2026-08-25", {
      white_sheet_sales: 1000,
      owner_cash: 0,
      actual_cash_submitted: 1000,
    });
    const result = await getDailyFinancialSettlement(client(db), {
      sourceId: SOURCE_ID,
      marketLabelNormalized: MARKET,
      businessDate: "2026-08-25",
    });
    expect(result.status).toBe("CLOSED_MATCHED");
    expect(result.uncertainty.some((note) => note.includes("ยังไม่ได้ทำการกระทบยอดเงินโอน"))).toBe(true);
  });

  it("a submitted transfer that disagrees with checked slip evidence is reported as uncertainty", async () => {
    const db = new FakeDatabase();
    seedCashEntry(db, "2026-08-26", {
      white_sheet_sales: 1000,
      owner_cash: 0,
      actual_cash_submitted: 1000,
    });
    db.seed("transfer_reconciliations", [
      {
        source_id: SOURCE_ID,
        business_date: "2026-08-26",
        accountability_round_id: null,
        submitted_transfer_total: 500,
        checked_slip_total: 300,
        matched: false,
      },
    ]);
    const result = await getDailyFinancialSettlement(client(db), {
      sourceId: SOURCE_ID,
      marketLabelNormalized: MARKET,
      businessDate: "2026-08-26",
    });
    expect(result.uncertainty.some((note) => note.includes("500.00") && note.includes("300.00"))).toBe(true);
  });
});

describe("getDailyFinancialSettlement — idempotency and business-date validation", () => {
  it("calling it twice against the same identity returns an identical result (read-only, no mutation)", async () => {
    const db = new FakeDatabase();
    seedCashEntry(db, "2026-08-22", {
      labor: 4160,
      location_fee: 1000,
      bag: 500,
      snack: 500,
      other: 1030,
      actual_cash_submitted: 9553,
      white_sheet_sales: 28632,
      owner_cash: 1500,
    });
    const identity = { sourceId: SOURCE_ID, marketLabelNormalized: MARKET, businessDate: "2026-08-22" };
    const first = await getDailyFinancialSettlement(client(db), identity);
    const second = await getDailyFinancialSettlement(client(db), identity);
    expect(second).toEqual(first);
  });

  it("rejects a calendar-invalid business date (delegates to the shared business-date validator)", async () => {
    const db = new FakeDatabase();
    await expect(
      getDailyFinancialSettlement(client(db), {
        sourceId: SOURCE_ID,
        marketLabelNormalized: MARKET,
        businessDate: "2026-02-30",
      }),
    ).rejects.toThrow();
  });
});

describe("loadWhiteSheetCashEntry — Task 4 fields round-trip", () => {
  it("reads whiteSheetSales/ownerCash back from a submitted row", async () => {
    const db = new FakeDatabase();
    seedCashEntry(db, "2026-08-22", { white_sheet_sales: 28632, owner_cash: 1500 });
    const entry = await loadWhiteSheetCashEntry(client(db), {
      sourceId: SOURCE_ID,
      marketLabelNormalized: MARKET,
      businessDate: "2026-08-22",
    });
    expect(entry.status).toBe("submitted");
    if (entry.status !== "submitted") throw new Error("unreachable");
    expect(entry.whiteSheetSales).toBe(28632);
    expect(entry.ownerCash).toBe(1500);
  });
});
