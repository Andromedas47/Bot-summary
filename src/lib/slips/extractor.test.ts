import { describe, expect, it } from "bun:test";
import { OpenAiSlipExtractor } from "@/lib/slips/extractor";

describe("OpenAiSlipExtractor", () => {
  it("sends private bytes as an inline image and parses structured output", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              slip_type: "BANK_SLIP_NO_QR",
              gross_amount: null,
              discount_amount: null,
              paid_amount: null,
              transfer_amount: 315,
              reference_id: "004999",
              transaction_time: "2026-06-06T08:35:00+07:00",
              sender_name: null,
              receiver_name: "ร้านรับเงิน",
              receiver_account_tail: "1234",
              confidence: 0.91,
            }),
          }],
        }],
      }), { status: 200 });
    }) as typeof fetch;
    const extractor = new OpenAiSlipExtractor("test-key", "test-model", fetchImpl);

    const result = await extractor.extract({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
    });

    expect(result.transferAmount).toBe(315);
    expect(result.transactionTime).toBe("2026-06-06T01:35:00.000Z");
    expect(requests).toHaveLength(1);

    const body = JSON.parse(String(requests[0].init.body)) as {
      model: string;
      store: boolean;
      input: Array<{ content: Array<{ type: string; image_url?: string }> }>;
    };
    expect(body.model).toBe("test-model");
    expect(body.store).toBe(false);
    expect(body.input[0].content[1].image_url).toBe("data:image/jpeg;base64,AQID");
  });
});
