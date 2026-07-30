/**
 * Second review, finding #3 — one guided owner per (source, market, business
 * date), enforced BEFORE the produce session is opened.
 *
 * `open_or_rotate_produce_structured_session` is keyed per operator, so it
 * cannot see that a second member of the same LINE group is already standing on
 * the same round. Operator B could therefore open a parallel round, after which
 * B's own journey matched and every per-operator guard downstream let B write.
 *
 * The check is a pre-flight query: on refusal nothing reaches the RPC, so there
 * is no pending_sessions row and no session at all for B.
 */

import { describe, expect, it } from "bun:test";
import { GuidedSessionOpener } from "./session-opener";
import { GuidedMenuFakeDatabase } from "./test-fake-db";

const SOURCE = "G-1";
const DATE = "2026-07-29";
const LATER_DATE = "2026-07-30";
const MARKET = "วัดทุ่งลานนา";
const OTHER_MARKET = "หน้าเซเวน";
const SELLER = "กี้";

const A = {
  lineUserId: "U-a",
  sourceType: "group" as const,
  sourceId: SOURCE,
  sessionKey: `group:${SOURCE}:user:U-a`,
};
const B = {
  lineUserId: "U-b",
  sourceType: "group" as const,
  sourceId: SOURCE,
  sessionKey: `group:${SOURCE}:user:U-b`,
};

const TS = Date.parse("2026-07-29T10:00:00+07:00");

function openInput(
  identity: typeof A,
  overrides: Partial<{
    marketLabel: string;
    businessDateIso: string;
    lineEventId: string;
  }> = {},
) {
  return {
    identity,
    transactionType: "withdraw" as const,
    sellerLabel: SELLER,
    marketLabel: MARKET,
    businessDateIso: DATE,
    lineEventId: "evt-open",
    lineTimestampMs: TS,
    ...overrides,
  };
}

/** A round already opened by A, as it looks once A has finished produce. */
function seedRoundFor(
  db: GuidedMenuFakeDatabase,
  identity: typeof A,
  overrides: Record<string, unknown> = {},
): void {
  db.seedPendingSession({
    session_key: identity.sessionKey,
    source_id: SOURCE,
    line_user_id: identity.lineUserId,
    session_generation: `gen-${identity.lineUserId}`,
    accumulated_text: "",
    terminalized: true,
    finalization_status: "finalized",
    entry_origin: "structured_menu",
    command_contract_version: 1,
    business_date: DATE,
    transaction_time: "10:00",
    transaction_time_source: "line_event",
    staff_label: SELLER,
    market_label: MARKET,
    session_kind: "main",
    initial_transaction_type: "เบิก",
    declared_transaction_type: null,
    additional_opener: null,
    ...overrides,
  });
}

function pendingKeys(db: GuidedMenuFakeDatabase): string[] {
  return (db.tables.pending_sessions ?? []).map((r) => String(r.session_key));
}

describe("only one operator may own a guided round", () => {
  it("refuses B for a tuple A already owns, and writes nothing", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRoundFor(db, A);
    const before = pendingKeys(db);

    const outcome = await new GuidedSessionOpener(db.asClient()).open(openInput(B));

    expect(outcome.status).toBe("round_owned");
    if (outcome.status !== "round_owned") return;
    expect(outcome.reason).toBe("other_operator");
    // Zero writes: no row for B, and the open RPC was never reached.
    expect(pendingKeys(db)).toEqual(before);
    expect(pendingKeys(db)).not.toContain(B.sessionKey);
    expect(db.openProduceCalls).toBe(0);
  });

  it("still lets A act on their own round", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRoundFor(db, A);

    // A's previous round is terminalized, so a fresh open is a rotation and the
    // RPC — not this guard — decides it.
    const outcome = await new GuidedSessionOpener(db.asClient()).open(openInput(A));
    expect(outcome.status).toBe("opened");
    expect(db.openProduceCalls).toBe(1);
  });

  it("stays idempotent for the same operator's retry of the same event", async () => {
    const db = new GuidedMenuFakeDatabase();
    const opener = new GuidedSessionOpener(db.asClient());

    const first = await opener.open(openInput(A));
    expect(first.status).toBe("opened");
    const second = await opener.open(openInput(A));
    // The live row belongs to the same operator, so ownership does not refuse:
    // the pre-existing already_open / idempotent contract still decides.
    expect(second.status === "opened" || second.status === "already_open").toBe(true);
    expect(pendingKeys(db).filter((k) => k === A.sessionKey)).toHaveLength(1);
  });

  it("fails closed when two operators already own a matching round", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRoundFor(db, A);
    seedRoundFor(db, B);

    const outcome = await new GuidedSessionOpener(db.asClient()).open(
      openInput({ ...A, lineUserId: "U-c", sessionKey: `group:${SOURCE}:user:U-c` }),
    );
    expect(outcome.status).toBe("round_owned");
    if (outcome.status !== "round_owned") return;
    expect(outcome.reason).toBe("ambiguous");
    expect(db.openProduceCalls).toBe(0);
  });

  it("leaves a later business date independent", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRoundFor(db, A);

    const outcome = await new GuidedSessionOpener(db.asClient()).open(
      openInput(B, { businessDateIso: LATER_DATE }),
    );
    expect(outcome.status).toBe("opened");
  });

  it("leaves another market independent", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRoundFor(db, A);

    const outcome = await new GuidedSessionOpener(db.asClient()).open(
      openInput(B, { marketLabel: OTHER_MARKET }),
    );
    expect(outcome.status).toBe("opened");
  });

  it("leaves another source independent", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRoundFor(db, A);

    const outcome = await new GuidedSessionOpener(db.asClient()).open(
      openInput({
        lineUserId: B.lineUserId,
        sourceType: "group",
        sourceId: "G-2",
        sessionKey: "group:G-2:user:U-b",
      }),
    );
    expect(outcome.status).toBe("opened");
  });

  it("ignores a legacy row that carries no guided origin", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedRoundFor(db, A, { entry_origin: null });

    const outcome = await new GuidedSessionOpener(db.asClient()).open(openInput(B));
    expect(outcome.status).toBe("opened");
  });

  it("refuses rather than opening when the ownership query fails", async () => {
    const db = new GuidedMenuFakeDatabase();
    const client = db.asClient() as { from: (t: string) => unknown };
    const failing = {
      from: (table: string) =>
        table === "pending_sessions"
          ? (() => {
              const chain: Record<string, unknown> = {};
              chain.select = () => chain;
              chain.eq = () => chain;
              chain.not = () => chain;
              chain.order = async () => ({ data: null, error: { message: "down" } });
              chain.maybeSingle = async () => ({ data: null, error: null });
              return chain;
            })()
          : client.from(table),
      rpc: (db.asClient() as unknown as { rpc: unknown }).rpc,
    } as never;

    const outcome = await new GuidedSessionOpener(failing).open(openInput(B));
    expect(outcome.status).toBe("round_owned");
    if (outcome.status !== "round_owned") return;
    expect(outcome.reason).toBe("unknown");
    expect(db.openProduceCalls).toBe(0);
  });
});
