import {
  PURCHASE_DOCUMENT_MONEY_MAX_SCALE,
  PURCHASE_DOCUMENT_MONEY_MAX_TOTAL_DIGITS,
  type ExactDecimal,
  type ExactDocumentMoney,
} from "./types";

export type ExactDecimalParseErrorCode =
  | "INVALID_NUMERIC_FORMAT"
  | "NUMERIC_SCALE_EXCEEDED"
  | "NUMERIC_VALUE_TOO_LARGE";

export interface ExactDecimalParseError {
  code: ExactDecimalParseErrorCode;
  raw: string;
}

export type ExactDecimalParseResult =
  | { ok: true; value: ExactDecimal; errors: readonly [] }
  | { ok: false; value: null; errors: readonly ExactDecimalParseError[] };

export interface ExactDecimalLimits {
  maxTotalDigits: number;
  maxScale: number;
}

const EXACT_UNSIGNED_DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/;

function canonicalInteger(integerDigits: string): string {
  return integerDigits.replace(/^0+(?=[0-9])/u, "");
}

export function parseExactDecimal(
  raw: string,
  limits: ExactDecimalLimits,
): ExactDecimalParseResult {
  const match = EXACT_UNSIGNED_DECIMAL.exec(raw);
  if (!match) {
    return {
      ok: false,
      value: null,
      errors: [{ code: "INVALID_NUMERIC_FORMAT", raw }],
    };
  }

  const integerDigits = match[1] ?? "";
  const fractionalDigits = match[2] ?? "";
  const scale = fractionalDigits.length;
  const totalDigits = integerDigits.length + fractionalDigits.length;
  const errors: ExactDecimalParseError[] = [];

  if (scale > limits.maxScale) {
    errors.push({ code: "NUMERIC_SCALE_EXCEEDED", raw });
  }
  if (totalDigits > limits.maxTotalDigits) {
    errors.push({ code: "NUMERIC_VALUE_TOO_LARGE", raw });
  }
  if (errors.length > 0) {
    return { ok: false, value: null, errors };
  }

  const coefficientDigits = `${integerDigits}${fractionalDigits}`;
  const canonicalWhole = canonicalInteger(integerDigits);
  const canonical =
    scale === 0
      ? canonicalWhole
      : `${canonicalWhole}.${fractionalDigits}`;

  return {
    ok: true,
    errors: [],
    value: {
      raw,
      canonical,
      coefficient: BigInt(coefficientDigits),
      scale,
      totalDigits,
    },
  };
}

export type ExactDocumentMoneyParseResult =
  | { ok: true; value: ExactDocumentMoney; errors: readonly [] }
  | { ok: false; value: null; errors: readonly ExactDecimalParseError[] };

export function parseExactDocumentMoney(
  raw: string,
): ExactDocumentMoneyParseResult {
  const parsed = parseExactDecimal(raw, {
    maxTotalDigits: PURCHASE_DOCUMENT_MONEY_MAX_TOTAL_DIGITS,
    maxScale: PURCHASE_DOCUMENT_MONEY_MAX_SCALE,
  });
  if (!parsed.ok) return parsed;

  const multiplier =
    parsed.value.scale === 0
      ? BigInt("100")
      : parsed.value.scale === 1
        ? BigInt("10")
        : BigInt("1");

  return {
    ok: true,
    errors: [],
    value: {
      decimal: parsed.value,
      satang: parsed.value.coefficient * multiplier,
    },
  };
}

export function exactDecimalIsZero(value: ExactDecimal): boolean {
  return value.coefficient === BigInt(0);
}
