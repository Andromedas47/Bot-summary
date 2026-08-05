/**
 * Durable purchase capture notification outbox RPC client (plan §16.3, §18).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;

export type PurchaseCaptureNotificationKind =
  | "preview_ready"
  | "posted_success"
  | "stuck_escalation";

export type PurchaseCaptureNotificationPart = {
  id: string;
  partIndex: number;
  partCount: number;
  retryKey: string;
  deliveryStatus: string;
  payloadText: string;
  claimToken?: string | null;
};

export class PurchaseCaptureNotificationIdentityConflictError extends Error {
  constructor(message = "notification_identity_conflict") {
    super(message);
    this.name = "PurchaseCaptureNotificationIdentityConflictError";
  }
}

export class PurchaseCaptureNotificationClaimError extends Error {
  constructor(message = "claim_token_mismatch") {
    super(message);
    this.name = "PurchaseCaptureNotificationClaimError";
  }
}

function mapNotificationRpcError(message: string): Error {
  if (message.includes("notification_identity_conflict")) {
    return new PurchaseCaptureNotificationIdentityConflictError();
  }
  if (message.includes("claim_token_mismatch") || message.includes("claim_expired")) {
    return new PurchaseCaptureNotificationClaimError(message);
  }
  return new Error(message);
}

function parsePart(row: Record<string, unknown>): PurchaseCaptureNotificationPart {
  return {
    id: String(row.id),
    partIndex: Number(row.part_index),
    partCount: Number(row.part_count),
    retryKey: String(row.retry_key),
    deliveryStatus: String(row.delivery_status),
    payloadText: String(row.payload_text),
    claimToken: row.claim_token == null ? null : String(row.claim_token),
  };
}

export class PurchaseCaptureNotificationService {
  constructor(private readonly supabase: Supabase) {}

  async createParts(params: {
    sessionId: string;
    notificationKind: PurchaseCaptureNotificationKind;
    notificationVersion: string;
    payloadTexts: readonly string[];
  }): Promise<PurchaseCaptureNotificationPart[]> {
    const { data, error } = await this.supabase.rpc("create_purchase_capture_notification_parts", {
      p_session_id: params.sessionId,
      p_notification_kind: params.notificationKind,
      p_notification_version: params.notificationVersion,
      p_payload_texts: [...params.payloadTexts],
    });
    if (error) throw mapNotificationRpcError(error.message ?? "");
    const rows = (data as { parts?: Record<string, unknown>[] } | null)?.parts
      ?? (Array.isArray(data) ? data : []);
    return (rows as Record<string, unknown>[]).map(parsePart);
  }

  async claimNextPart(params: {
    sessionId: string;
    notificationKind: PurchaseCaptureNotificationKind;
    notificationVersion: string;
    claimLeaseSeconds?: number;
  }): Promise<PurchaseCaptureNotificationPart | null> {
    const { data, error } = await this.supabase.rpc("claim_next_purchase_capture_notification_part", {
      p_session_id: params.sessionId,
      p_notification_kind: params.notificationKind,
      p_notification_version: params.notificationVersion,
      p_claim_lease_seconds: params.claimLeaseSeconds ?? 60,
    });
    if (error) throw mapNotificationRpcError(error.message ?? "");
    if (!data || typeof data !== "object") return null;
    const row = data as Record<string, unknown>;
    if (row.claimed !== true || row.claim_token == null) return null;
    return {
      id: String(row.id),
      partIndex: Number(row.part_index),
      partCount: Number(row.part_count),
      retryKey: String(row.retry_key),
      deliveryStatus: "sending",
      payloadText: String(row.payload_text),
      claimToken: String(row.claim_token),
    };
  }

  async recordAttempt(params: {
    notificationPartId: string;
    claimToken: string;
    error: string | null;
  }): Promise<void> {
    const { error } = await this.supabase.rpc("record_purchase_capture_notification_part_attempt", {
      p_notification_part_id: params.notificationPartId,
      p_claim_token: params.claimToken,
      p_error_or_null: params.error,
    });
    if (error) throw mapNotificationRpcError(error.message ?? "");
  }

  async markDelivered(params: {
    notificationPartId: string;
    claimToken: string;
  }): Promise<void> {
    const { error } = await this.supabase.rpc("mark_purchase_capture_notification_part_delivered", {
      p_notification_part_id: params.notificationPartId,
      p_claim_token: params.claimToken,
    });
    if (error) throw mapNotificationRpcError(error.message ?? "");
  }
}
