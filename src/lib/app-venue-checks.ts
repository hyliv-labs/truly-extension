/**
 * Before Bring back reads an app's address: does the app still hold anything
 * for it? A supply, a debt, a position or an open order is money the address
 * does not show, and shielding "what is there" would retire the address with
 * it still inside. Each app that can hold funds has a check here; an app that
 * cannot (a swap) has none.
 *
 * A check that cannot read its source refuses rather than guessing "empty".
 */

import { erc20Abi, type Address } from 'viem';
import { AAVE_POOL, AAVE_POOL_ABI, aaveExitBlocker, reserveTokens, type AavePositionToken } from './aave';
import type { AppVenueId } from './app-venues';
import { publicClient } from './chain';

type ExitCheck = (owner: Address) => Promise<string | null>;

/** Every Aave reserve's supply and debt token, read for this owner. */
async function aaveCheck(owner: Address): Promise<string | null> {
  try {
    const [collateral, debt] = await publicClient.readContract({ address: AAVE_POOL, abi: AAVE_POOL_ABI, functionName: 'getUserAccountData', args: [owner] });
    const reserves = await publicClient.readContract({ address: AAVE_POOL, abi: AAVE_POOL_ABI, functionName: 'getReservesList' });
    // Two multicalls: every reserve's token addresses, then every balance.
    const datas = await publicClient.multicall({
      contracts: reserves.map((asset) => ({ address: AAVE_POOL, abi: AAVE_POOL_ABI, functionName: 'getReserveData' as const, args: [asset] as const })),
      allowFailure: false,
    });
    const tokens = datas.flatMap((data) => reserveTokens(data));
    const balances = await publicClient.multicall({
      contracts: tokens.map((row) => ({ address: row.token, abi: erc20Abi, functionName: 'balanceOf' as const, args: [owner] as const })),
      allowFailure: false,
    });
    const held = tokens.map((row, index) => ({ ...row, balance: balances[index] ?? 0n })).filter((row) => row.balance > 0n);
    const positions: AavePositionToken[] = await Promise.all(
      held.map(async (row) => ({ ...row, symbol: await publicClient.readContract({ address: row.token, abi: erc20Abi, functionName: 'symbol' }).catch(() => '') })),
    );
    return aaveExitBlocker(positions, { collateral, debt });
  } catch (error) {
    return `Could not read the Aave position (${error instanceof Error ? error.message.split('\n')[0] : String(error)}). Nothing was moved; try again.`;
  }
}

const CHECKS: Partial<Record<AppVenueId, ExitCheck>> = {
  aave: aaveCheck,
};

export async function appExitBlocker(venue: AppVenueId, owner: Address): Promise<string | null> {
  const check = CHECKS[venue];
  return check ? check(owner) : null;
}
