import {
  parseSlipExtraction,
  SLIP_EXTRACTION_JSON_SCHEMA,
  type SlipExtraction,
} from "@/lib/slips/extraction-schema";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4o-mini";

export interface SlipExtractionInput {
  bytes: Uint8Array;
  mimeType: string;
}

export interface SlipExtractor {
  extract(input: SlipExtractionInput): Promise<SlipExtraction>;
}

export class OpenAiSlipExtractor implements SlipExtractor {
  constructor(
    private readonly apiKey = process.env.OPENAI_API_KEY,
    private readonly model = process.env.SLIP_EXTRACTION_MODEL ?? DEFAULT_MODEL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async extract(input: SlipExtractionInput): Promise<SlipExtraction> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not configured");

    const response = await this.fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: EXTRACTION_PROMPT,
            },
            {
              type: "input_image",
              image_url: `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`,
              detail: "high",
            },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "slip_extraction",
            strict: true,
            schema: SLIP_EXTRACTION_JSON_SCHEMA,
          },
        },
        max_output_tokens: 1200,
        store: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Image extraction provider returned HTTP ${response.status}`);
    }

    const payload = await response.json() as unknown;
    const outputText = readOutputText(payload);
    if (!outputText) throw new Error("Image extraction provider returned no structured output");

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      throw new Error("Image extraction provider returned invalid JSON");
    }

    return parseSlipExtraction(parsed);
  }
}

const EXTRACTION_PROMPT = `
Extract only information visibly present in this Thai payment evidence image.
Never infer, calculate, or guess a missing financial value. Return null when unclear.
Classify the image as BANK_SLIP_QR, BANK_SLIP_NO_QR, THAI_HELP_THAI, GWALLET,
NUMBERS_ONLY, WHITE_PAPER, or UNKNOWN.

For THAI_HELP_THAI or GWALLET:
- gross_amount is the visible goods/services total.
- discount_amount is the visible government right, subsidy, or discount.
- paid_amount is the visible amount actually paid.

For bank slips:
- transfer_amount is the visible transferred amount.

Use transaction_time only when both date and time are visible. Include Thailand's
+07:00 offset unless the image explicitly shows another offset. Convert a visible
Thai Buddhist year to the equivalent Gregorian year for ISO 8601. Keep reference_id
exactly as shown. Return only the last four visible receiver account digits.
Do not return OCR prose or any full bank account number.
`.trim();

function readOutputText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.output)) return null;

  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
