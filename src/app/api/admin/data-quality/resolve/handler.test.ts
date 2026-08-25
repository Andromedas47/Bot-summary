import { afterEach, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// `@/lib/supabase/server` is deliberately NEVER mocked here. Several other
// test files in this suite mock that exact shared path with a shape that
// omits createClient (they only need createServiceClient), and Bun's
// mock.module registry + module cache are process-wide, not file-scoped —
// depending on scheduling, route.ts's dependency link for that path can
// resolve against a DIFFERENT test file's mock (reproduced directly: neither
// command-line file order nor a cache-busted import specifier reliably fixed
// it). route.ts exports handleResolveRequest separately from POST precisely
// so tests can exercise the auth gate + business logic with a plain fake
// `{ auth: { getUser } }` object, never importing/calling the real
// createClient()/createServiceClient() at all.
let resolveCalls: Array<{ issueKey: string; note: string; actorId: string }> = [];
mock.module("@/lib/data-quality/inbox", () => ({
  resolveDataQualityIssue: async (
    _supabase: unknown,
    issueKey: string,
    actor: { id: string; email: string | null },
    note: string,
  ) => {
    resolveCalls.push({ issueKey, note, actorId: actor.id });
    return { id: "row-1", issue_key: issueKey, status: "RESOLVED" };
  },
  ignoreDataQualityIssue: async () => {
    throw new Error("resolve route.test.ts should never call ignoreDataQualityIssue");
  },
}));

const { handleResolveRequest } = await import("./handler");

function fakeSupabase(
  user: { id: string; email?: string; app_metadata?: Record<string, unknown> } | null,
): SupabaseClient<Database> {
  return { auth: { getUser: async () => ({ data: { user } }) } } as unknown as SupabaseClient<Database>;
}

function req(body: unknown) {
  return new NextRequest("http://localhost/api/admin/data-quality/resolve", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  resolveCalls = [];
  delete process.env.ADMIN_USER_IDS;
});

describe("POST /api/admin/data-quality/resolve — admin route permissions", () => {
  it("401s with no session", async () => {
    const res = await handleResolveRequest(req({ issueKey: "k", note: "fixed" }), fakeSupabase(null), {} as never);
    expect(res.status).toBe(401);
    expect(resolveCalls).toHaveLength(0);
  });

  it("403s for an authenticated non-admin session", async () => {
    const res = await handleResolveRequest(
      req({ issueKey: "k", note: "fixed" }),
      fakeSupabase({ id: "user-1", app_metadata: {} }),
      {} as never,
    );
    expect(res.status).toBe(403);
    expect(resolveCalls).toHaveLength(0);
  });

  it("succeeds for an admin session and calls the resolver with the actor", async () => {
    const res = await handleResolveRequest(
      req({ issueKey: "issue-key-1", note: "แก้ไขแล้ว" }),
      fakeSupabase({ id: "admin-1", email: "admin@example.com", app_metadata: { role: "admin" } }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect(resolveCalls).toEqual([{ issueKey: "issue-key-1", note: "แก้ไขแล้ว", actorId: "admin-1" }]);
  });

  it("400s when issueKey or note is missing, even for an admin", async () => {
    const res = await handleResolveRequest(
      req({ issueKey: "" }),
      fakeSupabase({ id: "admin-1", app_metadata: { role: "admin" } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(resolveCalls).toHaveLength(0);
  });
});
