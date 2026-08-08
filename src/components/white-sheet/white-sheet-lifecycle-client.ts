export type WhiteSheetLifecycleScope = {
  sourceId: string;
  market: string;
  date: string;
  accountabilityRoundId?: string | null;
};

export type WhiteSheetLifecycleResult =
  | { ok: true }
  | { ok: false; error: string };

export function requireReopenReason(reason: string): string | null {
  const trimmed = reason.normalize("NFC").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Calls the existing admin-gated finalize/reopen API routes. Does not touch
 * Supabase from the browser — lifecycle RPCs stay server-side.
 */
type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function postWhiteSheetLifecycle(
  action: "finalize" | "reopen",
  scope: WhiteSheetLifecycleScope,
  options: { reason?: string; fetchImpl?: FetchLike } = {},
): Promise<WhiteSheetLifecycleResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const path =
    action === "finalize" ? "/api/white-sheet/finalize" : "/api/white-sheet/reopen";

  let body: Record<string, string | null>;
  if (action === "finalize") {
    body = {
      sourceId: scope.sourceId,
      market: scope.market,
      date: scope.date,
      ...(scope.accountabilityRoundId !== undefined
        ? { accountabilityRoundId: scope.accountabilityRoundId }
        : {}),
    };
  } else {
    const reason = requireReopenReason(options.reason ?? "");
    if (!reason) {
      return { ok: false, error: "ต้องระบุเหตุผลในการเปิดยอดอีกครั้ง" };
    }
    body = {
      sourceId: scope.sourceId,
      market: scope.market,
      date: scope.date,
      reason,
      ...(scope.accountabilityRoundId !== undefined
        ? { accountabilityRoundId: scope.accountabilityRoundId }
        : {}),
    };
  }

  try {
    const res = await fetchImpl(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: string };
    if (!res.ok) {
      return { ok: false, error: json.error ?? `${action} failed` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `${action} failed`,
    };
  }
}
