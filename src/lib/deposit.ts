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
  const complete = isDepositComplete(status);

  // The account only exists once the first deposit is credited.
  const accountIndex = complete ? await getAccountIndex(trade.ownerAddress) : null;

  await updateActiveTrade({
    deposit: {
      status: status.status,
      description: status.description,
      checkedAt: Date.now(),
    },
    ...(accountIndex !== null ? { accountIndex } : {}),
  });

  return {
    complete,
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
