/**
 * Content-Disposition header values must be a ByteString (Latin-1) — raw Thai
 * filenames throw "Cannot convert argument to a ByteString" when the Headers
 * object is constructed. Encode the real filename as an RFC 5987 filename*
 * extended value, with an ASCII-safe filename= fallback for older clients.
 */
export function pdfContentDisposition(filename: string): string {
  const asciiFallback =
    filename
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/["\\]/g, "")
      .trim() || "report.pdf";

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
