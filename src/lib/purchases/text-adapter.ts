import { classifyPurchaseBlock } from "./classify";
import { issueForBlock } from "./issues";
import { parseClassifiedPurchaseBlock } from "./parse";
import {
  blockEndsAtChunkBoundary,
  expectedPurchaseContinuationLabel,
  firstNonblankPurchaseLine,
  isExactPurchaseFieldLine,
  segmentPurchaseChunk,
} from "./segment";
import type {
  PurchaseBlockInput,
  PurchaseCommandEnvelope,
  PurchaseTextChunk,
  TextBlockPurchaseProvenance,
} from "./types";

interface CandidateEnvelope {
  input: PurchaseBlockInput;
  envelope: PurchaseCommandEnvelope;
}

function textProvenance(
  input: PurchaseBlockInput,
): TextBlockPurchaseProvenance {
  return {
    source: "TEXT_BLOCK",
    classification: classifyPurchaseBlock(input),
    chunkId: input.chunk.chunkId,
    chunkOrdinal: input.chunk.chunkOrdinal,
    block: input.span,
    evidence: input.chunk.evidence,
  };
}

function appendSplitIssue(candidate: CandidateEnvelope): CandidateEnvelope {
  const splitIssue = issueForBlock(
    candidate.input,
    "BLOCK_SPLIT_ACROSS_CHUNKS",
    "A deterministic field continuation begins in the adjacent chunk; blocks are never joined",
  );

  return {
    input: candidate.input,
    envelope: {
      status: "INVALID",
      commandOrdinal: candidate.envelope.commandOrdinal,
      command: null,
      provenance: candidate.envelope.provenance,
      errors: [...candidate.envelope.errors, splitIssue],
      reviewFlags: candidate.envelope.reviewFlags,
    },
  };
}

/**
 * Converts ordered text chunks into typed or retained-invalid envelopes.
 * Input order is authoritative and is never replaced by timestamp sorting.
 */
export function extractPurchaseCommandsFromTextChunks(
  chunks: readonly PurchaseTextChunk[],
): PurchaseCommandEnvelope[] {
  const candidatesByChunk = chunks.map((chunk) => segmentPurchaseChunk(chunk));
  const candidates: CandidateEnvelope[] = [];
  let commandOrdinal = 1;

  for (const blockInputs of candidatesByChunk) {
    for (const input of blockInputs) {
      const parsed = parseClassifiedPurchaseBlock(input);
      const provenance = textProvenance(input);
      const envelope: PurchaseCommandEnvelope =
        parsed.status === "PARSED"
          ? {
              status: "PARSED",
              commandOrdinal,
              command: parsed.command,
              provenance,
              errors: parsed.errors,
              reviewFlags: parsed.reviewFlags,
            }
          : {
              status: "INVALID",
              commandOrdinal,
              command: null,
              provenance,
              errors: parsed.errors,
              reviewFlags: parsed.reviewFlags,
            };
      candidates.push({ input, envelope });
      commandOrdinal += 1;
    }
  }

  for (let index = 0; index < chunks.length - 1; index += 1) {
    const currentChunk = chunks[index];
    const nextChunk = chunks[index + 1];
    const currentBlocks = candidatesByChunk[index];
    if (
      !currentChunk
      || !nextChunk
      || !currentBlocks
      || currentChunk.chunkOrdinal >= nextChunk.chunkOrdinal
    ) {
      continue;
    }

    const previous = currentBlocks[currentBlocks.length - 1];
    const nextFirstLine = firstNonblankPurchaseLine(nextChunk);
    if (!previous || !nextFirstLine || !blockEndsAtChunkBoundary(previous)) {
      continue;
    }

    const expectedLabel = expectedPurchaseContinuationLabel(previous);
    if (
      !expectedLabel
      || !isExactPurchaseFieldLine(nextFirstLine, expectedLabel)
    ) {
      continue;
    }

    const candidateIndex = candidates.findIndex(
      (candidate) =>
        candidate.input.span.blockId === previous.span.blockId
        && candidate.input.chunk.chunkId === previous.chunk.chunkId,
    );
    if (candidateIndex < 0) continue;
    const candidate = candidates[candidateIndex];
    if (candidate) candidates[candidateIndex] = appendSplitIssue(candidate);
  }

  return candidates.map((candidate) => candidate.envelope);
}
