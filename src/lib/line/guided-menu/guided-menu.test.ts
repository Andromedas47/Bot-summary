import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_TX_CODES,
  TX_CODE_TO_BASE,
  TX_CODE_TO_LABEL,
  PREVIEW_OPERATOR_NOTICE,
  PREVIEW_SCENARIOS,
  applyScenarioInPreview,
  applyScenarioToSession,
  collectOperatorVisibleText,
  decodeGuidedMenuPostback,
  encodeGuidedMenuPostback,
  emptySelection,
  formatBusinessDateThai,
  initialGuidedMenuFlow,
  looksLikeSyntheticThaiProduceHeader,
  openCommandFromActiveSession,
  postbackData,
  reduceGuidedMenuPostback,
  resolveGuidedBusinessDate,
  sampleActiveSessionBase,
  toPreviewOpenProduceSessionCommand,
  type GuidedMenuTxCode,
} from "./index";

/** Fixed Bangkok afternoon — 2026-07-28 15:30 Asia/Bangkok */
const TS = Date.parse("2026-07-28T08:30:00.000Z");
const MARKET = "mkt_seven_front";

function openSession(tx: GuidedMenuTxCode, dm: "today" | "yesterday" | "custom" = "today", iso?: string) {
  let flow = initialGuidedMenuFlow();
  expect(flow.screen).toBe("start_menu");

  flow = reduceGuidedMenuPostback({
    data: postbackData("start"),
    selection: flow.selection,
    activeSession: null,
    lineTimestampMs: TS,
  });
  expect(flow.screen).toBe("main_menu");

  flow = reduceGuidedMenuPostback({
    data: postbackData("select_tx", { tx }),
    selection: flow.selection,
    activeSession: null,
    lineTimestampMs: TS,
  });
  expect(flow.screen).toBe("market_select");

  flow = reduceGuidedMenuPostback({
    data: postbackData("select_market", { tx, mid: MARKET }),
    selection: flow.selection,
    activeSession: null,
    lineTimestampMs: TS,
  });
  expect(flow.screen).toBe("date_select");

  if (dm === "custom") {
    flow = reduceGuidedMenuPostback({
      data: postbackData("custom_date", { tx, mid: MARKET, dm: "custom" }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
    flow = reduceGuidedMenuPostback({
      data: postbackData("set_custom_date", {
        tx,
        mid: MARKET,
        dm: "custom",
        iso: iso ?? "2026-07-25",
      }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
  } else {
    flow = reduceGuidedMenuPostback({
      data: postbackData("select_date", { tx, mid: MARKET, dm }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
  }

  expect(flow.screen).toBe("confirm_open");
  expect(flow.openCommand).toBeNull();

  flow = reduceGuidedMenuPostback({
    data: postbackData("start_session", {
      tx,
      mid: MARKET,
      dm,
      ...(dm === "custom" ? { iso: iso ?? "2026-07-25" } : {}),
    }),
    selection: flow.selection,
    activeSession: null,
    lineTimestampMs: TS,
  });

  return flow;
}

function loadValidScenario(tx: GuidedMenuTxCode = "b") {
  let flow = openSession(tx);
  flow = applyScenarioInPreview({
    activeSession: flow.activeSession!,
    scenarioId: "valid",
  });
  return flow;
}

function loadBlockingScenario(tx: GuidedMenuTxCode = "b") {
  let flow = openSession(tx);
  flow = applyScenarioInPreview({
    activeSession: flow.activeSession!,
    scenarioId: "partial_error",
  });
  return flow;
}

describe("guided menu V1 — all three transaction types", () => {
  for (const tx of ALL_TX_CODES) {
    it(`opens main session for ${TX_CODE_TO_LABEL[tx]} → ${TX_CODE_TO_BASE[tx]}`, () => {
      const flow = openSession(tx);
      expect(flow.screen).toBe("active_session");
      expect(flow.openCommand!.sessionKind).toBe("main");
      expect(flow.openCommand!.initialTransactionType).toBe(TX_CODE_TO_BASE[tx]);
      expect(flow.activeSession!.transactionLabel).toBe(TX_CODE_TO_LABEL[tx]);
      expect(flow.activeSession!.marketLabel).toBe("หน้าเซเวน");
    });
  }
});

describe("guided menu V1 — no silent transaction default", () => {
  it("rejects start_session without tx", () => {
    const flow = reduceGuidedMenuPostback({
      data: postbackData("start_session", { mid: MARKET, dm: "today" }),
      selection: emptySelection(),
      activeSession: null,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("error");
    expect(flow.openCommand).toBeNull();
    expect(flow.error).toBe("missing_tx_on_start");
  });

  it("start menu does not preselect a transaction type", () => {
    const flow = initialGuidedMenuFlow();
    expect(flow.selection.txCode).toBeNull();
    expect(flow.screen).toBe("start_menu");
  });
});

describe("guided menu V1 — ชั่งคืน maps to คืน", () => {
  it("maps UI ชั่งคืน to base transaction type คืน", () => {
    const flow = openSession("k");
    expect(flow.openCommand!.initialTransactionType).toBe("คืน");
    expect(flow.activeSession!.baseTransactionType).toBe("คืน");
    expect(flow.activeSession!.transactionLabel).toBe("ชั่งคืน");
  });
});

describe("guided menu V1 — displayed values equal emitted command", () => {
  it("confirmation values match OpenProduceSessionCommand", () => {
    const flow = openSession("b", "yesterday");
    expect(flow.openCommand!.initialTransactionType).toBe(flow.activeSession!.baseTransactionType);
    expect(flow.openCommand!.businessDate).toBe(flow.activeSession!.businessDateIso);
    expect(flow.openCommand!.marketLabel).toBe(flow.activeSession!.marketLabel);
    expect(flow.openCommand!.staffLabel).toBe(flow.activeSession!.staffLabel);
    expect(flow.openCommand!.businessDate).toBe("2026-07-27");
    expect(flow.openCommand!.transactionTimeSource).toBe("line_event");
  });
});

describe("guided menu V1 — received vs parsed counts", () => {
  it("keeps receivedMessageCount distinct from parsedItemCount", () => {
    const flow = loadValidScenario("b");
    expect(flow.activeSession!.receivedMessageCount).toBe(4);
    expect(flow.activeSession!.parsedItemCount).toBe(4);
    expect(flow.screen).toBe("ack_compact");
    const text = flow.messages[0].type === "text" ? flow.messages[0].text : "";
    expect(text).toContain("รับข้อความแล้ว 4 ข้อความ");
    expect(text).toContain("อ่านได้ 4 รายการ");
    expect(text).not.toContain("บันทึกแล้ว");
  });

  it("partial error keeps counts distinct", () => {
    const flow = loadBlockingScenario("k");
    expect(flow.activeSession!.receivedMessageCount).toBe(4);
    expect(flow.activeSession!.parsedItemCount).toBe(3);
    expect(flow.activeSession!.blockingIssueCount).toBe(1);
  });
});

describe("guided menu V1 — blocking prevents final confirmation", () => {
  it("review_blocking has no confirm_persist / finalize actions", () => {
    let flow = loadBlockingScenario();
    flow = reduceGuidedMenuPostback({
      data: postbackData("review_close"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("close_barrier");
    expect(flow.activeSession!.persistedSimulated).toBe(false);
    expect(flow.closeCommand).toBeNull();

    flow = reduceGuidedMenuPostback({
      data: postbackData("barrier_ready"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("review_blocking");
    const json = JSON.stringify(flow.messages);
    expect(json).not.toContain("ยืนยันบันทึก");
    expect(json).toContain("ยังไม่มีข้อมูลใดถูกบันทึก");
    expect(json).toContain("ส่งข้อความแก้ไข");

    flow = reduceGuidedMenuPostback({
      data: postbackData("confirm_persist"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("review_blocking");
    expect(flow.activeSession!.persistedSimulated).toBe(false);
  });
});

describe("guided menu V1 — valid review requires explicit confirmation", () => {
  it("review_valid → final_confirm → success only after finalize", () => {
    let flow = loadValidScenario();
    flow = reduceGuidedMenuPostback({
      data: postbackData("review_close"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("close_barrier");
    expect(flow.activeSession!.persistedSimulated).toBe(false);

    flow = reduceGuidedMenuPostback({
      data: postbackData("barrier_ready"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("review_valid");
    expect(flow.closeCommand).toBeNull();

    flow = reduceGuidedMenuPostback({
      data: postbackData("confirm_persist"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("final_confirm");
    expect(flow.activeSession!.reviewStatus).toBe("awaiting_final");
    expect(flow.activeSession!.persistedSimulated).toBe(false);
    expect(flow.closeCommand).toBeNull();

    flow = reduceGuidedMenuPostback({
      data: postbackData("finalize"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("success");
    expect(flow.activeSession!.persistedSimulated).toBe(true);
    expect(flow.closeCommand).not.toBeNull();
    expect(flow.closeCommand!.expectedItemCount).toBe(4);
  });

  it("finalize without awaiting_final is rejected", () => {
    let flow = loadValidScenario();
    flow = reduceGuidedMenuPostback({
      data: postbackData("finalize"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("error");
    expect(flow.error).toBe("finalize_requires_confirmation");
    expect(flow.activeSession!.persistedSimulated).toBe(false);
  });
});

describe("guided menu V1 — close barrier does not imply persistence", () => {
  it("waiting barrier never says บันทึกแล้ว and never emits close command", () => {
    let flow = loadValidScenario();
    flow = reduceGuidedMenuPostback({
      data: postbackData("review_close"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("close_barrier");
    expect(flow.activeSession!.closeBarrierStatus).toBe("waiting");
    expect(flow.activeSession!.admittedEventCount).toBeGreaterThan(flow.activeSession!.ingestedEventCount);
    expect(flow.activeSession!.persistedSimulated).toBe(false);
    expect(flow.closeCommand).toBeNull();
    const text = flow.messages[0].type === "text" ? flow.messages[0].text : "";
    expect(text).toContain("กำลังรอข้อความที่ส่งค้างอยู่");
    expect(text).toContain("ยังไม่มีการบันทึก");
    expect(text).not.toContain("บันทึกแล้ว");
  });
});

describe("guided menu V1 — success only after explicit confirmation", () => {
  it("success appears only after finalize", () => {
    let flow = loadValidScenario();
    const before = reduceGuidedMenuPostback({
      data: postbackData("review_close"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(before.screen).not.toBe("success");

    flow = before;
    flow = reduceGuidedMenuPostback({
      data: postbackData("barrier_ready"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    flow = reduceGuidedMenuPostback({
      data: postbackData("confirm_persist"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("final_confirm");

    flow = reduceGuidedMenuPostback({
      data: postbackData("finalize"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("success");
    const text = flow.messages[0].type === "text" ? flow.messages[0].text : "";
    expect(text).toContain("บันทึกแล้ว");
    expect(text).toContain("จำลองพรีวิว");
  });
});

describe("guided menu V1 polish — state hardening", () => {
  it("Back from market returns to type select; Back from date returns to market", () => {
    let flow = initialGuidedMenuFlow();
    flow = reduceGuidedMenuPostback({
      data: postbackData("start"),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
    flow = reduceGuidedMenuPostback({
      data: postbackData("select_tx", { tx: "s" }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("market_select");
    flow = reduceGuidedMenuPostback({
      data: postbackData("back", { tx: "s" }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("main_menu");
    expect(flow.selection.txCode).toBeNull();

    flow = reduceGuidedMenuPostback({
      data: postbackData("select_tx", { tx: "b" }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
    flow = reduceGuidedMenuPostback({
      data: postbackData("select_market", { tx: "b", mid: MARKET }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
    flow = reduceGuidedMenuPostback({
      data: postbackData("back", { tx: "b", mid: MARKET }),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("market_select");
  });

  it("reset via menu clears selection and session", () => {
    let flow = loadValidScenario();
    flow = reduceGuidedMenuPostback({
      data: postbackData("menu"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("start_menu");
    expect(flow.selection).toEqual(emptySelection());
    expect(flow.activeSession).toBeNull();
    expect(flow.openCommand).toBeNull();
    expect(flow.closeCommand).toBeNull();
  });

  it("double finalize stays on single success", () => {
    let flow = loadValidScenario();
    flow = reduceGuidedMenuPostback({
      data: postbackData("review_close"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    flow = reduceGuidedMenuPostback({
      data: postbackData("barrier_ready"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    flow = reduceGuidedMenuPostback({
      data: postbackData("confirm_persist"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    flow = reduceGuidedMenuPostback({
      data: postbackData("finalize"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("success");
    const first = flow.closeCommand;
    flow = reduceGuidedMenuPostback({
      data: postbackData("finalize"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("success");
    expect(flow.closeCommand!.expectedItemCount).toBe(first!.expectedItemCount);
  });

  it("barrier_ready rejected unless waiting", () => {
    let flow = loadValidScenario();
    flow = reduceGuidedMenuPostback({
      data: postbackData("barrier_ready"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("error");
    expect(flow.error).toBe("barrier_not_waiting");
  });

  it("waiting scenario isolates barrier counts from valid fixture", () => {
    let flow = openSession("b");
    flow = applyScenarioInPreview({
      activeSession: flow.activeSession!,
      scenarioId: "waiting",
    });
    expect(flow.screen).toBe("close_barrier");
    expect(flow.activeSession!.admittedEventCount).toBeGreaterThan(flow.activeSession!.ingestedEventCount);
    expect(flow.activeSession!.persistedSimulated).toBe(false);

    flow = applyScenarioInPreview({
      activeSession: flow.activeSession!,
      scenarioId: "partial_error",
    });
    expect(flow.screen).toBe("ack_compact");
    expect(flow.activeSession!.blockingIssueCount).toBe(1);
    expect(flow.activeSession!.closeBarrierStatus).toBe("idle");
  });

  it("operator-visible content keeps บันทึกแล้ว only on success", () => {
    let flow = loadValidScenario();
    let visible = collectOperatorVisibleText(flow.messages);
    expect(visible).toContain(PREVIEW_OPERATOR_NOTICE);
    expect(visible).not.toContain("บันทึกแล้ว");

    flow = openSession("k");
    visible = collectOperatorVisibleText(flow.messages);
    expect(visible).toContain("ส่งต่อข้อความรายการสินค้ามาได้เหมือนเดิม");
    expect(visible).toContain("หรือคัดลอกมาวางทั้งชุดได้");
    expect(visible).not.toContain("admitted");
    expect(visible).not.toContain("ingested");
  });

  it("adapter output matches visible session confirmation values", () => {
    const flow = openSession("k", "yesterday");
    const cmd = openCommandFromActiveSession(flow.activeSession!);
    expect(cmd.initialTransactionType).toBe("คืน");
    expect(cmd.businessDate).toBe(flow.activeSession!.businessDateIso);
    expect(cmd.marketLabel).toBe(flow.activeSession!.marketLabel);
    expect(cmd.staffLabel).toBe(flow.activeSession!.staffLabel);
  });

  it("counts derive from fixture data", () => {
    const session = applyScenarioToSession(sampleActiveSessionBase(), "valid");
    expect(session.receivedMessageCount).toBe(PREVIEW_SCENARIOS.valid.receivedMessages.length);
    expect(session.parsedItemCount).toBe(PREVIEW_SCENARIOS.valid.items.length);
    expect(session.blockingIssueCount).toBe(PREVIEW_SCENARIOS.valid.issues.length);
  });
});

describe("guided menu V1 — postback encode/decode + tamper rejection", () => {
  it("round-trips compact versioned payloads", () => {
    const payload = {
      v: 1 as const,
      a: "review_close" as const,
      tok: "opaque-0050-reserved",
    };
    const encoded = encodeGuidedMenuPostback(payload);
    expect(encoded.startsWith("gpm.v1.")).toBe(true);
    expect(encoded.length).toBeLessThanOrEqual(300);
    const decoded = decodeGuidedMenuPostback(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.payload).toEqual(payload);
  });

  it("rejects tampered / invalid payloads", () => {
    expect(decodeGuidedMenuPostback("not-a-postback").ok).toBe(false);
    expect(decodeGuidedMenuPostback("gpm.v1.!!!").ok).toBe(false);

    const smuggle = Buffer.from(JSON.stringify({
      v: 1,
      a: "start_session",
      tx: "b",
      mid: MARKET,
      dm: "today",
      marketLabel: "ปลอม",
    })).toString("base64url");
    const decoded = decodeGuidedMenuPostback(`gpm.v1.${smuggle}`);
    expect(decoded.ok).toBe(false);

    const badTx = Buffer.from(JSON.stringify({ v: 1, a: "select_tx", tx: "x" })).toString("base64url");
    expect(decodeGuidedMenuPostback(`gpm.v1.${badTx}`).ok).toBe(false);

    const badIso = Buffer.from(JSON.stringify({
      v: 1,
      a: "set_custom_date",
      tx: "b",
      mid: MARKET,
      dm: "custom",
      iso: "2026-13-40",
    })).toString("base64url");
    expect(decodeGuidedMenuPostback(`gpm.v1.${badIso}`).ok).toBe(false);
  });
});

describe("guided menu V1 — Buddhist Era display / ISO command", () => {
  it("keeps Thai BE display and ISO command consistent", () => {
    const today = resolveGuidedBusinessDate("today", TS)!;
    expect(today.iso).toBe("2026-07-28");
    expect(today.thai).toContain("2569");
    expect(formatBusinessDateThai(today.iso)).toBe(today.thai);

    const flow = openSession("s", "custom", "2026-07-20");
    expect(flow.openCommand!.businessDate).toBe("2026-07-20");
    expect(flow.activeSession!.businessDateThai).toContain("2569");
  });
});

describe("guided menu V1 — no synthetic Thai header", () => {
  it("adapter and flow messages never generate produce headers", () => {
    const cmd = toPreviewOpenProduceSessionCommand({
      initialTransactionType: "คืน",
      businessDate: "2026-07-28",
      marketLabel: "หน้าเซเวน",
      lineTimestampMs: TS,
    });
    expect(looksLikeSyntheticThaiProduceHeader(JSON.stringify(cmd))).toBe(false);

    const flow = openSession("k");
    for (const message of flow.messages) {
      const text = message.type === "text" ? message.text : JSON.stringify(message);
      expect(looksLikeSyntheticThaiProduceHeader(text)).toBe(false);
    }
    expect(looksLikeSyntheticThaiProduceHeader("ต้อม-พาซิโอ้ผัก ชั่งคืน 30/06/2569")).toBe(true);
  });
});

describe("guided menu V1 — no Production / 0049 imports", () => {
  it("guided-menu sources do not import webhook, supabase, or unfinished 0049 modules", () => {
    const dir = join(import.meta.dir);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const bannedImportPatterns = [
      /from\s+["'][^"']*webhook-service["']/,
      /from\s+["'][^"']*produce-session-commands["']/,
      /from\s+["'][^"']*pending-session-finalizer["']/,
      /from\s+["']@\/lib\/supabase/,
      /createServiceClient/,
      /from\s+["'][^"']*migration-0049/,
    ];
    for (const file of files) {
      const src = readFileSync(join(dir, file), "utf8");
      for (const pattern of bannedImportPatterns) {
        expect(pattern.test(src)).toBe(false);
      }
    }
  });
});

describe("guided menu V1 — status screens", () => {
  it("status shows valid and blocking content", () => {
    let flow = loadValidScenario();
    flow = reduceGuidedMenuPostback({
      data: postbackData("status"),
      selection: flow.selection,
      activeSession: flow.activeSession,
      lineTimestampMs: TS,
    });
    expect(flow.screen).toBe("session_status");
    const validText = flow.messages[0].type === "text" ? flow.messages[0].text : "";
    expect(validText).toContain("รับข้อความแล้ว");
    expect(validText).toContain("ยังไม่บันทึก");

    flow = loadBlockingScenario();
    const session = applyScenarioToSession(flow.activeSession!, "partial_error");
    flow = reduceGuidedMenuPostback({
      data: postbackData("status"),
      selection: session.selection,
      activeSession: session,
      lineTimestampMs: TS,
    });
    const errText = flow.messages[0].type === "text" ? flow.messages[0].text : "";
    expect(errText).toContain("ข้อความที่มีปัญหา");
    expect(errText).toContain("ไม่พบจำนวนและหน่วย");
  });
});

describe("guided menu V1 — อื่น ๆ market", () => {
  it("other market does not open a session", () => {
    let flow = initialGuidedMenuFlow();
    flow = reduceGuidedMenuPostback({
      data: postbackData("start"),
      selection: flow.selection,
      activeSession: null,
      lineTimestampMs: TS,
    });
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
  });
});
