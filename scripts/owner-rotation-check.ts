/**
 * Regression test for the invariant the whole design rests on:
 * a retired owner address is never handed out again.
 *
 * Runs under Node with an in-memory chrome.storage stub, so it exercises the
 * real vault/trade modules rather than a reimplementation of them.
 */

// --- chrome.storage stub -----------------------------------------------------

type Store = Record<string, unknown>;

function makeArea(store: Store) {
  return {
    async get(key: string) {
      return key in store ? { [key]: store[key] } : {};
    },
    async set(items: Store) {
      Object.assign(store, items);
    },
    async remove(key: string) {
      delete store[key];
    },
    async clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

const local: Store = {};
const session: Store = {};
(globalThis as Record<string, unknown>).chrome = {
  storage: { local: makeArea(local), session: makeArea(session) },
};

// Set before the imports below: config.ts reads the environment at module
// evaluation, and startTrade refuses to move money without a specifier.
process.env.WXT_ANON_RPC_SPECIFIER = '0x00000000000000000000000000000000000000a1';

// Imported after the stub exists — these modules touch chrome at call time only.
const { createVault, currentOwner, getOwnerIndex } = await import('../src/lib/vault.ts');
const { startTrade, endTrade, getActiveTrade } = await import('../src/lib/trade.ts');

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

const PHRASE = 'test test test test test test test test test test test junk';

await createVault('pw', PHRASE);

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

await endTrade();

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
