import { afterEach, describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  authErrorStatus,
  ForbiddenError,
  requireAdminActor,
  requireAuthenticatedActor,
  UnauthenticatedError,
} from "./admin";

function makeAuthSupabase(user: { id: string; email?: string; app_metadata?: Record<string, unknown> } | null) {
  return {
    auth: {
      getUser: async () => ({ data: { user } }),
    },
  } as unknown as SupabaseClient<Database>;
}

const ORIGINAL_ADMIN_USER_IDS = process.env.ADMIN_USER_IDS;

afterEach(() => {
  if (ORIGINAL_ADMIN_USER_IDS === undefined) {
    delete process.env.ADMIN_USER_IDS;
  } else {
    process.env.ADMIN_USER_IDS = ORIGINAL_ADMIN_USER_IDS;
  }
});

describe("requireAuthenticatedActor", () => {
  it("returns the actor for a valid session", async () => {
    const supabase = makeAuthSupabase({ id: "user-1", email: "a@b.com" });
    await expect(requireAuthenticatedActor(supabase)).resolves.toEqual({
      id: "user-1",
      email: "a@b.com",
    });
  });

  it("throws UnauthenticatedError (-> 401) when there is no session", async () => {
    const supabase = makeAuthSupabase(null);
    await expect(requireAuthenticatedActor(supabase)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe("requireAdminActor", () => {
  it("unauthenticated session -> UnauthenticatedError -> 401", async () => {
    delete process.env.ADMIN_USER_IDS;
    const supabase = makeAuthSupabase(null);
    await expect(requireAdminActor(supabase)).rejects.toBeInstanceOf(UnauthenticatedError);
    try {
      await requireAdminActor(supabase);
      throw new Error("expected rejection");
    } catch (err) {
      expect(authErrorStatus(err)).toBe(401);
    }
  });

  it("normal authenticated (non-admin) session -> ForbiddenError -> 403", async () => {
    delete process.env.ADMIN_USER_IDS;
    const supabase = makeAuthSupabase({ id: "user-1", app_metadata: {} });
    await expect(requireAdminActor(supabase)).rejects.toBeInstanceOf(ForbiddenError);
    try {
      await requireAdminActor(supabase);
      throw new Error("expected rejection");
    } catch (err) {
      expect(authErrorStatus(err)).toBe(403);
    }
  });

  it("admin session via app_metadata.role -> succeeds", async () => {
    delete process.env.ADMIN_USER_IDS;
    const supabase = makeAuthSupabase({ id: "admin-1", app_metadata: { role: "admin" } });
    await expect(requireAdminActor(supabase)).resolves.toEqual({ id: "admin-1", email: null });
  });

  it("does not trust user_metadata as an admin signal", async () => {
    delete process.env.ADMIN_USER_IDS;
    const supabase = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-1", user_metadata: { role: "admin" }, app_metadata: {} } },
        }),
      },
    } as unknown as SupabaseClient<Database>;
    await expect(requireAdminActor(supabase)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("bootstrap ADMIN_USER_IDS env var grants admin before app_metadata is set", async () => {
    process.env.ADMIN_USER_IDS = "user-1, user-2";
    const supabase = makeAuthSupabase({ id: "user-2", app_metadata: {} });
    await expect(requireAdminActor(supabase)).resolves.toEqual({ id: "user-2", email: null });
  });

  it("bootstrap ADMIN_USER_IDS does not grant admin to an id not listed", async () => {
    process.env.ADMIN_USER_IDS = "user-1";
    const supabase = makeAuthSupabase({ id: "user-99", app_metadata: {} });
    await expect(requireAdminActor(supabase)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("authErrorStatus", () => {
  it("returns null for an unrelated error", () => {
    expect(authErrorStatus(new Error("something else"))).toBeNull();
  });
});
