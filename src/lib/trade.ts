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

const LOCAL_ACTIVE_TRADE = 'truly:activeTrade';

export interface ActiveTrade {
  readonly ownerIndex: number;
  readonly ownerAddress: Address;
  readonly startedAt: number;
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
  await chrome.storage.local.remove(LOCAL_ACTIVE_TRADE);
}
