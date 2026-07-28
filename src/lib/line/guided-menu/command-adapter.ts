/**
 * Guided menu → 0049 typed command adapter (preview boundary).
 *
 * TODO(0049-integration): replace Preview* types with real exports from
 * `produce-session-commands.ts` after controlled merge. Do not import from
 * another worktree path.
 *
 * TODO(0050-integration): operator identity + opaque menu state token (`tok`)
 * will replace preview placeholders for staffLabel / session continuity.
 */

import { PREVIEW_LINE_EVENT_ID, PREVIEW_STAFF_LABEL } from "./config";
import { resolveTransactionTime } from "./dates";
import type {
  GuidedMenuActiveSession,
  GuidedMenuBaseTransactionType,
  PreviewCloseProduceSessionCommand,
  PreviewOpenProduceSessionCommand,
} from "./types";

export interface OpenCommandAdapterInput {
  initialTransactionType: GuidedMenuBaseTransactionType;
  businessDate: string;
  marketLabel: string;
  staffLabel?: string;
  lineEventId?: string;
  lineTimestampMs: number;
  /**
   * Guided menu does not collect an operator-declared clock time yet.
   * Time is taken from the LINE event timestamp.
   */
  transactionTimeSource?: "operator_declared" | "line_event";
}

/**
 * Preview placeholders that real LINE / 0049 / 0050 values will replace.
 *
 * | Field | Preview source | Future source |
 * |---|---|---|
 * | lineEventId | PREVIEW_LINE_EVENT_ID | LINE webhook event.id |
 * | lineTimestampMs | preview clock / event | LINE event.timestamp |
 * | transactionTime | derived from lineTimestampMs | same, or operator-declared |
 * | staffLabel | PREVIEW_STAFF_LABEL | 0050 operator identity |
 * | marketLabel | config lookup by mid | same config resolution |
 */
export const PREVIEW_COMMAND_PLACEHOLDERS = {
  lineEventId: PREVIEW_LINE_EVENT_ID,
  staffLabel: PREVIEW_STAFF_LABEL,
} as const;

/**
 * Map validated Guided Menu confirmation into the typed shape expected by 0049.
 * Never synthesizes a Thai session header string.
 */
export function toPreviewOpenProduceSessionCommand(
  input: OpenCommandAdapterInput,
): PreviewOpenProduceSessionCommand {
  if (!input.initialTransactionType) {
    throw new Error("initialTransactionType is required — no silent default to เบิก");
  }
  if (!input.businessDate) {
    throw new Error("businessDate is required");
  }
  if (!input.marketLabel) {
    throw new Error("marketLabel is required");
  }

  return {
    kind: "open",
    sessionKind: "main",
    initialTransactionType: input.initialTransactionType,
    declaredTransactionType: null,
    additionalOpener: null,
    businessDate: input.businessDate,
    transactionTime: resolveTransactionTime(input.lineTimestampMs),
    transactionTimeSource: input.transactionTimeSource ?? "line_event",
    staffLabel: input.staffLabel ?? PREVIEW_COMMAND_PLACEHOLDERS.staffLabel,
    marketLabel: input.marketLabel,
    lineEventId: input.lineEventId ?? PREVIEW_COMMAND_PLACEHOLDERS.lineEventId,
    lineTimestampMs: input.lineTimestampMs,
  };
}

/** Build open command from an already-opened preview session (display ↔ emit parity). */
export function openCommandFromActiveSession(
  session: GuidedMenuActiveSession,
  lineTimestampMs = session.openedAtMs,
): PreviewOpenProduceSessionCommand {
  return toPreviewOpenProduceSessionCommand({
    initialTransactionType: session.baseTransactionType,
    businessDate: session.businessDateIso,
    marketLabel: session.marketLabel,
    staffLabel: session.staffLabel,
    lineTimestampMs,
  });
}

export function toPreviewCloseProduceSessionCommand(input: {
  observedItemCount: number;
  lineEventId?: string;
  lineTimestampMs: number;
}): PreviewCloseProduceSessionCommand {
  return {
    kind: "close",
    lineEventId: input.lineEventId ?? PREVIEW_COMMAND_PLACEHOLDERS.lineEventId,
    lineTimestampMs: input.lineTimestampMs,
    expectedItemCount: input.observedItemCount,
  };
}

/** Guard used by tests — guided menu must never emit a textual produce header. */
export function looksLikeSyntheticThaiProduceHeader(text: string): boolean {
  return /[ก-๙].+-.+\s+(เบิก|ชั่งคืน|คืน|คืนเสีย)(\s|$)/.test(text)
    || /จบรายการ(เบิก|ชั่งคืน|คืนเสีย|คืน)/.test(text);
}
