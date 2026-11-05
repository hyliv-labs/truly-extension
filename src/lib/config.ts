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
 * Bootstrap RPC, used ONLY to read the anon-rpc specifier contract. It breaks
 * the circular "need the chain to reach the chain" dependency and sees exactly
 * one read; everything else goes through the harness.
 */
export const BOOTSTRAP_RPC_URL =
  import.meta.env.WXT_BOOTSTRAP_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';

/**
 * The anon-rpc IWorkerSpecifier contract, which identifies the anon-client by
 * hash. OPEN QUESTION for the Ethereum Foundation booth: which specifier to
 * use for Arbitrum reads. Until it is set, every read is refused.
 */
export const ANON_RPC_SPECIFIER = import.meta.env.WXT_ANON_RPC_SPECIFIER as
  | Address
  | undefined;

/** Destination the anon-client proxies reads to. */
export const ARBITRUM_RPC_URL =
  import.meta.env.WXT_ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';

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

  return problems;
}
