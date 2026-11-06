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
  const value = fromBundler?.[key] ?? globalThis.process?.env?.[key];

  // An EMPTY string counts as unset. A .env file written from .env.example
  // leaves keys blank to mean "use the default", but `??` only falls back on
  // undefined — so a blank line silently became a real empty value.
  //
  // That cost an evening: WXT_ANON_RPC_SPECIFIER= made the anon-rpc harness
  // read the specifier contract at address '', and every chain read then
  // failed with "invalid argument 0: hex string has length 0, want 40 for
  // common.Address" — an error naming neither the variable nor the file.
  // Downstream it surfaced as "the pool does not answer the Privacy Pools v1
  // interface", which was simply untrue.
  return value === undefined || value.trim() === '' ? undefined : value;
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
 * Defaults to NYM, not tor-js, on measurement rather than preference. Both are
 * kind "network" in anon-rpc's adopters.json5, so both genuinely anonymise —
 * the privacy claim holds either way.
 *
 * nym runs a mixnet client inside the sandbox and needs no gateway. Verified
 * working in-browser: the tunnel reports ready in ~20s and a full note
 * discovery scan (12 eth_getLogs) completes over it in 19s.
 *
 * tor-js relays through a KPS gateway because browsers cannot open the raw TCP
 * Tor needs, and the only published gateway is explicitly a demonstration one
 * — "limited capacity, and it may disappear at any time". Measured here it
 * never completed a dial: five minutes of silence with no network request at
 * all. Switch back with WXT_ANON_RPC_SPECIFIER plus WXT_ANON_RPC_GATEWAYS.
 *
 * Do NOT substitute the passthrough worker
 * (0x4fd77be300f31c5fe6ab266d35d27750a3478d27): it is kind "reference" and
 * fulfils calls with an ordinary fetch, so requests are not anonymised at all.
 * It demonstrates the sandbox, not privacy, and using it would quietly void
 * the entire claim this extension makes.
 *
 * nym's bundle is ~18 MB, so first boot is slower than a warm one; after that
 * the tunnel is reused for the life of the worker.
 */
/**
 * Nym's IWorkerSpecifier. It runs a mixnet client and takes no gateway.
 * A `gateways` config is what tor-js wants; handing that same object to Nym
 * makes the tunnel sit silent until the read times out.
 */
export const NYM_SPECIFIER: Address = '0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0';

export const ANON_RPC_SPECIFIER = (env('WXT_ANON_RPC_SPECIFIER') ?? NYM_SPECIFIER) as Address;

/**
 * The block a Truly Railgun wallet starts DECRYPTING from.
 *
 * Measured: the Arbitrum Railgun tree holds 134,028 commitments since the
 * contract's deployment (block 56,109,834). The engine tries to decrypt every
 * commitment after the wallet's creation block with the viewing key, so a
 * wallet created at deployment does 134k decryption attempts on its first
 * read -- that is the long "reading shielded balance" wait.
 *
 * Truly's Railgun wallet is derived from the vault seed, and nothing can have
 * been shielded to it before the vault existed. 521,000,000 is 3 Nov 2026,
 * 19:20 UTC, before any Truly vault. Lower it ONLY for a seed that held Railgun
 * funds earlier: notes before this block are invisible to the wallet.
 *
 * This does not shorten the merkle-tree sync itself; the whole tree is still
 * needed to build proofs. It removes the per-commitment decryption.
 */
export const RAILGUN_SCAN_FROM_BLOCK = Number(env('WXT_RAILGUN_SCAN_FROM_BLOCK') ?? 521_000_000);

/**
 * KPS gateways the tor-js worker relays through, as "<ip>:<port>:<certhash>".
 *
 * REQUIRED — tor-js has no default and refuses to start without one:
 *   "tor-js worker: no gateway configured. ... There is no default gateway."
 *
 * Browsers cannot open the raw TCP that Tor needs, so a gateway acts as a
 * blind KPS relay into the Tor network. Blind is the operative word: it
 * carries the traffic but cannot read it, which is why trusting the operator
 * is not the same as trusting an RPC provider with your address.
 *
 * The default below is the DEMONSTRATION gateway published in anon-rpc's
 * adopters.json5, which states: "limited capacity, and it may disappear at
 * any time — run your own for anything real." Treat its availability as a
 * demo-day risk, not a guarantee. Privacy Pools' own app takes the same
 * approach and lets the user pick the gateway.
 *
 * Comma-separated for several.
 */
export const ANON_RPC_GATEWAYS: string[] = (
  env('WXT_ANON_RPC_GATEWAYS') ??
  '152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ'
)
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

/**
 * How long to wait for one anonymised read, in ms.
 *
 * Bounded on purpose. If a KPS gateway is unreachable the WebRTC dial does
 * not fail — it simply never answers, and the whole extension waits forever
 * on a spinner. Observed directly: with no gateway the worker errors in under
 * two seconds; with an unreachable one it sat silent for five minutes and
 * made no network request at all.
 *
 * Generous enough for a real Tor bootstrap, which adopters.json5 warns about,
 * but finite so the failure is reportable.
 */
export const ANON_RPC_TIMEOUT_MS = Number(env('WXT_ANON_RPC_TIMEOUT_MS') ?? 120_000);

/**
 * Destination the anon-client proxies reads to.
 *
 * NOT arb1.arbitrum.io, and the reason is load-bearing: the anon-rpc hop does
 * not preserve the request's `content-type`, and arb1 rejects a POST without
 * it — "invalid content type, only application/json is supported". Verified
 * independently with curl: omit the header and arb1 returns that same error,
 * so this is the transport dropping it rather than anything we send.
 *
 * The endpoint therefore has to satisfy TWO constraints at once, and almost
 * none do:
 *
 *   1. accept a POST with no content-type  (arb1 and 1rpc reject it)
 *   2. serve wide eth_getLogs for discovery (publicnode, drpc, nodies,
 *      meowrpc all refuse logs on their public tier)
 *
 * Measured across nine public Arbitrum endpoints, tenderly's public gateway
 * was the only one that did both: it answers without a content-type and
 * serves 10,000,000-block log windows, which is a full note scan in 12 calls.
 *
 * Change this and check BOTH properties — `pnpm check:logrange` covers the
 * second, and the first is one curl without a content-type header.
 */
export const ARBITRUM_RPC_URL =
  env('WXT_ARBITRUM_RPC_URL') ?? 'https://arbitrum.gateway.tenderly.co';

/**
 * Widest eth_getLogs range to request, in blocks.
 *
 * A PROPERTY OF THE PROVIDER, not of Arbitrum — which is why it lives beside
 * ARBITRUM_RPC_URL rather than with the pool constants. arb1.arbitrum.io/rpc
 * serves 10,000,000-block ranges (measured by scripts/log-range-check.ts);
 * many providers cap far lower. Changing the RPC without changing this gives
 * "only N are allowed for this request" errors from every discovery scan.
 *
 * The SDK's default is 10,000, which turns a full scan from the pool's
 * deployment block into ~11,000 sequential calls. At this size it is ~12.
 */
export const LOG_CHUNK_SIZE = Number(env('WXT_LOG_CHUNK_SIZE') ?? 10_000_000);

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
 * 0xbow's ASP API. Serves Arbitrum too, despite the bare hostname.
 *
 * Every route needs an `X-Pool-Scope` header. This is a PLAIN fetch from the
 * user's IP — anon-rpc is a JSON-RPC proxy and cannot carry it — so the tree
 * is cached and refetched only when the on-chain root moves, rather than
 * pulled before each withdrawal. See docs/e3-validation.md.
 */
export const ASP_API_BASE = env('WXT_ASP_API_BASE') ?? 'https://api.0xbow.io';

/**
 * Block the Arbitrum USDC pool was deployed at. Discovery and the state-tree
 * scan both start here.
 */
export const POOL_DEPLOYMENT_BLOCK = 411197154n;

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

/**
 * How much to pull from the pool for one trade, in USDC units.
 *
 * Sized well above every floor rather than at them. The relayer's effective
 * rate is fixed-cost dominated — 68 BPS at 5 USDC, 21 at 25 — so trading near
 * the minimum pays a punitive rate, and any shortfall strands the remainder.
 */
export const DEFAULT_TRADE_SIZE_UNITS = BigInt(
  env('WXT_TRADE_SIZE_UNITS') ?? 25_000_000,
);

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
