/**
 * Fund a new account. The user picks an amount and a shielded source. Truly
 * creates a fresh owner, deposits to its Lighter account, and stops. The
 * order is placed on Lighter's own site, with Truly as that account's wallet.
 */

import { useCallback, useEffect, useState } from 'react';
import { send, SLOW_TIMEOUT_MS } from '@truly/lib/messages';
import { railgunReady, type ShieldedBalance } from '@truly/lib/shielded-balance';
import type { TradeQuote } from '@truly/lib/trade-plan';
import type { VenueId } from '@truly/lib/trade';
import { isAppVenue } from '@truly/lib/app-venues';
import type { RailgunSyncStatus } from '@truly/lib/railgun-sync-status';
import type { SessionView } from '@truly/lib/trade-session';
import { ACTIVE_SESSION_STATES, type SessionState } from '@truly/lib/session-types';
import { CompoundSupply } from './CompoundSupply';
import { UniswapSwap } from './UniswapSwap';

const usdc = (units: string | bigint) => (Number(units) / 1e6).toFixed(2);
const money = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) })}`;
const price = (n: number | null | undefined) => money(n, 6);

function toUnits(input: string): string | null {
  if (!/^\d+(\.\d{0,6})?$/.test(input.trim())) return null;
  const [whole, frac = ''] = input.trim().split('.');
  return (BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'))).toString();
}

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function TradeForm({
  busy,
  connecting = false,
  site = null,
  activeVenue = null,
  connectedAddress = null,
  onOpened,
  balance,
  balanceError,
  balanceLoading,
  onRefreshBalance,
  sync = null,
}: {
  busy: boolean;
  connecting?: boolean;
  /** Origin of a site that asked to connect, when the popup was opened for that. */
  site?: string | null;
  /** Set once an address is opened for one venue. The other venue stays closed. */
  activeVenue?: VenueId | null;
  /**
   * Set when Lighter is already connected to a trade that has no deposit yet.
   * Funding attaches to that trade (openTradeSession), so the deposit goes to
   * THIS address, not a new one, and the copy has to say so.
   */
  connectedAddress?: string | null;
  onOpened: () => Promise<void>;
  balance: ShieldedBalance | null;
  balanceError: string | null;
  balanceLoading: boolean;
  onRefreshBalance: () => Promise<void>;
  sync?: RailgunSyncStatus | null;
}) {
  const [margin, setMargin] = useState('10');
  const [venue, setVenue] = useState<VenueId>(
    activeVenue ?? (site?.includes('compound') ? 'compound' : site?.includes('lighter') ? 'lighter' : 'uniswap'),
  );

  useEffect(() => {
    if (activeVenue) setVenue(activeVenue);
  }, [activeVenue]);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [working, setWorking] = useState<'quote' | 'open' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Null until known; the notice says so rather than assuming either way. */
  const [funding, setFunding] = useState<{ fastBridgeLimit: string; fast: boolean } | null>(null);

  useEffect(() => {
    void send({ kind: 'fundingSpeed' }, 20_000).then(setFunding).catch(() => setFunding(null));
  }, []);

  useEffect(() => setQuote(null), [margin]);

  const marginUnits = toUnits(margin);
  const marginNum = marginUnits ? Number(marginUnits) / 1e6 : 0;
  const marginInvalid = margin.trim().length > 0 && marginUnits === null;

  const wire = () => {
    if (!marginUnits) throw new Error('Enter a deposit amount.');
    return { marginUnits, fundingSource: 'railgun' as const, depositOnly: true as const };
  };

  const review = async () => {
    setWorking('quote');
    setError(null);
    try {
      setQuote(await send({ kind: 'quoteTrade', trade: wire() }, 30_000));
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
  const railgunOk = balance !== null && railgunReady(balance.railgun);
  const canReview = railgunOk;

  return (
    <div className="trade">
      {!activeVenue && (
        <div className="venues" role="tablist" aria-label="Venue">
          <button type="button" aria-pressed={venue === 'uniswap'} onClick={() => setVenue('uniswap')}>
            Uniswap
          </button>
          <button type="button" aria-pressed={venue === 'lighter'} onClick={() => setVenue('lighter')}>
            Lighter
          </button>
          <button type="button" aria-pressed={venue === 'compound'} onClick={() => setVenue('compound')}>
            Compound
          </button>
        </div>
      )}
      <BalanceStrip
        balance={balance}
        error={balanceError}
        loading={balanceLoading}
        sync={sync}
        onRefresh={() => void onRefreshBalance()}
      />
      {venue === 'uniswap' ? (
        <UniswapSwap busy={busy} ready={balance !== null && railgunReady(balance.railgun)} onDone={onOpened} />
      ) : venue === 'hyperliquid' || isAppVenue(venue) ? (
        <p className="field-label">This account is funded and brought back from the Ghosty screens.</p>
      ) : venue === 'compound' ? (
        <CompoundSupply busy={busy} ready={balance !== null && railgunReady(balance.railgun)} onDone={onOpened} />
      ) : (
      <>
      <div className="trade-head">
        <strong>{connectedAddress ? 'Fund your Lighter account' : connecting ? 'Connect to Lighter' : 'New account'}</strong>
        <span className="field-label">
          {connectedAddress
            ? `Deposits to ${shortAddress(connectedAddress)}, the address Lighter is connected to. You trade it on Lighter.`
            : connecting
              ? 'The Railgun balance is above. Truly funds a new address and connects it. You trade on Lighter.'
              : 'A fresh address, funded from Railgun. You trade it on Lighter.'}
        </span>
      </div>

      <label className="field-label" htmlFor="margin">Deposit</label>
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
        <p className="field-label">
          Unshielded from Railgun to {connectedAddress ? 'this account' : 'the new account'}. The sender pays the unshield gas in ETH. Lighter credits at least 5 USDC.
        </p>
      )}

      <div className="ticket">
        <span className="ticket-kicker">Deposit</span>
        <span className="ticket-figure">{money(marginNum)}</span>
        <span className="ticket-meta">
          {connectedAddress
            ? `Lands on the Lighter account you connected (${shortAddress(connectedAddress)}). The order is placed on Lighter, not here.`
            : 'Lands on a new Lighter account. The order is placed on Lighter, not here.'}
        </span>
      </div>

      {quote && <OrderSummary quote={quote} />}

      {quote && (
        <p className={funding?.fast ? 'field-label' : 'warn'}>
          {funding === null
            ? 'Checking how fast Lighter will credit this…'
            : funding.fast
              ? 'Lighter’s fast bridge has capacity, so the deposit should credit in moments. Then open Lighter and trade.'
              : 'Lighter’s fast bridge is at zero capacity, so the deposit takes about 15–20 minutes. Then open Lighter and trade.'}
        </p>
      )}

      {quote ? (
        <button disabled={disabled} onClick={() => void confirm()}>
          {working === 'open'
            ? 'Connecting…'
            : connectedAddress
              ? 'Deposit to connected account'
              : connecting
                ? 'Fund and connect'
                : 'Create account and deposit'}
        </button>
      ) : (
        <button disabled={disabled || !marginUnits || !canReview} onClick={() => void review()}>
          {balance === null && balanceLoading ? 'Reading shielded balance…' : working === 'quote' ? 'Reviewing…' : connecting ? 'Review connection' : 'Review deposit'}
        </button>
      )}
      {quote && (
        <button className="link" disabled={disabled} onClick={() => setQuote(null)}>
          Edit amount
        </button>
      )}

      {error && <p className="error">{error}</p>}
      </>
      )}
    </div>
  );
}

function BalanceStrip({
  balance,
  error,
  loading,
  sync,
  onRefresh,
}: {
  balance: ShieldedBalance | null;
  error: string | null;
  loading: boolean;
  sync: RailgunSyncStatus | null;
  onRefresh: () => void;
}) {
  const railgun = balance && railgunReady(balance.railgun) ? balance.railgun : null;
  const railgunError = balance && !railgun && 'error' in balance.railgun ? balance.railgun.error : null;
  return (
    <div className="balances">
      {balance === null && loading ? (
        <div className="balance-card skeleton" role="status">
          <SyncProgress sync={sync} />
        </div>
      ) : balance === null ? (
        <div className="balance-missing">
          <p className="error">{error ?? 'Shielded balance has not been read yet.'}</p>
          <button className="secondary" onClick={onRefresh}>Read balance</button>
        </div>
      ) : (
        <>
          <div className="balance-card active" aria-current="true">
            <span className="name">Railgun</span>
            <span className="amount">{railgun ? usdc(railgun.spendableUnits) : '—'}</span>
            <span className="field-label">
              {railgun
                ? Number(railgun.pendingUnits) > 0
                  ? `${usdc(railgun.pendingUnits)} still syncing`
                  : 'Spendable USDC'
                : 'Spendable USDC'}
            </span>
          </div>
          {railgunError && <p className="error">{railgunError}</p>}
          <div className="balance-meta">
            <span className="field-label">{readLabel(balance.fetchedAt)}. Checked again only if the trade fails.</span>
            <button className="link" disabled={loading} onClick={onRefresh}>
              {loading ? 'Reading…' : 'Refresh'}
            </button>
          </div>
          {error && <p className="error balance-error">{error}</p>}
        </>
      )}
    </div>
  );
}

const SYNC_LABEL: Record<RailgunSyncStatus['phase'], string> = {
  idle: 'Reading Railgun',
  starting: 'Starting the Railgun engine',
  syncing: 'Syncing Railgun',
  'scanning-wallet': 'Finding your notes',
  ready: 'Railgun ready',
  error: 'Railgun sync failed',
};

/**
 * Progress for the first Railgun sync, which downloads and hashes ~134k
 * commitments and takes minutes. Only the first time: it is stored, and later
 * reads fetch only what is new.
 *
 * The rate-limit line is the important one. A stalled sync and a slow sync
 * used to look identical; when the RPC is refusing calls, progress stops while
 * the error count climbs, and saying so beats an indefinite spinner.
 */
function SyncProgress({ sync }: { sync: RailgunSyncStatus | null }) {
  if (!sync) return <span>Reading Railgun</span>;
  const pct = Math.round(sync.progress * 100);
  const mins = sync.startedAt ? Math.floor((Date.now() - sync.startedAt) / 60_000) : 0;
  const stalled = sync.rpcErrors > 0 && Date.now() - sync.updatedAt > 30_000;
  return (
    <div className="sync">
      <span>
        {SYNC_LABEL[sync.phase]}
        {sync.phase === 'syncing' || sync.phase === 'scanning-wallet' ? ` · ${pct}%` : ''}
        {mins > 0 ? ` · ${mins} min` : ''}
      </span>
      {(sync.phase === 'syncing' || sync.phase === 'scanning-wallet') && (
        <div className="meter" aria-hidden>
          <span style={{ width: `${Math.max(3, pct)}%` }} />
        </div>
      )}
      {sync.phase === 'syncing' && (
        <span className="field-label">First time only — later reads take seconds.</span>
      )}
      {stalled && (
        <span className="error">
          The RPC is refusing requests ({sync.rpcErrors} failed). Progress will resume when it recovers.
        </span>
      )}
      {sync.phase === 'error' && sync.error && <span className="error">{sync.error}</span>}
    </div>
  );
}

function readLabel(at: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (mins < 1) return 'Read just now';
  return `Read ${mins} minute${mins === 1 ? '' : 's'} ago`;
}

function OrderSummary({ quote }: { quote: TradeQuote }) {
  const pending = Number(quote.pendingAspUnits) > 0 ? ` · ${usdc(quote.pendingAspUnits)} awaiting ASP` : '';
  return (
    <div className="summary">
      <p className="summary-lead">New Lighter account · no order from Truly</p>
      <div className="row"><span>Deposit</span><span>{usdc(quote.marginUnits)} USDC from {quote.fundingSource}</span></div>
      <div className="row"><span>Sent</span><span>{usdc(quote.grossWithdrawalUnits)} gross, ~{usdc(quote.expectedNetUnits)} to the account</span></div>
      <div className="row"><span>Fee</span><span>~{usdc(quote.relayerFeeEstimateUnits)} from the shielded balance</span></div>
      <div className="row"><span>Spendable</span><span>{usdc(quote.spendableUnits)} USDC{pending}</span></div>
      {quote.warnings.map((w) => (
        <p key={w} className="hint">{w}</p>
      ))}
      <p className="hint">A new owner and a new Lighter account. Open Lighter after it credits and trade there.</p>
    </div>
  );
}

/** Whole minutes since a timestamp, worded so 0 does not read as broken. */
function waitedMinutes(since: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - since) / 60_000));
  if (mins < 1) return 'under a minute';
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

const ORDER_STEPS: { label: string; states: SessionState[] }[] = [
  { label: 'Unshield from Railgun', states: ['funding', 'funding-failed'] },
  { label: 'Lighter credits the deposit', states: ['awaiting-deposit', 'deposit-problem'] },
  { label: 'Authorise trading key', states: ['registering-key'] },
  { label: 'Set leverage', states: ['setting-leverage'] },
  { label: 'Market order executed', states: ['submitting-order', 'order-uncertain', 'order-failed'] },
  { label: 'Position open', states: ['open', 'closing', 'close-failed'] },
  { label: 'Closed', states: ['closed', 'withdrawing', 'withdraw-failed', 'exited', 'reshielding', 'complete'] },
];

const DEPOSIT_STEPS: { label: string; states: SessionState[] }[] = [
  { label: 'Withdraw from the shielded balance', states: ['funding', 'funding-failed'] },
  { label: 'Lighter credits the deposit', states: ['awaiting-deposit', 'deposit-problem'] },
  { label: 'Trade on Lighter', states: ['funded'] },
  { label: 'Withdraw from Lighter', states: ['withdrawing', 'withdraw-failed'] },
  { label: 'Shield back', states: ['exited', 'reshielding', 'complete', 'closed'] },
];

export function SessionPanel({
  busy,
  onChanged,
  balance,
  balanceLoading,
  onRefreshBalance,
}: {
  busy: boolean;
  onChanged: () => Promise<void>;
  balance: ShieldedBalance | null;
  balanceLoading: boolean;
  onRefreshBalance: () => Promise<void>;
}) {
  const [view, setView] = useState<SessionView | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state = view?.session.state;
  const active = state ? ACTIVE_SESSION_STATES.includes(state) : false;
  const failureKey =
    view && ['funding-failed', 'deposit-problem', 'order-failed', 'close-failed', 'withdraw-failed'].includes(view.session.state)
      ? `${view.session.id}:${view.session.state}`
      : null;

  useEffect(() => {
    if (!failureKey) return;
    void onRefreshBalance();
  }, [failureKey, onRefreshBalance]);

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
  const deposit = s.quote.orderType === 'deposit';
  const steps = deposit ? DEPOSIT_STEPS : ORDER_STEPS;
  const current = Math.max(0, steps.findIndex((st) => st.states.includes(s.state)));
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
          {deposit ? `Deposit · ${usdc(s.marginUnits)} USDC` : `${s.direction.toUpperCase()} ${s.symbol}-PERP · ${s.leverage}× · ${usdc(s.marginUnits)} USDC`}
        </span>
        {!failed && (
          <>
            <span className={`ticket-figure${pos ? (pos.unrealizedPnl >= 0 ? ' pos-long' : ' pos-short') : ''}`}>{hero}</span>
            <span className="ticket-meta">{heroCaption}</span>
          </>
        )}
      </div>

      <div className="meter" aria-hidden>
        <span className={failed ? 'failed' : ''} style={{ width: `${((current + 1) / steps.length) * 100}%` }} />
      </div>
      <p className="field-label">
        {current + 1} of {steps.length} ·{' '}
        {steps[current]?.label}
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
              its fast bridge has no capacity.
            </p>
          )}
          {s.blocked === 'locked' && <p className="error">Unlock Truly to continue. This step signs with the trade&apos;s keys.</p>}
          {s.error && s.error.code !== 'transient' && (
            <p className={s.detail.includes(s.error.message) ? 'field-label' : 'error'}>
              {s.detail.includes(s.error.message) ? s.error.code : `${s.error.code}: ${s.error.message}`}
            </p>
          )}
          {s.error?.code === 'transient' && <p className="hint">Last check failed, retrying: {s.error.message}</p>}
          {failed && (
            <p className="field-label">
              {balanceLoading
                ? 'Checking the shielded balance…'
                : balance
                  ? `Shielded now: ${
                      railgunReady(balance.railgun) ? usdc(balance.railgun.spendableUnits) : '—'
                    } Railgun`
                  : 'Could not re-read the shielded balance.'}
            </p>
          )}
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

      {s.state === 'funded' && (
        <div className="summary">
          <p className="summary-lead">Trade this account on Lighter</p>
          <div className="row"><span>Credited</span><span>{money(s.creditedUsd)}</span></div>
          <div className="row"><span>Owner</span><code>{view.ownerAddress}</code></div>
          <p className="hint">Connect Truly on Lighter. This extension will not place or close an order.</p>
          <button disabled={disabled} onClick={() => void act('shield', () => send({ kind: 'shieldFunds' }, SLOW_TIMEOUT_MS))}>
            {working === 'shield' ? 'Starting shield…' : `Shield back into ${s.quote.fundingSource}`}
          </button>
          <p className="hint">
            After you flatten on Lighter, this withdraws the USDC to this owner and shields it
            back into {s.quote.fundingSource}. An open position is left untouched.
          </p>
        </div>
      )}
      {deposit && (s.state === 'reshielding' || s.state === 'complete') && (
        <p className="hint">
          {s.state === 'complete'
            ? `Shielded back into ${s.quote.fundingSource}. This account can be retired.`
            : `Shielding the USDC back into ${s.quote.fundingSource}. Leave this open until it confirms.`}
        </p>
      )}

      {(s.state === 'open' || s.state === 'close-failed') && (
        <button className="short" disabled={disabled} onClick={() => void act('close', () => send({ kind: 'closePosition' }, SLOW_TIMEOUT_MS))}>
          {working === 'close' ? 'Closing…' : 'CLOSE POSITION'}
        </button>
      )}
      {s.state === 'funding-failed' && (
        <button disabled={disabled} onClick={() => void act('fund', () => send({ kind: 'retryFunding' }))}>
          Retry funding from {s.quote.fundingSource}
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
      {s.state === 'withdraw-failed' && (
        <button disabled={disabled} onClick={() => void act('exit', () => send({ kind: 'retryLighterExit' }, SLOW_TIMEOUT_MS))}>
          Retry Lighter withdrawal
        </button>
      )}
      {(s.state === 'order-uncertain' || s.state === 'submitting-order' || s.state === 'closing' || s.state === 'withdrawing') && (
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
        <div className="row"><span>Lighter withdrawal</span><code>{s.exitTx ? `${s.exitTx.amountUnits} units · ${s.exitTx.status}` : '—'}</code></div>
        <div className="row"><span>Re-shield</span><code>{view.reshieldUserOpHash ? `${view.reshieldStatus} · ${view.reshieldUserOpHash}` : '—'}</code></div>
        {(s.failedOrders?.length ?? 0) > 0 && <div className="row"><span>Failed attempts</span><code>{s.failedOrders!.length}</code></div>}
      </details>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
