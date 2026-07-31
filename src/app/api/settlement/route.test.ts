/**
 * Regression for POST /api/settlement after Slice 3D.1 moved the `source_id`
 * branch into src/lib/settlement/submit-entry.ts so LINE can share it.
 *
 * The Dashboard contract must be byte-for-byte what it was: reconcile blocks
 * with 400, the entry is upserted on
 * (settlement_date, settlement_time, staff_name, market_name), the finalizer
 * still runs on submit, and the response still carries the entry plus
 * finalizeStatus and reconciliation.
 *
 * route.ts calls createServiceClient() internally (not injected), so the module
 * is mocked and each test points `currentSupabase` at its own fixture — the
 * convention already used by src/app/api/pdf/report-summary/route.test.ts.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import { NextRequest } from "next/server";
import { RoundFakeDatabase } from "@/lib/line/guided-menu/test-fake-round-db";

let currentDb: RoundFakeDatabase;

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: async () => currentDb.asClient(),
}));

const { POST } = await import("./route");

const SOURCE = "G-1";
const DATE = "2026-07-29";
const MARKET = "วัดทุ่งลานนา";
const SELLER = "กี้";

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/settlement", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

function dashboardBody(extra: Record<string, unknown> = {}) {
  return {
    settlement_date: DATE,
    settlement_time: "",
    staff_name: SELLER,
    market_name: MARKET,
    money_transfer: 12000,
    money_cash: 3000,
    expenses: 500,
    labor: 800,
    notes: "จากแดชบอร์ด",
    ...extra,
  };
}

beforeEach(() => {
  currentDb = new RoundFakeDatabase();
});

describe("POST /api/settlement", () => {
  it("still requires settlement_date", async () => {
    const response = await post({ money_transfer: 1 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "settlement_date required" });
  });

  it("upserts and reconciles when source_id is supplied", async () => {
    // An in-flight batch keeps the finalizer at not_ready, so the test proves
    // the finalizer still runs without reaching the LINE push.
    currentDb.seed("slip_batches", [
      {
        id: "b-1",
        source_id: SOURCE,
        status: "collecting",
        last_image_at: `${DATE}T05:00:00Z`,
      },
    ]);

    const response = await post(dashboardBody({ source_id: SOURCE }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.finalizeStatus).toBe("not_ready");
    expect(body.reconciliation).toMatchObject({
      ai_verified_total: 0,
      manual_slip_total: 0,
      checked_slip_total: 0,
      submitted_transfer_total: 12000,
      difference: 12000,
      matched: false,
    });
    expect(body.money_transfer).toBe(12000);
    expect(body.source_id).toBe(SOURCE);

    expect(currentDb.tables.settlement_entries).toHaveLength(1);
    expect(currentDb.tables.settlement_entries[0]).toMatchObject({
      settlement_date: DATE,
      settlement_time: "",
      staff_name: SELLER,
      market_name: MARKET,
      money_cash: 3000,
      expenses: 500,
      labor: 800,
      notes: "จากแดชบอร์ด",
    });
    // reconcile() still writes transfer_reconciliations on submit.
    expect(currentDb.tables.transfer_reconciliations).toHaveLength(1);
  });

  it("still returns 400 and writes nothing when a manual slip session is open", async () => {
    currentDb.seed("manual_slip_sessions", [
      { id: "ms-1", source_id: SOURCE, business_date: DATE, status: "open" },
    ]);

    const response = await post(dashboardBody({ source_id: SOURCE }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("จบสลิปมือ");
    expect(currentDb.tables.settlement_entries).toHaveLength(0);
  });

  it("still updates one row on resubmission under the same key", async () => {
    currentDb.seed("slip_batches", [
      {
        id: "b-1",
        source_id: SOURCE,
        status: "collecting",
        last_image_at: `${DATE}T05:00:00Z`,
      },
    ]);

    await post(dashboardBody({ source_id: SOURCE }));
    await post(dashboardBody({ source_id: SOURCE, money_transfer: 11000 }));

    expect(currentDb.tables.settlement_entries).toHaveLength(1);
    expect(currentDb.tables.settlement_entries[0]!.money_transfer).toBe(11000);
    // reconcile() also upserts on (source_id, business_date) — no duplicate recon rows.
    expect(currentDb.tables.transfer_reconciliations).toHaveLength(1);
    expect(currentDb.tables.transfer_reconciliations[0]).toMatchObject({
      source_id: SOURCE,
      business_date: DATE,
      submitted_transfer_total: 11000,
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        currentDb.tables.transfer_reconciliations[0],
        "work_round_id",
      ),
    ).toBe(false);
  });

  it("keeps the legacy no-source_id path free of reconciliation", async () => {
    const response = await post(dashboardBody());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.reconciliation).toBeUndefined();
    expect(body.finalizeStatus).toBeUndefined();
    expect(body.lineTargets).toBe(0);
    expect(body.lineError).toBeNull();

    expect(currentDb.tables.settlement_entries).toHaveLength(1);
    expect(currentDb.tables.transfer_reconciliations ?? []).toHaveLength(0);
  });
});
