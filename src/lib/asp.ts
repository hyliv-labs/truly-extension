/**
 * E3 step 1: the ASP association set.
 *
 * A withdrawal proves two memberships — its commitment in the pool's state
 * tree, and its LABEL in the ASP's approved set. The pool then checks:
 *
 *     if (_proof.ASPRoot() != ENTRYPOINT.latestRoot()) revert IncorrectASPRoot();
 *
 * STRICT EQUALITY against one value. The entrypoint exposes rootByIndex(), but
 * the pool never consults it, so a proof built against yesterday's root simply
 * reverts. (The STATE root is different: that one goes through _isKnownRoot(),
 * a real history.)
 *
 * WHY THIS IS CACHED. Fetching the tree is a plain HTTPS call to 0xbow from
 * the user's IP — anon-rpc is a JSON-RPC proxy and cannot carry it. Pulling it
 * immediately before each withdrawal would hand 0xbow the timing of every one.
 * The root only moves when the ASP publishes a batch (observed: every few
 * days), so instead we cache the tree and compare its root against
 * latestRoot() over anon-rpc — a read that IS anonymised — refetching only
 * when they diverge.
 *
 * It also has to happen BEFORE the relayer quote: the quote's feeCommitment
 * lives for 60 seconds, and a Tor-routed fetch inside that window would expire
 * it.
 */

import { parseAbi } from 'viem';
import { publicClient } from './chain';
import { ARBITRUM_CHAIN_ID, ASP_API_BASE, PRIVACY_POOL_ENTRYPOINT } from './config';

const LOCAL_ASP_CACHE = 'truly:aspCache';

const entrypointAbi = parseAbi(['function latestRoot() view returns (uint256)']);

export class AspUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AspUnavailable';
  }
}

export interface AssociationSet {
  /** Approved labels. A commitment is spendable iff its label is in here. */
  readonly aspLeaves: readonly bigint[];
  /** Commitment hashes, in insertion order — the pool's state tree. */
  readonly stateTreeLeaves: readonly bigint[];
  /** The ASP root these leaves produce, as the API reports it. */
  readonly root: bigint;
  /** When this was fetched, for display only — never for validity. */
  readonly fetchedAt: number;
}

interface CachedSet {
  aspLeaves: string[];
  stateTreeLeaves: string[];
  root: string;
  fetchedAt: number;
}

/** The API returns decimal strings, hex strings, or numbers depending on route. */
function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      throw new AspUnavailable(`ASP returned an unparseable ${field}: ${value}`);
    }
  }
  throw new AspUnavailable(`ASP response is missing ${field}`);
}

async function aspFetch(path: string, scope: bigint): Promise<unknown> {
  const url = `${ASP_API_BASE}/${ARBITRUM_CHAIN_ID}/public/${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      // The scope selects the pool; without it the API answers for a
      // different pool, whose leaves would prove nothing about ours.
      headers: { 'X-Pool-Scope': scope.toString() },
    });
  } catch (error) {
    throw new AspUnavailable(
      `Could not reach the ASP at ${ASP_API_BASE}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new AspUnavailable(`ASP ${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

/** The root the pool will accept right now. Read over anon-rpc. */
export async function onChainAspRoot(): Promise<bigint> {
  if (!PRIVACY_POOL_ENTRYPOINT) {
    throw new AspUnavailable('No entrypoint configured; cannot read the accepted ASP root.');
  }
  return publicClient.readContract({
    address: PRIVACY_POOL_ENTRYPOINT,
    abi: entrypointAbi,
    functionName: 'latestRoot',
  });
}

async function readCache(): Promise<AssociationSet | null> {
  const stored = await chrome.storage.local.get(LOCAL_ASP_CACHE);
  const cached = stored[LOCAL_ASP_CACHE] as CachedSet | undefined;
  if (!cached?.aspLeaves || !cached.stateTreeLeaves || !cached.root) return null;
  try {
    return {
      aspLeaves: cached.aspLeaves.map((v) => BigInt(v)),
      stateTreeLeaves: cached.stateTreeLeaves.map((v) => BigInt(v)),
      root: BigInt(cached.root),
      fetchedAt: cached.fetchedAt ?? 0,
    };
  } catch {
    // A corrupt cache must not wedge withdrawals; treat it as absent.
    return null;
  }
}

async function writeCache(set: AssociationSet): Promise<void> {
  const serialised: CachedSet = {
    aspLeaves: set.aspLeaves.map(String),
    stateTreeLeaves: set.stateTreeLeaves.map(String),
    root: set.root.toString(),
    fetchedAt: set.fetchedAt,
  };
  await chrome.storage.local.set({ [LOCAL_ASP_CACHE]: serialised });
}

/** Fetch the association set from 0xbow. Always a plain, non-anonymised call. */
export async function fetchAssociationSet(scope: bigint): Promise<AssociationSet> {
  const leaves = (await aspFetch('mt-leaves', scope)) as {
    aspLeaves?: unknown[];
    stateTreeLeaves?: unknown[];
  };
  if (!Array.isArray(leaves.aspLeaves) || !Array.isArray(leaves.stateTreeLeaves)) {
    throw new AspUnavailable('ASP mt-leaves did not return aspLeaves and stateTreeLeaves arrays.');
  }

  const roots = (await aspFetch('mt-roots', scope)) as { mtRoot?: unknown };
  const root = toBigInt(roots.mtRoot, 'mtRoot');

  const set: AssociationSet = {
    aspLeaves: leaves.aspLeaves.map((v, i) => toBigInt(v, `aspLeaves[${i}]`)),
    stateTreeLeaves: leaves.stateTreeLeaves.map((v, i) => toBigInt(v, `stateTreeLeaves[${i}]`)),
    root,
    fetchedAt: Date.now(),
  };

  if (set.aspLeaves.length === 0) {
    throw new AspUnavailable('ASP returned an empty approved set; no withdrawal could prove.');
  }
  await writeCache(set);
  return set;
}

export interface AssociationSetResult {
  readonly set: AssociationSet;
  /** True if the cached copy was reused — i.e. 0xbow was not contacted. */
  readonly fromCache: boolean;
}

/**
 * The association set to prove against, guaranteed to match the root the pool
 * accepts at the moment it is read.
 *
 * Compares the cached root against latestRoot() over anon-rpc and refetches
 * only on divergence, so a withdrawal normally contacts 0xbow not at all.
 *
 * This is still a RACE, not a guarantee: the ASP can publish between this
 * check and inclusion. That is why `IncorrectASPRoot` must be handled as
 * retryable — see withdraw.ts.
 */
export async function getAssociationSet(scope: bigint): Promise<AssociationSetResult> {
  const accepted = await onChainAspRoot();

  const cached = await readCache();
  if (cached && cached.root === accepted) {
    return { set: cached, fromCache: true };
  }

  const fresh = await fetchAssociationSet(scope);
  if (fresh.root !== accepted) {
    // The ASP's published root disagrees with the one the pool enforces.
    // Proving against either would revert, so refuse rather than burn a quote
    // and a proof on a withdrawal that cannot land.
    throw new AspUnavailable(
      `The ASP publishes root ${fresh.root} but the pool accepts ${accepted}. ` +
        'A proof against either would revert. This usually means the ASP is mid-publish; retry shortly.',
    );
  }
  return { set: fresh, fromCache: false };
}

/** Whether a label has been approved. Cheap pre-check before quoting. */
export function isLabelApproved(set: AssociationSet, label: bigint): boolean {
  return set.aspLeaves.includes(label);
}

/** Clears the cached set. For tests and for a manual "refresh" affordance. */
export async function clearAssociationSetCache(): Promise<void> {
  await chrome.storage.local.remove(LOCAL_ASP_CACHE);
}
