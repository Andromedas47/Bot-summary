import { describe, expect, test } from "bun:test";

const compareDoc = await Bun.file(new URL("./CompareReportDoc.tsx", import.meta.url)).text();
const reconciliationDoc = await Bun.file(new URL("./ReconciliationDoc.tsx", import.meta.url)).text();

describe("report PDF multi-page contract", () => {
  test("Compare PDF repeats its header, keeps rows together, and prints page numbers", () => {
    expect(compareDoc).toContain("fixed");
    expect(compareDoc).toContain("wrap={false}");
    expect(compareDoc).toContain("pageNumber, totalPages");
    expect(compareDoc).toContain('fontFamily: "SarabunPDF"');
  });

  test("reconciliation PDF uses the same searchable text layout contract", () => {
    expect(reconciliationDoc).toContain("fixed");
    expect(reconciliationDoc).toContain("wrap={false}");
    expect(reconciliationDoc).toContain("pageNumber, totalPages");
    expect(reconciliationDoc).toContain('fontFamily: "SarabunPDF"');
  });
});
