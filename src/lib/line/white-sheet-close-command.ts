import { parseBuddhistDate } from "@/lib/parsers/weigh-session/parser";
import { normalizedMarketLabel } from "@/lib/market";

/** Same prefix strip as webhook normalizeLine / remaining-fruit command. */
const LINE_EXPORT_PREFIX = /^\d{1,2}[:.]\d{2}\s+\S+\s+/;

const HEADER_RE =
  /^(.+?)\s+ปิดยอด\s+(\d{1,2}\/\d{1,2}\/(?:25)?\d{2})\s*$/;

const FIELD_LABELS = {
  labor: "ค่าแรง",
  locationFee: "ค่าที่",
  bag: "ค่าถุง",
  snack: "ค่าขนม",
  other: "ค่าอื่น",
  actualCash: "เงินสด",
} as const;

const FIELD_LINE_RE =
  /^(ค่าแรง|ค่าที่|ค่าถุง|ค่าขนม|ค่าอื่น|เงินสด)\s+(.+?)\s*$/;

const CLOSE_LINE = "จบปิดยอด";

const MONEY_WITH_COMMAS = /^\d{1,3}(,\d{3})*(\.\d{1,2})?$/;
const MONEY_PLAIN = /^\d+(\.\d{1,2})?$/;

/**
 * Parsed LINE closing fields. Expense keys use `undefined` when the line was
 * omitted so the close service can preserve an existing SUBMITTED value on
 * resubmission. An explicit `0` (or explicit `ค่าอื่น 0`) means the operator
 * intentionally set that field to zero.
 */
export interface WhiteSheetCloseCommand {
  marketLabel: string;
  marketLabelNormalized: string;
  businessDate: string;
  /** `undefined` = omitted; number (including 0) = explicitly supplied. */
  labor: number | undefined;
  locationFee: number | undefined;
  bag: number | undefined;
  snack: number | undefined;
  /**
   * `undefined` = ค่าอื่น line omitted (preserve other + otherNote on resubmit).
   * Present = replace both amount and note from this submission.
   */
  other: { amount: number; note: string | null } | undefined;
  /** Always required — every closing message must include เงินสด. */
  actualCashSubmitted: number;
}

export type WhiteSheetCloseParseResult =
  | { kind: "not_command" }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; command: WhiteSheetCloseCommand };

function stripExportPrefix(line: string): string {
  return line.replace(LINE_EXPORT_PREFIX, "").trim();
}

function normalizeMessageLines(text: string): string[] {
  return text
    .split("\n")
    .map(stripExportPrefix)
    .filter((line) => line.length > 0);
}

function looksLikeCloseCommand(lines: readonly string[]): boolean {
  return lines.some(
    (line) => HEADER_RE.test(line) || line === CLOSE_LINE || line.startsWith("ปิดยอด "),
  );
}

/**
 * Parses operator money strings. Accepts 300, 300.00, 1,250, 1,250.50.
 * Rejects negatives, NaN, malformed commas, and >2 decimal places.
 * Never silently "fixes" a malformed amount.
 */
export function parseCloseMoneyAmount(raw: string): number | null {
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

function parseBusinessDate(dateStr: string): string | null {
  const parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/((?:25)?\d{2})$/);
  if (!parts) return null;

  const day = Number(parts[1]);
  const month = Number(parts[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  const iso = parseBuddhistDate(parts[1], parts[2], parts[3]);
  const [year, mon, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, mon - 1, d));
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === mon - 1 &&
    date.getUTCDate() === d;
  return valid ? iso : null;
}

function parseOtherField(rest: string): { amount: number; note: string | null } | null {
  const match = rest.match(/^(\S+)(?:\s+(.+))?$/);
  if (!match) return null;
  const amount = parseCloseMoneyAmount(match[1]);
  if (amount === null) return null;
  const note = match[2]?.trim() || null;
  return { amount, note };
}

/**
 * Parses one multiline LINE White Sheet closing message.
 * Returns not_command when the message is unrelated so webhook fallthrough works.
 */
export function parseWhiteSheetCloseCommand(text: string): WhiteSheetCloseParseResult {
  const lines = normalizeMessageLines(text);
  if (lines.length === 0 || !looksLikeCloseCommand(lines)) {
    return { kind: "not_command" };
  }

  let marketRaw: string | null = null;
  let businessDate: string | null = null;
  let headerLine: string | null = null;

  const labor: number[] = [];
  const locationFee: number[] = [];
  const bag: number[] = [];
  const snack: number[] = [];
  const other: Array<{ amount: number; note: string | null }> = [];
  const actualCash: number[] = [];
  let closeCount = 0;

  for (const line of lines) {
    const header = HEADER_RE.exec(line);
    if (header) {
      if (headerLine !== null) {
        return { kind: "invalid", message: "พบหัวข้อปิดยอดซ้ำในข้อความเดียวกัน กรุณาส่งทีละตลาด" };
      }
      headerLine = line;
      marketRaw = header[1].trim();
      businessDate = parseBusinessDate(header[2]);
      if (!businessDate) {
        return {
          kind: "invalid",
          message: `วันที่ไม่ถูกต้อง: ${header[2]}\nกรุณาใช้รูปแบบ วว/ดด/พ.ศ. เช่น 24/07/2569`,
        };
      }
      continue;
    }

    if (line === CLOSE_LINE) {
      closeCount += 1;
      continue;
    }

    const field = FIELD_LINE_RE.exec(line);
    if (!field) {
      return {
        kind: "invalid",
        message: `ไม่รู้จักบรรทัดนี้ในคำสั่งปิดยอด:\n${line}`,
      };
    }

    const label = field[1];
    const rest = field[2];

    if (label === FIELD_LABELS.other) {
      const parsed = parseOtherField(rest);
      if (parsed === null) {
        return {
          kind: "invalid",
          message: `จำนวนเงินไม่ถูกต้องที่บรรทัด:\n${line}`,
        };
      }
      other.push(parsed);
      continue;
    }

    const amount = parseCloseMoneyAmount(rest);
    if (amount === null) {
      return {
        kind: "invalid",
        message: `จำนวนเงินไม่ถูกต้องที่บรรทัด:\n${line}`,
      };
    }

    switch (label) {
      case FIELD_LABELS.labor:
        labor.push(amount);
        break;
      case FIELD_LABELS.locationFee:
        locationFee.push(amount);
        break;
      case FIELD_LABELS.bag:
        bag.push(amount);
        break;
      case FIELD_LABELS.snack:
        snack.push(amount);
        break;
      case FIELD_LABELS.actualCash:
        actualCash.push(amount);
        break;
    }
  }

  if (headerLine === null || !marketRaw || !businessDate) {
    return {
      kind: "invalid",
      message: [
        "รูปแบบหัวข้อปิดยอดไม่ถูกต้อง",
        "ตัวอย่าง:",
        "ตลาดกี้ ปิดยอด 24/07/2569",
      ].join("\n"),
    };
  }

  const marketLabelNormalized = normalizedMarketLabel(marketRaw);
  if (!marketLabelNormalized) {
    return {
      kind: "invalid",
      message: `ไม่สามารถระบุตลาดจากหัวข้อได้: ${marketRaw}`,
    };
  }

  if (closeCount === 0) {
    return {
      kind: "invalid",
      message: `ต้องมีบรรทัด "${CLOSE_LINE}" ท้ายข้อความ`,
    };
  }
  if (closeCount > 1) {
    return {
      kind: "invalid",
      message: `พบ "${CLOSE_LINE}" ซ้ำ กรุณาส่งคำสั่งปิดยอดเพียงชุดเดียว`,
    };
  }

  const dup = (name: string, values: readonly unknown[]) => {
    if (values.length > 1) {
      return {
        kind: "invalid" as const,
        message: `พบ${name}ซ้ำในข้อความ กรุณาระบุเพียงบรรทัดเดียว`,
      };
    }
    return null;
  };

  for (const check of [
    dup("ค่าแรง", labor),
    dup("ค่าที่", locationFee),
    dup("ค่าถุง", bag),
    dup("ค่าขนม", snack),
    dup("ค่าอื่น", other),
    dup("เงินสด", actualCash),
  ]) {
    if (check) return check;
  }

  if (actualCash.length === 0) {
    return {
      kind: "invalid",
      message: "ต้องระบุเงินสดที่ส่งจริง เช่น\nเงินสด 4850",
    };
  }

  return {
    kind: "ok",
    command: {
      marketLabel: marketLabelNormalized,
      marketLabelNormalized,
      businessDate,
      labor: labor[0],
      locationFee: locationFee[0],
      bag: bag[0],
      snack: snack[0],
      other: other[0],
      actualCashSubmitted: actualCash[0],
    },
  };
}

/** Parse raw LINE text including export-prefixed transcript lines. */
export function parseWhiteSheetCloseCommandFromMessage(
  text: string,
): WhiteSheetCloseParseResult {
  return parseWhiteSheetCloseCommand(text);
}
