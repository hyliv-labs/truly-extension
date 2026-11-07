import { useState } from 'react';
import { EyeIcon, GxBrand, GxDots, GxScreen } from './Ghosty';

/**
 * Shown once, right after the vault is created. The words stay blurred until
 * tapped so nobody reads them over a shoulder, and the phrase is the only way
 * back in: the password only unlocks this browser.
 */
export function PhraseScreen({ phrase, onDone }: { phrase: string; onDone: () => void }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const words = phrase.trim().split(/\s+/);

  const copy = async () => {
    await navigator.clipboard.writeText(phrase).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <GxScreen>
      <div className="gx-top">
        <GxBrand />
        <GxDots total={2} at={2} />
      </div>
      <h1 className="gx-title">Save your recovery phrase</h1>
      <p className="gx-sub">The only way back in if you lose this browser.</p>
      <div className={`gx-phrase${shown ? '' : ' hidden'}`}>
        <ol aria-hidden={!shown}>
          {words.map((w, i) => (
            <li key={i}>
              <b>{i + 1}</b>
              {w}
            </li>
          ))}
        </ol>
        {!shown && (
          <button type="button" className="gx-reveal" onClick={() => setShown(true)}>
            <EyeIcon />
            Tap to reveal
          </button>
        )}
      </div>
      <button type="button" className="gx-chip" onClick={() => void copy()}>
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <div className="gx-spacer" />
      <button type="button" className="gx-btn primary" disabled={!shown} onClick={onDone}>
        I saved it
      </button>
    </GxScreen>
  );
}
