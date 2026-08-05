import { describe, expect, test } from "bun:test";
import { sweepPurchaseCaptureEligibility } from "./eligibility-sweep";

type Row = Record<string, unknown>;

function makeSupabaseStub(params: {
  dueSessions: Row[];
  candidates: Record<string, Row | { error: string }>;
}) {
  const { dueSessions, candidates } = params;
  return {
    from(table: string) {
      if (table !== "purchase_capture_sessions") throw new Error(`unexpected table ${table}`);
      const api: Record<string, unknown> = {};
      api.select = () => api;
      api.eq = () => api;
      api.or = () => api;
      api.order = () => api;
      api.limit = async () => ({ data: dueSessions, error: null });
      return api;
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (name !== "get_purchase_capture_finalize_candidate") {
        throw new Error(`unexpected rpc ${name}`);
      }
      const sessionId = String(args.p_session_id);
      const candidate = candidates[sessionId];
      if (!candidate) throw new Error(`no candidate stub for ${sessionId}`);
      if ("error" in candidate) {
        return Promise.resolve({ data: null, error: { message: candidate.error } });
      }
      return Promise.resolve({ data: candidate, error: null });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function candidateRow(overrides: Partial<Row> = {}): Row {
  return {
    session_id: "s1",
    session_generation: "g1",
    status: "closing",
    ingest_revision: 3,
    ingest_set_hash: "hash",
    close_event_timestamp_ms: 1000,
    close_quiet_until: "2026-01-01T00:00:08.000Z",
    close_deadline_at: "2026-01-01T00:00:30.000Z",
    quiet_elapsed: true,
    deadline_elapsed: false,
    eligible_for_finalize: true,
    ingests: [],
    ...overrides,
  };
}

describe("sweepPurchaseCaptureEligibility", () => {
  test("no due sessions → zeroed result", async () => {
    const supabase = makeSupabaseStub({ dueSessions: [], candidates: {} });
    const result = await sweepPurchaseCaptureEligibility(supabase);
    expect(result).toEqual({ due: 0, eligible: 0, pending: 0, errors: 0 });
  });

  test("splits eligible vs pending sessions correctly", async () => {
    const supabase = makeSupabaseStub({
      dueSessions: [
        { id: "s1", session_generation: "g1" },
        { id: "s2", session_generation: "g2" },
      ],
      candidates: {
        s1: candidateRow({ session_id: "s1", eligible_for_finalize: true }),
        s2: candidateRow({
          session_id: "s2",
          quiet_elapsed: false,
          eligible_for_finalize: false,
        }),
      },
    });
    const result = await sweepPurchaseCaptureEligibility(supabase);
    expect(result).toEqual({ due: 2, eligible: 1, pending: 1, errors: 0 });
  });

  test("never parses, never transitions, never sends LINE — only counts eligibility", async () => {
    const supabase = makeSupabaseStub({
      dueSessions: [{ id: "s1", session_generation: "g1" }],
      candidates: { s1: candidateRow() },
    });
    let rpcCalls = 0;
    const wrapped = {
      ...supabase,
      rpc(name: string, args: Record<string, unknown>) {
        rpcCalls += 1;
        return supabase.rpc(name, args);
      },
    };
    await sweepPurchaseCaptureEligibility(wrapped);
    // Exactly one RPC call per due session: the read-only finalize-candidate
    // lookup. No finalize/confirm/post RPC exists to accidentally call.
    expect(rpcCalls).toBe(1);
  });

  test("a candidate lookup failure is counted as an error, not thrown", async () => {
    const supabase = makeSupabaseStub({
      dueSessions: [
        { id: "s1", session_generation: "g1" },
        { id: "s2", session_generation: "g2" },
      ],
      candidates: {
        s1: { error: "generation_conflict" },
        s2: candidateRow({ session_id: "s2" }),
      },
    });
    const result = await sweepPurchaseCaptureEligibility(supabase);
    expect(result).toEqual({ due: 2, eligible: 1, pending: 0, errors: 1 });
  });
});
