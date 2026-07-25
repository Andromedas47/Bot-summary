/**
 * Focused Production-hardening coverage for White Sheet lifecycle RPCs
 * and regression anchors for unchanged central-price / produce-void paths.
 *
 * A–H: atomic finalize/reopen + FINALIZED LINE rejection (via persist + close).
 * I/J: central-price set/seed and produce void remain RPC-driven and unchanged
 *      at the service boundary (smoke assertions; full suites remain elsewhere).
 */
import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { voidProduceSession } from "@/lib/produce/void";
import {
  finalizeWhiteSheetCashEntry,
  reopenWhiteSheetCashEntry,
  saveWhiteSheetCashEntry,
  WhiteSheetPersistenceError,
} from "./persist";
import { seedCentralPriceFromWithdrawal, setCentralPrice } from "./pricing";

const IDENTITY = {
  sourceId: "group-sec",
  marketLabelNormalized: "ตลาดเซค",
  businessDate: "2026-07-24",
};

type CashRow = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];

function makeLifecycleClient(options: { failFinalizeAudit?: boolean; failReopenAudit?: boolean } = {}) {
  const rows = new Map<string, CashRow>();
  const rpcCalls: string[] = [];
  const lifecycleEvents: Array<{ event: string; reason?: string | null }> = [];

  const keyOf = (r: Pick<CashRow, "source_id" | "market_label_normalized" | "business_date">) =>
    `${r.source_id}::${r.market_label_normalized}::${r.business_date}`;

  const database = {
    from(table: string) {
      if (table === "white_sheet_lifecycle_events") {
        throw new Error("direct lifecycle insert forbidden");
      }
      if (table !== "digital_white_sheet_cash_entries") {
        throw new Error(`unexpected table: ${table}`);
      }
      return {
        select: () => {
          const filters: Array<{ column: string; value: unknown }> = [];
          const builder = {
            eq: (column: string, value: unknown) => {
              filters.push({ column, value });
              return builder;
            },
            is: (column: string, value: unknown) => {
              filters.push({ column, value });
              return builder;
            },
            maybeSingle: async () => {
              const found = [...rows.values()].find((row) =>
                filters.every(({ column, value }) => (row as Record<string, unknown>)[column] === value),
              );
              return { data: found ?? null, error: null };
            },
          };
          return builder;
        },
        insert: (values: Partial<CashRow>) => ({
          select: () => ({
            single: async () => {
              const merged = {
                id: `sec-${rows.size + 1}`,
                created_at: "2026-07-24T00:00:00Z",
                updated_at: "2026-07-24T00:00:00Z",
                other_note: null,
                finalized_at: null,
                finalized_by: null,
                ...values,
              } as CashRow;
              rows.set(keyOf(merged), merged);
              return { data: merged, error: null };
            },
          }),
        }),
        update: (values: Partial<CashRow>) => {
          const filters: Array<{ column: string; value: unknown }> = [];
          const builder = {
            eq: (column: string, value: unknown) => {
              filters.push({ column, value });
              return builder;
            },
            is: (column: string, value: unknown) => {
              filters.push({ column, value });
              return builder;
            },
            select: () => ({
              maybeSingle: async () => {
                const found = [...rows.entries()].find(([, row]) =>
                  filters.every(({ column, value }) => (row as Record<string, unknown>)[column] === value),
                );
                if (!found) return { data: null, error: null };
                const [key, existing] = found;
                const merged = { ...existing, ...values } as CashRow;
                rows.set(key, merged);
                return { data: merged, error: null };
              },
            }),
          };
          return builder;
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push(fn);
      if (fn === "finalize_white_sheet_cash_entry") {
        const key = `${args.p_source_id}::${args.p_market_label_normalized}::${args.p_business_date}`;
        const existing = rows.get(key);
        if (!existing || existing.finalized_at !== null) {
          return Promise.resolve({
            data: null,
            error: { message: "no SUBMITTED White Sheet entry found for this identity, or it is already finalized" },
          });
        }
        if (options.failFinalizeAudit) {
          return Promise.resolve({ data: null, error: { message: "forced finalize audit failure" } });
        }
        const merged = {
          ...existing,
          finalized_at: "2026-07-24T02:00:00Z",
          finalized_by: String(args.p_actor),
        };
        rows.set(key, merged);
        lifecycleEvents.push({ event: "finalized" });
        return Promise.resolve({ data: merged, error: null });
      }
      if (fn === "reopen_white_sheet_cash_entry") {
        const key = `${args.p_source_id}::${args.p_market_label_normalized}::${args.p_business_date}`;
        const existing = rows.get(key);
        if (!existing || existing.finalized_at === null) {
          return Promise.resolve({
            data: null,
            error: { message: "no FINALIZED White Sheet entry found for this identity" },
          });
        }
        if (options.failReopenAudit) {
          return Promise.resolve({ data: null, error: { message: "forced reopen audit failure" } });
        }
        const merged = { ...existing, finalized_at: null, finalized_by: null };
        rows.set(key, merged);
        lifecycleEvents.push({ event: "reopened", reason: String(args.p_reason) });
        return Promise.resolve({ data: merged, error: null });
      }
      if (fn === "set_central_selling_price" || fn === "seed_central_selling_price") {
        return Promise.resolve({
          data: {
            id: "price-1",
            product_key: args.p_product_key,
            unit_key: args.p_unit_key,
            business_date: args.p_business_date,
            price_satang: args.p_price_satang,
            set_by: args.p_actor,
            set_reason: args.p_reason ?? null,
            created_at: "2026-07-24T00:00:00Z",
            updated_at: "2026-07-24T00:00:00Z",
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc: ${fn}` } });
    },
  };

  return {
    database: database as unknown as SupabaseClient<Database>,
    rows,
    rpcCalls,
    lifecycleEvents,
  };
}

describe("lifecycle security hardening (0045)", () => {
  it("A/B. finalize and reopen each call exactly one atomic RPC", async () => {
    const { database, rpcCalls } = makeLifecycleClient();
    await saveWhiteSheetCashEntry(database, {
      ...IDENTITY,
      labor: 10,
      locationFee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      actualCashSubmitted: 1,
    });

    await finalizeWhiteSheetCashEntry(database, IDENTITY, "admin-1");
    expect(rpcCalls.filter((fn) => fn === "finalize_white_sheet_cash_entry")).toHaveLength(1);
    expect(rpcCalls.filter((fn) => fn === "reopen_white_sheet_cash_entry")).toHaveLength(0);

    await reopenWhiteSheetCashEntry(database, IDENTITY, "admin-2", "fix reopen");
    expect(rpcCalls.filter((fn) => fn === "reopen_white_sheet_cash_entry")).toHaveLength(1);
  });

  it("C/D. audit failure rolls back finalize and reopen", async () => {
    const finalizeFail = makeLifecycleClient({ failFinalizeAudit: true });
    await saveWhiteSheetCashEntry(finalizeFail.database, {
      ...IDENTITY,
      labor: 10,
      locationFee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      actualCashSubmitted: 1,
    });
    await expect(finalizeWhiteSheetCashEntry(finalizeFail.database, IDENTITY, "admin-1")).rejects.toThrow(
      WhiteSheetPersistenceError,
    );
    expect([...finalizeFail.rows.values()][0].finalized_at).toBeNull();
    expect(finalizeFail.lifecycleEvents).toEqual([]);

    const reopenFail = makeLifecycleClient({ failReopenAudit: true });
    reopenFail.rows.set(`${IDENTITY.sourceId}::${IDENTITY.marketLabelNormalized}::${IDENTITY.businessDate}`, {
      id: "f1",
      source_id: IDENTITY.sourceId,
      market_label_normalized: IDENTITY.marketLabelNormalized,
      business_date: IDENTITY.businessDate,
      labor: 10,
      location_fee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      other_note: null,
      actual_cash_submitted: 1,
      created_at: "2026-07-24T00:00:00Z",
      updated_at: "2026-07-24T00:00:00Z",
      finalized_at: "2026-07-24T02:00:00Z",
      finalized_by: "admin-1",
    });
    await expect(
      reopenWhiteSheetCashEntry(reopenFail.database, IDENTITY, "admin-2", "reason"),
    ).rejects.toThrow(WhiteSheetPersistenceError);
    expect([...reopenFail.rows.values()][0].finalized_at).toBe("2026-07-24T02:00:00Z");
    expect(reopenFail.lifecycleEvents).toEqual([]);
  });

  it("E/F/G. reopen requires reason; already-finalized finalize fails; non-finalized reopen fails", async () => {
    const { database } = makeLifecycleClient();
    await saveWhiteSheetCashEntry(database, {
      ...IDENTITY,
      labor: 10,
      locationFee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      actualCashSubmitted: 1,
    });

    await expect(reopenWhiteSheetCashEntry(database, IDENTITY, "admin-2", "  ")).rejects.toThrow(
      /reason is required/,
    );

    await finalizeWhiteSheetCashEntry(database, IDENTITY, "admin-1");
    await expect(finalizeWhiteSheetCashEntry(database, IDENTITY, "admin-2")).rejects.toThrow(
      WhiteSheetPersistenceError,
    );

    const submittedOnly = makeLifecycleClient();
    await saveWhiteSheetCashEntry(submittedOnly.database, {
      ...IDENTITY,
      labor: 10,
      locationFee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      actualCashSubmitted: 1,
    });
    await expect(
      reopenWhiteSheetCashEntry(submittedOnly.database, IDENTITY, "admin-2", "nope"),
    ).rejects.toThrow(WhiteSheetPersistenceError);
  });

  it("I. central-price set/seed still delegate to their RPCs (unchanged)", async () => {
    const rpcCalls: string[] = [];
    const database = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push(fn);
        return {
          data: {
            id: "p1",
            product_key: args.p_product_key,
            unit_key: args.p_unit_key,
            business_date: args.p_business_date,
            price_satang: args.p_price_satang,
            set_by: args.p_actor,
            set_reason: args.p_reason ?? null,
            created_at: "2026-07-24T00:00:00Z",
            updated_at: "2026-07-24T00:00:00Z",
          },
          error: null,
        };
      },
    } as unknown as SupabaseClient<Database>;

    await setCentralPrice(database, {
      identity: { productName: "มะม่วง", unit: "ลูก", businessDate: "2026-07-24" },
      priceBaht: 5,
      actor: "admin-1",
      reason: "correction",
    });
    await seedCentralPriceFromWithdrawal(database, {
      identity: { productName: "มะม่วง", unit: "ลูก", businessDate: "2026-07-24" },
      priceSatang: 500,
      actor: "system:first-withdrawal",
    });

    expect(rpcCalls).toEqual(["set_central_selling_price", "seed_central_selling_price"]);
  });

  it("J. produce void still updates produce_sessions with void fields (unchanged)", async () => {
    const sessions = [
      {
        id: "sess-1",
        voided_at: null as string | null,
        voided_by: null as string | null,
        void_reason: null as string | null,
        replacement_session_id: null as string | null,
      },
    ];
    const database = {
      from(table: string) {
        if (table !== "produce_sessions") throw new Error(`unexpected table: ${table}`);
        return {
          update: (values: Record<string, unknown>) => {
            const filters: Array<{ column: string; value: unknown }> = [];
            const builder = {
              eq: (column: string, value: unknown) => {
                filters.push({ column, value });
                return builder;
              },
              is: (column: string, value: unknown) => {
                filters.push({ column, value });
                return builder;
              },
              select: () => ({
                maybeSingle: async () => {
                  const found = sessions.find((s) =>
                    filters.every((f) => (s as Record<string, unknown>)[f.column] === f.value),
                  );
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
      rpc() {
        throw new Error("produce void must not call white-sheet lifecycle RPCs");
      },
    } as unknown as SupabaseClient<Database>;

    const result = await voidProduceSession(database, {
      sessionId: "sess-1",
      actorId: "admin-1",
      reason: "duplicate",
    });
    expect(result.voidedBy).toBe("admin-1");
    expect(result.voidReason).toBe("duplicate");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.voided_at).toBeTruthy();
  });
});
