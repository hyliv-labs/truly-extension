/** Typed protocol into the background worker. Key material never crosses it. */

import type { Address } from 'viem';
import type { ApprovalRecord } from './approvals';
import type { ActiveTrade } from './trade';
import type { RecoveryState } from './recovery';
import type { TradeStatus } from './orchestrator';
import type { PerpMarket } from './lighter-markets';
import type { RailgunSyncStatus } from './railgun-sync-status';
import type { ShieldedBalance } from './shielded-balance';
import type { Direction, TradeQuote } from './trade-plan';
import type { SessionView } from './trade-session';
import type { TradeSession } from './session-types';
import type { CompoundAccountView } from './compound';
import type { UniswapAccountView } from './uniswap';
import type { IntentsAsset, IntentsDirection, IntentsPreview, IntentsView } from './intents';

/** bigint does not survive the message channel, so margin travels as a string. */
export interface TradeRequestWire {
  marketId?: number;
  direction?: Direction;
  marginUnits: string;
  leverage?: number;
  fundingSource?: 'privacy-pools' | 'railgun';
  /** Fund a new account and stop. The user trades it on the perps site. */
  depositOnly?: boolean;
}

export type Request =
  // Popup
  | { kind: 'status' }
  | { kind: 'createVault'; password: string; mnemonic?: string }
  | { kind: 'unlock'; password: string }
  | { kind: 'lock' }
  | { kind: 'currentOwner' }
  | { kind: 'startTrade' }
  // Connect a waiting site (Lighter) to a fresh owner address, now, without
  // funding it first. Funding attaches to this same trade afterwards.
  | { kind: 'connectToSite'; origin: string }
  | { kind: 'endTrade' }
  /** Retire a trade that is NOT finished, accepting that funds may remain. */
  | { kind: 'abandonTrade' }
  // Content-script relay (E5)
  | {
      kind: 'provider';
      origin: string;
      method: string;
      params: unknown[];
      /** Stable across a worker restart so a retry continues the same prompt. */
      requestId: string;
    }
  // Approval window (E5)
  | { kind: 'getApproval'; id: string }
  | { kind: 'settleApproval'; id: string; approved: boolean }
  // Keeps the worker alive while an approval prompt is open (E5).
  | { kind: 'keepAlive' }
  // Anon-RPC (E2)
  | { kind: 'anonRpcStatus' }
  | { kind: 'anonRpcSelfTest' }
  // Lighter bridge (E4)
  | { kind: 'prepareDeposit' }
  // E3: pull funds from Privacy Pools into this trade's Lighter deposit
  // address. Long-running (proof generation plus relaying), so the popup must
  // not assume a prompt answer.
  | { kind: 'unshield' }
  /** E7: send the owner's USDC back to the pool. Long-running, like unshield. */
  | { kind: 'reshield' }
  | { kind: 'poolBalance' }
  /** Unlock snapshot. `refresh` reads both pools again; otherwise the stored one. */
  | { kind: 'shieldedBalance'; refresh?: boolean }
  // How far the Railgun sync has got; polled by the popup while it waits.
  | { kind: 'railgunSyncStatus' }
  | { kind: 'checkDeposit' }
  // In-extension market trade (JIT funding)
  | { kind: 'markets' }
  // How fast a deposit will credit. Lighter's fast bridge has been at zero
  // capacity on Arbitrum, which means the ~15-20 minute path — and that is
  // the gap between confirming a trade and it being priced.
  | { kind: 'fundingSpeed' }
  | { kind: 'quoteTrade'; trade: TradeRequestWire }
  | { kind: 'openTrade'; trade: TradeRequestWire }
  | { kind: 'tradeSession' }
  | { kind: 'advanceTrade' }
  | { kind: 'retryFunding' }
  | { kind: 'retryOrder' }
  | { kind: 'closePosition' }
  | { kind: 'retryLighterExit' }
  /** Fast-withdraw a funded account and shield the USDC back into its pool. */
  | { kind: 'shieldFunds' }
  /** Unshield USDC onto a fresh address. The user swaps it on app.uniswap.org. */
  | { kind: 'fundUniswap'; amountUnits: string }
  /** Shield whatever that address still holds back into Railgun. */
  | { kind: 'shieldUniswap' }
  /** Unshield USDC onto a fresh address. The user supplies it on app.compound.xyz. */
  | { kind: 'fundCompound'; amountUnits: string }
  /** Shield whatever that address still holds, once the Compound position is empty. */
  | { kind: 'shieldCompound' }
  /** Starts the WASM signer in the worker and signs a throwaway order offline. */
  | { kind: 'lighterSignerSelfTest' }
  // NEAR Intents (1Click): private exit to any chain, private entry from any chain
  | { kind: 'intentsAssets' }
  | {
      kind: 'intentsPreview';
      direction: IntentsDirection;
      assetId: string;
      /** Exit: gross USDC units out of Railgun. Entry: origin-asset units. */
      amountUnits: string;
      /** Exit: the user's address on the destination chain. Entry: their refund address on the origin chain. */
      address: string;
    }
  | { kind: 'intentsStartExit'; assetId: string; grossUnits: string; recipient: string }
  | { kind: 'intentsStartEntry'; assetId: string; amountUnits: string; refundTo: string }
  | { kind: 'intentsAdvance' }
  | { kind: 'intentsDepositSent'; txHash: string }
  | { kind: 'intentsRetry' }
  | { kind: 'intentsDismiss' }
  /** The user's own 1Click partner key. Only whether one is set comes back. */
  | { kind: 'intentsSetKey'; key: string | null }
  | { kind: 'intentsKeyStatus' }
  // Orchestrator (E8)
  | { kind: 'tradeStatus' }
  | { kind: 'scanStranded' }
  // MetaMask recovery, run as a background job (E-recovery)
  | { kind: 'metamaskRecoverStart'; password: string; version: 'v1' | 'v2' }
  | { kind: 'metamaskRecoverStatus' }
  | { kind: 'metamaskRecoverClear' }
  // Recovering an existing Privacy Pools account (wallet-signature type)
  | { kind: 'seedTypedData'; address: string; version: 'v1' | 'v2' }
  | {
      kind: 'importWalletSeed';
      password: string;
      address: string;
      version: 'v1' | 'v2';
      signature: string;
    };

export interface AnonRpcStatus {
  reads: number;
  /** Non-empty means money-moving steps are blocked; each entry says why. */
  problems: { key: string; reason: string }[];
}

export interface SelfTestResult {
  blockNumber: string;
  usdcBalance: string;
}

export interface VaultStatus {
  hasVault: boolean;
  unlocked: boolean;
  ownerIndex: number;
  activeTrade: ActiveTrade | null;
}

export type Response<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ResultMap {
  status: VaultStatus;
  createVault: { mnemonic: string };
  unlock: null;
  lock: null;
  /** Address only — the private key stays in the worker. */
  currentOwner: { index: number; address: Address };
  startTrade: ActiveTrade;
  endTrade: null;
  abandonTrade: null;
  provider: unknown;
  getApproval: ApprovalRecord | null;
  settleApproval: null;
  keepAlive: null;
  anonRpcStatus: AnonRpcStatus;
  anonRpcSelfTest: SelfTestResult;
  tradeStatus: TradeStatus | null;
  scanStranded: { index: number; address: string; balance: string }[];
  metamaskRecoverStart: null;
  metamaskRecoverStatus: RecoveryState;
  metamaskRecoverClear: null;
  seedTypedData: { json: string };
  importWalletSeed: { mnemonic: string };
  prepareDeposit: { intentAddress: string };
  unshield: {
    txHash?: string;
    amountUnits: string;
    expectedNetUnits: string;
    remainderUnits: string;
    feeBPS: string;
    recipient: string;
  };
  reshield: {
    userOpHash: string;
    deposited: string;
    depositIndex: number;
  };
  poolBalance: {
    totalUnits: string;
    noteCount: number;
    /** Largest note, which bounds what a single trade can draw. */
    largestUnits: string;
  };
  shieldedBalance: ShieldedBalance;
  checkDeposit: {
    complete: boolean;
    status: string;
    description: string;
    accountIndex: number | null;
  };
  markets: PerpMarket[];
  connectToSite: { ownerAddress: string };
  railgunSyncStatus: RailgunSyncStatus;
  fundingSpeed: { fastBridgeLimit: string; fast: boolean };
  quoteTrade: TradeQuote;
  openTrade: TradeSession;
  tradeSession: SessionView | null;
  advanceTrade: SessionView | null;
  retryFunding: null;
  retryOrder: SessionView | null;
  closePosition: SessionView | null;
  retryLighterExit: SessionView | null;
  shieldFunds: SessionView | null;
  fundUniswap: UniswapAccountView;
  shieldUniswap: UniswapAccountView;
  fundCompound: CompoundAccountView;
  shieldCompound: CompoundAccountView;
  lighterSignerSelfTest: { txType: number; txHash: string; loadMs: number };
  intentsAssets: IntentsAsset[];
  intentsPreview: IntentsPreview;
  intentsStartExit: IntentsView;
  intentsStartEntry: IntentsView;
  intentsAdvance: IntentsView | null;
  intentsDepositSent: IntentsView;
  intentsRetry: IntentsView;
  intentsDismiss: null;
  intentsSetKey: { confidential: boolean };
  intentsKeyStatus: { confidential: boolean };
}

/**
 * Default timeout for a request to the background worker.
 *
 * SHORT on purpose. Most requests only touch chrome.storage and answer in
 * milliseconds, so if one of those has not come back in a few seconds the
 * worker is not slow — it is not there. Diagnosing that must not take two
 * minutes of staring at 'Loading…'.
 *
 * The genuinely slow calls pass their own timeout: see SLOW_TIMEOUT_MS.
 */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * For requests that really do take a while: a pool scan is 12 eth_getLogs
 * over Tor, a withdrawal builds a proof and relays it, and tor-js has to
 * bootstrap a circuit before the first read of all.
 */
export const SLOW_TIMEOUT_MS = 180_000;

export class BackgroundUnreachable extends Error {
  constructor(kind: string, ms: number) {
    super(
      `The background worker did not answer '${kind}' within ${Math.round(ms / 1000)}s. ` +
        'Check chrome://extensions — if the Truly card shows no "service worker" link, it failed to start.',
    );
    this.name = 'BackgroundUnreachable';
  }
}

export async function send<K extends Request['kind']>(
  request: Extract<Request, { kind: K }>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ResultMap[K]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BackgroundUnreachable(request.kind, timeoutMs)), timeoutMs);
  });

  try {
    const response = (await Promise.race([
      chrome.runtime.sendMessage(request),
      timeout,
    ])) as Response<ResultMap[K]> | undefined;

    // sendMessage resolves with undefined when nothing answered — a dead or
    // never-started worker looks exactly like this.
    if (response === undefined) {
      throw new BackgroundUnreachable(request.kind, 0);
    }
    if (!response.ok) throw new Error(response.error ?? 'no response');
    return response.value;
  } finally {
    clearTimeout(timer);
  }
}
