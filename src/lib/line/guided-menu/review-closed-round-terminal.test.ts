/**
 * PR #15 review — "make `closed` truly terminal".
 *
 * Uses the REAL `GuidedJourneyService` against a full fake database (not a
 * hand-built `GuidedJourneyState`), so this proves the actual resolver
 * ordering: a round whose settlement was already sent must resolve `closed`
 * even when a new slip batch is opened afterward, and every write-adjacent
 * guided guard (White Sheet close, slip open) must refuse against it.
 */

import { describe, expect, it } from "bun:test";
import { GuidedJourneyService } from "./journey";
import { resolveGuidedOwnership } from "./ownership-guard";
import { guardGuidedSlipOpen } from "./slip-open-guard";
import { guardGuidedWhiteSheetSubmission } from "./journey-bridge";
import { signGuidedMarker } from "./provenance";
import { GuidedMenuFakeDatabase } from "./test-fake-db";
import { GUIDED_MENU_COPY } from "./ux-types";
import type { GuidedMenuIdentity } from "./ux-types";
import type { WhiteSheetCloseCommand } from "@/lib/line/white-sheet-close-command";
import type { SlipSessionHeader } from "@/lib/slips/slip-session-service";

process.env.LINE_CHANNEL_SECRET ??= "test-channel-secret";

const SOURCE = "G-1";
const DATE = "2026-07-29";
const MARKET = "วัดทุ่งลานนา";
const SELLER = "กี้";
const SESSION_KEY = `group:${SOURCE}:user:U-op-1`;

const IDENTITY: GuidedMenuIdentity = {
  lineUserId: "U-op-1",
  sourceType: "group",
  sourceId: SOURCE,
  sessionKey: SESSION_KEY,
};

function seedCatalog(db: GuidedMenuFakeDatabase): void {
  db.seedOperator({ line_user_id: IDENTITY.lineUserId, staff_label: SELLER, active: true });
  db.seedMarket({ market_code: "wat", label: MARKET, active: true });
  db.seedSeller({ seller_code: "kee", label: SELLER, active: true, sort_order: 1 });
  db.seedSellerMarket({ seller_code: "kee", market_code: "wat", active: true, sort_order: 1 });
}

/** A fully-proven round standing at `reconcile`/`closed` — produce done, sheet in. */
function seedProvenRound(db: GuidedMenuFakeDatabase): void {
  db.seedPendingSession({
    session_key: SESSION_KEY,
    source_id: SOURCE,
    line_user_id: IDENTITY.lineUserId,
    session_generation: "gen-1",
    accumulated_text: "1.ทุเรียน100บาท\n2โล",
    terminalized: true,
    close_event_timestamp_ms: Date.parse("2026-07-29T10:00:00+07:00"),
    finalize_confirmed_at: "2026-07-29T04:00:00Z",
    finalization_status: "finalized",
    opened_line_event_id: "evt-open",
    entry_origin: "structured_menu",
    business_date: DATE,
    transaction_time: "10:00",
    transaction_time_source: "line_event",
    staff_label: SELLER,
    market_label: MARKET,
    session_kind: "main",
    initial_transaction_type: "เบิก",
    declared_transaction_type: null,
    additional_opener: null,
  });
  db.tables.produce_sessions = [
    { id: "produce-1", ingest_idempotency_key: `${SESSION_KEY}:gen-1` },
  ];
  db.tables.digital_white_sheet_cash_entries = [
    {
      source_id: SOURCE,
      market_label_normalized: MARKET,
      business_date: DATE,
      labor: 0,
      location_fee: 0,
      bag: 0,
      snack: 0,
      other: 0,
      other_note: null,
      actual_cash_submitted: 0,
      updated_at: `${DATE}T05:00:00Z`,
      finalized_at: null,
      finalized_by: null,
    },
  ];
}

function seedSentSettlement(db: GuidedMenuFakeDatabase): void {
  db.tables.settlement_finalizations = [
    { source_id: SOURCE, business_date: DATE, status: "sent", message_sent_at: `${DATE}T09:00:00Z` },
  ];
}

const COMMAND: WhiteSheetCloseCommand = {
  marketLabel: MARKET,
  marketLabelNormalized: MARKET,
  businessDate: DATE,
  labor: 0,
  locationFee: 0,
  bag: 0,
  snack: 0,
  other: undefined,
  actualCashSubmitted: 0,
};

function header(): SlipSessionHeader {
  return {
    sellerName: SELLER,
    marketName: MARKET,
    slipDate: "29/07/2569",
    rawHeaderText: `${SELLER} ${MARKET} สลิปเงินโอน 29/07/2569`,
    batchType: "TRANSFER_SLIPS",
  };
}

const CATALOG_OK = { isActiveSellerMarket: async () => true };

describe("resolver: closed is checked before open slip work", () => {
  it("resolves closed once the settlement was sent", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedCatalog(db);
    seedProvenRound(db);
    seedSentSettlement(db);

    const state = await new GuidedJourneyService(db.asClient()).resolve(IDENTITY);
    expect(state.stage).toBe("closed");
  });

  it("stays closed even when a new slip batch is opened afterward", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedCatalog(db);
    seedProvenRound(db);
    seedSentSettlement(db);
    db.tables.slip_batches = [{ id: "b1", source_id: SOURCE, status: "collecting" }];

    const state = await new GuidedJourneyService(db.asClient()).resolve(IDENTITY);
    expect(state.stage).toBe("closed");
  });

  it("resolves reconcile, not closed, while nothing has been sent", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedCatalog(db);
    seedProvenRound(db);

    const state = await new GuidedJourneyService(db.asClient()).resolve(IDENTITY);
    expect(state.stage).toBe("reconcile");
  });

  it("resolves slips while a batch is open and nothing has been sent", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedCatalog(db);
    seedProvenRound(db);
    db.tables.slip_batches = [{ id: "b1", source_id: SOURCE, status: "collecting" }];

    const state = await new GuidedJourneyService(db.asClient()).resolve(IDENTITY);
    expect(state.stage).toBe("slips");
  });
});

describe("write-adjacent guards reject a closed round", () => {
  it("resolveGuidedOwnership refuses for every purpose, unmarked", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedCatalog(db);
    seedProvenRound(db);
    seedSentSettlement(db);
    const journey = new GuidedJourneyService(db.asClient());

    for (const purpose of ["white_sheet", "slip_open", "settlement"] as const) {
      const verdict = await resolveGuidedOwnership({
        journey,
        identity: IDENTITY,
        target: { marketLabelNormalized: MARKET, businessDate: DATE },
        purpose,
      });
      expect(verdict.verdict).toBe("refused");
      if (verdict.verdict !== "refused") continue;
      expect(verdict.message).toContain(GUIDED_MENU_COPY.ownershipRoundClosed);
      // A lifecycle refusal, not a marker one — no regenerate offer.
      expect(verdict.reason).toBeUndefined();
      expect(verdict.regenerate).toBeUndefined();
    }
  });

  it("refuses to open a new slip batch against a closed round", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedCatalog(db);
    seedProvenRound(db);
    seedSentSettlement(db);
    const journey = new GuidedJourneyService(db.asClient());

    const guard = await guardGuidedSlipOpen({
      journey,
      catalog: CATALOG_OK,
      identity: IDENTITY,
      header: header(),
    });
    expect(guard.verdict).toBe("refused");
    if (guard.verdict !== "refused") return;
    expect(guard.message).toContain(GUIDED_MENU_COPY.ownershipRoundClosed);
    expect(db.tables.slip_batches ?? []).toHaveLength(0);
  });

  it("refuses to close a White Sheet against a closed round", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedCatalog(db);
    seedProvenRound(db);
    seedSentSettlement(db);
    const journey = new GuidedJourneyService(db.asClient());

    const guard = await guardGuidedWhiteSheetSubmission({
      journey,
      identity: IDENTITY,
      command: COMMAND,
    });
    expect(guard.verdict).toBe("refused");
    if (guard.verdict !== "refused") return;
    expect(guard.message).toContain(GUIDED_MENU_COPY.ownershipRoundClosed);
  });

  it("refuses a marked template resubmitted against a now-closed round — no template, no write", async () => {
    const db = new GuidedMenuFakeDatabase();
    seedCatalog(db);
    seedProvenRound(db);
    seedSentSettlement(db);
    const journey = new GuidedJourneyService(db.asClient());

    const marker = signGuidedMarker({
      purpose: "white_sheet",
      sourceId: SOURCE,
      lineUserId: IDENTITY.lineUserId,
      marketLabelNormalized: MARKET,
      businessDate: DATE,
      sessionGeneration: "gen-1",
    });
    expect(marker).toBeTruthy();

    const guard = await guardGuidedWhiteSheetSubmission({
      journey,
      identity: IDENTITY,
      command: COMMAND,
      marker,
    });
    expect(guard.verdict).toBe("refused");
    if (guard.verdict !== "refused") return;
    // Refused as a lifecycle terminal state — never offered a "fresh form".
    expect(guard.reason).toBeUndefined();
    expect(guard.regenerate).toBeUndefined();
    expect(db.tables.digital_white_sheet_cash_entries).toHaveLength(1);
  });
});
