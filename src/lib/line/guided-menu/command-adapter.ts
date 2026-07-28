import { PREVIEW_LINE_EVENT_ID, PREVIEW_STAFF_LABEL } from "./config";
import { resolveTransactionTime } from "./dates";
import type {
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
 * Map final confirmation into the typed shape expected by 0049.
 *
 * TODO(0049-integration): swap PreviewOpenProduceSessionCommand for the real
 * OpenProduceSessionCommand export after controlled merge of
 * feat/produce-structured-session-foundation. Do not import unfinished code
 * across worktrees.
 *
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
    staffLabel: input.staffLabel ?? PREVIEW_STAFF_LABEL,
    marketLabel: input.marketLabel,
    lineEventId: input.lineEventId ?? PREVIEW_LINE_EVENT_ID,
    lineTimestampMs: input.lineTimestampMs,
  };
}

export function toPreviewCloseProduceSessionCommand(input: {
  observedItemCount: number;
  lineEventId?: string;
  lineTimestampMs: number;
}): PreviewCloseProduceSessionCommand {
  return {
    kind: "close",
    lineEventId: input.lineEventId ?? PREVIEW_LINE_EVENT_ID,
    lineTimestampMs: input.lineTimestampMs,
    expectedItemCount: input.observedItemCount,
  };
}

/** Guard used by tests — guided menu must never emit a textual produce header. */
export function looksLikeSyntheticThaiProduceHeader(text: string): boolean {
  // Matches common header shapes like "ต้อม-พาซิโอ้ผัก เบิก 30/06/2569"
  // or "พี่ดำ-วิหาร ชั่งคืน" — guided flow must not generate these.
  return /[ก-๙].+-.+\s+(เบิก|ชั่งคืน|คืน|คืนเสีย)(\s|$)/.test(text)
    || /จบรายการ(เบิก|ชั่งคืน|คืนเสีย|คืน)/.test(text);
}
