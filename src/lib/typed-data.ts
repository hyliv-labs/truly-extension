/**
 * EIP-712 hashing for type names viem refuses.
 *
 * viem only accepts struct names made of letters, digits, "_" and "$".
 * Hyperliquid names its user-signed actions "HyperliquidTransaction:Withdraw",
 * "HyperliquidTransaction:ApproveAgent" and so on. MetaMask signs those, and
 * Hyperliquid rebuilds and verifies them, so a wallet that refuses them cannot
 * withdraw or Enable trading there.
 *
 * The digest is computed exactly as viem's hashTypedData does, minus that one
 * name check: same domain type, same struct encoding.
 */

import { concat, getTypesForEIP712Domain, hashDomain, hashStruct, keccak256, validateTypedData, type Hex, type TypedDataDomain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface LooseTypedData {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, readonly { name: string; type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

export function hashTypedDataLoose(input: LooseTypedData): Hex {
  const domain = input.domain as TypedDataDomain;
  const types = { ...input.types, EIP712Domain: getTypesForEIP712Domain({ domain }) };
  const parts: Hex[] = ['0x1901', hashDomain({ domain, types } as Parameters<typeof hashDomain>[0])];
  if (input.primaryType !== 'EIP712Domain') {
    parts.push(hashStruct({ data: input.message, primaryType: input.primaryType, types } as Parameters<typeof hashStruct>[0]));
  }
  return keccak256(concat(parts));
}

/** viem refuses the struct name, nothing else. Anything else it refuses stays refused. */
export function isStructNameRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === 'InvalidStructTypeError';
}

export function signTypedDataLoose(privateKey: Hex, input: LooseTypedData): Promise<Hex> {
  return privateKeyToAccount(privateKey).sign({ hash: hashTypedDataLoose(input) });
}

/** Hyperliquid's user-signed action names: "HyperliquidTransaction:Withdraw", "Hyperliquid:AcceptTerms". */
const HYPERLIQUID_NAME = /^Hyperliquid(Transaction)?:[A-Za-z0-9]+$/;

/**
 * May this be signed with the loose hash? Every struct name with a ':' must
 * be one of Hyperliquid's, and with the ':' swapped out the payload must pass
 * viem's own checks (field types, addresses, integer ranges). The rename only
 * feeds the check; the hash still uses the original names.
 */
export function looseTypedDataAllowed(input: LooseTypedData): boolean {
  const names = Object.keys(input.types);
  if (names.some((name) => name.includes(':') && !HYPERLIQUID_NAME.test(name))) return false;
  if (!names.some((name) => name.includes(':'))) return false;
  const rename = (name: string) => name.replace(/:/g, '_');
  const types = Object.fromEntries(
    names.map((name) => [rename(name), input.types[name]!.map((field) => ({ name: field.name, type: field.type.replace(/^([^[]+)/, (base) => (input.types[base] ? rename(base) : base)) }))]),
  );
  try {
    validateTypedData({ domain: input.domain as TypedDataDomain, types: types as never, primaryType: rename(input.primaryType), message: input.message } as never);
    return true;
  } catch {
    return false;
  }
}
