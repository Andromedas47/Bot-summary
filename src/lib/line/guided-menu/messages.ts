/**
 * Typed LINE message builders for Guided Menu Slice 2.
 * Postback `data` is always an opaque gpm1 token — never business labels.
 */

import {
  resolveMarketButtonLabel,
  type GuidedMenuMarketOption,
} from "./markets";
import type {
  GuidedMenuSeller,
  MenuTransactionTypeCode,
} from "./menu-state-types";
import {
  FLEX_BUBBLE_MAX_UTF8_BYTES,
  FLEX_BUTTON_LABEL_MAX,
  GUIDED_MENU_COPY,
  TEMPLATE_ACTION_LABEL_MAX,
  LINE_REPLY_MESSAGE_MAX,
  SELLERS_PER_MESSAGE,
  TX_CODE_TO_LABEL,
  type GuidedMenuLineMessage,
  type LineFlexBubble,
  type LineFlexMessage,
  type LineMessageAction,
  type LinePostbackAction,
  type LineQuickReply,
  type LineTemplateButtonsMessage,
  type LineTextMessage,
  type TokenButtonSpec,
} from "./ux-types";

export function measureFlexBubbleUtf8Bytes(bubble: LineFlexBubble): number {
  return Buffer.byteLength(JSON.stringify(bubble), "utf8");
}

function assertLabelLength(label: string, maxChars: number, kind: string): void {
  const len = [...label].length;
  if (len > maxChars) {
    throw new Error(
      `${kind} label exceeds ${maxChars} characters (${len}): ${label}`,
    );
  }
}

export function postbackAction(
  label: string,
  wireToken: string,
  options: {
    maxLabelChars: number;
    displayText?: string;
  },
): LinePostbackAction {
  if (!wireToken.startsWith("gpm1:")) {
    throw new Error("guided menu postback data must be a gpm1 token");
  }
  if (wireToken.length > 300) {
    throw new Error(`postback data exceeds LINE 300-char limit (${wireToken.length})`);
  }
  assertLabelLength(label, options.maxLabelChars, "postback action");
  return {
    type: "postback",
    label,
    data: wireToken,
    displayText: options.displayText ?? label,
  };
}

function quickReplyFromTokens(
  buttons: Array<{ label: string; wireToken: string; displayText?: string }>,
): LineQuickReply {
  return {
    items: buttons.slice(0, 13).map((b) => ({
      type: "action" as const,
      action: postbackAction(b.label, b.wireToken, {
        maxLabelChars: TEMPLATE_ACTION_LABEL_MAX,
        displayText: b.displayText,
      }),
    })),
  };
}

/**
 * A Quick Reply item that resubmits fixed text — only ever used to relabel an
 * ALREADY-recognized exact-text command (e.g. legacy "ปิดรอบ" / "เมนู" /
 * "ออกจากเมนู"). No token, no new action type, no new parser: the plain-text
 * router this resubmits into must already accept `text` verbatim.
 */
export function messageAction(label: string, text: string): LineMessageAction {
  assertLabelLength(label, TEMPLATE_ACTION_LABEL_MAX, "message action");
  return { type: "message", label, text };
}

export type QuickReplyButtonSpec =
  | { kind: "token"; label: string; wireToken: string; displayText?: string }
  | { kind: "message"; label: string; text: string };

/** Quick Reply mixing token-bound postback buttons and fixed-text buttons. */
export function bindMixedQuickReply(
  buttons: QuickReplyButtonSpec[],
): LineQuickReply {
  return {
    items: buttons.slice(0, 13).map((b) =>
      b.kind === "token"
        ? {
            type: "action" as const,
            action: postbackAction(b.label, b.wireToken, {
              maxLabelChars: TEMPLATE_ACTION_LABEL_MAX,
              displayText: b.displayText,
            }),
          }
        : {
            type: "action" as const,
            action: messageAction(b.label, b.text),
          },
    ),
  };
}

function bubbleButton(
  label: string,
  wireToken: string,
  style: "primary" | "secondary" = "primary",
) {
  return {
    type: "button",
    style,
    height: "sm",
    action: postbackAction(label, wireToken, {
      maxLabelChars: FLEX_BUTTON_LABEL_MAX,
    }),
  };
}

function assertUniqueRenderedLabels(labels: string[], context: string): void {
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) {
      throw new Error(`duplicate rendered ${context} label: ${label}`);
    }
    seen.add(label);
  }
}

function flexShell(
  altText: string,
  title: string,
  bodyLines: string[],
  footerButtons: Record<string, unknown>[],
): LineFlexMessage {
  const contents: LineFlexBubble = {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      paddingAll: "16px",
      contents: [
        {
          type: "text",
          text: title,
          weight: "bold",
          size: "lg",
          color: "#0F172A",
          wrap: true,
        },
        ...bodyLines.map((line) => ({
          type: "text" as const,
          text: line,
          size: "sm",
          color: "#334155",
          wrap: true,
        })),
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "12px",
      contents: footerButtons,
    },
  };

  const bytes = measureFlexBubbleUtf8Bytes(contents);
  if (bytes > FLEX_BUBBLE_MAX_UTF8_BYTES) {
    throw new Error(
      `flex bubble exceeds ${FLEX_BUBBLE_MAX_UTF8_BYTES} UTF-8 bytes (${bytes})`,
    );
  }

  return {
    type: "flex",
    altText,
    contents,
  };
}

/** Root transaction-type screen — buttons template (3 choices). */
export function buildTransactionTypeMessage(tokens: {
  withdraw: string;
  return: string;
  damagedReturn: string;
}): LineTemplateButtonsMessage {
  const actions = [
    postbackAction("เบิก", tokens.withdraw, {
      maxLabelChars: TEMPLATE_ACTION_LABEL_MAX,
    }),
    postbackAction("ชั่งคืน", tokens.return, {
      maxLabelChars: TEMPLATE_ACTION_LABEL_MAX,
    }),
    postbackAction("คืนเสีย", tokens.damagedReturn, {
      maxLabelChars: TEMPLATE_ACTION_LABEL_MAX,
    }),
  ];
  const text = GUIDED_MENU_COPY.txPrompt;
  if ([...text].length > 160) {
    throw new Error("buttons template text exceeds LINE limit");
  }
  return {
    type: "template",
    altText: text,
    template: {
      type: "buttons",
      text,
      actions,
    },
  };
}

/** Seller selection, split across LINE reply messages without truncation. */
export function buildSellerSelectMessages(input: {
  transactionType: MenuTransactionTypeCode;
  sellers: readonly GuidedMenuSeller[];
  sellerTokens: ReadonlyMap<string, string>;
  backToken: string;
  cancelToken: string;
}): LineFlexMessage[] {
  const labels = input.sellers.map((seller) => {
    assertLabelLength(seller.label, FLEX_BUTTON_LABEL_MAX, "flex seller button");
    return seller.label;
  });
  assertUniqueRenderedLabels([...labels, "กลับ", "ยกเลิก"], "seller screen");

  const pageCount = Math.ceil(input.sellers.length / SELLERS_PER_MESSAGE);
  if (pageCount > LINE_REPLY_MESSAGE_MAX) {
    throw new Error("seller catalog exceeds LINE reply capacity");
  }

  const txLabel = TX_CODE_TO_LABEL[input.transactionType];
  return Array.from({ length: pageCount }, (_, page) => {
    const sellers = input.sellers.slice(
      page * SELLERS_PER_MESSAGE,
      (page + 1) * SELLERS_PER_MESSAGE,
    );
    const buttons = sellers.map((seller) => {
      const token = input.sellerTokens.get(seller.sellerCode);
      if (!token) throw new Error(`missing seller token for ${seller.sellerCode}`);
      return bubbleButton(seller.label, token);
    });
    buttons.push(bubbleButton("กลับ", input.backToken, "secondary"));
    buttons.push(bubbleButton("ยกเลิก", input.cancelToken, "secondary"));

    const title =
      pageCount === 1
        ? GUIDED_MENU_COPY.sellerPrompt
        : `${GUIDED_MENU_COPY.sellerPrompt} (${page + 1}/${pageCount})`;
    return flexShell(
      GUIDED_MENU_COPY.sellerPrompt,
      title,
      [`ประเภท: ${txLabel}`],
      buttons,
    );
  });
}

/** Market selection — Flex; labels from server config only. */
export function buildMarketSelectMessage(input: {
  transactionType: MenuTransactionTypeCode;
  sellerLabel: string;
  markets: readonly GuidedMenuMarketOption[];
  marketTokens: ReadonlyMap<string, string>;
  backToken: string;
  cancelToken: string;
}): LineFlexMessage {
  const txLabel = TX_CODE_TO_LABEL[input.transactionType];
  const renderedMarketLabels = input.markets.map((market) => {
    const buttonLabel = resolveMarketButtonLabel(market);
    assertLabelLength(buttonLabel, FLEX_BUTTON_LABEL_MAX, "flex market button");
    return buttonLabel;
  });
  assertUniqueRenderedLabels(renderedMarketLabels, "market button");

  const navLabels = ["กลับ", "ยกเลิก"];
  assertUniqueRenderedLabels(
    [...renderedMarketLabels, ...navLabels],
    "market screen",
  );

  const buttons = input.markets.map((market) => {
    const token = input.marketTokens.get(market.code);
    if (!token) throw new Error(`missing market token for ${market.code}`);
    return bubbleButton(resolveMarketButtonLabel(market), token);
  });
  buttons.push(bubbleButton("กลับ", input.backToken, "secondary"));
  buttons.push(bubbleButton("ยกเลิก", input.cancelToken, "secondary"));

  return flexShell(
    GUIDED_MENU_COPY.marketPrompt,
    GUIDED_MENU_COPY.marketPrompt,
    [`ประเภท: ${txLabel}`, `คนขาย: ${input.sellerLabel}`],
    buttons,
  );
}

export function buildDateSelectMessage(input: {
  transactionType: MenuTransactionTypeCode;
  sellerLabel: string;
  marketLabel: string;
  todayToken: string;
  yesterdayToken: string;
  backToken: string;
  cancelToken: string;
}): LineFlexMessage {
  const txLabel = TX_CODE_TO_LABEL[input.transactionType];
  return flexShell(
    GUIDED_MENU_COPY.datePrompt,
    GUIDED_MENU_COPY.datePrompt,
    [
      `ประเภท: ${txLabel}`,
      `คนขาย: ${input.sellerLabel}`,
      `ตลาด: ${input.marketLabel}`,
    ],
    [
      bubbleButton("วันนี้", input.todayToken),
      bubbleButton("เมื่อวาน", input.yesterdayToken),
      bubbleButton("กลับ", input.backToken, "secondary"),
      bubbleButton("ยกเลิก", input.cancelToken, "secondary"),
    ],
  );
}

export function buildConfirmPreviewMessage(input: {
  transactionType: MenuTransactionTypeCode;
  sellerLabel: string;
  marketLabel: string;
  dateThaiShort: string;
  confirmToken: string;
  backToken: string;
  cancelToken: string;
}): LineFlexMessage {
  const txLabel = TX_CODE_TO_LABEL[input.transactionType];
  const body = [
    `ประเภท: ${txLabel}`,
    `คนขาย: ${input.sellerLabel}`,
    `ตลาด: ${input.marketLabel}`,
    `วันที่: ${input.dateThaiShort}`,
  ];
  return flexShell(
    GUIDED_MENU_COPY.confirmHeading,
    GUIDED_MENU_COPY.confirmHeading,
    body,
    [
      bubbleButton("ยืนยัน", input.confirmToken),
      bubbleButton("กลับ", input.backToken, "secondary"),
      bubbleButton("ยกเลิก", input.cancelToken, "secondary"),
    ],
  );
}

export function buildPlainTextMessage(text: string): LineTextMessage {
  return { type: "text", text };
}

export function buildUnmappedMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.unmapped);
}

export function buildInvalidMenuMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.invalidOrExpired);
}

export function buildCancelledMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.cancelled);
}

export function buildConfirmPlaceholderMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.confirmPlaceholder);
}

/** Collect postback button labels from a flex or quick-reply message. */
export function guidedControlLabels(message: unknown): string[] {
  const flex = message as LineFlexMessage;
  if (flex?.type === "flex") {
    const labels: string[] = [];
    walkPostbackActions(flex, (action) => labels.push(action.label));
    return labels;
  }
  const qr = (message as { quickReply?: LineQuickReply }).quickReply;
  return qr ? qr.items.map((item) => item.action.label) : [];
}

/** Primary Flex stage-control card for post-open guided operations. */
export function buildStageControlFlexMessage(input: {
  title: string;
  bodyLines?: readonly string[];
  buttons: ReadonlyArray<{ label: string; wireToken: string }>;
  altText?: string;
}): LineFlexMessage {
  const labels = input.buttons.map((b) => b.label);
  assertUniqueRenderedLabels(labels, "stage control");
  const footerButtons = input.buttons.map((b, index) =>
    bubbleButton(
      b.label,
      b.wireToken,
      index === 0 ? "primary" : "secondary",
    ),
  );
  return flexShell(
    input.altText ?? input.title,
    input.title,
    [...(input.bodyLines ?? [])],
    footerButtons,
  );
}

export function buildCaptureAckMessage(itemCount: number): LineTextMessage {
  return buildPlainTextMessage(
    [
      "บันทึกรายการแล้ว ✅",
      `รายการทั้งหมด ${itemCount} รายการ`,
    ].join("\n"),
  );
}

/**
 * Text segments plus a trailing Flex control card. Reserves one reply slot for
 * the card so long summaries still fit within LINE's five-message cap.
 */
export function buildTextMessagesWithStageControl(input: {
  summary: string;
  maxMessages: number;
  control: LineFlexMessage;
  quickReply?: LineQuickReply;
}): GuidedMenuLineMessage[] {
  const textBudget = Math.max(1, input.maxMessages - 1);
  const parts = splitTextForLineReply(input.summary, textBudget);
  const textMessages = parts.map((text, index) => ({
    type: "text" as const,
    text,
    ...(input.quickReply && index === parts.length - 1
      ? { quickReply: input.quickReply }
      : {}),
  }));
  return [...textMessages, input.control];
}

/**
 * Slice 3A success receipt. Text rather than Flex so Slice 3B can attach the
 * guided capture actions as a quickReply without re-laying out the bubble.
 */
export function buildSessionOpenedMessage(input: {
  transactionType: MenuTransactionTypeCode;
  sellerLabel: string;
  marketLabel: string;
  dateThaiShort: string;
  /** Trailing instruction lines; 3A ships the send-items hint, 3B the close button hint. */
  instructions: readonly string[];
}): LineTextMessage {
  const txLabel = TX_CODE_TO_LABEL[input.transactionType];
  return buildPlainTextMessage(
    [
      `เปิดรายการ${txLabel}แล้ว ✅`,
      `คนขาย: ${input.sellerLabel}`,
      `ตลาด: ${input.marketLabel}`,
      `วันที่: ${input.dateThaiShort}`,
      "",
      ...input.instructions,
    ].join("\n"),
  );
}

/** Safety margin under LINE's 5000-code-point text limit. */
const TEXT_SPLIT_BUDGET = 4500;

/**
 * Split a long summary on line boundaries, deterministically and in order.
 *
 * A single line longer than the budget is emitted whole rather than cut
 * mid-word; assertGuidedMenuMessageLimits still refuses anything that then
 * exceeds the hard limit, so an unsplittable monster fails closed instead of
 * being silently truncated.
 */
export function splitTextForLineReply(
  text: string,
  maxMessages: number,
  budget: number = TEXT_SPLIT_BUDGET,
): string[] {
  if ([...text].length <= budget) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (current && [...candidate].length > budget) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  if (chunks.length <= maxMessages) return chunks;
  // Keep the head and mark the truncation explicitly — never silently drop.
  const head = chunks.slice(0, maxMessages - 1);
  return [...head, "รายการยาวเกินกว่าจะแสดงครบในข้อความเดียว กรุณาดูในระบบหลังบ้าน"];
}

/** Slice 3B — captured-item review, split across at most `maxMessages`. */
export function buildCapturedItemsMessages(input: {
  summary: string;
  quickReply?: LineQuickReply;
  stageControl?: LineFlexMessage;
  maxMessages: number;
}): GuidedMenuLineMessage[] {
  if (input.stageControl) {
    return buildTextMessagesWithStageControl({
      summary: input.summary,
      maxMessages: input.maxMessages,
      control: input.stageControl,
      quickReply: input.quickReply,
    });
  }
  const parts = splitTextForLineReply(input.summary, input.maxMessages);
  return parts.map((text, index) => ({
    type: "text" as const,
    text,
    // Optional quick-reply fallback on the last text segment.
    ...(input.quickReply && index === parts.length - 1
      ? { quickReply: input.quickReply }
      : {}),
  }));
}

export function buildNoOpenSessionMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.noOpenSession);
}

export function buildMenuDismissedSessionOpenMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.menuDismissedSessionOpen);
}

export function buildFinalizeNotReadyMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.finalizeNotReady);
}

export function buildSessionActionConflictMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.sessionActionConflict);
}

/** Slice 3B — finalization confirmed; the deferred finalizer persists it. */
export function buildFinalizeConfirmedMessage(input: {
  summary: string;
  maxMessages: number;
  quickReply?: LineQuickReply;
  stageControl?: LineFlexMessage;
}): GuidedMenuLineMessage[] {
  return buildCapturedItemsMessages({
    summary: [
      "บันทึกรายการสินค้าเรียบร้อย ✅",
      "",
      input.summary,
      "",
      GUIDED_MENU_COPY.nextStepWhiteSheet,
    ].join("\n"),
    quickReply: input.quickReply,
    stageControl: input.stageControl,
    maxMessages: input.maxMessages,
  });
}

/**
 * Slice 3C — the White Sheet template, sent as its own message so the operator
 * can long-press-copy it without dragging the instructions along.
 */
export function buildWhiteSheetTemplateMessages(input: {
  template: string;
  sellerLabel: string;
  marketLabel: string;
  dateThaiShort: string;
  quickReply?: LineQuickReply;
  stageControl?: LineFlexMessage;
  note?: string;
}): GuidedMenuLineMessage[] {
  const header = [
    GUIDED_MENU_COPY.whiteSheetInstructions,
    "",
    `คนขาย: ${input.sellerLabel}`,
    `ตลาด: ${input.marketLabel}`,
    `วันที่: ${input.dateThaiShort}`,
    ...(input.note ? ["", input.note] : []),
  ].join("\n");
  const templateMessage: LineTextMessage = {
    type: "text",
    text: input.template,
    ...(input.quickReply ? { quickReply: input.quickReply } : {}),
  };
  if (input.stageControl) {
    return [
      { type: "text", text: header },
      templateMessage,
      input.stageControl,
    ];
  }
  return [{ type: "text", text: header }, templateMessage];
}

/** Slice 3D — slip-stage instructions plus the ready-to-send batch header. */
export function buildSlipInstructionMessages(input: {
  header: string;
  sellerLabel: string;
  marketLabel: string;
  dateThaiShort: string;
  quickReply?: LineQuickReply;
  stageControl?: LineFlexMessage;
}): GuidedMenuLineMessage[] {
  const intro = {
    type: "text" as const,
    text: [
      GUIDED_MENU_COPY.slipInstructions,
      "",
      `คนขาย: ${input.sellerLabel}`,
      `ตลาด: ${input.marketLabel}`,
      `วันที่: ${input.dateThaiShort}`,
    ].join("\n"),
  };
  const headerMessage: LineTextMessage = {
    type: "text",
    text: input.header,
    ...(input.quickReply ? { quickReply: input.quickReply } : {}),
  };
  if (input.stageControl) {
    return [intro, headerMessage, input.stageControl];
  }
  return [intro, headerMessage];
}

/**
 * Slice 3D.1 — the settlement template, sent as its own message so the operator
 * can long-press-copy it, exactly like the White Sheet template.
 */
export function buildSettlementTemplateMessages(input: {
  template: string;
  sellerLabel: string;
  marketLabel: string;
  dateThaiShort: string;
  quickReply?: LineQuickReply;
  stageControl?: LineFlexMessage;
}): GuidedMenuLineMessage[] {
  const intro = {
    type: "text" as const,
    text: [
      GUIDED_MENU_COPY.settlementInstructions,
      "",
      `คนขาย: ${input.sellerLabel}`,
      `ตลาด: ${input.marketLabel}`,
      `วันที่: ${input.dateThaiShort}`,
    ].join("\n"),
  };
  const templateMessage: LineTextMessage = {
    type: "text",
    text: input.template,
    ...(input.quickReply ? { quickReply: input.quickReply } : {}),
  };
  if (input.stageControl) {
    return [intro, templateMessage, input.stageControl];
  }
  return [intro, templateMessage];
}

/** Slice 3D.1 — the receipt for a settlement that actually persisted. */
export function buildSettlementSavedMessage(input: {
  moneyTransfer: number;
  moneyCash: number;
  expenses: number;
  labor: number;
}): LineTextMessage {
  return {
    type: "text",
    text: [
      "บันทึกยอดส่งเรียบร้อย ✅",
      "",
      `ยอดโอน: ${formatBaht(input.moneyTransfer)}`,
      `เงินสด: ${formatBaht(input.moneyCash)}`,
      `ค่าใช้จ่าย: ${formatBaht(input.expenses)}`,
      `ค่าแรง: ${formatBaht(input.labor)}`,
      "",
      GUIDED_MENU_COPY.nextStepReconcile,
    ].join("\n"),
  };
}

function formatBaht(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} บาท`;
}

/**
 * Slice 3D — the reconciliation view. Renders exactly what the authoritative
 * loaders reported; a missing settlement shows "—", never a guessed zero.
 */
export function buildRoundStatusMessage(input: {
  sellerLabel: string;
  marketLabel: string;
  dateThaiShort: string;
  totals: {
    checkedSlipTotal: number;
    submittedTransferTotal: number | null;
    difference: number | null;
  };
  slipCounts: ReadonlyArray<[string, number]>;
  blockerLines: readonly string[];
  closed: boolean;
  quickReply?: LineQuickReply;
}): LineTextMessage {
  const lines: string[] = [];
  lines.push(input.closed ? "ปิดรอบเรียบร้อย ✅" : "ตรวจยอดรอบขาย");
  lines.push("");
  lines.push(`คนขาย: ${input.sellerLabel}`);
  lines.push(`ตลาด: ${input.marketLabel}`);
  lines.push(`วันที่: ${input.dateThaiShort}`);
  lines.push(`ยอดส่งตามใบขาว: ${formatBaht(input.totals.submittedTransferTotal)}`);
  lines.push(`ยอดสลิปที่ตรวจแล้ว: ${formatBaht(input.totals.checkedSlipTotal)}`);
  lines.push(`ผลต่าง: ${formatBaht(input.totals.difference)}`);

  if (input.slipCounts.length > 0) {
    lines.push("");
    lines.push("สลิป:");
    for (const [label, count] of input.slipCounts) {
      lines.push(`- ${label}: ${count}`);
    }
  }

  if (input.blockerLines.length > 0) {
    lines.push("");
    lines.push("ยังปิดรอบไม่ได้ เพราะ:");
    for (const line of input.blockerLines) lines.push(`- ${line}`);
  }

  const message: LineTextMessage = { type: "text", text: lines.join("\n") };
  return input.quickReply ? { ...message, quickReply: input.quickReply } : message;
}

export function buildSessionAlreadyOpenMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.sessionAlreadyOpen);
}

export function buildSessionOpenConflictMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.sessionOpenConflict);
}


export function buildNoActiveSellersMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.noActiveSellers);
}

export function buildSellerUnavailableMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.sellerUnavailable);
}

export function buildNoActiveSellerMarketsMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.noActiveSellerMarkets);
}
export function buildMarketUnavailableMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.marketUnavailable);
}

/** Assert outbound messages stay within LINE payload budgets. */
export function assertGuidedMenuMessageLimits(
  messages: GuidedMenuLineMessage[],
): void {
  if (messages.length < 1 || messages.length > 5) {
    throw new Error(`LINE reply allows 1–5 messages, got ${messages.length}`);
  }
  for (const msg of messages) {
    if (msg.type === "text") {
      if ([...msg.text].length > 5000) {
        throw new Error("text message exceeds 5000 code points");
      }
      if (msg.quickReply) {
        for (const item of msg.quickReply.items) {
          if (item.action.type === "postback" && item.action.data.length > 300) {
            throw new Error("quickReply postback data exceeds 300 chars");
          }
          assertLabelLength(
            item.action.label,
            TEMPLATE_ACTION_LABEL_MAX,
            "quickReply",
          );
        }
      }
    }
    if (msg.type === "template") {
      if ([...msg.template.text].length > 160) {
        throw new Error("buttons template text exceeds 160 code points");
      }
      if (msg.template.actions.length > 4) {
        throw new Error("buttons template allows at most 4 actions");
      }
      for (const action of msg.template.actions) {
        if (action.data.length > 300) {
          throw new Error("template postback data exceeds 300 chars");
        }
        assertLabelLength(
          action.label,
          TEMPLATE_ACTION_LABEL_MAX,
          "template action",
        );
      }
    }
    if (msg.type === "flex") {
      if ([...msg.altText].length > 400) {
        throw new Error("flex altText exceeds 400 code points");
      }
      const bytes = measureFlexBubbleUtf8Bytes(msg.contents);
      if (bytes > FLEX_BUBBLE_MAX_UTF8_BYTES) {
        throw new Error(
          `flex bubble exceeds ${FLEX_BUBBLE_MAX_UTF8_BYTES} UTF-8 bytes (${bytes})`,
        );
      }
      walkPostbackActions(msg, (action) => {
        if (!action.data.startsWith("gpm1:")) {
          throw new Error("flex postback data must be gpm1 token");
        }
        if (action.data.length > 300) {
          throw new Error("flex postback data exceeds 300 chars");
        }
        assertLabelLength(action.label, FLEX_BUTTON_LABEL_MAX, "flex button");
      });
    }
  }
}

function walkPostbackActions(
  value: unknown,
  visit: (action: LinePostbackAction) => void,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkPostbackActions(item, visit);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (
    obj.type === "postback" &&
    typeof obj.data === "string" &&
    typeof obj.label === "string"
  ) {
    visit(obj as LinePostbackAction);
  }
  for (const child of Object.values(obj)) {
    walkPostbackActions(child, visit);
  }
}

/**
 * Recovery Quick Reply for a stale/expired form (ownership-guard's
 * `reason: "stale_form"`). Every item resubmits an ALREADY-recognized exact
 * text — "เมนู" re-resolves the journey and hands back whatever template is
 * current for the live stage, which is exactly "generate a fresh form"
 * without a new action type or any token. No internal token/generation
 * details are ever surfaced to the operator.
 */
export function buildStaleFormRecoveryQuickReply(): LineQuickReply {
  return {
    items: [
      {
        type: "action",
        action: messageAction(GUIDED_MENU_COPY.generateNewFormLabel, "เมนู"),
      },
      { type: "action", action: messageAction("ดูสถานะ", "เมนู") },
      { type: "action", action: messageAction("ออกจากเมนู", "ออกจากเมนู") },
    ],
  };
}

export type BoundTokenButton = TokenButtonSpec & { wireToken: string };

export function bindQuickReply(
  buttons: BoundTokenButton[],
): LineQuickReply {
  return quickReplyFromTokens(
    buttons.map((b) => ({
      label: b.label,
      wireToken: b.wireToken,
      displayText: b.displayText,
    })),
  );
}
