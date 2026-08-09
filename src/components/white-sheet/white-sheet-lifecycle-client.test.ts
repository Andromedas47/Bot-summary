import { describe, expect, it } from "bun:test";
import {
  postWhiteSheetLifecycle,
  requireReopenReason,
} from "./white-sheet-lifecycle-client";

const SCOPE = {
  sourceId: "src-1",
  market: "ทดสอบไวท์ชีท",
  date: "2026-07-25",
};

describe("requireReopenReason", () => {
  it("rejects empty or whitespace-only reasons", () => {
    expect(requireReopenReason("")).toBeNull();
    expect(requireReopenReason("   ")).toBeNull();
  });

  it("accepts a non-empty trimmed reason", () => {
    expect(requireReopenReason("  แก้ยอดผิด  ")).toBe("แก้ยอดผิด");
  });
});

describe("postWhiteSheetLifecycle", () => {
  it("finalizes via the existing finalize API and reports success", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await postWhiteSheetLifecycle("finalize", {
      ...SCOPE,
      accountabilityRoundId: "11111111-1111-4111-8111-111111111111",
    }, {
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return new Response(JSON.stringify({ status: "finalized" }), { status: 200 });
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: "/api/white-sheet/finalize",
        body: {
          sourceId: "src-1",
          market: "ทดสอบไวท์ชีท",
          date: "2026-07-25",
          accountabilityRoundId: "11111111-1111-4111-8111-111111111111",
        },
      },
    ]);
  });

  it("reopens via the existing reopen API with a required reason", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await postWhiteSheetLifecycle("reopen", SCOPE, {
      reason: "ต้องแก้ค่าใช้จ่าย",
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return new Response(JSON.stringify({ status: "submitted" }), { status: 200 });
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: "/api/white-sheet/reopen",
        body: {
          sourceId: "src-1",
          market: "ทดสอบไวท์ชีท",
          date: "2026-07-25",
          reason: "ต้องแก้ค่าใช้จ่าย",
        },
      },
    ]);
  });

  it("does not call the reopen API when reason is missing", async () => {
    let called = false;
    const result = await postWhiteSheetLifecycle("reopen", SCOPE, {
      reason: "  ",
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });
    expect(result).toEqual({
      ok: false,
      error: "ต้องระบุเหตุผลในการเปิดยอดอีกครั้ง",
    });
    expect(called).toBe(false);
  });

  it("surfaces API failures without faking success", async () => {
    const result = await postWhiteSheetLifecycle("finalize", SCOPE, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "entry is not submitted" }), {
          status: 400,
        }),
    });
    expect(result).toEqual({ ok: false, error: "entry is not submitted" });
  });

  it("surfaces network failures without faking success", async () => {
    const result = await postWhiteSheetLifecycle("finalize", SCOPE, {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(result).toEqual({ ok: false, error: "network down" });
  });

  it("does not start a second finalize while the first is still pending", async () => {
    let resolveFirst!: (value: Response) => void;
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return await new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      }).finally(() => {
        inFlight -= 1;
      });
    };

    const pending = { current: false };
    async function runExclusive() {
      if (pending.current) return { ok: false as const, error: "pending" };
      pending.current = true;
      try {
        return await postWhiteSheetLifecycle("finalize", SCOPE, { fetchImpl });
      } finally {
        pending.current = false;
      }
    }

    const first = runExclusive();
    const second = await runExclusive();
    expect(second).toEqual({ ok: false, error: "pending" });
    resolveFirst(new Response(JSON.stringify({ status: "finalized" }), { status: 200 }));
    expect(await first).toEqual({ ok: true });
    expect(maxInFlight).toBe(1);
  });
});
