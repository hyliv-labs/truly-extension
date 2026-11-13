/**
 * App venues (app-venues.ts): routing by host, and that the manifest covers
 * every app. A host the manifest misses gets no injected wallet, and a host
 * the table misses would be handed to the wrong venue's address.
 */

import { readFileSync } from 'node:fs';
import { APP_VENUE_IDS, APP_VENUES, appVenueFromHost, isAppVenue } from '../src/lib/app-venues.ts';
import { venueFromOrigin } from '../src/lib/trade.ts';
import { aaveExitBlocker, reserveTokens, underlyingName } from '../src/lib/aave.ts';
import { privateKeyToAccount } from 'viem/accounts';
import { bankUnits, DYDX_ONBOARDING, dydxAddressFromSignature, dydxExitBlocker, isDydxOnboarding, readSubaccounts } from '../src/lib/dydx.ts';

let failed = false;
const expect = (label: string, got: unknown, want: unknown) => {
  const json = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));
  if (json(got) === json(want)) console.log('pass', label);
  else {
    console.error('FAIL', label, 'got', json(got), 'want', json(want));
    failed = true;
  }
};

const manifest = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');
const content = readFileSync(new URL('../entrypoints/lighter.content.ts', import.meta.url), 'utf8');
for (const id of APP_VENUE_IDS) {
  const spec = APP_VENUES[id];
  expect(`${spec.name}: one tab pattern per domain`, spec.tabPatterns.length, spec.domains.length);
  for (const domain of spec.domains) {
    expect(`${spec.name}: ${domain} routes to it`, venueFromOrigin(`https://app.${domain}`), id);
    expect(`${spec.name}: ${domain} itself routes to it`, appVenueFromHost(domain), id);
    expect(`${spec.name}: a lookalike of ${domain} does not`, appVenueFromHost(`${domain}.evil.com`), null);
    expect(`${spec.name}: not${domain} does not`, appVenueFromHost(`not${domain}`), null);
  }
  for (const pattern of spec.tabPatterns) {
    expect(`${spec.name}: manifest host permission and resource match ${pattern}`, manifest.split(`'${pattern}'`).length - 1, 2);
    expect(`${spec.name}: content script matches ${pattern}`, content.includes(`'${pattern}'`), true);
  }
  expect(`${spec.name}: has a logo`, (() => { try { readFileSync(new URL(`../public/apps/${id}.png`, import.meta.url)); return true; } catch { return false; } })(), true);
  expect(`${spec.name}: minimum is at least 1 USDC`, spec.minUnits >= 1_000_000n, true);
}
expect('isAppVenue refuses other venues', [isAppVenue('compound'), isAppVenue('hyperliquid'), isAppVenue('x')], [false, false, false]);
expect('the existing venues still route', [venueFromOrigin('https://app.uniswap.org'), venueFromOrigin('https://app.lighter.xyz'), venueFromOrigin('https://app.hyperliquid.xyz')], ['uniswap', 'lighter', 'hyperliquid']);

// --- Aave: refuse on any supply or debt.
const Z = '0x0000000000000000000000000000000000000000' as const;
const A = '0x0000000000000000000000000000000000000001' as const;
const D = '0x0000000000000000000000000000000000000002' as const;
expect('a reserve without stable debt reads two tokens', reserveTokens({ aTokenAddress: A, stableDebtTokenAddress: Z, variableDebtTokenAddress: D }).length, 2);
expect('aArbUSDC is USDC', underlyingName('aArbUSDC'), 'USDC');
expect('variableDebtArbWETH is WETH', underlyingName('variableDebtArbWETH'), 'WETH');
expect('an empty address is not blocked', aaveExitBlocker([], { collateral: 0n, debt: 0n }), null);
expect('a supply blocks', aaveExitBlocker([{ token: A, kind: 'supply', symbol: 'aArbUSDC', balance: 5n }], { collateral: 5n, debt: 0n }), 'Withdraw your USDC supply on Aave first. Nothing was moved.');
expect('a debt blocks first', aaveExitBlocker([{ token: A, kind: 'supply', symbol: 'aArbUSDC', balance: 5n }, { token: D, kind: 'debt', symbol: 'variableDebtArbWETH', balance: 1n }], { collateral: 5n, debt: 1n }), 'Repay your WETH debt on Aave first, then withdraw. Nothing was moved.');
expect('account data alone still blocks', aaveExitBlocker([], { collateral: 0n, debt: 3n }), 'Repay your debt on Aave first, then withdraw. Nothing was moved.');

// --- dYdX. The vector is from dYdX's own v4-client-js (deriveHDKeyFromEthereumSignature,
// then cosmjs DirectSecp256k1HdWallet with prefix dydx / noble) for this test key's signature.
const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123' as const;
const onboardingSig = await privateKeyToAccount(KEY).signTypedData(DYDX_ONBOARDING as never);
expect('onboarding signature is the one fed to dYdX\'s client', onboardingSig, '0xf2d497f4a31335e7b6bed19181fdf96311fb86fc308a2176fc7323041e6ee35a30154b46a78844c5a5396682285838e1128ab9e10a1b05189ef09e7e835599011b');
expect('dydx and noble addresses match dYdX\'s client', dydxAddressFromSignature(onboardingSig), {
  dydx: 'dydx1qfv3mdnj06xlckp9krvly5erkyq0zeq8w2qywy',
  noble: 'noble1qfv3mdnj06xlckp9krvly5erkyq0zeq80smgka',
});
expect('the site\'s onboarding request is recognised', isDydxOnboarding({ primaryType: 'dYdX', message: { action: 'dYdX Chain Onboarding' } }), true);
expect('other dYdX-typed data is not', isDydxOnboarding({ primaryType: 'Permit', message: { action: 'x' } }), false);
const sub = readSubaccounts({ subaccounts: [{ subaccountNumber: 0, equity: '0.377434', openPerpetualPositions: {} }, { subaccountNumber: 128, equity: '2', openPerpetualPositions: { 'ETH-USD': {} } }] });
expect('subaccount equity sums', sub.equity, 2_377_434n);
expect('subaccount positions listed', sub.positions, ['ETH-USD']);
expect('a 404 reads as no subaccounts', readSubaccounts(null), { equity: 0n, positions: [], numbers: [] });
expect('bank balance of one denom', bankUnits({ balances: [{ denom: 'adydx', amount: '31' }, { denom: 'uusdc', amount: '1485845' }] }, 'uusdc'), 1_485_845n);
const none = { equity: 0n, positions: [] as string[], openOrders: 0, walletUsdc: 0n, nobleUsdc: 0n, lastTransferAt: null };
const now = Date.parse('2026-11-13T12:00:00Z');
expect('nothing anywhere passes', dydxExitBlocker(none, { usdc: 0n, lastSendAt: null }, now), null);
expect('a position blocks', /Close your ETH-USD position/.test(dydxExitBlocker({ ...none, positions: ['ETH-USD'] }, { usdc: 0n, lastSendAt: null }, now) ?? ''), true);
expect('equity blocks', /still on dYdX/.test(dydxExitBlocker({ ...none, equity: 3_000_000n }, { usdc: 0n, lastSendAt: null }, now) ?? ''), true);
expect('dust equity does not block', dydxExitBlocker({ ...none, equity: 5_000n }, { usdc: 0n, lastSendAt: null }, now), null);
expect('USDC in the dYdX wallet blocks', /in your dYdX wallet/.test(dydxExitBlocker({ ...none, walletUsdc: 1_485_845n }, { usdc: 0n, lastSendAt: null }, now) ?? ''), true);
expect('USDC on Noble blocks', /through Noble/.test(dydxExitBlocker({ ...none, nobleUsdc: 2_000_000n }, { usdc: 0n, lastSendAt: null }, now) ?? ''), true);
expect('a withdrawal minutes ago with nothing landed blocks', /on its way to Arbitrum/.test(dydxExitBlocker({ ...none, lastTransferAt: now - 10 * 60_000 }, { usdc: 0n, lastSendAt: null }, now) ?? ''), true);
expect('the same once the USDC landed passes', dydxExitBlocker({ ...none, lastTransferAt: now - 10 * 60_000 }, { usdc: 9_000_000n, lastSendAt: null }, now), null);
expect('a deposit that left but never showed blocks', /has not shown on dYdX/.test(dydxExitBlocker(none, { usdc: 0n, lastSendAt: now - 5 * 60_000 }, now) ?? ''), true);
expect('an old deposit that never showed does not', dydxExitBlocker(none, { usdc: 0n, lastSendAt: now - 3 * 3600_000 }, now), null);

if (failed) process.exit(1);
console.log('app-venues: all checks passed');
