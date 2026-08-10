/**
 * Slice P4A — the entry gate as the guided close/confirm presses see it.
 *
 * The close boundary is the thing being protected: a refusal here must leave
 * the round in capture with no boundary created, because that is the only
 * state in which a correction is still an ordinary item message.
 */
import { describe, it, expect } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GuidedSessionCaptureService } from "./session-capture";
import type { PendingSessionService } from "@/lib/line/pending-session-service";
import type {
  ProduceSessionCommandService,
  StructuredPendingSession,
} from "@/lib/line/produce-session-commands";
import type { GuidedMenuIdentity } from "./ux-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

const ROUND = "11111111-1111-4111-8111-111111111111";

const IDENTITY: GuidedMenuIdentity = {
  lineUserId: "U-typist",
  sourceType: "group",
  sourceId: "G-1",
  sessionKey: "group:G-1:user:U-typist",
} as GuidedMenuIdentity;

interface MasterRow {
  product_name: string;
  unit: string;
  quantity: number;
  price_per_unit: number | null;
  transaction_type: string;
}

const WITHDRAWAL: MasterRow[] = [
  { product_name: "มังคุด", unit: "โล", quantity: 15.9, price_per_unit: 45, transaction_type: "เบิก" },
];

function pendingRow(accumulatedText: string): StructuredPendingSession {
  return {
    id: "pending-1",
    session_key: "group:G-1:user:U-typist",
    source_id: "G-1",
    accumulated_text: accumulatedText,
    latest_reply_token: null,
    line_user_id: "U-typist",
    created_at: "2026-08-09T10:00:00.000Z",
    updated_at: "2026-08-09T10:00:00.000Z",
    session_generation: "7",
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
    accountability_round_id: ROUND,
    entry_origin: "structured_menu",
    command_contract_version: 1,
    business_date: "2026-08-09",
    transaction_time: "18:00",
    transaction_time_source: "operator_declared",
    staff_label: "ดำ",
    market_label: "ราชพฤกษ์",
    session_kind: "main",
    initial_transaction_type: "คืน",
    declared_transaction_type: null,
    additional_opener: null,
    opened_line_event_id: "evt-open",
  } as StructuredPendingSession;
}

class Harness {
  closeCalls = 0;
  readonly reviews = new Map<string, { presented: string; confirmed: boolean }>();

  constructor(private readonly master: MasterRow[] = WITHDRAWAL) {}

  service(row: StructuredPendingSession): GuidedSessionCaptureService {
    const pending = {
      lookup: async () => ({ session: row, reason: null }),
    } as unknown as PendingSessionService;

    const commands = {
      execute: async (command: { kind: string }) => {
        if (command.kind !== "close") throw new Error(`unexpected command ${command.kind}`);
        this.closeCalls += 1;
        return {
          ok: true,
          kind: "close",
          sessionKey: row.session_key,
          reason: "first_close",
          session: { ...row, close_event_timestamp_ms: 1 },
        };
      },
    } as unknown as ProduceSessionCommandService;

    return new GuidedSessionCaptureService(this.client(), {
      pendingService: pending,
      commandService: commands,
    });
  }

  private client(): AnyClient {
    const reviews = this.reviews;
    const master = this.master;
    return {
      from: (table: string) => {
        if (table === "produce_transactions") {
          const builder = {
            select: () => builder,
            eq: () => builder,
            limit: () => Promise.resolve({ data: master, error: null }),
          };
          return builder;
        }
        const filters: Record<string, string> = {};
        const builder = {
          select: () => builder,
          eq: (column: string, value: string) => {
            filters[column] = String(value);
            return builder;
          },
          maybeSingle: () => {
            const row = reviews.get(filters.validation_digest);
            return Promise.resolve({
              data: row ? { confirmed_at: row.confirmed ? "now" : null } : null,
              error: null,
            });
          },
        };
        return builder;
      },
      rpc: (name: string, params: Record<string, unknown>) => {
        const digest = String(params.p_validation_digest);
        if (name === "record_produce_validation_review") {
          const existing = reviews.get(digest);
          if (!existing) {
            reviews.set(digest, { presented: String(params.p_line_event_id), confirmed: false });
            return Promise.resolve({
              data: { confirmed: false, presented_line_event_id: String(params.p_line_event_id) },
              error: null,
            });
          }
          return Promise.resolve({
            data: { confirmed: existing.confirmed, presented_line_event_id: existing.presented },
            error: null,
          });
        }
        if (name === "confirm_produce_validation_review") {
          const existing = reviews.get(digest);
          if (!existing) return Promise.resolve({ data: { status: "not_found" }, error: null });
          if (existing.confirmed) {
            return Promise.resolve({ data: { status: "already_confirmed" }, error: null });
          }
          existing.confirmed = true;
          return Promise.resolve({ data: { status: "confirmed" }, error: null });
        }
        throw new Error(`unexpected rpc ${name}`);
      },
    } as unknown as AnyClient;
  }
}

const CLEAN_RETURN = ["18:00 ดำ 1.มังคุด45บาท", "", "15.4โล"].join("\n");
const UNKNOWN_UNIT_RETURN = ["18:00 ดำ 1.มังคุด45บาท", "", "15.4โลก"].join("\n");
const PRICE_CHANGE_RETURN = ["18:00 ดำ 1.มังคุด50บาท", "", "15.4โล"].join("\n");

function close(harness: Harness, text: string, lineEventId: string) {
  return harness.service(pendingRow(text)).requestClose({
    identity: IDENTITY,
    lineEventId,
    lineTimestampMs: 1_770_000_000_000,
  });
}

describe("guided close under the P4A gate", () => {
  it("closes a clean round exactly as before", async () => {
    const harness = new Harness();
    const outcome = await close(harness, CLEAN_RETURN, "E1");

    expect(outcome.status).toBe("closed");
    expect(harness.closeCalls).toBe(1);
    expect(harness.reviews.size).toBe(0);
  });

  it("refuses an unknown unit and creates no close boundary", async () => {
    const harness = new Harness();
    const outcome = await close(harness, UNKNOWN_UNIT_RETURN, "E1");

    expect(outcome.status).toBe("validation_failed");
    expect(harness.closeCalls).toBe(0);
    if (outcome.status === "validation_failed") {
      expect(outcome.detail).toContain("โลก");
      expect(outcome.detail).toContain("น่าจะเป็น: โล");
    }
  });

  it("cannot be pushed past an unknown unit by pressing again", async () => {
    const harness = new Harness();
    await close(harness, UNKNOWN_UNIT_RETURN, "E1");
    const second = await close(harness, UNKNOWN_UNIT_RETURN, "E2");

    expect(second.status).toBe("validation_failed");
    expect(harness.closeCalls).toBe(0);
  });

  it("closes once the operator corrects the unit", async () => {
    const harness = new Harness();
    await close(harness, UNKNOWN_UNIT_RETURN, "E1");
    const corrected = await close(harness, CLEAN_RETURN, "E2");

    expect(corrected.status).toBe("closed");
    expect(harness.closeCalls).toBe(1);
  });

  it("shows a price change first and closes on the second press", async () => {
    const harness = new Harness();
    const first = await close(harness, PRICE_CHANGE_RETURN, "E1");

    expect(first.status).toBe("review_required");
    expect(harness.closeCalls).toBe(0);
    if (first.status === "review_required") {
      expect(first.detail).toContain("50");
      expect(first.detail).toContain("45");
    }

    const second = await close(harness, PRICE_CHANGE_RETURN, "E2");
    expect(second.status).toBe("closed");
    expect(harness.closeCalls).toBe(1);
  });

  it("does not treat a redelivery of the presenting event as acknowledgement", async () => {
    const harness = new Harness();
    await close(harness, PRICE_CHANGE_RETURN, "E1");
    const replay = await close(harness, PRICE_CHANGE_RETURN, "E1");

    expect(replay.status).toBe("review_required");
    expect(harness.closeCalls).toBe(0);
  });

  it("refuses rather than closing when the round master cannot be read", async () => {
    const harness = new Harness();
    const service = harness.service(pendingRow(CLEAN_RETURN));
    // A gate that cannot answer must not answer "fine".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: null, error: { message: "down" } }) }) }),
      }),
    };
    const outcome = await service.requestClose({
      identity: IDENTITY,
      lineEventId: "E1",
      lineTimestampMs: 1,
    });

    expect(outcome.status).toBe("validation_failed");
    expect(harness.closeCalls).toBe(0);
  });
});
