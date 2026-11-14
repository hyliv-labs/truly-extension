/**
 * Bring funds back, in the same Ghosty screens as the deposit.
 *
 * Lighter: fast-withdraw, then shield. Hyperliquid: withdraw to the
 * address over its bridge, then shield. Uniswap and Compound: read the
 * address and shield what Railgun can hold. Same worker calls as the old
 * panels. An open Lighter position or an open Compound position is refused
 * by the worker; this screen only starts the call.
 */

import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { send, SLOW_TIMEOUT_MS, type VaultStatus } from '@truly/lib/messages';
import { dappVenue } from '@truly/lib/intents';
import { RAILGUN_RETURN_TOKENS } from '@truly/lib/uniswap';
import { Mascot } from './Mascot';
import { GxBack, GxBrand, GxScreen } from './Ghosty';
import { appView, VENUES, venueLogo, type Venue } from './Deposit';
import { APP_VENUES, isAppVenue } from '@truly/lib/app-venues';

export type ReturnPhase = 'confirm' | 'moving' | 'done' | 'failed';

type TokenLine = { token: string; symbol: string; amount: string; reason?: string };

function phaseOf(venue: Venue, trade: NonNullable<VaultStatus['activeTrade']>): { venue: Venue; phase: ReturnPhase } | null {
  if (venue !== 'lighter') {
    const wallet = appView(venue, trade);
    if (!wallet) return null;
    if (venue === 'hyperliquid' && wallet.status === 'failed') return trade.hyperliquid?.failedIn === 'shielding' ? { venue, phase: 'failed' } : null;
    if (wallet.status === 'shielding') return { venue, phase: 'moving' };
    if (wallet.status === 'done') return { venue, phase: 'done' };
    if (wallet.status === 'failed' && wallet.unshieldTx) return { venue, phase: 'failed' };
    return null;
  }
  const state = trade.session?.state;
  if (state === 'withdrawing' || state === 'exited' || state === 'reshielding') return { venue: 'lighter', phase: 'moving' };
  if (state === 'complete') return { venue: 'lighter', phase: 'done' };
  if (state === 'withdraw-failed' || state === 'closed') return { venue: 'lighter', phase: 'failed' };
  return null;
}

export function returnPhase(status: VaultStatus | null): { venue: Venue; phase: ReturnPhase } | null {
  if (!status) return null;
  const book = status.openVenues;
  for (const venue of Object.keys(VENUES) as Venue[]) {
    const trade = book?.[venue];
    if (!trade) continue;
    const phase = phaseOf(venue, trade);
    if (phase) return phase;
  }
  return status.activeTrade ? phaseOf(dappVenue(status.activeTrade.venue) ?? 'lighter', status.activeTrade) : null;
}

function amountLabel(row: TokenLine): string {
  const known = RAILGUN_RETURN_TOKENS.find((token) => token.address.toLowerCase() === row.token.toLowerCase());
  const decimals = row.symbol === 'NEAR' || row.symbol === 'wNEAR' ? 24 : row.symbol === 'ETH' ? 18 : known?.decimals ?? (row.symbol === 'USDC' || row.symbol === 'USDT' ? 6 : 18);
  const text = formatUnits(BigInt(row.amount), decimals);
  const [whole, frac = ''] = text.split('.');
  return `${whole}.${frac.slice(0, 4).replace(/0+$/, '') || '0'} ${row.symbol}`;
}

function plain(detail: string | null | undefined): string {
  const text = detail?.trim() ?? '';
  if (/intrinsic gas|viem@/i.test(text)) return 'The network rejected the transaction. Nothing new was sent.';
  if (/did not answer|timed? ?out|timeout/i.test(text)) return 'This is taking longer than usual. Leave it open, or try again.';
  return text || 'That didn’t finish.';
}

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function SiteChip({ venue }: { venue: Venue }) {
  return (
    <span className="gx-site">
      <img src={venueLogo(venue)} alt="" />
      {VENUES[venue].name}
    </span>
  );
}

function linesOf(status: VaultStatus, venue: Venue): { shielded: TokenLine[]; left: TokenLine[] } {
  const view = appView(venue, status.activeTrade);
  return { shielded: view?.shielded ?? [], left: view?.left ?? [] };
}

export function GhostReturn({
  status,
  venue,
  phase,
  onBack,
  onChanged,
  onMore,
  onFinished,
  onSettled,
  onSendOut,
}: {
  status: VaultStatus;
  venue: Venue;
  phase: ReturnPhase;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onMore: () => void;
  onFinished: () => Promise<void>;
  onSettled: (lines: { shielded: TokenLine[]; left: TokenLine[] }) => void;
  /** After it is shielded again: finish, then send it out to another chain through NEAR Intents. */
  onSendOut?: () => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remembered, setRemembered] = useState(linesOf(status, venue));
  const name = VENUES[venue].name;
  const lighter = venue === 'lighter';
  const session = status.activeTrade?.session;
  const wallet = appView(venue, status.activeTrade);

  useEffect(() => {
    const next = linesOf(status, venue);
    if (next.shielded.length > 0 || next.left.length > 0) setRemembered(next);
  }, [status, venue]);

  useEffect(() => {
    if (phase !== 'moving' || !lighter) return;
    let alive = true;
    const tick = () => {
      void send({ kind: 'advanceTrade' }, SLOW_TIMEOUT_MS)
        .catch(() => undefined)
        .finally(() => {
          if (alive) void onChanged();
        });
    };
    tick();
    const id = setInterval(tick, 4_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [phase, lighter, onChanged]);

  // A Hyperliquid withdrawal waits minutes for Arbitrum. If the worker that was
  // waiting is gone, ask again: it continues the saved, signed withdrawal.
  const resuming = useRef(false);
  useEffect(() => {
    if (phase !== 'moving' || lighter) return;
    const tick = () => {
      const nearApp = isAppVenue(venue) && APP_VENUES[venue].chain === 'near';
      if ((venue === 'hyperliquid' || nearApp) && !working && !resuming.current) {
        resuming.current = true;
        void send(nearApp ? { kind: 'shieldApp', venue } : { kind: 'shieldHyperliquid' }, SLOW_TIMEOUT_MS)
          .catch(() => undefined)
          .finally(() => {
            resuming.current = false;
          });
      }
      void onChanged();
    };
    const id = setInterval(tick, 4_000);
    return () => clearInterval(id);
  }, [phase, lighter, venue, working, onChanged]);

  const bring = async () => {
    setWorking(true);
    setError(null);
    try {
      let outcome: unknown;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          if (lighter && session?.state === 'withdraw-failed') outcome = await send({ kind: 'retryLighterExit' }, SLOW_TIMEOUT_MS);
          else if (lighter) outcome = await send({ kind: 'shieldFunds' }, SLOW_TIMEOUT_MS);
          else if (venue === 'uniswap') outcome = await send({ kind: 'shieldUniswap' }, SLOW_TIMEOUT_MS);
          else if (venue === 'hyperliquid') outcome = await send({ kind: 'shieldHyperliquid' }, SLOW_TIMEOUT_MS);
          else if (isAppVenue(venue)) outcome = await send({ kind: 'shieldApp', venue }, SLOW_TIMEOUT_MS);
          else outcome = await send({ kind: 'shieldCompound' }, SLOW_TIMEOUT_MS);
          break;
        } catch (e) {
          const latest = await send({ kind: 'status' }).catch(() => null);
          const next = returnPhase(latest);
          if (next && next.phase !== 'confirm') break;
          const walletView = appView(venue, latest?.openVenues?.[venue] ?? latest?.activeTrade);
          if (walletView?.status === 'done') {
            outcome = walletView;
            break;
          }
          // A finished shield retires the trade, so the record is gone.
          if (!latest?.activeTrade && attempt > 0) {
            onSettled(remembered);
            break;
          }
          const still = walletView?.status === 'shielding' || latest?.activeTrade?.session?.state === 'withdrawing' || latest?.activeTrade?.session?.state === 'exited' || latest?.activeTrade?.session?.state === 'reshielding';
          if (!still || attempt === 7) throw e;
        }
      }
      await onChanged();
      // Hyperliquid: part came back and part is still there. Say so on this screen.
      if (venue === 'hyperliquid' && outcome && typeof outcome === 'object' && (outcome as { status?: string }).status === 'funded') {
        setError((outcome as { detail?: string }).detail ?? null);
      }
      if (outcome && typeof outcome === 'object' && 'status' in outcome && (outcome as { status?: string }).status === 'done') {
        const view = outcome as { shielded?: TokenLine[]; left?: TokenLine[] };
        const lines = { shielded: view.shielded ?? [], left: view.left ?? [] };
        setRemembered(lines);
        onSettled(lines);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await onChanged().catch(() => undefined);
    } finally {
      setWorking(false);
    }
  };

  const top = (
    <div className="gx-top">
      <GxBrand />
      <SiteChip venue={venue} />
    </div>
  );

  if (phase === 'done') {
    return (
      <GxScreen>
        {top}
        <div className="gx-hero">
          <span className="gx-done">
            <Mascot size={96} className="gx-mascot" />
            <i><Icon d="m5 12 5 5 9-10" size={16} /></i>
          </span>
          <h1 className="gx-title">Back in your private balance</h1>
          <p className="gx-sub">
            {remembered.shielded.length > 0
              ? `${remembered.shielded.map(amountLabel).join(', ')} shielded. This address is not reused.`
              : `What ${name} was holding is shielded again. This address is not reused.`}
          </p>
        </div>
        {remembered.left.length > 0 && (
          <div className="gx-card gx-facts">
            {remembered.left.map((row) => (
              <div key={row.token}>
                <span>Left on the address</span>
                <span>{amountLabel(row)}{row.reason ? ` · ${row.reason}` : ''}</span>
              </div>
            ))}
          </div>
        )}
        {error && <p className="gx-error">{error}</p>}
        <button
          type="button"
          className="gx-btn primary"
          disabled={working}
          onClick={() => {
            setWorking(true);
            void onFinished()
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setWorking(false));
          }}
        >
          {working ? 'Finishing…' : 'Done'}
        </button>
        {onSendOut && (
          <button
            type="button"
            className="gx-btn quiet"
            disabled={working}
            onClick={() => {
              setWorking(true);
              void onSendOut()
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setWorking(false));
            }}
          >
            Send out to another chain
          </button>
        )}
      </GxScreen>
    );
  }

  if (phase === 'moving') {
    const state = session?.state;
    const hlStep = status.activeTrade?.hyperliquid?.step;
    const steps: { label: string; state: 'done' | 'now' | 'todo' }[] = lighter
      ? [
          { label: `Taking USDC off ${name}`, state: state === 'withdrawing' ? 'now' : 'done' },
          {
            label: state === 'exited' ? 'Waiting for the USDC on Arbitrum' : 'Shielding into your private balance',
            state: state === 'withdrawing' ? 'todo' : 'now',
          },
        ]
      : venue === 'hyperliquid'
        ? [
            { label: `Withdrawing USDC from ${name}`, state: hlStep === 'withdrawing' ? 'now' : 'done' },
            { label: 'Waiting for it on Arbitrum', state: hlStep === 'withdrawing' ? 'todo' : hlStep === 'arriving' ? 'now' : 'done' },
            { label: 'Shielding into your private balance', state: hlStep === 'shielding' ? 'now' : 'todo' },
          ]
        : [
            { label: `Reading what ${name} left`, state: 'now' },
            { label: 'Shielding into your private balance', state: 'todo' },
          ];
    return (
      <GxScreen>
        {top}
        <div className="gx-hero">
          <div className="gx-link-row">
            <img className="gx-app" src={venueLogo(venue)} alt="" />
            <svg aria-hidden="true" width="64" height="10" viewBox="0 0 64 10" fill="none">
              <path className="gx-dash" d="M2 5h60" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <Mascot size={58} className="gx-mascot" />
          </div>
          <h1 className="gx-title">Bringing it back…</h1>
        </div>
        <ol className="gx-steps">
          {steps.map((step) => (
            <li key={step.label} className={step.state}>
              <i>{step.state === 'done' && <Icon d="m5 12 5 5 9-10" size={11} />}</i>
              {step.label}
            </li>
          ))}
        </ol>
        <p className="gx-note">{session?.detail ?? wallet?.detail ?? 'About a minute. You can close this.'}</p>
      </GxScreen>
    );
  }

  if (phase === 'failed') {
    const closed = session?.state === 'closed';
    const detail = plain(error ?? session?.detail ?? wallet?.error ?? wallet?.detail);
    return (
      <GxScreen>
        {top}
        <div className="gx-hero">
          <div className="gx-link-row">
            <img className="gx-app" src={venueLogo(venue)} alt="" />
            <svg aria-hidden="true" width="64" height="10" viewBox="0 0 64 10" fill="none">
              <path d="M2 5h60" stroke="var(--gx-danger)" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <Mascot size={58} />
          </div>
          <h1 className="gx-title">That didn’t come back</h1>
        </div>
        <p className="gx-note bad">{detail}</p>
        {!closed && (
          <button type="button" className="gx-btn primary" disabled={working} onClick={() => void bring()}>
            {working ? 'Trying again…' : 'Try again'}
          </button>
        )}
        {closed && (
          <button type="button" className="gx-btn primary" onClick={() => void chrome.tabs.create({ url: VENUES[venue].url })}>
            Open {name}
          </button>
        )}
        <button type="button" className="gx-btn quiet" onClick={onMore}>
          More options
        </button>
      </GxScreen>
    );
  }

  const blurb = lighter
    ? `Close the position on ${name} first. This withdraws the USDC and shields it back. An open position stays where it is.`
    : venue === 'compound'
      ? `Withdraw on ${name} first. This will not shield while a supply, borrow, or reward is still open.`
      : isAppVenue(venue)
        ? APP_VENUES[venue].returnBlurb
      : venue === 'hyperliquid'
        ? `Close your positions and cancel open orders on ${name} first. This withdraws the USDC to Arbitrum (${name} keeps a 1 USDC fee) and shields it back.`
        : `When you finish on ${name}, this reads the address and shields USDC, WETH, USDT, DAI, and ARB. Anything else stays there, and gets named.`;

  return (
    <GxScreen>
      <div className="gx-top">
        <GxBack onClick={onBack} label={`Back from ${name}`} disabled={working} />
      </div>
      <div className="gx-hero">
        <div className="gx-link-row">
          <img className="gx-app" src={venueLogo(venue)} alt="" />
          <svg aria-hidden="true" width="64" height="10" viewBox="0 0 64 10" fill="none">
            <path className="gx-dash" d="M2 5h60" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <Mascot size={58} className="gx-mascot" />
        </div>
        <h1 className="gx-title">Bring it back</h1>
        <p className="gx-sub">{blurb}</p>
      </div>
      <div className="gx-card gx-facts">
        <div>
          <span>{name} sees</span>
          <span>The same private account</span>
        </div>
        <div>
          <span>You do there</span>
          <span>{isAppVenue(venue) ? APP_VENUES[venue].doThere : lighter || venue === 'hyperliquid' ? 'Close the position' : venue === 'compound' ? 'Withdraw the supply' : 'Finish the swap'}</span>
        </div>
        <div>
          <span>Then Ghosty</span>
          <span>Shields what’s left</span>
        </div>
      </div>
      {error && <p className="gx-error">{plain(error)}</p>}
      <button type="button" className="gx-btn primary" disabled={working} onClick={() => void bring()}>
        {working ? 'Bringing back…' : 'Bring funds back'}
      </button>
      <button type="button" className="gx-btn quiet" disabled={working} onClick={() => void chrome.tabs.create({ url: VENUES[venue].url })}>
        Open {name}
      </button>
    </GxScreen>
  );
}

export function GhostMore({
  status,
  busy,
  onBack,
  onChanged,
}: {
  status: VaultStatus;
  busy: boolean;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ index: number; address: string; balance: string }[] | null>(null);
  const disabled = busy || working !== null;
  const venue = status.activeTrade?.venue;

  const run = async (label: string, action: () => Promise<void>) => {
    setWorking(label);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  };

  return (
    <GxScreen>
      <div className="gx-top">
        <GxBack onClick={onBack} label="More options" disabled={disabled} />
      </div>
      <p className="gx-sub">These don’t move funds unless you abandon an address that still holds some.</p>
      {(status.activeTrade?.session?.error?.message ?? status.activeTrade?.session?.detail ?? status.activeTrade?.uniswap?.error ?? status.activeTrade?.compound?.error ?? status.activeTrade?.hyperliquid?.error ?? status.activeTrade?.app?.error) && (
        <p className="gx-note">
          {status.activeTrade?.session?.error?.message
            ?? status.activeTrade?.uniswap?.error
            ?? status.activeTrade?.compound?.error
            ?? status.activeTrade?.hyperliquid?.error
            ?? status.activeTrade?.app?.error
            ?? status.activeTrade?.session?.detail}
        </p>
      )}
      {status.activeTrade && (
        <button
          type="button"
          className="gx-option"
          disabled={disabled}
          onClick={() => void run('end', () => send({ kind: 'endTrade', venue: dappVenue(status.activeTrade?.venue) }).then(() => undefined))}
        >
          <b>{working === 'end' ? 'Ending…' : 'End this account'}</b>
          <span>Retire it once the funds are back. The address is not reused.</span>
        </button>
      )}
      {status.activeTrade && (
        <button
          type="button"
          className="gx-option danger"
          disabled={disabled}
          onClick={() => {
            const abandon = window.confirm(
              venue === 'dydx'
                ? 'Abandon this address? It is burned and will not be reused. USDC still on dYdX stays there, and the old-address scan does not read dYdX. Withdraw to Arbitrum first.'
                : venue === 'hyperliquid'
                ? 'Abandon this address? It is burned and will not be reused. USDC still on Hyperliquid stays there until you scan old addresses for it.'
                : venue === 'uniswap' || venue === 'compound'
                ? 'Abandon this address? It is burned and will not be reused. Tokens still on it stay there. Bring funds back first if they should return.'
                : 'Abandon this account? Its address is burned and will not be reused. Funds still on Lighter or at that address stay there until you scan for them.',
            );
            if (!abandon) return;
            void run('abandon', () => send({ kind: 'abandonTrade', venue: dappVenue(status.activeTrade?.venue) }).then(() => undefined));
          }}
        >
          <b>{working === 'abandon' ? 'Abandoning…' : 'Abandon this address'}</b>
          <span>Burns it. Anything still there stays there.</span>
        </button>
      )}
      <button
        type="button"
        className="gx-option"
        disabled={disabled}
        onClick={() =>
          void run('scan', async () => {
            setFound(await send({ kind: 'scanStranded' }, SLOW_TIMEOUT_MS));
          })
        }
      >
        <b>{working === 'scan' ? 'Scanning…' : 'Scan old addresses'}</b>
        <span>Looks for USDC left on addresses this wallet already retired.</span>
      </button>
      {found && (
        <div className="gx-card gx-facts">
          {found.length === 0 ? (
            <div>
              <span>Old addresses</span>
              <span>Nothing left</span>
            </div>
          ) : (
            found.map((row) => (
              <div key={row.index}>
                <span>#{row.index}</span>
                <span>{(Number(row.balance) / 1e6).toFixed(2)} USDC</span>
              </div>
            ))
          )}
        </div>
      )}
      <button type="button" className="gx-option" disabled={disabled} onClick={() => void run('lock', () => send({ kind: 'lock' }).then(() => undefined))}>
        <b>{working === 'lock' ? 'Locking…' : 'Lock Ghosty'}</b>
        <span>Asks for the password next time this opens.</span>
      </button>
      {error && <p className="gx-error">{error}</p>}
    </GxScreen>
  );
}
