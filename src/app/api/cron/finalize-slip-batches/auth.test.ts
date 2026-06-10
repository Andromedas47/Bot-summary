import { describe, expect, it } from "bun:test";
import { checkCronAuth } from "./auth";

describe("finalize-slip-batches authentication", () => {
  it("reports a missing CRON_SECRET", () => {
    expect(checkCronAuth(undefined, null, null)).toEqual({
      authorized: false,
      secretConfigured: false,
      authHeaderPresent: false,
      headerTypeUsed: "none",
    });
  });

  it("reports x-cron-secret as unsupported", () => {
    expect(checkCronAuth("expected-secret", null, "expected-secret")).toEqual({
      authorized: false,
      secretConfigured: true,
      authHeaderPresent: false,
      headerTypeUsed: "x-cron-secret-unsupported",
    });
  });

  it("rejects a mismatched Bearer token", () => {
    expect(
      checkCronAuth("expected-secret", "Bearer wrong-secret", null),
    ).toMatchObject({
      authorized: false,
      secretConfigured: true,
      authHeaderPresent: true,
      headerTypeUsed: "authorization-bearer",
    });
  });

  it("rejects a non-Bearer Authorization header", () => {
    expect(
      checkCronAuth("expected-secret", "Basic expected-secret", null),
    ).toMatchObject({
      authorized: false,
      authHeaderPresent: true,
      headerTypeUsed: "authorization-other",
    });
  });

  it("accepts a trimmed, case-insensitive Bearer scheme", () => {
    expect(
      checkCronAuth("expected-secret", "  bearer   expected-secret  ", null),
    ).toMatchObject({
      authorized: true,
      secretConfigured: true,
      authHeaderPresent: true,
      headerTypeUsed: "authorization-bearer",
    });
  });
});
