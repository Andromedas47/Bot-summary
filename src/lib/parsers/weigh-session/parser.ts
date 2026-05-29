import { BaseParser, type ParseResult } from "@/lib/parsers/base";
import type { LineMessageEvent, LineTextMessage } from "@/lib/line/types";
import { getUserId } from "@/lib/line/verify";
import { logger } from "@/lib/logger";
import { RE } from "./regex";
import type {
  WeighSession,
  WeighSessionItem,
  ProduceUnit,
  TransactionType,
} from "./types";

// ── Pure parse function (exported for unit tests) ─────────────────────────────

export function parseWeighSession(text: string): WeighSession {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let senderName:      string | null = null;
  let txTime:          string | null = null;
  let staffName:       string | null = null;
  let date:            string | null = null;
  let sessionTitle:    string | null = null;
  let currentSection                 = "main";
  let currentTxType: TransactionType = "เบิก";
  let state: "header" | "items"      = "header";

  const items:       WeighSessionItem[]        = [];
  const parseErrors: string[]                  = [];
  let   pendingItem: Partial<WeighSessionItem> | null = null;

  for (const line of lines) {
    const prefixMatch = line.match(RE.TIME_PREFIX);
    let   content: string;

    if (prefixMatch) {
      // Capture sender and time from first TIME_PREFIX occurrence
      if (!senderName) {
        senderName = prefixMatch[2];
        txTime     = prefixMatch[1]; // "HH:MM" or "HH.MM"
      }
      content = prefixMatch[3].trim();
    } else {
      content = line;
    }

    // ── Date extraction ────────────────────────────────────────────────────
    if (!date && !prefixMatch) {
      const m = content.match(RE.DATE_ONLY);
      if (m) {
        date = parseBuddhistDate(m[1], m[2], m[3]);
        continue;
      }
    }
    if (!date) {
      const m = content.match(RE.DATE_IN_TEXT);
      if (m) date = parseBuddhistDate(m[1], m[2], m[3]);
    }

    // ── Session end ────────────────────────────────────────────────────────
    if (RE.SESSION_END.test(content)) {
      if (pendingItem?.product_name) {
        items.push(finalize(pendingItem, currentSection, currentTxType));
        pendingItem = null;
      }
      currentSection = "main";
      continue;
    }

    // ── Header state: wait for session title ───────────────────────────────
    if (state === "header") {
      if (!prefixMatch) continue;

      // Try "พี่ดำ-วิหาร เบิก ..." format first
      const smMatch = content.match(RE.SELLER_MARKET);
      if (smMatch) {
        staffName    = smMatch[1].trim();
        sessionTitle = smMatch[2].trim();
        currentTxType = classifyTxType(smMatch[3] as TransactionType);
        state = "items";
        continue;
      }

      // Fall back to traditional "รายการชั่งเบิก" etc.
      if (RE.SESSION_START.test(content)) {
        sessionTitle  = content;
        currentTxType = classifyTxType(content);
        state         = "items";
      }
      continue;
    }

    // ── Items state ────────────────────────────────────────────────────────

    // Bare line (no prefix) → quantity/weight line
    if (!prefixMatch) {
      const m = content.match(RE.QUANTITY);
      if (m) {
        if (pendingItem?.product_name) {
          pendingItem.quantity = parseFloat(m[1]);
          pendingItem.unit     = m[2] as ProduceUnit;
          items.push(finalize(pendingItem, currentSection, currentTxType));
          pendingItem = null;
        } else {
          parseErrors.push(`quantity with no preceding item: "${line}"`);
        }
      }
      continue;
    }

    // Staff-prefixed line: try item pattern first
    const itemMatch = content.match(RE.ITEM);
    if (itemMatch) {
      if (pendingItem?.product_name) {
        items.push(finalize(pendingItem, currentSection, currentTxType));
      }
      pendingItem = {
        item_number:    parseInt(itemMatch[1], 10),
        product_name:   itemMatch[2].trim(),
        price_per_unit: parseFloat(itemMatch[3]),
        quantity:       null,
        unit:           null,
      };
      continue;
    }

    // Staff-prefixed non-item line → section / transaction-type marker
    if (pendingItem?.product_name) {
      items.push(finalize(pendingItem, currentSection, currentTxType));
      pendingItem = null;
    }
    currentSection = content;
    currentTxType  = classifyTxType(content);
  }

  // Trailing pending item (missing session-end marker)
  if (pendingItem?.product_name) {
    items.push(finalize(pendingItem, currentSection, currentTxType));
  }

  return {
    date,
    staff_name:       staffName ?? senderName ?? "",
    sender_name:      senderName,
    transaction_time: txTime,
    session_title:    sessionTitle,
    items,
    parse_errors:     parseErrors,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function finalize(
  p:       Partial<WeighSessionItem>,
  section: string,
  txType:  TransactionType,
): WeighSessionItem {
  return {
    item_number:      p.item_number!,
    product_name:     p.product_name!,
    price_per_unit:   p.price_per_unit!,
    quantity:         p.quantity ?? null,
    unit:             p.unit     ?? null,
    section,
    transaction_type: txType,
  };
}

function classifyTxType(text: string): TransactionType {
  if (RE.TX_TYPE_BEIK_PHERM.test(text)) return "เบิกเพิ่ม";
  if (RE.TX_TYPE_KUEN_SIA.test(text))   return "คืนเสีย";
  if (RE.TX_TYPE_KUEN.test(text))       return "คืน";
  if (RE.TX_TYPE_BEIK.test(text))       return "เบิก";
  return "เบิก"; // safe default
}

/**
 * Converts a Thai Buddhist calendar date to an ISO 8601 string.
 * Accepts 2-digit short years (69 → 2569 BE) and 4-digit years (2568 BE).
 */
function parseBuddhistDate(day: string, month: string, year: string): string {
  let buddhistYear = parseInt(year, 10);
  if (buddhistYear < 100) buddhistYear += 2500; // "69" → 2569
  const gregorianYear = buddhistYear - 543;
  return `${gregorianYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

// ── Parser class ──────────────────────────────────────────────────────────────

export class WeighSessionParser extends BaseParser {
  name           = "weigh-session";
  version        = "1.1.0";
  supportedTypes = ["text"];

  override canHandle(event: LineMessageEvent): boolean {
    if (event.message.type !== "text") return false;
    return RE.SESSION_START.test((event.message as LineTextMessage).text);
  }

  async parse(event: LineMessageEvent): Promise<ParseResult> {
    const text   = (event.message as LineTextMessage).text;
    const userId = getUserId(event.source);
    const parsed = parseWeighSession(text);

    const log = logger.child({
      parser: this.name,
      staff:  parsed.staff_name,
      items:  parsed.items.length,
    });

    if (parsed.parse_errors.length > 0) {
      log.warn("parse completed with unrecognized lines", { errors: parsed.parse_errors });
    } else {
      log.info("parse succeeded");
    }

    return {
      parserName:    this.name,
      parserVersion: this.version,
      data:          parsed as unknown as Record<string, unknown>,

      persist: async (supabase, rawMessageId) => {
        const { data: session, error: sessionErr } = await supabase
          .from("produce_sessions")
          .insert({
            raw_message_id:   rawMessageId,
            line_user_id:     userId,
            staff_name:       parsed.staff_name,
            sender_name:      parsed.sender_name   ?? undefined,
            transaction_time: parsed.transaction_time ?? undefined,
            session_date:     parsed.date          ?? undefined,
            session_title:    parsed.session_title ?? undefined,
            total_items:      parsed.items.length,
            parser_errors:    parsed.parse_errors.length > 0 ? parsed.parse_errors : null,
          })
          .select("id")
          .single();

        if (sessionErr) {
          throw new Error(`produce_session insert failed: ${sessionErr.message}`);
        }

        for (const item of parsed.items) {
          const { error: itemErr } = await supabase
            .from("produce_items")
            .insert({
              session_id:       session.id,
              item_number:      item.item_number,
              product_name:     item.product_name,
              price_per_unit:   item.price_per_unit,
              quantity:         item.quantity    ?? undefined,
              unit:             item.unit        ?? undefined,
              section:          item.section,
              transaction_type: item.transaction_type,
            });

          if (itemErr) {
            log.warn("failed to insert produce_item", {
              product: item.product_name,
              error:   itemErr.message,
            });
          }
        }
      },
    };
  }
}
