import { issueForProvenance } from "./issues";
import type {
  AddPurchaseItemCommand,
  ClosePurchaseCommand,
  OpenPurchaseCommand,
  PurchaseAssemblyInput,
  PurchaseAssemblyResult,
  PurchaseCommandEnvelope,
  PurchaseStructuralIssue,
  SetPurchaseCostsCommand,
} from "./types";

interface ParsedCommandAt {
  envelopeIndex: number;
  envelope: Extract<PurchaseCommandEnvelope, { status: "PARSED" }>;
}

function globalIssue(
  code: PurchaseStructuralIssue["code"],
  message: string,
): PurchaseStructuralIssue {
  return issueForProvenance(null, code, message);
}

function entryIssue(
  entry: ParsedCommandAt | PurchaseCommandEnvelope,
  code: PurchaseStructuralIssue["code"],
  message: string,
  rawValue: string | null = null,
): PurchaseStructuralIssue {
  return issueForProvenance(
    "envelope" in entry ? entry.envelope.provenance : entry.provenance,
    code,
    message,
    rawValue,
  );
}

function parsedEntries(
  envelopes: readonly PurchaseCommandEnvelope[],
): ParsedCommandAt[] {
  return envelopes.flatMap((envelope, envelopeIndex) =>
    envelope.status === "PARSED"
      ? [{ envelopeIndex, envelope }]
      : [],
  );
}

function validateEvidenceOrder(
  input: PurchaseAssemblyInput,
  errors: PurchaseStructuralIssue[],
): void {
  for (let index = 1; index < input.chunks.length; index += 1) {
    const previous = input.chunks[index - 1];
    const current = input.chunks[index];
    if (
      previous
      && current
      && current.chunkOrdinal <= previous.chunkOrdinal
    ) {
      errors.push({
        code: "OUT_OF_ORDER_EVIDENCE",
        message: "Text chunk ordinals must increase in supplied order",
        chunkId: current.chunkId,
        startLine: current.lines[0]?.lineNumber ?? null,
        endLine: current.lines[current.lines.length - 1]?.lineNumber ?? null,
        rawValue: current.rawText,
      });
    }
  }

  for (let index = 1; index < input.commandEnvelopes.length; index += 1) {
    const previous = input.commandEnvelopes[index - 1];
    const current = input.commandEnvelopes[index];
    if (
      previous
      && current
      && current.commandOrdinal <= previous.commandOrdinal
    ) {
      errors.push(
        entryIssue(
          current,
          "OUT_OF_ORDER_EVIDENCE",
          "Command ordinals must increase in supplied order",
        ),
      );
    }
  }

  let previousTextOrdinal: number | null = null;
  for (const envelope of input.commandEnvelopes) {
    if (envelope.provenance.source !== "TEXT_BLOCK") continue;
    if (
      previousTextOrdinal !== null
      && envelope.provenance.chunkOrdinal < previousTextOrdinal
    ) {
      errors.push(
        entryIssue(
          envelope,
          "OUT_OF_ORDER_EVIDENCE",
          "Text command provenance moved backward across chunks",
        ),
      );
    }
    previousTextOrdinal = envelope.provenance.chunkOrdinal;
  }
}

function validateItemNumbers(
  items: readonly ParsedCommandAt[],
  errors: PurchaseStructuralIssue[],
): void {
  const seen = new Set<string>();
  let expected = BigInt(1);

  for (const entry of items) {
    if (entry.envelope.command.kind !== "ADD_PURCHASE_ITEM") continue;
    const item = entry.envelope.command;
    const key = item.itemNumber.toString();
    if (seen.has(key)) {
      errors.push(
        entryIssue(
          entry,
          "DUPLICATE_ITEM_NUMBER",
          `Duplicate purchase item number ${key}; every item remains preserved`,
          item.itemNumberText.raw,
        ),
      );
      continue;
    }

    seen.add(key);
    if (item.itemNumber !== expected) {
      errors.push(
        entryIssue(
          entry,
          "ITEM_NUMBER_GAP",
          `Expected item number ${expected.toString()} but received ${key}; supplied order is preserved`,
          item.itemNumberText.raw,
        ),
      );
    }
    expected = item.itemNumber + BigInt(1);
  }
}

/**
 * Shared typed purchase domain boundary used by both text and future postback
 * adapters. It performs structural assembly only.
 */
export function assemblePurchaseEvidence(
  input: PurchaseAssemblyInput,
): PurchaseAssemblyResult {
  const commandEnvelopes = [...input.commandEnvelopes];
  const errors: PurchaseStructuralIssue[] = commandEnvelopes.flatMap(
    (envelope) => [...envelope.errors],
  );
  for (const envelope of commandEnvelopes) {
    if (envelope.status === "INVALID" && envelope.errors.length === 0) {
      errors.push(
        entryIssue(
          envelope,
          "UNRECOGNIZED_LINE",
          "An invalid purchase envelope must never be treated as structurally complete",
        ),
      );
    }
  }
  const reviewFlags = commandEnvelopes.flatMap(
    (envelope) => [...envelope.reviewFlags],
  );
  validateEvidenceOrder(input, errors);

  const parsed = parsedEntries(commandEnvelopes);
  const headers = parsed.filter(
    (entry) => entry.envelope.command.kind === "OPEN_PURCHASE",
  );
  const items = parsed.filter(
    (entry) => entry.envelope.command.kind === "ADD_PURCHASE_ITEM",
  );
  const costs = parsed.filter(
    (entry) => entry.envelope.command.kind === "SET_PURCHASE_COSTS",
  );
  const closes = parsed.filter(
    (entry) => entry.envelope.command.kind === "CLOSE_PURCHASE",
  );

  if (headers.length === 0) {
    errors.push(globalIssue("MISSING_HEADER", "One purchase header is required"));
  } else {
    const firstHeader = headers[0];
    if (firstHeader && firstHeader.envelopeIndex !== 0) {
      errors.push(
        entryIssue(
          firstHeader,
          "HEADER_NOT_FIRST",
          "The purchase header must be the first command envelope",
        ),
      );
    }
    for (const duplicate of headers.slice(1)) {
      errors.push(
        entryIssue(
          duplicate,
          "DUPLICATE_HEADER",
          "Only one purchase header is allowed",
        ),
      );
    }
  }

  const firstHeaderIndex = headers[0]?.envelopeIndex ?? Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (item.envelopeIndex < firstHeaderIndex) {
      errors.push(
        entryIssue(
          item,
          "ITEM_BEFORE_HEADER",
          "Purchase item appeared before a valid header",
        ),
      );
    }
  }

  if (items.length === 0) {
    errors.push(
      globalIssue(
        "MISSING_ITEM_FIELD",
        "At least one parsed purchase item block is required",
      ),
    );
  }
  validateItemNumbers(items, errors);

  if (costs.length === 0) {
    errors.push(globalIssue("MISSING_COSTS", "One purchase costs block is required"));
  } else {
    for (const duplicate of costs.slice(1)) {
      errors.push(
        entryIssue(
          duplicate,
          "DUPLICATE_COSTS",
          "Only one purchase costs block is allowed",
        ),
      );
    }

    const lastItemIndex = items[items.length - 1]?.envelopeIndex
      ?? Number.POSITIVE_INFINITY;
    const firstCosts = costs[0];
    if (firstCosts && firstCosts.envelopeIndex < lastItemIndex) {
      errors.push(
        entryIssue(
          firstCosts,
          "COSTS_BEFORE_ITEM",
          "The costs block must follow every purchase item",
        ),
      );
    }
  }

  if (closes.length === 0) {
    errors.push(globalIssue("MISSING_CLOSE", "One purchase close command is required"));
  } else {
    for (const duplicate of closes.slice(1)) {
      errors.push(
        entryIssue(
          duplicate,
          "DUPLICATE_CLOSE",
          "Only one purchase close command is allowed",
        ),
      );
    }

    const firstClose = closes[0];
    if (firstClose) {
      if (firstClose.envelopeIndex !== commandEnvelopes.length - 1) {
        errors.push(
          entryIssue(
            firstClose,
            "CLOSE_NOT_LAST",
            "The purchase close command must be the final envelope",
          ),
        );
      }
      for (
        let index = firstClose.envelopeIndex + 1;
        index < commandEnvelopes.length;
        index += 1
      ) {
        const afterClose = commandEnvelopes[index];
        if (!afterClose) continue;
        errors.push(
          entryIssue(
            afterClose,
            "COMMAND_AFTER_CLOSE",
            "Evidence after close remains visible and makes the document incomplete",
          ),
        );
      }

      const closeCommand = firstClose.envelope.command;
      if (
        closeCommand.kind === "CLOSE_PURCHASE"
        && closeCommand.expectedItemCount !== BigInt(items.length)
      ) {
        errors.push(
          entryIssue(
            firstClose,
            "CLOSE_COUNT_MISMATCH",
            `Close declared ${closeCommand.expectedItemCount.toString()} items but ${items.length} parsed item commands were supplied`,
            closeCommand.expectedItemCountText.raw,
          ),
        );
      }
    }
  }

  const headerCommands = headers.map(
    (entry) => entry.envelope.command,
  ).filter(
    (command): command is OpenPurchaseCommand =>
      command.kind === "OPEN_PURCHASE",
  );
  const itemCommands = items.map(
    (entry) => entry.envelope.command,
  ).filter(
    (command): command is AddPurchaseItemCommand =>
      command.kind === "ADD_PURCHASE_ITEM",
  );
  const costCommands = costs.map(
    (entry) => entry.envelope.command,
  ).filter(
    (command): command is SetPurchaseCostsCommand =>
      command.kind === "SET_PURCHASE_COSTS",
  );
  const closeCommands = closes.map(
    (entry) => entry.envelope.command,
  ).filter(
    (command): command is ClosePurchaseCommand =>
      command.kind === "CLOSE_PURCHASE",
  );

  return {
    status: errors.length === 0 ? "COMPLETE" : "INCOMPLETE",
    evidence: {
      header: headerCommands[0] ?? null,
      headers: headerCommands,
      items: itemCommands,
      costs: costCommands[0] ?? null,
      costCommands,
      close: closeCommands[0] ?? null,
      closes: closeCommands,
      intendedWarehouseCode:
        headerCommands[0]?.intendedWarehouseCode ?? null,
      rawTextChunks: [...input.chunks],
      postbackEvidence: [...input.postbackEvidence],
    },
    commandEnvelopes,
    errors,
    reviewFlags,
  };
}
