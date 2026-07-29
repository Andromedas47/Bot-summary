import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

const migration = new URL(
  "../../../../supabase/migrations/0055_guided_menu_seller_market_catalog.sql",
  import.meta.url,
);
const sql = await Bun.file(migration).text();
const code = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");
const canonicalLf = sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

describe("0055 migration — seller-market catalog", () => {
  it("creates private service-role catalogs with active foreign-key assignments", () => {
    expect(code).toContain("CREATE TABLE public.line_guided_menu_sellers");
    expect(code).toContain("CREATE TABLE public.line_guided_menu_seller_markets");
    expect(code).toContain("PRIMARY KEY (seller_code, market_code)");
    expect(code).toContain("REFERENCES public.line_guided_menu_sellers");
    expect(code).toContain("REFERENCES public.line_guided_menu_markets");
    expect(code).toContain(
      "ALTER TABLE public.line_guided_menu_sellers ENABLE ROW LEVEL SECURITY",
    );
    expect(code).toContain(
      "ALTER TABLE public.line_guided_menu_seller_markets ENABLE ROW LEVEL SECURITY",
    );
    expect(code).not.toMatch(/CREATE POLICY/i);
    expect(code).not.toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.line_guided_menu_/,
    );
  });

  it("requires exact seller-bound payloads and active seller-market rows", () => {
    expect(code).toContain("'choose_seller'");
    expect(code).toContain("ARRAY['seller_code', 'transaction_type']");
    expect(code).toContain(
      "ARRAY['market_code', 'seller_code', 'transaction_type']",
    );
    expect(code).toContain("NOT (payload ? 'seller_label')");
    expect(code).toContain("s.active IS TRUE");
    expect(code).toContain("sm.active IS TRUE");
    expect(code).toContain("m.active IS TRUE");
  });

  it("does not invent seller catalog rows", () => {
    expect(code).not.toMatch(
      /INSERT\s+INTO\s+public\.line_guided_menu_sellers/i,
    );
    expect(code).not.toMatch(
      /INSERT\s+INTO\s+public\.line_guided_menu_seller_markets/i,
    );
  });

  it("matches the reviewed canonical LF migration", () => {
    expect(createHash("sha256").update(canonicalLf, "utf8").digest("hex")).toBe(
      "8a556d5b20249c4e99b0b8b152ea792c548dc5b76f3088eafa0624ba0fd64cd4",
    );
    expect(Buffer.byteLength(canonicalLf, "utf8")).toBe(7681);
  });
});
