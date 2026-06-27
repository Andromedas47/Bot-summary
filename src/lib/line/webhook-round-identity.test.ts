/**
 * Round identity enforcement: a produce session may only attach to a work round where
 * source_id + seller_name + market_name + business_date all match the header.
 *
 * These tests CURRENTLY FAIL because RE.SELLER_MARKET excludes seller names that contain
 * Latin characters (e.g. "P0ผ่าน"). Such headers fall through to the generic
 * classifyHeader branch, which calls disambiguateGeneric — an unfiltered query that
 * surfaces ALL open rounds regardless of seller or market identity.
 *
 * Production incident 27/6/2569: P0ผ่าน-ตลาดเซฟ เบิก/ชั่งคืน offered ทดสอบ2 / แดง2
 * (completely unrelated seller+market). User selected แดง2 → data persisted there.
 */
import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";

const MESSAGE_DATE = "2026-06-27";
const GROUP        = "group-round-identity";
const LO           = "โล";

let seq = 0;
function textEvent(
  text:  string,
  opts:  { replyToken?: string; userId?: string } = {},
): LineMessageEvent {
  seq += 1;
  return {
    type:             "message",
    webhookEventId:   `evt-ri-${seq}`,
    deliveryContext:  { isRedelivery: false },
    timestamp:        Date.now(),
    source:           { type: "group", groupId: GROUP, userId: opts.userId ?? "user-1" },
    mode:             "active",
    replyToken:       opts.replyToken,
    message:          { id: `msg-ri-${seq}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function unrelatedRounds(): Row[] {
  return [
    {
      id: "wr-test2", source_id: GROUP, business_date: MESSAGE_DATE,
      seller_name: "ทดสอบ2", market_name: "ตลาดทดสอบ",
      round_seq: 1, status: "open", source_meta: null, created_at: "", updated_at: "",
    },
    {
      id: "wr-daeng2", source_id: GROUP, business_date: MESSAGE_DATE,
      seller_name: "แดง2", market_name: "ตลาดทดสอบ",
      round_seq: 1, status: "open", source_meta: null, created_at: "", updated_at: "",
    },
  ];
}

function matchingRound(over: Partial<Row> = {}): Row {
  return {
    id: "wr-p0-1", source_id: GROUP, business_date: MESSAGE_DATE,
    seller_name: "P0ผ่าน", market_name: "ตลาดเซฟ",
    round_seq: 1, status: "open", source_meta: null, created_at: "", updated_at: "",
    ...over,
  };
}

function svc(db: ReturnType<typeof memSupabase>, replies: string[] = []) {
  return new WebhookService(db as never, {
    produceEndSettleMs: 0,
    replyMessage: async (_tok, text) => { replies.push(text); },
  });
}

const BORROW_MSG = [
  `P0ผ่าน-ตลาดเซฟ เบิก 27/6/2569`,
  `1มังคุด35บาท`,
  `10${LO}`,
  `จบรายการเบิก`,
].join("\n");

const RETURN_MSG = [
  `P0ผ่าน-ตลาดเซฟ ชั่งคืน 27/6/2569`,
  `1มังคุด35บาท`,
  `10${LO}`,
  `จบรายการ`,
].join("\n");

describe("WebhookService — round identity filter (Latin-prefix seller)", () => {
  // ── Test 1 ─────────────────────────────────────────────────────────────────
  // เบิก with unrelated rounds only:
  //   Current: falls to disambiguateGeneric → ambiguous → selection with ทดสอบ2/แดง2
  //   Expected: creates new P0ผ่าน-ตลาดเซฟ round, writes there; no tainted selection.

  it("[CURRENTLY FAILS] เบิก with only unrelated rounds: writes to correct new round, no selection", async () => {
    const db      = memSupabase({ work_rounds: unrelatedRounds() });
    const replies: string[] = [];
    await svc(db, replies).processEvents([textEvent(BORROW_MSG, { replyToken: "tok" })], "dest");

    expect(db._rows("work_round_selections")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(1);
    const wrid = db._rows("produce_sessions")[0].work_round_id as string;
    const wr   = db._rows("work_rounds").find((r) => r.id === wrid);
    expect(wr?.seller_name).toBe("P0ผ่าน");
    expect(wr?.market_name).toBe("ตลาดเซฟ");
  });

  // ── Test 2 ─────────────────────────────────────────────────────────────────
  // ชั่งคืน with unrelated rounds only:
  //   Current: falls to disambiguateGeneric → selection with ทดสอบ2/แดง2
  //   Expected: no selection, no write; "no round found" reply.

  it("[CURRENTLY FAILS] ชั่งคืน with only unrelated rounds: no selection, no write", async () => {
    const db      = memSupabase({ work_rounds: unrelatedRounds() });
    const replies: string[] = [];
    await svc(db, replies).processEvents([textEvent(RETURN_MSG, { replyToken: "tok" })], "dest");

    expect(db._rows("work_round_selections")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
    // Must not be a numbered selection list
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toMatch(/^1\./m);
  });

  // ── Test 3 ─────────────────────────────────────────────────────────────────
  // ชั่งคืน with one matching round plus unrelated rounds:
  //   Current: disambiguateGeneric sees ALL 3 open rounds → ambiguous → selection
  //   Expected: resolveForIntent filters by seller+market → 1 match → direct attach.

  it("[CURRENTLY FAILS] ชั่งคืน with one matching round: attaches directly, no selection", async () => {
    const db = memSupabase({
      work_rounds: [...unrelatedRounds(), matchingRound()],
    });
    await svc(db).processEvents([textEvent(RETURN_MSG)], "dest");

    expect(db._rows("work_round_selections")).toHaveLength(0);
    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("produce_sessions")[0].work_round_id).toBe("wr-p0-1");
  });

  // ── Test 4 ─────────────────────────────────────────────────────────────────
  // ชั่งคืน with two matching rounds plus unrelated rounds:
  //   Current: disambiguateGeneric sees ALL 4 → selection lists ALL 4 candidates
  //   Expected: resolveForIntent filters by seller+market → 2 matching → selection
  //             with ONLY the two P0ผ่าน-ตลาดเซฟ candidates.

  it("[CURRENTLY FAILS] ชั่งคืน with two matching + two unrelated: selection has only matching", async () => {
    const db = memSupabase({
      work_rounds: [
        ...unrelatedRounds(),
        matchingRound({ id: "wr-p0-1", round_seq: 1 }),
        matchingRound({ id: "wr-p0-2", round_seq: 2 }),
      ],
    });
    await svc(db).processEvents([textEvent(RETURN_MSG)], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    const sels = db._rows("work_round_selections");
    expect(sels).toHaveLength(1);
    const cands = sels[0].candidates as Array<{ seller_name: string; market_name: string }>;
    expect(cands).toHaveLength(2);
    expect(cands.every((c) => c.seller_name === "P0ผ่าน" && c.market_name === "ตลาดเซฟ")).toBe(true);
    expect(cands.some((c) => c.seller_name === "ทดสอบ2")).toBe(false);
    expect(cands.some((c) => c.seller_name === "แดง2")).toBe(false);
  });

  // ── Test 5 ─────────────────────────────────────────────────────────────────
  // Defense in depth — resumeProduceAttach with tainted selection:
  //   Manually inject a pending selection whose candidate is an unrelated round,
  //   but whose payload contains a P0ผ่าน-ตลาดเซฟ accumulatedText.
  //   Current: resume blindly writes to the unrelated round.
  //   Expected: identity check detects mismatch → reject → no produce write.

  it("[CURRENTLY FAILS] resume with tainted selection: rejects round that does not match header identity", async () => {
    const accumulatedText = `P0ผ่าน-ตลาดเซฟ เบิก 27/6/2569\n1มังคุด35บาท\n10${LO}`;
    const db = memSupabase({
      work_rounds: [{
        id: "wr-unrelated", source_id: GROUP, business_date: MESSAGE_DATE,
        seller_name: "ทดสอบ2", market_name: "ตลาดทดสอบ",
        round_seq: 1, status: "open", source_meta: null, created_at: "", updated_at: "",
      }],
      work_round_selections: [{
        id:            "sel-tainted",
        source_id:     GROUP,
        line_user_id:  "user-1",
        business_date: MESSAGE_DATE,
        intent:        "produce_attach",
        candidates:    [{ work_round_id: "wr-unrelated", seller_name: "ทดสอบ2", market_name: "ตลาดทดสอบ", round_seq: 1, expected_sales: 0 }],
        payload:       { rawMessageId: "raw-1", accumulatedText, isAppend: false, lineUserId: "user-1" },
        status:        "pending",
        created_at:    new Date().toISOString(),
        expires_at:    new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }],
    });
    const replies: string[] = [];
    await svc(db, replies).processEvents(
      [textEvent("1", { replyToken: "tok", userId: "user-1" })],
      "dest",
    );

    // Resume must NOT write to the unrelated round
    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
  });
});
