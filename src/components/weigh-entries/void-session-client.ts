export type VoidSessionResult =
  | {
      ok: true;
      sessionId: string;
      voidedAt: string;
      voidedBy: string;
      voidReason: string;
      replacementSessionId: string | null;
    }
  | { ok: false; error: string };

export function requireVoidReason(reason: string): string | null {
  const trimmed = reason.normalize("NFC").trim();
  return trimmed.length > 0 ? trimmed : null;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Calls the existing admin void API. No Supabase writes from the browser.
 */
export async function postVoidProduceSession(
  input: { sessionId: string; reason: string },
  fetchImpl: FetchLike = fetch,
): Promise<VoidSessionResult> {
  const reason = requireVoidReason(input.reason);
  if (!reason) {
    return { ok: false, error: "ต้องระบุเหตุผลการยกเลิก" };
  }
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return { ok: false, error: "ไม่พบรหัสเซสชัน" };
  }

  try {
    const res = await fetchImpl("/api/admin/void-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, reason }),
    });
    const json = (await res.json()) as {
      error?: string;
      sessionId?: string;
      voidedAt?: string;
      voidedBy?: string;
      voidReason?: string;
      replacementSessionId?: string | null;
    };
    if (!res.ok) {
      return { ok: false, error: json.error ?? "void failed" };
    }
    if (!json.sessionId || !json.voidedAt || !json.voidedBy || !json.voidReason) {
      return { ok: false, error: "void response incomplete" };
    }
    return {
      ok: true,
      sessionId: json.sessionId,
      voidedAt: json.voidedAt,
      voidedBy: json.voidedBy,
      voidReason: json.voidReason,
      replacementSessionId: json.replacementSessionId ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "void failed",
    };
  }
}
