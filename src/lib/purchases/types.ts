export const PURCHASE_CONTRACT_VERSION = "p2b-slice-a-v1" as const;
export const PURCHASE_INTENDED_WAREHOUSE_MAIN = "MAIN" as const;
export const PURCHASE_UNKNOWN_TIME_LITERAL = "ไม่ทราบเวลา" as const;
export const PURCHASE_NO_VALUE_LITERAL = "ไม่มี" as const;
export const PURCHASE_UNKNOWN_RATE_LITERAL = "ไม่ทราบ" as const;
export const PURCHASE_BAHT_LITERAL = "บาท" as const;
export const PURCHASE_BOOLEAN_TRUE_LITERAL = "ใช่" as const;
export const PURCHASE_BOOLEAN_FALSE_LITERAL = "ไม่ใช่" as const;

export const PURCHASE_QUANTITY_MAX_TOTAL_DIGITS = 18;
export const PURCHASE_QUANTITY_MAX_SCALE = 6;
export const PURCHASE_UNIT_RATE_MAX_TOTAL_DIGITS = 18;
export const PURCHASE_UNIT_RATE_MAX_SCALE = 4;
export const PURCHASE_DOCUMENT_MONEY_MAX_TOTAL_DIGITS = 15;
export const PURCHASE_DOCUMENT_MONEY_MAX_SCALE = 2;
export const PURCHASE_MAX_ITEM_COUNT = 500;

export type PurchaseContractVersion = typeof PURCHASE_CONTRACT_VERSION;
export type PurchaseIntendedWarehouseCode =
  typeof PURCHASE_INTENDED_WAREHOUSE_MAIN;

export interface CapturedText {
  /** Verbatim token after removing only syntactic outer ASCII spaces/tabs. */
  raw: string;
  /** NFC plus ASCII space/tab trimming only. */
  normalized: string;
}

export interface ExactDecimal {
  raw: string;
  canonical: string;
  coefficient: bigint;
  scale: number;
  totalDigits: number;
}

export interface ExactDocumentMoney {
  decimal: ExactDecimal;
  satang: bigint;
}

export interface LineTextEvidenceMetadata {
  source: "LINE_TEXT";
  lineEventId: string;
  lineMessageId: string | null;
  eventTimestampMs: bigint;
  sourceType: "user" | "group" | "room";
  sourceId: string;
  senderLineUserId: string | null;
}

export interface GuidedPostbackEvidenceMetadata {
  source: "GUIDED_POSTBACK";
  postbackEventId: string;
  eventTimestampMs: bigint;
  rawPostbackData: string;
  action: string;
}

export interface PurchaseSourceLine {
  lineNumber: number;
  startOffset: number;
  endOffset: number;
  rawText: string;
  /** NFC and first-line BOM handling, before matching trim. */
  parsingText: string;
  /** NFC, first-line BOM handling, and ASCII outer trim for matching. */
  normalizedText: string;
}

export interface PurchaseTextChunk {
  chunkId: string;
  chunkOrdinal: number;
  rawText: string;
  /** Line endings folded to LF, NFC, first-line BOM removed; not trimmed. */
  normalizedParsingText: string;
  lines: readonly PurchaseSourceLine[];
  evidence: LineTextEvidenceMetadata;
}

export interface PurchaseTextChunkInput {
  chunkId: string;
  chunkOrdinal: number;
  rawText: string;
  evidence: LineTextEvidenceMetadata;
}

export interface PurchaseBlockSpan {
  blockId: string;
  chunkId: string;
  chunkOrdinal: number;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  rawText: string;
  normalizedParsingText: string;
  lines: readonly PurchaseSourceLine[];
}

export interface PurchaseBlockInput {
  chunk: PurchaseTextChunk;
  span: PurchaseBlockSpan;
}

export type PurchaseBlockKind =
  | "HEADER"
  | "ITEM"
  | "COSTS"
  | "CLOSE";

export type PurchaseBlockClassification =
  | PurchaseBlockKind
  | "INVALID_RESERVED_PURCHASE_BLOCK"
  | "NOT_PURCHASE"
  | "EMPTY_BLOCK";

export type PurchaseStructuralIssueCode =
  | "EMPTY_BLOCK"
  | "INVALID_RESERVED_PURCHASE_BLOCK"
  | "UNRECOGNIZED_LINE"
  | "BLOCK_SPLIT_ACROSS_CHUNKS"
  | "OUT_OF_ORDER_EVIDENCE"
  | "MISSING_HEADER"
  | "DUPLICATE_HEADER"
  | "HEADER_NOT_FIRST"
  | "INVALID_PURCHASE_DATE"
  | "INVALID_PURCHASE_TIME"
  | "MISSING_SUPPLIER"
  | "MISSING_REFERENCE_DECLARATION"
  | "INVALID_INTENDED_WAREHOUSE"
  | "ITEM_BEFORE_HEADER"
  | "MISSING_ITEM_FIELD"
  | "INVALID_ITEM_NUMBER"
  | "DUPLICATE_ITEM_NUMBER"
  | "ITEM_NUMBER_GAP"
  | "INVALID_QUANTITY"
  | "INVALID_UNIT_RATE"
  | "NUMERIC_SCALE_EXCEEDED"
  | "NUMERIC_VALUE_TOO_LARGE"
  | "MISSING_COSTS"
  | "DUPLICATE_COSTS"
  | "COSTS_BEFORE_ITEM"
  | "INVALID_DOCUMENT_MONEY"
  | "INVALID_VAT_DECLARATION"
  | "VAT_ZERO_MUST_USE_NONE"
  | "MISSING_CLOSE"
  | "DUPLICATE_CLOSE"
  | "CLOSE_NOT_LAST"
  | "CLOSE_COUNT_MISMATCH"
  | "COMMAND_AFTER_CLOSE";

export interface PurchaseStructuralIssue {
  code: PurchaseStructuralIssueCode;
  message: string;
  chunkId: string | null;
  startLine: number | null;
  endLine: number | null;
  rawValue: string | null;
}

export type PurchaseReviewFlagCode =
  | "UNKNOWN_PURCHASE_TIME"
  | "NO_REFERENCE"
  | "MISSING_UNIT_RATE"
  | "ZERO_UNIT_RATE"
  | "PRICE_UNIT_REQUIRES_RESOLUTION";

export interface PurchaseReviewFlag {
  code: PurchaseReviewFlagCode;
  message: string;
  chunkId: string | null;
  startLine: number | null;
  endLine: number | null;
  rawValue: string | null;
}

export interface OpenPurchaseCommand {
  kind: "OPEN_PURCHASE";
  contractVersion: PurchaseContractVersion;
  purchaseDate: string;
  purchaseDateText: CapturedText;
  purchaseTime: string | null;
  purchaseTimeText: CapturedText;
  supplierText: CapturedText;
  referenceText: CapturedText | null;
  referenceDeclarationText: CapturedText;
  intendedWarehouseCode: PurchaseIntendedWarehouseCode;
}

export interface AddPurchaseItemCommand {
  kind: "ADD_PURCHASE_ITEM";
  contractVersion: PurchaseContractVersion;
  itemNumber: bigint;
  itemNumberText: CapturedText;
  productText: CapturedText;
  quantity: ExactDecimal;
  quantityText: CapturedText;
  unitText: CapturedText;
  unitRate: ExactDecimal | null;
  unitRateText: CapturedText;
  priceUnitText: CapturedText | null;
}

export interface PurchaseVatNone {
  kind: "NONE";
  declarationText: CapturedText;
}

export interface PurchaseVatAmount {
  kind: "AMOUNT";
  amount: ExactDocumentMoney;
  declarationText: CapturedText;
  includedInItemPrices: boolean;
  includedInItemPricesText: CapturedText;
  recoverable: boolean;
  recoverableText: CapturedText;
}

export type PurchaseVat = PurchaseVatNone | PurchaseVatAmount;

export interface SetPurchaseCostsCommand {
  kind: "SET_PURCHASE_COSTS";
  contractVersion: PurchaseContractVersion;
  freight: ExactDocumentMoney;
  freightText: CapturedText;
  handling: ExactDocumentMoney;
  handlingText: CapturedText;
  discount: ExactDocumentMoney;
  discountText: CapturedText;
  vat: PurchaseVat;
}

export interface ClosePurchaseCommand {
  kind: "CLOSE_PURCHASE";
  contractVersion: PurchaseContractVersion;
  expectedItemCount: bigint;
  expectedItemCountText: CapturedText;
}

export type PurchaseCommand =
  | OpenPurchaseCommand
  | AddPurchaseItemCommand
  | SetPurchaseCostsCommand
  | ClosePurchaseCommand;

export interface TextBlockPurchaseProvenance {
  source: "TEXT_BLOCK";
  classification: PurchaseBlockClassification;
  chunkId: string;
  chunkOrdinal: number;
  block: PurchaseBlockSpan;
  evidence: LineTextEvidenceMetadata;
}

export interface GuidedPostbackPurchaseProvenance {
  source: "GUIDED_POSTBACK";
  evidence: GuidedPostbackEvidenceMetadata;
}

export type PurchaseProvenance =
  | TextBlockPurchaseProvenance
  | GuidedPostbackPurchaseProvenance;

export type PurchaseCommandEnvelope =
  | {
      status: "PARSED";
      commandOrdinal: number;
      command: PurchaseCommand;
      provenance: PurchaseProvenance;
      errors: readonly PurchaseStructuralIssue[];
      reviewFlags: readonly PurchaseReviewFlag[];
    }
  | {
      status: "INVALID";
      commandOrdinal: number;
      command: null;
      provenance: PurchaseProvenance;
      errors: readonly PurchaseStructuralIssue[];
      reviewFlags: readonly PurchaseReviewFlag[];
    };

export type PurchaseBlockParseResult =
  | {
      status: "PARSED";
      command: PurchaseCommand;
      errors: readonly PurchaseStructuralIssue[];
      reviewFlags: readonly PurchaseReviewFlag[];
    }
  | {
      status: "INVALID";
      command: null;
      errors: readonly PurchaseStructuralIssue[];
      reviewFlags: readonly PurchaseReviewFlag[];
    };

export interface PurchaseEvidenceDraft {
  header: OpenPurchaseCommand | null;
  headers: readonly OpenPurchaseCommand[];
  items: readonly AddPurchaseItemCommand[];
  costs: SetPurchaseCostsCommand | null;
  costCommands: readonly SetPurchaseCostsCommand[];
  close: ClosePurchaseCommand | null;
  closes: readonly ClosePurchaseCommand[];
  intendedWarehouseCode: PurchaseIntendedWarehouseCode | null;
  rawTextChunks: readonly PurchaseTextChunk[];
  postbackEvidence: readonly GuidedPostbackEvidenceMetadata[];
}

export interface PurchaseAssemblyInput {
  chunks: readonly PurchaseTextChunk[];
  postbackEvidence: readonly GuidedPostbackEvidenceMetadata[];
  commandEnvelopes: readonly PurchaseCommandEnvelope[];
}

export interface PurchaseAssemblyResult {
  status: "COMPLETE" | "INCOMPLETE";
  evidence: PurchaseEvidenceDraft;
  commandEnvelopes: readonly PurchaseCommandEnvelope[];
  errors: readonly PurchaseStructuralIssue[];
  reviewFlags: readonly PurchaseReviewFlag[];
}
