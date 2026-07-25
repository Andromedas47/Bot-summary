import { describe, expect, test } from "bun:test";
import {
  dailyStockRetryKey,
  deliverDailyStockMessages,
  parseDailyStockTargetIds,
  resolveDailyStockDate,
} from "@/lib/line/daily-stock-delivery";

describe("daily stock scheduled delivery", () => {
  test("Bangkok 04:00 business-date boundary is preserved", () => {
    const beforeCutoff = Date.UTC(2026, 6, 24, 20, 59); // 25 Jul 03:59 Bangkok
    const atCutoff = Date.UTC(2026, 6, 24, 21, 0); // 25 Jul 04:00 Bangkok

    expect(resolveDailyStockDate(null, beforeCutoff)).toBe("2026-07-24");
    expect(resolveDailyStockDate(null, atCutoff)).toBe("2026-07-25");
  });

  test("target configuration is explicit, trimmed, and deduplicated", () => {
    expect(parseDailyStockTargetIds(" group-a,group-b\ngroup-a,unknown ")).toEqual([
      "group-a",
      "group-b",
    ]);
    expect(parseDailyStockTargetIds(undefined)).toEqual([]);
  });

  test("scheduled retries reuse deterministic per-target, per-message keys", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const pushInto = (bucket: string[]) => async (
      _targetId: string,
      _text: string,
      retryKey: string,
    ) => {
      bucket.push(retryKey);
      return { status: "delivered" as const };
    };

    await deliverDailyStockMessages(
      "2026-07-25",
      ["group-a", "group-b"],
      ["part 1", "part 2"],
      pushInto(first),
    );
    await deliverDailyStockMessages(
      "2026-07-25",
      ["group-a", "group-b"],
      ["part 1", "part 2"],
      pushInto(second),
    );

    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(4);
    expect(first[0]).toBe(dailyStockRetryKey("2026-07-25", "group-a", 0));
  });

  test("one failed push is isolated and reported without blocking other targets", async () => {
    const result = await deliverDailyStockMessages(
      "2026-07-25",
      ["group-a", "group-b"],
      ["summary"],
      async (targetId) => {
        if (targetId === "group-a") throw new Error("LINE unavailable");
        return { status: "delivered" };
      },
    );

    expect(result).toEqual({
      attemptedCount: 2,
      acceptedCount: 1,
      failures: [{
        targetId: "group-a",
        messageIndex: 0,
        error: "LINE unavailable",
      }],
    });
  });
});
