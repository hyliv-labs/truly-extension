/**
 * E3 step: fund a trade from the pool.
 *
 * This is the join between the pool and Lighter, and it is the step that was
 * missing — everything downstream waited on an owner that nothing ever funded.
 *
 * THE RECIPIENT IS LIGHTER'S INTENT ADDRESS, not the owner. Lighter derives
 * the intent address from the owner and credits anything arriving there to the
 * owner's account, so paying it directly means the owner never has to hold
 * USDC or pay gas for a second transfer. The extra hop would buy no privacy
 * either: the intent address is derived from the owner, so both hops name the
 * same identity.
 *
 * TWO FLOORS HAVE TO BE SATISFIED AT ONCE, and they pull in opposite
 * directions:
 *
 *   - Lighter rejects a deposit under MIN_DEPOSIT_USDC, and the relayer's fee
 *     comes out of the withdrawal, so what LANDS must clear it — not what was
 *     requested.
 *   - The pool rejects a commitment under POOL_MIN_DEPOSIT_UNITS, so the
 *     remainder left behind must be either zero or above that floor.
 *
 * Miss the first and the funds sit at the intent address uncredited. Miss the
 * second and the remainder is stranded in the pool forever. Neither errors at
 * the time, so both are decided here, before anything is sent.
 */

import type { Address } from 'viem';
import { findSpendableNotes, type DiscoveredNote } from './discovery';
import { withdrawFromPool, type WithdrawResult } from './withdraw';
import { getAssociationSet, isLabelApproved } from './asp';
import { authoritativeScope } from './pool';
import { requireUnlockedMnemonic } from './vault';
import { getActiveTrade, updateActiveTrade } from './trade';
import { publicClient } from './chain';
import { MIN_DEPOSIT_USDC } from './lighter';
import {
  DEFAULT_TRADE_SIZE_UNITS,
  POOL_MIN_DEPOSIT_UNITS,
  estimateRelayerFeeUnits,
} from './config';

export class UnshieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnshieldError';
  }
}

/** What Lighter must actually receive, in USDC units. */
export const LIGHTER_MIN_UNITS = BigInt(MIN_DEPOSIT_USDC) * 1_000_000n;

export interface UnshieldPlan {
  readonly note: DiscoveredNote;
  /** Gross amount to withdraw; the relayer's fee comes out of this. */
  readonly amountUnits: bigint;
  /** Conservative estimate of what Lighter will see. */
  readonly expectedNetUnits: bigint;
  readonly remainderUnits: bigint;
  /** True when the note is spent entirely, leaving nothing to strand. */
  readonly spendsWholeNote: boolean;
}

/**
 * Choose a note and an amount that satisfies both floors.
 *
 * Prefers spending a note whole over leaving a remainder that is legal but
 * awkward: a note barely above the pool minimum is worth consuming, because
 * the alternative is a second withdrawal later at a punitive small-size rate.
 */
export function planUnshield(
  notes: readonly DiscoveredNote[],
  desiredUnits: bigint = DEFAULT_TRADE_SIZE_UNITS,
): UnshieldPlan {
  if (notes.length === 0) {
    throw new UnshieldError(
      'No spendable notes were found in the pool. Deposit into Privacy Pools first, and note that a new deposit must clear ASP screening before it can be spent.',
    );
  }
  if (desiredUnits <= 0n) {
    throw new UnshieldError('The trade size must be positive.');
  }

  // Largest first: the biggest note leaves the healthiest remainder.
  const ordered = [...notes].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));

  const reasons: string[] = [];

  for (const note of ordered) {
    // A partial withdrawal must leave either nothing or a usable remainder.
    // If taking the desired amount would leave an unusable scrap, take the
    // whole note instead rather than stranding it.
    const wouldStrand =
      note.value > desiredUnits && note.value - desiredUnits < POOL_MIN_DEPOSIT_UNITS;

    const amountUnits = note.value <= desiredUnits || wouldStrand ? note.value : desiredUnits;
    const remainderUnits = note.value - amountUnits;

    // The fee is taken from the withdrawal, so Lighter sees less than this.
    const expectedNetUnits = amountUnits - estimateRelayerFeeUnits(amountUnits);

    if (expectedNetUnits < LIGHTER_MIN_UNITS) {
      reasons.push(
        `a ${fmt(note.value)} note would land ~${fmt(expectedNetUnits)} after fees, under Lighter's ${fmt(LIGHTER_MIN_UNITS)} minimum`,
      );
      continue;
    }

    return {
      note,
      amountUnits,
      expectedNetUnits,
      remainderUnits,
      spendsWholeNote: remainderUnits === 0n,
    };
  }

  throw new UnshieldError(
    `No note is large enough to fund a trade: ${reasons.join('; ')}. Deposit more into the pool, or combine notes.`,
  );
}

function fmt(units: bigint): string {
  return `${(Number(units) / 1_000_000).toFixed(2)} USDC`;
}

export interface NotesByApproval {
  /** In the ASP's approved set: a proof can spend these. */
  readonly approved: DiscoveredNote[];
  /** Deposited but not yet approved. Real money, not spendable yet. */
  readonly pending: DiscoveredNote[];
}

/** Split notes by ASP approval. A pending deposit must never be planned against. */
export async function splitByAspApproval(
  notes: readonly DiscoveredNote[],
  scope: bigint,
): Promise<NotesByApproval> {
  if (notes.length === 0) return { approved: [], pending: [] };
  const { set } = await getAssociationSet(scope);
  const approved: DiscoveredNote[] = [];
  const pending: DiscoveredNote[] = [];
  for (const note of notes) (isLabelApproved(set, note.label) ? approved : pending).push(note);
  return { approved, pending };
}

/** Scan the pool and split by approval. A full scan over anon-rpc; not cheap. */
export async function scanNotesByApproval(): Promise<NotesByApproval> {
  const mnemonic = await requireUnlockedMnemonic();
  const scope = await authoritativeScope();
  return splitByAspApproval(await findSpendableNotes(mnemonic, scope), scope);
}

type PendingRecord = NonNullable<
  Awaited<ReturnType<typeof getActiveTrade>> extends infer T
    ? T extends { withdrawal?: infer W }
      ? W
      : never
    : never
>;

/**
 * Decide whether a pending funding withdrawal actually landed.
 *
 * Two independent ways to find out, because neither alone is enough:
 *
 *  - With a transaction hash, read its receipt. Definitive when available,
 *    but the hash is absent if the worker died before the relayer answered.
 *  - Otherwise ask the CHAIN whether the note gained a change note. The SDK
 *    derives a label's withdrawal index from children.length, so a count above
 *    what we recorded at the start means a withdrawal under that label landed.
 *
 * Returns 'landed' only on positive evidence. Anything ambiguous is reported
 * as 'landed' too — refusing a safe retry costs a manual rescan, whereas
 * permitting an unsafe one sends real funds twice.
 */
async function resolvePending(record: PendingRecord): Promise<'landed' | 'did-not-land'> {
  if (!record) return 'did-not-land';

  if (record.txHash) {
    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: record.txHash as `0x${string}`,
      });
      if (receipt.status === 'success') {
        await updateActiveTrade({
          withdrawal: { ...record, status: 'confirmed', confirmedAt: Date.now() },
        });
        return 'landed';
      }
      // Mined and reverted: the note was never spent, so a retry is safe.
      return 'did-not-land';
    } catch {
      // Could not read it. The transaction may still be in the mempool, so
      // treating this as "safe to retry" could double-fund.
      return 'landed';
    }
  }

  // No hash: ask the chain whether the label gained a change note.
  try {
    const mnemonic = await requireUnlockedMnemonic();
    const scope = await authoritativeScope();
    const notes = await findSpendableNotes(mnemonic, scope);
    const label = BigInt(record.label);
    const current = notes.find((n) => n.label === label);

    if (current && current.childrenCount > record.childrenCountAtStart) {
      await updateActiveTrade({
        withdrawal: { ...record, status: 'confirmed', confirmedAt: Date.now() },
      });
      return 'landed';
    }
    // The label is unchanged, so nothing was spent under it.
    return 'did-not-land';
  } catch {
    return 'landed';
  }
}

/**
 * Settle a pending funding record against the chain without withdrawing.
 * For a resumed session: it decides whether funding happened, never retries it.
 */
export async function resolvePendingWithdrawal(): Promise<'landed' | 'did-not-land' | 'none'> {
  const trade = await getActiveTrade();
  if (trade?.withdrawal?.status !== 'pending') return 'none';
  return resolvePending(trade.withdrawal);
}

export interface UnshieldResult extends WithdrawResult {
  readonly recipient: Address;
  readonly expectedNetUnits: bigint;
}

/**
 * Pull funds from the pool into the active trade's Lighter intent address.
 *
 * Requires the intent address, so `prepareDeposit()` runs first: the recipient
 * is baked into the relayer's fee commitment and therefore into the proof's
 * context, and cannot be changed afterwards.
 *
 * Idempotency is by record, not by inference. A trade that already carries a
 * `withdrawal` record refuses rather than withdrawing twice — the second one
 * would succeed, and the funds would be real but unaccounted for.
 */
export async function unshieldForTrade(
  desiredUnits: bigint = DEFAULT_TRADE_SIZE_UNITS,
): Promise<UnshieldResult> {
  const trade = await getActiveTrade();
  if (!trade) {
    throw new UnshieldError('No trade is active.');
  }
  // A pending record means a previous attempt may have broadcast. Resolve it
  // against the chain before doing anything: the whole hazard is that a
  // withdrawal landed while the record that would prove it was never written.
  if (trade.withdrawal?.status === 'confirmed') {
    throw new UnshieldError(
      'This trade has already been funded from the pool. Withdrawing again would move real funds with nothing tracking them.',
    );
  }
  if (trade.withdrawal?.status === 'pending') {
    const resolution = await resolvePending(trade.withdrawal);
    if (resolution === 'landed') {
      throw new UnshieldError(
        'The previous funding withdrawal did land — the record has been repaired. Do not withdraw again; wait for Lighter to credit the deposit.',
      );
    }
    // Did not land: the note is unspent, so retrying is safe.
  }
  if (!trade.intentAddress) {
    throw new UnshieldError(
      'Lighter has not issued a deposit address yet. The recipient is committed to inside the proof, so it must be known before withdrawing.',
    );
  }

  const mnemonic = await requireUnlockedMnemonic();
  const scope = await authoritativeScope();

  const notes = await findSpendableNotes(mnemonic, scope);
  const { approved, pending } = await splitByAspApproval(notes, scope);
  if (approved.length === 0 && pending.length > 0) {
    throw new UnshieldError(
      'Every note in the pool is still waiting for ASP approval, so none can be withdrawn yet. Approvals are published in batches.',
    );
  }
  const plan = planUnshield(approved, desiredUnits);

  // WRITTEN BEFORE THE QUOTE, not after the receipt. This is the orchestrator's
  // own rule — persist that something irreversible is about to happen before
  // doing it — and funding is where breaking it costs real money: without this
  // record a teardown between broadcast and confirmation leaves the phase at
  // 'unshielding', the button live, and a second click sends a second payment
  // to the same intent address.
  await updateActiveTrade({
    withdrawal: {
      status: 'pending',
      label: plan.note.label.toString(),
      amount: plan.amountUnits.toString(),
      childrenCountAtStart: plan.note.childrenCount,
      startedAt: Date.now(),
    },
  });

  const result = await withdrawFromPool({
    note: {
      label: plan.note.label,
      value: plan.note.value,
      nullifier: plan.note.nullifier as never,
      secret: plan.note.secret as never,
      commitmentHash: plan.note.commitmentHash,
      childrenCount: plan.note.childrenCount,
    },
    amountUnits: plan.amountUnits,
    recipient: trade.intentAddress,
    // Persisted the instant the relayer accepts, so the hash survives a
    // teardown that happens while waiting for the receipt.
    onBroadcast: async (txHash) => {
      await updateActiveTrade({
        withdrawal: {
          status: 'pending',
          txHash,
          label: plan.note.label.toString(),
          amount: plan.amountUnits.toString(),
          childrenCountAtStart: plan.note.childrenCount,
          startedAt: Date.now(),
        },
      });
    },
  });

  // Written only after the withdrawal is confirmed on chain — withdrawFromPool
  // does not return otherwise. The record is what makes the step idempotent,
  // and what getTradeStatus derives 'unshielding' from.
  await updateActiveTrade({
    withdrawal: {
      status: 'confirmed',
      txHash: result.txHash,
      label: plan.note.label.toString(),
      amount: plan.amountUnits.toString(),
      childrenCountAtStart: plan.note.childrenCount,
      withdrawalIndex: result.withdrawalIndex,
      startedAt: Date.now(),
      confirmedAt: Date.now(),
    },
  });

  return { ...result, recipient: trade.intentAddress, expectedNetUnits: plan.expectedNetUnits };
}
