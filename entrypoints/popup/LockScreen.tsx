import { useState } from 'react';
import { Mascot } from './Mascot';

/**
 * The locked screen: mascot, one password field, one button.
 *
 * "Forgot password" does not reset anything. The vault is encrypted with the
 * password and Truly refuses to create a second vault over it, so the honest
 * answer is how to get back in with the recovery phrase or MetaMask.
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
  const [help, setHelp] = useState<'none' | 'forgot' | 'about'>('none');

  const submit = async () => {
    if (!password || busy) return;
    await onUnlock(password);
    setPassword('');
  };

  return (
    <div className="lock">
      <div className="lock-top">
        <span className="wordmark">truly</span>
        <button
          className="lock-help"
          aria-label="What is Truly?"
          onClick={() => setHelp(help === 'about' ? 'none' : 'about')}
        >
          ?
        </button>
      </div>

      {notice}

      <div className="lock-body">
        <Mascot mood={error ? 'worried' : 'sleepy'} size={148} className="lock-mascot" />
        <h2 className="lock-title">Enter your password</h2>
        <input
          className="lock-input"
          type="password"
          placeholder="Password"
          aria-label="Password"
          value={password}
          disabled={busy}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        {error && <p className="lock-error">{error}</p>}

        {help === 'about' && (
          <p className="lock-note">
            Truly funds each Lighter trade from your shielded balance through a fresh address, then shields
            what comes back. Your password unlocks the vault on this device only.
          </p>
        )}
        {help === 'forgot' && (
          <p className="lock-note">
            Truly cannot reset your password: it encrypts the vault on this device. Your funds follow your
            recovery phrase (or your MetaMask signature), not the password. Remove and re-add the extension,
            then choose “Enter a recovery phrase” or “Recover with MetaMask” and set a new password.
          </p>
        )}
      </div>

      <div className="lock-actions">
        <button className="lock-unlock" disabled={busy || !password} onClick={() => void submit()}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        <button className="lock-forgot" onClick={() => setHelp(help === 'forgot' ? 'none' : 'forgot')}>
          Forgot password
        </button>
      </div>
    </div>
  );
}
