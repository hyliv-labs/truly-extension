/**
 * E6: getting the money off Lighter.
 *
 * The extension cannot place or cancel orders — it is only the connected
 * wallet, and Lighter's site owns the trading UI. So this watches the account
 * and tells the user what has to happen next, rather than pretending to drive
 * it.
 *
 * The withdrawal itself is made by the user on Lighter's site. Doing it over
 * the API would mean reimplementing Lighter's own transaction signer, which
 * v1 deliberately avoids.
 */

import type { Address } from 'viem';
import {
  MIN_FAST_WITHDRAWAL_USDC,
  MIN_SECURE_WITHDRAWAL_USDC,
  getAccountIndex,
} from './lighter';

/** Below this, a balance costs more to move than it is worth. */
export const DUST_USDC = 1;

export type ExitAdvice =
  | { kind: 'not-funded' }
  | { kind: 'has-positions'; positions: number; openOrders: number }
  | { kind: 'withdraw-fast'; balance: number }
  | { kind: 'withdraw-secure'; balance: number; reason: string }
  | { kind: 'dust'; balance: number }
  | { kind: 'empty' };

export interface AccountSnapshot {
  readonly accountIndex: number | null;
  /** Collateral in USDC, as a number — Lighter reports it as a decimal string. */
  readonly balance: number;
  readonly positions: number;
  readonly openOrders: number;
}

const API_BASE = 'https://mainnet.zklighter.elliot.ai/api/v1';

/**
 * Read the account's collateral, positions and open orders.
 *
 * Lighter's own endpoint, not a chain read, so it does not go through the
 * anon-rpc harness — see the note in lighter.ts.
 */
export async function readAccount(owner: Address): Promise<AccountSnapshot> {
  const accountIndex = await getAccountIndex(owner);
  if (accountIndex === null) {
    return { accountIndex: null, balance: 0, positions: 0, openOrders: 0 };
  }

  const response = await fetch(`${API_BASE}/account?by=index&value=${accountIndex}`);
  if (!response.ok) {
    throw new Error(`Lighter account read failed (${response.status})`);
  }

  const json = (await response.json()) as {
    accounts?: {
      collateral?: string;
      available_balance?: string;
      positions?: unknown[];
    }[];
  };

  const account = json.accounts?.[0];
  const balance = Number(account?.collateral ?? account?.available_balance ?? '0');

  // A position with no size is flat; Lighter keeps the row.
  const positions = (account?.positions ?? []).filter((p) => {
    const size = Number((p as { position?: string }).position ?? '0');
    return Number.isFinite(size) && size !== 0;
  }).length;

  return {
    accountIndex,
    balance: Number.isFinite(balance) ? balance : 0,
    positions,
    // Open orders are not on this payload; the watcher treats positions as the
    // gate and the user closes orders on Lighter's site.
    openOrders: 0,
  };
}

/**
 * What the user should do next.
 *
 * The thresholds matter: below the fast-withdrawal minimum the funds are not
 * stuck, they just have to leave by the slower route that lands on Ethereum —
 * which E7 cannot re-shield, since the paymaster flow is on Arbitrum.
 */
export function adviseExit(snapshot: AccountSnapshot): ExitAdvice {
  if (snapshot.accountIndex === null) return { kind: 'not-funded' };

  if (snapshot.positions > 0 || snapshot.openOrders > 0) {
    return {
      kind: 'has-positions',
      positions: snapshot.positions,
      openOrders: snapshot.openOrders,
    };
  }

  if (snapshot.balance <= 0) return { kind: 'empty' };

  if (snapshot.balance < DUST_USDC) {
    return { kind: 'dust', balance: snapshot.balance };
  }

  // The $1 fast-withdrawal fee is undocumented and may sit on top of the 4
  // USDC minimum, so the threshold is the minimum plus the fee rather than
  // the minimum alone. Being conservative costs a slower withdrawal; being
  // wrong strands the balance mid-withdrawal.
  if (snapshot.balance < MIN_FAST_WITHDRAWAL_USDC + 1) {
    return {
      kind: 'withdraw-secure',
      balance: snapshot.balance,
      reason:
        snapshot.balance >= MIN_SECURE_WITHDRAWAL_USDC
          ? 'Below the fast-withdrawal minimum, so this has to go the secure route — it lands on Ethereum, not Arbitrum.'
          : 'Below every withdrawal minimum.',
    };
  }

  return { kind: 'withdraw-fast', balance: snapshot.balance };
}

/** True once the account holds nothing worth moving. */
export function isExitComplete(advice: ExitAdvice): boolean {
  return advice.kind === 'empty' || advice.kind === 'dust';
}
