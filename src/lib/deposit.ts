/**
 * E4 step 2-3: get the owner an intent address, then wait for Lighter to
 * credit the deposit.
 *
 * Kept out of trade.ts so startTrade stays network-free and the offline
 * invariant tests still exercise the real module.
 */

import type { Address } from 'viem';
import {
  createIntentAddress,
  getAccountIndex,
  getDepositStatus,
  isDepositComplete,
  isDepositFailed,
} from './lighter';
import { getActiveTrade, updateActiveTrade, type ActiveTrade } from './trade';

/**
 * Allocate the deposit address for the active trade.
 *
 * Idempotent: Lighter returns the same intent address for a given owner, so a
 * resumed trade re-allocates rather than needing the value to have survived.
 */
export async function prepareDeposit(): Promise<Address> {
  const trade = await requireTrade();

  const intentAddress = await createIntentAddress(trade.ownerAddress);

  // Guard against a changed answer: the relayer may already have been pointed
  // at the stored address, and silently moving it would strand the funds.
  if (
    trade.intentAddress &&
    trade.intentAddress.toLowerCase() !== intentAddress.toLowerCase()
  ) {
    throw new Error(
      `Lighter changed the intent address for owner #${trade.ownerIndex}; refusing to continue.`,
    );
  }

  await updateActiveTrade({ intentAddress });
  return intentAddress;
}

export interface DepositProgress {
  readonly complete: boolean;
  readonly failed: boolean;
  readonly status: string;
  readonly description: string;
  readonly accountIndex: number | null;
}

/**
 * One poll of the deposit. The caller drives the schedule — under MV3 that is
 * a chrome.alarms tick, never a setInterval, which would die with the worker.
 */
export async function checkDeposit(): Promise<DepositProgress> {
  const trade = await requireTrade();

  const status = await getDepositStatus(trade.ownerAddress);

  // Asked on EVERY poll, not only when the status string looks terminal.
  // Lighter does not document its status values and only 'pending' has been
  // observed, so an unmatched string must not be able to stall a funded trade.
  // The account not existing is the real "not yet"; the account existing is
  // the real "credited".
  const accountIndex = await getAccountIndex(trade.ownerAddress);

  const complete = accountIndex !== null || isDepositComplete(status);
  const failed = !complete && isDepositFailed(status);

  await updateActiveTrade({
    deposit: {
      status: status.status,
      description: status.description,
      checkedAt: Date.now(),
      // Keeps every distinct status seen, so the first funded run on mainnet
      // records Lighter's real terminal string instead of us guessing again.
      seen: [...new Set([...(trade.deposit?.seen ?? []), status.status])],
    },
    ...(accountIndex !== null ? { accountIndex } : {}),
  });

  return {
    complete,
    failed,
    status: status.status,
    description: status.description,
    accountIndex,
  };
}

async function requireTrade(): Promise<ActiveTrade> {
  const trade = await getActiveTrade();
  if (!trade) throw new Error('no active trade');
  return trade;
}
