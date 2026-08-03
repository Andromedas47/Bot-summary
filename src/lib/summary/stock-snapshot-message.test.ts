import { describe, expect, test } from "bun:test";
import { buildStockSummaryFromRows } from "./stock-summary";
import { buildStockSummaryBlocks } from "./stock-summary-message";
import {
  buildStockSnapshotBlocks,
  buildStockSnapshotMessages,
  isStockSnapshotEmpty,
  stockSnapshotMarketCoverage,
  STOCK_SNAPSHOT_NO_DATA_PREFIX,
  STOCK_SNAPSHOT_NO_HISTORY_NOTICE,
  STOCK_SNAPSHOT_NOTICE,
  STOCK_SNAPSHOT_TITLE,
} from "./stock-snapshot-message";
import { countCodePoints, LINE_MESSAGE_MAX_CODE_POINTS, OVERFLOW_NOTICE } from "./line-chunking";
import { LATEST_DATA_UNAVAILABLE_NOTICE, type LatestDataLookup } from "./latest-data-hint";
import type { RemainingFruitSourceRow } from "./remaining-fruit";

const DATE = "2026-07-25";
const TX_RETURN = "คืน";
const TX_WITHDRAW = "เบิก";
const TX_DAMAGED = "คืนเสีย";

function row(overrides: Partial<RemainingFruitSourceRow> = {}): RemainingFruitSourceRow {
  return {
    market_name: "ตลาดกี้",
    product_name: "แตงโม",
    quantity: 10,
    unit: "ลูก",
    transaction_type: TX_RETURN,
    ...overrides,
  };
}

function textFor(rows: RemainingFruitSourceRow[]): string {
  return buildStockSnapshotMessages(buildStockSummaryFromRows(DATE, rows)).join("\n\n");
}

describe("stock snapshot header", () => {
  test("states that it is the all-market total, with the date and both market counts", () => {
    const text = textFor([
      row({ market_name: "ตลาดกี้", product_name: "แตงโม", quantity: 10, unit: "ลูก" }),
      row({ market_name: "เฉลิม72 ผลไม้", product_name: "มะละกอ", quantity: 4, unit: "ลูก" }),
    ]);

    expect(text).toContain(
      `${STOCK_SNAPSHOT_TITLE}\nข้อมูลวันที่ 25 กรกฎาคม 2569\n${STOCK_SNAPSHOT_NOTICE}\nข้อมูลจาก 2 ตลาด • พบคงเหลือ 2 ตลาด`,
    );
    // The purpose has to be legible from the first line.
    expect(STOCK_SNAPSHOT_TITLE).toContain("รวมทุกตลาด");
    // Must not claim to be physically counted stock.
    expect(STOCK_SNAPSHOT_TITLE).not.toContain("ตรวจนับ");
    expect(text).toContain(STOCK_SNAPSHOT_NOTICE);
  });

  test("both counts match when every market contributed sellable stock", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ market_name: "ตลาดกี้", product_name: "แตงโม", quantity: 10, unit: "ลูก" }),
      row({ market_name: "ตลาดกี้", product_name: "มะละกอ", quantity: 3, unit: "ลูก" }),
      row({ market_name: "เฉลิม72 ผลไม้", product_name: "ฝรั่ง", quantity: 5, unit: "โล" }),
    ]);

    // Each market counts once however many products it sent.
    expect(stockSnapshotMarketCoverage(summary)).toEqual({ total: 2, withStock: 2 });
  });

  test("a market with data but no sellable stock still counts toward the total", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ market_name: "ตลาดกี้", product_name: "แตงโม", quantity: 10, unit: "ลูก" }),
      // Withdrew, no ชั่งคืน recorded yet — present in the data, no stock figure.
      row({
        market_name: "เฉลิม72 ผลไม้",
        product_name: "แก้วมังกร",
        quantity: 9,
        unit: "โล",
        transaction_type: TX_WITHDRAW,
      }),
    ]);

    expect(stockSnapshotMarketCoverage(summary)).toEqual({ total: 2, withStock: 1 });
    expect(buildStockSnapshotBlocks(summary)[0]).toContain("ข้อมูลจาก 2 ตลาด • พบคงเหลือ 1 ตลาด");
  });

  test("an incomplete market is never counted as a zero-stock market", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({
        market_name: "เฉลิม72 ผลไม้",
        product_name: "แก้วมังกร",
        quantity: 9,
        unit: "โล",
        transaction_type: TX_WITHDRAW,
      }),
    ]);
    const text = buildStockSnapshotMessages(summary).join("\n\n");

    // It is in the total, absent from พบคงเหลือ, and named in the warning —
    // never rendered as a market holding 0.
    expect(stockSnapshotMarketCoverage(summary)).toEqual({ total: 1, withStock: 0 });
    expect(text).toContain("ข้อมูลจาก 1 ตลาด • พบคงเหลือ 0 ตลาด");
    expect(text).toContain("⚠️ พบรายการเบิกที่ไม่มีข้อมูลชั่งคืน\n1 รายการ จาก 1 ตลาด");
    expect(text).not.toContain("แก้วมังกร — 0");
  });

  test("คืนเสีย-only stock leaves the market outside พบคงเหลือ", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ market_name: "ตลาดกี้", product_name: "แตงโม", quantity: 6, unit: "ลูก" }),
      row({
        market_name: "เฉลิม72 ผลไม้",
        product_name: "ลูกพลับ",
        quantity: 12,
        unit: "ลูก",
        transaction_type: TX_WITHDRAW,
      }),
      row({
        market_name: "เฉลิม72 ผลไม้",
        product_name: "ลูกพลับ",
        quantity: 12,
        unit: "ลูก",
        transaction_type: TX_DAMAGED,
      }),
    ]);

    // Damage is not a good return, so the loop is still open for that market.
    expect(stockSnapshotMarketCoverage(summary)).toEqual({ total: 2, withStock: 1 });
  });
});

describe("stock snapshot unit grouping", () => {
  test("products are grouped by unit, and quantities sort ascending inside a group", () => {
    const text = textFor([
      row({ product_name: "มหาชนก", quantity: 120.2, unit: "โล" }),
      row({ product_name: "องุ่นแดง", quantity: 2.3, unit: "โล" }),
      row({ product_name: "องุ่นรวม", quantity: 6.4, unit: "โล" }),
      row({ product_name: "ลูกพลับ", quantity: 363, unit: "ลูก" }),
      row({ product_name: "แอปเปิ้ล", quantity: 66, unit: "ลูก" }),
      row({ product_name: "มะละกอ", quantity: 242, unit: "ลูก" }),
    ]);

    expect(text).toContain(
      "กก.\nองุ่นแดง — 2.3 กก.\nองุ่นรวม — 6.4 กก.\nมหาชนก — 120.2 กก.",
    );
    expect(text).toContain("ลูก\nแอปเปิ้ล — 66 ลูก\nมะละกอ — 242 ลูก\nลูกพลับ — 363 ลูก");
  });

  test("incompatible units form separate groups and are never ranked against each other", () => {
    const text = textFor([
      row({ product_name: "กะเพรา", quantity: 3, unit: "กำ" }),
      row({ product_name: "ผักชี", quantity: 9, unit: "กำ" }),
      row({ product_name: "มะนาว", quantity: 3, unit: "แพค" }),
      row({ product_name: "ถั่วงอก", quantity: 8, unit: "แพค" }),
      row({ product_name: "กะหล่ำปี", quantity: 3, unit: "หัว" }),
      row({ product_name: "ผักกาดขาว", quantity: 7, unit: "หัว" }),
    ]);

    // Each unit is its own list; 3 กำ, 3 แพค and 3 หัว never share an ordering.
    expect(text).toContain("กำ\nกะเพรา — 3 กำ\nผักชี — 9 กำ");
    expect(text).toContain("แพค\nมะนาว — 3 แพค\nถั่วงอก — 8 แพค");
    expect(text).toContain("หัว\nกะหล่ำปี — 3 หัว\nผักกาดขาว — 7 หัว");
  });

  test("the same product in two units appears once per unit, never summed", () => {
    const text = textFor([
      row({ product_name: "ทุเรียนกวน", quantity: 4, unit: "กระปุก" }),
      row({ product_name: "ทุเรียนกวน", quantity: 9, unit: "กล่อง" }),
    ]);

    expect(text).toContain("ทุเรียนกวน — 4 กระปุก");
    expect(text).toContain("ทุเรียนกวน — 9 กล่อง");
    expect(text).not.toContain("ทุเรียนกวน — 13");
  });

  test("categories appear in canonical order and only when they hold stock", () => {
    const text = textFor([
      row({ product_name: "กะเพรา", quantity: 2, unit: "กำ" }),
      row({ product_name: "หมอนทอง", quantity: 5, unit: "โล" }),
    ]);

    expect(text.indexOf("🥭 ทุเรียน")).toBeLessThan(text.indexOf("🥬 ผัก"));
    expect(text).not.toContain("🍉 ผลไม้");
    expect(text).not.toContain("❓ ไม่จัดหมวด");
  });
});

describe("stock snapshot completeness", () => {
  test("every stocked product is present — nothing is filtered by quantity", () => {
    const text = textFor([
      row({ product_name: "แตงโม", quantity: 0.1, unit: "โล" }),
      row({ product_name: "มะละกอ", quantity: 5000, unit: "ลูก" }),
      row({ product_name: "ฝรั่ง", quantity: 42, unit: "โล" }),
    ]);

    // A snapshot reports what is there. There is no threshold, no "low stock"
    // filter, and no notion of a product being uninteresting.
    expect(text).toContain("แตงโม — 0.1 กก.");
    expect(text).toContain("มะละกอ — 5000 ลูก");
    expect(text).toContain("ฝรั่ง — 42 กก.");
    expect(text).not.toContain("เกณฑ์");
    expect(text).not.toContain("คงเหลือน้อย");
  });

  test("never recommends a purchase", () => {
    const text = textFor([row({ product_name: "แตงโม", quantity: 1, unit: "ลูก" })]);
    for (const forbidden of ["ควรซื้อ", "ต้องซื้อ", "แนะนำ", "สั่งซื้อ"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("uncategorized products are still shown", () => {
    const text = textFor([row({ product_name: "ของแปลกใหม่ไม่เคยเจอ", quantity: 3, unit: "ถุง" })]);
    expect(text).toContain("❓ ไม่จัดหมวด");
    expect(text).toContain("ของแปลกใหม่ไม่เคยเจอ — 3 ถุง");
  });

  test("unresolved-market stock keeps its own section", () => {
    const text = textFor([
      row({ market_name: "ตลาดกี้", product_name: "แตงโม", quantity: 20, unit: "ลูก" }),
      row({ market_name: "รายการชั่งเบิก", product_name: "ลูกพลับ", quantity: 363, unit: "ลูก" }),
    ]);

    expect(text).toContain("❔ ยังระบุตลาดไม่ได้");
    expect(text).toContain("ลูกพลับ — 363 ลูก");
    // An unresolved row has no market identity, so it counts toward neither
    // number — its stock is still shown in its own section above.
    expect(text).toContain("ข้อมูลจาก 1 ตลาด • พบคงเหลือ 1 ตลาด");
  });

  test("reports an empty day explicitly", () => {
    const text = textFor([]);
    expect(text).toContain(STOCK_SNAPSHOT_TITLE);
    expect(text).toContain("ยังไม่พบข้อมูลชั่งคืนประจำวันที่ 25 กรกฎาคม 2569");
  });
});

describe("stock snapshot empty state", () => {
  const empty = () => buildStockSummaryFromRows(DATE, []);
  const FOUND: LatestDataLookup = {
    status: "found",
    hint: { date: "2026-07-24", marketCount: 10 },
  };

  test("names the requested date and drops the zero-market coverage line", () => {
    const text = buildStockSnapshotBlocks(empty(), { status: "none" }).join("\n\n");

    expect(text).toContain(`${STOCK_SNAPSHOT_TITLE}\nข้อมูลวันที่ 25 กรกฎาคม 2569`);
    expect(text).toContain(`${STOCK_SNAPSHOT_NO_DATA_PREFIX} 25 กรกฎาคม 2569`);
    // A count that was never taken must not read as a completed zero.
    expect(text).not.toContain("ข้อมูลจาก 0 ตลาด");
    expect(text).not.toContain("พบคงเหลือ 0 ตลาด");
  });

  test("found: shows the latest date as context, never as the report", () => {
    const text = buildStockSnapshotBlocks(empty(), FOUND).join("\n\n");

    expect(text).toContain(`${STOCK_SNAPSHOT_NO_DATA_PREFIX} 25 กรกฎาคม 2569`);
    expect(text).toContain("ข้อมูลล่าสุดที่มีคือวันที่ 24 กรกฎาคม 2569");
    expect(text).toContain("พบข้อมูล 10 ตลาด");
    // The requested date stays the report's date, and no prior-date stock
    // figure is anywhere in the message.
    expect(text).toContain("ข้อมูลวันที่ 25 กรกฎาคม 2569");
    expect(text).not.toContain("ข้อมูลวันที่ 24 กรกฎาคม 2569");
    expect(text).not.toContain(STOCK_SNAPSHOT_NO_HISTORY_NOTICE);
    expect(text).not.toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
  });

  test("none: says plainly that no ชั่งคืน exists anywhere", () => {
    const text = buildStockSnapshotBlocks(empty(), { status: "none" }).join("\n\n");

    expect(text).toContain(STOCK_SNAPSHOT_NO_HISTORY_NOTICE);
    expect(text).not.toContain("ข้อมูลล่าสุดที่มีคือ");
    expect(text).not.toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
  });

  test("unavailable: says the check failed and never claims history is empty", () => {
    const text = buildStockSnapshotBlocks(empty(), { status: "unavailable" }).join("\n\n");

    // The requested-date statement is still delivered in full …
    expect(text).toContain(`${STOCK_SNAPSHOT_NO_DATA_PREFIX} 25 กรกฎาคม 2569`);
    expect(text).toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
    // … and the false claim is absent.
    expect(text).not.toContain(STOCK_SNAPSHOT_NO_HISTORY_NOTICE);
    expect(text).not.toContain("ข้อมูลล่าสุดที่มีคือ");
  });

  test("an unpassed lookup defaults to 'could not check', never to 'nothing exists'", () => {
    const text = buildStockSnapshotBlocks(empty()).join("\n\n");

    expect(text).toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
    expect(text).not.toContain(STOCK_SNAPSHOT_NO_HISTORY_NOTICE);
  });

  test("omits the market count when the latest date resolved no market", () => {
    const text = buildStockSnapshotBlocks(empty(), {
      status: "found",
      hint: { date: "2026-07-24", marketCount: 0 },
    }).join("\n\n");

    expect(text).toContain("ข้อมูลล่าสุดที่มีคือวันที่ 24 กรกฎาคม 2569");
    expect(text).not.toContain("พบข้อมูล 0 ตลาด");
  });

  test("a day with withdrawals is not empty and keeps its existing report", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "แก้วมังกร", quantity: 9, unit: "โล", transaction_type: TX_WITHDRAW }),
    ]);

    expect(isStockSnapshotEmpty(summary)).toBe(false);
    const text = buildStockSnapshotBlocks(summary, FOUND).join("\n\n");
    expect(text).toContain("ข้อมูลจาก 1 ตลาด • พบคงเหลือ 0 ตลาด");
    expect(text).not.toContain("ข้อมูลล่าสุดที่มีคือ");
    expect(text).not.toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
  });

  test("a day with stock renders identically in all three lookup states", () => {
    const summary = buildStockSummaryFromRows(DATE, [row()]);
    const baseline = buildStockSnapshotBlocks(summary, { status: "none" });

    expect(isStockSnapshotEmpty(summary)).toBe(false);
    expect(buildStockSnapshotBlocks(summary, FOUND)).toEqual(baseline);
    expect(buildStockSnapshotBlocks(summary, { status: "unavailable" })).toEqual(baseline);
  });

  test("the empty state fits in a single LINE message in every state", () => {
    for (const latest of [FOUND, { status: "none" } as const, { status: "unavailable" } as const]) {
      const messages = buildStockSnapshotMessages(empty(), { latest });
      expect(messages).toHaveLength(1);
      expect(countCodePoints(messages[0])).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    }
  });
});

describe("stock snapshot missing-ชั่งคืน handling", () => {
  test("the warning is counts only — no market or product names", () => {
    const text = textFor([
      row({ market_name: "ตลาดกี้", product_name: "แตงโม", quantity: 20, unit: "ลูก" }),
      row({
        market_name: "เฉลิม72 ผลไม้",
        product_name: "แก้วมังกร",
        quantity: 9,
        unit: "โล",
        transaction_type: TX_WITHDRAW,
      }),
      row({
        market_name: "พาซิโอ้ผลไม้",
        product_name: "ลูกพลับ",
        quantity: 5,
        unit: "ลูก",
        transaction_type: TX_WITHDRAW,
      }),
    ]);

    expect(text).toContain("⚠️ พบรายการเบิกที่ไม่มีข้อมูลชั่งคืน\n2 รายการ จาก 2 ตลาด");
    expect(text).not.toContain("- เฉลิม72 ผลไม้:");
    expect(text).not.toContain("แก้วมังกร");
  });

  test("a withdrawal with no good return never becomes 0 remaining", () => {
    const text = textFor([
      row({ product_name: "มะละกอ", quantity: 50, unit: "ลูก", transaction_type: TX_WITHDRAW }),
    ]);

    expect(text).not.toContain("มะละกอ — 0 ลูก");
    expect(text).not.toContain("มะละกอ");
    expect(text).toContain("⚠️ พบรายการเบิกที่ไม่มีข้อมูลชั่งคืน\n1 รายการ จาก 1 ตลาด");
  });

  test("คืนเสีย alone does not close the loop or create sellable stock", () => {
    const text = textFor([
      row({ product_name: "แตงโม", quantity: 20, unit: "ลูก", transaction_type: TX_WITHDRAW }),
      row({ product_name: "แตงโม", quantity: 20, unit: "ลูก", transaction_type: TX_DAMAGED }),
    ]);

    expect(text).not.toContain("แตงโม — ");
    expect(text).toContain("⚠️ พบรายการเบิกที่ไม่มีข้อมูลชั่งคืน\n1 รายการ จาก 1 ตลาด");
  });

  test("states completeness when every ชั่งคืน is in", () => {
    const text = textFor([
      row({ product_name: "แตงโม", quantity: 20, unit: "ลูก", transaction_type: TX_WITHDRAW }),
      row({ product_name: "แตงโม", quantity: 8, unit: "ลูก" }),
    ]);

    expect(text).toContain("✅ ชั่งคืนครบทุกตลาด");
    expect(text).not.toContain("⚠️ พบรายการเบิกที่ไม่มีข้อมูลชั่งคืน");
  });
});

describe("stock snapshot has no per-market detail", () => {
  test("market names and per-market figures are absent from the snapshot", () => {
    const text = textFor([
      row({ market_name: "ตลาดกี้", product_name: "แตงโม", quantity: 12, unit: "ลูก" }),
      row({ market_name: "เฉลิม72 ผลไม้", product_name: "แตงโม", quantity: 8, unit: "ลูก" }),
    ]);

    // One combined line for the product …
    expect(text).toContain("แตงโม — 20 ลูก");
    // … and none of the manual report's per-market machinery.
    expect(text).not.toContain("ตลาดกี้");
    expect(text).not.toContain("เฉลิม72 ผลไม้");
    expect(text).not.toContain("เหลือขายต่อ:");
    expect(text).not.toContain("เบิกทั้งหมด:");
    expect(text).not.toContain("คืนเสีย:");
  });
});

describe("stock snapshot message splitting", () => {
  function bigDay(): RemainingFruitSourceRow[] {
    return [
      ...Array.from({ length: 5 }, (_, i) =>
        row({ product_name: `ทุเรียนพันธุ์${i}`, quantity: i + 1, unit: "โล" }),
      ),
      ...Array.from({ length: 22 }, (_, i) =>
        row({ product_name: `ผลไม้ชนิด${i}`, quantity: i + 1, unit: i % 2 ? "ลูก" : "โล" }),
      ),
      ...Array.from({ length: 56 }, (_, i) =>
        row({ product_name: `ผักชนิด${i}`, quantity: i + 1, unit: ["กำ", "แพค", "หัว"][i % 3] }),
      ),
    ];
  }

  test("a large day splits into several readable parts instead of one wall of text", () => {
    const messages = buildStockSnapshotMessages(buildStockSummaryFromRows(DATE, bigDay()));

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(countCodePoints(message)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    }
    // The header leads the first part.
    expect(messages[0].startsWith(STOCK_SNAPSHOT_TITLE)).toBe(true);
  });

  test("splitting never drops a product", () => {
    const rows = bigDay();
    const text = buildStockSnapshotMessages(buildStockSummaryFromRows(DATE, rows)).join("\n");

    for (const source of rows) expect(text).toContain(`${source.product_name} — `);
    expect(text).not.toContain(OVERFLOW_NOTICE);
  });

  test("a category too large for one block keeps its heading on every part", () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      row({ product_name: `ทุเรียนพันธุ์${i}`, quantity: i + 1, unit: "โล" }),
    );

    const blocks = buildStockSnapshotBlocks(buildStockSummaryFromRows(DATE, rows));
    const durianBlocks = blocks.filter((b) => b.startsWith("🥭 ทุเรียน"));

    expect(durianBlocks.length).toBeGreaterThan(1);
    // Every continuation still says which category and which unit it is.
    for (const block of durianBlocks) expect(block).toContain("\n\nกก.\n");
  });

  test("an enormous day still emits every product rather than truncating", () => {
    const rows = Array.from({ length: 1200 }, (_, i) =>
      row({ product_name: `สินค้า${i}`, quantity: i + 1, unit: "โล" }),
    );

    const messages = buildStockSnapshotMessages(buildStockSummaryFromRows(DATE, rows));

    expect(messages.length).toBeGreaterThan(5);
    expect(messages.join("\n")).toContain("สินค้า1199 — ");
    expect(messages.join("\n")).not.toContain(OVERFLOW_NOTICE);
  });
});

describe("the manual report is a different rendering sharing the same P0 heading", () => {
  test("manual keeps its own quantity ordering and per-market warning detail", () => {
    const rows = [
      row({ market_name: "ตลาดกี้", product_name: "มหาชนก", quantity: 120.2, unit: "โล" }),
      row({ market_name: "ตลาดกี้", product_name: "องุ่นแดง", quantity: 2.3, unit: "โล" }),
      row({
        market_name: "เฉลิม72 ผลไม้",
        product_name: "แก้วมังกร",
        quantity: 9,
        unit: "โล",
        transaction_type: TX_WITHDRAW,
      }),
    ];

    const manual = buildStockSummaryBlocks(buildStockSummaryFromRows(DATE, rows)).join("\n\n");

    expect(manual).toContain("📦 สรุปของดีชั่งคืนรวมทุกตลาด");
    // Manual is quantity DESCENDING and not grouped by unit.
    expect(manual).toContain("🍉 ผลไม้\nมหาชนก — 120.2 กก.\nองุ่นแดง — 2.3 กก.");
    // Manual keeps the full per-market missing-return listing.
    expect(manual).toContain("- เฉลิม72 ผลไม้: แก้วมังกร (กก.)");
    // Same shared heading as the scheduled snapshot — same P0 model, same claim.
    expect(manual).toContain(STOCK_SNAPSHOT_TITLE);
  });
});
