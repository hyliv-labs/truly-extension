/**
 * Privacy Pools note derivation and deposit-index allocation.
 *
 * This is what makes "new owner address every trade" compatible with "one
 * vault owns all the money".
 *
 * A deposit's secrets come from `generateDepositSecrets(masterKeys, scope,
 * index)` — master keys, pool scope, index. The DEPOSITOR ADDRESS IS NOT AN
 * INPUT. And the SDK discovers deposits by looking each derived precommitment
 * up in a map keyed by `event.precommitment`, never by who sent the deposit.
 *
 * So a re-shield sent from a brand-new owner address is found and spent by the
 * original vault, exactly as if the vault had deposited it. That is the whole
 * trick, and it holds only while the two rules below are respected.
 */

import {
  generateDepositSecrets,
  generateMasterKeys,
  hashPrecommitment,
  type Hash,
} from '@0xbow/privacy-pools-core-sdk';

const LOCAL_DEPOSIT_INDEX = 'truly:depositIndex';

/**
 * The SDK stops scanning after this many consecutive indices with no matching
 * deposit (`MAX_CONSECUTIVE_MISSES = 10`). Indices must therefore stay DENSE:
 * leave a gap of 10 and every later deposit becomes invisible — the money is
 * still on chain, but the vault can no longer find or spend it.
 */
export const MAX_INDEX_GAP = 10;

export interface DepositNote {
  readonly index: number;
  readonly precommitment: Hash;
}

/**
 * Derive the note for a given deposit index.
 *
 * `scope` identifies the pool. The same (mnemonic, scope, index) always gives
 * the same precommitment, which is precisely why the vault can recognise a
 * deposit it did not send.
 */
export function deriveNote(
  mnemonic: string,
  scope: Hash,
  index: number,
): DepositNote {
  const keys = generateMasterKeys(mnemonic);
  const { nullifier, secret } = generateDepositSecrets(keys, scope, BigInt(index));
  return { index, precommitment: hashPrecommitment(nullifier, secret) };
}

export async function getDepositIndex(): Promise<number> {
  const stored = await chrome.storage.local.get(LOCAL_DEPOSIT_INDEX);
  const index = stored[LOCAL_DEPOSIT_INDEX];
  return typeof index === 'number' ? index : 0;
}

/**
 * The index the next deposit should use.
 *
 * Deliberately NOT advanced here. A failed deposit must reuse the same index:
 * nothing with that precommitment reached the chain, so reusing it leaves no
 * gap. Advancing on attempt instead of on success would punch a hole in the
 * sequence for every relayer hiccup, and ten of those make everything after
 * them unspendable.
 */
export async function nextDepositIndex(): Promise<number> {
  return getDepositIndex();
}

/**
 * Record that a deposit at `index` is confirmed on chain.
 *
 * Only called once the deposit is known to have landed. Reusing a confirmed
 * index would be worse than leaving a gap: the SDK keeps only the EARLIEST
 * deposit per precommitment and drops the rest, and a single withdrawal then
 * matches every colliding account, producing negative-value commitments. The
 * duplicate's funds are simply lost.
 */
export async function confirmDepositIndex(index: number): Promise<void> {
  const current = await getDepositIndex();
  // Monotonic, so a late or repeated confirmation cannot move it backwards.
  await chrome.storage.local.set({
    [LOCAL_DEPOSIT_INDEX]: Math.max(current, index + 1),
  });
}
