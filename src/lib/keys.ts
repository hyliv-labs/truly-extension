/**
 * Owner key derivation.
 *
 * One trade = one owner address = one Lighter account, never reused. The index
 * only ever increases; reusing an index would link two trades on-chain, which
 * is the single thing this extension exists to prevent.
 */

import { HDKey } from '@scure/bip32';
import { mnemonicToSeed, validateMnemonic, generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

/**
 * Account 1' separates trade owners from anything at the usual account 0',
 * so a seed restored into an ordinary wallet never shows these addresses.
 */
export function ownerPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`owner index must be a non-negative integer: ${index}`);
  }
  return `m/44'/60'/1'/0/${index}`;
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic.trim(), wordlist);
}

export interface OwnerKey {
  readonly index: number;
  readonly address: Address;
  readonly privateKey: Hex;
}

export async function deriveOwner(
  mnemonic: string,
  index: number,
): Promise<OwnerKey> {
  const seed = await mnemonicToSeed(mnemonic.trim());
  const node = HDKey.fromMasterSeed(seed).derive(ownerPath(index));

  if (!node.privateKey) {
    throw new Error(`no private key at ${ownerPath(index)}`);
  }

  const privateKey = `0x${toHex(node.privateKey)}` as Hex;
  return {
    index,
    address: privateKeyToAccount(privateKey).address,
    privateKey,
  };
}

/** Address only — for display and recovery scans, where the key isn't needed. */
export async function deriveOwnerAddress(
  mnemonic: string,
  index: number,
): Promise<Address> {
  return (await deriveOwner(mnemonic, index)).address;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
