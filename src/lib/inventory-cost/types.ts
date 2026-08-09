/**
 * P2D inventory cost valuation — service contract types.
 *
 * This is the append-only VALUE record for stock, layered additively on top of
 * the 0053 quantity ledger (see ../inventory-ledger). It carries no quantity of
 * its own: every cost line points at a 0053 ledger line for its quantity, so
 * quantity and value cannot diverge by construction. See docs/p2d-actual-cost.md
 * for the frozen costing rules this module implements.
 *
 * ── Numeric transport rule ──────────────────────────────────────────────────
 * Every satang amount and every unit cost is exact numeric in PostgreSQL
 * (numeric(24,0) for signed_value_satang, numeric(40,10) for unit cost rates,
 * numeric(18,6) for the quantities carried alongside them) and would lose
 * precision the moment it passed through a JS double. The RPCs already return
 * every one of these as TEXT for exactly that reason. Nothing in this module
 * may grow a `number`-typed money or quantity field — every amount crosses the
 * TypeScript boundary as a decimal STRING, full stop:
 *   * signedValueSatang        -> decimal string, may be negative, zero is legal
 *   * unitCostSatangSnapshot   -> decimal string or null, audit-only, never summed
 *   * quantityBalance          -> decimal string, may be negative or zero
 *   * valueBalanceSatang       -> decimal string, may be negative or zero
 *   * averageUnitCostSatang    -> decimal string or null (null when quantity is zero)
 *
 * ── No stored average ────────────────────────────────────────────────────────
 * Average unit cost is derived at read time only (value_balance / quantity_balance)
 * and never persisted. Nothing here should cache or recompute it client-side.
 */

/** Cost event classes 0054 can write. Matches the migration's CHECK list exactly. */
export const INVENTORY_COST_EVENT_TYPES = [
  "PURCHASE_RECEIPT",
  "ISSUE",
  "GOOD_RETURN",
  "DAMAGED_WRITE_OFF",
  "ADJUSTMENT",
  "REVERSAL",
] as const;
export type InventoryCostEventType = (typeof INVENTORY_COST_EVENT_TYPES)[number];

/** Valuation bases 0054 can write. Matches the migration's CHECK list exactly. */
export const INVENTORY_COST_VALUATION_BASES = [
  "SOURCE_UNIT_COST",
  "MOVING_AVERAGE",
  "SOURCE_ISSUE_SNAPSHOT",
  "EXACT_NEGATION",
] as const;
export type InventoryCostValuationBasis = (typeof INVENTORY_COST_VALUATION_BASES)[number];

/** One valued line, bound 1:1 to a 0053 inventory_movement_lines row. */
export interface InventoryCostLine {
  movementLineId: string;
  /** Exact numeric(24,0) satang, as a decimal string. May be negative; zero is legal (free goods). */
  signedValueSatang: string;
  /** Audit-only derived rate. Never read back by any calculation. */
  unitCostSatangSnapshot: string | null;
  /** Good-return provenance: the issue cost line this line's value was restored from. */
  sourceCostLineId: string | null;
}

/** Result of posting (or replaying) a cost movement. */
export interface InventoryCostPostingResult {
  costMovementId: string;
  movementId: string;
  costEventType: InventoryCostEventType;
  valuationBasis: InventoryCostValuationBasis;
  dedupeKey: string;
  /** Number of cost lines written. DB-bounded to <= 500. */
  lineCount: number;
  /** True when this call replayed an existing cost movement and wrote nothing. */
  replayed: boolean;
  lines: InventoryCostLine[];
}

/** One derived value balance row. */
export interface InventoryCostBalance {
  locationCode: string;
  productKey: string;
  unitKey: string;
  /** Exact decimal string. May be negative or zero. */
  quantityBalance: string;
  /** Exact decimal string. May be negative or zero. */
  valueBalanceSatang: string;
  /** Derived at read time; null when quantityBalance is zero rather than divided. */
  averageUnitCostSatang: string | null;
}

export interface InventoryCostBalanceQuery {
  locationCode?: string | null;
  productKey?: string | null;
  unitKey?: string | null;
  /** Zero balances are omitted unless this is explicitly true. */
  includeZero?: boolean;
}
