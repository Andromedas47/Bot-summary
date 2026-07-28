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
const P2A_FORBIDDEN_WRITE_TABLES = new Set([
  "produce_sessions",
  "produce_items",
  "produce_transactions",
  "inventory_movements",
]);

function makeSupabaseDouble() {
  const rows: Record<string, Row[]> = {
    raw_messages: [],
    parse_errors: [],
    pending_sessions: [],
    manual_slip_sessions: [],
    manual_slip_entries: [],
  };
  const legacyAppends: Array<{ sessionKey: string; text: string }> = [];
  let sequence = 0;

  function query(table: string) {
    let inserted: Row | null = null;
    let update: Row | null = null;
    let includeExactCount = false;
    const filters: Array<[string, unknown]> = [];
    const api: Record<string, unknown> = {};

    const selected = () => (rows[table] ?? []).filter((row) =>
      filters.every(([column, value]) => row[column] === value));
    const result = () => {
      if (update) {
        for (const row of selected()) Object.assign(row, update);
      }
      return {
        data: inserted ? [inserted] : selected(),
        error: null,
        count: includeExactCount ? selected().length : null,
      };
    };

    api.insert = (value: Row) => {
      if (P2A_FORBIDDEN_WRITE_TABLES.has(table)) {
        throw new Error(`forbidden P2A write to ${table}`);
      }
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
      if (P2A_FORBIDDEN_WRITE_TABLES.has(table)) {
        throw new Error(`forbidden P2A write to ${table}`);
      }
      update = value;
      return api;
    };
    api.select = (_columns?: string, options?: { count?: string }) => {
      includeExactCount = options?.count === "exact";
      return api;
    };
    api.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return api;
    };
    api.in = () => api;
    api.gte = () => api;
    api.gt = () => api;
    api.lte = () => api;
    api.lt = () => api;
    api.neq = () => api;
    api.not = () => api;
    api.is = () => api;
    api.or = () => api;
    api.order = () => api;
    api.limit = () => api;
    api.range = () => api;
    api.upsert = (value: Row | Row[]) => {
      if (P2A_FORBIDDEN_WRITE_TABLES.has(table)) {
        throw new Error(`forbidden P2A write to ${table}`);
      }
      const values = Array.isArray(value) ? value : [value];
      (rows[table] ??= []).push(...values);
      return api;
    };
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
      return query(table);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "append_pending_session") {
        const sessionKey = String(args.p_session_key);
        const session = rows.pending_sessions!.find(
          (row) => row.session_key === sessionKey,
        );
        if (!session) {
          return {
            data: { accepted: false, reason: "not_found", session: null },
            error: null,
          };
        }
        const text = String(args.p_new_text);
        legacyAppends.push({ sessionKey, text });
        session.accumulated_text = `${String(session.accumulated_text)}\n${text}`;
        session.updated_at = new Date().toISOString();
        return {
          data: { accepted: true, reason: "appended", session },
          error: null,
        };
      }
      throw new Error(`unexpected base RPC ${name}`);
    },
    _seed(table: string, row: Row) {
      (rows[table] ??= []).push(row);
    },
    _rows(table: string) {
      return rows[table] ?? [];
    },
    _legacyAppends: legacyAppends,
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
      return base.rpc(name, args);
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

function seedLegacyProduceSession(
  db: ReturnType<typeof makeSupabaseDouble>,
  header: string,
  senderId = "U-sender-1",
): void {
  const now = new Date().toISOString();
  db._seed("pending_sessions", {
    id: `legacy-${senderId}`,
    session_key: `group:${AUTHORIZED_GROUP}:user:${senderId}`,
    source_id: AUTHORIZED_GROUP,
    accumulated_text: header,
    latest_reply_token: null,
    line_user_id: senderId,
    created_at: now,
    updated_at: now,
    session_generation: `40000000-0000-4000-8000-${senderId.padEnd(12, "0").slice(0, 12)}`,
    close_event_timestamp_ms: null,
    close_requested_at: null,
    close_line_event_id: null,
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: null,
    close_deadline_at: null,
    close_session_generation: null,
    expected_item_count: null,
    ingest_revision: 1,
    finalization_started_at: null,
    finalized_at: null,
    finalization_status: "pending",
    finalization_error: null,
    finalized_produce_session_id: null,
  });
}

function seedManualSlipSession(
  db: ReturnType<typeof makeSupabaseDouble>,
  senderId = "U-sender-1",
): void {
  db._seed("manual_slip_sessions", {
    id: "manual-session-1",
    source_id: AUTHORIZED_GROUP,
    business_date: "2026-07-28",
    market_key: "market-1",
    market_label: "ตลาด 1",
    status: "open",
    opened_by_line_user_id: senderId,
    opened_line_message_id: "manual-open-1",
  });
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
    replyMessages: async (_token, texts) => {
      replies.push(...texts);
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
    const results = await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69", { groupId: "C-other" }),
      textEvent("1แตงโม\n45.ลูก", { groupId: "C-other" }),
      textEvent("จบ", { groupId: "C-other" }),
    ], "destination");

    expect(results.every((result) => result.parsed !== true)).toBe(true);
    expect(ctx.gateway._sessions).toHaveLength(0);
    expect(ctx.gateway._ingests).toHaveLength(0);
  });

  for (const legacy of [
    {
      label: "withdrawal",
      header: "กี้-ตลาดหนึ่ง เบิก 28/7/2569",
      item: "1.มังคุด80บาท\n3.9.โล",
    },
    {
      label: "good return",
      header: "กี้-ตลาดหนึ่ง คืน 28/7/2569",
      item: "1.มังคุด\n3.9.โล",
    },
    {
      label: "damaged return",
      header: "กี้-ตลาดหนึ่ง คืนเสีย 28/7/2569",
      item: "1.มังคุด\n3.9.โล",
    },
  ]) {
    test(`active ${legacy.label} owns its numeric item during defensive overlap`, async () => {
      const ctx = service();
      await ctx.webhook.processEvents([
        textEvent("สตอกผลไม้คงเหลือ\n28/7/69"),
      ], "destination");
      seedLegacyProduceSession(ctx.db, legacy.header);

      await ctx.webhook.processEvents([
        textEvent(legacy.item),
      ], "destination");

      expect(
        ctx.gateway._ingests.filter((row) => row.kind === "item"),
      ).toHaveLength(0);
      expect(ctx.db._legacyAppends.map((row) => row.text)).toEqual([legacy.item]);
      expect(ctx.gateway._sessions[0]?.status).toBe("open");
    });
  }

  test("active manual slip owns compact numeric amounts during defensive overlap", async () => {
    const ctx = service();
    await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69"),
    ], "destination");
    seedManualSlipSession(ctx.db);

    await ctx.webhook.processEvents([
      textEvent("1.90"),
    ], "destination");

    expect(
      ctx.gateway._ingests.filter((row) => row.kind === "item"),
    ).toHaveLength(0);
    expect(ctx.db._rows("manual_slip_entries")).toHaveLength(1);
    expect(ctx.db._rows("manual_slip_entries")[0]?.amount).toBe(90);
  });

  test("active legacy session prevents a P2A header from opening", async () => {
    const ctx = service();
    seedLegacyProduceSession(
      ctx.db,
      "กี้-ตลาดหนึ่ง เบิก 28/7/2569",
    );

    await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69"),
    ], "destination");

    expect(ctx.gateway._sessions).toHaveLength(0);
    expect(ctx.gateway._ingests).toHaveLength(0);
    expect(ctx.db._legacyAppends.at(-1)?.text).toContain("สตอกผลไม้คงเหลือ");
  });

  test("active P2A blocks a new legacy header with one clear reply", async () => {
    const ctx = service();
    await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69"),
    ], "destination");
    const legacyHeader = textEvent("กี้-ตลาดหนึ่ง เบิก 28/7/2569", {
      eventId: "blocked-legacy-header",
    });

    await ctx.webhook.processEvents([legacyHeader], "destination");
    await ctx.webhook.processEvents([
      { ...legacyHeader, deliveryContext: { isRedelivery: true } },
    ], "destination");

    expect(ctx.gateway._sessions).toHaveLength(1);
    expect(ctx.db._rows("pending_sessions")).toHaveLength(0);
    expect(ctx.replies.filter((reply) =>
      reply.includes("กรุณาปิดรายการสต๊อกก่อนเริ่มรายการอื่น")
    )).toHaveLength(1);
  });

  test("legacy owner keeps bare close away from an overlapping P2A session", async () => {
    const ctx = service();
    await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69"),
    ], "destination");
    seedLegacyProduceSession(
      ctx.db,
      "กี้-ตลาดหนึ่ง เบิก 28/7/2569",
    );

    await ctx.webhook.processEvents([textEvent("จบ")], "destination");

    expect(
      ctx.gateway._ingests.filter((row) => row.kind === "close"),
    ).toHaveLength(0);
    expect(ctx.db._legacyAppends.at(-1)?.text).toBe("จบ");
    expect(ctx.gateway._sessions[0]?.status).toBe("open");
    expect(ctx.gateway._sessions[0]?.close_event_timestamp_ms).toBeNull();
  });

  test("P2A-only session admits a parser-recognized stock item", async () => {
    const ctx = service();
    await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69"),
      textEvent("1แตงโม\n45.ลูก"),
    ], "destination");

    expect(
      ctx.gateway._ingests.filter((row) => row.kind === "item"),
    ).toHaveLength(1);
  });

  test("P2A-only session does not admit a Produce-priced item", async () => {
    const ctx = service();
    await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69"),
      textEvent("1.มังคุด80บาท\n3.9.โล"),
    ], "destination");

    expect(
      ctx.gateway._ingests.filter((row) => row.kind === "item"),
    ).toHaveLength(0);
  });

  test("numeric normal chat with no active session remains outside P2A", async () => {
    const ctx = service();
    const [result] = await ctx.webhook.processEvents([
      textEvent("123"),
    ], "destination");

    expect(result?.parsed).toBe(false);
    expect(ctx.gateway._sessions).toHaveLength(0);
    expect(ctx.gateway._ingests).toHaveLength(0);
  });

  test("stock and sales summary commands bypass an active P2A session", async () => {
    const ctx = service();
    await ctx.webhook.processEvents([
      textEvent("สตอกผลไม้คงเหลือ\n28/7/69"),
    ], "destination");
    const before = ctx.gateway._ingests.length;

    const results = await ctx.webhook.processEvents([
      textEvent("สรุปคงเหลือ 28/07/2569"),
      textEvent("สรุปยอดขาย 28/07/2569"),
    ], "destination");

    expect(results.every((result) => result.status === "saved")).toBe(true);
    expect(ctx.gateway._ingests).toHaveLength(before);
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
