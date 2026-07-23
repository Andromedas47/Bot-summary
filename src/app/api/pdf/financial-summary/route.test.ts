import { describe, expect, test, mock } from "bun:test";
import { NextRequest } from "next/server";

type QueryResult = { data: unknown[] | null; error: { message: string } | null };

function chain(result: QueryResult): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.select = self;
  node.gte = self;
  node.lt = self;
  node.in = self;
  node.range = () => Promise.resolve(result);
  node.then = (resolve: (value: QueryResult) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return node;
}

const supabase = {
  from(table: string) {
    if (table === "produce_transactions" || table === "settlement_entries") {
      return chain({ data: [], error: null });
    }
    throw new Error(`Unexpected table: ${table}`);
  },
};

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => supabase,
}));

const { GET } = await import("./route");

describe("GET /api/pdf/financial-summary", () => {
  test("returns an attachment header that safely encodes the Thai filename", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/pdf/financial-summary?month=2026-07"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");

    const disposition = response.headers.get("Content-Disposition");
    const filename = "สรุปการเงิน-2026-07.pdf";

    expect(disposition).toBe(
      `attachment; filename="-2026-07.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    expect(disposition).not.toMatch(/[\u0E00-\u0E7F]/);
  });
});
