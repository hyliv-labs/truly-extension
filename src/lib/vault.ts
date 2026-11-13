/**
 * Vault: the sealed seed on disk, the unlocked seed in session memory.
 *
 * chrome.storage.local  — the sealed box and the owner index (survive restart).
 * chrome.storage.session — the plaintext mnemonic while unlocked. Never written
 *   to disk and cleared when the browser exits. This is not a style choice: the
 *   MV3 service worker is torn down after ~30s idle, so a module-level variable
 *   would drop the unlock mid-trade.
 */

import { open, seal, type SealedBox } from './crypto';
import { deriveFundingWallet, deriveOwner, isValidMnemonic, newMnemonic, type OwnerKey } from './keys';

const LOCAL_VAULT = 'truly:vault';
const LOCAL_OWNER_INDEX = 'truly:ownerIndex';
const SESSION_MNEMONIC = 'truly:mnemonic';

export async function hasVault(): Promise<boolean> {
  const stored = await chrome.storage.local.get(LOCAL_VAULT);
  return Boolean(stored[LOCAL_VAULT]);
}

export async function isUnlocked(): Promise<boolean> {
  const stored = await chrome.storage.session.get(SESSION_MNEMONIC);
  return typeof stored[SESSION_MNEMONIC] === 'string';
}

/**
 * Create a vault, or restore one from an existing phrase. Refuses to clobber
 * an existing vault — overwriting would strand every owner address under the
 * old seed, and with them any funds still in flight.
 */
export async function createVault(
  password: string,
  mnemonic?: string,
): Promise<{ mnemonic: string }> {
  if (await hasVault()) {
    throw new Error('a vault already exists; lock and unlock it instead');
  }

  // Enforced here, not only in the onboarding form: every path that creates a
  // vault (recovery, signature import) seals it with this password.
  if (password.length < 8) throw new Error('Use a password of at least 8 characters.');
  const phrase = mnemonic?.trim() ?? newMnemonic();
  if (!isValidMnemonic(phrase)) {
    throw new Error('invalid recovery phrase');
  }

  const box = await seal(phrase, password);
  await chrome.storage.local.set({
    [LOCAL_VAULT]: box,
    // A restored seed may already have used indexes; the recovery scan in E8
    // moves this forward before any trade starts.
    [LOCAL_OWNER_INDEX]: 0,
  });
  await chrome.storage.session.set({ [SESSION_MNEMONIC]: phrase });

  return { mnemonic: phrase };
}

export async function unlock(password: string): Promise<void> {
  const stored = await chrome.storage.local.get(LOCAL_VAULT);
  const box = stored[LOCAL_VAULT] as SealedBox | undefined;
  if (!box) throw new Error('no vault to unlock');

  // Throws 'incorrect password' on a bad password.
  const phrase = await open(box, password);
  await chrome.storage.session.set({ [SESSION_MNEMONIC]: phrase });
}

export async function lock(): Promise<void> {
  await chrome.storage.session.remove(SESSION_MNEMONIC);
}

/**
 * The unlocked phrase. Exported for note derivation, which needs the seed
 * itself rather than a derived key — the Privacy Pools SDK takes a mnemonic.
 */
export async function requireUnlockedMnemonic(): Promise<string> {
  return requireMnemonic();
}

async function requireMnemonic(): Promise<string> {
  const stored = await chrome.storage.session.get(SESSION_MNEMONIC);
  const phrase = stored[SESSION_MNEMONIC];
  if (typeof phrase !== 'string') throw new Error('locked');
  return phrase;
}

export async function getOwnerIndex(): Promise<number> {
  const stored = await chrome.storage.local.get(LOCAL_OWNER_INDEX);
  const index = stored[LOCAL_OWNER_INDEX];
  return typeof index === 'number' ? index : 0;
}

/** The owner for the current trade. */
export async function currentOwner(): Promise<OwnerKey> {
  return ownerAt(await getOwnerIndex());
}

/**
 * The owner at a specific index. A trade pins its index at the start and signs
 * against that, so a concurrent retirement can never redirect a signature to a
 * different address.
 */
export async function ownerAt(index: number): Promise<OwnerKey> {
  return deriveOwner(await requireMnemonic(), index);
}

/** Public USDC for Add funds. Stable for this vault, and never a trade owner. */
export async function fundingWallet(): Promise<{ address: OwnerKey['address']; privateKey: OwnerKey['privateKey'] }> {
  return deriveFundingWallet(await requireMnemonic());
}

/**
 * Burn the current index so the next trade gets a fresh address. This is the
 * ONLY place the index moves, and it deliberately needs no mnemonic: retiring
 * must succeed even when the vault has auto-locked mid-trade, or a locked
 * wallet would silently reissue the same owner to the next trade.
 */
export async function retireOwner(usedIndex: number): Promise<void> {
  const current = await getOwnerIndex();
  // Monotonic: never move backwards, even if called twice or out of order.
  const next = Math.max(current, usedIndex + 1);
  await chrome.storage.local.set({ [LOCAL_OWNER_INDEX]: next });
}
