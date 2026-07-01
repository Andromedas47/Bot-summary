import { createHmac } from "crypto";

/**
 * Verifies the X-Line-Signature header from LINE's webhook.
 * Uses HMAC-SHA256 of the raw request body with the channel secret.
 */
export function verifyLineSignature(
  body: string,
  signature: string,
  channelSecret: string
): boolean {
  const hash = createHmac("sha256", channelSecret)
    .update(body)
    .digest("base64");
  return hash === signature;
}

export function getSourceId(source: {
  type: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}): string {
  if (source.type === "group" && source.groupId) return source.groupId;
  if (source.type === "room" && source.roomId) return source.roomId;
  if (source.userId) return source.userId;
  return "unknown";
}

export function getUserId(source: {
  type: string;
  userId?: string;
}): string | null {
  return source.userId ?? null;
}

/**
 * Builds the composite identity key used for pending-session accumulation.
 *
 * Group/room sources are shared by every member — keying on the bare LINE
 * source id alone lets two different senders' messages collide on the same
 * row and interleave. Composing with the sender's userId gives each sender
 * an independent row:
 *   group:{groupId}:user:{userId}
 *   room:{roomId}:user:{userId}
 *   dm:{userId}
 *
 * This composite value is ONLY for pending-session identity — it is never a
 * valid LINE destination. Returns null when a group/room event has no userId
 * (LINE omits it for some senders); callers must reject such events for the
 * pending-session flow rather than fall back to a shared/partial key.
 */
export function getPendingSessionKey(source: {
  type: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}): string | null {
  if (source.type === "group") {
    return source.groupId && source.userId
      ? `group:${source.groupId}:user:${source.userId}`
      : null;
  }
  if (source.type === "room") {
    return source.roomId && source.userId
      ? `room:${source.roomId}:user:${source.userId}`
      : null;
  }
  return source.userId ? `dm:${source.userId}` : null;
}
