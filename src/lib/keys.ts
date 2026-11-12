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
 * BIP-44 account index for trade owners.
 *
 * NOT 0 or 1. The Privacy Pools SDK derives its master keys from
 * mnemonicToAccount(mnemonic, { accountIndex: 0 }) and { accountIndex: 1 },
 * which are m/44'/60'/0'/0/0 and m/44'/60'/1'/0/0. This used to be 1, which
 * made owner #0 byte-for-byte the preimage of the pool's masterSecret — the
 * key that signs on Lighter's website doubling as half the material that
 * derives every note in the pool.
 *
 * 7702 is arbitrary beyond being far from 0 and 1, and a nod to the delegation
 * the owner uses to re-shield.
 */
const OWNER_ACCOUNT = 7702;

/**
 * A dedicated account index keeps trade owners away from both the usual
 * account 0' a restored wallet would show AND the SDK's master-key paths.
 */
export function ownerPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`owner index must be a non-negative integer: ${index}`);
  }
  return `m/44'/60'/${OWNER_ACCOUNT}'/0/${index}`;
}

/**
 * The two private keys the Privacy Pools SDK hashes into master keys.
 *
 * Exported so tests can assert no owner key ever equals one. This returns raw
 * key material and exists for that assertion alone — never call it on a money
 * path.
 */
export async function sdkMasterKeyPreimages(
  mnemonic: string,
): Promise<{ masterNullifierPreimage: Hex; masterSecretPreimage: Hex }> {
  const seed = await mnemonicToSeed(mnemonic.trim());
  const root = HDKey.fromMasterSeed(seed);
  const read = (path: string): Hex => {
    const node = root.derive(path);
    if (!node.privateKey) throw new Error(`no private key at ${path}`);
    return `0x${toHex(node.privateKey)}` as Hex;
  };
  return {
    // viem's accountIndex N maps to m/44'/60'/N'/0/0.
    masterNullifierPreimage: read("m/44'/60'/0'/0/0"),
    masterSecretPreimage: read("m/44'/60'/1'/0/0"),
  };
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

/**
 * Where Add funds receives public USDC before shielding it.
 *
 * Change index 1 under the same account as trade owners, so this address is
 * not a trade owner (`…/0/n`) and not a Privacy Pools master-key path
 * (`m/44'/60'/0'` or `…/1'`).
 */
export const FUNDING_WALLET_PATH = "m/44'/60'/7702'/1/0";

async function deriveAt(mnemonic: string, path: string): Promise<{ address: Address; privateKey: Hex }> {
  const seed = await mnemonicToSeed(mnemonic.trim());
  const node = HDKey.fromMasterSeed(seed).derive(path);
  if (!node.privateKey) throw new Error(`no private key at ${path}`);
  const privateKey = `0x${toHex(node.privateKey)}` as Hex;
  return { address: privateKeyToAccount(privateKey).address, privateKey };
}

export async function deriveOwner(
  mnemonic: string,
  index: number,
): Promise<OwnerKey> {
  return { index, ...(await deriveAt(mnemonic, ownerPath(index))) };
}

/** The stable address Add funds shields from. Not a trade owner. */
export async function deriveFundingWallet(mnemonic: string): Promise<{ address: Address; privateKey: Hex }> {
  return deriveAt(mnemonic, FUNDING_WALLET_PATH);
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
