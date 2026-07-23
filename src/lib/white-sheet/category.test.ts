import { describe, expect, test } from "bun:test";
import { classifyProduct } from "./category";

describe("classifyProduct", () => {
  test("classifies durian before other product rules", () => {
    expect(classifyProduct("ทุเรียนหมอนทอง")).toBe("durian");
    expect(classifyProduct("ทุเรียนกล่อง")).toBe("durian");
  });

  test("classifies explicit fruit keywords", () => {
    expect(classifyProduct("แตงโม")).toBe("fruit");
    expect(classifyProduct("แก้วมังกร")).toBe("fruit");
    expect(classifyProduct("แอปเปิ้ลแดง")).toBe("fruit");
  });

  test("classifies explicit vegetable keywords after existing name normalization", () => {
    expect(classifyProduct("ผักกาดขาว")).toBe("vegetable");
    expect(classifyProduct("เพิ่มถั่วพู")).toBe("vegetable");
    expect(classifyProduct("ใบมังลัก")).toBe("vegetable");
  });

  test("does not guess ambiguous or unknown products", () => {
    expect(classifyProduct("หมอนทอง")).toBe("uncategorized");
    expect(classifyProduct("ปลาทูเค็ม")).toBe("uncategorized");
  });
});
