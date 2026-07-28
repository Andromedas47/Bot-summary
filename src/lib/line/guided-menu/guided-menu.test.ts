import { describe, expect, it } from "bun:test";
import {
  ALL_TX_CODES,
  TX_CODE_TO_BASE,
  TX_CODE_TO_LABEL,
  decodeGuidedMenuPostback,
  encodeGuidedMenuPostback,
  emptySelection,
  formatBusinessDateThai,
  initialGuidedMenuFlow,
  looksLikeSyntheticThaiProduceHeader,
  postbackData,
  reduceGuidedMenuPostback,
  resolveGuidedBusinessDate,
  toPreviewOpenProduceSessionCommand,
  type GuidedMenuTxCode,
} from "./index";

/** Fixed Bangkok afternoon — 2026-07-28 15:30 Asia/Bangkok */
const TS = Date.parse("2026-07-28T08:30:00.000Z");

function startSession(tx: GuidedMenuTxCode, dm: "today" | "yesterday" | "custom" = "today", iso?: string) {
  let flow = initialGuidedMenuFlow();

  flow = reduceGuidedMenuPostback({
    data: postbackData("select_tx", { tx }),
    selection: flow.selection,
    activeSession: null,
    lineTimestampMs: TS,
  });
  expect(flow.screen).toBe("market_select");

  flow = reduceGuidedMenuPostback({
    data: postbackData("select_market", { tx, mid: "mkt_khlong_toei" }),
    selection: flow.selection,
    activeSession: null,
    lineTimestampMs: TS,
  });
  expect(flow.screen).toBe("date_select");

  if (dm === "custom") {
    flow = reduceGuidedMenuPostback({
      data: postbackData("custom_date", { tx, mid: "mkt_khlong_toei", dm: "custom" }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("custom_date");

    flow = reduceGuidedMenuPostback({
      data: postbackData("set_custom_date", {
        tx,
        mid: "mkt_khlong_toei",
        dm: "custom",
        iso: iso ?? "2026-07-25",
      }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
  } else {
    flow = reduceGuidedMenuPostback({
      data: postbackData("select_date", { tx, mid: "mkt_khlong_toei", dm }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
  }

  expect(flow.screen).toBe("confirm_open");
  expect(flow.openCommand).toBeNull();

  const startData = postbackData("start_session", {
    tx,
    mid: "mkt_khlong_toei",
    dm,
    ...(dm === "custom" ? { iso: iso ?? "2026-07-25" } : {}),
  });

  flow = reduceGuidedMenuPostback({
    data: startData,
    selection: flow.selection,
    activeSession: null,
    lineTimestampMs: TS,
    observedItemCount: 2,
  });

  return flow;
}

describe("guided menu — every main transaction type", () => {
  for (const tx of ALL_TX_CODES) {
    it(`opens a main session for ${TX_CODE_TO_LABEL[tx]} → base ${TX_CODE_TO_BASE[tx]}`, () => {
      const flow = startSession(tx);
      expect(flow.screen).toBe("active_session");
      expect(flow.openCommand).not.toBeNull();
      expect(flow.openCommand!.sessionKind).toBe("main");
      expect(flow.openCommand!.initialTransactionType).toBe(TX_CODE_TO_BASE[tx]);
      expect(flow.openCommand!.declaredTransactionType).toBeNull();
      expect(flow.openCommand!.additionalOpener).toBeNull();
      expect(flow.openCommand!.marketLabel).toBe("คลองเตย");
      expect(flow.openCommand!.staffLabel).toBeTruthy();
      expect(flow.openCommand!.lineEventId).toBeTruthy();
      expect(flow.openCommand!.lineTimestampMs).toBe(TS);
      expect(flow.activeSession!.transactionLabel).toBe(TX_CODE_TO_LABEL[tx]);
    });
  }

  it("never silently defaults transaction type — start without tx fails", () => {
    const flow = reduceGuidedMenuPostback({
      data: postbackData("start_session", { mid: "mkt_khlong_toei", dm: "today" }),
      selection: emptySelection(),
      activeSession: null,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("error");
    expect(flow.openCommand).toBeNull();
    expect(flow.error).toBe("missing_tx_on_start");
  });
});

describe("guided menu — postback encode/decode", () => {
  it("round-trips compact versioned payloads", () => {
    const payload = {
      v: 1 as const,
      a: "select_date" as const,
      tx: "k" as const,
      mid: "mkt_si_mum_mueang",
      dm: "yesterday" as const,
      tok: "opaque-0050-reserved",
    };
    const encoded = encodeGuidedMenuPostback(payload);
    expect(encoded.startsWith("gpm.v1.")).toBe(true);
    expect(encoded.length).toBeLessThanOrEqual(300);

    const decoded = decodeGuidedMenuPostback(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.payload).toEqual(payload);
    }
  });

  it("rejects missing prefix", () => {
    expect(decodeGuidedMenuPostback("not-a-postback").ok).toBe(false);
  });

  it("rejects tampered base64", () => {
    expect(decodeGuidedMenuPostback("gpm.v1.!!!").ok).toBe(false);
  });

  it("rejects unknown fields (label smuggling)", () => {
    const json = JSON.stringify({
      v: 1,
      a: "start_session",
      tx: "b",
      mid: "mkt_khlong_toei",
      dm: "today",
      marketLabel: "ปลอมตลาด",
    });
    const b64 = Buffer.from(json).toString("base64url");
    const decoded = decodeGuidedMenuPostback(`gpm.v1.${b64}`);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain("unknown_field");
  });

  it("rejects invalid tx codes", () => {
    const json = JSON.stringify({ v: 1, a: "select_tx", tx: "x" });
    const b64 = Buffer.from(json).toString("base64url");
    expect(decodeGuidedMenuPostback(`gpm.v1.${b64}`).ok).toBe(false);
  });

  it("rejects wrong version", () => {
    const json = JSON.stringify({ v: 2, a: "menu" });
    const b64 = Buffer.from(json).toString("base64url");
    const decoded = decodeGuidedMenuPostback(`gpm.v1.${b64}`);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe("unsupported_version");
  });

  it("rejects invalid custom ISO dates", () => {
    const json = JSON.stringify({
      v: 1,
      a: "set_custom_date",
      tx: "b",
      mid: "mkt_khlong_toei",
      dm: "custom",
      iso: "2026-13-40",
    });
    const b64 = Buffer.from(json).toString("base64url");
    expect(decodeGuidedMenuPostback(`gpm.v1.${b64}`).ok).toBe(false);
  });
});

describe("guided menu — date conversion", () => {
  it("resolves today / yesterday to ISO and Thai BE display", () => {
    const today = resolveGuidedBusinessDate("today", TS);
    expect(today).not.toBeNull();
    expect(today!.iso).toBe("2026-07-28");
    expect(today!.thai).toContain("2569");
    expect(today!.thai).toContain("กรกฎาคม");

    const yesterday = resolveGuidedBusinessDate("yesterday", TS);
    expect(yesterday!.iso).toBe("2026-07-27");
    expect(yesterday!.thai).toContain("2569");
  });

  it("keeps custom ISO for commands and formats Thai for display", () => {
    const custom = resolveGuidedBusinessDate("custom", TS, "2026-07-25");
    expect(custom!.iso).toBe("2026-07-25");
    expect(formatBusinessDateThai(custom!.iso)).toBe(custom!.thai);
    expect(custom!.thai).toContain("2569");
  });

  it("supports custom-date preview path through confirmation", () => {
    const flow = startSession("s", "custom", "2026-07-20");
    expect(flow.openCommand!.businessDate).toBe("2026-07-20");
    expect(flow.activeSession!.businessDateThai).toContain("2569");
  });
});

describe("guided menu — no synthetic Thai header generation", () => {
  it("open command adapter does not produce header-shaped text", () => {
    const cmd = toPreviewOpenProduceSessionCommand({
      initialTransactionType: "คืน",
      businessDate: "2026-07-28",
      marketLabel: "คลองเตย",
      lineTimestampMs: TS,
    });
    const serialized = JSON.stringify(cmd);
    expect(looksLikeSyntheticThaiProduceHeader(serialized)).toBe(false);
    expect(serialized).not.toContain("จบรายการ");
    expect(serialized).not.toMatch(/คลองเตย\s+เบิก/);
  });

  it("flow messages never include synthetic produce headers", () => {
    const flow = startSession("k");
    for (const message of flow.messages) {
      const text = message.type === "text" ? message.text : JSON.stringify(message);
      expect(looksLikeSyntheticThaiProduceHeader(text)).toBe(false);
    }
    expect(looksLikeSyntheticThaiProduceHeader("ต้อม-พาซิโอ้ผัก ชั่งคืน 30/06/2569")).toBe(true);
  });
});

describe("guided menu — confirmation matches typed command", () => {
  it("confirmation values match emitted OpenProduceSessionCommand", () => {
    const flow = startSession("b", "yesterday");
    expect(flow.openCommand).not.toBeNull();
    expect(flow.activeSession).not.toBeNull();
    expect(flow.openCommand!.initialTransactionType).toBe(flow.activeSession!.baseTransactionType);
    expect(flow.openCommand!.businessDate).toBe(flow.activeSession!.businessDateIso);
    expect(flow.openCommand!.marketLabel).toBe(flow.activeSession!.marketLabel);
    expect(flow.openCommand!.staffLabel).toBe(flow.activeSession!.staffLabel);
    expect(flow.openCommand!.sessionKind).toBe("main");
    expect(flow.openCommand!.transactionTimeSource).toBe("line_event");
    expect(flow.openCommand!.businessDate).toBe("2026-07-27");
  });
});

describe("guided menu — close requires explicit confirmation", () => {
  it("close_ask alone does not close or emit close command", () => {
    let flow = startSession("b");
    flow = reduceGuidedMenuPostback({
      data: postbackData("close_ask"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("close_confirm");
    expect(flow.closeCommand).toBeNull();
    expect(flow.activeSession).not.toBeNull();
  });

  it("close_confirm emits close command and clears session", () => {
    let flow = startSession("b");
    flow = reduceGuidedMenuPostback({
      data: postbackData("close_ask"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    flow = reduceGuidedMenuPostback({
      data: postbackData("close_confirm"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("session_closed");
    expect(flow.activeSession).toBeNull();
    expect(flow.closeCommand).not.toBeNull();
    expect(flow.closeCommand!.kind).toBe("close");
    expect(flow.closeCommand!.expectedItemCount).toBe(2);
  });

  it("close_cancel returns to active session", () => {
    let flow = startSession("s");
    flow = reduceGuidedMenuPostback({
      data: postbackData("close_ask"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    flow = reduceGuidedMenuPostback({
      data: postbackData("close_cancel"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("active_session");
    expect(flow.closeCommand).toBeNull();
    expect(flow.activeSession).not.toBeNull();
  });
});

describe("guided menu — อื่น ๆ market without free-text persistence", () => {
  it("other market screen does not open a session", () => {
    let flow = initialGuidedMenuFlow();
    flow = reduceGuidedMenuPostback({
      data: postbackData("select_tx", { tx: "b" }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
    flow = reduceGuidedMenuPostback({
      data: postbackData("other_market", { tx: "b", mid: "mkt_other" }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("other_market");
    expect(flow.openCommand).toBeNull();
    expect(flow.messages[0].type).toBe("text");
    if (flow.messages[0].type === "text") {
      expect(flow.messages[0].text).toContain("ไม่บันทึก free-text");
    }
  });
});

describe("guided menu — active session quick replies", () => {
  it("status / menu quick replies work", () => {
    let flow = startSession("k");
    flow = reduceGuidedMenuPostback({
      data: postbackData("status"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("active_session");

    flow = reduceGuidedMenuPostback({
      data: postbackData("menu"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("main_menu");
  });
});
