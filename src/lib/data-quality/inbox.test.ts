import { describe, expect, it } from "bun:test";
import {
  buildIssueKey,
  planIgnore,
  planResolve,
  prepareAtomicUpsertPayload,
  upsertDataQualityIssuesAtomically,
} from "./inbox";
import type { DataQualityIssueCandidate } from "./types";

const NOW = "2026-08-25T10:00:00.000Z";

function candidate(overrides: Partial<DataQualityIssueCandidate> = {}): DataQualityIssueCandidate {
  return {
    category: "produce_no_return",
    businessDate: "2026-08-25",
    entityRefs: ["round-1"],
    summaryTh: "เบิก 3 รายการ และยังไม่พบรายการชั่งคืน",
    technicalContext: { accountabilityRoundId: "round-1" },
    ...overrides,
  };
}

describe("buildIssueKey", () => {
  it("is stable regardless of entity ref order or repeats", () => {
    const a = buildIssueKey("produce_no_return", "2026-08-25", ["round-2", "round-1"]);
    const b = buildIssueKey("produce_no_return", "2026-08-25", ["round-1", "round-2", "round-1"]);
    expect(a).toBe(b);
  });

  it("differs when category, date, or entities differ", () => {
    const base = buildIssueKey("produce_no_return", "2026-08-25", ["round-1"]);
    expect(buildIssueKey("produce_stale_failed_session", "2026-08-25", ["round-1"])).not.toBe(base);
    expect(buildIssueKey("produce_no_return", "2026-08-26", ["round-1"])).not.toBe(base);
    expect(buildIssueKey("produce_no_return", "2026-08-25", ["round-2"])).not.toBe(base);
  });
});

describe("planResolve / planIgnore", () => {
  it("resolve sets status, resolved_at, resolved_by (email preferred), and the note", () => {
    const patch = planResolve({ id: "u1", email: "admin@example.com" }, "  fixed manually  ", NOW);
    expect(patch).toEqual({
      status: "RESOLVED",
      resolved_at: NOW,
      resolved_by: "admin@example.com",
      resolution_note: "fixed manually",
    });
  });

  it("resolve falls back to actor id when email is null", () => {
    const patch = planResolve({ id: "u1", email: null }, "fixed", NOW);
    expect(patch.resolved_by).toBe("u1");
  });

  it("ignore sets status IGNORED with the same actor/note shape", () => {
    const patch = planIgnore({ id: "u1", email: "admin@example.com" }, "known issue", NOW);
    expect(patch.status).toBe("IGNORED");
    expect(patch.resolved_by).toBe("admin@example.com");
    expect(patch.resolution_note).toBe("known issue");
  });
});

describe("atomic scan persistence", () => {
  it("deduplicates repeated identities before the RPC", () => {
    const payload = prepareAtomicUpsertPayload([
      candidate(),
      candidate({ summaryTh: "latest summary" }),
    ]);
    expect(payload).toHaveLength(1);
    expect(payload[0].summary_th).toBe("latest summary");
  });

  it("uses one RPC for the complete candidate set", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const fakeSupabase = {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return { data: [], error: null };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await upsertDataQualityIssuesAtomically(fakeSupabase, [
      candidate(),
      candidate({ businessDate: "2026-08-26" }),
    ], NOW);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("upsert_data_quality_issues");
    expect(calls[0].args.p_seen_at).toBe(NOW);
    expect(calls[0].args.p_candidates).toHaveLength(2);
  });

  it("does not call the database for an empty scan", async () => {
    let calls = 0;
    const fakeSupabase = {
      async rpc() {
        calls += 1;
        return { data: [], error: null };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(await upsertDataQualityIssuesAtomically(fakeSupabase, [], NOW)).toEqual([]);
    expect(calls).toBe(0);
  });

  it("surfaces an RPC failure without attempting a second write", async () => {
    let calls = 0;
    const fakeSupabase = {
      async rpc() {
        calls += 1;
        return { data: null, error: { message: "forced failure" } };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(upsertDataQualityIssuesAtomically(fakeSupabase, [candidate()], NOW))
      .rejects.toThrow("atomic upsert failed: forced failure");
    expect(calls).toBe(1);
  });
});
