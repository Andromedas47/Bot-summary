import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ManualWhiteSheetNoteSessionRow } from "@/types/database";
import { saveManualWhiteSheetEntryFromLine } from "./white-sheet-note-canonical-save";
import { WhiteSheetPersistenceError } from "@/lib/white-sheet/persist";

type Supabase = SupabaseClient<Database>;
type Row = Record<string, unknown>;

function makeSupabase(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let idSeq = 0;

  function filterChain(filtered: Row[]) {
    return {
      eq(col: string, val: unknown) { return filterChain(filtered.filter((r) => r[col] === val)); },
      async maybeSingle() { return { data: filtered[0] ?? null, error: null }; },
    };
  }

  const supabase = {
    from(table: string) {
      if (table !== "digital_white_sheet_cash_entries") {
        throw new Error(`unexpected table access: ${table}`);
      }
      return {
        select(_cols = "*") { return filterChain(rows); },
        insert(payload: Row) {
          return {
            select(_cols = "*") {
              return {
                async single() {
                  const row: Row = { id: `cash-${++idSeq}`, finalized_at: null, finalized_by: null, ...payload };
                  rows.push(row);
                  return { data: row, error: null };
                },
              };
            },
          };
        },
        update(patch: Row) {
          return {
            eq(col: string, val: unknown) {
              return {
                is(col2: string, val2: unknown) {
                  const matched = rows.filter(
                    (r) => r[col] === val && (val2 === null ? r[col2] === null : r[col2] === val2),
                  );
                  return {
                    select(_cols = "*") {
                      return {
                        async maybeSingle() {
                          if (matched.length === 0) return { data: null, error: null };
                          Object.assign(matched[0], patch);
                          return { data: matched[0], error: null };
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
    },
  } as unknown as Supabase;

  return { supabase, rows };
}

function makeSession(overrides: Partial<ManualWhiteSheetNoteSessionRow> = {}): ManualWhiteSheetNoteSessionRow {
  return {
    id: "note-1",
    source_id: "src-1",
    market_label: "พาชิโอ้",
    market_label_normalized: "พาชิโอ้",
    business_date: "2026-08-01",
    status: "open",
    labor: null,
    location_fee: null,
    bag: null,
    snack: null,
    other_amount: null,
    other_note: null,
    actual_cash: null,
    opened_by_line_user_id: null,
    opened_line_event_id: "ev1",
    closed_by_line_user_id: null,
    closed_line_event_id: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    closed_at: null,
    ...overrides,
  };
}

describe("saveManualWhiteSheetEntryFromLine", () => {
  it("inserts a new canonical row, defaulting untouched fields to 0", async () => {
    const { supabase, rows } = makeSupabase();
    const state = await saveManualWhiteSheetEntryFromLine(
      supabase,
      makeSession({ labor: 500, actual_cash: 4850 }),
    );

    expect(state.status).toBe("submitted");
    expect(rows).toHaveLength(1);
    expect(rows[0].labor).toBe(500);
    expect(rows[0].location_fee).toBe(0);
    expect(rows[0].actual_cash_submitted).toBe(4850);
  });

  it("updates the same identity instead of creating a duplicate", async () => {
    const { supabase, rows } = makeSupabase();
    await saveManualWhiteSheetEntryFromLine(supabase, makeSession({ labor: 500, actual_cash: 100 }));
    await saveManualWhiteSheetEntryFromLine(supabase, makeSession({ labor: 700, actual_cash: 200 }));

    expect(rows).toHaveLength(1);
    expect(rows[0].labor).toBe(700);
    expect(rows[0].actual_cash_submitted).toBe(200);
  });

  it("preserves existing canonical values for fields the session never entered", async () => {
    const { supabase, rows } = makeSupabase([
      {
        id: "seed",
        source_id: "src-1",
        market_label_normalized: "พาชิโอ้",
        business_date: "2026-08-01",
        labor: 999, location_fee: 200, bag: 100, snack: 50, other: 30, other_note: "เดิม",
        actual_cash_submitted: 4850,
        finalized_at: null, finalized_by: null,
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    ]);

    await saveManualWhiteSheetEntryFromLine(supabase, makeSession({ labor: 0 }));

    expect(rows[0].labor).toBe(0); // explicit zero applied
    expect(rows[0].location_fee).toBe(200); // untouched, preserved
    expect(rows[0].actual_cash_submitted).toBe(4850); // untouched, preserved
  });

  it("rejects an update when the existing row is FINALIZED", async () => {
    const { supabase, rows } = makeSupabase([
      {
        id: "seed",
        source_id: "src-1",
        market_label_normalized: "พาชิโอ้",
        business_date: "2026-08-01",
        labor: 500, location_fee: 200, bag: 100, snack: 50, other: 30, other_note: null,
        actual_cash_submitted: 4850,
        finalized_at: "2026-07-31T00:00:00.000Z", finalized_by: "admin-1",
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    ]);

    await expect(
      saveManualWhiteSheetEntryFromLine(supabase, makeSession({ labor: 700 })),
    ).rejects.toBeInstanceOf(WhiteSheetPersistenceError);
    expect(rows[0].labor).toBe(500); // untouched
  });

  it("never touches any table other than digital_white_sheet_cash_entries", async () => {
    // makeSupabase's from() throws on any other table name — reaching the
    // assertions below proves no produce/slip/settlement table was read.
    const { supabase } = makeSupabase();
    await expect(
      saveManualWhiteSheetEntryFromLine(supabase, makeSession({ labor: 500, actual_cash: 100 })),
    ).resolves.toBeDefined();
  });
});
