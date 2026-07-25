import { describe, expect, it } from "bun:test";
import { postVoidProduceSession, requireVoidReason } from "./void-session-client";

describe("requireVoidReason", () => {
  it("blocks empty reason client-side", () => {
    expect(requireVoidReason("")).toBeNull();
    expect(requireVoidReason("   ")).toBeNull();
    expect(requireVoidReason("UAT void")).toBe("UAT void");
  });
});

describe("postVoidProduceSession", () => {
  it("calls existing API with exact sessionId + reason", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await postVoidProduceSession(
      { sessionId: "sess-1", reason: "  UAT void  " },
      async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({
            sessionId: "sess-1",
            voidedAt: "2026-07-25T10:00:00.000Z",
            voidedBy: "admin-1",
            voidReason: "UAT void",
            replacementSessionId: null,
          }),
          { status: 200 },
        );
      },
    );

    expect(calls).toEqual([
      {
        url: "/api/admin/void-session",
        body: { sessionId: "sess-1", reason: "UAT void" },
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("does not show fake success on API failure", async () => {
    const result = await postVoidProduceSession(
      { sessionId: "sess-1", reason: "oops" },
      async () =>
        new Response(JSON.stringify({ error: "Admin authorization is required" }), {
          status: 403,
        }),
    );
    expect(result).toEqual({
      ok: false,
      error: "Admin authorization is required",
    });
  });

  it("blocks empty reason without calling the API", async () => {
    let called = false;
    const result = await postVoidProduceSession(
      { sessionId: "sess-1", reason: "  " },
      async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    );
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });
});
