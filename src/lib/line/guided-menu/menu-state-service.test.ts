import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GuidedMenuStateService,
  validateMenuPayload,
  validateMenuPayloadForAction,
} from "./menu-state-service";

function fakeClient(handlers: {
  maybeSingle?: () => { data: unknown; error: null | { message: string } };
  rpc?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: null | { message: string } }>;
}): SupabaseClient {
  const api = {
    from: () => api,
    select: () => api,
    eq: () => api,
    order: () => api,
    maybeSingle: async () =>
      handlers.maybeSingle?.() ?? { data: null, error: null },
  };
  return {
    from: () => api,
    rpc: handlers.rpc ?? (async () => ({ data: null, error: null })),
  } as unknown as SupabaseClient;
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

    expect(GuidedMenuStateService.prototype.resolveOperator.length).toBe(1);
  });
});

describe("0051 action-specific payload validation", () => {
  it("accepts exact schemas and rejects unknown/missing keys", () => {
    expect(validateMenuPayloadForAction("menu_root", {})).toEqual({});
    expect(
      validateMenuPayloadForAction("menu_root", { intent: "cancel" }),
    ).toEqual({ intent: "cancel" });
    expect(() =>
      validateMenuPayloadForAction("menu_root", { intent: "nope" } as never),
    ).toThrow();

    expect(
      validateMenuPayloadForAction("choose_transaction_type", {
        transaction_type: "withdraw",
      }),
    ).toEqual({ transaction_type: "withdraw" });
    expect(() =>
      validateMenuPayloadForAction("choose_transaction_type", {
        transaction_type: "withdraw",
        market_code: "kee",
      } as never),
    ).toThrow(/keys/);

    expect(
      validateMenuPayloadForAction("choose_market", {
        transaction_type: "return",
        market_code: "kee",
      }),
    ).toEqual({ transaction_type: "return", market_code: "kee" });

    expect(
      validateMenuPayloadForAction("choose_date", {
        transaction_type: "withdraw",
        market_code: "kee",
        date_mode: "today",
      }),
    ).toMatchObject({ date_mode: "today" });

    expect(
      validateMenuPayloadForAction("confirm_open", {
        transaction_type: "withdraw",
        market_code: "kee",
        date_mode: "iso",
        iso_date: "2026-07-29",
      }),
    ).toMatchObject({ iso_date: "2026-07-29" });

    expect(() =>
      validateMenuPayloadForAction("confirm_open", {
        transaction_type: "withdraw",
        market_code: "kee",
        date_mode: "iso",
        iso_date: "2026-13-99",
      } as never),
    ).toThrow(/iso_date/);

    expect(validateMenuPayloadForAction("view_status", {})).toEqual({});
    expect(() =>
      validateMenuPayload({ step: "cancel" } as never),
    ).toThrow(/step/);
    expect(() =>
      validateMenuPayload({ staff_label: "x" } as never),
    ).toThrow(/trusted display labels/);
  });

  it("createState uses create_line_menu_state RPC without app-chosen expiry", async () => {
    let rpcArgs: Record<string, unknown> | null = null;
    const svc = new GuidedMenuStateService(
      fakeClient({
        rpc: async (name, args) => {
          expect(name).toBe("create_line_menu_state");
          rpcArgs = args;
          return {
            data: {
              status: "created",
              action_type: "menu_root",
              created_at: "2026-07-29T03:00:00.000Z",
              expires_at: "2026-07-29T03:30:00.000Z",
            },
            error: null,
          };
        },
      }),
    );

    const created = await svc.createState({
      actionType: "menu_root",
      lineUserId: "U1",
      sourceType: "user",
      sourceId: "U1",
      sessionKey: null,
      payload: {},
    });

    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("expected created");
    expect(created.wireToken.startsWith("gpm1:")).toBe(true);
    expect(created.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.expiresAt).toBe("2026-07-29T03:30:00.000Z");
    expect(rpcArgs).not.toBeNull();
    expect(rpcArgs).not.toHaveProperty("p_expires_at");
    expect(rpcArgs).not.toHaveProperty("p_created_at");
    expect(rpcArgs!.p_token_hash).toBe(created.tokenHash);
  });

  it("maps already_consumed without action/payload/result disclosure", async () => {
    const svc = new GuidedMenuStateService(
      fakeClient({
        rpc: async () => ({
          data: { status: "already_consumed" },
          error: null,
        }),
      }),
    );
    // Need a valid wire token — create one via create path first is hard;
    // parse fails → invalid. Use real encode from crypto.
    const { encodeMenuToken, generateRawMenuToken, hashMenuToken } =
      await import("./menu-token");
    const { randomBytes } = await import("crypto");
    const raw = generateRawMenuToken(randomBytes);
    const wire = encodeMenuToken(raw);
    void hashMenuToken;

    const outcome = await svc.consumeState({
      wireToken: wire,
      lineEventId: "evt-2",
      lineUserId: "U1",
      sourceType: "user",
      sourceId: "U1",
      sessionKey: null,
    });
    expect(outcome).toEqual({ status: "already_consumed" });
    expect(outcome).not.toHaveProperty("actionType");
    expect(outcome).not.toHaveProperty("payload");
    expect(outcome).not.toHaveProperty("result");
  });

  it("recordResult sends full binding fields", async () => {
    const { encodeMenuToken, generateRawMenuToken } = await import("./menu-token");
    const { randomBytes } = await import("crypto");
    const wire = encodeMenuToken(generateRawMenuToken(randomBytes));
    let rpcArgs: Record<string, unknown> | null = null;
    const svc = new GuidedMenuStateService(
      fakeClient({
        rpc: async (name, args) => {
          expect(name).toBe("record_line_menu_state_result");
          rpcArgs = args;
          return {
            data: { status: "recorded", result: { ok: true } },
            error: null,
          };
        },
      }),
    );

    const outcome = await svc.recordResult({
      wireToken: wire,
      consumedLineEventId: "evt-1",
      lineUserId: "U1",
      sourceType: "group",
      sourceId: "G1",
      sessionKey: "group:G1:user:U1",
      result: { ok: true },
    });
    expect(outcome).toEqual({ status: "recorded", result: { ok: true } });
    expect(rpcArgs).toMatchObject({
      p_line_user_id: "U1",
      p_source_type: "group",
      p_source_id: "G1",
      p_session_key: "group:G1:user:U1",
      p_consumed_line_event_id: "evt-1",
    });
  });
});
