/**
 * The re-shield step of a trade, with deposit-index bookkeeping.
 *
 * Separated from reshield.ts so that module stays a pure "send this user
 * operation" and this one owns the part where getting it wrong loses money
 * quietly: which index the note is derived at, and when that index is burned.
 */

import type { Hash } from '@0xbow/privacy-pools-core-sdk';
import { PRIVACY_POOL_SCOPE } from './config';
import { confirmDepositIndex, deriveNote, nextDepositIndex } from './notes';
import { reshield, ReshieldUnavailable } from './reshield';
import { getActiveTrade, updateActiveTrade } from './trade';
import { ownerAt } from './vault';

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

  // Derived from the vault, never from the owner address — that is what lets
  // the next trade find money this one sent from a single-use address.
  const scope = BigInt(PRIVACY_POOL_SCOPE) as unknown as Hash;
  const depositIndex = await nextDepositIndex();
  const owner = await ownerAt(trade.ownerIndex);
  const { precommitment } = await deriveNoteForVault(scope, depositIndex);

  const result = await reshield({
    privateKey: owner.privateKey,
    precommitment: precommitment as unknown as bigint,
  });

  if (!result.success) {
    // Included but reverted: nothing was deposited, so the index stays
    // reusable and the trade stays open for a retry.
    throw new ReshieldUnavailable(
      `The re-shield operation reverted on chain (${result.userOpHash}).`,
    );
  }

  // Only now is the index spent, and only now is the trade recorded as
  // re-shielded. Both follow on-chain confirmation rather than bundler
  // acceptance, because a reverted operation deposited nothing.
  await confirmDepositIndex(depositIndex);
  await updateActiveTrade({
    reshield: {
      userOpHash: result.userOpHash,
      depositIndex,
      deposited: result.deposited.toString(),
      confirmedAt: Date.now(),
    },
  });

  return { ...result, depositIndex };
}

/** Note derivation needs the unlocked phrase, which only the vault holds. */
async function deriveNoteForVault(scope: Hash, index: number) {
  const { requireUnlockedMnemonic } = await import('./vault');
  return deriveNote(await requireUnlockedMnemonic(), scope, index);
}
