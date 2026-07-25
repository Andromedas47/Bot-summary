import { createHash } from "node:crypto";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { pushLineMessage, type PushResult } from "@/lib/line/reply";
import { buildRemainingFruitMessages } from "@/lib/summary/remaining-fruit-message";
import type { StockSummary } from "@/lib/summary/remaining-fruit";

export type StockPush = (
  targetId: string,
  text: string,
  retryKey: string,
) => Promise<PushResult>;

export interface StockDeliveryFailure {
  targetId: string;
  messageIndex: number;
  error: string;
}

export interface StockDeliveryResult {
  attemptedCount: number;
  acceptedCount: number;
  failures: StockDeliveryFailure[];
}

export function resolveDailyStockDate(dateParam: string | null, timestamp = Date.now()): string {
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return dateParam;
  return bangkokBusinessDateFromTimestamp(timestamp)
    ?? new Date(timestamp).toISOString().slice(0, 10);
}

export function parseDailyStockTargetIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(
    raw
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter((value) => value && value !== "unknown"),
  )];
}

export function dailyStockRetryKey(
  businessDate: string,
  targetId: string,
  messageIndex: number,
): string {
  const bytes = createHash("sha256")
    .update(`daily-stock:${businessDate}:${targetId}:${messageIndex}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function prepareAutomaticStockReport(
  businessDate: string,
  summary: StockSummary,
): { summary: StockSummary; messages: string[] } {
  return {
    summary,
    messages: buildRemainingFruitMessages(businessDate, summary, {
      includeOverall: true,
      includeDetails: false,
    }),
  };
}

export async function deliverDailyStockMessages(
  businessDate: string,
  targetIds: readonly string[],
  messages: readonly string[],
  push: StockPush = pushLineMessage,
): Promise<StockDeliveryResult> {
  const failures: StockDeliveryFailure[] = [];
  let acceptedCount = 0;
  let attemptedCount = 0;

  for (const targetId of targetIds) {
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      attemptedCount += 1;
      try {
        await push(
          targetId,
          messages[messageIndex],
          dailyStockRetryKey(businessDate, targetId, messageIndex),
        );
        acceptedCount += 1;
      } catch (error) {
        failures.push({
          targetId,
          messageIndex,
          error: error instanceof Error ? error.message : String(error),
        });
        // Keep message order safe for this target. Other targets are still isolated.
        break;
      }
    }
  }

  return {
    attemptedCount,
    acceptedCount,
    failures,
  };
}
