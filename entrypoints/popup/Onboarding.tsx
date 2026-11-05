/**
 * Choosing how the vault is created.
 *
 * The three options are genuinely different accounts, not three ways in to one
 * — picking the wrong one finds no notes and looks like "you have no funds"
 * rather than an error. That is why the choice is explicit rather than
 * auto-detected.
 */

import { useEffect, useState } from 'react';
import { send } from '@truly/lib/messages';
import type { RecoveryState } from '@truly/lib/recovery';

type Mode = 'choose' | 'new' | 'phrase' | 'wallet' | 'paste';
type Version = 'v1' | 'v2';

export function Onboarding({
  busy,
  run,
  onBackup,
}: {
  busy: boolean;
  run: (action: () => Promise<void>) => void;
  onBackup: (mnemonic: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('choose');
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [address, setAddress] = useState('');
  const [signature, setSignature] = useState('');
  const [version, setVersion] = useState<Version>('v2');
  const [typedData, setTypedData] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState>({ phase: 'idle' });

  // The job lives in the background, so a reopened popup rejoins it rather
  // than starting a second one.
  useEffect(() => {
    if (mode !== 'wallet') return;
    let stop = false;
    const poll = async () => {
      while (!stop) {
        const state = await send({ kind: 'metamaskRecoverStatus' });
        if (stop) return;
        setRecovery(state);
        if (state.phase !== 'waiting') return;
        await new Promise((r) => setTimeout(r, 700));
      }
    };
    void poll().catch(() => {});
    return () => {
      stop = true;
    };
  }, [mode]);

  if (mode === 'choose') {
    return (
      <section className="panel">
        <p className="field-label">How do you want to set up Truly?</p>

        <button disabled={busy} onClick={() => setMode('new')}>
          Create a new vault
        </button>

        <button className="secondary" disabled={busy} onClick={() => setMode('wallet')}>
          Recover with MetaMask
        </button>
        <p className="hint">
          For a Privacy Pools account you made by connecting a wallet. MetaMask
          asks you to sign once; no phrase needed.
        </p>

        <button className="secondary" disabled={busy} onClick={() => setMode('phrase')}>
          Enter a recovery phrase
        </button>
        <p className="hint">
          For an account whose 12 or 24 word phrase you wrote down.
        </p>

        <button className="link" disabled={busy} onClick={() => setMode('paste')}>
          MetaMask not working? Sign elsewhere and paste →
        </button>
      </section>
    );
  }

  const back = (
    <button className="link" disabled={busy} onClick={() => setMode('choose')}>
      ← back
    </button>
  );

  const passwordField = (
    <>
      <label className="field-label" htmlFor="pw">
        Password to encrypt this vault on your device
      </label>
      <input
        id="pw"
        type="password"
        value={password}
        disabled={busy}
        onChange={(e) => setPassword(e.target.value)}
      />
    </>
  );

  if (mode === 'new') {
    return (
      <section className="panel">
        {back}
        {passwordField}
        <button
          disabled={busy || !password}
          onClick={() =>
            run(async () => {
              const { mnemonic } = await send({ kind: 'createVault', password });
              onBackup(mnemonic);
            })
          }
        >
          Create vault
        </button>
      </section>
    );
  }

  if (mode === 'phrase') {
    return (
      <section className="panel">
        {back}
        <label className="field-label" htmlFor="phrase">
          Recovery phrase (12 or 24 words)
        </label>
        <textarea
          id="phrase"
          rows={3}
          value={phrase}
          disabled={busy}
          spellCheck={false}
          onChange={(e) => setPhrase(e.target.value)}
        />
        {passwordField}
        <button
          disabled={busy || !password || !phrase.trim()}
          onClick={() =>
            run(async () => {
              await send({
                kind: 'createVault',
                password,
                // Whitespace and newlines are normal when pasting from a
                // written-down phrase.
                mnemonic: phrase.replace(/[\r\n,]+/g, ' ').replace(/\s+/g, ' ').trim(),
              });
            })
          }
        >
          Restore vault
        </button>
      </section>
    );
  }

  if (mode === 'wallet') {
    return (
      <section className="panel">
        {back}

        <label className="field-label">Account version</label>
        <div className="actions">
          <button
            className={version === 'v2' ? '' : 'secondary'}
            disabled={busy || recovery.phase === 'waiting'}
            onClick={() => setVersion('v2')}
          >
            v2 (24 words)
          </button>
          <button
            className={version === 'v1' ? '' : 'secondary'}
            disabled={busy || recovery.phase === 'waiting'}
            onClick={() => setVersion('v1')}
          >
            v1 (12 words)
          </button>
        </div>
        <p className="hint">
          If one finds no funds, try the other — they are different accounts and
          guessing wrong is harmless.
        </p>

        {passwordField}

        {recovery.phase === 'waiting' ? (
          <>
            <p className="field-label">
              Waiting for MetaMask — approve the connection, then sign.
            </p>
            <p className="hint">
              You can close this popup; recovery keeps running.
            </p>
          </>
        ) : recovery.phase === 'done' ? (
          <p className="field-label">Recovered {recovery.address}</p>
        ) : (
          <button
            disabled={busy || !password}
            onClick={() =>
              run(async () => {
                await send({ kind: 'metamaskRecoverClear' });
                await send({ kind: 'metamaskRecoverStart', password, version });
              })
            }
          >
            Connect MetaMask and sign
          </button>
        )}

        {recovery.phase === 'error' && (
          <>
            {/* Never auto-falls back to another wallet or a new vault: the
                user is told, and chooses. */}
            <p className="error">{recovery.message}</p>
            <button className="link" disabled={busy} onClick={() => setMode('paste')}>
              Sign elsewhere and paste instead →
            </button>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="panel">
      {back}
      <p className="hint">
        Fallback: sign the message below with your wallet however you like, then
        paste the signature.
      </p>
      <label className="field-label" htmlFor="addr">
        The wallet address you used on privacypools.com
      </label>
      <input
        id="addr"
        value={address}
        disabled={busy}
        placeholder="0x…"
        spellCheck={false}
        onChange={(e) => setAddress(e.target.value.trim())}
      />

      <label className="field-label">Account version</label>
      <div className="actions">
        <button
          className={version === 'v2' ? '' : 'secondary'}
          disabled={busy}
          onClick={() => setVersion('v2')}
        >
          v2 (24 words)
        </button>
        <button
          className={version === 'v1' ? '' : 'secondary'}
          disabled={busy}
          onClick={() => setVersion('v1')}
        >
          v1 (12 words)
        </button>
      </div>
      <p className="hint">
        If one finds no funds, try the other — they are different accounts and
        guessing wrong is harmless.
      </p>

      <button
        className="secondary"
        disabled={busy || !address}
        onClick={() =>
          run(async () => {
            const { json } = await send({
              kind: 'seedTypedData',
              address,
              version,
            });
            setTypedData(json);
            await navigator.clipboard.writeText(json).catch(() => {});
          })
        }
      >
        Copy the message to sign
      </button>

      {typedData && (
        <>
          <p className="hint">
            Sign this exact EIP-712 message with that wallet, then paste the
            signature below. It must match what your wallet shows.
          </p>
          <pre className="message">{typedData}</pre>
        </>
      )}

      <label className="field-label" htmlFor="sig">
        Signature
      </label>
      <input
        id="sig"
        value={signature}
        disabled={busy}
        placeholder="0x… (65 bytes)"
        spellCheck={false}
        onChange={(e) => setSignature(e.target.value.trim())}
      />

      {passwordField}

      <button
        disabled={busy || !password || !address || !signature}
        onClick={() =>
          run(async () => {
            await send({
              kind: 'importWalletSeed',
              password,
              address,
              version,
              signature,
            });
          })
        }
      >
        Recover account
      </button>
    </section>
  );
}
