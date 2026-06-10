import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SlipCheckService } from "@/lib/slips/check-service";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import type { Database } from "@/types/database";

function createFakeSupabase() {
  const insertedChecks: Array<Record<string, unknown>> = [];
  const updatedChecks: Array<Record<string, unknown>> = [];
  const downloads: Array<{ bucket: string; path: string }> = [];

  const client = {
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            downloads.push({ bucket, path });
            return {
              data: new Blob([new Uint8Array([1, 2, 3])]),
              error: null,
            };
          },
        };
      },
    },
    from(table: string) {
      if (table === "slip_evidences") {
        return {
          select() {
            return {
              eq() {
                return {
                  async single() {
                    return {
                      data: {
                        id: "evidence-1",
                        source_id: "group-1",
                        storage_bucket: "slip-evidence",
                        storage_path: "slips/2026-06-06/group-1/message.jpg",
                        mime_type: "image/jpeg",
                        status: "RECEIVED",
                        batch_id: null,
                      },
                      error: null,
                    };
                  },
                  async maybeSingle() {
                    return { data: { source_id: "group-1" }, error: null };
                  },
                };
              },
            };
          },
        };
      }

      if (table === "slip_checks") {
        return {
          upsert(row: Record<string, unknown>) {
            insertedChecks.push(row);
            return {
              select() {
                return {
                  async single() {
                    return { data: { id: "check-1" }, error: null };
                  },
                };
              },
            };
          },
          update(row: Record<string, unknown>) {
            updatedChecks.push(row);
            return {
              async eq() {
                return { error: null };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { client, insertedChecks, updatedChecks, downloads };
}

const extraction: SlipExtraction = {
  slipType: "BANK_SLIP_NO_QR",
  grossAmount: null,
  discountAmount: null,
  paidAmount: null,
  transferAmount: 315,
  referenceId: "004999",
  transactionTime: "2026-06-06T01:35:00.000Z",
  senderName: "ผู้โอน",
  receiverName: "ร้านรับเงิน",
  receiverAccountTail: "1234",
  confidence: 0.94,
};

describe("SlipCheckService", () => {
  it("creates one check, extracts private evidence, saves fields, and pushes a summary", async () => {
    const fake = createFakeSupabase();
    const extractorInputs: Array<{ bytes: number[]; mimeType: string }> = [];
    const pushes: Array<{ to: string; text: string }> = [];
    const service = new SlipCheckService(
      fake.client,
      {
        async extract(input) {
          extractorInputs.push({
            bytes: Array.from(input.bytes),
            mimeType: input.mimeType,
          });
          return extraction;
        },
      },
      async (to, text) => {
        pushes.push({ to, text });
      },
    );

    await service.processEvidence("evidence-1");

    expect(fake.insertedChecks).toEqual([{
      evidence_id: "evidence-1",
      status: "PROCESSING",
      slip_type: "UNKNOWN",
      failure_reason: null,
    }]);
    expect(fake.downloads).toEqual([{
      bucket: "slip-evidence",
      path: "slips/2026-06-06/group-1/message.jpg",
    }]);
    expect(extractorInputs).toEqual([{
      bytes: [1, 2, 3],
      mimeType: "image/jpeg",
    }]);
    expect(fake.updatedChecks[0]).toMatchObject({
      status: "EXTRACTED",
      slip_type: "BANK_SLIP_NO_QR",
      transfer_amount: 315,
      reference_id: "004999",
      receiver_account_tail: "1234",
      confidence: 0.94,
      failure_reason: null,
    });
    expect(pushes).toHaveLength(1);
    expect(pushes[0].to).toBe("group-1");
    expect(pushes[0].text).toContain("ยอดโอน 315 บาท");
  });

  it("keeps an extracted check when the LINE push fails", async () => {
    const fake = createFakeSupabase();
    const service = new SlipCheckService(
      fake.client,
      { async extract() { return extraction; } },
      async () => {
        throw new Error("LINE push HTTP 500");
      },
    );

    await expect(service.processEvidence("evidence-1")).resolves.toBeUndefined();
    expect(fake.updatedChecks).toHaveLength(1);
    expect(fake.updatedChecks[0]).toMatchObject({
      status: "EXTRACTED",
      slip_type: "BANK_SLIP_NO_QR",
    });
  });
});
