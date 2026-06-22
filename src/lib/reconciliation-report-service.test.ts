import { describe, expect, it } from "bun:test";
import { fetchReconciliationReport } from "./reconciliation-report-service";

// ── Stub Supabase ──────────────────────────────────────────────────────────────
// Each query in the service is `.from(t).select(...).gte(...).lte(...)` awaited
// as a promise. The builder returns itself for select/gte and resolves on lte.
function table(rows: unknown[]) {
  const builder = {
    select: () => builder,
    gte:    () => builder,
    lte:    () => Promise.resolve({ data: rows, error: null }),
  };
  return builder;
}

function makeSupabase(byTable: Record<string, unknown[]>) {
  return { from: (t: string) => table(byTable[t] ?? []) } as never;
}

// Three business dates inside the range:
//  - 2026-06-20 matched  (AI only): submitted 500 = checked 500, diff 0
//  - 2026-06-19 mixed    (AI+manual, matched): 600 + 400 = 1000, submitted 1000, diff 0
//  - 2026-06-18 mismatch (transfer short): submitted 650 vs checked 700, diff -50
const db = makeSupabase({
  transfer_reconciliations: [
    {
      source_id: "grpA", business_date: "2026-06-20",
      ai_verified_total: 500, manual_slip_total: 0, checked_slip_total: 500,
      submitted_transfer_total: 500, difference: 0, matched: true,
    },
    {
      source_id: "grpA", business_date: "2026-06-19",
      ai_verified_total: 600, manual_slip_total: 400, checked_slip_total: 1000,
      submitted_transfer_total: 1000, difference: 0, matched: true,
    },
    {
      source_id: "grpA", business_date: "2026-06-18",
      ai_verified_total: 700, manual_slip_total: 0, checked_slip_total: 700,
      submitted_transfer_total: 650, difference: -50, matched: false,
    },
  ],
  manual_slip_sessions: [
    { source_id: "grpA", business_date: "2026-06-19", market_label: "ตลาดบ่าย", status: "closed" },
  ],
  settlement_entries: [
    { source_id: "grpA", settlement_date: "2026-06-20", market_name: "ตลาดเช้า" },
    { source_id: "grpA", settlement_date: "2026-06-18", market_name: "ตลาดเย็น" },
  ],
});

describe("fetchReconciliationReport — UI/Excel parity scenarios", () => {
  it("produces identical per-row and summary totals consumed by both UI and Excel", async () => {
    const { rows, summary } = await fetchReconciliationReport(db, {
      fromDate: "2026-06-18",
      toDate:   "2026-06-20",
    });

    // Rows are sorted newest business_date first.
    expect(rows.map((r) => r.business_date)).toEqual([
      "2026-06-20",
      "2026-06-19",
      "2026-06-18",
    ]);

    // ── Matched day (AI only) ──
    const matched = rows[0];
    expect(matched.status).toBe("matched");
    expect(matched.submitted_transfer_total).toBe(500);
    expect(matched.checked_slip_total).toBe(500);
    expect(matched.difference).toBe(0);
    expect(matched.market).toBe("ตลาดเช้า");

    // ── Mixed AI + manual day ──
    const mixed = rows[1];
    expect(mixed.status).toBe("matched");
    expect(mixed.ai_verified_total).toBe(600);
    expect(mixed.manual_slip_total).toBe(400);
    expect(mixed.checked_slip_total).toBe(1000);
    expect(mixed.difference).toBe(0);
    expect(mixed.market).toBe("ตลาดบ่าย");

    // ── Mismatch day (transfer short) ──
    const mismatch = rows[2];
    expect(mismatch.status).toBe("transfer_short");
    expect(mismatch.submitted_transfer_total).toBe(650);
    expect(mismatch.checked_slip_total).toBe(700);
    expect(mismatch.difference).toBe(-50);

    // ── Summary (shown on UI StatCards AND the Excel "สรุป" sheet) ──
    expect(summary.submitted_transfer_total).toBe(2150);
    expect(summary.checked_slip_total).toBe(2200);
    expect(summary.difference_total).toBe(-50);
    expect(summary.needs_review_count).toBe(1);
    expect(summary.total_count).toBe(3);
  });

  it("isolates the mismatch row when the exception filter is applied", async () => {
    const { rows, summary } = await fetchReconciliationReport(db, {
      fromDate: "2026-06-18",
      toDate:   "2026-06-20",
      status:   "exception",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].business_date).toBe("2026-06-18");
    expect(rows[0].status).toBe("transfer_short");
    expect(summary.difference_total).toBe(-50);
  });
});
