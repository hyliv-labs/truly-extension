/** Typed protocol into the background worker. Key material never crosses it. */

import type { Address } from 'viem';
import type { ApprovalRecord } from './approvals';
import type { ActiveTrade } from './trade';
import type { RecoveryState } from './recovery';
import type { TradeStatus } from './orchestrator';
import type { PerpMarket } from './lighter-markets';
import type { Direction, TradeQuote } from './trade-plan';
import type { SessionView } from './trade-session';
import type { TradeSession } from './session-types';

/** bigint does not survive the message channel, so margin travels as a string. */
export interface TradeRequestWire {
  marketId: number;
  direction: Direction;
  marginUnits: string;
  leverage: number;
}

export type Request =
  // Popup
  | { kind: 'status' }
  | { kind: 'createVault'; password: string; mnemonic?: string }
  | { kind: 'unlock'; password: string }
  | { kind: 'lock' }
  | { kind: 'currentOwner' }
  | { kind: 'startTrade' }
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
  | { kind: 'checkDeposit' }
  // In-extension market trade (JIT funding)
  | { kind: 'markets' }
  | { kind: 'quoteTrade'; trade: TradeRequestWire }
  | { kind: 'openTrade'; trade: TradeRequestWire }
  | { kind: 'tradeSession' }
  | { kind: 'advanceTrade' }
  | { kind: 'retryFunding' }
  | { kind: 'retryOrder' }
  | { kind: 'closePosition' }
  /** Starts the WASM signer in the worker and signs a throwaway order offline. */
  | { kind: 'lighterSignerSelfTest' }
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
  checkDeposit: {
    complete: boolean;
    status: string;
    description: string;
    accountIndex: number | null;
  };
  markets: PerpMarket[];
  quoteTrade: TradeQuote;
  openTrade: TradeSession;
  tradeSession: SessionView | null;
  advanceTrade: SessionView | null;
  retryFunding: null;
  retryOrder: SessionView | null;
  closePosition: SessionView | null;
  lighterSignerSelfTest: { txType: number; txHash: string; loadMs: number };
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
