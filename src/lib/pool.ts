/**
 * Reads the deployed pool and refuses to work against anything that does not
 * match the configuration.
 *
 * The scope is an input to every note derivation. A wrong scope does not
 * error: it derives notes for a pool the funds are not in, findable by nobody.
 * So the chain is the authority here and the config is only a cross-check —
 * never the other way round.
 */

import { parseAbi, type Address } from 'viem';
import { publicClient } from './chain';
import {
  PRIVACY_POOL_ADDRESS,
  PRIVACY_POOL_ENTRYPOINT,
  PRIVACY_POOL_SCOPE,
  USDC_ADDRESS,
} from './config';

/** privacy-pools-core PrivacyPool. v2 has no contract with this surface. */
const poolAbi = parseAbi([
  'function SCOPE() view returns (uint256)',
  'function ASSET() view returns (address)',
  'function ENTRYPOINT() view returns (address)',
  'function dead() view returns (bool)',
]);

export interface PoolIdentity {
  readonly pool: Address;
  /** Read from the chain. This is the value note derivation must use. */
  readonly scope: bigint;
  readonly asset: Address;
  readonly entrypoint: Address;
  readonly dead: boolean;
}

export class PoolMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoolMismatch';
  }
}

/**
 * Read the pool's identity and check it against the configuration.
 *
 * Returns the ON-CHAIN values, so callers that use the result cannot
 * accidentally keep using a stale configured scope.
 */
export async function readPoolIdentity(): Promise<PoolIdentity> {
  if (!PRIVACY_POOL_ADDRESS) {
    throw new PoolMismatch('No pool address configured.');
  }

  const read = <T>(functionName: 'SCOPE' | 'ASSET' | 'ENTRYPOINT' | 'dead') =>
    publicClient.readContract({
      address: PRIVACY_POOL_ADDRESS,
      abi: poolAbi,
      functionName,
    }) as Promise<T>;

  let identity: PoolIdentity;
  try {
    const [scope, asset, entrypoint, isDead] = await Promise.all([
      read<bigint>('SCOPE'),
      read<Address>('ASSET'),
      read<Address>('ENTRYPOINT'),
      read<boolean>('dead'),
    ]);
    identity = { pool: PRIVACY_POOL_ADDRESS, scope, asset, entrypoint, dead: isDead };
  } catch (error) {
    // A pool that cannot answer this surface is not a privacy-pools-core pool
    // — which is exactly what a v2 address, or a wrong chain, would look like.
    throw new PoolMismatch(
      `${PRIVACY_POOL_ADDRESS} does not answer the Privacy Pools v1 interface: ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }`,
    );
  }

  if (identity.dead) {
    throw new PoolMismatch(`Pool ${identity.pool} is marked dead and must not be used.`);
  }

  if (identity.asset.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
    throw new PoolMismatch(
      `Pool asset is ${identity.asset}, not the configured USDC ${USDC_ADDRESS}.`,
    );
  }

  if (
    PRIVACY_POOL_ENTRYPOINT &&
    identity.entrypoint.toLowerCase() !== PRIVACY_POOL_ENTRYPOINT.toLowerCase()
  ) {
    throw new PoolMismatch(
      `Pool reports entrypoint ${identity.entrypoint}, but ${PRIVACY_POOL_ENTRYPOINT} is configured. Depositing through the wrong entrypoint sends funds somewhere this pool will not see.`,
    );
  }

  if (PRIVACY_POOL_SCOPE && BigInt(PRIVACY_POOL_SCOPE) !== identity.scope) {
    throw new PoolMismatch(
      `Configured scope ${PRIVACY_POOL_SCOPE} does not match the pool's SCOPE() ${identity.scope}. Notes derived with the configured value would belong to a different pool and be findable by nobody.`,
    );
  }

  return identity;
}

/**
 * The scope to derive notes with — always the chain's, never the config's.
 */
export async function authoritativeScope(): Promise<bigint> {
  return (await readPoolIdentity()).scope;
}
