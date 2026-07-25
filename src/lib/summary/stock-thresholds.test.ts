import { describe, expect, test } from "bun:test";
import {
  createStockThresholdTable,
  stockThresholdKey,
  STOCK_THRESHOLDS,
  stockThresholdTable,
} from "./stock-thresholds";

describe("stock thresholds configuration", () => {
  test("ships with no approved thresholds yet", () => {
    // Guards the activation-safety contract: until P'Krai approves real values
    // the scheduled low-stock delivery must stay inert. Updating this test is
    // the deliberate act of turning the feature on.
    expect(STOCK_THRESHOLDS).toHaveLength(0);
    expect(stockThresholdTable.size).toBe(0);
  });

  test("the configured list has no duplicate product+unit keys", () => {
    const keys = STOCK_THRESHOLDS.map((t) => stockThresholdKey(t.productName, t.unit));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every configured threshold is a usable positive number", () => {
    for (const entry of STOCK_THRESHOLDS) {
      expect(Number.isFinite(entry.threshold)).toBe(true);
      expect(entry.threshold).toBeGreaterThan(0);
      expect(entry.productName.trim()).toBe(entry.productName);
      expect(entry.unit.trim()).toBe(entry.unit);
    }
  });
});

describe("createStockThresholdTable", () => {
  test("looks up by exact product and unit", () => {
    const table = createStockThresholdTable([{ productName: "หมอนทอง", unit: "โล", threshold: 30 }]);

    expect(table.get("หมอนทอง", "โล")).toBe(30);
    expect(table.size).toBe(1);
  });

  test("unit is part of the identity — thresholds never cross units", () => {
    const table = createStockThresholdTable([
      { productName: "ทุเรียนกวน", unit: "กระปุก", threshold: 10 },
      { productName: "ทุเรียนกวน", unit: "กล่อง", threshold: 3 },
    ]);

    expect(table.get("ทุเรียนกวน", "กระปุก")).toBe(10);
    expect(table.get("ทุเรียนกวน", "กล่อง")).toBe(3);
    // A unit with no configured threshold stays unconfigured, never inherited.
    expect(table.get("ทุเรียนกวน", "โล")).toBeUndefined();
    expect(table.size).toBe(2);
  });

  test("an unconfigured product returns undefined rather than a guess", () => {
    const table = createStockThresholdTable([{ productName: "มะละกอ", unit: "ลูก", threshold: 20 }]);

    expect(table.get("แตงโม", "ลูก")).toBeUndefined();
    // No fuzzy or prefix matching.
    expect(table.get("มะละกอดิบ", "ลูก")).toBeUndefined();
  });

  test("matching is normalized and whitespace tolerant", () => {
    const table = createStockThresholdTable([
      { productName: " มะนาว ", unit: " แพค ", threshold: 5 },
    ]);

    expect(table.get("มะนาว", "แพค")).toBe(5);
    expect(table.entries()[0]).toEqual({ productName: "มะนาว", unit: "แพค", threshold: 5 });
  });

  test("unusable entries are dropped instead of becoming 0 or NaN", () => {
    const table = createStockThresholdTable([
      { productName: "แตงโม", unit: "ลูก", threshold: Number.NaN },
      { productName: "ฝรั่ง", unit: "โล", threshold: -1 },
      { productName: "", unit: "โล", threshold: 5 },
      { productName: "ส้ม", unit: "", threshold: 5 },
      { productName: "กล้วย", unit: "หวี", threshold: 4 },
    ]);

    expect(table.size).toBe(1);
    expect(table.get("แตงโม", "ลูก")).toBeUndefined();
    expect(table.get("ฝรั่ง", "โล")).toBeUndefined();
    expect(table.get("กล้วย", "หวี")).toBe(4);
  });

  test("a duplicate key never silently overrides the approved value", () => {
    const table = createStockThresholdTable([
      { productName: "หมอนทอง", unit: "โล", threshold: 30 },
      { productName: "หมอนทอง", unit: "โล", threshold: 999 },
    ]);

    expect(table.size).toBe(1);
    expect(table.get("หมอนทอง", "โล")).toBe(30);
  });

  test("an empty configuration reports size 0", () => {
    expect(createStockThresholdTable([]).size).toBe(0);
  });
});
