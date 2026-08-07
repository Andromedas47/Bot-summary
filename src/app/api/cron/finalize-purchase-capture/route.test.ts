import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

const originalSecret = process.env.CRON_SECRET;
const originalCronEnabled = process.env.PURCHASE_CAPTURE_CRON_ENABLED;

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
  confirmingDue: 0,
  confirmingResumed: 0,
  confirmingRefused: 0,
  postedSuccessDelivered: 0,
}));

mock.module("@/lib/purchase-capture/finalization-sweep", () => ({
  sweepPurchaseCaptureFinalization: sweepMock,
}));

const { GET } = await import("./route");

beforeEach(() => {
  // Every test opts into whichever flag state it needs explicitly; nothing
  // leaks in from a previous test or the outer environment.
  delete process.env.CRON_SECRET;
  delete process.env.PURCHASE_CAPTURE_CRON_ENABLED;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  if (originalCronEnabled === undefined) delete process.env.PURCHASE_CAPTURE_CRON_ENABLED;
  else process.env.PURCHASE_CAPTURE_CRON_ENABLED = originalCronEnabled;
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
    // Auth must be checked before the feature flag — an unauthenticated
    // request is rejected regardless of PURCHASE_CAPTURE_CRON_ENABLED.
    process.env.PURCHASE_CAPTURE_CRON_ENABLED = "true";
    expect((await GET(request())).status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  test("authenticated zero-work request returns Slice B/C4 result shape when the flag is enabled", async () => {
    process.env.CRON_SECRET = "purchase-capture-secret";
    process.env.PURCHASE_CAPTURE_CRON_ENABLED = "true";
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
    expect(body.confirmingDue).toBe(0);
    expect(body.confirmingResumed).toBe(0);
    expect(body.confirmingRefused).toBe(0);
    expect(body.postedSuccessDelivered).toBe(0);
    expect(typeof body.triggeredAt).toBe("string");
    expect(sweepMock).toHaveBeenCalledTimes(1);
  });

  test("returns a 500 and does not swallow the error when the sweep throws", async () => {
    process.env.CRON_SECRET = "purchase-capture-secret";
    process.env.PURCHASE_CAPTURE_CRON_ENABLED = "true";
    sweepMock.mockImplementationOnce(async () => {
      throw new Error("sweep exploded");
    });
    const response = await GET(request("purchase-capture-secret"));
    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe("sweep exploded");
  });

  test("flag absent -> 200 disabled, sweep never called", async () => {
    process.env.CRON_SECRET = "purchase-capture-secret";
    delete process.env.PURCHASE_CAPTURE_CRON_ENABLED;
    const response = await GET(request("purchase-capture-secret"));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.disabled).toBe(true);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  test('flag "false" -> 200 disabled, sweep never called', async () => {
    process.env.CRON_SECRET = "purchase-capture-secret";
    process.env.PURCHASE_CAPTURE_CRON_ENABLED = "false";
    const response = await GET(request("purchase-capture-secret"));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.disabled).toBe(true);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  test('flag "true" -> sweep runs', async () => {
    process.env.CRON_SECRET = "purchase-capture-secret";
    process.env.PURCHASE_CAPTURE_CRON_ENABLED = "true";
    const response = await GET(request("purchase-capture-secret"));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.disabled).toBeUndefined();
    expect(sweepMock).toHaveBeenCalledTimes(1);
  });
});
