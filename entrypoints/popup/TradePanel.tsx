/**
 * The market trade: pick a market, LONG or SHORT, margin and leverage, review,
 * confirm. Everything after confirm — funding from Privacy Pools, Lighter
 * credit, the order — runs in the background and is followed here from the
 * session record, so closing the popup never loses a step.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { send, SLOW_TIMEOUT_MS } from '@truly/lib/messages';
import type { PerpMarket } from '@truly/lib/lighter-markets';
import type { Direction, TradeQuote } from '@truly/lib/trade-plan';
import type { SessionView } from '@truly/lib/trade-session';
import { ACTIVE_SESSION_STATES, type SessionState } from '@truly/lib/session-types';

const usdc = (units: string | bigint) => (Number(units) / 1e6).toFixed(2);
const money = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) })}`;
const price = (n: number | null | undefined) => money(n, 6);

function toUnits(input: string): string | null {
  if (!/^\d+(\.\d{0,6})?$/.test(input.trim())) return null;
  const [whole, frac = ''] = input.trim().split('.');
  return (BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'))).toString();
}

export function TradeForm({ busy, onOpened }: { busy: boolean; onOpened: () => Promise<void> }) {
  const [markets, setMarkets] = useState<PerpMarket[] | null>(null);
  const [filter, setFilter] = useState('');
  const [marketId, setMarketId] = useState<number | null>(null);
  const [direction, setDirection] = useState<Direction>('long');
  const [margin, setMargin] = useState('10');
  const [leverage, setLeverage] = useState(2);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [working, setWorking] = useState<'quote' | 'open' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Null until known; the notice says so rather than assuming either way. */
  const [funding, setFunding] = useState<{ fastBridgeLimit: string; fast: boolean } | null>(null);

  const loadMarkets = useCallback(async () => {
    setError(null);
    try {
      const list = await send({ kind: 'markets' }, 20_000);
      setMarkets(list);
      setMarketId((current) => current ?? list.find((m) => m.tradable)?.marketId ?? null);
    } catch (e) {
      setError(`Markets unavailable: ${(e as Error).message}`);
    }
    // Best effort: a trade is still placeable if this read fails, so a
    // failure leaves the notice in its 'checking' wording rather than
    // blocking the form.
    try {
      setFunding(await send({ kind: 'fundingSpeed' }, 20_000));
    } catch {
      setFunding(null);
    }
  }, []);

  useEffect(() => {
    void loadMarkets();
  }, [loadMarkets]);

  const market = markets?.find((m) => m.marketId === marketId) ?? null;
  const visible = useMemo(
    () =>
      (markets ?? []).filter((m) => !filter || m.symbol.toLowerCase().includes(filter.toLowerCase())).slice(0, 80),
    [markets, filter],
  );

  // Any change invalidates the reviewed summary.
  useEffect(() => setQuote(null), [marketId, direction, margin, leverage]);
  useEffect(() => {
    if (market && leverage > market.maxLeverage) setLeverage(market.maxLeverage);
  }, [market, leverage]);

  const marginUnits = toUnits(margin);
  const marginNum = marginUnits ? Number(marginUnits) / 1e6 : 0;
  const notional = marginNum * leverage;
  const ref = market ? (market.markPrice > 0 ? market.markPrice : market.lastPrice) : 0;
  const marginInvalid = margin.trim().length > 0 && marginUnits === null;

  const wire = () => {
    if (!market || !marginUnits) throw new Error('Choose a market and a margin.');
    return { marketId: market.marketId, direction, marginUnits, leverage };
  };

  const review = async () => {
    setWorking('quote');
    setError(null);
    try {
      setQuote(await send({ kind: 'quoteTrade', trade: wire() }, SLOW_TIMEOUT_MS));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  };

  const confirm = async () => {
    setWorking('open');
    setError(null);
    try {
      await send({ kind: 'openTrade', trade: wire() }, SLOW_TIMEOUT_MS);
      await onOpened();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  };

  const disabled = busy || working !== null;

  return (
    <div className="trade">
      <div className="trade-head">
        <strong>Market trade</strong>
        <span className="field-label">One market order, funded from Privacy Pools when you confirm</span>
      </div>

      <div className="market-group">
        <input placeholder="Search markets" aria-label="Search markets" value={filter} disabled={disabled || markets === null} onChange={(e) => setFilter(e.target.value)} />
        {markets === null ? (
          <div className="skeleton" role="status">{error ? <span className="error">{error}</span> : 'Loading markets'}</div>
        ) : (
          <select
            aria-label="Market"
            value={marketId ?? ''}
            disabled={disabled}
            onChange={(e) => setMarketId(Number(e.target.value))}
          >
            {visible.map((m) => (
              <option key={m.marketId} value={m.marketId} disabled={!m.tradable}>
                {m.symbol}-PERP · {price(m.markPrice > 0 ? m.markPrice : m.lastPrice)}
                {m.tradable ? ` · ${m.maxLeverage}x` : ` · ${m.unavailableReason}`}
              </option>
            ))}
          </select>
        )}
      </div>
      {market && (
        <p className="field-label">
          24h {Number.isFinite(market.dailyChangePct) ? `${market.dailyChangePct.toFixed(2)}%` : '—'} · max {market.maxLeverage}× · min {market.minQuoteAmount} USDC notional
        </p>
      )}

      <div className="sides" role="group" aria-label="Direction">
        <button className={direction === 'long' ? 'long active' : 'long'} disabled={disabled} aria-pressed={direction === 'long'} onClick={() => setDirection('long')}>
          LONG
        </button>
        <button className={direction === 'short' ? 'short active' : 'short'} disabled={disabled} aria-pressed={direction === 'short'} onClick={() => setDirection('short')}>
          SHORT
        </button>
      </div>

      <label className="field-label" htmlFor="margin">Margin</label>
      <div className={`affix${marginInvalid ? ' invalid' : ''}`}>
        <input
          id="margin"
          inputMode="decimal"
          aria-invalid={marginInvalid}
          value={margin}
          disabled={disabled}
          onChange={(e) => setMargin(e.target.value)}
        />
        <span>USDC</span>
      </div>
      {marginInvalid ? (
        <p className="error">Enter a USDC amount, up to 6 decimals.</p>
      ) : (
        <p className="field-label">Withdrawn from Privacy Pools. Lighter credits at least 5 USDC.</p>
      )}

      <div className="lev-label">
        <label className="field-label" htmlFor="leverage">Leverage</label>
        <span>{leverage}×</span>
      </div>
      <input
        id="leverage"
        type="range"
        min={1}
        max={market?.maxLeverage ?? 1}
        step={1}
        value={Math.min(leverage, market?.maxLeverage ?? leverage)}
        disabled={disabled || !market}
        onChange={(e) => setLeverage(Number(e.target.value))}
      />

      <div className="ticket">
        <span className="ticket-kicker">Notional</span>
        <span className="ticket-figure">{money(notional)}</span>
        <span className="ticket-meta">
          Notional = {marginNum.toFixed(2)} × {leverage} = {money(notional)}
          {ref > 0 && ` · ≈ ${(notional / ref).toPrecision(4)} ${market?.symbol ?? ''}`}
        </span>
      </div>

      {quote && <OrderSummary quote={quote} />}

      {/* Stated BEFORE confirming, not discovered during the wait.
          stepOrder re-reads the book and the credited balance, so the order
          is sized correctly either way -- but it is sized at the price when
          funding lands, which is not the price on screen now. Saying so is
          the difference between a slow trade and a surprising one. */}
      {quote && (
        <p className={funding?.fast ? 'field-label' : 'warn'}>
          {funding === null
            ? 'Checking how fast Lighter will credit this…'
            : funding.fast
              ? 'Lighter’s fast bridge has capacity, so funding should credit in moments. Your order is priced when it lands.'
              : 'Lighter’s fast bridge is at zero capacity, so funding takes about 15–20 minutes. Your order is placed at the market price when it lands — not the price shown here.'}
        </p>
      )}

      {quote ? (
        <button className={direction} disabled={disabled} onClick={() => void confirm()}>
          {working === 'open' ? 'Starting…' : `Confirm ${direction.toUpperCase()} ${quote.symbol}`}
        </button>
      ) : (
        <button disabled={disabled || !market?.tradable || !marginUnits} onClick={() => void review()}>
          {working === 'quote' ? 'Checking spendable balance…' : 'Review order'}
        </button>
      )}
      {quote && (
        <button className="link" disabled={disabled} onClick={() => setQuote(null)}>
          Edit order
        </button>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

function OrderSummary({ quote }: { quote: TradeQuote }) {
  const pending = Number(quote.pendingAspUnits) > 0 ? ` · ${usdc(quote.pendingAspUnits)} awaiting ASP` : '';
  return (
    <div className="summary">
      <p className="summary-lead">
        {quote.direction.toUpperCase()} {quote.symbol}-PERP · {quote.leverage}× · market
      </p>
      <div className="row"><span>Size</span><span>{quote.estimatedSize} {quote.symbol} at ~{price(quote.referencePrice)}</span></div>
      <div className="row"><span>Margin</span><span>{usdc(quote.marginUnits)} USDC from {quote.fundingSource}</span></div>
      <div className="row"><span>Withdrawal</span><span>{usdc(quote.grossWithdrawalUnits)} gross, ~{usdc(quote.expectedNetUnits)} to Lighter</span></div>
      <div className="row"><span>Fees</span><span>~{usdc(quote.relayerFeeEstimateUnits)} relayer · {quote.takerFeePct}% Lighter · ≤{usdc(quote.reshieldGasReserveUnits)} to exit</span></div>
      <div className="row"><span>Spendable</span><span>{usdc(quote.spendableUnits)} USDC{pending}</span></div>
      {quote.warnings.map((w) => (
        <p key={w} className="hint">{w}</p>
      ))}
      <p className="hint">Sized from margin less a 2% buffer. A fresh owner and a fresh Lighter account, used once.</p>
    </div>
  );
}

/** Whole minutes since a timestamp, worded so 0 does not read as broken. */
function waitedMinutes(since: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - since) / 60_000));
  if (mins < 1) return 'under a minute';
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

const STEPS: { label: string; states: SessionState[] }[] = [
  { label: 'Withdraw from Privacy Pools', states: ['funding', 'funding-failed'] },
  { label: 'Lighter credits the deposit', states: ['awaiting-deposit', 'deposit-problem'] },
  { label: 'Authorise trading key', states: ['registering-key'] },
  { label: 'Set leverage', states: ['setting-leverage'] },
  { label: 'Market order executed', states: ['submitting-order', 'order-uncertain', 'order-failed'] },
  { label: 'Position open', states: ['open', 'closing', 'close-failed'] },
  { label: 'Closed', states: ['closed'] },
];

export function SessionPanel({ busy, onChanged }: { busy: boolean; onChanged: () => Promise<void> }) {
  const [view, setView] = useState<SessionView | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state = view?.session.state;
  const active = state ? ACTIVE_SESSION_STATES.includes(state) : false;

  const poll = useCallback(async () => {
    try {
      const kind = active ? 'advanceTrade' : 'tradeSession';
      setView(await send({ kind }, SLOW_TIMEOUT_MS));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [active]);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), active ? 4_000 : 10_000);
    return () => clearInterval(id);
  }, [poll, active]);

  const act = async (label: string, action: () => Promise<unknown>) => {
    setWorking(label);
    setError(null);
    try {
      await action();
      await poll();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  };

  if (!view) return <div className="skeleton tall" role="status">Loading trade</div>;
  const s = view.session;
  const current = Math.max(0, STEPS.findIndex((st) => st.states.includes(s.state)));
  const failed = ['funding-failed', 'deposit-problem', 'order-failed', 'close-failed'].includes(s.state);
  const ex = s.order?.execution;
  const pos = view.position;
  const disabled = busy || working !== null;
  const settled = ex && ex.state !== 'unfilled';
  const hero = pos
    ? money(pos.unrealizedPnl, 2)
    : ex?.averagePrice
      ? price(ex.averagePrice)
      : `${usdc(s.marginUnits)} USDC`;
  const heroCaption = pos ? 'Unrealised PnL' : ex?.averagePrice ? 'Average fill' : 'Margin';
  // The fill rows are the result, so the status box does not repeat them.
  const showNarrative = !settled || failed || Boolean(s.blocked) || Boolean(s.error && s.error.code !== 'transient');

  return (
    <div className="trade">
      <div className="ticket">
        <span className="ticket-kicker">
          {s.direction.toUpperCase()} {s.symbol}-PERP · {s.leverage}× · {usdc(s.marginUnits)} USDC
        </span>
        {!failed && (
          <>
            <span className={`ticket-figure${pos ? (pos.unrealizedPnl >= 0 ? ' pos-long' : ' pos-short') : ''}`}>{hero}</span>
            <span className="ticket-meta">{heroCaption}</span>
          </>
        )}
      </div>

      <div className="meter" aria-hidden>
        <span className={failed ? 'failed' : ''} style={{ width: `${((current + 1) / STEPS.length) * 100}%` }} />
      </div>
      <p className="field-label">
        {current + 1} of {STEPS.length} · {STEPS[current]?.label}
      </p>

      {showNarrative && (
        <div className={failed ? 'phase failed' : 'phase'}>
          <strong>{s.state.replace(/-/g, ' ')}</strong>
          <p>{s.detail}</p>
          {/* A 20-minute wait with no elapsed time reads as 'stuck'. Showing
              it against the expected window turns the same wait into
              something the user can judge. */}
          {s.state === 'awaiting-deposit' && (
            <p className="field-label">
              Waiting {waitedMinutes(s.updatedAt)} · Lighter usually credits in 15–20 minutes while
              its fast bridge has no capacity. Your order is priced when it lands.
            </p>
          )}
          {s.blocked === 'locked' && <p className="error">Unlock Truly to continue. This step signs with the trade&apos;s keys.</p>}
          {s.error && s.error.code !== 'transient' && (
            <p className={s.detail.includes(s.error.message) ? 'field-label' : 'error'}>
              {s.detail.includes(s.error.message) ? s.error.code : `${s.error.code}: ${s.error.message}`}
            </p>
          )}
          {s.error?.code === 'transient' && <p className="hint">Last check failed, retrying: {s.error.message}</p>}
        </div>
      )}

      {settled && (
        <div className="summary">
          <div className="row"><span>Execution</span><span>{ex.state === 'filled' ? 'FILLED' : 'PARTIALLY FILLED'}</span></div>
          <div className="row"><span>Order</span><span>{ex.orderIndex}</span></div>
          <div className="row"><span>Filled</span><span>{ex.filledBase} of {s.order!.baseAmount} {s.symbol}</span></div>
          <div className="row"><span>Size</span><span>{money(ex.filledQuote)}</span></div>
          <div className="row"><span>Margin used</span><span>{money(s.order!.marginUsd)} of {money(s.creditedUsd)} credited</span></div>
          <div className="row"><span>Fees paid</span><span>{money(ex.feesUsd, 4)} over {ex.fillCount} fill{ex.fillCount === 1 ? '' : 's'}</span></div>
        </div>
      )}

      {pos && (
        <div className="summary">
          <div className="row"><span>Position</span><span className={pos.sign > 0 ? 'pos-long' : 'pos-short'}>{pos.sign > 0 ? 'LONG' : 'SHORT'} {pos.size} {pos.symbol || s.symbol}</span></div>
          <div className="row"><span>Entry</span><span>{price(pos.avgEntryPrice)}</span></div>
          <div className="row"><span>Size</span><span>{money(pos.positionValue)}</span></div>
          <div className="row"><span>Margin</span><span>{money(pos.allocatedMargin > 0 ? pos.allocatedMargin : (view.account?.collateral ?? null))}</span></div>
          <div className="row"><span>Leverage</span><span>{pos.initialMarginFraction > 0 ? `${(100 / pos.initialMarginFraction).toFixed(1)}×` : `${s.leverage}×`}</span></div>
          <div className="row"><span>Liquidation</span><span>{pos.liquidationPrice > 0 ? price(pos.liquidationPrice) : '—'}</span></div>
          <div className="row"><span>Status</span><span>{s.state === 'closing' ? 'Closing' : 'Open'}</span></div>
        </div>
      )}
      {view.liveError && <p className="hint">Could not read the live position: {view.liveError}</p>}

      {(s.state === 'open' || s.state === 'close-failed') && (
        <button className="short" disabled={disabled} onClick={() => void act('close', () => send({ kind: 'closePosition' }, SLOW_TIMEOUT_MS))}>
          {working === 'close' ? 'Closing…' : 'CLOSE POSITION'}
        </button>
      )}
      {s.state === 'funding-failed' && (
        <button disabled={disabled} onClick={() => void act('fund', () => send({ kind: 'retryFunding' }))}>
          Retry funding from Privacy Pools
        </button>
      )}
      {s.state === 'order-failed' && (
        <>
          <p className="hint">
            Funds are on Lighter account #{view.accountIndex ?? '—'} with no position. Truly will not resend anything on its own. Retry places a NEW order after the
            previous one was confirmed dead; otherwise withdraw on Lighter and re-shield.
          </p>
          <button disabled={disabled} onClick={() => void act('retry', () => send({ kind: 'retryOrder' }, SLOW_TIMEOUT_MS))}>
            Retry market order
          </button>
        </>
      )}
      {(s.state === 'order-uncertain' || s.state === 'submitting-order' || s.state === 'closing') && (
        <button className="secondary" disabled={disabled} onClick={() => void act('check', () => send({ kind: 'advanceTrade' }, SLOW_TIMEOUT_MS))}>
          Check order status on Lighter
        </button>
      )}

      <details className="record">
        <summary>Session record</summary>
        <div className="row"><span>trade_session_id</span><code>{s.id}</code></div>
        <div className="row"><span>Owner #{view.ownerIndex}</span><code>{view.ownerAddress}</code></div>
        <div className="row"><span>Lighter account</span><code>{view.accountIndex ?? '—'}</code></div>
        <div className="row"><span>Pool withdrawal</span><code>{view.withdrawalTxHash ?? view.withdrawalStatus ?? '—'}</code></div>
        <div className="row"><span>Lighter deposit</span><code>{view.depositStatus ?? '—'}</code></div>
        <div className="row"><span>Open order</span><code>{s.order ? `client ${s.order.clientOrderIndex} · tx ${s.order.tx.txHash.slice(0, 16)}… · ${s.order.tx.status}` : '—'}</code></div>
        <div className="row"><span>Close order</span><code>{s.close ? `client ${s.close.clientOrderIndex} · ${s.close.execution?.lighterStatus ?? s.close.tx.status}` : '—'}</code></div>
        <div className="row"><span>Re-shield</span><code>{view.reshieldUserOpHash ? `${view.reshieldStatus} · ${view.reshieldUserOpHash}` : '—'}</code></div>
        {(s.failedOrders?.length ?? 0) > 0 && <div className="row"><span>Failed attempts</span><code>{s.failedOrders!.length}</code></div>}
      </details>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
