import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { matchedWhiteSheetFixture } from "./white-sheet-fixtures";
import { WhiteSheetPageClient } from "./WhiteSheetPageClient";

describe("WhiteSheetPageClient UX hardening", () => {
  it("shows Thai-readable business date next to the native date input", () => {
    const html = renderToStaticMarkup(
      <WhiteSheetPageClient
        initial={{
          sourceId: "Ccfac33c4e435ae95c5eaa04dbebff209",
          market: "ทดสอบเงินโอน",
          date: "2026-07-25",
          pageModel: {
            entryStatus: "not_submitted",
            summary: matchedWhiteSheetFixture,
            finalizedAt: null,
            finalizedBy: null,
          },
        }}
      />,
    );

    expect(html).toContain('data-testid="white-sheet-business-date"');
    expect(html).toContain('value="2026-07-25"');
    expect(html).toContain('data-testid="white-sheet-business-date-thai"');
    expect(html).toContain("2569");
    expect(html).toMatch(/กรกฎาคม/);
    expect(html).toContain('data-testid="white-sheet-market-scope"');
    expect(html).toContain("ตลาด / กลุ่ม LINE");
    expect(html).toContain("โหมดขั้นสูง (Source ID)");
  });
});
