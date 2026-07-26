import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { baseTransactionType } from "@/lib/summary/transactions";
import { resolveUnitQuantity } from "@/lib/parsers/weigh-session/units";
import { centralPriceMapKey } from "@/lib/white-sheet/pricing";

/**
 * P1 Daily Sales — the pure calculator.
 *
 * It answers exactly four questions for one business date: how much product was
 * sold, what that is worth at the central selling price, per market / per
 * product / across all markets, and which of those results cannot be trusted.
 *
 * It is NOT cash, slips, transfers, reconciliation, purchase, cost or profit.
 * Nothing in this file may read daily_summaries, settlement or slip data, and
 * expected sales is never derived from a White Sheet cash composition.
 *
 * Per market / product / unit:
 *
 *   sold_quantity  = W − R − D          (withdrawal − good return − damaged return)
 *   expected_sales = sold_quantity × authoritative central selling price
 *
 * FAIL CLOSED. Every rule below blocks rather than guesses:
 *   - a withdrawal with no good-return evidence is NOT "sold out"
 *   - a return with no withdrawal is not a negative sale
 *   - R + D > W is not a negative quantity
 *   - structurally invalid rows never contribute a number
 *   - trusted quantity with no resolvable central price yields no value
 *
 * Precision: quantity is carried as integer milli-units (3 dp, the canonical
 * quantity precision) and money as integer satang. Each atomic market/product/
 * unit row rounds half-up to satang ONCE, and every total is an integer sum of
 * those satang — so a displayed market total, product total and all-market
 * total always reconcile exactly with the rows above them.
 */

const QUANTITY_SCALE_PER_UNIT = BigInt(1000);
const SATANG_PER_BAHT = 100;

/** Separator for the composite market key — same construction as the White Sheet scope key. */
const MARKET_KEY_SEPARATOR = "\u0001";

export type SalesRowStatus = "TRUSTED" | "VALUE_BLOCKED" | "QUANTITY_BLOCKED";

/**
 * Why a row (or the whole scope) is not trusted. Ordered by how it is produced:
 * structural, then quantity evidence, then session integrity, then price.
 */
export type SalesBlockReason =
  | "invalid_identity"
  | "invalid_quantity"
  | "unknown_transaction_type"
  | "market_unresolved"
  | "missing_return_evidence"
  | "return_without_withdrawal"
  | "returns_exceed_withdrawal"
  | "duplicate_main_session"
  | "session_parser_errors"
  | "session_item_count_mismatch"
  | "missing_central_price"
  | "central_price_conflict";

export type SalesScopeBlockerKind =
  | "unresolved_pending_session"
  | "message_parser_error";

export interface SalesScopeBlocker {
  kind: SalesScopeBlockerKind;
  /** How many occurrences — the report states the count, never a guess at impact. */
  count: number;
}

/**
 * One persisted produce transaction, already adapted from produce_transactions
 * by the loader. Identity resolution (source, market label, canonical product,
 * canonical unit) happens here so it can be unit-tested without a database.
 */
export interface SalesSourceRow {
  /**
   * LINE source that owns the session. Null when it could not be resolved —
   * the row is then keyed by session and blocked, never merged into a market.
   */
  sourceId: string | null;
  /** Raw session title; display label only, never an identity on its own. */
  marketName: string | null;
  sessionId: string;
  /** "main" | "additional" — additional sessions are additive, never duplicates. */
  sessionKind: string;
  productName: string;
  unit: string | null;
  quantity: number | null;
  transactionType: string;
  /** Session-level integrity findings from the loader (parser errors, item-count mismatch). */
  sessionIssues?: readonly SalesBlockReason[];
}

export interface SalesCalculationInput {
  businessDate: string;
  rows: readonly SalesSourceRow[];
  /** Central selling price in satang, keyed by centralPriceMapKey(productKey, unitKey). */
  centralPrices?: ReadonlyMap<string, number>;
  /** Identities whose central price is disputed and not yet admin-resolved. */
  priceConflicts?: ReadonlySet<string>;
  /** Integrity problems that cannot be attributed to one market. */
  scopeBlockers?: readonly SalesScopeBlocker[];
}

/** One atomic market + product + unit result — the only place a number is computed. */
export interface SalesIdentityRow {
  marketKey: string;
  /** Display label. Carries a short source suffix when one label spans several sources. */
  marketLabel: string;
  sourceId: string | null;
  businessDate: string;
  productName: string;
  unit: string;
  withdrawnQuantity: number;
  goodReturnQuantity: number;
  damagedReturnQuantity: number;
  /** null whenever the quantity itself is blocked — never a substituted zero. */
  soldQuantity: number | null;
  centralPriceSatang: number | null;
  expectedSalesSatang: number | null;
  status: SalesRowStatus;
  reasons: SalesBlockReason[];
}

/**
 * A subtotal plus the only thing that makes it safe to read: whether every
 * identity behind it is trusted. `expectedSalesSatang` sums TRUSTED rows only,
 * so a non-authoritative total is a confirmed-partial figure — it must never be
 * presented as total sales.
 */
export interface SalesTotal {
  expectedSalesSatang: number;
  authoritative: boolean;
  trustedRowCount: number;
  blockedRowCount: number;
}

export interface SalesMarketSummary {
  marketKey: string;
  marketLabel: string;
  rows: SalesIdentityRow[];
  total: SalesTotal;
}

export interface SalesProductMarketBreakdown {
  marketKey: string;
  marketLabel: string;
  soldQuantity: number;
  expectedSalesSatang: number;
}

export interface SalesProductSummary {
  productName: string;
  unit: string;
  /** Summed over TRUSTED identities only. */
  soldQuantity: number;
  markets: SalesProductMarketBreakdown[];
  total: SalesTotal;
}

export interface SalesReport {
  businessDate: string;
  markets: SalesMarketSummary[];
  products: SalesProductSummary[];
  allMarkets: SalesTotal;
  /** Every non-TRUSTED identity, in full. Never sampled, never truncated. */
  blocked: SalesIdentityRow[];
  scopeBlockers: SalesScopeBlocker[];
}

export function salesMarketKey(sourceId: string, marketLabel: string): string {
  return `${sourceId}${MARKET_KEY_SEPARATOR}${marketLabel}`;
}

/** Key for a row whose market cannot be resolved: the session stands alone. */
function unresolvedMarketKey(sessionId: string): string {
  return `session${MARKET_KEY_SEPARATOR}${sessionId}`;
}

export function satangToBahtText(satang: number): string {
  const negative = satang < 0;
  const absolute = Math.abs(satang);
  const baht = Math.trunc(absolute / SATANG_PER_BAHT);
  const remainder = absolute % SATANG_PER_BAHT;
  const grouped = baht.toLocaleString("en-US");
  return `${negative ? "-" : ""}${grouped}.${String(remainder).padStart(2, "0")}`;
}

/** Half-up division of a non-negative bigint — the single rounding rule for money. */
function roundHalfUp(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder * BigInt(2) >= divisor ? quotient + BigInt(1) : quotient;
}

/**
 * Decimal → integer milli-units with no float arithmetic, so 0.1 + 0.2 style
 * drift can never reach a reported quantity. Returns null for anything that is
 * not a finite non-negative number — the caller then blocks the identity.
 */
function toMilliQuantity(value: number): bigint | null {
  if (!Number.isFinite(value) || value < 0) return null;

  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const unscaled = BigInt(digits);
  const decimalPlaces = fraction.length - exponent;
  const shift = 3 - decimalPlaces;
  if (shift >= 0) return unscaled * BigInt(10) ** BigInt(shift);
  return roundHalfUp(unscaled, BigInt(10) ** BigInt(-shift));
}

function fromMilliQuantity(value: bigint): number {
  return Number(value) / 1000;
}

interface IdentityAggregate {
  marketKey: string;
  marketLabel: string;
  sourceId: string | null;
  productName: string;
  unit: string;
  withdrawn: bigint;
  goodReturn: bigint;
  damaged: bigint;
  hasWithdrawal: boolean;
  hasGoodReturn: boolean;
  hasDamaged: boolean;
  reasons: Set<SalesBlockReason>;
}

function addReason(target: Set<SalesBlockReason>, reason: SalesBlockReason): void {
  target.add(reason);
}

/**
 * Canonical product name for aggregation.
 *
 * Reuses the deployed P0 alias map and its two-pass "เพิ่ม" handling, so a
 * legitimate additional-session line lands in the same identity as the main
 * session it adds to. No fuzzy matching is introduced here; anything the alias
 * map does not explicitly cover stays a separate product and is reported as its
 * own line.
 */
function canonicalProduct(rawName: string, knownNames: ReadonlySet<string>): string {
  return normalizeProductName(rawName, undefined, knownNames);
}

/**
 * The set of already-aliased names present in the day's data, used to authorize
 * "เพิ่ม" prefix stripping. Identical construction to buildRemainingFruitReport.
 */
function knownProductNames(rows: readonly SalesSourceRow[]): Set<string> {
  return new Set(
    rows.map((row) => normalizeProductName(row.productName.normalize("NFC").replace(/\s+/g, " ").trim())),
  );
}

/**
 * Display labels for markets.
 *
 * The audit finding is that the same (or a similar) market label appears under
 * more than one LINE source and there is no authoritative market registry. The
 * identity is therefore always (source + label) — two sources are never merged.
 * When one label really does span several sources, the display label gets a
 * short source suffix so a human can tell the two apart, exactly as the White
 * Sheet market-scope selector does.
 */
function resolveDisplayLabels(aggregates: readonly IdentityAggregate[]): void {
  const sourcesByLabel = new Map<string, Set<string>>();
  for (const aggregate of aggregates) {
    if (!aggregate.sourceId) continue;
    const sources = sourcesByLabel.get(aggregate.marketLabel) ?? new Set<string>();
    sources.add(aggregate.sourceId);
    sourcesByLabel.set(aggregate.marketLabel, sources);
  }

  for (const aggregate of aggregates) {
    if (!aggregate.sourceId) continue;
    if ((sourcesByLabel.get(aggregate.marketLabel)?.size ?? 0) > 1) {
      aggregate.marketLabel = `${aggregate.marketLabel} · …${aggregate.sourceId.slice(-6)}`;
    }
  }
}

/**
 * Markets holding more than one ACTIVE main session of the same effective
 * transaction type.
 *
 * Production has no unambiguous authoritative resolution for this (the White
 * Sheet only warns), so P1 fails closed: every identity in such a market is
 * quantity-blocked. Voided sessions never reach here — produce_transactions is
 * already void-filtered — and additional (ชุดเพิ่ม) sessions are additive by
 * design and are excluded from the check.
 */
function duplicateMainSessionMarkets(rows: readonly SalesSourceRow[]): Set<string> {
  const sessionsByMarketAndType = new Map<string, { marketKey: string; sessions: Set<string> }>();

  for (const row of rows) {
    if (row.sessionKind === "additional") continue;
    const type = baseTransactionType(row.transactionType);
    if (!type) continue;
    const marketKey = rowMarketKey(row);
    const key = `${marketKey}${MARKET_KEY_SEPARATOR}${type}`;
    const entry = sessionsByMarketAndType.get(key) ?? { marketKey, sessions: new Set<string>() };
    entry.sessions.add(row.sessionId);
    sessionsByMarketAndType.set(key, entry);
  }

  const blocked = new Set<string>();
  for (const entry of sessionsByMarketAndType.values()) {
    if (entry.sessions.size > 1) blocked.add(entry.marketKey);
  }
  return blocked;
}

/**
 * Session-level integrity findings, widened to every market the broken session
 * touched.
 *
 * Blocking only the identities that carry a row from that session is not
 * enough: the failure mode is a line that never made it into the data at all.
 * A return line dropped by the parser can leave a sibling product looking
 * complete — withdrawal present, return present, sold quantity plausible — when
 * the real return was larger. The market is the smallest scope that provably
 * contains the damage, so that is what gets blocked.
 */
function marketIssuesFromSessions(
  rows: readonly SalesSourceRow[],
): Map<string, Set<SalesBlockReason>> {
  const byMarket = new Map<string, Set<SalesBlockReason>>();

  for (const row of rows) {
    if (!row.sessionIssues || row.sessionIssues.length === 0) continue;
    const marketKey = rowMarketKey(row);
    const reasons = byMarket.get(marketKey) ?? new Set<SalesBlockReason>();
    for (const issue of row.sessionIssues) reasons.add(issue);
    byMarket.set(marketKey, reasons);
  }

  return byMarket;
}

function emptyTotal(): SalesTotal {
  return {
    expectedSalesSatang: 0,
    authoritative: true,
    trustedRowCount: 0,
    blockedRowCount: 0,
  };
}

function accumulate(total: SalesTotal, row: SalesIdentityRow): void {
  if (row.status === "TRUSTED") {
    total.expectedSalesSatang += row.expectedSalesSatang ?? 0;
    total.trustedRowCount += 1;
    return;
  }
  total.blockedRowCount += 1;
  total.authoritative = false;
}

/**
 * Market label used for identity. `cleanMarketName` is deliberately NOT applied
 * here: the loader already resolved the canonical label (or decided the market
 * is unresolvable), and re-deriving it in a second place is how two paths drift.
 */
function identityLabel(marketName: string | null): string {
  return (marketName ?? "").normalize("NFC").trim();
}

/** True only when BOTH halves of the market identity are present. */
function isMarketResolved(row: SalesSourceRow): boolean {
  return Boolean(row.sourceId) && identityLabel(row.marketName).length > 0;
}

/**
 * The one derivation of a row's market key. The duplicate-session scan and the
 * aggregation loop must agree exactly, or a duplicate could be detected against
 * a key no identity is ever filed under.
 */
function rowMarketKey(row: SalesSourceRow): string {
  return isMarketResolved(row)
    ? salesMarketKey(row.sourceId as string, identityLabel(row.marketName))
    : unresolvedMarketKey(row.sessionId);
}

export function calculateSalesReport(input: SalesCalculationInput): SalesReport {
  const businessDate = input.businessDate;
  const centralPrices = input.centralPrices ?? new Map<string, number>();
  const priceConflicts = input.priceConflicts ?? new Set<string>();
  const scopeBlockers = [...(input.scopeBlockers ?? [])];
  const knownNames = knownProductNames(input.rows);
  const duplicateMarkets = duplicateMainSessionMarkets(input.rows);
  const marketIssues = marketIssuesFromSessions(input.rows);

  const aggregates = new Map<string, IdentityAggregate>();

  for (const row of input.rows) {
    const label = identityLabel(row.marketName);
    const marketResolved = isMarketResolved(row);
    const marketKey = rowMarketKey(row);

    const rawProduct = row.productName?.normalize("NFC").trim() ?? "";
    const rawUnit = row.unit?.normalize("NFC").trim() ?? "";
    const bucket = baseTransactionType(row.transactionType);

    // Identity fields must be usable before anything can be grouped. A row with
    // no product or no unit is reported under whatever it does have rather than
    // being silently dropped, and its identity is blocked.
    const productName = rawProduct ? canonicalProduct(rawProduct, knownNames) : "(ไม่ระบุสินค้า)";
    const milliQuantity = row.quantity === null ? null : toMilliQuantity(row.quantity);
    const conversion = rawUnit && milliQuantity !== null
      ? resolveUnitQuantity(fromMilliQuantity(milliQuantity), rawUnit)
      : null;
    const unit = conversion ? conversion.unit : rawUnit || "(ไม่ระบุหน่วย)";

    const key = `${marketKey}${MARKET_KEY_SEPARATOR}${productName}${MARKET_KEY_SEPARATOR}${unit}`;
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        marketKey,
        marketLabel: marketResolved ? label : "",
        sourceId: marketResolved ? (row.sourceId as string) : null,
        productName,
        unit,
        withdrawn: BigInt(0),
        goodReturn: BigInt(0),
        damaged: BigInt(0),
        hasWithdrawal: false,
        hasGoodReturn: false,
        hasDamaged: false,
        reasons: new Set<SalesBlockReason>(),
      };
      aggregates.set(key, aggregate);
    }

    for (const issue of marketIssues.get(marketKey) ?? []) addReason(aggregate.reasons, issue);
    if (!marketResolved) addReason(aggregate.reasons, "market_unresolved");
    if (duplicateMarkets.has(marketKey)) addReason(aggregate.reasons, "duplicate_main_session");
    if (!rawProduct || !rawUnit) addReason(aggregate.reasons, "invalid_identity");
    if (!bucket) addReason(aggregate.reasons, "unknown_transaction_type");
    if (milliQuantity === null) addReason(aggregate.reasons, "invalid_quantity");

    if (!bucket || milliQuantity === null || !conversion) continue;

    // The converted quantity is re-scaled to milli-units: a conversion (ขีด → โล)
    // may introduce a fourth decimal, and 3 dp is the canonical precision.
    const converted = toMilliQuantity(conversion.quantity);
    if (converted === null) {
      addReason(aggregate.reasons, "invalid_quantity");
      continue;
    }

    if (bucket === "เบิก") {
      aggregate.withdrawn += converted;
      aggregate.hasWithdrawal = true;
    } else if (bucket === "คืน") {
      aggregate.goodReturn += converted;
      aggregate.hasGoodReturn = true;
    } else {
      aggregate.damaged += converted;
      aggregate.hasDamaged = true;
    }
  }

  const aggregateList = [...aggregates.values()];
  resolveDisplayLabels(aggregateList);

  const identityRows: SalesIdentityRow[] = aggregateList.map((aggregate) => {
    const reasons = new Set(aggregate.reasons);

    // Quantity evidence rules. A withdrawal with no ชั่งคืน is never "sold out",
    // a return with no withdrawal is never a negative sale, and returns that
    // exceed the withdrawal are never a negative quantity.
    if (aggregate.hasWithdrawal && !aggregate.hasGoodReturn) {
      addReason(reasons, "missing_return_evidence");
    }
    if (!aggregate.hasWithdrawal && (aggregate.hasGoodReturn || aggregate.hasDamaged)) {
      addReason(reasons, "return_without_withdrawal");
    }
    if (aggregate.goodReturn + aggregate.damaged > aggregate.withdrawn) {
      addReason(reasons, "returns_exceed_withdrawal");
    }

    const quantityBlocked = reasons.size > 0;
    const priceKey = centralPriceMapKey(aggregate.productName, aggregate.unit);
    const sold = aggregate.withdrawn - aggregate.goodReturn - aggregate.damaged;

    let centralPriceSatang: number | null = null;
    let expectedSalesSatang: number | null = null;
    let status: SalesRowStatus = "TRUSTED";

    if (quantityBlocked) {
      status = "QUANTITY_BLOCKED";
    } else if (priceConflicts.has(priceKey)) {
      addReason(reasons, "central_price_conflict");
      status = "VALUE_BLOCKED";
    } else {
      const price = centralPrices.get(priceKey);
      if (price === undefined) {
        addReason(reasons, "missing_central_price");
        status = "VALUE_BLOCKED";
      } else {
        centralPriceSatang = price;
        expectedSalesSatang = Number(
          roundHalfUp(sold * BigInt(price), QUANTITY_SCALE_PER_UNIT),
        );
      }
    }

    return {
      marketKey: aggregate.marketKey,
      marketLabel: aggregate.marketLabel,
      sourceId: aggregate.sourceId,
      businessDate,
      productName: aggregate.productName,
      unit: aggregate.unit,
      withdrawnQuantity: fromMilliQuantity(aggregate.withdrawn),
      goodReturnQuantity: fromMilliQuantity(aggregate.goodReturn),
      damagedReturnQuantity: fromMilliQuantity(aggregate.damaged),
      soldQuantity: quantityBlocked ? null : fromMilliQuantity(sold),
      centralPriceSatang,
      expectedSalesSatang,
      status,
      reasons: [...reasons],
    };
  });

  // An integrity problem that cannot be attributed to one market (an unresolved
  // pending session, a crashed parse) means data may be missing from ANY market,
  // so it demotes every total in the scope rather than only the all-market one.
  const scopeTrusted = scopeBlockers.length === 0;

  const marketMap = new Map<string, SalesMarketSummary>();
  const productMap = new Map<string, SalesProductSummary>();
  const allMarkets = emptyTotal();

  for (const row of identityRows) {
    let market = marketMap.get(row.marketKey);
    if (!market) {
      market = {
        marketKey: row.marketKey,
        marketLabel: row.marketLabel,
        rows: [],
        total: emptyTotal(),
      };
      marketMap.set(row.marketKey, market);
    }
    market.rows.push(row);
    accumulate(market.total, row);
    accumulate(allMarkets, row);

    const productKey = `${row.productName}${MARKET_KEY_SEPARATOR}${row.unit}`;
    let product = productMap.get(productKey);
    if (!product) {
      product = {
        productName: row.productName,
        unit: row.unit,
        soldQuantity: 0,
        markets: [],
        total: emptyTotal(),
      };
      productMap.set(productKey, product);
    }
    accumulate(product.total, row);
    // Only TRUSTED identities contribute, including to the sold quantity — a
    // VALUE_BLOCKED row has a trustworthy quantity, but mixing it in would
    // produce a line whose quantity and value describe different sets of rows.
    // Its quantity is still shown in full on the market detail and in the
    // blocked list, so nothing is hidden by leaving it out of the roll-up.
    if (row.status === "TRUSTED") {
      product.soldQuantity += row.soldQuantity ?? 0;
      product.markets.push({
        marketKey: row.marketKey,
        marketLabel: row.marketLabel,
        soldQuantity: row.soldQuantity ?? 0,
        expectedSalesSatang: row.expectedSalesSatang ?? 0,
      });
    }
  }

  if (!scopeTrusted) {
    allMarkets.authoritative = false;
    for (const market of marketMap.values()) market.total.authoritative = false;
    for (const product of productMap.values()) product.total.authoritative = false;
  }

  const markets = [...marketMap.values()]
    .map((market) => ({ ...market, rows: market.rows.sort(compareIdentityRows) }))
    .sort((a, b) => a.marketLabel.localeCompare(b.marketLabel, "th") || a.marketKey.localeCompare(b.marketKey));

  const products = [...productMap.values()]
    .map((product) => ({
      ...product,
      soldQuantity: Math.round(product.soldQuantity * 1000) / 1000,
      markets: product.markets.sort((a, b) => a.marketLabel.localeCompare(b.marketLabel, "th")),
    }))
    .sort(
      (a, b) =>
        a.productName.localeCompare(b.productName, "th") || a.unit.localeCompare(b.unit, "th"),
    );

  return {
    businessDate,
    markets,
    products,
    allMarkets,
    blocked: identityRows.filter((row) => row.status !== "TRUSTED").sort(compareIdentityRows),
    scopeBlockers,
  };
}

function compareIdentityRows(a: SalesIdentityRow, b: SalesIdentityRow): number {
  return (
    a.marketLabel.localeCompare(b.marketLabel, "th") ||
    a.productName.localeCompare(b.productName, "th") ||
    a.unit.localeCompare(b.unit, "th")
  );
}
