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

  const loadMarkets = useCallback(async () => {
    setError(null);
    try {
      const list = await send({ kind: 'markets' }, 20_000);
      setMarkets(list);
      setMarketId((current) => current ?? list.find((m) => m.tradable)?.marketId ?? null);
    } catch (e) {
      setError(`Markets unavailable: ${(e as Error).message}`);
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
        <span className="field-label">Market orders only · funded just-in-time</span>
      </div>

      {markets === null ? (
        <p className="field-label">{error ?? 'Loading Lighter markets…'}</p>
      ) : (
        <>
          <input placeholder="Search markets" value={filter} disabled={disabled} onChange={(e) => setFilter(e.target.value)} />
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
          {market && (
            <p className="field-label">
              {market.symbol} mark {price(ref)} · 24h {Number.isFinite(market.dailyChangePct) ? `${market.dailyChangePct.toFixed(2)}%` : '—'} · max {market.maxLeverage}x · min {market.minQuoteAmount} USDC notional
            </p>
          )}
        </>
      )}

      <div className="sides">
        <button className={direction === 'long' ? 'long active' : 'long'} disabled={disabled} onClick={() => setDirection('long')}>
          LONG
        </button>
        <button className={direction === 'short' ? 'short active' : 'short'} disabled={disabled} onClick={() => setDirection('short')}>
          SHORT
        </button>
      </div>

      <label className="field-label" htmlFor="margin">
        Margin (USDC withdrawn from Privacy Pools)
      </label>
      <input id="margin" inputMode="decimal" value={margin} disabled={disabled} onChange={(e) => setMargin(e.target.value)} />

      <label className="field-label" htmlFor="leverage">
        Leverage: {leverage}x {market ? `(max ${market.maxLeverage}x)` : ''}
      </label>
      <input
        id="leverage"
        type="range"
        min={1}
        max={market?.maxLeverage ?? 1}
        step={1}
        value={leverage}
        disabled={disabled || !market}
        onChange={(e) => setLeverage(Number(e.target.value))}
      />
      <p className="field-label">
        Notional = {marginNum.toFixed(2)} × {leverage} = <strong>{money(notional)}</strong>
        {ref > 0 && ` ≈ ${(notional / ref).toPrecision(4)} ${market?.symbol ?? ''}`}
      </p>

      {quote ? (
        <OrderSummary quote={quote} />
      ) : (
        <button disabled={disabled || !market?.tradable || !marginUnits} onClick={() => void review()}>
          {working === 'quote' ? 'Checking spendable balance…' : 'Review order'}
        </button>
      )}

      {quote && (
        <button className={direction} disabled={disabled} onClick={() => void confirm()}>
          {working === 'open' ? 'Starting…' : `Confirm ${direction.toUpperCase()} ${quote.symbol}`}
        </button>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

function OrderSummary({ quote }: { quote: TradeQuote }) {
  const rows: [string, string][] = [
    ['Market', `${quote.symbol}-PERP`],
    ['Direction', quote.direction.toUpperCase()],
    ['Order type', 'Market (immediate-or-cancel)'],
    ['Margin', `${usdc(quote.marginUnits)} USDC`],
    ['Leverage', `${quote.leverage}x`],
    ['Notional', `${money(quote.notionalUsd)} (sized from margin less a 2% buffer)`],
    ['Est. position size', `${quote.estimatedSize} ${quote.symbol} @ ~${price(quote.referencePrice)}`],
    ['Pool withdrawal', `${usdc(quote.grossWithdrawalUnits)} USDC gross → ~${usdc(quote.expectedNetUnits)} to Lighter`],
    ['Relayer fee (est.)', `${usdc(quote.relayerFeeEstimateUnits)} USDC`],
    ['Lighter taker fee', `${quote.takerFeePct}% ≈ ${money(quote.takerFeeEstimateUsd)}`],
    ['Exit costs (later)', `≤ ${usdc(quote.reshieldGasReserveUnits)} USDC gas + ${quote.poolVettingFeeBps / 100}% pool fee on re-shield`],
    ['Spendable now', `${usdc(quote.spendableUnits)} USDC${Number(quote.pendingAspUnits) > 0 ? ` (+${usdc(quote.pendingAspUnits)} pending ASP)` : ''}`],
    ['Funding source', quote.fundingSource],
  ];
  return (
    <div className="summary">
      {rows.map(([k, v]) => (
        <div key={k} className="row">
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
      {quote.warnings.map((w) => (
        <p key={w} className="hint">
          {w}
        </p>
      ))}
      <p className="hint">A fresh owner address and a fresh Lighter account are used for this trade only.</p>
    </div>
  );
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

  if (!view) return <p className="field-label">Loading trade session…</p>;
  const s = view.session;
  const current = STEPS.findIndex((st) => st.states.includes(s.state));
  const failed = ['funding-failed', 'deposit-problem', 'order-failed', 'close-failed'].includes(s.state);
  const ex = s.order?.execution;
  const pos = view.position;
  const disabled = busy || working !== null;

  return (
    <div className="trade">
      <div className="trade-head">
        <strong>
          {s.direction.toUpperCase()} {s.symbol}-PERP · {s.leverage}x · {usdc(s.marginUnits)} USDC
        </strong>
        <span className="field-label">Session {s.id.slice(0, 8)}</span>
      </div>

      <ol className="steps">
        {STEPS.map((st, i) => (
          <li key={st.label} className={i < current ? 'done' : i === current ? (failed ? 'failed' : 'now') : ''}>
            {st.label}
          </li>
        ))}
      </ol>

      <div className={failed ? 'phase failed' : 'phase'}>
        <strong>{s.state.replace(/-/g, ' ')}</strong>
        <p>{s.detail}</p>
        {s.blocked === 'locked' && <p className="error">Unlock Truly to continue — this step signs with the trade's keys.</p>}
        {s.error && s.error.code !== 'transient' && (
          <p className="error">
            {s.error.code}: {s.error.message}
          </p>
        )}
        {s.error?.code === 'transient' && <p className="hint">Last check failed, retrying: {s.error.message}</p>}
      </div>

      {ex && ex.state !== 'unfilled' && (
        <div className="summary">
          <div className="row"><span>Execution</span><span>{ex.state === 'filled' ? 'FILLED' : 'PARTIALLY FILLED'} (Lighter: {ex.lighterStatus})</span></div>
          <div className="row"><span>Order ID</span><span>{ex.orderIndex}</span></div>
          <div className="row"><span>Market</span><span>{s.symbol}-PERP · {s.direction.toUpperCase()}</span></div>
          <div className="row"><span>Avg. execution price</span><span>{price(ex.averagePrice)}</span></div>
          <div className="row"><span>Filled</span><span>{ex.filledBase} of {s.order!.baseAmount} {s.symbol}</span></div>
          <div className="row"><span>Size (USD)</span><span>{money(ex.filledQuote)}</span></div>
          <div className="row"><span>Margin used</span><span>{money(s.order!.marginUsd)} of {money(s.creditedUsd)} credited</span></div>
          <div className="row"><span>Fees paid</span><span>{money(ex.feesUsd, 4)} over {ex.fillCount} fill{ex.fillCount === 1 ? '' : 's'}</span></div>
        </div>
      )}

      {pos && (
        <div className="summary position">
          <div className="row"><span>Position</span><span className={pos.sign > 0 ? 'pos-long' : 'pos-short'}>{pos.sign > 0 ? 'LONG' : 'SHORT'} {pos.size} {pos.symbol || s.symbol}</span></div>
          <div className="row"><span>Entry</span><span>{price(pos.avgEntryPrice)}</span></div>
          <div className="row"><span>Size (USD)</span><span>{money(pos.positionValue)}</span></div>
          <div className="row"><span>Margin</span><span>{money(pos.allocatedMargin > 0 ? pos.allocatedMargin : (view.account?.collateral ?? null))}</span></div>
          <div className="row"><span>Leverage</span><span>{pos.initialMarginFraction > 0 ? `${(100 / pos.initialMarginFraction).toFixed(1)}x` : `${s.leverage}x`}</span></div>
          <div className="row"><span>Unrealised PnL</span><span className={pos.unrealizedPnl >= 0 ? 'pos-long' : 'pos-short'}>{money(pos.unrealizedPnl, 4)}</span></div>
          <div className="row"><span>Liquidation</span><span>{pos.liquidationPrice > 0 ? price(pos.liquidationPrice) : '—'}</span></div>
          <div className="row"><span>Status</span><span>{s.state === 'closing' ? 'closing…' : 'open'}</span></div>
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
