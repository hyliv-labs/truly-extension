/**
 * Send owner addresses' USDC on ETHEREUM MAINNET to one address.
 *
 * Why it exists: Lighter's secure withdrawal pays out on Ethereum, not
 * Arbitrum, so a test exit left USDC on mainnet at the owner addresses.
 * Each owner pays its own gas in ETH; one that cannot is reported with the
 * ETH it needs, and nothing is sent for it.
 *
 * Dry run by default; `--send` executes. Prints addresses, amounts and hashes
 * only, never a key or the phrase.
 *
 * Run: pnpm exec tsx scripts/mainnet-usdc-sweep-live.ts --owners 0,5 --to 0x… [--send]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, getAddress, http, keccak256, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const ROOT = '/home/jiojohny/Desktop/ethglobal/truly-extension';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const SEND = process.argv.includes('--send');
const argValue = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const OWNERS = (argValue('--owners') ?? '').split(',').filter(Boolean).map(Number);
const TO = getAddress(argValue('--to') ?? '');
if (OWNERS.length === 0) throw new Error('Pass --owners, e.g. --owners 0,5');

const env = Object.fromEntries(
  (await readFile(join(ROOT, '.env.local'), 'utf8'))
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
);
const { deriveOwner } = await import('../src/lib/keys.ts');
const client = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com', { retryCount: 4 }) });

for (const index of OWNERS) {
  const owner = privateKeyToAccount((await deriveOwner(env.RAILGUN_MNEMONIC!, index)).privateKey);
  const balance = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
  if (balance === 0n) {
    console.log(`owner #${index} ${owner.address}: no USDC on Ethereum`);
    continue;
  }
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [TO, balance] });
  const gas = ((await client.estimateGas({ account: owner.address, to: USDC, data })) * 12n) / 10n;
  const block = await client.getBlock();
  const maxPriorityFeePerGas = 10_000_000n; // 0.01 gwei tip
  const maxFeePerGas = ((block.baseFeePerGas ?? 0n) * 13n) / 10n + maxPriorityFeePerGas;
  const need = gas * maxFeePerGas;
  const eth = await client.getBalance({ address: owner.address });
  console.log(
    `owner #${index} ${owner.address}: ${formatUnits(balance, 6)} USDC -> ${TO}; gas up to ${formatUnits(need, 18)} ETH, holds ${formatUnits(eth, 18)}`,
  );
  if (eth < need) {
    console.log(`  needs ${formatUnits(need - eth, 18)} more ETH on Ethereum mainnet. Nothing sent.`);
    continue;
  }
  if (!SEND) {
    console.log('  dry run: nothing sent');
    continue;
  }
  const raw = await owner.signTransaction({
    chainId: 1,
    nonce: await client.getTransactionCount({ address: owner.address, blockTag: 'pending' }),
    to: USDC,
    data,
    value: 0n,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type: 'eip1559',
  });
  const hash = keccak256(raw);
  await client.sendRawTransaction({ serializedTransaction: raw });
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`  ${receipt.status === 'success' ? 'sent' : 'REVERTED'} ${formatUnits(balance, 6)} USDC: ${hash}`);
}
process.exit(0);
