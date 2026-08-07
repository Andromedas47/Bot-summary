import { describe, expect, mock, test } from "bun:test";
import { isPurchaseCaptureWebhookEnabled } from "./config";

// ── Module mocks (bun:test mock.module) ─────────────────────────────────────
// confirm-flow / finalizer / notification-push-worker are exercised in their
// own dedicated test files (confirm-flow.test.ts, finalizer.test.ts,
// notification-push-worker.test.ts). Here we only need to prove that
// tryHandlePurchaseCaptureMessage calls the right one, with the right
// arguments, at the right time — so they are replaced with call-tracking
// mocks rather than re-simulating their internal RPC chains.

type ConfirmResult =
  | {
      outcome: "posted";
      sessionId: string;
      receiptId: string;
      draftRevision: string;
      movementId: string;
      replayed: boolean;
      recoveryStage: string;
      deliveredParts: number;
      failedParts: number;
    }
  | { outcome: "refused"; sessionId: string; code: string; message: string; recoveryStage: string };

let confirmResult: ConfirmResult = {
  outcome: "posted",
  sessionId: "unset",
  receiptId: "unset",
  draftRevision: "1",
  movementId: "m1",
  replayed: false,
  recoveryStage: "fresh",
  deliveredParts: 0,
  failedParts: 0,
};

const confirmMock = mock(async () => confirmResult);
mock.module("./confirm-flow", () => ({
  confirmPurchaseCaptureFromLine: confirmMock,
}));

let replaceDraftResult: { draftRevision: string; previewPayloadTexts: string[] } = {
  draftRevision: "4",
  previewPayloadTexts: ["preview text"],
};
let replaceDraftThrows: Error | null = null;

const replaceDraftMock = mock(async () => {
  if (replaceDraftThrows) throw replaceDraftThrows;
  return replaceDraftResult;
});
mock.module("./finalizer", () => ({
  replacePurchaseCaptureDraftFromIngests: replaceDraftMock,
}));

type DeliverParams = {
  sessionId: string;
  recipientId: string;
  notificationKind: string;
  notificationVersion: string;
};

const deliverMock = mock(
  async (...args: [unknown, DeliverParams, unknown]) => (void args, {
    deliveredParts: 1,
    failedParts: 0,
    stoppedReason: "complete" as const,
  }),
);
mock.module("./notification-push-worker", () => ({
  deliverPurchaseCaptureNotificationParts: deliverMock,
}));

const {
  tryHandlePurchaseCaptureMessage,
  classifyPurchaseCaptureCommand,
  containsPurchaseBlock,
  PURCHASE_CAPTURE_CONFIRM_COMMAND,
  PURCHASE_CAPTURE_RECHECK_COMMAND,
  PURCHASE_CAPTURE_CANCEL_COMMAND,
} = await import("./webhook-handler");
import {
  PurchaseCaptureInvalidStateError,
} from "./session-service";

// ── Fake supabase: real query-builder semantics for purchase_capture_sessions,
// plus a tiny in-memory RPC executor for open/admit/close/cancel so the real
// PurchaseCaptureSessionService (not mocked) exercises real filter logic. ────

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const GENERATION = "22222222-2222-4222-8222-222222222222";
const RECEIPT_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "U-source";
const SENDER_ID = "U-sender";

type SessionRow = Record<string, unknown>;
type CallRecord = { name: string; args?: Record<string, unknown> };

function buildSession(overrides: Record<string, unknown> = {}): SessionRow {
  return {
    id: SESSION_ID,
    source_type: "user",
    source_id: SOURCE_ID,
    sender_line_user_id: SENDER_ID,
    opened_line_event_id: "evt-open",
    session_generation: GENERATION,
    status: "open",
    close_event_timestamp_ms: null,
    close_quiet_until: null,
    close_deadline_at: null,
    ingest_revision: 0,
    receipt_id: null,
    draft_revision: null,
    movement_id: null,
    fail_reason: null,
    warnings: [],
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSupabase(initialSession: SessionRow | null, callLog: CallRecord[] = []) {
  const state: { session: SessionRow | null } = { session: initialSession };

  function from(table: string) {
    callLog.push({ name: `from:${table}` });
    if (table !== "purchase_capture_sessions") throw new Error(`unexpected table ${table}`);
    const filters: { eq: Record<string, unknown>; inStatus?: string[] } = { eq: {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (col: string, val: unknown) => {
      filters.eq[col] = val;
      return api;
    };
    api.in = (col: string, vals: string[]) => {
      if (col === "status") filters.inStatus = vals;
      return api;
    };
    api.order = () => api;
    api.limit = () => api;
    api.maybeSingle = async () => {
      const s = state.session;
      if (!s) return { data: null, error: null };
      for (const [k, v] of Object.entries(filters.eq)) {
        if (s[k] !== v) return { data: null, error: null };
      }
      if (filters.inStatus && !filters.inStatus.includes(String(s.status))) {
        return { data: null, error: null };
      }
      return { data: s, error: null };
    };
    return api;
  }

  function rpc(name: string, args: Record<string, unknown>) {
    callLog.push({ name: `rpc:${name}`, args });
    switch (name) {
      case "open_purchase_capture_session": {
        state.session = buildSession({
          id: SESSION_ID,
          source_type: args.p_source_type,
          source_id: args.p_source_id,
          sender_line_user_id: args.p_sender_line_user_id,
          opened_line_event_id: args.p_opened_line_event_id,
          status: "open",
        });
        return Promise.resolve({
          data: { opened: true, idempotent: false, reason: "opened", session_id: SESSION_ID },
          error: null,
        });
      }
      case "admit_purchase_capture_event": {
        const nextStatus = args.p_kind === "close" ? "closing" : (state.session?.status ?? "open");
        state.session = { ...(state.session as SessionRow), status: nextStatus };
        return Promise.resolve({
          data: { accepted: true, inserted: true, reason: "accepted", session_id: SESSION_ID },
          error: null,
        });
      }
      case "close_purchase_capture_open_event": {
        state.session = { ...(state.session as SessionRow), status: "closing" };
        return Promise.resolve({ data: { idempotent: false, session_id: SESSION_ID }, error: null });
      }
      case "cancel_purchase_capture_session": {
        state.session = { ...(state.session as SessionRow), status: "cancelled" };
        return Promise.resolve({ data: { idempotent: false, session_id: SESSION_ID }, error: null });
      }
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from, rpc } as any;
}

const noopPush = async () => ({ status: "delivered" as const });

const HEADER_TEXT = "เริ่มซื้อ 1/8/2026 10:00";
const ONE_MESSAGE_OPEN_CLOSE_TEXT = [
  "เริ่มซื้อ 1/8/2026 10:00",
  "ซื้อรายการ 1",
  "ชื่อสินค้า: มะนาว",
  "จำนวน: 10 กก.",
  "สรุปค่าใช้จ่ายซื้อ",
  "ค่าขนส่ง: 0 บาท",
  "ปิดซื้อ 1 รายการ",
].join("\n");
const ITEM_TEXT = "ซื้อรายการ 2\nชื่อสินค้า: มะนาว\nจำนวน: 5 กก.";
const CLOSE_ONLY_TEXT = "ปิดซื้อ 3 รายการ";

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    sourceType: "user" as const,
    sourceId: SOURCE_ID,
    senderLineUserId: SENDER_ID,
    lineEventId: "evt-1",
    lineTimestampMs: 1_700_000_000_000,
    text: HEADER_TEXT,
    enabled: true,
    ...overrides,
  };
}

describe("config gating", () => {
  test("isPurchaseCaptureWebhookEnabled: absent -> false", () => {
    expect(isPurchaseCaptureWebhookEnabled(undefined)).toBe(false);
  });

  test("flag disabled -> returns null and makes zero supabase calls", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(null, callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ enabled: false }),
      noopPush,
    );
    expect(result).toBeNull();
    expect(callLog).toEqual([]);
  });

  test("flag true -> a purchase header opens a session", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(null, callLog);
    const result = await tryHandlePurchaseCaptureMessage(supabase, baseParams(), noopPush);
    expect(result?.action).toBe("opened");
    expect(result?.parsed).toBe(true);
    expect(callLog.some((c) => c.name === "rpc:open_purchase_capture_session")).toBe(true);
  });
});

describe("document content routing", () => {
  test("one-message open+close: header+items+costs+close opens then closes", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(null, callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: ONE_MESSAGE_OPEN_CLOSE_TEXT }),
      noopPush,
    );
    expect(result?.action).toBe("opened_and_closed");
    const rpcNames = callLog.filter((c) => c.name.startsWith("rpc:")).map((c) => c.name);
    expect(rpcNames).toEqual([
      "rpc:open_purchase_capture_session",
      "rpc:close_purchase_capture_open_event",
    ]);
  });

  test("item message with an open session -> admitted with kind 'item'", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(buildSession({ status: "open" }), callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: ITEM_TEXT }),
      noopPush,
    );
    expect(result?.action).toBe("admitted");
    const admitCall = callLog.find((c) => c.name === "rpc:admit_purchase_capture_event");
    expect(admitCall?.args?.p_kind).toBe("item");
  });

  test("message containing a close block -> admitted (closed) with kind 'close'", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(buildSession({ status: "open" }), callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: CLOSE_ONLY_TEXT }),
      noopPush,
    );
    expect(result?.action).toBe("closed");
    const admitCall = callLog.find((c) => c.name === "rpc:admit_purchase_capture_event");
    expect(admitCall?.args?.p_kind).toBe("close");
  });

  test("duplicate webhook (same lineEventId) -> RPC called again, handled without error", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(buildSession({ status: "open" }), callLog);
    const params = baseParams({ text: ITEM_TEXT, lineEventId: "evt-dup" });
    const first = await tryHandlePurchaseCaptureMessage(supabase, params, noopPush);
    const second = await tryHandlePurchaseCaptureMessage(supabase, params, noopPush);
    expect(first?.action).toBe("admitted");
    expect(second?.action).toBe("admitted");
    expect(callLog.filter((c) => c.name === "rpc:admit_purchase_capture_event")).toHaveLength(2);
  });

  test("confirming + new document content -> not admitted (admit RPC NOT called)", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(buildSession({ status: "confirming" }), callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: ITEM_TEXT }),
      noopPush,
    );
    expect(result?.action).toBe("content_after_close");
    expect(callLog.some((c) => c.name === "rpc:admit_purchase_capture_event")).toBe(false);
  });
});

describe("exact command matching", () => {
  test("exact match", () => {
    expect(classifyPurchaseCaptureCommand(PURCHASE_CAPTURE_CONFIRM_COMMAND)).toBe("confirm");
    expect(classifyPurchaseCaptureCommand(PURCHASE_CAPTURE_RECHECK_COMMAND)).toBe("recheck");
    expect(classifyPurchaseCaptureCommand(PURCHASE_CAPTURE_CANCEL_COMMAND)).toBe("cancel");
  });

  test("trimmed exact match still matches", () => {
    expect(classifyPurchaseCaptureCommand(` ${PURCHASE_CAPTURE_CONFIRM_COMMAND} `)).toBe("confirm");
  });

  test("suffixed text does NOT match and, with no purchase grammar, returns null", async () => {
    expect(classifyPurchaseCaptureCommand("ยืนยันซื้อครับ")).toBeNull();
    expect(containsPurchaseBlock("ยืนยันซื้อครับ")).toBe(false);

    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(null, callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: "ยืนยันซื้อครับ" }),
      noopPush,
    );
    expect(result).toBeNull();
    expect(callLog).toEqual([]);
  });
});

describe("cross-feature safety", () => {
  const nonPurchaseTexts = [
    ["produce header line", "จันทร์ 1/8/2026 ตลาดไท"],
    ["produce close", "จบรายการ"],
    ["guided round close", "ปิดรอบ"],
    ["guided menu trigger", "เมนู"],
    ["manual-slip amount line", "1,000.00"],
    ["arbitrary Thai sentence", "วันนี้อากาศดีมาก อยากไปเที่ยวทะเล"],
  ] as const;

  for (const [label, text] of nonPurchaseTexts) {
    test(`${label} -> null even with an OPEN purchase session, no RPC called`, async () => {
      const callLog: CallRecord[] = [];
      const supabase = makeSupabase(buildSession({ status: "open" }), callLog);
      const result = await tryHandlePurchaseCaptureMessage(
        supabase,
        baseParams({ text }),
        noopPush,
      );
      expect(result).toBeNull();
      expect(callLog).toEqual([]);
    });
  }
});

describe("confirm command", () => {
  test("awaiting_confirmation -> confirm flow invoked once; posted -> replyTexts []", async () => {
    confirmResult = {
      outcome: "posted",
      sessionId: SESSION_ID,
      receiptId: RECEIPT_ID,
      draftRevision: "3",
      movementId: "m-1",
      replayed: false,
      recoveryStage: "fresh",
      deliveredParts: 1,
      failedParts: 0,
    };
    confirmMock.mockClear();
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(
      buildSession({ status: "awaiting_confirmation", receipt_id: RECEIPT_ID, draft_revision: 3 }),
      callLog,
    );
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: PURCHASE_CAPTURE_CONFIRM_COMMAND }),
      noopPush,
    );
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(result?.action).toBe("confirmed");
    expect(result?.replyTexts).toEqual([]);
  });

  test("posted session -> confirm flow invoked (posted replay), no error", async () => {
    confirmResult = {
      outcome: "posted",
      sessionId: SESSION_ID,
      receiptId: RECEIPT_ID,
      draftRevision: "3",
      movementId: "m-2",
      replayed: true,
      recoveryStage: "posted_replay",
      deliveredParts: 1,
      failedParts: 0,
    };
    confirmMock.mockClear();
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(
      buildSession({ status: "posted", receipt_id: RECEIPT_ID, draft_revision: 3, movement_id: "m-2" }),
      callLog,
    );
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: PURCHASE_CAPTURE_CONFIRM_COMMAND }),
      noopPush,
    );
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(result?.action).toBe("confirm_replayed");
  });

  test("confirming -> confirm flow NOT invoked, in-progress ack", async () => {
    confirmMock.mockClear();
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(buildSession({ status: "confirming" }), callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: PURCHASE_CAPTURE_CONFIRM_COMMAND }),
      noopPush,
    );
    expect(confirmMock).not.toHaveBeenCalled();
    expect(result?.action).toBe("confirm_in_progress");
  });

  test("no session at all -> null (fail closed)", async () => {
    confirmMock.mockClear();
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(null, callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: PURCHASE_CAPTURE_CONFIRM_COMMAND }),
      noopPush,
    );
    expect(result).toBeNull();
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("recheck command", () => {
  test("awaiting_confirmation with bound receipt -> replaceDraft path + preview delivery", async () => {
    replaceDraftThrows = null;
    replaceDraftResult = { draftRevision: "4", previewPayloadTexts: ["preview"] };
    replaceDraftMock.mockClear();
    deliverMock.mockClear();
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(
      buildSession({ status: "awaiting_confirmation", receipt_id: RECEIPT_ID, draft_revision: 3 }),
      callLog,
    );
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: PURCHASE_CAPTURE_RECHECK_COMMAND }),
      noopPush,
    );
    expect(replaceDraftMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const deliverArgs = deliverMock.mock.calls[0]?.[1] as { notificationVersion?: string } | undefined;
    expect(deliverArgs?.notificationVersion).toBe("4");
    expect(result?.action).toBe("rechecked");
    expect(result?.replyTexts.length).toBeGreaterThan(0);
  });

  test("replaceDraft refuses with invalid_state -> recheck_refused, no throw", async () => {
    replaceDraftThrows = new PurchaseCaptureInvalidStateError();
    replaceDraftMock.mockClear();
    deliverMock.mockClear();
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(
      buildSession({ status: "awaiting_confirmation", receipt_id: RECEIPT_ID, draft_revision: 3 }),
      callLog,
    );
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: PURCHASE_CAPTURE_RECHECK_COMMAND }),
      noopPush,
    );
    expect(result?.action).toBe("recheck_refused");
    expect(deliverMock).not.toHaveBeenCalled();
    replaceDraftThrows = null;
  });

  test("recheck while session still open -> refused, replaceDraft not called", async () => {
    replaceDraftMock.mockClear();
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(buildSession({ status: "open" }), callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: PURCHASE_CAPTURE_RECHECK_COMMAND }),
      noopPush,
    );
    expect(result?.action).toBe("recheck_refused");
    expect(replaceDraftMock).not.toHaveBeenCalled();
  });
});

describe("cancel command", () => {
  test("cancel from awaiting_confirmation -> cancel RPC called", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(buildSession({ status: "awaiting_confirmation" }), callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: PURCHASE_CAPTURE_CANCEL_COMMAND }),
      noopPush,
    );
    expect(result?.action).toBe("cancelled");
    expect(callLog.some((c) => c.name === "rpc:cancel_purchase_capture_session")).toBe(true);
  });

  test("cancel on a posted session -> refused, no RPC called", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(buildSession({ status: "posted" }), callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: PURCHASE_CAPTURE_CANCEL_COMMAND }),
      noopPush,
    );
    expect(result?.action).toBe("cancel_refused");
    expect(callLog.some((c) => c.name === "rpc:cancel_purchase_capture_session")).toBe(false);
  });

  test("cancel while confirming -> refused, no RPC called", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(buildSession({ status: "confirming" }), callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: PURCHASE_CAPTURE_CANCEL_COMMAND }),
      noopPush,
    );
    expect(result?.action).toBe("cancel_refused");
    expect(callLog.some((c) => c.name === "rpc:cancel_purchase_capture_session")).toBe(false);
  });

  test("cancel is idempotent when the latest session is already cancelled", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(buildSession({ status: "cancelled" }), callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ text: PURCHASE_CAPTURE_CANCEL_COMMAND }),
      noopPush,
    );
    expect(result?.action).toBe("cancelled");
    expect(callLog.some((c) => c.name === "rpc:cancel_purchase_capture_session")).toBe(false);
  });
});

describe("group/room events with no sender", () => {
  test("blank senderLineUserId -> null even for a purchase header", async () => {
    const callLog: CallRecord[] = [];
    const supabase = makeSupabase(null, callLog);
    const result = await tryHandlePurchaseCaptureMessage(
      supabase,
      baseParams({ sourceType: "group", senderLineUserId: null }),
      noopPush,
    );
    expect(result).toBeNull();
    expect(callLog).toEqual([]);
  });
});
