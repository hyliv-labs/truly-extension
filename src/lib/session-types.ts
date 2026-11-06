/**
 * The trade session record: one trade, one fresh owner, one Lighter account,
 * one funding withdrawal and one re-shield. It lives inside the active trade
 * (see trade.ts), so it can never be attached to a different owner, and it is
 * archived with that trade when the trade ends.
 */

import type { SealedApiKey } from './lighter-keys';
import type { Direction, TradeQuote } from './trade-plan';

export type SessionState =
  /** Withdrawing the margin from Privacy Pools to the Lighter intent address. */
  | 'funding'
  /** Nothing left the pool (or it provably did not land). Safe to retry. */
  | 'funding-failed'
  | 'awaiting-deposit'
  /** Lighter reports the deposit failed or claimable. Needs a human. */
  | 'deposit-problem'
  /** Deposit credited. The user trades this account on the perps site. */
  | 'funded'
  | 'registering-key'
  | 'setting-leverage'
  | 'submitting-order'
  /** Sent, outcome not yet proven. Truly checks; it does not resubmit. */
  | 'order-uncertain'
  /** Funded, no position. Safe recovery: retry only after a status check, or exit. */
  | 'order-failed'
  | 'open'
  | 'closing'
  | 'close-failed'
  /** Flat on Lighter. A fast withdrawal is signed and being sent once. */
  | 'withdrawing'
  /** The stored withdrawal was refused or expired unsent. A new one is allowed. */
  | 'withdraw-failed'
  /** Lighter accepted the withdrawal. USDC is on its way to the owner. */
  | 'exited'
  /** Owner USDC is being deposited back into the pool. */
  | 'reshielding'
  /** Re-shield confirmed. The trade can be retired. */
  | 'complete'
  /** Flat, and the balance cannot take the fast route. */
  | 'closed';

export interface SubmittedTx {
  readonly txType: number;
  readonly txInfo: string;
  /** Computed offline by the signer, so it is known before the send. */
  readonly txHash: string;
  readonly nonce: number;
  readonly status: 'signed' | 'accepted' | 'rejected' | 'uncertain' | 'expired';
  readonly signedAt: number;
  readonly sentAt?: number;
  readonly code?: number;
  readonly message?: string;
}

export interface ExecutionResult {
  readonly orderIndex: number;
  /** Lighter's own status string, e.g. "filled" or "canceled-not-enough-liquidity". */
  readonly lighterStatus: string;
  readonly state: 'filled' | 'partially-filled' | 'unfilled';
  readonly filledBase: number;
  readonly filledQuote: number;
  readonly averagePrice: number | null;
  readonly feesUsd: number;
  readonly fillCount: number;
  readonly confirmedAt: number;
}

export interface OrderAttempt {
  readonly purpose: 'open' | 'close';
  readonly clientOrderIndex: number;
  readonly marketId: number;
  readonly isAsk: boolean;
  readonly reduceOnly: boolean;
  readonly baseAmount: number;
  readonly baseAmountScaled: number;
  readonly worstPrice: number;
  readonly worstPriceScaled: number;
  readonly marginUsd?: number;
  readonly notionalUsd?: number;
  readonly tx: SubmittedTx;
  readonly execution?: ExecutionResult;
}

export interface TradeSession {
  /** trade_session_id. */
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly marketId: number;
  readonly symbol: string;
  readonly direction: Direction;
  readonly leverage: number;
  readonly marginUnits: string;
  /** What the user confirmed. Kept verbatim for the record. */
  readonly quote: TradeQuote;

  readonly state: SessionState;
  readonly detail: string;
  readonly error?: { readonly code: string; readonly message: string; readonly at: number };
  /** Set when progress needs the vault unlocked. */
  readonly blocked?: 'locked';

  /** Collateral Lighter actually credited, read from the account. */
  readonly creditedUsd?: number;
  /**
   * Collateral already on the owner's Lighter account when the session
   * opened (0 when it had none). The deposit counts as credited only once
   * the collateral rises above this. Absent on sessions opened before it.
   */
  readonly baselineCollateralUsd?: number;

  readonly apiKey?: {
    readonly index: number;
    readonly publicKey: string;
    readonly sealed: SealedApiKey;
    readonly tx?: SubmittedTx;
    readonly registeredAt?: number;
  };
  readonly leverageTx?: SubmittedTx;
  readonly leverageSetAt?: number;

  readonly order?: OrderAttempt;
  /** Earlier open attempts that provably did not open a position. */
  readonly failedOrders?: OrderAttempt[];
  readonly close?: OrderAttempt;
  readonly closeHistory?: OrderAttempt[];
  /**
   * The one fast withdrawal off Lighter. Same rule as an order: signed once,
   * resent only as these exact bytes.
   */
  readonly exitTx?: SubmittedTx & {
    readonly amountUnits: string;
    /** Set for a fast withdrawal. Absent on a secure withdrawal, which is not sent. */
    readonly toAddress?: string;
  };
  readonly closedAt?: number;
}

/** States the background keeps ticking for. The rest wait on the user. */
export const ACTIVE_SESSION_STATES: readonly SessionState[] = [
  'funding',
  'awaiting-deposit',
  'registering-key',
  'setting-leverage',
  'submitting-order',
  'order-uncertain',
  'closing',
  'withdrawing',
  'exited',
  'reshielding',
];
