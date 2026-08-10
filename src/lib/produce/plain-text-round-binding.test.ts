import { describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  PLAIN_TEXT_ROUND_ENFORCEMENT_FROM,
  bindPlainTextRound,
  isNewRoundDocument,
  sourceTypeFromSessionKey,
} from "./plain-text-round-binding";

const SESSION_KEY = "group:G-1:user:U-typist";
const GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF = {
  sessionKey: SESSION_KEY,
  sessionGeneration: GENERATION,
  sourceId: "G-1",
  lineUserId: "U-typist",
};

// 11/8/2569 is the first enforced business date; 10/8/2569 is the day before.
const ENFORCED_DATE = "11/8/2569";
const LEGACY_DATE = "10/8/2569";

function doc(lines: string[]): ReturnType<typeof parseWeighSession> {
  return parseWeighSession(lines.join("\n"), "2026-08-11");
}

function withdrawal(date = ENFORCED_DATE) {
  return doc([
    `ดำ-ราชพฤกษ์ เบิก ${date}`,
    "1.มังคุด45บาท",
    "10โล",
    "จบรายการเบิก",
  ]);
}

function goodReturn(date = ENFORCED_DATE) {
  return doc([
    `ดำ-ราชพฤกษ์ ชั่งคืน ${date}`,
    "1.มังคุด45บาท",
    "4โล",
    "จบรายการชั่งคืน",
  ]);
}

/** Records the RPC call and answers with a scripted outcome. */
function fakeDb(outcome: Record<string, unknown> | { error: string }) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc: async (name: string, args: Record<string, unknown>): Promise<any> => {
      calls.push({ name, ...args });
      return "error" in outcome
        ? { data: null, error: { message: outcome.error } }
        : { data: outcome, error: null };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("document classification", () => {
  it("treats a main withdrawal as a new economic cycle", () => {
    expect(isNewRoundDocument(withdrawal())).toBe(true);
  });

  it("treats a good return as a continuation", () => {
    expect(isNewRoundDocument(goodReturn())).toBe(false);
  });

  it("treats a damaged return as a continuation", () => {
    const parsed = doc([
      `ดำ-ราชพฤกษ์ คืนเสีย ${ENFORCED_DATE}`,
      "1.มังคุด45บาท",
      "2โล",
      "จบรายการคืนเสีย",
    ]);
    expect(isNewRoundDocument(parsed)).toBe(false);
  });

  it("treats an additional withdrawal as a continuation of the same round", () => {
    const parsed = doc([
      `ดำ-ราชพฤกษ์ เบิกเพิ่ม ${ENFORCED_DATE}`,
      "1.มังคุด45บาท",
      "3โล",
      "จบรายการเบิกเพิ่ม",
    ]);
    expect(parsed.session_kind).toBe("additional");
    expect(isNewRoundDocument(parsed)).toBe(false);
  });

  it("still opens a round for a document that carries its own withdrawal and return", () => {
    const parsed = doc([
      `ดำ-ราชพฤกษ์ เบิก ${ENFORCED_DATE}`,
      "1.มังคุด45บาท",
      "10โล",
      "ชั่งคืน",
      "2.มังคุด45บาท",
      "4โล",
      "จบรายการ",
    ]);
    expect(isNewRoundDocument(parsed)).toBe(true);
  });
});

describe("session key shape", () => {
  it("recovers the LINE source type the key was minted from", () => {
    expect(sourceTypeFromSessionKey("group:G:user:U")).toBe("group");
    expect(sourceTypeFromSessionKey("room:R:user:U")).toBe("room");
    expect(sourceTypeFromSessionKey("dm:U")).toBe("user");
    expect(sourceTypeFromSessionKey("something-else")).toBeNull();
  });
});

describe("binding outcomes", () => {
  it("passes the parsed seller, market and date, never a stored tuple", async () => {
    const db = fakeDb({ outcome: "bound", accountability_round_id: "round-1" });
    const result = await bindPlainTextRound(db, REF, withdrawal());

    expect(result).toEqual({ status: "bound", accountabilityRoundId: "round-1" });
    expect(db.calls[0]).toMatchObject({
      name: "bind_plain_text_accountability_round",
      p_session_key: SESSION_KEY,
      p_session_generation: GENERATION,
      p_source_type: "group",
      p_line_user_id: "U-typist",
      p_business_date: "2026-08-11",
      p_seller_label: "ดำ",
      p_market_label: "ราชพฤกษ์",
      p_is_new_round: true,
    });
  });

  it("treats an already-bound generation as bound", async () => {
    const db = fakeDb({ outcome: "already_bound", accountability_round_id: "round-1" });
    expect(await bindPlainTextRound(db, REF, goodReturn())).toEqual({
      status: "bound",
      accountabilityRoundId: "round-1",
    });
  });

  it("fails closed when two open rounds match the same description", async () => {
    const db = fakeDb({ outcome: "ambiguous" });
    const result = await bindPlainTextRound(db, REF, goodReturn());
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("ambiguous");
    expect(result.detail).toContain("มากกว่า 1 รอบ");
  });

  it("fails closed on a return with no withdrawal, from the enforcement date", async () => {
    const db = fakeDb({ outcome: "no_round" });
    const result = await bindPlainTextRound(db, REF, goodReturn());
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("no_round");
    expect(result.detail).toContain("ไม่พบรอบเบิกของรายการนี้");
  });

  it("leaves a pre-cutover return unbound instead of blocking a real return", async () => {
    const db = fakeDb({ outcome: "no_round" });
    const parsed = goodReturn(LEGACY_DATE);
    expect(parsed.date! < PLAIN_TEXT_ROUND_ENFORCEMENT_FROM).toBe(true);
    expect(await bindPlainTextRound(db, REF, parsed)).toEqual({ status: "unbound" });
  });

  it("fails closed when the RPC itself errors — an unread master validates nothing", async () => {
    const db = fakeDb({ error: "connection reset" });
    const result = await bindPlainTextRound(db, REF, goodReturn());
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("bind_failed");
  });

  it("fails closed on an unrecognized outcome rather than guessing", async () => {
    const db = fakeDb({ outcome: "something_new" });
    expect((await bindPlainTextRound(db, REF, goodReturn())).status).toBe("refused");
  });

  it("fails closed when the generation is no longer the row's current one", async () => {
    const db = fakeDb({ outcome: "not_found" });
    expect((await bindPlainTextRound(db, REF, goodReturn())).status).toBe("refused");
  });

  it("does not call the RPC for a document with no seller and no market", async () => {
    const db = fakeDb({ outcome: "bound", accountability_round_id: "round-1" });
    const headerless = doc(["1.มังคุด45บาท", "4โล"]);
    expect(headerless.session_title).toBeNull();
    expect(await bindPlainTextRound(db, REF, headerless)).toEqual({ status: "unbound" });
    expect(db.calls).toHaveLength(0);
  });

  it("refuses to bind on behalf of an unattributable sender", async () => {
    const db = fakeDb({ outcome: "bound", accountability_round_id: "round-1" });
    const result = await bindPlainTextRound(
      db,
      { ...REF, lineUserId: null },
      withdrawal(),
    );
    expect(result).toEqual({ status: "unbound" });
    expect(db.calls).toHaveLength(0);
  });
});
