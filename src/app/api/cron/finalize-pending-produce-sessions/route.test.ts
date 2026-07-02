import { afterEach, describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "./route";

const originalCronSecret = process.env.CRON_SECRET;

afterEach(() => {
  if (originalCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalCronSecret;
  }
});

function request(
  body: string,
  authorization?: string,
): NextRequest {
  return new NextRequest(
    "http://localhost/api/cron/finalize-pending-produce-sessions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body,
    },
  );
}

describe("produce notification operator resend authentication", () => {
  it("rejects an unauthenticated resend", async () => {
    process.env.CRON_SECRET = "operator-secret";

    const response = await POST(request(JSON.stringify({
      produceSessionId: "20000000-0000-4000-8000-000000000002",
    })));

    expect(response.status).toBe(401);
  });

  it("requires CRON_SECRET to be configured", async () => {
    delete process.env.CRON_SECRET;

    const response = await POST(request(JSON.stringify({
      produceSessionId: "20000000-0000-4000-8000-000000000002",
    })));

    expect(response.status).toBe(500);
  });

  it("validates the session id before accessing notification state", async () => {
    process.env.CRON_SECRET = "operator-secret";

    const response = await POST(request(
      JSON.stringify({ produceSessionId: "not-a-uuid" }),
      "Bearer operator-secret",
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "produceSessionId must be a UUID",
    });
  });
});
