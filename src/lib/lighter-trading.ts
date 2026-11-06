/**
 * Lighter's trading API: nonces, transaction submission and lookup, orders,
 * fills and positions. Lighter's own HTTPS endpoints — deliberately NOT routed
 * through the Arbitrum anon-rpc transport, which carries JSON-RPC only.
 *
 * Submission is the dangerous part. `sendTx` returning 200 means "accepted
 * into the sequencer", not "filled", and a timeout means nothing at all. The
 * helpers here therefore never decide an outcome from the send alone: every
 * signed transaction carries its hash, computed offline, and is resolved by
 * looking it up and by reading the order it created.
 */

import { LighterApiError, request } from './lighter';
import type { SignedTx } from './lighter-signer';

/** A sendTx that takes longer than this is treated as an unknown outcome. */
export const SEND_TIMEOUT_MS = 15_000;

export async function nextNonce(accountIndex: number, apiKeyIndex: number): Promise<number> {
  const json = await request<{ nonce?: number }>(
    `/nextNonce?account_index=${accountIndex}&api_key_index=${apiKeyIndex}`,
  );
  if (typeof json.nonce !== 'number') throw new LighterApiError('Lighter returned no nonce.');
  return json.nonce;
}

export type SendOutcome =
  | { readonly kind: 'accepted'; readonly txHash: string }
  /** Lighter answered and refused it: nothing was sequenced. */
  | { readonly kind: 'rejected'; readonly code?: number; readonly message: string }
  /** No answer, or an answer that does not prove either way. */
  | { readonly kind: 'uncertain'; readonly message: string };

/**
 * A refusal that might really be "already have it". Resending the exact bytes
 * of an accepted tx is refused on its nonce, which is NOT evidence the
 * original failed.
 */
function isAmbiguousRefusal(message: string): boolean {
  return /nonce|duplicate|already/i.test(message);
}

export async function sendTx(tx: SignedTx, fetchImpl: typeof fetch = fetch): Promise<SendOutcome> {
  const body = new URLSearchParams({ tx_type: String(tx.txType), tx_info: tx.txInfo });
  let response: Response;
  try {
    response = await fetchImpl(`${LIGHTER_SEND_URL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: 'uncertain', message: `sendTx did not answer: ${(error as Error).message}` };
  }

  let json: { code?: number; message?: string; tx_hash?: string } | undefined;
  try {
    json = (await response.json()) as typeof json;
  } catch {
    // A gateway error page can arrive after the sequencer accepted the tx.
    return { kind: 'uncertain', message: `sendTx returned non-JSON (${response.status})` };
  }

  if (response.ok && json?.code === 200) {
    return { kind: 'accepted', txHash: json.tx_hash || tx.txHash };
  }
  const message = json?.message ?? `sendTx failed (${response.status})`;
  if (response.status >= 500 || isAmbiguousRefusal(message)) {
    return { kind: 'uncertain', message };
  }
  return { kind: 'rejected', ...(json?.code !== undefined ? { code: json.code } : {}), message };
}

const LIGHTER_SEND_URL = 'https://mainnet.zklighter.elliot.ai/api/v1/sendTx';

export type TxLookup =
  | { readonly found: false }
  | { readonly found: true; readonly status: number; readonly blockHeight?: number };

/** 21500 "transaction not found" is an answer, not an error. */
export async function lookupTx(txHash: string): Promise<TxLookup> {
  try {
    const json = await request<{ status?: number; block_height?: number }>(
      `/tx?by=hash&value=${encodeURIComponent(txHash)}`,
    );
    return {
      found: true,
      status: typeof json.status === 'number' ? json.status : -1,
      ...(typeof json.block_height === 'number' ? { blockHeight: json.block_height } : {}),
    };
  } catch (error) {
    if (error instanceof LighterApiError && error.code === 21500) return { found: false };
    throw error;
  }
}

/** Has Lighter recorded `publicKey` at this account's key slot? */
export async function isApiKeyRegistered(
  accountIndex: number,
  apiKeyIndex: number,
  publicKey: string,
): Promise<boolean> {
  let json: { api_keys?: { api_key_index?: number; public_key?: string }[] };
  try {
    json = await request(`/apikeys?account_index=${accountIndex}&api_key_index=${apiKeyIndex}`);
  } catch (error) {
    // 21109 "api key not found" is how an empty slot answers — the normal
    // state before ChangePubKey, so it must read as "no", not as a failure.
    if (error instanceof LighterApiError && error.code === 21109) return false;
    throw error;
  }
  const want = publicKey.toLowerCase().replace(/^0x/, '');
  return (json.api_keys ?? []).some(
    (k) => k.api_key_index === apiKeyIndex && (k.public_key ?? '').toLowerCase().replace(/^0x/, '') === want,
  );
}

export interface LighterOrder {
  readonly orderIndex: number;
  readonly clientOrderIndex: number;
  readonly marketIndex: number;
  readonly status: string;
  readonly isAsk: boolean;
  readonly initialBaseAmount: number;
  readonly filledBaseAmount: number;
  readonly filledQuoteAmount: number;
  readonly price: number;
  readonly reduceOnly: boolean;
}

interface RawOrder {
  order_index?: number;
  client_order_index?: number;
  market_index?: number;
  status?: string;
  is_ask?: boolean;
  initial_base_amount?: string;
  filled_base_amount?: string;
  filled_quote_amount?: string;
  price?: string;
  reduce_only?: boolean;
}

export function parseOrder(raw: RawOrder): LighterOrder {
  return {
    orderIndex: Number(raw.order_index),
    clientOrderIndex: Number(raw.client_order_index),
    marketIndex: Number(raw.market_index),
    status: String(raw.status ?? ''),
    isAsk: Boolean(raw.is_ask),
    initialBaseAmount: Number(raw.initial_base_amount ?? 0),
    filledBaseAmount: Number(raw.filled_base_amount ?? 0),
    filledQuoteAmount: Number(raw.filled_quote_amount ?? 0),
    price: Number(raw.price ?? 0),
    reduceOnly: Boolean(raw.reduce_only),
  };
}

/**
 * Find an order by OUR client order index. Active first (an IOC order is
 * briefly there), then the inactive history where every finished one lands.
 */
export async function findOrderByClientIndex(
  accountIndex: number,
  marketIndex: number,
  clientOrderIndex: number,
  authToken: string,
): Promise<LighterOrder | null> {
  const headers = { authorization: authToken };
  for (const path of [
    `/accountActiveOrders?account_index=${accountIndex}&market_id=${marketIndex}`,
    `/accountInactiveOrders?account_index=${accountIndex}&market_id=${marketIndex}&limit=50`,
  ]) {
    const json = await request<{ orders?: RawOrder[] }>(path, { headers });
    const match = (json.orders ?? []).find((o) => Number(o.client_order_index) === clientOrderIndex);
    if (match) return parseOrder(match);
  }
  return null;
}

export interface Fill {
  readonly price: number;
  readonly size: number;
  readonly usdAmount: number;
  /** Fee this account paid on the fill, in USDC, when Lighter reports it. */
  readonly feeUsd: number;
}

/** Fills for one order, for the execution price and the fees actually paid. */
export async function fetchOrderFills(
  accountIndex: number,
  marketIndex: number,
  orderIndex: number,
  authToken: string,
): Promise<Fill[]> {
  const json = await request<{
    trades?: {
      price?: string;
      size?: string;
      usd_amount?: string;
      taker_fee?: number | string;
      maker_fee?: number | string;
      ask_id?: number;
      bid_id?: number;
      ask_account_id?: number;
      bid_account_id?: number;
      is_maker_ask?: boolean;
    }[];
  }>(
    `/trades?account_index=${accountIndex}&market_id=${marketIndex}&order_index=${orderIndex}&sort_by=timestamp&limit=100`,
    { headers: { authorization: authToken } },
  );

  return (json.trades ?? [])
    .filter((t) => t.ask_id === orderIndex || t.bid_id === orderIndex)
    .map((t) => {
      const weAreAsk = t.ask_id === orderIndex;
      const weAreMaker = weAreAsk === Boolean(t.is_maker_ask);
      const usdAmount = Number(t.usd_amount ?? 0);
      // Lighter reports fees as an integer rate in millionths of notional.
      const rate = Number((weAreMaker ? t.maker_fee : t.taker_fee) ?? 0);
      return {
        price: Number(t.price ?? 0),
        size: Number(t.size ?? 0),
        usdAmount,
        feeUsd: Number.isFinite(rate) ? (usdAmount * rate) / 1_000_000 : 0,
      };
    });
}

export interface LighterPosition {
  readonly marketId: number;
  readonly symbol: string;
  /** +1 long, -1 short. */
  readonly sign: number;
  /** Absolute size in base units. */
  readonly size: number;
  readonly avgEntryPrice: number;
  readonly positionValue: number;
  readonly unrealizedPnl: number;
  readonly liquidationPrice: number;
  readonly allocatedMargin: number;
  /** Percent, e.g. "20.00" for 5x. */
  readonly initialMarginFraction: number;
}

export interface TradingAccount {
  readonly accountIndex: number;
  readonly collateral: number;
  readonly availableBalance: number;
  readonly positions: LighterPosition[];
}

export function parseAccount(accountIndex: number, json: { accounts?: Record<string, unknown>[] }): TradingAccount {
  const account = json.accounts?.[0];
  if (!account) {
    throw new LighterApiError(`Lighter returned no account for index ${accountIndex}.`);
  }
  const collateral = Number(account.collateral);
  if (!Number.isFinite(collateral)) {
    throw new LighterApiError(`Lighter account ${accountIndex} has no readable collateral.`);
  }
  const positions = ((account.positions as Record<string, unknown>[] | undefined) ?? [])
    .map((p) => ({
      marketId: Number(p.market_id),
      symbol: String(p.symbol ?? ''),
      sign: Number(p.sign ?? 0),
      size: Math.abs(Number(p.position ?? 0)),
      avgEntryPrice: Number(p.avg_entry_price ?? 0),
      positionValue: Number(p.position_value ?? 0),
      unrealizedPnl: Number(p.unrealized_pnl ?? 0),
      liquidationPrice: Number(p.liquidation_price ?? 0),
      allocatedMargin: Number(p.allocated_margin ?? 0),
      initialMarginFraction: Number(p.initial_margin_fraction ?? 0),
    }))
    .filter((p) => Number.isFinite(p.size) && p.size > 0);

  return {
    accountIndex,
    collateral,
    availableBalance: Number(account.available_balance ?? collateral),
    positions,
  };
}

export async function readTradingAccount(accountIndex: number): Promise<TradingAccount> {
  const json = await request<{ accounts?: Record<string, unknown>[] }>(
    `/account?by=index&value=${accountIndex}`,
  );
  return parseAccount(accountIndex, json);
}
