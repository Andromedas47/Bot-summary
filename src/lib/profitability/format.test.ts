/**
 * P3 profitability formatter tests.
 *
 * Two things are being protected here, and they are the reasons this file
 * exists at all:
 *
 *   1. An INCOMPLETE snapshot can never be read as a certified result. The
 *      warning is at the top, and every money line carries its own marker, so
 *      no partial read of the message produces a false impression.
 *   2. An exact satang string renders exactly. The report is the last place a
 *      figure can silently pass through a double, so a value far beyond
 *      Number.MAX_SAFE_INTEGER is asserted byte for byte.
 */
import { describe, expect, test } from "bun:test";
import {
  formatProfitabilitySnapshot,
  profitabilityReasonLabel,
  satangStringToBahtText,
  PROFITABILITY_CERTIFIED_HEADING,
  PROFITABILITY_COGS_LABEL,
  PROFITABILITY_DAMAGE_LOSS_LABEL,
  PROFITABILITY_INCOMPLETE_HEADING,
  PROFITABILITY_INCOMPLETE_NOTICE,
  PROFITABILITY_MONEY_UNPROVABLE,
  PROFITABILITY_OPERATING_PL_LABEL,
  PROFITABILITY_REALIZED_PL_LABEL,
  PROFITABILITY_SHORTAGE_OVERAGE_LABEL,
  PROFITABILITY_STANDARD_MARGIN_LABEL,
  PROFITABILITY_TITLE,
  PROFITABILITY_UNCERTIFIED_SUFFIX,
} from "./format";
import {
  PROFITABILITY_CALCULATION_VERSION,
  PROFITABILITY_INCOMPLETE_REASONS,
  type ProfitabilitySnapshot,
} from "./types";

const ROUND_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";

// 24 digits — far past 2^53 - 1, which has 16. A double would round this.
const HUGE_SATANG = "123456789012345678901234";
const HUGE_SATANG_BAHT = "1,234,567,890,123,456,789,012.34";

const CERTIFIED: ProfitabilitySnapshot = {
  snapshotId: SNAPSHOT_ID,
  accountabilityRoundId: ROUND_ID,
  revision: 3,
  calculationVersion: PROFITABILITY_CALCULATION_VERSION,
  inputHash: "a".repeat(64),
  certificationState: "CERTIFIED",
  incompleteReasons: [],
  supersededBySnapshotId: null,
  createdAt: "2026-08-08T03:00:00+00:00",
  issuedQuantity: "120.500000",
  goodReturnQuantity: "10.000000",
  damagedQuantity: "0.500000",
  soldQuantity: "110.000000",
  issuedCostSatang: "100000",
  goodReturnCostSatang: "1000",
  damageLossSatang: "250",
  cogsSoldSatang: "98750",
  expectedMoneySatang: "150000",
  standardMarginSatang: "51250",
  approvedExpensesSatang: "3000",
  approvedWagesSatang: "5000",
  purchasingExpensesSatang: "2000",
  expectedOperatingPlSatang: "41000",
  verifiedTransfersSatang: "40000",
  actualCashSatang: "99000",
  shortageOverageSatang: "-25000",
  realizedPlSatang: "16000",
  lines: [],
  sources: [],
};

/** Everything unprovable: the shape an operator most needs protecting from. */
const INCOMPLETE: ProfitabilitySnapshot = {
  ...CERTIFIED,
  revision: 4,
  certificationState: "INCOMPLETE",
  incompleteReasons: ["missing_central_price", "white_sheet_missing"],
  issuedCostSatang: null,
  goodReturnCostSatang: null,
  damageLossSatang: null,
  cogsSoldSatang: null,
  expectedMoneySatang: null,
  standardMarginSatang: null,
  expectedOperatingPlSatang: null,
  shortageOverageSatang: null,
  realizedPlSatang: null,
};

describe("satangStringToBahtText", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["0", "0.00"],
    ["1", "0.01"],
    ["-1", "-0.01"],
    ["9", "0.09"],
    ["99", "0.99"],
    ["100", "1.00"],
    ["150000", "1,500.00"],
    ["-25000", "-250.00"],
    ["1234567", "12,345.67"],
    ["100000000", "1,000,000.00"],
    ["-0", "0.00"],
  ];

  for (const [satang, expected] of cases) {
    test(`${satang} satang renders as ${expected}`, () => {
      expect(satangStringToBahtText(satang)).toBe(expected);
    });
  }

  test("a value larger than Number.MAX_SAFE_INTEGER renders exactly", () => {
    // Proof that no double touched it: the same value via Number() would print
    // 1,234,567,890,123,456,800,000-ish. This must be digit-for-digit exact.
    expect(satangStringToBahtText(HUGE_SATANG)).toBe(HUGE_SATANG_BAHT);
    expect(satangStringToBahtText(`-${HUGE_SATANG}`)).toBe(`-${HUGE_SATANG_BAHT}`);
    expect(Number.isSafeInteger(Number(HUGE_SATANG))).toBe(false);
  });

  test("a fractional satang is refused rather than rounded", () => {
    expect(() => satangStringToBahtText("150.5")).toThrow();
    expect(() => satangStringToBahtText("1e3")).toThrow();
    expect(() => satangStringToBahtText("")).toThrow();
    expect(() => satangStringToBahtText(1500 as unknown as string)).toThrow();
  });
});

describe("formatProfitabilitySnapshot — a CERTIFIED snapshot", () => {
  const output = formatProfitabilitySnapshot(CERTIFIED);

  test("leads with the title, the round and the revision", () => {
    expect(output.startsWith(PROFITABILITY_TITLE)).toBe(true);
    expect(output).toContain(ROUND_ID);
    expect(output).toContain("ฉบับที่ 3");
  });

  test("states the certified verdict and no incomplete warning", () => {
    expect(output).toContain(PROFITABILITY_CERTIFIED_HEADING);
    expect(output).not.toContain(PROFITABILITY_INCOMPLETE_HEADING);
    expect(output).not.toContain(PROFITABILITY_INCOMPLETE_NOTICE);
  });

  test("carries no uncertified marker on any line", () => {
    expect(output).not.toContain(PROFITABILITY_UNCERTIFIED_SUFFIX);
  });

  test("shows every required figure", () => {
    expect(output).toContain(`${PROFITABILITY_COGS_LABEL}: 987.50 บาท`);
    expect(output).toContain(`${PROFITABILITY_DAMAGE_LOSS_LABEL}: 2.50 บาท`);
    expect(output).toContain(`${PROFITABILITY_STANDARD_MARGIN_LABEL}: 512.50 บาท`);
    expect(output).toContain(`${PROFITABILITY_OPERATING_PL_LABEL}: 410.00 บาท`);
    expect(output).toContain(`${PROFITABILITY_SHORTAGE_OVERAGE_LABEL}: -250.00 บาท`);
    expect(output).toContain(`${PROFITABILITY_REALIZED_PL_LABEL}: 160.00 บาท`);
  });

  test("names the direction of the cash difference rather than only its sign", () => {
    expect(output).toContain("(เงินขาด)");
    expect(formatProfitabilitySnapshot({ ...CERTIFIED, shortageOverageSatang: "500" }))
      .toContain("(เงินเกิน)");
    expect(formatProfitabilitySnapshot({ ...CERTIFIED, shortageOverageSatang: "0" }))
      .toContain("(พอดี)");
  });

  test("an exact satang beyond a double's range reaches the report intact", () => {
    const output = formatProfitabilitySnapshot({
      ...CERTIFIED,
      realizedPlSatang: HUGE_SATANG,
    });
    expect(output).toContain(`${PROFITABILITY_REALIZED_PL_LABEL}: ${HUGE_SATANG_BAHT} บาท`);
  });
});

describe("formatProfitabilitySnapshot — an INCOMPLETE snapshot", () => {
  const output = formatProfitabilitySnapshot(INCOMPLETE);

  test("warns unmistakably at the top, before any figure", () => {
    expect(output).toContain(PROFITABILITY_INCOMPLETE_HEADING);
    expect(output).toContain(PROFITABILITY_INCOMPLETE_NOTICE);
    expect(output).not.toContain(PROFITABILITY_CERTIFIED_HEADING);
    // The warning must precede the first money label a reader meets.
    expect(output.indexOf(PROFITABILITY_INCOMPLETE_HEADING))
      .toBeLessThan(output.indexOf(PROFITABILITY_COGS_LABEL));
  });

  test("lists the reasons in plain language", () => {
    expect(output).toContain(profitabilityReasonLabel("missing_central_price"));
    expect(output).toContain(profitabilityReasonLabel("white_sheet_missing"));
  });

  test("renders every unprovable figure as an explicit marker, never 0 or a dash", () => {
    for (const label of [
      PROFITABILITY_COGS_LABEL,
      PROFITABILITY_DAMAGE_LOSS_LABEL,
      PROFITABILITY_STANDARD_MARGIN_LABEL,
      PROFITABILITY_OPERATING_PL_LABEL,
      PROFITABILITY_SHORTAGE_OVERAGE_LABEL,
      PROFITABILITY_REALIZED_PL_LABEL,
    ]) {
      expect(output).toContain(`${label}: ${PROFITABILITY_MONEY_UNPROVABLE}`);
      expect(output).not.toContain(`${label}: 0.00 บาท`);
      expect(output).not.toContain(`${label}: -`);
    }
    expect(output).not.toContain("0.00");
  });

  test("never presents a present P/L figure as certified", () => {
    // A partially-provable round: the realized P/L IS computed, but the round
    // is not certified, so the figure must still be marked.
    const partial = formatProfitabilitySnapshot({
      ...INCOMPLETE,
      cogsSoldSatang: "98750",
      realizedPlSatang: "16000",
    });
    expect(partial).toContain(
      `${PROFITABILITY_REALIZED_PL_LABEL}: 160.00 บาท ${PROFITABILITY_UNCERTIFIED_SUFFIX}`,
    );
    expect(partial).toContain(
      `${PROFITABILITY_COGS_LABEL}: 987.50 บาท ${PROFITABILITY_UNCERTIFIED_SUFFIX}`,
    );
    expect(partial).not.toContain(PROFITABILITY_CERTIFIED_HEADING);
    // Every rendered money figure carries the marker — none slips through bare.
    const bahtLines = partial
      .split("\n")
      .filter((line) => line.includes(" บาท"));
    expect(bahtLines.length).toBeGreaterThan(0);
    for (const line of bahtLines) {
      expect(line).toContain(PROFITABILITY_UNCERTIFIED_SUFFIX);
    }
  });

  test("a cash difference that is present is marked and still names its direction", () => {
    const output = formatProfitabilitySnapshot({
      ...INCOMPLETE,
      shortageOverageSatang: "-25000",
    });
    expect(output).toContain(
      `${PROFITABILITY_SHORTAGE_OVERAGE_LABEL}: -250.00 บาท ${PROFITABILITY_UNCERTIFIED_SUFFIX} (เงินขาด)`,
    );
  });
});

describe("profitabilityReasonLabel", () => {
  test("every reason the migration can emit has a non-empty Thai label", () => {
    for (const reason of PROFITABILITY_INCOMPLETE_REASONS) {
      const label = profitabilityReasonLabel(reason);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain("undefined");
    }
  });

  test("a snapshot carrying every reason renders each one as its own bullet", () => {
    const output = formatProfitabilitySnapshot({
      ...INCOMPLETE,
      incompleteReasons: [...PROFITABILITY_INCOMPLETE_REASONS],
    });
    for (const reason of PROFITABILITY_INCOMPLETE_REASONS) {
      expect(output).toContain(`• ${profitabilityReasonLabel(reason)}`);
    }
  });
});
