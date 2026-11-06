/**
 * The per-trade Lighter API key, sealed at rest.
 *
 * Lighter's signer generates API keys at random (it takes no seed), so the key
 * cannot be re-derived and has to be stored. It is sealed with AES-GCM under a
 * key HKDF-derived from the trade's OWNER private key, which exists only while
 * the vault is unlocked. Each trade's owner is fresh, so each trade's API key
 * is sealed under a different key and none can sign for another session.
 *
 * Losing it is recoverable, not fatal: the owner can always authorise a new
 * key with ChangePubKey.
 */

import type { Hex } from 'viem';
import { hexToBytes } from 'viem';

const INFO = new TextEncoder().encode('truly/lighter-api-key/v1');
const IV_BYTES = 12;

export interface SealedApiKey {
  readonly iv: string;
  readonly ciphertext: string;
  readonly version: 1;
}

async function keyFor(ownerPrivateKey: Hex, accountIndex: number): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', copy(hexToBytes(ownerPrivateKey)), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(`account:${accountIndex}`), info: INFO },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealApiKey(
  ownerPrivateKey: Hex,
  accountIndex: number,
  apiPrivateKey: string,
): Promise<SealedApiKey> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await keyFor(ownerPrivateKey, accountIndex);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(apiPrivateKey));
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)), version: 1 };
}

export async function openApiKey(
  ownerPrivateKey: Hex,
  accountIndex: number,
  sealed: SealedApiKey,
): Promise<string> {
  if (sealed.version !== 1) throw new Error(`unsupported API key box version ${sealed.version}`);
  const key = await keyFor(ownerPrivateKey, accountIndex);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.ciphertext));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('The Lighter API key for this trade could not be opened with its owner key.');
  }
}

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(value: string): Uint8Array<ArrayBuffer> {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
