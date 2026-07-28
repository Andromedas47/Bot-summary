import {
  MAIN_MENU_CHOICES,
  OTHER_MARKET_ID,
  PREVIEW_MARKET_OPTIONS,
} from "./config";
import { postbackData } from "./postback";
import {
  LABEL_TO_TX_CODE,
  TX_CODE_TO_LABEL,
  type GuidedMenuActiveSession,
  type GuidedMenuDateMode,
  type GuidedMenuSelection,
  type GuidedMenuTxCode,
  type LineFlexMessage,
  type LinePreviewMessage,
  type LineQuickReply,
  type LineTextMessage,
} from "./types";

const PREVIEW_BADGE = "PREVIEW ONLY";

function postbackAction(
  label: string,
  data: string,
  displayText?: string,
): LineQuickReply["items"][number] {
  return {
    type: "action",
    action: {
      type: "postback",
      label: label.slice(0, 20),
      data,
      displayText: displayText ?? label,
    },
  };
}

function quickReply(items: LineQuickReply["items"]): LineQuickReply {
  return { items: items.slice(0, 13) };
}

function selectionExtras(sel: GuidedMenuSelection): {
  tx?: GuidedMenuTxCode;
  mid?: string;
  dm?: GuidedMenuDateMode;
  iso?: string;
} {
  return {
    ...(sel.txCode ? { tx: sel.txCode } : {}),
    ...(sel.marketId ? { mid: sel.marketId } : {}),
    ...(sel.dateMode ? { dm: sel.dateMode } : {}),
    ...(sel.customIsoDate ? { iso: sel.customIsoDate } : {}),
  };
}

function bubbleButton(label: string, data: string, style: "primary" | "secondary" = "primary") {
  return {
    type: "button",
    style,
    height: "md",
    action: {
      type: "postback",
      label,
      data,
      displayText: label,
    },
  };
}

function flexShell(
  altText: string,
  title: string,
  bodyContents: Record<string, unknown>[],
  footerButtons: Record<string, unknown>[],
  qr?: LineQuickReply,
): LineFlexMessage {
  const msg: LineFlexMessage = {
    type: "flex",
    altText: `[${PREVIEW_BADGE}] ${altText}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0F172A",
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: PREVIEW_BADGE,
            color: "#FBBF24",
            size: "xs",
            weight: "bold",
          },
          {
            type: "text",
            text: title,
            color: "#FFFFFF",
            size: "xl",
            weight: "bold",
            margin: "md",
            wrap: true,
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "16px",
        contents: bodyContents,
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "12px",
        contents: footerButtons,
      },
    },
  };
  if (qr) msg.quickReply = qr;
  return msg;
}

/** Main menu — max 3 primary transaction choices. */
export function buildMainMenuFlex(): LineFlexMessage {
  const buttons = MAIN_MENU_CHOICES.map((choice) =>
    bubbleButton(
      choice.label,
      postbackData("select_tx", { tx: LABEL_TO_TX_CODE[choice.label] }),
    ),
  );

  return flexShell(
    "เมนูรายการผลิต",
    "เลือกประเภทรายการ",
    [
      {
        type: "text",
        text: "เลือกประเภทเพื่อเริ่มเซสชัน (ไม่ต้องพิมพ์หัวข้อไทย)",
        size: "sm",
        color: "#475569",
        wrap: true,
      },
      ...MAIN_MENU_CHOICES.map((choice) => ({
        type: "box",
        layout: "vertical",
        margin: "md",
        contents: [
          { type: "text", text: choice.label, weight: "bold", size: "md", color: "#0F172A" },
          { type: "text", text: choice.description, size: "xs", color: "#64748B", wrap: true },
        ],
      })),
    ],
    buttons,
  );
}

/** Market selection — configurable options + อื่น ๆ. */
export function buildMarketSelectFlex(sel: GuidedMenuSelection): LineFlexMessage {
  const tx = sel.txCode!;
  const label = TX_CODE_TO_LABEL[tx];
  const extras = selectionExtras(sel);

  const buttons = PREVIEW_MARKET_OPTIONS.map((market) => {
    if (market.id === OTHER_MARKET_ID) {
      return bubbleButton(
        market.label,
        postbackData("other_market", { ...extras, mid: market.id }),
        "secondary",
      );
    }
    return bubbleButton(
      market.label,
      postbackData("select_market", { ...extras, mid: market.id }),
    );
  });

  buttons.push(
    bubbleButton("ย้อนกลับ", postbackData("back", { tx }), "secondary"),
  );

  return flexShell(
    `เลือกตลาด — ${label}`,
    "เลือกตลาด",
    [
      {
        type: "text",
        text: `ประเภท: ${label}`,
        size: "sm",
        color: "#0F172A",
        weight: "bold",
      },
      {
        type: "text",
        text: "เลือกตลาดจากรายการ (สูงสุด 3 ตัวเลือกหลัก)",
        size: "sm",
        color: "#475569",
        wrap: true,
      },
    ],
    buttons,
  );
}

/** อื่น ๆ — state exists, free-text persistence is intentionally not implemented. */
export function buildOtherMarketMessage(sel: GuidedMenuSelection): LineTextMessage {
  return {
    type: "text",
    text: `[${PREVIEW_BADGE}]\nตลาด «อื่น ๆ» ยังไม่รับข้อความพิมพ์เสรีในพรีวิวนี้\n(reserved — ไม่บันทึก free-text)\n\nกรุณาเลือกตลาดจากรายการ หรือย้อนกลับ`,
    quickReply: quickReply([
      postbackAction("เลือกตลาดใหม่", postbackData("back", { tx: sel.txCode! })),
      postbackAction("กลับเมนู", postbackData("menu")),
    ]),
  };
}

/** Business date selection — วันนี้ / เมื่อวาน / ระบุวันที่. */
export function buildDateSelectFlex(sel: GuidedMenuSelection): LineFlexMessage {
  const extras = selectionExtras(sel);
  const label = TX_CODE_TO_LABEL[sel.txCode!];

  const buttons = [
    bubbleButton("วันนี้", postbackData("select_date", { ...extras, dm: "today" })),
    bubbleButton("เมื่อวาน", postbackData("select_date", { ...extras, dm: "yesterday" })),
    bubbleButton("ระบุวันที่", postbackData("custom_date", { ...extras, dm: "custom" }), "secondary"),
    bubbleButton("ย้อนกลับ", postbackData("back", { tx: sel.txCode! }), "secondary"),
  ];

  return flexShell(
    `เลือกวันที่ — ${label}`,
    "เลือกวันทำรายการ",
    [
      {
        type: "text",
        text: "แสดงผลเป็น พ.ศ. — ค่าคำสั่งเก็บเป็น ISO",
        size: "sm",
        color: "#475569",
        wrap: true,
      },
    ],
    buttons,
  );
}

/** Custom date prompt — preview collects ISO via UI; postback carries validated iso. */
export function buildCustomDatePrompt(sel: GuidedMenuSelection): LineTextMessage {
  const extras = selectionExtras(sel);
  return {
    type: "text",
    text: `[${PREVIEW_BADGE}]\nระบุวันที่ทำรายการ\nในพรีวิว: เลือกวันที่ด้านล่าง แล้วกดยืนยัน\n(ค่าที่ส่งคำสั่งเป็น ISO yyyy-mm-dd)`,
    quickReply: quickReply([
      postbackAction("ย้อนกลับ", postbackData("back", extras)),
      postbackAction("กลับเมนู", postbackData("menu")),
    ]),
  };
}

function summaryRows(rows: { label: string; value: string }[]) {
  return rows.map((row) => ({
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: row.label, color: "#64748B", size: "sm", flex: 2, wrap: true },
      { type: "text", text: row.value, color: "#0F172A", size: "sm", flex: 3, weight: "bold", wrap: true },
    ],
  }));
}

/** Confirmation summary before starting a session. */
export function buildConfirmOpenFlex(input: {
  selection: GuidedMenuSelection;
  transactionLabel: string;
  marketLabel: string;
  businessDateThai: string;
  businessDateIso: string;
  staffLabel: string;
}): LineFlexMessage {
  const extras = selectionExtras(input.selection);
  const buttons = [
    bubbleButton("เริ่มเซสชัน", postbackData("start_session", extras)),
    bubbleButton("ยกเลิก", postbackData("menu"), "secondary"),
  ];

  return flexShell(
    "ยืนยันเริ่มเซสชัน",
    "ยืนยันรายละเอียด",
    [
      {
        type: "text",
        text: "ตรวจสอบก่อนเริ่ม — ยังไม่ส่ง LINE / ไม่เขียนฐานข้อมูล",
        size: "xs",
        color: "#B45309",
        wrap: true,
      },
      ...summaryRows([
        { label: "ประเภท", value: input.transactionLabel },
        { label: "ตลาด", value: input.marketLabel },
        { label: "วันที่ (พ.ศ.)", value: input.businessDateThai },
        { label: "วันที่ (ISO)", value: input.businessDateIso },
        { label: "พนักงาน", value: input.staffLabel },
      ]),
    ],
    buttons,
  );
}

/** Active-session status + quick replies. */
export function buildActiveSessionStatusMessage(
  session: GuidedMenuActiveSession,
): LineTextMessage {
  const text = [
    `[${PREVIEW_BADGE}]`,
    "เซสชันเปิดอยู่",
    `ประเภท: ${session.transactionLabel}`,
    `ตลาด: ${session.marketLabel}`,
    `วันที่: ${session.businessDateThai}`,
    `พนักงาน: ${session.staffLabel}`,
    `รายการที่สังเกต: ${session.observedItemCount}`,
    "",
    "พิมพ์รายการสินค้าได้ตามปกติ (พรีวิวไม่บันทึก)",
  ].join("\n");

  return {
    type: "text",
    text,
    quickReply: buildActiveSessionQuickReplies(),
  };
}

export function buildActiveSessionQuickReplies(): LineQuickReply {
  return quickReply([
    postbackAction("ดูสถานะ", postbackData("status")),
    postbackAction("จบรายการ", postbackData("close_ask")),
    postbackAction("กลับเมนู", postbackData("menu")),
  ]);
}

/** Close confirmation — requires explicit confirm; shows observed item count. */
export function buildCloseConfirmFlex(session: GuidedMenuActiveSession): LineFlexMessage {
  return flexShell(
    "ยืนยันจบรายการ",
    "ยืนยันจบรายการ?",
    [
      {
        type: "text",
        text: "การจบรายการต้องยืนยันชัดเจน — ไม่ปิดอัตโนมัติ",
        size: "sm",
        color: "#475569",
        wrap: true,
      },
      ...summaryRows([
        { label: "ประเภท", value: session.transactionLabel },
        { label: "ตลาด", value: session.marketLabel },
        { label: "วันที่", value: session.businessDateThai },
        { label: "จำนวนรายการ", value: String(session.observedItemCount) },
      ]),
    ],
    [
      bubbleButton("ยืนยันจบรายการ", postbackData("close_confirm")),
      bubbleButton("ย้อนกลับ", postbackData("close_cancel"), "secondary"),
    ],
  );
}

export function buildSessionClosedMessage(): LineTextMessage {
  return {
    type: "text",
    text: `[${PREVIEW_BADGE}]\nจบรายการแล้ว (พรีวิว)\nไม่มีการเขียนฐานข้อมูลจริง`,
    quickReply: quickReply([
      postbackAction("กลับเมนู", postbackData("menu")),
    ]),
  };
}

export function buildErrorMessage(reason: string): LineTextMessage {
  return {
    type: "text",
    text: `[${PREVIEW_BADGE}]\nโพสต์แบ็กไม่ถูกต้องหรือถูกแก้ไข\n(${reason})\nกรุณาเริ่มจากเมนูใหม่`,
    quickReply: quickReply([
      postbackAction("กลับเมนู", postbackData("menu")),
    ]),
  };
}

/** All primary Flex/QR preview states for the admin gallery. */
export function buildAllPreviewStates(sample: {
  selection: GuidedMenuSelection;
  session: GuidedMenuActiveSession;
  transactionLabel: string;
  marketLabel: string;
  businessDateThai: string;
  businessDateIso: string;
  staffLabel: string;
}): { id: string; label: string; message: LinePreviewMessage }[] {
  return [
    { id: "main_menu", label: "เมนูหลัก", message: buildMainMenuFlex() },
    { id: "market_select", label: "เลือกตลาด", message: buildMarketSelectFlex(sample.selection) },
    { id: "other_market", label: "ตลาดอื่น ๆ", message: buildOtherMarketMessage(sample.selection) },
    { id: "date_select", label: "เลือกวันที่", message: buildDateSelectFlex(sample.selection) },
    { id: "custom_date", label: "ระบุวันที่", message: buildCustomDatePrompt(sample.selection) },
    {
      id: "confirm_open",
      label: "ยืนยันเปิดเซสชัน",
      message: buildConfirmOpenFlex({
        selection: sample.selection,
        transactionLabel: sample.transactionLabel,
        marketLabel: sample.marketLabel,
        businessDateThai: sample.businessDateThai,
        businessDateIso: sample.businessDateIso,
        staffLabel: sample.staffLabel,
      }),
    },
    {
      id: "active_session",
      label: "เซสชันเปิด / Quick Reply",
      message: buildActiveSessionStatusMessage(sample.session),
    },
    { id: "close_confirm", label: "ยืนยันจบรายการ", message: buildCloseConfirmFlex(sample.session) },
    { id: "session_closed", label: "จบแล้ว", message: buildSessionClosedMessage() },
  ];
}
