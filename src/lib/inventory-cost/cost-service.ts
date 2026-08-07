/**
 * P2D inventory cost valuation service.
 *
 * Writes the append-only VALUE ledger, layered additively on top of the 0053
 * quantity ledger:
 *   - value a confirmed PURCHASE_RECEIPT movement at its frozen 0052 unit cost
 *   - value an ISSUE / DAMAGED_WRITE_OFF consumption at the moving average
 *     effective at posting time
 *   - value a GOOD_RETURN at the original, caller-proven issue cost
 *   - reverse a cost movement with exact negative lines
 *   - read derived value balances
 *
 * Does NOT write quantity — that is P2C / migration 0053, untouched here. Does
 * NOT allocate receipt-level freight, handling, discount or VAT into product
 * cost — see docs/p2d-actual-cost.md rule 9. Is NOT wired into the P2C
 * purchase-capture confirm flow: nothing calls this service yet.
 *
 * All mutation goes through service_role SECURITY DEFINER RPCs from migration
 * 0054 — this client has no direct table DML and the grants enforce that.
 *
 * Every response is validated at runtime (see ./validate). Nothing is cast.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { parseCostBalancesResponse, parseCostPostingResult } from "./validate";
import type {
  InventoryCostBalance,
  InventoryCostBalanceQuery,
  InventoryCostPostingResult,
} from "./types";

type Supabase = SupabaseClient<Database>;

/** Referenced movement or cost movement does not exist. */
export class InventoryCostNotFoundError extends Error {
  constructor(message = "inventory_cost_source_not_found") {
    super(message);
    this.name = "InventoryCostNotFoundError";
  }
}

/**
 * A consumption line would drive a balance key's valued quantity below zero,
 * and the ledger-side quantity confirms this is genuine shortage rather than
 * a backfill gap.
 */
export class InventoryCostInsufficientInventoryError extends Error {
  constructor(message = "insufficient_inventory") {
    super(message);
    this.name = "InventoryCostInsufficientInventoryError";
  }
}

/**
 * A consumption line cannot be valued because the ledger holds more quantity
 * at that key than has ever been valued — a backfill gap, not genuine
 * shortage. See public.unvalued_inventory_movement_lines.
 */
export class InventoryCostUnvaluedSourceError extends Error {
  constructor(message = "unvalued_source_inventory") {
    super(message);
    this.name = "InventoryCostUnvaluedSourceError";
  }
}

/** A purchase receipt line has no usable unit cost, so line_amount_satang is NULL. */
export class InventoryCostMissingUnitCostError extends Error {
  constructor(message = "missing_unit_cost") {
    super(message);
    this.name = "InventoryCostMissingUnitCostError";
  }
}

/**
 * A good return could not be bound to a source issue cost line — missing,
 * nonexistent, mismatched key, or already fully restored. Never falls back to
 * the moving average.
 */
export class InventoryCostUnprovableReturnError extends Error {
  constructor(message = "unprovable_return_cost") {
    super(message);
    this.name = "InventoryCostUnprovableReturnError";
  }
}

/**
 * The movement already has a cost movement under a different dedupe key or
 * reversal binding — never resolved by retrying.
 */
export class InventoryCostAlreadyValuedError extends Error {
  constructor(message = "movement_already_valued") {
    super(message);
    this.name = "InventoryCostAlreadyValuedError";
  }
}

/** Valuation was requested for a movement type this RPC has no defined rule for. */
export class InventoryCostUnsupportedMovementTypeError extends Error {
  constructor(message = "unsupported_movement_type") {
    super(message);
    this.name = "InventoryCostUnsupportedMovementTypeError";
  }
}

/** An append-only guard rejected an edit, delete, or late line append. */
export class InventoryCostAppendOnlyViolationError extends Error {
  constructor(message = "cost_ledger_is_append_only") {
    super(message);
    this.name = "InventoryCostAppendOnlyViolationError";
  }
}

/** A cost line points at a ledger line belonging to a different movement, or a reversal binding is wrong. */
export class InventoryCostInvalidBindingError extends Error {
  constructor(message = "invalid_cost_binding") {
    super(message);
    this.name = "InventoryCostInvalidBindingError";
  }
}

/** A cost line's value sign opposes its ledger line's quantity sign. */
export class InventoryCostSignConflictError extends Error {
  constructor(message = "value_sign_conflict") {
    super(message);
    this.name = "InventoryCostSignConflictError";
  }
}

/**
 * Maps PostgreSQL RPC failures to typed errors.
 *
 * An unmatched failure is rethrown as a plain Error rather than flattened into
 * a business case, so an unexpected database fault can never masquerade as an
 * expected one. Ordering matters: the more specific patterns come first.
 *
 * `unvalued_source_inventory` is checked BEFORE `insufficient_inventory`: both
 * codes are raised from the same consumption-valuation branch of
 * value_inventory_consumption_movement (0054), and putting the more specific,
 * more narrowly-triggered backfill-gap case first guarantees it is never
 * shadowed by a looser insufficient-inventory match.
 */
export function mapInventoryCostRpcError(message: string): Error {
  const text = message ?? "";

  // "inventory movement % not found" / "inventory cost movement % not found"
  if (/not found/iu.test(text)) return new InventoryCostNotFoundError(text);

  // "unvalued_source_inventory: movement % line % cannot be valued because
  // (%,%,%) has ledger quantity % but only % of it is valued — see
  // public.unvalued_inventory_movement_lines"
  if (/unvalued_source_inventory/iu.test(text)) {
    return new InventoryCostUnvaluedSourceError(text);
  }

  // "insufficient_inventory: movement % line % would drive (%,%,%) balance to
  // % — refusing to post a negative resulting quantity"
  if (/insufficient_inventory/iu.test(text)) {
    return new InventoryCostInsufficientInventoryError(text);
  }

  // "missing_unit_cost: movement % has ledger lines with receipt_item_id in %
  // whose confirmation item has NULL line_amount_satang — refusing to value
  // an unpriced receipt line"
  if (/missing_unit_cost/iu.test(text)) {
    return new InventoryCostMissingUnitCostError(text);
  }

  // "unprovable_return_cost: ..." — four variants in value_good_return_movement:
  // no source ids supplied, no id at a line's position, id does not exist, id
  // names a different key, or id is already fully restored.
  if (/unprovable_return_cost/iu.test(text)) {
    return new InventoryCostUnprovableReturnError(text);
  }

  // "movement_already_valued: cost movement % already exists for movement %
  // under dedupe key % which does not match ... — refusing to treat this as a
  // replay" / "... is already reversed by % under a different reversal
  // binding ..." / "a cost movement already exists for reversal movement %
  // but original cost movement % has no back-link to it ..."
  if (/movement_already_valued/iu.test(text)) {
    return new InventoryCostAlreadyValuedError(text);
  }

  // "unsupported_movement_type: movement % has type % — value_*_movement only
  // values ..."
  if (/unsupported_movement_type/iu.test(text)) {
    return new InventoryCostUnsupportedMovementTypeError(text);
  }

  // "cost_ledger_is_append_only: inventory_cost_movement_lines is append-only
  // and immutable (attempted %) ..." / "... inventory_cost_movements is
  // append-only and immutable (attempted DELETE) ..." / "... immutable:
  // reversed_by_cost_movement_id may only be set once, from NULL" / "...
  // immutable: only reversed_by_cost_movement_id may transition from NULL"
  if (/cost_ledger_is_append_only/iu.test(text)) {
    return new InventoryCostAppendOnlyViolationError(text);
  }

  // "invalid_cost_binding: cost line % (movement_line %) belongs to movement
  // % but cost movement % is bound to movement % ..." / "invalid_cost_binding:
  // movement % is not a REVERSAL of movement % — cost movement % values
  // movement % and can only be reversed by the 0053 REVERSAL that undoes that
  // exact movement"
  if (/invalid_cost_binding/iu.test(text)) {
    return new InventoryCostInvalidBindingError(text);
  }

  // "value_sign_conflict: cost line % carries signed_value_satang=% but its
  // ledger line % carries signed_quantity=% — value must never flow opposite
  // to quantity"
  if (/value_sign_conflict/iu.test(text)) {
    return new InventoryCostSignConflictError(text);
  }

  return new Error(text || "inventory_cost_rpc_failed");
}

export class InventoryCostService {
  constructor(private readonly supabase: Supabase) {}

  /**
   * Values a confirmed PURCHASE_RECEIPT movement (SOURCE_UNIT_COST basis) at
   * the frozen 0052 line_amount_satang, never recomputed.
   *
   * Idempotent on the deterministic inventory-cost dedupe key: a redelivered
   * call for the same movement replays and returns the original cost movement
   * with `replayed: true`, writing nothing.
   */
  async valuePurchaseReceiptMovement(params: {
    movementId: string;
    actor?: string | null;
  }): Promise<InventoryCostPostingResult> {
    const { data, error } = await this.supabase.rpc("value_purchase_receipt_movement", {
      p_movement_id: params.movementId,
      p_actor: params.actor ?? null,
    });

    if (error) throw mapInventoryCostRpcError(error.message ?? "");
    return parseCostPostingResult(data);
  }

  /**
   * Values an ISSUE or DAMAGED_WRITE_OFF movement (MOVING_AVERAGE basis) at
   * the moving average effective at posting time.
   *
   * Idempotent on the deterministic inventory-cost dedupe key, same as
   * {@link valuePurchaseReceiptMovement}.
   */
  async valueConsumptionMovement(params: {
    movementId: string;
    actor?: string | null;
  }): Promise<InventoryCostPostingResult> {
    const { data, error } = await this.supabase.rpc("value_inventory_consumption_movement", {
      p_movement_id: params.movementId,
      p_actor: params.actor ?? null,
    });

    if (error) throw mapInventoryCostRpcError(error.message ?? "");
    return parseCostPostingResult(data);
  }

  /**
   * Values a GOOD_RETURN movement (SOURCE_ISSUE_SNAPSHOT basis) at the
   * original issue cost.
   *
   * `sourceCostLineIds` is positionally aligned to each ledger line's
   * `line_ordinal` (1-based): index 0 is the source cost line id for the
   * ledger line whose `line_ordinal` is 1. Never falls back to the moving
   * average — an unprovable return fails closed.
   */
  async valueGoodReturnMovement(params: {
    movementId: string;
    sourceCostLineIds: readonly string[];
    actor?: string | null;
  }): Promise<InventoryCostPostingResult> {
    const { data, error } = await this.supabase.rpc("value_good_return_movement", {
      p_movement_id: params.movementId,
      p_source_cost_line_ids: [...params.sourceCostLineIds],
      p_actor: params.actor ?? null,
    });

    if (error) throw mapInventoryCostRpcError(error.message ?? "");
    return parseCostPostingResult(data);
  }

  /**
   * Reverses a cost movement (EXACT_NEGATION basis): the reversal's lines are
   * the exact negatives of the original's, bound to the mirroring lines of
   * the 0053 REVERSAL movement. Nothing is recomputed.
   *
   * `reversalMovementId` must be the 0053 REVERSAL movement that undoes the
   * exact quantity movement this cost movement values.
   */
  async reverseCostMovement(params: {
    costMovementId: string;
    reversalMovementId: string;
    reason: string;
    actor?: string | null;
  }): Promise<InventoryCostPostingResult> {
    const { data, error } = await this.supabase.rpc("reverse_inventory_cost_movement", {
      p_cost_movement_id: params.costMovementId,
      p_reversal_movement_id: params.reversalMovementId,
      p_reason: params.reason,
      p_actor: params.actor ?? null,
    });

    if (error) throw mapInventoryCostRpcError(error.message ?? "");
    return parseCostPostingResult(data);
  }

  /**
   * Reads derived value balances, ordered by location, product, then unit.
   *
   * Quantities and values come back as exact decimal strings.
   * `averageUnitCostSatang` is derived at read time and is null when the
   * quantity balance is zero, never divided. Zero balances are omitted unless
   * `includeZero` is explicitly true.
   */
  async getCostBalances(
    query: InventoryCostBalanceQuery = {},
  ): Promise<InventoryCostBalance[]> {
    const { data, error } = await this.supabase.rpc("get_inventory_cost_balances", {
      p_location_code: query.locationCode ?? null,
      p_product_key: query.productKey ?? null,
      p_unit_key: query.unitKey ?? null,
      p_include_zero: query.includeZero ?? false,
    });

    if (error) throw mapInventoryCostRpcError(error.message ?? "");
    return parseCostBalancesResponse(data);
  }
}
