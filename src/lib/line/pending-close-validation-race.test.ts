/**
 * Unit regression for the 2026-08-30 stale close-validation race.
 *
 * Production evidence: the close was admitted at 06:13:30.544Z while items
 * whose LINE timestamps preceded it kept committing until 06:13:36.980Z. The
 * boundary landed on a document the entry gate never validated, and the
 * finalizer later terminalized the session with
 * validation_errors = ["entry validation review was never confirmed"].
 *
 * The SQL semantics are proven end-to-end in
 * migration-produce-close-validation-race.pg.test.ts against real PostgreSQL.
 * This file pins the TypeScript side: which arguments cross the RPC boundary,
 * how refusals are typed, and the ordering guarantee that a presented review
 * parks finalization BEFORE any terminal validation error is recorded.
 */
import { describe, expect, it } from "bun:test";
import {
  PendingSessionService,
  PendingSessionStaleValidationSnapshotError,
} from "./pending-session-service";

type Row = Record<string, unknown>;

const SESSION_KEY = "group:test-market-1:user:test-staff-1";
const GENERATION = "44444444-4444-4444-8444-444444444444";

class RpcDouble {
  calls: Array<{ name: string; args: Row }> = [];
  constructor(private readonly results: Record<string, Row | null>) {}
  rpc = async (name: string, args: Row) => {
    this.calls.push({ name, args });
    return { data: this.results[name] ?? null, error: null };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from = () => ({}) as any;
}

function service(results: Record<string, Row | null>) {
  const db = new RpcDouble(results);
  return { db, svc: new PendingSessionService(db as never) };
}

describe("close revision pin — RPC boundary", () => {
  it("omits the 9th argument for an ordinary append, keeping the 8-arg overload", async () => {
    const { db, svc } = service({
      append_pending_session: { accepted: true, reason: "appended", session: { id: "s" } },
    });

    await svc.append(SESSION_KEY, "ทุเรียน 10", null, "evt-1", 1_000, false, GENERATION);

    const args = db.calls[0].args;
    // The hot path must not depend on 20260831120000 being deployed.
    expect("p_expected_ingest_revision" in args).toBe(false);
    expect(args.p_mark_close).toBe(false);
  });

  it("sends the pinned revision on a close so the boundary binds to the validated document", async () => {
    const { db, svc } = service({
      append_pending_session: { accepted: true, reason: "appended", session: { id: "s" } },
    });

    await svc.append(
      SESSION_KEY, "จบรายการเบิก", null, "evt-close", 2_000, true, GENERATION, undefined, 7,
    );

    expect(db.calls[0].args.p_expected_ingest_revision).toBe(7);
    expect(db.calls[0].args.p_mark_close).toBe(true);
  });

  it("pins revision 0 rather than dropping it — a fresh document is still a document", async () => {
    const { db, svc } = service({
      append_pending_session: { accepted: true, reason: "appended", session: { id: "s" } },
    });

    await svc.append(
      SESSION_KEY, "จบรายการเบิก", null, "evt-close", 2_000, true, GENERATION, undefined, 0,
    );

    expect(db.calls[0].args.p_expected_ingest_revision).toBe(0);
  });

  it("raises a typed, recoverable error when the document moved under the gate", async () => {
    const { svc } = service({
      append_pending_session: {
        accepted: false,
        reason: "stale_validation_snapshot",
        expected_revision: 5,
        current_revision: 6,
      },
    });

    const attempt = svc.append(
      SESSION_KEY, "จบรายการเบิก", null, "evt-close", 2_000, true, GENERATION, undefined, 5,
    );

    await expect(attempt).rejects.toBeInstanceOf(PendingSessionStaleValidationSnapshotError);
    const error = await attempt.catch((caught: unknown) => caught);
    expect((error as PendingSessionStaleValidationSnapshotError).expectedRevision).toBe(5);
    expect((error as PendingSessionStaleValidationSnapshotError).currentRevision).toBe(6);
  });
});

describe("validation hold — RPC boundary", () => {
  it("holds against the exact generation and revision the gate saw", async () => {
    const { db, svc } = service({
      hold_pending_validation_review: { accepted: true, reason: "held" },
    });

    expect(await svc.holdValidationReview(SESSION_KEY, GENERATION, 9)).toBe(true);
    expect(db.calls[0]).toEqual({
      name: "hold_pending_validation_review",
      args: {
        p_session_key: SESSION_KEY,
        p_expected_session_generation: GENERATION,
        p_expected_ingest_revision: 9,
      },
    });
  });

  it("reports a refused hold instead of pretending the session is parked", async () => {
    const { svc } = service({
      hold_pending_validation_review: { accepted: false, reason: "stale_validation_snapshot" },
    });
    expect(await svc.holdValidationReview(SESSION_KEY, GENERATION, 9)).toBe(false);
  });

  it("treats a terminalized refusal as not held", async () => {
    const { svc } = service({
      hold_pending_validation_review: { accepted: false, reason: "terminalized" },
    });
    expect(await svc.holdValidationReview(SESSION_KEY, GENERATION, 9)).toBe(false);
  });

  it("resumes by generation only — never by revision, which has moved by then", async () => {
    const { db, svc } = service({
      resume_pending_close_finalization: { accepted: true, reason: "resumed" },
    });

    expect(await svc.resumeCloseFinalization(SESSION_KEY, GENERATION)).toBe(true);
    expect(db.calls[0].args).toEqual({
      p_session_key: SESSION_KEY,
      p_expected_session_generation: GENERATION,
    });
  });
});

describe("finalizer ordering guarantee", () => {
  const finalizerPath = new URL("./pending-session-finalizer.ts", import.meta.url);

  it("parks a presented review BEFORE any validation error is recorded", async () => {
    const source = await Bun.file(finalizerPath).text();

    const holdCall = source.indexOf("service.holdValidationReview(");
    const pushErrors = source.indexOf("validationErrors.push(...gate.errors)");

    expect(holdCall).toBeGreaterThan(0);
    expect(pushErrors).toBeGreaterThan(0);
    // If this order ever inverts, an unconfirmed review becomes a terminal
    // validation error again — the exact 2026-08-30 regression.
    expect(holdCall).toBeLessThan(pushErrors);
  });

  it("returns validation_held without reaching the terminal finalize RPC", async () => {
    const source = await Bun.file(finalizerPath).text();
    const holdReturn = source.indexOf('return { status: "validation_held"');
    const finalizeRpc = source.indexOf("try_finalize_pending_generation");

    expect(holdReturn).toBeGreaterThan(0);
    expect(holdReturn).toBeLessThan(finalizeRpc);
  });

  it("pins the hold to the snapshot revision, not to a re-read", async () => {
    const source = await Bun.file(finalizerPath).text();
    expect(source).toContain("snapshot.ingest_revision ?? null");
  });

  it("falls through to normal finalization when the hold is refused", async () => {
    const source = await Bun.file(finalizerPath).text();
    expect(source).toContain("validation hold refused; falling through to normal finalization");
  });
});

describe("webhook close gate wiring", () => {
  const webhookPath = new URL("./webhook-service.ts", import.meta.url);

  it("pins the revision the entry gate inspected, and only when the gate ran clean", async () => {
    const source = await Bun.file(webhookPath).text();
    expect(source).toContain("if (closeGateRefusal) markClose = false;");
    expect(source).toContain("else closeGatePinnedRevision = pending.ingest_revision ?? undefined;");
    expect(source).toContain("closeGatePinnedRevision,");
  });

  it("resumes a held session when the distinct later close confirms its review", async () => {
    const source = await Bun.file(webhookPath).text();
    // Without this, hold_pending_validation_review's next_attempt_at = NULL
    // would strand a CONFIRMED session forever: no sweep can see a closed row
    // with no attempt scheduled.
    expect(source).toContain("pendingService.resumeCloseFinalization(");
    expect(source).toContain("!closeGateRefusal && pending.close_event_timestamp_ms !== null");
  });

  it("answers a raced close with recoverable Thai copy, not a terminal failure", async () => {
    const source = await Bun.file(webhookPath).text();
    expect(source).toContain("PendingSessionStaleValidationSnapshotError");
    expect(source).toContain("CLOSE_RACED_LATE_ITEM_REPLY");
    // The operator must be told the list is intact and to simply close again.
    expect(source).toContain("รายการทั้งหมดยังอยู่ครบ");
    expect(source).toContain("กรุณาพิมพ์ปิดรอบอีกครั้ง");
  });
});
