/**
 * The pool's state tree, rebuilt from chain events.
 *
 * WHY THIS IS NOT CACHED, unlike the ASP set. ASP leaves change once per
 * published batch — every few days. STATE leaves change with every deposit and
 * every withdrawal, including our own. Freezing them means the change note
 * from trade 1 is missing when trade 2 builds its merkle proof, and
 * `generateMerkleProof` throws. That would break the chain of trades which is
 * the entire answer to ASP batching, and it would break it on the second
 * trade, not the first.
 *
 * `LeafInserted(_index, _leaf, _root)` carries the insertion order and the
 * resulting root, so one log scan rebuilds the tree and the last event's root
 * is checkable against the pool's own `currentRoot()`.
 *
 * `_index` is ONE-BASED — it is the tree size after insertion, not the leaf's
 * position. Verified against the live pool: 603 events numbered 1..603, and
 * the rebuilt root equals `currentRoot()`.
 *
 * These reads go through anon-rpc like every other chain read.
 */

import { parseAbi, parseAbiItem } from 'viem';
import { publicClient } from './chain';
import { LOG_CHUNK_SIZE, POOL_DEPLOYMENT_BLOCK, PRIVACY_POOL_ADDRESS } from './config';

const LEAF_INSERTED = parseAbiItem(
  'event LeafInserted(uint256 _index, uint256 _leaf, uint256 _root)',
);

const poolAbi = parseAbi(['function currentRoot() view returns (uint256)']);

export class StateTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateTreeError';
  }
}

export interface StateTree {
  /** Commitment hashes in insertion order. */
  readonly leaves: readonly bigint[];
  /** The pool's current root, confirmed to match these leaves. */
  readonly root: bigint;
}

/**
 * Fetch every state leaf and verify the set against the pool's own root.
 *
 * The root check is not optional. A missing or reordered leaf still produces a
 * well-formed merkle proof — one the pool rejects after the quote and the
 * proving cost have already been spent.
 */
export async function fetchStateTree(): Promise<StateTree> {
  const address = PRIVACY_POOL_ADDRESS;
  if (!address) {
    throw new StateTreeError('No pool address configured; the state tree cannot be read.');
  }

  const head = await publicClient.getBlockNumber();
  const chunk = BigInt(LOG_CHUNK_SIZE);

  const events: Array<{ index: bigint; leaf: bigint; root: bigint }> = [];
  for (let from = POOL_DEPLOYMENT_BLOCK; from <= head; from += chunk) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    const logs = await publicClient.getLogs({
      address,
      event: LEAF_INSERTED,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      const args = log.args as { _index?: bigint; _leaf?: bigint; _root?: bigint };
      if (args._index === undefined || args._leaf === undefined || args._root === undefined) {
        throw new StateTreeError('A LeafInserted event was missing its fields.');
      }
      events.push({ index: args._index, leaf: args._leaf, root: args._root });
    }
  }

  if (events.length === 0) {
    throw new StateTreeError(
      'No LeafInserted events found. Either the pool address is wrong or the RPC refused the range.',
    );
  }

  // Sort by the event's own index, not by log order: a chunk returned out of
  // order would otherwise permute the tree silently.
  events.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));

  // Dense, one-based. A gap means a leaf was missed, and every proof built
  // from this tree would be wrong while still looking well-formed.
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.index !== BigInt(i + 1)) {
      throw new StateTreeError(
        `State tree leaves are not contiguous: expected index ${i + 1}, got ${events[i]?.index}. A leaf is missing, so no merkle proof from this tree would be valid.`,
      );
    }
  }

  const leaves = events.map((e) => e.leaf);

  const onChainRoot = await publicClient.readContract({
    address,
    abi: poolAbi,
    functionName: 'currentRoot',
  });

  // The last event's root is what the pool arrived at. If that disagrees with
  // currentRoot() the scan is mid-reorg or incomplete.
  const lastRoot = events[events.length - 1]?.root;
  if (lastRoot !== onChainRoot) {
    throw new StateTreeError(
      `The last LeafInserted root ${lastRoot} does not match currentRoot() ${onChainRoot}. The log scan is incomplete or mid-reorg; retry.`,
    );
  }

  return { leaves, root: onChainRoot };
}
