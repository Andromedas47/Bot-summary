import { parseBuddhistDate } from "@/lib/parsers/weigh-session/parser";
import { normalizedMarketLabel } from "@/lib/market";

// ── Open: "<market> ส่งใบขาวมือ <DD/MM/BBBB>" ────────────────────────────────
const OPEN_RE = /^(.+?)\s+ส่งใบขาวมือ\s+(\d{1,2}\/\d{1,2}\/(?:25)?\d{2})\s*$/;

const CLOSE_TEXT = "จบใบขาวมือ";
const CANCEL_TEXT = "ยกเลิกใบขาวมือ";

export const FIELD_LABELS = {
  labor: "ค่าแรง",
  locationFee: "ค่าที่",
  bag: "ค่าถุง",
  snack: "ค่าขนม",
  other: "ค่าอื่น",
  actualCash: "เงินสด",
} as const;

const FIELD_LINE_RE = /^(ค่าแรง|ค่าที่|ค่าถุง|ค่าขนม|ค่าอื่น|เงินสด)\s+(.+?)\s*$/;

const MONEY_WITH_COMMAS = /^\d{1,3}(,\d{3})*(\.\d{1,2})?$/;
const MONEY_PLAIN = /^\d+(\.\d{1,2})?$/;

/** Accepts 300, 300.00, 1,250, 1,250.50. Rejects negatives, NaN, malformed input. */
export function parseNoteMoneyAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;

  const pattern = trimmed.includes(",") ? MONEY_WITH_COMMAS : MONEY_PLAIN;
  if (!pattern.test(trimmed)) return null;

  const value = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 0) return null;

  const cents = value * 100;
  if (Math.abs(cents - Math.round(cents)) >= 1e-6) return null;

  return Math.round(cents) / 100;
}

export interface WhiteSheetNoteOpenCommand {
  marketLabel: string;
  marketLabelNormalized: string;
  businessDate: string;
}

export type WhiteSheetNoteFieldKey =
  | "labor"
  | "locationFee"
  | "bag"
  | "snack"
  | "other"
  | "actualCash";

export interface WhiteSheetNoteFieldValue {
  key: WhiteSheetNoteFieldKey;
  amount: number;
  note: string | null;
}

export type WhiteSheetNoteParseResult =
  | { kind: "not_command" }
  | { kind: "open"; command: WhiteSheetNoteOpenCommand }
  | { kind: "open_invalid"; message: string }
  | { kind: "field"; fields: WhiteSheetNoteFieldValue[] }
  | { kind: "field_invalid"; message: string }
  | { kind: "close" }
  | { kind: "cancel" };

/** Shared Buddhist-date parse/validate contract for the note open command. */
export function parseNoteBusinessDate(dateStr: string): string | null {
  const parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/((?:25)?\d{2})$/);
  if (!parts) return null;

  const day = Number(parts[1]);
  const month = Number(parts[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  const iso = parseBuddhistDate(parts[1], parts[2], parts[3]);
  const [year, mon, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, mon - 1, d));
  const valid =
    date.getUTCFullYear() === year
    && date.getUTCMonth() === mon - 1
    && date.getUTCDate() === d;
  return valid ? iso : null;
}

function parseOtherField(rest: string): { amount: number; note: string | null } | null {
  const match = rest.match(/^(\S+)(?:\s+(.+))?$/);
  if (!match) return null;
  const amount = parseNoteMoneyAmount(match[1]);
  if (amount === null) return null;
  const note = match[2]?.trim() || null;
  return { amount, note };
}

const FIELD_KEY_BY_LABEL: Record<string, WhiteSheetNoteFieldKey> = {
  [FIELD_LABELS.labor]: "labor",
  [FIELD_LABELS.locationFee]: "locationFee",
  [FIELD_LABELS.bag]: "bag",
  [FIELD_LABELS.snack]: "snack",
  [FIELD_LABELS.other]: "other",
  [FIELD_LABELS.actualCash]: "actualCash",
};

type FieldLineParse =
  | { kind: "field"; field: WhiteSheetNoteFieldValue }
  | { kind: "invalid"; line: string }
  | { kind: "not_field" };

/** Parse one already-trimmed non-empty line as a White Sheet field. */
function parseOneFieldLine(line: string): FieldLineParse {
  const field = FIELD_LINE_RE.exec(line);
  if (!field) return { kind: "not_field" };

  const key = FIELD_KEY_BY_LABEL[field[1]];
  const rest = field[2];

  if (key === "other") {
    const parsed = parseOtherField(rest);
    if (parsed === null) return { kind: "invalid", line };
    return { kind: "field", field: { key, amount: parsed.amount, note: parsed.note } };
  }

  const amount = parseNoteMoneyAmount(rest);
  if (amount === null) return { kind: "invalid", line };
  return { kind: "field", field: { key, amount, note: null } };
}

/**
 * Collapse repeated keys so the last value wins, preserving first-seen key
 * order (Map insertion order). Used by the webhook reply builder.
 */
export function collapseWhiteSheetNoteFields(
  fields: WhiteSheetNoteFieldValue[],
): WhiteSheetNoteFieldValue[] {
  const byKey = new Map<WhiteSheetNoteFieldKey, WhiteSheetNoteFieldValue>();
  for (const field of fields) byKey.set(field.key, field);
  return [...byKey.values()];
}

/**
 * Pure classification of a LINE message for the manual White Sheet note
 * session. Supports multi-line field messages (CRLF/LF, blank lines ignored).
 * Never touches the database — the webhook checks for an open session only
 * after this returns something other than not_command.
 */
export function parseWhiteSheetNoteCommand(text: string): WhiteSheetNoteParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "not_command" };

  if (trimmed === CLOSE_TEXT) return { kind: "close" };
  if (trimmed === CANCEL_TEXT) return { kind: "cancel" };

  const open = OPEN_RE.exec(trimmed);
  if (open) {
    const marketRaw = open[1].trim();
    const businessDate = parseNoteBusinessDate(open[2]);
    if (!businessDate) {
      return {
        kind: "open_invalid",
        message: `วันที่ไม่ถูกต้อง: ${open[2]}\nกรุณาใช้รูปแบบ วว/ดด/พ.ศ. เช่น 01/08/2569`,
      };
    }
    return {
      kind: "open",
      command: {
        marketLabel: marketRaw,
        marketLabelNormalized: normalizedMarketLabel(marketRaw),
        businessDate,
      },
    };
  }

  // Field messages: every non-empty line must be a valid field line. Mixed
  // valid+invalid (or field + unrelated) rejects the whole message with zero
  // DB mutation. Completely unrelated text stays not_command.
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return { kind: "not_command" };

  const parsedLines = lines.map(parseOneFieldLine);

  if (parsedLines.every((p) => p.kind === "field")) {
    return {
      kind: "field",
      fields: parsedLines.map((p) => (p as Extract<FieldLineParse, { kind: "field" }>).field),
    };
  }

  const anyFieldShaped = parsedLines.some((p) => p.kind === "field" || p.kind === "invalid");
  if (!anyFieldShaped) return { kind: "not_command" };

  const invalid = parsedLines.find((p) => p.kind === "invalid") as
    | Extract<FieldLineParse, { kind: "invalid" }>
    | undefined;
  const notFieldLine = lines.find((_, i) => parsedLines[i]?.kind === "not_field");
  return {
    kind: "field_invalid",
    message: `จำนวนเงินไม่ถูกต้องที่บรรทัด:\n${invalid?.line ?? notFieldLine ?? lines[0]}`,
  };
}
