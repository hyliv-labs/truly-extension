/**
 * MetaMask recovery, run as a background job.
 *
 * The popup cannot own this: MetaMask's approval window takes focus and the
 * popup closes, which would abandon an in-flight request. So the background
 * starts the job, the offscreen document holds the provider, and the popup
 * only polls a status record.
 *
 * The signature never reaches the popup and is never persisted. It is
 * seed-equivalent — anyone holding it derives the account — so it exists only
 * as a local in this module while the mnemonic is derived.
 */

import type { Address, Hex } from 'viem';
import { recoverTypedDataAddress } from 'viem';
import {
  buildSeedDerivationTypedData,
  deriveMnemonicFromWalletSignature,
  type SeedVersion,
} from './wallet-seed';
import { ensureOffscreenDocument } from './offscreen';
import { createVault, hasVault } from './vault';

const SESSION_RECOVERY = 'truly:recovery';

export type RecoveryState =
  | { phase: 'idle' }
  | { phase: 'waiting'; startedAt: number }
  | { phase: 'done'; address: Address }
  | { phase: 'error'; message: string; reason: string };

export async function getRecoveryState(): Promise<RecoveryState> {
  const stored = await chrome.storage.session.get(SESSION_RECOVERY);
  return (stored[SESSION_RECOVERY] as RecoveryState | undefined) ?? { phase: 'idle' };
}

async function setRecoveryState(state: RecoveryState): Promise<void> {
  await chrome.storage.session.set({ [SESSION_RECOVERY]: state });
}

export async function clearRecoveryState(): Promise<void> {
  await chrome.storage.session.remove(SESSION_RECOVERY);
}

/**
 * Begin recovery. Returns as soon as the request is in flight so the popup is
 * never blocked on MetaMask's UI; progress is read with getRecoveryState.
 */
export async function startMetaMaskRecovery(
  password: string,
  version: SeedVersion,
): Promise<void> {
  if (await hasVault()) {
    throw new Error('A vault already exists on this device.');
  }

  const current = await getRecoveryState();
  if (current.phase === 'waiting') {
    throw new Error('A recovery is already waiting on MetaMask.');
  }

  await setRecoveryState({ phase: 'waiting', startedAt: Date.now() });

  // Deliberately not awaited: the caller returns immediately.
  void runRecovery(password, version);
}

async function runRecovery(password: string, version: SeedVersion): Promise<void> {
  try {
    await ensureOffscreenDocument();

    const response = await chrome.runtime.sendMessage({
      target: 'truly:offscreen',
      kind: 'metamaskSign',
      version,
    });

    if (!response?.ok) {
      await setRecoveryState({
        phase: 'error',
        message: response?.error ?? 'MetaMask recovery failed.',
        reason: response?.reason ?? 'failed',
      });
      return;
    }

    const { address, signature } = response.value as {
      address: Address;
      signature: Hex;
    };

    // Independent verification. We built the payload, but the signature came
    // back through another extension's provider, so the signer is recovered
    // here rather than trusted — and compared against the account MetaMask
    // itself reported.
    const recovered = await recoverTypedDataAddress({
      ...buildSeedDerivationTypedData(address, version),
      signature,
    });

    if (recovered.toLowerCase() !== address.toLowerCase()) {
      await setRecoveryState({
        phase: 'error',
        message: `MetaMask reported ${address} but the signature recovers to ${recovered}.`,
        reason: 'signer-mismatch',
      });
      return;
    }

    // deriveMnemonicFromWalletSignature re-checks length and signer; the
    // duplication is deliberate, since a wrong signature derives a different
    // empty account rather than failing.
    const mnemonic = await deriveMnemonicFromWalletSignature(signature, address, version);

    // Never silently create a new vault: if this throws, recovery fails and
    // the user is told, rather than ending up with an unrelated empty wallet.
    await createVault(password, mnemonic);

    await setRecoveryState({ phase: 'done', address });
  } catch (error) {
    await setRecoveryState({
      phase: 'error',
      message: error instanceof Error ? error.message : String(error),
      reason: (error as { reason?: string })?.reason ?? 'failed',
    });
  }
}
