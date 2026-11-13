/**
 * Ghosty as a NEAR wallet (NEAR Connect injected wallet), worker half. Pure:
 * parses what a site asks for, refuses what Ghosty will not sign, describes
 * it for the approval window, and signs NEP-413 messages.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import type { Action } from '@near-js/transactions';
import { base64, formatNear, nearFunctionCall, nearTransfer } from './near-chain';
import type { NearOwnerKey } from './near-keys';

export const NEAR_WALLET_METHODS = ['near_signIn', 'near_signOut', 'near_getAccounts', 'near_signAndSendTransaction', 'near_signAndSendTransactions', 'near_signMessage'] as const;
export type NearWalletMethod = (typeof NEAR_WALLET_METHODS)[number];

export function isNearWalletMethod(method: string): method is NearWalletMethod {
  return (NEAR_WALLET_METHODS as readonly string[]).includes(method);
}

/** `ed25519:<base58>` for an implicit account id (its own public key). */
export function implicitPublicKey(accountId: string): string {
  if (!/^[0-9a-f]{64}$/.test(accountId)) throw new Error('Not a NEAR implicit account.');
  return `ed25519:${base58.encode(Uint8Array.from(accountId.match(/../g)!.map((pair) => parseInt(pair, 16))))}`;
}

const MAX_GAS = 300n * 10n ** 12n;

interface ConnectorAction {
  readonly type?: string;
  readonly params?: { methodName?: unknown; args?: unknown; gas?: unknown; deposit?: unknown };
}

export interface NearTx {
  readonly receiverId: string;
  readonly actions: Action[];
  readonly lines: string[];
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value && typeof value === 'object' && Array.isArray((value as { __bytes?: unknown }).__bytes)) {
    return Uint8Array.from((value as { __bytes: number[] }).__bytes);
  }
  return null;
}

function amount(value: unknown, what: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`The site sent no ${what}.`);
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`The site sent an unreadable ${what}: ${text.slice(0, 40)}`);
  return BigInt(text);
}

function parseAction(action: ConnectorAction): { action: Action; line: string } {
  if (action.type === 'Transfer') {
    const deposit = amount(action.params?.deposit, 'transfer amount');
    return { action: nearTransfer(deposit), line: `Send ${formatNear(deposit, 6)} NEAR` };
  }
  if (action.type === 'FunctionCall') {
    const method = action.params?.methodName;
    if (typeof method !== 'string' || !method) throw new Error('The site sent a call with no method.');
    const raw = bytesOf(action.params?.args);
    const args = raw ?? new TextEncoder().encode(JSON.stringify(action.params?.args ?? {}));
    const gas = amount(action.params?.gas ?? '30000000000000', 'gas');
    if (gas > MAX_GAS) throw new Error('The site asked for more gas than a NEAR transaction allows.');
    const deposit = amount(action.params?.deposit ?? '0', 'deposit');
    const shown = raw ? `${raw.length} bytes` : JSON.stringify(action.params?.args ?? {});
    return {
      action: nearFunctionCall(method, args, gas, deposit),
      line: `Call ${method}(${shown.length > 240 ? `${shown.slice(0, 240)}…` : shown})${deposit > 0n ? ` attaching ${formatNear(deposit, 6)} NEAR` : ''}`,
    };
  }
  // Keys, account deletion, contract deployment and staking would hand control of the account away.
  throw new Error(`Ghosty does not sign ${action.type ?? 'unknown'} actions.`);
}

/**
 * The transactions a site asked for, refused if any is not from this account,
 * not on mainnet, or carries an action Ghosty does not sign.
 */
export function parseNearTransactions(method: 'near_signAndSendTransaction' | 'near_signAndSendTransactions', params: unknown[], accountId: string): NearTx[] {
  const input = (params[0] ?? {}) as { network?: unknown; signerId?: unknown; receiverId?: unknown; actions?: unknown; transactions?: unknown };
  if (input.network !== undefined && input.network !== 'mainnet') throw new Error('Ghosty only signs on NEAR mainnet.');
  if (input.signerId !== undefined && input.signerId !== accountId) throw new Error('That transaction is for another NEAR account.');
  const raw =
    method === 'near_signAndSendTransaction'
      ? [{ receiverId: input.receiverId, actions: input.actions }]
      : Array.isArray(input.transactions)
        ? (input.transactions as { receiverId?: unknown; actions?: unknown; signerId?: unknown }[])
        : [];
  if (raw.length === 0) throw new Error('The site sent no transaction.');
  if (raw.length > 10) throw new Error('The site sent more transactions than Ghosty signs at once.');
  return raw.map((tx) => {
    if ('signerId' in tx && tx.signerId !== undefined && tx.signerId !== accountId) throw new Error('That transaction is for another NEAR account.');
    if (typeof tx.receiverId !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(tx.receiverId)) throw new Error('The site sent a transaction with no valid receiver.');
    if (!Array.isArray(tx.actions) || tx.actions.length === 0) throw new Error('The site sent a transaction with no actions.');
    const parsed = (tx.actions as ConnectorAction[]).map(parseAction);
    return { receiverId: tx.receiverId, actions: parsed.map((row) => row.action), lines: parsed.map((row) => row.line) };
  });
}

export function describeNearTransactions(txs: NearTx[], accountId: string): string {
  const head = `From NEAR account ${accountId.slice(0, 8)}…${accountId.slice(-6)}`;
  return [head, ...txs.map((tx, index) => `${txs.length > 1 ? `${index + 1}. ` : ''}To ${tx.receiverId}:\n${tx.lines.map((line) => `  • ${line}`).join('\n')}`)].join('\n\n');
}

export interface Nep413Params {
  readonly message: string;
  readonly recipient: string;
  readonly nonce: Uint8Array;
  readonly callbackUrl?: string;
}

export function parseNep413(params: unknown[]): Nep413Params {
  const input = (params[0] ?? {}) as { message?: unknown; recipient?: unknown; nonce?: unknown; callbackUrl?: unknown; network?: unknown };
  if (input.network !== undefined && input.network !== 'mainnet') throw new Error('Ghosty only signs on NEAR mainnet.');
  if (typeof input.message !== 'string' || typeof input.recipient !== 'string') throw new Error('The site sent an incomplete message to sign.');
  const nonce = bytesOf(input.nonce) ?? (Array.isArray(input.nonce) ? Uint8Array.from(input.nonce as number[]) : null);
  if (!nonce || nonce.length !== 32) throw new Error('The message nonce must be 32 bytes.');
  return { message: input.message, recipient: input.recipient, nonce, ...(typeof input.callbackUrl === 'string' ? { callbackUrl: input.callbackUrl } : {}) };
}

/** NEP-413: sha256 over the 2^31+413 tag and the borsh payload, signed with ed25519. */
export function signNep413(key: NearOwnerKey, params: Nep413Params): { accountId: string; publicKey: string; signature: string } {
  const enc = new TextEncoder();
  const u32 = (value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
  };
  const string = (value: string) => {
    const bytes = enc.encode(value);
    return [u32(bytes.length), bytes];
  };
  const parts: Uint8Array[] = [
    u32(2 ** 31 + 413),
    ...string(params.message),
    params.nonce,
    ...string(params.recipient),
    ...(params.callbackUrl === undefined ? [Uint8Array.of(0)] : [Uint8Array.of(1), ...string(params.callbackUrl)]),
  ];
  const total = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    total.set(part, offset);
    offset += part.length;
  }
  return { accountId: key.accountId, publicKey: key.publicKey, signature: base64(ed25519.sign(sha256(total), key.secretKey)) };
}
