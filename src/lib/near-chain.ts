/**
 * NEAR mainnet: reads, and signing a transaction with a NEAR owner key.
 *
 * Plain JSON-RPC over fetch, no near-api-js account layer. Borsh encoding is
 * @near-js/transactions; the signature is ed25519 over sha256 of it.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { KeyType, PublicKey } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature, type Action } from '@near-js/transactions';
import type { NearOwnerKey } from './near-keys';

/** Tried in order. Both are listed in the manifest's host permissions. */
export const NEAR_RPCS = ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'] as const;

export const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const WRAP_NEAR = 'wrap.near';
/** 1 NEAR in yoctoNEAR. */
export const ONE_NEAR = 10n ** 24n;
const ONE_YOCTO = 1n;
const TGAS = 10n ** 12n;

export class NearRpcError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  let lastError: unknown;
  for (const url of NEAR_RPCS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'ghosty', method, params }),
      });
      if (!response.ok) throw new NearRpcError(`NEAR RPC answered ${response.status}`);
      const body = (await response.json()) as { result?: T; error?: { name?: string; cause?: { name?: string; info?: unknown }; data?: unknown; message?: string } };
      if (body.error) {
        // A real answer (unknown account, failed view): no point asking another node.
        throw new NearRpcError(nearErrorText(body.error), body.error);
      }
      return body.result as T;
    } catch (error) {
      if (error instanceof NearRpcError && error.cause) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new NearRpcError('NEAR RPC unreachable');
}

function nearErrorText(error: { name?: string; cause?: { name?: string }; data?: unknown; message?: string }): string {
  const cause = error.cause?.name;
  const data = typeof error.data === 'string' ? error.data : JSON.stringify(error.data ?? '');
  return [cause ?? error.name ?? 'NEAR RPC error', data].filter(Boolean).join(': ').slice(0, 400);
}

function isUnknownAccount(error: unknown): boolean {
  return error instanceof NearRpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(error.message);
}

/** Native balance in yoctoNEAR, or null when the account does not exist yet (an implicit account before its first NEAR). */
export async function nearAccountBalance(accountId: string): Promise<{ amount: bigint; locked: bigint; storageUsage: number } | null> {
  try {
    const result = await rpc<{ amount: string; locked: string; storage_usage: number }>('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    return { amount: BigInt(result.amount), locked: BigInt(result.locked), storageUsage: result.storage_usage };
  } catch (error) {
    if (isUnknownAccount(error)) return null;
    throw error;
  }
}

/** A contract view call with JSON args and a JSON result. Throws on any failure: callers refuse rather than read 0. */
export async function nearView<T>(contractId: string, methodName: string, args: Record<string, unknown>): Promise<T> {
  const result = await rpc<{ result: number[] }>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: methodName,
    args_base64: base64(new TextEncoder().encode(JSON.stringify(args))),
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as T;
}

export async function nearFtBalance(tokenId: string, accountId: string): Promise<bigint> {
  return BigInt(await nearView<string>(tokenId, 'ft_balance_of', { account_id: accountId }));
}

export async function nearStorageRegistered(tokenId: string, accountId: string): Promise<boolean> {
  return (await nearView<unknown>(tokenId, 'storage_balance_of', { account_id: accountId })) !== null;
}

export interface NearOutcome {
  readonly transaction: { readonly hash: string };
  readonly status: unknown;
  readonly transaction_outcome: unknown;
  readonly receipts_outcome: unknown[];
}

/** Whether a final outcome failed anywhere: the transaction or any receipt. */
export function nearOutcomeFailure(outcome: NearOutcome): string | null {
  const status = outcome.status as { Failure?: unknown } | undefined;
  if (status && typeof status === 'object' && 'Failure' in status) return JSON.stringify(status.Failure).slice(0, 300);
  for (const receipt of outcome.receipts_outcome as { outcome?: { status?: { Failure?: unknown } } }[]) {
    const failure = receipt.outcome?.status?.Failure;
    if (failure) return JSON.stringify(failure).slice(0, 300);
  }
  return null;
}

/**
 * Sign and send one transaction from a NEAR owner, waiting until final.
 * The nonce comes from the access key, the block hash from a final block.
 */
export async function nearSignAndSend(key: NearOwnerKey, receiverId: string, actions: Action[]): Promise<NearOutcome> {
  const bytes = await nearSignTransaction(key, receiverId, actions);
  return rpc<NearOutcome>('send_tx', { signed_tx_base64: base64(bytes), wait_until: 'FINAL' });
}

/** The borsh bytes of a signed transaction. Exported for the signing check. */
export async function nearSignTransaction(key: NearOwnerKey, receiverId: string, actions: Action[], at?: { nonce: bigint; blockHash: Uint8Array }): Promise<Uint8Array> {
  const publicKey = new PublicKey({ keyType: KeyType.ED25519, data: key.publicKeyBytes });
  let nonce = at?.nonce;
  let blockHash = at?.blockHash;
  if (!at) {
    const accessKey = await rpc<{ nonce: number | string }>('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: key.accountId,
      public_key: key.publicKey,
    });
    const block = await rpc<{ header: { hash: string } }>('block', { finality: 'final' });
    nonce = BigInt(accessKey.nonce) + 1n;
    blockHash = base58.decode(block.header.hash);
  }
  const transaction = createTransaction(key.accountId, publicKey, receiverId, nonce!, actions, blockHash!);
  const hash = sha256(encodeTransaction(transaction));
  const signature = new Signature({ keyType: KeyType.ED25519, data: ed25519.sign(hash, key.secretKey) });
  return new SignedTransaction({ transaction, signature }).encode();
}

export function nearTxHash(signed: Uint8Array): string {
  const decoded = SignedTransaction.decode(signed);
  return base58.encode(sha256(encodeTransaction(decoded.transaction)));
}

// --- Actions -------------------------------------------------------------------

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

export function nearFunctionCall(methodName: string, args: Record<string, unknown> | Uint8Array, gas: bigint, deposit: bigint): Action {
  return actionCreators.functionCall(methodName, args instanceof Uint8Array ? args : json(args), gas, deposit);
}

export function nearTransfer(deposit: bigint): Action {
  return actionCreators.transfer(deposit);
}

/** ft_transfer of `amount` to `receiverId`. NEP-141 requires exactly 1 yoctoNEAR attached. */
export function ftTransferAction(receiverId: string, amount: bigint, memo?: string): Action {
  return nearFunctionCall('ft_transfer', { receiver_id: receiverId, amount: amount.toString(), ...(memo ? { memo } : {}) }, 30n * TGAS, ONE_YOCTO);
}

export function storageDepositAction(accountId: string, deposit: bigint): Action {
  return nearFunctionCall('storage_deposit', { account_id: accountId, registration_only: true }, 30n * TGAS, deposit);
}

export function nearDepositAction(amount: bigint): Action {
  return nearFunctionCall('near_deposit', {}, 10n * TGAS, amount);
}

export function nearWithdrawAction(amount: bigint): Action {
  return nearFunctionCall('near_withdraw', { amount: amount.toString() }, 10n * TGAS, ONE_YOCTO);
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function formatNear(yocto: bigint, digits = 4): string {
  const whole = yocto / ONE_NEAR;
  const fraction = (yocto % ONE_NEAR).toString().padStart(24, '0').slice(0, digits).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
