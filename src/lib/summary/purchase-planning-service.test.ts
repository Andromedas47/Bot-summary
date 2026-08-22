import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { HOUSE_STOCK_PRICED_PARSER_VERSION } from "@/lib/physical-inventory/types";
import { loadPurchasePlanningReport } from "./purchase-planning-service";
import { FakeDatabase, type Row } from "./test-fake-supabase";

const BUSINESS_DATE = "2026-08-21";
const ROUND = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function produceRow(overrides: Row = {}): Row {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    session_id: "session-1",
    market_name: "ตลาด72",
    staff_name: "โอม",
    product_name: "แอปเปิ้ล",
    quantity: 100,
    unit: "ลูก",
    transaction_type: "เบิก",
    base_transaction_type: "เบิก",
    price_per_unit: 20,
    raw_message_id: "raw-seed-1",
    session_kind: "main",
    item_created_at: "2026-08-21T02:00:00.000Z",
    accountability_round_id: ROUND,
    transaction_date: BUSINESS_DATE,
    ...overrides,
  };
}

function snapshotRow(overrides: Row = {}): Row {
  return {
    id: SNAPSHOT,
    business_date: BUSINESS_DATE,
    warehouse_code: "MAIN",
    status: "finalized",
    parser_version: HOUSE_STOCK_PRICED_PARSER_VERSION,
    replacement_snapshot_id: null,
    ...overrides,
  };
}

function itemRow(overrides: Row = {}): Row {
  return {
    id: `stock-${Math.random().toString(36).slice(2)}`,
    snapshot_id: SNAPSHOT,
    item_ordinal: 1,
    raw_text: "แอปเปิ้ล 10 ลูก 20 บาท",
    raw_product_description: "แอปเปิ้ล",
    normalized_product: "แอปเปิ้ล",
    quantity: 10,
    unit_price_satang: 2_000,
    raw_unit: "ลูก",
    normalized_unit: "ลูก",
    resolution_status: "ACCEPTED_NORMALIZED",
    reason: null,
    ...overrides,
  };
}

/** 100 out, 20 weighed back → 80 sold → 80%, a HIGH seller. */
function highSellingDay(db = new FakeDatabase()): FakeDatabase {
  return db
    .seed("produce_transactions", [
      produceRow({ transaction_type: "เบิก", quantity: 100 }),
      produceRow({ transaction_type: "คืน", quantity: 20 }),
    ])
    .seed("accountability_rounds", [
      { id: ROUND, seller_label: "โอม", market_label: "ตลาด72" },
    ]);
}

const client = (db: FakeDatabase): SupabaseClient<Database> =>
  db as unknown as SupabaseClient<Database>;

describe("loadPurchasePlanningReport — house stock wiring", () => {
  test("a matched authoritative snapshot turns a high seller green", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.stockAbsence).toBeNull();
    expect(report.items).toHaveLength(1);
    expect(report.items[0]!.houseStockQuantity).toBe(10);
    // 10 left at home after dispatch + 20 that came back good = 30 ready.
    expect(report.items[0]!.nextDayGoodStockQuantity).toBe(30);
    expect(report.items[0]!.nextStockToSoldRatio).toBe(30 / 80);
    expect(report.items[0]!.status).toBe("strong");
  });

  test("a large house stock holds the same high seller back to 🟠", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [itemRow({ quantity: 200 })]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.items[0]!.houseStockQuantity).toBe(200);
    expect(report.items[0]!.nextDayGoodStockQuantity).toBe(220);
    expect(report.items[0]!.status).toBe("surplus");
    // The market arithmetic is untouched by the snapshot.
    expect(report.items[0]!.goodReturnQuantity).toBe(20);
    expect(report.items[0]!.estimatedSoldQuantity).toBe(80);
  });

  test("rejected observations are not counted as stock", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [
        itemRow({ quantity: 10 }),
        itemRow({ quantity: 999, resolution_status: "REJECTED", reason: "missing_unit" }),
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);
    expect(report.items[0]!.houseStockQuantity).toBe(10);
  });

  test("no snapshot leaves the market report intact and the seller conservative", async () => {
    const report = await loadPurchasePlanningReport(client(highSellingDay()), BUSINESS_DATE);

    expect(report.stockAbsence).toBe("no_snapshot");
    expect(report.items[0]!.estimatedSoldQuantity).toBe(80);
    expect(report.items[0]!.houseStockQuantity).toBeNull();
    expect(report.items[0]!.status).toBe("surplus");
  });

  test("two authoritative snapshots invent no stock and do not fail the report", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [
        snapshotRow(),
        snapshotRow({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      ])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.stockAbsence).toBe("snapshot_conflict");
    expect(report.items[0]!.houseStockQuantity).toBeNull();
    expect(report.items[0]!.status).toBe("surplus");
  });

  test("a superseded or unfinalized snapshot is not authoritative", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [
        snapshotRow({ status: "open" }),
        snapshotRow({
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          replacement_snapshot_id: SNAPSHOT,
        }),
      ])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);
    expect(report.stockAbsence).toBe("no_snapshot");
  });

  test("a house unit the market never uses is never combined", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [
        itemRow({ quantity: 10, normalized_unit: null, raw_unit: "ตะกร้า" }),
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.stockAbsence).toBeNull();
    expect(report.items[0]!.houseStockQuantity).toBeNull();
    expect(report.items[0]!.stockAbsence).toBe("no_match");
    expect(report.items[0]!.status).toBe("surplus");
  });

  test("a snapshot whose entries are all rejected is not a matched snapshot", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [
        itemRow({ quantity: 5, resolution_status: "REJECTED", reason: "missing_unit_price" }),
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.stockAbsence).toBe("snapshot_empty");
    expect(report.items[0]!.houseStockQuantity).toBeNull();
    expect(report.items[0]!.status).toBe("surplus");
  });

  test("a session that failed to parse blocks its own products", async () => {
    const db = highSellingDay()
      .seed("produce_sessions", [
        { id: "session-1", total_items: 2, parser_errors: [{ line: 3, reason: "unreadable" }] },
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.items[0]!.status).toBe("unknown");
    expect(report.items[0]!.uncertaintyReasons).toContain("session_integrity");
  });

  test("a session that persisted fewer rows than it claimed blocks its products", async () => {
    const db = highSellingDay()
      .seed("produce_sessions", [
        { id: "session-1", total_items: 5, parser_errors: [] },
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.items[0]!.status).toBe("unknown");
    expect(report.items[0]!.uncertaintyReasons).toContain("session_integrity");
  });

  test("a clean session is not blocked", async () => {
    const db = highSellingDay()
      .seed("produce_sessions", [
        { id: "session-1", total_items: 2, parser_errors: [] },
      ])
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.items[0]!.uncertaintyReasons).toEqual([]);
    expect(report.items[0]!.status).toBe("strong");
  });

  test("the legacy เสีย spelling survives the loader's lack of a type filter", async () => {
    const db = new FakeDatabase()
      .seed("produce_transactions", [
        produceRow({ transaction_type: "เบิก", quantity: 100 }),
        produceRow({ transaction_type: "คืน", quantity: 20 }),
        produceRow({ transaction_type: "เสีย", quantity: 30 }),
      ])
      .seed("accountability_rounds", [
        { id: ROUND, seller_label: "โอม", market_label: "ตลาด72" },
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.items[0]!.damagedQuantity).toBe(30);
    expect(report.items[0]!.estimatedSoldQuantity).toBe(50);
  });
});
