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
