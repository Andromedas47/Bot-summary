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
