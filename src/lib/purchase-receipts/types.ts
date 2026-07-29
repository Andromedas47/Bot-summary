/**
 * P2B purchase receipt persistence — service contract types.
 *
 * Lives OUTSIDE src/lib/purchases on purpose: that module is the pure Slice A
 * parser and its architecture test forbids any database/Supabase import. This
 * module is the persistence sink that consumes Slice A output.
 *
 * Money: every settled amount is an integer number of satang, carried as a
 * decimal STRING across the boundary so no value ever passes through a JS
 * number. unitCost is the one exception in kind — it is a quoted RATE in baht
 * at 4dp, matching the parser envelope, also carried as a string.
 */

/** Version of the confirmation contract this client understands. */
export const PURCHASE_CONFIRMATION_CONTRACT_VERSION =
  "p2b-purchase-confirm-v1" as const;

/** Document-line limit, mirrored from PURCHASE_MAX_ITEM_COUNT and the DB CHECK. */
export const PURCHASE_RECEIPT_MAX_ITEMS = 500;

export type PurchaseReceiptStatus = "draft" | "confirmed" | "void";

export type PurchaseReceiptVatKind = "NONE" | "AMOUNT";

/** A single document line as written to persistence. */
export interface PurchaseReceiptItemInput {
  /** Application-canonical product identity. Never recomputed in SQL. */
  productKey: string;
  /** Verbatim staff product text, kept as evidence beside productKey. */
  rawProductText: string;
  /** Decimal string, numeric(18,6) envelope. Must be > 0. */
  quantity: string;
  /** Application-canonical unit identity. */
  unitKey: string;
  /** Verbatim staff unit text. */
  rawUnit: string;
  /** Decimal string, numeric(18,4) envelope. null = no rate on the document. */
  unitCost?: string | null;
  /** Unit the rate was quoted against when it differs from unitKey. */
  priceUnitText?: string | null;
  /** Staff-entered line number; may differ from document ordinal. */
  itemNumber?: string | null;
  /** Per-line provenance (chunk/block span, captured text). */
  sourceEvidence?: unknown;
}

/** VAT declaration on the document. Zero VAT must be declared as NONE. */
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
  /** Stable identity for the staff document; redelivery updates in place. */
  draftKey: string;
  /** Slice A parser contract version that produced this document. */
  contractVersion: string;
  /** Staff-declared business date, YYYY-MM-DD. Never the server date. */
  businessDate: string;
  /** HH:MM, or null when the document declared an unknown time. */
  purchaseTime?: string | null;

  /** Canonical supplier identity. Null when no supplier is known yet. */
  supplierKey?: string | null;
  /** Verbatim supplier text. Must be paired with supplierKey. */
  supplierRaw?: string | null;
  /** Optional external supplier/vendor code from the document. */
  supplierRef?: string | null;

  /** Invoice/PO reference, or null when the document declared none. */
  referenceText?: string | null;

  /** Integer satang strings. Default "0". */
  freightSatang?: string;
  handlingSatang?: string;
  discountSatang?: string;
  vat?: PurchaseReceiptVat;

  items: readonly PurchaseReceiptItemInput[];

  sourceType?: "user" | "group" | "room" | null;
  sourceId?: string | null;
  senderLineUserId?: string | null;
  sourceLineEventId?: string | null;
  sourceRawMessageId?: string | null;
  sourceEvidence?: unknown;
  reviewFlags?: unknown;

  actor?: string | null;
}

export interface PurchaseReceiptDraftResult {
  receiptId: string;
  status: PurchaseReceiptStatus;
  draftRevision: number;
  itemCount: number;
}

/** One line of the frozen confirmation contract handed to P2C. */
export interface PurchaseConfirmationItem {
  item_ordinal: number;
  item_number: string | null;
  product_key: string;
  quantity: string;
  unit_key: string;
  unit_cost: string | null;
  price_unit_text: string | null;
  line_amount_satang: string | null;
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
  draft_key: string;
  parser_contract_version: string;
  business_date: string;
  purchase_time: string | null;
  supplier_key: string | null;
  supplier_ref: string | null;
  reference_text: string | null;
  intended_warehouse_code: "MAIN";
  freight_satang: string;
  handling_satang: string;
  discount_satang: string;
  vat_kind: PurchaseReceiptVatKind;
  vat_satang: string | null;
  vat_included_in_item_prices: boolean | null;
  vat_recoverable: boolean | null;
  item_count: number;
  items: readonly PurchaseConfirmationItem[];
  items_line_amount_satang_total: string;
  items_missing_unit_cost_count: number;
  /** Always false in P2B. P2C owns movement. */
  posts_inventory_movement: false;
  /** Always false in P2B. P2C owns valuation/COGS. */
  posts_valuation: false;
}

export interface PurchaseReceiptConfirmation {
  receiptId: string;
  status: PurchaseReceiptStatus;
  confirmationKey: string;
  /** sha256 over the canonical payload; stable anchor for P2C. */
  confirmationHash: string;
  confirmedAt: string;
  /** True when this call replayed an existing confirmation instead of creating one. */
  replayed: boolean;
  payload: PurchaseConfirmationPayload;
}

export interface PurchaseReceiptVoidResult {
  receiptId: string;
  status: PurchaseReceiptStatus;
  replayed: boolean;
}
