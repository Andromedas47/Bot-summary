import { describe, expect, test } from "bun:test";
import {
  itemHasBlockingIdentity,
  normalizeRegistryText,
  resolvePriceUnitIdentity,
  resolveProductIdentity,
  resolveQuantityUnitIdentity,
  unresolvedPlaceholderKey,
} from "./identity";

const products = new Map([
  ["หมอนทอง", { raw_product_text: "หมอนทอง", product_key: "durian-monthong", active: true }],
]);

const units = new Map([
  ["โล", { raw_unit_text: "โล", unit_key: "kg", active: true }],
]);

describe("purchase intake identity resolution", () => {
  test("normalizes collapsed whitespace for registry lookup keys", () => {
    expect(normalizeRegistryText("  หมอนทอง  ")).toBe("หมอนทอง");
  });

  test("exact product resolution only", () => {
    const resolved = resolveProductIdentity("หมอนทอง", products);
    expect(resolved.productIdentityStatus).toBe("RESOLVED");
    expect(resolved.productKey).toBe("durian-monthong");
  });

  test("unknown product stays UNRESOLVED with deterministic placeholder", () => {
    const resolved = resolveProductIdentity("องุ่นเขียว", products);
    expect(resolved.productIdentityStatus).toBe("UNRESOLVED");
    expect(resolved.productKey).toBe(unresolvedPlaceholderKey("product", "องุ่นเขียว"));
  });

  test("NFC normalization alone never implies RESOLVED", () => {
    const resolved = resolveProductIdentity("หมอนทอง", new Map());
    expect(resolved.productIdentityStatus).toBe("UNRESOLVED");
  });

  test("exact quantity unit resolution", () => {
    const resolved = resolveQuantityUnitIdentity("โล", units);
    expect(resolved.unitIdentityStatus).toBe("RESOLVED");
    expect(resolved.unitKey).toBe("kg");
  });

  test("unknown quantity unit stays UNRESOLVED", () => {
    const resolved = resolveQuantityUnitIdentity("ตะกร้า", units);
    expect(resolved.unitIdentityStatus).toBe("UNRESOLVED");
  });

  test("price unit resolves when it matches quantity canonical unit", () => {
    const quantity = resolveQuantityUnitIdentity("โล", units);
    const price = resolvePriceUnitIdentity({
      priceUnitText: "โล",
      quantityUnit: quantity,
      units,
    });
    expect(price.priceUnitStatus).toBe("RESOLVED");
  });

  test("quantity/price canonical unit mismatch blocks", () => {
    const quantity = resolveQuantityUnitIdentity("โล", units);
    const unitsWithPiece = new Map([
      ...units,
      ["ชิ้น", { raw_unit_text: "ชิ้น", unit_key: "piece", active: true }],
    ]);
    const price = resolvePriceUnitIdentity({
      priceUnitText: "ชิ้น",
      quantityUnit: quantity,
      units: unitsWithPiece,
    });
    expect(price.priceUnitStatus).toBe("UNRESOLVED");
  });

  test("no implicit RESOLVED defaults in blocking checks", () => {
    expect(
      itemHasBlockingIdentity({
        productIdentityStatus: "UNRESOLVED",
        unitIdentityStatus: "RESOLVED",
        priceUnitStatus: "RESOLVED",
      }),
    ).toBe(true);
    expect(
      itemHasBlockingIdentity({
        productIdentityStatus: "RESOLVED",
        unitIdentityStatus: "UNRESOLVED",
        priceUnitStatus: "NOT_APPLICABLE",
      }),
    ).toBe(true);
  });
});
