/**
 * Recovering an existing Privacy Pools account that was created with a wallet
 * signature on privacypools.com.
 *
 * The site never stores a mnemonic for these accounts: it re-derives one from
 * an EIP-712 signature each time. ECDSA signatures are deterministic
 * (RFC 6979), so the same wallet always reproduces the same phrase.
 *
 * Reimplemented here because the SDK has no signature entry point — it accepts
 * only a mnemonic or a prebuilt account. Every constant below is copied from
 * privacy-pools-website/src/utils/{walletSeed,seedSignature}.ts; a single
 * changed byte yields a valid-looking phrase that finds no notes at all.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { english } from 'viem/accounts';

/**
 * v1 accounts derive 16 bytes of entropy (12 words), v2 derive 32 (24 words).
 * The two are different accounts with different notes, not two encodings of
 * one account.
 */
export type SeedVersion = 'v1' | 'v2';

/** Standard secp256k1 signature. Contract accounts sign differently. */
const SEED_SIGNATURE_BYTES = 65;

export class SeedSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedSignatureError';
  }
}

/**
 * The exact payload privacypools.com asks the wallet to sign. Shown to the
 * user so they can compare it with what their wallet displays.
 */
export function buildSeedDerivationTypedData(
  address: Address,
  version: SeedVersion = 'v2',
) {
  return {
    domain: { name: 'Privacy Pools', version: '1' } as const,
    types: {
      DeriveSeed: [
        { name: 'action', type: 'string' },
        { name: 'context', type: 'string' },
        { name: 'addressHash', type: 'bytes32' },
      ],
    } as const,
    primaryType: 'DeriveSeed' as const,
    message: {
      action: 'Derive Account Seed',
      context: `privacy-pools/wallet-seed:${version}`,
      addressHash: keccak256(toBytes(address)),
    } as const,
  };
}

/**
 * Derive the account mnemonic from a wallet signature.
 *
 * Refuses anything but a 65-byte signature that recovers to `address`. That is
 * not ceremony: a signature from a different account silently derives a
 * different, empty account, and the user would see "no funds" rather than an
 * error.
 */
export async function deriveMnemonicFromWalletSignature(
  signature: Hex,
  address: Address,
  version: SeedVersion = 'v2',
): Promise<string> {
  const bytes = toBytes(signature);
  if (bytes.length !== SEED_SIGNATURE_BYTES) {
    throw new SeedSignatureError(
      `Expected a 65-byte signature, got ${bytes.length}. Smart contract wallets cannot be used for this.`,
    );
  }

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      ...buildSeedDerivationTypedData(address, version),
      signature,
    });
  } catch {
    throw new SeedSignatureError('That signature could not be read.');
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new SeedSignatureError(
      `This signature was made by ${recovered}, not ${address}.`,
    );
  }

  // Only r is used as HKDF input keying material.
  const r = bytes.slice(0, 32);
  const salt = toBytes(address.toLowerCase() as Address);
  const info = new TextEncoder().encode(`privacy-pools/wallet-seed:${version}`);
  const entropy = hkdf(sha256, r, salt, info, version === 'v1' ? 16 : 32);

  const mnemonic = entropyToMnemonic(entropy);

  // The upstream implementation zeroes these after use, on its auditor's
  // advice. Cheap, and this is the highest-value secret in the process.
  r.fill(0);
  bytes.fill(0);
  entropy.fill(0);

  return mnemonic;
}

/**
 * BIP-39 entropy -> English mnemonic.
 *
 * Written out rather than taken from a library because it must match the
 * website's own minimal implementation exactly.
 */
function entropyToMnemonic(entropy: Uint8Array): string {
  const checksumBits = (entropy.length * 8) / 32;
  const bits = toBits(entropy) + toBits(sha256(entropy)).slice(0, checksumBits);

  const words: string[] = [];
  for (let i = 0; i + 11 <= bits.length; i += 11) {
    words.push(english[parseInt(bits.slice(i, i + 11), 2)]!);
  }
  return words.join(' ');
}

function toBits(bytes: Uint8Array): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return bits;
}
