import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SlipEvidenceService, buildSlipEvidencePath, computeSha256 } from "./evidence-service";
import { DOWNLOAD_FAILED_SHA256, SLIP_EVIDENCE_BUCKET } from "./types";
import type { Database } from "@/types/database";

function createFakeSupabase(storageError?: string) {
  const evidenceRows: Array<Record<string, unknown>> = [];
  const uploads: Array<{
    bucket: string;
    path: string;
    bytes: number[];
    contentType: string | undefined;
  }> = [];
  const rawUpdates: Array<Record<string, unknown>> = [];

  const client = {
    storage: {
      from(bucket: string) {
        return {
          async upload(
            path: string,
            body: Uint8Array,
            options: { contentType?: string },
          ) {
            uploads.push({
              bucket,
              path,
              bytes: Array.from(body),
              contentType: options.contentType,
            });
            return {
              data: null,
              error: storageError ? { message: storageError } : null,
            };
          },
        };
      },
    },
    from(table: string) {
      if (table === "slip_evidences") {
        return {
          async insert(row: Record<string, unknown>) {
            evidenceRows.push(row);
            return { error: null };
          },
        };
      }

      if (table === "raw_messages") {
        return {
          update(values: Record<string, unknown>) {
            rawUpdates.push(values);
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

  return { client, evidenceRows, uploads, rawUpdates };
}

const input = {
  rawMessageId: "raw-1",
  lineMessageId: "line-message-1",
  sourceId: "group-1",
  sourceType: "group" as const,
  lineUserId: "user-1",
  eventTimestamp: Date.UTC(2026, 5, 1, 5, 0, 0),
};

describe("slip evidence helpers", () => {
  it("builds the required private storage path", () => {
    expect(buildSlipEvidencePath({
      businessDate: "2026-06-01",
      sourceId: "group-1",
      lineMessageId: "message-1",
    })).toBe("slips/2026-06-01/group-1/message-1.jpg");
  });

  it("computes a lowercase SHA-256 hash", () => {
    expect(computeSha256(new Uint8Array([1, 2, 3]))).toBe(
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
  });
});

describe("SlipEvidenceService", () => {
  it("uploads image bytes and records RECEIVED evidence", async () => {
    const fake = createFakeSupabase();
    const bytes = new Uint8Array([1, 2, 3]);
    const service = new SlipEvidenceService(fake.client, async () => ({
      bytes,
      mimeType: "image/jpeg",
    }));

    const result = await service.ingest(input);

    expect(result.status).toBe("RECEIVED");
    expect(fake.uploads).toEqual([{
      bucket: SLIP_EVIDENCE_BUCKET,
      path: "slips/2026-06-01/group-1/line-message-1.jpg",
      bytes: [1, 2, 3],
      contentType: "image/jpeg",
    }]);
    expect(fake.evidenceRows).toHaveLength(1);
    expect(fake.evidenceRows[0]).toMatchObject({
      raw_message_id: "raw-1",
      line_message_id: "line-message-1",
      source_id: "group-1",
      source_type: "group",
      line_user_id: "user-1",
      storage_bucket: SLIP_EVIDENCE_BUCKET,
      storage_path: "slips/2026-06-01/group-1/line-message-1.jpg",
      mime_type: "image/jpeg",
      byte_size: 3,
      sha256: computeSha256(bytes),
      status: "RECEIVED",
    });
    expect(fake.rawUpdates).toEqual([{ is_processed: true }]);
  });

  it("records DOWNLOAD_FAILED when LINE content cannot be downloaded", async () => {
    const fake = createFakeSupabase();
    const service = new SlipEvidenceService(fake.client, async () => {
      throw new Error("download failed");
    });

    const result = await service.ingest(input);

    expect(result.status).toBe("DOWNLOAD_FAILED");
    expect(fake.uploads).toHaveLength(0);
    expect(fake.evidenceRows[0]).toMatchObject({
      status: "DOWNLOAD_FAILED",
      byte_size: 0,
      sha256: DOWNLOAD_FAILED_SHA256,
    });
    expect(fake.rawUpdates).toHaveLength(0);
  });

  it("records STORAGE_FAILED when private bucket upload fails", async () => {
    const fake = createFakeSupabase("bucket unavailable");
    const bytes = new Uint8Array([4, 5, 6]);
    const service = new SlipEvidenceService(fake.client, async () => ({
      bytes,
      mimeType: "image/png",
    }));

    const result = await service.ingest(input);

    expect(result.status).toBe("STORAGE_FAILED");
    expect(fake.evidenceRows[0]).toMatchObject({
      status: "STORAGE_FAILED",
      mime_type: "image/png",
      byte_size: 3,
      sha256: computeSha256(bytes),
    });
    expect(fake.rawUpdates).toHaveLength(0);
  });
});
