import { describe, expect, it } from "bun:test";
import {
  determineSlipCheckStatus,
  extractionToJson,
  parseSlipExtraction,
} from "@/lib/slips/extraction-schema";

describe("slip extraction validation", () => {
  it("marks number-only evidence NEED_REVIEW", () => {
    const extraction = parseSlipExtraction({
      slip_type: "NUMBERS_ONLY",
      gross_amount: null,
      discount_amount: null,
      paid_amount: 160,
      transfer_amount: null,
      reference_id: null,
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: null,
      confidence: 0.35,
    });

    expect(determineSlipCheckStatus(extraction)).toBe("NEED_REVIEW");
  });

  it("does not convert unclear values into financial amounts", () => {
    const extraction = parseSlipExtraction({
      slip_type: "BANK_SLIP_NO_QR",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      transfer_amount: "315",
      reference_id: "",
      transaction_time: "unclear",
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: "xxx-1234",
      confidence: 2,
    });

    expect(extraction.transferAmount).toBeNull();
    expect(extraction.referenceId).toBeNull();
    expect(extraction.transactionTime).toBeNull();
    expect(extraction.receiverAccountTail).toBe("1234");
    expect(extraction.confidence).toBe(1);
    expect(determineSlipCheckStatus(extraction)).toBe("NEED_REVIEW");
  });

  it("normalizes compact ISO transaction time with colonless offset", () => {
    const extraction = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: 60,
      discount_amount: 36,
      paid_amount: 24,
      transfer_amount: null,
      reference_id: "abc",
      transaction_time: "2026-06-15T105400+0700",
      sender_name: null,
      receiver_name: "ร้านค้า",
      receiver_account_tail: "1234",
      confidence: 0.9,
    });

    expect(extraction.transactionTime).toBe("2026-06-15T03:54:00.000Z");
  });

  it("parses Thai month text with Buddhist year to Gregorian timestamp", () => {
    const extraction = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: 60,
      discount_amount: 36,
      paid_amount: 24,
      transfer_amount: null,
      reference_id: "abc",
      transaction_time: "15 มิ.ย. 2569 1054 น.",
      sender_name: null,
      receiver_name: "ร้านค้า",
      receiver_account_tail: "1234",
      confidence: 0.9,
    });

    expect(extraction.transactionTime).toBe("2026-06-15T03:54:00.000Z");
  });

  it("parses Thai month text with short Buddhist year to Gregorian timestamp", () => {
    const extraction = parseSlipExtraction({
      slip_type: "BANK_SLIP_QR",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      transfer_amount: 130,
      reference_id: "016168181620CTF05042",
      transaction_time: "17 มิ.ย. 69 18:16",
      sender_name: null,
      receiver_name: "ร้านค้า",
      receiver_account_tail: "1234",
      confidence: 0.96,
    });

    expect(extraction.transactionTime).toBe("2026-06-17T11:16:00.000Z");
  });
});

const UAT_INSTANT = "2026-08-19T23:59:16.000Z";
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

function bangkokDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(Date.parse(iso) + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

function parseTime(transaction_time: string | null) {
  return parseSlipExtraction({
    slip_type: "THAI_HELP_THAI",
    gross_amount: 107,
    discount_amount: 64.2,
    paid_amount: 42.8,
    transfer_amount: null,
    reference_id: "9ecc8f59c10945afad6165371ace1741-qr",
    transaction_time,
    sender_name: "นฤมล พี.",
    receiver_name: "ฟรุตแวลู",
    receiver_account_tail: null,
    confidence: 0.9,
  });
}

describe("production UAT Thai Help Thai timestamp normalization", () => {
  it("CASE 1 — short Thai year 20 ส.ค. 69 - 06:59:16 น. is 2026-08-20 Bangkok", () => {
    const extraction = parseTime("20 ส.ค. 69 - 06:59:16 น.");
    expect(extraction.transactionTime).toBe(UAT_INSTANT);
    expect(bangkokDate(extraction.transactionTime)).toBe("2026-08-20");
  });

  it("CASE 2 — full Buddhist year 20 ส.ค. 2569 - 06:59:16 น.", () => {
    const extraction = parseTime("20 ส.ค. 2569 - 06:59:16 น.");
    expect(extraction.transactionTime).toBe(UAT_INSTANT);
    expect(bangkokDate(extraction.transactionTime)).toBe("2026-08-20");
  });

  it("CASE 3 — slash Buddhist date 20/8/2569 06:59:16", () => {
    const extraction = parseTime("20/8/2569 06:59:16");
    expect(extraction.transactionTime).toBe(UAT_INSTANT);
  });

  it("CASE 4 — two-digit slash year 20/8/69 06:59:16", () => {
    const extraction = parseTime("20/8/69 06:59:16");
    expect(extraction.transactionTime).toBe(UAT_INSTANT);
  });

  it("parses full Thai month name 20 สิงหาคม 2569 06:59:16", () => {
    expect(parseTime("20 สิงหาคม 2569 06:59:16").transactionTime).toBe(UAT_INSTANT);
  });

  it("parses hyphen and dot numeric Buddhist dates", () => {
    expect(parseTime("20-8-69 06:59:16").transactionTime).toBe(UAT_INSTANT);
    expect(parseTime("20.8.2569 06:59:16").transactionTime).toBe(UAT_INSTANT);
  });

  it("accepts 29 ก.พ. 67 leap day and rejects 29 ก.พ. 69", () => {
    expect(parseTime("29 ก.พ. 67 06:59:16").transactionTime).toBe("2024-02-28T23:59:16.000Z");
    expect(parseTime("29 ก.พ. 69 06:59:16").transactionTime).toBeNull();
  });

  it("CASE 5 — invalid 31 ก.พ. 69 does not overflow into March", () => {
    expect(parseTime("31 ก.พ. 69 06:59:16").transactionTime).toBeNull();
  });

  it("CASE 6 — existing ISO 2026-08-20T06:59:16+07:00", () => {
    expect(parseTime("2026-08-20T06:59:16+07:00").transactionTime).toBe(UAT_INSTANT);
  });

  it("does not treat 11/8 as November via DateStyle/JS heuristics", () => {
    const extraction = parseTime("11/8/2569 06:59:16");
    expect(extraction.transactionTime).toBe("2026-08-10T23:59:16.000Z");
    expect(bangkokDate(extraction.transactionTime)).toBe("2026-08-11");
  });
});

describe("production UAT Thai Help Thai field contract", () => {
  it("CASE 7 — labeled สิทธิโครงการฯ / G-Wallet win even if discount/paid were swapped", () => {
    const extraction = parseSlipExtraction({
      slip_type: "THAI_HELP_THAI",
      gross_amount: 107,
      discount_amount: 42.8,
      paid_amount: 64.2,
      project_right_amount: 64.2,
      gwallet_amount: 42.8,
      transfer_amount: null,
      reference_id: "9ecc8f59c10945afad6165371ace1741-qr",
      transaction_time: "20 ส.ค. 69 - 06:59:16 น.",
      sender_name: "นฤมล พี.",
      receiver_name: "ฟรุตแวลู / ฟรุตแวลู่",
      receiver_account_tail: "2418",
      confidence: 0.95,
    });

    expect(extraction.slipType).toBe("THAI_HELP_THAI");
    expect(extraction.grossAmount).toBe(107);
    expect(extraction.discountAmount).toBe(64.2);
    expect(extraction.paidAmount).toBe(42.8);
    expect(extraction.receiverAccountTail).toBeNull();
    expect(extraction.transactionTime).toBe(UAT_INSTANT);
    expect(determineSlipCheckStatus(extraction)).toBe("EXTRACTED");
  });

  it("CASE 8 — Thai Help Thai payer digits never become receiver_account_tail", () => {
    const masked = parseSlipExtraction({
      slip_type: "THAI_HELP_THAI",
      gross_amount: 107,
      discount_amount: 64.2,
      paid_amount: 42.8,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: "20 ส.ค. 69 - 06:59:16 น.",
      sender_name: "นฤมล พี.",
      receiver_name: "ฟรุตแวลู",
      receiver_account_tail: "**2418",
      confidence: 0.9,
    });
    const unqualified = parseSlipExtraction({
      slip_type: "THAI_HELP_THAI",
      gross_amount: 107,
      discount_amount: 64.2,
      paid_amount: 42.8,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: "20 ส.ค. 69 - 06:59:16 น.",
      sender_name: "นฤมล พี.",
      receiver_name: "ฟรุตแวลู",
      receiver_account_tail: "2418",
      confidence: 0.9,
    });

    expect(masked.receiverAccountTail).toBeNull();
    expect(unqualified.receiverAccountTail).toBeNull();
  });

  it("keeps bank-slip receiver tails and still rejects masked **2418", () => {
    const bank = parseSlipExtraction({
      slip_type: "BANK_SLIP_QR",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      transfer_amount: 130,
      reference_id: "016168181620CTF05042",
      transaction_time: "17 มิ.ย. 69 18:16",
      sender_name: null,
      receiver_name: "ร้านค้า",
      receiver_account_tail: "xxx-1234",
      confidence: 0.96,
    });
    const maskedBank = parseSlipExtraction({
      slip_type: "BANK_SLIP_QR",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      transfer_amount: 130,
      reference_id: "016168181620CTF05042",
      transaction_time: "17 มิ.ย. 69 18:16",
      sender_name: null,
      receiver_name: "ร้านค้า",
      receiver_account_tail: "**2418",
      confidence: 0.96,
    });

    expect(bank.receiverAccountTail).toBe("1234");
    expect(maskedBank.receiverAccountTail).toBeNull();
  });

  it("CASE 9 — wrapped reference joins without spaces or newlines", () => {
    const extraction = parseSlipExtraction({
      slip_type: "THAI_HELP_THAI",
      gross_amount: 107,
      discount_amount: 64.2,
      paid_amount: 42.8,
      transfer_amount: null,
      reference_id: "9ecc8f59c10945afad6165371\nace1741-qr",
      transaction_time: "20 ส.ค. 69 - 06:59:16 น.",
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: null,
      confidence: 0.9,
    });

    expect(extraction.referenceId).toBe("9ecc8f59c10945afad6165371ace1741-qr");
  });
});

describe("production defect fixture — raw GWALLET misclassification (A5)", () => {
  it("canonicalizes the exact bad production shape to THAI_HELP_THAI with correct amounts and a nulled tail", () => {
    const extraction = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      project_right_amount: 64.2,
      gwallet_amount: 42.8,
      headline_total_amount: 107,
      transfer_amount: null,
      reference_id: "9ecc8f59c10945afad6165371\nace1741-qr",
      transaction_time: "20 ส.ค. 69 - 06:59:16 น.",
      sender_name: "นฤมล พิล.",
      receiver_name: "ฟู้ตแวลู่",
      receiver_account_tail: "2418",
      payment_channel_text: "ไทยช่วยไทย พลัส (60/40)",
      confidence: 0.95,
    });

    expect(extraction.slipType).toBe("THAI_HELP_THAI");
    expect(extraction.grossAmount).toBe(107);
    expect(extraction.discountAmount).toBe(64.2);
    expect(extraction.paidAmount).toBe(42.8);
    expect(extraction.transferAmount).toBeNull();
    expect(extraction.transactionTime).toBe(UAT_INSTANT);
    expect(extraction.receiverAccountTail).toBeNull();
    expect(extraction.referenceId).toBe("9ecc8f59c10945afad6165371ace1741-qr");
    expect(determineSlipCheckStatus(extraction)).toBe("EXTRACTED");
  });

  it("persists the raw signals the canonicalization decided on, for later forensics", () => {
    const extraction = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      project_right_amount: 64.2,
      gwallet_amount: 42.8,
      headline_total_amount: 107,
      transfer_amount: null,
      reference_id: "9ecc8f59c10945afad6165371ace1741-qr",
      transaction_time: "20 ส.ค. 69 - 06:59:16 น.",
      sender_name: "นฤมล พิล.",
      receiver_name: "ฟู้ตแวลู่",
      receiver_account_tail: "2418",
      payment_channel_text: "ไทยช่วยไทย พลัส (60/40)",
      confidence: 0.95,
    });

    expect(extraction.paymentChannelText).toBe("ไทยช่วยไทย พลัส (60/40)");
    expect(extraction.headlineTotalAmount).toBe(107);

    // extracted_json is the only durable record of why this slip was upgraded.
    const persisted = extractionToJson(extraction) as Record<string, unknown>;
    expect(persisted.payment_channel_text).toBe("ไทยช่วยไทย พลัส (60/40)");
    expect(persisted.headline_total_amount).toBe(107);
    expect(persisted.slip_type).toBe("THAI_HELP_THAI");
    // The leaked payer tail must not reach the database.
    expect(persisted.receiver_account_tail).toBeNull();
  });

  it("redacts long digit runs swept into the channel text, keeping the marker and the split ratio", () => {
    const extraction = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      project_right_amount: 64.2,
      gwallet_amount: 42.8,
      headline_total_amount: 107,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: "2418",
      // The model sweeping an adjacent masked-account line into the channel field
      // must not reintroduce the payer digits that receiverAccountTail nulls out.
      payment_channel_text: "ไทยช่วยไทย พลัส (60/40)\nรับเงินจาก นฤมล **2418",
      confidence: 0.9,
    });

    expect(extraction.paymentChannelText).not.toContain("2418");
    expect(extraction.paymentChannelText).toContain("ไทยช่วยไทย");
    expect(extraction.paymentChannelText).toContain("(60/40)");
    // Redaction must not cost us the canonicalization it feeds.
    expect(extraction.slipType).toBe("THAI_HELP_THAI");
    expect(extraction.receiverAccountTail).toBeNull();
  });
});

describe("payment channel canonicalization (A1, A6)", () => {
  it("explicit ไทยช่วยไทย marker overrides raw GWALLET to canonical THAI_HELP_THAI", () => {
    const extraction = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: null,
      discount_amount: 64.2,
      paid_amount: 42.8,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: null,
      payment_channel_text: "ไทยช่วยไทย พลัส (60/40)",
      confidence: 0.9,
    });

    expect(extraction.slipType).toBe("THAI_HELP_THAI");
  });

  it("plain GWALLET with no marker stays GWALLET", () => {
    const noChannelText = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: 60,
      discount_amount: 36,
      paid_amount: 24,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: null,
      payment_channel_text: null,
      confidence: 0.9,
    });
    const unrelatedChannelText = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: 60,
      discount_amount: 36,
      paid_amount: 24,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: null,
      payment_channel_text: "G-Wallet เติมเงิน",
      confidence: 0.9,
    });

    expect(noChannelText.slipType).toBe("GWALLET");
    expect(unrelatedChannelText.slipType).toBe("GWALLET");
  });

  it("marker does not upgrade a bank slip or other unrelated raw type (false-positive guard)", () => {
    const bankSlip = parseSlipExtraction({
      slip_type: "BANK_SLIP_QR",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      transfer_amount: 130,
      reference_id: "016168181620CTF05042",
      transaction_time: "17 มิ.ย. 69 18:16",
      sender_name: null,
      receiver_name: "ร้านค้า",
      receiver_account_tail: "1234",
      payment_channel_text: "ไทยช่วยไทย พลัส (60/40)",
      confidence: 0.96,
    });
    const whitePaper = parseSlipExtraction({
      slip_type: "WHITE_PAPER",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      transfer_amount: null,
      reference_id: null,
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: null,
      payment_channel_text: "ไทยช่วยไทย พลัส (60/40)",
      confidence: 0.4,
    });

    expect(bankSlip.slipType).toBe("BANK_SLIP_QR");
    expect(bankSlip.receiverAccountTail).toBe("1234");
    expect(whitePaper.slipType).toBe("WHITE_PAPER");
  });
});

describe("headline total precedence over gross_amount (A2, A6)", () => {
  it("headline total fills a null generic gross", () => {
    const extraction = parseSlipExtraction({
      slip_type: "THAI_HELP_THAI",
      gross_amount: null,
      discount_amount: 64.2,
      paid_amount: 42.8,
      headline_total_amount: 107,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: null,
      confidence: 0.9,
    });

    expect(extraction.grossAmount).toBe(107);
  });

  it("headline total wins over a contradictory generic gross_amount reading", () => {
    // The explicit รับเงินสำเร็จ / ยอดรับรวม label names the exact line the model
    // transcribed; gross_amount is a looser catch-all that can land on a different,
    // less certain number. When both are present and disagree, the labeled headline
    // total is trusted over the generic field.
    const extraction = parseSlipExtraction({
      slip_type: "THAI_HELP_THAI",
      gross_amount: 999,
      discount_amount: 64.2,
      paid_amount: 42.8,
      headline_total_amount: 107,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: null,
      confidence: 0.9,
    });

    expect(extraction.grossAmount).toBe(107);
  });

  it("does not fall back to arithmetic — gross stays null when headline and gross are both null", () => {
    const extraction = parseSlipExtraction({
      slip_type: "THAI_HELP_THAI",
      gross_amount: null,
      discount_amount: 64.2,
      paid_amount: 42.8,
      headline_total_amount: null,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: null,
      confidence: 0.9,
    });

    expect(extraction.grossAmount).toBeNull();
  });
});

describe("receiver account tail fail-closed rule (A3, A6)", () => {
  it("nulls the tail for canonical THAI_HELP_THAI", () => {
    const extraction = parseSlipExtraction({
      slip_type: "THAI_HELP_THAI",
      gross_amount: 107,
      discount_amount: 64.2,
      paid_amount: 42.8,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: "2418",
      confidence: 0.9,
    });

    expect(extraction.receiverAccountTail).toBeNull();
  });

  it("nulls the tail for canonical GWALLET (raw GWALLET, no marker)", () => {
    const extraction = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: 60,
      discount_amount: 36,
      paid_amount: 24,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: "2418",
      confidence: 0.9,
    });

    expect(extraction.receiverAccountTail).toBeNull();
  });

  it("preserves the last four digits for BANK_SLIP_QR and BANK_SLIP_NO_QR", () => {
    const bankQr = parseSlipExtraction({
      slip_type: "BANK_SLIP_QR",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      transfer_amount: 130,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: "ร้านค้า",
      receiver_account_tail: "xxx-1234",
      confidence: 0.9,
    });
    const bankNoQr = parseSlipExtraction({
      slip_type: "BANK_SLIP_NO_QR",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      transfer_amount: 130,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: "ร้านค้า",
      receiver_account_tail: "5678",
      confidence: 0.9,
    });

    expect(bankQr.receiverAccountTail).toBe("1234");
    expect(bankNoQr.receiverAccountTail).toBe("5678");
  });
});

describe("PR #70 regressions stay fixed under the new raw fields (A4)", () => {
  it("retains the labeled project_right_amount / gwallet_amount mapping", () => {
    const extraction = parseSlipExtraction({
      slip_type: "THAI_HELP_THAI",
      gross_amount: 107,
      discount_amount: 42.8,
      paid_amount: 64.2,
      project_right_amount: 64.2,
      gwallet_amount: 42.8,
      transfer_amount: null,
      reference_id: "ref",
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: null,
      confidence: 0.9,
    });

    expect(extraction.discountAmount).toBe(64.2);
    expect(extraction.paidAmount).toBe(42.8);
  });

  it("retains the wrapped-reference whitespace compaction", () => {
    const extraction = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: 60,
      discount_amount: 36,
      paid_amount: 24,
      transfer_amount: null,
      reference_id: "abc123\ndef456",
      transaction_time: null,
      sender_name: null,
      receiver_name: null,
      receiver_account_tail: null,
      confidence: 0.9,
    });

    expect(extraction.referenceId).toBe("abc123def456");
  });

  it("retains short Thai year 69 normalization", () => {
    expect(parseTime("20 ส.ค. 69 - 06:59:16 น.").transactionTime).toBe(UAT_INSTANT);
  });

  it("retains rejection of an invalid Thai calendar date", () => {
    expect(parseTime("31 ก.พ. 69 06:59:16").transactionTime).toBeNull();
  });
});
