/**
 * Fund a fresh address from Railgun, then let the user swap on Uniswap.
 * Shield back reads whatever that address still holds.
 */

import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { send, SLOW_TIMEOUT_MS } from '@truly/lib/messages';
import { RAILGUN_RETURN_TOKENS, type UniswapAccountView, type UniswapTokenLine } from '@truly/lib/uniswap';

const UNISWAP_APP = 'https://app.uniswap.org/swap?chain=arbitrum';

function toUnits(input: string): string | null {
  if (!/^\d+(\.\d{0,6})?$/.test(input.trim())) return null;
  const [whole, frac = ''] = input.trim().split('.');
  return (BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'))).toString();
}

function amountLabel(row: UniswapTokenLine): string {
  const known = RAILGUN_RETURN_TOKENS.find((token) => token.address.toLowerCase() === row.token.toLowerCase());
  const decimals = row.symbol === 'ETH' ? 18 : known?.decimals ?? 18;
  const text = formatUnits(BigInt(row.amount), decimals);
  const [whole, frac = ''] = text.split('.');
  return `${whole}.${frac.slice(0, 6).replace(/0+$/, '') || '0'} ${row.symbol}`;
}

export function UniswapSwap({
  busy,
  ready,
  onDone,
}: {
  busy: boolean;
  ready: boolean;
  onDone: () => Promise<void> | void;
}) {
  const [amount, setAmount] = useState('5');
  const [working, setWorking] = useState<'fund' | 'shield' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<UniswapAccountView | null>(null);

  const units = toUnits(amount);
  const invalid = amount.trim() !== '' && units === null;
  const funded = progress?.status === 'funded' || progress?.status === 'shielding' || (progress?.status === 'failed' && Boolean(progress.unshieldTx));
  const done = progress?.status === 'done';

  useEffect(() => {
    void send({ kind: 'status' }).then((status) => {
      if (status.activeTrade?.uniswap) setProgress(status.activeTrade.uniswap);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!working && progress?.status !== 'funding' && progress?.status !== 'shielding') return;
    const id = setInterval(() => {
      void send({ kind: 'status' }).then((status) => {
        if (status.activeTrade?.uniswap) {
          setProgress(status.activeTrade.uniswap);
          return;
        }
        if (progress?.status === 'shielding') {
          setError(null);
          setProgress({
            ...progress,
            status: 'done',
            detail: 'Shielded back into Railgun. This address is not reused.',
          });
        }
      });
    }, 2000);
    return () => clearInterval(id);
  }, [working, progress]);

  const run = async (kind: 'fund' | 'shield') => {
    setWorking(kind);
    setError(null);
    try {
      const view = kind === 'fund'
        ? await send({ kind: 'fundUniswap', amountUnits: units! }, SLOW_TIMEOUT_MS)
        : await send({ kind: 'shieldUniswap' }, SLOW_TIMEOUT_MS);
      setProgress(view);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      const status = await send({ kind: 'status' }).catch(() => null);
      if (status?.activeTrade?.uniswap) setProgress(status.activeTrade.uniswap);
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="uniswap">
      <div className="trade-head">
        <strong>{done ? 'Shielded back' : funded ? 'Trade on Uniswap' : 'New Uniswap address'}</strong>
        <span className="field-label">
          {done
            ? 'The tokens that could be shielded are back in Railgun. This address is not reused.'
            : funded
              ? 'This address holds the USDC. Swap any pair on Uniswap. When you are finished, shield what is left back into Railgun.'
              : 'A fresh address, funded from Railgun. You swap it on Uniswap. Truly does not send the swap.'}
        </span>
      </div>

      {!funded && !done && (
        <>
          <label className="field-label" htmlFor="swap-amount">Fund</label>
          <div className={`affix${invalid ? ' invalid' : ''}`}>
            <input
              id="swap-amount"
              inputMode="decimal"
              aria-invalid={invalid}
              value={amount}
              disabled={busy || working !== null}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span>USDC</span>
          </div>
          {invalid ? (
            <p className="error">Enter a USDC amount, up to 6 decimals.</p>
          ) : (
            <p className="field-label">Unshielded from Railgun onto the new address. Railgun keeps 0.25%. You need at least 1 USDC.</p>
          )}
        </>
      )}

      {progress?.ownerAddress && (
        <p className="field-label">Uniswap connects to <code>{progress.ownerAddress}</code></p>
      )}

      {progress && progress.status !== 'failed' && <p className="field-label">{progress.detail}</p>}

      {progress?.shielded && progress.shielded.length > 0 && (
        <div className="summary">
          {progress.shielded.map((row) => (
            <div className="row" key={`${row.token}-${row.txHash ?? 'held'}`}>
              <span>Shielded</span>
              <span>{amountLabel(row)}</span>
            </div>
          ))}
        </div>
      )}
      {progress?.left && progress.left.length > 0 && (
        <div className="summary">
          {progress.left.map((row) => (
            <div className="row" key={row.token}>
              <span>Still on the address</span>
              <span>{amountLabel(row)}</span>
            </div>
          ))}
        </div>
      )}

      {done ? (
        <button type="button" disabled={busy} onClick={() => setProgress(null)}>
          New Uniswap address
        </button>
      ) : funded ? (
        <>
          <p className="connect-steps">
            On Uniswap: select <strong>Arbitrum</strong>, then <strong>Connect wallet</strong>, then <strong>Truly</strong>.
            A different network is refused.
          </p>
          <button type="button" className="secondary" disabled={busy || working !== null} onClick={() => void chrome.tabs.create({ url: UNISWAP_APP })}>
            Open Uniswap
          </button>
          <button type="button" disabled={busy || working !== null || progress?.status === 'shielding'} onClick={() => void run('shield')}>
            {working === 'shield' || progress?.status === 'shielding' ? 'Shielding back…' : 'Shield back into Railgun'}
          </button>
        </>
      ) : (
        <button type="button" disabled={busy || working !== null || !ready || !units || invalid} onClick={() => void run('fund')}>
          {working === 'fund' || progress?.status === 'funding' ? 'Funding…' : progress?.status === 'failed' ? 'Retry funding' : 'Fund address'}
        </button>
      )}

      {(error || progress?.status === 'failed') && <p className="error">{error ?? progress?.detail}</p>}
    </div>
  );
}
