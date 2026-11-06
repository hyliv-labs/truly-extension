/**
 * E3: move funds from the pool to a fresh owner address.
 *
 * This is the step that funds a trade. Everything downstream — the Lighter
 * deposit, the trade, the exit, the re-shield — waits on it.
 *
 * THE CALL ORDER IS NOT ARBITRARY. Two constraints fix it:
 *
 *  - The context is keccak(withdrawal, SCOPE), and the withdrawal's `data`
 *    carries the relayer's fee terms. So the quote must precede proving, or
 *    the pool reverts with ContextMismatch.
 *  - The quote's feeCommitment lives ~60 SECONDS (measured). Everything
 *    between quoting and submitting has to fit inside it.
 *
 * So anything network-bound that does NOT depend on the quote happens first:
 *
 *   1. association set + latestRoot() check   (may fetch over Tor; slow)
 *   2. relayer quote                          (60s clock starts here)
 *   3. withdrawal struct from the quote
 *   4. context
 *   5. prove                                  (~2.5s)
 *   6. relayer request
 *
 * Steps 2-6 are deliberately free of any other network call.
 */

import type { Address } from 'viem';
import type { Hash, Secret } from '@0xbow/privacy-pools-core-sdk';
import {
  generateMerkleProof,
  calculateContext,
  getCommitment,
} from '@0xbow/privacy-pools-core-sdk';
import { getAssociationSet, isLabelApproved, AspUnavailable } from './asp';
import { fetchStateTree, StateTreeError } from './state-tree';
import { ensureOffscreenDocument } from './offscreen';
import {
  proveWithdrawalOffscreen,
  toWireMerkleProof,
  ProvingUnavailable,
} from './prove-withdrawal';
import {
  requestQuote,
  submitWithdrawal,
  quoteStillUsable,
  quoteTimeRemainingMs,
  RelayerError,
  isRetryableRevert,
  type RelayerQuote,
} from './relayer';
import { deriveChangeNote, nextWithdrawalIndex, confirmWithdrawalIndex } from './notes';
import { authoritativeScope } from './pool';
import { PRIVACY_POOL_ENTRYPOINT, POOL_MIN_DEPOSIT_UNITS, estimateRelayerFeeUnits } from './config';
import { requireUnlockedMnemonic } from './vault';
import { publicClient } from './chain';

export class WithdrawError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'WithdrawError';
    this.retryable = retryable;
  }
}

/** A spendable note, as the SDK's account model describes it. */
export interface SpendableNote {
  readonly label: bigint;
  readonly value: bigint;
  readonly nullifier: Secret;
  readonly secret: Secret;
  readonly commitmentHash: bigint;
  /** account.children.length — the SDK derives the withdrawal index from this. */
  readonly childrenCount: number;
}

export interface WithdrawRequest {
  readonly note: SpendableNote;
  readonly amountUnits: bigint;
  readonly recipient: Address;
  /**
   * Called the moment the relayer accepts, BEFORE the receipt is awaited.
   *
   * The gap between broadcast and confirmation is where a worker teardown or
   * a failed receipt read would otherwise lose the transaction entirely. The
   * caller uses this to persist the hash while it still can.
   */
  readonly onBroadcast?: (txHash: string | undefined) => Promise<void>;
}

export interface WithdrawResult {
  readonly txHash?: string;
  readonly amountUnits: bigint;
  readonly remainderUnits: bigint;
  readonly feeBPS: bigint;
  readonly withdrawalIndex: number;
  readonly attempts: number;
}

/**
 * Reject a withdrawal that would strand its own remainder.
 *
 * A change note below the pool minimum cannot be re-shielded or withdrawn
 * economically — the funds are simply stuck. The relayer's effective rate is
 * fixed-cost dominated (68 BPS at the 5 USDC floor, 11 BPS at 250), so this
 * must be checked against the ESTIMATE, not the advertised base rate.
 */
export function checkSizing(note: SpendableNote, amountUnits: bigint): void {
  if (amountUnits <= 0n) {
    throw new WithdrawError('Withdrawal amount must be positive.');
  }
  if (amountUnits > note.value) {
    throw new WithdrawError(
      `Cannot withdraw ${amountUnits} from a note worth ${note.value}.`,
    );
  }

  const fee = estimateRelayerFeeUnits(amountUnits);
  if (fee >= amountUnits) {
    throw new WithdrawError(
      `The relayer fee (~${fee}) would consume the whole ${amountUnits} withdrawal.`,
    );
  }

  const remainder = note.value - amountUnits;
  // A remainder of exactly zero is fine: the note is fully spent and there is
  // nothing left to strand. Anything between 1 and the pool minimum is not.
  if (remainder > 0n && remainder < POOL_MIN_DEPOSIT_UNITS) {
    throw new WithdrawError(
      `This would leave ${remainder} units behind, below the pool's ${POOL_MIN_DEPOSIT_UNITS} minimum. ` +
        'That remainder could not be re-shielded or economically withdrawn. Withdraw the whole note or less of it.',
    );
  }
}

interface ProvenWithdrawal {
  readonly bundle: Parameters<typeof submitWithdrawal>[0];
  readonly index: number;
  readonly remainder: bigint;
}

/**
 * Steps 2-5: quote, context, prove. Kept together because the 60s clock runs
 * across all of them, so nothing else may be interleaved.
 */
async function quoteAndProve(
  request: WithdrawRequest,
  scope: bigint,
  stateLeaves: readonly bigint[],
  aspLeaves: readonly bigint[],
  mnemonic: string,
): Promise<{ proven: ProvenWithdrawal; quote: RelayerQuote }> {
  const { note, amountUnits, recipient } = request;

  if (!PRIVACY_POOL_ENTRYPOINT) {
    throw new WithdrawError('No entrypoint configured; the relayer could not route the withdrawal.');
  }

  // The index is the chain's, never a local counter: the SDK derives it as
  // account.children.length both here and when replaying Withdrawn events to
  // rebuild an account from a seed. Reusing one strands the change note.
  const index = await nextWithdrawalIndex(note.label, note.childrenCount);
  const change = deriveChangeNote(mnemonic, note.label, index);

  // Merkle proofs are LOCAL work, so they happen before the quote: a failure
  // here (a note missing from the tree, an unapproved label) must not burn a
  // 60-second commitment.
  const stateMerkleProof = generateMerkleProof([...stateLeaves], note.commitmentHash);
  const aspMerkleProof = generateMerkleProof([...aspLeaves], note.label);

  // Built with getCommitment, NOT hand-rolled. The SDK's shape is
  // { hash, nullifierHash, preimage: { value, label, precommitment } } — a
  // flat { hash, label, value, nullifier, secret } feeds undefined into the
  // circuit and fails as an opaque "Failed to generate proof".
  const commitment = getCommitment(
    note.value,
    note.label as unknown as Hash,
    note.nullifier,
    note.secret,
  );

  // Cross-check: this also validates that findSpendableNotes mapped the
  // account fields correctly. A mismatch means we are about to prove against
  // a commitment that is not the one in the state tree.
  if ((commitment.hash as unknown as bigint) !== note.commitmentHash) {
    throw new WithdrawError(
      `Rebuilt commitment ${commitment.hash} does not match the discovered ${note.commitmentHash}. The note's fields are wrong; proving would produce an unusable proof.`,
    );
  }

  // The offscreen document must exist and have its artifacts ready BEFORE the
  // clock starts: first use fetches and hash-checks the circuit files, which
  // is not a 60-second-window task.
  await ensureOffscreenDocument();

  // --- 2. quote. The 60s window opens HERE. ---
  const quote = await requestQuote(recipient, amountUnits);

  // --- 3+4. the withdrawal struct and its context. ---
  // withdrawalData comes from the relayer PRE-ENCODED. Rebuilding it would
  // change the context and the pool would revert with ContextMismatch.
  const withdrawal = {
    processooor: PRIVACY_POOL_ENTRYPOINT,
    data: quote.feeCommitment.withdrawalData,
  };
  const context = calculateContext(withdrawal as never, scope as unknown as Hash);

  if (!quoteStillUsable(quote)) {
    throw new WithdrawError(
      `The relayer quote has only ${quoteTimeRemainingMs(quote)}ms left; proving would outlive it.`,
      true,
    );
  }

  // --- 5. prove. ---
  // Runs in the offscreen document: snarkjs needs real DOM, workers and
  // WebAssembly, none of which a service worker has. Only the proof crosses;
  // the orchestration stays here with the vault and chrome.storage.
  const { publicSignals, proof: rawProof } = await proveWithdrawalOffscreen({
    value: note.value.toString(),
    label: note.label.toString(),
    nullifier: String(note.nullifier),
    secret: String(note.secret),
    withdrawalAmount: amountUnits.toString(),
    context: String(context),
    stateMerkleProof: toWireMerkleProof(stateMerkleProof as never),
    aspMerkleProof: toWireMerkleProof(aspMerkleProof as never),
    newNullifier: String(change.nullifier),
    newSecret: String(change.secret),
  });

  // The relayer's schema is strict; a malformed bundle is rejected after the
  // proving cost has already been paid, so check before submitting.
  if (!Array.isArray(publicSignals) || publicSignals.length !== 8) {
    throw new WithdrawError(
      `The proof produced ${publicSignals?.length} public signals; the relayer requires exactly 8.`,
    );
  }

  return {
    quote,
    proven: {
      index,
      remainder: note.value - amountUnits,
      bundle: {
        processooor: withdrawal.processooor,
        data: withdrawal.data,
        publicSignals,
        proof: rawProof,
      },
    },
  };
}

const MAX_ATTEMPTS = 3;

/**
 * Wait for the relayer's transaction and report whether it actually succeeded.
 *
 * Read over anon-rpc, like every other chain read. A missing hash is treated
 * as "unknown", not as success: the caller then declines to record the index,
 * and the next scan resolves the truth from chain history.
 */
async function confirmOnChain(txHash: string | undefined): Promise<boolean> {
  if (!txHash) {
    throw new WithdrawError(
      'The relayer returned no transaction hash, so the withdrawal could not be confirmed on chain. Rescan before retrying — it may have landed.',
      false,
    );
  }
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash as `0x${string}`,
  });
  return receipt.status === 'success';
}

/**
 * Withdraw from the pool to `recipient`.
 *
 * Retries only the races: a new ASP root published mid-flight, or a transient
 * relayer/CoW failure. Each retry restarts from the association set, because
 * an IncorrectASPRoot means the cached tree is now wrong — and re-quotes,
 * because by then the 60s commitment is usually dead.
 *
 * The withdrawal index is advanced ONLY after the relayer accepts, so a failed
 * attempt reuses it rather than burning one.
 */
export async function withdrawFromPool(request: WithdrawRequest): Promise<WithdrawResult> {
  checkSizing(request.note, request.amountUnits);

  const mnemonic = await requireUnlockedMnemonic();
  const scope = await authoritativeScope();

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // --- 1. association set, pinned to the root the pool accepts. ---
      const { set } = await getAssociationSet(scope);

      if (!isLabelApproved(set, request.note.label)) {
        // Not a race: this deposit has not cleared screening. Retrying cannot
        // help, and the ASP publishes in batches measured in days.
        throw new WithdrawError(
          'This deposit has not yet been approved by the ASP, so it cannot be withdrawn. ' +
            'Screening is published in batches and can take days.',
        );
      }

      // The state tree is read LIVE from chain events, never cached: state
      // leaves change with every deposit and withdrawal, including our own.
      // A cached copy would be missing trade N-1's change note and every
      // merkle proof after the first would fail.
      const stateTree = await fetchStateTree();

      const { proven, quote } = await quoteAndProve(
        request,
        scope,
        stateTree.leaves,
        set.aspLeaves,
        mnemonic,
      );

      // --- 6. submit. ---
      const result = await submitWithdrawal(proven.bundle, quote, scope);

      // Persist the hash before waiting on anything. From here the withdrawal
      // is real whether or not this process survives to see it confirmed.
      await request.onBroadcast?.(result.txHash);

      // The relayer accepting is NOT the withdrawal landing. It returns once
      // the transaction is broadcast, and that transaction can still revert --
      // with IncorrectASPRoot, most plausibly, since the ASP can publish
      // between proving and inclusion.
      //
      // Confirming the index on acceptance would raise the local floor above
      // the chain's children count forever, and every later withdrawal on
      // this label would throw StaleScanError.
      const landed = await confirmOnChain(result.txHash);

      if (!landed) {
        throw new WithdrawError(
          'The relayer accepted the withdrawal but the transaction reverted on chain. The note is unspent and can be retried.',
          true,
        );
      }

      // Only now is the index spent.
      //
      // If this is never reached because the receipt could not be read, the
      // index is simply not recorded -- which is safe, because the chain is
      // the authority: the next scan sees the new child and derives the right
      // index anyway. The local floor is only a staleness guard.
      await confirmWithdrawalIndex(request.note.label, proven.index);

      return {
        txHash: result.txHash,
        amountUnits: request.amountUnits,
        remainderUnits: proven.remainder,
        feeBPS: quote.feeBPS,
        withdrawalIndex: proven.index,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error as Error;

      const retryable =
        (error instanceof RelayerError && error.retryable) ||
        (error instanceof WithdrawError && error.retryable) ||
        error instanceof AspUnavailable ||
        error instanceof StateTreeError ||
        // The offscreen document can be torn down between calls; that is a
        // lifecycle race, not a bad proof.
        error instanceof ProvingUnavailable ||
        isRetryableRevert(lastError.message);

      if (!retryable || attempt === MAX_ATTEMPTS) break;
      // Loop: the next pass refetches the association set and re-quotes.
    }
  }

  throw new WithdrawError(
    `Withdrawal failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
    false,
  );
}
