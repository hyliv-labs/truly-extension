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
 * Bootstrap RPC, used ONLY to read the anon-rpc specifier contract once. It
 * breaks the circular "need the chain to reach the chain" dependency.
 *
 * ETHEREUM MAINNET, not Arbitrum. The specifier contract is published on
 * Ethereum; the chain the anon-client then *fetches* from is a separate thing
 * entirely (ARBITRUM_RPC_URL below). Pointing this at Arbitrum reads an
 * address with no contract there, and the failure says nothing useful.
 */
export const BOOTSTRAP_RPC_URL =
  env('WXT_BOOTSTRAP_RPC_URL') ?? 'https://ethereum-rpc.publicnode.com';

/**
 * The anon-rpc IWorkerSpecifier contract, which pins the anon-client by hash.
 *
 * Defaults to tor-js, from anon-rpc's own adopters.json5 — a published worker
 * of kind "network", meaning it actually anonymises. Verified to have bytecode
 * on Ethereum mainnet.
 *
 * Do NOT substitute the passthrough worker
 * (0x4fd77be300f31c5fe6ab266d35d27750a3478d27): it is kind "reference" and
 * fulfils calls with an ordinary fetch, so requests are not anonymised at all.
 * It demonstrates the sandbox, not privacy, and using it would quietly void
 * the entire claim this extension makes.
 *
 * Alternative network worker: nym, 0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0
 * (~18 MB bundle, several seconds to bootstrap).
 */
export const ANON_RPC_SPECIFIER = (env('WXT_ANON_RPC_SPECIFIER') ??
  '0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e') as Address;

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
 * The pool's scope. Configured only as a cross-check — src/lib/pool.ts reads
 * SCOPE() from the chain and that value is authoritative, because a wrong
 * scope derives notes for a pool the funds are not in and errors nowhere.
 */
export const PRIVACY_POOL_SCOPE = env('WXT_PRIVACY_POOL_SCOPE');

/**
 * Read from the entrypoint's assetConfig(USDC) on Arbitrum, in 6-decimal USDC
 * units. The pool itself REJECTS a deposit below this, so a re-shield that
 * would land under it must not be attempted.
 */
export const POOL_MIN_DEPOSIT_UNITS = 5_000_000n;

/**
 * Entrypoint vetting fee, 50 BPS = 0.5%, taken from every deposit. Verified on
 * chain. A re-shield therefore returns less than it sends, which matters when
 * sizing against POOL_MIN_DEPOSIT_UNITS.
 */
export const POOL_VETTING_FEE_BPS = 50n;

/** Relayer fee ceiling the entrypoint enforces, 1000 BPS = 10%. */
export const POOL_MAX_RELAY_FEE_BPS = 1000n;

/**
 * fastrelay.xyz's BASE rate on Arbitrum USDC, from /relayer/details.
 *
 * This is NOT what a withdrawal pays. /relayer/quote amortises the relay
 * transaction's gas into the rate, and that gas is a FIXED cost, so the
 * effective rate rises sharply as the withdrawal shrinks. Measured live
 * (scripts/relayer-quote-check.ts):
 *
 *     5 USDC -> 68 BPS      50 USDC -> 15 BPS
 *    10 USDC -> 39 BPS     100 USDC -> 12 BPS
 *    25 USDC -> 21 BPS     250 USDC -> 11 BPS
 *
 * Treating this as a constant would under-reserve by ~6x at the pool floor.
 * Use estimateRelayerFeeUnits() for sizing, and the live quote to transact.
 */
export const RELAYER_BASE_FEE_BPS = 10n;

/**
 * The fixed gas component the relayer folds in, in USDC units. Derived from
 * the curve above: 250 USDC pays $0.275 against a $0.25 base, leaving ~$0.025;
 * 5 USDC pays $0.034 against a $0.005 base, leaving ~$0.029. Rounded up,
 * because under-reserving strands funds and over-reserving only costs dust.
 */
export const RELAYER_FIXED_FEE_UNITS = 35_000n; // $0.035

/**
 * Conservative pre-quote estimate of what a relayed withdrawal costs.
 *
 * Only for SIZING — deciding whether a withdrawal is worth attempting and how
 * much to leave behind. The authoritative number is the relayer's quote, which
 * must be obtained before the context is computed, since the fee terms are
 * inside the withdrawal data the context commits to.
 */
export function estimateRelayerFeeUnits(amountUnits: bigint): bigint {
  return (amountUnits * RELAYER_BASE_FEE_BPS) / 10_000n + RELAYER_FIXED_FEE_UNITS;
}

/**
 * Where the Privacy Pools circuit artifacts (.wasm / .zkey) are served from.
 *
 * They are NOT shipped in the SDK and 0xbow publishes no release assets, so
 * they have to be placed in public/privacy-pools/ and served from the
 * extension's own origin. MV3 forbids remote code, so fetching them from a CDN
 * is not an alternative.
 */
export const CIRCUIT_ARTIFACT_PATH = 'privacy-pools/';

/**
 * Circle Paymaster v0.8 on Arbitrum One — pays gas in USDC so the owner
 * address never needs ETH, which is the whole point: funding it with ETH from
 * anywhere would link it to whoever sent the ETH.
 *
 * Verified: this address has bytecode on Arbitrum mainnet and Circle's
 * addresses page lists it as v0.8 mainnet. v0.7 is a DIFFERENT address
 * (0x6C973eBe80dCD8660841D4356bf15c32460271C9) paired with EntryPoint v0.7.
 */
export const CIRCLE_PAYMASTER: Address =
  '0x0578cFB241215b77442a541325d6A4E6dFE700Ec';

/**
 * Circle's own samples use Pimlico's public endpoint. Overridable because the
 * public one carries undocumented rate limits, which is exactly the kind of
 * thing that fails during a demo.
 */
export const BUNDLER_URL =
  env('WXT_BUNDLER_URL') ?? `https://public.pimlico.io/v2/${ARBITRUM_CHAIN_ID}/rpc`;

/** Circle's documented sample values. */
export const PAYMASTER_VERIFICATION_GAS_LIMIT = 200_000n;
export const PAYMASTER_POST_OP_GAS_LIMIT = 35_000n;

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
