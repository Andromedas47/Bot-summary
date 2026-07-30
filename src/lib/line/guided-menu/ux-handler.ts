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
import {
  assertGuidedMenuMessageLimits,
  buildCancelledMessage,
  buildConfirmPlaceholderMessage,
  buildConfirmPreviewMessage,
  buildDateSelectMessage,
  buildNoActiveSellerMarketsMessage,
  buildNoActiveSellersMessage,
  buildSellerSelectMessages,
  buildSellerUnavailableMessage,
  buildInvalidMenuMessage,
  buildMarketSelectMessage,
  buildMarketUnavailableMessage,
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

  constructor(
    supabase: SupabaseClient,
    options: {
      stateService?: GuidedMenuStateService;
    } = {},
  ) {
    this.state = options.stateService ?? new GuidedMenuStateService(supabase);
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
    lineTimestampMs: number;
  }): Promise<GuidedMenuUxResult> {
    // Re-check operator on every navigation step (inactive mid-flow → refuse).
    const operator = await this.state.resolveOperator(input.identity.lineUserId);
    if (operator.status !== "mapped") {
      return resultEnvelope("unmapped", [buildUnmappedMessage()]);
    }

    if (input.actionType === "menu_root") {
      if (isCancelPayload(input.payload)) {
        return resultEnvelope("cancelled", [buildCancelledMessage()]);
      }
      return this.buildTransactionTypeScreen(input.identity);
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
      const sellerCode = input.payload.seller_code?.trim();
      const marketCode = input.payload.market_code?.trim();
      if (!sellerCode || !marketCode) {
        return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
      }
      const selection = await this.state.loadActiveSellerMarkets(sellerCode);
      if (!selection.seller) {
        return resultEnvelope("seller_unavailable", [
          buildSellerUnavailableMessage(),
        ]);
      }
      if (!selection.markets.some((row) => row.marketCode === marketCode)) {
        return resultEnvelope("market_unavailable", [
          buildMarketUnavailableMessage(),
        ]);
      }
      // UX boundary: no open/append/admission/ingest/close — placeholder only.
      return resultEnvelope(
        "confirm_placeholder",
        [buildConfirmPlaceholderMessage()],
        {
          opened: false,
          recorded: false,
          use_existing_method: true,
          note: GUIDED_MENU_COPY.confirmPlaceholder,
        },
      );
    }

    return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
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
