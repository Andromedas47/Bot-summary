/**
 * Read-only duplicate detection — cases O and P of the hotfix.
 *
 * Rows are shaped exactly as `produce_transactions` returns them, including
 * Postgres numeric strings ("3.000"), because the detector has to agree with
 * the write-path fingerprint digit for digit.
 */
import { describe, expect, it } from "bun:test";
import { detectDuplicateAnomalies, type DuplicateScanRow } from "./duplicate-detector";

const DATE = "2026-08-14";

function row(
  sessionId: string,
  roundId: string,
  seller: string,
  market: string,
  product: string,
  quantity: string,
  price: string,
  unit = "โล",
  transactionType = "เบิก",
): DuplicateScanRow {
  return {
    session_id: sessionId,
    accountability_round_id: roundId,
    staff_name: seller,
    market_name: market,
    product_name: product,
    unit,
    quantity,
    price_per_unit: price,
    transaction_type: transactionType,
  };
}

// ── CASE O — the แทน exact duplicate ────────────────────────────────────────

const ROUND_A = "d5ae8a20-6e41-4293-8065-dcfab9ff2b97";
const ROUND_B = "0874d4f3-9e6a-4aba-afad-02f6c848fcaf";
const SESSION_A = "c180b94d-8072-4fa1-8a63-d168a9acad17";
const SESSION_B = "26546974-8a79-419c-baf4-192983fdd7bb";

function tanRows(sessionId: string, roundId: string, avocado: string): DuplicateScanRow[] {
  return [
    row(sessionId, roundId, "แทน", "ราชพฤก", "ฝรั่งแดง", "0.090", "300.00"),
    row(sessionId, roundId, "แทน", "ราชพฤก", avocado, "3.000", "50.00"),
    row(sessionId, roundId, "แทน", "ราชพฤก", "องุ่นดำ", "1.900", "50.00"),
    row(sessionId, roundId, "แทน", "ราชพฤก", "สับปะรด", "16.000", "50.00", "ลูก"),
  ];
}

describe("CASE O — historical exact duplicate detection", () => {
  it("identifies the two แทน withdrawal sessions as one business withdrawal", () => {
    const anomalies = detectDuplicateAnomalies(DATE, [
      // The only difference in Production was the avocado spelling.
      ...tanRows(SESSION_A, ROUND_A, "อะโวคาโด"),
      ...tanRows(SESSION_B, ROUND_B, "อะโวคาโด้"),
    ]);

    expect(anomalies).toHaveLength(1);
    const [anomaly] = anomalies;
    if (anomaly.kind !== "exact_duplicate_withdrawal") throw new Error("expected exact duplicate");
    expect(anomaly.sessions.map((session) => session.sessionId).sort())
      .toEqual([SESSION_B, SESSION_A].sort());
    expect(anomaly.sessions.map((session) => session.accountabilityRoundId).sort())
      .toEqual([ROUND_B, ROUND_A].sort());
    expect(new Set(anomaly.sessions.map((session) => session.fingerprint)).size).toBe(1);
  });

  it("does not flag two withdrawals that differ in a quantity", () => {
    const changed = tanRows(SESSION_B, ROUND_B, "อะโวคาโด")
      .map((r) => (r.product_name === "องุ่นดำ" ? { ...r, quantity: "2.400" } : r));

    expect(detectDuplicateAnomalies(DATE, [
      ...tanRows(SESSION_A, ROUND_A, "อะโวคาโด"),
      ...changed,
    ])).toEqual([]);
  });

  it("does not flag the same items under a different seller", () => {
    expect(detectDuplicateAnomalies(DATE, [
      ...tanRows(SESSION_A, ROUND_A, "อะโวคาโด"),
      ...tanRows(SESSION_B, ROUND_B, "อะโวคาโด").map((r) => ({ ...r, staff_name: "จิ๋ว" })),
    ])).toEqual([]);
  });

  it("ignores returns — only withdrawals can inflate sales twice", () => {
    const returns = tanRows(SESSION_B, ROUND_B, "อะโวคาโด")
      .map((r) => ({ ...r, transaction_type: "คืน" }));

    expect(detectDuplicateAnomalies(DATE, [
      ...tanRows(SESSION_A, ROUND_A, "อะโวคาโด"),
      ...returns,
    ])).toEqual([]);
  });
});

// ── CASE P — the ป้าลี / ขวัญ / โด้ composite overlap ───────────────────────

const PALEE_ROUND = "1846c8a3-3c46-4181-92b7-fc85a1834c20";
const KWAN_ROUND = "69e0770b-9cea-4273-99c3-2ae40d98ca9e";
const DO_ROUND = "bbf1c5bf-460f-451f-a64a-41f2a43a1338";

/** The fruit block (ขวัญ) and the durian block (โด้), as one whole for ป้าลี. */
const FRUIT = [
  ["มะม่วงเขียวมรกต", "13.500", "30.00", "โล"],
  ["แตงโม", "10.000", "35.00", "ลูก"],
  ["อะโวคาโด้", "32.500", "50.00", "โล"],
] as const;
const DURIAN = [
  ["หมอนทอง", "12.000", "100.00", "โล"],
  ["ชะนี", "8.000", "119.00", "โล"],
] as const;

function block(
  entries: ReadonlyArray<readonly [string, string, string, string]>,
  sessionId: string,
  roundId: string,
  seller: string,
  market: string,
  overrides: Partial<Record<string, string>> = {},
): DuplicateScanRow[] {
  return entries.map(([product, quantity, price, unit]) =>
    row(sessionId, roundId, seller, market, overrides[product] ?? product, quantity, price, unit));
}

describe("CASE P — composite duplicate detection", () => {
  const wholeRows = [
    ...block(FRUIT, "s-palee", PALEE_ROUND, "ป้าลี", "ตลาด72", { "อะโวคาโด้": "อะโวคาโด" }),
    ...block(DURIAN, "s-palee", PALEE_ROUND, "ป้าลี", "ตลาด72"),
  ];
  const partRows = [
    ...block(FRUIT, "s-kwan", KWAN_ROUND, "ขวัญ", "72ผลไม้"),
    ...block(DURIAN, "s-do", DO_ROUND, "โด้", "72ทุเรียน"),
  ];

  it("flags ป้าลี = ขวัญ + โด้ as a possible composite duplicate", () => {
    const anomalies = detectDuplicateAnomalies(DATE, [...wholeRows, ...partRows]);

    expect(anomalies).toHaveLength(1);
    const [anomaly] = anomalies;
    if (anomaly.kind !== "possible_composite_duplicate") {
      throw new Error("expected a composite duplicate");
    }
    expect(anomaly.whole.sessionId).toBe("s-palee");
    expect(anomaly.whole.accountabilityRoundId).toBe(PALEE_ROUND);
    expect(anomaly.whole.itemCount).toBe(5);
    expect(anomaly.parts.map((part) => part.sessionId).sort()).toEqual(["s-do", "s-kwan"]);
    expect(anomaly.parts.map((part) => part.accountabilityRoundId).sort())
      .toEqual([KWAN_ROUND, DO_ROUND].sort());
    // Evidence carries both identities. Nothing merged them.
    expect(anomaly.parts.map((part) => part.sellerLabel).sort()).toEqual(["ขวัญ", "โด้"].sort());
  });

  it("never merges or rebinds the distinct seller identities", () => {
    const before = JSON.stringify([...wholeRows, ...partRows]);
    const rows = [...wholeRows, ...partRows];
    detectDuplicateAnomalies(DATE, rows);
    // The detector is pure: its input is untouched and it returns evidence only.
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("does not flag parts that do not cover the whole exactly", () => {
    const short = partRows.filter((r) => r.product_name !== "ชะนี");
    expect(detectDuplicateAnomalies(DATE, [...wholeRows, ...short])).toEqual([]);
  });

  it("does not flag a single session that merely overlaps", () => {
    const overlapOnly = block(FRUIT, "s-kwan", KWAN_ROUND, "ขวัญ", "72ผลไม้");
    expect(detectDuplicateAnomalies(DATE, [...wholeRows, ...overlapOnly])).toEqual([]);
  });

  it("returns nothing for an ordinary day", () => {
    expect(detectDuplicateAnomalies(DATE, wholeRows)).toEqual([]);
  });
});

describe("what the detector must not flag", () => {
  it("ignores an additional (เบิกเพิ่ม) batch that repeats the main withdrawal", () => {
    // The ingest gate deliberately allows this — two intentional additional
    // batches with identical content both persist — so the detector must not
    // block the day for it.
    const main = tanRows(SESSION_A, ROUND_A, "อะโวคาโด");
    const additional = tanRows("s-additional", ROUND_A, "อะโวคาโด")
      .map((r) => ({ ...r, session_kind: "additional" }));

    expect(detectDuplicateAnomalies(DATE, [...main, ...additional])).toEqual([]);
  });
});
