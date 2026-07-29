/**
 * P2C inventory movement ledger — service contract types.
 *
 * The ledger is the authoritative QUANTITY record for stock. It carries no
 * monetary value at all: valuation, landed cost and COGS are P2D / migration
 * 0054, and nothing in this module should grow a price field.
 *
 * ── Numeric transport rule ──────────────────────────────────────────────────
 * Quantities are exact numeric(18,6) in PostgreSQL and would lose precision as
 * JS numbers, so they cross this boundary as decimal STRINGS:
 *   * signedQuantity   -> decimal string, may be negative, never "0"
 *   * quantityBalance  -> decimal string, may be negative or zero
 * Only genuinely small, DB-bounded integers stay `number`: lineCount and
 * lineOrdinal, both CHECK-constrained to <= 500.
 *
 * ── Sign convention ─────────────────────────────────────────────────────────
 *   positive = stock ENTERS the location
 *   negative = stock LEAVES the location
 * A balance is SUM(signed_quantity); it is never a stored column, and a negative
 * balance is a legal, reportable state rather than a schema violation.
 */

/** Movement classes 0053 can write. Future adapters widen this in their own migration. */
export const INVENTORY_MOVEMENT_TYPES = ["PURCHASE_RECEIPT", "REVERSAL"] as const;
export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];

/** The only stock location seeded by 0053. */
export const INVENTORY_MAIN_LOCATION = "MAIN" as const;

/** Actor recorded on the P2B posting lock when P2C posts a receipt. */
export const INVENTORY_POSTING_LOCK_ACTOR = "p2c-inventory-ledger" as const;

/**
 * Prefix of the reversal dedupe identity built inside PostgreSQL.
 * Callers supply the unprefixed key; the database namespaces it so a reversal
 * key can never collide with a posting dedupe key.
 */
export const INVENTORY_REVERSAL_KEY_PREFIX = "inventory-movement-reversal:v1:" as const;

/** Result of posting a confirmed P2B purchase receipt into the ledger. */
export interface InventoryPostingResult {
  movementId: string;
  receiptId: string;
  /**
   * P2B's frozen p2c_dedupe_key, verbatim:
   * `purchase-receipt-confirmation:v1:{receiptId}:{confirmationHash}`.
   */
  dedupeKey: string;
  /** Number of movement lines written. DB-bounded to <= 500. */
  lineCount: number;
  /** True when this call replayed an existing movement and wrote nothing. */
  replayed: boolean;
  /**
   * Non-null when the posted movement has since been REVERSED.
   *
   * Only meaningful on a replay: without it, `replayed: true` would read as
   * "this stock is on hand" even when the movement it points at has been fully
   * negated and the net balance is zero.
   */
  reversedByMovementId: string | null;
  /** P2B posting-lock state, set in the SAME transaction as the movement. */
  postingLockedAt: string | null;
  postingLockedBy: string | null;
}

/** Result of reversing a movement. */
export interface InventoryReversalResult {
  /** The original movement that was reversed. */
  movementId: string;
  /** The reversal movement carrying the exact negative lines. */
  reversalId: string;
  /** Namespaced reversal dedupe identity as stored. */
  dedupeKey: string;
  lineCount: number;
  /** True when this call replayed an existing reversal and wrote nothing. */
  replayed: boolean;
}

/** One derived balance row. */
export interface InventoryBalance {
  locationCode: string;
  productKey: string;
  unitKey: string;
  /** Exact decimal string. May be negative; may be "0.000000" when zeros are requested. */
  quantityBalance: string;
}

export interface InventoryBalanceQuery {
  locationCode?: string | null;
  productKey?: string | null;
  unitKey?: string | null;
  /** Zero balances are omitted unless this is explicitly true. */
  includeZero?: boolean;
}
