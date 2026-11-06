/**
 * A trade never takes an address that already has on-chain history.
 *
 * Measured failure this guards: after a vault restore the index was 0 again,
 * and the next deposit was planned on owner #0, which an earlier test had
 * funded and traded from. Offline: the chain reads are faked.
 */
import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

const { hasHistory, skipUsedOwners } = await import('../src/lib/fresh-owner.ts');

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const clean = { nonce: 0, ethWei: 0n, usdcUnits: 0n };
if (hasHistory(clean)) fail('an untouched address counted as used');
if (!hasHistory({ ...clean, nonce: 4 })) fail('an address that sent transactions counted as fresh');
if (!hasHistory({ ...clean, ethWei: 1n })) fail('an address holding ETH counted as fresh');
if (!hasHistory({ ...clean, usdcUnits: 1n })) fail('an address holding USDC counted as fresh');
if (!failed) pass('history = any transaction sent, or any ETH or USDC held');

const addr = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}` as `0x${string}`;

// Restored vault: #0 and #1 were used (as on the demo vault), #2 is fresh.
{
  let index = 0;
  const retired: number[] = [];
  const used = new Set([addr(0), addr(1)]);
  const fresh = await skipUsedOwners({
    current: async () => ({ index, address: addr(index) }),
    retire: async (i) => {
      retired.push(i);
      index = Math.max(index, i + 1);
    },
    read: async (a) => (used.has(a) ? { ...clean, nonce: 3 } : clean),
  });
  if (fresh !== 2 || retired.join(',') !== '0,1') fail(`restored vault landed on #${fresh}, retired [${retired}]`);
  else pass('a restored vault skips #0 and #1 (used) and lands on #2');
}

// Nothing used: the current address is kept, nothing is burned.
{
  const retired: number[] = [];
  const fresh = await skipUsedOwners({
    current: async () => ({ index: 5, address: addr(5) }),
    retire: async (i) => {
      retired.push(i);
    },
    read: async () => clean,
  });
  if (fresh !== 5 || retired.length) fail('a fresh address was retired');
  else pass('a fresh address is kept and nothing is burned');
}

// A read that fails stops the trade rather than guessing the address is fresh.
try {
  await skipUsedOwners({
    current: async () => ({ index: 0, address: addr(0) }),
    retire: async () => {},
    read: async () => {
      throw new Error('anon-rpc timeout');
    },
  });
  fail('a failed history read was treated as a fresh address');
} catch {
  pass('a failed history read stops the trade instead of assuming fresh');
}

console.log(failed ? '\nFAILED' : '\nfresh owner OK');
process.exit(failed ? 1 : 0);
