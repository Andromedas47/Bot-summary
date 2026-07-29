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
const seedCode = code.split("ALTER TABLE public.line_menu_states")[0];

describe("0055 migration — seller-market catalog", () => {
  it("creates private service-role catalogs with aliases and active assignments", () => {
    expect(code).toContain("CREATE TABLE public.line_guided_menu_sellers");
    expect(code).toContain("CREATE TABLE public.line_guided_menu_seller_aliases");
    expect(code).toContain("CREATE TABLE public.line_guided_menu_market_aliases");
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
    expect(code).toContain(
      "ALTER TABLE public.line_guided_menu_seller_aliases ENABLE ROW LEVEL SECURITY",
    );
    expect(code).toContain(
      "ALTER TABLE public.line_guided_menu_market_aliases ENABLE ROW LEVEL SECURITY",
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

  it("seeds only the approved canonical sellers and seller aliases", () => {
    expect(code).toContain("('ki', 'กี้', true, 10)");
    expect(code).toContain("('กี่', 'ki', true)");
    expect(code).toContain("('โอ', 'ohm', true)");
    expect(code).toContain("('ดำ', 'phi_dam', true)");
    expect(code).not.toContain("'ป้าลีนาง'");
  });

  it("keeps Pasio categories distinct and ambiguous labels unseeded", () => {
    expect(code).toContain("('paseo_durian', 'พาซิโอ้ทุเรียน', true)");
    expect(code).toContain("('paseo_vegetable', 'พาซิโอ้ผัก', true)");
    expect(code).toContain("('paseo_fruit', 'พาซิโอ้ผลไม้', true)");
    expect(code).not.toMatch(/\('พาสิโอ้',\s*'/);
    expect(code).not.toMatch(/\('(ผัก|ผลไม้|ทุเรียน)',\s*'/);
  });

  it("applies approved market corrections and supports multiple active markets", () => {
    expect(code).toContain("('ทรัพย์พัน2', 'sap_phun', true)");
    expect(code).toContain("DELETE FROM public.line_guided_menu_markets");
    expect(code).toContain("WHERE market_code = 'kee'");
    expect(code).not.toContain("('kee', 'ตลาดกี้'");
    expect(code).toContain("('ki', 'wat_thung_lanna', true, 10)");
    expect(code).toContain("('tom', 'paseo_vegetable', true, 10)");
    expect(code).toContain("('tom', 'paseo_durian', true, 20)");
    expect(code).toContain("('tom', 'paseo_fruit', true, 30)");
    expect(code).not.toContain("'วิหารหลวงปู่โต'");
    expect(code).not.toContain("'ทรัพย์เจริญ'");
  });

  it("uses guarded upserts for deterministic idempotent seed DML", () => {
    expect(seedCode.match(/ON CONFLICT/g)).toHaveLength(5);
    expect(seedCode.match(/IS DISTINCT FROM/g)).toHaveLength(5);
  });

  it("matches the reviewed canonical LF migration", () => {
    expect(createHash("sha256").update(canonicalLf, "utf8").digest("hex")).toBe(
      "2e839eb5ca147bbf8fce2e7cf44aaaec6c1451fe50c12bb11bac9b50c419f4fa",
    );
    expect(Buffer.byteLength(canonicalLf, "utf8")).toBe(15804);
  });
});
