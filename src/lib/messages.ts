/** Typed popup <-> background protocol. Key material never crosses this line. */

import type { Address } from 'viem';

export type Request =
  | { kind: 'status' }
  | { kind: 'createVault'; password: string; mnemonic?: string }
  | { kind: 'unlock'; password: string }
  | { kind: 'lock' }
  | { kind: 'currentOwner' };

export interface VaultStatus {
  hasVault: boolean;
  unlocked: boolean;
  ownerIndex: number;
}

export type Response<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ResultMap {
  status: VaultStatus;
  createVault: { mnemonic: string };
  unlock: null;
  lock: null;
  /** Address only — the private key stays in the worker. */
  currentOwner: { index: number; address: Address };
}

export async function send<K extends Request['kind']>(
  request: Extract<Request, { kind: K }>,
): Promise<ResultMap[K]> {
  const response: Response<ResultMap[K]> = await chrome.runtime.sendMessage(request);
  if (!response?.ok) throw new Error(response?.error ?? 'no response');
  return response.value;
}
