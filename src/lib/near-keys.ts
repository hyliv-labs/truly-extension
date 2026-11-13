/**
 * NEAR keys for the NEAR venue: one fresh implicit account per owner index.
 *
 * SLIP-10 ed25519 from the same recovery phrase as every EVM owner, so a
 * NEAR account is recoverable from the phrase alone. Ed25519 SLIP-10 only
 * has hardened children, so every level is hardened.
 *
 * Coin type 397 is NEAR's. Account 7702' keeps these away from 0', the
 * account a NEAR wallet would show for this phrase, as the EVM owners do.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { mnemonicToSeed } from '@scure/bip39';
import { base58 } from '@scure/base';

const HARDENED = 0x8000_0000;
const NEAR_OWNER_ACCOUNT = 7702;

export interface NearOwnerKey {
  readonly index: number;
  /** The implicit account id: the 64-hex public key. */
  readonly accountId: string;
  /** `ed25519:<base58 public key>`, as NEAR RPC and access keys print it. */
  readonly publicKey: string;
  readonly publicKeyBytes: Uint8Array;
  /** The 32-byte ed25519 seed. Never leaves the worker. */
  readonly secretKey: Uint8Array;
}

export function nearOwnerPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`owner index must be a non-negative integer: ${index}`);
  return `m/44'/397'/${NEAR_OWNER_ACCOUNT}'/0'/${index}'`;
}

/** SLIP-10 ed25519 derivation of a fully hardened path. */
export function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  const parts = path.split('/');
  if (parts[0] !== 'm') throw new Error(`bad path: ${path}`);
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const part of parts.slice(1)) {
    if (!part.endsWith("'")) throw new Error(`ed25519 needs hardened levels: ${path}`);
    const index = Number(part.slice(0, -1));
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error(`bad level ${part} in ${path}`);
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index + HARDENED, false);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

export function nearKeyFromSecret(secretKey: Uint8Array, index = -1): NearOwnerKey {
  const publicKeyBytes = ed25519.getPublicKey(secretKey);
  return {
    index,
    accountId: toHex(publicKeyBytes),
    publicKey: `ed25519:${base58.encode(publicKeyBytes)}`,
    publicKeyBytes,
    secretKey,
  };
}

export async function deriveNearOwner(mnemonic: string, index: number): Promise<NearOwnerKey> {
  const seed = await mnemonicToSeed(mnemonic.trim());
  return nearKeyFromSecret(slip10Ed25519(seed, nearOwnerPath(index)), index);
}

/** A NEAR implicit account id: exactly 64 lowercase hex characters. */
export function isImplicitAccount(accountId: string): boolean {
  return /^[0-9a-f]{64}$/.test(accountId);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
