/** Typed protocol into the background worker. Key material never crosses it. */

import type { Address } from 'viem';
import type { ApprovalRecord } from './approvals';
import type { ActiveTrade } from './trade';

export type Request =
  // Popup
  | { kind: 'status' }
  | { kind: 'createVault'; password: string; mnemonic?: string }
  | { kind: 'unlock'; password: string }
  | { kind: 'lock' }
  | { kind: 'currentOwner' }
  | { kind: 'startTrade' }
  | { kind: 'endTrade' }
  // Content-script relay (E5)
  | { kind: 'provider'; origin: string; method: string; params: unknown[] }
  // Approval window (E5)
  | { kind: 'getApproval'; id: string }
  | { kind: 'settleApproval'; id: string; approved: boolean }
  // Keeps the worker alive while an approval prompt is open (E5).
  | { kind: 'keepAlive' }
  // Anon-RPC (E2)
  | { kind: 'anonRpcStatus' }
  | { kind: 'anonRpcSelfTest' }
  // Lighter bridge (E4)
  | { kind: 'prepareDeposit' }
  | { kind: 'checkDeposit' }
  // Recovering an existing Privacy Pools account (wallet-signature type)
  | { kind: 'seedTypedData'; address: string; version: 'v1' | 'v2' }
  | {
      kind: 'importWalletSeed';
      password: string;
      address: string;
      version: 'v1' | 'v2';
      signature: string;
    };

export interface AnonRpcStatus {
  reads: number;
  /** Non-empty means money-moving steps are blocked; each entry says why. */
  problems: { key: string; reason: string }[];
}

export interface SelfTestResult {
  blockNumber: string;
  usdcBalance: string;
}

export interface VaultStatus {
  hasVault: boolean;
  unlocked: boolean;
  ownerIndex: number;
  activeTrade: ActiveTrade | null;
}

export type Response<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ResultMap {
  status: VaultStatus;
  createVault: { mnemonic: string };
  unlock: null;
  lock: null;
  /** Address only — the private key stays in the worker. */
  currentOwner: { index: number; address: Address };
  startTrade: ActiveTrade;
  endTrade: null;
  provider: unknown;
  getApproval: ApprovalRecord | null;
  settleApproval: null;
  keepAlive: null;
  anonRpcStatus: AnonRpcStatus;
  anonRpcSelfTest: SelfTestResult;
  seedTypedData: { json: string };
  importWalletSeed: { mnemonic: string };
  prepareDeposit: { intentAddress: string };
  checkDeposit: {
    complete: boolean;
    status: string;
    description: string;
    accountIndex: number | null;
  };
}

export async function send<K extends Request['kind']>(
  request: Extract<Request, { kind: K }>,
): Promise<ResultMap[K]> {
  const response: Response<ResultMap[K]> = await chrome.runtime.sendMessage(request);
  if (!response?.ok) throw new Error(response?.error ?? 'no response');
  return response.value;
}
