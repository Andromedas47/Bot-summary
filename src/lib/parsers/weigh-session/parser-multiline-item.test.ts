import { describe, it, expect } from "bun:test";
import type { LineMessageEvent } from "@/lib/line/types";
import {
  parseWeighSession,
  WeighSessionParser,
  assertWeighSessionFinalizable,
  buildWeighSessionValidationReply,
} from "./parser";

// Regression coverage for the production incident: a withdrawal message
// split an item's name, price, and quantity across three separate lines.
// The parser silently dropped it (no error, no item) while items directly
// before and after it persisted normally, and the session still replied
// with a success checkmark — creating a 600 THB transfer-reconciliation gap.

const HEADER = "รายการชั่งเบิก";

function withHeader(...lines: string[]): string {
  return [HEADER, ...lines].join("\n");
}

function seedRpcStub() {
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== "seed_central_selling_price") {
        return { data: null, error: { message: `unexpected rpc: ${fn}` } };
      }
      return {
        data: {
          product_key: args.p_product_key,
          unit_key: args.p_unit_key,
          business_date: args.p_business_date,
          price_satang: args.p_price_satang,
          set_by: args.p_actor,
          set_reason: args.p_reason ?? null,
          created_at: "2026-06-29T00:00:00Z",
          updated_at: "2026-06-29T00:00:00Z",
        },
        error: null,
      };
    },
  };
}

function textEvent(text: string, suffix: string): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: `event-${suffix}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.UTC(2026, 5, 29, 5, 0, 0),
    source: { type: "user", userId: "user-1" },
    mode: "active",
    replyToken: "reply-token",
    message: { id: `message-${suffix}`, type: "text", quoteToken: "quote-token", text },
  };
}

const INCIDENT_EXCERPT = [
  "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
  "14ปลาอินทรี120บาท",
  "5กระปุก",
  "15ปลาหวานงา",
  "100บาท",
  "6ถุง",
  "16ปลาหวานไม่งา100บาท",
  "4ถุง",
  "17ปลาซิวทอดกรอบ100บาท",
  "7ถุง",
  "จบรายการเบิก",
].join("\n");

describe("three-line item — production incident reproduction", () => {
  it("parses the exact incident excerpt as 4 complete items, ปลาหวานงา included", () => {
    const result = parseWeighSession(INCIDENT_EXCERPT);

    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toHaveLength(4);
    expect(result.items.map((i) => i.item_number)).toEqual([14, 15, 16, 17]);
    expect(result.items[1]).toMatchObject({
      item_number: 15,
      product_name: "ปลาหวานงา",
      price_per_unit: 100,
      quantity: 6,
      unit: "ถุง",
    });
    expect(() => assertWeighSessionFinalizable(result)).not.toThrow();

    // 5*120 + 6*100 + 4*100 + 7*100 = 600 + 600 + 400 + 700 = 2300
    const total = result.items.reduce(
      (sum, item) => sum + item.price_per_unit * (item.quantity ?? 0),
      0,
    );
    expect(total).toBe(2300);
  });

  it("parses a standalone three-line item into exactly one complete item", () => {
    const result = parseWeighSession(withHeader("15ปลาหวานงา", "100บาท", "6ถุง"));

    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toEqual([
      expect.objectContaining({
        item_number: 15,
        product_name: "ปลาหวานงา",
        price_per_unit: 100,
        quantity: 6,
        unit: "ถุง",
      }),
    ]);
  });

  it("persists all 4 items including the split ปลาหวานงา, and replies with success", async () => {
    const event = textEvent(INCIDENT_EXCERPT, "incident");
    const result = await new WeighSessionParser().parse(event);
    const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const database = {
      from(table: string) {
        return {
          insert(payload: Record<string, unknown>) {
            inserts.push({ table, payload });
            if (table === "produce_sessions") {
              return { select: () => ({ single: async () => ({ data: { id: "session-1" }, error: null }) }) };
            }
            return Promise.resolve({ error: null });
          },
        };
      },
      ...seedRpcStub(),
    };

    await result.persist(database as never, "raw-message-1");

    const itemInserts = inserts.filter((i) => i.table === "produce_items");
    expect(itemInserts).toHaveLength(4);
    expect(itemInserts.find((i) => i.payload.item_number === 15)?.payload).toMatchObject({
      product_name: "ปลาหวานงา",
      price_per_unit: 100,
      quantity: 6,
      unit: "ถุง",
    });
  });
});

describe("general multiline item split — format variations", () => {
  const cases: Array<[string, string]> = [
    ["combined single-line price, split quantity", withHeader("15ปลาหวานงา100บาท", "6ถุง")],
    ["dotted item number and quantity", withHeader("15.ปลาหวานงา", "100บาท", "6.ถุง")],
    ["spaced item number, name, price, quantity", withHeader("15 ปลาหวานงา", "100 บาท", "6 ถุง")],
    ["name+price on one line, spaced, quantity split", withHeader("15. ปลาหวานงา 100 บาท", "6 ถุง")],
  ];

  for (const [label, text] of cases) {
    it(`supports: ${label}`, () => {
      const result = parseWeighSession(text);
      expect(result.parse_errors).toHaveLength(0);
      expect(result.items).toEqual([
        expect.objectContaining({
          item_number: 15,
          product_name: "ปลาหวานงา",
          price_per_unit: 100,
          quantity: 6,
          unit: "ถุง",
        }),
      ]);
    });
  }

  it("does not special-case ปลาหวานงา — any product name splits the same way", () => {
    const result = parseWeighSession(withHeader("22มะม่วงเบา", "45บาท", "9ถุง"));
    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toEqual([
      expect.objectContaining({
        item_number: 22,
        product_name: "มะม่วงเบา",
        price_per_unit: 45,
        quantity: 9,
        unit: "ถุง",
      }),
    ]);
  });

  it("does not let a name-only header consume the following item's lines", () => {
    const result = parseWeighSession(withHeader(
      "1ปลาหวานงา", "100บาท", "6ถุง",
      "2ปลาทู", "80บาท", "3ถุง",
    ));

    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toEqual([
      expect.objectContaining({ item_number: 1, product_name: "ปลาหวานงา", price_per_unit: 100, quantity: 6, unit: "ถุง" }),
      expect.objectContaining({ item_number: 2, product_name: "ปลาทู", price_per_unit: 80, quantity: 3, unit: "ถุง" }),
    ]);
  });
});

describe("multiline item split — LINE-export-prefixed lines", () => {
  // Regression for a real UAT run: parseWeighSession had two parallel
  // item-line branches, one for a bare line and one for a line carrying a
  // "HH:MM sender" LINE-export prefix (see TIME_PREFIX). The general
  // multiline-split fallback (name-only header, price-only continuation,
  // quantity-only continuation) was only wired into the bare-line branch, so
  // the exact same three-line item that parses fine unprefixed was silently
  // rejected line-by-line when every line carried a prefix.
  function prefixed(...contentLines: string[]): string {
    return [HEADER, ...contentLines]
      .map((content) => `12:00 พนักงาน ${content}`)
      .join("\n");
  }

  it("parses a three-line item split across TIME_PREFIX-prefixed lines", () => {
    const result = parseWeighSession(prefixed("15ปลาหวานงา", "100บาท", "6ถุง"));

    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toEqual([
      expect.objectContaining({
        item_number: 15,
        product_name: "ปลาหวานงา",
        price_per_unit: 100,
        quantity: 6,
        unit: "ถุง",
      }),
    ]);
  });

  it("parses the real UAT 3-item excerpt across prefixed lines with no drops", () => {
    const result = parseWeighSession(prefixed(
      "1ปลาอินทรี120บาท", "5กระปุก",
      "2ปลาหวานงา", "100บาท", "6ถุง",
      "3ปลาหวานไม่งา100บาท", "4ถุง",
    ));

    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toHaveLength(3);
    expect(() => assertWeighSessionFinalizable(result)).not.toThrow();

    // 5*120 + 6*100 + 4*100 = 600 + 600 + 400 = 1600
    const total = result.items.reduce(
      (sum, item) => sum + item.price_per_unit * (item.quantity ?? 0),
      0,
    );
    expect(total).toBe(1600);
  });
});

describe("incomplete item — fail closed, never a fake complete row", () => {
  it("reports a parse error and produces no valid item when the quantity line never arrives", () => {
    const result = parseWeighSession(withHeader("15ปลาหวานงา", "100บาท"));

    // The pending header+price is finalized with quantity/unit still null —
    // getWeighSessionFinalizationErrors must still block it (no fake complete row).
    expect(() => assertWeighSessionFinalizable(result)).toThrow(/weigh session validation failed/);
    expect(buildWeighSessionValidationReply(result)).toContain("ปลาหวานงา");
  });

  it("reports a parse error and produces no item when the price line never arrives", () => {
    const result = parseWeighSession(withHeader("15ปลาหวานงา", "6ถุง"));

    expect(result.items).toHaveLength(0);
    expect(
      result.parse_errors.some((e) => e.includes("missing a price line") || e.includes("no preceding item")),
    ).toBe(true);
    expect(() => assertWeighSessionFinalizable(result)).toThrow(/weigh session validation failed/);
  });

  it("keeps the offending source line available for the error reply", () => {
    const result = parseWeighSession(withHeader("15ปลาหวานงา", "6ถุง"));
    expect(result.parse_errors.join(" ")).toContain("ปลาหวานงา");
    expect(result.parse_errors.join(" ")).toContain('"6ถุง"');
  });
});

describe("orphan quantity — never silently ignored", () => {
  it("reports a bare quantity line with no preceding item as an error", () => {
    const result = parseWeighSession(withHeader("6ถุง"));

    expect(result.items).toHaveLength(0);
    expect(result.parse_errors).toContain('quantity with no preceding item: "6ถุง"');
  });
});

describe("zero-write behavior — one bad item blocks the whole session", () => {
  it("persists nothing when one of three candidates is invalid", async () => {
    const text = [
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "1มะม่วง10บาท",
      "1ถุง",
      "2ปลาหวานงา",
      "100บาท",
      "3น้อยหน่า50บาท",
      "6.โล",
      "จบรายการเบิก",
    ].join("\n");
    const event = textEvent(text, "zero-write");
    const result = await new WeighSessionParser().parse(event);
    const parsed = result.data as unknown as ReturnType<typeof parseWeighSession>;

    expect(() => assertWeighSessionFinalizable(parsed)).toThrow(/weigh session validation failed/);
    const reply = buildWeighSessionValidationReply(parsed);
    expect(reply).not.toContain("บันทึกแล้ว");
    expect(reply).toContain("ปลาหวานงา");

    let databaseCalls = 0;
    const noWriteDatabase = {
      from() {
        databaseCalls += 1;
        throw new Error("database must not be called");
      },
    };
    await expect(result.persist(noWriteDatabase as never, "raw-message-1")).rejects.toThrow(
      /weigh session validation failed/,
    );
    expect(databaseCalls).toBe(0);
  });
});

describe("existing supported formats — unaffected regression", () => {
  it("still parses: 1แก้วมังกร35.บาท / 24.4.โล", () => {
    const result = parseWeighSession(withHeader("1แก้วมังกร35.บาท", "24.4.โล"));
    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toEqual([
      expect.objectContaining({
        item_number: 1, product_name: "แก้วมังกร", price_per_unit: 35, quantity: 24.4, unit: "โล",
      }),
    ]);
  });

  it("still parses: 15ปลาหวานไม่งา100บาท / 4ถุง", () => {
    const result = parseWeighSession(withHeader("15ปลาหวานไม่งา100บาท", "4ถุง"));
    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toEqual([
      expect.objectContaining({
        item_number: 15, product_name: "ปลาหวานไม่งา", price_per_unit: 100, quantity: 4, unit: "ถุง",
      }),
    ]);
  });

  it("still parses basis-priced items (qty+unit for price bundled in the header)", () => {
    const result = parseWeighSession(withHeader("2ส้มไต้หวัน3โล100บาท", "13.7.โล"));
    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ item_number: 2, product_name: "ส้มไต้หวัน" });
  });

  it("still parses basis-priced items with a Thai product name (qty unit for price)", () => {
    const result = parseWeighSession(withHeader("13มะละกอ3ลูก40บาท", "42.ลูก"));
    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ item_number: 13, product_name: "มะละกอ" });
  });
});
