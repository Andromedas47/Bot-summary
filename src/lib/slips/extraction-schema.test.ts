import { describe, expect, it } from "bun:test";
import {
  determineSlipCheckStatus,
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
