import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchRemainingFruitRows } from "./remaining-fruit-data";

/**
 * Minimal supabase stub. produce_transactions always succeeds; the caller controls
 * whether produce_sessions/raw_messages (session-identity enrichment) succeed or fail,
 * to exercise the fail-open path.
 */
function makeSupabase({
  transactionRows,
  sessionsError = null,
  messagesError = null,
  tablesSeen,
}: {
  transactionRows: Array<Record<string, unknown>>;
  sessionsError?: { message: string } | null;
  messagesError?: { message: string } | null;
  tablesSeen?: string[];
}): SupabaseClient<Database> {
  return {
    from(table: string) {
      tablesSeen?.push(table);
      if (table === "produce_transactions") {
        return {
          select() {
            return {
              eq() {
                return {
                  in() {
                    return {
                      order() {
                        return {
                          range() {
                            return Promise.resolve({ data: transactionRows, error: null });
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === "produce_sessions") {
        return {
          select() {
            return {
              in() {
                if (sessionsError) return Promise.resolve({ data: null, error: sessionsError });
                return Promise.resolve({
                  data: [
                    { id: "session-1", raw_message_id: "raw-1", finalized_at: null, created_at: "2026-07-01T14:00:00.000Z" },
                  ],
                  error: null,
                });
              },
            };
          },
        };
      }

      if (table === "raw_messages") {
        return {
          select() {
            return {
              in() {
                if (messagesError) return Promise.resolve({ data: null, error: messagesError });
                return Promise.resolve({
                  data: [{ id: "raw-1", source_id: "Csource-1" }],
                  error: null,
                });
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

describe("fetchRemainingFruitRows enrichment", () => {
  test("uses the active, void-filtered produce view and never the audit-only superset", async () => {
    const tablesSeen: string[] = [];
    const supabase = makeSupabase({ transactionRows: [], tablesSeen });

    await fetchRemainingFruitRows(supabase, "2026-07-01");

    expect(tablesSeen).toEqual(["produce_transactions"]);
    expect(tablesSeen).not.toContain("produce_transactions_all");
  });

  test("attaches source_id/session_time when enrichment succeeds", async () => {
    const supabase = makeSupabase({
      transactionRows: [
        {
          market_name: "ตลาดกี้",
          product_name: "แตงโม",
          quantity: 10,
          unit: "ลูก",
          transaction_type: "คืน",
          session_id: "session-1",
          sender_name: null,
        },
      ],
    });

    const rows = await fetchRemainingFruitRows(supabase, "2026-07-01");

    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe("Csource-1");
    expect(rows[0].session_time).toBe("2026-07-01T14:00:00.000Z");
  });

  test("fails open when produce_sessions lookup errors: report data still returns, without dedupe metadata", async () => {
    const supabase = makeSupabase({
      transactionRows: [
        {
          market_name: "ตลาดกี้",
          product_name: "แตงโม",
          quantity: 10,
          unit: "ลูก",
          transaction_type: "คืน",
          session_id: "session-1",
          sender_name: null,
        },
      ],
      sessionsError: { message: "boom" },
    });

    const rows = await fetchRemainingFruitRows(supabase, "2026-07-01");

    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBeUndefined();
    expect(rows[0].session_time).toBeUndefined();
  });

  test("fails open when raw_messages lookup errors: report data still returns, without source_id", async () => {
    const supabase = makeSupabase({
      transactionRows: [
        {
          market_name: "ตลาดกี้",
          product_name: "แตงโม",
          quantity: 10,
          unit: "ลูก",
          transaction_type: "คืน",
          session_id: "session-1",
          sender_name: null,
        },
      ],
      messagesError: { message: "boom" },
    });

    const rows = await fetchRemainingFruitRows(supabase, "2026-07-01");

    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBeUndefined();
  });
});
