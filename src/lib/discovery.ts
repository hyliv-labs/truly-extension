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
import { DataService } from '@0xbow/privacy-pools-core-sdk';
import { publicClient } from './chain';
import {
  ARBITRUM_CHAIN_ID,
  LOG_CHUNK_SIZE,
  PRIVACY_POOL_ADDRESS,
  PRIVACY_POOL_ENTRYPOINT,
} from './config';

/** The deployment block of the Arbitrum USDC pool. */
export const POOL_DEPLOYMENT_BLOCK = 411197154n;

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
