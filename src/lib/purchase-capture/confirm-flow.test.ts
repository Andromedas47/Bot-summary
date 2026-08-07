import { describe, expect, test } from "bun:test";
import {
  confirmPurchaseCaptureFromLine,
  purchaseCaptureActor,
  purchaseCaptureConfirmationKey,
  resumePurchaseCaptureConfirmation,
  runPurchaseCaptureConfirmation,
  type PurchaseCaptureConfirmFailureCode,
  type PurchaseCaptureConfirmResult,
} from "./confirm-flow";
import {
  renderPurchaseCapturePostedSuccessPayloadTexts,
  renderPurchaseCapturePostedSuccessText,
} from "./posted-success";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const GENERATION = "22222222-2222-4222-8222-222222222222";
const RECEIPT_ID = "33333333-3333-4333-8333-333333333333";
const MOVEMENT_ID = "44444444-4444-4444-8444-444444444444";
const ITEM_ID = "55555555-5555-4555-8555-555555555555";
const HASH = "a".repeat(64);
const SOURCE_ID = "U-source";
const SENDER_ID = "U-sender";
const OPENED_EVENT_ID = "event-1";

type RpcResult = { data: unknown; error: { message: string } | null };
type RpcHandler = (args: Record<string, unknown>) => RpcResult;

function buildSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    source_type: "user",
    source_id: SOURCE_ID,
    sender_line_user_id: SENDER_ID,
    opened_line_event_id: OPENED_EVENT_ID,
    session_generation: GENERATION,
    status: "awaiting_confirmation",
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
      source_line_event_id: OPENED_EVENT_ID,
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

function buildConfirmationRpcResponse(replayed = false): Record<string, unknown> {
  return {
    receipt_id: RECEIPT_ID,
    confirmation: {
      contract_version: "p2b-purchase-confirm-v1",
      canonical_form: "purchase-receipt-canonical-json-v1",
      hash_algorithm: "sha256",
      hash: HASH,
      confirmation_key: purchaseCaptureConfirmationKey(OPENED_EVENT_ID),
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

const beginSuccessHandler: RpcHandler = (args) => ({
  data: {
    ok: true,
    idempotent: false,
    session_id: args.p_session_id,
    status: "confirming",
    receipt_id: args.p_expected_receipt_id,
    draft_revision: String(args.p_expected_draft_revision),
  },
  error: null,
});

const confirmSuccessHandler: RpcHandler = () => ({
  data: buildConfirmationRpcResponse(),
  error: null,
});

const getConfirmationSuccessHandler: RpcHandler = () => ({
  data: buildConfirmationRpcResponse(),
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

function errorHandler(message: string): RpcHandler {
  return () => ({ data: null, error: { message } });
}

function makeSupabase(options: {
  session: Record<string, unknown> | null;
  handlers: Record<string, RpcHandler>;
  callLog?: string[];
}) {
  const callLog = options.callLog ?? [];
  return {
    from(table: string) {
      if (table !== "purchase_capture_sessions") {
        throw new Error(`unexpected table ${table}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api: any = {};
      api.select = () => api;
      api.eq = () => api;
      api.maybeSingle = async () => ({ data: options.session, error: null });
      return api;
    },
    rpc(name: string, args: Record<string, unknown>) {
      callLog.push(name);
      const handler = options.handlers[name];
      if (!handler) throw new Error(`unexpected rpc ${name}`);
      return Promise.resolve(handler(args));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const baseParams = {
  sessionId: SESSION_ID,
  expectedSourceType: "user" as const,
  expectedSourceId: SOURCE_ID,
  expectedSenderLineUserId: SENDER_ID,
};

const noopPush = async () => ({ status: "delivered" as const });

function expectPosted(result: PurchaseCaptureConfirmResult): asserts result is Extract<
  PurchaseCaptureConfirmResult,
  { outcome: "posted" }
> {
  if (result.outcome !== "posted") {
    throw new Error(`expected posted, got refused: ${JSON.stringify(result)}`);
  }
}

function expectRefused(result: PurchaseCaptureConfirmResult): asserts result is Extract<
  PurchaseCaptureConfirmResult,
  { outcome: "refused" }
> {
  if (result.outcome !== "refused") {
    throw new Error(`expected refused, got posted: ${JSON.stringify(result)}`);
  }
}

describe("runPurchaseCaptureConfirmation", () => {
  test("fresh happy path: begin -> confirm -> post -> complete -> deliver, in order", async () => {
    let beginArgs: Record<string, unknown> | undefined;
    const callLog: string[] = [];
    const session = buildSession();
    const supabase = makeSupabase({
      session,
      callLog,
      handlers: {
        begin_purchase_capture_confirmation: (args) => {
          beginArgs = args;
          return beginSuccessHandler(args);
        },
        confirm_purchase_receipt: confirmSuccessHandler,
        post_purchase_receipt_inventory_movement: postSuccessHandler,
        complete_purchase_capture_posting: completeSuccessHandler,
        claim_next_purchase_capture_notification_part: noopClaimHandler,
      },
    });

    const result = await runPurchaseCaptureConfirmation(supabase, baseParams, noopPush);

    expectPosted(result);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.receiptId).toBe(RECEIPT_ID);
    expect(result.draftRevision).toBe("3");
    expect(result.movementId).toBe(MOVEMENT_ID);
    expect(result.replayed).toBe(false);
    expect(result.recoveryStage).toBe("fresh");

    expect(callLog).toEqual([
      "begin_purchase_capture_confirmation",
      "confirm_purchase_receipt",
      "post_purchase_receipt_inventory_movement",
      "complete_purchase_capture_posting",
      "claim_next_purchase_capture_notification_part",
    ]);

    expect(beginArgs?.p_expected_generation).toBe(session.session_generation);
    expect(beginArgs?.p_expected_receipt_id).toBe(session.receipt_id);
    expect(beginArgs?.p_expected_draft_revision).toBe(session.draft_revision);
  });

  test("confirming recovery: begin_* is never called; confirm/post/complete still run", async () => {
    const callLog: string[] = [];
    const session = buildSession({ status: "confirming" });
    const supabase = makeSupabase({
      session,
      callLog,
      handlers: {
        confirm_purchase_receipt: confirmSuccessHandler,
        post_purchase_receipt_inventory_movement: postSuccessHandler,
        complete_purchase_capture_posting: completeSuccessHandler,
        claim_next_purchase_capture_notification_part: noopClaimHandler,
      },
    });

    const result = await resumePurchaseCaptureConfirmation(supabase, baseParams, noopPush);

    expectPosted(result);
    expect(result.recoveryStage).toBe("confirming");
    expect(callLog).toEqual([
      "confirm_purchase_receipt",
      "post_purchase_receipt_inventory_movement",
      "complete_purchase_capture_posting",
      "claim_next_purchase_capture_notification_part",
    ]);
    expect(callLog).not.toContain("begin_purchase_capture_confirmation");
  });

  test("posted replay: begin/confirm/post never called; complete_* uses the stored movement_id", async () => {
    const callLog: string[] = [];
    let completeArgs: Record<string, unknown> | undefined;
    const session = buildSession({ status: "posted", movement_id: MOVEMENT_ID });
    const supabase = makeSupabase({
      session,
      callLog,
      handlers: {
        get_purchase_receipt_confirmation: getConfirmationSuccessHandler,
        complete_purchase_capture_posting: (args) => {
          completeArgs = args;
          return completeSuccessHandler(args);
        },
        claim_next_purchase_capture_notification_part: noopClaimHandler,
      },
    });

    const result = await runPurchaseCaptureConfirmation(supabase, baseParams, noopPush);

    expectPosted(result);
    expect(result.outcome).toBe("posted");
    expect(result.replayed).toBe(true);
    expect(result.recoveryStage).toBe("posted_replay");
    expect(result.movementId).toBe(MOVEMENT_ID);

    expect(callLog).toEqual([
      "get_purchase_receipt_confirmation",
      "complete_purchase_capture_posting",
      "claim_next_purchase_capture_notification_part",
    ]);
    expect(completeArgs?.p_movement_id).toBe(MOVEMENT_ID);
  });

  test("resumePurchaseCaptureConfirmation refuses invalid_state on awaiting_confirmation without calling begin_*", async () => {
    const callLog: string[] = [];
    const session = buildSession({ status: "awaiting_confirmation" });
    const supabase = makeSupabase({ session, callLog, handlers: {} });

    const result = await resumePurchaseCaptureConfirmation(supabase, baseParams, noopPush);

    expectRefused(result);
    expect(result.code).toBe("invalid_state");
    expect(result.recoveryStage).toBe("fresh");
    expect(callLog).toEqual([]);
  });

  test("ownership mismatch pre-check refuses without calling any RPC", async () => {
    const callLog: string[] = [];
    const session = buildSession({ source_id: "U-someone-else" });
    const supabase = makeSupabase({ session, callLog, handlers: {} });

    const result = await runPurchaseCaptureConfirmation(supabase, baseParams, noopPush);

    expectRefused(result);
    expect(result.code).toBe("ownership_mismatch");
    expect(callLog).toEqual([]);
  });

  test("session_not_found when the session row does not exist", async () => {
    const supabase = makeSupabase({ session: null, handlers: {} });
    const result = await runPurchaseCaptureConfirmation(supabase, baseParams, noopPush);
    expectRefused(result);
    expect(result.code).toBe("session_not_found");
    expect(result.recoveryStage).toBe("fresh");
  });

  test("delivery throwing does not change outcome 'posted'", async () => {
    const session = buildSession({ status: "posted", movement_id: MOVEMENT_ID });
    const throwingHandler: RpcHandler = () => {
      throw new Error("record_attempt_boom");
    };
    const throwingPush = async () => {
      throw new Error("push boom");
    };
    const supabase = makeSupabase({
      session,
      handlers: {
        get_purchase_receipt_confirmation: getConfirmationSuccessHandler,
        complete_purchase_capture_posting: completeSuccessHandler,
        claim_next_purchase_capture_notification_part: () => ({
          data: {
            claimed: true,
            id: "part-1",
            claim_token: "token-1",
            retry_key: "retry-1",
            payload_text: "text-1",
          },
          error: null,
        }),
        record_purchase_capture_notification_part_attempt: throwingHandler,
      },
    });

    const result = await runPurchaseCaptureConfirmation(supabase, baseParams, throwingPush);

    expectPosted(result);
    expect(result.outcome).toBe("posted");
    expect(result.deliveredParts).toBe(0);
    expect(result.failedParts).toBe(0);
  });

  describe("refusal code mapping — begin_purchase_capture_confirmation", () => {
    const table: Array<[string, string, PurchaseCaptureConfirmFailureCode]> = [
      ["generation_conflict", "generation_conflict", "generation_conflict"],
      ["ownership_mismatch (RPC-level)", "ownership_mismatch", "ownership_mismatch"],
      ["invalid_state", "invalid_state", "invalid_state"],
      ["stale_revision", "stale_revision", "stale_revision"],
      ["receipt_not_draft", "receipt_not_draft", "receipt_not_draft"],
      ["receipt_binding_mismatch", "receipt_binding_mismatch", "receipt_binding_mismatch"],
      [
        "blocking_blocker_present",
        'blocking_blocker_present: [{"code":"MISSING_UNIT_COST"}]',
        "blocking_blocker_present",
      ],
      ["empty_receipt", "empty_receipt", "empty_receipt"],
    ];

    for (const [label, rpcMessage, expectedCode] of table) {
      test(label, async () => {
        const session = buildSession();
        const supabase = makeSupabase({
          session,
          handlers: {
            begin_purchase_capture_confirmation: errorHandler(rpcMessage),
          },
        });
        const result = await runPurchaseCaptureConfirmation(supabase, baseParams, noopPush);
        expectRefused(result);
        expect(result.code).toBe(expectedCode);
        expect(result.recoveryStage).toBe("fresh");
        if (expectedCode === "blocking_blocker_present") {
          expect(result.message).toContain("MISSING_UNIT_COST");
        }
      });
    }
  });

  describe("refusal code mapping — confirm_purchase_receipt", () => {
    const table: Array<[string, string, PurchaseCaptureConfirmFailureCode]> = [
      ["draft_revision moved -> stale_revision", "draft_revision moved underneath the caller", "stale_revision"],
      [
        "already confirmed under a different confirmation_key -> invalid_state",
        "already confirmed under a different confirmation_key",
        "invalid_state",
      ],
      ["cannot be confirmed -> receipt_not_draft", "receipt cannot be confirmed", "receipt_not_draft"],
      ["not found -> receipt_not_bound", "purchase receipt not found", "receipt_not_bound"],
    ];

    for (const [label, rpcMessage, expectedCode] of table) {
      test(label, async () => {
        const session = buildSession({ status: "confirming" });
        const supabase = makeSupabase({
          session,
          handlers: {
            confirm_purchase_receipt: errorHandler(rpcMessage),
          },
        });
        const result = await resumePurchaseCaptureConfirmation(supabase, baseParams, noopPush);
        expectRefused(result);
        expect(result.code).toBe(expectedCode);
        expect(result.recoveryStage).toBe("confirming");
      });
    }
  });

  describe("refusal code mapping — post_purchase_receipt_inventory_movement", () => {
    const table: Array<[string, string, PurchaseCaptureConfirmFailureCode]> = [
      ["UNRESOLVED identity -> blocking_blocker_present", "UNRESOLVED product identity on line 1", "blocking_blocker_present"],
      ["is not confirmed -> invalid_state", "receipt is not confirmed", "invalid_state"],
      ["already posted -> invalid_movement", "already posted as movement X", "invalid_movement"],
      ["not found -> receipt_not_bound", "purchase receipt not found", "receipt_not_bound"],
    ];

    for (const [label, rpcMessage, expectedCode] of table) {
      test(label, async () => {
        const session = buildSession({ status: "confirming" });
        const supabase = makeSupabase({
          session,
          handlers: {
            confirm_purchase_receipt: confirmSuccessHandler,
            post_purchase_receipt_inventory_movement: errorHandler(rpcMessage),
          },
        });
        const result = await resumePurchaseCaptureConfirmation(supabase, baseParams, noopPush);
        expectRefused(result);
        expect(result.code).toBe(expectedCode);
        expect(result.recoveryStage).toBe("confirming");
      });
    }
  });

  describe("refusal code mapping — complete_purchase_capture_posting", () => {
    const table: Array<[string, string, PurchaseCaptureConfirmFailureCode]> = [
      ["invalid_movement", "invalid_movement", "invalid_movement"],
      ["invalid_state", "invalid_state", "invalid_state"],
      ["generation_conflict", "generation_conflict", "generation_conflict"],
      ["notification_identity_conflict", "notification_identity_conflict", "notification_identity_conflict"],
    ];

    for (const [label, rpcMessage, expectedCode] of table) {
      test(label, async () => {
        const session = buildSession({ status: "confirming" });
        const supabase = makeSupabase({
          session,
          handlers: {
            confirm_purchase_receipt: confirmSuccessHandler,
            post_purchase_receipt_inventory_movement: postSuccessHandler,
            complete_purchase_capture_posting: errorHandler(rpcMessage),
          },
        });
        const result = await resumePurchaseCaptureConfirmation(supabase, baseParams, noopPush);
        expectRefused(result);
        expect(result.code).toBe(expectedCode);
        expect(result.recoveryStage).toBe("confirming");
      });
    }
  });

  test("confirmPurchaseCaptureFromLine is the same function as runPurchaseCaptureConfirmation", () => {
    expect(confirmPurchaseCaptureFromLine).toBe(runPurchaseCaptureConfirmation);
  });
});

describe("purchaseCaptureConfirmationKey / purchaseCaptureActor", () => {
  test("derives a stable, prefixed key from the opening LINE event id", () => {
    expect(purchaseCaptureConfirmationKey("event-1")).toBe("purchase-capture:v1:event-1");
    expect(purchaseCaptureConfirmationKey("event-1")).toBe(purchaseCaptureConfirmationKey("event-1"));
  });

  test("throws on a blank opened_line_event_id", () => {
    expect(() => purchaseCaptureConfirmationKey("")).toThrow();
    expect(() => purchaseCaptureConfirmationKey("   ")).toThrow();
  });

  test("derives the actor string from the sender's LINE user id", () => {
    expect(purchaseCaptureActor("Uabc123")).toBe("line:Uabc123");
  });
});

describe("renderPurchaseCapturePostedSuccessText", () => {
  test("is byte-identical across repeated calls with the same payload", () => {
    const payload = buildPayload() as unknown as Parameters<
      typeof renderPurchaseCapturePostedSuccessText
    >[0]["payload"];
    const first = renderPurchaseCapturePostedSuccessText({ payload, movementId: MOVEMENT_ID });
    const second = renderPurchaseCapturePostedSuccessText({ payload, movementId: MOVEMENT_ID });
    expect(first).toBe(second);
  });

  test("contains the required headline copy", () => {
    const payload = buildPayload() as unknown as Parameters<
      typeof renderPurchaseCapturePostedSuccessText
    >[0]["payload"];
    const text = renderPurchaseCapturePostedSuccessText({ payload, movementId: MOVEMENT_ID });
    expect(text).toContain("ยืนยันใบซื้อแล้ว");
    expect(text).toContain("บันทึกสินค้าเข้าสต๊อกคลังหลักแล้ว");
  });

  test("never prints a money, cost, or valuation figure, and never prints the movement id", () => {
    const payload = buildPayload() as unknown as Parameters<
      typeof renderPurchaseCapturePostedSuccessText
    >[0]["payload"];
    const text = renderPurchaseCapturePostedSuccessText({ payload, movementId: MOVEMENT_ID });
    expect(text).not.toContain("บาท");
    expect(text).not.toContain("20"); // the item's unit_cost value must never appear
    expect(text).not.toContain(MOVEMENT_ID);
    // The single permitted mention of cost is the disclaimer note.
    expect(text).toContain("ยังไม่คำนวณต้นทุนจริงและมูลค่าสินค้า");
  });

  test("renderPurchaseCapturePostedSuccessPayloadTexts chunks into at least one part", () => {
    const payload = buildPayload() as unknown as Parameters<
      typeof renderPurchaseCapturePostedSuccessText
    >[0]["payload"];
    const texts = renderPurchaseCapturePostedSuccessPayloadTexts({ payload, movementId: MOVEMENT_ID });
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts.join("\n\n")).toContain("ยืนยันใบซื้อแล้ว");
  });
});
