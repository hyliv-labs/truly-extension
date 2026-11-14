/**
 * The NEAR venue (Rhea Finance): a fresh NEAR implicit account per owner index.
 *
 * Fund: a NEAR Intents exit takes USDC out of Railgun and delivers NEAR to
 * the fresh account. Nothing earlier ever paid that account, so it starts
 * unlinked, and the NEAR it receives creates it and pays its gas.
 *
 * Bring back: once Rhea holds nothing for the account, Ghosty itself sends
 * what the account holds (wNEAR, NEAR wrapped first, and USDC) into a NEAR
 * Intents entry. The entry delivers Arbitrum USDC to a brand-new EVM owner
 * and shields it, exactly as any Bring in does. One token per entry, since
 * NEAR Intents runs one move at a time.
 *
 * Same AppAccountView as the other apps, so the screens treat it alike.
 */

import { formatUnits } from 'viem';
import type { AppAccountView, AppTokenLine } from './app-venues';
import {
  ftTransferAction,
  formatNear,
  NEAR_USDC,
  nearAccountBalance,
  nearDepositAction,
  nearFtBalance,
  nearOutcomeFailure,
  nearSignTransaction,
  nearStorageRegistered,
  nearTxHash,
  ONE_NEAR,
  storageDepositAction,
  WRAP_NEAR,
  base64,
  type NearOutcome,
} from './near-chain';
import { deriveNearOwner, type NearOwnerKey } from './near-keys';
import { intentsDepositSent, lastIntentsView, startIntentsEntry, startIntentsExit } from './intents-private';
import { railgunGrossForNet } from './railgun';
import { railgunUsdcBalances } from './railgun-client';
import { rheaExitBlocker } from './rhea';
import { endVenue, getVenueTrade, updateOwnedTrade, type ActiveTrade } from './trade';
import { requireUnlockedMnemonic } from './vault';

export const NEAR_VENUE = 'rhea' as const;
export const WNEAR_ASSET = 'nep141:wrap.near';
export const NEAR_USDC_ASSET = `nep141:${NEAR_USDC}`;

/** Kept on the account for the wrap and transfer gas and storage. Not brought back. */
export const NEAR_GAS_RESERVE = ONE_NEAR / 20n; // 0.05 NEAR
/** What a token registration costs on wrap.near / NEAR USDC (storage_balance_bounds, read live). */
const FT_STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
/** NEAR Intents takes entries from about $3. Below this, a token stays and is named. */
const MIN_BACK_USD = 3.2;
const NEAR_TOKENS = {
  [WRAP_NEAR]: { asset: WNEAR_ASSET, symbol: 'wNEAR', decimals: 24 },
  [NEAR_USDC]: { asset: NEAR_USDC_ASSET, symbol: 'USDC', decimals: 6 },
} as const;

async function nearOwner(trade: ActiveTrade): Promise<NearOwnerKey> {
  return deriveNearOwner(await requireUnlockedMnemonic(), trade.ownerIndex);
}

function view(trade: ActiveTrade, patch: AppAccountView, accountId: string): AppAccountView {
  return { ...patch, ownerAddress: accountId };
}

async function save(trade: ActiveTrade, next: AppAccountView, accountId: string): Promise<AppAccountView> {
  await updateOwnedTrade(trade.ownerIndex, { app: next, appAccount: { ...trade.appAccount, address: accountId } });
  return next;
}

// --- Fund ------------------------------------------------------------------------

export async function fundNearAccount(trade: ActiveTrade, amountIn: bigint, fundedDetail: string): Promise<AppAccountView> {
  const near = await nearOwner(trade);
  const base = trade.app ?? { status: 'funding' as const, amountIn: amountIn.toString(), detail: '' };
  let recorded = trade.app?.viaIntents;

  // Never pay twice: adopt an exit already paying this account.
  if (!recorded) {
    const live = (await getVenueTrade('intents'))?.intents;
    const last = await lastIntentsView();
    const paying = [live, last].find((move) => move && move.direction === 'exit' && move.recipient === near.accountId && move.stage !== 'refunded' && move.stage !== 'failed');
    if (paying) recorded = { correlationId: paying.correlationId, minOut: paying.minAmountOut };
  }

  const account = await nearAccountBalance(near.accountId);
  if (!recorded) {
    // A record lost after the exit was sent: if NEAR already arrived, it is funded.
    if (account && account.amount > NEAR_GAS_RESERVE) {
      return save(trade, view(trade, { ...base, status: 'funded', detail: fundedDetail, error: undefined }, near.accountId), near.accountId);
    }
    const { feeBps } = await railgunUsdcBalances();
    const gross = railgunGrossForNet(amountIn, feeBps);
    await save(trade, view(trade, { status: 'funding', amountIn: amountIn.toString(), detail: 'Quoting NEAR through NEAR Intents.' }, near.accountId), near.accountId);
    const exit = await startIntentsExit({ assetId: WNEAR_ASSET, grossUnits: gross.toString(), recipient: near.accountId });
    return save(
      trade,
      view(trade, {
        status: 'funding',
        amountIn: amountIn.toString(),
        viaIntents: { correlationId: exit.correlationId, minOut: exit.minAmountOut },
        detail: `Sending ${formatUnits(amountIn, 6)} USDC out of Railgun through NEAR Intents. At least ${formatNear(BigInt(exit.minAmountOut))} NEAR arrives on ${short(near.accountId)}.`,
      }, near.accountId),
      near.accountId,
    );
  }

  const live = (await getVenueTrade('intents'))?.intents;
  const last = await lastIntentsView();
  const move = live?.correlationId === recorded.correlationId ? live : last?.correlationId === recorded.correlationId ? last : null;
  const minOut = BigInt(recorded.minOut);

  // Native NEAR arrived: the account exists and can pay its own gas.
  if (account && account.amount * 100n >= minOut * 95n) {
    return save(trade, view(trade, { ...base, status: 'funded', viaIntents: recorded, detail: fundedDetail, error: undefined }, near.accountId), near.accountId);
  }
  // Delivered as the wNEAR token to an account with no NEAR: it cannot sign anything yet.
  if (move?.swapStatus === 'SUCCESS') {
    const wnear = await nearFtBalance(WRAP_NEAR, near.accountId).catch(() => 0n);
    if (!account && wnear > 0n) {
      return save(
        trade,
        view(trade, {
          ...base,
          status: 'failed',
          viaIntents: recorded,
          detail: `NEAR Intents delivered ${formatNear(wnear)} wNEAR as a token, and the account has no NEAR to pay gas, so it cannot act yet. It activates when any NEAR arrives at ${near.accountId}.`,
          error: 'Delivered as wNEAR to an account with no NEAR.',
        }, near.accountId),
        near.accountId,
      );
    }
    if (account) {
      return save(trade, view(trade, { ...base, status: 'funded', viaIntents: recorded, detail: fundedDetail, error: undefined }, near.accountId), near.accountId);
    }
  }
  if (move?.stage === 'failed') {
    return save(trade, view(trade, { ...base, status: 'funding', viaIntents: recorded, detail: `The NEAR Intents move needs attention: ${move.error ?? move.detail}. Open Send out to retry it.` }, near.accountId), near.accountId);
  }
  if (move && (move.stage === 'refunded' || (move.stage === 'done' && move.swapStatus === 'REFUNDED'))) {
    return save(
      trade,
      view(trade, { status: 'failed', amountIn: amountIn.toString(), detail: `NEAR Intents did not deliver the NEAR. ${move.error ?? 'Any refund goes back into your private balance.'} Try again to quote a new one.`, error: move.error ?? 'Not delivered.' }, near.accountId),
      near.accountId,
    );
  }
  return save(trade, view(trade, { ...base, status: 'funding', viaIntents: recorded, detail: move?.detail || base.detail || 'Waiting on NEAR Intents.' }, near.accountId), near.accountId);
}

// --- Bring back ------------------------------------------------------------------

interface Holding {
  readonly token: string;
  readonly symbol: string;
  readonly amount: bigint;
  readonly decimals: number;
  /** Native NEAR to wrap into wNEAR before sending. */
  readonly wrap: bigint;
}

async function holdings(accountId: string): Promise<{ native: bigint; list: Holding[] }> {
  const account = await nearAccountBalance(accountId);
  const native = account?.amount ?? 0n;
  const [wnear, usdc] = await Promise.all([nearFtBalance(WRAP_NEAR, accountId), nearFtBalance(NEAR_USDC, accountId)]);
  const wrap = native > NEAR_GAS_RESERVE * 2n ? native - NEAR_GAS_RESERVE : 0n;
  return {
    native,
    list: [
      { token: NEAR_USDC, symbol: 'USDC', amount: usdc, decimals: 6, wrap: 0n },
      { token: WRAP_NEAR, symbol: 'NEAR', amount: wnear + wrap, decimals: 24, wrap },
    ],
  };
}

async function usdValue(holding: Holding): Promise<number> {
  if (holding.token === NEAR_USDC) return Number(holding.amount) / 1e6;
  const tokens = (await fetch('https://1click.chaindefuser.com/v0/tokens').then((r) => r.json())) as { assetId: string; price?: number }[];
  const price = tokens.find((t) => t.assetId === WNEAR_ASSET)?.price ?? 0;
  return (Number(holding.amount) / 1e24) * price;
}

export async function shieldNearAccount(trade: ActiveTrade, spec: { name: string }): Promise<AppAccountView> {
  const near = await nearOwner(trade);
  const amountIn = trade.app?.amountIn ?? '0';
  const shielded: AppTokenLine[] = [...(trade.app?.shielded ?? [])];
  const status = trade.app?.status;
  if (status !== 'funded' && status !== 'shielding' && status !== 'failed') {
    throw new Error('Bring back is available once the NEAR is on this account.');
  }

  // A deposit already recorded: finish it, never start another.
  if (trade.nearBack) return continueBack(trade, near, shielded);

  const blocked = await rheaExitBlocker(near.accountId);
  if (blocked) {
    await save(trade, view(trade, { ...trade.app!, detail: blocked, error: blocked }, near.accountId), near.accountId);
    throw new Error(blocked);
  }

  const { native, list } = await holdings(near.accountId);
  const left: AppTokenLine[] = [];
  let next: Holding | null = null;
  for (const holding of list) {
    if (holding.amount === 0n) continue;
    const usd = await usdValue(holding);
    if (usd < MIN_BACK_USD) {
      left.push({ token: holding.token, symbol: holding.symbol, amount: holding.amount.toString(), reason: `About $${usd.toFixed(2)}: below the ~$3 NEAR Intents takes.` });
      continue;
    }
    next ??= holding;
  }

  if (!next) {
    left.push({ token: 'NEAR', symbol: 'NEAR', amount: (native < NEAR_GAS_RESERVE * 2n ? native : NEAR_GAS_RESERVE).toString(), reason: 'Kept on the account for gas and storage.' });
    const done = view(trade, {
      status: 'done',
      amountIn,
      shielded,
      left,
      detail: shielded.length > 0 ? `Shielded back into Railgun through NEAR Intents. This ${spec.name} account is not reused.` : 'Nothing was left to bring back. This account is not reused.',
    }, near.accountId);
    await save(trade, done, near.accountId);
    await endVenue(NEAR_VENUE);
    return done;
  }

  await save(trade, view(trade, { status: 'shielding', amountIn, shielded, left, detail: `Quoting ${next.symbol} back into Railgun through NEAR Intents.` }, near.accountId), near.accountId);
  const meta = NEAR_TOKENS[next.token as keyof typeof NEAR_TOKENS];
  const entry = await startIntentsEntry({ assetId: meta.asset, amountUnits: next.amount.toString(), refundTo: near.accountId });
  await updateOwnedTrade(trade.ownerIndex, {
    nearBack: { correlationId: entry.correlationId, token: next.token, amount: next.amount.toString(), wrap: next.wrap.toString(), depositAddress: entry.depositAddress },
  });
  const fresh = (await getVenueTrade(NEAR_VENUE))!;
  return continueBack(fresh, near, shielded);
}

/** Send the recorded deposit (once), then follow the entry until it is shielded. */
async function continueBack(trade: ActiveTrade, near: NearOwnerKey, shielded: AppTokenLine[]): Promise<AppAccountView> {
  const back = trade.nearBack!;
  const amountIn = trade.app?.amountIn ?? '0';
  const meta = NEAR_TOKENS[back.token as keyof typeof NEAR_TOKENS];

  if (!back.sent) {
    let signed = back.signedTx;
    if (!signed) {
      const actions = [];
      const wrap = BigInt(back.wrap ?? '0');
      if (back.token === WRAP_NEAR && wrap > 0n) actions.push(nearDepositAction(wrap));
      // The 1Click deposit address must be registered on the token before it can receive it.
      if (!(await nearStorageRegistered(back.token, back.depositAddress))) actions.push(storageDepositAction(back.depositAddress, FT_STORAGE));
      actions.push(ftTransferAction(back.depositAddress, BigInt(back.amount)));
      const bytes = await nearSignTransaction(near, back.token, actions);
      signed = base64(bytes);
      // Saved before broadcast: a resume re-sends these bytes, never a new transfer.
      await updateOwnedTrade(trade.ownerIndex, { nearBack: { ...back, signedTx: signed, txHash: nearTxHash(bytes) } });
    }
    await save(trade, view(trade, { ...trade.app!, status: 'shielding', detail: `Sending ${meta.symbol} to NEAR Intents.` }, near.accountId), near.accountId);
    const outcome = await sendSaved(signed);
    const failure = nearOutcomeFailure(outcome);
    if (failure) {
      await updateOwnedTrade(trade.ownerIndex, { nearBack: undefined });
      const failed = view(trade, { ...trade.app!, status: 'failed', detail: `The NEAR transfer failed and nothing was sent: ${failure}. Abandon the waiting Bring in on the NEAR Intents panel, then Bring back again.`, error: failure }, near.accountId);
      return save(trade, failed, near.accountId);
    }
    await updateOwnedTrade(trade.ownerIndex, { nearBack: { ...back, signedTx: signed, txHash: outcome.transaction.hash, sent: true } });
    await intentsDepositSent(outcome.transaction.hash).catch(() => undefined);
  }

  const current = (await getVenueTrade(NEAR_VENUE))!;
  const record = current.nearBack!;
  const live = (await getVenueTrade('intents'))?.intents;
  const last = await lastIntentsView();
  const move = live?.correlationId === record.correlationId ? live : last?.correlationId === record.correlationId ? last : null;

  if (move && (move.stage === 'done' || move.stage === 'refunded' || move.stage === 'failed')) {
    const line: AppTokenLine = { token: record.token, symbol: meta.symbol, amount: record.amount, txHash: record.txHash };
    const nextShielded = move.stage === 'done' && move.swapStatus !== 'REFUNDED' ? [...shielded, line] : shielded;
    await updateOwnedTrade(trade.ownerIndex, { nearBack: undefined });
    if (move.stage !== 'done' || move.swapStatus === 'REFUNDED') {
      const refunded = view(current, {
        ...current.app!,
        status: 'failed',
        shielded: nextShielded,
        detail: move.stage === 'failed' ? `The NEAR Intents move needs attention: ${move.error ?? move.detail}. Open Bring in to retry it.` : `NEAR Intents refunded the ${meta.symbol} to this account. Bring back tries again.`,
        error: move.error ?? 'Refunded.',
      }, near.accountId);
      return save(current, refunded, near.accountId);
    }
    // One token done; look for the next one.
    await save(current, view(current, { ...current.app!, status: 'shielding', shielded: nextShielded, detail: `${meta.symbol} is shielded. Checking for anything else.` }, near.accountId), near.accountId);
    return shieldNearAccount((await getVenueTrade(NEAR_VENUE))!, { name: 'Rhea' });
  }

  return save(
    current,
    view(current, { status: 'shielding', amountIn, shielded, detail: move?.detail ? `${meta.symbol}: ${move.detail}` : `Waiting on NEAR Intents for the ${meta.symbol}.` }, near.accountId),
    near.accountId,
  );
}

async function sendSaved(signedBase64: string): Promise<NearOutcome> {
  const { NEAR_RPCS } = await import('./near-chain');
  let lastError: unknown;
  for (const url of NEAR_RPCS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'ghosty', method: 'send_tx', params: { signed_tx_base64: signedBase64, wait_until: 'FINAL' } }),
      });
      const body = (await response.json()) as { result?: NearOutcome; error?: { cause?: { name?: string }; data?: unknown } };
      if (body.result) return body.result;
      const cause = body.error?.cause?.name ?? JSON.stringify(body.error?.data ?? body.error);
      // Already included (a resume after a crash): the transaction stands; read its outcome.
      if (/InvalidNonce|already|NonceTooLarge/i.test(String(cause))) return txStatus(signedBase64);
      throw new Error(`NEAR rejected the transaction: ${cause}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('NEAR RPC unreachable');
}

async function txStatus(signedBase64: string): Promise<NearOutcome> {
  const bytes = Uint8Array.from(atob(signedBase64), (c) => c.charCodeAt(0));
  const { SignedTransaction } = await import('@near-js/transactions');
  const signerId = SignedTransaction.decode(bytes).transaction.signerId;
  const response = await fetch('https://free.rpc.fastnear.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'ghosty', method: 'tx', params: { tx_hash: nearTxHash(bytes), sender_account_id: signerId, wait_until: 'FINAL' } }),
  });
  const body = (await response.json()) as { result?: NearOutcome; error?: unknown };
  if (!body.result) throw new Error(`Could not read the earlier NEAR transfer: ${JSON.stringify(body.error).slice(0, 200)}`);
  return body.result;
}

function short(accountId: string): string {
  return accountId.length > 16 ? `${accountId.slice(0, 6)}…${accountId.slice(-4)}` : accountId;
}
