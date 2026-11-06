/**
 * Popup. The trade is driven from here: fund from the pool, then re-shield
 * whatever comes back. Lighter itself is where the position is opened and closed.
 */

import { useCallback, useEffect, useState } from 'react';
import { Onboarding } from './Onboarding';
import { SessionPanel, TradeForm } from './TradePanel';
import {
  send,
  type AnonRpcStatus,
  type SelfTestResult,
  type VaultStatus,
  SLOW_TIMEOUT_MS,
} from '@truly/lib/messages';
import type { ShieldedBalance } from '@truly/lib/shielded-balance';

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [password, setPassword] = useState('');
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
  const [shielded, setShielded] = useState<ShieldedBalance | null>(null);
  const [shieldedError, setShieldedError] = useState<string | null>(null);
  const [shieldedLoading, setShieldedLoading] = useState(false);
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
    try {
      setShielded(await send({ kind: 'shieldedBalance', refresh: refreshBalance }, SLOW_TIMEOUT_MS));
    } catch (e) {
      setShieldedError(e instanceof Error ? e.message : String(e));
    } finally {
      setShieldedLoading(false);
    }
  }, []);

  const refreshShielded = useCallback(() => loadBalance(true), [loadBalance]);
  // A failed trade already started a fresh read in the worker. Joining that
  // read, rather than starting a second scan, is the check.
  const rereadShielded = useCallback(() => loadBalance(false), [loadBalance]);

  useEffect(() => {
    void refresh().catch((e: Error) => setError(e.message));
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
      setPassword('');
    }
  };

  return (
    <main className="popup">
      <header>
        <h1>Truly</h1>
        <p className="tagline">A new account, funded once.</p>
      </header>

      {connectOrigin && !status?.activeTrade && (
        <div className="connect-hint">
          <p>
            <strong>{connectOrigin}</strong> is waiting to connect.
            {status?.unlocked
              ? ' The shielded balance is at the top. Fund a new address from it and Truly connects that address. Closing this window cancels the request.'
              : ' Unlock Truly, then fund a new address. Closing this window cancels the request.'}
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
          {!status.activeTrade && (
            <TradeForm
              busy={busy}
              connecting={connectOrigin !== null}
              onOpened={refresh}
              balance={shielded}
              balanceError={shieldedError}
              balanceLoading={shieldedLoading}
              onRefreshBalance={refreshShielded}
            />
          )}

          <p className="who">
            <span className="field-label">Lighter address #{status.ownerIndex}</span>
            <code>{owner ?? '…'}</code>
          </p>
          {!status.activeTrade && (
            <p className="field-label">This address is what Lighter connects to. The shielded USDC is the Railgun balance above, not at this address.</p>
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

          {status.activeTrade && !status.activeTrade.session && (
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
          {phase && (!status.activeTrade?.session || ['closed', 'exited', 'withdraw-failed'].includes(status.activeTrade.session.state)) && (
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
              {status.activeTrade.session ? null : status.activeTrade.intentAddress ? (
                <>
                  <label className="field-label">
                    Deposit address (the relayer sends here)
                  </label>
                  <code className="address">{status.activeTrade.intentAddress}</code>
                </>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => run(() => send({ kind: 'prepareDeposit' }).then(() => {}))}
                >
                  Get deposit address
                </button>
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
              <button
                className="secondary"
                disabled={busy}
                onClick={() => run(() => send({ kind: 'endTrade' }).then(() => {}))}
              >
                End trade
              </button>
              <button
                className="link danger"
                disabled={busy}
                onClick={() => {
                  const abandon = window.confirm(
                    'Abandon this trade? Its owner address is burned and will not be reused. Funds still on Lighter or at that address stay there until you scan for them.',
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
      ) : status.hasVault ? (
        // An existing vault only needs unlocking. Onboarding is for choosing
        // which account a NEW vault represents, which is already settled here.
        <section className="panel">
          <label className="field-label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            disabled={busy}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !password) return;
              void run(() => send({ kind: 'unlock', password }).then(() => {}));
            }}
          />
          <button
            disabled={busy || !password}
            onClick={() => run(() => send({ kind: 'unlock', password }).then(() => {}))}
          >
            Unlock
          </button>
        </section>
      ) : (
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
