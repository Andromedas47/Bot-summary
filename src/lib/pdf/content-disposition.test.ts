import { describe, expect, test } from "bun:test";
import { pdfContentDisposition } from "./content-disposition";

describe("pdfContentDisposition", () => {
  test("does not throw when used to construct a Headers object with Thai text", () => {
    // This is the exact production crash: "Cannot convert argument to a ByteString
    // because the character at index 22 has a value of 3619 which is greater than 255."
    // — raised by the Fetch Headers implementation when a header value contains a
    // code point above 255 (any Thai character). Constructing real Headers is the
    // most direct regression check for that failure.
    const value = pdfContentDisposition("รายงานสรุป-2026-07-21.pdf");
    expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
  });

  test("includes an ASCII-only filename= fallback", () => {
    const value = pdfContentDisposition("รายงานสรุป-2026-07-21.pdf");
    const match = value.match(/filename="([^"]*)"/);
    expect(match?.[1]).toBeDefined();
    expect(match![1]).toMatch(/^[\x20-\x7E]*$/);
    expect(match![1]).toContain("2026-07-21.pdf");
  });

  test("includes the real filename as an RFC 5987 filename* extended value", () => {
    const value = pdfContentDisposition("รายงานสรุป-2026-07-21.pdf");
    expect(value).toContain("filename*=UTF-8''" + encodeURIComponent("รายงานสรุป-2026-07-21.pdf"));
  });

  test("falls back to a default name when the filename is all non-ASCII", () => {
    const value = pdfContentDisposition("รายงาน.pdf".replace(".pdf", ""));
    const match = value.match(/filename="([^"]*)"/);
    expect(match?.[1]).toBe("report.pdf");
  });

  test("strips quote and backslash characters from the ASCII fallback", () => {
    const value = pdfContentDisposition('a"b\\c.pdf');
    const match = value.match(/filename="([^"]*)"/);
    expect(match?.[1]).toBe("abc.pdf");
  });

  test("plain ASCII filenames pass through unchanged in the fallback", () => {
    const value = pdfContentDisposition("daily-table-123.pdf");
    expect(value).toContain('filename="daily-table-123.pdf"');
  });
});
