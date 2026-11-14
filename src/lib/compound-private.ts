/**
 * Fund a fresh address from Railgun so the user can supply on Compound,
 * then shield whatever that address still holds.
 *
 * Truly does not supply, borrow, or withdraw. Compound's own site does that,
 * with this address as the connected wallet. Shield back refuses while a
 * supply, borrow, or collateral balance is still inside a Comet market.
 */

import { erc20Abi, parseAbiItem, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { publicClient } from './chain';
import { type CompoundAccountView, type CompoundTokenLine } from './compound';
import { compoundExitBlocker } from './compound-position';
import { ARBITRUM_CHAIN_ID, USDC_ADDRESS } from './config';
import { railgunGrossForNet } from './railgun';
import { ensureUnshieldGas, railgunUsdcBalances, shieldOwnerToken, unshieldRailgunForTrade } from './railgun-client';
import { endVenue, getVenueTrade, startVenue, updateOwnedTrade, type ActiveTrade } from './trade';
import { arbitrumGasLimit } from './tx-gas';
import { RAILGUN_RETURN_TOKENS, WETH_ADDRESS } from './uniswap';
import { ownerAt } from './vault';

const MIN_USDC = 1_000_000n;
/** Left on the address so the wrap and the shields can pay gas. */
const GAS_RESERVE_WEI = 80_000_000_000_000n;
/** What the address should hold after funding, so Compound transactions can pay gas. */
const TRADE_GAS_WEI = 100_000_000_000_000n;

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

let funding: Promise<CompoundAccountView> | null = null;
let shielding: Promise<CompoundAccountView> | null = null;

export async function fundCompoundAccount(amountIn: bigint): Promise<CompoundAccountView> {
  if (funding) return funding;
  funding = fund(amountIn).finally(() => {
    funding = null;
  });
  return funding;
}

export async function shieldCompoundAccount(): Promise<CompoundAccountView> {
  if (shielding) return shielding;
  shielding = shield().finally(() => {
    shielding = null;
  });
  return shielding;
}

async function fund(amountIn: bigint): Promise<CompoundAccountView> {
  if (amountIn < MIN_USDC) throw new Error('Fund at least 1 USDC.');
  const existing = await getVenueTrade('compound');
  if (existing?.compound?.status === 'funded') return existing.compound;
  if (existing?.compound?.status === 'shielding') throw new Error('Shield back is already running.');
  if (existing?.compound?.status === 'failed' && existing.compound.unshieldTx) {
    throw new Error('This address is already funded. Shield back the tokens that are still on it.');
  }
  if (existing?.compound?.status === 'done') return existing.compound;

  const trade = existing ?? (await startVenue('compound'));
  await updateOwnedTrade(trade.ownerIndex, {
    venue: 'compound',
    intentAddress: trade.ownerAddress,
    compound: view(trade, {
      status: 'funding',
      amountIn: amountIn.toString(),
      detail: 'Checking the Railgun balance.',
      unshieldTx: trade.compound?.unshieldTx,
    }),
  });

  try {
    return await unshieldOntoOwner(amountIn);
  } catch (error) {
    return fail(amountIn, error);
  }
}

async function unshieldOntoOwner(amountIn: bigint): Promise<CompoundAccountView> {
  const balances = await railgunUsdcBalances();
  const gross = railgunGrossForNet(amountIn, balances.feeBps);
  const trade = await requireCompoundTrade();
  const fundedAlready =
    trade.withdrawal?.status === 'confirmed' &&
    trade.withdrawal.label === 'railgun' &&
    BigInt(trade.withdrawal.amount) === gross;

  if (trade.withdrawal?.status === 'confirmed' && !fundedAlready) {
    throw new Error('This address was already funded with a different amount. Abandon it before funding again.');
  }

  let unshieldTx = trade.compound?.unshieldTx ?? trade.withdrawal?.txHash;
  if (!fundedAlready) {
    await remember(trade, {
      status: 'funding',
      amountIn: amountIn.toString(),
      detail: 'Building the Railgun unshield proof. This takes a minute or two.',
      unshieldTx,
    });
    const funded = await unshieldRailgunForTrade(amountIn, 'compound');
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
    detail: 'USDC is on this address. Supply it on Compound. Withdraw it there before shielding. Ghosty will not supply or withdraw.',
  });
  await updateOwnedTrade(trade.ownerIndex, { compound: ready });
  return ready;
}

async function shield(): Promise<CompoundAccountView> {
  const trade = await requireCompoundTrade();
  if (trade.compound?.status !== 'funded' && trade.compound?.status !== 'shielding' && trade.compound?.status !== 'failed') {
    throw new Error('Shield back is available once the USDC is on this address.');
  }
  const amountIn = trade.compound?.amountIn ?? '0';
  await remember(trade, {
    status: 'shielding',
    amountIn,
    unshieldTx: trade.compound?.unshieldTx,
    detail: 'Checking that this address has withdrawn from Compound.',
  });

  try {
    const blocked = await compoundExitBlocker(trade.ownerAddress);
    if (blocked) throw new Error(blocked);

    await remember(trade, {
      status: 'shielding',
      amountIn,
      unshieldTx: trade.compound?.unshieldTx,
      detail: 'Reading what this address still holds.',
    });
    await wrapLeftoverEth(trade);
    const found = await balancesToShield(trade);
    const shielded: CompoundTokenLine[] = [...(trade.compound?.shielded ?? [])];
    const already = new Set(shielded.map((row) => row.token.toLowerCase()));
    const left: CompoundTokenLine[] = [];

    for (const row of found) {
      if (already.has(row.token.toLowerCase())) continue;
      await remember(trade, {
        status: 'shielding',
        amountIn,
        unshieldTx: trade.compound?.unshieldTx,
        shielded,
        left,
        detail: `Shielding ${row.symbol} back into Railgun.`,
      });
      try {
        await clearConfirmedShield();
        const result = await shieldOwnerToken(row.token, row.amount, 'compound');
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
        unshieldTx: trade.compound?.unshieldTx,
        shielded,
        left,
        detail: 'Some tokens are still on this address. Shield back tries them again. Nothing already shielded is sent twice.',
        error: left.find((row) => row.token !== 'ETH')?.reason,
      });
      await updateOwnedTrade(trade.ownerIndex, { compound: failed });
      return failed;
    }

    const done = view(trade, {
      status: 'done',
      amountIn,
      unshieldTx: trade.compound?.unshieldTx,
      shielded,
      left,
      detail:
        shielded.length > 0
          ? 'Shielded back into Railgun. This address is not reused.'
          : 'Nothing was left to shield. This address is not reused.',
    });
    await updateOwnedTrade(trade.ownerIndex, { compound: done });
    await endVenue('compound');
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
  // eth_estimateGas is the call that sits until the anon-rpc deadline and then
  // answers "intrinsic gas too low". A WETH deposit's posting cost is known.
  const gas = arbitrumGasLimit(data);
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
  const unshieldTx = trade.compound?.unshieldTx ?? trade.withdrawal?.txHash;
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
  const trade = await getVenueTrade('compound');
  if (trade?.reshield?.status === 'confirmed') await updateOwnedTrade(trade.ownerIndex, { reshield: undefined });
}

async function requireCompoundTrade(): Promise<ActiveTrade> {
  const trade = await getVenueTrade('compound');
  if (!trade || trade.venue !== 'compound') throw new Error('No Compound address is open.');
  return trade;
}

async function remember(trade: ActiveTrade, patch: CompoundAccountView): Promise<void> {
  await updateOwnedTrade(trade.ownerIndex, { compound: view(trade, patch) });
}

function view(trade: ActiveTrade, patch: CompoundAccountView): CompoundAccountView {
  return { ...patch, ownerAddress: trade.ownerAddress };
}

async function fail(amountIn: bigint, error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  const trade = await getVenueTrade('compound');
  if (trade) {
    await updateOwnedTrade(trade.ownerIndex, {
      compound: {
        status: 'failed',
        amountIn: amountIn.toString(),
        detail: message,
        error: message,
        ownerAddress: trade.ownerAddress,
        unshieldTx: trade.compound?.unshieldTx ?? trade.withdrawal?.txHash,
        shielded: trade.compound?.shielded,
        left: trade.compound?.left,
      },
    }).catch(() => undefined);
  }
  throw error instanceof Error ? error : new Error(message);
}

function line(row: { token: Address; symbol: string; amount: bigint }): CompoundTokenLine {
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
