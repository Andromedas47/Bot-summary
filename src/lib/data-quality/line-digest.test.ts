import { describe, expect, it } from "bun:test";
import * as lineDigest from "./line-digest";
import { planAdminDigest } from "./line-digest";
import type { DataQualityIssueRow } from "./types";

function row(overrides: Partial<DataQualityIssueRow>): DataQualityIssueRow {
  return {
    id: "row-1",
    issue_key: "k",
    category: "produce_no_return",
    severity: "ACTION_REQUIRED",
    business_date: "2026-08-25",
    affected_refs: [],
    summary_th: "x",
    technical_context: {},
    status: "OPEN",
    first_seen: "2026-08-25T00:00:00.000Z",
    last_seen: "2026-08-25T00:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    created_at: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("planAdminDigest — routing, no sending", () => {
  it("routes CRITICAL to immediate, ACTION_REQUIRED to daily digest, ADVISORY to inbox only", () => {
    const plan = planAdminDigest([
      row({ id: "1", severity: "CRITICAL" }),
      row({ id: "2", severity: "ACTION_REQUIRED" }),
      row({ id: "3", severity: "ADVISORY" }),
    ]);
    expect(plan.immediate.map((r) => r.id)).toEqual(["1"]);
    expect(plan.dailyDigest.map((r) => r.id)).toEqual(["2"]);
    expect(plan.inboxOnly.map((r) => r.id)).toEqual(["3"]);
  });

  it("only routes OPEN issues — resolved/ignored are never dispatched anywhere", () => {
    const plan = planAdminDigest([
      row({ id: "1", severity: "CRITICAL", status: "RESOLVED" }),
      row({ id: "2", severity: "CRITICAL", status: "IGNORED" }),
      row({ id: "3", severity: "CRITICAL", status: "OPEN" }),
    ]);
    expect(plan.immediate.map((r) => r.id)).toEqual(["3"]);
  });

  it("is synchronous and returns plain data — no promise, no I/O", () => {
    const result = planAdminDigest([]);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual({ immediate: [], dailyDigest: [], inboxOnly: [] });
  });

  it("exposes no send function at all — this module cannot push a LINE message", () => {
    const exportNames = Object.keys(lineDigest);
    expect(exportNames).toEqual(["planAdminDigest"]);
    for (const name of exportNames) {
      expect(name.toLowerCase()).not.toContain("send");
      expect(name.toLowerCase()).not.toContain("push");
    }
  });
});
