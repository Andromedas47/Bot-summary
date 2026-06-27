import { BaseParser, type ParseResult } from "@/lib/parsers/base";
import type { LineMessageEvent, LineTextMessage } from "@/lib/line/types";
import { getUserId } from "@/lib/line/verify";
import { logger } from "@/lib/logger";
import { computeItemHash } from "@/lib/line/session-dedup-service";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { RE, isReservedFinancialLine, isAmbiguousItemPriceLine, looksLikeIndexedItemLine, normalizeIndexedItemHeader, tryExtractAmbiguousRepair } from "./regex";
import type {
  WeighSession,
  WeighSessionItem,
  WeighSessionReviewIssue,
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

  type PendingRepair = {
    item_number:    number;
    product_name:   string;
    unit:           string;
    price_per_unit: number;
    sourceLine:     string;  // original line text for review_issues on failure
  };

  const items:       WeighSessionItem[]        = [];
  const parseErrors: string[]                  = [];
  const reviewIssues: WeighSessionReviewIssue[] = [];
  const repairNotes: string[]                   = [];
  const declaredItemNumbers = new Set<number>();
  let   pendingItem:   Partial<WeighSessionItem> | null = null;
  let   pendingRepair: PendingRepair | null             = null;

  const failPendingRepair = (): void => {
    if (!pendingRepair) return;
    reviewIssues.push({
      item_number: pendingRepair.item_number,
      line:        pendingRepair.sourceLine,
      reason:      "ambiguous_price",
    });
    pendingRepair = null;
  };

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

    if (isReservedFinancialLine(content)) continue;

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
      failPendingRepair(); // no qty line arrived before end
      if (pendingItem?.product_name) {
        if (isMissingQuantity(pendingItem.quantity ?? null)) {
          reviewIssues.push({
            item_number: pendingItem.item_number ?? null,
            line:        `#${pendingItem.item_number ?? "?"} ${pendingItem.product_name}`,
            reason:      "missing_quantity",
          });
        } else {
          const finalizedItem = finalize(pendingItem, currentSection, currentTxType);
          pushOrMergeItem(items, finalizedItem);
          console.log("[TRACE][parseWeighSession] PUSH_ITEM(session-end):", JSON.stringify(finalizedItem), "items_total_after:", items.length);
        }
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

    const trackDeclaredItemLine = (): void => {
      const indexed = content.match(RE.ITEM_LINE_INDEXED);
      if (indexed) declaredItemNumbers.add(parseInt(indexed[1], 10));
    };

    const recordItemLineFailure = (reason: WeighSessionReviewIssue["reason"]): void => {
      const indexed = content.match(RE.ITEM_LINE_INDEXED);
      reviewIssues.push({
        item_number: indexed ? parseInt(indexed[1], 10) : null,
        line:        line,
        reason,
      });
    };

    // Bare line (no prefix) — quantity, item, or tx-type marker
    if (!prefixMatch) {
      const qm = content.match(RE.QUANTITY);
      if (qm) {
        if (pendingRepair) {
          // Repair confirmed only when the next-line unit matches the embedded stray unit.
          const qty  = parseFloat(qm[1]);
          const unit = qm[2];
          if (unit === pendingRepair.unit) {
            const repairedItem = finalize(
              { item_number: pendingRepair.item_number, product_name: pendingRepair.product_name, price_per_unit: pendingRepair.price_per_unit, quantity: qty, unit: unit as ProduceUnit },
              currentSection, currentTxType,
            );
            pushOrMergeItem(items, repairedItem);
            repairNotes.push(`หมายเหตุ: ใช้จำนวนจากบรรทัดถัดไป ${qty} ${unit}`);
            console.log("[TRACE][parseWeighSession] REPAIR_ITEM:", JSON.stringify(repairedItem));
            pendingRepair = null;
          } else {
            // Unit mismatch → fail the repair; orphan the quantity line.
            failPendingRepair();
            parseErrors.push(`quantity with no preceding item: "${line}"`);
          }
        } else if (pendingItem?.product_name) {
          pendingItem.quantity = parseFloat(qm[1]);
          pendingItem.unit     = qm[2] as ProduceUnit;
          const finalizedItem = finalize(pendingItem, currentSection, currentTxType);
          pushOrMergeItem(items, finalizedItem);
          console.log("[TRACE][parseWeighSession] PUSH_ITEM(quantity):", JSON.stringify(finalizedItem), "items_total_after:", items.length);
          pendingItem = null;
        } else {
          parseErrors.push(`quantity with no preceding item: "${line}"`);
        }
      } else {
        trackDeclaredItemLine();
        const parsedItem = parseItemLine(content, nextItemNumber(items, pendingItem));
        if (parsedItem) {
          // Item line sent without LINE export timestamp (direct typed message)
          failPendingRepair(); // repair displaced by new valid item
          if (pendingItem?.product_name) {
            const finalizedItem = finalize(pendingItem, currentSection, currentTxType);
            pushOrMergeItem(items, finalizedItem);
            console.log("[TRACE][parseWeighSession] PUSH_ITEM(displaced):", JSON.stringify(finalizedItem), "items_total_after:", items.length);
          }
          pendingItem = parsedItem;
          console.log("[TRACE][parseWeighSession] SET_PENDING_ITEM:", JSON.stringify(pendingItem));
        } else if (content.length > 0) {
          if (looksLikeIndexedItemLine(content)) {
            failPendingRepair(); // flush before attempting a new repair
            const repair = tryExtractAmbiguousRepair(content);
            if (repair) {
              if (pendingItem?.product_name) {
                const finalizedItem = finalize(pendingItem, currentSection, currentTxType);
                pushOrMergeItem(items, finalizedItem);
                console.log("[TRACE][parseWeighSession] PUSH_ITEM(repair-displaced):", JSON.stringify(finalizedItem), "items_total_after:", items.length);
                pendingItem = null;
              }
              pendingRepair = { ...repair, sourceLine: line };
              console.log("[TRACE][parseWeighSession] SET_PENDING_REPAIR:", JSON.stringify(pendingRepair));
            } else {
              recordItemLineFailure(
                isAmbiguousItemPriceLine(content) ? "ambiguous_price" : "unparsed",
              );
            }
          }
          // Non-item bare line → section / transaction-type marker
          if (!pendingRepair) {
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
            } else if (!looksLikeIndexedItemLine(content)) {
              parseErrors.push(`unrecognized line: "${line}"`);
            }
          }
        }
      }
      continue;
    }

    // Staff-prefixed line: try item pattern first
    trackDeclaredItemLine();
    const parsedItem = parseItemLine(content, nextItemNumber(items, pendingItem));
    if (parsedItem) {
      failPendingRepair(); // new valid item displaces any pending repair
      if (pendingItem?.product_name) {
        pushOrMergeItem(items, finalize(pendingItem, currentSection, currentTxType));
      }
      pendingItem = parsedItem;
      continue;
    }

    if (looksLikeIndexedItemLine(content)) {
      failPendingRepair();
      const repair = tryExtractAmbiguousRepair(content);
      if (repair) {
        if (pendingItem?.product_name) {
          pushOrMergeItem(items, finalize(pendingItem, currentSection, currentTxType));
          pendingItem = null;
        }
        pendingRepair = { ...repair, sourceLine: line };
        console.log("[TRACE][parseWeighSession] SET_PENDING_REPAIR(prefixed):", JSON.stringify(pendingRepair));
        continue;
      }
      recordItemLineFailure(
        isAmbiguousItemPriceLine(content) ? "ambiguous_price" : "unparsed",
      );
    }

    // Staff-prefixed non-item line → section / transaction-type marker
    failPendingRepair(); // section marker interrupts pending repair
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

  // Trailing state: flush any repair that never got its quantity line.
  if (pendingRepair) {
    reviewIssues.push({
      item_number: pendingRepair.item_number,
      line:        pendingRepair.sourceLine,
      reason:      "ambiguous_price",
    });
    pendingRepair = null;
  }

  // Trailing pending item (missing session-end marker)
  if (pendingItem?.product_name) {
    if (isMissingQuantity(pendingItem.quantity ?? null)) {
      reviewIssues.push({
        item_number: pendingItem.item_number ?? null,
        line:        `#${pendingItem.item_number ?? "?"} ${pendingItem.product_name}`,
        reason:      "missing_quantity",
      });
    } else {
      const finalizedItem = finalize(pendingItem, currentSection, currentTxType);
      pushOrMergeItem(items, finalizedItem);
      console.log("[TRACE][parseWeighSession] PUSH_ITEM(trailing):", JSON.stringify(finalizedItem), "items_total_after:", items.length);
    }
  }

  finalizeDeclaredItemGaps(items, declaredItemNumbers, reviewIssues);
  console.log("[TRACE][parseWeighSession] final_items_count:", items.length);

  return {
    date:             date ?? fallbackDate,
    staff_name:       staffName ?? senderName ?? "",
    sender_name:      senderName,
    transaction_time: txTime ?? fallbackTime ?? null,
    session_title:    sessionTitle,
    items,
    parse_errors:     parseErrors,
    review_issues:    dedupeReviewIssues(reviewIssues),
    repair_notes:     repairNotes,
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

function parseItemLine(
  content: string,
  fallbackItemNumber: number,
): Partial<WeighSessionItem> | null {
  if (isReservedFinancialLine(content)) return null;
  if (isAmbiguousItemPriceLine(content)) return null;

  const indexed = normalizeIndexedItemHeader(content).match(RE.ITEM);
  if (indexed) {
    return {
      item_number:    parseInt(indexed[1], 10),
      product_name:   indexed[2].trim(),
      price_per_unit: parseFloat(indexed[3]),
      quantity:       null,
      unit:           null,
    };
  }

  const unindexed = content.match(RE.ITEM_NO_INDEX);
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

function finalizeDeclaredItemGaps(
  items: WeighSessionItem[],
  declaredItemNumbers: Set<number>,
  reviewIssues: WeighSessionReviewIssue[],
): void {
  const parsedNumbers = new Set(items.map((item) => item.item_number));
  const flaggedNumbers = new Set(
    reviewIssues.map((issue) => issue.item_number).filter((n): n is number => n != null),
  );
  const knownNumbers = new Set([...parsedNumbers, ...flaggedNumbers]);

  for (const itemNumber of declaredItemNumbers) {
    if (parsedNumbers.has(itemNumber) || flaggedNumbers.has(itemNumber)) continue;
    reviewIssues.push({
      item_number: itemNumber,
      line:        `#${itemNumber}`,
      reason:      "index_gap",
    });
  }

  if (knownNumbers.size < 2) return;

  const sorted = [...knownNumbers].sort((a, b) => a - b);
  for (let itemNumber = sorted[0]; itemNumber <= sorted[sorted.length - 1]; itemNumber += 1) {
    if (knownNumbers.has(itemNumber)) continue;
    reviewIssues.push({
      item_number: itemNumber,
      line:        `#${itemNumber}`,
      reason:      "index_gap",
    });
  }
}

function dedupeReviewIssues(issues: WeighSessionReviewIssue[]): WeighSessionReviewIssue[] {
  const seen = new Set<string>();
  const out: WeighSessionReviewIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.item_number ?? "x"}:${issue.reason}:${issue.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

export function hasParseReviewBlockers(session: WeighSession): boolean {
  return session.review_issues.length > 0;
}

export function buildParseReviewReply(session: WeighSession): string {
  const lines = session.review_issues.map((issue) => {
    const prefix  = issue.item_number != null ? `#${issue.item_number}` : "?";
    const snippet = issue.line.replace(/^\d+\.?\s*/, "").slice(0, 60);
    return `${prefix} ${snippet}`.trim();
  });
  return `อ่านรายการไม่ครบ กรุณาแก้ไข:\n${lines.join("\n")}`;
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
  if (RE.TX_TYPE_APPEND_RETURN.test(text)) return "ชั่งคืนเพิ่ม";
  if (RE.TX_TYPE_BEIK_PHERM.test(text))   return "เบิกเพิ่ม";
  if (RE.TX_TYPE_KUEN_SIA.test(text))     return "คืนเสีย";
  if (RE.TX_TYPE_KUEN.test(text))         return "คืน";
  if (RE.TX_TYPE_BEIK.test(text))         return "เบิก";
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
