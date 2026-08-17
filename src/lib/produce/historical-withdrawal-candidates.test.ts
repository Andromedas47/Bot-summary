/**
 * The historical arm of the containment guard proposes candidates; the RPC
 * decides. What must be exact here is the CONTENT: the canonical lines derived
 * from persisted `produce_items` have to be the same strings the ingest path
 * would have stored, or a real superset resend slips through.
 */
import { describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { canonicalWithdrawalItemLines } from "@/lib/produce/business-fingerprint";
import { loadHistoricalWithdrawalCandidates } from "@/lib/produce/historical-withdrawal-candidates";

const ISO_DATE = "2026-08-16";
const DATE = "16/8/2569";
const SELLER = "โด้";
const MARKET = "ตลาด72";

const DURIAN_TEXT = [
  `${SELLER}-${MARKET} เบิก ${DATE}`,
  "1.หมอนทอง100บาท", "3.9โล",
  "2.หมอนทอง100บาท", "23.2โล",
  "จบรายการเบิก",
].join("\n");

const parsed = parseWeighSession(DURIAN_TEXT, ISO_DATE);

/** The persisted shape of the document above, as `produce_items` holds it. */
const PERSISTED_ITEMS = parsed.items.map((item) => ({
  session_id: "session-1",
  product_name: item.product_name,
  unit: item.unit,
  quantity: item.quantity,
  price_per_unit: item.price_per_unit,
  transaction_type: item.transaction_type,
  basis_quantity: item.basis_quantity,
  basis_unit: item.basis_unit,
  basis_price: item.basis_price,
}));

interface FakeOptions {
  sessions?: Array<Record<string, unknown>>;
  items?: Array<Record<string, unknown>>;
  sessionError?: { message: string };
  itemError?: { message: string };
}

function fakeDb(options: FakeOptions = {}) {
  const sessions = options.sessions ?? [
    { id: "session-1", staff_name: SELLER, session_title: MARKET, session_kind: "main" },
  ];
  const items = options.items ?? PERSISTED_ITEMS;
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        in: () => Promise.resolve({
          data: items,
          error: options.itemError ?? null,
        }),
        limit: () => Promise.resolve({
          data: sessions,
          error: options.sessionError ?? null,
        }),
      };
      void table;
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const input = {
  sessionDate: ISO_DATE,
  staffName: SELLER,
  marketLabel: MARKET,
  canonicalLines: canonicalWithdrawalItemLines(parsed),
};

describe("historical withdrawal candidates", () => {
  it("derives EXACTLY the lines the ingest path would have stored", async () => {
    // The whole design rests on this: the persisted-row adapter and the parsed-
    // document adapter are one canonicalizer, so a historical session compares
    // like-for-like against a new document.
    const candidates = await loadHistoricalWithdrawalCandidates(fakeDb(), input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      produce_session_id: "session-1",
      lines: canonicalWithdrawalItemLines(parsed)!,
      item_count: 2,
    });
  });

  it("proposes nothing for a document that is not a plain base withdrawal", async () => {
    const append = parseWeighSession(DURIAN_TEXT.replaceAll("เบิก", "เบิกเพิ่ม"), ISO_DATE);
    expect(canonicalWithdrawalItemLines(append)).toBeNull();
    expect(await loadHistoricalWithdrawalCandidates(fakeDb(), {
      ...input,
      canonicalLines: canonicalWithdrawalItemLines(append),
    })).toEqual([]);
  });

  it("proposes nothing without a business date, seller or market", async () => {
    for (const override of [
      { sessionDate: null },
      { sessionDate: "  " },
      { staffName: null },
      { marketLabel: null },
    ]) {
      expect(await loadHistoricalWithdrawalCandidates(fakeDb(), { ...input, ...override }))
        .toEqual([]);
    }
  });

  it("skips a session whose seller or market is a different identity", async () => {
    for (const session of [
      { id: "s", staff_name: "มิ้น", session_title: MARKET, session_kind: "main" },
      { id: "s", staff_name: SELLER, session_title: "ราชพฤก", session_kind: "main" },
    ]) {
      expect(await loadHistoricalWithdrawalCandidates(fakeDb({ sessions: [session] }), input))
        .toEqual([]);
    }
  });

  it("treats a reviewed market alias as the same market", async () => {
    const aliased = parseWeighSession(
      DURIAN_TEXT.replace(MARKET, "พาซีโอ้"),
      ISO_DATE,
    );
    const candidates = await loadHistoricalWithdrawalCandidates(
      fakeDb({
        sessions: [{
          id: "session-1", staff_name: SELLER, session_title: "พาซิโอ้", session_kind: "main",
        }],
      }),
      {
        sessionDate: ISO_DATE,
        staffName: SELLER,
        marketLabel: "พาซีโอ้",
        canonicalLines: canonicalWithdrawalItemLines(aliased),
      },
    );
    expect(candidates).toHaveLength(1);
  });

  it("skips an additional session and a session with a non-withdrawal item", async () => {
    expect(await loadHistoricalWithdrawalCandidates(fakeDb({
      sessions: [{
        id: "session-1", staff_name: SELLER, session_title: MARKET, session_kind: "additional",
      }],
    }), input)).toEqual([]);

    expect(await loadHistoricalWithdrawalCandidates(fakeDb({
      items: [
        PERSISTED_ITEMS[0]!,
        { ...PERSISTED_ITEMS[1]!, transaction_type: "ชั่งคืน" },
      ],
    }), input)).toEqual([]);
  });

  it("proposes nothing when either read fails, rather than failing the finalization", async () => {
    expect(await loadHistoricalWithdrawalCandidates(
      fakeDb({ sessionError: { message: "boom" } }),
      input,
    )).toEqual([]);
    expect(await loadHistoricalWithdrawalCandidates(
      fakeDb({ itemError: { message: "boom" } }),
      input,
    )).toEqual([]);
  });

  it("proposes nothing when the client cannot express the query at all", async () => {
    // An older or partial client is a read failure, not a reason to lose a
    // finalization that has otherwise succeeded.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken = { from: () => ({ select: () => ({}) }) } as any;
    expect(await loadHistoricalWithdrawalCandidates(broken, input)).toEqual([]);
  });
});
