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
});
