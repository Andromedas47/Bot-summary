import { describe, expect, test } from "bun:test";
import { purchaseCaptureActor, purchaseCaptureConfirmationKey } from "./confirm-flow";
import {
  recoverPostedSuccessDeliveries,
  recoverStuckConfirmingSessions,
} from "./confirmation-recovery";
import { listUndeliveredNotificationWork } from "./finalizer";

const RECEIPT_ID = "33333333-3333-4333-8333-333333333333";
const MOVEMENT_ID = "44444444-4444-4444-8444-444444444444";
const ITEM_ID = "55555555-5555-4555-8555-555555555555";
const HASH = "a".repeat(64);
const SOURCE_ID = "U-source";
const SENDER_ID = "U-sender";

type RpcResult = { data: unknown; error: { message: string } | null };
type RpcHandler = (args: Record<string, unknown>) => RpcResult;

type NotificationRow = {
  session_id: string;
  notification_kind: string;
  notification_version: string;
  delivery_status: string;
  claim_expires_at: string | null;
};

function buildSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "session-1",
    source_type: "user",
    source_id: SOURCE_ID,
    sender_line_user_id: SENDER_ID,
    opened_line_event_id: "event-1",
    session_generation: "generation-1",
    status: "confirming",
    close_event_timestamp_ms: null,
    close_quiet_until: null,
    close_deadline_at: null,
    ingest_revision: 1,
    receipt_id: RECEIPT_ID,
    draft_revision: 3,
    movement_id: null,
    fail_reason: null,
    warnings: [],
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildPayload(): Record<string, unknown> {
  return {
    contract_version: "p2b-purchase-confirm-v1",
    receipt_id: RECEIPT_ID,
    document_namespace: "line-text",
    document_key: "doc-key-1",
    parser_contract_version: "p2a-v1",
    source: {
      source_type: "user",
      source_id: SOURCE_ID,
      sender_line_user_id: SENDER_ID,
      source_line_event_id: "event-1",
      source_raw_message_id: null,
      source_evidence: {},
    },
    business_date: "2026-08-01",
    purchase_time: null,
    supplier_key: null,
    supplier_raw: "ร้านผัก",
    supplier_ref: null,
    reference_text: null,
    intended_warehouse_code: "MAIN",
    vat_kind: "NONE",
    vat_included_in_item_prices: null,
    vat_recoverable: null,
    item_count: 1,
    items: [
      {
        receipt_item_id: ITEM_ID,
        item_ordinal: 1,
        item_number: null,
        product_key: "pk-lemon",
        raw_product_text: "มะนาว",
        product_identity_status: "RESOLVED",
        quantity: "10",
        unit_key: "kg",
        raw_unit: "กก.",
        unit_identity_status: "RESOLVED",
        unit_cost: "20",
        price_unit_text: null,
        price_unit_status: "NOT_APPLICABLE",
        line_amount_satang: "2000",
        source_evidence: {},
      },
    ],
    totals: {
      line_subtotal_satang: "2000",
      freight_satang: "0",
      handling_satang: "0",
      discount_satang: "0",
      vat_satang: null,
      payable_total_satang: "2000",
      declared_total_satang: null,
      reconciliation_status: "COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE",
    },
    blockers: [],
    has_blocking_blockers: false,
    posts_inventory_movement: false,
    posts_valuation: false,
  };
}

function buildConfirmationRpcResponse(confirmationKey: string, replayed = false): Record<string, unknown> {
  return {
    receipt_id: RECEIPT_ID,
    confirmation: {
      contract_version: "p2b-purchase-confirm-v1",
      canonical_form: "purchase-receipt-canonical-json-v1",
      hash_algorithm: "sha256",
      hash: HASH,
      confirmation_key: confirmationKey,
      confirmed_at: "2026-08-01T00:00:00.000Z",
      confirmed_by: purchaseCaptureActor(SENDER_ID),
      payload: buildPayload(),
    },
    lifecycle: { status: "confirmed", posting_locked_at: null, posting_locked_by: null },
    void: null,
    correction: { supersedes_receipt_id: null, superseded_by_receipt_id: null },
    p2c_dedupe_key: `purchase-receipt-confirmation:v1:${RECEIPT_ID}:${HASH}`,
    replayed,
  };
}

function buildPostingRpcResponse(replayed = false): Record<string, unknown> {
  return {
    movement_id: MOVEMENT_ID,
    receipt_id: RECEIPT_ID,
    dedupe_key: `purchase-receipt-confirmation:v1:${RECEIPT_ID}:${HASH}`,
    line_count: 1,
    replayed,
    reversed_by_movement_id: null,
    posting_locked_at: "2026-08-01T00:00:00.000Z",
    posting_locked_by: "p2c-inventory-ledger",
  };
}

const confirmSuccessHandler: RpcHandler = (args) => ({
  data: buildConfirmationRpcResponse(String(args.p_confirmation_key)),
  error: null,
});

const postSuccessHandler: RpcHandler = () => ({
  data: buildPostingRpcResponse(),
  error: null,
});

const completeSuccessHandler: RpcHandler = (args) => ({
  data: {
    ok: true,
    idempotent: false,
    session_id: args.p_session_id,
    status: "posted",
    movement_id: args.p_movement_id,
    notification: { created: true },
  },
  error: null,
});

const noopClaimHandler: RpcHandler = () => ({
  data: { claimed: false, reason: "nothing_eligible" },
  error: null,
});

function makeClaimOnceHandler(): RpcHandler {
  let claimed = false;
  return () => {
    if (claimed) return { data: { claimed: false, reason: "nothing_eligible" }, error: null };
    claimed = true;
    return {
      data: {
        claimed: true,
        id: "part-1",
        part_index: 0,
        part_count: 1,
        retry_key: "retry-1",
        payload_text: "text-1",
        claim_token: "token-1",
      },
      error: null,
    };
  };
}

function errorHandler(message: string): RpcHandler {
  return () => ({ data: null, error: { message } });
}

const noopPush = async () => ({ status: "delivered" as const });

/**
 * A single fake supabase client shared by every test in this file.
 *
 * `sessions` is the one source of truth for every purchase_capture_sessions
 * query shape this module (and confirm-flow.ts, which it delegates to) uses:
 *  - the discovery query (`select("*").eq("status","confirming").lt(...)
 *    .order(...).limit(n)`) resolved by `.limit()`,
 *  - `getSession(id)` (`select("*").eq("id", id).maybeSingle()`) resolved by
 *    `.maybeSingle()`,
 *  - listUndeliveredNotificationWork's narrow session lookup
 *    (`select("id, source_id, status").in("id", ids).in("status", [...])`,
 *    or the pre-fix `.eq("status", "awaiting_confirmation")`), resolved via
 *    the object's own `.then()` so `await` works after either filter shape.
 *
 * `notifications` backs the purchase_capture_notifications query used by
 * listUndeliveredNotificationWork.
 */
function makeSupabase(options: {
  sessions: Record<string, Record<string, unknown>>;
  notifications?: NotificationRow[];
  handlers?: Record<string, RpcHandler>;
  callLog?: string[];
}) {
  const callLog = options.callLog ?? [];
  return {
    from(table: string) {
      if (table === "purchase_capture_sessions") {
        const eqFilters: Record<string, unknown> = {};
        const ltFilters: Record<string, unknown> = {};
        const inFilters: Record<string, unknown[]> = {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api: any = {
          select: () => api,
          eq: (col: string, val: unknown) => {
            eqFilters[col] = val;
            return api;
          },
          lt: (col: string, val: unknown) => {
            ltFilters[col] = val;
            return api;
          },
          in: (col: string, vals: unknown[]) => {
            inFilters[col] = vals;
            return api;
          },
          order: () => api,
          // Discovery query terminal: select("*")...limit(n).
          limit: async (n: number) => {
            let rows = Object.values(options.sessions);
            for (const [col, val] of Object.entries(eqFilters)) {
              rows = rows.filter((row) => row[col] === val);
            }
            for (const [col, val] of Object.entries(ltFilters)) {
              rows = rows.filter((row) => String(row[col]) < String(val));
            }
            rows = [...rows].sort((a, b) =>
              String(a.updated_at).localeCompare(String(b.updated_at)));
            return { data: rows.slice(0, n), error: null };
          },
          // getSession(id) terminal: select("*").eq("id", id).maybeSingle().
          maybeSingle: async () => {
            const id = eqFilters.id as string | undefined;
            return { data: id != null ? (options.sessions[id] ?? null) : null, error: null };
          },
          // listUndeliveredNotificationWork's narrow session lookup terminal —
          // works whether the caller ends on .eq(...) (pre-fix) or .in(...)
          // (post-fix), since either way `await` invokes this .then().
          then: (
            resolve: (value: { data: unknown[]; error: null }) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => {
            const ids = (inFilters.id as string[] | undefined) ?? Object.keys(options.sessions);
            let rows = ids
              .map((id) => options.sessions[id])
              .filter((row): row is Record<string, unknown> => row != null);
            for (const [col, val] of Object.entries(eqFilters)) {
              rows = rows.filter((row) => row[col] === val);
            }
            for (const [col, vals] of Object.entries(inFilters)) {
              if (col === "id") continue;
              rows = rows.filter((row) => (vals as unknown[]).includes(row[col]));
            }
            const mapped = rows.map((row) => ({
              id: row.id,
              source_id: row.source_id,
              status: row.status,
            }));
            return Promise.resolve({ data: mapped, error: null }).then(resolve, reject);
          },
        };
        return api;
      }
      if (table === "purchase_capture_notifications") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api: any = {};
        api.select = () => api;
        api.neq = () => api;
        api.order = () => api;
        api.limit = async () => ({ data: options.notifications ?? [], error: null });
        return api;
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      callLog.push(name);
      const handler = (options.handlers ?? {})[name];
      if (!handler) throw new Error(`unexpected rpc ${name}`);
      return Promise.resolve(handler(args));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("recoverStuckConfirmingSessions", () => {
  test("no confirming sessions -> due 0, nothing called", async () => {
    const callLog: string[] = [];
    const supabase = makeSupabase({ sessions: {}, callLog });

    const result = await recoverStuckConfirmingSessions(supabase, noopPush);

    expect(result).toEqual({ due: 0, resumed: 0, refused: 0, errors: 0 });
    expect(callLog).toEqual([]);
  });

  test("a confirming session newer than the quiet threshold is not picked up", async () => {
    const callLog: string[] = [];
    const recent = new Date().toISOString();
    const supabase = makeSupabase({
      sessions: { s1: buildSession({ id: "s1", status: "confirming", updated_at: recent }) },
      callLog,
    });

    const result = await recoverStuckConfirmingSessions(supabase, noopPush);

    expect(result).toEqual({ due: 0, resumed: 0, refused: 0, errors: 0 });
    expect(callLog).toEqual([]);
  });

  test("a confirming session older than the threshold is resumed exactly once", async () => {
    const callLog: string[] = [];
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    const supabase = makeSupabase({
      sessions: { s1: buildSession({ id: "s1", status: "confirming", updated_at: old }) },
      callLog,
      handlers: {
        confirm_purchase_receipt: confirmSuccessHandler,
        post_purchase_receipt_inventory_movement: postSuccessHandler,
        complete_purchase_capture_posting: completeSuccessHandler,
        claim_next_purchase_capture_notification_part: noopClaimHandler,
      },
    });

    const result = await recoverStuckConfirmingSessions(supabase, noopPush);

    expect(result).toEqual({ due: 1, resumed: 1, refused: 0, errors: 0 });
    expect(callLog.filter((n) => n === "confirm_purchase_receipt")).toHaveLength(1);
    expect(callLog.filter((n) => n === "complete_purchase_capture_posting")).toHaveLength(1);
  });

  test("begin_purchase_capture_confirmation is never invoked by the recovery path", async () => {
    const callLog: string[] = [];
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    const supabase = makeSupabase({
      sessions: { s1: buildSession({ id: "s1", status: "confirming", updated_at: old }) },
      callLog,
      handlers: {
        confirm_purchase_receipt: confirmSuccessHandler,
        post_purchase_receipt_inventory_movement: postSuccessHandler,
        complete_purchase_capture_posting: completeSuccessHandler,
        claim_next_purchase_capture_notification_part: noopClaimHandler,
        // Deliberately no begin_purchase_capture_confirmation handler: if the
        // recovery path ever reached it, the fake rpc() would throw
        // "unexpected rpc begin_purchase_capture_confirmation" and this test
        // would fail with an error instead of a clean assertion.
      },
    });

    await recoverStuckConfirmingSessions(supabase, noopPush);

    expect(callLog).not.toContain("begin_purchase_capture_confirmation");
  });

  test('resume returning "refused" increments refused (not errors) and does not abort the loop', async () => {
    const old1 = new Date(Date.now() - 5 * 60_000).toISOString();
    const old2 = new Date(Date.now() - 6 * 60_000).toISOString();
    const supabase = makeSupabase({
      sessions: {
        s1: buildSession({ id: "s1", status: "confirming", updated_at: old1, opened_line_event_id: "event-1" }),
        s2: buildSession({ id: "s2", status: "confirming", updated_at: old2, opened_line_event_id: "event-2" }),
      },
      handlers: {
        confirm_purchase_receipt: (args) => {
          const key = String(args.p_confirmation_key);
          if (key === purchaseCaptureConfirmationKey("event-1")) {
            return { data: null, error: { message: "receipt cannot be confirmed" } };
          }
          return confirmSuccessHandler(args);
        },
        post_purchase_receipt_inventory_movement: postSuccessHandler,
        complete_purchase_capture_posting: completeSuccessHandler,
        claim_next_purchase_capture_notification_part: noopClaimHandler,
      },
    });

    const result = await recoverStuckConfirmingSessions(supabase, noopPush, 25);

    expect(result.due).toBe(2);
    expect(result.refused).toBe(1);
    expect(result.resumed).toBe(1);
    expect(result.errors).toBe(0);
  });

  test("a thrown/unmapped error on one session increments errors and the next session is still processed", async () => {
    const old1 = new Date(Date.now() - 5 * 60_000).toISOString();
    const old2 = new Date(Date.now() - 6 * 60_000).toISOString();
    const supabase = makeSupabase({
      sessions: {
        s1: buildSession({ id: "s1", status: "confirming", updated_at: old1, opened_line_event_id: "event-1" }),
        s2: buildSession({ id: "s2", status: "confirming", updated_at: old2, opened_line_event_id: "event-2" }),
      },
      handlers: {
        confirm_purchase_receipt: (args) => {
          const key = String(args.p_confirmation_key);
          if (key === purchaseCaptureConfirmationKey("event-1")) {
            // An unrecognised message: mapErrorToFailureCode returns null, so
            // confirm-flow rethrows it as a genuine infrastructure error.
            return errorHandler("totally_unexpected_infrastructure_boom")(args);
          }
          return confirmSuccessHandler(args);
        },
        post_purchase_receipt_inventory_movement: postSuccessHandler,
        complete_purchase_capture_posting: completeSuccessHandler,
        claim_next_purchase_capture_notification_part: noopClaimHandler,
      },
    });

    const result = await recoverStuckConfirmingSessions(supabase, noopPush, 25);

    expect(result.due).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.refused).toBe(0);
    expect(result.resumed).toBe(1);
  });
});

describe("recoverPostedSuccessDeliveries", () => {
  test("drains a posted session's undelivered posted_success parts", async () => {
    const supabase = makeSupabase({
      sessions: {
        s1: buildSession({ id: "s1", status: "posted", movement_id: MOVEMENT_ID, receipt_id: RECEIPT_ID }),
      },
      notifications: [
        {
          session_id: "s1",
          notification_kind: "posted_success",
          notification_version: MOVEMENT_ID,
          delivery_status: "pending",
          claim_expires_at: null,
        },
      ],
      handlers: {
        claim_next_purchase_capture_notification_part: makeClaimOnceHandler(),
        mark_purchase_capture_notification_part_delivered: () => ({ data: {}, error: null }),
      },
    });

    const result = await recoverPostedSuccessDeliveries(supabase, noopPush);

    expect(result).toEqual({ due: 1, delivered: 1, errors: 0 });
  });

  test("a posted session whose parts are all delivered yields due 0", async () => {
    const supabase = makeSupabase({
      sessions: {
        s1: buildSession({ id: "s1", status: "posted", movement_id: MOVEMENT_ID, receipt_id: RECEIPT_ID }),
      },
      notifications: [
        {
          session_id: "s1",
          notification_kind: "posted_success",
          notification_version: MOVEMENT_ID,
          delivery_status: "delivered",
          claim_expires_at: null,
        },
      ],
    });

    const result = await recoverPostedSuccessDeliveries(supabase, noopPush);

    expect(result).toEqual({ due: 0, delivered: 0, errors: 0 });
  });

  test("no time-based cutoff: an old undelivered posted_success part is still returned and drained", async () => {
    // listUndeliveredNotificationWork never selects or filters on created_at
    // (or any other age column) — ordering by it is the only place it
    // appears — so there is no "stale work is abandoned" behaviour to
    // accidentally reintroduce here.
    const supabase = makeSupabase({
      sessions: {
        s1: buildSession({ id: "s1", status: "posted", movement_id: MOVEMENT_ID, receipt_id: RECEIPT_ID }),
      },
      notifications: [
        {
          session_id: "s1",
          notification_kind: "posted_success",
          notification_version: MOVEMENT_ID,
          delivery_status: "pending",
          claim_expires_at: null,
        },
      ],
      handlers: {
        claim_next_purchase_capture_notification_part: makeClaimOnceHandler(),
        mark_purchase_capture_notification_part_delivered: () => ({ data: {}, error: null }),
      },
    });

    const result = await recoverPostedSuccessDeliveries(supabase, noopPush);

    expect(result.due).toBe(1);
    expect(result.delivered).toBe(1);
  });
});

describe("listUndeliveredNotificationWork (STEP 1 regression)", () => {
  test("returns posted_success work for a 'posted' session", async () => {
    const supabase = makeSupabase({
      sessions: {
        s1: buildSession({ id: "s1", status: "posted", movement_id: MOVEMENT_ID, receipt_id: RECEIPT_ID }),
      },
      notifications: [
        {
          session_id: "s1",
          notification_kind: "posted_success",
          notification_version: MOVEMENT_ID,
          delivery_status: "pending",
          claim_expires_at: null,
        },
      ],
    });

    const work = await listUndeliveredNotificationWork(supabase, 10);

    expect(work).toHaveLength(1);
    expect(work[0]?.sessionId).toBe("s1");
    expect(work[0]?.notificationKind).toBe("posted_success");
    // This assertion is the STEP 1 regression check: against the pre-fix
    // `.eq("status", "awaiting_confirmation")` filter, a "posted" session is
    // excluded and `work` comes back empty — verified by temporarily
    // reverting the finalizer.ts fix and re-running this file (see report).
  });
});
