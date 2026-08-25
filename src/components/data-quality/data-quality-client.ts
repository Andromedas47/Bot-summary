export type DataQualityActionResult =
  | { ok: true; status: "RESOLVED" | "IGNORED" }
  | { ok: false; error: string };

/** A note is required for both actions — an audit trail with no "why" is not one. */
export function requireResolutionNote(note: string): string | null {
  const trimmed = note.normalize("NFC").trim();
  return trimmed.length > 0 ? trimmed : null;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function postAction(
  path: string,
  input: { issueKey: string; note: string },
  fetchImpl: FetchLike,
  expectedStatus: "RESOLVED" | "IGNORED",
): Promise<DataQualityActionResult> {
  const note = requireResolutionNote(input.note);
  if (!note) {
    return { ok: false, error: "ต้องระบุเหตุผล" };
  }
  const issueKey = input.issueKey.trim();
  if (!issueKey) {
    return { ok: false, error: "ไม่พบรหัสรายการ" };
  }

  try {
    const res = await fetchImpl(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueKey, note }),
    });
    const json = (await res.json()) as { error?: string };
    if (!res.ok) {
      return { ok: false, error: json.error ?? "การดำเนินการล้มเหลว" };
    }
    return { ok: true, status: expectedStatus };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "การดำเนินการล้มเหลว" };
  }
}

export async function postResolveDataQualityIssue(
  input: { issueKey: string; note: string },
  fetchImpl: FetchLike = fetch,
): Promise<DataQualityActionResult> {
  return postAction("/api/admin/data-quality/resolve", input, fetchImpl, "RESOLVED");
}

export async function postIgnoreDataQualityIssue(
  input: { issueKey: string; note: string },
  fetchImpl: FetchLike = fetch,
): Promise<DataQualityActionResult> {
  return postAction("/api/admin/data-quality/ignore", input, fetchImpl, "IGNORED");
}
