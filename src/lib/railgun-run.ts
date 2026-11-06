/**
 * Railgun engine. Imported ONLY by the offscreen document.
 *
 * The wallet SDK needs IndexedDB, workers and WebAssembly. A service worker
 * has none of those, and importing this file there pulls the SDK into the
 * worker bundle. prove-withdrawal.ts has the same split.
 *
 * Proofs are the SDK's. This file does not invent a proof, and it does not
 * submit the transaction: the service worker signs and broadcasts it.
 */

import Level from 'level-js';
import {
  ArtifactStore,
  balanceForERC20Token,
  createRailgunWallet,
  gasEstimateForShield,
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  getRailgunAddress,
  loadProvider,
  loadWalletByID,
  populateProvedUnshield,
  populateShield,
  getEngine,
  pauseAllPollingProviders,
  refreshBalances,
  setOnBalanceUpdateCallback,
  setOnUTXOMerkletreeScanCallback,
  startRailgunEngine,
  walletForID,
} from '@railgun-community/wallet';
import {
  calculateGasPrice,
  EVMGasType,
  getEVMGasTypeForTransaction,
  NETWORK_CONFIG,
  NetworkName,
  TXIDVersion,
  type RailgunERC20AmountRecipient,
  type TransactionGasDetails,
} from '@railgun-community/shared-models';
import { ARBITRUM_RPC_URL, RAILGUN_SCAN_FROM_BLOCK } from './config';
import { countRailgunRpcError, getRailgunSyncStatus, setRailgunSyncStatus } from './railgun-sync-status';
import { installRpcThrottle } from './rpc-throttle';

/**
 * RPC endpoints for the Railgun engine. The engine talks to these DIRECTLY
 * (ethers, normal headers), not through anon-rpc, so arb1 works here even
 * though the mixnet hop's dropped content-type rules it out for anon-rpc.
 * Two providers, so one failing does not stall the sync.
 */
const RAILGUN_RPC_URLS = [...new Set(['https://arb1.arbitrum.io/rpc', ARBITRUM_RPC_URL])];
import { POI, RailgunEngine } from '@railgun-community/engine';
import { RAILGUN_CIRCUIT_FILES, RAILGUN_CIRCUIT_PUBLIC_DIR } from './railgun-circuit';
import { RAILGUN_USDC, SELF_BROADCAST_SPEND_BUCKETS } from './railgun';

const NETWORK = NetworkName.Arbitrum;
const TXID = TXIDVersion.V2_PoseidonMerkle;
/*
 * v2: wallets made before the creation block moved off the deployment block
 * must be re-created once to pick it up. The ID is generateID(mnemonic, index),
 * so re-creating rewrites only the stored creation block and keeps any scan
 * progress already made.
 */
const WALLET_ID_KEY = 'truly:railgunWalletId:v2';
const PPOI_NODE = 'https://ppoi.fdi.network';

export interface RailgunBalanceSnapshot {
  readonly spendableUnits: string;
  readonly pendingUnits: string;
  readonly feeBps: string;
  readonly railgunAddress: string;
}

export interface PopulatedRailgunTx {
  readonly to: string;
  readonly data: string;
  readonly value: string;
  readonly gasLimit: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
}

let booting: Promise<{ feeBps: bigint }> | null = null;
let walletId: string | null = null;

export async function runRailgunBalances(mnemonic: string): Promise<RailgunBalanceSnapshot> {
  try {
    return await readBalances(mnemonic);
  } catch (error) {
    setRailgunSyncStatus({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function readBalances(mnemonic: string): Promise<RailgunBalanceSnapshot> {
  setRailgunSyncStatus({ phase: 'starting', progress: 0, error: undefined });
  const { feeBps } = await ensureEngine();
  const id = await ensureWallet(mnemonic);
  setRailgunSyncStatus({ phase: 'syncing' });
  await syncWallet(id);

  const wallet = walletForID(id);
  const spendable = await balanceForERC20Token(TXID, wallet, NETWORK, RAILGUN_USDC, true);
  const total = await balanceForERC20Token(TXID, wallet, NETWORK, RAILGUN_USDC, false);
  const pending = total > spendable ? total - spendable : 0n;
  const address = getRailgunAddress(id);
  if (!address) throw new Error('Railgun wallet has no 0zk address.');

  setRailgunSyncStatus({ phase: 'ready', progress: 1 });
  return {
    spendableUnits: spendable.toString(),
    pendingUnits: pending.toString(),
    feeBps: feeBps.toString(),
    railgunAddress: address,
  };
}

/**
 * Build a proved unshield of `amountUnits` to `recipient`. The amount is what
 * the contract is asked to send; the caller grosses it up for the fee.
 */
export async function runRailgunUnshield(input: {
  mnemonic: string;
  recipient: string;
  amountUnits: string;
  fromAddress: string;
}): Promise<PopulatedRailgunTx> {
  await ensureEngine();
  const id = await ensureWallet(input.mnemonic);
  // The live listener is paused (see boot), so the notes are only as fresh as
  // the last sync. Without this, a second unshield in the same session could
  // pick the note the first one already spent, and the transaction reverts.
  await syncWallet(id);
  const key = await encryptionKey(input.mnemonic);
  const recipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress: RAILGUN_USDC,
      amount: BigInt(input.amountUnits),
      recipientAddress: input.recipient,
    },
  ];
  const gas = await feeCaps();
  const estimateDetails = gasDetails(0n, gas);
  const { gasEstimate } = await gasEstimateForUnprovenUnshield(
    TXID,
    NETWORK,
    id,
    key,
    recipients,
    [],
    estimateDetails,
    undefined,
    true,
  );
  const details = gasDetails(gasEstimate, gas);
  const minPrice = calculateGasPrice(details);
  await generateUnshieldProof(
    TXID,
    NETWORK,
    id,
    key,
    recipients,
    [],
    undefined,
    true,
    minPrice,
    (progress) => console.info('[truly] railgun unshield proof', progress),
  );
  const { transaction } = await populateProvedUnshield(
    TXID,
    NETWORK,
    id,
    recipients,
    [],
    undefined,
    true,
    minPrice,
    details,
  );
  return serialise(transaction);
}

/** Shield `amountUnits` of USDC into this vault's Railgun wallet. */
export async function runRailgunShield(input: {
  mnemonic: string;
  shieldPrivateKey: string;
  amountUnits: string;
  fromAddress: string;
}): Promise<PopulatedRailgunTx> {
  await ensureEngine();
  const id = await ensureWallet(input.mnemonic);
  const railgunAddress = getRailgunAddress(id);
  if (!railgunAddress) throw new Error('Railgun wallet has no 0zk address.');
  const recipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress: RAILGUN_USDC,
      amount: BigInt(input.amountUnits),
      recipientAddress: railgunAddress,
    },
  ];
  const { gasEstimate } = await gasEstimateForShield(
    TXID,
    NETWORK,
    input.shieldPrivateKey,
    recipients,
    [],
    input.fromAddress,
  );
  const details = gasDetails(gasEstimate, await feeCaps());
  const { transaction } = await populateShield(
    TXID,
    NETWORK,
    input.shieldPrivateKey,
    recipients,
    [],
    details,
  );
  return serialise(transaction);
}

/**
 * Shield calldata only. No gas estimate, so this does not need an allowance
 * and does not need ETH. The caller batches the approve with this call and
 * lets Circle's paymaster buy the gas with USDC.
 */
export async function runRailgunShieldCall(input: {
  mnemonic: string;
  shieldPrivateKey: string;
  amountUnits: string;
}): Promise<{ to: string; data: string }> {
  await ensureEngine();
  const id = await ensureWallet(input.mnemonic);
  const railgunAddress = getRailgunAddress(id);
  if (!railgunAddress) throw new Error('Railgun wallet has no 0zk address.');
  const recipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress: RAILGUN_USDC,
      amount: BigInt(input.amountUnits),
      recipientAddress: railgunAddress,
    },
  ];
  const { transaction } = await populateShield(
    TXID,
    NETWORK,
    input.shieldPrivateKey,
    recipients,
    [],
    gasDetails(0n, { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
  );
  const to = stringField(transaction.to);
  const data = stringField(transaction.data);
  if (!to || !data) throw new Error('Railgun did not return a shield call.');
  return { to, data };
}

/**
 * Bring the merkle tree and this wallet's notes up to date. Resolves once
 * the wallet's notes are decrypted, so a balance read straight after is real.
 *
 * NOT the SDK's awaitWalletScan. refreshBalances runs the decrypt itself and
 * defers the wallet's completion event (deferCompletionEvent), so
 * WalletDecryptBalancesComplete never fires on this path. awaitWalletScan
 * then waits for some later decrypt, and measured, the popup never got a
 * balance after a sync that had finished.
 */
async function syncWallet(id: string): Promise<void> {
  const chain = NETWORK_CONFIG[NETWORK].chain;
  await refreshBalances(chain, [id]);
  // refreshBalances returns at once ("Already scanning") when an earlier
  // call's scan still holds the tree, e.g. the popup asked again. That scan
  // decrypts before it releases the tree, so waiting for the release is enough.
  const tree = getEngine().getUTXOMerkletree(TXID, chain);
  while (tree.isScanning) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function snarkGroth16(): unknown {
  const snark = (globalThis as { snarkjs?: { groth16?: { fullProve?: unknown } } }).snarkjs;
  if (!snark?.groth16 || typeof snark.groth16.fullProve !== 'function') {
    throw new Error('snarkjs did not load. The offscreen page must include snarkjs.min.js before the engine starts.');
  }
  return snark.groth16;
}

async function ensureEngine(): Promise<{ feeBps: bigint }> {
  if (!booting) {
    booting = boot().catch((error: unknown) => {
      booting = null;
      throw error;
    });
  }
  return booting;
}

async function boot(): Promise<{ feeBps: bigint }> {
  const db = new Level('truly-railgun');
  // The proof builder only selects getSpendableBalanceBuckets(). On Arbitrum
  // that is the PPOI-valid bucket, which is empty for about an hour after a
  // shield. Self-broadcast does not submit a PPOI proof (sendWithPublicWallet),
  // and the contract does not check one, so tree-synced notes are spendable.
  POI.getSpendableBalanceBuckets = async () => [...SELF_BROADCAST_SPEND_BUCKETS];
  // TXID history is only needed for PPOI. Left running, the scan sits at the
  // end of refreshBalances and the popup never gets a balance.
  RailgunEngine.prototype.scanTXIDHistoryV2 = async () => undefined;
  await startRailgunEngine(
    'truly',
    db as never,
    false,
    artifactStore(),
    false,
    false,
    [PPOI_NODE],
    [],
    false,
  );
  // These read the live engine. Calling them before startRailgunEngine throws
  // "RAILGUN Engine not yet initialized."
  setOnBalanceUpdateCallback(() => undefined);
  // Was `() => undefined`: the engine reported progress and we dropped it,
  // so the popup could only spin, and a STALLED sync looked like a slow one.
  setOnUTXOMerkletreeScanCallback((event: { scanStatus?: string; progress?: number }) => {
    const progress = typeof event?.progress === 'number' ? event.progress : 0;
    if (event?.scanStatus === 'Error' || event?.scanStatus === 'Incomplete') {
      setRailgunSyncStatus({ error: `Railgun tree scan ${event.scanStatus.toLowerCase()}` });
    }
    // A late tree event must not drag the phase back from the wallet scan.
    const phase = getRailgunSyncStatus().phase;
    if (phase === 'starting' || phase === 'syncing') {
      setRailgunSyncStatus({ phase: 'syncing', progress });
    }
  });
  getEngine().prover.setSnarkJSGroth16(snarkGroth16());
  // Before the first RPC call. The first sync's slow-scan phase fires
  // hundreds of calls at once and public endpoints answer with 429s; without
  // this the sync sits at 67% for good. See rpc-throttle.ts.
  installRpcThrottle({
    hosts: RAILGUN_RPC_URLS.map((url) => new URL(url).host),
    concurrency: 4,
    maxRetries: 8,
    baseDelayMs: 500,
    maxDelayMs: 10_000,
    onRateLimited: () => countRailgunRpcError(),
  });
  const loaded = await loadProvider(
    {
      chainId: 42161,
      providers: RAILGUN_RPC_URLS.map((provider, index) => ({
        provider,
        priority: index + 1,
        weight: 2,
        maxLogsPerBatch: 2_000,
        stallTimeout: 2_500,
      })),
    },
    NETWORK,
    30_000,
  );
  // loadProvider also attaches a live listener for new Railgun events. On
  // Arbitrum that costs one getLogs per block: each ethers poll replays every
  // block since the last one and the listener queries each. Measured: a
  // ~113-call batch every 30s, which arb1 rate-limits, so the retries crowd
  // out the calls that matter (55k getLogs in 7 minutes). Truly syncs on
  // demand instead (syncWallet), so the listener has nothing to add.
  pauseAllPollingProviders();
  return { feeBps: parseBps(loaded.feesSerialized.unshieldFeeV2) };
}

/*
 * Where the Railgun wallet ID is remembered.
 *
 * NOT chrome.storage: this module runs in the offscreen document, and
 * offscreen documents expose only chrome.runtime. chrome.storage is undefined
 * there, so every Railgun call failed with "Cannot read properties of
 * undefined (reading 'local')" before the engine was ever touched.
 *
 * localStorage is the right home anyway. The ID is a pointer into the
 * engine's own IndexedDB database, and both live in this same extension
 * origin, so clearing site data clears them together. A pointer kept in
 * chrome.storage could outlive the database it points into.
 */
function readWalletId(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(WALLET_ID_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeWalletId(id: string | null): void {
  try {
    if (id) globalThis.localStorage?.setItem(WALLET_ID_KEY, id);
    else globalThis.localStorage?.removeItem(WALLET_ID_KEY);
  } catch {
    // Losing the pointer only costs a re-create from the mnemonic; the
    // wallet is derived from it, so no funds depend on this write.
  }
}

async function ensureWallet(mnemonic: string): Promise<string> {
  if (walletId) return walletId;
  const key = await encryptionKey(mnemonic);

  const existing = readWalletId();
  if (existing) {
    try {
      const loaded = await loadWalletByID(key, existing, false);
      walletId = loaded.id;
      return loaded.id;
    } catch {
      // Stale pointer -- the database was cleared, or it belongs to a
      // different mnemonic after a vault reset. Fall through and re-create:
      // the wallet is derived from the mnemonic, so nothing is lost.
      writeWalletId(null);
    }
  }

  // Not the deployment block: see RAILGUN_SCAN_FROM_BLOCK. Never earlier
  // than deployment, which would be meaningless to the engine.
  const created = await createRailgunWallet(key, mnemonic, {
    [NETWORK]: Math.max(RAILGUN_SCAN_FROM_BLOCK, NETWORK_CONFIG[NETWORK].deploymentBlock),
  });
  writeWalletId(created.id);
  walletId = created.id;
  return created.id;
}

async function encryptionKey(mnemonic: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`truly-railgun-v1:${mnemonic}`),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  // The engine hashes this string as raw hex and rejects a 0x prefix (33 bytes).
  return hex;
}

function parseBps(hex: string | undefined): bigint {
  if (!hex) return 25n;
  const bps = BigInt(hex);
  if (bps < 0n || bps >= 10_000n) return 25n;
  return bps;
}

function gasDetails(
  gasEstimate: bigint,
  gas: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): TransactionGasDetails {
  const evmGasType = getEVMGasTypeForTransaction(NETWORK, true);
  if (evmGasType === EVMGasType.Type2) {
    return {
      evmGasType,
      gasEstimate,
      maxFeePerGas: gas.maxFeePerGas,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    };
  }
  return { evmGasType: EVMGasType.Type0, gasEstimate, gasPrice: gas.maxFeePerGas };
}

async function feeCaps(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const call = async (method: string): Promise<bigint> => {
    const response = await fetch(ARBITRUM_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    });
    const json = (await response.json()) as { result?: string; error?: { message?: string } };
    if (!json.result) {
      throw new Error(json.error?.message ?? `Arbitrum ${method} returned nothing.`);
    }
    return BigInt(json.result);
  };
  const [tip, price] = await Promise.all([call('eth_maxPriorityFeePerGas'), call('eth_gasPrice')]);
  // A cap equal to the current base fee was rejected when the base fee moved
  // up by a few wei. Twice the price leaves room for that while the proof runs.
  const maxFeePerGas = (price > tip ? price : tip) * 2n;
  return { maxFeePerGas, maxPriorityFeePerGas: tip > maxFeePerGas ? maxFeePerGas : tip };
}

function serialise(transaction: {
  to?: unknown;
  data?: unknown;
  value?: unknown;
  gasLimit?: unknown;
  maxFeePerGas?: unknown;
  maxPriorityFeePerGas?: unknown;
  gasPrice?: unknown;
}): PopulatedRailgunTx {
  const to = stringField(transaction.to);
  const data = stringField(transaction.data);
  if (!to || !data) throw new Error('Railgun did not return a transaction.');
  const maxFee = bigintField(transaction.maxFeePerGas) ?? bigintField(transaction.gasPrice) ?? 0n;
  const tip = bigintField(transaction.maxPriorityFeePerGas) ?? 0n;
  return {
    to,
    data,
    value: (bigintField(transaction.value) ?? 0n).toString(),
    gasLimit: (bigintField(transaction.gasLimit) ?? 0n).toString(),
    maxFeePerGas: maxFee.toString(),
    maxPriorityFeePerGas: (tip > maxFee ? maxFee : tip).toString(),
  };
}

function stringField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'toString' in value) return String(value);
  return '';
}

function bigintField(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.length > 0) return BigInt(value);
  return null;
}

const circuitBytes = new Map<string, string | Uint8Array>();

/**
 * The SDK looks up `artifacts-v2.1/1x2` and, on a miss, downloads the old key.
 * These three paths are answered from the extension package so that download
 * never runs. Anything else (POI) still uses IndexedDB.
 */
async function bundledCircuit(path: string): Promise<string | Uint8Array | undefined> {
  const name = RAILGUN_CIRCUIT_FILES[path as keyof typeof RAILGUN_CIRCUIT_FILES];
  if (!name) return undefined;
  const cached = circuitBytes.get(path);
  if (cached) return cached;
  const response = await fetch(chrome.runtime.getURL(`${RAILGUN_CIRCUIT_PUBLIC_DIR}/${name}`));
  if (!response.ok) {
    throw new Error(
      `The Railgun proving key is not in the extension (${name}). Run pnpm dev so it is fetched before proving.`,
    );
  }
  const value = name.endsWith('.json') ? await response.text() : new Uint8Array(await response.arrayBuffer());
  circuitBytes.set(path, value);
  return value;
}

function artifactStore(): ArtifactStore {
  const db = openArtifacts();
  return new ArtifactStore(
    async (path) => {
      const bundled = await bundledCircuit(path);
      if (bundled !== undefined) return bundled as string | Buffer;
      const value = await idbGet(await db, path);
      return (value === undefined ? null : value) as string | Buffer | null;
    },
    async (_dir, path, item) => {
      if (path in RAILGUN_CIRCUIT_FILES) return;
      await idbSet(await db, path, item);
    },
    async (path) => {
      if (path in RAILGUN_CIRCUIT_FILES) return true;
      return (await idbGet(await db, path)) !== undefined;
    },
  );
}

function openArtifacts(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('truly-railgun-artifacts', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('files');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Railgun artifact store failed to open.'));
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<string | Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('files', 'readonly').objectStore('files').get(key);
    request.onsuccess = () => resolve(request.result as string | Uint8Array | undefined);
    request.onerror = () => reject(request.error ?? new Error('artifact read failed'));
  });
}

function idbSet(db: IDBDatabase, key: string, value: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('files', 'readwrite').objectStore('files').put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('artifact write failed'));
  });
}
