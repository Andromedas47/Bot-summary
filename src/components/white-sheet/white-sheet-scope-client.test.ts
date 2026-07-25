import { describe, expect, it } from "bun:test";
import {
  buildWhiteSheetMarketScopeOptions,
  whiteSheetMarketScopeKey,
} from "@/lib/white-sheet/market-scopes";
import {
  buildWhiteSheetLoadScope,
  fetchWhiteSheetMarketScopes,
} from "./white-sheet-scope-client";

const SOURCE = "Ccfac33c4e435ae95c5eaa04dbebff209";

const options = buildWhiteSheetMarketScopeOptions(
  [{ market_name: "ทดสอบเงินโอน", raw_message_id: "raw-1" }],
  new Map([["raw-1", SOURCE]]),
);

describe("buildWhiteSheetLoadScope", () => {
  it("resolves human-readable selection to source_id + market + date for the loader", () => {
    const result = buildWhiteSheetLoadScope({
      date: "2026-07-25",
      selectedKey: whiteSheetMarketScopeKey(SOURCE, "ทดสอบเงินโอน"),
      options,
    });
    expect(result).toEqual({
      ok: true,
      sourceId: SOURCE,
      market: "ทดสอบเงินโอน",
      date: "2026-07-25",
    });
  });

  it("does not leak a different market/source", () => {
    const other = buildWhiteSheetMarketScopeOptions(
      [{ market_name: "ตลาดน้อย", raw_message_id: "raw-2" }],
      new Map([["raw-2", "Cotherotherotherotherotherotheroth"]]),
    );
    const result = buildWhiteSheetLoadScope({
      date: "2026-07-25",
      selectedKey: whiteSheetMarketScopeKey(SOURCE, "ทดสอบเงินโอน"),
      options: other,
    });
    expect(result.ok).toBe(false);
  });

  it("fails visibly when no scopes or no selection", () => {
    expect(
      buildWhiteSheetLoadScope({
        date: "2026-07-25",
        selectedKey: "",
        options: [],
      }).ok,
    ).toBe(false);
    expect(
      buildWhiteSheetLoadScope({
        date: "2026-07-25",
        selectedKey: "",
        options,
      }).ok,
    ).toBe(false);
  });

  it("keeps advanced raw source_id path for troubleshooting", () => {
    const result = buildWhiteSheetLoadScope({
      date: "2026-07-25",
      selectedKey: "",
      options: [],
      useAdvancedSource: true,
      advancedSourceId: SOURCE,
      advancedMarket: "ทดสอบเงินโอน",
    });
    expect(result).toEqual({
      ok: true,
      sourceId: SOURCE,
      market: "ทดสอบเงินโอน",
      date: "2026-07-25",
    });
  });

  it("preserves canonical YYYY-MM-DD business_date", () => {
    const result = buildWhiteSheetLoadScope({
      date: "2026-07-25",
      selectedKey: whiteSheetMarketScopeKey(SOURCE, "ทดสอบเงินโอน"),
      options,
    });
    expect(result.ok && result.date).toBe("2026-07-25");
  });
});

describe("fetchWhiteSheetMarketScopes", () => {
  it("returns options from the scopes API", async () => {
    const result = await fetchWhiteSheetMarketScopes("2026-07-25", async () =>
      new Response(JSON.stringify({ options }), { status: 200 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options).toEqual(options);
  });

  it("surfaces API failures", async () => {
    const result = await fetchWhiteSheetMarketScopes("2026-07-25", async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );
    expect(result).toEqual({ ok: false, error: "boom" });
  });
});
