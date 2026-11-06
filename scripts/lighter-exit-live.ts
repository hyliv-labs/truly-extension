/**
 * Move everything on owner #0's Lighter account back into Railgun.
 *
 *   1. Fast-withdraw the whole Lighter balance (less Lighter's fee) to owner #0
 *      on Arbitrum, signed with the trading key the round-trip script registered.
 *   2. Shield ALL the USDC that arrives into the Railgun wallet of the same
 *      phrase, paying gas in ETH from owner #0. Not the paymaster route: that
 *      one keeps a 1 USDC gas reserve behind at the owner.
 *
 * Dry run by default: prints the plan and sends nothing. `--send` executes.
 * Resumable: the signed withdrawal and the shield hash are saved, so a rerun
 * continues the same transactions and never signs a second withdrawal.
 * Prints addresses, amounts and hashes only, never a key or the phrase.
 *
 * Run: pnpm exec tsx scripts/lighter-exit-live.ts [--send]
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';

const ROOT = '/home/jiojohny/Desktop/ethglobal/truly-extension';
const ROUNDTRIP_STATE = '/tmp/truly-railgun/roundtrip.json';
const EXIT_STATE = '/tmp/truly-railgun/exit.json';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;
const PROXY = '0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9' as Address;
const OWNER_INDEX = 0;
const EXPECTED_OWNER = '0xc433867B3Ed1B352eDE2cae13dC8b1bbA7a50fB5';
const API_KEY_INDEX = 4;
const SEND = process.argv.includes('--send');

type Signed = { txType: number; txInfo: string; txHash: string; messageToSign?: string };
type ExitState = { withdrawTx?: Signed; withdrawUnits?: string; usdcBefore?: string; approveHash?: Hex; shieldHash?: Hex };

const log = (message: string) => console.log(new Date().toISOString().slice(11, 19), message);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const env = Object.fromEntries(
  (await readFile(join(ROOT, '.env.local'), 'utf8'))
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);
const MNEMONIC = env.RAILGUN_MNEMONIC?.trim();
if (!MNEMONIC) throw new Error('RAILGUN_MNEMONIC is not set in .env.local');

const client = createPublicClient({ chain: arbitrum, transport: http('https://arbitrum.gateway.tenderly.co', { retryCount: 5 }) });
const sender = createPublicClient({ chain: arbitrum, transport: http('https://arb1.arbitrum.io/rpc', { retryCount: 3 }) });

const { deriveOwner } = await import('../src/lib/keys.ts');
const lighter = await import('../src/lib/lighter.ts');
const trading = await import('../src/lib/lighter-trading.ts');
const signerMod = await import('../src/lib/lighter-signer.ts');
const { fastWithdrawAmount } = await import('../src/lib/exit.ts');

const ownerKey = await deriveOwner(MNEMONIC, OWNER_INDEX);
const owner = privateKeyToAccount(ownerKey.privateKey);
if (owner.address !== EXPECTED_OWNER) throw new Error(`Owner #0 is ${owner.address}, not ${EXPECTED_OWNER}. Stopped.`);

async function loadExit(): Promise<ExitState> {
  try {
    return JSON.parse(await readFile(EXIT_STATE, 'utf8')) as ExitState;
  } catch {
    return {};
  }
}
async function saveExit(state: ExitState): Promise<void> {
  await mkdir('/tmp/truly-railgun', { recursive: true });
  await writeFile(EXIT_STATE, JSON.stringify(state, null, 2));
  await chmod(EXIT_STATE, 0o600);
}
const usdcOf = (address: Address) => client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] });

async function sendRaw(raw: Hex): Promise<Hex> {
  const hash = keccak256(raw);
  await sender.sendRawTransaction({ serializedTransaction: raw }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already known|nonce too low/i.test(message)) throw error;
  });
  return hash;
}

async function feeCaps(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const block = await client.getBlock();
  return { maxFeePerGas: (block.baseFeePerGas ?? 10_000_000n) * 2n, maxPriorityFeePerGas: 0n };
}

// --- 1. Lighter -------------------------------------------------------------
const accountIndex = await lighter.getAccountIndex(owner.address);
if (accountIndex === null) throw new Error('Owner #0 has no Lighter account.');
const saved = JSON.parse(await readFile(ROUNDTRIP_STATE, 'utf8')) as { apiKey?: { privateKey: string; publicKey: string } };
if (!saved.apiKey) throw new Error('No saved trading key.');
if (!(await trading.isApiKeyRegistered(accountIndex, API_KEY_INDEX, saved.apiKey.publicKey))) {
  throw new Error('The saved trading key is no longer the one at index 4 (was it replaced?). Nothing was signed.');
}
await signerMod.loadSigner(async () => {
  const bytes = await readFile(join(ROOT, 'public/lighter/lighter-signer.wasm'));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
});
const account = { privateKey: saved.apiKey.privateKey, apiKeyIndex: API_KEY_INDEX, accountIndex };

const state = await loadExit();
const live = await trading.readTradingAccount(accountIndex);
log(`owner #0 ${owner.address} · Lighter account #${accountIndex} · collateral ${live.collateralRaw} USDC · open positions ${live.positions.length}`);

if (!state.withdrawTx) {
  if (live.positions.length > 0) throw new Error('A position is open. Close it on Lighter first. Nothing was signed.');
  const auth = await signerMod.createAuthToken(account);
  const pool = await trading.fastWithdrawPool(accountIndex, auth);
  const fee = await trading.transferFeeUnits(accountIndex, pool.toAccountIndex, auth);
  const units = fastWithdrawAmount(live.collateralRaw, fee);
  if (units === null) throw new Error(`Collateral ${live.collateralRaw} cannot cover a fast withdrawal (fee ${formatUnits(fee, 6)}). Nothing was signed.`);
  log(`plan: fast-withdraw ${formatUnits(units, 6)} USDC to owner #0 on Arbitrum; Lighter keeps ${formatUnits(fee, 6)} as its fee`);
  if (!SEND) {
    log('dry run: nothing signed or sent. Run again with --send.');
    process.exit(0);
  }
  const nonce = await trading.nextNonce(accountIndex, API_KEY_INDEX);
  const unsigned = await signerMod.signFastWithdraw(account, {
    toAccountIndex: pool.toAccountIndex,
    amountUnits: units,
    feeUnits: fee,
    toAddress: owner.address,
    nonce,
  });
  const l1 = await owner.signMessage({ message: unsigned.messageToSign });
  state.withdrawTx = signerMod.withL1Signature(unsigned, l1);
  state.withdrawUnits = units.toString();
  state.usdcBefore = (await usdcOf(owner.address)).toString();
  await saveExit(state);
  log('withdrawal signed and saved');
}
if (!SEND) {
  log('dry run: a signed withdrawal is already saved; --send continues it.');
  process.exit(0);
}

if (!state.shieldHash) {
  const seen = await trading.lookupTx(state.withdrawTx.txHash);
  if (!seen.found) {
    const auth = await signerMod.createAuthToken(account);
    const outcome = await trading.sendFastWithdraw(state.withdrawTx, owner.address, auth);
    log(`withdrawal sent: ${outcome.kind}${'message' in outcome && outcome.message ? ` (${outcome.message})` : ''}`);
    if (outcome.kind === 'rejected') throw new Error('Lighter refused the withdrawal. Nothing left Lighter.');
  } else {
    log('withdrawal already on Lighter');
  }
  const before = BigInt(state.usdcBefore ?? '0');
  const want = BigInt(state.withdrawUnits ?? '0');
  const started = Date.now();
  for (;;) {
    const now = await usdcOf(owner.address);
    if (now - before >= want) {
      log(`USDC arrived at owner #0: ${formatUnits(now, 6)}`);
      break;
    }
    if (Date.now() - started > 20 * 60_000) throw new Error('The withdrawal has not reached owner #0 after 20 minutes. Rerun to keep waiting.');
    log(`waiting for the withdrawal to land on Arbitrum (owner holds ${formatUnits(now, 6)} USDC)`);
    await sleep(15_000);
  }
}

// --- 2. Shield everything ------------------------------------------------------
if (state.shieldHash) {
  log(`shield already sent ${state.shieldHash}`);
  process.exit(0);
}
const balance = await usdcOf(owner.address);
if (balance === 0n) throw new Error('Owner #0 holds no USDC to shield.');

const require = createRequire(join(ROOT, 'package.json'));
const railgun = require('@railgun-community/wallet');
const models = require('@railgun-community/shared-models');
const LevelDOWN = require('leveldown');
const network = models.NetworkName.Arbitrum;
const txid = models.TXIDVersion.V2_PoseidonMerkle;

// A throwaway engine database: a shield needs only the recipient's 0zk
// address, which the phrase alone fixes, so no history sync is needed.
const dbPath = '/tmp/truly-railgun/exit-engine.db';
await rm(dbPath, { recursive: true, force: true });
const noArtifacts = new railgun.ArtifactStore(async () => null, async () => {}, async () => false);
await railgun.startRailgunEngine('truly', new LevelDOWN(dbPath), false, noArtifacts, false, false, [], [], false);
await railgun.loadProvider(
  { chainId: 42161, providers: [{ provider: 'https://arbitrum.gateway.tenderly.co', priority: 1, weight: 2 }] },
  network,
  60_000,
);
railgun.pauseAllPollingProviders();
const walletKey = createHash('sha256').update(`truly-railgun-v1:${MNEMONIC}`).digest('hex');
const head = Number(await client.getBlockNumber());
const wallet = await railgun.createRailgunWallet(walletKey, MNEMONIC, { [network]: head });
const zk = railgun.getRailgunAddress(wallet.id) as string;
log(`shield target: Railgun wallet ${zk.slice(0, 12)}…${zk.slice(-6)} (index 0 of the same phrase as the Truly vault)`);

const gas = await feeCaps();
const eth = await client.getBalance({ address: owner.address });

if (!state.approveHash) {
  const nonce = await client.getTransactionCount({ address: owner.address, blockTag: 'pending' });
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PROXY, balance] });
  const approveGas = await client.estimateGas({ account: owner.address, to: USDC, data });
  const raw = await owner.signTransaction({
    chainId: 42161, nonce, to: USDC, data, value: 0n, gas: (approveGas * 12n) / 10n, ...gas, type: 'eip1559',
  });
  state.approveHash = await sendRaw(raw);
  await saveExit(state);
  const receipt = await client.waitForTransactionReceipt({ hash: state.approveHash });
  if (receipt.status !== 'success') throw new Error('USDC approve reverted. Nothing was shielded.');
  log(`approved ${formatUnits(balance, 6)} USDC for Railgun (${state.approveHash})`);
}

const shieldPrivateKey = keccak256(await owner.signMessage({ message: 'RAILGUN_SHIELD' }));
const recipients = [{ tokenAddress: USDC, amount: balance, recipientAddress: zk }];
const { gasEstimate } = await railgun.gasEstimateForShield(txid, network, shieldPrivateKey, recipients, [], owner.address);
const details = {
  evmGasType: models.getEVMGasTypeForTransaction(network, true),
  gasEstimate: BigInt(gasEstimate),
  maxFeePerGas: gas.maxFeePerGas,
  maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
};
const { transaction } = await railgun.populateShield(txid, network, shieldPrivateKey, recipients, [], details);
const gasLimit = BigInt(transaction.gasLimit ?? gasEstimate);
const cost = gasLimit * gas.maxFeePerGas;
const ethNow = await client.getBalance({ address: owner.address });
log(`shield gas up to ${formatUnits(cost, 18)} ETH; owner holds ${formatUnits(ethNow, 18)} ETH (was ${formatUnits(eth, 18)})`);
if (ethNow < cost) throw new Error('Owner #0 lacks the ETH for the shield gas. The USDC stays at owner #0; send ETH and rerun.');
const raw = await owner.signTransaction({
  chainId: 42161,
  nonce: await client.getTransactionCount({ address: owner.address, blockTag: 'pending' }),
  to: transaction.to as Address,
  data: transaction.data as Hex,
  value: 0n,
  gas: gasLimit,
  ...gas,
  type: 'eip1559',
});
state.shieldHash = await sendRaw(raw);
await saveExit(state);
const receipt = await client.waitForTransactionReceipt({ hash: state.shieldHash });
if (receipt.status !== 'success') throw new Error(`Shield reverted (${state.shieldHash}). The USDC stays at owner #0.`);
log(`shielded ${formatUnits(balance, 6)} USDC into Railgun (${state.shieldHash}). Railgun keeps its 0.25% shield fee.`);
process.exit(0);
