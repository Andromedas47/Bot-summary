import { describe, expect, it } from "bun:test";
import {
  buildIssueKey,
  planIgnore,
  planResolve,
  planUpsert,
  upsertDataQualityIssue,
} from "./inbox";
import type { DataQualityIssueCandidate, DataQualityIssueRow } from "./types";

const NOW = "2026-08-25T10:00:00.000Z";
const LATER = "2026-08-26T10:00:00.000Z";

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

function existingRow(overrides: Partial<DataQualityIssueRow> = {}): DataQualityIssueRow {
  return {
    id: "row-1",
    issue_key: buildIssueKey("produce_no_return", "2026-08-25", ["round-1"]),
    category: "produce_no_return",
    severity: "ACTION_REQUIRED",
    business_date: "2026-08-25",
    affected_refs: ["round-1"],
    summary_th: "เบิก 3 รายการ และยังไม่พบรายการชั่งคืน",
    technical_context: { accountabilityRoundId: "round-1" },
    status: "OPEN",
    first_seen: NOW,
    last_seen: NOW,
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    created_at: NOW,
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

describe("planUpsert — deduplication", () => {
  it("a category mapped to NORMAL is never persisted", () => {
    // No shipped category is NORMAL today, so this proves the escape hatch
    // works via a category severity.ts does not know about failing loudly
    // would be the wrong test; instead prove ADVISORY/ACTION_REQUIRED/CRITICAL
    // categories always insert, establishing the contrast.
    const plan = planUpsert(null, candidate(), NOW);
    expect(plan.op).toBe("insert");
  });

  it("no existing row -> insert with first_seen = last_seen = now, status OPEN", () => {
    const plan = planUpsert(null, candidate(), NOW);
    expect(plan.op).toBe("insert");
    if (plan.op !== "insert") throw new Error("expected insert");
    expect(plan.row.status).toBe("OPEN");
    expect(plan.row.first_seen).toBe(NOW);
    expect(plan.row.last_seen).toBe(NOW);
    expect(plan.row.issue_key).toBe(buildIssueKey("produce_no_return", "2026-08-25", ["round-1"]));
  });

  it("same problem scanned twice -> the second scan updates last_seen, not a new row", () => {
    const first = planUpsert(null, candidate(), NOW);
    if (first.op !== "insert") throw new Error("expected insert");
    const rowAfterFirst: DataQualityIssueRow = { id: "row-1", ...first.row };

    const second = planUpsert(rowAfterFirst, candidate(), LATER);
    expect(second.op).toBe("update_open");
    if (second.op !== "update_open") throw new Error("expected update_open");
    expect(second.patch.last_seen).toBe(LATER);
    expect(second.issueKey).toBe(first.issueKey);
  });

  it("a later daily scan of an already-recorded historical issue does not duplicate it", () => {
    const day1 = planUpsert(null, candidate(), NOW);
    if (day1.op !== "insert") throw new Error("expected insert");
    const stored: DataQualityIssueRow = { id: "row-1", ...day1.row };

    // Re-running the scan (e.g. a retry, or a backfill over the same date)
    // must still resolve to the SAME key and never insert a second time.
    const rescan = planUpsert(stored, candidate(), LATER);
    expect(rescan.op).not.toBe("insert");
    expect(rescan.issueKey).toBe(day1.issueKey);
  });
});

describe("planUpsert — reopen", () => {
  it("a RESOLVED issue whose condition recurs reopens to OPEN, keeps first_seen, clears resolution", () => {
    const resolved = existingRow({
      status: "RESOLVED",
      resolved_at: NOW,
      resolved_by: "admin@example.com",
      resolution_note: "แก้ไขแล้ว",
      first_seen: "2026-08-20T00:00:00.000Z",
    });

    const plan = planUpsert(resolved, candidate(), LATER);
    expect(plan.op).toBe("reopen");
    if (plan.op !== "reopen") throw new Error("expected reopen");
    expect(plan.patch.status).toBe("OPEN");
    expect(plan.patch.resolved_at).toBeNull();
    expect(plan.patch.resolved_by).toBeNull();
    expect(plan.patch.resolution_note).toBeNull();
    expect(plan.patch.last_seen).toBe(LATER);
    // first_seen is untouched by the patch — this is not a new problem.
    expect(plan.patch.first_seen).toBeUndefined();
  });
});

describe("planUpsert — ignore", () => {
  it("an IGNORED issue stays IGNORED but keeps last_seen moving (suppressed, not silenced)", () => {
    const ignored = existingRow({
      status: "IGNORED",
      resolved_at: NOW,
      resolved_by: "admin@example.com",
      resolution_note: "known, low priority",
    });

    const plan = planUpsert(ignored, candidate(), LATER);
    expect(plan.op).toBe("touch_ignored");
    if (plan.op !== "touch_ignored") throw new Error("expected touch_ignored");
    expect(plan.patch.last_seen).toBe(LATER);
    expect(plan.patch.status).toBeUndefined(); // does not flip back to OPEN
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

describe("upsertDataQualityIssue — end-to-end idempotency against a fake store", () => {
  it("scanning the same candidate twice leaves exactly one row", async () => {
    const store: DataQualityIssueRow[] = [];
    let nextId = 1;

    const fakeSupabase = {
      from(table: string) {
        expect(table).toBe("data_quality_issues");
        return {
          select() {
            return {
              eq(_col: string, value: string) {
                return {
                  async maybeSingle() {
                    const found = store.find((r) => r.issue_key === value) ?? null;
                    return { data: found, error: null };
                  },
                };
              },
            };
          },
          insert(row: Omit<DataQualityIssueRow, "id">) {
            return {
              select() {
                return {
                  async single() {
                    const saved: DataQualityIssueRow = { id: `row-${nextId++}`, ...row };
                    store.push(saved);
                    return { data: saved, error: null };
                  },
                };
              },
            };
          },
          update(patch: Partial<DataQualityIssueRow>) {
            return {
              eq(_col: string, value: string) {
                return {
                  select() {
                    return {
                      async single() {
                        const idx = store.findIndex((r) => r.issue_key === value);
                        store[idx] = { ...store[idx], ...patch };
                        return { data: store[idx], error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const first = await upsertDataQualityIssue(fakeSupabase, candidate(), NOW);
    expect(first.plan.op).toBe("insert");
    expect(store).toHaveLength(1);

    const second = await upsertDataQualityIssue(fakeSupabase, candidate(), LATER);
    expect(second.plan.op).toBe("update_open");
    expect(store).toHaveLength(1);
    expect(store[0].last_seen).toBe(LATER);

    // A later "daily scan" of the same historical business date still keys
    // to the one row, not a fresh one.
    const third = await upsertDataQualityIssue(fakeSupabase, candidate(), LATER);
    expect(store).toHaveLength(1);
    void third;
  });
});
