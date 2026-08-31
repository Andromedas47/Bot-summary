import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

const additiveFile = new URL(
  "../../../../supabase/migrations/20260730090006_guided_menu_seller_market_catalog.sql",
  import.meta.url,
);
const strictFile = new URL(
  "../../../../supabase/migrations/20260730090937_guided_menu_seller_catalog_strict_cleanup.sql",
  import.meta.url,
);
const additive = await Bun.file(additiveFile).text();
const strict = await Bun.file(strictFile).text();
const canonical = (sql: string) =>
  sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const seedStart = additive.indexOf("-- BEGIN REVIEWED CATALOG SEEDS");
const seedEnd = additive.indexOf("-- END REVIEWED CATALOG SEEDS");
const seeds = additive.slice(seedStart, seedEnd);

describe("0055 additive + 0056 strict Guided Menu catalog rollout", () => {
  it("creates private seller catalogs and preserves legacy compatibility", () => {
    expect(additive).toContain("CREATE TABLE public.line_guided_menu_sellers");
    expect(additive).toContain(
      "CREATE TABLE public.line_guided_menu_seller_aliases",
    );
    expect(additive).toContain(
      "CREATE TABLE public.line_guided_menu_market_aliases",
    );
    expect(additive).toContain(
      "CREATE TABLE public.line_guided_menu_seller_markets",
    );
    expect(additive).toContain(
      "v_keys = ARRAY['market_code', 'transaction_type']",
    );
    expect(additive).not.toMatch(
      /DELETE FROM public\.line_guided_menu_markets/,
    );
    expect(additive).toContain(
      "ALTER TABLE public.line_guided_menu_sellers ENABLE ROW LEVEL SECURITY",
    );
    expect(additive).not.toMatch(/CREATE POLICY/i);
  });

  it("revalidates current payload before update and same-event replay", () => {
    const validation = additive.indexOf(
      "IF NOT public.guided_menu_payload_valid(",
    );
    const replay = additive.indexOf("IF v_row.consumed_at IS NOT NULL");
    const update = additive.indexOf("UPDATE public.line_menu_states");
    expect(validation).toBeGreaterThan(0);
    expect(validation).toBeLessThan(replay);
    expect(validation).toBeLessThan(update);
    expect(additive).toContain(
      "RETURN jsonb_build_object('status', 'invalid_or_expired')",
    );
  });

  it("uses insert-if-missing seeds that abort rather than overwrite drift", () => {
    expect(seeds.match(/ON CONFLICT/g)).toHaveLength(5);
    expect(seeds.match(/DO NOTHING/g)).toHaveLength(5);
    expect(seeds).not.toMatch(/ON CONFLICT[\s\S]*?DO UPDATE/);
    expect(seeds).toContain("reviewed seller baseline drift");
    expect(seeds).toContain("reviewed market baseline drift");
    expect(seeds).toContain("reviewed seller alias baseline drift");
    expect(seeds).toContain("reviewed market alias baseline drift");
    expect(seeds).toContain("reviewed seller-market baseline drift");
  });

  it("seeds approved identities and keeps rejected labels absent", () => {
    expect(seeds).toContain("('ki', 'กี้', true, 10)");
    expect(seeds).toContain("('กี่', 'ki', true)");
    expect(seeds).toContain("('โอ', 'ohm', true)");
    expect(seeds).toContain("('ดำ', 'phi_dam', true)");
    expect(seeds).toContain("('ทรัพย์พัน2', 'sap_phun', true)");
    expect(seeds).toContain("('ki', 'wat_thung_lanna', true, 10)");
    expect(seeds).toContain("('tom', 'paseo_vegetable', true, 10)");
    expect(seeds).toContain("('tom', 'paseo_durian', true, 20)");
    expect(seeds).toContain("('tom', 'paseo_fruit', true, 30)");
    expect(seeds).not.toContain("ป้าลีนาง");
    expect(seeds).not.toMatch(/\('พาสิโอ้',\s*'/);
    expect(seeds).not.toMatch(/\('(ผัก|ผลไม้|ทุเรียน)',\s*'/);
    expect(seeds).not.toContain("วิหารหลวงปู่โต");
    expect(seeds).not.toContain("ทรัพย์เจริญ");
  });

  it("strict migration blocks legacy states and guards malformed-market cleanup", () => {
    expect(strict).toContain(
      "unexpired legacy seller-less Guided Menu states remain",
    );
    expect(strict).toContain(
      "kee/ตลาดกี้ differs from the original 0051 baseline",
    );
    expect(strict).toContain("unexpected foreign-key dependency");
    expect(strict).toContain(
      "DELETE FROM public.line_guided_menu_markets",
    );
    expect(strict).toContain("GET DIAGNOSTICS v_deleted = ROW_COUNT");
    expect(strict).toContain(
      "an unexpired Guided Menu state is invalid under strict catalog rules",
    );
    expect(strict).not.toContain(
      "v_keys = ARRAY['market_code', 'transaction_type']",
    );
  });

  it("matches canonical LF checksums and byte counts", () => {
    const additiveLf = canonical(additive);
    const strictLf = canonical(strict);
    expect(createHash("sha256").update(additiveLf).digest("hex")).toBe(
      "de3d9af9c929a518367d1662d4d4a127961698ef73c3880194bc16e28ad90bec",
    );
    expect(Buffer.byteLength(additiveLf)).toBe(23350);
    expect(createHash("sha256").update(strictLf).digest("hex")).toBe(
      "69e964c0e1dcb3310d669a39de9accd1f74bc37cc82cb63969c2c3eb2ad89207",
    );
    expect(Buffer.byteLength(strictLf)).toBe(8019);
  });
});
