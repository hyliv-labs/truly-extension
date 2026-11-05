/**
 * Password-based sealing for the seed phrase.
 *
 * WebCrypto has no scrypt, so the KDF comes from @noble/hashes and only the
 * AES-GCM step uses WebCrypto.
 */

import { scryptAsync } from '@noble/hashes/scrypt.js';

/** 32 MiB of working memory — tuned so the popup unlock stays responsive. */
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;

const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface SealedBox {
  /** Base64url. */
  readonly salt: string;
  /** Base64url. */
  readonly iv: string;
  /** Base64url, AES-GCM ciphertext with the tag appended. */
  readonly ciphertext: string;
  /** Guards against silently misreading a box written by an older build. */
  readonly version: 1;
}

export async function seal(
  plaintext: string,
  password: string,
): Promise<SealedBox> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    salt: toBase64Url(salt),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    version: 1,
  };
}

/** Throws on a wrong password — AES-GCM tag verification fails. */
export async function open(box: SealedBox, password: string): Promise<string> {
  if (box.version !== 1) {
    throw new Error(`unsupported vault version: ${box.version}`);
  }

  const key = await deriveKey(password, fromBase64Url(box.salt));

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(box.iv) },
      key,
      fromBase64Url(box.ciphertext),
    );
  } catch {
    // Deliberately opaque: never leak whether the box or the password is at fault.
    throw new Error('incorrect password');
  }

  return new TextDecoder().decode(plaintext);
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const bytes = await scryptAsync(
    new TextEncoder().encode(password.normalize('NFKD')),
    salt,
    SCRYPT_PARAMS,
  );
  // Copy into a plain ArrayBuffer: noble returns Uint8Array<ArrayBufferLike>,
  // which may be SharedArrayBuffer-backed and is not a valid BufferSource.
  const raw = new Uint8Array(bytes.length);
  raw.set(bytes);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Uint8Array<ArrayBuffer>, not plain Uint8Array: the default ArrayBufferLike
// includes SharedArrayBuffer, which WebCrypto will not accept as a BufferSource.
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
