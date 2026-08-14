import { describe, expect, test } from "bun:test";
import { classifyProduceFailures, type ProduceFailureAttempt } from "./failure-lifecycle";
import { buildDailyClosePreflight } from "./daily-close-preflight";
import type { RoundReturnStatus } from "./round-return-status";
import {
  buildPreflightBlocks,
  PREFLIGHT_BLOCKED,
  PREFLIGHT_READY,
  PREFLIGHT_READY_WITH_WARNINGS,
} from "./preflight-message";
import { parsePreflightCommand, parsePreflightCommandFromMessage } from "./preflight-command";

const DATE = "2026-08-13";

function round(overrides: Partial<RoundReturnStatus> = {}): RoundReturnStatus {
  return {
    accountabilityRoundId: "round-1",
    sellerLabel: "วุฒิ",
    marketLabel: "เลียบด่วน",
    withdrawalItemCount: 4,
    hasPersistedReturn: true,
    state: "persisted",
    ...overrides,
  };
}

describe("preflight message", () => {
  test("a ready day says so and lists no market", () => {
    const blocks = buildPreflightBlocks(
      buildDailyClosePreflight({
        businessDate: DATE,
        roundStatuses: [round(), round({ accountabilityRoundId: "r2", marketLabel: "ตลาด72" })],
        failureAttempts: [],
        failureClassifications: [],
        priceReview: [],
        openRounds: [],
        unboundProduce: [],
      }),
    );

    expect(blocks[0]).toContain("✅ พร้อมปิด 2 ตลาด");
    expect(blocks.at(-1)).toBe(PREFLIGHT_READY);
    expect(blocks.join("\n")).not.toContain("⛔");
  });

  test("a blocked market is named with its cause and no UUID", () => {
    const attempts: ProduceFailureAttempt[] = [
      {
        attemptId: "6f1b0b4e-0000-4000-8000-000000000000",
        origin: "pending_session",
        businessDate: DATE,
        sourceId: "group:C1",
        staffLabel: "จิ๋ว",
        marketLabel: "ราชพฤกษ์",
        transactionKind: "คืน",
        accountabilityRoundId: "round-2",
        attemptedAtMs: 1_000,
      },
    ];

    const blocks = buildPreflightBlocks(
      buildDailyClosePreflight({
        businessDate: DATE,
        roundStatuses: [
          round(),
          round({
            accountabilityRoundId: "round-2",
            sellerLabel: "จิ๋ว",
            marketLabel: "ราชพฤกษ์",
            hasPersistedReturn: false,
            state: "blocked",
          }),
        ],
        failureAttempts: attempts,
        failureClassifications: classifyProduceFailures(attempts, []),
        priceReview: [],
        openRounds: [],
        unboundProduce: [],
      }),
    );

    const text = blocks.join("\n");
    expect(text).toContain("⛔ ต้องตรวจ 1 ตลาด");
    expect(text).toContain("ราชพฤกษ์ — จิ๋ว");
    expect(text).toContain("พบการส่งชั่งคืน แต่ยังบันทึกไม่สำเร็จ");
    expect(text).not.toContain("6f1b0b4e");
    expect(blocks.at(-1)).toBe(PREFLIGHT_BLOCKED);
  });

  test("price conflicts name product, unit and every candidate price", () => {
    const blocks = buildPreflightBlocks(
      buildDailyClosePreflight({
        businessDate: DATE,
        roundStatuses: [round()],
        failureAttempts: [],
        failureClassifications: [],
        priceReview: [
          {
            productKey: "อะโวคาโด",
            productDisplayName: "อะโวคาโด",
            unitKey: "โล",
            businessDate: DATE,
            status: "unresolved",
            candidates: [
              { priceSatang: 5_000, occurrenceCount: 6, affectedMarkets: ["ตลาด72"] },
              { priceSatang: 7_000, occurrenceCount: 1, affectedMarkets: ["เลียบด่วน"] },
            ],
            approvedPriceSatang: 5_000,
            approvedBy: "system:first-withdrawal",
          },
        ],
        openRounds: [],
        unboundProduce: [],
      }),
    );

    const text = blocks.join("\n");
    expect(text).toContain("⚠️ ราคากลางต้องยืนยัน 1 สินค้า");
    expect(text).toContain("อะโวคาโด (โล) — พบ 50 / 70 บาท");
    expect(blocks.at(-1)).toBe(PREFLIGHT_BLOCKED);
  });

  test("a superseded failure is a reassurance line, not a problem", () => {
    const attempts: ProduceFailureAttempt[] = [
      {
        attemptId: "a1",
        origin: "raw_message",
        businessDate: DATE,
        sourceId: "group:C1",
        staffLabel: "เมย์",
        marketLabel: "ทรัพย์พัน",
        transactionKind: "คืน",
        accountabilityRoundId: null,
        attemptedAtMs: 1_000,
      },
    ];

    const blocks = buildPreflightBlocks(
      buildDailyClosePreflight({
        businessDate: DATE,
        roundStatuses: [round()],
        failureAttempts: attempts,
        failureClassifications: classifyProduceFailures(attempts, [
          {
            produceSessionId: "ok",
            businessDate: DATE,
            sourceId: "group:C1",
            staffLabel: "เมย์",
            marketLabel: "ทรัพย์พัน",
            transactionKind: "คืน",
            accountabilityRoundId: null,
            sessionKind: "main",
            finalizedAtMs: 9_000,
          },
        ]),
        priceReview: [],
        openRounds: [],
        unboundProduce: [],
      }),
    );

    expect(blocks.join("\n")).toContain("แก้ไขและส่งใหม่สำเร็จแล้ว 1 ชุด");
    expect(blocks.at(-1)).toBe(PREFLIGHT_READY_WITH_WARNINGS);
  });
});

describe("preflight command", () => {
  test("accepts the bare command", () => {
    expect(parsePreflightCommand("ตรวจความพร้อม")).toEqual({ businessDate: null });
  });

  test("accepts a Buddhist-era date", () => {
    expect(parsePreflightCommand("ตรวจความพร้อม 13/8/2569")).toEqual({
      businessDate: "2026-08-13",
    });
  });

  test("accepts a Gregorian date", () => {
    expect(parsePreflightCommand("ตรวจความพร้อม 13/08/2026")).toEqual({
      businessDate: "2026-08-13",
    });
  });

  test("refuses a date that does not exist rather than answering for another day", () => {
    expect(parsePreflightCommand("ตรวจความพร้อม 31/02/2569")).toBeNull();
  });

  test("is not confused by other commands", () => {
    expect(parsePreflightCommand("สรุปยอดขาย")).toBeNull();
    expect(parsePreflightCommand("ตรวจความพร้อมมาก")).toBeNull();
  });

  test("strips LINE export prefixes", () => {
    expect(parsePreflightCommandFromMessage("08:12 พี่ไก่ ตรวจความพร้อม 13/8/2569")).toEqual({
      businessDate: "2026-08-13",
    });
  });
});
