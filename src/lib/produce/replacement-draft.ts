/**
 * Finalized Produce replacement / void lineage — operator UX (Task 2).
 *
 * The narrowest explicit flow the contract allows: no magic one-message
 * correction, no fuzzy "latest session" guessing.
 *
 *   1. Operator opens a NORMAL header (unchanged — this module never touches
 *      that path). A fresh, still-empty pending session now exists.
 *   2. Operator sends the exact trigger phrase below, alone, on its own
 *      message — mirroring how `ยกเลิกรายการ` / `กู้รายการล่าสุด` already work
 *      (see pending-produce-recovery.ts): both require an existing `pending`
 *      row, never infer one.
 *   3. This module resolves the EXACT finalized predecessor by exact business
 *      identity (date + staff + market + base transaction type), using
 *      produce_transactions — the same voided_at-filtered view every report
 *      already reads, so a superseded predecessor can never be picked again
 *      and a session split across multiple base transaction types (a session
 *      this narrow flow does not support) never matches at all. Zero or more
 *      than one candidate refuses outright.
 *   4. The predecessor's effective items are rendered back into the SAME
 *      item-line grammar the parser already accepts and appended to the
 *      draft exactly as if the operator had retyped them (PendingSessionService.append,
 *      the same primitive กู้รายการล่าสุด uses to replay recovered lines).
 *   5. The operator now corrects with the EXISTING แก้ข้อ N / ลบข้อ N grammar
 *      (PR #81) and closes normally. Nothing downstream of that point is new:
 *      the ordinary finalizer runs, and try_finalize_pending_generation (see
 *      20260825090000) atomically supersedes the predecessor if and only if
 *      the replacement itself finalizes successfully.
 *
 * ponytail: scoped to single-base-type sessions (a session is either all
 * เบิก, all คืน, or all คืนเสีย). A finalized session that mixes sections
 * under one document (เช่น ชั่งคืนและคืนเสีย ในเอกสารเดียว) is invisible to
 * findReplacementCandidate — it can never appear as a false partial match,
 * and the operator is refused with "none" rather than seeing a silently
 * incomplete seed. Upgrade path: extend the seed builder to emit the
 * appropriate section header lines and lift this module's grouping to allow
 * multiple base types per candidate, the day a real mixed-section correction
 * is needed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { PendingSession } from "@/lib/line/pending-session-service";
import { PendingSessionService } from "@/lib/line/pending-session-service";
import { headerProvenance, type HeaderProvenance } from "@/lib/line/pending-produce-recovery";

type Supabase = SupabaseClient<Database>;

export const REPLACE_FINALIZED_SESSION_COMMAND = "แก้ไขรายการที่ปิดแล้ว";

export function isExactReplaceFinalizedSessionCommand(text: string): boolean {
  return text.trim() === REPLACE_FINALIZED_SESSION_COMMAND;
}

/** Only a still-empty, still-open plain-text draft may start a replacement. */
export function canStartReplacementFrom(session: PendingSession | null): boolean {
  return Boolean(
    session
    && session.entry_origin == null
    && !session.terminalized
    && session.close_event_timestamp_ms == null
    && session.replaces_produce_session_id == null,
  );
}

export interface ReplacementCandidateItemRow {
  session_id:         string;
  item_number:        number;
  product_name:       string;
  price_per_unit:     number | null;
  quantity:           number | null;
  unit:               string | null;
  section:            string | null;
  transaction_type:   string;
  basis_quantity:     number | null;
  basis_unit:         string | null;
  basis_price:        number | null;
  pricing_mode:       string | null;
}

export type CandidateSelection =
  | { kind: "none" }
  | { kind: "ambiguous"; count: number }
  | { kind: "found"; sessionId: string; items: ReplacementCandidateItemRow[] };

/**
 * Exact identification, never a guess. Groups produce_transactions rows (the
 * voided_at-filtered view — a superseded predecessor is structurally absent)
 * by session_id, then keeps only sessions whose ENTIRE item set matches the
 * requested base transaction type. A session that mixes types can therefore
 * never be a partial false match — it simply cannot appear.
 */
export async function findReplacementCandidate(
  supabase: Supabase,
  header: HeaderProvenance,
): Promise<CandidateSelection> {
  if (!header.type || !header.staff || !header.date) return { kind: "none" };

  const { data, error } = await supabase
    .from("produce_transactions")
    .select(
      "session_id, item_number, product_name, price_per_unit, quantity, unit, section, transaction_type, basis_quantity, basis_unit, basis_price, pricing_mode, base_transaction_type",
    )
    .eq("transaction_date", header.date)
    .eq("staff_name", header.staff)
    .eq("market_name", header.market ?? "");

  if (error) throw new Error(`replacement candidate lookup failed: ${error.message}`);

  const rows = (data ?? []) as Array<ReplacementCandidateItemRow & { base_transaction_type: string | null }>;
  const bySession = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = bySession.get(row.session_id);
    if (bucket) bucket.push(row);
    else bySession.set(row.session_id, [row]);
  }

  const matching = [...bySession.entries()].filter(([, sessionRows]) =>
    sessionRows.length > 0
    && sessionRows.every((row) => row.base_transaction_type === header.type));

  if (matching.length === 0) return { kind: "none" };
  if (matching.length > 1) return { kind: "ambiguous", count: matching.length };

  const [sessionId, items] = matching[0]!;
  return {
    kind: "found",
    sessionId,
    items: [...items].sort((a, b) => a.item_number - b.item_number),
  };
}

/**
 * Renders one persisted row back into the plain-text item-line grammar
 * parseWeighSession already accepts (see RE.ITEM / RE.ITEM_WITH_BASIS and
 * parser-correction.test.ts's own `item()` helper, which this mirrors).
 */
export function renderReplacementItemLines(row: ReplacementCandidateItemRow): string[] {
  if (
    row.pricing_mode === "basis"
    && row.basis_quantity != null
    && row.basis_unit
    && row.basis_price != null
  ) {
    return [
      `${row.item_number}. ${row.product_name} ${row.basis_quantity} ${row.basis_unit} ${row.basis_price} บาท`,
    ];
  }
  return [
    `${row.item_number}. ${row.product_name} ${row.price_per_unit ?? 0} บาท`,
    `${row.quantity ?? 0} ${row.unit ?? ""}`,
  ];
}

export function buildReplacementSeedText(items: ReplacementCandidateItemRow[]): string {
  return items.flatMap(renderReplacementItemLines).join("\n");
}

export type StartReplacementResult =
  | { status: "no_header" }
  | { status: "already_replacing" }
  | { status: "none" }
  | { status: "ambiguous"; count: number }
  | { status: "stamp_refused"; reason: string }
  | { status: "started"; session: PendingSession; predecessorSessionId: string; itemCount: number };

function syntheticSeedEventId(predecessorSessionId: string, sessionGeneration: string): string {
  return `replacement-seed:${predecessorSessionId}:${sessionGeneration}`;
}

/**
 * Orchestrates steps 3–4 above. Idempotent end to end under webhook/operator
 * retry: candidate resolution is a pure read, stamping is a no-op on a
 * repeat of the SAME target, and the seed append reuses the deterministic
 * synthetic event id so append_pending_session's own duplicate_event path
 * absorbs a replay without re-appending the lines twice.
 */
export async function startFinalizedSessionReplacementDraft(
  supabase: Supabase,
  service: PendingSessionService,
  session: PendingSession | null,
  lineTimestampMs: number,
): Promise<StartReplacementResult> {
  if (!canStartReplacementFrom(session)) {
    if (session?.replaces_produce_session_id) return { status: "already_replacing" };
    return { status: "no_header" };
  }
  const s = session!;

  const header = headerProvenance(s.accumulated_text);
  const selection = await findReplacementCandidate(supabase, header);
  if (selection.kind === "none") return { status: "none" };
  if (selection.kind === "ambiguous") return { status: "ambiguous", count: selection.count };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stampData, error: stampError } = await (supabase as any).rpc(
    "stamp_pending_session_replacement_target",
    {
      p_session_key:        s.session_key,
      p_session_generation: s.session_generation,
      p_produce_session_id: selection.sessionId,
    },
  );
  if (stampError) throw new Error(`replacement stamp failed: ${stampError.message}`);
  const stamped = stampData as { stamped: boolean; reason: string } | null;
  if (!stamped?.stamped) {
    return { status: "stamp_refused", reason: stamped?.reason ?? "unknown" };
  }

  const seedText = buildReplacementSeedText(selection.items);
  const updated = await service.append(
    s.session_key,
    seedText,
    null,
    syntheticSeedEventId(selection.sessionId, s.session_generation),
    lineTimestampMs,
    false,
    s.session_generation,
  );

  return {
    status: "started",
    session: updated,
    predecessorSessionId: selection.sessionId,
    itemCount: selection.items.length,
  };
}

export function replacementDraftCommandReply(result: StartReplacementResult): string {
  if (result.status === "started") {
    return [
      "✏️ เริ่มแก้รายการที่ปิดแล้ว",
      `นำ ${result.itemCount} รายการเดิมมาลงในหัวนี้แล้ว`,
      "",
      `แก้ไขด้วย “แก้ข้อ N” หรือ “ลบข้อ N” ตามปกติ`,
      "แล้วปิดรายการตามประเภทนี้เมื่อครบถ้วน",
    ].join("\n");
  }
  if (result.status === "already_replacing") {
    return [
      "⛔ หัวรายการนี้กำลังแก้รายการที่ปิดแล้วอยู่",
      "ไม่ต้องส่งคำสั่งนี้ซ้ำ",
    ].join("\n");
  }
  if (result.status === "none") {
    return [
      "⛔ ยังแก้รายการที่ปิดแล้วไม่ได้",
      "ไม่พบรายการที่ปิดแล้วซึ่งตรงกับ วันที่/พนักงาน/ตลาด/ประเภท ในหัวนี้พอดี",
      "ตรวจสอบหัวรายการให้ตรงกับรายการเดิมทุกช่อง แล้วลองใหม่",
    ].join("\n");
  }
  if (result.status === "ambiguous") {
    return [
      "⛔ ยังแก้รายการที่ปิดแล้วไม่ได้",
      `พบ ${result.count} รายการที่ตรงกับหัวนี้ จึงไม่เลือกให้อัตโนมัติ`,
      "กรุณาแจ้งผู้ดูแลให้ระบุรายการที่ต้องการแก้ให้ชัดเจน",
    ].join("\n");
  }
  if (result.status === "stamp_refused") {
    if (result.reason === "target_not_replaceable") {
      return [
        "⛔ ยังแก้รายการที่ปิดแล้วไม่ได้",
        "รายการเดิมถูกแก้ไปแล้วโดยรายการอื่น",
      ].join("\n");
    }
    return [
      "⛔ ยังแก้รายการที่ปิดแล้วไม่ได้",
      "หัวรายการนี้ใช้เริ่มแก้รายการที่ปิดแล้วไม่ได้ในตอนนี้",
    ].join("\n");
  }
  return [
    "⛔ ยังแก้รายการที่ปิดแล้วไม่ได้",
    "ยังไม่มีหัวรายการที่เปิดอยู่",
    "กรุณาเปิดหัวรายการให้ตรงกับรายการเดิมก่อน แล้วส่ง " + `“${REPLACE_FINALIZED_SESSION_COMMAND}”`,
  ].join("\n");
}
