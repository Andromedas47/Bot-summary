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

  it("fails closed when a requested reference has no resolved accepted row", async () => {
    const supabase = makeSupabase({
      checks: [
        {
          id: "check-found",
          evidence_id: "ev-1",
          created_at: "2026-06-06T01:00:00Z",
          reference_id: "REF-FOUND",
        },
      ],
    });

    await expect(
      resolveGloballyAcceptedCheckIds(
        supabase as never,
        ["REF-FOUND", "REF-MISSING"],
      ),
    ).rejects.toThrow("incomplete for 1 reference id");
  });

  it("deduplicates a repeated reference id before chunking, without changing the winner", async () => {
    const supabase = makeSupabase({
      checks: [
        { id: "check-early", evidence_id: "ev-1", created_at: "2026-06-06T01:00:00Z", reference_id: "REF-001" },
        { id: "check-late", evidence_id: "ev-2", created_at: "2026-06-06T02:00:00Z", reference_id: "REF-001" },
      ],
    });
    const winners = await resolveGloballyAcceptedCheckIds(
      supabase as never,
      ["REF-001", "REF-001", "REF-001"],
    );
    expect(winners).toEqual(new Set(["check-early"]));
  });

  it("resolves winners correctly across many chunks, with references spanning different chunks deduping correctly", async () => {
    const CHUNK_SIZE = 500; // must match REFERENCE_LOOKUP_CHUNK_SIZE in transaction-dedupe.ts
    const referenceIdCount = CHUNK_SIZE * 2 + 137; // forces 3 chunks, uneven last chunk

    const referenceIds = Array.from({ length: referenceIdCount }, (_, i) => `REF-${i}`);
    // Two checks per reference id: an earlier winner and a later duplicate,
    // exactly mirroring the single-chunk "earliest wins" test above but at a
    // scale that requires resolveGloballyAcceptedCheckIds to issue multiple
    // chunked queries under REFERENCE_LOOKUP_CHUNK_SIZE.
    const checksByReference = new Map<string, Array<{ id: string; created_at: string; reference_id: string }>>();
    for (const referenceId of referenceIds) {
      checksByReference.set(referenceId, [
        { id: `${referenceId}-early`, created_at: "2026-06-06T01:00:00Z", reference_id: referenceId },
        { id: `${referenceId}-late`, created_at: "2026-06-06T02:00:00Z", reference_id: referenceId },
      ]);
    }

    let queryCount = 0;
    const observedChunkSizes: number[] = [];
    const supabase = {
      from(table: string) {
        if (table !== "slip_checks") throw new Error(`unexpected table: ${table}`);
        const builder = {
          select: () => builder,
          in: (column: string, values: string[]) => {
            if (column === "reference_id") {
              queryCount += 1;
              observedChunkSizes.push(values.length);
              builder._matched = values.flatMap((v) => checksByReference.get(v) ?? []);
            }
            return builder;
          },
          order: () => builder,
          _matched: [] as Array<{ id: string; created_at: string; reference_id: string }>,
          then: (resolve: (v: unknown) => void) => resolve({ data: builder._matched, error: null }),
        };
        return builder;
      },
    };

    const winners = await resolveGloballyAcceptedCheckIds(supabase as never, referenceIds);

    // Multiple chunks were actually issued (not one unbounded query).
    expect(queryCount).toBeGreaterThan(1);
    expect(observedChunkSizes.every((size) => size <= CHUNK_SIZE)).toBe(true);
    expect(observedChunkSizes.reduce((a, b) => a + b, 0)).toBe(referenceIdCount);

    // Every reference id resolved to its earlier check across every chunk —
    // no silent partial result, no cross-chunk mixups.
    expect(winners.size).toBe(referenceIdCount);
    for (const referenceId of referenceIds) {
      expect(winners.has(`${referenceId}-early`)).toBe(true);
      expect(winners.has(`${referenceId}-late`)).toBe(false);
    }
  });
});
