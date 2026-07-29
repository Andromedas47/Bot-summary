/**
 * P2B purchase receipt persistence — service contract types.
 *
 * Lives OUTSIDE src/lib/purchases on purpose: that module is the pure Slice A
 * parser and its architecture test forbids any database/Supabase import. This
 * module is the persistence sink that consumes Slice A output.
 *
 * ── Numeric transport rule ──────────────────────────────────────────────────
 * Nothing precision-sensitive crosses this boundary as a JS number.
 *   * satang amounts       -> decimal STRING (PostgreSQL bigint/numeric)
 *   * quantity / unit_cost -> decimal STRING (numeric(18,6) / numeric(18,4))
 *   * item_number          -> STRING (bigint, unbounded in the source document)
 *   * draft_revision       -> STRING (bigint)
 *   * lifecycle event id   -> STRING (bigint identity)
 * Only genuinely small, DB-bounded integers stay `number`: item_ordinal and
 * item_count (both CHECK-constrained to <= 500) and blocker counts.
 * line_amount_satang is exact `numeric` in PostgreSQL — the Slice A envelope
 * admits products far beyond bigint — so it is always a string.
 */

/** Version of the confirmation contract this client understands. */
export const PURCHASE_CONFIRMATION_CONTRACT_VERSION =
  "p2b-purchase-confirm-v1" as const;

/** Canonical serialization the confirmation hash is taken over. */
export const PURCHASE_CONFIRMATION_CANONICAL_FORM =
  "purchase-receipt-canonical-json-v1" as const;

export const PURCHASE_CONFIRMATION_HASH_ALGORITHM = "sha256" as const;

/** Document-line limit, mirrored from PURCHASE_MAX_ITEM_COUNT and the DB CHECK. */
export const PURCHASE_RECEIPT_MAX_ITEMS = 500;

/**
 * Documented document-money envelope: 15 digits at scale 2 => 10^15 - 1 satang.
 * Mirrors purchase_receipt_max_document_satang() in migration 0052.
 */
export const PURCHASE_RECEIPT_MAX_DOCUMENT_SATANG = "999999999999999" as const;

/**
 * Registered document identity namespaces (migration 0052 seeds these).
 *
 * The namespace exists so a guided-session id can never collide with a
 * LINE-text document key. It is a table in the database, not an enum, so a
 * future intake path can register one without a schema migration — this union
 * is the set known to this client today.
 */
export const PURCHASE_DOCUMENT_NAMESPACES = [
  "line-text",
  "guided-postback",
  "manual-entry",
] as const;
export type PurchaseDocumentNamespace =
  (typeof PURCHASE_DOCUMENT_NAMESPACES)[number];

export type PurchaseReceiptStatus = "draft" | "confirmed" | "void";
export type PurchaseReceiptVatKind = "NONE" | "AMOUNT";
export type PurchaseIdentityStatus = "RESOLVED" | "UNRESOLVED";
export type PurchasePriceUnitStatus =
  | "NOT_APPLICABLE"
  | "RESOLVED"
  | "UNRESOLVED";

/** Structured posting blockers surfaced in the frozen contract. */
export const PURCHASE_BLOCKER_CODES = [
  "MISSING_UNIT_COST",
  "UNRESOLVED_PRODUCT_IDENTITY",
  "UNRESOLVED_UNIT_IDENTITY",
  "UNRESOLVED_PRICE_UNIT",
  "UNRESOLVED_DESTINATION",
  "SOURCE_REVIEW_FLAGS",
  "DECLARED_TOTAL_MISMATCH",
] as const;
export type PurchaseBlockerCode = (typeof PURCHASE_BLOCKER_CODES)[number];

export type PurchaseBlockerSeverity = "BLOCKING" | "REVIEW";

export interface PurchaseBlocker {
  code: PurchaseBlockerCode;
  severity: PurchaseBlockerSeverity;
  item_count: number;
  item_ordinals: readonly number[];
  detail: string;
  flags?: unknown;
}

/**
 * Totals reconciliation.
 *
 * Slice A's COSTS block captures freight, handling, discount and VAT only — it
 * carries NO declared document/invoice total. v1 therefore does not invent one,
 * and payable-total reconciliation against a declared figure is UNAVAILABLE.
 * `declared_total_satang` is always null in v1 and exists so adding a declared
 * total later is not a breaking shape change.
 */
export type PurchaseTotalsReconciliationStatus =
  | "COMPUTED_NO_DECLARED_TOTAL_IN_SOURCE"
  | "NOT_COMPUTABLE_MISSING_UNIT_COST";

export interface PurchaseConfirmationTotals {
  /** null when any line lacks a unit cost — never silently zero. */
  line_subtotal_satang: string | null;
  freight_satang: string;
  handling_satang: string;
  discount_satang: string;
  vat_satang: string | null;
  payable_total_satang: string | null;
  declared_total_satang: null;
  reconciliation_status: PurchaseTotalsReconciliationStatus;
}

/** A single document line as written to persistence. */
export interface PurchaseReceiptItemInput {
  /** Application-canonical product identity. Never recomputed in SQL. */
  productKey: string;
  rawProductText: string;
  /** UNRESOLVED marks productKey as a raw-text fallback, not an identity. */
  productIdentityStatus?: PurchaseIdentityStatus;
  /** Decimal string, numeric(18,6) envelope. Must be > 0. */
  quantity: string;
  unitKey: string;
  rawUnit: string;
  unitIdentityStatus?: PurchaseIdentityStatus;
  /** Decimal string, numeric(18,4) envelope. null = no rate on the document. */
  unitCost?: string | null;
  priceUnitText?: string | null;
  priceUnitStatus?: PurchasePriceUnitStatus;
  /** Staff-entered line number, string because bigint is unbounded here. */
  itemNumber?: string | null;
  sourceEvidence?: Record<string, unknown>;
}

export type PurchaseReceiptVat =
  | { kind: "NONE" }
  | {
      kind: "AMOUNT";
      /** Integer satang as a string. Must be > 0. */
      satang: string;
      includedInItemPrices: boolean;
      recoverable: boolean;
    };

export interface PurchaseReceiptDraftInput {
  /**
   * Document identity namespace. Combined with documentKey this is the
   * document's identity — NOT a delivery event id.
   */
  documentNamespace: PurchaseDocumentNamespace;
  /**
   * Stable identity for the staff document within its namespace.
   *
   * Normalized by the database (NFC + collapsed internal whitespace + trim)
   * before both lookup and insert, so whitespace variants are one document.
   * Reusing a key across genuinely different documents is a caller error; the
   * source-binding check turns an accidental cross-conversation reuse into a
   * hard failure rather than silent replacement.
   */
  documentKey: string;
  contractVersion: string;
  /** Staff-declared business date, YYYY-MM-DD. Never the server date. */
  businessDate: string;
  purchaseTime?: string | null;

  supplierKey?: string | null;
  supplierRaw?: string | null;
  supplierRef?: string | null;
  referenceText?: string | null;

  /** Integer satang strings. Default "0". */
  freightSatang?: string;
  handlingSatang?: string;
  discountSatang?: string;
  vat?: PurchaseReceiptVat;

  items: readonly PurchaseReceiptItemInput[];

  /**
   * Source binding. A document key already stored under a different
   * (sourceType, sourceId) fails closed instead of being replaced.
   */
  sourceType?: "user" | "group" | "room" | null;
  sourceId?: string | null;
  senderLineUserId?: string | null;
  /** Latest DELIVERY event id. Separate from identity; may change on redelivery. */
  sourceLineEventId?: string | null;
  sourceRawMessageId?: string | null;
  sourceEvidence?: Record<string, unknown>;
  reviewFlags?: readonly unknown[];

  /** Correction linkage: the confirmed receipt this document replaces. */
  supersedesReceiptId?: string | null;

  actor?: string | null;
}

export interface PurchaseReceiptDraftResult {
  receiptId: string;
  documentNamespace: string;
  documentKey: string;
  status: PurchaseReceiptStatus;
  /** bigint as string. */
  draftRevision: string;
  itemCount: number;
}

/** One line of the frozen confirmation contract handed to P2C. */
export interface PurchaseConfirmationItem {
  /** Stable item identity so P2C can address a line directly. */
  receipt_item_id: string;
  item_ordinal: number;
  item_number: string | null;
  product_key: string;
  raw_product_text: string;
  product_identity_status: PurchaseIdentityStatus;
  quantity: string;
  unit_key: string;
  raw_unit: string;
  unit_identity_status: PurchaseIdentityStatus;
  unit_cost: string | null;
  price_unit_text: string | null;
  price_unit_status: PurchasePriceUnitStatus;
  /** null when the document stated no unit rate — never "0". */
  line_amount_satang: string | null;
  source_evidence: Record<string, unknown>;
}

/** Frozen source/delivery identity captured at confirmation time. */
export interface PurchaseConfirmationSource {
  source_type: "user" | "group" | "room" | null;
  source_id: string | null;
  sender_line_user_id: string | null;
  source_line_event_id: string | null;
  source_raw_message_id: string | null;
  source_evidence: Record<string, unknown>;
}

/**
 * The canonical P2B confirmation payload.
 *
 * Field names are snake_case because this is the DB-issued contract document
 * verbatim — renaming it in the client would let the TypeScript view and the
 * hashed payload drift apart silently.
 */
export interface PurchaseConfirmationPayload {
  contract_version: typeof PURCHASE_CONFIRMATION_CONTRACT_VERSION;
  receipt_id: string;
  document_namespace: string;
  document_key: string;
  parser_contract_version: string;
  source: PurchaseConfirmationSource;
  business_date: string;
  purchase_time: string | null;
  supplier_key: string | null;
  supplier_raw: string | null;
  supplier_ref: string | null;
  reference_text: string | null;
  intended_warehouse_code: "MAIN";
  vat_kind: PurchaseReceiptVatKind;
  vat_included_in_item_prices: boolean | null;
  vat_recoverable: boolean | null;
  item_count: number;
  items: readonly PurchaseConfirmationItem[];
  totals: PurchaseConfirmationTotals;
  blockers: readonly PurchaseBlocker[];
  has_blocking_blockers: boolean;
  /** Always false in P2B. P2C owns movement. */
  posts_inventory_movement: false;
  /** Always false in P2B. P2C owns valuation/COGS. */
  posts_valuation: false;
}

/** The frozen contract envelope, returned exactly as stored. */
export interface PurchaseConfirmationEnvelope {
  contract_version: typeof PURCHASE_CONFIRMATION_CONTRACT_VERSION;
  canonical_form: typeof PURCHASE_CONFIRMATION_CANONICAL_FORM;
  hash_algorithm: typeof PURCHASE_CONFIRMATION_HASH_ALGORITHM;
  hash: string;
  confirmation_key: string;
  confirmed_at: string;
  confirmed_by: string | null;
  payload: PurchaseConfirmationPayload;
}

/** Current truth, kept separate from the frozen contract. */
export interface PurchaseReceiptLifecycleView {
  status: PurchaseReceiptStatus;
  posting_locked_at: string | null;
  posting_locked_by: string | null;
}

export interface PurchaseReceiptVoidView {
  voided_at: string;
  voided_by: string | null;
  void_reason: string;
}

export interface PurchaseReceiptCorrectionView {
  supersedes_receipt_id: string | null;
  superseded_by_receipt_id: string | null;
}

/**
 * What P2C reads. The frozen contract, current lifecycle, void metadata and
 * correction metadata are SEPARATE fields — a confirmed document stays readable
 * after void, and a consumer can always tell "what was confirmed" from
 * "what is true now".
 */
export interface PurchaseReceiptConfirmation {
  receiptId: string;
  confirmation: PurchaseConfirmationEnvelope;
  lifecycle: PurchaseReceiptLifecycleView;
  /** null unless the receipt is currently void. */
  void: PurchaseReceiptVoidView | null;
  correction: PurchaseReceiptCorrectionView;
  /**
   * Exact P2C dedupe identity:
   * `purchase-receipt-confirmation:v1:{receiptId}:{hash}`.
   * receipt_id alone is insufficient — the hash pins the exact posted content.
   */
  p2cDedupeKey: string;
  /** True when this call replayed an existing confirmation. */
  replayed: boolean;
}

export interface PurchaseReceiptVoidResult {
  receiptId: string;
  status: PurchaseReceiptStatus;
  replayed: boolean;
}

export interface PurchaseReceiptPostingLockResult {
  receiptId: string;
  replayed: boolean;
}
