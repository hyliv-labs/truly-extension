/**
 * Lighter perp markets, read live from `orderBookDetails`. Nothing is
 * hardcoded: market ids, decimals, minimums and the leverage cap all come from
 * this payload, and a market that is inactive, frozen, hidden or reduce-only
 * is shown as unavailable rather than offered.
 *
 * Lighter's own API, not a chain read, so it does not go through anon-rpc —
 * see the note in lighter.ts.
 */

import { request } from './lighter';

export interface PerpMarket {
  readonly marketId: number;
  readonly symbol: string;
  readonly tradable: boolean;
  /** Why the market cannot be traded, when it cannot. */
  readonly unavailableReason?: string;
  readonly sizeDecimals: number;
  readonly priceDecimals: number;
  /** In base units, e.g. 0.002 ETH. */
  readonly minBaseAmount: number;
  /** Minimum notional in USDC. */
  readonly minQuoteAmount: number;
  readonly markPrice: number;
  readonly lastPrice: number;
  readonly dailyChangePct: number;
  readonly dailyVolumeUsd: number;
  /** floor(10000 / min_initial_margin_fraction). */
  readonly maxLeverage: number;
  readonly minInitialMarginFraction: number;
  readonly maintenanceMarginFraction: number;
  /** Percent, as Lighter reports it ("0.0000" = 0%). */
  readonly takerFeePct: number;
}

/** Lighter expresses margin fractions in basis points of notional. */
export const MARGIN_FRACTION_SCALE = 10_000;

interface RawMarket {
  symbol?: unknown;
  market_id?: unknown;
  market_type?: unknown;
  status?: unknown;
  is_frozen?: unknown;
  taker_fee?: unknown;
  min_base_amount?: unknown;
  min_quote_amount?: unknown;
  size_decimals?: unknown;
  price_decimals?: unknown;
  min_initial_margin_fraction?: unknown;
  maintenance_margin_fraction?: unknown;
  mark_price?: unknown;
  last_trade_price?: unknown;
  daily_price_change?: unknown;
  daily_quote_token_volume?: unknown;
  market_config?: { hidden?: unknown; force_reduce_only?: unknown };
}

const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : NaN;
};

/** Parse one entry; null when a field the trade path depends on is missing. */
export function parseMarket(raw: RawMarket): PerpMarket | null {
  if (raw.market_type !== undefined && raw.market_type !== 'perp') return null;
  const marketId = num(raw.market_id);
  const sizeDecimals = num(raw.size_decimals);
  const priceDecimals = num(raw.price_decimals);
  const imf = num(raw.min_initial_margin_fraction);
  if (
    typeof raw.symbol !== 'string' ||
    !Number.isInteger(marketId) ||
    !Number.isInteger(sizeDecimals) ||
    !Number.isInteger(priceDecimals) ||
    !(imf > 0)
  ) {
    return null;
  }

  const markPrice = num(raw.mark_price);
  const lastPrice = num(raw.last_trade_price);
  const reasons: string[] = [];
  if (raw.status !== 'active') reasons.push(`status ${String(raw.status)}`);
  if (raw.is_frozen === true) reasons.push('frozen');
  if (raw.market_config?.hidden === true) reasons.push('hidden');
  if (raw.market_config?.force_reduce_only === true) reasons.push('reduce-only');
  if (!(markPrice > 0) && !(lastPrice > 0)) reasons.push('no price');

  return {
    marketId,
    symbol: raw.symbol,
    tradable: reasons.length === 0,
    ...(reasons.length ? { unavailableReason: reasons.join(', ') } : {}),
    sizeDecimals,
    priceDecimals,
    minBaseAmount: num(raw.min_base_amount),
    minQuoteAmount: num(raw.min_quote_amount),
    markPrice,
    lastPrice,
    dailyChangePct: num(raw.daily_price_change),
    dailyVolumeUsd: num(raw.daily_quote_token_volume),
    maxLeverage: Math.floor(MARGIN_FRACTION_SCALE / imf),
    minInitialMarginFraction: imf,
    maintenanceMarginFraction: num(raw.maintenance_margin_fraction),
    takerFeePct: num(raw.taker_fee),
  };
}

/** Busiest first, so the selector opens on markets with real liquidity. */
export function parseMarkets(json: { order_book_details?: RawMarket[] }): PerpMarket[] {
  const markets = (json.order_book_details ?? [])
    .map(parseMarket)
    .filter((m): m is PerpMarket => m !== null);
  return markets.sort((a, b) => (b.dailyVolumeUsd || 0) - (a.dailyVolumeUsd || 0));
}

export async function fetchMarkets(): Promise<PerpMarket[]> {
  const json = await request<{ order_book_details?: RawMarket[] }>('/orderBookDetails?filter=perp');
  const markets = parseMarkets(json);
  if (markets.length === 0) throw new Error('Lighter returned no perp markets.');
  return markets;
}

/** Always a fresh read: the decimals and leverage cap must be current when signing. */
export async function fetchMarket(marketId: number): Promise<PerpMarket> {
  const json = await request<{ order_book_details?: RawMarket[] }>(
    `/orderBookDetails?market_id=${marketId}`,
  );
  const market = parseMarkets(json).find((m) => m.marketId === marketId);
  if (!market) throw new Error(`Lighter market ${marketId} is not available.`);
  return market;
}

export interface TopOfBook {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
}

export async function fetchTopOfBook(marketId: number): Promise<TopOfBook> {
  const json = await request<{ bids?: { price?: string }[]; asks?: { price?: string }[] }>(
    `/orderBookOrders?market_id=${marketId}&limit=1`,
  );
  const bid = num(json.bids?.[0]?.price);
  const ask = num(json.asks?.[0]?.price);
  return { bestBid: bid > 0 ? bid : null, bestAsk: ask > 0 ? ask : null };
}

/** The price a quote is shown at: mark, falling back to the last trade. */
export function referencePrice(market: PerpMarket): number {
  return market.markPrice > 0 ? market.markPrice : market.lastPrice;
}
