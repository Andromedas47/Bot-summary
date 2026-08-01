/**
 * Manual White Sheet LINE session commands.
 *
 * Open-header → send fields across one or more messages → close-header
 * workflow. This module only recognizes/parses text; all White Sheet
 * arithmetic and persistence stays in @/lib/white-sheet and
 * @/lib/line/white-sheet-close-service (reused, never duplicated).
 */
import { normalizedMarketLabel } from "@/lib/market";
import {
  FIELD_LABEL_ONLY_RE,
  FIELD_LABELS,
  FIELD_LINE_RE,
  parseBusinessDate,
  parseCloseMoneyAmount,
  parseOtherField,
  stripExportPrefix,
} from "@/lib/line/white-sheet-close-command";

const OPENER_RE =
  /^(.+?)\s+ส่งใบขาวมือ\s+(\d{1,2}\/\d{1,2}\/(?:25)?\d{2})\s*$/;

export const SESSION_CLOSE_TEXT = "จบใบขาวมือ";
export const SESSION_CANCEL_TEXT = "ยกเลิกใบขาวมือ";

export interface WhiteSheetSessionOpener {
  marketLabel: string;
  marketLabelNormalized: string;
  businessDate: string;
  /** Raw operator-typed DD/MM/BBBB text, kept only for reply display fidelity. */
  businessDateDisplay: string;
}

export type WhiteSheetSessionOpenerResult =
  | { kind: "not_command" }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; opener: WhiteSheetSessionOpener };

function singleNormalizedLine(text: string): string | null {
  const lines = text
    .split("\n")
    .map(stripExportPrefix)
    .filter((line) => line.length > 0);
  return lines.length === 1 ? lines[0] : null;
}

/** Parses the exact opener line "<market> ส่งใบขาวมือ <DD/MM/BBBB>". */
export function parseWhiteSheetSessionOpener(text: string): WhiteSheetSessionOpenerResult {
  const line = singleNormalizedLine(text);
  if (line === null) return { kind: "not_command" };

  const match = OPENER_RE.exec(line);
  if (!match) return { kind: "not_command" };

  const marketRaw = match[1].trim();
  const businessDate = parseBusinessDate(match[2]);
  if (!businessDate) {
    return {
      kind: "invalid",
      message: `วันที่ไม่ถูกต้อง: ${match[2]}\nกรุณาใช้รูปแบบ วว/ดด/พ.ศ. เช่น 31/07/2569`,
    };
  }

  const marketLabelNormalized = normalizedMarketLabel(marketRaw);
  if (!marketLabelNormalized) {
    return { kind: "invalid", message: `ไม่สามารถระบุตลาดจากข้อความได้: ${marketRaw}` };
  }

  return {
    kind: "ok",
    opener: {
      marketLabel: marketRaw,
      marketLabelNormalized,
      businessDate,
      businessDateDisplay: match[2],
    },
  };
}

/** Exact closer trigger "จบใบขาวมือ". */
export function isWhiteSheetSessionCloseCommand(text: string): boolean {
  return singleNormalizedLine(text) === SESSION_CLOSE_TEXT;
}

/** Exact cancel trigger "ยกเลิกใบขาวมือ". */
export function isWhiteSheetSessionCancelCommand(text: string): boolean {
  return singleNormalizedLine(text) === SESSION_CANCEL_TEXT;
}

/**
 * Parsed field values from one LINE message. `undefined` = field not present
 * in this message; number (including 0) = explicitly supplied. `other`
 * present = replace both amount and note (ค่าอื่น 0 with no note clears a
 * stale note) — same contract as WhiteSheetCloseCommand.
 */
export interface WhiteSheetSessionFieldSet {
  labor: number | undefined;
  locationFee: number | undefined;
  bag: number | undefined;
  snack: number | undefined;
  other: { amount: number; note: string | null } | undefined;
  actualCashSubmitted: number | undefined;
}

export type WhiteSheetSessionFieldParseResult =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; fields: WhiteSheetSessionFieldSet };

/**
 * Scans every line for recognized field syntax (ค่าแรง / ค่าที่ / ค่าถุง /
 * ค่าขนม / ค่าอื่น / เงินสด). Lines that don't start with a known label are
 * ignored (so an unrelated message returns "none" and falls through to the
 * rest of webhook dispatch — it is never swallowed by an open session).
 *
 * Any recognized-but-invalid line makes the WHOLE message invalid — zero
 * fields are ever applied from a partially-bad message. Within one message,
 * a later line for the same field wins over an earlier one.
 */
export function parseWhiteSheetSessionFieldLines(text: string): WhiteSheetSessionFieldParseResult {
  const lines = text
    .split("\n")
    .map(stripExportPrefix)
    .filter((line) => line.length > 0);

  const fields: WhiteSheetSessionFieldSet = {
    labor: undefined,
    locationFee: undefined,
    bag: undefined,
    snack: undefined,
    other: undefined,
    actualCashSubmitted: undefined,
  };
  let sawField = false;

  for (const line of lines) {
    const full = FIELD_LINE_RE.exec(line);
    if (full) {
      sawField = true;
      const label = full[1];
      const rest = full[2];

      if (label === FIELD_LABELS.other) {
        const parsed = parseOtherField(rest);
        if (parsed === null) {
          return { kind: "invalid", message: `จำนวนเงินไม่ถูกต้องที่บรรทัด:\n${line}` };
        }
        fields.other = parsed;
        continue;
      }

      const amount = parseCloseMoneyAmount(rest);
      if (amount === null) {
        return { kind: "invalid", message: `จำนวนเงินไม่ถูกต้องที่บรรทัด:\n${line}` };
      }

      switch (label) {
        case FIELD_LABELS.labor:
          fields.labor = amount;
          break;
        case FIELD_LABELS.locationFee:
          fields.locationFee = amount;
          break;
        case FIELD_LABELS.bag:
          fields.bag = amount;
          break;
        case FIELD_LABELS.snack:
          fields.snack = amount;
          break;
        case FIELD_LABELS.actualCash:
          fields.actualCashSubmitted = amount;
          break;
      }
      continue;
    }

    if (FIELD_LABEL_ONLY_RE.test(line)) {
      sawField = true;
      return { kind: "invalid", message: `ต้องระบุจำนวนเงินที่บรรทัด:\n${line}` };
    }
  }

  if (!sawField) return { kind: "none" };
  return { kind: "ok", fields };
}

interface SessionFieldsSnapshot {
  labor: number | null;
  location_fee: number | null;
  bag: number | null;
  snack: number | null;
  other_amount: number | null;
  other_note: string | null;
  actual_cash_submitted: number | null;
}

function fmt(value: number | null): string {
  return value === null
    ? "ยังไม่ระบุ"
    : value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Renders a session's currently-entered values for LINE replies — display only. */
export function formatWhiteSheetSessionFieldsSummary(session: SessionFieldsSnapshot): string {
  const otherLine = session.other_note
    ? `${FIELD_LABELS.other}: ${fmt(session.other_amount)} (${session.other_note})`
    : `${FIELD_LABELS.other}: ${fmt(session.other_amount)}`;
  return [
    `${FIELD_LABELS.labor}: ${fmt(session.labor)}`,
    `${FIELD_LABELS.locationFee}: ${fmt(session.location_fee)}`,
    `${FIELD_LABELS.bag}: ${fmt(session.bag)}`,
    `${FIELD_LABELS.snack}: ${fmt(session.snack)}`,
    otherLine,
    `${FIELD_LABELS.actualCash}: ${fmt(session.actual_cash_submitted)}`,
  ].join("\n");
}
