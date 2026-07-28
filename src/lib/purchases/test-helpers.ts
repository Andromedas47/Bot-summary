import {
  createPurchaseTextChunk,
  segmentPurchaseChunk,
  type LineTextEvidenceMetadata,
  type PurchaseBlockInput,
  type PurchaseTextChunk,
} from "./index";

export const HEADER_KNOWN = `เริ่มซื้อ 28/07/2569 06:30
ผู้ขาย: ร้านเจ๊แดง
ใบอ้างอิง: INV-123
ปลายทาง: MAIN`;

export const HEADER_UNKNOWN = `เริ่มซื้อ 28/07/2569 ไม่ทราบเวลา
ผู้ขาย: ร้านเจ๊แดง
ใบอ้างอิง: ไม่มี
ปลายทาง: MAIN`;

export const ITEM_ONE = `ซื้อรายการ 1
สินค้า: หมอนทอง
จำนวน: 120 โล
ราคา: 85 บาท/โล`;

export const ITEM_TWO_UNKNOWN = `ซื้อรายการ 2
สินค้า: องุ่นเขียวตะกร้าแดง
จำนวน: 6 ตะกร้า
ราคา: ไม่ทราบ`;

export const COSTS_NO_VAT = `สรุปค่าใช้จ่ายซื้อ
ค่าขนส่ง: 300 บาท
ค่าจัดการ: 50 บาท
ส่วนลด: 100 บาท
ภาษีมูลค่าเพิ่ม: ไม่มี`;

export const COSTS_POSITIVE_VAT = `สรุปค่าใช้จ่ายซื้อ
ค่าขนส่ง: 300 บาท
ค่าจัดการ: 50 บาท
ส่วนลด: 100 บาท
ภาษีมูลค่าเพิ่ม: 70 บาท
ภาษีรวมในราคาสินค้า: ใช่
ภาษีขอคืนได้: ใช่`;

export const CLOSE_TWO = "ปิดซื้อ 2 รายการ";

export const COMPLETE_DOCUMENT = [
  HEADER_KNOWN,
  ITEM_ONE,
  ITEM_TWO_UNKNOWN,
  COSTS_NO_VAT,
  CLOSE_TWO,
].join("\n\n");

export function lineEvidence(
  suffix = "1",
  timestamp = "1785232800000",
): LineTextEvidenceMetadata {
  return {
    source: "LINE_TEXT",
    lineEventId: `event-${suffix}`,
    lineMessageId: `message-${suffix}`,
    eventTimestampMs: BigInt(timestamp),
    sourceType: "user",
    sourceId: `source-${suffix}`,
    senderLineUserId: `user-${suffix}`,
  };
}

export function makeChunk(
  rawText: string,
  chunkOrdinal = 1,
  chunkId = `chunk-${chunkOrdinal}`,
): PurchaseTextChunk {
  return createPurchaseTextChunk({
    chunkId,
    chunkOrdinal,
    rawText,
    evidence: lineEvidence(String(chunkOrdinal)),
  });
}

export function firstBlock(rawText: string): PurchaseBlockInput {
  const chunk = makeChunk(rawText);
  const block = segmentPurchaseChunk(chunk)[0];
  if (!block) throw new Error("Test fixture did not produce a block");
  return block;
}

export function wholeChunkBlock(rawText: string): PurchaseBlockInput {
  const chunk = makeChunk(rawText);
  const first = chunk.lines[0];
  const last = chunk.lines[chunk.lines.length - 1];
  if (!first || !last) throw new Error("Chunk factory must retain one line");
  return {
    chunk,
    span: {
      blockId: `${chunk.chunkId}:whole`,
      chunkId: chunk.chunkId,
      chunkOrdinal: chunk.chunkOrdinal,
      startLine: first.lineNumber,
      endLine: last.lineNumber,
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      rawText: chunk.rawText,
      normalizedParsingText: chunk.normalizedParsingText,
      lines: chunk.lines,
    },
  };
}
