/**
 * Fund a fresh address from Railgun for one of the apps in app-venues.ts,
 * then shield whatever that address still holds.
 *
 * The same flow as compound-private.ts, kept apart so the Compound path that
 * ran on mainnet is untouched: unshield onto the owner, top up gas for the
 * app's own transactions, and on Bring back refuse while the app still holds
 * anything for the owner (appExitBlocker), then shield every token found.
 *
 * Truly never acts on the app. Its own site does, with this owner connected.
 */

import { erc20Abi, formatUnits, parseAbiItem, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { publicClient } from './chain';
import { APP_VENUES, type AppAccountView, type AppTokenLine, type AppVenueId } from './app-venues';
import { appExitBlocker } from './app-venue-checks';
import { DYDX_ONBOARDING, dydxAddressFromSignature } from './dydx';
import { lastIntentsView, startIntentsExit } from './intents-private';
import { ARBITRUM_CHAIN_ID } from './config';
import { railgunGrossForNet } from './railgun';
import { ensureUnshieldGas, railgunUsdcBalances, settleRecordedShield, shieldOwnerToken, unshieldRailgunForTrade } from './railgun-client';
import { endVenue, getVenueTrade, startVenue, updateOwnedTrade, type ActiveTrade } from './trade';
import { arbitrumGasLimit } from './tx-gas';
import { RAILGUN_RETURN_TOKENS, WETH_ADDRESS } from './uniswap';
import { ownerAt } from './vault';
import { USDC_ADDRESS } from './config';

/** Left on the address so the wrap and the shields can pay gas. */
const GAS_RESERVE_WEI = 80_000_000_000_000n;

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** One run per app at a time, in this worker. */
const funding = new Map<AppVenueId, Promise<AppAccountView>>();
const shielding = new Map<AppVenueId, Promise<AppAccountView>>();

export function fundAppAccount(venue: AppVenueId, amountIn: bigint): Promise<AppAccountView> {
  const running = funding.get(venue);
  if (running) return running;
  const run = fund(venue, amountIn).finally(() => funding.delete(venue));
  funding.set(venue, run);
  return run;
}

/** Called by the intents alarm: move an app funded through NEAR Intents along, panel open or not. */
export async function advanceIntentsFundedApps(): Promise<void> {
  for (const venue of Object.keys(APP_VENUES) as AppVenueId[]) {
    if (!APP_VENUES[venue].fundVia) continue;
    const trade = await getVenueTrade(venue);
    if (trade?.app?.status === 'funding' && trade.app.viaIntents) {
      await fundAppAccount(venue, BigInt(trade.app.amountIn)).catch(() => undefined);
    }
  }
}

export function shieldAppAccount(venue: AppVenueId): Promise<AppAccountView> {
  const running = shielding.get(venue);
  if (running) return running;
  const run = shield(venue).finally(() => shielding.delete(venue));
  shielding.set(venue, run);
  return run;
}

async function fund(venue: AppVenueId, amountIn: bigint): Promise<AppAccountView> {
  const spec = APP_VENUES[venue];
  if (amountIn < spec.minUnits) throw new Error(`Fund at least ${Number(spec.minUnits) / 1e6} USDC for ${spec.name}.`);
  const existing = await getVenueTrade(venue);
  if (existing?.app?.status === 'funded' || existing?.app?.status === 'done') return existing.app;
  if (existing?.app?.status === 'shielding') throw new Error('Shield back is already running.');
  // A failure after the unshield landed means shield back; one while the
  // unshield is still pending resumes it (unshieldRailgunForTrade settles the
  // recorded bytes, never a second proof).
  if (existing?.app?.status === 'failed' && existing.app.unshieldTx && !spec.fundVia && existing.withdrawal?.status !== 'pending') {
    throw new Error('This address is already funded. Shield back the tokens that are still on it.');
  }

  const trade = existing ?? (await startVenue(venue));
  if (spec.fundVia) {
    try {
      return await fundViaIntents(venue, trade, amountIn);
    } catch (error) {
      return fail(venue, amountIn, error);
    }
  }
  await remember(trade, {
    status: 'funding',
    amountIn: amountIn.toString(),
    detail: 'Checking the Railgun balance.',
    unshieldTx: trade.app?.unshieldTx,
  });

  try {
    return await unshieldOntoOwner(venue, amountIn);
  } catch (error) {
    return fail(venue, amountIn, error);
  }
}

async function unshieldOntoOwner(venue: AppVenueId, amountIn: bigint): Promise<AppAccountView> {
  const spec = APP_VENUES[venue];
  const balances = await railgunUsdcBalances();
  const gross = railgunGrossForNet(amountIn, balances.feeBps);
  const trade = await requireTrade(venue);
  const fundedAlready =
    trade.withdrawal?.status === 'confirmed' && trade.withdrawal.label === 'railgun' && BigInt(trade.withdrawal.amount) === gross;

  if (trade.withdrawal?.status === 'confirmed' && !fundedAlready) {
    throw new Error('This address was already funded with a different amount. Abandon it before funding again.');
  }

  let unshieldTx = trade.app?.unshieldTx ?? trade.withdrawal?.txHash;
  if (!fundedAlready) {
    await remember(trade, {
      status: 'funding',
      amountIn: amountIn.toString(),
      detail: 'Building the Railgun unshield proof. This takes a minute or two.',
      unshieldTx,
    });
    unshieldTx = (await unshieldRailgunForTrade(amountIn, venue)).txHash;
  }

  const usdc = await tokenBalance(USDC_ADDRESS, trade.ownerAddress);
  if (usdc < amountIn) {
    throw new Error('The unshield confirmed, but the USDC is not on the address yet. Retry in a moment.');
  }
  await ensureUnshieldGas(trade.ownerIndex, trade.ownerAddress, spec.gasWei);

  const ready = view(trade, { status: 'funded', amountIn: amountIn.toString(), unshieldTx, detail: spec.fundedDetail });
  await updateOwnedTrade(trade.ownerIndex, { app: ready });
  return ready;
}

async function shield(venue: AppVenueId): Promise<AppAccountView> {
  const spec = APP_VENUES[venue];
  const trade = await requireTrade(venue);
  const status = trade.app?.status;
  if (status !== 'funded' && status !== 'shielding' && status !== 'failed') {
    throw new Error('Shield back is available once the USDC is on this address.');
  }
  const amountIn = trade.app?.amountIn ?? '0';
  const unshieldTx = trade.app?.unshieldTx;
  if (trade.withdrawal?.status === 'pending') {
    throw new Error('The unshield onto this address is still confirming. Try again (Go ghost continues it); nothing was moved.');
  }

  const blocked = await appExitBlocker(venue, await withAppAccount(venue, trade));
  if (blocked) {
    // Refused before anything moved. The address stays funded; say why.
    await remember(trade, { ...trade.app!, status: status === 'failed' ? 'failed' : 'funded', detail: blocked, error: blocked });
    throw new Error(blocked);
  }

  await remember(trade, { status: 'shielding', amountIn, unshieldTx, shielded: trade.app?.shielded, detail: 'Reading what this address still holds.' });
  try {
    const shielded: AppTokenLine[] = [...(trade.app?.shielded ?? [])];
    // A shield sent before a crash is that token's result: count it once, by its token.
    const earlier = await settleRecordedShield(venue);
    if (earlier) {
      shielded.push({ token: earlier.token, symbol: earlier.token === 'unknown' ? 'earlier shield' : await readSymbol(earlier.token as Address, short(earlier.token as Address)), amount: earlier.amountUnits.toString(), txHash: earlier.txHash });
      await updateOwnedTrade(trade.ownerIndex, { app: view(trade, { ...trade.app!, status: 'shielding', shielded }) });
    }
    await wrapLeftoverEth(trade);
    const found = await balancesToShield(venue, trade);
    const already = new Set(shielded.map((row) => row.token.toLowerCase()));
    const left: AppTokenLine[] = [];

    for (const row of found) {
      if (already.has(row.token.toLowerCase())) continue;
      await remember(trade, { status: 'shielding', amountIn, unshieldTx, shielded, left, detail: `Shielding ${row.symbol} back into Railgun.` });
      try {
        await clearConfirmedShield(venue);
        const result = await shieldOwnerToken(row.token, row.amount, venue);
        shielded.push({ ...line(row), txHash: result.txHash, amount: result.amountUnits.toString() });
        await clearConfirmedShield(venue);
      } catch (error) {
        left.push({ ...line(row), reason: error instanceof Error ? error.message : String(error) });
      }
    }

    const ethLeft = await publicClient.getBalance({ address: trade.ownerAddress });
    if (ethLeft > 1_000_000_000_000n) {
      left.push({
        token: 'ETH',
        symbol: 'ETH',
        amount: ethLeft.toString(),
        reason: 'Kept for gas. Native ETH is not shielded; it was wrapped to WETH only above the gas reserve.',
      });
    }

    if (left.some((row) => row.token !== 'ETH')) {
      const failed = view(trade, {
        status: 'failed',
        amountIn,
        unshieldTx,
        shielded,
        left,
        detail: 'Some tokens are still on this address. Shield back tries them again. Nothing already shielded is sent twice.',
        error: left.find((row) => row.token !== 'ETH')?.reason,
      });
      await updateOwnedTrade(trade.ownerIndex, { app: failed });
      return failed;
    }

    const done = view(trade, {
      status: 'done',
      amountIn,
      unshieldTx,
      shielded,
      left,
      detail: shielded.length > 0 ? `Shielded back into Railgun. This ${spec.name} address is not reused.` : 'Nothing was left to shield. This address is not reused.',
    });
    await updateOwnedTrade(trade.ownerIndex, { app: done });
    await endVenue(venue);
    return done;
  } catch (error) {
    return fail(venue, BigInt(amountIn), error);
  }
}

/**
 * Funding in another asset (Lido: ETH). A NEAR Intents exit takes the USDC
 * out of Railgun and a solver delivers the asset to this fresh address, so
 * nothing on Arbitrum links it to Railgun or to an earlier address. The exit
 * runs on its own (the intents alarm); this checks on it and is safe to call
 * again: it never starts a second exit while one is recorded.
 */
async function fundViaIntents(venue: AppVenueId, trade: ActiveTrade, amountIn: bigint): Promise<AppAccountView> {
  const spec = APP_VENUES[venue];
  const fundVia = spec.fundVia!;
  let recorded = trade.app?.viaIntents;

  // Never pay twice: an exit already delivering to this address (one whose
  // record was lost to a failure or a restart) is adopted, not repeated.
  if (!recorded) {
    const live = (await getVenueTrade('intents'))?.intents;
    const last = await lastIntentsView();
    const paying = [live, last].find(
      (move) => move && move.direction === 'exit' && move.recipient.toLowerCase() === trade.ownerAddress.toLowerCase() && move.stage !== 'refunded' && move.stage !== 'failed',
    );
    if (paying) {
      recorded = { correlationId: paying.correlationId, minOut: paying.minAmountOut };
      await updateOwnedTrade(trade.ownerIndex, { app: view(trade, { ...(trade.app ?? { amountIn: amountIn.toString(), detail: '' }), status: 'funding', viaIntents: recorded, detail: paying.detail }) });
    }
  }

  if (!recorded) {
    // A record lost to a crash after the exit was sent: if the asset already
    // arrived (or was staked), this address is funded. Never pay a second time.
    const ethHeld = await publicClient.getBalance({ address: trade.ownerAddress });
    const stakedHeld = await Promise.all((spec.extraTokens ?? []).map((token) => tokenBalance(token.address, trade.ownerAddress)));
    if (ethHeld > 100_000_000_000_000n || stakedHeld.some((amount) => amount > 0n)) {
      const ready = view(trade, { ...(trade.app ?? { amountIn: amountIn.toString(), detail: '' }), status: 'funded', detail: spec.fundedDetail, error: undefined });
      await updateOwnedTrade(trade.ownerIndex, { app: ready });
      return ready;
    }
    const { feeBps } = await railgunUsdcBalances();
    const gross = railgunGrossForNet(amountIn, feeBps);
    await remember(trade, { status: 'funding', amountIn: amountIn.toString(), detail: `Quoting ${fundVia.symbol} through NEAR Intents.` });
    const exit = await startIntentsExit({ assetId: fundVia.intentsAssetId, grossUnits: gross.toString(), recipient: trade.ownerAddress });
    const started = view(trade, {
      status: 'funding',
      amountIn: amountIn.toString(),
      viaIntents: { correlationId: exit.correlationId, minOut: exit.minAmountOut },
      detail: `Sending ${Number(amountIn) / 1e6} USDC out of Railgun through NEAR Intents. At least ${formatUnits(BigInt(exit.minAmountOut), fundVia.decimals)} ${fundVia.symbol} arrives on this address.`,
    });
    await updateOwnedTrade(trade.ownerIndex, { app: started });
    return started;
  }

  const live = (await getVenueTrade('intents'))?.intents;
  const last = await lastIntentsView();
  const move = live?.correlationId === recorded.correlationId ? live : last?.correlationId === recorded.correlationId ? last : null;

  // Arrived? The quoted minimum is on the address, or the user already
  // staked it (wstETH), or NEAR Intents reported the swap delivered.
  const held = fundVia.symbol === 'ETH' ? await publicClient.getBalance({ address: trade.ownerAddress }) : 0n;
  const staked = await Promise.all((spec.extraTokens ?? []).map((token) => tokenBalance(token.address, trade.ownerAddress).catch(() => 0n)));
  if (held >= BigInt(recorded.minOut) || staked.some((amount) => amount > 0n) || move?.swapStatus === 'SUCCESS') {
    const ready = view(trade, { ...(trade.app ?? { amountIn: amountIn.toString(), detail: '' }), status: 'funded', viaIntents: recorded, detail: spec.fundedDetail, error: undefined });
    await updateOwnedTrade(trade.ownerIndex, { app: ready });
    return ready;
  }

  if (move?.stage === 'failed') {
    // Retryable on the NEAR Intents panel; its ETH may still come here. Keep the record.
    const stalled = view(trade, { ...(trade.app ?? { amountIn: amountIn.toString(), detail: '' }), status: 'funding', viaIntents: recorded, detail: `The NEAR Intents move needs attention: ${move.error ?? move.detail}. Open Send out to retry it.` });
    await updateOwnedTrade(trade.ownerIndex, { app: stalled });
    return stalled;
  }
  if (move && (move.stage === 'refunded' || (move.stage === 'done' && move.direction === 'exit' && move.swapStatus === 'REFUNDED'))) {
    // Nothing reached this address. NEAR Intents' refund is shielded back by the exit itself.
    const failed = view(trade, {
      status: 'failed',
      amountIn: amountIn.toString(),
      detail: `NEAR Intents did not deliver the ${fundVia.symbol}. ${move.error ?? 'Any refund goes back into your private balance.'} Try again to quote a new one.`,
      error: move.error ?? 'Not delivered.',
    });
    await updateOwnedTrade(trade.ownerIndex, { app: failed });
    return failed;
  }
  const waiting = view(trade, { ...(trade.app ?? { amountIn: amountIn.toString(), detail: '' }), status: 'funding', viaIntents: recorded, detail: move?.detail || trade.app?.detail || 'Waiting on NEAR Intents.' });
  await updateOwnedTrade(trade.ownerIndex, { app: waiting });
  return waiting;
}

/**
 * dYdX knows the owner by a dydx1 address derived from its onboarding
 * signature. The provider records it when the site asks; if it did not (an
 * older session), derive it here the same way: the signature is
 * deterministic, so it is the address the site got.
 */
async function withAppAccount(venue: AppVenueId, trade: ActiveTrade): Promise<ActiveTrade> {
  if (venue !== 'dydx' || trade.appAccount?.address || trade.appAccount?.unknownAccounts?.length) return trade;
  const owner = await ownerAt(trade.ownerIndex);
  const signature = await privateKeyToAccount(owner.privateKey).signTypedData(DYDX_ONBOARDING);
  const derived = dydxAddressFromSignature(signature);
  const appAccount = { ...trade.appAccount, address: derived.dydx, noble: derived.noble };
  await updateOwnedTrade(trade.ownerIndex, { appAccount });
  return { ...trade, appAccount };
}

async function wrapLeftoverEth(trade: ActiveTrade): Promise<void> {
  const balance = await publicClient.getBalance({ address: trade.ownerAddress });
  if (balance <= GAS_RESERVE_WEI) return;
  const value = balance - GAS_RESERVE_WEI;
  const account = privateKeyToAccount((await ownerAt(trade.ownerIndex)).privateKey);
  const block = await publicClient.getBlock();
  const maxFeePerGas = (block.baseFeePerGas ?? 20_000_000n) * 2n;
  const data = '0xd0e30db0' as const;
  // A WETH deposit's posting cost is known; estimating it through anon-rpc stalls.
  const gas = arbitrumGasLimit(data);
  const raw = await account.signTransaction({
    chainId: ARBITRUM_CHAIN_ID,
    nonce: await publicClient.getTransactionCount({ address: trade.ownerAddress }),
    to: WETH_ADDRESS,
    data,
    value,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas: 0n,
    type: 'eip1559',
  });
  const hash = await publicClient.sendRawTransaction({ serializedTransaction: raw }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already known|nonce too low|replacement transaction underpriced/i.test(message)) throw error;
    return null;
  });
  if (!hash) throw new Error('Wrapping ETH to WETH is already submitted. Retry shield back in a moment.');
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Wrapping ETH to WETH reverted. Nothing was shielded.');
}

async function balancesToShield(venue: AppVenueId, trade: ActiveTrade): Promise<{ token: Address; symbol: string; amount: bigint }[]> {
  const tokens = new Map<string, { token: Address; symbol: string }>();
  for (const token of [...RAILGUN_RETURN_TOKENS, ...(APP_VENUES[venue].extraTokens ?? [])]) {
    tokens.set(token.address.toLowerCase(), { token: token.address, symbol: token.symbol });
  }
  for (const discovered of await tokensReceived(trade)) {
    if (!tokens.has(discovered.toLowerCase())) tokens.set(discovered.toLowerCase(), { token: discovered, symbol: short(discovered) });
  }

  const rows: { token: Address; symbol: string; amount: bigint }[] = [];
  for (const entry of tokens.values()) {
    // A failed read is not a zero: refusing beats retiring an address with a token on it.
    const amount = await tokenBalance(entry.token, trade.ownerAddress);
    if (amount === 0n) continue;
    rows.push({ token: entry.token, symbol: await readSymbol(entry.token, entry.symbol), amount });
  }
  return rows;
}

/** Every token that reached the owner since it was funded, so a swap's output is found too. */
async function tokensReceived(trade: ActiveTrade): Promise<Address[]> {
  const unshieldTx = trade.app?.unshieldTx ?? trade.withdrawal?.txHash;
  if (!unshieldTx) return [];
  // Thrown on failure, not read as "nothing received": a swap output outside
  // the usual tokens is only found here.
  const receipt = await publicClient.getTransactionReceipt({ hash: unshieldTx as Hash });
  const logs = await publicClient.getLogs({ event: transferEvent, args: { to: trade.ownerAddress }, fromBlock: receipt.blockNumber, toBlock: 'latest' });
  return [...new Set(logs.map((log) => log.address))];
}

async function readSymbol(token: Address, fallback: string): Promise<string> {
  try {
    return (await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })) || fallback;
  } catch {
    return fallback;
  }
}

async function clearConfirmedShield(venue: AppVenueId): Promise<void> {
  const trade = await getVenueTrade(venue);
  if (trade?.reshield?.status === 'confirmed') await updateOwnedTrade(trade.ownerIndex, { reshield: undefined });
}

async function requireTrade(venue: AppVenueId): Promise<ActiveTrade> {
  const trade = await getVenueTrade(venue);
  if (!trade || trade.venue !== venue) throw new Error(`No ${APP_VENUES[venue].name} address is open.`);
  return trade;
}

async function remember(trade: ActiveTrade, patch: AppAccountView): Promise<void> {
  await updateOwnedTrade(trade.ownerIndex, { venue: trade.venue, intentAddress: trade.ownerAddress, app: view(trade, patch) });
}

function view(trade: ActiveTrade, patch: AppAccountView): AppAccountView {
  return { ...patch, ownerAddress: trade.ownerAddress };
}

async function fail(venue: AppVenueId, amountIn: bigint, error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  const trade = await getVenueTrade(venue);
  if (trade) {
    await updateOwnedTrade(trade.ownerIndex, {
      app: {
        status: 'failed',
        amountIn: amountIn.toString(),
        detail: message,
        error: message,
        ownerAddress: trade.ownerAddress,
        unshieldTx: trade.app?.unshieldTx ?? trade.withdrawal?.txHash,
        shielded: trade.app?.shielded,
        left: trade.app?.left,
        // Kept: a retry continues this NEAR Intents move instead of paying again.
        viaIntents: trade.app?.viaIntents,
      },
    }).catch(() => undefined);
  }
  throw error instanceof Error ? error : new Error(message);
}

function line(row: { token: Address; symbol: string; amount: bigint }): AppTokenLine {
  return { token: row.token, symbol: row.symbol, amount: row.amount.toString() };
}

function tokenBalance(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

function short(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
