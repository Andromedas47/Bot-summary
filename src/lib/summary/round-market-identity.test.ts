/**
 * Production regression: reporting must reconcile a withdrawal and its returns
 * through the accountability round they share, not the market label each
 * document happened to carry.
 *
 * Business date 2026-08-10, round d96d2898-43f7-4eeb-9477-5e8b942da477:
 *   withdrawal   market_name = ทุ่งลานนา       (32 items)
 *   good return  market_name = วัดทุ่งลานนา    (25 items)
 *   damaged      market_name = วัดทุ่งลานนา    (9 items)
 *
 * The 08:00 report presented วัดทุ่งลานนา with เบิก 0 and raised
 * ไม่พบรายการเบิกที่ตรงกัน against a withdrawal sitting in the same round.
 */
import { describe, expect, test } from "bun:test";
import { buildDailyGoodReturnValueMessages, buildDailyGoodReturnValueReport } from "./daily-good-return-value";
import { buildMissingReturnNotices, MISSING_RETURN_HEADING } from "./pending-validation-notice";
import type { RemainingFruitSourceRow } from "./remaining-fruit";
import type { RoundReturnStatus } from "@/lib/produce/round-return-status";

const ROUND = "d96d2898-43f7-4eeb-9477-5e8b942da477";
const CANONICAL = new Map([[ROUND, { marketLabel: "ทุ่งลานนา" }]]);

const row = (overrides: Partial<RemainingFruitSourceRow>): RemainingFruitSourceRow => ({
  market_name: "ทุ่งลานนา",
  product_name: "หมอนทอง",
  quantity: 1,
  unit: "โล",
  transaction_type: "คืน",
  accountability_round_id: ROUND,
  ...overrides,
});

/** The exact Production shape: one round, two market labels. */
const driftedRound: RemainingFruitSourceRow[] = [
  row({ market_name: "ทุ่งลานนา", transaction_type: "เบิก", quantity: 20, price_per_unit: 40 }),
  row({ market_name: "วัดทุ่งลานนา", transaction_type: "คืน", quantity: 7 }),
  row({ market_name: "วัดทุ่งลานนา", transaction_type: "คืนเสีย", quantity: 2 }),
];

const status = (overrides: Partial<RoundReturnStatus> = {}): RoundReturnStatus => ({
  accountabilityRoundId: "round-x",
  sellerLabel: "ต้อม",
  marketLabel: "พาชิโอ้",
  withdrawalItemCount: 19,
  hasPersistedReturn: false,
  state: "none",
  ...overrides,
});

describe("Test 7 — good-return report reconciles on the round", () => {
  test("a return filed under the alias label still matches its withdrawal", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-10", driftedRound, CANONICAL);

    expect(report.anomalies).toEqual([]);
    expect(report.products[0]).toMatchObject({
      productName: "หมอนทอง",
      quantity: 7,
      valuedQuantity: 7,
      unvaluedQuantity: 0,
      valueSatang: 28_000,
    });
  });

  test("it can never print the drifted market with เบิก 0", () => {
    const messages = buildDailyGoodReturnValueMessages(
      buildDailyGoodReturnValueReport("2026-08-10", driftedRound, CANONICAL),
    ).join("\n");

    expect(messages).not.toContain("ไม่พบรายการเบิกที่ตรงกัน");
    expect(messages).not.toContain("เบิก 0");
    // One canonical market label reaches the reader, never the second spelling.
    expect(messages).not.toContain("วัดทุ่งลานนา");
  });

  test("the same rows WITHOUT a round still produce the old false anomaly", () => {
    // Guards the fix itself: label-keying is what Production did, and it must
    // stay reproducible so a regression is visible rather than silent. The
    // round — not the canonical-label lookup — is what repairs it.
    const report = buildDailyGoodReturnValueReport(
      "2026-08-10",
      driftedRound.map((item) => ({ ...item, accountability_round_id: null })),
    );
    expect(report.anomalies.map((item) => item.blockers).flat())
      .toContain("ไม่พบรายการเบิกที่ตรงกัน");
  });

  test("round keying alone repairs the drift, with or without the label lookup", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-10", driftedRound);
    expect(report.anomalies).toEqual([]);
  });

  test("Test 6 — a correct single-label round is unchanged by round keying", () => {
    const rows: RemainingFruitSourceRow[] = [
      row({ transaction_type: "เบิก", quantity: 20, price_per_unit: 40 }),
      row({ transaction_type: "คืน", quantity: 7 }),
    ];
    const withRound = buildDailyGoodReturnValueReport("2026-08-10", rows, CANONICAL);
    const withoutRound = buildDailyGoodReturnValueReport(
      "2026-08-10",
      rows.map((item) => ({ ...item, accountability_round_id: null })),
    );
    expect(withRound.products).toEqual(withoutRound.products);
    expect(withRound.anomalies).toEqual(withoutRound.anomalies);
  });

  test("legacy rows with no round keep their market-label identity", () => {
    const report = buildDailyGoodReturnValueReport("2026-08-10", [
      { ...row({ transaction_type: "เบิก", quantity: 20, price_per_unit: 40 }), accountability_round_id: null },
      { ...row({ transaction_type: "คืน", quantity: 5 }), accountability_round_id: null },
    ]);
    expect(report.anomalies).toEqual([]);
    expect(report.products[0]).toMatchObject({ quantity: 5, valueSatang: 20_000 });
  });

  test("two different rounds sharing a market label are still separate identities", () => {
    const other = "11111111-1111-4111-8111-111111111111";
    const report = buildDailyGoodReturnValueReport(
      "2026-08-10",
      [
        row({ transaction_type: "เบิก", quantity: 20, price_per_unit: 40 }),
        row({ accountability_round_id: other, transaction_type: "คืน", quantity: 3 }),
      ],
      new Map([...CANONICAL, [other, { marketLabel: "ทุ่งลานนา" }]]),
    );
    // The return belongs to a round that issued nothing — that IS a real
    // anomaly and must not be absorbed by a same-labelled sibling round.
    expect(report.anomalies.map((item) => item.blockers).flat())
      .toContain("ไม่พบรายการเบิกที่ตรงกัน");
  });
});

describe("missing-return notices", () => {
  test("names the market, the seller and which of the three states it is in", () => {
    const [message] = buildMissingReturnNotices([
      status({ accountabilityRoundId: "r1", marketLabel: "พาชิโอ้", sellerLabel: "ต้อม", withdrawalItemCount: 19, state: "none" }),
      status({ accountabilityRoundId: "r2", marketLabel: "ทรัพย์พัน2", sellerLabel: "มิ้น", withdrawalItemCount: 33, state: "blocked" }),
      status({ accountabilityRoundId: "r3", marketLabel: "ราชพฤกษ์", sellerLabel: "ขวัญ", withdrawalItemCount: 16, state: "pending" }),
    ]);

    expect(message).toContain(MISSING_RETURN_HEADING);
    expect(message).toContain("พาชิโอ้ — ต้อม\nเบิก 19 รายการ แต่ยังไม่พบรายการชั่งคืนที่บันทึกสำเร็จ");
    expect(message).toContain("ทรัพย์พัน2 — มิ้น\nพบการส่งชั่งคืน แต่ยังบันทึกไม่สำเร็จ เนื่องจากรายการต้องแก้ไข");
    expect(message).toContain("ราชพฤกษ์ — ขวัญ\nมีรายการชั่งคืนที่ยังปิดไม่สำเร็จ");
  });

  test("a round whose return landed is never listed", () => {
    expect(buildMissingReturnNotices([status({ hasPersistedReturn: true, state: "persisted" })]))
      .toEqual([]);
    expect(buildMissingReturnNotices([])).toEqual([]);
  });

  test("QA scopes stay out of the operational report", () => {
    expect(buildMissingReturnNotices([status({ marketLabel: "ทดสอบ", sellerLabel: "เทส" })]))
      .toEqual([]);
  });
});

describe("missing-return notice splitting", () => {
  test("splits by real code-point length instead of truncating", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      status({
        accountabilityRoundId: `r${index}`,
        marketLabel: `ตลาดทดสอบความยาว${index}`,
        sellerLabel: `คนขายหมายเลข${index}`,
      }));
    const messages = buildMissingReturnNotices(many);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages[0]).toStartWith(MISSING_RETURN_HEADING);
    expect(messages[1]).toStartWith(`${MISSING_RETURN_HEADING} (ต่อ)`);
    for (const message of messages) expect([...message].length).toBeLessThanOrEqual(1_000);
    // Every round is still reported — splitting never drops one.
    for (const round of many) expect(messages.join("\n")).toContain(round.marketLabel);
  });
});
