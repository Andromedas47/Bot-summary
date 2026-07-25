import { describe, expect, test } from "bun:test";
import { stockCategoryFor, stockCategoryEntries } from "./stock-categories";

describe("stockCategoryFor", () => {
  test("maps durian varieties", () => {
    for (const name of ["หมอนทอง", "ก้านยาว", "ชะนี", "พวงมณี", "กระดุม", "หลงลับแล", "มูซังคิง"]) {
      expect(stockCategoryFor(name)).toBe("ทุเรียน");
    }
  });

  test("maps compound durian forms through the ทุเรียน marker", () => {
    for (const name of ["ทุเรียน", "ทุเรียนกล่อง", "ทุเรียนแกะ", "ทุเรียนหมอนทอง"]) {
      expect(stockCategoryFor(name)).toBe("ทุเรียน");
    }
  });

  test("ทุเรียนเทศ is soursop, not durian", () => {
    expect(stockCategoryFor("ทุเรียนเทศ")).toBe("ผลไม้");
  });

  test("maps fruit", () => {
    for (const name of ["มหาชนก", "กระท้อน", "แตงโม", "ลูกพลับ", "แก้วมังกร", "สับปะรด", "อะโวคาโด"]) {
      expect(stockCategoryFor(name)).toBe("ผลไม้");
    }
  });

  test("maps vegetables", () => {
    for (const name of ["กระชาย", "กะเพรา", "ผักชี", "ต้นหอม", "ถั่วพู", "กะหล่ำปี", "ใบมังลัก"]) {
      expect(stockCategoryFor(name)).toBe("ผัก");
    }
  });

  test("unknown products stay visible as ไม่จัดหมวด", () => {
    expect(stockCategoryFor("ของแปลกใหม่ไม่เคยเจอ")).toBe("ไม่จัดหมวด");
    expect(stockCategoryFor("")).toBe("ไม่จัดหมวด");
    expect(stockCategoryFor("   ")).toBe("ไม่จัดหมวด");
  });

  test("similar-looking names are not guessed into a category", () => {
    // Only exact canonical names (plus the durian marker) are mapped. A
    // misspelling that has no alias must surface as uncategorized rather than
    // being silently filed under a category it merely resembles.
    expect(stockCategoryFor("แตงโมมม")).toBe("ไม่จัดหมวด");
    expect(stockCategoryFor("กระชายย")).toBe("ไม่จัดหมวด");
  });

  test("mapping is normalized and free of duplicate keys", () => {
    const entries = stockCategoryEntries();
    const keys = entries.map(([name]) => name);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toBe(key.normalize("NFC").trim());
      expect(key.length).toBeGreaterThan(0);
    }
  });
});
