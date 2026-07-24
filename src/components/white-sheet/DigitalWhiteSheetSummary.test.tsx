import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DigitalWhiteSheetSummary } from "./DigitalWhiteSheetSummary";
import {
  matchedWhiteSheetFixture,
  overageWhiteSheetFixture,
  shortageWhiteSheetFixture,
  uncategorizedWarningFixture,
} from "./white-sheet-fixtures";
import { formatThaiDate } from "@/lib/date";

describe("DigitalWhiteSheetSummary", () => {
  it("renders shortage with explicit Thai label independent of colour", () => {
    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary viewModel={shortageWhiteSheetFixture} />,
    );

    expect(html).toContain("เงินขาด");
    expect(html).toContain("เงินขาด 310.00 บาท");
    expect(html).toContain("ค่าแรง");
    expect(html).toContain("ค่าที่");
    expect(html).toContain("ค่าถุง");
    expect(html).toContain("ค่าขนม");
    expect(html).toContain("ค่าใช้จ่ายอื่น");
    expect(html).toContain("ค่าน้ำแข็ง");
  });

  it("renders matched status with ยอดตรง label", () => {
    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary viewModel={matchedWhiteSheetFixture} />,
    );

    expect(html).toContain("ยอดตรง");
    expect(html).toContain("ยอดตรง 0.00 บาท");
    expect(html).not.toContain("white-sheet-warnings");
  });

  it("renders overage status with เงินเกิน label", () => {
    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary viewModel={overageWhiteSheetFixture} />,
    );

    expect(html).toContain("เงินเกิน");
    expect(html).toContain("เงินเกิน 150.00 บาท");
  });

  it("formats business date in Thai", () => {
    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary viewModel={matchedWhiteSheetFixture} />,
    );

    expect(html).toContain(formatThaiDate("2026-06-01"));
  });

  it("shows uncategorized warning when present", () => {
    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary viewModel={uncategorizedWarningFixture} />,
    );

    expect(html).toContain("มีรายการที่ยังไม่ได้จัดหมวด");
  });

  it("shows the operational preview but hides cash/status fields when not submitted", () => {
    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary
        viewModel={shortageWhiteSheetFixture}
        entryStatus="not_submitted"
      />,
    );

    expect(html).toContain("ยังไม่ได้บันทึก");
    expect(html).toContain("ยอดขายที่ควรได้");
    expect(html).toContain("เงินโอนที่ตรวจแล้ว");
    expect(html).not.toContain("white-sheet-status");
    expect(html).not.toContain("รวมค่าใช้จ่าย");
    expect(html).not.toContain("เงินสดที่ควรส่ง");
  });

  it("renders the full cash/status section when submitted (default)", () => {
    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary viewModel={shortageWhiteSheetFixture} />,
    );

    expect(html).not.toContain("ยังไม่ได้บันทึก");
    expect(html).toContain("white-sheet-status");
    expect(html).toContain("รวมค่าใช้จ่าย");
  });

  it("shows a distinct HARD STOP banner separate from ordinary warnings", () => {
    const hardStopFixture = {
      ...shortageWhiteSheetFixture,
      warnings: [
        "Multiple completed main produce sessions (2) exist for this market and business " +
          "date; current schema has no void/supersede marker, so duplicate business data " +
          "may still be included.",
        "พบสลิปโอนซ้ำในช่วงเวลาเดียวกัน",
      ],
    };
    const html = renderToStaticMarkup(
      <DigitalWhiteSheetSummary viewModel={hardStopFixture} />,
    );

    expect(html).toContain("white-sheet-hard-stop");
    expect(html).toContain("ห้ามเชื่อผลลัพธ์ทางการเงินนี้");
    expect(html).toContain("Multiple completed main produce sessions");
    // The hard-stop warning appears only in the dedicated banner, not duplicated
    // in the ordinary warnings list.
    expect(html).toContain("white-sheet-warnings");
    expect(html).toContain("พบสลิปโอนซ้ำในช่วงเวลาเดียวกัน");
  });
});
