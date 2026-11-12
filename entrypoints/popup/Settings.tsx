/**
 * Settings. The gear on the dashboard used to open the old trade panel.
 * This screen is the wallet itself: the next address, accounts already open,
 * leftover USDC, the private read counter, and lock.
 */

import { useState } from 'react';
import {
  send,
  SLOW_TIMEOUT_MS,
  type AnonRpcStatus,
  type SelfTestResult,
  type VaultStatus,
} from '@truly/lib/messages';
import { GxBack, GxScreen } from './Ghosty';
import { VENUES, venueLogo } from './Deposit';

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function Settings({
  status,
  nextAddress,
  anon,
  onBack,
  onChanged,
}: {
  status: VaultStatus;
  nextAddress: string | null;
  anon: AnonRpcStatus | null;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<
    { index: number | null; label: string; address: string; holdings: { place: string; symbol: string; amount: string }[] }[] | null
  >(null);
  const [selfTest, setSelfTest] = useState<SelfTestResult | null>(null);
  const disabled = working !== null;

  const copy = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1400);
  };

  const run = async (label: string, action: () => Promise<void>) => {
    setWorking(label);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  };

  const open = (['lighter', 'uniswap', 'compound'] as const).flatMap((venue) => {
    const trade = status.openVenues?.[venue];
    return trade ? [{ venue, trade }] : [];
  });

  return (
    <GxScreen className="gx-scroll">
      <div className="gx-top">
        <GxBack onClick={onBack} label="Settings" disabled={disabled} />
      </div>

      <section className="gx-set">
        <h2>Wallet</h2>
        <div className="gx-card gx-set-row">
          <div>
            <span>Next address · #{status.ownerIndex}</span>
            <code>{nextAddress ? short(nextAddress) : '…'}</code>
          </div>
          <button
            type="button"
            className="gx-chip"
            disabled={!nextAddress || disabled}
            onClick={() => nextAddress && void copy('next', nextAddress)}
          >
            {copied === 'next' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="gx-note">A fresh address each time you go ghost. This is the next one.</p>
      </section>

      <section className="gx-set">
        <h2>Open now</h2>
        {open.length === 0 ? (
          <p className="gx-note">No app is funded yet.</p>
        ) : (
          open.map(({ venue, trade }) => (
            <div key={venue} className="gx-account">
              <img src={venueLogo(venue)} alt="" />
              <span>
                <b>{VENUES[venue].name}</b>
                <code>{short(trade.ownerAddress)}</code>
              </span>
              <button
                type="button"
                className="gx-chip"
                disabled={disabled}
                onClick={() => void copy(venue, trade.ownerAddress)}
              >
                {copied === venue ? 'Copied' : 'Copy'}
              </button>
            </div>
          ))
        )}
      </section>

      <section className="gx-set">
        <h2>Your addresses</h2>
        <button
          type="button"
          className="gx-option"
          disabled={disabled}
          onClick={() =>
            void run('scan', async () => {
              setFound(await send({ kind: 'scanWalletFunds' }, SLOW_TIMEOUT_MS));
            })
          }
        >
          <b>{working === 'scan' ? 'Looking…' : 'Find funds'}</b>
          <span>Every address this wallet created. Includes Lighter and Compound, not only USDC sitting on Arbitrum.</span>
        </button>
        {found && found.length === 0 && <p className="gx-note">Nothing held on these addresses.</p>}
        {found?.map((row) => (
          <div key={row.label} className="gx-card gx-funds">
            <div className="gx-set-row">
              <div>
                <span>{row.label}</span>
                <code>{short(row.address)}</code>
              </div>
              <button type="button" className="gx-chip" disabled={disabled} onClick={() => void copy(row.label, row.address)}>
                {copied === row.label ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="gx-facts">
              {row.holdings.map((holding) => (
                <div key={`${holding.place}-${holding.symbol}`}>
                  <span>{holding.place}</span>
                  <span className="gx-mono">{holding.amount} {holding.symbol}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="gx-set">
        <h2>Network</h2>
        <div className="gx-card gx-facts">
          <div>
            <span>Anon-RPC reads</span>
            <span className="gx-mono">{anon?.reads ?? '—'}</span>
          </div>
          {selfTest && (
            <div>
              <span>Last test</span>
              <span className="gx-mono">block {selfTest.blockNumber}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          className="gx-btn quiet"
          disabled={disabled}
          onClick={() =>
            void run('test', async () => {
              setSelfTest(await send({ kind: 'anonRpcSelfTest' }, SLOW_TIMEOUT_MS));
              await onChanged();
            })
          }
        >
          {working === 'test' ? 'Reading…' : 'Test a private read'}
        </button>
        {anon?.problems.map((problem) => (
          <p key={problem.key} className="gx-note bad">{problem.reason}</p>
        ))}
      </section>

      <button
        type="button"
        className="gx-option"
        disabled={disabled}
        onClick={() => void run('lock', () => send({ kind: 'lock' }).then(() => onChanged()))}
      >
        <b>{working === 'lock' ? 'Locking…' : 'Lock Ghosty'}</b>
        <span>Asks for the password the next time this opens.</span>
      </button>
      {error && <p className="gx-error">{error}</p>}
    </GxScreen>
  );
}
