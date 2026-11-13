/**
 * dYdX v4. dYdX is its own chain: dydx.trade asks the connected EVM wallet
 * for one "dYdX Chain Onboarding" signature and derives the dYdX key from it.
 * Deposits from Arbitrum go out over CCTP through Noble; withdrawals come back
 * the same way to the address the user names on the site.
 *
 * Bring back must therefore look in four places before it can call the
 * address empty: the dYdX subaccounts (equity, positions, orders), the dYdX
 * wallet (USDC withdrawn from trading but not off the chain), Noble (USDC in
 * transit), and the CCTP leg to Arbitrum, which shows nowhere for ~20 minutes.
 *
 * The onboarding payload and derivation are copied from dydxprotocol/v4-web
 * (constants/wallets.ts getSignTypedData, useSignForWalletDerivation.tsx; the
 * mainnet env has ethereumChainId 1) and v4-clients (lib/onboarding.ts
 * deriveHDKeyFromEthereumSignature), read 2026-11-13.
 */

import { bech32 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, keccak256 } from 'viem';

export const DYDX_APP = 'https://dydx.trade/trade/ETH-USD';
export const DYDX_INDEXER = 'https://indexer.dydx.trade/v4';
export const DYDX_REST = 'https://dydx-rest.publicnode.com';
export const NOBLE_REST = 'https://noble-api.polkachu.com';
/** USDC on the dYdX chain (IBC from Noble), and on Noble itself. */
export const DYDX_USDC_DENOM = 'ibc/8E27BA2D5493AF5636760E354E46004562C46AB7EC0CC4C1CA14E9E20E2545B5';
export const NOBLE_USDC_DENOM = 'uusdc';
/** A deposit or withdrawal leg that shows nowhere yet: CCTP takes about 20 minutes. */
export const DYDX_TRANSIT_MS = 45 * 60_000;
/** Below this, a balance is dust and does not hold Bring back. In USDC units (6 decimals). */
export const DYDX_DUST_UNITS = 10_000n;

/** What dydx.trade (mainnet) asks the wallet to sign. Not MetaMask, so no empty verifyingContract. */
export const DYDX_ONBOARDING = {
  domain: { name: 'dYdX Chain', chainId: 1 },
  types: { dYdX: [{ name: 'action', type: 'string' }] },
  primaryType: 'dYdX',
  message: { action: 'dYdX Chain Onboarding' },
} as const;

/** Anything shaped like a dYdX onboarding request: its account comes from this signature. */
export function isDydxOnboarding(typed: { primaryType: string; message: Record<string, unknown> }): boolean {
  return typed.primaryType === 'dYdX' && typeof typed.message.action === 'string' && /onboarding/i.test(typed.message.action);
}

/**
 * Exactly the mainnet onboarding payload. Only this one is recorded as the
 * account: a variant (other domain, chainId, extra field) derives a different
 * dydx1 address, and recording that would make Bring back check the wrong one.
 */
export function isCanonicalDydxOnboarding(typed: {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}): boolean {
  const domainKeys = Object.keys(typed.domain).filter((key) => typed.domain[key] !== undefined).sort();
  const fields = typed.types.dYdX ?? [];
  return (
    typed.primaryType === 'dYdX' &&
    JSON.stringify(domainKeys) === JSON.stringify(['chainId', 'name']) &&
    typed.domain.name === DYDX_ONBOARDING.domain.name &&
    Number(typed.domain.chainId) === DYDX_ONBOARDING.domain.chainId &&
    Object.keys(typed.types).filter((key) => key !== 'EIP712Domain').length === 1 &&
    fields.length === 1 &&
    fields[0]?.name === 'action' &&
    fields[0]?.type === 'string' &&
    JSON.stringify(Object.keys(typed.message)) === '["action"]' &&
    typed.message.action === DYDX_ONBOARDING.message.action
  );
}

/**
 * The dYdX (and Noble) address the site derives from the onboarding
 * signature. Only the public address leaves this function: the mnemonic is
 * the dYdX account's key and is never kept or stored.
 */
export function dydxAddressFromSignature(signature: `0x${string}`): { dydx: string; noble: string } {
  const bytes = hexToBytes(signature);
  if (bytes.length !== 65) throw new Error('A dYdX onboarding signature is 65 bytes.');
  const entropy = hexToBytes(keccak256(bytes.subarray(0, 64)));
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive("m/44'/118'/0'/0/0");
  if (!key.publicKey) throw new Error('Could not derive the dYdX key.');
  const words = bech32.toWords(ripemd160(sha256(key.publicKey)));
  return { dydx: bech32.encode('dydx', words), noble: bech32.encode('noble', words) };
}

/* ------------------------------------------------------------- Reading */

export interface DydxState {
  /** Sum of subaccount equity, in USDC units. */
  readonly equity: bigint;
  readonly positions: string[];
  readonly openOrders: number;
  /** USDC in the dYdX chain wallet (not in a subaccount). */
  readonly walletUsdc: bigint;
  /** USDC sitting on Noble for this key: mid-route either way. */
  readonly nobleUsdc: bigint;
  /** Newest transfer the indexer knows for this address, ms. */
  readonly lastTransferAt: number | null;
}

export function decimalUnits(value: string | number | undefined): bigint {
  const text = String(value ?? '0').trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return 0n;
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  const units = BigInt(whole!) * 1_000_000n + BigInt(frac.slice(0, 6).padEnd(6, '0'));
  return negative ? -units : units;
}

/** /v4/addresses/{address}. A 404 "No subaccounts found" is an address that never deposited. */
export function readSubaccounts(body: unknown): { equity: bigint; positions: string[]; numbers: number[] } {
  // null is the indexer's 404 (never deposited). Anything else must look right,
  // or a changed API would read as an empty account.
  if (body !== null && (typeof body !== 'object' || !Array.isArray((body as { subaccounts?: unknown }).subaccounts))) {
    throw new Error('The dYdX indexer answered in an unexpected shape.');
  }
  const subaccounts = ((body ?? {}) as { subaccounts?: { subaccountNumber?: number; equity?: string; openPerpetualPositions?: Record<string, unknown> }[] }).subaccounts ?? [];
  return {
    equity: subaccounts.reduce((sum, row) => sum + decimalUnits(row.equity), 0n),
    positions: subaccounts.flatMap((row) => Object.keys(row.openPerpetualPositions ?? {})),
    numbers: subaccounts.map((row) => row.subaccountNumber ?? 0),
  };
}

/** A cosmos bank balances answer -> units of one denom. */
export function bankUnits(body: unknown, denom: string): bigint {
  const balances = ((body ?? {}) as { balances?: { denom?: string; amount?: string }[] }).balances ?? [];
  const row = balances.find((balance) => balance.denom === denom);
  return row?.amount && /^\d+$/.test(row.amount) ? BigInt(row.amount) : 0n;
}

/**
 * Why Bring back cannot run yet, or null.
 * `ownerUsdc` is the owner's USDC on Arbitrum; `lastOwnerSendAt` its newest
 * outgoing USDC transfer (a deposit leaving), both for the transit rule.
 */
export function dydxExitBlocker(state: DydxState, owner: { usdc: bigint; lastSendAt: number | null }, now = Date.now()): string | null {
  if (state.positions.length > 0) {
    return `Close your ${state.positions.join(', ')} position${state.positions.length > 1 ? 's' : ''} on dYdX first. Nothing was moved.`;
  }
  if (state.openOrders > 0) return `Cancel your ${state.openOrders} open order${state.openOrders > 1 ? 's' : ''} on dYdX first. Nothing was moved.`;
  if (state.equity > DYDX_DUST_UNITS) {
    return `${fmt(state.equity)} USDC is still on dYdX. On dydx.trade, Withdraw it to Arbitrum, to this same address. Nothing was moved.`;
  }
  if (state.walletUsdc > DYDX_DUST_UNITS) {
    return `${fmt(state.walletUsdc)} USDC is in your dYdX wallet, off trading but still on the dYdX chain. On dydx.trade, Withdraw it to Arbitrum, to this same address. Nothing was moved.`;
  }
  if (state.nobleUsdc > DYDX_DUST_UNITS) {
    return `${fmt(state.nobleUsdc)} USDC is on its way through Noble. Wait a few minutes and bring it back again. Nothing was moved.`;
  }
  // Any dYdX movement inside the transit window may still be on its way over
  // CCTP, whatever the address already holds: some USDC here proves nothing
  // about the rest.
  const recentDydx = state.lastTransferAt !== null && now - state.lastTransferAt < DYDX_TRANSIT_MS;
  if (recentDydx) {
    return 'dYdX moved funds for this account in the last 45 minutes; a withdrawal may still be on its way to Arbitrum over CCTP. Bring it back again after that. Nothing was moved.';
  }
  // A deposit that left Arbitrum after dYdX last showed any movement has not landed there yet.
  const recentSend = owner.lastSendAt !== null && now - owner.lastSendAt < DYDX_TRANSIT_MS;
  if (recentSend && (state.lastTransferAt === null || owner.lastSendAt! > state.lastTransferAt)) {
    return 'A deposit to dYdX left this address recently and has not shown on dYdX yet. Wait for it to land, then withdraw it on dydx.trade. Nothing was moved.';
  }
  return null;
}

function fmt(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, '0').slice(0, 2);
  return `${whole}.${frac}`;
}
