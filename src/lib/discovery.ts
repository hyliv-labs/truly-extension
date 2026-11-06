/**
 * Note discovery over anon-rpc.
 *
 * The SDK's DataService takes an `rpcUrl` STRING and builds its own transport:
 *
 *     createPublicClient({ transport: http(config.rpcUrl, { ... }) })
 *
 * So by default every discovery read goes straight to that URL, bypassing the
 * anon-rpc harness entirely. That is not a small leak: discovery is the one
 * operation that scans the whole pool, and doing it from the user's own IP
 * tells the provider this address is interested in Privacy Pools — the exact
 * association the extension exists to prevent.
 *
 * It cannot be configured away, but it does not need to be. All three fetchers
 * (getDeposits, getWithdrawals, getRagequits) obtain their client through
 * `getClientForChain(chainId)`, which reads the instance's `clients` map. So
 * replacing the entry after construction redirects every one of them, with no
 * subclassing and no re-implementation of the fetch/retry logic.
 *
 * A string URL is still required by the constructor, which validates it is
 * non-empty. It is never dialled once the client is replaced.
 */

import type { PublicClient } from 'viem';
import { AccountService, DataService } from '@0xbow/privacy-pools-core-sdk';
import { publicClient } from './chain';
import {
  ARBITRUM_CHAIN_ID,
  LOG_CHUNK_SIZE,
  POOL_DEPLOYMENT_BLOCK,
  PRIVACY_POOL_ADDRESS,
  PRIVACY_POOL_ENTRYPOINT,
} from './config';

/**
 * Placeholder satisfying DataService's non-empty rpcUrl check. Never reached:
 * the client that would dial it is replaced before any read.
 */
const UNUSED_RPC_URL = 'http://anon-rpc.invalid';

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/**
 * Shape of the private field we reach into. Narrow on purpose: if a future SDK
 * version renames or removes it, the guard below fails loudly instead of
 * silently reverting to direct RPC.
 */
interface ClientBearing {
  clients: Map<number, unknown>;
}

/**
 * Build a DataService whose reads all go through anon-rpc.
 *
 * Throws rather than degrading. Falling back to a direct RPC would still
 * *work* — which is precisely why it must not happen silently.
 */
export function createAnonDataService(): DataService {
  if (!PRIVACY_POOL_ADDRESS || !PRIVACY_POOL_ENTRYPOINT) {
    throw new DiscoveryError('No pool or entrypoint address configured; cannot discover notes.');
  }

  const service = new DataService(
    [
      {
        chainId: ARBITRUM_CHAIN_ID,
        privacyPoolAddress: PRIVACY_POOL_ADDRESS,
        entryPointAddress: PRIVACY_POOL_ENTRYPOINT,
        startBlock: POOL_DEPLOYMENT_BLOCK,
        rpcUrl: UNUSED_RPC_URL,
        apiKey: '',
      } as never,
    ],
    // Measured ceiling for the configured provider. At the SDK's 10k default a
    // full scan is ~11,000 sequential calls; at this size it is ~12.
    new Map([[ARBITRUM_CHAIN_ID, { blockChunkSize: LOG_CHUNK_SIZE, concurrency: 2 }]]) as never,
  );

  const bearer = service as unknown as ClientBearing;
  if (!(bearer.clients instanceof Map)) {
    throw new DiscoveryError(
      "This SDK version does not expose DataService.clients, so discovery cannot be routed through anon-rpc. Refusing to scan over a direct RPC, which would reveal this address's interest in the pool.",
    );
  }
  if (!bearer.clients.has(ARBITRUM_CHAIN_ID)) {
    throw new DiscoveryError(
      `DataService built no client for chain ${ARBITRUM_CHAIN_ID}; the anon-rpc swap would be a no-op.`,
    );
  }

  bearer.clients.set(ARBITRUM_CHAIN_ID, publicClient as PublicClient);
  return service;
}

/**
 * Whether `service`'s reads for Arbitrum go through anon-rpc.
 *
 * Exported so the swap can be asserted in tests: a leak here is invisible at
 * runtime, since discovery succeeds either way.
 */
export function usesAnonTransport(service: DataService): boolean {
  const bearer = service as unknown as ClientBearing;
  return bearer.clients instanceof Map && bearer.clients.get(ARBITRUM_CHAIN_ID) === publicClient;
}

/* ------------------------------------------------------------------------ *
 * Finding the notes this vault can spend.
 * ------------------------------------------------------------------------ */

/**
 * Shape of the SDK's account model that we read.
 *
 * `children` is the chain's record of this label's change notes, and its
 * LENGTH is what the SDK uses as the next withdrawal index — in
 * createWithdrawalSecrets and in the Withdrawn replay alike. It must travel
 * with the note, or a caller would have to invent the index and strand funds.
 */
interface PoolAccountLike {
  label: bigint;
  deposit: CommitmentLike;
  children: CommitmentLike[];
  ragequit?: unknown;
  isMigrated?: boolean;
}

interface CommitmentLike {
  hash: bigint;
  value: bigint;
  nullifier: bigint;
  secret: bigint;
}

export interface DiscoveredNote {
  readonly label: bigint;
  readonly value: bigint;
  readonly nullifier: bigint;
  readonly secret: bigint;
  readonly commitmentHash: bigint;
  /** account.children.length — the authority for the next withdrawal index. */
  readonly childrenCount: number;
}

/**
 * Scan the pool and return every note this mnemonic can spend.
 *
 * The spendable commitment is the account's LAST child, or the deposit if it
 * has none — a partial withdrawal supersedes what came before it, so spending
 * an earlier commitment would present an already-spent nullifier.
 *
 * Ragequit and migrated accounts are skipped: their value is no longer
 * spendable from here.
 */
export async function findSpendableNotes(
  mnemonic: string,
  scope: bigint,
): Promise<DiscoveredNote[]> {
  if (!PRIVACY_POOL_ADDRESS) {
    throw new DiscoveryError('No pool address configured; cannot discover notes.');
  }

  const dataService = createAnonDataService();
  const account = new AccountService(dataService, { mnemonic });

  await account.retrieveHistory([
    {
      chainId: ARBITRUM_CHAIN_ID,
      address: PRIVACY_POOL_ADDRESS,
      scope: scope as never,
      deploymentBlock: POOL_DEPLOYMENT_BLOCK,
    } as never,
  ]);

  const accounts = (
    account as unknown as { account: { poolAccounts: Map<unknown, PoolAccountLike[]> } }
  ).account?.poolAccounts;

  if (!(accounts instanceof Map)) {
    throw new DiscoveryError(
      'This SDK version does not expose poolAccounts, so the withdrawal index cannot be read from chain history. Refusing to guess it.',
    );
  }

  const notes: DiscoveredNote[] = [];
  for (const list of accounts.values()) {
    for (const poolAccount of list) {
      if (poolAccount.ragequit || poolAccount.isMigrated) continue;

      const children = poolAccount.children ?? [];
      const spendable = children.length > 0 ? children[children.length - 1] : poolAccount.deposit;
      if (!spendable || spendable.value === 0n) continue;

      notes.push({
        label: poolAccount.label,
        value: spendable.value,
        nullifier: spendable.nullifier,
        secret: spendable.secret,
        commitmentHash: spendable.hash,
        childrenCount: children.length,
      });
    }
  }

  // Largest first: a trade should spend the note that leaves the healthiest
  // remainder, and a note too small to split is the last resort.
  notes.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  return notes;
}

/** Total spendable across all notes. For the popup's balance line. */
export function totalSpendable(notes: readonly DiscoveredNote[]): bigint {
  return notes.reduce((sum, note) => sum + note.value, 0n);
}
