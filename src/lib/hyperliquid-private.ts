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
  withdrawnSince,
  withdrawalArrived,
  withdrawTypedData,
  type HyperliquidAccountView,
  type HyperliquidTokenLine,
} from './hyperliquid';
import { postHyperliquid, readHyperliquid, readLedger } from './hyperliquid-api';
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
/** Below this the paymaster's 1 USDC permit ceiling would eat it; it is reported as left instead. */
const MIN_SHIELD_UNITS = 1_000_000n;

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
  // Once Hyperliquid credited the deposit, or Bring back started, funding is
  // over for this address. Running it again could sign a second deposit.
  if (before && (before.creditedAt || before.withdrawal || before.failedIn === 'shielding')) {
    throw new Error('This Hyperliquid address is already funded. Bring it back, or abandon it.');
  }
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
  // A recorded transfer is never signed again, even with its bytes gone: wait on that hash.
  if (!raw && hash) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error('The transfer to Hyperliquid’s bridge reverted. The USDC is still on the address. Abandon this address and scan old addresses to recover it.');
    return;
  }
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
        creditedAt: Date.now(),
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
  // Until Hyperliquid has shown the deposit, it may still be crediting: an
  // empty account then means "not yet", and retiring would lose the credit.
  if (!view.creditedAt) {
    throw new Error('Hyperliquid has not credited the deposit yet. Go ghost keeps checking; bring it back after that. Nothing was moved.');
  }
  const amountIn = view.amountIn;
  try {
    // A shield already sent (or this round's USDC already gone to Railgun)
    // means the arrival check can never pass again: go straight to settling it.
    if (!trade.reshield && view.step !== 'shielding') {
      if (!view.withdrawal) await startWithdrawal(trade);
      else if (!view.withdrawal.acceptedAt) await sendWithdrawal(trade);
      const arrived = await waitForArrival();
      if (!arrived) return (await requireTrade()).hyperliquid!;
    }
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
    // Nothing worth the fee is left on Hyperliquid. Either the user already
    // withdrew from Hyperliquid's own site (to this same address, still
    // arriving), or the account is empty. The ledger says which; without it
    // nothing is retired, because USDC landing on a retired address is lost track of.
    // Only this round: an earlier round's withdrawals were already shielded.
    const since = Math.max(trade.startedAt, view.roundStartedAt ?? 0);
    const withdrawn = withdrawnSince(await readLedger(trade.ownerAddress, since));
    const latest = await requireTrade();
    await remember(latest, {
      ...latest.hyperliquid!,
      // Waits for every withdrawal already made to land: arrival is amount minus the fee.
      withdrawal: {
        nonce: 0,
        amount: usdcDecimalFromUnits(withdrawn > 0n ? withdrawn + HYPERLIQUID_WITHDRAW_FEE_UNITS : 0n),
        arbitrumBefore: '0',
        acceptedAt: Date.now(),
      },
      step: withdrawn > 0n ? 'arriving' : 'shielding',
      detail:
        withdrawn > 0n
          ? `You already withdrew ${usdcDecimalFromUnits(withdrawn)} USDC on Hyperliquid. Waiting for it on Arbitrum, then shielding it.`
          : 'Nothing is left on Hyperliquid and nothing was withdrawn from it. Shielding whatever is on the address.',
    });
    return;
  }

  try {
    await signAndSend(trade, account.withdrawable);
  } catch (error) {
    // If Hyperliquid charges the 1 USDC on top of the amount, the whole
    // balance is refused as too much. Nothing was withdrawn; ask for 1 less, once.
    if (!(error instanceof WithdrawRefused) || !/insufficient|not enough|exceed|too (large|much)/i.test(error.reason)) throw error;
    if (account.withdrawable - HYPERLIQUID_WITHDRAW_FEE_UNITS <= HYPERLIQUID_WITHDRAW_FEE_UNITS) throw error;
    await signAndSend(await requireTrade(), account.withdrawable - HYPERLIQUID_WITHDRAW_FEE_UNITS);
  }
}

async function signAndSend(trade: ActiveTrade, units: bigint): Promise<void> {
  const amount = usdcDecimalFromUnits(units);
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

class WithdrawRefused extends Error {
  constructor(readonly reason: string) {
    super(`Hyperliquid refused the withdrawal: ${reason}. Nothing was withdrawn.`);
  }
}

/** Send the saved, signed withdrawal. The same nonce every time, so it can only be processed once. */
async function sendWithdrawal(trade: ActiveTrade): Promise<void> {
  const view = trade.hyperliquid!;
  const saved = view.withdrawal;
  if (!saved?.signature) throw new Error('The withdrawal was not signed. Try again.');
  const action = withdrawAction(trade.ownerAddress, saved.amount, saved.nonce);

  // A lost response is the case to fear: maybe it was processed. The ledger
  // lists every withdrawal; one at or after this nonce's time means it was.
  const ledger = await readLedger(trade.ownerAddress, saved.nonce - 60_000).catch(() => null);
  const already = ledger !== null && withdrawnSince(ledger, saved.nonce - 5_000) > 0n;

  const answer = already ? 'duplicate' : readExchangeAnswer(await postHyperliquid('/exchange', exchangeBody(action, saved.signature)));
  if (typeof answer === 'object') {
    // Hyperliquid refused it outright, so nothing was withdrawn. Forget it, so the next try signs a fresh one.
    await remember(trade, { ...view, withdrawal: undefined, step: 'withdrawing' });
    throw new WithdrawRefused(answer.error);
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
  // A confirmed shield record belongs to this round until its line is saved.
  // Saving the line and clearing the record happen in one write, so a crash
  // between them repeats the same result rather than shielding twice.
  const usdc = await usdcOn(trade.ownerAddress);
  if (trade.reshield?.status === 'confirmed' || usdc >= MIN_SHIELD_UNITS) {
    const result = await shieldOwnerUsdcToRailgun('hyperliquid');
    shielded.push({ token: USDC_ADDRESS, symbol: 'USDC', amount: result.amountUnits.toString(), txHash: result.txHash });
    await updateOwnedTrade(trade.ownerIndex, { reshield: undefined, hyperliquid: { ...view, shielded, ownerAddress: trade.ownerAddress } });
  }

  // Never retire an address that still has money on Hyperliquid: a
  // withdrawal from the site, or one we mistook for ours, would leave it there.
  const account = await readHyperliquid(trade.ownerAddress);
  if (totalUsdc(account) > HYPERLIQUID_WITHDRAW_FEE_UNITS || account.openPositions.length > 0 || account.spotOther.length > 0) {
    const latest = await requireTrade();
    const still: HyperliquidAccountView = {
      ...latest.hyperliquid!,
      status: 'funded',
      step: undefined,
      withdrawal: undefined,
      roundStartedAt: Date.now(),
      shielded,
      error: undefined,
      detail: `${shielded.length > 0 ? 'What arrived is shielded. ' : ''}${usdcDecimalFromUnits(totalUsdc(account) > 0n ? totalUsdc(account) : 0n)} USDC is still on Hyperliquid. Bring it back again to withdraw the rest.`,
    };
    await remember(latest, still);
    return still;
  }

  const left: HyperliquidTokenLine[] = [];
  const after = await usdcOn(trade.ownerAddress);
  if (after > 0n) {
    left.push({ token: USDC_ADDRESS, symbol: 'USDC', amount: after.toString(), reason: 'Too little to shield, or kept to pay the shield’s gas through the paymaster.' });
  }
  const eth = await publicClient.getBalance({ address: trade.ownerAddress });
  if (eth > 1_000_000_000_000n) {
    left.push({ token: 'ETH', symbol: 'ETH', amount: eth.toString(), reason: 'Kept for gas. Native ETH is not shielded.' });
  }

  const latest = await requireTrade();
  const done: HyperliquidAccountView = {
    ...latest.hyperliquid!,
    status: 'done',
    step: undefined,
    shielded,
    left,
    error: undefined,
    detail: shielded.length > 0 ? 'Shielded back into Railgun. This address is not reused.' : 'Nothing was left to shield. This address is not reused.',
  };
  await remember(latest, done);
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
