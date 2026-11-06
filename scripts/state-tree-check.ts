/**
 * Rebuilds the live pool's state tree from LeafInserted events.
 *
 * The state tree CANNOT be cached the way the ASP set can. ASP leaves change
 * once per published batch; state leaves change with every deposit and every
 * withdrawal. Freezing them means trade 1's change note is missing when trade
 * 2 builds its merkle proof, and generateMerkleProof throws -- breaking the
 * chain of trades that is the whole answer to ASP batching.
 *
 * LeafInserted(_index, _leaf, _root) carries the order and the resulting root,
 * so one getLogs rebuilds the tree and the last event's root is checkable
 * against the pool's own currentRoot().
 *
 * Network-bound, so it is not part of `pnpm check`.
 */

import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';
import { arbitrum } from 'viem/chains';
import { generateMerkleProof } from '@0xbow/privacy-pools-core-sdk';

const RPC = process.env.WXT_ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const POOL = '0x3706e38af05bf0158BCdbB46239f8289980b093f' as const;
const DEPLOYMENT_BLOCK = 411197154n;
const CHUNK = 10_000_000n;

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const client = createPublicClient({ chain: arbitrum, transport: http(RPC) });

const LEAF_INSERTED = parseAbiItem(
  'event LeafInserted(uint256 _index, uint256 _leaf, uint256 _root)',
);

try {
  const head = await client.getBlockNumber();

  const logs: Array<{ args: { _index?: bigint; _leaf?: bigint; _root?: bigint } }> = [];
  for (let from = DEPLOYMENT_BLOCK; from <= head; from += CHUNK) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    const batch = await client.getLogs({
      address: POOL,
      event: LEAF_INSERTED,
      fromBlock: from,
      toBlock: to,
    });
    logs.push(...(batch as unknown as typeof logs));
  }
  pass(`fetched ${logs.length} LeafInserted events`);

  if (logs.length === 0) {
    fail('no LeafInserted events — the state tree cannot be rebuilt from chain');
    process.exit(1);
  }

  // Order by the event's own index, not by log order, so a reorg or an
  // out-of-order chunk cannot silently permute the tree.
  const byIndex = [...logs].sort((a, b) => Number((a.args._index ?? 0n) - (b.args._index ?? 0n)));

  // _index is ONE-BASED: it is the tree size after the insertion, not the
  // leaf's 0-based position. Verified against the live pool, where 603 events
  // run 1..603 and the rebuilt root matches currentRoot().
  //
  // The sequence must be dense, or a leaf is missing and every merkle proof
  // built from this tree would be wrong while still looking well-formed.
  let dense = true;
  byIndex.forEach((log, i) => {
    if (log.args._index !== BigInt(i + 1)) dense = false;
  });
  if (!dense) {
    const got = byIndex.slice(0, 5).map((l) => String(l.args._index)).join(',');
    fail(`LeafInserted indices are not dense from 1 (first: ${got})`);
  } else {
    pass(`indices are dense, 1 to ${byIndex.length}`);
  }

  const leaves = byIndex.map((l) => l.args._leaf as bigint);

  // Rebuild using the SDK's OWN merkle helper -- the same function withdraw.ts
  // proves with, so this checks the code that ships rather than a lookalike.
  const firstLeaf = leaves[0];
  if (firstLeaf === undefined) throw new Error('no leaves');
  const proof = generateMerkleProof(leaves, firstLeaf);
  const rebuiltRoot = proof.root as unknown as bigint;
  pass(`rebuilt a tree of ${leaves.length} leaves, depth ${proof.siblings.length}`);

  // THE DECISIVE CHECK: our computed root must equal the pool's.
  const onChainRoot = await client.readContract({
    address: POOL,
    abi: parseAbi(['function currentRoot() view returns (uint256)']),
    functionName: 'currentRoot',
  });

  if (rebuiltRoot !== onChainRoot) {
    fail(`rebuilt root ${rebuiltRoot} != pool currentRoot() ${onChainRoot}`);
    console.error('  A merkle proof against this tree would be rejected by the pool.');
  } else {
    pass('the rebuilt root EQUALS the pool\'s currentRoot()');
  }

  // The last event's root should also agree, which makes the event stream
  // self-checking without a contract read.
  const lastEventRoot = byIndex[byIndex.length - 1]?.args._root;
  if (lastEventRoot !== onChainRoot) {
    fail(`the last LeafInserted root ${lastEventRoot} != currentRoot() ${onChainRoot}`);
  } else {
    pass('the last LeafInserted root agrees with currentRoot()');
  }

  // Cross-check the count against the ASP's view of the same tree.
  try {
    const res = await fetch(
      'https://api.0xbow.io/42161/public/mt-leaves',
      {
        headers: {
          'X-Pool-Scope':
            '19314316433070648921215665277427138450050666275686107272761703472573535400848',
        },
      },
    );
    const body = (await res.json()) as { stateTreeLeaves?: unknown[] };
    const aspCount = body.stateTreeLeaves?.length ?? -1;
    if (aspCount !== leaves.length) {
      console.log(`  note: ASP reports ${aspCount} state leaves, chain has ${leaves.length}`);
      console.log('  (the ASP snapshot lags; the CHAIN is authoritative for the state tree)');
    } else {
      pass(`the ASP's state leaf count agrees: ${aspCount}`);
    }
  } catch {
    console.log('  note: could not cross-check against the ASP');
  }
} catch (error) {
  fail(error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error));
}

process.exit(failed ? 1 : 0);
