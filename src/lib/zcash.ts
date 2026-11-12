/**
 * Zcash addresses as NEAR Intents can use them, whatever wallet they came from.
 *
 * 1Click pays and refunds Zcash on transparent addresses only: t1… (P2PKH),
 * t3… (P2SH) and tex1… (ZIP-320) are accepted; a unified address (u1…) is
 * refused with "refundTo is not valid" (checked live 2026-11-12). Zashi,
 * Zingo, YWallet and most current wallets show a unified address first, so a
 * user who pastes it would hit that error with no idea why.
 *
 * A unified address (ZIP-316) bundles several receivers of the same wallet.
 * If it carries a transparent one, that receiver IS the user's own t-address,
 * so Ghosty uses it and says so on screen. A unified address with no
 * transparent receiver, or a Sapling zs1… address, cannot be used: the user
 * is told where their wallet shows the transparent one.
 *
 * Pure: no chrome, no network. The checks run it against the official ZIP-316
 * test vectors.
 */

import { base58check, bech32, bech32m } from '@scure/base';
import { blake2b } from '@noble/hashes/blake2.js';
import { sha256 } from '@noble/hashes/sha2.js';

const b58 = base58check(sha256);

/** Mainnet version bytes (ZIP-316 / protocol spec §5.6.1.1). */
const P2PKH_VERSION = [0x1c, 0xb8] as const;
const P2SH_VERSION = [0x1c, 0xbd] as const;

/** ZIP-316 receiver typecodes. */
const TYPE_P2PKH = 0x00;
const TYPE_P2SH = 0x01;

/** Long enough for any unified address (bech32's 90-character limit does not apply). */
const BECH32_LIMIT = 2_000;

export type ZcashAddressKind = 'p2pkh' | 'p2sh' | 'tex' | 'unified' | 'sapling' | 'sprout' | 'testnet' | 'invalid';

export interface ParsedZcashAddress {
  readonly kind: ZcashAddressKind;
  /** A transparent address 1Click accepts, if this address is or contains one. */
  readonly transparent?: string;
}

/** What Ghosty sends to 1Click, and whether the user typed something else. */
export interface IntentsZcashAddress {
  readonly address: string;
  /** Set when the address was taken out of a unified address the user pasted. */
  readonly fromUnified: boolean;
}

export class ZcashAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZcashAddressError';
  }
}

// --- F4Jumble (ZIP-316) ------------------------------------------------------------

const H_LEN = 64;

function personal(tag: string, i: number, j = 0): Uint8Array {
  const out = new Uint8Array(16);
  out.set(new TextEncoder().encode(tag));
  out[13] = i;
  out[14] = j & 0xff;
  out[15] = j >> 8;
  return out;
}

function hashH(i: number, u: Uint8Array, length: number): Uint8Array {
  return blake2b(u, { dkLen: length, personalization: personal('UA_F4Jumble_H', i) });
}

function hashG(i: number, u: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(length / H_LEN) * H_LEN);
  for (let j = 0; j * H_LEN < length; j++) {
    out.set(blake2b(u, { dkLen: H_LEN, personalization: personal('UA_F4Jumble_G', i, j) }), j * H_LEN);
  }
  return out.subarray(0, length);
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  return a.map((byte, k) => byte ^ b[k]!);
}

function split(message: Uint8Array): [number, number] {
  if (message.length < 48 || message.length > 4_194_368) throw new ZcashAddressError('Not a unified address.');
  const left = Math.min(H_LEN, Math.floor(message.length / 2));
  return [left, message.length - left];
}

export function f4jumble(message: Uint8Array): Uint8Array {
  const [left, right] = split(message);
  const a = message.subarray(0, left);
  const b = message.subarray(left);
  const x = xor(b, hashG(0, a, right));
  const y = xor(a, hashH(0, x, left));
  const d = xor(x, hashG(1, y, right));
  const c = xor(y, hashH(1, d, left));
  return Uint8Array.from([...c, ...d]);
}

export function f4jumbleInverse(message: Uint8Array): Uint8Array {
  const [left, right] = split(message);
  const c = message.subarray(0, left);
  const d = message.subarray(left);
  const y = xor(c, hashH(1, d, left));
  const x = xor(d, hashG(1, y, right));
  const a = xor(y, hashH(0, x, left));
  const b = xor(x, hashG(0, a, right));
  return Uint8Array.from([...a, ...b]);
}

// --- Unified addresses -------------------------------------------------------------

function compactSize(bytes: Uint8Array, at: number): [number, number] {
  const first = bytes[at];
  if (first === undefined) throw new ZcashAddressError('Not a unified address.');
  if (first < 0xfd) return [first, at + 1];
  if (first === 0xfd && at + 3 <= bytes.length) {
    const value = bytes[at + 1]! | (bytes[at + 2]! << 8);
    if (value < 0xfd) throw new ZcashAddressError('Not a unified address.');
    return [value, at + 3];
  }
  throw new ZcashAddressError('Not a unified address.');
}

/** The receivers inside a mainnet unified address, keyed by ZIP-316 typecode. */
export function unifiedReceivers(address: string): Map<number, Uint8Array> {
  const { prefix, words } = bech32m.decode(address.toLowerCase() as `${string}1${string}`, BECH32_LIMIT);
  if (prefix !== 'u') throw new ZcashAddressError('Not a mainnet unified address.');
  const raw = f4jumbleInverse(bech32m.fromWords(words));
  // The last 16 bytes are the HRP, zero-padded: a cheap integrity check.
  const padding = raw.subarray(raw.length - 16);
  const expected = new Uint8Array(16);
  expected.set(new TextEncoder().encode(prefix));
  if (!padding.every((byte, k) => byte === expected[k])) throw new ZcashAddressError('Not a unified address.');

  const items = raw.subarray(0, raw.length - 16);
  const receivers = new Map<number, Uint8Array>();
  let at = 0;
  while (at < items.length) {
    const [typecode, afterType] = compactSize(items, at);
    const [length, afterLength] = compactSize(items, afterType);
    if (afterLength + length > items.length) throw new ZcashAddressError('Not a unified address.');
    receivers.set(typecode, items.slice(afterLength, afterLength + length));
    at = afterLength + length;
  }
  return receivers;
}

function transparentFromHash(version: readonly [number, number], hash: Uint8Array): string {
  return b58.encode(Uint8Array.from([...version, ...hash]));
}

// --- Classification ----------------------------------------------------------------

export function parseZcashAddress(input: string): ParsedZcashAddress {
  const address = input.trim();
  if (/^(tm|t2|utest1|ztestsapling1|texttest1)/i.test(address)) return { kind: 'testnet' };

  if (/^t[13]/.test(address)) {
    try {
      const bytes = b58.decode(address);
      if (bytes.length !== 22) return { kind: 'invalid' };
      const kind = bytes[0] === P2PKH_VERSION[0] && bytes[1] === P2PKH_VERSION[1] ? 'p2pkh' : bytes[0] === P2SH_VERSION[0] && bytes[1] === P2SH_VERSION[1] ? 'p2sh' : null;
      return kind ? { kind, transparent: address } : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  }

  if (/^tex1/i.test(address)) {
    try {
      const { words } = bech32m.decode(address.toLowerCase() as `${string}1${string}`, BECH32_LIMIT);
      return bech32m.fromWords(words).length === 20 ? { kind: 'tex', transparent: address.toLowerCase() } : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  }

  if (/^u1/i.test(address)) {
    try {
      const receivers = unifiedReceivers(address);
      const p2pkh = receivers.get(TYPE_P2PKH);
      const p2sh = receivers.get(TYPE_P2SH);
      const transparent =
        p2pkh?.length === 20 ? transparentFromHash(P2PKH_VERSION, p2pkh) : p2sh?.length === 20 ? transparentFromHash(P2SH_VERSION, p2sh) : undefined;
      return transparent ? { kind: 'unified', transparent } : { kind: 'unified' };
    } catch {
      return { kind: 'invalid' };
    }
  }

  if (/^zs1/i.test(address)) {
    try {
      bech32.decode(address.toLowerCase() as `${string}1${string}`, BECH32_LIMIT);
      return { kind: 'sapling' };
    } catch {
      return { kind: 'invalid' };
    }
  }
  if (/^zc/.test(address)) return { kind: 'sprout' };
  return { kind: 'invalid' };
}

/** Where wallets keep the transparent address, for the error the user sees. */
const WHERE_TRANSPARENT =
  'Paste a transparent t1… address instead. Zashi: Receive → Transparent. Zingo / YWallet: the transparent (t) address on the receive screen. An exchange deposit address for ZEC is already transparent.';

/**
 * The address to give 1Click for a Zcash leg, or a message saying what to
 * paste instead. `role` only changes the wording.
 */
export function zcashAddressForIntents(input: string, role: 'refund' | 'recipient'): IntentsZcashAddress {
  const parsed = parseZcashAddress(input);
  const what = role === 'refund' ? 'refund' : 'delivery';
  switch (parsed.kind) {
    case 'p2pkh':
    case 'p2sh':
    case 'tex':
      return { address: parsed.transparent!, fromUnified: false };
    case 'unified':
      if (parsed.transparent) return { address: parsed.transparent, fromUnified: true };
      throw new ZcashAddressError(`This unified address has no transparent part, and NEAR Intents can only ${role === 'refund' ? 'refund to' : 'pay'} a transparent Zcash address. ${WHERE_TRANSPARENT}`);
    case 'sapling':
    case 'sprout':
      throw new ZcashAddressError(`NEAR Intents cannot use a shielded-only Zcash address for the ${what}. ${WHERE_TRANSPARENT}`);
    case 'testnet':
      throw new ZcashAddressError('That is a Zcash testnet address. NEAR Intents runs on mainnet.');
    default:
      throw new ZcashAddressError(`That is not a Zcash address. ${WHERE_TRANSPARENT}`);
  }
}

// --- Payment request (ZIP-321) -----------------------------------------------------

/** ZEC has 8 decimals: "zatoshi". */
export const ZEC_DECIMALS = 8;

/** A ZIP-321 amount: decimal ZEC, at most 8 fraction digits, no trailing zeros, no exponent. */
export function zip321Amount(zatoshi: bigint): string {
  if (zatoshi <= 0n) throw new ZcashAddressError('The amount must be positive.');
  const whole = zatoshi / 100_000_000n;
  const fraction = (zatoshi % 100_000_000n).toString().padStart(ZEC_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * `zcash:<address>?amount=<ZEC>` for a QR code or a wallet link. Every Zcash
 * wallet with a scanner reads it and fills in the exact amount. No memo (not
 * allowed for a transparent address) and no label (it would leak to the
 * wallet's history what the payment was for).
 */
export function zip321Uri(address: string, zatoshi: bigint): string {
  const parsed = parseZcashAddress(address);
  if (!parsed.transparent || parsed.kind === 'unified') throw new ZcashAddressError('The deposit address is not a transparent Zcash address.');
  return `zcash:${address.trim()}?amount=${zip321Amount(zatoshi)}`;
}
