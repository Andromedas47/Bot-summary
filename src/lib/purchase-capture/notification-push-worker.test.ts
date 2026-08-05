import { describe, expect, test } from "bun:test";
import { deliverPurchaseCaptureNotificationParts } from "./notification-push-worker";

describe("purchase capture notification push worker", () => {
  test("delivers parts in order and stops on push failure", async () => {
    const calls: string[] = [];
    let claimCount = 0;
    const supabase = {
      rpc(name: string) {
        if (name === "claim_next_purchase_capture_notification_part") {
          if (claimCount === 0) {
            claimCount += 1;
            return Promise.resolve({
              data: {
                claimed: true,
                id: "part-0",
                claim_token: "token-0",
                retry_key: "retry-0",
                payload_text: "message-0",
              },
              error: null,
            });
          }
          if (claimCount === 1) {
            claimCount += 1;
            return Promise.resolve({
              data: {
                claimed: true,
                id: "part-1",
                claim_token: "token-1",
                retry_key: "retry-1",
                payload_text: "message-1",
              },
              error: null,
            });
          }
          return Promise.resolve({
            data: { claimed: false, reason: "nothing_eligible" },
            error: null,
          });
        }
        if (name === "mark_purchase_capture_notification_part_delivered") {
          return Promise.resolve({ data: { ok: true }, error: null });
        }
        if (name === "record_purchase_capture_notification_part_attempt") {
          return Promise.resolve({ data: { ok: true }, error: null });
        }
        throw new Error(`unexpected rpc ${name}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const push = async (_to: string, text: string, retryKey?: string) => {
      calls.push(`${text}:${retryKey ?? ""}`);
      if (text === "message-1") throw new Error("push failed");
      return { status: "delivered" as const };
    };

    const result = await deliverPurchaseCaptureNotificationParts(
      supabase,
      {
        sessionId: "session-1",
        recipientId: "recipient-1",
        notificationKind: "preview_ready",
        notificationVersion: "1",
        maxParts: 2,
      },
      push,
    );

    expect(result.deliveredParts).toBe(1);
    expect(result.failedParts).toBe(1);
    expect(result.stoppedReason).toBe("push_failed");
    expect(calls).toEqual(["message-0:retry-0", "message-1:retry-1"]);
  });
});
