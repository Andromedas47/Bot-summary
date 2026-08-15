/**
 * Canonical business-content fingerprint for a produce session.
 *
 * The 2026-08-14 incident: the SAME 16-item withdrawal for แทน — ราชพฤก was
 * submitted from two different LINE groups and both persisted, inflating
 * calculated sales by exactly one withdrawal. The deployed duplicate blocker
 * (imported_sessions.session_hash, unique, inserted ON CONFLICT DO NOTHING
 * inside try_finalize_pending_generation) was already source-independent — it
 * simply hashed the RAW parsed strings, so "อะโวคาโด" and "อะโวคาโด้" produced
 * two different hashes for one business withdrawal.
 *
 * This module supplies the identity the blocker should have been using:
 * canonical business content only.
 *
 * IN the fingerprint:
 *   business date, normalized seller, normalized market identity, the base
 *   transaction types present, and the item MULTISET — each item as canonical
 *   product identity, canonical unit, quantity, effective price and pricing
 *   basis.
 *
 * NEVER in the fingerprint:
 *   raw_message_id, LINE event id, sender/owner user id, source_id,
 *   session_key, session generation. Those stay audit metadata, which is the
 *   whole point: two LINE sources carrying one business withdrawal must
 *   fingerprint identically.
 *
 * Two properties the callers depend on:
 *
 *   Order-insensitive. Item lines are sorted by canonical content, so the same
 *   withdrawal typed in a different order is the same fingerprint.
 *
 *   Multiplicity-preserving. Lines are NOT de-duplicated before hashing. A
 *   legitimate withdrawal that lists กระชาย 6 แพค @20 twice has two rows in the
 *   multiset and stays distinct from one that lists it once.
 *
 * The two adapters (a parsed WeighSession on the write path, persisted produce
 * rows on the read-only detector path) MUST agree digit for digit — the
 * historical detector proves a duplicate by comparing a stored round against
 * the same identity the ingest gate would have computed. Numbers are therefore
 * formatted at a fixed scale rather than passed through as JS numbers or as
 * Postgres numeric text ("32.500" and 32.5 are the same quantity).
 */

import { createHash } from "node:crypto";
import { normalizedMarketLabel } from "@/lib/market";
import { normalizeUnitAlias } from "@/lib/parsers/weigh-session/units";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { baseTransactionType } from "@/lib/summary/transactions";

/** Quantities are numeric(_,3) in Postgres; prices numeric(_,2). */
const QUANTITY_SCALE = 3;
const PRICE_SCALE = 2;

/** One produce line, from either the parser or a persisted row. */
export interface BusinessItemInput {
  productName: string | null;
  unit: string | null;
  quantity: number | string | null;
  pricePerUnit: number | string | null;
  transactionType: string | null;
  basisQuantity?: number | string | null;
  basisUnit?: string | null;
  basisPrice?: number | string | null;
}

export interface BusinessContentInput {
  businessDate: string | null;
  sellerLabel: string | null;
  marketLabel: string | null;
  items: readonly BusinessItemInput[];
}

function decimal(value: number | string | null | undefined, scale: number): string {
  if (value === null || value === undefined || value === "") return "";
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "";
  const factor = 10 ** scale;
  return (Math.round(numeric * factor) / factor).toFixed(scale);
}

/** NFC + collapsed whitespace. The same shape accountability_round_normalize gives. */
export function normalizeSellerLabel(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * The market identity, falling back to the raw label when it cannot be resolved.
 *
 * `normalizedMarketLabel` answers "" for a title the market boundary does not
 * recognise, and two DIFFERENT unrecognised markets would then share one
 * identity — a false duplicate, which refuses legitimate business data. Falling
 * back to the trimmed raw label keeps them apart. It errs toward persisting,
 * which is the correct direction for a blocker.
 */
function marketIdentity(value: string | null | undefined): string {
  const normalized = normalizedMarketLabel(value);
  return normalized || (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * The accounting identity of a transaction type. เบิกเพิ่ม folds onto เบิก
 * exactly as the persisted `base_transaction_type` does, so an additional batch
 * and its equivalent main line describe the same business fact. An
 * unrecognised type is kept verbatim rather than guessed at.
 */
function canonicalTransactionType(value: string | null | undefined): string {
  const raw = (value ?? "").normalize("NFC").trim();
  return baseTransactionType(raw) ?? raw;
}

/**
 * One item as canonical business content.
 *
 * Product identity is `normalizeProductName` — the SAME canonicalization P4A
 * validates withdrawals against and the reports aggregate by. Nothing here
 * rewrites stored evidence; this string never leaves the hash.
 */
export function canonicalItemLine(item: BusinessItemInput): string {
  return [
    normalizeProductName((item.productName ?? "").normalize("NFC").trim()),
    normalizeUnitAlias((item.unit ?? "").normalize("NFC").trim()),
    decimal(item.quantity, QUANTITY_SCALE),
    decimal(item.pricePerUnit, PRICE_SCALE),
    decimal(item.basisQuantity, QUANTITY_SCALE),
    normalizeUnitAlias((item.basisUnit ?? "").normalize("NFC").trim()),
    decimal(item.basisPrice, PRICE_SCALE),
    canonicalTransactionType(item.transactionType),
  ].join("|");
}

/**
 * The sorted item multiset. Duplicates are kept — see the module note.
 * Exported because the composite detector needs the multiset itself, not only
 * its digest.
 */
export function canonicalItemLines(items: readonly BusinessItemInput[]): string[] {
  return items.map(canonicalItemLine).sort();
}

/** The canonical document, before hashing. Exported for test diagnostics. */
export function canonicalBusinessContent(input: BusinessContentInput): string {
  const transactionTypes = [
    ...new Set(input.items.map((item) => canonicalTransactionType(item.transactionType))),
  ].sort().join(",");

  return [
    input.businessDate ?? "",
    normalizeSellerLabel(input.sellerLabel),
    marketIdentity(input.marketLabel),
    transactionTypes,
    canonicalItemLines(input.items).join("\n"),
  ].join("||");
}

export function businessContentFingerprint(input: BusinessContentInput): string {
  return createHash("sha256")
    .update(canonicalBusinessContent(input), "utf8")
    .digest("hex");
}

function fromWeighItem(item: WeighSessionItem): BusinessItemInput {
  return {
    productName: item.product_name,
    unit: item.unit,
    quantity: item.quantity,
    pricePerUnit: item.price_per_unit,
    transactionType: item.transaction_type,
    basisQuantity: item.basis_quantity,
    basisUnit: item.basis_unit,
    basisPrice: item.basis_price,
  };
}

/** Write-path adapter: the fingerprint of a freshly parsed document. */
export function weighSessionBusinessFingerprint(parsed: WeighSession): string {
  return businessContentFingerprint({
    businessDate: parsed.date,
    sellerLabel: parsed.staff_name,
    marketLabel: parsed.session_title,
    items: parsed.items.map(fromWeighItem),
  });
}

export function weighSessionBusinessContent(parsed: WeighSession): string {
  return canonicalBusinessContent({
    businessDate: parsed.date,
    sellerLabel: parsed.staff_name,
    marketLabel: parsed.session_title,
    items: parsed.items.map(fromWeighItem),
  });
}
