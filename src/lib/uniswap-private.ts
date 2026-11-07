/**
 * Fund a fresh address from Railgun so the user can swap on app.uniswap.org,
 * then shield whatever that address still holds.
 *
 * Truly does not choose the pair and does not send the swap. Uniswap's own
 * site does that, with this address as the connected wallet. There is no
 * deposit contract and no withdrawal: the unshield lands on the owner, and
 * Shield back reads the balances that are still there.
 */

import { erc20Abi, parseAbiItem, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { publicClient } from './chain';
import { ARBITRUM_CHAIN_ID, USDC_ADDRESS } from './config';
import { railgunGrossForNet } from './railgun';
import { ensureUnshieldGas, railgunUsdcBalances, shieldOwnerToken, unshieldRailgunForTrade } from './railgun-client';
import { endTrade, getActiveTrade, startTrade, updateActiveTrade, type ActiveTrade } from './trade';
import { ownerAt } from './vault';
import {
  RAILGUN_RETURN_TOKENS,
  WETH_ADDRESS,
  type UniswapAccountView,
  type UniswapTokenLine,
} from './uniswap';

const MIN_USDC = 1_000_000n;
/** Left on the address so the wrap and the shields can pay gas. */
const GAS_RESERVE_WEI = 80_000_000_000_000n;
/** What the address should hold after funding, so the user's swaps can pay gas. */
const TRADE_GAS_WEI = 100_000_000_000_000n;

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

let funding: Promise<UniswapAccountView> | null = null;
let shielding: Promise<UniswapAccountView> | null = null;

export async function fundUniswapAccount(amountIn: bigint): Promise<UniswapAccountView> {
  if (funding) return funding;
  funding = fund(amountIn).finally(() => {
    funding = null;
  });
  return funding;
}

export async function shieldUniswapAccount(): Promise<UniswapAccountView> {
  if (shielding) return shielding;
  shielding = shield().finally(() => {
    shielding = null;
  });
  return shielding;
}

async function fund(amountIn: bigint): Promise<UniswapAccountView> {
  if (amountIn < MIN_USDC) throw new Error('Fund at least 1 USDC.');
  const existing = await getActiveTrade();
  if (existing?.venue === 'compound') {
    throw new Error('A Compound address is open. Shield it back or abandon it before funding Uniswap.');
  }
  if (existing?.session || existing?.venue === 'lighter') {
    throw new Error('A Lighter account is open. Finish or abandon it before funding Uniswap.');
  }
  if (existing?.intentAddress && existing.intentAddress.toLowerCase() !== existing.ownerAddress.toLowerCase()) {
    throw new Error('This address is a Lighter deposit. Abandon it before funding Uniswap.');
  }
  if (existing?.uniswap?.status === 'funded') return existing.uniswap;
  if (existing?.uniswap?.status === 'shielding') throw new Error('Shield back is already running.');
  if (existing?.uniswap?.status === 'failed' && existing.uniswap.unshieldTx) {
    throw new Error('This address is already funded. Shield back the tokens that are still on it.');
  }
  if (existing?.uniswap?.status === 'done') return existing.uniswap;

  const trade = existing ?? (await startTrade());
  await updateActiveTrade({
    venue: 'uniswap',
    intentAddress: trade.ownerAddress,
    uniswap: view(trade, {
      status: 'funding',
      amountIn: amountIn.toString(),
      detail: 'Checking the Railgun balance.',
      unshieldTx: trade.uniswap?.unshieldTx,
    }),
  });

  try {
    return await unshieldOntoOwner(amountIn);
  } catch (error) {
    return fail(amountIn, error);
  }
}

async function unshieldOntoOwner(amountIn: bigint): Promise<UniswapAccountView> {
  const balances = await railgunUsdcBalances();
  const gross = railgunGrossForNet(amountIn, balances.feeBps);
  const trade = await requireUniswapTrade();
  const fundedAlready =
    trade.withdrawal?.status === 'confirmed' &&
    trade.withdrawal.label === 'railgun' &&
    BigInt(trade.withdrawal.amount) === gross;

  if (trade.withdrawal?.status === 'confirmed' && !fundedAlready) {
    throw new Error('This address was already funded with a different amount. Abandon it before funding again.');
  }

  let unshieldTx = trade.uniswap?.unshieldTx ?? trade.withdrawal?.txHash;
  if (!fundedAlready) {
    await remember(trade, {
      status: 'funding',
      amountIn: amountIn.toString(),
      detail: 'Building the Railgun unshield proof. This takes a minute or two.',
      unshieldTx,
    });
    const funded = await unshieldRailgunForTrade(amountIn);
    unshieldTx = funded.txHash;
  }

  const usdc = await tokenBalance(USDC_ADDRESS, trade.ownerAddress);
  if (usdc < amountIn) {
    throw new Error('The unshield confirmed, but the USDC is not on the address yet. Retry in a moment.');
  }
  await ensureUnshieldGas(trade.ownerIndex, trade.ownerAddress, TRADE_GAS_WEI);

  const ready = view(trade, {
    status: 'funded',
    amountIn: amountIn.toString(),
    unshieldTx,
    detail: 'USDC is on this address. Open Uniswap, connect Truly, and swap there. Truly will not send a swap.',
  });
  await updateActiveTrade({ uniswap: ready });
  return ready;
}

async function shield(): Promise<UniswapAccountView> {
  const trade = await requireUniswapTrade();
  if (trade.uniswap?.status !== 'funded' && trade.uniswap?.status !== 'shielding' && trade.uniswap?.status !== 'failed') {
    throw new Error('Shield back is available once the USDC is on this address.');
  }
  const amountIn = trade.uniswap?.amountIn ?? '0';
  await remember(trade, {
    status: 'shielding',
    amountIn,
    unshieldTx: trade.uniswap?.unshieldTx,
    detail: 'Reading what this address still holds.',
  });

  try {
    await wrapLeftoverEth(trade);
    const found = await balancesToShield(trade);
    const shielded: UniswapTokenLine[] = [...(trade.uniswap?.shielded ?? [])];
    const already = new Set(shielded.map((row) => row.token.toLowerCase()));
    const left: UniswapTokenLine[] = [];

    for (const row of found) {
      if (already.has(row.token.toLowerCase())) continue;
      await remember(trade, {
        status: 'shielding',
        amountIn,
        unshieldTx: trade.uniswap?.unshieldTx,
        shielded,
        left,
        detail: `Shielding ${row.symbol} back into Railgun.`,
      });
      try {
        await clearConfirmedShield();
        const result = await shieldOwnerToken(row.token, row.amount);
        shielded.push({ ...line(row), txHash: result.txHash, amount: result.amountUnits.toString() });
        await clearConfirmedShield();
      } catch (error) {
        left.push({ ...line(row), reason: error instanceof Error ? error.message : String(error) });
      }
    }

    const ethLeft = await publicClient.getBalance({ address: trade.ownerAddress });
    if (ethLeft > 1_000_000_000_000n) {
      left.push({
        token: 'ETH',
        symbol: 'ETH',
        amount: ethLeft.toString(),
        reason: 'Kept for gas. Native ETH is not shielded; it was wrapped to WETH only above the gas reserve.',
      });
    }

    if (left.some((row) => row.token !== 'ETH')) {
      const failed = view(trade, {
        status: 'failed',
        amountIn,
        unshieldTx: trade.uniswap?.unshieldTx,
        shielded,
        left,
        detail: 'Some tokens are still on this address. Shield back tries them again. Nothing already shielded is sent twice.',
        error: left.find((row) => row.token !== 'ETH')?.reason,
      });
      await updateActiveTrade({ uniswap: failed });
      return failed;
    }

    const done = view(trade, {
      status: 'done',
      amountIn,
      unshieldTx: trade.uniswap?.unshieldTx,
      shielded,
      left,
      detail:
        shielded.length > 0
          ? 'Shielded back into Railgun. This address is not reused.'
          : 'Nothing was left to shield. This address is not reused.',
    });
    await updateActiveTrade({ uniswap: done });
    await endTrade();
    return done;
  } catch (error) {
    return fail(BigInt(amountIn), error);
  }
}

async function wrapLeftoverEth(trade: ActiveTrade): Promise<void> {
  const balance = await publicClient.getBalance({ address: trade.ownerAddress });
  if (balance <= GAS_RESERVE_WEI) return;
  const value = balance - GAS_RESERVE_WEI;
  const account = privateKeyToAccount((await ownerAt(trade.ownerIndex)).privateKey);
  const block = await publicClient.getBlock();
  const maxFeePerGas = (block.baseFeePerGas ?? 20_000_000n) * 2n;
  const data = '0xd0e30db0' as const;
  const gas = ((await publicClient.estimateGas({ account: trade.ownerAddress, to: WETH_ADDRESS, data, value })) * 12n) / 10n;
  const raw = await account.signTransaction({
    chainId: ARBITRUM_CHAIN_ID,
    nonce: await publicClient.getTransactionCount({ address: trade.ownerAddress }),
    to: WETH_ADDRESS,
    data,
    value,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas: 0n,
    type: 'eip1559',
  });
  const hash = await publicClient.sendRawTransaction({ serializedTransaction: raw }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already known|nonce too low|replacement transaction underpriced/i.test(message)) throw error;
    return null;
  });
  if (!hash) throw new Error('Wrapping ETH to WETH is already submitted. Retry shield back in a moment.');
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Wrapping ETH to WETH reverted. Nothing was shielded.');
}

async function balancesToShield(trade: ActiveTrade): Promise<{ token: Address; symbol: string; amount: bigint }[]> {
  const tokens = new Map<string, { token: Address; symbol: string }>();
  for (const token of RAILGUN_RETURN_TOKENS) {
    tokens.set(token.address.toLowerCase(), { token: token.address, symbol: token.symbol });
  }
  for (const discovered of await tokensReceived(trade)) tokens.set(discovered.toLowerCase(), { token: discovered, symbol: short(discovered) });

  const rows: { token: Address; symbol: string; amount: bigint }[] = [];
  for (const entry of tokens.values()) {
    const amount = await tokenBalance(entry.token, trade.ownerAddress);
    if (amount === 0n) continue;
    const symbol = await readSymbol(entry.token, entry.symbol);
    rows.push({ token: entry.token, symbol, amount });
  }
  return rows;
}

async function tokensReceived(trade: ActiveTrade): Promise<Address[]> {
  const unshieldTx = trade.uniswap?.unshieldTx ?? trade.withdrawal?.txHash;
  if (!unshieldTx) return [];
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: unshieldTx as Hash });
    const logs = await publicClient.getLogs({
      event: transferEvent,
      args: { to: trade.ownerAddress },
      fromBlock: receipt.blockNumber,
      toBlock: 'latest',
    });
    return [...new Set(logs.map((log) => log.address))];
  } catch {
    return [];
  }
}

async function readSymbol(token: Address, fallback: string): Promise<string> {
  try {
    const symbol = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'symbol',
    });
    return symbol || fallback;
  } catch {
    return fallback;
  }
}

async function clearConfirmedShield(): Promise<void> {
  const trade = await getActiveTrade();
  if (trade?.reshield?.status === 'confirmed') await updateActiveTrade({ reshield: undefined });
}

async function requireUniswapTrade(): Promise<ActiveTrade> {
  const trade = await getActiveTrade();
  if (!trade || trade.venue !== 'uniswap') throw new Error('No Uniswap address is open.');
  return trade;
}

async function remember(trade: ActiveTrade, patch: UniswapAccountView): Promise<void> {
  await updateActiveTrade({ uniswap: view(trade, patch) });
}

function view(trade: ActiveTrade, patch: UniswapAccountView): UniswapAccountView {
  return { ...patch, ownerAddress: trade.ownerAddress };
}

async function fail(amountIn: bigint, error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  const trade = await getActiveTrade();
  if (trade) {
    await updateActiveTrade({
      uniswap: {
        status: 'failed',
        amountIn: amountIn.toString(),
        detail: message,
        error: message,
        ownerAddress: trade.ownerAddress,
        unshieldTx: trade.uniswap?.unshieldTx ?? trade.withdrawal?.txHash,
        shielded: trade.uniswap?.shielded,
        left: trade.uniswap?.left,
      },
    }).catch(() => undefined);
  }
  throw error instanceof Error ? error : new Error(message);
}

function line(row: { token: Address; symbol: string; amount: bigint }): UniswapTokenLine {
  return { token: row.token, symbol: row.symbol, amount: row.amount.toString() };
}

function tokenBalance(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
}

function short(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
