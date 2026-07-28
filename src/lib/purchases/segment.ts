import {
  classifyPurchaseFirstLine,
  startsWithPurchaseReservedPrefix,
} from "./classify";
import type {
  PurchaseBlockInput,
  PurchaseBlockKind,
  PurchaseBlockSpan,
  PurchaseSourceLine,
  PurchaseTextChunk,
} from "./types";

const FIELD_LABELS: Record<PurchaseBlockKind, readonly string[]> = {
  HEADER: ["ผู้ขาย", "ใบอ้างอิง", "ปลายทาง"],
  ITEM: ["สินค้า", "จำนวน", "ราคา"],
  COSTS: [
    "ค่าขนส่ง",
    "ค่าจัดการ",
    "ส่วนลด",
    "ภาษีมูลค่าเพิ่ม",
    "ภาษีรวมในราคาสินค้า",
    "ภาษีขอคืนได้",
  ],
  CLOSE: [],
};

function nonblankLines(lines: readonly PurchaseSourceLine[]): PurchaseSourceLine[] {
  return lines.filter((line) => line.normalizedText.length > 0);
}

function requiredNonblankCount(
  kind: PurchaseBlockKind,
  collected: readonly PurchaseSourceLine[],
): number {
  if (kind !== "COSTS") {
    return kind === "CLOSE" ? 1 : 4;
  }

  if (
    collected.length >= 5
    && collected[4]?.normalizedText === "ภาษีมูลค่าเพิ่ม: ไม่มี"
  ) {
    return 5;
  }
  return 7;
}

function makeSpan(
  chunk: PurchaseTextChunk,
  lines: readonly PurchaseSourceLine[],
): PurchaseBlockSpan | null {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) return null;

  return {
    blockId: `${chunk.chunkId}:${first.lineNumber}-${last.lineNumber}`,
    chunkId: chunk.chunkId,
    chunkOrdinal: chunk.chunkOrdinal,
    startLine: first.lineNumber,
    endLine: last.lineNumber,
    startOffset: first.startOffset,
    endOffset: last.endOffset,
    rawText: chunk.rawText.slice(first.startOffset, last.endOffset),
    normalizedParsingText: lines.map((line) => line.parsingText).join("\n"),
    lines,
  };
}

/**
 * Splits complete candidates within one chunk. It never consumes text from a
 * neighboring chunk and never silently discards a nonblank unknown line.
 */
export function segmentPurchaseChunk(
  chunk: PurchaseTextChunk,
): PurchaseBlockInput[] {
  const candidates: PurchaseBlockInput[] = [];
  let cursor = 0;

  while (cursor < chunk.lines.length) {
    const start = chunk.lines.findIndex(
      (line, index) => index >= cursor && line.normalizedText.length > 0,
    );
    if (start < 0) break;

    const first = chunk.lines[start];
    if (!first) break;
    const classification = classifyPurchaseFirstLine(first.normalizedText);

    if (
      classification === "NOT_PURCHASE"
      || classification === "INVALID_RESERVED_PURCHASE_BLOCK"
    ) {
      const span = makeSpan(chunk, [first]);
      if (!span) break;
      candidates.push({ chunk, span });
      cursor = start + 1;
      continue;
    }

    const kind = classification as PurchaseBlockKind;
    const collected: PurchaseSourceLine[] = [];
    let scan = start;
    let retainForbiddenNoVatDetails = false;

    while (scan < chunk.lines.length) {
      const line = chunk.lines[scan];
      if (!line) break;

      if (
        scan > start
        && line.normalizedText.length > 0
        && startsWithPurchaseReservedPrefix(line.normalizedText)
      ) {
        break;
      }

      collected.push(line);
      const meaningful = nonblankLines(collected);
      if (
        kind === "COSTS"
        && meaningful.length === 5
        && meaningful[4]?.normalizedText === "ภาษีมูลค่าเพิ่ม: ไม่มี"
      ) {
        const nextMeaningful = chunk.lines
          .slice(scan + 1)
          .find((candidate) => candidate.normalizedText.length > 0);
        retainForbiddenNoVatDetails = Boolean(
          nextMeaningful
          && (
            isExactPurchaseFieldLine(
              nextMeaningful,
              "ภาษีรวมในราคาสินค้า",
            )
            || isExactPurchaseFieldLine(nextMeaningful, "ภาษีขอคืนได้")
          ),
        );
      }

      const required = retainForbiddenNoVatDetails
        ? 7
        : requiredNonblankCount(kind, meaningful);
      if (meaningful.length >= required) {
        break;
      }
      scan += 1;
    }

    while (
      collected.length > 1
      && collected[collected.length - 1]?.normalizedText.length === 0
    ) {
      collected.pop();
    }

    const span = makeSpan(chunk, collected);
    if (!span) break;
    candidates.push({ chunk, span });
    cursor = start + collected.length;
  }

  if (
    candidates.length === 0
    && chunk.lines.every((line) => line.normalizedText.length === 0)
  ) {
    const span = makeSpan(chunk, chunk.lines);
    if (span) candidates.push({ chunk, span });
  }

  return candidates;
}

export function isExactPurchaseFieldLine(
  line: PurchaseSourceLine,
  label: string,
): boolean {
  const delimiter = `${label}:`;
  if (line.normalizedText === delimiter) return true;
  if (!line.normalizedText.startsWith(`${delimiter} `)) return false;
  const value = line.normalizedText.slice(delimiter.length + 1);
  return !value.startsWith(" ") && !value.startsWith("\t");
}

/**
 * Returns the sole next label that can prove a block was split. A malformed
 * field sequence is never treated as split evidence.
 */
export function expectedPurchaseContinuationLabel(
  input: PurchaseBlockInput,
): string | null {
  const meaningful = nonblankLines(input.span.lines);
  const opener = meaningful[0];
  if (!opener) return null;

  const classification = classifyPurchaseFirstLine(opener.normalizedText);
  if (
    classification === "NOT_PURCHASE"
    || classification === "EMPTY_BLOCK"
    || classification === "INVALID_RESERVED_PURCHASE_BLOCK"
  ) {
    return null;
  }

  const kind = classification as PurchaseBlockKind;
  const labels = FIELD_LABELS[kind];
  const fields = meaningful.slice(1);
  const required = requiredNonblankCount(kind, meaningful);
  if (meaningful.length >= required) return null;

  for (let index = 0; index < fields.length; index += 1) {
    const expected = labels[index];
    const actual = fields[index];
    if (!expected || !actual || !isExactPurchaseFieldLine(actual, expected)) {
      return null;
    }
  }

  return labels[fields.length] ?? null;
}

export function firstNonblankPurchaseLine(
  chunk: PurchaseTextChunk,
): PurchaseSourceLine | null {
  return chunk.lines.find((line) => line.normalizedText.length > 0) ?? null;
}

export function blockEndsAtChunkBoundary(input: PurchaseBlockInput): boolean {
  const lastMeaningful = [...input.chunk.lines]
    .reverse()
    .find((line) => line.normalizedText.length > 0);
  const blockLast = [...input.span.lines]
    .reverse()
    .find((line) => line.normalizedText.length > 0);
  return Boolean(
    lastMeaningful
    && blockLast
    && lastMeaningful.lineNumber === blockLast.lineNumber,
  );
}
