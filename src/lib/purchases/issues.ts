import type {
  PurchaseBlockInput,
  PurchaseProvenance,
  PurchaseReviewFlag,
  PurchaseReviewFlagCode,
  PurchaseSourceLine,
  PurchaseStructuralIssue,
  PurchaseStructuralIssueCode,
} from "./types";

export function issueForBlock(
  input: PurchaseBlockInput,
  code: PurchaseStructuralIssueCode,
  message: string,
  line?: PurchaseSourceLine,
  rawValue?: string | null,
): PurchaseStructuralIssue {
  return {
    code,
    message,
    chunkId: input.chunk.chunkId,
    startLine: line?.lineNumber ?? input.span.startLine,
    endLine: line?.lineNumber ?? input.span.endLine,
    rawValue: rawValue === undefined
      ? line?.rawText ?? input.span.rawText
      : rawValue,
  };
}

export function flagForBlock(
  input: PurchaseBlockInput,
  code: PurchaseReviewFlagCode,
  message: string,
  line?: PurchaseSourceLine,
  rawValue?: string | null,
): PurchaseReviewFlag {
  return {
    code,
    message,
    chunkId: input.chunk.chunkId,
    startLine: line?.lineNumber ?? input.span.startLine,
    endLine: line?.lineNumber ?? input.span.endLine,
    rawValue: rawValue === undefined
      ? line?.rawText ?? input.span.rawText
      : rawValue,
  };
}

export function issueForProvenance(
  provenance: PurchaseProvenance | null,
  code: PurchaseStructuralIssueCode,
  message: string,
  rawValue: string | null = null,
): PurchaseStructuralIssue {
  if (provenance?.source === "TEXT_BLOCK") {
    return {
      code,
      message,
      chunkId: provenance.chunkId,
      startLine: provenance.block.startLine,
      endLine: provenance.block.endLine,
      rawValue: rawValue ?? provenance.block.rawText,
    };
  }

  return {
    code,
    message,
    chunkId: null,
    startLine: null,
    endLine: null,
    rawValue,
  };
}
