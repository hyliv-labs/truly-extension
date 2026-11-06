/**
 * E9 shell, wired to E1 only: create or unlock a vault and show the owner
 * address. Balance, New trade and progress land with E3/E8.
 */

import { useCallback, useEffect, useState } from 'react';
import { Onboarding } from './Onboarding';
import {
  send,
  type AnonRpcStatus,
  type SelfTestResult,
  type VaultStatus,
  SLOW_TIMEOUT_MS,
} from '@truly/lib/messages';

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [backup, setBackup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [anon, setAnon] = useState<AnonRpcStatus | null>(null);
  const [phase, setPhase] = useState<{ phase: string; detail: string } | null>(null);
  const [unshield, setUnshield] = useState<string | null>(null);
  const [pool, setPool] = useState<{
    totalUnits: string;
    noteCount: number;
    largestUnits: string;
  } | null>(null);
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

  useEffect(() => {
    void refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

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
        <p className="tagline">One trade, one address.</p>
      </header>

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
          <label className="field-label">Owner address #{status.ownerIndex}</label>
          <code className="address">{owner ?? '…'}</code>

          {backup && (
            <div className="backup">
              <strong>Write this down now.</strong>
              <code>{backup}</code>
              <p>It is the only way to recover funds from a trade in flight.</p>
            </div>
          )}

          <p className="field-label">
            {status.activeTrade
              ? 'Trade active — Lighter can connect to this address.'
              : 'No active trade. Lighter cannot connect.'}
          </p>

          {phase && (
            <div className="phase">
              <strong>{phase.phase.replace(/-/g, ' ')}</strong>
              <p>{phase.detail}</p>
            </div>
          )}

          {status.activeTrade && (
            <>
              {status.activeTrade.intentAddress ? (
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
                (status.activeTrade.withdrawal?.status === 'confirmed' ? (
                  <p className="field-label">
                    Funded from the pool —{' '}
                    {(Number(status.activeTrade.withdrawal.amount) / 1e6).toFixed(2)} USDC
                    withdrawn.
                  </p>
                ) : status.activeTrade.withdrawal?.status === 'pending' ? (
                  // In flight. Offering the button here is what would send a
                  // second payment to the same intent address.
                  <p className="field-label">
                    Funding withdrawal in progress
                    {status.activeTrade.withdrawal.txHash
                      ? ' — waiting for it to confirm.'
                      : ' — its outcome is being checked against the chain.'}
                  </p>
                ) : (
                  <>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const result = await send({ kind: 'unshield' }, SLOW_TIMEOUT_MS);
                          setUnshield(
                            `Sent ${(Number(result.amountUnits) / 1e6).toFixed(2)} USDC; ` +
                              `Lighter should see ~${(
                                Number(result.expectedNetUnits) / 1e6
                              ).toFixed(2)} after a ${result.feeBPS} BPS relayer fee.`,
                          );
                        })
                      }
                    >
                      Fund this trade from Privacy Pools
                    </button>
                    <p className="field-label">
                      Builds a zero-knowledge proof and relays the withdrawal. This takes
                      a minute and must not be interrupted.
                    </p>
                  </>
                ))}

              {unshield && <p className="field-label">{unshield}</p>}

              {status.activeTrade.deposit && (
                <p className="field-label">
                  {status.activeTrade.deposit.description} (
                  {status.activeTrade.deposit.status})
                </p>
              )}

              {status.activeTrade.accountIndex !== undefined && (
                <p className="field-label">
                  Lighter account #{status.activeTrade.accountIndex}
                </p>
              )}
            </>
          )}

          {/* TODO(E8): the orchestrator starts a trade only once the account
              is funded. Until then these are manual, for exercising E5. */}
          {status.activeTrade ? (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => run(() => send({ kind: 'endTrade' }).then(() => {}))}
            >
              End trade
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() => run(() => send({ kind: 'startTrade' }).then(() => {}))}
            >
              Start trade
            </button>
          )}

          {/* A full pool scan, so it is asked for rather than polled. Shown
              before starting a trade, since a trade that cannot be funded
              should fail here rather than after an owner is burned. */}
          <button
            className="link"
            disabled={busy}
            onClick={() => run(async () => setPool(await send({ kind: 'poolBalance' }, SLOW_TIMEOUT_MS)))}
          >
            Check pool balance
          </button>

          {pool && (
            <div className="phase">
              <strong>{(Number(pool.totalUnits) / 1e6).toFixed(2)} USDC in the pool</strong>
              <p>
                {pool.noteCount === 0
                  ? 'No spendable notes. A new deposit must clear ASP screening before it can be spent, which is published in batches.'
                  : `${pool.noteCount} note${pool.noteCount === 1 ? '' : 's'}; largest ${(
                      Number(pool.largestUnits) / 1e6
                    ).toFixed(2)} USDC, which bounds a single trade.`}
              </p>
            </div>
          )}

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
