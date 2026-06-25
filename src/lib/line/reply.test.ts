import { afterEach, describe, it, expect, spyOn } from "bun:test";
import {
  buildWeighSessionSummary,
  pushLineMessage,
  replyLineMessage,
} from "./reply";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";

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
    items: [],
    parse_errors: [],
    review_issues: [],
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
};

const BORROW_EXTRA_ITEM = {
  item_number: 2,
  product_name: "หมอนทอง",
  price_per_unit: 119,
  quantity: 5,
  unit: "โล" as const,
  section: "",
  transaction_type: "เบิกเพิ่ม" as const,
};

const RETURN_ITEM = {
  item_number: 1,
  product_name: "ชะนี",
  price_per_unit: 100,
  quantity: 8,
  unit: "โล" as const,
  section: "",
  transaction_type: "คืน" as const,
};

const BAD_RETURN_ITEM = {
  item_number: 1,
  product_name: "กระดุม",
  price_per_unit: 80,
  quantity: 3,
  unit: "โล" as const,
  section: "",
  transaction_type: "คืนเสีย" as const,
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
  it("does not log or throw the LINE reply response body", async () => {
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
    expect(logged).not.toContain(sensitiveBody);
    expect(logged).not.toContain("sensitive LINE detail");
    errorLog.mockRestore();
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
