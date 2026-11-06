/**
 * Shield the env wallet's Arbitrum USDC into a Railgun wallet.
 * The mnemonic is written to .env.local and never printed.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  keccak256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import LevelDOWN from 'leveldown';

const ROOT = '/home/jiojohny/Desktop/ethglobal/truly-extension';
const ENV_PATH = join(ROOT, '.env.local');
const WORK = '/tmp/truly-railgun';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const require = createRequire(join(ROOT, 'node_modules/@railgun-community/wallet/package.json'));
const railgun = require('@railgun-community/wallet');
const models = require('@railgun-community/shared-models');

const env = Object.fromEntries(
  (await readFile(ENV_PATH, 'utf8'))
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);

async function remember(name, value) {
  if (env[name]) return;
  env[name] = value;
  const current = await readFile(ENV_PATH, 'utf8');
  await writeFile(ENV_PATH, `${current.replace(/\s*$/, '')}\n${name}=${value}\n`);
}

const rawKey = env.PRIVATE_KEY?.trim();
if (!rawKey) throw new Error('PRIVATE_KEY is missing');
const account = privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`);
const client = createPublicClient({
  chain: arbitrum,
  transport: http(env.WXT_ARBITRUM_RPC_URL || 'https://arbitrum.gateway.tenderly.co'),
});

if (!env.RAILGUN_MNEMONIC) {
  await remember('RAILGUN_MNEMONIC', generateMnemonic(wordlist));
}
const mnemonic = env.RAILGUN_MNEMONIC;
const encryptionKey = createHash('sha256').update(`truly-railgun-v1:${mnemonic}`).digest('hex');

await mkdir(WORK, { recursive: true });
const artifactRoot = join(WORK, 'artifacts');
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

const network = models.NetworkName.Arbitrum;
const db = new LevelDOWN(join(WORK, 'engine.db'));
await railgun.startRailgunEngine(
  'truly',
  db,
  false,
  artifactStore,
  false,
  false,
  ['https://ppoi.fdi.network'],
  [],
  false,
);
const loaded = await railgun.loadProvider(
  {
    chainId: 42161,
    providers: [{ provider: env.WXT_ARBITRUM_RPC_URL || 'https://arbitrum.gateway.tenderly.co', priority: 1, weight: 2 }],
  },
  network,
  30_000,
);
console.log('unshieldFeeBps', BigInt(loaded.feesSerialized.unshieldFeeV2).toString());

let walletInfo;
if (env.RAILGUN_WALLET_ID) {
  walletInfo = await railgun.loadWalletByID(encryptionKey, env.RAILGUN_WALLET_ID, false);
} else {
  walletInfo = await railgun.createRailgunWallet(encryptionKey, mnemonic, {
    [network]: models.NETWORK_CONFIG[network].deploymentBlock,
  });
  await remember('RAILGUN_WALLET_ID', walletInfo.id);
}
console.log('railgunAddress', walletInfo.railgunAddress);

const balance = await client.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [account.address],
});
console.log('usdc', formatUnits(balance, 6));
if (balance < 15_000_000n) throw new Error('USDC balance is under 15');

const recipients = [{
  tokenAddress: USDC,
  amount: balance,
  recipientAddress: walletInfo.railgunAddress,
}];
const signature = await account.signMessage({ message: railgun.getShieldPrivateKeySignatureMessage() });
const shieldPrivateKey = keccak256(signature);
const approveData = encodeFunctionData({
  abi: erc20Abi,
  functionName: 'approve',
  args: [models.NETWORK_CONFIG[network].proxyContract, balance],
});
const allowance = await client.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'allowance',
  args: [account.address, models.NETWORK_CONFIG[network].proxyContract],
});
const fees = await client.estimateFeesPerGas();
async function send(to, data, gas) {
  const nonce = await client.getTransactionCount({ address: account.address });
  const serialized = await account.signTransaction({
    chainId: 42161,
    nonce,
    to,
    data,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    type: 'eip1559',
  });
  const hash = await client.sendRawTransaction({ serializedTransaction: serialized });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
  return hash;
}
if (allowance < balance) {
  const approveGas = await client.estimateGas({ account: account.address, to: USDC, data: approveData });
  const approveHash = await send(USDC, approveData, approveGas);
  console.log('approve', approveHash);
}
const { gasEstimate } = await railgun.gasEstimateForShield(
  models.TXIDVersion.V2_PoseidonMerkle,
  network,
  shieldPrivateKey,
  recipients,
  [],
  account.address,
);
const gasDetails = {
  evmGasType: models.EVMGasType.Type2,
  gasEstimate,
  maxFeePerGas: fees.maxFeePerGas,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
};
const { transaction } = await railgun.populateShield(
  models.TXIDVersion.V2_PoseidonMerkle,
  network,
  shieldPrivateKey,
  recipients,
  [],
  gasDetails,
);

const shieldGas = BigInt(transaction.gasLimit?.toString?.() ?? gasEstimate);
const eth = await client.getBalance({ address: account.address });
const cost = (shieldGas * fees.maxFeePerGas * 12n) / 10n;
console.log('eth', formatUnits(eth, 18), 'gasBudget', formatUnits(cost, 18));
if (eth < cost) throw new Error('Not enough ETH for the shield');
const shieldHash = await send(transaction.to, transaction.data, shieldGas);
console.log('shield', shieldHash);
const left = await client.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [account.address],
});
console.log('usdcLeft', formatUnits(left, 6));
await railgun.stopRailgunEngine();
