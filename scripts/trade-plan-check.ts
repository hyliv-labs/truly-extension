/**
 * Market-trade validation and sizing: margin vs notional, leverage caps,
 * spendable vs ASP-pending funds, Lighter minimums, worst-price rounding and
 * order-outcome classification. Offline; part of `pnpm check`.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

const plan = await import('../src/lib/trade-plan.ts');
const { parseMarket, parseMarkets } = await import('../src/lib/lighter-markets.ts');
const { estimateRelayerFeeUnits } = await import('../src/lib/config.ts');

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);
const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
const note = (usdc: number, label = 1n) => ({
  label,
  value: USDC(usdc),
  nullifier: 7n,
  secret: 8n,
  commitmentHash: 9n,
  childrenCount: 0,
});

// Shape taken from a live orderBookDetails entry (ETH, 2026-11-06).
const raw = {
  symbol: 'ETH',
  market_id: 0,
  market_type: 'perp',
  status: 'active',
  taker_fee: '0.0000',
  min_base_amount: '0.0020',
  min_quote_amount: '10.000000',
  size_decimals: 4,
  price_decimals: 2,
  min_initial_margin_fraction: 200,
  maintenance_margin_fraction: 120,
  mark_price: '2221.51',
  last_trade_price: 2221.6,
  daily_price_change: -8.2,
  daily_quote_token_volume: 677899594.9,
  is_frozen: false,
  market_config: { hidden: false, force_reduce_only: false },
};
const eth = parseMarket(raw)!;
if (eth.maxLeverage !== 50) fail(`max leverage from IMF 200 is ${eth.maxLeverage}, expected 50`);
else pass('max leverage is derived from min_initial_margin_fraction (200 -> 50x)');
if (!eth.tradable) fail('an active ETH market parsed as untradable');
else pass('an active market is tradable');

const inactive = parseMarket({ ...raw, status: 'inactive' })!;
const frozen = parseMarket({ ...raw, is_frozen: true })!;
const reduceOnly = parseMarket({ ...raw, market_config: { force_reduce_only: true } })!;
if (inactive.tradable || frozen.tradable || reduceOnly.tradable) fail('an inactive/frozen/reduce-only market is offered');
else pass('inactive, frozen and reduce-only markets are not tradable');
if (parseMarket({ ...raw, size_decimals: undefined }) !== null) fail('a market missing decimals was accepted');
else pass('a market missing decimals is dropped rather than guessed');
if (parseMarkets({ order_book_details: [raw, { ...raw, market_type: 'spot', symbol: 'X' }] }).length !== 1) {
  fail('spot entries leaked into the perp list');
} else pass('only perp markets are listed');

const request = (over: Partial<Parameters<typeof plan.validateTrade>[0]['request']> = {}) => ({
  marketId: 0,
  direction: 'long' as const,
  marginUnits: USDC(10),
  leverage: 5,
  ...over,
});
const validate = (over: Partial<Parameters<typeof plan.validateTrade>[0]> = {}) =>
  plan.validateTrade({
    market: eth,
    request: request(),
    referencePrice: 2221.51,
    approvedNotes: [note(100)],
    pendingNotes: [],
    ...over,
  });
const expectCode = (what: string, code: string, fn: () => unknown) => {
  try {
    fn();
    fail(`${what}: accepted`);
  } catch (error) {
    const got = (error as { code?: string }).code;
    if (got === code) pass(`${what} -> ${code}`);
    else fail(`${what}: expected ${code}, got ${got ?? (error as Error).message}`);
  }
};

// --- the happy path, and margin vs notional --------------------------------
const q = validate();
if (q.marginUnits !== USDC(10).toString()) fail('margin was altered');
if (Math.abs(q.notionalUsd - 10 * 0.98 * 5) > 1e-9) fail(`notional ${q.notionalUsd} != margin x leverage (buffered)`);
else pass(`notional = margin x leverage: ${q.notionalUsd}`);
if (BigInt(q.expectedNetUnits) < USDC(10)) fail('the pool withdrawal lands less than the margin');
else pass(`withdrawal ${q.grossWithdrawalUnits} gross lands >= margin (${q.expectedNetUnits})`);
if (q.fundingSource !== 'Privacy Pools' || q.orderType !== 'market') fail('summary lost its funding source / order type');
else pass('summary states market order, funded from Privacy Pools');

// grossForNet is the smallest gross that nets the margin.
let tight = true;
for (const m of [5, 10, 25, 99.99, 1000]) {
  const g = plan.grossForNet(USDC(m));
  const ok = g - estimateRelayerFeeUnits(g) >= USDC(m) && g - 1n - estimateRelayerFeeUnits(g - 1n) < USDC(m);
  if (!ok) {
    tight = false;
    fail(`grossForNet(${m}) = ${g} is not the tight minimum`);
  }
}
if (tight) pass('grossForNet returns the tight minimum gross for each margin');

// --- rejections ---------------------------------------------------------------
expectCode('leverage above the market cap', 'invalid-leverage', () => validate({ request: request({ leverage: 51 }) }));
expectCode('fractional leverage', 'invalid-leverage', () => validate({ request: request({ leverage: 2.5 }) }));
expectCode('zero leverage', 'invalid-leverage', () => validate({ request: request({ leverage: 0 }) }));
expectCode('zero margin', 'invalid-margin', () => validate({ request: request({ marginUnits: 0n }) }));
expectCode('margin under Lighter deposit minimum', 'below-lighter-minimum', () =>
  validate({ request: request({ marginUnits: USDC(4) }) }),
);
expectCode('notional under the market minimum', 'below-min-notional', () =>
  validate({ request: request({ marginUnits: USDC(5), leverage: 1 }) }),
);
expectCode('inactive market', 'market-unavailable', () => validate({ market: inactive }));
expectCode('no price', 'market-unavailable', () => validate({ referencePrice: 0 }));
expectCode('bad direction', 'invalid-direction', () => validate({ request: request({ direction: 'up' as never }) }));
expectCode('nothing spendable', 'insufficient-balance', () => validate({ approvedNotes: [] }));
expectCode('only small notes', 'insufficient-balance', () => validate({ approvedNotes: [note(8)], request: request({ marginUnits: USDC(20) }) }));
expectCode('the only big note is still pending ASP', 'pending-asp', () =>
  validate({ approvedNotes: [note(6)], pendingNotes: [note(500, 2n)], request: request({ marginUnits: USDC(50) }) }),
);
expectCode('pending-only pool', 'pending-asp', () =>
  validate({ approvedNotes: [], pendingNotes: [note(500, 2n)] }),
);

const withPending = validate({ pendingNotes: [note(40, 2n)] });
if (withPending.spendableUnits !== USDC(100).toString() || withPending.pendingAspUnits !== USDC(40).toString()) {
  fail('pending ASP funds were counted as spendable');
} else pass('pending ASP funds are shown but not counted as spendable');

// --- execution sizing from what was CREDITED -------------------------------
const sized = plan.sizeMarketOrder({
  market: eth,
  direction: 'long',
  leverage: 5,
  requestedMarginUsd: 10,
  creditedUsd: 9.7,
  bestBid: 2221.0,
  bestAsk: 2221.5,
});
if (Math.abs(sized.marginUsd - 9.7) > 1e-9) fail(`sized from ${sized.marginUsd}, not the 9.7 credited`);
else pass('a short credit sizes the order down to what Lighter actually holds');
if (sized.worstPriceScaled !== Math.ceil(2221.5 * 1.01 * 100)) fail(`long worst price ${sized.worstPriceScaled}`);
else pass(`a long's worst price rounds up from the ask (+1%): ${sized.worstPrice}`);
if (sized.baseAmountScaled !== Math.round(sized.baseAmount * 1e4) || sized.baseAmount < eth.minBaseAmount) {
  fail('base amount is not scaled to size_decimals');
} else pass(`base ${sized.baseAmount} ETH -> ${sized.baseAmountScaled} at size_decimals 4`);

const shortSized = plan.sizeMarketOrder({ ...{ market: eth, leverage: 5, requestedMarginUsd: 10, creditedUsd: 10 }, direction: 'short', bestBid: 2221.0, bestAsk: 2221.5 });
if (shortSized.worstPriceScaled !== Math.floor(2221.0 * 0.99 * 100)) fail('short worst price not floored from the bid');
else pass(`a short's worst price rounds down from the bid (-1%): ${shortSized.worstPrice}`);

expectCode('credited far below the margin', 'below-min-notional', () =>
  plan.sizeMarketOrder({ market: eth, direction: 'long', leverage: 1, requestedMarginUsd: 10, creditedUsd: 2, bestBid: 1, bestAsk: 2221 }),
);
expectCode('an empty book', 'market-unavailable', () =>
  plan.sizeMarketOrder({ market: eth, direction: 'long', leverage: 5, requestedMarginUsd: 10, creditedUsd: 10, bestBid: 2221, bestAsk: null }),
);

// --- close sizing -----------------------------------------------------------
const close = plan.sizeCloseOrder({ market: eth, positionSign: 1, positionSize: 0.0221, bestBid: 2200, bestAsk: 2201 });
if (close.direction !== 'short' || close.baseAmountScaled !== 221) fail(`closing a long: ${JSON.stringify(close)}`);
else pass('closing a long sells the exact position size');
const closeShort = plan.sizeCloseOrder({ market: eth, positionSign: -1, positionSize: 0.5, bestBid: 2200, bestAsk: 2201 });
if (closeShort.direction !== 'long') fail('closing a short does not buy');
else pass('closing a short buys');

// --- outcome classification: never assume a fill ---------------------------
const order = (status: string, filled: number, initial = 0.02) => ({
  status,
  filledBaseAmount: filled,
  filledQuoteAmount: filled * 2221,
  initialBaseAmount: initial,
});
const cases: [string, ReturnType<typeof order>, string][] = [
  ['filled', order('filled', 0.02), 'filled'],
  ['partial IOC', order('canceled-not-enough-liquidity', 0.01), 'partially-filled'],
  ['unfilled IOC', order('canceled-too-much-slippage', 0), 'unfilled'],
  ['margin cancel', order('canceled-margin-not-allowed', 0), 'unfilled'],
  ['still open', order('open', 0), 'pending'],
  ['in progress', order('in-progress', 0), 'pending'],
];
for (const [what, o, want] of cases) {
  const got = plan.classifyOrder(o, 0.02).state;
  if (got !== want) fail(`${what}: classified ${got}, expected ${want}`);
}
pass('order outcomes: filled / partial / unfilled / pending are told apart');
const avg = plan.classifyOrder(order('filled', 0.02), 0.02);
if (avg.state !== 'filled' || Math.abs((avg.averagePrice ?? 0) - 2221) > 1e-9) fail('average price not derived from filled quote/base');
else pass('average execution price = filled quote / filled base');

console.log(failed ? '\nFAILED' : '\ntrade plan OK');
process.exit(failed ? 1 : 0);
