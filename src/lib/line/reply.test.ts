import { afterEach, describe, it, expect, spyOn } from "bun:test";
import {
  buildAdditionalSessionSummary,
  buildWeighSessionSummary,
  LinePushError,
  measureLineText,
  parseRetryAfterMs,
  pushLineMessage,
  replyLineMessage,
  replyLineMessages,
  sumWeighItemsSatang,
  weighItemTotal,
  weighItemTotalMilliSatang,
  weighItemTotalSatang,
} from "./reply";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { LINE_MESSAGE_MAX_CODE_POINTS, countCodePoints } from "@/lib/summary/line-chunking";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeSession(overrides: Partial<WeighSession> = {}): WeighSession {
  return {
    date: "2026-06-01",
    staff_name: "กี้",
    sender_name: null,
    transaction_time: null,
    session_title: null,
    session_kind: "main",
    declared_transaction_type: null,
    items: [],
    parse_errors: [],
    ...overrides,
  };
}

const BORROW_ITEM = {
  item_number: 1,
  product_name: "ทุเรียน",
  price_per_unit: 100,
  quantity: 10,
  unit: "โล" as const,
  section: "",
  transaction_type: "เบิก" as const,
  pricing_mode: "unit" as const,
  basis_quantity: null,
  basis_unit: null,
  basis_price: null,
};

const BORROW_EXTRA_ITEM = {
  item_number: 2,
  product_name: "หมอนทอง",
  price_per_unit: 119,
  quantity: 5,
  unit: "โล" as const,
  section: "",
  transaction_type: "เบิกเพิ่ม" as const,
  pricing_mode: "unit" as const,
  basis_quantity: null,
  basis_unit: null,
  basis_price: null,
};

const RETURN_ITEM = {
  item_number: 1,
  product_name: "ชะนี",
  price_per_unit: 100,
  quantity: 8,
  unit: "โล" as const,
  section: "",
  transaction_type: "คืน" as const,
  pricing_mode: "unit" as const,
  basis_quantity: null,
  basis_unit: null,
  basis_price: null,
};

const BAD_RETURN_ITEM = {
  item_number: 1,
  product_name: "กระดุม",
  price_per_unit: 80,
  quantity: 3,
  unit: "โล" as const,
  section: "",
  transaction_type: "คืนเสีย" as const,
  pricing_mode: "unit" as const,
  basis_quantity: null,
  basis_unit: null,
  basis_price: null,
};

const BASIS_ITEM = {
  item_number: 1,
  product_name: "ผักกาดขาว",
  price_per_unit: 6.67, // rounded display approximation, not used for the total below
  quantity: 32,
  unit: "หัว" as const,
  section: "",
  transaction_type: "เบิก" as const,
  pricing_mode: "basis" as const,
  basis_quantity: 3,
  basis_unit: "หัว" as const,
  basis_price: 20,
};

describe("buildWeighSessionSummary — ยอดส่ง must not appear", () => {
  it("session เบิกอย่างเดียว ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });

  it("session คืนอย่างเดียว ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [RETURN_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });

  it("session คืนเสียอย่างเดียว ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BAD_RETURN_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });

  it("session หลาย type ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM, RETURN_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });
});

describe("buildWeighSessionSummary — section subtotals", () => {
  it("session เบิกอย่างเดียว แสดง รวมเบิก", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM] }));
    expect(result).toContain("รวมเบิก:");
    expect(result).toContain("รวมเบิก: 1,000.00 บาท");
    expect(result).not.toContain("รวมคืน:");
    expect(result).not.toContain("รวมเสีย:");
  });

  it("session คืนอย่างเดียว แสดง รวมคืน", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [RETURN_ITEM] }));
    expect(result).toContain("รวมคืน:");
    expect(result).not.toContain("รวมเบิก:");
    expect(result).not.toContain("รวมเสีย:");
  });

  it("session คืนเสียอย่างเดียว แสดง รวมเสีย", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BAD_RETURN_ITEM] }));
    expect(result).toContain("รวมเสีย:");
    expect(result).not.toContain("รวมเบิก:");
    expect(result).not.toContain("รวมคืน:");
  });

  it("session มี เบิก+คืน แสดงทั้ง รวมเบิก และ รวมคืน แต่ไม่แสดงยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM, RETURN_ITEM] }));
    expect(result).toContain("รวมเบิก:");
    expect(result).toContain("รวมคืน:");
    expect(result).not.toContain("ยอดส่ง");
  });

  it("เบิกเพิ่ม นับรวมใน section เบิก", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM, BORROW_EXTRA_ITEM] }));
    expect(result).toContain("เบิก");
    expect(result).toContain("รวมเบิก:");
    // both items appear under one เบิก section — numbered 1 and 2
    expect(result).toContain("1. ทุเรียน");
    expect(result).toContain("2. หมอนทอง");
  });
});

describe("buildWeighSessionSummary — category grouping (presentation only)", () => {
  const MUSHROOM_ITEM = {
    item_number: 3,
    product_name: "เห็ดนางฟ้า",
    price_per_unit: 60,
    quantity: 4,
    unit: "โล" as const,
    section: "",
    transaction_type: "เบิก" as const,
    pricing_mode: "unit" as const,
    basis_quantity: null,
    basis_unit: null,
    basis_price: null,
  };

  it("inserts a category heading for a single-category section without changing the subtotal", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM] }));
    expect(result).toContain("🥭 ทุเรียน");
    expect(result).toContain("1. ทุเรียน");
    expect(result).toContain("รวมเบิก: 1,000.00 บาท");
  });

  it("groups a mixed-category section under separate headings, ordered by the dictionary category order, with an unchanged section total", () => {
    // ทุเรียน (ท) and หมอนทอง (ท) are the same category as BORROW_ITEM;
    // เห็ดนางฟ้า is a different category (ห) and must get its own heading.
    const result = buildWeighSessionSummary(makeSession({ items: [MUSHROOM_ITEM, BORROW_ITEM] }));
    const durianHeadingIndex = result.indexOf("🥭 ทุเรียน");
    const mushroomHeadingIndex = result.indexOf("🍄 เห็ด");
    expect(durianHeadingIndex).toBeGreaterThan(-1);
    expect(mushroomHeadingIndex).toBeGreaterThan(-1);
    // ท (ทุเรียน) sorts before ห (เห็ด) in REPORT_CATEGORY_ORDER, so its
    // heading appears first even though the mushroom item was listed first.
    expect(durianHeadingIndex).toBeLessThan(mushroomHeadingIndex);
    // Section subtotal is untouched: 1,000 (ทุเรียน) + 240 (เห็ดนางฟ้า 4 × 60).
    expect(result).toContain("รวมเบิก: 1,240.00 บาท");
  });

  it("keeps same-category items in original relative order and numbering (stable sort)", () => {
    // ทุเรียน then หมอนทอง are both category ท — grouping must not reorder them.
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM, BORROW_EXTRA_ITEM] }));
    const durianLineIndex = result.indexOf("1. ทุเรียน");
    const homThongLineIndex = result.indexOf("2. หมอนทอง");
    expect(durianLineIndex).toBeGreaterThan(-1);
    expect(homThongLineIndex).toBeGreaterThan(durianLineIndex);
    // Only one category heading should appear for this all-ท section.
    expect(result.match(/🥭 ทุเรียน/g)?.length).toBe(1);
  });

  it("an unrecognized product still renders under ❓ ไม่จัดหมวด and still counts toward the subtotal", () => {
    const unknownItem = { ...BORROW_ITEM, product_name: "มะม่วงต่างดาว" };
    const result = buildWeighSessionSummary(makeSession({ items: [unknownItem] }));
    expect(result).toContain("❓ ไม่จัดหมวด");
    expect(result).toContain("รวมเบิก: 1,000.00 บาท");
  });

  it("a sub-satang item total cannot print one number in the lines and another in the section total", () => {
    // 0.5 โล × 0.25 บาท = 0.125 per line. Each line rounds to 0.13, so the
    // honest section total of three of them is 0.39. Summing the raw floats
    // instead gives 0.375 → 0.38, and the receipt would contradict itself:
    // three 0.13 lines under a 0.38 total.
    const items = Array.from({ length: 3 }, () => ({
      ...BORROW_ITEM,
      product_name: "หมอนทอง",
      quantity: 0.5,
      price_per_unit: 0.25,
    }));
    const result = buildWeighSessionSummary(makeSession({ items }));
    expect(result).toContain("รวมทุเรียน 0.39 บาท");
    expect(result).toContain("รวมเบิก: 0.39 บาท");
    expect(result).not.toContain("0.38");
  });

  it("an item's category does not depend on which other items share the message", () => {
    // `เพิ่ม` is a real prefix the alias layer can strip, but only when
    // authorized by a set of known names. Authorizing it from the message's
    // own items would make this item's category flip based on a sibling line.
    const prefixed = { ...BORROW_ITEM, product_name: "เพิ่มหมอนทอง" };
    const solo = buildWeighSessionSummary(makeSession({ items: [prefixed] }));
    const withSibling = buildWeighSessionSummary(makeSession({
      items: [prefixed, { ...BORROW_ITEM, product_name: "หมอนทอง" }],
    }));
    expect(solo).toContain("❓ ไม่จัดหมวด");
    expect(withSibling).toContain("❓ ไม่จัดหมวด");
    expect(withSibling).toContain("🥭 ทุเรียน");
    // And no row may be totalled under one category but printed under none:
    // both items appear, and the two subtotals add up to the section total.
    // ทุเรียน sorts first, so the sibling leads and the prefixed name follows.
    expect(withSibling).toContain("1. หมอนทอง");
    expect(withSibling).toContain("2. เพิ่มหมอนทอง");
    expect(withSibling).toContain("รวมทุเรียน 1,000.00 บาท");
    expect(withSibling).toContain("รวมไม่จัดหมวด 1,000.00 บาท");
    expect(withSibling).toContain("รวมเบิก: 2,000.00 บาท");
  });

  it("falls back to the ungrouped rendering rather than losing an oversized receipt", () => {
    // This reply is delivered as one unsplit LINE message. Grouping must never
    // be the reason an operator gets no confirmation at all.
    const items = Array.from({ length: 400 }, (_, index) => ({
      ...BORROW_ITEM,
      product_name: index % 2 === 0 ? "ทุเรียน" : "เห็ดนางฟ้า",
    }));
    const result = buildWeighSessionSummary(makeSession({ items }));
    // The flat rendering of a document this size is itself over the limit —
    // that is pre-existing and out of scope here. What must hold is that
    // grouping is dropped rather than added on top of an already-large message,
    // and that the receipt still carries its totals.
    expect(result).not.toContain("🥭 ทุเรียน");
    expect(result).not.toContain("รวมทุเรียน");
    expect(result).toContain("รวมเบิก:");
    expect(countCodePoints(result))
      .toBeLessThan(countCodePoints(buildWeighSessionSummary(makeSession({ items: items.slice(0, 40) }))) * 10);
  });

  it("numbers a mixed-category section 1, 2, 3 reading downward", () => {
    // Numbering by the item's original position would print "2." above "1."
    // here, since เห็ด was typed first but sorts after ทุเรียน.
    const result = buildWeighSessionSummary(
      makeSession({ items: [MUSHROOM_ITEM, BORROW_ITEM, BORROW_EXTRA_ITEM] }),
    );
    const numbers = [...result.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3]);
    // …and the durian pair, typed second and third, is what leads the section.
    expect(result.indexOf("1. ทุเรียน")).toBeLessThan(result.indexOf("3. เห็ดนางฟ้า"));
  });

  it("keeps grouping for a document that still fits", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      ...BORROW_ITEM,
      product_name: index % 2 === 0 ? "ทุเรียน" : "เห็ดนางฟ้า",
    }));
    const result = buildWeighSessionSummary(makeSession({ items }));
    expect(countCodePoints(result)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    expect(result).toContain("🥭 ทุเรียน");
    expect(result).toContain("🍄 เห็ด");
  });

  it("the printed category subtotals add up to the printed section subtotal", () => {
    // The invariant, asserted on the rendered message rather than on the
    // helper: not one satang may appear or disappear because of grouping. A
    // decimal quantity and an uncategorized row are both in the mix, and the
    // uncategorized money must be part of the total, never dropped.
    const items = [
      BORROW_ITEM,                                                    // ท  1,000.00
      MUSHROOM_ITEM,                                                  //  ห    240.00
      { ...BORROW_ITEM, product_name: "แก้วมังกร", quantity: 14.5, price_per_unit: 50 },
      { ...BORROW_ITEM, product_name: "สินค้าไม่มีในพจนานุกรม", quantity: 2.5, price_per_unit: 35 },
    ];
    const result = buildWeighSessionSummary(makeSession({ items }));

    const subtotals = [...result.matchAll(/^รวม(?!เบิก:|คืน:|เสีย:).*?([\d,]+\.\d{2}) บาท$/gm)]
      .map((match) => Math.round(Number(match[1]!.replace(/,/g, "")) * 100));
    const section = /^รวมเบิก: ([\d,]+\.\d{2}) บาท$/m.exec(result)![1]!;

    expect(subtotals).toHaveLength(4);
    expect(subtotals.reduce((a, b) => a + b, 0))
      .toBe(Math.round(Number(section.replace(/,/g, "")) * 100));
    // 14.5 × 50 and 2.5 × 35 are exact to the satang, not merely close.
    expect(result).toContain("รวมผลไม้ 725.00 บาท");
    expect(result).toContain("รวมไม่จัดหมวด 87.50 บาท");
  });
});

describe("buildWeighSessionSummary — price-basis rows", () => {
  it("shows the basis equation instead of an inconsistent qty × price_per_unit line", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BASIS_ITEM] }));

    // Must never print "32.00 หัว × 6.67" — that arithmetic doesn't multiply out.
    expect(result).not.toContain("× 6.67 ");
    // Must show the real basis and the correctly rounded total (32 × 20 / 3 = 213.33).
    expect(result).toContain("32.00 หัว × 20.00 บาท / 3.00 หัว = 213.33");
    expect(result).toContain("รวมเบิก: 213.33");
  });
});

describe("buildWeighSessionSummary — header", () => {
  it("แสดงชื่อ staff และวันที่ไทย", () => {
    const result = buildWeighSessionSummary(makeSession({ staff_name: "พี่ดำ", date: "2026-06-01" }));
    expect(result).toContain("บันทึกแล้ว ✅");
    expect(result).toContain("พี่ดำ");
    expect(result).toContain("2569"); // Buddhist era
  });

  it("session ที่ไม่มี items ยังแสดง header ได้", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [] }));
    expect(result).toContain("บันทึกแล้ว ✅");
  });
});

describe("pushLineMessage — X-Line-Retry-Key and 409 handling", () => {
  it("transmits X-Line-Retry-Key header when retryKey is provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await pushLineMessage("group-id", "hello", "retry-uuid-123");

    expect(capturedHeaders["X-Line-Retry-Key"]).toBe("retry-uuid-123");
  });

  it("does NOT transmit X-Line-Retry-Key when retryKey is omitted", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await pushLineMessage("group-id", "hello");

    expect(capturedHeaders["X-Line-Retry-Key"]).toBeUndefined();
  });

  it("2xx returns { status: 'delivered' }", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const result = await pushLineMessage("group-id", "hello", "retry-key");
    expect(result).toEqual({ status: "delivered" });
  });

  it("409 with retry key returns { status: 'already_accepted' } and does not throw", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 409 })) as unknown as typeof fetch;

    const result = await pushLineMessage("group-id", "hello", "retry-key");
    expect(result).toEqual({ status: "already_accepted" });
  });

  it("409 without retry key throws (not treated as already_accepted)", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 409 })) as unknown as typeof fetch;

    await expect(pushLineMessage("group-id", "hello")).rejects.toThrow(
      "LINE push HTTP 409",
    );
  });

  it("400 remains a failure", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 400 })) as unknown as typeof fetch;

    await expect(pushLineMessage("group-id", "hello", "retry-key")).rejects.toThrow(
      "LINE push HTTP 400",
    );
  });

  it("401 remains a failure", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 401 })) as unknown as typeof fetch;

    await expect(pushLineMessage("group-id", "hello", "retry-key")).rejects.toThrow(
      "LINE push HTTP 401",
    );
  });

  it("500 remains a failure", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 500 })) as unknown as typeof fetch;

    await expect(pushLineMessage("group-id", "hello", "retry-key")).rejects.toThrow(
      "LINE push HTTP 500",
    );
  });
});

describe("LINE API error logging", () => {
  it("logs reply response body and message metrics without exposing them in thrown errors", async () => {
    const sensitiveBody = '{"message":"sensitive LINE detail"}';
    globalThis.fetch = (async () =>
      new Response(sensitiveBody, { status: 401 })) as unknown as typeof fetch;
    const errorLog = spyOn(console, "error").mockImplementation(() => {});

    await expect(replyLineMessage("reply-token", "message")).rejects.toThrow(
      "LINE reply HTTP 401",
    );

    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("authentication_error");
    expect(logged).toContain("reply");
    expect(logged).toContain("responseBody");
    expect(logged).toContain("messageCount");
    expect(logged).toContain("codePoints");
    expect(logged).toContain("utf8Bytes");
    expect(logged).toContain("sensitive LINE detail");

    let thrown: unknown;
    try {
      await replyLineMessage("reply-token", "message");
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).not.toContain(sensitiveBody);
    errorLog.mockRestore();
  });

  it("replyLineMessages sends multiple text objects and logs each message length", async () => {
    type CapturedReplyBody = { messages: Array<{ type: string; text: string }> };
    let capturedBody: CapturedReplyBody | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as CapturedReplyBody;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const infoLog = spyOn(console, "log").mockImplementation(() => {});

    await replyLineMessages("reply-token", ["part one", "part two"]);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.messages).toEqual([
      { type: "text", text: "part one" },
      { type: "text", text: "part two" },
    ]);

    const logged = infoLog.mock.calls.flat().join(" ");
    expect(logged).toContain("messageCount");
    expect(logged).toContain("codePoints");
    infoLog.mockRestore();
  });

  it("measureLineText counts Unicode code points and UTF-8 bytes", () => {
    expect(measureLineText("abc")).toEqual({ codePoints: 3, utf8Bytes: 3 });
    expect(measureLineText("👋")).toEqual({ codePoints: 1, utf8Bytes: 4 });
  });

  it("does not log or throw the LINE push response body", async () => {
    const sensitiveBody = '{"message":"recipient detail"}';
    globalThis.fetch = (async () =>
      new Response(sensitiveBody, { status: 429 })) as unknown as typeof fetch;
    const errorLog = spyOn(console, "error").mockImplementation(() => {});

    await expect(pushLineMessage("group-id", "message")).rejects.toThrow(
      "LINE push HTTP 429",
    );

    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("rate_limit_error");
    expect(logged).toContain("push");
    expect(logged).not.toContain(sensitiveBody);
    expect(logged).not.toContain("recipient detail");
    errorLog.mockRestore();
  });
});

describe("LINE push retry metadata", () => {
  it("classifies 429 and exposes Retry-After without exposing the body", async () => {
    globalThis.fetch = (async () =>
      new Response('{"message":"private detail"}', {
        status: 429,
        headers: { "Retry-After": "7" },
      })) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await pushLineMessage("group-id", "hello", "retry-key");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LinePushError);
    expect(thrown).toMatchObject({
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 7_000,
      message: "LINE push HTTP 429",
    });
  });

  it("parses an HTTP-date Retry-After value", () => {
    expect(parseRetryAfterMs(
      "Fri, 03 Jul 2026 00:00:12 GMT",
      Date.parse("2026-07-03T00:00:00.000Z"),
    )).toBe(12_000);
  });
});

describe("buildAdditionalSessionSummary — previous total line", () => {
  // 10 โล × 100 = 1000
  const ADD_ITEM = { ...BORROW_ITEM, transaction_type: "เบิก" as const };

  function additionalSession(
    declared: "เบิก" | "คืน" | "คืนเสีย",
    items = [ADD_ITEM],
  ) {
    return makeSession({
      session_kind: "additional",
      declared_transaction_type: declared,
      items: items.map((item) => ({ ...item, transaction_type: declared })),
    });
  }

  it("shows previous, batch, and cumulative totals in order", () => {
    const result = buildAdditionalSessionSummary(additionalSession("เบิก"), {
      cumulativeTotal: 1055,
      hasMatchingMain: true,
    });

    expect(result).toBe([
      "บันทึกรายการเบิกเพิ่มแล้ว ✅",
      "",
      "เพิ่ม 1 รายการ",
      "ยอดเดิมก่อนเพิ่ม: 55.00 บาท",
      "ยอดเพิ่ม: 1,000.00 บาท",
      "ยอดสะสมของวัน: 1,055.00 บาท",
    ].join("\n"));
  });

  it.each([
    ["เบิก", "เบิกเพิ่ม"],
    ["คืน", "ชั่งคืนเพิ่ม"],
    ["คืนเสีย", "คืนเสียเพิ่ม"],
  ] as const)("labels a %s addition as %s with the same line layout", (declared, label) => {
    const result = buildAdditionalSessionSummary(additionalSession(declared), {
      cumulativeTotal: 1500,
      hasMatchingMain: true,
    });

    expect(result).toContain(`บันทึกรายการ${label}แล้ว ✅\n\nเพิ่ม 1 รายการ`);
    expect(result).toContain("ยอดเดิมก่อนเพิ่ม: 500.00 บาท");
    expect(result).toContain("ยอดเพิ่ม: 1,000.00 บาท");
    expect(result).toContain("ยอดสะสมของวัน: 1,500.00 บาท");
  });

  it("clamps floating-point residue in the previous total to zero", () => {
    // First addition of the day: cumulative == batch total, but computed with
    // a tiny floating-point residue.
    const result = buildAdditionalSessionSummary(additionalSession("คืน"), {
      cumulativeTotal: 1000.0000000000001,
      hasMatchingMain: false,
    });

    expect(result).toContain("ยอดเดิมก่อนเพิ่ม: 0.00 บาท");
    expect(result).not.toContain("-0.00");
    expect(result).toContain("ยังไม่พบชุดหลัก");
  });

  it("formats fractional previous totals to 2 decimals", () => {
    const result = buildAdditionalSessionSummary(additionalSession("คืนเสีย"), {
      cumulativeTotal: 1012.345,
      hasMatchingMain: true,
    });

    expect(result).toContain("ยอดเดิมก่อนเพิ่ม: 12.35 บาท");
    expect(result).toContain("ยอดสะสมของวัน: 1,012.35 บาท");
  });
});

function weighItem(overrides: Partial<WeighSessionItem>): WeighSessionItem {
  return {
    item_number: 1,
    product_name: "ทดสอบ",
    price_per_unit: 0,
    quantity: 0,
    unit: "โล",
    section: "",
    transaction_type: "เบิก",
    pricing_mode: "unit",
    basis_quantity: null,
    basis_unit: null,
    basis_price: null,
    ...overrides,
  };
}

// Independent reference for the "documented DB formula" — half-up division
// on plain BigInt. Deliberately NOT imported from src/lib/sales/calculate.ts,
// so the generated sweeps below check weighItemTotalSatang against the
// formula's definition, not against the implementation reusing its own helper.
function exactRoundHalfUp(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder * BigInt(2) >= divisor ? quotient + BigInt(1) : quotient;
}

describe("weighItemTotalSatang — exact money, no floating-point reimplementation", () => {
  // Regression: produce_transactions computes a unit row's total as
  // `quantity * price_per_unit` and a basis row's total as
  // `ROUND(quantity * basis_price / basis_quantity, 2)`
  // (supabase/migrations/0033_produce_basis_pricing.sql). The pre-fix LINE
  // receipt reimplemented this in IEEE-754 floating point, and the unit
  // branch applied NO rounding at all: quantity 1.001 x price 10 returned
  // the raw float 10.009999999999998, not 10.01.
  it("unit row: quantity 1.001 x price 10 — old code returned the raw unrounded float", () => {
    const item = weighItem({ quantity: 1.001, price_per_unit: 10, pricing_mode: "unit" });
    // What the pre-fix code literally returned for this input:
    expect(1.001 * 10).toBe(10.009999999999998);
    // What the fixed code returns:
    expect(weighItemTotalSatang(item)).toBe(1_001);
    expect(weighItemTotal(item)).toBe(10.01);
  });

  it("unit row: quantity 1.001 x price 2 — old code returned the raw unrounded float", () => {
    const item = weighItem({ quantity: 1.001, price_per_unit: 2, pricing_mode: "unit" });
    // What the pre-fix code literally returned for this input:
    expect(1.001 * 2).toBe(2.002);
    // What the fixed code returns:
    expect(weighItemTotalSatang(item)).toBe(200);
    expect(weighItemTotal(item)).toBe(2);
  });

  it("basis row: quantity 1.001, basis price 10 / basis qty 3 — round(qty*price/basis,2)", () => {
    const item = weighItem({
      quantity: 1.001,
      pricing_mode: "basis",
      basis_quantity: 3,
      basis_price: 10,
    });
    // round(1.001 * 10 / 3, 2) = round(3.336666..., 2) = 3.34
    expect(weighItemTotalSatang(item)).toBe(334);
    expect(weighItemTotal(item)).toBe(3.34);
  });

  it("basis row: quantity 1.001, basis price 2 / basis qty 3 — round(qty*price/basis,2)", () => {
    const item = weighItem({
      quantity: 1.001,
      pricing_mode: "basis",
      basis_quantity: 3,
      basis_price: 2,
    });
    // round(1.001 * 2 / 3, 2) = round(0.667333..., 2) = 0.67
    expect(weighItemTotalSatang(item)).toBe(67);
    expect(weighItemTotal(item)).toBe(0.67);
  });

  // A real rounding-boundary case the old float division got wrong by a
  // whole satang: 0.225 x 17.40 / 1 = 3.915 exactly, which is a half-up
  // tie that rounds to 3.92 — but JS computes 0.225 * 17.4 as
  // 3.9149999999999996, and Math.round(391.49999999999994) floors to 391.
  it("basis row: a real float-division rounding-boundary miss (0.225 x 17.40 / 1)", () => {
    const item = weighItem({
      quantity: 0.225,
      pricing_mode: "basis",
      basis_quantity: 1,
      basis_price: 17.4,
    });
    const oldFloatResult = Math.round(((0.225 * 17.4) / 1) * 100) / 100;
    expect(oldFloatResult).toBe(3.91); // the bug: off by one satang
    expect(weighItemTotalSatang(item)).toBe(392);
    expect(weighItemTotal(item)).toBe(3.92); // the correct half-up result
  });

  // Generated property-style sweep: weighItemTotalSatang must equal the
  // documented DB formula, computed independently in exact integer
  // arithmetic, for every generated quantity/price pair — including many
  // rounding-boundary combinations, never just the hand-picked cases above.
  it("matches the documented DB formula for many generated quantity/price pairs (unit rows)", () => {
    let checked = 0;
    for (let qtyMilli = 1; qtyMilli <= 20_000; qtyMilli += 37) {
      for (let priceSatang = 1; priceSatang <= 3_000; priceSatang += 211) {
        const item = weighItem({
          quantity: qtyMilli / 1000,
          price_per_unit: priceSatang / 100,
          pricing_mode: "unit",
        });
        const expected = exactRoundHalfUp(BigInt(qtyMilli) * BigInt(priceSatang), BigInt(1000));
        expect(weighItemTotalSatang(item)).toBe(Number(expected));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("matches the documented DB formula for many generated quantity/price/basis-quantity triples (basis rows)", () => {
    const basisQtyMillis = [1, 13, 999, 1_000, 3_000, 7_000, 11_000].map(BigInt);
    let checked = 0;
    for (let qtyMilli = 1; qtyMilli <= 5_000; qtyMilli += 233) {
      for (let priceSatang = 1; priceSatang <= 2_000; priceSatang += 251) {
        for (const basisQtyMilli of basisQtyMillis) {
          const item = weighItem({
            quantity: qtyMilli / 1000,
            pricing_mode: "basis",
            basis_quantity: Number(basisQtyMilli) / 1000,
            basis_price: priceSatang / 100,
          });
          const expected = exactRoundHalfUp(BigInt(qtyMilli) * BigInt(priceSatang), basisQtyMilli);
          expect(weighItemTotalSatang(item)).toBe(Number(expected));
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe("weighItemTotalMilliSatang — unit rows are EXACT, never rounded (adversarial-review BLOCKER)", () => {
  // produce_transactions_all's unit-row term is plain NUMERIC multiplication
  // (`quantity * price_per_unit`) and the view NEVER rounds it — only the
  // basis-row term gets ROUND(...,2). A receipt total that rounds the unit
  // branch disagrees with every other consumer of total_amount (financial
  // summary, report summary, daily-summary-cron, settlement, both PDF
  // exports). This locks in that the exact internal value — not just the
  // rounded display value — matches the view bit for bit.
  it("quantity 1.001 x price 2 is exactly 2.002 baht (200200 milli-satang), matching the DB's unrounded NUMERIC product", () => {
    const item = weighItem({ quantity: 1.001, price_per_unit: 2, pricing_mode: "unit" });
    // 1.001 * 2 = 2.002 baht exactly = 200200 milli-satang (10^-5 baht). The
    // internal value is NOT 200 satang (2.00) — that only appears once this
    // is rounded for single-line display via weighItemTotalSatang.
    expect(weighItemTotalMilliSatang(item)).toBe(BigInt(200_200));
    // The rounded display value is still 2.00 — rounding happens ONCE, at
    // the display boundary, not lost from the exact value above.
    expect(weighItemTotal(item)).toBe(2);
  });

  it("quantity 1.001 x price 10 is exactly 10.01 baht (1001000 milli-satang) with zero remainder", () => {
    const item = weighItem({ quantity: 1.001, price_per_unit: 10, pricing_mode: "unit" });
    expect(weighItemTotalMilliSatang(item)).toBe(BigInt(1_001_000));
  });

  it("a unit row with a genuine sub-satang remainder keeps it in the exact value", () => {
    // quantity 0.333 x price 0.01 = 0.00333 baht = 333 milli-satang exactly
    // — a real amount the DB view stores and never rounds away.
    const item = weighItem({ quantity: 0.333, price_per_unit: 0.01, pricing_mode: "unit" });
    expect(weighItemTotalMilliSatang(item)).toBe(BigInt(333));
    expect(weighItemTotalSatang(item)).toBe(0); // rounds to 0 satang for single-line display
  });

  it("basis rows scale the DB's already-rounded satang up to milli-satang exactly (no second rounding)", () => {
    const item = weighItem({
      quantity: 1.001,
      pricing_mode: "basis",
      basis_quantity: 3,
      basis_price: 10,
    });
    // round(1.001 * 10 / 3, 2) = 3.34 baht = 334 satang = 334_000 milli-satang.
    expect(weighItemTotalMilliSatang(item)).toBe(BigInt(334_000));
  });

  // Generated sweep: the exact milli-satang value for a unit row must equal
  // quantityMilli * priceSatang with NO rounding, for many combinations —
  // including ones whose product is not a whole number of satang.
  it("matches quantityMilli x priceSatang exactly (no rounding) for many generated unit-row pairs", () => {
    let checked = 0;
    for (let qtyMilli = 1; qtyMilli <= 20_000; qtyMilli += 37) {
      for (let priceSatang = 1; priceSatang <= 3_000; priceSatang += 211) {
        const item = weighItem({
          quantity: qtyMilli / 1000,
          price_per_unit: priceSatang / 100,
          pricing_mode: "unit",
        });
        expect(weighItemTotalMilliSatang(item)).toBe(BigInt(qtyMilli) * BigInt(priceSatang));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
});

describe("sumWeighItemsSatang — exact sum, rounded ONCE at the end (MEDIUM 1)", () => {
  // The exact regression this codebase already documented once (see the
  // comment above buildSection about 0.13 + 0.13 + 0.13 printing as 0.39
  // against a 0.38 subtotal): summing PRE-ROUNDED per-item totals can drift
  // from rounding the exact sum once. Three items whose milli-satang value
  // each rounds down to 13 satang individually, but whose exact sum rounds
  // UP to 40 satang, not 39.
  it("sums the exact milli-satang value, not three pre-rounded satang values", () => {
    // quantity 13.334 x price 0.01 = 0.13334 baht = 13334 milli-satang.
    // Rounded per item: 13334 -> round(13.334) = 13 satang. Three of those
    // summed the old (wrong) way = 39 satang = 0.39 baht.
    const item = weighItem({ quantity: 13.334, price_per_unit: 0.01, pricing_mode: "unit" });
    expect(weighItemTotalMilliSatang(item)).toBe(BigInt(13_334));
    expect(weighItemTotalSatang(item)).toBe(13); // per-item display, rounds down

    const wrongSumOfRoundedItems = 3 * weighItemTotalSatang(item); // the old bug's shape
    expect(wrongSumOfRoundedItems).toBe(39);

    // Exact sum: 13334 * 3 = 40002 milli-satang -> round once -> 40 satang.
    expect(sumWeighItemsSatang([item, item, item])).toBe(40);
  });

  it("an empty item list sums to exactly zero", () => {
    expect(sumWeighItemsSatang([])).toBe(0);
  });
});

describe("weighItemTotalMilliSatang — fails closed, never a silent zero (MEDIUM 2 / MEDIUM 3)", () => {
  it("throws rather than returning 0 for a non-finite quantity", () => {
    const item = weighItem({ quantity: Number.NaN, price_per_unit: 10, pricing_mode: "unit" });
    expect(() => weighItemTotalMilliSatang(item)).toThrow(/invalid_weigh_item_quantity/);
  });

  it("throws rather than returning 0 for a negative quantity", () => {
    const item = weighItem({ quantity: -1, price_per_unit: 10, pricing_mode: "unit" });
    expect(() => weighItemTotalMilliSatang(item)).toThrow(/invalid_weigh_item_quantity/);
  });

  it("basis_quantity: 0 is falsy, so it falls through to the unit branch by design", () => {
    // Matches the pre-existing `if (item.basis_quantity && ...)` guard: a
    // zero basis_quantity was never a valid basis row, so this is not a new
    // precondition to enforce — it is the unit branch, unchanged.
    const item = weighItem({
      quantity: 1,
      price_per_unit: 10,
      pricing_mode: "basis",
      basis_quantity: 0,
      basis_price: 20,
    });
    expect(weighItemTotalMilliSatang(item)).toBe(BigInt(1000) * BigInt(1000));
  });

  it("throws rather than returning 0 for a negative basis_quantity", () => {
    const item = weighItem({
      quantity: 1,
      pricing_mode: "basis",
      basis_quantity: -1,
      basis_price: 10,
    });
    expect(() => weighItemTotalMilliSatang(item)).toThrow(/invalid_weigh_item_basis_quantity/);
  });

  it("throws rather than returning 0 for a negative basis_price (MEDIUM 3 sign guard)", () => {
    const item = weighItem({
      quantity: 1,
      pricing_mode: "basis",
      basis_quantity: 3,
      basis_price: -10,
    });
    expect(() => weighItemTotalMilliSatang(item)).toThrow(/invalid_weigh_item_basis_price/);
  });

  it("throws rather than returning 0 for a negative price_per_unit", () => {
    const item = weighItem({ quantity: 1, price_per_unit: -10, pricing_mode: "unit" });
    expect(() => weighItemTotalMilliSatang(item)).toThrow(/invalid_weigh_item_price/);
  });
});
