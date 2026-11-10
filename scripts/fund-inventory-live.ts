// Read-only inventory of every address the test vault could have used.
// Prints addresses and amounts only, never a key or the phrase.
import { readFileSync } from 'node:fs';
import { createPublicClient, erc20Abi, formatUnits, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { deriveFundingWallet, deriveOwner } from '../src/lib/keys.ts';

const env = Object.fromEntries(
  readFileSync('/home/jiojohny/Desktop/ethglobal/truly-extension/.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const phrase = env.RAILGUN_MNEMONIC!;
const pk = (env.PRIVATE_KEY!.startsWith('0x') ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`) as `0x${string}`;

const client = createPublicClient({ chain: arbitrum, transport: http('https://arbitrum.gateway.tenderly.co', { retryCount: 6, retryDelay: 1500 }) });
const TOKENS: [string, Address, number][] = [
  ['USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6],
  ['USDC.e', '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 6],
  ['USDT', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6],
  ['DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 18],
  ['ARB', '0x912CE59144191C1204E64559FE8253a0e49E6548', 18],
  ['WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18],
];
const COMETS: [string, Address, number][] = [
  ['cUSDCv3', '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf', 6],
  ['cUSDC.ev3', '0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA', 6],
  ['cUSDTv3', '0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07', 6],
  ['cWETHv3', '0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486', 18],
];
const borrowAbi = [{ type: 'function', name: 'borrowBalanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;

const who: [string, Address][] = [['funder (PRIVATE_KEY)', privateKeyToAccount(pk).address], ['funding wallet', (await deriveFundingWallet(phrase)).address]];
for (let i = 0; i < 16; i++) who.push([`owner #${i}`, (await deriveOwner(phrase, i)).address]);

async function lighter(address: Address): Promise<string> {
  try {
    const r = await fetch(`https://mainnet.zklighter.elliot.ai/api/v1/accountsByL1Address?l1_address=${address}`);
    const j = (await r.json()) as { sub_accounts?: { index: number; collateral: string }[] };
    const subs = (j.sub_accounts ?? []).filter((s) => Number(s.collateral) > 0);
    return subs.map((s) => `Lighter #${s.index} ${s.collateral} USDC`).join(', ');
  } catch {
    return 'Lighter ?';
  }
}

for (const [label, address] of who) {
  const eth = await client.getBalance({ address });
  const nonce = await client.getTransactionCount({ address });
  const reads = await client.multicall({
    allowFailure: false,
    contracts: [
      ...TOKENS.map(([, t]) => ({ address: t, abi: erc20Abi, functionName: 'balanceOf' as const, args: [address] as const })),
      ...COMETS.map(([, c]) => ({ address: c, abi: erc20Abi, functionName: 'balanceOf' as const, args: [address] as const })),
      ...COMETS.map(([, c]) => ({ address: c, abi: borrowAbi, functionName: 'borrowBalanceOf' as const, args: [address] as const })),
    ],
  });
  const rest = reads as bigint[];
  await new Promise((r) => setTimeout(r, 400));
  const parts: string[] = [];
  if (eth > 0n) parts.push(`${formatUnits(eth as bigint, 18)} ETH`);
  TOKENS.forEach(([s, , d], i) => { const v = rest[i] as bigint; if (v > 0n) parts.push(`${formatUnits(v, d)} ${s}`); });
  COMETS.forEach(([s, , d], i) => { const v = rest[TOKENS.length + i] as bigint; if (v > 0n) parts.push(`${formatUnits(v, d)} supplied in ${s}`); });
  COMETS.forEach(([s, , d], i) => { const v = rest[TOKENS.length + COMETS.length + i] as bigint; if (v > 0n) parts.push(`BORROWED ${formatUnits(v, d)} from ${s}`); });
  const l = await lighter(address);
  if (l) parts.push(l);
  if (parts.length || (nonce as number) > 0) console.log(`${label.padEnd(22)} ${address}  txs=${nonce}  ${parts.join(' | ') || '(empty)'}`);
}
