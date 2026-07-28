import type {
  BaseTransactionType,
  SessionKind,
  TransactionType,
} from "./types";

/**
 * Immutable session metadata handed to the parser instead of being recovered
 * from a text header.
 *
 * This is the complete frozen seed, not a convenient subset: it carries every
 * piece of state `parseWeighSession` would otherwise derive from the header
 * lines — identity, timing, labels, main/additional rules AND the transaction
 * section/state the item loop runs in. A partial seed would leave the parser
 * silently falling back to header inference for whatever was omitted, which is
 * exactly the ambiguity a structured session exists to remove.
 *
 * A seeded parse starts in the item state. A later text line therefore can
 * never overwrite seeded metadata: headers are only ever read in the header
 * state, and a header-shaped line arriving mid-session is reported as a parse
 * error rather than silently replacing the operator's declared session.
 */
export interface WeighSessionSeed {
  /** main vs additional — decides closer discipline and section-change rules. */
  session_kind: SessionKind;
  /** Base type every item stores. Non-null exactly when session_kind is "additional". */
  declared_transaction_type: BaseTransactionType | null;
  /** Opener keyword ("เบิกเพิ่ม" …) an additional batch must close with. */
  additional_opener: string | null;
  /** ISO business date. Structured sessions always declare one. */
  date: string | null;
  /** "HH:MM" transaction time. */
  transaction_time: string | null;
  /** Where transaction_time came from — kept for provenance, not parsing. */
  transaction_time_source: TransactionTimeSource | null;
  /** คนขาย. */
  staff_name: string;
  /** Market label (session_title in the parsed result). */
  session_title: string | null;
  /** ผู้ส่ง LINE, when the opening command knew it. */
  sender_name: string | null;
  /** Section label the item loop starts in (legacy default is "main"). */
  current_section: string;
  /**
   * Transaction type items take until a section marker changes it.
   *
   * Seeded EXCLUSIVELY from initial_transaction_type. A guided main session may
   * be a ชั่งคืน or คืนเสีย session with no textual section marker anywhere in
   * its item text, so defaulting to เบิก here would silently persist returns as
   * withdrawals.
   */
  current_transaction_type: TransactionType;
}

export type TransactionTimeSource = "operator_declared" | "line_event";

/** Structured metadata as stored on pending_sessions by migration 0049. */
export interface StructuredSessionMetadata {
  entry_origin: string | null;
  command_contract_version: number | null;
  business_date: string | null;
  transaction_time: string | null;
  transaction_time_source: string | null;
  staff_label: string | null;
  market_label: string | null;
  session_kind: string | null;
  /**
   * The transaction type the session's items start in — required for BOTH
   * kinds. For an additional batch it equals declared_transaction_type; for a
   * main session it is the type the operator picked when opening, and it is the
   * only representation a guided ชั่งคืน / คืนเสีย main session has.
   */
  initial_transaction_type: string | null;
  declared_transaction_type: string | null;
  additional_opener: string | null;
  opened_line_event_id: string | null;
}

/**
 * A structured row that passed the completeness guard. The fields the contract
 * requires are non-null here, so the seed builder needs no assertions.
 */
export type CompleteStructuredMetadata = StructuredSessionMetadata & {
  entry_origin: string;
  command_contract_version: number;
  business_date: string;
  transaction_time: string;
  transaction_time_source: string;
  staff_label: string;
  market_label: string;
  session_kind: "main" | "additional";
  initial_transaction_type: BaseTransactionType;
  opened_line_event_id: string;
};

/** The contract version this build knows how to seed from. */
export const COMMAND_CONTRACT_VERSION = 1;

const BASE_TRANSACTION_TYPES: readonly string[] = ["เบิก", "คืน", "คืนเสีย"];

/**
 * True only when the row carries a complete, contract-compatible structured
 * metadata set. The database already enforces completeness (see the
 * pending_sessions_structured_* CHECK constraints); this repeats the check in
 * the reader so a row written by a newer contract version, or read through a
 * client that predates the columns, falls back to the legacy path instead of
 * being half-trusted.
 */
export function isStructuredSession(
  row: Partial<StructuredSessionMetadata> | null | undefined,
): row is CompleteStructuredMetadata {
  if (!row) return false;
  if (row.entry_origin == null) return false;
  if (row.command_contract_version !== COMMAND_CONTRACT_VERSION) return false;
  if (!row.business_date) return false;
  if (!row.transaction_time) return false;
  if (!row.transaction_time_source) return false;
  if (!row.staff_label?.trim()) return false;
  if (!row.market_label?.trim()) return false;
  if (!row.opened_line_event_id?.trim()) return false;
  // Required for BOTH kinds: a guided main คืน session has no other way to say
  // what its items are.
  if (!BASE_TRANSACTION_TYPES.includes(row.initial_transaction_type as string)) return false;

  if (row.session_kind === "main") {
    return row.declared_transaction_type == null && row.additional_opener == null;
  }
  if (row.session_kind === "additional") {
    return Boolean(row.declared_transaction_type)
      && BASE_TRANSACTION_TYPES.includes(row.declared_transaction_type as string)
      && row.declared_transaction_type === row.initial_transaction_type
      && Boolean(row.additional_opener);
  }
  return false;
}

/**
 * Builds the parser seed from database-enforced structured metadata.
 *
 * Returns null for anything that is not a complete, contract-compatible
 * structured row, so the caller stays on the legacy path rather than seeding
 * the parser from partial state.
 */
export function buildSeedFromStructuredMetadata(
  row: Partial<StructuredSessionMetadata> | null | undefined,
): WeighSessionSeed | null {
  if (!isStructuredSession(row)) return null;

  const sessionKind: SessionKind = row.session_kind === "additional" ? "additional" : "main";
  const declared = (row.declared_transaction_type ?? null) as BaseTransactionType | null;

  return {
    session_kind:              sessionKind,
    declared_transaction_type: declared,
    additional_opener:         row.additional_opener ?? null,
    date:                      row.business_date,
    transaction_time:          row.transaction_time,
    transaction_time_source:   row.transaction_time_source as TransactionTimeSource,
    staff_name:                row.staff_label.trim(),
    session_title:             row.market_label.trim(),
    // A typed open carries no LINE display name; the operator identity that
    // matters for produce accountability is staff_label. Left null rather than
    // invented so nothing downstream mistakes it for observed sender evidence.
    sender_name:               null,
    current_section:           "main",
    // Exclusively from initial_transaction_type — never a เบิก default. An
    // additional batch's initial type is constrained to equal its declared type
    // by both the CHECK constraint and isStructuredSession above.
    current_transaction_type:  row.initial_transaction_type as TransactionType,
  };
}
