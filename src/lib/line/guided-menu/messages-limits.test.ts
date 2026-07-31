import { describe, expect, it } from "bun:test";
import {
  assertGuidedMenuMessageLimits,
  bindMixedQuickReply,
  buildMarketSelectMessage,
  buildPlainTextMessage,
  buildSellerSelectMessages,
  guidedControlLabels,
  measureFlexBubbleUtf8Bytes,
  messageAction,
  postbackAction,
} from "./messages";
import {
  FLEX_BUBBLE_MAX_UTF8_BYTES,
  FLEX_BUTTON_LABEL_MAX,
  LINE_REPLY_MESSAGE_MAX,
  SELLERS_PER_MESSAGE,
  TEMPLATE_ACTION_LABEL_MAX,
} from "./ux-types";
import { fixedEvidenceToken } from "./evidence";

describe("0051 Slice 2 — LINE label and Flex byte limits", () => {
  it("enforces template action label max 20 without silent clipping", () => {
    const long = "ก".repeat(TEMPLATE_ACTION_LABEL_MAX + 1);
    expect(() =>
      postbackAction(long, fixedEvidenceToken(1), {
        maxLabelChars: TEMPLATE_ACTION_LABEL_MAX,
      }),
    ).toThrow(/exceeds 20/);
  });

  it("enforces Flex button label max 40 without silent clipping", () => {
    const long = "ข".repeat(FLEX_BUTTON_LABEL_MAX + 1);
    expect(() =>
      buildMarketSelectMessage({
        transactionType: "withdraw",
        sellerLabel: "Seller A",
        markets: [{ code: "long", label: long }],
        marketTokens: new Map([["long", fixedEvidenceToken(2)]]),
        backToken: fixedEvidenceToken(3),
        cancelToken: fixedEvidenceToken(4),
      }),
    ).toThrow(/exceeds 40/);
  });

  it("accepts explicit buttonLabel abbreviation for long market names", () => {
    const long = "ตลาดชื่อยาวมากจนเกินสี่สิบตัวอักษรสำหรับปุ่มไลน์";
    expect([...long].length).toBeGreaterThan(FLEX_BUTTON_LABEL_MAX);
    const msg = buildMarketSelectMessage({
      transactionType: "withdraw",
      sellerLabel: "Seller A",
      markets: [{ code: "long", label: long, buttonLabel: "ตลาดยาว" }],
      marketTokens: new Map([["long", fixedEvidenceToken(5)]]),
      backToken: fixedEvidenceToken(6),
      cancelToken: fixedEvidenceToken(7),
    });
    const json = JSON.stringify(msg);
    expect(json).toContain("ตลาดยาว");
    expect(json).not.toContain(long);
    assertGuidedMenuMessageLimits([msg]);
  });

  it("rejects ambiguous duplicate rendered market button labels", () => {
    expect(() =>
      buildMarketSelectMessage({
        transactionType: "withdraw",
        sellerLabel: "Seller A",
        markets: [
          { code: "a", label: "ตลาดเดียวกัน" },
          { code: "b", label: "ตลาดอื่น", buttonLabel: "ตลาดเดียวกัน" },
        ],
        marketTokens: new Map([
          ["a", fixedEvidenceToken(8)],
          ["b", fixedEvidenceToken(9)],
        ]),
        backToken: fixedEvidenceToken(10),
        cancelToken: fixedEvidenceToken(11),
      }),
    ).toThrow(/duplicate rendered/);
  });

  it("fails closed when Flex bubble exceeds 30 KiB UTF-8", () => {
    // Build an oversized bubble payload directly through the byte measurer contract.
    const fatLine = "ย".repeat(8_000); // Thai code point = 3 UTF-8 bytes
    const fatBubble = {
      type: "bubble" as const,
      body: {
        type: "box",
        layout: "vertical",
        contents: Array.from({ length: 20 }, () => ({
          type: "text",
          text: fatLine,
          wrap: true,
        })),
      },
    };
    const bytes = measureFlexBubbleUtf8Bytes(fatBubble);
    expect(bytes).toBeGreaterThan(FLEX_BUBBLE_MAX_UTF8_BYTES);

    expect(() =>
      assertGuidedMenuMessageLimits([
        {
          type: "flex",
          altText: "เกินขนาด",
          contents: fatBubble,
        },
      ]),
    ).toThrow(/UTF-8 bytes/);
  });

  it("accepts Thai Flex under the UTF-8 byte budget", () => {
    const msg = buildMarketSelectMessage({
      transactionType: "withdraw",
      sellerLabel: "Seller A",
      markets: [
        { code: "wat_thung_lanna", label: "วัดทุ่งลานนา" },
        { code: "seven_front", label: "หน้าเซเวน" },
      ],
      marketTokens: new Map([
        ["wat_thung_lanna", fixedEvidenceToken(12)],
        ["seven_front", fixedEvidenceToken(13)],
      ]),
      backToken: fixedEvidenceToken(14),
      cancelToken: fixedEvidenceToken(15),
    });
    expect(measureFlexBubbleUtf8Bytes(msg.contents)).toBeLessThanOrEqual(
      FLEX_BUBBLE_MAX_UTF8_BYTES,
    );
    assertGuidedMenuMessageLimits([msg]);
  });

  it("splits up to 40 sellers across LINE's five-message reply limit", () => {
    const sellers = Array.from(
      { length: SELLERS_PER_MESSAGE * LINE_REPLY_MESSAGE_MAX },
      (_, index) => ({
        sellerCode: `seller_${index}`,
        label: `Seller ${index}`,
        active: true,
        sortOrder: index,
      }),
    );
    const sellerTokens = new Map(
      sellers.map((seller, index) => [
        seller.sellerCode,
        fixedEvidenceToken(index + 1),
      ]),
    );
    const input = {
      transactionType: "withdraw" as const,
      sellers,
      sellerTokens,
      backToken: fixedEvidenceToken(41),
      cancelToken: fixedEvidenceToken(42),
    };

    const messages = buildSellerSelectMessages(input);
    expect(messages).toHaveLength(LINE_REPLY_MESSAGE_MAX);
    assertGuidedMenuMessageLimits(messages);
    expect(() =>
      buildSellerSelectMessages({
        ...input,
        sellers: [
          ...sellers,
          {
            sellerCode: "seller_overflow",
            label: "Seller overflow",
            active: true,
            sortOrder: sellers.length,
          },
        ],
      }),
    ).toThrow(/reply capacity/);
  });
});

describe("LineMessageAction — label vs resubmitted text", () => {
  it("has a distinct user-facing label and a separately-resubmitted text", () => {
    const action = messageAction("สร้างแบบฟอร์มใหม่", "เมนู");
    expect(action).toEqual({ type: "message", label: "สร้างแบบฟอร์มใหม่", text: "เมนู" });
    // The button LABEL and the TEXT it resubmits are independent fields —
    // this is exactly what lets a friendly label relabel a plain-text command.
    expect(action.label).not.toBe(action.text);
  });

  it("accepts message text up to the 300-code-point LINE limit", () => {
    const text = "ก".repeat(300);
    expect(() => messageAction("label", text)).not.toThrow();
  });

  it("rejects message text over the 300-code-point LINE limit", () => {
    const text = "ก".repeat(301);
    expect(() => messageAction("label", text)).toThrow(/300/);
  });

  it("still enforces the 20-char label limit for a message action", () => {
    const long = "ก".repeat(TEMPLATE_ACTION_LABEL_MAX + 1);
    expect(() => messageAction(long, "เมนู")).toThrow(/exceeds 20/);
  });

  it("mixes token (postback) and message actions in one Quick Reply", () => {
    const qr = bindMixedQuickReply([
      { kind: "token", label: "ดูสถานะ", wireToken: fixedEvidenceToken(50) },
      { kind: "message", label: "ออกจากเมนู", text: "ออกจากเมนู" },
    ]);
    expect(qr.items[0]!.action.type).toBe("postback");
    expect(qr.items[1]!.action.type).toBe("message");
    // assertGuidedMenuMessageLimits only checks `.data` on postback actions —
    // a message action never carries `data`, so this must not throw.
    expect(() =>
      assertGuidedMenuMessageLimits([
        { ...buildPlainTextMessage("status"), quickReply: qr },
      ]),
    ).not.toThrow();
  });

  it("label extraction (guidedControlLabels) includes message-action labels", () => {
    const qr = bindMixedQuickReply([
      { kind: "message", label: "สร้างแบบฟอร์มใหม่", text: "แบบฟอร์มยาว..." },
      { kind: "message", label: "ออกจากเมนู", text: "ออกจากเมนู" },
    ]);
    const message = { ...buildPlainTextMessage("status"), quickReply: qr };
    expect(guidedControlLabels(message)).toEqual(["สร้างแบบฟอร์มใหม่", "ออกจากเมนู"]);
  });

  it("walkPostbackActions traversal (via assertGuidedMenuMessageLimits) skips message actions safely", () => {
    // A flex postback-data check must never trip over a message action mixed
    // into the SAME quickReply on a sibling text message — no `.data` field
    // to misread as missing/short.
    const qr = bindMixedQuickReply([
      { kind: "token", label: "กรอกใบขาว", wireToken: fixedEvidenceToken(51) },
      { kind: "message", label: "ดูสถานะ", text: "เมนู" },
    ]);
    const messages = [{ ...buildPlainTextMessage("status"), quickReply: qr }];
    expect(() => assertGuidedMenuMessageLimits(messages)).not.toThrow();
  });
});
