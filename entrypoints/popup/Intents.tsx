/**
 * NEAR Intents screens: send shielded USDC out to any chain, or bring funds
 * in from any chain (Zcash and Aleo included) into the shielded balance.
 *
 * The form asks 1Click for a dry quote as the user types, so the address is
 * validated and the outcome is on screen before anything is committed. The
 * progress screen polls the worker, which does the actual work and keeps
 * going on its own alarm when this panel is closed.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { send, SLOW_TIMEOUT_MS } from '@truly/lib/messages';
import type { IntentsAsset, IntentsDirection, IntentsPreview, IntentsView } from '@truly/lib/intents';
import { formatUnits, parseUnits } from '@truly/lib/near-intents';
import { zip321Uri } from '@truly/lib/zcash';
import { encode as encodeQr } from 'uqr';
import { Mascot } from './Mascot';
import { GxBack, GxScreen } from './Ghosty';
import './intents.css';

const ARBISCAN = 'https://arbiscan.io/tx/';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------- Form */

export function IntentsMove({
  spendableUnits,
  initialDirection,
  onBack,
  onStarted,
}: {
  spendableUnits: bigint;
  /** The tab to open on, when another screen sent the user here for one direction. */
  initialDirection?: IntentsDirection;
  onBack: () => void;
  onStarted: () => void;
}) {
  // Nothing shielded yet: Bring in is the only thing that can work.
  const [direction, setDirection] = useState<IntentsDirection>(initialDirection ?? (spendableUnits > 0n ? 'exit' : 'entry'));
  const [assets, setAssets] = useState<IntentsAsset[] | null>(null);
  const [assetId, setAssetId] = useState('');
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [preview, setPreview] = useState<IntentsPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confidential, setConfidential] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [key, setKey] = useState('');

  useEffect(() => {
    void send({ kind: 'intentsAssets' }, 30_000)
      .then((list) => {
        setAssets(list);
        setAssetId((current) => current || list[0]?.assetId || '');
      })
      .catch((e) => setError(errorText(e)));
    void send({ kind: 'intentsKeyStatus' }).then((s) => setConfidential(s.confidential)).catch(() => undefined);
  }, []);

  const asset = assets?.find((row) => row.assetId === assetId) ?? null;
  const decimals = direction === 'exit' ? 6 : (asset?.decimals ?? 6);
  const units = useMemo(() => {
    try {
      return amount ? parseUnits(amount, decimals) : null;
    } catch {
      return null;
    }
  }, [amount, decimals]);
  const tooBig = direction === 'exit' && units !== null && units >= spendableUnits;
  const ready = !!asset && units !== null && units > 0n && address.trim().length > 3 && !tooBig;

  // Dry quote as the user types. Debounced; the last answer wins.
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!ready || !asset || units === null) return;
    let live = true;
    const timer = setTimeout(() => {
      setQuoting(true);
      void send(
        { kind: 'intentsPreview', direction, assetId: asset.assetId, amountUnits: units.toString(), address: address.trim() },
        30_000,
      )
        .then((p) => live && setPreview(p))
        .catch((e) => live && setPreviewError(errorText(e)))
        .finally(() => live && setQuoting(false));
    }, 600);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ready, direction, asset, units, address]);

  async function start() {
    if (!asset || units === null) return;
    setWorking(true);
    setError(null);
    try {
      if (direction === 'exit') {
        await send({ kind: 'intentsStartExit', assetId: asset.assetId, grossUnits: units.toString(), recipient: address.trim() }, SLOW_TIMEOUT_MS);
      } else {
        await send({ kind: 'intentsStartEntry', assetId: asset.assetId, amountUnits: units.toString(), refundTo: address.trim() }, SLOW_TIMEOUT_MS);
      }
      onStarted();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(false);
    }
  }

  async function saveKey(value: string | null) {
    try {
      const result = await send({ kind: 'intentsSetKey', key: value });
      setConfidential(result.confidential);
      setKeyOpen(false);
      setKey('');
    } catch (e) {
      setError(errorText(e));
    }
  }

  const privacyAssets = assets?.filter((row) => row.privacy) ?? [];
  const otherAssets = assets?.filter((row) => !row.privacy) ?? [];
  const symbol = direction === 'exit' ? 'USDC' : (asset?.symbol ?? '');
  const chain = asset?.label.split(' on ')[1] ?? asset?.blockchain ?? '';

  return (
    <GxScreen>
      <div className="gx-top">
        <GxBack onClick={onBack} label="Any chain" disabled={working} />
        <span className="ix-badge" title="Cross-chain settlement by NEAR Intents">NEAR Intents</span>
      </div>

      <div className="gx-venues ix-tabs" role="radiogroup" aria-label="Direction">
        <button type="button" role="radio" aria-checked={direction === 'exit'} className={direction === 'exit' ? 'on' : ''} disabled={working} onClick={() => setDirection('exit')}>
          Send out
        </button>
        <button type="button" role="radio" aria-checked={direction === 'entry'} className={direction === 'entry' ? 'on' : ''} disabled={working} onClick={() => setDirection('entry')}>
          Bring in
        </button>
      </div>

      <p className="gx-note">
        {direction === 'exit'
          ? 'Shielded USDC leaves Railgun straight into a one-time NEAR Intents address and lands on the chain you pick. No address of yours in between.'
          : 'Pay a one-time NEAR Intents address from any chain, ideally from a shielded wallet. It arrives at a fresh address and is shielded into Railgun.'}
      </p>

      <label className="gx-field ix-select">
        <span className="ix-label">{direction === 'exit' ? 'Receive' : 'Pay with'}</span>
        <select value={assetId} disabled={!assets || working} onChange={(e) => setAssetId(e.target.value)}>
          {!assets && <option>Loading chains…</option>}
          {privacyAssets.length > 0 && (
            <optgroup label="Privacy chains">
              {privacyAssets.map((row) => (
                <option key={row.assetId} value={row.assetId}>{row.label}</option>
              ))}
            </optgroup>
          )}
          {otherAssets.length > 0 && (
            <optgroup label={`Everything else (${otherAssets.length})`}>
              {otherAssets.map((row) => (
                <option key={row.assetId} value={row.assetId}>{row.label}</option>
              ))}
            </optgroup>
          )}
        </select>
      </label>

      <label className="gx-big-amount">
        <input inputMode="decimal" placeholder="0.00" value={amount} disabled={working} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} />
        <span>{symbol}</span>
      </label>
      {direction === 'exit' && (
        <p className={`gx-note${tooBig ? ' bad' : ''}`}>
          {spendableUnits === 0n
            ? 'No shielded USDC yet (or still syncing). Use Bring in first.'
            : tooBig
              ? 'Leave a little shielded: the proof needs a change note.'
              : `Shielded: ${formatUnits(spendableUnits, 6)} USDC`}
        </p>
      )}

      <label className="gx-field">
        <input
          placeholder={direction === 'exit' ? `Your address on ${chain || 'that chain'}` : `Your ${chain || 'origin'} address, for a refund`}
          value={address}
          spellCheck={false}
          disabled={working}
          onChange={(e) => setAddress(e.target.value)}
        />
      </label>
      {asset?.blockchain === 'zec' && (
        <p className="gx-note">
          {direction === 'exit'
            ? 'Zcash: paste the address from any wallet (Zashi, Zingo, YWallet, Ledger, an exchange). A unified u1… address works if it has a transparent part; ZEC lands there and your wallet can shield it.'
            : 'Zcash: pay from any wallet, best from a shielded balance (Zashi, Zingo, YWallet). For the refund, paste your address from that wallet; a unified u1… address works if it has a transparent part.'}
        </p>
      )}
      {preview?.addressFromUnified && (
        <p className="gx-note">
          {direction === 'exit' ? 'Delivering to' : 'Refunds go to'} <span className="gx-mono">{short(preview.address)}</span>, the transparent part of your unified address.
        </p>
      )}
      {asset?.blockchain === 'aleo' && (
        <p className="gx-note">
          {direction === 'exit' ? 'Aleo: it lands as a public balance. Move it to private in your Aleo wallet.' : 'Aleo: send with a private-to-public transfer, so your sending account stays hidden.'}
        </p>
      )}

      <div className="gx-spacer" />

      {(preview || quoting || previewError) && (
        <div className="gx-card gx-facts">
          {quoting && !preview && <div><span>Asking NEAR Intents solvers…</span><span /></div>}
          {previewError && <div className="ix-bad"><span>{previewError}</span><span /></div>}
          {preview && (
            <>
              {preview.railgunFeeUnits && (
                <div><span>Railgun fee</span><span>{formatUnits(preview.railgunFeeUnits, 6)} USDC</span></div>
              )}
              <div><span>Into NEAR Intents</span><span>{preview.amountInFormatted} {direction === 'exit' ? 'USDC' : asset?.symbol}</span></div>
              {preview.minAmountInFormatted && (
                <div><span>Still swaps from</span><span>{preview.minAmountInFormatted} {asset?.symbol}</span></div>
              )}
              <div><span>{direction === 'exit' ? 'You receive' : 'Shielded'}</span><span className="ix-strong">{preview.amountOutFormatted} {direction === 'exit' ? asset?.symbol : 'USDC'}</span></div>
              <div><span>At least</span><span>{preview.minAmountOutFormatted}</span></div>
              <div><span>Time</span><span>~{Math.max(1, Math.round(preview.timeEstimate / 60))} min</span></div>
              <div>
                <span>Mode</span>
                <span>{preview.confidential ? 'Confidential' : 'Public intents'}</span>
              </div>
            </>
          )}
        </div>
      )}

      {error && <p className="gx-error">{error}</p>}
      <button type="button" className="gx-btn primary" disabled={!preview || working || quoting} onClick={() => void start()}>
        {working ? (direction === 'exit' ? 'Locking the quote…' : 'Getting a deposit address…') : direction === 'exit' ? 'Send privately' : 'Get deposit address'}
      </button>

      {keyOpen ? (
        <div className="ix-key">
          <label className="gx-field">
            <input placeholder="1Click partner key" value={key} spellCheck={false} onChange={(e) => setKey(e.target.value)} />
          </label>
          <button type="button" className="gx-link" onClick={() => void saveKey(key || null)}>Save</button>
          {confidential && <button type="button" className="gx-link" onClick={() => void saveKey(null)}>Remove</button>}
        </div>
      ) : (
        <button type="button" className="gx-link ix-mode" onClick={() => setKeyOpen(true)}>
          Confidential mode: {confidential ? 'on' : 'off · add a 1Click partner key'}
        </button>
      )}
    </GxScreen>
  );
}

/* ---------------------------------------------------------------- Progress */

type Step = { label: string; state: 'done' | 'now' | 'todo' | 'bad' };

function stepsFor(view: IntentsView): Step[] {
  const failed = view.stage === 'failed';
  const order =
    view.direction === 'exit'
      ? ['unshielding', 'swapping', 'done']
      : ['awaiting-deposit', 'swapping', 'shielding', 'done'];
  const labels =
    view.direction === 'exit'
      ? ['Unshield from Railgun into NEAR Intents', 'Solvers fill the swap', `Delivered as ${view.destinationLabel}`]
      : [`Your deposit of ${view.originLabel}`, 'Solvers fill the swap', 'USDC arrives at a fresh address', 'Shielded into Railgun'];
  let at = order.indexOf(view.stage === 'refunded' ? 'done' : view.stage);
  if (failed) {
    at = view.direction === 'exit' ? (view.unshieldTx ? 1 : 0) : view.swapStatus === 'SUCCESS' ? 2 : view.swapStatus ? 1 : 0;
  }
  return labels.map((label, index) => ({
    label,
    state: view.stage === 'done' || index < at ? 'done' : index === at ? (failed ? 'bad' : 'now') : 'todo',
  }));
}

export function IntentsProgress({
  onClose,
  onHome,
  onTrade,
}: {
  onClose: () => void;
  onHome?: () => void;
  /** After a Bring in lands: go fund an app with it. */
  onTrade?: () => void;
}) {
  const [view, setView] = useState<IntentsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [txHash, setTxHash] = useState('');
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    let live = true;
    const tick = () =>
      void send({ kind: 'intentsAdvance' }, 30_000)
        .then((next) => live && setView(next))
        .catch((e) => live && setError(errorText(e)));
    tick();
    const id = setInterval(tick, 3_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  async function act(run: () => Promise<unknown>) {
    setWorking(true);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(false);
    }
  }

  if (!view) {
    return (
      <GxScreen>
        <div className="gx-hero">
          <Mascot size={72} className="gx-mascot" />
          <p className="gx-sub">{error ?? 'Loading the NEAR Intents move…'}</p>
        </div>
        {error && <button type="button" className="gx-btn quiet" onClick={onClose}>Back</button>}
      </GxScreen>
    );
  }

  const finished = view.stage === 'done' || view.stage === 'refunded';
  const entryWaiting = view.direction === 'entry' && view.stage === 'awaiting-deposit';
  const partlyPaid = entryWaiting && !!view.depositedAmount;
  const entryExpired =
    view.direction === 'entry' && view.stage === 'failed' && (!view.swapStatus || view.swapStatus === 'PENDING_DEPOSIT') && !view.userDepositTx;
  const originSymbol = view.originLabel.split(' on ')[0];

  return (
    <GxScreen>
      <div className="gx-top">
        <span className="gx-title ix-head">{view.direction === 'exit' ? 'Sending out' : 'Bringing in'}</span>
        <span className="ix-badge">NEAR Intents</span>
      </div>

      <div className="gx-hero ix-hero">
        <Mascot size={64} className={finished ? '' : 'gx-mascot'} />
        <p className="gx-sub">{view.detail}</p>
      </div>

      {entryWaiting && (
        <div className="gx-card ix-deposit">
          <span className="ix-label">{view.minAmountIn ? 'Send' : 'Send exactly'}</span>
          <b className="gx-mono">{formatUnits(view.amountIn, view.originDecimals)} {originSymbol}</b>
          {view.minAmountIn && (
            <span className="ix-label">
              Anything from {formatUnits(view.minAmountIn, view.originDecimals)} {originSymbol} up swaps. If your wallet or exchange takes its fee out of the amount, that is fine; a second payment to the same address adds up.
            </span>
          )}
          <span className="ix-label">to this one-time address</span>
          <DepositQr view={view} />
          <code className="ix-addr">{view.depositAddress}</code>
          {view.depositMemo && (
            <>
              <span className="ix-label">with memo</span>
              <code className="ix-addr">{view.depositMemo}</code>
            </>
          )}
          <button
            type="button"
            className="gx-chip"
            onClick={() =>
              void navigator.clipboard.writeText(view.depositAddress).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? 'Copied' : 'Copy address'}
          </button>
          {zcashLink(view) && (
            <button
              type="button"
              className="gx-chip"
              onClick={() =>
                void navigator.clipboard.writeText(zcashLink(view)!).then(() => {
                  setLinkCopied(true);
                  setTimeout(() => setLinkCopied(false), 1500);
                })
              }
            >
              {linkCopied ? 'Copied' : 'Copy payment link'}
            </button>
          )}
          {view.originAsset === ZEC_ASSET && (
            <span className="ix-label">
              Zashi, Zingo, YWallet, Edge: scan the code, the amount fills in. Paying from a shielded balance keeps your wallet private. An exchange withdrawal or a transparent balance works too, but links that account to this deposit.
            </span>
          )}
          <span className="ix-label">Valid until {new Date(view.inactiveAt).toLocaleString()}. Refunds go to {short(view.refundTo)}.</span>
          <div className="ix-key">
            <label className="gx-field">
              <input placeholder="Optional: your deposit tx hash" value={txHash} spellCheck={false} onChange={(e) => setTxHash(e.target.value)} />
            </label>
            <button type="button" className="gx-link" disabled={!txHash.trim() || working} onClick={() => void act(async () => setView(await send({ kind: 'intentsDepositSent', txHash })))}>
              Sent
            </button>
          </div>
        </div>
      )}

      <ol className="gx-steps">
        {stepsFor(view).map((step) => (
          <li key={step.label} className={step.state === 'todo' ? '' : step.state}>
            <i>{step.state === 'done' ? '✓' : step.state === 'bad' ? '!' : ''}</i>
            {step.label}
          </li>
        ))}
      </ol>

      <div className="gx-card gx-facts">
        <div><span>{view.direction === 'exit' ? 'Out of Railgun' : 'You pay'}</span><span>{view.direction === 'exit' ? `${formatUnits(view.grossUnits ?? view.amountIn, 6)} USDC` : `${formatUnits(view.amountIn, view.originDecimals)} ${originSymbol}`}</span></div>
        <div><span>Quoted out</span><span>{formatUnits(view.amountOut, view.destinationDecimals)} {view.direction === 'exit' ? view.destinationLabel.split(' on ')[0] : 'USDC'}</span></div>
        {view.direction === 'exit' && <div><span>To</span><span className="gx-mono">{short(view.recipient)}</span></div>}
        {view.swapStatus && <div><span>NEAR Intents</span><span>{view.swapStatus.replace(/_/g, ' ').toLowerCase()}</span></div>}
        {view.unshieldTx && <div><span>Unshield</span><a href={ARBISCAN + view.unshieldTx} target="_blank" rel="noreferrer">{short(view.unshieldTx)}</a></div>}
        {view.destinationTx && (
          <div>
            <span>Delivery</span>
            {safeExplorerUrl(view.destinationTx.explorerUrl) ? (
              <a href={safeExplorerUrl(view.destinationTx.explorerUrl)} target="_blank" rel="noreferrer noopener">{short(view.destinationTx.hash)}</a>
            ) : (
              <span className="gx-mono">{short(view.destinationTx.hash)}</span>
            )}
          </div>
        )}
        {view.shieldTx && <div><span>Shield</span><span className="gx-mono">{short(view.shieldTx)}</span></div>}
      </div>

      {(error || (view.error && view.error !== view.detail)) && <p className="gx-error">{error ?? view.error}</p>}

      {finished && view.direction === 'entry' && view.stage === 'done' && onTrade ? (
        <>
          <button type="button" className="gx-btn primary" onClick={() => void send({ kind: 'intentsDismiss' }).finally(onTrade)}>
            Trade with it
          </button>
          <button type="button" className="gx-btn quiet" onClick={() => void send({ kind: 'intentsDismiss' }).finally(onClose)}>
            Done
          </button>
        </>
      ) : finished ? (
        <button type="button" className="gx-btn primary" onClick={() => void send({ kind: 'intentsDismiss' }).finally(onClose)}>
          Done
        </button>
      ) : view.stage === 'failed' ? (
        <button type="button" className="gx-btn primary" disabled={working} onClick={() => void act(async () => setView(await send({ kind: 'intentsRetry' }, SLOW_TIMEOUT_MS)))}>
          Retry
        </button>
      ) : null}
      {!finished && ((entryWaiting && !partlyPaid) || entryExpired || (view.stage === 'failed' && !view.unshieldTx && view.direction === 'exit')) && (
        <button
          type="button"
          className="gx-btn quiet"
          disabled={working}
          onClick={() =>
            void act(async () => {
              await send({ kind: 'intentsAbandon' });
              onClose();
            })
          }
        >
          {entryWaiting ? 'Cancel · only if you have not paid' : 'Abandon'}
        </button>
      )}
      {!finished && onHome && (
        <button type="button" className="gx-link ix-mode" onClick={onHome}>
          Home · this keeps running
        </button>
      )}
    </GxScreen>
  );
}

/**
 * A NEAR Intents move that finished while the panel was closed. finish()
 * retires the slot, so nothing else would show the outcome; this card does,
 * until the user dismisses it.
 */
export function IntentsDoneCard({ view, onOpen, onTrade, onDismiss }: { view: IntentsView; onOpen: () => void; onTrade?: () => void; onDismiss: () => void }) {
  const landed = view.direction === 'entry' && view.stage === 'done';
  const title =
    view.direction === 'entry'
      ? view.stage === 'done'
        ? 'Bring in finished'
        : 'Bring in refunded'
      : view.stage === 'done'
        ? `Sent out as ${view.destinationLabel}`
        : 'Send out refunded and shielded back';
  return (
    <div className="gx-card ix-donecard">
      <button type="button" className="ix-donecard-main" onClick={onOpen}>
        <b>{title}</b>
        <small>{view.detail}</small>
      </button>
      <span className="ix-donecard-actions">
        {landed && onTrade && (
          <button type="button" className="gx-link" onClick={onTrade}>
            Trade with it
          </button>
        )}
        <button type="button" className="gx-link" onClick={onDismiss}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

const ZEC_ASSET = 'nep141:zec.omft.near';

/** ZIP-321 link for a Zcash deposit, so any Zcash wallet fills in address and amount. */
function zcashLink(view: IntentsView): string | null {
  if (view.originAsset !== ZEC_ASSET) return null;
  try {
    return zip321Uri(view.depositAddress, BigInt(view.amountIn));
  } catch {
    return null;
  }
}

/**
 * QR for the deposit: a ZIP-321 payment request for Zcash (address and
 * amount), the bare address for every other chain (each wallet reads that).
 * Drawn as SVG rects from the module matrix; no HTML is injected.
 */
function DepositQr({ view }: { view: IntentsView }) {
  const qr = useMemo(() => {
    try {
      return encodeQr(zcashLink(view) ?? view.depositAddress, { ecc: 'M', border: 2 });
    } catch {
      return null;
    }
  }, [view.depositAddress, view.amountIn, view.originAsset]);
  if (!qr) return null;
  const cells: ReactElement[] = [];
  qr.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) cells.push(<rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} />);
    }),
  );
  return (
    <svg className="ix-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="Deposit QR code" shapeRendering="crispEdges">
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <g fill="#000">{cells}</g>
    </svg>
  );
}

function short(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

/** 1Click supplies the delivery link. Only an https URL is shown; anything else is dropped. */
function safeExplorerUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
