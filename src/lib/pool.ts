/**
 * Reads the deployed pool and refuses to work against anything that does not
 * match the configuration.
 *
 * The scope is an input to every note derivation. A wrong scope does not
 * error: it derives notes for a pool the funds are not in, findable by nobody.
 * So the chain is the authority here and the config is only a cross-check —
 * never the other way round.
 */

import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { anonRpcCall } from './anon-rpc';
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
  const address = PRIVACY_POOL_ADDRESS;
  if (!address) {
    throw new PoolMismatch('No pool address configured.');
  }

  // Not publicClient.readContract. viem's eth_call catch always dynamic-imports
  // its CCIP handler before it looks at ccipRead, and Chrome forbids that import
  // in a service worker. Any failed read then surfaces as "An unknown error
  // occurred" and the real RPC error is discarded.
  const read = (functionName: 'SCOPE' | 'ASSET' | 'ENTRYPOINT' | 'dead') =>
    readPoolView(address, functionName);

  let identity: PoolIdentity;
  try {
    const [scope, asset, entrypoint, isDead] = await Promise.all([
      read('SCOPE'),
      read('ASSET'),
      read('ENTRYPOINT'),
      read('dead'),
    ]);
    identity = {
      pool: address,
      scope: scope as bigint,
      asset: asset as Address,
      entrypoint: entrypoint as Address,
      dead: isDead as boolean,
    };
  } catch (error) {
    const detail = errorText(error);
    const transport = /anon-rpc|timed? ?out|429|403|fetch|gateway|network/i.test(detail);
    throw new PoolMismatch(
      transport
        ? `Could not read Privacy Pools at ${address}: ${detail}`
        : `${address} does not answer the Privacy Pools v1 interface: ${detail}`,
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

async function readPoolView(
  address: Address,
  functionName: 'SCOPE' | 'ASSET' | 'ENTRYPOINT' | 'dead',
): Promise<bigint | Address | boolean> {
  const data = encodeFunctionData({ abi: poolAbi, functionName });
  const result = await anonRpcCall('eth_call', [{ to: address, data }, 'latest']);
  if (typeof result !== 'string' || !result.startsWith('0x') || result === '0x') {
    throw new Error(`${functionName} returned no data`);
  }
  return decodeFunctionResult({ abi: poolAbi, functionName, data: result as Hex });
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const nested = (error as { cause?: unknown }).cause;
  const own = error.message.split('\n')[0] ?? error.message;
  if (!nested) return own;
  const deeper = errorText(nested);
  return deeper && deeper !== own && !own.includes(deeper) ? `${own}: ${deeper}` : own;
}
