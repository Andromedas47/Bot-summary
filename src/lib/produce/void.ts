import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;

/**
 * Void/supersede for produce_sessions (BR-03). Integrates the protected
 * 0037 produce-session void schema's intent (this branch's own
 * 0037_produce_session_void.sql — see that file's header): ACTIVE -> VOID is
 * the only transition, hard delete is forbidden, and the original row
 * remains readable via produce_transactions_all for audit while
 * produce_transactions (the operational view every financial loader reads)
 * excludes it automatically.
 *
 * Authorization is NOT checked here — callers (API routes) must call
 * requireAdminActor() first (see src/lib/auth/admin.ts) and pass its actor
 * id as actorId. This function only enforces the data-level invariants: a
 * non-empty reason, and that voiding never overwrites an already-voided
 * session's void record.
 */
export class ProduceVoidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProduceVoidError";
  }
}

export interface VoidProduceSessionInput {
  sessionId: string;
  actorId: string;
  reason: string;
  replacementSessionId?: string | null;
}

export interface VoidedProduceSession {
  sessionId: string;
  voidedAt: string;
  voidedBy: string;
  voidReason: string;
  replacementSessionId: string | null;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ProduceVoidError(`${field} must not be empty`);
  }
  return trimmed;
}

export async function voidProduceSession(
  supabase: Supabase,
  input: VoidProduceSessionInput,
): Promise<VoidedProduceSession> {
  const sessionId = requireNonEmpty(input.sessionId, "sessionId");
  const actorId = requireNonEmpty(input.actorId, "actorId");
  const reason = requireNonEmpty(input.reason, "reason");

  const { data, error } = await supabase
    .from("produce_sessions")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: actorId,
      void_reason: reason,
      ...(input.replacementSessionId ? { replacement_session_id: input.replacementSessionId } : {}),
    })
    .eq("id", sessionId)
    .is("voided_at", null)
    .select("id, voided_at, voided_by, void_reason, replacement_session_id")
    .maybeSingle();

  if (error) {
    throw new ProduceVoidError(`void failed: ${error.message}`);
  }
  if (!data) {
    throw new ProduceVoidError(
      `produce session ${sessionId} was not found, or is already voided`,
    );
  }

  return {
    sessionId: data.id,
    voidedAt: data.voided_at as string,
    voidedBy: data.voided_by as string,
    voidReason: data.void_reason as string,
    replacementSessionId: data.replacement_session_id,
  };
}
