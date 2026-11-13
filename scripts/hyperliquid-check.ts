/**
 * Hyperliquid: the withdrawal signature, amounts, and when Bring back refuses.
 *
 * The signature vector was produced by Hyperliquid's own Python SDK
 * (hyperliquid-python-sdk, signing.user_signed_payload + sign_inner) for a
 * throwaway key, with signatureChainId 0xa4b1. If this file's typed data
 * drifts from what Hyperliquid rebuilds, /exchange rejects the withdrawal and
 * the USDC stays on Hyperliquid, so the vector is the check that matters.
 */

import { privateKeyToAccount } from 'viem/accounts';
import {
  depositCredited,
  exchangeBody,
  HYPERLIQUID_BRIDGE,
  hyperliquidExitBlocker,
  readAbstraction,
  readAccount,
  readExchangeAnswer,
  splitSignature,
  totalUsdc,
  usdcDecimalFromUnits,
  usdcUnitsFromDecimal,
  withdrawAction,
  withdrawalArrived,
  withdrawnSince,
  withdrawTypedData,
} from '../src/lib/hyperliquid.ts';
import { venueFromOrigin } from '../src/lib/trade.ts';
import { hashTypedDataLoose, isStructNameRefusal, looseTypedDataAllowed, signTypedDataLoose } from '../src/lib/typed-data.ts';
import { hashTypedData } from 'viem';

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);
const expect = (label: string, got: unknown, want: unknown) => {
  const a = JSON.stringify(got, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const b = JSON.stringify(want, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (a === b) pass(label);
  else fail(`${label}: got ${a}, want ${b}`);
};
const throws = (label: string, run: () => unknown, pattern: RegExp) => {
  try {
    run();
    fail(`${label}: did not throw`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) pass(label);
    else fail(`${label}: threw "${message}"`);
  }
};

// --- The signature, against the SDK.
const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123' as const;
/** sign_agent's typed data from the SDK, same key, nonce 1731400000000, agent 0x…01, chain 0xa4b1. */
const APPROVE_AGENT_SIG = {
  r: '0x10cab06eded3d62dd5ffeecc9353a8e1a3d117ac337ac27cdd6ddbf66b1fb777',
  s: '0x76712f73f541ade40c21cf362297e7e8a4b932d4ffb86959923cebdedb007463',
  v: 28,
};
const account = privateKeyToAccount(KEY);
expect('test key address', account.address, '0x14791697260E4c9A71f18484C9f997B308e59325');
const action = withdrawAction(account.address, '12.5', 1731400000000);
expect('action fields', action, {
  type: 'withdraw3',
  hyperliquidChain: 'Mainnet',
  signatureChainId: '0xa4b1',
  destination: '0x14791697260e4c9a71f18484c9f997b308e59325',
  amount: '12.5',
  time: 1731400000000,
});
const signature = splitSignature(await signTypedDataLoose(KEY, withdrawTypedData(action)));
expect('withdraw3 signature matches the Hyperliquid SDK', signature, {
  r: '0xc99e6d9964a607abd6316ebcb02ddae240f70cb3201c723b7eb723e4d9b503f3',
  s: '0x2e6135d23c953afc4c6fc43bc7ad347d58b063d6d5cfe511070ab3bd27ec0097',
  v: 27,
});
// The loose hash is viem's hash wherever viem accepts the input.
const permitLike = {
  domain: { name: 'USD Coin', version: '2', chainId: 42161, verifyingContract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const },
  types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }] },
  primaryType: 'Permit' as const,
  message: { owner: account.address, value: 5n, nonce: 0n },
};
expect('loose hash equals viem for a normal struct', hashTypedDataLoose(permitLike), hashTypedData(permitLike));
try {
  await account.signTypedData(withdrawTypedData(action));
  fail('viem now accepts the Hyperliquid type name; the loose path may be unneeded');
} catch (error) {
  expect('viem refuses the Hyperliquid type name, and the provider recognises that refusal', isStructNameRefusal(error), true);
}
// Enable trading on app.hyperliquid.xyz: approveAgent, as the site sends it to the wallet.
const approveAgent = {
  domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: '0x0000000000000000000000000000000000000000' },
  types: {
    'HyperliquidTransaction:ApproveAgent': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'agentAddress', type: 'address' },
      { name: 'agentName', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  primaryType: 'HyperliquidTransaction:ApproveAgent',
  message: { hyperliquidChain: 'Mainnet', agentAddress: '0x0000000000000000000000000000000000000001', agentName: '', nonce: 1731400000000 },
};
expect('approveAgent signature matches the Hyperliquid SDK', splitSignature(await signTypedDataLoose(KEY, approveAgent)), APPROVE_AGENT_SIG);
// Security review: the loose path is for Hyperliquid's names only, and still validates fields.
expect('loose signing allowed for ApproveAgent', looseTypedDataAllowed(approveAgent), true);
expect('loose signing allowed for Withdraw', looseTypedDataAllowed(withdrawTypedData(action) as never), true);
expect('loose signing refused for another colon name', looseTypedDataAllowed({ ...approveAgent, types: { 'Evil:Permit': approveAgent.types['HyperliquidTransaction:ApproveAgent'] }, primaryType: 'Evil:Permit' }), false);
expect('loose signing refused for a Permit with an unused colon type added', looseTypedDataAllowed({ ...permitLike, types: { ...permitLike.types, 'a:b': [] } } as never), false);
expect('loose signing refused when a field fails viem checks', looseTypedDataAllowed({ ...approveAgent, message: { ...approveAgent.message, agentAddress: '0x123' } }), false);
expect('exchange body nonce is the action time', exchangeBody(action, signature).nonce, 1731400000000);
throws('a withdrawal of the fee or less is refused', () => withdrawAction(account.address, '1', 1), /1 USDC/);
throws('more than 6 decimals is refused', () => withdrawAction(account.address, '2.1234567', 1), /6 places/);
throws('a bad destination is refused', () => withdrawAction('0x1234' as `0x${string}`, '2', 1), /not an address/);

// --- Amounts.
expect('decimal to units', usdcUnitsFromDecimal('14.624883'), 14_624_883n);
expect('extra digits are dropped, not rounded up', usdcUnitsFromDecimal('1.9999999'), 1_999_999n);
expect('negative PnL reads negative', usdcUnitsFromDecimal('-0.5'), -500_000n);
expect('units to decimal trims zeros', usdcDecimalFromUnits(12_500_000n), '12.5');
expect('whole units have no point', usdcDecimalFromUnits(7_000_000n), '7');
throws('a non-number from the API is refused', () => usdcUnitsFromDecimal('NaN'), /not a number/);

// --- Reading the account and the exit rules. Shapes from the /info docs.
const empty = readAccount({ marginSummary: { accountValue: '0.0' }, withdrawable: '0.0', assetPositions: [] }, { balances: [] }, []);
expect('a new address has nothing', totalUsdc(empty), 0n);
expect('a new address is not blocked', hyperliquidExitBlocker(empty), null);

const open = readAccount(
  { marginSummary: { accountValue: '24.1' }, withdrawable: '10.0', assetPositions: [{ position: { coin: 'ETH', szi: '0.01' } }, { position: { coin: 'BTC', szi: '0.0' } }] },
  { balances: [{ coin: 'USDC', total: '1.5', hold: '0.0' }, { coin: 'HYPE', total: '0.3', hold: '0.0' }] },
  [{ coin: 'ETH', oid: 1 }],
);
expect('only non-zero positions count', open.openPositions, ['ETH']);
expect('perp plus spot USDC', totalUsdc(open), 25_600_000n);
expect('an open position blocks Bring back first', /Close your ETH position/.test(hyperliquidExitBlocker(open) ?? ''), true);
const ordersOnly = readAccount({ marginSummary: { accountValue: '5' }, withdrawable: '5', assetPositions: [] }, { balances: [] }, [{}, {}]);
expect('open orders block', hyperliquidExitBlocker(ordersOnly), 'Cancel your 2 open orders on Hyperliquid first. Nothing was withdrawn.');
const spotToken = readAccount({ marginSummary: { accountValue: '5' }, withdrawable: '5', assetPositions: [] }, { balances: [{ coin: 'HYPE', total: '0.3', hold: '0' }] }, []);
expect('a spot token blocks', /Sell 0.3 HYPE/.test(hyperliquidExitBlocker(spotToken) ?? ''), true);

// --- Unified account: the spot balance is the account.
const unified = readAccount(
  { marginSummary: { accountValue: '9.0' }, withdrawable: '0.0', assetPositions: [] },
  { balances: [{ coin: 'USDC', total: '9.0', hold: '2.0' }] },
  [],
  readAbstraction('unifiedAccount'),
);
expect('unified: withdrawable is spot USDC not on hold', unified.withdrawable, 7_000_000n);
expect('unified: perp value is not counted twice', totalUsdc(unified), 9_000_000n);
expect('an unknown mode reads as unknown', readAbstraction('somethingNew'), 'unknown');

// --- Waiting rules.
expect('credited when the total rose by the deposit', depositCredited(0n, 10_000_000n, 10_000_000n), true);
expect('credited within a 1 USDC allowance', depositCredited(0n, 9_200_000n, 10_000_000n), true);
expect('not credited before it shows', depositCredited(0n, 0n, 10_000_000n), false);
expect('arrived once amount minus the fee landed', withdrawalArrived(0n, 9_000_000n, 10_000_000n), true);
expect('not arrived before it lands', withdrawalArrived(0n, 0n, 10_000_000n), false);

// --- The ledger. Row shape read live 2026-11-12: usdc is what reached Arbitrum, fee listed apart.
const ledger = [
  { time: 1000, delta: { type: 'deposit', usdc: '10.0' } },
  { time: 2000, delta: { type: 'withdraw', usdc: '4.5', fee: '1.0' } },
  { time: 3000, delta: { type: 'withdraw', usdc: '2.0', fee: '1.0' } },
];
expect('withdrawals since a time, deposits ignored', withdrawnSince(ledger, 0), 6_500_000n);
expect('withdrawals before the time are ignored', withdrawnSince(ledger, 2500), 2_000_000n);
expect('no withdrawals reads as zero', withdrawnSince([], 0), 0n);

// --- What /exchange answered.
expect('ok is accepted', readExchangeAnswer({ status: 'ok', response: { type: 'default' } }), 'accepted');
expect('an error string is an error', readExchangeAnswer({ status: 'err', response: 'Insufficient balance for withdrawal' }), { error: 'Insufficient balance for withdrawal' });
expect('a used nonce is a duplicate', readExchangeAnswer({ status: 'err', response: 'Nonce already used' }), 'duplicate');

// --- Routing.
expect('app.hyperliquid.xyz is the Hyperliquid venue', venueFromOrigin('https://app.hyperliquid.xyz'), 'hyperliquid');
expect('a lookalike host is not', venueFromOrigin('https://hyperliquid.xyz.evil.com'), null);
expect('bridge address is Bridge2', HYPERLIQUID_BRIDGE, '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7');

if (failed) process.exit(1);
console.log('hyperliquid: all checks passed');
