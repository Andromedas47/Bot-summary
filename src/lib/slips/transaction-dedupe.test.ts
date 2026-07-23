import { describe, expect, it } from "bun:test";
import {
  findSlipTransactionDuplicate,
  normalizeTransactionId,
  resolveGloballyAcceptedCheckIds,
} from "./transaction-dedupe";

// ── Fake Supabase query builder ─────────────────────────────────────────────
// Chainable on select/eq/in/order; resolves via bare `await` (thenable, for
// the slip_checks queries) or via `.maybeSingle()` (for the evidence/batch
// lookups), matching how the real code calls each table.
function makeQueryBuilder(data: unknown, error: unknown = null) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    then: (resolve: (v: unknown) => void) => resolve({ data, error }),
    maybeSingle: async () => ({ data, error }),
  };
  return builder;
}

function makeSupabase(cfg: {
  checks?: Array<{ id: string; evidence_id: string; created_at: string; reference_id?: string }>;
  checksError?: { message: string } | null;
  evidence?: { source_id: string; received_at: string; batch_id: string | null } | null;
  batch?: { market_name: string | null } | null;
}) {
  return {
    from(table: string) {
      if (table === "slip_checks") return makeQueryBuilder(cfg.checks ?? [], cfg.checksError ?? null);
      if (table === "slip_evidences") return makeQueryBuilder(cfg.evidence ?? null);
      if (table === "slip_batches") return makeQueryBuilder(cfg.batch ?? null);
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

// ── normalizeTransactionId ───────────────────────────────────────────────────

describe("normalizeTransactionId", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeTransactionId("  ABC123  ")).toBe("ABC123");
  });
  it("preserves internal case and punctuation", () => {
    expect(normalizeTransactionId("  aBc-123/xyz  ")).toBe("aBc-123/xyz");
  });
  it("treats null, undefined, and empty-after-trim as null", () => {
    expect(normalizeTransactionId(null)).toBeNull();
    expect(normalizeTransactionId(undefined)).toBeNull();
    expect(normalizeTransactionId("   ")).toBeNull();
    expect(normalizeTransactionId("")).toBeNull();
  });
});

// ── findSlipTransactionDuplicate ─────────────────────────────────────────────

describe("findSlipTransactionDuplicate", () => {
  it("returns missing_transaction_id and performs no lookup when the id is null", async () => {
    const supabase = makeSupabase({});
    const result = await findSlipTransactionDuplicate(supabase as never, {
      rawTransactionId: null,
      sourceId: "group-1",
    });
    expect(result).toEqual({ status: "missing_transaction_id" });
  });

  it("returns missing_transaction_id for a whitespace-only id", async () => {
    const supabase = makeSupabase({});
    const result = await findSlipTransactionDuplicate(supabase as never, {
      rawTransactionId: "   ",
      sourceId: "group-1",
    });
    expect(result).toEqual({ status: "missing_transaction_id" });
  });

  it("returns unique when no prior check shares the reference id", async () => {
    const supabase = makeSupabase({ checks: [] });
    const result = await findSlipTransactionDuplicate(supabase as never, {
      rawTransactionId: "REF-001",
      sourceId: "group-1",
    });
    expect(result).toEqual({ status: "unique", transactionId: "REF-001" });
  });

  it("returns unique when the only match is the check being re-processed (webhook retry)", async () => {
    const supabase = makeSupabase({
      checks: [{ id: "check-self", evidence_id: "ev-1", created_at: "2026-06-06T01:00:00Z" }],
    });
    const result = await findSlipTransactionDuplicate(supabase as never, {
      rawTransactionId: "REF-001",
      sourceId: "group-1",
      excludeCheckId: "check-self",
    });
    expect(result).toEqual({ status: "unique", transactionId: "REF-001" });
  });

  it("flags duplicate_same_source when the original evidence shares the same LINE source", async () => {
    const supabase = makeSupabase({
      checks: [{ id: "check-orig", evidence_id: "ev-orig", created_at: "2026-06-06T01:00:00Z" }],
      evidence: { source_id: "group-1", received_at: "2026-06-06T01:00:00Z", batch_id: null },
    });
    const result = await findSlipTransactionDuplicate(supabase as never, {
      rawTransactionId: "REF-001",
      sourceId: "group-1",
      excludeCheckId: "check-new",
    });
    expect(result).toMatchObject({
      status: "duplicate_same_source",
      transactionId: "REF-001",
      originalRecordId: "check-orig",
    });
  });

  it("flags duplicate_cross_source when the original evidence belongs to a different LINE source", async () => {
    const supabase = makeSupabase({
      checks: [{ id: "check-orig", evidence_id: "ev-orig", created_at: "2026-06-06T01:00:00Z" }],
      evidence: { source_id: "group-OTHER", received_at: "2026-06-06T01:00:00Z", batch_id: null },
    });
    const result = await findSlipTransactionDuplicate(supabase as never, {
      rawTransactionId: "REF-001",
      sourceId: "group-1",
      excludeCheckId: "check-new",
    });
    expect(result).toMatchObject({
      status: "duplicate_cross_source",
      transactionId: "REF-001",
      originalRecordId: "check-orig",
    });
  });

  it("flags duplicate_cross_source with the original market label when the source differs by market", async () => {
    const supabase = makeSupabase({
      checks: [{ id: "check-orig", evidence_id: "ev-orig", created_at: "2026-06-06T01:00:00Z" }],
      evidence: { source_id: "group-market-b", received_at: "2026-06-06T01:00:00Z", batch_id: "batch-1" },
      batch: { market_name: "ตลาดบี" },
    });
    const result = await findSlipTransactionDuplicate(supabase as never, {
      rawTransactionId: "REF-001",
      sourceId: "group-market-a",
      excludeCheckId: "check-new",
    });
    expect(result).toMatchObject({
      status: "duplicate_cross_source",
      originalMarketLabel: "ตลาดบี",
      originalBusinessDate: "2026-06-06",
    });
  });

  it("does not reveal evidence/account details beyond record id, market label, and business date", () => {
    const result = {
      status: "duplicate_cross_source" as const,
      transactionId: "REF-001",
      originalRecordId: "check-orig",
      originalMarketLabel: "ตลาดบี",
      originalBusinessDate: "2026-06-06",
    };
    expect(Object.keys(result).sort()).toEqual(
      ["originalBusinessDate", "originalMarketLabel", "originalRecordId", "status", "transactionId"].sort(),
    );
  });

  it("surfaces a database error instead of silently reporting unique", async () => {
    const supabase = makeSupabase({ checksError: { message: "connection reset" } });
    await expect(
      findSlipTransactionDuplicate(supabase as never, { rawTransactionId: "REF-001", sourceId: "group-1" }),
    ).rejects.toThrow("connection reset");
  });
});

// ── resolveGloballyAcceptedCheckIds ─────────────────────────────────────────

describe("resolveGloballyAcceptedCheckIds", () => {
  it("returns an empty set without querying when given no reference ids", async () => {
    const supabase = { from() { throw new Error("should not query"); } };
    const winners = await resolveGloballyAcceptedCheckIds(supabase as never, []);
    expect(winners.size).toBe(0);
  });

  it("picks the earliest-created check as the winner per reference id", async () => {
    const supabase = makeSupabase({
      checks: [
        { id: "check-early", evidence_id: "ev-1", created_at: "2026-06-06T01:00:00Z", reference_id: "REF-001" },
        { id: "check-late", evidence_id: "ev-2", created_at: "2026-06-06T02:00:00Z", reference_id: "REF-001" },
        { id: "check-other", evidence_id: "ev-3", created_at: "2026-06-06T01:30:00Z", reference_id: "REF-002" },
      ],
    });
    const winners = await resolveGloballyAcceptedCheckIds(supabase as never, ["REF-001", "REF-002"]);
    expect(winners).toEqual(new Set(["check-early", "check-other"]));
  });
});
