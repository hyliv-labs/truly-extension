/**
 * Live Railgun → Lighter → Railgun round trip on Arbitrum mainnet.
 * Resumable. Prints addresses and tx hashes only, never a key or a mnemonic.
 *
 * Run: pnpm exec tsx scripts/railgun-roundtrip-live.ts
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  formatUnits,
  http,
  keccak256,
  maxUint256,
  parseErc6492Signature,
  parseTransaction,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createBundlerClient, toSimple7702SmartAccount } from 'viem/account-abstraction';
import { arbitrum } from 'viem/chains';

const ROOT = '/home/jiojohny/Desktop/ethglobal/truly-extension';
const STATE_PATH = '/tmp/truly-railgun/roundtrip.json';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;
const PROXY = '0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9' as Address;
const PAYMASTER = '0x0578cFB241215b77442a541325d6A4E6dFE700Ec' as Address;
const PERMIT = 1_000_000n;
const NET = 10_000_000n;
const OWNER_INDEX = 0;
const ETH_FOR_UNSHIELD = 100_000_000_000_000n; // 0.0001 ETH
const API_KEY_INDEX = 4;
const MARKET_ID = 0;
const LEVERAGE = 2;
const MARGIN_USD = 8;

type Signed = { txType: number; txInfo: string; txHash: string; messageToSign?: string };
type State = {
  ownerIndex: number;
  ownerAddress: Address;
  intent?: Address;
  ethTx?: Hex;
  unshieldRaw?: Hex;
  unshieldHash?: Hex;
  accountIndex?: number;
  apiKey?: { privateKey: string; publicKey: string };
  opened?: boolean;
  openTx?: Signed;
  closed?: boolean;
  closeTx?: Signed;
  withdrawTx?: Signed;
  /** Set only for a fast withdrawal. A secure withdrawal has no destination here. */
  withdrawTo?: Address;
  shieldHash?: string;
};

const env = Object.fromEntries(
  (await readFile(join(ROOT, '.env.local'), 'utf8'))
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
for (const [key, value] of Object.entries(env)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

/** A missing value here must stop the run, not derive keys from "undefined". */
function required(key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is not set in .env.local`);
  return value;
}
const RAILGUN_MNEMONIC = required('RAILGUN_MNEMONIC');

const funderKey = (env.PRIVATE_KEY?.trim().startsWith('0x') ? env.PRIVATE_KEY.trim() : `0x${env.PRIVATE_KEY?.trim()}`) as Hex;
const funder = privateKeyToAccount(funderKey);
const readRpc = env.WXT_ARBITRUM_RPC_URL || 'https://arbitrum.gateway.tenderly.co';
const sendRpc = 'https://arbitrum-one-rpc.publicnode.com';
const bundlerUrl = env.WXT_BUNDLER_URL || 'https://public.pimlico.io/v2/42161/rpc';
const client = createPublicClient({
  chain: arbitrum,
  transport: http(readRpc, { retryCount: 5, retryDelay: 1_000 }),
});
const sender = createPublicClient({ chain: arbitrum, transport: http(sendRpc, { retryCount: 3, retryDelay: 800 }) });
const wallet = createWalletClient({ account: funder, chain: arbitrum, transport: http(sendRpc) });

const { deriveOwner } = await import('../src/lib/keys.ts');
const lighter = await import('../src/lib/lighter.ts');
const markets = await import('../src/lib/lighter-markets.ts');
const trading = await import('../src/lib/lighter-trading.ts');
const signerMod = await import('../src/lib/lighter-signer.ts');
const plan = await import('../src/lib/trade-plan.ts');
const { railgunGrossForNet, railgunShieldAfterGasReserve } = await import('../src/lib/railgun.ts');
const { fastWithdrawAmount } = await import('../src/lib/exit.ts');

const require = createRequire(join(ROOT, 'package.json'));
const LevelDOWN = require('leveldown');
const railgun = require('@railgun-community/wallet');
const models = require('@railgun-community/shared-models');
const engine = require('@railgun-community/engine');

const SPEND = ['Spendable', 'ShieldPending', 'MissingExternalPOI', 'MissingInternalPOI', 'ProofSubmitted'];
engine.POI.getSpendableBalanceBuckets = async () => SPEND;
const Engine = engine.RailgunEngine;
if (Engine?.prototype?.scanTXIDHistoryV2) {
  Engine.prototype.scanTXIDHistoryV2 = async () => undefined;
}

const ownerKey = await deriveOwner(RAILGUN_MNEMONIC, OWNER_INDEX);
const ownerAccount = privateKeyToAccount(ownerKey.privateKey);

function log(message: string): void {
  console.log(new Date().toISOString().slice(11, 19), message);
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8')) as State;
  } catch {
    return { ownerIndex: OWNER_INDEX, ownerAddress: ownerAccount.address };
  }
}

async function saveState(state: State): Promise<void> {
  await mkdir('/tmp/truly-railgun', { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  await chmod(STATE_PATH, 0o600);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let engineUp = false;
async function bootEngine(): Promise<{ id: string; key: string }> {
  if (engineUp) {
    return {
      id: required('RAILGUN_WALLET_ID'),
      key: createHash('sha256').update(`truly-railgun-v1:${RAILGUN_MNEMONIC}`).digest('hex'),
    };
  }
  const artifactRoot = '/tmp/truly-railgun/artifacts';
  await mkdir(artifactRoot, { recursive: true });
  const artifactStore = new railgun.ArtifactStore(
    (path: string) => readFile(join(artifactRoot, path)),
    async (dir: string, path: string, item: Uint8Array) => {
      await mkdir(join(artifactRoot, dir), { recursive: true });
      await writeFile(join(artifactRoot, path), item);
    },
    (path: string) =>
      readFile(join(artifactRoot, path)).then(
        () => true,
        () => false,
      ),
  );
  const key = createHash('sha256').update(`truly-railgun-v1:${RAILGUN_MNEMONIC}`).digest('hex');
  const db = new LevelDOWN('/tmp/truly-railgun/engine.db');
  await railgun.startRailgunEngine('truly', db, false, artifactStore, false, false, [], [], false);
  const snarkjs = createRequire(require.resolve('@railgun-community/wallet'))('snarkjs');
  railgun.getEngine().prover.setSnarkJSGroth16(snarkjs.groth16);
  await railgun.loadProvider(
    { chainId: 42161, providers: [{ provider: readRpc, priority: 1, weight: 2, maxLogsPerBatch: 400 }] },
    models.NetworkName.Arbitrum,
    30_000,
  );
  const walletInfo = await railgun.loadWalletByID(key, required('RAILGUN_WALLET_ID'), false);
  const chain = models.NETWORK_CONFIG[models.NetworkName.Arbitrum].chain;
  railgun.pausePPOIBatchingForChain(chain);
  let last = 0;
  railgun.setOnUTXOMerkletreeScanCallback((event: { progress?: number }) => {
    if (typeof event?.progress !== 'number' || event.progress < last + 0.2) return;
    last = event.progress;
    log(`scan ${event.progress.toFixed(2)}`);
  });
  await railgun.refreshBalances(chain, [walletInfo.id]);
  await Promise.race([
    railgun.awaitWalletScan(walletInfo.id, chain),
    new Promise((resolve) => setTimeout(resolve, 30_000)),
  ]);
  engineUp = true;
  return { id: walletInfo.id, key };
}

async function feeCaps(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const [tip, price, block] = await Promise.all([
    client.request({ method: 'eth_maxPriorityFeePerGas' }),
    client.request({ method: 'eth_gasPrice' }),
    client.getBlock(),
  ]);
  const base = (block.baseFeePerGas ?? 0n) * 2n;
  const quoted = BigInt(price);
  const maxFeePerGas = quoted > base ? quoted : base;
  const maxPriorityFeePerGas = BigInt(tip);
  return {
    maxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas,
  };
}

/** The SDK prices from eth_gasPrice, which can sit under the next base fee. */
async function reprice(raw: Hex): Promise<Hex> {
  const tx = parseTransaction(raw);
  const block = await client.getBlock();
  const floor = (block.baseFeePerGas ?? 0n) * 2n;
  const current = tx.maxFeePerGas ?? 0n;
  if (current >= floor || !tx.to || !tx.data || tx.gas === undefined || tx.nonce === undefined) return raw;
  return ownerAccount.signTransaction({
    chainId: 42161,
    nonce: tx.nonce,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gas: tx.gas,
    maxFeePerGas: floor,
    maxPriorityFeePerGas: 0n,
    type: 'eip1559',
  });
}

function gasDetails(gasEstimate: bigint, gas: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
  return {
    evmGasType: models.getEVMGasTypeForTransaction(models.NetworkName.Arbitrum, true),
    gasEstimate,
    maxFeePerGas: gas.maxFeePerGas,
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
  };
}

async function sendRaw(raw: Hex): Promise<void> {
  await sender.sendRawTransaction({ serializedTransaction: raw }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/already known|nonce too low|replacement transaction underpriced/i.test(message)) return;
    throw error;
  });
}

async function ensureEth(state: State): Promise<void> {
  const balance = await client.getBalance({ address: ownerAccount.address });
  if (balance >= ETH_FOR_UNSHIELD) {
    log(`owner eth ${formatUnits(balance, 18)}`);
    return;
  }
  if (state.ethTx) {
    const receipt = await client.getTransactionReceipt({ hash: state.ethTx }).catch(() => null);
    if (receipt?.status === 'success') return;
  }
  log(`sending 0.0001 ETH to owner ${ownerAccount.address}`);
  const hash = await wallet.sendTransaction({
    to: ownerAccount.address,
    value: ETH_FOR_UNSHIELD,
  });
  state.ethTx = hash;
  await saveState(state);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('ETH transfer to the owner reverted.');
  log(`eth tx ${hash}`);
}

async function unshield(state: State): Promise<void> {
  if (!state.intent) {
    state.intent = await lighter.createIntentAddress(ownerAccount.address);
    await saveState(state);
    log(`intent ${state.intent}`);
  }
  await ensureEth(state);
  if (state.unshieldHash) {
    const receipt = await client.getTransactionReceipt({ hash: state.unshieldHash }).catch(() => null);
    if (receipt?.status === 'success') {
      log(`unshield already confirmed ${state.unshieldHash}`);
      return;
    }
    if (state.unshieldRaw && !receipt) {
      const raw = await reprice(state.unshieldRaw);
      const hash = keccak256(raw);
      state.unshieldRaw = raw;
      state.unshieldHash = hash;
      await saveState(state);
      log(`resending unshield ${hash}`);
      await sendRaw(raw);
      const waited = await client.waitForTransactionReceipt({ hash });
      if (waited.status !== 'success') throw new Error('Resent unshield reverted.');
      return;
    }
    if (receipt?.status === 'reverted') {
      log(`unshield ${state.unshieldHash} reverted; building a new proof`);
      state.unshieldRaw = undefined;
      state.unshieldHash = undefined;
      await saveState(state);
    }
  }

  const { id, key } = await bootEngine();
  const txid = models.TXIDVersion.V2_PoseidonMerkle;
  const network = models.NetworkName.Arbitrum;
  const walletHandle = railgun.walletForID(id);
  const spendable = await railgun.balanceForERC20Token(txid, walletHandle, network, USDC, true);
  const gross = railgunGrossForNet(NET, 25n);
  log(`spendable ${formatUnits(spendable, 6)} unshield gross ${formatUnits(gross, 6)}`);
  if (spendable < gross) throw new Error('Shielded balance cannot cover a 10 USDC unshield.');

  const recipients = [{ tokenAddress: USDC, amount: gross, recipientAddress: state.intent }];
  const gas = await feeCaps();
  const { gasEstimate } = await railgun.gasEstimateForUnprovenUnshield(
    txid,
    network,
    id,
    key,
    recipients,
    [],
    gasDetails(0n, gas),
    undefined,
    true,
  );
  const details = gasDetails(BigInt(gasEstimate), gas);
  const minPrice = models.calculateGasPrice(details);
  const cost = BigInt(gasEstimate) * gas.maxFeePerGas;
  const ownerEth = await client.getBalance({ address: ownerAccount.address });
  log(`unshield gas ${gasEstimate} cost ${formatUnits(cost, 18)} owner eth ${formatUnits(ownerEth, 18)}`);
  if (ownerEth < cost) throw new Error('Owner ETH does not cover the unshield.');

  log('building unshield proof');
  await railgun.generateUnshieldProof(txid, network, id, key, recipients, [], undefined, true, minPrice, (progress: number) => {
    if (progress === 0 || progress === 1 || progress > 0.5) log(`proof ${progress}`);
  });
  const { transaction } = await railgun.populateProvedUnshield(
    txid,
    network,
    id,
    recipients,
    [],
    undefined,
    true,
    minPrice,
    details,
  );
  const nonce = await client.getTransactionCount({ address: ownerAccount.address, blockTag: 'pending' });
  const raw = await ownerAccount.signTransaction({
    chainId: 42161,
    nonce,
    to: transaction.to as Address,
    data: transaction.data as Hex,
    value: BigInt(transaction.value ?? 0),
    gas: BigInt(transaction.gasLimit),
    maxFeePerGas: BigInt(transaction.maxFeePerGas ?? gas.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas ?? gas.maxPriorityFeePerGas),
    type: 'eip1559',
  });
  const priced = await reprice(raw);
  const hash = keccak256(priced);
  state.unshieldRaw = priced;
  state.unshieldHash = hash;
  await saveState(state);
  await sendRaw(priced);
  log(`unshield sent ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Unshield reverted.');
  log(`unshield confirmed block ${receipt.blockNumber}`);
}

async function waitForCredit(state: State): Promise<number> {
  if (state.accountIndex !== undefined) {
    const account = await trading.readTradingAccount(state.accountIndex);
    if (account.collateral > 0) {
      log(`lighter account ${state.accountIndex} collateral ${account.collateralRaw}`);
      return state.accountIndex;
    }
  }
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 40 * 60_000) {
    const index = await lighter.getAccountIndex(ownerAccount.address);
    const status = await lighter.getDepositStatus(ownerAccount.address).catch(() => null);
    const line = `deposit ${status?.status ?? 'none'} ${status?.description ?? ''} account ${index ?? 'none'}`;
    if (line !== last) {
      log(line);
      last = line;
    }
    if (index !== null) {
      const account = await trading.readTradingAccount(index);
      if (account.collateral > 0) {
        state.accountIndex = index;
        await saveState(state);
        log(`credited ${account.collateralRaw} USDC on account ${index}`);
        return index;
      }
    }
    await sleep(20_000);
  }
  throw new Error('Lighter had not credited the deposit after 40 minutes.');
}

async function submit(tx: Signed, label: string): Promise<void> {
  const outcome = await trading.sendTx(tx);
  log(`${label} ${outcome.kind}${outcome.kind === 'accepted' ? '' : 'message' in outcome ? ` ${outcome.message}` : ''}`);
  if (outcome.kind === 'rejected') throw new Error(`${label} refused: ${outcome.message}`);
}

async function trade(state: State, accountIndex: number): Promise<void> {
  await signerMod.loadSigner(async () => {
    const bytes = await readFile(join(ROOT, 'public/lighter/lighter-signer.wasm'));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  });
  if (!state.apiKey) {
    state.apiKey = await signerMod.generateApiKey();
    await saveState(state);
    log('trading key generated');
  }
  const account = {
    privateKey: state.apiKey.privateKey,
    apiKeyIndex: API_KEY_INDEX,
    accountIndex,
  };
  if (!(await trading.isApiKeyRegistered(accountIndex, API_KEY_INDEX, state.apiKey.publicKey))) {
    const nonce = await trading.nextNonce(accountIndex, API_KEY_INDEX);
    const unsigned = await signerMod.signChangePubKey(account, state.apiKey.publicKey, nonce);
    const l1 = await ownerAccount.signMessage({ message: unsigned.messageToSign });
    await submit(signerMod.withL1Signature(unsigned, l1), 'change pubkey');
    for (let i = 0; i < 20; i += 1) {
      if (await trading.isApiKeyRegistered(accountIndex, API_KEY_INDEX, state.apiKey.publicKey)) break;
      await sleep(3_000);
    }
    if (!(await trading.isApiKeyRegistered(accountIndex, API_KEY_INDEX, state.apiKey.publicKey))) {
      throw new Error('Trading key was submitted but never registered.');
    }
    log('trading key registered');
  }

  const market = await markets.fetchMarket(MARKET_ID);
  const book = await markets.fetchTopOfBook(MARKET_ID);
  const live = await trading.readTradingAccount(accountIndex);
  if (!state.opened) {
    if (!state.openTx) {
      const leverageNonce = await trading.nextNonce(accountIndex, API_KEY_INDEX);
      const leverageTx = await signerMod.signUpdateLeverage(
        account,
        MARKET_ID,
        plan.marginFractionFor(LEVERAGE),
        leverageNonce,
      );
      await submit(leverageTx, 'leverage');
      await sleep(2_000);
      const sizing = plan.sizeMarketOrder({
        market,
        direction: 'long',
        leverage: LEVERAGE,
        requestedMarginUsd: MARGIN_USD,
        creditedUsd: live.availableBalance,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
      });
      log(`opening ${sizing.baseAmount} ${market.symbol} notional ${sizing.notionalUsd.toFixed(2)} at worst ${sizing.worstPrice}`);
      const nonce = await trading.nextNonce(accountIndex, API_KEY_INDEX);
      const clientOrderIndex = (crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fff_ffff) || 1;
      state.openTx = await signerMod.signMarketOrder(
        account,
        {
          marketIndex: MARKET_ID,
          clientOrderIndex,
          baseAmount: sizing.baseAmountScaled,
          price: sizing.worstPriceScaled,
          isAsk: false,
          reduceOnly: false,
        },
        nonce,
      );
      await saveState(state);
    }
    await submit(state.openTx, 'open');
    state.opened = true;
    await saveState(state);
  }

  let position = (await trading.readTradingAccount(accountIndex)).positions.find((p) => p.marketId === MARKET_ID);
  for (let i = 0; i < 8 && !position; i += 1) {
    await sleep(3_000);
    position = (await trading.readTradingAccount(accountIndex)).positions.find((p) => p.marketId === MARKET_ID);
  }
  if (!position) {
    log('no position after the open; treating it as unfilled');
    state.closed = true;
    await saveState(state);
    return;
  }
  log(`position ${position.size} ${position.symbol} entry ${position.avgEntryPrice}`);
  if (state.closed) return;

  const closeBook = await markets.fetchTopOfBook(MARKET_ID);
  const close = plan.sizeCloseOrder({
    market,
    positionSign: position.sign,
    positionSize: position.size,
    bestBid: closeBook.bestBid,
    bestAsk: closeBook.bestAsk,
  });
  if (!state.closeTx) {
    const closeNonce = await trading.nextNonce(accountIndex, API_KEY_INDEX);
    const clientOrderIndex = (crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fff_ffff) || 1;
    state.closeTx = await signerMod.signMarketOrder(
      account,
      {
        marketIndex: MARKET_ID,
        clientOrderIndex,
        baseAmount: close.baseAmountScaled,
        price: close.worstPriceScaled,
        isAsk: close.direction === 'short',
        reduceOnly: true,
      },
      closeNonce,
    );
    await saveState(state);
  }
  await submit(state.closeTx, 'close');
  for (let i = 0; i < 10; i += 1) {
    await sleep(3_000);
    position = (await trading.readTradingAccount(accountIndex)).positions.find((p) => p.marketId === MARKET_ID);
    if (!position) break;
  }
  if (position) throw new Error(`Position still open: ${position.size} ${position.symbol}. No withdrawal was sent.`);
  state.closed = true;
  await saveState(state);
  log('position closed');
}

async function withdraw(state: State, accountIndex: number): Promise<void> {
  const account = {
    privateKey: state.apiKey!.privateKey,
    apiKeyIndex: API_KEY_INDEX,
    accountIndex,
  };
  const live = await trading.readTradingAccount(accountIndex);
  log(`collateral ${live.collateralRaw}`);
  if (state.withdrawTx && !state.withdrawTo) {
    throw new Error('The saved withdrawal is the secure route. It was not sent again.');
  }
  if (!state.withdrawTx) {
    const auth = await signerMod.createAuthToken(account);
    const pool = await trading.fastWithdrawPool(accountIndex, auth);
    const fee = await trading.transferFeeUnits(accountIndex, pool.toAccountIndex, auth);
    const units = fastWithdrawAmount(live.collateralRaw, fee);
    if (units === null) throw new Error(`Collateral ${live.collateralRaw} cannot cover a fast withdrawal. Nothing was signed.`);
    const nonce = await trading.nextNonce(accountIndex, API_KEY_INDEX);
    const unsigned = await signerMod.signFastWithdraw(account, {
      toAccountIndex: pool.toAccountIndex,
      amountUnits: units,
      feeUnits: fee,
      toAddress: ownerAccount.address,
      nonce,
    });
    const l1 = await ownerAccount.signMessage({ message: unsigned.messageToSign });
    state.withdrawTx = signerMod.withL1Signature(unsigned, l1);
    state.withdrawTo = ownerAccount.address;
    await saveState(state);
    log(`withdrawing ${formatUnits(units, 6)} USDC, fee ${formatUnits(fee, 6)}`);
  }
  const seen = await trading.lookupTx(state.withdrawTx!.txHash);
  if (!seen.found) {
    const auth = await signerMod.createAuthToken(account);
    const outcome = await trading.sendFastWithdraw(state.withdrawTx!, state.withdrawTo!, auth);
    log(`withdraw ${outcome.kind}${outcome.kind === 'accepted' ? '' : 'message' in outcome ? ` ${outcome.message}` : ''}`);
    if (outcome.kind === 'rejected') throw new Error(`Withdraw refused: ${outcome.message}`);
  }
  const started = Date.now();
  while (Date.now() - started < 15 * 60_000) {
    try {
      const balance = await client.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [ownerAccount.address],
      });
      if (balance > 0n) {
        log(`owner usdc ${formatUnits(balance, 6)}`);
        return;
      }
    } catch (error) {
      log(`balance read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(15_000);
  }
  throw new Error('Fast withdrawal was submitted but USDC has not reached the owner.');
}

async function shieldBack(state: State): Promise<void> {
  if (state.shieldHash) {
    log(`shield already recorded ${state.shieldHash}`);
    return;
  }
  const balance = await client.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [ownerAccount.address],
  });
  log(`shielding from ${formatUnits(balance, 6)} USDC`);
  try {
    const hash = await shieldWithPaymaster(balance);
    state.shieldHash = hash;
    await saveState(state);
    log(`paymaster shield ${hash}`);
    return;
  } catch (error) {
    log(`paymaster shield failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hash = await shieldWithEth(balance);
  state.shieldHash = hash;
  await saveState(state);
  log(`eth shield ${hash}`);
}

async function shieldWithPaymaster(balance: bigint): Promise<string> {
  const amount = railgunShieldAfterGasReserve(balance, PERMIT);
  const call = await shieldCalldata(amount);
  const account = await toSimple7702SmartAccount({ client, owner: ownerAccount });
  const bundler = createBundlerClient({
    account,
    client,
    transport: http(bundlerUrl),
    userOperation: {
      async estimateFeesPerGas({ bundlerClient }) {
        const { standard } = await bundlerClient.request<{
          Method: 'pimlico_getUserOperationGasPrice';
          Parameters: [];
          ReturnType: { standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
        }>({ method: 'pimlico_getUserOperationGasPrice', params: [] });
        return {
          maxFeePerGas: BigInt(standard.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(standard.maxPriorityFeePerGas),
        };
      },
    },
  });
  const permitSignature = await signPermit(PERMIT);
  const authorization = await ownerAccount.signAuthorization({
    chainId: 42161,
    nonce: await client.getTransactionCount({ address: ownerAccount.address }),
    address: account.authorization.address,
  });
  const userOpHash = await bundler.sendUserOperation({
    account,
    authorization,
    calls: [
      {
        to: USDC,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PROXY, amount],
        }),
      },
      { to: call.to, data: call.data },
    ],
    paymaster: PAYMASTER,
    paymasterData: encodePacked(['uint8', 'address', 'uint256', 'bytes'], [0, USDC, PERMIT, permitSignature]),
    paymasterVerificationGasLimit: 200_000n,
    paymasterPostOpGasLimit: 35_000n,
  });
  const receipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash });
  if (!receipt.success) throw new Error(`Paymaster shield reverted (${userOpHash}).`);
  return userOpHash;
}

async function shieldWithEth(balance: bigint): Promise<Hex> {
  const eth = await client.getBalance({ address: ownerAccount.address });
  if (eth < 50_000_000_000_000n) {
    const hash = await wallet.sendTransaction({ to: ownerAccount.address, value: 200_000_000_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('Top-up ETH for the shield reverted.');
  }
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [PROXY, balance],
  });
  const approveHash = await ownerWallet().sendTransaction({ to: USDC, data: approveData });
  const approveReceipt = await client.waitForTransactionReceipt({ hash: approveHash });
  if (approveReceipt.status !== 'success') throw new Error('USDC approve for the shield reverted.');
  const call = await shieldCalldata(balance);
  const { id } = await bootEngine();
  const network = models.NetworkName.Arbitrum;
  const txid = models.TXIDVersion.V2_PoseidonMerkle;
  const shieldPrivateKey = keccak256(await ownerAccount.signMessage({ message: 'RAILGUN_SHIELD' }));
  const recipients = [{ tokenAddress: USDC, amount: balance, recipientAddress: railgun.getRailgunAddress(id) }];
  const { gasEstimate } = await railgun.gasEstimateForShield(txid, network, shieldPrivateKey, recipients, [], ownerAccount.address);
  const gas = await feeCaps();
  const { transaction } = await railgun.populateShield(
    txid,
    network,
    shieldPrivateKey,
    recipients,
    [],
    gasDetails(BigInt(gasEstimate), gas),
  );
  const nonce = await client.getTransactionCount({ address: ownerAccount.address, blockTag: 'pending' });
  const raw = await ownerAccount.signTransaction({
    chainId: 42161,
    nonce,
    to: transaction.to as Address,
    data: transaction.data as Hex,
    value: 0n,
    gas: BigInt(transaction.gasLimit),
    maxFeePerGas: BigInt(transaction.maxFeePerGas ?? gas.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas ?? gas.maxPriorityFeePerGas),
    type: 'eip1559',
  });
  const hash = keccak256(raw);
  await sendRaw(raw);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('ETH-paid shield reverted.');
  return hash;
}

function ownerWallet() {
  return createWalletClient({ account: ownerAccount, chain: arbitrum, transport: http(sendRpc) });
}

async function shieldCalldata(amount: bigint): Promise<{ to: Address; data: Hex }> {
  const { id } = await bootEngine();
  const shieldPrivateKey = keccak256(await ownerAccount.signMessage({ message: 'RAILGUN_SHIELD' }));
  const recipients = [{ tokenAddress: USDC, amount, recipientAddress: railgun.getRailgunAddress(id) }];
  const { transaction } = await railgun.populateShield(
    models.TXIDVersion.V2_PoseidonMerkle,
    models.NetworkName.Arbitrum,
    shieldPrivateKey,
    recipients,
    [],
    gasDetails(0n, { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
  );
  return { to: transaction.to as Address, data: transaction.data as Hex };
}

async function signPermit(value: bigint): Promise<Hex> {
  const permitAbi = [
    { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    {
      type: 'function',
      name: 'nonces',
      stateMutability: 'view',
      inputs: [{ name: 'owner', type: 'address' }],
      outputs: [{ type: 'uint256' }],
    },
  ] as const;
  const [name, version, nonce] = await Promise.all([
    client.readContract({ address: USDC, abi: erc20Abi, functionName: 'name' }),
    client.readContract({ address: USDC, abi: permitAbi, functionName: 'version' }),
    client.readContract({ address: USDC, abi: permitAbi, functionName: 'nonces', args: [ownerAccount.address] }),
  ]);
  const signature = await ownerAccount.signTypedData({
    domain: { name, version, chainId: 42161n, verifyingContract: USDC },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner: ownerAccount.address, spender: PAYMASTER, value, nonce, deadline: maxUint256 },
  });
  return parseErc6492Signature(signature).signature;
}

process.on('unhandledRejection', (error) => {
  log(`background error: ${error instanceof Error ? error.message : String(error)}`);
});

const state = await loadState();
if (state.ownerAddress !== ownerAccount.address) {
  throw new Error('Saved round trip belongs to a different owner. It was not continued.');
}
const eth = await client.getBalance({ address: funder.address });
log(`funder ${funder.address} eth ${formatUnits(eth, 18)}`);
log(`owner ${ownerAccount.address}`);

await unshield(state);
const accountIndex = await waitForCredit(state);
await trade(state, accountIndex);
await withdraw(state, accountIndex);
await shieldBack(state);
log('round trip finished');
process.exit(0);
