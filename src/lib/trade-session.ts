/**
 * Just-in-time market trade: validate, fund a fresh owner from Privacy Pools,
 * wait for Lighter to credit it, then place ONE market order — and later close
 * it — with Lighter's official signer.
 *
 * Same rule as the rest of the orchestrator: the session record IS the state.
 * Every step persists what it is about to do before doing it, and every step
 * is safe to run again after a worker teardown:
 *
 *   - Funding reuses unshieldForTrade, whose pending record prevents a second
 *     withdrawal to the same intent address.
 *   - Every Lighter transaction is signed ONCE, stored with its offline hash
 *     and nonce, and only ever re-sent as the identical bytes. Lighter's nonce
 *     makes a resend unable to execute twice. A new signature (new nonce) is
 *     made only after the old one is provably dead: refused, or expired
 *     without its nonce being consumed.
 *   - An order's outcome comes from Lighter's order record and fills, never
 *     from sendTx's 200, and never assumed.
 *
 * Lighter calls go to Lighter's API directly. Arbitrum reads and broadcasts
 * stay on the anon-rpc transport inside the reused funding and re-shield code.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { ownerAt } from './vault';
import { getActiveTrade, startTrade, updateActiveTrade, updateSession, type ActiveTrade } from './trade';
import { prepareDeposit, checkDeposit } from './deposit';
import { resolvePendingWithdrawal, scanNotesByApproval, unshieldForTrade } from './unshield';
import { fetchMarket, fetchTopOfBook, referencePrice } from './lighter-markets';
import {
  createAuthToken,
  generateApiKey,
  signChangePubKey,
  signMarketOrder,
  signUpdateLeverage,
  txExpiresAt,
  withL1Signature,
  type SignedTx,
  type SignerAccount,
} from './lighter-signer';
import { openApiKey, sealApiKey } from './lighter-keys';
import {
  fetchOrderFills,
  findOrderByClientIndex,
  isApiKeyRegistered,
  lookupTx,
  nextNonce,
  readTradingAccount,
  sendTx,
  type LighterPosition,
  type TradingAccount,
} from './lighter-trading';
import {
  TradeValidationError,
  checkRequest,
  classifyOrder,
  marginFractionFor,
  sizeCloseOrder,
  sizeMarketOrder,
  validateTrade,
  type TradeQuote,
  type TradeRequest,
} from './trade-plan';
import type { ExecutionResult, OrderAttempt, SessionState, SubmittedTx, TradeSession } from './session-types';

/**
 * Lighter reserves the low key slots for its own apps; 4 is the first index
 * free for API use, and a fresh account has nothing there.
 */
export const API_KEY_INDEX = 4;

/** An accepted order with no order record after this is reported, not retried. */
const ORDER_LOOKUP_GRACE_MS = 3 * 60_000;

/** A signed tx is dead this long after its ExpiredAt, if its nonce is unused. */
const EXPIRY_MARGIN_MS = 30_000;

export class SessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

// ---------------------------------------------------------------------------
// Quote and open
// ---------------------------------------------------------------------------

/** Validate against live market data and the spendable (ASP-approved) balance. */
export async function quoteTrade(request: TradeRequest): Promise<TradeQuote> {
  const market = await fetchMarket(request.marketId);
  // Cheap rules first: a bad leverage must not wait on a pool scan over Tor.
  checkRequest(market, request, referencePrice(market));
  const notes = await scanNotesByApproval();
  return validateTrade({
    market,
    request,
    referencePrice: referencePrice(market),
    approvedNotes: notes.approved,
    pendingNotes: notes.pending,
  });
}

/**
 * Start a session: re-validate, take a FRESH owner, get its intent address.
 * Returns before funding — runFunding() moves money and can take minutes.
 */
export async function openTradeSession(request: TradeRequest): Promise<TradeSession> {
  if (await getActiveTrade()) {
    throw new SessionError('trade-active', 'A trade is already active. Finish or abandon it first.');
  }
  // Re-validated here, not trusted from the popup: balances and markets move.
  const quote = await quoteTrade(request);

  const trade = await startTrade();
  const now = Date.now();
  const session: TradeSession = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    marketId: quote.marketId,
    symbol: quote.symbol,
    direction: quote.direction,
    leverage: quote.leverage,
    marginUnits: quote.marginUnits,
    quote,
    state: 'funding',
    detail: 'Getting a Lighter deposit address for a fresh owner.',
  };
  await updateActiveTrade({ session });

  try {
    await prepareDeposit();
  } catch (error) {
    await transition(session.id, 'funding-failed', 'Lighter did not issue a deposit address. Nothing was withdrawn.', {
      code: 'lighter-deposit-address',
      message: messageOf(error),
    });
    throw error;
  }
  console.info('[truly] session', session.id, 'owner', trade.ownerIndex);
  return (await getSession())!;
}

let fundingRunning = false;

/**
 * Withdraw the margin from Privacy Pools to the intent address. Proof is built
 * locally (offscreen), the relayer quotes and submits, receipts are read over
 * anon-rpc. Never retried automatically.
 */
export async function runFunding(): Promise<void> {
  if (fundingRunning) return;
  const session = await requireSession();
  if (session.state !== 'funding' && session.state !== 'funding-failed') return;

  fundingRunning = true;
  try {
    await transition(session.id, 'funding', 'Building the withdrawal proof and relaying it. This takes a minute or two.');
    const result = await unshieldForTrade(BigInt(session.quote.grossWithdrawalUnits));
    await transition(
      session.id,
      'awaiting-deposit',
      `Withdrew ${usd(result.amountUnits)} USDC from Privacy Pools (tx ${short(result.txHash)}). Waiting for Lighter to credit it.`,
    );
  } catch (error) {
    const trade = await getActiveTrade();
    const withdrawal = trade?.withdrawal;
    if (withdrawal?.status === 'confirmed') {
      await transition(session.id, 'awaiting-deposit', 'Funding confirmed. Waiting for Lighter to credit it.');
    } else if (withdrawal?.status === 'pending') {
      // Possibly broadcast. The tick settles it against the chain; a retry
      // from here could pay the same intent address twice.
      await transition(session.id, 'funding', 'Funding outcome is being checked against the chain. Do not retry.', {
        code: classifyFundingError(error),
        message: messageOf(error),
      });
    } else {
      await transition(session.id, 'funding-failed', 'Nothing left the pool. You can retry funding or abandon this trade.', {
        code: classifyFundingError(error),
        message: messageOf(error),
      });
    }
  } finally {
    fundingRunning = false;
  }
}

/** Map a funding failure to the error the spec names. */
export function classifyFundingError(error: unknown): string {
  const m = messageOf(error).toLowerCase();
  if (/asp|not yet been approved|waiting for asp/.test(m)) return 'pending-asp';
  if (/no spendable|not large enough|insufficient|no note/.test(m)) return 'insufficient-balance';
  if (/proof|prove|circuit|snark/.test(m)) return 'proof-failed';
  if (/relayer/.test(m)) return 'relayer-rejected';
  if (/timed? ?out|timeout|anon-rpc|did not answer/.test(m)) return 'anon-rpc-timeout';
  if (/revert/.test(m)) return 'arbitrum-revert';
  return 'funding-error';
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

let advancing: Promise<TradeSession | null> | null = null;

/** One step of progress. Single-flight per worker; safe to call at any time. */
export function advanceSession(): Promise<TradeSession | null> {
  advancing ??= step().finally(() => {
    advancing = null;
  });
  return advancing;
}

async function step(): Promise<TradeSession | null> {
  const trade = await getActiveTrade();
  const session = trade?.session;
  if (!trade || !session) return null;

  try {
    switch (session.state) {
      case 'funding':
        await stepFunding(trade, session);
        break;
      case 'awaiting-deposit':
        await stepDeposit(trade, session);
        break;
      case 'registering-key':
        await stepRegisterKey(trade, session);
        break;
      case 'setting-leverage':
        await stepLeverage(trade, session);
        break;
      case 'submitting-order':
      case 'order-uncertain':
        await stepOrder(trade, session);
        break;
      case 'closing':
        await stepClose(trade, session);
        break;
      default:
        break;
    }
    const after = await getSession();
    if (after?.blocked) await updateSession(after.id, () => ({ blocked: undefined }));
  } catch (error) {
    if (messageOf(error) === 'locked') {
      await updateSession(session.id, () => ({ blocked: 'locked' }));
    } else if (error instanceof SessionError || error instanceof TradeValidationError) {
      throw error;
    } else {
      // Reads and idempotent sends: keep the state, show why, try next tick.
      await updateSession(session.id, () => ({
        error: { code: 'transient', message: messageOf(error), at: Date.now() },
      }));
      console.warn('[truly] session step failed; will retry', error);
    }
  }
  return getSession();
}

async function stepFunding(trade: ActiveTrade, session: TradeSession): Promise<void> {
  if (fundingRunning) return;
  if (trade.withdrawal?.status === 'confirmed') {
    await transition(session.id, 'awaiting-deposit', 'Funding confirmed. Waiting for Lighter to credit it.');
    return;
  }
  if (trade.withdrawal?.status === 'pending') {
    const outcome = await resolvePendingWithdrawal();
    if (outcome === 'landed') {
      await transition(session.id, 'awaiting-deposit', 'Funding confirmed on chain. Waiting for Lighter to credit it.');
    } else if (outcome === 'did-not-land') {
      await transition(session.id, 'funding-failed', 'The funding withdrawal did not land. Nothing left the pool; retry is safe.');
    }
    return;
  }
  // No record at all: the worker died before the withdrawal began.
  if (trade.intentAddress) {
    await transition(session.id, 'funding-failed', 'Funding was interrupted before anything was withdrawn. Retry is safe.');
  }
}

async function stepDeposit(trade: ActiveTrade, session: TradeSession): Promise<void> {
  const progress = await checkDeposit();
  if (progress.failed || progress.claimable) {
    await transition(
      session.id,
      'deposit-problem',
      progress.claimable
        ? 'Lighter marks the deposit claimable: the funds arrived but need claiming on Lighter. Nothing will be traded.'
        : `Lighter reports the deposit failed (${progress.status}). The funds were withdrawn from the pool; check Lighter before anything else.`,
      { code: 'lighter-deposit-failed', message: progress.description },
    );
    return;
  }
  if (progress.accountIndex === null) {
    await updateSession(session.id, () => ({
      detail: `Waiting for Lighter to credit the deposit: ${progress.description || progress.status}. Usually 15–20 minutes.`,
    }));
    return;
  }

  const account = await readTradingAccount(progress.accountIndex);
  if (!(account.collateral > 0)) {
    await updateSession(session.id, () => ({
      detail: `Lighter account #${account.accountIndex} exists; waiting for the collateral to show.`,
    }));
    return;
  }
  await updateSession(session.id, () => ({ creditedUsd: account.collateral }));
  await transition(
    session.id,
    'registering-key',
    `Lighter credited ${account.collateral.toFixed(2)} USDC to account #${account.accountIndex}. Authorising a trading key.`,
  );
}

async function stepRegisterKey(trade: ActiveTrade, session: TradeSession): Promise<void> {
  const accountIndex = requireAccount(trade);
  const owner = await ownerAt(trade.ownerIndex);

  let apiKey = session.apiKey;
  if (!apiKey) {
    const pair = await generateApiKey();
    apiKey = {
      index: API_KEY_INDEX,
      publicKey: pair.publicKey,
      sealed: await sealApiKey(owner.privateKey, accountIndex, pair.privateKey),
    };
    await updateSession(session.id, () => ({ apiKey }));
  }

  if (await isApiKeyRegistered(accountIndex, apiKey.index, apiKey.publicKey)) {
    await updateSession(session.id, (s) => ({ apiKey: { ...s.apiKey!, registeredAt: Date.now() } }));
    await transition(session.id, 'setting-leverage', `Trading key authorised. Setting ${session.leverage}x leverage.`);
    return;
  }

  const signer = await signerFor(trade, { ...session, apiKey });
  let tx = apiKey.tx;
  if (!tx || tx.status === 'expired') {
    const nonce = await nextNonce(accountIndex, apiKey.index);
    const unsigned = await signChangePubKey(signer, apiKey.publicKey, nonce);
    const l1 = await privateKeyToAccount(owner.privateKey).signMessage({ message: unsigned.messageToSign });
    tx = record(withL1Signature(unsigned, l1), nonce);
    const toSave = tx;
    await updateSession(session.id, (s) => ({ apiKey: { ...s.apiKey!, tx: toSave } }));
  }

  if (tx.status === 'rejected') {
    await transition(session.id, 'order-failed', 'Lighter refused the trading-key authorisation. No order was placed.', {
      code: 'key-registration-rejected',
      message: tx.message ?? 'rejected',
    });
    return;
  }

  const next = await driveTx(tx, accountIndex, apiKey.index);
  await updateSession(session.id, (s) => ({ apiKey: { ...s.apiKey!, tx: next } }));
  if (await isApiKeyRegistered(accountIndex, apiKey.index, apiKey.publicKey)) {
    await updateSession(session.id, (s) => ({ apiKey: { ...s.apiKey!, registeredAt: Date.now() } }));
    await transition(session.id, 'setting-leverage', `Trading key authorised. Setting ${session.leverage}x leverage.`);
  } else if (next.status === 'rejected') {
    await transition(session.id, 'order-failed', 'Lighter refused the trading-key authorisation. No order was placed.', {
      code: 'key-registration-rejected',
      message: next.message ?? 'rejected',
    });
  } else if (next.status === 'accepted' && Date.now() - (next.sentAt ?? next.signedAt) > ORDER_LOOKUP_GRACE_MS) {
    // Sequenced but never took effect: executing it failed on Lighter's side.
    await transition(session.id, 'order-failed', 'Lighter sequenced the trading-key authorisation but the key never appeared. No order was placed.', {
      code: 'key-registration-failed',
      message: next.message ?? 'not registered',
    });
  }
}

async function stepLeverage(trade: ActiveTrade, session: TradeSession): Promise<void> {
  const accountIndex = requireAccount(trade);
  const signer = await signerFor(trade, session);

  let tx = session.leverageTx;
  if (!tx || tx.status === 'expired') {
    // Re-read: the cap is the market's current one, not the quote's.
    const market = await fetchMarket(session.marketId);
    if (session.leverage > market.maxLeverage) {
      await transition(session.id, 'order-failed', `${market.symbol} now allows at most ${market.maxLeverage}x. No order was placed.`, {
        code: 'invalid-leverage',
        message: `requested ${session.leverage}x`,
      });
      return;
    }
    const nonce = await nextNonce(accountIndex, signer.apiKeyIndex);
    tx = record(await signUpdateLeverage(signer, session.marketId, marginFractionFor(session.leverage), nonce), nonce);
    const toSave = tx;
    await updateSession(session.id, () => ({ leverageTx: toSave }));
  }

  const next = await driveTx(tx, accountIndex, signer.apiKeyIndex);
  await updateSession(session.id, () => ({ leverageTx: next }));
  if (next.status === 'accepted') {
    await updateSession(session.id, () => ({ leverageSetAt: Date.now() }));
    await transition(session.id, 'submitting-order', `Leverage set to ${session.leverage}x. Submitting the market order.`);
  } else if (next.status === 'rejected') {
    await transition(session.id, 'order-failed', 'Lighter refused the leverage change. No order was placed.', {
      code: 'invalid-leverage',
      message: next.message ?? 'rejected',
    });
  }
}

async function stepOrder(trade: ActiveTrade, session: TradeSession): Promise<void> {
  const accountIndex = requireAccount(trade);
  const signer = await signerFor(trade, session);

  let attempt = session.order;
  if (!attempt) {
    const market = await fetchMarket(session.marketId);
    const book = await fetchTopOfBook(session.marketId);
    const account = await readTradingAccount(accountIndex);
    let sizing: ReturnType<typeof sizeMarketOrder>;
    try {
      sizing = sizeMarketOrder({
        market,
        direction: session.direction,
        leverage: session.leverage,
        requestedMarginUsd: Number(session.marginUnits) / 1e6,
        creditedUsd: account.availableBalance,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
      });
    } catch (error) {
      if (!(error instanceof TradeValidationError)) throw error;
      const code = error.code === 'below-min-notional' || error.code === 'below-min-size' ? 'insufficient-credited-balance' : error.code;
      await transition(session.id, 'order-failed', 'The order could not be sized from what Lighter credited. Funds are on Lighter; no order was sent.', {
        code,
        message: error.message,
      });
      return;
    }

    const nonce = await nextNonce(accountIndex, signer.apiKeyIndex);
    const clientOrderIndex = newClientOrderIndex();
    const params = {
      marketIndex: session.marketId,
      clientOrderIndex,
      baseAmount: sizing.baseAmountScaled,
      price: sizing.worstPriceScaled,
      isAsk: session.direction === 'short',
      reduceOnly: false,
    };
    attempt = {
      purpose: 'open',
      clientOrderIndex,
      marketId: session.marketId,
      isAsk: params.isAsk,
      reduceOnly: false,
      baseAmount: sizing.baseAmount,
      baseAmountScaled: sizing.baseAmountScaled,
      worstPrice: sizing.worstPrice,
      worstPriceScaled: sizing.worstPriceScaled,
      marginUsd: sizing.marginUsd,
      notionalUsd: sizing.notionalUsd,
      tx: record(await signMarketOrder(signer, params, nonce), nonce),
    };
    // Persisted BEFORE the send: this record is the duplicate-order guard.
    const toSave = attempt;
    await updateSession(session.id, () => ({ order: toSave }));
  }

  const result = await settleOrder(signer, attempt, accountIndex);
  await updateSession(session.id, () => ({ order: result.attempt }));

  switch (result.kind) {
    case 'pending':
      await transition(session.id, result.uncertain ? 'order-uncertain' : 'submitting-order', result.detail);
      break;
    case 'dead':
      await transition(session.id, 'order-failed', result.detail, { code: result.code, message: result.message });
      break;
    case 'done': {
      const ex = result.attempt.execution!;
      if (ex.state === 'unfilled') {
        await transition(session.id, 'order-failed', `Lighter did not fill the order (${ex.lighterStatus}). No position was opened; funds are on Lighter.`, {
          code: 'order-rejected',
          message: ex.lighterStatus,
        });
      } else {
        await transition(
          session.id,
          'open',
          ex.state === 'partially-filled'
            ? `Partially filled: ${ex.filledBase} of ${attempt.baseAmount} ${session.symbol}. The rest was cancelled (${ex.lighterStatus}).`
            : `Filled ${ex.filledBase} ${session.symbol} at ${fmtPrice(ex.averagePrice)}.`,
        );
      }
      break;
    }
  }
}

async function stepClose(trade: ActiveTrade, session: TradeSession): Promise<void> {
  const accountIndex = requireAccount(trade);
  const attempt = session.close;
  if (!attempt) {
    await transition(session.id, 'open', 'No close order on record.');
    return;
  }
  const signer = await signerFor(trade, session);
  const result = await settleOrder(signer, attempt, accountIndex);
  await updateSession(session.id, () => ({ close: result.attempt }));

  if (result.kind === 'pending') {
    await updateSession(session.id, () => ({ detail: result.detail }));
    return;
  }
  if (result.kind === 'dead') {
    await transition(session.id, 'close-failed', `${result.detail} The position is still open.`, {
      code: 'close-failed',
      message: result.message,
    });
    return;
  }
  const ex = result.attempt.execution!;
  if (ex.state === 'unfilled') {
    await transition(session.id, 'close-failed', `The close order was not filled (${ex.lighterStatus}). The position is still open.`, {
      code: 'close-failed',
      message: ex.lighterStatus,
    });
    return;
  }
  const account = await readTradingAccount(accountIndex);
  const still = account.positions.find((p) => p.marketId === session.marketId);
  if (still) {
    await transition(session.id, 'open', `Partially closed: ${still.size} ${session.symbol} is still open. Close again to finish.`);
    return;
  }
  await updateSession(session.id, () => ({ closedAt: Date.now() }));
  await transition(
    session.id,
    'closed',
    `Position closed at ${fmtPrice(ex.averagePrice)}. ${account.collateral.toFixed(2)} USDC is on Lighter: withdraw it to the owner address on Lighter, then re-shield.`,
  );
}

// ---------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------

export async function retryFunding(): Promise<void> {
  const session = await requireSession();
  if (session.state !== 'funding-failed') {
    throw new SessionError('not-retryable', `Funding can be retried only after it failed (now: ${session.state}).`);
  }
  const trade = await getActiveTrade();
  if (trade?.withdrawal?.status === 'confirmed') {
    await transition(session.id, 'awaiting-deposit', 'Funding was already confirmed. Waiting for Lighter.');
    return;
  }
  await runFunding();
}

/**
 * Try again after a provably failed attempt. Only from 'order-failed', which
 * is entered only when the previous attempt is dead (refused, unfilled, or
 * expired unsent) — never from an uncertain one.
 */
export async function retryOrder(): Promise<TradeSession> {
  const session = await requireSession();
  if (session.state !== 'order-failed') {
    throw new SessionError('not-retryable', `Retry is only offered after a failed order (now: ${session.state}).`);
  }
  const keyReady = Boolean(session.apiKey?.registeredAt);
  const leverageReady = Boolean(session.leverageSetAt);
  await updateSession(session.id, (s) => ({
    failedOrders: s.order ? [...(s.failedOrders ?? []), s.order] : s.failedOrders,
    order: undefined,
    ...(keyReady ? {} : { apiKey: s.apiKey ? { ...s.apiKey, tx: undefined } : undefined }),
    ...(leverageReady ? {} : { leverageTx: undefined }),
    error: undefined,
  }));
  const target: SessionState = !keyReady ? 'registering-key' : !leverageReady ? 'setting-leverage' : 'submitting-order';
  await transition(session.id, target, 'Retrying after a confirmed failure.');
  return (await advanceSession()) ?? (await requireSession());
}

/** Close the whole position with a reduce-only market order. */
export async function closePosition(): Promise<TradeSession> {
  const trade = await getActiveTrade();
  const session = trade?.session;
  if (!trade || !session) throw new SessionError('no-session', 'No trade session is active.');
  if (session.state !== 'open' && session.state !== 'close-failed') {
    throw new SessionError('not-closable', `Nothing to close in state ${session.state}.`);
  }
  if (session.close && !session.close.execution && session.close.tx.status !== 'rejected' && session.close.tx.status !== 'expired') {
    throw new SessionError('close-in-flight', 'A close order is already in flight. Check its status first.');
  }

  const accountIndex = requireAccount(trade);
  const signer = await signerFor(trade, session);
  const account = await readTradingAccount(accountIndex);
  const position = account.positions.find((p) => p.marketId === session.marketId);
  if (!position) {
    await updateSession(session.id, () => ({ closedAt: Date.now() }));
    await transition(session.id, 'closed', 'No open position on Lighter. Withdraw the balance on Lighter, then re-shield.');
    return requireSession();
  }

  const market = await fetchMarket(session.marketId);
  const book = await fetchTopOfBook(session.marketId);
  const sizing = sizeCloseOrder({
    market,
    positionSign: position.sign,
    positionSize: position.size,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
  });
  const nonce = await nextNonce(accountIndex, signer.apiKeyIndex);
  const clientOrderIndex = newClientOrderIndex();
  const isAsk = sizing.direction === 'short';
  const attempt: OrderAttempt = {
    purpose: 'close',
    clientOrderIndex,
    marketId: session.marketId,
    isAsk,
    reduceOnly: true,
    baseAmount: sizing.baseAmount,
    baseAmountScaled: sizing.baseAmountScaled,
    worstPrice: sizing.worstPrice,
    worstPriceScaled: sizing.worstPriceScaled,
    tx: record(
      await signMarketOrder(
        signer,
        {
          marketIndex: session.marketId,
          clientOrderIndex,
          baseAmount: sizing.baseAmountScaled,
          price: sizing.worstPriceScaled,
          isAsk,
          reduceOnly: true,
        },
        nonce,
      ),
      nonce,
    ),
  };
  await updateSession(session.id, (s) => ({
    closeHistory: s.close ? [...(s.closeHistory ?? []), s.close] : s.closeHistory,
    close: attempt,
    error: undefined,
  }));
  await transition(session.id, 'closing', 'Close order signed. Submitting to Lighter.');
  return (await advanceSession()) ?? (await requireSession());
}

export interface SessionView {
  readonly session: TradeSession;
  readonly ownerAddress: string;
  readonly ownerIndex: number;
  readonly accountIndex?: number;
  readonly withdrawalTxHash?: string;
  readonly withdrawalStatus?: string;
  readonly depositStatus?: string;
  readonly reshieldStatus?: string;
  readonly reshieldUserOpHash?: string;
  readonly position?: LighterPosition;
  readonly account?: Pick<TradingAccount, 'collateral' | 'availableBalance'>;
  readonly liveError?: string;
}

/** The session plus a live position read, for the popup's card. */
export async function getSessionView(): Promise<SessionView | null> {
  const trade = await getActiveTrade();
  const session = trade?.session;
  if (!trade || !session) return null;

  let position: LighterPosition | undefined;
  let account: SessionView['account'];
  let liveError: string | undefined;
  if (trade.accountIndex !== undefined && ['open', 'closing', 'close-failed', 'closed', 'order-failed', 'order-uncertain'].includes(session.state)) {
    try {
      const live = await readTradingAccount(trade.accountIndex);
      position = live.positions.find((p) => p.marketId === session.marketId);
      account = { collateral: live.collateral, availableBalance: live.availableBalance };
    } catch (error) {
      liveError = messageOf(error);
    }
  }

  return {
    session,
    ownerAddress: trade.ownerAddress,
    ownerIndex: trade.ownerIndex,
    ...(trade.accountIndex !== undefined ? { accountIndex: trade.accountIndex } : {}),
    ...(trade.withdrawal?.txHash ? { withdrawalTxHash: trade.withdrawal.txHash } : {}),
    ...(trade.withdrawal ? { withdrawalStatus: trade.withdrawal.status } : {}),
    ...(trade.deposit ? { depositStatus: trade.deposit.status } : {}),
    ...(trade.reshield ? { reshieldStatus: trade.reshield.status, reshieldUserOpHash: trade.reshield.userOpHash } : {}),
    ...(position ? { position } : {}),
    ...(account ? { account } : {}),
    ...(liveError ? { liveError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Transaction plumbing
// ---------------------------------------------------------------------------

type Settled =
  | { kind: 'pending'; attempt: OrderAttempt; detail: string; uncertain: boolean }
  | { kind: 'dead'; attempt: OrderAttempt; detail: string; code: string; message: string }
  | { kind: 'done'; attempt: OrderAttempt };

/** Push an order's tx through and read its outcome. Never re-signs. */
async function settleOrder(signer: SignerAccount, attempt: OrderAttempt, accountIndex: number): Promise<Settled> {
  if (attempt.execution) return { kind: 'done', attempt };

  const tx = await driveTx(attempt.tx, accountIndex, signer.apiKeyIndex);
  attempt = { ...attempt, tx };

  if (tx.status === 'rejected') {
    return { kind: 'dead', attempt, detail: 'Lighter refused the order.', code: 'order-rejected', message: tx.message ?? 'rejected' };
  }
  if (tx.status === 'expired') {
    return {
      kind: 'dead',
      attempt,
      detail: 'The signed order expired without reaching Lighter, so it can never execute.',
      code: 'submission-timeout',
      message: 'expired unsent',
    };
  }

  // Accepted or uncertain: the order record is the only proof of outcome.
  const token = await createAuthToken(signer);
  const order = await findOrderByClientIndex(accountIndex, attempt.marketId, attempt.clientOrderIndex, token);
  if (!order) {
    const waited = Date.now() - (tx.sentAt ?? tx.signedAt);
    return {
      kind: 'pending',
      attempt,
      uncertain: tx.status === 'uncertain' || waited > ORDER_LOOKUP_GRACE_MS,
      detail:
        tx.status === 'accepted'
          ? waited > ORDER_LOOKUP_GRACE_MS
            ? 'Lighter accepted the order transaction but shows no order for it yet. Truly will keep checking and will not resubmit.'
            : 'Order accepted by Lighter. Waiting for its execution record.'
          : `Submission outcome unknown (${tx.message ?? 'no answer'}). Checking Lighter before doing anything else.`,
    };
  }

  const outcome = classifyOrder(order, attempt.baseAmount);
  if (outcome.state === 'pending') {
    return { kind: 'pending', attempt, uncertain: false, detail: `Order ${order.orderIndex} is ${order.status} on Lighter.` };
  }

  let feesUsd = 0;
  let averagePrice = outcome.averagePrice;
  let fillCount = 0;
  if (outcome.filledBase > 0) {
    try {
      const fills = await fetchOrderFills(accountIndex, attempt.marketId, order.orderIndex, token);
      fillCount = fills.length;
      feesUsd = fills.reduce((s, f) => s + f.feeUsd, 0);
      const size = fills.reduce((s, f) => s + f.size, 0);
      if (size > 0) averagePrice = fills.reduce((s, f) => s + f.price * f.size, 0) / size;
    } catch {
      // The order record already proves the fill; fees stay unknown (0).
    }
  }

  const execution: ExecutionResult = {
    orderIndex: order.orderIndex,
    lighterStatus: order.status,
    state: outcome.state,
    filledBase: outcome.filledBase,
    filledQuote: outcome.filledQuote,
    averagePrice,
    feesUsd,
    fillCount,
    confirmedAt: Date.now(),
  };
  return { kind: 'done', attempt: { ...attempt, execution } };
}

/**
 * Move one signed tx forward. Looks before it sends, and only ever sends the
 * identical signed bytes: the nonce inside them makes a second copy unable to
 * execute, so this cannot duplicate an order.
 */
export async function driveTx(
  tx: SubmittedTx,
  accountIndex: number,
  apiKeyIndex: number,
  deps: {
    lookup?: typeof lookupTx;
    nonce?: typeof nextNonce;
    send?: (tx: SignedTx) => ReturnType<typeof sendTx>;
    now?: () => number;
  } = {},
): Promise<SubmittedTx> {
  const lookup = deps.lookup ?? lookupTx;
  const nonceOf = deps.nonce ?? nextNonce;
  const send = deps.send ?? ((t: SignedTx) => sendTx(t));
  const now = deps.now ?? Date.now;

  if (tx.status === 'accepted' || tx.status === 'rejected' || tx.status === 'expired') return tx;

  const seen = await lookup(tx.txHash);
  if (seen.found) return { ...tx, status: 'accepted', message: `sequenced (status ${seen.status})` };

  // Only this session signs with this key slot, so a consumed nonce is ours.
  const next = await nonceOf(accountIndex, apiKeyIndex);
  if (next > tx.nonce) return { ...tx, status: 'accepted', message: 'nonce consumed; awaiting indexer' };

  const expiresAt = txExpiresAt(tx);
  if (expiresAt !== null && now() > expiresAt + EXPIRY_MARGIN_MS) {
    return { ...tx, status: 'expired', message: 'expired without being sequenced' };
  }

  const outcome = await send(tx);
  const sentAt = now();
  if (outcome.kind === 'accepted') return { ...tx, status: 'accepted', sentAt, message: undefined };
  if (outcome.kind === 'rejected') {
    return { ...tx, status: 'rejected', sentAt, message: outcome.message, ...(outcome.code !== undefined ? { code: outcome.code } : {}) };
  }
  return { ...tx, status: 'uncertain', sentAt, message: outcome.message };
}

function record(tx: SignedTx, nonce: number): SubmittedTx {
  return { txType: tx.txType, txInfo: tx.txInfo, txHash: tx.txHash, nonce, status: 'signed', signedAt: Date.now() };
}

async function signerFor(trade: ActiveTrade, session: TradeSession): Promise<SignerAccount> {
  const accountIndex = requireAccount(trade);
  if (!session.apiKey) throw new SessionError('no-api-key', 'No trading key for this session yet.');
  const owner = await ownerAt(trade.ownerIndex);
  return {
    privateKey: await openApiKey(owner.privateKey, accountIndex, session.apiKey.sealed),
    apiKeyIndex: session.apiKey.index,
    accountIndex,
  };
}

function requireAccount(trade: ActiveTrade): number {
  if (trade.accountIndex === undefined) {
    throw new SessionError('no-account', 'Lighter has not created an account for this owner yet.');
  }
  return trade.accountIndex;
}

/** Unique per attempt; Lighter keys client order ids per account. */
function newClientOrderIndex(): number {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return (bytes[0]! & 0x7fff_ffff) || 1;
}

async function transition(
  sessionId: string,
  state: SessionState,
  detail: string,
  error?: { code: string; message: string },
): Promise<TradeSession> {
  return updateSession(sessionId, () => ({
    state,
    detail,
    error: error ? { ...error, at: Date.now() } : undefined,
  }));
}

export async function getSession(): Promise<TradeSession | null> {
  return (await getActiveTrade())?.session ?? null;
}

async function requireSession(): Promise<TradeSession> {
  const session = await getSession();
  if (!session) throw new SessionError('no-session', 'No trade session is active.');
  return session;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const usd = (units: bigint) => (Number(units) / 1e6).toFixed(2);
const short = (hash?: string) => (hash ? `${hash.slice(0, 10)}…` : 'pending');
const fmtPrice = (p: number | null) => (p === null ? 'unknown price' : `$${p.toLocaleString(undefined, { maximumFractionDigits: 6 })}`);
