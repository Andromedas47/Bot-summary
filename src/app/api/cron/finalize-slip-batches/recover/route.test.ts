import { afterEach, describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import * as routeModule from "./route";

const originalCronSecret = process.env.CRON_SECRET;

afterEach(() => {
  if (originalCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalCronSecret;
  }
});

describe("slip recovery route module", () => {
  it("exports only supported Next.js route fields", () => {
    expect(Object.keys(routeModule).sort()).toEqual([
      "POST",
      "dynamic",
      "runtime",
    ]);
  });

  it("preserves authenticated request validation through POST", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const response = await routeModule.POST(new NextRequest(
      "http://localhost/api/cron/finalize-slip-batches/recover",
      {
        method: "POST",
        headers: {
          authorization: "Bearer cron-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ batch_id: "not-a-uuid" }),
      },
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      result: "invalid_batch_id",
      error: "batch_id must be a valid UUID",
    });
  });
  it("delegates POST requests to the recovery handler", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const response = await routeModule.POST(new NextRequest(
      "http://localhost/api/cron/finalize-slip-batches/recover",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          batch_id: "123e4567-e89b-12d3-a456-426614174000",
        }),
      },
    ));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
