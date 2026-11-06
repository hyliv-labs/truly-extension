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
import { getSdk } from './proving';
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

  // The SDK must be ready before the clock starts: first use fetches and
  // hash-checks the circuit artifacts, which is not a 60-second-window task.
  const sdk = await getSdk();

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
  const proof = await sdk.proveWithdrawal(commitment as never, {
    context: context as unknown as bigint,
    withdrawalAmount: amountUnits,
    stateMerkleProof,
    aspMerkleProof,
    stateRoot: stateMerkleProof.root as unknown as Hash,
    stateTreeDepth: BigInt(stateMerkleProof.siblings.length),
    aspRoot: aspMerkleProof.root as unknown as Hash,
    aspTreeDepth: BigInt(aspMerkleProof.siblings.length),
    newSecret: change.secret as unknown as Secret,
    newNullifier: change.nullifier as unknown as Secret,
  } as never);

  const { publicSignals, proof: rawProof } = proof as unknown as {
    publicSignals: string[];
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  };

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

      // Only now is the index spent. Advancing earlier would burn one on
      // every relayer hiccup.
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
