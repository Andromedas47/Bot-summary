import { BaseParser, type ParseResult } from "@/lib/parsers/base";
import type { LineMessageEvent, LineTextMessage } from "@/lib/line/types";
import { getUserId } from "@/lib/line/verify";
import { logger } from "@/lib/logger";
import { computeItemHash } from "@/lib/line/session-dedup-service";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { RE } from "./regex";
import type {
  WeighSession,
  WeighSessionItem,
  ProduceUnit,
  TransactionType,
} from "./types";

// ── Pure parse function (exported for unit tests) ─────────────────────────────

export function parseWeighSession(
  text:         string,
  fallbackDate: string | null = null,
  fallbackTime: string | null = null,
): WeighSession {
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

  console.log("[TRACE][parseWeighSession] input_lines:", JSON.stringify(lines));
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
    console.log(`[TRACE][parseWeighSession] line="${line}" state=${state} content="${content}" hasPrefix=${!!prefixMatch} pendingItem=${JSON.stringify(pendingItem)}`);

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
      console.log("[TRACE][parseWeighSession] SESSION_END detected, pendingItem:", JSON.stringify(pendingItem));
      if (pendingItem?.product_name) {
        const finalizedItem = finalize(pendingItem, currentSection, currentTxType);
        pushOrMergeItem(items, finalizedItem);
        console.log("[TRACE][parseWeighSession] PUSH_ITEM(session-end):", JSON.stringify(finalizedItem), "items_total_after:", items.length);
        pendingItem = null;
      }
      currentSection = "main";
      continue;
    }

    // ── Header state: wait for session title ───────────────────────────────
    if (state === "header") {
      // Accept both prefixed (LINE export) and bare (direct typed) header lines.
      const headerItem = parseItemLine(content, nextItemNumber(items, pendingItem));
      if (headerItem) {
        pendingItem = headerItem;
        state = "items";
        console.log("[TRACE][parseWeighSession] SET_PENDING_ITEM:", JSON.stringify(pendingItem));
        continue;
      }

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

    // Bare line (no prefix) — quantity, item, or tx-type marker
    if (!prefixMatch) {
      const qm = content.match(RE.QUANTITY);
      if (qm) {
        if (pendingItem?.product_name) {
          applyQuantity(pendingItem, parseFloat(qm[1]), qm[2]);
          const finalizedItem = finalize(pendingItem, currentSection, currentTxType);
          pushOrMergeItem(items, finalizedItem);
          console.log("[TRACE][parseWeighSession] PUSH_ITEM(quantity):", JSON.stringify(finalizedItem), "items_total_after:", items.length);
          pendingItem = null;
        } else {
          parseErrors.push(`quantity with no preceding item: "${line}"`);
        }
      } else {
        const parsedItem = parseItemLine(content, nextItemNumber(items, pendingItem));
        if (parsedItem) {
          // Item line sent without LINE export timestamp (direct typed message)
          if (pendingItem?.product_name) {
            const finalizedItem = finalize(pendingItem, currentSection, currentTxType);
            pushOrMergeItem(items, finalizedItem);
            console.log("[TRACE][parseWeighSession] PUSH_ITEM(displaced):", JSON.stringify(finalizedItem), "items_total_after:", items.length);
          }
          pendingItem = parsedItem;
          console.log("[TRACE][parseWeighSession] SET_PENDING_ITEM:", JSON.stringify(pendingItem));
        } else if (content.length > 0) {
          // Non-item bare line → section / transaction-type marker
          if (pendingItem?.product_name) {
            const finalizedItem = finalize(pendingItem, currentSection, currentTxType);
            pushOrMergeItem(items, finalizedItem);
            console.log("[TRACE][parseWeighSession] PUSH_ITEM(section-change):", JSON.stringify(finalizedItem), "items_total_after:", items.length);
            pendingItem = null;
          }
          const nextTxType = detectTxType(content);
          if (nextTxType) {
            currentSection = content;
            currentTxType  = nextTxType;
            console.log("[TRACE][parseWeighSession] SECTION_CHANGE:", content, "txType:", currentTxType);
          } else {
            parseErrors.push(`unrecognized line: "${line}"`);
          }
        }
      }
      continue;
    }

    // Staff-prefixed line: try item pattern first
    const parsedItem = parseItemLine(content, nextItemNumber(items, pendingItem));
    if (parsedItem) {
      if (pendingItem?.product_name) {
        pushOrMergeItem(items, finalize(pendingItem, currentSection, currentTxType));
      }
      pendingItem = parsedItem;
      continue;
    }

    // Staff-prefixed non-item line → section / transaction-type marker
    if (pendingItem?.product_name) {
      pushOrMergeItem(items, finalize(pendingItem, currentSection, currentTxType));
      pendingItem = null;
    }
    const nextTxType = detectTxType(content);
    if (nextTxType) {
      currentSection = content;
      currentTxType  = nextTxType;
    } else {
      parseErrors.push(`unrecognized line: "${line}"`);
    }
  }

  // Trailing pending item (missing session-end marker)
  if (pendingItem?.product_name) {
    const finalizedItem = finalize(pendingItem, currentSection, currentTxType);
    pushOrMergeItem(items, finalizedItem);
    console.log("[TRACE][parseWeighSession] PUSH_ITEM(trailing):", JSON.stringify(finalizedItem), "items_total_after:", items.length);
  }
  console.log("[TRACE][parseWeighSession] final_items_count:", items.length);

  return {
    date:             date ?? fallbackDate,
    staff_name:       staffName ?? senderName ?? "",
    sender_name:      senderName,
    transaction_time: txTime ?? fallbackTime ?? null,
    session_title:    sessionTitle,
    items,
    parse_errors:     parseErrors,
  };
}

export function getWeighSessionFinalizationErrors(session: WeighSession): string[] {
  const errors = [...session.parse_errors];

  for (const item of session.items) {
    if (
      item.quantity === null ||
      !Number.isFinite(item.quantity) ||
      item.quantity <= 0 ||
      item.unit === null
    ) {
      errors.push(
        `item #${item.item_number} "${item.product_name}" has invalid quantity or unit`,
      );
    }
  }

  return errors;
}

export function assertWeighSessionFinalizable(session: WeighSession): void {
  const errors = getWeighSessionFinalizationErrors(session);
  if (errors.length > 0) {
    throw new Error(`weigh session validation failed: ${errors.join("; ")}`);
  }
}

export function buildWeighSessionValidationReply(session: WeighSession): string {
  const details = getWeighSessionFinalizationErrors(session).map((error) => {
    const quotedLine = error.match(/"([^"]+)"/)?.[1];
    if (quotedLine) return `- ${quotedLine}`;

    const item = error.match(/^item #(\d+) "([^"]+)"/);
    if (item) return `- รายการ #${item[1]} ${item[2]}: จำนวนหรือหน่วยไม่ถูกต้อง`;

    return `- ${error}`;
  });

  return [
    "อ่านรายการไม่ครบ จึงยังไม่บันทึก",
    "กรุณาตรวจสอบบรรทัดสินค้าและจำนวน แล้วส่งใหม่",
    ...details,
  ].join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function applyQuantity(
  item: Partial<WeighSessionItem>,
  quantity: number,
  unit: string,
): void {
  if (unit === "ขีด") {
    // Shop rule: 1 ขีด = 0.1 โล. Convert both quantity and price basis so
    // price-per-unit × quantity remains unchanged.
    item.quantity = Number((quantity * 0.1).toFixed(10));
    item.unit = "โล";
    item.price_per_unit = item.price_per_unit! * 10;
    return;
  }

  item.quantity = quantity;
  item.unit = unit as ProduceUnit;
}

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
    unit:             normalizeUnit(p.unit),
    section,
    transaction_type: txType,
  };
}

function pushOrMergeItem(items: WeighSessionItem[], item: WeighSessionItem): void {
  const existingIndex = findMergeCandidateIndex(items, item);

  if (existingIndex === -1) {
    items.push(item);
    return;
  }

  if (hasValidQuantity(item)) {
    items[existingIndex] = {
      ...item,
      item_number: items[existingIndex].item_number,
      section: items[existingIndex].section,
      transaction_type: items[existingIndex].transaction_type,
    };
    return;
  }

  // Avoid appending repeated zero/null placeholders for the same product+price.
}

function parseItemLine(content: string, fallbackItemNumber: number): Partial<WeighSessionItem> | null {
  const normalizedContent = normalizeItemLinePunctuation(content);
  const indexed = normalizedContent.match(RE.ITEM);
  if (indexed) {
    return {
      item_number:    parseInt(indexed[1], 10),
      product_name:   indexed[2].trim(),
      price_per_unit: parseFloat(indexed[3]),
      quantity:       null,
      unit:           null,
    };
  }

  const unindexed = normalizedContent.match(RE.ITEM_NO_INDEX);
  if (unindexed) {
    return {
      item_number:    fallbackItemNumber,
      product_name:   unindexed[1].trim(),
      price_per_unit: parseFloat(unindexed[2]),
      quantity:       null,
      unit:           null,
    };
  }

  return null;
}

function normalizeItemLinePunctuation(content: string): string {
  return content
    .replace(/(\d)\.\s*บาท\.?\s*$/, "$1บาท")
    .replace(/บาท\.\s*$/, "บาท");
}

function nextItemNumber(
  items: WeighSessionItem[],
  pendingItem: Partial<WeighSessionItem> | null,
): number {
  const maxExisting = items.reduce((max, item) => Math.max(max, item.item_number), 0);
  return Math.max(maxExisting, pendingItem?.item_number ?? 0) + 1;
}

function findMergeCandidateIndex(items: WeighSessionItem[], item: WeighSessionItem): number {
  if (hasValidQuantity(item)) {
    const sameIndex = items.findIndex((existing) =>
      existing.item_number === item.item_number &&
      existing.transaction_type === item.transaction_type &&
      (isIncompleteItem(existing) || sameProductAndPrice(existing, item)),
    );
    if (sameIndex !== -1) return sameIndex;
  }

  return items.findIndex((existing) =>
    sameProductAndPrice(existing, item) &&
    existing.transaction_type === item.transaction_type &&
    isIncompleteItem(existing),
  );
}

function sameProductAndPrice(a: WeighSessionItem, b: WeighSessionItem): boolean {
  return normalizeProductName(a.product_name) === normalizeProductName(b.product_name)
    && a.price_per_unit === b.price_per_unit;
}

function normalizeProductName(name: string): string {
  return name.replace(/\s+/g, "").trim();
}

function isMissingQuantity(quantity: number | null): boolean {
  return quantity === null || quantity === 0;
}

function isIncompleteItem(item: WeighSessionItem): boolean {
  return isMissingQuantity(item.quantity) || item.unit === null;
}

function hasValidQuantity(item: WeighSessionItem): boolean {
  return item.quantity !== null && Number.isFinite(item.quantity) && item.quantity > 0 && item.unit !== null;
}

function normalizeUnit(
  unit: ProduceUnit | "แพ็ค" | "แพ็ก" | "เเพ็ค" | "เเพค" | "แพต" | "แพ็ด" | "แผค" | null | undefined,
): ProduceUnit | null {
  if (
    unit === "แพ็ค" ||
    unit === "แพ็ก" ||
    unit === "เเพ็ค" ||
    unit === "เเพค" ||
    unit === "แพต" ||
    unit === "แพ็ด" ||
    unit === "แผค"
  ) return "แพค";
  return unit ?? null;
}

function classifyTxType(text: string): TransactionType {
  return detectTxType(text) ?? "เบิก"; // safe default for session headers
}

function detectTxType(text: string): TransactionType | null {
  if (RE.TX_TYPE_BEIK_PHERM.test(text)) return "เบิกเพิ่ม";
  if (RE.TX_TYPE_KUEN_SIA.test(text))   return "คืนเสีย";
  if (RE.TX_TYPE_KUEN.test(text))       return "คืน";
  if (RE.TX_TYPE_BEIK.test(text))       return "เบิก";
  return null;
}

/**
 * Converts a Thai Buddhist calendar date to an ISO 8601 string.
 * Accepts 2-digit short years (69 → 2569 BE) and 4-digit years (2568 BE).
 */
export function parseBuddhistDate(day: string, month: string, year: string): string {
  let buddhistYear = parseInt(year, 10);
  if (buddhistYear < 100) buddhistYear += 2500; // "69" → 2569
  const gregorianYear = buddhistYear - 543;
  return `${gregorianYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** Converts a LINE event timestamp (ms) to Bangkok local time "HH:mm". */
export function bangkokTimeFromTimestamp(ts: number | undefined): string | null {
  if (ts == null || !Number.isFinite(ts)) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
  }).formatToParts(new Date(ts));

  const h = parts.find((p) => p.type === "hour")?.value;
  const m = parts.find((p) => p.type === "minute")?.value;

  return h && m ? `${h}:${m}` : null;
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
    const parsed = parseWeighSession(
      text,
      bangkokBusinessDateFromTimestamp(event.timestamp),
      bangkokTimeFromTimestamp(event.timestamp),
    );

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
        assertWeighSessionFinalizable(parsed);

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

        try {
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
                item_hash:        computeItemHash(parsed, item),
              });

            if (itemErr) {
              throw new Error(`produce_item insert failed for ${item.product_name}: ${itemErr.message}`);
            }
          }
        } catch (err) {
          await supabase.from("produce_sessions").delete().eq("id", session.id);
          throw err;
        }
      },
    };
  }
}
