/**
 * First run: Welcome, then Create (password, then the phrase screen in App)
 * or Restore (phrase and a new password). The MetaMask and paste recoveries
 * are for Privacy Pools accounts and live under "Other ways to restore".
 *
 * The recovery paths are genuinely different accounts, not three ways in to
 * one, so the choice stays explicit rather than auto-detected.
 */

import { useEffect, useState } from 'react';
import { send } from '@truly/lib/messages';
import type { RecoveryState } from '@truly/lib/recovery';
import { Mascot } from './Mascot';
import { GxBack, GxBrand, GxDots, GxScreen, PasswordField, Strength, passwordStrength } from './Ghosty';

type Mode = 'welcome' | 'create' | 'restore' | 'other' | 'wallet' | 'paste';
type Version = 'v1' | 'v2';

export function Onboarding({
  busy,
  run,
  onBackup,
  error,
}: {
  busy: boolean;
  run: (action: () => Promise<void>) => void;
  onBackup: (mnemonic: string) => void;
  error?: string | null;
}) {
  const [mode, setMode] = useState<Mode>('welcome');
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

  const go = (next: Mode) => {
    setPassword('');
    setMode(next);
  };
  const errorLine = error ? <p className="gx-error">{error}</p> : null;

  if (mode === 'welcome') {
    return (
      <GxScreen>
        <div className="gx-top">
          <GxBrand />
        </div>
        <div className="gx-hero">
          <Mascot size={104} className="gx-mascot" />
          <h1 className="gx-title display">Go ghost on any app.</h1>
          <p className="gx-sub">Privacy where you already trade, swap and lend.</p>
        </div>
        <button type="button" className="gx-btn primary" disabled={busy} onClick={() => go('create')}>
          Create Ghosty
        </button>
        <button type="button" className="gx-btn quiet" disabled={busy} onClick={() => go('restore')}>
          I already have Ghosty
        </button>
      </GxScreen>
    );
  }

  const createVault = () => {
    if (busy || passwordStrength(password) < 1) return;
    run(async () => {
      const { mnemonic } = await send({ kind: 'createVault', password });
      onBackup(mnemonic);
    });
  };

  if (mode === 'create') {
    return (
      <GxScreen>
        <div className="gx-top">
          <GxBack onClick={() => go('welcome')} disabled={busy} />
          <GxDots total={2} at={1} />
        </div>
        <h1 className="gx-title">Set a password</h1>
        <p className="gx-sub">Unlocks Ghosty on this browser.</p>
        <PasswordField label="New password" value={password} onChange={setPassword} onEnter={createVault} disabled={busy} autoFocus />
        <Strength password={password} />
        <div className="gx-spacer" />
        {errorLine}
        <button type="button" className="gx-btn primary" disabled={busy || passwordStrength(password) < 1} onClick={createVault}>
          {busy ? 'Creating…' : 'Continue'}
        </button>
      </GxScreen>
    );
  }

  const restore = () => {
    if (busy || !phrase.trim() || passwordStrength(password) < 1) return;
    run(async () => {
      await send({
        kind: 'createVault',
        password,
        // Whitespace and newlines are normal when pasting from a
        // written-down phrase.
        mnemonic: phrase.replace(/[\r\n,]+/g, ' ').replace(/\s+/g, ' ').trim(),
      });
    });
  };

  if (mode === 'restore') {
    return (
      <GxScreen>
        <div className="gx-top">
          <GxBack onClick={() => go('welcome')} disabled={busy} />
        </div>
        <h1 className="gx-title">Restore Ghosty</h1>
        <textarea
          className="gx-textarea"
          aria-label="Recovery phrase"
          placeholder="Paste your 12 or 24 words"
          value={phrase}
          disabled={busy}
          spellCheck={false}
          autoFocus
          onChange={(e) => setPhrase(e.target.value)}
        />
        <PasswordField label="New password" placeholder="New password" value={password} onChange={setPassword} onEnter={restore} disabled={busy} />
        <div className="gx-spacer" />
        {errorLine}
        <button type="button" className="gx-btn primary" disabled={busy || !phrase.trim() || passwordStrength(password) < 1} onClick={restore}>
          {busy ? 'Restoring…' : 'Restore'}
        </button>
        <button type="button" className="gx-btn quiet" disabled={busy} onClick={() => go('other')}>
          Other ways to restore
        </button>
      </GxScreen>
    );
  }

  if (mode === 'other') {
    return (
      <GxScreen>
        <div className="gx-top">
          <GxBack onClick={() => go('restore')} disabled={busy} />
        </div>
        <h1 className="gx-title">Other ways to restore</h1>
        <p className="gx-sub">For a Privacy Pools account made with a wallet.</p>
        <button type="button" className="gx-option" onClick={() => go('wallet')}>
          <b>Sign with MetaMask</b>
          <span>MetaMask asks you to sign once.</span>
        </button>
        <button type="button" className="gx-option" onClick={() => go('paste')}>
          <b>Sign elsewhere and paste</b>
          <span>For any wallet, or if MetaMask isn&apos;t working.</span>
        </button>
      </GxScreen>
    );
  }

  const back = <GxBack onClick={() => go('other')} disabled={busy} />;

  const passwordField = (
    <PasswordField label="New password" placeholder="New password for Ghosty" value={password} onChange={setPassword} disabled={busy} />
  );

  if (mode === 'wallet') {
    return (
      <section className="gx gx-legacy">
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
    <section className="gx gx-legacy">
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
