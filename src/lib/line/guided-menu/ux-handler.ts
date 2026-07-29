/**
 * Guided Menu Slice 2 UX handler.
 * Opens menu on exact "เมนู", consumes opaque gpm1 tokens, never opens sessions.
 * Adapted to corrected Slice 1 create/consume/record contracts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { MENU_TOKEN_PREFIX, parseMenuToken } from "./menu-token";
import { GuidedMenuStateService } from "./menu-state-service";
import type {
  CreateMenuStateInput,
  GuidedMenuSeller,
  GuidedMenuSellerMarket,
  MenuActionType,
  MenuDateMode,
  MenuPayload,
  MenuPayloadByAction,
  MenuSourceType,
  MenuTransactionTypeCode,
} from "./menu-state-types";
import { MENU_SOURCE_TYPES, MENU_TRANSACTION_TYPE_CODES } from "./menu-state-types";
import { resolveGuidedMenuDate } from "./dates";
import {
  findGuidedMenuMarket,
  type GuidedMenuMarketOption,
} from "./markets";
import { GuidedSessionOpener } from "./session-opener";
import {
  GuidedSessionCaptureService,
  type GuidedCaptureRefusal,
} from "./session-capture";
import {
  GuidedJourneyService,
  buildSlipHeaderTemplate,
  buildWhiteSheetTemplate,
  thaiDateFromIso,
  type GuidedJourneyContext,
} from "./journey";
import {
  GuidedRoundService,
  GUIDED_ROUND_BLOCKER_LABEL,
  summarizeSlipStatuses,
} from "./round-close";
import { buildWeighSessionSummary } from "@/lib/line/reply";
import {
  assertGuidedMenuMessageLimits,
  bindQuickReply,
  buildCancelledMessage,
  buildCapturedItemsMessages,
  buildConfirmPreviewMessage,
  buildRoundStatusMessage,
  buildSlipInstructionMessages,
  buildWhiteSheetTemplateMessages,
  buildFinalizeConfirmedMessage,
  buildFinalizeNotReadyMessage,
  buildMenuDismissedSessionOpenMessage,
  buildNoOpenSessionMessage,
  buildSessionActionConflictMessage,
  type BoundTokenButton,
  buildDateSelectMessage,
  buildNoActiveSellerMarketsMessage,
  buildNoActiveSellersMessage,
  buildSellerSelectMessages,
  buildSellerUnavailableMessage,
  buildInvalidMenuMessage,
  buildMarketSelectMessage,
  buildMarketUnavailableMessage,
  buildSessionAlreadyOpenMessage,
  buildSessionOpenConflictMessage,
  buildSessionOpenedMessage,
  buildTransactionTypeMessage,
  buildUnmappedMessage,
} from "./messages";
import {
  GUIDED_MENU_COPY,
  GUIDED_MENU_TRIGGER,
  LINE_REPLY_MESSAGE_MAX,
  SELLERS_PER_MESSAGE,
  type GuidedMenuIdentity,
  type GuidedMenuLineMessage,
  type GuidedMenuUxResult,
  type LineQuickReply,
} from "./ux-types";

export function isExactGuidedMenuTrigger(text: string): boolean {
  return text.trim() === GUIDED_MENU_TRIGGER;
}

/** True when postback data carries a well-formed opaque gpm1 token. */
export function isGuidedMenuPostbackData(data: string): boolean {
  return parseMenuToken(data).ok;
}

/**
 * True when postback data looks like Guided Menu (`gpm1:` prefix).
 * Malformed candidates must fail closed with the invalid-menu reply —
 * they must not fall through as "unrelated" postbacks.
 */
export function isGuidedMenuPostbackCandidate(data: string): boolean {
  return typeof data === "string" && data.startsWith(MENU_TOKEN_PREFIX);
}

function asSourceType(value: string): MenuSourceType | null {
  return (MENU_SOURCE_TYPES as readonly string[]).includes(value)
    ? (value as MenuSourceType)
    : null;
}

function asTx(value: unknown): MenuTransactionTypeCode | null {
  return typeof value === "string" &&
    (MENU_TRANSACTION_TYPE_CODES as readonly string[]).includes(value)
    ? (value as MenuTransactionTypeCode)
    : null;
}

function isCancelPayload(payload: MenuPayload): boolean {
  return payload.intent === "cancel";
}

function resultEnvelope(
  screen: GuidedMenuUxResult["screen"],
  messages: GuidedMenuLineMessage[],
  extra: Record<string, unknown> = {},
): GuidedMenuUxResult {
  assertGuidedMenuMessageLimits(messages);
  return {
    screen,
    messages,
    result: {
      v: 1,
      screen,
      messages,
      ...extra,
    },
    confirmPlaceholder: screen === "confirm_placeholder",
  };
}

function restoreFromResult(result: Record<string, unknown> | null): GuidedMenuUxResult | null {
  if (!result || typeof result !== "object") return null;
  if (result.v !== 1 || typeof result.screen !== "string") return null;
  if (!Array.isArray(result.messages)) return null;
  const messages = result.messages as GuidedMenuLineMessage[];
  try {
    assertGuidedMenuMessageLimits(messages);
  } catch {
    return null;
  }
  return {
    screen: result.screen as GuidedMenuUxResult["screen"],
    messages,
    result,
    confirmPlaceholder: result.screen === "confirm_placeholder",
  };
}

type CreateToken = <A extends MenuActionType>(input: {
  actionType: A;
  payload: MenuPayloadByAction[A];
}) => Promise<string>;

export class GuidedMenuUxHandler {
  private readonly state: GuidedMenuStateService;
  private readonly opener: GuidedSessionOpener;
  private readonly capture: GuidedSessionCaptureService;
  private readonly journey: GuidedJourneyService;
  private readonly rounds: GuidedRoundService;

  constructor(
    supabase: SupabaseClient,
    options: {
      stateService?: GuidedMenuStateService;
      sessionOpener?: GuidedSessionOpener;
      captureService?: GuidedSessionCaptureService;
      journeyService?: GuidedJourneyService;
      roundService?: GuidedRoundService;
    } = {},
  ) {
    this.state = options.stateService ?? new GuidedMenuStateService(supabase);
    this.opener = options.sessionOpener ?? new GuidedSessionOpener(supabase);
    this.capture =
      options.captureService ?? new GuidedSessionCaptureService(supabase);
    this.journey = options.journeyService ?? new GuidedJourneyService(supabase);
    this.rounds =
      options.roundService ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new GuidedRoundService(supabase as any);
  }

  async openMenu(input: {
    identity: GuidedMenuIdentity;
  }): Promise<GuidedMenuUxResult> {
    const operator = await this.state.resolveOperator(input.identity.lineUserId);
    if (operator.status !== "mapped") {
      return resultEnvelope("unmapped", [buildUnmappedMessage()]);
    }
    return this.buildTransactionTypeScreen(input.identity);
  }

  async handlePostback(input: {
    wireToken: string;
    lineEventId: string;
    identity: GuidedMenuIdentity;
    lineTimestampMs: number;
  }): Promise<GuidedMenuUxResult> {
    if (!isGuidedMenuPostbackData(input.wireToken)) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    const consumed = await this.state.consumeState({
      wireToken: input.wireToken,
      lineEventId: input.lineEventId,
      lineUserId: input.identity.lineUserId,
      sourceType: input.identity.sourceType,
      sourceId: input.identity.sourceId,
      sessionKey: input.identity.sessionKey,
    });

    if (consumed.status === "invalid_or_expired") {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    if (consumed.status === "already_consumed") {
      // Different-event: no action/payload/result disclosure — generic refuse.
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    if (consumed.status === "replay") {
      const restored = restoreFromResult(consumed.result);
      if (restored) return restored;
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    // status === "consumed"
    const outcome = await this.dispatchConsumed({
      actionType: consumed.actionType,
      payload: consumed.payload,
      identity: input.identity,
      lineEventId: input.lineEventId,
      lineTimestampMs: input.lineTimestampMs,
    });

    const recorded = await this.state.recordResult({
      wireToken: input.wireToken,
      consumedLineEventId: input.lineEventId,
      lineUserId: input.identity.lineUserId,
      sourceType: input.identity.sourceType,
      sourceId: input.identity.sourceId,
      sessionKey: input.identity.sessionKey,
      result: outcome.result,
    });

    if (recorded.status === "replay") {
      const restored = restoreFromResult(recorded.result);
      if (restored) return restored;
    }
    if (
      recorded.status === "result_conflict" ||
      recorded.status === "invalid_or_expired"
    ) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    return outcome;
  }

  private async dispatchConsumed(input: {
    actionType: MenuActionType;
    payload: MenuPayload;
    identity: GuidedMenuIdentity;
    lineEventId: string;
    lineTimestampMs: number;
  }): Promise<GuidedMenuUxResult> {
    // Re-check operator on every navigation step (inactive mid-flow → refuse).
    const operator = await this.state.resolveOperator(input.identity.lineUserId);
    if (operator.status !== "mapped") {
      return resultEnvelope("unmapped", [buildUnmappedMessage()]);
    }

    if (input.actionType === "menu_root") {
      if (isCancelPayload(input.payload)) {
        // Dismissing the menu never voids an open round — there is no
        // authoritative cancel-open-session contract to call. Say so plainly
        // rather than let "ยกเลิกแล้ว" read as a cancelled round.
        const open = await this.capture.snapshot(input.identity);
        if (open.status === "ok") {
          return resultEnvelope("session_menu_dismissed", [
            buildMenuDismissedSessionOpenMessage(),
          ]);
        }
        return resultEnvelope("cancelled", [buildCancelledMessage()]);
      }
      return this.buildTransactionTypeScreen(input.identity);
    }

    if (input.actionType === "view_status") {
      return this.viewStatus(input.identity);
    }

    if (input.actionType === "request_close") {
      return this.requestClose(input);
    }

    if (input.actionType === "confirm_finalize") {
      return this.confirmFinalize(input);
    }

    if (input.actionType === "choose_transaction_type") {
      const tx = asTx(input.payload.transaction_type);
      if (!tx) {
        return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
      }
      return this.buildSellerScreen(input.identity, tx);
    }

    if (input.actionType === "choose_seller") {
      const tx = asTx(input.payload.transaction_type);
      const sellerCode = input.payload.seller_code?.trim();
      if (!tx || !sellerCode) {
        return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
      }
      const selection = await this.state.loadActiveSellerMarkets(sellerCode);
      if (!selection.seller) {
        return resultEnvelope("seller_unavailable", [
          buildSellerUnavailableMessage(),
        ]);
      }
      if (selection.markets.length === 0) {
        return resultEnvelope("no_seller_markets", [
          buildNoActiveSellerMarketsMessage(),
        ]);
      }
      return this.buildMarketScreen(
        input.identity,
        tx,
        selection.seller,
        selection.markets,
      );
    }

    if (input.actionType === "choose_market") {
      const tx = asTx(input.payload.transaction_type);
      const sellerCode = input.payload.seller_code?.trim();
      const marketCode = input.payload.market_code?.trim();
      if (!tx || !sellerCode || !marketCode) {
        return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
      }
      const selection = await this.state.loadActiveSellerMarkets(sellerCode);
      if (!selection.seller) {
        return resultEnvelope("seller_unavailable", [
          buildSellerUnavailableMessage(),
        ]);
      }
      const market = findGuidedMenuMarket(
        selection.markets.map((row) => ({
          code: row.marketCode,
          label: row.marketLabel,
        })),
        marketCode,
      );
      if (!market) {
        return resultEnvelope("market_unavailable", [
          buildMarketUnavailableMessage(),
        ]);
      }
      return this.buildDateScreen(input.identity, tx, selection.seller, market);
    }

    if (input.actionType === "choose_date") {
      const tx = asTx(input.payload.transaction_type);
      const sellerCode = input.payload.seller_code?.trim();
      const marketCode = input.payload.market_code?.trim();
      const dateMode = input.payload.date_mode;
      if (
        !tx ||
        !sellerCode ||
        !marketCode ||
        (dateMode !== "today" && dateMode !== "yesterday")
      ) {
        return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
      }
      const selection = await this.state.loadActiveSellerMarkets(sellerCode);
      if (!selection.seller) {
        return resultEnvelope("seller_unavailable", [
          buildSellerUnavailableMessage(),
        ]);
      }
      const market = findGuidedMenuMarket(
        selection.markets.map((row) => ({
          code: row.marketCode,
          label: row.marketLabel,
        })),
        marketCode,
      );
      if (!market) {
        return resultEnvelope("market_unavailable", [
          buildMarketUnavailableMessage(),
        ]);
      }
      return this.buildConfirmScreen(
        input.identity,
        tx,
        selection.seller,
        market,
        dateMode,
        input.lineTimestampMs,
      );
    }

    if (input.actionType === "confirm_open") {
      return this.confirmOpen({
        payload: input.payload,
        identity: input.identity,
        lineEventId: input.lineEventId,
        lineTimestampMs: input.lineTimestampMs,
      });
    }

    return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
  }

  /**
   * Slice 3A — the confirm boundary now opens a REAL structured session.
   *
   * Every selection is re-validated against the live catalog at press time,
   * not trusted from the token payload: the operator, the transaction type,
   * the seller, the market, the seller→market assignment and the business
   * date are all re-derived here. A stale button whose assignment was revoked
   * after the token was minted therefore refuses instead of opening.
   */
  private async confirmOpen(input: {
    payload: MenuPayload;
    identity: GuidedMenuIdentity;
    lineEventId: string;
    lineTimestampMs: number;
  }): Promise<GuidedMenuUxResult> {
    const tx = asTx(input.payload.transaction_type);
    const sellerCode = input.payload.seller_code?.trim();
    const marketCode = input.payload.market_code?.trim();
    const dateMode = input.payload.date_mode;
    if (
      !tx ||
      !sellerCode ||
      !marketCode ||
      (dateMode !== "today" && dateMode !== "yesterday")
    ) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    const selection = await this.state.loadActiveSellerMarkets(sellerCode);
    if (!selection.seller) {
      return resultEnvelope("seller_unavailable", [
        buildSellerUnavailableMessage(),
      ]);
    }
    const assignment = selection.markets.find(
      (row) => row.marketCode === marketCode,
    );
    if (!assignment) {
      return resultEnvelope("market_unavailable", [
        buildMarketUnavailableMessage(),
      ]);
    }

    // The date is resolved from the LINE event timestamp against the Bangkok
    // calendar at press time — never carried as a label in the token.
    const resolved = resolveGuidedMenuDate(dateMode, input.lineTimestampMs);
    if (!resolved) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    const opened = await this.opener.open({
      identity: input.identity,
      transactionType: tx,
      sellerLabel: selection.seller.label,
      marketLabel: assignment.marketLabel,
      businessDateIso: resolved.iso,
      lineEventId: input.lineEventId,
      lineTimestampMs: input.lineTimestampMs,
    });

    if (opened.status === "already_open") {
      return resultEnvelope(
        "session_already_open",
        [buildSessionAlreadyOpenMessage()],
        { opened: false, recorded: false, reason: "session_already_open" },
      );
    }
    if (opened.status !== "opened") {
      return resultEnvelope(
        "session_open_conflict",
        [buildSessionOpenConflictMessage()],
        { opened: false, recorded: false, reason: opened.reason },
      );
    }

    // 3B: the round is immediately actionable — review and close ride along
    // as single-use tokens so the operator never has to remember a command.
    const quickReply = await this.buildSessionActions(input.identity, {
      close: true,
      confirm: false,
    });
    const openedMessage = buildSessionOpenedMessage({
      transactionType: tx,
      sellerLabel: selection.seller.label,
      marketLabel: assignment.marketLabel,
      dateThaiShort: resolved.thaiShort,
      instructions: [
        GUIDED_MENU_COPY.sendItemsHint,
        GUIDED_MENU_COPY.closeWhenDoneHint,
      ],
    });

    return resultEnvelope(
      "session_opened",
      [quickReply ? { ...openedMessage, quickReply } : openedMessage],
      {
        opened: true,
        transaction_type: tx,
        seller_code: selection.seller.sellerCode,
        market_code: assignment.marketCode,
        business_date_iso: resolved.iso,
        session_key: opened.sessionKey,
        session_generation: opened.sessionGeneration,
        open_outcome: opened.outcome,
      },
    );
  }

  // ── Slice 3B — guided capture, review and finalize ──────────────────────

  /**
   * Action buttons for an open round. Built fresh on every screen so each is
   * a single-use token bound to this operator, source and session key.
   */
  private async buildSessionActions(
    identity: GuidedMenuIdentity,
    include: { close: boolean; confirm: boolean },
  ): Promise<LineQuickReply | undefined> {
    try {
      const create = this.createTokenFn(identity);
      const buttons: BoundTokenButton[] = [];
      buttons.push({
        label: "ดูรายการ",
        actionType: "view_status",
        payload: {},
        wireToken: await create({ actionType: "view_status", payload: {} }),
      });
      if (include.close) {
        buttons.push({
          label: "จบรายการ",
          actionType: "request_close",
          payload: {},
          wireToken: await create({ actionType: "request_close", payload: {} }),
        });
      }
      if (include.confirm) {
        buttons.push({
          label: "ยืนยันจบรายการ",
          actionType: "confirm_finalize",
          payload: {},
          wireToken: await create({
            actionType: "confirm_finalize",
            payload: {},
          }),
        });
      }
      buttons.push({
        // Never "ยกเลิกรายการ": this dismisses the guided controls and leaves
        // the produce session open. There is no cancel-open-session contract.
        label: "ออกจากเมนู",
        actionType: "menu_root",
        payload: { intent: "cancel" },
        wireToken: await create({
          actionType: "menu_root",
          payload: { intent: "cancel" },
        }),
      });
      return bindQuickReply(buttons);
    } catch {
      // Losing the buttons must not lose the message: the operator still sees
      // their summary and can reopen the menu with the เมนู trigger.
      return undefined;
    }
  }

  /** Map a capture refusal onto operator copy without leaking internals. */
  private refusalEnvelope(reason: GuidedCaptureRefusal): GuidedMenuUxResult {
    if (reason === "no_open_session" || reason === "not_structured" || reason === "terminalized") {
      return resultEnvelope("no_open_session", [buildNoOpenSessionMessage()], {
        reason,
      });
    }
    // ownership/session-key mismatches disclose nothing beyond the generic
    // invalid-menu copy — a stranger must not learn a round exists.
    return resultEnvelope("invalid", [buildInvalidMenuMessage()], { reason });
  }

  /**
   * Slices 3B/3C/3D — one journey-status action, rendered for wherever the
   * operator actually is.
   *
   * The stage is re-derived server-side from authoritative state on every
   * press (GuidedJourneyService), never carried in the token, so a button
   * minted at an earlier stage always renders the CURRENT stage. This action
   * is read-only, which is why sharing one action type across stages is safe.
   */
  private async viewStatus(
    identity: GuidedMenuIdentity,
  ): Promise<GuidedMenuUxResult> {
    let journey;
    try {
      journey = await this.journey.resolve(identity);
    } catch {
      return resultEnvelope("no_open_session", [buildNoOpenSessionMessage()], {
        reason: "lookup_failed",
      });
    }
    if (journey.stage === "idle") {
      // Identity failures disclose nothing; everything else is "no round yet",
      // but the specific reason is kept in the recorded result for operators
      // support and for the replay envelope.
      const opaque =
        journey.reason === "ownership_conflict" ||
        journey.reason === "session_key_mismatch" ||
        journey.reason === "missing_session_key";
      return opaque
        ? resultEnvelope("invalid", [buildInvalidMenuMessage()], {
            reason: journey.reason,
          })
        : resultEnvelope("no_open_session", [buildNoOpenSessionMessage()], {
            reason: journey.reason,
          });
    }

    if (journey.stage === "capture" || journey.stage === "awaiting_confirm") {
      return this.renderCaptureStatus(identity, journey.stage);
    }
    if (journey.stage === "white_sheet") {
      return this.renderWhiteSheetStage(identity, journey.context);
    }
    if (journey.stage === "slips") {
      return this.renderSlipStage(identity, journey.context);
    }
    return this.renderRoundStatus(
      identity,
      journey.context,
      journey.whiteSheet.status !== "not_submitted",
    );
  }

  /** Slice 3D — read-only reconciliation with the remaining blockers spelled out. */
  private async renderRoundStatus(
    identity: GuidedMenuIdentity,
    context: GuidedJourneyContext,
    whiteSheetSubmitted: boolean,
  ): Promise<GuidedMenuUxResult> {
    const report = await this.rounds.report(context, whiteSheetSubmitted);
    const dateThaiShort =
      thaiDateFromIso(context.businessDate) ?? context.businessDate;
    const quickReply = await this.buildJourneyActions(identity, "ตรวจยอด");
    return resultEnvelope(
      "round_status",
      [
        buildRoundStatusMessage({
          sellerLabel: context.sellerLabel,
          marketLabel: context.marketLabel,
          dateThaiShort,
          totals: report.totals,
          slipCounts: summarizeSlipStatuses(report.slips),
          blockerLines: [
            ...report.blockers.map((b) => GUIDED_ROUND_BLOCKER_LABEL[b]),
            ...(report.blockers.length === 0
              ? [`พิมพ์ "${GUIDED_MENU_COPY.roundCloseCommand}" เพื่อปิดรอบ`]
              : [
                  `แก้ไขแล้วพิมพ์ "${GUIDED_MENU_COPY.roundCloseCommand}" อีกครั้ง`,
                ]),
          ],
          closed: false,
          quickReply,
        }),
      ],
      {
        stage: "reconcile",
        blockers: report.blockers,
        difference: report.totals.difference,
      },
    );
  }

  private async renderCaptureStatus(
    identity: GuidedMenuIdentity,
    stage: "capture" | "awaiting_confirm",
  ): Promise<GuidedMenuUxResult> {
    const snapshot = await this.capture.snapshot(identity);
    if (snapshot.status !== "ok") return this.refusalEnvelope(snapshot.reason);

    const closeRequested = stage === "awaiting_confirm";
    const quickReply = await this.buildSessionActions(identity, {
      close: !closeRequested,
      confirm: closeRequested,
    });
    const summary =
      snapshot.parsed.items.length > 0
        ? buildWeighSessionSummary(snapshot.parsed)
        : GUIDED_MENU_COPY.noCapturedItems;

    return resultEnvelope(
      "session_status",
      buildCapturedItemsMessages({
        summary: [summary, "", GUIDED_MENU_COPY.correctionHint].join("\n"),
        quickReply,
        maxMessages: LINE_REPLY_MESSAGE_MAX,
      }),
      {
        item_count: snapshot.parsed.items.length,
        parse_error_count: snapshot.parsed.parse_errors.length,
        close_requested: closeRequested,
      },
    );
  }

  /** Slice 3C — hand the operator a ready-to-edit White Sheet closing command. */
  private async renderWhiteSheetStage(
    identity: GuidedMenuIdentity,
    context: GuidedJourneyContext,
  ): Promise<GuidedMenuUxResult> {
    const template = buildWhiteSheetTemplate(context);
    const dateThaiShort = thaiDateFromIso(context.businessDate);
    if (!template || !dateThaiShort) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()], {
        reason: "invalid_business_date",
      });
    }
    const quickReply = await this.buildJourneyActions(identity, "ดูสถานะ");
    return resultEnvelope(
      "white_sheet_template",
      buildWhiteSheetTemplateMessages({
        template,
        sellerLabel: context.sellerLabel,
        marketLabel: context.marketLabel,
        dateThaiShort,
        quickReply,
      }),
      {
        stage: "white_sheet",
        market_label_normalized: context.marketLabelNormalized,
        business_date: context.businessDate,
      },
    );
  }

  /** Slice 3D — hand the operator the existing slip batch header. */
  private async renderSlipStage(
    identity: GuidedMenuIdentity,
    context: GuidedJourneyContext,
  ): Promise<GuidedMenuUxResult> {
    const header = buildSlipHeaderTemplate(context);
    const dateThaiShort = thaiDateFromIso(context.businessDate);
    if (!header || !dateThaiShort) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()], {
        reason: "invalid_business_date",
      });
    }
    const quickReply = await this.buildJourneyActions(identity, "ตรวจยอด");
    return resultEnvelope(
      "slip_instructions",
      buildSlipInstructionMessages({
        header,
        sellerLabel: context.sellerLabel,
        marketLabel: context.marketLabel,
        dateThaiShort,
        quickReply,
      }),
      { stage: "slips", business_date: context.businessDate },
    );
  }

  /**
   * The journey-stage quick reply: one read-only status refresh plus the exit.
   * Closing the round is a text command (`ปิดรอบ`), deliberately not a shared
   * mutating token — see docs/guided-operations-end-to-end.md §2.5.
   */
  private async buildJourneyActions(
    identity: GuidedMenuIdentity,
    statusLabel: string,
  ): Promise<LineQuickReply | undefined> {
    try {
      const create = this.createTokenFn(identity);
      return bindQuickReply([
        {
          label: statusLabel,
          actionType: "view_status",
          payload: {},
          wireToken: await create({ actionType: "view_status", payload: {} }),
        },
        {
          label: "ออกจากเมนู",
          actionType: "menu_root",
          payload: { intent: "cancel" },
          wireToken: await create({
            actionType: "menu_root",
            payload: { intent: "cancel" },
          }),
        },
      ]);
    } catch {
      return undefined;
    }
  }

  private async requestClose(input: {
    identity: GuidedMenuIdentity;
    lineEventId: string;
    lineTimestampMs: number;
  }): Promise<GuidedMenuUxResult> {
    const outcome = await this.capture.requestClose({
      identity: input.identity,
      lineEventId: input.lineEventId,
      lineTimestampMs: input.lineTimestampMs,
    });
    if (outcome.status === "refused") return this.refusalEnvelope(outcome.reason);
    if (outcome.status === "conflict") {
      return resultEnvelope(
        "session_action_conflict",
        [buildSessionActionConflictMessage()],
        { reason: outcome.reason },
      );
    }

    const quickReply = await this.buildSessionActions(input.identity, {
      close: false,
      confirm: true,
    });
    const summary =
      outcome.parsed.items.length > 0
        ? buildWeighSessionSummary(outcome.parsed)
        : GUIDED_MENU_COPY.noCapturedItems;

    return resultEnvelope(
      "session_close_requested",
      buildCapturedItemsMessages({
        summary: [summary, "", GUIDED_MENU_COPY.closeRequested].join("\n"),
        quickReply,
        maxMessages: LINE_REPLY_MESSAGE_MAX,
      }),
      {
        close_reason: outcome.reason,
        item_count: outcome.parsed.items.length,
      },
    );
  }

  private async confirmFinalize(input: {
    identity: GuidedMenuIdentity;
    lineEventId: string;
  }): Promise<GuidedMenuUxResult> {
    const outcome = await this.capture.confirmFinalize({
      identity: input.identity,
      lineEventId: input.lineEventId,
    });
    if (outcome.status === "refused") return this.refusalEnvelope(outcome.reason);
    if (outcome.status === "not_ready") {
      // The barrier decides readiness, not this handler. Re-offer confirm.
      const quickReply = await this.buildSessionActions(input.identity, {
        close: false,
        confirm: true,
      });
      const message = buildFinalizeNotReadyMessage();
      return resultEnvelope(
        "session_finalize_not_ready",
        [quickReply ? { ...message, quickReply } : message],
        { reason: "not_ready", detail: outcome.detail ?? null },
      );
    }
    if (outcome.status === "conflict") {
      return resultEnvelope(
        "session_action_conflict",
        [buildSessionActionConflictMessage()],
        { reason: outcome.reason },
      );
    }

    // 3C handoff: the next stage is one button away — no command to remember.
    const quickReply = await this.buildJourneyActions(
      input.identity,
      "กรอกใบขาว",
    );
    return resultEnvelope(
      "session_finalize_confirmed",
      buildFinalizeConfirmedMessage({
        summary:
          outcome.parsed.items.length > 0
            ? buildWeighSessionSummary(outcome.parsed)
            : GUIDED_MENU_COPY.noCapturedItems,
        maxMessages: LINE_REPLY_MESSAGE_MAX,
        quickReply,
      }),
      {
        confirm_reason: outcome.reason,
        item_count: outcome.parsed.items.length,
        next_step: "white_sheet",
      },
    );
  }

  private createTokenFn(identity: GuidedMenuIdentity): CreateToken {
    return async ({ actionType, payload }) => {
      const created = await this.state.createState({
        actionType,
        lineUserId: identity.lineUserId,
        sourceType: identity.sourceType,
        sourceId: identity.sourceId,
        sessionKey: identity.sessionKey,
        payload,
      } as CreateMenuStateInput);
      if (created.status !== "created") {
        throw new Error("guided menu state create refused");
      }
      return created.wireToken;
    };
  }

  private async buildTransactionTypeScreen(
    identity: GuidedMenuIdentity,
  ): Promise<GuidedMenuUxResult> {
    try {
      const create = this.createTokenFn(identity);
      const [withdraw, ret, damaged] = await Promise.all([
        create({
          actionType: "choose_transaction_type",
          payload: { transaction_type: "withdraw" },
        }),
        create({
          actionType: "choose_transaction_type",
          payload: { transaction_type: "return" },
        }),
        create({
          actionType: "choose_transaction_type",
          payload: { transaction_type: "damaged_return" },
        }),
      ]);
      const message = buildTransactionTypeMessage({
        withdraw,
        return: ret,
        damagedReturn: damaged,
      });
      return resultEnvelope("transaction_type", [message]);
    } catch {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
  }

  private async buildSellerScreen(
    identity: GuidedMenuIdentity,
    transactionType: MenuTransactionTypeCode,
  ): Promise<GuidedMenuUxResult> {
    const sellers = await this.state.listActiveSellers();
    if (sellers.length === 0) {
      return resultEnvelope("no_sellers", [buildNoActiveSellersMessage()]);
    }
    if (sellers.length > SELLERS_PER_MESSAGE * LINE_REPLY_MESSAGE_MAX) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
    try {
      const create = this.createTokenFn(identity);
      const [sellerEntries, backToken, cancelToken] = await Promise.all([
        Promise.all(
          sellers.map(async (seller) => [
            seller.sellerCode,
            await create({
              actionType: "choose_seller",
              payload: {
                transaction_type: transactionType,
                seller_code: seller.sellerCode,
              },
            }),
          ] as const),
        ),
        create({ actionType: "menu_root", payload: {} }),
        create({ actionType: "menu_root", payload: { intent: "cancel" } }),
      ]);
      const sellerTokens = new Map(sellerEntries);
      const messages = buildSellerSelectMessages({
        transactionType,
        sellers,
        sellerTokens,
        backToken,
        cancelToken,
      });
      return resultEnvelope("seller", messages, {
        transaction_type: transactionType,
      });
    } catch {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
  }

  private async buildMarketScreen(
    identity: GuidedMenuIdentity,
    transactionType: MenuTransactionTypeCode,
    seller: GuidedMenuSeller,
    assignments: GuidedMenuSellerMarket[],
  ): Promise<GuidedMenuUxResult> {
    const markets = assignments.map((row) => ({
      code: row.marketCode,
      label: row.marketLabel,
    }));
    if (markets.length === 0) {
      return resultEnvelope("no_seller_markets", [
        buildNoActiveSellerMarketsMessage(),
      ]);
    }
    try {
      const create = this.createTokenFn(identity);
      const marketTokens = new Map<string, string>();
      for (const market of markets) {
        const token = await create({
          actionType: "choose_market",
          payload: {
            transaction_type: transactionType,
            seller_code: seller.sellerCode,
            market_code: market.code,
          },
        });
        marketTokens.set(market.code, token);
      }
      const [backToken, cancelToken] = await Promise.all([
        create({
          actionType: "choose_transaction_type",
          payload: { transaction_type: transactionType },
        }),
        create({ actionType: "menu_root", payload: { intent: "cancel" } }),
      ]);
      const message = buildMarketSelectMessage({
        transactionType,
        sellerLabel: seller.label,
        markets,
        marketTokens,
        backToken,
        cancelToken,
      });
      return resultEnvelope("market", [message], {
        transaction_type: transactionType,
        seller_code: seller.sellerCode,
      });
    } catch {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
  }

  private async buildDateScreen(
    identity: GuidedMenuIdentity,
    transactionType: MenuTransactionTypeCode,
    seller: GuidedMenuSeller,
    market: GuidedMenuMarketOption,
  ): Promise<GuidedMenuUxResult> {
    try {
      const create = this.createTokenFn(identity);
      const base = {
        transaction_type: transactionType,
        seller_code: seller.sellerCode,
        market_code: market.code,
      };
      const [todayToken, yesterdayToken, backToken, cancelToken] =
        await Promise.all([
          create({
            actionType: "choose_date",
            payload: { ...base, date_mode: "today" },
          }),
          create({
            actionType: "choose_date",
            payload: { ...base, date_mode: "yesterday" },
          }),
          create({
            actionType: "choose_seller",
            payload: {
              transaction_type: transactionType,
              seller_code: seller.sellerCode,
            },
          }),
          create({ actionType: "menu_root", payload: { intent: "cancel" } }),
        ]);
      const message = buildDateSelectMessage({
        transactionType,
        sellerLabel: seller.label,
        marketLabel: market.label,
        todayToken,
        yesterdayToken,
        backToken,
        cancelToken,
      });
      return resultEnvelope("date", [message], base);
    } catch {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
  }

  private async buildConfirmScreen(
    identity: GuidedMenuIdentity,
    transactionType: MenuTransactionTypeCode,
    seller: GuidedMenuSeller,
    market: GuidedMenuMarketOption,
    dateMode: Extract<MenuDateMode, "today" | "yesterday">,
    lineTimestampMs: number,
  ): Promise<GuidedMenuUxResult> {
    const resolved = resolveGuidedMenuDate(dateMode, lineTimestampMs);
    if (!resolved) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    try {
      const create = this.createTokenFn(identity);
      const selection: MenuPayloadByAction["confirm_open"] = {
        transaction_type: transactionType,
        seller_code: seller.sellerCode,
        market_code: market.code,
        date_mode: dateMode,
      };
      const [confirmToken, backToken, cancelToken] = await Promise.all([
        create({ actionType: "confirm_open", payload: selection }),
        create({
          actionType: "choose_market",
          payload: {
            transaction_type: transactionType,
            seller_code: seller.sellerCode,
            market_code: market.code,
          },
        }),
        create({ actionType: "menu_root", payload: { intent: "cancel" } }),
      ]);

      const message = buildConfirmPreviewMessage({
        transactionType,
        sellerLabel: seller.label,
        marketLabel: market.label,
        dateThaiShort: resolved.thaiShort,
        confirmToken,
        backToken,
        cancelToken,
      });

      return resultEnvelope("confirm", [message], {
        transaction_type: transactionType,
        seller_code: seller.sellerCode,
        market_code: market.code,
        date_mode: dateMode,
        business_date_iso: resolved.iso,
      });
    } catch {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
  }
}

export function buildGuidedMenuIdentity(input: {
  lineUserId: string | null | undefined;
  sourceType: string;
  sourceId: string;
  sessionKey: string | null;
}): GuidedMenuIdentity | null {
  const lineUserId = (input.lineUserId ?? "").trim();
  if (!lineUserId) return null;
  const sourceType = asSourceType(input.sourceType);
  if (!sourceType) return null;
  const sourceId = input.sourceId.trim();
  if (!sourceId || sourceId === "unknown") return null;
  return {
    lineUserId,
    sourceType,
    sourceId,
    sessionKey: input.sessionKey,
  };
}
