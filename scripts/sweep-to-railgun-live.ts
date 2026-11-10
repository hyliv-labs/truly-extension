/**
 * Sweep test funds from owner addresses back into the vault's Railgun wallet.
 *
 * For each owner index given:
 *   1. Lighter: register a withdrawal key if needed, then fast-withdraw the
 *      whole balance (Lighter keeps its fee) to the owner on Arbitrum.
 *   2. Shield ALL the owner's USDC into Railgun, gas paid in ETH. An owner
 *      short of gas is topped up from the donor owners (unused gas top-ups).
 *
 * Dry run by default; `--send` executes. Every signed step is saved before it
 * is sent (0600 file), so a rerun continues it and never signs a second one.
 * Prints addresses, amounts and hashes only, never a key or the phrase.
 *
 * Run: pnpm exec tsx scripts/sweep-to-railgun-live.ts --owners 2,5,10 --donors 6,7,8,9 [--send]
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';

const ROOT = '/home/jiojohny/Desktop/ethglobal/truly-extension';
const STATE_DIR = '/tmp/truly-railgun';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;
const PROXY = '0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9' as Address;
const API_KEY_INDEX = 4;
const SEND = process.argv.includes('--send');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? '').split(',').filter(Boolean).map(Number) : [];
};
const OWNERS = arg('--owners');
const DONORS = arg('--donors');
if (OWNERS.length === 0) throw new Error('Pass --owners, e.g. --owners 2,5,10');

type Signed = { txType: number; txInfo: string; txHash: string; messageToSign?: string };
type OwnerState = {
  apiKey?: { privateKey: string; publicKey: string };
  keyTx?: Signed;
  withdrawTx?: Signed;
  withdrawUnits?: string;
  usdcBefore?: string;
  approveHash?: Hex;
  shieldHash?: Hex;
};

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

const client = createPublicClient({ chain: arbitrum, transport: http('https://arbitrum.gateway.tenderly.co', { retryCount: 6, retryDelay: 1_500 }) });
const sender = createPublicClient({ chain: arbitrum, transport: http('https://arb1.arbitrum.io/rpc', { retryCount: 3 }) });

const { deriveOwner } = await import('../src/lib/keys.ts');
const lighter = await import('../src/lib/lighter.ts');
const trading = await import('../src/lib/lighter-trading.ts');
const signerMod = await import('../src/lib/lighter-signer.ts');
const { fastWithdrawAmount } = await import('../src/lib/exit.ts');

await signerMod.loadSigner(async () => {
  const bytes = await readFile(join(ROOT, 'public/lighter/lighter-signer.wasm'));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
});

const statePath = (index: number) => join(STATE_DIR, `sweep-owner-${index}.json`);
async function loadState(index: number): Promise<OwnerState> {
  try {
    return JSON.parse(await readFile(statePath(index), 'utf8')) as OwnerState;
  } catch {
    return {};
  }
}
async function saveState(index: number, state: OwnerState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(statePath(index), JSON.stringify(state, null, 2));
  await chmod(statePath(index), 0o600);
}
const usdcOf = (address: Address) => client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] });

async function fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const block = await client.getBlock();
  return { maxFeePerGas: ((block.baseFeePerGas ?? 10_000_000n) * 3n) / 2n, maxPriorityFeePerGas: 0n };
}

async function sendSigned(account: PrivateKeyAccount, tx: { to: Address; data?: Hex; value?: bigint; gas: bigint }): Promise<Hex> {
  const fee = await fees();
  const raw = await account.signTransaction({
    chainId: 42161,
    nonce: await client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gas: tx.gas,
    ...fee,
    type: 'eip1559',
  });
  const hash = keccak256(raw);
  await sender.sendRawTransaction({ serializedTransaction: raw }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already known|nonce too low/i.test(message)) throw error;
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted.`);
  return hash;
}

/** Give `target` at least `need` wei of ETH from the donor owners. */
async function topUp(target: Address, need: bigint): Promise<void> {
  const have = await client.getBalance({ address: target });
  if (have >= need) return;
  let short = need - have + need / 5n;
  for (const index of DONORS) {
    const donor = privateKeyToAccount((await deriveOwner(MNEMONIC!, index)).privateKey);
    const balance = await client.getBalance({ address: donor.address });
    const transferCost = 21_000n * 2n * (await fees()).maxFeePerGas;
    const spare = balance - transferCost * 2n;
    if (spare <= 0n) continue;
    const amount = spare < short ? spare : short;
    log(`  gas top-up ${formatUnits(amount, 18)} ETH from owner #${index}`);
    if (SEND) await sendSigned(donor, { to: target, value: amount, gas: 21_000n * 2n });
    short -= amount;
    if (short <= 0n) return;
  }
  if (short > 0n) throw new Error(`Not enough donor ETH: ${target} is still ${formatUnits(short, 18)} ETH short.`);
}

// --- Railgun recipient: index 0 of the same phrase, no history sync needed --------
const require = createRequire(join(ROOT, 'package.json'));
const railgun = require('@railgun-community/wallet');
const models = require('@railgun-community/shared-models');
const LevelDOWN = require('leveldown');
const network = models.NetworkName.Arbitrum;
const txid = models.TXIDVersion.V2_PoseidonMerkle;
let zkAddress: string | null = null;
async function railgunRecipient(): Promise<string> {
  if (zkAddress) return zkAddress;
  const dbPath = join(STATE_DIR, 'sweep-engine.db');
  await mkdir(STATE_DIR, { recursive: true });
  await rm(dbPath, { recursive: true, force: true });
  const noArtifacts = new railgun.ArtifactStore(async () => null, async () => {}, async () => false);
  await railgun.startRailgunEngine('truly', new LevelDOWN(dbPath), false, noArtifacts, false, false, [], [], false);
  await railgun.loadProvider({ chainId: 42161, providers: [{ provider: 'https://arbitrum.gateway.tenderly.co', priority: 1, weight: 2 }] }, network, 60_000);
  railgun.pauseAllPollingProviders();
  const key = createHash('sha256').update(`truly-railgun-v1:${MNEMONIC}`).digest('hex');
  const wallet = await railgun.createRailgunWallet(key, MNEMONIC, { [network]: Number(await client.getBlockNumber()) });
  zkAddress = railgun.getRailgunAddress(wallet.id) as string;
  log(`Railgun recipient ${zkAddress.slice(0, 12)}…${zkAddress.slice(-6)}`);
  return zkAddress;
}

// --- per owner ---------------------------------------------------------------
for (const index of OWNERS) {
  const owner = privateKeyToAccount((await deriveOwner(MNEMONIC, index)).privateKey);
  const state = await loadState(index);
  log(`owner #${index} ${owner.address}`);

  // 1. Lighter
  const accountIndex = await lighter.getAccountIndex(owner.address);
  const live = accountIndex === null ? null : await trading.readTradingAccount(accountIndex);
  if (live && Number(live.collateralRaw) > 0 && !state.withdrawTx) {
    if (live.positions.length > 0) throw new Error(`owner #${index}: a Lighter position is open. Close it first. Nothing was signed.`);
    log(`  Lighter #${accountIndex} holds ${live.collateralRaw} USDC`);
    if (!SEND) {
      log('  dry run: would register a withdrawal key if needed and fast-withdraw it all to this owner');
    } else {
      if (!state.apiKey) {
        state.apiKey = await signerMod.generateApiKey();
        await saveState(index, state);
      }
      const account = { privateKey: state.apiKey.privateKey, apiKeyIndex: API_KEY_INDEX, accountIndex: accountIndex! };
      if (!(await trading.isApiKeyRegistered(accountIndex!, API_KEY_INDEX, state.apiKey.publicKey))) {
        if (!state.keyTx) {
          const nonce = await trading.nextNonce(accountIndex!, API_KEY_INDEX);
          const unsigned = await signerMod.signChangePubKey(account, state.apiKey.publicKey, nonce);
          const l1 = await owner.signMessage({ message: unsigned.messageToSign });
          state.keyTx = signerMod.withL1Signature(unsigned, l1);
          await saveState(index, state);
        }
        if (!(await trading.lookupTx(state.keyTx.txHash)).found) {
          const outcome = await trading.sendTx(state.keyTx);
          log(`  key registration ${outcome.kind}`);
          if (outcome.kind === 'rejected') throw new Error(`owner #${index}: Lighter refused the key. Nothing was withdrawn.`);
        }
        for (let i = 0; i < 30 && !(await trading.isApiKeyRegistered(accountIndex!, API_KEY_INDEX, state.apiKey.publicKey)); i += 1) await sleep(3_000);
        if (!(await trading.isApiKeyRegistered(accountIndex!, API_KEY_INDEX, state.apiKey.publicKey))) {
          throw new Error(`owner #${index}: the key is not registered yet. Rerun in a minute. Nothing was withdrawn.`);
        }
        log('  withdrawal key registered');
      }
      const auth = await signerMod.createAuthToken(account);
      const pool = await trading.fastWithdrawPool(accountIndex!, auth);
      const fee = await trading.transferFeeUnits(accountIndex!, pool.toAccountIndex, auth);
      const units = fastWithdrawAmount(live.collateralRaw, fee);
      if (units === null) throw new Error(`owner #${index}: ${live.collateralRaw} USDC cannot cover a fast withdrawal (fee ${formatUnits(fee, 6)}).`);
      const nonce = await trading.nextNonce(accountIndex!, API_KEY_INDEX);
      const unsigned = await signerMod.signFastWithdraw(account, { toAccountIndex: pool.toAccountIndex, amountUnits: units, feeUnits: fee, toAddress: owner.address, nonce });
      const l1 = await owner.signMessage({ message: unsigned.messageToSign });
      state.withdrawTx = signerMod.withL1Signature(unsigned, l1);
      state.withdrawUnits = units.toString();
      state.usdcBefore = (await usdcOf(owner.address)).toString();
      await saveState(index, state);
      log(`  withdrawing ${formatUnits(units, 6)} USDC; Lighter keeps ${formatUnits(fee, 6)} as its fee`);
    }
  }
  if (SEND && state.withdrawTx && !state.shieldHash) {
    if (!(await trading.lookupTx(state.withdrawTx.txHash)).found) {
      const account = { privateKey: state.apiKey!.privateKey, apiKeyIndex: API_KEY_INDEX, accountIndex: accountIndex! };
      const outcome = await trading.sendFastWithdraw(state.withdrawTx, owner.address, await signerMod.createAuthToken(account));
      log(`  withdrawal ${outcome.kind}`);
      if (outcome.kind === 'rejected') throw new Error(`owner #${index}: Lighter refused the withdrawal. Nothing left Lighter.`);
    }
    const before = BigInt(state.usdcBefore ?? '0');
    const want = BigInt(state.withdrawUnits ?? '0');
    const started = Date.now();
    while ((await usdcOf(owner.address)) - before < want) {
      if (Date.now() - started > 20 * 60_000) throw new Error(`owner #${index}: the withdrawal has not landed after 20 minutes. Rerun to keep waiting.`);
      await sleep(15_000);
    }
    log('  withdrawal arrived on Arbitrum');
  }

  // 2. Shield everything
  if (state.shieldHash) {
    log(`  already shielded ${state.shieldHash}`);
    continue;
  }
  const balance = await usdcOf(owner.address);
  if (balance === 0n) {
    log('  no USDC to shield');
    continue;
  }
  const recipient = await railgunRecipient();
  const fee = await fees();
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PROXY, balance] });
  const allowance = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [owner.address, PROXY] });
  const approveGas = allowance >= balance ? 0n : 120_000n;
  const shieldGasGuess = 900_000n;
  log(`  shield ${formatUnits(balance, 6)} USDC; gas budget ${formatUnits((approveGas + shieldGasGuess) * fee.maxFeePerGas, 18)} ETH, owner holds ${formatUnits(await client.getBalance({ address: owner.address }), 18)} ETH`);
  await topUp(owner.address, (approveGas + shieldGasGuess) * fee.maxFeePerGas);
  if (!SEND) {
    log('  dry run: would approve and shield it all');
    continue;
  }
  if (approveGas > 0n) {
    state.approveHash = await sendSigned(owner, { to: USDC, data: approveData, gas: approveGas });
    await saveState(index, state);
    log(`  approved (${state.approveHash})`);
  }
  const shieldPrivateKey = keccak256(await owner.signMessage({ message: 'RAILGUN_SHIELD' }));
  const recipients = [{ tokenAddress: USDC, amount: balance, recipientAddress: recipient }];
  const { gasEstimate } = await railgun.gasEstimateForShield(txid, network, shieldPrivateKey, recipients, [], owner.address);
  const details = { evmGasType: models.getEVMGasTypeForTransaction(network, true), gasEstimate: BigInt(gasEstimate), ...fee };
  const { transaction } = await railgun.populateShield(txid, network, shieldPrivateKey, recipients, [], details);
  const gasLimit = (BigInt(transaction.gasLimit ?? gasEstimate) * 12n) / 10n;
  await topUp(owner.address, gasLimit * fee.maxFeePerGas);
  state.shieldHash = await sendSigned(owner, { to: transaction.to as Address, data: transaction.data as Hex, gas: gasLimit });
  await saveState(index, state);
  log(`  shielded ${formatUnits(balance, 6)} USDC into Railgun (${state.shieldHash})`);
}
log(SEND ? 'sweep finished' : 'dry run finished: nothing was signed or sent');
process.exit(0);
