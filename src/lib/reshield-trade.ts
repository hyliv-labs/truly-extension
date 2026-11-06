/**
 * The re-shield step of a trade, with deposit-index bookkeeping.
 *
 * Separated from reshield.ts so that module stays a pure "send this user
 * operation" and this one owns the part where getting it wrong loses money
 * quietly: which index the note is derived at, and when that index is burned.
 */

import type { Hash } from '@0xbow/privacy-pools-core-sdk';
import type { Hex } from 'viem';
import { PRIVACY_POOL_SCOPE } from './config';
import { confirmDepositIndex, deriveNote, nextDepositIndex } from './notes';
import { readUserOperationReceipt, reshield, ReshieldUnavailable } from './reshield';
import {
  clearPendingReshield,
  discardReshield,
  getActiveTrade,
  updateActiveTrade,
  type ActiveTrade,
} from './trade';
import { ownerAt } from './vault';

/**
 * Set for the life of one attempt in this worker. A second click while the
 * proof and the bundler call are still running must not start another deposit.
 * The flag dies with the worker, which is what we want: a dead attempt that
 * never received a hash is safe to repeat.
 */
let reshieldRunning = false;

export interface ReshieldTradeResult {
  readonly userOpHash: string;
  readonly deposited: bigint;
  readonly depositIndex: number;
}

/** Recorded on the trade once the deposit is confirmed on chain. */
export interface ReshieldRecord {
  readonly userOpHash: string;
  readonly depositIndex: number;
  readonly deposited: string;
  readonly confirmedAt: number;
}

/**
 * Re-shield the active trade's remaining USDC into Privacy Pools.
 *
 * The index is taken but NOT burned up front. It is confirmed only once the
 * bundler accepts the operation, because:
 *
 *  - burning on a failed attempt leaves a hole, and ten holes make every later
 *    deposit invisible to the SDK's scan
 *  - not burning a confirmed one lets the next trade reuse the precommitment,
 *    and the SDK keeps only the earliest deposit per precommitment and drops
 *    the rest
 *
 * Neither failure reports itself at the time, which is why the ordering here
 * is deliberate rather than incidental.
 */
export async function reshieldActiveTrade(): Promise<ReshieldTradeResult> {
  if (!PRIVACY_POOL_SCOPE) {
    throw new ReshieldUnavailable(
      'No Privacy Pools scope configured. Notes derived with the wrong scope belong to a pool the funds are not in, so this refuses rather than guessing.',
    );
  }

  const trade = await getActiveTrade();
  if (!trade) throw new ReshieldUnavailable('No active trade to re-shield.');

  if (trade.reshield?.status === 'confirmed') {
    throw new ReshieldUnavailable('This trade is already back in the pool.');
  }

  // A hash means the bundler already accepted an operation. Checking the
  // receipt is the whole of a retry — sending another would deposit twice.
  if (trade.reshield?.status === 'pending' && trade.reshield.userOpHash) {
    return finishSubmittedReshield(trade);
  }

  if (reshieldRunning) {
    throw new ReshieldUnavailable(
      'A re-shield is already in progress. Wait for it to finish before trying again.',
    );
  }
  reshieldRunning = true;

  try {
    return await beginReshield(trade);
  } finally {
    reshieldRunning = false;
  }
}

/** A new deposit. Only called when nothing has been submitted for this trade. */
async function beginReshield(trade: ActiveTrade): Promise<ReshieldTradeResult> {
  if (trade.reshield?.status === 'pending') {
    await clearPendingReshield();
  }

  // Derived from the vault, never from the owner address — that is what lets
  // the next trade find money this one sent from a single-use address.
  if (!PRIVACY_POOL_SCOPE) {
    throw new ReshieldUnavailable('No Privacy Pools scope configured.');
  }
  const scope = BigInt(PRIVACY_POOL_SCOPE) as unknown as Hash;
  const depositIndex = await nextDepositIndex();
  const owner = await ownerAt(trade.ownerIndex);
  const { precommitment } = await deriveNoteForVault(scope, depositIndex);

  await updateActiveTrade({
    reshield: {
      status: 'pending',
      userOpHash: '',
      depositIndex,
      deposited: '0',
      confirmedAt: 0,
    },
  });

  try {
    const result = await reshield({
      privateKey: owner.privateKey,
      precommitment: precommitment as unknown as bigint,
      onSubmitted: async ({ userOpHash, deposited }) => {
        await updateActiveTrade({
          reshield: {
            status: 'pending',
            userOpHash,
            depositIndex,
            deposited: deposited.toString(),
            confirmedAt: 0,
          },
        });
      },
    });

    if (!result.success) {
      // Included but reverted: nothing was deposited, so the index stays
      // reusable and the trade stays open for a retry. The hash is set, so
      // the "never submitted" clear would leave this record in place.
      await discardReshield();
      throw new ReshieldUnavailable(
        `The re-shield operation reverted on chain (${result.userOpHash}).`,
      );
    }

    return commitReshield(depositIndex, result.userOpHash, result.deposited);
  } catch (error) {
    const current = await getActiveTrade();
    // No hash means the bundler never accepted it. Keep the button usable.
    // A hash means it might still land, so the pending record stays.
    if (current?.reshield?.status === 'pending' && !current.reshield.userOpHash) {
      await clearPendingReshield();
    }
    throw error;
  }
}

/** The bundler already has this operation. Record it once the receipt says so. */
async function finishSubmittedReshield(trade: ActiveTrade): Promise<ReshieldTradeResult> {
  const record = trade.reshield;
  if (!record?.userOpHash) {
    throw new ReshieldUnavailable('No re-shield operation to check.');
  }

  const outcome = await readUserOperationReceipt(record.userOpHash as Hex);
  if (outcome === 'pending') {
    throw new ReshieldUnavailable(
      'Re-shield submitted; still waiting for the bundler to include it. Check again in a minute — it will not send a second deposit.',
    );
  }
  if (outcome === 'reverted') {
    await discardReshield();
    throw new ReshieldUnavailable(
      'The re-shield operation reverted on chain. You can try again.',
    );
  }

  return commitReshield(record.depositIndex, record.userOpHash, BigInt(record.deposited));
}

/**
 * Only now is the index spent, and only now is the trade recorded as
 * re-shielded. Both follow on-chain confirmation rather than bundler
 * acceptance, because a reverted operation deposited nothing.
 */
async function commitReshield(
  depositIndex: number,
  userOpHash: string,
  deposited: bigint,
): Promise<ReshieldTradeResult> {
  await confirmDepositIndex(depositIndex);
  await updateActiveTrade({
    reshield: {
      status: 'confirmed',
      userOpHash,
      depositIndex,
      deposited: deposited.toString(),
      confirmedAt: Date.now(),
    },
  });
  return { userOpHash, deposited, depositIndex };
}

/** Note derivation needs the unlocked phrase, which only the vault holds. */
async function deriveNoteForVault(scope: Hash, index: number) {
  const { requireUnlockedMnemonic } = await import('./vault');
  return deriveNote(await requireUnlockedMnemonic(), scope, index);
}
