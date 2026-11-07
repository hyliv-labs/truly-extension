/**
 * Read an address's Compound III positions on Arbitrum.
 *
 * One multicall per pass. The popup never imports this: it pulls in the
 * chain client, and that client belongs in the background worker.
 */

import { type Address } from 'viem';
import { publicClient } from './chain';
import { COMPOUND_MARKETS, COMPOUND_REWARDS } from './compound';

/** Claimable COMP below this stays on Compound. A short supply earns less. */
const COMP_REWARD_DUST = 10n ** 16n;
const MAX_COLLATERALS = 16;

const cometAbi = [
  {
    type: 'function',
    name: 'borrowBalanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'numAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'getAssetInfo',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint8' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'offset', type: 'uint8' },
          { name: 'asset', type: 'address' },
          { name: 'priceFeed', type: 'address' },
          { name: 'scale', type: 'uint64' },
          { name: 'borrowCollateralFactor', type: 'uint64' },
          { name: 'liquidateCollateralFactor', type: 'uint64' },
          { name: 'liquidationFactor', type: 'uint64' },
          { name: 'supplyCap', type: 'uint128' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'collateralBalanceOf',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'asset', type: 'address' },
    ],
    outputs: [{ type: 'uint128' }],
  },
] as const;

const rewardsAbi = [
  {
    type: 'function',
    name: 'getRewardOwed',
    stateMutability: 'view',
    inputs: [
      { name: 'comet', type: 'address' },
      { name: 'account', type: 'address' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          { name: 'owed', type: 'uint256' },
        ],
      },
    ],
  },
] as const;

/**
 * Why this address cannot be shielded yet, or null when every Compound
 * position is empty. A throw means the read itself failed, so nothing is
 * shielded and the address stays open.
 */
export async function compoundExitBlocker(account: Address): Promise<string | null> {
  const stride = 4 + MAX_COLLATERALS;
  const heads = await publicClient.multicall({
    allowFailure: true,
    contracts: COMPOUND_MARKETS.flatMap((market) => [
      { address: market.comet, abi: cometAbi, functionName: 'numAssets' },
      { address: market.comet, abi: cometAbi, functionName: 'borrowBalanceOf', args: [account] },
      { address: market.comet, abi: cometAbi, functionName: 'balanceOf', args: [account] },
      { address: COMPOUND_REWARDS, abi: rewardsAbi, functionName: 'getRewardOwed', args: [market.comet, account] },
      ...Array.from({ length: MAX_COLLATERALS }, (_, index) => ({
        address: market.comet,
        abi: cometAbi,
        functionName: 'getAssetInfo' as const,
        args: [index] as const,
      })),
    ]),
  });

  const collateral: { label: string; comet: Address; asset: Address }[] = [];
  for (let marketIndex = 0; marketIndex < COMPOUND_MARKETS.length; marketIndex += 1) {
    const market = COMPOUND_MARKETS[marketIndex]!;
    const base = marketIndex * stride;
    const num = heads[base];
    const borrow = heads[base + 1];
    const supply = heads[base + 2];
    const reward = heads[base + 3];
    if (num?.status !== 'success' || borrow?.status !== 'success' || supply?.status !== 'success') {
      throw new Error(`Could not read the Compound ${market.label} market. Retry shield back. Nothing was shielded.`);
    }
    // One multicall mixes every Comet read, so each result is a union.
    const borrowBalance = borrow.result as unknown as bigint;
    const supplyBalance = supply.result as unknown as bigint;
    if (borrowBalance > 0n) {
      return `This address still has a borrow on the Compound ${market.label} market. Repay it on Compound, then shield back. Truly will not repay it.`;
    }
    if (supplyBalance > 0n) {
      return `Funds are still supplied on the Compound ${market.label} market. Withdraw them on Compound, then shield back. Truly will not withdraw.`;
    }
    if (reward?.status !== 'success') {
      throw new Error(`Could not read Compound rewards on the ${market.label} market. Retry shield back. Nothing was shielded.`);
    }
    const owed = (reward.result as unknown as { owed: bigint }).owed;
    if (owed > COMP_REWARD_DUST) {
      return `COMP rewards are still claimable on the Compound ${market.label} market. Claim them on Compound, then shield back.`;
    }
    const count = Number(num.result as unknown as number);
    for (let index = 0; index < count; index += 1) {
      const info = heads[base + 4 + index];
      if (info?.status !== 'success') {
        throw new Error(`Could not read Compound collateral on the ${market.label} market. Retry shield back. Nothing was shielded.`);
      }
      collateral.push({ label: market.label, comet: market.comet, asset: (info.result as unknown as { asset: Address }).asset });
    }
  }

  if (collateral.length === 0) return null;
  const balances = await publicClient.multicall({
    allowFailure: true,
    contracts: collateral.map((row) => ({
      address: row.comet,
      abi: cometAbi,
      functionName: 'collateralBalanceOf' as const,
      args: [account, row.asset] as const,
    })),
  });
  for (let index = 0; index < balances.length; index += 1) {
    const row = balances[index];
    if (row?.status !== 'success') {
      throw new Error('Could not read Compound collateral. Retry shield back. Nothing was shielded.');
    }
    if ((row.result as unknown as bigint) > 0n) {
      return `Collateral is still supplied on the Compound ${collateral[index]!.label} market. Withdraw it on Compound, then shield back. Truly will not withdraw.`;
    }
  }
  return null;
}
