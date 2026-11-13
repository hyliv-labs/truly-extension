/**
 * Minimal active-trade state.
 *
 * E8 takes ownership of the full state machine; E5 only needs to answer
 * "is a trade active, and which owner is it?" so the provider can refuse
 * everything otherwise. One active trade at a time is the core invariant:
 * two concurrent trades would share a browser session and defeat the point.
 */

import type { Address } from 'viem';
import { currentOwner, getOwnerIndex, retireOwner } from './vault';
import { skipUsedOwners } from './fresh-owner';
import { configProblems } from './config';
import { clearHyperliquidSiteData, clearLighterSiteData } from './site-cleanup';
import type { TradeSession } from './session-types';
import type { CompoundAccountView } from './compound';
import type { UniswapAccountView } from './uniswap';
import type { IntentsView } from './intents';
import type { HyperliquidAccountView } from './hyperliquid';
import { APP_VENUE_IDS, appVenueFromHost, type AppAccountView, type AppVenueId } from './app-venues';

const LOCAL_ACTIVE_TRADE = 'truly:activeTrade';

export type VenueId = 'lighter' | 'uniswap' | 'compound' | 'hyperliquid' | AppVenueId;
/**
 * A slot in the book. 'intents' is a NEAR Intents exit or entry: it has its
 * own fresh owner like any venue, but no dapp ever connects to it, so it is
 * never the "focused" trade a site or the Lighter flow reads.
 */
export type BookSlot = VenueId | 'intents';
const SLOTS: readonly BookSlot[] = ['lighter', 'uniswap', 'compound', 'hyperliquid', ...APP_VENUE_IDS, 'intents'];

export function venueFromOrigin(origin: string): VenueId | null {
  let host = origin;
  try {
    host = new URL(origin).hostname;
  } catch {
    host = origin;
  }
  if (host === 'uniswap.org' || host.endsWith('.uniswap.org')) return 'uniswap';
  if (host === 'lighter.xyz' || host.endsWith('.lighter.xyz')) return 'lighter';
  if (host === 'hyperliquid.xyz' || host.endsWith('.hyperliquid.xyz')) return 'hyperliquid';
  if (
    host === 'compound.xyz' ||
    host.endsWith('.compound.xyz') ||
    host === 'compound.finance' ||
    host.endsWith('.compound.finance')
  ) {
    return 'compound';
  }
  return appVenueFromHost(host);
}

export async function tradeForOrigin(origin: string): Promise<ActiveTrade | null> {
  const venue = venueFromOrigin(origin);
  if (!venue) return getActiveTrade();
  return getVenueTrade(venue);
}

export type VenueBook = { [slot in BookSlot]?: ActiveTrade };
const LOCAL_TRADE_HISTORY = 'truly:tradeHistory';
const HISTORY_LIMIT = 50;

export interface ActiveTrade {
  readonly ownerIndex: number;
  readonly ownerAddress: Address;
  readonly startedAt: number;
  /** E4: where the relayer sends the withdrawal. Stable for a given owner. */
  readonly intentAddress?: Address;
  /** E4: assigned by Lighter once the first deposit is credited. */
  readonly accountIndex?: number;
  /**
   * E7/E8: the re-shield back into Privacy Pools.
   *
   * `pending` is written BEFORE the bundler is asked, and again with the
   * user-operation hash the moment it accepts one. A crash in between must
   * not look like "never sent" — that is how a second click would deposit
   * twice. `confirmed` is the only state that makes the trade retirable.
   * Inferring it from balances cannot tell "re-shielded" from "still in flight".
   */
  readonly reshield?: {
    readonly status: 'pending' | 'confirmed';
    readonly userOpHash: string;
    readonly depositIndex: number;
    readonly deposited: string;
    readonly confirmedAt: number;
    /**
     * Set only for an older ETH-paid Railgun shield. A paymaster shield has
     * no raw transaction; its userOpHash is waited on through the bundler.
     */
    readonly raw?: string;
  };
  /**
   * E3: set once the pool withdrawal is CONFIRMED on chain. Mirrors `reshield`
   * and for the same reason — this record is what makes funding idempotent,
   * and the only thing that distinguishes "funded, waiting for Lighter" from
   * "never funded". Inferring it from balances cannot: the intent address
   * shows nothing until Lighter sweeps it.
   */
  readonly withdrawal?: {
    /**
     * 'pending' is written BEFORE the relayer is asked for a quote, so a
     * crash, a worker teardown or a failed receipt read can never leave a
     * broadcast withdrawal with no record. Without it the phase falls back to
     * 'unshielding', the button goes live again, and a second click sends a
     * second payment to the same intent address — untracked, and linking two
     * pool withdrawals to one Lighter identity.
     */
    readonly status: 'pending' | 'confirmed';
    /** Added the moment the relayer returns, before the receipt is awaited. */
    readonly txHash?: string;
    readonly label: string;
    readonly amount: string;
    /** children.length when this started, so a resume can tell if it landed. */
    readonly childrenCountAtStart: number;
    readonly withdrawalIndex?: number;
    readonly startedAt: number;
    readonly confirmedAt?: number;
    /** Signed Railgun transaction, resent as these exact bytes. */
    readonly raw?: string;
    /**
     * Set once the receipt was read as SUCCESS. A record without it may have
     * been marked confirmed by the old code, which did not look at the
     * receipt status: a reverted unshield was reported as funding.
     */
    readonly receiptOk?: boolean;
  };
  /** E8: last phase recorded, so the popup has something before the first poll. */
  readonly phase?: string;
  /** E4: last status seen, so the popup can show a wait without re-polling. */
  readonly deposit?: {
    readonly status: string;
    readonly description: string;
    readonly checkedAt: number;
    /** Every distinct status seen, so a real run records Lighter's vocabulary. */
    readonly seen?: string[];
  };
  /** The in-extension market trade this owner exists for, when there is one. */
  readonly session?: TradeSession;
  /** Which venue this address was opened for. Absent on older Lighter trades. */
  readonly venue?: BookSlot;
  /** Uniswap funding and the shield back. A retry continues this record. */
  readonly uniswap?: UniswapAccountView;
  /** Compound funding and the shield back. A retry continues this record. */
  readonly compound?: CompoundAccountView;
  /** Hyperliquid funding (bridge deposit), the withdrawal and the shield back. */
  readonly hyperliquid?: HyperliquidAccountView;
  /** An app from app-venues.ts (1inch, Aave, ...): funding and the shield back. */
  readonly app?: AppAccountView;
  /**
   * The account the app knows this owner by, when it is not the owner itself
   * (dYdX derives a dydx1 address from a wallet signature). Public addresses
   * only; the signature and the key derived from it are never stored.
   */
  readonly appAccount?: { readonly address: string; readonly noble?: string };
  /** A NEAR Intents move. intentAddress is the 1Click deposit address (exit) or the owner (entry). */
  readonly intents?: IntentsView;
}

/**
 * Serialises read-modify-write within this worker. Funding, the session tick
 * and the popup can all write the record; without this, two interleaved
 * writers each spread a stale copy and one silently drops the other's field.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

type TradePatch = Partial<Omit<ActiveTrade, 'ownerIndex' | 'ownerAddress' | 'startedAt'>>;

function venueOf(trade: ActiveTrade): BookSlot {
  return trade.venue && trade.venue !== 'lighter' && SLOTS.includes(trade.venue) ? trade.venue : 'lighter';
}

function isTrade(value: unknown): value is ActiveTrade {
  return Boolean(value && typeof value === 'object' && 'ownerAddress' in value);
}

/** One record per venue. An older install stored a single trade; that still reads. */
async function readBook(): Promise<VenueBook> {
  const stored = await chrome.storage.local.get(LOCAL_ACTIVE_TRADE);
  const raw = stored[LOCAL_ACTIVE_TRADE];
  if (!raw) return {};
  if (isTrade(raw)) return { [venueOf(raw)]: raw };
  const book = raw as VenueBook;
  return Object.fromEntries(SLOTS.filter((slot) => book[slot]).map((slot) => [slot, book[slot]])) as VenueBook;
}

async function writeBook(book: VenueBook): Promise<void> {
  if (SLOTS.every((slot) => !book[slot])) {
    await chrome.storage.local.remove(LOCAL_ACTIVE_TRADE);
    return;
  }
  await chrome.storage.local.set({ [LOCAL_ACTIVE_TRADE]: book });
}

function focused(book: VenueBook): ActiveTrade | null {
  if (book.lighter) return book.lighter;
  const rest = [book.uniswap, book.compound, book.hyperliquid, ...APP_VENUE_IDS.map((id) => book[id])].filter((trade): trade is ActiveTrade => Boolean(trade));
  return rest.length === 1 ? rest[0] ?? null : null;
}

function place(book: VenueBook, previous: BookSlot, trade: ActiveTrade): void {
  const next = venueOf(trade);
  if (next !== previous) delete book[previous];
  book[next] = trade;
}

/** Merge fields into the active trade. Refuses if no trade is active. */
export function updateActiveTrade(patch: TradePatch): Promise<ActiveTrade> {
  return serialized(async () => {
    const book = await readBook();
    const trade = focused(book);
    if (!trade) throw new Error('no active trade');
    const next = { ...trade, ...patch };
    place(book, venueOf(trade), next);
    await writeBook(book);
    return next;
  });
}

/** Merge fields into the venue account that owns this index. */
export function updateOwnedTrade(ownerIndex: number, patch: TradePatch): Promise<ActiveTrade> {
  return serialized(async () => {
    const book = await readBook();
    const venue = SLOTS.find((id) => book[id]?.ownerIndex === ownerIndex);
    const trade = venue ? book[venue] : undefined;
    if (!trade || !venue) throw new Error('no active trade');
    const next = { ...trade, ...patch };
    place(book, venue, next);
    await writeBook(book);
    return next;
  });
}

/** Patch the session in place. Refuses if the trade or its session is gone. */
export function updateSession(
  sessionId: string,
  patch: (session: TradeSession) => Partial<TradeSession>,
): Promise<TradeSession> {
  return serialized(async () => {
    const trade = await getActiveTrade();
    if (!trade?.session || trade.session.id !== sessionId) {
      throw new Error('this trade session is no longer active');
    }
    const session: TradeSession = { ...trade.session, ...patch(trade.session), updatedAt: Date.now() };
    const book = await readBook();
    const venue = venueOf(trade);
    book[venue] = { ...trade, session };
    await writeBook(book);
    return session;
  });
}

/** Finished trades, newest first. Kept separate so sessions never mix. */
export async function getTradeHistory(): Promise<ActiveTrade[]> {
  const stored = await chrome.storage.local.get(LOCAL_TRADE_HISTORY);
  return (stored[LOCAL_TRADE_HISTORY] as ActiveTrade[] | undefined) ?? [];
}

async function archive(trade: ActiveTrade): Promise<void> {
  const history = await getTradeHistory();
  await chrome.storage.local.set({
    [LOCAL_TRADE_HISTORY]: [{ ...trade, endedAt: Date.now() }, ...history].slice(0, HISTORY_LIMIT),
  });
}

export async function getActiveTrade(): Promise<ActiveTrade | null> {
  return focused(await readBook());
}

export async function listOpenVenues(): Promise<VenueBook> {
  return readBook();
}

export async function getVenueTrade(venue: BookSlot): Promise<ActiveTrade | null> {
  return (await readBook())[venue] ?? null;
}

export async function findTradeByOwner(ownerIndex: number): Promise<ActiveTrade | null> {
  const book = await readBook();
  const slot = SLOTS.find((id) => book[id]?.ownerIndex === ownerIndex);
  return slot ? (book[slot] ?? null) : null;
}

/**
 * Mark the current owner as trading. E8 will replace this with the funded
 * lifecycle; for now it exists so E5 can be exercised end to end.
 */
export async function startTrade(): Promise<ActiveTrade> {
  if (await getActiveTrade()) {
    throw new Error('a trade is already active');
  }
  return startVenue('lighter');
}

/**
 * Open one venue without closing the others. Each venue keeps its own owner,
 * so Lighter, Uniswap and Compound can all be funded at once.
 */
export function startVenue(venue: BookSlot): Promise<ActiveTrade> {
  return serialized(async () => {
    const book = await readBook();
    const existing = book[venue];
    if (existing) return existing;

    const problems = configProblems();
    if (problems.length > 0) {
      throw new Error(problems.map((p) => p.reason).join(' '));
    }
    if (venue === 'lighter') await clearLighterSiteData();
    if (venue === 'hyperliquid') await clearHyperliquidSiteData();

    await skipUsedOwners();
    const held = new Set(
      SLOTS
        .map((id) => book[id]?.ownerIndex)
        .filter((index): index is number => index !== undefined),
    );
    for (let guard = 0; held.has(await getOwnerIndex()); guard += 1) {
      if (guard > 30) throw new Error('Could not allocate a fresh address.');
      await retireOwner(await getOwnerIndex());
    }
    const owner = await currentOwner();
    const trade: ActiveTrade = {
      ownerIndex: owner.index,
      ownerAddress: owner.address,
      startedAt: Date.now(),
      venue,
      // Uniswap, Compound and Hyperliquid receive on the owner. Lighter's deposit address
      // is issued later and is not this owner.
      ...(venue === 'lighter' ? {} : { intentAddress: owner.address }),
    };
    book[venue] = trade;
    await writeBook(book);
    return trade;
  });
}

/**
 * Drop a re-shield that never reached the bundler, so the button can try
 * again. A pending record that already has a user-operation hash is left
 * alone: that operation may still land, and deleting it invites a second one.
 */
export async function clearPendingReshield(): Promise<void> {
  const trade = await getActiveTrade();
  if (!trade?.reshield || trade.reshield.status !== 'pending') return;
  if (trade.reshield.userOpHash) return;
  await discardReshield();
}

/**
 * Forget a pending re-shield even if the bundler already accepted it.
 * Only for a receipt that says the operation reverted — nothing was deposited,
 * so the deposit index is still free and a retry is the correct next step.
 */
export async function discardReshield(ownerIndex?: number): Promise<void> {
  const trade = ownerIndex === undefined ? await getActiveTrade() : await findTradeByOwner(ownerIndex);
  if (!trade?.reshield || trade.reshield.status === 'confirmed') return;

  await updateOwnedTrade(trade.ownerIndex, { reshield: undefined });
}

/**
 * Retire the trade AND its owner address. The index is burned here rather than
 * at the start of the next trade, so an unfinished trade resumes on the same
 * address while a finished one can never be handed out again.
 */
export async function endTrade(): Promise<void> {
  const trade = await getActiveTrade();
  if (!trade) return;
  await endVenue(venueOf(trade));
}

/** Retire one venue. The others stay funded on their own addresses. */
export function endVenue(venue: BookSlot): Promise<void> {
  return serialized(async () => {
    const book = await readBook();
    const trade = book[venue];
    if (!trade) return;

    await retireOwner(trade.ownerIndex);
    await archive(trade).catch(() => {});
    delete book[venue];
    await writeBook(book);
    if (venue === 'lighter') await clearLighterSiteData().catch(() => {});
    if (venue === 'hyperliquid') await clearHyperliquidSiteData().catch(() => {});
  });
}
