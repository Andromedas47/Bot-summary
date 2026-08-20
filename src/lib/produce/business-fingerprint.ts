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
import {
  canonicalMarketLabel,
  normalizedMarketLabel,
  reviewedMarketSpellings,
} from "@/lib/market";
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
 * The fingerprint's market component, per generation. See the V0/V1/V2 note at
 * the bottom of this module.
 *
 * Both resolvers fall back to the trimmed raw label when the market boundary
 * does not recognise the title. Answering "" there would make two DIFFERENT
 * unrecognised markets share one identity — a false duplicate, which refuses
 * legitimate business data. The fallback errs toward persisting, which is the
 * correct direction for a blocker.
 */
type MarketResolver = (value: string | null | undefined) => string;

function rawLabel(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/** V1 — the PR #51 generation: the normalized raw label, aliases NOT folded. */
const v1MarketIdentity: MarketResolver = (value) =>
  normalizedMarketLabel(value) || rawLabel(value);

/**
 * V2 — current: the reviewed canonical market identity.
 *
 * Reviewed aliases resolve here for the same reason they resolve in
 * `accountability_round_same_market`: a spelling variant of one market is one
 * business identity, and it must not be able to buy itself a second
 * fingerprint. `พาซีโอ้` and `พาซิโอ้` are the same withdrawal.
 */
const marketIdentity: MarketResolver = (value) =>
  canonicalMarketLabel(value) || rawLabel(value);

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
 * The fingerprint's product/unit identity component, per reading. See the
 * alias-compatibility note above `weighSessionAliasCompatibilityFingerprints`.
 */
export interface ItemIdentityResolver {
  resolveProduct: (baseNormalized: string) => string;
  resolveUnit: (baseNormalized: string) => string;
}

/** Current — `normalizeProductName` / `normalizeUnitAlias`, aliases folded. */
const CURRENT_ITEM_IDENTITY: ItemIdentityResolver = {
  resolveProduct: (name) => normalizeProductName(name),
  resolveUnit: (unit) => normalizeUnitAlias(unit),
};

/**
 * Raw — no PRODUCT_ALIASES / UNIT_ALIASES applied at all, the base-normalized
 * text as-is. Reconstructs what an item would have canonicalized to before
 * whichever of today's alias entries affects it existed. LOOKUP only; see
 * `weighSessionAliasCompatibilityFingerprints`.
 */
const RAW_ITEM_IDENTITY: ItemIdentityResolver = {
  resolveProduct: (name) => name,
  resolveUnit: (unit) => unit,
};

/**
 * One item as canonical business content.
 *
 * Product identity is `normalizeProductName` — the SAME canonicalization P4A
 * validates withdrawals against and the reports aggregate by. Nothing here
 * rewrites stored evidence; this string never leaves the hash.
 *
 * `resolveItem` defaults to the current (alias-folded) reading, which is every
 * caller's identity today. `weighSessionAliasCompatibilityFingerprints` is the
 * only caller that passes `RAW_ITEM_IDENTITY`.
 */
export function canonicalItemLine(
  item: BusinessItemInput,
  resolveItem: ItemIdentityResolver = CURRENT_ITEM_IDENTITY,
): string {
  const productName = (item.productName ?? "").normalize("NFC").trim();
  const unit         = (item.unit ?? "").normalize("NFC").trim();
  const basisUnit    = (item.basisUnit ?? "").normalize("NFC").trim();
  return [
    resolveItem.resolveProduct(productName),
    resolveItem.resolveUnit(unit),
    decimal(item.quantity, QUANTITY_SCALE),
    decimal(item.pricePerUnit, PRICE_SCALE),
    decimal(item.basisQuantity, QUANTITY_SCALE),
    resolveItem.resolveUnit(basisUnit),
    decimal(item.basisPrice, PRICE_SCALE),
    canonicalTransactionType(item.transactionType),
  ].join("|");
}

/**
 * The sorted item multiset. Duplicates are kept — see the module note.
 * Exported because the composite detector needs the multiset itself, not only
 * its digest.
 */
export function canonicalItemLines(
  items: readonly BusinessItemInput[],
  resolveItem: ItemIdentityResolver = CURRENT_ITEM_IDENTITY,
): string[] {
  return items.map((item) => canonicalItemLine(item, resolveItem)).sort();
}

/** The canonical document, before hashing. Exported for test diagnostics. */
export function canonicalBusinessContent(
  input: BusinessContentInput,
  resolveMarket: MarketResolver = marketIdentity,
  resolveItem: ItemIdentityResolver = CURRENT_ITEM_IDENTITY,
): string {
  const transactionTypes = [
    ...new Set(input.items.map((item) => canonicalTransactionType(item.transactionType))),
  ].sort().join(",");

  return [
    input.businessDate ?? "",
    normalizeSellerLabel(input.sellerLabel),
    resolveMarket(input.marketLabel),
    transactionTypes,
    canonicalItemLines(input.items, resolveItem).join("\n"),
  ].join("||");
}

export function businessContentFingerprint(
  input: BusinessContentInput,
  resolveMarket: MarketResolver = marketIdentity,
  resolveItem: ItemIdentityResolver = CURRENT_ITEM_IDENTITY,
): string {
  return createHash("sha256")
    .update(canonicalBusinessContent(input, resolveMarket, resolveItem), "utf8")
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

function businessContentOf(parsed: WeighSession): BusinessContentInput {
  return {
    businessDate: parsed.date,
    sellerLabel: parsed.staff_name,
    marketLabel: parsed.session_title,
    items: parsed.items.map(fromWeighItem),
  };
}

/** Write-path adapter: the V2 fingerprint of a freshly parsed document. */
export function weighSessionBusinessFingerprint(parsed: WeighSession): string {
  return businessContentFingerprint(businessContentOf(parsed));
}

/**
 * The V1 fingerprints of the SAME business document — one per reviewed spelling
 * of its market other than the canonical one.
 *
 * Why this exists
 * ---------------
 * Three fingerprint generations have written `imported_sessions.session_hash`:
 *
 *   V0  pre-PR #51. The raw parsed strings, ordered by item number.
 *       `computeLegacySessionHash` in session-dedup-service.ts.
 *   V1  PR #51. Canonical business content — canonical product, canonical unit,
 *       the item multiset, base transaction types — but the market component is
 *       the NORMALIZED RAW LABEL, with no reviewed alias folding.
 *   V2  PR #53, current. The same business content with the REVIEWED CANONICAL
 *       market identity.
 *
 * Only V2 is ever written as a session's identity. But Production already holds
 * V1 rows — seller ต้อม, market พาซีโอ้, 2026-08-15 among them — and after V2
 * ships, a resend of that document canonicalizes to พาซิโอ้ and hashes
 * differently. Without this set the duplicate blocker would not recognise its
 * own recent history, and the document would persist twice.
 *
 * The set is the reviewed equivalence class and nothing wider: for canonical
 * `พาซิโอ้` it covers exactly `พาซีโอ้` and `พาสิโอ้`. An unreviewed near-miss
 * such as `พาชิโอ้` is its own market here, exactly as it is everywhere else,
 * so unrelated markets can never share a hash. A market with no reviewed
 * aliases, or a title the market boundary cannot read at all, produces an empty
 * set — its V1 and V2 hashes are already identical.
 */
export function weighSessionCompatibilityFingerprints(parsed: WeighSession): string[] {
  return marketSpellingFingerprintsFor(parsed, CURRENT_ITEM_IDENTITY);
}

/**
 * `weighSessionCompatibilityFingerprints`, parameterized over the item
 * identity reading. Shared by the V1 market-alias set (current item identity
 * — reservations) and `weighSessionAliasCompatibilityFingerprints` (raw item
 * identity — lookup only), so the two never drift apart on how a market
 * spelling equivalence class is walked.
 */
function marketSpellingFingerprintsFor(
  parsed: WeighSession,
  resolveItem: ItemIdentityResolver,
): string[] {
  const canonical = canonicalMarketLabel(parsed.session_title);
  if (!canonical) return [];

  const seen = new Set<string>([
    businessContentFingerprint(businessContentOf(parsed), marketIdentity, resolveItem),
  ]);
  const compatibility: string[] = [];
  for (const spelling of reviewedMarketSpellings(canonical)) {
    const hash = weighSessionLegacyMarketFingerprint(parsed, spelling, resolveItem);
    if (seen.has(hash)) continue;
    seen.add(hash);
    compatibility.push(hash);
  }
  return compatibility;
}

/**
 * The V1 fingerprint of this document — the PR #51 generation, whose market
 * component is the raw normalized label.
 *
 * `spelling` reproduces the hash the PR #51 code WOULD have written had the
 * header carried that market label instead. That is faithful because V1's
 * market component was `normalizedMarketLabel(session_title)`, which for a
 * header naming `spelling` is `spelling` itself.
 *
 * Exported so the regression tests can seed `imported_sessions` with genuine
 * previous-generation hashes rather than with hand-copied constants.
 */
export function weighSessionLegacyMarketFingerprint(
  parsed: WeighSession,
  spelling?: string,
  resolveItem: ItemIdentityResolver = CURRENT_ITEM_IDENTITY,
): string {
  return businessContentFingerprint(
    businessContentOf(parsed),
    spelling === undefined ? v1MarketIdentity : () => spelling,
    resolveItem,
  );
}

/**
 * Product/unit alias compatibility — the LOOKUP-only counterpart of
 * `weighSessionCompatibilityFingerprints`, for `normalizeProductName` /
 * `normalizeUnitAlias` instead of the market resolver.
 *
 * The gap
 * -------
 * `canonicalItemLine` folds PRODUCT_ALIASES / UNIT_ALIASES (remaining-fruit.ts
 * and units.ts respectively) into every V1/V2 hash, at WHATEVER state that
 * alias table is in when the hash is computed. Unlike the market registry,
 * which has always had a reviewed equivalence class and a compatibility layer
 * (above), product and unit aliases never did — see the ไชมัส entry in
 * remaining-fruit.ts, which named this exact gap in place and deferred
 * closing it to "its own change, covering the whole map". This is that
 * change.
 *
 * A document recorded before an alias entry existed hashed under the RAW
 * (base-normalized only) spelling. Once the alias lands, recomputing that
 * SAME raw text folds it to the alias's target, and the hash no longer
 * matches the historical row.
 *
 * What this reconstructs, and why callers pass TWO different readings
 * ----------------------------------------------------------------------
 * This function always bypasses BOTH product and unit alias folding
 * (`RAW_ITEM_IDENTITY`) — but which reading of `parsed` it needs to run
 * against differs by axis, because product and unit are resolved at
 * different pipeline stages:
 *
 *   product   `item.product_name` is untouched raw text all the way to hash
 *             time — `canonicalItemLine` is the only place PRODUCT_ALIASES is
 *             ever applied. So calling this directly on `parsed` already
 *             reconstructs the pre-alias reading.
 *
 *   unit      `item.unit` is ALREADY canonical by the time anything past the
 *             PARSER sees it — parser.ts applies `normalizeUnitAlias` while
 *             building the item, so `RAW_ITEM_IDENTITY` on `parsed` directly
 *             changes nothing (it bypasses a fold that already happened).
 *             `duplicateLookupCandidates` instead calls this on
 *             `legacyUnitAliasSession(parsed)` — the item, with `unit` put
 *             back to the RAW token the operator typed, from
 *             `legacy_unit_alias_raw` (types.ts). That field only exists
 *             because the parser captured it at the one moment the raw
 *             spelling was still available.
 *
 * A document needing BOTH reverted at once is covered too:
 * `legacyUnitAliasSession` only touches `unit`, so `product_name` in that
 * reading is still the untouched raw text, and running THIS function against
 * it bypasses both.
 *
 * Every reading is also crossed with every market spelling
 * `weighSessionCompatibilityFingerprints` already covers, so a document that
 * predates a product/unit alias AND a market alias is still recognised in one
 * lookup. Returns `[]` for a reading nothing here touches (the common case),
 * so a document nothing here touches costs nothing extra to look up.
 *
 * Known limit, matching the one legacySubunitPricedSession accepts: the
 * product axis is all-or-nothing across every affected item in one reading —
 * a document where item A's alias existed at import time but item B's did
 * not is not reconstructed exactly. No per-alias "added on" date is tracked
 * anywhere in this codebase, so an exact reconstruction is not possible; this
 * bounds the gap instead of leaving it wide open. LOOKUP only — see
 * `duplicateLookupCandidates` in session-dedup-service.ts. Never reserved: a
 * new document must never claim identity under an alias table it does not
 * believe in any more.
 */
export function weighSessionAliasCompatibilityFingerprints(parsed: WeighSession): string[] {
  const content = businessContentOf(parsed);
  const currentLines = canonicalItemLines(content.items, CURRENT_ITEM_IDENTITY).join("\n");
  const rawLines = canonicalItemLines(content.items, RAW_ITEM_IDENTITY).join("\n");
  if (currentLines === rawLines) return [];

  const seen = new Set<string>([
    businessContentFingerprint(content, marketIdentity, CURRENT_ITEM_IDENTITY),
    ...marketSpellingFingerprintsFor(parsed, CURRENT_ITEM_IDENTITY),
  ]);
  const compatibility: string[] = [];
  for (const hash of [
    businessContentFingerprint(content, marketIdentity, RAW_ITEM_IDENTITY),
    ...marketSpellingFingerprintsFor(parsed, RAW_ITEM_IDENTITY),
  ]) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    compatibility.push(hash);
  }
  return compatibility;
}

/**
 * The canonical item multiset of a PLAIN base withdrawal, or null.
 *
 * This is the containment guard's comparison key (migration
 * 20260817090100). It is deliberately the SAME per-item canonicalization the
 * fingerprint hashes — `canonicalItemLine` — so a document that is a strict
 * superset of an already-recorded one is recognised by exactly the identity
 * that decided the two were not equal.
 *
 * Null for anything that is not a plain base withdrawal:
 *
 *   an additional batch (`เบิกเพิ่ม`) is an INTENTIONAL append, and a seller
 *   who genuinely withdraws a second identical batch says so with that
 *   contract. Guarding it would refuse real business data.
 *
 *   a return or damaged return is not a withdrawal at all.
 *
 *   a mixed document does not describe one withdrawal, so containment against
 *   another document's withdrawal rows would not be a like-for-like comparison.
 *
 * Null means "not comparable" on both sides of the guard: such a session is
 * neither checked nor stored as a candidate.
 */
export function canonicalWithdrawalItemLines(parsed: WeighSession): string[] | null {
  if (parsed.session_kind !== "main") return null;
  if (parsed.items.length === 0) return null;
  const allWithdrawals = parsed.items.every(
    (item) => baseTransactionType(item.transaction_type) === "เบิก",
  );
  if (!allWithdrawals) return null;
  return canonicalItemLines(parsed.items.map(fromWeighItem));
}

/**
 * True when every canonical line of `subset` occurs in `superset` at least as
 * many times. Order-insensitive, multiplicity-preserving, exact — the mirror of
 * `produce_item_multiset_contains` in SQL.
 */
export function canonicalItemMultisetContains(
  superset: readonly string[],
  subset: readonly string[],
): boolean {
  const counts = new Map<string, number>();
  for (const line of superset) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of subset) {
    const remaining = counts.get(line) ?? 0;
    if (remaining === 0) return false;
    counts.set(line, remaining - 1);
  }
  return true;
}

export function weighSessionBusinessContent(parsed: WeighSession): string {
  return canonicalBusinessContent({
    businessDate: parsed.date,
    sellerLabel: parsed.staff_name,
    marketLabel: parsed.session_title,
    items: parsed.items.map(fromWeighItem),
  });
}
