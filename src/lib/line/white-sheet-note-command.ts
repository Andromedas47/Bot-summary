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
  | {
      kind: "all_in_one";
      command: WhiteSheetNoteOpenCommand;
      fields: WhiteSheetNoteFieldValue[];
    }
  | { kind: "all_in_one_invalid"; message: string }
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

function parseOpenLine(line: string): WhiteSheetNoteOpenCommand | { invalid: string } | null {
  const open = OPEN_RE.exec(line);
  if (!open) return null;
  const marketRaw = open[1].trim();
  const businessDate = parseNoteBusinessDate(open[2]);
  if (!businessDate) {
    return {
      invalid: `วันที่ไม่ถูกต้อง: ${open[2]}\nกรุณาใช้รูปแบบ วว/ดด/พ.ศ. เช่น 01/08/2569`,
    };
  }
  return {
    marketLabel: marketRaw,
    marketLabelNormalized: normalizedMarketLabel(marketRaw),
    businessDate,
  };
}

/**
 * Collapse repeated keys so the last value wins, preserving first-seen key
 * order (Map insertion order). Used by the webhook reply builder and the
 * all-in-one submit path.
 */
export function collapseWhiteSheetNoteFields(
  fields: WhiteSheetNoteFieldValue[],
): WhiteSheetNoteFieldValue[] {
  const byKey = new Map<WhiteSheetNoteFieldKey, WhiteSheetNoteFieldValue>();
  for (const field of fields) byKey.set(field.key, field);
  return [...byKey.values()];
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Pure classification of a LINE message for the manual White Sheet note
 * session. Supports multi-line field messages and a complete all-in-one
 * message (opener + fields + จบใบขาวมือ). Never touches the database.
 */
export function parseWhiteSheetNoteCommand(text: string): WhiteSheetNoteParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "not_command" };

  if (trimmed === CLOSE_TEXT) return { kind: "close" };
  if (trimmed === CANCEL_TEXT) return { kind: "cancel" };

  const lines = nonEmptyLines(trimmed);
  if (lines.length === 0) return { kind: "not_command" };

  // All-in-one: first non-empty line is a valid opener, last is exactly
  // จบใบขาวมือ, every middle line is a valid field line.
  if (lines.length >= 2) {
    const firstOpen = parseOpenLine(lines[0]);
    const lastIsClose = lines[lines.length - 1] === CLOSE_TEXT;

    if (firstOpen !== null && lastIsClose) {
      if ("invalid" in firstOpen) {
        return { kind: "open_invalid", message: firstOpen.invalid };
      }

      const middle = lines.slice(1, -1);
      if (middle.length === 0) {
        return {
          kind: "all_in_one_invalid",
          message: "กรุณาส่งค่าใช้จ่ายอย่างน้อย 1 รายการก่อนพิมพ์ จบใบขาวมือ",
        };
      }

      for (const line of middle) {
        if (line === CLOSE_TEXT) {
          return {
            kind: "all_in_one_invalid",
            message: `จำนวนเงินไม่ถูกต้องที่บรรทัด:\n${line}`,
          };
        }
        if (parseOpenLine(line) !== null) {
          return {
            kind: "all_in_one_invalid",
            message: `จำนวนเงินไม่ถูกต้องที่บรรทัด:\n${line}`,
          };
        }
        const parsed = parseOneFieldLine(line);
        if (parsed.kind !== "field") {
          return {
            kind: "all_in_one_invalid",
            message: `จำนวนเงินไม่ถูกต้องที่บรรทัด:\n${line}`,
          };
        }
      }

      return {
        kind: "all_in_one",
        command: firstOpen,
        fields: middle.map((line) => {
          const parsed = parseOneFieldLine(line) as Extract<FieldLineParse, { kind: "field" }>;
          return parsed.field;
        }),
      };
    }

    // Opener-shaped first line without a closing line is not all-in-one and
    // must not open a session (preserve single-line opener behavior only).
    if (firstOpen !== null && !lastIsClose) {
      if ("invalid" in firstOpen) {
        return { kind: "open_invalid", message: firstOpen.invalid };
      }
      return {
        kind: "all_in_one_invalid",
        message:
          "กรุณาพิมพ์ จบใบขาวมือ เป็นบรรทัดสุดท้ายเมื่อส่งใบขาวมือครบในข้อความเดียว",
      };
    }
  }

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
