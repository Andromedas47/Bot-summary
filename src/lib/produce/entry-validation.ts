/**
 * P4A — produce entry validation gate (pure domain).
 *
 * The bot is the second checker. A human prepares the withdrawal/return sheet,
 * a second human transcribes it into LINE, and nobody compares the two line by
 * line. This module compares them: every return line is checked against the
 * withdrawal master of its own accountability round before the session is
 * allowed to finalize, so a transcription slip is caught while the operator is
 * still in front of the round instead of surfacing in the 08:00 report.
 *
 * Three things it deliberately does NOT do:
 *
 *  - it never rewrites the operator's text. Product canonicalization is
 *    reporting-only (see remaining-fruit.ts) and stays that way; an unknown
 *    unit is reported, never converted;
 *  - it never merges two products because their names look alike. Fuzzy
 *    distance produces a SUGGESTION for a human, never a match — เขียวมรกต and
 *    เขียวมรกตเก่า are one character apart and are different goods;
 *  - it never coerces a price. A return price may differ from the withdrawal
 *    price; the difference is reported as an advisory while the entered price
 *    remains authoritative for the transaction.
 */

import { createHash } from "node:crypto";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import {
  boundedEditDistance,
  isKnownUnit,
  nearestKnownUnit,
  normalizeUnitAlias,
} from "@/lib/parsers/weigh-session/units";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { baseTransactionType } from "@/lib/summary/transactions";
import {
  isApprovedProductName,
  suggestDictionaryProducts,
  type ProductVocabularySuggestion,
} from "./product-vocabulary";

/** Quantities are numeric(10,3); prices numeric(10,2). Compare inside that grid. */
const QUANTITY_EPSILON = 0.0005;

export type ProduceValidationSeverity = "blocking" | "review_required" | "advisory";

export type ProduceValidationException =
  /** The unit is not part of the shop vocabulary at all ("โลก"). */
  | {
      kind: "unknown_unit";
      severity: "blocking";
      itemNumber: number;
      productName: string;
      unit: string;
      suggestion: string | null;
    }
  /** A known unit, but not one this product was withdrawn in. */
  | {
      kind: "unit_not_withdrawn";
      severity: "blocking";
      itemNumber: number;
      productName: string;
      unit: string;
      withdrawnUnits: string[];
    }
  /** Nothing by this name was withdrawn in this round. */
  | {
      kind: "product_not_withdrawn";
      severity: "blocking";
      itemNumber: number;
      productName: string;
      unit: string;
      suggestions: string[];
    }
  /** Good + damaged returns exceed what was withdrawn. Never confirmable. */
  | {
      kind: "return_exceeds_withdrawal";
      severity: "blocking";
      productName: string;
      unit: string;
      withdrawnQuantity: number;
      goodReturnQuantity: number;
      damagedQuantity: number;
      excessQuantity: number;
    }
  /**
   * A withdrawal is about to mint a product identity that is not an approved
   * dictionary spelling. Distinct from product_not_withdrawn: that one is a
   * RETURN that does not match an existing withdrawal master; this one is the
   * withdrawal master itself being created under a suspicious name.
   */
  | {
      kind: "unknown_product_vocabulary";
      severity: "review_required";
      itemNumber: number;
      productName: string;
      suggestions: ProductVocabularySuggestion[];
    }
  /** An intentional price change is allowed and shown after a successful save. */
  | {
      kind: "price_not_withdrawn";
      severity: "advisory";
      itemNumber: number;
      productName: string;
      unit: string;
      quantity: number;
      enteredPrice: number;
      withdrawnPrices: number[];
    };

export type ProduceValidationBlocking = Extract<
  ProduceValidationException,
  { severity: "blocking" }
>;
export type ProduceValidationReview = Extract<
  ProduceValidationException,
  { severity: "review_required" }
>;
export type ProduceValidationAdvisory = Extract<
  ProduceValidationException,
  { severity: "advisory" }
>;

export interface ProduceValidationResult {
  status: "clean" | "review_required" | "blocked";
  blocking: ProduceValidationBlocking[];
  reviews: ProduceValidationReview[];
  advisories: ProduceValidationAdvisory[];
  /**
   * Immutable fingerprint of (session content + the exception set shown). A
   * confirmation is stored against it, so it can only ever approve the exact
   * data a human looked at.
   */
  digest: string;
}

/** One (canonical product, canonical unit) cell of a round's withdrawal master. */
export interface WithdrawalMasterCell {
  productName: string;
  unit: string;
  withdrawnQuantity: number;
  goodReturnQuantity: number;
  damagedQuantity: number;
  prices: number[];
}

export interface WithdrawalMaster {
  /** Keyed by `${canonical product}|${canonical unit}`. */
  cells: Map<string, WithdrawalMasterCell>;
  /** Canonical product name → the canonical units it was withdrawn in. */
  unitsByProduct: Map<string, Set<string>>;
}

/** A finalized produce row of the round, as exposed by `produce_transactions`. */
export interface RoundMasterRow {
  product_name: string;
  unit: string | null;
  quantity: number | null;
  price_per_unit: number | null;
  transaction_type: string;
}

export function masterCellKey(productName: string, unit: string): string {
  return `${normalizeProductName(productName)}|${normalizeUnitAlias(unit)}`;
}

export function emptyWithdrawalMaster(): WithdrawalMaster {
  return { cells: new Map(), unitsByProduct: new Map() };
}

/**
 * Fold finalized round rows and the session being closed into one master.
 *
 * Both sources matter. The withdrawal may live in an earlier session of the
 * same round (the ordinary เปิดรอบ → ชั่งคืน flow), in an additional
 * withdrawal batch, or in the very document being validated when one session
 * carries both sections.
 */
export function buildWithdrawalMaster(rows: Iterable<RoundMasterRow>): WithdrawalMaster {
  const master = emptyWithdrawalMaster();
  for (const row of rows) {
    const unitRaw = row.unit?.trim();
    if (!unitRaw || row.quantity === null || !Number.isFinite(row.quantity)) continue;
    const base = baseTransactionType(row.transaction_type);
    if (!base) continue;

    const product = normalizeProductName(row.product_name);
    const unit = normalizeUnitAlias(unitRaw);
    const key = `${product}|${unit}`;
    let cell = master.cells.get(key);
    if (!cell) {
      cell = {
        productName: product,
        unit,
        withdrawnQuantity: 0,
        goodReturnQuantity: 0,
        damagedQuantity: 0,
        prices: [],
      };
      master.cells.set(key, cell);
    }

    if (base === "เบิก") {
      cell.withdrawnQuantity += row.quantity;
      // Every withdrawal price is a legitimate price for this cell. One product
      // routinely carries several buckets (100 and 119 on the same durian) and
      // neither of them is an entry error.
      const price = roundPrice(row.price_per_unit);
      if (price !== null && !cell.prices.includes(price)) cell.prices.push(price);

      let units = master.unitsByProduct.get(product);
      if (!units) {
        units = new Set();
        master.unitsByProduct.set(product, units);
      }
      units.add(unit);
    } else if (base === "คืน") {
      cell.goodReturnQuantity += row.quantity;
    } else {
      cell.damagedQuantity += row.quantity;
    }
  }
  for (const cell of master.cells.values()) cell.prices.sort((a, b) => a - b);
  return master;
}

/** The session's own items, in the same shape as a finalized round row. */
export function masterRowsFromSession(parsed: WeighSession): RoundMasterRow[] {
  return parsed.items
    .filter((item) => item.unit !== null && item.quantity !== null)
    .map((item) => ({
      product_name: item.product_name,
      unit: item.unit,
      quantity: item.quantity,
      price_per_unit: item.price_per_unit,
      transaction_type: item.transaction_type,
    }));
}

export interface ProduceValidationInput {
  parsed: WeighSession;
  /** Finalized rows of this session's round. Empty for an unbound session. */
  roundRows: RoundMasterRow[];
  /**
   * True when the session carries an explicit accountability round. Only then
   * is the master complete enough to say "this was never withdrawn": an
   * unbound legacy session has no knowable round, and blocking it would be
   * guessing, not fail-closed. Unit vocabulary is checked either way.
   */
  roundBound: boolean;
}

export function validateProduceEntry(input: ProduceValidationInput): ProduceValidationResult {
  const { parsed, roundRows, roundBound } = input;
  const sessionRows = masterRowsFromSession(parsed);
  const master = buildWithdrawalMaster([...roundRows, ...sessionRows]);

  const blocking: ProduceValidationBlocking[] = [];
  const reviews: ProduceValidationReview[] = [];
  const advisories: ProduceValidationAdvisory[] = [];

  // ── 1. Unit vocabulary. Applies to every item, withdrawal included: a
  // withdrawal booked in "โลก" poisons its own master cell.
  for (const item of parsed.items) {
    const unit = item.unit?.trim();
    if (!unit || isKnownUnit(unit)) continue;
    blocking.push({
      kind: "unknown_unit",
      severity: "blocking",
      itemNumber: item.item_number,
      productName: item.product_name,
      unit,
      suggestion: nearestKnownUnit(unit),
    });
  }

  const unknownUnitItems = new Set(
    blocking
      .filter((exception) => exception.kind === "unknown_unit")
      .map((exception) => exception.itemNumber),
  );

  // ── 1b. Product vocabulary, on withdrawals only. A return is checked against
  // the round's master instead (§2) — that master is the authority for what
  // this round actually holds, and it is exactly what this section protects
  // from being created under a misspelled name in the first place.
  reviews.push(...vocabularyExceptions(parsed));

  // ── 2. Identity and price of every return line, against the master.
  // An unbound legacy session has no knowable round, so the only master it can
  // have is whatever its own document declares. With no withdrawal anywhere,
  // "this was never withdrawn" would be a guess, not a fail-closed verdict.
  const canValidateAgainstMaster = roundBound || master.unitsByProduct.size > 0;
  if (canValidateAgainstMaster) {
    for (const item of parsed.items) {
      const base = baseTransactionType(item.transaction_type);
      if (base !== "คืน" && base !== "คืนเสีย") continue;
      const unitRaw = item.unit?.trim();
      if (!unitRaw || item.quantity === null) continue;
      // An unknown unit already blocks; matching it against the master would
      // only add a second, confusing exception for the same line.
      if (unknownUnitItems.has(item.item_number)) continue;

      const product = normalizeProductName(item.product_name);
      const unit = normalizeUnitAlias(unitRaw);
      const withdrawnUnits = master.unitsByProduct.get(product);

      if (!withdrawnUnits) {
        blocking.push({
          kind: "product_not_withdrawn",
          severity: "blocking",
          itemNumber: item.item_number,
          productName: item.product_name,
          unit,
          suggestions: suggestProducts(product, master),
        });
        continue;
      }
      if (!withdrawnUnits.has(unit)) {
        blocking.push({
          kind: "unit_not_withdrawn",
          severity: "blocking",
          itemNumber: item.item_number,
          productName: item.product_name,
          unit,
          withdrawnUnits: [...withdrawnUnits].sort(),
        });
        continue;
      }

      // Price is validated on its own axis. Product identity is (product, unit)
      // — never the price — so several withdrawal buckets are all valid.
      const cell = master.cells.get(`${product}|${unit}`);
      const entered = roundPrice(item.price_per_unit);
      if (cell && entered !== null && cell.prices.length > 0 && !cell.prices.includes(entered)) {
        advisories.push({
          kind: "price_not_withdrawn",
          severity: "advisory",
          itemNumber: item.item_number,
          productName: item.product_name,
          unit,
          quantity: item.quantity,
          enteredPrice: entered,
          withdrawnPrices: [...cell.prices],
        });
      }
    }

    // ── 3. The inventory invariant, per cell and across every price bucket.
    for (const cell of master.cells.values()) {
      const returned = cell.goodReturnQuantity + cell.damagedQuantity;
      if (returned <= cell.withdrawnQuantity + QUANTITY_EPSILON) continue;
      // A cell with no withdrawal at all is already reported as an unmatched
      // product; adding "returned more than the zero you withdrew" on top of
      // that would be two exceptions for one mistake.
      if (!master.unitsByProduct.get(cell.productName)?.has(cell.unit)) continue;
      blocking.push({
        kind: "return_exceeds_withdrawal",
        severity: "blocking",
        productName: cell.productName,
        unit: cell.unit,
        withdrawnQuantity: round3(cell.withdrawnQuantity),
        goodReturnQuantity: round3(cell.goodReturnQuantity),
        damagedQuantity: round3(cell.damagedQuantity),
        excessQuantity: round3(returned - cell.withdrawnQuantity),
      });
    }
  }

  const digest = computeValidationDigest(parsed, blocking, reviews);
  const status = blocking.length > 0
    ? "blocked"
    : reviews.length > 0
      ? "review_required"
      : "clean";
  return { status, blocking, reviews, advisories, digest };
}

/**
 * Withdrawal lines whose product name is not an approved dictionary spelling.
 *
 * One exception per distinct name, at its first item number: the operator has
 * one spelling to fix, not one per line that carries it. Ordered by item
 * number so the reply is deterministic.
 */
function vocabularyExceptions(parsed: WeighSession): ProduceValidationReview[] {
  const seen = new Set<string>();
  const exceptions: ProduceValidationReview[] = [];
  for (const item of [...parsed.items].sort((a, b) => a.item_number - b.item_number)) {
    if (baseTransactionType(item.transaction_type) !== "เบิก") continue;
    const name = item.product_name.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (isApprovedProductName(name)) continue;
    exceptions.push({
      kind: "unknown_product_vocabulary",
      severity: "review_required",
      itemNumber: item.item_number,
      productName: item.product_name,
      suggestions: suggestDictionaryProducts(name),
    });
  }
  return exceptions;
}

/**
 * Candidate spellings for a product the round never withdrew.
 *
 * Suggestions only, and only from this round's own master — a name that is one
 * or two characters away from something actually withdrawn today is worth
 * showing a human. Nothing here decides anything.
 */
function suggestProducts(product: string, master: WithdrawalMaster): string[] {
  if (product.length < 3) return [];
  const scored: Array<{ name: string; distance: number }> = [];
  for (const candidate of master.unitsByProduct.keys()) {
    if (candidate === product) continue;
    const distance = boundedEditDistance(product, candidate, 2);
    if (distance === null) continue;
    scored.push({ name: candidate, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return scored.slice(0, 3).map((entry) => entry.name);
}

function roundPrice(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Bind a confirmation to what was actually on screen.
 *
 * The digest covers the session content AND the exception set. A straggler
 * arriving after the preview changes the content, so the digest changes, so
 * the earlier confirmation no longer matches and the operator is asked again
 * instead of silently approving text nobody read.
 */
export function computeValidationDigest(
  parsed: WeighSession,
  blocking: ProduceValidationBlocking[],
  reviews: ProduceValidationReview[],
): string {
  const canonicalItems = [...parsed.items]
    .sort((a, b) => a.item_number - b.item_number)
    .map((item: WeighSessionItem) =>
      [
        item.item_number,
        item.product_name,
        item.quantity ?? "",
        item.unit ?? "",
        item.price_per_unit,
        item.transaction_type,
      ].join("|"),
    );
  const canonicalExceptions = [...blocking, ...reviews]
    .map((exception) => JSON.stringify(exception, Object.keys(exception).sort()))
    .sort();
  return createHash("sha256")
    .update(
      [
        parsed.date ?? "",
        parsed.staff_name,
        parsed.session_title ?? "",
        ...canonicalItems,
        "--",
        ...canonicalExceptions,
      ].join("\n"),
    )
    .digest("hex");
}
