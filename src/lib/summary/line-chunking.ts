/**
 * LINE-safe message chunking.
 *
 * Extracted verbatim from remaining-fruit-message.ts (which re-exports every
 * symbol for backwards compatibility) so that both the existing remaining-fruit
 * report and the Stock summary can share one splitter without an import cycle.
 */

export const LINE_MESSAGE_MAX_CODE_POINTS = 4000;
export const LINE_REPLY_MAX_MESSAGES = 5;
export const OVERFLOW_NOTICE = "\n\nรายการยังไม่ครบ — ดูรายละเอียดทั้งหมดในหน้าเว็บ";

/** Count Unicode code points (not UTF-16 code units). */
export function countCodePoints(text: string): number {
  return [...text].length;
}

export function joinBlocks(blocks: string[]): string {
  return blocks.join("\n\n");
}

/** Hard split on code-point count — last resort for a block with no internal boundary. */
function splitByCodePoints(text: string, maxCodePoints: number): string[] {
  const codePoints = [...text];
  const parts: string[] = [];
  for (let i = 0; i < codePoints.length; i += maxCodePoints) {
    parts.push(codePoints.slice(i, i + maxCodePoints).join(""));
  }
  return parts;
}

/** Split only at blank-line boundaries within a single oversized block. */
function splitOversizedBlock(block: string, maxCodePoints: number): string[] {
  const parts = block.split("\n\n");
  // No internal blank-line boundary: recursing into chunkBlocks would loop
  // forever on the same single part, so fall back to a line/code-point split.
  if (parts.length <= 1) {
    const lines = block.split("\n");
    if (lines.length <= 1) return splitByCodePoints(block, maxCodePoints);
    return chunkLines(lines, maxCodePoints);
  }
  return chunkBlocks(parts, maxCodePoints);
}

/** Pack single lines into messages, hard-splitting any line that alone is too long. */
function chunkLines(lines: string[], maxCodePoints: number): string[] {
  const messages: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      messages.push(current.join("\n"));
      current = [];
    }
  };

  for (const line of lines) {
    const candidate = current.length === 0 ? line : [...current, line].join("\n");
    if (countCodePoints(candidate) <= maxCodePoints) {
      current.push(line);
      continue;
    }
    flush();
    if (countCodePoints(line) <= maxCodePoints) current = [line];
    else messages.push(...splitByCodePoints(line, maxCodePoints));
  }

  flush();
  return messages;
}

/**
 * Pack blocks into messages without splitting a block unless it alone exceeds the limit.
 */
export function chunkBlocks(blocks: string[], maxCodePoints: number): string[] {
  const messages: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      messages.push(joinBlocks(current));
      current = [];
    }
  };

  for (const block of blocks) {
    const candidate = current.length === 0 ? block : joinBlocks([...current, block]);

    if (countCodePoints(candidate) <= maxCodePoints) {
      current.push(block);
      continue;
    }

    flush();

    if (countCodePoints(block) <= maxCodePoints) {
      current = [block];
    } else {
      messages.push(...splitOversizedBlock(block, maxCodePoints));
    }
  }

  flush();
  return messages;
}

export function truncateAtSectionBoundary(text: string, maxCodePoints: number): string {
  if (countCodePoints(text) <= maxCodePoints) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice = text.slice(0, mid);
    const boundary = slice.lastIndexOf("\n\n");
    const cut = boundary > 0 ? slice.slice(0, boundary) : slice;
    if (countCodePoints(cut) <= maxCodePoints) low = mid;
    else high = mid - 1;
  }

  const slice = text.slice(0, low);
  const boundary = slice.lastIndexOf("\n\n");
  if (boundary > 0) return slice.slice(0, boundary).trimEnd();
  const lineBoundary = slice.lastIndexOf("\n");
  if (lineBoundary > 0) return slice.slice(0, lineBoundary).trimEnd();
  return slice.trimEnd();
}

export function capAtMaxMessages(
  messages: string[],
  maxMessages: number = LINE_REPLY_MAX_MESSAGES,
): string[] {
  if (messages.length <= maxMessages) return messages;

  const kept = messages.slice(0, maxMessages - 1);
  const overflow = messages.slice(maxMessages - 1).join("\n\n");
  const maxBody = LINE_MESSAGE_MAX_CODE_POINTS - countCodePoints(OVERFLOW_NOTICE);
  const truncated = truncateAtSectionBoundary(overflow, maxBody);
  kept.push(`${truncated}${OVERFLOW_NOTICE}`);
  return kept;
}
