import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

const serviceClient = { name: "service-client" };
let loadedReport: unknown = { businessDate: "2026-08-22", items: [] };
let loadError: Error | null = null;
let loadCalls: Array<{ client: unknown; businessDate: string }> = [];
let formatterCalls: unknown[] = [];
let formatterMessages = ["📦 แผนซื้อของประจำวัน\nข้อมูลวันที่ 22/08/2569"];
let pushCalls: Array<{ to: string; text: string; retryKey?: string }> = [];
let failingTarget: string | null = null;

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => serviceClient,
}));

mock.module("@/lib/summary/purchase-planning-service", () => ({
  loadPurchasePlanningReport: async (client: unknown, businessDate: string) => {
    loadCalls.push({ client, businessDate });
    if (loadError) throw loadError;
    return loadedReport;
  },
}));

mock.module("@/lib/summary/purchase-planning-message", () => ({
  buildPurchasePlanningMessages: (report: unknown) => {
    formatterCalls.push(report);
    return formatterMessages;
  },
}));

mock.module("@/lib/line/reply", () => ({
  pushLineMessage: async (to: string, text: string, retryKey?: string) => {
    pushCalls.push({ to, text, retryKey });
    if (to === failingTarget) throw new Error("LINE unavailable");
    return { status: "delivered" };
  },
}));

const { GET } = await import("./route");

const originalSecret = process.env.CRON_SECRET;
const originalTargets = process.env.STOCK_SUMMARY_LINE_TARGETS;
const realDateNow = Date.now;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function request(query = "", authorization: string | null = "Bearer purchase-secret") {
  return new NextRequest(`http://localhost/api/cron/daily-purchase-planning${query}`, {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "purchase-secret";
  process.env.STOCK_SUMMARY_LINE_TARGETS = "Coperator";
  loadedReport = { businessDate: "2026-08-22", items: [] };
  loadError = null;
  loadCalls = [];
  formatterCalls = [];
  formatterMessages = ["📦 แผนซื้อของประจำวัน\nข้อมูลวันที่ 22/08/2569"];
  pushCalls = [];
  failingTarget = null;
  Date.now = realDateNow;
});

afterEach(() => {
  restore("CRON_SECRET", originalSecret);
  restore("STOCK_SUMMARY_LINE_TARGETS", originalTargets);
  Date.now = realDateNow;
});

describe("daily purchase planning cron", () => {
  test("rejects unauthorized calls and fails closed without CRON_SECRET", async () => {
    expect((await GET(request("", null))).status).toBe(401);
    expect((await GET(request("", "Bearer wrong"))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(request())).status).toBe(500);
    expect(loadCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  test("morning 23/08/2569 loads and formats 22/08/2569", async () => {
    Date.now = () => Date.UTC(2026, 7, 23, 1, 15);

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(loadCalls).toEqual([{ client: serviceClient, businessDate: "2026-08-22" }]);
    expect(formatterCalls).toEqual([loadedReport]);
  });

  test("pushes every formatter chunk in order with deterministic distinct keys", async () => {
    formatterMessages = ["part 1", "part 2", "part 3"];

    await GET(request("?date=2026-08-22"));
    expect(pushCalls.map(({ to, text }) => ({ to, text }))).toEqual([
      { to: "Coperator", text: "part 1" },
      { to: "Coperator", text: "part 2" },
      { to: "Coperator", text: "part 3" },
    ]);
    expect(new Set(pushCalls.map((call) => call.retryKey)).size).toBe(3);

    const firstKeys = pushCalls.map((call) => call.retryKey);
    pushCalls = [];
    await GET(request("?date=2026-08-22"));
    expect(pushCalls.map((call) => call.retryKey)).toEqual(firstKeys);
  });

  test("passes no-data formatter output through unchanged", async () => {
    formatterMessages = [
      "📦 แผนซื้อของประจำวัน\nข้อมูลวันที่ 22/08/2569\n\n🟢 ควรซื้อเพิ่ม\n\nวันนี้ยังไม่มีสินค้าที่ควรซื้อเพิ่ม\n\nยังไม่มีข้อมูลเบิก/ชั่งคืนที่บันทึกสำเร็จสำหรับวันนี้",
    ];

    const response = await GET(request("?date=2026-08-22"));
    expect(response.status).toBe(200);
    expect(pushCalls.map((call) => call.text)).toEqual(formatterMessages);
  });

  test("debug returns exact messages without sending LINE", async () => {
    formatterMessages = ["part 1", "part 2"];
    const response = await GET(request("?date=2026-08-22&debug=1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      debug: true,
      businessDate: "2026-08-22",
      messageCount: 2,
      messages: formatterMessages,
    });
    expect(pushCalls).toHaveLength(0);
  });

  test("loader or formatter failure returns 500 without LINE delivery", async () => {
    loadError = new Error("report unavailable");
    expect((await GET(request("?date=2026-08-22"))).status).toBe(500);
    expect(pushCalls).toHaveLength(0);
  });

  test("isolates target failures and reports the partial failure", async () => {
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cbroken,Coperator";
    formatterMessages = ["part 1", "part 2"];
    failingTarget = "Cbroken";

    const response = await GET(request("?date=2026-08-22"));
    expect(response.status).toBe(500);
    expect(pushCalls.map((call) => call.to)).toEqual(["Cbroken", "Coperator", "Coperator"]);
    expect(await response.json()).toMatchObject({ sent: true, sentCount: 1, failedCount: 1 });
  });

  test("invalid or impossible dates never load or send a different day", async () => {
    for (const date of ["22/08/2569", "2026-02-31"]) {
      expect((await GET(request(`?date=${encodeURIComponent(date)}`))).status).toBe(400);
    }
    expect(loadCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  test("uses stock-summary operators and stays outside Vercel/GitHub schedules", async () => {
    const workflow = await Bun.file(
      `${import.meta.dir}/../../../../../.github/workflows/daily-purchase-planning.yml`,
    ).text();
    expect(workflow).toContain("08:15 Asia/Bangkok");
    expect(workflow).toContain("01:15 UTC");
    expect(workflow).toContain("Supabase Cron");
    expect(workflow).toContain("/api/cron/daily-purchase-planning");
    expect(workflow).not.toMatch(/^\s*schedule:/m);
    expect(workflow).not.toMatch(/^\s*- cron:/m);

    const file = await import("../../../../../vercel.json", { with: { type: "json" } });
    const config = file.default as { crons?: Array<{ path: string }> };
    expect(config.crons?.find((cron) => cron.path === "/api/cron/daily-purchase-planning"))
      .toBeUndefined();
  });
});
