import { useState, type ReactNode } from 'react';

const ghostUrl = chrome.runtime.getURL('brand/ghost.png');

export function GxBrand({ onClick }: { onClick?: () => void }) {
  const mark = (
    <>
      <img src={ghostUrl} alt="" />
      Ghosty
    </>
  );
  if (!onClick) return <span className="gx-brand">{mark}</span>;
  return (
    <button type="button" className="gx-brand" onClick={onClick}>
      {mark}
    </button>
  );
}

export function GxBack({ onClick, label = 'Back', disabled }: { onClick: () => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" className="gx-back" onClick={onClick} disabled={disabled}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m15 18-6-6 6-6" />
      </svg>
      {label}
    </button>
  );
}

export function GxDots({ total, at }: { total: number; at: number }) {
  return (
    <span className="gx-dots" aria-label={`Step ${at} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < at ? 'on' : ''} />
      ))}
    </span>
  );
}

export function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

/** A password input with a show/hide toggle. Enter submits. */
export function PasswordField({
  value,
  onChange,
  onEnter,
  placeholder = 'Password',
  disabled,
  autoFocus,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  label: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="gx-field">
      <input
        type={shown ? 'text' : 'password'}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="new-password"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter?.();
        }}
      />
      <button type="button" className="gx-eye" aria-label={shown ? 'Hide password' : 'Show password'} onClick={() => setShown(!shown)}>
        <EyeIcon off={shown} />
      </button>
    </div>
  );
}

/** 0 to 3, from length and character variety. Guidance only, never a gate beyond 8 characters. */
export function passwordStrength(pw: string): 0 | 1 | 2 | 3 {
  if (pw.length < 8) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 14 || (pw.length >= 10 && kinds >= 3)) return 3;
  if (pw.length >= 10 || kinds >= 3) return 2;
  return 1;
}

export function Strength({ password }: { password: string }) {
  const s = passwordStrength(password);
  const label = password.length === 0 ? '' : ['Too short', 'Okay', 'Good', 'Strong'][s];
  return (
    <div className="gx-strength" aria-live="polite">
      <i className={s >= 1 ? 'on' : ''} />
      <i className={s >= 2 ? 'on' : ''} />
      <i className={s >= 3 ? 'on' : ''} />
      <span>{label}</span>
    </div>
  );
}

export function GxScreen({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={className ? `gx ${className}` : 'gx'}>{children}</section>;
}
