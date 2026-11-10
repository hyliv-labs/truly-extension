/**
 * Unshield USDC from the vault's Railgun wallet (index 0 of RAILGUN_MNEMONIC)
 * to a public Arbitrum address, self-broadcast from the PRIVATE_KEY wallet.
 *
 * Circuit keys: the wallet SDK's own IPFS hash serves OLD keys whose proofs
 * revert ("Invalid Snark Proof"). Every circuit here is fetched from the
 * current set (IPFS QmUsmnK4…) and its vkey IC[0] is checked against the
 * proxy's getVerificationKey(n, c) before it is used. Unshielding the whole
 * balance leaves no change note, so it needs an n x 1 circuit Truly does not
 * bundle; this handles any n x c.
 *
 * Dry run by default; `--send` proves, signs and broadcasts. The signed bytes
 * are saved first, so a rerun resends them instead of building a second.
 * Prints addresses, amounts and hashes only, never a key or the phrase.
 *
 * Run: pnpm exec tsx scripts/unshield-to-address-live.ts --to 0x… --amount all|<usdc> --db <engineDbDir> [--send]
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { createPublicClient, formatUnits, getAddress, http, keccak256, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';

const ROOT = '/home/jiojohny/Desktop/ethglobal/truly-extension';
const STATE = '/tmp/truly-railgun/unshield-to-address.json';
const CACHE = '/tmp/truly-railgun/artifacts-current';
const IPFS = 'https://ipfs-lb.com/ipfs/QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;
const PROXY = '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9' as Address;
const SEND = process.argv.includes('--send');
const argValue = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const TO = getAddress(argValue('--to') ?? '');
const AMOUNT = argValue('--amount') ?? 'all';
const DB = argValue('--db');
if (!DB) throw new Error('Pass --db <engine database directory>');

const t0 = Date.now();
const log = (message: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${message}`);
process.on('unhandledRejection', () => {});

const env = Object.fromEntries(
  (await readFile(join(ROOT, '.env.local'), 'utf8'))
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
);
const PHRASE = env.RAILGUN_MNEMONIC;
if (!PHRASE) throw new Error('RAILGUN_MNEMONIC is not set');
const sender = privateKeyToAccount((env.PRIVATE_KEY!.startsWith('0x') ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`) as Hex);

const client = createPublicClient({ chain: arbitrum, transport: http('https://arbitrum.gateway.tenderly.co', { retryCount: 6, retryDelay: 1_500 }) });
const broadcaster = createPublicClient({ chain: arbitrum, transport: http('https://arb1.arbitrum.io/rpc', { retryCount: 3 }) });

const require = createRequire(join(ROOT, 'package.json'));
const railgun = require('@railgun-community/wallet');
const models = require('@railgun-community/shared-models');
const engine = require('@railgun-community/engine');
const LevelDOWN = require('leveldown');
const abi = engine.ABIRailgunSmartWallet;

// Self-broadcast: the contract does not check a PPOI proof, so notes still
// waiting on PPOI are spendable here.
engine.POI.getSpendableBalanceBuckets = async () => ['Spendable', 'ShieldPending', 'MissingExternalPOI', 'MissingInternalPOI', 'ProofSubmitted'];
engine.RailgunEngine.prototype.scanTXIDHistoryV2 = async () => undefined;

// --- current circuit keys, checked against the chain -------------------------
const verified = new Set<string>();
async function chainIc0(n: number, c: number): Promise<string> {
  const key = (await client.readContract({ address: PROXY, abi, functionName: 'getVerificationKey', args: [BigInt(n), BigInt(c)] })) as { ic: { x: bigint }[] };
  return key.ic[0]!.x.toString();
}
async function fetchCurrent(variant: string, name: 'vkey.json' | 'zkey' | 'wasm'): Promise<Buffer> {
  const [n, c] = variant.split('x').map(Number) as [number, number];
  const ipfsName = `${String(n).padStart(2, '0')}x${String(c).padStart(2, '0')}`;
  const local = join(CACHE, variant, name);
  try {
    return await readFile(local);
  } catch {
    // not cached yet
  }
  const url =
    name === 'vkey.json'
      ? `${IPFS}/circuits/${ipfsName}/vkey.json`
      : name === 'zkey'
        ? `${IPFS}/circuits/${ipfsName}/zkey.br`
        : `${IPFS}/prover/snarkjs/${ipfsName}.wasm.br`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`circuit ${variant} ${name}: HTTP ${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  const bytes = name === 'vkey.json' ? raw : brotliDecompressSync(raw);
  await mkdir(join(CACHE, variant), { recursive: true });
  await writeFile(local, bytes);
  log(`fetched current ${variant} ${name} (${(bytes.length / 1_048_576).toFixed(2)} MiB)`);
  return bytes;
}
async function ensureVerified(variant: string): Promise<void> {
  if (verified.has(variant)) return;
  const [n, c] = variant.split('x').map(Number) as [number, number];
  const vkey = JSON.parse((await fetchCurrent(variant, 'vkey.json')).toString('utf8')) as { IC: string[][] };
  const onChain = await chainIc0(n, c);
  if (vkey.IC[0]![0] !== onChain) throw new Error(`circuit ${variant}: the current key does not match the proxy. Not proving.`);
  verified.add(variant);
  log(`circuit ${variant} matches the Arbitrum verifier`);
}
const SPEND = /^artifacts-v2\.1\/(\d+x\d+)\/(vkey\.json|zkey|wasm)$/;
const store = new railgun.ArtifactStore(
  async (path: string) => {
    const match = SPEND.exec(path);
    if (!match) return null;
    await ensureVerified(match[1]!);
    const bytes = await fetchCurrent(match[1]!, match[2] as 'vkey.json' | 'zkey' | 'wasm');
    return match[2] === 'vkey.json' ? bytes.toString('utf8') : bytes;
  },
  async () => {},
  async (path: string) => SPEND.test(path),
);

// --- engine + wallet -----------------------------------------------------------
await railgun.startRailgunEngine('truly', new LevelDOWN(DB), false, store, false, false, [], [], false);
railgun.setOnBalanceUpdateCallback(() => {});
const snarkjs = createRequire(require.resolve('@railgun-community/wallet'))('snarkjs');
railgun.getEngine().prover.setSnarkJSGroth16(snarkjs.groth16);
const network = models.NetworkName.Arbitrum;
const chain = models.NETWORK_CONFIG[network].chain;
const txid = models.TXIDVersion.V2_PoseidonMerkle;
await railgun.loadProvider(
  { chainId: 42161, providers: [
    { provider: 'https://arb1.arbitrum.io/rpc', priority: 1, weight: 2, maxLogsPerBatch: 2000, stallTimeout: 2500 },
    { provider: 'https://arbitrum.gateway.tenderly.co', priority: 2, weight: 2, maxLogsPerBatch: 2000, stallTimeout: 2500 },
  ] },
  network,
  60_000,
);
railgun.pauseAllPollingProviders();
const key = createHash('sha256').update(`truly-railgun-v1:${PHRASE}`).digest('hex');
const wallet = await railgun.createRailgunWallet(key, PHRASE, { [network]: 520_000_000 });
log(`Railgun wallet ${String(wallet.railgunAddress).slice(0, 12)}…${String(wallet.railgunAddress).slice(-6)}`);

type State = { to: string; raw?: Hex; hash?: Hex };
let state: State | null = null;
try {
  state = JSON.parse(await readFile(STATE, 'utf8')) as State;
} catch {
  state = null;
}
if (state?.raw && state.to === TO) {
  const receipt = await client.getTransactionReceipt({ hash: state.hash! }).catch(() => null);
  if (receipt?.status === 'success') {
    log(`already unshielded: ${state.hash}`);
    process.exit(0);
  }
  if (!receipt && SEND) {
    log(`resending the saved unshield ${state.hash}`);
    await broadcaster.sendRawTransaction({ serializedTransaction: state.raw }).catch(() => {});
    const again = await client.waitForTransactionReceipt({ hash: state.hash! });
    log(again.status === 'success' ? `unshielded: ${state.hash}` : `the saved unshield reverted: ${state.hash}`);
    process.exit(again.status === 'success' ? 0 : 1);
  }
}

log('syncing the shielded balance');
await railgun.refreshBalances(chain, [wallet.id]);
const tree = railgun.getEngine().getUTXOMerkletree(txid, chain);
while (tree.isScanning) await new Promise((r) => setTimeout(r, 500));
const w = railgun.walletForID(wallet.id);
const balance = BigInt(await railgun.balanceForERC20Token(txid, w, network, USDC, true));
const amount = AMOUNT === 'all' ? balance : parseUnits(AMOUNT, 6);
if (amount <= 0n || amount > balance) throw new Error(`Cannot unshield ${formatUnits(amount, 6)} from ${formatUnits(balance, 6)} USDC.`);
const feeBps = 25n;
log(`shielded ${formatUnits(balance, 6)} USDC; unshielding ${formatUnits(amount, 6)} to ${TO}; ${TO} receives about ${formatUnits(amount - (amount * feeBps) / 10_000n, 6)} after Railgun's 0.25%`);

const recipients = [{ tokenAddress: USDC, amount, recipientAddress: TO }];
const block = await client.getBlock();
const gas = { maxFeePerGas: (block.baseFeePerGas ?? 10_000_000n) * 2n, maxPriorityFeePerGas: 0n };
const evmGasType = models.getEVMGasTypeForTransaction(network, true);
const { gasEstimate } = await railgun.gasEstimateForUnprovenUnshield(
  txid, network, wallet.id, key, recipients, [], { evmGasType, gasEstimate: 0n, ...gas }, undefined, true,
);
const gasLimit = (BigInt(gasEstimate) * 13n) / 10n;
const eth = await client.getBalance({ address: sender.address });
log(`gas up to ${formatUnits(gasLimit * gas.maxFeePerGas, 18)} ETH from ${sender.address} (holds ${formatUnits(eth, 18)})`);
if (eth < gasLimit * gas.maxFeePerGas) throw new Error('The sender cannot cover the gas. Nothing was proved or sent.');
if (!SEND) {
  log('dry run: nothing proved, signed or sent. Run again with --send.');
  process.exit(0);
}

const details = { evmGasType, gasEstimate: gasLimit, ...gas };
const minGasPrice = models.calculateGasPrice(details);
log('building the proof');
await railgun.generateUnshieldProof(txid, network, wallet.id, key, recipients, [], undefined, true, minGasPrice, (p: number) => {
  if (Math.round(p) % 25 === 0) log(`proof ${Math.round(p)}%`);
});
const { transaction } = await railgun.populateProvedUnshield(txid, network, wallet.id, recipients, [], undefined, true, minGasPrice, details);
const raw = await sender.signTransaction({
  chainId: 42161,
  nonce: await client.getTransactionCount({ address: sender.address, blockTag: 'pending' }),
  to: transaction.to as Address,
  data: transaction.data as Hex,
  value: 0n,
  gas: gasLimit,
  ...gas,
  type: 'eip1559',
});
const hash = keccak256(raw);
await mkdir('/tmp/truly-railgun', { recursive: true });
await writeFile(STATE, JSON.stringify({ to: TO, raw, hash }));
await chmod(STATE, 0o600);
await broadcaster.sendRawTransaction({ serializedTransaction: raw }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!/already known|nonce too low/i.test(message)) throw error;
});
log(`unshield sent ${hash}`);
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') {
  log(`REVERTED ${hash}. Nothing left the pool.`);
  process.exit(1);
}
log(`unshielded ${formatUnits(amount, 6)} USDC to ${TO} (${hash})`);
process.exit(0);
