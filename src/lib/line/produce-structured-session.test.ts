import { describe, expect, it } from "bun:test";
import {
  ProduceSessionCommandService,
  containsProduceHeader,
  produceSessionKey,
  type ProduceCommandSource,
  type ProduceSessionCommand,
  type StructuredPendingSession,
} from "./produce-session-commands";
import {
  COMMAND_CONTRACT_VERSION,
  buildSeedFromStructuredMetadata,
  isStructuredSession,
} from "@/lib/parsers/weigh-session/seed";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { computeItemHash, computeSessionHash } from "@/lib/line/session-dedup-service";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STRUCTURED_MAIN: StructuredPendingSession = {
  id: "row-1",
  session_key: "dm:U1",
  source_id: "U1",
  accumulated_text: "",
  latest_reply_token: null,
  line_user_id: "U1",
  created_at: "2026-07-28T03:00:00.000Z",
  updated_at: "2026-07-28T03:00:00.000Z",
  session_generation: "11111111-1111-1111-1111-111111111111",
  close_event_timestamp_ms: null,
  close_requested_at: null,
  close_line_event_id: null,
  close_finalize_started_at: null,
  terminalized: false,
  next_attempt_at: null,
  close_deadline_at: null,
  close_session_generation: null,
  expected_item_count: null,
  ingest_revision: 0,
  entry_origin: "structured_menu",
  command_contract_version: COMMAND_CONTRACT_VERSION,
  business_date: "2026-07-28",
  transaction_time: "09:15",
  transaction_time_source: "operator_declared",
  staff_label: "พี่ดำ",
  market_label: "วิหาร",
  session_kind: "main",
  declared_transaction_type: null,
  additional_opener: null,
  opened_line_event_id: "evt-open-1",
};

const LEGACY_ROW: StructuredPendingSession = {
  ...STRUCTURED_MAIN,
  id: "row-legacy",
  accumulated_text: "พี่ดำ-วิหาร เบิก 10/6/2569",
  entry_origin: null,
  command_contract_version: null,
  business_date: null,
  transaction_time: null,
  transaction_time_source: null,
  staff_label: null,
  market_label: null,
  session_kind: null,
  declared_transaction_type: null,
  additional_opener: null,
  opened_line_event_id: null,
};

const SOURCE: ProduceCommandSource = {
  type: "user",
  sourceId: "U1",
  lineUserId: "U1",
};

interface RpcCall { name: string; params: Record<string, unknown> }

function fakeSupabase(options: {
  row?: StructuredPendingSession | null;
  rpcResults?: Record<string, unknown>;
}) {
  const calls: RpcCall[] = [];
  const tableWrites: string[] = [];
  const client = {
    calls,
    tableWrites,
    rpc(name: string, params: Record<string, unknown>) {
      calls.push({ name, params });
      return Promise.resolve({ data: options.rpcResults?.[name] ?? null, error: null });
    },
    from(table: string) {
      if (table !== "pending_sessions") tableWrites.push(table);
      const builder = {
        select: () => builder,
        eq: () => builder,
        insert: (payload: unknown) => { tableWrites.push(`${table}:insert`); return Promise.resolve({ data: payload, error: null }); },
        maybeSingle: () => Promise.resolve({ data: options.row ?? null, error: null }),
      };
      return builder;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any;
}

function run(
  command: ProduceSessionCommand,
  source: ProduceCommandSource,
  options: Parameters<typeof fakeSupabase>[0],
) {
  const supabase = fakeSupabase(options);
  const service = new ProduceSessionCommandService(supabase);
  return { supabase, result: service.execute(command, source) };
}

const OPEN_MAIN: ProduceSessionCommand = {
  kind: "open",
  sessionKind: "main",
  declaredTransactionType: null,
  additionalOpener: null,
  businessDate: "2026-07-28",
  transactionTime: "09:15",
  transactionTimeSource: "operator_declared",
  staffLabel: "พี่ดำ",
  marketLabel: "วิหาร",
  lineEventId: "evt-open-1",
  lineTimestampMs: 1_800_000_000_000,
};

// ── 1/2. Historical rows stay legacy ──────────────────────────────────────────

describe("0049 — legacy rows are never marked structured", () => {
  it("treats a row with entry_origin NULL as legacy", () => {
    expect(isStructuredSession(LEGACY_ROW)).toBe(false);
    expect(buildSeedFromStructuredMetadata(LEGACY_ROW)).toBeNull();
  });

  it("treats a row with no structured columns at all as legacy", () => {
    // A client that predates the 0049 columns reads them as undefined.
    expect(isStructuredSession({})).toBe(false);
    expect(isStructuredSession(null)).toBe(false);
    expect(buildSeedFromStructuredMetadata(undefined)).toBeNull();
  });
});

// ── 3. Completeness is enforced, and a partial row is never trusted ───────────

describe("0049 — structured completeness", () => {
  it("accepts only a complete, contract-compatible row", () => {
    expect(isStructuredSession(STRUCTURED_MAIN)).toBe(true);
  });

  it("rejects every partially populated variant", () => {
    const required: Array<keyof StructuredPendingSession> = [
      "command_contract_version",
      "business_date",
      "transaction_time",
      "transaction_time_source",
      "staff_label",
      "market_label",
      "session_kind",
      "opened_line_event_id",
    ];
    for (const field of required) {
      expect(isStructuredSession({ ...STRUCTURED_MAIN, [field]: null })).toBe(false);
    }
    expect(isStructuredSession({ ...STRUCTURED_MAIN, staff_label: "   " })).toBe(false);
    expect(isStructuredSession({ ...STRUCTURED_MAIN, market_label: "" })).toBe(false);
  });

  it("refuses a future contract version instead of half-trusting it", () => {
    expect(isStructuredSession({
      ...STRUCTURED_MAIN,
      command_contract_version: COMMAND_CONTRACT_VERSION + 1,
    })).toBe(false);
  });
});

// ── 4/5. Open idempotency and rotation ────────────────────────────────────────

describe("0049 — atomic open / rotate command", () => {
  it("reports idempotent when LINE redelivers the same open event", async () => {
    const { result } = run(OPEN_MAIN, SOURCE, {
      rpcResults: {
        open_or_rotate_produce_structured_session: {
          outcome: "idempotent",
          rotated: false,
          reason: "duplicate_open_event",
          session_generation: STRUCTURED_MAIN.session_generation,
        },
      },
    });
    const value = await result;
    expect(value).toEqual({
      ok: true,
      kind: "open",
      outcome: "idempotent",
      sessionKey: "dm:U1",
      sessionGeneration: STRUCTURED_MAIN.session_generation,
    });
  });

  it("passes the full typed metadata set and the contract version to the RPC", async () => {
    const { supabase, result } = run(OPEN_MAIN, SOURCE, {
      rpcResults: {
        open_or_rotate_produce_structured_session: {
          outcome: "opened", session_generation: "gen-2",
        },
      },
    });
    await result;
    const call = supabase.calls[0] as RpcCall;
    expect(call.name).toBe("open_or_rotate_produce_structured_session");
    expect(call.params.p_command_contract_version).toBe(COMMAND_CONTRACT_VERSION);
    for (const key of [
      "p_business_date", "p_transaction_time", "p_transaction_time_source",
      "p_staff_label", "p_market_label", "p_session_kind", "p_opened_line_event_id",
      "p_source_type", "p_source_id", "p_line_user_id",
    ]) {
      expect(call.params[key]).not.toBeUndefined();
    }
  });

  it("surfaces ownership and generation conflicts as refusals", async () => {
    for (const [outcome, reason] of [
      ["ownership_conflict", "ownership_conflict"],
      ["generation_conflict", "generation_conflict"],
    ] as const) {
      const { result } = run(OPEN_MAIN, SOURCE, {
        rpcResults: {
          open_or_rotate_produce_structured_session: { outcome, session_generation: "g" },
        },
      });
      expect((await result)).toMatchObject({ ok: false, reason });
    }
  });
});

// ── 6. Main and additional invariants ─────────────────────────────────────────

describe("0049 — main and additional invariants", () => {
  it("refuses an additional open without a declared type and opener", async () => {
    const { result } = run(
      { ...OPEN_MAIN, sessionKind: "additional" },
      SOURCE,
      { rpcResults: {} },
    );
    expect(await result).toMatchObject({ ok: false, reason: "invalid_command" });
  });

  it("refuses a main open that declares a transaction type", async () => {
    const { result } = run(
      { ...OPEN_MAIN, declaredTransactionType: "เบิก" },
      SOURCE,
      { rpcResults: {} },
    );
    expect(await result).toMatchObject({ ok: false, reason: "invalid_command" });
  });

  it("accepts a well-formed additional open — the service does not restrict kinds to main", async () => {
    const { result } = run(
      {
        ...OPEN_MAIN,
        sessionKind: "additional",
        declaredTransactionType: "เบิก",
        additionalOpener: "เบิกเพิ่ม",
      },
      SOURCE,
      {
        rpcResults: {
          open_or_rotate_produce_structured_session: {
            outcome: "opened", session_generation: "gen-add",
          },
        },
      },
    );
    expect(await result).toMatchObject({ ok: true, outcome: "opened" });
  });
});

// ── 7. A textual header inside a structured session is refused ────────────────

describe("0049 — structured sessions refuse a text header", () => {
  it("refuses before append, admission or ingest happen", async () => {
    const { supabase, result } = run(
      {
        kind: "append",
        text: "พี่ดำ-วิหาร เบิก 10/6/2569",
        lineEventId: "evt-2",
        lineTimestampMs: 1_800_000_001_000,
      },
      SOURCE,
      { row: STRUCTURED_MAIN },
    );

    expect(await result).toMatchObject({ ok: false, reason: "structured_header_refused" });
    // No append RPC, and nothing written to either ledger.
    expect(supabase.calls).toHaveLength(0);
    expect(supabase.tableWrites).toHaveLength(0);
  });

  it("still appends ordinary item text", async () => {
    const { supabase, result } = run(
      {
        kind: "append",
        text: "1.แตงโม10บาท\n1โล",
        lineEventId: "evt-3",
        lineTimestampMs: 1_800_000_002_000,
      },
      SOURCE,
      {
        row: STRUCTURED_MAIN,
        rpcResults: { append_pending_session: { accepted: true, session: STRUCTURED_MAIN } },
      },
    );
    expect(await result).toMatchObject({ ok: true, kind: "append" });
    expect(supabase.calls[0].name).toBe("append_pending_session");
  });

  it("recognises headers but not closers", () => {
    expect(containsProduceHeader("พี่ดำ-วิหาร เบิก 10/6/2569")).toBe(true);
    expect(containsProduceHeader("1.แตงโม10บาท")).toBe(false);
    expect(containsProduceHeader("จบรายการเบิก")).toBe(false);
  });

  it("refuses to drive a legacy row with structured commands", async () => {
    const { result } = run(
      { kind: "append", text: "1.แตงโม10บาท", lineEventId: "e", lineTimestampMs: 1 },
      SOURCE,
      { row: LEGACY_ROW },
    );
    expect(await result).toMatchObject({ ok: false, reason: "not_structured" });
  });
});

// ── 17. Missing identity fails closed ─────────────────────────────────────────

describe("0049 — identity is mandatory", () => {
  it("fails closed when a menu command has no line_user_id", async () => {
    for (const type of ["user", "group", "room"] as const) {
      const { supabase, result } = run(
        OPEN_MAIN,
        { type, sourceId: "C1", groupId: "C1", roomId: "C1", lineUserId: null },
        { rpcResults: {} },
      );
      expect(await result).toMatchObject({ ok: false, reason: "missing_line_user_id" });
      expect(supabase.calls).toHaveLength(0);
    }
  });

  it("keeps group, room and user source types explicit in the session key", () => {
    expect(produceSessionKey({ type: "user", sourceId: "U1", lineUserId: "U1" })).toBe("dm:U1");
    expect(produceSessionKey({ type: "group", sourceId: "C1", groupId: "C1", lineUserId: "U1" }))
      .toBe("group:C1:user:U1");
    expect(produceSessionKey({ type: "room", sourceId: "R1", roomId: "R1", lineUserId: "U1" }))
      .toBe("room:R1:user:U1");
    // Fail closed, never fall back to a shared group-only key.
    expect(produceSessionKey({ type: "group", sourceId: "C1", groupId: "C1", lineUserId: null }))
      .toBeNull();
    expect(produceSessionKey({ type: "group", sourceId: "C1", groupId: null, lineUserId: "U1" }))
      .toBeNull();
  });
});

// ── 20. No cancel, no hard delete ─────────────────────────────────────────────

describe("0049 — command surface", () => {
  it("exposes exactly open, append, close and status", async () => {
    const source = await Bun.file(
      new URL("./produce-session-commands.ts", import.meta.url),
    ).text();
    const kinds = [...source.matchAll(/kind: "(\w+)";/g)].map((m) => m[1]);
    expect([...new Set(kinds)].sort()).toEqual(["append", "close", "open", "status"]);
    expect(source).not.toContain('"cancel"');
    expect(source).not.toMatch(/\.delete\(/);
  });
});

// ── 13/14/15/16. Parser seeding and legacy compatibility ─────────────────────

describe("0049 — parser seed", () => {
  const seed = buildSeedFromStructuredMetadata(STRUCTURED_MAIN)!;

  it("carries every parser state, not a convenient subset", () => {
    expect(Object.keys(seed).sort()).toEqual([
      "additional_opener",
      "current_section",
      "current_transaction_type",
      "date",
      "declared_transaction_type",
      "sender_name",
      "session_kind",
      "session_title",
      "staff_name",
      "transaction_time",
      "transaction_time_source",
    ]);
  });

  it("parses item-only text with no header and synthesizes nothing", () => {
    const parsed = parseWeighSession("1.แตงโม10บาท\n1โล", null, null, seed);
    expect(parsed.staff_name).toBe("พี่ดำ");
    expect(parsed.session_title).toBe("วิหาร");
    expect(parsed.date).toBe("2026-07-28");
    expect(parsed.transaction_time).toBe("09:15");
    expect(parsed.session_kind).toBe("main");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.parse_errors).toEqual([]);
  });

  it("does not let a later text header replace immutable seeded metadata", () => {
    // The refusal itself happens one layer up, in the command service, which
    // never lets header text reach append/admit/ingest. This proves the second
    // line of defence: even if such text were parsed, the seeded identity,
    // market and date survive it untouched.
    const parsed = parseWeighSession(
      "1.แตงโม10บาท\n1โล\nสมชาย-ตลาดอื่น เบิก 1/1/2569",
      null,
      null,
      seed,
    );
    expect(parsed.staff_name).toBe("พี่ดำ");
    expect(parsed.session_title).toBe("วิหาร");
    expect(parsed.date).toBe("2026-07-28");
    expect(parsed.transaction_time).toBe("09:15");
    expect(parsed.items).toHaveLength(1);
  });

  it("rejects a header inside a seeded additional batch outright", () => {
    const additionalSeed = buildSeedFromStructuredMetadata({
      ...STRUCTURED_MAIN,
      session_kind: "additional",
      declared_transaction_type: "เบิก",
      additional_opener: "เบิกเพิ่ม",
    })!;
    const parsed = parseWeighSession(
      "1.แตงโม10บาท\n1โล\nสมชาย-ตลาดอื่น เบิก 1/1/2569",
      null,
      null,
      additionalSeed,
    );
    expect(parsed.staff_name).toBe("พี่ดำ");
    expect(parsed.parse_errors.length).toBeGreaterThan(0);
  });

  it("keeps a seeded additional batch on its declared type", () => {
    const additionalSeed = buildSeedFromStructuredMetadata({
      ...STRUCTURED_MAIN,
      session_kind: "additional",
      declared_transaction_type: "คืน",
      additional_opener: "ชั่งคืนเพิ่ม",
    })!;
    const parsed = parseWeighSession("1.แตงโม10บาท\n1โล", null, null, additionalSeed);
    expect(parsed.session_kind).toBe("additional");
    expect(parsed.declared_transaction_type).toBe("คืน");
    expect(parsed.items[0].transaction_type).toBe("คืน");
  });

  it("leaves the unseeded legacy parse byte-for-byte unchanged", () => {
    const legacyText = [
      "พี่ดำ-วิหาร เบิก 10/6/2569",
      "1.แตงโม10บาท",
      "1โล",
      "จบรายการเบิก",
    ].join("\n");

    const withDefaultArg = parseWeighSession(legacyText, "2026-06-10", "08:00");
    const withExplicitNull = parseWeighSession(legacyText, "2026-06-10", "08:00", null);

    expect(withExplicitNull).toEqual(withDefaultArg);
    expect(withDefaultArg.staff_name).toBe("พี่ดำ");
    expect(withDefaultArg.session_title).toBe("วิหาร");
    expect(withDefaultArg.session_kind).toBe("main");
    expect(withDefaultArg.items).toHaveLength(1);
    expect(withDefaultArg.parse_errors).toEqual([]);
  });

  it("keeps hash semantics unchanged for the legacy path", () => {
    const legacyText = [
      "พี่ดำ-วิหาร เบิก 10/6/2569",
      "1.แตงโม10บาท",
      "1โล",
      "จบรายการเบิก",
    ].join("\n");
    const a = parseWeighSession(legacyText, "2026-06-10", "08:00");
    const b = parseWeighSession(legacyText, "2026-06-10", "08:00", null);

    expect(computeSessionHash(a)).toBe(computeSessionHash(b));
    expect(computeItemHash(a, a.items[0])).toBe(computeItemHash(b, b.items[0]));
  });

  it("hashes a seeded session through the same unmodified functions", () => {
    // Same observable session, reached with and without a seed: the hash is a
    // function of the parsed result only, so seeding cannot move it.
    const seededParse = parseWeighSession("1.แตงโม10บาท\n1โล", null, null, seed);
    const textParse = parseWeighSession(
      "พี่ดำ-วิหาร เบิก 28/7/2569\n1.แตงโม10บาท\n1โล",
      null,
      "09:15",
    );
    expect(seededParse.date).toBe(textParse.date);
    expect(computeSessionHash(seededParse)).toBe(computeSessionHash(textParse));
  });
});
