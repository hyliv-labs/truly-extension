/**
 * E8: the trade state machine.
 *
 * The machine exists for one reason: a trade spans ~20 minutes of waiting, a
 * browser that may be closed at any point, and a service worker Chrome tears
 * down every 30 seconds. Progress therefore cannot live in memory — the state
 * IS the saved record, and every step is derived from it.
 *
 * The ordering rule throughout: persist the fact that something irreversible
 * is about to happen BEFORE doing it. Repeating a step must be harmless;
 * forgetting one must be impossible.
 */

import type { ActiveTrade } from './trade';
import { getActiveTrade, updateActiveTrade } from './trade';
import { adviseExit, isExitComplete, readAccount, type ExitAdvice } from './exit';
import { ownerUsdcBalance } from './reshield';

export type TradePhase =
  | 'funding'
  | 'unshielding'
  | 'waiting-for-deposit'
  | 'trading'
  | 'exiting'
  | 'withdrawn'
  | 'reshielded';

export interface TradeStatus {
  readonly phase: TradePhase;
  /** One line for the popup; the plan requires the wait to be visible. */
  readonly detail: string;
  readonly advice?: ExitAdvice;
  readonly ownerBalance?: bigint;
}

/**
 * Work out where the trade actually is.
 *
 * Derived from observable state — Lighter's account, the owner's balance —
 * rather than from a stored step counter. A counter and reality drift apart
 * exactly when it matters: after a crash, mid-withdrawal.
 */
export async function getTradeStatus(): Promise<TradeStatus | null> {
  const trade = await getActiveTrade();
  if (!trade) return null;

  if (!trade.intentAddress) {
    return { phase: 'funding', detail: 'Getting a deposit address from Lighter.' };
  }

  // The intent address exists but nothing has been pulled from the pool yet.
  // Derived from the stored record rather than from a balance: the intent
  // address shows nothing until Lighter sweeps it, so a balance check cannot
  // tell "not funded" from "funded and already swept".
  if (!trade.withdrawal) {
    return {
      phase: 'unshielding',
      detail: 'Ready to fund this trade from Privacy Pools.',
    };
  }

  if (trade.accountIndex === undefined) {
    return {
      phase: 'waiting-for-deposit',
      detail:
        trade.deposit?.description ??
        'Funded from the pool. Waiting for Lighter to credit the deposit, which usually takes 15-20 minutes.',
    };
  }

  // The account exists, so the money arrived. From here the question is only
  // whether it has left again.
  const snapshot = await readAccount(trade.ownerAddress);
  const advice = adviseExit(snapshot);

  if (!isExitComplete(advice)) {
    return {
      phase: advice.kind === 'has-positions' ? 'trading' : 'exiting',
      detail: describe(advice),
      advice,
    };
  }

  const ownerBalance = await ownerUsdcBalance(trade.ownerAddress);

  // Only a confirmed receipt proves the funds went back to the pool. Inferring
  // it from "Lighter is empty and the owner is empty" cannot distinguish a
  // completed re-shield from a withdrawal still in flight — Lighter zeroes the
  // moment the withdrawal is requested, before the USDC lands.
  if (trade.reshield) {
    return {
      phase: 'reshielded',
      detail: 'Everything is back in the pool. This trade can be retired.',
      advice,
      ownerBalance,
    };
  }

  if (ownerBalance > 0n) {
    return {
      phase: 'withdrawn',
      detail: 'Funds are at the owner address, ready to re-shield.',
      advice,
      ownerBalance,
    };
  }

  return {
    phase: 'exiting',
    detail:
      'Lighter is empty but nothing has reached the owner address yet. A fast withdrawal takes a few minutes.',
    advice,
    ownerBalance,
  };
}

function describe(advice: ExitAdvice): string {
  switch (advice.kind) {
    case 'not-funded':
      return 'Lighter has not credited the deposit yet.';
    case 'has-positions':
      return `Position open on Lighter. Close it there to end the trade.`;
    case 'withdraw-fast':
      // Truly cannot see resting orders, so it says so rather than implying
      // the account is clear.
      return `Withdraw the full ${advice.balance} USDC on Lighter (fast withdrawal). Cancel any resting orders there first — Truly cannot see them.`;
    case 'withdraw-secure':
      return advice.reason;
    case 'dust':
      return `Only ${advice.balance} USDC left — writing it off as dust.`;
    case 'empty':
      return 'Lighter account is empty.';
  }
}

/**
 * Is the trade finished enough to retire?
 *
 * Deliberately strict: retiring burns the owner index, and an index burned
 * while funds remain at that address makes them harder to find later. The
 * recovery scan would still reach them, but only because it exists.
 */
export async function canRetire(): Promise<{ ok: boolean; reason?: string }> {
  return decideRetirable(await getTradeStatus());
}

/**
 * The retirement rule itself, separated from reading the world so it can be
 * tested without Lighter or a chain.
 */
export function decideRetirable(
  status: TradeStatus | null,
): { ok: boolean; reason?: string } {
  if (!status) return { ok: false, reason: 'No active trade.' };

  if (status.phase !== 'reshielded') {
    return { ok: false, reason: status.detail };
  }

  // A successful re-shield leaves the unspent part of the 1 USDC gas permit
  // behind, so the owner is never exactly empty. Requiring zero would make
  // every trade permanently unretirable.
  if ((status.ownerBalance ?? 0n) > DUST_UNITS) {
    return {
      ok: false,
      reason: `The owner address still holds ${Number(status.ownerBalance) / 1e6} USDC, which is more than leftover gas.`,
    };
  }

  return { ok: true };
}

/**
 * Leftover gas allowance, in USDC units. Above this, something is actually
 * stranded; below it, it is the permit reserve that was never spent.
 */
const DUST_UNITS = 1_000_000n;

/** Record progress for the popup without re-deriving it on every poll. */
export async function recordPhase(phase: TradePhase): Promise<ActiveTrade> {
  return updateActiveTrade({ phase });
}
