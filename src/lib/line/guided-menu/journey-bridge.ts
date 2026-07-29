/**
 * Slices 3C/3D — where the guided journey meets the existing text commands.
 *
 * The guided flow hands the operator ready-made messages in the syntax the
 * existing commands already accept, so the White Sheet and the transfer-slip
 * batch keep exactly one parser, one validator and one lifecycle each. This
 * module adds only two things around them:
 *
 *   1. a guard so a guided operator cannot submit a White Sheet for a market
 *      or date other than the round they are standing in;
 *   2. the handoff copy that carries them to the next stage.
 *
 * It never parses money, never persists a sheet and never closes a batch.
 */

import type { WhiteSheetCloseCommand } from "@/lib/line/white-sheet-close-command";
import {
  GuidedJourneyService,
  buildSlipHeaderTemplate,
  thaiDateFromIso,
  type GuidedJourneyContext,
  type GuidedJourneyState,
} from "./journey";
import { GUIDED_MENU_COPY } from "./ux-types";
import type { GuidedMenuIdentity } from "./ux-types";

export type GuidedWhiteSheetGuard =
  /** No guided round for this operator — the legacy direct command is unaffected. */
  | { verdict: "not_guided" }
  /** Submission agrees with the round; let the existing command through. */
  | { verdict: "allowed"; context: GuidedJourneyContext }
  /** Submission targets another market/date — refuse, write nothing. */
  | { verdict: "refused"; message: string };

/**
 * Verify a White Sheet closing command against the operator's active round.
 *
 * A guided operator's sheet must land on the round they opened. Silently
 * accepting a different market or date would file real money against the wrong
 * round, so the mismatch is refused before anything is loaded or written.
 *
 * When there is no guided round (or the row belongs to someone else) the
 * verdict is `not_guided` and the existing direct command path runs unchanged
 * — this guard never blocks the pre-existing workflow.
 */
export async function guardGuidedWhiteSheetSubmission(input: {
  journey: GuidedJourneyService;
  identity: GuidedMenuIdentity;
  command: WhiteSheetCloseCommand;
}): Promise<GuidedWhiteSheetGuard> {
  let state: GuidedJourneyState;
  try {
    state = await input.journey.resolve(input.identity);
  } catch {
    // A journey lookup failure must not take down the existing command path.
    return { verdict: "not_guided" };
  }
  if (state.stage === "idle") return { verdict: "not_guided" };

  const { context } = state;
  const marketMatches =
    context.marketLabelNormalized === input.command.marketLabelNormalized;
  const dateMatches = context.businessDate === input.command.businessDate;
  if (marketMatches && dateMatches) return { verdict: "allowed", context };

  const expectedDate =
    thaiDateFromIso(context.businessDate) ?? context.businessDate;
  return {
    verdict: "refused",
    message: [
      "ใบขาวนี้ไม่ตรงกับรอบที่เปิดอยู่ ยังไม่ได้บันทึกอะไร",
      `รอบที่เปิดอยู่: ${context.sellerLabel} — ${context.marketLabel} — ${expectedDate}`,
      "กรุณาใช้แบบฟอร์มที่ระบบส่งให้ และแก้เฉพาะตัวเลข",
    ].join("\n"),
  };
}

/**
 * The 3C → 3D handoff appended after a White Sheet submission that persisted.
 * Returns null when the round context cannot produce a valid slip header, so a
 * malformed handoff is never shown.
 */
export function buildSlipHandoffMessages(
  context: GuidedJourneyContext,
): string[] | null {
  const header = buildSlipHeaderTemplate(context);
  if (!header) return null;
  return [
    [
      GUIDED_MENU_COPY.nextStepSlips,
      "",
      GUIDED_MENU_COPY.slipInstructions,
    ].join("\n"),
    header,
  ];
}

