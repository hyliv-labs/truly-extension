/**
 * NEAR Intents moves, run from the service worker.
 *
 * Both directions ride the same one-trade-at-a-time record as Lighter,
 * Uniswap and Compound (venue 'intents'), so they get a fresh owner, the
 * same retirement rules and the same history for free.
 *
 * Exit. The fresh owner signs a Railgun unshield whose recipient is the
 * 1Click deposit address itself. No public address of the user's sits
 * between the shielded pool and the destination chain. The quote is for the
 * exact amount the unshield delivers (Railgun's fee is taken inside), and
 * 1Click refunds to the fresh owner, from where it is shielded again.
 *
 * Entry. The user pays a 1Click deposit address on the origin chain, ideally
 * straight from a shielded wallet (Zashi's shielded ZEC to the transparent
 * deposit address, an Aleo private-to-public transfer). The USDC arrives at a
 * fresh owner on Arbitrum and is shielded into Railgun.
 *
 * Nothing here awaits the Railgun proof inside a message reply: start
 * returns at once, the work runs in the worker, and advanceIntents() (panel
 * poll and alarm) continues whatever was interrupted.
 */

import { erc20Abi, type Address } from 'viem';
import { publicClient } from './chain';
import { USDC_ADDRESS } from './config';
import {
  ARB_USDC_ASSET,
  TERMINAL_STATUSES,
  createOneClickClient,
  describeStatus,
  destinationTx,
  formatUnits,
  getQuote,
  pickerAssets,
  railgunNetForGross,
  type OneClickClient,
  type OneClickToken,
  type QuoteResponse,
} from './near-intents';
import {
  exitInterrupted,
  intentsAbandonBlocker,
  intentsNeedsTick,
  nextFromStatus,
  type IntentsAsset,
  type IntentsDirection,
  type IntentsPreview,
  type IntentsView,
} from './intents';
import { loadShieldedBalance, railgunReady, readShieldedBalance } from './shielded-balance';
import { shieldOwnerUsdcToRailgun, unshieldRailgunForTrade } from './railgun-client';
import { endVenue, getVenueTrade, startVenue, updateOwnedTrade, type ActiveTrade } from './trade';
import { zcashAddressForIntents } from './zcash';

/** The NEAR Intents slot of the venue book. Other venues stay open on their own owners. */
const getIntentsTrade = () => getVenueTrade('intents');

const PARTNER_KEY = 'truly:oneClickPartnerKey';
const LAST_VIEW = 'truly:intentsLast';
const TOKENS_CACHE_MS = 10 * 60_000;

/** Railgun's published Arbitrum unshield fee. Only for a preview before the balance has loaded. */
const DEFAULT_RAILGUN_FEE_BPS = 25n;
/** Exit: the refund deadline must outlast the proof (1-3 min) with room for a retry. */
const EXIT_DEADLINE_MINUTES = 60;
/** Entry: Bitcoin needs ~15 min, and the user has to open their own wallet first. */
const ENTRY_DEADLINE_MINUTES = 180;
/** Requote an exit that never sent anything once its refund deadline is this close. */
const REQUOTE_MARGIN_MS = 15 * 60_000;
/** Shield back pays Circle's paymaster from a 1 USDC permit when the owner has no ETH. */
const MIN_ENTRY_USD = 3;
const MIN_EXIT_UNITS = 1_000_000n;
const DEFAULT_SLIPPAGE_BPS = 100;
const POLL_EVERY_MS = 4_000;

let tokenCache: { at: number; tokens: OneClickToken[] } | null = null;
let exitRun: Promise<void> | null = null;
let shieldRun: Promise<void> | null = null;
let lastPoll = 0;

// --- Partner key ---------------------------------------------------------------

/** The user's own 1Click partner key. Never bundled: a key in the build ships in the zip. */
export async function getPartnerKey(): Promise<string | null> {
  const stored = await chrome.storage.local.get(PARTNER_KEY);
  const key = stored[PARTNER_KEY];
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

export async function setPartnerKey(key: string | null): Promise<{ confidential: boolean }> {
  if (key && key.trim()) await chrome.storage.local.set({ [PARTNER_KEY]: key.trim() });
  else await chrome.storage.local.remove(PARTNER_KEY);
  return { confidential: !!(key && key.trim()) };
}

async function client(): Promise<{ api: OneClickClient; confidential: boolean }> {
  const apiKey = await getPartnerKey();
  return { api: createOneClickClient({ apiKey }), confidential: apiKey !== null };
}

// --- Assets and preview ----------------------------------------------------------

async function tokens(): Promise<OneClickToken[]> {
  if (tokenCache && Date.now() - tokenCache.at < TOKENS_CACHE_MS) return tokenCache.tokens;
  const { api } = await client();
  const list = await api.tokens();
  tokenCache = { at: Date.now(), tokens: list };
  return list;
}

export async function intentsAssets(): Promise<IntentsAsset[]> {
  return pickerAssets(await tokens());
}

async function asset(assetId: string): Promise<OneClickToken> {
  const token = (await tokens()).find((row) => row.assetId === assetId);
  if (!token) throw new Error('NEAR Intents does not list that asset.');
  return token;
}

/**
 * The user's own address as 1Click needs it. Zcash: a unified address from
 * Zashi, Zingo, YWallet… is reduced to its transparent receiver (1Click
 * refuses u1…); the preview shows the user which address that is.
 */
function userAddress(token: OneClickToken, address: string, role: 'refund' | 'recipient'): { address: string; fromUnified: boolean } {
  if (token.blockchain === 'zec') return zcashAddressForIntents(address, role);
  return { address: address.trim(), fromUnified: false };
}

/** A person pays an entry from their own wallet, so the amount may be off; Ghosty's own exits are exact. */
function entrySwapType(confidential: boolean): 'EXACT_INPUT' | 'FLEX_INPUT' {
  return confidential ? 'EXACT_INPUT' : 'FLEX_INPUT';
}

function label(token: OneClickToken): string {
  const featured = pickerAssets([token])[0];
  return featured?.label ?? `${token.symbol} on ${token.blockchain}`;
}

async function railgunFeeBps(): Promise<bigint> {
  const balance = await readShieldedBalance();
  return balance && railgunReady(balance.railgun) ? BigInt(balance.railgun.feeBps) : DEFAULT_RAILGUN_FEE_BPS;
}

async function spendableRailgun(): Promise<bigint | null> {
  const balance = await readShieldedBalance();
  return balance && railgunReady(balance.railgun) ? BigInt(balance.railgun.spendableUnits) : null;
}

export interface ExitInput {
  readonly assetId: string;
  /** USDC units to take out of Railgun, before Railgun's fee. */
  readonly grossUnits: string;
  readonly recipient: string;
  readonly slippageBps?: number;
}

export interface EntryInput {
  readonly assetId: string;
  /** Origin-asset units the user will send. */
  readonly amountUnits: string;
  /** The user's own address on the origin chain, for a refund. */
  readonly refundTo: string;
  readonly slippageBps?: number;
}

/** Stand-in for the fresh owner in a dry quote. 1Click rejects the 0x…dEaD burn address as invalid. */
const PREVIEW_OWNER = '0x2222222222222222222222222222222222222222';

/**
 * A dry quote: no deposit address, nothing reserved. It also validates the
 * user's address, since 1Click refuses one that is not well-formed.
 */
export async function previewIntents(direction: IntentsDirection, input: ExitInput | EntryInput): Promise<IntentsPreview> {
  const { api, confidential } = await client();
  if (direction === 'exit') {
    const exit = input as ExitInput;
    const gross = BigInt(exit.grossUnits);
    if (gross < MIN_EXIT_UNITS) throw new Error('Send at least 1 USDC.');
    const feeBps = await railgunFeeBps();
    const net = railgunNetForGross(gross, feeBps);
    const destination = await asset(exit.assetId);
    const recipient = userAddress(destination, exit.recipient, 'recipient');
    const { quote } = await getQuote(api, {
      dry: true,
      originAsset: ARB_USDC_ASSET,
      destinationAsset: exit.assetId,
      amountUnits: net,
      recipient: recipient.address,
      refundTo: PREVIEW_OWNER,
      slippageBps: exit.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      deadlineMinutes: EXIT_DEADLINE_MINUTES,
      confidential,
    });
    return {
      direction,
      amountIn: net.toString(),
      amountInFormatted: formatUnits(net, 6),
      grossUnits: gross.toString(),
      railgunFeeUnits: (gross - net).toString(),
      amountOut: quote.amountOut,
      amountOutFormatted: formatUnits(quote.amountOut, destination.decimals),
      minAmountOutFormatted: formatUnits(quote.minAmountOut, destination.decimals),
      timeEstimate: quote.timeEstimate,
      confidential,
      address: recipient.address,
      addressFromUnified: recipient.fromUnified,
    };
  }
  const entry = input as EntryInput;
  const origin = await asset(entry.assetId);
  checkEntrySize(origin, BigInt(entry.amountUnits));
  const refundTo = userAddress(origin, entry.refundTo, 'refund');
  const { quote } = await getQuote(api, {
    dry: true,
    originAsset: entry.assetId,
    destinationAsset: ARB_USDC_ASSET,
    amountUnits: BigInt(entry.amountUnits),
    recipient: PREVIEW_OWNER,
    refundTo: refundTo.address,
    slippageBps: entry.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    deadlineMinutes: ENTRY_DEADLINE_MINUTES,
    confidential,
    swapType: entrySwapType(confidential),
  });
  return {
    direction,
    amountIn: quote.amountIn,
    amountInFormatted: formatUnits(quote.amountIn, origin.decimals),
    ...(quote.minAmountIn ? { minAmountInFormatted: formatUnits(quote.minAmountIn, origin.decimals) } : {}),
    amountOut: quote.amountOut,
    amountOutFormatted: formatUnits(quote.amountOut, 6),
    minAmountOutFormatted: formatUnits(quote.minAmountOut, 6),
    timeEstimate: quote.timeEstimate,
    confidential,
    address: refundTo.address,
    addressFromUnified: refundTo.fromUnified,
  };
}

function checkEntrySize(origin: OneClickToken, units: bigint): void {
  if (units <= 0n) throw new Error('Enter an amount.');
  if (origin.price && Number(units) / 10 ** origin.decimals * origin.price < MIN_ENTRY_USD) {
    throw new Error(`Bring in at least about $${MIN_ENTRY_USD}. Below that the shield's gas reserve eats most of it.`);
  }
}

// --- Start ---------------------------------------------------------------------------

/**
 * One NEAR Intents move at a time. It always gets its own brand-new owner from
 * the venue book (startVenue), never the owner of a Lighter, Uniswap or
 * Compound account, so a site that saw those owners learns nothing here.
 */
async function refuseSecondMove(): Promise<void> {
  const existing = await getIntentsTrade();
  if (existing?.intents) throw new Error('A NEAR Intents move is already running. Finish or abandon it first.');
  // A slot left with no move recorded (a start that died mid-quote) is
  // released, so the next start allocates a fresh owner again.
  if (existing) await endVenue('intents');
}

export async function startIntentsExit(input: ExitInput): Promise<IntentsView> {
  const gross = BigInt(input.grossUnits);
  if (gross < MIN_EXIT_UNITS) throw new Error('Send at least 1 USDC.');
  const spendable = await spendableRailgun();
  if (spendable !== null && spendable <= gross) {
    throw new Error('That is the whole shielded balance. Leave a little behind: the proof needs a change note.');
  }
  await refuseSecondMove();
  const destination = await asset(input.assetId);
  const recipient = userAddress(destination, input.recipient, 'recipient').address;
  const feeBps = await railgunFeeBps();
  const net = railgunNetForGross(gross, feeBps);
  const { api, confidential } = await client();

  const trade = await startVenue('intents');
  let quoted: Awaited<ReturnType<typeof getQuote>>;
  try {
    quoted = await getQuote(api, {
      dry: false,
      originAsset: ARB_USDC_ASSET,
      destinationAsset: input.assetId,
      amountUnits: net,
      recipient,
      // A refund lands on the fresh owner and goes back into Railgun.
      refundTo: trade.ownerAddress,
      slippageBps: input.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      deadlineMinutes: EXIT_DEADLINE_MINUTES,
      confidential,
    });
  } catch (error) {
    await endVenue('intents').catch(() => undefined);
    throw error;
  }

  const view: IntentsView = {
    direction: 'exit',
    stage: 'unshielding',
    detail: 'Building the Railgun unshield proof. This takes a minute or two.',
    originAsset: ARB_USDC_ASSET,
    originLabel: 'Shielded USDC (Railgun)',
    originDecimals: 6,
    destinationAsset: input.assetId,
    destinationLabel: label(destination),
    destinationDecimals: destination.decimals,
    recipient: quoted.request.recipient,
    refundTo: trade.ownerAddress,
    amountIn: net.toString(),
    grossUnits: gross.toString(),
    confidential,
    ...quoteFields(quoted.response),
    updatedAt: Date.now(),
  };
  // Saved BEFORE any proof or broadcast: from here on the deposit address is
  // the only place this money may go.
  await updateOwnedTrade(trade.ownerIndex, { venue: 'intents', intentAddress: view.depositAddress as Address, intents: view });
  kickExit();
  return view;
}

export async function startIntentsEntry(input: EntryInput): Promise<IntentsView> {
  const origin = await asset(input.assetId);
  if (input.assetId === ARB_USDC_ASSET) throw new Error('That is already Arbitrum USDC. Use Add funds instead.');
  checkEntrySize(origin, BigInt(input.amountUnits));
  const refundTo = userAddress(origin, input.refundTo, 'refund').address;
  await refuseSecondMove();
  const { api, confidential } = await client();

  const trade = await startVenue('intents');
  let quoted: Awaited<ReturnType<typeof getQuote>>;
  try {
    quoted = await getQuote(api, {
      dry: false,
      originAsset: input.assetId,
      destinationAsset: ARB_USDC_ASSET,
      amountUnits: BigInt(input.amountUnits),
      recipient: trade.ownerAddress,
      refundTo,
      slippageBps: input.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      deadlineMinutes: ENTRY_DEADLINE_MINUTES,
      confidential,
      swapType: entrySwapType(confidential),
    });
  } catch (error) {
    await endVenue('intents').catch(() => undefined);
    throw error;
  }

  const view: IntentsView = {
    direction: 'entry',
    stage: 'awaiting-deposit',
    detail: quoted.quote.minAmountIn
      ? `Send ${formatUnits(quoted.quote.amountIn, origin.decimals)} ${origin.symbol} to the deposit address, from any wallet.`
      : `Send exactly ${formatUnits(quoted.quote.amountIn, origin.decimals)} ${origin.symbol} to the deposit address.`,
    originAsset: input.assetId,
    originLabel: label(origin),
    originDecimals: origin.decimals,
    destinationAsset: ARB_USDC_ASSET,
    destinationLabel: 'Shielded USDC (Railgun)',
    destinationDecimals: 6,
    recipient: trade.ownerAddress,
    refundTo: quoted.request.refundTo,
    amountIn: quoted.quote.amountIn,
    ...(quoted.quote.minAmountIn ? { minAmountIn: quoted.quote.minAmountIn } : {}),
    confidential,
    ...quoteFields(quoted.response),
    updatedAt: Date.now(),
  };
  // intentAddress is the owner: that is where the USDC lands on Arbitrum.
  await updateOwnedTrade(trade.ownerIndex, { venue: 'intents', intentAddress: trade.ownerAddress, intents: view });
  return view;
}

function quoteFields(response: QuoteResponse) {
  const quote = response.quote;
  return {
    depositAddress: quote.depositAddress!,
    depositMemo: quote.depositMemo ?? null,
    amountOut: quote.amountOut,
    minAmountOut: quote.minAmountOut,
    timeEstimate: quote.timeEstimate,
    inactiveAt: quote.timeWhenInactive ?? quote.deadline ?? '',
    refundAfter: response.quoteRequest.deadline,
    correlationId: response.correlationId,
    quoteSignature: response.signature,
    quotedAt: Date.now(),
  };
}

// --- Progress --------------------------------------------------------------------------

/** One step of whatever the move is waiting on. Safe to call often. */
export async function advanceIntents(): Promise<IntentsView | null> {
  const trade = await getIntentsTrade();
  if (!trade || trade.venue !== 'intents' || !trade.intents) return lastIntentsView();
  const view = trade.intents;
  switch (view.stage) {
    case 'unshielding':
      // Only resume an unshield that may already be on chain. One cut off
      // before signing (worker restart mid-proof) surfaces for Retry, so a
      // proof is never built twice without the user asking.
      if (exitInterrupted(trade, exitRun !== null)) {
        const message = 'The proof was interrupted before anything was sent. Nothing left Railgun. Retry builds it again.';
        return patch({ stage: 'failed', error: message, detail: message });
      }
      if (!exitRun && trade.withdrawal) kickExit();
      return view;
    case 'awaiting-deposit':
    case 'swapping':
      return pollStatus(trade, view);
    case 'shielding':
      if (!shieldRun) kickShield();
      return view;
    default:
      return view;
  }
}

export async function intentsDepositSent(txHash: string): Promise<IntentsView> {
  const trade = await requireIntentsTrade();
  const view = trade.intents!;
  if (view.direction !== 'entry') throw new Error('Only an entry takes your deposit transaction.');
  const hash = txHash.trim();
  if (!hash) throw new Error('Paste the transaction hash or id.');
  const { api } = await client();
  // Optional for 1Click; it only makes the deposit visible sooner.
  await api.submitDeposit(view.depositAddress, hash, view.depositMemo).catch(() => undefined);
  return patch({ userDepositTx: hash, detail: '1Click was told about your deposit. Waiting for it to confirm.' });
}

async function pollStatus(trade: ActiveTrade, view: IntentsView): Promise<IntentsView> {
  if (Date.now() - lastPoll < POLL_EVERY_MS) return view;
  lastPoll = Date.now();
  const { api } = await client();
  let status;
  try {
    status = await api.status(view.depositAddress, view.depositMemo);
  } catch {
    return view; // Transient. The next poll tries again; nothing moved.
  }
  const delivered = destinationTx(status);
  const base = {
    swapStatus: status.status,
    detail: describeStatus(status.status, view.direction),
    ...(delivered ? { destinationTx: delivered } : {}),
    ...(status.swapDetails?.refundedAmount && status.swapDetails.refundedAmount !== '0'
      ? { refundedAmount: status.swapDetails.refundedAmount }
      : {}),
    // A short deposit: kept so the panel can say how much is missing, and so
    // Cancel is no longer offered once money is at the address.
    ...(status.status === 'INCOMPLETE_DEPOSIT' && status.swapDetails?.depositedAmount && status.swapDetails.depositedAmount !== '0'
      ? { depositedAmount: status.swapDetails.depositedAmount }
      : {}),
  };

  const next = nextFromStatus(view, status.status, Date.now(), status.swapDetails?.depositedAmount);
  const delivered_ =
    view.direction === 'exit' && next.stage === 'done'
      ? `Delivered ${formatUnits(view.amountOut, view.destinationDecimals)} ${view.destinationLabel} (quoted).`
      : next.detail;
  const fields: Partial<IntentsView> = {
    ...base,
    stage: next.stage,
    ...(delivered_ ? { detail: delivered_ } : {}),
    ...(next.error ? { error: next.error } : {}),
  };
  void trade;
  if (next.then === 'finish') return finish(fields);
  const saved = await patch(fields);
  if (next.then === 'shield') kickShield();
  return saved;
}

function kickExit(): void {
  if (exitRun) return;
  exitRun = runExit().finally(() => {
    exitRun = null;
  });
}

async function runExit(): Promise<void> {
  const trade = await requireIntentsTrade();
  const view = trade.intents!;
  try {
    await patch({ detail: trade.withdrawal ? 'The unshield is on its way. Waiting for it to confirm.' : 'Building the Railgun unshield proof. This takes a minute or two.' });
    const result = await unshieldRailgunForTrade(BigInt(view.amountIn), 'intents', BigInt(view.grossUnits!));
    await patch({
      stage: 'swapping',
      unshieldTx: result.txHash,
      detail: 'Unshielded straight into the 1Click deposit address. Solvers are filling it.',
      error: undefined,
    });
    const { api } = await client();
    await api.submitDeposit(view.depositAddress, result.txHash).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = await getIntentsTrade();
    // A broadcast may be in flight: stay here so the tick resumes it.
    if (now?.withdrawal?.status === 'pending') await patch({ detail: message });
    else if (/more ETH on Arbitrum/i.test(message)) {
      // ensureUnshieldGas found no earlier owner able to pay. Its advice
      // ("send it to the owner") would put the user's own wallet next to
      // this exit, so say that plainly.
      const gas =
        `No earlier Ghosty address has the ~0.0001 ETH this unshield needs for gas. Nothing left Railgun. ` +
        `Sending ETH from your own wallet to ${trade.ownerAddress} works but links that wallet to this exit; ` +
        `funding an earlier Ghosty address instead keeps it private. Then Retry.`;
      await patch({ stage: 'failed', error: gas, detail: gas });
    } else await patch({ stage: 'failed', error: message, detail: message });
  }
}

function kickShield(): void {
  if (shieldRun) return;
  shieldRun = runShield().finally(() => {
    shieldRun = null;
  });
}

async function runShield(): Promise<void> {
  const trade = await requireIntentsTrade();
  const view = trade.intents!;
  try {
    const usdc = await publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [trade.ownerAddress] });
    if (usdc === 0n && !trade.reshield) {
      // An entry NEAR Intents failed or refunded sends the money back to the
      // user's own refund address, never here. Nothing will arrive: finish,
      // rather than wait on an empty address forever.
      if (view.direction === 'entry' && (view.swapStatus === 'FAILED' || view.swapStatus === 'REFUNDED')) {
        await finish({
          stage: 'refunded',
          detail: `NEAR Intents did not complete this swap. Your deposit goes back to ${view.refundTo}; nothing reached Ghosty.`,
          error: undefined,
        });
        return;
      }
      await patch({ detail: 'Waiting for the USDC to arrive at the fresh address on Arbitrum.' });
      return;
    }
    const shielded = await shieldOwnerUsdcToRailgun('intents');
    const amount = formatUnits(shielded.amountUnits, 6);
    await finish({
      shieldTx: shielded.txHash,
      stage: view.direction === 'exit' ? 'refunded' : 'done',
      detail:
        view.direction === 'exit'
          ? `Refunded and shielded back: ${amount} USDC is in Railgun again.`
          : `${amount} USDC is shielded in Railgun. Nothing links it to the address you paid from.`,
      error: undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already (submitted|broadcast)/i.test(message)) await patch({ detail: message });
    // Auto-lock during a long entry: keep the stage, so unlocking resumes it.
    else if (/^locked$|is locked|Locked before/i.test(message)) await patch({ detail: 'Unlock Ghosty to finish shielding. Your USDC is waiting at the fresh address.' });
    else await patch({ stage: 'failed', error: message, detail: message });
  }
}

/** The user's Retry. Continues; never builds a second proof for one deposit address. */
export async function retryIntents(): Promise<IntentsView> {
  const trade = await requireIntentsTrade();
  const view = trade.intents!;
  if (view.stage !== 'failed') return view;

  if (view.direction === 'exit' && !view.unshieldTx && !trade.withdrawal) {
    // Nothing left the pool. A stale quote is replaced before proving.
    // Whichever comes first: 1Click stops watching the address, or starts refunding.
    const closes = Math.min(Date.parse(view.inactiveAt) || Infinity, Date.parse(view.refundAfter) || Infinity);
    if (!Number.isFinite(closes) || closes - Date.now() < REQUOTE_MARGIN_MS) await requoteExit(trade, view);
    await patch({ stage: 'unshielding', error: undefined });
    kickExit();
    return (await getIntentsTrade())!.intents!;
  }
  if (view.direction === 'exit' && trade.withdrawal?.status === 'pending') {
    await patch({ stage: 'unshielding', error: undefined });
    kickExit();
    return (await getIntentsTrade())!.intents!;
  }
  if (view.swapStatus === 'SUCCESS' || view.swapStatus === 'REFUNDED' || view.swapStatus === 'FAILED' || view.shieldTx) {
    const next = await patch({ stage: 'shielding', error: undefined, detail: 'Checking the fresh address for USDC to shield back.' });
    kickShield();
    return next;
  }
  lastPoll = 0;
  return patch({ stage: view.direction === 'entry' && !view.swapStatus ? 'awaiting-deposit' : 'swapping', error: undefined });
}

async function requoteExit(trade: ActiveTrade, view: IntentsView): Promise<void> {
  const { api, confidential } = await client();
  const quoted = await getQuote(api, {
    dry: false,
    originAsset: ARB_USDC_ASSET,
    destinationAsset: view.destinationAsset,
    amountUnits: BigInt(view.amountIn),
    recipient: view.recipient,
    refundTo: trade.ownerAddress,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    deadlineMinutes: EXIT_DEADLINE_MINUTES,
    confidential,
  });
  const fields = quoteFields(quoted.response);
  await updateOwnedTrade(trade.ownerIndex, { intentAddress: fields.depositAddress as Address });
  await patch({ ...fields, confidential });
}

export async function lastIntentsView(): Promise<IntentsView | null> {
  const stored = await chrome.storage.local.get(LAST_VIEW);
  return (stored[LAST_VIEW] as IntentsView | undefined) ?? null;
}

export async function dismissLastIntents(): Promise<void> {
  await chrome.storage.local.remove(LAST_VIEW);
}

// --- Record helpers ------------------------------------------------------------------------

async function requireIntentsTrade(): Promise<ActiveTrade> {
  const trade = await getIntentsTrade();
  if (!trade || trade.venue !== 'intents' || !trade.intents) throw new Error('No NEAR Intents move is open.');
  return trade;
}

async function patch(fields: Partial<IntentsView>): Promise<IntentsView> {
  const trade = await requireIntentsTrade();
  const next: IntentsView = { ...trade.intents!, ...fields, updatedAt: Date.now() };
  await updateOwnedTrade(trade.ownerIndex, { intents: next });
  return next;
}

/** Terminal: keep the last view for the panel, then retire the owner. */
async function finish(fields: Partial<IntentsView>): Promise<IntentsView> {
  const next = await patch(fields);
  await chrome.storage.local.set({ [LAST_VIEW]: next });
  await endVenue('intents');
  // The home screen and the exit form read the cached snapshot. Rescan, so a
  // just-shielded entry is spendable and a finished exit is gone from it.
  void loadShieldedBalance(true).catch(() => undefined);
  return next;
}

export { TERMINAL_STATUSES, intentsAbandonBlocker, intentsNeedsTick };
