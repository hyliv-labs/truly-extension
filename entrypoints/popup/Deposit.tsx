/**
 * The Ghosty deposit flow: home, add funds, connect, go ghost, progress, ready.
 *
 * It drives the same worker calls as TradeForm, UniswapSwap and
 * CompoundSupply; only the screens are new. Bringing funds back is Return.tsx.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { send, SLOW_TIMEOUT_MS, type VaultStatus } from '@truly/lib/messages';
import { railgunReady, type ShieldedBalance } from '@truly/lib/shielded-balance';
import type { RailgunSyncStatus } from '@truly/lib/railgun-sync-status';
import type { TradeQuote } from '@truly/lib/trade-plan';
import { HYPERLIQUID_APP, HYPERLIQUID_MIN_FUND_UNITS } from '@truly/lib/hyperliquid';
import { APP_VENUE_IDS, APP_VENUES, appVenueFromHost, isAppVenue, type AppVenueId } from '@truly/lib/app-venues';
import type { VenueId } from '@truly/lib/trade';
import type { SessionView } from '@truly/lib/trade-session';
import { Mascot } from './Mascot';
import { EyeIcon, GxBack, GxBrand, GxScreen } from './Ghosty';

export type Venue = VenueId;

export const VENUES: Record<Venue, { name: string; url: string; minUnits: bigint; ready: string }> = {
  lighter: { name: 'Lighter', url: 'https://app.lighter.xyz', minUnits: 5_000_000n, ready: 'Trade' },
  uniswap: { name: 'Uniswap', url: 'https://app.uniswap.org/swap?chain=arbitrum', minUnits: 1_000_000n, ready: 'Swap' },
  compound: { name: 'Compound', url: 'https://app.compound.finance/markets/usdc-arb', minUnits: 1_000_000n, ready: 'Supply' },
  hyperliquid: { name: 'Hyperliquid', url: HYPERLIQUID_APP, minUnits: HYPERLIQUID_MIN_FUND_UNITS, ready: 'Trade' },
  ...(Object.fromEntries(
    APP_VENUE_IDS.map((id) => [id, { name: APP_VENUES[id].name, url: APP_VENUES[id].url, minUnits: APP_VENUES[id].minUnits, ready: APP_VENUES[id].ready }]),
  ) as Record<AppVenueId, { name: string; url: string; minUnits: bigint; ready: string }>),
};

/** The account record a dapp venue keeps on its trade. Lighter keeps a session instead. */
export function appView(venue: Venue, trade: NonNullable<VaultStatus['activeTrade']> | null | undefined) {
  if (!trade) return undefined;
  if (venue === 'uniswap') return trade.uniswap;
  if (venue === 'compound') return trade.compound;
  if (venue === 'hyperliquid') return trade.hyperliquid;
  if (isAppVenue(venue)) return trade.venue === venue ? trade.app : undefined;
  return undefined;
}

export const venueLogo = (v: Venue) => chrome.runtime.getURL(`apps/${v}.png`);

export function venueFromSite(site: string | null | undefined): Venue | null {
  if (!site) return null;
  if (site.includes('lighter')) return 'lighter';
  if (site.includes('uniswap')) return 'uniswap';
  if (site.includes('compound')) return 'compound';
  if (site.includes('hyperliquid')) return 'hyperliquid';
  try {
    return appVenueFromHost(new URL(site.includes('://') ? site : `https://${site}`).hostname);
  } catch {
    return null;
  }
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
  activities,
  onActivity,
  onGoGhost,
  onAddFunds,
  onBringBack,
  onRetry,
  onAdvanced,
  onAnyChain,
  notice,
}: {
  balance: ShieldedBalance | null;
  balanceError: string | null;
  balanceLoading: boolean;
  sync: RailgunSyncStatus | null;
  venue: Venue | null;
  activities: { venue: Venue; amountUnits: string }[];
  onActivity: (venue: Venue) => void;
  onGoGhost: () => void;
  onAddFunds: () => void;
  onBringBack: () => void;
  onRetry: () => void;
  onAdvanced: () => void;
  /** NEAR Intents: send out to, or bring in from, any chain. */
  onAnyChain?: () => void;
  /** Shown above the actions, e.g. a NEAR Intents move that finished while the panel was closed. */
  notice?: ReactNode;
}) {
  const [revealed, setRevealed] = useState(false);
  const ready = balance !== null && railgunReady(balance.railgun);
  const spendable = ready ? BigInt((balance!.railgun as { spendableUnits: string }).spendableUnits) : 0n;
  const pending = ready ? BigInt((balance!.railgun as { pendingUnits?: string }).pendingUnits ?? '0') : 0n;
  const empty = ready && spendable === 0n && pending === 0n;
  const syncing = !ready && balanceLoading;
  const pct = sync ? Math.round(Math.min(1, Math.max(0, sync.progress)) * 100) : null;

  return (
    <GxScreen>
      <div className="gx-top">
        <GxBrand />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {venue && <SiteChip venue={venue} live />}
          <button type="button" className="gx-icon" aria-label="Settings" onClick={onAdvanced}>
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
        {ready && pending > 0n && (
          <small className="gx-pending">{revealed ? `${fmt(pending)} USDC` : 'More'} still landing in Railgun. Spendable in a few minutes.</small>
        )}
      </div>

      {activities.map((activity) => (
        <button key={activity.venue} type="button" className="gx-activity" onClick={() => onActivity(activity.venue)}>
          <img src={venueLogo(activity.venue)} alt="" />
          <span>
            <b>On {VENUES[activity.venue].name}</b>
            <small>Ready. Open it, or bring it back.</small>
          </span>
          <em>{fmt(activity.amountUnits)}</em>
        </button>
      ))}

      <div className="gx-hint-row">
        {activities.length > 0 ? (
          <span>Each app has its own account. You can fund another without bringing one back.</span>
        ) : empty ? (
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

      {notice}

      <div className="gx-actions">
        <button type="button" className={`gx-act${empty && activities.length === 0 ? ' primary' : ''}`} onClick={onAddFunds}>
          <Icon d={PLUS} />
          Add funds
        </button>
        <button type="button" className={`gx-act${activities.length === 0 && !empty ? ' primary' : ''}`} disabled={activities.length === 0 && (!ready || empty)} onClick={onGoGhost}>
          <Icon d={GHOST} />
          Go ghost
        </button>
        <button type="button" className={`gx-act${activities.length === 1 ? ' primary' : ''}`} disabled={activities.length !== 1} title={activities.length === 1 ? undefined : activities.length > 1 ? 'Open an app above, then bring that one back' : 'Available once an app is funded'} onClick={onBringBack}>
          <Icon d={UP} />
          Bring back
        </button>
      </div>

      {onAnyChain && (
        <button type="button" className="gx-option" onClick={onAnyChain}>
          <b>Any chain · NEAR Intents</b>
          <span>{empty || !ready ? 'Bring funds in from Zcash, Aleo, Solana, Bitcoin and 30+ chains.' : 'Send out to 30+ chains, or bring funds in from Zcash, Aleo and more.'}</span>
        </button>
      )}
    </GxScreen>
  );
}

/* ------------------------------------------------------------- Add funds */

const RAILGUN_FEE_BPS = 25n;
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function AddFunds({
  onBack,
  onDone,
  onPrivate,
}: {
  onBack: () => void;
  onDone: () => Promise<void>;
  /** NEAR Intents Bring in: from a shielded wallet or any other chain, with no public address of the user's. */
  onPrivate?: () => void;
}) {
  const [wallet, setWallet] = useState<{ address: string; usdcUnits: bigint; ethWei: bigint } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<'form' | 'moving' | 'done' | 'failed'>('form');
  const [error, setError] = useState<string | null>(null);
  const [shieldedUnits, setShieldedUnits] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const view = await send({ kind: 'fundingWallet' }, SLOW_TIMEOUT_MS);
      setWallet({ address: view.address, usdcUnits: BigInt(view.usdcUnits), ethWei: BigInt(view.ethWei) });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const units = toUnits(amount);
  const available = wallet?.usdcUnits ?? 0n;
  const tooSmall = units !== null && units < 1_000_000n;
  const tooBig = units !== null && units > available;
  const invalid = amount.trim() !== '' && units === null;
  const lowEth = wallet !== null && wallet.ethWei < 50_000_000_000_000n;
  const canShield = phase !== 'moving' && units !== null && !tooSmall && !tooBig;
  const received = units === null ? null : (units * (10_000n - RAILGUN_FEE_BPS)) / 10_000n;

  const copyAddress = async () => {
    if (!wallet) return;
    await navigator.clipboard.writeText(wallet.address);
    setCopied(true);
  };

  const shield = async () => {
    if (!canShield || units === null) return;
    setPhase('moving');
    setError(null);
    try {
      const shielded = await send({ kind: 'shieldFundingWallet', amountUnits: units.toString() }, SLOW_TIMEOUT_MS);
      setShieldedUnits(shielded.amountUnits);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    }
  };

  if (phase === 'moving' || phase === 'failed') {
    return (
      <GxScreen>
        <div className="gx-top">
          <GxBack onClick={onBack} label="Add funds" disabled={phase === 'moving'} />
        </div>
        <div className="gx-hero">
          <Mascot size={84} className="gx-mascot" />
          <h1 className="gx-title">{phase === 'failed' ? 'That didn’t go through' : 'Shielding USDC…'}</h1>
        </div>
        <ol className="gx-steps">
          <li className={phase === 'failed' ? 'bad' : 'now'}>
            <i />
            Paying from this address
          </li>
          <li className="todo">
            <i />
            In your private balance
          </li>
        </ol>
        {phase === 'failed' ? (
          <>
            <p className="gx-note bad">{error}</p>
            <button type="button" className="gx-btn primary" onClick={() => void shield()}>
              Try again
            </button>
          </>
        ) : (
          <p className="gx-note">About a minute. You can close this.</p>
        )}
      </GxScreen>
    );
  }

  if (phase === 'done') {
    return (
      <GxScreen>
        <div className="gx-top">
          <GxBrand />
        </div>
        <div className="gx-hero">
          <span className="gx-done">
            <Mascot size={96} className="gx-mascot" />
            <i><Icon d="m5 12 5 5 9-10" size={16} /></i>
          </span>
          <h1 className="gx-title">In your private balance</h1>
          <p className="gx-sub">
            {shieldedUnits ? `${fmt(shieldedUnits)} USDC left this address.` : 'The USDC is shielded.'} Railgun takes a 0.25% fee on the way in.
          </p>
        </div>
        <button type="button" className="gx-btn primary" onClick={() => void onDone()}>
          Done
        </button>
      </GxScreen>
    );
  }

  return (
    <GxScreen>
      <div className="gx-top">
        <GxBack onClick={onBack} label="Add funds" />
      </div>
      <div className="gx-hero">
        <Mascot size={72} className="gx-mascot" />
        <h1 className="gx-title">Shield USDC to start</h1>
        <p className="gx-sub">Send USDC on Arbitrum to this Ghosty address. Shield moves it into your private balance.</p>
      </div>
      <div className="gx-card gx-receive">
        <code>{wallet ? shortAddress(wallet.address) : 'Reading…'}</code>
        <button type="button" className="gx-link" disabled={!wallet} onClick={() => void copyAddress()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <label className="gx-big-amount">
        <input
          inputMode="decimal"
          placeholder="0.00"
          aria-label="Amount in USDC"
          value={amount}
          autoFocus
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void shield();
          }}
        />
        <span>USDC</span>
      </label>
      <p className={`gx-note${invalid || tooSmall || tooBig || loadError ? ' bad' : ''}`}>
        {loadError
          ? loadError
          : invalid
            ? 'Up to 6 decimals.'
            : tooSmall
              ? 'At least 1.00 USDC.'
              : tooBig
                ? 'More than this address holds.'
                : wallet
                  ? `${fmt(available)} USDC on this address`
                  : 'Reading this address…'}
      </p>
      <div className="gx-presets">
        <button type="button" onClick={() => setAmount('10')} disabled={!wallet}>10</button>
        <button type="button" onClick={() => setAmount('25')} disabled={!wallet}>25</button>
        <button type="button" onClick={() => setAmount(fmt(available))} disabled={!wallet || available === 0n}>Max</button>
      </div>
      <div className="gx-spacer" />
      {lowEth && <p className="gx-note">This address also needs a little ETH for gas.</p>}
      <div className="gx-card gx-facts">
        <div>
          <span>Private balance receives</span>
          <span>{received === null ? '—' : `${fmt(received)} USDC`}</span>
        </div>
        <div>
          <span>Fee</span>
          <span>0.25%</span>
        </div>
        <div>
          <span>Ready in</span>
          <span>About a minute</span>
        </div>
      </div>
      {error && <p className="gx-error">{error}</p>}
      <button type="button" className="gx-btn primary" disabled={!canShield} onClick={() => void shield()}>
        {units !== null && !invalid ? `Shield ${fmt(units)} USDC` : 'Shield from your wallet'}
      </button>
      {loadError && (
        <button type="button" className="gx-btn quiet" onClick={() => void load()}>
          Try again
        </button>
      )}
      {onPrivate && (
        <button type="button" className="gx-option" onClick={onPrivate}>
          <b>Privately, from any wallet or chain</b>
          <span>Zcash (Zashi, Zingo, YWallet…), Aleo, Solana, Bitcoin and 30+ chains through NEAR Intents. No public address of yours is involved.</span>
        </button>
      )}
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
  activeVenues,
  onBack,
  onStarted,
  onResume,
  pendingUnits = 0n,
  onBringIn,
}: {
  venue: Venue | null;
  spendableUnits: bigint;
  /** Shielded but not spendable yet (a fresh shield still landing in Railgun's tree). */
  pendingUnits?: bigint;
  /** Too little to fund this app: bring more in through NEAR Intents. */
  onBringIn?: () => void;
  /** Venues that already have a funded address. Another app can still be funded. */
  activeVenues?: Venue[];
  onBack: () => void;
  onStarted: (venue: Venue) => Promise<void>;
  onResume?: () => void;
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
  const openVenues = activeVenues ?? [];
  const resumeHere = openVenues.includes(venue);
  const canGo = resumeHere || (units !== null && !tooSmall && !tooBig && !working);
  const readyIn = venue === 'lighter' ? (fast === false ? '15 to 20 minutes' : 'About a minute') : venue === 'hyperliquid' ? 'A few minutes' : 'About a minute';

  const preset = (u: bigint) => setAmount(fmt(u < 0n ? 0n : u));

  const go = async () => {
    if (resumeHere) {
      onResume?.();
      return;
    }
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
      } else if (venue === 'hyperliquid') {
        await send({ kind: 'fundHyperliquid', amountUnits: units.toString() }, SLOW_TIMEOUT_MS);
      } else if (isAppVenue(venue)) {
        await send({ kind: 'fundApp', venue, amountUnits: units.toString() }, SLOW_TIMEOUT_MS);
      } else {
        await send({ kind: 'fundCompound', amountUnits: units.toString() }, SLOW_TIMEOUT_MS);
      }
      await onStarted(venue);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await onStarted(venue).catch(() => undefined);
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

      {resumeHere ? (
        <p className="gx-note">This {VENUES[venue].name} account is already funded. The other apps can stay open.</p>
      ) : (
        <>
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
              ? pendingUnits > 0n && units !== null && units <= spendableUnits + pendingUnits
                ? `More than is spendable yet: ${fmt(pendingUnits)} USDC is still landing in Railgun. Try again in a few minutes.`
                : 'More than your private balance.'
              : `${fmt(spendableUnits)} available privately${pendingUnits > 0n ? `, ${fmt(pendingUnits)} still landing` : ''}`}
      </p>
      {isAppVenue(venue) && APP_VENUES[venue].caution && <p className="gx-note bad">{APP_VENUES[venue].caution}</p>}
      {onBringIn && spendableUnits + pendingUnits < min && (
        <button type="button" className="gx-option" onClick={onBringIn}>
          <b>Not enough for {VENUES[venue].name} yet</b>
          <span>Bring funds in privately from Zcash, Aleo, Solana or any chain. They land in your private balance, then fund this app.</span>
        </button>
      )}
      {!quote && <div className="gx-presets">
        <button type="button" onClick={() => preset(10_000_000n)} disabled={working}>10</button>
        <button type="button" onClick={() => preset(25_000_000n)} disabled={working}>25</button>
        <button type="button" onClick={() => preset(spendableUnits)} disabled={working}>Max</button>
      </div>}
        </>
      )}

      <div className="gx-spacer" />
      {!resumeHere && <div className="gx-card gx-facts">
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
      </div>}
      {error && <p className="gx-error">{error}</p>}
      <button type="button" className="gx-btn primary" disabled={!canGo} onClick={() => void go()}>
        {resumeHere
          ? `Back to ${VENUES[venue].name}`
          : working
              ? quote || venue !== 'lighter'
                ? 'Starting…'
                : 'Checking…'
              : quote
                ? `Confirm ${fmt(units ?? 0n)} USDC`
                : 'Go ghost'}
      </button>
    </GxScreen>
  );
}

/* ------------------------------------------------------ Progress / ready */

type Stage = 'paying' | 'crediting' | 'ready' | 'failed';

function stageOf(venue: Venue, trade: NonNullable<VaultStatus['activeTrade']>): { venue: Venue; stage: Stage } | null {
  if (venue !== 'lighter') {
    const view = appView(venue, trade);
    if (!view) return null;
    if (venue === 'hyperliquid' && trade.hyperliquid?.status === 'funding' && trade.hyperliquid.step === 'crediting') return { venue, stage: 'crediting' };
    if (venue === 'hyperliquid' && trade.hyperliquid?.status === 'failed') return trade.hyperliquid.failedIn === 'shielding' ? null : { venue, stage: 'failed' };
    if (view.status === 'funding') return { venue, stage: 'paying' };
    if (view.status === 'funded') return { venue, stage: 'ready' };
    if (view.status === 'failed' && !view.unshieldTx) return { venue, stage: 'failed' };
    return null;
  }
  const s = trade.session?.state;
  if (!s) return null;
  if (s === 'funding') return { venue: 'lighter', stage: 'paying' };
  if (s === 'awaiting-deposit' || s === 'registering-key') return { venue: 'lighter', stage: 'crediting' };
  if (s === 'funded') return { venue: 'lighter', stage: 'ready' };
  if (s === 'funding-failed' || s === 'deposit-problem') return { venue: 'lighter', stage: 'failed' };
  return null;
}

/** In-progress funding first, then a ready account. Null when nothing is open. */
export function depositStage(status: VaultStatus | null): { venue: Venue; stage: Stage } | null {
  const stages = openStages(status);
  return stages.find((item) => item.stage !== 'ready') ?? stages[0] ?? null;
}

export function openStages(status: VaultStatus | null): { venue: Venue; stage: Stage; amountUnits: string }[] {
  if (!status) return [];
  const book = status.openVenues ?? {};
  const rows: { venue: Venue; stage: Stage; amountUnits: string }[] = [];
  for (const venue of Object.keys(VENUES) as Venue[]) {
    const trade = book[venue] ?? (status.activeTrade && (status.activeTrade.venue ?? 'lighter') === venue ? status.activeTrade : null);
    if (!trade) continue;
    const stage = stageOf(venue, trade);
    if (!stage) continue;
    const amountUnits = venue === 'lighter' ? trade.session?.marginUnits ?? '0' : appView(venue, trade)?.amountIn ?? '0';
    rows.push({ ...stage, amountUnits });
  }
  return rows;
}

export function GhostProgress({
  status,
  venue,
  stage,
  onChanged,
  onBringBack,
  onHome,
  onManage,
}: {
  status: VaultStatus;
  venue: Venue;
  stage: Stage;
  onChanged: () => Promise<void>;
  onBringBack: () => void;
  onHome?: () => void;
  onManage: () => void;
}) {
  const [view, setView] = useState<SessionView | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = status.activeTrade!;
  const lighter = venue === 'lighter';
  const wallet = appView(venue, t);
  const amountUnits = lighter ? t.session?.marginUnits : wallet?.amountIn;
  const name = VENUES[venue].name;

  // A Lighter trade only moves while something asks it to: this is that.
  // A Hyperliquid funding that a worker restart cut off resumes the same way:
  // the worker continues the saved record and never pays the bridge twice.
  const resuming = useRef(false);
  const poll = useCallback(async () => {
    try {
      if (lighter) setView(await send({ kind: stage === 'ready' ? 'tradeSession' : 'advanceTrade' }, SLOW_TIMEOUT_MS));
      // An app funded through NEAR Intents (Lido) waits on the exit; ask the worker to look again.
      if (isAppVenue(venue) && APP_VENUES[venue].fundVia && stage === 'paying' && !resuming.current && amountUnits) {
        resuming.current = true;
        void send({ kind: 'fundApp', venue, amountUnits }, SLOW_TIMEOUT_MS)
          .catch(() => undefined)
          .finally(() => {
            resuming.current = false;
          });
      }
      const cutOff = stage === 'crediting' || (stage === 'paying' && t.hyperliquid?.step === 'bridging' && Boolean(t.hyperliquid.depositTx));
      if (venue === 'hyperliquid' && cutOff && !resuming.current && amountUnits) {
        resuming.current = true;
        void send({ kind: 'fundHyperliquid', amountUnits }, SLOW_TIMEOUT_MS)
          .catch(() => undefined)
          .finally(() => {
            resuming.current = false;
          });
      }
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lighter, venue, stage, amountUnits, onChanged, t.hyperliquid?.step, t.hyperliquid?.depositTx]);

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
      else if (venue === 'hyperliquid') await send({ kind: 'fundHyperliquid', amountUnits: amountUnits ?? '0' }, SLOW_TIMEOUT_MS);
      else if (isAppVenue(venue)) await send({ kind: 'fundApp', venue, amountUnits: amountUnits ?? '0' }, SLOW_TIMEOUT_MS);
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
      {stage === 'ready' && onHome ? (
        <span className="gx-brand-row">
          <button type="button" className="gx-back" aria-label="Dashboard" onClick={onHome}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <GxBrand onClick={onHome} />
        </span>
      ) : (
        <GxBrand />
      )}
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
            {isAppVenue(venue) && APP_VENUES[venue].chain === 'near' ? (
              <>
                {VENUES[venue].ready} as usual. {name} sees a fresh NEAR account holding{amountUnits ? ` about ${fmt(amountUnits)} USDC worth of` : ''} NEAR.
                {' '}Connect, choose NEAR, then Ghosty in the wallet list.
              </>
            ) : (
              <>
                {VENUES[venue].ready} as usual. {name} sees a private account{amountUnits ? ` with ${fmt(amountUnits)} USDC` : ''}.
                {venue === 'hyperliquid'
                  ? ' Connect, pick Ghosty in the wallet list, then Enable trading. The USDC is already in your Hyperliquid account.'
                  : venue !== 'lighter' && ' Pick Arbitrum, then Ghosty in its wallet list.'}
              </>
            )}
          </p>
        </div>
        <button type="button" className="gx-btn primary" onClick={() => void chrome.tabs.create({ url: VENUES[venue].url })}>
          Open {name}
        </button>
        <button type="button" className="gx-btn quiet" onClick={onBringBack}>
          Bring funds back
        </button>
      </GxScreen>
    );
  }

  const failed = stage === 'failed';
  const detail = lighter ? view?.session.detail ?? t.session?.detail : wallet?.detail;
  const steps: { label: string; state: 'done' | 'now' | 'todo' | 'bad' }[] = [
    { label: stage === 'paying' || failed ? 'Paying from your private balance' : 'Paid from your private balance', state: failed ? 'bad' : stage === 'paying' ? 'now' : 'done' },
    ...(lighter || venue === 'hyperliquid' ? [{ label: `${name} is crediting it`, state: (stage === 'crediting' ? 'now' : 'todo') as 'now' | 'todo' }] : []),
    { label: `Ready to ${VENUES[venue].ready.toLowerCase()}`, state: 'todo' },
  ];
  const wait = lighter && stage === 'crediting' ? 'This can take up to 20 minutes.' : venue === 'hyperliquid' || (isAppVenue(venue) && APP_VENUES[venue].fundVia) ? 'A few minutes.' : 'About a minute.';

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
