import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET } from "./route";

const originalSecret = process.env.CRON_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

function request(secret?: string): NextRequest {
  return new NextRequest(
    "http://localhost/api/cron/finalize-physical-inventory",
    {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    },
  );
}

describe("Physical Inventory finalizer cron authentication", () => {
  test("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(request())).status).toBe(500);
  });

  test("rejects an unauthenticated request", async () => {
    process.env.CRON_SECRET = "physical-secret";
    expect((await GET(request())).status).toBe(401);
  });
});
