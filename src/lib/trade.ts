/**
 * Minimal active-trade state.
 *
 * E8 takes ownership of the full state machine; E5 only needs to answer
 * "is a trade active, and which owner is it?" so the provider can refuse
 * everything otherwise. One active trade at a time is the core invariant:
 * two concurrent trades would share a browser session and defeat the point.
 */

import type { Address } from 'viem';
import { currentOwner, retireOwner } from './vault';
import { configProblems } from './config';
import { clearLighterSiteData } from './site-cleanup';
import type { TradeSession } from './session-types';

const LOCAL_ACTIVE_TRADE = 'truly:activeTrade';
const LOCAL_TRADE_HISTORY = 'truly:tradeHistory';
const HISTORY_LIMIT = 50;

export interface ActiveTrade {
  readonly ownerIndex: number;
  readonly ownerAddress: Address;
  readonly startedAt: number;
  /** E4: where the relayer sends the withdrawal. Stable for a given owner. */
  readonly intentAddress?: Address;
  /** E4: assigned by Lighter once the first deposit is credited. */
  readonly accountIndex?: number;
  /**
   * E7/E8: the re-shield back into Privacy Pools.
   *
   * `pending` is written BEFORE the bundler is asked, and again with the
   * user-operation hash the moment it accepts one. A crash in between must
   * not look like "never sent" — that is how a second click would deposit
   * twice. `confirmed` is the only state that makes the trade retirable.
   * Inferring it from balances cannot tell "re-shielded" from "still in flight".
   */
  readonly reshield?: {
    readonly status: 'pending' | 'confirmed';
    readonly userOpHash: string;
    readonly depositIndex: number;
    readonly deposited: string;
    readonly confirmedAt: number;
  };
  /**
   * E3: set once the pool withdrawal is CONFIRMED on chain. Mirrors `reshield`
   * and for the same reason — this record is what makes funding idempotent,
   * and the only thing that distinguishes "funded, waiting for Lighter" from
   * "never funded". Inferring it from balances cannot: the intent address
   * shows nothing until Lighter sweeps it.
   */
  readonly withdrawal?: {
    /**
     * 'pending' is written BEFORE the relayer is asked for a quote, so a
     * crash, a worker teardown or a failed receipt read can never leave a
     * broadcast withdrawal with no record. Without it the phase falls back to
     * 'unshielding', the button goes live again, and a second click sends a
     * second payment to the same intent address — untracked, and linking two
     * pool withdrawals to one Lighter identity.
     */
    readonly status: 'pending' | 'confirmed';
    /** Added the moment the relayer returns, before the receipt is awaited. */
    readonly txHash?: string;
    readonly label: string;
    readonly amount: string;
    /** children.length when this started, so a resume can tell if it landed. */
    readonly childrenCountAtStart: number;
    readonly withdrawalIndex?: number;
    readonly startedAt: number;
    readonly confirmedAt?: number;
  };
  /** E8: last phase recorded, so the popup has something before the first poll. */
  readonly phase?: string;
  /** E4: last status seen, so the popup can show a wait without re-polling. */
  readonly deposit?: {
    readonly status: string;
    readonly description: string;
    readonly checkedAt: number;
    /** Every distinct status seen, so a real run records Lighter's vocabulary. */
    readonly seen?: string[];
  };
  /** The in-extension market trade this owner exists for, when there is one. */
  readonly session?: TradeSession;
}

/**
 * Serialises read-modify-write within this worker. Funding, the session tick
 * and the popup can all write the record; without this, two interleaved
 * writers each spread a stale copy and one silently drops the other's field.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

/** Merge fields into the active trade. Refuses if no trade is active. */
export function updateActiveTrade(
  patch: Partial<Omit<ActiveTrade, 'ownerIndex' | 'ownerAddress' | 'startedAt'>>,
): Promise<ActiveTrade> {
  return serialized(async () => {
    const trade = await getActiveTrade();
    if (!trade) throw new Error('no active trade');

    const next = { ...trade, ...patch };
    await chrome.storage.local.set({ [LOCAL_ACTIVE_TRADE]: next });
    return next;
  });
}

/** Patch the session in place. Refuses if the trade or its session is gone. */
export function updateSession(
  sessionId: string,
  patch: (session: TradeSession) => Partial<TradeSession>,
): Promise<TradeSession> {
  return serialized(async () => {
    const trade = await getActiveTrade();
    if (!trade?.session || trade.session.id !== sessionId) {
      throw new Error('this trade session is no longer active');
    }
    const session: TradeSession = { ...trade.session, ...patch(trade.session), updatedAt: Date.now() };
    await chrome.storage.local.set({ [LOCAL_ACTIVE_TRADE]: { ...trade, session } });
    return session;
  });
}

/** Finished trades, newest first. Kept separate so sessions never mix. */
export async function getTradeHistory(): Promise<ActiveTrade[]> {
  const stored = await chrome.storage.local.get(LOCAL_TRADE_HISTORY);
  return (stored[LOCAL_TRADE_HISTORY] as ActiveTrade[] | undefined) ?? [];
}

async function archive(trade: ActiveTrade): Promise<void> {
  const history = await getTradeHistory();
  await chrome.storage.local.set({
    [LOCAL_TRADE_HISTORY]: [{ ...trade, endedAt: Date.now() }, ...history].slice(0, HISTORY_LIMIT),
  });
}

export async function getActiveTrade(): Promise<ActiveTrade | null> {
  const stored = await chrome.storage.local.get(LOCAL_ACTIVE_TRADE);
  return (stored[LOCAL_ACTIVE_TRADE] as ActiveTrade | undefined) ?? null;
}

/**
 * Mark the current owner as trading. E8 will replace this with the funded
 * lifecycle; for now it exists so E5 can be exercised end to end.
 */
export async function startTrade(): Promise<ActiveTrade> {
  if (await getActiveTrade()) {
    throw new Error('a trade is already active');
  }

  // E2: no money moves while reads cannot be anonymised. Starting a trade is
  // the first step of the money path, so the gate belongs here rather than at
  // each later call — by then an address has already been exposed.
  const problems = configProblems();
  if (problems.length > 0) {
    throw new Error(problems.map((p) => p.reason).join(' '));
  }

  // Before, not only after: after-only trusts that the previous cleanup ran,
  // and the first trade after an install or a crash has no previous at all.
  await clearLighterSiteData();

  const owner = await currentOwner();
  const trade: ActiveTrade = {
    ownerIndex: owner.index,
    ownerAddress: owner.address,
    startedAt: Date.now(),
  };

  await chrome.storage.local.set({ [LOCAL_ACTIVE_TRADE]: trade });
  return trade;
}

/**
 * Drop a re-shield that never reached the bundler, so the button can try
 * again. A pending record that already has a user-operation hash is left
 * alone: that operation may still land, and deleting it invites a second one.
 */
export async function clearPendingReshield(): Promise<void> {
  const trade = await getActiveTrade();
  if (!trade?.reshield || trade.reshield.status !== 'pending') return;
  if (trade.reshield.userOpHash) return;
  await discardReshield();
}

/**
 * Forget a pending re-shield even if the bundler already accepted it.
 * Only for a receipt that says the operation reverted — nothing was deposited,
 * so the deposit index is still free and a retry is the correct next step.
 */
export async function discardReshield(): Promise<void> {
  const trade = await getActiveTrade();
  if (!trade?.reshield || trade.reshield.status === 'confirmed') return;

  const { reshield: _omit, ...rest } = trade;
  await chrome.storage.local.set({ [LOCAL_ACTIVE_TRADE]: rest });
}

/**
 * Retire the trade AND its owner address. The index is burned here rather than
 * at the start of the next trade, so an unfinished trade resumes on the same
 * address while a finished one can never be handed out again.
 */
export async function endTrade(): Promise<void> {
  const trade = await getActiveTrade();
  if (!trade) return;

  // Burn first: if this throws, the trade stays active and retryable. The
  // reverse order could drop the record and leave the index reusable.
  await retireOwner(trade.ownerIndex);
  // Best effort, before the record goes: the history is for the user, and
  // failing to write it must not keep a retired owner active.
  await archive(trade).catch(() => {});
  await chrome.storage.local.remove(LOCAL_ACTIVE_TRADE);

  // Best effort: the trade is already closed and the index burned, so a
  // cleanup failure must not resurrect it. The next startTrade cleans up again.
  await clearLighterSiteData().catch(() => {});
}
