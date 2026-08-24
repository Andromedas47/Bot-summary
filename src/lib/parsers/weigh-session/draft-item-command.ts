import type { DraftItemAction, WeighSession } from "./types";

export type DraftItemCommand = {
  kind: "correct" | "remove";
  itemNumber: number;
};

const CORRECT_ITEM = /^แก้ข้อ\s*(\d+)\s*$/;
const REMOVE_ITEM = /^ลบข้อ\s*(\d+)\s*$/;

/** Exact control grammar. Ordinary repeated item numbers keep legacy meaning. */
export function parseDraftItemCommandLine(text: string): DraftItemCommand | null {
  const correct = text.trim().match(CORRECT_ITEM);
  if (correct) return { kind: "correct", itemNumber: Number(correct[1]) };

  const remove = text.trim().match(REMOVE_ITEM);
  if (remove) return { kind: "remove", itemNumber: Number(remove[1]) };

  return null;
}

/** Last explicit action in one incoming LINE message, if any. */
export function findDraftItemCommand(text: string): DraftItemCommand | null {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const command = parseDraftItemCommandLine(lines[index]);
    if (command) return command;
  }
  return null;
}

export function latestDraftItemAction(session: WeighSession): DraftItemAction | null {
  return session.draft_item_actions?.at(-1) ?? null;
}

/** Operator copy shared by plain-text and guided capture acknowledgements. */
export function buildDraftItemActionReply(action: DraftItemAction): string {
  const item = `ข้อ ${action.item_number}`;

  if (action.status === "awaiting_replacement") {
    return [
      `✏️ จะแก้${item}`,
      "",
      `ส่งรายการ${item}ใหม่ พร้อมราคาและจำนวน`,
      "รายการอื่นยังอยู่ครบ ไม่ต้องยกเลิก",
    ].join("\n");
  }

  if (action.status === "target_not_found") {
    return [
      `⛔ ${action.kind === "remove" ? "ลบ" : "แก้"}${item}ไม่ได้`,
      `ไม่พบ${item}ในรายการที่กำลังกรอก`,
      "รายการเดิมยังไม่เปลี่ยนแปลง",
    ].join("\n");
  }

  if (action.status === "ambiguous_target") {
    return [
      `⛔ ${action.kind === "remove" ? "ลบ" : "แก้"}${item}ไม่ได้`,
      `พบเลข${item}มากกว่า 1 รายการ จึงไม่เลือกรายการแทนให้`,
      "รายการเดิมยังไม่เปลี่ยนแปลง",
    ].join("\n");
  }

  if (action.status === "invalid_replacement") {
    return [
      `⚠️ ยังแก้${item}ไม่ได้`,
      action.detail ?? "รายการใหม่ยังไม่ครบหรืออ่านไม่ได้",
      "รายการเดิมยังไม่เปลี่ยนแปลง",
      `ส่ง “แก้ข้อ ${action.item_number}” แล้วส่งรายการใหม่อีกครั้ง`,
    ].join("\n");
  }

  if (action.kind === "remove") {
    return [
      `✅ ลบ${item} แล้ว`,
      "รายการอื่นยังอยู่ครบ",
    ].join("\n");
  }

  const replacement = action.replacement_item;
  return [
    `✅ แก้${item} แล้ว`,
    ...(replacement
      ? [
          `${replacement.product_name} — ${replacement.price_per_unit} บาท`,
          `${replacement.quantity} ${replacement.unit}`,
        ]
      : []),
    "รายการอื่นยังอยู่ครบ",
    "เมื่อครบแล้วปิดรายการตามปกติ",
  ].join("\n");
}
