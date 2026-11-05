/**
 * Deployment-specific addresses and endpoints.
 *
 * Anything still unanswered is read from the environment rather than guessed,
 * so a missing value fails loudly at the point of use instead of silently
 * reading from the wrong place.
 */

import type { Address } from 'viem';

/** Arbitrum One. */
export const ARBITRUM_CHAIN_ID = 42161;

/**
 * Native USDC on Arbitrum (Circle), not the bridged USDC.e. The pool, Lighter
 * deposits and the Circle Paymaster all work in this one.
 */
export const USDC_ADDRESS: Address = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

/**
 * import.meta.env exists under the bundler but not under plain Node, which is
 * how the scripts/ checks run. Fall through to process.env there so the same
 * modules are exercised by the tests rather than a stub.
 */
function env(key: string): string | undefined {
  const fromBundler = (import.meta as { env?: Record<string, string | undefined> }).env;
  return fromBundler?.[key] ?? globalThis.process?.env?.[key];
}

/**
 * Bootstrap RPC, used ONLY to read the anon-rpc specifier contract. It breaks
 * the circular "need the chain to reach the chain" dependency and sees exactly
 * one read; everything else goes through the harness.
 */
export const BOOTSTRAP_RPC_URL =
  env('WXT_BOOTSTRAP_RPC_URL') ?? 'https://arb1.arbitrum.io/rpc';

/**
 * The anon-rpc IWorkerSpecifier contract, which identifies the anon-client by
 * hash. OPEN QUESTION for the Ethereum Foundation booth: which specifier to
 * use for Arbitrum reads. Until it is set, every read is refused.
 */
export const ANON_RPC_SPECIFIER = env('WXT_ANON_RPC_SPECIFIER') as
  | Address
  | undefined;

/** Destination the anon-client proxies reads to. */
export const ARBITRUM_RPC_URL =
  env('WXT_ARBITRUM_RPC_URL') ?? 'https://arb1.arbitrum.io/rpc';

/**
 * Privacy Pools v2 on Arbitrum. OPEN QUESTIONS for the 0xbow booth: the pool,
 * entrypoint and relayer addresses, and the minimum deposit.
 */
export const PRIVACY_POOL_ENTRYPOINT = env('WXT_PRIVACY_POOL_ENTRYPOINT') as
  | Address
  | undefined;
export const PRIVACY_POOL_ADDRESS = env('WXT_PRIVACY_POOL_ADDRESS') as
  | Address
  | undefined;
export const PRIVACY_POOL_RELAYER_URL = env('WXT_PRIVACY_POOL_RELAYER_URL');

/**
 * Where the Privacy Pools circuit artifacts (.wasm / .zkey) are served from.
 *
 * They are NOT shipped in the SDK and 0xbow publishes no release assets, so
 * they have to be placed in public/privacy-pools/ and served from the
 * extension's own origin. MV3 forbids remote code, so fetching them from a CDN
 * is not an alternative.
 */
export const CIRCUIT_ARTIFACT_PATH = 'privacy-pools/';

export interface ConfigProblem {
  readonly key: string;
  readonly reason: string;
}

/**
 * Everything missing that would block a money-moving step. E2 requires the
 * popup to show the reason rather than failing opaquely.
 */
export function configProblems(): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  if (!ANON_RPC_SPECIFIER) {
    problems.push({
      key: 'WXT_ANON_RPC_SPECIFIER',
      reason:
        'No anon-rpc specifier contract set, so reads cannot be anonymised. Ask the Ethereum Foundation booth which specifier to use on Arbitrum.',
    });
  }

  if (!PRIVACY_POOL_ENTRYPOINT || !PRIVACY_POOL_ADDRESS) {
    problems.push({
      key: 'WXT_PRIVACY_POOL_ENTRYPOINT',
      reason:
        'No Privacy Pools entrypoint or pool address set, so funds cannot be withdrawn from the pool. Ask the 0xbow booth for the Arbitrum USDC pool addresses.',
    });
  }

  if (!PRIVACY_POOL_RELAYER_URL) {
    problems.push({
      key: 'WXT_PRIVACY_POOL_RELAYER_URL',
      reason:
        'No Privacy Pools relayer set. Without it the withdrawal would have to be paid for by the owner address, which would link it to the deposit.',
    });
  }

  return problems;
}
