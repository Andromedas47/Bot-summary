import { describe, expect, it } from "bun:test";
import { memSupabase } from "@/lib/test-utils/mem-supabase";
import { hasV2WorkRoundForSettlement } from "./route";

describe("settlement legacy API guard", () => {
  it("detects V2 Work Rounds so source/date legacy finalization can be blocked", async () => {
    const db = memSupabase({
      work_rounds: [
        { id: "wr-a", source_id: "group-1", business_date: "2026-06-24" },
      ],
    });

    expect(await hasV2WorkRoundForSettlement(db as never, "group-1", "2026-06-24")).toBe(true);
    expect(await hasV2WorkRoundForSettlement(db as never, "group-1", "2026-06-25")).toBe(false);
  });
});
