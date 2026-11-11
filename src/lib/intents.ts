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

/** The slice of the active trade these rules read. Structural, so this file needs no chrome. */
export interface IntentsTradeLike {
  readonly venue?: string;
  readonly intents?: IntentsView;
  readonly withdrawal?: { readonly status: string };
}

/**
 * What a 1Click status means for the move. Pure: the worker applies it.
 * `then` says what to start after saving: a shield back, or retiring the owner.
 */
export function nextFromStatus(
  view: IntentsView,
  status: SwapStatus,
  now = Date.now(),
): { stage: IntentsStage; then?: 'shield' | 'finish'; error?: string; detail?: string } {
  switch (status) {
    case 'PENDING_DEPOSIT':
      if (view.direction === 'entry' && Date.parse(view.inactiveAt) < now) {
        return {
          stage: 'failed',
          error: 'The deposit address expired with nothing received. Do not send to it any more. Cancel and start again.',
        };
      }
      return { stage: view.direction === 'entry' ? 'awaiting-deposit' : 'swapping' };
    case 'KNOWN_DEPOSIT_TX':
    case 'PROCESSING':
    case 'INCOMPLETE_DEPOSIT':
      return { stage: 'swapping' };
    case 'SUCCESS':
      return view.direction === 'exit'
        ? { stage: 'done', then: 'finish' }
        : { stage: 'shielding', then: 'shield', detail: 'USDC arrived at the fresh address. Shielding it into Railgun.' };
    case 'REFUNDED':
      return view.direction === 'exit'
        ? { stage: 'shielding', then: 'shield', detail: 'The swap did not fill. Shielding the refunded USDC back into Railgun.' }
        : { stage: 'refunded', then: 'finish' };
    case 'FAILED':
      return { stage: 'failed', error: 'NEAR Intents reported the swap as failed. Retry checks for USDC at the fresh address and shields it back.' };
    default:
      return { stage: view.stage };
  }
}

/**
 * An exit still 'unshielding' with no worker running it and no withdrawal
 * record was cut off before anything was signed (a worker restart mid-proof).
 * Nothing will resume it on its own, so it must surface as failed for Retry.
 */
export function exitInterrupted(trade: IntentsTradeLike, running: boolean): boolean {
  return trade.intents?.direction === 'exit' && trade.intents.stage === 'unshielding' && !running && !trade.withdrawal;
}

/**
 * Why abandoning now would strand money, or null if it would not. A retired
 * owner is still reachable from the phrase, but nothing would watch it.
 */
export function intentsAbandonBlocker(trade: IntentsTradeLike | null): string | null {
  const view = trade?.venue === 'intents' ? trade.intents : undefined;
  if (!view || view.stage === 'done' || view.stage === 'refunded') return null;
  if (view.direction === 'exit' && (trade?.withdrawal || view.unshieldTx)) {
    return 'The unshield already went to NEAR Intents. Wait for delivery or the refund; abandoning now would stop Ghosty from shielding a refund back.';
  }
  if (view.direction === 'entry' && (view.stage === 'swapping' || view.stage === 'shielding' || view.userDepositTx)) {
    return 'Your deposit is with NEAR Intents. Wait for it to land and be shielded; abandoning now would leave the USDC at an address nothing watches.';
  }
  return null;
}

export function intentsNeedsTick(trade: IntentsTradeLike | null): boolean {
  const stage = trade?.venue === 'intents' ? trade.intents?.stage : undefined;
  return stage !== undefined && LIVE_INTENTS_STAGES.includes(stage);
}

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
