/**
 * What the panel knows about a NEAR Intents move. Saved on the active trade,
 * so a closed panel, a worker restart or a retry all continue the same move.
 *
 *   exit:  Railgun -> fresh owner signs an unshield straight to a 1Click
 *          deposit address -> delivered on the destination chain. A refund
 *          comes back to the fresh owner and is shielded again.
 *   entry: the user pays a 1Click deposit address from any chain, usually
 *          from their own private wallet (Zashi, an Aleo wallet) -> USDC
 *          arrives at a fresh owner on Arbitrum -> shielded into Railgun.
 */

import type { ChainTx, SwapStatus } from './near-intents';

export type IntentsDirection = 'exit' | 'entry';

export type IntentsStage =
  /** Exit: the Railgun proof is being built, or the unshield is in flight. */
  | 'unshielding'
  /** Entry: the deposit address is shown and 1Click has not seen funds yet. */
  | 'awaiting-deposit'
  /** 1Click has the deposit; solvers are filling it. */
  | 'swapping'
  /** USDC is at the fresh owner and is going into Railgun. */
  | 'shielding'
  | 'done'
  /** Terminal: nothing was delivered and nothing is left at the owner. */
  | 'refunded'
  | 'failed';

export interface IntentsView {
  readonly direction: IntentsDirection;
  readonly stage: IntentsStage;
  readonly detail: string;
  readonly error?: string;

  readonly originAsset: string;
  readonly originLabel: string;
  readonly originDecimals: number;
  readonly destinationAsset: string;
  readonly destinationLabel: string;
  readonly destinationDecimals: number;

  /** Who receives on the destination chain. Exit: the user's address. Entry: the fresh owner. */
  readonly recipient: string;
  /** Who 1Click refunds on the origin chain. Exit: the fresh owner. Entry: the user's address. */
  readonly refundTo: string;
  /** Origin units that must land on the deposit address (EXACT_INPUT). */
  readonly amountIn: string;
  /** Exit only: what leaves the Railgun balance, before Railgun's fee. */
  readonly grossUnits?: string;
  readonly confidential: boolean;

  readonly depositAddress: string;
  readonly depositMemo?: string | null;
  readonly amountOut: string;
  readonly minAmountOut: string;
  readonly timeEstimate: number;
  /** When 1Click stops watching the deposit address. */
  readonly inactiveAt: string;
  /** When 1Click starts refunding if the swap has not completed. */
  readonly refundAfter: string;
  readonly correlationId: string;
  /** 1Click's signature over the quote. Kept for a dispute. */
  readonly quoteSignature: string;
  readonly quotedAt: number;

  readonly swapStatus?: SwapStatus;
  readonly unshieldTx?: string;
  /** Entry: the user's own deposit transaction, if they pasted it. */
  readonly userDepositTx?: string;
  readonly destinationTx?: ChainTx;
  readonly refundedAmount?: string;
  readonly shieldTx?: string;
  readonly updatedAt: number;
}

/** Stages the extension still has work to do in, or is waiting on 1Click. */
export const LIVE_INTENTS_STAGES: readonly IntentsStage[] = ['unshielding', 'awaiting-deposit', 'swapping', 'shielding'];

export interface IntentsPreview {
  readonly direction: IntentsDirection;
  readonly amountIn: string;
  readonly amountInFormatted: string;
  /** Exit: what leaves Railgun, and Railgun's cut of it. */
  readonly grossUnits?: string;
  readonly railgunFeeUnits?: string;
  readonly amountOut: string;
  readonly amountOutFormatted: string;
  readonly minAmountOutFormatted: string;
  readonly timeEstimate: number;
  readonly confidential: boolean;
}

export interface IntentsAsset {
  readonly assetId: string;
  readonly label: string;
  readonly symbol: string;
  readonly blockchain: string;
  readonly decimals: number;
  readonly privacy: boolean;
}
