/**
 * Runs the SDK's AccountService against the real Arbitrum USDC pool.
 *
 * Checks the machinery end to end — event fetching from the deployment block,
 * index scanning, precommitment matching — without needing a funded seed. A
 * seed with no deposits MUST find nothing; finding something would mean the
 * matcher is wrong in a way that would also mis-assign real notes.
 *
 * Network-bound, so it is not part of `pnpm check`.
 */

import {
  AccountService,
  DataService,
  generateMasterKeys,
  generateDepositSecrets,
  hashPrecommitment,
  type Hash,
} from '@0xbow/privacy-pools-core-sdk';

const POOL = '0x3706e38af05bf0158BCdbB46239f8289980b093f';
const ENTRYPOINT = '0x44192215FEd782896BE2CE24E0Bfbf0BF825d15E';
const CHAIN_ID = 42161;
const DEPLOYMENT_BLOCK = 411197154n;
const SCOPE = 19314316433070648921215665277427138450050666275686107272761703472573535400848n;
const RPC = process.env.WXT_ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

const PHRASE = 'test test test test test test test test test test test junk';

try {
  // Derivation is local; prove it lines up with what the scan looks for
  // before blaming the network for finding nothing.
  const keys = generateMasterKeys(PHRASE);
  const { nullifier, secret } = generateDepositSecrets(keys, SCOPE as unknown as Hash, 0n);
  const precommitment = hashPrecommitment(nullifier, secret);
  pass(`derived index 0 precommitment for the REAL scope: ${String(precommitment).slice(0, 20)}…`);

  const dataService = new DataService([
    {
      chainId: CHAIN_ID,
      privacyPoolAddress: POOL as `0x${string}`,
      entryPointAddress: ENTRYPOINT as `0x${string}`,
      startBlock: DEPLOYMENT_BLOCK,
      rpcUrl: RPC,
      apiKey: '',
    } as never,
  ]);
  pass('DataService constructed for Arbitrum');

  const account = new AccountService(dataService, { mnemonic: PHRASE });
  pass('AccountService constructed from a mnemonic');

  // Report the scan's actual cost before attempting it. The SDK chunks
  // eth_getLogs at 10k blocks by default, and Arbitrum has ~110M blocks since
  // this pool was deployed — so a full scan is over 11,000 sequential RPC
  // round trips. That is the real constraint on note discovery, not the
  // matching logic.
  const { createPublicClient, http } = await import('viem');
  const { arbitrum } = await import('viem/chains');
  const head = await createPublicClient({
    chain: arbitrum,
    transport: http(RPC),
  }).getBlockNumber();
  const chunks = Number((head - DEPLOYMENT_BLOCK) / 10_000n) + 1;
  console.log(`  head block ${head}; ${head - DEPLOYMENT_BLOCK} blocks since deployment`);
  console.log(`  => ${chunks} eth_getLogs calls at the SDK's default 10k chunk size`);
  if (chunks > 1000) {
    console.log(
      '  NOTE: that is impractical over a public RPC and far worse over anon-rpc.',
    );
    console.log(
      '  The official frontend proxies these reads through Hypersync for exactly this reason.',
    );
  }

  const started = Date.now();
  await account.retrieveHistory([
    {
      chainId: CHAIN_ID,
      address: POOL as `0x${string}`,
      scope: SCOPE as unknown as Hash,
      deploymentBlock: DEPLOYMENT_BLOCK,
    } as never,
  ]);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  pass(`retrieveHistory completed against the live pool in ${elapsed}s`);

  const spendable = account.getSpendableCommitments();
  const total = [...spendable.values()].reduce((n, list) => n + list.length, 0);

  // The decisive assertion: an unfunded seed must find NOTHING. A false match
  // here would mean the matcher could also mis-assign a real user's notes.
  if (total !== 0) {
    fail(`an unfunded seed matched ${total} commitments — the matcher is wrong`);
  } else {
    pass('an unfunded seed finds no notes, as it must');
  }

  console.log(`  scopes tracked: ${spendable.size}`);
} catch (error) {
  fail(error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error));
  console.error(
    '  NOTE: a public RPC often refuses wide eth_getLogs ranges. Set WXT_ARBITRUM_RPC_URL to a provider that allows them before concluding the SDK is at fault.',
  );
} finally {
  process.exit(failed ? 1 : 0);
}
