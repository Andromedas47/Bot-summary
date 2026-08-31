/**
 * Dedicated Physical Inventory parser (P2A Slice A).
 *
 * Does NOT route through the produce/weigh-session parser.
 * Does NOT apply P0/P1 product aliases.
 * Does NOT invent unit conversions (ตะกร้า stays ตะกร้า; no basket→kg).
 */

import { parseBuddhistDate } from "@/lib/parsers/weigh-session/parser";
import { isKnownUnit, normalizeUnitAlias } from "@/lib/parsers/weigh-session/units";
import { parseExactDocumentMoney } from "@/lib/purchases/exact-decimal";
import { roundHalfUp, toMilliQuantity } from "@/lib/sales/calculate";
import {
  isPhysicalInventoryHeaderLine,
  isPricedPhysicalInventoryHeaderText,
  matchesPhysicalInventoryCloseLine,
} from "./classify";
import {
  PHYSICAL_INVENTORY_PARSER_VERSION,
  HOUSE_STOCK_PRICED_PARSER_VERSION,
  PHYSICAL_INVENTORY_WAREHOUSE_MAIN,
  type PhysicalInventoryParseIssue,
  type PhysicalInventoryParsedItem,
  type PhysicalInventoryParsedSession,
  type PhysicalInventoryResolutionStatus,
} from "./types";

export {
  classifyPhysicalInventoryStandaloneIntent,
  isPhysicalInventoryHeaderLine,
  isPhysicalInventorySessionClose,
  isPricedPhysicalInventoryHeaderText,
  matchesPhysicalInventoryCloseLine,
} from "./classify";
import {
  PHYSICAL_INVENTORY_EXPLICIT_EMPTY_DECLARATIONS,
  PHYSICAL_INVENTORY_HEADERS,
} from "./patterns";
export * from "./types";
export * from "./patterns";

const DATE_LINE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

/** Trailing qty + optional dot/space + unit (e.g. 3ตะกร้า, 90.ลูก, 15.โล). */
const QTY_UNIT_SUFFIX =
  /^(.+?)(-?\d+(?:\.\d+)?)[.\s]*([^\d\s].+)$/u;

/** Continuation line: qty + unit only (unit must start with a non-digit). */
const QTY_UNIT_ONLY =
  /^(-?\d+(?:\.\d+)?)[.\s]*([^\d\s].+)$/u;

/** Indexed line: leading sequence digits + remainder. */
const INDEXED_LINE =
  /^(\d+)(?!\d)(?:[.)])?\s*(.*)$/u;

const UNIT_PRICE_SUFFIX = /^(.+?)\s*(-?\d+(?:\.\d+)?)\s*บาท$/u;

export interface PhysicalInventoryParseOptions {
  requireUnitPrice?: boolean;
}

function nfcCollapse(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

function pushIssue(
  list: PhysicalInventoryParseIssue[],
  code: string,
  message: string,
  line?: string,
): void {
  list.push(line != null ? { code, message, line } : { code, message });
}

function parseDateToken(token: string): string | null {
  const m = DATE_LINE.exec(nfcCollapse(token));
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return parseBuddhistDate(m[1], m[2], m[3]);
}

function rejected(
  partial: Partial<PhysicalInventoryParsedItem> & { rawText: string; reason: string },
): PhysicalInventoryParsedItem {
  return {
    sequence: partial.sequence ?? null,
    rawText: partial.rawText,
    rawProductDescription: partial.rawProductDescription ?? null,
    quantity: partial.quantity ?? null,
    unitPriceSatang: partial.unitPriceSatang ?? null,
    rawUnit: partial.rawUnit ?? null,
    normalizedUnit: null,
    normalizedProduct: null,
    resolutionStatus: "REJECTED",
    reason: partial.reason,
  };
}

function resolveAccepted(
  sequence: number,
  rawText: string,
  rawProduct: string,
  quantity: number,
  rawUnit: string,
  unitPriceSatang: number | null = null,
  priceReason: string | null = null,
): PhysicalInventoryParsedItem {
  const product = nfcCollapse(rawProduct);
  const unitRaw = nfcCollapse(rawUnit);

  if (!product) {
    return rejected({
      sequence,
      rawText,
      rawProductDescription: null,
      quantity,
      rawUnit: unitRaw || null,
      reason: "missing_product",
    });
  }
  if (!unitRaw) {
    return rejected({
      sequence,
      rawText,
      rawProductDescription: product,
      quantity,
      rawUnit: null,
      reason: "missing_unit",
    });
  }
  if (!Number.isFinite(quantity)) {
    return rejected({
      sequence,
      rawText,
      rawProductDescription: product,
      quantity: null,
      rawUnit: unitRaw,
      reason: "missing_quantity",
    });
  }
  if (quantity <= 0) {
    return rejected({
      sequence,
      rawText,
      rawProductDescription: product,
      quantity,
      rawUnit: unitRaw,
      reason: quantity === 0 ? "zero_quantity" : "negative_quantity",
    });
  }
  if (priceReason || unitPriceSatang !== null && unitPriceSatang <= 0) {
    return rejected({
      sequence,
      rawText,
      rawProductDescription: product,
      quantity,
      rawUnit: unitRaw,
      unitPriceSatang,
      reason: priceReason ?? "invalid_unit_price",
    });
  }

  // Spelling aliases only — never resolveUnitQuantity (no ขีด→โล rescale here).
  const unitKnown = isKnownUnit(unitRaw);
  const normalizedUnit = unitKnown ? normalizeUnitAlias(unitRaw) : null;
  // Capture normalization only — not canonical inventory resolution for P2C.
  const status: PhysicalInventoryResolutionStatus = unitKnown
    ? "ACCEPTED_NORMALIZED"
    : "ACCEPTED_RAW";

  return {
    sequence,
    rawText,
    rawProductDescription: product,
    quantity,
    unitPriceSatang,
    rawUnit: unitRaw,
    normalizedUnit,
    normalizedProduct: product,
    resolutionStatus: status,
    reason: unitKnown ? null : "unknown_unit",
  };
}

function trySplitProductQtyUnit(remainder: string): {
  product: string;
  quantity: number;
  unit: string;
} | null {
  const m = QTY_UNIT_SUFFIX.exec(nfcCollapse(remainder));
  if (!m) return null;
  const product = nfcCollapse(m[1]);
  const quantity = Number(m[2]);
  const unit = nfcCollapse(m[3]);
  if (!product || !unit || !Number.isFinite(quantity)) return null;
  // Avoid treating a lone decimal artifact as qty when product empty
  return { product, quantity, unit };
}

function tryParseQtyUnitOnly(line: string): { quantity: number; unit: string } | null {
  const m = QTY_UNIT_ONLY.exec(nfcCollapse(line));
  if (!m) return null;
  const quantity = Number(m[1]);
  const unit = nfcCollapse(m[2]);
  if (!unit || !Number.isFinite(quantity)) return null;
  return { quantity, unit };
}

/** Unit-only remainder ⇒ qty+unit line, not "sequence + product named โล". */
function isUnitOnlyToken(token: string): boolean {
  const u = nfcCollapse(token);
  // ตะกร้า is a real physical unit in staff counts but not in the produce registry.
  return isKnownUnit(u) || u === "ตะกร้า";
}

function isQtyUnitOnlyLine(line: string): boolean {
  const collapsed = nfcCollapse(line);
  const qu = tryParseQtyUnitOnly(collapsed);
  if (!qu) return false;
  // Decide purely from the quantity+unit split itself (isUnitOnlyToken), not
  // by comparing against INDEXED_LINE's naive leading-digit-run remainder —
  // that comparison breaks whenever the quantity has its own decimal point
  // (e.g. "25.1.โล": INDEXED_LINE reads sequence 25 + remainder "1.โล",
  // which never matches the correctly split unit "โล").
  return isUnitOnlyToken(qu.unit);
}

interface OpenItem {
  sequence: number;
  product: string;
  headerRaw: string;
  unitPriceSatang: number | null;
  priceReason: string | null;
}

function parseUnitPrice(text: string): {
  product: string;
  unitPriceSatang: number | null;
  priceReason: string | null;
} {
  const match = UNIT_PRICE_SUFFIX.exec(nfcCollapse(text));
  if (!match) return { product: nfcCollapse(text), unitPriceSatang: null, priceReason: "missing_unit_price" };
  const [, product, amount] = match;
  // Exact BigInt decimal→satang conversion (same helper the Purchase Capture
  // pipeline uses) — never `Number(amount) * 100`, which misrounds valid
  // 2-decimal baht amounts like 2.01 or 10.05 under IEEE-754 (see
  // src/lib/purchases/exact-decimal.ts). The parser regex allows a leading
  // "-", but parseExactDocumentMoney's grammar is unsigned, so a negative
  // amount fails to parse and falls into the same invalid_unit_price path
  // negative/zero prices already took.
  const parsed = parseExactDocumentMoney(amount);
  if (!parsed.ok) {
    return { product: nfcCollapse(product), unitPriceSatang: null, priceReason: "invalid_unit_price" };
  }
  const satang = parsed.value.satang;
  if (satang <= BigInt(0) || !Number.isSafeInteger(Number(satang))) {
    return { product: nfcCollapse(product), unitPriceSatang: null, priceReason: "invalid_unit_price" };
  }
  return { product: nfcCollapse(product), unitPriceSatang: Number(satang), priceReason: null };
}

/**
 * Bundle pricing (e.g. "3โล100บาท" = 100 บาท for every 3 โล) converts to an
 * effective per-remaining-unit price, half-up rounded to the nearest satang.
 * The schema has one quantity/unit-price pair — there is no separate
 * pricing-basis column — so the bundle basis is folded in here; the raw
 * text stays intact in rawText for audit.
 */
function computeBundleUnitPriceSatang(
  totalPriceSatang: number,
  pricingQuantity: number,
): number | null {
  if (!Number.isSafeInteger(totalPriceSatang) || totalPriceSatang <= 0) return null;
  const pricingMilli = toMilliQuantity(pricingQuantity);
  if (pricingMilli === null || pricingMilli <= BigInt(0)) return null;
  const perUnit = roundHalfUp(BigInt(totalPriceSatang) * BigInt(1000), pricingMilli);
  return Number.isSafeInteger(Number(perUnit)) && perUnit > BigInt(0) ? Number(perUnit) : null;
}

/**
 * Exact empty-house declaration for priced House Stock.
 * Strips only an optional leading item number / . ) / whitespace.
 */
export function isExplicitEmptyHouseStockDeclaration(text: string): boolean {
  const collapsed = nfcCollapse(text);
  if (!collapsed) return false;
  const stripped = collapsed.replace(/^\d+(?!\d)(?:[.)])?\s*/u, "");
  return (PHYSICAL_INVENTORY_EXPLICIT_EMPTY_DECLARATIONS as readonly string[])
    .includes(stripped);
}

/**
 * Parse a complete Physical Stock multi-line document (header + date + items + close).
 * Deleted/unsent LINE content is unknowable — never inferred or reconstructed.
 */
export function parsePhysicalInventoryDocument(
  text: string,
  options: PhysicalInventoryParseOptions = {},
): PhysicalInventoryParsedSession {
  const errors: PhysicalInventoryParseIssue[] = [];
  const warnings: PhysicalInventoryParseIssue[] = [];
  const items: PhysicalInventoryParsedItem[] = [];
  let explicitEmpty = false;

  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.map((l) => l.trimEnd()).map((l) => l.trim());

  let headerText: string | null = null;
  let businessDate: string | null = null;
  let closeText: string | null = null;
  let i = 0;

  // Skip leading empties
  while (i < lines.length && !nfcCollapse(lines[i] ?? "")) i++;

  // Header
  if (i < lines.length && isPhysicalInventoryHeaderLine(lines[i]!)) {
    const headerLine = nfcCollapse(lines[i]!);
    const header = [...PHYSICAL_INVENTORY_HEADERS]
      .sort((a, b) => b.length - a.length)
      .find((value) => headerLine === value || headerLine.startsWith(`${value} `))!;
    headerText = header;
    const inlineDate = headerLine.slice(header.length).trim();
    if (inlineDate) businessDate = parseDateToken(inlineDate);
    i++;
  } else {
    pushIssue(errors, "missing_header", "Physical stock header not found");
  }

  while (i < lines.length && !nfcCollapse(lines[i] ?? "")) i++;

  // Date (dedicated line)
  if (!businessDate && i < lines.length) {
    const date = parseDateToken(lines[i]!);
    if (date) {
      businessDate = date;
      i++;
    } else if (headerText) {
      pushIssue(errors, "missing_or_invalid_date", "Business date missing or invalid", lines[i]);
    }
  } else if (!businessDate && headerText) {
    pushIssue(errors, "missing_or_invalid_date", "Business date missing or invalid");
  }

  const seenSequences = new Set<number>();
  let open: OpenItem | null = null;
  let expectedNextSeq = 1;

  const flushIncomplete = (reason: string) => {
    if (!open) return;
    items.push(
      rejected({
        sequence: open.sequence,
        rawText: open.headerRaw,
        rawProductDescription: open.product,
        reason,
      }),
    );
    open = null;
  };

  const noteSequenceGaps = (seq: number) => {
    if (seq > expectedNextSeq) {
      pushIssue(
        warnings,
        "sequence_gap",
        `Missing sequence number(s) between ${expectedNextSeq} and ${seq - 1}`,
      );
    }
    if (seq >= expectedNextSeq) expectedNextSeq = seq + 1;
  };

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const collapsed = nfcCollapse(line);
    if (!collapsed) continue;

    // In-document close (session context is implied by parsing a document)
    if (matchesPhysicalInventoryCloseLine(collapsed)) {
      flushIncomplete("missing_quantity");
      closeText = collapsed;
      // Ignore trailing lines after close — do not invent missing content
      break;
    }

    // Continuation qty+unit MUST win over "leading digits = sequence"
    // (e.g. open product then "15โล" / "6ตะกร้า").
    if (open) {
      if (/^-?\d+(?:\.\d+)?$/.test(collapsed)) {
        items.push(rejected({
          sequence: open.sequence,
          rawText: `${open.headerRaw}\n${collapsed}`,
          rawProductDescription: open.product,
          quantity: Number(collapsed),
          unitPriceSatang: open.unitPriceSatang,
          reason: options.requireUnitPrice ? "missing_unit" : "missing_quantity",
        }));
        open = null;
        continue;
      }
      const qu = tryParseQtyUnitOnly(collapsed);
      if (qu) {
        const rawText = `${open.headerRaw}\n${collapsed}`;
        items.push(resolveAccepted(
          open.sequence,
          rawText,
          open.product,
          qu.quantity,
          qu.unit,
          open.unitPriceSatang,
          open.priceReason,
        ));
        open = null;
        continue;
      }
      // Non-qty line while open → incomplete previous; fall through to re-parse
      flushIncomplete("missing_quantity");
    }

    if (
      options.requireUnitPrice
      && (headerText === null || isPricedPhysicalInventoryHeaderText(headerText))
      && isExplicitEmptyHouseStockDeclaration(collapsed)
    ) {
      if (items.length > 0 || explicitEmpty) {
        pushIssue(
          errors,
          "explicit_empty_conflict",
          "Explicit empty declaration conflicts with inventory items",
          collapsed,
        );
      } else {
        explicitEmpty = true;
        pushIssue(
          warnings,
          "explicit_empty",
          "Operator declared no remaining house stock",
          collapsed,
        );
      }
      continue;
    }

    if (explicitEmpty) {
      pushIssue(
        errors,
        "explicit_empty_conflict",
        "Explicit empty declaration conflicts with inventory items",
        collapsed,
      );
      continue;
    }

    const indexed = INDEXED_LINE.exec(collapsed);
    if (indexed && !isQtyUnitOnlyLine(collapsed)) {
      const seq = Number(indexed[1]);
      const remainder = nfcCollapse(indexed[2] ?? "");

      // Sequence is staff ordering metadata, not item identity — duplicates stay.
      if (seenSequences.has(seq)) {
        pushIssue(
          warnings,
          "DUPLICATE_SEQUENCE",
          `Duplicate sequence number ${seq} — both observations preserved`,
          collapsed,
        );
      }
      seenSequences.add(seq);
      noteSequenceGaps(seq);

      if (!remainder) {
        items.push(
          rejected({
            sequence: seq,
            rawText: collapsed,
            reason: "missing_product",
          }),
        );
        continue;
      }

      const priced = options.requireUnitPrice ? parseUnitPrice(remainder) : null;

      // A found price never resolves on the same line — the remaining
      // quantity/unit always arrives as a continuation line/message. A
      // qty+unit still embedded in the product text after the price is
      // stripped is the bundle pricing basis (e.g. "3โล" in
      // "ส้มไต้หวัน3โล100บาท" = 100 บาท per 3 โล), never the remaining stock.
      if (priced && priced.priceReason === null) {
        const bundle = trySplitProductQtyUnit(priced.product);
        if (bundle) {
          const bundleUnitPriceSatang = computeBundleUnitPriceSatang(
            priced.unitPriceSatang!,
            bundle.quantity,
          );
          if (bundleUnitPriceSatang === null) {
            items.push(
              rejected({
                sequence: seq,
                rawText: collapsed,
                rawProductDescription: bundle.product,
                reason: "invalid_unit_price",
              }),
            );
            continue;
          }
          open = {
            sequence: seq,
            product: bundle.product,
            headerRaw: collapsed,
            unitPriceSatang: bundleUnitPriceSatang,
            priceReason: null,
          };
          continue;
        }
        open = {
          sequence: seq,
          product: priced.product,
          headerRaw: collapsed,
          unitPriceSatang: priced.unitPriceSatang,
          priceReason: null,
        };
        continue;
      }

      const itemRemainder = priced?.product ?? remainder;
      const oneLine = trySplitProductQtyUnit(itemRemainder);
      if (oneLine) {
        items.push(
          resolveAccepted(
            seq,
            collapsed,
            oneLine.product,
            oneLine.quantity,
            oneLine.unit,
            priced?.unitPriceSatang ?? null,
            priced?.priceReason ?? null,
          ),
        );
        continue;
      }

      // Product-only line; qty/unit expected next
      open = {
        sequence: seq,
        product: itemRemainder,
        headerRaw: collapsed,
        unitPriceSatang: priced?.unitPriceSatang ?? null,
        priceReason: priced?.priceReason ?? null,
      };
      continue;
    }

    // Orphan qty/unit without product (or qty line that was not consumed as continuation)
    const orphanQty = tryParseQtyUnitOnly(collapsed);
    if (orphanQty && isQtyUnitOnlyLine(collapsed)) {
      items.push(
        rejected({
          rawText: collapsed,
          quantity: orphanQty.quantity,
          rawUnit: orphanQty.unit,
          reason: "missing_product",
        }),
      );
      continue;
    }

    if (isPhysicalInventoryHeaderLine(collapsed)) {
      pushIssue(
        warnings,
        "header_like_in_body",
        "Header-like text ignored inside item body",
        collapsed,
      );
      continue;
    }

    pushIssue(warnings, "unrecognized_line", "Unrecognized line in physical stock body", collapsed);
  }

  flushIncomplete("missing_quantity");

  if (headerText && !closeText) {
    pushIssue(warnings, "missing_close", "Document ended without a recognized close line");
  }

  return {
    businessDate,
    warehouseCode: PHYSICAL_INVENTORY_WAREHOUSE_MAIN,
    parserVersion: options.requireUnitPrice
      ? HOUSE_STOCK_PRICED_PARSER_VERSION
      : PHYSICAL_INVENTORY_PARSER_VERSION,
    headerText,
    closeText,
    items,
    explicitEmpty,
    errors,
    warnings,
  };
}

/**
 * Narrow session-gated routing predicate for a standalone Physical Inventory
 * item message. The actual parser must recognize at least one accepted
 * observation. Selling-price text belongs to Produce, never P2A.
 */
export function isRecognizedPhysicalInventoryItemBlock(
  text: string,
  options: PhysicalInventoryParseOptions = {},
): boolean {
  if (!options.requireUnitPrice && /บาท/u.test(text.normalize("NFC"))) return false;

  const parsed = parsePhysicalInventoryDocument(text, options);
  const hasAcceptedObservation = parsed.items.some(
    (item) =>
      item.resolutionStatus === "ACCEPTED_NORMALIZED"
      || item.resolutionStatus === "ACCEPTED_RAW",
  );
  const hasUnrecognizedLine = parsed.warnings.some(
    (warning) => warning.code === "unrecognized_line",
  );
  const hasEmptyConflict = parsed.errors.some(
    (error) => error.code === "explicit_empty_conflict",
  );

  return (hasAcceptedObservation || parsed.explicitEmpty)
    && !hasUnrecognizedLine
    && !hasEmptyConflict;
}

export interface PhysicalInventoryBundlePricingBasis {
  pricingQuantity: number;
  pricingUnit: string;
  totalPriceSatang: number;
}

/**
 * Recover the original bundle-pricing expression (e.g. "3 โล 100 บาท") from
 * a persisted item's rawText, for DISPLAY only — never re-derives quantity
 * or price for storage/finalize. Reuses the same price/qty-unit splitting
 * the live parser uses, so this never drifts from what parsing actually
 * decided. Returns null for standard (non-bundle) pricing or plain text.
 */
export function extractPhysicalInventoryBundlePricingBasis(
  rawText: string,
): PhysicalInventoryBundlePricingBasis | null {
  const headerLine = nfcCollapse(rawText.split(/\r?\n/)[0] ?? "");
  const indexed = INDEXED_LINE.exec(headerLine);
  const remainder = indexed ? nfcCollapse(indexed[2] ?? "") : headerLine;
  if (!remainder) return null;

  const priced = parseUnitPrice(remainder);
  if (priced.priceReason !== null || priced.unitPriceSatang === null) return null;

  const bundle = trySplitProductQtyUnit(priced.product);
  if (!bundle) return null;

  return {
    pricingQuantity: bundle.quantity,
    pricingUnit: bundle.unit,
    totalPriceSatang: priced.unitPriceSatang,
  };
}

/** Accepted observations only (RESOLVED + RAW). */
export function acceptedPhysicalInventoryItems(
  session: PhysicalInventoryParsedSession,
): PhysicalInventoryParsedItem[] {
  return session.items.filter(
    (it) =>
      it.resolutionStatus === "ACCEPTED_NORMALIZED" ||
      it.resolutionStatus === "ACCEPTED_RAW",
  );
}
