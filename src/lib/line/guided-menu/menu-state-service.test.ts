import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GuidedMenuStateService } from "./menu-state-service";

function fakeClient(handlers: {
  maybeSingle?: () => { data: unknown; error: null | { message: string } };
}): SupabaseClient {
  const chain: Record<string, unknown> = {};
  const api = {
    from: () => api,
    select: () => api,
    eq: () => api,
    maybeSingle: async () =>
      handlers.maybeSingle?.() ?? { data: null, error: null },
  };
  Object.assign(chain, api);
  return { from: () => api } as unknown as SupabaseClient;
}

describe("0051 operator identity service", () => {
  it("maps an active operator by line_user_id", async () => {
    const svc = new GuidedMenuStateService(
      fakeClient({
        maybeSingle: () => ({
          data: {
            line_user_id: "U1",
            staff_label: "พี่ดำ",
            active: true,
          },
          error: null,
        }),
      }),
    );
    await expect(svc.resolveOperator("U1")).resolves.toEqual({
      status: "mapped",
      identity: {
        lineUserId: "U1",
        staffLabel: "พี่ดำ",
        active: true,
      },
    });
  });

  it("rejects unmapped and inactive operators without display-name fallback", async () => {
    const missing = new GuidedMenuStateService(
      fakeClient({ maybeSingle: () => ({ data: null, error: null }) }),
    );
    await expect(missing.resolveOperator("U-missing")).resolves.toEqual({
      status: "unmapped",
    });

    const inactive = new GuidedMenuStateService(
      fakeClient({
        maybeSingle: () => ({
          data: {
            line_user_id: "U2",
            staff_label: "Inactive",
            active: false,
          },
          error: null,
        }),
      }),
    );
    await expect(inactive.resolveOperator("U2")).resolves.toEqual({
      status: "unmapped",
    });

    // API accepts only lineUserId — no displayName fallback parameter exists.
    expect(svcArity()).toBe(1);
  });
});

function svcArity(): number {
  return GuidedMenuStateService.prototype.resolveOperator.length;
}
