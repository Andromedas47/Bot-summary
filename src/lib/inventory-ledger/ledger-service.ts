/**
 * P2C inventory movement ledger service.
 *
 * Writes the authoritative QUANTITY ledger only:
 *   - post a confirmed P2B purchase receipt into MAIN (idempotent)
 *   - reverse a movement with exact negative lines (idempotent)
 *   - read derived balances
 *
 * Does NOT write valuation, landed cost or COGS — that is P2D / migration 0054.
 * Does NOT void purchase documents: 0052's posting lock deliberately refuses a
 * standalone void once movements exist, and this client does not work around it.
 * Does NOT wire LINE webhooks.
 *
 * All mutation goes through service_role SECURITY DEFINER RPCs from migration
 * 0053 — this client has no direct table DML and the grants enforce that.
 *
 * Every response is validated at runtime (see ./validate). Nothing is cast.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  InventoryContractViolationError,
  parseBalancesResponse,
  parsePostingResult,
  parseReversalResult,
} from "./validate";
import type {
  InventoryBalance,
  InventoryBalanceQuery,
  InventoryPostingResult,
  InventoryReversalResult,
} from "./types";

type Supabase = SupabaseClient<Database>;

/** Referenced receipt or movement does not exist. */
export class InventoryNotFoundError extends Error {
  constructor(message = "inventory_source_not_found") {
    super(message);
    this.name = "InventoryNotFoundError";
  }
}

/** Source document is not in a state that may post (draft, void, wrong type). */
export class InventoryInvalidLifecycleError extends Error {
  constructor(message = "invalid_source_lifecycle") {
    super(message);
    this.name = "InventoryInvalidLifecycleError";
  }
}

/**
 * The source document itself forbids posting: blocking blockers, a destination
 * other than MAIN, a non-positive quantity, or a payload claiming P2B already
 * posts movement.
 */
export class InventorySourceBlockedError extends Error {
  constructor(message = "source_blocked_for_posting") {
    super(message);
    this.name = "InventorySourceBlockedError";
  }
}

/** A line carries an unresolved product or unit identity. Stock cannot move against it. */
export class InventoryUnresolvedIdentityError extends Error {
  constructor(message = "unresolved_identity") {
    super(message);
    this.name = "InventoryUnresolvedIdentityError";
  }
}

/**
 * A different payload tried to reuse an existing source identity, or a reversal
 * key is already bound to an unrelated movement. Never resolved by retrying.
 */
export class InventoryDuplicateSourceError extends Error {
  constructor(message = "duplicate_source_identity") {
    super(message);
    this.name = "InventoryDuplicateSourceError";
  }
}

/** The movement is already reversed under a different reversal key. */
export class InventoryAlreadyReversedError extends Error {
  constructor(message = "movement_already_reversed") {
    super(message);
    this.name = "InventoryAlreadyReversedError";
  }
}

/** An append-only guard rejected an edit, delete, or late line append. */
export class InventoryAppendOnlyViolationError extends Error {
  constructor(message = "ledger_is_append_only") {
    super(message);
    this.name = "InventoryAppendOnlyViolationError";
  }
}

/**
 * The all-or-nothing coupling between a movement, its lines and the P2B posting
 * lock was violated — for example a header whose declared line count does not
 * match its lines.
 */
export class InventoryPostingAtomicityError extends Error {
  constructor(message = "posting_atomicity_violated") {
    super(message);
    this.name = "InventoryPostingAtomicityError";
  }
}

/**
 * Maps PostgreSQL RPC failures to typed errors.
 *
 * An unmatched failure is rethrown as a plain Error rather than flattened into
 * a business case, so an unexpected DB fault can never masquerade as an
 * expected one. Ordering matters: the more specific patterns come first.
 */
export function mapInventoryRpcError(message: string): Error {
  const text = message ?? "";

  if (/not found/iu.test(text)) return new InventoryNotFoundError(text);

  if (/already reversed by/iu.test(text)) return new InventoryAlreadyReversedError(text);
  if (/itself a reversal and cannot be reversed/iu.test(text)) {
    return new InventoryInvalidLifecycleError(text);
  }

  if (/already posted as movement|already in use by a different movement/iu.test(text)) {
    return new InventoryDuplicateSourceError(text);
  }

  if (/UNRESOLVED (?:product|unit) identity|blank product_key or unit_key/iu.test(text)) {
    return new InventoryUnresolvedIdentityError(text);
  }

  if (
    /has blocking blockers|posts_inventory_movement=true|targets destination|non-positive quantity|has no items to post/iu
      .test(text)
  ) {
    return new InventorySourceBlockedError(text);
  }

  if (/is void and must not be posted|is not confirmed/iu.test(text)) {
    return new InventoryInvalidLifecycleError(text);
  }

  if (/append-only and immutable|lines may only be written/iu.test(text)) {
    return new InventoryAppendOnlyViolationError(text);
  }

  if (/declares \d+ lines but has|all-or-nothing/iu.test(text)) {
    return new InventoryPostingAtomicityError(text);
  }

  if (
    /malformed confirmation payload|malformed items array|no p2c_dedupe_key|declares item_count|no business_date/iu
      .test(text)
  ) {
    return new InventoryContractViolationError(text, "rpc");
  }

  return new Error(text || "inventory_ledger_rpc_failed");
}

export class InventoryLedgerService {
  constructor(private readonly supabase: Supabase) {}

  /**
   * Posts a confirmed, unblocked P2B purchase receipt into MAIN.
   *
   * Atomic with the P2B posting lock: either both the movement and the lock
   * exist, or neither does. Safe to retry — a redelivered call for the same
   * frozen confirmation returns the ORIGINAL movement with `replayed: true` and
   * writes nothing.
   *
   * Check `reversedByMovementId` on a replay: a replayed posting whose movement
   * has since been reversed contributes nothing to the current balance.
   */
  async postPurchaseReceipt(params: {
    receiptId: string;
    actor?: string | null;
  }): Promise<InventoryPostingResult> {
    const { data, error } = await this.supabase.rpc(
      "post_purchase_receipt_inventory_movement",
      { p_receipt_id: params.receiptId, p_actor: params.actor ?? null },
    );

    if (error) throw mapInventoryRpcError(error.message ?? "");
    return parsePostingResult(data);
  }

  /**
   * Reverses a movement by writing exact negative lines.
   *
   * Idempotent on `reversalKey`: the same key replays and returns the existing
   * reversal. A DIFFERENT key against an already-reversed movement fails closed
   * — a movement may be reversed at most once, and a reversal may never itself
   * be reversed.
   *
   * Does NOT void the source purchase document. While a receipt holds a P2B
   * posting lock, its document-level void stays refused by design; the atomic
   * "void + reverse" adapter needs a P2B primitive that does not exist yet.
   */
  async reverseMovement(params: {
    movementId: string;
    reversalKey: string;
    reason: string;
    actor?: string | null;
  }): Promise<InventoryReversalResult> {
    const { data, error } = await this.supabase.rpc("reverse_inventory_movement", {
      p_movement_id: params.movementId,
      p_reversal_key: params.reversalKey,
      p_reason: params.reason,
      p_actor: params.actor ?? null,
    });

    if (error) throw mapInventoryRpcError(error.message ?? "");
    return parseReversalResult(data);
  }

  /**
   * Reads derived balances, ordered by location, product, then unit.
   *
   * Quantities come back as exact decimal strings. Zero balances are omitted
   * unless `includeZero` is explicitly true — a fully reversed product nets to
   * zero and is not "in stock".
   */
  async getBalances(query: InventoryBalanceQuery = {}): Promise<InventoryBalance[]> {
    const { data, error } = await this.supabase.rpc("get_inventory_balances", {
      p_location_code: query.locationCode ?? null,
      p_product_key: query.productKey ?? null,
      p_unit_key: query.unitKey ?? null,
      p_include_zero: query.includeZero ?? false,
    });

    if (error) throw mapInventoryRpcError(error.message ?? "");
    return parseBalancesResponse(data);
  }
}
