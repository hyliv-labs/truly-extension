/**
 * Fund a fresh address on Hyperliquid from Railgun, and bring it back.
 *
 *   Go ghost:   Railgun -> unshield onto a fresh owner -> USDC transfer to
 *               Bridge2 -> credited to that owner's Hyperliquid account.
 *   Bring back: owner signs withdraw3 to itself -> USDC on Arbitrum ->
 *               shielded into Railgun -> the owner is retired.
 *
 * Ghosty never trades, closes a position, or sells a token. Hyperliquid's own
 * site does that, with this owner as the connected wallet. Bring back refuses
 * while a position, an order, or a non-USDC spot balance is still open.
 *
 * Every step that moves money is written down before it is sent, and a retry
 * continues that record: the bridge transfer resends the same signed bytes,
 * the withdrawal resends the same signed action (same nonce).
 */

import { encodeFunctionData, erc20Abi, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { publicClient } from './chain';
import { ARBITRUM_CHAIN_ID, USDC_ADDRESS } from './config';
import {
  depositCredited,
  exchangeBody,
  HYPERLIQUID_BRIDGE,
  HYPERLIQUID_MIN_DEPOSIT_UNITS,
  HYPERLIQUID_MIN_FUND_UNITS,
  HYPERLIQUID_WITHDRAW_FEE_UNITS,
  hyperliquidExitBlocker,
  isUnified,
  readExchangeAnswer,
  splitSignature,
  totalUsdc,
  usdcDecimalFromUnits,
  usdcUnitsFromDecimal,
  withdrawAction,
  withdrawalArrived,
  withdrawTypedData,
  type HyperliquidAccountView,
  type HyperliquidTokenLine,
} from './hyperliquid';
import { postHyperliquid, readHyperliquid } from './hyperliquid-api';
import { railgunGrossForNet } from './railgun';
import { ensureUnshieldGas, railgunUsdcBalances, shieldOwnerUsdcToRailgun, unshieldRailgunForTrade } from './railgun-client';
import { endVenue, getVenueTrade, startVenue, updateOwnedTrade, type ActiveTrade } from './trade';
import { arbitrumGasLimit } from './tx-gas';
import { signTypedDataLoose } from './typed-data';
import { ownerAt } from './vault';

/** One ERC-20 transfer on Arbitrum, with room to spare. */
const BRIDGE_GAS_WEI = 10_000_000_000_000n;
/** Hyperliquid credits a deposit in about a minute. Wait this long inside one call. */
const CREDIT_WAIT_MS = 3 * 60_000;
/** A withdrawal lands on Arbitrum in about 3 to 5 minutes. */
const ARRIVAL_WAIT_MS = 8 * 60_000;
const POLL_MS = 5_000;

let funding: Promise<HyperliquidAccountView> | null = null;
let shielding: Promise<HyperliquidAccountView> | null = null;

export function fundHyperliquidAccount(amountIn: bigint): Promise<HyperliquidAccountView> {
  if (funding) return funding;
  funding = fund(amountIn).finally(() => {
    funding = null;
  });
  return funding;
}

export function shieldHyperliquidAccount(): Promise<HyperliquidAccountView> {
  if (shielding) return shielding;
  shielding = shield().finally(() => {
    shielding = null;
  });
  return shielding;
}

/* ---------------------------------------------------------------- Funding */

async function fund(amountIn: bigint): Promise<HyperliquidAccountView> {
  if (amountIn < HYPERLIQUID_MIN_FUND_UNITS) {
    throw new Error(`Fund at least ${usdcDecimalFromUnits(HYPERLIQUID_MIN_FUND_UNITS)} USDC. Hyperliquid loses deposits under 5 USDC and keeps 1 USDC on the way back.`);
  }
  const existing = await getVenueTrade('hyperliquid');
  const before = existing?.hyperliquid;
  if (before?.status === 'funded' || before?.status === 'done') return before;
  if (before?.status === 'shielding') throw new Error('Bring back is already running.');
  if (before && before.amountIn !== amountIn.toString() && (before.unshieldTx || before.depositTx)) {
    throw new Error('This address was already funded with a different amount. Bring it back or abandon it first.');
  }

  const trade = existing ?? (await startVenue('hyperliquid'));
  try {
    if (!before?.depositTx) await unshieldOntoOwner(trade, amountIn);
    await depositToBridge(amountIn);
    return await waitForCredit(amountIn);
  } catch (error) {
    return fail('funding', amountIn.toString(), error);
  }
}

async function unshieldOntoOwner(trade: ActiveTrade, amountIn: bigint): Promise<void> {
  const balances = await railgunUsdcBalances();
  const gross = railgunGrossForNet(amountIn, balances.feeBps);
  const current = await requireTrade();
  const fundedAlready =
    current.withdrawal?.status === 'confirmed' && current.withdrawal.label === 'railgun' && BigInt(current.withdrawal.amount) === gross;
  if (current.withdrawal?.status === 'confirmed' && !fundedAlready) {
    throw new Error('This address was already funded with a different amount. Abandon it before funding again.');
  }

  let unshieldTx = current.hyperliquid?.unshieldTx ?? current.withdrawal?.txHash;
  if (!fundedAlready) {
    await remember(trade, {
      status: 'funding',
      step: 'unshielding',
      amountIn: amountIn.toString(),
      unshieldTx,
      detail: 'Building the Railgun unshield proof. This takes a minute or two.',
    });
    unshieldTx = (await unshieldRailgunForTrade(amountIn, 'hyperliquid')).txHash;
  }
  const usdc = await usdcOn(trade.ownerAddress);
  if (usdc < amountIn) throw new Error('The unshield confirmed, but the USDC is not on the address yet. Retry in a moment.');
  await remember(trade, {
    status: 'funding',
    step: 'bridging',
    amountIn: amountIn.toString(),
    unshieldTx,
    detail: 'Sending the USDC to Hyperliquid’s bridge on Arbitrum.',
  });
}

/**
 * The transfer that credits Hyperliquid. Signed once; the bytes and hash are
 * saved BEFORE broadcast, and a retry resends those bytes. A second transfer
 * with a fresh nonce would deposit twice.
 */
async function depositToBridge(amountIn: bigint): Promise<void> {
  const trade = await requireTrade();
  const view = trade.hyperliquid;
  if (!view) throw new Error('No Hyperliquid funding is recorded.');
  // The bridge's floor. Below it the USDC is not credited and cannot be recovered.
  if (amountIn < HYPERLIQUID_MIN_DEPOSIT_UNITS) throw new Error('Hyperliquid does not credit deposits under 5 USDC. Nothing was sent to it.');

  let raw = view.depositRaw as Hex | undefined;
  let hash = view.depositTx as Hex | undefined;
  if (!raw || !hash) {
    if (await bridgePaused()) throw new Error('Hyperliquid’s bridge is paused right now. Nothing was sent to it; the USDC is still on the address. Try again later.');
    await ensureUnshieldGas(trade.ownerIndex, trade.ownerAddress, BRIDGE_GAS_WEI);
    const creditBefore = totalUsdc(await readHyperliquid(trade.ownerAddress));
    const owner = await ownerAt(trade.ownerIndex);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [HYPERLIQUID_BRIDGE, amountIn] });
    const block = await publicClient.getBlock();
    raw = await privateKeyToAccount(owner.privateKey).signTransaction({
      chainId: ARBITRUM_CHAIN_ID,
      nonce: await publicClient.getTransactionCount({ address: trade.ownerAddress }),
      to: USDC_ADDRESS,
      data,
      gas: arbitrumGasLimit(data),
      maxFeePerGas: (block.baseFeePerGas ?? 20_000_000n) * 2n,
      maxPriorityFeePerGas: 0n,
      type: 'eip1559',
    });
    hash = keccak256(raw);
    await remember(trade, {
      ...view,
      step: 'bridging',
      depositRaw: raw,
      depositTx: hash,
      creditBefore: creditBefore.toString(),
      detail: 'Sending the USDC to Hyperliquid’s bridge on Arbitrum.',
    });
  }

  await publicClient.sendRawTransaction({ serializedTransaction: raw }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already known|nonce too low|replacement transaction underpriced/i.test(message)) throw error;
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') {
    // Nothing moved. Forget the bytes so a retry signs a new transfer.
    const latest = await requireTrade();
    await remember(latest, { ...latest.hyperliquid!, depositRaw: undefined, depositTx: undefined, step: 'bridging' });
    throw new Error('The transfer to Hyperliquid’s bridge reverted. The USDC is still on the address.');
  }
}

async function waitForCredit(amountIn: bigint): Promise<HyperliquidAccountView> {
  const trade = await requireTrade();
  const view = trade.hyperliquid!;
  await remember(trade, {
    ...view,
    status: 'funding',
    step: 'crediting',
    error: undefined,
    detail: 'The USDC reached Hyperliquid’s bridge. Waiting for Hyperliquid to credit it, usually about a minute.',
  });
  const before = BigInt(view.creditBefore ?? '0');
  const deadline = Date.now() + CREDIT_WAIT_MS;
  for (;;) {
    const account = await readHyperliquid(trade.ownerAddress).catch(() => null);
    if (account && depositCredited(before, totalUsdc(account), amountIn)) {
      const latest = await requireTrade();
      const ready: HyperliquidAccountView = {
        ...latest.hyperliquid!,
        status: 'funded',
        step: undefined,
        depositRaw: undefined,
        error: undefined,
        detail: 'The USDC is in this address’s Hyperliquid account. Trade on Hyperliquid. Close positions there before bringing it back.',
      };
      await remember(latest, ready);
      return ready;
    }
    if (Date.now() > deadline) {
      const latest = await requireTrade();
      const waiting: HyperliquidAccountView = {
        ...latest.hyperliquid!,
        detail: 'The bridge transfer confirmed. Hyperliquid has not credited it yet. Ghosty keeps checking; nothing needs to be sent again.',
      };
      await remember(latest, waiting);
      return waiting;
    }
    await sleep(POLL_MS);
  }
}

/* ------------------------------------------------------------ Bring back */

async function shield(): Promise<HyperliquidAccountView> {
  const trade = await requireTrade();
  const view = trade.hyperliquid;
  if (!view || !(view.status === 'funded' || view.status === 'shielding' || (view.status === 'failed' && view.depositTx))) {
    throw new Error('Bring back is available once the USDC is on Hyperliquid.');
  }
  const amountIn = view.amountIn;
  try {
    if (!view.withdrawal) await startWithdrawal(trade);
    else if (!view.withdrawal.acceptedAt) await sendWithdrawal(trade);
    const arrived = await waitForArrival();
    if (!arrived) return (await requireTrade()).hyperliquid!;
    return await shieldBack();
  } catch (error) {
    const latest = await getVenueTrade('hyperliquid');
    if (latest?.hyperliquid && !latest.hyperliquid.withdrawal) {
      // Refused before anything was withdrawn (an open position, an order, a
      // spot token). The account is still funded; say why and stay there.
      const message = error instanceof Error ? error.message : String(error);
      await remember(latest, { ...latest.hyperliquid, status: 'funded', step: undefined, error: message, detail: message });
      throw error instanceof Error ? error : new Error(message);
    }
    return fail('shielding', amountIn, error);
  }
}

async function startWithdrawal(trade: ActiveTrade): Promise<void> {
  const view = trade.hyperliquid!;
  await remember(trade, { ...view, status: 'shielding', step: 'withdrawing', error: undefined, detail: 'Checking the Hyperliquid account.' });

  const account = await readHyperliquid(trade.ownerAddress);
  const blocked = hyperliquidExitBlocker(account);
  if (blocked) throw new Error(blocked);
  if (!isUnified(account.mode) && account.withdrawable <= HYPERLIQUID_WITHDRAW_FEE_UNITS && account.spotUsdc - account.spotUsdcHold > HYPERLIQUID_WITHDRAW_FEE_UNITS) {
    throw new Error('Your USDC is in Hyperliquid’s spot balance. Move it to Perps on Hyperliquid (Transfer, Spot to Perps), then bring it back. Nothing was withdrawn.');
  }
  if (account.withdrawable <= HYPERLIQUID_WITHDRAW_FEE_UNITS) {
    if (totalUsdc(account) > HYPERLIQUID_WITHDRAW_FEE_UNITS) {
      throw new Error('Hyperliquid shows a balance but nothing withdrawable yet. Wait a moment and try again. Nothing was withdrawn.');
    }
    // Nothing left on Hyperliquid worth the 1 USDC fee. Shield what is on the address.
    const latest = await requireTrade();
    await remember(latest, {
      ...latest.hyperliquid!,
      withdrawal: { nonce: 0, amount: '0', arbitrumBefore: '0', acceptedAt: Date.now() },
      detail: 'Nothing left on Hyperliquid to withdraw. Shielding what is on the address.',
    });
    return;
  }

  const amount = usdcDecimalFromUnits(account.withdrawable);
  const nonce = Date.now();
  const action = withdrawAction(trade.ownerAddress, amount, nonce);
  const owner = await ownerAt(trade.ownerIndex);
  const signature = splitSignature(await signTypedDataLoose(owner.privateKey, withdrawTypedData(action)));
  const latest = await requireTrade();
  await remember(latest, {
    ...latest.hyperliquid!,
    status: 'shielding',
    step: 'withdrawing',
    withdrawal: { nonce, amount, arbitrumBefore: (await usdcOn(trade.ownerAddress)).toString(), signature },
    detail: `Withdrawing ${amount} USDC from Hyperliquid to Arbitrum. Hyperliquid keeps 1 USDC.`,
  });
  await sendWithdrawal(await requireTrade());
}

/** Send the saved, signed withdrawal. The same nonce every time, so it can only be processed once. */
async function sendWithdrawal(trade: ActiveTrade): Promise<void> {
  const view = trade.hyperliquid!;
  const saved = view.withdrawal;
  if (!saved?.signature) throw new Error('The withdrawal was not signed. Try again.');
  const action = withdrawAction(trade.ownerAddress, saved.amount, saved.nonce);

  // A lost response is the case to fear: maybe it was processed. If the
  // withdrawable balance already dropped by the amount, it was.
  const account = await readHyperliquid(trade.ownerAddress).catch(() => null);
  const already = account !== null && account.withdrawable + 1_000_000n < usdcUnitsFromDecimal(saved.amount);

  const answer = already ? 'duplicate' : readExchangeAnswer(await postHyperliquid('/exchange', exchangeBody(action, saved.signature)));
  if (typeof answer === 'object') {
    // Hyperliquid refused it outright, so nothing was withdrawn. Forget it, so the next try signs a fresh one.
    await remember(trade, { ...view, withdrawal: undefined, step: 'withdrawing' });
    throw new Error(`Hyperliquid refused the withdrawal: ${answer.error}. Nothing was withdrawn.`);
  }
  await remember(trade, {
    ...view,
    step: 'arriving',
    withdrawal: { ...saved, acceptedAt: Date.now() },
    detail: `Hyperliquid accepted the withdrawal of ${saved.amount} USDC. It reaches Arbitrum in about 3 to 5 minutes.`,
  });
}

async function waitForArrival(): Promise<boolean> {
  const trade = await requireTrade();
  const saved = trade.hyperliquid!.withdrawal!;
  const amount = usdcUnitsFromDecimal(saved.amount);
  if (amount === 0n) return true;
  const before = BigInt(saved.arbitrumBefore);
  const deadline = Date.now() + ARRIVAL_WAIT_MS;
  for (;;) {
    const now = await usdcOn(trade.ownerAddress).catch(() => null);
    if (now !== null && withdrawalArrived(before, now, amount)) return true;
    if (Date.now() > deadline) {
      await remember(trade, {
        ...(await requireTrade()).hyperliquid!,
        detail: 'Hyperliquid accepted the withdrawal. It has not reached Arbitrum yet. Ghosty keeps checking; nothing needs to be signed again.',
      });
      return false;
    }
    await sleep(POLL_MS * 2);
  }
}

async function shieldBack(): Promise<HyperliquidAccountView> {
  const trade = await requireTrade();
  const view = trade.hyperliquid!;
  await remember(trade, { ...view, step: 'shielding', detail: 'Shielding the USDC back into Railgun.' });

  const shielded: HyperliquidTokenLine[] = [...(view.shielded ?? [])];
  const left: HyperliquidTokenLine[] = [];
  const usdc = await usdcOn(trade.ownerAddress);
  if (usdc > 0n && !shielded.some((row) => row.token.toLowerCase() === USDC_ADDRESS.toLowerCase())) {
    const result = await shieldOwnerUsdcToRailgun('hyperliquid');
    shielded.push({ token: USDC_ADDRESS, symbol: 'USDC', amount: result.amountUnits.toString(), txHash: result.txHash });
  }
  const after = await usdcOn(trade.ownerAddress);
  if (after > 0n) {
    left.push({ token: USDC_ADDRESS, symbol: 'USDC', amount: after.toString(), reason: 'Kept to pay the shield’s gas through the paymaster.' });
  }
  const eth = await publicClient.getBalance({ address: trade.ownerAddress });
  if (eth > 1_000_000_000_000n) {
    left.push({ token: 'ETH', symbol: 'ETH', amount: eth.toString(), reason: 'Kept for gas. Native ETH is not shielded.' });
  }

  const done: HyperliquidAccountView = {
    ...view,
    status: 'done',
    step: undefined,
    shielded,
    left,
    error: undefined,
    detail: shielded.length > 0 ? 'Shielded back into Railgun. This address is not reused.' : 'Nothing was left to shield. This address is not reused.',
  };
  await remember(trade, done);
  await endVenue('hyperliquid');
  return done;
}

/* ---------------------------------------------------------------- Helpers */

async function requireTrade(): Promise<ActiveTrade> {
  const trade = await getVenueTrade('hyperliquid');
  if (!trade || trade.venue !== 'hyperliquid') throw new Error('No Hyperliquid address is open.');
  return trade;
}

async function remember(trade: ActiveTrade, view: HyperliquidAccountView): Promise<void> {
  await updateOwnedTrade(trade.ownerIndex, { venue: 'hyperliquid', intentAddress: trade.ownerAddress, hyperliquid: { ...view, ownerAddress: trade.ownerAddress } });
}

async function fail(phase: 'funding' | 'shielding', amountIn: string, error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  const trade = await getVenueTrade('hyperliquid');
  if (trade) {
    await remember(trade, {
      ...(trade.hyperliquid ?? { amountIn, detail: message }),
      status: 'failed',
      failedIn: phase,
      amountIn,
      detail: message,
      error: message,
      unshieldTx: trade.hyperliquid?.unshieldTx ?? trade.withdrawal?.txHash,
    }).catch(() => undefined);
  }
  throw error instanceof Error ? error : new Error(message);
}

/** Bridge2 is Pausable. A failed read does not block: the site's own Deposit button does not check either. */
async function bridgePaused(): Promise<boolean> {
  try {
    return await publicClient.readContract({
      address: HYPERLIQUID_BRIDGE,
      abi: [{ type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }] as const,
      functionName: 'paused',
    });
  } catch {
    return false;
  }
}

function usdcOn(owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
