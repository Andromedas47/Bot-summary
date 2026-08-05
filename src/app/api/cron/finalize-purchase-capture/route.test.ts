import { afterEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

const originalSecret = process.env.CRON_SECRET;

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => ({}),
}));

const sweepMock = mock(async () => ({
  due: 0,
  awaitingConfirmation: 0,
  failedClosed: 0,
  pending: 0,
  skipped: 0,
  errors: 0,
}));

mock.module("@/lib/purchase-capture/finalization-sweep", () => ({
  sweepPurchaseCaptureFinalization: sweepMock,
}));

const { GET } = await import("./route");

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  sweepMock.mockClear();
});

function request(secret?: string): NextRequest {
  return new NextRequest(
    "http://localhost/api/cron/finalize-purchase-capture",
    {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    },
  );
}

describe("Purchase Capture finalization cron", () => {
  test("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(request())).status).toBe(500);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  test("rejects an unauthenticated request", async () => {
    process.env.CRON_SECRET = "purchase-capture-secret";
    expect((await GET(request())).status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  test("authenticated zero-work request returns Slice B result shape", async () => {
    process.env.CRON_SECRET = "purchase-capture-secret";
    const response = await GET(request("purchase-capture-secret"));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.due).toBe(0);
    expect(body.awaitingConfirmation).toBe(0);
    expect(body.failedClosed).toBe(0);
    expect(body.pending).toBe(0);
    expect(body.skipped).toBe(0);
    expect(body.errors).toBe(0);
    expect(typeof body.triggeredAt).toBe("string");
    expect(sweepMock).toHaveBeenCalledTimes(1);
  });
});
