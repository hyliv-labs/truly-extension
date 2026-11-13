/**
 * NEAR Intents 1Click API: the cross-chain leg of Ghosty.
 *
 * 1Click quotes a swap from solvers and returns a one-time deposit address.
 * Whatever lands there is swapped and delivered on the destination chain;
 * anything that cannot be delivered goes back to `refundTo`. Ghosty uses it
 * in two directions:
 *
 *   exit:  Railgun unshield -> 1Click deposit address -> any chain / asset
 *   entry: any chain / asset -> 1Click deposit address -> fresh owner -> Railgun
 *
 * This file has no chrome.* and no wallet code, so the checks run in Node.
 * Every quote is checked against what was asked before money moves: a quote
 * echoing a different recipient, asset or amount is refused, not "fixed".
 *
 * Docs: https://docs.near-intents.org/integration/distribution-channels/1click-api
 */

export const ONE_CLICK_BASE = 'https://1click.chaindefuser.com';

/** USDC on Arbitrum, as 1Click names it. Railgun's shielded asset in Ghosty. */
export const ARB_USDC_ASSET = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near';

/** Railgun takes this on every unshield, inclusive of the amount sent. */
export const BASIS_POINTS = 10_000n;

export type SwapType = 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT';
export type Confidentiality = 'public' | 'basic' | 'advanced';

export interface OneClickToken {
  readonly assetId: string;
  readonly decimals: number;
  readonly blockchain: string;
  readonly symbol: string;
  readonly price?: number;
  readonly contractAddress?: string | null;
}

export interface QuoteRequest {
  readonly dry: boolean;
  readonly swapType: SwapType;
  readonly slippageTolerance: number;
  readonly originAsset: string;
  readonly depositType: 'ORIGIN_CHAIN';
  readonly destinationAsset: string;
  readonly amount: string;
  readonly refundTo: string;
  readonly refundType: 'ORIGIN_CHAIN';
  readonly recipient: string;
  readonly recipientType: 'DESTINATION_CHAIN';
  readonly deadline: string;
  readonly referral?: string;
  readonly confidentiality?: Confidentiality;
}

export interface Quote {
  readonly amountIn: string;
  readonly amountInFormatted: string;
  /** FLEX_INPUT: the smallest total deposit that still swaps. */
  readonly minAmountIn?: string;
  readonly amountOut: string;
  readonly amountOutFormatted: string;
  readonly amountOutUsd?: string;
  readonly minAmountOut: string;
  readonly timeEstimate: number;
  readonly deadline?: string;
  readonly timeWhenInactive?: string;
  readonly depositAddress?: string;
  readonly depositMemo?: string | null;
  readonly refundFee?: string;
  readonly withdrawFee?: string;
}

export interface QuoteResponse {
  readonly quote: Quote;
  readonly quoteRequest: QuoteRequest & Record<string, unknown>;
  readonly signature: string;
  readonly timestamp: string;
  readonly correlationId: string;
}

export type SwapStatus =
  | 'PENDING_DEPOSIT'
  | 'KNOWN_DEPOSIT_TX'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'INCOMPLETE_DEPOSIT'
  | 'REFUNDED'
  | 'FAILED';

export interface ChainTx {
  readonly hash: string;
  readonly explorerUrl?: string;
}

export interface StatusResponse {
  readonly status: SwapStatus;
  readonly updatedAt: string;
  readonly swapDetails?: {
    readonly amountOut?: string | null;
    readonly amountOutFormatted?: string | null;
    readonly depositedAmount?: string | null;
    readonly depositedAmountFormatted?: string | null;
    readonly refundedAmount?: string | null;
    readonly refundedAmountFormatted?: string | null;
    readonly refundReason?: string | null;
    readonly originChainTxHashes?: ChainTx[];
    readonly destinationChainTxHashes?: ChainTx[];
  };
}

/** Terminal: 1Click will not move these funds again on its own. */
export const TERMINAL_STATUSES: readonly SwapStatus[] = ['SUCCESS', 'REFUNDED', 'FAILED'];

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'OneClickError';
  }
}

export interface OneClickClient {
  tokens(): Promise<OneClickToken[]>;
  quote(request: QuoteRequest): Promise<QuoteResponse>;
  status(depositAddress: string, depositMemo?: string | null): Promise<StatusResponse>;
  submitDeposit(depositAddress: string, txHash: string, memo?: string | null): Promise<void>;
}

/**
 * The partner key is optional. Without it 1Click charges a little more and
 * refuses Confidential quotes. A JWT goes in Authorization, a plain key in
 * X-API-Key, matching the two schemes 1Click documents.
 */
export function authHeaders(apiKey: string | null | undefined): Record<string, string> {
  const key = apiKey?.trim();
  if (!key) return {};
  return key.split('.').length === 3 ? { Authorization: `Bearer ${key}` } : { 'X-API-Key': key };
}

export function createOneClickClient(options: {
  apiKey?: string | null;
  fetch?: typeof fetch;
  base?: string;
} = {}): OneClickClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.base ?? ONE_CLICK_BASE;
  const headers = { 'content-type': 'application/json', ...authHeaders(options.apiKey) };

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await doFetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Left null: the message below says what came back.
    }
    if (!response.ok) {
      const said = body && typeof body === 'object' && 'message' in body ? String((body as { message: unknown }).message) : '';
      throw new OneClickError(said || `1Click answered ${response.status}.`, response.status);
    }
    return body as T;
  }

  return {
    tokens: () => call<OneClickToken[]>('/v0/tokens'),
    quote: (request) => call<QuoteResponse>('/v0/quote', { method: 'POST', body: JSON.stringify(request) }),
    status: (depositAddress, depositMemo) => {
      const query = new URLSearchParams({ depositAddress });
      if (depositMemo) query.set('depositMemo', depositMemo);
      return call<StatusResponse>(`/v0/status?${query.toString()}`);
    },
    submitDeposit: async (depositAddress, txHash, memo) => {
      await call<unknown>('/v0/deposit/submit', {
        method: 'POST',
        body: JSON.stringify(memo ? { depositAddress, txHash, memo } : { depositAddress, txHash }),
      });
    },
  };
}

/**
 * What arrives when Railgun unshields `grossUnits`. The contract's fee is
 * inclusive: base = amount - floor(amount * bps / 10000). Measured on
 * Arbitrum: 9,814,800 at 25 bps arrived as 9,790,263.
 *
 * The exit quotes THIS number. Going the other way (net -> gross, rounding
 * up) can put one unit more on the deposit address than the quote expects,
 * and 1Click refunds the excess with a refund fee.
 */
export function railgunNetForGross(grossUnits: bigint, feeBps: bigint): bigint {
  if (grossUnits <= 0n) throw new OneClickError('The amount must be positive.');
  if (feeBps < 0n || feeBps >= BASIS_POINTS) throw new OneClickError('The Railgun fee is not a usable rate.');
  return grossUnits - (grossUnits * feeBps) / BASIS_POINTS;
}

/** A deadline `minutes` from `now`, in the ISO form 1Click accepts. */
export function deadlineIn(minutes: number, now = Date.now()): string {
  return new Date(now + minutes * 60_000).toISOString();
}

export function buildQuoteRequest(input: {
  dry: boolean;
  originAsset: string;
  destinationAsset: string;
  amountUnits: bigint;
  recipient: string;
  refundTo: string;
  slippageBps: number;
  deadlineMinutes: number;
  confidential?: boolean;
  /**
   * EXACT_INPUT (default) when Ghosty sends the deposit itself and knows it to
   * the unit. FLEX_INPUT when a person pays from their own wallet: an exchange
   * that takes its fee out of the amount, or a second payment to make up a
   * short one, still swaps. 1Click does not offer FLEX_INPUT confidentially.
   */
  swapType?: 'EXACT_INPUT' | 'FLEX_INPUT';
  now?: number;
}): QuoteRequest {
  if (input.amountUnits <= 0n) throw new OneClickError('The amount must be positive.');
  const swapType = input.swapType ?? 'EXACT_INPUT';
  if (swapType === 'FLEX_INPUT' && input.confidential) {
    throw new OneClickError('NEAR Intents does not offer a flexible amount in Confidential mode.');
  }
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 1_000) {
    throw new OneClickError('Slippage must be between 0 and 10%.');
  }
  if (input.originAsset === input.destinationAsset) {
    throw new OneClickError('Origin and destination are the same asset.');
  }
  return {
    dry: input.dry,
    swapType,
    slippageTolerance: input.slippageBps,
    originAsset: input.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: input.destinationAsset,
    amount: input.amountUnits.toString(),
    refundTo: input.refundTo.trim(),
    refundType: 'ORIGIN_CHAIN',
    recipient: input.recipient.trim(),
    recipientType: 'DESTINATION_CHAIN',
    deadline: deadlineIn(input.deadlineMinutes, input.now),
    referral: 'ghosty',
    ...(input.confidential ? { confidentiality: 'basic' as const } : {}),
  };
}

/**
 * Refuse a quote that does not answer the request that was sent. Money only
 * moves on a quote that passed this. Returns the checked quote.
 */
export function checkQuote(request: QuoteRequest, response: QuoteResponse, now = Date.now()): Quote {
  const quote = response?.quote;
  const echo = response?.quoteRequest;
  if (!quote || !echo) throw new OneClickError('1Click returned no quote.');

  // Asset ids and EVM addresses compare without case; every other address
  // (base58 Solana, Zcash t-addresses, ...) is case-sensitive and must match exactly.
  const sameId = (a: string | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();
  const sameAddress = (a: string | undefined, b: string) =>
    /^0x[0-9a-fA-F]{40}$/.test(b) ? (a ?? '').toLowerCase() === b.toLowerCase() : (a ?? '') === b;
  const mismatches: string[] = [];
  if (!sameId(echo.originAsset, request.originAsset)) mismatches.push('origin asset');
  if (!sameId(echo.destinationAsset, request.destinationAsset)) mismatches.push('destination asset');
  if (!sameAddress(echo.recipient, request.recipient)) mismatches.push('recipient');
  if (!sameAddress(echo.refundTo, request.refundTo)) mismatches.push('refund address');
  if (echo.swapType !== request.swapType) mismatches.push('swap type');
  if (echo.amount !== request.amount) mismatches.push('amount');
  // A refund to an Intents account, or delivery anywhere but the chain, would
  // land where Ghosty never looks; nothing shields it back.
  if (echo.refundType !== request.refundType) mismatches.push('refund type');
  if (echo.recipientType !== request.recipientType) mismatches.push('recipient type');
  if (echo.depositType !== request.depositType) mismatches.push('deposit type');
  if (Boolean(echo.dry) !== request.dry) mismatches.push('dry flag');
  if (Number(echo.slippageTolerance) !== request.slippageTolerance) mismatches.push('slippage');
  if (Date.parse(String(echo.deadline ?? '')) !== Date.parse(request.deadline)) mismatches.push('deadline');
  if (mismatches.length > 0) {
    throw new OneClickError(`1Click quoted a different ${mismatches.join(', ')} from the one asked for. Nothing was sent.`);
  }

  // EXACT_INPUT: the deposit must be exactly this. More is refunded with a
  // fee, less is refunded whole; either way the swap does not happen.
  // FLEX_INPUT quotes the same amountIn, plus a floor the total may fall to.
  if (quote.amountIn !== request.amount) {
    throw new OneClickError(`1Click wants ${quote.amountIn} units in, not the ${request.amount} asked for. Nothing was sent.`);
  }
  if (request.swapType === 'FLEX_INPUT') {
    const floor = quote.minAmountIn ?? '';
    if (!/^\d+$/.test(floor) || BigInt(floor) <= 0n || BigInt(floor) > BigInt(quote.amountIn)) {
      throw new OneClickError('1Click returned no usable minimum deposit for a flexible quote. Nothing was sent.');
    }
  }
  if (!/^\d+$/.test(quote.amountOut ?? '') || BigInt(quote.amountOut) <= 0n) {
    throw new OneClickError('1Click quoted nothing out for this amount. Nothing was sent.');
  }
  if (!/^\d+$/.test(quote.minAmountOut ?? '') || BigInt(quote.minAmountOut) > BigInt(quote.amountOut)) {
    throw new OneClickError('1Click quoted a minimum above the expected amount. Nothing was sent.');
  }
  // The guaranteed minimum must be within the slippage asked for (plus 1 bp of
  // rounding). Otherwise "min 0" would pass, and the swap could deliver nothing.
  const floorBps = BigInt(Math.max(0, 10_000 - request.slippageTolerance - 1));
  if (BigInt(quote.minAmountOut) * 10_000n < BigInt(quote.amountOut) * floorBps) {
    throw new OneClickError('1Click guaranteed less than the slippage allows. Nothing was sent.');
  }

  if (!request.dry) {
    if (!quote.depositAddress) throw new OneClickError('1Click returned no deposit address. Nothing was sent.');
    // An exit pays the deposit address with a Railgun unshield on Arbitrum: it
    // must be an EVM address, and an unshield cannot carry a memo.
    if (sameId(request.originAsset, ARB_USDC_ASSET)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(quote.depositAddress)) throw new OneClickError('1Click returned a deposit address that is not an Arbitrum address. Nothing was sent.');
      if (quote.depositMemo) throw new OneClickError('1Click asked for a memo, which a Railgun unshield cannot send. Nothing was sent.');
    }
    if (!response.signature || !response.correlationId) {
      throw new OneClickError('1Click returned an unsigned quote. Nothing was sent.');
    }
    const inactive = Date.parse(quote.timeWhenInactive ?? quote.deadline ?? '');
    if (!Number.isFinite(inactive) || inactive <= now) {
      throw new OneClickError('1Click returned a deposit address that is already inactive. Nothing was sent.');
    }
  }
  return quote;
}

/** One quote round: build, ask, check. */
export async function getQuote(
  client: OneClickClient,
  input: Parameters<typeof buildQuoteRequest>[0],
): Promise<{ request: QuoteRequest; response: QuoteResponse; quote: Quote }> {
  const request = buildQuoteRequest(input);
  const response = await client.quote(request);
  return { request, response, quote: checkQuote(request, response, input.now) };
}

/** Last tx hash 1Click reports on the destination chain, if any. */
export function destinationTx(status: StatusResponse): ChainTx | null {
  const list = status.swapDetails?.destinationChainTxHashes ?? [];
  return list.at(-1) ?? null;
}

/** A plain sentence for each 1Click state, for the panel. */
export function describeStatus(status: SwapStatus, direction: 'exit' | 'entry'): string {
  switch (status) {
    case 'PENDING_DEPOSIT':
      return direction === 'exit' ? 'Waiting for 1Click to see the unshield.' : 'Waiting for your deposit.';
    case 'KNOWN_DEPOSIT_TX':
      return '1Click has seen the deposit and is waiting for it to confirm.';
    case 'PROCESSING':
      return 'Solvers are filling the swap.';
    case 'SUCCESS':
      return 'Delivered.';
    case 'INCOMPLETE_DEPOSIT':
      return 'The deposit so far is smaller than quoted.';
    case 'REFUNDED':
      return direction === 'exit'
        ? 'The swap did not fill. 1Click refunded the USDC to this fresh address.'
        : 'The swap did not fill. 1Click refunded your deposit to your refund address.';
    case 'FAILED':
      return 'The swap failed.';
    default:
      return String(status);
  }
}

/**
 * Routes Ghosty shows first. Everything 1Click lists is still selectable;
 * these are the ones checked live with a dry quote (2026-11-11). Left out on
 * purpose: BNB Chain ($1,000 minimum), Tron as an origin ($100 minimum), and
 * routes that answered "No liquidity available" that day.
 */
export const FEATURED_ASSETS: readonly { readonly assetId: string; readonly label: string; readonly privacy?: boolean }[] = [
  { assetId: 'nep141:zec.omft.near', label: 'ZEC on Zcash', privacy: true },
  { assetId: 'nep141:aleo-usdcx.omft.near', label: 'USDCx on Aleo', privacy: true },
  { assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', label: 'USDC on Solana' },
  { assetId: 'nep141:sol.omft.near', label: 'SOL on Solana' },
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', label: 'USDC on Base' },
  { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', label: 'USDC on Ethereum' },
  { assetId: 'nep141:btc.omft.near', label: 'BTC on Bitcoin' },
  { assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', label: 'USDC on NEAR' },
  { assetId: 'nep141:wrap.near', label: 'wNEAR on NEAR' },
];

const HIDDEN_CHAINS = new Set(['bsc']);

/**
 * The asset list for a picker: featured first, then everything else 1Click
 * lists, minus deprecated tickers, Arbitrum USDC itself and hidden chains.
 */
export function pickerAssets(tokens: readonly OneClickToken[]): { assetId: string; label: string; symbol: string; blockchain: string; decimals: number; privacy: boolean }[] {
  const byId = new Map(tokens.map((token) => [token.assetId, token]));
  const rows: { assetId: string; label: string; symbol: string; blockchain: string; decimals: number; privacy: boolean }[] = [];
  const seen = new Set<string>();
  for (const featured of FEATURED_ASSETS) {
    const token = byId.get(featured.assetId);
    if (!token) continue;
    rows.push({ ...featured, symbol: token.symbol, blockchain: token.blockchain, decimals: token.decimals, privacy: !!featured.privacy });
    seen.add(featured.assetId);
  }
  const rest = tokens
    .filter((token) => !seen.has(token.assetId))
    .filter((token) => token.assetId !== ARB_USDC_ASSET)
    .filter((token) => !/deprecated/i.test(token.symbol))
    .filter((token) => !HIDDEN_CHAINS.has(token.blockchain))
    .sort((a, b) => a.blockchain.localeCompare(b.blockchain) || a.symbol.localeCompare(b.symbol));
  for (const token of rest) {
    rows.push({
      assetId: token.assetId,
      label: `${token.symbol} on ${token.blockchain}`,
      symbol: token.symbol,
      blockchain: token.blockchain,
      decimals: token.decimals,
      privacy: token.blockchain === 'zec' || token.blockchain === 'aleo',
    });
  }
  return rows;
}

/** Decimal string -> base units. Refuses more decimals than the token has. */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new OneClickError('Enter an amount like 12.5.');
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) throw new OneClickError(`At most ${decimals} decimals for this asset.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

export function formatUnits(units: bigint | string, decimals: number): string {
  const value = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
