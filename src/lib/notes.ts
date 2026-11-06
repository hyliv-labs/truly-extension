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
  generateWithdrawalSecrets,
  hashPrecommitment,
  type Hash,
} from '@0xbow/privacy-pools-core-sdk';

const LOCAL_DEPOSIT_INDEX = 'truly:depositIndex';
const LOCAL_WITHDRAWAL_INDEX = 'truly:withdrawalIndex';

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

/* ------------------------------------------------------------------------ *
 * Withdrawal indices.
 *
 * A partial withdrawal spends a note and writes a CHANGE note under the same
 * label, with secrets from `generateWithdrawalSecrets(keys, label, index)`.
 * That index is per-LABEL, not global, and carries the same hazard as the
 * deposit index in a nastier form:
 *
 *  - Reuse an index already spent under that label and the change note gets a
 *    nullifier that is already in the pool's spent set. The withdrawal that
 *    tries to spend it reverts, permanently, and those funds are unreachable.
 *  - Advance on ATTEMPT rather than on success and a failed withdrawal burns
 *    an index. Unlike deposits there is no density requirement here — the SDK
 *    walks a label's withdrawals from its own event history — but a burned
 *    index still desynchronises the stored counter from the chain.
 *
 * So: allocate without advancing, and advance only once the chain confirms.
 * ------------------------------------------------------------------------ */

type WithdrawalIndexMap = Record<string, number>;

/** Labels are bigints; storage keys must be strings. One place to convert. */
const labelKey = (label: bigint): string => label.toString();

async function readWithdrawalIndices(): Promise<WithdrawalIndexMap> {
  const stored = await chrome.storage.local.get(LOCAL_WITHDRAWAL_INDEX);
  const map = stored[LOCAL_WITHDRAWAL_INDEX];
  return map && typeof map === 'object' ? (map as WithdrawalIndexMap) : {};
}

/** How many withdrawals this label has already confirmed. */
export async function getWithdrawalIndex(label: bigint): Promise<number> {
  const indices = await readWithdrawalIndices();
  const index = indices[labelKey(label)];
  return typeof index === 'number' ? index : 0;
}

/**
 * The index the next withdrawal under `label` should use.
 *
 * Deliberately NOT advanced, for the same reason as `nextDepositIndex`: a
 * withdrawal that never lands has consumed nothing.
 */
export async function nextWithdrawalIndex(label: bigint): Promise<number> {
  return getWithdrawalIndex(label);
}

/**
 * Record that a withdrawal at `index` under `label` is confirmed on chain.
 *
 * Monotonic per label, so a late or duplicated confirmation cannot move the
 * counter backwards and hand the next withdrawal an index already spent.
 */
export async function confirmWithdrawalIndex(label: bigint, index: number): Promise<void> {
  const indices = await readWithdrawalIndices();
  const key = labelKey(label);
  const current = indices[key] ?? 0;
  await chrome.storage.local.set({
    [LOCAL_WITHDRAWAL_INDEX]: { ...indices, [key]: Math.max(current, index + 1) },
  });
}

export interface ChangeNoteSecrets {
  readonly index: number;
  readonly nullifier: Hash;
  readonly secret: Hash;
}

/**
 * Derive the change-note secrets for a withdrawal under `label`.
 *
 * The label is inherited from the original deposit, which is why the change
 * note needs no new ASP approval — see docs/e3-validation.md.
 */
export function deriveChangeNote(
  mnemonic: string,
  label: bigint,
  index: number,
): ChangeNoteSecrets {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Withdrawal index must be a non-negative integer, got ${index}`);
  }
  const keys = generateMasterKeys(mnemonic);
  const { nullifier, secret } = generateWithdrawalSecrets(
    keys,
    label as unknown as Hash,
    BigInt(index),
  );
  return { index, nullifier: nullifier as unknown as Hash, secret: secret as unknown as Hash };
}
