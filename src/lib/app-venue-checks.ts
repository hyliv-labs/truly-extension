/**
 * Before Bring back reads an app's address: does the app still hold anything
 * for it? A supply, a debt, a position or an open order is money the address
 * does not show, and shielding "what is there" would retire the address with
 * it still inside. Each app that can hold funds has a check here; an app that
 * cannot (a swap) has none.
 *
 * A check that cannot read its source refuses rather than guessing "empty".
 */

import { erc20Abi, parseAbiItem, type Address } from 'viem';
import { AAVE_POOL, AAVE_POOL_ABI, aaveExitBlocker, reserveTokens, type AavePositionToken } from './aave';
import { lidoExitBlocker, WSTETH_ARBITRUM, type AppVenueId } from './app-venues';
import { publicClient } from './chain';
import { USDC_ADDRESS } from './config';
import {
  bankUnits,
  DYDX_INDEXER,
  DYDX_REST,
  DYDX_TRANSIT_MS,
  DYDX_USDC_DENOM,
  dydxExitBlocker,
  NOBLE_REST,
  NOBLE_USDC_DENOM,
  readSubaccounts,
} from './dydx';
import type { ActiveTrade } from './trade';

type ExitCheck = (owner: Address, trade: ActiveTrade) => Promise<string | null>;

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

/**
 * dYdX: subaccounts, open orders, the dYdX wallet, Noble, and a transit rule
 * for the CCTP leg that shows nowhere. Needs the dydx1 address the site uses.
 */
async function dydxCheck(owner: Address, trade: ActiveTrade): Promise<string | null> {
  const account = trade.appAccount;
  if (!account?.address) return 'Ghosty does not know this address’s dYdX account yet. Try again. Nothing was moved.';
  try {
    const subaccountsBody = await getJson(`${DYDX_INDEXER}/addresses/${account.address}`, [404]);
    const subaccounts = readSubaccounts(subaccountsBody);
    const orders = await Promise.all(
      subaccounts.numbers.map((number) => getJson(`${DYDX_INDEXER}/orders?address=${account.address}&subaccountNumber=${number}&status=OPEN&limit=50`, [])),
    );
    const transfers = (await getJson(`${DYDX_INDEXER}/transfers?address=${account.address}&subaccountNumber=0&limit=1`, [404])) as { transfers?: { createdAt?: string }[] } | null;
    const wallet = await getJson(`${DYDX_REST}/cosmos/bank/v1beta1/balances/${account.address}`, []);
    const noble = account.noble ? await getJson(`${NOBLE_REST}/cosmos/bank/v1beta1/balances/${account.noble}`, []) : null;
    const lastTransfer = transfers?.transfers?.[0]?.createdAt;

    const ownerUsdc = await publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
    return dydxExitBlocker(
      {
        equity: subaccounts.equity,
        positions: subaccounts.positions,
        openOrders: orders.reduce<number>((sum, body) => sum + (Array.isArray(body) ? body.length : 0), 0),
        walletUsdc: bankUnits(wallet, DYDX_USDC_DENOM),
        nobleUsdc: bankUnits(noble, NOBLE_USDC_DENOM),
        lastTransferAt: lastTransfer ? Date.parse(lastTransfer) : null,
      },
      { usdc: ownerUsdc, lastSendAt: await lastUsdcSend(owner) },
    );
  } catch (error) {
    return `Could not read the dYdX account (${error instanceof Error ? error.message.split('\n')[0] : String(error)}). Nothing was moved; try again.`;
  }
}

/** When this owner last sent USDC out on Arbitrum, if within the transit window. */
async function lastUsdcSend(owner: Address): Promise<number | null> {
  const latest = await publicClient.getBlockNumber();
  // Arbitrum makes about 4 blocks a second; read a little more than the transit window.
  const span = BigInt(Math.ceil((DYDX_TRANSIT_MS / 1000) * 4.5));
  const logs = await publicClient.getLogs({
    address: USDC_ADDRESS,
    event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
    args: { from: owner },
    fromBlock: latest > span ? latest - span : 0n,
    toBlock: latest,
  });
  const last = logs.at(-1);
  if (!last?.blockNumber) return null;
  const block = await publicClient.getBlock({ blockNumber: last.blockNumber });
  return Number(block.timestamp) * 1000;
}

/** GET JSON. Statuses in `empty` read as "nothing there" (null); anything else not ok throws. */
async function getJson(url: string, empty: number[]): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (empty.includes(response.status)) return null;
    if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lido on Arbitrum usually swaps ETH for wstETH at once from a pool; when the
 * pool is short it goes the slow way (CCIP to Ethereum and back, minutes).
 * ETH gone from the address with no wstETH yet is that: wait, do not retire.
 */
async function lidoCheck(owner: Address, trade: ActiveTrade): Promise<string | null> {
  try {
    const funded = BigInt(trade.app?.viaIntents?.minOut ?? '0');
    if (funded === 0n) return null;
    const [eth, wst] = await Promise.all([
      publicClient.getBalance({ address: owner }),
      publicClient.readContract({ address: WSTETH_ARBITRUM, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    ]);
    return lidoExitBlocker({ funded, eth, wst });
  } catch (error) {
    return `Could not read the Lido balances (${error instanceof Error ? error.message.split('\n')[0] : String(error)}). Nothing was moved; try again.`;
  }
}

const CHECKS: Partial<Record<AppVenueId, ExitCheck>> = {
  aave: aaveCheck,
  dydx: dydxCheck,
  lido: lidoCheck,
};

export async function appExitBlocker(venue: AppVenueId, trade: ActiveTrade): Promise<string | null> {
  const check = CHECKS[venue];
  return check ? check(trade.ownerAddress, trade) : null;
}
