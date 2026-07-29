import { describe, expect, it } from "bun:test";
import {
  assertGuidedMenuMessageLimits,
  buildMarketSelectMessage,
  buildSellerSelectMessages,
  measureFlexBubbleUtf8Bytes,
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
        { code: "kee", label: "ตลาดกี้" },
        { code: "seven_front", label: "หน้าเซเวน" },
      ],
      marketTokens: new Map([
        ["kee", fixedEvidenceToken(12)],
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
