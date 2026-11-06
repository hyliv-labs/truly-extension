/**
 * Read-only. Prints shielded USDC after the self-broadcast spend set.
 * Does not print the key or the mnemonic, and does not send a transaction.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';

const ROOT = '/home/jiojohny/Desktop/ethglobal/truly-extension';
const require = createRequire(join(ROOT, 'package.json'));
const LevelDOWN = require('leveldown');
const railgun = require('@railgun-community/wallet');
const models = require('@railgun-community/shared-models');
const engine = require('@railgun-community/engine');

const SPEND = ['Spendable', 'ShieldPending', 'MissingExternalPOI', 'MissingInternalPOI', 'ProofSubmitted'];
engine.POI.getSpendableBalanceBuckets = async () => SPEND;
// TXID sync is only for PPOI. This read uses the self-broadcast spend set.
const Engine = engine.RailgunEngine ?? engine.default?.RailgunEngine;
if (Engine?.prototype?.scanTXIDHistoryV2) {
  Engine.prototype.scanTXIDHistoryV2 = async () => {
    console.log('txid scan skipped');
  };
} else {
  console.log('txid patch missing');
}
process.on('unhandledRejection', (error) => {
  console.log('background', error instanceof Error ? error.message : String(error));
});

const env = Object.fromEntries(
  (await readFile(join(ROOT, '.env.local'), 'utf8'))
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);

const rawKey = env.PRIVATE_KEY?.trim();
if (!rawKey || !env.RAILGUN_MNEMONIC || !env.RAILGUN_WALLET_ID) {
  throw new Error('Wallet env is incomplete');
}
const account = privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`);
const client = createPublicClient({
  chain: arbitrum,
  transport: http(env.WXT_ARBITRUM_RPC_URL || 'https://arbitrum.gateway.tenderly.co'),
});
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const [eth, usdc] = await Promise.all([
  client.getBalance({ address: account.address }),
  client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
]);
console.log('public', account.address, 'eth', formatUnits(eth, 18), 'usdc', formatUnits(usdc, 6));

const artifactRoot = '/tmp/truly-railgun/artifacts';
await mkdir(artifactRoot, { recursive: true });
const exists = (path) => access(join(artifactRoot, path)).then(() => true, () => false);
const artifactStore = new railgun.ArtifactStore(
  (path) => readFile(join(artifactRoot, path)),
  async (dir, path, item) => {
    await mkdir(join(artifactRoot, dir), { recursive: true });
    await writeFile(join(artifactRoot, path), item);
  },
  exists,
);

const mnemonic = env.RAILGUN_MNEMONIC;
const encryptionKey = createHash('sha256').update(`truly-railgun-v1:${mnemonic}`).digest('hex');
const network = models.NetworkName.Arbitrum;
const txid = models.TXIDVersion.V2_PoseidonMerkle;
const db = new LevelDOWN('/tmp/truly-railgun/engine.db');
await railgun.startRailgunEngine('truly', db, false, artifactStore, false, false, [], [], false);
let lastLogged = 0;
railgun.setOnUTXOMerkletreeScanCallback((event) => {
  const progress = event?.progress;
  if (typeof progress !== 'number' || progress < lastLogged + 0.05) return;
  lastLogged = progress;
  console.log('scan', progress.toFixed(2));
});
await railgun.loadProvider(
  {
    chainId: 42161,
    providers: [{ provider: env.WXT_ARBITRUM_RPC_URL || 'https://arbitrum.gateway.tenderly.co', priority: 1, weight: 2, maxLogsPerBatch: 400 }],
  },
  network,
  30_000,
);
const walletInfo = await railgun.loadWalletByID(encryptionKey, env.RAILGUN_WALLET_ID, false);
const chain = models.NETWORK_CONFIG[network].chain;
railgun.pausePPOIBatchingForChain(chain);
await railgun.refreshBalances(chain, [walletInfo.id]);
await Promise.race([
  railgun.awaitWalletScan(walletInfo.id, chain),
  new Promise((resolve) => setTimeout(resolve, 20_000)),
]);
const wallet = railgun.walletForID(walletInfo.id);
const spendable = await railgun.balanceForERC20Token(txid, wallet, network, USDC, true);
const total = await railgun.balanceForERC20Token(txid, wallet, network, USDC, false);
console.log('spendable', formatUnits(spendable, 6), 'total', formatUnits(total, 6));
if (wallet.getTokenBalancesByBucket) {
  const buckets = await wallet.getTokenBalancesByBucket(txid, chain);
  for (const [name, balances] of Object.entries(buckets)) {
    const amount = Object.values(balances).reduce((sum, entry) => sum + (entry.balance ?? 0n), 0n);
    if (amount > 0n) console.log('bucket', name, formatUnits(amount, 6));
  }
}
process.exit(0);
