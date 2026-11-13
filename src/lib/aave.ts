/**
 * Aave v3 on Arbitrum. The user supplies and borrows on app.aave.com; Truly
 * never does. Bring back refuses while the address has any supply (aToken) or
 * debt (debt token) in any reserve.
 *
 * Read live from the Pool (2026-11-13): ADDRESSES_PROVIDER is
 * 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb, 20 reserves, and getReserveData
 * still returns the v3.0 struct (aArbUSDC, variableDebtArbUSDC, ...). The
 * reserve list is read each time, so a reserve Aave adds later is covered.
 */

import { parseAbi, zeroAddress, type Address } from 'viem';

export const AAVE_POOL: Address = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
export const AAVE_APP = 'https://app.aave.com/?marketName=proto_arbitrum_v3';

export const AAVE_POOL_ABI = parseAbi([
  'function getReservesList() view returns (address[])',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]);

export interface AavePositionToken {
  readonly token: Address;
  readonly kind: 'supply' | 'debt';
  readonly symbol: string;
  readonly balance: bigint;
}

/** The tokens to read for one reserve. A zero address (no stable debt any more) is skipped. */
export function reserveTokens(data: { aTokenAddress: Address; stableDebtTokenAddress: Address; variableDebtTokenAddress: Address }): { token: Address; kind: 'supply' | 'debt' }[] {
  return [
    { token: data.aTokenAddress, kind: 'supply' as const },
    { token: data.variableDebtTokenAddress, kind: 'debt' as const },
    { token: data.stableDebtTokenAddress, kind: 'debt' as const },
  ].filter((row) => row.token !== zeroAddress);
}

/** "aArbUSDC" -> "USDC", "variableDebtArbWETH" -> "WETH". */
export function underlyingName(symbol: string): string {
  return symbol.replace(/^(aArb|variableDebtArb|stableDebtArb)/, '') || symbol;
}

/**
 * Why Bring back cannot run yet, or null. `accountData` is getUserAccountData:
 * collateral or debt there refuses too, even if a token read missed it.
 */
export function aaveExitBlocker(positions: readonly AavePositionToken[], accountData: { collateral: bigint; debt: bigint }): string | null {
  const debts = positions.filter((row) => row.kind === 'debt' && row.balance > 0n);
  if (debts.length > 0 || accountData.debt > 0n) {
    const names = [...new Set(debts.map((row) => underlyingName(row.symbol)))];
    return `Repay your ${names.length > 0 ? names.join(', ') : ''} debt on Aave first, then withdraw. Nothing was moved.`.replace('your  debt', 'your debt');
  }
  const supplies = positions.filter((row) => row.kind === 'supply' && row.balance > 0n);
  if (supplies.length > 0 || accountData.collateral > 0n) {
    const names = [...new Set(supplies.map((row) => underlyingName(row.symbol)))];
    return `Withdraw your ${names.length > 0 ? names.join(', ') : ''} supply on Aave first. Nothing was moved.`.replace('your  supply', 'your supply');
  }
  return null;
}
