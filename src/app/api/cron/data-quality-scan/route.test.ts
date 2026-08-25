import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ marker: "fake-service-client" }),
}));

let scanCalls: Array<{ businessDate: string }> = [];
const scanResult = { businessDate: "2026-08-24", candidateCount: 3, upserts: [] as unknown[] };

mock.module("@/lib/data-quality/scan", () => ({
  scanDataQualityIssues: async (_supabase: unknown, businessDate: string) => {
    scanCalls.push({ businessDate });
    return { ...scanResult, businessDate };
  },
}));

// Imported at module scope, immediately after the mocks above (this route
// only needs createServiceClient — the same key every other cron test file
// already mocks it with, so there's no cross-file shape conflict here; see
// src/app/api/admin/data-quality/resolve/route.ts for the one route that
// DID need createClient and hit that conflict).
const { GET } = await import("./route");

const ORIGINAL_SECRET = process.env.CRON_SECRET;

function req(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

beforeEach(() => {
  scanCalls = [];
  process.env.CRON_SECRET = "test-secret";
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe("GET /api/cron/data-quality-scan", () => {
  it("fails closed when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req("http://localhost/api/cron/data-quality-scan"));
    expect(res.status).toBe(500);
    expect(scanCalls).toHaveLength(0);
  });

  it("rejects a missing/invalid bearer token", async () => {
    const res = await GET(req("http://localhost/api/cron/data-quality-scan"));
    expect(res.status).toBe(401);
    expect(scanCalls).toHaveLength(0);
  });

  it("defaults to yesterday's Bangkok business date when no ?date= is given", async () => {
    const res = await GET(
      req("http://localhost/api/cron/data-quality-scan", { authorization: "Bearer test-secret" }),
    );
    expect(res.status).toBe(200);
    expect(scanCalls).toHaveLength(1);
    expect(scanCalls[0].businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("honors an explicit ?date= override and is idempotent to call twice", async () => {
    const url = "http://localhost/api/cron/data-quality-scan?date=2026-08-20";
    const res1 = await GET(req(url, { authorization: "Bearer test-secret" }));
    const res2 = await GET(req(url, { authorization: "Bearer test-secret" }));
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(scanCalls).toEqual([{ businessDate: "2026-08-20" }, { businessDate: "2026-08-20" }]);
  });

  it("ignores a malformed ?date= and falls back to the computed default", async () => {
    const res = await GET(
      req("http://localhost/api/cron/data-quality-scan?date=not-a-date", {
        authorization: "Bearer test-secret",
      }),
    );
    expect(res.status).toBe(200);
    expect(scanCalls[0].businessDate).not.toBe("not-a-date");
  });
});
