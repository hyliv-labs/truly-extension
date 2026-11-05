/**
 * E9 shell, wired to E1 only: create or unlock a vault and show the owner
 * address. Balance, New trade and progress land with E3/E8.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  send,
  type AnonRpcStatus,
  type SelfTestResult,
  type VaultStatus,
} from '@truly/lib/messages';

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [backup, setBackup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [anon, setAnon] = useState<AnonRpcStatus | null>(null);
  const [selfTest, setSelfTest] = useState<SelfTestResult | null>(null);

  const refresh = useCallback(async () => {
    const next = await send({ kind: 'status' });
    setStatus(next);
    setAnon(await send({ kind: 'anonRpcStatus' }));
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
          <p>Loading…</p>
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

          <button className="secondary" disabled={busy} onClick={() => run(async () => {
            setBackup(null);
            await send({ kind: 'lock' });
          })}>
            Lock
          </button>
        </section>
      ) : (
        <section className="panel">
          <label className="field-label" htmlFor="password">
            {status.hasVault ? 'Password' : 'Choose a password'}
          </label>
          <input
            id="password"
            type="password"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !password) return;
              void run(async () => {
                if (status.hasVault) {
                  await send({ kind: 'unlock', password });
                } else {
                  setBackup((await send({ kind: 'createVault', password })).mnemonic);
                }
              });
            }}
          />
          <button
            disabled={busy || !password}
            onClick={() =>
              run(async () => {
                if (status.hasVault) {
                  await send({ kind: 'unlock', password });
                } else {
                  setBackup((await send({ kind: 'createVault', password })).mnemonic);
                }
              })
            }
          >
            {status.hasVault ? 'Unlock' : 'Create vault'}
          </button>
        </section>
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
                setSelfTest(await send({ kind: 'anonRpcSelfTest' }));
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
