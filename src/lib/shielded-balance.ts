/**
 * The shielded balance read once at unlock and reused for the order ticket.
 *
 * A pool scan is a dozen eth_getLogs over Tor, and a Railgun read starts the
 * engine. Neither belongs on Review. The snapshot here is amounts only: note
 * secrets never leave the scan that spends them. Funding still scans live
 * before any withdrawal, and a failed trade reads this again.
 *
 * The snapshot lives in chrome.storage.session, same as the unlocked mnemonic.
 * A module variable would vanish when the service worker is torn down.
 */

import type { DiscoveredNote } from './discovery';
import { railgunUsdcBalances } from './railgun-client';
import { isUnlocked } from './vault';

const STORAGE_KEY = 'truly:shieldedBalance';

export interface PoolSide {
  readonly spendableUnits: string;
  readonly pendingUnits: string;
  readonly noteCount: number;
  readonly largestUnits: string;
  /** Approved note values. Enough to plan a quote; not enough to spend. */
  readonly approvedValues: string[];
  readonly pendingValues: string[];
}

export interface RailgunSide {
  readonly spendableUnits: string;
  readonly pendingUnits: string;
  readonly feeBps: string;
}

export interface ShieldedBalance {
  readonly fetchedAt: number;
  readonly privacyPools: PoolSide | { readonly error: string };
  readonly railgun: RailgunSide | { readonly error: string };
}

export function poolsReady(side: ShieldedBalance['privacyPools']): side is PoolSide {
  return 'spendableUnits' in side;
}

export function railgunReady(side: ShieldedBalance['railgun']): side is RailgunSide {
  return 'spendableUnits' in side;
}

/**
 * Notes whose only true field is the value. validateTrade and planUnshield
 * size a quote from that. They must never be passed to a withdrawal.
 */
export function notesForQuote(values: readonly string[]): DiscoveredNote[] {
  return values.map((value, index) => ({
    label: BigInt(index + 1),
    value: BigInt(value),
    nullifier: 0n,
    secret: 0n,
    commitmentHash: 0n,
    childrenCount: 0,
  }));
}

let generation = 0;
let inflight: Promise<ShieldedBalance> | null = null;
let inflightRefresh = false;

export async function readShieldedBalance(): Promise<ShieldedBalance | null> {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as ShieldedBalance | undefined;
  if (!value || typeof value.fetchedAt !== 'number' || !value.privacyPools) return null;
  return value;
}

/** Drop the snapshot. An in-flight scan will not write after this. */
export async function forgetShieldedBalance(): Promise<void> {
  generation += 1;
  inflight = null;
  inflightRefresh = false;
  await chrome.storage.session.remove(STORAGE_KEY);
}

/**
 * The unlock snapshot. A second caller joins the scan already running.
 * `refresh` ignores the stored snapshot and reads both pools again.
 */
export function loadShieldedBalance(refresh = false): Promise<ShieldedBalance> {
  // A refresh must not be answered by an in-flight cache read.
  if (inflight && (inflightRefresh || !refresh)) return inflight;
  inflightRefresh = refresh;
  const run = readOrScan(refresh);
  inflight = run.finally(() => {
    if (inflight === run) {
      inflight = null;
      inflightRefresh = false;
    }
  });
  return inflight;
}

async function readOrScan(refresh: boolean): Promise<ShieldedBalance> {
  if (!refresh) {
    const cached = await readShieldedBalance();
    if (cached) return cached;
  }
  const gen = generation;
  const snapshot = await scanBoth();
  if (gen !== generation || !(await isUnlocked())) {
    throw new Error('Locked before the shielded balance finished.');
  }
  await chrome.storage.session.set({ [STORAGE_KEY]: snapshot });
  return snapshot;
}

async function scanBoth(): Promise<ShieldedBalance> {
  const railgun = await Promise.allSettled([railgunUsdcBalances()]);
  const side = railgun[0]!;
  return {
    fetchedAt: Date.now(),
    privacyPools: { error: 'Privacy Pools is turned off.' },
    railgun:
      side.status === 'fulfilled'
        ? {
            spendableUnits: side.value.spendableUnits.toString(),
            pendingUnits: side.value.pendingUnits.toString(),
            feeBps: side.value.feeBps.toString(),
          }
        : { error: messageOf(side.reason) },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
