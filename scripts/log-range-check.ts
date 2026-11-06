/**
 * Finds how wide an eth_getLogs range the configured Arbitrum RPC will serve.
 *
 * Note discovery scans from the pool's deployment block to head. At the SDK's
 * default 10k chunk size that is ~11,000 sequential round trips, which is not
 * viable over anon-rpc. The pool has only ~240 deposits, so the result set is
 * tiny -- the only question is the provider's range limit.
 *
 * Network-bound, so it is not part of `pnpm check`.
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
import { arbitrum } from 'viem/chains';

const RPC = process.env.WXT_ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const POOL = '0x3706e38af05bf0158BCdbB46239f8289980b093f' as const;
const DEPLOYMENT_BLOCK = 411197154n;

const DEPOSITED = parseAbiItem(
  'event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)',
);

const client = createPublicClient({ chain: arbitrum, transport: http(RPC) });

const detail = (e: unknown): string => {
  const err = e as { details?: string; shortMessage?: string; message?: string };
  return (err.details ?? err.shortMessage ?? err.message ?? String(e)).split('\n')[0] ?? '';
};

const head = await client.getBlockNumber();
const span = head - DEPLOYMENT_BLOCK;
console.log(`head ${head}; ${span} blocks since deployment`);
console.log(`RPC: ${RPC}`);

// Does the whole range work in one call?
try {
  const t0 = Date.now();
  const logs = await client.getLogs({
    address: POOL,
    event: DEPOSITED,
    fromBlock: DEPLOYMENT_BLOCK,
    toBlock: head,
  });
  console.log(
    `pass full range in ONE call: ${logs.length} deposits, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  process.exit(0);
} catch (error) {
  console.log(`  full range refused: ${detail(error)}`);
}

// It refused. Find the widest window it does serve, so the real chunk count
// can be stated rather than guessed.
let best = 0n;
for (const width of [10_000n, 100_000n, 1_000_000n, 10_000_000n, 50_000_000n]) {
  try {
    await client.getLogs({
      address: POOL,
      event: DEPOSITED,
      fromBlock: head - width,
      toBlock: head,
    });
    best = width;
    console.log(`  pass ${width} blocks`);
  } catch (error) {
    console.log(`  fail ${width} blocks: ${detail(error)}`);
    break;
  }
}

if (best === 0n) {
  console.log('\nThis RPC serves no usable window. Discovery needs another source.');
} else {
  const calls = Number(span / best) + 1;
  console.log(`\nWidest accepted window: ${best} blocks => ${calls} calls for a full scan.`);
  console.log(calls > 100 ? 'Still not viable over anon-rpc.' : 'Viable.');
}
process.exit(0);
