import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { ProduceVoidError, voidProduceSession } from "./void";

interface FakeSession {
  id: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  replacement_session_id: string | null;
}

function makeFakeSupabase(sessions: FakeSession[]) {
  const database = {
    from(table: string) {
      if (table !== "produce_sessions") throw new Error(`unexpected table: ${table}`);
      return {
        update: (values: Partial<FakeSession>) => {
          const filters: Array<{ column: string; value: unknown; is?: boolean }> = [];
          const builder = {
            eq: (column: string, value: unknown) => {
              filters.push({ column, value });
              return builder;
            },
            is: (column: string, value: unknown) => {
              filters.push({ column, value, is: true });
              return builder;
            },
            select: () => ({
              maybeSingle: async () => {
                const found = sessions.find((s) =>
                  filters.every((f) => (s as unknown as Record<string, unknown>)[f.column] === f.value));
                if (!found) return { data: null, error: null };
                Object.assign(found, values);
                return { data: found, error: null };
              },
            }),
          };
          return builder;
        },
      };
    },
  };
  return database as unknown as SupabaseClient<Database>;
}

describe("voidProduceSession (BR-03)", () => {
  it("voids an active session, recording actor/timestamp/reason", async () => {
    const database = makeFakeSupabase([
      { id: "sess-1", voided_at: null, voided_by: null, void_reason: null, replacement_session_id: null },
    ]);

    const result = await voidProduceSession(database, {
      sessionId: "sess-1",
      actorId: "admin-1",
      reason: "duplicate submission",
    });

    expect(result.voidedBy).toBe("admin-1");
    expect(result.voidReason).toBe("duplicate submission");
    expect(result.voidedAt).toBeTruthy();
  });

  it("rejects an empty reason", async () => {
    const database = makeFakeSupabase([
      { id: "sess-1", voided_at: null, voided_by: null, void_reason: null, replacement_session_id: null },
    ]);
    await expect(
      voidProduceSession(database, { sessionId: "sess-1", actorId: "admin-1", reason: "  " }),
    ).rejects.toBeInstanceOf(ProduceVoidError);
  });

  it("rejects voiding an already-voided session (no silent re-void)", async () => {
    const database = makeFakeSupabase([
      {
        id: "sess-1",
        voided_at: "2026-07-01T00:00:00Z",
        voided_by: "admin-0",
        void_reason: "first void",
        replacement_session_id: null,
      },
    ]);
    await expect(
      voidProduceSession(database, { sessionId: "sess-1", actorId: "admin-1", reason: "second attempt" }),
    ).rejects.toBeInstanceOf(ProduceVoidError);
  });

  it("rejects a session id that does not exist", async () => {
    const database = makeFakeSupabase([]);
    await expect(
      voidProduceSession(database, { sessionId: "missing", actorId: "admin-1", reason: "x" }),
    ).rejects.toBeInstanceOf(ProduceVoidError);
  });

  it("hard delete is never performed — the session row remains present after void", async () => {
    const sessions: FakeSession[] = [
      { id: "sess-1", voided_at: null, voided_by: null, void_reason: null, replacement_session_id: null },
    ];
    const database = makeFakeSupabase(sessions);
    await voidProduceSession(database, { sessionId: "sess-1", actorId: "admin-1", reason: "correction" });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.voided_at).toBeTruthy();
  });
});
