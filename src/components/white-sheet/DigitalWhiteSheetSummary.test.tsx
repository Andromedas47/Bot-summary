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
});
