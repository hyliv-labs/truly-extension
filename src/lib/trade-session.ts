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

import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getAccountIndex } from './lighter';
import { ownerAt } from './vault';
import { getActiveTrade, startTrade, updateActiveTrade, updateSession, type ActiveTrade } from './trade';
import { prepareDeposit, checkDeposit } from './deposit';
import { resolvePendingWithdrawal, unshieldForTrade } from './unshield';
import { settleRailgunFunding, shieldOwnerUsdcToRailgun, unshieldRailgunForTrade, verifyRailgunFunding } from './railgun-client';
import { loadShieldedBalance, notesForQuote, poolsReady, railgunReady } from './shielded-balance';
import { POOL_MIN_DEPOSIT_UNITS } from './config';
import { fastWithdrawAmount } from './exit';
import { ownerUsdcBalance } from './reshield';
import { reshieldActiveTrade } from './reshield-trade';
import { fetchMarket, fetchTopOfBook, referencePrice } from './lighter-markets';
import {
  createAuthToken,
  generateApiKey,
  signChangePubKey,
  signFastWithdraw,
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
  fastWithdrawPool,
  lookupTx,
  nextNonce,
  readTradingAccount,
  sendFastWithdraw,
  sendTx,
  transferFeeUnits,
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
  validateDeposit,
  validateRailgunDeposit,
  validateRailgunTrade,
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
/**
 * Validate against the live market and the shielded balance read at unlock.
 * Does not scan the pool. The withdrawal scans again before any money moves.
 */
export async function quoteTrade(request: TradeRequest): Promise<TradeQuote> {
  if (request.depositOnly) {
    const balance = await loadShieldedBalance();
    if (request.fundingSource === 'railgun') {
      if (!railgunReady(balance.railgun)) {
        throw new TradeValidationError('insufficient-balance', `Railgun balance is unavailable: ${balance.railgun.error}`);
      }
      return validateRailgunDeposit({
        amountUnits: request.marginUnits,
        spendableUnits: BigInt(balance.railgun.spendableUnits),
        pendingUnits: BigInt(balance.railgun.pendingUnits),
        feeBps: BigInt(balance.railgun.feeBps),
      });
    }
    if (!poolsReady(balance.privacyPools)) {
      throw new TradeValidationError('insufficient-balance', `Privacy Pools balance is unavailable: ${balance.privacyPools.error}`);
    }
    return validateDeposit({
      amountUnits: request.marginUnits,
      approvedNotes: notesForQuote(balance.privacyPools.approvedValues),
      pendingNotes: notesForQuote(balance.privacyPools.pendingValues),
    });
  }
  const market = await fetchMarket(request.marketId);
  const price = referencePrice(market);
  // Cheap rules first: a bad leverage must not wait on anything else.
  checkRequest(market, request, price);
  const balance = await loadShieldedBalance();
  if (request.fundingSource === 'railgun') {
    if (!railgunReady(balance.railgun)) {
      throw new TradeValidationError('insufficient-balance', `Railgun balance is unavailable: ${balance.railgun.error}`);
    }
    return validateRailgunTrade({
      market,
      request,
      referencePrice: price,
      spendableUnits: BigInt(balance.railgun.spendableUnits),
      pendingUnits: BigInt(balance.railgun.pendingUnits),
      feeBps: BigInt(balance.railgun.feeBps),
    });
  }
  if (!poolsReady(balance.privacyPools)) {
    throw new TradeValidationError('insufficient-balance', `Privacy Pools balance is unavailable: ${balance.privacyPools.error}`);
  }
  return validateTrade({
    market,
    request,
    referencePrice: price,
    approvedNotes: notesForQuote(balance.privacyPools.approvedValues),
    pendingNotes: notesForQuote(balance.privacyPools.pendingValues),
  });
}

/**
 * Start a session: re-validate, take a FRESH owner, get its intent address.
 * Returns before funding — runFunding() moves money and can take minutes.
 */
export async function openTradeSession(request: TradeRequest): Promise<TradeSession> {
  // A trade with no session is one the user CONNECTED to Lighter before
  // funding it: the address Lighter is already holding. Funding must attach
  // to that trade. Starting a fresh one instead would send the deposit to a
  // different address from the one Lighter is connected to -- the money and
  // the connection would end up on two separate accounts.
  const existing = await getActiveTrade();
  if (existing?.session) {
    throw new SessionError('trade-active', 'A trade is already active. Finish or abandon it first.');
  }
  // A connected trade carries no funding record. One that does was funded
  // before (an earlier test on the same address), and a new session would
  // inherit it: the Railgun step returns early on a 'confirmed' record, so
  // the new deposit is never unshielded and the old one is reported instead.
  if (existing?.withdrawal) {
    throw new SessionError(
      'address-used',
      'This address was funded before, so a new deposit here would be confused with the old one. Abandon this trade to move to a fresh address, then connect Lighter to that one.',
    );
  }
  // Market is read live. The shielded balance is the unlock snapshot;
  // runFunding scans again and refuses if the notes have moved.
  const quote = await quoteTrade(request);

  const trade = existing ?? (await startTrade());
  // What is on Lighter BEFORE this deposit. A reused owner can already have
  // an account with collateral; without a baseline that counts as credited.
  const priorAccount = await getAccountIndex(trade.ownerAddress as Address);
  const baselineCollateralUsd = priorAccount === null ? 0 : (await readTradingAccount(priorAccount)).collateral;
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
    baselineCollateralUsd,
    state: 'funding',
    detail: existing
      ? 'Getting a Lighter deposit address for the connected account.'
      : request.depositOnly
        ? 'Getting a Lighter deposit address for a new account.'
        : 'Getting a Lighter deposit address for a fresh owner.',
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
    const fromRailgun = session.quote.fundingSource === 'Railgun';
    await transition(
      session.id,
      'funding',
      fromRailgun
        ? 'Building the Railgun unshield proof. This takes a minute or two.'
        : 'Building the withdrawal proof and relaying it. This takes a minute or two.',
    );
    const result = fromRailgun
      ? await unshieldRailgunForTrade(BigInt(session.quote.expectedNetUnits))
      : await unshieldForTrade(BigInt(session.quote.grossWithdrawalUnits));
    await transition(
      session.id,
      'awaiting-deposit',
      fromRailgun
        ? `Unshielded ${usd(result.amountUnits)} USDC from Railgun (tx ${short(result.txHash)}). Waiting for Lighter to credit it.`
        : `Withdrew ${usd(result.amountUnits)} USDC from Privacy Pools (tx ${short(result.txHash)}). Waiting for Lighter to credit it.`,
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
  // ppoi is Railgun's equivalent of the ASP wait, so both map to pending.
  if (/asp|not yet been approved|waiting for asp|ppoi/.test(m)) return 'pending-asp';
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
    if (await repairFallThrough(trade, session)) return getSession();
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
      case 'withdrawing':
        await stepWithdraw(trade, session);
        break;
      case 'exited':
      case 'reshielding':
        await stepReturn(trade, session);
        break;
      default:
        // Failed states and states that wait for the user (funding-failed,
        // funded, open, closed, ...) do not advance on a tick. This used to
        // fall through into stepWithdraw, which turned a failed Railgun
        // unshield into "withdraw failed: no withdrawal was stored" and lost
        // the real error. It would have done the same to a funded trade.
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
  if (session.quote.fundingSource === 'Railgun') {
    await stepRailgunFunding(session, trade);
    return;
  }
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
  if (session.quote.fundingSource === 'Railgun') {
    const funding = await verifyRailgunFunding();
    if (funding === 'reverted') {
      await transition(
        session.id,
        'funding-failed',
        'The Railgun unshield reverted on chain, so nothing was sent to Lighter. Nothing left the shielded pool. Retry builds a new proof.',
        { code: 'arbitrum-revert', message: 'unshield reverted' },
      );
      return;
    }
  }
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
  if (!depositCredited(session, account.collateral)) {
    await updateSession(session.id, () => ({
      detail: `Lighter account #${account.accountIndex} holds ${account.collateral.toFixed(2)} USDC; waiting for this deposit to add to it.`,
    }));
    return;
  }
  await updateSession(session.id, () => ({ creditedUsd: account.collateral }));
  if (session.quote.orderType === 'deposit') {
    await transition(
      session.id,
      'funded',
      `Lighter credited ${account.collateral.toFixed(2)} USDC to account #${account.accountIndex}. Open Lighter and trade there. Truly did not place an order.`,
    );
    return;
  }
  await transition(
    session.id,
    'registering-key',
    `Lighter credited ${account.collateral.toFixed(2)} USDC to account #${account.accountIndex}. Authorising a trading key.`,
  );
}

/**
 * Has THIS deposit landed? An account existing is not enough: a reused owner
 * already had one (measured: owner #0 kept 1.00 USDC from an earlier test,
 * and the session reported "credited 1.00 USDC" with nothing unshielded).
 * The collateral has to rise above what was there when the session opened,
 * by at least half the deposit so a stray dollar does not count.
 */
export function depositCredited(
  session: Pick<TradeSession, 'baselineCollateralUsd' | 'marginUnits'>,
  collateralUsd: number,
): boolean {
  if (session.baselineCollateralUsd === undefined) return collateralUsd > 0;
  const expectedUsd = Number(session.marginUnits) / 1e6;
  return collateralUsd - session.baselineCollateralUsd >= expectedUsd / 2;
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
  await queueLighterExit(
    trade,
    session,
    account.collateralRaw,
    `Position closed at ${fmtPrice(ex.averagePrice)}.`,
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
/**
 * Sign one fast withdrawal. The fee Lighter quotes is left on the account.
 * Below the 4 USDC minimum nothing is signed: the other route lands on Ethereum.
 */
async function queueLighterExit(
  trade: ActiveTrade,
  session: TradeSession,
  collateralRaw: string,
  headline: string,
): Promise<void> {
  const existing = session.exitTx;
  if (existing && existing.status !== 'rejected' && existing.status !== 'expired') {
    if (!existing.toAddress) {
      await transition(
        session.id,
        'withdraw-failed',
        `${headline} The stored withdrawal is the secure route, so it was not sent. That one pays on Ethereum.`,
      );
      return;
    }
    await transition(session.id, 'withdrawing', session.detail);
    return;
  }
  const signer = await signerFor(trade, session);
  const owner = privateKeyToAccount((await ownerAt(trade.ownerIndex)).privateKey);
  const auth = await createAuthToken(signer);
  const pool = await fastWithdrawPool(signer.accountIndex, auth);
  const fee = await transferFeeUnits(signer.accountIndex, pool.toAccountIndex, auth);
  const units = fastWithdrawAmount(collateralRaw, fee);
  if (units === null) {
    await transition(
      session.id,
      'closed',
      `${headline} The balance cannot cover a fast withdrawal, so nothing was sent. A secure withdrawal lands on Ethereum and cannot be re-shielded here.`,
    );
    return;
  }
  const nonce = await nextNonce(requireAccount(trade), signer.apiKeyIndex);
  const unsigned = await signFastWithdraw(signer, {
    toAccountIndex: pool.toAccountIndex,
    amountUnits: units,
    feeUnits: fee,
    toAddress: owner.address,
    nonce,
  });
  const l1 = await owner.signMessage({ message: unsigned.messageToSign });
  const tx = record(withL1Signature(unsigned, l1), nonce);
  await updateSession(session.id, () => ({
    exitTx: { ...tx, amountUnits: units.toString(), toAddress: owner.address },
  }));
  const usd = (Number(units) / 1e6).toFixed(2);
  const feeUsd = (Number(fee) / 1e6).toFixed(2);
  await transition(
    session.id,
    'withdrawing',
    `${headline} Withdrawing ${usd} USDC to this owner on Arbitrum. ${feeUsd} USDC stays on Lighter for the fee. This withdrawal is sent once.`,
  );
}

/**
 * Put back a record the old step() fall-through mislabelled. Its signature is
 * 'withdraw-failed' with code 'no-exit-tx' and no stored withdrawal: a real
 * exit always stores its withdrawal before entering 'withdrawing', so only
 * the fall-through produces that. Nothing was sent then, but the record named
 * the wrong step, and its one button ("Retry Lighter withdrawal") would sign a
 * withdrawal of whatever sits on Lighter.
 *
 * Where it goes back to depends on the funding record, never on a guess:
 * - not sent: 'funding-failed', which offers the funding retry.
 * - pending: 'funding', which settles that same transaction on chain.
 * - confirmed, deposit-only: 'awaiting-deposit', which re-reads Lighter and
 *   never places an order for a deposit-only trade.
 * A confirmed trade that places its own order is left alone: replaying its
 * steps could sign a second order.
 */
async function repairFallThrough(trade: ActiveTrade, session: TradeSession): Promise<boolean> {
  if (session.state !== 'withdraw-failed' || session.exitTx || session.error?.code !== 'no-exit-tx') return false;
  const funding = trade.withdrawal?.status;
  if (funding === 'pending') {
    await transition(session.id, 'funding', 'Checking the funding transaction against the chain. It will not be sent again.');
    return true;
  }
  if (funding === 'confirmed') {
    if (session.quote.orderType !== 'deposit') return false;
    await transition(session.id, 'awaiting-deposit', 'Funding landed. Checking whether Lighter has credited it.');
    return true;
  }
  await transition(
    session.id,
    'funding-failed',
    'Funding did not complete, and a bug (now fixed) replaced its error. Nothing left the shielded pool. Retry is safe and will show the real error if it fails again.',
    { code: 'funding-error', message: 'original error not recorded' },
  );
  return true;
}

async function stepWithdraw(trade: ActiveTrade, session: TradeSession): Promise<void> {
  const stored = session.exitTx;
  if (!stored) {
    await transition(session.id, 'withdraw-failed', 'No withdrawal was stored, so nothing was sent.', {
      code: 'no-exit-tx',
      message: 'missing withdrawal',
    });
    return;
  }
  if (!stored.toAddress || stored.txType === 13) {
    await transition(
      session.id,
      'withdraw-failed',
      'The stored withdrawal is the secure route, so it was not sent. That one pays on Ethereum.',
      { code: 'secure-withdraw', message: 'stored withdrawal has no Arbitrum destination' },
    );
    return;
  }
  const signer = await signerFor(trade, session);
  const destination = stored.toAddress;
  const tx = await driveTx(stored, requireAccount(trade), signer.apiKeyIndex, {
    send: async (signed) => {
      try {
        const auth = await createAuthToken(signer);
        return await sendFastWithdraw(signed, destination, auth);
      } catch (error) {
        return { kind: 'uncertain', message: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  await updateSession(session.id, (s) => ({ exitTx: s.exitTx ? { ...s.exitTx, ...tx, amountUnits: s.exitTx.amountUnits } : s.exitTx }));
  if (tx.status === 'rejected' || tx.status === 'expired') {
    await transition(
      session.id,
      'withdraw-failed',
      `Lighter did not take the withdrawal (${tx.message ?? tx.status}). The position is already closed. Retry signs a new one.`,
      { code: 'withdraw-failed', message: tx.message ?? tx.status },
    );
    return;
  }
  if (tx.status === 'accepted') {
    const usd = (Number(stored.amountUnits) / 1e6).toFixed(2);
    await transition(
      session.id,
      'exited',
      `Lighter accepted a withdrawal of ${usd} USDC to the owner on Arbitrum. Re-shield once it arrives. Truly will not send a second withdrawal.`,
    );
    return;
  }
  await updateSession(session.id, () => ({
    detail: `Withdrawal outcome unknown (${tx.message ?? 'no answer'}). Checking this same transaction. It will not be signed again.`,
  }));
}

/**
 * After Lighter accepts the withdrawal, wait until USDC is actually at the
 * owner, then re-shield. Acceptance is not arrival: Lighter can zero its
 * balance before the Arbitrum transfer lands.
 */
async function stepRailgunFunding(session: TradeSession, trade: ActiveTrade): Promise<void> {
  if (trade.withdrawal?.status === 'confirmed') {
    await transition(session.id, 'awaiting-deposit', 'Railgun funding confirmed. Waiting for Lighter to credit it.');
    return;
  }
  if (trade.withdrawal?.status === 'pending') {
    const outcome = await settleRailgunFunding();
    if (outcome === 'landed') {
      await transition(session.id, 'awaiting-deposit', 'Railgun unshield confirmed on chain. Waiting for Lighter to credit it.');
    } else if (outcome === 'reverted') {
      await transition(session.id, 'funding-failed', 'The Railgun unshield reverted. Nothing was spent. Retry builds a new proof.');
    }
    return;
  }
  if (trade.intentAddress) {
    await transition(session.id, 'funding-failed', 'Railgun funding was interrupted before a proof was broadcast. Retry is safe.');
  }
}

async function stepReturn(trade: ActiveTrade, session: TradeSession): Promise<void> {
  if (session.quote.fundingSource === 'Railgun') {
    await stepReturnRailgun(trade, session);
    return;
  }
  const fresh = await getActiveTrade();
  if (fresh?.reshield?.status === 'confirmed') {
    await transition(session.id, 'complete', 'Funds are back in Privacy Pools. This trade can be retired.');
    return;
  }
  const submitted = fresh?.reshield?.status === 'pending' && fresh.reshield.userOpHash;
  const balance = await ownerUsdcBalance(trade.ownerAddress);
  if (!submitted && balance < POOL_MIN_DEPOSIT_UNITS) {
    const usd = (Number(balance) / 1e6).toFixed(2);
    await updateSession(session.id, () => ({
      detail:
        balance === 0n
          ? 'Lighter accepted the withdrawal. Waiting for the USDC to reach this owner on Arbitrum, then Truly re-shields it.'
          : `${usd} USDC is at the owner, under the pool minimum, so it is not re-shielded yet.`,
    }));
    return;
  }
  await transition(session.id, 'reshielding', 'USDC is at the owner. Re-shielding into Privacy Pools.');
  await reshieldActiveTrade();
}

async function stepReturnRailgun(trade: ActiveTrade, session: TradeSession): Promise<void> {
  const fresh = await getActiveTrade();
  if (fresh?.reshield?.status === 'confirmed') {
    await transition(session.id, 'complete', 'Funds are back in Railgun. This trade can be retired.');
    return;
  }
  const submitted = fresh?.reshield?.status === 'pending' && fresh.reshield.userOpHash;
  const balance = await ownerUsdcBalance(trade.ownerAddress);
  if (!submitted && balance === 0n) {
    await updateSession(session.id, () => ({
      detail: 'Lighter accepted the withdrawal. Waiting for the USDC to reach this owner on Arbitrum, then Truly shields it back into Railgun.',
    }));
    return;
  }
  await transition(session.id, 'reshielding', 'USDC is at the owner. Shielding all of it back into Railgun, gas paid from the owner\'s ETH (or in USDC if it has none).');
  await shieldOwnerUsdcToRailgun();
  await transition(session.id, 'complete', 'Funds are back in Railgun. This trade can be retired.');
}

/**
 * The user traded on Lighter. Bring the collateral back to the owner with a
 * fast withdrawal, then the session tick shields it into the pool it left.
 * An open position is refused: closing it is the user's trade, not ours.
 */
export async function shieldFundedAccount(): Promise<TradeSession> {
  const trade = await getActiveTrade();
  const session = trade?.session;
  if (!trade || !session) throw new SessionError('no-session', 'No account is active.');
  if (session.quote.orderType !== 'deposit' || session.state !== 'funded') {
    throw new SessionError('not-shieldable', 'Shielding is available once this account is funded and the deposit has landed.');
  }
  const account = await readTradingAccount(requireAccount(trade));
  if (account.positions.length > 0) {
    throw new SessionError(
      'position-open',
      'Close the position on Lighter first. Nothing was withdrawn, and nothing was shielded.',
    );
  }
  // A deposit-only account is traded on Lighter's own site, so Truly never
  // registered a key for it, and the withdrawal has to be signed with one.
  // Measured: "No trading key for this session yet." on Shield back.
  const keyed = await ensureWithdrawalKey(trade, session);
  const signer = await signerFor(trade, keyed);
  const auth = await createAuthToken(signer);
  const pool = await fastWithdrawPool(signer.accountIndex, auth);
  const fee = await transferFeeUnits(signer.accountIndex, pool.toAccountIndex, auth);
  if (fastWithdrawAmount(account.collateralRaw, fee) === null) {
    throw new SessionError(
      'below-fast-minimum',
      'The balance cannot cover a fast withdrawal, so nothing was sent. A secure withdrawal lands on Ethereum and cannot be shielded here.',
    );
  }
  const where = session.quote.fundingSource === 'Railgun' ? 'Railgun' : 'Privacy Pools';
  await queueLighterExit(trade, keyed, account.collateralRaw, `Withdrawing USDC from Lighter to shield it back into ${where}.`);
  return (await advanceSession()) ?? (await requireSession());
}

/**
 * Make sure this session has a Lighter API key registered at API_KEY_INDEX,
 * registering one if not. Index 4 is outside the slots Lighter's own apps use,
 * so the user's Lighter web session is not touched.
 *
 * Signed once and stored before sending; later calls drive the SAME signed
 * change, so clicking again cannot register two keys. Waits up to ~30s for
 * Lighter to apply it, then asks the user to click again rather than guess.
 */
async function ensureWithdrawalKey(trade: ActiveTrade, session: TradeSession): Promise<TradeSession> {
  const accountIndex = requireAccount(trade);
  const owner = await ownerAt(trade.ownerIndex);

  let apiKey = session.apiKey;
  if (apiKey?.registeredAt) return session;
  if (!apiKey) {
    const pair = await generateApiKey();
    const fresh = {
      index: API_KEY_INDEX,
      publicKey: pair.publicKey,
      sealed: await sealApiKey(owner.privateKey, accountIndex, pair.privateKey),
    };
    apiKey = fresh;
    await updateSession(session.id, () => ({ apiKey: fresh }));
  }
  const key = apiKey;
  const markRegistered = async () =>
    updateSession(session.id, (s) => ({ apiKey: { ...s.apiKey!, registeredAt: Date.now() } }));

  if (await isApiKeyRegistered(accountIndex, key.index, key.publicKey)) return markRegistered();

  let tx = key.tx;
  if (!tx || tx.status === 'expired' || tx.status === 'rejected') {
    const signer = await signerFor(trade, { ...session, apiKey: key });
    const nonce = await nextNonce(accountIndex, key.index);
    const unsigned = await signChangePubKey(signer, key.publicKey, nonce);
    const l1 = await privateKeyToAccount(owner.privateKey).signMessage({ message: unsigned.messageToSign });
    const signed = record(withL1Signature(unsigned, l1), nonce);
    tx = signed;
    await updateSession(session.id, (s) => ({ apiKey: { ...s.apiKey!, tx: signed } }));
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const next = await driveTx(tx, accountIndex, key.index);
    await updateSession(session.id, (s) => ({ apiKey: { ...s.apiKey!, tx: next } }));
    if (await isApiKeyRegistered(accountIndex, key.index, key.publicKey)) return markRegistered();
    if (next.status === 'rejected') {
      throw new SessionError(
        'key-rejected',
        `Lighter refused the withdrawal key (${next.message ?? 'rejected'}). Nothing was withdrawn; click again to retry.`,
      );
    }
    tx = next;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new SessionError(
    'key-pending',
    'Lighter is still authorising the withdrawal key. Nothing was withdrawn. Click Shield back again in a minute.',
  );
}

/** A refused or expired withdrawal can be signed again. An uncertain one cannot. */
export async function retryLighterExit(): Promise<TradeSession> {
  const trade = await getActiveTrade();
  const session = trade?.session;
  if (!trade || !session) throw new SessionError('no-session', 'No trade session is active.');
  if (await repairFallThrough(trade, session)) return requireSession();
  if (session.state !== 'withdraw-failed') {
    throw new SessionError('not-retryable', `A Lighter withdrawal can be retried only after it failed (now: ${session.state}).`);
  }
  const previous = session.exitTx;
  if (previous && previous.status !== 'rejected' && previous.status !== 'expired') {
    throw new SessionError('exit-in-flight', 'The previous withdrawal is not confirmed dead.');
  }
  const account = await readTradingAccount(requireAccount(trade));
  await queueLighterExit(trade, session, account.collateralRaw, 'Retrying the Lighter withdrawal.');
  return (await advanceSession()) ?? (await requireSession());
}

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
    await queueLighterExit(trade, session, account.collateralRaw, 'No open position on Lighter.');
    // Must stop here. Without this return the function went on to size a
    // close order from position.sign on an account that has no position --
    // a TypeError at best, and at worst a reduce order sent to a flat
    // account straight after the session was marked closed.
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
  let trade = await getActiveTrade();
  let session = trade?.session;
  if (!trade || !session) return null;
  // A mislabelled record sits in a state nothing ticks, so repair it here,
  // where the panel looks, rather than wait for a click on the wrong button.
  if (await repairFallThrough(trade, session)) {
    trade = (await getActiveTrade()) ?? trade;
    session = trade.session ?? session;
  }

  let position: LighterPosition | undefined;
  let account: SessionView['account'];
  let liveError: string | undefined;
  if (trade.accountIndex !== undefined && ['open', 'closing', 'close-failed', 'closed', 'withdrawing', 'withdraw-failed', 'exited', 'funded', 'order-failed', 'order-uncertain'].includes(session.state)) {
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
  const next = await updateSession(sessionId, () => ({
    state,
    detail,
    error: error ? { ...error, at: Date.now() } : undefined,
  }));
  // The ticket was priced from the unlock snapshot. A failure is the moment
  // that snapshot is allowed to be wrong, so read the pools again.
  if (state === 'funding-failed' || state === 'deposit-problem' || state === 'order-failed' || state === 'close-failed' || state === 'withdraw-failed') {
    void loadShieldedBalance(true).catch((error: unknown) => console.warn('[truly] shielded balance refresh failed', error));
  }
  return next;
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
