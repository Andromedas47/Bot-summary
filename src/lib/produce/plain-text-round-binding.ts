/**
 * P4A completion — give a plain-text produce session a P2E accountability round.
 *
 * The guided menu gets its round from a typed open command. Plain text has no
 * such command: the seller, market and business date only exist once the
 * accumulated document is parsed. So the binding happens at the two places that
 * already hold a parsed `WeighSession` — the close message and the deferred
 * finalizer — and is idempotent so calling it at both costs nothing.
 *
 * Nothing here decides identity. `bind_plain_text_accountability_round` owns
 * the create/resolve contract; this module supplies the parsed attributes and
 * turns the RPC's outcome into an operator-facing refusal.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { baseTransactionType } from "@/lib/summary/transactions";
import { normalizedMarketLabel } from "@/lib/market";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/**
 * Business dates from this day on must resolve a round or fail closed.
 *
 * Before it, a return whose withdrawal was entered by the previous release has
 * no round to find, and refusing it would make a real return permanently
 * un-recordable. Round creation is not gated — a withdrawal always mints its
 * round, so the first enforced day already has masters to validate against.
 */
export const PLAIN_TEXT_ROUND_ENFORCEMENT_FROM = "2026-08-11";

export type PlainTextRoundBinding =
  | {
      status: "bound";
      accountabilityRoundId: string;
      /** The ROUND's own market label — canonical for everything downstream. */
      marketLabel: string | null;
    }
  /** Legacy-compatible: no round, so only P4A's unit-vocabulary tier applies. */
  | { status: "unbound" }
  | { status: "refused"; reason: PlainTextRoundRefusal; detail: string };

export type PlainTextRoundRefusal =
  | "no_round"
  | "market_mismatch"
  | "ambiguous"
  | "not_found"
  | "identity_mismatch"
  | "bind_failed";

/** The pending generation being bound. Never a descriptive tuple. */
export interface PlainTextRoundSessionRef {
  sessionKey: string;
  sessionGeneration: string;
  sourceId: string;
  lineUserId: string | null;
}

const NO_ROUND_REPLY = [
  "⛔ ไม่พบรอบเบิกของรายการนี้",
  "ระบบยังไม่ได้บันทึกอะไร",
  "กรุณาบันทึกรายการเบิกของรอบนี้ก่อน แล้วส่งรายการนี้ใหม่",
].join("\n");

/**
 * The round exists — under another market.
 *
 * Production 2026-08-10 turned this state into silent data corruption: the
 * return was filed into the withdrawal's round while carrying its own market
 * label, and the next morning's report showed that market with เบิก 0. Naming
 * the round's market is what an operator can act on; "no withdrawal found"
 * sends them to re-enter a withdrawal that already exists.
 */
function marketMismatchReply(roundMarketLabel: string | null, sentMarketLabel: string): string {
  return [
    "⛔ ตลาดไม่ตรงกับรอบเบิกที่เปิดอยู่",
    roundMarketLabel
      ? `รอบนี้เปิดไว้ที่ตลาด "${roundMarketLabel}" แต่รายการนี้ระบุ "${sentMarketLabel}"`
      : `รายการนี้ระบุตลาด "${sentMarketLabel}" ซึ่งไม่ตรงกับรอบที่เปิดอยู่`,
    "ระบบยังไม่ได้บันทึกอะไร",
    "กรุณาแก้ชื่อตลาดให้ตรงกับรอบเบิก แล้วส่งใหม่",
  ].join("\n");
}

const AMBIGUOUS_REPLY = [
  "⛔ มีรอบที่เปิดค้างอยู่มากกว่า 1 รอบ ของคนขาย/ตลาด/วันที่เดียวกัน",
  "ระบบไม่เดาว่ารายการนี้เป็นของรอบไหน จึงยังไม่บันทึก",
  "กรุณาให้ผู้ดูแลปิดรอบที่ไม่ได้ใช้ก่อน แล้วส่งรายการนี้ใหม่",
].join("\n");

const BIND_FAILED_REPLY = [
  "⛔ ระบบผูกรายการนี้กับรอบไม่สำเร็จ จึงยังไม่บันทึก",
  "กรุณาส่งรายการนี้ใหม่อีกครั้ง",
].join("\n");

/**
 * True when this document is a new economic cycle rather than a continuation.
 *
 * A main session carrying at least one เบิก item brings its own withdrawal
 * master, so it opens a round. Everything else — a return, a damaged return, an
 * additional batch of any type — continues one that already exists and must
 * never create.
 */
export function isNewRoundDocument(parsed: WeighSession): boolean {
  if (parsed.session_kind !== "main") return false;
  return parsed.items.some(
    (item) => baseTransactionType(item.transaction_type) === "เบิก",
  );
}

/** "group:<id>:user:<id>" / "room:…" / "dm:<id>" — the shape produceSessionKey mints. */
export function sourceTypeFromSessionKey(
  sessionKey: string,
): "user" | "group" | "room" | null {
  if (sessionKey.startsWith("group:")) return "group";
  if (sessionKey.startsWith("room:")) return "room";
  if (sessionKey.startsWith("dm:")) return "user";
  return null;
}

/**
 * Bind the generation, or explain why it cannot be bound.
 *
 * A document the round contract cannot describe — no date, no market, no
 * sender — is left `unbound` rather than refused: those are parse-level
 * failures with their own operator message, and reporting them as a round
 * problem would be misleading.
 */
export async function bindPlainTextRound(
  supabase: AnyClient,
  ref: PlainTextRoundSessionRef,
  parsed: WeighSession,
): Promise<PlainTextRoundBinding> {
  const sourceType = sourceTypeFromSessionKey(ref.sessionKey);
  const market = normalizedMarketLabel(parsed.session_title);
  if (
    !sourceType
    || !ref.lineUserId
    || !parsed.date
    || !parsed.staff_name.trim()
    || !market
  ) {
    return { status: "unbound" };
  }

  let data: unknown;
  try {
    const response = await supabase.rpc("bind_plain_text_accountability_round", {
      p_session_key: ref.sessionKey,
      p_session_generation: ref.sessionGeneration,
      p_source_type: sourceType,
      p_source_id: ref.sourceId,
      p_line_user_id: ref.lineUserId,
      p_business_date: parsed.date,
      p_seller_label: parsed.staff_name,
      p_market_label: parsed.session_title,
      p_market_label_normalized: market,
      p_is_new_round: isNewRoundDocument(parsed),
    });
    if (response.error) {
      return { status: "refused", reason: "bind_failed", detail: BIND_FAILED_REPLY };
    }
    data = response.data;
  } catch {
    return { status: "refused", reason: "bind_failed", detail: BIND_FAILED_REPLY };
  }

  const result = (data ?? {}) as {
    outcome?: string;
    accountability_round_id?: string | null;
    market_label?: string | null;
  };

  switch (result.outcome) {
    case "bound":
    case "already_bound":
      return result.accountability_round_id
        ? {
            status: "bound",
            accountabilityRoundId: result.accountability_round_id,
            marketLabel: result.market_label ?? null,
          }
        : { status: "refused", reason: "bind_failed", detail: BIND_FAILED_REPLY };
    case "market_mismatch":
      // Always fail closed, on every business date. Unlike `no_round` there is
      // no legacy reading of this state: a round WAS found for this seller and
      // day, so the pre-cutover "the withdrawal predates the release" excuse
      // cannot apply, and persisting under a second market label is the exact
      // corruption this refusal exists to prevent.
      return {
        status: "refused",
        reason: "market_mismatch",
        detail: marketMismatchReply(result.market_label ?? null, market),
      };
    case "no_round":
      // Before the cutover the withdrawal side of this round predates the
      // release, so there is genuinely nothing to find and legacy behaviour is
      // the honest answer. From the cutover on, a return with no withdrawal is
      // exactly what P4A exists to stop.
      return parsed.date >= PLAIN_TEXT_ROUND_ENFORCEMENT_FROM
        ? { status: "refused", reason: "no_round", detail: NO_ROUND_REPLY }
        : { status: "unbound" };
    case "ambiguous":
      return { status: "refused", reason: "ambiguous", detail: AMBIGUOUS_REPLY };
    case "not_found":
      return { status: "refused", reason: "not_found", detail: BIND_FAILED_REPLY };
    case "identity_mismatch":
      return { status: "refused", reason: "identity_mismatch", detail: BIND_FAILED_REPLY };
    default:
      return { status: "refused", reason: "bind_failed", detail: BIND_FAILED_REPLY };
  }
}
