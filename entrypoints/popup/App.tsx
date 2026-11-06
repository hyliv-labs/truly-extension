/**
 * Popup. The trade is driven from here: fund from the pool, then re-shield
 * whatever comes back. Lighter itself is where the position is opened and closed.
 */

import { useCallback, useEffect, useState } from 'react';
import { LockScreen } from './LockScreen';
import { Logo } from './Mascot';
import { Onboarding } from './Onboarding';
import { SessionPanel, TradeForm } from './TradePanel';
import {
  send,
  type AnonRpcStatus,
  type SelfTestResult,
  type VaultStatus,
  SLOW_TIMEOUT_MS,
} from '@truly/lib/messages';
import type { RailgunSyncStatus } from '@truly/lib/railgun-sync-status';
import type { ShieldedBalance } from '@truly/lib/shielded-balance';

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [backup, setBackup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [anon, setAnon] = useState<AnonRpcStatus | null>(null);
  const [phase, setPhase] = useState<{ phase: string; detail: string } | null>(null);
  /**
   * Set when the provider opened this window because a dapp is waiting on
   * eth_requestAccounts. The request stays open until a trade starts.
   * Closing the window rejects it.
   */
  const [connectOrigin] = useState<string | null>(() => {
    const raw = new URLSearchParams(window.location.search).get('connect');
    if (!raw) return null;
    try {
      return new URL(raw).host;
    } catch {
      return 'A site';
    }
  });
  const [connectFullOrigin] = useState<string | null>(() => {
    const raw = new URLSearchParams(window.location.search).get('connect');
    if (!raw) return null;
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  });
  const [connected, setConnected] = useState(false);
  const [shielded, setShielded] = useState<ShieldedBalance | null>(null);
  const [shieldedError, setShieldedError] = useState<string | null>(null);
  const [shieldedLoading, setShieldedLoading] = useState(false);
  const [sync, setSync] = useState<RailgunSyncStatus | null>(null);
  const [stranded, setStranded] = useState<
    { index: number; address: string; balance: string }[] | null
  >(null);
  const [selfTest, setSelfTest] = useState<SelfTestResult | null>(null);

  const refresh = useCallback(async () => {
    const next = await send({ kind: 'status' });
    setStatus(next);
    setAnon(await send({ kind: 'anonRpcStatus' }));
    // Derived from Lighter and the chain, so it survives a restart mid-trade.
    setPhase(next.activeTrade ? await send({ kind: 'tradeStatus' }, SLOW_TIMEOUT_MS) : null);
    if (next.unlocked) {
      setOwner((await send({ kind: 'currentOwner' })).address);
    } else {
      setOwner(null);
    }
  }, []);

  const loadBalance = useCallback(async (refreshBalance = false) => {
    setShieldedLoading(true);
    setShieldedError(null);
    let refreshNow = refreshBalance;
    try {
      // A first Railgun sync outlasts one request: it takes minutes, and the
      // popup used to give up at SLOW_TIMEOUT_MS and report a failure while
      // the sync carried on fine. If the sync is still MOVING, wait on it
      // again -- joining the read already in flight, never restarting it.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          setShielded(await send({ kind: 'shieldedBalance', refresh: refreshNow }, SLOW_TIMEOUT_MS));
          return;
        } catch (e) {
          const sync = await send({ kind: 'railgunSyncStatus' }).catch(() => null);
          const moving = sync !== null && ['starting', 'syncing', 'scanning-wallet'].includes(sync.phase);
          if (!moving) throw e;
          refreshNow = false;
        }
      }
      throw new Error('The Railgun sync is still running. Leave Truly unlocked and check back.');
    } catch (e) {
      setShieldedError(e instanceof Error ? e.message : String(e));
    } finally {
      setShieldedLoading(false);
    }
  }, []);

  // While a read is in flight, show where the sync actually is. Cheap: the
  // offscreen document answers from a variable.
  useEffect(() => {
    if (!shieldedLoading) return;
    let alive = true;
    const tick = async () => {
      const next = await send({ kind: 'railgunSyncStatus' }).catch(() => null);
      if (alive && next) setSync(next);
    };
    void tick();
    const id = setInterval(() => void tick(), 2_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [shieldedLoading]);

  const refreshShielded = useCallback(() => loadBalance(true), [loadBalance]);
  // A failed trade already started a fresh read in the worker. Joining that
  // read, rather than starting a second scan, is the check.
  const rereadShielded = useCallback(() => loadBalance(false), [loadBalance]);

  useEffect(() => {
    void refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  // The side panel (and the connect window) stay open for as long as the
  // user keeps them, so state read once at open goes stale: the auto-lock
  // fires, a trade starts from Lighter's connect window. Re-read when stored
  // state changes (lock and trade state live in chrome.storage), when the
  // page is shown again, and every 15s as a backstop. One read at a time.
  useEffect(() => {
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reread = () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      void refresh()
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(reread, 1_000);
    };
    chrome.storage.onChanged.addListener(soon);
    document.addEventListener('visibilitychange', soon);
    const id = setInterval(reread, 15_000);
    return () => {
      chrome.storage.onChanged.removeListener(soon);
      document.removeEventListener('visibilitychange', soon);
      clearInterval(id);
      clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!status?.unlocked) {
      setShielded(null);
      setShieldedError(null);
      setShieldedLoading(false);
      return;
    }
    void loadBalance(false);
  }, [status?.unlocked, loadBalance]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (status?.hasVault && !status.unlocked) {
    return (
      <main className="popup popup-locked">
        <LockScreen
          busy={busy}
          error={error}
          notice={
            connectOrigin ? (
              <div className="connect-hint">
                <p>
                  <strong>{connectOrigin}</strong> wants to connect. Unlock to continue.
                </p>
              </div>
            ) : undefined
          }
          onUnlock={(pw) => run(() => send({ kind: 'unlock', password: pw }).then(() => {}))}
        />
      </main>
    );
  }

  return (
    <main className="popup">
      <header>
        <h1>
          <Logo />
        </h1>
        <p className="tagline">A new account, funded once.</p>
      </header>

      {connectOrigin && !status?.activeTrade && !connected && (
        <div className="connect-hint">
          <p>
            <strong>{connectOrigin}</strong> wants to connect.
            {status?.unlocked
              ? connectOrigin.includes('uniswap')
                ? ' Truly gives it a fresh address. Fund that address from Railgun below, then swap on Uniswap.'
                : ' Truly gives it a fresh address that has never been used. You fund it from the shielded balance when you trade, not now.'
              : ' Unlock Truly first.'}
          </p>
          {/* The button the site's "click connect in your wallet popup" refers
              to. Without it the window only offered funding, and the site sat
              waiting on a button that did not exist. */}
          {status?.unlocked && connectFullOrigin && (
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await send({ kind: 'connectToSite', origin: connectFullOrigin }, SLOW_TIMEOUT_MS);
                  setConnected(true);
                })
              }
            >
              {busy ? 'Preparing a fresh address…' : `Connect to ${connectOrigin}`}
            </button>
          )}
          <p className="field-label">
            {busy
              ? 'Checking that this address has never been used. The first check can take a minute.'
              : 'Closing this window cancels the request.'}
          </p>
        </div>
      )}

      {connectOrigin && connected && (
        <div className="connect-hint">
          <p>
            Connected to <strong>{connectOrigin}</strong>. You can close this window and
            return to the site.
          </p>
        </div>
      )}

      {status === null ? (
        <section className="placeholder">
          {/* The error belongs HERE as well as below. The only error render
              used to sit inside the loaded branch, so a background that never
              answered left the popup on 'Loading…' forever with the reason
              invisible — the failure state showed the least information. */}
          {error ? (
            <>
              <p className="error">{error}</p>
              <p className="field-label">
                The background worker did not answer. Open chrome://extensions, check
                the Truly card for errors, and click &ldquo;service worker&rdquo; to see
                its console.
              </p>
              <button onClick={() => void refresh().catch((e: Error) => setError(e.message))}>
                Retry
              </button>
            </>
          ) : (
            <p>Loading…</p>
          )}
        </section>
      ) : status.unlocked ? (
        <section className="panel">
          {/* Also shown for a CONNECTED-but-unfunded trade (active, no
              session). Connecting first starts a trade, and this used to be
              gated on there being no trade at all -- so connecting hid the
              only way to deposit. Funding attaches to that same trade, so the
              deposit lands on the address Lighter is already connected to. */}
          {(!status.activeTrade || !status.activeTrade.session) && (
            <TradeForm
              busy={busy}
              connecting={connectOrigin !== null}
              site={connectOrigin}
              activeVenue={status.activeTrade?.venue ?? null}
              connectedAddress={status.activeTrade ? owner : null}
              onOpened={refresh}
              balance={shielded}
              balanceError={shieldedError}
              balanceLoading={shieldedLoading}
              onRefreshBalance={refreshShielded}
              sync={sync}
            />
          )}

          <p className="who">
            <span className="field-label">
              {status.activeTrade?.venue === 'uniswap' ? 'Uniswap address' : 'Lighter address'} #{status.ownerIndex}
            </span>
            <code>{owner ?? '…'}</code>
          </p>
          {!status.activeTrade && (
            <p className="field-label">
              This is the next fresh address. The Railgun balance above is the shielded USDC.
            </p>
          )}

          {backup && (
            <div className="backup">
              <strong>Write this down now.</strong>
              <code>{backup}</code>
              <p>It is the only way to recover funds from a trade in flight.</p>
              <button className="secondary" disabled={busy} onClick={() => setBackup(null)}>
                I&apos;ve written it down
              </button>
            </div>
          )}

          {status.activeTrade && !status.activeTrade.session && status.activeTrade.venue !== 'uniswap' && (
            <>
              <p className="field-label">Trade active — Lighter can connect to this address.</p>
              {/* Lighter's login is Dynamic. Its six-wallet 'RECOMMENDED' list
                  is fixed; a wallet outside Dynamic's own registry is added
                  as its own connector (fetchInjectedWalletConnectors) but
                  only shown under 'View all wallets'. Without this line the
                  natural conclusion is that Truly is not supported at all. */}
              <p className="connect-steps">
                On Lighter: <strong>Connect Wallet</strong> → <strong>View all wallets</strong> →{' '}
                <strong>Truly</strong>. It is not in the recommended list.
              </p>
            </>
          )}

          {/* A market-trade session reports its own progress; the exit phases
              (withdraw from Lighter, re-shield) apply again once it is closed. */}
          {phase && status.activeTrade?.venue !== 'uniswap' && (!status.activeTrade?.session || ['closed', 'exited', 'withdraw-failed'].includes(status.activeTrade.session.state)) && (
            <div className="phase">
              <strong>{phase.phase.replace(/-/g, ' ')}</strong>
              <p>{phase.detail}</p>
            </div>
          )}

          {status.activeTrade?.session && (
            <SessionPanel
              busy={busy}
              onChanged={refresh}
              balance={shielded}
              balanceLoading={shieldedLoading}
              onRefreshBalance={rereadShielded}
            />
          )}

          {status.activeTrade && (
            <>
              {/* No separate 'Get deposit address' button here any more: the
                  Deposit form above fetches it as its first step, and two
                  actions for one job read as two different jobs. */}
              {!status.activeTrade.session && status.activeTrade.intentAddress && status.activeTrade.venue !== 'uniswap' && (
                <>
                  <label className="field-label">
                    Deposit address (the unshield sends here)
                  </label>
                  <code className="address">{status.activeTrade.intentAddress}</code>
                </>
              )}

              {/* E3: the step that funds the trade. Shown only once Lighter
                  has issued an address, because the recipient is committed to
                  inside the withdrawal proof and cannot be changed after. */}
              {status.activeTrade.intentAddress &&
                !status.activeTrade.session &&
                (status.activeTrade.withdrawal?.status === 'confirmed' ? (
                  <p className="field-label">
                    Funded from Railgun —{' '}
                    {(Number(status.activeTrade.withdrawal.amount) / 1e6).toFixed(2)} USDC
                    withdrawn.
                  </p>
                ) : status.activeTrade.withdrawal?.status === 'pending' ? (
                  <p className="field-label">
                    Funding withdrawal in progress
                    {status.activeTrade.withdrawal.txHash
                      ? ' — waiting for it to confirm.'
                      : ' — its outcome is being checked against the chain.'}
                  </p>
                ) : null)}

              {status.activeTrade.deposit && (
                <p className="field-label">
                  {status.activeTrade.deposit.description} (
                  {status.activeTrade.deposit.status})
                </p>
              )}

              {status.activeTrade.accountIndex !== undefined && !status.activeTrade.session && (
                <p className="field-label">
                  Lighter account #{status.activeTrade.accountIndex}
                </p>
              )}
            </>
          )}

          {status.activeTrade ? (
            <>
              {(status.activeTrade.venue !== 'uniswap' || !status.activeTrade.withdrawal) && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => run(() => send({ kind: 'endTrade' }).then(() => {}))}
                >
                  End trade
                </button>
              )}
              <button
                className="link danger"
                disabled={busy}
                onClick={() => {
                  const abandon = window.confirm(
                    status.activeTrade?.venue === 'uniswap'
                      ? 'Abandon this address? It is burned and will not be reused. Tokens still on it stay there. Shield back first if they should return to Railgun.'
                      : 'Abandon this trade? Its owner address is burned and will not be reused. Funds still on Lighter or at that address stay there until you scan for them.',
                  );
                  if (!abandon) return;
                  void run(() => send({ kind: 'abandonTrade' }).then(() => {}));
                }}
              >
                Abandon trade
              </button>
            </>
          ) : null}

          {/* Owner addresses are single-use and nothing watches them once
              retired, so leftover funds need somewhere to be found. */}
          <button
            className="link"
            disabled={busy}
            onClick={() => run(async () => setStranded(await send({ kind: 'scanStranded' }, SLOW_TIMEOUT_MS)))}
          >
            Scan for funds left at old addresses
          </button>

          {stranded && (
            <div className="phase">
              {stranded.length === 0 ? (
                <p>Nothing left behind.</p>
              ) : (
                stranded.map((s) => (
                  <p key={s.index}>
                    #{s.index} holds {Number(s.balance) / 1e6} USDC
                  </p>
                ))
              )}
            </div>
          )}

          <button className="secondary" disabled={busy} onClick={() => run(async () => {
            setBackup(null);
            await send({ kind: 'lock' });
          })}>
            Lock
          </button>
        </section>
      ) : status.hasVault ? null /* locked: LockScreen above */ : (
        <Onboarding busy={busy} run={run} onBackup={setBackup} />
      )}

      {error && <p className="error">{error}</p>}

      {/* The counter has to be visible in the demo video. */}
      <footer>
        <span className="anon-rpc">Anon-RPC reads: {anon?.reads ?? '—'}</span>
        {status?.unlocked && (
          <button
            className="link"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setSelfTest(await send({ kind: 'anonRpcSelfTest' }, SLOW_TIMEOUT_MS));
              })
            }
          >
            Test read
          </button>
        )}
        {selfTest && (
          <p className="field-label">
            block {selfTest.blockNumber} · {Number(selfTest.usdcBalance) / 1e6} USDC
          </p>
        )}
        {anon?.problems.map((p) => (
          <p key={p.key} className="blocked">
            {p.reason}
          </p>
        ))}
      </footer>
    </main>
  );
}
