/**
 * Typed LINE message builders for Guided Menu Slice 2.
 * Postback `data` is always an opaque gpm1 token — never business labels.
 */

import {
  resolveMarketButtonLabel,
  type GuidedMenuMarketOption,
} from "./markets";
import type { MenuTransactionTypeCode } from "./menu-state-types";
import {
  FLEX_BUBBLE_MAX_UTF8_BYTES,
  FLEX_BUTTON_LABEL_MAX,
  GUIDED_MENU_COPY,
  TEMPLATE_ACTION_LABEL_MAX,
  TX_CODE_TO_LABEL,
  type GuidedMenuLineMessage,
  type LineFlexBubble,
  type LineFlexMessage,
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

/** Market selection — Flex; labels from server config only. */
export function buildMarketSelectMessage(input: {
  transactionType: MenuTransactionTypeCode;
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

export function buildNoActiveMarketsMessage(): LineTextMessage {
  return buildPlainTextMessage(GUIDED_MENU_COPY.noActiveMarkets);
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
          if (item.action.data.length > 300) {
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
