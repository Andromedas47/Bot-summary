/**
 * Second review, finding #5 — the signed provenance marker itself.
 *
 * The guard behaviour that hangs off it lives in review-ownership-binding.test.ts.
 * This file is about the marker as a mechanism: that it is a MAC and not an
 * encoding, that it binds every field it claims to bind, and — just as important
 * — that adding it changed nothing for the existing parsers or the LINE limits.
 */

process.env.LINE_CHANNEL_SECRET ??= "test-channel-secret";

import { describe, expect, it } from "bun:test";
import {
  extractGuidedMarker,
  GUIDED_MARKER_PREFIX,
  isGuidedMarker,
  signGuidedMarker,
  verifyGuidedMarker,
  withGuidedMarker,
  type GuidedMarkerFields,
} from "./provenance";
import { buildSlipHeaderTemplate, buildWhiteSheetTemplate } from "./journey";
import type { GuidedJourneyContext } from "./journey";
import { buildSettlementTemplate, parseGuidedSettlementCommand } from "./settlement-command";
import { parseWhiteSheetCloseCommandFromMessage } from "@/lib/line/white-sheet-close-command";
import { parseSlipSessionHeader } from "@/lib/slips/slip-session-service";

const SECRET = "test-channel-secret";
const OTHER_SECRET = "a-different-channel-secret";

const FIELDS: GuidedMarkerFields = {
  purpose: "white_sheet",
  sourceId: "G-1",
  lineUserId: "U-op-1",
  marketLabelNormalized: "วัดทุ่งลานนา",
  businessDate: "2026-07-29",
  sessionGeneration: "gen-1",
};

const CONTEXT: GuidedJourneyContext = {
  sessionKey: "group:G-1:user:U-op-1",
  sourceId: "G-1",
  lineUserId: "U-op-1",
  sellerLabel: "กี้",
  marketLabel: "วัดทุ่งลานนา",
  marketLabelNormalized: "วัดทุ่งลานนา",
  businessDate: "2026-07-29",
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

describe("the marker is a MAC, not an encoding", () => {
  it("is short, opaque and ASCII", () => {
    const marker = signGuidedMarker(FIELDS, SECRET)!;
    expect(marker.startsWith(GUIDED_MARKER_PREFIX)).toBe(true);
    expect(marker).toHaveLength(GUIDED_MARKER_PREFIX.length + 22);
    expect(/^[\x21-\x7e]+$/.test(marker)).toBe(true);
    expect(isGuidedMarker(marker)).toBe(true);
  });

  it("leaks none of the values it binds", () => {
    const marker = signGuidedMarker(FIELDS, SECRET)!;
    for (const value of [
      FIELDS.sourceId,
      FIELDS.lineUserId,
      FIELDS.marketLabelNormalized,
      FIELDS.businessDate,
      FIELDS.sessionGeneration,
      FIELDS.purpose,
    ]) {
      expect(marker).not.toContain(value);
    }
  });

  it("verifies against the identical field set", () => {
    const marker = signGuidedMarker(FIELDS, SECRET)!;
    expect(verifyGuidedMarker(marker, FIELDS, SECRET)).toBe(true);
  });

  it("changes when any single bound field changes", () => {
    const base = signGuidedMarker(FIELDS, SECRET)!;
    const variants: Array<Partial<GuidedMarkerFields>> = [
      { purpose: "slip_open" },
      { purpose: "settlement" },
      { sourceId: "G-2" },
      { lineUserId: "U-op-2" },
      { marketLabelNormalized: "หน้าเซเวน" },
      { businessDate: "2026-07-28" },
      { sessionGeneration: "gen-2" },
    ];
    for (const overrides of variants) {
      const fields = { ...FIELDS, ...overrides };
      expect(signGuidedMarker(fields, SECRET)).not.toBe(base);
      expect(verifyGuidedMarker(base, fields, SECRET)).toBe(false);
    }
  });

  it("canonicalizes the market label the same way the loaders do", () => {
    expect(
      signGuidedMarker({ ...FIELDS, marketLabelNormalized: "  วัดทุ่งลานนา  " }, SECRET),
    ).toBe(signGuidedMarker(FIELDS, SECRET));
  });

  it("cannot be forged without the secret", () => {
    const marker = signGuidedMarker(FIELDS, SECRET)!;
    expect(signGuidedMarker(FIELDS, OTHER_SECRET)).not.toBe(marker);
    expect(verifyGuidedMarker(marker, FIELDS, OTHER_SECRET)).toBe(false);
  });

  it("rejects tampered, truncated and malformed markers", () => {
    const marker = signGuidedMarker(FIELDS, SECRET)!;
    const body = marker.slice(GUIDED_MARKER_PREFIX.length);
    for (const bad of [
      `${marker.slice(0, -1)}${marker.endsWith("A") ? "B" : "A"}`,
      marker.slice(0, -1),
      `${GUIDED_MARKER_PREFIX}${body.slice(0, 10)}`,
      `${GUIDED_MARKER_PREFIX}${"A".repeat(22)}`,
      `#gp0.${body}`,
      body,
      "",
      "not-a-marker",
    ]) {
      expect(verifyGuidedMarker(bad, FIELDS, SECRET)).toBe(false);
    }
    expect(verifyGuidedMarker(null, FIELDS, SECRET)).toBe(false);
    expect(verifyGuidedMarker(undefined, FIELDS, SECRET)).toBe(false);
  });

  it("signs nothing when a bound field is missing", () => {
    for (const overrides of [
      { sourceId: "" },
      { lineUserId: "  " },
      { marketLabelNormalized: "" },
      { businessDate: "" },
      { sessionGeneration: "" },
    ]) {
      expect(signGuidedMarker({ ...FIELDS, ...overrides }, SECRET)).toBeNull();
    }
  });

  it("signs nothing, and verifies nothing, with no configured secret", () => {
    expect(signGuidedMarker(FIELDS, null)).toBeNull();
    // A message claiming a marker we cannot check is refused, not trusted.
    const marker = signGuidedMarker(FIELDS, SECRET)!;
    expect(verifyGuidedMarker(marker, FIELDS, null)).toBe(false);
    expect(withGuidedMarker("แบบฟอร์ม", FIELDS, null)).toBe("แบบฟอร์ม");
  });
});

describe("extracting the marker leaves the message the parsers expect", () => {
  it("removes only the marker line", () => {
    const marker = signGuidedMarker(FIELDS, SECRET)!;
    const result = extractGuidedMarker(`หนึ่ง\nสอง\n${marker}`);
    expect(result.text).toBe("หนึ่ง\nสอง");
    expect(result.marker).toBe(marker);
  });

  it("returns an ordinary message untouched", () => {
    for (const text of [
      "แตงโม 10 ลูก 500",
      "วัดทุ่งลานนา ปิดยอด 29/07/2569\nเงินสด 0\nจบปิดยอด",
      "#gp1.short",
      "#gp1",
      "ราคา #gp1.AAAAAAAAAAAAAAAAAAAAAA ต่อกิโล",
    ]) {
      expect(extractGuidedMarker(text)).toEqual({ text, marker: null });
    }
  });

  it("tolerates the marker anywhere and keeps only the first", () => {
    const first = signGuidedMarker(FIELDS, SECRET)!;
    const second = signGuidedMarker({ ...FIELDS, purpose: "slip_open" }, SECRET)!;
    const result = extractGuidedMarker(`${first}\nเนื้อหา\n${second}`);
    expect(result.text).toBe("เนื้อหา");
    expect(result.marker).toBe(first);
  });
});

describe("marked templates still round-trip through the existing parsers", () => {
  it("the White Sheet template does", () => {
    const generated = buildWhiteSheetTemplate(CONTEXT)!;
    expect(extractGuidedMarker(generated).marker).not.toBeNull();
    const parsed = parseWhiteSheetCloseCommandFromMessage(
      extractGuidedMarker(generated).text,
    );
    expect(parsed.kind).toBe("ok");
  });

  it("the slip header does", () => {
    const generated = buildSlipHeaderTemplate(CONTEXT)!;
    expect(extractGuidedMarker(generated).marker).not.toBeNull();
    expect(parseSlipSessionHeader(extractGuidedMarker(generated).text)).toMatchObject({
      sellerName: "กี้",
      marketName: "วัดทุ่งลานนา",
    });
  });

  it("the settlement template does", () => {
    const generated = buildSettlementTemplate(CONTEXT)!;
    expect(extractGuidedMarker(generated).marker).not.toBeNull();
    expect(
      parseGuidedSettlementCommand(extractGuidedMarker(generated).text).kind,
    ).toBe("ok");
  });

  it("uses a different marker per template purpose", () => {
    const markers = [
      buildWhiteSheetTemplate(CONTEXT)!,
      buildSlipHeaderTemplate(CONTEXT)!,
      buildSettlementTemplate(CONTEXT)!,
    ].map((t) => extractGuidedMarker(t).marker);
    expect(new Set(markers).size).toBe(3);
  });

  it("adds one short line and stays far inside the LINE text limit", () => {
    for (const template of [
      buildWhiteSheetTemplate(CONTEXT)!,
      buildSlipHeaderTemplate(CONTEXT)!,
      buildSettlementTemplate(CONTEXT)!,
    ]) {
      const { text, marker } = extractGuidedMarker(template);
      expect(template.split("\n")).toHaveLength(text.split("\n").length + 1);
      expect(marker!.length).toBe(GUIDED_MARKER_PREFIX.length + 22);
      expect([...template].length).toBeLessThan(5000);
    }
  });

  it("omits the marker when the round context is incomplete", () => {
    // The public builders are also called with the display-only fields; those
    // callers get an unmarked template rather than a half-signed one.
    const partial = { marketLabel: "วัดทุ่งลานนา", businessDate: "2026-07-29" };
    expect(extractGuidedMarker(buildWhiteSheetTemplate(partial)!).marker).toBeNull();
    expect(
      extractGuidedMarker(
        buildSlipHeaderTemplate({ ...partial, sellerLabel: "กี้" })!,
      ).marker,
    ).toBeNull();
    expect(
      extractGuidedMarker(
        buildSettlementTemplate({ ...partial, sellerLabel: "กี้" })!,
      ).marker,
    ).toBeNull();
  });
});
