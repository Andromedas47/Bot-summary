import { describe, expect, test } from "bun:test";
import type { LineEvent, LineMessageEvent } from "./types";
import { WebhookService } from "./webhook-service";
import {
  PhysicalInventoryAfterCloseBoundaryError,
  PhysicalInventoryAfterCloseError,
  PhysicalInventorySessionService,
} from "@/lib/physical-inventory/session-service";
import type { PhysicalInventorySessionRow } from "@/lib/physical-inventory";

const AUTHORIZED_GROUP = "C1d96954d298d99f65912a5f1e96edffc";

type Row = Record<string, unknown>;

function makeSupabaseDouble() {
  const rows: Record<string, Row[]> = {
    raw_messages: [],
    parse_errors: [],
    pending_sessions: [],
  };
  let sequence = 0;

  function query(table: string) {
    let inserted: Row | null = null;
    let update: Row | null = null;
    const filters: Array<[string, unknown]> = [];
    const api: Record<string, unknown> = {};

    const selected = () => (rows[table] ?? []).filter((row) =>
      filters.every(([column, value]) => row[column] === value));
    const result = () => {
      if (update) {
        for (const row of selected()) Object.assign(row, update);
      }
      return { data: inserted ? [inserted] : selected(), error: null };
    };

    api.insert = (value: Row) => {
      if (table === "raw_messages") {
        const duplicate = rows.raw_messages!.some(
          (row) => row.line_event_id === value.line_event_id,
        );
        if (duplicate) {
          const duplicateApi = {
            select: () => duplicateApi,
            single: async () => ({
              data: null,
              error: { code: "23505", message: "duplicate" },
            }),
            then: (resolve: (value: unknown) => void) =>
              resolve({ data: null, error: { code: "23505", message: "duplicate" } }),
          };
          return duplicateApi;
        }
      }
      inserted = {
        id: `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        is_processed: false,
        ...value,
      };
      (rows[table] ??= []).push(inserted);
      return api;
    };
    api.update = (value: Row) => {
      update = value;
      return api;
    };
    api.select = () => api;
    api.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return api;
    };
    api.in = () => api;
    api.maybeSingle = async () => ({ data: selected()[0] ?? null, error: null });
    api.single = async () => ({
      data: inserted ?? selected()[0] ?? null,
      error: inserted || selected()[0] ? null : { message: "not found" },
    });
    api.then = (resolve: (value: unknown) => void) => resolve(result());
    return api;
  }

  return {
    from(table: string) {
      if (
        table === "produce_sessions"
        || table === "produce_items"
        || table === "inventory_movements"
      ) {
        throw new Error(`forbidden P2A access to ${table}`);
      }
      return query(table);
    },
    _rows(table: string) {
      return rows[table] ?? [];
    },
  };
}

function makePhysicalInventoryGateway() {
  const sessions: PhysicalInventorySessionRow[] = [];
  const ingests: Array<{
    sessionId: string;
    eventId: string;
    timestamp: number;
    kind: "header" | "item" | "close";
    rawText: string;
  }> = [];
  let sequence = 0;

  const gateway = {
    async findOpenSession(sourceId: string, senderLineUserId: string) {
      return sessions.find(
        (session) =>
          session.source_id === sourceId
          && session.sender_line_user_id === senderLineUserId
          && ["open", "closing"].includes(session.status),
      ) ?? null;
    },
    async openSession(params: {
      sourceType: "group";
      sourceId: string;
      senderLineUserId: string;
      openedLineEventId: string;
      lineTimestampMs: number;
      rawText: string;
      rawMessageId?: string | null;
      businessDate?: string | null;
    }) {
      const duplicate = ingests.find((ingest) => ingest.eventId === params.openedLineEventId);
      if (duplicate) {
        const session = sessions.find((row) => row.id === duplicate.sessionId)!;
        return {
          opened: false,
          idempotent: true,
          reason: "duplicate_open_event",
          session,
        };
      }
      const active = sessions.find(
        (session) =>
          session.source_id === params.sourceId
          && session.sender_line_user_id === params.senderLineUserId
          && ["open", "closing"].includes(session.status),
      );
      if (active) {
        return {
          opened: false,
          idempotent: true,
          reason: "already_open_or_duplicate",
          session: active,
        };
      }

      const id = `20000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      const generation =
        `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
      const session = {
        id,
        source_type: "group",
        source_id: params.sourceId,
        sender_line_user_id: params.senderLineUserId,
        opened_line_event_id: params.openedLineEventId,
        session_generation: generation,
        business_date: params.businessDate ?? null,
        warehouse_code: "MAIN",
        status: "open",
        parser_version: "p2a-physical-1.0.0",
        opened_at: new Date().toISOString(),
        close_requested_at: null,
        close_event_timestamp_ms: null,
        close_quiet_until: null,
        close_deadline_at: null,
        closed_at: null,
        failed_closed_at: null,
        fail_reason: null,
        ingest_revision: 1,
        snapshot_id: null,
        header_raw_message_id: params.rawMessageId ?? null,
        close_raw_message_id: null,
        close_line_event_id: null,
        warnings: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as unknown as PhysicalInventorySessionRow;
      sessions.push(session);
      ingests.push({
        sessionId: id,
        eventId: params.openedLineEventId,
        timestamp: params.lineTimestampMs,
        kind: "header",
        rawText: params.rawText,
      });
      return { opened: true, idempotent: false, reason: "opened", session };
    },
    async registerIngest(params: {
      sessionId: string;
      expectedGeneration: string;
      lineEventId: string;
      lineTimestampMs: number;
      kind: "header" | "item" | "close" | "other";
      rawText: string;
      rawMessageId?: string | null;
    }) {
      const session = sessions.find((row) => row.id === params.sessionId)!;
      const duplicate = ingests.find((ingest) => ingest.eventId === params.lineEventId);
      if (duplicate) {
        return {
          accepted: true,
          inserted: false,
          reason: "duplicate_event",
          session,
        };
      }
      if (!["open", "closing"].includes(session.status)) {
        throw new PhysicalInventoryAfterCloseError();
      }
      if (
        session.close_event_timestamp_ms !== null
        && params.kind !== "close"
        && params.lineTimestampMs > session.close_event_timestamp_ms
      ) {
        throw new PhysicalInventoryAfterCloseBoundaryError();
      }
      if (session.close_event_timestamp_ms !== null && params.kind === "close") {
        return {
          accepted: true,
          inserted: false,
          reason: "close_already_requested",
          session,
        };
      }
      ingests.push({
        sessionId: session.id,
        eventId: params.lineEventId,
        timestamp: params.lineTimestampMs,
        kind: params.kind as "item" | "close",
        rawText: params.rawText,
      });
      session.ingest_revision += 1;
      if (params.kind === "close") {
        session.status = "closing";
        session.close_event_timestamp_ms = params.lineTimestampMs;
        session.close_line_event_id = params.lineEventId;
        session.close_raw_message_id = params.rawMessageId ?? null;
      }
      return {
        accepted: true,
        inserted: true,
        reason: "admitted",
        session,
      };
    },
    _sessions: sessions,
    _ingests: ingests,
  };
  return gateway;
}

function withPhysicalInventoryRpc(
  base: ReturnType<typeof makeSupabaseDouble>,
  gateway: ReturnType<typeof makePhysicalInventoryGateway>,
) {
  function sessionQuery() {
    const filters: Array<[string, unknown, "eq" | "in"]> = [];
    const api: Record<string, unknown> = {};
    const selected = () => gateway._sessions.filter((row) =>
      filters.every(([column, value, operator]) =>
        operator === "eq"
          ? row[column as keyof PhysicalInventorySessionRow] === value
          : Array.isArray(value)
            && value.includes(row[column as keyof PhysicalInventorySessionRow])));
    api.select = () => api;
    api.eq = (column: string, value: unknown) => {
      filters.push([column, value, "eq"]);
      return api;
    };
    api.in = (column: string, value: unknown[]) => {
      filters.push([column, value, "in"]);
      return api;
    };
    api.maybeSingle = async () => ({ data: selected()[0] ?? null, error: null });
    return api;
  }

  return {
    from(table: string) {
      if (table === "physical_inventory_sessions") return sessionQuery();
      return base.from(table);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "open_physical_inventory_session") {
        const result = await gateway.openSession({
          sourceType: args.p_source_type as "group",
          sourceId: String(args.p_source_id),
          senderLineUserId: String(args.p_sender_line_user_id),
          openedLineEventId: String(args.p_opened_line_event_id),
          lineTimestampMs: Number(args.p_line_timestamp_ms),
          rawText: String(args.p_raw_text),
          rawMessageId: args.p_raw_message_id as string | null,
          businessDate: args.p_business_date as string | null,
        });
        return {
          data: {
            opened: result.opened,
            idempotent: result.idempotent,
            reason: result.reason,
            session_id: result.session.id,
          },
          error: null,
        };
      }
      if (name === "admit_physical_inventory_event") {
        try {
          const result = await gateway.registerIngest({
            sessionId: String(args.p_session_id),
            expectedGeneration: String(args.p_expected_generation),
            lineEventId: String(args.p_line_event_id),
            lineTimestampMs: Number(args.p_line_timestamp_ms),
            kind: args.p_kind as "item" | "close",
            rawText: String(args.p_raw_text),
            rawMessageId: args.p_raw_message_id as string | null,
          });
          return {
            data: {
              accepted: result.accepted,
              inserted: result.inserted,
              reason: result.reason,
              session_id: result.session.id,
            },
            error: null,
          };
        } catch (error) {
          return {
            data: null,
            error: { message: error instanceof Error ? error.message : String(error) },
          };
        }
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
}

let eventSequence = 0;
function textEvent(
  text: string,
  options: {
    groupId?: string;
    senderId?: string;
    timestamp?: number;
    eventId?: string;
  } = {},
): LineMessageEvent {
  const number = ++eventSequence;
  return {
    type: "message",
    webhookEventId: options.eventId ?? `physical-event-${number}`,
    deliveryContext: { isRedelivery: false },
    timestamp: options.timestamp ?? 1_000 + number,
    source: {
      type: "group",
      groupId: options.groupId ?? AUTHORIZED_GROUP,
      userId: options.senderId ?? "U-sender-1",
    },
    mode: "active",
    replyToken: `reply-${number}`,
    message: {
      id: `message-${number}`,
      type: "text",
      text,
      quoteToken: `quote-${number}`,
    },
  };
}

function service() {
  const db = makeSupabaseDouble();
  const gateway = makePhysicalInventoryGateway();
  const replies: string[] = [];
  const scheduled: Array<() => Promise<void>> = [];
  const finalized: string[] = [];
  const webhook = new WebhookService(db as never, {
    physicalInventoryService: gateway,
    replyMessage: async (_token, text) => {
      replies.push(text);
    },
    scheduleBackgroundTask: (task) => scheduled.push(task),
    physicalInventoryFinalizer: async ({ sessionId }) => {
      if (!finalized.includes(sessionId)) finalized.push(sessionId);
    },
  });
  return { db, gateway, replies, scheduled, finalized, webhook };
}

describe("P2A Slice C webhook routing", () => {
  test("default routing uses the real Slice B session service RPC integration", async () => {
    const base = makeSupabaseDouble();
    const gateway = makePhysicalInventoryGateway();
    const db = withPhysicalInventoryRpc(base, gateway);
    const replies: string[] = [];
    const webhook = new WebhookService(db as never, {
      replyMessage: async (_token, text) => {
        replies.push(text);
      },
      scheduleBackgroundTask: () => undefined,
      physicalInventoryFinalizer: async () => undefined,
    });

    await webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือวันนี้\n27/7/69"),
      textEvent("1แตงโม\n45.ลูก"),
      textEvent("จบ"),
    ], "destination");

    expect(gateway._sessions).toHaveLength(1);
    expect(gateway._ingests.map((row) => row.kind)).toEqual([
      "header",
      "item",
      "close",
    ]);
    expect(replies[0]).toContain("27/07/2026");
    expect(
      new PhysicalInventorySessionService(db as never),
    ).toBeInstanceOf(PhysicalInventorySessionService);
  });

  test("authorized group header opens a MAIN session and replies", async () => {
    const ctx = service();
    const [result] = await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69"),
    ], "destination");

    expect(result?.parsed).toBe(true);
    expect(ctx.gateway._sessions).toHaveLength(1);
    expect(ctx.gateway._sessions[0]?.warehouse_code).toBe("MAIN");
    expect(ctx.gateway._sessions[0]?.business_date).toBe("2026-07-28");
    expect(ctx.replies).toEqual([
      "เริ่มบันทึกสต๊อกผลไม้คงเหลือวันที่ 28/07/2026 แล้ว",
    ]);
  });

  test("unauthorized group remains outside P2A", async () => {
    const ctx = service();
    const [result] = await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69", { groupId: "C-other" }),
    ], "destination");

    expect(result?.parsed).toBe(false);
    expect(ctx.gateway._sessions).toHaveLength(0);
  });

  test("header redelivery and concurrent identical headers create one session", async () => {
    const ctx = service();
    const header = textEvent("สตอกผลไม้คงเหลือ\n28/7/69", {
      eventId: "same-header-event",
    });
    const [first, second] = await Promise.all([
      ctx.webhook.processEvents([header], "destination"),
      ctx.webhook.processEvents([{ ...header, deliveryContext: { isRedelivery: true } }], "destination"),
    ]);

    expect(ctx.gateway._sessions).toHaveLength(1);
    expect(ctx.gateway._ingests).toHaveLength(1);
    expect([first[0]?.status, second[0]?.status].sort()).toEqual(["duplicate", "saved"]);
    expect(ctx.replies).toHaveLength(1);
  });

  test("sender isolation, duplicate item event, and standalone item fallthrough", async () => {
    const ctx = service();
    await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69", { senderId: "U-one" }),
    ], "destination");

    const item = textEvent("1แตงโม\n45.ลูก", {
      senderId: "U-one",
      eventId: "item-one",
    });
    await ctx.webhook.processEvents([item], "destination");
    await ctx.webhook.processEvents([{ ...item, deliveryContext: { isRedelivery: true } }], "destination");
    await ctx.webhook.processEvents([
      textEvent("2พุทรานม\n2ตะกร้า", { senderId: "U-two" }),
    ], "destination");

    expect(ctx.gateway._ingests.filter((row) => row.kind === "item")).toHaveLength(1);
    expect(ctx.gateway._sessions).toHaveLength(1);
  });

  test("typo close followed by corrected close keeps one boundary", async () => {
    const ctx = service();
    await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69"),
      textEvent("1แตงโม\n45.ลูก"),
      textEvent("จบรายการปลไม้ที่เหลือในบ้าน", { timestamp: 2_000 }),
    ], "destination");
    await ctx.webhook.processEvents([
      textEvent("จบรายการผลไม้ที่เหลือในบ้าน", { timestamp: 2_100 }),
    ], "destination");

    const closeRows = ctx.gateway._ingests.filter((row) => row.kind === "close");
    expect(closeRows).toHaveLength(1);
    expect(ctx.gateway._sessions[0]?.close_event_timestamp_ms).toBe(2_000);
    expect(ctx.scheduled).toHaveLength(2);
    await Promise.all(ctx.scheduled.map((task) => task()));
    expect(ctx.finalized).toHaveLength(1);
  });

  test("late pre-boundary item is admitted; post-boundary item is rejected", async () => {
    const ctx = service();
    await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69", { timestamp: 1_000 }),
      textEvent("จบ", { timestamp: 2_000 }),
    ], "destination");
    await ctx.webhook.processEvents([
      textEvent("1แตงโม\n45.ลูก", { timestamp: 1_900 }),
      textEvent("2พุทรานม\n2ตะกร้า", { timestamp: 2_100 }),
    ], "destination");

    expect(ctx.gateway._ingests.filter((row) => row.kind === "item")).toHaveLength(1);
    expect(ctx.replies.at(-1)).toContain("ส่งหลังคำสั่งจบ");
  });

  test("non-text and unsend events preserve raw audit and do not enter P2A", async () => {
    const ctx = service();
    const sticker = {
      ...textEvent("ignored"),
      message: {
        id: "sticker-1",
        type: "sticker",
        packageId: "1",
        stickerId: "2",
        stickerResourceType: "STATIC",
        quoteToken: "q",
      },
    } as LineEvent;
    const unsend = {
      type: "unsend",
      webhookEventId: "unsend-1",
      deliveryContext: { isRedelivery: false },
      timestamp: 4_000,
      source: { type: "group", groupId: AUTHORIZED_GROUP, userId: "U-one" },
      mode: "active",
      unsend: { messageId: "deleted-message" },
    } as LineEvent;

    await ctx.webhook.processEvents([sticker, unsend], "destination");
    expect(ctx.gateway._sessions).toHaveLength(0);
    expect(ctx.db._rows("raw_messages")).toHaveLength(2);
  });
});
