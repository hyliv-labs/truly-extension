/**
 * The Ghosty deposit flow: home, add funds, connect, go ghost, progress, ready.
 *
 * It drives the same worker calls as TradeForm, UniswapSwap and
 * CompoundSupply; only the screens are new. Everything after "ready"
 * (bringing funds back, failures past funding) still uses those panels.
 */

import { useCallback, useEffect, useState } from 'react';
import { send, SLOW_TIMEOUT_MS, type VaultStatus } from '@truly/lib/messages';
import { railgunReady, type ShieldedBalance } from '@truly/lib/shielded-balance';
import type { RailgunSyncStatus } from '@truly/lib/railgun-sync-status';
import type { TradeQuote } from '@truly/lib/trade-plan';
import type { SessionView } from '@truly/lib/trade-session';
import { Mascot } from './Mascot';
import { EyeIcon, GxBack, GxBrand, GxScreen } from './Ghosty';

export type Venue = 'lighter' | 'uniswap' | 'compound';

export const VENUES: Record<Venue, { name: string; url: string; minUnits: bigint; ready: string }> = {
  lighter: { name: 'Lighter', url: 'https://app.lighter.xyz', minUnits: 5_000_000n, ready: 'Trade' },
  uniswap: { name: 'Uniswap', url: 'https://app.uniswap.org/swap?chain=arbitrum', minUnits: 1_000_000n, ready: 'Swap' },
  compound: { name: 'Compound', url: 'https://app.compound.finance/markets/usdc-arb', minUnits: 1_000_000n, ready: 'Supply' },
};

export const venueLogo = (v: Venue) => chrome.runtime.getURL(`apps/${v}.png`);

export function venueFromSite(site: string | null | undefined): Venue | null {
  if (!site) return null;
  if (site.includes('lighter')) return 'lighter';
  if (site.includes('uniswap')) return 'uniswap';
  if (site.includes('compound')) return 'compound';
  return null;
}

function toUnits(input: string): bigint | null {
  if (!/^\d+(\.\d{0,6})?$/.test(input.trim())) return null;
  const [whole, frac = ''] = input.trim().split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

const fmt = (units: bigint | string) => (Number(units) / 1e6).toFixed(2);

/** Plain-language versions of the worker's failure details. The original stays in More options. */
function friendly(detail: string | null | undefined): string {
  const d = detail ?? '';
  if (/proving key/.test(d)) return d;
  if (/ETH/.test(d) && /gas/i.test(d)) return 'It needs a little ETH on Arbitrum for gas. Nothing left your private balance.';
  if (/timed? ?out|timeout/i.test(d)) return 'The network was slow to answer. Nothing left your private balance.';
  if (/insufficient|not enough/i.test(d)) return 'Not enough in your private balance for that amount.';
  return d ? 'Something went wrong. Nothing left your private balance.' : 'Nothing left your private balance.';
}

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const PLUS = 'M12 5v14M5 12h14';
const UP = 'M12 20V5M6 11l6-6 6 6';
const GHOST = 'M5 20V11a7 7 0 0 1 14 0v9l-2.5-2-2.3 2-2.2-2-2.2 2-2.3-2zM9.5 11h.01M14.5 11h.01';
const GEAR = 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z';

function SiteChip({ venue, live }: { venue: Venue; live?: boolean }) {
  return (
    <span className="gx-site">
      <img src={venueLogo(venue)} alt="" />
      {VENUES[venue].name}
      {live && <span className="gx-live" />}
    </span>
  );
}

/* ------------------------------------------------------------------ Home */

export function GhostHome({
  balance,
  balanceError,
  balanceLoading,
  sync,
  venue,
  onGoGhost,
  onAddFunds,
  onRetry,
  onAdvanced,
}: {
  balance: ShieldedBalance | null;
  balanceError: string | null;
  balanceLoading: boolean;
  sync: RailgunSyncStatus | null;
  venue: Venue | null;
  onGoGhost: () => void;
  onAddFunds: () => void;
  onRetry: () => void;
  onAdvanced: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const ready = balance !== null && railgunReady(balance.railgun);
  const spendable = ready ? BigInt((balance!.railgun as { spendableUnits: string }).spendableUnits) : 0n;
  const empty = ready && spendable === 0n;
  const syncing = !ready && balanceLoading;
  const pct = sync ? Math.round(Math.min(1, Math.max(0, sync.progress)) * 100) : null;

  return (
    <GxScreen>
      <div className="gx-top">
        <GxBrand />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {venue && <SiteChip venue={venue} live />}
          <button type="button" className="gx-icon" aria-label="Advanced" onClick={onAdvanced}>
            <Icon d={GEAR} size={15} />
          </button>
        </span>
      </div>

      <div className="gx-card">
        <div className="gx-card-head">
          <span>Private balance</span>
          {ready && (
            <button type="button" className="gx-link" aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>
              <EyeIcon off={revealed} />
              {revealed ? 'Hide' : 'Reveal'}
            </button>
          )}
        </div>
        {ready ? (
          <div className="gx-stack gx-amount">
            <span className="gx-mono gx-shim" style={{ opacity: revealed ? 0 : 1 }}>*****.**</span>
            <span className="gx-mono" style={{ opacity: revealed ? 1 : 0 }}>
              {fmt(spendable)} <small>USDC</small>
            </span>
          </div>
        ) : syncing ? (
          <div className="gx-sync">
            <span>Finding your private balance{pct !== null ? ` · ${pct}%` : '…'}</span>
            <i><b style={{ width: `${pct ?? 15}%` }} /></i>
            <small>First time only. Later it takes seconds.</small>
          </div>
        ) : (
          <div className="gx-sync">
            <span>{balanceError ? 'Couldn’t read your balance.' : 'Not read yet.'}</span>
            <button type="button" className="gx-link" onClick={onRetry}>Try again</button>
          </div>
        )}
      </div>

      <div className="gx-hint-row">
        {empty ? (
          <>
            <Mascot size={34} />
            <span>Add USDC to start going ghost.</span>
          </>
        ) : venue ? (
          <span>Ready to go ghost on {VENUES[venue].name}.</span>
        ) : (
          <span>Open an app, or pick one when you tap Go ghost.</span>
        )}
      </div>

      <div className="gx-actions">
        <button type="button" className={`gx-act${empty ? ' primary' : ''}`} onClick={onAddFunds}>
          <Icon d={PLUS} />
          Add funds
        </button>
        <button type="button" className={`gx-act${empty ? '' : ' primary'}`} disabled={!ready || empty} onClick={onGoGhost}>
          <Icon d={GHOST} />
          Go ghost
        </button>
        <button type="button" className="gx-act" disabled title="Available once an app is funded">
          <Icon d={UP} />
          Bring back
        </button>
      </div>
    </GxScreen>
  );
}

/* ------------------------------------------------------------- Add funds */

export function AddFunds({ onBack }: { onBack: () => void }) {
  return (
    <GxScreen>
      <div className="gx-top">
        <GxBack onClick={onBack} label="Add funds" />
      </div>
      <div className="gx-hero">
        <Mascot size={84} className="gx-mascot" />
        <h1 className="gx-title">Shield USDC to start</h1>
        <p className="gx-sub">
          Send USDC on Arbitrum into Railgun from any Railgun wallet, using this Ghosty&apos;s recovery phrase. It shows up
          here as your private balance.
        </p>
      </div>
      <button type="button" className="gx-btn primary" disabled>
        Shield from your wallet · soon
      </button>
    </GxScreen>
  );
}

/* --------------------------------------------------------------- Connect */

export function ConnectScreen({
  site,
  venue,
  busy,
  error,
  onConnect,
}: {
  site: string;
  venue: Venue | null;
  busy: boolean;
  error: string | null;
  onConnect: () => void;
}) {
  return (
    <GxScreen>
      <div className="gx-top">
        <GxBrand />
      </div>
      <div className="gx-hero">
        <div className="gx-link-row">
          {venue ? <img className="gx-app" src={venueLogo(venue)} alt="" /> : <span className="gx-app gx-app-blank" />}
          <svg aria-hidden="true" width="44" height="10" viewBox="0 0 44 10" fill="none">
            <path className="gx-dash" d="M2 5h40" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <Mascot size={56} />
        </div>
        <h1 className="gx-title">{site} wants to connect</h1>
        <p className="gx-sub">{busy ? 'Making a fresh private account. The first one can take a minute.' : 'It will see a private account, never your wallet.'}</p>
      </div>
      {error && <p className="gx-error">{error}</p>}
      <button type="button" className="gx-btn primary" disabled={busy} onClick={onConnect}>
        {busy ? 'Connecting…' : 'Connect privately'}
      </button>
      <button type="button" className="gx-btn quiet" disabled={busy} onClick={() => window.close()}>
        Cancel
      </button>
    </GxScreen>
  );
}

/* ---------------------------------------------------------------- Amount */

export function GoGhost({
  venue: fixedVenue,
  spendableUnits,
  onBack,
  onStarted,
}: {
  venue: Venue | null;
  spendableUnits: bigint;
  onBack: () => void;
  onStarted: () => Promise<void>;
}) {
  const [venue, setVenue] = useState<Venue>(fixedVenue ?? 'lighter');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fast, setFast] = useState<boolean | null>(null);

  useEffect(() => {
    if (venue !== 'lighter') return;
    void send({ kind: 'fundingSpeed' }, 20_000).then((f) => setFast(f.fast)).catch(() => setFast(null));
  }, [venue]);
  useEffect(() => setQuote(null), [amount, venue]);

  const units = toUnits(amount);
  const min = VENUES[venue].minUnits;
  const tooSmall = units !== null && units < min;
  const tooBig = units !== null && units > spendableUnits;
  const invalid = amount.trim() !== '' && units === null;
  const canGo = units !== null && !tooSmall && !tooBig && !working;
  const readyIn = venue === 'lighter' ? (fast === false ? '15 to 20 minutes' : 'About a minute') : 'About a minute';

  const preset = (u: bigint) => setAmount(fmt(u < 0n ? 0n : u));

  const go = async () => {
    if (!canGo || units === null) return;
    setWorking(true);
    setError(null);
    try {
      if (venue === 'lighter') {
        const trade = { marginUnits: units.toString(), fundingSource: 'railgun' as const, depositOnly: true as const };
        if (!quote) {
          // First tap: price it. Second tap: send it.
          setQuote(await send({ kind: 'quoteTrade', trade }, 30_000));
          return;
        }
        await send({ kind: 'openTrade', trade }, SLOW_TIMEOUT_MS);
      } else if (venue === 'uniswap') {
        await send({ kind: 'fundUniswap', amountUnits: units.toString() }, SLOW_TIMEOUT_MS);
      } else {
        await send({ kind: 'fundCompound', amountUnits: units.toString() }, SLOW_TIMEOUT_MS);
      }
      await onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await onStarted().catch(() => undefined);
    } finally {
      setWorking(false);
    }
  };

  const fee = quote ? BigInt(quote.grossWithdrawalUnits) - BigInt(quote.expectedNetUnits) : null;

  return (
    <GxScreen>
      <div className="gx-top">
        <GxBack onClick={onBack} label={`Go ghost on ${VENUES[venue].name}`} disabled={working} />
      </div>

      {!fixedVenue && (
        <div className="gx-venues" role="radiogroup" aria-label="App">
          {(Object.keys(VENUES) as Venue[]).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={venue === v} className={venue === v ? 'on' : ''} disabled={working} onClick={() => setVenue(v)}>
              <img src={venueLogo(v)} alt="" />
              {VENUES[v].name}
            </button>
          ))}
        </div>
      )}

      <label className="gx-big-amount">
        <input
          inputMode="decimal"
          placeholder="0.00"
          aria-label="Amount in USDC"
          value={amount}
          disabled={working}
          autoFocus
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void go();
          }}
        />
        <span>USDC</span>
      </label>
      <p className={`gx-note${invalid || tooSmall || tooBig ? ' bad' : ''}`}>
        {invalid
          ? 'Up to 6 decimals.'
          : tooSmall
            ? `At least ${fmt(min)} USDC on ${VENUES[venue].name}.`
            : tooBig
              ? 'More than your private balance.'
              : `${fmt(spendableUnits)} available privately`}
      </p>
      {!quote && <div className="gx-presets">
        <button type="button" onClick={() => preset(10_000_000n)} disabled={working}>10</button>
        <button type="button" onClick={() => preset(25_000_000n)} disabled={working}>25</button>
        <button type="button" onClick={() => preset(spendableUnits)} disabled={working}>Max</button>
      </div>}

      <div className="gx-spacer" />
      <div className="gx-card gx-facts">
        <div>
          <span>{VENUES[venue].name} sees</span>
          <span>A new account{units !== null && !invalid ? `, ${fmt(units)} USDC` : ''}</span>
        </div>
        {fee !== null && (
          <div>
            <span>Fee</span>
            <span>{fmt(fee)} USDC</span>
          </div>
        )}
        <div>
          <span>Ready in</span>
          <span>{readyIn}</span>
        </div>
      </div>
      {error && <p className="gx-error">{error}</p>}
      <button type="button" className="gx-btn primary" disabled={!canGo} onClick={() => void go()}>
        {working ? (quote || venue !== 'lighter' ? 'Starting…' : 'Checking…') : quote ? `Confirm ${fmt(units ?? 0n)} USDC` : 'Go ghost'}
      </button>
    </GxScreen>
  );
}

/* ------------------------------------------------------ Progress / ready */

type Stage = 'paying' | 'crediting' | 'ready' | 'failed';

/** Where a funding attempt stands, for any venue. Null: not in the deposit phase. */
export function depositStage(status: VaultStatus | null): { venue: Venue; stage: Stage } | null {
  const t = status?.activeTrade;
  if (!t) return null;
  if (t.uniswap || t.compound) {
    const view = t.uniswap ?? t.compound!;
    const venue: Venue = t.uniswap ? 'uniswap' : 'compound';
    if (view.status === 'funding') return { venue, stage: 'paying' };
    if (view.status === 'funded') return { venue, stage: 'ready' };
    if (view.status === 'failed' && !view.unshieldTx) return { venue, stage: 'failed' };
    return null;
  }
  const s = t.session?.state;
  if (!s) return null;
  if (s === 'funding') return { venue: 'lighter', stage: 'paying' };
  if (s === 'awaiting-deposit' || s === 'registering-key') return { venue: 'lighter', stage: 'crediting' };
  if (s === 'funded') return { venue: 'lighter', stage: 'ready' };
  if (s === 'funding-failed' || s === 'deposit-problem') return { venue: 'lighter', stage: 'failed' };
  return null;
}

export function GhostProgress({
  status,
  venue,
  stage,
  onChanged,
  onManage,
}: {
  status: VaultStatus;
  venue: Venue;
  stage: Stage;
  onChanged: () => Promise<void>;
  onManage: () => void;
}) {
  const [view, setView] = useState<SessionView | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = status.activeTrade!;
  const lighter = venue === 'lighter';
  const amountUnits = lighter ? t.session?.marginUnits : (t.uniswap ?? t.compound)?.amountIn;
  const name = VENUES[venue].name;

  // A Lighter trade only moves while something asks it to: this is that.
  const poll = useCallback(async () => {
    try {
      if (lighter) setView(await send({ kind: stage === 'ready' ? 'tradeSession' : 'advanceTrade' }, SLOW_TIMEOUT_MS));
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lighter, stage, onChanged]);

  useEffect(() => {
    if (stage === 'ready' && !lighter) return;
    void poll();
    const id = setInterval(() => void poll(), stage === 'ready' ? 10_000 : 4_000);
    return () => clearInterval(id);
  }, [poll, stage, lighter]);

  const retry = async () => {
    setWorking(true);
    setError(null);
    try {
      if (lighter) await send({ kind: 'retryFunding' }, SLOW_TIMEOUT_MS);
      else if (venue === 'uniswap') await send({ kind: 'fundUniswap', amountUnits: amountUnits ?? '0' }, SLOW_TIMEOUT_MS);
      else await send({ kind: 'fundCompound', amountUnits: amountUnits ?? '0' }, SLOW_TIMEOUT_MS);
      await poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const top = (
    <div className="gx-top">
      <GxBrand />
      <SiteChip venue={venue} live={stage === 'ready'} />
    </div>
  );

  if (stage === 'ready') {
    return (
      <GxScreen>
        {top}
        <div className="gx-hero">
          <span className="gx-done">
            <Mascot size={96} className="gx-mascot" />
            <i><Icon d="m5 12 5 5 9-10" size={16} /></i>
          </span>
          <h1 className="gx-title">You&apos;re a ghost on {name}</h1>
          <p className="gx-sub">
            {VENUES[venue].ready} as usual. {name} sees a private account{amountUnits ? ` with ${fmt(amountUnits)} USDC` : ''}.
            {venue !== 'lighter' && ' Pick Arbitrum, then Ghosty in its wallet list.'}
          </p>
        </div>
        <button type="button" className="gx-btn primary" onClick={() => void chrome.tabs.create({ url: VENUES[venue].url })}>
          Open {name}
        </button>
        <button type="button" className="gx-btn quiet" onClick={onManage}>
          Bring funds back later
        </button>
      </GxScreen>
    );
  }

  const failed = stage === 'failed';
  const detail = lighter ? view?.session.detail ?? t.session?.detail : (t.uniswap ?? t.compound)?.detail;
  const steps: { label: string; state: 'done' | 'now' | 'todo' | 'bad' }[] = [
    { label: stage === 'paying' || failed ? 'Paying from your private balance' : 'Paid from your private balance', state: failed ? 'bad' : stage === 'paying' ? 'now' : 'done' },
    ...(lighter ? [{ label: 'Lighter is crediting it', state: (stage === 'crediting' ? 'now' : 'todo') as 'now' | 'todo' }] : []),
    { label: `Ready to ${VENUES[venue].ready.toLowerCase()}`, state: 'todo' },
  ];
  const wait = lighter && stage === 'crediting' ? 'This can take up to 20 minutes.' : 'About a minute.';

  return (
    <GxScreen>
      {top}
      <div className="gx-hero">
        <div className="gx-link-row">
          <Mascot size={58} className="gx-mascot" />
          <svg aria-hidden="true" width="64" height="10" viewBox="0 0 64 10" fill="none">
            <path className={failed ? '' : 'gx-dash'} d="M2 5h60" stroke={failed ? 'var(--gx-danger)' : 'var(--accent)'} strokeWidth="2" strokeLinecap="round" />
          </svg>
          <img className="gx-app" src={venueLogo(venue)} alt="" />
        </div>
        <h1 className="gx-title">{failed ? 'That didn’t go through' : `Going ghost on ${name}…`}</h1>
      </div>
      <ol className="gx-steps">
        {steps.map((s) => (
          <li key={s.label} className={s.state}>
            <i>{s.state === 'done' && <Icon d="m5 12 5 5 9-10" size={11} />}</i>
            {s.label}
          </li>
        ))}
      </ol>
      {failed ? (
        <>
          <p className="gx-note bad">{friendly(error ?? detail)}</p>
          <button type="button" className="gx-btn primary" disabled={working} onClick={() => void retry()}>
            {working ? 'Retrying…' : 'Try again'}
          </button>
          <button type="button" className="gx-btn quiet" onClick={onManage}>
            More options
          </button>
        </>
      ) : (
        <p className="gx-note">{wait} You can close this.</p>
      )}
    </GxScreen>
  );
}
