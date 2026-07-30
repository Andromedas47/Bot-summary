import { describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "crypto";
import {
  encodeMenuToken,
  generateRawMenuToken,
  hashMenuToken,
  hashMenuTokenWire,
  MENU_TOKEN_MAX_WIRE_LENGTH,
  MENU_TOKEN_PREFIX,
  MENU_TOKEN_RAW_BYTES,
  parseMenuToken,
} from "./menu-token";
import {
  ttlMsForAction,
  validateMenuPayload,
} from "./menu-state-service";
import {
  MENU_TTL_MUTATING_MS,
  MENU_TTL_NAVIGATION_MS,
} from "./menu-state-types";

describe("0051 menu token", () => {
  it("generates 128-bit CSPRNG raw tokens and a valid wire form", () => {
    const raw = generateRawMenuToken(randomBytes);
    expect(raw.length).toBe(MENU_TOKEN_RAW_BYTES);
    const wire = encodeMenuToken(raw);
    expect(wire.startsWith(MENU_TOKEN_PREFIX)).toBe(true);
    expect(wire.length).toBeLessThanOrEqual(MENU_TOKEN_MAX_WIRE_LENGTH);
    expect(parseMenuToken(wire)).toEqual({ ok: true, raw });
  });

  it("hashes deterministically and never embeds business values", () => {
    const raw = Buffer.alloc(MENU_TOKEN_RAW_BYTES, 7);
    const a = hashMenuToken(raw);
    const b = hashMenuToken(raw);
    expect(a).toBe(b);
    expect(a).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(a).toHaveLength(64);
    const wire = encodeMenuToken(raw);
    expect(wire).not.toContain("withdraw");
    expect(wire).not.toContain("staff");
    expect(wire).not.toContain("market");
    expect(hashMenuTokenWire(wire)).toBe(a);
  });

  it("fails closed on malformed prefix, padding, whitespace, unicode, truncation, oversize, garbage", () => {
    const good = encodeMenuToken(Buffer.alloc(MENU_TOKEN_RAW_BYTES, 1));
    expect(parseMenuToken("").ok).toBe(false);
    expect(parseMenuToken("gpm2:aaaa").ok).toBe(false);
    expect(parseMenuToken(`${good}=`).ok).toBe(false);
    expect(parseMenuToken(` ${good}`).ok).toBe(false);
    expect(parseMenuToken(`${good} `).ok).toBe(false);
    expect(parseMenuToken("gpm1:โทเคน").ok).toBe(false);
    expect(parseMenuToken(good.slice(0, -1)).ok).toBe(false);
    expect(parseMenuToken(`${good}${"x".repeat(80)}`).ok).toBe(false);
    expect(parseMenuToken("gpm1:!!!not-base64!!!").ok).toBe(false);
    expect(parseMenuToken("totally-random-garbage").ok).toBe(false);
  });
});

describe("0051 menu payload + TTL", () => {
  it("accepts known short codes only and rejects trusted labels / free-form step", () => {
    expect(
      validateMenuPayload({
        transaction_type: "withdraw",
        market_code: "wat_thung_lanna",
        date_mode: "today",
      }),
    ).toEqual({
      transaction_type: "withdraw",
      market_code: "wat_thung_lanna",
      date_mode: "today",
    });

    expect(() =>
      validateMenuPayload({ staff_label: "พี่ดำ" } as never),
    ).toThrow(/trusted display labels/);
    expect(() =>
      validateMenuPayload({ market_label: "วิหาร" } as never),
    ).toThrow(/trusted display labels/);
    expect(() =>
      validateMenuPayload({ transaction_type: "เบิก" as never }),
    ).toThrow(/transaction_type/);
    expect(() =>
      validateMenuPayload({ step: "root" } as never),
    ).toThrow(/step/);
    expect(() =>
      validateMenuPayload({ mystery: "x" } as never),
    ).toThrow(/unknown payload key/);
  });

  it("uses 30m navigation TTL and 10m mutating TTL", () => {
    expect(ttlMsForAction("menu_root")).toBe(MENU_TTL_NAVIGATION_MS);
    expect(ttlMsForAction("choose_market")).toBe(MENU_TTL_NAVIGATION_MS);
    expect(ttlMsForAction("view_status")).toBe(MENU_TTL_NAVIGATION_MS);
    expect(ttlMsForAction("confirm_open")).toBe(MENU_TTL_MUTATING_MS);
    expect(ttlMsForAction("request_close")).toBe(MENU_TTL_MUTATING_MS);
    expect(ttlMsForAction("confirm_finalize")).toBe(MENU_TTL_MUTATING_MS);
  });
});
