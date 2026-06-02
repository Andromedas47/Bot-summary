import { describe, it, expect } from "bun:test";
import type { LineMessageEvent } from "@/lib/line/types";
import { parseWeighSession, bangkokTimeFromTimestamp, WeighSessionParser } from "./parser";
import { RE } from "./regex";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EXAMPLE_1 = `\
18:53 เสือ รายการชั่งคืน
18:53 เสือ 1.หมอนทอง119บาท

38โล
18:53 เสือ 2.หมอนทอง119บาท

42โล
18:53 เสือ 3.หมอนทอง119บาท

18.5โล
18:53 เสือ 4.กระดุม100บาท

30.3โล
18:53 เสือ 5.ชะนี100บาท

38.3โล
18:53 เสือ 6.กระท้อน35บาท

14.5โล
18:53 เสือ คืนเสีย
18:53 เสือ 1.ชะนี100บาท

11.6โล
18:53 เสือ 2.กระท้อน35บาท

4.1โล
18:53 เสือ จบรายการชั่งคืนและคืนเสีย`;

const EXAMPLE_2 = `\
18:56 เสือ รายการชั่งเบิกไปตลาด72

25/5/69
18:56 เสือ 2หมอนทอง119บาท

38.1.โล
18:56 เสือ 3หมอนทอง119บาท

35.7.โล
18:56 เสือ 4กระดุม100บาท

29.9.โล
18:56 เสือ 5ชะนี100บาท

28.3.โล
18:56 เสือ 6ชะนี100บาท

28.โล
18:56 เสือ 7ก้านบาว109บาท

48.1.โล
18:56 เสือ 8กระท้อน40บาท

5.9.โล
18:56 เสือ 9กระท้อน30บาท

14.2.โล
18:56 เสือ 10ส้มไต้หวัน40บาท

2.6.โล
18:56 เสือ 11แอปเปิ้ล15บาท

9ลูก
18:56 เสือ 12แตงไทย20บาท

3ลูก
18:56 เสือ 13สัปปรถ15บาท

6.ลูก
18:56 เสือ 14สละ30บาท

22.2.โล
18:56 เสือ 15ทุเรียนกล่อง100บาท

13.กล่อง
18:56 เสือ รายการเบิกเพิ่ม
18:56 เสือ 16มะพร้าว25บาท

23.ลูก
18:56 เสือ 17ฝรั่งขาว45บาท

18.6.โล
18:56 เสือ 18ทุเรียนกล่อง100บาท

12.กล่อง
18:56 เสือ จบรายการชั่งเบิก`;

// ── Example 1: รายการชั่งคืน ──────────────────────────────────────────────────

describe("Example 1: รายการชั่งคืน", () => {
  const result = parseWeighSession(EXAMPLE_1);

  it("extracts staff name", () => {
    expect(result.staff_name).toBe("เสือ");
  });

  it("extracts session title", () => {
    expect(result.session_title).toBe("รายการชั่งคืน");
  });

  it("has no date (not present in input)", () => {
    expect(result.date).toBeNull();
  });

  it("parses 8 items total", () => {
    expect(result.items).toHaveLength(8);
  });

  it("parses no errors", () => {
    expect(result.parse_errors).toHaveLength(0);
  });

  it("parses main-section items correctly", () => {
    const main = result.items.filter((i) => i.section === "main");
    expect(main).toHaveLength(6);

    expect(main[0]).toMatchObject({
      item_number: 1, product_name: "หมอนทอง", price_per_unit: 119,
      quantity: 38, unit: "โล", section: "main",
    });
    expect(main[2]).toMatchObject({
      item_number: 3, product_name: "หมอนทอง", price_per_unit: 119,
      quantity: 18.5, unit: "โล",
    });
    expect(main[5]).toMatchObject({
      item_number: 6, product_name: "กระท้อน", price_per_unit: 35,
      quantity: 14.5, unit: "โล",
    });
  });

  it("parses คืนเสีย section items correctly", () => {
    const returns = result.items.filter((i) => i.section === "คืนเสีย");
    expect(returns).toHaveLength(2);

    expect(returns[0]).toMatchObject({
      item_number: 1, product_name: "ชะนี", price_per_unit: 100,
      quantity: 11.6, unit: "โล", section: "คืนเสีย",
    });
    expect(returns[1]).toMatchObject({
      item_number: 2, product_name: "กระท้อน", price_per_unit: 35,
      quantity: 4.1, unit: "โล", section: "คืนเสีย",
    });
  });
});

// ── Example 2: รายการชั่งเบิก ─────────────────────────────────────────────────

describe("Example 2: รายการชั่งเบิกไปตลาด", () => {
  const result = parseWeighSession(EXAMPLE_2);

  it("extracts staff name", () => {
    expect(result.staff_name).toBe("เสือ");
  });

  it("extracts session title with market number", () => {
    expect(result.session_title).toBe("รายการชั่งเบิกไปตลาด72");
  });

  it("parses Buddhist short year date", () => {
    expect(result.date).toBe("2026-05-25"); // 25/5/69 → 2569 BE → 2026 CE
  });

  it("parses 17 items total", () => {
    expect(result.items).toHaveLength(17);
  });

  it("parses no errors", () => {
    expect(result.parse_errors).toHaveLength(0);
  });

  it("handles item number without dot separator", () => {
    const item2 = result.items.find((i) => i.item_number === 2);
    expect(item2).toMatchObject({
      product_name: "หมอนทอง", price_per_unit: 119, quantity: 38.1, unit: "โล",
    });
  });

  it("handles weight with trailing dot (38.1.โล → 38.1)", () => {
    const item3 = result.items.find((i) => i.item_number === 3);
    expect(item3?.quantity).toBe(35.7);
  });

  it("handles integer weight with trailing dot (28.โล → 28)", () => {
    const item6 = result.items.find((i) => i.item_number === 6 && i.section === "main");
    expect(item6?.quantity).toBe(28);
    expect(item6?.unit).toBe("โล");
  });

  it("handles ลูก unit without dot (9ลูก)", () => {
    const item11 = result.items.find((i) => i.item_number === 11);
    expect(item11).toMatchObject({ quantity: 9, unit: "ลูก" });
  });

  it("handles ลูก unit with dot (6.ลูก → 6)", () => {
    const item13 = result.items.find((i) => i.item_number === 13);
    expect(item13).toMatchObject({ quantity: 6, unit: "ลูก" });
  });

  it("handles กล่อง unit (13.กล่อง → 13)", () => {
    const item15 = result.items.find((i) => i.item_number === 15);
    expect(item15).toMatchObject({
      product_name: "ทุเรียนกล่อง", price_per_unit: 100, quantity: 13, unit: "กล่อง",
    });
  });

  it("handles two-digit item numbers", () => {
    const item10 = result.items.find((i) => i.item_number === 10);
    expect(item10).toMatchObject({ product_name: "ส้มไต้หวัน", price_per_unit: 40 });
  });

  it("parses รายการเบิกเพิ่ม section items", () => {
    const extra = result.items.filter((i) => i.section === "รายการเบิกเพิ่ม");
    expect(extra).toHaveLength(3);

    expect(extra[0]).toMatchObject({
      item_number: 16, product_name: "มะพร้าว", price_per_unit: 25,
      quantity: 23, unit: "ลูก",
    });
    expect(extra[1]).toMatchObject({
      item_number: 17, product_name: "ฝรั่งขาว", price_per_unit: 45,
      quantity: 18.6, unit: "โล",
    });
    expect(extra[2]).toMatchObject({
      item_number: 18, product_name: "ทุเรียนกล่อง", price_per_unit: 100,
      quantity: 12, unit: "กล่อง",
    });
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("real message: short withdraw header followed by return section", () => {
  const result = parseWeighSession(`\
13:29 เสือ จิ๋วเบิก 25/5/2569
13:29 เสือ 1.ทุเรียนรวม89บาท

28.8โล
13:29 เสือ 2.ทุเรียนรวม89บาท

38.6โล
13:29 เสือ 3.ทุเรียนรวม100บาท

54.8โล
13:29 เสือ 4.ทุเรียนรวม89บาท

20.1โล
13:29 เสือ จบรายการชั่งเบิก
13:29 เสือ รายการชั่งคืน
13:29 เสือ 1.ทุเรียนรวม100บาท

26.3โล
13:29 เสือ 2.ทุเรียนรวม89บาท

44.7โล
13:30 เสือ จบรายการชั่งคืน`);

  it("extracts session metadata from short header", () => {
    expect(result.staff_name).toBe("เสือ");
    expect(result.session_title).toBe("จิ๋วเบิก 25/5/2569");
    expect(result.date).toBe("2026-05-25");
  });

  it("parses withdraw and return items from the same message", () => {
    expect(result.items).toHaveLength(6);
    expect(result.parse_errors).toHaveLength(0);

    expect(result.items[0]).toMatchObject({
      item_number: 1, product_name: "ทุเรียนรวม", price_per_unit: 89,
      quantity: 28.8, unit: "โล", section: "main",
    });
    expect(result.items[3]).toMatchObject({
      item_number: 4, product_name: "ทุเรียนรวม", price_per_unit: 89,
      quantity: 20.1, unit: "โล", section: "main",
    });
    expect(result.items[4]).toMatchObject({
      item_number: 1, product_name: "ทุเรียนรวม", price_per_unit: 100,
      quantity: 26.3, unit: "โล", section: "รายการชั่งคืน",
    });
    expect(result.items[5]).toMatchObject({
      item_number: 2, product_name: "ทุเรียนรวม", price_per_unit: 89,
      quantity: 44.7, unit: "โล", section: "รายการชั่งคืน",
    });
  });
});

describe("edge cases", () => {
  it("saves item with null quantity when weight line is missing", () => {
    const result = parseWeighSession(`\
18:53 เสือ รายการชั่งคืน
18:53 เสือ 1.หมอนทอง119บาท
18:53 เสือ 2.กระดุม100บาท

25โล
18:53 เสือ จบรายการชั่งคืน`);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ item_number: 1, quantity: null, unit: null });
    expect(result.items[1]).toMatchObject({ item_number: 2, quantity: 25, unit: "โล" });
  });

  it("records error for orphan quantity (weight with no preceding item)", () => {
    const result = parseWeighSession(`\
18:53 เสือ รายการชั่งคืน
38โล
18:53 เสือ จบรายการชั่งคืน`);

    expect(result.parse_errors).toHaveLength(1);
    expect(result.parse_errors[0]).toMatch(/quantity with no preceding item/);
  });

  it("ignores non-session messages before SESSION_START", () => {
    const result = parseWeighSession(`\
18:50 เสือ ดีครับ
18:51 เสือ รายการชั่งคืน
18:51 เสือ 1.หมอนทอง119บาท

20โล
18:51 เสือ จบรายการชั่งคืน`);

    expect(result.items).toHaveLength(1);
    expect(result.session_title).toBe("รายการชั่งคืน");
  });

  it("handles missing session-end marker", () => {
    const result = parseWeighSession(`\
18:53 เสือ รายการชั่งคืน
18:53 เสือ 1.หมอนทอง119บาท

38โล`);

    // Pending item saved on EOF
    expect(result.items).toHaveLength(1);
    expect(result.items[0].quantity).toBe(38);
  });

  it("parses full Buddhist year date (4 digits)", () => {
    const result = parseWeighSession(`\
18:53 เสือ รายการชั่งคืน
18/5/2568
18:53 เสือ 1.หมอนทอง119บาท

10โล
18:53 เสือ จบรายการชั่งคืน`);

    expect(result.date).toBe("2025-05-18");
  });

  it("uses fallback date when message text has time but no date", () => {
    const result = parseWeighSession("12:47 เสือ รายการชั่งคืน", "2026-05-29");
    expect(result.date).toBe("2026-05-29");
  });
});

// ── Real sample: พี่ดำ-เฉลิมฯ72 with แพค unit ────────────────────────────────

describe("real sample: พี่ดำ-เฉลิมฯ72 ทุเรียน with แพค unit (4 items)", () => {
  const SAMPLE = `\
พี่ดำ-เฉลิมฯ72ทุเรียน เบิก 30/5/2569

1หมอนทอง119บาท

23.4.โล

2ก้านยาว109บาท

8.6.โล

3ชะนี100บาท

15.5.โล

5ทุเนียนกล่อง80บาท

20.แพค

จบรายการเบิก`;

  const result = parseWeighSession(SAMPLE);

  it("parses 4 items", () => {
    expect(result.items).toHaveLength(4);
  });

  it("parses no errors", () => {
    expect(result.parse_errors).toHaveLength(0);
  });

  it("extracts staff name and date", () => {
    expect(result.staff_name).toBe("พี่ดำ");
    expect(result.date).toBe("2026-05-30");
  });

  it("parses item 1 — หมอนทอง 23.4 โล", () => {
    expect(result.items[0]).toMatchObject({
      item_number: 1, product_name: "หมอนทอง", price_per_unit: 119,
      quantity: 23.4, unit: "โล",
    });
  });

  it("parses item 2 — ก้านยาว 8.6 โล", () => {
    expect(result.items[1]).toMatchObject({
      item_number: 2, product_name: "ก้านยาว", price_per_unit: 109,
      quantity: 8.6, unit: "โล",
    });
  });

  it("parses item 3 — ชะนี 15.5 โล", () => {
    expect(result.items[2]).toMatchObject({
      item_number: 3, product_name: "ชะนี", price_per_unit: 100,
      quantity: 15.5, unit: "โล",
    });
  });

  it("parses item 5 — ทุเนียนกล่อง 20 แพค (skipped number 4 is ok)", () => {
    expect(result.items[3]).toMatchObject({
      item_number: 5, product_name: "ทุเนียนกล่อง", price_per_unit: 80,
      quantity: 20, unit: "แพค",
    });
  });

  it("total borrow = 119×23.4 + 109×8.6 + 100×15.5 + 80×20 = 6,872", () => {
    const borrow = result.items
      .filter((i) => i.transaction_type === "เบิก" || i.transaction_type === "เบิกเพิ่ม")
      .reduce((sum, i) => sum + (i.price_per_unit ?? 0) * (i.quantity ?? 0), 0);
    expect(borrow).toBeCloseTo(6872, 1);
  });
});

// ── bangkokTimeFromTimestamp ──────────────────────────────────────────────────

describe("bangkokTimeFromTimestamp", () => {
  it("converts ms timestamp to Bangkok HH:mm", () => {
    // 2026-05-31T11:34:00Z = 18:34 Bangkok (UTC+7)
    const ts = Date.UTC(2026, 4, 31, 11, 34, 0);
    expect(bangkokTimeFromTimestamp(ts)).toBe("18:34");
  });

  it("pads single-digit minute", () => {
    // 2026-05-31T04:05:00Z = 11:05 Bangkok
    const ts = Date.UTC(2026, 4, 31, 4, 5, 0);
    expect(bangkokTimeFromTimestamp(ts)).toBe("11:05");
  });

  it("returns null for undefined", () => {
    expect(bangkokTimeFromTimestamp(undefined)).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(bangkokTimeFromTimestamp(NaN)).toBeNull();
  });
});

// ── transaction_time fallback logic ──────────────────────────────────────────

describe("transaction_time fallback", () => {
  it("uses time from message prefix when present — ignores fallbackTime", () => {
    const result = parseWeighSession("18:34 เสือ รายการชั่งคืน", null, "12:00");
    expect(result.transaction_time).toBe("18:34");
  });

  it("uses fallbackTime when message has no time prefix", () => {
    const result = parseWeighSession(
      "เสือ-ตลาด72 เบิก\n1.หมอนทอง119บาท\n38โล\nจบรายการเบิก",
      null,
      "18:34",
    );
    expect(result.transaction_time).toBe("18:34");
  });

  it("returns null when no prefix and no fallbackTime", () => {
    const result = parseWeighSession("เสือ-ตลาด72 เบิก\n1.หมอนทอง119บาท\n38โล\nจบรายการเบิก");
    expect(result.transaction_time).toBeNull();
  });

  it("pending session simulation: normalized accumulated text uses fallbackTime", () => {
    // normalizeText strips "HH:MM sender " prefixes, so parser sees no TIME_PREFIX.
    // finalizeAccumulated passes created_at-derived time as fallbackTime.
    const accumulated = [
      "เสือ-ตลาด72 เบิก 31/5/2569",
      "1.หมอนทอง119บาท",
      "38โล",
      "จบรายการเบิก",
    ].join("\n");
    const result = parseWeighSession(accumulated, "2026-05-31", "18:34");
    expect(result.transaction_time).toBe("18:34");
    expect(result.date).toBe("2026-05-31");
    expect(result.items).toHaveLength(1);
  });

  it("pending session raw accumulated text preserves LINE sender from prefix", () => {
    const accumulated = [
      "09:50 กี่ วัดทุ่งลานนา เบิก 30/5/2569",
      "09:50 กี่ 1.กระท้อน8.1บาท",
      "1โล",
      "09:50 กี่ จบรายการเบิก",
    ].join("\n");

    const result = parseWeighSession(accumulated, "2026-05-30", "09:50");
    expect(result.sender_name).toBe("กี่");
    expect(result.staff_name).toBe("กี่");
    expect(result.transaction_time).toBe("09:50");
  });
});

// ── Regex unit tests ──────────────────────────────────────────────────────────

describe("WeighSessionParser timestamp fallback", () => {
  it("uses LINE event.timestamp when text has no time prefix", async () => {
    const event: LineMessageEvent = {
      type: "message",
      webhookEventId: "event-1",
      deliveryContext: { isRedelivery: false },
      timestamp: Date.UTC(2026, 4, 31, 11, 34, 0),
      source: { type: "user", userId: "user-1" },
      mode: "active",
      replyToken: "reply-token",
      message: {
        id: "message-1",
        type: "text",
        quoteToken: "quote-token",
        text: [
          "เสือ-ตลาด72 เบิก",
          "1.หมอนทอง119บาท",
          "38โล",
          "จบรายการเบิก",
        ].join("\n"),
      },
    };

    const result = await new WeighSessionParser().parse(event);
    expect(result.data.transaction_time).toBe("18:34");
  });

  it("uses previous business date before 04:00 Bangkok when text has no date", async () => {
    const event: LineMessageEvent = {
      type: "message",
      webhookEventId: "event-before-cutoff",
      deliveryContext: { isRedelivery: false },
      timestamp: Date.UTC(2026, 5, 1, 19, 30, 0), // 2026-06-02 02:30 Bangkok
      source: { type: "user", userId: "user-1" },
      mode: "active",
      replyToken: "reply-token",
      message: {
        id: "message-before-cutoff",
        type: "text",
        quoteToken: "quote-token",
        text: [
          "กี้-ตลาด72 เบิก",
          "1.หมอนทอง119บาท",
          "10โล",
          "จบรายการเบิก",
        ].join("\n"),
      },
    };

    const result = await new WeighSessionParser().parse(event);
    expect(result.data.date).toBe("2026-06-01");
    expect(result.data.transaction_time).toBe("02:30");
  });
});

describe("RE.QUANTITY", () => {
  const cases: [string, number, string][] = [
    ["38โล",      38,   "โล"],
    ["18.5โล",    18.5, "โล"],
    ["38.1.โล",   38.1, "โล"],
    ["28.โล",     28,   "โล"],
    ["9ลูก",      9,    "ลูก"],
    ["23.ลูก",    23,   "ลูก"],
    ["6.ลูก",     6,    "ลูก"],
    ["13.กล่อง",  13,   "กล่อง"],
    ["12.กล่อง",  12,   "กล่อง"],
    ["20.แพค",    20,   "แพค"],
    ["5แพค",       5,   "แพค"],
    ["1แพ็ค",      1,    "แพ็ค"],
    ["1แพ็ก",      1,    "แพ็ก"],
    ["1เเพ็ค",     1,    "เเพ็ค"],
    ["3กำ",        3,    "กำ"],
    ["2มัด",       2,    "มัด"],
    ["5ถุง",        5,    "ถุง"],
  ];

  cases.forEach(([input, expectedAmt, expectedUnit]) => {
    it(`parses "${input}"`, () => {
      const m = input.match(RE.QUANTITY);
      expect(m).not.toBeNull();
      expect(parseFloat(m![1])).toBe(expectedAmt);
      expect(m![2]).toBe(expectedUnit);
    });
  });

  it("does not match non-quantity lines", () => {
    expect("1.หมอนทอง119บาท".match(RE.QUANTITY)).toBeNull();
    expect("รายการชั่งคืน".match(RE.QUANTITY)).toBeNull();
  });
});

describe("real sample: คืนเสีย with แพ็ค spelling", () => {
  const result = parseWeighSession(`\
20:57 เสือ กี้-วัดทุ่งลานนา คืนเสีย 1/6/2569
20:58 เสือ 1.หมอนทอง119บาท
2.4โล
20:58 เสือ 2.องุ่นแดง100บาท
1โล
20:58 เสือ 3.แก้วมังกร40บาท
1.8โล
20:58 เสือ 4.แอปเปิ้ล5บาท
1ลูก
20:58 เสือ 5.ส้มไต้หวัน45บาท
0.6โล
20:58 เสือ 6.สาลี่หอม40บาท
1.2โล
20:58 เสือ 7.ทุเรียนลูกค้าเคลม160บาท
1แพ็ค
20:58 เสือ จบรายการคืนเสีย`);

  it("parses all items as bad returns", () => {
    expect(result.items).toHaveLength(7);
    expect(result.items.every((item) => item.transaction_type === "คืนเสีย")).toBe(true);
    expect(result.items[6]).toMatchObject({
      item_number: 7,
      product_name: "ทุเรียนลูกค้าเคลม",
      price_per_unit: 160,
      quantity: 1,
      unit: "แพค",
    });
  });
});

describe("RE.ITEM", () => {
  it("matches item with dot separator", () => {
    const m = "1.หมอนทอง119บาท".match(RE.ITEM);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("1");
    expect(m![2].trim()).toBe("หมอนทอง");
    expect(m![3]).toBe("119");
  });

  it("matches item without dot separator", () => {
    const m = "2หมอนทอง119บาท".match(RE.ITEM);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("2");
    expect(m![2].trim()).toBe("หมอนทอง");
    expect(m![3]).toBe("119");
  });

  it("matches two-digit item number", () => {
    const m = "10ส้มไต้หวัน40บาท".match(RE.ITEM);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("10");
    expect(m![2].trim()).toBe("ส้มไต้หวัน");
  });

  it("matches product name containing กล่อง", () => {
    const m = "15ทุเรียนกล่อง100บาท".match(RE.ITEM);
    expect(m).not.toBeNull();
    expect(m![2].trim()).toBe("ทุเรียนกล่อง");
    expect(m![3]).toBe("100");
  });

  it("does not match weight lines", () => {
    expect("38โล".match(RE.ITEM)).toBeNull();
    expect("13.กล่อง".match(RE.ITEM)).toBeNull();
  });
});

describe("RE.DATE_ONLY", () => {
  it("matches short Buddhist year", () => {
    const m = "25/5/69".match(RE.DATE_ONLY);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("25");
    expect(m![2]).toBe("5");
    expect(m![3]).toBe("69");
  });

  it("matches full Buddhist year", () => {
    const m = "18/5/2568".match(RE.DATE_ONLY);
    expect(m).not.toBeNull();
    expect(m![3]).toBe("2568");
  });

  it("does not match item lines", () => {
    expect("1.หมอนทอง119บาท".match(RE.DATE_ONLY)).toBeNull();
  });
});
