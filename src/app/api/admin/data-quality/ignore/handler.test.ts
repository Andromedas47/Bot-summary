import { afterEach, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// See resolve/route.test.ts for why "@/lib/supabase/server" is never mocked
// here and handleIgnoreRequest is tested directly with a plain fake instead.
let ignoreCalls: Array<{ issueKey: string; note: string; actorId: string }> = [];
mock.module("@/lib/data-quality/inbox", () => ({
  ignoreDataQualityIssue: async (
    _supabase: unknown,
    issueKey: string,
    actor: { id: string; email: string | null },
    note: string,
  ) => {
    ignoreCalls.push({ issueKey, note, actorId: actor.id });
    return { id: "row-1", issue_key: issueKey, status: "IGNORED" };
  },
  resolveDataQualityIssue: async () => {
    throw new Error("ignore route.test.ts should never call resolveDataQualityIssue");
  },
}));

const { handleIgnoreRequest } = await import("./handler");

function fakeSupabase(
  user: { id: string; email?: string; app_metadata?: Record<string, unknown> } | null,
): SupabaseClient<Database> {
  return { auth: { getUser: async () => ({ data: { user } }) } } as unknown as SupabaseClient<Database>;
}

function req(body: unknown) {
  return new NextRequest("http://localhost/api/admin/data-quality/ignore", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  ignoreCalls = [];
  delete process.env.ADMIN_USER_IDS;
});

describe("POST /api/admin/data-quality/ignore — admin route permissions", () => {
  it("401s with no session", async () => {
    const res = await handleIgnoreRequest(req({ issueKey: "k", note: "known issue" }), fakeSupabase(null), {} as never);
    expect(res.status).toBe(401);
    expect(ignoreCalls).toHaveLength(0);
  });

  it("403s for an authenticated non-admin session", async () => {
    const res = await handleIgnoreRequest(
      req({ issueKey: "k", note: "known issue" }),
      fakeSupabase({ id: "user-1", app_metadata: {} }),
      {} as never,
    );
    expect(res.status).toBe(403);
    expect(ignoreCalls).toHaveLength(0);
  });

  it("succeeds for an admin session and calls the ignorer with the actor", async () => {
    const res = await handleIgnoreRequest(
      req({ issueKey: "issue-key-1", note: "known, low priority" }),
      fakeSupabase({ id: "admin-1", email: "admin@example.com", app_metadata: { role: "admin" } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect(ignoreCalls).toEqual([{ issueKey: "issue-key-1", note: "known, low priority", actorId: "admin-1" }]);
  });
});
