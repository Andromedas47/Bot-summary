import {
  findMarketOption,
  isKnownMarketId,
  OTHER_MARKET_ID,
  PREVIEW_STAFF_LABEL,
} from "./config";
import {
  toPreviewCloseProduceSessionCommand,
  toPreviewOpenProduceSessionCommand,
} from "./command-adapter";
import { resolveGuidedBusinessDate } from "./dates";
import {
  applyCloseBarrierMatched,
  applyCloseBarrierWaiting,
  applyScenarioToSession,
  emptySessionIntake,
} from "./fixtures";
import {
  buildActiveSessionOpenedMessage,
  buildCloseBarrierMessage,
  buildCompactAckMessage,
  buildConfirmOpenFlex,
  buildCustomDatePrompt,
  buildDateSelectFlex,
  buildErrorMessage,
  buildFinalConfirmFlex,
  buildMainMenuFlex,
  buildMarketSelectFlex,
  buildOtherMarketMessage,
  buildReviewBlockingFlex,
  buildReviewValidFlex,
  buildSessionStatusMessage,
  buildStartMenuFlex,
  buildSuccessMessage,
} from "./builders";
import { decodeGuidedMenuPostback, postbackData } from "./postback";
import {
  TX_CODE_TO_BASE,
  TX_CODE_TO_LABEL,
  type GuidedMenuActiveSession,
  type GuidedMenuFlowResult,
  type GuidedMenuSelection,
  type GuidedMenuTxCode,
  type GuidedProducePostbackV1,
} from "./types";

export function emptySelection(): GuidedMenuSelection {
  return {
    txCode: null,
    marketId: null,
    dateMode: null,
    customIsoDate: null,
  };
}

function baseResult(
  partial: Omit<GuidedMenuFlowResult, "previewOnly" | "openCommand" | "closeCommand" | "error"> & {
    openCommand?: GuidedMenuFlowResult["openCommand"];
    closeCommand?: GuidedMenuFlowResult["closeCommand"];
    error?: string | null;
  },
): GuidedMenuFlowResult {
  return {
    previewOnly: true,
    openCommand: partial.openCommand ?? null,
    closeCommand: partial.closeCommand ?? null,
    error: partial.error ?? null,
    screen: partial.screen,
    messages: partial.messages,
    selection: partial.selection,
    activeSession: partial.activeSession,
  };
}

function selectionFromPayload(payload: GuidedProducePostbackV1): GuidedMenuSelection {
  return {
    txCode: payload.tx ?? null,
    marketId: payload.mid ?? null,
    dateMode: payload.dm ?? null,
    customIsoDate: payload.iso ?? null,
  };
}

function requireTx(sel: GuidedMenuSelection): GuidedMenuTxCode | null {
  return sel.txCode;
}

function buildConfirm(sel: GuidedMenuSelection, lineTimestampMs: number): GuidedMenuFlowResult | null {
  const tx = requireTx(sel);
  if (!tx || !sel.marketId || !sel.dateMode) return null;
  if (sel.marketId === OTHER_MARKET_ID) return null;

  const market = findMarketOption(sel.marketId);
  if (!market || !isKnownMarketId(sel.marketId)) return null;

  const resolved = resolveGuidedBusinessDate(sel.dateMode, lineTimestampMs, sel.customIsoDate);
  if (!resolved) return null;

  const transactionLabel = TX_CODE_TO_LABEL[tx];
  return baseResult({
    screen: "confirm_open",
    selection: sel,
    activeSession: null,
    messages: [
      buildConfirmOpenFlex({
        selection: sel,
        transactionLabel,
        marketLabel: market.label,
        businessDateThai: resolved.thai,
        businessDateIso: resolved.iso,
        staffLabel: PREVIEW_STAFF_LABEL,
      }),
    ],
  });
}

function reviewScreenFor(session: GuidedMenuActiveSession): GuidedMenuFlowResult {
  if (session.blockingIssueCount > 0 || session.issues.length > 0) {
    const next = { ...session, reviewStatus: "blocking" as const, persistedSimulated: false };
    return baseResult({
      screen: "review_blocking",
      selection: next.selection,
      activeSession: next,
      messages: [buildReviewBlockingFlex(next)],
    });
  }
  const next = { ...session, reviewStatus: "valid" as const, persistedSimulated: false };
  return baseResult({
    screen: "review_valid",
    selection: next.selection,
    activeSession: next,
    messages: [buildReviewValidFlex(next)],
  });
}

export function initialGuidedMenuFlow(): GuidedMenuFlowResult {
  return baseResult({
    screen: "start_menu",
    messages: [buildStartMenuFlex()],
    selection: emptySelection(),
    activeSession: null,
  });
}

/**
 * Pure guided-menu reducer for preview / future webhook adapter.
 * Never writes DB, never sends LINE, never synthesizes Thai headers.
 */
export function reduceGuidedMenuPostback(input: {
  data: string;
  selection: GuidedMenuSelection;
  activeSession: GuidedMenuActiveSession | null;
  lineTimestampMs: number;
}): GuidedMenuFlowResult {
  const decoded = decodeGuidedMenuPostback(input.data);
  if (!decoded.ok) {
    return baseResult({
      screen: "error",
      messages: [buildErrorMessage(decoded.reason)],
      selection: input.selection,
      activeSession: input.activeSession,
      error: decoded.reason,
    });
  }

  const payload = decoded.payload;
  const sel = selectionFromPayload(payload);

  switch (payload.a) {
    case "menu":
      return initialGuidedMenuFlow();

    case "start":
      return baseResult({
        screen: "main_menu",
        selection: emptySelection(),
        activeSession: null,
        messages: [buildMainMenuFlex()],
      });

    case "select_tx": {
      if (!payload.tx) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("missing_tx")],
          selection: emptySelection(),
          activeSession: null,
          error: "missing_tx",
        });
      }
      const next: GuidedMenuSelection = {
        txCode: payload.tx,
        marketId: null,
        dateMode: null,
        customIsoDate: null,
      };
      return baseResult({
        screen: "market_select",
        selection: next,
        activeSession: null,
        messages: [buildMarketSelectFlex(next)],
      });
    }

    case "select_market": {
      if (!payload.tx || !payload.mid) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("missing_market")],
          selection: sel,
          activeSession: null,
          error: "missing_market",
        });
      }
      if (!isKnownMarketId(payload.mid) || payload.mid === OTHER_MARKET_ID) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("unknown_market")],
          selection: sel,
          activeSession: null,
          error: "unknown_market",
        });
      }
      const next: GuidedMenuSelection = {
        txCode: payload.tx,
        marketId: payload.mid,
        dateMode: null,
        customIsoDate: null,
      };
      return baseResult({
        screen: "date_select",
        selection: next,
        activeSession: null,
        messages: [buildDateSelectFlex(next)],
      });
    }

    case "other_market": {
      if (!payload.tx) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("missing_tx")],
          selection: emptySelection(),
          activeSession: null,
          error: "missing_tx",
        });
      }
      const next: GuidedMenuSelection = {
        txCode: payload.tx,
        marketId: OTHER_MARKET_ID,
        dateMode: null,
        customIsoDate: null,
      };
      return baseResult({
        screen: "other_market",
        selection: next,
        activeSession: null,
        messages: [buildOtherMarketMessage(next)],
      });
    }

    case "select_date": {
      if (!payload.tx || !payload.mid || !payload.dm) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("incomplete_date_selection")],
          selection: sel,
          activeSession: null,
          error: "incomplete_date_selection",
        });
      }
      if (payload.dm === "custom") {
        const next: GuidedMenuSelection = {
          txCode: payload.tx,
          marketId: payload.mid,
          dateMode: "custom",
          customIsoDate: null,
        };
        return baseResult({
          screen: "custom_date",
          selection: next,
          activeSession: null,
          messages: [buildCustomDatePrompt(next)],
        });
      }
      const next: GuidedMenuSelection = {
        txCode: payload.tx,
        marketId: payload.mid,
        dateMode: payload.dm,
        customIsoDate: null,
      };
      const confirm = buildConfirm(next, input.lineTimestampMs);
      if (!confirm) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("cannot_resolve_date")],
          selection: next,
          activeSession: null,
          error: "cannot_resolve_date",
        });
      }
      return confirm;
    }

    case "custom_date": {
      if (!payload.tx || !payload.mid) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("incomplete_custom_date")],
          selection: sel,
          activeSession: null,
          error: "incomplete_custom_date",
        });
      }
      const next: GuidedMenuSelection = {
        txCode: payload.tx,
        marketId: payload.mid,
        dateMode: "custom",
        customIsoDate: null,
      };
      return baseResult({
        screen: "custom_date",
        selection: next,
        activeSession: null,
        messages: [buildCustomDatePrompt(next)],
      });
    }

    case "set_custom_date": {
      if (!payload.tx || !payload.mid || !payload.iso) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("missing_custom_iso")],
          selection: sel,
          activeSession: null,
          error: "missing_custom_iso",
        });
      }
      const next: GuidedMenuSelection = {
        txCode: payload.tx,
        marketId: payload.mid,
        dateMode: "custom",
        customIsoDate: payload.iso,
      };
      const confirm = buildConfirm(next, input.lineTimestampMs);
      if (!confirm) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("cannot_resolve_custom_date")],
          selection: next,
          activeSession: null,
          error: "cannot_resolve_custom_date",
        });
      }
      return confirm;
    }

    case "confirm_open": {
      const confirm = buildConfirm(sel, input.lineTimestampMs);
      if (!confirm) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("incomplete_confirmation")],
          selection: sel,
          activeSession: null,
          error: "incomplete_confirmation",
        });
      }
      return confirm;
    }

    case "edit_open": {
      if (!payload.tx || !payload.mid) {
        return baseResult({
          screen: "main_menu",
          selection: emptySelection(),
          activeSession: null,
          messages: [buildMainMenuFlex()],
        });
      }
      const next: GuidedMenuSelection = {
        txCode: payload.tx,
        marketId: payload.mid,
        dateMode: null,
        customIsoDate: null,
      };
      return baseResult({
        screen: "date_select",
        selection: next,
        activeSession: null,
        messages: [buildDateSelectFlex(next)],
      });
    }

    case "start_session": {
      if (
        input.activeSession
        && !input.activeSession.persistedSimulated
        && input.activeSession.reviewStatus !== "persisted_sim"
      ) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("session_already_open")],
          selection: input.selection,
          activeSession: input.activeSession,
          error: "session_already_open",
        });
      }
      if (!payload.tx) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("missing_tx_on_start")],
          selection: sel,
          activeSession: null,
          error: "missing_tx_on_start",
        });
      }
      const market = payload.mid ? findMarketOption(payload.mid) : null;
      if (!market || !payload.mid || payload.mid === OTHER_MARKET_ID || !isKnownMarketId(payload.mid)) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("invalid_market_on_start")],
          selection: sel,
          activeSession: null,
          error: "invalid_market_on_start",
        });
      }
      if (!payload.dm) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("missing_date_on_start")],
          selection: sel,
          activeSession: null,
          error: "missing_date_on_start",
        });
      }
      const resolved = resolveGuidedBusinessDate(payload.dm, input.lineTimestampMs, payload.iso);
      if (!resolved) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("invalid_date_on_start")],
          selection: sel,
          activeSession: null,
          error: "invalid_date_on_start",
        });
      }

      const openCommand = toPreviewOpenProduceSessionCommand({
        initialTransactionType: TX_CODE_TO_BASE[payload.tx],
        businessDate: resolved.iso,
        marketLabel: market.label,
        staffLabel: PREVIEW_STAFF_LABEL,
        lineTimestampMs: input.lineTimestampMs,
      });

      const activeSession: GuidedMenuActiveSession = {
        selection: {
          txCode: payload.tx,
          marketId: payload.mid,
          dateMode: payload.dm,
          customIsoDate: payload.iso ?? null,
        },
        marketLabel: market.label,
        businessDateIso: resolved.iso,
        businessDateThai: resolved.thai,
        transactionLabel: TX_CODE_TO_LABEL[payload.tx],
        baseTransactionType: TX_CODE_TO_BASE[payload.tx],
        staffLabel: PREVIEW_STAFF_LABEL,
        openedAtMs: input.lineTimestampMs,
        ...emptySessionIntake(),
      };

      return baseResult({
        screen: "active_session",
        selection: activeSession.selection,
        activeSession,
        messages: [buildActiveSessionOpenedMessage(activeSession)],
        openCommand,
      });
    }

    case "status": {
      if (!input.activeSession) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("no_active_session")],
          selection: input.selection,
          activeSession: null,
          error: "no_active_session",
        });
      }
      return baseResult({
        screen: "session_status",
        selection: input.activeSession.selection,
        activeSession: input.activeSession,
        messages: [buildSessionStatusMessage(input.activeSession)],
      });
    }

    case "show_ack": {
      if (!input.activeSession) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("no_active_session")],
          selection: input.selection,
          activeSession: null,
          error: "no_active_session",
        });
      }
      return baseResult({
        screen: "ack_compact",
        selection: input.activeSession.selection,
        activeSession: input.activeSession,
        messages: [buildCompactAckMessage(input.activeSession)],
      });
    }

    case "review_close":
    case "close_ask": {
      if (!input.activeSession) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("no_active_session")],
          selection: input.selection,
          activeSession: null,
          error: "no_active_session",
        });
      }
      // Close barrier first — does not imply persistence.
      const waiting = applyCloseBarrierWaiting(input.activeSession);
      return baseResult({
        screen: "close_barrier",
        selection: waiting.selection,
        activeSession: waiting,
        messages: [buildCloseBarrierMessage(waiting)],
      });
    }

    case "barrier_ready": {
      if (!input.activeSession) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("no_active_session")],
          selection: input.selection,
          activeSession: null,
          error: "no_active_session",
        });
      }
      // Close barrier cannot reach review until waiting/matched parity is ready.
      if (input.activeSession.closeBarrierStatus !== "waiting") {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("barrier_not_waiting")],
          selection: input.activeSession.selection,
          activeSession: input.activeSession,
          error: "barrier_not_waiting",
        });
      }
      if (input.activeSession.admittedEventCount > input.activeSession.ingestedEventCount) {
        // Preview advance: barrier_ready simulates ingest catch-up.
      }
      const matched = applyCloseBarrierMatched(input.activeSession);
      return reviewScreenFor(matched);
    }

    case "confirm_persist": {
      if (!input.activeSession) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("no_active_session")],
          selection: input.selection,
          activeSession: null,
          error: "no_active_session",
        });
      }
      if (input.activeSession.persistedSimulated) {
        return baseResult({
          screen: "success",
          selection: emptySelection(),
          activeSession: input.activeSession,
          messages: [buildSuccessMessage(input.activeSession)],
        });
      }
      // Blocking errors must never reach final confirmation.
      if (input.activeSession.blockingIssueCount > 0 || input.activeSession.issues.length > 0) {
        return reviewScreenFor(input.activeSession);
      }
      if (input.activeSession.reviewStatus === "awaiting_final") {
        return baseResult({
          screen: "final_confirm",
          selection: input.activeSession.selection,
          activeSession: input.activeSession,
          messages: [buildFinalConfirmFlex(input.activeSession)],
        });
      }
      const next: GuidedMenuActiveSession = {
        ...input.activeSession,
        reviewStatus: "awaiting_final",
        persistedSimulated: false,
      };
      return baseResult({
        screen: "final_confirm",
        selection: next.selection,
        activeSession: next,
        messages: [buildFinalConfirmFlex(next)],
      });
    }

    case "finalize": {
      if (!input.activeSession) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("no_active_session")],
          selection: input.selection,
          activeSession: null,
          error: "no_active_session",
        });
      }
      // Idempotent success — repeated finalize does not create a second transition.
      if (input.activeSession.persistedSimulated || input.activeSession.reviewStatus === "persisted_sim") {
        const closeCommand = toPreviewCloseProduceSessionCommand({
          observedItemCount: input.activeSession.parsedItemCount,
          lineTimestampMs: input.lineTimestampMs,
        });
        return baseResult({
          screen: "success",
          selection: emptySelection(),
          activeSession: input.activeSession,
          messages: [buildSuccessMessage(input.activeSession)],
          closeCommand,
        });
      }
      if (input.activeSession.blockingIssueCount > 0 || input.activeSession.issues.length > 0) {
        return reviewScreenFor(input.activeSession);
      }
      // Require explicit path through final_confirm (awaiting_final).
      if (input.activeSession.reviewStatus !== "awaiting_final") {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("finalize_requires_confirmation")],
          selection: input.activeSession.selection,
          activeSession: input.activeSession,
          error: "finalize_requires_confirmation",
        });
      }

      const closeCommand = toPreviewCloseProduceSessionCommand({
        observedItemCount: input.activeSession.parsedItemCount,
        lineTimestampMs: input.lineTimestampMs,
      });
      const done: GuidedMenuActiveSession = {
        ...input.activeSession,
        reviewStatus: "persisted_sim",
        persistedSimulated: true,
        closeBarrierStatus: "matched",
      };
      return baseResult({
        screen: "success",
        selection: emptySelection(),
        activeSession: done,
        messages: [buildSuccessMessage(done)],
        closeCommand,
      });
    }

    /** Legacy alias: must NOT finalize — routes to final_confirm or blocking review. */
    case "close_confirm": {
      if (!input.activeSession) {
        return baseResult({
          screen: "error",
          messages: [buildErrorMessage("no_active_session")],
          selection: input.selection,
          activeSession: null,
          error: "no_active_session",
        });
      }
      if (input.activeSession.closeBarrierStatus === "waiting") {
        return baseResult({
          screen: "close_barrier",
          selection: input.activeSession.selection,
          activeSession: input.activeSession,
          messages: [buildCloseBarrierMessage(input.activeSession)],
        });
      }
      if (input.activeSession.blockingIssueCount > 0) {
        return reviewScreenFor(input.activeSession);
      }
      const next: GuidedMenuActiveSession = {
        ...input.activeSession,
        reviewStatus: "awaiting_final",
        persistedSimulated: false,
      };
      return baseResult({
        screen: "final_confirm",
        selection: next.selection,
        activeSession: next,
        messages: [buildFinalConfirmFlex(next)],
      });
    }

    case "send_more":
    case "send_fix":
    case "close_cancel": {
      if (!input.activeSession) {
        return initialGuidedMenuFlow();
      }
      const resumed: GuidedMenuActiveSession = {
        ...input.activeSession,
        closeBarrierStatus: "idle",
        reviewStatus: input.activeSession.blockingIssueCount > 0 ? "blocking" : "none",
        persistedSimulated: false,
      };
      return baseResult({
        screen: "active_session",
        selection: resumed.selection,
        activeSession: resumed,
        messages: [buildActiveSessionOpenedMessage(resumed)],
      });
    }

    case "back_review": {
      if (!input.activeSession) {
        return initialGuidedMenuFlow();
      }
      return baseResult({
        screen: "session_status",
        selection: input.activeSession.selection,
        activeSession: input.activeSession,
        messages: [buildSessionStatusMessage(input.activeSession)],
      });
    }

    case "back": {
      if (input.activeSession && !payload.tx) {
        return baseResult({
          screen: "active_session",
          selection: input.activeSession.selection,
          activeSession: input.activeSession,
          messages: [buildActiveSessionOpenedMessage(input.activeSession)],
        });
      }
      if (payload.tx && payload.mid && payload.dm === "custom" && !payload.iso) {
        const next: GuidedMenuSelection = {
          txCode: payload.tx,
          marketId: payload.mid,
          dateMode: null,
          customIsoDate: null,
        };
        return baseResult({
          screen: "date_select",
          selection: next,
          activeSession: null,
          messages: [buildDateSelectFlex(next)],
        });
      }
      if (payload.tx && payload.mid && !payload.dm) {
        const next: GuidedMenuSelection = {
          txCode: payload.tx,
          marketId: null,
          dateMode: null,
          customIsoDate: null,
        };
        return baseResult({
          screen: "market_select",
          selection: next,
          activeSession: null,
          messages: [buildMarketSelectFlex(next)],
        });
      }
      if (payload.tx) {
        return baseResult({
          screen: "main_menu",
          selection: emptySelection(),
          activeSession: null,
          messages: [buildMainMenuFlex()],
        });
      }
      return initialGuidedMenuFlow();
    }

    default:
      return baseResult({
        screen: "error",
        messages: [buildErrorMessage("unhandled_action")],
        selection: input.selection,
        activeSession: input.activeSession,
        error: "unhandled_action",
      });
  }
}

/** Apply a validated custom ISO date from the preview UI into the flow. */
export function applyCustomDateInPreview(input: {
  selection: GuidedMenuSelection;
  iso: string;
  lineTimestampMs: number;
}): GuidedMenuFlowResult {
  if (!input.selection.txCode || !input.selection.marketId) {
    return baseResult({
      screen: "error",
      messages: [buildErrorMessage("incomplete_selection")],
      selection: input.selection,
      activeSession: null,
      error: "incomplete_selection",
    });
  }

  return reduceGuidedMenuPostback({
    data: postbackData("set_custom_date", {
      tx: input.selection.txCode,
      mid: input.selection.marketId,
      dm: "custom",
      iso: input.iso,
    }),
    selection: input.selection,
    activeSession: null,
    lineTimestampMs: input.lineTimestampMs,
  });
}

/** Preview helper: attach a scenario fixture to the active session. */
export function applyScenarioInPreview(input: {
  activeSession: GuidedMenuActiveSession;
  scenarioId: import("./types").PreviewScenarioId;
}): GuidedMenuFlowResult {
  const session = applyScenarioToSession(input.activeSession, input.scenarioId);
  if (session.closeBarrierStatus === "waiting") {
    return baseResult({
      screen: "close_barrier",
      selection: session.selection,
      activeSession: session,
      messages: [buildCloseBarrierMessage(session)],
    });
  }
  return baseResult({
    screen: "ack_compact",
    selection: session.selection,
    activeSession: session,
    messages: [buildCompactAckMessage(session)],
  });
}
