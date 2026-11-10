/**
 * Read-only: shielded USDC of the vault's Railgun wallet (index 0 of
 * RAILGUN_MNEMONIC), syncing into the given engine database. Prints amounts
 * only, never the phrase or a key. Usage: node scripts/railgun-balance-fresh-live.mjs <dbDir>
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = '/home/jiojohny/Desktop/ethglobal/truly-extension';
const require = createRequire(join(ROOT, 'package.json'));
const LevelDOWN = require('leveldown');
const railgun = require('@railgun-community/wallet');
const models = require('@railgun-community/shared-models');
const engine = require('@railgun-community/engine');
const env = Object.fromEntries((await readFile(join(ROOT, '.env.local'), 'utf8')).split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const phrase = env.RAILGUN_MNEMONIC;
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`, ...a);
process.on('unhandledRejection', () => {});

engine.POI.getSpendableBalanceBuckets = async () => ['Spendable', 'ShieldPending', 'MissingExternalPOI', 'MissingInternalPOI', 'ProofSubmitted'];
engine.RailgunEngine.prototype.scanTXIDHistoryV2 = async () => undefined;
const store = new railgun.ArtifactStore(async () => null, async () => {}, async () => false);
await railgun.startRailgunEngine('truly', new LevelDOWN(process.argv[2]), false, store, false, false, [], [], false);
railgun.setOnBalanceUpdateCallback(() => {});
let last = -1;
railgun.setOnUTXOMerkletreeScanCallback((e) => { const p = Math.round((e?.progress ?? 0) * 10); if (p !== last) { last = p; log('scan', e?.scanStatus, `${p * 10}%`); } });
const network = models.NetworkName.Arbitrum;
const chain = models.NETWORK_CONFIG[network].chain;
await railgun.loadProvider({ chainId: 42161, providers: [
  { provider: 'https://arb1.arbitrum.io/rpc', priority: 1, weight: 2, maxLogsPerBatch: 2000, stallTimeout: 2500 },
  { provider: 'https://arbitrum.gateway.tenderly.co', priority: 2, weight: 2, maxLogsPerBatch: 2000, stallTimeout: 2500 },
] }, network, 60_000);
railgun.pauseAllPollingProviders();
const key = createHash('sha256').update(`truly-railgun-v1:${phrase}`).digest('hex');
const w = await railgun.createRailgunWallet(key, phrase, { [network]: 520_000_000 });
log('wallet', w.railgunAddress.slice(0, 12) + '…' + w.railgunAddress.slice(-6));
await railgun.refreshBalances(chain, [w.id]);
const tree = railgun.getEngine().getUTXOMerkletree(models.TXIDVersion.V2_PoseidonMerkle, chain);
while (tree.isScanning) await new Promise((r) => setTimeout(r, 500));
const wallet = railgun.walletForID(w.id);
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const spendable = await railgun.balanceForERC20Token(models.TXIDVersion.V2_PoseidonMerkle, wallet, network, USDC, true);
const total = await railgun.balanceForERC20Token(models.TXIDVersion.V2_PoseidonMerkle, wallet, network, USDC, false);
log(`SHIELDED USDC total ${Number(total) / 1e6} (spendable now ${Number(spendable) / 1e6})`);
process.exit(0);
