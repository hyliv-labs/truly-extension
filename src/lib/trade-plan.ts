/**
 * Validate a trade request and size it, before anything irreversible happens.
 *
 * Pure: the caller supplies the market (read live), the reference price and
 * the notes, so every rule here is testable offline. Two numbers are kept
 * apart throughout because confusing them is the classic margin bug:
 *
 *   margin   — USDC that actually leaves the pool for Lighter.
 *   notional — margin × leverage, the size of the position it backs.
 */

import type { DiscoveredNote } from './discovery';
import type { PerpMarket } from './lighter-markets';
import { MARGIN_FRACTION_SCALE } from './lighter-markets';
import { planUnshield, LIGHTER_MIN_UNITS, UnshieldError } from './unshield';
import {
  POOL_VETTING_FEE_BPS,
  RELAYER_BASE_FEE_BPS,
  RELAYER_FIXED_FEE_UNITS,
  estimateRelayerFeeUnits,
} from './config';

export type Direction = 'long' | 'short';

export type TradeErrorCode =
  | 'market-unavailable'
  | 'invalid-direction'
  | 'invalid-leverage'
  | 'invalid-margin'
  | 'below-lighter-minimum'
  | 'below-min-notional'
  | 'below-min-size'
  | 'insufficient-balance'
  | 'pending-asp';

export class TradeValidationError extends Error {
  constructor(
    readonly code: TradeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TradeValidationError';
  }
}

/** Worst price a market order accepts, away from the touch. */
export const SLIPPAGE_BPS = 100;

/**
 * Margin held back from sizing so slippage and fees cannot push the order over
 * the initial-margin requirement and get it cancelled for margin.
 */
export const MARGIN_BUFFER_BPS = 200;

/** Up to this much USDC is permitted for re-shield gas (paid in USDC later). */
export const RESHIELD_GAS_RESERVE_UNITS = 1_000_000n;

export interface TradeRequest {
  readonly marketId: number;
  readonly direction: Direction;
  /** USDC units (6 decimals). */
  readonly marginUnits: bigint;
  readonly leverage: number;
}

export interface TradeQuote {
  readonly marketId: number;
  readonly symbol: string;
  readonly direction: Direction;
  readonly orderType: 'market';
  readonly leverage: number;
  readonly maxLeverage: number;
  readonly marginUnits: string;
  /** What the order is sized from: margin less the safety buffer. */
  readonly sizingMarginUsd: number;
  readonly notionalUsd: number;
  readonly referencePrice: number;
  readonly estimatedSize: number;
  readonly sizeDecimals: number;
  readonly priceDecimals: number;
  /** Gross pool withdrawal; the relayer's fee comes out of this. */
  readonly grossWithdrawalUnits: string;
  readonly relayerFeeEstimateUnits: string;
  readonly expectedNetUnits: string;
  readonly takerFeePct: number;
  readonly takerFeeEstimateUsd: number;
  /** Paid on the way out, from what comes back. */
  readonly reshieldGasReserveUnits: string;
  readonly poolVettingFeeBps: number;
  readonly spendableUnits: string;
  readonly pendingAspUnits: string;
  readonly fundingSource: 'Privacy Pools';
  readonly warnings: string[];
}

/** Smallest gross withdrawal whose estimated net is at least `netUnits`. */
export function grossForNet(netUnits: bigint): bigint {
  const denominator = 10_000n - RELAYER_BASE_FEE_BPS;
  let gross = ((netUnits + RELAYER_FIXED_FEE_UNITS) * 10_000n + denominator - 1n) / denominator;
  const nets = (g: bigint) => g - estimateRelayerFeeUnits(g) >= netUnits;
  // The estimate floors its BPS part, so the closed form can be a unit or two
  // off in either direction; walk to the exact minimum.
  while (!nets(gross)) gross += 1n;
  while (gross > 1n && nets(gross - 1n)) gross -= 1n;
  return gross;
}

/** Initial margin fraction to send for a leverage, in Lighter's basis points. */
export function marginFractionFor(leverage: number): number {
  return Math.ceil(MARGIN_FRACTION_SCALE / leverage);
}

export function assertLeverage(market: PerpMarket, leverage: number): void {
  if (!Number.isInteger(leverage) || leverage < 1) {
    throw new TradeValidationError('invalid-leverage', 'Leverage must be a whole number of at least 1x.');
  }
  if (leverage > market.maxLeverage) {
    throw new TradeValidationError(
      'invalid-leverage',
      `${market.symbol} allows at most ${market.maxLeverage}x; ${leverage}x was requested.`,
    );
  }
  if (marginFractionFor(leverage) < market.minInitialMarginFraction) {
    throw new TradeValidationError('invalid-leverage', `${leverage}x is above ${market.symbol}'s margin limit.`);
  }
}

const usd = (units: bigint) => Number(units) / 1_000_000;
const fmt = (units: bigint) => `${usd(units).toFixed(2)} USDC`;

/** Base size from a USD notional at a price, floored to the market's step. */
export function baseSizeFor(notionalUsd: number, price: number, sizeDecimals: number): number {
  if (!(price > 0)) return 0;
  const scale = 10 ** sizeDecimals;
  return Math.floor((notionalUsd / price) * scale) / scale;
}

/**
 * Everything that can be checked without the pool: market, direction,
 * leverage, Lighter's minimums. Run before the (slow) pool scan.
 */
export function checkRequest(
  market: PerpMarket,
  request: TradeRequest,
  referencePrice: number,
): { sizingMarginUsd: number; notionalUsd: number; estimatedSize: number } {
  if (!market.tradable) {
    throw new TradeValidationError(
      'market-unavailable',
      `${market.symbol} is not tradable right now (${market.unavailableReason ?? 'unavailable'}).`,
    );
  }
  if (request.marketId !== market.marketId) {
    throw new TradeValidationError('market-unavailable', 'The market changed under this request.');
  }
  if (request.direction !== 'long' && request.direction !== 'short') {
    throw new TradeValidationError('invalid-direction', 'Choose LONG or SHORT.');
  }
  assertLeverage(market, request.leverage);
  if (request.marginUnits <= 0n) {
    throw new TradeValidationError('invalid-margin', 'Enter a margin amount in USDC.');
  }
  if (request.marginUnits < LIGHTER_MIN_UNITS) {
    throw new TradeValidationError(
      'below-lighter-minimum',
      `Lighter credits deposits of at least ${fmt(LIGHTER_MIN_UNITS)}, so margin must be at least that.`,
    );
  }
  if (!(referencePrice > 0)) {
    throw new TradeValidationError('market-unavailable', `${market.symbol} has no price right now.`);
  }

  const sizingMarginUsd = (usd(request.marginUnits) * (10_000 - MARGIN_BUFFER_BPS)) / 10_000;
  const notionalUsd = sizingMarginUsd * request.leverage;
  if (notionalUsd < market.minQuoteAmount) {
    throw new TradeValidationError(
      'below-min-notional',
      `${market.symbol} needs at least $${market.minQuoteAmount} notional; this is $${notionalUsd.toFixed(2)}. Raise margin or leverage.`,
    );
  }
  const estimatedSize = baseSizeFor(notionalUsd, referencePrice, market.sizeDecimals);
  if (estimatedSize < market.minBaseAmount || estimatedSize <= 0) {
    throw new TradeValidationError(
      'below-min-size',
      `${market.symbol}'s minimum size is ${market.minBaseAmount}; this would be ${estimatedSize}.`,
    );
  }
  return { sizingMarginUsd, notionalUsd, estimatedSize };
}

export function validateTrade(input: {
  readonly market: PerpMarket;
  readonly request: TradeRequest;
  readonly referencePrice: number;
  /** Notes the ASP has approved — the only ones a proof can spend. */
  readonly approvedNotes: readonly DiscoveredNote[];
  /** Notes still waiting on the ASP. Shown, never spent. */
  readonly pendingNotes: readonly DiscoveredNote[];
}): TradeQuote {
  const { market, request, referencePrice, approvedNotes, pendingNotes } = input;
  const { sizingMarginUsd, notionalUsd, estimatedSize } = checkRequest(market, request, referencePrice);

  const grossWanted = grossForNet(request.marginUnits);
  const spendable = approvedNotes.reduce((s, n) => s + n.value, 0n);
  const pending = pendingNotes.reduce((s, n) => s + n.value, 0n);

  let plan: ReturnType<typeof planUnshield>;
  try {
    plan = planUnshield(approvedNotes, grossWanted);
  } catch (error) {
    if (pending > 0n && pendingNotes.some((n) => n.value >= grossWanted)) {
      throw new TradeValidationError(
        'pending-asp',
        `${fmt(pending)} is still waiting for ASP approval and cannot be spent yet. Spendable now: ${fmt(spendable)}.`,
      );
    }
    throw new TradeValidationError(
      'insufficient-balance',
      error instanceof UnshieldError ? error.message : `Not enough spendable USDC in Privacy Pools.`,
    );
  }

  // The planner may spend a smaller note whole when it cannot reach the
  // target. Margin is a promise, so a plan that lands short is refused.
  if (plan.expectedNetUnits < request.marginUnits) {
    const maxNote = approvedNotes.reduce((m, n) => (n.value > m ? n.value : m), 0n);
    const pendingCovers = pendingNotes.some((n) => n.value >= grossWanted);
    throw new TradeValidationError(
      pendingCovers ? 'pending-asp' : 'insufficient-balance',
      `A single withdrawal can land at most ~${fmt(maxNote - estimateRelayerFeeUnits(maxNote))} after the relayer fee; ` +
        `${fmt(request.marginUnits)} margin needs ${fmt(grossWanted)} from one note.` +
        (pendingCovers ? ` A larger deposit is still waiting for ASP approval.` : ''),
    );
  }

  const warnings: string[] = [];
  if (plan.expectedNetUnits > request.marginUnits + 1_000_000n) {
    warnings.push(
      `The note is spent whole to avoid stranding a remainder, so ~${fmt(plan.expectedNetUnits - request.marginUnits)} extra lands on Lighter as unused collateral and returns at exit.`,
    );
  }
  if (pending > 0n) warnings.push(`${fmt(pending)} is waiting on ASP approval and is not counted.`);

  return {
    marketId: market.marketId,
    symbol: market.symbol,
    direction: request.direction,
    orderType: 'market',
    leverage: request.leverage,
    maxLeverage: market.maxLeverage,
    marginUnits: request.marginUnits.toString(),
    sizingMarginUsd,
    notionalUsd,
    referencePrice,
    estimatedSize,
    sizeDecimals: market.sizeDecimals,
    priceDecimals: market.priceDecimals,
    grossWithdrawalUnits: plan.amountUnits.toString(),
    relayerFeeEstimateUnits: estimateRelayerFeeUnits(plan.amountUnits).toString(),
    expectedNetUnits: plan.expectedNetUnits.toString(),
    takerFeePct: market.takerFeePct,
    takerFeeEstimateUsd: (notionalUsd * (market.takerFeePct || 0)) / 100,
    reshieldGasReserveUnits: RESHIELD_GAS_RESERVE_UNITS.toString(),
    poolVettingFeeBps: Number(POOL_VETTING_FEE_BPS),
    spendableUnits: spendable.toString(),
    pendingAspUnits: pending.toString(),
    fundingSource: 'Privacy Pools',
    warnings,
  };
}

export interface OrderSizing {
  readonly baseAmount: number;
  /** Scaled integer sent to the signer. */
  readonly baseAmountScaled: number;
  readonly worstPrice: number;
  readonly worstPriceScaled: number;
  readonly notionalUsd: number;
  readonly marginUsd: number;
}

/**
 * Size the real order from what Lighter actually credited — never from what
 * was requested. A deposit that landed short sizes down; one below the
 * market's minimum refuses, and the session goes to recovery.
 */
export function sizeMarketOrder(input: {
  readonly market: PerpMarket;
  readonly direction: Direction;
  readonly leverage: number;
  readonly requestedMarginUsd: number;
  readonly creditedUsd: number;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
}): OrderSizing {
  const { market, direction, leverage } = input;
  assertLeverage(market, leverage);

  const touch = direction === 'long' ? input.bestAsk : input.bestBid;
  if (!touch || !(touch > 0)) {
    throw new TradeValidationError('market-unavailable', `${market.symbol} has no ${direction === 'long' ? 'asks' : 'bids'} to fill against.`);
  }

  const marginUsd = Math.min(input.requestedMarginUsd, input.creditedUsd);
  const sizingMargin = (marginUsd * (10_000 - MARGIN_BUFFER_BPS)) / 10_000;
  const notionalUsd = sizingMargin * leverage;
  if (notionalUsd < market.minQuoteAmount) {
    throw new TradeValidationError(
      'below-min-notional',
      `Lighter credited $${input.creditedUsd.toFixed(2)}, which backs only $${notionalUsd.toFixed(2)} notional — under ${market.symbol}'s $${market.minQuoteAmount} minimum.`,
    );
  }

  const baseAmount = baseSizeFor(notionalUsd, touch, market.sizeDecimals);
  if (baseAmount < market.minBaseAmount || baseAmount <= 0) {
    throw new TradeValidationError('below-min-size', `${baseAmount} is under ${market.symbol}'s minimum size of ${market.minBaseAmount}.`);
  }

  return {
    baseAmount,
    baseAmountScaled: Math.round(baseAmount * 10 ** market.sizeDecimals),
    ...worstPrice(market, direction, touch),
    notionalUsd,
    marginUsd,
  };
}

/** The worst price a market order accepts, rounded away from the trader. */
export function worstPrice(
  market: Pick<PerpMarket, 'priceDecimals'>,
  direction: Direction,
  touch: number,
): { worstPrice: number; worstPriceScaled: number } {
  const scale = 10 ** market.priceDecimals;
  const slip = SLIPPAGE_BPS / 10_000;
  const worstPriceScaled =
    direction === 'long' ? Math.ceil(touch * (1 + slip) * scale) : Math.floor(touch * (1 - slip) * scale);
  if (worstPriceScaled <= 0 || worstPriceScaled > 0xffff_ffff) {
    throw new TradeValidationError('market-unavailable', 'The price does not fit Lighter\'s price field.');
  }
  return { worstPrice: worstPriceScaled / scale, worstPriceScaled };
}

/** A reduce-only order that flattens `size` of an open position. */
export function sizeCloseOrder(input: {
  readonly market: PerpMarket;
  readonly positionSign: number;
  readonly positionSize: number;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
}): { direction: Direction; baseAmountScaled: number; baseAmount: number; worstPrice: number; worstPriceScaled: number } {
  // Closing a long sells into the bids; closing a short buys the asks.
  const direction: Direction = input.positionSign > 0 ? 'short' : 'long';
  const touch = direction === 'long' ? input.bestAsk : input.bestBid;
  if (!touch || !(touch > 0)) {
    throw new TradeValidationError('market-unavailable', `${input.market.symbol} has no liquidity to close against.`);
  }
  const baseAmountScaled = Math.round(input.positionSize * 10 ** input.market.sizeDecimals);
  if (baseAmountScaled <= 0) throw new TradeValidationError('below-min-size', 'There is no position to close.');
  return {
    direction,
    baseAmountScaled,
    baseAmount: baseAmountScaled / 10 ** input.market.sizeDecimals,
    ...worstPrice(input.market, direction, touch),
  };
}

export type OrderOutcome =
  | { readonly state: 'pending' }
  | {
      readonly state: 'filled' | 'partially-filled' | 'unfilled';
      readonly filledBase: number;
      readonly filledQuote: number;
      readonly averagePrice: number | null;
      readonly status: string;
    };

/** Decide a Lighter order's outcome from its own record. Never assumes a fill. */
export function classifyOrder(
  order: { status: string; filledBaseAmount: number; filledQuoteAmount: number; initialBaseAmount: number },
  requestedBase: number,
): OrderOutcome {
  const status = order.status.toLowerCase();
  if (status === 'open' || status === 'pending' || status === 'in-progress') return { state: 'pending' };

  const filledBase = order.filledBaseAmount;
  const filledQuote = order.filledQuoteAmount;
  const averagePrice = filledBase > 0 ? filledQuote / filledBase : null;
  const target = Math.min(requestedBase, order.initialBaseAmount || requestedBase);
  // Half a step of tolerance for decimal-string rounding.
  const full = filledBase > 0 && filledBase + 1e-12 >= target;

  if (filledBase <= 0) return { state: 'unfilled', filledBase: 0, filledQuote: 0, averagePrice: null, status };
  return { state: full ? 'filled' : 'partially-filled', filledBase, filledQuote, averagePrice, status };
}
