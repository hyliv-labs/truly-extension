/**
 * E8's safety net: find money left at owner addresses.
 *
 * Owner addresses are single-use and retired, so nothing watches them after a
 * trade ends. A failed re-shield, a crash between withdrawal and re-shield, or
 * a trade abandoned mid-flight all leave USDC at an address the UI has stopped
 * showing. The seed can regenerate every one of them, so nothing is ever truly
 * lost — but only if something goes looking.
 */

import { erc20Abi, formatUnits, multicall3Abi, type Address } from 'viem';
import { publicClient } from './chain';
import { COMPOUND_MARKETS } from './compound';
import { getAccountIndex } from './lighter';
import { readTradingAccount } from './lighter-trading';
import { ownerUsdcBalance } from './reshield';
import { RAILGUN_RETURN_TOKENS } from './uniswap';
import { fundingWallet, getOwnerIndex, ownerAt } from './vault';

/**
 * How far past the last known index to keep looking.
 *
 * The index advances before a trade's funds are committed, so a crash can
 * leave the real money one or two indices beyond the stored pointer. Scanning
 * only up to the pointer would miss exactly the case this exists for.
 */
const LOOKAHEAD = 5;

export interface StrandedFunds {
  readonly index: number;
  readonly address: Address;
  readonly balance: bigint;
}

/**
 * Scan owner indices for leftover USDC.
 *
 * Reads go through the anon-rpc transport like everything else, so a scan is
 * not a privacy hole: it does not reveal to the RPC which addresses belong
 * together.
 */
export async function scanForStrandedFunds(options?: {
  onProgress?: (scanned: number, total: number) => void;
}): Promise<StrandedFunds[]> {
  const highest = await getOwnerIndex();
  const total = highest + LOOKAHEAD + 1;
  const found: StrandedFunds[] = [];

  for (let index = 0; index <= highest + LOOKAHEAD; index++) {
    const owner = await ownerAt(index);
    const balance = await ownerUsdcBalance(owner.address);

    if (balance > 0n) {
      found.push({ index, address: owner.address, balance });
    }

    options?.onProgress?.(index + 1, total);
  }

  return found;
}

const MULTICALL: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** Base-token decimals for the four Arbitrum Comets. USDC, USDC.e and USDT are 6. */
const COMPOUND_DECIMALS: Record<string, number> = {
  USDC: 6,
  'USDC.e': 6,
  USDT: 6,
  WETH: 18,
};

export interface WalletHolding {
  readonly place: 'Arbitrum' | 'Lighter' | 'Compound';
  readonly symbol: string;
  readonly amount: string;
}

export interface WalletAddressFunds {
  readonly index: number | null;
  readonly label: string;
  readonly address: Address;
  readonly holdings: WalletHolding[];
}

function showAmount(amount: bigint, decimals: number): string {
  const [whole, frac = ''] = formatUnits(amount, decimals).split('.');
  const trimmed = frac.slice(0, 8).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole!;
}

function showDecimal(raw: string): string {
  const [whole, frac = ''] = raw.trim().split('.');
  const trimmed = frac.slice(0, 6).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole || '0';
}

/**
 * Every address this vault can regenerate, and whatever it still holds.
 *
 * The old scan only reads USDC on Arbitrum, so a Lighter deposit or a Compound
 * supply looks like an empty address. This one also reads ETH and the tokens
 * Railgun can bring back, the four Arbitrum Comets, and Lighter collateral.
 * The funding address is included. It is not a trade owner.
 */
export async function scanWalletFunds(): Promise<WalletAddressFunds[]> {
  const highest = await getOwnerIndex();
  const rows: { index: number | null; label: string; address: Address }[] = [];
  for (let index = 0; index <= highest + LOOKAHEAD; index++) {
    rows.push({ index, label: `#${index}`, address: (await ownerAt(index)).address });
  }
  rows.push({ index: null, label: 'Funding', address: (await fundingWallet()).address });

  const contracts = rows.flatMap((row) => [
    {
      address: MULTICALL,
      abi: multicall3Abi,
      functionName: 'getEthBalance' as const,
      args: [row.address] as const,
    },
    ...RAILGUN_RETURN_TOKENS.map((token) => ({
      address: token.address,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [row.address] as const,
    })),
    ...COMPOUND_MARKETS.map((market) => ({
      address: market.comet,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [row.address] as const,
    })),
  ]);
  const chain = await publicClient.multicall({ contracts, allowFailure: true });
  const stride = 1 + RAILGUN_RETURN_TOKENS.length + COMPOUND_MARKETS.length;

  const lighter = await Promise.all(
    rows.map(async (row) => {
      const accountIndex = await getAccountIndex(row.address);
      if (accountIndex === null) return null;
      return readTradingAccount(accountIndex);
    }),
  );

  return rows.flatMap((row, rowIndex) => {
    const holdings: WalletHolding[] = [];
    const start = rowIndex * stride;
    const eth = chain[start];
    if (eth?.status === 'success' && eth.result > 0n) {
      holdings.push({ place: 'Arbitrum', symbol: 'ETH', amount: showAmount(eth.result, 18) });
    }
    RAILGUN_RETURN_TOKENS.forEach((token, tokenIndex) => {
      const read = chain[start + 1 + tokenIndex];
      if (read?.status === 'success' && read.result > 0n) {
        holdings.push({ place: 'Arbitrum', symbol: token.symbol, amount: showAmount(read.result, token.decimals) });
      }
    });
    COMPOUND_MARKETS.forEach((market, marketIndex) => {
      const read = chain[start + 1 + RAILGUN_RETURN_TOKENS.length + marketIndex];
      const decimals = COMPOUND_DECIMALS[market.label] ?? 18;
      if (read?.status === 'success' && read.result > 0n) {
        holdings.push({ place: 'Compound', symbol: market.label, amount: showAmount(read.result, decimals) });
      }
    });
    const account = lighter[rowIndex];
    if (account && (account.collateral > 0 || account.positions.length > 0)) {
      holdings.push({
        place: 'Lighter',
        symbol: account.positions.length > 0 ? 'USDC · position open' : 'USDC',
        amount: showDecimal(account.collateralRaw),
      });
    }
    return holdings.length > 0 ? [{ ...row, holdings }] : [];
  });
}
