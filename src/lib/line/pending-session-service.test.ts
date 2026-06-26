import { describe, expect, it } from "bun:test";
import { PendingSessionService, rebuildPendingSessionText } from "./pending-session-service";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";

function rawRow(
  eventId: string,
  text: string,
  timestamp: number,
  createdOffset: number,
) {
  return {
    line_event_id: eventId,
    raw_text: text,
    payload: { timestamp },
    created_at: new Date(Date.UTC(2026, 5, 10, 8, 0, 0) + createdOffset).toISOString(),
  };
}

function total(items: ReturnType<typeof parseWeighSession>["items"]): number {
  return items.reduce(
    (sum, item) => sum + item.price_per_unit * (item.quantity ?? 0),
    0,
  );
}

describe("produce pending-session finalization ordering", () => {
  const header = "น้อย-วัดตะกล่ำ เบิก 10/6/2569";

  it("rebuilds header + 13 item messages + end into all 13 saved items", () => {
    const productNames = [
      "แตงโม",
      "มะละกอ",
      "ภูเขาไฟ",
      "แก้วแดง",
      "หมอนทอง",
      "ชะนี",
      "กระดุม",
      "ก้านยาว",
      "กระท้อน",
      "ส้ม",
      "แอปเปิ้ล",
      "แตงไทย",
    ];
    const itemMessages = Array.from({ length: 13 }, (_, index) => {
      const itemNumber = index + 1;
      if (itemNumber === 13) {
        return `${itemNumber}.แก้วแดง100บาท\n223.716โล`;
      }
      return `${itemNumber}.${productNames[index]}${itemNumber * 10}บาท\n${itemNumber}โล`;
    });
    const end = "จบรายการเบิก";
    const rows = [
      rawRow("end", end, 30, 30),
      ...itemMessages.map((text, index) =>
        rawRow(`item-${index + 1}`, text, index + 2, index + 2),
      ),
      rawRow("header", header, 1, 1),
    ];

    const rebuilt = rebuildPendingSessionText(header, rows, 30);
    const parsed = parseWeighSession(rebuilt, "2026-06-10");

    expect(parsed.items).toHaveLength(13);
    expect(total(parsed.items)).toBeCloseTo(28871.6, 6);
  });

  it("keeps slowly processed active-session messages available until explicit end", () => {
    const rows = [
      rawRow("header", header, 1, 1),
      rawRow("item-1", "1.แตงโม10บาท\n2โล", 2, 31 * 60 * 1000),
      rawRow("end", "จบรายการเบิก", 3, 32 * 60 * 1000),
    ];

    const rebuilt = rebuildPendingSessionText(header, rows, 3);
    const parsed = parseWeighSession(rebuilt, "2026-06-10");

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].product_name).toBe("แตงโม");
  });

  it("orders concurrent raw events by LINE timestamp without losing items", () => {
    const rows = [
      rawRow("item-3", "3.ภูเขาไฟ30บาท\n3โล", 4, 1),
      rawRow("item-1", "1.แตงโม10บาท\n1โล", 2, 4),
      rawRow("header", header, 1, 3),
      rawRow("item-2", "2.มะละกอ20บาท\n2โล", 3, 2),
      rawRow("end", "จบรายการเบิก", 5, 0),
    ];

    const parsed = parseWeighSession(
      rebuildPendingSessionText(header, rows, 5),
      "2026-06-10",
    );

    expect(parsed.items.map((item) => item.item_number)).toEqual([1, 2, 3]);
  });

  it("places the end command after all earlier events even when it arrives first", () => {
    const rows = [
      rawRow("end", "จบรายการเบิก", 4, 1),
      rawRow("item-2", "2.มะละกอ20บาท\n2โล", 3, 4),
      rawRow("header", header, 1, 3),
      rawRow("item-1", "1.แตงโม10บาท\n1โล", 2, 2),
    ];

    const rebuilt = rebuildPendingSessionText(header, rows, 4);

    expect(rebuilt.split("\n").at(-1)).toBe("จบรายการเบิก");
    expect(parseWeighSession(rebuilt).items).toHaveLength(2);
  });

  it("starts from the latest matching header when a prior session reused the same header", () => {
    const rows = [
      rawRow("old-header", header, 1, 1),
      rawRow("old-item", "1.ของเก่า10บาท\n99โล", 2, 2),
      rawRow("old-end", "จบรายการเบิก", 3, 3),
      rawRow("header", header, 4, 4),
      rawRow("item", "1.แตงโม10บาท\n1โล", 5, 5),
      rawRow("end", "จบรายการเบิก", 6, 6),
    ];

    const parsed = parseWeighSession(
      rebuildPendingSessionText(header, rows, 6),
      "2026-06-10",
    );

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].product_name).toBe("แตงโม");
  });

  it("reports an unrecognized raw line without dropping unrelated valid items", () => {
    const rows = [
      rawRow("header", header, 1, 1),
      rawRow("item-1", "1.แตงโม10บาท\n1โล", 2, 2),
      rawRow("bad", "ข้อความที่อ่านไม่ได้", 3, 3),
      rawRow("item-2", "2.มะละกอ20บาท\n2โล", 4, 4),
      rawRow("end", "จบรายการเบิก", 5, 5),
    ];

    const parsed = parseWeighSession(
      rebuildPendingSessionText(header, rows, 5),
      "2026-06-10",
    );

    expect(parsed.items).toHaveLength(2);
    expect(parsed.parse_errors).toContain(
      'unrecognized line: "ข้อความที่อ่านไม่ได้"',
    );
  });
});

describe("PendingSessionService.append", () => {
  it("fails visibly when append_pending_session RPC is unavailable", async () => {
    const writes: unknown[] = [];
    const service = new PendingSessionService({
      from() {
        writes.push("from-called");
        return {
          upsert() {
            writes.push("upsert-called");
            return Promise.resolve({ error: null });
          },
        };
      },
    } as never);

    await expect(service.append("group-1", "1.มะม่วง100บาท", "reply-1")).rejects.toThrow(
      "append_pending_session RPC unavailable",
    );
    expect(writes).toEqual([]);
  });

  it("does not fall back to read-modify-write when append_pending_session RPC fails", async () => {
    const writes: unknown[] = [];
    const service = new PendingSessionService({
      rpc: async () => ({ data: null, error: { message: "rpc down" } }),
      from() {
        writes.push("from-called");
        return {
          upsert() {
            writes.push("upsert-called");
            return Promise.resolve({ error: null });
          },
        };
      },
    } as never);

    await expect(service.append("group-1", "1.มะม่วง100บาท", "reply-1")).rejects.toThrow(
      "pending session append failed: rpc down",
    );
    expect(writes).toEqual([]);
  });
});
