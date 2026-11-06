/**
 * The order ticket is priced from note values captured at unlock.
 * Those values are not spendable notes: a quote built from them matches a
 * quote built from real notes of the same size, and the snapshot round-trips
 * through session storage without a pool scan.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

const plan = await import('../src/lib/trade-plan.ts');
const { parseMarket } = await import('../src/lib/lighter-markets.ts');
const balance = await import('../src/lib/shielded-balance.ts');
type ShieldedBalance = import('../src/lib/shielded-balance.ts').ShieldedBalance;

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);
const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

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
  daily_quote_token_volume: 1,
  is_frozen: false,
  market_config: { hidden: false, force_reduce_only: false },
};
const eth = parseMarket(raw)!;
const request = {
  marketId: 0,
  direction: 'long' as const,
  marginUnits: USDC(10),
  leverage: 5,
};
const real = (value: bigint) => ({
  label: 1n,
  value,
  nullifier: 7n,
  secret: 8n,
  commitmentHash: 9n,
  childrenCount: 0,
});

const fromValues = plan.validateTrade({
  market: eth,
  request,
  referencePrice: 2221.51,
  approvedNotes: balance.notesForQuote([USDC(40).toString(), USDC(12).toString()]),
  pendingNotes: balance.notesForQuote([USDC(5).toString()]),
});
const fromNotes = plan.validateTrade({
  market: eth,
  request,
  referencePrice: 2221.51,
  approvedNotes: [real(USDC(40)), real(USDC(12))],
  pendingNotes: [real(USDC(5))],
});
if (fromValues.grossWithdrawalUnits !== fromNotes.grossWithdrawalUnits || fromValues.spendableUnits !== fromNotes.spendableUnits) {
  fail('a quote from stored values disagreed with a quote from the notes');
} else pass('stored note values price the same withdrawal as the notes themselves');

if (fromValues.pendingAspUnits !== USDC(5).toString()) fail('pending value was dropped');
else pass('pending value is carried into the quote');

const notes = balance.notesForQuote(['100', '200']);
if (notes.some((note) => note.secret !== 0n || note.nullifier !== 0n)) fail('quote notes carried a secret');
else pass('quote notes hold values only');

const snapshot: ShieldedBalance = {
  fetchedAt: 1_700_000_000_000,
  privacyPools: {
    spendableUnits: USDC(15).toString(),
    pendingUnits: '0',
    noteCount: 1,
    largestUnits: USDC(15).toString(),
    approvedValues: [USDC(15).toString()],
    pendingValues: [],
  },
  railgun: { spendableUnits: USDC(14).toString(), pendingUnits: USDC(1).toString(), feeBps: '25' },
};

await chrome.storage.session.set({ 'truly:shieldedBalance': snapshot });
const read = await balance.readShieldedBalance();
if (
  !read ||
  !balance.poolsReady(read.privacyPools) ||
  !balance.poolsReady(snapshot.privacyPools) ||
  read.privacyPools.spendableUnits !== snapshot.privacyPools.spendableUnits ||
  !balance.railgunReady(read.railgun)
) {
  fail('the snapshot did not round-trip');
} else pass('the unlock snapshot round-trips without a pool scan');

if (!balance.railgunReady(read!.railgun) || read!.railgun.feeBps !== '25') fail('railgun fee was lost');
else pass('the railgun side of the snapshot is intact');

await balance.forgetShieldedBalance();
if (await balance.readShieldedBalance()) fail('lock left the snapshot behind');
else pass('locking drops the snapshot');

if (failed) process.exit(1);
