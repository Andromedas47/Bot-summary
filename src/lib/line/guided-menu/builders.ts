import {
  MAIN_MENU_CHOICES,
  OTHER_MARKET_ID,
  PREVIEW_MARKET_OPTIONS,
} from "./config";
import { countsByTransactionType } from "./fixtures";
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

/** Start menu — operator taps เริ่มรายการ (no default transaction type). */
export function buildStartMenuFlex(): LineFlexMessage {
  return flexShell(
    "เริ่มรายการผลิต",
    "รายการผลิต",
    [
      {
        type: "text",
        text: "เริ่มด้วยปุ่ม — ไม่ต้องพิมพ์หัวข้อไทย",
        size: "sm",
        color: "#475569",
        wrap: true,
      },
      {
        type: "text",
        text: "จากนั้นส่งต่อข้อความรายการสินค้าตามปกติ",
        size: "sm",
        color: "#64748B",
        wrap: true,
      },
    ],
    [bubbleButton("เริ่มรายการ", postbackData("start"))],
  );
}

/** Transaction type selection — max 3 choices; never defaults. */
export function buildMainMenuFlex(): LineFlexMessage {
  const buttons = MAIN_MENU_CHOICES.map((choice) =>
    bubbleButton(
      choice.label,
      postbackData("select_tx", { tx: LABEL_TO_TX_CODE[choice.label] }),
    ),
  );
  buttons.push(bubbleButton("ย้อนกลับ", postbackData("menu"), "secondary"));

  return flexShell(
    "เลือกประเภทรายการ",
    "เลือกประเภทรายการ",
    [
      {
        type: "text",
        text: "ต้องเลือกประเภทอย่างชัดเจน — ไม่มีค่าเริ่มต้น",
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

  buttons.push(bubbleButton("ย้อนกลับ", postbackData("back", { tx }), "secondary"));

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
        text: "เลือกจากรายการ (สูงสุด 3 ตัวเลือก)",
        size: "sm",
        color: "#475569",
        wrap: true,
      },
    ],
    buttons,
  );
}

export function buildOtherMarketMessage(sel: GuidedMenuSelection): LineTextMessage {
  return {
    type: "text",
    text: [
      `[${PREVIEW_BADGE}]`,
      "ตลาด «ตลาดอื่น» ยังไม่รับข้อความพิมพ์เสรีในพรีวิวนี้",
      "(reserved — ไม่บันทึก free-text)",
      "",
      "กรุณาเลือกตลาดจากรายการ หรือย้อนกลับ",
    ].join("\n"),
    quickReply: quickReply([
      postbackAction("ย้อนกลับ", postbackData("back", { tx: sel.txCode! })),
      postbackAction("กลับเมนู", postbackData("menu")),
    ]),
  };
}

export function buildDateSelectFlex(sel: GuidedMenuSelection): LineFlexMessage {
  const extras = selectionExtras(sel);
  const label = TX_CODE_TO_LABEL[sel.txCode!];

  const buttons = [
    bubbleButton("วันนี้", postbackData("select_date", { ...extras, dm: "today" })),
    bubbleButton("เมื่อวาน", postbackData("select_date", { ...extras, dm: "yesterday" })),
    bubbleButton("เลือกวันที่", postbackData("custom_date", { ...extras, dm: "custom" }), "secondary"),
    bubbleButton("ย้อนกลับ", postbackData("back", { tx: sel.txCode!, mid: sel.marketId! }), "secondary"),
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

export function buildCustomDatePrompt(sel: GuidedMenuSelection): LineTextMessage {
  const extras = selectionExtras(sel);
  return {
    type: "text",
    text: [
      `[${PREVIEW_BADGE}]`,
      "เลือกวันที่ทำรายการ",
      "ในพรีวิว: เลือกวันที่ด้านล่าง แล้วกดยืนยัน",
      "(ค่าที่ส่งคำสั่งเป็น ISO yyyy-mm-dd)",
    ].join("\n"),
    quickReply: quickReply([
      postbackAction("ย้อนกลับ", postbackData("back", extras)),
      postbackAction("กลับเมนู", postbackData("menu")),
    ]),
  };
}

export function buildConfirmOpenFlex(input: {
  selection: GuidedMenuSelection;
  transactionLabel: string;
  marketLabel: string;
  businessDateThai: string;
  businessDateIso: string;
  staffLabel: string;
}): LineFlexMessage {
  const extras = selectionExtras(input.selection);
  return flexShell(
    "ยืนยันเปิดรายการ",
    "ยืนยันรายละเอียด",
    [
      {
        type: "text",
        text: "ตรวจสอบก่อนเปิด — ยังไม่ส่ง LINE / ไม่เขียนฐานข้อมูล",
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
    [
      bubbleButton("เปิดรายการ", postbackData("start_session", extras)),
      bubbleButton("กลับไปแก้ไข", postbackData("edit_open", extras), "secondary"),
    ],
  );
}

export function buildActiveSessionOpenedMessage(session: GuidedMenuActiveSession): LineTextMessage {
  const text = [
    `[${PREVIEW_BADGE}]`,
    "เปิดรายการแล้ว ✅",
    "",
    `${session.staffLabel} — ${session.marketLabel}`,
    `${session.transactionLabel} — ${session.businessDateThai}`,
    "",
    "ส่งต่อข้อความรายการสินค้ามาได้เลย",
    "(ส่งต่อจากแชทอื่น / วางข้อความตามปกติ — ไม่ใช่ฟอร์มสินค้า)",
    "เมื่อส่งครบ กด “ตรวจและจบรายการ”",
    "",
    `ข้อความที่รับแล้ว: ${session.receivedMessageCount}`,
    `รายการที่อ่านได้: ${session.parsedItemCount}`,
    `จุดต้องตรวจ: ${session.blockingIssueCount}`,
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
    postbackAction("ตรวจและจบรายการ", postbackData("review_close")),
    postbackAction("กลับเมนู", postbackData("menu")),
  ]);
}

/** Compact non-spam acknowledgement after a burst of forwards. */
export function buildCompactAckMessage(session: GuidedMenuActiveSession): LineTextMessage {
  const text = [
    `[${PREVIEW_BADGE}]`,
    `รับข้อความแล้ว ${session.receivedMessageCount} ข้อความ ✅`,
    `ขณะนี้พบรายการรอตรวจ ${session.parsedItemCount} รายการ`,
    "",
    "รับข้อความแล้ว = ได้รับเหตุการณ์ LINE แล้ว",
    "รายการรอตรวจ = อ่าน/ประกอบรายการได้แล้ว (ยังไม่บันทึก)",
    "ยังไม่ถึงขั้นยืนยันสุดท้าย",
  ].join("\n");

  return {
    type: "text",
    text,
    quickReply: quickReply([
      postbackAction("ดูสถานะ", postbackData("status")),
      postbackAction("ตรวจและจบรายการ", postbackData("review_close")),
    ]),
  };
}

export function buildSessionStatusMessage(session: GuidedMenuActiveSession): LineTextMessage {
  const itemLines = session.items.slice(0, 4).map(
    (item) => `#${item.itemNumber} ${item.productName} ${item.pricePerUnit} บาท ${item.quantity ?? "?"} ${item.unit ?? ""}`.trim(),
  );
  const issueLines = session.issues.map(
    (issue) => `⚠ #${issue.itemNumber ?? "?"} ${issue.message}\n${issue.rawText}`,
  );

  const text = [
    `[${PREVIEW_BADGE}]`,
    "สถานะเซสชัน",
    `${session.staffLabel} — ${session.marketLabel}`,
    `${session.transactionLabel} — ${session.businessDateThai}`,
    "",
    `ข้อความที่รับแล้ว: ${session.receivedMessageCount}`,
    `รายการที่อ่านได้: ${session.parsedItemCount}`,
    `จุดต้องตรวจ: ${session.blockingIssueCount}`,
    "สถานะบันทึก: ยังไม่บันทึก",
    "",
    itemLines.length > 0 ? "ตัวอย่างรายการ:" : "ยังไม่มีรายการ",
    ...itemLines,
    ...(issueLines.length > 0 ? ["", "ข้อความที่มีปัญหา:", ...issueLines] : []),
  ].join("\n");

  return {
    type: "text",
    text,
    quickReply: quickReply([
      postbackAction("ส่งรายการเพิ่ม", postbackData("send_more")),
      postbackAction("ตรวจและจบรายการ", postbackData("review_close")),
      postbackAction("กลับ", postbackData("back")),
    ]),
  };
}

/** Close barrier — waiting for in-flight forwarded LINE events. Not persisted. */
export function buildCloseBarrierMessage(session: GuidedMenuActiveSession): LineTextMessage {
  const text = [
    `[${PREVIEW_BADGE}]`,
    "รับคำสั่งจบแล้ว",
    "กำลังรอข้อความที่ส่งค้างอยู่…",
    "",
    "กำลังรอเหตุการณ์ที่ส่งต่อเข้ามายังค้างอยู่",
    "ยังไม่มีการบันทึกข้อมูลใด ๆ",
    "",
    `admitted: ${session.admittedEventCount}`,
    `ingested: ${session.ingestedEventCount}`,
    `สถานะ barrier: ${session.closeBarrierStatus}`,
  ].join("\n");

  return {
    type: "text",
    text,
    quickReply: quickReply([
      postbackAction("รอครบแล้ว (พรีวิว)", postbackData("barrier_ready")),
      postbackAction("กลับ", postbackData("close_cancel")),
    ]),
  };
}

export function buildReviewValidFlex(session: GuidedMenuActiveSession): LineFlexMessage {
  const counts = countsByTransactionType(session.items);
  const countLines = Object.entries(counts).map(([tx, n]) => ({
    type: "text" as const,
    text: `${tx === "คืน" ? "ชั่งคืน" : tx}: ${n} รายการ`,
    size: "sm",
    color: "#0F172A",
  }));

  const itemPreview = session.items.slice(0, 6).map((item) => ({
    type: "text" as const,
    text: `#${item.itemNumber} ${item.rawPreview}`,
    size: "xs",
    color: "#334155",
    wrap: true,
  }));

  return flexShell(
    "พร้อมบันทึก",
    `พร้อมบันทึก ${session.parsedItemCount} รายการ`,
    [
      {
        type: "text",
        text: "ไม่มีจุดต้องตรวจ — ยังไม่บันทึกจนกว่าจะยืนยัน",
        size: "sm",
        color: "#047857",
        wrap: true,
      },
      ...countLines,
      { type: "separator", margin: "md" },
      { type: "text", text: "รายการที่จะบันทึก:", size: "sm", weight: "bold", color: "#0F172A" },
      ...itemPreview,
    ],
    [
      bubbleButton("ยืนยันบันทึก", postbackData("confirm_persist")),
      bubbleButton("กลับไปตรวจ", postbackData("back_review"), "secondary"),
    ],
  );
}

export function buildReviewBlockingFlex(session: GuidedMenuActiveSession): LineFlexMessage {
  const issue = session.issues[0];
  return flexShell(
    "ยังบันทึกไม่ได้",
    "ยังบันทึกไม่ได้",
    [
      {
        type: "text",
        text: `อ่านครบ: ${session.parsedItemCount} รายการ`,
        size: "sm",
        color: "#0F172A",
      },
      {
        type: "text",
        text: `ต้องตรวจ: ${session.blockingIssueCount} จุด`,
        size: "sm",
        color: "#B45309",
        weight: "bold",
      },
      { type: "separator", margin: "md" },
      {
        type: "text",
        text: issue
          ? `#${issue.itemNumber ?? "?"} ${issue.rawText.replace(/\n/g, " ")}`
          : "พบจุดต้องตรวจ",
        size: "sm",
        color: "#0F172A",
        wrap: true,
      },
      {
        type: "text",
        text: issue?.message ?? "ข้อมูลไม่ครบ",
        size: "sm",
        color: "#B91C1C",
        wrap: true,
      },
      {
        type: "text",
        text: "ยังไม่มีข้อมูลใดถูกบันทึก",
        size: "sm",
        color: "#64748B",
        margin: "md",
        wrap: true,
      },
    ],
    [
      bubbleButton("ส่งข้อความแก้ไข", postbackData("send_fix"), "secondary"),
      bubbleButton("กลับไปส่งเพิ่ม", postbackData("send_more"), "secondary"),
      bubbleButton("กลับไปตรวจ", postbackData("back_review"), "secondary"),
    ],
  );
}

export function buildFinalConfirmFlex(session: GuidedMenuActiveSession): LineFlexMessage {
  return flexShell(
    "ยืนยันบันทึก",
    "ยืนยันบันทึก?",
    [
      {
        type: "text",
        text: "ต้องกดยืนยันชัดเจน — ไม่บันทึกอัตโนมัติ",
        size: "sm",
        color: "#475569",
        wrap: true,
      },
      ...summaryRows([
        { label: "พนักงาน", value: session.staffLabel },
        { label: "ตลาด", value: session.marketLabel },
        { label: "ประเภท", value: session.transactionLabel },
        { label: "วันที่", value: session.businessDateThai },
        { label: "จำนวนรายการ", value: String(session.parsedItemCount) },
      ]),
      {
        type: "text",
        text: "PREVIEW ONLY — จำลองการบันทึกเท่านั้น",
        size: "xs",
        color: "#B45309",
        margin: "md",
      },
    ],
    [
      bubbleButton("ยืนยันบันทึก", postbackData("finalize")),
      bubbleButton("กลับไปตรวจ", postbackData("back_review"), "secondary"),
    ],
  );
}

export function buildSuccessMessage(session: GuidedMenuActiveSession): LineTextMessage {
  return {
    type: "text",
    text: [
      `[${PREVIEW_BADGE}]`,
      "บันทึกแล้ว ✅ (จำลองพรีวิว)",
      "",
      `${session.staffLabel} — ${session.marketLabel}`,
      `${session.transactionLabel} — ${session.businessDateThai}`,
      `รวม ${session.parsedItemCount} รายการ`,
      "",
      "ไม่มีการเขียนฐานข้อมูลจริง / ไม่ส่ง LINE API",
    ].join("\n"),
    quickReply: quickReply([
      postbackAction("กลับเมนู", postbackData("menu")),
    ]),
  };
}

/** @deprecated gallery/compat — prefer review_valid / final_confirm */
export function buildCloseConfirmFlex(session: GuidedMenuActiveSession): LineFlexMessage {
  if (session.blockingIssueCount > 0) return buildReviewBlockingFlex(session);
  return buildReviewValidFlex(session);
}

/** @deprecated gallery/compat */
export function buildSessionClosedMessage(session?: GuidedMenuActiveSession): LineTextMessage {
  if (session) return buildSuccessMessage(session);
  return {
    type: "text",
    text: `[${PREVIEW_BADGE}]\nบันทึกแล้ว ✅ (จำลองพรีวิว)\nไม่มีการเขียนฐานข้อมูลจริง`,
    quickReply: quickReply([postbackAction("กลับเมนู", postbackData("menu"))]),
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

/** Alias retained for older imports. */
export const buildActiveSessionStatusMessage = buildActiveSessionOpenedMessage;

export function buildAllPreviewStates(sample: {
  selection: GuidedMenuSelection;
  session: GuidedMenuActiveSession;
  validSession: GuidedMenuActiveSession;
  blockingSession: GuidedMenuActiveSession;
  barrierSession: GuidedMenuActiveSession;
  transactionLabel: string;
  marketLabel: string;
  businessDateThai: string;
  businessDateIso: string;
  staffLabel: string;
}): { id: string; label: string; message: LinePreviewMessage }[] {
  return [
    { id: "start_menu", label: "เริ่มรายการ", message: buildStartMenuFlex() },
    { id: "main_menu", label: "เลือกประเภท", message: buildMainMenuFlex() },
    { id: "market_select", label: "เลือกตลาด", message: buildMarketSelectFlex(sample.selection) },
    { id: "other_market", label: "ตลาดอื่น", message: buildOtherMarketMessage(sample.selection) },
    { id: "date_select", label: "เลือกวันที่", message: buildDateSelectFlex(sample.selection) },
    { id: "custom_date", label: "เลือกวันที่ (กำหนดเอง)", message: buildCustomDatePrompt(sample.selection) },
    {
      id: "confirm_open",
      label: "ยืนยันเปิดรายการ",
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
      label: "เซสชันเปิด",
      message: buildActiveSessionOpenedMessage(sample.session),
    },
    { id: "ack_compact", label: "ตอบรับแบบย่อ", message: buildCompactAckMessage(sample.validSession) },
    {
      id: "session_status_valid",
      label: "สถานะ (ครบถ้วน)",
      message: buildSessionStatusMessage(sample.validSession),
    },
    {
      id: "session_status_error",
      label: "สถานะ (มีปัญหา)",
      message: buildSessionStatusMessage(sample.blockingSession),
    },
    {
      id: "close_barrier",
      label: "รอข้อความค้าง",
      message: buildCloseBarrierMessage(sample.barrierSession),
    },
    { id: "review_valid", label: "ตรวจครบถ้วน", message: buildReviewValidFlex(sample.validSession) },
    {
      id: "review_blocking",
      label: "ตรวจมีปัญหา",
      message: buildReviewBlockingFlex(sample.blockingSession),
    },
    {
      id: "final_confirm",
      label: "ยืนยันบันทึก",
      message: buildFinalConfirmFlex(sample.validSession),
    },
    { id: "success", label: "สำเร็จ (จำลอง)", message: buildSuccessMessage(sample.validSession) },
  ];
}
