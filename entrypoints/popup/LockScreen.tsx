import { useState } from 'react';
import { Mascot } from './Mascot';
import { GxBrand, GxScreen, PasswordField } from './Ghosty';

/**
 * The locked screen: mascot, one password field, one button.
 *
 * "Forgot password" does not reset anything. The vault is encrypted with the
 * password and Ghosty refuses to create a second vault over it, so the honest
 * answer is how to get back in with the recovery phrase.
 */
export function LockScreen({
  busy,
  error,
  notice,
  onUnlock,
}: {
  busy: boolean;
  error: string | null;
  /** Shown above the mascot, e.g. a site waiting to connect. */
  notice?: React.ReactNode;
  onUnlock: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [forgot, setForgot] = useState(false);

  const submit = async () => {
    if (!password || busy) return;
    await onUnlock(password);
    setPassword('');
  };

  return (
    <GxScreen>
      <div className="gx-top">
        <GxBrand />
      </div>
      {notice}
      <div className="gx-hero">
        <Mascot size={notice ? 76 : 92} className="gx-mascot" />
        <h1 className="gx-title">Welcome back</h1>
      </div>
      <PasswordField label="Password" value={password} onChange={setPassword} onEnter={() => void submit()} disabled={busy} autoFocus />
      {error && <p className="gx-error">{error}</p>}
      {forgot && (
        <p className="gx-note">
          Ghosty can&apos;t reset it: the password only unlocks this browser. Remove and re-add the extension,
          then choose &ldquo;I already have Ghosty&rdquo; and paste your recovery phrase.
        </p>
      )}
      <button type="button" className="gx-btn primary" disabled={busy || !password} onClick={() => void submit()}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      <button type="button" className="gx-btn quiet" onClick={() => setForgot(!forgot)}>
        Forgot password?
      </button>
    </GxScreen>
  );
}
