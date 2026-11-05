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

  if (trade.accountIndex === undefined) {
    return {
      phase: 'waiting-for-deposit',
      detail:
        trade.deposit?.description ??
        'Waiting for Lighter to credit the deposit. This usually takes 15-20 minutes.',
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

  // Lighter is empty. Either the funds are at the owner address waiting to be
  // re-shielded, or they have already gone back to the pool.
  const ownerBalance = await ownerUsdcBalance(trade.ownerAddress);

  if (ownerBalance > 0n) {
    return {
      phase: 'withdrawn',
      detail: 'Funds are at the owner address, ready to re-shield.',
      advice,
      ownerBalance,
    };
  }

  return {
    phase: 'reshielded',
    detail: 'Everything is back in the pool. This trade can be retired.',
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
      return `Withdraw the full ${advice.balance} USDC on Lighter (fast withdrawal).`;
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
  const status = await getTradeStatus();
  if (!status) return { ok: false, reason: 'No active trade.' };

  if (status.phase !== 'reshielded') {
    return { ok: false, reason: status.detail };
  }
  return { ok: true };
}

/** Record progress for the popup without re-deriving it on every poll. */
export async function recordPhase(phase: TradePhase): Promise<ActiveTrade> {
  return updateActiveTrade({ phase });
}
