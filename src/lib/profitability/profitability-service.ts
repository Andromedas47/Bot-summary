/**
 * P3 profitability service.
 *
 * Records and reads the append-only COGS / profit-loss result for one
 * accountability round:
 *   - record (or replay) a snapshot for a round from caller-proven attributions
 *   - read a snapshot back, at the latest revision or at a named one
 *
 * Writes no quantity movement and no cost line — P2C (0053) and P2D (0054) own
 * those and are only read here. All mutation goes through the service_role
 * SECURITY DEFINER RPC from migration 20260808130000, so this client has no
 * direct table DML and the grants enforce that.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 * `accountabilityRoundId` is REQUIRED on every call. There is no legacy tuple
 * path — no (source, market, seller, businessDate) fallback exists here, and
 * none may be added: two rounds may share every descriptive field and are still
 * two rounds. A missing or blank round id is refused before the network call.
 *
 * ── Money crosses as strings ────────────────────────────────────────────────
 * Satang amounts are sent to PostgreSQL as decimal STRINGS and cast to numeric
 * server-side. Sending a JS number would round a large amount through a double
 * before PostgreSQL ever saw it, so a number is refused outright rather than
 * stringified. `null`/omitted is a legitimate, meaningful value: it tells the
 * RPC the term is not provable, and the snapshot comes back INCOMPLETE with a
 * named reason rather than carrying a fabricated zero.
 *
 * Every response is validated at runtime (see ./validate). Nothing is cast.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  isExactSatangString,
  isProfitabilityUuid,
  validateProfitabilityPostingResult,
  validateProfitabilitySnapshot,
} from "./validate";
import {
  PROFITABILITY_CALCULATION_VERSION,
  type ProfitabilityPostingResult,
  type ProfitabilityQuantityAttribution,
  type ProfitabilitySnapshot,
} from "./types";

type Supabase = SupabaseClient<Database>;

/**
 * An argument this service refused to send.
 *
 * Distinct from ProfitabilityContractViolationError on purpose: this one means
 * the CALL was wrong and the caller must fix it, while a contract violation
 * means the DATABASE answered something untrustworthy. Conflating them would
 * hide which side is broken.
 */
export class ProfitabilityInvalidInputError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`profitability invalid input at ${path}: ${message}`);
    this.name = "ProfitabilityInvalidInputError";
  }
}

function failInput(path: string, message: string): never {
  throw new ProfitabilityInvalidInputError(message, path);
}

/** The named accountability round does not exist. */
export class ProfitabilityRoundNotFoundError extends Error {
  constructor(message = "accountability_round_not_found") {
    super(message);
    this.name = "ProfitabilityRoundNotFoundError";
  }
}

/**
 * A satang argument was not exact whole satang (or was negative where the RPC
 * requires non-negative). Never rounded into range.
 */
export class ProfitabilityInvalidSatangInputError extends Error {
  constructor(message = "invalid_satang_input") {
    super(message);
    this.name = "ProfitabilityInvalidSatangInputError";
  }
}

/**
 * A supplied artifact belongs to a different accountability round. Refused
 * outright rather than quietly dropped — silently ignoring it would understate
 * the round it was meant for and leave no trace of the mistake.
 */
export class ProfitabilityCrossRoundArtifactError extends Error {
  constructor(message = "cross_round_artifact") {
    super(message);
    this.name = "ProfitabilityCrossRoundArtifactError";
  }
}

/** A purchasing-expense receipt id is not a confirmed purchase receipt. */
export class ProfitabilityRequiredArtifactUnboundError extends Error {
  constructor(message = "required_artifact_unbound") {
    super(message);
    this.name = "ProfitabilityRequiredArtifactUnboundError";
  }
}

/**
 * The attribution array was malformed, incomplete, or attributed one produce
 * item more than once — as judged by the RPC, which sees the round's real rows.
 */
export class ProfitabilityInvalidAttributionError extends Error {
  constructor(message = "invalid_quantity_attributions") {
    super(message);
    this.name = "ProfitabilityInvalidAttributionError";
  }
}

/**
 * Returns plus damage exceed withdrawals on at least one line. That is a
 * contradiction in the operational record, not a degraded result, so the RPC
 * raises instead of clamping and this surfaces it as its own class.
 */
export class ProfitabilityNegativeSoldQuantityError extends Error {
  constructor(message = "negative_sold_quantity") {
    super(message);
    this.name = "ProfitabilityNegativeSoldQuantityError";
  }
}

/** An append-only guard rejected an edit or delete of a frozen snapshot. */
export class ProfitabilityAppendOnlyViolationError extends Error {
  constructor(message = "profitability_ledger_is_append_only") {
    super(message);
    this.name = "ProfitabilityAppendOnlyViolationError";
  }
}

/** The RPC was called without a usable calculation version. */
export class ProfitabilityMissingCalculationVersionError extends Error {
  constructor(message = "calculation_version_required") {
    super(message);
    this.name = "ProfitabilityMissingCalculationVersionError";
  }
}

/**
 * Maps PostgreSQL RPC failures to typed errors.
 *
 * An unmatched failure is rethrown as a plain Error rather than flattened into
 * a business case, so an unexpected database fault can never masquerade as an
 * expected one. Ordering matters: `cross_round_artifact` is tested before the
 * attribution patterns because its message also mentions attributed produce
 * items, and a cross-round artifact is the more specific, more serious fact.
 */
export function mapProfitabilityRpcError(message: string): Error {
  const text = message ?? "";

  // "P3: accountability_round_not_found (%)"
  if (/accountability_round_not_found/iu.test(text)) {
    return new ProfitabilityRoundNotFoundError(text);
  }

  // "P3: cross_round_artifact (% transfer source id(s) do not belong to round %)"
  // "P3: cross_round_artifact (% attributed produce item(s) do not belong to round %)"
  if (/cross_round_artifact/iu.test(text)) {
    return new ProfitabilityCrossRoundArtifactError(text);
  }

  // "P3: invalid_satang_input (verified transfers must be exact satang)"
  // "P3: invalid_satang_input (purchasing expenses must be exact non-negative satang)"
  if (/invalid_satang_input/iu.test(text)) {
    return new ProfitabilityInvalidSatangInputError(text);
  }

  // "P3: required_artifact_unbound (% purchasing-expense receipt id(s) are not
  //  confirmed receipts)"
  if (/required_artifact_unbound/iu.test(text)) {
    return new ProfitabilityRequiredArtifactUnboundError(text);
  }

  // "P3: negative_sold_quantity (% line(s) return more than was issued)"
  if (/negative_sold_quantity/iu.test(text)) {
    return new ProfitabilityNegativeSoldQuantityError(text);
  }

  // "P3: profitability_ledger_is_append_only (%, %)" and its snapshot-guard
  // variants (already superseded / no permitted change / snapshot is immutable)
  if (/profitability_ledger_is_append_only/iu.test(text)) {
    return new ProfitabilityAppendOnlyViolationError(text);
  }

  // "P3: calculation_version is required"
  if (/calculation_version is required/iu.test(text)) {
    return new ProfitabilityMissingCalculationVersionError(text);
  }

  // "P3: quantity attributions must be a JSON array"
  // "P3: quantity attribution entries require produce_item_id, location_code,
  //  product_key and unit_key"
  // "P3: % produce item(s) attributed more than once"
  if (/quantity attribution|attributed more than once/iu.test(text)) {
    return new ProfitabilityInvalidAttributionError(text);
  }

  return new Error(text || "profitability_rpc_failed");
}

/** Arguments for {@link ProfitabilityService.recordSnapshot}. */
export interface RecordProfitabilitySnapshotInput {
  /** REQUIRED. The round is the whole identity; there is no tuple fallback. */
  accountabilityRoundId: string;
  /** Every produce item of the round the caller can bind to a 0054 balance key. */
  quantityAttributions: readonly ProfitabilityQuantityAttribution[];
  /**
   * Exact whole satang as a decimal STRING, or null/omitted when the total
   * cannot be proven — which yields `missing_verified_transfers` rather than a
   * zero. Typed `string` so a `number` is a compile error, and re-checked at
   * runtime so a JS caller cannot slip one through either.
   */
  verifiedTransfersSatang?: string | null;
  /** Slip evidence / slip batch / manual slip session / reconciliation ids of THIS round. */
  verifiedTransferSourceIds?: readonly string[];
  /** Exact whole satang as a decimal STRING, or null/omitted when unprovable. */
  purchasingExpensesSatang?: string | null;
  /** Confirmed purchase receipt ids backing the purchasing expense figure. */
  purchasingExpenseReceiptIds?: readonly string[];
  /** Defaults to PROFITABILITY_CALCULATION_VERSION, matching the RPC's own default. */
  calculationVersion?: string;
  actor?: string | null;
}

/** Validates one attribution entry and returns its snake_case RPC form. */
function attributionPayload(
  attribution: ProfitabilityQuantityAttribution,
  path: string,
): Record<string, string> {
  if (!isProfitabilityUuid(attribution?.produceItemId)) {
    failInput(`${path}.produceItemId`, "expected a produce item UUID");
  }
  const text = (key: "locationCode" | "productKey" | "unitKey"): string => {
    const value = attribution[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      failInput(`${path}.${key}`, "expected a non-blank string");
    }
    return value;
  };
  return {
    produce_item_id: attribution.produceItemId,
    location_code: text("locationCode"),
    product_key: text("productKey"),
    unit_key: text("unitKey"),
  };
}

/**
 * Validates an optional satang argument.
 *
 * Absent (undefined or null) is legal and meaningful — it becomes SQL NULL and
 * the snapshot records the matching "unprovable" reason. Present means an exact
 * whole-satang decimal string and nothing else: a `number` is refused because
 * it has already been through a double, and `"1.5"` / `"1e3"` are refused
 * because satang are whole and a plain decimal has no exponent.
 */
function optionalSatang(value: string | null | undefined, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    failInput(path, "expected exact satang as a decimal string but got a JS number");
  }
  if (!isExactSatangString(value)) {
    failInput(path, `expected an exact whole-satang decimal string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Validates an id array and returns a plain, mutable copy for the RPC. */
function uuidArray(ids: readonly string[] | undefined, path: string): string[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) failInput(path, "expected an array of UUIDs");
  return ids.map((id, index) => {
    if (!isProfitabilityUuid(id)) failInput(`${path}[${index}]`, "expected a UUID");
    return id;
  });
}

function requireRoundId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failInput(
      path,
      "accountabilityRoundId is required — a profitability snapshot has no identity without it",
    );
  }
  if (!isProfitabilityUuid(value)) {
    failInput(path, `expected an accountability round UUID, got ${JSON.stringify(value)}`);
  }
  return value;
}

export class ProfitabilityService {
  constructor(private readonly supabase: Supabase) {}

  /**
   * Records (or replays) the profitability snapshot for one accountability
   * round.
   *
   * Idempotent on the deterministic dedupe key, which digests every input that
   * can move a number: an unchanged round replays and returns the ORIGINAL
   * snapshot with `replayed: true`, writing nothing, while any changed input
   * writes a new revision and supersedes the previous one.
   *
   * The result is CERTIFIED only when nothing was left unproven; otherwise it
   * is INCOMPLETE and carries the named reasons. Both are normal outcomes and
   * neither is an error — an INCOMPLETE snapshot is the honest record of a
   * round whose evidence is not all in yet.
   */
  async recordSnapshot(
    input: RecordProfitabilitySnapshotInput,
  ): Promise<ProfitabilityPostingResult> {
    const path = "recordSnapshot";
    const accountabilityRoundId = requireRoundId(
      input?.accountabilityRoundId,
      `${path}.accountabilityRoundId`,
    );

    const attributions = input.quantityAttributions;
    if (!Array.isArray(attributions)) {
      failInput(`${path}.quantityAttributions`, "expected an array of attributions");
    }
    const quantityAttributions = attributions.map((attribution, index) =>
      attributionPayload(attribution, `${path}.quantityAttributions[${index}]`),
    );

    const calculationVersion = input.calculationVersion ?? PROFITABILITY_CALCULATION_VERSION;
    if (typeof calculationVersion !== "string" || calculationVersion.trim().length === 0) {
      failInput(`${path}.calculationVersion`, "expected a non-blank calculation version");
    }

    const { data, error } = await this.supabase.rpc("record_profitability_snapshot", {
      p_accountability_round_id: accountabilityRoundId,
      p_quantity_attributions: quantityAttributions,
      // Sent as a decimal string and cast to numeric server-side; see the
      // module header for why this is never a JS number.
      p_verified_transfers_satang: optionalSatang(
        input.verifiedTransfersSatang,
        `${path}.verifiedTransfersSatang`,
      ),
      p_verified_transfer_source_ids: uuidArray(
        input.verifiedTransferSourceIds,
        `${path}.verifiedTransferSourceIds`,
      ),
      p_purchasing_expenses_satang: optionalSatang(
        input.purchasingExpensesSatang,
        `${path}.purchasingExpensesSatang`,
      ),
      p_purchasing_expense_receipt_ids: uuidArray(
        input.purchasingExpenseReceiptIds,
        `${path}.purchasingExpenseReceiptIds`,
      ),
      p_calculation_version: calculationVersion,
      p_actor: input.actor ?? null,
    });

    if (error) throw mapProfitabilityRpcError(error.message ?? "");
    return validateProfitabilityPostingResult(data);
  }

  /**
   * Reads one snapshot back: the latest revision by default, or the named one.
   *
   * Returns null — never a zeroed placeholder — when the round has no snapshot
   * at that revision. A caller must treat that as "nothing has been computed
   * yet", which is a different fact from a computed result of zero.
   */
  async getSnapshot(
    accountabilityRoundId: string,
    revision?: number,
  ): Promise<ProfitabilitySnapshot | null> {
    const path = "getSnapshot";
    const roundId = requireRoundId(accountabilityRoundId, `${path}.accountabilityRoundId`);

    if (revision !== undefined && revision !== null) {
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
        failInput(`${path}.revision`, `expected a positive integer, got ${String(revision)}`);
      }
    }

    const { data, error } = await this.supabase.rpc("get_profitability_snapshot", {
      p_accountability_round_id: roundId,
      p_revision: revision ?? null,
    });

    if (error) throw mapProfitabilityRpcError(error.message ?? "");
    if (data === null || data === undefined) return null;
    return validateProfitabilitySnapshot(data);
  }
}
