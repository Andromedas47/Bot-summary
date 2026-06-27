/**
 * Regression: ชั่งคืน (weigh-back) must only attach to rounds matching
 * seller_name + market_name + business_date — never unrelated sellers.
 *
 * Production incident 27/6/2569: ปลา-ราชพฤกษ์ ชั่งคืน offered ทดสอบ2 / แดง2.
 */
import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { memSupabase, type Row } from "@/lib/test-utils/mem-supabase";

const MESSAGE_DATE = "2026-06-27";
const GROUP = "group-weigh-back";
const LO = "\u0E42\u0E25";

let seq = 0;
function textEvent(text: string, replyToken?: string): LineMessageEvent {
  seq += 1;
  return {
    type: "message",
    webhookEventId: `evt-${seq}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
    source: { type: "group", groupId: GROUP, userId: "user-1" },
    mode: "active",
    replyToken,
    message: { id: `msg-${seq}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function round(over: Partial<Row> = {}): Row {
  return {
    id: `wr-${Math.random().toString(36).slice(2, 8)}`,
    source_id: GROUP,
    business_date: MESSAGE_DATE,
    seller_name: "ปลา",
    market_name: "ราชพฤกษ์",
    round_seq: 1,
    status: "open",
    source_meta: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

function unrelatedRounds(): Row[] {
  return [
    round({
      id: "wr-test2",
      seller_name: "ทดสอบ2",
      market_name: "ตลาดทดสอบ",
      status: "open",
    }),
    round({
      id: "wr-daeng2",
      seller_name: "แดง2",
      market_name: "ตลาดทดสอบ",
      status: "open",
    }),
  ];
}

function svc(db: ReturnType<typeof memSupabase>, replies: string[] = []) {
  return new WebhookService(db as never, {
    produceEndSettleMs: 0,
    replyMessage: async (_tok, text) => { replies.push(text); },
  });
}

const HEADER = "ปลา-ราชพฤกษ์ ชั่งคืน 27/6/2569";

function shortWeighBackMsg(): string {
  return [
    HEADER,
    "1ส้มไต้หวัน 40 บาท",
    `2${LO}`,
    "จบรายการชั่งคืน",
  ].join("\n");
}

describe("WebhookService — ชั่งคืน round selection scoping", () => {
  it("does NOT offer unrelated rounds (ทดสอบ2 / แดง2) when ปลา-ราชพฤกษ์ has no matching round", async () => {
    const db = memSupabase({ work_rounds: unrelatedRounds() });

    await svc(db).processEvents([textEvent(shortWeighBackMsg())], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
    expect(db._rows("work_round_selections")).toHaveLength(0);
  });

  it("persists when a matching seller+market+date round exists", async () => {
    const db = memSupabase({
      work_rounds: [...unrelatedRounds(), round({ id: "wr-pla" })],
    });

    await svc(db).processEvents([textEvent(shortWeighBackMsg())], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(1);
    expect(db._rows("produce_items")).toHaveLength(1);
    expect(db._rows("work_round_selections")).toHaveLength(0);
    expect(db._rows("produce_sessions")[0].work_round_id).toBe("wr-pla");
  });

  it("opens selection only among matching seller+market rounds on the same date", async () => {
    const db = memSupabase({
      work_rounds: [
        ...unrelatedRounds(),
        round({ id: "wr-pla-1", round_seq: 1 }),
        round({ id: "wr-pla-2", round_seq: 2 }),
      ],
    });

    await svc(db).processEvents([textEvent(shortWeighBackMsg())], "dest");

    expect(db._rows("produce_sessions")).toHaveLength(0);
    expect(db._rows("produce_items")).toHaveLength(0);
    const selections = db._rows("work_round_selections");
    expect(selections).toHaveLength(1);
    const candidates = selections[0].candidates as Array<{ seller_name: string; market_name: string }>;
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.seller_name === "ปลา" && c.market_name === "ราชพฤกษ์")).toBe(true);
    expect(candidates.some((c) => c.seller_name === "ทดสอบ2")).toBe(false);
    expect(candidates.some((c) => c.seller_name === "แดง2")).toBe(false);
  });

  it("blocks header start when no matching round (explicit ชั่งคืน)", async () => {
    const replies: string[] = [];
    const db = memSupabase({ work_rounds: unrelatedRounds() });

    await svc(db, replies).processEvents([textEvent(HEADER, "reply-tok")], "dest");

    expect(db._rows("pending_sessions")).toHaveLength(0);
    expect(replies[0]).toContain("ปลา — ราชพฤกษ์");
    expect(replies[0]).not.toContain("ทดสอบ2");
  });
});
