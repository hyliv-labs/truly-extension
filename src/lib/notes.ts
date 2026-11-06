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
 *
 * THE INDEX IS NOT OURS TO CHOOSE. The SDK derives it from chain history —
 * `index = BigInt(account.children.length)` — in BOTH places that matter:
 *
 *   createWithdrawalSecrets()  when building the next withdrawal
 *   the `Withdrawn` event replay  when reconstructing an account from a seed
 *
 * So the chain decides, and a local counter is a SECOND source of truth that
 * can only drift. The drift is silent and it strands funds:
 *
 *   After MetaMask recovery, or a reinstall, local storage is empty and reads
 *   0. A label with two prior withdrawals would then reuse index 0 — whose
 *   nullifier is already in the pool's spent set. The withdrawal that tries to
 *   spend that change note reverts permanently, and a later rescan
 *   reconstructs different secrets than the ones we used. Nothing errors when
 *   the duplicate is created.
 *
 * The counter is therefore kept only as a FLOOR, to catch the opposite
 * failure: a scan that has not yet seen withdrawals we know confirmed. If the
 * floor exceeds what the scan reports, the scan is stale and we must refuse
 * rather than derive against a count we know is too low.
 * ------------------------------------------------------------------------ */

type WithdrawalIndexMap = Record<string, number>;

/** Labels are bigints; storage keys must be strings. One place to convert. */
const labelKey = (label: bigint): string => label.toString();

async function readWithdrawalIndices(): Promise<WithdrawalIndexMap> {
  const stored = await chrome.storage.local.get(LOCAL_WITHDRAWAL_INDEX);
  const map = stored[LOCAL_WITHDRAWAL_INDEX];
  return map && typeof map === 'object' ? (map as WithdrawalIndexMap) : {};
}

/**
 * How many withdrawals under this label we have seen confirmed LOCALLY.
 *
 * A floor, not an answer. It is 0 on a freshly recovered vault even when the
 * chain has many — which is exactly why it must never be used as the index.
 */
export async function getWithdrawalFloor(label: bigint): Promise<number> {
  const indices = await readWithdrawalIndices();
  const index = indices[labelKey(label)];
  return typeof index === 'number' ? index : 0;
}

export class StaleScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleScanError';
  }
}

/**
 * The index the next withdrawal under `label` must use.
 *
 * `childrenCount` comes from the SDK's account for this label — the number of
 * change notes already on chain. That is the authority, because it is what the
 * SDK itself will derive when it replays the pool's `Withdrawn` events.
 *
 * Throws if our local floor is higher: that means we confirmed a withdrawal
 * the scan has not caught up with, and deriving against the lower count would
 * reuse an index whose nullifier is already spent.
 */
export async function nextWithdrawalIndex(
  label: bigint,
  childrenCount: number,
): Promise<number> {
  if (!Number.isInteger(childrenCount) || childrenCount < 0) {
    throw new Error(`childrenCount must be a non-negative integer, got ${childrenCount}`);
  }
  const floor = await getWithdrawalFloor(label);
  if (floor > childrenCount) {
    throw new StaleScanError(
      `Label ${label}: ${floor} withdrawals are recorded locally but the scan found ${childrenCount}. ` +
        'Deriving against the scan would reuse a spent nullifier and strand the change note. Rescan before withdrawing.',
    );
  }
  return childrenCount;
}

/**
 * Record that a withdrawal at `index` under `label` is confirmed on chain.
 *
 * Raises the local floor only. Monotonic, so a late or duplicated
 * confirmation cannot lower it and let a stale scan pass the check above.
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
