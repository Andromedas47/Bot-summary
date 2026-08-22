import { describe, expect, test } from "bun:test";
import {
  parsePurchasePlanningCommand,
  parsePurchasePlanningCommandFromMessage,
} from "./purchase-planning-command";

describe("สรุปสินค้าขายดี command", () => {
  test("with no date defers the business date to the caller", () => {
    expect(parsePurchasePlanningCommand("สรุปสินค้าขายดี")).toEqual({ businessDate: null });
  });

  test("reads Buddhist years in every deployed spelling", () => {
    expect(parsePurchasePlanningCommand("สรุปสินค้าขายดี 21/08/69"))
      .toEqual({ businessDate: "2026-08-21" });
    expect(parsePurchasePlanningCommand("สรุปสินค้าขายดี 21/08/2569"))
      .toEqual({ businessDate: "2026-08-21" });
    expect(parsePurchasePlanningCommand("สรุปสินค้าขายดี 21/08/2026"))
      .toEqual({ businessDate: "2026-08-21" });
  });

  test("rejects an impossible date instead of answering for another day", () => {
    expect(parsePurchasePlanningCommand("สรุปสินค้าขายดี 31/02/2569")).toBeNull();
    expect(parsePurchasePlanningCommand("สรุปสินค้าขายดี 21-08-2569")).toBeNull();
  });

  test("does not steal other commands or arbitrary text", () => {
    expect(parsePurchasePlanningCommand("สรุปยอดขาย")).toBeNull();
    expect(parsePurchasePlanningCommand("สรุปคงเหลือ")).toBeNull();
    expect(parsePurchasePlanningCommand("ตรวจความพร้อม")).toBeNull();
    expect(parsePurchasePlanningCommand("สรุปสินค้าขายดีรวม")).toBeNull();
    expect(parsePurchasePlanningCommand("อยากรู้ว่าสรุปสินค้าขายดีวันไหน")).toBeNull();
  });

  test("reads the command out of an exported LINE line", () => {
    expect(parsePurchasePlanningCommandFromMessage("09:12 พี่ไก่ สรุปสินค้าขายดี 21/08/69"))
      .toEqual({ businessDate: "2026-08-21" });
    expect(parsePurchasePlanningCommandFromMessage("สวัสดี\nสรุปสินค้าขายดี"))
      .toEqual({ businessDate: null });
  });
});
