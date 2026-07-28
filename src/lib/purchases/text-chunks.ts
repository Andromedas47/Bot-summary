import type {
  CapturedText,
  PurchaseSourceLine,
  PurchaseTextChunk,
  PurchaseTextChunkInput,
} from "./types";

const OUTER_ASCII_SPACE_TAB = /^[ \t]+|[ \t]+$/gu;
const LINE_ENDING = /\r\n|\r|\n/g;

export function trimPurchaseOuterWhitespace(text: string): string {
  return text.replace(OUTER_ASCII_SPACE_TAB, "");
}

export function capturePurchaseText(raw: string): CapturedText {
  const token = trimPurchaseOuterWhitespace(raw);
  return {
    raw: token,
    normalized: trimPurchaseOuterWhitespace(token.normalize("NFC")),
  };
}

function parsingLine(rawText: string, lineNumber: number): string {
  const withoutLeadingBom =
    lineNumber === 1 && rawText.startsWith("\uFEFF")
      ? rawText.slice(1)
      : rawText;
  return withoutLeadingBom.normalize("NFC");
}

/**
 * Creates the sole supported derived chunk representation.
 *
 * Offsets are calculated against the untouched JavaScript string, so they are
 * UTF-16 code-unit offsets even when line-ending folding or NFC changes length.
 */
export function createPurchaseTextChunk(
  input: PurchaseTextChunkInput,
): PurchaseTextChunk {
  const lines: PurchaseSourceLine[] = [];
  let lineStart = 0;
  let lineNumber = 1;
  LINE_ENDING.lastIndex = 0;

  for (;;) {
    const ending = LINE_ENDING.exec(input.rawText);
    const lineEnd = ending?.index ?? input.rawText.length;
    const rawText = input.rawText.slice(lineStart, lineEnd);
    const normalizedForParsing = parsingLine(rawText, lineNumber);

    lines.push({
      lineNumber,
      startOffset: lineStart,
      endOffset: lineEnd,
      rawText,
      parsingText: normalizedForParsing,
      normalizedText: trimPurchaseOuterWhitespace(normalizedForParsing),
    });

    if (!ending) break;
    lineStart = ending.index + ending[0].length;
    lineNumber += 1;
  }

  return {
    chunkId: input.chunkId,
    chunkOrdinal: input.chunkOrdinal,
    rawText: input.rawText,
    normalizedParsingText: lines.map((line) => line.parsingText).join("\n"),
    lines,
    evidence: input.evidence,
  };
}
