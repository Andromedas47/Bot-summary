import { describe, expect, it } from "bun:test";
import {
  ProduceSessionCommandService,
  type ConfirmProduceSessionCommand,
  type ProduceCommandSource,
  type StructuredPendingSession,
} from "./produce-session-commands";
import {
  buildReviewNotConfirmedMessage,
  buildUnconfirmedStructuredCloseMessage,
} from "./pending-session-finalizer";
import { STRUCTURED_TEXT_CLOSE_REFUSED_REPLY } from "./webhook-service";
import { COMMAND_CONTRACT_VERSION } from "@/lib/parsers/weigh-session/seed";

const SOURCE: ProduceCommandSource = {
  type: "user",
  sourceId: "U1",
  lineUserId: "U1",
};

const HELD: StructuredPendingSession = {
  id: "row-1",
  session_key: "dm:U1",
  source_id: "U1",
  accumulated_text: "",
  latest_reply_token: null,
  line_user_id: "U1",
  created_at: "2026-07-28T00:00:00Z",
  updated_at: "2026-07-28T00:00:00Z",
  session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  close_event_timestamp_ms: 1_800_000_005_000,
  close_requested_at: "2026-07-28T00:01:00Z",
  close_line_event_id: "evt-close",
  close_finalize_started_at: null,
  terminalized: false,
  next_attempt_at: "2026-07-28T00:01:08Z",
  close_deadline_at: "2026-07-28T00:01:30Z",
  close_session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  expected_item_count: null,
  ingest_revision: 2,
  entry_origin: "structured_menu",
  command_contract_version: COMMAND_CONTRACT_VERSION,
  business_date: "2026-07-28",
  transaction_time: "09:15",
  transaction_time_source: "operator_declared",
  staff_label: "พี่ดำ",
  market_label: "วิหาร",
  session_kind: "main",
  initial_transaction_type: "เบิก",
  declared_transaction_type: null,
  additional_opener: null,
  opened_line_event_id: "evt-open",
  finalize_hold_until: "2026-07-28T00:11:00Z",
  finalize_confirmed_at: null,
  finalize_confirm_line_event_id: null,
};

type RpcResult = Record<string, unknown>;

class FakeSupabase {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(private readonly rpcResults: Record<string, RpcResult>) {}
  rpc(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    const data = this.rpcResults[name];
    if (data === undefined) {
      return Promise.resolve({ data: null, error: { message: `missing stub ${name}` } });
    }
    return Promise.resolve({ data, error: null });
  }
  from() {
    return {
      select() {
        return {
          eq() {
            return {
              maybeSingle: async () => ({ data: HELD, error: null }),
            };
          },
        };
      },
    };
  }
}

function run(command: ConfirmProduceSessionCommand, rpc: RpcResult) {
  const supabase = new FakeSupabase({
    confirm_produce_structured_finalization: rpc,
  });
  const service = new ProduceSessionCommandService(supabase as never);
  return { supabase, result: service.execute(command, SOURCE) };
}

describe("0050 — confirm command service", () => {
  const CONFIRM: ConfirmProduceSessionCommand = {
    kind: "confirm",
    lineEventId: "evt-confirm-1",
    expectedSessionGeneration: HELD.session_generation,
  };

  it("maps successful confirm without Produce/admission/ingest writes", async () => {
    const confirmed = {
      ...HELD,
      finalize_hold_until: null,
      finalize_confirmed_at: "2026-07-28T00:02:00Z",
      finalize_confirm_line_event_id: "evt-confirm-1",
      next_attempt_at: "2026-07-28T00:02:00Z",
      ingest_revision: 3,
    };
    const { supabase, result } = run(CONFIRM, {
      accepted: true,
      reason: "confirmed",
      session: confirmed,
    });
    expect(await result).toMatchObject({
      ok: true,
      kind: "confirm",
      reason: "confirmed",
    });
    expect(supabase.calls).toEqual([
      {
        name: "confirm_produce_structured_finalization",
        args: {
          p_session_key: "dm:U1",
          p_line_user_id: "U1",
          p_confirm_line_event_id: "evt-confirm-1",
          p_expected_session_generation: HELD.session_generation,
        },
      },
    ]);
  });

  it("maps already_confirmed / hold_expired / not_ready / ownership", async () => {
    expect(
      await run(CONFIRM, { accepted: true, reason: "already_confirmed", session: HELD }).result,
    ).toMatchObject({ ok: true, reason: "already_confirmed" });

    expect(
      await run(CONFIRM, { accepted: false, reason: "hold_expired" }).result,
    ).toMatchObject({ ok: false, reason: "hold_expired" });

    expect(
      await run(CONFIRM, {
        accepted: false,
        reason: "not_ready",
        admission_count: 1,
        ingest_count: 0,
        straggler_count: 0,
      }).result,
    ).toMatchObject({
      ok: false,
      reason: "not_ready",
      admission_count: 1,
      ingest_count: 0,
    });

    expect(
      await run(CONFIRM, { accepted: false, reason: "ownership_conflict" }).result,
    ).toMatchObject({ ok: false, reason: "ownership_conflict" });
  });

  it("refuses blank confirm event ids before any RPC", async () => {
    const { supabase, result } = run(
      { kind: "confirm", lineEventId: "  " },
      { accepted: true, reason: "confirmed", session: HELD },
    );
    expect(await result).toMatchObject({ ok: false, reason: "invalid_command" });
    expect(supabase.calls).toHaveLength(0);
  });
});

describe("0050 — finalizer messaging", () => {
  it("uses a dedicated reply for review_not_confirmed", () => {
    expect(buildReviewNotConfirmedMessage()).toContain("ยืนยัน");
    expect(buildReviewNotConfirmedMessage()).toContain("ไม่บันทึก");
  });

  it("uses a dedicated reply for unconfirmed_structured_close", () => {
    expect(buildUnconfirmedStructuredCloseMessage()).toContain("ไม่ยืนยัน");
    expect(buildUnconfirmedStructuredCloseMessage()).toContain("ไม่บันทึก");
  });
});

describe("0050 — text close cannot bypass structured confirmation", () => {
  it("exports a clear refusal for plain จบรายการ on structured sessions", () => {
    expect(STRUCTURED_TEXT_CLOSE_REFUSED_REPLY).toContain("เมนู");
    expect(STRUCTURED_TEXT_CLOSE_REFUSED_REPLY).toContain("ไม่รับคำสั่งจบจากข้อความ");
  });

  it("refuses text close before append/admit/ingest on structured rows", async () => {
    const source = await Bun.file(
      new URL("./webhook-service.ts", import.meta.url),
    ).text();
    const guard = source.indexOf("text close refused for structured produce session");
    const append = source.indexOf("pendingService.append(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(append);
    expect(source).toContain("STRUCTURED_TEXT_CLOSE_REFUSED_REPLY");
    expect(source).toContain("markClose");
    expect(source).toContain("entry_origin != null");
  });

  it("DB try_finalize fail-closes unconfirmed structured closes", async () => {
    const migration = await Bun.file(
      new URL(
        "../../../supabase/migrations/0050_produce_finalization_hold.sql",
        import.meta.url,
      ),
    ).text();
    expect(migration).toContain("unconfirmed_structured_close");
    const tryIdx = migration.indexOf("try_finalize_pending_generation");
    const bypassIdx = migration.indexOf("unconfirmed_structured_close", tryIdx);
    const insertIdx = migration.indexOf("INSERT INTO public.produce_sessions", tryIdx);
    expect(bypassIdx).toBeGreaterThan(tryIdx);
    expect(insertIdx).toBeGreaterThan(bypassIdx);
  });
});

describe("0050 — command surface includes confirm", () => {
  it("exposes open, append, close, confirm and status", async () => {
    const source = await Bun.file(
      new URL("./produce-session-commands.ts", import.meta.url),
    ).text();
    const kinds = [...source.matchAll(/kind: "(\w+)";/g)].map((m) => m[1]);
    expect([...new Set(kinds)].sort()).toEqual([
      "append",
      "close",
      "confirm",
      "open",
      "status",
    ]);
  });
});
