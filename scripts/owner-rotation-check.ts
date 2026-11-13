/**
 * Regression test for the invariant the whole design rests on:
 * a retired owner address is never handed out again.
 *
 * Runs under Node with an in-memory chrome.storage stub, so it exercises the
 * real vault/trade modules rather than a reimplementation of them.
 */

import { installChromeStub } from './chrome-stub.ts';

const calls = installChromeStub();


// Set before the imports below: config.ts reads the environment at module
// evaluation, and startTrade refuses to move money without a specifier.
process.env.WXT_ANON_RPC_SPECIFIER = '0x00000000000000000000000000000000000000a1';
process.env.WXT_PRIVACY_POOL_ENTRYPOINT = '0x00000000000000000000000000000000000000e1';
process.env.WXT_PRIVACY_POOL_ADDRESS = '0x00000000000000000000000000000000000000b1';
process.env.WXT_PRIVACY_POOL_RELAYER_URL = 'https://relayer.example';

// Imported after the stub exists — these modules touch chrome at call time only.
const { createVault, currentOwner, getOwnerIndex } = await import('../src/lib/vault.ts');
const { startTrade, endTrade, getActiveTrade } = await import('../src/lib/trade.ts');
// Offline: every address reads as never used, so rotation alone is tested here
// (fresh-owner-check covers skipping used ones).
const { setHistoryReaderForTests } = await import('../src/lib/fresh-owner.ts');
setHistoryReaderForTests(async () => ({ nonce: 0, ethWei: 0n, usdcUnits: 0n }));

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

const PHRASE = 'test test test test test test test test test test test junk';

await createVault('test-password', PHRASE);

// Trade 1.
const first = await startTrade();
if (first.ownerIndex !== 0) fail(`first trade should use index 0, got ${first.ownerIndex}`);
else pass(`trade 1 uses owner #0 (${first.ownerAddress})`);

// An active trade blocks a second one: one trade at a time.
try {
  await startTrade();
  fail('a second concurrent trade was allowed');
} catch {
  pass('concurrent trade refused');
}

// While the trade is live the owner must not move — resume depends on it.
if ((await currentOwner()).address !== first.ownerAddress) {
  fail('owner changed mid-trade');
} else pass('owner stable during the trade');

// E10: starting a trade must wipe Lighter's session, or the new owner is
// linked to the previous one from Lighter's side regardless of funding.
if (calls.browsingDataRemove.length === 0) {
  fail('starting a trade did not clear Lighter site data');
} else {
  const origins = calls.browsingDataRemove[0]!.origins;
  if (!origins.some((o) => o.includes('lighter.xyz'))) {
    fail(`cleanup did not target Lighter: ${origins.join(', ')}`);
  } else {
    pass('starting a trade clears Lighter site data');
  }
}

const cleanupsBeforeEnd = calls.browsingDataRemove.length;
await endTrade();

if (calls.browsingDataRemove.length <= cleanupsBeforeEnd) {
  fail('ending a trade did not clear Lighter site data');
} else {
  pass('ending a trade clears Lighter site data too');
}

if (await getActiveTrade()) fail('trade still active after endTrade');
else pass('trade cleared');

if ((await getOwnerIndex()) !== 1) {
  fail(`index should advance to 1 on end, got ${await getOwnerIndex()}`);
} else pass('owner index advanced on end');

// Trade 2 — the actual regression: this used to reuse owner #0.
const second = await startTrade();
if (second.ownerAddress === first.ownerAddress) {
  fail('REUSED the retired owner address — trades are linkable');
} else {
  pass(`trade 2 uses a fresh owner #${second.ownerIndex} (${second.ownerAddress})`);
}

await endTrade();
const third = await startTrade();
if (third.ownerAddress === first.ownerAddress || third.ownerAddress === second.ownerAddress) {
  fail('trade 3 collided with an earlier owner');
} else pass(`trade 3 distinct (#${third.ownerIndex})`);

process.exitCode = failed ? 1 : 0;
