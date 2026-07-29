/**
 * Typed LINE message builders for Guided Menu Slice 2.
 * Postback `data` is always an opaque gpm1 token — never business labels.
 */

import type { GuidedMenuMarketOption } from "./markets";
import type { MenuTransactionTypeCode } from "./menu-state-types";
import {
  GUIDED_MENU_COPY,
  TX_CODE_TO_LABEL,
  type GuidedMenuLineMessage,
  type LineFlexMessage,
  type LinePostbackAction,
  type LineQuickReply,
  type LineTemplateButtonsMessage,
  type LineTextMessage,
  type TokenButtonSpec,
} from "./ux-types";

const POSTBACK_LABEL_MAX = 20;

function clipLabel(label: string): string {
  const chars = [...label];
  if (chars.length <= POSTBACK_LABEL_MAX) return label;
  return chars.slice(0, POSTBACK_LABEL_MAX).join("");
}

export function postbackAction(
  label: string,
  wireToken: string,
  displayText?: string,
): LinePostbackAction {
  if (!wireToken.startsWith("gpm1:")) {
    throw new Error("guided menu postback data must be a gpm1 token");
  }
  if (wireToken.length > 300) {
    throw new Error(`postback data exceeds LINE 300-char limit (${wireToken.length})`);
  }
  const clipped = clipLabel(label);
  return {
    type: "postback",
    label: clipped,
    data: wireToken,
    displayText: displayText ?? clipped,
  };
}

function quickReplyFromTokens(
  buttons: Array<{ label: string; wireToken: string; displayText?: string }>,
): LineQuickReply {
  return {
    items: buttons.slice(0, 13).map((b) => ({
      type: "action" as const,
      action: postbackAction(b.label, b.wireToken, b.displayText),
    })),
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
    action: postbackAction(label, wireToken),
  };
}

function flexShell(
  altText: string,
  title: string,
  bodyLines: string[],
  footerButtons: Record<string, unknown>[],
): LineFlexMessage {
  return {
    type: "flex",
    altText,
    contents: {
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
    },
  };
}

/** Root transaction-type screen — buttons template (3 choices). */
export function buildTransactionTypeMessage(tokens: {
  withdraw: string;
  return: string;
  damagedReturn: string;
}): LineTemplateButtonsMessage {
  const actions = [
    postbackAction("เบิก", tokens.withdraw),
    postbackAction("ชั่งคืน", tokens.return),
    postbackAction("คืนเสีย", tokens.damagedReturn),
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

/** Market selection — Flex; labels from server config only. */
export function buildMarketSelectMessage(input: {
  transactionType: MenuTransactionTypeCode;
  markets: readonly GuidedMenuMarketOption[];
  marketTokens: ReadonlyMap<string, string>;
  backToken: string;
  cancelToken: string;
}): LineFlexMessage {
  const txLabel = TX_CODE_TO_LABEL[input.transactionType];
  const buttons = input.markets.map((market) => {
    const token = input.marketTokens.get(market.code);
    if (!token) throw new Error(`missing market token for ${market.code}`);
    return bubbleButton(market.label, token);
  });
  buttons.push(bubbleButton("กลับ", input.backToken, "secondary"));
  buttons.push(bubbleButton("ยกเลิก", input.cancelToken, "secondary"));

  return flexShell(
    GUIDED_MENU_COPY.marketPrompt,
    GUIDED_MENU_COPY.marketPrompt,
    [`ประเภท: ${txLabel}`],
    buttons,
  );
}

export function buildDateSelectMessage(input: {
  transactionType: MenuTransactionTypeCode;
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
    [`ประเภท: ${txLabel}`, `ตลาด: ${input.marketLabel}`],
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
  marketLabel: string;
  dateThaiShort: string;
  confirmToken: string;
  backToken: string;
  cancelToken: string;
}): LineFlexMessage {
  const txLabel = TX_CODE_TO_LABEL[input.transactionType];
  const body = [
    `ประเภท: ${txLabel}`,
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
          if (item.action.data.length > 300) {
            throw new Error("quickReply postback data exceeds 300 chars");
          }
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
        if ([...action.label].length > POSTBACK_LABEL_MAX) {
          throw new Error("template action label exceeds 20 chars");
        }
      }
    }
    if (msg.type === "flex") {
      if ([...msg.altText].length > 400) {
        throw new Error("flex altText exceeds 400 code points");
      }
      const json = JSON.stringify(msg);
      if (json.length > 50_000) {
        throw new Error("flex message JSON exceeds practical LINE size");
      }
      walkPostbackData(msg, (data) => {
        if (!data.startsWith("gpm1:")) {
          throw new Error("flex postback data must be gpm1 token");
        }
        if (data.length > 300) {
          throw new Error("flex postback data exceeds 300 chars");
        }
      });
    }
  }
}

function walkPostbackData(
  value: unknown,
  visit: (data: string) => void,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkPostbackData(item, visit);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.type === "postback" && typeof obj.data === "string") {
    visit(obj.data);
  }
  for (const child of Object.values(obj)) {
    walkPostbackData(child, visit);
  }
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
